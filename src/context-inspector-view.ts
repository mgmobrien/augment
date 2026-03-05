import { debounce, ItemView, MarkdownView, setIcon, WorkspaceLeaf } from "obsidian";
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

function estimateCost(inputTokens: number, modelId: string): number {
  const pricing = MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
  const outputTokens = 1024; // max_tokens configured in generateText
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
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

export class ContextInspectorView extends ItemView {
  private plugin: AugmentTerminalPlugin;
  private contentDiv!: HTMLElement;
  private lastEditorView: MarkdownView | null = null;
  private debouncedRefresh!: () => void;

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
    this.debouncedRefresh = debounce(() => this.refresh(), 300, true);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastEditorView = leaf.view;
          this.debouncedRefresh();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", this.debouncedRefresh)
    );

    const current = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (current) this.lastEditorView = current;
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
    el.createEl("div", { cls: "augment-ctx-panel-header", text: "Context inspector" });
    el.createEl("div", {
      cls: "augment-ctx-panel-subtitle",
      text: "What Augment sends when you generate",
    });

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

    // ── Pinned token bar ──
    const modelId = this.plugin.resolveModel();
    const cost = estimateCost(totalTokens, modelId);
    el.createEl("div", {
      cls: "augment-ctx-token-bar",
      text: `~${totalTokens.toLocaleString()} tokens \u00b7 ~${formatCost(cost)} per generation`,
    });

    // ── Scrollable content ──
    const scroll = el.createEl("div", { cls: "augment-ctx-scroll" });

    // ── System prompt section ──
    const sysSection = scroll.createEl("div", { cls: "augment-ctx-section" });
    const sysDetails = sysSection.createEl("details");
    const sysSummary = sysDetails.createEl("summary", { cls: "augment-ctx-section-hdr" });
    sysSummary.createEl("span", { cls: "augment-ctx-section-label", text: "System prompt" });
    sysSummary.createEl("span", { cls: "augment-ctx-token-count", text: `~${sysTokens} tokens` });
    sysDetails.createEl("div", { cls: "augment-ctx-block", text: sysPromptText });

    // ── Current note section ──
    const noteSection = scroll.createEl("div", { cls: "augment-ctx-section" });
    const noteHdr = noteSection.createEl("div", { cls: "augment-ctx-section-hdr" });
    noteHdr.createEl("span", {
      cls: "augment-ctx-section-label",
      text: `This note \u2014 \u201c${ctx.title}\u201d`,
    });
    noteHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${noteTokens} tokens` });

    const noteBlock = noteSection.createEl("div", { cls: "augment-ctx-block" });
    noteBlock.setText(userMsgText);

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
