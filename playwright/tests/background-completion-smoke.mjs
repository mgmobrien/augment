import { connect, waitForPlugin } from "../connect.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function openPartInbox(page) {
  await page.evaluate(async () => {
    const workspace = window.app.workspace;
    const existing = workspace.getLeavesOfType("augment-part-inbox");
    let leaf = existing[0];

    if (!leaf) {
      const baseLeaf = workspace.getMostRecentLeaf() ?? workspace.getLeaf("tab");
      leaf =
        workspace.createLeafBySplit?.(baseLeaf, "vertical") ??
        workspace.getLeaf("split", "vertical");
    }

    await leaf.setViewState({
      type: "augment-part-inbox",
      active: true,
      state: { mode: "all" },
    });
    workspace.revealLeaf(leaf);
  });
}

async function readRedirectCount(page) {
  const count = page.locator(".augment-legacy-redirect-count");
  if ((await count.count()) === 0) return null;
  return (await count.first().textContent())?.trim() ?? null;
}

async function waitForRedirectCount(page, expectedText, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await readRedirectCount(page);
    if (current === expectedText) return current;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for redirect count "${expectedText}"`);
}

async function waitForStatusBarBadge(page, expectedText, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const badges = await page.locator(".status-bar-item").allTextContents();
    if (badges.map((value) => value.trim()).includes(expectedText)) return expectedText;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for status-bar badge "${expectedText}"`);
}

async function writeCanonicalBusMessage(page, { subject, body }) {
  await page.evaluate(async ({ subject, body }) => {
    const createdAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const msgId =
      (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`)
        .toString()
        .toLowerCase();
    const threadId = msgId;
    const fileTimestamp = createdAt.replace(/:/g, "");
    const folder = `agents/bus/local/messages/${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}`;
    const filePath = `${folder}/${fileTimestamp}__${msgId}.md`;
    const signalPath = "agents/bus/derived/signals/ceo_matt-stack.json";
    const content = [
      "---",
      `msg_id: ${msgId}`,
      `thread_id: ${threadId}`,
      "from: watcher-dispatcher@vault",
      "to: ceo@matt-stack",
      "msg_type: message",
      `subject: '${String(subject).replace(/'/g, "''")}'`,
      `created_at: ${createdAt}`,
      "habitat: vault",
      "privacy: local",
      "---",
      "",
      String(body),
    ].join("\n");
    const signal = `${JSON.stringify(
      {
        to: "ceo@matt-stack",
        msg_id: msgId,
        thread_id: threadId,
        created_at: createdAt,
      },
      null,
      2
    )}\n`;

    async function ensureFolder(folderPath) {
      try {
        await window.app.vault.createFolder(folderPath);
      } catch {
        // already exists
      }
    }

    await ensureFolder("agents");
    await ensureFolder("agents/bus");
    await ensureFolder("agents/bus/local");
    await ensureFolder("agents/bus/local/messages");
    await ensureFolder(`agents/bus/local/messages/${createdAt.slice(0, 4)}`);
    await ensureFolder(folder);
    await ensureFolder("agents/bus/derived");
    await ensureFolder("agents/bus/derived/signals");

    await window.app.vault.create(filePath, content);
    await window.app.vault.adapter.write(signalPath, signal);
  }, { subject, body });
}

async function main() {
  console.log("Augment background-completion smoke");
  console.log("─────────────────────────────────");

  const { page, close } = await connect();

  try {
    const trustButton = page.locator('button:has-text("Trust author and enable plugins")');
    if (await trustButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await trustButton.click();
      await page.waitForTimeout(3_000);
    }

    await waitForPlugin(page, 15_000);
    await openPartInbox(page);
    await page.waitForTimeout(800);

    const title = page.locator(".augment-legacy-redirect-title");
    assert((await title.textContent())?.trim() === "Inbox moved", "part inbox redirect shell did not open");

    const before = await readRedirectCount(page);
    assert(before === null, `expected no unread-attention count before message, saw ${before}`);

    const stamp = String(Date.now());
    await writeCanonicalBusMessage(page, {
      subject: `Background completion smoke ${stamp}`,
      body: `Background completion smoke body ${stamp}`,
    });

    const after = await waitForRedirectCount(page, "Unread attention: 1");
    assert(after === "Unread attention: 1", `unexpected redirect count after message: ${after}`);
    const badge = await waitForStatusBarBadge(page, "⚡ 1 inbox");
    assert(badge === "⚡ 1 inbox", `unexpected status-bar badge after message: ${badge}`);

    console.log("  ✓ Opened the redirect-shell inbox surface");
    console.log("  ✓ Count line started empty");
    console.log("  ✓ Addressed bus message incremented unread attention to 1");
    console.log("  ✓ Plugin-global attention badge reflected watched-address unread attention");
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
