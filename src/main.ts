import { addIcon, App, Editor, EditorPosition, FuzzySuggestModal, MarkdownView, Notice, Plugin, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { execFile } from "child_process";
import { applyOutputFormat, bestModelByTier, bestModelId, buildSystemPrompt, buildUserMessage, fetchModels, friendlyApiError, generateText, logApiDiagnostics, ModelInfo, modelDisplayName, substituteVariables } from "./ai-client";
import { AgentSuggest } from "./agent-suggest";
import { summarizeAttentionSessions } from "./attention-queue";
import { BusPollerManager } from "./bus-poller";
import {
  AUGMENT_CONTROL_CENTER_UNAVAILABLE_NOTICE,
  resolveReachableControlCenterRootUrl,
} from "./control-center-redirect";
import { InboxSuggest } from "./inbox-suggest";
import {
  DEFAULT_WATCHED_INBOX_ADDRESSES,
  setBusNotifier,
  unreadCountForAddresses,
} from "./inbox-bus";
import { buildManagedRoleStatus, createDeliveryObservation } from "../packages/shared-domain/src";
import type {
  DeliveryObservation,
  ManagedRoleStatus,
  ManagedTerminalStatus,
  TeamRosterProject,
} from "../packages/shared-domain/src";
import { ContextInspectorView, VIEW_TYPE_CONTEXT_INSPECTOR } from "./context-inspector-view";
import { openAllMessages, PartInboxView, VIEW_TYPE_PART_INBOX } from "./part-inbox-view";
import { AugmentSettingTab } from "./settings-tab";
import { getTemplateFiles, runGenerateTemplatesFlow, TemplatePicker, TemplatePreviewModal } from "./template-picker";
import { assembleNoteContext, assembleVaultContext, AugmentSettings, ContextEntry, DEFAULT_SETTINGS, populateLinkedNoteContent, SessionRecord, SpendData, TerminalOpenLocation } from "./vault-context";
import { TerminalView, VIEW_TYPE_TERMINAL, cleanupXtermStyle } from "./terminal-view";
import { TerminalManagerView, VIEW_TYPE_TERMINAL_MANAGER } from "./terminal-manager-view";
import { TerminalSwitcherModal } from "./terminal-switcher";
import {
  buildPostLaunchWatcherSetup,
  buildTeamLaunchSpec,
  computeTeamLayout,
} from "./team-launch";
import * as teamLaunchModule from "./team-launch";
import { discoverTeamProjects } from "./team-roster";
import { EditorView, keymap } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { SCAFFOLD_FOLDER, SCAFFOLD_TEMPLATES, SCAFFOLD_SKILLS_FOLDER, SCAFFOLD_SKILLS } from "./scaffold-data";
import { addSpinnerEffect, removeSpinnerEffect, spinnerField, addAgentWidgetEffect, removeAgentWidgetEffect, agentWidgetField } from "./editor-extensions";
import { TeamCreateSpawnEvent, RenameModal, InitTeamModal } from "./terminal-modals";
import { SelectionTransformModal } from "./selection-transform-modal";
import { SideQuestionModal } from "./side-question-modal";
import { summarizeStatusBridgeSessions } from "./status-bridge";
import { promisify } from "util";

declare const __AUGMENT_BUILD_ID__: string;
declare const __AUGMENT_GIT_SHA__: string;

const execFileAsync = promisify(execFile);
const CC_NATIVE_TEAM_ID_PREFIX = "cc-native-team::";

type SelectionTransformSnapshot = {
  originalText: string;
  from: EditorPosition;
  to: EditorPosition;
  noteTitle: string;
  filePath: string | null;
};

type SideQuestionSnapshot = {
  insertPos: number;
  noteTitle: string;
  filePath: string | null;
};

type AddressedTerminalView = Partial<TerminalView> & {
  getBusAddress?: () => string | null;
  getManagedTeamId?: () => string | null;
  getManagedRoleId?: () => string | null;
  appendSystemOutput?: (text: string) => void;
  write?: (text: string) => void;
};

type StatusBridgeTerminalView = Partial<TerminalView> & {
  getName?: () => string;
  getStatus?: () => string;
  getLastActivityMs?: () => number;
};

async function isWslAvailable(): Promise<boolean> {
  try {
    const result = await execFileAsync("wsl.exe", ["--list", "--quiet"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function buildWelcomeNoteContent(mod: string): string {
  return `# Get started with Augment

Augment adds AI-powered text generation and Claude Code terminal sessions to Obsidian. This note walks you through everything.

---

## 1. Add your API key

You need a console API key from [console.anthropic.com/settings/api-keys](https://console.anthropic.com/settings/api-keys) — not your Claude.ai login.

> [!warning] Claude Max/Pro subscriptions don't work here
> Anthropic prohibits OAuth tokens in third-party tools (Feb 2026). You need a pay-per-token key starting with \`sk-ant-api03-\`. Billing is separate from any subscription.

Open settings: **${mod}+,** → Augment in the left sidebar → Overview tab. Add your key there, then come back.

---

## 2. Generate (${mod}+Enter)

Augment reads your note title, frontmatter, the text above your cursor, and any linked notes — then continues from where your cursor is. Output goes directly below your cursor.

**Try it.** Put your cursor at the end of the line below and press ${mod}+Enter:

The most interesting thing about writing in plain text is

---

## 3. Template picker (${mod}+Shift+Enter)

Instead of free-form generation, templates run a specific prompt on your current note — useful for recurring tasks: summarise, extract action items, rewrite in a different register.

**Try it:** Press **${mod}+Shift+Enter** to open the template picker.

Templates are \`.md\` files in your templates folder (\`Augment/templates/\` by default). Configure the folder in Settings → Templates. Each template can define a custom system prompt via \`system_prompt:\` in its frontmatter.

---

## 4. Context inspector

The context inspector shows exactly what Augment sent to the AI: system prompt, this note's content, linked notes, and a token estimate per section. It updates live as you write.

**Open it:** Command palette → \`Augment: Open context inspector\`

The panel opens in your right sidebar. Use it to understand why the AI responded the way it did, or to check your context budget before generating.

---

## 5. Right-click menu

Right-clicking in any note gives you quick access without shortcuts:
- **Augment: Generate** — same as ${mod}+Enter
- **Augment: Generate from template…** — same as ${mod}+Shift+Enter

---

## 6. Claude Code terminal sessions

Augment hosts Claude Code agent sessions in a panel alongside your notes. Each session runs a full CC conversation with access to your vault.

**Set it up:** Settings → Terminal → follow the guided setup. Four steps, same on every platform: install Node.js, install Claude Code, sign in, configure vault.

---

*This note lives at \`Augment/Get started.md\`. Reopen it any time: command palette → \`Augment: Open welcome\`.*
`;
}

class TeamProjectPickerModal extends FuzzySuggestModal<TeamRosterProject> {
  private projects: TeamRosterProject[];
  private onChoose: (project: TeamRosterProject) => void;

  constructor(app: App, projects: TeamRosterProject[], onChoose: (project: TeamRosterProject) => void) {
    super(app);
    this.projects = projects;
    this.onChoose = onChoose;
    this.setPlaceholder("Launch project team...");
  }

  getItems(): TeamRosterProject[] {
    return this.projects;
  }

  getItemText(project: TeamRosterProject): string {
    return `${project.projectDisplayName} (${project.projectId})`;
  }

  renderSuggestion(project: { item: TeamRosterProject; match: any }, el: HTMLElement): void {
    const wrapper = el.createDiv({ cls: "augment-ts-suggestion" });
    wrapper.createSpan({ cls: "augment-ts-name", text: project.item.projectDisplayName });
    wrapper.createEl("small", { text: project.item.projectId });
  }

  onChooseItem(project: TeamRosterProject): void {
    this.onChoose(project);
  }
}

type ActiveGeneration = {
  id: string;
  abortController: AbortController;
  cmView: EditorView;
  insertPos: number;
  showSpinner: boolean;
};

export default class AugmentTerminalPlugin extends Plugin {
  settings: AugmentSettings = { ...DEFAULT_SETTINGS };
  public availableModels: ModelInfo[] = [];
  public contextHistory: ContextEntry[] = [];
  public readonly buildId: string = __AUGMENT_BUILD_ID__;
  public readonly gitSha: string = __AUGMENT_GIT_SHA__;
  private recentTeamCreateSpawnSignatures: Map<string, number> = new Map();
  private calloutStyleEl: HTMLStyleElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private statusBridgePopoverEl: HTMLDivElement | null = null;
  private statusBridgePopoverCleanup: (() => void) | null = null;
  private ribbonGenerateEl: HTMLElement | null = null;
  private ribbonTerminalEl: HTMLElement | null = null;
  private _tier1Registered = false;
  private _tier3Registered = false;
  public spendData: SpendData | null = null;
  private readonly SPEND_PATH = "augment-spend.json";
  private waitingBadgeEl: HTMLElement | null = null;
  private waitingCursor: number = 0;
  private activeGenerations: Map<string, ActiveGeneration> = new Map();
  private generationCounter = 0;
  private busPollerManager: BusPollerManager | null = null;
  private readonly managedDeliveryByRole: Map<string, DeliveryObservation> = new Map();
  private readonly addressedTerminalPollers = new Map<string, { address: string; view: AddressedTerminalView }>();

  private buildManagedRoleKey(teamId: string, roleId: string): string {
    return `${teamId}::${roleId}`;
  }

  private updateManagedDeliveryObservation(
    teamId: string,
    roleId: string,
    updater: (current: DeliveryObservation) => DeliveryObservation
  ): void {
    const key = this.buildManagedRoleKey(teamId, roleId);
    const current = this.managedDeliveryByRole.get(key);
    if (!current) return;

    this.managedDeliveryByRole.set(key, updater(current));
    this.app.workspace.trigger("augment-terminal:changed");
  }

  private noteManagedDeliveryPollSuccess(teamId: string, roleId: string): void {
    this.updateManagedDeliveryObservation(teamId, roleId, (current) => {
      const now = Date.now();
      return {
        ...current,
        firstDeliveryReadyAt: current.firstDeliveryReadyAt ?? now,
        lastDeliveryPollAt: now,
        lastDeliveryError: null,
      };
    });
  }

  private noteManagedDeliveryPollFailure(teamId: string, roleId: string, error: unknown): void {
    this.updateManagedDeliveryObservation(teamId, roleId, (current) => ({
      ...current,
      lastDeliveryPollAt: Date.now(),
      lastDeliveryError: error instanceof Error ? error.message : String(error),
    }));
  }

  private addressedTerminalPollerKey(address: string): string {
    return `augment-terminal::${address}`;
  }

  private stopAddressedTerminalPollers(): void {
    if (!this.busPollerManager) return;

    for (const key of this.addressedTerminalPollers.keys()) {
      this.busPollerManager.stopPoller(key);
    }

    this.addressedTerminalPollers.clear();
  }

  private syncAddressedTerminalBusPollers(): void {
    if (!this.busPollerManager) return;

    const vaultBase = (((this.app.vault.adapter as any).basePath as string | undefined) ?? "").trim();
    if (!vaultBase) {
      this.stopAddressedTerminalPollers();
      return;
    }

    const activeLeaf = this.app.workspace.activeLeaf;
    const desired = new Map<string, {
      address: string;
      view: AddressedTerminalView;
      managedTeamId: string;
      managedRoleId: string;
      isActive: boolean;
    }>();

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
      const view = leaf.view as AddressedTerminalView;
      const leafState = (leaf as any).getViewState?.()?.state;
      const address =
        (typeof view.getBusAddress === "function" ? view.getBusAddress()?.trim() ?? "" : "") ||
        (typeof leafState?.busAddress === "string" ? leafState.busAddress.trim() : "");

      if (!address) continue;

      const key = this.addressedTerminalPollerKey(address);
      const candidate = {
        address,
        view,
        managedTeamId:
          (typeof view.getManagedTeamId === "function" ? view.getManagedTeamId()?.trim() ?? "" : "") ||
          (typeof leafState?.managedTeamId === "string" ? leafState.managedTeamId.trim() : ""),
        managedRoleId:
          (typeof view.getManagedRoleId === "function" ? view.getManagedRoleId()?.trim() ?? "" : "") ||
          (typeof leafState?.managedRoleId === "string" ? leafState.managedRoleId.trim() : ""),
        isActive: leaf === activeLeaf,
      };
      const existing = desired.get(key);

      if (!existing || (!existing.isActive && candidate.isActive)) {
        desired.set(key, candidate);
      }
    }

    for (const key of this.addressedTerminalPollers.keys()) {
      if (desired.has(key)) continue;
      this.busPollerManager.stopPoller(key);
      this.addressedTerminalPollers.delete(key);
    }

    for (const [key, target] of desired.entries()) {
      const existing = this.addressedTerminalPollers.get(key);
      if (existing && existing.address === target.address && existing.view === target.view) {
        continue;
      }

      if (existing) {
        this.busPollerManager.stopPoller(key);
      }

      this.busPollerManager.startPoller(
        key,
        target.address,
        vaultBase,
        (text: string) => {
          if (typeof target.view.appendSystemOutput === "function") {
            target.view.appendSystemOutput(text);
            return;
          }

          target.view.write?.(text);
        },
        {
          onPollSuccess: () => {
            if (target.managedTeamId && target.managedRoleId) {
              this.noteManagedDeliveryPollSuccess(target.managedTeamId, target.managedRoleId);
            }
          },
          onPollFailure: (error: unknown) => {
            if (target.managedTeamId && target.managedRoleId) {
              this.noteManagedDeliveryPollFailure(target.managedTeamId, target.managedRoleId, error);
            }
          },
        }
      );

      this.addressedTerminalPollers.set(key, { address: target.address, view: target.view });
    }
  }

  public getManagedRoleStatuses(teamId?: string): ManagedRoleStatus[] {
    const targetTeamId = teamId?.trim() ?? "";
    const statuses: ManagedRoleStatus[] = [];

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
      const view = leaf.view as Partial<TerminalView>;
      const leafState = (leaf as any).getViewState?.()?.state;
      const resolvedTeamId =
        (typeof view.getManagedTeamId === "function" ? view.getManagedTeamId()?.trim() ?? "" : "") ||
        (typeof leafState?.managedTeamId === "string" ? leafState.managedTeamId.trim() : "");
      const resolvedRoleId =
        (typeof view.getManagedRoleId === "function" ? view.getManagedRoleId()?.trim() ?? "" : "") ||
        (typeof leafState?.managedRoleId === "string" ? leafState.managedRoleId.trim() : "");

      if (!resolvedTeamId || !resolvedRoleId) continue;
      if (resolvedTeamId.startsWith(CC_NATIVE_TEAM_ID_PREFIX)) continue;
      if (targetTeamId && resolvedTeamId !== targetTeamId) continue;

      const terminalStatus: ManagedTerminalStatus =
        typeof view.getStatus === "function" ? view.getStatus() : "shell";
      const observation = this.managedDeliveryByRole.get(this.buildManagedRoleKey(resolvedTeamId, resolvedRoleId));
      const viewName = typeof view.getName === "function" ? view.getName()?.trim() ?? "" : "";
      const stateName = typeof leafState?.name === "string" ? leafState.name.trim() : "";

      statuses.push(buildManagedRoleStatus({
        teamId: resolvedTeamId,
        roleId: resolvedRoleId,
        address: viewName || stateName || null,
        observation,
        terminalStatus,
      }));
    }

    statuses.sort((left, right) => {
      const teamCompare = left.teamId.localeCompare(right.teamId);
      if (teamCompare !== 0) return teamCompare;
      return left.roleId.localeCompare(right.roleId);
    });

    return statuses;
  }

  private async maybeDefaultWindowsShellToWsl(): Promise<void> {
    if (process.platform !== "win32") return;
    if (this.settings.shellPath.trim().length > 0) return;

    if (!(await isWslAvailable())) return;
    if (this.settings.shellPath.trim().length > 0) return;

    this.settings.shellPath = "wsl.exe";
    try {
      await this.saveData(this.settings);
    } catch (err) {
      console.warn("[Augment] failed to save WSL shell default", err);
    }
  }

  // Returns the actual model ID to use, resolving "auto" and tier aliases to the best available.
  public resolveModel(): string {
    switch (this.settings.model) {
      case "auto":         return bestModelId(this.availableModels) ?? "claude-opus-4-6";
      case "auto-opus":    return bestModelByTier(this.availableModels, "opus")   ?? "claude-opus-4-6";
      case "auto-sonnet":  return bestModelByTier(this.availableModels, "sonnet") ?? "claude-sonnet-4-6";
      case "auto-haiku":   return bestModelByTier(this.availableModels, "haiku")  ?? "claude-haiku-4-5-20251001";
      default:             return this.settings.model;
    }
  }

  // Display name for the resolved model — used in status bar and output formats.
  // Prefers curated local names over API-returned display_name (API may truncate, e.g. "Claude Opus 4" vs "Claude Opus 4.6").
  public resolveModelDisplayName(): string {
    const id = this.resolveModel();
    const localName = modelDisplayName(id);
    // modelDisplayName returns the id itself when not found — if it differs, we have a curated name.
    if (localName !== id) return localName;
    const found = this.availableModels.find(m => m.id === id);
    return found?.display_name ?? id;
  }

  /** Sync the `.augment-ribbon-colored` class with the current setting value. */
  public applyRibbonColoredClass(): void {
    if (!this.ribbonGenerateEl) return;
    if (this.settings.coloredRibbonIcon) {
      this.ribbonGenerateEl.addClass("augment-ribbon-colored");
    } else {
      this.ribbonGenerateEl.removeClass("augment-ribbon-colored");
    }
  }

  /** Swap the ribbon Generate button icon to match the current ribbonIcon setting. */
  public applyRibbonIcon(): void {
    if (!this.ribbonGenerateEl) return;
    // Call setIcon on the container element, not the inner .svg-icon span.
    // Calling it on the span causes the icon to revert when Obsidian refreshes the ribbon.
    setIcon(this.ribbonGenerateEl, this.settings.ribbonIcon || "augment-pyramid");
  }

  public refreshStatusBar(): void {
    if (this.activeGenerations.size > 0) {
      this.showStatusBarGenerating();
    } else {
      this.ribbonGenerateEl?.removeClass("augment-ribbon-generating");
      this.ribbonGenerateEl?.removeClass("is-generating");
    }
    if (!this.statusBarEl) return;

    const snapshot = this.getStatusBridgeSnapshot();

    this.statusBarEl.empty();
    this.statusBarEl.addClass("augment-status-bridge");

    // Generation indicator takes priority over status bridge session count.
    if (this.activeGenerations.size > 0) {
      this.statusBarEl.toggleClass("is-quiet", false);
      this.statusBarEl.toggleClass("is-active", true);
      this.statusBarEl.setAttribute("aria-label", "Generating…");
      this.statusBarEl.setAttribute("title", "Generating…");
      this.statusBarEl.createSpan({
        cls: "augment-status-bridge-label",
        text: "Generating…",
      });
      return;
    }

    this.statusBarEl.toggleClass("is-quiet", snapshot.activeSessionCount === 0);
    this.statusBarEl.toggleClass("is-active", snapshot.activeSessionCount > 0);
    this.statusBarEl.setAttribute("role", "button");
    this.statusBarEl.setAttribute("aria-haspopup", "dialog");
    this.statusBarEl.setAttribute("aria-expanded", this.statusBridgePopoverEl ? "true" : "false");
    this.statusBarEl.setAttribute("aria-label", snapshot.label);
    this.statusBarEl.setAttribute("title", snapshot.label);
    this.statusBarEl.createSpan({
      cls: "augment-status-bridge-label",
      text: snapshot.label,
    });

    if (this.statusBridgePopoverEl) {
      this.renderStatusBridgePopoverContent();
      this.positionStatusBridgePopover();
    }
  }

  public getBuildFingerprint(): string {
    return `${this.buildId} (${this.gitSha})`;
  }

  private createGenerationId(): string {
    this.generationCounter += 1;
    return `generation-${this.generationCounter}`;
  }

  private getActiveGenerationsForView(cmView: EditorView): ActiveGeneration[] {
    return Array.from(this.activeGenerations.values()).filter((generation) => generation.cmView === cmView);
  }

  private syncGenerationSpinners(cmView: EditorView, selectionPos?: number): void {
    const effects = [
      removeSpinnerEffect.of(null),
      ...this.getActiveGenerationsForView(cmView)
        .filter((generation) => generation.showSpinner)
        .map((generation) => addSpinnerEffect.of(Math.min(generation.insertPos, cmView.state.doc.length))),
    ];
    const transaction: Parameters<EditorView["dispatch"]>[0] = { effects };
    if (selectionPos != null) {
      transaction.selection = EditorSelection.cursor(Math.min(selectionPos, cmView.state.doc.length), 1);
    }
    cmView.dispatch(transaction);
  }

  private registerGeneration(
    cmView: EditorView,
    insertPos: number,
    abortController: AbortController,
    showSpinner: boolean
  ): ActiveGeneration {
    const generation: ActiveGeneration = {
      id: this.createGenerationId(),
      abortController,
      cmView,
      insertPos,
      showSpinner,
    };
    this.activeGenerations.set(generation.id, generation);
    if (showSpinner) {
      this.syncGenerationSpinners(cmView, insertPos);
    }
    this.refreshStatusBar();
    return generation;
  }

  private unregisterGeneration(generationId: string): void {
    const generation = this.activeGenerations.get(generationId);
    if (!generation) {
      this.refreshStatusBar();
      return;
    }
    this.activeGenerations.delete(generationId);
    this.syncGenerationSpinners(generation.cmView);
    this.refreshStatusBar();
  }

  private insertTextAndShiftGenerations(
    editor: Editor,
    insertPos: number,
    insertedText: string,
    sourceGenerationId?: string
  ): number {
    if (insertedText.length === 0) return insertPos;

    const safeInsertPos = Math.min(insertPos, editor.getValue().length);
    editor.replaceRange(insertedText, editor.offsetToPos(safeInsertPos));
    const delta = insertedText.length;

    for (const generation of this.activeGenerations.values()) {
      if (generation.id === sourceGenerationId) {
        generation.insertPos = safeInsertPos + delta;
      } else if (generation.insertPos >= safeInsertPos) {
        generation.insertPos += delta;
      }
    }

    return safeInsertPos + delta;
  }

  private cancelGeneration(): void {
    if (this.activeGenerations.size === 0) return;

    const generations = Array.from(this.activeGenerations.values());
    const selectionsByView = new Map<EditorView, number>();
    for (const generation of generations) {
      generation.abortController.abort();
      const existingPos = selectionsByView.get(generation.cmView);
      const safePos = Math.min(generation.insertPos, generation.cmView.state.doc.length);
      selectionsByView.set(generation.cmView, existingPos == null ? safePos : Math.min(existingPos, safePos));
      this.activeGenerations.delete(generation.id);
    }

    for (const [cmView, selectionPos] of selectionsByView.entries()) {
      this.syncGenerationSpinners(cmView, selectionPos);
    }

    this.refreshStatusBar();
    console.log("[Augment] generation cancelled");
    new Notice("Augment: generation cancelled");
  }

  private showStatusBarGenerating(): void {
    this.ribbonGenerateEl?.addClass("augment-ribbon-generating");
    this.ribbonGenerateEl?.addClass("is-generating");
  }

  private getStatusBridgeSnapshot() {
    return summarizeStatusBridgeSessions(
      this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL).map((leaf) => {
        const view = leaf.view as StatusBridgeTerminalView;
        const leafState = (leaf as any).getViewState?.()?.state;
        const name =
          (typeof view.getName === "function" ? view.getName()?.trim() ?? "" : "") ||
          (typeof leafState?.name === "string" ? leafState.name.trim() : "") ||
          "Terminal";
        const rawStatus = typeof view.getStatus === "function" ? view.getStatus() : "shell";
        const status =
          typeof rawStatus === "string" && rawStatus.trim().length > 0 ? rawStatus : "shell";
        const lastActivityMs =
          typeof view.getLastActivityMs === "function" ? view.getLastActivityMs() ?? 0 : 0;

        return { name, status, lastActivityMs };
      })
    );
  }

  private renderStatusBridgePopoverContent(): void {
    if (!this.statusBridgePopoverEl) return;

    const snapshot = this.getStatusBridgeSnapshot();
    this.statusBridgePopoverEl.empty();

    const header = this.statusBridgePopoverEl.createDiv({ cls: "augment-status-bridge-popover-header" });
    header.createDiv({
      cls: "augment-status-bridge-popover-kicker",
      text: "Augment",
    });
    header.createDiv({
      cls: "augment-status-bridge-popover-title",
      text: snapshot.label,
    });

    if (snapshot.recentSessions.length === 0) {
      this.statusBridgePopoverEl.createDiv({
        cls: "augment-status-bridge-empty",
        text: "No active sessions",
      });
    } else {
      const sessionsEl = this.statusBridgePopoverEl.createDiv({ cls: "augment-status-bridge-sessions" });
      for (const session of snapshot.recentSessions) {
        const row = sessionsEl.createDiv({ cls: "augment-status-bridge-session" });
        const dot = row.createDiv({ cls: "augment-status-bridge-session-dot" });
        dot.addClass(`is-${session.status}`);
        row.createDiv({ cls: "augment-status-bridge-session-name", text: session.name });
        row.createDiv({
          cls: "augment-status-bridge-session-meta",
          text: session.statusLabel,
        });
      }
    }

    const actions = this.statusBridgePopoverEl.createDiv({ cls: "augment-status-bridge-actions" });
    const newSessionButton = actions.createEl("button", {
      cls: "augment-status-bridge-link",
      text: "+ New session",
      attr: { type: "button" },
    });
    newSessionButton.addEventListener("click", () => {
      this.closeStatusBridgePopover();
      void this.openTerminalAt(this.settings.defaultTerminalLocation);
    });

    const openControlCenterButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Open Control Center",
      attr: { type: "button" },
    });
    openControlCenterButton.addEventListener("click", () => {
      this.closeStatusBridgePopover();
      void this.openControlCenter();
    });
  }

  private positionStatusBridgePopover(): void {
    if (!this.statusBarEl || !this.statusBridgePopoverEl) return;

    const anchorRect = this.statusBarEl.getBoundingClientRect();
    const popoverRect = this.statusBridgePopoverEl.getBoundingClientRect();
    const top = Math.max(8, anchorRect.top - popoverRect.height - 8);
    const left = Math.min(
      window.innerWidth - popoverRect.width - 8,
      Math.max(8, anchorRect.right - popoverRect.width)
    );

    this.statusBridgePopoverEl.style.top = `${top}px`;
    this.statusBridgePopoverEl.style.left = `${left}px`;
  }

  private openStatusBridgePopover(): void {
    if (!this.statusBarEl || this.statusBridgePopoverEl) return;

    this.statusBridgePopoverEl = document.body.createDiv({ cls: "augment-status-bridge-popover" });
    this.statusBridgePopoverEl.setAttribute("role", "dialog");
    this.statusBridgePopoverEl.setAttribute("aria-label", "Augment active sessions");

    this.renderStatusBridgePopoverContent();
    this.positionStatusBridgePopover();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.statusBridgePopoverEl?.contains(target)) return;
      if (this.statusBarEl?.contains(target)) return;
      this.closeStatusBridgePopover();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.closeStatusBridgePopover();
      }
    };

    const handleResize = () => {
      this.closeStatusBridgePopover();
    };

    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleResize);

    this.statusBridgePopoverCleanup = () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleResize);
    };

    this.statusBarEl.setAttribute("aria-expanded", "true");
  }

  private closeStatusBridgePopover(): void {
    this.statusBridgePopoverCleanup?.();
    this.statusBridgePopoverCleanup = null;
    this.statusBridgePopoverEl?.remove();
    this.statusBridgePopoverEl = null;
    this.statusBarEl?.setAttribute("aria-expanded", "false");
  }

  private toggleStatusBridgePopover(): void {
    if (this.statusBridgePopoverEl) {
      this.closeStatusBridgePopover();
      return;
    }

    this.openStatusBridgePopover();
  }

  private captureSelectionTransformSnapshot(editor: Editor): SelectionTransformSnapshot | null {
    const originalText = editor.getSelection();
    if (!originalText) return null;

    const activeFile = this.app.workspace.getActiveFile();
    return {
      originalText,
      from: editor.getCursor("from"),
      to: editor.getCursor("to"),
      noteTitle: activeFile?.basename ?? "Untitled",
      filePath: activeFile?.path ?? null,
    };
  }

  private captureSideQuestionSnapshot(editor: Editor): SideQuestionSnapshot {
    const activeFile = this.app.workspace.getActiveFile();
    return {
      insertPos: editor.posToOffset(editor.getCursor()),
      noteTitle: activeFile?.basename ?? "Untitled",
      filePath: activeFile?.path ?? null,
    };
  }

  private openSelectionTransform(editor: Editor): void {
    if (!this.settings.apiKey) {
      console.log("[Augment] API key required");
      const notice = new Notice("Augment: API key required — click to open settings", 0);
      notice.noticeEl.style.cursor = "pointer";
      notice.noticeEl.addEventListener("click", () => {
        notice.hide();
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("augment-terminal");
      });
      return;
    }

    const snapshot = this.captureSelectionTransformSnapshot(editor);
    if (!snapshot) {
      new Notice("Select text to transform.");
      return;
    }

    new SelectionTransformModal(this.app, {
      noteTitle: snapshot.noteTitle,
      selectionText: snapshot.originalText,
      onTransform: (instruction, signal) =>
        this.runSelectionTransform(snapshot, instruction, signal),
      onReplace: (candidate) =>
        this.applySelectionTransform(editor, snapshot, candidate, "replace"),
      onKeepBoth: (candidate) =>
        this.applySelectionTransform(editor, snapshot, candidate, "keep-both"),
    }).open();
  }

  private openSideQuestion(editor: Editor): void {
    if (!this.settings.apiKey) {
      console.log("[Augment] API key required");
      const notice = new Notice("Augment: API key required — click to open settings", 0);
      notice.noticeEl.style.cursor = "pointer";
      notice.noticeEl.addEventListener("click", () => {
        notice.hide();
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById("augment-terminal");
      });
      return;
    }

    const snapshot = this.captureSideQuestionSnapshot(editor);
    new SideQuestionModal(this.app, {
      onAsk: (question, signal) =>
        this.runSideQuestion(snapshot, question, signal),
      onInsert: (answer) =>
        this.insertSideQuestionAnswer(editor, snapshot, answer),
    }).open();
  }

  private async runSelectionTransform(
    snapshot: SelectionTransformSnapshot,
    instruction: string,
    signal: AbortSignal
  ): Promise<string> {
    const context = {
      title: snapshot.noteTitle,
      frontmatter: null,
      selection: snapshot.originalText,
      surroundingContext: "",
      linkedNotes: [],
    };
    const baseSystemPrompt = await buildSystemPrompt(
      context,
      this.settings.systemPrompt || undefined,
      this.settings.workspaceScope,
      this.settings.defaultWorkingDirectory || undefined
    );
    const systemPrompt = [
      baseSystemPrompt,
      "Transform the selected text according to the user's instruction. Return only the replacement text. Do not add commentary or code fences unless the instruction asks for them.",
    ].filter(Boolean).join("\n\n");
    const userMessage = [
      "Instruction:",
      instruction.trim(),
      "",
      "Selected text:",
      snapshot.originalText,
    ].join("\n");

    this.showStatusBarGenerating();
    if (this.settings.showGenerationToast) {
      new Notice("Generating...", 3000);
    }

    try {
      const resolvedModel = this.resolveModel();
      const resolvedModelName = this.resolveModelDisplayName();
      const { text: result, usage: genUsage } = await generateText(
        systemPrompt,
        userMessage,
        this.settings,
        resolvedModel,
        signal
      );
      if (signal.aborted) return "";
      void this.accumulateSpend(resolvedModel, genUsage);

      const entry: ContextEntry = {
        timestamp: Date.now(),
        noteName: snapshot.noteTitle,
        model: resolvedModelName,
        systemPrompt,
        userMessage,
      };
      this.pushContextHistory(entry);

      if (!this.settings.hasGenerated) {
        this.settings.hasGenerated = true;
        await this.saveData(this.settings);
        this.registerTieredCommands();
      }

      return result;
    } catch (err) {
      if (signal.aborted) throw err;
      console.error("[Augment] selection transform failed", err);
      logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
      const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
      throw new Error(errMsg);
    } finally {
      this.refreshStatusBar();
    }
  }

  private async runSideQuestion(
    snapshot: SideQuestionSnapshot,
    question: string,
    signal: AbortSignal
  ): Promise<string> {
    const context = {
      title: snapshot.noteTitle,
      frontmatter: null,
      selection: "",
      surroundingContext: "",
      linkedNotes: [],
    };
    const baseSystemPrompt = await buildSystemPrompt(
      context,
      this.settings.systemPrompt || undefined,
      this.settings.workspaceScope,
      this.settings.defaultWorkingDirectory || undefined
    );
    const systemPrompt = [
      baseSystemPrompt,
      "Answer the user's side question using only the question provided. Do not claim to have read the current note, selection, linked notes, or any other hidden context. Return only the answer.",
    ].filter(Boolean).join("\n\n");
    const userMessage = [
      "Question:",
      question.trim(),
    ].join("\n");

    this.showStatusBarGenerating();
    if (this.settings.showGenerationToast) {
      new Notice("Asking...", 3000);
    }

    try {
      const resolvedModel = this.resolveModel();
      const resolvedModelName = this.resolveModelDisplayName();
      const { text: result, usage: genUsage } = await generateText(
        systemPrompt,
        userMessage,
        this.settings,
        resolvedModel,
        signal
      );
      if (signal.aborted) return "";
      void this.accumulateSpend(resolvedModel, genUsage);

      const entry: ContextEntry = {
        timestamp: Date.now(),
        noteName: snapshot.noteTitle,
        model: resolvedModelName,
        systemPrompt,
        userMessage,
      };
      this.pushContextHistory(entry);

      if (!this.settings.hasGenerated) {
        this.settings.hasGenerated = true;
        await this.saveData(this.settings);
        this.registerTieredCommands();
      }

      return result;
    } catch (err) {
      if (signal.aborted) throw err;
      console.error("[Augment] side question failed", err);
      logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
      const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
      throw new Error(errMsg);
    } finally {
      this.refreshStatusBar();
    }
  }

  private async applySelectionTransform(
    editor: Editor,
    snapshot: SelectionTransformSnapshot,
    candidate: string,
    mode: "replace" | "keep-both"
  ): Promise<boolean> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeView || activeView.editor !== editor || (snapshot.filePath && activeFile?.path !== snapshot.filePath)) {
      new Notice("Augment: reopen Transform selection… from the note you want to edit");
      return false;
    }

    const currentText = editor.getRange(snapshot.from, snapshot.to);
    if (currentText !== snapshot.originalText) {
      new Notice("The selected text changed before Augment could apply this transform. Review the candidate, then copy it manually or run the transform again.");
      return false;
    }

    const nextText = mode === "replace"
      ? candidate
      : `${snapshot.originalText}\n\n${candidate}`;
    editor.replaceRange(nextText, snapshot.from, snapshot.to);
    new Notice(
      mode === "replace"
        ? "Selection replaced. Undo to restore the original."
        : "Inserted the candidate below the original selection. Undo to remove it."
    );
    return true;
  }

  private async insertSideQuestionAnswer(
    editor: Editor,
    snapshot: SideQuestionSnapshot,
    answer: string
  ): Promise<boolean> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = this.app.workspace.getActiveFile();
    const activePath = activeFile?.path ?? null;
    if (!activeView || activeView.editor !== editor || activePath !== snapshot.filePath) {
      new Notice("Augment: return to the original note to insert this answer, or use Copy instead");
      return false;
    }

    const safeInsertPos = Math.min(snapshot.insertPos, editor.getValue().length);
    editor.replaceRange(answer, editor.offsetToPos(safeInsertPos));
    editor.setCursor(editor.offsetToPos(safeInsertPos + answer.length));
    new Notice("Inserted the answer into the note. Undo to remove it.");
    return true;
  }

  private triggerGenerate(editor: Editor): void {
    const cursor = editor.getCursor();
    const aboveCursor = editor.getRange({ line: 0, ch: 0 }, cursor);
    const promptText = aboveCursor.trim() || editor.getValue().trim();
    const ctx = assembleVaultContext(this.app, editor, this.settings);

    this.showStatusBarGenerating();
    if (this.settings.showGenerationToast) {
      const genNotice = new Notice("Generating…", 3000);
    }

    const isBlock = this.settings.outputFormat !== "plain";
    let insertPos: number;
    if (isBlock && cursor.ch > 0) {
      const cursorOffset = editor.posToOffset(cursor);
      insertPos = this.insertTextAndShiftGenerations(editor, cursorOffset, "\n");
    } else {
      insertPos = editor.posToOffset(cursor);
    }

    const cmView = (editor as any).cm as EditorView;
    const abortController = new AbortController();
    const generation = this.registerGeneration(cmView, insertPos, abortController, true);

    void (async () => {
      try {
        await populateLinkedNoteContent(this.app, ctx);
        const resolvedModel = this.resolveModel();
        const resolvedModelName = this.resolveModelDisplayName();
        const builtSystemPrompt = await buildSystemPrompt(ctx, this.settings.systemPrompt || undefined, this.settings.workspaceScope, this.settings.defaultWorkingDirectory || undefined);
        if (abortController.signal.aborted) return;
        const { text: result, usage: genUsage } = await generateText(builtSystemPrompt, promptText, this.settings, resolvedModel, abortController.signal);
        if (abortController.signal.aborted) return;
        void this.accumulateSpend(resolvedModel, genUsage);
        const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
        if (isBlock) {
          const withTrail = formatted + "\n\n";
          const nextInsertPos = this.insertTextAndShiftGenerations(editor, generation.insertPos, withTrail, generation.id);
          editor.setCursor(editor.offsetToPos(nextInsertPos));
        } else {
          this.insertTextAndShiftGenerations(editor, generation.insertPos, formatted, generation.id);
        }
        const entry: ContextEntry = {
          timestamp: Date.now(),
          noteName: ctx.title,
          model: resolvedModelName,
          systemPrompt: builtSystemPrompt,
          userMessage: buildUserMessage(ctx, promptText),
        };
        this.pushContextHistory(entry);
        console.log("[Augment] generation done");
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
          this.openContextInspector();
        });
        if (!this.settings.hasGenerated) {
          this.settings.hasGenerated = true;
          await this.saveData(this.settings);
          this.registerTieredCommands();
        }
      } catch (err) {
        if (abortController.signal.aborted) return; // Cancel — no error notice.
        console.error("[Augment] generation failed", err);
        logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
        const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
        new Notice(`Augment: ${errMsg}`);
      } finally {
        this.unregisterGeneration(generation.id);
      }
    })();
  }

  private pushContextHistory(entry: ContextEntry): void {
    this.contextHistory.push(entry);
    if (this.contextHistory.length > 5) this.contextHistory.shift();
    this.app.workspace.trigger("augment:generation-complete");
  }

  private async loadAvailableModels(): Promise<void> {
    if (!this.settings.apiKey) return;
    this.availableModels = await fetchModels(this.settings.apiKey);
    // Refresh status bar in case "auto" now resolves to a fetched model name.
    this.refreshStatusBar();
  }

  async clearObsidianLinkHotkey(): Promise<void> {
    const CONFLICT_IDS = [
      "editor:cycle-list-checklist",
      "editor:open-link-in-new-leaf",
      "obsidian-textgenerator-plugin:generate-text",
      "obsidian-textgenerator-plugin:insert-generated-text-From-template",
    ];
    try {
      const hotkeyPath = ".obsidian/hotkeys.json";
      let hotkeys: Record<string, unknown> = {};
      try {
        const raw = await this.app.vault.adapter.read(hotkeyPath);
        hotkeys = JSON.parse(raw);
      } catch { /* file may not exist yet */ }
      // Capture originals before overwriting so restore is exact.
      const originals: Record<string, unknown> = {};
      for (const id of CONFLICT_IDS) {
        if (id in hotkeys) originals[id] = hotkeys[id];
        hotkeys[id] = [];
      }
      await this.app.vault.adapter.write(hotkeyPath, JSON.stringify(hotkeys, null, 2));
      (this.app as any).hotkeyManager?.load?.();
      this.settings.clearedLinkHotkey = true;
      this.settings.clearedHotkeyOriginals = originals;
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[Augment] could not clear link hotkey:", e);
    }
  }

  async restoreObsidianLinkHotkey(): Promise<void> {
    const CONFLICT_IDS = [
      "editor:cycle-list-checklist",
      "editor:open-link-in-new-leaf",
      "obsidian-textgenerator-plugin:generate-text",
      "obsidian-textgenerator-plugin:insert-generated-text-From-template",
    ];
    // Built-in default hotkeys for commands where we called removeDefaultHotkeys().
    // Must re-add these at runtime so Obsidian's binding works immediately.
    const BUILTIN_DEFAULTS: Record<string, Array<{ modifiers: string[]; key: string }>> = {
      "editor:open-link-in-new-leaf": [{ modifiers: ["Mod"], key: "Enter" }],
    };
    try {
      const hotkeyPath = ".obsidian/hotkeys.json";
      let hotkeys: Record<string, unknown> = {};
      try {
        const raw = await this.app.vault.adapter.read(hotkeyPath);
        hotkeys = JSON.parse(raw);
      } catch { /* file may not exist */ }
      const originals = this.settings.clearedHotkeyOriginals ?? {};
      for (const id of CONFLICT_IDS) {
        if (id in originals) {
          hotkeys[id] = originals[id]; // restore exact original value
        } else {
          delete hotkeys[id]; // wasn't customised before — remove Augment's entry
        }
      }
      await this.app.vault.adapter.write(hotkeyPath, JSON.stringify(hotkeys, null, 2));
      // Restore runtime defaults that were removed via removeDefaultHotkeys().
      const hm = (this.app as any).hotkeyManager;
      for (const [id, bindings] of Object.entries(BUILTIN_DEFAULTS)) {
        hm?.addDefaultHotkeys?.(id, bindings);
      }
      await hm?.load?.();
      this.settings.clearedLinkHotkey = false;
      this.settings.clearedHotkeyOriginals = {};
      await this.saveData(this.settings);
    } catch (e) {
      console.warn("[Augment] could not restore link hotkey:", e);
    }
  }

  private showHotkeyClaimedNotice(): void {
    const notice = new Notice("", 0);
    notice.noticeEl.empty();
    notice.noticeEl.createEl("span", { text: "Augment claimed Ctrl+Enter \u2014 " });
    const link = notice.noticeEl.createEl("a", { text: "Restore Obsidian\u2019s default", href: "#" });
    link.style.color = "var(--text-accent)";
    link.style.cursor = "pointer";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      notice.hide();
      (this.app as any).setting?.open?.();
      (this.app as any).setting?.openTabById?.("augment-terminal");
    });
  }

  private async scaffoldDefaultTemplates(): Promise<void> {
    const targetFolder = this.settings.templateFolder || SCAFFOLD_FOLDER;

    // Create folder if absent.
    if (!this.app.vault.getAbstractFileByPath(targetFolder)) {
      try { await this.app.vault.createFolder(targetFolder); } catch { /* already exists */ }
    }

    // Ensure templateFolder setting is saved.
    if (!this.settings.templateFolder) {
      this.settings.templateFolder = targetFolder;
      await this.saveData(this.settings);
    }

    // Write each default template if its file doesn't exist yet.
    // Never overwrite existing files — user edits are preserved.
    // New defaults added in future versions will be seeded into existing vaults.
    for (const [name, content] of SCAFFOLD_TEMPLATES) {
      const path = `${targetFolder}/${name}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.create(path, content); } catch { /* already exists */ }
      }
    }

    // Set templateFolder so the picker finds the scaffolded files.
    this.settings.templateFolder = targetFolder;
    await this.saveData(this.settings);
  }

  private async scaffoldDefaultSkills(): Promise<void> {
    // Create top-level folder if absent.
    if (!this.app.vault.getAbstractFileByPath(SCAFFOLD_SKILLS_FOLDER)) {
      try { await this.app.vault.createFolder(SCAFFOLD_SKILLS_FOLDER); } catch { /* already exists */ }
    }

    for (const [folderName, content] of SCAFFOLD_SKILLS) {
      const skillFolder = `${SCAFFOLD_SKILLS_FOLDER}/${folderName}`;
      if (!this.app.vault.getAbstractFileByPath(skillFolder)) {
        try { await this.app.vault.createFolder(skillFolder); } catch { /* already exists */ }
      }
      const skillPath = `${skillFolder}/SKILL.md`;
      if (!this.app.vault.getAbstractFileByPath(skillPath)) {
        try { await this.app.vault.create(skillPath, content); } catch { /* already exists */ }
      }
    }
  }

  async onload(): Promise<void> {
    // Register the System 3 pyramid icon: three dots (red top, blue bottom-left, green bottom-right).
    // Lucide-style: stroke outlines, currentColor, no fill. Three circles in pyramid.
    addIcon("augment-pyramid", `
      <circle cx="50" cy="18" r="13" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
      <circle cx="18" cy="72" r="13" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
      <circle cx="82" cy="72" r="13" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>
    `);

    console.log(`[augment] build ${this.getBuildFingerprint()}`);
    const raw = await this.loadData() as Record<string, unknown> | null;
    // Schema migration: strip keys removed in prior versions.
    // v0.0.4: useWsl, pythonPath; v0.0.7: s3Token, s3Email
    if (raw && typeof raw === "object") {
      delete raw["useWsl"];
      delete raw["pythonPath"];
      delete raw["s3Token"];
      delete raw["s3Email"];
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

    // Migrate legacy sidebar location values to their top/bottom variants.
    if (this.settings.defaultTerminalLocation === "sidebar-right") {
      this.settings.defaultTerminalLocation = "sidebar-right-bottom";
    } else if (this.settings.defaultTerminalLocation === "sidebar-left") {
      this.settings.defaultTerminalLocation = "sidebar-left-bottom";
    }

    // Migrate invalid ribbonIcon values. Any unrecognised value resets to the default pyramid.
    const VALID_RIBBON_ICONS = new Set([
      "radio-tower", "augment-pyramid", "wand-2", "sparkles", "brain", "zap", "bot",
      "pencil", "type", "message-square", "cpu", "code-2", "terminal",
    ]);
    if (!VALID_RIBBON_ICONS.has(this.settings.ribbonIcon)) {
      this.settings.ribbonIcon = "augment-pyramid";
    }
    // systemPrompt default is in DEFAULT_SETTINGS. Users may intentionally blank it.

    void this.maybeDefaultWindowsShellToWsl();

    // Clear Obsidian's conflicting Cmd/Ctrl+Enter defaults.
    // Two mechanisms: (1) removeDefaultHotkeys on the runtime hotkey manager (immediate),
    // (2) write [] to hotkeys.json (persists across reloads for non-plugin built-ins).
    {
      const hm = (this.app as any).hotkeyManager;
      const RUNTIME_CONFLICTS = [
        "editor:open-link-in-new-leaf",
        "editor:cycle-list-checklist",
      ];
      for (const id of RUNTIME_CONFLICTS) {
        hm?.removeDefaultHotkeys?.(id);
      }
      const isFirst = !this.settings.clearedLinkHotkey;
      void this.clearObsidianLinkHotkey().then(() => {
        if (isFirst) this.showHotkeyClaimedNotice();
      });
    }

    // Fetch available models in the background — populates the model dropdown
    // and resolves "auto" to the best available model name in the status bar.
    void this.loadAvailableModels();
    this.busPollerManager = new BusPollerManager();

    this.calloutStyleEl = document.head.createEl("style");
    this.calloutStyleEl.id = "augment-callout-styles";
    this.calloutStyleEl.textContent = [
      `.callout[data-callout="ai"] { --callout-icon: bot; --callout-color: 139, 92, 246; }`,
      `.callout[data-callout="ai"] .callout-icon { display: flex !important; }`,
      `.callout[data-callout="ai"] .callout-title::before { content: "" !important; display: none !important; }`,
    ].join("\n");

    // Register views
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => {
      const view = new TerminalView(
        leaf,
        this.getPluginDir(),
        () => this.settings.shellPath,
        () => this.settings.defaultWorkingDirectory
      );
      view.onSessionExit = (name, status, startedAt, skillName) => {
        this.appendSessionRecord(name, status, startedAt, skillName);
      };
      view.onAutoRenameRequest = (excerpt: string) => {
        return Promise.resolve(this.deriveTerminalNameFromExcerpt(excerpt));
      };
      return view;
    });
    this.registerView(VIEW_TYPE_TERMINAL_MANAGER, (leaf) => {
      return new TerminalManagerView(leaf);
    });
    this.registerView(VIEW_TYPE_PART_INBOX, (leaf) => {
      return new PartInboxView(leaf);
    });
    this.registerView(VIEW_TYPE_CONTEXT_INSPECTOR, (leaf) => {
      return new ContextInspectorView(leaf, this);
    });
    // Escape key cancels in-progress generation.
    const escapeKeymap = keymap.of([{
      key: "Escape",
      run: () => {
        if (this.activeGenerations.size > 0) {
          this.cancelGeneration();
          return true;
        }
        return false;
      },
    }]);

    this.registerEditorExtension([spinnerField, agentWidgetField, escapeKeymap]);

    // Global cancel callback for the spinnerField's backspace detection.
    (globalThis as any).__augmentCancelGeneration = () => this.cancelGeneration();

    const agentSuggest = new AgentSuggest(this.app);
    this.registerEditorSuggest(agentSuggest);
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => agentSuggest.reload())
    );

    this.registerEditorSuggest(new InboxSuggest(this.app));

    // AI generation commands
    this.addCommand({
      id: "augment-btw-side-question",
      name: "btw: Ask side question…",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for side question");
          new Notice("Open a note to ask a side question");
          return;
        }
        this.openSideQuestion(view.editor);
      },
    });

    this.addCommand({
      id: "augment-transform-selection",
      name: "Transform selection…",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for selection transform");
          new Notice("Open a note to transform selected text");
          return;
        }
        this.openSelectionTransform(view.editor);
      },
    });

    this.addCommand({
      id: "augment-generate",
      name: "Generate",
      hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for generate");
          new Notice("Open a note to generate");
          return;
        }
        if (!this.settings.apiKey) {
          console.log("[Augment] API key required");
          const notice = new Notice("Augment: API key required \u2014 click to open settings", 0);
          notice.noticeEl.style.cursor = "pointer";
          notice.noticeEl.addEventListener("click", () => {
            notice.hide();
            (this.app as any).setting.open();
            (this.app as any).setting.openTabById("augment-terminal");
          });
          return;
        }
        this.triggerGenerate(view.editor);
      },
    });

    this.addCommand({
      id: "augment-generate-from-template",
      name: "Generate from template",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          console.log("[Augment] no active note for generate-from-template");
          new Notice("Open a note to generate");
          return;
        }
        const editor = view.editor;
        if (!this.settings.apiKey) {
          console.log("[Augment] API key required");
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
          console.log("[Augment] no template folder set");
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
          console.log("[Augment] no templates found in", this.settings.templateFolder);
          new Notice(`Augment: no templates found in ${this.settings.templateFolder}`);
          return;
        }
        const cursor = editor.getCursor();
        const ctx = assembleVaultContext(this.app, editor, this.settings);
        new TemplatePicker(this.app, files, async (templateFile) => {
          const templateContent = await this.app.vault.read(templateFile);

          // Read system_prompt override and output routing from template frontmatter.
          const templateFm = this.app.metadataCache.getFileCache(templateFile)?.frontmatter;
          const systemPromptOverride = typeof templateFm?.system_prompt === "string"
            ? templateFm.system_prompt
            : undefined;
          // target: "cursor" (default) | "clipboard" | "file" | "frontmatter"
          const targetMode: string = typeof templateFm?.target === "string" ? templateFm.target : "cursor";
          const targetFilePath: string | null = typeof templateFm?.target_file === "string" ? templateFm.target_file : null;
          const targetField: string | null = typeof templateFm?.target_field === "string" ? templateFm.target_field : null;

          // Lazy full-content reads — only when the template actually uses the variables.
          if (templateContent.includes("{{note_content}}")) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) ctx.content = await this.app.vault.read(activeFile);
          }
          if (templateContent.includes("{{linked_notes_full}}") || templateContent.includes("linked_notes_array")) {
            for (const note of ctx.linkedNotes) {
              const file = this.app.vault.getFiles().find((f) => f.basename === note.title);
              if (file) {
                try { note.content = await this.app.vault.read(file); } catch { /* skip */ }
              }
            }
          }

          const rendered = await substituteVariables(templateContent, ctx);

          const runGenerate = async () => {
            this.showStatusBarGenerating();

            const isCursorMode = targetMode === "cursor";
            const isBlock = this.settings.outputFormat !== "plain";
            let insertPos = editor.posToOffset(cursor);
            const cmView = (editor as any).cm as EditorView;

            if (isCursorMode) {
              if (isBlock && cursor.ch > 0) {
                const cursorOffset = editor.posToOffset(cursor);
                insertPos = this.insertTextAndShiftGenerations(editor, cursorOffset, "\n");
              } else {
                insertPos = editor.posToOffset(cursor);
              }
            }

            const abortController = new AbortController();
            const generation = this.registerGeneration(cmView, insertPos, abortController, isCursorMode);

            try {
              const resolvedModel = this.resolveModel();
              const resolvedModelName = this.resolveModelDisplayName();
              const builtSystemPrompt = await buildSystemPrompt(ctx, systemPromptOverride, this.settings.workspaceScope, this.settings.defaultWorkingDirectory || undefined);
              if (abortController.signal.aborted) return;
              const { text: result, usage: genUsage } = await generateText(builtSystemPrompt, rendered, this.settings, resolvedModel, abortController.signal);
              if (abortController.signal.aborted) return;
              void this.accumulateSpend(resolvedModel, genUsage);

              // Route output
              if (targetMode === "clipboard") {
                await navigator.clipboard.writeText(result);
                new Notice("Augment: copied to clipboard", 5000);
              } else if (targetMode === "file" && targetFilePath) {
                const destFile = this.app.vault.getAbstractFileByPath(targetFilePath);
                if (destFile instanceof TFile) {
                  const prev = await this.app.vault.read(destFile);
                  await this.app.vault.modify(destFile, prev + "\n\n" + result);
                } else {
                  const parentFolder = targetFilePath.includes("/")
                    ? targetFilePath.slice(0, targetFilePath.lastIndexOf("/"))
                    : null;
                  if (parentFolder && !this.app.vault.getAbstractFileByPath(parentFolder)) {
                    try { await this.app.vault.createFolder(parentFolder); } catch { /* ignore */ }
                  }
                  await this.app.vault.create(targetFilePath, result);
                }
                const shortName = targetFilePath.split("/").pop() ?? targetFilePath;
                new Notice(`Augment: appended to ${shortName}`, 5000);
              } else if (targetMode === "frontmatter" && targetField) {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile) {
                  await this.app.fileManager.processFrontMatter(activeFile, (fm) => {
                    fm[targetField!] = result;
                  });
                }
                new Notice(`Augment: wrote to frontmatter.${targetField}`, 5000);
              } else {
                // cursor (default)
                const formatted = applyOutputFormat(result, this.settings, resolvedModelName);
                if (isBlock) {
                  const withTrail = formatted + "\n\n";
                  const nextInsertPos = this.insertTextAndShiftGenerations(editor, generation.insertPos, withTrail, generation.id);
                  editor.setCursor(editor.offsetToPos(nextInsertPos));
                } else {
                  this.insertTextAndShiftGenerations(editor, generation.insertPos, formatted, generation.id);
                }
                console.log("[Augment] template generation done");
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
                  this.openContextInspector();
                });
              }

              // Common post-generation tracking (all targets)
              const entry: ContextEntry = {
                timestamp: Date.now(),
                noteName: ctx.title,
                model: resolvedModelName,
                systemPrompt: builtSystemPrompt,
                userMessage: rendered,
              };
              this.pushContextHistory(entry);
              if (!this.settings.hasGenerated) {
                this.settings.hasGenerated = true;
                await this.saveData(this.settings);
                this.registerTieredCommands();
              }
              if (!this.settings.hasUsedTemplate) {
                this.settings.hasUsedTemplate = true;
                await this.saveData(this.settings);
              }
            } catch (err) {
              if (abortController.signal.aborted) return;
              console.error("[Augment] template generation failed", err);
              logApiDiagnostics(err, this.settings.apiKey, this.resolveModel());
              const errMsg = friendlyApiError(err) ?? (err instanceof Error ? err.message : String(err));
              new Notice(`Augment: ${errMsg}`);
            } finally {
              this.unregisterGeneration(generation.id);
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
      id: "generate-templates-from-folder",
      name: "Generate templates from folder\u2026",
      callback: () => {
        if (!this.settings.apiKey) {
          new Notice("Augment: add an API key in Settings \u2192 Augment first");
          return;
        }
        runGenerateTemplatesFlow(this.app, this.settings, this.resolveModel());
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
      id: "open-welcome",
      name: "Open welcome",
      callback: () => {
        void this.createAndOpenWelcomeNote();
      },
    });

    this.addSettingTab(new AugmentSettingTab(this.app, this));

    // Status bar — active-session bridge
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.tabIndex = 0;
    this.statusBarEl.addEventListener("click", (event) => {
      event.preventDefault();
      this.toggleStatusBridgePopover();
    });
    this.statusBarEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleStatusBridgePopover();
    });
    this.refreshStatusBar();

    // First-load welcome note — shown once, only when not yet configured
    if (!this.settings.apiKey && !this.settings.hasSeenWelcome) {
      this.settings.hasSeenWelcome = true;
      void this.saveData(this.settings);
      this.app.workspace.onLayoutReady(() => {
        void this.createAndOpenWelcomeNote();
      });
    }

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const menuIcon = this.settings.ribbonIcon || "augment-pyramid";
        if (!this.settings.apiKey) {
          menu.addItem((item) => {
            item
              .setTitle("Augment: add API key to get started \u2192")
              .setIcon(menuIcon)
              .onClick(() => {
                (this.app as any).setting.open();
                (this.app as any).setting.openTabById("augment-terminal");
              });
          });
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("Augment: Transform selection…")
            .setIcon(menuIcon)
            .onClick(() => {
              this.openSelectionTransform(editor);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate")
            .setIcon(menuIcon)
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate");
            });
        });
        menu.addItem((item) => {
          item
            .setTitle("Augment: Generate from template\u2026")
            .setIcon(menuIcon)
            .onClick(() => {
              (this.app as any).commands.executeCommandById("augment-terminal:augment-generate-from-template");
            });
        });
      })
    );

    // Ribbon: configurable icon → generate AI text (always first)
    this.ribbonGenerateEl = this.addRibbonIcon(this.settings.ribbonIcon || "augment-pyramid", "Generate", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice("Open a note to generate");
        return;
      }
      this.triggerGenerate(view.editor);
    });
    this.ribbonGenerateEl.addClass("augment-ribbon-generate");
    this.applyRibbonColoredClass();

    // Ribbon: sensor tower (Augment logo) → opens settings (always second)
    this.addRibbonIcon("radio-tower", "Augment settings", () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("augment-terminal");
    });

    // Ribbon: terminal — added only after terminal setup completes (tier 3, always third)
    this.addTerminalRibbonIfNeeded();

    // Default open command — uses defaultTerminalLocation setting.
    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      hotkeys: [{ modifiers: ["Ctrl"], key: "t" }],
      callback: () => {
        this.openTerminalAt(this.settings.defaultTerminalLocation);
      },
    });

    // Tier 3 commands (location variants, manager, switcher) register lazily
    // via registerTieredCommands() when terminalSetupDone becomes true.

    // Team scaffolding
    this.addCommand({
      id: "init-team",
      name: "Init team \u2014 scaffold .parts/ in a project",
      callback: () => {
        new InitTeamModal(this.app, false).open();
      },
    });

    this.addCommand({
      id: "refresh-team-skills",
      name: "Refresh team skills \u2014 update .parts/skills/ with latest defaults",
      callback: () => {
        new InitTeamModal(this.app, true).open();
      },
    });

    this.registerEvent(
      (this.app.workspace as any).on("augment-terminal:teamcreate", (event: TeamCreateSpawnEvent) => {
        void this.handleTeamCreateSpawn(event);
      })
    );

    // Attention queue — badge (always visible), command registered lazily at tier 3.
    this.waitingBadgeEl = this.addStatusBarItem();
    this.waitingBadgeEl.style.cursor = "pointer";
    this.waitingBadgeEl.style.display = "none";
    this.waitingBadgeEl.addEventListener("click", () => this.jumpToNextAttention());

    this.registerEvent(
      this.app.workspace.on("augment-terminal:changed", () => {
        this.refreshStatusBar();
        this.refreshAttentionBadge();
        this.syncAddressedTerminalBusPollers();
      })
    );

    this.registerEvent(
      this.app.workspace.on("augment-bus:changed", () => {
        this.refreshAttentionBadge();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshStatusBar();
      })
    );

    this.register(
      setBusNotifier(this.app, () => (this.app.workspace as any).trigger("augment-bus:changed"))
    );

    this.app.workspace.onLayoutReady(() => {
      this.syncAddressedTerminalBusPollers();
      void this.loadSpendData().then(() => {
        // Migration: infer tier flags from existing data for users who installed before
        // progressive disclosure was implemented.
        let migrated = false;
        if (!this.settings.terminalSetupDone && (this.settings.sessionHistory?.length ?? 0) > 0) {
          this.settings.terminalSetupDone = true;
          migrated = true;
        }
        if (!this.settings.hasGenerated && this.spendData && Object.keys(this.spendData.byModel).length > 0) {
          this.settings.hasGenerated = true;
          migrated = true;
        }
        if (migrated) {
          void this.saveData(this.settings);
        }
        this.registerTieredCommands();
        this.addTerminalRibbonIfNeeded();
      });
      // Scaffold defaults on first install — deferred so vault I/O doesn't
      // compete with Obsidian's core startup sequence.
      void this.scaffoldDefaultTemplates();
      void this.scaffoldDefaultSkills();
      this.refreshStatusBar();
      this.refreshAttentionBadge();
      // Keep legacy views restorable, but do not auto-create redirect shells on fresh load.
      // Auto-open Context Inspector in right sidebar on first install.
      // Also clean up duplicate leaves that may have been saved from prior sessions.
      const inspectorLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONTEXT_INSPECTOR);
      if (inspectorLeaves.length === 0) {
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
          leaf.setViewState({ type: VIEW_TYPE_CONTEXT_INSPECTOR, active: false });
        }
      } else if (inspectorLeaves.length > 1) {
        for (let i = 1; i < inspectorLeaves.length; i++) {
          inspectorLeaves[i].detach();
        }
      }
    });

  }

  // Lazily register commands that should only appear after the user reaches a tier.
  // Safe to call multiple times — flags prevent double-registration.
  public registerTieredCommands(): void {
    if (this.settings.hasGenerated && !this._tier1Registered) {
      this._tier1Registered = true;
      // Tier 1: generate-from-template is already registered eagerly (complex callback).
      // view-context registered at tier 1 only:
      this.addCommand({
        id: "augment-view-context",
        name: "Open context inspector",
        callback: () => { this.openContextInspector(); },
      });
    }

    if (this.settings.terminalSetupDone && !this._tier3Registered) {
      this._tier3Registered = true;

      // 7 explicit location variants
      this.addCommand({
        id: "open-terminal-tab",
        name: "Open terminal in new tab",
        callback: () => { this.openTerminalAt("tab"); },
      });
      this.addCommand({
        id: "open-terminal-right",
        name: "Open terminal to the right",
        callback: () => { this.openTerminalAt("split-right"); },
      });
      this.addCommand({
        id: "open-terminal-down",
        name: "Open terminal below",
        callback: () => { this.openTerminalAt("split-down"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-right-top",
        name: "Open terminal in right sidebar (top)",
        callback: () => { this.openTerminalAt("sidebar-right-top"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-right-bottom",
        name: "Open terminal in right sidebar (bottom)",
        callback: () => { this.openTerminalAt("sidebar-right-bottom"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-left-top",
        name: "Open terminal in left sidebar (top)",
        callback: () => { this.openTerminalAt("sidebar-left-top"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-left-bottom",
        name: "Open terminal in left sidebar (bottom)",
        callback: () => { this.openTerminalAt("sidebar-left-bottom"); },
      });

      // Legacy compat aliases (preserve saved hotkeys)
      this.addCommand({
        id: "open-terminal-sidebar-right",
        name: "Open terminal in right sidebar (bottom, legacy)",
        callback: () => { this.openTerminalAt("sidebar-right-bottom"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar-left",
        name: "Open terminal in left sidebar (bottom, legacy)",
        callback: () => { this.openTerminalAt("sidebar-left-bottom"); },
      });
      this.addCommand({
        id: "open-terminal-sidebar",
        name: "Open terminal in sidebar (right)",
        callback: () => { this.openTerminalAt("sidebar-right"); },
      });
      this.addCommand({
        id: "open-terminal-grid",
        name: "Open terminal grid (2x2)",
        callback: () => { this.openTerminalGrid(); },
      });
      this.addCommand({
        id: "launch-team",
        name: "Launch project team",
        callback: () => { void this.openTeamLaunchPicker(); },
      });
      this.addCommand({
        id: "launch-cc-team",
        name: "Launch CC project team",
        callback: () => { void this.openCCTeamLaunchPicker(); },
      });

      // Terminal manager
      this.addCommand({
        id: "open-terminal-manager",
        name: "Show terminal manager",
        hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "t" }],
        callback: () => { this.openTerminalManager(); },
      });

      // Terminal switcher
      this.addCommand({
        id: "switch-terminal",
        name: "Switch terminal",
        callback: () => { new TerminalSwitcherModal(this.app).open(); },
      });

      // Rename terminal
      this.addCommand({
        id: "rename-terminal",
        name: "Rename terminal",
        callback: () => {
          const view = this.app.workspace.getActiveViewOfType(TerminalView);
          if (view) { new RenameModal(this.app, view).open(); }
        },
      });

      // Attention queue command
      this.addCommand({
        id: "jump-to-next-waiting-session",
        name: "Jump to next session needing attention",
        callback: () => this.jumpToNextAttention(),
      });
    }
  }

  // Add the terminal ribbon icon if terminalSetupDone and not already added.
  public addTerminalRibbonIfNeeded(): void {
    if (this.settings.terminalSetupDone && !this.ribbonTerminalEl) {
      this.ribbonTerminalEl = this.addRibbonIcon("terminal", "Open terminal", () => {
        this.openTerminalAt(this.settings.defaultTerminalLocation);
      });
    }
  }

  async onunload(): Promise<void> {
    delete (globalThis as any).__augmentCancelGeneration;
    this.busPollerManager?.stopAll();
    this.busPollerManager = null;
    this.addressedTerminalPollers.clear();
    this.managedDeliveryByRole.clear();
    this.closeStatusBridgePopover();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
    // Do not detach VIEW_TYPE_TERMINAL_MANAGER or VIEW_TYPE_CONTEXT_INSPECTOR on unload.
    // Obsidian persists their sidebar placement across reloads. Detaching here would
    // remove the saved position and force a re-place to the default location every time.
    cleanupXtermStyle();
    this.calloutStyleEl?.remove();
    this.calloutStyleEl = null;
  }

  private getAttentionSnapshot() {
    const sessions: Array<{
      id: WorkspaceLeaf;
      status: string;
      unreadActivity: number;
      lastActivityMs: number;
    }> = [];

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType?.() === VIEW_TYPE_TERMINAL) {
        const view = leaf.view as any;
        sessions.push({
          id: leaf,
          status: typeof view.getStatus === "function" ? view.getStatus() : "shell",
          unreadActivity:
            typeof view.getUnreadActivity === "function" ? view.getUnreadActivity() : 0,
          lastActivityMs:
            typeof view.getLastActivityMs === "function" ? view.getLastActivityMs() : 0,
        });
      }
    });

    return summarizeAttentionSessions(sessions);
  }

  private getAttentionLeaves(): WorkspaceLeaf[] {
    return this.getAttentionSnapshot().ordered.map((session) => session.id);
  }

  private getWatchedInboxUnreadAttention(): number {
    return unreadCountForAddresses(this.app, [...DEFAULT_WATCHED_INBOX_ADDRESSES]);
  }

  private refreshAttentionBadge(): void {
    if (!this.waitingBadgeEl) return;
    const attention = this.getAttentionSnapshot();
    const watchedInboxUnread = this.getWatchedInboxUnreadAttention();

    if (attention.attentionCount === 0 && watchedInboxUnread === 0) {
      this.waitingBadgeEl.style.display = "none";
      this.waitingCursor = 0;
      this.waitingBadgeEl.removeAttribute("title");
      this.waitingBadgeEl.setAttribute("aria-label", "No sessions need attention");
    } else {
      let badgeText = attention.badgeText;
      let ariaLabel = attention.ariaLabel;
      if (attention.attentionCount === 0) {
        badgeText = `⚡ ${watchedInboxUnread} inbox`;
        ariaLabel = `${watchedInboxUnread} watched-address unread`;
      } else if (watchedInboxUnread > 0) {
        badgeText = `${attention.badgeText} · ${watchedInboxUnread} inbox`;
        ariaLabel = `${attention.ariaLabel}; ${watchedInboxUnread} watched-address unread`;
      }
      this.waitingBadgeEl.style.display = "";
      this.waitingBadgeEl.setText(badgeText);
      this.waitingBadgeEl.setAttribute("aria-label", ariaLabel);
      this.waitingBadgeEl.setAttribute("title", ariaLabel);
    }
  }

  private jumpToNextAttention(): void {
    const attention = this.getAttentionLeaves();
    if (attention.length === 0) {
      if (this.getWatchedInboxUnreadAttention() > 0) {
        void openAllMessages(this.app);
      }
      return;
    }
    this.waitingCursor = this.waitingCursor % attention.length;
    const target = attention[this.waitingCursor];
    this.waitingCursor = (this.waitingCursor + 1) % attention.length;
    this.app.workspace.setActiveLeaf(target, { focus: true });
  }

  private getPluginDir(): string {
    return (this.app.vault.adapter as any).basePath + "/.obsidian/plugins/augment-terminal";
  }

  private async createAndOpenWelcomeNote(): Promise<void> {
    const folderPath = "Augment";
    const filePath = "Augment/Get started.md";

    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }

    if (!this.app.vault.getAbstractFileByPath(filePath)) {
      const mod = process.platform === "darwin" ? "Cmd" : "Ctrl";
      await this.app.vault.create(filePath, buildWelcomeNoteContent(mod));
    }

    const file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
  }

  // Open a terminal at the user-configured default location (or a fixed location
  // for explicit-location commands). Sidebar locations fall back to a new tab if
  // the workspace API returns null for the sidebar leaf.
  private async openTerminalAt(
    location: TerminalOpenLocation = "tab",
    options?: { name?: string; active?: boolean; reveal?: boolean }
  ): Promise<TerminalView> {
    const { workspace } = this.app;
    const desiredName = options?.name?.trim();
    const active = options?.active ?? true;
    const reveal = options?.reveal ?? true;

    let leaf: WorkspaceLeaf;
    if (location === "split-right") {
      leaf = workspace.getLeaf("split", "vertical");
    } else if (location === "split-down") {
      leaf = workspace.getLeaf("split", "horizontal");
    } else if (location === "sidebar-right" || location === "sidebar-right-bottom") {
      // getRightLeaf(true) splits the sidebar, placing the new leaf below the existing one.
      // getRightLeaf(false) reuses/returns the existing top leaf — wrong for "bottom".
      leaf = workspace.getRightLeaf(true) ?? workspace.getLeaf("tab");
    } else if (location === "sidebar-right-top") {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
    } else if (location === "sidebar-left" || location === "sidebar-left-bottom") {
      leaf = workspace.getLeftLeaf(true) ?? workspace.getLeaf("tab");
    } else if (location === "sidebar-left-top") {
      leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf("tab");
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

    return leaf.view as TerminalView;
  }


  private async openTerminalSidebar(): Promise<TerminalView | null> {
    const { workspace } = this.app;
    const leaf = workspace.getRightLeaf(false);

    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: true,
      });
      workspace.revealLeaf(leaf);
      return leaf.view as TerminalView;
    }
    return null;
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

  public async openControlCenter(): Promise<void> {
    const rootUrl = await resolveReachableControlCenterRootUrl();
    if (!rootUrl) {
      new Notice(AUGMENT_CONTROL_CENTER_UNAVAILABLE_NOTICE);
      return;
    }

    window.open(rootUrl, "_blank", "noopener");
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

  private getTeamLaunchCodeRoot(): string {
    const configuredCwd = this.settings.defaultWorkingDirectory.trim();
    if (configuredCwd) return configuredCwd;

    const activeTerminal = this.app.workspace.getActiveViewOfType(TerminalView);
    const activeTerminalCwd = activeTerminal?.getWorkingDirectory().trim() ?? "";
    if (activeTerminalCwd) return activeTerminalCwd;

    try {
      const cwd = process.cwd().trim();
      if (cwd) return cwd;
    } catch {
      // Ignore missing process cwd access and fall back to vault path.
    }

    const vaultBase = (((this.app.vault.adapter as any).basePath as string | undefined) ?? "").trim();
    return vaultBase || ".";
  }

  public async openTeamLaunchPicker(): Promise<void> {
    const vaultBase = (((this.app.vault.adapter as any).basePath as string | undefined) ?? "").trim();
    if (!vaultBase) {
      new Notice("Augment: vault path unavailable");
      return;
    }

    const projects = await discoverTeamProjects(vaultBase);
    if (projects.length === 0) {
      new Notice("Augment: no team projects found in agents/parts/");
      return;
    }

    if (projects.length === 1) {
      await this.launchProjectTeam(projects[0].projectId);
      return;
    }

    new TeamProjectPickerModal(this.app, projects, (project) => {
      void this.launchProjectTeam(project.projectId);
    }).open();
  }

  public async openCCTeamLaunchPicker(): Promise<void> {
    const vaultBase = (((this.app.vault.adapter as any).basePath as string | undefined) ?? "").trim();
    if (!vaultBase) {
      new Notice("Augment: vault path unavailable");
      return;
    }

    const projects = await discoverTeamProjects(vaultBase);
    if (projects.length === 0) {
      new Notice("Augment: no team projects found in agents/parts/");
      return;
    }

    if (projects.length === 1) {
      await this.launchCCProjectTeam(projects[0].projectId);
      return;
    }

    new TeamProjectPickerModal(this.app, projects, (project) => {
      void this.launchCCProjectTeam(project.projectId);
    }).open();
  }

  public async launchProjectTeam(projectId: string, userBrief?: string): Promise<void> {
    const targetProjectId = projectId.trim();
    if (!targetProjectId) return;

    const vaultBase = (((this.app.vault.adapter as any).basePath as string | undefined) ?? "").trim();
    if (!vaultBase) {
      new Notice("Augment: vault path unavailable");
      return;
    }

    const projects = await discoverTeamProjects(vaultBase);
    const project = projects.find((candidate) => candidate.projectId === targetProjectId);
    if (!project) {
      new Notice(`Augment: team project not found: ${targetProjectId}`);
      return;
    }

    const codeRoot = project.codeRoot ?? this.getTeamLaunchCodeRoot();
    const launchSpec = buildTeamLaunchSpec(
      project,
      codeRoot,
      vaultBase,
      userBrief
    );
    const layoutSlots = computeTeamLayout(launchSpec.specs.map((spec) => spec.member));
    if (layoutSlots.length === 0) {
      new Notice(`Augment: no team members found for ${project.projectDisplayName}`);
      return;
    }

    const orderedSlots = layoutSlots
      .slice()
      .sort((a, b) => a.column - b.column || a.row - b.row);
    const specByRoleId = new Map(launchSpec.specs.map((spec) => [spec.member.roleId, spec]));
    const pollerAddressByRoleId = new Map(
      buildPostLaunchWatcherSetup(project, vaultBase).map((entry) => [entry.roleId, entry.address])
    );
    const workspace = this.app.workspace;
    const workspaceAny = workspace as any;
    let ceoLeaf: WorkspaceLeaf | null = null;
    let middleColumnLeaf: WorkspaceLeaf | null = null;
    let rightColumnLeaf: WorkspaceLeaf | null = null;
    const createdTerminals: Array<{
      bootPrompt: string;
      roleId: string;
      address: string | null;
      view: Partial<TerminalView>;
    }> = [];

    for (const slot of orderedSlots) {
      const spec = specByRoleId.get(slot.member.roleId);
      if (!spec) continue;

      let leaf: WorkspaceLeaf;
      if (slot.column === 0) {
        leaf = workspace.getLeaf("tab");
        ceoLeaf = leaf;
      } else if (slot.column === 1) {
        if (middleColumnLeaf === null) {
          const anchorLeaf = ceoLeaf ?? workspace.getLeaf("tab");
          ceoLeaf = ceoLeaf ?? anchorLeaf;
          leaf = workspaceAny.createLeafBySplit(anchorLeaf, "vertical");
          middleColumnLeaf = leaf;
        } else if (slot.row === 0) {
          leaf = middleColumnLeaf;
        } else {
          leaf = workspaceAny.createLeafBySplit(middleColumnLeaf, "horizontal");
        }
      } else {
        const anchorLeaf = middleColumnLeaf ?? ceoLeaf ?? workspace.getLeaf("tab");
        ceoLeaf = ceoLeaf ?? anchorLeaf;
        if (rightColumnLeaf === null) {
          leaf = workspaceAny.createLeafBySplit(anchorLeaf, "vertical");
          rightColumnLeaf = leaf;
        } else if (slot.row === 0) {
          leaf = rightColumnLeaf;
        } else {
          leaf = workspaceAny.createLeafBySplit(rightColumnLeaf, "horizontal");
        }
      }

      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: slot.column === 0 && slot.row === 0,
        state: {
          name: spec.member.address,
          launchCwd: spec.cwd,
          managedTeamId: launchSpec.teamId,
          managedRoleId: spec.member.roleId,
        } as any,
      });

      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(spec.member.address);
      }
      createdTerminals.push({
        bootPrompt: spec.bootPrompt,
        roleId: spec.member.roleId,
        address: pollerAddressByRoleId.get(spec.member.roleId) ?? null,
        view,
      });
    }

    for (const { bootPrompt, roleId, address, view } of createdTerminals) {
      this.managedDeliveryByRole.set(
        this.buildManagedRoleKey(launchSpec.teamId, roleId),
        createDeliveryObservation(address)
      );

      if (typeof view.enqueueInitialInput !== "function") continue;

      view.enqueueInitialInput(bootPrompt);

      if (!address) continue;
    }

    if (ceoLeaf) {
      workspace.revealLeaf(ceoLeaf);
    }
    workspace.trigger("augment-terminal:changed");
  }

  public async launchCCProjectTeam(projectId: string, userBrief?: string): Promise<void> {
    const targetProjectId = projectId.trim();
    if (!targetProjectId) return;

    const vaultBase = (((this.app.vault.adapter as any).basePath as string | undefined) ?? "").trim();
    if (!vaultBase) {
      new Notice("Augment: vault path unavailable");
      return;
    }

    const projects = await discoverTeamProjects(vaultBase);
    const project = projects.find((candidate) => candidate.projectId === targetProjectId);
    if (!project) {
      new Notice(`Augment: team project not found: ${targetProjectId}`);
      return;
    }

    const codeRoot = (project.codeRoot ?? this.getTeamLaunchCodeRoot()).trim();
    const ccNativeHelpers = teamLaunchModule as typeof teamLaunchModule & {
      buildCCNativeTeamLaunchSpec?: (
        project: TeamRosterProject,
        codeRoot: string,
        vaultRoot: string,
        userBrief?: string
      ) => {
        teamName: string;
        leaderSessionId: string;
        config: unknown;
        memberCommands: Array<{
          bootPromptText: string;
          command: string;
          cwd?: string;
          member: TeamRosterProject["members"][number];
        }>;
      };
      writeCCTeamScaffolding?: (teamName: string, config: unknown) => void | Promise<void>;
      seedCCInboxMessage?: (
        teamName: string,
        agentName: string,
        from: string,
        text: string
      ) => void | Promise<void>;
    };

    if (
      typeof ccNativeHelpers.buildCCNativeTeamLaunchSpec !== "function" ||
      typeof ccNativeHelpers.writeCCTeamScaffolding !== "function" ||
      typeof ccNativeHelpers.seedCCInboxMessage !== "function"
    ) {
      new Notice("Augment: CC native team helpers unavailable");
      return;
    }

    const { teamName, leaderSessionId, config, memberCommands } =
      ccNativeHelpers.buildCCNativeTeamLaunchSpec(project, codeRoot, vaultBase, userBrief);

    if (!Array.isArray(memberCommands) || memberCommands.length === 0) {
      new Notice(`Augment: no CC native team members found for ${project.projectDisplayName}`);
      return;
    }

    const managedTeamId = `${CC_NATIVE_TEAM_ID_PREFIX}${teamName}::${leaderSessionId}`;
    const layoutSlots = computeTeamLayout(memberCommands.map((entry) => entry.member));
    if (layoutSlots.length === 0) {
      new Notice(`Augment: no team members found for ${project.projectDisplayName}`);
      return;
    }

    await ccNativeHelpers.writeCCTeamScaffolding(teamName, config);

    const commandByRoleId = new Map(
      memberCommands.map((entry) => [entry.member.roleId, entry] as const)
    );

    for (const entry of memberCommands) {
      const bootPromptText = typeof entry.bootPromptText === "string" ? entry.bootPromptText.trim() : "";
      if (!bootPromptText) {
        new Notice(`Augment: missing CC native boot prompt for ${entry.member.displayName}`);
        return;
      }

      await ccNativeHelpers.seedCCInboxMessage(
        teamName,
        entry.member.roleId,
        "augment",
        bootPromptText
      );
    }

    const orderedSlots = layoutSlots
      .slice()
      .sort((a, b) => a.column - b.column || a.row - b.row);
    const workspace = this.app.workspace;
    const workspaceAny = workspace as any;
    let ceoLeaf: WorkspaceLeaf | null = null;
    let middleColumnLeaf: WorkspaceLeaf | null = null;
    let rightColumnLeaf: WorkspaceLeaf | null = null;
    const createdTerminals: Array<{
      command: string;
      view: Partial<TerminalView>;
    }> = [];

    for (const slot of orderedSlots) {
      const entry = commandByRoleId.get(slot.member.roleId);
      if (!entry) continue;

      const command = typeof entry.command === "string" ? entry.command : "";
      if (!command.trim()) {
        new Notice(`Augment: missing CC native launch command for ${entry.member.displayName}`);
        return;
      }

      let leaf: WorkspaceLeaf;
      if (slot.column === 0) {
        leaf = workspace.getLeaf("tab");
        ceoLeaf = leaf;
      } else if (slot.column === 1) {
        if (middleColumnLeaf === null) {
          const anchorLeaf = ceoLeaf ?? workspace.getLeaf("tab");
          ceoLeaf = ceoLeaf ?? anchorLeaf;
          leaf = workspaceAny.createLeafBySplit(anchorLeaf, "vertical");
          middleColumnLeaf = leaf;
        } else if (slot.row === 0) {
          leaf = middleColumnLeaf;
        } else {
          leaf = workspaceAny.createLeafBySplit(middleColumnLeaf, "horizontal");
        }
      } else {
        const anchorLeaf = middleColumnLeaf ?? ceoLeaf ?? workspace.getLeaf("tab");
        ceoLeaf = ceoLeaf ?? anchorLeaf;
        if (rightColumnLeaf === null) {
          leaf = workspaceAny.createLeafBySplit(anchorLeaf, "vertical");
          rightColumnLeaf = leaf;
        } else if (slot.row === 0) {
          leaf = rightColumnLeaf;
        } else {
          leaf = workspaceAny.createLeafBySplit(rightColumnLeaf, "horizontal");
        }
      }

      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: slot.column === 0 && slot.row === 0,
        state: {
          name: entry.member.address,
          launchCwd: entry.cwd?.trim() || codeRoot,
          managedTeamId,
          managedRoleId: entry.member.roleId,
        } as any,
      });

      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(entry.member.address);
      }
      createdTerminals.push({
        command: command.endsWith("\n") ? command : `${command}\n`,
        view,
      });
    }

    for (const { command, view } of createdTerminals) {
      if (typeof view.enqueueInitialInput !== "function") continue;
      view.enqueueInitialInput(command);
    }

    if (ceoLeaf) {
      workspace.revealLeaf(ceoLeaf);
    }
    workspace.trigger("augment-terminal:changed");
  }

  public async shutdownManagedTeam(teamId: string): Promise<void> {
    const targetTeamId = teamId.trim();
    if (!targetTeamId) return;

    const activeLeaf = this.app.workspace.activeLeaf;
    const leaves = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_TERMINAL)
      .filter((leaf) => {
        const view = leaf.view as Partial<TerminalView>;
        return typeof view.getManagedTeamId === "function" &&
          view.getManagedTeamId()?.trim() === targetTeamId;
      })
      .sort((a, b) => {
        if (a === activeLeaf) return 1;
        if (b === activeLeaf) return -1;
        return 0;
      });

    for (const leaf of leaves) {
      const view = leaf.view as Partial<TerminalView>;
      const managedRoleId =
        typeof view.getManagedRoleId === "function" ? view.getManagedRoleId()?.trim() ?? "" : "";
      if (managedRoleId) {
        const managedRoleKey = this.buildManagedRoleKey(targetTeamId, managedRoleId);
        this.busPollerManager?.stopPoller(managedRoleKey);
        this.managedDeliveryByRole.delete(managedRoleKey);
      }
      leaf.detach();
    }

    if (leaves.length > 0) {
      this.app.workspace.trigger("augment-terminal:changed");
    }
  }

  private async handleTeamCreateSpawn(event: TeamCreateSpawnEvent): Promise<void> {
    if (this.isNativeCCTeamLaunchSource(event.sourceName)) return;

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

    // Filter out members that already have a terminal.
    const toSpawn = members.filter((name) => !this.hasTerminalNamed(name));
    if (toSpawn.length === 0) return;

    // Layout: first subagent opens in a vertical split (right column),
    // subsequent subagents stack below it via createLeafBySplit.
    // This mirrors the tmux split-pane layout: leader left, subagents right.
    let columnLeaf: WorkspaceLeaf | null = null;
    for (const member of toSpawn) {
      let leaf: WorkspaceLeaf;
      if (columnLeaf === null) {
        leaf = this.app.workspace.getLeaf("split", "vertical");
        columnLeaf = leaf;
      } else {
        leaf = (this.app.workspace as any).createLeafBySplit(columnLeaf, "horizontal");
      }

      await leaf.setViewState({
        type: VIEW_TYPE_TERMINAL,
        active: false,
        state: { name: member },
      });

      const view = leaf.view as Partial<TerminalView>;
      if (typeof view.setName === "function") {
        view.setName(member);
      }
    }
  }

  public insertAgentWidget(editor: Editor, pos: { line: number; ch: number }, name: string): void {
    const cmView = (editor as any).cm as EditorView;
    const offset = editor.posToOffset(pos);
    cmView.dispatch({ effects: addAgentWidgetEffect.of({ pos: offset, name }) });
  }

  public async launchSkillSession(file: TFile, skillName: string, editor?: Editor): Promise<void> {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const absolutePath = `${vaultBase}/${file.path}`;

    // Build a claude shell command: claude "/{skillName} on {absoluteFilePath}"
    // Escape double quotes in the path to avoid shell breakage.
    const safePath = absolutePath.replace(/"/g, '\\"');
    const claudeCmd = `claude "/${skillName} on ${safePath}"\n`;

    // Open in right sidebar without stealing focus from the note.
    const terminalView = await this.openTerminalSidebar();
    if (!terminalView) return;

    // Mark as skill session immediately — green steady dot in terminal manager.
    terminalView.markSkillRunning();
    terminalView.setSkillName(skillName);

    // Shell needs ~1500ms to initialize before we can write to it.
    setTimeout(() => {
      terminalView.write(claudeCmd);
    }, 1500);

    // Remove the inline widget silently when the terminal process exits.
    if (editor) {
      const cmView = (editor as any).cm as EditorView;
      const ref = this.app.workspace.on("augment-terminal:changed", () => {
        if (terminalView.getStatus() === "exited") {
          this.app.workspace.offref(ref);
          try {
            cmView.dispatch({ effects: removeAgentWidgetEffect.of(null) });
          } catch {
            // Editor may have been closed before the process exited — ignore.
          }
        }
      });
    }
  }

  async loadSpendData(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.SPEND_PATH);
      this.spendData = JSON.parse(raw) as SpendData;
      if (!this.spendData.byModel) this.spendData.byModel = {};
    } catch {
      this.spendData = { byModel: {} };
    }
  }

  private async accumulateSpend(modelId: string, usage: { input_tokens: number; output_tokens: number }): Promise<void> {
    if (!this.spendData) this.spendData = { byModel: {} };
    if (!this.spendData.since) this.spendData.since = Date.now();
    const entry = this.spendData.byModel[modelId] ?? { inputTokens: 0, outputTokens: 0, generations: 0 };
    entry.inputTokens += usage.input_tokens;
    entry.outputTokens += usage.output_tokens;
    entry.generations += 1;
    this.spendData.byModel[modelId] = entry;
    try {
      await this.app.vault.adapter.write(this.SPEND_PATH, JSON.stringify(this.spendData, null, 2));
    } catch { /* non-fatal */ }
  }

  async resetSpendData(): Promise<void> {
    this.spendData = { byModel: {}, since: Date.now() };
    try {
      await this.app.vault.adapter.write(this.SPEND_PATH, JSON.stringify(this.spendData, null, 2));
    } catch { /* non-fatal */ }
  }

  private appendSessionRecord(name: string, status: "exited" | "crashed", startedAt: number, skillName?: string): void {
    const record: SessionRecord = {
      id: `${startedAt}-${Math.random().toString(36).slice(2)}`,
      name,
      skillName,
      status,
      startedAt,
      closedAt: Date.now(),
    };
    if (!Array.isArray(this.settings.sessionHistory)) {
      this.settings.sessionHistory = [];
    }
    this.settings.sessionHistory.push(record);
    if (this.settings.sessionHistory.length > 200) {
      this.settings.sessionHistory = this.settings.sessionHistory.slice(-200);
    }
    void this.saveData(this.settings);
  }

  public async openTerminalNamed(name: string): Promise<void> {
    await this.openTerminalAt("tab", { name });
  }

  private sanitizeTerminalName(raw: string): string | null {
    const cleaned = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return cleaned || null;
  }

  // Local fallback so auto-rename works without custom hooks or API success.
  private deriveTerminalNameFromExcerpt(excerpt: string): string | null {
    const lines = excerpt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const userTurns: string[] = [];
    for (const line of lines) {
      if (line.startsWith("❯")) {
        const text = line.replace(/^❯\s*/, "").trim();
        if (text) userTurns.push(text);
      }
    }

    const source = userTurns.slice(-3).join(" ") || lines.slice(-20).join(" ");
    if (!source) return null;

    const STOP_WORDS = new Set([
      "the", "and", "for", "with", "that", "this", "from", "what", "when", "where",
      "which", "who", "your", "have", "will", "would", "could", "should", "about",
      "into", "them", "they", "dont", "doesnt", "cant", "isnt", "lets", "discussion",
      "discuss", "thread", "session", "please", "help", "talk", "why", "how", "bad",
      "good", "like", "love", "dont", "not",
    ]);

    const words = source
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

    const unique: string[] = [];
    for (const word of words) {
      if (unique.includes(word)) continue;
      unique.push(word);
      if (unique.length >= 4) break;
    }

    if (unique.length === 0) return null;
    return this.sanitizeTerminalName(unique.join("-"));
  }

  public openContextInspector(): void {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      leaf.setViewState({ type: VIEW_TYPE_CONTEXT_INSPECTOR, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  public async openFocusedTerminal(): Promise<TerminalView> {
    return this.openTerminalAt("tab", { active: true });
  }

  public deleteSessionRecord(id: string): void {
    this.settings.sessionHistory = (this.settings.sessionHistory ?? []).filter(r => r.id !== id);
    void this.saveData(this.settings);
    this.app.workspace.trigger("augment-terminal:changed");
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

  private isNativeCCTeamLaunchSource(sourceName?: string): boolean {
    const target = sourceName?.trim().toLowerCase();
    if (!target) return false;

    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    for (const leaf of leaves) {
      const view = leaf.view as Partial<TerminalView>;
      const viewName = typeof view.getName === "function" ? view.getName().trim().toLowerCase() : "";
      const leafState = (leaf as any).getViewState?.()?.state;
      const stateName = typeof leafState?.name === "string" ? leafState.name.trim().toLowerCase() : "";
      if (viewName !== target && stateName !== target) continue;

      const managedTeamId =
        typeof view.getManagedTeamId === "function" ? view.getManagedTeamId()?.trim() ?? "" : "";
      const managedRoleId =
        typeof view.getManagedRoleId === "function" ? view.getManagedRoleId()?.trim() ?? "" : "";
      const stateManagedTeamId =
        typeof leafState?.managedTeamId === "string" ? leafState.managedTeamId.trim() : "";
      const stateManagedRoleId =
        typeof leafState?.managedRoleId === "string" ? leafState.managedRoleId.trim() : "";

      if (
        (managedRoleId === "ceo" || stateManagedRoleId === "ceo") &&
        (
          managedTeamId.startsWith(CC_NATIVE_TEAM_ID_PREFIX) ||
          stateManagedTeamId.startsWith(CC_NATIVE_TEAM_ID_PREFIX)
        )
      ) {
        return true;
      }
    }

    return false;
  }
}
