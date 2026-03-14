import { App, Modal, Notice } from "obsidian";

export interface SelectionTransformModalOptions {
  noteTitle: string;
  selectionText: string;
  onTransform: (instruction: string, signal: AbortSignal) => Promise<string>;
  onReplace: (candidate: string) => Promise<boolean> | boolean;
  onKeepBoth: (candidate: string) => Promise<boolean> | boolean;
}

export class SelectionTransformModal extends Modal {
  private readonly options: SelectionTransformModalOptions;
  private instruction = "";
  private candidate = "";
  private hasCandidate = false;
  private isLoading = false;
  private instructionEl: HTMLTextAreaElement | null = null;
  private candidateSectionEl: HTMLDivElement | null = null;
  private candidatePreEl: HTMLPreElement | null = null;
  private buttonRowEl: HTMLDivElement | null = null;
  private abortController: AbortController | null = null;

  constructor(app: App, options: SelectionTransformModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-selection-transform-modal");

    contentEl.createEl("h3", { text: "Transform selection" });
    contentEl.createEl("p", {
      cls: "augment-selection-transform-hint",
      text: "Review the candidate before changing the selected text. Nothing in the note changes until you click Replace or Keep both.",
    });
    contentEl.createEl("div", {
      cls: "augment-selection-transform-context",
      text: "Context: selection only",
    });

    contentEl.createEl("div", {
      cls: "augment-selection-transform-label",
      text: "Selected text",
    });
    const selectionPre = contentEl.createEl("pre", {
      cls: "augment-selection-transform-preview",
    });
    selectionPre.setText(this.options.selectionText);

    contentEl.createEl("div", {
      cls: "augment-selection-transform-label",
      text: "Describe the change",
    });
    this.instructionEl = contentEl.createEl("textarea", {
      cls: "augment-selection-transform-input",
      attr: {
        rows: "5",
        placeholder: "Turn this into a markdown table",
      },
    });
    this.instructionEl.addEventListener("input", () => {
      this.instruction = this.instructionEl?.value ?? "";
    });
    this.instructionEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !this.hasCandidate) {
        event.preventDefault();
        void this.submitTransform();
      }
    });

    this.candidateSectionEl = contentEl.createDiv({
      cls: "augment-selection-transform-candidate-section",
    });
    this.candidateSectionEl.createEl("div", {
      cls: "augment-selection-transform-label",
      text: "Candidate",
    });
    this.candidatePreEl = this.candidateSectionEl.createEl("pre", {
      cls: "augment-selection-transform-preview",
    });

    this.buttonRowEl = contentEl.createDiv({
      cls: "augment-selection-transform-btn-row",
    });

    this.render();
    window.setTimeout(() => this.instructionEl?.focus(), 10);
  }

  onClose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.contentEl.empty();
  }

  private render(): void {
    if (this.instructionEl) {
      this.instructionEl.disabled = this.isLoading || this.hasCandidate;
    }

    if (this.candidatePreEl) {
      if (this.isLoading && !this.hasCandidate) {
        this.candidatePreEl.setText("Generating candidate…");
      } else if (!this.hasCandidate) {
        this.candidatePreEl.setText("Generate a candidate to preview the change.");
      } else {
        this.candidatePreEl.setText(this.candidate);
      }
    }

    if (!this.buttonRowEl) return;
    this.buttonRowEl.empty();

    const cancelBtn = this.buttonRowEl.createEl("button", { text: "Cancel" });
    cancelBtn.disabled = false;
    cancelBtn.addEventListener("click", () => this.close());

    if (!this.hasCandidate) {
      const transformBtn = this.buttonRowEl.createEl("button", {
        cls: "mod-cta",
        text: this.isLoading ? "Generating candidate…" : "Generate candidate",
      });
      transformBtn.disabled = this.isLoading;
      transformBtn.addEventListener("click", () => {
        void this.submitTransform();
      });
      return;
    }

    const keepBothBtn = this.buttonRowEl.createEl("button", {
      text: "Keep both",
    });
    keepBothBtn.disabled = this.isLoading;
    keepBothBtn.addEventListener("click", () => {
      void this.applyCandidate("keep-both");
    });

    const replaceBtn = this.buttonRowEl.createEl("button", {
      cls: "mod-cta",
      text: "Replace",
    });
    replaceBtn.disabled = this.isLoading;
    replaceBtn.addEventListener("click", () => {
      void this.applyCandidate("replace");
    });
  }

  private async submitTransform(): Promise<void> {
    const instruction = this.instruction.trim();
    if (!instruction) {
      new Notice("Enter an instruction first");
      return;
    }
    if (this.isLoading) return;

    this.isLoading = true;
    this.candidate = "";
    this.hasCandidate = false;
    const controller = new AbortController();
    this.abortController = controller;
    this.render();

    try {
      const candidate = await this.options.onTransform(instruction, controller.signal);
      if (controller.signal.aborted) return;
      this.candidate = candidate;
      this.hasCandidate = true;
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      const lead = "Augment couldn't generate a candidate for this selection.";
      new Notice(message ? `${lead} ${message}` : lead);
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async applyCandidate(mode: "replace" | "keep-both"): Promise<void> {
    if (!this.hasCandidate || this.isLoading) return;

    this.isLoading = true;
    this.render();

    try {
      const applied = mode === "replace"
        ? await this.options.onReplace(this.candidate)
        : await this.options.onKeepBoth(this.candidate);
      if (applied) this.close();
    } finally {
      this.isLoading = false;
      this.render();
    }
  }
}
