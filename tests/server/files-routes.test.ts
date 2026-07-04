import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { promisify } from 'util'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

const provider = {
  listDir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  deleteFile: vi.fn(),
  deleteDir: vi.fn(),
  writeFile: vi.fn(),
}
const createFileProviderMock = vi.fn(async () => provider)
const resolveHermesPathMock = vi.fn((relativePath: string) => {
  const normalized = relativePath.replace(/^\/+/, '')
  return normalized ? `/home/agent/.hermes/${normalized}` : '/home/agent/.hermes'
})

vi.mock('../../packages/server/src/services/hermes/file-provider', () => ({
  createFileProvider: createFileProviderMock,
  resolveHermesPath: resolveHermesPathMock,
  isSensitivePath: vi.fn(() => false),
  MAX_EDIT_SIZE: 10 * 1024 * 1024,
}))

async function runFileRoute(path: string, ctx: any) {
  const { fileRoutes } = await import('../../packages/server/src/routes/hermes/files')
  const layer = fileRoutes.stack.find((entry: any) => entry.path === path)
  if (!layer) throw new Error(`Missing file route ${path}`)

  let index = -1
  async function dispatch(nextIndex: number): Promise<void> {
    if (nextIndex <= index) throw new Error('next() called multiple times')
    index = nextIndex
    const fn = layer.stack[nextIndex]
    if (!fn) return
    await fn(ctx, () => dispatch(nextIndex + 1))
  }

  await dispatch(0)
}

function superAdminState(profile = 'research') {
  return {
    profile: { name: profile },
    user: { id: 1, username: 'owner', role: 'super_admin' },
  }
}

describe('file routes path metadata', () => {
  beforeEach(() => {
    vi.resetModules()
    createFileProviderMock.mockClear()
    resolveHermesPathMock.mockClear()
    provider.listDir.mockReset()
    provider.stat.mockReset()
    provider.readFile.mockReset()
    provider.deleteFile.mockReset()
    provider.deleteDir.mockReset()
    provider.writeFile.mockReset()
  })

  it('returns absolute paths for listed entries while preserving relative operation paths', async () => {
    provider.listDir.mockResolvedValue([
      { name: 'app.log', path: 'logs/app.log', isDir: false, size: 12, modTime: '2026-05-20T00:00:00.000Z' },
    ])

    const ctx: any = { query: { path: 'logs' }, state: { profile: { name: 'research' } }, body: null }

    await runFileRoute('/api/hermes/files/list', ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('logs', 'research')
    expect(provider.listDir).toHaveBeenCalledWith('/home/agent/.hermes/logs')
    expect(ctx.body).toEqual({
      path: 'logs',
      absolutePath: '/home/agent/.hermes/logs',
      entries: [
        {
          name: 'app.log',
          path: 'logs/app.log',
          absolutePath: '/home/agent/.hermes/logs/app.log',
          isDir: false,
          size: 12,
          modTime: '2026-05-20T00:00:00.000Z',
        },
      ],
    })
  })

  it('allows absolute workspace paths under the configured workspace base', async () => {
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    process.env.WORKSPACE_BASE = '/home/agent'
    provider.listDir.mockResolvedValue([
      { name: 'project', path: '/home/agent/Documents/project', isDir: true, size: 0, modTime: '2026-05-20T00:00:00.000Z' },
    ])

    try {
      const ctx: any = { query: { path: '/home/agent/Documents' }, state: superAdminState(), body: null }
      await runFileRoute('/api/hermes/files/list', ctx)

      expect(provider.listDir).toHaveBeenCalledWith('/home/agent/Documents')
      expect(ctx.body.path).toBe('/home/agent/Documents')
      expect(ctx.body.absolutePath).toBe('/home/agent/Documents')
      expect(ctx.body.entries[0].path).toBe('/home/agent/Documents/project')
    } finally {
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
    }
  })

  it('searches workspace files recursively for @ mentions', async () => {
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    process.env.WORKSPACE_BASE = '/home/agent'
    provider.listDir.mockImplementation(async (path: string) => {
      if (path === '/home/agent/repo') {
        return [
          { name: 'node_modules', path: '/home/agent/repo/node_modules', isDir: true, size: 0, modTime: '' },
          { name: 'src', path: '/home/agent/repo/src', isDir: true, size: 0, modTime: '' },
        ]
      }
      if (path === '/home/agent/repo/src') {
        return [
          { name: 'app.ts', path: '/home/agent/repo/src/app.ts', isDir: false, size: 18, modTime: '' },
        ]
      }
      return []
    })

    try {
      const ctx: any = { query: { path: '/home/agent/repo', q: 'app', limit: '8' }, state: superAdminState(), body: null }
      await runFileRoute('/api/hermes/files/search', ctx)

      expect(provider.listDir).toHaveBeenCalledWith('/home/agent/repo')
      expect(provider.listDir).toHaveBeenCalledWith('/home/agent/repo/src')
      expect(provider.listDir).not.toHaveBeenCalledWith('/home/agent/repo/node_modules')
      expect(ctx.body.entries).toEqual([
        {
          name: 'app.ts',
          path: '/home/agent/repo/src/app.ts',
          absolutePath: '/home/agent/repo/src/app.ts',
          isDir: false,
          size: 18,
          modTime: '',
        },
      ])
    } finally {
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
    }
  })

  it('returns an absolute path in stat responses', async () => {
    provider.stat.mockResolvedValue({
      name: 'app.log',
      path: 'logs/app.log',
      isDir: false,
      size: 12,
      modTime: '2026-05-20T00:00:00.000Z',
    })

    const ctx: any = { query: { path: 'logs/app.log' }, state: { profile: { name: 'research' } }, body: null }

    await runFileRoute('/api/hermes/files/stat', ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('logs/app.log', 'research')
    expect(ctx.body).toEqual({
      name: 'app.log',
      path: 'logs/app.log',
      absolutePath: '/home/agent/.hermes/logs/app.log',
      isDir: false,
      size: 12,
      modTime: '2026-05-20T00:00:00.000Z',
    })
  })

  it('deletes files from the parsed request body', async () => {
    provider.deleteFile.mockResolvedValue(undefined)

    const ctx: any = {
      request: { body: { path: 'workspace/weather.txt', recursive: false } },
      state: superAdminState(),
      body: null,
    }

    await runFileRoute('/api/hermes/files/delete', ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('workspace/weather.txt', 'research')
    expect(provider.deleteFile).toHaveBeenCalledWith('/home/agent/.hermes/workspace/weather.txt')
    expect(provider.deleteDir).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('returns missing_path instead of throwing when delete body is absent', async () => {
    const ctx: any = {
      request: { body: undefined },
      state: superAdminState(),
      body: null,
    }

    await runFileRoute('/api/hermes/files/delete', ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing path parameter', code: 'missing_path' })
    expect(createFileProviderMock).not.toHaveBeenCalled()
    expect(provider.deleteFile).not.toHaveBeenCalled()
    expect(provider.deleteDir).not.toHaveBeenCalled()
  })

  it('uploads files with boundary parameters and RFC 5987 filenames', async () => {
    provider.writeFile.mockResolvedValue(undefined)
    const boundary = 'files-boundary'
    const body = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename*=UTF-8\'\'daily%20report.txt',
      'Content-Type: text/plain',
      '',
      'hello',
      `--${boundary}--`,
      '',
    ].join('\r\n'))

    const ctx: any = {
      query: { path: 'workspace' },
      req: Readable.from([body]),
      request: {},
      state: superAdminState(),
      body: null,
      status: 200,
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}; charset=utf-8`
        : ''),
    }

    await runFileRoute('/api/hermes/files/upload', ctx)

    expect(createFileProviderMock).toHaveBeenCalledWith('research')
    expect(resolveHermesPathMock).toHaveBeenCalledWith('workspace/daily report.txt', 'research')
    expect(provider.writeFile).toHaveBeenCalledWith(
      '/home/agent/.hermes/workspace/daily report.txt',
      Buffer.from('hello'),
    )
    expect(ctx.body).toEqual({
      files: [{ name: 'daily report.txt', path: 'workspace/daily report.txt' }],
    })
  })

  it('returns invalid_request for malformed RFC 5987 filenames', async () => {
    const boundary = 'files-boundary'
    const body = Buffer.from([
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename*=UTF-8\'\'bad%ZZname.txt',
      'Content-Type: text/plain',
      '',
      'hello',
      `--${boundary}--`,
      '',
    ].join('\r\n'))

    const ctx: any = {
      query: { path: 'workspace' },
      req: Readable.from([body]),
      request: {},
      state: superAdminState(),
      body: null,
      status: 200,
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}`
        : ''),
    }

    await runFileRoute('/api/hermes/files/upload', ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename', code: 'invalid_request' })
    expect(provider.writeFile).not.toHaveBeenCalled()
  })

  it('requires a super administrator for file editor content and mutations', async () => {
    const readCtx: any = {
      query: { path: 'workspace/weather.txt' },
      state: {
        profile: { name: 'research' },
        user: { id: 2, username: 'admin', role: 'admin' },
      },
      body: null,
    }

    await runFileRoute('/api/hermes/files/read', readCtx)

    expect(readCtx.status).toBe(403)
    expect(readCtx.body).toEqual({ error: 'Super administrator privileges are required' })
    expect(provider.readFile).not.toHaveBeenCalled()

    const writeCtx: any = {
      request: { body: { path: 'workspace/weather.txt', content: 'rain' } },
      state: {
        profile: { name: 'research' },
        user: { id: 2, username: 'admin', role: 'admin' },
      },
      body: null,
    }

    await runFileRoute('/api/hermes/files/write', writeCtx)

    expect(writeCtx.status).toBe(403)
    expect(writeCtx.body).toEqual({ error: 'Super administrator privileges are required' })
    expect(provider.writeFile).not.toHaveBeenCalled()
  })

  it('keeps full git diff file stats when loading a selected file diff', async () => {
    const originalWorkspaceBase = process.env.WORKSPACE_BASE
    const tempRoot = await mkdtemp(join(tmpdir(), 'hermes-git-diff-'))
    const repo = join(tempRoot, 'repo')
    process.env.WORKSPACE_BASE = tempRoot

    try {
      await execFileAsync('git', ['init', repo])
      await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'hermes@example.com'])
      await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Hermes Test'])
      await writeFile(join(repo, 'a.txt'), 'a1\n')
      await writeFile(join(repo, 'b.txt'), 'b1\n')
      await execFileAsync('git', ['-C', repo, 'add', '.'])
      await execFileAsync('git', ['-C', repo, 'commit', '-m', 'initial'])
      await writeFile(join(repo, 'a.txt'), 'a1\na2\n')
      await writeFile(join(repo, 'b.txt'), 'b1\nb2\n')

      const ctx: any = {
        query: { workspace: repo, path: 'a.txt' },
        state: superAdminState(),
        body: null,
      }

      await runFileRoute('/api/hermes/files/git-diff', ctx)

      expect(ctx.body.selectedPath).toBe('a.txt')
      expect(ctx.body.diff).toContain('diff --git a/a.txt b/a.txt')
      expect(ctx.body.diff).not.toContain('diff --git a/b.txt b/b.txt')
      expect(ctx.body.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'a.txt', additions: 1, deletions: 0 }),
        expect.objectContaining({ path: 'b.txt', additions: 1, deletions: 0 }),
      ]))
      const totals = ctx.body.files.reduce((acc: { additions: number; deletions: number }, file: any) => ({
        additions: acc.additions + (file.additions || 0),
        deletions: acc.deletions + (file.deletions || 0),
      }), { additions: 0, deletions: 0 })
      expect(totals).toEqual({ additions: 2, deletions: 0 })
    } finally {
      if (originalWorkspaceBase === undefined) delete process.env.WORKSPACE_BASE
      else process.env.WORKSPACE_BASE = originalWorkspaceBase
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

})
