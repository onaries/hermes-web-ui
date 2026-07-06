import { execFile } from 'child_process'
import { readdir, readFile, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve } from 'path'
import { promisify } from 'util'
import { countTokens } from '../../../lib/context-compressor'
import { isPathWithin, relativePathFromBase } from '../hermes-path'

const execFileAsync = promisify(execFile)

const DEFAULT_CONTEXT_LENGTH = 256_000
const SOFT_CONTEXT_RATIO = 0.25
const HARD_CONTEXT_RATIO = 0.5
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FOLDER_ENTRIES = 200
const MAX_GIT_COMMITS = 10

const SENSITIVE_PARTS = new Set(['.aws', '.docker', '.gnupg', '.kube', '.ssh', 'mcp-tokens'])
const SENSITIVE_NAMES = new Set([
  '.anthropic_oauth.json',
  '.env',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  'auth.json',
  'credentials',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
])
const SKIP_FOLDER_PARTS = new Set(['.git', 'node_modules', '__pycache__'])
const REFERENCE_PATTERN = /(?<![\w/])@(?:(diff|staged)\b|(file|folder|git):((?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+')(?::\d+(?:-\d+)?)?|\S+))/g

export interface ContextReferenceExpansion {
  message: string
  expanded: boolean
  blocked: boolean
  warnings: string[]
  tokenEstimate: number
}

export interface ContextReferenceOptions {
  cwd: string
  contextLength?: number
}

interface ReferenceMatch {
  token: string
  kind: 'file' | 'folder' | 'git' | 'diff' | 'staged'
  value: string
}

function stripReferenceValue(value: string): string {
  const trimmed = value.trim().replace(/[.,;:!?]+$/, '')
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '`' && last === '`') || (first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function parseFileValue(rawValue: string): { path: string; range?: [number, number] } {
  const value = rawValue.trim().replace(/[.,;:!?]+$/, '')
  const match = value.match(/^(.*):(\d+)(?:-(\d+))?$/)
  if (!match) return { path: stripReferenceValue(value) }
  const path = stripReferenceValue(match[1])
  if (!path || /^[a-zA-Z]$/.test(path)) return { path: value }
  const start = Number(match[2])
  const end = Number(match[3] || match[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return { path: value }
  return { path, range: [start, end] }
}

function findReferences(message: string): ReferenceMatch[] {
  const matches: ReferenceMatch[] = []
  for (const match of message.matchAll(REFERENCE_PATTERN)) {
    const simple = match[1]
    const kind = match[2]
    const value = match[3]
    if (simple === 'diff' || simple === 'staged') {
      matches.push({ token: match[0], kind: simple, value: '' })
    } else if (kind === 'file' || kind === 'folder' || kind === 'git') {
      matches.push({ token: match[0], kind, value })
    }
  }
  return matches
}

function removeReferenceTokens(message: string, references: ReferenceMatch[]): string {
  let next = message
  for (const ref of references) next = next.replace(ref.token, '')
  return next.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function looksSensitivePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.some(part => SENSITIVE_PARTS.has(part) || SENSITIVE_NAMES.has(part))
}

function resolveWorkspacePath(cwd: string, rawPath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = resolve(cwd, rawPath)
  if (!isPathWithin(absolutePath, cwd)) throw new Error(`Reference path is outside the workspace: ${rawPath}`)
  const relativePath = relativePathFromBase(absolutePath, cwd) || '.'
  if (isAbsolute(rawPath) && !isPathWithin(rawPath, cwd)) {
    throw new Error(`Reference path is outside the workspace: ${rawPath}`)
  }
  if (looksSensitivePath(relativePath)) throw new Error(`Sensitive file reference is blocked: ${relativePath}`)
  return { absolutePath, relativePath }
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0)
}

function fencedLanguage(filePath: string): string {
  return extname(filePath).slice(1).replace(/[^a-zA-Z0-9_+-]/g, '')
}

async function expandFileReference(cwd: string, rawValue: string): Promise<string> {
  const parsed = parseFileValue(rawValue)
  const { absolutePath, relativePath } = resolveWorkspacePath(cwd, parsed.path)
  const fileStat = await stat(absolutePath)
  if (!fileStat.isFile()) throw new Error(`Not a file: ${relativePath}`)
  if (fileStat.size > MAX_FILE_BYTES) {
    return `### File: ${relativePath}\n\nFile is too large to inline (${fileStat.size} bytes).\nLocal file path for tools: ${absolutePath}`
  }

  const data = await readFile(absolutePath)
  if (isProbablyBinary(data)) {
    return `### File: ${relativePath}\n\nBinary file not inlined (${fileStat.size} bytes).\nLocal file path for tools: ${absolutePath}`
  }

  let text = data.toString('utf8')
  let suffix = ''
  if (parsed.range) {
    const [start, end] = parsed.range
    text = text.split(/\r?\n/).slice(start - 1, end).join('\n')
    suffix = `:${start}-${end}`
  }
  return `### File: ${relativePath}${suffix}\n\n\`\`\`${fencedLanguage(relativePath)}\n${text}\n\`\`\``
}

async function listFolder(cwd: string, dirPath: string, prefix = '', output: string[] = []): Promise<string[]> {
  if (output.length >= MAX_FOLDER_ENTRIES) return output
  const entries = await readdir(dirPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (output.length >= MAX_FOLDER_ENTRIES) break
    if (SKIP_FOLDER_PARTS.has(entry.name)) continue
    const abs = resolve(dirPath, entry.name)
    const rel = relative(cwd, abs).replace(/\\/g, '/')
    if (looksSensitivePath(rel)) continue
    output.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
    if (entry.isDirectory()) await listFolder(cwd, abs, `${prefix}${entry.name}/`, output)
  }
  return output
}

async function expandFolderReference(cwd: string, rawValue: string): Promise<string> {
  const { absolutePath, relativePath } = resolveWorkspacePath(cwd, stripReferenceValue(rawValue))
  const dirStat = await stat(absolutePath)
  if (!dirStat.isDirectory()) throw new Error(`Not a folder: ${relativePath}`)
  const entries = await listFolder(cwd, absolutePath)
  const suffix = entries.length >= MAX_FOLDER_ENTRIES ? `\n... truncated at ${MAX_FOLDER_ENTRIES} entries` : ''
  return `### Folder: ${relativePath}\n\n${entries.join('\n')}${suffix}`
}

async function runGit(cwd: string, args: string[], title: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  })
  const output = String(stdout || stderr || '').trimEnd()
  return `### ${title}\n\n\`\`\`diff\n${output || '(no output)'}\n\`\`\``
}

async function expandReference(cwd: string, ref: ReferenceMatch): Promise<string> {
  if (ref.kind === 'file') return expandFileReference(cwd, ref.value)
  if (ref.kind === 'folder') return expandFolderReference(cwd, ref.value)
  if (ref.kind === 'diff') return runGit(cwd, ['diff', '--no-ext-diff'], 'Git diff')
  if (ref.kind === 'staged') return runGit(cwd, ['diff', '--staged', '--no-ext-diff'], 'Git staged diff')
  const count = Math.min(Math.max(Number(stripReferenceValue(ref.value)) || 1, 1), MAX_GIT_COMMITS)
  return runGit(cwd, ['log', `-${count}`, '--patch', '--stat'], `Git log -${count}`)
}

export async function expandBridgeContextReferences(
  message: string,
  options: ContextReferenceOptions,
): Promise<ContextReferenceExpansion> {
  const references = findReferences(message)
  if (references.length === 0) return { message, expanded: false, blocked: false, warnings: [], tokenEstimate: 0 }

  const warnings: string[] = []
  const blocks: string[] = []
  for (const ref of references) {
    try {
      blocks.push(await expandReference(options.cwd, ref))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      warnings.push(`Warning: failed to expand ${ref.token}: ${reason}`)
    }
  }

  const context = [warnings.join('\n'), blocks.join('\n\n')].filter(Boolean).join('\n\n')
  const tokenEstimate = countTokens(context)
  const contextLength = options.contextLength || DEFAULT_CONTEXT_LENGTH
  if (tokenEstimate > contextLength * HARD_CONTEXT_RATIO) {
    return {
      message,
      expanded: false,
      blocked: true,
      warnings: [`Referenced context is too large (${tokenEstimate} tokens, limit ${Math.floor(contextLength * HARD_CONTEXT_RATIO)}).`],
      tokenEstimate,
    }
  }
  if (tokenEstimate > contextLength * SOFT_CONTEXT_RATIO) {
    warnings.unshift(`Warning: referenced context is large (${tokenEstimate} tokens).`)
  }
  if (!context.trim()) return { message, expanded: false, blocked: false, warnings, tokenEstimate }

  return {
    message: `${removeReferenceTokens(message, references)}\n\n--- Attached Context ---\n${context}`.trim(),
    expanded: true,
    blocked: false,
    warnings,
    tokenEstimate,
  }
}
