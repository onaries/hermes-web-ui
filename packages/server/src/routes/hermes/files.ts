import Router from '@koa/router'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { resolve, normalize, isAbsolute, relative, sep } from 'path'
import { promisify } from 'util'
import { isPathWithin } from '../../services/hermes/hermes-path'
import {
  createFileProvider,
  resolveHermesPath,
  isSensitivePath,
  MAX_EDIT_SIZE,
} from '../../services/hermes/file-provider'
import { requireSuperAdmin } from '../../middleware/user-auth'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../../lib/multipart'

function requestedProfile(ctx: any): string | undefined {
  return ctx.state?.profile?.name
}

function workspaceBase(): string {
  return resolve(process.env.WORKSPACE_BASE || process.env.HOME || homedir())
}

function resolveRequestPath(ctx: any, relativePath: string): string {
  if (relativePath && isAbsolute(relativePath)) {
    const absPath = normalize(resolve(relativePath))
    const base = workspaceBase()
    if (!isPathWithin(absPath, base)) {
      throw Object.assign(new Error(`Workspace path is outside WORKSPACE_BASE (${base})`), { code: 'invalid_path' })
    }
    return absPath
  }
  return resolveHermesPath(relativePath, requestedProfile(ctx))
}

async function createRequestFileProvider(ctx: any) {
  return createFileProvider(requestedProfile(ctx))
}

function withAbsolutePath<T extends { path: string }>(ctx: any, entry: T): T & { absolutePath: string } {
  return { ...entry, absolutePath: resolveRequestPath(ctx, entry.path) }
}

export const fileRoutes = new Router()

const execFileAsync = promisify(execFile)
const MAX_GIT_DIFF_BYTES = 512 * 1024
const MAX_SYNTHETIC_UNTRACKED_BYTES = 96 * 1024
const MAX_UNTRACKED_FILES = 25
const MAX_FILE_SEARCH_SCAN = 2000
const MAX_FILE_SEARCH_RESULTS = 50
const FILE_SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage'])

interface GitStatusEntry {
  path: string
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown'
  staged: boolean
  unstaged: boolean
  additions?: number
  deletions?: number
}

function ensureRepoRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw Object.assign(new Error('Invalid git path'), { code: 'invalid_path' })
  }
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some(part => part === '..')) {
    throw Object.assign(new Error('Invalid git path'), { code: 'invalid_path' })
  }
  return parts.join('/')
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function mapGitStatus(code: string): GitStatusEntry['status'] {
  if (code === '??') return 'untracked'
  const marker = code.includes('R') ? 'R' : code.includes('C') ? 'C' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : code.includes('M') ? 'M' : code.includes('T') ? 'M' : ''
  if (marker === 'R') return 'renamed'
  if (marker === 'C') return 'copied'
  if (marker === 'A') return 'added'
  if (marker === 'D') return 'deleted'
  if (marker === 'M') return 'modified'
  return 'unknown'
}

function parseGitStatusPorcelain(raw: string): GitStatusEntry[] {
  const parts = raw.split('\0').filter(Boolean)
  const entries: GitStatusEntry[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i]
    const code = record.slice(0, 2)
    let path = normalizeGitPath(record.slice(3))
    let oldPath: string | undefined
    if ((code.includes('R') || code.includes('C')) && i + 1 < parts.length) {
      oldPath = path
      i += 1
      path = normalizeGitPath(parts[i])
    }
    entries.push({
      path,
      oldPath,
      status: mapGitStatus(code),
      staged: code[0] !== ' ' && code[0] !== '?',
      unstaged: code[1] !== ' ' || code === '??',
    })
  }
  return entries
}

function parseGitNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = Number(parts[0])
    const deletions = Number(parts[1])
    const path = normalizeGitPath(parts.at(-1) || '')
    if (!path) continue
    stats.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  return stats
}

async function runGit(cwd: string, args: string[], maxBuffer = MAX_GIT_DIFF_BYTES): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer,
    timeout: 10000,
  })
  return stdout as string
}

async function tryRunGit(cwd: string, args: string[], maxBuffer = MAX_GIT_DIFF_BYTES): Promise<string> {
  try {
    return await runGit(cwd, args, maxBuffer)
  } catch (error: any) {
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw Object.assign(new Error('Git diff is too large to display'), { code: 'file_too_large' })
    }
    throw error
  }
}

async function resolveGitRoot(workspace: string): Promise<string | null> {
  try {
    return (await runGit(workspace, ['rev-parse', '--show-toplevel'], 64 * 1024)).trim()
  } catch {
    return null
  }
}

async function synthesizeUntrackedDiff(repoRoot: string, entries: GitStatusEntry[], selectedPath?: string): Promise<string> {
  const candidates = entries
    .filter(entry => entry.status === 'untracked')
    .filter(entry => !selectedPath || entry.path === selectedPath)
    .slice(0, MAX_UNTRACKED_FILES)
  const chunks: string[] = []
  for (const entry of candidates) {
    const absPath = resolve(repoRoot, entry.path)
    const rel = relative(repoRoot, absPath)
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..') || !existsSync(absPath)) continue
    let data: Buffer
    try {
      data = await readFile(absPath)
    } catch {
      continue
    }
    if (data.includes(0)) {
      chunks.push(`diff --git a/${entry.path} b/${entry.path}\nnew file mode 100644\nBinary files /dev/null and b/${entry.path} differ\n`)
      continue
    }
    const content = data.toString('utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_SYNTHETIC_UNTRACKED_BYTES) {
      chunks.push(`diff --git a/${entry.path} b/${entry.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${entry.path}\n@@ -0,0 +1 @@\n+[diff omitted: file too large]\n`)
      continue
    }
    const lines = content.split(/\r?\n/)
    if (lines.at(-1) === '') lines.pop()
    chunks.push([
      `diff --git a/${entry.path} b/${entry.path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${entry.path}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...(lines.length ? lines.map(line => `+${line}`) : ['+']),
      '\\ No newline at end of file',
    ].join('\n'))
  }
  return chunks.join('\n')
}

function handleError(ctx: any, err: any) {
  const code = err.code || 'unknown'
  const statusMap: Record<string, number> = {
    missing_path: 400,
    invalid_path: 400,
    not_found: 404,
    ENOENT: 404,
    already_exists: 409,
    permission_denied: 403,
    file_too_large: 413,
    not_a_directory: 400,
    not_a_file: 400,
    unsupported_backend: 501,
    backend_error: 502,
    backend_timeout: 504,
  }
  ctx.status = statusMap[code] || 500
  ctx.body = { error: err.message, code }
}

// GET /api/hermes/files/list?path=
fileRoutes.get('/api/hermes/files/list', async (ctx) => {
  const relativePath = (ctx.query.path as string) || ''
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const entries = await provider.listDir(absPath)
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const responseEntries = entries.map(entry => {
      const path = relativePath && isAbsolute(relativePath)
        ? `${absPath.replace(/\/$/, '')}/${entry.name}`
        : entry.path
      return withAbsolutePath(ctx, { ...entry, path })
    })
    ctx.body = { entries: responseEntries, path: relativePath, absolutePath: absPath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/search?path=&q=
fileRoutes.get('/api/hermes/files/search', async (ctx) => {
  const rootPath = (ctx.query.path as string) || ''
  const query = String(ctx.query.q || '').trim().toLowerCase()
  const limitValue = Number(ctx.query.limit || MAX_FILE_SEARCH_RESULTS)
  const limit = Math.min(Math.max(Number.isFinite(limitValue) ? limitValue : MAX_FILE_SEARCH_RESULTS, 1), MAX_FILE_SEARCH_RESULTS)
  try {
    const provider = await createRequestFileProvider(ctx)
    const rootAbsPath = resolveRequestPath(ctx, rootPath)
    const absoluteRoot = Boolean(rootPath && isAbsolute(rootPath))
    const results: any[] = []
    const queue: Array<{ absPath: string; depth: number }> = [{ absPath: rootAbsPath, depth: 0 }]
    let scanned = 0

    // ponytail: bounded BFS for @file search; use fd/ripgrep indexing if huge repos outgrow this.
    while (queue.length && scanned < MAX_FILE_SEARCH_SCAN && results.length < limit) {
      const current = queue.shift()!
      let entries = [] as Awaited<ReturnType<typeof provider.listDir>>
      try {
        entries = await provider.listDir(current.absPath)
      } catch {
        continue
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      for (const entry of entries) {
        const path = absoluteRoot ? resolve(current.absPath, entry.name) : entry.path
        if (entry.isDir) {
          if (current.depth < 8 && !FILE_SEARCH_SKIP_DIRS.has(entry.name)) {
            queue.push({ absPath: resolveRequestPath(ctx, path), depth: current.depth + 1 })
          }
          continue
        }
        scanned += 1
        const haystack = `${entry.name} ${path}`.toLowerCase()
        if (!query || haystack.includes(query)) {
          results.push(withAbsolutePath(ctx, { ...entry, path, isDir: false }))
          if (results.length >= limit) break
        }
        if (scanned >= MAX_FILE_SEARCH_SCAN) break
      }
    }
    ctx.body = { entries: results, path: rootPath, absolutePath: rootAbsPath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/stat?path=
fileRoutes.get('/api/hermes/files/stat', async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const info = await provider.stat(absPath)
    ctx.body = withAbsolutePath(ctx, info)
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/git-diff?workspace=&path=
fileRoutes.get('/api/hermes/files/git-diff', requireSuperAdmin, async (ctx) => {
  const workspace = ctx.query.workspace as string
  if (!workspace) {
    ctx.status = 400
    ctx.body = { error: 'Missing workspace parameter', code: 'missing_path' }
    return
  }

  try {
    const selectedPath = ctx.query.path ? ensureRepoRelativePath(ctx.query.path as string) : undefined
    const absWorkspace = resolveRequestPath(ctx, workspace)
    const repoRoot = await resolveGitRoot(absWorkspace)
    if (!repoRoot) {
      ctx.body = { isRepo: false, workspace: absWorkspace, files: [], diff: '' }
      return
    }

    const [branch, upstream, statusRaw, fullNumstatRaw, trackedDiff] = await Promise.all([
      runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], 64 * 1024).then(value => value.trim()).catch(() => ''),
      runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 64 * 1024).then(value => value.trim()).catch(() => ''),
      tryRunGit(repoRoot, ['status', '--porcelain=v1', '-z'], MAX_GIT_DIFF_BYTES),
      tryRunGit(repoRoot, ['diff', '--numstat', 'HEAD'], MAX_GIT_DIFF_BYTES).catch(() => ''),
      tryRunGit(repoRoot, ['diff', '--no-color', '--no-ext-diff', '--unified=80', 'HEAD', '--', ...(selectedPath ? [selectedPath] : [])], MAX_GIT_DIFF_BYTES).catch((error) => {
        if (error?.code === 'file_too_large') throw error
        return ''
      }),
    ])

    const files = parseGitStatusPorcelain(statusRaw)
    const statMap = parseGitNumstat(fullNumstatRaw)
    for (const file of files) {
      const stats = statMap.get(file.path)
      if (stats) {
        file.additions = stats.additions
        file.deletions = stats.deletions
      } else if (file.status === 'untracked') {
        file.additions = file.additions ?? 0
        file.deletions = file.deletions ?? 0
      }
    }
    const syntheticUntrackedDiff = await synthesizeUntrackedDiff(repoRoot, files, selectedPath)
    const diff = [trackedDiff.trimEnd(), syntheticUntrackedDiff.trimEnd()].filter(Boolean).join('\n')

    ctx.body = {
      isRepo: true,
      workspace: absWorkspace,
      root: repoRoot,
      branch,
      upstream,
      selectedPath,
      files,
      diff,
      truncated: false,
    }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// GET /api/hermes/files/read?path=
fileRoutes.get('/api/hermes/files/read', requireSuperAdmin, async (ctx) => {
  const relativePath = ctx.query.path as string
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    const data = await provider.readFile(absPath)
    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'File too large to edit', code: 'file_too_large' }
      return
    }
    ctx.body = { content: data.toString('utf-8'), path: relativePath, size: data.length }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// PUT /api/hermes/files/write  body: { path, content }
fileRoutes.put('/api/hermes/files/write', requireSuperAdmin, async (ctx) => {
  const { path: relativePath, content } = ctx.request.body as { path?: string; content?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot modify sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const buf = Buffer.from(content || '', 'utf-8')
    if (buf.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: 'Content too large', code: 'file_too_large' }
      return
    }
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    await provider.writeFile(absPath, buf)
    ctx.body = { ok: true, path: relativePath }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// DELETE /api/hermes/files/delete  body: { path, recursive? }
fileRoutes.delete('/api/hermes/files/delete', requireSuperAdmin, async (ctx) => {
  const { path: relativePath, recursive } = (ctx.request.body || {}) as { path?: string; recursive?: boolean }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  if (isSensitivePath(relativePath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot delete sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    if (recursive) {
      await provider.deleteDir(absPath)
    } else {
      await provider.deleteFile(absPath)
    }
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/rename  body: { oldPath, newPath }
fileRoutes.post('/api/hermes/files/rename', requireSuperAdmin, async (ctx) => {
  const { oldPath, newPath } = ctx.request.body as { oldPath?: string; newPath?: string }
  if (!oldPath || !newPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing oldPath or newPath', code: 'missing_path' }
    return
  }
  if (isSensitivePath(oldPath)) {
    ctx.status = 403
    ctx.body = { error: 'Cannot rename sensitive file', code: 'permission_denied' }
    return
  }
  try {
    const absOld = resolveRequestPath(ctx, oldPath)
    const absNew = resolveRequestPath(ctx, newPath)
    const provider = await createRequestFileProvider(ctx)
    await provider.renameFile(absOld, absNew)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/mkdir  body: { path }
fileRoutes.post('/api/hermes/files/mkdir', requireSuperAdmin, async (ctx) => {
  const { path: relativePath } = ctx.request.body as { path?: string }
  if (!relativePath) {
    ctx.status = 400
    ctx.body = { error: 'Missing path parameter', code: 'missing_path' }
    return
  }
  try {
    const absPath = resolveRequestPath(ctx, relativePath)
    const provider = await createRequestFileProvider(ctx)
    await provider.mkDir(absPath)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/copy  body: { srcPath, destPath }
fileRoutes.post('/api/hermes/files/copy', requireSuperAdmin, async (ctx) => {
  const { srcPath, destPath } = ctx.request.body as { srcPath?: string; destPath?: string }
  if (!srcPath || !destPath) {
    ctx.status = 400
    ctx.body = { error: 'Missing srcPath or destPath', code: 'missing_path' }
    return
  }
  try {
    const absSrc = resolveRequestPath(ctx, srcPath)
    const absDest = resolveRequestPath(ctx, destPath)
    const provider = await createRequestFileProvider(ctx)
    await provider.copyFile(absSrc, absDest)
    ctx.body = { ok: true }
  } catch (err: any) {
    handleError(ctx, err)
  }
})

// POST /api/hermes/files/upload?path=  (multipart/form-data)
fileRoutes.post('/api/hermes/files/upload', requireSuperAdmin, async (ctx) => {
  const targetDir = (ctx.query.path as string) || ''
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400
    ctx.body = { error: 'Expected multipart/form-data', code: 'invalid_request' }
    return
  }

  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400
    ctx.body = { error: 'Missing boundary', code: 'invalid_request' }
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of ctx.req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)

  const parts = splitMultipart(raw, boundaryBuf)
  const provider = await createRequestFileProvider(ctx)
  const results: { name: string; path: string }[] = []

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400
        ctx.body = { error: error.message, code: 'invalid_request' }
        return
      }
      throw error
    }
    if (!filename) continue

    if (data.length > MAX_EDIT_SIZE) {
      ctx.status = 413
      ctx.body = { error: `File ${filename} too large`, code: 'file_too_large' }
      return
    }

    const filePath = targetDir ? `${targetDir}/${filename}` : filename
    if (isSensitivePath(filePath)) {
      ctx.status = 403
      ctx.body = { error: `Cannot overwrite sensitive file: ${filename}`, code: 'permission_denied' }
      return
    }

    const absPath = resolveRequestPath(ctx, filePath)
    await provider.writeFile(absPath, data)
    results.push({ name: filename, path: filePath })
  }

  ctx.body = { files: results }
})
