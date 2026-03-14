import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

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
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { bundleDir, outfile } = await bundleModule(
    path.join(repoRoot, "packages", "shared-domain", "src", "index.ts"),
    "runtime-owner-slot-ownership.cjs"
  );

  try {
    const shared = require(outfile);

    assert.deepEqual(shared.SLOT_OWNER_METHODS, ["claimSlot", "statusSlot", "stopSlot"]);
    assert.deepEqual(shared.SLOT_OWNERSHIP_OUTCOMES, ["ok", "rejected", "conflict"]);
    assert.deepEqual(shared.SLOT_LEASE_STATES, ["empty", "prepared", "running", "stopped", "stale"]);
    assert.deepEqual(shared.SLOT_OWNERSHIP_CANARY_CASE_IDS, [
      "single-slot-happy-path",
      "same-slot-contention",
      "different-slot-parallelism",
      "stale-lease-recovery",
    ]);

    assert.equal(shared.isSlotOwnerMethod("claimSlot"), true);
    assert.equal(shared.isSlotOwnerMethod("releaseSlot"), false);
    assert.equal(shared.isSlotLeaseState("stale"), true);
    assert.equal(shared.isSlotLeaseState("released"), false);
    assert.equal(shared.isSlotOwnershipOutcome("conflict"), true);
    assert.equal(shared.isSlotOwnershipOutcome("retry"), false);
    assert.equal(shared.isSlotOwnershipCanaryCaseId("same-slot-contention"), true);
    assert.equal(shared.isSlotOwnershipCanaryCaseId("owner-restart"), false);

    const claimRequest = shared.createClaimSlotRequest({
      requestId: "claim-1",
      slotId: "s01",
      caller: "augment-plugin",
      fixturePath: "/tmp/augment/s01.fixture",
      obsidianVersion: "1.8.10",
    });
    assert.deepEqual(claimRequest, {
      method: "claimSlot",
      requestId: "claim-1",
      slotId: "s01",
      caller: "augment-plugin",
      fixturePath: "/tmp/augment/s01.fixture",
      obsidianVersion: "1.8.10",
    });

    const statusRequest = shared.createStatusSlotRequest({
      requestId: "status-1",
      slotId: "s01",
      caller: "augment-plugin",
    });
    assert.deepEqual(statusRequest, {
      method: "statusSlot",
      requestId: "status-1",
      slotId: "s01",
      caller: "augment-plugin",
    });

    const stopRequest = shared.createStopSlotRequest({
      requestId: "stop-1",
      slotId: "s01",
      caller: "augment-plugin",
    });
    assert.deepEqual(stopRequest, {
      method: "stopSlot",
      requestId: "stop-1",
      slotId: "s01",
      caller: "augment-plugin",
    });

    const stateAfter = shared.createSlotOwnershipState({
      slotId: "s01",
      leaseState: "stale",
      debugPort: 9223,
      vaultDir: "/tmp/augment/s01/vault",
      configDir: "/tmp/augment/s01/config",
      obsidianPid: null,
      observedAt: "2026-03-12T09:38:00.000Z",
    });
    assert.deepEqual(stateAfter, {
      slotId: "s01",
      leaseState: "stale",
      debugPort: 9223,
      vaultDir: "/tmp/augment/s01/vault",
      configDir: "/tmp/augment/s01/config",
      obsidianPid: null,
      observedAt: "2026-03-12T09:38:00.000Z",
    });

    const response = shared.createSlotOwnerResponse({
      method: claimRequest.method,
      requestId: claimRequest.requestId,
      slotId: claimRequest.slotId,
      caller: claimRequest.caller,
      outcome: "ok",
      stateAfter,
    });
    assert.equal(response.method, "claimSlot");
    assert.equal(response.outcome, "ok");
    assert.notStrictEqual(response.stateAfter, stateAfter);
    assert.deepEqual(response.stateAfter, stateAfter);

    const matrix = shared.SLOT_OWNERSHIP_CANARY_MATRIX;
    assert.equal(Array.isArray(matrix), true);
    assert.deepEqual(
      matrix.map((scenario) => scenario.id),
      shared.SLOT_OWNERSHIP_CANARY_CASE_IDS
    );

    for (const scenario of matrix) {
      assert.equal(scenario.placeholder, true, `${scenario.id} should remain a placeholder`);
      assert.equal(typeof scenario.summary, "string", `${scenario.id} should include summary text`);
      assert.equal(Array.isArray(scenario.requiredMethods), true, `${scenario.id} should list required methods`);
      assert.equal(Array.isArray(scenario.expectedOutcomes), true, `${scenario.id} should list expected outcomes`);
      assert.equal(Array.isArray(scenario.expectedLeaseStates), true, `${scenario.id} should list lease states`);
      assert.equal(scenario.requiredMethods.length > 0, true, `${scenario.id} should cover at least one method`);
      assert.equal(scenario.expectedOutcomes.length > 0, true, `${scenario.id} should cover at least one outcome`);
      assert.equal(scenario.expectedLeaseStates.length > 0, true, `${scenario.id} should cover at least one lease state`);
    }

    const sameSlotContention = matrix.find((scenario) => scenario.id === "same-slot-contention");
    assert.ok(sameSlotContention, "same-slot contention placeholder should exist");
    assert.deepEqual(sameSlotContention.requiredMethods, ["claimSlot"]);
    assert.deepEqual(sameSlotContention.expectedOutcomes, ["ok", "rejected"]);
    assert.deepEqual(sameSlotContention.expectedLeaseStates, ["running"]);

    const staleLeaseRecovery = matrix.find((scenario) => scenario.id === "stale-lease-recovery");
    assert.ok(staleLeaseRecovery, "stale lease recovery placeholder should exist");
    assert.deepEqual(staleLeaseRecovery.requiredMethods, ["claimSlot", "statusSlot"]);
    assert.deepEqual(staleLeaseRecovery.expectedOutcomes, ["ok"]);
    assert.deepEqual(staleLeaseRecovery.expectedLeaseStates, ["stale", "running"]);

    console.log("runtime-owner slot-ownership contract check passed.");
    console.log(`  methods: ${shared.SLOT_OWNER_METHODS.join(", ")}`);
    console.log(`  outcomes: ${shared.SLOT_OWNERSHIP_OUTCOMES.join(", ")}`);
    console.log(`  lease states: ${shared.SLOT_LEASE_STATES.join(", ")}`);
    console.log(`  canary placeholders: ${shared.SLOT_OWNERSHIP_CANARY_CASE_IDS.join(", ")}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
