import { App, Modal, Notice } from "obsidian";

export interface TransformPreset {
  label: string;
  instruction: string;
  category: "quality" | "format" | "structure";
  directReplace: boolean;
}

const TRANSFORM_PRESETS: TransformPreset[] = [
  { label: "\u26A1 Fix/proofread", instruction: "Fix spelling, grammar, and punctuation. Preserve meaning and tone.", category: "quality", directReplace: true },
  { label: "Formalize", instruction: "Rewrite in clear, professional prose. Preserve meaning.", category: "quality", directReplace: false },
  { label: "Summarize", instruction: "Summarize this text concisely, preserving key information.", category: "structure", directReplace: false },
  { label: "Action items", instruction: "Extract action items as a markdown bullet list.", category: "structure", directReplace: false },
  { label: "\u2192 Table", instruction: "Convert this text into a well-structured markdown table.", category: "format", directReplace: false },
  { label: "Callout", instruction: "Wrap this text in an Obsidian callout block. Choose an appropriate callout type.", category: "format", directReplace: false },
];

export type TransformHistoryEntry = { role: "user" | "assistant"; content: string };

export interface SelectionTransformModalOptions {
  noteTitle: string;
  selectionText: string;
  onTransform: (
    instruction: string,
    history: TransformHistoryEntry[],
    signal: AbortSignal
  ) => Promise<string>;
  onReplace: (candidate: string) => Promise<boolean> | boolean;
  onKeepBoth: (candidate: string) => Promise<boolean> | boolean;
}

export class SelectionTransformModal extends Modal {
  private readonly options: SelectionTransformModalOptions;
  private instruction = "";
  private candidate = "";
  private hasCandidate = false;
  private isLoading = false;
  private isRefining = false;
  private history: TransformHistoryEntry[] = [];
  private activePreset: TransformPreset | null = null;
  private instructionEl: HTMLTextAreaElement | null = null;
  private instructionLabelEl: HTMLDivElement | null = null;
  private candidateSectionEl: HTMLDivElement | null = null;
  private candidatePreEl: HTMLPreElement | null = null;
  private buttonRowEl: HTMLDivElement | null = null;
  private presetsEl: HTMLDivElement | null = null;
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

    this.instructionLabelEl = contentEl.createDiv({
      cls: "augment-selection-transform-label",
      text: "Describe the change",
    });

    this.presetsEl = contentEl.createDiv({
      cls: "augment-selection-transform-presets",
    });
    for (const preset of TRANSFORM_PRESETS) {
      const chip = this.presetsEl.createEl("button", {
        cls: "augment-selection-transform-preset-chip",
        text: preset.label,
      });
      chip.addEventListener("click", () => {
        void this.activatePreset(preset);
      });
    }

    this.instructionEl = contentEl.createEl("textarea", {
      cls: "augment-selection-transform-input",
      attr: {
        rows: "5",
        placeholder: "Turn this into a markdown table",
      },
    });
    this.instructionEl.addEventListener("input", () => {
      this.instruction = this.instructionEl?.value ?? "";
      if (this.activePreset && this.instruction !== this.activePreset.label) {
        this.activePreset = null;
        this.renderPresetChips();
      }
    });
    this.instructionEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !this.hasCandidate) {
        event.preventDefault();
        if (event.shiftKey) {
          void this.submitDirectReplace();
        } else {
          void this.submitTransform();
        }
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

  private renderPresetChips(): void {
    if (!this.presetsEl) return;
    const chips = this.presetsEl.querySelectorAll(".augment-selection-transform-preset-chip");
    chips.forEach((chip, i) => {
      const preset = TRANSFORM_PRESETS[i];
      if (this.activePreset === preset) {
        chip.addClass("is-active");
      } else {
        chip.removeClass("is-active");
      }
    });
  }

  private async activatePreset(preset: TransformPreset): Promise<void> {
    if (this.isLoading || this.hasCandidate) return;

    this.activePreset = preset;
    this.renderPresetChips();

    if (preset.directReplace) {
      this.instruction = preset.instruction;
      void this.submitDirectReplace();
    } else {
      if (this.instructionEl) {
        this.instructionEl.value = preset.label;
      }
      this.instruction = preset.label;
      this.instructionEl?.focus();
    }
  }

  private render(): void {
    if (this.instructionEl) {
      this.instructionEl.disabled = this.isLoading || this.hasCandidate;
    }

    if (this.instructionLabelEl) {
      this.instructionLabelEl.setText(this.isRefining ? "Refine" : "Describe the change");
    }

    if (this.instructionEl && this.isRefining && !this.hasCandidate && !this.isLoading) {
      this.instructionEl.placeholder = "Make it shorter, reformat as bullets\u2026";
    } else if (this.instructionEl && !this.isRefining) {
      this.instructionEl.placeholder = "Turn this into a markdown table";
    }

    if (this.presetsEl) {
      const chips = this.presetsEl.querySelectorAll<HTMLButtonElement>(".augment-selection-transform-preset-chip");
      chips.forEach((chip) => {
        chip.disabled = this.isLoading || this.hasCandidate;
      });
      // Hide presets during refinement — they don't compose with follow-up instructions.
      this.presetsEl.style.display = this.isRefining ? "none" : "";
    }

    if (this.candidatePreEl) {
      if (this.isLoading && !this.hasCandidate) {
        this.candidatePreEl.setText(this.activePreset?.directReplace ? "Applying fix\u2026" : "Generating candidate\u2026");
      } else if (!this.hasCandidate && !this.isRefining) {
        this.candidatePreEl.setText("Generate a candidate to preview the change.");
      } else if (!this.hasCandidate && this.isRefining) {
        // Refining: show previous candidate while user types follow-up
        this.candidatePreEl.setText(this.candidate || "Generate a candidate to preview the change.");
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
        text: this.isLoading ? "Generating candidate\u2026" : "Generate candidate",
      });
      transformBtn.disabled = this.isLoading;
      transformBtn.addEventListener("click", () => {
        void this.submitTransform();
      });
      return;
    }

    // Candidate review buttons: Cancel | Refine | Keep both | Replace
    const refineBtn = this.buttonRowEl.createEl("button", {
      text: "Refine",
    });
    refineBtn.disabled = this.isLoading;
    refineBtn.addEventListener("click", () => {
      this.enterRefineMode();
    });

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

  private enterRefineMode(): void {
    if (this.isLoading) return;
    this.isRefining = true;
    this.hasCandidate = false;
    // Keep this.candidate so it stays visible in the preview
    if (this.instructionEl) {
      this.instructionEl.value = "";
      this.instruction = "";
    }
    this.activePreset = null;
    this.render();
    window.setTimeout(() => this.instructionEl?.focus(), 10);
  }

  private getEffectiveInstruction(): string {
    if (this.activePreset) {
      return this.activePreset.instruction;
    }
    return this.instruction.trim();
  }

  private async submitTransform(): Promise<void> {
    const instruction = this.getEffectiveInstruction();
    if (!instruction) {
      new Notice("Enter an instruction first");
      return;
    }
    if (this.isLoading) return;

    this.isLoading = true;
    this.hasCandidate = false;
    const controller = new AbortController();
    this.abortController = controller;
    this.render();

    try {
      const candidate = await this.options.onTransform(
        instruction,
        [...this.history],
        controller.signal
      );
      if (controller.signal.aborted) return;
      this.candidate = candidate;
      this.hasCandidate = true;
      // Accumulate history
      this.history.push({ role: "user", content: instruction });
      this.history.push({ role: "assistant", content: candidate });
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

  private async submitDirectReplace(): Promise<void> {
    const instruction = this.getEffectiveInstruction();
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
      const candidate = await this.options.onTransform(
        instruction,
        [...this.history],
        controller.signal
      );
      if (controller.signal.aborted) return;
      const applied = await this.options.onReplace(candidate);
      if (applied) {
        this.close();
        return;
      }
      this.candidate = candidate;
      this.hasCandidate = true;
      this.history.push({ role: "user", content: instruction });
      this.history.push({ role: "assistant", content: candidate });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      const lead = "Augment couldn't apply the transform.";
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
