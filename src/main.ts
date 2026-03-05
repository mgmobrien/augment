import { MarkdownView, Modal, Notice, Plugin, Setting } from "obsidian";
import { applyOutputFormat, bestModelId, buildSystemPrompt, buildUserMessage, fetchModels, generateText, ModelInfo, modelDisplayName, substituteVariables } from "./ai-client";
import { ContextInspectorModal } from "./context-inspector";
import { AugmentSettingTab } from "./settings-tab";
import { getTemplateFiles, TemplatePicker, TemplatePreviewModal } from "./template-picker";
import { assembleVaultContext, AugmentSettings, ContextEntry, DEFAULT_SETTINGS } from "./vault-context";
import { TerminalView, VIEW_TYPE_TERMINAL, cleanupXtermStyle } from "./terminal-view";
import { TerminalManagerView, VIEW_TYPE_TERMINAL_MANAGER } from "./terminal-manager-view";
import { TerminalSwitcherModal } from "./terminal-switcher";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";

// Default template files written to vault on first install
const SCAFFOLD_FOLDER = "Augment/templates";
const SCAFFOLD_TEMPLATES: [string, string][] = [
  [
    "Summarize whole note",
    `---
description: Reads the entire note — use for summaries, head blocks, and full-note responses
---
{{note_content}}
`,
  ],
  [
    "Generate with linked notes",
    `---
description: Includes full content of wikilinked notes — use for synthesis across connected notes
---
{{note_content}}

---

Linked notes:

{{linked_notes_full}}
`,
  ],
];

// CM6 spinner widget — inserts an HTML triangle animation at cursor without modifying document text
const addSpinnerEffect = StateEffect.define<number>();
const removeSpinnerEffect = StateEffect.define<null>();

class SpinnerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "augment-spinner";
    for (const cls of ["augment-dot-red", "augment-dot-green", "augment-dot-blue"]) {
      const dot = document.createElement("span");
      dot.className = "augment-spinner-dot " + cls;
      wrap.appendChild(dot);
    }
    return wrap;
  }
  ignoreEvent(): boolean { return true; }
}

const spinnerField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addSpinnerEffect)) {
        decos = decos.update({ add: [Decoration.widget({ widget: new SpinnerWidget(), side: 1 }).range(e.value)] });
      } else if (e.is(removeSpinnerEffect)) {
        decos = Decoration.none;
      }
    }
    return decos;
  },
  provide: f => EditorView.decorations.from(f),
});

type TeamCreateSpawnEvent = {
  sourceName?: string;
  team?: string;
  members?: string[];
};

class RenameModal extends Modal {
  private view: TerminalView;
  private newName: string;

  constructor(app: any, view: TerminalView) {
    super(app);
    this.view = view;
    this.newName = view.getName();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Rename terminal" });

    new Setting(contentEl)
      .setName("Name")
      .addText((text) => {
        text.setValue(this.newName);
        text.onChange((value) => {
          this.newName = value;
        });
        text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            this.submit();
          }
        });
        // Focus and select all text
        setTimeout(() => {
          text.inputEl.focus();
          text.inputEl.select();
        }, 10);
      });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText("Rename")
          .setCta()
          .onClick(() => this.submit());
      });
  }

  private submit(): void {
    const trimmed = this.newName.trim();
    if (trimmed) {
      this.view.setName(trimmed);
    }
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class AugmentTerminalPlugin extends Plugin {
  settings: AugmentSettings = { ...DEFAULT_SETTINGS };
  public availableModels: ModelInfo[] = [];
  public contextHistory: ContextEntry[] = [];
  private recentTeamCreateSpawnSignatures: Map<string, number> = new Map();
  private calloutStyleEl: HTMLStyleElement | null = null;
  private statusBarEl: HTMLElement | null = null;

  // Returns the actual model ID to use, resolving "auto" to the best available.
  public resolveModel(): string {
    if (this.settings.model !== "auto") return this.settings.model;
    return bestModelId(this.availableModels) ?? "claude-opus-4-6";
  }

  // Display name for the resolved model — used in status bar and output formats.
  public resolveModelDisplayName(): string {
    const id = this.resolveModel();
    const found = this.availableModels.find(m => m.id === id);
    return found?.display_name ?? modelDisplayName(id);
  }

  public refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    if (!this.settings.apiKey) {
      this.statusBarEl.setText("Augment: API key needed");
    } else {
      this.statusBarEl.setText(`Augment: ${this.resolveModelDisplayName()}`);
    }
  }

  private pushContextHistory(entry: ContextEntry): void {
    this.contextHistory.push(entry);
    if (this.contextHistory.length > 5) this.contextHistory.shift();
  }

  private async loadAvailableModels(): Promise<void> {
    if (!this.settings.apiKey) return;
    this.availableModels = await fetchModels(this.settings.apiKey);
    // Refresh status bar in case "auto" now resolves to a fetched model name.
    this.refreshStatusBar();
  }

  private async scaffoldDefaultTemplates(): Promise<void> {
    // Only scaffold when templateFolder has never been configured.
    if (this.settings.templateFolder) return;

    // Create folder if absent.
    if (!this.app.vault.getFolderByPath(SCAFFOLD_FOLDER)) {
      try { await this.app.vault.createFolder(SCAFFOLD_FOLDER); } catch { /* already exists */ }
    }

    // Create each template file idempotently — never overwrite.
    for (const [name, content] of SCAFFOLD_TEMPLATES) {
      const path = `${SCAFFOLD_FOLDER}/${name}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.create(path, content); } catch { /* already exists */ }
      }
    }

    // Set templateFolder so the picker finds the scaffolded files.
    this.settings.templateFolder = SCAFFOLD_FOLDER;
    await this.saveData(this.settings);
  }

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Scaffold default templates on first install (fire-and-forget — doesn't block onload).
    void this.scaffoldDefaultTemplates();

    // Fetch available models in the background — populates the model dropdown
    // and resolves "auto" to the best available model name in the status bar.
    void this.loadAvailableModels();

    this.calloutStyleEl = document.head.createEl("style");
    this.calloutStyleEl.id = "augment-callout-styles";
    this.calloutStyleEl.textContent = [
      `.callout[data-callout="ai"] { --callout-icon: bot; --callout-color: 139, 92, 246; }`,
      `.callout[data-callout="ai"] .callout-icon { display: flex !important; }`,
      `.callout[data-callout="ai"] .callout-title::before { content: "" !important; display: none !important; }`,
    ].join("\n");

    // Register views
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      return new TerminalView(leaf, this.getPluginDir(), () => this.settings.useWsl);
    });
    this.registerView(VIEW_TYPE_TERMINAL_MANAGER, (leaf) => {
      return new TerminalManagerView(leaf);
    });

    this.registerEditorExtension(spinnerField);

    // AI generation commands
    this.addCommand({
      id: "augment-generate",
      name: "Generate",
      hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        if (!this.settings.apiKey) {
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }

        const cursor = editor.getCursor();
        const aboveCursor = editor.getRange({ line: 0, ch: 0 }, cursor);
        const promptText = aboveCursor.trim() || editor.getValue().trim();
        const ctx = assembleVaultContext(this.app, editor, this.settings);

        if (this.statusBarEl) {
          this.statusBarEl.empty();
          const sbSpinner = this.statusBarEl.createEl("span", { cls: "augment-sb-spinner" });
          sbSpinner.createEl("span", { cls: "augment-sb-dot" });
          sbSpinner.createEl("span", { cls: "augment-sb-dot" });
          sbSpinner.createEl("span", { cls: "augment-sb-dot" });
          this.statusBarEl.createEl("span", { text: " generating" });
        }

        const isBlock = this.settings.outputFormat !== "plain";
        let insertPos: number;
        if (isBlock && cursor.ch > 0) {
          editor.replaceRange("\n", cursor);
          insertPos = editor.posToOffset({ line: cursor.line + 1, ch: 0 });
        } else {
          insertPos = editor.posToOffset(cursor);
        }

        const cmView = (editor as any).cm as EditorView;
        cmView.dispatch({ effects: addSpinnerEffect.of(insertPos), selection: EditorSelection.cursor(insertPos, 1) });

        void (async () => {
          try {
            const resolvedModel = this.resolveModel();
            const resolvedModelName = this.resolveModelDisplayName();
            const result = await generateText(buildSystemPrompt(ctx), promptText, this.settings, resolvedModel);
            cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
            const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
            const insertPosLine = editor.offsetToPos(insertPos);
            if (isBlock) {
              const withTrail = formatted + "\n";
              editor.replaceRange(withTrail, insertPosLine);
              const lines = withTrail.split("\n");
              editor.setCursor({ line: insertPosLine.line + lines.length - 1, ch: 0 });
            } else {
              editor.replaceRange(formatted, insertPosLine);
            }
            const entry: ContextEntry = {
              timestamp: Date.now(),
              noteName: ctx.title,
              model: resolvedModelName,
              systemPrompt: buildSystemPrompt(ctx),
              userMessage: buildUserMessage(ctx, promptText),
            };
            this.pushContextHistory(entry);
            const notice = new Notice("", 5000);
            notice.noticeEl.empty();
            notice.noticeEl.createEl("span", { text: "Augment: done" });
            notice.noticeEl.createEl("span", { cls: "augment-notice-sep", text: " \u00b7 " });
            const viewLink = notice.noticeEl.createEl("a", { cls: "augment-notice-action", text: "view context" });
            viewLink.href = "#";
            viewLink.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              notice.hide();
              new ContextInspectorModal(this.app, ctx).open();
            });
            if (!this.settings.hasGenerated) {
              this.settings.hasGenerated = true;
              await this.saveData(this.settings);
            }
          } catch (err) {
            console.error("[Augment]", err);
            cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
            new Notice(`Augment: generation failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            this.refreshStatusBar();
          }
        })();
      },
    });

    this.addCommand({
      id: "augment-generate-from-template",
      name: "Generate from template",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        if (!this.settings.apiKey) {
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        if (!this.settings.templateFolder) {
          const notice = new Notice("Augment: no template folder set \u2014 click to configure", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        const files = getTemplateFiles(this.app, this.settings.templateFolder);
        if (files.length === 0) {
          new Notice(`Augment: no templates found in ${this.settings.templateFolder}`);
          return;
        }
        const cursor = editor.getCursor();
        const ctx = assembleVaultContext(this.app, editor, this.settings);
        new TemplatePicker(this.app, files, async (templateFile) => {
          const templateContent = await this.app.vault.read(templateFile);

          // Lazy full-content reads — only when the template actually uses the variables.
          if (templateContent.includes("{{note_content}}")) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) ctx.content = await this.app.vault.read(activeFile);
          }
          if (templateContent.includes("{{linked_notes_full}}")) {
            for (const note of ctx.linkedNotes) {
              const file = this.app.vault.getFiles().find((f) => f.basename === note.title);
              if (file) {
                try { note.content = await this.app.vault.read(file); } catch { /* skip */ }
              }
            }
          }

          const rendered = substituteVariables(templateContent, ctx);

          const runGenerate = async () => {
            if (this.statusBarEl) {
              this.statusBarEl.empty();
              const sbSpinner = this.statusBarEl.createEl("span", { cls: "augment-sb-spinner" });
              sbSpinner.createEl("span", { cls: "augment-sb-dot" });
              sbSpinner.createEl("span", { cls: "augment-sb-dot" });
              sbSpinner.createEl("span", { cls: "augment-sb-dot" });
              this.statusBarEl.createEl("span", { text: " generating" });
            }
            const isBlock = this.settings.outputFormat !== "plain";
            let insertPos: number;
            if (isBlock && cursor.ch > 0) {
              editor.replaceRange("\n", cursor);
              insertPos = editor.posToOffset({ line: cursor.line + 1, ch: 0 });
            } else {
              insertPos = editor.posToOffset(cursor);
            }

            const cmView = (editor as any).cm as EditorView;
            cmView.dispatch({ effects: addSpinnerEffect.of(insertPos), selection: EditorSelection.cursor(insertPos, 1) });

            try {
              const resolvedModel = this.resolveModel();
              const resolvedModelName = this.resolveModelDisplayName();
              const result = await generateText(buildSystemPrompt(ctx), rendered, this.settings, resolvedModel);
              cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
              const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
              const insertPosLine = editor.offsetToPos(insertPos);
              if (isBlock) {
                const withTrail = formatted + "\n";
                editor.replaceRange(withTrail, insertPosLine);
                const lines = withTrail.split("\n");
                editor.setCursor({ line: insertPosLine.line + lines.length - 1, ch: 0 });
              } else {
                editor.replaceRange(formatted, insertPosLine);
              }
              const entry: ContextEntry = {
                timestamp: Date.now(),
                noteName: ctx.title,
                model: resolvedModelName,
                systemPrompt: buildSystemPrompt(ctx),
                userMessage: rendered,
              };
              this.pushContextHistory(entry);
              const notice = new Notice("", 5000);
              notice.noticeEl.empty();
              notice.noticeEl.createEl("span", { text: "Augment: done" });
              notice.noticeEl.createEl("span", { cls: "augment-notice-sep", text: " \u00b7 " });
              const viewLink = notice.noticeEl.createEl("a", { cls: "augment-notice-action", text: "view context" });
              viewLink.href = "#";
              viewLink.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                notice.hide();
                new ContextInspectorModal(this.app, ctx).open();
              });
              if (!this.settings.hasGenerated) {
                this.settings.hasGenerated = true;
                await this.saveData(this.settings);
              }
              if (!this.settings.hasUsedTemplate) {
                this.settings.hasUsedTemplate = true;
                await this.saveData(this.settings);
              }
            } catch (err) {
              console.error("[Augment]", err);
              cmView.dispatch({ effects: removeSpinnerEffect.of(null) });
              new Notice(`Augment: generation failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              this.refreshStatusBar();
            }
          };

          if (!this.settings.showTemplatePreview) {
            await runGenerate();
            return;
          }

          new TemplatePreviewModal(this.app, rendered, ctx, async (skipPreviewInFuture) => {
            if (skipPreviewInFuture) {
              this.settings.showTemplatePreview = false;
              await this.saveData(this.settings);
            }
            await runGenerate();
          }).open();
        }).open();
      },
    });

    this.addCommand({
      id: "augment-open-settings",
      name: "Open settings",
      callback: () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("augment-terminal");
      },
    });

    this.addCommand({
      id: "augment-view-context",
      name: "View current note context",
      callback: () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
          new Notice("Augment: open a note to view its context");
          return;
        }
        const ctx = assembleVaultContext(this.app, activeView.editor, this.settings);
        new ContextInspectorModal(this.app, ctx).open();
      },
    });

    this.addSettingTab(new AugmentSettingTab(this.app, this));

    // Status bar — model name, click to open settings
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.addEventListener("click", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("augment-terminal");
    });
    this.refreshStatusBar();

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate")
            .setIcon("wand-2")
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate");
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate from template\u2026")
            .setIcon("wand-2")
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate-from-template");
            });
        });
      })
    );

    // Ribbon — radio-tower, opens settings
    this.addRibbonIcon("radio-tower", "Augment", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("augment-terminal");
    });

    // Add ribbon icon
    this.addRibbonIcon("terminal", "Open terminal", () => {
      this.openTerminal();
    });

    // Add command
    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      callback: () => {
        this.openTerminal();
      },
    });

    // Tiling commands
    this.addCommand({
      id: "open-terminal-right",
      name: "Open terminal to the right",
      callback: () => {
        this.openTerminal("split-vertical");
      },
    });

    this.addCommand({
      id: "open-terminal-down",
      name: "Open terminal below",
      callback: () => {
        this.openTerminal("split-horizontal");
      },
    });

    this.addCommand({
      id: "open-terminal-grid",
      name: "Open terminal grid (2x2)",
      callback: () => {
        this.openTerminalGrid();
      },
    });

    // Sidebar terminal
    this.addCommand({
      id: "open-terminal-sidebar",
      name: "Open terminal in sidebar",
      callback: () => {
        this.openTerminalSidebar();
      },
    });

    // Rename command
    this.addCommand({
      id: "rename-terminal",
      name: "Rename terminal",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (view) {
          new RenameModal(this.app, view).open();
        }
      },
    });

    // Terminal manager
    this.addCommand({
      id: "open-terminal-manager",
      name: "Show terminal manager",
      callback: () => {
        this.openTerminalManager();
      },
    });

    // Terminal switcher
    this.addCommand({
      id: "switch-terminal",
      name: "Switch terminal",
      callback: () => {
        new TerminalSwitcherModal(this.app).open();
      },
    });

    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:teamcreate", (event: TeamCreateSpawnEvent) => {
        void this.handleTeamCreateSpawn(event);
      })
    );
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER);
    cleanupXtermStyle();
    this.calloutStyleEl?.remove();
    this.calloutStyleEl = null;
  }

  private getPluginDir(): string {
    return (this.app.vault.adapter as any).basePath + "/.obsidian/plugins/augment-terminal";
  }

  private async openTerminal(
    mode: "tab" | "split-vertical" | "split-horizontal" = "tab",
    options?: { name?: string; active?: boolean; reveal?: boolean }
  ): Promise<void> {
    const { workspace } = this.app;
    const desiredName = options?.name?.trim();
    const active = options?.active ?? true;
    const reveal = options?.reveal ?? true;

    let leaf;
    if (mode === "split-vertical") {
      leaf = workspace.getLeaf("split", "vertical");
    } else if (mode === "split-horizontal") {
      leaf = workspace.getLeaf("split", "horizontal");
    } else {
      leaf = workspace.getLeaf("tab");
    }

    await leaf.setViewState({
      type: VIEW_TYPE_TERMINAL,
      active,
      state: desiredName ? { name: desiredName } : undefined,
    });

    if (desiredName) {
      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(desiredName);
      }
    }

    if (reveal) {
      workspace.revealLeaf(leaf);
    }
  }

  private async openTerminalSidebar(): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getRightLeaf(false);

    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: true,
      });
      workspace.revealLeaf(leaf);
    }
  }

  private async openTerminalManager(): Promise<void> {
    const { workspace } = this.app;

    // Reuse existing manager leaf
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL_MANAGER,
        active: true,
      });
      workspace.revealLeaf(leaf);
    }
  }

  private async openTerminalGrid(): Promise<void> {
    const { workspace } = this.app;

    const topLeft = workspace.getLeaf("tab");
    await topLeft.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const topRight = (workspace as any).createLeafBySplit(topLeft, "vertical");
    await topRight.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const bottomLeft = (workspace as any).createLeafBySplit(topLeft, "horizontal");
    await bottomLeft.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    const bottomRight = (workspace as any).createLeafBySplit(topRight, "horizontal");
    await bottomRight.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });

    workspace.revealLeaf(topLeft);
  }

  private async handleTeamCreateSpawn(event: TeamCreateSpawnEvent): Promise<void> {
    const members = Array.from(
      new Set(
        (event.members ?? [])
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      )
    );
    if (members.length === 0) return;

    const signature = `${event.team ?? ""}|${members.slice().sort().join(",")}`;
    const now = Date.now();
    const previous = this.recentTeamCreateSpawnSignatures.get(signature);
    if (previous && now - previous < 15_000) {
      return;
    }
    this.recentTeamCreateSpawnSignatures.set(signature, now);
    if (this.recentTeamCreateSpawnSignatures.size > 150) {
      for (const [key, ts] of this.recentTeamCreateSpawnSignatures) {
        if (now - ts > 60_000) {
          this.recentTeamCreateSpawnSignatures.delete(key);
        }
      }
    }

    for (const member of members) {
      if (this.hasTerminalNamed(member)) continue;
      await this.openTerminal("tab", {
        name: member,
        active: false,
        reveal: false,
      });
    }
  }

  private hasTerminalNamed(name: string): boolean {
    const target = name.trim().toLowerCase();
    if (!target) return false;

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      const view = leaf.view as Partial<TerminalView>;
      const viewName = typeof view.getName === "function" ? view.getName().trim() : "";
      if (viewName.toLowerCase() === target) {
        return true;
      }

      const leafAny = leaf as any;
      const stateName = leafAny.getViewState?.()?.state?.name;
      if (typeof stateName === "string" && stateName.trim().toLowerCase() === target) {
        return true;
      }
    }

    return false;
  }
}
