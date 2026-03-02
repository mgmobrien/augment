import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
// @ts-ignore
import xtermCssText from "@xterm/xterm/css/xterm.css";

type TerminalCreated = {
  id: number;
  cwd: string;
};

type TerminalData = {
  id: number;
  data: string;
};

type TerminalExit = {
  id: number;
  code: number;
};

type SessionView = {
  id: number;
  name: string;
  tabEl: HTMLButtonElement;
  paneEl: HTMLDivElement;
  terminal: Terminal;
  fit: FitAddon;
  resizeObserver: ResizeObserver;
  closed: boolean;
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

const sessions = new Map<number, SessionView>();
let activeId: number | null = null;
let sessionCounter = 0;

const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const panesEl = document.getElementById("panes") as HTMLDivElement;
const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;

const xtermStyleEl = document.createElement("style");
xtermStyleEl.textContent = xtermCssText;
document.head.appendChild(xtermStyleEl);

function makeName(): string {
  sessionCounter += 1;
  return `term-${sessionCounter}`;
}

function setActive(id: number): void {
  activeId = id;
  for (const session of sessions.values()) {
    const isActive = session.id === id;
    session.tabEl.classList.toggle("is-active", isActive);
    session.paneEl.classList.toggle("is-active", isActive);
  }

  const active = sessions.get(id);
  if (active) {
    setTimeout(() => {
      active.fit.fit();
      const dims = active.fit.proposeDimensions();
      if (dims) {
        window.augmentApp.resize(active.id, dims.rows, dims.cols);
      }
      active.terminal.focus();
    }, 0);
  }
}

function disposeSession(id: number): void {
  const session = sessions.get(id);
  if (!session) return;

  session.closed = true;
  session.resizeObserver.disconnect();
  session.terminal.dispose();
  session.tabEl.remove();
  session.paneEl.remove();
  sessions.delete(id);

  if (activeId === id) {
    const remaining = Array.from(sessions.keys());
    activeId = null;
    if (remaining.length > 0) {
      setActive(remaining[0]);
    }
  }
}

function markExited(id: number, code: number): void {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  session.tabEl.dataset.exited = "true";
  session.tabEl.title = `Exited (${code})`;
  session.terminal.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`);
}

function createSessionView(created: TerminalCreated): SessionView {
  const name = makeName();

  const tabEl = document.createElement("button");
  tabEl.type = "button";
  tabEl.className = "tab";
  tabEl.textContent = name;
  tabEl.addEventListener("click", () => {
    setActive(created.id);
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close terminal";
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    window.augmentApp.kill(created.id);
    disposeSession(created.id);
  });
  tabEl.appendChild(closeBtn);

  const paneEl = document.createElement("div");
  paneEl.className = "pane";
  const terminalRoot = document.createElement("div");
  terminalRoot.className = "terminal-root";
  paneEl.appendChild(terminalRoot);

  tabsEl.appendChild(tabEl);
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
    tabEl,
    paneEl,
    terminal,
    fit,
    resizeObserver,
    closed: false,
  };
}

async function spawnTerminal(): Promise<void> {
  const created = await window.augmentApp.createTerminal();
  const session = createSessionView(created);
  sessions.set(created.id, session);
  setActive(created.id);
}

window.augmentApp.onData((payload) => {
  const session = sessions.get(payload.id);
  if (!session || session.closed) return;
  session.terminal.write(payload.data);
});

window.augmentApp.onStderr((payload) => {
  const session = sessions.get(payload.id);
  if (!session || session.closed) return;
  session.terminal.write(`\x1b[31m${payload.data}\x1b[0m`);
});

window.augmentApp.onExit((payload) => {
  markExited(payload.id, payload.code);
});

window.augmentApp.onError((payload) => {
  const session = sessions.get(payload.id);
  if (!session || session.closed) return;
  session.terminal.write(`\r\n\x1b[31m[Error] ${payload.error}\x1b[0m\r\n`);
});

newTabBtn.addEventListener("click", () => {
  void spawnTerminal();
});

void spawnTerminal();
