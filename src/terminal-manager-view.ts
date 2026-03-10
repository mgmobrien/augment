import { EventRef, ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";
import { ProjectGroup, SessionMeta, SessionStore } from "./session-store";
import type { PartInfo } from "./inbox-bus";
import { discoverVaultParts, HUMAN_ADDRESS, unreadCount } from "./inbox-bus";
import { ComposeModal } from "./inbox-suggest";
import {
  findTerminalLeafForPart,
  openHumanInbox,
  openPartInboxForPart,
} from "./part-inbox-view";

export const VIEW_TYPE_TERMINAL_MANAGER = "augment-terminal-manager";


type ActivityState = "thinking" | "bash" | "read" | "write" | "mcp" | "waiting" | "idle" | null;
type CurrentActivity = { state: ActivityState; detail: string | null } | null;
type TerminalManagerWorkspaceEvents = ItemView["app"]["workspace"] & {
  on(name: "augment-terminal:changed" | "augment-bus:changed", callback: () => void): EventRef;
};

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
  getManagedTeamId?: () => string | null;
  getManagedRoleId?: () => string | null;
  setName?: (name: string) => void;
};

type TeamContext = {
  isTeamMember: boolean;
  isSubAgent: boolean;
  isManagedTeamMember?: boolean;
  managedRoleId?: string | null;
};
type ManagedTeamGroup = {
  teamId: string;
  displayName: string;
  members: WorkspaceLeaf[];
  status: string;
  lastActivityMs: number;
};

const STATUS_PRIORITY: Record<string, number> = {
  crashed: 7,
  waiting: 6,
  active: 5,
  tool: 4,
  running: 3,
  shell: 2,
  idle: 1,
  exited: 0,
};

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
  private inboxCollapseState: "open" | "closed" = "open";
  private partsCollapseState: "open" | "closed" = "open";
  private collapsedManagedTeams: Set<string> = new Set();


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
    header.createSpan({ cls: "augment-tm-title", text: "AUGMENT" });
    const headerActions = header.createDiv({ cls: "augment-tm-header-actions" });

    const launchBtn = headerActions.createEl("button", {
      cls: "augment-tm-launch clickable-icon",
      attr: { type: "button", "aria-label": "Launch managed team" },
    });
    launchBtn.setAttribute("title", "Launch managed team");
    setIcon(launchBtn, "rocket");
    launchBtn.addEventListener("click", () => {
      void this.getPlugin()?.openTeamLaunchPicker?.();
    });

    const ccLaunchBtn = headerActions.createEl("button", {
      cls: "augment-tm-launch augment-tm-launch-cc clickable-icon",
      attr: { type: "button", "aria-label": "Launch CC team" },
    });
    ccLaunchBtn.setAttribute("title", "Launch CC team");
    setIcon(ccLaunchBtn, "terminal");
    ccLaunchBtn.addEventListener("click", () => {
      void (this.getPlugin() as any)?.openCCTeamLaunchPicker?.();
    });

    const addBtn = headerActions.createEl("button", {
      cls: "augment-tm-add clickable-icon",
      attr: { type: "button", "aria-label": "Open terminal" },
    });
    addBtn.setAttribute("title", "Open terminal");
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
      (this.app.workspace as TerminalManagerWorkspaceEvents).on("augment-terminal:changed", () =>
        this.requestRefresh()
      )
    );
    this.registerEvent(
      (this.app.workspace as TerminalManagerWorkspaceEvents).on("augment-bus:changed", () =>
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
    // Cancel any pending RAF so the latest state is always read. Without this,
    // an in-flight RAF from a status-change event can swallow the rename event:
    // requestRefresh() early-returns, the stale RAF fires with the old name, and
    // the TM never shows the auto-renamed session until the next layout-change.
    if (this.refreshFrameId !== null) {
      window.cancelAnimationFrame(this.refreshFrameId);
    }
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

  private computeManagedTeamGroups(leaves: WorkspaceLeaf[]): ManagedTeamGroup[] {
    const byTeam = new Map<string, WorkspaceLeaf[]>();

    for (const leaf of leaves) {
      const view = leaf.view as TerminalViewLike;
      const teamId = this.getManagedTeamId(view);
      if (!teamId) continue;
      const group = byTeam.get(teamId) ?? [];
      group.push(leaf);
      byTeam.set(teamId, group);
    }

    return Array.from(byTeam.entries())
      .map(([teamId, members]) => {
        const sortedMembers = members.sort((a, b) => this.compareManagedTeamMembers(a, b));
        return {
          teamId,
          displayName: this.getManagedTeamDisplayName(teamId, sortedMembers),
          members: sortedMembers,
          status: this.getGroupStatus(sortedMembers),
          lastActivityMs: this.getGroupLastActivityMs(sortedMembers),
        };
      })
      .sort((a, b) => {
        const statusDiff = this.getStatusPriority(b.status) - this.getStatusPriority(a.status);
        if (statusDiff !== 0) return statusDiff;
        if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
        return a.displayName.localeCompare(b.displayName);
      });
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
    const parts = discoverVaultParts(this.app);
    const activeLeaf = this.app.workspace.activeLeaf;

    const hasOpen = leaves.length > 0;
    const hasHistory = sessions.length > 0;
    const hasOtherProjects = otherGroups.length > 0;

    this.listEl.createDiv({ cls: "augment-tm-section-label", text: "LIVE" });

    if (!hasOpen && !hasHistory && !hasOtherProjects) {
      const emptyEl = this.listEl.createDiv({ cls: "augment-tm-empty" });
      emptyEl.createDiv({ text: "No terminals yet." });
      emptyEl.createDiv({ text: "Press + to open one." });
    }

    // ── Live sessions ─────────────────────────────────────────
    if (hasOpen) {
      const managedTeamGroups = this.computeManagedTeamGroups(leaves);
      const managedLeaves = new Set<WorkspaceLeaf>();
      for (const group of managedTeamGroups) {
        for (const member of group.members) {
          managedLeaves.add(member);
        }
      }

      if (managedTeamGroups.length > 0) {
        this.renderManagedTeamCards(managedTeamGroups, activeLeaf);
      }

      const unmanagedLeaves = leaves.filter((leaf) => !managedLeaves.has(leaf));
      const teamGroups = this.computeTeamGroups(unmanagedLeaves);
      this.renderOpenSectionWithGroups(this.listEl!, unmanagedLeaves, teamGroups, activeLeaf);
    }

    // ── INBOX section ─────────────────────────────────────────
    this.renderInboxSection();

    // ── PARTS section ─────────────────────────────────────────
    this.renderPartsSection(parts);

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
      } else if (this.projectsState.inFlight) {
        otherContainer.createDiv({ cls: "augment-tm-empty", text: "Loading…" });
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
        text: "Show other projects",
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
    container: HTMLElement,
    leaves: WorkspaceLeaf[],
    teamGroups: Map<string, WorkspaceLeaf[]>,
    activeLeaf: WorkspaceLeaf | null
  ): void {
    // Track which leaves belong to any group. A leaf only appears in its
    // first detected group to prevent duplication.
    const assignedLeaves = new Set<WorkspaceLeaf>();

    for (const [teamName, members] of teamGroups) {
      // Team header.
      const teamHeader = container.createDiv({ cls: "augment-tm-team-label" });
      teamHeader.createSpan({ text: teamName });

      // Leader (most teamMembers).
      const leader = members[0];
      assignedLeaves.add(leader);
      this.renderOpenRow(container, leader, activeLeaf, {
        isTeamMember: true,
        isSubAgent: false,
      });

      // Sub-agents.
      for (const member of members.slice(1)) {
        assignedLeaves.add(member);
        this.renderOpenRow(container, member, activeLeaf, {
          isTeamMember: true,
          isSubAgent: true,
        });
      }

      // Gap after group.
      container.createDiv({ cls: "augment-tm-team-gap" });
    }

    // Ungrouped leaves.
    for (const leaf of leaves) {
      if (!assignedLeaves.has(leaf)) {
        this.renderOpenRow(container, leaf, activeLeaf, {
          isTeamMember: false,
          isSubAgent: false,
        });
      }
    }
  }

  private renderOpenRow(
    container: HTMLElement,
    leaf: WorkspaceLeaf,
    activeLeaf: WorkspaceLeaf | null,
    teamContext: TeamContext = { isTeamMember: false, isSubAgent: false }
  ): void {
    const view = leaf.view as TerminalViewLike;
    const row = container.createDiv({ cls: "augment-tm-item" });

    if (leaf === activeLeaf) row.addClass("is-active");
    if (teamContext.isTeamMember) row.addClass("augment-tm-team-member");
    if (teamContext.isSubAgent) row.addClass("is-sub-agent");
    if (teamContext.isManagedTeamMember) row.addClass("is-managed-team-member");

    const line = row.createDiv({ cls: "augment-tm-line" });

    const dot = line.createDiv({ cls: "augment-tm-dot" });
    const status = this.getLeafStatus(view);
    dot.addClass(status);
    // Left-accent border keyed to status — suppressed on team member rows (they use their own border).
    if (!teamContext.isTeamMember) row.addClass("status-" + status);
    dot.setAttribute("title", this.getStatusTooltipLabel(status));

    const name = this.getLeafTerminalName(leaf, view);
    const identity = typeof view.getAgentIdentity === "function" ? view.getAgentIdentity() : null;
    const managedRoleId = teamContext.managedRoleId?.trim()
      ? teamContext.managedRoleId.trim()
      : null;
    const primaryName =
      managedRoleId ??
      (teamContext.isManagedTeamMember ? identity ?? name : name);
    const autoNamed = typeof view.getAutoNamed === "function" && view.getAutoNamed();
    const nameEl = line.createSpan({
      cls: "augment-tm-name" + (autoNamed ? " is-just-named" : ""),
      text: primaryName,
    });
    if (autoNamed) setTimeout(() => nameEl.removeClass("is-just-named"), 1200);

    // Click-to-rename: clicking the name span opens an inline text input.
    if (!teamContext.isManagedTeamMember && typeof view.setName === "function") {
      nameEl.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const currentName = nameEl.textContent ?? "";
        const input = document.createElement("input");
        input.type = "text";
        input.value = currentName;
        input.className = "augment-tm-name-input";
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
          const newName = input.value.trim();
          if (newName && newName !== currentName) {
            (view.setName as (n: string) => void)(newName);
          }
          input.replaceWith(nameEl);
          nameEl.textContent = newName || currentName;
        };
        const cancel = () => { input.replaceWith(nameEl); };

        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        });
        input.addEventListener("blur", commit);
      });
    }
    const secondaryLabel = teamContext.isManagedTeamMember
      ? primaryName.toLowerCase() !== name.toLowerCase()
        ? name
        : null
      : identity && identity.toLowerCase() !== name.toLowerCase()
        ? identity
        : null;
    if (secondaryLabel) {
      line.createSpan({ cls: "augment-tm-role", text: secondaryLabel });
    }
    if (teamContext.isManagedTeamMember) {
      line.createSpan({
        cls: "augment-tm-managed-state",
        text: this.getMemberActivityLabel(view),
      });
    }

    // Working directory basename label.
    const cwd = typeof view.getWorkingDirectory === "function" ? view.getWorkingDirectory() : "";
    if (cwd && !teamContext.isManagedTeamMember) {
      const cwdBasename = cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
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

    // Subtext: last team event summary only (CWD is already shown as the right-side badge).
    if (summary) {
      row.createDiv({ cls: "augment-tm-subtext", text: summary });
    }

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

    if (!teamContext.isManagedTeamMember && (teams.length > 0 || members.length > 0)) {
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

  private renderManagedTeamCards(
    groups: ManagedTeamGroup[],
    activeLeaf: WorkspaceLeaf | null
  ): void {
    for (const group of groups) {
      const isExpanded = !this.collapsedManagedTeams.has(group.teamId);
      const card = this.listEl!.createDiv({ cls: "augment-tm-team-card" });
      if (isExpanded) card.addClass("is-open");

      const header = card.createDiv({ cls: "augment-tm-team-header" });
      const headerMain = header.createDiv({ cls: "augment-tm-team-header-main" });

      const dot = headerMain.createDiv({ cls: "augment-tm-dot" });
      dot.addClass(group.status);
      dot.setAttribute("title", this.getStatusTooltipLabel(group.status));

      const headerCopy = headerMain.createDiv({ cls: "augment-tm-team-header-copy" });
      headerCopy.createDiv({ cls: "augment-tm-team-title", text: group.displayName });
      headerCopy.createDiv({
        cls: "augment-tm-team-meta",
        text: `${group.members.length} member${group.members.length === 1 ? "" : "s"}`,
      });

      const headerTrailing = header.createDiv({ cls: "augment-tm-team-header-trailing" });
      const actions = headerTrailing.createDiv({ cls: "augment-tm-team-actions" });
      const shutdownBtn = actions.createEl("button", {
        cls: "augment-tm-team-action clickable-icon",
        attr: { type: "button", "aria-label": "Shutdown team" },
      });
      shutdownBtn.setAttribute("title", "Shutdown team");
      setIcon(shutdownBtn, "square");
      shutdownBtn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.getPlugin()?.shutdownManagedTeam?.(group.teamId);
      });

      headerTrailing.createSpan({ cls: "augment-tm-team-chevron", text: "›" });

      const body = card.createDiv({ cls: "augment-tm-team-body" });
      if (!isExpanded) body.style.display = "none";

      for (const member of group.members) {
        const memberView = member.view as TerminalViewLike;
        this.renderOpenRow(body, member, activeLeaf, {
          isTeamMember: true,
          isSubAgent: false,
          isManagedTeamMember: true,
          managedRoleId: this.getManagedRoleId(memberView),
        });
      }

      header.addEventListener("click", () => {
        const nextExpanded = this.collapsedManagedTeams.has(group.teamId);
        if (nextExpanded) {
          this.collapsedManagedTeams.delete(group.teamId);
        } else {
          this.collapsedManagedTeams.add(group.teamId);
        }
        card.toggleClass("is-open", nextExpanded);
        body.style.display = nextExpanded ? "" : "none";
      });
    }
  }

  private showActivityTooltip(evt: MouseEvent, view: TerminalViewLike): void {
    const activity = typeof view.getCurrentActivity === "function" ? view.getCurrentActivity() : null;
    const status = typeof view.getStatus === "function" ? view.getStatus() : null;
    const lastMs = typeof view.getLastActivityMs === "function" ? view.getLastActivityMs() : 0;
    const summary = typeof view.getLastTeamEventSummary === "function" ? view.getLastTeamEventSummary() : null;

    // Priority 1: activity.detail exists → state label + full untruncated path.
    if (activity?.detail) {
      const stateLabel: Record<string, string> = {
        bash: "Running Bash", read: "Reading file", write: "Writing file", mcp: "Using tool",
      };
      const label = stateLabel[activity.state ?? ""] ?? (activity.state ?? "Active");
      this.hideActivityTooltip();
      const tip = document.body.createDiv({ cls: "augment-tm-activity-tip" });
      this.tooltipEl = tip;
      tip.createDiv({ cls: "augment-tm-activity-tip-label", text: label });
      tip.createDiv({ cls: "augment-tm-activity-tip-detail", text: activity.detail });
      if (summary) tip.createDiv({ cls: "augment-tm-activity-tip-detail", text: summary });
      this.positionTooltip(tip, evt);
      return;
    }

    // Priority 2: Thinking with no detail → show nothing.
    if (activity?.state === "thinking") return;

    const timeStr = (ms: number) =>
      new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    let stateLine = "";
    if (status === "idle" || status === "shell") {
      if (lastMs > 0) {
        stateLine = "Idle · " + timeStr(lastMs);
      } else {
        return;
      }
    } else if (activity?.state === "waiting" || status === "waiting") {
      stateLine = "Waiting for input";
    } else if (status === "exited") {
      stateLine = "Exited" + (lastMs > 0 ? " · " + timeStr(lastMs) : "");
    } else if (status === "crashed") {
      stateLine = "Crashed" + (lastMs > 0 ? " · " + timeStr(lastMs) : "");
    } else {
      return;
    }

    this.hideActivityTooltip();
    const tip = document.body.createDiv({ cls: "augment-tm-activity-tip" });
    this.tooltipEl = tip;
    tip.createDiv({ cls: "augment-tm-activity-tip-label", text: stateLine });
    if (summary) tip.createDiv({ cls: "augment-tm-activity-tip-detail", text: summary });
    this.positionTooltip(tip, evt);
  }

  private positionTooltip(tip: HTMLElement, evt: MouseEvent): void {
    tip.style.left = `${Math.min(evt.clientX + 12, window.innerWidth - 440)}px`;
    tip.style.top = `${evt.clientY + 14}px`;
  }

  private hideActivityTooltip(): void {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }

  private bindRowActivation(
    row: HTMLElement,
    action: () => void,
    ariaLabel: string
  ): void {
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", ariaLabel);
    row.tabIndex = 0;
    row.addEventListener("click", () => action());
    row.addEventListener("keydown", (evt) => {
      if (evt.target !== row) return;
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      action();
    });
  }

  private renderPartsSection(parts: PartInfo[]): void {
    const isExpanded = this.partsCollapseState !== "closed";

    const divider = this.listEl!.createDiv({ cls: "augment-tm-section-divider" });
    if (isExpanded) divider.addClass("is-open");
    divider.createSpan({ cls: "augment-tm-section-label", text: "PARTS" });
    divider.createSpan({ cls: "augment-tm-section-chevron", text: "›" });

    const partsContainer = this.listEl!.createDiv({ cls: "augment-tm-parts-container" });
    if (!isExpanded) partsContainer.style.display = "none";

    partsContainer.createDiv({
      cls: "augment-tm-part-helper",
      text: "Click a part to see conversation history. Use the pen to send a message.",
    });

    if (parts.length === 0) {
      partsContainer.createDiv({
        cls: "augment-tm-empty augment-tm-parts-empty",
        text: "No parts found. Parts are AI agents that live in your vault.",
      });
    }

    const groups = new Map<string, PartInfo[]>();
    for (const part of parts) {
      const group = groups.get(part.habitat) ?? [];
      group.push(part);
      groups.set(part.habitat, group);
    }

    for (const [habitat, groupParts] of groups) {
      partsContainer.createDiv({
        cls: "augment-tm-date-group",
        text: habitat === "vault" ? "Vault" : habitat,
      });
      for (const part of groupParts) {
        this.renderPartRow(part, partsContainer);
      }
    }

    divider.addEventListener("click", () => {
      this.partsCollapseState = isExpanded ? "closed" : "open";
      divider.toggleClass("is-open", !isExpanded);
      partsContainer.style.display = isExpanded ? "none" : "";
    });
  }

  private renderInboxSection(): void {
    const unread = unreadCount(this.app, HUMAN_ADDRESS);
    const isExpanded = this.inboxCollapseState !== "closed";

    const divider = this.listEl!.createDiv({ cls: "augment-tm-section-divider" });
    if (isExpanded) divider.addClass("is-open");
    divider.createSpan({ cls: "augment-tm-section-label", text: "INBOX" });
    if (unread > 0) {
      divider.createSpan({
        cls: "augment-tm-section-count",
        text: `(${unread} unread)`,
      });
    }
    divider.createSpan({ cls: "augment-tm-section-chevron", text: "›" });

    const inboxContainer = this.listEl!.createDiv({ cls: "augment-tm-parts-container" });
    if (!isExpanded) inboxContainer.style.display = "none";

    const row = inboxContainer.createDiv({ cls: "augment-tm-item augment-tm-part-row augment-tm-inbox-row" });
    if (unread > 0) row.addClass("has-unread");

    const line = row.createDiv({ cls: "augment-tm-line" });
    line.createDiv({ cls: "augment-tm-dot augment-tm-part-dot" });
    line.createSpan({ cls: "augment-tm-name", text: "My inbox" });
    line.createDiv({ cls: "augment-tm-spacer" });

    if (unread > 0) {
      line.createSpan({ cls: "augment-tm-part-badge", text: String(unread) });
    }

    this.bindRowActivation(
      row,
      () => {
        void openHumanInbox(this.app);
      },
      "Open messages addressed to you"
    );

    divider.addEventListener("click", () => {
      this.inboxCollapseState = isExpanded ? "closed" : "open";
      divider.toggleClass("is-open", !isExpanded);
      inboxContainer.style.display = isExpanded ? "none" : "";
    });
  }

  private renderPartRow(part: PartInfo, container: HTMLElement): void {
    const row = container.createDiv({ cls: "augment-tm-item augment-tm-part-row" });
    const isLive = Boolean(findTerminalLeafForPart(this.app, part));
    row.addClass(isLive ? "is-live" : "is-offline");

    const line = row.createDiv({ cls: "augment-tm-line" });
    line.createDiv({ cls: "augment-tm-dot augment-tm-part-dot" });
    line.createSpan({ cls: "augment-tm-name", text: part.name });
    line.createDiv({ cls: "augment-tm-spacer" });

    const composeBtn = line.createEl("button", {
      cls: "augment-tm-part-compose clickable-icon",
      attr: { type: "button", "aria-label": `Compose to ${part.name}` },
    });
    setIcon(composeBtn, "square-pen");
    composeBtn.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const activeFile = this.app.workspace.getActiveFile();
      const sourceNote = activeFile?.basename ?? "";
      new ComposeModal(
        this.app,
        part.address,
        part.isProjectPart ? part.address : part.name,
        sourceNote,
        ""
      ).open();
    });

    row.createDiv({
      cls: "augment-tm-subtext augment-tm-part-subtext",
      text: `${part.habitat === "vault" ? "vault part" : part.habitat} · ${
        isLive ? "live" : "offline"
      }`,
    });

    this.bindRowActivation(
      row,
      () => {
        void openPartInboxForPart(this.app, part.address);
      },
      `Open conversation with ${part.name}`
    );
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

    // Dual-name subtext: full excerpt if different from the truncated title.
    if (session.titleFull && session.titleFull !== session.title) {
      row.createDiv({ cls: "augment-tm-subtext", text: session.titleFull });
    }

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

  private getManagedTeamId(view: TerminalViewLike): string | null {
    const value =
      typeof view.getManagedTeamId === "function" ? view.getManagedTeamId() : null;
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private getManagedRoleId(view: TerminalViewLike): string | null {
    const value =
      typeof view.getManagedRoleId === "function" ? view.getManagedRoleId() : null;
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private getLeafStatus(view: TerminalViewLike): string {
    return typeof view.getStatus === "function" ? view.getStatus() ?? "shell" : "shell";
  }

  private getStatusPriority(status: string | null): number {
    return STATUS_PRIORITY[status ?? ""] ?? 0;
  }

  private getStatusTooltipLabel(status: string): string {
    const labels: Record<string, string> = {
      active: "Generating (yellow)",
      tool: "Using tool (blue)",
      waiting: "Waiting for input (orange)",
      idle: "Idle",
      shell: "Open",
      running: "Running",
      crashed: "Crashed",
      exited: "Exited",
    };
    return labels[status] ?? status;
  }

  private getMemberActivityLabel(view: TerminalViewLike): string {
    const activity = typeof view.getCurrentActivity === "function" ? view.getCurrentActivity() : null;
    switch (activity?.state) {
      case "thinking":
        return "Thinking";
      case "bash":
        return "Running Bash";
      case "read":
        return "Reading";
      case "write":
        return "Writing";
      case "mcp":
        return "Using tool";
      case "waiting":
        return "Waiting";
      case "idle":
        return "Idle";
    }

    const status = this.getLeafStatus(view);
    const statusLabels: Record<string, string> = {
      active: "Generating",
      tool: "Using tool",
      waiting: "Waiting",
      idle: "Idle",
      shell: "Open",
      running: "Running",
      crashed: "Crashed",
      exited: "Exited",
    };
    return statusLabels[status] ?? "Open";
  }

  private compareManagedTeamMembers(a: WorkspaceLeaf, b: WorkspaceLeaf): number {
    const aView = a.view as TerminalViewLike;
    const bView = b.view as TerminalViewLike;
    const aRole = this.getManagedRoleId(aView) ?? "";
    const bRole = this.getManagedRoleId(bView) ?? "";
    const aIsLead = /\bceo\b/i.test(aRole);
    const bIsLead = /\bceo\b/i.test(bRole);
    if (aIsLead !== bIsLead) return aIsLead ? -1 : 1;

    const activityDiff = this.getStatusPriority(this.getLeafStatus(bView)) - this.getStatusPriority(this.getLeafStatus(aView));
    if (activityDiff !== 0) return activityDiff;

    const aName = aRole || this.getLeafTerminalName(a, aView);
    const bName = bRole || this.getLeafTerminalName(b, bView);
    return aName.localeCompare(bName);
  }

  private getManagedTeamDisplayName(teamId: string, members: WorkspaceLeaf[]): string {
    const encodedDisplayName = teamId.split("::")[1];
    if (encodedDisplayName) {
      try {
        const decoded = decodeURIComponent(encodedDisplayName);
        if (decoded.trim()) {
          return decoded.trim();
        }
      } catch {
        // Fall through to legacy heuristics for malformed IDs.
      }
    }

    const cwdBasenames = members
      .map((leaf) => {
        const view = leaf.view as TerminalViewLike;
        const cwd = typeof view.getWorkingDirectory === "function" ? view.getWorkingDirectory() : "";
        return cwd.split(/[/\\]/).filter(Boolean).pop() ?? "";
      })
      .filter((name) => name.length > 0);

    if (cwdBasenames.length > 0) {
      const [first] = cwdBasenames;
      if (cwdBasenames.every((name) => name === first)) {
        return first;
      }
    }

    const fallback = teamId.split(/[/\\]/).filter(Boolean).pop() || teamId;
    try {
      return decodeURIComponent(fallback);
    } catch {
      return fallback;
    }
  }

  private getGroupStatus(members: WorkspaceLeaf[]): string {
    let bestStatus = "exited";
    for (const leaf of members) {
      const view = leaf.view as TerminalViewLike;
      const status = this.getLeafStatus(view);
      if (this.getStatusPriority(status) > this.getStatusPriority(bestStatus)) {
        bestStatus = status;
      }
    }
    return bestStatus;
  }

  private getGroupLastActivityMs(members: WorkspaceLeaf[]): number {
    let lastActivityMs = 0;
    for (const leaf of members) {
      const view = leaf.view as TerminalViewLike;
      const currentMs =
        typeof view.getLastActivityMs === "function" ? view.getLastActivityMs() : 0;
      lastActivityMs = Math.max(lastActivityMs, currentMs);
    }
    return lastActivityMs;
  }

  private relativeTime(mtimeMs: number, abbreviated = false): string {
    const diff = Date.now() - mtimeMs;
    const mins = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(diff / 86_400_000);

    if (abbreviated) {
      if (diff < 60_000) return "just now";
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
