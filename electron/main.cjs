const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const net = require("net");

app.name = "Augment";

let mainWindow = null;
let nextSessionId = 1;
const sessions = new Map();

// Maps tmux shim pane names to Augment session IDs
const shimPaneMap = new Map(); // name → sessionId

function getPtyScriptPath() {
  return path.resolve(__dirname, "..", "scripts", "terminal_pty.py");
}

function getShimBinPath() {
  return path.resolve(__dirname, "..", "scripts", "shim-bin");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "Augment",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
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

  // Build the PTY environment with tmux shim.
  // Instead of stripping $TMUX (which makes CC run agents in-process and
  // invisible), we set a fake $TMUX so CC uses its tmux backend — but our
  // shim binary intercepts the tmux commands and redirects agent spawns
  // into Augment terminal sessions.
  const ptyEnv = { ...process.env };
  const shimBin = getShimBinPath();
  ptyEnv.PATH = shimBin + ":" + (ptyEnv.PATH || "");
  ptyEnv.TMUX = "/tmp/augment-shim,0,0";
  ptyEnv.TMUX_PANE = "%0";
  ptyEnv.AUGMENT_SOCKET = getSocketPath();
  ptyEnv.TERM = "xterm-256color";
  ptyEnv.LANG = ptyEnv.LANG || "en_US.UTF-8";

  // Support custom commands (e.g., claude --resume <sessionId>)
  // Passed as extra args to the PTY bridge script
  const cmd = options.cmd || [];
  const spawnArgs = [ptyScript, ...cmd];

  const child = spawn("python3", spawnArgs, {
    cwd,
    env: ptyEnv,
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

// ============================================================
// History persistence
// ============================================================

const fs = require("fs");
const os = require("os");

const HISTORY_DIR = path.join(os.homedir(), ".augment", "history");

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

ipcMain.handle("history:save", (_event, entries) => {
  ensureHistoryDir();
  const filePath = path.join(HISTORY_DIR, "sessions.json");
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  return true;
});

ipcMain.handle("history:load", () => {
  const filePath = path.join(HISTORY_DIR, "sessions.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
});

// Read CC session metadata from ~/.claude/projects/
ipcMain.handle("history:scanCCSessions", (_event, projectPath) => {
  try {
    // Compute path hash: /foo/bar → -foo-bar
    const pathHash = projectPath.replace(/\//g, "-");
    const projectDir = path.join(os.homedir(), ".claude", "projects", pathHash);

    if (!fs.existsSync(projectDir)) return [];

    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    const results = [];

    for (const file of files.slice(-50)) {
      // Read only the first line for metadata
      const filePath = path.join(projectDir, file);
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);

      const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
      try {
        const meta = JSON.parse(firstLine);
        results.push({
          sessionId: meta.sessionId,
          timestamp: meta.timestamp,
          agentName: meta.agentName || null,
          teamName: meta.teamName || null,
          cwd: meta.cwd || projectPath,
          file: file,
        });
      } catch {
        // Skip malformed files
      }
    }

    // Sort by timestamp descending
    results.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    return results;
  } catch {
    return [];
  }
});

// Read display text from ~/.claude/history.jsonl
ipcMain.handle("history:getCCHistory", () => {
  try {
    const historyPath = path.join(os.homedir(), ".claude", "history.jsonl");
    if (!fs.existsSync(historyPath)) return {};

    const content = fs.readFileSync(historyPath, "utf-8");
    const lines = content.trim().split("\n");
    const map = {};

    // Build sessionId → display text map (last 200 entries)
    for (const line of lines.slice(-200)) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.display) {
          map[entry.sessionId] = entry.display;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return map;
  } catch {
    return {};
  }
});

// ============================================================
// Tmux shim socket server
// ============================================================
// Listens on a Unix domain socket for commands from the tmux shim.
// The shim intercepts CC's tmux calls and forwards them here so
// we can create real Augment sessions for each agent.

const AUGMENT_DIR = path.join(os.homedir(), ".augment");

function getSocketPath() {
  return path.join(AUGMENT_DIR, "augment.sock");
}

let shimServer = null;

function startShimServer() {
  const socketPath = getSocketPath();

  // Ensure directory exists
  if (!fs.existsSync(AUGMENT_DIR)) {
    fs.mkdirSync(AUGMENT_DIR, { recursive: true });
  }

  // Remove stale socket file
  try { fs.unlinkSync(socketPath); } catch { /* ignore */ }

  shimServer = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (data) => {
      buf += data.toString();
      // Process complete lines (newline-delimited JSON)
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleShimMessage(conn, line);
      }
      // Also try to parse if there's a complete JSON without newline
      // (socat may close without trailing newline)
      if (buf.length > 0) {
        try {
          JSON.parse(buf);
          handleShimMessage(conn, buf);
          buf = "";
        } catch { /* incomplete, wait for more data */ }
      }
    });
    conn.on("end", () => {
      // Try to parse any remaining data
      if (buf.length > 0) {
        try {
          handleShimMessage(conn, buf);
        } catch { /* ignore */ }
      }
    });
    conn.on("error", () => { /* ignore connection errors */ });
  });

  shimServer.listen(socketPath, () => {
    // Socket server ready
  });

  shimServer.on("error", (err) => {
    console.error("Shim server error:", err);
  });
}

function handleShimMessage(conn, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    conn.end('{"error":"invalid json"}\n');
    return;
  }

  switch (msg.type) {
    case "spawn": {
      // CC wants to create a new agent pane
      // msg.name = agent name, msg.cmd = full shell command
      const name = msg.name || "agent";
      const cmdStr = msg.cmd || "";

      // Parse the command string to extract the actual command
      // CC typically sends: bash -c "claude --agent-id ..."
      // or: claude --resume <id>
      let cmdArgs = [];
      if (cmdStr) {
        // Use shell to handle quoting
        cmdArgs = ["bash", "-c", cmdStr];
      }

      const session = createSession({ cmd: cmdArgs });

      // Map the pane name to the session ID
      shimPaneMap.set(name, session.id);

      // Notify renderer about the new agent session
      sendToRenderer("shim:agent-spawned", {
        id: session.id,
        name: name,
        cmd: cmdStr,
      });

      conn.end(`{"ok":true,"id":${session.id},"pane":"%${session.id}"}\n`);
      break;
    }

    case "send-keys": {
      // CC wants to send input to an agent pane
      const target = msg.target || "";
      const keys = msg.keys || "";

      // Find session by pane name or pane ID
      let sessionId = null;
      if (target.startsWith("%")) {
        sessionId = parseInt(target.slice(1), 10);
      } else {
        sessionId = shimPaneMap.get(target) || null;
      }

      if (sessionId !== null) {
        const session = sessions.get(sessionId);
        if (session && session.process?.stdin) {
          session.process.stdin.write(keys);
        }
      }

      conn.end('{"ok":true}\n');
      break;
    }

    case "rename": {
      // CC wants to rename a pane
      const title = msg.title || "";
      const target = msg.target || "";

      sendToRenderer("shim:agent-renamed", {
        target: target,
        title: title,
      });

      conn.end('{"ok":true}\n');
      break;
    }

    case "list-panes": {
      // Return all active agent panes
      const panes = [];
      for (const [name, id] of shimPaneMap.entries()) {
        if (sessions.has(id)) {
          panes.push(`%${id} ${name}`);
        }
      }
      if (panes.length === 0) {
        panes.push("%0 augment");
      }
      conn.end(panes.join("\n") + "\n");
      break;
    }

    case "kill": {
      const target = msg.target || "";
      let sessionId = null;
      if (target.startsWith("%")) {
        sessionId = parseInt(target.slice(1), 10);
      } else {
        sessionId = shimPaneMap.get(target) || null;
      }
      if (sessionId !== null) {
        killSession(sessionId);
      }
      conn.end('{"ok":true}\n');
      break;
    }

    default:
      conn.end('{"ok":true}\n');
      break;
  }
}

function stopShimServer() {
  if (shimServer) {
    shimServer.close();
    shimServer = null;
  }
  try { fs.unlinkSync(getSocketPath()); } catch { /* ignore */ }
}

// ============================================================
// Universal session discovery
// ============================================================
// Discovers CC sessions running outside Augment via:
// 1. Process table polling (every 10s) — finds CC processes with PIDs, args
// 2. fs.watch on ~/.claude/teams/ — reads team config files for member rosters

const { execFile } = require("child_process");

const TEAMS_DIR = path.join(os.homedir(), ".claude", "teams");
const DISCOVERY_POLL_MS = 10_000;

let discoveryTimer = null;
let teamWatchers = new Map(); // team dir path → FSWatcher
let lastDiscovery = []; // cache to diff against

function parseProcessArgs(args) {
  const result = {};
  const tokens = args.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--agent-name" && tokens[i + 1]) {
      result.agentName = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--team-name" && tokens[i + 1]) {
      result.teamName = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--agent-color" && tokens[i + 1]) {
      result.agentColor = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--agent-id" && tokens[i + 1]) {
      result.agentId = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--parent-session-id" && tokens[i + 1]) {
      result.parentSessionId = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--resume" && tokens[i + 1]) {
      result.resumeSessionId = tokens[i + 1];
      i++;
    }
  }
  return result;
}

function scanProcessTable() {
  return new Promise((resolve) => {
    // ps output: PID, STAT, COMMAND (full args)
    execFile("ps", ["-eo", "pid,stat,args"], { maxBuffer: 1024 * 512 }, (err, stdout) => {
      if (err) { resolve([]); return; }

      const results = [];
      const lines = stdout.split("\n");

      for (const line of lines) {
        // Match lines containing claude binary or "claude" command
        if (!line.includes("claude") && !line.includes(".local/share/claude/versions/")) continue;
        // Skip grep/ps itself
        if (line.includes("ps -eo") || line.includes("grep")) continue;

        const trimmed = line.trim();
        const pidMatch = trimmed.match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!pidMatch) continue;

        const pid = parseInt(pidMatch[1], 10);
        const stat = pidMatch[2];
        const args = pidMatch[3];

        // Skip chrome native host processes
        if (args.includes("--chrome-native-host")) continue;

        const parsed = parseProcessArgs(args);

        // Determine running status from process stat
        // R = running, S = sleeping (idle), T = stopped
        const isRunning = stat.startsWith("R");

        results.push({
          pid,
          stat,
          isRunning,
          agentName: parsed.agentName || null,
          teamName: parsed.teamName || null,
          agentColor: parsed.agentColor || null,
          agentId: parsed.agentId || null,
          parentSessionId: parsed.parentSessionId || null,
          resumeSessionId: parsed.resumeSessionId || null,
          // Determine display name
          displayName: parsed.agentName || (args.includes("claude ") ? args.split("claude ").pop().split(" ")[0] : "claude"),
          cmdLine: args,
        });
      }

      resolve(results);
    });
  });
}

function readTeamConfigs() {
  const teams = [];
  try {
    if (!fs.existsSync(TEAMS_DIR)) return teams;
    const dirs = fs.readdirSync(TEAMS_DIR);
    for (const dir of dirs) {
      const configPath = path.join(TEAMS_DIR, dir, "config.json");
      if (!fs.existsSync(configPath)) continue;
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        teams.push({
          name: config.name || dir,
          leadSessionId: config.leadSessionId || null,
          members: (config.members || []).map((m) => ({
            name: m.name,
            agentId: m.agentId || null,
            agentType: m.agentType || null,
            color: m.color || null,
            isActive: m.isActive ?? false,
            cwd: m.cwd || null,
          })),
        });
      } catch { /* skip malformed configs */ }
    }
  } catch { /* ignore */ }
  return teams;
}

async function runDiscoveryCycle() {
  const [processes, teams] = await Promise.all([
    scanProcessTable(),
    Promise.resolve(readTeamConfigs()),
  ]);

  // Build a unified snapshot
  const snapshot = { processes, teams, timestamp: Date.now() };

  // Only send to renderer if something changed (compare serialized)
  const serialized = JSON.stringify(snapshot);
  const lastSerialized = JSON.stringify(lastDiscovery);
  if (serialized !== lastSerialized) {
    lastDiscovery = snapshot;
    sendToRenderer("discovery:update", snapshot);
  }
}

function startDiscovery() {
  // Initial scan
  void runDiscoveryCycle();

  // Poll process table every 10s
  discoveryTimer = setInterval(() => {
    void runDiscoveryCycle();
  }, DISCOVERY_POLL_MS);

  // Watch team config directory for changes
  try {
    if (fs.existsSync(TEAMS_DIR)) {
      watchTeamsDir();
    }
  } catch { /* ignore */ }
}

function watchTeamsDir() {
  try {
    const watcher = fs.watch(TEAMS_DIR, { recursive: true }, (eventType, filename) => {
      if (filename && filename.endsWith("config.json")) {
        // Team config changed — run discovery immediately
        void runDiscoveryCycle();
      }
    });
    watcher.on("error", () => { /* ignore */ });
    teamWatchers.set(TEAMS_DIR, watcher);
  } catch { /* ignore */ }
}

function stopDiscovery() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  for (const watcher of teamWatchers.values()) {
    try { watcher.close(); } catch { /* ignore */ }
  }
  teamWatchers.clear();
}

// IPC: renderer can request an immediate discovery scan
ipcMain.handle("discovery:scan", async () => {
  await runDiscoveryCycle();
  return lastDiscovery;
});

// IPC: resolve a CC session ID for resuming a discovered process
// Searches ~/.claude/projects/ for a session file matching the given criteria
ipcMain.handle("discovery:resolveSession", (_event, { parentSessionId, agentName, pid }) => {
  try {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return null;

    // If we have a parentSessionId, look in the subagents directory
    if (parentSessionId && agentName) {
      const projectDirs = fs.readdirSync(projectsDir);
      for (const pDir of projectDirs) {
        const subagentsDir = path.join(projectsDir, pDir, parentSessionId, "subagents");
        if (!fs.existsSync(subagentsDir)) continue;

        const files = fs.readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = path.join(subagentsDir, file);
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(4096);
          const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);

          const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
          try {
            const meta = JSON.parse(firstLine);
            if (meta.sessionId) {
              return { sessionId: meta.sessionId, cwd: meta.cwd || null };
            }
          } catch { /* skip */ }
        }
      }
    }

    // For standalone processes, scan recent session files
    if (!agentName) {
      const projectDirs = fs.readdirSync(projectsDir);
      for (const pDir of projectDirs) {
        const dir = path.join(projectsDir, pDir);
        let stat;
        try { stat = fs.statSync(dir); } catch { continue; }
        if (!stat.isDirectory()) continue;

        const files = fs.readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl") && !f.includes("subagent"))
          .sort()
          .slice(-10); // check last 10 sessions

        for (const file of files) {
          const filePath = path.join(dir, file);
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(4096);
          const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);

          const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
          try {
            const meta = JSON.parse(firstLine);
            if (meta.sessionId && meta.pid === pid) {
              return { sessionId: meta.sessionId, cwd: meta.cwd || null };
            }
          } catch { /* skip */ }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
});

// IPC: read a session transcript from JSONL for display
// Finds the session file by PID, then extracts human-readable conversation
ipcMain.handle("transcript:read", (_event, pid) => {
  try {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return null;

    // Scan all project dirs for a session with matching PID
    const projectDirs = fs.readdirSync(projectsDir);
    for (const pDir of projectDirs) {
      const dir = path.join(projectsDir, pDir);
      let stat;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, 30);

      for (const file of files) {
        const filePath = path.join(dir, file);
        let content;
        try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }

        const lines = content.trim().split("\n");
        if (lines.length === 0) continue;

        // Check first line for PID match or session identity
        let meta;
        try { meta = JSON.parse(lines[0]); } catch { continue; }

        // Match by PID if provided, or just grab recent sessions
        if (pid && meta.pid !== pid) continue;

        // Extract conversation turns into readable text
        const parts = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "human" && entry.message?.content) {
              const text = typeof entry.message.content === "string"
                ? entry.message.content
                : entry.message.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n");
              if (text.trim()) parts.push(`\x1b[36m❯ ${text.trim()}\x1b[0m`);
            } else if (entry.type === "assistant" && entry.message?.content) {
              const text = typeof entry.message.content === "string"
                ? entry.message.content
                : entry.message.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n");
              if (text.trim()) parts.push(text.trim());
            }
          } catch { /* skip malformed lines */ }
        }

        if (parts.length > 0) {
          return parts.join("\r\n\r\n");
        }
      }
    }

    return null;
  } catch {
    return null;
  }
});

app.whenReady().then(() => {
  startShimServer();
  startDiscovery();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  killAllSessions();
  stopShimServer();
  stopDiscovery();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  killAllSessions();
  stopShimServer();
  stopDiscovery();
});
