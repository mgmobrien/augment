import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import { VaultContext } from "./vault-context";

export function getTemplateFiles(app: App, folderPath: string): TFile[] {
  const folder = app.vault.getAbstractFileByPath(folderPath);
  // DEBUG — remove after diagnosis
  const debugMsg = `[Augment debug] path="${folderPath}" type=${folder?.constructor?.name ?? "null"} children=${folder instanceof TFolder ? folder.children.length : "n/a"}`;
  console.log(debugMsg);
  new Notice(debugMsg, 8000);
  if (!(folder instanceof TFolder)) return [];
  folder.children.forEach((f, i) => {
    console.log(`[Augment debug] child[${i}] name="${f.name}" type=${f?.constructor?.name ?? "null"} isFile=${f instanceof TFile} ext=${f instanceof TFile ? f.extension : "n/a"}`);
  });
  return folder.children.filter(
    (f): f is TFile => f instanceof TFile && f.extension === "md"
  );
}

export class TemplatePicker extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private onChoose: (file: TFile) => void;

  constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Select a template...");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl("div", { text: file.basename });
    const desc = this.app.metadataCache.getFileCache(file)?.frontmatter?.["description"];
    if (desc && typeof desc === "string") {
      el.createEl("div", { cls: "augment-tpl-desc", text: desc });
    }
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

export class TemplatePreviewModal extends Modal {
  private renderedPrompt: string;
  private ctx: VaultContext;
  private onConfirm: (skipPreviewInFuture: boolean) => void;
  private skipPreview = false;

  constructor(
    app: App,
    renderedPrompt: string,
    ctx: VaultContext,
    onConfirm: (skipPreviewInFuture: boolean) => void
  ) {
    super(app);
    this.renderedPrompt = renderedPrompt;
    this.ctx = ctx;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-gen-preview-modal");

    const pre = contentEl.createEl("pre", { cls: "augment-gen-preview-prompt" });
    pre.setText(this.renderedPrompt);

    const linkedCount = this.ctx.linkedNotes.length;
    const summaryText =
      linkedCount > 0
        ? `Will include: ${this.ctx.title} + ${linkedCount} linked note${linkedCount > 1 ? "s" : ""}`
        : `Will include: ${this.ctx.title}`;
    contentEl.createEl("p", { text: summaryText, cls: "augment-gen-context-hint" });

    const charCount = this.renderedPrompt.length;
    const approxTokens = Math.round(charCount / 4);
    const isLarge = this.renderedPrompt.includes("{{note_content}}") ||
      this.renderedPrompt.includes("{{linked_notes_full}}") ||
      charCount > 4000;
    if (isLarge || charCount > 2000) {
      contentEl.createEl("p", {
        cls: "augment-gen-token-estimate" + (approxTokens > 4000 ? " is-large" : ""),
        text: `~${approxTokens.toLocaleString()} tokens (${charCount.toLocaleString()} chars)`,
      });
    }

    new Setting(contentEl)
      .setName("Don't show preview")
      .addToggle((toggle) => {
        toggle.setValue(false).onChange((val) => {
          this.skipPreview = val;
        });
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => this.close());
      })
      .addButton((btn) => {
        btn
          .setButtonText("Generate")
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm(this.skipPreview);
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
