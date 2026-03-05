import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";
import { SessionMeta, SessionStore } from "./session-store";

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
  private sessionStore: SessionStore | null = null;
  private historyLoadedCount: number = 50;
  private expandedSessionId: string | null = null;

  // History scan debounce — avoid stat'ing 1000+ files on rapid layout events.
  private lastHistoryLoadTime = 0;
  private cachedSessions: SessionMeta[] = [];

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

    // Initialize session store from vault base path.
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    this.sessionStore = new SessionStore(vaultPath);

    this.refresh();
    window.setTimeout(() => this.refresh(), 0);
    this.app.workspace.onLayoutReady(() => this.refresh());

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

  private getHistorySessions(): SessionMeta[] {
    const now = Date.now();
    if (now - this.lastHistoryLoadTime >= 500) {
      this.lastHistoryLoadTime = now;
      this.cachedSessions =
        this.sessionStore?.loadSessions(this.historyLoadedCount) ?? [];
    }
    return this.cachedSessions;
  }

  private getTerminalLeaves(): WorkspaceLeaf[] {
    const byType = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    if (byType.length > 0) {
      return byType;
    }

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

    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const identity =
        typeof view.getAgentIdentity === "function"
          ? view.getAgentIdentity() ?? ""
          : "";
      if (identity.toLowerCase() === target) return leaf;
    }

    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const name =
        typeof view.getName === "function" ? view.getName() ?? "" : "";
      if (name.toLowerCase() === target) return leaf;
    }

    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const name =
        typeof view.getName === "function" ? view.getName() ?? "" : "";
      if (name.toLowerCase().includes(target)) return leaf;
    }

    return null;
  }

  private refresh(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const leaves = this.getTerminalLeaves();
    const sessions = this.getHistorySessions();
    const totalOnDisk = this.sessionStore?.loadSessions(10_000).length ?? 0;
    const activeLeaf = this.app.workspace.activeLeaf;

    const hasOpen = leaves.length > 0;
    const hasHistory = sessions.length > 0;

    if (!hasOpen && !hasHistory) {
      this.listEl.createDiv({
        cls: "augment-tm-empty",
        text: "No terminals open",
      });
      return;
    }

    // ── OPEN section ──────────────────────────────────────────
    if (hasOpen) {
      this.listEl.createDiv({
        cls: "augment-tm-section-label",
        text: "OPEN",
      });
      for (const leaf of leaves) {
        this.renderOpenRow(leaf, activeLeaf);
      }
    }

    // ── HISTORY section ───────────────────────────────────────
    if (hasHistory) {
      this.listEl.createDiv({
        cls: "augment-tm-section-label",
        text: "HISTORY",
      });
      this.renderHistorySections(sessions, totalOnDisk);
    }
  }

  private renderOpenRow(
    leaf: WorkspaceLeaf,
    activeLeaf: WorkspaceLeaf | null
  ): void {
    const view = leaf.view as TerminalViewLike;
    const row = this.listEl!.createDiv({ cls: "augment-tm-item" });

    if (leaf === activeLeaf) row.addClass("is-active");

    const line = row.createDiv({ cls: "augment-tm-line" });

    const dot = line.createDiv({ cls: "augment-tm-dot" });
    const status =
      typeof view.getStatus === "function" ? view.getStatus() : "shell";
    dot.addClass(status);

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
    if (summary) row.createDiv({ cls: "augment-tm-summary", text: summary });

    const teams =
      typeof view.getTeamNames === "function" ? view.getTeamNames() : [];
    const members =
      typeof view.getTeamMembers === "function" ? view.getTeamMembers() : [];

    if (teams.length > 0 || members.length > 0) {
      const meta = row.createDiv({ cls: "augment-tm-meta" });
      if (teams.length > 0) {
        meta.createSpan({
          cls: "augment-tm-team",
          text: teams.slice(0, 2).join(", "),
        });
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
            if (targetLeaf) this.focusLeaf(targetLeaf);
          });
        }
      }
    }

    row.addEventListener("click", () => this.focusLeaf(leaf));
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

  private renderHistorySections(
    sessions: SessionMeta[],
    totalOnDisk: number
  ): void {
    const now = new Date();
    const todayStr = this.dateStr(now);

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yesterdayStr = this.dateStr(yesterday);

    // Start of current week (Sunday).
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const startOfWeekStr = this.dateStr(startOfWeek);

    // Group by date bucket.
    const groups = new Map<string, SessionMeta[]>();
    const groupOrder: string[] = [];

    for (const session of sessions) {
      const d = new Date(session.mtimeMs);
      const dStr = this.dateStr(d);

      let groupKey: string;
      if (dStr === todayStr) {
        groupKey = "Today";
      } else if (dStr === yesterdayStr) {
        groupKey = "Yesterday";
      } else if (dStr >= startOfWeekStr && dStr < todayStr) {
        groupKey = "This week";
      } else {
        groupKey = d.toLocaleString("en-US", {
          month: "long",
          year: "numeric",
        });
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
        groupOrder.push(groupKey);
      }
      groups.get(groupKey)!.push(session);
    }

    const GROUP_COLLAPSE_THRESHOLD = 10;
    const GROUP_PREVIEW_COUNT = 5;

    for (const groupKey of groupOrder) {
      const groupSessions = groups.get(groupKey)!;
      this.listEl!.createDiv({
        cls: "augment-tm-date-group",
        text: groupKey,
      });

      const showAll = groupSessions.length <= GROUP_COLLAPSE_THRESHOLD;
      const visible = showAll
        ? groupSessions
        : groupSessions.slice(0, GROUP_PREVIEW_COUNT);

      for (const session of visible) {
        this.renderHistoryRow(session);
      }

      if (!showAll) {
        const remaining = groupSessions.length - GROUP_PREVIEW_COUNT;
        const showMore = this.listEl!.createDiv({
          cls: "augment-tm-load-more",
          text: `Show ${remaining} more`,
        });
        showMore.addEventListener("click", () => {
          // Expand the group — show all then re-render remaining
          for (const session of groupSessions.slice(GROUP_PREVIEW_COUNT)) {
            this.renderHistoryRow(session);
          }
          showMore.remove();
        });
      }
    }

    // "Load 50 more" if disk has more than currently loaded.
    if (totalOnDisk > this.historyLoadedCount) {
      const loadMore = this.listEl!.createDiv({
        cls: "augment-tm-load-more",
        text: "Load 50 more \u2193",
      });
      loadMore.addEventListener("click", () => {
        this.historyLoadedCount += 50;
        this.lastHistoryLoadTime = 0; // force reload
        this.refresh();
      });
    }
  }

  private renderHistoryRow(session: SessionMeta): void {
    const isExpanded = this.expandedSessionId === session.id;
    const row = this.listEl!.createDiv({ cls: "augment-tm-item is-history" });

    const line = row.createDiv({ cls: "augment-tm-line" });

    const dot = line.createDiv({ cls: "augment-tm-dot" });
    dot.addClass(session.status === "stale" ? "stale" : "exited");

    line.createSpan({ cls: "augment-tm-name", text: session.title });
    line.createDiv({ cls: "augment-tm-spacer" });
    line.createSpan({
      cls: "augment-tm-timestamp",
      text: this.relativeTime(session.mtimeMs),
    });

    if (isExpanded) {
      const expand = row.createDiv({ cls: "augment-tm-expand" });
      const label =
        session.status === "stale"
          ? `Last active ${this.relativeTime(session.mtimeMs)} \u2014 may still be running`
          : `Closed ${this.relativeTime(session.mtimeMs)}`;
      expand.createSpan({ cls: "augment-tm-expand-label", text: label });

      const actions = expand.createDiv({ cls: "augment-tm-expand-actions" });
      const resumeBtn = actions.createEl("button", {
        cls: "augment-tm-resume",
        text: "Resume in terminal",
        attr: { type: "button" },
      });
      resumeBtn.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        const plugin = this.getPlugin();
        if (!plugin) return;
        const termView = await plugin.openFocusedTerminal();
        if (termView) {
          setTimeout(() => {
            termView.write(`claude --resume ${session.id}\n`);
          }, 800);
        }
      });
    }

    row.addEventListener("click", () => {
      this.expandedSessionId = isExpanded ? null : session.id;
      this.refresh();
    });

    row.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Resume in terminal")
          .setIcon("terminal")
          .onClick(async () => {
            const plugin = this.getPlugin();
            if (!plugin) return;
            const termView = await plugin.openFocusedTerminal();
            if (termView) {
              setTimeout(() => {
                termView.write(`claude --resume ${session.id}\n`);
              }, 800);
            }
          })
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private relativeTime(mtimeMs: number): string {
    const diff = Date.now() - mtimeMs;
    const mins = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);

    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
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
      if (value?.trim()) return value.trim();
    }

    const leafEl = leafAny?.view?.containerEl?.closest?.(".workspace-leaf");
    const headerName = leafEl
      ?.querySelector?.(".view-header-title")
      ?.textContent?.trim();
    if (headerName) return headerName;

    return leafAny.getDisplayText?.() || "terminal";
  }
}
