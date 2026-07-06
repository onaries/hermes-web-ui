type Translator = (key: string, params?: Record<string, unknown>) => string

type SummaryPart = string | null | undefined

const MAX_VALUE_LENGTH = 90
const MAX_SUMMARY_LENGTH = 220

function parsePayload(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (!/^[{[]/.test(trimmed)) return trimmed
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function truncate(value: string, max = MAX_VALUE_LENGTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return ''
}

export function isNamedTool(toolName: string | undefined, needle: string): boolean {
  if (!toolName) return false
  return toolName.toLowerCase().replace(/\s+/g, '_').includes(needle)
}

export function webSearchQuery(args: Record<string, unknown>): string {
  const direct = firstString(args, ['query', 'q', 'text'])
  if (direct) return direct
  for (const key of ['action', 'input']) {
    const value = args[key]
    if (isRecord(value)) {
      const nested = firstString(value, ['query', 'q', 'text'])
      if (nested) return nested
    }
  }
  const search = args.search_query ?? args.searchQuery ?? args.queries
  const first = Array.isArray(search) ? search[0] : search
  if (typeof first === 'string') return first.trim()
  return isRecord(first) ? firstString(first, ['query', 'q', 'text']) : ''
}

function arrayCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null
}

function countFromResult(result: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = result[key]
    if (Array.isArray(value)) return value.length
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function label(t: Translator, key: string, params?: Record<string, unknown>): string {
  return t(`chat.toolSummary.${key}`, params)
}

function keyValue(t: Translator, key: string, value: string): string | null {
  const clean = truncate(value)
  if (!clean) return null
  return label(t, key, { value: clean })
}

function rawValue(value: string): string | null {
  const clean = truncate(value)
  return clean || null
}

function countLabel(t: Translator, key: string, count: number | null): string | null {
  if (count === null) return null
  return label(t, key, { count })
}

function firstResultTitle(result: Record<string, unknown>): string {
  const arrays = ['results', 'data', 'matches', 'files']
  for (const key of arrays) {
    const value = result[key]
    if (!Array.isArray(value) || !value.length) continue
    const first = value[0]
    if (isRecord(first)) {
      return firstString(first, ['title', 'name', 'path', 'url', 'description', 'content'])
    }
    const text = asString(first)
    if (text) return text
  }
  return ''
}

function fileChangeSummary(args: Record<string, unknown>): string | null {
  const summary = rawValue(firstString(args, ['summary']))
  if (summary) return summary
  const changes = Array.isArray(args.changes) ? args.changes : []
  const text = changes
    .map((change) => {
      if (!isRecord(change)) return ''
      return [firstString(change, ['action', 'kind', 'change', 'status']), firstString(change, ['path', 'file', 'file_path', 'filePath'])]
        .filter(Boolean)
        .join(' ')
    })
    .filter(Boolean)
    .join(', ')
  return rawValue(text)
}

function resultStatus(t: Translator, result: unknown): string | null {
  if (!isRecord(result)) return null
  if (typeof result.success === 'boolean') return result.success ? label(t, 'success') : label(t, 'failure')
  if (typeof result.ok === 'boolean') return result.ok ? label(t, 'success') : label(t, 'failure')
  if (typeof result.exit_code === 'number') return label(t, 'exitCode', { code: result.exit_code })
  if (typeof result.exitCode === 'number') return label(t, 'exitCode', { code: result.exitCode })
  if (typeof result.status === 'string' && result.status) return keyValue(t, 'status', result.status)
  return null
}

function resultCountSummary(t: Translator, result: unknown): string | null {
  if (!isRecord(result)) return null
  return countLabel(t, 'results', countFromResult(result, ['results', 'data', 'items']))
    || countLabel(t, 'matches', countFromResult(result, ['matches', 'total_count']))
    || countLabel(t, 'files', countFromResult(result, ['files']))
    || null
}

function outputSummary(t: Translator, result: unknown): string | null {
  if (!isRecord(result)) return null
  const output = firstString(result, ['output', 'stdout', 'content', 'message', 'error'])
  if (!output) return null
  const firstLine = output.split(/\r?\n/).find(line => line.trim()) || output
  return keyValue(t, 'output', firstLine)
}

function genericArgsSummary(t: Translator, args: unknown): string[] {
  if (!isRecord(args)) return []
  const parts: SummaryPart[] = [
    keyValue(t, 'query', firstString(args, ['query', 'q'])),
    keyValue(t, 'path', firstString(args, ['path', 'file_path', 'cwd', 'workdir'])),
    keyValue(t, 'url', firstString(args, ['url', 'image_url'])),
    keyValue(t, 'command', firstString(args, ['command', 'keys', 'key'])),
    keyValue(t, 'pattern', firstString(args, ['pattern', 'file_glob'])),
    keyValue(t, 'action', firstString(args, ['action', 'mode', 'direction', 'target'])),
    countLabel(t, 'items', arrayCount(args.urls) ?? arrayCount(args.tasks) ?? arrayCount(args.todos)),
  ]
  return parts.filter((part): part is string => Boolean(part))
}

function toolSpecificArgsSummary(t: Translator, toolName: string, args: unknown): string[] {
  if (!isRecord(args)) return []
  const name = toolName.toLowerCase()
  if (isNamedTool(toolName, 'web_search')) return [rawValue(webSearchQuery(args))].filter(Boolean) as string[]
  if (name.includes('web_extract')) return [countLabel(t, 'urls', arrayCount(args.urls)), keyValue(t, 'url', firstString(args, ['url']))].filter(Boolean) as string[]
  if (name.includes('skill_view')) return [rawValue(firstString(args, ['name']))].filter(Boolean) as string[]
  if (name.includes('read_file')) return [rawValue(firstString(args, ['path']))].filter(Boolean) as string[]
  if (name.includes('search_files')) return [keyValue(t, 'pattern', firstString(args, ['pattern'])), keyValue(t, 'path', firstString(args, ['path']))].filter(Boolean) as string[]
  if (name.includes('terminal') || name === 'command') return [rawValue(firstString(args, ['command', 'cmd']))].filter(Boolean) as string[]
  if (name.includes('file change') || name.includes('file_change')) return [fileChangeSummary(args)].filter(Boolean) as string[]
  if (name.includes('execute_code')) return [keyValue(t, 'code', firstString(args, ['code']))].filter(Boolean) as string[]
  if (name.includes('patch')) return [rawValue(firstString(args, ['path']))].filter(Boolean) as string[]
  if (name.includes('write_file')) return [rawValue(firstString(args, ['path']))].filter(Boolean) as string[]
  if (name.includes('delegate_task')) {
    return [keyValue(t, 'goal', firstString(args, ['goal'])), countLabel(t, 'tasks', arrayCount(args.tasks))].filter(Boolean) as string[]
  }
  if (name.includes('browser_navigate')) return [keyValue(t, 'url', firstString(args, ['url']))].filter(Boolean) as string[]
  if (name.includes('browser_type')) return [keyValue(t, 'text', firstString(args, ['text'])), keyValue(t, 'target', firstString(args, ['ref']))].filter(Boolean) as string[]
  if (name.includes('browser_click')) return [keyValue(t, 'target', firstString(args, ['ref']))].filter(Boolean) as string[]
  if (name.includes('browser_press')) return [keyValue(t, 'key', firstString(args, ['key']))].filter(Boolean) as string[]
  if (name.includes('browser_scroll')) return [keyValue(t, 'direction', firstString(args, ['direction']))].filter(Boolean) as string[]
  if (name.includes('computer_use')) return [keyValue(t, 'action', firstString(args, ['action'])), keyValue(t, 'target', firstString(args, ['app', 'element']))].filter(Boolean) as string[]
  return []
}

function compactParts(parts: string[]): string {
  const joined = parts.filter(Boolean).join(' · ')
  if (joined.length <= MAX_SUMMARY_LENGTH) return joined
  return `${joined.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
}

function usesArgsOnlyInlineSummary(toolName: string | undefined): boolean {
  const name = (toolName || '').toLowerCase()
  if (isNamedTool(name, 'web_search')) return true
  return ['web_search', 'skill_view', 'read_file', 'write_file', 'patch', 'terminal', 'file_change'].some(tool => name.includes(tool)) || name === 'command' || name.includes('file change')
}

export function buildToolInlineSummary(
  toolName: string | undefined,
  toolArgs: unknown,
  toolResult: unknown,
  existingPreview: string | undefined,
  t: Translator,
): string {
  const args = parsePayload(toolArgs)
  const result = parsePayload(toolResult)
  const specificParts = toolSpecificArgsSummary(t, toolName || '', args)
  const parts = [
    ...specificParts,
    ...(usesArgsOnlyInlineSummary(toolName) && specificParts.length ? [] : [
      ...genericArgsSummary(t, args),
      resultCountSummary(t, result),
      resultStatus(t, result),
      firstResultTitle(isRecord(result) ? result : {}) ? keyValue(t, 'topResult', firstResultTitle(result as Record<string, unknown>)) : null,
      outputSummary(t, result),
    ]),
  ].filter((part): part is string => Boolean(part))

  const deduped = [...new Set(parts)]
  if (deduped.length) return compactParts(deduped)

  if (usesArgsOnlyInlineSummary(toolName)) return ''
  if (existingPreview) return truncate(existingPreview, MAX_SUMMARY_LENGTH)
  if (typeof result === 'string' && result.trim()) return truncate(result, MAX_SUMMARY_LENGTH)
  if (typeof args === 'string' && args.trim()) return truncate(args, MAX_SUMMARY_LENGTH)
  return ''
}
