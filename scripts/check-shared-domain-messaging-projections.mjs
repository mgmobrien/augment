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

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toRepoRelativeInput(input) {
  const resolved = path.resolve(repoRoot, input);
  if (!isWithin(repoRoot, resolved)) return null;
  return path.relative(repoRoot, resolved).replace(/\\/g, "/");
}

function describeUnexpectedRepoInput(input) {
  for (const [prefix, label] of forbiddenRepoInputLabels) {
    if (input === prefix || input.startsWith(prefix)) {
      return `${input} (${label})`;
    }
  }

  return `${input} (outside messaging seam)`;
}

function assertMessagingBundleInputs(checkName, metafile, expectedInputs) {
  const repoInputs = [...new Set(Object.keys(metafile.inputs).map(toRepoRelativeInput).filter(Boolean))].sort();
  const missing = expectedInputs.filter((input) => !repoInputs.includes(input));
  const unexpected = repoInputs.filter((input) => !expectedInputs.includes(input));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        `${checkName} bundle drifted from the messaging seam.`,
        missing.length > 0 ? `missing inputs: ${missing.join(", ")}` : null,
        unexpected.length > 0
          ? `unexpected inputs: ${unexpected.map(describeUnexpectedRepoInput).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return repoInputs;
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixturesRoot = path.join(
  repoRoot,
  "packages",
  "shared-domain",
  "fixtures",
  "messaging",
  "projections",
  "v1"
);
const manifestPath = path.join(fixturesRoot, "manifest.json");
const messagingRepoInputs = [
  "packages/shared-domain/src/messaging/contracts.ts",
  "packages/shared-domain/src/messaging/address.ts",
  "packages/shared-domain/src/messaging/layout.ts",
  "packages/shared-domain/src/messaging/document.ts",
  "packages/shared-domain/src/messaging/mutations.ts",
  "packages/shared-domain/src/messaging/projections.ts",
];
const forbiddenRepoInputLabels = [
  ["packages/shared-domain/src/index.ts", "shared-domain barrel"],
  ["packages/shared-domain/src/runtime/", "runtime/*"],
  ["packages/shared-domain/src/launch/", "launch/*"],
  ["src/", "plugin-host"],
];

function pathLane(busPath) {
  const match = busPath.match(/^agents\/bus\/(local|shared)\//);
  assert(match, `fixture path is outside the canonical bus root: ${busPath}`);
  return match[1];
}

function readFixture(shared, caseMeta, fixtureMeta, kind) {
  const fixturePath = path.join(fixturesRoot, fixtureMeta.fixture);
  const rawContent = fs.readFileSync(fixturePath, "utf8");
  const frontmatter = shared.parseRawFrontmatter(rawContent);

  const record =
    kind === "message"
      ? shared.parseIndexedMessageRecord(frontmatter, fixtureMeta.busPath, pathLane(fixtureMeta.busPath))
      : shared.parseIndexedEventRecord(frontmatter, fixtureMeta.busPath, pathLane(fixtureMeta.busPath));

  assert(record, `${caseMeta.id}: ${kind} fixture should parse: ${fixtureMeta.fixture}`);
  return record;
}

function normalizeLifecycleViolation(violation) {
  return {
    reason: violation.reason,
    msgId: violation.msgId,
    actor: violation.actor,
    eventType: violation.eventType,
    filePath: violation.filePath,
  };
}

function normalizeThreadSummary(summary) {
  return {
    threadId: summary.threadId,
    subject: summary.subject,
    lastSender: summary.lastSender,
    lastTo: summary.lastTo,
    counterparty: summary.counterparty,
    participants: summary.participants,
    humanInvolved: summary.humanInvolved,
    lastActivityAt: summary.lastActivityAt,
    messageCount: summary.messageCount,
    hasUnread: summary.hasUnread,
  };
}

function assertLifecycle(caseMeta, index) {
  const actual = index.lifecycleViolations.map(normalizeLifecycleViolation);
  const expected = caseMeta.expected.lifecycleViolations ?? [];

  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${caseMeta.id}: lifecycle violations drifted\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`
  );
}

function assertUnread(shared, caseMeta, index) {
  const expected = caseMeta.expected.unread;
  const actualUnread = shared.listUnreadMessages(index, expected.actor).map((message) => message.msgId);
  const actualCount = shared.unreadCountForActor(index, expected.actor);

  assert(
    JSON.stringify(actualUnread) === JSON.stringify(expected.msgIds),
    `${caseMeta.id}: unread ids drifted\nexpected: ${JSON.stringify(expected.msgIds)}\nactual: ${JSON.stringify(actualUnread)}`
  );
  assert(
    actualCount === expected.count,
    `${caseMeta.id}: unread count drifted\nexpected: ${expected.count}\nactual: ${actualCount}`
  );
}

function assertThreadProjection(shared, caseMeta, index) {
  const expected = caseMeta.expected.threadProjection;
  const actual = shared
    .listPartThreadsFromIndex(index, expected.address)
    .map(normalizeThreadSummary);

  assert(
    JSON.stringify(actual) === JSON.stringify(expected.summaries),
    `${caseMeta.id}: thread summaries drifted\nexpected: ${JSON.stringify(expected.summaries)}\nactual: ${JSON.stringify(actual)}`
  );
}

async function bundleModule(outputName) {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "augment-check-"));
  const entryPoint = path.join(bundleDir, "messaging-entry.ts");
  const outfile = path.join(bundleDir, outputName);

  fs.writeFileSync(
    entryPoint,
    [
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "contracts.ts"))};`,
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "address.ts"))};`,
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "layout.ts"))};`,
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "document.ts"))};`,
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "mutations.ts"))};`,
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "projections.ts"))};`,
    ].join("\n")
  );

  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    metafile: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });

  const repoInputs = assertMessagingBundleInputs(
    "shared-domain messaging projections",
    result.metafile,
    messagingRepoInputs
  );

  return { bundleDir, outfile, repoInputs };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { bundleDir, outfile, repoInputs } = await bundleModule("shared-domain-projections.cjs");

  try {
    const shared = require(outfile);
    const positiveIds = [];
    const negativeIds = [];

    for (const caseMeta of manifest.cases) {
      const messages = caseMeta.messages.map((fixtureMeta) =>
        readFixture(shared, caseMeta, fixtureMeta, "message")
      );
      const events = caseMeta.events.map((fixtureMeta) =>
        readFixture(shared, caseMeta, fixtureMeta, "event")
      );
      const index = shared.buildBusIndex({ messages, events });

      assertLifecycle(caseMeta, index);
      assertUnread(shared, caseMeta, index);
      assertThreadProjection(shared, caseMeta, index);

      if (caseMeta.status === "positive") {
        positiveIds.push(caseMeta.id);
      } else {
        negativeIds.push(caseMeta.id);
      }
    }

    console.log("shared-domain messaging projections check passed.");
    console.log(`  positive fixtures: ${positiveIds.join(", ")}`);
    console.log(`  negative fixtures: ${negativeIds.join(", ")}`);
    console.log(`  bundle inputs: ${repoInputs.join(", ")}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
