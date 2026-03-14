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
    "shared-domain-team-roster-parser.cjs"
  );

  try {
    const shared = require(outfile);

    assert(typeof shared.parsePartsMd === "function", "parsePartsMd should be exported");
    assert(typeof shared.parseLaunchConfig === "function", "parseLaunchConfig should be exported");

    const validParts = `
# Augment plugin team

## Code root
\`/Users/mattobrien/Development/augment-plugin\`

## Roster
| Part | Directory | Owns | PERspective |
| --- | --- | --- | --- |
| CEO | \`ceo/\` | Routing | Whole system |
| Engineering | eng/// | Implementation | Delivery |
`;

    const parsedProject = shared.parsePartsMd(validParts, "augment-plugin");
    assert(parsedProject !== null, "valid PARTS.md should parse");
    assert(parsedProject.projectId === "augment-plugin", "project id should be preserved");
    assert(parsedProject.projectDisplayName === "Augment plugin team", "display name should come from the H1");
    assert(
      parsedProject.partsMdPath === "agents/parts/augment-plugin/PARTS.md",
      `unexpected PARTS.md path: ${parsedProject.partsMdPath}`
    );
    assert(
      parsedProject.workspacePath === "agents/parts/augment-plugin",
      `unexpected workspace path: ${parsedProject.workspacePath}`
    );
    assert(
      parsedProject.codeRoot === "/Users/mattobrien/Development/augment-plugin",
      `unexpected code root: ${parsedProject.codeRoot}`
    );
    assert(parsedProject.members.length === 2, `unexpected member count: ${parsedProject.members.length}`);
    assert(parsedProject.ceo.roleId === "ceo", `unexpected CEO role id: ${parsedProject.ceo.roleId}`);
    assert(parsedProject.ceo.directory === "`ceo/`", `unexpected CEO directory cell: ${parsedProject.ceo.directory}`);
    assert(
      parsedProject.ceo.address === "ceo@augment-plugin",
      `unexpected CEO address: ${parsedProject.ceo.address}`
    );
    assert(
      parsedProject.ceo.workspacePath === "agents/parts/augment-plugin/ceo",
      `unexpected CEO workspace path: ${parsedProject.ceo.workspacePath}`
    );
    assert(
      parsedProject.members[1].roleId === "eng",
      `unexpected normalized role id: ${parsedProject.members[1].roleId}`
    );
    assert(
      parsedProject.members[1].workspacePath === "agents/parts/augment-plugin/eng",
      `unexpected member workspace path: ${parsedProject.members[1].workspacePath}`
    );

    const missingHeaderParts = `
# Broken roster

## Roster
| Part | Directory | Owns |
| --- | --- | --- |
| CEO | ceo | Routing |
`;
    assert(
      shared.parsePartsMd(missingHeaderParts, "broken-roster") === null,
      "missing required roster header should return null"
    );

    const duplicateRoleIdParts = `
# Duplicate role ids

## Roster
| Part | Directory | Owns | Perspective |
| --- | --- | --- | --- |
| Engineering | eng/ | Build | Delivery |
| Platform | \`eng///\` | Infra | Reliability |
`;
    assert(
      shared.parsePartsMd(duplicateRoleIdParts, "duplicate-role-ids") === null,
      "duplicate normalized role ids should return null"
    );

    const fallbackLaunchConfig = shared.parseLaunchConfig(JSON.stringify({
      launchModel: "claude-sonnet-4-6",
    }));
    assert(
      fallbackLaunchConfig.managedLaunchModel === "claude-sonnet-4-6",
      `unexpected managed fallback model: ${fallbackLaunchConfig.managedLaunchModel}`
    );
    assert(
      fallbackLaunchConfig.ccLaunchModel === "claude-sonnet-4-6",
      `unexpected CC fallback model: ${fallbackLaunchConfig.ccLaunchModel}`
    );

    const explicitLaunchConfig = shared.parseLaunchConfig(JSON.stringify({
      launchModel: "bad/model",
      managedLaunchModel: " claude-opus-4-6 ",
      ccLaunchModel: "",
      ignored: 42,
    }));
    assert(
      explicitLaunchConfig.managedLaunchModel === "claude-opus-4-6",
      `unexpected managed explicit model: ${explicitLaunchConfig.managedLaunchModel}`
    );
    assert(
      explicitLaunchConfig.ccLaunchModel === null,
      `unexpected CC explicit model: ${explicitLaunchConfig.ccLaunchModel}`
    );

    const malformedLaunchConfig = shared.parseLaunchConfig("{ not json");
    assert(
      malformedLaunchConfig.managedLaunchModel === null && malformedLaunchConfig.ccLaunchModel === null,
      "malformed launch config should normalize to null models"
    );

    console.log("shared-domain team-roster parser check passed.");
    console.log(`  parsed project: ${parsedProject.projectId}`);
    console.log(`  parsed members: ${parsedProject.members.map((member) => member.roleId).join(",")}`);
    console.log(`  fallback launch model: ${fallbackLaunchConfig.managedLaunchModel}`);
  } finally {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
