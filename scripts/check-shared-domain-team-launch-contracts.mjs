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

function makeMember(roleId, isLead = false) {
  return { roleId, isLead };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { bundleDir, outfile } = await bundleModule(
    path.join(repoRoot, "packages", "shared-domain", "src", "index.ts"),
    "shared-domain-team-launch-contracts.cjs"
  );

  try {
    const shared = require(outfile);

    assert(Array.isArray(shared.CC_TEAM_COLOR_PALETTE), "color palette should be exported");
    assert(typeof shared.buildManagedTeamId === "function", "buildManagedTeamId should be exported");
    assert(typeof shared.buildCCNativeTeamName === "function", "buildCCNativeTeamName should be exported");
    assert(typeof shared.buildCCAgentId === "function", "buildCCAgentId should be exported");
    assert(typeof shared.resolveCCColor === "function", "resolveCCColor should be exported");
    assert(typeof shared.computeTeamLayout === "function", "computeTeamLayout should be exported");
    assert(typeof shared.buildCCTeamConfigContract === "function", "buildCCTeamConfigContract should be exported");

    const ceo = makeMember("ceo", true);
    const eng = makeMember("eng");
    const product = makeMember("product");
    const design = makeMember("design");
    const qa = makeMember("qa");
    const cs = makeMember("customer-success");
    const values = makeMember("values");
    const visionary = makeMember("visionary");

    const project = {
      projectId: "augment-plugin",
      projectDisplayName: " Augment Plugin ",
      ceo,
      members: [eng, ceo, product, design, qa, cs, values, visionary],
    };

    const launchedAt = new Date(2026, 2, 12, 1, 2, 3, 456);
    const expectedTimestamp = "2026-03-12-010203-456";

    assert(
      shared.formatLaunchTimestamp(launchedAt) === expectedTimestamp,
      `unexpected launch timestamp: ${shared.formatLaunchTimestamp(launchedAt)}`
    );
    assert(
      shared.buildManagedTeamId(project, launchedAt) === `augment-plugin::Augment%20Plugin::${expectedTimestamp}`,
      `unexpected managed team id: ${shared.buildManagedTeamId(project, launchedAt)}`
    );
    const fallbackDisplayNameProject = {
      ...project,
      projectDisplayName: "   ",
    };
    assert(
      shared.buildManagedTeamId(fallbackDisplayNameProject, launchedAt) === `augment-plugin::augment-plugin::${expectedTimestamp}`,
      `unexpected managed team id fallback: ${shared.buildManagedTeamId(fallbackDisplayNameProject, launchedAt)}`
    );
    assert(
      shared.buildCCNativeTeamName(project, launchedAt) === `augment-plugin-${expectedTimestamp}`,
      `unexpected CC native team name: ${shared.buildCCNativeTeamName(project, launchedAt)}`
    );
    assert(
      shared.buildCCAgentId(product, "augment-plugin-team") === "product@augment-plugin-team",
      `unexpected agent id: ${shared.buildCCAgentId(product, "augment-plugin-team")}`
    );

    const orderedMembers = shared.orderedProjectMembers(project);
    assert(orderedMembers[0] === ceo, "CEO should be first in orderedProjectMembers");
    assert(orderedMembers.slice(1).map((member) => member.roleId).join(",") === "eng,product,design,qa,customer-success,values,visionary", "orderedProjectMembers should preserve non-CEO order");

    assert(shared.resolveCCColor(project, ceo) === "blue", "CEO should get the first palette color");
    assert(shared.resolveCCColor(project, eng) === "green", "second ordered member should get the second palette color");
    assert(shared.resolveCCColor(project, visionary) === "blue", "palette should wrap by modulo");
    assert(shared.resolveCCColor(project, makeMember("missing")) === "blue", "missing member should fall back to the first palette color");

    const layout = shared.computeTeamLayout([eng, ceo, product, design, qa]);
    assert(layout.length === 5, `unexpected layout size: ${layout.length}`);
    assert(layout[0].member === ceo && layout[0].column === 0 && layout[0].row === 0, "lead member should anchor column 0 row 0");
    assert(layout[1].member === eng && layout[1].column === 1 && layout[1].row === 0, "first non-lead should land in middle column");
    assert(layout[2].member === product && layout[2].column === 1 && layout[2].row === 1, "middle column should stack first half of the roster");
    assert(layout[3].member === design && layout[3].column === 2 && layout[3].row === 0, "right column should start with the second half");
    assert(layout[4].member === qa && layout[4].column === 2 && layout[4].row === 1, "right column should preserve roster order");

    const fallbackLayout = shared.computeTeamLayout([eng, product, design]);
    assert(fallbackLayout[0].member === eng, "first member should anchor the layout when no lead exists");

    const config = shared.buildCCTeamConfigContract(
      project,
      "augment-plugin-team",
      "leader-session-123",
      {
        cwd: "/tmp/augment-plugin",
        joinedAt: 1700000000000,
      }
    );

    assert(config.name === "augment-plugin-team", "config should preserve team name");
    assert(config.leadAgentId === "ceo@augment-plugin-team", `unexpected lead agent id: ${config.leadAgentId}`);
    assert(config.leadSessionId === "leader-session-123", "config should preserve leader session id");
    assert(config.members.length === 8, `unexpected config member count: ${config.members.length}`);
    assert(config.members.map((member) => member.name).join(",") === "ceo,eng,product,design,qa,customer-success,values,visionary", "config members should use ordered project members");

    const [leadConfig, memberConfig] = config.members;
    assert(leadConfig.agentType === "team-lead", "lead config should use team-lead agent type");
    assert(leadConfig.model === "claude-opus-4-6", "lead config should use the lead model");
    assert(leadConfig.joinedAt === 1700000000000, "lead config should preserve joinedAt");
    assert(leadConfig.tmuxPaneId === "", "lead config should start with an empty tmux pane id");
    assert(leadConfig.cwd === "/tmp/augment-plugin", "lead config should preserve cwd");
    assert(Array.isArray(leadConfig.subscriptions) && leadConfig.subscriptions.length === 0, "lead config should start with empty subscriptions");

    assert(memberConfig.agentType === "eng", "non-lead config should use the member role id as agent type");
    assert(memberConfig.model === "claude-sonnet-4-6", "non-lead config should use the member model");

    console.log("shared-domain team-launch contracts check passed.");
    console.log(`  managed team id: ${shared.buildManagedTeamId(project, launchedAt)}`);
    console.log(`  cc native team name: ${shared.buildCCNativeTeamName(project, launchedAt)}`);
    console.log(`  config members: ${config.members.length}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
