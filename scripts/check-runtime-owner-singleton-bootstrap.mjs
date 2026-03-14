import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterPath = path.join(repoRoot, "scripts", "slot-owner-adapter.mjs");

function slotFile(stateDir, slotId) {
  return path.join(stateDir, `${slotId}.json`);
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

async function readOwnerMetadata(runtimeDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(runtimeDir, "owner.json"), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForOwnerMetadata(runtimeDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const metadata = await readOwnerMetadata(runtimeDir);
    if (metadata && isPidAlive(Number(metadata.pid))) {
      return metadata;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for owner metadata in ${runtimeDir}`);
}

async function stopOwner(runtimeDir) {
  const metadata = await readOwnerMetadata(runtimeDir);
  const pid = Number(metadata?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!error || error.code !== "ESRCH") {
      throw error;
    }
    return;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await sleep(50);
  }
}

function countOwnerProcesses(runtimeDir) {
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "ps failed");

  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("slot-owner-adapter.mjs"))
    .filter((line) => line.includes("__serve"))
    .filter((line) => line.includes(runtimeDir))
    .length;
}

async function waitForOwnerProcessCount(runtimeDir, expectedCount, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (countOwnerProcesses(runtimeDir) === expectedCount) {
      return;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for ${expectedCount} owner process(es) for ${runtimeDir}`);
}

async function readStateFile(stateDir, slotId) {
  return JSON.parse(await fs.readFile(slotFile(stateDir, slotId), "utf8"));
}

async function writeFakeSeam(tempRoot) {
  const runtimePath = path.join(tempRoot, "fake-slot-runtime.mjs");
  const harnessPath = path.join(tempRoot, "fake-obsidian-slot.sh");
  const helperPath = path.join(tempRoot, "fake-claim-helper.sh");

  await fs.writeFile(
    runtimePath,
    `import fs from "node:fs/promises";
import path from "node:path";

const stateDir = process.env.AUGMENT_SLOT_OWNER_TEST_STATE_DIR;
const delayMs = Number(process.env.AUGMENT_SLOT_OWNER_TEST_CLAIM_DELAY_MS || "0");
const argv = process.argv.slice(2);

function normalizeSlotId(rawValue) {
  const value = String(rawValue || "").trim();
  if (/^s\\d{2}$/i.test(value)) {
    const slotNumber = Number(value.slice(1));
    return \`s\${String(slotNumber).padStart(2, "0")}\`;
  }
  const slotNumber = Number(value);
  if (Number.isFinite(slotNumber) && slotNumber >= 1 && slotNumber <= 26) {
    return \`s\${String(slotNumber).padStart(2, "0")}\`;
  }
  throw new Error(\`invalid slot id \${value}\`);
}

function portForSlot(slotId) {
  return 9222 + Number(slotId.slice(1));
}

function statePath(slotId) {
  return path.join(stateDir, \`\${slotId}.json\`);
}

async function readState(slotId) {
  try {
    return JSON.parse(await fs.readFile(statePath(slotId), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeState(slotId, state) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath(slotId), JSON.stringify(state, null, 2));
}

function recordFor(slotId, state) {
  return {
    slot_id: slotId,
    port: portForSlot(slotId),
    vault_dir: state?.vaultDir ?? path.join(stateDir, slotId, "vault"),
    config_dir: state?.configDir ?? path.join(stateDir, slotId, "config"),
    plugin_id: "augment-terminal",
    obsidian_version: state?.obsidianVersion ?? "latest",
    owner: state?.owner ?? "",
    fixture_path: state?.fixturePath ?? "",
    state: state?.state ?? "empty",
    pid: Number.isFinite(state?.pid) ? state.pid : null,
  };
}

function readOption(name) {
  const index = argv.indexOf(name);
  return index === -1 ? "" : String(argv[index + 1] || "");
}

function readCommand() {
  if (argv[0] === "harness") {
    return argv[1];
  }
  return argv[0];
}

async function sleep(milliseconds) {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const mode = argv[0];
  const command = readCommand();

  if (mode === "claim-helper") {
    const slotId = normalizeSlotId(readOption("--slot"));
    const owner = readOption("--owner");
    const fixturePath = readOption("--fixture") || "/fixture/default";
    const obsidianVersion = readOption("--obsidian-version") || "latest";
    await sleep(delayMs);
    const state = {
      owner,
      fixturePath,
      obsidianVersion,
      vaultDir: path.join(stateDir, slotId, "vault"),
      configDir: path.join(stateDir, slotId, "config"),
      state: "running",
      pid: Date.now() % 100000 + 1000,
    };
    await writeState(slotId, state);
    process.stdout.write(\`\${JSON.stringify(recordFor(slotId, state))}\\n\`);
    return;
  }

  if (mode !== "harness") {
    throw new Error(\`unknown mode \${mode}\`);
  }

  if (command === "status") {
    const slotId = normalizeSlotId(readOption("--slot"));
    const state = await readState(slotId);
    process.stdout.write(\`\${JSON.stringify(recordFor(slotId, state))}\\n\`);
    return;
  }

  if (command === "stop") {
    const slotId = normalizeSlotId(readOption("--slot"));
    const existing = (await readState(slotId)) ?? {};
    const stopped = {
      ...existing,
      vaultDir: existing.vaultDir ?? path.join(stateDir, slotId, "vault"),
      configDir: existing.configDir ?? path.join(stateDir, slotId, "config"),
      state: "stopped",
      pid: null,
    };
    await writeState(slotId, stopped);
    process.stdout.write(\`\${JSON.stringify(recordFor(slotId, stopped))}\\n\`);
    return;
  }

  throw new Error(\`unknown harness command \${command}\`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`,
    "utf8"
  );

  await fs.writeFile(harnessPath, `#!/usr/bin/env bash\nnode "${runtimePath}" harness "$@"\n`, "utf8");
  await fs.writeFile(helperPath, `#!/usr/bin/env bash\nnode "${runtimePath}" claim-helper "$@"\n`, "utf8");
}

function runAdapter(args, env) {
  const result = spawnSync("node", [adapterPath, ...args], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || "adapter command failed");
  return JSON.parse((result.stdout || "").trim());
}

async function spawnAdapter(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [adapterPath, ...args], {
      env,
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
      if (code !== 0) {
        reject(new Error(stderr || stdout || `adapter exited with ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      socket.setEncoding("utf8");
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };

    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

async function openOwnerClient(socketPath) {
  const socket = await connectSocket(socketPath);

  return {
    request(payload) {
      return new Promise((resolve, reject) => {
        let buffer = "";
        const cleanup = () => {
          socket.off("data", onData);
          socket.off("error", onError);
          socket.off("close", onClose);
        };
        const onData = (chunk) => {
          buffer += chunk;
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) {
            return;
          }

          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          cleanup();

          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (error) {
            reject(error);
            return;
          }

          if (parsed && typeof parsed.error === "string") {
            reject(new Error(parsed.error));
            return;
          }

          resolve(parsed);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("Runtime owner client closed before responding."));
        };

        socket.on("data", onData);
        socket.on("error", onError);
        socket.on("close", onClose);
        socket.write(`${JSON.stringify(payload)}\n`);
      });
    },
    async close() {
      if (socket.destroyed) {
        return;
      }

      await new Promise((resolve) => {
        socket.once("close", resolve);
        socket.end();
      });
    },
  };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "augment-runtime-owner-check-"));
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "aug-ro-"));
  const stateDir = path.join(tempRoot, "state");
  const lockDir = path.join(tempRoot, "locks");

  await writeFakeSeam(tempRoot);

  const env = {
    ...process.env,
    AUGMENT_SLOT_OWNER_CLAIM_HELPER: path.join(tempRoot, "fake-claim-helper.sh"),
    AUGMENT_SLOT_OWNER_HARNESS: path.join(tempRoot, "fake-obsidian-slot.sh"),
    AUGMENT_SLOT_OWNER_LOCK_DIR: lockDir,
    AUGMENT_SLOT_OWNER_TEST_STATE_DIR: stateDir,
    AUGMENT_SLOT_OWNER_TEST_CLAIM_DELAY_MS: "150",
    AUGMENT_RUNTIME_OWNER_DIR: runtimeDir,
  };

  try {
    const bootstrapA = spawnAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "bootstrap-a", "--request-id", "bootstrap-a", "--json"],
      env
    );
    const bootstrapB = spawnAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "bootstrap-b", "--request-id", "bootstrap-b", "--json"],
      env
    );
    const [bootstrapStatusA, bootstrapStatusB] = await Promise.all([bootstrapA, bootstrapB]);
    assert.equal(bootstrapStatusA.outcome, "ok");
    assert.equal(bootstrapStatusB.outcome, "ok");

    const firstOwner = await waitForOwnerMetadata(runtimeDir);
    assert.equal(typeof firstOwner.instanceId, "string");
    assert.equal(firstOwner.socketPath, path.join(runtimeDir, "owner.sock"));
    assert.equal(isPidAlive(Number(firstOwner.pid)), true);
    await waitForOwnerProcessCount(runtimeDir, 1);

    const clientA = await openOwnerClient(firstOwner.socketPath);
    const claimWhileConnected = await clientA.request({
      method: "claimSlot",
      requestId: "client-a-claim",
      slotId: "s01",
      caller: "client-a",
      fixturePath: "/fixture/client-a",
      obsidianVersion: "latest",
    });
    assert.equal(claimWhileConnected.outcome, "ok");
    assert.equal(claimWhileConnected.stateAfter.leaseState, "running");

    const ownerAfterClaim = await waitForOwnerMetadata(runtimeDir);
    assert.equal(ownerAfterClaim.instanceId, firstOwner.instanceId);
    assert.equal(ownerAfterClaim.socketPath, firstOwner.socketPath);

    const clientB = await openOwnerClient(firstOwner.socketPath);
    const inspectWhileConnected = await clientB.request({
      method: "statusSlot",
      requestId: "client-b-inspect",
      slotId: "s01",
      caller: "client-b",
    });
    assert.equal(inspectWhileConnected.outcome, "ok");
    assert.equal(inspectWhileConnected.stateAfter.leaseState, "running");
    assert.equal(inspectWhileConnected.stateAfter.debugPort, claimWhileConnected.stateAfter.debugPort);
    await clientB.close();

    await clientA.close();

    const inspectAfterDisconnect = runAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "post-disconnect", "--request-id", "post-disconnect", "--json"],
      env
    );
    assert.equal(inspectAfterDisconnect.outcome, "ok");
    assert.equal(inspectAfterDisconnect.stateAfter.leaseState, "running");
    assert.equal(inspectAfterDisconnect.stateAfter.debugPort, claimWhileConnected.stateAfter.debugPort);

    const staleState = await readStateFile(stateDir, "s01");
    staleState.pid = null;
    staleState.state = "running";
    await fs.writeFile(slotFile(stateDir, "s01"), JSON.stringify(staleState, null, 2));

    const staleStatus = runAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "stale-observer", "--request-id", "stale-status", "--json"],
      env
    );
    assert.equal(staleStatus.outcome, "ok");
    assert.equal(staleStatus.stateAfter.leaseState, "stale");

    const reclaimAfterDisconnect = runAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "client-b", "--request-id", "reclaim-after-stale", "--json"],
      env
    );
    assert.equal(reclaimAfterDisconnect.outcome, "ok");
    assert.equal(reclaimAfterDisconnect.stateAfter.leaseState, "running");
    assert.notEqual(reclaimAfterDisconnect.stateAfter.obsidianPid, null);

    const ownerBeforeRestart = await waitForOwnerMetadata(runtimeDir);
    const restartState = await readStateFile(stateDir, "s01");
    restartState.pid = null;
    restartState.state = "running";
    await fs.writeFile(slotFile(stateDir, "s01"), JSON.stringify(restartState, null, 2));

    await stopOwner(runtimeDir);

    const rebuiltStatus = runAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "restart-observer", "--request-id", "restart-status", "--json"],
      env
    );
    assert.equal(rebuiltStatus.outcome, "ok");
    assert.equal(["running", "stale"].includes(rebuiltStatus.stateAfter.leaseState), true);

    const ownerAfterRestart = await waitForOwnerMetadata(runtimeDir);
    assert.notEqual(ownerAfterRestart.instanceId, ownerBeforeRestart.instanceId);
    assert.notEqual(Number(ownerAfterRestart.pid), Number(ownerBeforeRestart.pid));
    await waitForOwnerProcessCount(runtimeDir, 1);

    console.log("runtime-owner singleton bootstrap check passed.");
    console.log("  singleton bootstrap race: both clients converged on one surviving owner");
    console.log("  second-client inspect while connected: statusSlot reported the live slot");
    console.log("  inspect after disconnect: surviving owner kept slot projection available");
    console.log("  reclaim after disconnect when stale: claimSlot recovered the stale slot");
    console.log("  owner restart state rebuild: first post-restart status rebuilt state before mutation");
  } finally {
    await stopOwner(runtimeDir);
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
