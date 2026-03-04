const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("augmentApp", {
  createTerminal: (options = {}) => ipcRenderer.invoke("terminal:create", options),
  listTerminals: () => ipcRenderer.invoke("terminal:list"),
  write: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  resize: (id, rows, cols) => ipcRenderer.send("terminal:resize", { id, rows, cols }),
  kill: (id) => ipcRenderer.send("terminal:kill", { id }),
  onData: (callback) => ipcRenderer.on("terminal:data", (_event, payload) => callback(payload)),
  onStderr: (callback) => ipcRenderer.on("terminal:stderr", (_event, payload) => callback(payload)),
  onExit: (callback) => ipcRenderer.on("terminal:exit", (_event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on("terminal:error", (_event, payload) => callback(payload)),
  // History
  saveHistory: (entries) => ipcRenderer.invoke("history:save", entries),
  loadHistory: () => ipcRenderer.invoke("history:load"),
  scanCCSessions: (projectPath) => ipcRenderer.invoke("history:scanCCSessions", projectPath),
  getCCHistory: () => ipcRenderer.invoke("history:getCCHistory"),
  // Tmux shim events — agent sessions spawned by the shim
  onAgentSpawned: (callback) => ipcRenderer.on("shim:agent-spawned", (_event, payload) => callback(payload)),
  onAgentRenamed: (callback) => ipcRenderer.on("shim:agent-renamed", (_event, payload) => callback(payload)),
  // Discovery — external CC sessions
  onDiscoveryUpdate: (callback) => ipcRenderer.on("discovery:update", (_event, payload) => callback(payload)),
  requestDiscoveryScan: () => ipcRenderer.invoke("discovery:scan"),
});
