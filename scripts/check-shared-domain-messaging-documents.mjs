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
const fixturesRoot = path.join(repoRoot, "packages", "shared-domain", "fixtures", "messaging", "v1");
const manifestPath = path.join(fixturesRoot, "manifest.json");
const messagingRepoInputs = [
  "packages/shared-domain/src/messaging/contracts.ts",
  "packages/shared-domain/src/messaging/address.ts",
  "packages/shared-domain/src/messaging/layout.ts",
  "packages/shared-domain/src/messaging/document.ts",
  "packages/shared-domain/src/messaging/mutations.ts",
];
const forbiddenRepoInputLabels = [
  ["packages/shared-domain/src/index.ts", "shared-domain barrel"],
  ["packages/shared-domain/src/runtime/", "runtime/*"],
  ["packages/shared-domain/src/launch/", "launch/*"],
  ["src/", "plugin-host"],
];

const MESSAGE_TYPES = new Set(["message", "request", "response", "error"]);
const EVENT_TYPES = new Set(["delivered", "read", "acked"]);
const MESSAGE_BASE_KEYS = [
  "msg_id",
  "thread_id",
  "from",
  "to",
  "msg_type",
  "subject",
  "created_at",
  "habitat",
  "privacy",
];
const EVENT_BASE_KEYS = ["event_id", "msg_id", "thread_id", "event_type", "actor", "created_at"];
const ADDRESS_RE = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/;

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

function asString(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeContent(raw) {
  return raw.replace(/\r\n/g, "\n").trimEnd();
}

function pathLane(busPath) {
  const match = busPath.match(/^agents\/bus\/(local|shared)\//);
  assert(match, `fixture path is outside the canonical bus root: ${busPath}`);
  return match[1];
}

function hasExactKeys(frontmatter, expectedKeys) {
  const actual = Object.keys(frontmatter).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalAddress(value) {
  return ADDRESS_RE.test(value);
}

function messageFrontmatterKeys(shape) {
  return shape === "reply" ? [...MESSAGE_BASE_KEYS, "reply_to"] : MESSAGE_BASE_KEYS;
}

function eventFrontmatterKeys(caseMeta) {
  return caseMeta.hasVia ? [...EVENT_BASE_KEYS, "via"] : EVENT_BASE_KEYS;
}

function classifyMessageCase(shared, caseMeta, frontmatter) {
  if (!frontmatter) return "missing-stable-field";

  const requiredKeys = messageFrontmatterKeys(caseMeta.shape);
  const missingRequiredKey = requiredKeys.find((key) => !asString(frontmatter[key]));
  if (missingRequiredKey) {
    return caseMeta.shape === "reply" && missingRequiredKey === "reply_to"
      ? "invalid-reply-law"
      : "missing-stable-field";
  }

  const from = asString(frontmatter.from);
  const to = asString(frontmatter.to);
  if (!isCanonicalAddress(from) || !isCanonicalAddress(to)) {
    return "invalid-address";
  }

  if (!MESSAGE_TYPES.has(asString(frontmatter.msg_type))) {
    return "invalid-message-enum";
  }

  const lane = pathLane(caseMeta.busPath);
  if (asString(frontmatter.privacy) !== lane) {
    return "invalid-path-privacy-law";
  }

  const msgId = asString(frontmatter.msg_id);
  const threadId = asString(frontmatter.thread_id);

  if (caseMeta.shape === "root" && threadId !== msgId) {
    return "invalid-root-thread-law";
  }

  const expectedPath = shared.messageFilePath(lane, asString(frontmatter.created_at), msgId);
  if (shared.normalizeVaultPath(caseMeta.busPath) !== expectedPath) {
    return "invalid-filename-law";
  }

  return null;
}

function classifyEventCase(shared, caseMeta, frontmatter) {
  if (!frontmatter) return "missing-stable-field";

  const missingRequiredKey = EVENT_BASE_KEYS.find((key) => !asString(frontmatter[key]));
  if (missingRequiredKey) {
    return "missing-stable-field";
  }

  if (!isCanonicalAddress(asString(frontmatter.actor))) {
    return "invalid-address";
  }

  if (!EVENT_TYPES.has(asString(frontmatter.event_type))) {
    return "invalid-event-enum";
  }

  const lane = pathLane(caseMeta.busPath);
  const expectedPath = shared.eventFilePath(
    lane,
    asString(frontmatter.created_at),
    asString(frontmatter.event_type),
    asString(frontmatter.msg_id),
    asString(frontmatter.event_id)
  );
  if (shared.normalizeVaultPath(caseMeta.busPath) !== expectedPath) {
    return "invalid-filename-law";
  }

  return null;
}

function assertPositiveCase(shared, caseMeta, rawContent, frontmatter) {
  assert(frontmatter, `${caseMeta.id}: fixture frontmatter should parse`);

  if (caseMeta.kind === "message") {
    assert(
      classifyMessageCase(shared, caseMeta, frontmatter) === null,
      `${caseMeta.id}: positive message fixture violated the frozen contract`
    );
    assert(
      hasExactKeys(frontmatter, messageFrontmatterKeys(caseMeta.shape)),
      `${caseMeta.id}: frontmatter keys drifted from the frozen envelope`
    );

    const parsed = shared.parseIndexedMessageRecord(frontmatter, caseMeta.busPath, caseMeta.privacy);
    assert(parsed, `${caseMeta.id}: shared parser should accept the positive message fixture`);
    assert(parsed.msgId === asString(frontmatter.msg_id), `${caseMeta.id}: parsed message id mismatch`);
    assert(parsed.threadId === asString(frontmatter.thread_id), `${caseMeta.id}: parsed thread id mismatch`);
    assert(parsed.from === asString(frontmatter.from), `${caseMeta.id}: parsed sender mismatch`);
    assert(parsed.to === asString(frontmatter.to), `${caseMeta.id}: parsed recipient mismatch`);
    assert(parsed.msgType === asString(frontmatter.msg_type), `${caseMeta.id}: parsed message type mismatch`);
    assert(parsed.habitat === asString(frontmatter.habitat), `${caseMeta.id}: parsed habitat mismatch`);
    assert(parsed.privacy === caseMeta.privacy, `${caseMeta.id}: parsed privacy mismatch`);

    const body = shared.stripFrontmatter(rawContent).trim();
    assert(body === caseMeta.expectedBody, `${caseMeta.id}: body mismatch`);
  } else {
    assert(
      classifyEventCase(shared, caseMeta, frontmatter) === null,
      `${caseMeta.id}: positive event fixture violated the frozen contract`
    );
    assert(
      hasExactKeys(frontmatter, eventFrontmatterKeys(caseMeta)),
      `${caseMeta.id}: event frontmatter keys drifted from the frozen envelope`
    );

    const parsed = shared.parseIndexedEventRecord(frontmatter, caseMeta.busPath, caseMeta.privacy);
    assert(parsed, `${caseMeta.id}: shared parser should accept the positive event fixture`);
    assert(parsed.eventType === asString(frontmatter.event_type), `${caseMeta.id}: parsed event type mismatch`);
    assert(parsed.msgId === asString(frontmatter.msg_id), `${caseMeta.id}: parsed event message id mismatch`);
    assert(parsed.actor === asString(frontmatter.actor), `${caseMeta.id}: parsed actor mismatch`);
    assert(parsed.privacy === caseMeta.privacy, `${caseMeta.id}: parsed event privacy mismatch`);
  }
}

function assertNegativeCase(shared, caseMeta, frontmatter) {
  const actualClass =
    caseMeta.kind === "message"
      ? classifyMessageCase(shared, caseMeta, frontmatter)
      : classifyEventCase(shared, caseMeta, frontmatter);

  assert(
    actualClass === caseMeta.expectedClass,
    `${caseMeta.id}: expected ${caseMeta.expectedClass}, saw ${actualClass ?? "no failure"}`
  );
}

function assertPlanProof(shared, caseMeta, rawContent) {
  if (!caseMeta.plan) return false;

  if (caseMeta.plan.kind === "message") {
    const plan = shared.planMessageWrite(caseMeta.plan.opts, caseMeta.plan.options);
    assert(plan.filePath === caseMeta.busPath, `${caseMeta.id}: message plan path drifted`);
    assert(
      plan.signalPath === caseMeta.plan.expectedSignalPath,
      `${caseMeta.id}: message signal path drifted`
    );
    assert(
      normalizeContent(plan.content) === normalizeContent(rawContent),
      `${caseMeta.id}: message plan content drifted from the frozen fixture`
    );
    return true;
  }

  if (caseMeta.plan.kind === "event") {
    const plan = shared.planEventWrite(
      caseMeta.plan.message,
      caseMeta.plan.eventType,
      caseMeta.plan.actor,
      caseMeta.plan.options
    );
    assert(plan.filePath === caseMeta.busPath, `${caseMeta.id}: event plan path drifted`);
    assert(
      normalizeContent(plan.content) === normalizeContent(rawContent),
      `${caseMeta.id}: event plan content drifted from the frozen fixture`
    );
    return true;
  }

  throw new Error(`${caseMeta.id}: unknown plan kind ${caseMeta.plan.kind}`);
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
    "shared-domain messaging documents",
    result.metafile,
    messagingRepoInputs
  );

  return { bundleDir, outfile, repoInputs };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { bundleDir, outfile, repoInputs } = await bundleModule("shared-domain-documents.cjs");

  try {
    const shared = require(outfile);
    const positiveIds = [];
    const negativeIds = [];
    const builderProofIds = [];

    for (const caseMeta of manifest.cases) {
      const fixturePath = path.join(fixturesRoot, caseMeta.fixture);
      const rawContent = fs.readFileSync(fixturePath, "utf8");
      const frontmatter = shared.parseRawFrontmatter(rawContent);

      if (caseMeta.status === "positive") {
        assertPositiveCase(shared, caseMeta, rawContent, frontmatter);
        positiveIds.push(caseMeta.id);
      } else {
        assertNegativeCase(shared, caseMeta, frontmatter);
        negativeIds.push(`${caseMeta.id}:${caseMeta.expectedClass}`);
      }

      if (assertPlanProof(shared, caseMeta, rawContent)) {
        builderProofIds.push(caseMeta.id);
      }
    }

    console.log("shared-domain messaging documents check passed.");
    console.log(`  positive fixtures: ${positiveIds.join(", ")}`);
    console.log(`  negative fixtures: ${negativeIds.join(", ")}`);
    console.log(`  builder proofs: ${builderProofIds.join(", ")}`);
    console.log(`  bundle inputs: ${repoInputs.join(", ")}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
