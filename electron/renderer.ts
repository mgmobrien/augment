import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
// @ts-ignore
import xtermCssText from "@xterm/xterm/css/xterm.css";

// ============================================================
// Types
// ============================================================

type TerminalCreated = { id: number; cwd: string };
type TerminalData = { id: number; data: string };
type TerminalExit = { id: number; code: number };

type SessionStatus =
  | "shell"    // plain shell, no agent detected
  | "active"   // agent is thinking/generating
  | "tool"     // agent is invoking a tool
  | "idle"     // agent is at prompt, waiting for human input
  | "waiting"  // agent needs human attention (permission, decision)
  | "error"    // something went wrong
  | "exited";  // process terminated

type TeamEventType = "teamcreate" | "sendmessage";

type TeamEvent = {
  type: TeamEventType;
  at: number;
  team?: string;
  from?: string;
  to?: string;
  members?: string[];
};

type SessionView = {
  id: number;
  name: string;
  status: SessionStatus;
  statusText: string;
  lastOutputLines: string[];  // last N stripped lines for context preview
  terminal: Terminal;
  fit: FitAddon;
  paneEl: HTMLDivElement;
  resizeObserver: ResizeObserver;
  closed: boolean;
  rawBuffer: string;  // rolling buffer for status detection
  needsAttention: boolean;
  attentionReason: string;
  lastActivityAt: number;
  // Orchestration state
  teamNames: Set<string>;
  teamMembers: Set<string>;
  agentIdentity: string | null;
  recentTeamEvents: TeamEvent[];
  unreadActivity: number;
  parseBuffer: string;  // rolling buffer for line-based orchestration parsing
  lastEventSignature: string;
  lastEventAt: number;
};

type AugmentApp = {
  createTerminal: (options?: { cwd?: string }) => Promise<TerminalCreated>;
  listTerminals: () => Promise<Array<{ id: number; cwd: string }>>;
  write: (id: number, data: string) => void;
  resize: (id: number, rows: number, cols: number) => void;
  kill: (id: number) => void;
  onData: (callback: (payload: TerminalData) => void) => void;
  onStderr: (callback: (payload: TerminalData) => void) => void;
  onExit: (callback: (payload: TerminalExit) => void) => void;
  onError: (callback: (payload: { id: number; error: string }) => void) => void;
};

declare global {
  interface Window {
    augmentApp: AugmentApp;
  }
}

// ============================================================
// Constants
// ============================================================

const MAX_RAW_BUFFER = 16_000;
const MAX_PREVIEW_LINES = 6;
const STATUS_DEBOUNCE_MS = 200;

const ADJECTIVES = [
  "swift", "bright", "calm", "dark", "eager", "fair", "glad", "hazy",
  "keen", "lazy", "mild", "neat", "odd", "pale", "quick", "raw",
  "sharp", "tame", "vast", "warm", "bold", "crisp", "dense", "flat",
];

const NOUNS = [
  "arch", "bay", "cave", "dawn", "edge", "flint", "gate", "haze",
  "isle", "jade", "knot", "lake", "mesa", "node", "oak", "path",
  "quay", "reef", "slab", "tide", "vale", "weld", "yard", "zinc",
];

// Status detection patterns (ported from Obsidian plugin terminal-view.ts)
const TOOL_PATTERN = /\b(?:Bash|Read|Edit|Write|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|TeamCreate|SendMessage)\s*\(/;
const PERMISSION_PATTERN = /(?:Allow|Deny|approve|reject|permission|Press Enter to|yes\/no\?|Y\/n|y\/N)/i;
const QUESTION_PATTERN = /\?\s*(?:\[|$)/m;
const THINKING_MARKER = "\u23FA"; // ⏺ — Claude Code thinking indicator
const IDLE_PROMPT_PATTERN = /[❯>]\s*$/;

// Orchestration activity patterns (ported from Obsidian plugin terminal-view.ts)
const TEAM_CREATE_ACTIVITY_PATTERN = /\bTeamCreate\b/i;
const SEND_MESSAGE_ACTIVITY_PATTERN = /\bSendMessage\b/i;
const TEAM_NAME_PATTERN = /\bteam(?:Name)?\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i;
const TEAM_PATH_PATTERN = /\/teams\/([a-zA-Z0-9._-]+)\//i;
const AGENT_ID_PATTERN = /\bagentId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)/i;
const AGENT_ID_GLOBAL_PATTERN = /\bagentId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)/ig;
const AGENT_KEY_PATTERN = /\b(?:recipient|from|to|agentName|agent)\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/ig;
const MAILBOX_WRITE_PATTERN = /Wrote message to\s+([a-zA-Z0-9._-]+)'s inbox from\s+([a-zA-Z0-9._-]+)/i;
const GET_INBOX_AGENT_PATTERN = /\bgetInboxPath:\s*agent=([a-zA-Z0-9._-]+)/i;
const MAX_TEAM_EVENTS = 40;
const EVENT_DEDUP_WINDOW_MS = 1200;
const MAX_PARSE_BUFFER_CHARS = 24_000;

// ============================================================
// State
// ============================================================

const sessions = new Map<number, SessionView>();
let activeId: number | null = null;
let sessionCounter = 0;
const statusTimers = new Map<number, ReturnType<typeof setTimeout>>();

// DOM refs
const appEl = document.getElementById("app") as HTMLDivElement;
const sidebarEl = document.getElementById("sidebar") as HTMLDivElement;
const sessionListEl = document.getElementById("session-list") as HTMLDivElement;
const attentionBanner = document.getElementById("attention-banner") as HTMLDivElement;
const attentionCountEl = document.getElementById("attention-count") as HTMLSpanElement;
const newSessionBtn = document.getElementById("new-session-btn") as HTMLButtonElement;
const collapseSidebarBtn = document.getElementById("collapse-sidebar-btn") as HTMLButtonElement;
const collapseContextBtn = document.getElementById("collapse-context-btn") as HTMLButtonElement;
const focusDot = document.getElementById("focus-dot") as HTMLDivElement;
const focusNameEl = document.getElementById("focus-session-name") as HTMLSpanElement;
const focusStatusEl = document.getElementById("focus-status-text") as HTMLSpanElement;
const focusEmptyEl = document.getElementById("focus-empty") as HTMLDivElement;
const focusTerminalContainer = document.getElementById("focus-terminal-container") as HTMLDivElement;
const panesEl = document.getElementById("panes") as HTMLDivElement;
const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const goNextBtn = document.getElementById("go-next-btn") as HTMLButtonElement;
const contextListEl = document.getElementById("context-list") as HTMLDivElement;
const keyHintEl = document.getElementById("key-hint") as HTMLDivElement;

// Rename state
let renameActiveSessionId: number | null = null;

// ============================================================
// Inject xterm CSS
// ============================================================

const xtermStyleEl = document.createElement("style");
xtermStyleEl.textContent = xtermCssText;
document.head.appendChild(xtermStyleEl);

// ============================================================
// Name generation
// ============================================================

function generateName(): string {
  sessionCounter += 1;
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

// ============================================================
// ANSI stripping
// ============================================================

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")   // CSI sequences (including DEC private mode ?25h etc)
    .replace(/\x1b\[[0-9;?]*[hlm]/g, "")       // set/reset mode sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[()][0-9A-B]/g, "")           // character set selection
    .replace(/\x1b[>=<]/g, "")                  // keypad/ANSI mode
    .replace(/\x1b\[[\d;]*[ -/]*[@-~]/g, "")   // remaining CSI sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // control chars including DEL
    .replace(/[\uE000-\uF8FF]/g, "")            // private use area (powerline glyphs, nerd fonts)
    .replace(/[\u2500-\u257F]/g, "")            // box drawing characters
    .replace(/[\u2580-\u259F]/g, "")           // block elements
    .replace(/^\d{1,3}[a-zA-Z]/gm, "")         // orphaned ANSI tail (e.g. "49m" from split \x1b[49m)
    .replace(/\?\d+[hlm]/g, "");               // orphaned DEC private mode tail (e.g. "?25h")
}

// ============================================================
// Status detection
// ============================================================

function detectStatus(session: SessionView, rawData: string): void {
  if (session.closed || session.status === "exited") return;

  const clean = stripAnsi(rawData);

  // Update rolling buffer
  session.rawBuffer = (session.rawBuffer + clean).slice(-MAX_RAW_BUFFER);

  // Update preview lines (skip very short lines that are likely prompt fragments)
  const newLines = clean.split(/\r?\n/).filter((l) => l.trim().length > 2);
  if (newLines.length > 0) {
    session.lastOutputLines.push(...newLines);
    if (session.lastOutputLines.length > MAX_PREVIEW_LINES) {
      session.lastOutputLines = session.lastOutputLines.slice(-MAX_PREVIEW_LINES);
    }
  }

  // Detect status from the latest chunk
  let detected: SessionStatus | null = null;
  let statusText = session.statusText;
  let needsAttention = false;
  let attentionReason = "";

  // Permission/question prompts — highest priority, needs human
  if (PERMISSION_PATTERN.test(clean)) {
    detected = "waiting";
    needsAttention = true;
    attentionReason = "Permission or decision needed";
    statusText = "Waiting for input";
  }
  // Tool invocations
  else if (TOOL_PATTERN.test(clean)) {
    detected = "tool";
    const toolMatch = clean.match(/\b(Bash|Read|Edit|Write|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|TeamCreate|SendMessage)\s*\(/);
    statusText = toolMatch ? `Running ${toolMatch[1]}` : "Using tool";
  }
  // Thinking/generating (⏺ marker)
  else if (clean.includes(THINKING_MARKER)) {
    detected = "active";
    statusText = "Thinking";
  }
  // Idle prompt
  else if (IDLE_PROMPT_PATTERN.test(clean) || (clean.includes(">") && clean.includes("claude"))) {
    detected = "idle";
    statusText = "Waiting for input";
    // If the agent produced substantial output and is now idle, it might need review
    if (session.status === "active" || session.status === "tool") {
      needsAttention = true;
      attentionReason = "Agent finished — review output";
    }
  }

  if (detected !== null) {
    debouncedSetStatus(session, detected, statusText, needsAttention, attentionReason);
  }

  session.lastActivityAt = Date.now();
}

function debouncedSetStatus(
  session: SessionView,
  status: SessionStatus,
  statusText: string,
  needsAttention: boolean,
  attentionReason: string
): void {
  const existing = statusTimers.get(session.id);
  if (existing) clearTimeout(existing);

  statusTimers.set(
    session.id,
    setTimeout(() => {
      statusTimers.delete(session.id);
      if (session.status !== status || session.statusText !== statusText || session.needsAttention !== needsAttention) {
        session.status = status;
        session.statusText = statusText;
        if (needsAttention && !session.needsAttention) {
          session.needsAttention = true;
          session.attentionReason = attentionReason;
        }
        renderSidebar();
        renderContextPane();
        renderFocusHeader();
      }
    }, STATUS_DEBOUNCE_MS)
  );
}

// ============================================================
// Attention queue
// ============================================================

function getAttentionQueue(): SessionView[] {
  return Array.from(sessions.values())
    .filter((s) => s.needsAttention && !s.closed)
    .sort((a, b) => {
      // Priority: waiting > idle-after-work > other
      const pri = (s: SessionView) => {
        if (s.status === "waiting") return 0;
        if (s.status === "error") return 1;
        return 2;
      };
      const pa = pri(a), pb = pri(b);
      if (pa !== pb) return pa - pb;
      return a.lastActivityAt - b.lastActivityAt;
    });
}

function goToNextAttention(): void {
  const queue = getAttentionQueue();
  if (queue.length === 0) {
    showKeyHint("No sessions need attention");
    return;
  }

  // Find next one after current, or first
  const currentIdx = queue.findIndex((s) => s.id === activeId);
  const next = currentIdx >= 0 && currentIdx < queue.length - 1
    ? queue[currentIdx + 1]
    : queue[0];

  setActive(next.id);
  // Clear attention on focus
  next.needsAttention = false;
  next.attentionReason = "";
  renderSidebar();
  renderContextPane();
  showKeyHint(`→ ${next.name}`);
}

// ============================================================
// Navigation
// ============================================================

function getSessionList(): SessionView[] {
  return Array.from(sessions.values()).filter((s) => !s.closed);
}

function navigateRelative(delta: number): void {
  const list = getSessionList();
  if (list.length === 0) return;

  const idx = list.findIndex((s) => s.id === activeId);
  const nextIdx = (idx + delta + list.length) % list.length;
  setActive(list[nextIdx].id);
}

// ============================================================
// Rename
// ============================================================

function startRename(sessionId: number, nameEl: HTMLElement, context: "sidebar" | "focus"): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  renameActiveSessionId = sessionId;

  const input = document.createElement("input");
  input.type = "text";
  input.className = context === "focus" ? "" : "session-name-input";
  if (context === "focus") {
    input.id = "focus-session-name-input";
  }
  input.value = session.name;
  input.spellcheck = false;

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== session.name) {
      session.name = newName;
      showKeyHint(`Renamed → ${newName}`);
    }
    renameActiveSessionId = null;
    renderSidebar();
    renderFocusHeader();
    renderContextPane();
  };

  const cancel = () => {
    renameActiveSessionId = null;
    renderSidebar();
    renderFocusHeader();
    renderContextPane();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
    e.stopPropagation(); // don't let keyboard shortcuts fire while renaming
  });

  input.addEventListener("blur", () => {
    commit();
  });

  // Replace the name element with the input
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

// ============================================================
// Orchestration parsing (ported from Obsidian plugin terminal-view.ts)
// ============================================================

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  const withoutQuotes = trimmed.replace(/^["']+|["']+$/g, "");
  return withoutQuotes.replace(/[^a-zA-Z0-9._-]+$/g, "");
}

function extractTeamName(text: string): string | null {
  const idMatch = text.match(AGENT_ID_PATTERN);
  if (idMatch?.[2]) return normalizeIdentifier(idMatch[2]);

  const teamMatch = text.match(TEAM_NAME_PATTERN);
  if (teamMatch?.[1]) return normalizeIdentifier(teamMatch[1]);

  const pathMatch = text.match(TEAM_PATH_PATTERN);
  if (pathMatch?.[1]) return normalizeIdentifier(pathMatch[1]);

  return null;
}

function extractAgentIdentity(text: string): string | null {
  const inbox = text.match(GET_INBOX_AGENT_PATTERN);
  if (inbox?.[1]) return normalizeIdentifier(inbox[1]);

  const byName = text.match(/\bagentName\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);
  if (byName?.[1]) return normalizeIdentifier(byName[1]);

  return null;
}

function extractAgentNames(text: string): string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(AGENT_ID_GLOBAL_PATTERN)) {
    names.add(normalizeIdentifier(match[1]));
  }
  for (const match of text.matchAll(AGENT_KEY_PATTERN)) {
    names.add(normalizeIdentifier(match[1]));
  }

  const mailboxWrite = text.match(MAILBOX_WRITE_PATTERN);
  if (mailboxWrite?.[1]) names.add(normalizeIdentifier(mailboxWrite[1]));
  if (mailboxWrite?.[2]) names.add(normalizeIdentifier(mailboxWrite[2]));

  const identity = extractAgentIdentity(text);
  if (identity) names.add(identity);

  return Array.from(names).filter(Boolean);
}

function extractSendMessageDetails(
  text: string,
  fallbackTeam: string | null
): { team?: string; from?: string; to?: string } {
  const mailboxWrite = text.match(MAILBOX_WRITE_PATTERN);
  if (mailboxWrite?.[1] || mailboxWrite?.[2]) {
    return {
      team: fallbackTeam ?? undefined,
      to: mailboxWrite?.[1] ? normalizeIdentifier(mailboxWrite[1]) : undefined,
      from: mailboxWrite?.[2] ? normalizeIdentifier(mailboxWrite[2]) : undefined,
    };
  }

  const recipient = text.match(/\brecipient\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);
  const from = text.match(/\bfrom\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);
  const agent = text.match(/\bagent(?:Name)?\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);

  return {
    team: fallbackTeam ?? undefined,
    to: recipient?.[1] ? normalizeIdentifier(recipient[1]) : undefined,
    from: from?.[1] ? normalizeIdentifier(from[1]) : agent?.[1] ? normalizeIdentifier(agent[1]) : undefined,
  };
}

function recordTeamEvent(session: SessionView, event: TeamEvent): boolean {
  const signature = `${event.type}|${event.team ?? ""}|${event.from ?? ""}|${event.to ?? ""}`;
  const now = Date.now();
  if (signature === session.lastEventSignature && now - session.lastEventAt < EVENT_DEDUP_WINDOW_MS) {
    return false;
  }

  session.lastEventSignature = signature;
  session.lastEventAt = now;
  session.recentTeamEvents.push(event);
  if (session.recentTeamEvents.length > MAX_TEAM_EVENTS) {
    session.recentTeamEvents = session.recentTeamEvents.slice(-MAX_TEAM_EVENTS);
  }

  // Bump unread if this session isn't active
  if (session.id !== activeId) {
    session.unreadActivity += 1;
  }

  return true;
}

function parseOrchestrationLine(session: SessionView, line: string): boolean {
  const clean = line.trim();
  if (!clean) return false;

  let changed = false;

  const team = extractTeamName(clean);
  if (team && !session.teamNames.has(team)) {
    session.teamNames.add(team);
    changed = true;
  }

  const identity = extractAgentIdentity(clean);
  if (identity && identity !== session.agentIdentity) {
    session.agentIdentity = identity;
    changed = true;
  }

  const names = extractAgentNames(clean);
  for (const name of names) {
    if (!session.teamMembers.has(name)) {
      session.teamMembers.add(name);
      changed = true;
    }
  }

  if (TEAM_CREATE_ACTIVITY_PATTERN.test(clean)) {
    const created = recordTeamEvent(session, {
      type: "teamcreate",
      at: Date.now(),
      team: team ?? undefined,
      members: names,
    });
    changed = created || changed;
  }

  if (SEND_MESSAGE_ACTIVITY_PATTERN.test(clean) || MAILBOX_WRITE_PATTERN.test(clean)) {
    const details = extractSendMessageDetails(clean, team);
    changed = recordTeamEvent(session, {
      type: "sendmessage",
      at: Date.now(),
      team: details.team,
      from: details.from,
      to: details.to,
    }) || changed;
  }

  return changed;
}

function parseOrchestrationActivity(session: SessionView, rawData: string): void {
  const cleanChunk = stripAnsi(rawData);
  session.parseBuffer = (session.parseBuffer + cleanChunk).slice(-MAX_PARSE_BUFFER_CHARS);

  const lines = session.parseBuffer.split(/\r?\n/);
  session.parseBuffer = lines.pop() ?? "";

  let changed = false;
  for (const line of lines) {
    changed = parseOrchestrationLine(session, line) || changed;
  }

  // Parse current chunk even without newline for immediate tool activity
  if (!/[\r\n]/.test(cleanChunk)) {
    changed = parseOrchestrationLine(session, cleanChunk) || changed;
  }

  if (changed) {
    renderSidebar();
    renderContextPane();
  }
}

function getLastTeamEventSummary(session: SessionView): string | null {
  const event = session.recentTeamEvents[session.recentTeamEvents.length - 1];
  if (!event) return null;

  if (event.type === "teamcreate") {
    const memberCount = event.members?.length ?? 0;
    const parts: string[] = ["TeamCreate"];
    if (event.team) parts.push(event.team);
    if (memberCount > 0) parts.push(`(${memberCount} members)`);
    return parts.join(" ");
  }

  const parts: string[] = ["SendMessage"];
  if (event.from) parts.push(event.from);
  if (event.to) parts.push(`→ ${event.to}`);
  if (event.team) parts.push(`(${event.team})`);
  return parts.join(" ");
}

// ============================================================
// Session lifecycle
// ============================================================

function setActive(id: number): void {
  const prevId = activeId;
  activeId = id;

  // Determine slide direction based on session order
  const list = getSessionList();
  const prevIdx = list.findIndex((s) => s.id === prevId);
  const nextIdx = list.findIndex((s) => s.id === id);
  const slideRight = nextIdx > prevIdx; // new session is to the right

  for (const session of sessions.values()) {
    const isActive = session.id === id;
    const pane = session.paneEl;

    // Remove all transition classes first
    pane.classList.remove("is-active", "slide-out-left", "slide-out-right");

    if (isActive) {
      // The incoming pane: set initial position (off-screen), then animate in
      pane.style.transition = "none";
      pane.style.transform = slideRight ? "translateX(40px)" : "translateX(-40px)";
      pane.style.opacity = "0";

      // Force reflow so the initial position takes effect
      void pane.offsetHeight;

      // Now enable transition and animate to final position
      pane.style.transition = "";
      pane.style.transform = "";
      pane.style.opacity = "";
      pane.classList.add("is-active");
    } else if (session.id === prevId && prevId !== null) {
      // The outgoing pane: slide out in opposite direction
      pane.classList.add(slideRight ? "slide-out-left" : "slide-out-right");
    }
  }

  const active = sessions.get(id);
  if (active) {
    // Clear attention when focused
    if (active.needsAttention) {
      active.needsAttention = false;
      active.attentionReason = "";
    }

    setTimeout(() => {
      active.fit.fit();
      const dims = active.fit.proposeDimensions();
      if (dims) {
        window.augmentApp.resize(active.id, dims.rows, dims.cols);
      }
      active.terminal.focus();
    }, 50); // slightly longer delay to let slide animation start
  }

  renderSidebar();
  renderFocusHeader();
  renderContextPane();
  renderEmptyState();
}

function disposeSession(id: number): void {
  const session = sessions.get(id);
  if (!session) return;

  session.closed = true;
  session.resizeObserver.disconnect();
  session.terminal.dispose();
  session.paneEl.remove();
  sessions.delete(id);

  const timer = statusTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    statusTimers.delete(id);
  }

  if (activeId === id) {
    const remaining = getSessionList();
    activeId = null;
    if (remaining.length > 0) {
      setActive(remaining[0].id);
    } else {
      renderSidebar();
      renderFocusHeader();
      renderContextPane();
      renderEmptyState();
    }
  } else {
    renderSidebar();
    renderContextPane();
  }
}

function markExited(id: number, code: number): void {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  session.status = "exited";
  session.statusText = `Exited (${code})`;
  session.terminal.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`);
  renderSidebar();
  renderFocusHeader();
  renderContextPane();
}

function createSessionView(created: TerminalCreated): SessionView {
  const name = generateName();

  const paneEl = document.createElement("div");
  paneEl.className = "pane";
  const terminalRoot = document.createElement("div");
  terminalRoot.className = "terminal-root";
  paneEl.appendChild(terminalRoot);
  panesEl.appendChild(paneEl);

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
    theme: {
      background: "#0f1115",
      foreground: "#d7dce8",
      cursor: "#7aa2f7",
      cursorAccent: "#0f1115",
      selectionBackground: "rgba(122, 162, 247, 0.25)",
    },
    scrollback: 10000,
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(terminalRoot);

  terminal.onData((data) => {
    window.augmentApp.write(created.id, data);
  });

  const resizeObserver = new ResizeObserver(() => {
    if (activeId !== created.id) return; // only resize active terminal
    fit.fit();
    const dims = fit.proposeDimensions();
    if (dims) {
      window.augmentApp.resize(created.id, dims.rows, dims.cols);
    }
  });
  resizeObserver.observe(paneEl);

  return {
    id: created.id,
    name,
    status: "shell",
    statusText: "Shell",
    lastOutputLines: [],
    terminal,
    fit,
    paneEl,
    resizeObserver,
    closed: false,
    rawBuffer: "",
    needsAttention: false,
    attentionReason: "",
    lastActivityAt: Date.now(),
    // Orchestration state
    teamNames: new Set(),
    teamMembers: new Set(),
    agentIdentity: null,
    recentTeamEvents: [],
    unreadActivity: 0,
    parseBuffer: "",
    lastEventSignature: "",
    lastEventAt: 0,
  };
}

async function spawnSession(): Promise<void> {
  const created = await window.augmentApp.createTerminal();
  const session = createSessionView(created);
  sessions.set(created.id, session);
  setActive(created.id);
}

// ============================================================
// Render: sidebar session list
// ============================================================

function renderSidebar(): void {
  sessionListEl.innerHTML = "";

  const list = getSessionList();
  const attentionQueue = getAttentionQueue();

  // Update attention banner
  if (attentionQueue.length > 0) {
    attentionBanner.classList.add("visible");
    attentionCountEl.textContent = String(attentionQueue.length);
  } else {
    attentionBanner.classList.remove("visible");
  }

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 20px 10px; text-align: center; color: var(--text-dim); font-size: 12px;";
    empty.textContent = "No active sessions";
    sessionListEl.appendChild(empty);
    return;
  }

  // Group: needing attention first, then active, then rest
  const needingAttention = list.filter((s) => s.needsAttention);
  const active = list.filter((s) => !s.needsAttention && (s.status === "active" || s.status === "tool"));
  const rest = list.filter((s) => !s.needsAttention && s.status !== "active" && s.status !== "tool");

  if (needingAttention.length > 0) {
    appendGroupLabel("Needs attention");
    needingAttention.forEach((s) => appendSessionCard(s));
  }

  if (active.length > 0) {
    appendGroupLabel("Working");
    active.forEach((s) => appendSessionCard(s));
  }

  if (rest.length > 0) {
    if (needingAttention.length > 0 || active.length > 0) {
      appendGroupLabel("Other");
    }
    rest.forEach((s) => appendSessionCard(s));
  }
}

function appendGroupLabel(text: string): void {
  const label = document.createElement("div");
  label.className = "session-group-label";
  label.textContent = text;
  sessionListEl.appendChild(label);
}

function appendSessionCard(session: SessionView): void {
  const card = document.createElement("div");
  card.className = "session-card";
  if (session.id === activeId) {
    card.classList.add("is-active");
  }

  // Header row
  const header = document.createElement("div");
  header.className = "session-card-header";

  const dot = document.createElement("div");
  dot.className = `status-dot ${session.status}`;
  header.appendChild(dot);

  const name = document.createElement("span");
  name.className = "session-name";
  name.textContent = session.name;
  name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startRename(session.id, name, "sidebar");
  });
  header.appendChild(name);

  if (session.needsAttention) {
    const badge = document.createElement("span");
    badge.className = "session-badge";
    badge.textContent = "!";
    badge.title = session.attentionReason;
    header.appendChild(badge);
  }

  // Unread activity badge
  if (session.unreadActivity > 0) {
    const unreadBadge = document.createElement("span");
    unreadBadge.className = "session-unread";
    unreadBadge.textContent = session.unreadActivity > 99 ? "99+" : String(session.unreadActivity);
    header.appendChild(unreadBadge);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "close-btn";
  closeBtn.textContent = "\u00D7";
  closeBtn.title = "Close session";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.augmentApp.kill(session.id);
    disposeSession(session.id);
  });
  header.appendChild(closeBtn);

  card.appendChild(header);

  // Status line
  const statusLine = document.createElement("div");
  statusLine.className = "session-status-line";
  statusLine.textContent = session.statusText;
  card.appendChild(statusLine);

  // Team event summary
  const summary = getLastTeamEventSummary(session);
  if (summary) {
    const summaryEl = document.createElement("div");
    summaryEl.className = "session-team-summary";
    summaryEl.textContent = summary;
    card.appendChild(summaryEl);
  }

  // Team member chips
  const teams = Array.from(session.teamNames);
  const members = Array.from(session.teamMembers);
  if (teams.length > 0 || members.length > 0) {
    const meta = document.createElement("div");
    meta.className = "session-team-meta";

    if (teams.length > 0) {
      const teamLabel = document.createElement("span");
      teamLabel.className = "session-team-name";
      teamLabel.textContent = teams.slice(0, 2).join(", ");
      meta.appendChild(teamLabel);
    }

    if (members.length > 0) {
      const membersWrap = document.createElement("div");
      membersWrap.className = "session-team-members";
      for (const member of members.slice(0, 6)) {
        const chip = document.createElement("button");
        chip.className = "session-member-chip";
        chip.textContent = member;
        chip.title = `Jump to ${member}`;
        chip.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          // Find session with this agent identity or name and switch to it
          for (const [id, s] of sessions) {
            if (s.agentIdentity?.toLowerCase() === member.toLowerCase() ||
                s.name.toLowerCase() === member.toLowerCase() ||
                s.name.toLowerCase().includes(member.toLowerCase())) {
              setActive(id);
              return;
            }
          }
        });
        membersWrap.appendChild(chip);
      }
      meta.appendChild(membersWrap);
    }
    card.appendChild(meta);
  }

  card.addEventListener("click", () => {
    setActive(session.id);
    // Mark activity as read when focusing
    session.unreadActivity = 0;
  });

  sessionListEl.appendChild(card);
}

// ============================================================
// Render: focus header
// ============================================================

function renderFocusHeader(): void {
  const active = activeId !== null ? sessions.get(activeId) : null;

  if (!active) {
    focusNameEl.textContent = "";
    focusStatusEl.textContent = "";
    focusDot.className = "status-dot";
    return;
  }

  // Don't clobber if we're actively renaming in the focus header
  if (renameActiveSessionId !== active.id || !document.getElementById("focus-session-name-input")) {
    focusNameEl.textContent = active.name;
  }
  focusStatusEl.textContent = active.statusText;
  focusDot.className = `status-dot ${active.status}`;
}

// ============================================================
// Render: context pane (nearby sessions)
// ============================================================

function renderContextPane(): void {
  contextListEl.innerHTML = "";

  const list = getSessionList();
  // Show all sessions except the active one, prioritizing those needing attention
  const others = list.filter((s) => s.id !== activeId);

  if (others.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 20px 8px; text-align: center; color: var(--text-dim); font-size: 11px;";
    empty.textContent = "No other sessions";
    contextListEl.appendChild(empty);
    return;
  }

  // Sort: needing attention first, then by last activity
  others.sort((a, b) => {
    if (a.needsAttention && !b.needsAttention) return -1;
    if (!a.needsAttention && b.needsAttention) return 1;
    return b.lastActivityAt - a.lastActivityAt;
  });

  for (const session of others) {
    const card = document.createElement("div");
    card.className = "context-card";

    // Header
    const header = document.createElement("div");
    header.className = "context-card-header";

    const dot = document.createElement("div");
    dot.className = `status-dot ${session.status}`;
    header.appendChild(dot);

    const name = document.createElement("span");
    name.className = "session-name";
    name.textContent = session.name;
    header.appendChild(name);

    if (session.needsAttention) {
      const badge = document.createElement("span");
      badge.className = "session-badge";
      badge.textContent = "!";
      badge.style.fontSize = "9px";
      badge.style.padding = "0 4px";
      header.appendChild(badge);
    }

    // Unread badge in context card
    if (session.unreadActivity > 0) {
      const unread = document.createElement("span");
      unread.className = "session-unread";
      unread.style.fontSize = "8px";
      unread.textContent = session.unreadActivity > 99 ? "99+" : String(session.unreadActivity);
      header.appendChild(unread);
    }

    card.appendChild(header);

    // Status
    const statusDiv = document.createElement("div");
    statusDiv.className = "context-card-status";
    statusDiv.textContent = session.statusText;
    card.appendChild(statusDiv);

    // Team event summary in context card
    const ctxSummary = getLastTeamEventSummary(session);
    if (ctxSummary) {
      const summaryEl = document.createElement("div");
      summaryEl.className = "context-card-status";
      summaryEl.style.color = "var(--accent-blue)";
      summaryEl.style.fontSize = "9px";
      summaryEl.textContent = ctxSummary;
      card.appendChild(summaryEl);
    }

    // Team member chips in context card
    const ctxMembers = Array.from(session.teamMembers);
    if (ctxMembers.length > 0) {
      const membersWrap = document.createElement("div");
      membersWrap.className = "session-team-members";
      membersWrap.style.padding = "2px 0";
      for (const member of ctxMembers.slice(0, 4)) {
        const chip = document.createElement("button");
        chip.className = "session-member-chip";
        chip.textContent = member;
        chip.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          for (const [id, s] of sessions) {
            if (s.agentIdentity?.toLowerCase() === member.toLowerCase() ||
                s.name.toLowerCase() === member.toLowerCase()) {
              setActive(id);
              return;
            }
          }
        });
        membersWrap.appendChild(chip);
      }
      card.appendChild(membersWrap);
    }

    // Preview (last few lines of output, stripped)
    if (session.lastOutputLines.length > 0) {
      const preview = document.createElement("div");
      preview.className = "context-card-preview";
      preview.textContent = session.lastOutputLines.join("\n");
      card.appendChild(preview);
    }

    card.addEventListener("click", () => {
      setActive(session.id);
      session.unreadActivity = 0;
    });

    contextListEl.appendChild(card);
  }
}

// ============================================================
// Render: empty state
// ============================================================

function renderEmptyState(): void {
  const list = getSessionList();
  if (list.length === 0) {
    focusEmptyEl.classList.add("visible");
    focusTerminalContainer.style.display = "none";
  } else {
    focusEmptyEl.classList.remove("visible");
    focusTerminalContainer.style.display = "block";
  }
}

// ============================================================
// Key hint toast
// ============================================================

let keyHintTimer: ReturnType<typeof setTimeout> | null = null;

function showKeyHint(text: string): void {
  keyHintEl.textContent = text;
  keyHintEl.classList.add("visible");
  if (keyHintTimer) clearTimeout(keyHintTimer);
  keyHintTimer = setTimeout(() => {
    keyHintEl.classList.remove("visible");
  }, 1500);
}

// ============================================================
// IPC event handlers
// ============================================================

window.augmentApp.onData((payload) => {
  const session = sessions.get(payload.id);
  if (!session || session.closed) return;
  session.terminal.write(payload.data);
  detectStatus(session, payload.data);
  parseOrchestrationActivity(session, payload.data);
});

window.augmentApp.onStderr((payload) => {
  const session = sessions.get(payload.id);
  if (!session || session.closed) return;
  session.terminal.write(`\x1b[31m${payload.data}\x1b[0m`);

  // Stderr often indicates errors
  if (session.status !== "exited") {
    session.status = "error";
    session.statusText = "Error in output";
    session.needsAttention = true;
    session.attentionReason = "Error detected";
    renderSidebar();
    renderContextPane();
    renderFocusHeader();
  }
});

window.augmentApp.onExit((payload) => {
  markExited(payload.id, payload.code);
});

window.augmentApp.onError((payload) => {
  const session = sessions.get(payload.id);
  if (!session || session.closed) return;
  session.terminal.write(`\r\n\x1b[31m[Error] ${payload.error}\x1b[0m\r\n`);
  session.status = "error";
  session.statusText = "Process error";
  session.needsAttention = true;
  session.attentionReason = "Process error";
  renderSidebar();
  renderContextPane();
  renderFocusHeader();
});

// ============================================================
// UI event handlers
// ============================================================

newSessionBtn.addEventListener("click", () => {
  void spawnSession();
});

collapseSidebarBtn.addEventListener("click", () => {
  appEl.classList.toggle("sidebar-collapsed");
});

collapseContextBtn.addEventListener("click", () => {
  appEl.classList.toggle("context-collapsed");
  // Re-fit the active terminal since the focus area width changed
  if (activeId !== null) {
    const active = sessions.get(activeId);
    if (active) {
      setTimeout(() => {
        active.fit.fit();
        const dims = active.fit.proposeDimensions();
        if (dims) {
          window.augmentApp.resize(active.id, dims.rows, dims.cols);
        }
      }, 250); // wait for grid transition
    }
  }
});

// Double-click focus header name to rename
focusNameEl.addEventListener("dblclick", () => {
  if (activeId !== null) {
    startRename(activeId, focusNameEl, "focus");
  }
});

attentionBanner.addEventListener("click", () => {
  goToNextAttention();
});

prevBtn.addEventListener("click", () => {
  navigateRelative(-1);
});

nextBtn.addEventListener("click", () => {
  navigateRelative(1);
});

goNextBtn.addEventListener("click", () => {
  goToNextAttention();
});

// ============================================================
// Keyboard shortcuts
// ============================================================

document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;

  // Cmd+T — new session
  if (meta && e.key === "t" && !e.shiftKey) {
    e.preventDefault();
    void spawnSession();
    return;
  }

  // Cmd+J — go to next needing attention
  if (meta && e.key === "j" && !e.shiftKey) {
    e.preventDefault();
    goToNextAttention();
    return;
  }

  // Cmd+W — close current session
  if (meta && e.key === "w" && !e.shiftKey) {
    e.preventDefault();
    if (activeId !== null) {
      window.augmentApp.kill(activeId);
      disposeSession(activeId);
    }
    return;
  }

  // Cmd+Shift+[ — previous session
  if (meta && e.shiftKey && e.key === "[") {
    e.preventDefault();
    navigateRelative(-1);
    return;
  }

  // Cmd+Shift+] — next session
  if (meta && e.shiftKey && e.key === "]") {
    e.preventDefault();
    navigateRelative(1);
    return;
  }

  // Cmd+B — toggle sidebar
  if (meta && e.key === "b" && !e.shiftKey) {
    e.preventDefault();
    appEl.classList.toggle("sidebar-collapsed");
    // Re-fit active terminal after grid transition
    if (activeId !== null) {
      const active = sessions.get(activeId);
      if (active) {
        setTimeout(() => {
          active.fit.fit();
          const dims = active.fit.proposeDimensions();
          if (dims) window.augmentApp.resize(active.id, dims.rows, dims.cols);
        }, 250);
      }
    }
    return;
  }

  // Cmd+\ — toggle context pane
  if (meta && e.key === "\\" && !e.shiftKey) {
    e.preventDefault();
    appEl.classList.toggle("context-collapsed");
    // Re-fit active terminal after grid transition
    if (activeId !== null) {
      const active = sessions.get(activeId);
      if (active) {
        setTimeout(() => {
          active.fit.fit();
          const dims = active.fit.proposeDimensions();
          if (dims) window.augmentApp.resize(active.id, dims.rows, dims.cols);
        }, 250);
      }
    }
    return;
  }

  // Cmd+E — rename current session
  if (meta && e.key === "e" && !e.shiftKey) {
    e.preventDefault();
    if (activeId !== null) {
      startRename(activeId, focusNameEl, "focus");
    }
    return;
  }

  // Cmd+1-9 — switch to session by position
  if (meta && !e.shiftKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    const list = getSessionList();
    if (idx < list.length) {
      setActive(list[idx].id);
    }
    return;
  }
});

// ============================================================
// Initialize
// ============================================================

renderEmptyState();
renderSidebar();
renderContextPane();
void spawnSession();
