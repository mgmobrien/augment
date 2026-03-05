import { debounce, ItemView, MarkdownView, WorkspaceLeaf } from "obsidian";
import { buildSystemPrompt } from "./ai-client";
import AugmentTerminalPlugin from "./main";
import { assembleVaultContext, VaultContext } from "./vault-context";

export const VIEW_TYPE_CONTEXT_INSPECTOR = "augment-context-inspector";

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

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private render(ctx: VaultContext, activeView: MarkdownView): void {
    const el = this.contentDiv;

    // Header
    el.createEl("div", { cls: "augment-ctx-panel-header", text: "Context inspector" });
    el.createEl("div", {
      cls: "augment-ctx-panel-subtitle",
      text: "What Augment sends to the AI when you press Mod+Enter",
    });

    let totalTokens = 0;

    // ── System prompt section ──
    const sysSection = el.createEl("div", { cls: "augment-ctx-section" });
    const sysPromptText = buildSystemPrompt(ctx, this.plugin.settings.systemPrompt || undefined);
    const sysTokens = this.estimateTokens(sysPromptText);
    totalTokens += sysTokens;

    const sysDetails = sysSection.createEl("details");
    const sysSummary = sysDetails.createEl("summary", { cls: "augment-ctx-section-hdr" });
    sysSummary.createEl("span", { cls: "augment-ctx-section-label", text: "System prompt" });
    sysSummary.createEl("span", { cls: "augment-ctx-token-count", text: `~${sysTokens} tokens` });
    sysDetails.createEl("pre", { cls: "augment-ctx-pre augment-ctx-sys-pre", text: sysPromptText });

    // ── This note section ──
    const noteSection = el.createEl("div", { cls: "augment-ctx-section" });
    const noteHdr = noteSection.createEl("div", { cls: "augment-ctx-section-hdr" });

    // Build combined content for token count
    let noteContent = `Note: ${ctx.title}\n`;
    if (ctx.frontmatter && Object.keys(ctx.frontmatter).length > 0) {
      for (const [key, val] of Object.entries(ctx.frontmatter)) {
        const valStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
        noteContent += `${key}: ${valStr}\n`;
      }
    }
    if (ctx.selection) {
      noteContent += `\n${ctx.selection}`;
    } else if (ctx.surroundingContext) {
      noteContent += `\n${ctx.surroundingContext}`;
    }
    const noteTokens = this.estimateTokens(noteContent);
    totalTokens += noteTokens;

    noteHdr.createEl("span", {
      cls: "augment-ctx-section-label",
      text: `This note \u2014 \u201c${ctx.title}\u201d`,
    });
    noteHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${noteTokens} tokens` });

    // Frontmatter
    if (ctx.frontmatter && Object.keys(ctx.frontmatter).length > 0) {
      for (const [key, val] of Object.entries(ctx.frontmatter)) {
        const row = noteSection.createEl("div", { cls: "augment-ctx-fm-row" });
        row.createEl("span", { cls: "augment-ctx-fm-key", text: key });
        const valStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
        row.createEl("span", { text: valStr });
      }
    }

    // Text content
    if (ctx.selection) {
      noteSection.createEl("div", { cls: "augment-ctx-content-label", text: "Selected text" });
      noteSection.createEl("pre", { cls: "augment-ctx-pre", text: ctx.selection });
    } else {
      noteSection.createEl("pre", {
        cls: "augment-ctx-pre",
        text: ctx.surroundingContext || "(empty \u2014 position cursor in a note)",
      });
    }

    // ── Linked notes section ──
    if (ctx.linkedNotes.length > 0) {
      const linkedSection = el.createEl("div", { cls: "augment-ctx-section" });
      const linkedHdr = linkedSection.createEl("div", { cls: "augment-ctx-section-hdr" });

      // Count total links in the note for the "N of M" display
      const activeFile = activeView.file;
      const totalLinks = activeFile
        ? (this.app.metadataCache.getFileCache(activeFile)?.links ?? []).length
        : ctx.linkedNotes.length;

      let linkedContent = "";
      for (const note of ctx.linkedNotes) {
        linkedContent += `${note.title}\n`;
        if (note.frontmatter) {
          for (const [, val] of Object.entries(note.frontmatter)) {
            linkedContent += `${String(val)}\n`;
          }
        }
      }
      const linkedTokens = this.estimateTokens(linkedContent);
      totalTokens += linkedTokens;

      linkedHdr.createEl("span", {
        cls: "augment-ctx-section-label",
        text: `Linked notes (${ctx.linkedNotes.length} of ${totalLinks} linked)`,
      });
      linkedHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${linkedTokens} tokens` });

      linkedSection.createEl("div", {
        cls: "augment-ctx-linked-hint",
        text: "Augment sends each linked note\u2019s frontmatter, not its body.",
      });

      for (const note of ctx.linkedNotes) {
        const noteEl = linkedSection.createEl("div", { cls: "augment-ctx-linked-note" });
        noteEl.createEl("div", { cls: "augment-ctx-note-title", text: `\u25b8 ${note.title}` });
        if (note.frontmatter && Object.keys(note.frontmatter).length > 0) {
          for (const [key, val] of Object.entries(note.frontmatter)) {
            const valStr = Array.isArray(val) ? val.join(", ") : String(val ?? "");
            noteEl.createEl("div", {
              cls: "augment-ctx-linked-fm",
              text: `  ${key}: ${valStr}`,
            });
          }
        } else {
          noteEl.createEl("div", { cls: "augment-ctx-note-empty", text: "  (no frontmatter)" });
        }
      }
    }

    // ── Total ──
    const totalSection = el.createEl("div", { cls: "augment-ctx-section augment-ctx-total" });
    const totalHdr = totalSection.createEl("div", { cls: "augment-ctx-section-hdr" });
    totalHdr.createEl("span", { cls: "augment-ctx-section-label", text: "Total" });
    totalHdr.createEl("span", { cls: "augment-ctx-token-count", text: `~${totalTokens} tokens` });
  }

  async onClose(): Promise<void> {
    this.contentDiv.empty();
  }
}
