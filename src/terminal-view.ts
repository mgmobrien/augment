import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { PtyBridge } from "./pty-bridge";
// esbuild loads .css as text string via loader config
// @ts-ignore
import xtermCssText from "@xterm/xterm/css/xterm.css";

export const VIEW_TYPE_TERMINAL = "augment-terminal";

type TerminalStatus = "idle" | "active" | "tool" | "exited" | "shell";

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

// Strip ANSI escape sequences for pattern matching
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
            .replace(/\x1b\][^\x07]*\x07/g, "")
            .replace(/\x1b[()][0-9A-B]/g, "");
}

// Tool invocation patterns in Claude Code output
const TOOL_PATTERN = /\b(?:Bash|Read|Edit|Write|Glob|Grep|WebFetch|WebSearch|NotebookEdit|Task)\s*\(/;

export class TerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private ptyBridge: PtyBridge | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pluginDir: string;
  private terminalName: string;
  private isExited: boolean = false;
  private status: TerminalStatus = "shell";
  private statusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStatus: TerminalStatus | null = null;

  constructor(leaf: WorkspaceLeaf, pluginDir: string) {
    super(leaf);
    this.pluginDir = pluginDir;
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

  setName(name: string): void {
    this.terminalName = name;
    (this.leaf as any).updateHeader();
    this.app.workspace.trigger("augment-terminal:changed");
  }

  async onOpen(): Promise<void> {
    // Inject xterm.js CSS into document head (once)
    if (!xtermStyleEl) {
      xtermStyleEl = document.createElement("style");
      xtermStyleEl.id = "augment-xterm-css";
      xtermStyleEl.textContent = xtermCssText;
      document.head.appendChild(xtermStyleEl);
    }

    const container = this.contentEl;
    container.empty();
    container.addClass("augment-terminal-container");

    // Set initial tab status
    this.setStatus("shell");

    // Create terminal
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

    // Mount terminal
    const termDiv = container.createDiv({ cls: "augment-terminal-xterm" });
    this.terminal.open(termDiv);

    // Start PTY
    const vaultPath = (this.app.vault.adapter as any).basePath || ".";
    this.ptyBridge = new PtyBridge(
      this.pluginDir,
      vaultPath,
      (data) => {
        this.terminal?.write(data);
        this.detectStatus(data);
      },
      (code) => {
        this.terminal?.write(`\r\n[Process exited with code ${code}]\r\n`);
        this.isExited = true;
        this.setStatus("exited");
        this.app.workspace.trigger("augment-terminal:changed");
      }
    );
    this.ptyBridge.start();

    // Terminal input → PTY
    this.terminal.onData((data) => {
      this.ptyBridge?.write(data);
    });

    // Handle resize — the ResizeObserver fires once the container has
    // its final dimensions, which also handles the initial fit.
    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(container);
  }

  private detectStatus(rawData: string): void {
    if (this.isExited) return;

    const clean = stripAnsi(rawData);

    let detected: TerminalStatus | null = null;

    // Check for tool invocations first (most specific)
    if (TOOL_PATTERN.test(clean)) {
      detected = "tool";
    }
    // Check for Claude Code thinking/output marker
    else if (clean.includes("\u23FA")) { // ⏺
      detected = "active";
    }
    // Check for Claude Code idle prompt
    else if (/❯\s*$/.test(clean) || />\s*$/.test(clean) && clean.includes("claude")) {
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
    this.status = newStatus;
    this.contentEl.closest(".workspace-leaf")?.setAttribute("data-augment-status", newStatus);
    (this.leaf as any).updateHeader();
    this.app.workspace.trigger("augment-terminal:changed");
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
      // Ignore resize errors during teardown
    }
  }

  private getTheme(): any {
    // Use Obsidian's CSS variables for theme integration
    const style = getComputedStyle(document.body);
    const isDark = document.body.classList.contains("theme-dark");

    return {
      background: style.getPropertyValue("--background-primary").trim() || (isDark ? "#1e1e1e" : "#ffffff"),
      foreground: style.getPropertyValue("--text-normal").trim() || (isDark ? "#d4d4d4" : "#1e1e1e"),
      cursor: style.getPropertyValue("--text-accent").trim() || "#528bff",
      cursorAccent: style.getPropertyValue("--background-primary").trim() || (isDark ? "#1e1e1e" : "#ffffff"),
      selectionBackground: style.getPropertyValue("--text-selection").trim() || "rgba(82, 139, 255, 0.3)",
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
