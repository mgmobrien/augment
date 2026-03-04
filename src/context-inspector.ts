import { App, Modal } from "obsidian";
import { ContextEntry } from "./vault-context";

export class ContextInspectorModal extends Modal {
  private entries: ContextEntry[];
  private index: number;

  constructor(app: App, entries: ContextEntry[], index: number) {
    super(app);
    this.entries = entries;
    this.index = index;
    this.modalEl.addClass("augment-context-modal");
  }

  onOpen(): void {
    this.titleEl.setText("Context inspector");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const entry = this.entries[this.index];
    const isPreview = entry.timestamp === 0;
    const hasMultiple = this.entries.length > 1;

    // Navigation (history mode only)
    if (hasMultiple) {
      const nav = contentEl.createEl("div", { cls: "augment-ctx-nav" });

      const prevBtn = nav.createEl("button", { text: "\u2190 prev" });
      prevBtn.disabled = this.index === 0;
      prevBtn.addEventListener("click", () => { this.index--; this.render(); });

      const runLabel = `Run ${this.index + 1} of ${this.entries.length}`;
      const timeLabel = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      nav.createEl("span", {
        cls: "augment-ctx-nav-meta",
        text: [runLabel, entry.model, timeLabel].join(" \u00b7 "),
      });

      const nextBtn = nav.createEl("button", { text: "next \u2192" });
      nextBtn.disabled = this.index === this.entries.length - 1;
      nextBtn.addEventListener("click", () => { this.index++; this.render(); });
    } else {
      const parts = [entry.noteName, entry.model];
      if (isPreview) parts.push("preview");
      else parts.push(new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      contentEl.createEl("div", { cls: "augment-ctx-single-meta", text: parts.join(" \u00b7 ") });
    }

    this.renderSection(contentEl, "System prompt", entry.systemPrompt);
    this.renderSection(
      contentEl,
      isPreview ? "User message (placeholder)" : "User message",
      entry.userMessage,
    );
  }

  private renderSection(parent: HTMLElement, label: string, content: string): void {
    const section = parent.createEl("div", { cls: "augment-ctx-section" });

    const hdr = section.createEl("div", { cls: "augment-ctx-section-hdr" });
    hdr.createEl("span", { cls: "augment-ctx-section-label", text: label });
    const copyBtn = hdr.createEl("button", { cls: "augment-ctx-copy", text: "copy" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(content);
      copyBtn.setText("copied");
      setTimeout(() => copyBtn.setText("copy"), 1500);
    });

    section.createEl("pre", { cls: "augment-ctx-pre", text: content });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
