import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "augment-attention-queue-"));
const outfile = path.join(tempDir, "attention-queue.mjs");

try {
  await build({
    entryPoints: [path.join(repoRoot, "src/attention-queue.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });

  const { summarizeAttentionSessions } = await import(pathToFileURL(outfile).href);

  const quiet = summarizeAttentionSessions([]);
  assert.equal(quiet.attentionCount, 0);
  assert.equal(quiet.unreadSessionCount, 0);
  assert.equal(quiet.waitingSessionCount, 0);
  assert.equal(quiet.badgeText, "");
  assert.equal(quiet.ariaLabel, "No sessions need attention");

  const waitingOnly = summarizeAttentionSessions([
    { id: "older-waiting", status: "waiting", unreadActivity: 0, lastActivityMs: 10 },
    { id: "newer-waiting", status: "waiting", unreadActivity: 0, lastActivityMs: 20 },
  ]);
  assert.equal(waitingOnly.attentionCount, 2);
  assert.equal(waitingOnly.unreadSessionCount, 0);
  assert.equal(waitingOnly.badgeText, "⚡ 2");
  assert.deepEqual(
    waitingOnly.ordered.map((session) => session.id),
    ["older-waiting", "newer-waiting"]
  );

  const mixed = summarizeAttentionSessions([
    { id: "waiting-only", status: "waiting", unreadActivity: 0, lastActivityMs: 50 },
    { id: "unread-shell", status: "shell", unreadActivity: 1, lastActivityMs: 80 },
    { id: "unread-active", status: "active", unreadActivity: 3, lastActivityMs: 90 },
  ]);
  assert.equal(mixed.attentionCount, 3);
  assert.equal(mixed.unreadSessionCount, 2);
  assert.equal(mixed.waitingSessionCount, 1);
  assert.equal(mixed.badgeText, "⚡ 3 · 2 unread");
  assert.deepEqual(
    mixed.ordered.map((session) => session.id),
    ["unread-active", "unread-shell", "waiting-only"]
  );

  const waitingUnread = summarizeAttentionSessions([
    { id: "waiting-with-unread", status: "waiting", unreadActivity: 1, lastActivityMs: 15 },
    { id: "plain-waiting", status: "waiting", unreadActivity: 0, lastActivityMs: 5 },
  ]);
  assert.equal(waitingUnread.attentionCount, 2);
  assert.equal(waitingUnread.unreadSessionCount, 1);
  assert.equal(waitingUnread.waitingSessionCount, 2);
  assert.deepEqual(
    waitingUnread.ordered.map((session) => session.id),
    ["waiting-with-unread", "plain-waiting"]
  );

  console.log("attention queue checks passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
