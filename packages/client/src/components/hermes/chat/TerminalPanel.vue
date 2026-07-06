<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getApiKey, getBaseUrlValue } from "@/api/client";
import { useSettingsStore } from "@/stores/hermes/settings";
import { useChatStore } from "@/stores/hermes/chat";
import { NButton, NInputNumber, NPopconfirm, NTooltip, NSelect, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import type { ITheme } from "@xterm/xterm";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_FAMILY_OPTIONS,
  sanitizeTerminalFontFamily,
  sanitizeTerminalFontSize,
} from "@/utils/terminal-font-options";

const { t } = useI18n();
const message = useMessage();
const settingsStore = useSettingsStore();
const chatStore = useChatStore();

const props = defineProps<{ visible?: boolean; initialCommand?: string }>();

// ─── Terminal themes ────────────────────────────────────────────

const TERMINAL_THEMES: Record<string, { label: string; theme: ITheme }> = {
  default: {
    label: "Default",
    theme: {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#4cc9f0",
      cursorAccent: "#1a1a2e",
      selectionBackground: "rgba(76, 201, 240, 0.3)",
      black: "#000000", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  "solarized-dark": {
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496",
      cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "rgba(147, 161, 161, 0.3)",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  "tokyo-night": {
    label: "Tokyo Night",
    theme: {
      background: "#1a1b26", foreground: "#a9b1d6",
      cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "rgba(192, 202, 245, 0.2)",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  "github-dark": {
    label: "GitHub Dark",
    theme: {
      background: "#0d1117", foreground: "#c9d1d9",
      cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "rgba(88, 166, 255, 0.25)",
      black: "#484f58", red: "#ff7b72", green: "#7ee787", yellow: "#ffa657",
      blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#a5d6ff", white: "#c9d1d9",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#58a6ff", brightMagenta: "#bc8cff",
      brightCyan: "#79c0ff", brightWhite: "#f0f6fc",
    },
  },
};

const STORAGE_KEY_THEME = "hermes_terminal_theme";

// ─── Types ──────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  shell: string;
  pid: number;
  title: string;
  createdAt: number;
  exited: boolean;
  chatSessionId: string;
  cwd?: string;
}

interface PendingCreateContext {
  chatSessionId: string;
  cwd: string;
}

// ─── State ──────────────────────────────────────────────────────

const terminalRef = ref<HTMLDivElement | null>(null);
const sessions = ref<SessionInfo[]>([]);
const activeTerminalSessionId = ref<string | null>(null);
const selectedTheme = ref(localStorage.getItem(STORAGE_KEY_THEME) || "default");
const connectionError = ref<string | null>(null);
const isConnecting = ref(false);
const showSidebar = ref(false);
const terminalSessionListCollapsed = ref(false);
const isMobileViewport = ref(
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(max-width: 768px)").matches,
);
const showTerminalSessionList = computed(() => settingsStore.display.show_terminal_session_list !== false);
const showTerminalSidebarPanel = computed(() =>
  showTerminalSessionList.value && (isMobileViewport.value || !terminalSessionListCollapsed.value),
);
const showDesktopSessionCollapseToggle = computed(() => showTerminalSessionList.value && !isMobileViewport.value);
const TERMINAL_SIDEBAR_MIN_WIDTH = 96;
const TERMINAL_SIDEBAR_MAX_WIDTH = 320;
const terminalSidebarWidth = ref(180);
const isTerminalSidebarResizing = ref(false);
const terminalSidebarStyle = computed(() => ({
  "--terminal-sidebar-width": `${terminalSidebarWidth.value}px`,
}));
const mobileShortcutBottomOffset = ref(0);
const mobileShortcutHidden = ref(false);
const ctrlLatchActive = ref(false);
const shiftLatchActive = ref(false);

watch(showTerminalSessionList, (visible) => {
  if (!visible) {
    showSidebar.value = false;
    terminalSessionListCollapsed.value = false;
  }
});

function toggleTerminalSessionList(): void {
  const nextCollapsed = !terminalSessionListCollapsed.value;
  terminalSessionListCollapsed.value = nextCollapsed;
  showSidebar.value = isMobileViewport.value && !nextCollapsed;
}

function setTerminalSidebarWidth(width: number): void {
  terminalSidebarWidth.value = Math.min(
    Math.max(Math.round(width), TERMINAL_SIDEBAR_MIN_WIDTH),
    TERMINAL_SIDEBAR_MAX_WIDTH,
  );
  requestAnimationFrame(() => {
    tryFit();
    sendResize();
  });
}

function handleTerminalSidebarPointerMove(event: PointerEvent): void {
  if (!isTerminalSidebarResizing.value) return;
  const rect = terminalRef.value?.closest(".terminal-panel-drawer")?.getBoundingClientRect();
  if (!rect) return;
  setTerminalSidebarWidth(event.clientX - rect.left);
}

function stopTerminalSidebarResize(): void {
  if (!isTerminalSidebarResizing.value) return;
  isTerminalSidebarResizing.value = false;
  document.removeEventListener("pointermove", handleTerminalSidebarPointerMove);
  document.removeEventListener("pointerup", stopTerminalSidebarResize);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function startTerminalSidebarResize(event: PointerEvent): void {
  if (isMobileViewport.value) return;
  event.preventDefault();
  isTerminalSidebarResizing.value = true;
  document.addEventListener("pointermove", handleTerminalSidebarPointerMove);
  document.addEventListener("pointerup", stopTerminalSidebarResize);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  handleTerminalSidebarPointerMove(event);
}

function handleTerminalSidebarResizeKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 32 : 16;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    setTerminalSidebarWidth(terminalSidebarWidth.value - step);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    setTerminalSidebarWidth(terminalSidebarWidth.value + step);
  }
}

let ws: WebSocket | null = null;
const termMap = new Map<string, { term: Terminal; fitAddon: FitAddon; opened: boolean }>();
let activeTerm: Terminal | null = null;
let activeFitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let touchScrollLastY: number | null = null;
let touchScrollRemainder = 0;
const TOUCH_SCROLL_LINE_PX = 18;
const INITIAL_COMMAND_CHUNK_SIZE = 128;
const INITIAL_COMMAND_CHUNK_DELAY_MS = 8;
const initialCommandSent = ref(false);
const initialCommandTimers = new Set<ReturnType<typeof setTimeout>>();
const pendingCreateContexts: PendingCreateContext[] = [];
const FALLBACK_CHAT_SESSION_ID = "__global_terminal__";

// ─── Computed ──────────────────────────────────────────────────

const activeChatSessionId = computed(() => chatStore.activeSessionId || FALLBACK_CHAT_SESSION_ID);
const activeWorkspaceRoot = computed(() => {
  const activeId = chatStore.activeSessionId;
  return chatStore.activeSession?.workspace
    || chatStore.sessions.find(session => session.id === activeId)?.workspace
    || '';
});
const currentSessions = computed(() => sessions.value.filter((s) => s.chatSessionId === activeChatSessionId.value));
const activeSession = computed(
  () => currentSessions.value.find((s) => s.id === activeTerminalSessionId.value) || null,
);

const themeOptions = computed(() =>
  Object.entries(TERMINAL_THEMES).map(([key, val]) => ({
    label: val.label,
    value: key,
  })),
);

const terminalBg = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.theme.background ?? "#1a1a2e",
);

const terminalFontSize = computed(() =>
  sanitizeTerminalFontSize(settingsStore.display.terminal_font_size),
);

const terminalFontFamily = computed(() =>
  sanitizeTerminalFontFamily(settingsStore.display.terminal_font_family),
);

function currentAppliedFontSize(): number {
  return sanitizeTerminalFontSize(
    typeof activeTerm?.options.fontSize === "number"
      ? activeTerm.options.fontSize
      : terminalFontSize.value,
  );
}

function currentAppliedFontFamily(): string {
  return sanitizeTerminalFontFamily(
    typeof activeTerm?.options.fontFamily === "string"
      ? activeTerm.options.fontFamily
      : terminalFontFamily.value,
  );
}

function saveTerminalFontSetting(values: Record<string, number | string>): void {
  const nextSize = typeof values.terminal_font_size === "number"
    ? sanitizeTerminalFontSize(values.terminal_font_size)
    : currentAppliedFontSize();
  const nextFamily = typeof values.terminal_font_family === "string"
    ? sanitizeTerminalFontFamily(values.terminal_font_family)
    : currentAppliedFontFamily();

  settingsStore.updateLocal('display', values);
  applyTerminalFontSettings(nextSize, nextFamily);
  void settingsStore.saveSection('display', values).catch((err: any) => {
    message.error(err?.message || t('common.saveFailed'));
  });
}

function handleTerminalFontSizeChange(value: number | null): void {
  if (value == null) return;
  saveTerminalFontSetting({ terminal_font_size: sanitizeTerminalFontSize(value) });
}

function handleTerminalFontFamilyChange(value: string | null): void {
  saveTerminalFontSetting({
    terminal_font_family: sanitizeTerminalFontFamily(value),
  });
}

const mobileShortcutKeyRows = [
  [
    { label: "Ctrl", toggle: "ctrl" },
    { label: "Shift", toggle: "shift" },
    { label: "Tab", data: "\t" },
    { label: "Esc", data: "\x1b" },
    { label: "Home", data: "\x1b[H" },
    { label: "End", data: "\x1b[F" },
  ],
  [
    { label: "PgUp", data: "\x1b[5~" },
    { label: "PgDn", data: "\x1b[6~" },
    { label: "←", data: "\x1b[D" },
    { label: "→", data: "\x1b[C" },
    { label: "↑", data: "\x1b[A" },
    { label: "↓", data: "\x1b[B" },
  ],
];

// ─── WebSocket ──────────────────────────────────────────────────

function formatHostForPort(hostname: string, port: number): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return `${hostname}:${port}`;
  }
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

function buildWsUrl(): string {
  const token = getApiKey();
  const base = getBaseUrlValue();
  const wsProtocol = base
    ? base.startsWith("https")
      ? "wss:"
      : "ws:"
    : location.protocol === "https:"
      ? "wss:"
      : "ws:";

  if (base) {
    return `${wsProtocol}//${new URL(base).host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }

  const directDevPort = import.meta.env.VITE_HERMES_DIRECT_WS_PORT;
  const host = import.meta.env.DEV && directDevPort
    ? formatHostForPort(location.hostname, Number(directDevPort))
    : location.host;
  return `${wsProtocol}//${host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

function connect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connectionError.value = t('terminal.connectionFailed');
    isConnecting.value = false;
    return;
  }

  const url = buildWsUrl();
  connectionError.value = null;
  isConnecting.value = true;
  reconnectAttempts++;

  ws = new WebSocket(url);

  ws.onopen = () => {
    isConnecting.value = false;
    connectionError.value = null;
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (data.charCodeAt(0) === 0x7b) {
      try {
        handleControl(JSON.parse(data));
      } catch {}
    } else {
      activeTerm?.write(data);
    }
  };

  ws.onclose = (event) => {
    isConnecting.value = false;

    // 如果是正常关闭（code 1000）或认证失败，不重连
    if (event.code === 1000 || event.code === 1003 || event.code === 1008) {
      connectionError.value = t('terminal.connectionClosed');
      return;
    }

    // 其他情况尝试重连
    setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error('[Terminal] WebSocket error:', error);
    connectionError.value = t('terminal.connectionError');
  };
}

function send(data: object | string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

function sendTerminalInput(data: string) {
  if (!data) return;
  send({ type: "input", data });
  activeTerm?.focus();
}

function mapCtrlInput(data: string): string {
  if (!ctrlLatchActive.value || data.length !== 1) return data;
  ctrlLatchActive.value = false;
  shiftLatchActive.value = false;
  const ch = data.toLowerCase();
  if (ch >= "a" && ch <= "z") {
    return String.fromCharCode(ch.charCodeAt(0) - 96);
  }
  const controlMap: Record<string, string> = {
    "@": "\x00",
    "[": "\x1b",
    "\\": "\x1c",
    "]": "\x1d",
    "^": "\x1e",
    "_": "\x1f",
    "?": "\x7f",
  };
  return controlMap[data] ?? data;
}

function mapShiftInput(data: string): string {
  if (!shiftLatchActive.value || data.length !== 1) return data;
  shiftLatchActive.value = false;
  if (data >= "a" && data <= "z") {
    return data.toUpperCase();
  }
  return data;
}

function mapShortcutInput(data: string): string {
  return mapShiftInput(mapCtrlInput(data));
}

function handleShortcutKey(key: { data?: string; toggle?: string }) {
  if (key.toggle === "ctrl") {
    ctrlLatchActive.value = !ctrlLatchActive.value;
    if (ctrlLatchActive.value) shiftLatchActive.value = false;
    activeTerm?.focus();
    return;
  }
  if (key.toggle === "shift") {
    shiftLatchActive.value = !shiftLatchActive.value;
    if (shiftLatchActive.value) ctrlLatchActive.value = false;
    activeTerm?.focus();
    return;
  }
  ctrlLatchActive.value = false;
  shiftLatchActive.value = false;
  sendTerminalInput(key.data || "");
}

function clearMobileShortcutState() {
  ctrlLatchActive.value = false;
  shiftLatchActive.value = false;
  touchScrollLastY = null;
  touchScrollRemainder = 0;
}

function blurActiveTerminal() {
  activeTerm?.blur();
  const terminalElement = activeTerm?.element;
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (focusedElement && terminalElement?.contains(focusedElement)) {
    focusedElement.blur();
  }
}

function setMobileShortcutHidden(hidden: boolean) {
  mobileShortcutHidden.value = hidden;
  clearMobileShortcutState();
  if (props.visible) activeTerm?.focus();
}

// ─── Control message handlers ──────────────────────────────────

function handleControl(msg: any) {
  switch (msg.type) {
    case "created": {
      reconnectAttempts = 0;
      const pendingContext = pendingCreateContexts.shift();
      const serverChatSessionId = typeof msg.chatSessionId === 'string' && msg.chatSessionId ? msg.chatSessionId : '';
      const workspaceRoot = activeWorkspaceRoot.value;
      const serverCwd = typeof msg.cwd === 'string' ? msg.cwd : '';
      if (!pendingContext && !serverChatSessionId && workspaceRoot && serverCwd && serverCwd !== workspaceRoot) {
        send({ type: "close", sessionId: msg.id });
        createSessionForChat(activeChatSessionId.value, workspaceRoot);
        break;
      }
      const context = pendingContext || {
        chatSessionId: serverChatSessionId || activeChatSessionId.value,
        cwd: typeof msg.cwd === 'string' ? msg.cwd : workspaceRoot,
      };
      const chatSessionCount = sessions.value.filter((session) => session.chatSessionId === context.chatSessionId).length;
      sessions.value.push({
        id: msg.id,
        shell: msg.shell,
        pid: msg.pid,
        title: `${msg.shell} #${chatSessionCount + 1}`,
        createdAt: Date.now(),
        exited: false,
        chatSessionId: context.chatSessionId,
        cwd: context.cwd,
      });
      if (context.chatSessionId === activeChatSessionId.value) {
        switchSession(msg.id);
        runInitialCommand();
      }
      break;
    }

    case "exited": {
      const s = sessions.value.find((s) => s.id === msg.id);
      if (s) {
        s.exited = true;
        if (activeTerminalSessionId.value === msg.id) {
          activeTerm?.write(
            `\r\n\x1b[90m[${t("terminal.processExited", { code: msg.exitCode })}]\x1b[0m\r\n`,
          );
        }
      }
      break;
    }

    case "error":
      pendingCreateContexts.shift();
      message.error(msg.message);
      break;
  }
}

// ─── Session actions ────────────────────────────────────────────

function createSession() {
  createSessionForChat(activeChatSessionId.value, activeWorkspaceRoot.value);
}

function createSessionForChat(chatSessionId: string, cwd: string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  pendingCreateContexts.push({ chatSessionId, cwd });
  send({ type: "create", cwd: cwd || undefined, chatSessionId });
}

function runInitialCommand() {
  const command = props.initialCommand?.trim();
  if (!command || initialCommandSent.value) return;
  initialCommandSent.value = true;
  scheduleInitialCommandChunk(`${command}\r`, 0, 100);
}

function scheduleInitialCommandChunk(command: string, offset: number, delay: number) {
  const timer = setTimeout(() => {
    initialCommandTimers.delete(timer);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const nextOffset = Math.min(offset + INITIAL_COMMAND_CHUNK_SIZE, command.length);
    send({ type: "input", data: command.slice(offset, nextOffset) });
    if (nextOffset < command.length) {
      scheduleInitialCommandChunk(command, nextOffset, INITIAL_COMMAND_CHUNK_DELAY_MS);
    }
  }, delay);
  initialCommandTimers.add(timer);
}

function getOrCreateTerm(id: string): { term: Terminal; fitAddon: FitAddon } {
  let entry = termMap.get(id);
  if (!entry) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: terminalFontSize.value,
      fontFamily: terminalFontFamily.value,
      theme: { ...TERMINAL_THEMES[selectedTheme.value].theme },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(mapShortcutInput(data));
      }
    });
    entry = { term, fitAddon, opened: false };
    termMap.set(id, entry);
  }
  return entry;
}

function switchSession(id: string) {
  if (activeTerminalSessionId.value === id) return;
  activeTerminalSessionId.value = id;
  const entry = getOrCreateTerm(id);
  activeTerm = entry.term;
  activeFitAddon = entry.fitAddon;
  mountActiveTerminal();
  send({ type: "switch", sessionId: id });
}

function closeSession(id: string) {
  const closingSession = sessions.value.find((s) => s.id === id);
  send({ type: "close", sessionId: id });
  sessions.value = sessions.value.filter((s) => s.id !== id);
  const entry = termMap.get(id);
  if (entry) {
    entry.term.dispose();
    termMap.delete(id);
  }
  if (activeTerminalSessionId.value === id) {
    const replacement = sessions.value.find((s) => s.chatSessionId === (closingSession?.chatSessionId || activeChatSessionId.value) && !s.exited)
      || sessions.value.find((s) => s.chatSessionId === (closingSession?.chatSessionId || activeChatSessionId.value))
      || null;
    activeTerminalSessionId.value = replacement?.id || null;
    activeTerm = null;
    activeFitAddon = null;
    if (activeTerminalSessionId.value) {
      switchSession(activeTerminalSessionId.value);
    } else {
      unmountActiveTerminal();
      createSessionForChat(closingSession?.chatSessionId || activeChatSessionId.value, activeWorkspaceRoot.value);
    }
  }
}

function ensureActiveChatTerminalSession() {
  if (!props.visible || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (sessions.value.length === 0) return;
  const activeId = activeTerminalSessionId.value;
  if (activeId && currentSessions.value.some((s) => s.id === activeId && !s.exited)) return;

  const nextSession = currentSessions.value.find((s) => !s.exited) || currentSessions.value[0] || null;
  if (nextSession) {
    switchSession(nextSession.id);
    return;
  }

  activeTerminalSessionId.value = null;
  activeTerm = null;
  activeFitAddon = null;
  unmountActiveTerminal();
  createSessionForChat(activeChatSessionId.value, activeWorkspaceRoot.value);
}

// ─── Terminal mount/unmount ─────────────────────────────────────

function mountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);

  const entry = termMap.get(activeTerminalSessionId.value!);
  if (!entry) return;

  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
  } else {
    const termEl = entry.term.element;
    if (termEl) {
      container.appendChild(termEl);
    }
  }

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    tryFit();
    sendResize();
  });
  resizeObserver.observe(terminalRef.value);

  setTimeout(() => tryFit(), 50);
  setTimeout(() => tryFit(), 200);
}

function unmountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);
}

function tryFit() {
  if (!activeFitAddon) return;
  try {
    activeFitAddon.fit();
  } catch {}
}

function applyTermFontOptions(entry: { term: Terminal; fitAddon: FitAddon }, fontSize: number, fontFamily: string) {
  entry.term.options.fontSize = fontSize;
  entry.term.options.fontFamily = fontFamily;
  if (entry.term.element) {
    entry.term.element.style.fontSize = `${fontSize}px`;
    entry.term.element.style.fontFamily = fontFamily;
  }
  try {
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  } catch {}
  try {
    entry.fitAddon.fit();
  } catch {}
  requestAnimationFrame(() => {
    try {
      entry.fitAddon.fit();
    } catch {}
    try {
      entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
    } catch {}
    sendResize();
  });
}

function applyTerminalFontSettings(
  fontSize = terminalFontSize.value,
  fontFamily = terminalFontFamily.value,
) {
  for (const entry of termMap.values()) {
    applyTermFontOptions(entry, fontSize, fontFamily);
  }
  sendResize();
}

function sendResize() {
  if (!activeTerm || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    send({
      type: "resize",
      cols: activeTerm.cols,
      rows: activeTerm.rows,
    });
  } catch {}
}

function handleTerminalTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) {
    touchScrollLastY = null;
    touchScrollRemainder = 0;
    return;
  }
  touchScrollLastY = event.touches[0].clientY;
  touchScrollRemainder = 0;
}

function handleTerminalTouchMove(event: TouchEvent) {
  if (!activeTerm || event.touches.length !== 1 || touchScrollLastY === null) return;
  const nextY = event.touches[0].clientY;
  touchScrollRemainder += touchScrollLastY - nextY;
  touchScrollLastY = nextY;

  const lines = Math.trunc(touchScrollRemainder / TOUCH_SCROLL_LINE_PX);
  if (lines === 0) return;

  activeTerm.scrollLines(lines);
  touchScrollRemainder -= lines * TOUCH_SCROLL_LINE_PX;
  event.preventDefault();
}

function handleTerminalTouchEnd() {
  touchScrollLastY = null;
  touchScrollRemainder = 0;
}

// ─── Theme ───────────────────────────────────────────────────────

function applyTheme(themeName: string) {
  selectedTheme.value = themeName;
  localStorage.setItem(STORAGE_KEY_THEME, themeName);
  const themeObj = TERMINAL_THEMES[themeName]?.theme;
  if (!themeObj) return;
  for (const entry of termMap.values()) {
    entry.term.options.theme = { ...themeObj };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateMobileShortcutBottomOffset() {
  const viewport = window.visualViewport;
  if (!viewport) {
    mobileShortcutBottomOffset.value = 0;
    return;
  }
  mobileShortcutBottomOffset.value = Math.max(
    0,
    Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
  );
}

let mobileViewportQuery: MediaQueryList | null = null;

function handleMobileViewportChange(event?: MediaQueryListEvent) {
  isMobileViewport.value = event?.matches ?? mobileViewportQuery?.matches ?? false;
  if (!isMobileViewport.value) {
    showSidebar.value = false;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────

let hasConnected = false;

watch(() => props.visible, (visible) => {
  if (visible && !hasConnected && !ws) {
    hasConnected = true;
    connect();
  }
  if (visible) {
    updateMobileShortcutBottomOffset();
    ensureActiveChatTerminalSession();
  } else {
    showSidebar.value = false;
    clearMobileShortcutState();
    mobileShortcutBottomOffset.value = 0;
    blurActiveTerminal();
  }
}, { immediate: true });

watch(activeChatSessionId, () => {
  ensureActiveChatTerminalSession();
});

watch([terminalFontSize, terminalFontFamily], () => {
  applyTerminalFontSettings();
});

onMounted(() => {
  updateMobileShortcutBottomOffset();
  if (typeof window.matchMedia === "function") {
    mobileViewportQuery = window.matchMedia("(max-width: 768px)");
    handleMobileViewportChange();
    mobileViewportQuery.addEventListener?.("change", handleMobileViewportChange);
  }
  window.visualViewport?.addEventListener("resize", updateMobileShortcutBottomOffset);
  window.visualViewport?.addEventListener("scroll", updateMobileShortcutBottomOffset);
  window.addEventListener("resize", updateMobileShortcutBottomOffset);
});

onUnmounted(() => {
  stopTerminalSidebarResize();
  mobileViewportQuery?.removeEventListener?.("change", handleMobileViewportChange);
  mobileViewportQuery = null;
  window.visualViewport?.removeEventListener("resize", updateMobileShortcutBottomOffset);
  window.visualViewport?.removeEventListener("scroll", updateMobileShortcutBottomOffset);
  window.removeEventListener("resize", updateMobileShortcutBottomOffset);
  for (const timer of initialCommandTimers) clearTimeout(timer);
  initialCommandTimers.clear();
  unmountActiveTerminal();
  for (const entry of termMap.values()) {
    entry.term.dispose();
  }
  termMap.clear();
  activeTerm = null;
  activeFitAddon = null;
  ws?.close();
  ws = null;
});
</script>

<template>
  <div class="terminal-panel-drawer">
    <div
      v-if="showSidebar && showTerminalSidebarPanel"
      class="sidebar-overlay"
      @click="showSidebar = false"
    ></div>
    <div
      v-if="showTerminalSidebarPanel"
      class="terminal-sidebar"
      :class="{ 'mobile-visible': showSidebar }"
      :style="terminalSidebarStyle"
    >
      <div class="sidebar-header">
        <span class="sidebar-title">{{ t("terminal.sessions") }}</span>
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary size="tiny" @click="createSession" circle>
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </template>
            </NButton>
          </template>
          {{ t("terminal.newTab") }}
        </NTooltip>
      </div>
      <div class="session-list">
        <div v-if="connectionError" class="session-error">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{{ connectionError }}</span>
          <NButton size="tiny" @click="connect">{{ t("common.retry") }}</NButton>
        </div>
        <div v-else-if="currentSessions.length === 0" class="session-empty">
          <template v-if="isConnecting">
            {{ t("common.loading") }}
          </template>
          <template v-else>
            {{ t("terminal.noSessions") }}
          </template>
        </div>
        <button
          v-for="s in currentSessions"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === activeTerminalSessionId, exited: s.exited }"
          @click="switchSession(s.id)"
        >
          <div class="session-item-content">
            <span class="session-item-title">{{ s.title }}</span>
            <span class="session-item-meta">
              <span class="session-item-shell">{{ s.shell }}</span>
              <span v-if="s.exited" class="session-item-status">{{
                t("terminal.sessionExited")
              }}</span>
              <span v-else class="session-item-time">{{
                formatTime(s.createdAt)
              }}</span>
            </span>
          </div>
          <NPopconfirm v-if="currentSessions.length > 1" @positive-click="closeSession(s.id)">
            <template #trigger>
              <button class="session-item-delete" @click.stop>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </template>
            {{ t("terminal.closeSession") }}
          </NPopconfirm>
        </button>
      </div>
    </div>
    <button
      v-if="showTerminalSidebarPanel && !isMobileViewport"
      type="button"
      class="terminal-sidebar-resize-handle"
      :class="{ resizing: isTerminalSidebarResizing }"
      :aria-label="t('drawer.resize')"
      :title="t('drawer.resize')"
      @pointerdown="startTerminalSidebarResize"
      @keydown="handleTerminalSidebarResizeKeydown"
    ></button>

    <div class="terminal-main">
      <header class="terminal-header">
        <span v-if="activeSession" class="header-session-title">{{
          activeSession.title
        }}</span>
        <div class="header-actions">
          <NButton
            v-if="showDesktopSessionCollapseToggle"
            size="small"
            quaternary
            circle
            @click="toggleTerminalSessionList"
            class="session-list-collapse-toggle"
            :title="terminalSessionListCollapsed ? t('terminal.showSessions') : t('terminal.hideSessions')"
            :aria-label="terminalSessionListCollapsed ? t('terminal.showSessions') : t('terminal.hideSessions')"
          >
            <span class="session-list-collapse-glyph" aria-hidden="true">
              {{ terminalSessionListCollapsed ? '>' : '<' }}
            </span>
          </NButton>
          <NButton
            v-if="showTerminalSidebarPanel"
            size="small"
            @click="showSidebar = !showSidebar"
            class="sidebar-toggle"
          >
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </template>
            {{ t("terminal.sessions") }}
          </NButton>
          <NSelect
            :value="selectedTheme"
            :options="themeOptions"
            size="small"
            :consistent-menu-width="false"
            class="theme-select"
            @update:value="applyTheme"
          />
          <div class="terminal-font-controls" :aria-label="t('settings.display.terminalFontSize')">
            <span class="terminal-font-label" aria-hidden="true">Aa</span>
            <NInputNumber
              :value="terminalFontSize"
              :min="9"
              :max="32"
              :step="1"
              size="small"
              class="terminal-font-size-input"
              :title="t('settings.display.terminalFontSize')"
              :aria-label="t('settings.display.terminalFontSize')"
              @update:value="handleTerminalFontSizeChange"
            />
            <NSelect
              :value="terminalFontFamily"
              :options="TERMINAL_FONT_FAMILY_OPTIONS"
              size="small"
              class="terminal-font-family-input"
              :placeholder="DEFAULT_TERMINAL_FONT_FAMILY"
              :title="t('settings.display.terminalFontFamily')"
              :aria-label="t('settings.display.terminalFontFamily')"
              :consistent-menu-width="false"
              filterable
              tag
              clearable
              @update:value="handleTerminalFontFamilyChange"
            />
          </div>
          <NButton size="small" @click="createSession">
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </template>
            {{ t("terminal.newTab") }}
          </NButton>
        </div>
      </header>
      <div class="terminal-container">
        <div
          ref="terminalRef"
          class="terminal-xterm"
          :style="{ backgroundColor: terminalBg }"
          @touchstart="handleTerminalTouchStart"
          @touchmove="handleTerminalTouchMove"
          @touchend="handleTerminalTouchEnd"
          @touchcancel="handleTerminalTouchEnd"
        />
        <div
          v-if="visible"
          v-show="!mobileShortcutHidden"
          class="mobile-shortcut-bar"
          :aria-label="t('terminal.mobileShortcutBar')"
          :style="{ '--terminal-mobile-keyboard-offset': `${mobileShortcutBottomOffset}px` }"
        >
          <button
            type="button"
            class="mobile-shortcut-toggle mobile-shortcut-hide"
            :aria-label="t('terminal.hideMobileShortcutBar')"
            :title="t('terminal.hideMobileShortcutBar')"
            @click="setMobileShortcutHidden(true)"
          >
            ˅
          </button>
          <div
            v-for="(row, rowIndex) in mobileShortcutKeyRows"
            :key="rowIndex"
            class="mobile-shortcut-row"
          >
            <button
              v-for="key in row"
              :key="key.label"
              type="button"
              class="mobile-shortcut-key"
              :class="{
                active:
                  (key.toggle === 'ctrl' && ctrlLatchActive) ||
                  (key.toggle === 'shift' && shiftLatchActive),
              }"
              @click="handleShortcutKey(key)"
            >
              {{ key.label }}
            </button>
          </div>
        </div>
        <button
          v-if="visible"
          v-show="mobileShortcutHidden"
          type="button"
          class="mobile-shortcut-toggle mobile-shortcut-show"
          :aria-label="t('terminal.showMobileShortcutBar')"
          :title="t('terminal.showMobileShortcutBar')"
          :style="{ '--terminal-mobile-keyboard-offset': `${mobileShortcutBottomOffset}px` }"
          @click="setMobileShortcutHidden(false)"
        >
          ⌨
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

$terminal-panel-header-height: 47px;

.terminal-panel-drawer {
  display: flex;
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.sidebar-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 50;

  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }
}

.terminal-sidebar {
  width: var(--terminal-sidebar-width, 180px);
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;

  @media (max-width: $breakpoint-mobile) {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 80%;
    max-width: 300px;
    z-index: 51;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.15);
    transform: translateX(-100%);
    transition: transform 0.3s ease;

    &.mobile-visible {
      transform: translateX(0);
    }
  }
}

.terminal-sidebar-resize-handle {
  flex: 0 0 6px;
  width: 6px;
  padding: 0;
  border: 0;
  border-right: 1px solid $border-color;
  appearance: none;
  background: transparent;
  cursor: col-resize;
  touch-action: none;

  &:hover,
  &:focus-visible,
  &.resizing {
    background: rgba(var(--accent-primary-rgb), 0.12);
    outline: none;
  }
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: $terminal-panel-header-height;
  padding: 12px;
  flex-shrink: 0;
  border-bottom: 1px solid $border-color;
  box-sizing: border-box;
}

.sidebar-title {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-empty {
  padding: 16px 8px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.session-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 12px;
  font-size: 12px;
  color: $error;
  text-align: center;

  svg {
    width: 32px;
    height: 32px;
    opacity: 0.8;
  }

  span {
    flex: 1;
  }
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: none;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;
  color: $text-secondary;
  transition: all $transition-fast;
  margin-bottom: 2px;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;

    .session-item-delete {
      opacity: 1;
    }
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.1);
    color: $text-primary;
    font-weight: 500;
  }

  &.exited {
    opacity: 0.5;
  }
}

.session-item-content {
  flex: 1;
  overflow: hidden;
}

.session-item-title {
  display: block;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.session-item-shell {
  font-size: 9px;
  color: $accent-primary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
}

.session-item-time,
.session-item-status {
  font-size: 10px;
  color: $text-muted;
}

.session-item-delete {
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
    background: rgba(var(--error-rgb), 0.1);
  }
}

.terminal-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: $terminal-panel-header-height;
  padding: 9px 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
  min-width: 0;
  box-sizing: border-box;
}

.header-session-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}

.theme-select {
  width: 120px;
}

.terminal-font-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.terminal-font-label {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 700;
  color: $text-muted;
  letter-spacing: 0.02em;
}

.terminal-font-size-input {
  width: 76px;
  flex: 0 0 auto;
}

.terminal-font-family-input {
  width: clamp(140px, 18vw, 240px);
  min-width: 0;
}

.session-list-collapse-toggle {
  flex: 0 0 28px;
  width: 28px;
  min-width: 28px;
  height: 28px;
  padding: 0;
  overflow: visible;
}

.session-list-collapse-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-family: $font-code;
  font-size: 16px;
  font-weight: 800;
  line-height: 1;
}

.sidebar-toggle {
  @media (min-width: $breakpoint-mobile + 1) {
    display: none;
  }
}

.terminal-container {
  flex: 1;
  margin: 8px;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.terminal-xterm {
  flex: 1;
  min-height: 0;
  min-width: 0;
  border-radius: $radius-md;
  overflow: hidden;
  border: 1px solid $border-color;

  :deep(.xterm) {
    height: 100%;
    padding: 8px;
  }

  :deep(.xterm-viewport) {
    overflow-y: scroll !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
    background-color: transparent !important;
  }

  :deep(.xterm-viewport::-webkit-scrollbar) {
    display: none !important;
  }

  :deep(.xterm-screen) {
    background-color: transparent !important;
  }

  :deep(.xterm-scrollable-element) {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }

  :deep(.xterm-scrollable-element::-webkit-scrollbar) {
    display: none !important;
  }
}

.mobile-shortcut-bar,
.mobile-shortcut-toggle {
  display: none;
}

.mobile-shortcut-toggle,
.mobile-shortcut-key {
  border: 1px solid rgba(var(--accent-primary-rgb), 0.18);
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
  border-radius: $radius-sm;
  padding: 6px 10px;
  min-width: 42px;
  min-height: 32px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  touch-action: manipulation;
  transition: all $transition-fast;

  &:active,
  &.active {
    transform: translateY(1px);
    background: rgba(var(--accent-primary-rgb), 0.18);
    color: $text-primary;
  }

  &.active {
    border-color: rgba(var(--accent-primary-rgb), 0.55);
    box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.22) inset;
  }
}

@media (max-width: $breakpoint-mobile) {
  .terminal-panel-drawer {
    height: 100%;
    max-height: 100%;
  }

  .terminal-main {
    min-height: 0;
    min-width: 0;
  }

  .terminal-header {
    padding: 8px;
    gap: 6px;
  }

  .header-session-title {
    display: none;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-start;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    flex-wrap: nowrap;
    touch-action: pan-x;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }

    > * {
      flex: 0 0 auto;
    }
  }

  .theme-select {
    width: 112px;
  }

  .terminal-font-controls {
    flex: 0 0 auto;
    min-width: max-content;
  }

  .terminal-font-size-input {
    width: 96px;

    :deep(.n-input__input-el) {
      min-width: 2.5ch;
      text-align: center;
    }
  }

  .terminal-font-family-input {
    display: none;
  }

  .terminal-container {
    margin: 6px;
    margin-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
    gap: 6px;
  }

  .mobile-shortcut-bar {
    display: flex;
    flex-direction: column;
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: calc(var(--terminal-mobile-keyboard-offset, 0px) + 8px + env(safe-area-inset-bottom, 0px));
    z-index: 70;
    flex-shrink: 0;
    gap: 6px;
    overflow: hidden;
    padding: 6px 40px 6px 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: $radius-md;
    background: rgba(15, 15, 28, 0.92);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(8px);
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .mobile-shortcut-row {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .mobile-shortcut-hide {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 6px;
    right: 6px;
    width: 28px;
    min-width: 28px;
    min-height: 30px;
    padding: 0;
    font-size: 15px;
    line-height: 1;
  }

  .mobile-shortcut-show {
    display: flex;
    align-items: center;
    justify-content: center;
    position: fixed;
    right: 12px;
    bottom: calc(var(--terminal-mobile-keyboard-offset, 0px) + 8px + env(safe-area-inset-bottom, 0px));
    z-index: 70;
    width: 42px;
    min-width: 42px;
    min-height: 36px;
    padding: 0;
    border-radius: 999px;
    background: rgba(15, 15, 28, 0.92);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
    backdrop-filter: blur(8px);
    font-size: 16px;
  }

  .mobile-shortcut-key {
    flex: 0 0 auto;
    min-height: 30px;
    padding: 5px 9px;
  }

  .terminal-xterm {
    border-radius: $radius-sm;

    :deep(.xterm) {
      padding: 6px;
    }

    :deep(.xterm-viewport),
    :deep(.xterm-scrollable-element) {
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      scrollbar-width: thin !important;
    }

    :deep(.xterm-viewport::-webkit-scrollbar),
    :deep(.xterm-scrollable-element::-webkit-scrollbar) {
      display: block !important;
      width: 6px !important;
    }
  }
}
</style>
