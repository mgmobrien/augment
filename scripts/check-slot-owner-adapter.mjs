import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterPath = path.join(repoRoot, "scripts", "slot-owner-adapter.mjs");

function slotFile(stateDir, slotId) {
  return path.join(stateDir, `${slotId}.json`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") {
        return;
      }
    }
    await sleep(50);
  }
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

function runStartTest(args, env) {
  const result = spawnSync("bash", [path.join(repoRoot, "scripts", "start-test.sh"), ...args], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || "start-test failed");
  return result.stdout || "";
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

async function readStateFile(stateDir, slotId) {
  return JSON.parse(await fs.readFile(slotFile(stateDir, slotId), "utf8"));
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "augment-slot-owner-check-"));
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
    const happyClaim = runAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "happy-a", "--request-id", "happy-claim", "--json"],
      env
    );
    assert.equal(happyClaim.outcome, "ok");
    assert.equal(happyClaim.stateAfter.leaseState, "running");
    assert.equal(happyClaim.stateAfter.debugPort, 9223);
    assert.notEqual(happyClaim.stateAfter.obsidianPid, null);

    const happyStatus = runAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "observer", "--request-id", "happy-status", "--json"],
      env
    );
    assert.equal(happyStatus.outcome, "ok");
    assert.equal(happyStatus.stateAfter.leaseState, "running");
    assert.equal(happyStatus.stateAfter.debugPort, 9223);

    const happyStop = runAdapter(
      ["stopSlot", "--slot", "s01", "--caller", "happy-a", "--request-id", "happy-stop", "--json"],
      env
    );
    assert.equal(happyStop.outcome, "ok");
    assert.equal(happyStop.stateAfter.leaseState, "stopped");
    assert.equal(happyStop.stateAfter.obsidianPid, null);

    const sameSlotA = spawnAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "same-slot-a", "--request-id", "same-slot-a", "--json"],
      env
    );
    const sameSlotB = spawnAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "same-slot-b", "--request-id", "same-slot-b", "--json"],
      env
    );
    const [contentionA, contentionB] = await Promise.all([sameSlotA, sameSlotB]);
    const contentionOutcomes = [contentionA.outcome, contentionB.outcome].sort();
    assert.deepEqual(contentionOutcomes, ["ok", "rejected"]);

    const winner = contentionA.outcome === "ok" ? contentionA : contentionB;
    const slotState = await readStateFile(stateDir, "s01");
    assert.equal(slotState.owner, winner.caller);
    assert.equal(slotState.state, "running");

    runAdapter(["stopSlot", "--slot", "s01", "--caller", "cleanup", "--request-id", "cleanup-s01", "--json"], env);

    const differentSlotA = spawnAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "parallel-a", "--request-id", "parallel-a", "--json"],
      env
    );
    const differentSlotB = spawnAdapter(
      ["claimSlot", "--slot", "s02", "--caller", "parallel-b", "--request-id", "parallel-b", "--json"],
      env
    );
    const [parallelA, parallelB] = await Promise.all([differentSlotA, differentSlotB]);
    assert.equal(parallelA.outcome, "ok");
    assert.equal(parallelB.outcome, "ok");
    assert.notEqual(parallelA.stateAfter.debugPort, parallelB.stateAfter.debugPort);

    runAdapter(["stopSlot", "--slot", "s01", "--caller", "cleanup", "--request-id", "cleanup-s01-2", "--json"], env);
    runAdapter(["stopSlot", "--slot", "s02", "--caller", "cleanup", "--request-id", "cleanup-s02", "--json"], env);

    const staleClaim = runAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "stale-a", "--request-id", "stale-a", "--json"],
      env
    );
    assert.equal(staleClaim.outcome, "ok");
    const staleState = await readStateFile(stateDir, "s01");
    staleState.pid = null;
    staleState.state = "running";
    await fs.writeFile(slotFile(stateDir, "s01"), JSON.stringify(staleState, null, 2));

    const staleStatus = runAdapter(
      ["statusSlot", "--slot", "s01", "--caller", "observer", "--request-id", "stale-status", "--json"],
      env
    );
    assert.equal(staleStatus.outcome, "ok");
    assert.equal(staleStatus.stateAfter.leaseState, "stale");

    const staleRecovery = runAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "stale-b", "--request-id", "stale-b", "--json"],
      env
    );
    assert.equal(staleRecovery.outcome, "ok");
    assert.equal(staleRecovery.stateAfter.leaseState, "running");
    assert.notEqual(staleRecovery.stateAfter.obsidianPid, null);
    const recoveredState = await readStateFile(stateDir, "s01");
    assert.equal(recoveredState.owner, "stale-b");

    runAdapter(["stopSlot", "--slot", "s01", "--caller", "cleanup", "--request-id", "cleanup-s01-3", "--json"], env);

    const timeoutRecoveryEnv = {
      ...env,
      AUGMENT_RUNTIME_OWNER_CONNECT_TIMEOUT_MS: "300",
      AUGMENT_SLOT_OWNER_TEST_CLAIM_DELAY_MS: "700",
    };

    console.log("  timeout recovery: checking direct adapter claim");
    const timeoutRecoveredClaim = runAdapter(
      ["claimSlot", "--slot", "s01", "--caller", "timeout-adapter", "--request-id", "timeout-adapter", "--json"],
      timeoutRecoveryEnv
    );
    assert.equal(timeoutRecoveredClaim.outcome, "ok");
    assert.equal(timeoutRecoveredClaim.stateAfter.leaseState, "running");
    assert.equal(timeoutRecoveredClaim.stateAfter.debugPort, 9223);

    runAdapter(
      ["stopSlot", "--slot", "s01", "--caller", "cleanup", "--request-id", "cleanup-s01-timeout-adapter", "--json"],
      timeoutRecoveryEnv
    );

    console.log("  timeout recovery: checking start-test launcher");
    const startTestOutput = runStartTest(["--slot", "s01", "--owner", "timeout-recovery"], timeoutRecoveryEnv);
    assert.match(startTestOutput, /Slot:\s+s01/);
    assert.match(startTestOutput, /CDP port:\s+9223/);
    const timeoutRecoveredState = await readStateFile(stateDir, "s01");
    assert.equal(timeoutRecoveredState.owner, "timeout-recovery");
    assert.equal(timeoutRecoveredState.state, "running");

    runAdapter(
      ["stopSlot", "--slot", "s01", "--caller", "cleanup", "--request-id", "cleanup-s01-timeout", "--json"],
      timeoutRecoveryEnv
    );

    console.log("slot-owner adapter check passed.");
    console.log("  happy path: claim -> status -> stop");
    console.log("  same-slot contention: ok + rejected with winner preserved");
    console.log("  different-slot parallelism: ok + ok on distinct ports");
    console.log("  stale recovery: status reports stale before reclaim");
    console.log("  adapter timeout recovery: claimSlot recovered a live slot after owner response timeout");
    console.log("  start-test timeout recovery: launcher survived owner response timeout after valid launch");
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
