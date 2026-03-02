import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";

export const VIEW_TYPE_TERMINAL_MANAGER = "augment-terminal-manager";

type TerminalViewLike = {
  getStatus?: () => string;
  getName?: () => string;
  getUnreadActivity?: () => number;
  getTeamNames?: () => string[];
  getTeamMembers?: () => string[];
  getLastTeamEventSummary?: () => string | null;
  getAgentIdentity?: () => string | null;
  markActivityRead?: () => void;
};

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

    // Header.
    const header = container.createDiv({ cls: "augment-tm-header" });
    header.createSpan({ cls: "augment-tm-title", text: "TERMINALS" });
    const addBtn = header.createEl("button", {
      cls: "augment-tm-add clickable-icon",
    });
    setIcon(addBtn, "plus");
    addBtn.addEventListener("click", () => {
      (this.app as any).commands.executeCommandById(
        "augment-terminal:open-terminal"
      );
    });

    // List container.
    this.listEl = container.createDiv({ cls: "augment-tm-list" });

    this.refresh();
    // Run again after the workspace settles; terminal leaves can appear a tick later.
    window.setTimeout(() => this.refresh(), 0);
    this.app.workspace.onLayoutReady(() => this.refresh());

    // Listen for changes.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh())
    );
    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:changed", () =>
        this.refresh()
      )
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

  private focusLeaf(leaf: WorkspaceLeaf): void {
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as TerminalViewLike;
    if (typeof view.markActivityRead === "function") {
      view.markActivityRead();
    }
  }

  private findLeafForAgent(agentName: string): WorkspaceLeaf | null {
    const target = agentName.toLowerCase();
    const leaves = this.getTerminalLeaves();

    // Prefer explicit parsed identity.
    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const identity =
        typeof view.getAgentIdentity === "function"
          ? view.getAgentIdentity() ?? ""
          : "";
      if (identity.toLowerCase() === target) {
        return leaf;
      }
    }

    // Fallback to terminal name exact match.
    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const name =
        typeof view.getName === "function" ? view.getName() ?? "" : "";
      if (name.toLowerCase() === target) {
        return leaf;
      }
    }

    // Last fallback: partial name match.
    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const name =
        typeof view.getName === "function" ? view.getName() ?? "" : "";
      if (name.toLowerCase().includes(target)) {
        return leaf;
      }
    }

    return null;
  }

  private refresh(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const leaves = this.getTerminalLeaves();
    const activeLeaf = this.app.workspace.activeLeaf;

    if (leaves.length === 0) {
      this.listEl.createDiv({
        cls: "augment-tm-empty",
        text: "No terminals open",
      });
      return;
    }

    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const row = this.listEl.createDiv({ cls: "augment-tm-item" });

      if (leaf === activeLeaf) {
        row.addClass("is-active");
      }

      const line = row.createDiv({ cls: "augment-tm-line" });

      // Status dot.
      const dot = line.createDiv({ cls: "augment-tm-dot" });
      const status =
        typeof view.getStatus === "function" ? view.getStatus() : "shell";
      dot.addClass(status);

      // Name.
      const name = this.getLeafTerminalName(leaf, view);
      line.createSpan({ cls: "augment-tm-name", text: name });
      line.createDiv({ cls: "augment-tm-spacer" });

      const unread =
        typeof view.getUnreadActivity === "function"
          ? view.getUnreadActivity()
          : 0;
      if (unread > 0) {
        line.createSpan({
          cls: "augment-tm-unread",
          text: unread > 99 ? "99+" : String(unread),
        });
      }

      const summary =
        typeof view.getLastTeamEventSummary === "function"
          ? view.getLastTeamEventSummary()
          : null;
      if (summary) {
        row.createDiv({ cls: "augment-tm-summary", text: summary });
      }

      const teams =
        typeof view.getTeamNames === "function" ? view.getTeamNames() : [];
      const members =
        typeof view.getTeamMembers === "function" ? view.getTeamMembers() : [];

      if (teams.length > 0 || members.length > 0) {
        const meta = row.createDiv({ cls: "augment-tm-meta" });

        if (teams.length > 0) {
          const teamLabel = teams.slice(0, 2).join(", ");
          meta.createSpan({ cls: "augment-tm-team", text: teamLabel });
        }

        if (members.length > 0) {
          const membersWrap = meta.createDiv({ cls: "augment-tm-members" });
          for (const member of members.slice(0, 8)) {
            const chip = membersWrap.createEl("button", {
              cls: "augment-tm-member",
              text: member,
              attr: { type: "button" },
            });

            chip.addEventListener("click", (evt) => {
              evt.preventDefault();
              evt.stopPropagation();

              const targetLeaf = this.findLeafForAgent(member);
              if (targetLeaf) {
                this.focusLeaf(targetLeaf);
              }
            });
          }
        }
      }

      // Click row to reveal terminal.
      row.addEventListener("click", () => {
        this.focusLeaf(leaf);
      });
    }
  }

  async onClose(): Promise<void> {
    this.listEl = null;
  }

  private getLeafTerminalName(
    leaf: WorkspaceLeaf,
    view: TerminalViewLike
  ): string {
    const leafAny = leaf as any;
    const stateName = leafAny.getViewState?.()?.state?.name;
    if (typeof stateName === "string" && stateName.trim()) {
      return stateName.trim();
    }

    if (typeof view.getName === "function") {
      const value = view.getName();
      if (value?.trim()) {
        return value.trim();
      }
    }

    const leafEl = leafAny?.view?.containerEl?.closest?.(".workspace-leaf");
    const headerName = leafEl
      ?.querySelector?.(".view-header-title")
      ?.textContent?.trim();
    if (headerName) {
      return headerName;
    }

    return leafAny.getDisplayText?.() || "terminal";
  }
}
