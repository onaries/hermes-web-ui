<script setup lang="ts">
import { renameSession, setSessionWorkspace, batchDeleteSessions, exportSession } from "@/api/hermes/sessions";
import type { AvailableModelGroup } from "@/api/hermes/system";
import { fetchCodingAgentsStatus, inferCodingAgentApiMode, normalizeCodingAgentApiMode, type CodingAgentApiMode, type CodingAgentId } from "@/api/coding-agents";
import { useChatStore, type Session } from "@/stores/hermes/chat";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import { useSettingsStore } from "@/stores/hermes/settings";
import { useArtifactsStore, type ArtifactFileReference } from "@/stores/hermes/artifacts";
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NInput,
  NModal,
  NSelect,
  NTooltip,
  NPopconfirm,
  NRadioButton,
  NRadioGroup,
  useMessage,
  type DropdownOption,
} from "naive-ui";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/utils/clipboard";
import { sortSessionsWithInProgressFirst } from "@/utils/session-sort";
import { groupSessionsByAgent, type SessionAgentKind } from "@/shared/session-display";
import {
  drawerButtonAnchorY,
  loadDrawerButtonPosition,
  saveDrawerButtonPosition,
  snapDrawerButtonPosition,
  type DrawerButtonPosition,
} from "@/utils/drawer-button-position";
import { extractGeneratedMessageArtifacts } from "@/utils/chat-artifact-references";
import FolderPicker from "./FolderPicker.vue";
import ChatInput from "./ChatInput.vue";
import ConversationMonitorPane from "./ConversationMonitorPane.vue";
import MessageList from "./MessageList.vue";
import SessionListItem from "./SessionListItem.vue";
import DrawerPanel from "./DrawerPanel.vue";
import OutlinePanel from "./OutlinePanel.vue";
import SettingsCircuitBadge from "@/components/layout/SettingsCircuitBadge.vue";

const chatStore = useChatStore();
const appStore = useAppStore();
const profilesStore = useProfilesStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const settingsStore = useSettingsStore();
const artifactsStore = useArtifactsStore();
const router = useRouter();
const message = useMessage();
const { t } = useI18n();

const showDrawer = ref(false);
const drawerActiveTab = ref<"terminal" | "files" | "artifacts" | "gitDiff">("files");
const chatPanelRef = ref<HTMLElement | null>(null);
const drawerButtonPosition = ref<DrawerButtonPosition>(
  loadDrawerButtonPosition(typeof window !== "undefined" ? window.localStorage : null),
);
const drawerButtonDragY = ref<number | null>(null);
const isDrawerButtonDragging = ref(false);
let drawerButtonPointerId: number | null = null;
let drawerButtonStartY = 0;
let suppressNextDrawerButtonClick = false;
const showOutline = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);
const chatInputRef = ref<(InstanceType<typeof ChatInput> & { addFiles?: (files: File[] | FileList) => void }) | null>(null);
const isFileDragOverChat = ref(false);
let chatFileDragDepth = 0;
const SESSION_AGENT_GROUP_COLLAPSE_STORAGE_KEY = "hermes_chat_session_agent_group_collapsed";

function loadCollapsedSessionAgentGroups(): Set<SessionAgentKind> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_AGENT_GROUP_COLLAPSE_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is SessionAgentKind =>
      value === "codex" || value === "claude-code" || value === "hermes",
    ));
  } catch {
    return new Set();
  }
}

const collapsedSessionAgentGroups = ref<Set<SessionAgentKind>>(loadCollapsedSessionAgentGroups());

function saveCollapsedSessionAgentGroups(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SESSION_AGENT_GROUP_COLLAPSE_STORAGE_KEY,
    JSON.stringify([...collapsedSessionAgentGroups.value]),
  );
}

function isSessionAgentGroupCollapsed(kind: SessionAgentKind): boolean {
  return collapsedSessionAgentGroups.value.has(kind);
}

function toggleSessionAgentGroup(kind: SessionAgentKind): void {
  const next = new Set(collapsedSessionAgentGroups.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  collapsedSessionAgentGroups.value = next;
  saveCollapsedSessionAgentGroups();
}

watch(() => artifactsStore.openSequence, (openSequence) => {
  if (openSequence <= 0) return;
  drawerActiveTab.value = "artifacts";
  showDrawer.value = true;
});

const currentMode = ref<"chat" | "live">("chat");

// Batch selection mode
const isBatchMode = ref(false);
const selectedSessionKeys = ref<Set<string>>(new Set());
const showBatchDeleteConfirm = ref(false);
const isBatchDeleting = ref(false);

// Initialize synchronously from the media query so first paint is correct.
// On narrow viewports the session list is an absolute-positioned overlay
// (z-index 10) on top of the chat area; if we default to `true`, onMounted
// only flips it to `false` AFTER the first render, causing a visible flash
// where the session list covers the chat content ("auto-fixes after a
// moment" — that was the race).
const showSessions = ref(
  typeof window === "undefined" ||
    !window.matchMedia("(max-width: 768px)").matches,
);
let mobileQuery: MediaQueryList | null = null;
let approvalCountdownTimer: number | null = null;
const isMobile = ref(false);
const approvalNow = ref(Date.now());
const browserNotificationPermission = ref<NotificationPermission | 'unsupported'>(
  typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported",
);
const notifiedApprovalIds = new Set<string>();
const notifiedClarifyIds = new Set<string>();
const notifiedCompletionIds = new Set<string>();
const showDrawerRainbow = computed(() => settingsStore.display.show_drawer_rainbow !== false);
const isDrawerPinned = computed(() => settingsStore.display.pin_right_drawer === true);
const drawerShown = computed({
  get: () => showDrawer.value || (isDrawerPinned.value && !isMobile.value),
  set: (value: boolean) => {
    showDrawer.value = value;
  },
});

const drawerButtonStyle = computed(() => {
  if (drawerButtonDragY.value != null) {
    return { top: `${drawerButtonDragY.value}px` };
  }
  if (drawerButtonPosition.value === "top") return { top: "88px" };
  if (drawerButtonPosition.value === "bottom") return { top: "calc(100% - 96px)" };
  return { top: "50%" };
});

function chatPanelHeight(): number {
  return chatPanelRef.value?.getBoundingClientRect().height || window.innerHeight || 0;
}

function setDrawerButtonPosition(position: DrawerButtonPosition): void {
  drawerButtonPosition.value = position;
  saveDrawerButtonPosition(typeof window !== "undefined" ? window.localStorage : null, position);
}

function cleanupDrawerButtonDrag(): void {
  document.removeEventListener("pointermove", handleDrawerButtonPointerMove);
  document.removeEventListener("pointerup", handleDrawerButtonPointerUp);
  document.body.classList.remove("drawer-button-dragging-body");
  drawerButtonPointerId = null;
  drawerButtonDragY.value = null;
  isDrawerButtonDragging.value = false;
}

function handleDrawerButtonPointerDown(event: PointerEvent): void {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const rect = chatPanelRef.value?.getBoundingClientRect();
  if (!rect) return;
  drawerButtonPointerId = event.pointerId;
  drawerButtonStartY = event.clientY;
  drawerButtonDragY.value = drawerButtonAnchorY(drawerButtonPosition.value, rect.height);
  isDrawerButtonDragging.value = false;
  document.body.classList.add("drawer-button-dragging-body");
  document.addEventListener("pointermove", handleDrawerButtonPointerMove);
  document.addEventListener("pointerup", handleDrawerButtonPointerUp);
}

function handleDrawerButtonPointerMove(event: PointerEvent): void {
  if (drawerButtonPointerId !== event.pointerId) return;
  const rect = chatPanelRef.value?.getBoundingClientRect();
  if (!rect) return;
  const y = Math.min(rect.height - 24, Math.max(24, event.clientY - rect.top));
  drawerButtonDragY.value = y;
  if (Math.abs(event.clientY - drawerButtonStartY) > 4) {
    isDrawerButtonDragging.value = true;
  }
  event.preventDefault();
}

function handleDrawerButtonPointerUp(event: PointerEvent): void {
  if (drawerButtonPointerId !== event.pointerId) return;
  const wasDragging = isDrawerButtonDragging.value;
  const y = drawerButtonDragY.value;
  if (wasDragging && y != null) {
    setDrawerButtonPosition(snapDrawerButtonPosition(y, chatPanelHeight()));
    suppressNextDrawerButtonClick = true;
    window.setTimeout(() => {
      suppressNextDrawerButtonClick = false;
    }, 0);
  }
  cleanupDrawerButtonDrag();
}

function handleDrawerButtonClick(): void {
  if (suppressNextDrawerButtonClick) return;
  showDrawer.value = true;
}

async function handleDrawerPinnedChange(value: boolean): Promise<void> {
  settingsStore.updateLocal('display', { pin_right_drawer: value });
  showDrawer.value = value;
  try {
    await settingsStore.saveSection('display', { pin_right_drawer: value });
  } catch (error) {
    settingsStore.updateLocal('display', { pin_right_drawer: !value });
    showDrawer.value = !value;
    message.error(t('settings.saveFailed'));
  }
}

function nudgeDrawerButtonPosition(direction: "up" | "down"): void {
  const order: DrawerButtonPosition[] = ["top", "middle", "bottom"];
  const currentIndex = order.indexOf(drawerButtonPosition.value);
  const nextIndex = direction === "up"
    ? Math.max(0, currentIndex - 1)
    : Math.min(order.length - 1, currentIndex + 1);
  setDrawerButtonPosition(order[nextIndex]);
}

const activeChatArtifactFiles = computed<ArtifactFileReference[]>(() => {
  const messages = chatStore.activeSession?.messages || chatStore.messages || [];
  const workspace = chatStore.activeSession?.workspace || null;
  const refs: ArtifactFileReference[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    for (const file of extractGeneratedMessageArtifacts(messages[i], workspace)) {
      refs.push(file);
    }
  }
  return refs;
});

watch(
  [() => chatStore.activeSessionId, activeChatArtifactFiles],
  ([sessionId, files]) => {
    artifactsStore.syncChatFileArtifacts(sessionId, files);
  },
  { immediate: true },
);

function sessionRouteName() {
  return chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session";
}

function sessionHref(sessionId: string) {
  return router.resolve({
    name: sessionRouteName(),
    params: { sessionId },
  }).href;
}

function openSettingsPage() {
  router.push({ name: "hermes.settings" });
}

function openSessionInNewTab(sessionId: string) {
  if (typeof window === "undefined") return;
  window.open(sessionHref(sessionId), "_blank", "noopener,noreferrer");
}

function handleOutlineNavigate(target: { messageId: string; anchorId: string }) {
  messageListRef.value?.scrollToAnchor(target.messageId, target.anchorId);
}


async function handleSessionClick(sessionId: string) {
  if (chatStore.activeSessionId !== sessionId) {
    await chatStore.switchSession(sessionId);
  }
  await router.push({
    name: sessionRouteName(),
    params: { sessionId },
  });
  if (mobileQuery?.matches) showSessions.value = false;
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches;
  if (e.matches && showSessions.value) {
    showSessions.value = false;
  }
}

function syncBrowserNotificationPermission() {
  browserNotificationPermission.value =
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

async function requestBrowserNotifications() {
  if (typeof window === "undefined" || !("Notification" in window)) {
    browserNotificationPermission.value = "unsupported";
    message.warning(t("chat.browserNotificationsUnsupported"));
    return false;
  }

  if (Notification.permission === "granted") {
    browserNotificationPermission.value = "granted";
    message.success(t("chat.browserNotificationsEnabled"));
    return true;
  }

  const permission = await Notification.requestPermission();
  browserNotificationPermission.value = permission;
  if (permission === "granted") {
    message.success(t("chat.browserNotificationsEnabled"));
    return true;
  }
  return false;
}

async function showBrowserNotification(title: string, body: string, tag: string, requireInteraction = true) {
  if (typeof window === "undefined" || !("Notification" in window)) return;

  if (Notification.permission === "default") {
    await requestBrowserNotifications();
  } else {
    syncBrowserNotificationPermission();
  }

  if (Notification.permission !== "granted") return;

  const notification = new Notification(title, {
    body,
    tag,
    requireInteraction,
  });
  notification.onclick = () => {
    const desktop = (window as typeof window & { hermesDesktop?: { showWindow?: () => Promise<void> } }).hermesDesktop;
    if (desktop?.showWindow) {
      void desktop.showWindow();
    } else {
      window.focus();
    }
    notification.close();
  };
}

function buildNotificationBody(primary: string, fallback: string) {
  const text = primary.trim() || fallback;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

onMounted(() => {
  syncBrowserNotificationPermission();
  mobileQuery = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mobileQuery);
  mobileQuery.addEventListener("change", handleMobileChange);
  if (profilesStore.profiles.length === 0) {
    void profilesStore.fetchProfiles();
  }
  approvalCountdownTimer = window.setInterval(() => {
    approvalNow.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  cleanupDrawerButtonDrag();
  mobileQuery?.removeEventListener("change", handleMobileChange);
  if (approvalCountdownTimer !== null) {
    window.clearInterval(approvalCountdownTimer);
    approvalCountdownTimer = null;
  }
});
const showRenameModal = ref(false);
const renameValue = ref("");
const renameSessionId = ref<string | null>(null);
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null);
const sessionProfileFilter = computed(() => chatStore.sessionProfileFilter);
const profileFilterOptions = computed(() => [
  { label: t("chat.allProfiles"), value: "__all__" },
  ...profilesStore.profiles.map((profile) => ({
    label: profile.name,
    value: profile.name,
  })),
]);

async function handleProfileFilterChange(value: string) {
  chatStore.sessionProfileFilter = value === "__all__" ? null : value;
  await chatStore.loadSessions(chatStore.sessionProfileFilter);
}

function sortSessionsForSidebar(items: Session[]): Session[] {
  return sortSessionsWithInProgressFirst(items, chatStore.isSessionLive);
}

const pinnedSessions = computed(() =>
  sortSessionsForSidebar(
    chatStore.sessions.filter((session) =>
      sessionBrowserPrefsStore.isPinned(session.id),
    ),
  ),
);

const unpinnedSessions = computed(() =>
  sortSessionsForSidebar(
    chatStore.sessions.filter(
      (session) => !sessionBrowserPrefsStore.isPinned(session.id),
    ),
  ),
);

const unpinnedSessionGroups = computed(() => groupSessionsByAgent(unpinnedSessions.value));

watch(
  () => [
    chatStore.sessionsLoaded,
    ...chatStore.sessions.map((session) => session.id),
  ],
  (value) => {
    const sessionIds = value.slice(1) as string[];
    if (!value[0] || sessionIds.length === 0) return;
    sessionBrowserPrefsStore.pruneMissingSessions(sessionIds);
  },
  { immediate: true },
);

const activeSessionTitle = computed(
  () => chatStore.activeSession?.title || t("chat.newChat"),
);

const activeSessionModelLabel = computed(() => {
  const session = chatStore.activeSession;
  if (!session?.model) return t("models.selectModel");
  return appStore.displayModelName(session.model, session.provider);
});

const headerTitle = computed(() =>
  currentMode.value === "live"
    ? t("chat.liveSessions")
    : activeSessionTitle.value,
);
const activeWorkspace = computed(() => chatStore.activeSession?.workspace || "");
const activeWorkspaceLabel = computed(() => {
  const workspace = activeWorkspace.value;
  if (!workspace) return "";
  return workspace.split(/[\\/]/).filter(Boolean).pop() || workspace;
});

const activeApproval = computed(() => chatStore.activePendingApproval);
const visibleApproval = computed(() => activeApproval.value);
const approvalRemainingMs = computed(() => {
  const approval = visibleApproval.value;
  if (!approval) return 0;
  return Math.max(0, approval.requestedAt + approval.timeoutMs - approvalNow.value);
});
const approvalCountdownText = computed(() => {
  if (!visibleApproval.value) return "";
  const seconds = Math.ceil(approvalRemainingMs.value / 1000);
  if (seconds <= 0) return t("chat.approvalExpired");
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = seconds % 60;
  const time = `${minutesPart}:${String(secondsPart).padStart(2, "0")}`;
  return t("chat.approvalExpiresIn", { time });
});

const activeClarify = computed(() => chatStore.activePendingClarify);
const visibleClarify = computed(() => activeClarify.value);
const clarifyRemainingMs = computed(() => {
  const clarify = visibleClarify.value;
  if (!clarify) return 0;
  return Math.max(0, clarify.requestedAt + clarify.timeoutMs - approvalNow.value);
});
const clarifyCountdownText = computed(() => {
  if (!visibleClarify.value) return "";
  const seconds = Math.ceil(clarifyRemainingMs.value / 1000);
  if (seconds <= 0) return t("chat.clarifyExpired");
  const minutesPart = Math.floor(seconds / 60);
  const secondsPart = seconds % 60;
  const time = `${minutesPart}:${String(secondsPart).padStart(2, "0")}`;
  return t("chat.clarifyExpiresIn", { time });
});
const clarifyResponse = ref('');

watch(
  visibleApproval,
  (approval) => {
    if (!approval || notifiedApprovalIds.has(approval.approvalId)) return;
    notifiedApprovalIds.add(approval.approvalId);
    void showBrowserNotification(
      t("chat.approvalNotificationTitle"),
      buildNotificationBody(approval.command || approval.description, t("chat.approvalNotificationBody")),
      `hermes-approval-${approval.approvalId}`,
    );
  },
);

watch(
  visibleClarify,
  (clarify) => {
    if (!clarify || notifiedClarifyIds.has(clarify.clarifyId)) return;
    notifiedClarifyIds.add(clarify.clarifyId);
    void showBrowserNotification(
      t("chat.clarifyNotificationTitle"),
      buildNotificationBody(clarify.question, t("chat.clarifyNotificationBody")),
      `hermes-clarify-${clarify.clarifyId}`,
    );
  },
);

watch(
  () => chatStore.latestCompletionNotification,
  (completion) => {
    if (!completion || notifiedCompletionIds.has(completion.id)) return;
    if (settingsStore.display.browser_notify_on_complete !== true) return;
    notifiedCompletionIds.add(completion.id);
    const failed = completion.status === "failed";
    void showBrowserNotification(
      failed ? t("chat.completionFailedNotificationTitle") : t("chat.completionNotificationTitle"),
      t(failed ? "chat.completionFailedNotificationBody" : "chat.completionNotificationBody", {
        title: completion.sessionTitle,
      }),
      `hermes-completion-${completion.id}`,
      false,
    );
  },
);

function handleClarify(response?: string) {
  if (clarifyRemainingMs.value <= 0) return;
  const finalResponse = response !== undefined ? response : clarifyResponse.value.trim();
  chatStore.respondToClarify(finalResponse);
  clarifyResponse.value = '';
}

const showNewChatModal = ref(false);
const newChatAgent = ref<"hermes" | "claude-code" | "codex">("hermes");
const newChatAgentMode = ref<"global" | "scoped">("scoped");
const newChatProfile = ref<string>("default");
const newChatProvider = ref<string>("");
const newChatModel = ref<string>("");
const newChatBaseUrl = ref<string>("");
const newChatApiKey = ref<string>("");
const newChatApiMode = ref<CodingAgentApiMode>("codex_responses");
const newChatWorkspace = ref("");
const newChatLoading = ref(false);
const CODING_AGENT_AUTH_PROVIDER_KEYS = new Set(["openai-codex", "copilot", "xai-oauth", "nous", "google-gemini-cli", "claude-oauth"]);

const newChatAgentOptions = computed(() => [
  { label: "Hermes", value: "hermes" },
  { label: "Claude Code", value: "claude-code" },
  { label: "Codex", value: "codex" },
]);

const newChatApiModeOptions = computed(() => [
  { label: t("codingAgents.protocolOpenAiChat"), value: "chat_completions" },
  { label: t("codingAgents.protocolOpenAiResponses"), value: "codex_responses" },
  { label: t("codingAgents.protocolAnthropicMessages"), value: "anthropic_messages" },
]);

const newChatAgentModeOptions = computed(() => [
  { label: t("codingAgents.launchModeGlobal"), value: "global" },
  { label: t("codingAgents.launchModeScoped"), value: "scoped" },
]);

function getModelGroupsForProfile(profile: string) {
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  return profileModels?.groups || [];
}

function isCodingAgentAuthProvider(provider?: string) {
  return CODING_AGENT_AUTH_PROVIDER_KEYS.has(String(provider || "").toLowerCase());
}

function isNewChatProviderAllowed(group: AvailableModelGroup) {
  if (!(newChatAgent.value !== "hermes" && newChatAgentMode.value === "scoped")) return true;
  return !isCodingAgentAuthProvider(group.provider);
}

function getSelectableModelGroupsForProfile(profile: string) {
  return getModelGroupsForProfile(profile).filter(isNewChatProviderAllowed);
}

function getDefaultModelForProfile(profile: string) {
  const groups = getSelectableModelGroupsForProfile(profile);
  const activeProfileName = profilesStore.activeProfileName || "default";
  const selectedProvider = appStore.selectedProvider || "";
  const selectedModel = appStore.selectedModel || "";
  const selectedGroup = selectedProvider
    ? groups.find((group) => group.provider === selectedProvider)
    : undefined;
  if (
    profile === activeProfileName &&
    selectedGroup?.models.includes(selectedModel)
  ) {
    return {
      provider: selectedProvider,
      model: selectedModel,
    };
  }
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  const defaultProvider = profileModels?.default_provider || "";
  const defaultModel = profileModels?.default || "";
  const providerGroup = defaultProvider
    ? groups.find((group) => group.provider === defaultProvider)
    : undefined;
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  return {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(defaultModel)
      ? defaultModel
      : fallbackGroup?.models[0] || "",
  };
}

const newChatProfileOptions = computed(() =>
  (profilesStore.profiles.length > 0 ? profilesStore.profiles : [{ name: "default" }]).map((profile) => ({
    label: profile.name,
    value: profile.name,
  })),
);

const newChatModelGroups = computed(() => {
  return getSelectableModelGroupsForProfile(newChatProfile.value);
});

const newChatProviderOptions = computed(() =>
  newChatModelGroups.value.map((group) => ({
    label: group.label || group.provider,
    value: group.provider,
  })),
);

const newChatModelOptions = computed(() => {
  const group = newChatModelGroups.value.find(
    (item) => item.provider === newChatProvider.value,
  );
  return (group?.models || []).map((model) => ({
    label: appStore.displayModelName(model, group?.provider),
    value: model,
  }));
});

const selectedNewChatProviderGroup = computed(() =>
  newChatModelGroups.value.find((item) => item.provider === newChatProvider.value),
);

const isNewChatCodingAgent = computed(() => newChatAgent.value !== "hermes");
const isNewChatGlobalCodingAgent = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "global",
);
const newChatUsesProviderModel = computed(() => !isNewChatGlobalCodingAgent.value);
const newChatNeedsBaseUrl = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.base_url,
);
const newChatNeedsApiKey = computed(() =>
  isNewChatCodingAgent.value && newChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.api_key,
);
const canConfirmNewChat = computed(() => {
  if (!newChatProfile.value) return false;
  if (!newChatUsesProviderModel.value) return true;
  if (!newChatProvider.value || !newChatModel.value) return false;
  if (!isNewChatCodingAgent.value) return true;
  if (!newChatApiMode.value) return false;
  if (newChatNeedsBaseUrl.value && !newChatBaseUrl.value.trim()) return false;
  if (newChatNeedsApiKey.value && !newChatApiKey.value.trim()) return false;
  return true;
});

function defaultNewChatApiMode(group?: AvailableModelGroup): CodingAgentApiMode {
  const providerKey = String(group?.provider || newChatProvider.value || "").toLowerCase();
  const baseUrl = String(group?.base_url || newChatBaseUrl.value || "").toLowerCase();
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(providerKey, baseUrl),
  );
}

function syncNewChatApiMode() {
  newChatApiMode.value = defaultNewChatApiMode(selectedNewChatProviderGroup.value);
}

function syncNewChatModelSelection() {
  const defaults = getDefaultModelForProfile(newChatProfile.value);
  newChatProvider.value = defaults.provider;
  newChatModel.value = defaults.model;
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

function ensureNewChatProviderSelection() {
  if (!newChatUsesProviderModel.value) return;
  const currentGroup = selectedNewChatProviderGroup.value;
  if (currentGroup && currentGroup.models.includes(newChatModel.value)) {
    syncNewChatApiMode();
    return;
  }
  syncNewChatModelSelection();
}

watch(
  () => [newChatAgent.value, newChatAgentMode.value, newChatProfile.value],
  () => ensureNewChatProviderSelection(),
);

async function openNewChatModal() {
  showNewChatModal.value = true;
  newChatLoading.value = true;
  try {
    if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles();
    if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
      await appStore.loadModels();
    }
    newChatWorkspace.value = "";
    newChatProfile.value =
      profilesStore.activeProfileName ||
      profilesStore.profiles.find((profile) => profile.active)?.name ||
      profilesStore.profiles[0]?.name ||
      "default";
    syncNewChatModelSelection();
  } finally {
    newChatLoading.value = false;
  }
}

function handleNewChatProfileChange(value: string) {
  newChatProfile.value = value;
  syncNewChatModelSelection();
}

function handleNewChatProviderChange(value: string) {
  newChatProvider.value = value;
  newChatModel.value = newChatModelOptions.value[0]?.value || "";
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

async function confirmNewChat() {
  if (newChatAgent.value !== "hermes") {
    newChatLoading.value = true;
    try {
      const agentId = newChatAgent.value as CodingAgentId;
      const status = await fetchCodingAgentsStatus();
      const tool = status.tools.find((item) => item.id === agentId);
      if (!tool?.installed) {
        const fallbackName = agentId === "codex" ? "Codex" : "Claude Code";
        message.warning(t("codingAgents.installRequired", { agent: tool?.name || fallbackName }));
        showNewChatModal.value = false;
        await router.push({ name: "hermes.codingAgents" });
        return;
      }
    } catch {
      message.error(t("codingAgents.loadFailed"));
      return;
    } finally {
      newChatLoading.value = false;
    }
  }

  const group = selectedNewChatProviderGroup.value;
  const source = newChatAgent.value === "hermes" ? "cli" : "coding_agent";
  const isGlobalCodingAgent = source === "coding_agent" && newChatAgentMode.value === "global";
  const agent = newChatAgent.value === "codex"
    ? "codex"
    : newChatAgent.value === "claude-code"
      ? "claude"
      : "hermes";
  const session = chatStore.newChat({
    profile: newChatProfile.value,
    provider: isGlobalCodingAgent ? undefined : newChatProvider.value,
    model: isGlobalCodingAgent ? undefined : newChatModel.value,
    source,
    agent,
    codingAgentId: newChatAgent.value === "hermes" ? undefined : newChatAgent.value,
    codingAgentMode: source === "coding_agent" ? newChatAgentMode.value : undefined,
    workspace: newChatWorkspace.value || null,
    baseUrl: source === "coding_agent" && !isGlobalCodingAgent ? group?.base_url || newChatBaseUrl.value.trim() || undefined : undefined,
    apiKey: source === "coding_agent" && !isGlobalCodingAgent ? group?.api_key || newChatApiKey.value.trim() || undefined : undefined,
    apiMode: source === "coding_agent" && !isGlobalCodingAgent ? newChatApiMode.value : undefined,
  });
  showNewChatModal.value = false;
  void router.push({
    name: sessionRouteName(),
    params: { sessionId: session.id },
  });
}

function handleApproval(choice: "once" | "session" | "always" | "deny") {
  chatStore.respondApproval(choice);
}

function sessionPendingInteraction(sessionId: string): "approval" | "clarify" | null {
  if (chatStore.pendingApprovals.has(sessionId)) return "approval";
  if (chatStore.pendingClarifies.has(sessionId)) return "clarify";
  return null;
}

function sessionProfile(sessionId: string): string | null {
  return chatStore.sessions.find((session) => session.id === sessionId)?.profile || null;
}

function buildSessionUrl(sessionId: string, profile?: string | null): string {
  const href = router.resolve({
    name: sessionRouteName(),
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
  return `${window.location.origin}${window.location.pathname}${href}`;
}

async function copySessionLink(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(buildSessionUrl(sessionId, sessionProfile(sessionId)));
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

async function copySessionId(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(sessionId);
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

async function handleDeleteSession(id: string) {
  const ok = await chatStore.deleteSession(id);
  if (!ok) {
    message.error(t("common.deleteFailed"));
    return;
  }
  sessionBrowserPrefsStore.removePinned(id);
  message.success(t("chat.sessionDeleted"));
}

function toggleBatchMode() {
  if (isBatchDeleting.value) return;
  isBatchMode.value = !isBatchMode.value;
  if (!isBatchMode.value) {
    selectedSessionKeys.value.clear();
    showBatchDeleteConfirm.value = false;
  }
}

function sessionSelectionKey(session: Pick<Session, "id" | "profile">): string {
  return `${session.profile || "default"}\u0000${session.id}`;
}

function toggleSessionSelection(session: Session) {
  if (isBatchDeleting.value) return;
  const key = sessionSelectionKey(session);
  if (selectedSessionKeys.value.has(key)) {
    selectedSessionKeys.value.delete(key);
  } else {
    selectedSessionKeys.value.add(key);
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
  if (selectedSessionKeys.value.size === 0) {
    showBatchDeleteConfirm.value = false;
  }
}

function isSessionSelected(session: Session): boolean {
  return selectedSessionKeys.value.has(sessionSelectionKey(session));
}

async function handleBatchDelete() {
  if (selectedSessionKeys.value.size === 0 || isBatchDeleting.value) return;

  const sessionsByKey = new Map(chatStore.sessions.map((session) => [sessionSelectionKey(session), session]));
  const targets = Array.from(selectedSessionKeys.value)
    .map((key) => sessionsByKey.get(key))
    .filter((session): session is Session => Boolean(session))
    .map((session) => ({ id: session.id, profile: session.profile || null }));
  if (targets.length === 0) return;
  isBatchDeleting.value = true;
  try {
    const result = await batchDeleteSessions(targets);
    if (result.deleted > 0) {
      // Remove from pinned sessions
      for (const target of targets) {
        sessionBrowserPrefsStore.removePinned(target.id);
      }

      // Remove deleted sessions from local store (without calling API again)
      // Use loadSessions to refresh from server instead of manual filtering
      await chatStore.loadSessions(chatStore.sessionProfileFilter);

      message.success(t("chat.batchDeleteSuccess", { count: result.deleted }));
      if (result.failed > 0) {
        message.warning(t("chat.batchDeletePartial", { failed: result.failed }));
      }
    } else {
      message.error(t("chat.batchDeleteFailed"));
    }
  } catch (err: any) {
    message.error(t("chat.batchDeleteFailed"));
  } finally {
    isBatchDeleting.value = false;
    showBatchDeleteConfirm.value = false;
    isBatchMode.value = false;
    selectedSessionKeys.value.clear();
  }
}

function handleBatchDeleteConfirm() {
  void handleBatchDelete();
  return false;
}

function selectAllSessions() {
  if (isBatchDeleting.value) return;
  selectedSessionKeys.value.clear();
  for (const session of chatStore.sessions) {
    if (session.id !== chatStore.activeSessionId) {
      selectedSessionKeys.value.add(sessionSelectionKey(session));
    }
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
}

const selectedCount = computed(() => selectedSessionKeys.value.size);
const canSelectAll = computed(() => {
  return chatStore.sessions.some(s => s.id !== chatStore.activeSessionId);
});

const contextSessionId = ref<string | null>(null);
const contextSessionPinned = computed(() =>
  contextSessionId.value
    ? sessionBrowserPrefsStore.isPinned(contextSessionId.value)
    : false,
);
const contextSession = computed(() =>
  contextSessionId.value
    ? chatStore.sessions.find((session) => session.id === contextSessionId.value) || null
    : null,
);

const contextMenuOptions = computed(() => {
  const options: DropdownOption[] = [{
    label: t(contextSessionPinned.value ? "chat.unpin" : "chat.pin"),
    key: "pin",
  },
  { label: t("chat.rename"), key: "rename" }]

  if (contextSession.value?.source !== "global_agent") {
    options.push({ label: t("chat.archiveSession"), key: "archive" })
  }

  options.push({ label: t("chat.setWorkspace"), key: "workspace" })

  if (contextSession.value?.source === "cli" || contextSession.value?.source === "coding_agent") {
    options.push({ label: t("chat.setModel"), key: "model" })
  }

  options.push({
    label: t("chat.export"),
    key: "export",
    children: [
      {
        label: t("chat.exportFull"),
        key: "export-full",
        children: [
          { label: "JSON", key: "export-full-json" },
          { label: "TXT", key: "export-full-txt" },
        ],
      },
      {
        label: t("chat.exportCompressed"),
        key: "export-compressed",
        children: [
          { label: "JSON", key: "export-compressed-json" },
          { label: "TXT", key: "export-compressed-txt" },
        ],
      },
    ],
  })
  options.push({ label: t("chat.openSessionInNewTab"), key: "open-link" })
  options.push({ label: t("chat.copySessionLink"), key: "copy-link" })
  options.push({ label: t("chat.copySessionId"), key: "copy-id" })
  return options
});

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault();
  contextSessionId.value = sessionId;
  showContextMenu.value = true;
  contextMenuX.value = e.clientX;
  contextMenuY.value = e.clientY;
}

const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

function parseExportKey(key: string): { mode: 'full' | 'compressed'; ext: 'json' | 'txt' } | null {
  if (key === 'export-full-json') return { mode: 'full', ext: 'json' }
  if (key === 'export-full-txt') return { mode: 'full', ext: 'txt' }
  if (key === 'export-compressed-json') return { mode: 'compressed', ext: 'json' }
  if (key === 'export-compressed-txt') return { mode: 'compressed', ext: 'txt' }
  return null
}

async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false;
  if (!contextSessionId.value) return;
  if (key === "pin") {
    sessionBrowserPrefsStore.togglePinned(contextSessionId.value);
    return;
  }
  if (key === "copy-link") {
    copySessionLink(contextSessionId.value);
  } else if (key === "copy-id") {
    copySessionId(contextSessionId.value);
  } else if (key === "open-link") {
    openSessionInNewTab(contextSessionId.value);
  } else if (key === "archive") {
    const archivedSession = contextSession.value;
    const ok = await chatStore.archiveSession(contextSessionId.value);
    if (ok) {
      sessionBrowserPrefsStore.removePinned(contextSessionId.value);
      if (archivedSession) {
        selectedSessionKeys.value.delete(sessionSelectionKey(archivedSession));
        selectedSessionKeys.value = new Set(selectedSessionKeys.value);
      }
      message.success(t("chat.sessionArchived"));
    } else {
      message.error(t("chat.archiveSessionFailed"));
    }
  } else if (parseExportKey(key)) {
    const { mode, ext } = parseExportKey(key)!;
    const loadingMsg = mode === "compressed" ? message.loading(t("chat.exportCompressing"), { duration: 0 }) : null;
    try {
      await exportSession(contextSessionId.value, mode, ext);
      loadingMsg?.destroy();
      message.success(t("chat.exportSuccess"));
    } catch {
      loadingMsg?.destroy();
      message.error(t("chat.exportFailed"));
    }
  } else if (key === "workspace") {
    const session = chatStore.sessions.find(
      (s) => s.id === contextSessionId.value,
    );
    workspaceSessionId.value = contextSessionId.value;
    workspaceValue.value = session?.workspace || "";
    showWorkspaceModal.value = true;
  } else if (key === "model") {
    await openSessionModelModal(contextSessionId.value);
  } else if (key === "rename") {
    const session = chatStore.sessions.find(
      (s) => s.id === contextSessionId.value,
    );
    renameSessionId.value = contextSessionId.value;
    renameValue.value = session?.title || "";
    showRenameModal.value = true;
    nextTick(() => {
      renameInputRef.value?.focus();
    });
  }
}

function handleClickOutside() {
  showContextMenu.value = false;
}

async function handleRenameConfirm() {
  if (!renameSessionId.value || !renameValue.value.trim()) return;
  const ok = await renameSession(
    renameSessionId.value,
    renameValue.value.trim(),
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === renameSessionId.value,
    );
    if (session) session.title = renameValue.value.trim();
    if (chatStore.activeSession?.id === renameSessionId.value) {
      chatStore.activeSession.title = renameValue.value.trim();
    }
    message.success(t("chat.renamed"));
  } else {
    message.error(t("chat.renameFailed"));
  }
  showRenameModal.value = false;
}

const showWorkspaceModal = ref(false);
const workspaceValue = ref("");
const workspaceSessionId = ref<string | null>(null);

function openActiveSessionWorkspace() {
  const session = chatStore.activeSession;
  if (!session?.id) return;
  workspaceSessionId.value = session.id;
  workspaceValue.value = session.workspace || "";
  showWorkspaceModal.value = true;
}

async function handleWorkspaceConfirm() {
  if (!workspaceSessionId.value) return;
  const ok = await setSessionWorkspace(
    workspaceSessionId.value,
    workspaceValue.value || null,
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === workspaceSessionId.value,
    );
    if (session) session.workspace = workspaceValue.value || null;
    if (chatStore.activeSession?.id === workspaceSessionId.value) {
      chatStore.activeSession.workspace = workspaceValue.value || null;
    }
    message.success(t("chat.workspaceSet"));
  } else {
    message.error(t("chat.workspaceSetFailed"));
  }
  showWorkspaceModal.value = false;
}

const showSessionModelModal = ref(false);
const showSessionModelModeModal = ref(false);
const sessionModelSessionId = ref<string | null>(null);
const sessionModelSearch = ref("");
const sessionModelCollapsedGroups = ref<Record<string, boolean>>({});
const sessionModelValue = ref("");
const sessionModelProvider = ref("");
const sessionModelCustomInput = ref("");
const sessionModelCustomProvider = ref("");
const sessionModelApiMode = ref<CodingAgentApiMode>("codex_responses");
const pendingSessionModelSwitch = ref<{ model: string; provider: string } | null>(null);

const sessionModelProfile = computed<string | null>(() => {
  const session = chatStore.sessions.find((s) => s.id === sessionModelSessionId.value);
  return session?.profile || null;
});

const sessionModelSession = computed(() =>
  chatStore.sessions.find((s) => s.id === sessionModelSessionId.value) ||
  (chatStore.activeSession?.id === sessionModelSessionId.value ? chatStore.activeSession : undefined),
);

const isSessionModelScopedCodingAgent = computed(() =>
  sessionModelSession.value?.source === "coding_agent" &&
  sessionModelSession.value?.codingAgentMode !== "global",
);

const sessionModelBaseGroups = computed(() =>
  sessionModelProfile.value
    ? getModelGroupsForProfile(sessionModelProfile.value).filter((group) => (
        !isSessionModelScopedCodingAgent.value || !isCodingAgentAuthProvider(group.provider)
      ))
    : [],
);

const sessionModelProviderOptions = computed(() =>
  sessionModelBaseGroups.value.map((group) => ({ label: group.label, value: group.provider })),
);

const sessionModelGroupsWithCustom = computed(() =>
  sessionModelBaseGroups.value.map((group) => ({
    ...group,
    models: [
      ...group.models,
      ...(appStore.customModels[group.provider] || []).filter(
        (model) => !group.models.includes(model),
      ),
    ],
  })),
);

const filteredSessionModelGroups = computed(() => {
  const query = sessionModelSearch.value.trim().toLowerCase();
  if (!query) return sessionModelGroupsWithCustom.value;
  return sessionModelGroupsWithCustom.value
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => {
        const displayName = appStore.displayModelName(model, group.provider);
        return model.toLowerCase().includes(query) || displayName.toLowerCase().includes(query);
      }),
    }))
    .filter((group) => group.models.length > 0 || group.label.toLowerCase().includes(query));
});

async function openSessionModelModal(sessionId: string) {
  if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
    await appStore.loadModels();
  }
  const session =
    chatStore.sessions.find((s) => s.id === sessionId) ||
    (chatStore.activeSession?.id === sessionId ? chatStore.activeSession : undefined);
  sessionModelSessionId.value = sessionId;
  const groups = sessionModelBaseGroups.value;
  const providerGroup = session?.provider
    ? groups.find((group) => group.provider === session.provider)
    : undefined;
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  const defaults = {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(session?.model || "")
      ? session?.model || ""
      : fallbackGroup?.models[0] || "",
  };
  sessionModelValue.value = providerGroup ? session?.model || defaults.model || "" : defaults.model || "";
  sessionModelProvider.value = providerGroup ? session?.provider || "" : defaults.provider || "";
  sessionModelCustomProvider.value = sessionModelProvider.value;
  sessionModelSearch.value = "";
  sessionModelCustomInput.value = "";
  sessionModelCollapsedGroups.value = {};
  showSessionModelModal.value = true;
}

function handleHeaderModelClick() {
  const sessionId = chatStore.activeSession?.id;
  if (!sessionId) {
    openNewChatModal();
    return;
  }
  openSessionModelModal(sessionId);
}

function isSessionModelGroupCollapsed(provider: string) {
  return !!sessionModelCollapsedGroups.value[provider];
}

function toggleSessionModelGroup(provider: string) {
  sessionModelCollapsedGroups.value[provider] = !sessionModelCollapsedGroups.value[provider];
}

function isCustomSessionModel(model: string, provider: string) {
  return (appStore.customModels[provider] || []).includes(model);
}

function sessionModelDisplayName(model: string, provider: string) {
  return appStore.displayModelName(model, provider);
}

function sessionModelAlias(model: string, provider: string) {
  return appStore.getModelAlias(model, provider);
}

function dragEventHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function handleChatFileDragOver(event: DragEvent) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleChatFileDragEnter(event: DragEvent) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  chatFileDragDepth += 1;
  isFileDragOverChat.value = true;
}

function handleChatFileDragLeave(event: DragEvent) {
  if (!dragEventHasFiles(event)) return;
  chatFileDragDepth = Math.max(0, chatFileDragDepth - 1);
  if (chatFileDragDepth === 0) {
    isFileDragOverChat.value = false;
  }
}

function handleChatFileDrop(event: DragEvent) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  chatFileDragDepth = 0;
  isFileDragOverChat.value = false;
  if (!files.length) return;
  chatInputRef.value?.addFiles(files);
}

function defaultSessionModelApiMode(provider: string): CodingAgentApiMode {
  const group = sessionModelBaseGroups.value.find((item) => item.provider === provider);
  const providerKey = String(group?.provider || provider || "").toLowerCase();
  const baseUrl = String(group?.base_url || "").toLowerCase();
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(providerKey, baseUrl),
  );
}

async function applySessionModelSwitch(model: string, provider: string, apiMode?: CodingAgentApiMode) {
  if (!sessionModelSessionId.value) return;
  const ok = await chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode);
  if (ok) {
    sessionModelValue.value = model;
    sessionModelProvider.value = provider;
    if (apiMode) sessionModelApiMode.value = apiMode;
    pendingSessionModelSwitch.value = null;
    showSessionModelModeModal.value = false;
    showSessionModelModal.value = false;
    message.success(t("chat.modelSet"));
  } else {
    message.error(t("chat.modelSetFailed"));
  }
}

async function selectSessionModel(model: string, provider: string) {
  const meta = sessionModelBaseGroups.value.find((group) => group.provider === provider)?.model_meta?.[model];
  if (meta?.disabled || !sessionModelSessionId.value) return;
  if (isSessionModelScopedCodingAgent.value) {
    pendingSessionModelSwitch.value = { model, provider };
    sessionModelApiMode.value = defaultSessionModelApiMode(provider);
    showSessionModelModeModal.value = true;
    return;
  }
  await applySessionModelSwitch(model, provider);
}

async function confirmSessionModelMode() {
  const pending = pendingSessionModelSwitch.value;
  if (!pending) return;
  await applySessionModelSwitch(pending.model, pending.provider, sessionModelApiMode.value);
}

function cancelSessionModelMode() {
  pendingSessionModelSwitch.value = null;
  showSessionModelModeModal.value = false;
}

async function handleSessionModelCustomSubmit() {
  const model = sessionModelCustomInput.value.trim();
  const provider = sessionModelCustomProvider.value;
  if (!model || !provider) return;
  await selectSessionModel(model, provider);
}
</script>

<template>
  <div ref="chatPanelRef" class="chat-panel" :class="{ 'chat-panel--drawer-pinned': isDrawerPinned && !isMobile }">
    <div
      v-if="currentMode === 'chat'"
      class="session-backdrop"
      :class="{ active: showSessions }"
      @click="showSessions = false"
    />
    <aside
      v-if="currentMode === 'chat'"
      class="session-list"
      :class="{ collapsed: !showSessions }"
    >
      <div class="session-list-header">
        <span v-if="showSessions" class="session-list-title">{{
          t("chat.webUiSessions")
        }}</span>
        <div class="session-list-actions">
          <button class="session-close-btn" @click="showSessions = false">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <NButton
            v-if="!isBatchMode"
            quaternary
            size="tiny"
            @click="toggleBatchMode"
            :title="t('chat.toggleBatchMode')"
          >
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </template>
          </NButton>
          <NButton
            v-if="isBatchMode"
            quaternary
            size="tiny"
            @click="selectAllSessions"
            :disabled="!canSelectAll || isBatchDeleting"
            :title="t('chat.selectAll')"
          >
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </template>
          </NButton>
          <NPopconfirm
            v-if="isBatchMode && selectedCount > 0"
            v-model:show="showBatchDeleteConfirm"
            :positive-button-props="{ loading: isBatchDeleting, disabled: isBatchDeleting }"
            :negative-button-props="{ disabled: isBatchDeleting }"
            @positive-click="handleBatchDeleteConfirm"
          >
            <template #trigger>
              <NButton quaternary size="tiny" type="error" :loading="isBatchDeleting" :disabled="isBatchDeleting">
                <template #icon>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.confirmBatchDelete', { count: selectedCount }) }}
          </NPopconfirm>
          <NButton
            v-if="isBatchMode"
            quaternary
            size="tiny"
            @click="toggleBatchMode"
            :disabled="isBatchDeleting"
          >
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </template>
          </NButton>
          <NButton quaternary size="tiny" circle @click="openNewChatModal">
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </template>
          </NButton>
        </div>
      </div>
      <div v-if="showSessions" class="session-profile-filter">
        <NSelect
          :value="sessionProfileFilter || '__all__'"
          :options="profileFilterOptions"
          size="small"
          :loading="profilesStore.loading"
          @update:value="handleProfileFilterChange"
        />
      </div>
      <div v-if="showSessions" class="session-items">
        <div
          v-if="chatStore.isLoadingSessions && chatStore.sessions.length === 0"
          class="session-loading"
        >
          {{ t("common.loading") }}
        </div>
        <div v-else-if="chatStore.sessions.length === 0" class="session-empty">
          {{ t("chat.noSessions") }}
        </div>

        <template v-if="pinnedSessions.length > 0">
          <div class="session-group-header session-group-header--static">
            <span class="session-group-label">{{ t("chat.pinned") }}</span>
            <span class="session-group-count">{{ pinnedSessions.length }}</span>
          </div>
          <SessionListItem
            v-for="s in pinnedSessions"
            :key="`pinned-${s.id}`"
            :session="s"
            :active="s.id === chatStore.activeSessionId"
            :pinned="true"
            :can-delete="
              s.id !== chatStore.activeSessionId ||
              chatStore.sessions.length > 1
            "
            :streaming="chatStore.isSessionLive(s.id)"
            :pending-interaction="sessionPendingInteraction(s.id)"
            :selectable="isBatchMode"
            :selected="isSessionSelected(s)"
            :show-profile="true"
            :to="sessionHref(s.id)"
            @select="handleSessionClick(s.id)"
            @contextmenu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id)"
            @toggle-select="toggleSessionSelection(s)"
          />
        </template>

        <template v-for="group in unpinnedSessionGroups" :key="group.kind">
          <button
            class="session-group-header session-group-header--collapsible"
            type="button"
            :aria-expanded="!isSessionAgentGroupCollapsed(group.kind)"
            @click="toggleSessionAgentGroup(group.kind)"
          >
            <svg
              class="group-chevron"
              :class="{ collapsed: isSessionAgentGroupCollapsed(group.kind) }"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span class="session-group-label">{{ t(group.labelKey) }}</span>
            <span class="session-group-count">{{ group.sessions.length }}</span>
          </button>
          <template v-if="!isSessionAgentGroupCollapsed(group.kind)">
            <SessionListItem
              v-for="s in group.sessions"
              :key="s.id"
              :session="s"
              :active="s.id === chatStore.activeSessionId"
              :pinned="false"
              :can-delete="
                s.id !== chatStore.activeSessionId ||
                chatStore.sessions.length > 1
              "
              :streaming="chatStore.isSessionLive(s.id)"
              :pending-interaction="sessionPendingInteraction(s.id)"
              :selectable="isBatchMode"
              :selected="isSessionSelected(s)"
              :show-profile="true"
              :to="sessionHref(s.id)"
              @select="handleSessionClick(s.id)"
              @contextmenu="handleContextMenu($event, s.id)"
              @delete="handleDeleteSession(s.id)"
              @toggle-select="toggleSessionSelection(s)"
            />
          </template>
        </template>
      </div>
      <div v-if="showSessions" class="page-sidebar-bottom">
        <button class="page-sidebar-menu-btn" type="button" @click="openSettingsPage">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{{ t("sidebar.settings") }}</span>
        </button>
        <SettingsCircuitBadge />
      </div>
    </aside>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="showContextMenu"
      @select="handleContextMenuSelect"
      @clickoutside="handleClickOutside"
    />

    <NModal
      v-model:show="showRenameModal"
      preset="dialog"
      :title="t('chat.renameSession')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="handleRenameConfirm"
    >
      <NInput
        ref="renameInputRef"
        v-model:value="renameValue"
        :placeholder="t('chat.enterNewTitle')"
        @keydown.enter="handleRenameConfirm"
      />
    </NModal>

    <NModal
      v-model:show="showWorkspaceModal"
      preset="dialog"
      :title="t('chat.setWorkspaceTitle')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      style="width: 520px"
      @positive-click="handleWorkspaceConfirm"
    >
      <FolderPicker v-model="workspaceValue" />
    </NModal>

    <NModal
      v-model:show="showSessionModelModal"
      preset="card"
      :title="t('chat.setModelTitle')"
      :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      :mask-closable="true"
    >
      <NInput
        v-model:value="sessionModelSearch"
        :placeholder="t('models.searchPlaceholder')"
        clearable
        size="small"
        class="session-model-search"
      />
      <div class="session-model-list">
        <div v-for="group in filteredSessionModelGroups" :key="group.provider" class="session-model-group">
          <div class="session-model-group-header" @click="toggleSessionModelGroup(group.provider)">
            <svg
              class="session-model-group-arrow"
              :class="{ collapsed: isSessionModelGroupCollapsed(group.provider) }"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span class="session-model-group-label">{{ group.label }}</span>
            <span class="session-model-group-count">{{ group.models.length }}</span>
          </div>
          <div v-show="!isSessionModelGroupCollapsed(group.provider)" class="session-model-group-items">
            <div
              v-for="model in group.models"
              :key="model"
              class="session-model-item"
              :class="{
                active: model === sessionModelValue && group.provider === sessionModelProvider,
                disabled: !!group.model_meta?.[model]?.disabled,
              }"
              :title="group.model_meta?.[model]?.disabled ? t('models.disabledTooltip') : ''"
              @click="selectSessionModel(model, group.provider)"
            >
              <span class="session-model-item-label">
                <span class="session-model-item-name">{{ sessionModelDisplayName(model, group.provider) }}</span>
                <span v-if="sessionModelAlias(model, group.provider)" class="session-model-item-id">
                  {{ t('models.aliasCanonical', { model }) }}
                </span>
              </span>
              <span v-if="group.model_meta?.[model]?.preview" class="session-model-badge-preview">{{ t('models.previewBadge') }}</span>
              <span v-if="group.model_meta?.[model]?.disabled" class="session-model-badge-disabled">{{ t('models.disabledBadge') }}</span>
              <span v-if="isCustomSessionModel(model, group.provider)" class="session-model-badge-custom">{{ t('models.customBadge') }}</span>
              <svg
                v-if="model === sessionModelValue && group.provider === sessionModelProvider"
                class="session-model-check"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
        </div>
        <div v-if="filteredSessionModelGroups.length === 0" class="session-model-empty">
          {{ sessionModelSearch ? 'No results' : 'No models' }}
        </div>
        <div class="session-model-custom">
          <div class="session-model-custom-row">
            <NSelect
              v-model:value="sessionModelCustomProvider"
              :options="sessionModelProviderOptions"
              size="small"
              class="session-model-custom-provider"
            />
            <NInput
              v-model:value="sessionModelCustomInput"
              :placeholder="t('models.customModelPlaceholder')"
              size="small"
              class="session-model-custom-input"
              @keydown.enter="handleSessionModelCustomSubmit"
            />
          </div>
          <div class="session-model-custom-hint">
            {{ t('models.customModelHint') }}
          </div>
        </div>
      </div>
    </NModal>

    <NModal
      v-model:show="showSessionModelModeModal"
      preset="dialog"
      :title="t('codingAgents.protocolScope')"
      :mask-closable="true"
      style="width: min(420px, calc(100vw - 32px))"
    >
      <NSelect
        v-model:value="sessionModelApiMode"
        :options="newChatApiModeOptions"
      />
      <template #action>
        <NButton size="small" @click="cancelSessionModelMode">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" @click="confirmSessionModelMode">
          {{ t('common.confirm') }}
        </NButton>
      </template>
    </NModal>

    <NDrawer
      v-model:show="showNewChatModal"
      class="new-chat-drawer"
      placement="right"
      width="min(440px, 100vw)"
      :mask-closable="true"
    >
      <NDrawerContent :title="t('chat.newChat')" closable>
        <div class="new-chat-form">
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.agent") }}</span>
            <NSelect
              v-model:value="newChatAgent"
              :options="newChatAgentOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="isNewChatCodingAgent" class="new-chat-field">
            <span class="new-chat-label">{{ t("codingAgents.launchModeScope") }}</span>
            <NRadioGroup v-model:value="newChatAgentMode" name="new-chat-coding-agent-mode">
              <NRadioButton
                v-for="option in newChatAgentModeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </NRadioButton>
            </NRadioGroup>
          </label>
          <label class="new-chat-field">
            <span class="new-chat-label">{{ t("sidebar.profiles") }}</span>
            <NSelect
              :value="newChatProfile"
              :options="newChatProfileOptions"
              :loading="newChatLoading || profilesStore.loading"
              @update:value="handleNewChatProfileChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.provider") }}</span>
            <NSelect
              :value="newChatProvider"
              :options="newChatProviderOptions"
              :disabled="newChatLoading"
              @update:value="handleNewChatProviderChange"
            />
          </label>
          <label v-if="newChatUsesProviderModel" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.models") }}</span>
            <NSelect
              v-model:value="newChatModel"
              :options="newChatModelOptions"
              :disabled="newChatLoading || !newChatProvider"
              filterable
            />
          </label>
          <label v-if="isNewChatCodingAgent && newChatAgentMode === 'scoped'" class="new-chat-field">
            <span class="new-chat-label">{{ t("codingAgents.protocolScope") }}</span>
            <NSelect
              v-model:value="newChatApiMode"
              :options="newChatApiModeOptions"
              :disabled="newChatLoading"
            />
          </label>
          <label v-if="newChatNeedsBaseUrl" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.baseUrl") }}</span>
            <NInput
              v-model:value="newChatBaseUrl"
              :placeholder="t('models.baseUrlPlaceholder')"
            />
          </label>
          <label v-if="newChatNeedsApiKey" class="new-chat-field">
            <span class="new-chat-label">{{ t("models.apiKey") }}</span>
            <NInput
              v-model:value="newChatApiKey"
              type="password"
              show-password-on="click"
              :placeholder="t('models.apiKeyPlaceholder')"
            />
          </label>
          <div class="new-chat-field">
            <span class="new-chat-label">{{ t("chat.workspace") }}</span>
            <FolderPicker v-model="newChatWorkspace" />
          </div>
        </div>
        <template #footer>
          <div class="new-chat-actions">
            <NButton @click="showNewChatModal = false">{{ t("common.cancel") }}</NButton>
            <NButton
              type="primary"
              :disabled="!canConfirmNewChat"
              @click="confirmNewChat"
            >
              {{ t("common.create") }}
            </NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>

    <div class="chat-main">
      <header class="chat-header">
        <div class="header-left">
          <NButton
            v-if="currentMode === 'chat'"
            quaternary
            size="small"
            @click="showSessions = !showSessions"
            circle
          >
            <template #icon>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </template>
          </NButton>
          <div
            class="header-title-stack"
            :class="{ 'header-title-stack--with-workspace': !!activeWorkspace }"
          >
            <div class="header-title-line">
              <span class="header-session-title" :title="headerTitle">{{ headerTitle }}</span>
            </div>
            <button
              v-if="activeWorkspace"
              class="workspace-badge"
              type="button"
              :title="activeWorkspace"
              @click="openActiveSessionWorkspace"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span>{{ activeWorkspaceLabel }}</span>
            </button>
          </div>
        </div>
        <div class="header-actions">
          <!-- chat/live mode toggle hidden -->
          <template v-if="currentMode === 'chat'">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  quaternary
                  size="small"
                  @click="showOutline = !showOutline"
                  circle
                >
                  <template #icon>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <path d="M3 12h18M3 6h18M3 18h18" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t("chat.outlineTitle") }}
            </NTooltip>
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  quaternary
                  size="small"
                  @click="copySessionId()"
                  circle
                >
                  <template #icon>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t("chat.copySessionId") }}
            </NTooltip>
            <NButton size="small" :circle="isMobile" @click="openNewChatModal">
              <template #icon>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </template>
              <template v-if="!isMobile">{{ t("chat.newChat") }}</template>
            </NButton>
          </template>
        </div>
      </header>

      <template v-if="currentMode === 'chat'">
        <div
          class="chat-content-wrapper"
          :class="{ 'chat-content-wrapper--file-drag': isFileDragOverChat }"
          @dragover="handleChatFileDragOver"
          @dragenter="handleChatFileDragEnter"
          @dragleave="handleChatFileDragLeave"
          @drop="handleChatFileDrop"
        >
          <div class="chat-main-content">
            <div v-if="isFileDragOverChat" class="chat-file-drop-overlay">
              <div class="chat-file-drop-card">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>{{ t("chat.dropFilesToAttach") }}</span>
              </div>
            </div>
            <MessageList ref="messageListRef" />
            <div v-if="visibleApproval || visibleClarify" class="pending-interaction-stack">
              <div v-if="visibleApproval" class="approval-bar">
                <div class="approval-icon" aria-hidden="true">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>
              <div class="approval-content">
                <div class="approval-main">
                  <div class="approval-kicker">{{ t("chat.approvalKicker") }}</div>
                  <div class="approval-title-row">
                    <div class="approval-title">{{ t("chat.approvalTitle") }}</div>
                    <div
                      class="approval-countdown"
                      :class="{ 'approval-countdown-expired': approvalRemainingMs <= 0 }"
                    >
                      {{ approvalCountdownText }}
                    </div>
                  </div>
                  <div class="approval-desc">{{ visibleApproval.description }}</div>
                  <code class="approval-command">{{ visibleApproval.command }}</code>
                </div>
                <div class="approval-actions">
                  <NButton
                    v-if="visibleApproval.choices.includes('once')"
                    size="small"
                    type="primary"
                    :disabled="approvalRemainingMs <= 0"
                    @click="handleApproval('once')"
                  >
                    {{ t("chat.approvalAllowOnce") }}
                  </NButton>
                  <NButton
                    v-if="visibleApproval.choices.includes('session')"
                    size="small"
                    secondary
                    :disabled="approvalRemainingMs <= 0"
                    @click="handleApproval('session')"
                  >
                    {{ t("chat.approvalAllowSession") }}
                  </NButton>
                  <NButton
                    v-if="visibleApproval.choices.includes('always')"
                    size="small"
                    secondary
                    :disabled="approvalRemainingMs <= 0"
                    @click="handleApproval('always')"
                  >
                    {{ t("chat.approvalAlways") }}
                  </NButton>
                  <NButton
                    v-if="visibleApproval.choices.includes('deny')"
                    size="small"
                    type="error"
                    secondary
                    :disabled="approvalRemainingMs <= 0"
                    @click="handleApproval('deny')"
                  >
                    {{ t("chat.approvalDeny") }}
                  </NButton>
                  <NButton
                    v-if="browserNotificationPermission === 'default'"
                    size="small"
                    tertiary
                    @click="requestBrowserNotifications"
                  >
                    {{ t("chat.browserNotificationsEnable") }}
                  </NButton>
                </div>
              </div>
            </div>
            <div v-if="visibleClarify" class="clarify-bar">
              <div class="clarify-icon" aria-hidden="true">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div class="clarify-content">
                <div class="clarify-main">
                  <div class="clarify-kicker">{{ t('chat.clarifyKicker') }}</div>
                  <div class="clarify-title">{{ t('chat.clarifyTitle') }}</div>
                  <div class="clarify-countdown" :class="{ expired: clarifyRemainingMs <= 0 }">
                    {{ clarifyCountdownText }}
                  </div>
                  <div class="clarify-desc">{{ visibleClarify.question }}</div>
                </div>
                <div v-if="visibleClarify.choices && visibleClarify.choices.length" class="clarify-actions">
                  <NButton
                    v-for="choice in visibleClarify.choices"
                    :key="choice"
                    size="small"
                    type="primary"
                    :disabled="clarifyRemainingMs <= 0"
                    @click="handleClarify(choice)"
                  >
                    {{ choice }}
                  </NButton>
                  <NButton
                    size="small"
                    type="error"
                    secondary
                    :disabled="clarifyRemainingMs <= 0"
                    @click="handleClarify('')"
                  >
                    {{ t('chat.clarifyDismiss') }}
                  </NButton>
                  <NButton
                    v-if="browserNotificationPermission === 'default'"
                    size="small"
                    tertiary
                    @click="requestBrowserNotifications"
                  >
                    {{ t('chat.browserNotificationsEnable') }}
                  </NButton>
                </div>
                <div v-else class="clarify-actions clarify-actions-open">
                  <div class="clarify-input-row">
                    <NInput
                      v-model:value="clarifyResponse"
                      size="small"
                      :disabled="clarifyRemainingMs <= 0"
                      :placeholder="t('chat.clarifyPlaceholder')"
                    />
                    <NButton size="small" type="primary" :disabled="clarifyRemainingMs <= 0" @click="handleClarify()">
                      {{ t('chat.clarifySubmit') }}
                    </NButton>
                    <NButton
                      v-if="browserNotificationPermission === 'default'"
                      size="small"
                      tertiary
                      @click="requestBrowserNotifications"
                    >
                      {{ t('chat.browserNotificationsEnable') }}
                    </NButton>
                  </div>
                </div>
              </div>
              </div>
            </div>

            <ChatInput
              ref="chatInputRef"
              :model-label="activeSessionModelLabel"
              @model-click="handleHeaderModelClick"
            />
          </div>
          <OutlinePanel
            v-if="showOutline"
            :messages="chatStore.messages"
            @navigate="handleOutlineNavigate"
          />
        </div>
      </template>
      <ConversationMonitorPane
        v-else
        :human-only="sessionBrowserPrefsStore.humanOnly"
      />
    </div>

    <!-- Floating drawer button -->
    <div
      v-if="!isDrawerPinned || isMobile"
      class="drawer-button-wrapper"
      :class="[
        `drawer-button-wrapper--${drawerButtonPosition}`,
        { dragging: isDrawerButtonDragging, 'drawer-button-wrapper--rainbow': showDrawerRainbow },
      ]"
      :style="drawerButtonStyle"
    >
      <button
        class="drawer-button"
        type="button"
        :aria-label="t('drawer.open')"
        :title="t('drawer.repositionHint')"
        @click="handleDrawerButtonClick"
        @pointerdown="handleDrawerButtonPointerDown"
        @keydown.up.prevent="nudgeDrawerButtonPosition('up')"
        @keydown.down.prevent="nudgeDrawerButtonPosition('down')"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    </div>

    <DrawerPanel
      v-model:show="drawerShown"
      :pinned="isDrawerPinned && !isMobile"
      :active-tab="drawerActiveTab"
      @update:pinned="handleDrawerPinnedChange"
    />
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.chat-panel {
  display: flex;
  height: 100%;
  position: relative;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}

.session-model-search {
  margin-bottom: 12px;
}

.session-model-list {
  max-height: 50vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.session-model-group {
  margin-bottom: 4px;
}

.session-model-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  font-size: 12px;
  font-weight: 600;
  color: $text-secondary;
  cursor: pointer;
  border-radius: $radius-sm;
  user-select: none;
  transition: background-color $transition-fast;

  &:hover {
    background-color: $bg-secondary;
  }
}

.session-model-group-arrow {
  flex-shrink: 0;
  transition: transform $transition-fast;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.session-model-group-label {
  flex: 1;
}

.session-model-group-count {
  font-size: 11px;
  color: $text-muted;
  font-weight: 400;
}

.session-model-group-items {
  padding-left: 8px;
}

.session-model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  color: $text-secondary;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    color: $accent-primary;
    font-weight: 500;
  }

  &.disabled {
    opacity: 0.45;
    cursor: not-allowed;

    &:hover {
      background-color: transparent;
      color: $text-secondary;
    }
  }
}

.session-model-item-label {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-model-item-name,
.session-model-item-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: $font-code;
}

.session-model-item-name {
  font-size: 12px;
}

.session-model-item-id {
  color: $text-muted;
  font-size: 10px;
  font-weight: 400;
}

.session-model-check {
  flex-shrink: 0;
  color: $accent-primary;
}

.session-model-badge-preview,
.session-model-badge-custom,
.session-model-badge-disabled {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 4px;
  letter-spacing: 0.03em;
}

.session-model-badge-preview {
  color: #fff;
  background: #d97706;
}

.session-model-badge-custom {
  color: #fff;
  background: $accent-primary;
}

.session-model-badge-disabled {
  color: $text-muted;
  background: transparent;
  border: 1px solid $border-color;
  padding: 0 5px;
}

.session-model-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: $text-muted;
}

.session-model-custom {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid $border-color;
}

.session-model-custom-row {
  display: flex;
  gap: 8px;
}

.session-model-custom-provider {
  width: 160px;
  flex-shrink: 0;
}

.session-model-custom-input {
  flex: 1;
}

.session-model-custom-hint {
  margin-top: 6px;
  font-size: 11px;
  color: $text-muted;
}

.session-list {
  width: 220px;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 120;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: 280px;

    &.collapsed {
      transform: translateX(-100%);
      opacity: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .session-close-btn {
    display: flex;
  }

  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  flex-shrink: 0;
  min-height: 0;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    min-height: 22px;
  }
}

.session-close-btn {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;
  height: 22px;
  min-height: 22px;
  align-items: center;
  justify-content: center;

  &:hover {
    background: rgba($accent-primary, 0.06);
  }
}

.session-list-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  line-height: 22px;
}

.session-profile-filter {
  margin: 0 8px 10px;
}

.new-chat-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

:deep(.new-chat-drawer .n-drawer-content) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

:deep(.new-chat-drawer .n-drawer-header),
:deep(.new-chat-drawer .n-drawer-footer) {
  flex-shrink: 0;
}

:deep(.new-chat-drawer .n-drawer-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

:deep(.new-chat-drawer .n-drawer-body-content-wrapper) {
  height: 100%;
  overflow-y: auto;
}

:deep(.new-chat-drawer .folder-picker) {
  max-height: 260px;
}

:deep(.new-chat-drawer .folder-tree) {
  max-height: 170px;
}

@media (max-width: $breakpoint-mobile) {
  :deep(.new-chat-drawer .n-drawer-body-content-wrapper) {
    padding-top: 12px;
    padding-bottom: 12px;
  }

  :deep(.new-chat-drawer .folder-picker) {
    max-height: 210px;
  }

  :deep(.new-chat-drawer .folder-tree) {
    max-height: 128px;
  }
}

.new-chat-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.new-chat-label {
  font-size: 12px;
  color: $text-muted;
  font-weight: 500;
}

.new-chat-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.session-group-header {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 4px;
  padding: 6px 10px 4px;
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  color: inherit;
  cursor: pointer;
  user-select: none;
}

.session-group-header--static {
  cursor: default;
}

.session-group-header--collapsible:hover .session-group-label,
.session-group-header--collapsible:focus-visible .session-group-label {
  color: $text-primary;
}

.group-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;
  transform: rotate(90deg);

  &.collapsed {
    transform: rotate(0deg);
  }
}

.session-group-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-group-count {
  font-size: 10px;
  color: $text-muted;
  font-weight: 400;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 10px 6px 12px;
}

.page-sidebar-bottom {
  flex-shrink: 0;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-sidebar-menu-btn {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 36px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.page-sidebar-menu-btn span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 18px;
}

.session-loading,
.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

:deep(.session-item) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  color: $text-secondary;
  transition: all $transition-fast;
  margin-bottom: 2px;

  &:hover {
    background: rgba($accent-primary, 0.06);
    color: $text-primary;

    .session-item-delete {
      opacity: 1;
    }
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $text-primary;
    font-weight: 500;
  }

  &.active .session-item-title {
    color: $accent-primary;
  }

  &.missing-models {
    color: #b42318;
    background: rgba(220, 38, 38, 0.08);

    .session-item-title,
    .session-item-profile-name,
    .session-item-time {
      color: #b42318;
    }

    .session-item-model {
      color: #b42318;
      background: rgba(220, 38, 38, 0.12);
    }

    &:hover {
      background: rgba(220, 38, 38, 0.12);
    }
  }
}

:deep(.session-item-content) {
  flex: 1;
  overflow: hidden;
}

:deep(.session-item-title-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

:deep(.session-item-title) {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.session-item-streaming) {
  display: inline-block;
  flex-shrink: 0;
  margin-right: 4px;
  vertical-align: middle;
  animation: spin 1.2s linear infinite;
  color: $accent-primary;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

:deep(.session-item-pin) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: $accent-primary;
}

:deep(.session-item-time) {
  font-size: 11px;
  color: $text-muted;
}

:deep(.session-item-meta) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

:deep(.session-item-model) {
  font-size: 10px;
  color: $accent-primary;
  background: rgba($accent-primary, 0.08);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.session-item-delete) {
  flex-shrink: 0;
  opacity: 0.5;
  padding: 2px;
  border: none;
  background: none;
  color: $text-muted;
  cursor: pointer;
  border-radius: 3px;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba($error, 0.1);
  }
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  position: relative;
}

.chat-content-wrapper {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  min-width: 0;
  max-width: 100%;
}

.chat-content-wrapper--file-drag {
  outline: 2px dashed var(--accent-info);
  outline-offset: -8px;
}

.chat-file-drop-overlay {
  position: absolute;
  inset: 12px;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--accent-info);
  border-radius: 16px;
  background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  pointer-events: none;
}

.chat-file-drop-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-radius: 14px;
  border: 1px solid rgba(var(--accent-info-rgb), 0.35);
  background: $bg-card;
  color: var(--accent-info);
  font-size: 14px;
  font-weight: 600;
  box-shadow: 0 18px 45px rgba(0, 0, 0, 0.18);
}

.chat-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  background-color: $bg-card;
  animation: chat-surface-fade-in 1.5s ease both;
}

@keyframes chat-surface-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-title-stack {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.header-title-line {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
}

.header-session-title {
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  font-size: 10px;
  color: $text-muted;
  background: rgba($text-muted, 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.chat-mode-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px;
    gap: 8px;
  }

  .header-sidebar-toggle {
    display: none;
  }

  .header-left {
    flex: 1 1 auto;
    min-width: 0;
  }

  .header-title-stack {
    gap: 4px;
  }

  .header-session-title {
    display: inline-block;
    max-width: 100%;
    font-size: 13px;
    line-height: 18px;
  }

}


.workspace-badge {
  border: 0;
  font-size: 11px;
  line-height: 16px;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 160px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  cursor: pointer;

  svg {
    flex: 0 0 auto;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover {
    color: $text-secondary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    align-items: center;
    padding: 12px 10px 12px 52px;
  }

  .header-left {
    gap: 7px;
  }

  .header-title-stack {
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 2px;
    line-height: 1.15;
  }

  .header-title-line {
    max-width: 100%;
  }

  .header-title-stack--with-workspace .header-session-title {
    font-size: 13px;
    line-height: 16px;
  }

  .workspace-badge {
    max-width: 100%;
    padding: 0;
    border-radius: 0;
    background: transparent;
    font-size: 10px;
    line-height: 12px;
  }
}

// ─── Drawer button ─────────────────────────────────────────────

.drawer-button-wrapper {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 100;
  background: $bg-card;
  border-radius: 50%;
  box-shadow:
    0 8px 20px rgba(0, 0, 0, 0.12),
    0 0 0 1px rgba(var(--accent-primary-rgb), 0.22);
  touch-action: none;
  transition:
    top $transition-fast,
    box-shadow $transition-fast,
    transform $transition-fast;

  &:hover {
    box-shadow:
      0 10px 24px rgba(0, 0, 0, 0.16),
      0 0 0 2px rgba(var(--accent-primary-rgb), 0.28);
  }

  &.dragging {
    transition: none;
    transform: translateY(-50%) scale(1.04);
  }
}

.drawer-button-wrapper--rainbow {
  box-shadow:
    0 0 10px rgba(255, 107, 107, 0.4),
    0 0 20px rgba(255, 107, 107, 0.2);
  animation: rainbow-glow 8s linear infinite;

  &:hover,
  &.dragging {
    animation-play-state: paused;
  }

  &:hover {
    box-shadow:
      0 0 15px rgba(255, 107, 107, 0.6),
      0 0 30px rgba(255, 107, 107, 0.3);
  }
}

:global(.drawer-button-dragging-body) {
  cursor: grabbing;
  user-select: none;
}

.drawer-button-wrapper--rainbow.drawer-button-wrapper--top,
.drawer-button-wrapper--rainbow.drawer-button-wrapper--bottom {
  animation-duration: 10s;
}

.drawer-button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(var(--accent-primary-rgb), 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  border: 0;
  padding: 0;
  font: inherit;
  transition: all $transition-fast;

  &:active {
    cursor: grabbing;
  }

  svg {
    width: 18px;
    height: 18px;
    color: var(--accent-primary);
  }

  &:hover {
    transform: scale(1.1);
  }
}

.pending-interaction-stack {
  position: relative;
  z-index: 140;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 10px;
  width: calc(100% - 48px);
  max-width: 960px;
  max-height: min(45vh, 360px);
  margin: 0 auto 8px;
  overflow-y: auto;
  pointer-events: none;
}

.pending-interaction-stack > * {
  pointer-events: auto;
}

.approval-bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  max-width: 960px;
  margin: 0 auto;
  padding: 12px 14px;
  border: 1px solid rgba(var(--text-muted-rgb), 0.22);
  border-left: 3px solid rgba(var(--warning-rgb), 0.68);
  border-radius: $radius-md;
  background: $bg-card;
  background: color-mix(in srgb, var(--bg-card) 72%, transparent);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(18px) saturate(1.18);
  -webkit-backdrop-filter: blur(18px) saturate(1.18);
}

.approval-icon {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  color: $warning;
  background: rgba(var(--warning-rgb), 0.14);
  border: 1px solid rgba(var(--warning-rgb), 0.24);
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(var(--warning-rgb), 0.1);
}

.approval-content {
  flex: 1;
  min-width: 0;
}

.approval-main {
  min-width: 0;
}

.approval-kicker {
  margin-bottom: 2px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-primary);
}

.approval-title {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: $text-primary;
}

.approval-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.approval-countdown {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid rgba(var(--warning-rgb), 0.34);
  border-radius: 999px;
  background: rgba(var(--warning-rgb), 0.14);
  color: $warning;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1.3;
}

.approval-countdown-expired {
  border-color: rgba(var(--error-rgb), 0.32);
  background: rgba(var(--error-rgb), 0.1);
  color: var(--error);
}

.approval-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-secondary;
}

.approval-command {
  display: block;
  margin-top: 8px;
  max-height: 96px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: $text-primary;
  background: rgba(var(--text-muted-rgb), 0.08);
  border: 1px solid rgba(var(--text-muted-rgb), 0.18);
  border-radius: 6px;
  padding: 8px 10px;
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(var(--text-muted-rgb), 0.16);
}


.clarify-bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  max-width: 960px;
  margin: 0 auto;
  padding: 12px 14px;
  border: 1px solid rgba(var(--text-muted-rgb), 0.2);
  border-left: 3px solid rgba(var(--accent-primary-rgb), 0.42);
  border-radius: $radius-md;
  background: $bg-card;
  background: color-mix(in srgb, var(--bg-card) 70%, transparent);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.14),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(18px) saturate(1.18);
  -webkit-backdrop-filter: blur(18px) saturate(1.18);
}

.clarify-icon {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.14);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(var(--accent-primary-rgb), 0.1);
}

.clarify-content {
  flex: 1;
  min-width: 0;
}

.clarify-main {
  min-width: 0;
}

.clarify-kicker {
  margin-bottom: 2px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-primary);
}

.clarify-title {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
  color: $text-primary;
}

.clarify-countdown {
  display: inline-flex;
  align-items: center;
  margin-top: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: var(--accent-primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
}

.clarify-countdown.expired {
  background: rgba(239, 68, 68, 0.12);
  color: var(--error-color, #ef4444);
}

.clarify-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: $text-secondary;
}

.clarify-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(var(--text-muted-rgb), 0.16);
}

.clarify-input-row {
  display: flex;
  flex: 1;
  width: 100%;
  min-width: 0;
  gap: 8px;
  align-items: center;

  :deep(.n-input) {
    flex: 1 1 auto;
    min-width: 0;
  }

  :deep(.n-button) {
    flex: 0 0 auto;
  }
}

.clarify-actions-open {
  display: flex;
  width: 100%;
}
@media (max-width: 768px) {
  .pending-interaction-stack {
    width: calc(100% - 20px);
    max-height: min(45vh, 320px);
    margin-bottom: 8px;
  }

  .approval-bar {
    margin: 0;
    padding: 10px;
  }

  .approval-icon {
    flex-basis: 28px;
    width: 28px;
    height: 28px;
  }

  .approval-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .approval-actions :deep(.n-button) {
    width: 100%;
  }

  .clarify-bar {
    margin: 0;
    padding: 10px;
  }

  .clarify-icon {
    flex-basis: 28px;
    width: 28px;
    height: 28px;
  }

  .clarify-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .clarify-actions-open {
    display: flex;
    grid-template-columns: none;
  }

  .clarify-actions :deep(.n-button) {
    width: 100%;
  }

  .clarify-actions-open :deep(.n-button) {
    width: auto;
  }
}

@media (max-width: 420px) {
  .approval-bar {
    gap: 8px;
  }

  .approval-actions {
    grid-template-columns: 1fr;
  }

  .clarify-bar {
    gap: 8px;
  }

  .clarify-actions {
    grid-template-columns: 1fr;
  }

  .clarify-input-row {
    flex-direction: column;
    align-items: stretch;
  }

  .clarify-actions-open :deep(.n-button) {
    width: 100%;
  }
}

@keyframes rainbow-glow {
  0% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    border-color: #ff6b6b;
    color: #ff6b6b;
  }
  16.66% {
    box-shadow:
      0 0 0 2px #feca57,
      0 0 10px rgba(254, 202, 87, 0.4),
      0 0 20px rgba(254, 202, 87, 0.2);
    border-color: #feca57;
    color: #feca57;
  }
  33.33% {
    box-shadow:
      0 0 0 2px #48dbfb,
      0 0 10px rgba(72, 219, 251, 0.4),
      0 0 20px rgba(72, 219, 251, 0.2);
    border-color: #48dbfb;
    color: #48dbfb;
  }
  50% {
    box-shadow:
      0 0 0 2px #ff9ff3,
      0 0 10px rgba(255, 159, 243, 0.4),
      0 0 20px rgba(255, 159, 243, 0.2);
    border-color: #ff9ff3;
    color: #ff9ff3;
  }
  66.66% {
    box-shadow:
      0 0 0 2px #54a0ff,
      0 0 10px rgba(84, 160, 255, 0.4),
      0 0 20px rgba(84, 160, 255, 0.2);
    border-color: #54a0ff;
    color: #54a0ff;
  }
  83.33% {
    box-shadow:
      0 0 0 2px #5f27cd,
      0 0 10px rgba(95, 39, 205, 0.4),
      0 0 20px rgba(95, 39, 205, 0.2);
    border-color: #5f27cd;
    color: #5f27cd;
  }
  100% {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    border-color: #ff6b6b;
    color: #ff6b6b;
  }
}

@media (max-width: $breakpoint-mobile) {
  .drawer-button-wrapper {
    right: 12px;
  }

  .drawer-button {
    width: 36px;
    height: 36px;

    svg {
      width: 16px;
      height: 16px;
    }
  }
}
</style>
