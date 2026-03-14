import fs from "fs";
import os from "os";
import path from "path";
import { connect, waitForPlugin } from "../connect.mjs";

const PARTS_MD = `# Augment dummy team

## Project identity

Augment dummy team is a lightweight sandbox for testing Augment team launch flows.

## Code root

\`/Users/mattobrien/Development/augment-dummy-team\`

## Roster

| Part | Directory | Owns | Perspective |
|------|-----------|------|-------------|
| CEO | \`ceo/\` | Session management, launch verification, routing | "Did the test team boot cleanly? What broke in the launch flow?" |
| Product | \`product/\` | Test-surface scope, user-facing launch behavior | "Does this dummy team make the prototype easier and safer to test?" |
| Eng | \`eng/\` | Boot mechanics, repo shape, build sanity | "Does the launch path work against a tiny project root?" |
`;

const LAUNCH_CONFIG = JSON.stringify(
  {
    managedLaunchModel: "haiku",
    ccLaunchModel: "haiku",
  },
  null,
  2
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  console.log("Augment team-launch smoke");
  console.log("────────────────────────");

  const { page, close } = await connect();
  const consoleErrors = [];

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!text.includes("ResizeObserver loop") && !text.includes("net::ERR_FILE_NOT_FOUND")) {
      consoleErrors.push(text);
    }
  });

  try {
    const trustButton = page.locator('button:has-text("Trust author and enable plugins")');
    if (await trustButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await trustButton.click();
      await page.waitForTimeout(3_000);
    }

    await waitForPlugin(page, 15_000);

    const nodeSupport = await page.evaluate(() => ({
      hasProcess: typeof process !== "undefined",
      hasRequire: typeof require !== "undefined" || typeof window.require !== "undefined",
    }));
    assert(nodeSupport.hasProcess, "Electron page has no process object");
    assert(nodeSupport.hasRequire, "Electron page has no require/window.require");

    const managed = await page.evaluate(
      async ({ partsMd, launchConfig }) => {
        const plugin = window.app.plugins.plugins["augment-terminal"];
        const workspace = window.app.workspace;
        const adapter = window.app.vault.adapter;
        const nodeRequire = typeof require === "function" ? require : window.require;
        const fs = nodeRequire("fs");
        const path = nodeRequire("path");
        const basePath = adapter.basePath;
        const hooksDir = path.join(basePath, "claude", "hooks");
        const busDir = path.join(basePath, "test-bus");

        async function ensureFolder(folder) {
          try {
            await window.app.vault.createFolder(folder);
          } catch {
            // Folder already exists.
          }
        }

        await ensureFolder("agents");
        await ensureFolder("agents/parts");
        await ensureFolder("agents/parts/augment-dummy-team");
        await ensureFolder("claude");
        await ensureFolder("claude/hooks");
        await adapter.write("agents/parts/augment-dummy-team/PARTS.md", partsMd);
        await adapter.write("agents/parts/augment-dummy-team/launch-config.json", launchConfig);
        fs.mkdirSync(busDir, { recursive: true });
        fs.writeFileSync(
          path.join(hooksDir, "inbox-check.sh"),
          `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR=${JSON.stringify(busDir)}
ADDRESS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --address)
      ADDRESS="\${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "$ADDRESS" ]]; then
  FILE="\${STATE_DIR}/\${ADDRESS}.txt"
  if [[ -f "$FILE" ]]; then
    cat "$FILE"
    : > "$FILE"
  fi
fi
`,
          "utf8"
        );
        fs.chmodSync(path.join(hooksDir, "inbox-check.sh"), 0o755);

        const leafProto = Object.getPrototypeOf(workspace.getLeaf("tab"));
        const originalSetViewState = leafProto.setViewState;
        const queuedInputs = [];
        const runtimeWrites = [];
        const previousInterval = process.env.AUGMENT_BUS_POLL_INTERVAL;

        leafProto.setViewState = async function (...args) {
          const result = await originalSetViewState.apply(this, args);
          const state = args[0];
          if (state?.type === "augment-terminal" && this.view) {
            this.view.enqueueInitialInput = (data) => {
              queuedInputs.push({
                roleId: this.view.getManagedRoleId?.() ?? null,
                managedTeamId: this.view.getManagedTeamId?.() ?? null,
                data,
              });
            };
            const captureRuntimeWrite = (data) => {
              runtimeWrites.push({
                roleId: this.view.getManagedRoleId?.() ?? null,
                managedTeamId: this.view.getManagedTeamId?.() ?? null,
                data,
              });
            };
            this.view.write = captureRuntimeWrite;
            this.view.appendSystemOutput = captureRuntimeWrite;
          }
          return result;
        };

        try {
          process.env.AUGMENT_BUS_POLL_INTERVAL = "25";
          await plugin.launchProjectTeam("augment-dummy-team", "Managed smoke");
          await new Promise((resolve) => setTimeout(resolve, 150));

          const terminals = workspace.getLeavesOfType("augment-terminal").map((leaf) => ({
            roleId: leaf.view.getManagedRoleId?.() ?? null,
            managedTeamId: leaf.view.getManagedTeamId?.() ?? null,
          }));

          fs.writeFileSync(path.join(busDir, "ceo@augment-dummy-team.txt"), "bus message one\n", "utf8");
          await new Promise((resolve) => setTimeout(resolve, 150));

          const teamId = terminals[0]?.managedTeamId ?? null;
          if (teamId) {
            await plugin.shutdownManagedTeam(teamId);
          }

          const writesAfterShutdown = runtimeWrites.length;
          fs.writeFileSync(path.join(busDir, "ceo@augment-dummy-team.txt"), "bus message two\n", "utf8");
          await new Promise((resolve) => setTimeout(resolve, 150));

          return {
            terminals,
            queuedInputs,
            runtimeWrites,
            writesAfterShutdown,
          };
        } finally {
          if (previousInterval === undefined) {
            delete process.env.AUGMENT_BUS_POLL_INTERVAL;
          } else {
            process.env.AUGMENT_BUS_POLL_INTERVAL = previousInterval;
          }
          leafProto.setViewState = originalSetViewState;
          workspace.detachLeavesOfType("augment-terminal");
        }
      },
      { partsMd: PARTS_MD, launchConfig: LAUNCH_CONFIG }
    );

    assert(managed.terminals.length === 3, `managed launch expected 3 terminals, saw ${managed.terminals.length}`);
    assert(managed.queuedInputs.length === 3, `managed launch expected 3 queued inputs, saw ${managed.queuedInputs.length}`);
    assert(managed.runtimeWrites.length >= 1, "managed launch bus poller did not inject any runtime writes");
    assert(
      managed.terminals.every((entry) => typeof entry.managedTeamId === "string" && entry.managedTeamId.length > 0),
      "managed launch terminals missing managedTeamId"
    );
    assert(
      managed.runtimeWrites.some(
        (entry) =>
          entry.roleId === "ceo" &&
          typeof entry.data === "string" &&
          entry.data.includes("bus message one")
      ),
      "managed launch did not inject the seeded bus message into the CEO terminal"
    );
    assert(
      managed.runtimeWrites.length === managed.writesAfterShutdown,
      "managed launch still injected messages after shutdownManagedTeam()"
    );

    console.log(`  ✓ Managed launch created ${managed.terminals.length} terminals`);
    console.log("  ✓ Managed launch injected a live bus message into the CEO terminal and stopped reinjection after shutdown");

    const ccNative = await page.evaluate(
      async ({ partsMd, launchConfig, tempHomePrefix }) => {
        const plugin = window.app.plugins.plugins["augment-terminal"];
        const workspace = window.app.workspace;
        const adapter = window.app.vault.adapter;
        const nodeRequire = typeof require === "function" ? require : window.require;
        const fs = nodeRequire("fs");
        const os = nodeRequire("os");
        const path = nodeRequire("path");

        async function ensureFolder(folder) {
          try {
            await window.app.vault.createFolder(folder);
          } catch {
            // Folder already exists.
          }
        }

        await ensureFolder("agents");
        await ensureFolder("agents/parts");
        await ensureFolder("agents/parts/augment-dummy-team");
        await adapter.write("agents/parts/augment-dummy-team/PARTS.md", partsMd);
        await adapter.write("agents/parts/augment-dummy-team/launch-config.json", launchConfig);

        const leafProto = Object.getPrototypeOf(workspace.getLeaf("tab"));
        const originalSetViewState = leafProto.setViewState;
        const recordedInputs = [];
        const previousHome = process.env.HOME;
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), tempHomePrefix));

        leafProto.setViewState = async function (...args) {
          const result = await originalSetViewState.apply(this, args);
          const state = args[0];
          if (state?.type === "augment-terminal" && this.view) {
            this.view.enqueueInitialInput = (data) => {
              recordedInputs.push({
                roleId: this.view.getManagedRoleId?.() ?? null,
                managedTeamId: this.view.getManagedTeamId?.() ?? null,
                data,
              });
            };
          }
          return result;
        };

        try {
          process.env.HOME = tempHome;
          await plugin.launchCCProjectTeam("augment-dummy-team", "CC native smoke");
          await new Promise((resolve) => setTimeout(resolve, 250));

          const terminals = workspace.getLeavesOfType("augment-terminal").map((leaf) => ({
            roleId: leaf.view.getManagedRoleId?.() ?? null,
            managedTeamId: leaf.view.getManagedTeamId?.() ?? null,
          }));

          const teamsRoot = path.join(tempHome, ".claude", "teams");
          const teamNames = fs.existsSync(teamsRoot) ? fs.readdirSync(teamsRoot) : [];
          const teamName = teamNames[0] ?? null;
          const teamDir = teamName ? path.join(teamsRoot, teamName) : null;
          const configPath = teamDir ? path.join(teamDir, "config.json") : null;
          const inboxDir = teamDir ? path.join(teamDir, "inboxes") : null;
          const inboxFiles = inboxDir && fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).sort() : [];
          const inboxSizes = Object.fromEntries(
            inboxFiles.map((file) => {
              const fullPath = path.join(inboxDir, file);
              const messages = JSON.parse(fs.readFileSync(fullPath, "utf8"));
              return [file, Array.isArray(messages) ? messages.length : -1];
            })
          );

          return {
            terminals,
            recordedInputs,
            teamName,
            configExists: Boolean(configPath && fs.existsSync(configPath)),
            inboxFiles,
            inboxSizes,
          };
        } finally {
          process.env.HOME = previousHome;
          leafProto.setViewState = originalSetViewState;
          workspace.detachLeavesOfType("augment-terminal");
          fs.rmSync(tempHome, { recursive: true, force: true });
        }
      },
      { partsMd: PARTS_MD, launchConfig: LAUNCH_CONFIG, tempHomePrefix: "augment-cc-team-smoke-" }
    );

    assert(ccNative.terminals.length === 3, `CC-native launch expected 3 terminals, saw ${ccNative.terminals.length}`);
    assert(ccNative.recordedInputs.length === 3, `CC-native launch expected 3 queued commands, saw ${ccNative.recordedInputs.length}`);
    assert(
      ccNative.terminals.every(
        (entry) => typeof entry.managedTeamId === "string" && entry.managedTeamId.startsWith("cc-native-team::")
      ),
      "CC-native terminals missing cc-native managedTeamId"
    );
    assert(ccNative.teamName, "CC-native launch did not create a team directory");
    assert(ccNative.configExists, "CC-native launch did not write config.json");
    assert(ccNative.inboxFiles.length === 3, `CC-native launch expected 3 inbox files, saw ${ccNative.inboxFiles.length}`);
    assert(
      Object.values(ccNative.inboxSizes).every((count) => count === 1),
      `CC-native launch expected one seed message per inbox, saw ${JSON.stringify(ccNative.inboxSizes)}`
    );

    console.log(`  ✓ CC-native launch created ${ccNative.terminals.length} terminals`);
    console.log(`  ✓ CC-native launch wrote ${ccNative.inboxFiles.length} seeded inbox files`);

    await page.waitForTimeout(500);
    assert(consoleErrors.length === 0, `Unexpected console errors:\n${consoleErrors.join("\n")}`);
    console.log("  ✓ No unexpected console errors");
  } finally {
    await close();
  }

  console.log("────────────────────────");
  console.log("Team-launch smoke passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
