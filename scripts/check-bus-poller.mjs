import { build } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(description, predicate, timeoutMs = 750, intervalMs = 20) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await wait(intervalMs);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function createDeliveryObservation() {
  return {
    firstDeliveryReadyAt: null,
    lastDeliveryPollAt: null,
    lastDeliveryError: null,
  };
}

function notePollSuccess(observation) {
  const now = Date.now();
  observation.firstDeliveryReadyAt ??= now;
  observation.lastDeliveryPollAt = now;
  observation.lastDeliveryError = null;
}

function notePollFailure(observation, error) {
  observation.lastDeliveryPollAt = Date.now();
  observation.lastDeliveryError = error instanceof Error ? error.message : String(error);
}

function deriveDeliveryState(observation) {
  if (observation.firstDeliveryReadyAt === null) return "pending";
  if (observation.lastDeliveryError) return "degraded";
  return "ready";
}

async function bundleModule(entryPoint, outputName) {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "augment-check-"));
  const outfile = path.join(bundleDir, outputName);

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });

  return { bundleDir, outfile };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { bundleDir, outfile } = await bundleModule(
    path.join(repoRoot, "src", "bus-poller.ts"),
    "bus-poller.cjs"
  );

  const { BusPoller, BusPollerManager } = require(outfile);
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "augment-bus-poller-vault-"));
  const hooksDir = path.join(vaultRoot, "claude", "hooks");
  const messagePath = path.join(vaultRoot, "message.txt");
  const failPath = path.join(vaultRoot, "fail-next-poll");
  const scriptPath = path.join(hooksDir, "inbox-check.sh");
  const previousInterval = process.env.AUGMENT_BUS_POLL_INTERVAL;

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
set -euo pipefail
STATE_FILE=${JSON.stringify(messagePath)}
FAIL_FILE=${JSON.stringify(failPath)}
if [[ -f "$FAIL_FILE" ]]; then
  echo "forced inbox-check failure" >&2
  exit 1
fi
if [[ -f "$STATE_FILE" ]]; then
  cat "$STATE_FILE"
  : > "$STATE_FILE"
fi
`,
      "utf8"
    );
    fs.chmodSync(scriptPath, 0o755);

    process.env.AUGMENT_BUS_POLL_INTERVAL = "25";

    const writes = [];
    const deliveryObservation = createDeliveryObservation();
    let directFailureCount = 0;
    const poller = new BusPoller(
      "ceo@augment-dummy-team",
      vaultRoot,
      (text) => {
        writes.push(text);
      },
      {
        onPollSuccess: () => {
          notePollSuccess(deliveryObservation);
        },
        onPollFailure: (error) => {
          directFailureCount += 1;
          notePollFailure(deliveryObservation, error);
        },
      }
    );

    assert(deriveDeliveryState(deliveryObservation) === "pending", "initial delivery state should be pending");

    fs.writeFileSync(messagePath, "message one\n", "utf8");
    poller.start();
    await waitForCondition("first poll write", () => writes.length === 1);

    assert(writes.length === 1, `expected first poll write, saw ${writes.length}`);
    assert(writes[0].includes("message one"), "first poll output missing message one");
    assert(deriveDeliveryState(deliveryObservation) === "ready", "first successful poll should mark delivery ready");

    fs.writeFileSync(messagePath, "message two\n", "utf8");
    await waitForCondition("second poll write", () => writes.length === 2);

    assert(writes.length === 2, `expected second poll write, saw ${writes.length}`);
    assert(writes[1].includes("message two"), "second poll output missing message two");
    assert(deriveDeliveryState(deliveryObservation) === "ready", "successful follow-up poll should keep delivery ready");

    poller.destroy();
    fs.writeFileSync(messagePath, "message three\n", "utf8");
    await wait(120);
    assert(writes.length === 2, "destroyed poller should not write more data");
    assert(directFailureCount === 0, `direct poller should not fail, saw ${directFailureCount} failures`);

    const managerWrites = [];
    const managerObservation = createDeliveryObservation();
    let managerFailureCount = 0;
    const manager = new BusPollerManager();
    fs.writeFileSync(messagePath, "message four\n", "utf8");
    manager.startPoller(
      "dummy::ceo",
      "ceo@augment-dummy-team",
      vaultRoot,
      (text) => {
        managerWrites.push(text);
      },
      {
        onPollSuccess: () => {
          notePollSuccess(managerObservation);
        },
        onPollFailure: (error) => {
          managerFailureCount += 1;
          notePollFailure(managerObservation, error);
        },
      }
    );
    await waitForCondition("manager poll write", () => managerWrites.length === 1);

    assert(managerWrites.length === 1, `manager startPoller failed, saw ${managerWrites.length}`);
    assert(managerWrites[0].includes("message four"), "manager output missing message four");
    assert(deriveDeliveryState(managerObservation) === "ready", "manager poller should mark delivery ready after success");

    fs.writeFileSync(failPath, "1\n", "utf8");
    await waitForCondition("manager poll failure", () => managerFailureCount >= 1);
    assert(managerFailureCount >= 1, "forced failure should be observed by the manager poller");
    assert(deriveDeliveryState(managerObservation) === "degraded", "poll failure after readiness should mark delivery degraded");

    manager.stopAll();
    fs.writeFileSync(messagePath, "message five\n", "utf8");
    await wait(120);
    assert(managerWrites.length === 1, "stopAll should prevent more writes");

    console.log("Bus poller check passed.");
    console.log(`  direct writes: ${writes.length}`);
    console.log(`  manager writes: ${managerWrites.length}`);
    console.log(`  delivery states: direct=${deriveDeliveryState(deliveryObservation)}, manager=${deriveDeliveryState(managerObservation)}`);
  } finally {
    if (previousInterval === undefined) {
      delete process.env.AUGMENT_BUS_POLL_INTERVAL;
    } else {
      process.env.AUGMENT_BUS_POLL_INTERVAL = previousInterval;
    }

    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
