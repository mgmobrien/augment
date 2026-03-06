/**
 * CDP connect helper for Augment visual testing.
 *
 * Adapted from relay-harness/playwright/lib/connect.mjs — simplified for
 * single-instance, no-auth use case.
 *
 * Usage:
 *   const { page, close } = await connect();
 *   await page.evaluate(() => window.app?.plugins?.plugins?.['augment-terminal']);
 *   await close();
 */

import { chromium } from 'playwright';

const PLUGIN_ID = 'augment-terminal';

/**
 * Connect to Obsidian via CDP.
 *
 * @param {number} port - CDP port (default 9223, set by start-test.sh)
 * @returns {{ browser, page, close }}
 */
export async function connect(port = 9223) {
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  const close = () => browser.close();
  return { browser, page, close };
}

/**
 * Get the Augment plugin instance.
 * Returns null if the plugin isn't loaded.
 */
export async function getPlugin(page) {
  return page.evaluate(
    (id) => window.app?.plugins?.plugins?.[id] ?? null,
    PLUGIN_ID
  );
}

/**
 * Wait until the Augment plugin is loaded (polls up to timeoutMs).
 */
export async function waitForPlugin(page, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loaded = await page.evaluate(
      (id) => !!window.app?.plugins?.plugins?.[id],
      PLUGIN_ID
    );
    if (loaded) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Augment plugin not loaded after ${timeoutMs}ms`);
}
