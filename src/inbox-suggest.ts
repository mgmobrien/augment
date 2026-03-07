import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Notice } from "obsidian";
import { discoverVaultParts, writeMessage } from "./inbox-bus";

/**
 * InboxSuggest — @-mention dispatch to vault part inboxes.
 *
 * Triggers on `@` at line-start or after whitespace (avoids email addresses).
 * On selection: derives message body from selected text or surrounding line
 * content, writes to the part's inbox via writeMessage(), shows a Notice.
 */
export class InboxSuggest extends EditorSuggest<string> {
  constructor(app: App) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    // Only trigger after whitespace or at line start — avoids email addresses.
    const match = before.match(/(^|[\s])@(\w*)$/);
    if (!match) return null;
    const atPos = before.lastIndexOf("@");
    return {
      start: { line: cursor.line, ch: atPos },
      end: cursor,
      query: match[2],
    };
  }

  getSuggestions(ctx: EditorSuggestContext): string[] {
    const parts = discoverVaultParts(this.app);
    const q = ctx.query.toLowerCase();
    return q ? parts.filter((p) => p.includes(q)) : parts;
  }

  renderSuggestion(partName: string, el: HTMLElement): void {
    el.createEl("div", { cls: "augment-inbox-part-name", text: partName });
    el.createEl("div", { cls: "augment-inbox-part-hint", text: `→ ${partName}'s inbox` });
  }

  selectSuggestion(partName: string): void {
    const ctx = this.context;
    if (!ctx) return;
    const editor = ctx.editor;

    // Derive body from selection (if any) or from line content around the @mention.
    let body: string;
    const selection = editor.getSelection().trim();
    if (selection) {
      body = selection;
    } else {
      const line = editor.getLine(ctx.start.line);
      const before = line.slice(0, ctx.start.ch).trim();
      const after = line.slice(ctx.end.ch).trim();
      body = [before, after].filter(Boolean).join(" ");
    }

    // Remove the @mention text from the editor.
    editor.replaceRange("", ctx.start, ctx.end);

    const subject = body.slice(0, 80) || "Message";

    void writeMessage(this.app, {
      to: partName,
      from: "user",
      subject,
      body,
    }).then(() => {
      new Notice(`Sent to ${partName}'s inbox`);
    }).catch((err: unknown) => {
      new Notice(`Failed to send to ${partName}: ${String(err)}`);
    });
  }
}
