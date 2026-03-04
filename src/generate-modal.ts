import { App, Modal, Setting } from "obsidian";

export class GenerateModal extends Modal {
  private instruction: string = "";
  private noteTitle: string;
  private onSubmit: (instruction: string) => void;

  constructor(app: App, noteTitle: string, onSubmit: (instruction: string) => void) {
    super(app);
    this.noteTitle = noteTitle;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-gen-modal");

    contentEl.createEl("p", {
      text: `Using: ${this.noteTitle}`,
      cls: "augment-gen-context-hint",
    });

    new Setting(contentEl).addText((text) => {
      text.setPlaceholder("What do you want to generate?").onChange((value) => {
        this.instruction = value;
      });
      text.inputEl.addClass("augment-gen-input");
      text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") this.submit();
      });
      setTimeout(() => text.inputEl.focus(), 10);
    });

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText("Generate")
        .setCta()
        .onClick(() => this.submit());
    });
  }

  private submit(): void {
    const trimmed = this.instruction.trim();
    if (!trimmed) return;
    this.close();
    this.onSubmit(trimmed);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
