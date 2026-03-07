import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";
import { ProjectGroup, SessionMeta, SessionStore } from "./session-store";

export const VIEW_TYPE_TERMINAL_MANAGER = "augment-terminal-manager";


type ActivityState = "thinking" | "bash" | "read" | "write" | "mcp" | "waiting" | "idle" | null;
type CurrentActivity = { state: ActivityState; detail: string | null } | null;

type TerminalViewLike = {
  getStatus?: () => string;
  getName?: () => string;
  getUnreadActivity?: () => number;
  getTeamNames?: () => string[];
  getTeamMembers?: () => string[];
  getLastTeamEventSummary?: () => string | null;
  getAgentIdentity?: () => string | null;
  getCurrentActivity?: () => CurrentActivity;
  markActivityRead?: () => void;
  getExchangeCount?: () => number;
  getLastActivityMs?: () => number;
  getAutoNamed?: () => boolean;
  getWorkingDirectory?: () => string;
};

type TeamContext = { isTeamMember: boolean; isSubAgent: boolean };

export class TerminalManagerView extends ItemView {
  private listEl: HTMLElement | null = null;
  private sessionStore: SessionStore | null = null;
  private historyLoadedCount: number = 20;
  private refreshFrameId: number | null = null;

  private otherProjectsEnabled = false;
  private otherProjectsExpanded = true;

  // Async loader state objects — owned by createAsyncLoader() closures.
  private historyState = { cached: [] as SessionMeta[], lastLoadTime: 0, inFlight: false, reloadRequested: false };
  private projectsState = { cached: [] as ProjectGroup[], lastLoadTime: 0, inFlight: false, reloadRequested: false };
  private maybeLoadHistory: () => void = () => {};
  private maybeLoadProjects: () => void = () => {};

  // Which other-project groups are expanded (collapsed by default).
  private expandedProjects: Set<string> = new Set();

  // Collapse state for the RECENT history section.
  // "auto": expand when no live sessions, collapse otherwise.
  // "open" / "closed": explicit user preference.
  private historyCollapseState: "auto" | "open" | "closed" = "auto";


  // Hover tooltip for session activity.
  private tooltipEl: HTMLDivElement | null = null;

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
    return "square-terminal";
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

    // Respect persisted "show other projects" preference.
    if (this.getPlugin()?.settings?.showOtherProjects) {
      this.otherProjectsEnabled = true;
    }

    // Wire up async loaders. historyRequestedLimit is captured per-call to
    // detect mid-load limit changes (user clicked "Load 50 more").
    let historyRequestedLimit = 0;
    this.maybeLoadHistory = this.createAsyncLoader(
      this.historyState,
      () => {
        historyRequestedLimit = this.historyLoadedCount;
        return this.sessionStore!.loadSessions(historyRequestedLimit);
      },
      1500,
      () => this.historyLoadedCount !== historyRequestedLimit
    );
    this.maybeLoadProjects = this.createAsyncLoader(
      this.projectsState,
      () => this.sessionStore!.loadAllProjectGroups(50).then((gs) => gs.filter((g) => !g.isVault)),
      2000
    );

    this.requestRefresh();
    window.setTimeout(() => this.requestRefresh(), 0);
    this.app.workspace.onLayoutReady(() => this.requestRefresh());

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.requestRefresh())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.requestRefresh())
    );
    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:changed", () =>
        this.requestRefresh()
      )
    );

    // Refresh timestamps every 30s so relative times stay current.
    this.registerInterval(window.setInterval(() => this.refreshTimestamps(), 30_000));
  }

  private getPlugin(): any {
    return (this.app as any).plugins?.plugins?.["augment-terminal"];
  }

  requestRefresh(): void {
    if (this.refreshFrameId !== null) return;
    this.refreshFrameId = window.requestAnimationFrame(() => {
      this.refreshFrameId = null;
      this.refresh();
    });
  }

  private getHistorySessions(): SessionMeta[] {
    this.maybeLoadHistory();
    return this.historyState.cached;
  }

  private getOtherProjectGroups(): ProjectGroup[] {
    this.maybeLoadProjects();
    return this.projectsState.cached;
  }

  // Returns a debounced async loader for a given load function and TTL.
  // State is stored in the passed-in object so callers can reset lastLoadTime
  // and set reloadRequested externally (e.g., from "Load more" click handlers).
  // extraReload: optional extra condition that triggers a reload in finally().
  private createAsyncLoader<T>(
    state: { cached: T; lastLoadTime: number; inFlight: boolean; reloadRequested: boolean },
    loadFn: () => Promise<T>,
    ttlMs: number,
    extraReload?: () => boolean
  ): () => void {
    const maybeLoad = (): void => {
      if (Date.now() - state.lastLoadTime < ttlMs) return;
      if (!this.sessionStore) return;
      if (state.inFlight) { state.reloadRequested = true; return; }

      state.inFlight = true;
      loadFn()
        .then((result) => { state.cached = result; state.lastLoadTime = Date.now(); })
        .catch(() => { state.lastLoadTime = Date.now(); })
        .finally(() => {
          state.inFlight = false;
          const needsReload = state.reloadRequested || (extraReload?.() ?? false);
          state.reloadRequested = false;
          if (needsReload) { state.lastLoadTime = 0; maybeLoad(); }
          if (this.listEl) this.requestRefresh();
        });
    };
    return maybeLoad;
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

    // Sync otherProjectsEnabled from persisted settings on every render so
    // the toggle in Settings → Terminal takes effect immediately.
    const plugin = this.getPlugin();
    if (plugin?.settings) {
      this.otherProjectsEnabled = plugin.settings.showOtherProjects;
    }

    const leaves = this.getTerminalLeaves();
    const sessions = this.getHistorySessions();
    const otherGroups = this.otherProjectsEnabled ? this.getOtherProjectGroups() : [];
    const activeLeaf = this.app.workspace.activeLeaf;

    const hasOpen = leaves.length > 0;
    const hasHistory = sessions.length > 0;
    const hasOtherProjects = otherGroups.length > 0;

    if (!hasOpen && !hasHistory && !hasOtherProjects) {
      const emptyEl = this.listEl.createDiv({ cls: "augment-tm-empty" });
      emptyEl.createDiv({ text: "No terminals yet." });
      emptyEl.createDiv({ text: "Press + to open one." });
      return;
    }

    // ── Live sessions (no section label — header already says TERMINALS) ──
    if (hasOpen) {
      const teamGroups = this.computeTeamGroups(leaves);
      this.renderOpenSectionWithGroups(leaves, teamGroups, activeLeaf);
    }

    // ── RECENT section with collapse ──────────────────────────
    if (hasHistory) {
      const isExpanded =
        this.historyCollapseState === "open" ||
        (this.historyCollapseState === "auto" && !hasOpen);

      const divider = this.listEl.createDiv({ cls: "augment-tm-section-divider" });
      if (isExpanded) divider.addClass("is-open");
      divider.createSpan({ cls: "augment-tm-section-label", text: "RECENT" });
      divider.createSpan({ cls: "augment-tm-section-count", text: `(${sessions.length})` });
      divider.createSpan({ cls: "augment-tm-section-chevron", text: "›" });

      const historyContainer = this.listEl.createDiv({ cls: "augment-tm-history-container" });
      if (!isExpanded) historyContainer.style.display = "none";
      this.renderHistorySections(sessions, historyContainer);

      divider.addEventListener("click", () => {
        this.historyCollapseState = isExpanded ? "closed" : "open";
        divider.toggleClass("is-open", !isExpanded);
        historyContainer.style.display = isExpanded ? "none" : "";
      });
    }

    // ── OTHER PROJECTS section ─────────────────────────────────
    if (this.otherProjectsEnabled) {
      const otherDivider = this.listEl.createDiv({ cls: "augment-tm-section-divider" });
      if (this.otherProjectsExpanded) otherDivider.addClass("is-open");
      otherDivider.createSpan({ cls: "augment-tm-section-label", text: "OTHER PROJECTS" });
      otherDivider.createSpan({ cls: "augment-tm-section-chevron", text: "›" });

      const otherContainer = this.listEl.createDiv({ cls: "augment-tm-other-projects-container" });
      if (!this.otherProjectsExpanded) otherContainer.style.display = "none";

      if (hasOtherProjects) {
        this.renderOtherProjectsSection(otherGroups, otherContainer);
      } else {
        otherContainer.createDiv({ cls: "augment-tm-empty", text: "No other projects found" });
      }

      otherDivider.addEventListener("click", () => {
        this.otherProjectsExpanded = !this.otherProjectsExpanded;
        otherDivider.toggleClass("is-open", this.otherProjectsExpanded);
        otherContainer.style.display = this.otherProjectsExpanded ? "" : "none";
      });
    } else {
      const loadDivider = this.listEl.createDiv({ cls: "augment-tm-section-divider" });
      loadDivider.createSpan({ cls: "augment-tm-section-label", text: "OTHER PROJECTS" });

      // Info icon explaining what "other projects" reads.
      const infoIcon = loadDivider.createSpan({ cls: "augment-api-key-info", text: "\u24d8" });
      let tip: HTMLElement | null = null;
      infoIcon.addEventListener("mouseenter", () => {
        tip = document.createElement("div");
        tip.className = "augment-api-key-tip";
        tip.textContent = "Shows Claude Code sessions from other projects. Claude Code stores session data in ~/.claude/projects/ for every directory you\u2019ve worked in \u2014 this reads that index. Your filesystem is not scanned directly.";
        document.body.appendChild(tip);
        const rect = infoIcon.getBoundingClientRect();
        tip.style.top = `${rect.bottom + 6}px`;
        tip.style.left = `${rect.left}px`;
      });
      infoIcon.addEventListener("mouseleave", () => {
        tip?.remove();
        tip = null;
      });

      const loadBtn = loadDivider.createEl("button", {
        cls: "augment-tm-load-projects-btn",
        text: "Load",
      });
      loadBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        // Show loading state.
        loadBtn.disabled = true;
        loadBtn.textContent = "";
        loadBtn.addClass("is-loading");
        const spinner = loadBtn.createSpan({ cls: "augment-tm-spinner" });

        this.otherProjectsEnabled = true;
        this.otherProjectsExpanded = true;
        this.projectsState.lastLoadTime = 0;
        this.projectsState.reloadRequested = true;
        // Persist the preference so it survives reloads.
        const plugin = this.getPlugin();
        if (plugin?.settings) {
          plugin.settings.showOtherProjects = true;
          void plugin.saveData(plugin.settings);
        }
        this.requestRefresh();
      });
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
      active: "Generating (yellow)", tool: "Using tool (blue)", waiting: "Waiting for input (orange)",
      idle: "Idle", shell: "Open", running: "Running", crashed: "Crashed", exited: "Exited",
    };
    dot.setAttribute("title", dotLabel[status] ?? status);

    const name = this.getLeafTerminalName(leaf, view);
    const autoNamed = typeof view.getAutoNamed === "function" && view.getAutoNamed();
    const nameEl = line.createSpan({ cls: "augment-tm-name" + (autoNamed ? " is-just-named" : ""), text: name });
    if (autoNamed) setTimeout(() => nameEl.removeClass("is-just-named"), 1200);
    const identity = typeof view.getAgentIdentity === "function" ? view.getAgentIdentity() : null;
    if (identity && identity.toLowerCase() !== name.toLowerCase()) {
      line.createSpan({ cls: "augment-tm-role", text: identity });
    }

    // Working directory basename label.
    const cwd = typeof view.getWorkingDirectory === "function" ? view.getWorkingDirectory() : "";
    if (cwd) {
      const cwdBasename = cwd.split("/").filter(Boolean).pop() || cwd;
      line.createSpan({ cls: "augment-tm-cwd", text: cwdBasename });
    }

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

    if (exchangeCount > 0 || lastActivityMs > 0 || summary) {
      const secEl = row.createDiv({ cls: "augment-tm-summary" });
      if (exchangeCount > 0) {
        const countText = `${exchangeCount} msg${exchangeCount !== 1 ? "s" : ""}`;
        if (lastActivityMs > 0) {
          const rtEl = document.createElement("span");
          rtEl.className = "augment-tm-reltime";
          rtEl.dataset.ms = String(lastActivityMs);
          rtEl.textContent = this.relativeTime(lastActivityMs);
          secEl.textContent = countText + " · ";
          secEl.appendChild(rtEl);
        } else {
          secEl.textContent = countText;
        }
        if (summary) secEl.appendChild(document.createTextNode(" — " + summary));
      } else if (lastActivityMs > 0) {
        const rtEl = document.createElement("span");
        rtEl.className = "augment-tm-reltime";
        rtEl.dataset.ms = String(lastActivityMs);
        rtEl.textContent = this.relativeTime(lastActivityMs);
        secEl.appendChild(rtEl);
        if (summary) secEl.appendChild(document.createTextNode(" — " + summary));
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

    row.addEventListener("mouseenter", (evt) => this.showActivityTooltip(evt, view));
    row.addEventListener("mouseleave", () => this.hideActivityTooltip());
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

  private showActivityTooltip(evt: MouseEvent, view: TerminalViewLike): void {
    const activity = typeof view.getCurrentActivity === "function" ? view.getCurrentActivity() : null;
    const status = typeof view.getStatus === "function" ? view.getStatus() : null;
    const lastMs = typeof view.getLastActivityMs === "function" ? view.getLastActivityMs() : 0;

    let label = "";
    let detail = "";

    if (activity?.state === "thinking") {
      label = "Thinking";
    } else if (activity?.state === "bash") {
      label = "Running Bash";
      detail = activity.detail ?? "";
    } else if (activity?.state === "read") {
      label = "Reading file";
      detail = activity.detail ?? "";
    } else if (activity?.state === "write") {
      label = "Writing file";
      detail = activity.detail ?? "";
    } else if (activity?.state === "mcp") {
      label = "Using tool";
      detail = activity.detail ?? "";
    } else if (activity?.state === "waiting" || status === "waiting") {
      label = "Waiting for input";
    } else if (status === "idle" || status === "shell") {
      label = "Idle";
      if (lastMs > 0) detail = `Last active ${this.relativeTime(lastMs)}`;
    } else if (status === "exited") {
      label = "Exited";
      if (lastMs > 0) detail = `Last active ${this.relativeTime(lastMs)}`;
    } else if (status === "crashed") {
      label = "Crashed";
    } else {
      return; // nothing useful to show
    }

    this.hideActivityTooltip();
    const tip = document.body.createDiv({ cls: "augment-tm-activity-tip" });
    this.tooltipEl = tip;

    const labelEl = tip.createDiv({ cls: "augment-tm-activity-tip-label", text: label });
    if (detail) tip.createDiv({ cls: "augment-tm-activity-tip-detail", text: detail });

    const reposition = () => {
      const x = evt.clientX + 12;
      const y = evt.clientY + 14;
      tip.style.left = `${Math.min(x, window.innerWidth - 300)}px`;
      tip.style.top = `${y}px`;
    };
    reposition();
  }

  private hideActivityTooltip(): void {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }

  private renderOtherProjectsSection(groups: ProjectGroup[], container: HTMLElement): void {
    for (const group of groups) {
      const isExpanded = this.expandedProjects.has(group.encodedName);

      const projectRow = container.createDiv({ cls: "augment-tm-project-row" + (isExpanded ? " is-expanded" : "") });
      const line = projectRow.createDiv({ cls: "augment-tm-line" });

      line.createSpan({
        cls: "augment-tm-project-chevron",
        text: "›",
      });

      // Display the last meaningful path segment.
      const segments = group.projectName.split("/").filter(Boolean);
      const displayName = segments.slice(-1)[0] || group.projectName;
      line.createSpan({ cls: "augment-tm-project-name", text: displayName });
      line.createDiv({ cls: "augment-tm-spacer" });

      const metaEl = line.createSpan({ cls: "augment-tm-project-meta" });
      metaEl.textContent = `${group.totalOnDisk} · ${this.relativeTime(group.lastActivityMs)}`;

      // Pre-render sessions so the toggle can be handled via direct DOM
      // manipulation. Using requestRefresh() here causes a full DOM rebuild
      // before the click event fires (triggered by active-leaf-change when the
      // TM sidebar gains focus on first interaction), which detaches the row
      // element and swallows the click.
      const sessionsEl = container.createDiv({ cls: "augment-tm-project-sessions" });
      if (!isExpanded) sessionsEl.style.display = "none";
      this.renderHistorySections(group.sessions, sessionsEl);

      projectRow.addEventListener("click", () => {
        if (this.expandedProjects.has(group.encodedName)) {
          this.expandedProjects.delete(group.encodedName);
          projectRow.removeClass("is-expanded");
          sessionsEl.style.display = "none";
        } else {
          this.expandedProjects.add(group.encodedName);
          projectRow.addClass("is-expanded");
          sessionsEl.style.display = "";
        }
      });
    }
  }

  private renderHistorySections(
    sessions: SessionMeta[],
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
    if (sessions.length >= this.historyLoadedCount) {
      const loadMore = container.createDiv({
        cls: "augment-tm-load-more",
        text: "Load 50 more \u2193",
      });
      loadMore.addEventListener("click", () => {
        this.historyLoadedCount += 50;
        this.historyState.lastLoadTime = 0; // force reload
        this.historyState.reloadRequested = true;
        this.requestRefresh();
      });
    }
  }

  private showSessionTooltip(evt: MouseEvent, session: SessionMeta): void {
    const excerpt = session.titleFull || session.title;
    if (!excerpt) return;

    this.hideActivityTooltip();
    const tip = document.body.createDiv({ cls: "augment-tm-activity-tip" });
    this.tooltipEl = tip;

    tip.createDiv({ cls: "augment-tm-activity-tip-detail", text: excerpt });

    const meta: string[] = [];
    if (session.msgCount > 0) meta.push(`${session.msgCount} msg${session.msgCount !== 1 ? "s" : ""}`);
    meta.push(this.relativeTime(session.mtimeMs));
    tip.createDiv({ cls: "augment-tm-activity-tip-label", text: meta.join(" · ") });

    const x = evt.clientX + 12;
    const y = evt.clientY + 14;
    tip.style.left = `${Math.min(x, window.innerWidth - 340)}px`;
    tip.style.top = `${y}px`;
  }

  private renderHistoryRow(session: SessionMeta, container: HTMLElement): void {
    const row = container.createDiv({ cls: "augment-tm-item is-history is-archived" });

    const line = row.createDiv({ cls: "augment-tm-line" });

    // Dim circle — styling applied via CSS .is-archived .augment-tm-dot
    line.createDiv({ cls: "augment-tm-dot" });

    line.createSpan({ cls: "augment-tm-name", text: session.title });
    line.createDiv({ cls: "augment-tm-spacer" });

    const ageEl = line.createSpan({ cls: "augment-tm-age" });
    ageEl.dataset.ms = String(session.mtimeMs);
    ageEl.dataset.msgCount = String(session.msgCount);
    ageEl.textContent = this.formatHistoryMeta(session.msgCount, session.mtimeMs);

    row.addEventListener("mouseenter", (evt) => this.showSessionTooltip(evt, session));
    row.addEventListener("mouseleave", () => this.hideActivityTooltip());

    // Click directly resumes the session — no expand drawer.
    row.addEventListener("click", async () => {
      const plugin = this.getPlugin();
      if (!plugin) return;
      const termView = await plugin.openFocusedTerminal();
      if (termView) {
        setTimeout(() => {
          termView.write(`claude --resume ${session.resumeId}\n`);
        }, 800);
      }
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
                termView.write(`claude --resume ${session.resumeId}\n`);
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
    this.listEl.querySelectorAll<HTMLElement>(".augment-tm-reltime[data-ms], .augment-tm-age[data-ms]").forEach(el => {
      const ms = Number(el.dataset.ms);
      if (el.classList.contains("augment-tm-age")) {
        const msgCount = el.dataset.msgCount !== undefined ? Number(el.dataset.msgCount) : -1;
        el.textContent = msgCount >= 0
          ? this.formatHistoryMeta(msgCount, ms)
          : this.relativeTime(ms, true);
      } else {
        el.textContent = this.relativeTime(ms);
      }
    });
  }

  private formatHistoryMeta(msgCount: number, mtimeMs: number): string {
    const age = this.relativeTime(mtimeMs, true);
    if (msgCount > 0) return `${msgCount} msg${msgCount !== 1 ? "s" : ""} · ${age}`;
    return age;
  }

  private relativeTime(mtimeMs: number, abbreviated = false): string {
    const diff = Date.now() - mtimeMs;
    const mins = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);

    if (abbreviated) {
      if (diff < 3_600_000) return `${mins}m`;
      if (diff < 86_400_000) return `${hours}h`;
      return `${days}d`;
    }

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
    if (this.refreshFrameId !== null) {
      window.cancelAnimationFrame(this.refreshFrameId);
      this.refreshFrameId = null;
    }
    this.hideActivityTooltip();
    this.listEl = null;
  }

  private getLeafTerminalName(
    leaf: WorkspaceLeaf,
    view: TerminalViewLike
  ): string {
    // getName() reads this.terminalName directly — always in sync, even before
    // the async setViewState() call from persistNameToLeafState() resolves.
    // Prefer it over getViewState() which may lag by one render frame.
    if (typeof view.getName === "function") {
      const value = view.getName();
      if (value?.trim()) return value.trim();
    }

    const leafAny = leaf as any;
    const stateName = leafAny.getViewState?.()?.state?.name;
    if (typeof stateName === "string" && stateName.trim()) {
      return stateName.trim();
    }

    const leafEl = leafAny?.view?.containerEl?.closest?.(".workspace-leaf");
    const headerName = leafEl
      ?.querySelector?.(".view-header-title")
      ?.textContent?.trim();
    if (headerName) return headerName;

    return leafAny.getDisplayText?.() || "terminal";
  }
}
