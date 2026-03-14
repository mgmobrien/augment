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

function defaultPort() {
  const raw = process.env.AUGMENT_CDP_PORT?.trim();
  if (!raw) return 9223;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid AUGMENT_CDP_PORT: ${raw}`);
  }
  return parsed;
}

/**
 * Connect to Obsidian via CDP.
 *
 * @param {number} port - CDP port (default: AUGMENT_CDP_PORT or 9223)
 * @returns {{ browser, page, close }}
 */
export async function connect(port = defaultPort()) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ECONNREFUSED')) {
      throw new Error(
        `Could not connect to Obsidian CDP at http://localhost:${port}. ` +
          `Start the local test app first with either ` +
          `"npm run start" from /Users/mattobrien/Development/augment-plugin/playwright ` +
          `or "./scripts/start-test.sh ${port}" from /Users/mattobrien/Development/augment-plugin, ` +
          `then rerun this smoke. Original error: ${message}`
      );
    }
    throw error;
  }
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
