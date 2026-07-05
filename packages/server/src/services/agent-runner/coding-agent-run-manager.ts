import { dirname, join } from 'path'
import { existsSync, accessSync, chmodSync, constants as fsConstants, readFileSync } from 'fs'
import { homedir } from 'os'
import { spawn, type ChildProcess } from 'child_process'
import { createSession, addMessage, getSession, updateSession, updateSessionStats } from '../../db/hermes/session-store'
import { logger } from '../logger'
import { applyResponseStreamEvent, flushResponseRunToDb } from '../hermes/run-chat/response-stream'
import { calcAndUpdateUsage, updateMessageContextTokenUsage } from '../hermes/run-chat/usage'
import { extractResponseText } from '../hermes/run-chat/response-utils'
import type { SessionState } from '../hermes/run-chat/types'
import type { CanonicalResponsesEvent } from './adapters/responses-stream'
import { mapCodingAgentResponseEvent } from './coding-agent-event-mapper'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell } from '../windows-command'
import { readCodexLatestContextUsageForNativeSession, type CodexTokenUsage } from '../codex-usage'
import { completeWorkspaceRunCheckpoint, startWorkspaceRunCheckpoint } from '../hermes/run-chat/workspace-diff-tracker' 

const DEFAULT_IDLE_MS = 30 * 60 * 1000
const TERMINAL_OUTPUT_FLUSH_MS = 120
const MAX_TERMINAL_EVENT_CHARS = 4000
const CHILD_STDERR_TAIL_CHARS = 8 * 1024
const CODING_AGENT_TOOL_OUTPUT_STORAGE_LIMIT = 32 * 1024
const CODING_AGENT_TOOL_OUTPUT_HEAD_CHARS = 24 * 1024
const CODING_AGENT_TOOL_OUTPUT_TAIL_CHARS = 8 * 1024
const CODEX_REASONING_SUMMARY_ARGS = ['-c', 'model_reasoning_summary="auto"']
const HERMES_MCP_SERVER_NAME = 'hermes-studio'

let pty: any = null

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return
  try {
    const nodePtyRoot = dirname(require.resolve('node-pty/package.json'))
    const candidates = [
      join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
      join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]
    for (const helperPath of candidates) {
      if (!existsSync(helperPath)) continue
      try {
        accessSync(helperPath, fsConstants.X_OK)
      } catch {
        chmodSync(helperPath, 0o755)
      }
    }
  } catch (err) {
    logger.warn(err, '[coding-agent-run] failed to normalize node-pty helper permissions')
  }
}

try {
  ensureNodePtySpawnHelperExecutable()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err) {
  logger.warn(err, '[coding-agent-run] node-pty unavailable; hidden coding agent sessions disabled')
}

export interface CodingAgentRunLaunch {
  agentSessionId: string
  agentId: string
  mode?: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  sessionId: string
  agentNativeSessionId?: string
  nativeResume?: boolean
  command: string
  args: string[]
  shellCommand: string
  workspaceDir: string
  env?: NodeJS.ProcessEnv
  state?: SessionState
  sessionSource?: 'global_agent' | 'workflow'
  reasoningEffort?: string
}

interface ManagedCodingAgentRun {
  id: string
  launch: CodingAgentRunLaunch
  pty?: { pid: number; write: (data: string) => void; kill: (signal?: string) => void; onData: (cb: (data: string) => void) => void; onExit: (cb: (event: { exitCode: number }) => void) => void }
  state: SessionState
  runMarker?: string
  lastActiveAt: number
  idleTimer?: ReturnType<typeof setTimeout>
  terminalBuffer?: string
  terminalFlushTimer?: ReturnType<typeof setTimeout>
  apiKeyPromptAnswered?: boolean
  startedAt: number
  exited: boolean
  currentChild?: ChildProcess
  currentChildKillTimer?: ReturnType<typeof setTimeout>
  currentChildStderr?: string
  printResponseId?: string
  printMessageId?: string
  printTextStarted?: boolean
  printText?: string
  printCompleted?: boolean
  responseStartEmitted?: boolean
  terminalEventHandled?: boolean
  acceptingPrintEvent?: boolean
  printToolBlocks?: Map<number, { id: string; name: string; arguments: string; done: boolean }>
  nativeResumeReady?: boolean
  codexToolBlocks?: Map<string, { id: string; name: string; arguments: string; done: boolean }>
  codexChatText?: string
  codexPendingUsage?: any
  codexContextLimit?: number
  pendingSteer?: string
  stoppedByUser?: boolean
  pendingChatCompletionEvent?: 'run.completed' | 'run.failed'
  pendingChatCompletionPayload?: Record<string, unknown>
}

interface CodingAgentRunSendOptions {
  systemPrompt?: string
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function makeId(): string {
  return `car_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

type NormalizedCodingAgentUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  reasoningTokens?: number
  contextTokens?: number
  contextLimit?: number
}

function finiteUsageNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric)
  }
  return undefined
}

function nestedUsageValue(usage: any, ...keys: string[]): unknown[] {
  const values: unknown[] = []
  for (const key of keys) values.push(usage?.[key])
  for (const container of [usage?.tokens, usage?.token_usage, usage?.tokenUsage]) {
    if (!container || typeof container !== 'object') continue
    for (const key of keys) values.push(container[key])
  }
  return values
}

function codexUsageInfo(usage: any): any {
  return usage?.info && typeof usage.info === 'object' ? usage.info : usage
}

function codexLastUsage(usage: any): any {
  const info = codexUsageInfo(usage)
  const last = info?.last_token_usage || info?.lastTokenUsage || info?.last
  return last && typeof last === 'object' ? last : null
}

function codexContextUsage(usage: any): any {
  if (!usage || typeof usage !== 'object') return usage
  // Codex exposes both a cumulative billing counter (`total_token_usage`) and
  // the prompt/context size of the most recent request (`last_token_usage`).
  // The context meter must use the latter; otherwise long sessions show
  // impossible values such as 731k / 256k. Codex app-server/Paseo normalizes
  // the same field as `last`.
  return codexLastUsage(usage) || usage
}

function codexAccountingUsage(usage: any): any {
  if (!usage || typeof usage !== 'object') return usage
  const info = codexUsageInfo(usage)
  const total = info?.total_token_usage || info?.totalTokenUsage
  if (total && typeof total === 'object') return total
  const directAccountingTokens = finiteUsageNumber(
    ...nestedUsageValue(usage, 'total_tokens', 'totalTokens', 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'),
  )
  return directAccountingTokens != null ? usage : codexContextUsage(usage)
}

function codexModelContextWindow(usage: any): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const info = codexUsageInfo(usage)
  return finiteUsageNumber(
    info?.model_context_window,
    info?.modelContextWindow,
    usage?.model_context_window,
    usage?.modelContextWindow,
  )
}

function codexUsageHasLastTokenUsage(usage: any): boolean {
  return !!codexLastUsage(usage)
}

function copyCodexContextWindow(next: any, current: any): any {
  const existing = codexModelContextWindow(next)
  const fallback = codexModelContextWindow(current)
  if (existing || !fallback || !next || typeof next !== 'object') return next
  const info = codexUsageInfo(next)
  if (info !== next && info && typeof info === 'object') {
    return { ...next, info: { ...info, model_context_window: fallback } }
  }
  return { ...next, model_context_window: fallback }
}

function preferCodexUsage(current: any, next: any): any {
  if (!next || typeof next !== 'object') return current
  if (!current || typeof current !== 'object') return next
  if (codexUsageHasLastTokenUsage(current) && !codexUsageHasLastTokenUsage(next)) return current
  return copyCodexContextWindow(next, current)
}

function tokenBucketToCodexUsage(bucket: CodexTokenUsage): Record<string, number> {
  return {
    input_tokens: bucket.inputTokens,
    cached_input_tokens: bucket.cacheReadTokens,
    output_tokens: bucket.outputTokens,
    reasoning_output_tokens: bucket.reasoningTokens,
    total_tokens: bucket.totalTokens,
  }
}

function withCodexContextUsage(usage: any, contextUsage: CodexTokenUsage | null): any {
  if (!contextUsage) return usage
  const contextFields = {
    last_token_usage: tokenBucketToCodexUsage(contextUsage),
    ...(contextUsage.contextLimit ? { model_context_window: contextUsage.contextLimit } : {}),
  }
  if (!usage || typeof usage !== 'object') return contextFields
  const info = codexUsageInfo(usage)
  if (info !== usage && info && typeof info === 'object') {
    return { ...usage, info: { ...info, ...contextFields } }
  }
  return { ...usage, ...contextFields }
}

function normalizeCodingAgentUsageFrom(usage: any, usageSelector: (usage: any) => any): NormalizedCodingAgentUsage | null {
  if (!usage || typeof usage !== 'object') return null
  const contextUsage = usageSelector(usage)
  const inputTokens = finiteUsageNumber(
    ...nestedUsageValue(contextUsage, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'),
  )
  const outputTokens = finiteUsageNumber(
    ...nestedUsageValue(contextUsage, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'),
  )
  const totalTokens = finiteUsageNumber(
    ...nestedUsageValue(contextUsage, 'total_tokens', 'totalTokens', 'context_tokens', 'contextTokens'),
  )
  const cacheReadTokens = finiteUsageNumber(
    ...nestedUsageValue(contextUsage, 'cached_input_tokens', 'cachedInputTokens', 'cache_read_tokens', 'cacheReadTokens'),
  )
  const reasoningTokens = finiteUsageNumber(
    ...nestedUsageValue(contextUsage, 'reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning_tokens', 'reasoningTokens'),
  )
  if (inputTokens == null && outputTokens == null && totalTokens == null) return null
  const normalizedInput = inputTokens ?? Math.max(0, (totalTokens ?? 0) - (outputTokens ?? 0))
  const normalizedOutput = outputTokens ?? Math.max(0, (totalTokens ?? 0) - normalizedInput)
  const normalizedTotal = totalTokens ?? normalizedInput + normalizedOutput
  const contextLimit = codexModelContextWindow(usage)
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
    contextTokens: normalizedTotal,
    ...(contextLimit ? { contextLimit } : {}),
  }
}

function normalizeCodingAgentUsage(usage: any): NormalizedCodingAgentUsage | null {
  return normalizeCodingAgentUsageFrom(usage, codexContextUsage)
}

function normalizeCodingAgentAccountingUsage(usage: any): NormalizedCodingAgentUsage | null {
  return normalizeCodingAgentUsageFrom(usage, codexAccountingUsage)
}

function applyRunContextLimit(
  normalizedUsage: NormalizedCodingAgentUsage | null,
  run: ManagedCodingAgentRun,
): NormalizedCodingAgentUsage | null {
  if (!normalizedUsage) return null
  if (normalizedUsage.contextLimit || !run.codexContextLimit) return normalizedUsage
  return { ...normalizedUsage, contextLimit: run.codexContextLimit }
}

export function codingAgentGatewayErrorMessage(text: string): string | null {
  const value = String(text || '').trim()
  if (!value) return null
  if (/^API Error:\s*\d+\b/i.test(value)) return value
  if (/^Provider returned HTTP\s+\d+\b/i.test(value)) return value
  return null
}

function responseErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const message = record.message || record.error || record.detail
    if (typeof message === 'string') return message
  }
  return String(error)
}

function isProxyToolEvent(event: CanonicalResponsesEvent): boolean {
  const data: any = event.data || {}
  const item = data.item || data.output_item || data
  return event.type === 'response.function_call_arguments.delta' ||
    ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && item?.type === 'function_call')
}

function isCodexProxyExecToolEvent(event: CanonicalResponsesEvent): boolean {
  const data: any = event.data || {}
  const item = data.item || data.output_item || data
  if (
    (event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done') ||
    item?.type !== 'function_call'
  ) {
    return false
  }
  const name = String(item.name || item.function?.name || '').trim()
  return name === 'exec_command' || name === 'functions.exec_command'
}

function truncateCodingAgentToolOutputForStorage(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  if (text.length <= CODING_AGENT_TOOL_OUTPUT_STORAGE_LIMIT) return text
  const head = text.slice(0, CODING_AGENT_TOOL_OUTPUT_HEAD_CHARS)
  const tail = text.slice(-CODING_AGENT_TOOL_OUTPUT_TAIL_CHARS)
  const omitted = text.length - head.length - tail.length
  return [
    head,
    '',
    `[Hermes Web UI: coding-agent tool output truncated for storage; original_chars=${text.length}; omitted_chars=${omitted}]`,
    '',
    tail,
  ].join('\n')
}

function truncateCodingAgentToolOutputItem(item: any): any {
  if (!item || item.type !== 'function_call_output') return item
  const nextOutput = truncateCodingAgentToolOutputForStorage(item.output)
  if (nextOutput === item.output) return item
  return { ...item, output: nextOutput }
}

function truncateCodingAgentToolOutputEvent(event: CanonicalResponsesEvent): CanonicalResponsesEvent {
  const data: any = event.data || {}
  if (event.type === 'response.output_item.done') {
    const item = data.item || data.output_item || data
    const nextItem = truncateCodingAgentToolOutputItem(item)
    if (nextItem === item) return event
    if (data.item) return { ...event, data: { ...data, item: nextItem } }
    if (data.output_item) return { ...event, data: { ...data, output_item: nextItem } }
    return { ...event, data: nextItem }
  }

  if (event.type === 'response.completed') {
    const response = data.response || data
    const output = Array.isArray(response?.output) ? response.output : null
    if (!output) return event
    let changed = false
    const nextOutput = output.map((item: any) => {
      const nextItem = truncateCodingAgentToolOutputItem(item)
      if (nextItem !== item) changed = true
      return nextItem
    })
    if (!changed) return event
    const nextResponse = { ...response, output: nextOutput }
    return data.response
      ? { ...event, data: { ...data, response: nextResponse } }
      : { ...event, data: nextResponse }
  }

  return event
}

function isPrintAgent(agentId: string): boolean {
  return agentId === 'claude-code' || agentId === 'codex'
}

function hasManagedHermesMcpConfig(run: ManagedCodingAgentRun): boolean {
  if (run.launch.agentId !== 'codex' || run.launch.mode !== 'scoped') return true
  const codexHome = String(run.launch.env?.CODEX_HOME || '').trim()
  if (!codexHome) return false
  try {
    const config = readFileSync(join(codexHome, 'config.toml'), 'utf-8')
    return config.includes(`[mcp_servers.${HERMES_MCP_SERVER_NAME}]`)
  } catch {
    return false
  }
}

function childIsRunning(child?: ChildProcess): boolean {
  return Boolean(child && child.exitCode == null && child.signalCode == null && !child.killed)
}

function normalizeCliPromptArgument(prompt: string): string {
  const text = String(prompt || '').trim()
  if (!text || process.platform !== 'win32') return text
  return text
    .split(/\r\n|\n|\r/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' / ')
}

function hasArg(args: string[], name: string): boolean {
  return args.includes(name)
}

function formatCodingAgentSteerInstruction(text: string): string {
  return [
    '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered mid-turn; not tool output]',
    text.trim(),
    '[/OUT-OF-BAND USER MESSAGE]',
  ].join('\n')
}

function compactUnknownValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function codexFileChangeEntries(item: any): Array<{ path: string; action: string }> {
  const rawChanges = Array.isArray(item?.changes)
    ? item.changes
    : Array.isArray(item?.files)
      ? item.files
      : Array.isArray(item?.diffs)
        ? item.diffs
        : []
  const changes = rawChanges
    .map((change: any) => ({
      path: compactUnknownValue(change?.path || change?.file || change?.file_path || change?.filePath),
      action: compactUnknownValue(change?.kind || change?.action || change?.change || change?.status),
    }))
    .filter((change: { path: string; action: string }) => change.path || change.action)
  if (changes.length) return changes
  const path = compactUnknownValue(item?.path || item?.file || item?.file_path || item?.filePath)
  const action = compactUnknownValue(item?.kind || item?.action || item?.change || item?.status)
  return path || action ? [{ path, action }] : []
}

function codexFileChangeSummary(item: any): string {
  const changes = codexFileChangeEntries(item)
  return changes
    .map(change => [change.action, change.path].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ')
}

function decodeChildChunk(chunk: Buffer): string {
  const utf8 = chunk.toString('utf8')
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gb18030').decode(chunk)
  } catch {
    return utf8
  }
}

function spawnCodingAgentChild(command: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
}): ChildProcess {
  const normalizedCommand = process.platform === 'win32' ? normalizeWindowsCommandPath(command) : command
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const execution = windowsCmdShimExecution(normalizedCommand, args)
    return spawn(execution.command, execution.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
      windowsHide: true,
    })
  }

  return spawn(normalizedCommand, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: process.platform === 'win32',
  })
}

function childProcessErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (!err || typeof err !== 'object') return String(err || 'Process failed')
  const record = err as Record<string, unknown>
  const message = record.message
  if (typeof message === 'string' && message.trim()) return message
  try {
    return JSON.stringify(record)
  } catch {
    return String(err)
  }
}

function appendChildStderr(run: ManagedCodingAgentRun, chunk: Buffer): string {
  const text = sanitizeCodingAgentTerminalOutput(decodeChildChunk(chunk))
  run.currentChildStderr = `${run.currentChildStderr || ''}${text}`.slice(-CHILD_STDERR_TAIL_CHARS)
  return text.trim()
}

function exitErrorMessage(agentName: string, code: number | null, stderr?: string): string {
  const message = `${agentName} exited with code ${code ?? 'unknown'}`
  const detail = String(stderr || '').trim()
  return detail ? `${message}: ${detail}` : message
}

function appendedTextDelta(existing: string, next: string): string {
  if (!existing || !next) return next
  if (next.startsWith(existing)) return next.slice(existing.length)
  const max = Math.min(existing.length, next.length)
  for (let length = max; length >= 16; length--) {
    if (existing.endsWith(next.slice(0, length))) return next.slice(length)
  }
  return next
}

function terminateChildProcess(child?: ChildProcess) {
  if (!child || !child.pid || !childIsRunning(child)) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {})
    return
  }
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    try { process.kill(child.pid, 'SIGINT') } catch {}
  }
}

function forceKillChildProcess(child?: ChildProcess) {
  if (!child || !child.pid || !childIsRunning(child)) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => {})
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { process.kill(child.pid, 'SIGKILL') } catch {}
  }
}

function claudeContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content == null) return ''
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (!block || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    try {
      return JSON.stringify(record)
    } catch {
      return String(record)
    }
  }).filter(Boolean).join('\n')
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  const shell = process.env.SHELL || ''
  if (shell && existsSync(shell)) return shell
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  if (existsSync('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

export function sanitizeCodingAgentTerminalOutput(value: string): string {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|sk-ant|sk-proj|sk-or)-[A-Za-z0-9._-]{8,}\b/g, '[redacted-api-key]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
}

export class CodingAgentRunManager {
  private runs = new Map<string, ManagedCodingAgentRun>()
  private sessionIndex = new Map<string, string>()

  constructor(private readonly idleMs = DEFAULT_IDLE_MS) {}

  isAvailable(): boolean {
    return !!pty
  }

  hasSession(sessionId: string): boolean {
    const run = this.getBySession(sessionId)
    return Boolean(run && !run.exited)
  }

  isSessionProcessing(sessionId: string): boolean {
    const run = this.getBySession(sessionId)
    return childIsRunning(run?.currentChild)
  }

  private enrichCodexUsageFromSessionLog(run: ManagedCodingAgentRun, usage: any): any {
    if (run.launch.agentId !== 'codex') return usage
    const nativeSessionId = String(run.launch.agentNativeSessionId || '').trim()
    if (!nativeSessionId) return usage
    const contextUsage = readCodexLatestContextUsageForNativeSession(nativeSessionId)
    return withCodexContextUsage(usage, contextUsage)
  }

  private persistCodingAgentTokenUsage(run: ManagedCodingAgentRun, usage: any): void {
    const normalizedUsage = normalizeCodingAgentAccountingUsage(usage)
    const normalizedContextUsage = applyRunContextLimit(normalizeCodingAgentUsage(usage), run)
    if (!normalizedUsage && !normalizedContextUsage) return
    try {
      updateSession(run.launch.sessionId, {
        input_tokens: normalizedUsage?.inputTokens ?? 0,
        output_tokens: normalizedUsage?.outputTokens ?? 0,
        context_tokens: normalizedContextUsage?.contextTokens ?? 0,
        context_limit: normalizedContextUsage?.contextLimit ?? 0,
        cache_read_tokens: normalizedUsage?.cacheReadTokens ?? 0,
        reasoning_tokens: normalizedUsage?.reasoningTokens ?? 0,
        ...(run.launch.model ? { model: run.launch.model } : {}),
        ...(run.launch.provider ? { provider: run.launch.provider } : {}),
      })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist coding-agent token usage')
    }
  }

  runIdForSession(sessionId: string): string | undefined {
    const run = this.getBySession(sessionId)
    return run && !run.exited ? run.id : undefined
  }

  isSessionLaunchCompatible(sessionId: string, launch: {
    agentId: string
    mode?: 'scoped' | 'global'
    provider?: string
    model?: string
    workspace?: string | null
    reasoningEffort?: string
  }): boolean {
    const run = this.getBySession(sessionId)
    if (!run || run.exited) return false
    const mode = launch.mode === 'global' ? 'global' : 'scoped'
    if (run.launch.agentId !== launch.agentId) return false
    if (run.launch.mode !== mode) return false
    if (mode === 'scoped') {
      const provider = String(launch.provider || '').trim()
      const model = String(launch.model || '').trim()
      if (provider && run.launch.provider !== provider) return false
      if (model && run.launch.model !== model) return false
    }
    const workspace = String(launch.workspace || '').trim()
    if (workspace && run.launch.workspaceDir !== workspace) return false
    if (String(run.launch.reasoningEffort || '').trim() !== String(launch.reasoningEffort || '').trim()) return false
    if (!hasManagedHermesMcpConfig(run)) return false
    return true
  }

  start(launch: CodingAgentRunLaunch): { runId: string; pid: number } {
    const existingRunId = this.sessionIndex.get(launch.sessionId)
    if (existingRunId) {
      const existing = this.runs.get(existingRunId)
      if (existing && !existing.exited) {
        if (this.isSessionLaunchCompatible(launch.sessionId, {
          agentId: launch.agentId,
          mode: launch.mode,
          provider: launch.provider,
          model: launch.model,
          workspace: launch.workspaceDir,
          reasoningEffort: launch.reasoningEffort,
        })) {
          return { runId: existing.id, pid: existing.pty?.pid || existing.currentChild?.pid || 0 }
        }
        this.stop(launch.sessionId, { reportClosed: false })
      }
    }

    const runId = launch.agentSessionId || makeId()
    const state = launch.state || { messages: [], isWorking: false, events: [], queue: [] }
    state.isWorking = true
    state.profile = launch.profile
    state.source = launch.sessionSource === 'workflow' ? 'workflow' : 'coding_agent'
    state.runId = runId

    if (isPrintAgent(launch.agentId)) {
      const run: ManagedCodingAgentRun = {
        id: runId,
        launch,
        state,
        lastActiveAt: Date.now(),
        startedAt: Date.now(),
        exited: false,
        nativeResumeReady: launch.nativeResume === true,
      }
      this.runs.set(run.id, run)
      this.sessionIndex.set(launch.sessionId, run.id)
      this.ensureDbSession(run)
      this.touch(run)
      this.emitTerminalStatus(run, `${launch.agentId === 'codex' ? 'Codex' : 'Claude Code'} chat runner ready.`)
      logger.info({
        runId: run.id,
        sessionId: launch.sessionId,
        agentId: launch.agentId,
        mode: launch.mode,
        profile: launch.profile,
        provider: launch.provider,
        model: launch.model,
      }, '[coding-agent-run] print runner started')
      return { runId: run.id, pid: 0 }
    }

    if (!pty) throw new Error('Hidden coding agent terminal is unavailable because node-pty is not installed')

    const shell = defaultShell()
    const args = process.platform === 'win32'
      ? ['-NoExit', '-Command', launch.shellCommand]
      : ['-lc', launch.shellCommand]
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: existsSync(launch.workspaceDir) ? launch.workspaceDir : homedir(),
      env: {
        ...process.env,
        ...(launch.env || {}),
      },
    })

    const run: ManagedCodingAgentRun = {
      id: runId,
      launch,
      pty: proc,
      state,
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    this.runs.set(run.id, run)
    this.sessionIndex.set(launch.sessionId, run.id)
    this.ensureDbSession(run)
    this.touch(run)
    this.emitTerminalStatus(run, `${launch.agentId === 'codex' ? 'Codex' : 'Claude Code'} session started.`)

    proc.onData((data: string) => {
      this.touch(run)
      logger.debug({ runId: run.id, bytes: Buffer.byteLength(data || '', 'utf8') }, '[coding-agent-run] pty output')
      this.maybeAnswerClaudeApiKeyPrompt(run, data)
      this.bufferTerminalOutput(run, data)
    })
    proc.onExit(({ exitCode }: { exitCode: number }) => {
      run.exited = true
      this.cleanupRun(run, { kill: false })
      logger.info({ runId: run.id, sessionId: launch.sessionId, exitCode }, '[coding-agent-run] process exited')
    })

    logger.info({
      runId: run.id,
      sessionId: launch.sessionId,
      agentId: launch.agentId,
      mode: launch.mode,
      profile: launch.profile,
      provider: launch.provider,
      model: launch.model,
      pid: proc.pid,
    }, '[coding-agent-run] hidden session started')

    return { runId: run.id, pid: proc.pid }
  }

  send(sessionId: string, input: string, options: CodingAgentRunSendOptions = {}): { runId: string } {
    const run = this.getBySession(sessionId)
    if (!run) throw new Error('Coding agent session not found')
    const text = String(input || '').trim()
    if (!text) throw new Error('Input is required')
    const systemPrompt = String(options.systemPrompt || '').trim()
    this.ensureDbSession(run)
    this.addUserMessage(run, text)
    this.touch(run)
    this.emitTerminalStatus(run, 'Input sent to coding agent.')
    this.startWorkspaceRunDiff(run)
    if (run.launch.agentId === 'claude-code') {
      this.startClaudePrintTurn(run, text, systemPrompt)
      return { runId: run.id }
    }
    if (run.launch.agentId === 'codex') {
      this.startCodexExecTurn(run, text, systemPrompt)
      return { runId: run.id }
    }
    if (!run.pty) throw new Error('Coding agent terminal is not available')
    run.pty.write(`${text}\r`)
    return { runId: run.id }
  }

  steer(sessionId: string, input: string): { runId: string; queued: boolean } {
    const run = this.getBySession(sessionId)
    if (!run || run.exited) throw new Error('Coding agent session not found')
    const text = String(input || '').trim()
    if (!text) throw new Error('Input is required')
    const steerText = formatCodingAgentSteerInstruction(text)
    this.ensureDbSession(run)
    this.touch(run)
    if (run.launch.agentId === 'claude-code' || run.launch.agentId === 'codex') {
      if (childIsRunning(run.currentChild)) {
        run.pendingSteer = [run.pendingSteer, steerText].filter(Boolean).join('\n\n')
        this.emitTerminalStatus(run, 'Steer instruction queued for the running coding-agent turn.')
        return { runId: run.id, queued: true }
      }
      this.startCodingAgentSteerTurn(run, steerText)
      return { runId: run.id, queued: false }
    }
    if (!run.pty) throw new Error('Coding agent terminal is not available')
    run.pty.write(`${steerText}\r`)
    return { runId: run.id, queued: false }
  }

  stop(sessionId: string, options: { reportClosed?: boolean } = {}): boolean {
    const run = this.getBySession(sessionId)
    if (!run) return false
    if (options.reportClosed === false) run.stoppedByUser = true
    this.cleanupRun(run, { kill: true, reportClosed: options.reportClosed ?? true })
    return true
  }

  touchByAgentSession(agentSessionId?: string | null) {
    if (!agentSessionId) return
    const run = this.runs.get(agentSessionId)
    if (run) this.touch(run)
  }

  handleResponseEvent(agentSessionId: string | undefined, event: CanonicalResponsesEvent) {
    if (!agentSessionId) return
    const run = this.runs.get(agentSessionId)
    if (!run) return
    if (run.launch.agentId === 'codex' && isCodexProxyExecToolEvent(event)) return
    const responseEvent = this.normalizeCodexChatTextEvent(run, event)
    if (!responseEvent) return
    const storageSafeResponseEvent = truncateCodingAgentToolOutputEvent(responseEvent)
    if (run.launch.agentId === 'claude-code' && run.currentChild && !run.acceptingPrintEvent && !isProxyToolEvent(event)) return
    if (storageSafeResponseEvent.type === 'response.created') {
      if (run.responseStartEmitted) return
      run.responseStartEmitted = true
    }
    const isTerminalEvent = storageSafeResponseEvent.type === 'response.completed' || storageSafeResponseEvent.type === 'response.failed'
    if (
      run.launch.agentId === 'codex' &&
      storageSafeResponseEvent.type === 'response.completed' &&
      childIsRunning(run.currentChild)
    ) {
      const final = (storageSafeResponseEvent.data as any).response || storageSafeResponseEvent.data
      run.codexPendingUsage = preferCodexUsage(run.codexPendingUsage, this.enrichCodexUsageFromSessionLog(run, final?.usage))
      return
    }
    if (isTerminalEvent) {
      if (run.terminalEventHandled) return
      run.terminalEventHandled = true
    }
    this.touch(run)
    this.ensureDbSession(run)
    if (!run.runMarker) run.runMarker = `coding_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    run.state.isWorking = true
    run.state.profile = run.launch.profile
    run.state.source = run.launch.sessionSource === 'workflow' ? 'workflow' : 'coding_agent'
    run.state.runId = run.id
    for (const mappedEvent of mapCodingAgentResponseEvent(storageSafeResponseEvent)) {
      this.emitToChat(run.launch.sessionId, mappedEvent.event, mappedEvent.payload)
    }
    const mapped = applyResponseStreamEvent(run.state, run.launch.sessionId, run.runMarker, storageSafeResponseEvent.type, storageSafeResponseEvent.data)
    if (mapped) {
      this.emitToChat(run.launch.sessionId, mapped.event, mapped.payload)
    }
    if (isTerminalEvent) {
      flushResponseRunToDb(run.state, run.launch.sessionId)
      run.state.responseRun = undefined
      updateSessionStats(run.launch.sessionId)
      void this.refreshCodingAgentUsage(run)
      const final = (storageSafeResponseEvent.data as any).response || storageSafeResponseEvent.data
      const finalText = extractResponseText(final)
      const usageForCompletion = run.launch.agentId === 'codex'
        ? preferCodexUsage(run.codexPendingUsage, this.enrichCodexUsageFromSessionLog(run, final?.usage))
        : final?.usage
      if (run.launch.agentId === 'codex') run.codexPendingUsage = usageForCompletion
      const normalizedUsage = applyRunContextLimit(normalizeCodingAgentUsage(usageForCompletion), run)
      if (normalizedUsage) {
        run.state.inputTokens = normalizedUsage.inputTokens
        run.state.outputTokens = normalizedUsage.outputTokens
        if (normalizedUsage.contextTokens != null) run.state.contextTokens = normalizedUsage.contextTokens
        if (normalizedUsage.contextLimit != null) run.state.contextLimit = normalizedUsage.contextLimit
        this.persistCodingAgentTokenUsage(run, usageForCompletion)
        this.emitToChat(run.launch.sessionId, 'usage.updated', {
          event: 'usage.updated',
          session_id: run.launch.sessionId,
          inputTokens: normalizedUsage.inputTokens,
          outputTokens: normalizedUsage.outputTokens,
          contextTokens: normalizedUsage.contextTokens,
          contextLimit: normalizedUsage.contextLimit,
        })
      }
      const terminalError = storageSafeResponseEvent.type === 'response.failed'
        ? responseErrorMessage(final?.error || (responseEvent.data as any).error) || 'Coding agent run failed'
        : codingAgentGatewayErrorMessage(finalText)
      const chatCompletionEvent = terminalError ? 'run.failed' : 'run.completed'
      const chatCompletionPayload: Record<string, unknown> = {
        event: chatCompletionEvent,
        run_id: final?.id,
        response_id: final?.id,
        output: finalText,
        error: terminalError || undefined,
        ...(normalizedUsage ? {
          usage: {
            inputTokens: normalizedUsage.inputTokens,
            outputTokens: normalizedUsage.outputTokens,
            contextTokens: normalizedUsage.contextTokens,
            contextLimit: normalizedUsage.contextLimit,
          },
          inputTokens: normalizedUsage.inputTokens,
          outputTokens: normalizedUsage.outputTokens,
          contextTokens: normalizedUsage.contextTokens,
          contextLimit: normalizedUsage.contextLimit,
        } : {}),
      }
      if (childIsRunning(run.currentChild)) {
        run.pendingChatCompletionEvent = chatCompletionEvent
        run.pendingChatCompletionPayload = chatCompletionPayload
      } else {
        this.emitAndMarkPrintChatRunCompleted(run, chatCompletionEvent, chatCompletionPayload)
      }
    }
  }

  private async refreshCodingAgentUsage(run: ManagedCodingAgentRun) {
    const emitUsage = (event: string, payload: any) => {
      this.emitToChat(run.launch.sessionId, event, payload)
    }
    const usage = await calcAndUpdateUsage(run.launch.sessionId, run.state, emitUsage)
    updateMessageContextTokenUsage(
      run.launch.sessionId,
      run.state,
      emitUsage,
      usage.inputTokens + usage.outputTokens,
      usage,
    )
  }

  private normalizeCodexChatTextEvent(run: ManagedCodingAgentRun, event: CanonicalResponsesEvent): CanonicalResponsesEvent | null {
    if (run.launch.agentId !== 'codex' || event.type !== 'response.output_text.delta') return event
    const data: any = event.data || {}
    const text = typeof data.delta === 'string'
      ? data.delta
      : typeof data.text === 'string'
        ? data.text
        : ''
    if (!text) return event
    const existing = run.codexChatText || ''
    const delta = text.length >= 16 ? appendedTextDelta(existing, text) : text
    if (!delta) return null
    run.codexChatText = `${existing}${delta}`
    if (delta === text) return event
    return {
      ...event,
      data: {
        ...data,
        delta,
        text: typeof data.text === 'string' ? delta : data.text,
      },
    }
  }

  hasActiveRuns(): boolean {
    return [...this.runs.values()].some(run => run.state.isWorking || childIsRunning(run.currentChild))
  }

  activeRunSummary(): Array<{ sessionId: string; runId: string; agentId: string; mode: 'scoped' | 'global' }> {
    return [...this.runs.values()]
      .filter(run => run.state.isWorking || childIsRunning(run.currentChild))
      .map(run => ({
        sessionId: run.launch.sessionId,
        runId: run.id,
        agentId: run.launch.agentId,
        mode: run.launch.mode || 'scoped',
      }))
  }

  shutdown() {
    for (const run of [...this.runs.values()]) this.cleanupRun(run, { kill: true })
  }

  private getBySession(sessionId: string): ManagedCodingAgentRun | null {
    const runId = this.sessionIndex.get(sessionId)
    return runId ? this.runs.get(runId) || null : null
  }

  private ensureDbSession(run: ManagedCodingAgentRun) {
    if (getSession(run.launch.sessionId)) return
    const source = run.launch.sessionSource === 'global_agent'
      ? 'global_agent'
      : run.launch.sessionSource === 'workflow'
        ? 'workflow'
        : 'coding_agent'
    createSession({
      id: run.launch.sessionId,
      profile: run.launch.profile,
        source,
        agent: run.launch.agentId === 'codex' ? 'codex' : 'claude',
        agent_session_id: run.id,
        agent_native_session_id: run.launch.agentNativeSessionId,
        model: run.launch.model,
      provider: run.launch.provider,
      title: '',
      workspace: run.launch.workspaceDir,
    })
  }

  private addUserMessage(run: ManagedCodingAgentRun, content: string) {
    const timestamp = nowSeconds()
    run.state.messages.push({
      id: run.state.messages.length + 1,
      session_id: run.launch.sessionId,
      runMarker: run.runMarker,
      role: 'user',
      content,
      timestamp,
    })
    const id = addMessage({ session_id: run.launch.sessionId, role: 'user', content, timestamp })
    logger.debug({ runId: run.id, sessionId: run.launch.sessionId, messageId: id }, '[coding-agent-run] recorded user message')
  }

  private touch(run: ManagedCodingAgentRun) {
    run.lastActiveAt = Date.now()
    if (run.idleTimer) clearTimeout(run.idleTimer)
    run.idleTimer = setTimeout(() => {
      const current = this.runs.get(run.id)
      if (!current) return
      const remaining = this.idleMs - (Date.now() - current.lastActiveAt)
      if (remaining > 0) {
        this.touch(current)
        return
      }
      logger.info({ runId: current.id, sessionId: current.launch.sessionId, idleMs: this.idleMs }, '[coding-agent-run] closing idle hidden session')
      this.cleanupRun(current, { kill: true })
    }, this.idleMs)
  }

  private cleanupRun(run: ManagedCodingAgentRun, options: { kill: boolean; reportClosed?: boolean }) {
    const shouldReportClosed = options.reportClosed !== false && (run.state.isWorking || Boolean(run.currentChild && !run.currentChild.killed))
    if (run.idleTimer) clearTimeout(run.idleTimer)
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
    this.flushTerminalOutput(run)
    if (run.terminalFlushTimer) clearTimeout(run.terminalFlushTimer)
    this.runs.delete(run.id)
    if (this.sessionIndex.get(run.launch.sessionId) === run.id) this.sessionIndex.delete(run.launch.sessionId)
    if (options.kill && !run.exited) {
      try { run.pty?.kill() } catch {}
      terminateChildProcess(run.currentChild)
      if (childIsRunning(run.currentChild)) {
        run.currentChildKillTimer = setTimeout(() => forceKillChildProcess(run.currentChild), 1500)
      }
    }
    run.exited = true
    run.state.isWorking = false
    if (shouldReportClosed) {
      const workspaceRunChange = this.completeWorkspaceRunDiff(run)
      this.emitToChat(run.launch.sessionId, 'run.failed', {
        event: 'run.failed',
        error: 'Coding agent session closed',
        workspace_run_change: workspaceRunChange,
      })
      this.markChatRunCompleted(run.launch.sessionId, 'run.failed')
    }
  }

  private startClaudePrintTurn(run: ManagedCodingAgentRun, input: string, systemPrompt = '') {
    if (childIsRunning(run.currentChild)) {
      throw new Error('Claude Code is still processing the previous input')
    }

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.printToolBlocks = new Map()
    run.currentChildStderr = ''
    run.runMarker = undefined

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    const nativeSessionArgs = run.launch.agentNativeSessionId
      ? (run.nativeResumeReady
          ? ['--resume', run.launch.agentNativeSessionId]
          : ['--session-id', run.launch.agentNativeSessionId])
      : []
    const promptArgument = hasArg(run.launch.args, '--append-system-prompt-file')
      ? ''
      : normalizeCliPromptArgument(systemPrompt)
    const args = [
      ...run.launch.args,
      ...nativeSessionArgs,
      ...(promptArgument ? ['--append-system-prompt', promptArgument] : []),
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      input,
    ]
    const child = spawnCodingAgentChild(run.launch.command, args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: {
        ...process.env,
        ...(run.launch.env || {}),
      },
    })
    run.currentChild = child

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.touch(run)
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleClaudePrintLine(run, line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = appendChildStderr(run, chunk)
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] claude print stderr')
    })

    child.on('error', (err) => {
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] claude print failed to start')
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: childProcessErrorMessage(err) },
            output: [],
          },
        },
      })
    })

    child.on('exit', (code) => {
      if (stdoutBuffer.trim()) this.handleClaudePrintLine(run, stdoutBuffer)
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] claude print exited')
      if (run.stoppedByUser) return
      if (run.pendingChatCompletionEvent) {
        this.emitAndMarkPrintChatRunCompleted(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
        return
      }
      if (code === 0) {
        this.completeClaudePrintTurn(run)
        return
      }
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: exitErrorMessage('Claude Code', code, run.currentChildStderr) },
            output: [],
          },
        },
      })
    })
  }

  private handleClaudePrintResponseEvent(run: ManagedCodingAgentRun, event: CanonicalResponsesEvent) {
    run.acceptingPrintEvent = true
    try {
      this.handleResponseEvent(run.id, event)
    } finally {
      run.acceptingPrintEvent = false
    }
  }

  private handleClaudePrintLine(run: ManagedCodingAgentRun, line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(trimmed) }, '[coding-agent-run] ignored non-json Claude print line')
      return
    }

    if (event.type === 'stream_event' && event.event) {
      this.handleClaudeAnthropicStreamEvent(run, event.event)
      return
    }

    if (typeof event.session_id === 'string' && event.session_id.trim()) {
      this.recordClaudeNativeSessionId(run, event.session_id.trim())
    }

    if ((event.type === 'assistant' || event.type === 'user') && event.message) {
      this.handleClaudeTopLevelMessage(run, event.message)
      return
    }

    if (event.type === 'result') {
      if (run.printCompleted) return
      const resultText = String(event.result || '')
      if (resultText && !run.printTextStarted) {
        this.ensureClaudePrintText(run)
        run.printText = `${run.printText || ''}${resultText}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: resultText,
          },
        })
      }
      this.completeClaudePrintTurn(run, event.usage)
    }
  }

  private recordClaudeNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    if (run.launch.agentNativeSessionId === nativeSessionId && run.nativeResumeReady) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist Claude native session id')
    }
  }

  private handleClaudeTopLevelMessage(run: ManagedCodingAgentRun, message: any) {
    const role = String(message?.role || '')
    const content = Array.isArray(message?.content) ? message.content : []
    if (!content.length) return

    if (role === 'assistant') {
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'tool_use') continue
        const toolBlock = {
          id: String(block.id || `toolu_${index}`),
          name: String(block.name || 'tool'),
          arguments: JSON.stringify(block.input || {}),
          done: false,
        }
        run.printToolBlocks?.set(index, toolBlock)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
      }
      return
    }

    if (role === 'user') {
      for (const [index, block] of content.entries()) {
        if (block?.type !== 'tool_result') continue
        const callId = String(block.tool_use_id || block.id || `toolu_${index}`)
        const output = claudeContentToText(block.content)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            output_index: index,
            item: {
              type: 'function_call_output',
              id: callId,
              call_id: callId,
              output,
            },
          },
        })
      }
    }
  }

  private handleClaudeAnthropicStreamEvent(run: ManagedCodingAgentRun, event: any) {
    const type = String(event?.type || '')
    if (type === 'message_start') {
      const id = String(event?.message?.id || run.printResponseId || `resp_${Date.now()}`)
      run.printResponseId = id
      run.printMessageId = `msg_${id}`
      return
    }

    if (type === 'content_block_start') {
      const index = Number(event.index || 0)
      const block = event.content_block || {}
      if (block.type === 'text') {
        this.ensureClaudePrintText(run)
        return
      }
      if (block.type === 'tool_use') {
        const toolBlock = {
          id: String(block.id || `toolu_${index}`),
          name: String(block.name || 'tool'),
          arguments: block.input ? JSON.stringify(block.input) : '',
          done: false,
        }
        run.printToolBlocks?.set(index, toolBlock)
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: index,
            item: {
              type: 'function_call',
              id: toolBlock.id,
              call_id: toolBlock.id,
              name: toolBlock.name,
              arguments: toolBlock.arguments,
            },
          },
        })
      }
      return
    }

    if (type === 'content_block_delta') {
      const index = Number(event.index || 0)
      const delta = event.delta || {}
      if (delta.type === 'thinking_delta' && delta.thinking) {
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.reasoning.delta',
          data: {
            type: 'response.reasoning.delta',
            item_id: run.printMessageId,
            output_index: index,
            delta: String(delta.thinking),
          },
        })
        return
      }
      if (delta.type === 'text_delta' && delta.text) {
        this.ensureClaudePrintText(run)
        const text = String(delta.text)
        run.printText = `${run.printText || ''}${text}`
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: run.printMessageId,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
        })
        return
      }
      if (delta.type === 'input_json_delta' && delta.partial_json) {
        let toolBlock = run.printToolBlocks?.get(index)
        if (!toolBlock) {
          toolBlock = { id: `toolu_${index}`, name: 'tool', arguments: '', done: false }
          run.printToolBlocks?.set(index, toolBlock)
        }
        const argsDelta = String(delta.partial_json)
        toolBlock.arguments += argsDelta
        this.handleClaudePrintResponseEvent(run, {
          type: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            item_id: toolBlock.id,
            output_index: index,
            delta: argsDelta,
          },
        })
      }
      return
    }

    if (type === 'content_block_stop') {
      const index = Number(event.index || 0)
      const toolBlock = run.printToolBlocks?.get(index)
      if (!toolBlock || toolBlock.done) return
      toolBlock.done = true
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: index,
          item: {
            type: 'function_call',
            id: toolBlock.id,
            call_id: toolBlock.id,
            name: toolBlock.name,
            arguments: toolBlock.arguments || '{}',
          },
        },
      })
    }
  }

  private ensureClaudePrintText(run: ManagedCodingAgentRun) {
    if (run.printTextStarted) return
    run.printTextStarted = true
    const item = { type: 'message', id: run.printMessageId, status: 'in_progress', role: 'assistant', content: [] }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: { type: 'response.output_item.added', output_index: 0, item },
    })
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.content_part.added',
      data: {
        type: 'response.content_part.added',
        item_id: run.printMessageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    })
  }

  private completeClaudePrintTurn(run: ManagedCodingAgentRun, usage?: any) {
    if (run.printCompleted) return
    run.printCompleted = true
    const text = run.printText || ''
    const output = run.printTextStarted
      ? [{
          type: 'message',
          id: run.printMessageId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        }]
      : []
    if (run.printTextStarted) {
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_text.done',
        data: {
          type: 'response.output_text.done',
          item_id: run.printMessageId,
          output_index: 0,
          content_index: 0,
          text,
        },
      })
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: output[0],
        },
      })
    }
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'completed',
          model: run.launch.model,
          output,
          usage,
        },
      },
    })
  }

  private startCodexExecTurn(run: ManagedCodingAgentRun, input: string, systemPrompt = '') {
    if (childIsRunning(run.currentChild)) {
      throw new Error('Codex is still processing the previous input')
    }

    const responseId = `resp_${Date.now()}`
    run.printResponseId = responseId
    run.printMessageId = `msg_${responseId}`
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    run.codexPendingUsage = undefined
    run.currentChildStderr = ''
    run.runMarker = undefined

    this.handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: {
        type: 'response.created',
        response: { id: responseId, object: 'response', status: 'in_progress', model: run.launch.model, output: [] },
      },
    })

    const promptArgument = run.launch.mode === 'scoped' ? '' : normalizeCliPromptArgument(systemPrompt)
    const commonArgs = [
      '--json',
      ...CODEX_REASONING_SUMMARY_ARGS,
      ...(promptArgument ? ['-c', `developer_instructions=${JSON.stringify(promptArgument)}`] : []),
      ...run.launch.args,
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]
    const workspaceArgs = ['--cd', run.launch.workspaceDir]
    const args = run.launch.agentNativeSessionId && run.nativeResumeReady
      ? ['exec', ...workspaceArgs, 'resume', ...commonArgs, '--', run.launch.agentNativeSessionId, input]
      : ['exec', ...commonArgs, '--cd', run.launch.workspaceDir, '--', input]

    const child = spawnCodingAgentChild(run.launch.command, args, {
      cwd: existsSync(run.launch.workspaceDir) ? run.launch.workspaceDir : homedir(),
      env: {
        ...process.env,
        ...(run.launch.env || {}),
      },
    })
    run.currentChild = child

    let stdoutBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      this.touch(run)
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) this.handleCodexExecLine(run, line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      this.touch(run)
      const text = appendChildStderr(run, chunk)
      if (text) logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] codex exec stderr')
    })

    child.on('error', (err) => {
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] codex exec failed to start')
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: childProcessErrorMessage(err) },
            output: [],
          },
        },
      })
    })

    child.on('exit', (code) => {
      if (stdoutBuffer.trim()) this.handleCodexExecLine(run, stdoutBuffer)
      if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
      run.currentChildKillTimer = undefined
      run.currentChild = undefined
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, code }, '[coding-agent-run] codex exec exited')
      if (run.stoppedByUser) return
      if (run.pendingChatCompletionEvent) {
        this.emitAndMarkPrintChatRunCompleted(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)
        return
      }
      if (code === 0) {
        this.completeCodexExecTurn(run, run.codexPendingUsage)
        return
      }
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.failed',
        data: {
          type: 'response.failed',
          response: {
            id: run.printResponseId,
            object: 'response',
            status: 'failed',
            model: run.launch.model,
            error: { message: exitErrorMessage('Codex', code, run.currentChildStderr) },
            output: [],
          },
        },
      })
    })
  }

  private handleCodexExecLine(run: ManagedCodingAgentRun, line: string) {
    const trimmed = line.trim()
    if (!trimmed) return
    let event: any
    try {
      event = JSON.parse(trimmed)
    } catch {
      logger.debug({ runId: run.id, line: sanitizeCodingAgentTerminalOutput(trimmed) }, '[coding-agent-run] ignored non-json Codex exec line')
      return
    }

    this.recordCodexNativeSessionId(run, this.codexNativeSessionIdFrom(event))

    const method = String(event.method || '').trim()
    if (method) {
      this.handleCodexProtocolEvent(run, method, event.params || {})
      return
    }

    const msg = event.msg || event.message
    if (msg && (typeof msg.content === 'string' || typeof msg.text === 'string')) {
      this.appendCodexFinalText(run, String(msg.content || msg.text || ''))
      return
    }

    const type = String(event.type || '').trim()
    if (type === 'thread.started') {
      this.recordCodexNativeSessionId(run, String(event.thread_id || event.threadId || '').trim())
      return
    }
    if (type === 'task_started') {
      run.codexContextLimit = finiteUsageNumber(event.model_context_window, event.modelContextWindow) ?? run.codexContextLimit
      return
    }
    if (type === 'item.started') {
      this.handleCodexItemStarted(run, event.item || event)
      return
    }
    if (type === 'item.completed') {
      this.handleCodexItemCompleted(run, event.item || event)
      return
    }
    if (type === 'response_item') {
      this.handleCodexResponseItem(run, event.payload || event.item || event)
      return
    }
    if (type === 'event_msg') {
      this.handleCodexEventMessage(run, event.payload || event.msg || event)
      return
    }
    if (type === 'token_count') {
      this.handleCodexTokenCount(run, event)
      return
    }
    if (type === 'turn.completed') {
      run.codexPendingUsage = preferCodexUsage(run.codexPendingUsage, this.enrichCodexUsageFromSessionLog(run, event.usage))
      return
    }
    if (type === 'turn.failed' || type === 'error') {
      this.failCodexExecTurn(run, event.error?.message || event.message || 'Codex run failed')
    }
  }

  private handleCodexProtocolEvent(run: ManagedCodingAgentRun, method: string, params: any) {
    this.recordCodexNativeSessionId(run, this.codexNativeSessionIdFrom(params))
    if (method === 'thread/started') {
      this.recordCodexNativeSessionId(run, String(params.thread_id || params.threadId || '').trim())
      return
    }
    if (method === 'task_started' || method === 'task/started') {
      run.codexContextLimit = finiteUsageNumber(params.model_context_window, params.modelContextWindow) ?? run.codexContextLimit
      return
    }
    if (method === 'event_msg' || method === 'event/msg') {
      this.handleCodexEventMessage(run, params.payload || params.msg || params)
      return
    }
    if (method === 'item/agentMessage/delta' || method === 'item/assistantMessage/delta') {
      this.appendCodexText(run, String(params.delta || params.text || ''))
      return
    }
    if (
      method === 'item/reasoning/delta' ||
      method === 'item/reasoningText/delta' ||
      method === 'item/reasoningSummary/delta' ||
      method === 'item/thinking/delta'
    ) {
      this.appendCodexReasoning(run, this.codexReasoningText(params))
      return
    }
    if (method === 'item/started') {
      this.handleCodexItemStarted(run, params.item || params)
      return
    }
    if (method === 'item/completed') {
      this.handleCodexItemCompleted(run, params.item || params)
      return
    }
    if (method === 'turn/completed') {
      run.codexPendingUsage = preferCodexUsage(run.codexPendingUsage, this.enrichCodexUsageFromSessionLog(run, params.usage))
      return
    }
    if (method === 'turn/failed' || method === 'error') {
      this.failCodexExecTurn(run, params.error?.message || params.message || 'Codex run failed')
    }
  }

  private handleCodexEventMessage(run: ManagedCodingAgentRun, event: any) {
    const type = String(event?.type || '').trim()
    if (type === 'task_started') {
      run.codexContextLimit = finiteUsageNumber(event.model_context_window, event.modelContextWindow) ?? run.codexContextLimit
      return
    }
    if (type === 'token_count') {
      this.handleCodexTokenCount(run, event)
    }
  }

  private handleCodexTokenCount(run: ManagedCodingAgentRun, usage: any) {
    const enrichedUsage = this.enrichCodexUsageFromSessionLog(run, usage)
    run.codexPendingUsage = preferCodexUsage(run.codexPendingUsage, enrichedUsage)
    const normalizedUsage = applyRunContextLimit(normalizeCodingAgentUsage(run.codexPendingUsage), run)
    if (!normalizedUsage) return
    run.state.inputTokens = normalizedUsage.inputTokens
    run.state.outputTokens = normalizedUsage.outputTokens
    if (normalizedUsage.contextTokens != null) run.state.contextTokens = normalizedUsage.contextTokens
    if (normalizedUsage.contextLimit != null) run.state.contextLimit = normalizedUsage.contextLimit
    this.persistCodingAgentTokenUsage(run, run.codexPendingUsage)
    this.emitToChat(run.launch.sessionId, 'usage.updated', {
      event: 'usage.updated',
      session_id: run.launch.sessionId,
      inputTokens: normalizedUsage.inputTokens,
      outputTokens: normalizedUsage.outputTokens,
      contextTokens: normalizedUsage.contextTokens,
      contextLimit: normalizedUsage.contextLimit,
    })
  }

  private failCodexExecTurn(run: ManagedCodingAgentRun, message: string) {
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.failed',
      data: {
        type: 'response.failed',
        response: {
          id: run.printResponseId,
          object: 'response',
          status: 'failed',
          model: run.launch.model,
          error: { message },
          output: [],
        },
      },
    })
  }

  private handleCodexItemStarted(run: ManagedCodingAgentRun, item: any) {
    const itemType = this.codexItemType(item)
    if (!this.isCodexToolItem(itemType)) return
    if (this.isRedundantCodexExecToolItem(item, itemType)) return
    const toolBlock = this.codexToolBlock(item, itemType)
    run.codexToolBlocks?.set(toolBlock.id, toolBlock)
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: run.codexToolBlocks?.size || 0,
        item: {
          type: 'function_call',
          id: toolBlock.id,
          call_id: toolBlock.id,
          name: toolBlock.name,
          arguments: toolBlock.arguments,
        },
      },
    })
  }

  private handleCodexItemCompleted(run: ManagedCodingAgentRun, item: any) {
    const itemType = this.codexItemType(item)
    if (this.isCodexReasoningItem(itemType)) {
      this.appendCodexReasoning(run, this.codexReasoningText(item))
      return
    }
    if (
      itemType === 'agent_message' ||
      itemType === 'assistant_message' ||
      itemType === 'agentMessage' ||
      itemType === 'assistantMessage'
    ) {
      this.appendCodexFinalText(run, String(item.text || item.message || item.content || ''))
      return
    }
    if (!this.isCodexToolItem(itemType)) return
    if (this.isRedundantCodexExecToolItem(item, itemType)) return
    let toolBlock = run.codexToolBlocks?.get(String(item.id || item.call_id || item.callId || itemType))
    if (!toolBlock) {
      toolBlock = this.codexToolBlock(item, itemType)
      run.codexToolBlocks?.set(toolBlock.id, toolBlock)
      this.handleClaudePrintResponseEvent(run, {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: run.codexToolBlocks?.size || 0,
          item: {
            type: 'function_call',
            id: toolBlock.id,
            call_id: toolBlock.id,
            name: toolBlock.name,
            arguments: toolBlock.arguments,
          },
        },
      })
    }
    if (toolBlock.done) return
    toolBlock.done = true
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: run.codexToolBlocks?.size || 0,
        item: {
          type: 'function_call',
          id: toolBlock.id,
          call_id: toolBlock.id,
          name: toolBlock.name,
          arguments: toolBlock.arguments,
        },
      },
    })
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: run.codexToolBlocks?.size || 0,
        item: {
          type: 'function_call_output',
          id: toolBlock.id,
          call_id: toolBlock.id,
          output: this.codexToolOutput(item),
        },
      },
    })
  }

  private handleCodexResponseItem(run: ManagedCodingAgentRun, item: any) {
    const itemType = this.codexItemType(item)
    if (this.isCodexReasoningItem(itemType)) {
      this.appendCodexReasoning(run, this.codexReasoningText(item))
      return
    }
    if (
      itemType === 'agent_message' ||
      itemType === 'assistant_message' ||
      itemType === 'agentMessage' ||
      itemType === 'assistantMessage' ||
      itemType === 'message'
    ) {
      this.appendCodexFinalText(run, String(item.text || item.message || item.content || ''))
    }
  }

  private codexItemType(item: any): string {
    return String(item?.type || item?.item_type || item?.itemType || '').trim()
  }

  private isCodexToolItem(itemType: string): boolean {
    return itemType === 'command_execution' ||
      itemType === 'mcp_tool_call' ||
      itemType === 'web_search' ||
      itemType === 'file_change'
  }

  private isCodexReasoningItem(itemType: string): boolean {
    return itemType === 'reasoning' ||
      itemType === 'reasoning_text' ||
      itemType === 'reasoning_summary' ||
      itemType === 'thinking'
  }

  private codexReasoningText(item: any): string {
    if (typeof item?.delta === 'string') return item.delta
    if (typeof item?.text === 'string') return item.text
    if (typeof item?.summary === 'string') return item.summary
    if (typeof item?.reasoning === 'string') return item.reasoning
    if (Array.isArray(item?.summary)) {
      return item.summary
        .map((part: any) => typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : '')
        .filter(Boolean)
        .join('')
    }
    return ''
  }

  private isRedundantCodexExecToolItem(item: any, itemType: string): boolean {
    if (itemType !== 'mcp_tool_call') return false
    const name = String(item.tool || item.name || item.function?.name || '').trim()
    return name === 'exec_command' || name === 'functions.exec_command'
  }

  private codexToolBlock(item: any, itemType: string): { id: string; name: string; arguments: string; done: boolean } {
    const id = String(item.id || item.call_id || item.callId || `codex_${itemType}_${Date.now()}`)
    const name = itemType === 'command_execution'
      ? 'Command'
      : itemType === 'mcp_tool_call'
        ? String(item.tool || item.name || 'MCP Tool')
        : itemType === 'web_search'
          ? 'Web Search'
          : 'File Change'
    const args = itemType === 'command_execution'
      ? { command: item.command || item.cmd || '' }
      : itemType === 'mcp_tool_call'
        ? { server: item.server, tool: item.tool || item.name, arguments: item.arguments || item.input }
        : itemType === 'web_search'
          ? { query: item.query || item.text || '' }
          : { changes: codexFileChangeEntries(item), summary: codexFileChangeSummary(item) }
    return { id, name, arguments: JSON.stringify(args), done: false }
  }

  private codexToolOutput(item: any): string {
    const value = item.aggregated_output ?? item.output ?? item.result ?? item.error?.message ?? ''
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private appendCodexFinalText(run: ManagedCodingAgentRun, text: string) {
    if (!text) return
    const existing = run.printText || ''
    if (!existing) {
      this.appendCodexText(run, text)
      return
    }
    if (text === existing) return
    if (text.startsWith(existing)) {
      this.appendCodexText(run, text.slice(existing.length))
      return
    }
    const existingTrimmed = existing.trimEnd()
    const textTrimmed = text.trimEnd()
    if (textTrimmed === existingTrimmed || existingTrimmed.endsWith(textTrimmed)) return
    if (textTrimmed.startsWith(existingTrimmed)) {
      this.appendCodexText(run, text.slice(existingTrimmed.length))
      return
    }
    if (this.codexLastRunMessageIsToolBoundary(run)) {
      this.appendCodexText(run, text)
    }
  }

  private codexLastRunMessageIsToolBoundary(run: ManagedCodingAgentRun): boolean {
    const marker = run.runMarker
    if (!marker) return false
    for (let index = run.state.messages.length - 1; index >= 0; index--) {
      const message = run.state.messages[index]
      if (message.runMarker !== marker) continue
      return message.role === 'tool' || Boolean(message.tool_calls?.length)
    }
    return false
  }

  private appendCodexText(run: ManagedCodingAgentRun, text: string) {
    if (!text) return
    const existing = run.printText || ''
    const delta = text.length >= 16 ? appendedTextDelta(existing, text) : text
    if (!delta) return
    this.ensureClaudePrintText(run)
    run.printText = `${existing}${delta}`
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        item_id: run.printMessageId,
        output_index: 0,
        content_index: 0,
        delta,
      },
    })
  }

  private appendCodexReasoning(run: ManagedCodingAgentRun, text: string) {
    if (!text) return
    this.handleClaudePrintResponseEvent(run, {
      type: 'response.reasoning.delta',
      data: {
        type: 'response.reasoning.delta',
        item_id: run.printMessageId,
        output_index: 0,
        delta: text,
      },
    })
  }

  private startCodingAgentSteerTurn(run: ManagedCodingAgentRun, steerText: string) {
    run.state.isWorking = true
    run.state.profile = run.launch.profile
    run.state.source = run.launch.sessionSource === 'workflow' ? 'workflow' : 'coding_agent'
    run.state.runId = run.id
    if (run.launch.agentId === 'claude-code') {
      this.startClaudePrintTurn(run, steerText)
      return
    }
    if (run.launch.agentId === 'codex') {
      this.startCodexExecTurn(run, steerText)
      return
    }
    if (!run.pty) throw new Error('Coding agent terminal is not available')
    run.pty.write(`${steerText}\r`)
  }

  private completeCodexExecTurn(run: ManagedCodingAgentRun, usage?: any) {
    this.completeClaudePrintTurn(run, this.enrichCodexUsageFromSessionLog(run, usage))
  }

  private emitAndMarkPrintChatRunCompleted(run: ManagedCodingAgentRun, event: 'run.completed' | 'run.failed', payload?: Record<string, unknown>) {
    run.pendingChatCompletionEvent = undefined
    run.pendingChatCompletionPayload = undefined
    const pendingSteer = event === 'run.completed' ? run.pendingSteer : undefined
    run.pendingSteer = undefined
    const queueRemaining = run.state.queue.length
    const workspaceRunChange = this.completeWorkspaceRunDiff(run)
    this.emitToChat(run.launch.sessionId, event, {
      ...(payload || { event }),
      ...(queueRemaining > 0 ? { queue_remaining: queueRemaining } : {}),
      workspace_run_change: workspaceRunChange,
    })
    if (pendingSteer) {
      run.state.isWorking = true
      run.state.runId = run.id
      run.state.profile = run.launch.profile
      run.state.source = run.launch.sessionSource === 'workflow' ? 'workflow' : 'coding_agent'
      run.runMarker = undefined
      setImmediate(() => {
        try {
          this.startCodingAgentSteerTurn(run, pendingSteer)
        } catch (err) {
          logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to start pending steer turn')
          this.emitToChat(run.launch.sessionId, 'run.failed', {
            event: 'run.failed',
            error: err instanceof Error ? err.message : String(err),
          })
          this.markChatRunCompleted(run.launch.sessionId, 'run.failed')
        }
      })
      return
    }
    run.state.isWorking = false
    run.state.runId = undefined
    run.state.abortController = undefined
    run.state.activeRunMarker = undefined
    run.state.events = []
    this.markChatRunCompleted(run.launch.sessionId, event)
    run.runMarker = undefined
  }

  private codexNativeSessionIdFrom(value: any): string {
    if (!value || typeof value !== 'object') return ''
    const direct = value.thread_id || value.threadId || value.session_id || value.sessionId || value.conversation_id || value.conversationId
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const nested = value.thread || value.session || value.conversation || value.params || value.msg || value.message
    if (nested && nested !== value) return this.codexNativeSessionIdFrom(nested)
    return ''
  }

  private recordCodexNativeSessionId(run: ManagedCodingAgentRun, nativeSessionId: string) {
    if (!nativeSessionId) return
    if (run.launch.agentNativeSessionId === nativeSessionId && run.nativeResumeReady) return
    run.launch.agentNativeSessionId = nativeSessionId
    run.nativeResumeReady = true
    try {
      updateSession(run.launch.sessionId, { agent_native_session_id: nativeSessionId })
      logger.info({ runId: run.id, sessionId: run.launch.sessionId, nativeSessionId }, '[coding-agent-run] recorded Codex native session id')
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to persist Codex native session id')
    }
  }

  private startWorkspaceRunDiff(run: ManagedCodingAgentRun) {
    try {
      startWorkspaceRunCheckpoint({
        sessionId: run.launch.sessionId,
        runId: run.id,
        workspace: run.launch.workspaceDir,
      })
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[workspace-diff] failed to start coding agent run checkpoint')
    }
  }

  private completeWorkspaceRunDiff(run: ManagedCodingAgentRun) {
    try {
      const change = completeWorkspaceRunCheckpoint({
        sessionId: run.launch.sessionId,
        runId: run.id,
        workspace: run.launch.workspaceDir,
      })
      if (!change) return null
      this.emitToChat(run.launch.sessionId, 'workspace.diff.completed', {
        event: 'workspace.diff.completed',
        run_id: run.id,
        change_id: change.change_id,
        change,
      })
      return change
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[workspace-diff] failed to complete coding agent run checkpoint')
      return null
    }
  }

  private emitToChat(sessionId: string, event: string, payload: any) {
    try {
      // Lazy require avoids coupling the service to bootstrap order.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getChatRunServer } = require('../../routes/hermes/chat-run')
      getChatRunServer()?.emitExternalEvent?.(sessionId, event, payload)
    } catch {}
  }

  private emitTerminalStatus(run: ManagedCodingAgentRun, text: string) {
    logger.debug({ runId: run.id, sessionId: run.launch.sessionId, text }, '[coding-agent-run] status')
  }

  private bufferTerminalOutput(run: ManagedCodingAgentRun, chunk: string) {
    const sanitized = sanitizeCodingAgentTerminalOutput(chunk)
    if (!sanitized.trim()) return
    run.terminalBuffer = `${run.terminalBuffer || ''}${sanitized}`
    if (run.terminalBuffer.length > MAX_TERMINAL_EVENT_CHARS * 2) {
      run.terminalBuffer = run.terminalBuffer.slice(-MAX_TERMINAL_EVENT_CHARS * 2)
    }
    if (run.terminalFlushTimer) return
    run.terminalFlushTimer = setTimeout(() => {
      run.terminalFlushTimer = undefined
      this.flushTerminalOutput(run)
    }, TERMINAL_OUTPUT_FLUSH_MS)
  }

  private maybeAnswerClaudeApiKeyPrompt(run: ManagedCodingAgentRun, chunk: string) {
    if (run.launch.agentId !== 'claude-code' || run.apiKeyPromptAnswered) return
    const text = sanitizeCodingAgentTerminalOutput(`${run.terminalBuffer || ''}${chunk}`).toLowerCase()
    if (!text.includes('detected a custom api key') && !text.includes('detectedacustomapikey')) return
    if (!text.includes('do you want to use this api key') && !text.includes('doyouwanttousethisapikey')) return
    run.apiKeyPromptAnswered = true
    this.emitTerminalStatus(run, 'Confirmed scoped Claude Code API key.')
    try {
      run.pty?.write('1\r')
    } catch (err) {
      logger.warn({ err, runId: run.id, sessionId: run.launch.sessionId }, '[coding-agent-run] failed to confirm Claude Code API key prompt')
    }
  }

  private flushTerminalOutput(run: ManagedCodingAgentRun) {
    run.terminalBuffer = ''
  }

  private markChatRunCompleted(sessionId: string, event: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getChatRunServer } = require('../../routes/hermes/chat-run')
      getChatRunServer()?.markExternalRunCompleted?.(sessionId, event)
    } catch {}
  }
}

export const codingAgentRunManager = new CodingAgentRunManager()
