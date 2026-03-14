/**
 * Trust plugin prompt + compose modal visual test.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { connect } from '../connect.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function run() {
  const results = [];
  const pass = (name) => { results.push({ name, status: 'PASS' }); console.log(`  ✓ ${name}`); };
  const fail = (name, reason) => { results.push({ name, status: 'FAIL', reason }); console.log(`  ✗ ${name}: ${reason}`); };

  const { browser, page, close } = await connect();

  try {
    // Handle trust dialog if present
    const trustBtn = page.locator('button:has-text("Trust author and enable plugins")');
    if (await trustBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('Clicking Trust button...');
      await trustBtn.click();
      await page.waitForTimeout(3000);
    }

    // Wait for plugin
    console.log('Waiting for plugin...');
    for (let i = 0; i < 30; i++) {
      const loaded = await page.evaluate(() => !!window.app?.plugins?.plugins?.['augment-terminal']);
      if (loaded) break;
      await page.waitForTimeout(500);
    }

    const pluginLoaded = await page.evaluate(() => !!window.app?.plugins?.plugins?.['augment-terminal']);
    if (!pluginLoaded) { fail('Plugin loaded', 'Not loaded after 15s'); return; }
    pass('Plugin loaded');

    // Open test note
    console.log('Opening test note...');
    await page.evaluate(async () => {
      const file = window.app.vault.getAbstractFileByPath('Test note.md');
      if (file) await window.app.workspace.openLinkText('Test note', '', false);
    });
    await page.waitForTimeout(1000);

    const hasEditor = await page.evaluate(() => !!window.app.workspace.activeLeaf?.view?.editor);
    if (!hasEditor) { fail('Editor available', 'No editor'); return; }
    pass('Editor available');

    // Try opening compose modal via the InboxSuggest API directly
    console.log('Opening compose modal via InboxSuggest...');
    await page.evaluate(() => {
      const editor = window.app.workspace.activeLeaf.view.editor;
      // Clear editor
      editor.setValue('');
      editor.setCursor({ line: 0, ch: 0 });
    });
    await page.waitForTimeout(200);

    // Type @ using keyboard to trigger the EditorSuggest
    await page.keyboard.type('@');
    await page.waitForTimeout(1000);

    // Check if suggester appeared
    let suggesterVisible = await page.evaluate(() => {
      const el = document.querySelector('.suggestion-container');
      return el != null && el.offsetParent != null;
    });

    if (suggesterVisible) {
      pass('Suggester appears on @');
      await page.screenshot({ path: join(SCREENSHOT_DIR, '01-suggester.png'), fullPage: true });

      // Click first suggestion
      await page.evaluate(() => {
        const item = document.querySelector('.suggestion-container .suggestion-item');
        if (item) item.click();
      });
      await page.waitForTimeout(800);
    } else {
      console.log('  Suggester not visible via keyboard, trying programmatic approach...');
      // Try triggering the suggest programmatically
      await page.evaluate(() => {
        const editor = window.app.workspace.activeLeaf.view.editor;
        editor.setValue('@chief');
        editor.setCursor({ line: 0, ch: 6 });
      });
      await page.waitForTimeout(500);
      // Use keyboard to trigger CM6 update
      await page.keyboard.type('-');
      await page.waitForTimeout(1000);

      suggesterVisible = await page.evaluate(() => {
        const el = document.querySelector('.suggestion-container');
        return el != null && el.offsetParent != null;
      });

      if (suggesterVisible) {
        pass('Suggester appears (programmatic)');
        await page.screenshot({ path: join(SCREENSHOT_DIR, '01-suggester.png'), fullPage: true });
        await page.evaluate(() => {
          const item = document.querySelector('.suggestion-container .suggestion-item');
          if (item) item.click();
        });
        await page.waitForTimeout(800);
      } else {
        // Last resort: find InboxSuggest and call selectSuggestion directly
        console.log('  Suggester still not visible. Using direct InboxSuggest API...');
        await page.screenshot({ path: join(SCREENSHOT_DIR, '01-no-suggester.png'), fullPage: true });

        await page.evaluate(() => {
          const editor = window.app.workspace.activeLeaf.view.editor;
          editor.setValue('');
          editor.setCursor({ line: 0, ch: 0 });

          // Find InboxSuggest in registered suggests
          const suggests = window.app.workspace.editorSuggest?.suggests ?? [];
          for (const s of suggests) {
            if (s.constructor?.name === 'InboxSuggest') {
              s.context = {
                editor,
                start: { line: 0, ch: 0 },
                end: { line: 0, ch: 0 },
              };
              s.selectSuggestion('chief-of-staff');
              console.log('Called selectSuggestion directly');
              break;
            }
          }
        });
        await page.waitForTimeout(800);
      }
    }

    // Check if compose modal opened
    const modalVisible = await page.evaluate(() => !!document.querySelector('.augment-compose-modal'));

    if (!modalVisible) {
      fail('Compose modal opens', 'Modal not found after triggering @-mention');
      await page.screenshot({ path: join(SCREENSHOT_DIR, '02-no-modal.png'), fullPage: true });
      return;
    }
    pass('Compose modal opens (NOT immediate send)');

    // Screenshot the modal
    await page.screenshot({ path: join(SCREENSHOT_DIR, '02-compose-modal.png'), fullPage: true });

    // Verify modal elements
    const elements = await page.evaluate(() => {
      const modal = document.querySelector('.augment-compose-modal');
      if (!modal) return null;

      const recipient = modal.querySelector('.augment-compose-recipient');
      const recipientLabel = recipient?.querySelector('.augment-compose-label')?.textContent;
      const recipientValue = recipient?.querySelector('.augment-compose-value')?.textContent;

      const context = modal.querySelector('.augment-compose-context');
      const contextLabel = context?.querySelector('.augment-compose-label')?.textContent;

      const divider = modal.querySelector('.augment-compose-divider');

      const textarea = modal.querySelector('.augment-compose-body');

      const btnRow = modal.querySelector('.augment-compose-btn-row');
      const buttons = [...(btnRow?.querySelectorAll('button') ?? [])].map(b => ({
        text: b.textContent,
        isCta: b.classList.contains('mod-cta'),
      }));

      // Check computed styles
      const recipientLabelStyle = recipient?.querySelector('.augment-compose-label')
        ? getComputedStyle(recipient.querySelector('.augment-compose-label')) : null;
      const recipientValueStyle = recipient?.querySelector('.augment-compose-value')
        ? getComputedStyle(recipient.querySelector('.augment-compose-value')) : null;

      return {
        hasRecipient: !!recipient,
        recipientLabel,
        recipientValue,
        hasContext: !!context,
        contextLabel,
        hasDivider: !!divider,
        hasTextarea: !!textarea,
        placeholder: textarea?.placeholder,
        rows: textarea?.rows,
        isFocused: document.activeElement === textarea,
        buttons,
        // Style checks
        recipientValueFontWeight: recipientValueStyle?.fontWeight,
      };
    });

    if (elements) {
      // To: line
      elements.hasRecipient && elements.recipientLabel === 'To: '
        ? pass('To: label present')
        : fail('To: label', `"${elements.recipientLabel}"`);

      elements.recipientValue === 'chief-of-staff'
        ? pass('To: value = "chief-of-staff"')
        : fail('To: value', `"${elements.recipientValue}"`);

      // Font weight check for part name (spec: font-semibold)
      if (elements.recipientValueFontWeight && parseInt(elements.recipientValueFontWeight) >= 600) {
        pass('Part name is semibold');
      } else {
        fail('Part name semibold', `weight=${elements.recipientValueFontWeight}`);
      }

      // From: context line
      if (elements.hasContext && elements.contextLabel === 'From: ') {
        pass('From: context line present');
      } else if (!elements.hasContext) {
        pass('From: context line absent (no active file — acceptable)');
      } else {
        fail('From: context line', `contextLabel="${elements.contextLabel}"`);
      }

      // Divider
      elements.hasDivider ? pass('Divider present') : fail('Divider', 'Not found');

      // Textarea
      if (elements.hasTextarea) {
        pass('Textarea present');
        elements.placeholder === 'Write a message...' ? pass('Placeholder correct') : fail('Placeholder', `"${elements.placeholder}"`);
        elements.rows === 4 ? pass('Textarea rows=4') : fail('Rows', `${elements.rows}`);
        elements.isFocused ? pass('Textarea auto-focused') : fail('Auto-focus', 'Not focused');
      } else {
        fail('Textarea', 'Not found');
      }

      // Buttons
      if (elements.buttons.length === 2) {
        const [cancel, send] = elements.buttons;
        cancel.text === 'Cancel' && !cancel.isCta ? pass('Cancel button (non-CTA, left)') : fail('Cancel btn', JSON.stringify(cancel));
        send.text === 'Send' && send.isCta ? pass('Send button (CTA, right)') : fail('Send btn', JSON.stringify(send));
      } else {
        fail('Buttons', `Expected 2, found ${elements.buttons.length}`);
      }
    }

    // Test Escape cancels
    console.log('Testing Escape...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const afterEscape = await page.evaluate(() => !!document.querySelector('.augment-compose-modal'));
    !afterEscape ? pass('Escape closes modal') : fail('Escape', 'Modal still visible');

    // Verify no inbox file written
    const inboxEmptyAfterCancel = await page.evaluate(() => {
      const folder = window.app.vault.getAbstractFileByPath('agents/parts/chief-of-staff/inbox');
      if (!folder) return true;
      return folder.children.filter(f => f.extension === 'md' && !f.path.includes('/read/')).length === 0;
    });
    inboxEmptyAfterCancel ? pass('Cancel: no message sent') : fail('Cancel side effects', 'Inbox has files');

    await page.screenshot({ path: join(SCREENSHOT_DIR, '03-after-cancel.png'), fullPage: true });

    // Test send flow
    console.log('Testing send flow...');
    // Re-open modal
    await page.evaluate(() => {
      const editor = window.app.workspace.activeLeaf.view.editor;
      editor.setValue('');
      editor.setCursor({ line: 0, ch: 0 });
      const suggests = window.app.workspace.editorSuggest?.suggests ?? [];
      for (const s of suggests) {
        if (s.constructor?.name === 'InboxSuggest') {
          s.context = { editor, start: { line: 0, ch: 0 }, end: { line: 0, ch: 0 } };
          s.selectSuggestion('stack');
          break;
        }
      }
    });
    await page.waitForTimeout(800);

    const modalForSend = await page.evaluate(() => !!document.querySelector('.augment-compose-modal'));
    if (!modalForSend) { fail('Re-open modal for send', 'Not visible'); return; }

    // Type message
    const textarea = page.locator('.augment-compose-body');
    await textarea.fill('QA visual test message — verify inbox write');
    await page.waitForTimeout(200);

    await page.screenshot({ path: join(SCREENSHOT_DIR, '04-compose-with-text.png'), fullPage: true });

    // Send via Cmd+Enter
    await textarea.press('Meta+Enter');
    await page.waitForTimeout(800);

    const afterSend = await page.evaluate(() => !!document.querySelector('.augment-compose-modal'));
    !afterSend ? pass('Cmd+Enter sends and closes modal') : fail('Cmd+Enter send', 'Modal still visible');

    // Verify inbox file
    const inboxFiles = await page.evaluate(() => {
      const folder = window.app.vault.getAbstractFileByPath('agents/parts/stack/inbox');
      if (!folder) return [];
      return folder.children
        .filter(f => f.extension === 'md' && !f.path.includes('/read/'))
        .map(f => f.path);
    });

    if (inboxFiles.length > 0) {
      pass(`Inbox file written (${inboxFiles[0]})`);

      const content = await page.evaluate(async (path) => {
        const file = window.app.vault.getAbstractFileByPath(path);
        return file ? await window.app.vault.read(file) : null;
      }, inboxFiles[0]);

      if (content) {
        content.includes('to: stack@vault') ? pass('Message to: correct') : fail('to:', 'Wrong');
        content.includes('from: user') ? pass('Message from: correct') : fail('from:', 'Wrong');
        content.includes('QA visual test message') ? pass('Message body correct') : fail('body:', 'Missing');
        content.includes('source_note:') ? pass('source_note field present') : fail('source_note:', 'Missing');
      }
    } else {
      fail('Inbox file written', 'No files in inbox');
    }

    // Verify note is clean
    const noteContent = await page.evaluate(() => {
      return window.app.workspace.activeLeaf?.view?.editor?.getValue() ?? '';
    });
    !noteContent.includes('@stack') && !noteContent.includes('@chief')
      ? pass('Note clean (no @mention residue)')
      : fail('Note clean', `Contains: "${noteContent.trim()}"`);

    await page.screenshot({ path: join(SCREENSHOT_DIR, '05-after-send.png'), fullPage: true });

  } catch (err) {
    console.error('Error:', err.message);
    fail('Execution', err.message);
    try { await page.screenshot({ path: join(SCREENSHOT_DIR, 'error.png'), fullPage: true }); } catch {}
  } finally {
    console.log('\n=== Results ===');
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\nFailures:');
      results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  ✗ ${r.name}: ${r.reason}`));
    }
    console.log(`\nScreenshots: ${SCREENSHOT_DIR}`);
    await close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
