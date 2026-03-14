#!/usr/bin/env node

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const INTERNAL_SERVER_MODE = "__serve";
const VAULT_ROOT =
  process.env.MATT_STACK_VAULT_ROOT || "/Users/mattobrien/Obsidian Main Vault/ObsidianVault";
const CLAIM_HELPER =
  process.env.AUGMENT_SLOT_OWNER_CLAIM_HELPER || path.join(SCRIPT_DIR, "claim-shared-slot.sh");
const SLOT_HARNESS =
  process.env.AUGMENT_SLOT_OWNER_HARNESS || path.join(VAULT_ROOT, "claude", "hooks", "obsidian-slot.sh");
const RUNTIME_OWNER_DIR =
  process.env.AUGMENT_RUNTIME_OWNER_DIR || path.join(os.tmpdir(), "augment-runtime-owner");
const BOOTSTRAP_LOCK_PATH = path.join(RUNTIME_OWNER_DIR, "bootstrap.lock");
const OWNER_METADATA_PATH = path.join(RUNTIME_OWNER_DIR, "owner.json");
const OWNER_SOCKET_PATH = path.join(RUNTIME_OWNER_DIR, "owner.sock");
const LOCK_TIMEOUT_MS = parseInteger(process.env.AUGMENT_SLOT_OWNER_LOCK_TIMEOUT_MS, 10000);
const LOCK_POLL_MS = parseInteger(process.env.AUGMENT_SLOT_OWNER_LOCK_POLL_MS, 50);
const OWNER_READY_TIMEOUT_MS = parseInteger(process.env.AUGMENT_RUNTIME_OWNER_READY_TIMEOUT_MS, 5000);
const OWNER_CONNECT_TIMEOUT_MS = parseInteger(process.env.AUGMENT_RUNTIME_OWNER_CONNECT_TIMEOUT_MS, 1500);
const OWNER_CLAIM_RECOVERY_TIMEOUT_MS = parseInteger(
  process.env.AUGMENT_RUNTIME_OWNER_CLAIM_RECOVERY_TIMEOUT_MS,
  5000
);
const OWNER_IDLE_TIMEOUT_MS = parseInteger(process.env.AUGMENT_RUNTIME_OWNER_IDLE_TIMEOUT_MS, 30000);
const CONTROL_CENTER_HOST = "127.0.0.1";
const CONTROL_CENTER_POLL_MS = parseInteger(process.env.AUGMENT_CONTROL_CENTER_POLL_MS, 3000);
const EXTERNAL_WAKE_STATE_DIR =
  process.env.LAREDO_BUS_AUGMENT_STATUS_DIR?.trim() ||
  (process.platform === "win32"
    ? path.join(os.tmpdir(), "laredo-bus", "augment-terminal-status")
    : "/tmp/laredo-bus/augment-terminal-status");
const VALID_METHODS = new Set(["claimSlot", "statusSlot", "stopSlot"]);
const VALID_LEASE_STATES = new Set(["empty", "prepared", "running", "stopped", "stale"]);
const VALID_TERMINAL_STATUSES = new Set(["idle", "active", "tool", "waiting", "exited", "shell", "running", "crashed"]);
const CC_NATIVE_TEAM_ID_PREFIX = "cc-native-team::";

function parseInteger(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function usage() {
  console.error(`Usage:
  node scripts/slot-owner-adapter.mjs claimSlot --slot <sNN> --caller <id> [--request-id <id>] [--fixture <abs-dir>] [--obsidian-version <ver>] [--json]
  node scripts/slot-owner-adapter.mjs statusSlot --slot <sNN> --caller <id> [--request-id <id>] [--json]
  node scripts/slot-owner-adapter.mjs stopSlot --slot <sNN> --caller <id> [--request-id <id>] [--json]`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeSlotId(rawValue) {
  const value = String(rawValue || "").trim();
  if (/^s\d{2}$/i.test(value)) {
    const slotNumber = Number(value.slice(1));
    if (slotNumber >= 1 && slotNumber <= 26) {
      return `s${String(slotNumber).padStart(2, "0")}`;
    }
  }

  if (/^\d+$/.test(value)) {
    const slotNumber = Number(value);
    if (slotNumber >= 1 && slotNumber <= 26) {
      return `s${String(slotNumber).padStart(2, "0")}`;
    }
  }

  throw new Error(`Invalid slot id '${value}' (expected s01-s26 or 1-26)`);
}

function buildRequestId(method, slotId) {
  return `auto-${method}-${slotId}-${process.pid}-${Date.now()}`;
}

function normalizeRequest(input, source = "request") {
  const method = String(input.method || "").trim();
  if (!VALID_METHODS.has(method)) {
    throw new Error(`Unknown method '${method}'`);
  }

  const slotId = normalizeSlotId(input.slotId ?? input.slot_id ?? "");
  const caller = String(input.caller || "").trim();
  if (!caller) {
    throw new Error(`${source}: caller is required`);
  }

  const fixturePath = String(input.fixturePath ?? input.fixture_path ?? "").trim();
  if (method === "claimSlot" && fixturePath && !path.isAbsolute(fixturePath)) {
    throw new Error(`${source}: fixture path must be absolute when provided`);
  }

  return {
    method,
    slotId,
    caller,
    requestId: String(input.requestId ?? input.request_id ?? "").trim() || buildRequestId(method, slotId),
    fixturePath,
    obsidianVersion: String(input.obsidianVersion ?? input.obsidian_version ?? "").trim() || "latest",
    json: Boolean(input.json),
  };
}

function parseArgs(argv) {
  const method = argv[0] || "";
  if (!VALID_METHODS.has(method)) {
    usage();
    throw new Error(`Unknown method '${method}'`);
  }

  const options = {
    method,
    slotId: "",
    caller: "",
    requestId: "",
    fixturePath: "",
    obsidianVersion: "latest",
    json: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--slot":
        options.slotId = normalizeSlotId(argv[index + 1] || "");
        index += 1;
        break;
      case "--caller":
        options.caller = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--request-id":
        options.requestId = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--fixture":
        options.fixturePath = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--obsidian-version":
        options.obsidianVersion = String(argv[index + 1] || "").trim() || "latest";
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        usage();
        throw new Error(`Unknown option '${token}'`);
    }
  }

  if (!options.slotId) {
    throw new Error("--slot is required");
  }

  if (!options.caller) {
    throw new Error("--caller is required");
  }

  if (method === "claimSlot" && options.fixturePath && !path.isAbsolute(options.fixturePath)) {
    throw new Error("--fixture must be an absolute path when provided");
  }

  options.requestId = options.requestId || buildRequestId(method, options.slotId);
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function removeStaleLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed.pid);
    if (isPidAlive(pid)) {
      return false;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      // Treat malformed metadata as stale.
    }
  }

  await fs.rm(lockPath, { force: true });
  return true;
}

async function acquireExclusiveLock(lockPath, metadata = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
            ...metadata,
          },
          null,
          2
        ),
        {
          flag: "wx",
        }
      );

      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }

      const removed = await removeStaleLock(lockPath);
      if (removed) {
        continue;
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        return null;
      }

      await sleep(LOCK_POLL_MS);
    }
  }
}

function runJsonCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 0) !== 0) {
        resolve({
          ok: false,
          status: code ?? 1,
          stdout,
          stderr,
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          ok: false,
          status: 1,
          stdout,
          stderr: "Command returned no JSON output.",
        });
        return;
      }

      try {
        resolve({
          ok: true,
          json: JSON.parse(trimmed),
        });
      } catch (error) {
        resolve({
          ok: false,
          status: 1,
          stdout,
          stderr: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}

function parsePid(rawValue) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveLeaseState(rawState, obsidianPid) {
  if (obsidianPid !== null) {
    return "running";
  }

  if (rawState === "running" && obsidianPid === null) {
    return "stale";
  }

  if (VALID_LEASE_STATES.has(rawState)) {
    return rawState;
  }

  return "empty";
}

function mapStateAfter(record) {
  const slotId = normalizeSlotId(record.slot_id ?? record.slotId ?? "");
  const debugPort = Number(record.port ?? record.debugPort ?? 0);
  if (!Number.isFinite(debugPort)) {
    throw new Error(`Invalid debug port for slot ${slotId}`);
  }

  const obsidianPid = parsePid(record.pid ?? record.obsidianPid);
  const rawState = String(record.state ?? record.leaseState ?? "empty");

  return {
    slotId,
    leaseState: deriveLeaseState(rawState, obsidianPid),
    debugPort,
    vaultDir: String(record.vault_dir ?? record.vaultDir ?? ""),
    configDir: String(record.config_dir ?? record.configDir ?? ""),
    obsidianPid,
    observedAt: new Date().toISOString(),
  };
}

function buildResponse(method, request, outcome, stateAfter) {
  return {
    method,
    requestId: request.requestId,
    slotId: request.slotId,
    caller: request.caller,
    outcome,
    stateAfter,
  };
}

function printResponse(response, jsonOutput) {
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }

  const state = response.stateAfter;
  const lines = [
    `method=${response.method}`,
    `request_id=${response.requestId}`,
    `caller=${response.caller}`,
    `outcome=${response.outcome}`,
    `slot_id=${state.slotId}`,
    `lease_state=${state.leaseState}`,
    `debug_port=${state.debugPort}`,
    `vault_dir=${state.vaultDir}`,
    `config_dir=${state.configDir}`,
    `obsidian_pid=${state.obsidianPid ?? ""}`,
    `observed_at=${state.observedAt}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function normalizeText(rawValue) {
  const value = String(rawValue ?? "").trim();
  return value || null;
}

function normalizeTerminalStatus(rawValue) {
  const value = String(rawValue ?? "").trim();
  return VALID_TERMINAL_STATUSES.has(value) ? value : "shell";
}

function createDeliveryObservation(address = null) {
  return {
    address,
    firstDeliveryReadyAt: null,
    lastDeliveryPollAt: null,
    lastDeliveryError: null,
  };
}

function deriveRuntimeState(status) {
  switch (status) {
    case "shell":
    case "running":
      return "launching";
    case "active":
    case "tool":
      return "busy";
    case "waiting":
    case "idle":
      return "waiting";
    case "exited":
      return "exited";
    case "crashed":
      return "failed";
    default:
      return "launching";
  }
}

function deriveManagedDeliveryState(observation) {
  if (!observation) return "pending";
  if (observation.firstDeliveryReadyAt === null) return "pending";
  if (observation.lastDeliveryError) return "degraded";
  return "ready";
}

function buildManagedRoleStatus(input) {
  const observation = input.observation;

  return {
    teamId: input.teamId,
    roleId: input.roleId,
    address: observation?.address ?? input.address ?? null,
    runtime: deriveRuntimeState(input.terminalStatus),
    delivery: deriveManagedDeliveryState(observation),
    terminalStatus: input.terminalStatus,
    firstDeliveryReadyAt: observation?.firstDeliveryReadyAt ?? null,
    lastDeliveryPollAt: observation?.lastDeliveryPollAt ?? null,
    lastDeliveryError: observation?.lastDeliveryError ?? null,
  };
}

async function readManagedRoleStatuses() {
  let entries;
  try {
    entries = await fs.readdir(EXTERNAL_WAKE_STATE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const byManagedRole = new Map();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(EXTERNAL_WAKE_STATE_DIR, entry.name), "utf8"));
    } catch {
      continue;
    }

    const teamId = normalizeText(parsed.managedTeamId);
    const roleId = normalizeText(parsed.managedRoleId);
    if (!teamId || !roleId || teamId.startsWith(CC_NATIVE_TEAM_ID_PREFIX)) {
      continue;
    }

    const address = normalizeText(parsed.address) ?? normalizeText(parsed.name);
    const observation = createDeliveryObservation(address);
    const status = buildManagedRoleStatus({
      teamId,
      roleId,
      address,
      observation,
      terminalStatus: normalizeTerminalStatus(parsed.status),
    });

    const key = `${teamId}::${roleId}`;
    const updatedAtMs = Number(parsed.updatedAtMs);
    const previous = byManagedRole.get(key);
    if (!previous || updatedAtMs >= previous.updatedAtMs) {
      byManagedRole.set(key, {
        updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
        status,
      });
    }
  }

  return Array.from(byManagedRole.values())
    .map((entry) => entry.status)
    .sort((left, right) => {
      const teamCompare = left.teamId.localeCompare(right.teamId);
      if (teamCompare !== 0) return teamCompare;
      return left.roleId.localeCompare(right.roleId);
    });
}

function renderControlCenterRootHtml(rootUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Augment control center</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: #f5f1e8;
      color: #1f1b16;
    }
    body {
      margin: 0;
      padding: 24px;
      background:
        radial-gradient(circle at top left, rgba(176, 143, 88, 0.18), transparent 28rem),
        linear-gradient(180deg, #fbf8f1 0%, #efe7d8 100%);
      min-height: 100vh;
    }
    main {
      max-width: 1040px;
      margin: 0 auto;
      padding: 24px;
      border: 1px solid rgba(31, 27, 22, 0.12);
      border-radius: 18px;
      background: rgba(255, 252, 247, 0.9);
      box-shadow: 0 18px 60px rgba(79, 55, 24, 0.12);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.5rem;
    }
    p {
      margin: 0;
      line-height: 1.5;
    }
    .meta {
      margin-top: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.9rem;
      color: #5f5648;
    }
    .meta code {
      font-size: 0.9rem;
    }
    .status-shell {
      margin-top: 24px;
      overflow-x: auto;
      border-radius: 14px;
      border: 1px solid rgba(31, 27, 22, 0.12);
      background: rgba(255, 255, 255, 0.7);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 900px;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(31, 27, 22, 0.08);
      text-align: left;
      vertical-align: top;
      font-size: 0.9rem;
    }
    th {
      font-size: 0.75rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #5f5648;
      background: rgba(240, 233, 220, 0.75);
    }
    tbody tr:last-child td {
      border-bottom: 0;
    }
    .empty, .error {
      padding: 18px 20px;
      font-size: 0.95rem;
    }
    .empty {
      color: #5f5648;
    }
    .error {
      color: #8a2f2f;
      display: none;
    }
  </style>
</head>
<body>
  <main>
    <h1>Augment control center</h1>
    <p>Runtime owner root. Patch 1 stays limited to one managed-role runtime-status slice.</p>
    <div class="meta">
      <span>root: <code>${rootUrl}</code></span>
      <span>endpoint: <code>/api/runtime-status</code></span>
      <span id="summary">Loading runtime status...</span>
      <span id="updated-at">Not loaded yet</span>
    </div>
    <div class="status-shell">
      <div id="empty" class="empty">No managed-role status is published yet.</div>
      <div id="error" class="error"></div>
      <table aria-label="Managed role runtime status">
        <thead>
          <tr>
            <th>teamId</th>
            <th>roleId</th>
            <th>address</th>
            <th>runtime</th>
            <th>delivery</th>
            <th>terminalStatus</th>
            <th>firstDeliveryReadyAt</th>
            <th>lastDeliveryPollAt</th>
            <th>lastDeliveryError</th>
          </tr>
        </thead>
        <tbody id="status-body"></tbody>
      </table>
    </div>
  </main>
  <script>
    const API_PATH = "/api/runtime-status";
    const POLL_MS = ${JSON.stringify(CONTROL_CENTER_POLL_MS)};
    const summaryEl = document.getElementById("summary");
    const updatedAtEl = document.getElementById("updated-at");
    const emptyEl = document.getElementById("empty");
    const errorEl = document.getElementById("error");
    const bodyEl = document.getElementById("status-body");

    function formatValue(value) {
      if (value === null || value === undefined || value === "") return "—";
      if (typeof value === "number") return String(value);
      return String(value);
    }

    function renderRows(items) {
      bodyEl.innerHTML = "";
      emptyEl.style.display = items.length === 0 ? "block" : "none";

      for (const item of items) {
        const row = document.createElement("tr");
        const cells = [
          item.teamId,
          item.roleId,
          item.address,
          item.runtime,
          item.delivery,
          item.terminalStatus,
          item.firstDeliveryReadyAt,
          item.lastDeliveryPollAt,
          item.lastDeliveryError
        ];

        for (const value of cells) {
          const cell = document.createElement("td");
          cell.textContent = formatValue(value);
          row.appendChild(cell);
        }

        bodyEl.appendChild(row);
      }
    }

    async function loadStatuses() {
      try {
        const response = await fetch(API_PATH, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(\`runtime status request failed: \${response.status}\`);
        }

        const payload = await response.json();
        if (!Array.isArray(payload)) {
          throw new Error("runtime status payload was not an array");
        }

        renderRows(payload);
        summaryEl.textContent = \`\${payload.length} managed role\${payload.length === 1 ? "" : "s"} published\`;
        updatedAtEl.textContent = \`Updated \${new Date().toLocaleTimeString()}\`;
        errorEl.style.display = "none";
        errorEl.textContent = "";
      } catch (error) {
        errorEl.style.display = "block";
        errorEl.textContent = error instanceof Error ? error.message : String(error);
        summaryEl.textContent = "Runtime status unavailable";
        updatedAtEl.textContent = \`Last attempt \${new Date().toLocaleTimeString()}\`;
      }
    }

    void loadStatuses();
    window.setInterval(() => {
      void loadStatuses();
    }, POLL_MS);
  </script>
</body>
</html>`;
}

function writeHttpResponse(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function handleControlCenterRequest(request, response, rootUrl) {
  const method = String(request.method || "GET").toUpperCase();
  const url = new URL(request.url || "/", `${rootUrl || `http://${CONTROL_CENTER_HOST}/`}`);

  if (method !== "GET") {
    writeHttpResponse(response, 405, "Method not allowed\n", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/runtime-status") {
    const statuses = await readManagedRoleStatuses();
    writeHttpResponse(response, 200, `${JSON.stringify(statuses, null, 2)}\n`, "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/") {
    writeHttpResponse(response, 200, renderControlCenterRootHtml(rootUrl), "text/html; charset=utf-8");
    return;
  }

  writeHttpResponse(response, 404, "Not found\n", "text/plain; charset=utf-8");
}

async function readStatus(slotId) {
  const result = await runJsonCommand("bash", [SLOT_HARNESS, "status", "--slot", slotId, "--json"]);
  if (!result.ok) {
    throw new Error(`status failed: ${result.stderr || result.stdout}`);
  }
  return mapStateAfter(result.json);
}

function toTransportPayload(request) {
  const payload = {
    method: request.method,
    requestId: request.requestId,
    slotId: request.slotId,
    caller: request.caller,
  };

  if (request.method === "claimSlot") {
    if (request.fixturePath) {
      payload.fixturePath = request.fixturePath;
    }
    if (request.obsidianVersion) {
      payload.obsidianVersion = request.obsidianVersion;
    }
  }

  return payload;
}

function requestCacheKey(request) {
  return JSON.stringify(toTransportPayload(request));
}

function normalizeOwnerMetadata(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const instanceId = String(rawValue.instanceId || "").trim();
  const pid = Number(rawValue.pid);
  const socketPath = String(rawValue.socketPath || "").trim();
  const startedAt = String(rawValue.startedAt || "").trim();

  if (!instanceId || !Number.isFinite(pid) || pid <= 0 || !socketPath || !startedAt) {
    return null;
  }

  return {
    instanceId,
    pid,
    socketPath,
    startedAt,
  };
}

async function readOwnerMetadata() {
  try {
    return normalizeOwnerMetadata(JSON.parse(await fs.readFile(OWNER_METADATA_PATH, "utf8")));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function ownerMetadataReady(metadata) {
  if (!metadata || !isPidAlive(metadata.pid)) {
    return false;
  }

  try {
    await fs.access(metadata.socketPath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeOwnerArtifactsIfStale(metadata = null) {
  const current = metadata ?? (await readOwnerMetadata());
  if (current && isPidAlive(current.pid)) {
    return false;
  }

  await Promise.all([
    fs.rm(OWNER_METADATA_PATH, { force: true }),
    fs.rm(OWNER_SOCKET_PATH, { force: true }),
  ]);
  return true;
}

async function waitForOwnerReady(deadline) {
  while (Date.now() < deadline) {
    const metadata = await readOwnerMetadata();
    if (await ownerMetadataReady(metadata)) {
      return metadata;
    }
    await sleep(LOCK_POLL_MS);
  }

  return null;
}

function spawnDetachedOwner() {
  const child = spawn(process.execPath, [SCRIPT_PATH, INTERNAL_SERVER_MODE, RUNTIME_OWNER_DIR], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureOwnerReady() {
  const deadline = Date.now() + OWNER_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const existing = await readOwnerMetadata();
    if (await ownerMetadataReady(existing)) {
      return existing;
    }

    const releaseLock = await acquireExclusiveLock(BOOTSTRAP_LOCK_PATH, {
      scope: "runtime-owner-bootstrap",
    });
    if (!releaseLock) {
      await sleep(LOCK_POLL_MS);
      continue;
    }

    try {
      const current = await readOwnerMetadata();
      if (await ownerMetadataReady(current)) {
        return current;
      }

      if (current && isPidAlive(current.pid)) {
        const started = await waitForOwnerReady(deadline);
        if (started) {
          return started;
        }
        continue;
      }

      await fs.mkdir(RUNTIME_OWNER_DIR, { recursive: true });
      await removeOwnerArtifactsIfStale(current);
      spawnDetachedOwner();

      const started = await waitForOwnerReady(deadline);
      if (started) {
        return started;
      }
    } finally {
      await releaseLock();
    }
  }

  throw new Error(`Timed out waiting for runtime owner bootstrap at ${OWNER_SOCKET_PATH}`);
}

function requestOwnerOnce(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(OWNER_CONNECT_TIMEOUT_MS, () => {
      finish(new Error(`Timed out waiting for runtime owner response on ${socketPath}`));
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        buffer = buffer.slice(newlineIndex + 1);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (parsed && typeof parsed.error === "string") {
        finish(new Error(parsed.error));
        return;
      }

      finish(null, parsed);
    });

    socket.on("error", (error) => {
      finish(error);
    });

    socket.on("close", () => {
      if (!settled) {
        finish(new Error("Runtime owner closed the connection before responding."));
      }
    });
  });
}

async function sendRequestViaOwner(request) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const metadata = await ensureOwnerReady();
    try {
      return await requestOwnerOnce(metadata.socketPath, toTransportPayload(request));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const recovered = await recoverTimedOutClaimViaOwner(request, lastError);
      if (recovered) {
        return recovered;
      }
      if (!isPidAlive(metadata.pid)) {
        await removeOwnerArtifactsIfStale(metadata);
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  throw lastError ?? new Error("Failed to reach runtime owner.");
}

function isOwnerResponseTimeoutError(error) {
  return (
    error instanceof Error &&
    error.message.startsWith("Timed out waiting for runtime owner response on ")
  );
}

async function recoverTimedOutClaimViaOwner(request, error) {
  if (request.method !== "claimSlot" || !isOwnerResponseTimeoutError(error)) {
    return null;
  }

  const deadline = Date.now() + OWNER_CLAIM_RECOVERY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const metadata = await ensureOwnerReady();
      return await requestOwnerOnce(metadata.socketPath, toTransportPayload(request));
    } catch (retryError) {
      const retryAsError = retryError instanceof Error ? retryError : new Error(String(retryError));
      if (!isOwnerResponseTimeoutError(retryAsError)) {
        return null;
      }
    }

    await sleep(LOCK_POLL_MS);
  }

  return null;
}

function serializeBySlot(slotQueues, slotId, task) {
  const previous = slotQueues.get(slotId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tracked = current.finally(() => {
    if (slotQueues.get(slotId) === tracked) {
      slotQueues.delete(slotId);
    }
  });
  slotQueues.set(slotId, tracked);
  return tracked;
}

async function refreshSlotProjection(slotStates, slotId) {
  const state = await readStatus(slotId);
  slotStates.set(slotId, state);
  return state;
}

async function claimSlot(slotStates, request) {
  const current = await refreshSlotProjection(slotStates, request.slotId);
  if (current.leaseState === "running") {
    return buildResponse(request.method, request, "rejected", current);
  }

  const args = [
    CLAIM_HELPER,
    "--slot",
    request.slotId,
    "--owner",
    request.caller,
    "--obsidian-version",
    request.obsidianVersion,
    "--json",
  ];

  if (request.fixturePath) {
    args.push("--fixture", request.fixturePath);
  }

  const claimed = await runJsonCommand("bash", args);
  if (!claimed.ok) {
    return buildResponse(request.method, request, "conflict", await refreshSlotProjection(slotStates, request.slotId));
  }

  const stateAfter = mapStateAfter(claimed.json);
  slotStates.set(request.slotId, stateAfter);
  if (stateAfter.leaseState !== "running" || stateAfter.obsidianPid === null) {
    return buildResponse(request.method, request, "conflict", stateAfter);
  }

  return buildResponse(request.method, request, "ok", stateAfter);
}

async function statusSlot(slotStates, request) {
  return buildResponse(request.method, request, "ok", await refreshSlotProjection(slotStates, request.slotId));
}

async function stopSlot(slotStates, request) {
  const current = await refreshSlotProjection(slotStates, request.slotId);
  if (current.leaseState === "empty") {
    return buildResponse(request.method, request, "rejected", current);
  }

  const stopped = await runJsonCommand("bash", [SLOT_HARNESS, "stop", "--slot", request.slotId, "--json"]);
  if (!stopped.ok) {
    return buildResponse(request.method, request, "conflict", await refreshSlotProjection(slotStates, request.slotId));
  }

  const stateAfter = mapStateAfter(stopped.json);
  slotStates.set(request.slotId, stateAfter);
  if (stateAfter.leaseState !== "stopped" && stateAfter.leaseState !== "empty") {
    return buildResponse(request.method, request, "conflict", stateAfter);
  }

  return buildResponse(request.method, request, "ok", stateAfter);
}

async function dispatchServerRequest(slotStates, slotQueues, requestResults, payload) {
  const request = normalizeRequest(payload, "socket request");
  const cacheKey = requestCacheKey(request);
  const cached = requestResults.get(cacheKey);
  if (cached) {
    return cached;
  }

  const responsePromise = serializeBySlot(slotQueues, request.slotId, async () => {
    switch (request.method) {
      case "claimSlot":
        return claimSlot(slotStates, request);
      case "statusSlot":
        return statusSlot(slotStates, request);
      case "stopSlot":
        return stopSlot(slotStates, request);
      default:
        throw new Error(`Unknown method '${request.method}'`);
    }
  });

  requestResults.set(cacheKey, responsePromise);

  try {
    const response = await responsePromise;
    return response;
  } catch (error) {
    requestResults.delete(cacheKey);
    throw error;
  }
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function serveOwner() {
  await fs.mkdir(RUNTIME_OWNER_DIR, { recursive: true });
  await fs.rm(OWNER_SOCKET_PATH, { force: true });

  const slotStates = new Map();
  const slotQueues = new Map();
  const requestResults = new Map();
  const activeSockets = new Set();
  const activeHttpSockets = new Set();
  const instanceId = randomUUID();
  const server = net.createServer();
  const httpServer = http.createServer();
  let idleTimer = null;
  let shuttingDown = false;
  let rootUrl = "";

  const hasActiveClients = () => activeSockets.size > 0 || activeHttpSockets.size > 0;

  const cancelIdleShutdown = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdleShutdown = () => {
    if (shuttingDown || hasActiveClients() || idleTimer || OWNER_IDLE_TIMEOUT_MS <= 0) {
      return;
    }

    idleTimer = setTimeout(() => {
      idleTimer = null;
      void shutdown("idle-timeout");
    }, OWNER_IDLE_TIMEOUT_MS);
  };

  const cleanupArtifacts = async () => {
    await Promise.all([
      fs.rm(OWNER_METADATA_PATH, { force: true }),
      fs.rm(OWNER_SOCKET_PATH, { force: true }),
    ]);
  };

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    cancelIdleShutdown();

    for (const socket of activeSockets) {
      socket.destroy();
    }
    for (const socket of activeHttpSockets) {
      socket.destroy();
    }

    await closeServer(server);
    await closeServer(httpServer);
    await cleanupArtifacts();
    process.exit(0);
  };

  server.on("connection", (socket) => {
    cancelIdleShutdown();
    activeSockets.add(socket);
    socket.setEncoding("utf8");

    let buffer = "";
    let chain = Promise.resolve();

    const handleClose = () => {
      activeSockets.delete(socket);
      scheduleIdleShutdown();
    };

    socket.on("data", (chunk) => {
      buffer += chunk;

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        chain = chain
          .then(async () => {
            const response = await dispatchServerRequest(slotStates, slotQueues, requestResults, JSON.parse(line));
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify(response)}\n`);
            }
          })
          .catch((error) => {
            if (!socket.destroyed) {
              const message = error instanceof Error ? error.message : String(error);
              socket.write(`${JSON.stringify({ error: message })}\n`);
            }
          });
      }
    });

    socket.on("close", handleClose);
    socket.on("error", handleClose);
  });

  httpServer.on("connection", (socket) => {
    cancelIdleShutdown();
    activeHttpSockets.add(socket);
    const handleClose = () => {
      activeHttpSockets.delete(socket);
      scheduleIdleShutdown();
    };
    socket.on("close", handleClose);
    socket.on("error", handleClose);
  });

  httpServer.on("request", (request, response) => {
    cancelIdleShutdown();
    response.once("finish", () => {
      scheduleIdleShutdown();
    });
    response.once("close", () => {
      scheduleIdleShutdown();
    });

    void handleControlCenterRequest(request, response, rootUrl).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        writeHttpResponse(response, 500, `${message}\n`, "text/plain; charset=utf-8");
        return;
      }
      response.end();
    });
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(OWNER_SOCKET_PATH, () => {
        resolve();
      });
    }),
    new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, CONTROL_CENTER_HOST, () => {
        resolve();
      });
    }),
  ]);

  const address = httpServer.address();
  if (!address || typeof address === "string" || !Number.isFinite(address.port)) {
    throw new Error("Runtime owner HTTP server did not publish a usable address.");
  }

  rootUrl = `http://${CONTROL_CENTER_HOST}:${address.port}/`;
  const metadata = {
    instanceId,
    pid: process.pid,
    socketPath: OWNER_SOCKET_PATH,
    startedAt: new Date().toISOString(),
    rootUrl,
  };

  await fs.writeFile(OWNER_METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`);

  process.on("SIGTERM", () => {
    void shutdown("sigterm");
  });
  process.on("SIGINT", () => {
    void shutdown("sigint");
  });
  process.on("uncaughtException", async () => {
    await cleanupArtifacts();
    process.exit(1);
  });

  scheduleIdleShutdown();
}

async function ensureDependencies() {
  try {
    await fs.access(SLOT_HARNESS);
    await fs.mkdir(RUNTIME_OWNER_DIR, { recursive: true });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  if (process.argv[2] === INTERNAL_SERVER_MODE) {
    await ensureDependencies();
    await serveOwner();
    return;
  }

  const request = parseArgs(process.argv.slice(2));

  try {
    if (request.method === "claimSlot") {
      await fs.access(CLAIM_HELPER);
    }
    await ensureDependencies();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const response = await sendRequestViaOwner(request);
  printResponse(response, request.json);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
