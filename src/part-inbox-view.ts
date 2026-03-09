import { App, ItemView, WorkspaceLeaf } from "obsidian";
import {
  discoverVaultParts,
  getThread,
  HUMAN_ADDRESS,
  InboxMessage,
  InboxThreadSummary,
  listHumanInboxThreads,
  listPartThreads,
  markThreadRead,
  PartInfo,
  unreadCount,
} from "./inbox-bus";
import { ComposeModal } from "./inbox-suggest";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";

export const VIEW_TYPE_PART_INBOX = "augment-part-inbox";

export type PartInboxViewState =
  | { mode: "part"; address: string; selectedThreadId?: string }
  | { mode: "human"; selectedThreadId?: string };

type TerminalViewLike = {
  getStatus?: () => string;
  getName?: () => string;
  getAgentIdentity?: () => string | null;
  getWorkingDirectory?: () => string;
  markActivityRead?: () => void;
};

type ResolvedPart = Pick<PartInfo, "name" | "address" | "habitat" | "isProjectPart">;

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

function scorePartMatch(leaf: WorkspaceLeaf, part: ResolvedPart): number {
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

function findTerminalLeafForPart(app: App, part: ResolvedPart): WorkspaceLeaf | null {
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
    address: address.trim().toLowerCase(),
  });
}

export async function openHumanInbox(app: App): Promise<PartInboxView> {
  return openPartInboxLeaf(app, { mode: "human" });
}

export class PartInboxView extends ItemView {
  private viewState: PartInboxViewState = { mode: "human" };
  private refreshToken = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PART_INBOX;
  }

  getDisplayText(): string {
    if (this.viewState.mode === "human") return "My inbox";
    return `Inbox: ${splitAddress(this.viewState.address).name}`;
  }

  getIcon(): string {
    return "inbox";
  }

  getState(): PartInboxViewState {
    return { ...this.viewState };
  }

  async setState(state: PartInboxViewState): Promise<void> {
    if (state.mode === "part") {
      this.viewState = {
        mode: "part",
        address: state.address.trim().toLowerCase(),
        selectedThreadId: state.selectedThreadId,
      };
    } else {
      this.viewState = {
        mode: "human",
        selectedThreadId: state.selectedThreadId,
      };
    }

    await this.refresh();
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("augment-part-inbox-view");

    this.registerEvent(
      (this.app.workspace as any).on("augment-bus:changed", () => void this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("augment-terminal:changed", () => void this.refresh())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => void this.refresh())
    );
    this.registerInterval(window.setInterval(() => this.refreshRelativeTimes(), 30_000));

    await this.refresh();
  }

  private resolvePart(): ResolvedPart | null {
    if (this.viewState.mode !== "part") return null;
    const resolved = discoverVaultParts(this.app).find(
      (part) => part.address === this.viewState.address
    );
    if (resolved) return resolved;

    const { name, habitat } = splitAddress(this.viewState.address);
    return {
      name,
      address: this.viewState.address,
      habitat,
      isProjectPart: habitat !== "vault",
    };
  }

  private currentThreads(): InboxThreadSummary[] {
    if (this.viewState.mode === "human") {
      return listHumanInboxThreads(this.app);
    }
    return listPartThreads(this.app, this.viewState.address);
  }

  private async refresh(): Promise<void> {
    const token = ++this.refreshToken;
    const threads = this.currentThreads();
    let selectedThreadId = this.viewState.selectedThreadId;

    if (selectedThreadId && !threads.some((thread) => thread.threadId === selectedThreadId)) {
      selectedThreadId = undefined;
    }

    if (!selectedThreadId && threads.length > 0) {
      selectedThreadId = threads[0].threadId;
    }

    if (this.viewState.mode === "part") {
      this.viewState = {
        ...this.viewState,
        selectedThreadId,
      };
    } else {
      this.viewState = {
        mode: "human",
        selectedThreadId,
      };
    }

    if (selectedThreadId && this.viewState.mode === "human") {
      await markThreadRead(this.app, selectedThreadId, HUMAN_ADDRESS);
      if (token !== this.refreshToken) return;
    }

    const refreshedThreads = this.currentThreads();
    const transcript =
      selectedThreadId && refreshedThreads.some((thread) => thread.threadId === selectedThreadId)
        ? await getThread(this.app, selectedThreadId)
        : [];

    if (token !== this.refreshToken) return;
    this.render(refreshedThreads, transcript);
  }

  private refreshRelativeTimes(): void {
    this.contentEl.querySelectorAll<HTMLElement>("[data-augment-ts]").forEach((el) => {
      const timestampMs = Number(el.dataset.augmentTs ?? "0");
      el.textContent = relativeTime(timestampMs);
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

    if (this.viewState.mode === "human") {
      titleRow.createDiv({ cls: "augment-part-inbox-title", text: "My inbox" });
      const unread = unreadCount(this.app, HUMAN_ADDRESS);
      metaRow.createSpan({
        cls: "augment-part-inbox-pill",
        text: unread > 0 ? `${unread} unread` : "No unread messages",
      });
    } else {
      const part = this.resolvePart();
      if (!part) return;

      const terminalLeaf = findTerminalLeafForPart(this.app, part);
      const terminalStatus = (terminalLeaf?.view as TerminalViewLike | undefined)?.getStatus?.();
      const unread = unreadCount(this.app, part.address);

      titleRow.createDiv({ cls: "augment-part-inbox-title", text: part.name });
      metaRow.createSpan({ cls: "augment-part-inbox-pill", text: part.habitat });
      metaRow.createSpan({
        cls:
          "augment-part-inbox-pill augment-part-inbox-pill-terminal" +
          (terminalLeaf ? " is-live" : " is-offline"),
        text: formatTerminalStatus(terminalStatus),
      });
      metaRow.createSpan({
        cls: "augment-part-inbox-pill",
        text: unread > 0 ? `${unread} unread` : "No unread messages",
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

    const replyTarget = this.getReplyTarget(selectedThread);
    const replyTo = transcript.length > 0 ? transcript[transcript.length - 1].msgId : "";
    if (selectedThread && replyTarget && replyTo) {
      const replyBtn = actions.createEl("button", {
        text: "Reply",
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
      empty.createDiv({
        cls: "augment-part-inbox-empty-title",
        text:
          this.viewState.mode === "human"
            ? "No messages addressed to you."
            : "No threads with this part yet.",
      });

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
        text:
          this.viewState.mode === "human"
            ? formatAddressLabel(thread.counterparty)
            : thread.subject,
      });
      const age = rowTop.createSpan({ cls: "augment-part-inbox-thread-age" });
      age.dataset.augmentTs = String(parseTimestampMs(thread.lastActivityAt));
      age.textContent = relativeTime(parseTimestampMs(thread.lastActivityAt));

      row.createDiv({
        cls: "augment-part-inbox-thread-subline",
        text:
          this.viewState.mode === "human"
            ? thread.subject
            : `${formatAddressLabel(thread.lastSender)} · ${thread.messageCount} messages`,
      });

      row.addEventListener("click", () => {
        if (this.viewState.mode === "part") {
          this.viewState = {
            ...this.viewState,
            selectedThreadId: thread.threadId,
          };
        } else {
          this.viewState = {
            mode: "human",
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
      text: selectedThread.subject,
    });
    transcriptHeader.createDiv({
      cls: "augment-part-inbox-transcript-subtitle",
      text:
        this.viewState.mode === "human"
          ? formatAddressLabel(selectedThread.counterparty)
          : `${selectedThread.messageCount} messages`,
    });

    const messages = container.createDiv({ cls: "augment-part-inbox-messages" });
    for (const message of transcript) {
      this.renderMessage(messages, message);
    }
  }

  private renderMessage(container: HTMLElement, message: InboxMessage): void {
    const outbound = message.from === HUMAN_ADDRESS;
    const wrapper = container.createDiv({
      cls:
        "augment-part-inbox-message" + (outbound ? " is-outbound" : " is-inbound"),
    });
    const bubble = wrapper.createDiv({ cls: "augment-part-inbox-bubble" });
    const meta = bubble.createDiv({ cls: "augment-part-inbox-message-meta" });
    meta.createSpan({
      cls: "augment-part-inbox-message-sender",
      text: formatAddressLabel(message.from),
    });
    meta.createSpan({
      cls: "augment-part-inbox-message-time",
      text: absoluteTime(message.createdAt),
    });

    if (message.privacy === "shared") {
      meta.createSpan({
        cls: "augment-part-inbox-message-privacy",
        text: "Shared",
      });
    }

    if (message.sourceNote) {
      bubble.createDiv({
        cls: "augment-part-inbox-message-source",
        text: message.sourceNote,
      });
    }

    bubble.createDiv({
      cls: "augment-part-inbox-message-body",
      text: message.body || " ",
    });
  }

  private getReplyTarget(selectedThread: InboxThreadSummary | null): string | null {
    if (!selectedThread) return null;
    if (this.viewState.mode === "part") {
      return this.viewState.address;
    }
    return selectedThread.counterparty === HUMAN_ADDRESS ? null : selectedThread.counterparty;
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
