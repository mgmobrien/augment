import { ItemView, MarkdownView, setIcon, WorkspaceLeaf } from "obsidian";
import { buildSystemPrompt, buildUserMessage } from "./ai-client";
import AugmentTerminalPlugin from "./main";
import { assembleVaultContext, VaultContext } from "./vault-context";

export const VIEW_TYPE_CONTEXT_INSPECTOR = "augment-context-inspector";

// Input/output price in USD per million tokens.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00  },
  "claude-sonnet-4-6":         { input: 3.00,  output: 15.00 },
  "claude-opus-4-6":           { input: 15.00, output: 75.00 },
};
const DEFAULT_PRICING = { input: 3.00, output: 15.00 }; // sonnet as fallback

const MAX_TOKENS = 1024; // matches max_tokens in generateText

function inputCost(tokens: number, modelId: string): number {
  const pricing = MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
  return (tokens * pricing.input) / 1_000_000;
}

function outputCost(tokens: number, modelId: string): number {
  const pricing = MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
  return (tokens * pricing.output) / 1_000_000;
}

function formatCost(dollars: number): string {
  if (dollars < 0.0001) return `$${dollars.toFixed(6)}`;
  if (dollars < 0.001)  return `$${dollars.toFixed(5)}`;
  if (dollars < 0.01)   return `$${dollars.toFixed(4)}`;
  if (dollars < 0.10)   return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type InspectorState = "cursor" | "post-generation";

function formatTimeAgo(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

export class ContextInspectorView extends ItemView {
  private plugin: AugmentTerminalPlugin;
  private contentDiv!: HTMLElement;
  private lastEditorView: MarkdownView | null = null;
  private state: InspectorState = "cursor";
  private generatedAt: number = 0;

  constructor(leaf: WorkspaceLeaf, plugin: AugmentTerminalPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_CONTEXT_INSPECTOR; }
  getDisplayText(): string { return "Context inspector"; }
  getIcon(): string { return "eye"; }

  async onOpen(): Promise<void> {
    this.contentDiv = this.containerEl.children[1] as HTMLElement;
    this.contentDiv.addClass("augment-ctx-panel");

    // Track active editor (no auto-refresh on switch)
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastEditorView = leaf.view;
        }
      })
    );

    // Trigger 1: generation completes → post-generation state
    this.registerEvent(
      (this.app.workspace as any).on("augment:generation-complete", () => {
        this.state = "post-generation";
        this.generatedAt = Date.now();
        this.refresh();
      })
    );

    // Trigger 2: manual refresh button (handled in render) → cursor state

    const current = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (current) this.lastEditorView = current;
    this.refresh();
  }

  private refreshToCursor(): void {
    this.state = "cursor";
    this.refresh();
  }

  private refresh(): void {
    this.contentDiv.empty();
    if (!this.lastEditorView) {
      this.contentDiv.createEl("div", {
        cls: "augment-ctx-empty",
        text: "Open a note to inspect its context.",
      });
      return;
    }
    const ctx = assembleVaultContext(
      this.plugin.app,
      this.lastEditorView.editor,
      this.plugin.settings
    );
    this.render(ctx, this.lastEditorView);
  }

  private render(ctx: VaultContext, activeView: MarkdownView): void {
    const el = this.contentDiv;

    // ── Header ──
    const headerEl = el.createEl("div", { cls: "augment-ctx-panel-header" });
    const headerLeft = headerEl.createEl("span", { cls: "augment-ctx-panel-header-left" });
    const iconEl = headerLeft.createEl("span", { cls: "augment-ctx-panel-header-icon" });
    setIcon(iconEl, "radio-tower");
    headerLeft.createEl("span", { text: "Context inspector" });
    const refreshBtn = headerEl.createEl("span", { cls: "augment-ctx-refresh clickable-icon" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refreshToCursor());

    const subtitleEl = el.createEl("div", { cls: "augment-ctx-panel-subtitle" });
    if (this.state === "post-generation") {
      subtitleEl.createEl("span", {
        text: `Sent last generation \u00b7 ${formatTimeAgo(this.generatedAt)}`,
      });
      const backLink = subtitleEl.createEl("span", {
        cls: "augment-ctx-back-to-cursor",
        text: "back to cursor \u2191",
      });
      backLink.addEventListener("click", () => this.refreshToCursor());
    } else {
      subtitleEl.setText("What Augment sends when you generate");
    }

    // Build all text blocks for token counting
    const sysPromptText = buildSystemPrompt(ctx, this.plugin.settings.systemPrompt || undefined);
    const userMsgText = buildUserMessage(ctx, "Continue writing.");
    const sysTokens = estimateTokens(sysPromptText);
    const noteTokens = estimateTokens(userMsgText);

    // Per-linked-note token counts and content
    const linkedData = ctx.linkedNotes.map((note) => {
      let text = `Linked note: ${note.title}`;
      if (note.frontmatter) {
        for (const [key, val] of Object.entries(note.frontmatter)) {
          const valStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
          text += `\n${key}: ${valStr}`;
        }
      }
      return { note, text, tokens: estimateTokens(text) };
    });
    const linkedTokens = linkedData.reduce((sum, d) => sum + d.tokens, 0);
    const totalTokens = sysTokens + noteTokens + linkedTokens;

    // ── Pinned token bar (collapsible) ──
    const modelId = this.plugin.resolveModel();
    const modelName = this.plugin.resolveModelDisplayName();
    const pricing = MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
    const inCost = inputCost(totalTokens, modelId);
    const estOutputTokens = Math.round(MAX_TOKENS / 4);
    const outCost = outputCost(estOutputTokens, modelId);
    const totalCost = inCost + outCost;

    const tokenBar = el.createEl("div", { cls: "augment-ctx-token-bar" });
    tokenBar.createEl("span", {
      cls: "augment-ctx-token-bar-summary",
      text: `${totalTokens.toLocaleString()} tokens \u00b7 ~${formatCost(totalCost)}`,
    });
    const barChevron = tokenBar.createEl("span", { cls: "augment-ctx-token-bar-chevron" });
    setIcon(barChevron, "chevron-right");
    tokenBar.addEventListener("click", () => {
      tokenBar.toggleClass("is-open", !tokenBar.hasClass("is-open"));
    });

    const detail = el.createEl("div", { cls: "augment-ctx-token-bar-detail" });

    const addRow = (label: string, value: string) => {
      const row = detail.createEl("div", { cls: "augment-ctx-token-bar-row" });
      row.createEl("span", { cls: "augment-ctx-token-bar-label", text: label });
      row.createEl("span", { cls: "augment-ctx-token-bar-value", text: value });
    };

    addRow("Model", modelName);
    addRow("Input", `${totalTokens.toLocaleString()} tok  \u00b7  ~${formatCost(inCost)}  ($${pricing.input}/Mtok)`);
    addRow("Output", `~${estOutputTokens.toLocaleString()} tok  \u00b7  ~${formatCost(outCost)}  ($${pricing.output}/Mtok, est.)`);
    addRow("Total", `~${formatCost(totalCost)}`);

    // ── Scrollable content ──
    const scroll = el.createEl("div", { cls: "augment-ctx-panel-body" });

    // ── System prompt section ──
    const sysSection = scroll.createEl("div", { cls: "augment-ctx-section augment-ctx-collapsible" });
    const sysHdr = sysSection.createEl("div", { cls: "augment-ctx-section-hdr" });
    const sysChevron = sysHdr.createEl("span", { cls: "augment-ctx-chevron" });
    setIcon(sysChevron, "chevron-right");
    sysHdr.createEl("span", { cls: "augment-ctx-section-label", text: "System prompt" });
    const sysEditBtn = sysHdr.createEl("span", { cls: "augment-ctx-edit-btn clickable-icon" });
    setIcon(sysEditBtn, "pencil");
    sysEditBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't toggle collapsible
      const setting = (this.app as any).setting;
      setting.open();
      setting.openTabById("augment-terminal");
      // Switch to Continuation tab after settings DOM renders
      setTimeout(() => {
        const tab = setting.containerEl?.querySelector?.(".augment-tab:nth-child(2)") as HTMLElement;
        tab?.click();
        // Focus system prompt textarea
        setTimeout(() => {
          const textarea = setting.containerEl?.querySelector?.("textarea") as HTMLTextAreaElement;
          textarea?.focus();
        }, 50);
      }, 50);
    });
    sysHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${sysTokens} tokens` });
    const sysContent = sysSection.createEl("div", { cls: "augment-ctx-collapsible-content" });
    sysContent.createEl("div", { cls: "augment-ctx-block", text: sysPromptText });
    sysHdr.addEventListener("click", () => {
      sysSection.toggleClass("is-open", !sysSection.hasClass("is-open"));
    });

    // ── Current note section (collapsible, default expanded) ──
    const noteSection = scroll.createEl("div", { cls: "augment-ctx-section augment-ctx-collapsible is-open" });
    const noteHdr = noteSection.createEl("div", { cls: "augment-ctx-section-hdr" });
    const noteChevron = noteHdr.createEl("span", { cls: "augment-ctx-chevron" });
    setIcon(noteChevron, "chevron-right");
    noteHdr.createEl("span", {
      cls: "augment-ctx-section-label",
      text: `This note \u2014 \u201c${ctx.title}\u201d`,
    });
    noteHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${noteTokens} tokens` });
    const noteContent = noteSection.createEl("div", { cls: "augment-ctx-collapsible-content" });
    const noteBlock = noteContent.createEl("div", { cls: "augment-ctx-block" });
    noteBlock.setText(userMsgText);
    noteHdr.addEventListener("click", () => {
      noteSection.toggleClass("is-open", !noteSection.hasClass("is-open"));
    });

    // ── Linked notes section (omitted if zero) ──
    if (linkedData.length > 0) {
      const linkedSection = scroll.createEl("div", { cls: "augment-ctx-section" });
      const activeFile = activeView.file;
      const totalLinks = activeFile
        ? (this.app.metadataCache.getFileCache(activeFile)?.links ?? []).length
        : linkedData.length;

      const linkedHdr = linkedSection.createEl("div", { cls: "augment-ctx-section-hdr" });
      linkedHdr.createEl("span", {
        cls: "augment-ctx-section-label",
        text: `Linked notes (${linkedData.length} of ${totalLinks})`,
      });
      linkedHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${linkedTokens} tokens` });

      const list = linkedSection.createEl("div", { cls: "augment-ctx-linked-list" });
      for (const { note, text, tokens } of linkedData) {
        const row = list.createEl("div", { cls: "augment-ctx-linked-row" });

        const header = row.createEl("div", { cls: "augment-ctx-linked-row-header" });
        const chevron = header.createEl("span", { cls: "augment-ctx-linked-chevron" });
        setIcon(chevron, "chevron-right");
        header.createEl("span", { cls: "augment-ctx-linked-row-title", text: note.title });
        header.createEl("span", { cls: "augment-ctx-linked-row-token-count", text: `~${tokens}` });

        const content = row.createEl("div", { cls: "augment-ctx-linked-row-content" });
        content.createEl("div", { cls: "augment-ctx-block", text });

        header.addEventListener("click", () => {
          row.toggleClass("is-open", !row.hasClass("is-open"));
        });
      }
    }
  }

  async onClose(): Promise<void> {
    this.contentDiv.empty();
  }
}
