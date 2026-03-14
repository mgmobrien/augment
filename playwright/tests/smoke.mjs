/**
 * Augment smoke test — runs against a live Obsidian instance on CDP port 9223.
 *
 * Setup:
 *   cd playwright && npm run start   # shared slot s01 -> port 9223
 *   # or: ./scripts/start-test.sh 9223
 *
 * Run:
 *   node playwright/tests/smoke.mjs
 *
 * Checks:
 *   1. Plugin loaded (window.app.plugins.plugins['augment-terminal'] exists)
 *   2. No console errors on load
 *   3. Stable ribbon/command surfaces are present on a fresh slot
 *   4. Settings tab renders without error
 */

import { connect, waitForPlugin } from '../connect.mjs';

const PLUGIN_ID = 'augment-terminal';
let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name, detail) {
  console.error(`  ✗ ${name}`);
  if (detail) console.error(`    ${detail}`);
  failed++;
}

async function main() {
  console.log('Augment smoke test');
  console.log('──────────────────');

  const { page, close } = await connect();

  // Capture console errors from Obsidian
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter expected Obsidian internal errors
      if (!text.includes('ResizeObserver loop') && !text.includes('net::ERR_FILE_NOT_FOUND')) {
        consoleErrors.push(text);
      }
    }
  });

  try {
    const trustButton = page.locator('button:has-text("Trust author and enable plugins")');
    if (await trustButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await trustButton.click();
      await page.waitForTimeout(3_000);
    }

    // 1. Plugin loaded
    try {
      await waitForPlugin(page);
      pass('Plugin loaded');
    } catch (e) {
      fail('Plugin loaded', e.message);
    }

    // 2. No console errors on load
    await page.waitForTimeout(1000); // let any deferred errors surface
    if (consoleErrors.length === 0) {
      pass('No console errors on load');
    } else {
      fail('No console errors on load', `${consoleErrors.length} error(s):\n    ${consoleErrors.slice(0, 3).join('\n    ')}`);
    }

    // 3. Stable ribbon surfaces present on a fresh slot.
    //    The terminal ribbon is tier-gated after terminal setup, so a fresh
    //    slot only guarantees settings + generate plus the open-terminal command.
    const ribbonTooltips = ['Augment settings', 'Generate'];
    for (const tooltip of ribbonTooltips) {
      const el = page.locator(`.side-dock-ribbon-action[aria-label="${tooltip}"]`);
      const count = await el.count();
      if (count > 0) {
        pass(`Ribbon icon: "${tooltip}"`);
      } else {
        fail(`Ribbon icon: "${tooltip}"`, 'Element not found in DOM');
      }
    }

    try {
      const commandRegistered = await page.evaluate(
        () => !!window.app?.commands?.commands?.['augment-terminal:open-terminal']
      );
      if (commandRegistered) {
        pass('Command registered: "Open terminal"');
      } else {
        fail('Command registered: "Open terminal"', 'augment-terminal:open-terminal missing');
      }
    } catch (e) {
      fail('Command registered: "Open terminal"', e.message);
    }

    // 4. Settings tab renders
    try {
      // Open settings via ribbon click
      await page.click(`.side-dock-ribbon-action[aria-label="Augment settings"]`);
      await page.waitForTimeout(800);

      // Check settings modal is open
      const modal = page.locator('.modal-container');
      const modalVisible = await modal.count() > 0;
      if (modalVisible) {
        pass('Settings modal opened');
      } else {
        fail('Settings modal opened', 'Modal container not found');
      }

      // Close modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } catch (e) {
      fail('Settings modal opened', e.message);
    }

  } finally {
    await close();
  }

  console.log('──────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
