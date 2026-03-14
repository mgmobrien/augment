import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "augment-status-bridge-"));
const outfile = path.join(tempDir, "status-bridge.mjs");

try {
  await build({
    entryPoints: [path.join(repoRoot, "src/status-bridge.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });

  const { summarizeStatusBridgeSessions } = await import(pathToFileURL(outfile).href);

  const quiet = summarizeStatusBridgeSessions([]);
  assert.equal(quiet.label, "Augment");
  assert.equal(quiet.activeSessionCount, 0);
  assert.equal(quiet.recentSessions.length, 0);

  const active = summarizeStatusBridgeSessions([
    { name: "late-shell", status: "shell", lastActivityMs: 20 },
    { name: "waiting-run", status: "waiting", lastActivityMs: 40 },
    { name: "active-run", status: "active", lastActivityMs: 60 },
    { name: "done-run", status: "exited", lastActivityMs: 80 },
    { name: "crashed-run", status: "crashed", lastActivityMs: 100 },
  ]);
  assert.equal(active.label, "Augment · 3 active");
  assert.equal(active.activeSessionCount, 3);
  assert.deepEqual(
    active.recentSessions.map((session) => session.name),
    ["active-run", "waiting-run", "late-shell"]
  );
  assert.deepEqual(
    active.recentSessions.map((session) => session.statusLabel),
    ["Active", "Waiting", "Shell"]
  );

  const capped = summarizeStatusBridgeSessions([
    { name: "s1", status: "shell", lastActivityMs: 10 },
    { name: "s2", status: "shell", lastActivityMs: 20 },
    { name: "s3", status: "shell", lastActivityMs: 30 },
    { name: "s4", status: "shell", lastActivityMs: 40 },
    { name: "s5", status: "shell", lastActivityMs: 50 },
    { name: "s6", status: "shell", lastActivityMs: 60 },
  ]);
  assert.equal(capped.activeSessionCount, 6);
  assert.equal(capped.recentSessions.length, 5);
  assert.deepEqual(
    capped.recentSessions.map((session) => session.name),
    ["s6", "s5", "s4", "s3", "s2"]
  );

  console.log("status bridge active-session-only checks passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
