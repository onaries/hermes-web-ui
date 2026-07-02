// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'
import { archiveSession, fetchSessions } from '@/api/hermes/sessions'
import { resumeSession } from '@/api/hermes/chat'

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn((_sessionId: string, cb: (data: any) => void) => {
    cb({ session_id: _sessionId, isWorking: false, messages: [] })
  }),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  showCompletionNotification: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

function makeSession(id: string, times: Partial<{ started_at: number; ended_at: number | null; last_active: number }>) {
  return {
    id,
    profile: 'default',
    source: 'cli',
    title: id,
    preview: '',
    started_at: times.started_at ?? 1,
    ended_at: times.ended_at ?? null,
    last_active: times.last_active,
    message_count: 0,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: 'gpt-test',
    provider: 'test',
  }
}

describe('chat session ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('orders sessions by the newest known activity timestamp, including started_at', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('older-active-session', { started_at: 100, last_active: 900 }),
        makeSession('new-session-with-stale-last-active', { started_at: 1000, last_active: 200 }),
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions.map(session => session.id)).toEqual([
      'new-session-with-stale-last-active',
      'older-active-session',
    ])
    expect(store.sessions[0].updatedAt).toBe(1000_000)
  })

  it('removes an archived session from the runtime session list', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('active-session', { started_at: 1000, last_active: 1000 }),
        makeSession('archive-me', { started_at: 900, last_active: 900 }),
      ] as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeSession('active-session', { started_at: 1000, last_active: 1000 }),
      ] as any)
      .mockResolvedValueOnce([])
    vi.mocked(archiveSession).mockResolvedValueOnce(true)

    const store = useChatStore()
    await store.loadSessions()
    const ok = await store.archiveSession('archive-me')

    expect(ok).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('archive-me')
    expect(store.sessions.map(session => session.id)).toEqual(['active-session'])
  })

  it('clears the active session when archiving the only runtime session', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        makeSession('archive-me', { started_at: 1000, last_active: 1000 }),
      ] as any)
      .mockResolvedValueOnce([])
    vi.mocked(archiveSession).mockResolvedValueOnce(true)

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSessionId).toBe('archive-me')

    const ok = await store.archiveSession('archive-me')

    expect(ok).toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('archive-me')
    expect(store.sessions).toEqual([])
    expect(store.activeSessionId).toBeNull()
    expect(store.activeSession).toBeNull()
  })

  it('keeps coding-agent context usage separate from cumulative token accounting', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        {
          ...makeSession('codex-session', { started_at: 1000, last_active: 1000 }),
          source: 'coding_agent',
          agent: 'codex',
          input_tokens: 8_787_567,
          output_tokens: 31_809,
          context_tokens: 187_985,
          context_limit: 237_500,
        },
      ] as any)
      .mockResolvedValueOnce([])

    const store = useChatStore()
    await store.loadSessions()

    expect(store.sessions[0]).toMatchObject({
      inputTokens: 8_787_567,
      outputTokens: 31_809,
      contextTokens: 187_985,
      contextLimit: 237_500,
    })
  })

  it('pairs repeated Codex Command item ids with the nearest assistant tool call', async () => {
    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([
        {
          ...makeSession('codex-session', { started_at: 1000, last_active: 1000 }),
          source: 'coding_agent',
          agent: 'codex',
          message_count: 4,
        },
      ] as any)
      .mockResolvedValueOnce([])
    vi.mocked(resumeSession).mockImplementationOnce((_sessionId: string, cb: (data: any) => void) => {
      cb({
        session_id: _sessionId,
        isWorking: false,
        messages: [
          {
            id: 1,
            session_id: _sessionId,
            role: 'assistant',
            content: '',
            timestamp: 1000,
            tool_calls: [{
              id: 'item_2',
              type: 'function',
              function: {
                name: 'Command',
                arguments: '{"command":"/bin/zsh -lc \\"nl -ba first.py\\""}',
              },
            }],
          },
          {
            id: 2,
            session_id: _sessionId,
            role: 'tool',
            content: '     1\timport copy\n     2\timport os',
            timestamp: 1001,
            tool_call_id: 'item_2',
            tool_name: 'Command',
          },
          {
            id: 3,
            session_id: _sessionId,
            role: 'assistant',
            content: '',
            timestamp: 1002,
            tool_calls: [{
              id: 'item_2',
              type: 'function',
              function: {
                name: 'Command',
                arguments: '{"command":"/bin/zsh -lc \\"git status --short\\""}',
              },
            }],
          },
          {
            id: 4,
            session_id: _sessionId,
            role: 'tool',
            content: ' M first.py',
            timestamp: 1003,
            tool_call_id: 'item_2',
            tool_name: 'Command',
          },
        ],
      })
    })

    const store = useChatStore()
    await store.loadSessions()

    const tools = store.activeSession?.messages.filter(message => message.role === 'tool') || []
    expect(tools).toHaveLength(2)
    expect(tools[0].toolArgs).toBe('{"command":"/bin/zsh -lc \\"nl -ba first.py\\""}')
    expect(tools[1].toolArgs).toBe('{"command":"/bin/zsh -lc \\"git status --short\\""}')
  })
})
