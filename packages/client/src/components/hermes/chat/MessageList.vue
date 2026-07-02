<script lang="ts">
type SessionScrollSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  wasNearBottom: boolean;
}

type BottomScrollOptions = number | {
  frames?: number;
  keepAliveMs?: number;
}

const sessionScrollPositions = new Map<string, SessionScrollSnapshot>();
</script>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import VirtualMessageList from "./VirtualMessageList.vue";
import MessageItem from "./MessageItem.vue";
import TodoPanel from "./TodoPanel.vue";
import ToolTraceGroup from "./ToolTraceGroup.vue";
import { useChatStore, type Message } from "@/stores/hermes/chat";
import { useSettingsStore } from "@/stores/hermes/settings";
import {
  extractUnifiedDiffPayload,
  handleCodeBlockCopyClick,
  inferStructuredLanguage,
  renderHighlightedCodeBlock,
} from "./highlight";
import {
  groupToolTraceMessages,
  isToolTraceGroup,
  type ToolTraceDisplayItem,
} from "@/utils/tool-aggregate-summary";
import thinkingImageLight from "@/assets/thinking-light.gif";
import thinkingImageDark from "@/assets/thinking-dark.gif";
import { useTheme } from "@/composables/useTheme";
import { useToolTraceVisibility } from "@/composables/useToolTraceVisibility";

const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const { t } = useI18n();
const { isDark } = useTheme();
const { toolTraceVisible } = useToolTraceVisibility();
const isMobileViewport = ref(
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 768px)').matches
    : false,
);
let mobileViewportQuery: MediaQueryList | null = null;
const showToolMascotLegacy = computed(() => settingsStore.display.show_tool_mascot !== false);
const showToolMascotDesktop = computed(() => settingsStore.display.show_tool_mascot_desktop ?? showToolMascotLegacy.value);
const showToolMascotMobile = computed(() => settingsStore.display.show_tool_mascot_mobile ?? showToolMascotLegacy.value);
const showToolMascot = computed(() => isMobileViewport.value ? showToolMascotMobile.value : showToolMascotDesktop.value);
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null);
const pendingInitialScrollSessionId = ref<string | null>(null);
const showScrollBottomButton = ref(false);
const initialBottomScrollOptions = { frames: 8, keepAliveMs: 1200 };
const LIVE_CHAT_MAX_LOADED_MESSAGES = 300;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatToolDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${mins}m ${secs}s`
}

type ToolCallLike = {
  id?: string
  toolName?: string
  toolPreview?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolDuration?: number
  toolStatus?: string
  timestamp?: number
}

function parseToolArgs(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return trimmed
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function rawString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstRawString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = rawString(record[key])
    if (value) return value
  }
  return ''
}

function fileChangePreview(args: Record<string, unknown>): string {
  const summary = firstRawString(args, ['summary'])
  if (summary) return summary
  const changes = Array.isArray(args.changes) ? args.changes : []
  return changes
    .map((change) => {
      if (!isRecord(change)) return ''
      return [firstRawString(change, ['action', 'kind', 'change', 'status']), firstRawString(change, ['path', 'file', 'file_path', 'filePath'])]
        .filter(Boolean)
        .join(' ')
    })
    .filter(Boolean)
    .join(', ')
}

function usesArgsOnlyLivePreview(toolName: string | undefined): boolean {
  const name = (toolName || '').toLowerCase()
  return name.includes('terminal') || name === 'command'
}

function fullToolPreview(tool: ToolCallLike): string {
  const name = (tool.toolName || '').toLowerCase()
  const args = parseToolArgs(tool.toolArgs)
  if (isRecord(args)) {
    if (name.includes('read_file') || name.includes('write_file') || name.includes('patch')) {
      return firstRawString(args, ['path']) || tool.toolPreview || ''
    }
    if (name.includes('skill_view')) {
      return firstRawString(args, ['name']) || tool.toolPreview || ''
    }
    if (name.includes('terminal') || name === 'command') {
      return firstRawString(args, ['command', 'cmd']) || ''
    }
    if (name.includes('web_search')) {
      return firstRawString(args, ['query']) || tool.toolPreview || ''
    }
    if (name.includes('file change') || name.includes('file_change')) {
      return fileChangePreview(args) || tool.toolPreview || ''
    }
    if (name.includes('search_files')) {
      return [firstRawString(args, ['pattern']), firstRawString(args, ['path'])]
        .filter(Boolean)
        .join(' ')
        || tool.toolPreview
        || ''
    }
  }
  return usesArgsOnlyLivePreview(tool.toolName) ? '' : tool.toolPreview || ''
}

function toolCallPreview(tool: ToolCallLike): string {
  const fullPreview = fullToolPreview(tool)
  if (usesArgsOnlyLivePreview(tool.toolName)) return fullPreview
  return tool.toolPreview || fullPreview
}

function hasToolDuration(tool: ToolCallLike): boolean {
  return typeof tool.toolDuration === 'number' && Number.isFinite(tool.toolDuration) && tool.toolDuration >= 0
}

function toolDurationSeconds(tool: ToolCallLike): number {
  return hasToolDuration(tool) ? tool.toolDuration! : 0
}

function shouldShowToolDuration(tool: ToolCallLike): boolean {
  return tool.toolStatus !== 'running' && (hasToolDuration(tool) || tool.toolStatus === 'done' || tool.toolStatus === 'error')
}

function toolCallTitle(tool: ToolCallLike): string {
  const parts = [tool.toolName, fullToolPreview(tool)]
  if (isPatchTool(tool)) parts.push(t('chat.patchChanges'))
  if (shouldShowToolDuration(tool)) parts.push(formatToolDuration(toolDurationSeconds(tool)))
  if (tool.toolStatus === 'done') parts.push('✓')
  if (tool.toolStatus === 'error') parts.push('✕')
  return parts.filter(Boolean).join(' ')
}

const expandedPatchToolIds = ref<Set<string>>(new Set());
const autoExpandPatchToolDetails = computed(() => settingsStore.display.auto_open_patch_drawer === true);
const autoExpandSeenCompletedPatchToolIds = ref<Set<string>>(new Set());
const autoExpandPatchToolDetailsInitialized = ref(false);

function isPatchTool(tool: ToolCallLike): boolean {
  const name = (tool.toolName || '').toLowerCase();
  return name === 'patch' || name.endsWith('.patch') || name.endsWith('_patch') || name.includes('functions.patch');
}

function togglePatchToolDetails(tool: Message): void {
  if (!isPatchTool(tool)) return;
  const nextIds = new Set(expandedPatchToolIds.value);
  if (nextIds.has(tool.id)) nextIds.delete(tool.id);
  else nextIds.add(tool.id);
  expandedPatchToolIds.value = nextIds;
}

function isPatchToolExpanded(tool: Message): boolean {
  return expandedPatchToolIds.value.has(tool.id);
}

function seedCompletedPatchToolIds(tools: ToolCallLike[]): void {
  const nextIds = new Set(autoExpandSeenCompletedPatchToolIds.value);
  tools.forEach((tool) => {
    if (tool.id && isPatchTool(tool) && tool.toolStatus === 'done') {
      nextIds.add(tool.id);
    }
  });
  autoExpandSeenCompletedPatchToolIds.value = nextIds;
}

function autoExpandCompletedPatchTools(tools: ToolCallLike[]): void {
  const seenIds = new Set(autoExpandSeenCompletedPatchToolIds.value);
  const expandedIds = new Set(expandedPatchToolIds.value);
  let changed = false;

  tools.forEach((tool) => {
    if (!tool.id || !isPatchTool(tool) || tool.toolStatus !== 'done') return;
    if (seenIds.has(tool.id)) return;
    seenIds.add(tool.id);
    expandedIds.add(tool.id);
    changed = true;
  });

  if (changed) {
    autoExpandSeenCompletedPatchToolIds.value = seenIds;
    expandedPatchToolIds.value = expandedIds;
  } else if (seenIds.size !== autoExpandSeenCompletedPatchToolIds.value.size) {
    autoExpandSeenCompletedPatchToolIds.value = seenIds;
  }
}

function normalizePayloadText(raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'string') return raw;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized !== undefined) return serialized;
  } catch {}
  return String(raw);
}

function parsePayloadJson(raw: unknown): unknown | null {
  const text = normalizePayloadText(raw).trim();
  if (!text || !/^[{[]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractDiffPayload(raw: unknown): string {
  const parsed = parsePayloadJson(raw);
  if (parsed) {
    const extracted = extractUnifiedDiffPayload(parsed);
    if (extracted) return extracted;
  }
  const text = normalizePayloadText(raw).trim();
  if (text && inferStructuredLanguage(text) === 'diff') return text;
  return '';
}

function buildPatchArgsPreview(tool: ToolCallLike): string {
  const args = parseToolArgs(tool.toolArgs);
  if (!isRecord(args)) return '';
  const patchText = firstRawString(args, ['patch']);
  if (patchText) return patchText;
  const oldString = firstRawString(args, ['old_string']);
  const newString = firstRawString(args, ['new_string']);
  if (!oldString && !newString) return '';
  const path = firstRawString(args, ['path']);
  const lines = [
    path ? `*** Update File: ${path}` : '*** Update File',
    '@@',
    ...oldString.split(/\r?\n/).map((line) => `-${line}`),
    ...newString.split(/\r?\n/).map((line) => `+${line}`),
  ];
  return lines.join('\n');
}

function livePatchDiff(tool: ToolCallLike): string {
  return extractDiffPayload(tool.toolResult) || buildPatchArgsPreview(tool);
}

function renderedLivePatchDiff(tool: ToolCallLike): string {
  const diff = livePatchDiff(tool);
  if (!diff) return '';
  return renderHighlightedCodeBlock(diff, 'diff', t('common.copy'), {
    maxHighlightLength: 20_000,
    formatDiffFoldLabel: (hiddenCount) => t('chat.unchangedLines', { count: hiddenCount }),
  });
}

async function handleLivePatchDetailClick(event: MouseEvent): Promise<void> {
  await handleCodeBlockCopyClick(event);
}

const currentToolCalls = computed(() => {
  const msgs = chatStore.messages;
  // Slash commands are also user input boundaries for the live tool strip.
  let lastInputIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user" || msgs[i].role === "command") {
      lastInputIdx = i;
      break;
    }
  }
  // Only tool calls after the last user input, newest on top.
  const tools = msgs.filter((m, i) => m.role === "tool" && i > lastInputIdx);
  return [...tools].reverse();
});

const visibleToolCalls = computed(() =>
  currentToolCalls.value.filter((tool) => !!tool.toolName),
);
const hasActiveLivePresentation = computed(() => (
  chatStore.isStreaming || !!chatStore.compressionState || !!chatStore.abortState
));
const liveToolCalls = computed(() => {
  // The floating/loading tool panel belongs only to the active live run. When a
  // completed/restored transcript still has a stale `running` placeholder (for
  // example a terminal tool without a persisted result row), keep that trace in
  // the transcript but do not keep animating it as current work.
  if (!hasActiveLivePresentation.value) return [];

  // While a run is active, keep completed tool rows visible as settled progress
  // instead of disappearing mid-run. Row-level loading affordances are already
  // gated on `toolStatus === "running"`, so completed terminal tools stay visible
  // without a spinner/badge until the whole run settles.
  return visibleToolCalls.value;
});
watch(
  () => chatStore.activeSessionId,
  () => {
    expandedPatchToolIds.value = new Set();
    autoExpandSeenCompletedPatchToolIds.value = new Set();
    autoExpandPatchToolDetailsInitialized.value = false;
    seedCompletedPatchToolIds(liveToolCalls.value);
  },
);

watch(
  [liveToolCalls, autoExpandPatchToolDetails, () => chatStore.isLoadingMessages],
  ([tools, enabled, isLoadingMessages]) => {
    if (!autoExpandPatchToolDetailsInitialized.value || !enabled || isLoadingMessages) {
      seedCompletedPatchToolIds(tools);
      autoExpandPatchToolDetailsInitialized.value = true;
      return;
    }
    autoExpandCompletedPatchTools(tools);
  },
  { immediate: true },
);

const enteringToolCallIds = ref<Set<string>>(new Set());
const enteringToolCallTimers = new Map<string, number>();

function markToolCallEntering(id: string) {
  window.clearTimeout(enteringToolCallTimers.get(id));
  enteringToolCallIds.value = new Set(enteringToolCallIds.value).add(id);
  enteringToolCallTimers.set(id, window.setTimeout(() => {
    enteringToolCallTimers.delete(id);
    const nextIds = new Set(enteringToolCallIds.value);
    nextIds.delete(id);
    enteringToolCallIds.value = nextIds;
  }, 900));
}

function isToolCallEntering(tool: Message): boolean {
  // Keep the stronger highlight for tools that are visibly running.
  // Fast tool calls often arrive already completed; highlighting those after they
  // are done creates a noisy flash as the success icon appears at the same time.
  return enteringToolCallIds.value.has(tool.id) && tool.toolStatus === "running";
}

watch(
  () => liveToolCalls.value.map((tool) => tool.id),
  (toolIds, previousToolIds = []) => {
    const previousIds = new Set(previousToolIds);
    for (const id of toolIds) {
      if (!previousIds.has(id)) markToolCallEntering(id);
    }
    const currentIds = new Set(toolIds);
    const expandedIds = new Set(expandedPatchToolIds.value);
    for (const id of expandedIds) {
      if (!currentIds.has(id)) expandedIds.delete(id);
    }
    if (expandedIds.size !== expandedPatchToolIds.value.size) {
      expandedPatchToolIds.value = expandedIds;
    }
  },
);

const emptyState = computed(() => {
  const session = chatStore.activeSession;
  const codingAgentId = session?.codingAgentId || (session?.agent === "codex" ? "codex" : session?.agent === "claude" ? "claude-code" : undefined);
  if (codingAgentId === "codex") {
    return {
      logo: "/coding-agents/codex-openai.png",
      alt: "Codex",
      text: t("chat.emptyStateAgent", { agent: "Codex" }),
    };
  }
  if (codingAgentId === "claude-code") {
    return {
      logo: "/coding-agents/claude-code.svg",
      alt: "Claude Code",
      text: t("chat.emptyStateAgent", { agent: "Claude Code" }),
    };
  }
  return {
    logo: "/logo.png",
    alt: "Hermes",
    text: t("chat.emptyState"),
  };
});

const displayMessages = computed<ToolTraceDisplayItem[]>(() => {
  const currentToolIds = new Set(currentToolCalls.value.map((tool) => tool.id));
  const visibleMessages: Message[] = chatStore.messages.filter((m) => {
    if (m.role === "tool") {
      return toolTraceVisible.value && !!m.toolName && !(chatStore.isRunActive && currentToolIds.has(m.id));
    }
    if (
      m.role === "assistant" &&
      m.isStreaming &&
      !m.content?.trim() &&
      !!m.reasoning?.trim() &&
      currentToolCalls.value.length === 0
    ) {
      return false;
    }
    return true;
  });
  return groupToolTraceMessages(visibleMessages);
});

function forkDividerId(sessionId: string): string {
  return `fork-divider-${sessionId}`;
}

const displayMessagesWithForkDivider = computed<ToolTraceDisplayItem[]>(() => {
  const messages = displayMessages.value;
  const lineage = forkLineage.value;
  const session = chatStore.activeSession;
  if (!lineage || !session?.forkPointMessageId) return messages;

  const forkPoint = String(session.forkPointMessageId);
  const index = messages.findIndex((message) => String(message.id) === forkPoint);
  if (index < 0) return messages;

  const divider: Message = {
    id: forkDividerId(session.id),
    role: "system",
    content: "",
    timestamp: session.updatedAt || Date.now(),
    systemType: "fork-divider",
  };
  return [
    ...messages.slice(0, index + 1),
    divider,
    ...messages.slice(index + 1),
  ];
});

const canForkActiveSession = computed(() => {
  const session = chatStore.activeSession;
  const hasConversation = displayMessages.value.some((message) => message.role === "user" || message.role === "assistant");
  return !!session && session.source !== "coding_agent" && !chatStore.isStreaming && !chatStore.isForkPending && hasConversation;
});

const lastForkActionMessageId = computed(() => {
  const messages = displayMessagesWithForkDivider.value;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" || message.role === "assistant") return message.id;
  }
  return null;
});

const queuedMessages = computed(() => {
  const sid = chatStore.activeSessionId;
  if (!sid) return [];
  return chatStore.queuedUserMessages.get(sid) || [];
});
const editingQueuedMessageId = ref<string | null>(null);
const editingQueuedMessageDraft = ref("");
const visibleApproval = computed(() => chatStore.activePendingApproval);
const visibleClarify = computed(() => chatStore.activePendingClarify);
const hasFloatingPrompt = computed(() => !!visibleApproval.value || !!visibleClarify.value);
const virtualListPadding = computed(() => {
  if (queuedMessages.value.length > 0 && hasFloatingPrompt.value) return "20px 20px 380px";
  if (queuedMessages.value.length > 0 || hasFloatingPrompt.value) return "20px 20px 260px";
  return "20px";
});

const showHistoryArchiveLink = computed(() => {
  const session = chatStore.activeSession;
  return !!session?.hasMoreBefore && (session.loadedMessageCount || 0) >= LIVE_CHAT_MAX_LOADED_MESSAGES;
});

const historyArchiveHref = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.id) return "#/hermes/history";
  const profileQuery = session.profile ? `?profile=${encodeURIComponent(session.profile)}` : "";
  return `#/hermes/history/session/${encodeURIComponent(session.id)}${profileQuery}`;
});

const forkLineage = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.parentSessionId) return null;
  return {
    parentSessionId: session.parentSessionId,
    parentTitle: session.parentTitle || session.parentSessionId,
    parentHref: `#/hermes/history/session/${encodeURIComponent(session.parentSessionId)}${session.profile ? `?profile=${encodeURIComponent(session.profile)}` : ""}`,
    canSwitchParent: chatStore.sessions.some((item) => item.id === session.parentSessionId),
    lastRole: session.parentLastMessageRole || "",
    lastMessage: session.parentLastMessage || "",
  };
});

async function openForkParent(event?: MouseEvent) {
  const lineage = forkLineage.value;
  if (!lineage?.parentSessionId) return;
  if (lineage.canSwitchParent) {
    event?.preventDefault();
    await chatStore.switchSession(lineage.parentSessionId);
    return;
  }
  window.location.hash = lineage.parentHref.replace(/^#/, "");
}

function removeQueuedMessage(messageId: string) {
  const sid = chatStore.activeSessionId;
  if (!sid) return;
  chatStore.removeQueuedMessage(sid, messageId);
  if (editingQueuedMessageId.value === messageId) cancelQueuedEdit();
}

function startQueuedEdit(message: Message) {
  editingQueuedMessageId.value = message.id;
  editingQueuedMessageDraft.value = message.content;
}

function cancelQueuedEdit() {
  editingQueuedMessageId.value = null;
  editingQueuedMessageDraft.value = "";
}

function saveQueuedEdit(messageId: string) {
  const sid = chatStore.activeSessionId;
  const nextContent = editingQueuedMessageDraft.value.trim();
  if (!sid || !nextContent) return;
  chatStore.editQueuedMessage(sid, messageId, nextContent);
  cancelQueuedEdit();
}

function shouldAutoFollowBottom(threshold = 100): boolean {
  return listRef.value?.shouldAutoFollowBottom(threshold) ?? true;
}

function scrollToBottom(options?: BottomScrollOptions) {
  listRef.value?.scrollToBottom(options);
  showScrollBottomButton.value = false;
}

function scrollToMessage(messageId: string) {
  listRef.value?.scrollToMessage(messageId);
}

function scrollToAnchor(messageId: string, anchorId: string) {
  listRef.value?.scrollToAnchor(messageId, anchorId);
}

function updateScrollBottomButton() {
  const isNearBottom = typeof listRef.value?.isNearBottom === 'function'
    ? listRef.value.isNearBottom(1000)
    : true;
  showScrollBottomButton.value = displayMessages.value.length > 0 && !isNearBottom;
}

function handleListScroll() {
  updateScrollBottomButton();
}

function handleScrollBottomClick() {
  scrollToBottom({ frames: 4, keepAliveMs: 600 });
}

function saveSessionScrollPosition(sessionId: string | null | undefined) {
  if (!sessionId) return;
  const snapshot = listRef.value?.captureViewportPosition() ?? null;
  if (snapshot) sessionScrollPositions.set(sessionId, snapshot);
}

function applyInitialSessionScroll(sessionId: string) {
  if (chatStore.activeSessionId !== sessionId) return;
  if (chatStore.focusMessageId) {
    pendingInitialScrollSessionId.value = null;
    scrollToMessage(chatStore.focusMessageId);
    return;
  }

  const snapshot = sessionScrollPositions.get(sessionId);
  if (snapshot) {
    pendingInitialScrollSessionId.value = null;
    if (snapshot.wasNearBottom) {
      scrollToBottom(initialBottomScrollOptions);
    } else {
      listRef.value?.restoreViewportPosition(snapshot);
    }
    return;
  }

  const session = chatStore.activeSession;
  if (session?.parentSessionId && session.forkPointMessageId) {
    const dividerId = forkDividerId(session.id);
    const hasDivider = displayMessagesWithForkDivider.value.some((message) => message.id === dividerId);
    if (hasDivider) {
      pendingInitialScrollSessionId.value = null;
      scrollToMessage(dividerId);
      return;
    }
    if (chatStore.isLoadingMessages || chatStore.messages.length === 0) return;
  }

  scrollToBottom(initialBottomScrollOptions);
  if (chatStore.messages.length > 0 && !chatStore.isLoadingMessages) {
    pendingInitialScrollSessionId.value = null;
  }
}

async function handleTopReach() {
  const session = chatStore.activeSession;
  if (!session?.hasMoreBefore || session.isLoadingOlderMessages || showHistoryArchiveLink.value) return;
  const snapshot = listRef.value?.captureScrollPosition() ?? null;
  const loaded = await chatStore.loadOlderMessages(session.id);
  if (!loaded) return;
  await nextTick();
  listRef.value?.restoreScrollPosition(snapshot);
  updateScrollBottomButton();
}

watch(
  () => chatStore.activeSessionId,
  async (id, previousId) => {
    saveSessionScrollPosition(previousId);
    if (!id) return;
    pendingInitialScrollSessionId.value = id;
    await nextTick();
    applyInitialSessionScroll(id);
  },
  { immediate: true },
);

watch(
  () => [chatStore.activeSessionId, chatStore.messages.length] as const,
  ([id, length]) => {
    if (!id || pendingInitialScrollSessionId.value !== id || length === 0) return;
    applyInitialSessionScroll(id);
    void nextTick(updateScrollBottomButton);
  },
  { flush: "post" },
);

watch(
  () => displayMessages.value.length,
  () => {
    void nextTick(updateScrollBottomButton);
  },
  { flush: "post" },
);

watch(
  () => chatStore.isLoadingMessages,
  async (isLoading, wasLoading) => {
    if (isLoading || !wasLoading) return;
    const id = chatStore.activeSessionId;
    if (!id || pendingInitialScrollSessionId.value !== id) return;
    if (chatStore.focusMessageId) {
      pendingInitialScrollSessionId.value = null;
      return;
    }
    await nextTick();
    if (chatStore.activeSessionId !== id) return;
    applyInitialSessionScroll(id);
  },
  { flush: "post" },
);

watch(
  () => chatStore.focusMessageId,
  (messageId) => {
    if (!messageId) return;
    scrollToMessage(messageId);
  },
);

// When a run starts (user just sent a message), always scroll to bottom once
watch(
  () => chatStore.isRunActive,
  (v) => {
    if (v) scrollToBottom({ frames: 3, keepAliveMs: 400 });
  },
);

// During streaming, only auto-scroll if the user is already near the bottom
watch(
  () => chatStore.messages[chatStore.messages.length - 1]?.content,
  () => {
    if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
    if (chatStore.focusMessageId) {
      scrollToMessage(chatStore.focusMessageId);
      return;
    }
    if (!shouldAutoFollowBottom()) return;
    scrollToBottom({ frames: 1, keepAliveMs: 0 });
  },
);
watch(currentToolCalls, () => {
  if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
  if (chatStore.focusMessageId) {
    scrollToMessage(chatStore.focusMessageId);
    return;
  }
  if (!shouldAutoFollowBottom()) return;
  scrollToBottom({ frames: 1, keepAliveMs: 0 });
});

watch(
  () => queuedMessages.value.length,
  async (length, previousLength) => {
    if (pendingInitialScrollSessionId.value === chatStore.activeSessionId) return;
    if (chatStore.focusMessageId) return;
    if (length <= previousLength) return;
    const wasNearBottom = shouldAutoFollowBottom(320);
    await nextTick();
    if (!wasNearBottom && !chatStore.isRunActive) return;
    scrollToBottom({ frames: 4, keepAliveMs: 600 });
  },
);

function updateMobileViewport(event?: MediaQueryListEvent | MediaQueryList) {
  isMobileViewport.value = Boolean(event?.matches ?? mobileViewportQuery?.matches ?? false);
}

onBeforeUnmount(() => {
  saveSessionScrollPosition(chatStore.activeSessionId);
  if (mobileViewportQuery) {
    mobileViewportQuery.removeEventListener?.('change', updateMobileViewport);
  }
  for (const timer of enteringToolCallTimers.values()) {
    window.clearTimeout(timer);
  }
  enteringToolCallTimers.clear();
});

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mobileViewportQuery = window.matchMedia('(max-width: 768px)');
    updateMobileViewport(mobileViewportQuery);
    mobileViewportQuery.addEventListener?.('change', updateMobileViewport);
  }
  void nextTick(updateScrollBottomButton);
});

defineExpose({
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
});
</script>

<template>
  <div class="message-list-shell">
    <VirtualMessageList
      :key="chatStore.activeSessionId || 'chat-empty'"
      ref="listRef"
      :messages="displayMessagesWithForkDivider"
      :virtualized="false"
      :padding="virtualListPadding"
      @scroll="handleListScroll"
      @top-reach="handleTopReach"
    >
      <template #empty>
        <div class="empty-state">
          <img :src="emptyState.logo" :alt="emptyState.alt" class="empty-logo" />
          <p>{{ emptyState.text }}</p>
        </div>
      </template>
      <template #before>
        <div v-if="showHistoryArchiveLink" class="history-archive-link-wrap">
          <a class="history-archive-link" :href="historyArchiveHref">
            {{ t("chat.viewOlderInHistory") }}
          </a>
        </div>
        <div
          v-else-if="chatStore.activeSession?.hasMoreBefore || chatStore.activeSession?.isLoadingOlderMessages"
          class="history-loader"
        >
          <span v-if="chatStore.activeSession?.isLoadingOlderMessages" class="history-loader-spinner"></span>
        </div>
      </template>
      <template #item="{ message: msg }">
        <ToolTraceGroup
          v-if="isToolTraceGroup(msg)"
          :id="msg.id"
          :tools="msg.tools"
          :highlight="chatStore.focusMessageId === msg.id"
        />
        <div v-else-if="msg.systemType === 'fork-divider' && forkLineage" class="fork-divider" role="separator">
          <div class="fork-divider-line" aria-hidden="true"></div>
          <div class="fork-divider-pill">
            <span class="fork-divider-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M6 3v6a4 4 0 0 0 4 4h4.2" />
                <path d="M18 9l4 4-4 4" />
                <path d="M6 21V3" />
                <circle cx="6" cy="5" r="2" />
                <circle cx="6" cy="19" r="2" />
              </svg>
            </span>
            <span class="fork-divider-text">{{ t("chat.forkedFrom") }}</span>
            <a class="fork-divider-link" :href="forkLineage.parentHref" @click="openForkParent">
              {{ forkLineage.parentTitle }}
            </a>
          </div>
          <div class="fork-divider-line" aria-hidden="true"></div>
        </div>
        <MessageItem
          v-else
          :message="msg"
          :highlight="chatStore.focusMessageId === msg.id"
          :show-fork-action="canForkActiveSession && msg.id === lastForkActionMessageId"
        />
      </template>
      <template #after>
        <Transition name="fade">
        <div
          v-if="chatStore.isRunActive || chatStore.abortState"
          class="streaming-indicator"
          :class="{ 'streaming-indicator--no-mascot': !showToolMascot }"
        >
          <img
            v-if="showToolMascot"
            :src="isDark ? thinkingImageDark : thinkingImageLight"
            alt=""
            aria-hidden="true"
            class="thinking-video"
          >
          <div v-if="liveToolCalls.length > 0 || chatStore.compressionState || chatStore.abortState" class="tool-calls-panel">
            <!-- Abort indicator -->
            <div v-if="chatStore.abortState" class="tool-call-item compression-item">
              <svg
                v-if="chatStore.abortState.aborting"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M10 9v6m4-6v6M5 5h14v14H5z" />
              </svg>
              <svg
                v-else
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
              <span class="tool-call-name">
                {{
                  chatStore.abortState.aborting
                    ? chatStore.abortState.timedOut
                      ? (chatStore.abortState.message || 'Still stopping... new messages will be queued')
                      : 'Pausing... waiting for the run to stop and sync'
                    : chatStore.abortState.synced
                      ? 'Paused and synced'
                      : 'Paused'
                }}
              </span>
              <span
                v-if="chatStore.abortState.aborting"
                class="tool-call-spinner"
              ></span>
            </div>
            <!-- Compression indicator -->
            <div v-if="chatStore.compressionState" class="tool-call-item compression-item">
              <svg
                v-if="chatStore.compressionState.compressing"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <svg
                v-else-if="chatStore.compressionState.compressed"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                class="tool-call-icon"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
              <span class="tool-call-name">
                {{
                  chatStore.compressionState.compressing
                    ? `Compressing... (${chatStore.compressionState.messageCount} msgs, ~${formatTokens(chatStore.compressionState.beforeTokens)} tokens)`
                    : chatStore.compressionState.compressed
                      ? `Compressed ${chatStore.compressionState.messageCount} msgs: ~${formatTokens(chatStore.compressionState.beforeTokens)} → ~${formatTokens(chatStore.compressionState.afterTokens)} tokens`
                      : `Compression skipped`
                }}
              </span>
              <span
                v-if="chatStore.compressionState.compressing"
                class="tool-call-spinner"
              ></span>
            </div>
            <!-- Tool calls -->
            <TransitionGroup name="tool-call-list" tag="div" class="tool-call-list">
              <div
                v-for="tc in liveToolCalls"
                :key="tc.id"
                class="tool-call-entry"
              >
                <div
                  class="tool-call-item"
                  :class="{
                    'tool-call-item--entering': isToolCallEntering(tc),
                    'tool-call-item--running': tc.toolStatus === 'running',
                    'tool-call-item--done': tc.toolStatus === 'done',
                    'tool-call-item--error': tc.toolStatus === 'error',
                    'tool-call-item--expandable': isPatchTool(tc),
                    'tool-call-item--expanded': isPatchToolExpanded(tc),
                  }"
                  :title="toolCallTitle(tc)"
                  :role="isPatchTool(tc) ? 'button' : undefined"
                  :tabindex="isPatchTool(tc) ? 0 : undefined"
                  :aria-expanded="isPatchTool(tc) ? isPatchToolExpanded(tc) : undefined"
                  @click="togglePatchToolDetails(tc)"
                  @keydown.enter.prevent="togglePatchToolDetails(tc)"
                  @keydown.space.prevent="togglePatchToolDetails(tc)"
                >
                  <svg
                    v-if="isPatchTool(tc)"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="tool-call-chevron"
                    :class="{ rotated: isPatchToolExpanded(tc) }"
                    aria-hidden="true"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    class="tool-call-icon"
                  >
                    <path
                      d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
                    />
                  </svg>
                  <span class="tool-call-name">{{ tc.toolName }}</span>
                  <span v-if="toolCallPreview(tc)" class="tool-call-preview">{{
                    toolCallPreview(tc)
                  }}</span>
                  <span
                    v-if="shouldShowToolDuration(tc)"
                    class="tool-call-duration"
                    :title="t('chat.executionDuration')"
                  >{{ formatToolDuration(toolDurationSeconds(tc)) }}</span
                  >
                  <svg
                    v-if="tc.toolStatus === 'done'"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    class="tool-call-success-icon"
                  >
                    <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15"/>
                    <path
                      d="M8 12L11 15L16 9"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      fill="none"
                    />
                  </svg>
                  <span
                    v-if="tc.toolStatus === 'running'"
                    class="tool-call-spinner"
                  ></span>
                  <svg
                    v-if="tc.toolStatus === 'error'"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    class="tool-call-error-icon"
                  >
                    <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.15"/>
                    <path
                      d="M15 9L9 15M9 9L15 15"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      fill="none"
                    />
                  </svg>
                </div>
                <div
                  v-if="isPatchToolExpanded(tc) && livePatchDiff(tc)"
                  class="tool-call-patch-details"
                  @click.stop="handleLivePatchDetailClick"
                >
                  <div class="tool-call-patch-label">{{ t('chat.patchChanges') }}</div>
                  <div class="tool-call-patch-code" v-html="renderedLivePatchDiff(tc)"></div>
                </div>
              </div>
            </TransitionGroup>
          </div>
        </div>
        </Transition>
        <TodoPanel />
      </template>
    </VirtualMessageList>
    <button
      v-if="showScrollBottomButton"
      type="button"
      class="scroll-bottom-button"
      :aria-label="t('chat.scrollToBottom')"
      :title="t('chat.scrollToBottom')"
      @click="handleScrollBottomClick"
    >
      <svg
        class="scroll-bottom-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m7 10 5 5 5-5" />
        <path d="M6 19h12" />
      </svg>
    </button>
    <div
      v-if="queuedMessages.length > 0"
      class="message-float-stack"
    >
      <Transition name="queue-float">
        <div v-if="queuedMessages.length > 0" class="queue-float-panel">
          <div class="queue-float-header">
            <span class="queue-orbit" aria-hidden="true">
              <span></span>
            </span>
            <span>{{ t('chat.messageQueue') }}</span>
            <strong>{{ queuedMessages.length }}</strong>
          </div>
          <div class="queue-float-list">
            <div
              v-for="(message, index) in queuedMessages"
              :key="message.id"
              class="queue-float-item"
              :class="{ editing: editingQueuedMessageId === message.id }"
            >
              <span class="queue-index">{{ index + 1 }}</span>
              <template v-if="editingQueuedMessageId === message.id">
                <textarea
                  v-model="editingQueuedMessageDraft"
                  class="queue-edit-input"
                  rows="3"
                  @keydown.esc.prevent="cancelQueuedEdit"
                  @keydown.meta.enter.prevent="saveQueuedEdit(message.id)"
                  @keydown.ctrl.enter.prevent="saveQueuedEdit(message.id)"
                />
                <div class="queue-edit-actions">
                  <button
                    type="button"
                    class="queue-action queue-save"
                    :title="t('common.save')"
                    :disabled="!editingQueuedMessageDraft.trim()"
                    @click="saveQueuedEdit(message.id)"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="queue-action"
                    :title="t('common.cancel')"
                    @click="cancelQueuedEdit"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </template>
              <template v-else>
                <span class="queue-text" :title="message.content">{{ message.content }}</span>
                <button
                  type="button"
                  class="queue-action queue-edit"
                  :title="t('common.edit')"
                  @click="startQueuedEdit(message)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              </template>
              <button
                v-if="editingQueuedMessageId !== message.id"
                type="button"
                class="queue-remove"
                :title="t('chat.removeQueuedMessage')"
                @click="removeQueuedMessage(message.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.message-list-shell {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

.message-float-stack {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 8;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(720px, calc(100% - 32px));
  pointer-events: none;
}

.scroll-bottom-button {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 7;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
  background: rgba(255, 255, 255, 0.94);
  color: var(--accent-primary);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  padding: 0;
  cursor: pointer;

  .dark & {
    background: rgba(38, 38, 38, 0.94);
  }
}

.scroll-bottom-button:hover {
  background: rgba(var(--accent-primary-rgb), 0.1);
}

.scroll-bottom-icon {
  width: 19px;
  height: 19px;
}

.history-archive-link-wrap {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.history-archive-link {
  font-size: 12px;
  color: var(--accent-primary);
  text-decoration: none;
}

.history-archive-link:hover {
  text-decoration: underline;
}

.approval-float-panel,
.queue-float-panel {
  pointer-events: auto;
  width: 100%;
  padding: 10px;
  border: 1px solid rgba(var(--accent-info-rgb), 0.22);
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(14px);

  .dark & {
    background: #262626;
  }
}

.approval-float-panel {
  border-color: rgba(var(--accent-primary-rgb), 0.24);
}

.queue-float-panel {
  align-self: flex-end;
  width: min(460px, 100%);
}

.float-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: var(--accent-primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.approval-float-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.12);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
}

.approval-float-title {
  padding: 0 4px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: $text-primary;
}

.approval-float-desc {
  padding: 0 4px;
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-secondary;
}

.approval-float-command {
  display: block;
  margin: 8px 4px 0;
  max-height: 96px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: $text-primary;
  background: rgba(255, 255, 255, 0.68);
  border: 1px solid $border-color;
  border-radius: 11px;
  padding: 8px 10px;

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.approval-float-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;
}

.clarify-float-input-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding: 10px 4px 0;
  border-top: 1px solid $border-color;

  :deep(.n-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  :deep(.n-button) {
    flex: 0 0 auto;
  }
}

.queue-float-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 8px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;

  strong {
    margin-left: auto;
    min-width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: rgba(var(--accent-info-rgb), 0.16);
    color: var(--accent-info);
  }
}

.queue-orbit {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid rgba(var(--accent-info-rgb), 0.28);
  position: relative;
  animation: queue-spin 1.6s linear infinite;

  span {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    right: -2px;
    top: 5px;
    background: var(--accent-info);
    box-shadow: 0 0 12px rgba(var(--accent-info-rgb), 0.65);
  }
}

.queue-float-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 172px;
  overflow-y: auto;
}

.queue-float-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-height: 34px;
  padding: 7px 8px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.68);
  color: $text-primary;

  &.editing {
    align-items: stretch;
  }

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.queue-index {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--accent-info);
  background: rgba(var(--accent-info-rgb), 0.12);
}

.queue-text {
  min-width: 0;
  flex: 1;
  max-height: 96px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.45;
}

.queue-edit-input {
  flex: 1;
  min-width: 0;
  max-height: 160px;
  resize: vertical;
  overflow: auto;
  border: 1px solid rgba(var(--accent-info-rgb), 0.28);
  border-radius: 9px;
  padding: 7px 9px;
  color: $text-primary;
  background: rgba(255, 255, 255, 0.72);
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  outline: none;

  &:focus {
    border-color: rgba(var(--accent-info-rgb), 0.56);
    box-shadow: 0 0 0 2px rgba(var(--accent-info-rgb), 0.12);
  }

  .dark & {
    background: rgba(255, 255, 255, 0.08);
  }
}

.queue-edit-actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue-action,
.queue-remove {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  background: transparent;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    color: var(--accent-info);
    background: rgba(var(--accent-info-rgb), 0.1);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.queue-remove:hover {
  color: $error;
  background: rgba($error, 0.1);
}

.queue-save:hover:not(:disabled) {
  color: $success;
  background: rgba($success, 0.1);
}

@media (max-width: 640px) {
  .message-float-stack {
    left: 8px;
    right: 8px;
    bottom: 8px;
    width: auto;
    gap: 8px;
  }

  .approval-float-panel,
  .queue-float-panel {
    padding: 7px;
    border-radius: 14px;
  }

  .queue-float-header {
    padding: 0 2px;
    font-size: 11px;

    span:nth-child(2) {
      display: none;
    }
  }

  .queue-orbit {
    width: 16px;
    height: 16px;

    span {
      width: 5px;
      height: 5px;
      top: 5px;
    }
  }

  .queue-float-list {
    margin-top: 6px;
    max-height: min(220px, 34dvh);
    overflow-y: auto;
  }

  .queue-float-item {
    min-height: 30px;
    padding: 5px 6px;
  }

  .queue-index {
    width: 18px;
    height: 18px;
    border-radius: 6px;
    font-size: 10px;
  }

  .queue-text {
    font-size: 11px;
  }

  .queue-remove {
    width: 22px;
    height: 22px;
  }

  .approval-float-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));

    :deep(.n-button) {
      width: 100%;
    }
  }

  .clarify-float-input-row {
    flex-direction: column;

    :deep(.n-button) {
      width: 100%;
    }
  }
}

@keyframes queue-spin {
  to {
    transform: rotate(360deg);
  }
}

.queue-float-enter-active,
.queue-float-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.queue-float-enter-from,
.queue-float-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  gap: 12px;

  .empty-logo {
    width: 48px;
    height: 48px;
    opacity: 0.25;
  }

  p {
    font-size: 14px;
  }
}

.history-loader {
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.history-loader-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.16);
  border-top-color: $accent-primary;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;

  .dark & {
    border-color: rgba(255, 255, 255, 0.18);
    border-top-color: $accent-primary;
  }
}

.history-archive-link-wrap {
  display: flex;
  justify-content: center;
  padding-bottom: 8px;
}

.history-archive-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  min-height: 28px;
  padding: 5px 10px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: var(--accent-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  text-decoration: none;
  white-space: normal;
  text-align: center;
}

.history-archive-link:hover {
  background: rgba(var(--accent-primary-rgb), 0.14);
}

 .fork-divider {
  display: grid;
  grid-template-columns: minmax(24px, 1fr) auto minmax(24px, 1fr);
  align-items: center;
  gap: 12px;
  width: min(760px, 100%);
  margin: 12px auto 18px;
  color: var(--text-secondary);
}

.fork-divider-line {
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-primary-rgb), 0.26), transparent);
}

.fork-divider-pill {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  max-width: min(560px, calc(100vw - 56px));
  padding: 7px 12px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.22);
  border-radius: 999px;
  background: var(--bg-card);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
  font-size: 12px;
  line-height: 1.35;
}

.fork-divider-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--accent-primary);
  flex: 0 0 auto;
}

.fork-divider-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.fork-divider-text {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.fork-divider-link {
  overflow: hidden;
  max-width: 220px;
  color: var(--text-primary);
  font-weight: 700;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fork-divider-link:hover {
  color: var(--accent-primary);
  text-decoration: underline;
}


@media (max-width: 640px) {
  .fork-divider {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .fork-divider-line {
    display: none;
  }
}


.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.streaming-indicator {
  --tool-mascot-height: 213px;

  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 4px;
  .thinking-video {
    width: 120px;
    height: var(--tool-mascot-height);
    border-radius: $radius-md;
    object-fit: contain;
    flex-shrink: 0;
  }

  &.streaming-indicator--no-mascot {
    min-height: var(--tool-mascot-height);
    gap: 10px;
    padding-left: 0;
  }

  &.streaming-indicator--no-mascot::before {
    content: '';
    align-self: stretch;
    flex: 0 0 4px;
    min-height: var(--tool-mascot-height);
    border-radius: 999px;
    background: linear-gradient(
      180deg,
      rgba(var(--accent-primary-rgb), 0.22),
      rgba(var(--accent-primary-rgb), 0.82),
      rgba(var(--accent-info-rgb), 0.38),
      rgba(var(--accent-primary-rgb), 0.22)
    );
    background-size: 100% 240%;
    box-shadow: 0 0 18px rgba(var(--accent-primary-rgb), 0.16);
    animation: hidden-mascot-activity-bar 5.6s ease-in-out infinite;
  }
}

@keyframes hidden-mascot-activity-bar {
  0%,
  100% {
    background-position: 50% 0%;
    box-shadow: 0 0 14px rgba(var(--accent-primary-rgb), 0.12);
    opacity: 0.66;
  }

  50% {
    background-position: 50% 100%;
    box-shadow: 0 0 22px rgba(var(--accent-primary-rgb), 0.24);
    opacity: 0.9;
  }
}

@media (prefers-reduced-motion: reduce) {
  .streaming-indicator.streaming-indicator--no-mascot::before {
    animation: none;
  }
}

.tool-calls-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 213px;
  overflow: hidden;
  padding-top: 4px;
}

.tool-calls-panel > .compression-item {
  flex: 0 0 auto;
}

.tool-call-list {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.tool-call-entry {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.tool-call-list-enter-active,
.tool-call-list-appear-active {
  animation: tool-call-row-enter 0.22s ease-out both;
}

.tool-call-list-leave-active {
  transition:
    opacity 0.24s ease,
    transform 0.24s cubic-bezier(0.16, 1, 0.3, 1),
    filter 0.24s ease;
}

.tool-call-list-enter-from,
.tool-call-list-appear-from {
  opacity: 0;
  transform: translateY(-3px);
}

.tool-call-list-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.985);
}

.tool-call-list-move {
  transition: transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

.tool-call-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: $text-secondary;
  padding: 3px 8px 3px 10px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: $radius-sm;
  border: 1px solid transparent;
  text-align: left;
  overflow: hidden;
  transition:
    background $transition-fast,
    border-color $transition-fast,
    box-shadow $transition-fast;

  .dark & {
    background: rgba(255, 255, 255, 0.06);
  }

  &.compression-item {
    color: $text-muted;
    font-size: 10px;

    .tool-call-name {
      flex: 1 1 auto;
      max-width: none;
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      overflow-wrap: anywhere;
    }
  }

  &.tool-call-item--entering {
    animation: tool-call-row-enter-highlight 0.9s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  &.tool-call-item--expandable {
    cursor: pointer;
  }

  &.tool-call-item--expanded,
  &.tool-call-item--expandable:focus-visible {
    border-color: rgba(var(--accent-primary-rgb), 0.24);
    box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.08) inset;
    outline: none;
  }

  &.tool-call-item--running {
    background: rgba(var(--accent-primary-rgb), 0.08);
    border-color: rgba(var(--accent-primary-rgb), 0.2);
    box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.04) inset;

    .tool-call-icon,
    .tool-call-name {
      color: $accent-primary;
    }

    &::before {
      content: '';
      position: absolute;
      top: 4px;
      bottom: 4px;
      left: 4px;
      width: 2px;
      border-radius: 999px;
      background: $accent-primary;
      animation: tool-running-pulse 1.15s ease-in-out infinite;
    }

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        100deg,
        transparent 0%,
        rgba(var(--accent-primary-rgb), 0.14) 45%,
        transparent 70%
      );
      transform: translateX(-120%);
      animation: tool-running-sweep 1.8s ease-in-out infinite;
    }
  }

  .tool-call-icon {
    flex-shrink: 0;
    color: $text-muted;
  }

  .tool-call-chevron {
    flex-shrink: 0;
    color: $text-muted;
    transition: transform 0.15s ease;

    &.rotated {
      transform: rotate(90deg);
    }
  }

  .tool-call-name {
    font-family: $font-code;
    flex-shrink: 0;
  }

  .tool-call-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
    color: $text-muted;
  }

  &:hover {
    align-items: flex-start;
  }

  &:hover .tool-call-preview {
    white-space: normal;
    overflow: visible;
    text-overflow: initial;
    max-width: min(760px, 72vw);
    overflow-wrap: anywhere;
    color: $text-secondary;
  }
}

.tool-call-patch-details {
  margin-left: 18px;
  border-left: 2px solid rgba(var(--accent-primary-rgb), 0.18);
  padding-left: 8px;
  max-width: min(760px, 74vw);
}

.tool-call-patch-label {
  margin-bottom: 3px;
  color: $text-muted;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.tool-call-patch-code {
  :deep(.hljs-code-block) {
    margin: 0;
  }

  :deep(.code-header) {
    background: rgba(0, 0, 0, 0.02);
  }

  :deep(code.hljs) {
    max-height: 240px;
    overflow: auto;
    font-size: 10.5px;
    white-space: pre;
  }
}

.tool-call-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid $text-muted;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

.tool-call-error-icon {
  color: #ff4d4f;
  flex-shrink: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tool-call-duration {
  font-size: 10px;
  color: $text-muted;
  font-family: $font-code;
  margin-left: 4px;
  flex-shrink: 0;
}

.tool-call-success-icon {
  color: #52c41a;
  flex-shrink: 0;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@keyframes tool-call-row-enter {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes tool-call-row-enter-highlight {
  0% {
    opacity: 0;
    filter: saturate(1.35);
    transform: translateY(-14px) scale(0.96);
    box-shadow:
      0 0 0 1px rgba(var(--accent-primary-rgb), 0.22) inset,
      0 12px 28px rgba(var(--accent-primary-rgb), 0.18);
  }
  45% {
    opacity: 1;
    filter: saturate(1.18);
    transform: translateY(0) scale(1.015);
    box-shadow:
      0 0 0 1px rgba(var(--accent-primary-rgb), 0.24) inset,
      0 8px 20px rgba(var(--accent-primary-rgb), 0.14);
  }
  100% {
    opacity: 1;
    filter: none;
    transform: translateY(0) scale(1);
    box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.04) inset;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes tool-running-pulse {
  0%, 100% {
    opacity: 0.45;
    transform: scaleY(0.7);
  }
  50% {
    opacity: 1;
    transform: scaleY(1);
  }
}

@keyframes tool-running-sweep {
  0% {
    transform: translateX(-120%);
  }
  55%, 100% {
    transform: translateX(120%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool-call-list-enter-active,
  .tool-call-list-appear-active,
  .tool-call-list-leave-active,
  .tool-call-list-move {
    transition: none;
    animation: none;
  }

  .tool-call-list-enter-from,
  .tool-call-list-appear-from,
  .tool-call-list-leave-to {
    opacity: 1;
    filter: none;
    transform: none;
  }

  .tool-call-item--entering,
  .tool-call-item--running::before,
  .tool-call-item--running::after,
  .tool-call-spinner {
    animation: none;
  }

  .tool-call-item--running::after {
    display: none;
  }
}
@media (max-width: 640px) {
  .tool-call-preview {
    width: 100%;
    max-width: none;
  }
}
</style>
