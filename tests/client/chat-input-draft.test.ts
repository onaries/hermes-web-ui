// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const fetchSkillsMock = vi.hoisted(() => vi.fn())
const searchFilesMock = vi.hoisted(() => vi.fn())
const readFileMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  NPopselect: {
    props: ['value', 'options'],
    emits: ['update:value'],
    template: `
      <div class="n-popselect-stub">
        <slot />
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="n-popselect-option"
          :data-value="option.value"
          @click="$emit('update:value', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    `,
  },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/api/hermes/files', () => ({
  searchFiles: searchFilesMock,
  readFile: readFileMock,
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

async function blobText(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsText(blob)
  })
}

function mountForSession(
  sessionId: string,
  sessionOverrides: Partial<ReturnType<typeof useChatStore>['sessions'][number]> = {},
  displayOverrides: Partial<ReturnType<typeof useSettingsStore>['display']> = {},
) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()
  settingsStore.display = { ...settingsStore.display, ...displayOverrides }
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  return mount(ChatInput, { global: { plugins: [pinia] } })
}

describe('ChatInput draft persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      },
    })
    window.innerWidth = 1024
    fetchSkillsMock.mockReset()
    fetchSkillsMock.mockResolvedValue({ categories: [], archived: [] })
    searchFilesMock.mockReset()
    searchFilesMock.mockResolvedValue({ entries: [], path: '' })
    readFileMock.mockReset()
  })

  it('restores unsent text for the active session after the chat view is remounted', async () => {
    const wrapper = mountForSession('session-a')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('draft before tab switch')
    await nextTick()
    wrapper.unmount()

    const remounted = mountForSession('session-a')
    await nextTick()

    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('draft before tab switch')
  })

  it('stores drafts under one localStorage key mapped by session id', async () => {
    const wrapperA = mountForSession('session-a')
    await wrapperA.get('textarea').setValue('draft for session a')
    await nextTick()
    wrapperA.unmount()

    const wrapperB = mountForSession('session-b')
    await wrapperB.get('textarea').setValue('draft for session b')
    await nextTick()
    wrapperB.unmount()

    expect(localStorage.getItem('hermes_chat_input_draft_v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1') || '{}')).toEqual({
      'session-a': 'draft for session a',
      'session-b': 'draft for session b',
    })

    const remountedA = mountForSession('session-a')
    await nextTick()
    expect((remountedA.get('textarea').element as HTMLTextAreaElement).value).toBe('draft for session a')
  })

  it('grows the textarea as multiline draft text is entered', async () => {
    const wrapper = mountForSession('session-autogrow')
    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', {
      configurable: true,
      get() {
        return (textarea.element as HTMLTextAreaElement).value.split('\n').length * 24
      },
    })

    await textarea.setValue('line one\nline two\nline three')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('72px')
  })

  it('resizes after Shift+Enter schedules a non-submit newline path', async () => {
    const wrapper = mountForSession('session-shift-enter')
    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', {
      configurable: true,
      value: 64,
    })

    await textarea.trigger('keydown', { key: 'Enter', shiftKey: true })
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('64px')
  })

  it('applies the configured desktop input height from display settings', async () => {
    const wrapper = mountForSession('session-a', {}, { chat_input_height: 180 })
    await flushPromises()
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('180px')
  })

  it('lets multiline desktop input grow beyond the configured minimum height', async () => {
    const wrapper = mountForSession('session-configured-multiline', {}, { chat_input_height: 48 })
    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', {
      configurable: true,
      value: 72,
    })

    await textarea.setValue('line one\nline two\nline three')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('72px')
  })

  it('resets textarea scroll when configured height can fit the multiline content', async () => {
    const wrapper = mountForSession('session-configured-scroll', {}, { chat_input_height: 96 })
    const textarea = wrapper.get('textarea')
    Object.defineProperty(textarea.element, 'scrollHeight', {
      configurable: true,
      value: 64,
    })
    Object.defineProperty(textarea.element, 'clientHeight', {
      configurable: true,
      value: 96,
    })
    ;(textarea.element as HTMLTextAreaElement).scrollTop = 24

    await textarea.setValue('line one\nline two')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).style.height).toBe('96px')
    expect((textarea.element as HTMLTextAreaElement).scrollTop).toBe(0)
  })

  it('keeps mobile chat input behavior even when a desktop height is configured', async () => {
    window.innerWidth = 640
    const wrapper = mountForSession('session-mobile', {}, { chat_input_height: 180 })
    await flushPromises()
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).not.toBe('180px')
  })

  it('shows context usage for coding-agent sessions when usage is available', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      inputTokens: 1200,
      outputTokens: 800,
      contextTokens: 2000,
    })
    await nextTick()
    await flushPromises()

    expect(wrapper.find('.context-info').text()).toContain('2.0k')
    expect(wrapper.find('.context-bar').exists()).toBe(true)
  })

  it('uses coding-agent reported context limit when available', async () => {
    const wrapper = mountForSession('session-codex-limit', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      inputTokens: 75828,
      outputTokens: 356,
      contextTokens: 76184,
      contextLimit: 237500,
    })
    await nextTick()
    await flushPromises()

    const text = wrapper.find('.context-info').text()
    expect(text).toContain('76.2k')
    expect(text).toContain('237.5k')
    expect(text).toContain('161.3k')
    expect(wrapper.find('.context-bar').exists()).toBe(true)
  })

  it('shows live TPS beside remaining context when available', async () => {
    const wrapper = mountForSession('session-live-tps', {
      inputTokens: 1200,
      outputTokens: 300,
      contextTokens: 1500,
      liveTps: 42.3,
    })
    await nextTick()

    expect(wrapper.find('.context-info').text()).toContain('42.3 chat.liveTps')
    expect(wrapper.find('.live-tps').exists()).toBe(true)
    expect(wrapper.find('.live-tps-separator').exists()).toBe(true)
  })

  it('shows live TPS even before context usage has settled', async () => {
    const wrapper = mountForSession('session-live-tps-only', {
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      liveTps: 18.6,
    })
    await nextTick()

    expect(wrapper.find('.context-info').text()).toBe('18.6 chat.liveTps')
    expect(wrapper.find('.live-tps').exists()).toBe(true)
    expect(wrapper.find('.live-tps-separator').exists()).toBe(false)
    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })

  it('hides live TPS when the display setting is disabled', async () => {
    const wrapper = mountForSession('session-live-tps-disabled', {
      inputTokens: 1200,
      outputTokens: 300,
      contextTokens: 1500,
      liveTps: 18.6,
    }, {
      show_live_tps: false,
    })
    await nextTick()

    expect(wrapper.find('.live-tps').exists()).toBe(false)
    expect(wrapper.find('.context-info').text()).not.toContain('chat.liveTps')
    expect(wrapper.find('.context-bar').exists()).toBe(true)
  })

  it('renders the context bar fill at the current usage width', async () => {
    const wrapper = mountForSession('session-context-bar', {
      inputTokens: 120000,
      outputTokens: 56000,
      contextTokens: 176000,
    })
    await nextTick()

    expect(wrapper.find('.context-bar').exists()).toBe(true)
    expect(wrapper.find('.context-bar-fill').attributes('style')).toContain('width: 68.75%')
  })

  it('hides reasoning effort selector for coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
    })
    await nextTick()

    expect(wrapper.find('.n-popselect-stub').exists()).toBe(false)
    expect(wrapper.find('[data-value="high"]').exists()).toBe(false)
  })

  it('stores the selected reasoning effort for the active session', async () => {
    const wrapper = mountForSession('session-reasoning')
    const store = useChatStore()

    await wrapper.get('[data-value="high"]').trigger('click')
    await nextTick()

    expect(store.sessions[0].reasoningEffort).toBe('high')
    expect(localStorage.getItem('hermes:reasoning_effort:session-reasoning')).toBe('high')
  })

  it('exposes a file drop helper that adds attachment previews', async () => {
    const createObjectURL = vi.fn(() => 'blob:drop-test')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const wrapper = mountForSession('session-file-drop')
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

    ;(wrapper.vm as any).addFiles([file])
    await nextTick()

    expect(createObjectURL).toHaveBeenCalledWith(file)
    expect(wrapper.find('.attachment-preview').exists()).toBe(true)
    expect(wrapper.text()).toContain('notes.txt')

    wrapper.unmount()
  })

  it('attaches a workspace file from @ mention autocomplete', async () => {
    const createObjectURL = vi.fn(() => 'blob:mention-test')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    searchFilesMock.mockResolvedValue({
      path: '/repo',
      entries: [
        { name: 'app.ts', path: '/repo/src/app.ts', isDir: false, size: 18, modTime: '' },
      ],
    })
    let resolveReadFile: (value: { content: string; path: string; size: number }) => void = () => {}
    readFileMock.mockReturnValue(new Promise(resolve => {
      resolveReadFile = resolve
    }))
    const wrapper = mountForSession('session-file-mention', { workspace: '/repo', profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('look @app')
    await flushPromises()
    await nextTick()

    expect(searchFilesMock).toHaveBeenCalledWith('/repo', 'app', 'work', 20)
    expect(wrapper.text()).toContain('app.ts')

    await wrapper.get('.file-mention-item').trigger('mousedown')
    await nextTick()

    expect(readFileMock).toHaveBeenCalledWith('/repo/src/app.ts', 'work')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('look ')
    expect(wrapper.find('.file-mention-item').exists()).toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()

    resolveReadFile({ content: 'export const ok = true', path: '/repo/src/app.ts', size: 22 })
    await flushPromises()
    await nextTick()

    expect(createObjectURL).toHaveBeenCalled()
    const attachedFile = (createObjectURL.mock.calls as unknown as unknown[][])[0]?.[0] as File
    expect(attachedFile.name).toBe('app.ts')
    expect(await blobText(attachedFile)).toBe('export const ok = true')
    expect(wrapper.find('.attachment-preview').exists()).toBe(true)
    expect(wrapper.text()).toContain('app.ts')
  })

  it('searches workspace files again as the @ mention query changes', async () => {
    searchFilesMock.mockImplementation(async (_path: string, query: string) => ({
      path: '/repo',
      entries: query === 'rea'
        ? [{ name: 'README.md', path: '/repo/README.md', isDir: false, size: 12, modTime: '' }]
        : [{ name: 'app.ts', path: '/repo/src/app.ts', isDir: false, size: 18, modTime: '' }],
    }))
    const wrapper = mountForSession('session-file-mention-search', { workspace: '/repo', profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('look @app')
    await flushPromises()
    await nextTick()
    expect(searchFilesMock).toHaveBeenLastCalledWith('/repo', 'app', 'work', 20)
    expect(wrapper.text()).toContain('app.ts')

    await textarea.setValue('look @rea')
    await nextTick()
    expect(wrapper.text()).not.toContain('app.ts')
    await flushPromises()
    await nextTick()

    expect(searchFilesMock).toHaveBeenLastCalledWith('/repo', 'rea', 'work', 20)
    expect(wrapper.text()).toContain('README.md')
    expect(wrapper.text()).not.toContain('app.ts')
  })

  it('ignores stale @ mention search results when typing changes before the first search resolves', async () => {
    let resolveAppSearch: (value: { path: string; entries: any[] }) => void = () => {}
    searchFilesMock.mockImplementation(async (_path: string, query: string) => {
      if (query === 'app') {
        return new Promise(resolve => {
          resolveAppSearch = resolve
        })
      }
      return {
        path: '/repo',
        entries: [{ name: 'README.md', path: '/repo/README.md', isDir: false, size: 12, modTime: '' }],
      }
    })
    const wrapper = mountForSession('session-file-mention-stale-search', { workspace: '/repo', profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('look @app')
    await nextTick()
    expect(searchFilesMock).toHaveBeenLastCalledWith('/repo', 'app', 'work', 20)

    await textarea.setValue('look @rea')
    await flushPromises()
    await nextTick()
    expect(searchFilesMock).toHaveBeenLastCalledWith('/repo', 'rea', 'work', 20)
    expect(wrapper.text()).toContain('README.md')

    resolveAppSearch({
      path: '/repo',
      entries: [{ name: 'app.ts', path: '/repo/src/app.ts', isDir: false, size: 18, modTime: '' }],
    })
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).toContain('README.md')
    expect(wrapper.text()).not.toContain('app.ts')
  })

  it('opens the skill picker from /skill and inserts the selected skill command', async () => {
    fetchSkillsMock.mockResolvedValue({
      categories: [
        {
          name: 'review',
          description: '',
          skills: [
            { name: 'github-pr-review', description: 'Review pull requests', enabled: true },
            { name: 'disabled-skill', description: 'Hidden', enabled: false },
          ],
        },
      ],
      archived: [],
    })
    const wrapper = mountForSession('session-skills', { profile: 'work' })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/skill')
    await nextTick()

    await wrapper.get('.slash-command-item').trigger('mousedown')
    await flushPromises()
    await nextTick()

    expect(fetchSkillsMock).toHaveBeenCalledWith('work')
    expect(wrapper.text()).toContain('/skill github-pr-review')
    expect(wrapper.text()).toContain('Review pull requests')
    expect(wrapper.text()).not.toContain('disabled-skill')

    await wrapper.get('.skill-picker-item').trigger('click')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill github-pr-review ')
  })

  it('hides bridge autocomplete for non-Hermes slash prefixes', async () => {
    const wrapper = mountForSession('session-prefixes')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('/')
    await nextTick()
    expect(wrapper.findAll('.slash-command-item').length).toBeGreaterThan(0)

    await textarea.setValue('/ter')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(4, 4)
    await textarea.trigger('input')
    await nextTick()

    const dropdown = wrapper.find('.slash-command-dropdown')
    if (dropdown.exists()) {
      expect(dropdown.classes()).toContain('dropdown-fade-leave-active')
    } else {
      expect(wrapper.findAll('.slash-command-item')).toHaveLength(0)
    }
  })
})
