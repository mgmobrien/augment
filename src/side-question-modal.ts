import { App, Modal, Notice } from "obsidian";

export interface SideQuestionModalOptions {
  onAsk: (question: string, signal: AbortSignal) => Promise<string>;
  onInsert: (answer: string) => Promise<boolean> | boolean;
}

export class SideQuestionModal extends Modal {
  private readonly options: SideQuestionModalOptions;
  private question = "";
  private answer = "";
  private hasAnswer = false;
  private isLoading = false;
  private questionEl: HTMLTextAreaElement | null = null;
  private answerSectionEl: HTMLDivElement | null = null;
  private answerPreEl: HTMLPreElement | null = null;
  private buttonRowEl: HTMLDivElement | null = null;
  private abortController: AbortController | null = null;

  constructor(app: App, options: SideQuestionModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("augment-side-question-modal");

    contentEl.createEl("h3", { text: "Ask side question" });
    contentEl.createEl("p", {
      cls: "augment-side-question-hint",
      text: "This answer is ephemeral. Nothing is written to the note unless you click Insert into note.",
    });
    contentEl.createEl("div", {
      cls: "augment-side-question-context",
      text: "Context: question only",
    });

    contentEl.createEl("div", {
      cls: "augment-side-question-label",
      text: "Question",
    });
    this.questionEl = contentEl.createEl("textarea", {
      cls: "augment-side-question-input",
      attr: {
        rows: "5",
        placeholder: "Why is this section unclear?",
      },
    });
    this.questionEl.addEventListener("input", () => {
      this.question = this.questionEl?.value ?? "";
    });
    this.questionEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !this.hasAnswer) {
        event.preventDefault();
        void this.submitQuestion();
      }
    });

    this.answerSectionEl = contentEl.createDiv({
      cls: "augment-side-question-answer-section",
    });
    this.answerSectionEl.createEl("div", {
      cls: "augment-side-question-label",
      text: "Answer",
    });
    this.answerPreEl = this.answerSectionEl.createEl("pre", {
      cls: "augment-side-question-preview",
    });

    this.buttonRowEl = contentEl.createDiv({
      cls: "augment-side-question-btn-row",
    });

    this.render();
    window.setTimeout(() => this.questionEl?.focus(), 10);
  }

  onClose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.contentEl.empty();
  }

  private render(): void {
    if (this.questionEl) {
      this.questionEl.disabled = this.isLoading || this.hasAnswer;
    }

    if (this.answerPreEl) {
      if (this.isLoading && !this.hasAnswer) {
        this.answerPreEl.setText("Generating answer...");
      } else if (!this.hasAnswer) {
        this.answerPreEl.setText("Ask one question to preview the answer outside the note.");
      } else {
        this.answerPreEl.setText(this.answer);
      }
    }

    if (!this.buttonRowEl) return;
    this.buttonRowEl.empty();

    const closeBtn = this.buttonRowEl.createEl("button", { text: "Close" });
    closeBtn.addEventListener("click", () => this.close());

    if (!this.hasAnswer) {
      const askBtn = this.buttonRowEl.createEl("button", {
        cls: "mod-cta",
        text: this.isLoading ? "Asking..." : "Ask",
      });
      askBtn.disabled = this.isLoading;
      askBtn.addEventListener("click", () => {
        void this.submitQuestion();
      });
      return;
    }

    const copyBtn = this.buttonRowEl.createEl("button", {
      text: "Copy",
    });
    copyBtn.disabled = this.isLoading;
    copyBtn.addEventListener("click", () => {
      void this.copyAnswer();
    });

    const insertBtn = this.buttonRowEl.createEl("button", {
      cls: "mod-cta",
      text: "Insert into note",
    });
    insertBtn.disabled = this.isLoading;
    insertBtn.addEventListener("click", () => {
      void this.insertAnswer();
    });
  }

  private async submitQuestion(): Promise<void> {
    const question = this.question.trim();
    if (!question) {
      new Notice("Enter a question first");
      return;
    }
    if (this.isLoading || this.hasAnswer) return;

    this.isLoading = true;
    this.answer = "";
    this.hasAnswer = false;
    const controller = new AbortController();
    this.abortController = controller;
    this.render();

    try {
      const answer = await this.options.onAsk(question, controller.signal);
      if (controller.signal.aborted) return;
      this.answer = answer;
      this.hasAnswer = true;
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      const lead = "Augment couldn't answer that side question.";
      new Notice(message ? `${lead} ${message}` : lead);
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
      this.isLoading = false;
      this.render();
    }
  }

  private async copyAnswer(): Promise<void> {
    if (!this.hasAnswer || this.isLoading) return;

    try {
      await navigator.clipboard.writeText(this.answer);
      new Notice("Augment: copied to clipboard", 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lead = "Augment couldn't copy this answer.";
      new Notice(message ? `${lead} ${message}` : lead);
    }
  }

  private async insertAnswer(): Promise<void> {
    if (!this.hasAnswer || this.isLoading) return;

    this.isLoading = true;
    this.render();

    try {
      const inserted = await this.options.onInsert(this.answer);
      if (inserted) this.close();
    } finally {
      this.isLoading = false;
      this.render();
    }
  }
}
