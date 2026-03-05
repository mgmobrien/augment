import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { PtyBridge } from "./pty-bridge";
// esbuild loads .css as text string via loader config
// @ts-ignore
import xtermCssText from "@xterm/xterm/css/xterm.css";

export const VIEW_TYPE_TERMINAL = "augment-terminal";

type TerminalStatus = "idle" | "active" | "tool" | "exited" | "shell" | "running" | "crashed";
type TeamEventType = "teamcreate" | "sendmessage";

type TeamEvent = {
  type: TeamEventType;
  at: number;
  team?: string;
  from?: string;
  to?: string;
  members?: string[];
};

export type TeamCreateSpawnHint = {
  sourceName: string;
  team?: string;
  members: string[];
};

type OrchestrationState = {
  teams?: string[];
  members?: string[];
  unreadActivity?: number;
  recentEvents?: TeamEvent[];
  agentIdentity?: string;
};

type TerminalViewState = {
  name?: string;
  snapshot?: string;
  orchestration?: OrchestrationState;
};

const MAX_SNAPSHOT_CHARS = 200_000;
const MAX_PARSE_BUFFER_CHARS = 24_000;
const MAX_TEAM_EVENTS = 40;
const EVENT_DEDUP_WINDOW_MS = 1200;

let xtermStyleEl: HTMLStyleElement | null = null;

export function cleanupXtermStyle(): void {
  if (xtermStyleEl) {
    xtermStyleEl.remove();
    xtermStyleEl = null;
  }
}

const ADJECTIVES = [
  "swift", "bright", "calm", "dark", "eager", "fair", "glad", "hazy",
  "keen", "lazy", "mild", "neat", "odd", "pale", "quick", "raw",
  "sharp", "tame", "vast", "warm", "bold", "crisp", "dense", "flat",
  "grim", "harsh", "icy", "jade", "lush", "mute", "numb", "plush",
  "rich", "sage", "taut", "vivid", "worn", "zinc", "amber", "bleak",
];

const NOUNS = [
  "arch", "bay", "cave", "dawn", "edge", "flint", "gate", "haze",
  "isle", "jade", "knot", "lake", "mesa", "node", "oak", "path",
  "quay", "reef", "slab", "tide", "vale", "weld", "yard", "zinc",
  "apex", "bolt", "clay", "dusk", "elm", "fork", "glen", "hull",
  "iron", "jetty", "keel", "loft", "marsh", "nave", "opal", "pier",
];

function generateTerminalName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

// Strip ANSI escape sequences for pattern matching.
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "");
}

// Tool invocation patterns in Claude Code output.
const TOOL_PATTERN = /\b(?:Bash|Read|Edit|Write|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|TeamCreate|SendMessage)\s*\(/;
const TEAM_CREATE_ACTIVITY_PATTERN = /\bTeamCreate\b/i;
const SEND_MESSAGE_ACTIVITY_PATTERN = /\bSendMessage\b/i;
const TEAM_NAME_PATTERN = /\bteam(?:Name)?\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i;
const TEAM_PATH_PATTERN = /\/teams\/([a-zA-Z0-9._-]+)\//i;
const AGENT_ID_PATTERN = /\bagentId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)/i;
const AGENT_ID_GLOBAL_PATTERN = /\bagentId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)/ig;
const AGENT_KEY_PATTERN = /\b(?:recipient|from|to|agentName|agent)\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/ig;
const MAILBOX_WRITE_PATTERN = /Wrote message to\s+([a-zA-Z0-9._-]+)'s inbox from\s+([a-zA-Z0-9._-]+)/i;
const GET_INBOX_AGENT_PATTERN = /\bgetInboxPath:\s*agent=([a-zA-Z0-9._-]+)/i;

export class TerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private ptyBridge: PtyBridge | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private parseBuffer: string = "";
  private pluginDir: string;
  private getUseWsl: () => boolean;
  private getPythonPath: () => string;
  private getShellPath: () => string;
  private getDefaultWorkingDirectory: () => string;
  private terminalName: string;
  private startedAt: number = Date.now();
  private skillName?: string;
  private isExited: boolean = false;
  private status: TerminalStatus = "shell";
  public onSessionExit?: (name: string, status: "exited" | "crashed", startedAt: number, skillName?: string) => void;
  private restoredSnapshot: string = "";
  private scrollbackBuffer: string = "";
  private statusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStatus: TerminalStatus | null = null;
  private teamNames: Set<string> = new Set();
  private teamMembers: Set<string> = new Set();
  private unreadActivity: number = 0;
  private recentTeamEvents: TeamEvent[] = [];
  private agentIdentity: string | null = null;
  private lastEventSignature: string = "";
  private lastEventAt: number = 0;
  private exchangeCount: number = 0;
  private lastActivityMs: number = Date.now();
  private userRenamed: boolean = false;
  private autoRenameNeeded: boolean = false;
  private autoNamedThisTurn: boolean = false;
  public onAutoRenameRequest?: (excerpt: string) => Promise<string | null>;

  constructor(
    leaf: WorkspaceLeaf,
    pluginDir: string,
    getUseWsl: () => boolean = () => false,
    getPythonPath: () => string = () => "",
    getShellPath: () => string = () => "",
    getDefaultWorkingDirectory: () => string = () => ""
  ) {
    super(leaf);
    this.pluginDir = pluginDir;
    this.getUseWsl = getUseWsl;
    this.getPythonPath = getPythonPath;
    this.getShellPath = getShellPath;
    this.getDefaultWorkingDirectory = getDefaultWorkingDirectory;
    this.terminalName = generateTerminalName();
  }

  getViewType(): string {
    return VIEW_TYPE_TERMINAL;
  }

  getDisplayText(): string {
    return this.terminalName;
  }

  getIcon(): string {
    return "terminal";
  }

  getName(): string {
    return this.terminalName;
  }

  getIsExited(): boolean {
    return this.isExited;
  }

  getStatus(): TerminalStatus {
    return this.status;
  }

  getUnreadActivity(): number {
    return this.unreadActivity;
  }

  getTeamNames(): string[] {
    return Array.from(this.teamNames);
  }

  getTeamMembers(): string[] {
    return Array.from(this.teamMembers);
  }

  getAgentIdentity(): string | null {
    return this.agentIdentity;
  }

  getLastTeamEventSummary(): string | null {
    const event = this.recentTeamEvents[this.recentTeamEvents.length - 1];
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

  setName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;

    this.terminalName = trimmed;
    this.userRenamed = true;
    this.refreshLeafName();
    this.persistNameToLeafState();
    this.app.workspace.trigger("augment-terminal:changed");
  }

  getState(): TerminalViewState {
    let snapshot = this.scrollbackBuffer;
    if (snapshot.length > MAX_SNAPSHOT_CHARS) {
      snapshot = snapshot.slice(-MAX_SNAPSHOT_CHARS);
    }

    return {
      name: this.terminalName,
      snapshot,
      orchestration: {
        teams: this.getTeamNames(),
        members: this.getTeamMembers(),
        unreadActivity: this.unreadActivity,
        recentEvents: [...this.recentTeamEvents],
        agentIdentity: this.agentIdentity ?? undefined,
      },
    };
  }

  async setState(state: TerminalViewState): Promise<void> {
    if (typeof state?.name === "string" && state.name.trim()) {
      this.terminalName = state.name.trim();
    }
    if (typeof state?.snapshot === "string") {
      this.restoredSnapshot = state.snapshot;
    }

    const orchestration = state?.orchestration;
    if (orchestration) {
      this.teamNames = new Set(
        Array.isArray(orchestration.teams)
          ? orchestration.teams
              .map((name) => this.normalizeIdentifier(name))
              .filter(Boolean)
          : []
      );

      this.teamMembers = new Set(
        Array.isArray(orchestration.members)
          ? orchestration.members
              .map((name) => this.normalizeIdentifier(name))
              .filter(Boolean)
          : []
      );

      this.unreadActivity = Number.isFinite(orchestration.unreadActivity)
        ? Math.max(0, Math.floor(orchestration.unreadActivity as number))
        : 0;

      this.recentTeamEvents = Array.isArray(orchestration.recentEvents)
        ? orchestration.recentEvents.slice(-MAX_TEAM_EVENTS)
        : [];

      this.agentIdentity =
        typeof orchestration.agentIdentity === "string" &&
        orchestration.agentIdentity.trim()
          ? orchestration.agentIdentity.trim()
          : null;
    }

    this.refreshLeafName();
    this.app.workspace.trigger("augment-terminal:changed");
  }

  private refreshLeafName(): void {
    const leafAny = this.leaf as any;
    if (typeof leafAny.updateHeader === "function") {
      leafAny.updateHeader();
    }

    const leafEl = this.contentEl.closest(".workspace-leaf");
    const headerTitleEl = leafEl?.querySelector(".view-header-title");
    if (headerTitleEl) {
      headerTitleEl.textContent = this.terminalName;
    }

    if (leafAny?.tabHeaderInnerTitleEl && typeof leafAny.tabHeaderInnerTitleEl.setText === "function") {
      leafAny.tabHeaderInnerTitleEl.setText(this.terminalName);
    }
    if (leafAny?.tabHeaderEl && typeof leafAny.tabHeaderEl.setAttribute === "function") {
      leafAny.tabHeaderEl.setAttribute("aria-label", this.terminalName);
    }
  }

  private persistNameToLeafState(): void {
    const leafAny = this.leaf as any;
    if (typeof leafAny.getViewState !== "function") return;

    const current = leafAny.getViewState();
    if (!current || current.type !== VIEW_TYPE_TERMINAL) return;

    const nextState = {
      ...current,
      state: {
        ...(current.state ?? {}),
        name: this.terminalName,
      },
    };

    void this.leaf.setViewState(nextState, { focus: false });
  }

  async onOpen(): Promise<void> {
    // Inject xterm.js CSS into document head (once).
    if (!xtermStyleEl) {
      xtermStyleEl = document.createElement("style");
      xtermStyleEl.id = "augment-xterm-css";
      xtermStyleEl.textContent = xtermCssText;
      document.head.appendChild(xtermStyleEl);
    }

    const container = this.contentEl;
    container.empty();
    container.addClass("augment-terminal-container");

    // Set initial tab status.
    this.setStatus("shell");

    // Create terminal.
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: this.getTheme(),
      allowProposedApi: true,
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    // Mount terminal.
    const termDiv = container.createDiv({ cls: "augment-terminal-xterm" });
    this.terminal.open(termDiv);

    // Restore previous terminal output snapshot, then spawn a fresh shell.
    if (this.restoredSnapshot) {
      this.terminal.write(this.restoredSnapshot);
      this.terminal.write(
        "\r\n\x1b[2m[Session restored: previous output snapshot; started new shell]\x1b[0m\r\n"
      );
    }

    // Start PTY.
    const vaultPath = (this.app.vault.adapter as any).basePath || ".";
    const customCwd = this.getDefaultWorkingDirectory();
    this.ptyBridge = new PtyBridge({
      pluginDir: this.pluginDir,
      cwd: customCwd || vaultPath,
      useWsl: this.getUseWsl(),
      pythonPath: this.getPythonPath(),
      shellPath: this.getShellPath(),
      onData: (data) => {
        this.terminal?.write(data);
        this.appendToScrollback(data);
        this.detectStatus(data);
        this.detectOrchestrationActivity(data);
      },
      onExit: (code) => {
        this.terminal?.write(`\r\n[Process exited with code ${code}]\r\n`);
        if (code === 9009 && process.platform === "win32") {
          this.terminal?.write(
            `\r\n\x1b[33m[Windows: Python not found in PATH. Augment requires WSL with python3.]\r\n` +
            `[Open Settings \u2192 Augment \u2192 Terminal to check setup status.]\x1b[0m\r\n`
          );
          const notice = new Notice(
            "Augment terminal: Python not found (exit 9009). Open Settings \u2192 Augment \u2192 Terminal to check setup.",
            0
          );
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting?.open?.();
            (this.app as any).setting?.openTabById?.("augment-terminal");
          });
        }
        this.isExited = true;
        const exitStatus: TerminalStatus = code === 0 ? "exited" : "crashed";
        this.setStatus(exitStatus);
        this.onSessionExit?.(this.terminalName, exitStatus, this.startedAt, this.skillName);
        this.app.workspace.trigger("augment-terminal:changed");
      },
    });
    this.ptyBridge.start();

    // Terminal input → PTY.
    this.terminal.onData((data) => {
      this.ptyBridge?.write(data);
    });

    // Handle resize — the ResizeObserver fires once the container has
    // its final dimensions, which also handles the initial fit.
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) {
          this.markActivityRead();
        }
      })
    );

    if (this.app.workspace.activeLeaf === this.leaf) {
      this.markActivityRead();
    }

    this.resizeObserver.observe(container);
  }

  private detectStatus(rawData: string): void {
    if (this.isExited) return;

    const clean = stripAnsi(rawData);

    let detected: TerminalStatus | null = null;

    // Check for tool invocations first (most specific).
    if (TOOL_PATTERN.test(clean)) {
      detected = "tool";
    }
    // Check for Claude Code thinking/output marker.
    else if (clean.includes("\u23FA")) {
      // ⏺
      detected = "active";
    }
    // Check for Claude Code idle prompt.
    else if (/❯\s*$/.test(clean) || (/\>\s*$/.test(clean) && clean.includes("claude"))) {
      detected = "idle";
    }

    if (detected !== null) {
      this.debouncedSetStatus(detected);
    }
  }

  private debouncedSetStatus(newStatus: TerminalStatus): void {
    this.pendingStatus = newStatus;
    if (this.statusDebounceTimer !== null) return;
    this.statusDebounceTimer = setTimeout(() => {
      this.statusDebounceTimer = null;
      if (this.pendingStatus !== null && this.pendingStatus !== this.status) {
        this.setStatus(this.pendingStatus);
      }
      this.pendingStatus = null;
    }, 150);
  }

  private setStatus(newStatus: TerminalStatus): void {
    const wasActive = this.status === "active" || this.status === "tool";
    const nowIdle = newStatus === "shell" || newStatus === "idle";
    if (wasActive && nowIdle) {
      this.exchangeCount++;
      this.lastActivityMs = Date.now();
      // Trigger auto-rename after exchange 3; retry on 4 and 5 if prior attempt failed.
      const shouldTry = (this.exchangeCount === 3) ||
        ((this.exchangeCount === 4 || this.exchangeCount === 5) && this.autoRenameNeeded);
      if (shouldTry && !this.userRenamed) {
        void this.triggerAutoRename();
      }
    }
    this.status = newStatus;
    this.contentEl
      .closest(".workspace-leaf")
      ?.setAttribute("data-augment-status", newStatus);
    (this.leaf as any).updateHeader();
    this.app.workspace.trigger("augment-terminal:changed");
  }

  private async triggerAutoRename(): Promise<void> {
    if (!this.onAutoRenameRequest || this.userRenamed) return;
    const excerpt = stripAnsi(this.scrollbackBuffer).slice(-2000);
    const name = await this.onAutoRenameRequest(excerpt);
    if (name) {
      this.autoRenameNeeded = false;
      this.terminalName = name;
      this.refreshLeafName();
      this.persistNameToLeafState();
      this.autoNamedThisTurn = true;
      this.app.workspace.trigger("augment-terminal:changed");
      setTimeout(() => { this.autoNamedThisTurn = false; }, 1500);
    } else {
      this.autoRenameNeeded = true;
    }
  }

  setSkillName(name: string): void {
    this.skillName = name;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  write(data: string): void {
    this.ptyBridge?.write(data);
  }

  markSkillRunning(): void {
    this.setStatus("running");
  }

  markActivityRead(): void {
    if (this.unreadActivity === 0) return;
    this.unreadActivity = 0;
    this.app.workspace.trigger("augment-terminal:changed");
  }

  getExchangeCount(): number { return this.exchangeCount; }
  getLastActivityMs(): number { return this.lastActivityMs; }
  getAutoNamed(): boolean { return this.autoNamedThisTurn; }

  private detectOrchestrationActivity(rawData: string): void {
    if (this.isExited) return;

    const cleanChunk = stripAnsi(rawData);
    if (!cleanChunk) return;

    this.parseBuffer = (this.parseBuffer + cleanChunk).slice(-MAX_PARSE_BUFFER_CHARS);
    const lines = this.parseBuffer.split(/\r?\n/);
    this.parseBuffer = lines.pop() ?? "";

    let changed = false;
    for (const line of lines) {
      changed = this.parseOrchestrationLine(line) || changed;
    }

    // If this chunk has no newline boundaries yet, still parse it for immediate tool activity.
    if (!/[\r\n]/.test(cleanChunk)) {
      changed = this.parseOrchestrationLine(cleanChunk) || changed;
    }

    if (changed) {
      this.app.workspace.trigger("augment-terminal:changed");
    }
  }

  private parseOrchestrationLine(line: string): boolean {
    const clean = line.trim();
    if (!clean) return false;

    let changed = false;

    const team = this.extractTeamName(clean);
    if (team) changed = this.addTeamName(team) || changed;

    const identity = this.extractAgentIdentity(clean);
    if (identity && identity !== this.agentIdentity) {
      this.agentIdentity = identity;
      changed = true;
    }

    const names = this.extractAgentNames(clean);
    for (const name of names) {
      changed = this.addTeamMember(name) || changed;
    }

    if (TEAM_CREATE_ACTIVITY_PATTERN.test(clean)) {
      const created = this.recordTeamEvent({
        type: "teamcreate",
        at: Date.now(),
        team: team ?? undefined,
        members: names,
      });
      if (created) {
        this.emitTeamCreateSpawnHint({
          sourceName: this.terminalName,
          team: team ?? undefined,
          members: names,
        });
      }
      changed = created || changed;
    }

    if (SEND_MESSAGE_ACTIVITY_PATTERN.test(clean) || MAILBOX_WRITE_PATTERN.test(clean)) {
      const details = this.extractSendMessageDetails(clean, team);
      changed =
        this.recordTeamEvent({
          type: "sendmessage",
          at: Date.now(),
          team: details.team,
          from: details.from,
          to: details.to,
        }) || changed;
    }

    return changed;
  }

  private recordTeamEvent(event: TeamEvent): boolean {
    const signature = `${event.type}|${event.team ?? ""}|${event.from ?? ""}|${event.to ?? ""}`;
    const now = Date.now();
    if (
      signature === this.lastEventSignature &&
      now - this.lastEventAt < EVENT_DEDUP_WINDOW_MS
    ) {
      return false;
    }

    this.lastEventSignature = signature;
    this.lastEventAt = now;

    this.recentTeamEvents.push(event);
    if (this.recentTeamEvents.length > MAX_TEAM_EVENTS) {
      this.recentTeamEvents = this.recentTeamEvents.slice(-MAX_TEAM_EVENTS);
    }

    if (this.app.workspace.activeLeaf !== this.leaf) {
      this.unreadActivity += 1;
    }

    return true;
  }

  private emitTeamCreateSpawnHint(hint: TeamCreateSpawnHint): void {
    const members = Array.from(
      new Set(
        hint.members
          .map((name) => this.normalizeIdentifier(name))
          .filter((name) => !!name)
      )
    );

    if (members.length === 0) return;

    const source = this.normalizeIdentifier(hint.sourceName);
    const filtered = members.filter((name) => name.toLowerCase() !== source.toLowerCase());
    if (filtered.length === 0) return;

    (this.app.workspace as any).trigger("augment-terminal:teamcreate", {
      sourceName: hint.sourceName,
      team: hint.team,
      members: filtered,
    } as TeamCreateSpawnHint);
  }

  private extractTeamName(text: string): string | null {
    const idMatch = text.match(AGENT_ID_PATTERN);
    if (idMatch?.[2]) {
      return this.normalizeIdentifier(idMatch[2]);
    }

    const teamMatch = text.match(TEAM_NAME_PATTERN);
    if (teamMatch?.[1]) {
      return this.normalizeIdentifier(teamMatch[1]);
    }

    const pathMatch = text.match(TEAM_PATH_PATTERN);
    if (pathMatch?.[1]) {
      return this.normalizeIdentifier(pathMatch[1]);
    }

    return null;
  }

  private extractAgentIdentity(text: string): string | null {
    const inbox = text.match(GET_INBOX_AGENT_PATTERN);
    if (inbox?.[1]) {
      return this.normalizeIdentifier(inbox[1]);
    }

    const byName = text.match(/\bagentName\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);
    if (byName?.[1]) {
      return this.normalizeIdentifier(byName[1]);
    }

    return null;
  }

  private extractAgentNames(text: string): string[] {
    const names = new Set<string>();

    for (const match of text.matchAll(AGENT_ID_GLOBAL_PATTERN)) {
      names.add(this.normalizeIdentifier(match[1]));
    }

    for (const match of text.matchAll(AGENT_KEY_PATTERN)) {
      names.add(this.normalizeIdentifier(match[1]));
    }

    const mailboxWrite = text.match(MAILBOX_WRITE_PATTERN);
    if (mailboxWrite?.[1]) names.add(this.normalizeIdentifier(mailboxWrite[1]));
    if (mailboxWrite?.[2]) names.add(this.normalizeIdentifier(mailboxWrite[2]));

    const identity = this.extractAgentIdentity(text);
    if (identity) names.add(identity);

    return Array.from(names).filter(Boolean);
  }

  private extractSendMessageDetails(
    text: string,
    fallbackTeam: string | null
  ): { team?: string; from?: string; to?: string } {
    const mailboxWrite = text.match(MAILBOX_WRITE_PATTERN);
    if (mailboxWrite?.[1] || mailboxWrite?.[2]) {
      return {
        team: fallbackTeam ?? undefined,
        to: mailboxWrite?.[1] ? this.normalizeIdentifier(mailboxWrite[1]) : undefined,
        from: mailboxWrite?.[2]
          ? this.normalizeIdentifier(mailboxWrite[2])
          : undefined,
      };
    }

    const recipient = text.match(/\brecipient\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);
    const from = text.match(/\bfrom\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);
    const agent = text.match(/\bagent(?:Name)?\s*[:=]\s*["']?([a-zA-Z0-9._-]+)/i);

    return {
      team: fallbackTeam ?? undefined,
      to: recipient?.[1] ? this.normalizeIdentifier(recipient[1]) : undefined,
      from: from?.[1]
        ? this.normalizeIdentifier(from[1])
        : agent?.[1]
          ? this.normalizeIdentifier(agent[1])
          : undefined,
    };
  }

  private addTeamName(value: string): boolean {
    if (!value || this.teamNames.has(value)) return false;
    this.teamNames.add(value);
    return true;
  }

  private addTeamMember(value: string): boolean {
    if (!value || this.teamMembers.has(value)) return false;
    this.teamMembers.add(value);
    return true;
  }

  private normalizeIdentifier(value: string): string {
    const trimmed = value.trim();
    const withoutQuotes = trimmed.replace(/^["']+|["']+$/g, "");
    return withoutQuotes.replace(/[^a-zA-Z0-9._-]+$/g, "");
  }

  private handleResize(): void {
    if (!this.fitAddon || !this.terminal) return;

    try {
      this.fitAddon.fit();
      const dims = this.fitAddon.proposeDimensions();
      if (dims) {
        this.ptyBridge?.resize(dims.rows, dims.cols);
      }
    } catch (e) {
      // Ignore resize errors during teardown.
    }
  }

  private appendToScrollback(data: string): void {
    this.scrollbackBuffer += data;
    if (this.scrollbackBuffer.length > MAX_SNAPSHOT_CHARS) {
      this.scrollbackBuffer = this.scrollbackBuffer.slice(-MAX_SNAPSHOT_CHARS);
    }
  }

  private getTheme(): any {
    // Use Obsidian's CSS variables for theme integration.
    const style = getComputedStyle(document.body);
    const isDark = document.body.classList.contains("theme-dark");

    return {
      background:
        style.getPropertyValue("--background-primary").trim() ||
        (isDark ? "#1e1e1e" : "#ffffff"),
      foreground:
        style.getPropertyValue("--text-normal").trim() ||
        (isDark ? "#d4d4d4" : "#1e1e1e"),
      cursor: style.getPropertyValue("--text-accent").trim() || "#528bff",
      cursorAccent:
        style.getPropertyValue("--background-primary").trim() ||
        (isDark ? "#1e1e1e" : "#ffffff"),
      selectionBackground:
        style.getPropertyValue("--text-selection").trim() ||
        "rgba(82, 139, 255, 0.3)",
    };
  }

  async onClose(): Promise<void> {
    if (this.statusDebounceTimer !== null) {
      clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }

    this.resizeObserver?.disconnect();
    this.ptyBridge?.kill();
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.ptyBridge = null;
    this.resizeObserver = null;
  }
}
