import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { downloadFile, fetchFileText, getDownloadUrl } from '@/api/hermes/download'

export type ArtifactKind = 'markdown' | 'text' | 'image' | 'media' | 'file'
export type ArtifactStatus = 'loading' | 'ready' | 'error'

export interface ArtifactItem {
  id: string
  name: string
  path?: string
  workspace?: string | null
  content?: string
  kind: ArtifactKind
  status: ArtifactStatus
  error?: string
  createdAt: number
  source?: 'manual' | 'chat'
  sourceSessionId?: string
}

export interface ArtifactFileReference {
  path: string
  name?: string
  workspace?: string | null
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])
const TEXT_EXTENSIONS = new Set([
  'txt',
  'json',
  'csv',
  'log',
  'py',
  'yaml',
  'yml',
  'toml',
  'sh',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const MEDIA_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])

function basenameOf(nameOrPath: string): string {
  return nameOrPath.split('?')[0].split('#')[0].split(/[\\/]/).pop() || ''
}

function extensionOf(nameOrPath: string): string {
  const basename = basenameOf(nameOrPath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return ''
  return basename.slice(dotIndex + 1).toLowerCase()
}

function hasMarkdownNameHint(nameOrPath: string): boolean {
  const basename = basenameOf(nameOrPath).toLowerCase()
  return /(^|[\s._-])(md|markdown|mdown|mkd)([\s._-]|$)/.test(basename)
}

function looksLikeMarkdownContent(content: string): boolean {
  const sample = content.slice(0, 16000)
  const signals = [
    /^#{1,6}\s+\S/m,
    /^[-*+]\s+\S/m,
    /^\d+\.\s+\S/m,
    /^>\s+\S/m,
    /^```/m,
    /^\|\s*[^\n]+\s*\|\s*$/m,
    /\[[^\]\n]+\]\([^\)\n]+\)/,
    /`[^`\n]+`/,
  ]
  return signals.some(pattern => pattern.test(sample))
}

function kindForContent(baseKind: ArtifactKind, content: string): ArtifactKind {
  if (baseKind === 'markdown') return 'markdown'
  if ((baseKind === 'file' || baseKind === 'text') && looksLikeMarkdownContent(content)) return 'markdown'
  return baseKind
}

function kindForFetchedContent(item: ArtifactItem, content: string): ArtifactKind {
  return kindForContent(item.kind, content)
}

function inferKind(nameOrPath: string): ArtifactKind {
  const ext = extensionOf(nameOrPath)
  if (MARKDOWN_EXTENSIONS.has(ext) || hasMarkdownNameHint(nameOrPath)) return 'markdown'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (MEDIA_EXTENSIONS.has(ext)) return 'media'
  return 'file'
}

function artifactId(pathOrName: string): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${pathOrName}`
}

function fileArtifactId(path: string, name?: string, workspace?: string | null): string {
  return `file:${workspace || ''}::${path}::${name || ''}`
}

function fileStatusForKind(kind: ArtifactKind): ArtifactStatus {
  return kind === 'image' || kind === 'media' ? 'ready' : 'loading'
}

function isMissingFileError(err: unknown): boolean {
  const record = err as { code?: unknown; status?: unknown; message?: unknown }
  return record?.code === 'not_found'
    || record?.code === 'ENOENT'
    || record?.status === 404
    || (typeof record?.message === 'string' && /\bENOENT\b|no such file or directory|not found/i.test(record.message))
}

export const useArtifactsStore = defineStore('artifacts', () => {
  const artifacts = ref<ArtifactItem[]>([])
  const selectedArtifactId = ref<string | null>(null)
  const openSequence = ref(0)
  const currentChatSessionId = ref<string | null>(null)
  const dismissedChatArtifactIds = new Set<string>()

  const selectedArtifact = computed(() => artifacts.value.find(item => item.id === selectedArtifactId.value) || null)

  function selectArtifact(id: string): void {
    selectedArtifactId.value = id
    openSequence.value += 1
  }

  function upsertArtifact(item: ArtifactItem, options: { select?: boolean; open?: boolean } = {}): void {
    artifacts.value = [item, ...artifacts.value.filter(existing => existing.id !== item.id)].slice(0, 20)
    if (options.select !== false) selectedArtifactId.value = item.id
    if (options.open !== false) openSequence.value += 1
  }

  function updateArtifact(id: string, patch: Partial<ArtifactItem>): ArtifactItem | null {
    let updated: ArtifactItem | null = null
    artifacts.value = artifacts.value.map(item => {
      if (item.id !== id) return item
      updated = { ...item, ...patch }
      return updated
    })
    return updated
  }

  function openContentArtifact(options: { name: string; content: string; kind?: ArtifactKind; path?: string }): ArtifactItem {
    const item: ArtifactItem = {
      id: artifactId(options.path || options.name),
      name: options.name,
      path: options.path,
      content: options.content,
      kind: options.kind || kindForContent(inferKind(options.name), options.content),
      status: 'ready',
      createdAt: Date.now(),
      source: 'manual',
    }
    upsertArtifact(item)
    return item
  }

  function createFileArtifact(options: { path: string; name?: string; workspace?: string | null; source?: 'manual' | 'chat'; sourceSessionId?: string }): ArtifactItem {
    const name = options.name || options.path.split('/').pop() || options.path
    const id = fileArtifactId(options.path, name, options.workspace)
    const existing = artifacts.value.find(item => item.id === id)
    const kind = inferKind(name || options.path)
    return {
      ...existing,
      id,
      name,
      path: options.path,
      workspace: options.workspace ?? existing?.workspace ?? null,
      kind,
      status: existing?.content !== undefined ? 'ready' : existing?.status || fileStatusForKind(kind),
      createdAt: existing?.createdAt || Date.now(),
      source: options.source || existing?.source || 'manual',
      sourceSessionId: options.sourceSessionId ?? existing?.sourceSessionId,
    }
  }

  function registerFileArtifact(options: { path: string; name?: string; workspace?: string | null; sourceSessionId?: string }): ArtifactItem {
    const item = createFileArtifact({ ...options, source: 'chat' })
    dismissedChatArtifactIds.delete(item.id)
    upsertArtifact(item, { select: selectedArtifactId.value === null, open: false })
    return item
  }

  function syncChatFileArtifacts(sessionId: string | null | undefined, files: ArtifactFileReference[]): void {
    currentChatSessionId.value = sessionId || null
    if (!sessionId) {
      artifacts.value = artifacts.value.filter(item => item.source !== 'chat' && !item.sourceSessionId)
      if (selectedArtifactId.value && !artifacts.value.some(item => item.id === selectedArtifactId.value)) {
        selectedArtifactId.value = artifacts.value[0]?.id || null
      }
      return
    }

    const seen = new Set<string>()
    const chatItems = files.flatMap(file => {
      if (!file.path) return []
      const item = createFileArtifact({ ...file, source: 'chat', sourceSessionId: sessionId })
      if (dismissedChatArtifactIds.has(item.id) || seen.has(item.id)) return []
      seen.add(item.id)
      return [item]
    })
    const manualItems = artifacts.value.filter(item =>
      item.source !== 'chat' && (!item.sourceSessionId || item.sourceSessionId === sessionId),
    )
    artifacts.value = [...chatItems, ...manualItems].slice(0, 20)

    if (selectedArtifactId.value && artifacts.value.some(item => item.id === selectedArtifactId.value)) return
    selectedArtifactId.value = artifacts.value[0]?.id || null
  }

  async function ensureArtifactContent(id: string): Promise<ArtifactItem | null> {
    const item = artifacts.value.find(item => item.id === id) || null
    if (!item) return null
    if (item.content !== undefined || item.status === 'error') return item
    if (item.kind === 'image' || item.kind === 'media') return item
    if (!item.path) return item

    updateArtifact(item.id, { status: 'loading' })

    try {
      const content = await fetchFileText(item.path, item.name, undefined, item.workspace)
      return updateArtifact(item.id, { content, kind: kindForFetchedContent(item, content), status: 'ready' }) || item
    } catch (err: any) {
      if (item.source === 'chat' && isMissingFileError(err)) {
        closeArtifact(item.id)
        return null
      }
      return updateArtifact(item.id, {
        status: 'error',
        error: err?.message || String(err),
      }) || item
    }
  }

  async function openFileArtifact(options: { path: string; name?: string; workspace?: string | null; sourceSessionId?: string }): Promise<ArtifactItem> {
    const item = createFileArtifact({
      ...options,
      source: 'manual',
      sourceSessionId: options.sourceSessionId ?? currentChatSessionId.value ?? undefined,
    })
    upsertArtifact(item)
    return await ensureArtifactContent(item.id) || item
  }

  function closeArtifact(id: string): void {
    const item = artifacts.value.find(item => item.id === id)
    if (item?.source === 'chat') dismissedChatArtifactIds.add(id)
    artifacts.value = artifacts.value.filter(item => item.id !== id)
    if (selectedArtifactId.value === id) {
      selectedArtifactId.value = artifacts.value[0]?.id || null
    }
  }

  function clearArtifacts(): void {
    artifacts.value = []
    selectedArtifactId.value = null
    dismissedChatArtifactIds.clear()
  }

  async function downloadArtifact(item: ArtifactItem): Promise<void> {
    if (item.path) {
      await downloadFile(item.path, item.name, undefined, item.workspace)
    }
  }

  function artifactUrl(item: ArtifactItem): string {
    return item.path ? getDownloadUrl(item.path, item.name, undefined, item.workspace) : ''
  }

  return {
    artifacts,
    selectedArtifactId,
    selectedArtifact,
    openSequence,
    openContentArtifact,
    openFileArtifact,
    registerFileArtifact,
    syncChatFileArtifacts,
    ensureArtifactContent,
    selectArtifact,
    closeArtifact,
    clearArtifacts,
    downloadArtifact,
    artifactUrl,
  }
})
