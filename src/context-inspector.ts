import { App, Modal } from "obsidian";
import { VaultContext } from "./vault-context";

export class ContextInspectorModal extends Modal {
  private ctx: VaultContext;

  constructor(app: App, ctx: VaultContext) {
    super(app);
    this.ctx = ctx;
    this.modalEl.addClass("augment-context-modal");
  }

  onOpen(): void {
    this.titleEl.setText("Context inspector");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Note title
    const titleSection = contentEl.createEl("div", { cls: "augment-ctx-section" });
    titleSection.createEl("div", { cls: "augment-ctx-section-label", text: "NOTE" });
    titleSection.createEl("div", { cls: "augment-ctx-note-title", text: this.ctx.title });

    // Frontmatter
    if (this.ctx.frontmatter && Object.keys(this.ctx.frontmatter).length > 0) {
      const fmSection = contentEl.createEl("div", { cls: "augment-ctx-section" });
      fmSection.createEl("div", { cls: "augment-ctx-section-label", text: "FRONTMATTER" });
      for (const [key, val] of Object.entries(this.ctx.frontmatter)) {
        const row = fmSection.createEl("div", { cls: "augment-ctx-fm-row" });
        row.createEl("span", { cls: "augment-ctx-fm-key", text: key });
        const valStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
        row.createEl("span", { text: valStr });
      }
    }

    // Selection or context window
    const ctxSection = contentEl.createEl("div", { cls: "augment-ctx-section" });
    if (this.ctx.selection) {
      ctxSection.createEl("div", { cls: "augment-ctx-section-label", text: "SELECTION" });
      ctxSection.createEl("pre", { cls: "augment-ctx-pre", text: this.ctx.selection });
    } else {
      ctxSection.createEl("div", { cls: "augment-ctx-section-label", text: "CONTEXT" });
      ctxSection.createEl("pre", {
        cls: "augment-ctx-pre",
        text: this.ctx.surroundingContext || "(empty — position cursor in a note)",
      });
    }

    // Linked notes
    if (this.ctx.linkedNotes.length > 0) {
      const linkedSection = contentEl.createEl("div", { cls: "augment-ctx-section" });
      linkedSection.createEl("div", {
        cls: "augment-ctx-section-label",
        text: `LINKED NOTES (${this.ctx.linkedNotes.length})`,
      });
      for (const note of this.ctx.linkedNotes) {
        const noteEl = linkedSection.createEl("div", { cls: "augment-ctx-linked-note" });
        noteEl.createEl("div", { cls: "augment-ctx-note-title", text: note.title });
        if (note.frontmatter && Object.keys(note.frontmatter).length > 0) {
          for (const [key, val] of Object.entries(note.frontmatter)) {
            const row = noteEl.createEl("div", { cls: "augment-ctx-fm-row" });
            row.createEl("span", { cls: "augment-ctx-fm-key", text: key });
            const valStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
            row.createEl("span", { text: valStr });
          }
        } else {
          noteEl.createEl("div", { cls: "augment-ctx-note-empty", text: "(no frontmatter)" });
        }
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
