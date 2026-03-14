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
    path.join(repoRoot, "packages", "shared-domain", "src", "index.ts"),
    "shared-domain-runtime-contracts.cjs"
  );

  try {
    const shared = require(outfile);

    assert(shared.deriveRuntimeState("shell") === "launching", "shell should derive to launching");
    assert(shared.deriveRuntimeState("running") === "launching", "running should derive to launching");
    assert(shared.deriveRuntimeState("active") === "busy", "active should derive to busy");
    assert(shared.deriveRuntimeState("tool") === "busy", "tool should derive to busy");
    assert(shared.deriveRuntimeState("waiting") === "waiting", "waiting should derive to waiting");
    assert(shared.deriveRuntimeState("idle") === "waiting", "idle should derive to waiting");
    assert(shared.deriveRuntimeState("exited") === "exited", "exited should derive to exited");
    assert(shared.deriveRuntimeState("crashed") === "failed", "crashed should derive to failed");
    assert(Array.isArray(shared.SLOT_OWNER_METHODS), "slot-owner methods should export");
    assert(shared.isSlotOwnerMethod("claimSlot"), "claimSlot should be a valid slot-owner method");
    assert(shared.isSlotLeaseState("stale"), "stale should be a valid slot lease state");
    assert(shared.isSlotOwnershipOutcome("conflict"), "conflict should be a valid slot outcome");

    const pendingObservation = shared.createDeliveryObservation("ceo@augment-plugin");
    assert(pendingObservation.address === "ceo@augment-plugin", "delivery observation should keep the address");
    assert(shared.deriveManagedDeliveryState(undefined) === "pending", "missing observation should be pending");
    assert(
      shared.deriveManagedDeliveryState(pendingObservation) === "pending",
      "unready observation should be pending"
    );

    const readyObservation = {
      ...pendingObservation,
      firstDeliveryReadyAt: 1000,
      lastDeliveryPollAt: 1200,
    };
    assert(shared.deriveManagedDeliveryState(readyObservation) === "ready", "ready observation should be ready");

    const degradedObservation = {
      ...readyObservation,
      lastDeliveryError: "poll failed",
    };
    assert(
      shared.deriveManagedDeliveryState(degradedObservation) === "degraded",
      "errored observation should be degraded"
    );

    const fallbackAddressStatus = shared.buildManagedRoleStatus({
      teamId: "team-a",
      roleId: "ceo",
      address: "fallback@augment-plugin",
      terminalStatus: "tool",
    });
    assert(fallbackAddressStatus.address === "fallback@augment-plugin", "status should keep fallback address");
    assert(fallbackAddressStatus.runtime === "busy", "tool runtime should derive to busy");
    assert(fallbackAddressStatus.delivery === "pending", "missing observation should keep pending delivery");

    const observedStatus = shared.buildManagedRoleStatus({
      teamId: "team-a",
      roleId: "eng",
      address: "fallback@augment-plugin",
      observation: degradedObservation,
      terminalStatus: "running",
    });
    assert(observedStatus.address === "ceo@augment-plugin", "observation address should override fallback");
    assert(observedStatus.runtime === "launching", "running runtime should derive to launching");
    assert(observedStatus.delivery === "degraded", "degraded observation should propagate");
    assert(observedStatus.firstDeliveryReadyAt === 1000, "status should expose first ready time");
    assert(observedStatus.lastDeliveryPollAt === 1200, "status should expose last poll time");
    assert(observedStatus.lastDeliveryError === "poll failed", "status should expose last delivery error");

    const slotState = shared.createSlotOwnershipState({
      slotId: "s01",
      leaseState: "stale",
      debugPort: 9223,
      vaultDir: "/tmp/augment/s01/vault",
      configDir: "/tmp/augment/s01/config",
      obsidianPid: null,
      observedAt: "2026-03-12T09:00:00.000Z",
    });
    assert(slotState.leaseState === "stale", "slot ownership state should preserve stale lease state");
    assert(slotState.debugPort === 9223, "slot ownership state should preserve debug port");

    const slotResponse = shared.createSlotOwnerResponse({
      method: "claimSlot",
      requestId: "request-1",
      slotId: "s01",
      caller: "augment-plugin",
      outcome: "ok",
      stateAfter: slotState,
    });
    assert(slotResponse.method === "claimSlot", "slot-owner response should preserve method");
    assert(slotResponse.outcome === "ok", "slot-owner response should preserve outcome");
    assert(slotResponse.stateAfter.slotId === "s01", "slot-owner response should preserve state");

    console.log("shared-domain runtime contracts check passed.");
    console.log(`  pending delivery: ${shared.deriveManagedDeliveryState(pendingObservation)}`);
    console.log(`  ready delivery: ${shared.deriveManagedDeliveryState(readyObservation)}`);
    console.log(`  degraded delivery: ${shared.deriveManagedDeliveryState(degradedObservation)}`);
    console.log(`  slot-owner methods: ${shared.SLOT_OWNER_METHODS.join(", ")}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
