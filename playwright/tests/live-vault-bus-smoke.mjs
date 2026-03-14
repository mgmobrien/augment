/**
 * Live-vault bus smoke for Augment managed terminals.
 *
 * Runs against a real Obsidian instance on a CDP port and verifies the
 * managed-team bus poller through the actual vault hooks:
 *   - one unread message lands in exactly one target terminal
 *   - the target terminal scrollback shows the delivery prompt and body
 *   - after shutdown, a new unread message remains unread
 *
 * Expected setup:
 *   1. Open a dedicated Obsidian instance on the real vault with CDP enabled.
 *   2. Leave that instance idle with no Augment terminals already open.
 *
 * Environment:
 *   AUGMENT_CDP_PORT       CDP port (default: 9224)
 *   OBSIDIAN_VAULT_PATH    expected vault path; required for safety
 *   AUGMENT_PROJECT_ID     managed project id (default: augment-dummy-team)
 *   AUGMENT_TARGET_ROLE    receiving role id (default: product)
 *   AUGMENT_SOURCE_ROLE    sending role id (default: ceo)
 *   AUGMENT_CLOSE_EXISTING_TERMINALS
 *                          set to 1 to close pre-existing Augment terminals
 *                          in the connected smoke instance before the run
 */

import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";
import { connect, waitForPlugin } from "../connect.mjs";

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z@`]/g, "")
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b[^\\])*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b[=>78DMEHNOcn]/g, "");
}

async function waitForCondition(description, predicate, timeoutMs = 10_000, intervalMs = 100) {
  const startedAt = Date.now();
  let lastValue = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await wait(intervalMs);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function runHook(vaultBase, args) {
  const hookPath = path.join(vaultBase, "claude", "hooks", args.shift());
  const { stdout, stderr } = await execFileAsync("bash", [hookPath, ...args], {
    cwd: vaultBase,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function clearInbox(vaultBase, address) {
  await runHook(vaultBase, [
    "inbox-check.sh",
    "--address",
    address,
    "--format",
    "plain",
    "--mark",
    "read",
  ]);
}

async function readInbox(vaultBase, address, mark = "none") {
  const result = await runHook(vaultBase, [
    "inbox-check.sh",
    "--address",
    address,
    "--format",
    "plain",
    "--mark",
    mark,
  ]);
  return result.stdout;
}

async function sendInboxMessage(vaultBase, to, from, subject, body) {
  await runHook(vaultBase, [
    "inbox-send.sh",
    "--to",
    to,
    "--from",
    from,
    "--subject",
    subject,
    "--body",
    body,
  ]);
}

async function installProbe(page, pollIntervalMs) {
  await page.evaluate(({ pollIntervalMs: interval }) => {
    const workspace = window.app.workspace;
    const leafProto = Object.getPrototypeOf(workspace.getLeaf("tab"));

    if (window.__augmentLiveVaultBusProbe) {
      return;
    }

    const originalSetViewState = leafProto.setViewState;
    const previousInterval = process.env.AUGMENT_BUS_POLL_INTERVAL;
    const wrappedViews = [];
    const queuedInputs = [];

    leafProto.setViewState = async function (...args) {
      const result = await originalSetViewState.apply(this, args);
      const state = args[0];

      if (state?.type === "augment-terminal" && this.view && !this.view.__augmentLiveVaultBusWrapped) {
        const view = this.view;
        const originalEnqueue =
          typeof view.enqueueInitialInput === "function" ? view.enqueueInitialInput.bind(view) : null;

        view.enqueueInitialInput = (data) => {
          queuedInputs.push({
            roleId: view.getManagedRoleId?.() ?? null,
            managedTeamId: view.getManagedTeamId?.() ?? null,
            data: String(data ?? ""),
          });
        };

        view.__augmentLiveVaultBusWrapped = true;
        view.__augmentLiveVaultBusOriginalEnqueue = originalEnqueue;
        wrappedViews.push(view);
      }

      return result;
    };

    process.env.AUGMENT_BUS_POLL_INTERVAL = String(interval);

    window.__augmentLiveVaultBusProbe = {
      getState() {
        const terminals = workspace.getLeavesOfType("augment-terminal").map((leaf) => ({
          roleId: leaf.view.getManagedRoleId?.() ?? null,
          managedTeamId: leaf.view.getManagedTeamId?.() ?? null,
          terminalName:
            typeof leaf.view.getDisplayText === "function" ? leaf.view.getDisplayText() : null,
          snapshot:
            typeof leaf.view.getState === "function" ? leaf.view.getState()?.snapshot ?? "" : "",
        }));

        return {
          queuedInputs: queuedInputs.map((entry) => ({ ...entry })),
          terminals,
        };
      },

      async cleanup() {
        for (const view of wrappedViews) {
          if (!view?.__augmentLiveVaultBusWrapped) continue;
          if (typeof view.__augmentLiveVaultBusOriginalEnqueue === "function") {
            view.enqueueInitialInput = view.__augmentLiveVaultBusOriginalEnqueue;
          }
          delete view.__augmentLiveVaultBusWrapped;
          delete view.__augmentLiveVaultBusOriginalEnqueue;
        }

        leafProto.setViewState = originalSetViewState;

        if (previousInterval === undefined) {
          delete process.env.AUGMENT_BUS_POLL_INTERVAL;
        } else {
          process.env.AUGMENT_BUS_POLL_INTERVAL = previousInterval;
        }

        workspace.detachLeavesOfType("augment-terminal");
        delete window.__augmentLiveVaultBusProbe;
      },
    };
  }, { pollIntervalMs });
}

async function getProbeState(page) {
  return page.evaluate(() => window.__augmentLiveVaultBusProbe?.getState() ?? null);
}

async function cleanupProbe(page) {
  await page.evaluate(async () => {
    await window.__augmentLiveVaultBusProbe?.cleanup?.();
  });
}

async function main() {
  const port = Number.parseInt(process.env.AUGMENT_CDP_PORT ?? "9224", 10);
  const expectedVaultBase = (process.env.OBSIDIAN_VAULT_PATH ?? "").trim();
  const projectId = (process.env.AUGMENT_PROJECT_ID ?? "augment-dummy-team").trim();
  const targetRole = (process.env.AUGMENT_TARGET_ROLE ?? "product").trim();
  const sourceRole = (process.env.AUGMENT_SOURCE_ROLE ?? "ceo").trim();
  const pollIntervalMs = Number.parseInt(process.env.AUGMENT_BUS_POLL_INTERVAL_OVERRIDE ?? "100", 10);
  const allowCloseExistingTerminals = process.env.AUGMENT_CLOSE_EXISTING_TERMINALS === "1";

  assert(expectedVaultBase, "Set OBSIDIAN_VAULT_PATH to the real vault path before running this smoke");
  assert(Number.isFinite(port) && port > 0, `Invalid AUGMENT_CDP_PORT: ${process.env.AUGMENT_CDP_PORT ?? ""}`);
  assert(Number.isFinite(pollIntervalMs) && pollIntervalMs > 0, `Invalid poll interval override: ${pollIntervalMs}`);

  const targetAddress = `${targetRole}@${projectId}`;
  const sourceAddress = `${sourceRole}@${projectId}`;
  const tokenBase = `LIVE VAULT BUS SMOKE ${Date.now()}`;
  const liveBody = `${tokenBase} DELIVERY`;
  const shutdownBody = `${tokenBase} AFTER SHUTDOWN`;
  const subject = process.env.AUGMENT_SMOKE_SUBJECT?.trim() || "live vault bus smoke";

  console.log("Augment live-vault bus smoke");
  console.log("────────────────────────────");
  console.log(`  CDP port: ${port}`);
  console.log(`  Vault: ${expectedVaultBase}`);
  console.log(`  Project: ${projectId}`);
  console.log(`  Route: ${sourceAddress} -> ${targetAddress}`);

  const { page, close } = await connect(port);
  const consoleErrors = [];
  let cleanupNeeded = false;

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
    console.log("  ✓ Plugin loaded");

    const preflight = await page.evaluate(() => {
      const adapter = window.app.vault.adapter;
      const workspace = window.app.workspace;
      const plugin = window.app.plugins.plugins["augment-terminal"];
      const terminals = workspace.getLeavesOfType("augment-terminal").map((leaf) => ({
        roleId: leaf.view.getManagedRoleId?.() ?? null,
        managedTeamId: leaf.view.getManagedTeamId?.() ?? null,
      }));

      return {
        vaultBase: adapter.basePath,
        pluginLoaded: Boolean(plugin),
        terminalCount: terminals.length,
        terminals,
      };
    });

    assert(preflight.pluginLoaded, "Augment plugin is not loaded in the connected Obsidian instance");
    assert(
      preflight.vaultBase === expectedVaultBase,
      `Connected vault mismatch. Expected ${expectedVaultBase}, saw ${preflight.vaultBase}`
    );
    if (preflight.terminalCount > 0) {
      assert(
        allowCloseExistingTerminals,
        `Connected instance already has ${preflight.terminalCount} Augment terminal(s) open; re-run with AUGMENT_CLOSE_EXISTING_TERMINALS=1 in the dedicated smoke instance`
      );

      const closedCount = await page.evaluate(() => {
        const workspace = window.app.workspace;
        const count = workspace.getLeavesOfType("augment-terminal").length;
        workspace.detachLeavesOfType("augment-terminal");
        return count;
      });
      await page.waitForTimeout(250);

      const remainingTerminalCount = await page.evaluate(() => window.app.workspace.getLeavesOfType("augment-terminal").length);
      assert(remainingTerminalCount === 0, `Failed to clear pre-existing Augment terminals; ${remainingTerminalCount} remain open`);
      console.log(`  ✓ Closed ${closedCount} pre-existing Augment terminal(s) in the smoke instance`);
    }

    console.log("  ✓ Connected instance is the expected real vault");

    await clearInbox(preflight.vaultBase, targetAddress);
    await installProbe(page, pollIntervalMs);
    cleanupNeeded = true;

    const launchResult = await page.evaluate(async ({ projectId: liveProjectId }) => {
      const plugin = window.app.plugins.plugins["augment-terminal"];
      await plugin.launchProjectTeam(liveProjectId, "Live vault bus smoke");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const state = window.__augmentLiveVaultBusProbe.getState();
      return {
        terminals: state.terminals,
        queuedInputs: state.queuedInputs,
      };
    }, { projectId });

    assert(launchResult.terminals.length === 3, `Expected 3 managed terminals, saw ${launchResult.terminals.length}`);
    assert(launchResult.queuedInputs.length === 3, `Expected 3 queued boot prompts, saw ${launchResult.queuedInputs.length}`);
    console.log("  ✓ Managed launch opened 3 terminals without sending the boot prompts");

    const readyState = await waitForCondition(
      "managed terminals to produce initial shell output",
      async () => {
        const state = await getProbeState(page);
        if (!state || state.terminals.length !== 3) return null;
        const ready = state.terminals.every((entry) => stripAnsi(entry.snapshot).trim().length > 0);
        return ready ? state : null;
      },
      15_000,
      150
    );

    const teamId = readyState.terminals[0]?.managedTeamId ?? null;
    assert(teamId, "Managed terminals are missing managedTeamId");

    await sendInboxMessage(preflight.vaultBase, targetAddress, sourceAddress, subject, liveBody);

    const deliveredState = await waitForCondition(
      "live bus message to appear in the target terminal",
      async () => {
        const state = await getProbeState(page);
        if (!state || state.terminals.length !== 3) return null;

        const hits = state.terminals.filter((entry) => stripAnsi(entry.snapshot).includes(liveBody));
        const targetTerminal = state.terminals.find((entry) => entry.roleId === targetRole);
        const targetSnapshot = stripAnsi(targetTerminal?.snapshot ?? "");

        if (
          hits.length === 1 &&
          hits[0]?.roleId === targetRole &&
          targetSnapshot.includes("Unread bus messages arrived. Review them and continue.") &&
          targetSnapshot.includes(liveBody)
        ) {
          return state;
        }

        return null;
      },
      15_000,
      150
    );

    const hitRoles = deliveredState.terminals
      .filter((entry) => stripAnsi(entry.snapshot).includes(liveBody))
      .map((entry) => entry.roleId);
    assert(hitRoles.length === 1 && hitRoles[0] === targetRole, `Delivery hit the wrong terminal set: ${hitRoles.join(", ")}`);

    const unreadAfterDelivery = await readInbox(preflight.vaultBase, targetAddress, "none");
    assert(!unreadAfterDelivery.includes(liveBody), "Delivered message is still unread after the live poller pass");
    console.log(`  ✓ ${targetRole} terminal showed the live bus delivery and no other terminal did`);

    await page.evaluate(async ({ managedTeamId }) => {
      const plugin = window.app.plugins.plugins["augment-terminal"];
      await plugin.shutdownManagedTeam(managedTeamId);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }, { managedTeamId: teamId });

    await waitForCondition(
      "managed terminals to close after shutdown",
      async () => {
        const state = await getProbeState(page);
        return state && state.terminals.length === 0 ? state : null;
      },
      10_000,
      150
    );

    await sendInboxMessage(preflight.vaultBase, targetAddress, sourceAddress, subject, shutdownBody);
    await wait(pollIntervalMs * 4);

    const unreadAfterShutdown = await readInbox(preflight.vaultBase, targetAddress, "none");
    assert(
      unreadAfterShutdown.includes(shutdownBody),
      "Post-shutdown message did not remain unread; a poller may still be running"
    );
    console.log("  ✓ After shutdown, a fresh message remained unread");

    await clearInbox(preflight.vaultBase, targetAddress);

    await page.waitForTimeout(500);
    assert(consoleErrors.length === 0, `Unexpected console errors:\n${consoleErrors.join("\n")}`);
    console.log("  ✓ No unexpected console errors");
  } finally {
    try {
      if (cleanupNeeded) {
        await cleanupProbe(page);
      }
    } catch (error) {
      console.error(`Cleanup error: ${error instanceof Error ? error.message : String(error)}`);
    }

    await close();
  }

  console.log("────────────────────────────");
  console.log("Live-vault bus smoke passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
