import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";
import { ProjectGroup, SessionMeta, SessionStore } from "./session-store";

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
  getExchangeCount?: () => number;
  getLastActivityMs?: () => number;
  getAutoNamed?: () => boolean;
};

type TeamContext = { isTeamMember: boolean; isSubAgent: boolean };

export class TerminalManagerView extends ItemView {
  private listEl: HTMLElement | null = null;
  private sessionStore: SessionStore | null = null;
  private historyLoadedCount: number = 50;
  private expandedSessionId: string | null = null;

  // History scan debounce — avoid stat'ing 1000+ files on rapid layout events.
  private lastHistoryLoadTime = 0;
  private cachedSessions: SessionMeta[] = [];

  // Other-projects scan debounce.
  private lastProjectGroupsLoadTime = 0;
  private cachedProjectGroups: ProjectGroup[] = [];

  // Which other-project groups are expanded (collapsed by default).
  private expandedProjects: Set<string> = new Set();

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

    // Refresh timestamps every 30s so relative times stay current.
    this.registerInterval(window.setInterval(() => this.refreshTimestamps(), 30_000));
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

  private getOtherProjectGroups(): ProjectGroup[] {
    const now = Date.now();
    if (now - this.lastProjectGroupsLoadTime >= 500) {
      this.lastProjectGroupsLoadTime = now;
      const all = this.sessionStore?.loadAllProjectGroups(50) ?? [];
      this.cachedProjectGroups = all.filter((g) => !g.isVault);
    }
    return this.cachedProjectGroups;
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

  // Build team groups from open terminal leaves.
  // Returns Map<teamName, orderedLeaves> where index 0 is the leader.
  // Only includes groups with ≥2 members (confident detection).
  private computeTeamGroups(
    leaves: WorkspaceLeaf[]
  ): Map<string, WorkspaceLeaf[]> {
    const byTeam = new Map<string, Set<WorkspaceLeaf>>();

    // Signal 1: shared team name from each leaf's getTeamNames().
    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const teams =
        typeof view.getTeamNames === "function" ? view.getTeamNames() : [];
      for (const team of teams) {
        if (!byTeam.has(team)) byTeam.set(team, new Set());
        byTeam.get(team)!.add(leaf);
      }
    }

    // Signal 2: name cross-reference.
    // If leaf A's teamMembers includes the name of leaf B, they're connected.
    // This catches worker tabs that don't self-identify their team.
    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const teams =
        typeof view.getTeamNames === "function" ? view.getTeamNames() : [];
      if (teams.length === 0) continue;
      const members =
        typeof view.getTeamMembers === "function"
          ? view.getTeamMembers().map((m) => m.toLowerCase())
          : [];
      if (members.length === 0) continue;

      for (const otherLeaf of leaves) {
        if (otherLeaf === leaf) continue;
        const otherName = this.getLeafTerminalName(
          otherLeaf,
          otherLeaf.view as TerminalViewLike
        ).toLowerCase();
        if (members.includes(otherName)) {
          for (const team of teams) {
            if (!byTeam.has(team)) byTeam.set(team, new Set());
            byTeam.get(team)!.add(leaf);
            byTeam.get(team)!.add(otherLeaf);
          }
        }
      }
    }

    // Build result: only groups with ≥2 members, leader (most teamMembers) first.
    const result = new Map<string, WorkspaceLeaf[]>();
    for (const [team, leafSet] of byTeam) {
      if (leafSet.size < 2) continue;
      const sorted = Array.from(leafSet).sort((a, b) => {
        const aView = a.view as TerminalViewLike;
        const bView = b.view as TerminalViewLike;
        const aCount =
          typeof aView.getTeamMembers === "function"
            ? aView.getTeamMembers().length
            : 0;
        const bCount =
          typeof bView.getTeamMembers === "function"
            ? bView.getTeamMembers().length
            : 0;
        return bCount - aCount; // most members = leader
      });
      result.set(team, sorted);
    }

    return result;
  }

  private refresh(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const leaves = this.getTerminalLeaves();
    const sessions = this.getHistorySessions();
    const totalOnDisk = this.sessionStore?.countSessions() ?? 0;
    const otherGroups = this.getOtherProjectGroups();
    const activeLeaf = this.app.workspace.activeLeaf;

    const hasOpen = leaves.length > 0;
    const hasHistory = sessions.length > 0;
    const hasOtherProjects = otherGroups.length > 0;

    if (!hasOpen && !hasHistory && !hasOtherProjects) {
      this.listEl.createDiv({
        cls: "augment-tm-empty",
        text: "No terminals open",
      });
      return;
    }

    // ── OPEN section with team grouping ───────────────────────
    if (hasOpen) {
      this.listEl.createDiv({
        cls: "augment-tm-section-label",
        text: "OPEN",
      });
      const teamGroups = this.computeTeamGroups(leaves);
      this.renderOpenSectionWithGroups(leaves, teamGroups, activeLeaf);
    }

    // ── HISTORY section (vault) ────────────────────────────────
    if (hasHistory) {
      this.listEl.createDiv({
        cls: "augment-tm-section-label",
        text: "HISTORY",
      });
      this.renderHistorySections(sessions, totalOnDisk, this.listEl);
    }

    // ── OTHER PROJECTS section ─────────────────────────────────
    if (hasOtherProjects) {
      this.listEl.createDiv({
        cls: "augment-tm-section-label",
        text: "OTHER PROJECTS",
      });
      this.renderOtherProjectsSection(otherGroups);
    }
  }

  private renderOpenSectionWithGroups(
    leaves: WorkspaceLeaf[],
    teamGroups: Map<string, WorkspaceLeaf[]>,
    activeLeaf: WorkspaceLeaf | null
  ): void {
    // Track which leaves belong to any group. A leaf only appears in its
    // first detected group to prevent duplication.
    const assignedLeaves = new Set<WorkspaceLeaf>();

    for (const [teamName, members] of teamGroups) {
      // Team header.
      const teamHeader = this.listEl!.createDiv({ cls: "augment-tm-team-header" });
      teamHeader.createSpan({ text: teamName });

      // Leader (most teamMembers).
      const leader = members[0];
      assignedLeaves.add(leader);
      this.renderOpenRow(leader, activeLeaf, {
        isTeamMember: true,
        isSubAgent: false,
      });

      // Sub-agents.
      for (const member of members.slice(1)) {
        assignedLeaves.add(member);
        this.renderOpenRow(member, activeLeaf, {
          isTeamMember: true,
          isSubAgent: true,
        });
      }

      // Gap after group.
      this.listEl!.createDiv({ cls: "augment-tm-team-gap" });
    }

    // Ungrouped leaves.
    for (const leaf of leaves) {
      if (!assignedLeaves.has(leaf)) {
        this.renderOpenRow(leaf, activeLeaf, {
          isTeamMember: false,
          isSubAgent: false,
        });
      }
    }
  }

  private renderOpenRow(
    leaf: WorkspaceLeaf,
    activeLeaf: WorkspaceLeaf | null,
    teamContext: TeamContext = { isTeamMember: false, isSubAgent: false }
  ): void {
    const view = leaf.view as TerminalViewLike;
    const row = this.listEl!.createDiv({ cls: "augment-tm-item" });

    if (leaf === activeLeaf) row.addClass("is-active");
    if (teamContext.isTeamMember) row.addClass("augment-tm-team-member");
    if (teamContext.isSubAgent) row.addClass("is-sub-agent");

    const line = row.createDiv({ cls: "augment-tm-line" });

    const dot = line.createDiv({ cls: "augment-tm-dot" });
    const status =
      typeof view.getStatus === "function" ? view.getStatus() : "shell";
    dot.addClass(status);
    const dotLabel: Record<string, string> = {
      active: "Generating", tool: "Using tool", idle: "Idle", shell: "Open in Obsidian",
      running: "Running", crashed: "Crashed", exited: "Exited",
    };
    dot.setAttribute("title", dotLabel[status] ?? status);

    const name = this.getLeafTerminalName(leaf, view);
    const autoNamed = typeof view.getAutoNamed === "function" && view.getAutoNamed();
    const nameEl = line.createSpan({ cls: "augment-tm-name" + (autoNamed ? " is-just-named" : ""), text: name });
    if (autoNamed) setTimeout(() => nameEl.removeClass("is-just-named"), 1200);
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

    const exchangeCount = typeof view.getExchangeCount === "function" ? view.getExchangeCount() : 0;
    const lastActivityMs = typeof view.getLastActivityMs === "function" ? view.getLastActivityMs() : 0;
    const summary = typeof view.getLastTeamEventSummary === "function" ? view.getLastTeamEventSummary() : null;

    if (exchangeCount > 0 || summary) {
      const secEl = row.createDiv({ cls: "augment-tm-summary" });
      if (exchangeCount > 0) {
        const parts: string[] = [`${exchangeCount} msg${exchangeCount !== 1 ? "s" : ""}`];
        if (lastActivityMs > 0) {
          const rtEl = document.createElement("span");
          rtEl.className = "augment-tm-reltime";
          rtEl.dataset.ms = String(lastActivityMs);
          rtEl.textContent = this.relativeTime(lastActivityMs);
          secEl.textContent = parts[0] + " · ";
          secEl.appendChild(rtEl);
        } else {
          secEl.textContent = parts[0];
        }
        if (summary) secEl.textContent += " — " + summary;
      } else if (summary) {
        secEl.textContent = summary;
      }
    }

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

  private renderOtherProjectsSection(groups: ProjectGroup[]): void {
    for (const group of groups) {
      const isExpanded = this.expandedProjects.has(group.encodedName);

      const projectRow = this.listEl!.createDiv({ cls: "augment-tm-project-row" });
      const line = projectRow.createDiv({ cls: "augment-tm-line" });

      line.createSpan({
        cls: "augment-tm-project-chevron",
        text: isExpanded ? "▾" : "▸",
      });

      // Display the last meaningful path segment.
      const segments = group.projectName.split("/").filter(Boolean);
      const displayName = segments.slice(-1)[0] || group.projectName;
      line.createSpan({ cls: "augment-tm-project-name", text: displayName });
      line.createDiv({ cls: "augment-tm-spacer" });

      const metaEl = line.createSpan({ cls: "augment-tm-project-meta" });
      metaEl.textContent = `${group.totalOnDisk} · ${this.relativeTime(group.lastActivityMs)}`;

      projectRow.addEventListener("click", () => {
        if (isExpanded) {
          this.expandedProjects.delete(group.encodedName);
        } else {
          this.expandedProjects.add(group.encodedName);
        }
        this.lastProjectGroupsLoadTime = 0; // allow fresh load
        this.refresh();
      });

      if (isExpanded) {
        const sessionsEl = this.listEl!.createDiv({
          cls: "augment-tm-project-sessions",
        });
        this.renderHistorySections(group.sessions, group.totalOnDisk, sessionsEl);
      }
    }
  }

  private renderHistorySections(
    sessions: SessionMeta[],
    totalOnDisk: number,
    container: HTMLElement
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

    for (const groupKey of groupOrder) {
      const groupSessions = groups.get(groupKey)!;
      container.createDiv({
        cls: "augment-tm-date-group",
        text: groupKey,
      });
      for (const session of groupSessions) {
        this.renderHistoryRow(session, container);
      }
    }

    // "Load 50 more" if disk has more than currently loaded.
    if (totalOnDisk > this.historyLoadedCount) {
      const loadMore = container.createDiv({
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

  private renderHistoryRow(session: SessionMeta, container: HTMLElement): void {
    const isExpanded = this.expandedSessionId === session.id;
    const row = container.createDiv({ cls: "augment-tm-item is-history" });

    const line = row.createDiv({ cls: "augment-tm-line" });

    const dot = line.createDiv({ cls: "augment-tm-dot" });
    dot.addClass(session.status === "stale" ? "stale" : "exited");
    dot.setAttribute("title", session.status === "stale" ? "Active recently — may still be running" : "Session ended");

    line.createSpan({ cls: "augment-tm-name", text: session.title });
    line.createDiv({ cls: "augment-tm-spacer" });
    const tsEl = line.createSpan({ cls: "augment-tm-timestamp" });
    tsEl.dataset.mtime = String(session.mtimeMs);
    tsEl.textContent = this.relativeTime(session.mtimeMs);

    if (session.msgCount > 0) {
      const secEl = row.createDiv({ cls: "augment-tm-summary" });
      secEl.textContent = `${session.msgCount} msg${session.msgCount !== 1 ? "s" : ""}`;
    }

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

  private refreshTimestamps(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll<HTMLElement>(".augment-tm-timestamp[data-mtime]").forEach(el => {
      el.textContent = this.relativeTime(Number(el.dataset.mtime));
    });
    this.listEl.querySelectorAll<HTMLElement>(".augment-tm-reltime[data-ms]").forEach(el => {
      el.textContent = this.relativeTime(Number(el.dataset.ms));
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
