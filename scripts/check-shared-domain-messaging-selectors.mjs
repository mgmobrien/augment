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

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixturesRoot = path.join(
  repoRoot,
  "packages",
  "shared-domain",
  "fixtures",
  "messaging",
  "v1",
  "selectors"
);
const manifestPath = path.join(fixturesRoot, "manifest.json");

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

function normalizeSelectorSummary(summary) {
  return {
    threadId: summary.threadId,
    counterparty: summary.counterparty,
    participants: summary.participants,
    humanInvolved: summary.humanInvolved,
    lastActivityAt: summary.lastActivityAt,
  };
}

function assertSelectorRows(caseMeta, actualRows, expectedRows, label) {
  const actual = actualRows.map(normalizeSelectorSummary);

  assert(
    JSON.stringify(actual) === JSON.stringify(expectedRows),
    `${caseMeta.id}: ${label} selector drifted\nexpected: ${JSON.stringify(expectedRows)}\nactual: ${JSON.stringify(actual)}`
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
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "document.ts"))};`,
      `export * from ${JSON.stringify(path.join(repoRoot, "packages", "shared-domain", "src", "messaging", "projections.ts"))};`,
    ].join("\n")
  );

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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { bundleDir, outfile } = await bundleModule("shared-domain-selectors.cjs");

  try {
    const shared = require(outfile);
    const passedIds = [];

    for (const caseMeta of manifest.cases) {
      const messages = caseMeta.messages.map((fixtureMeta) =>
        readFixture(shared, caseMeta, fixtureMeta, "message")
      );
      const events = caseMeta.events.map((fixtureMeta) =>
        readFixture(shared, caseMeta, fixtureMeta, "event")
      );
      const index = shared.buildBusIndex({ messages, events });

      assertSelectorRows(
        caseMeta,
        shared.listHumanThreadsFromIndex(index),
        caseMeta.expected.humanThreads,
        "human"
      );
      assertSelectorRows(
        caseMeta,
        shared.listAllThreadsFromIndex(index, caseMeta.visibleAddresses),
        caseMeta.expected.allThreads,
        "all"
      );

      passedIds.push(caseMeta.id);
    }

    console.log("shared-domain messaging selectors check passed.");
    console.log(`  selector fixtures: ${passedIds.join(", ")}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
