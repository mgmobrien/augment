import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";

export const VIEW_TYPE_TERMINAL_MANAGER = "augment-terminal-manager";

export class TerminalManagerView extends ItemView {
  private listEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TERMINAL_MANAGER;
  }

  getDisplayText(): string {
    return "Terminals";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("augment-terminal-manager");

    // Header
    const header = container.createDiv({ cls: "augment-tm-header" });
    header.createSpan({ cls: "augment-tm-title", text: "TERMINALS" });
    const addBtn = header.createEl("button", { cls: "augment-tm-add clickable-icon" });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => {
      (this.app as any).commands.executeCommandById("augment-terminal:open-terminal");
    });

    // List container
    this.listEl = container.createDiv({ cls: "augment-tm-list" });

    this.refresh();
    // Run again after the workspace settles; terminal leaves can appear a tick later.
    window.setTimeout(() => this.refresh(), 0);
    this.app.workspace.onLayoutReady(() => this.refresh());

    // Listen for changes
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh())
    );
    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:changed", () => this.refresh())
    );
  }

  private getTerminalLeaves(): WorkspaceLeaf[] {
    const byType = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (byType.length > 0) {
      return byType;
    }

    // Fallback: scan all leaves for restored views where getLeavesOfType can briefly lag.
    const found: WorkspaceLeaf[] = [];
    const workspaceAny = this.app.workspace as any;
    if (typeof workspaceAny.iterateAllLeaves === "function") {
      workspaceAny.iterateAllLeaves((leaf: WorkspaceLeaf) => {
        const viewAny = leaf.view as any;
        const viewType =
          typeof viewAny?.getViewType === "function"
            ? viewAny.getViewType()
            : viewAny?.getViewType;
        if (viewType === VIEW_TYPE_TERMINAL) {
          found.push(leaf);
        }
      });
    }

    return found;
  }

  private refresh(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const leaves = this.getTerminalLeaves();
    const activeLeaf = this.app.workspace.activeLeaf;

    if (leaves.length === 0) {
      this.listEl.createDiv({ cls: "augment-tm-empty", text: "No terminals open" });
      return;
    }

    for (const leaf of leaves) {
      const view = leaf.view as Partial<TerminalView>;
      const row = this.listEl.createDiv({ cls: "augment-tm-item" });

      if (leaf === activeLeaf) {
        row.addClass("is-active");
      }

      // Status dot
      const dot = row.createDiv({ cls: "augment-tm-dot" });
      const status = typeof view.getStatus === "function" ? view.getStatus() : "shell";
      dot.addClass(status);

      // Name
      const leafAny = leaf as any;
      const name =
        typeof view.getName === "function"
          ? view.getName()
          : leafAny.getDisplayText?.() || "terminal";
      row.createSpan({ cls: "augment-tm-name", text: name });

      // Click to reveal
      row.addEventListener("click", () => {
        this.app.workspace.revealLeaf(leaf);
      });
    }
  }

  async onClose(): Promise<void> {
    this.listEl = null;
  }
}
