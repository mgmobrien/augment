import { App, FuzzySuggestModal, Modal, Setting, TFile, TFolder } from "obsidian";
import { VaultContext } from "./vault-context";

export function getTemplateFiles(app: App, folderPath: string): TFile[] {
  const folder = app.vault.getFolderByPath(folderPath);
  if (!(folder instanceof TFolder)) return [];
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

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

export class TemplatePreviewModal extends Modal {
  private renderedPrompt: string;
  private ctx: VaultContext;
  private onConfirm: () => void;

  constructor(app: App, renderedPrompt: string, ctx: VaultContext, onConfirm: () => void) {
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
            this.onConfirm();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
