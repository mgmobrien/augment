import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { CanvasAddon } from "@xterm/addon-canvas";
import { PtyBridge } from "./pty-bridge";
import { detectDeps, invalidateDepsCache, CCDeps } from "./deps";
import { setupVaultForClaude } from "./vault-setup";
// esbuild loads .css as text string via loader config
// @ts-ignore
import xtermCssText from "@xterm/xterm/css/xterm.css";

export const VIEW_TYPE_TERMINAL = "augment-terminal";

type TerminalStatus = "idle" | "active" | "tool" | "waiting" | "exited" | "shell" | "running" | "crashed";

type ActivityState = "thinking" | "bash" | "read" | "write" | "mcp" | "waiting" | "idle" | null;
type CurrentActivity = { state: ActivityState; detail: string | null } | null;
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

// Map raw PTY errors and exit codes to user-friendly messages.
function translatePtyError(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes("enoent") || l.includes("no such file") || l.includes("command not found")) {
    if (l.includes("claude")) return "Claude Code isn't installed yet.";
    return "A required program is missing. Check setup in Settings → Augment → Terminal.";
  }
  if (l.includes("eacces") || l.includes("permission denied")) {
    return "Permission error — try running the install again.";
  }
  if (l.includes("sigkill") || l.includes("signal sigkill")) {
    return "Terminal bridge was killed by the OS during launch.";
  }
  return "The terminal connection failed.";
}

function translateExitCode(code: number): string | null {
  if (code === 0) return null;
  if (code === 127) return "Claude Code isn't installed yet.";
  return null;
}

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
    .replace(/\x1b\[[0-9;?]*[a-zA-Z@`]/g, "")           // CSI (including private mode ?25h etc.)
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b[^\\])*(?:\x07|\x1b\\)/g, "")  // OSC (BEL or ST terminator)
    .replace(/\x1b[()][0-9A-B]/g, "")                     // Charset designations
    .replace(/\x1b[=>78DMEHNOcn]/g, "");                  // Simple two-character escapes
}

// ── Teammate-message XML detector ──
// Non-blocking side-channel detector: NEVER buffers or delays the PTY data
// stream. All data passes through to terminal.write() immediately. This
// detector scans the stripped text for teammate-message blocks and emits
// compact formatted summaries as ADDITIONAL terminal output after the raw
// data has already been rendered.
class TeammateMessageFilter {
  private scanBuffer: string = "";
  private emit: (data: string) => void;

  constructor(emit: (data: string) => void) {
    this.emit = emit;
  }

  // Scan stripped text for complete teammate-message blocks.
  // Called AFTER data has already been written to the terminal.
  detect(cleanChunk: string): void {
    this.scanBuffer += cleanChunk;
    // Keep scan buffer bounded
    if (this.scanBuffer.length > 8000) {
      this.scanBuffer = this.scanBuffer.slice(-4000);
    }

    // Look for complete blocks
    const closeIdx = this.scanBuffer.indexOf("</teammate-message>");
    if (closeIdx === -1) return;

    const openIdx = this.scanBuffer.lastIndexOf("<teammate-message", closeIdx);
    if (openIdx === -1) {
      // Closing tag without opening — discard up to closing tag
      this.scanBuffer = this.scanBuffer.slice(closeIdx + 19);
      return;
    }

    const block = this.scanBuffer.slice(openIdx, closeIdx + 19);
    this.scanBuffer = this.scanBuffer.slice(closeIdx + 19);
    this.emitFormatted(block);
  }

  private emitFormatted(clean: string): void {
    const attr = (name: string): string =>
      clean.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
    const type = attr("type") || "message";
    const id = attr("teammate_id") || attr("recipient") || "?";
    const summary = attr("summary").slice(0, 70);

    const DIM = "\x1b[2m";
    const WARN = "\x1b[33m";
    const RST = "\x1b[0m";

    let line: string;
    switch (type) {
      case "message":
        line = `${DIM}\u2197 [${id}] ${summary}${RST}`;
        break;
      case "broadcast":
        line = `${DIM}\u2197 [broadcast] ${summary}${RST}`;
        break;
      case "shutdown_request":
        line = `${WARN}[shutdown request \u2192 ${id}]${RST}`;
        break;
      case "shutdown_response": {
        const approved = /approve.*true/i.test(clean);
        const verb = approved ? "approved" : "rejected";
        const color = approved ? DIM : WARN;
        line = `${color}[shutdown ${verb} \u2192 ${id}]${RST}`;
        break;
      }
      case "plan_approval_response": {
        const approved = /approve.*true/i.test(clean);
        const verb = approved ? "approved" : "rejected";
        const color = approved ? DIM : WARN;
        line = `${color}[plan ${verb} \u2192 ${id}]${RST}`;
        break;
      }
      default:
        line = `${DIM}\u2197 [${id}] ${summary || type}${RST}`;
    }

    this.emit(`\r\n${line}\r\n`);
  }

  destroy(): void {
    this.scanBuffer = "";
  }
}

// Tool invocation patterns in Claude Code output.
const TOOL_PATTERN = /\b(?:Bash|Read|Edit|Write|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|TeamCreate|SendMessage)\s*\(/;
const TOOL_DETAIL_PATTERN = /\b(Bash|Read|Edit|Write|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task|TeamCreate|SendMessage)\s*\(([^)\n]{0,120})\)/;
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
  private errorBannerEl: HTMLDivElement | null = null;
  private currentActivity: CurrentActivity = null;
  public onAutoRenameRequest?: (excerpt: string) => Promise<string | null>;
  private messageFilter: TeammateMessageFilter | null = null;
  private canvasAddon: CanvasAddon | null = null;
  private ptyStartedAtMs: number = 0;
  private startupRetryCount: number = 0;
  private resolvedCwd: string = "";
  private promptTurnCount: number = 0;
  private lastPromptText: string = "";
  private lastPromptAtMs: number = 0;
  private autoRenameInFlight: boolean = false;
  private lastAutoRenameAttemptAtMs: number = 0;
  private resizeRafId: number | null = null;
  private lastPtyRows: number = 0;
  private lastPtyCols: number = 0;
  private resizeInFlight: boolean = false;
  private resizeFlightTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedCellWidth: number = 0;
  private cachedCellHeight: number = 0;
  private windowResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAnalysis: string[] = [];
  private analysisRaf: number | null = null;
  private analysisTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    pluginDir: string,
    getShellPath: () => string = () => "",
    getDefaultWorkingDirectory: () => string = () => ""
  ) {
    super(leaf);
    this.pluginDir = pluginDir;
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

  getWorkingDirectory(): string {
    return this.resolvedCwd;
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

  getCurrentActivity(): CurrentActivity {
    return this.currentActivity;
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

    const tabHeaderEl: HTMLElement | null = leafAny?.tabHeaderEl ?? null;
    if (tabHeaderEl) {
      tabHeaderEl.setAttribute("aria-label", this.terminalName);
      tabHeaderEl.setAttribute("data-augment-terminal", "true");
      // Propagate current status so CSS can style the tab immediately.
      tabHeaderEl.setAttribute("data-augment-status", this.status ?? "shell");
      // Re-inject close button — updateHeader() may have wiped DOM children.
      this.ensureTabCloseButton(tabHeaderEl);
    }
  }

  // Injects a hover-to-close × button into the tab header if not already present.
  // Called after every updateHeader() because Obsidian may clear tab children.
  private ensureTabCloseButton(tabHeaderEl: HTMLElement): void {
    if (tabHeaderEl.querySelector(".augment-tab-close")) return;
    const btn = document.createElement("button");
    btn.className = "augment-tab-close";
    btn.setAttribute("aria-label", "Close terminal");
    btn.setAttribute("type", "button");
    btn.textContent = "×";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.leaf.detach();
    });
    tabHeaderEl.appendChild(btn);
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

    // Always boot the terminal immediately — never block on dep checks.
    this.bootTerminal();

    // Show a "Checking setup…" overlay if dep detection takes more than 300ms
    // (avoids a flash on cache hits, but makes the wait visible otherwise).
    let loadingEl: HTMLElement | null = null;
    const loadTimer = window.setTimeout(() => {
      if (!this.isSetupBypassed()) {
        loadingEl = this.contentEl.createDiv({ cls: "augment-bootstrapper-wrapper" });
        loadingEl.createEl("p", { cls: "augment-bootstrapper-desc", text: "Checking setup\u2026" });
      }
    }, 300);

    // Run dep detection in background; overlay bootstrapper if something is missing.
    detectDeps(this.app).then((deps) => {
      window.clearTimeout(loadTimer);
      if (loadingEl) { loadingEl.remove(); loadingEl = null; }
      if ((!deps.cc || !deps.authed || !deps.vaultConfigured) && !this.isSetupBypassed()) {
        this.renderBootstrapper(this.contentEl, deps);
      }
    }).catch(() => {
      window.clearTimeout(loadTimer);
      if (loadingEl) { loadingEl.remove(); loadingEl = null; }
      // If dep detection itself errors, don't block the terminal.
    });
  }

  private isSetupBypassed(): boolean {
    const plugin = (this.app as any).plugins?.plugins?.["augment-terminal"];
    return !!plugin?.settings?.terminalSetupBypassed;
  }

  private setSetupBypassed(value: boolean): void {
    const plugin = (this.app as any).plugins?.plugins?.["augment-terminal"];
    if (!plugin?.settings) return;
    plugin.settings.terminalSetupBypassed = value;
    if (value) plugin.settings.terminalSetupDone = true;
    void plugin.saveData(plugin.settings);
  }

  private markTerminalSetupDone(): void {
    const plugin = (this.app as any).plugins?.plugins?.["augment-terminal"];
    if (!plugin?.settings || plugin.settings.terminalSetupDone) return;
    plugin.settings.terminalSetupDone = true;
    void plugin.saveData(plugin.settings);
  }

  private openTerminalSettings(): void {
    (this.app as any).setting?.open?.();
    (this.app as any).setting?.openTabById?.("augment-terminal");
  }

  private createBootstrapperBypassActions(wrapper: HTMLElement, dismiss: () => void): void {
    const actions = wrapper.createDiv({ cls: "augment-bootstrapper-actions" });

    const continueBtn = actions.createEl("button", {
      cls: "augment-bootstrapper-btn augment-bootstrapper-btn--secondary",
      text: "Skip for now",
    });
    setIcon(continueBtn, "play");
    continueBtn.addEventListener("click", () => dismiss());

    const bypassBtn = actions.createEl("button", {
      cls: "augment-bootstrapper-btn augment-bootstrapper-btn--secondary",
      text: "Disable setup checks",
    });
    setIcon(bypassBtn, "eye-off");
    bypassBtn.addEventListener("click", () => {
      this.setSetupBypassed(true);
      dismiss();
    });
  }

  // Transition the bootstrapper overlay to a "running" state after an action fires.
  // Shows a Verify button that re-detects deps and re-renders or dismisses.
  private renderBootstrapperRunning(wrapper: HTMLElement, title: string, desc: string): void {
    wrapper.empty();
    wrapper.createEl("h2", { text: title, cls: "augment-bootstrapper-title" });
    wrapper.createEl("p", { text: desc, cls: "augment-bootstrapper-desc" });

    const verifyBtn = wrapper.createEl("button", { cls: "mod-cta augment-bootstrapper-btn", text: "Verify" });
    setIcon(verifyBtn, "check");
    verifyBtn.onclick = () => {
      verifyBtn.disabled = true;
      verifyBtn.textContent = "Checking\u2026";
      detectDeps(this.app, { forceFresh: true }).then((newDeps) => {
        wrapper.remove();
        if ((!newDeps.cc || !newDeps.authed || !newDeps.vaultConfigured) && !this.isSetupBypassed()) {
          this.renderBootstrapper(this.contentEl, newDeps);
        }
      }).catch(() => wrapper.remove());
    };

    const dismiss = () => wrapper.remove();
    this.createBootstrapperBypassActions(wrapper, dismiss);
  }

  private renderBootstrapper(container: HTMLElement, deps: CCDeps): void {
    // Overlay on top of the already-running terminal.
    const wrapper = container.createDiv({ cls: "augment-bootstrapper-wrapper" });
    const needsRuntimeSetup = !deps.node || !deps.cc || !deps.authed;

    // When deps (Node and/or Claude) were found only in WSL but the
    // terminal is running a native Windows shell, guide the user to switch.
    // This covers both "fully installed in WSL" and "Node in WSL, Claude
    // not yet installed" — in either case, the native shell can't use them.
    const shellPath = this.getShellPath();
    const isWslShell = /wsl/i.test(shellPath);
    if (deps.wslOnly && !isWslShell) {
      wrapper.createEl("h2", {
        text: "Switch terminal to WSL",
        cls: "augment-bootstrapper-title",
      });
      wrapper.createEl("p", {
        text: "Node.js and Claude Code were found in WSL but the terminal is running a native Windows shell. Go to Settings \u2192 Augment \u2192 Terminal and change the shell to WSL, then reopen this terminal.",
        cls: "augment-bootstrapper-desc",
      });
      this.createBootstrapperBypassActions(wrapper, () => wrapper.remove());
      return;
    }

    wrapper.createEl("h2", {
      text: needsRuntimeSetup ? "Set up Claude Code" : "Finish terminal setup",
      cls: "augment-bootstrapper-title",
    });
    wrapper.createEl("p", {
      text: needsRuntimeSetup
        ? "Terminal sessions in Augment run on Claude Code, Anthropic\u2019s command-line AI agent."
        : "Claude Code is ready. One more step lets it understand this vault.",
      cls: "augment-bootstrapper-desc",
    });

    const dismiss = () => wrapper.remove();

    if (!deps.node) {
      wrapper.createEl("p", {
        text: "Claude Code requires Node.js. Download and run the installer, then click \u2018Check again\u2019 below.",
        cls: "augment-bootstrapper-desc",
      });
      const btn = wrapper.createEl("button", { cls: "mod-cta augment-bootstrapper-btn", text: "Download Node.js" });
      setIcon(btn, "download");
      btn.onclick = () => window.open("https://nodejs.org");

      // User must install externally — provide a re-check button so they don't have to reopen.
      const checkBtn = wrapper.createEl("button", {
        cls: "augment-bootstrapper-btn augment-bootstrapper-btn--secondary",
        text: "Check again",
      });
      setIcon(checkBtn, "refresh-cw");
      checkBtn.onclick = () => {
        checkBtn.disabled = true;
        checkBtn.textContent = "Checking\u2026";
        detectDeps(this.app, { forceFresh: true }).then((newDeps) => {
          wrapper.remove();
          if ((!newDeps.cc || !newDeps.authed || !newDeps.vaultConfigured) && !this.isSetupBypassed()) {
            this.renderBootstrapper(this.contentEl, newDeps);
          }
        }).catch(() => {
          checkBtn.disabled = false;
          checkBtn.textContent = "Check again";
        });
      };

      this.createBootstrapperBypassActions(wrapper, dismiss);
      return;
    }

    if (!deps.cc) {
      wrapper.createEl("p", {
        text: "Claude Code is not installed. Click Install — the installer will run in the terminal below.",
        cls: "augment-bootstrapper-desc",
      });
      const btn = wrapper.createEl("button", { cls: "mod-cta augment-bootstrapper-btn", text: "Install Claude Code" });
      setIcon(btn, "terminal");
      btn.onclick = () => {
        invalidateDepsCache();
        this.ptyBridge?.write("npm install -g @anthropic-ai/claude-code && claude auth login\n");
        this.renderBootstrapperRunning(
          wrapper,
          "Installing Claude Code\u2026",
          "The installer is running in the terminal below. When it completes and sign-in is done, click Verify."
        );
      };
      this.createBootstrapperBypassActions(wrapper, dismiss);
      return;
    }

    if (!deps.authed) {
      wrapper.createEl("p", {
        text: "Sign in to connect your Anthropic account. Your browser will open to complete sign-in.",
        cls: "augment-bootstrapper-desc",
      });
      const btn = wrapper.createEl("button", { cls: "mod-cta augment-bootstrapper-btn", text: "Sign in to Claude" });
      setIcon(btn, "log-in");
      btn.onclick = () => {
        invalidateDepsCache();
        this.ptyBridge?.write("claude auth login\n");
        this.renderBootstrapperRunning(
          wrapper,
          "Sign-in started",
          "Complete sign-in in the terminal below or your browser. Click Verify when done."
        );
      };
      this.createBootstrapperBypassActions(wrapper, dismiss);
      return;
    }

    if (!deps.vaultConfigured) {
      wrapper.createEl("p", {
        text: "Creates CLAUDE.md and a starter agents/skills folder so Claude Code understands this vault.",
        cls: "augment-bootstrapper-desc",
      });
      const btn = wrapper.createEl("button", { cls: "mod-cta augment-bootstrapper-btn", text: "Set up vault" });
      setIcon(btn, "folder-plus");
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Setting up\u2026";
        try {
          const plugin = (this.app as any).plugins?.plugins?.["augment-terminal"];
          const templateFolder = plugin?.settings?.templateFolder || "Augment/templates";
          await setupVaultForClaude(this.app, templateFolder);
          invalidateDepsCache();
          this.markTerminalSetupDone();
          dismiss();
          new Notice("Vault setup complete.");
        } catch (error) {
          console.error("[Augment] vault scaffold failed from terminal bootstrapper", error);
          btn.disabled = false;
          btn.textContent = "Set up vault";
          new Notice("Vault setup failed. Open Terminal settings to try again.");
        }
      };

      const settingsBtn = wrapper.createEl("button", {
        cls: "augment-bootstrapper-btn augment-bootstrapper-btn--secondary",
        text: "Open Terminal settings",
      });
      setIcon(settingsBtn, "settings");
      settingsBtn.onclick = () => this.openTerminalSettings();

      this.createBootstrapperBypassActions(wrapper, dismiss);
      return;
    }
  }

  private bootTerminal(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("augment-terminal-container");

    // Set initial tab status.
    this.setStatus("shell");

    // Create terminal.
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: this.getTerminalFontFamily(),
      theme: this.getTheme(),
      allowProposedApi: true,
      scrollback: 10000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    // Error recovery banner — shown when the PTY fails to start or crashes.
    const errorBanner = container.createDiv({ cls: "augment-terminal-error-banner" });
    errorBanner.style.display = "none";
    this.errorBannerEl = errorBanner;

    // Mount terminal.
    const termDiv = container.createDiv({ cls: "augment-terminal-xterm" });
    this.openTerminalWithStableMetrics(termDiv);

    // Switch to Canvas renderer — uses independent 2D canvas contexts per
    // terminal (no shared global state like WebGL's CharAtlasCache). This
    // eliminates cross-terminal glyph corruption in 2x2+ layouts where
    // WebGL's shared texture atlas caused one pane's resize to corrupt
    // siblings' glyph textures. Falls back to DOM renderer silently.
    try {
      const canvas = new CanvasAddon();
      this.terminal.loadAddon(canvas);
      this.canvasAddon = canvas;
    } catch {
      // Canvas addon not available — DOM renderer continues as fallback.
    }

    // Fit immediately so the terminal has correct dimensions before any
    // content is written — avoids garbled snapshot restore and ensures
    // the PTY starts with the right cols/rows instead of default 80x24.
    this.applyResize();
    this.updateCellCache();

    // Restore previous terminal output snapshot, then spawn a fresh shell.
    if (this.restoredSnapshot) {
      this.terminal.write(this.restoredSnapshot);
      this.terminal.write(
        "\r\n\x1b[2m[Session restored: previous output snapshot; started new shell]\x1b[0m\r\n"
      );
    }

    // Start PTY.
    this.startPtyBridge();

    // Terminal input → PTY.
    this.terminal.onData((data) => {
      this.ptyBridge?.write(data);
    });

    // Handle resize — the ResizeObserver fires once the container has
    // its final dimensions, which also handles the initial fit.
    // Cell-grid gate: only schedule a resize if the container change would
    // actually produce different cols/rows. This is pure arithmetic (no DOM
    // reads) and eliminates 90%+ of resize cycles in 2x2 layouts where
    // Obsidian's flex recalculates all panes on every micro-shift.
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (this.wouldChangeCellGrid(width, height)) {
        this.scheduleResize();
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) {
          this.markActivityRead();
          // Do NOT resize on focus change. Focus does not change container
          // dimensions. ResizeObserver handles the case where a previously-
          // hidden pane becomes visible and gets dimensions. Resizing on
          // every focus change in a 2x2 layout fires 4 unnecessary resize
          // cycles that interrupt TUI mid-paint.
        }
      })
    );

    if (this.app.workspace.activeLeaf === this.leaf) {
      this.markActivityRead();
    }

    this.resizeObserver.observe(termDiv);
    this.registerTerminalMetricObservers();
    // No boot-time delayed resize needed — ResizeObserver fires when the
    // element gets dimensions (including deferred visibility), and the
    // initial applyResize() call above handles the sync case.
  }

  private startPtyBridge(forcedShellPath?: string): void {
    const vaultPath = (this.app.vault.adapter as any).basePath || ".";
    const customCwd = this.getDefaultWorkingDirectory();
    this.resolvedCwd = customCwd || vaultPath;
    const shellPath = forcedShellPath ?? this.getShellPath();
    this.ptyStartedAtMs = Date.now();
    this.ptyBridge?.kill();
    this.messageFilter?.destroy();
    this.messageFilter = new TeammateMessageFilter((formatted) => {
      this.terminal?.write(formatted);
      // Include formatted summaries in scrollback so snapshot restore
      // and auto-rename see the same output the user saw live (not raw XML).
      this.appendToScrollback(formatted);
    });
    // Clear any queued analysis from the previous PTY session so stale
    // output from a failed shell doesn't produce bogus status/rename signals
    // against the new session (e.g., during automatic fallback-shell retries).
    this.flushPendingAnalysis();
    this.ptyBridge = new PtyBridge({
      pluginDir: this.pluginDir,
      cwd: this.resolvedCwd,
      shellPath,
      initialRows: this.terminal?.rows ?? 0,
      initialCols: this.terminal?.cols ?? 0,
      onData: (data) => {
        // ALWAYS write to terminal FIRST, immediately, with zero delay.
        // Never let analysis or filtering block the data path.
        this.terminal?.write(data);
        this.appendToScrollback(data);
        // Batch analysis using rAF (preferred) with setTimeout fallback.
        // rAF is throttled/paused when the Electron window is hidden, so
        // the fallback ensures analysis drains even for background sessions
        // and prevents unbounded pendingAnalysis growth.
        this.pendingAnalysis.push(data);
        if (!this.analysisRaf && !this.analysisTimer) {
          this.analysisRaf = requestAnimationFrame(() => {
            this.analysisRaf = null;
            this.drainAnalysis();
          });
          // Fallback: if rAF doesn't fire within 500ms (window hidden),
          // drain via setTimeout instead.
          this.analysisTimer = setTimeout(() => {
            this.analysisTimer = null;
            if (this.analysisRaf !== null) {
              cancelAnimationFrame(this.analysisRaf);
              this.analysisRaf = null;
            }
            this.drainAnalysis();
          }, 500);
        }
      },
      onError: (err) => {
        const friendly = translatePtyError(err.message);
        this.showErrorBanner(friendly, err.message);
      },
      onExit: (code, signal) => {
        const runtimeMs = Date.now() - this.ptyStartedAtMs;
        const exitedImmediately = code === 0 && !signal && runtimeMs < 1200;
        if (exitedImmediately && this.startupRetryCount < 2) {
          const isWin = process.platform === "win32";
          const fallbackShell = this.startupRetryCount === 0
            ? (isWin ? "powershell.exe" : "/bin/bash")
            : (isWin ? "cmd.exe" : "/bin/zsh");
          this.startupRetryCount++;
          this.terminal?.write(
            `\r\n\x1b[2m[Shell exited quickly (${runtimeMs}ms); retrying with ${fallbackShell}]\x1b[0m\r\n`
          );
          this.startPtyBridge(fallbackShell);
          return;
        }

        if (signal) {
          this.terminal?.write(`\r\n[Process terminated by ${signal}]\r\n`);
        } else {
          this.terminal?.write(`\r\n[Process exited with code ${code}]\r\n`);
        }
        this.isExited = true;
        const exitStatus: TerminalStatus = signal ? "crashed" : (code === 0 ? "exited" : "crashed");
        this.setStatus(exitStatus);
        this.onSessionExit?.(this.terminalName, exitStatus, this.startedAt, this.skillName);
        this.app.workspace.trigger("augment-terminal:changed");
        if (signal) {
          const friendly = translatePtyError(`signal ${signal}`);
          this.showErrorBanner(friendly, `Signal: ${signal}`);
        } else if (code !== 0) {
          const friendly = translateExitCode(code) ?? translatePtyError(`exit ${code}`);
          this.showErrorBanner(friendly, `Exit code: ${code}`);
        }
      },
    });
    this.ptyBridge.start();
  }

  private showErrorBanner(friendly: string, raw?: string): void {
    const banner = this.errorBannerEl;
    if (!banner) return;
    banner.empty();
    banner.style.display = "";

    const msg = banner.createDiv({ cls: "augment-terminal-error-msg" });
    msg.setText(friendly);

    const actions = banner.createDiv({ cls: "augment-terminal-error-actions" });

    const retryBtn = actions.createEl("button", { cls: "augment-terminal-error-btn", text: "Retry" });
    retryBtn.addEventListener("click", () => {
      banner.style.display = "none";
      this.isExited = false;
      this.setStatus("shell");
      this.terminal?.write("\r\n\x1b[2m[Retrying connection\u2026]\x1b[0m\r\n");
      this.startPtyBridge();
    });

    const setupBtn = actions.createEl("button", { cls: "augment-terminal-error-btn", text: "Open Terminal settings" });
    setupBtn.addEventListener("click", () => this.openTerminalSettings());

    if (raw) {
      let detailsVisible = false;
      const detailsBtn = actions.createEl("button", { cls: "augment-terminal-error-btn augment-terminal-error-btn--ghost", text: "Show details" });
      const rawEl = banner.createEl("pre", { cls: "augment-terminal-error-raw", text: raw });
      rawEl.style.display = "none";
      detailsBtn.addEventListener("click", () => {
        detailsVisible = !detailsVisible;
        rawEl.style.display = detailsVisible ? "" : "none";
        detailsBtn.setText(detailsVisible ? "Hide details" : "Show details");
      });
    }
  }

  private detectStatus(clean: string): void {
    if (this.isExited) return;

    let detected: TerminalStatus | null = null;

    // Check for tool invocations first (most specific).
    if (TOOL_PATTERN.test(clean)) {
      detected = "tool";
      const m = TOOL_DETAIL_PATTERN.exec(clean);
      if (m) {
        const toolName = m[1];
        const arg = m[2].trim().slice(0, 100);
        let state: ActivityState;
        if (toolName === "Bash") state = "bash";
        else if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") state = "read";
        else if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") state = "write";
        else state = "mcp";
        this.currentActivity = { state, detail: arg || null };
      }
    }
    // Check for Claude Code thinking/output marker.
    else if (clean.includes("\u23FA")) {
      // ⏺
      detected = "active";
      this.currentActivity = { state: "thinking", detail: null };
    }
    // Check for Claude Code waiting-for-input prompt.
    else if (/❯\s*$/.test(clean) || (/\>\s*$/.test(clean) && clean.includes("claude"))) {
      detected = "waiting";
      this.currentActivity = { state: "waiting", detail: null };
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

  // Auto-rename path — works without external hooks.
  //
  // Two independent counting mechanisms both call triggerAutoRename() at turn 3:
  //
  //   1. exchangeCount (status-transition based): setStatus() increments when
  //      transitioning from active|tool → shell|idle|waiting. Reliable when
  //      Claude Code's status markers (⏺, tool lines, ❯) are detectable.
  //
  //   2. promptTurnCount (output-parsing based): detectUserPromptTurns() scans
  //      raw PTY output for "❯ <text>" lines (Claude Code echoing user input).
  //      Fires independently of status state — covers noisy or ambiguous transitions.
  //
  // triggerAutoRename() calls onAutoRenameRequest(excerpt) which:
  //   - Derives a local keyword name from the last 3 ❯ prompt lines (no API needed).
  //   - Enriches via Haiku API if an API key is present, falls back to local on error.
  //
  // Hook-dependent paths (extractPaneNameHookRename, extractTmuxRename) fire earlier
  // if Claude Code emits pane-name.sh or tmux rename commands, but are not required.
  // The rename works end-to-end without any shell hooks installed.
  //
  // Retries: autoRenameNeeded flag enables retries at exchanges/turns 4 and 5 if the
  // name call returned null. autoRenameInFlight + 1200ms cooldown prevent both triggers
  // from firing simultaneously.
  private setStatus(newStatus: TerminalStatus): void {
    const wasActive = this.status === "active" || this.status === "tool";
    const nowIdle = newStatus === "shell" || newStatus === "idle" || newStatus === "waiting";
    const nowActive = newStatus === "active" || newStatus === "tool";
    // Update timestamp when a new user request begins (idle → active), so the
    // activity timer shows the start of the current response, not the end of
    // the previous one.
    if (!wasActive && nowActive) {
      this.lastActivityMs = Date.now();
    }
    if (wasActive && nowIdle) {
      this.exchangeCount++;
      this.lastActivityMs = Date.now();
      // Trigger auto-rename after exchange 1 (enough content for a local name).
      // Haiku API is called again at exchange 3 as a quality upgrade if available.
      // Retries at 4 and 5 if prior attempt returned null.
      const shouldTry = (this.exchangeCount === 1) ||
        (this.exchangeCount === 3) ||
        ((this.exchangeCount === 4 || this.exchangeCount === 5) && this.autoRenameNeeded);
      if (shouldTry && !this.userRenamed) {
        void this.triggerAutoRename();
      }
    }
    this.status = newStatus;
    this.contentEl
      .closest(".workspace-leaf")
      ?.setAttribute("data-augment-status", newStatus);
    const leafAnyS = this.leaf as any;
    leafAnyS.updateHeader?.();
    // Propagate status to tab header for sidebar tab styling.
    const tabHeaderElS: HTMLElement | null = leafAnyS?.tabHeaderEl ?? null;
    if (tabHeaderElS) {
      tabHeaderElS.setAttribute("data-augment-status", newStatus);
      // Re-inject close button in case updateHeader() cleared DOM children.
      this.ensureTabCloseButton(tabHeaderElS);
    }
    this.app.workspace.trigger("augment-terminal:changed");
  }

  private async triggerAutoRename(): Promise<void> {
    if (!this.onAutoRenameRequest || this.userRenamed) return;
    const now = Date.now();
    if (this.autoRenameInFlight) return;
    if (now - this.lastAutoRenameAttemptAtMs < 1200) return;
    this.autoRenameInFlight = true;
    this.lastAutoRenameAttemptAtMs = now;
    const excerpt = stripAnsi(this.scrollbackBuffer).slice(-2000);
    try {
      const name = await this.onAutoRenameRequest(excerpt);
      if (name) {
        this.applyAutoName(name);
      } else {
        this.autoRenameNeeded = true;
      }
    } finally {
      this.autoRenameInFlight = false;
    }
  }

  // Secondary rename trigger: count explicit user submitted turns from Claude's
  // prompt lines (`❯ user text`). This covers cases where status transitions are
  // too noisy to reliably increment exchangeCount.
  private detectUserPromptTurns(rawData: string): void {
    if (this.userRenamed || this.isExited) return;

    const clean = stripAnsi(rawData);
    if (!clean) return;

    const lines = clean.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*❯\s+(.+?)\s*$/);
      if (!m?.[1]) continue;
      const text = m[1].trim();
      if (!text) continue;

      const now = Date.now();
      if (text === this.lastPromptText && now - this.lastPromptAtMs < 3000) {
        continue;
      }

      this.lastPromptText = text;
      this.lastPromptAtMs = now;
      this.promptTurnCount++;

      const shouldTry =
        this.promptTurnCount === 1 ||
        this.promptTurnCount === 3 ||
        ((this.promptTurnCount === 4 || this.promptTurnCount === 5) && this.autoRenameNeeded);

      if (shouldTry) {
        void this.triggerAutoRename();
      }
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
    // Claude Code is a TUI and frequently redraws with bare '\r'.
    // Treat both '\r' and '\n' as boundaries for orchestration parsing.
    const lines = this.parseBuffer.split(/[\r\n]+/);
    this.parseBuffer = lines.pop() ?? "";

    let changed = false;
    for (const line of lines) {
      changed = this.parseOrchestrationLine(line) || changed;
    }

    // If this chunk has no newline boundaries yet, still parse it for immediate tool activity.
    if (!/[\r\n]/.test(cleanChunk)) {
      changed = this.parseOrchestrationLine(this.parseBuffer) || changed;
    }

    if (changed) {
      this.app.workspace.trigger("augment-terminal:changed");
    }
  }

  private parseOrchestrationLine(line: string): boolean {
    const clean = line.trim();
    if (!clean) return false;

    let changed = false;
    const renameFromHook = this.extractPaneNameHookRename(clean);
    if (renameFromHook && !this.userRenamed) {
      changed = this.applyAutoName(renameFromHook) || changed;
    }

    const renameFromTmux = this.extractTmuxRename(clean);
    if (renameFromTmux && !this.userRenamed) {
      changed = this.applyAutoName(renameFromTmux) || changed;
    }

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

  // Claude's pane-name hook can emit a Bash tool line like:
  //   Bash(bash ~/.claude/hooks/pane-name.sh topic "dirt bikes pros cons")
  // In Augment that may be the only observable rename signal, so capture it.
  private extractPaneNameHookRename(text: string): string | null {
    if (!/\bBash\(/i.test(text) || !/pane-name\.sh/i.test(text)) return null;

    const topicCall = text.match(
      /pane-name\.sh[\s\S]*?topic\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s)]+))/i
    );
    if (!topicCall) return null;

    return this.normalizeRenameCandidate(
      topicCall[1] ?? topicCall[2] ?? topicCall[3] ?? topicCall[4] ?? ""
    );
  }

  // Claude Code often emits tmux rename commands (e.g. select-pane -T) after
  // a few turns. In Augment there may be no live tmux bridge, so mirror that
  // intent by applying the requested title directly to the leaf state.
  private extractTmuxRename(text: string): string | null {
    if (!/\bBash\(/i.test(text) || !/\btmux\b/i.test(text)) return null;

    const selectPane = text.match(
      /\btmux\b[\s\S]*?\bselect-pane\b[\s\S]*?\s-T\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s)]+))/i
    );
    if (selectPane) {
      return this.normalizeRenameCandidate(
        selectPane[1] ?? selectPane[2] ?? selectPane[3] ?? selectPane[4] ?? ""
      );
    }

    const renameWindow = text.match(
      /\btmux\b[\s\S]*?\brename-window\b[\s\S]*?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s)]+))/i
    );
    if (renameWindow) {
      return this.normalizeRenameCandidate(
        renameWindow[1] ?? renameWindow[2] ?? renameWindow[3] ?? renameWindow[4] ?? ""
      );
    }

    return null;
  }

  private normalizeRenameCandidate(value: string): string | null {
    const cleaned = value
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\(["'`\\])/g, "$1")
      .trim()
      .slice(0, 80);
    return cleaned || null;
  }

  private applyAutoName(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this.terminalName) return false;

    this.autoRenameNeeded = false;
    this.terminalName = trimmed;
    this.refreshLeafName();
    this.persistNameToLeafState();
    this.autoNamedThisTurn = true;
    this.app.workspace.trigger("augment-terminal:changed");
    // Belt-and-suspenders: directly call requestRefresh() on any open
    // TerminalManagerViews. The workspace event above can be debounced away
    // when a rAF frame from a concurrent setStatus() is already in-flight.
    // Direct call bypasses the event/rAF race entirely.
    this.app.workspace.getLeavesOfType("augment-terminal-manager").forEach(leaf => {
      (leaf.view as any).requestRefresh?.();
    });
    // Second fallback 150ms later — covers the case where persistNameToLeafState()
    // causes Obsidian to call setState() async, which can emit layout-change and
    // temporarily shadow the name before our update is visible to TM.
    setTimeout(() => {
      if (this.terminalName === trimmed) {
        this.app.workspace.getLeavesOfType("augment-terminal-manager").forEach(leaf => {
          (leaf.view as any).requestRefresh?.();
        });
      }
      this.autoNamedThisTurn = false;
    }, 150);
    return true;
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

  private openTerminalWithStableMetrics(termDiv: HTMLDivElement): void {
    if (!this.terminal) return;

    // xterm's DOM renderer compares two different font measurement paths.
    // In Electron, OffscreenCanvas metrics can drift from actual DOM glyph
    // widths, which explodes row height and injected letter-spacing.
    const globalScope = globalThis as typeof globalThis & {
      OffscreenCanvas?: typeof OffscreenCanvas;
    };
    const hadOwnOffscreenCanvas = Object.prototype.hasOwnProperty.call(globalScope, "OffscreenCanvas");
    const originalOffscreenCanvas = globalScope.OffscreenCanvas;

    try {
      (globalScope as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas = undefined;
      this.terminal.open(termDiv);
    } finally {
      if (hadOwnOffscreenCanvas) {
        globalScope.OffscreenCanvas = originalOffscreenCanvas;
      } else {
        delete (globalScope as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
      }
    }
  }

  /** Drain pending analysis batch. Called from rAF or setTimeout fallback. */
  private drainAnalysis(): void {
    if (this.analysisTimer !== null) {
      clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
    }
    if (this.pendingAnalysis.length === 0) return;
    const batch = this.pendingAnalysis.join("");
    this.pendingAnalysis = [];
    const clean = stripAnsi(batch);
    this.messageFilter?.detect(clean);
    this.detectStatus(clean);
    this.detectUserPromptTurns(batch);
    this.detectOrchestrationActivity(batch);
  }

  /** Flush and discard any queued analysis (used on PTY restart). */
  private flushPendingAnalysis(): void {
    if (this.analysisRaf !== null) {
      cancelAnimationFrame(this.analysisRaf);
      this.analysisRaf = null;
    }
    if (this.analysisTimer !== null) {
      clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
    }
    this.pendingAnalysis = [];
  }

  /** Pure arithmetic check: would the given container dimensions produce
   *  different terminal cols/rows? Uses cached cell dimensions so this
   *  involves zero DOM reads and can run in the ResizeObserver callback
   *  without triggering layout. Returns true when cell cache is empty
   *  (first resize) to ensure the initial fit always runs. */
  private wouldChangeCellGrid(containerWidth: number, containerHeight: number): boolean {
    if (!this.terminal || this.cachedCellWidth === 0 || this.cachedCellHeight === 0) return true;
    const newCols = Math.max(2, Math.floor(containerWidth / this.cachedCellWidth));
    const newRows = Math.max(1, Math.floor(containerHeight / this.cachedCellHeight));
    return newCols !== this.terminal.cols || newRows !== this.terminal.rows;
  }

  /** Update the cached cell dimensions from xterm's render service.
   *  Called after fit() and on font load — NOT on every resize check. */
  private updateCellCache(): void {
    const core = (this.terminal as Terminal & {
      _core?: {
        _renderService?: {
          dimensions?: { css?: { cell?: { width?: number; height?: number } } };
        };
      };
    })._core;
    const dims = core?._renderService?.dimensions?.css?.cell;
    if (dims?.width && dims?.height) {
      this.cachedCellWidth = dims.width;
      this.cachedCellHeight = dims.height;
    }
  }

  /** Schedule a resize via requestAnimationFrame. rAF runs at the start
   *  of the next frame after all pending layout is committed, naturally
   *  coalescing multiple triggers from the same layout pass. In a 2x2
   *  layout, if 4 ResizeObserver callbacks fire in one frame, only one
   *  rAF callback runs. */
  private scheduleResize(): void {
    if (this.resizeRafId !== null) return; // already scheduled
    this.resizeRafId = requestAnimationFrame(() => {
      this.resizeRafId = null;
      this.applyResize();
    });
  }

  /** Apply a resize: fit the terminal to its container and send PTY resize.
   *  Only called when wouldChangeCellGrid() returned true or from font/
   *  visibility handlers that bypass the cell-grid gate. */
  private applyResize(): void {
    if (!this.terminal || !this.fitAddon) return;

    // Re-entrancy guard: after a real dimension change, the TUI needs
    // time to process SIGWINCH and redraw (up to 150ms for complex TUI
    // layouts). If we resize again during that window, fit() invalidates
    // the render model while the TUI is mid-paint.
    if (this.resizeInFlight) {
      this.scheduleResize();
      return;
    }

    const el = this.terminal.element?.parentElement;
    if (el && (el.clientWidth === 0 || el.clientHeight === 0)) return;

    // Final gate: proposeDimensions accounts for padding and scrollbar
    // width that our fast-path wouldChangeCellGrid does not.
    const proposed = this.fitAddon.proposeDimensions();
    if (proposed &&
        proposed.cols === this.terminal.cols &&
        proposed.rows === this.terminal.rows) {
      this.terminal.element?.style.removeProperty("height");
      return;
    }

    try {
      const oldCols = this.terminal.cols;
      const oldRows = this.terminal.rows;

      this.fitAddon.fit();
      this.terminal.element?.style.removeProperty("height");

      const { rows, cols } = this.terminal;

      if (rows > 0 && cols > 0 &&
          (rows !== this.lastPtyRows || cols !== this.lastPtyCols)) {
        this.lastPtyRows = rows;
        this.lastPtyCols = cols;
        this.ptyBridge?.resize(rows, cols);
      }

      // Update cell cache after fit — cell dimensions may have changed
      // if the renderer recalculated metrics.
      this.updateCellCache();

      // If dimensions actually changed, block subsequent resizes for 150ms
      // so the TUI can finish its SIGWINCH redraw.
      if (this.terminal.cols !== oldCols || this.terminal.rows !== oldRows) {
        this.resizeInFlight = true;
        if (this.resizeFlightTimer) clearTimeout(this.resizeFlightTimer);
        this.resizeFlightTimer = setTimeout(() => {
          this.resizeInFlight = false;
          this.resizeFlightTimer = null;
        }, 150);
      }
    } catch {
      // Ignore resize errors during teardown.
    }
  }

  private registerTerminalMetricObservers(): void {
    // Window resize: debounce separately since it fires rapidly during
    // window drag. The cell-grid gate isn't needed here — window resize
    // always changes all container dimensions.
    this.registerDomEvent(window, "resize", () => {
      if (this.windowResizeTimer !== null) clearTimeout(this.windowResizeTimer);
      this.windowResizeTimer = setTimeout(() => {
        this.windowResizeTimer = null;
        this.updateCellCache();
        this.scheduleResize();
      }, 100);
    });

    // Visibility change: only resize if we were hidden (dimensions may
    // have changed while hidden and ResizeObserver doesn't fire then).
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) {
        this.scheduleResize();
      }
    });

    // Font load: re-measure cell dimensions and resize.
    const fontSet = document.fonts;
    if (!fontSet) return;

    const onFontChange = () => {
      this.updateCellCache();
      this.scheduleResize();
    };
    void fontSet.ready.then(onFontChange);

    if ("addEventListener" in fontSet) {
      fontSet.addEventListener("loadingdone", onFontChange);
      fontSet.addEventListener("loadingerror", onFontChange);
      this.register(() => {
        fontSet.removeEventListener("loadingdone", onFontChange);
        fontSet.removeEventListener("loadingerror", onFontChange);
      });
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

  private getTerminalFontFamily(): string {
    const themeMono = getComputedStyle(document.body).getPropertyValue("--font-monospace").trim();
    return themeMono || "'SF Mono', 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', monospace";
  }

  async onClose(): Promise<void> {
    if (this.statusDebounceTimer !== null) {
      clearTimeout(this.statusDebounceTimer);
      this.statusDebounceTimer = null;
    }
    if (this.resizeRafId !== null) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = null;
    }
    if (this.windowResizeTimer !== null) {
      clearTimeout(this.windowResizeTimer);
      this.windowResizeTimer = null;
    }
    if (this.resizeFlightTimer !== null) {
      clearTimeout(this.resizeFlightTimer);
      this.resizeFlightTimer = null;
    }
    this.flushPendingAnalysis();

    this.resizeObserver?.disconnect();
    this.messageFilter?.destroy();
    this.messageFilter = null;
    this.ptyBridge?.kill();
    this.canvasAddon?.dispose();
    this.canvasAddon = null;
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.ptyBridge = null;
    this.resizeObserver = null;
  }
}
