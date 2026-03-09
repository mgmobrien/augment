import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

type PrivacyTier = "local" | "shared";
type MessageType = "message" | "request" | "response" | "error";
type EventType = "delivered" | "read" | "acked";

const BUS_ROOT = "agents/bus";
const PARTS_ROOT = "agents/parts";
const SIGNALS_ROOT = `${BUS_ROOT}/derived/signals`;
const SOURCE_NOTE_PREFIX = "<!-- source_note:";
const SOURCE_NOTE_SUFFIX = "-->";
export const HUMAN_ADDRESS = "user@vault";

export interface InboxMessage {
  msgId: string;
  threadId: string;
  from: string;
  to: string;
  msgType: string;
  subject: string;
  replyTo: string;
  createdAt: string;
  habitat: string;
  privacy: string;
  sourceNote: string;
  body: string;
  filePath: string;
}

export interface WriteMessageOptions {
  to: string;
  from: string;
  subject: string;
  body: string;
  threadId?: string;
  msgType?: string;
  replyTo?: string;
  habitat?: string;
  privacy?: string;
  sourceNote?: string;
}

export interface PartInfo {
  name: string;
  address: string;
  habitat: string;
  workspacePath: string;
  isProjectPart: boolean;
}

export interface InboxThreadSummary {
  threadId: string;
  subject: string;
  lastSender: string;
  counterparty: string;
  lastActivityAt: string;
  lastActivityAge: number;
  messageCount: number;
  hasUnread: boolean;
}

interface IndexedMessage {
  file: TFile;
  filePath: string;
  msgId: string;
  threadId: string;
  from: string;
  to: string;
  msgType: string;
  subject: string;
  replyTo: string;
  createdAt: string;
  habitat: string;
  privacy: PrivacyTier;
  sourceNote: string;
}

interface IndexedEvent {
  msgId: string;
  threadId: string;
  eventType: EventType;
  actor: string;
  privacy: PrivacyTier;
}

interface BusIndex {
  messagesById: Map<string, IndexedMessage>;
  unreadByActor: Map<string, IndexedMessage[]>;
  unreadCounts: Map<string, number>;
  deliveredKeys: Set<string>;
  readKeys: Set<string>;
}

interface CacheState {
  dirty: boolean;
  wired: boolean;
  index: BusIndex | null;
  notify: (() => void) | null;
}

const cacheByApp = new WeakMap<App, CacheState>();

function normalizeAddress(raw: string, kind: "to" | "from"): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return kind === "from" ? HUMAN_ADDRESS : "@vault";
  if (kind === "from" && trimmed === "user") return HUMAN_ADDRESS;
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed}@vault`;
}

function extractHabitat(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1 || at === address.length - 1) return "vault";
  return address.slice(at + 1);
}

function normalizePrivacy(value?: string): PrivacyTier {
  return value?.trim().toLowerCase() === "shared" ? "shared" : "local";
}

function normalizeMessageType(value?: string): MessageType {
  switch (value?.trim().toLowerCase()) {
    case "request":
    case "response":
    case "error":
      return value.trim().toLowerCase() as MessageType;
    default:
      return "message";
  }
}

function normalizeReplyTo(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeSubject(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "Message";
  return compact.slice(0, 120);
}

function canonicalTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function filenameTimestamp(timestamp: string): string {
  return timestamp.replace(/:/g, "");
}

function messageFolderPath(privacy: PrivacyTier, createdAt: string): string {
  return normalizePath(
    `${BUS_ROOT}/${privacy}/messages/${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}`
  );
}

function eventFolderPath(privacy: PrivacyTier, createdAt: string): string {
  return normalizePath(
    `${BUS_ROOT}/${privacy}/events/${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}`
  );
}

function messageFilePath(privacy: PrivacyTier, createdAt: string, msgId: string): string {
  const folder = messageFolderPath(privacy, createdAt);
  return normalizePath(`${folder}/${filenameTimestamp(createdAt)}__${msgId}.md`);
}

function signalSlug(address: string): string {
  return address.replace(/@/g, "_at_");
}

function signalFilePath(address: string): string {
  return normalizePath(`${SIGNALS_ROOT}/${signalSlug(address)}.json`);
}

function legacyInboxFolderPath(address: string): string {
  const [partName, habitat] = address.split("@");
  if (habitat && habitat !== "vault") {
    // Project parts: agents/parts/{habitat}/{partName}/inbox
    return normalizePath(`${PARTS_ROOT}/${habitat}/${partName}/inbox`);
  }
  // Vault parts: agents/parts/{partName}/inbox
  return normalizePath(`${PARTS_ROOT}/${partName}/inbox`);
}

function legacyInboxFilePath(address: string, createdAt: string, msgId: string): string {
  const folder = legacyInboxFolderPath(address);
  const shortId = msgId.slice(0, 8);
  return normalizePath(`${folder}/${filenameTimestamp(createdAt)}-${shortId}.md`);
}

function eventFilePath(
  privacy: PrivacyTier,
  createdAt: string,
  eventType: EventType,
  msgId: string,
  eventId: string
): string {
  const folder = eventFolderPath(privacy, createdAt);
  return normalizePath(
    `${folder}/${filenameTimestamp(createdAt)}__${eventType}__${msgId}__${eventId}.md`
  );
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodeSourceNoteBody(sourceNote: string, body: string): string {
  const trimmedNote = sourceNote.trim();
  if (!trimmedNote) return body;
  const escapedNote = trimmedNote.replace(/-->/g, "-- >");
  const prefix = `${SOURCE_NOTE_PREFIX} ${escapedNote} ${SOURCE_NOTE_SUFFIX}`;
  return body ? `${prefix}\n\n${body}` : prefix;
}

function decodeSourceNoteBody(rawBody: string): { sourceNote: string; body: string } {
  if (!rawBody.startsWith(SOURCE_NOTE_PREFIX)) {
    return { sourceNote: "", body: rawBody };
  }

  const end = rawBody.indexOf(SOURCE_NOTE_SUFFIX);
  if (end === -1) {
    return { sourceNote: "", body: rawBody };
  }

  const sourceNote = rawBody
    .slice(SOURCE_NOTE_PREFIX.length, end)
    .trim()
    .replace(/-- >/g, "-->");
  const remainder = rawBody.slice(end + SOURCE_NOTE_SUFFIX.length).replace(/^\s*\n/, "");
  return { sourceNote, body: remainder };
}

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? raw.slice(match[0].length) : raw;
}

function eventKey(msgId: string, actor: string): string {
  return `${msgId}::${actor}`;
}

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function collectMarkdownFiles(root: TFolder | null): TFile[] {
  if (!root) return [];

  const files: TFile[] = [];
  const queue: TAbstractFile[] = [...root.children];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current instanceof TFolder) {
      queue.push(...current.children);
      continue;
    }
    if (current instanceof TFile && current.extension === "md") {
      files.push(current);
    }
  }

  return files;
}

function getBusFolder(app: App, privacy: PrivacyTier, kind: "messages" | "events"): TFolder | null {
  const path = normalizePath(`${BUS_ROOT}/${privacy}/${kind}`);
  const folder = app.vault.getAbstractFileByPath(path);
  return folder instanceof TFolder ? folder : null;
}

function fileCacheFrontmatter(app: App, file: TFile): Record<string, unknown> | null {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;
  return frontmatter ? (frontmatter as Record<string, unknown>) : null;
}

function toIndexedMessage(app: App, file: TFile, privacy: PrivacyTier): IndexedMessage | null {
  const fm = fileCacheFrontmatter(app, file);
  if (!fm) return null;

  const msgId = asString(fm.msg_id).toLowerCase();
  const from = normalizeAddress(asString(fm.from), "from");
  const to = normalizeAddress(asString(fm.to), "to");
  if (!msgId || !to) return null;

  const replyTo = normalizeReplyTo(asString(fm.reply_to));

  return {
    file,
    filePath: file.path,
    msgId,
    threadId: asString(fm.thread_id) || msgId,
    from,
    to,
    msgType: normalizeMessageType(asString(fm.msg_type)),
    subject: asString(fm.subject) || "Message",
    replyTo,
    createdAt: asString(fm.created_at),
    habitat: extractHabitat(from),
    privacy: normalizePrivacy(asString(fm.privacy) || privacy),
    sourceNote: asString(fm.source_note),
  };
}

function toIndexedEvent(app: App, file: TFile, privacy: PrivacyTier): IndexedEvent | null {
  const fm = fileCacheFrontmatter(app, file);
  if (!fm) return null;

  const eventType = asString(fm.event_type) as EventType;
  if (eventType !== "delivered" && eventType !== "read" && eventType !== "acked") {
    return null;
  }

  const msgId = asString(fm.msg_id).toLowerCase();
  const actor = normalizeAddress(asString(fm.actor), "to");
  if (!msgId || !actor) return null;

  return {
    msgId,
    threadId: asString(fm.thread_id),
    eventType,
    actor,
    privacy: normalizePrivacy(asString(fm.privacy) || privacy),
  };
}

function sortMessages(messages: IndexedMessage[]): IndexedMessage[] {
  return messages.sort((a, b) => {
    const createdCompare = a.createdAt.localeCompare(b.createdAt);
    return createdCompare !== 0 ? createdCompare : a.msgId.localeCompare(b.msgId);
  });
}

function buildBusIndex(app: App): BusIndex {
  const messagesById = new Map<string, IndexedMessage>();
  const unreadByActor = new Map<string, IndexedMessage[]>();
  const unreadCounts = new Map<string, number>();
  const deliveredKeys = new Set<string>();
  const readKeys = new Set<string>();

  for (const privacy of ["local", "shared"] as PrivacyTier[]) {
    for (const file of collectMarkdownFiles(getBusFolder(app, privacy, "messages"))) {
      const message = toIndexedMessage(app, file, privacy);
      if (message) {
        messagesById.set(message.msgId, message);
      }
    }

    for (const file of collectMarkdownFiles(getBusFolder(app, privacy, "events"))) {
      const event = toIndexedEvent(app, file, privacy);
      if (!event) continue;

      const key = eventKey(event.msgId, event.actor);
      if (event.eventType === "delivered") deliveredKeys.add(key);
      if (event.eventType === "read" || event.eventType === "acked") {
        deliveredKeys.add(key);
        readKeys.add(key);
      }
    }
  }

  for (const message of messagesById.values()) {
    const actor = message.to;
    if (readKeys.has(eventKey(message.msgId, actor))) continue;

    const unread = unreadByActor.get(actor) ?? [];
    unread.push(message);
    unreadByActor.set(actor, unread);
    unreadCounts.set(actor, (unreadCounts.get(actor) ?? 0) + 1);
  }

  for (const messages of unreadByActor.values()) {
    sortMessages(messages);
  }

  return {
    messagesById,
    unreadByActor,
    unreadCounts,
    deliveredKeys,
    readKeys,
  };
}

function getCacheState(app: App): CacheState {
  let state = cacheByApp.get(app);
  if (!state) {
    state = { dirty: true, wired: false, index: null, notify: null };
    cacheByApp.set(app, state);
  }
  if (!state.wired) wireCacheInvalidation(app, state);
  return state;
}

function isBusPath(path: string): boolean {
  return normalizePath(path).startsWith(`${BUS_ROOT}/`);
}

function wireCacheInvalidation(app: App, state: CacheState): void {
  if (state.wired) return;
  state.wired = true;

  const markDirty = (path?: string): void => {
    if (path && isBusPath(path)) {
      state.dirty = true;
      state.notify?.();
    }
  };

  app.vault.on("create", (file) => markDirty(file.path));
  app.vault.on("modify", (file) => markDirty(file.path));
  app.vault.on("delete", (file) => markDirty(file.path));
  app.vault.on("rename", (file, oldPath) => {
    markDirty(oldPath);
    markDirty(file.path);
  });
  app.metadataCache.on("resolved", () => {
    state.dirty = true;
  });
}

function getBusIndex(app: App): BusIndex {
  const state = getCacheState(app);
  if (!state.dirty && state.index) return state.index;
  const index = buildBusIndex(app);
  state.index = index;
  state.dirty = false;
  return index;
}

function insertUnreadMessage(index: BusIndex, message: IndexedMessage): void {
  if (index.readKeys.has(eventKey(message.msgId, message.to))) return;
  const unread = index.unreadByActor.get(message.to) ?? [];
  unread.push(message);
  sortMessages(unread);
  index.unreadByActor.set(message.to, unread);
  index.unreadCounts.set(message.to, (index.unreadCounts.get(message.to) ?? 0) + 1);
}

function removeUnreadMessage(index: BusIndex, msgId: string, actor: string): void {
  const unread = index.unreadByActor.get(actor);
  if (!unread) return;
  const next = unread.filter((message) => message.msgId !== msgId);
  if (next.length === unread.length) return;

  if (next.length === 0) {
    index.unreadByActor.delete(actor);
    index.unreadCounts.delete(actor);
    return;
  }

  index.unreadByActor.set(actor, next);
  index.unreadCounts.set(actor, next.length);
}

function recordMessageWrite(app: App, message: IndexedMessage): void {
  const state = getCacheState(app);
  if (!state.index) {
    state.index = buildBusIndex(app);
  }

  state.dirty = false;
  state.index.messagesById.set(message.msgId, message);
  insertUnreadMessage(state.index, message);
}

function recordEventWrite(app: App, event: IndexedEvent): void {
  const state = getCacheState(app);
  if (!state.index) {
    state.index = buildBusIndex(app);
  }

  state.dirty = false;
  const key = eventKey(event.msgId, event.actor);
  if (event.eventType === "delivered") {
    state.index.deliveredKeys.add(key);
    return;
  }

  if (event.eventType === "read" || event.eventType === "acked") {
    state.index.deliveredKeys.add(key);
    if (state.index.readKeys.has(key)) return;
    state.index.readKeys.add(key);
    removeUnreadMessage(state.index, event.msgId, event.actor);
  }
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (app.vault.getAbstractFileByPath(normalized)) return;

  const parts = normalized.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // Folder creation races are harmless.
      }
    }
  }
}

function buildMessageFrontmatter(message: IndexedMessage): string {
  return [
    "---",
    `msg_id: ${message.msgId}`,
    `thread_id: ${message.threadId}`,
    `from: ${message.from}`,
    `to: ${message.to}`,
    `msg_type: ${message.msgType}`,
    `subject: ${yamlQuote(message.subject)}`,
    `created_at: ${message.createdAt}`,
    `habitat: ${message.habitat}`,
    `privacy: ${message.privacy}`,
    `reply_to: ${message.replyTo || "null"}`,
    "---",
  ].join("\n");
}

function buildEventFrontmatter(eventId: string, message: IndexedMessage, eventType: EventType, actor: string, createdAt: string): string {
  return [
    "---",
    `event_id: ${eventId}`,
    `msg_id: ${message.msgId}`,
    `thread_id: ${message.threadId}`,
    `event_type: ${eventType}`,
    `actor: ${actor}`,
    "via: augment-ui",
    `created_at: ${createdAt}`,
    "---",
  ].join("\n");
}

function buildSignalContent(message: IndexedMessage, createdAt = canonicalTimestamp()): string {
  return `${JSON.stringify(
    {
      to: message.to,
      msg_id: message.msgId,
      thread_id: message.threadId,
      created_at: createdAt,
    },
    null,
    2
  )}\n`;
}

function toInboxMessage(message: IndexedMessage, rawBody: string): InboxMessage {
  const parsed = decodeSourceNoteBody(rawBody);
  return {
    msgId: message.msgId,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    msgType: message.msgType,
    subject: message.subject,
    replyTo: message.replyTo,
    createdAt: message.createdAt,
    habitat: message.habitat,
    privacy: message.privacy,
    sourceNote: parsed.sourceNote || message.sourceNote,
    body: parsed.body,
    filePath: message.filePath,
  };
}

function listIndexedMessages(index: BusIndex): IndexedMessage[] {
  return sortMessages([...index.messagesById.values()]);
}

function getIndexedThreadMessages(index: BusIndex, threadId: string): IndexedMessage[] {
  const normalized = normalizeReplyTo(threadId);
  return listIndexedMessages(index).filter((message) => message.threadId === normalized);
}

function buildThreadSummary(
  index: BusIndex,
  threadId: string,
  messages: IndexedMessage[],
  primaryAddress: string
): InboxThreadSummary | null {
  if (messages.length === 0) return null;

  const ordered = sortMessages([...messages]);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const lastActivityAt = last.createdAt;
  const participants = new Set<string>();

  for (const message of ordered) {
    participants.add(message.from);
    participants.add(message.to);
  }

  const counterparty =
    [...participants].find((address) => address !== primaryAddress) ?? last.from;

  return {
    threadId,
    subject: first.subject || last.subject || "Message",
    lastSender: last.from,
    counterparty,
    lastActivityAt,
    lastActivityAge: Math.max(0, Date.now() - parseTimestampMs(lastActivityAt)),
    messageCount: ordered.length,
    hasUnread: ordered.some(
      (message) =>
        message.to === primaryAddress &&
        !index.readKeys.has(eventKey(message.msgId, primaryAddress))
    ),
  };
}

function sortThreadSummaries(threads: InboxThreadSummary[]): InboxThreadSummary[] {
  return threads.sort((a, b) => {
    const activityCompare = parseTimestampMs(b.lastActivityAt) - parseTimestampMs(a.lastActivityAt);
    return activityCompare !== 0 ? activityCompare : a.threadId.localeCompare(b.threadId);
  });
}

function buildThreadList(
  app: App,
  primaryAddress: string,
  includeMessage: (message: IndexedMessage) => boolean
): InboxThreadSummary[] {
  const index = getBusIndex(app);
  const threadIds = new Set<string>();

  for (const message of listIndexedMessages(index)) {
    if (includeMessage(message)) {
      threadIds.add(message.threadId);
    }
  }

  const summaries: InboxThreadSummary[] = [];
  for (const threadId of threadIds) {
    const messages = getIndexedThreadMessages(index, threadId);
    const summary = buildThreadSummary(index, threadId, messages, primaryAddress);
    if (summary) summaries.push(summary);
  }

  return sortThreadSummaries(summaries);
}

async function writeEvent(app: App, message: IndexedMessage, eventType: EventType, actor: string, createdAt: string): Promise<void> {
  const eventId = crypto.randomUUID().toLowerCase();
  const folder = eventFolderPath(message.privacy, createdAt);
  await ensureFolder(app, folder);

  const path = eventFilePath(message.privacy, createdAt, eventType, message.msgId, eventId);
  const content = `${buildEventFrontmatter(eventId, message, eventType, actor, createdAt)}\n`;
  await app.vault.create(path, content);

  recordEventWrite(app, {
    msgId: message.msgId,
    threadId: message.threadId,
    eventType,
    actor,
    privacy: message.privacy,
  });
}

export async function writeMessage(app: App, opts: WriteMessageOptions): Promise<string> {
  const to = normalizeAddress(opts.to, "to");
  const from = normalizeAddress(opts.from, "from");
  const msgId = crypto.randomUUID().toLowerCase();
  const replyTo = normalizeReplyTo(opts.replyTo);
  const threadId = (opts.threadId?.trim() || replyTo || msgId).toLowerCase();
  const createdAt = canonicalTimestamp();
  const privacy = normalizePrivacy(opts.privacy);
  const message: IndexedMessage = {
    file: null as unknown as TFile,
    filePath: "",
    msgId,
    threadId,
    from,
    to,
    msgType: normalizeMessageType(opts.msgType),
    subject: normalizeSubject(opts.subject),
    replyTo,
    createdAt,
    habitat: extractHabitat(from),
    privacy,
    sourceNote: opts.sourceNote?.trim() ?? "",
  };

  const folder = messageFolderPath(privacy, createdAt);
  await ensureFolder(app, folder);

  const path = messageFilePath(privacy, createdAt, msgId);
  const body = encodeSourceNoteBody(message.sourceNote, opts.body);
  const content = `${buildMessageFrontmatter(message)}\n\n${body}`;
  const file = await app.vault.create(path, content);

  message.file = file;
  message.filePath = path;
  recordMessageWrite(app, message);

  await ensureFolder(app, SIGNALS_ROOT);
  await app.vault.adapter.write(signalFilePath(message.to), buildSignalContent(message));

  // Compatibility shim for legacy part inbox readers. Remove after migration to agents/bus/.
  const legacyInboxFolder = legacyInboxFolderPath(message.to);
  await ensureFolder(app, legacyInboxFolder);
  await app.vault.create(legacyInboxFilePath(message.to, createdAt, msgId), content);

  return path;
}

export async function readInbox(app: App, partName: string): Promise<InboxMessage[]> {
  const actor = normalizeAddress(partName, "to");
  const messages = [...(getBusIndex(app).unreadByActor.get(actor) ?? [])];
  if (messages.length === 0) return [];

  const result: InboxMessage[] = [];
  for (const message of messages) {
    try {
      const raw = await app.vault.cachedRead(message.file);
      const body = stripFrontmatter(raw).trim();
      result.push(toInboxMessage(message, body));
    } catch {
      // Ignore files that disappeared or became unreadable.
    }
  }

  return result.sort((a, b) => {
    const createdCompare = a.createdAt.localeCompare(b.createdAt);
    return createdCompare !== 0 ? createdCompare : a.msgId.localeCompare(b.msgId);
  });
}

export async function readAndAcknowledgeInbox(app: App, partName: string): Promise<InboxMessage[]> {
  const actor = normalizeAddress(partName, "to");
  const messages = await readInbox(app, actor);
  if (messages.length === 0) return [];

  const index = getBusIndex(app);

  for (const msg of messages) {
    const indexed = index.messagesById.get(msg.msgId);
    if (!indexed) continue;

    const key = eventKey(msg.msgId, actor);
    const hadDelivered = index.deliveredKeys.has(key);
    if (!hadDelivered) {
      const deliveredAt = canonicalTimestamp();
      await writeEvent(app, indexed, "delivered", actor, deliveredAt);
    }

    if (!index.readKeys.has(key)) {
      const readBase = new Date();
      if (!hadDelivered) {
        readBase.setSeconds(readBase.getSeconds() + 1);
      }
      await writeEvent(app, indexed, "read", actor, canonicalTimestamp(readBase));
    }
  }

  return messages;
}

export function listPartThreads(app: App, address: string): InboxThreadSummary[] {
  const normalized = normalizeAddress(address, "to");
  return buildThreadList(
    app,
    normalized,
    (message) => message.from === normalized || message.to === normalized
  );
}

export function listHumanInboxThreads(app: App): InboxThreadSummary[] {
  return buildThreadList(app, HUMAN_ADDRESS, (message) => message.to === HUMAN_ADDRESS);
}

export async function getThread(app: App, threadId: string): Promise<InboxMessage[]> {
  const messages = getIndexedThreadMessages(getBusIndex(app), threadId);
  if (messages.length === 0) return [];

  const transcript: InboxMessage[] = [];
  for (const message of messages) {
    try {
      const raw = await app.vault.cachedRead(message.file);
      const body = stripFrontmatter(raw).trim();
      transcript.push(toInboxMessage(message, body));
    } catch {
      // Ignore files that disappeared or became unreadable.
    }
  }

  return transcript.sort((a, b) => {
    const createdCompare = a.createdAt.localeCompare(b.createdAt);
    return createdCompare !== 0 ? createdCompare : a.msgId.localeCompare(b.msgId);
  });
}

export async function markThreadRead(
  app: App,
  threadId: string,
  actor = HUMAN_ADDRESS
): Promise<void> {
  const normalizedActor = normalizeAddress(actor, "to");
  const index = getBusIndex(app);
  const messages = getIndexedThreadMessages(index, threadId).filter(
    (message) => message.to === normalizedActor
  );
  if (messages.length === 0) return;

  for (const message of messages) {
    const key = eventKey(message.msgId, normalizedActor);
    const hadDelivered = index.deliveredKeys.has(key);
    if (!hadDelivered) {
      await writeEvent(app, message, "delivered", normalizedActor, canonicalTimestamp());
    }

    if (!index.readKeys.has(key)) {
      await writeEvent(app, message, "read", normalizedActor, canonicalTimestamp());
    }
  }
}

export function unreadCount(app: App, partName: string): number {
  const actor = normalizeAddress(partName, "to");
  return getBusIndex(app).unreadCounts.get(actor) ?? 0;
}

function hasPartState(app: App, workspacePath: string): boolean {
  return app.vault.getAbstractFileByPath(
    normalizePath(`${workspacePath}/.state/current.md`)
  ) instanceof TFile;
}

// Register a callback to be called whenever a file under agents/bus/ changes.
// Returns an unsubscribe function. Call once from plugin onload.
export function setBusNotifier(app: App, fn: () => void): () => void {
  const state = getCacheState(app);
  state.notify = fn;
  return () => {
    if (state.notify === fn) state.notify = null;
  };
}

export function discoverVaultParts(app: App): PartInfo[] {
  const partsFolder = app.vault.getAbstractFileByPath(PARTS_ROOT);
  if (!(partsFolder instanceof TFolder)) return [];

  const parts: PartInfo[] = [];

  for (const child of partsFolder.children) {
    if (!(child instanceof TFolder)) continue;

    if (hasPartState(app, child.path)) {
      parts.push({
        name: child.name,
        address: `${child.name}@vault`,
        habitat: "vault",
        workspacePath: child.path,
        isProjectPart: false,
      });
      continue;
    }

    const projectParts = child.children
      .filter((grandchild): grandchild is TFolder => grandchild instanceof TFolder)
      .filter((grandchild) => hasPartState(app, grandchild.path))
      .map((grandchild) => ({
        name: grandchild.name,
        address: `${grandchild.name}@${child.name}`,
        habitat: child.name,
        workspacePath: grandchild.path,
        isProjectPart: true,
      }));

    parts.push(...projectParts);
  }

  return parts.sort((a, b) => {
    if (a.habitat === b.habitat) return a.name.localeCompare(b.name);
    if (a.habitat === "vault") return -1;
    if (b.habitat === "vault") return 1;
    return a.habitat.localeCompare(b.habitat);
  });
}
