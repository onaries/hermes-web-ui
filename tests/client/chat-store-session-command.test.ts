// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  connectEmit: vi.fn(),
  connectChatRun: vi.fn(() => ({ emit: chatApi.connectEmit })),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [], queueLength: 0 })
    return {} as any
  }),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  sessionCommandHandlers: [] as Array<(event: any) => void>,
  peerUserMessageHandlers: [] as Array<(event: any) => void>,
  sessionTitleUpdatedHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('@/api/hermes/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  connectChatRun: chatApi.connectChatRun,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => {
    chatApi.peerUserMessageHandlers.push(handler)
    return vi.fn()
  }),
  onSessionCommand: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionCommandHandlers.push(handler)
    return vi.fn()
  }),
  onSessionTitleUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionTitleUpdatedHandlers.push(handler)
    return vi.fn()
  }),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    waitForModelsForRun: vi.fn(async () => undefined),
    selectedModel: 'gpt-test',
    selectedProvider: 'openai',
    modelGroups: [],
  }),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(): Session {
  return {
    id: 'session-1',
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store session.command fanout', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
  })

  it('attaches to a goal resume run started from another window', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    expect(chatApi.sessionCommandHandlers).toHaveLength(1)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })

    expect(store.isStreaming).toBe(true)
    expect(chatApi.registerSessionHandlers).toHaveBeenCalledWith('session-1', expect.objectContaining({
      onRunStarted: expect.any(Function),
      onSessionCommand: expect.any(Function),
    }))
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'command',
        content: 'Goal resumed',
        commandAction: 'resume',
      }),
    ])
  })

  it('keeps the latest live TPS visible after a resumed run completes', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'streaming text' })
      expect(session.liveTps).toBeNull()
      vi.setSystemTime(3_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'more streaming text' })
      expect(session.liveTps).toBeGreaterThan(0)
      const finalTps = session.liveTps

      handlers.onRunCompleted({
        event: 'run.completed',
        session_id: 'session-1',
        queue_remaining: 0,
        output: 'streaming text',
      })

      expect(session.liveTps).toBe(finalTps)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts live TPS timing at the first streamed token, not at run start', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(61_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      expect(session.liveTps).toBeNull()
      vi.setSystemTime(62_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      expect(session.liveTps).toBeNull()
      vi.setSystemTime(63_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })

      expect(session.liveTps).toBe(7.5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses final server output token delta for the completed TPS value when usage is available', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      session.outputTokens = 100
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(2_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'short' })
      vi.setSystemTime(4_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'short' })
      vi.setSystemTime(6_000)
      handlers.onRunCompleted({
        event: 'run.completed',
        session_id: 'session-1',
        queue_remaining: 0,
        output: 'shortshort',
        inputTokens: 50,
        outputTokens: 130,
      })

      expect(session.outputTokens).toBe(130)
      expect(session.liveTps).toBe(7.5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses backend-settled TPS from completed run payload when available', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      session.outputTokens = 100
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(2_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'short' })
      vi.setSystemTime(4_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'short' })
      vi.setSystemTime(6_000)
      handlers.onRunCompleted({
        event: 'run.completed',
        session_id: 'session-1',
        queue_remaining: 0,
        output: 'shortshort',
        inputTokens: 50,
        outputTokens: 130,
        duration_seconds: 3.75,
        tps: 8,
      })

      expect(session.outputTokens).toBe(130)
      expect(session.liveTps).toBe(8)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps live estimate when backend TPS is implausibly cumulative', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(2_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      vi.setSystemTime(3_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      vi.setSystemTime(4_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      expect(session.liveTps).toBe(7.5)

      handlers.onRunCompleted({
        event: 'run.completed',
        session_id: 'session-1',
        queue_remaining: 0,
        output: 'stream',
        inputTokens: 50,
        outputTokens: 3_416,
        duration_seconds: 1.4,
        tps: 2362,
      })

      expect(session.liveTps).toBe(7.5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not show a huge completed TPS from a single streamed chunk', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(2_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'one chunk' })
      vi.setSystemTime(2_100)
      handlers.onRunCompleted({
        event: 'run.completed',
        session_id: 'session-1',
        queue_remaining: 0,
        output: 'one chunk',
        inputTokens: 50,
        outputTokens: 3_416,
      })

      expect(session.liveTps).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to streamed token estimates when completed usage is implausibly cumulative', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(2_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      vi.setSystemTime(4_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      vi.setSystemTime(6_000)
      handlers.onRunCompleted({
        event: 'run.completed',
        session_id: 'session-1',
        queue_remaining: 0,
        output: 'short stream',
        inputTokens: 50,
        outputTokens: 3_416,
      })

      expect(session.liveTps).toBeLessThan(100)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let long tool gaps depress live TPS when reasoning resumes', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      vi.setSystemTime(2_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      vi.setSystemTime(3_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      vi.setSystemTime(4_000)
      handlers.onMessageDelta({ event: 'message.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })
      expect(session.liveTps).toBe(7.5)

      vi.setSystemTime(64_000)
      handlers.onReasoningDelta({ event: 'reasoning.delta', session_id: 'session-1', delta: 'abcdefghijklmnopqrst' })

      expect(session.liveTps).toBeGreaterThanOrEqual(7.5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates live TPS while reasoning deltas stream before answer text', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const store = useChatStore()
      const session = makeSession()
      store.sessions = [session]
      store.activeSessionId = 'session-1'
      store.activeSession = session

      chatApi.sessionCommandHandlers[0]({
        event: 'session.command',
        session_id: 'session-1',
        command: 'goal',
        action: 'resume',
        message: 'Goal resumed',
        started: true,
        terminal: false,
      })

      const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
      handlers.onRunStarted({ event: 'run.started', session_id: 'session-1' })
      handlers.onReasoningDelta({ event: 'reasoning.delta', session_id: 'session-1', delta: 'thinking text' })
      expect(session.liveTps).toBeNull()
      vi.setSystemTime(3_000)
      handlers.onReasoningDelta({ event: 'reasoning.delta', session_id: 'session-1', delta: 'more thinking text' })

      expect(session.liveTps).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles approval events for resumed runs and clears stale approvals on completion', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })

    const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
    expect(handlers?.onApprovalRequested).toEqual(expect.any(Function))
    expect(handlers?.onApprovalResolved).toEqual(expect.any(Function))

    handlers.onApprovalRequested({
      event: 'approval.requested',
      session_id: 'session-1',
      approval_id: 'approval-1',
      command: 'rm -rf /tmp/smoke',
      description: 'delete in root path',
      choices: ['deny'],
      timeout_ms: 300000,
    })

    expect(store.activePendingApproval?.approvalId).toBe('approval-1')
    expect(store.activePendingApproval?.timeoutMs).toBe(300000)

    handlers.onRunCompleted({
      event: 'run.completed',
      session_id: 'session-1',
      queue_remaining: 0,
      output: 'done',
    })

    expect(store.activePendingApproval).toBeNull()
  })

  it('clears stale approvals when a resumed run fails', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })

    const handlers = chatApi.registerSessionHandlers.mock.calls[0]?.[1]
    handlers.onApprovalRequested({
      event: 'approval.requested',
      session_id: 'session-1',
      approval_id: 'approval-1',
      command: 'rm -rf /tmp/smoke',
      description: 'delete in root path',
      choices: ['deny'],
    })

    expect(store.activePendingApproval?.approvalId).toBe('approval-1')

    handlers.onRunFailed({
      event: 'run.failed',
      session_id: 'session-1',
      queue_remaining: 0,
      error: 'failed',
    })

    expect(store.activePendingApproval).toBeNull()
  })

  it('does not clear the transcript for goal done commands', () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [
      { id: 'user-1', role: 'user', content: 'keep me', timestamp: 1 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'clear',
      message: 'Goal cleared.',
      terminal: true,
    })

    expect(store.messages).toEqual([
      expect.objectContaining({ id: 'user-1', content: 'keep me' }),
      expect.objectContaining({
        role: 'command',
        content: 'Goal cleared.',
        commandAction: 'clear',
      }),
    ])
  })

  it('renders background command status as system so current assistant targeting survives', () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [
      { id: 'user-1', role: 'user', content: 'foreground task', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'working...', timestamp: 2, isStreaming: true },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'background',
      action: 'background',
      message: 'Background task started in session bg_test.',
      backgroundSessionId: 'bg_test',
      prompt: 'summarize docs',
      terminal: true,
    })

    expect(store.sessions[0].messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'summarize docs',
      }),
    ])
    expect(chatApi.registerSessionHandlers).toHaveBeenCalledWith('bg_test', expect.objectContaining({
      onRunStarted: expect.any(Function),
      onMessageDelta: expect.any(Function),
    }))
    expect(store.messages.at(-1)).toEqual(expect.objectContaining({
      role: 'system',
      content: 'Background task started in session bg_test.',
      commandAction: 'background',
    }))
    expect(store.sessions[0].messages.some(message => message.role === 'command' && message.commandAction === 'background')).toBe(false)
  })

  it('renders /btw as a prompt bubble plus a separate ephemeral result', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'btw',
      action: 'btw',
      sideQuestionId: 'btw_test',
      prompt: 'quick check',
      started: true,
      terminal: false,
    })
    session.messages.push({ id: 'foreground-assistant', role: 'assistant', content: 'foreground still running', timestamp: 2, isStreaming: true })
    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'btw',
      action: 'btw',
      sideQuestionId: 'btw_test',
      prompt: 'quick check',
      delta: 'answer',
      terminal: false,
    })
    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'btw',
      action: 'btw',
      sideQuestionId: 'btw_test',
      prompt: 'quick check',
      output: 'answer',
      done: true,
      terminal: true,
    })

    expect(store.sessions.some(item => item.id.startsWith('bg_'))).toBe(false)
    expect(chatApi.registerSessionHandlers).not.toHaveBeenCalled()
    expect(store.isStreaming).toBe(false)
    expect(store.messages).toEqual([
      expect.objectContaining({
        id: 'btw-btw_test',
        role: 'assistant',
        content: '',
        isStreaming: false,
        commandAction: 'btw',
        commandData: expect.objectContaining({ prompt: 'quick check' }),
      }),
      expect.objectContaining({
        id: 'btw-result-btw_test',
        role: 'assistant',
        content: 'answer',
        isStreaming: false,
        commandAction: 'btw_result',
        commandData: expect.objectContaining({ prompt: 'quick check' }),
      }),
      expect.objectContaining({
        id: 'foreground-assistant',
        role: 'assistant',
        content: 'foreground still running',
      }),
    ])
  })

  it('dismisses ephemeral /btw bubbles and drops them when leaving the session', async () => {
    const store = useChatStore()
    const session = makeSession()
    const otherSession: Session = { ...makeSession(), id: 'session-2', title: 'other' }
    store.sessions = [session, otherSession]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    chatApi.resumeSession.mockImplementation((sessionId: string, callback: (data: any) => void) => {
      callback({ session_id: sessionId, messages: [], isWorking: false })
    })

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'btw',
      action: 'btw',
      sideQuestionId: 'btw_test',
      prompt: 'quick check',
      output: 'answer',
      done: true,
      terminal: true,
    })

    expect(store.messages).toHaveLength(2)
    store.dismissBtwMessage('btw-result-btw_test')
    expect(store.messages).toHaveLength(0)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'btw',
      action: 'btw',
      sideQuestionId: 'btw_again',
      output: 'temporary answer',
      done: true,
      terminal: true,
    })
    expect(session.messages.some(message => String(message.commandAction || '').startsWith('btw'))).toBe(true)

    await store.switchSession('session-2')
    expect(session.messages.some(message => String(message.commandAction || '').startsWith('btw'))).toBe(false)
    await store.switchSession('session-1')
    expect(store.messages.some(message => String(message.commandAction || '').startsWith('btw'))).toBe(false)
  })

  it('sends /btw out-of-band while the foreground session is active', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      started: true,
      terminal: false,
    })
    session.messages = []

    await store.sendMessage('/btw another check')

    expect(chatApi.connectEmit).toHaveBeenCalledTimes(1)
    expect(chatApi.connectEmit).toHaveBeenNthCalledWith(1, 'run', expect.objectContaining({
      session_id: 'session-1',
      input: '/btw another check',
      source: 'cli',
    }))
    expect(store.messages).toEqual([])
    expect(store.isStreaming).toBe(true)
  })

  it('updates session title from the global generated-title event', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    expect(chatApi.sessionTitleUpdatedHandlers).toHaveLength(1)

    chatApi.sessionTitleUpdatedHandlers[0]({
      event: 'session.title.updated',
      session_id: 'session-1',
      title: 'Generated Title',
    })

    expect(store.sessions[0].title).toBe('Generated Title')
    expect(store.activeSession?.title).toBe('Generated Title')
  })

  it('does not show a thinking/streaming state while submitting terminal fork commands', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messageCount = 2
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Previous question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Previous answer', timestamp: 2 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/fork')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledWith(
      expect.objectContaining({ input: '/fork', session_id: 'session-1', source: 'cli' }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Object),
    )
    expect(store.isStreaming).toBe(false)
  })

  it('debounces terminal fork commands until the session.command settles', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messageCount = 2
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Previous question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Previous answer', timestamp: 2 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/fork')
    await store.sendMessage('/fork')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(store.isStreaming).toBe(false)
    expect(store.isForkPending).toBe(true)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'fork',
      action: 'branch',
      ok: false,
      message: 'Cannot branch: no conversation messages found to copy.',
      terminal: true,
    })

    expect(store.isForkPending).toBe(false)
  })

  it('clears stale working state when terminal session commands complete', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })
    expect(store.isStreaming).toBe(true)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'done',
      message: 'Goal done.',
      terminal: true,
    })

    expect(store.isStreaming).toBe(false)
  })

  it('settles stale runtime tool rows when terminal session commands complete', () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [
      { id: 'tool-1', role: 'tool', content: '', timestamp: 1, toolName: 'shell', toolStatus: 'running' },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'status',
      action: 'status',
      message: 'Status: idle',
      terminal: true,
    })

    expect(store.messages[0]).toEqual(expect.objectContaining({
      role: 'tool',
      toolName: 'shell',
      toolStatus: 'done',
    }))
    expect(store.isStreaming).toBe(false)
  })

  it('settles stale runtime tool rows before sending an idle slash command', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messages = [
      { id: 'tool-1', role: 'tool', content: '', timestamp: 1, toolName: 'weather', toolStatus: 'running' },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/status')

    expect(store.messages[0]).toEqual(expect.objectContaining({
      role: 'tool',
      toolName: 'weather',
      toolStatus: 'done',
    }))
    expect(store.messages[1]).toEqual(expect.objectContaining({
      role: 'command',
      content: '/status',
    }))
  })

  it('adds peer command messages to the transcript even after the session command marks the run live', () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers.forEach(handler => handler({
      event: 'session.command',
      session_id: 'session-1',
      command: 'moa',
      action: 'moa',
      message: 'MoA one-shot queued with preset default.',
      started: true,
      terminal: false,
    }))
    chatApi.peerUserMessageHandlers.forEach(handler => handler({
      event: 'run.peer_user_message',
      session_id: 'session-1',
      message: {
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        timestamp: 2,
      },
    }))

    expect(store.queuedUserMessages.get('session-1')).toBeUndefined()
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'command',
        content: 'MoA one-shot queued with preset default.',
        commandAction: 'moa',
      }),
      expect.objectContaining({
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        queued: false,
      }),
    ])
  })

  it('moves an existing peer command queue entry into the transcript when the command starts', () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers.forEach(handler => handler({
      event: 'session.command',
      session_id: 'session-1',
      action: 'moa',
      started: true,
      terminal: false,
    }))
    chatApi.registerSessionHandlers.mock.calls.at(-1)?.[1]?.onRunQueued?.({
      event: 'run.queued',
      session_id: 'session-1',
      queue_length: 1,
      queued_messages: [
        { id: 'queue-moa', role: 'command', content: '/moa test', timestamp: 2, queued: true },
      ],
    })

    chatApi.peerUserMessageHandlers.forEach(handler => handler({
      event: 'run.peer_user_message',
      session_id: 'session-1',
      message: {
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        timestamp: 3,
      },
    }))

    expect(store.queuedUserMessages.get('session-1')).toBeUndefined()
    expect(store.messages).toEqual([
      expect.objectContaining({
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        queued: false,
      }),
    ])
  })

  it('adds and switches to a branched child session from session.command branch events', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.resumeSession.mockImplementationOnce((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [
          { id: 1, role: 'user', content: 'Previous question', timestamp: 1 },
          { id: 2, role: 'assistant', content: 'Previous answer', timestamp: 2 },
        ],
        parentSessionId: 'session-1',
        forkPointMessageId: '2',
        parentTitle: 'session',
        parentLastMessage: 'Previous answer',
        parentLastMessageRole: 'assistant',
        messageLoadedCount: 2,
        messageTotal: 2,
        hasMoreBefore: false,
        isWorking: false,
        events: [],
        queueLength: 0,
      })
      return {} as any
    })

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'fork',
      action: 'branch',
      ok: true,
      parentSessionId: 'session-1',
      newSessionId: 'branch-1',
      newSessionTitle: 'Side path',
      branchSession: {
        id: 'branch-1',
        profile: 'default',
        source: 'cli',
        title: 'Side path',
        model: 'openai/gpt-5.4',
        provider: 'openai-codex',
        parentSessionId: 'session-1',
        forkPointMessageId: '2',
        parentTitle: 'session',
        parentLastMessage: 'Previous answer',
        parentLastMessageRole: 'assistant',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        messageCount: 2,
        workspace: '/repo',
      },
      message: 'Branched session "Side path" from session-1.',
    })
    await Promise.resolve()

    const branch = store.sessions.find((item: Session) => item.id === 'branch-1')
    expect(branch).toMatchObject({
      title: 'Side path',
      source: 'cli',
      profile: 'default',
      model: 'openai/gpt-5.4',
      provider: 'openai-codex',
      parentSessionId: 'session-1',
      forkPointMessageId: '2',
      parentTitle: 'session',
      parentLastMessage: 'Previous answer',
      parentLastMessageRole: 'assistant',
      messageCount: 2,
      workspace: '/repo',
    })
    expect(store.activeSessionId).toBe('branch-1')
    expect(chatApi.resumeSession).toHaveBeenCalledWith('branch-1', expect.any(Function), 'default', 'chat-run')

    await store.switchSession('session-1')
    expect(store.activeSessionId).toBe('session-1')
    expect(store.activeSession?.id).toBe('session-1')
    expect(store.sessions.find((item: Session) => item.id === 'session-1')?.messages.at(-1)).toMatchObject({
      role: 'command',
      commandAction: 'branch',
      content: 'Branched session "Side path" from session-1.',
    })

    await store.switchSession('branch-1')
    expect(store.activeSessionId).toBe('branch-1')
    expect(store.activeSession?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Previous question' }),
      expect.objectContaining({ role: 'assistant', content: 'Previous answer' }),
    ])
  })
})
