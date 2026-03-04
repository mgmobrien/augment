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

type SessionGroup = {
  id: number;
  name: string;
  parentSessionId: number | null;  // session that spawned this group (TeamCreate)
  collapsed: boolean;
};

type SessionView = {
  id: number;
  name: string;
  groupId: number | null;  // which group this session belongs to
  ccSessionId: string | null;  // CC session ID captured from terminal output
  cwd: string | null;
  exitCode: number | null;
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

type ArchivedSession = {
  name: string;
  groupId: number | null;
  groupName: string | null;
  ccSessionId: string | null;
  cwd: string | null;
  displayText: string | null;  // user's first message from CC history
  archivedAt: number;
  exitCode: number | null;
};

type CcSessionMeta = {
  sessionId: string;
  timestamp: string;
  agentName: string | null;
  teamName: string | null;
  cwd: string;
  file: string;
};

type DiscoveredProcess = {
  pid: number;
  stat: string;
  isRunning: boolean;
  agentName: string | null;
  teamName: string | null;
  agentColor: string | null;
  agentId: string | null;
  parentSessionId: string | null;
  resumeSessionId: string | null;
  displayName: string;
  cmdLine: string;
};

type DiscoveredTeamMember = {
  name: string;
  agentId: string | null;
  agentType: string | null;
  color: string | null;
  isActive: boolean;
  cwd: string | null;
};

type DiscoveredTeam = {
  name: string;
  leadSessionId: string | null;
  members: DiscoveredTeamMember[];
};

type DiscoverySnapshot = {
  processes: DiscoveredProcess[];
  teams: DiscoveredTeam[];
  timestamp: number;
};

type AugmentApp = {
  createTerminal: (options?: { cwd?: string; cmd?: string[] }) => Promise<TerminalCreated>;
  listTerminals: () => Promise<Array<{ id: number; cwd: string }>>;
  write: (id: number, data: string) => void;
  resize: (id: number, rows: number, cols: number) => void;
  kill: (id: number) => void;
  onData: (callback: (payload: TerminalData) => void) => void;
  onStderr: (callback: (payload: TerminalData) => void) => void;
  onExit: (callback: (payload: TerminalExit) => void) => void;
  onError: (callback: (payload: { id: number; error: string }) => void) => void;
  // History
  saveHistory: (entries: ArchivedSession[]) => Promise<boolean>;
  loadHistory: () => Promise<ArchivedSession[]>;
  scanCCSessions: (projectPath: string) => Promise<CcSessionMeta[]>;
  getCCHistory: () => Promise<Record<string, string>>;
  // Tmux shim events
  onAgentSpawned: (callback: (payload: { id: number; name: string; cmd: string }) => void) => void;
  onAgentRenamed: (callback: (payload: { target: string; title: string }) => void) => void;
  // Discovery
  onDiscoveryUpdate: (callback: (payload: DiscoverySnapshot) => void) => void;
  getCachedDiscovery: () => Promise<DiscoverySnapshot | null>;
  requestDiscoveryScan: () => Promise<DiscoverySnapshot>;
  resolveDiscoveredSession: (opts: {
    parentSessionId?: string | null;
    agentName?: string | null;
    pid?: number | null;
  }) => Promise<{ sessionId: string; cwd: string | null } | null>;
  // Transcript reading
  readSessionTranscript: (pid: number) => Promise<string | null>;
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

// CC session ID capture — CC prints session info on startup
const CC_SESSION_ID_PATTERN = /session(?:Id)?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CC_RESUME_HINT_PATTERN = /claude\s+--resume\s+([0-9a-f-]{36})/i;

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
const groups = new Map<number, SessionGroup>();
let archivedSessions: ArchivedSession[] = [];
let activeId: number | null = null;
let sessionCounter = 0;
let groupCounter = 0;
let showHistory = true;
let latestDiscovery: DiscoverySnapshot | null = null;
const statusTimers = new Map<number, ReturnType<typeof setTimeout>>();

// DOM refs
const appEl = document.getElementById("app") as HTMLDivElement;
const sidebarEl = document.getElementById("sidebar") as HTMLDivElement;
const sessionListEl = document.getElementById("session-list") as HTMLDivElement;
const attentionBanner = document.getElementById("attention-banner") as HTMLDivElement;
const attentionCountEl = document.getElementById("attention-count") as HTMLSpanElement;
const newSessionBtn = document.getElementById("new-session-btn") as HTMLButtonElement;
const collapseSidebarBtn = document.getElementById("collapse-sidebar-btn") as HTMLButtonElement;
const focusSidebarToggle = document.getElementById("focus-sidebar-toggle") as HTMLButtonElement;
const focusAttentionBadge = document.getElementById("focus-attention-badge") as HTMLButtonElement;
const focusDot = document.getElementById("focus-dot") as HTMLDivElement;
const focusNameEl = document.getElementById("focus-session-name") as HTMLSpanElement;
const focusStatusEl = document.getElementById("focus-status-text") as HTMLSpanElement;
const focusEmptyEl = document.getElementById("focus-empty") as HTMLDivElement;
const focusTerminalContainer = document.getElementById("focus-terminal-container") as HTMLDivElement;
const panesEl = document.getElementById("panes") as HTMLDivElement;
const prevBtn = document.getElementById("prev-btn") as HTMLButtonElement;
const nextBtn = document.getElementById("next-btn") as HTMLButtonElement;
const goNextBtn = document.getElementById("go-next-btn") as HTMLButtonElement;
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

  // Capture CC session ID from output
  if (!session.ccSessionId) {
    const sessionMatch = clean.match(CC_SESSION_ID_PATTERN) || clean.match(CC_RESUME_HINT_PATTERN);
    if (sessionMatch?.[1]) {
      session.ccSessionId = sessionMatch[1];
    }
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
  };

  const cancel = () => {
    renameActiveSessionId = null;
    renderSidebar();
    renderFocusHeader();
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

    // Auto-create group for the team
    if (team) {
      ensureGroupForTeam(session, team);
    }
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
// Group lifecycle
// ============================================================

function createGroup(name: string, parentSessionId: number | null = null): SessionGroup {
  groupCounter += 1;
  const group: SessionGroup = {
    id: groupCounter,
    name,
    parentSessionId,
    collapsed: false,
  };
  groups.set(group.id, group);
  return group;
}

function getGroupSessions(groupId: number): SessionView[] {
  return Array.from(sessions.values()).filter((s) => s.groupId === groupId && !s.closed);
}

function getUngroupedSessions(): SessionView[] {
  return Array.from(sessions.values()).filter((s) => s.groupId === null && !s.closed);
}

function getGroupList(): SessionGroup[] {
  return Array.from(groups.values());
}

function groupNeedsAttention(groupId: number): boolean {
  return getGroupSessions(groupId).some((s) => s.needsAttention);
}

function groupAttentionCount(groupId: number): number {
  return getGroupSessions(groupId).filter((s) => s.needsAttention).length;
}

/** Auto-create a group when TeamCreate is detected, if one doesn't exist for this team */
function ensureGroupForTeam(session: SessionView, teamName: string): void {
  // Check if a group already exists for this team
  for (const group of groups.values()) {
    if (group.name === teamName) {
      // Assign session to existing group if not already assigned
      if (session.groupId === null) {
        session.groupId = group.id;
      }
      return;
    }
  }

  // Create new group named after the team, parented to this session
  const group = createGroup(teamName, session.id);
  session.groupId = group.id;
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

  renderEmptyState();
}

function disposeSession(id: number): void {
  const session = sessions.get(id);
  if (!session) return;

  // Three-stage Cmd+W lifecycle:
  // 1. Active/running → kill process (becomes exited, buffer preserved)
  // 2. Exited → archive (metadata saved, buffer released)
  if (session.status === "exited") {
    // Stage 2: exited → archive
    archiveSession(id);
    return;
  }

  // Stage 1: running → kill (will become exited via onExit handler)
  // The kill signal will trigger markExited() which preserves the session
  window.augmentApp.kill(id);
}

function markExited(id: number, code: number): void {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  session.status = "exited";
  session.exitCode = code;
  session.statusText = `Exited (${code})`;
  session.terminal.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`);
  renderSidebar();
  renderFocusHeader();
}

function archiveSession(id: number): void {
  const session = sessions.get(id);
  if (!session) return;

  const groupName = session.groupId !== null ? groups.get(session.groupId)?.name ?? null : null;

  const archived: ArchivedSession = {
    name: session.name,
    groupId: session.groupId,
    groupName,
    ccSessionId: session.ccSessionId,
    cwd: session.cwd,
    displayText: null,
    archivedAt: Date.now(),
    exitCode: session.exitCode,
  };

  archivedSessions.unshift(archived);
  // Keep last 50
  if (archivedSessions.length > 50) {
    archivedSessions = archivedSessions.slice(0, 50);
  }

  // Persist to disk
  void window.augmentApp.saveHistory(archivedSessions);

  // Now dispose the live session
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
      renderEmptyState();
    }
  } else {
    renderSidebar();
  }

  showKeyHint(`Archived ${archived.name}`);
}

async function resumeSession(archived: ArchivedSession): Promise<void> {
  if (!archived.ccSessionId) {
    showKeyHint("No CC session ID — cannot resume");
    return;
  }

  const cmd = ["claude", "--resume", archived.ccSessionId];
  const cwd = archived.cwd || undefined;
  const created = await window.augmentApp.createTerminal({ cwd, cmd });
  const session = createSessionView(created);
  session.name = `${archived.name} (resumed)`;
  session.ccSessionId = archived.ccSessionId;
  session.cwd = archived.cwd;

  // Restore group membership if the group still exists
  if (archived.groupId !== null && groups.has(archived.groupId)) {
    session.groupId = archived.groupId;
  }

  sessions.set(created.id, session);
  setActive(created.id);

  // Remove from archive
  const idx = archivedSessions.indexOf(archived);
  if (idx >= 0) {
    archivedSessions.splice(idx, 1);
    void window.augmentApp.saveHistory(archivedSessions);
  }

  showKeyHint(`Resumed ${archived.name}`);
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
    groupId: null,
    ccSessionId: null,
    cwd: created.cwd || null,
    exitCode: null,
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

  // Render groups first, then ungrouped sessions
  const groupList = getGroupList();
  const ungrouped = getUngroupedSessions();

  for (const group of groupList) {
    const members = getGroupSessions(group.id);
    if (members.length === 0) continue; // skip empty groups

    appendGroupHeader(group, members);

    if (!group.collapsed) {
      for (const session of members) {
        appendSessionCard(session, true);
      }

      // Archived sessions for this group
      if (showHistory) {
        const groupArchived = archivedSessions.filter(
          (a) => a.groupId === group.id || a.groupName === group.name
        );
        if (groupArchived.length > 0) {
          appendArchivedSection(groupArchived, true);
        }
      }
    }
  }

  // Ungrouped sessions
  if (ungrouped.length > 0) {
    if (groupList.length > 0 && groupList.some((g) => getGroupSessions(g.id).length > 0)) {
      appendGroupLabel("Ungrouped");
    }
    for (const session of ungrouped) {
      appendSessionCard(session, false);
    }
  }

  // Ungrouped archived sessions
  if (showHistory) {
    const ungroupedArchived = archivedSessions.filter(
      (a) => a.groupId === null && a.groupName === null
    );
    if (ungroupedArchived.length > 0) {
      appendArchivedSection(ungroupedArchived, false);
    }
  }

  // Discovered external sessions
  if (latestDiscovery && latestDiscovery.processes.length > 0) {
    appendDiscoveredSection(latestDiscovery);
  }
}

function appendGroupHeader(group: SessionGroup, members: SessionView[]): void {
  const header = document.createElement("div");
  header.className = "group-header";

  const chevron = document.createElement("span");
  chevron.className = "group-chevron";
  chevron.textContent = group.collapsed ? "\u25B6" : "\u25BC"; // ▶ or ▼
  header.appendChild(chevron);

  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = group.name;
  header.appendChild(name);

  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = String(members.length);
  header.appendChild(count);

  // Attention rollup badge
  const attCount = groupAttentionCount(group.id);
  if (attCount > 0) {
    const badge = document.createElement("span");
    badge.className = "session-badge";
    badge.textContent = String(attCount);
    badge.title = `${attCount} session${attCount > 1 ? "s" : ""} need attention`;
    header.appendChild(badge);
  }

  header.addEventListener("click", () => {
    group.collapsed = !group.collapsed;
    renderSidebar();
  });

  sessionListEl.appendChild(header);
}

function appendGroupLabel(text: string): void {
  const label = document.createElement("div");
  label.className = "session-group-label";
  label.textContent = text;
  sessionListEl.appendChild(label);
}

function appendSessionCard(session: SessionView, indented: boolean = false): void {
  const card = document.createElement("div");
  card.className = "session-card";
  if (indented) card.classList.add("indented");
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

function appendArchivedSection(archived: ArchivedSession[], indented: boolean): void {
  const toggle = document.createElement("div");
  toggle.className = "archived-toggle";
  if (indented) toggle.classList.add("indented");
  toggle.textContent = `${archived.length} past session${archived.length > 1 ? "s" : ""}`;

  let expanded = false;
  const container = document.createElement("div");
  container.style.display = "none";

  toggle.addEventListener("click", () => {
    expanded = !expanded;
    container.style.display = expanded ? "block" : "none";
    toggle.textContent = expanded
      ? `\u25BC ${archived.length} past session${archived.length > 1 ? "s" : ""}`
      : `${archived.length} past session${archived.length > 1 ? "s" : ""}`;
  });

  for (const entry of archived.slice(0, 20)) {
    appendArchivedCard(entry, container, indented);
  }

  sessionListEl.appendChild(toggle);
  sessionListEl.appendChild(container);
}

function appendArchivedCard(
  archived: ArchivedSession,
  container: HTMLElement,
  indented: boolean
): void {
  const card = document.createElement("div");
  card.className = "session-card archived";
  if (indented) card.classList.add("indented");

  // Header row
  const header = document.createElement("div");
  header.className = "session-card-header";

  const dot = document.createElement("div");
  dot.className = "status-dot exited";
  header.appendChild(dot);

  const name = document.createElement("span");
  name.className = "session-name";
  name.textContent = archived.name;
  header.appendChild(name);

  card.appendChild(header);

  // Info line
  const info = document.createElement("div");
  info.className = "session-status-line";
  const time = new Date(archived.archivedAt);
  const timeStr = time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  info.textContent = archived.displayText
    ? `${timeStr} — ${archived.displayText}`
    : `Archived ${timeStr}`;
  card.appendChild(info);

  // Resume button (only if CC session ID is available)
  if (archived.ccSessionId) {
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "resume-btn";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void resumeSession(archived);
    });
    card.appendChild(resumeBtn);
  }

  // Remove from history button
  const removeBtn = document.createElement("button");
  removeBtn.className = "close-btn";
  removeBtn.textContent = "\u00D7";
  removeBtn.title = "Remove from history";
  removeBtn.style.display = "block";
  removeBtn.style.position = "absolute";
  removeBtn.style.right = "8px";
  removeBtn.style.top = "8px";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const idx = archivedSessions.indexOf(archived);
    if (idx >= 0) {
      archivedSessions.splice(idx, 1);
      void window.augmentApp.saveHistory(archivedSessions);
      renderSidebar();
    }
  });
  card.appendChild(removeBtn);

  card.style.position = "relative";

  container.appendChild(card);
}

// ============================================================
// Render: discovered external sessions
// ============================================================

function appendDiscoveredSection(snapshot: DiscoverySnapshot): void {
  // Group processes by team
  const teamProcesses = new Map<string, DiscoveredProcess[]>();
  const ungroupedProcesses: DiscoveredProcess[] = [];

  for (const proc of snapshot.processes) {
    if (proc.teamName) {
      if (!teamProcesses.has(proc.teamName)) {
        teamProcesses.set(proc.teamName, []);
      }
      teamProcesses.get(proc.teamName)!.push(proc);
    } else {
      ungroupedProcesses.push(proc);
    }
  }

  // Section header
  const sectionHeader = document.createElement("div");
  sectionHeader.className = "session-group-label";
  sectionHeader.style.marginTop = "12px";
  sectionHeader.textContent = `Discovered (${snapshot.processes.length})`;
  sessionListEl.appendChild(sectionHeader);

  // Render team-grouped discovered sessions
  for (const [teamName, procs] of teamProcesses) {
    // Find team config for enrichment
    const teamConfig = snapshot.teams.find((t) => t.name === teamName);

    const teamHeader = document.createElement("div");
    teamHeader.className = "group-header discovered-group";

    const chevron = document.createElement("span");
    chevron.className = "group-chevron";
    chevron.textContent = "\u25BC"; // ▼
    teamHeader.appendChild(chevron);

    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = teamName;
    teamHeader.appendChild(name);

    const count = document.createElement("span");
    count.className = "group-count";
    const runningCount = procs.filter((p) => p.isRunning).length;
    count.textContent = `${runningCount}/${procs.length}`;
    count.title = `${runningCount} running, ${procs.length - runningCount} idle`;
    teamHeader.appendChild(count);

    let collapsed = false;
    teamHeader.addEventListener("click", () => {
      collapsed = !collapsed;
      chevron.textContent = collapsed ? "\u25B6" : "\u25BC";
      container.style.display = collapsed ? "none" : "block";
    });

    sessionListEl.appendChild(teamHeader);

    const container = document.createElement("div");

    // If we have team config, show all members (even ones without processes)
    if (teamConfig) {
      for (const member of teamConfig.members) {
        const proc = procs.find((p) => p.agentName === member.name);
        appendDiscoveredCard(container, {
          name: member.name,
          color: member.color || proc?.agentColor || null,
          isRunning: proc?.isRunning ?? false,
          hasProcess: !!proc,
          pid: proc?.pid ?? null,
          teamName,
          agentId: member.agentId || proc?.agentId || null,
          resumeSessionId: proc?.resumeSessionId || null,
          parentSessionId: proc?.parentSessionId || null,
        });
      }
    } else {
      for (const proc of procs) {
        appendDiscoveredCard(container, {
          name: proc.agentName || proc.displayName,
          color: proc.agentColor,
          isRunning: proc.isRunning,
          hasProcess: true,
          pid: proc.pid,
          teamName,
          agentId: proc.agentId,
          resumeSessionId: proc.resumeSessionId,
          parentSessionId: proc.parentSessionId,
        });
      }
    }

    sessionListEl.appendChild(container);
  }

  // Ungrouped discovered sessions
  for (const proc of ungroupedProcesses) {
    appendDiscoveredCard(sessionListEl, {
      name: proc.agentName || proc.displayName,
      color: proc.agentColor,
      isRunning: proc.isRunning,
      hasProcess: true,
      pid: proc.pid,
      teamName: null,
      agentId: proc.agentId,
      resumeSessionId: proc.resumeSessionId,
      parentSessionId: proc.parentSessionId,
    });
  }
}

function appendDiscoveredCard(
  container: HTMLElement,
  info: {
    name: string;
    color: string | null;
    isRunning: boolean;
    hasProcess: boolean;
    pid: number | null;
    teamName: string | null;
    agentId: string | null;
    resumeSessionId: string | null;
    parentSessionId: string | null;
  }
): void {
  const card = document.createElement("div");
  card.className = "session-card discovered";
  if (info.teamName) card.classList.add("indented");

  const header = document.createElement("div");
  header.className = "session-card-header";

  const dot = document.createElement("div");
  dot.className = "status-dot discovered";
  if (info.isRunning) {
    dot.classList.add("discovered-running");
  }
  // Apply agent color if available
  if (info.color) {
    dot.style.background = getAgentColorValue(info.color);
  }
  header.appendChild(dot);

  const name = document.createElement("span");
  name.className = "session-name";
  name.textContent = info.name;
  header.appendChild(name);

  if (info.isRunning) {
    const badge = document.createElement("span");
    badge.className = "discovered-running-badge";
    badge.textContent = "R";
    badge.title = "Running (CPU active)";
    header.appendChild(badge);
  }

  card.appendChild(header);

  const statusLine = document.createElement("div");
  statusLine.className = "session-status-line";
  statusLine.textContent = info.hasProcess
    ? (info.isRunning ? "Running" : "Idle")
    : "No process";
  if (info.pid) statusLine.textContent += ` (PID ${info.pid})`;
  card.appendChild(statusLine);

  // Click to attach/resume discovered session
  card.style.cursor = "pointer";
  card.addEventListener("click", () => {
    void attachDiscoveredSession(info);
  });

  container.appendChild(card);
}

async function attachDiscoveredSession(info: {
  name: string;
  agentId: string | null;
  resumeSessionId: string | null;
  parentSessionId: string | null;
  hasProcess: boolean;
  pid: number | null;
}): Promise<void> {
  // Determine the CC session ID to resume
  let sessionId = info.resumeSessionId;
  let cwd: string | null = null;

  // If no explicit resume ID, try resolving from the session files
  if (!sessionId) {
    const resolved = await window.augmentApp.resolveDiscoveredSession({
      parentSessionId: info.parentSessionId,
      agentName: info.name,
      pid: info.pid,
    });
    if (resolved) {
      sessionId = resolved.sessionId;
      cwd = resolved.cwd;
    }
  }

  if (sessionId) {
    // Spawn a new terminal that resumes the CC session
    const created = await window.augmentApp.createTerminal({
      cwd: cwd || undefined,
      cmd: ["claude", "--resume", sessionId],
    });
    const session = createSessionView(created);
    session.name = info.name;
    session.ccSessionId = sessionId;
    sessions.set(created.id, session);
    setActive(created.id);
    showKeyHint(`Attached: ${info.name}`);
  } else if (info.hasProcess && info.pid) {
    // No session ID — show transcript as fallback
    try {
      const transcript = await window.augmentApp.readSessionTranscript(info.pid);
      if (transcript) {
        const created = await window.augmentApp.createTerminal();
        const session = createSessionView(created);
        session.name = `${info.name} (transcript)`;
        sessions.set(created.id, session);
        setActive(created.id);
        session.terminal.write(`\x1b[2m── Transcript for ${info.name} (PID ${info.pid}) ──\x1b[0m\r\n\r\n`);
        session.terminal.write(transcript);
        session.terminal.write(`\r\n\x1b[2m── End of transcript ──\x1b[0m\r\n`);
        showKeyHint(`Transcript: ${info.name}`);
      } else {
        showKeyHint(`No session data for ${info.name}`);
      }
    } catch {
      showKeyHint(`Cannot read transcript for ${info.name}`);
    }
  } else {
    showKeyHint(`No session data for ${info.name}`);
  }
}

function getAgentColorValue(colorName: string): string {
  const map: Record<string, string> = {
    green: "var(--accent-green)",
    blue: "var(--accent-blue)",
    yellow: "var(--accent-yellow)",
    red: "var(--accent-red)",
    purple: "var(--accent-purple)",
    orange: "#e0915a",
    pink: "#e06a9a",
    cyan: "#56c8d8",
  };
  return map[colorName] || "var(--text-dim)";
}

// ============================================================
// Render: focus header
// ============================================================

function renderFocusHeader(): void {
  const active = activeId !== null ? sessions.get(activeId) : null;

  // Attention badge — show when sidebar is collapsed and sessions need attention
  const sidebarCollapsed = appEl.classList.contains("sidebar-collapsed");
  const attentionQueue = getAttentionQueue();
  if (sidebarCollapsed && attentionQueue.length > 0) {
    focusAttentionBadge.textContent = `${attentionQueue.length} need attention`;
    focusAttentionBadge.classList.add("visible");
  } else {
    focusAttentionBadge.classList.remove("visible");
  }

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

  renderFocusHeader();
});

// Tmux shim: agent spawned — create a session view for the new agent
window.augmentApp.onAgentSpawned((payload) => {
  const session = createSessionView({ id: payload.id, cwd: "" });
  session.name = payload.name || `agent-${payload.id}`;
  sessions.set(payload.id, session);

  // Find the parent session (the one that triggered TeamCreate) and
  // assign this new agent session to the same group
  for (const [, s] of sessions) {
    if (s.id === payload.id) continue;
    if (s.teamNames.size > 0 && s.groupId !== null) {
      session.groupId = s.groupId;
      break;
    }
  }

  // If no group found via parent, try to match by team name from the group list
  if (session.groupId === null) {
    for (const group of groups.values()) {
      // Assign to the most recently created group
      session.groupId = group.id;
    }
  }

  renderSidebar();
  showKeyHint(`Agent spawned: ${session.name}`);
});

// Tmux shim: agent renamed
window.augmentApp.onAgentRenamed((payload) => {
  // Find session by matching the pane target pattern
  // Target could be a pane ID (%N) or a name
  for (const [, session] of sessions) {
    if (session.name === payload.target ||
        `%${session.id}` === payload.target) {
      session.name = payload.title;
      renderSidebar();
      if (session.id === activeId) renderFocusHeader();
      break;
    }
  }
});

// Discovery: external CC sessions discovered via process table + team configs
window.augmentApp.onDiscoveryUpdate((snapshot) => {
  latestDiscovery = snapshot;
  renderSidebar();
});

// ============================================================
// UI event handlers
// ============================================================

newSessionBtn.addEventListener("click", () => {
  void spawnSession();
});

function toggleSidebar(): void {
  appEl.classList.toggle("sidebar-collapsed");
  renderFocusHeader(); // update attention badge visibility
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
}

collapseSidebarBtn.addEventListener("click", () => {
  toggleSidebar();
});

focusSidebarToggle.addEventListener("click", () => {
  toggleSidebar();
});

focusAttentionBadge.addEventListener("click", () => {
  goToNextAttention();
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

  // Cmd+W — close/archive current session (three-stage lifecycle)
  if (meta && e.key === "w" && !e.shiftKey) {
    e.preventDefault();
    if (activeId !== null) {
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
    toggleSidebar();
    return;
  }


  // Cmd+H — toggle history visibility
  if (meta && e.key === "h" && !e.shiftKey) {
    e.preventDefault();
    showHistory = !showHistory;
    renderSidebar();
    showKeyHint(showHistory ? "History visible" : "History hidden");
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

  // Cmd+1-9 — jump to group (or session if no groups)
  if (meta && !e.shiftKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    const gList = getGroupList();

    if (gList.length > 0) {
      // Jump to group: expand it and focus its first session
      if (idx < gList.length) {
        const group = gList[idx];
        group.collapsed = false;
        const members = getGroupSessions(group.id);
        if (members.length > 0) {
          setActive(members[0].id);
          showKeyHint(`→ ${group.name}`);
        }
      }
    } else {
      // No groups — fall back to session-by-position
      const list = getSessionList();
      if (idx < list.length) {
        setActive(list[idx].id);
      }
    }
    return;
  }
});

// ============================================================
// Initialize
// ============================================================

renderEmptyState();
renderSidebar();

// Load archived sessions and cached discovery from disk, then spawn first session
void (async () => {
  try {
    const loaded = await window.augmentApp.loadHistory();
    if (Array.isArray(loaded) && loaded.length > 0) {
      archivedSessions = loaded;
      renderSidebar();
    }
  } catch {
    // History load failure is non-fatal
  }
  // Load cached discovery snapshot for instant sidebar population
  try {
    const cached = await window.augmentApp.getCachedDiscovery();
    if (cached && (cached.processes?.length || cached.teams?.length)) {
      latestDiscovery = cached;
      renderSidebar();
    }
  } catch {
    // Cache load failure is non-fatal
  }
  void spawnSession();
})();
