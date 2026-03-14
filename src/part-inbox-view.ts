import { App, EventRef, ItemView, WorkspaceLeaf } from "obsidian";
import { renderLegacyRedirectShell } from "./control-center-redirect";
import {
  DEFAULT_WATCHED_INBOX_ADDRESSES,
  getThread,
  HUMAN_ADDRESS,
  InboxMessage,
  InboxThreadSummary,
  listAllThreads,
  listHumanThreads,
  listPartThreads,
  markThreadRead,
  unreadCount,
  unreadCountForAddresses,
} from "./inbox-bus";
import { ComposeModal } from "./inbox-suggest";
import { discoverVaultParts, PartInfo } from "./part-registry";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";

export const VIEW_TYPE_PART_INBOX = "augment-part-inbox";
const ALL_MESSAGES_FILTER = "__all_messages__";
const WITH_MATT_FILTER = "__with_matt__";

export type PartInboxViewState =
  | { mode: "all"; selectedThreadId?: string }
  | { mode: "part"; address: string; selectedThreadId?: string }
  | { mode: "human"; selectedThreadId?: string };

type TerminalViewLike = {
  getStatus?: () => string;
  getName?: () => string;
  getAgentIdentity?: () => string | null;
  getWorkingDirectory?: () => string;
  markActivityRead?: () => void;
};

type PartTerminalTarget = Pick<PartInfo, "name" | "address" | "habitat" | "isProjectPart">;
type InboxLeafLike = WorkspaceLeaf & {
  updateHeader?: () => void;
  tabHeaderInnerTitleEl?: { setText?: (title: string) => void };
};
type InboxWorkspaceEvents = App["workspace"] & {
  on(name: "augment-bus:changed" | "augment-terminal:changed", callback: () => void): EventRef;
};

function normalizeInboxAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "human" || normalized === "user") {
    return HUMAN_ADDRESS;
  }
  if (normalized === HUMAN_ADDRESS) return HUMAN_ADDRESS;
  return normalized.includes("@") ? normalized : `${normalized}@vault`;
}

function splitAddress(address: string): { name: string; habitat: string } {
  const [name = address, habitat = "vault"] = address.split("@");
  return {
    name: name.trim() || address,
    habitat: habitat.trim() || "vault",
  };
}

function formatAddressLabel(address: string): string {
  if (address === HUMAN_ADDRESS) return "You";
  const { name, habitat } = splitAddress(address);
  return habitat === "vault" ? name : `${name}@${habitat}`;
}

function formatMailboxLabel(
  address: string,
  part?: PartTerminalTarget | null
): string {
  if (normalizeInboxAddress(address) === HUMAN_ADDRESS) return "With Matt";
  if (part) {
    return part.habitat === "vault"
      ? part.name
      : `${part.name} @ ${part.habitat}`;
  }

  const { name, habitat } = splitAddress(address);
  return habitat === "vault" ? name : `${name} @ ${habitat}`;
}

function formatPartQueueLabel(unread: number): string {
  return unread > 0 ? `Part has ${unread} unread` : "Part inbox clear";
}

function formatParticipantList(participants: string[]): string {
  return participants.map((address) => formatAddressLabel(address)).join(", ");
}

function renderLabeledField(
  container: HTMLElement,
  classPrefix: string,
  label: string,
  value: string
): void {
  const field = container.createDiv({ cls: `${classPrefix}-field` });
  field.createSpan({ cls: `${classPrefix}-field-label`, text: label });
  field.createSpan({ cls: `${classPrefix}-field-value`, text: value });
}

function formatThreadSubject(
  thread: Pick<InboxThreadSummary, "subject" | "participants" | "lastSender" | "lastTo">
): string {
  const subject = thread.subject.trim();
  if (subject && subject.toLowerCase() !== "message") {
    return subject;
  }

  const [firstParticipant, secondParticipant] = thread.participants;
  const fromLabel = formatAddressLabel(firstParticipant || thread.lastSender);
  const toLabel = formatAddressLabel(secondParticipant || thread.lastTo || thread.lastSender);
  return `Conversation: ${fromLabel} to ${toLabel}`;
}

function formatThreadParticipants(
  thread: Pick<InboxThreadSummary, "participants" | "messageCount">
): string {
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
  if (thread.participants.length <= 2) {
    return count;
  }
  return `${thread.participants.length} participants · ${count}`;
}

function formatTerminalStatus(status: string | null | undefined): string {
  switch (status) {
    case "active":
      return "Live terminal · active";
    case "tool":
      return "Live terminal · tool";
    case "waiting":
      return "Live terminal · waiting";
    case "idle":
    case "shell":
    case "running":
      return "Live terminal";
    case "crashed":
      return "Terminal crashed";
    case "exited":
      return "Terminal exited";
    default:
      return "No live terminal";
  }
}

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(timestampMs: number): string {
  if (!timestampMs) return "";
  const diff = Date.now() - timestampMs;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function absoluteTime(iso: string): string {
  const ms = parseTimestampMs(iso);
  if (!ms) return iso;
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getTerminalLeaves(app: App): WorkspaceLeaf[] {
  const byType = app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
  if (byType.length > 0) {
    return byType;
  }

  const found: WorkspaceLeaf[] = [];
  const workspaceAny = app.workspace as any;
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

function scorePartMatch(leaf: WorkspaceLeaf, part: PartTerminalTarget): number {
  const view = leaf.view as TerminalViewLike;
  const identity = view.getAgentIdentity?.()?.trim().toLowerCase() ?? "";
  const name = view.getName?.()?.trim().toLowerCase() ?? "";
  const cwd = (view.getWorkingDirectory?.() ?? "").toLowerCase().replace(/\\/g, "/");
  const partName = part.name.toLowerCase();
  const partAddress = part.address.toLowerCase();
  const habitat = part.habitat.toLowerCase();

  // Full address match (e.g., "eng@augment-plugin") is unambiguous — best score
  if (identity === partAddress || name === partAddress) {
    return 3;
  }

  // Bare name match — need to check habitat for project parts
  const nameMatch = identity === partName || name === partName;
  if (!nameMatch) return 0;

  // Vault parts: bare name match is sufficient
  if (habitat === "vault") return 2;

  // Project parts: bare name + cwd contains habitat — strong match
  if (cwd.endsWith(`/${habitat}`) || cwd.includes(`/${habitat}/`)) {
    return 2;
  }

  // Project parts: bare name match but cwd doesn't confirm habitat — weak match
  // Still return it as a fallback rather than missing the terminal entirely
  return 1;
}

export function findTerminalLeafForPart(app: App, part: PartTerminalTarget): WorkspaceLeaf | null {
  let bestLeaf: WorkspaceLeaf | null = null;
  let bestScore = 0;
  for (const leaf of getTerminalLeaves(app)) {
    const score = scorePartMatch(leaf, part);
    if (score > bestScore) {
      bestScore = score;
      bestLeaf = leaf;
    }
  }
  return bestLeaf;
}

function focusLeaf(app: App, leaf: WorkspaceLeaf): void {
  app.workspace.revealLeaf(leaf);
  const view = leaf.view as TerminalViewLike;
  view.markActivityRead?.();
}

async function openPartInboxLeaf(
  app: App,
  state: PartInboxViewState
): Promise<PartInboxView> {
  const workspace = app.workspace;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_PART_INBOX);
  let leaf = existing[0];

  if (!leaf) {
    const baseLeaf = workspace.getMostRecentLeaf() ?? workspace.getLeaf("tab");
    leaf =
      (workspace as any).createLeafBySplit?.(baseLeaf, "vertical") ??
      workspace.getLeaf("split", "vertical");
  }

  await leaf.setViewState({
    type: VIEW_TYPE_PART_INBOX,
    active: true,
    state,
  });
  workspace.revealLeaf(leaf);
  return leaf.view as PartInboxView;
}

export async function openPartInboxForPart(app: App, address: string): Promise<PartInboxView> {
  return openPartInboxLeaf(app, {
    mode: "part",
    address: normalizeInboxAddress(address),
  });
}

export async function openAllMessages(app: App): Promise<PartInboxView> {
  return openPartInboxLeaf(app, { mode: "all" });
}

export async function openHumanInbox(app: App): Promise<PartInboxView> {
  return openPartInboxLeaf(app, { mode: "human" });
}

export class PartInboxView extends ItemView {
  private viewState: PartInboxViewState = { mode: "all" };
  private refreshToken = 0;
  private discoveredParts: PartTerminalTarget[] = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PART_INBOX;
  }

  getDisplayText(): string {
    return `Messages — ${this.getSelectedMailboxLabel()}`;
  }

  getIcon(): string {
    return "inbox";
  }

  getState(): PartInboxViewState {
    return { ...this.viewState };
  }

  async setState(state: PartInboxViewState): Promise<void> {
    if (state.mode === "all") {
      await this.setMode("all", { selectedThreadId: state.selectedThreadId });
      return;
    }

    await this.setMode(state.mode === "human" ? "human" : state.address, {
      selectedThreadId: state.selectedThreadId,
    });
  }

  async setMode(
    modeOrAddress: "all" | "human" | string,
    options: { selectedThreadId?: string } = {}
  ): Promise<void> {
    const nextState: PartInboxViewState =
      modeOrAddress === "all"
        ? { mode: "all", selectedThreadId: options.selectedThreadId }
        : (() => {
            const address =
              modeOrAddress === "human"
                ? HUMAN_ADDRESS
                : normalizeInboxAddress(modeOrAddress);
            return address === HUMAN_ADDRESS
              ? { mode: "human", selectedThreadId: options.selectedThreadId }
              : {
                  mode: "part",
                  address,
                  selectedThreadId: options.selectedThreadId,
                };
          })();

    const currentMode = this.viewState.mode;
    const currentAddress = this.selectedAddress();
    const currentThreadId = this.viewState.selectedThreadId;
    const nextAddress =
      nextState.mode === "part"
        ? nextState.address
        : nextState.mode === "human"
          ? HUMAN_ADDRESS
          : null;

    this.viewState = nextState;
    this.syncLeafTitle();

    if (
      currentMode !== nextState.mode ||
      currentAddress !== nextAddress ||
      currentThreadId !== nextState.selectedThreadId
    ) {
      await this.refresh();
    }
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("augment-part-inbox-view");
    this.syncLeafTitle();
    const workspaceEvents = this.app.workspace as InboxWorkspaceEvents;

    this.registerEvent(
      workspaceEvents.on("augment-bus:changed", () => void this.refresh())
    );

    await this.refresh();
  }

  private selectedAddress(): string | null {
    return this.viewState.mode === "part"
      ? this.viewState.address
      : this.viewState.mode === "human"
        ? HUMAN_ADDRESS
        : null;
  }

  private selectedFilterValue(): string {
    if (this.viewState.mode === "all") return ALL_MESSAGES_FILTER;
    if (this.viewState.mode === "human") return WITH_MATT_FILTER;
    return this.viewState.address;
  }

  private visibleAddresses(): string[] {
    return Array.from(new Set([HUMAN_ADDRESS, ...this.discoveredParts.map((part) => part.address)]));
  }

  private fallbackPart(address: string): PartTerminalTarget {
    const normalized = normalizeInboxAddress(address);
    const { name, habitat } = splitAddress(normalized);
    return {
      name,
      address: normalized,
      habitat,
      isProjectPart: habitat !== "vault",
    };
  }

  private refreshDiscoveredParts(): void {
    const discovered = discoverVaultParts(this.app).map((part) => ({
      name: part.name,
      address: part.address,
      habitat: part.habitat,
      isProjectPart: part.isProjectPart,
    }));

    const currentAddress = this.selectedAddress();
    if (
      currentAddress &&
      currentAddress !== HUMAN_ADDRESS &&
      !discovered.some((part) => part.address === currentAddress)
    ) {
      discovered.push(this.fallbackPart(currentAddress));
    }

    this.discoveredParts = discovered;
  }

  private resolvePart(address = this.selectedAddress()): PartTerminalTarget | null {
    if (!address) return null;

    const normalized = normalizeInboxAddress(address);
    if (normalized === HUMAN_ADDRESS) return null;

    const discovered =
      this.discoveredParts.find((part) => part.address === normalized) ??
      discoverVaultParts(this.app).find((part) => part.address === normalized);
    if (discovered) {
      return {
        name: discovered.name,
        address: discovered.address,
        habitat: discovered.habitat,
        isProjectPart: discovered.isProjectPart,
      };
    }

    return this.fallbackPart(normalized);
  }

  private getSelectedMailboxLabel(): string {
    if (this.viewState.mode === "all") return "All messages";
    if (this.viewState.mode === "human") return "With Matt";
    return formatMailboxLabel(this.viewState.address, this.resolvePart());
  }

  private syncLeafTitle(): void {
    const title = this.getDisplayText();
    const leafLike = this.leaf as InboxLeafLike;

    leafLike.updateHeader?.();

    const headerTitleEl = this.contentEl
      .closest(".workspace-leaf")
      ?.querySelector(".view-header-title");
    if (headerTitleEl instanceof HTMLElement) {
      headerTitleEl.textContent = title;
    }

    leafLike.tabHeaderInnerTitleEl?.setText?.(title);
  }

  private currentThreads(): InboxThreadSummary[] {
    if (this.viewState.mode === "all") {
      return listAllThreads(this.app, this.visibleAddresses());
    }
    if (this.viewState.mode === "human") {
      return listHumanThreads(this.app);
    }
    return listPartThreads(this.app, this.viewState.address);
  }

  private async refresh(): Promise<void> {
    this.syncLeafTitle();
    this.contentEl.addClass("augment-part-inbox-view");
    const unread = unreadCountForAddresses(this.app, DEFAULT_WATCHED_INBOX_ADDRESSES);
    renderLegacyRedirectShell(this.contentEl, {
      title: "Inbox moved",
      copy:
        "The legacy inbox view moved out of Augment for Obsidian. Open Augment Control Center when it is available, or use Learn more for the current gap-period path.",
      countLine: unread > 0 ? `Unread attention: ${unread}` : null,
      onOpenControlCenter: () => {
        void (this.app as any).plugins?.plugins?.["augment-terminal"]?.openControlCenter?.();
      },
    });
  }

  private refreshRelativeTimes(): void {
    this.contentEl.querySelectorAll<HTMLElement>("[data-augment-ts]").forEach((el) => {
      const timestampMs = Number(el.dataset.augmentTs ?? "0");
      const prefix = el.dataset.augmentTsPrefix ?? "";
      el.textContent = `${prefix}${relativeTime(timestampMs)}`;
    });
  }

  private render(threads: InboxThreadSummary[], transcript: InboxMessage[]): void {
    const selectedThread =
      threads.find((thread) => thread.threadId === this.viewState.selectedThreadId) ?? null;

    this.contentEl.empty();
    this.contentEl.addClass("augment-part-inbox-view");

    this.renderHeader(selectedThread, transcript);

    const layout = this.contentEl.createDiv({
      cls:
        "augment-part-inbox-layout" +
        (this.viewState.mode === "human" ? " is-human-mode" : ""),
    });
    const threadPane = layout.createDiv({ cls: "augment-part-inbox-threads" });
    const transcriptPane = layout.createDiv({ cls: "augment-part-inbox-transcript" });

    this.renderThreadList(threadPane, threads, selectedThread?.threadId ?? "");
    this.renderTranscript(transcriptPane, selectedThread, transcript);
  }

  private renderHeader(selectedThread: InboxThreadSummary | null, transcript: InboxMessage[]): void {
    const header = this.contentEl.createDiv({ cls: "augment-part-inbox-header" });
    const titleBlock = header.createDiv({ cls: "augment-part-inbox-title-block" });
    const titleRow = titleBlock.createDiv({ cls: "augment-part-inbox-title-row" });
    const metaRow = titleBlock.createDiv({ cls: "augment-part-inbox-meta-row" });
    const actions = header.createDiv({ cls: "augment-part-inbox-actions" });

    titleRow.createDiv({ cls: "augment-part-inbox-title", text: "Messages" });
    const selectorWrapper = titleRow.createDiv({
      cls: "dropdown augment-part-inbox-selector-wrap",
    });
    const selector = selectorWrapper.createEl("select", {
      cls: "augment-part-inbox-selector",
      attr: { "aria-label": "Filter messages" },
    }) as HTMLSelectElement;
    selector.createEl("option", {
      value: ALL_MESSAGES_FILTER,
      text: "All messages",
    });
    selector.createEl("option", {
      value: WITH_MATT_FILTER,
      text: "With Matt",
    });
    for (const part of this.discoveredParts) {
      selector.createEl("option", {
        value: part.address,
        text: formatMailboxLabel(part.address, part),
      });
    }
    selector.value = this.selectedFilterValue();
    selector.addEventListener("change", () => {
      if (selector.value === ALL_MESSAGES_FILTER) {
        void this.setMode("all");
        return;
      }
      if (selector.value === WITH_MATT_FILTER) {
        void this.setMode("human");
        return;
      }
      void this.setMode(selector.value);
    });

    if (this.viewState.mode === "all") {
      const visibleCount = this.visibleAddresses().length;
      metaRow.createSpan({
        cls: "augment-part-inbox-pill",
        text: `${visibleCount} visible ${visibleCount === 1 ? "address" : "addresses"}`,
      });
    } else if (this.viewState.mode === "human") {
      const unread = unreadCount(this.app, HUMAN_ADDRESS);
      metaRow.createSpan({
        cls: "augment-part-inbox-pill",
        text: unread > 0 ? `${unread} unread for Matt` : "No unread for Matt",
      });
    } else {
      const part = this.resolvePart(this.viewState.address);
      if (!part) return;
      const terminalLeaf = findTerminalLeafForPart(this.app, part);
      const terminalStatus = (terminalLeaf?.view as TerminalViewLike | undefined)?.getStatus?.();
      const unread = unreadCount(this.app, part.address);
      metaRow.createSpan({ cls: "augment-part-inbox-pill", text: part.habitat });
      metaRow.createSpan({
        cls:
          "augment-part-inbox-pill augment-part-inbox-pill-terminal" +
          (terminalLeaf ? " is-live" : " is-offline"),
        text: formatTerminalStatus(terminalStatus),
      });
      metaRow.createSpan({
        cls: "augment-part-inbox-pill",
        text: formatPartQueueLabel(unread),
      });

      const newBtn = actions.createEl("button", {
        cls: "mod-cta",
        text: "New message",
        attr: { type: "button" },
      });
      newBtn.addEventListener("click", () => {
        this.openCompose(part.address);
      });

      if (terminalLeaf) {
        const jumpBtn = actions.createEl("button", {
          text: "Jump to terminal",
          attr: { type: "button" },
        });
        jumpBtn.addEventListener("click", () => focusLeaf(this.app, terminalLeaf));
      }
    }

    const replyTarget = this.getReplyTarget(selectedThread, transcript);
    const replyTo = transcript.length > 0 ? transcript[transcript.length - 1].msgId : "";
    if (selectedThread && replyTarget && replyTo) {
      const replyBtn = actions.createEl("button", {
        text: `Reply to ${formatAddressLabel(replyTarget)}`,
        attr: { type: "button" },
      });
      replyBtn.addEventListener("click", () => {
        this.openCompose(replyTarget, {
          threadId: selectedThread.threadId,
          replyTo,
          subject: selectedThread.subject,
        });
      });
    }
  }

  private renderThreadList(
    container: HTMLElement,
    threads: InboxThreadSummary[],
    selectedThreadId: string
  ): void {
    const list = container.createDiv({ cls: "augment-part-inbox-thread-list" });

    if (threads.length === 0) {
      const empty = list.createDiv({ cls: "augment-part-inbox-empty" });
      if (this.viewState.mode === "all") {
        empty.createDiv({
          cls: "augment-part-inbox-empty-title",
          text: "No messages in scope yet.",
        });
        empty.createDiv({
          cls: "augment-part-inbox-empty-copy",
          text: "When Augment has visible traffic between Matt and the listed agents, threads will appear here.",
        });
      } else if (this.viewState.mode === "human") {
        empty.createDiv({
          cls: "augment-part-inbox-empty-title",
          text: "No messages with Matt yet.",
        });
        empty.createDiv({
          cls: "augment-part-inbox-empty-copy",
          text: "This view only shows threads where one side is Matt. Switch to All messages to inspect agent traffic.",
        });
      } else {
        const part = this.resolvePart();
        const partLabel = formatMailboxLabel(this.viewState.address, part);
        empty.createDiv({
          cls: "augment-part-inbox-empty-title",
          text: `No messages with ${partLabel} yet.`,
        });
        empty.createDiv({
          cls: "augment-part-inbox-empty-copy",
          text: `This view only shows threads where one side is ${partLabel}. Start a conversation or switch filters.`,
        });
      }

      if (this.viewState.mode === "part") {
        const part = this.resolvePart();
        if (part) {
          const cta = empty.createEl("button", {
            cls: "mod-cta",
            text: "Start a conversation",
            attr: { type: "button" },
          });
          cta.addEventListener("click", () => this.openCompose(part.address));
        }
      }
      return;
    }

    for (const thread of threads) {
      const row = list.createEl("button", {
        cls:
          "augment-part-inbox-thread-row" +
          (thread.threadId === selectedThreadId ? " is-selected" : "") +
          (thread.hasUnread ? " has-unread" : ""),
        attr: { type: "button" },
      });
      const rowTop = row.createDiv({ cls: "augment-part-inbox-thread-top" });
      rowTop.createSpan({
        cls:
          "augment-part-inbox-thread-dot" +
          (thread.hasUnread ? " is-unread" : " is-read"),
      });
      rowTop.createSpan({
        cls: "augment-part-inbox-thread-title",
        text: formatThreadSubject(thread),
      });
      const age = rowTop.createSpan({ cls: "augment-part-inbox-thread-age" });
      age.dataset.augmentTs = String(parseTimestampMs(thread.lastActivityAt));
      age.textContent = relativeTime(parseTimestampMs(thread.lastActivityAt));

      const route = row.createDiv({ cls: "augment-part-inbox-thread-route" });
      renderLabeledField(
        route,
        "augment-part-inbox-thread",
        "From",
        formatAddressLabel(thread.lastSender)
      );
      renderLabeledField(
        route,
        "augment-part-inbox-thread",
        "To",
        formatAddressLabel(thread.lastTo)
      );
      row.createDiv({
        cls: "augment-part-inbox-thread-participants",
        text: formatThreadParticipants(thread),
      });

      row.addEventListener("click", () => {
        if (this.viewState.mode === "part") {
          this.viewState = {
            ...this.viewState,
            selectedThreadId: thread.threadId,
          };
        } else if (this.viewState.mode === "human") {
          this.viewState = {
            mode: "human",
            selectedThreadId: thread.threadId,
          };
        } else {
          this.viewState = {
            mode: "all",
            selectedThreadId: thread.threadId,
          };
        }
        void this.refresh();
      });
    }
  }

  private renderTranscript(
    container: HTMLElement,
    selectedThread: InboxThreadSummary | null,
    transcript: InboxMessage[]
  ): void {
    if (!selectedThread || transcript.length === 0) {
      const empty = container.createDiv({ cls: "augment-part-inbox-empty" });
      empty.createDiv({
        cls: "augment-part-inbox-empty-title",
        text: selectedThread ? "Thread is empty." : "Select a thread.",
      });
      if (!selectedThread && this.viewState.mode === "part") {
        const part = this.resolvePart();
        if (part) {
          const cta = empty.createEl("button", {
            cls: "mod-cta",
            text: "New message",
            attr: { type: "button" },
          });
          cta.addEventListener("click", () => this.openCompose(part.address));
        }
      }
      return;
    }

    const transcriptHeader = container.createDiv({ cls: "augment-part-inbox-transcript-header" });
    transcriptHeader.createDiv({
      cls: "augment-part-inbox-transcript-title",
      text: formatThreadSubject(selectedThread),
    });
    transcriptHeader.createDiv({
      cls: "augment-part-inbox-transcript-subtitle",
      text: `Participants: ${formatParticipantList(selectedThread.participants)}`,
    });
    const transcriptMeta = transcriptHeader.createDiv({
      cls: "augment-part-inbox-transcript-meta",
    });
    transcriptMeta.createSpan({
      cls: "augment-part-inbox-transcript-count",
      text: `${selectedThread.messageCount} ${
        selectedThread.messageCount === 1 ? "message" : "messages"
      }`,
    });
    const activity = transcriptMeta.createSpan({
      cls: "augment-part-inbox-transcript-activity",
    });
    activity.dataset.augmentTs = String(parseTimestampMs(selectedThread.lastActivityAt));
    activity.dataset.augmentTsPrefix = "Last activity ";
    activity.textContent = `Last activity ${relativeTime(parseTimestampMs(selectedThread.lastActivityAt))}`;

    const messages = container.createDiv({ cls: "augment-part-inbox-messages" });
    for (const message of transcript) {
      this.renderMessage(messages, message);
    }
  }

  private renderMessage(container: HTMLElement, message: InboxMessage): void {
    const wrapper = container.createDiv({ cls: "augment-part-inbox-message" });
    const bubble = wrapper.createDiv({ cls: "augment-part-inbox-bubble" });
    const route = bubble.createDiv({
      cls: "augment-part-inbox-message-meta augment-part-inbox-message-route",
    });
    const routeFields = route.createDiv({
      cls: "augment-part-inbox-message-route-fields",
    });
    renderLabeledField(
      routeFields,
      "augment-part-inbox-message",
      "From",
      formatAddressLabel(message.from)
    );
    renderLabeledField(
      routeFields,
      "augment-part-inbox-message",
      "To",
      formatAddressLabel(message.to)
    );
    route.createSpan({
      cls: "augment-part-inbox-message-time",
      text: absoluteTime(message.createdAt),
    });

    if (message.privacy === "shared" || message.sourceNote) {
      const context = bubble.createDiv({
        cls: "augment-part-inbox-message-meta augment-part-inbox-message-context",
      });

      if (message.privacy === "shared") {
        context.createSpan({
          cls: "augment-part-inbox-message-privacy",
          text: "Shared",
        });
      }

      if (message.sourceNote) {
        context.createSpan({
          cls: "augment-part-inbox-message-source",
          text: `Source: ${message.sourceNote}`,
        });
      }
    }

    bubble.createDiv({
      cls: "augment-part-inbox-message-body",
      text: message.body || " ",
    });
  }

  private getReplyTarget(
    selectedThread: InboxThreadSummary | null,
    transcript: InboxMessage[]
  ): string | null {
    if (!selectedThread || transcript.length === 0) return null;
    if (this.viewState.mode === "part") {
      return this.viewState.address;
    }
    if (selectedThread.humanInvolved) {
      return selectedThread.participants.find((participant) => participant !== HUMAN_ADDRESS) ?? null;
    }
    return selectedThread.lastSender || transcript[transcript.length - 1].from;
  }

  private openCompose(
    recipientAddress: string,
    options: { threadId?: string; replyTo?: string; subject?: string } = {}
  ): void {
    new ComposeModal(
      this.app,
      recipientAddress,
      formatAddressLabel(recipientAddress),
      "",
      "",
      options
    ).open();
  }
}
