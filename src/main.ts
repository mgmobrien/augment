import { Modal, Plugin, Setting } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL, cleanupXtermStyle } from "./terminal-view";
import { TerminalManagerView, VIEW_TYPE_TERMINAL_MANAGER } from "./terminal-manager-view";
import { TerminalSwitcherModal } from "./terminal-switcher";

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
  async onload(): Promise<void> {
    // Register views
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      return new TerminalView(leaf, this.getPluginDir());
    });
    this.registerView(VIEW_TYPE_TERMINAL_MANAGER, (leaf) => {
      return new TerminalManagerView(leaf);
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
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL_MANAGER);
    cleanupXtermStyle();
  }

  private getPluginDir(): string {
    return (this.app.vault.adapter as any).basePath + "/.obsidian/plugins/augment-terminal";
  }

  private async openTerminal(mode: "tab" | "split-vertical" | "split-horizontal" = "tab"): Promise<void> {
    const { workspace } = this.app;

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
      active: true,
    });

    workspace.revealLeaf(leaf);
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
}
