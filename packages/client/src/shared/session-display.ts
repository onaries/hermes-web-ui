const SOURCE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  api_server: 'API Server',
  cli: 'CLI',
  coding_agent: 'Coding Agent',
  global_agent: 'Global Agent',
  discord: 'Discord',
  slack: 'Slack',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: 'Email',
  sms: 'SMS',
  dingtalk: 'DingTalk',
  feishu: 'Feishu',
  wecom: 'WeCom',
  weixin: 'WeChat',
  bluebubbles: 'iMessage',
  mattermost: 'Mattermost',
  cron: 'Cron',
}

export type SessionAgentKind = 'codex' | 'ekko-agent' | 'claude-code' | 'hermes'

export interface SessionAgentLike {
  source?: string | null
  agent?: string | null
  codingAgentId?: string | null
}

export interface SessionAgentGroup<T extends SessionAgentLike> {
  kind: SessionAgentKind
  labelKey: string
  sessions: T[]
}

export const SESSION_AGENT_GROUP_ORDER: readonly SessionAgentKind[] = ['codex', 'ekko-agent', 'claude-code', 'hermes']

const SESSION_AGENT_GROUP_LABEL_KEYS: Record<SessionAgentKind, string> = {
  codex: 'chat.agentGroups.codex',
  'ekko-agent': 'chat.agentGroups.ekkoAgent',
  'claude-code': 'chat.agentGroups.claudeCode',
  hermes: 'chat.agentGroups.hermes',
}

const SESSION_AGENT_LOGOS: Record<SessionAgentKind, { label: string; src: string }> = {
  codex: { label: 'Codex', src: '/coding-agents/codex-openai.png' },
  'ekko-agent': { label: 'Ekko Agent', src: '/coding-agents/ekko-agent.png' },
  'claude-code': { label: 'Claude Code', src: '/coding-agents/claude-code.svg' },
  hermes: { label: 'Hermes', src: '/coding-agents/hermes.png' },
}

export function getSourceLabel(source?: string): string {
  if (!source) return ''
  return SOURCE_LABELS[source] || source
}

export function getSessionAgentKind(session: SessionAgentLike): SessionAgentKind {
  if (session.source === 'coding_agent') {
    if (session.codingAgentId === 'codex' || session.agent === 'codex') return 'codex'
    if (session.codingAgentId === 'ekko-agent' || session.agent === 'ekko-agent') return 'ekko-agent'
    return 'claude-code'
  }
  return 'hermes'
}

export function getSessionAgentLogo(session: SessionAgentLike): { label: string; src: string } {
  return SESSION_AGENT_LOGOS[getSessionAgentKind(session)]
}

export function groupSessionsByAgent<T extends SessionAgentLike>(sessions: T[]): SessionAgentGroup<T>[] {
  const buckets = new Map<SessionAgentKind, T[]>(SESSION_AGENT_GROUP_ORDER.map(kind => [kind, []]))
  for (const session of sessions) {
    buckets.get(getSessionAgentKind(session))?.push(session)
  }
  return SESSION_AGENT_GROUP_ORDER.flatMap(kind => {
    const groupSessions = buckets.get(kind) || []
    if (groupSessions.length === 0) return []
    return [{ kind, labelKey: SESSION_AGENT_GROUP_LABEL_KEYS[kind], sessions: groupSessions }]
  })
}

export function formatTimestampMs(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function formatTimestampSeconds(timestamp: number): string {
  return formatTimestampMs(timestamp * 1000)
}
