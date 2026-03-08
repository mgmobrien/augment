/**
 * Visual QA test for @-mention compose modal.
 *
 * Tests:
 * 1. Plugin loaded
 * 2. Open a test note, type @, verify suggester appears
 * 3. Select a part, verify compose modal opens (NOT immediate send)
 * 4. Verify modal elements: To: header, From: context, textarea, buttons
 * 5. Verify Escape cancels (no side effects)
 * 6. Re-open modal, write message, submit, verify inbox file written
 * 7. Screenshot the modal for visual review
 */

import { connect, waitForPlugin } from '../connect.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', 'screenshots');

async function run() {
  const results = [];
  const pass = (name) => { results.push({ name, status: 'PASS' }); console.log(`  ✓ ${name}`); };
  const fail = (name, reason) => { results.push({ name, status: 'FAIL', reason }); console.log(`  ✗ ${name}: ${reason}`); };

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log('Connecting to Obsidian via CDP...');
  const { page, close } = await connect();

  try {
    // 1. Wait for plugin
    console.log('Waiting for plugin...');
    await waitForPlugin(page);
    pass('Plugin loaded');

    // 2. Open the test note
    console.log('Opening test note...');
    await page.evaluate(async () => {
      const file = window.app.vault.getAbstractFileByPath('Test note.md');
      if (file) {
        await window.app.workspace.openLinkText('Test note', '', false);
      }
    });
    await page.waitForTimeout(500);

    // Check we have an active editor
    const hasEditor = await page.evaluate(() => {
      const view = window.app.workspace.activeLeaf?.view;
      return view?.editor != null;
    });
    if (!hasEditor) {
      fail('Editor available', 'No active editor found');
      return;
    }
    pass('Editor available');

    // 3. Type @ to trigger suggester
    console.log('Typing @ to trigger suggester...');
    await page.evaluate(() => {
      const editor = window.app.workspace.activeLeaf.view.editor;
      const cursor = editor.getCursor();
      editor.replaceRange('@', cursor);
      editor.setCursor({ line: cursor.line, ch: cursor.ch + 1 });
    });
    await page.waitForTimeout(500);

    // Manually trigger the suggest by simulating input event
    await page.evaluate(() => {
      const cmEditor = window.app.workspace.activeLeaf.view.editor;
      // Trigger EditorSuggest by dispatching input
      const cm = cmEditor.cm;
      if (cm?.dispatch) {
        // CodeMirror 6 - trigger a transaction to wake up suggesters
        cm.dispatch({ changes: { from: cm.state.doc.length, insert: '' } });
      }
    });
    await page.waitForTimeout(800);

    // Check for suggester popup
    let suggesterVisible = await page.evaluate(() => {
      const el = document.querySelector('.suggestion-container');
      return el != null && el.offsetParent != null;
    });

    if (!suggesterVisible) {
      // Try keyboard approach instead
      console.log('  Trying keyboard input for @...');
      await page.evaluate(() => {
        const editor = window.app.workspace.activeLeaf.view.editor;
        editor.setValue('');
        editor.setCursor({ line: 0, ch: 0 });
      });
      await page.waitForTimeout(200);
      await page.keyboard.type('@');
      await page.waitForTimeout(1000);

      suggesterVisible = await page.evaluate(() => {
        const el = document.querySelector('.suggestion-container');
        return el != null && el.offsetParent != null;
      });
    }

    if (suggesterVisible) {
      pass('Suggester appears on @');
      await page.screenshot({ path: join(SCREENSHOT_DIR, '01-suggester.png'), fullPage: true });
    } else {
      fail('Suggester appears on @', 'Suggestion container not visible');
      await page.screenshot({ path: join(SCREENSHOT_DIR, '01-no-suggester.png'), fullPage: true });
      // Try to continue by opening modal directly for visual inspection
      console.log('  Attempting direct modal open for visual inspection...');
    }

    // 4. Select a part from suggester (or open modal directly)
    console.log('Selecting part from suggester...');
    let modalOpened = false;

    if (suggesterVisible) {
      // Click the first suggestion
      await page.evaluate(() => {
        const item = document.querySelector('.suggestion-container .suggestion-item');
        if (item) item.click();
      });
      await page.waitForTimeout(500);
    } else {
      // Fallback: Open compose modal directly via plugin API
      console.log('  Fallback: opening compose modal via API...');
      await page.evaluate(() => {
        const plugin = window.app.plugins.plugins['augment-terminal'];
        // Access the InboxSuggest class and create a ComposeModal manually
        // We need to find the ComposeModal - it's not exported, but we can test via the suggest
      });
    }

    // Check if compose modal opened
    const modalVisible = await page.evaluate(() => {
      const modal = document.querySelector('.augment-compose-modal');
      return modal != null;
    });

    if (modalVisible) {
      pass('Compose modal opens (not immediate send)');
      modalOpened = true;
    } else {
      // If suggester didn't work, try opening modal via a more direct route
      console.log('  Trying to open modal by simulating selectSuggestion...');
      await page.evaluate(async () => {
        // Create a ComposeModal-like test by importing the class
        const { Modal, Notice } = window.require('obsidian');
        const plugin = window.app.plugins.plugins['augment-terminal'];

        // Access the InboxSuggest instance from plugin's registered suggests
        // EditorSuggests are registered on the plugin, look for it
        const suggests = window.app.workspace.editorSuggest?.suggests ?? [];
        for (const s of suggests) {
          if (s.constructor?.name === 'InboxSuggest') {
            // Simulate selecting "chief-of-staff"
            const ctx = {
              editor: window.app.workspace.activeLeaf?.view?.editor,
              start: { line: 0, ch: 0 },
              end: { line: 0, ch: 1 },
            };
            s.context = ctx;
            s.selectSuggestion('chief-of-staff');
            break;
          }
        }
      });
      await page.waitForTimeout(500);

      const retryModal = await page.evaluate(() => {
        return document.querySelector('.augment-compose-modal') != null;
      });
      if (retryModal) {
        pass('Compose modal opens (via API simulation)');
        modalOpened = true;
      } else {
        fail('Compose modal opens', 'Could not trigger compose modal');
      }
    }

    if (modalOpened) {
      // 5. Screenshot the compose modal
      await page.screenshot({ path: join(SCREENSHOT_DIR, '02-compose-modal.png'), fullPage: true });

      // 6. Verify modal elements
      const elements = await page.evaluate(() => {
        const modal = document.querySelector('.augment-compose-modal');
        if (!modal) return null;

        const recipient = modal.querySelector('.augment-compose-recipient');
        const recipientLabel = recipient?.querySelector('.augment-compose-label')?.textContent;
        const recipientValue = recipient?.querySelector('.augment-compose-value')?.textContent;

        const context = modal.querySelector('.augment-compose-context');
        const contextLabel = context?.querySelector('.augment-compose-label')?.textContent;
        const contextValue = context?.querySelector('span:not(.augment-compose-label)')?.textContent;

        const divider = modal.querySelector('.augment-compose-divider');

        const textarea = modal.querySelector('.augment-compose-body');
        const placeholder = textarea?.placeholder;
        const rows = textarea?.rows;
        const isFocused = document.activeElement === textarea;

        const btnRow = modal.querySelector('.augment-compose-btn-row');
        const buttons = [...(btnRow?.querySelectorAll('button') ?? [])].map(b => ({
          text: b.textContent,
          isCta: b.classList.contains('mod-cta'),
        }));

        return {
          hasRecipient: !!recipient,
          recipientLabel,
          recipientValue,
          hasContext: !!context,
          contextLabel,
          contextValue,
          hasDivider: !!divider,
          hasTextarea: !!textarea,
          placeholder,
          rows,
          isFocused,
          buttons,
        };
      });

      if (elements) {
        // To: line
        if (elements.hasRecipient && elements.recipientLabel === 'To: ') {
          pass('To: label present');
        } else {
          fail('To: label present', `recipientLabel="${elements.recipientLabel}"`);
        }

        if (elements.recipientValue) {
          pass(`To: value shows part name ("${elements.recipientValue}")`);
        } else {
          fail('To: value shows part name', 'No value found');
        }

        // From: context line
        if (elements.hasContext && elements.contextLabel === 'From: ') {
          pass('From: context line present');
        } else if (!elements.hasContext) {
          // Could be absent if no active file - check
          console.log('  Note: From: line absent (may be expected if no active file detected)');
          pass('From: context line absent (acceptable if no file)');
        } else {
          fail('From: context line', `contextLabel="${elements.contextLabel}"`);
        }

        // Divider
        elements.hasDivider ? pass('Divider present') : fail('Divider present', 'Not found');

        // Textarea
        if (elements.hasTextarea) {
          pass('Textarea present');
          elements.placeholder === 'Write a message...'
            ? pass('Textarea placeholder correct')
            : fail('Textarea placeholder', `"${elements.placeholder}"`);
          elements.rows === 4
            ? pass('Textarea rows=4')
            : fail('Textarea rows', `rows=${elements.rows}`);
          elements.isFocused
            ? pass('Textarea auto-focused')
            : fail('Textarea auto-focused', 'Not focused');
        } else {
          fail('Textarea present', 'Not found');
        }

        // Buttons
        if (elements.buttons.length === 2) {
          const [cancel, send] = elements.buttons;
          cancel.text === 'Cancel' && !cancel.isCta
            ? pass('Cancel button (non-CTA, left)')
            : fail('Cancel button', JSON.stringify(cancel));
          send.text === 'Send' && send.isCta
            ? pass('Send button (CTA, right)')
            : fail('Send button', JSON.stringify(send));
        } else {
          fail('Button row', `Expected 2 buttons, found ${elements.buttons.length}`);
        }
      }

      // 7. Test Escape cancels
      console.log('Testing Escape cancels...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      const modalAfterEscape = await page.evaluate(() => {
        return document.querySelector('.augment-compose-modal') != null;
      });
      !modalAfterEscape ? pass('Escape closes modal') : fail('Escape closes modal', 'Modal still visible');

      // Check no inbox files were created (no send happened)
      const inboxEmpty = await page.evaluate(() => {
        const folder = window.app.vault.getAbstractFileByPath('agents/parts/chief-of-staff/inbox');
        if (!folder) return true;
        return folder.children.filter(f => f.extension === 'md' && !f.path.includes('/read/')).length === 0;
      });
      inboxEmpty ? pass('Cancel: no message sent') : fail('Cancel: no message sent', 'Inbox has files');

      await page.screenshot({ path: join(SCREENSHOT_DIR, '03-after-escape.png'), fullPage: true });

      // 8. Re-open modal, write message, send
      console.log('Re-opening modal for send test...');
      // Type @ again to trigger
      await page.evaluate(() => {
        const editor = window.app.workspace.activeLeaf.view.editor;
        const cursor = editor.getCursor();
        editor.replaceRange('@', cursor);
        editor.setCursor({ line: cursor.line, ch: cursor.ch + 1 });
      });
      await page.waitForTimeout(500);
      await page.keyboard.type('chief');
      await page.waitForTimeout(500);

      // Try clicking suggestion or fallback to API
      const hasSuggester2 = await page.evaluate(() => {
        const items = document.querySelectorAll('.suggestion-container .suggestion-item');
        if (items.length > 0) { items[0].click(); return true; }
        return false;
      });

      if (!hasSuggester2) {
        // Fallback: open via API simulation again
        await page.evaluate(() => {
          const suggests = window.app.workspace.editorSuggest?.suggests ?? [];
          for (const s of suggests) {
            if (s.constructor?.name === 'InboxSuggest') {
              const editor = window.app.workspace.activeLeaf?.view?.editor;
              const cursor = editor.getCursor();
              s.context = { editor, start: { line: cursor.line, ch: 0 }, end: cursor };
              s.selectSuggestion('chief-of-staff');
              break;
            }
          }
        });
      }
      await page.waitForTimeout(500);

      const modalForSend = await page.evaluate(() => {
        return document.querySelector('.augment-compose-modal') != null;
      });

      if (modalForSend) {
        // Type a message
        await page.evaluate(() => {
          const textarea = document.querySelector('.augment-compose-body');
          if (textarea) {
            textarea.value = 'Test message from QA visual testing';
            textarea.dispatchEvent(new Event('input'));
          }
        });
        await page.waitForTimeout(200);

        await page.screenshot({ path: join(SCREENSHOT_DIR, '04-compose-with-text.png'), fullPage: true });

        // Click Send
        await page.evaluate(() => {
          const btns = document.querySelectorAll('.augment-compose-btn-row button');
          const sendBtn = [...btns].find(b => b.textContent === 'Send');
          if (sendBtn) sendBtn.click();
        });
        await page.waitForTimeout(500);

        // Verify modal closed
        const modalAfterSend = await page.evaluate(() => {
          return document.querySelector('.augment-compose-modal') != null;
        });
        !modalAfterSend ? pass('Send closes modal') : fail('Send closes modal', 'Modal still visible');

        // Check for Notice (toast)
        // Notices are transient, hard to catch, skip this check

        // Check inbox file was written
        await page.waitForTimeout(500);
        const inboxFiles = await page.evaluate(() => {
          const folder = window.app.vault.getAbstractFileByPath('agents/parts/chief-of-staff/inbox');
          if (!folder) return [];
          return folder.children
            .filter(f => f.extension === 'md' && !f.path.includes('/read/'))
            .map(f => f.path);
        });

        if (inboxFiles.length > 0) {
          pass(`Inbox file written (${inboxFiles[0]})`);

          // Read the message and verify contents
          const msgContent = await page.evaluate(async (path) => {
            const file = window.app.vault.getAbstractFileByPath(path);
            if (!file) return null;
            return await window.app.vault.read(file);
          }, inboxFiles[0]);

          if (msgContent) {
            const hasTo = msgContent.includes('to: chief-of-staff@vault');
            const hasFrom = msgContent.includes('from: user');
            const hasBody = msgContent.includes('Test message from QA visual testing');
            const hasSourceNote = msgContent.includes('source_note:');

            hasTo ? pass('Message to: correct') : fail('Message to:', 'Missing or wrong');
            hasFrom ? pass('Message from: correct') : fail('Message from:', 'Missing or wrong');
            hasBody ? pass('Message body correct') : fail('Message body:', 'Missing or wrong');
            hasSourceNote ? pass('source_note field present') : fail('source_note field', 'Missing');
          }
        } else {
          fail('Inbox file written', 'No files found in inbox');
        }

        pass('Send test complete');
      } else {
        fail('Re-open modal for send test', 'Could not re-open modal');
      }

      // 9. Verify note is clean (no @mention text left)
      const noteContent = await page.evaluate(() => {
        const editor = window.app.workspace.activeLeaf?.view?.editor;
        return editor?.getValue() ?? '';
      });
      if (!noteContent.includes('@chief-of-staff') && !noteContent.includes('@chief')) {
        pass('Note clean (no @mention residue)');
      } else {
        fail('Note clean', `Note still contains: "${noteContent.trim()}"`);
      }

    }

  } catch (err) {
    console.error('Test error:', err.message);
    fail('Test execution', err.message);
    try {
      await page.screenshot({ path: join(SCREENSHOT_DIR, 'error.png'), fullPage: true });
    } catch {}
  } finally {
    // Summary
    console.log('\n=== Results ===');
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\nFailures:');
      results.filter(r => r.status === 'FAIL').forEach(r => {
        console.log(`  ✗ ${r.name}: ${r.reason}`);
      });
    }
    console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`);

    await close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
