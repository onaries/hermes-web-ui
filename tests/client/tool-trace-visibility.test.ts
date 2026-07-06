// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params?.elapsed ? `${key} ${params.elapsed}` : key
    ),
  }),
}))

vi.mock('@/composables/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: { template: '<div><slot /></div>' },
  NDrawerContent: { template: '<div><slot /></div>' },
  NSpin: { template: '<div><slot /></div>' },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('@/components/hermes/chat/MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: {
      message: { type: Object, required: true },
      highlight: { type: Boolean, default: false },
    },
    template: '<div class="stub-message" :data-role="message.role" :data-id="message.id">{{ message.toolName || message.content }}</div>',
  },
}))

vi.mock('@/components/hermes/chat/VirtualMessageList.vue', () => ({
  default: {
    name: 'VirtualMessageList',
    props: {
      messages: { type: Array, default: () => [] },
    },
    methods: {
      scrollToBottom() {},
      shouldAutoFollowBottom() { return true },
    },
    template: `
      <div class="virtual-message-list-stub">
        <slot name="before" />
        <div v-for="message in messages" :key="message.id">
          <slot name="item" :message="message" />
        </div>
        <slot name="after" />
        <slot v-if="messages.length === 0" name="empty" />
      </div>
    `,
  },
}))

import MessageList from '@/components/hermes/chat/MessageList.vue'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'

const MessageItemStub = defineComponent({
  name: 'MessageItem',
  props: {
    message: { type: Object, required: true },
    highlight: { type: Boolean, default: false },
  },
  template: '<div class="stub-message" :data-role="message.role" :data-id="message.id">{{ message.toolName || message.content }}</div>',
})

const VirtualMessageListStub = defineComponent({
  name: 'VirtualMessageList',
  props: {
    messages: { type: Array, default: () => [] },
  },
  methods: {
    scrollToBottom() {},
    shouldAutoFollowBottom() { return true },
  },
  template: `
    <div class="virtual-message-list-stub">
      <slot name="before" />
      <div v-for="message in messages" :key="message.id">
        <slot name="item" :message="message" />
      </div>
      <slot name="after" />
      <slot v-if="messages.length === 0" name="empty" />
    </div>
  `,
})

function makeSession(messages: Message[]): Session {
  return {
    id: 'session-1',
    title: 'Tool trace visibility',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const sampleMessages: Message[] = [
  { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
  { id: 'tool-named', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolArgs: { path: '/Users/safemotion/Documents/projects/safemotion/clip/really/long/file/path/that/does/not/fit/on/one/line.ts' }, toolPreview: '/Users/safemotion/Documents/projects/safemotion/clip/really/long/file/path/that…', toolResult: 'ok', toolStatus: 'done', toolDuration: 0.21 },
  { id: 'tool-internal', role: 'tool', content: '', timestamp: 3, toolResult: 'internal', toolStatus: 'done' },
  { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 4 },
]

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('tool trace visibility', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('hermes_show_tool_calls')
    const settingsStore = useSettingsStore()
    settingsStore.display = { show_tool_mascot: undefined }
    setMobileViewport(false)
    useToolTraceVisibility().setToolTraceVisible(true)
  })

  function mountLiveList(messages: Message[] = sampleMessages, showLivePanel = true) {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.messages = [...messages]
    chatStore.activeSession = makeSession(messages)
    chatStore.abortState = showLivePanel ? { aborting: true, synced: false } : null

    return mount(MessageList, {
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          VirtualMessageList: VirtualMessageListStub,
          Transition: false,
        },
      },
    })
  }

  it('shows named transcript and live tool traces by default while keeping unnamed internal tools hidden', () => {
    const wrapper = mountLiveList()

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'tool-named',
      'assistant-1',
    ])
    expect(wrapper.find('.thinking-video').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')
    const readFileTool = wrapper.findAll('.tool-call-item').find(node => node.text().includes('read_file'))
    expect(readFileTool?.attributes('title')).toContain('/Users/safemotion/Documents/projects/safemotion/clip/really/long/file/path/that/does/not/fit/on/one/line.ts')
  })

  it('hides the live tool mascot on desktop when disabled in desktop display settings', () => {
    const settingsStore = useSettingsStore()
    settingsStore.display = { show_tool_mascot_desktop: false, show_tool_mascot_mobile: true }
    setMobileViewport(false)

    const wrapper = mountLiveList()

    expect(wrapper.find('.thinking-video').exists()).toBe(false)
    expect(wrapper.find('.streaming-indicator--no-mascot').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')
  })

  it('hides the live tool mascot on mobile without changing the desktop setting', () => {
    const settingsStore = useSettingsStore()
    settingsStore.display = { show_tool_mascot_desktop: true, show_tool_mascot_mobile: false }
    setMobileViewport(true)

    const wrapper = mountLiveList()

    expect(wrapper.find('.thinking-video').exists()).toBe(false)
    expect(wrapper.find('.streaming-indicator--no-mascot').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')
  })

  it('falls back to the legacy tool mascot setting when platform-specific settings are unset', () => {
    const settingsStore = useSettingsStore()
    settingsStore.display = { show_tool_mascot: false }
    setMobileViewport(true)

    const wrapper = mountLiveList()

    expect(wrapper.find('.thinking-video').exists()).toBe(false)
    expect(wrapper.find('.streaming-indicator--no-mascot').exists()).toBe(true)
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')
  })

  it('summarizes large tool batches only in the transcript, not the live panel', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'do many things', timestamp: 1 },
      { id: 'tool-1', role: 'tool', content: '', timestamp: 2, toolName: 'terminal', toolArgs: { command: 'npm test' }, toolStatus: 'done', toolDuration: 0.4 },
      { id: 'tool-2', role: 'tool', content: '', timestamp: 3, toolName: 'terminal', toolArgs: { command: 'npm run build' }, toolStatus: 'done', toolDuration: 1.1 },
      { id: 'tool-3', role: 'tool', content: '', timestamp: 4, toolName: 'search_files', toolArgs: { pattern: 'tool', target: 'content' }, toolStatus: 'done', toolDuration: 2.2 },
      { id: 'tool-4', role: 'tool', content: '', timestamp: 5, toolName: 'web_search', toolArgs: { query: 'Hermes' }, toolStatus: 'done', toolDuration: 60.5 },
      { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 6 },
    ]

    const transcriptWrapper = mountLiveList(messages, false)

    const transcriptGroup = transcriptWrapper.find('.tool-trace-group')
    expect(transcriptGroup.exists()).toBe(true)
    expect(transcriptGroup.text()).toContain('chat.toolAggregate.ranCommandsMany')
    expect(transcriptWrapper.find('.tool-summary-duration').text()).toBe('chat.toolAggregate.durationMinutes')
    expect(transcriptWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])

    const liveWrapper = mountLiveList(messages)
    expect(liveWrapper.find('.tool-call-summary-item').exists()).toBe(false)
    const liveToolNames = liveWrapper
      .findAll('.tool-call-item:not(.compression-item) .tool-call-name')
      .map(node => node.text())
    expect(liveToolNames).toEqual([
      'web_search',
      'search_files',
      'terminal',
      'terminal',
    ])
  })

  it('marks running live tools for entry/progress animation', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
      { id: 'tool-running', role: 'tool', content: '', timestamp: 2, toolName: 'search_files', toolArgs: { pattern: 'DrawerPanel' }, toolStatus: 'running' },
    ]

    const wrapper = mountLiveList(messages)
    const toolList = wrapper.find('.tool-call-list')
    const runningTool = wrapper.find('.tool-call-item--running')

    expect(toolList.exists()).toBe(true)
    expect(runningTool.exists()).toBe(true)
    expect(runningTool.find('.tool-call-spinner').exists()).toBe(true)
    expect(runningTool.text()).toContain('search_files')
  })

  it('shows live Codex Command rows with the command args instead of stdout preview', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'check dataset', timestamp: 1 },
      {
        id: 'tool-command-done',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'Command',
        toolArgs: { command: 'ssh AICA md5sum content 01-InHARD.7z.*' },
        toolPreview: 'X11 forwarding request failed on channel 8\nrchar: 11424926668 wchar: 1473473954',
        toolStatus: 'done',
      },
    ]

    const wrapper = mountLiveList(messages)
    const commandTool = wrapper.find('.tool-call-item--done')

    expect(commandTool.exists()).toBe(true)
    expect(commandTool.text()).toContain('Command')
    expect(commandTool.text()).toContain('ssh AICA md5sum content 01-InHARD.7z.*')
    expect(commandTool.text()).not.toContain('X11 forwarding request failed')
  })

  it('does not show empty Web Search JSON in the live tool preview', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'search', timestamp: 1 },
      {
        id: 'tool-web-search',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'Web Search',
        toolArgs: { query: '' },
        toolPreview: '{"query":""}',
        toolStatus: 'running',
      },
    ]

    const wrapper = mountLiveList(messages)
    const tool = wrapper.find('.tool-call-item--running')

    expect(tool.exists()).toBe(true)
    expect(tool.text()).toContain('Web Search')
    expect(tool.text()).not.toContain('{"query":""}')
  })

  it('shows nested Web Search action queries in the live tool preview', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'search', timestamp: 1 },
      {
        id: 'tool-web-search',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'Web Search',
        toolArgs: { query: '', action: { query: 'Hermes Studio web search display bug' } },
        toolPreview: '{"query":""}',
        toolStatus: 'running',
      },
    ]

    const wrapper = mountLiveList(messages)
    const tool = wrapper.find('.tool-call-item--running')

    expect(tool.text()).toContain('Hermes Studio web search display bug')
    expect(tool.text()).not.toContain('{"query":""}')
  })

  it('shows running terminal tools with the standard spinner only', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'run a long build', timestamp: Date.now() - 65_000 },
      {
        id: 'tool-terminal',
        role: 'tool',
        content: '',
        timestamp: Date.now() - 65_000,
        toolName: 'terminal',
        toolArgs: { command: 'npm run build' },
        toolStatus: 'running',
      },
    ]

    const wrapper = mountLiveList(messages)
    const runningTool = wrapper.find('.tool-call-item--running')

    expect(runningTool.exists()).toBe(true)
    expect(runningTool.find('.tool-call-spinner').exists()).toBe(true)
    expect(runningTool.text()).toContain('terminal')
    expect(runningTool.text()).not.toContain('chat.terminalRunning')
    expect(wrapper.find('.tool-call-running-badge').exists()).toBe(false)
    expect(wrapper.find('.tool-call-running-dot').exists()).toBe(false)
  })

  it('keeps completed terminal tools visible during active work without loading affordances', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'restart bridge', timestamp: 1 },
      {
        id: 'tool-terminal-done',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'terminal',
        toolArgs: { command: 'kill -USR2 1234' },
        toolStatus: 'done',
        toolDuration: 3.2,
      },
      {
        id: 'tool-todo-done',
        role: 'tool',
        content: '',
        timestamp: 3,
        toolName: 'todo',
        toolArgs: { todos: [] },
        toolStatus: 'done',
      },
      {
        id: 'tool-search-done',
        role: 'tool',
        content: '',
        timestamp: 4,
        toolName: 'search_files',
        toolArgs: { pattern: 'terminal' },
        toolStatus: 'done',
        toolDuration: 0.5,
      },
    ]

    const wrapper = mountLiveList(messages)
    const liveToolNames = wrapper
      .findAll('.tool-call-item:not(.compression-item) .tool-call-name')
      .map(node => node.text())

    expect(liveToolNames).toEqual(['search_files', 'todo', 'terminal'])
    const doneRows = wrapper.findAll('.tool-call-item--done')
    expect(doneRows.some(node => node.text().includes('terminal') && node.text().includes('3.2s'))).toBe(true)
    expect(doneRows.some(node => node.text().includes('todo') && node.text().includes('0ms'))).toBe(true)
    expect(wrapper.find('.tool-call-item--running').exists()).toBe(false)
    expect(wrapper.find('.tool-call-item:not(.compression-item) .tool-call-spinner').exists()).toBe(false)
    expect(wrapper.find('.tool-call-running-badge').exists()).toBe(false)
  })

  it('does not keep stale running terminal placeholders in the live panel after a run is inactive', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'run command', timestamp: 1 },
      {
        id: 'tool-terminal-stale',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'terminal',
        toolArgs: { command: 'npm run build' },
        toolStatus: 'running',
      },
      { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: 3 },
    ]

    const wrapper = mountLiveList(messages, false)

    expect(wrapper.find('.tool-calls-panel').exists()).toBe(false)
    expect(wrapper.find('.tool-call-running-badge').exists()).toBe(false)
  })

  it('keeps a visible entry animation class on newly added live tool rows', async () => {
    vi.useFakeTimers()
    try {
      const messages: Message[] = [
        { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
      ]
      const wrapper = mountLiveList(messages)
      const chatStore = useChatStore()

      const nextMessages: Message[] = [
        ...messages,
        { id: 'tool-running', role: 'tool', content: '', timestamp: 2, toolName: 'search_files', toolArgs: { pattern: 'DrawerPanel' }, toolStatus: 'running' },
      ]
      chatStore.activeSession = makeSession(nextMessages)
      await nextTick()

      expect(wrapper.find('.tool-call-item--entering').exists()).toBe(true)
      expect(wrapper.find('.tool-call-item--entering').text()).toContain('search_files')

      vi.advanceTimersByTime(901)
      await nextTick()

      expect(wrapper.find('.tool-call-item--entering').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not apply the stronger entry highlight to fast-completed live tools', async () => {
    vi.useFakeTimers()
    try {
      const messages: Message[] = [
        { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
      ]
      const wrapper = mountLiveList(messages)
      const chatStore = useChatStore()

      const nextMessages: Message[] = [
        ...messages,
        { id: 'tool-done', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolArgs: { path: '/tmp/file.ts' }, toolStatus: 'done', toolDuration: 0.08 },
      ]
      chatStore.activeSession = makeSession(nextMessages)
      await nextTick()

      const doneTool = wrapper.find('.tool-call-item--done')
      expect(doneTool.exists()).toBe(true)
      expect(doneTool.text()).toContain('read_file')
      expect(wrapper.find('.tool-call-item--entering').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps completed live tools visible while final assistant output streams without loading affordances', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'inspect repo', timestamp: 1 },
      { id: 'tool-done', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolArgs: { path: '/tmp/file.ts' }, toolResult: 'ok', toolStatus: 'done' },
      { id: 'assistant-final', role: 'assistant', content: 'Final answer is streaming', timestamp: 3, isStreaming: true },
    ]

    const wrapper = mountLiveList(messages)

    const liveToolNames = wrapper
      .findAll('.tool-call-item:not(.compression-item) .tool-call-name')
      .map(node => node.text())
    expect(liveToolNames).toEqual(['read_file'])
    expect(wrapper.find('.tool-call-item--done').exists()).toBe(true)
    expect(wrapper.find('.tool-call-item--running').exists()).toBe(false)
    expect(wrapper.find('.tool-call-item:not(.compression-item) .tool-call-spinner').exists()).toBe(false)
  })

  it('expands live patch tools to show the changed diff', async () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'patch file', timestamp: 1 },
      {
        id: 'tool-patch',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'patch',
        toolArgs: { path: 'src/example.ts' },
        toolResult: {
          diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n-const answer = 41\n+const answer = 42',
        },
        toolStatus: 'done',
      },
    ]
    const wrapper = mountLiveList(messages)

    const patchTool = wrapper.find('.tool-call-item--expandable')
    expect(patchTool.exists()).toBe(true)
    expect(patchTool.attributes('role')).toBe('button')
    expect(patchTool.attributes('aria-expanded')).toBe('false')

    await patchTool.trigger('click')
    await nextTick()

    const expandedPatchTool = wrapper.find('.tool-call-item--expandable')
    const details = wrapper.find('.tool-call-patch-details')
    expect(expandedPatchTool.attributes('aria-expanded')).toBe('true')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('chat.patchChanges')
    expect(details.text()).toContain('-const answer = 41')
    expect(details.text()).toContain('+const answer = 42')
  })

  it('auto-expands newly completed live patch tools when enabled', async () => {
    const settingsStore = useSettingsStore()
    settingsStore.display = { auto_open_patch_drawer: true }
    const runningMessages: Message[] = [
      { id: 'user-1', role: 'user', content: 'patch file', timestamp: 1 },
      {
        id: 'tool-patch-auto',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'patch',
        toolArgs: { path: 'src/example.ts', old_string: 'const answer = 41', new_string: 'const answer = 42' },
        toolStatus: 'running',
      },
    ]
    const wrapper = mountLiveList(runningMessages)
    const chatStore = useChatStore()

    expect(wrapper.find('.tool-call-item--expandable').attributes('aria-expanded')).toBe('false')

    const completedMessages = [
      runningMessages[0],
      {
        ...runningMessages[1],
        toolStatus: 'done',
        toolResult: {
          diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,2 @@\n-const answer = 41\n+const answer = 42',
        },
      },
    ] as Message[]
    chatStore.activeSession = makeSession(completedMessages)
    await nextTick()

    const expandedPatchTool = wrapper.find('.tool-call-item--expandable')
    const details = wrapper.find('.tool-call-patch-details')
    expect(expandedPatchTool.attributes('aria-expanded')).toBe('true')
    expect(details.exists()).toBe(true)
    expect(details.text()).toContain('-const answer = 41')
    expect(details.text()).toContain('+const answer = 42')
  })

  it('does not auto-expand already loaded patch tools when enabled', () => {
    const settingsStore = useSettingsStore()
    settingsStore.display = { auto_open_patch_drawer: true }
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'patch file', timestamp: 1 },
      {
        id: 'tool-patch-loaded',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'patch',
        toolArgs: { path: 'src/example.ts' },
        toolResult: { diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@\n-old\n+new' },
        toolStatus: 'done',
      },
    ]
    const wrapper = mountLiveList(messages)

    expect(wrapper.find('.tool-call-item--expandable').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.tool-call-patch-details').exists()).toBe(false)
  })

  it('renders the current todo panel below the live tool panel', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'do the thing', timestamp: 1 },
      { id: 'tool-read', role: 'tool', content: '', timestamp: 2, toolName: 'read_file', toolArgs: { path: '/tmp/file.ts' }, toolResult: 'ok', toolStatus: 'done' },
      { id: 'tool-todo', role: 'tool', content: '', timestamp: 3, toolName: 'todo', toolArgs: JSON.stringify({ todos: [
        { id: 'a', content: 'Plan patch', status: 'completed' },
        { id: 'b', content: 'Apply patch', status: 'in_progress' },
        { id: 'c', content: 'Verify behavior', status: 'pending' },
      ] }), toolResult: '{}', toolStatus: 'done' },
    ]
    const wrapper = mountLiveList(messages)
    const html = wrapper.html()

    expect(wrapper.find('.tool-calls-panel').exists()).toBe(true)
    expect(wrapper.find('.todo-panel').exists()).toBe(true)
    expect(html.indexOf('streaming-indicator')).toBeLessThan(html.indexOf('todo-panel'))
    expect(html.indexOf('tool-calls-panel')).toBeLessThan(html.indexOf('todo-panel'))
    expect(wrapper.text()).toContain('Plan patch')
    expect(wrapper.text()).toContain('Apply patch')
    expect(wrapper.text()).toContain('Verify behavior')
  })

  it('applies the same default-visible rule to history sessions', () => {
    const wrapper = mount(HistoryMessageList, {
      props: { session: makeSession(sampleMessages) },
      global: {
        stubs: { MessageItem: MessageItemStub, VirtualMessageList: VirtualMessageListStub },
      },
    })

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'tool-named',
      'assistant-1',
    ])
  })

  it('does not fall back to the live chat session while history session data is loading', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession(sampleMessages)

    const wrapper = mount(HistoryMessageList, {
      global: {
        stubs: { MessageItem: MessageItemStub, VirtualMessageList: VirtualMessageListStub },
      },
    })

    expect(wrapper.findAll('.stub-message')).toHaveLength(0)
  })

  it('hides named transcript traces when the toggle is off while keeping live tool stream visible', () => {
    useToolTraceVisibility().setToolTraceVisible(false)

    const liveWrapper = mountLiveList()
    expect(liveWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
    expect(liveWrapper.findAll('.tool-call-name').map(node => node.text())).toContain('read_file')

    const historyWrapper = mount(HistoryMessageList, {
      props: { session: makeSession(sampleMessages) },
      global: {
        stubs: { MessageItem: MessageItemStub, VirtualMessageList: VirtualMessageListStub },
      },
    })
    expect(historyWrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toEqual([
      'user-1',
      'assistant-1',
    ])
  })

  it('does not treat tool traces before a slash command as current tool calls', () => {
    const chatStore = useChatStore()
    chatStore.activeSessionId = 'session-1'
    chatStore.activeSession = makeSession([
      { id: 'user-1', role: 'user', content: 'check weather', timestamp: 1 },
      { id: 'tool-weather', role: 'tool', content: '', timestamp: 2, toolName: 'weather', toolResult: 'ok', toolStatus: 'done' },
      { id: 'command-1', role: 'command', content: '/moa where next', timestamp: 3 },
    ])
    chatStore.abortState = { aborting: true, synced: false }

    const wrapper = mount(MessageList, {
      global: {
        stubs: {
          MessageItem: MessageItemStub,
          Transition: false,
        },
      },
    })

    expect(wrapper.findAll('.stub-message').map(node => node.attributes('data-id'))).toContain('tool-weather')
    expect(wrapper.findAll('.tool-call-name').map(node => node.text())).not.toContain('weather')
  })

})
