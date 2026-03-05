import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";
import { SessionRecord } from "./vault-context";

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

const CLOSED_PREVIEW_COUNT = 8;

export class TerminalManagerView extends ItemView {
  private listEl: HTMLElement | null = null;
  private expandedSessionId: string | null = null;
  private showAllHistory: boolean = false;

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

  private getPlugin(): any {
    return (this.app as any).plugins?.plugins?.["augment-terminal"];
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
    const plugin = this.getPlugin();
    const sessionHistory: SessionRecord[] = Array.isArray(plugin?.settings?.sessionHistory)
      ? plugin.settings.sessionHistory
      : [];

    if (leaves.length === 0 && sessionHistory.length === 0) {
      this.listEl.createDiv({
        cls: "augment-tm-empty",
        text: "No terminals open",
      });
      return;
    }

    const activeLeaf = this.app.workspace.activeLeaf;

    // OPEN section.
    if (leaves.length > 0) {
      this.listEl.createDiv({ cls: "augment-tm-section-header", text: "OPEN" });
      for (const leaf of leaves) {
        this.renderOpenRow(leaf, activeLeaf);
      }
    }

    // History sections.
    if (sessionHistory.length > 0) {
      this.renderHistorySections(sessionHistory, plugin);
    }
  }

  private renderOpenRow(leaf: WorkspaceLeaf, activeLeaf: WorkspaceLeaf | null): void {
    const view = leaf.view as TerminalViewLike;
    const row = this.listEl!.createDiv({ cls: "augment-tm-item" });

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

    // Right-click context menu.
    row.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Focus")
          .setIcon("eye")
          .onClick(() => this.focusLeaf(leaf))
      );
      menu.addItem((item) =>
        item
          .setTitle("Close")
          .setIcon("x")
          .onClick(() => leaf.detach())
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private renderHistorySections(sessionHistory: SessionRecord[], plugin: any): void {
    const now = new Date();
    const todayStr = this.dateStr(now);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = this.dateStr(yesterday);

    // Start of current week (Sunday).
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const startOfWeekStr = this.dateStr(startOfWeek);

    // Sort descending by close time.
    const sorted = [...sessionHistory].sort((a, b) => b.closedAt - a.closedAt);

    // Group into labelled buckets.
    const groups = new Map<string, SessionRecord[]>();
    const groupOrder: string[] = [];

    for (const record of sorted) {
      const d = new Date(record.closedAt);
      const dStr = this.dateStr(d);
      let groupKey: string;

      if (dStr === todayStr) {
        groupKey = "TODAY";
      } else if (dStr === yesterdayStr) {
        groupKey = "YESTERDAY";
      } else if (dStr >= startOfWeekStr && dStr < todayStr) {
        groupKey = "EARLIER THIS WEEK";
      } else {
        groupKey = d
          .toLocaleString("en-US", { month: "long", year: "numeric" })
          .toUpperCase();
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
        groupOrder.push(groupKey);
      }
      groups.get(groupKey)!.push(record);
    }

    const totalClosed = sorted.length;
    let rendered = 0;

    for (const groupKey of groupOrder) {
      if (!this.showAllHistory && rendered >= CLOSED_PREVIEW_COUNT) break;

      const records = groups.get(groupKey)!;
      this.listEl!.createDiv({ cls: "augment-tm-section-header", text: groupKey });

      for (const record of records) {
        if (!this.showAllHistory && rendered >= CLOSED_PREVIEW_COUNT) break;
        this.renderClosedRow(record, plugin);
        rendered++;
      }
    }

    if (!this.showAllHistory && totalClosed > CLOSED_PREVIEW_COUNT) {
      const remaining = totalClosed - CLOSED_PREVIEW_COUNT;
      const showMore = this.listEl!.createDiv({
        cls: "augment-tm-show-older",
        text: `Show ${remaining} older session${remaining === 1 ? "" : "s"}`,
      });
      showMore.addEventListener("click", () => {
        this.showAllHistory = true;
        this.refresh();
      });
    }
  }

  private renderClosedRow(record: SessionRecord, plugin: any): void {
    const isExpanded = this.expandedSessionId === record.id;
    const row = this.listEl!.createDiv({ cls: "augment-tm-item is-closed" });

    const line = row.createDiv({ cls: "augment-tm-line" });

    // Status dot.
    const dot = line.createDiv({ cls: "augment-tm-dot" });
    dot.addClass(record.status);

    // Name.
    line.createSpan({ cls: "augment-tm-name", text: record.name });
    line.createDiv({ cls: "augment-tm-spacer" });

    // Close timestamp.
    const ts = new Date(record.closedAt);
    const tsText = ts
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
      .toLowerCase();
    line.createSpan({ cls: "augment-tm-timestamp", text: tsText });

    // Expand/collapse toggle.
    const expandBtn = line.createEl("button", {
      cls: "augment-tm-expand clickable-icon",
      attr: { type: "button" },
    });
    setIcon(expandBtn, isExpanded ? "chevron-up" : "chevron-down");

    // Inline actions (expanded).
    if (isExpanded) {
      const actions = row.createDiv({ cls: "augment-tm-expand-actions" });

      const reopenBtn = actions.createEl("button", {
        cls: "augment-tm-action",
        text: "Reopen",
        attr: { type: "button" },
      });
      reopenBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        plugin?.openTerminalNamed?.(record.name);
      });

      const deleteBtn = actions.createEl("button", {
        cls: "augment-tm-action is-danger",
        text: "Delete",
        attr: { type: "button" },
      });
      deleteBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (this.expandedSessionId === record.id) {
          this.expandedSessionId = null;
        }
        plugin?.deleteSessionRecord?.(record.id);
      });
    }

    // Toggle expansion on row click.
    row.addEventListener("click", () => {
      this.expandedSessionId = isExpanded ? null : record.id;
      this.refresh();
    });

    expandBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.expandedSessionId = isExpanded ? null : record.id;
      this.refresh();
    });

    // Right-click context menu.
    row.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Reopen")
          .setIcon("terminal")
          .onClick(() => plugin?.openTerminalNamed?.(record.name))
      );
      menu.addItem((item) =>
        item
          .setTitle("Delete")
          .setIcon("trash")
          .onClick(() => {
            if (this.expandedSessionId === record.id) {
              this.expandedSessionId = null;
            }
            plugin?.deleteSessionRecord?.(record.id);
          })
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private dateStr(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
