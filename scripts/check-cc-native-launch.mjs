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
    path.join(repoRoot, "src", "team-launch.ts"),
    "team-launch.cjs"
  );

  const {
    buildCCNativeTeamLaunchSpec,
    writeCCTeamScaffolding,
    seedCCInboxMessage,
  } = require(outfile);

  const project = {
    projectId: "augment-dummy-team",
    projectDisplayName: "Augment dummy team",
    partsMdPath: "agents/parts/augment-dummy-team/PARTS.md",
    workspacePath: "agents/parts/augment-dummy-team",
    codeRoot: "/Users/mattobrien/Development/augment-dummy-team",
    managedLaunchModel: "haiku",
    ccLaunchModel: "haiku",
    members: [
      {
        roleId: "ceo",
        displayName: "CEO",
        directory: "ceo/",
        owns: "Session management, launch verification, routing",
        perspective: "Did the test team boot cleanly? What broke in the launch flow?",
        address: "ceo@augment-dummy-team",
        workspacePath: "agents/parts/augment-dummy-team/ceo",
        isLead: true,
      },
      {
        roleId: "product",
        displayName: "Product",
        directory: "product/",
        owns: "Test-surface scope, user-facing launch behavior",
        perspective: "Does this dummy team make the prototype easier and safer to test?",
        address: "product@augment-dummy-team",
        workspacePath: "agents/parts/augment-dummy-team/product",
        isLead: false,
      },
      {
        roleId: "eng",
        displayName: "Eng",
        directory: "eng/",
        owns: "Boot mechanics, repo shape, build sanity",
        perspective: "Does the launch path work against a tiny project root?",
        address: "eng@augment-dummy-team",
        workspacePath: "agents/parts/augment-dummy-team/eng",
        isLead: false,
      },
    ],
  };
  project.ceo = project.members[0];

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "augment-cc-native-home-"));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = tempHome;

    const spec = buildCCNativeTeamLaunchSpec(
      project,
      project.codeRoot,
      "/Users/mattobrien/Obsidian Main Vault/ObsidianVault",
      "Smoke test brief"
    );

    assert(typeof spec.teamName === "string" && spec.teamName.length > 0, "teamName missing");
    assert(
      typeof spec.leaderSessionId === "string" && spec.leaderSessionId.length > 0,
      "leaderSessionId missing"
    );
    assert(Array.isArray(spec.memberCommands) && spec.memberCommands.length === 3, "expected 3 member commands");

    for (const entry of spec.memberCommands) {
      assert(entry.member?.roleId, "member roleId missing");
      assert(entry.cwd === project.codeRoot, `cwd mismatch for ${entry.member.roleId}`);
      assert(
        typeof entry.bootPromptText === "string" && entry.bootPromptText.trim().length > 0,
        `bootPromptText missing for ${entry.member.roleId}`
      );
      assert(
        typeof entry.command === "string" &&
          entry.command.includes("claude") &&
          entry.command.includes("--team-name"),
        `command missing CC launch flags for ${entry.member.roleId}`
      );
    }

    const teamDir = path.join(tempHome, ".claude", "teams", spec.teamName);
    assert(!fs.existsSync(teamDir), "buildCCNativeTeamLaunchSpec should not write team scaffolding");

    writeCCTeamScaffolding(spec.teamName, spec.config);
    for (const entry of spec.memberCommands) {
      seedCCInboxMessage(spec.teamName, entry.member.roleId, "augment", entry.bootPromptText);
    }

    const configPath = path.join(teamDir, "config.json");
    const inboxDir = path.join(teamDir, "inboxes");
    assert(fs.existsSync(configPath), "config.json missing after writeCCTeamScaffolding");
    assert(fs.existsSync(inboxDir), "inboxes directory missing after writeCCTeamScaffolding");

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert(Array.isArray(config.members) && config.members.length === 3, "config members mismatch");

    for (const entry of spec.memberCommands) {
      const inboxPath = path.join(inboxDir, `${entry.member.roleId}.json`);
      assert(fs.existsSync(inboxPath), `inbox missing for ${entry.member.roleId}`);
      const messages = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
      assert(Array.isArray(messages) && messages.length === 1, `expected 1 seed message for ${entry.member.roleId}`);
      assert(messages[0]?.text === entry.bootPromptText, `seed message text mismatch for ${entry.member.roleId}`);
    }

    console.log("CC native launch contract check passed.");
    console.log(`  teamName: ${spec.teamName}`);
    console.log(`  members: ${spec.memberCommands.map((entry) => entry.member.roleId).join(", ")}`);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
