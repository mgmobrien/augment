import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Modal, Notice } from "obsidian";
import { discoverVaultParts, writeMessage } from "./inbox-bus";

/**
 * InboxSuggest — @-mention dispatch to vault part inboxes.
 *
 * Triggers on `@` at line-start or after whitespace (avoids email addresses).
 * On selection: opens a compose modal for the user to write a message.
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

    // Capture selection before modifying the editor.
    const selection = editor.getSelection().trim();

    // Remove the @mention text from the editor.
    editor.replaceRange("", ctx.start, ctx.end);

    // Get the active note title for the From: context line.
    const activeFile = this.app.workspace.getActiveFile();
    const sourceNote = activeFile?.basename ?? "";

    // Open compose modal instead of sending immediately.
    new ComposeModal(this.app, partName, sourceNote, selection).open();
  }
}

export class ComposeModal extends Modal {
  private partName: string;
  private sourceNote: string;
  private initialBody: string;

  constructor(app: App, partName: string, sourceNote: string, initialBody: string) {
    super(app);
    this.partName = partName;
    this.sourceNote = sourceNote;
    this.initialBody = initialBody;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-compose-modal");

    // To: line
    const recipientEl = contentEl.createEl("div", { cls: "augment-compose-recipient" });
    recipientEl.createEl("span", { cls: "augment-compose-label", text: "To: " });
    recipientEl.createEl("span", { cls: "augment-compose-value", text: this.partName });

    // From: context line (only if we have a source note)
    if (this.sourceNote) {
      const contextEl = contentEl.createEl("div", { cls: "augment-compose-context" });
      contextEl.createEl("span", { cls: "augment-compose-label", text: "From: " });
      contextEl.createEl("span", { text: this.sourceNote });
    }

    // Divider
    contentEl.createEl("div", { cls: "augment-compose-divider" });

    // Textarea
    const textarea = contentEl.createEl("textarea", {
      cls: "augment-compose-body",
      attr: { rows: "4", placeholder: "Write a message..." },
    });
    textarea.value = this.initialBody;

    // Cmd+Enter to send
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit(textarea.value);
      }
    });

    // Auto-focus textarea, cursor at end
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    }, 10);

    // Button row
    const btnRow = contentEl.createEl("div", { cls: "augment-compose-btn-row" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const sendBtn = btnRow.createEl("button", { cls: "mod-cta", text: "Send" });
    sendBtn.addEventListener("click", () => this.submit(textarea.value));
  }

  private submit(body: string): void {
    const subject = body.trim().slice(0, 80) || "Message";
    void writeMessage(this.app, {
      to: this.partName,
      from: "user",
      subject,
      body: body.trim(),
      sourceNote: this.sourceNote,
    }).then(() => {
      new Notice(`Sent to ${this.partName}`);
    }).catch((err: unknown) => {
      new Notice(`Failed to send to ${this.partName}: ${String(err)}`);
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
