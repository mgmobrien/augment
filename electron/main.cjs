const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");

let mainWindow = null;
let nextSessionId = 1;
const sessions = new Map();

function getPtyScriptPath() {
  return path.resolve(__dirname, "..", "scripts", "terminal_pty.py");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function killSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  if (session.process && !session.process.killed) {
    session.process.kill("SIGTERM");
  }
  sessions.delete(id);
}

function killAllSessions() {
  for (const id of sessions.keys()) {
    killSession(id);
  }
}

function createSession(options = {}) {
  const id = nextSessionId++;
  const cwd = options.cwd || app.getPath("home");
  const ptyScript = getPtyScriptPath();

  const child = spawn("python3", [ptyScript], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  const control = child.stdio[3];

  sessions.set(id, {
    id,
    cwd,
    process: child,
    control,
  });

  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (data) => {
    sendToRenderer("terminal:data", { id, data });
  });

  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (data) => {
    sendToRenderer("terminal:stderr", { id, data });
  });

  child.on("exit", (code) => {
    sessions.delete(id);
    sendToRenderer("terminal:exit", { id, code: code ?? 0 });
  });

  child.on("error", (error) => {
    sessions.delete(id);
    sendToRenderer("terminal:error", { id, error: String(error) });
  });

  return { id, cwd };
}

ipcMain.handle("terminal:create", (_event, options) => {
  return createSession(options || {});
});

ipcMain.on("terminal:write", (_event, payload) => {
  const session = sessions.get(payload?.id);
  if (!session || !session.process?.stdin) return;
  session.process.stdin.write(payload.data ?? "");
});

ipcMain.on("terminal:resize", (_event, payload) => {
  const session = sessions.get(payload?.id);
  if (!session || !session.control) return;
  const rows = Number(payload.rows || 24);
  const cols = Number(payload.cols || 80);
  session.control.write(`R${rows},${cols}\n`);
});

ipcMain.on("terminal:kill", (_event, payload) => {
  if (!payload || typeof payload.id !== "number") return;
  killSession(payload.id);
});

ipcMain.handle("terminal:list", () => {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    cwd: s.cwd,
  }));
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  killAllSessions();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  killAllSessions();
});
