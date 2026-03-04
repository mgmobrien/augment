import { App, Modal } from "obsidian";

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

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "augment-gen-input",
    });
    input.placeholder = "What do you want to generate?";
    input.addEventListener("input", () => {
      this.instruction = input.value;
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") this.submit();
    });
    setTimeout(() => input.focus(), 10);

    const btnRow = contentEl.createDiv({ cls: "augment-gen-btn-row" });
    const btn = btnRow.createEl("button", {
      text: "Generate",
      cls: "mod-cta",
    });
    btn.addEventListener("click", () => this.submit());
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
