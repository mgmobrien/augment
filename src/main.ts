import { MarkdownView, Modal, Notice, Plugin, Setting } from "obsidian";
import { applyOutputFormat, buildSystemPrompt, buildUserMessage, generateText, modelDisplayName, substituteVariables } from "./ai-client";
import { AugmentSettingTab } from "./settings-tab";
import { getTemplateFiles, TemplatePicker, TemplatePreviewModal } from "./template-picker";
import { assembleVaultContext, AugmentSettings, DEFAULT_SETTINGS } from "./vault-context";
import { TerminalView, VIEW_TYPE_TERMINAL, cleanupXtermStyle } from "./terminal-view";
import { TerminalManagerView, VIEW_TYPE_TERMINAL_MANAGER } from "./terminal-manager-view";
import { TerminalSwitcherModal } from "./terminal-switcher";

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
  private recentTeamCreateSpawnSignatures: Map<string, number> = new Map();
  private calloutStyleEl: HTMLStyleElement | null = null;
  private statusBarEl: HTMLElement | null = null;

  public refreshStatusBar(): void {
    if (this.statusBarEl) {
      this.statusBarEl.setText(`Augment: ${modelDisplayName(this.settings.model)}`);
    }
  }

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.calloutStyleEl = document.head.createEl("style");
    this.calloutStyleEl.id = "augment-callout-styles";
    this.calloutStyleEl.textContent = [
      `.callout[data-callout="ai"] { --callout-icon: bot; --callout-color: 139, 92, 246; }`,
      `.callout[data-callout="ai"] .callout-icon { display: flex !important; }`,
      `.callout[data-callout="ai"] .callout-title::before { content: "" !important; display: none !important; }`,
    ].join("\n");

    // Register views
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      return new TerminalView(leaf, this.getPluginDir());
    });
    this.registerView(VIEW_TYPE_TERMINAL_MANAGER, (leaf) => {
      return new TerminalManagerView(leaf);
    });

    // AI generation commands
    this.addCommand({
      id: "augment-generate",
      name: "Generate",
      hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        if (!this.settings.apiKey) {
          const notice = new Notice("Augment: add your API key in Settings \u2192 Augment", 0);
          notice.noticeEl.addEventListener("click", () => {
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
            notice.hide();
          });
          return;
        }

        const cursor = editor.getCursor();
        const aboveCursor = editor.getRange({ line: 0, ch: 0 }, cursor);
        const promptText = aboveCursor.trim() || editor.getValue().trim();
        const ctx = assembleVaultContext(this.app, editor, this.settings);

        if (this.statusBarEl) this.statusBarEl.setText("\u00B7 \u00B7 \u00B7 generating");

        void (async () => {
          try {
            const result = await generateText(buildSystemPrompt(ctx), promptText, this.settings);
            const formatted = applyOutputFormat(result, this.settings);
            const isBlock = this.settings.outputFormat !== "plain";
            if (isBlock) {
              const prefix = cursor.ch > 0 ? "\n" : "";
              const insertion = prefix + formatted + "\n";
              editor.replaceRange(insertion, cursor);
              const lines = insertion.split("\n");
              editor.setCursor({ line: cursor.line + lines.length - 1, ch: 0 });
            } else {
              editor.replaceRange(formatted, cursor);
            }
          } catch (err) {
            console.error("[Augment]", err);
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
          const notice = new Notice("Augment: add your API key in Settings \u2192 Augment", 0);
          notice.noticeEl.addEventListener("click", () => {
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
            notice.hide();
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
          const rendered = substituteVariables(templateContent, ctx);

          const runGenerate = async () => {
            if (this.statusBarEl) this.statusBarEl.setText("\u00B7 \u00B7 \u00B7 generating");
            try {
              const result = await generateText(buildSystemPrompt(ctx), rendered, this.settings);
              const formatted = applyOutputFormat(result, this.settings);
              const isBlock = this.settings.outputFormat !== "plain";
              if (isBlock) {
                const prefix = cursor.ch > 0 ? "\n" : "";
                const insertion = prefix + formatted + "\n";
                editor.replaceRange(insertion, cursor);
                const lines = insertion.split("\n");
                editor.setCursor({ line: cursor.line + lines.length - 1, ch: 0 });
              } else {
                editor.replaceRange(formatted, cursor);
              }
            } catch (err) {
              console.error("[Augment]", err);
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
