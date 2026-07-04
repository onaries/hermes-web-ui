import { request, getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'

export interface FileEntry {
  name: string
  path: string
  absolutePath?: string
  isDir: boolean
  size: number
  modTime: string
}

export interface FileStat {
  name: string
  path: string
  absolutePath?: string
  isDir: boolean
  size: number
  modTime: string
  permissions?: string
}

function normalizeProfile(profile?: string | null): string | null {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || null
}

function appendProfile(params: URLSearchParams, profile?: string | null): void {
  const value = normalizeProfile(profile)
  if (value) params.set('profile', value)
}

export async function listFiles(path: string = '', profile?: string | null): Promise<{ entries: FileEntry[]; path: string; absolutePath?: string }> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  appendProfile(params, profile)
  const query = params.toString()
  return request<{ entries: FileEntry[]; path: string }>(`/api/hermes/files/list${query ? `?${query}` : ''}`)
}

export async function searchFiles(path: string = '', q: string = '', profile?: string | null, limit = 20): Promise<{ entries: FileEntry[]; path: string; absolutePath?: string }> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (path) params.set('path', path)
  if (q) params.set('q', q)
  appendProfile(params, profile)
  return request<{ entries: FileEntry[]; path: string }>(`/api/hermes/files/search?${params.toString()}`)
}

export async function statFile(path: string, profile?: string | null): Promise<FileStat> {
  const params = new URLSearchParams({ path })
  appendProfile(params, profile)
  return request<FileStat>(`/api/hermes/files/stat?${params.toString()}`)
}

export async function readFile(path: string, profile?: string | null): Promise<{ content: string; path: string; size: number }> {
  const params = new URLSearchParams({ path })
  appendProfile(params, profile)
  return request<{ content: string; path: string; size: number }>(`/api/hermes/files/read?${params.toString()}`)
}

export async function writeFile(path: string, content: string, profile?: string | null): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content, profile: normalizeProfile(profile) || undefined }),
  })
}

export async function deleteFile(path: string, recursive: boolean = false, profile?: string | null): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/delete', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive, profile: normalizeProfile(profile) || undefined }),
  })
}

export async function renameFile(oldPath: string, newPath: string, profile?: string | null): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/rename', {
    method: 'POST',
    body: JSON.stringify({ oldPath, newPath, profile: normalizeProfile(profile) || undefined }),
  })
}

export async function mkDir(path: string, profile?: string | null): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/mkdir', {
    method: 'POST',
    body: JSON.stringify({ path, profile: normalizeProfile(profile) || undefined }),
  })
}

export async function copyFile(srcPath: string, destPath: string, profile?: string | null): Promise<void> {
  await request<{ ok: boolean }>('/api/hermes/files/copy', {
    method: 'POST',
    body: JSON.stringify({ srcPath, destPath, profile: normalizeProfile(profile) || undefined }),
  })
}

export async function uploadFiles(targetDir: string, files: File[], profile?: string | null): Promise<{ name: string; path: string }[]> {
  const base = getBaseUrlValue()
  const formData = new FormData()
  for (const file of files) {
    formData.append('file', file)
  }
  const params = new URLSearchParams()
  if (targetDir) params.set('path', targetDir)
  appendProfile(params, profile)
  const query = params.toString()
  const url = `${base}/api/hermes/files/upload${query ? `?${query}` : ''}`

  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const explicitProfile = normalizeProfile(profile)
  const profileName = explicitProfile || getActiveProfileName()
  if (profileName && !explicitProfile) headers['X-Hermes-Profile'] = profileName

  const res = await fetch(url, { method: 'POST', headers, body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Upload failed: ${res.status}`)
  }
  const data = await res.json()
  return data.files
}

export interface GitDiffFile {
  path: string
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown'
  staged: boolean
  unstaged: boolean
  additions?: number
  deletions?: number
}

export interface GitDiffResponse {
  isRepo: boolean
  workspace: string
  root?: string
  branch?: string
  upstream?: string
  selectedPath?: string
  files: GitDiffFile[]
  diff: string
  truncated?: boolean
}

export async function fetchGitDiff(workspace: string, path?: string): Promise<GitDiffResponse> {
  const params = new URLSearchParams({ workspace })
  if (path) params.set('path', path)
  return request<GitDiffResponse>(`/api/hermes/files/git-diff?${params.toString()}`)
}

export async function uploadRuntimeFiles(files: File[]): Promise<{ name: string; path: string }[]> {
  const base = getBaseUrlValue()
  const formData = new FormData()
  for (const file of files) {
    formData.append('file', file)
  }

  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers.Authorization = `Bearer ${token}`
  const profileName = getActiveProfileName()
  if (profileName) headers['X-Hermes-Profile'] = profileName

  const res = await fetch(`${base}/upload`, { method: 'POST', headers, body: formData })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(body.error || `Upload failed: ${res.status}`)
  }
  const data = await res.json()
  return data.files
}

export function getFileDownloadUrl(relativePath: string, fileName?: string, profile?: string | null): string {
  const base = getBaseUrlValue()
  const params = new URLSearchParams({ path: relativePath })
  if (fileName) params.set('name', fileName)
  const explicitProfile = normalizeProfile(profile)
  const profileName = profile === undefined ? getActiveProfileName() : explicitProfile
  if (profileName) params.set('profile', profileName)
  const token = getApiKey()
  if (token) params.set('token', token)
  return `${base}/api/hermes/download?${params.toString()}`
}
