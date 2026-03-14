import * as fs from "fs";
import * as path from "path";
import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import {
  BUS_ROOT,
  HUMAN_ADDRESS,
  SIGNALS_ROOT,
  buildBusIndex as buildSharedBusIndex,
  canonicalTimestamp,
  eventKey,
  filenameTimestamp,
  getIndexedThreadMessages,
  listAllThreadsFromIndex,
  listHumanThreadsFromIndex,
  listPartThreadsFromIndex,
  listUnreadMessages,
  normalizeAddress,
  parseIndexedEventRecord,
  parseIndexedMessageRecord,
  parseRawFrontmatter,
  planEventWrite,
  planMessageWrite,
  recordEventWrite as recordEventWriteToIndex,
  recordMessageWrite as recordMessageWriteToIndex,
  stripFrontmatter,
  toInboxMessage,
  unreadCountForActor,
} from "../packages/shared-domain/src";
import type {
  BusIndex,
  IndexedEventRecord,
  IndexedMessageRecord,
  InboxMessage,
  InboxThreadSummary,
  PrivacyTier,
  WriteMessageOptions,
} from "../packages/shared-domain/src";

export { HUMAN_ADDRESS };
export type { InboxMessage, InboxThreadSummary, WriteMessageOptions };
export const DEFAULT_WATCHED_INBOX_ADDRESSES = [HUMAN_ADDRESS, "ceo@matt-stack"] as const;

const PARTS_ROOT = "agents/parts";

interface IndexedMessageFile extends IndexedMessageRecord {
  file: TFile;
}

interface CacheState {
  dirty: boolean;
  wired: boolean;
  index: BusIndex<IndexedMessageFile> | null;
  notify: (() => void) | null;
}

const cacheByApp = new WeakMap<App, CacheState>();

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
  const folder = app.vault.getAbstractFileByPath(normalizePath(`${BUS_ROOT}/${privacy}/${kind}`));
  return folder instanceof TFolder ? folder : null;
}

function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string; basePath?: string };
  return (
    (typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath) ?? ""
  ).trim();
}

function readFrontmatterFromDisk(app: App, file: TFile): Record<string, unknown> | null {
  const vaultBase = getVaultBasePath(app);
  if (!vaultBase) return null;

  try {
    const raw = fs.readFileSync(path.join(vaultBase, normalizePath(file.path)), "utf8");
    return parseRawFrontmatter(raw);
  } catch {
    return null;
  }
}

function fileCacheFrontmatter(app: App, file: TFile): Record<string, unknown> | null {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;
  if (frontmatter) {
    return frontmatter as Record<string, unknown>;
  }

  // Installed builds can hit this path before Obsidian resolves frontmatter.
  // Fall back to the raw bus file so aggregate thread discovery is not timing-dependent.
  return readFrontmatterFromDisk(app, file);
}

function toIndexedMessageFile(app: App, file: TFile, privacy: PrivacyTier): IndexedMessageFile | null {
  const record = parseIndexedMessageRecord(fileCacheFrontmatter(app, file), file.path, privacy);
  if (!record) return null;
  return { ...record, file };
}

function toIndexedEvent(app: App, file: TFile, privacy: PrivacyTier): IndexedEventRecord | null {
  return parseIndexedEventRecord(fileCacheFrontmatter(app, file), file.path, privacy);
}

function buildBusIndex(app: App): BusIndex<IndexedMessageFile> {
  const messages: IndexedMessageFile[] = [];
  const events: IndexedEventRecord[] = [];

  for (const privacy of ["local", "shared"] as PrivacyTier[]) {
    for (const file of collectMarkdownFiles(getBusFolder(app, privacy, "messages"))) {
      const message = toIndexedMessageFile(app, file, privacy);
      if (message) messages.push(message);
    }

    for (const file of collectMarkdownFiles(getBusFolder(app, privacy, "events"))) {
      const event = toIndexedEvent(app, file, privacy);
      if (event) events.push(event);
    }
  }

  return buildSharedBusIndex({ messages, events });
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

function isBusPath(filePath: string): boolean {
  return normalizePath(filePath).startsWith(`${BUS_ROOT}/`);
}

function wireCacheInvalidation(app: App, state: CacheState): void {
  if (state.wired) return;
  state.wired = true;

  const markDirty = (filePath?: string): void => {
    if (filePath && isBusPath(filePath)) {
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

function getBusIndex(app: App): BusIndex<IndexedMessageFile> {
  const state = getCacheState(app);
  if (!state.dirty && state.index) return state.index;
  const index = buildBusIndex(app);
  state.index = index;
  state.dirty = false;
  return index;
}

function recordMessageWrite(app: App, message: IndexedMessageFile): void {
  const state = getCacheState(app);
  if (!state.index) {
    state.index = buildBusIndex(app);
    state.dirty = false;
    return;
  }

  state.dirty = false;
  recordMessageWriteToIndex(state.index, message);
}

function recordEventWrite(app: App, event: IndexedEventRecord): void {
  const state = getCacheState(app);
  if (!state.index) {
    state.index = buildBusIndex(app);
    state.dirty = false;
    return;
  }

  state.dirty = false;
  recordEventWriteToIndex(state.index, event);
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

function legacyInboxFolderPath(address: string): string {
  const [partName, habitat] = address.split("@");
  if (habitat && habitat !== "vault") {
    return normalizePath(`${PARTS_ROOT}/${habitat}/${partName}/inbox`);
  }
  return normalizePath(`${PARTS_ROOT}/${partName}/inbox`);
}

function legacyInboxFilePath(address: string, createdAt: string, msgId: string): string {
  const shortId = msgId.slice(0, 8);
  return normalizePath(
    `${legacyInboxFolderPath(address)}/${filenameTimestamp(createdAt)}-${shortId}.md`
  );
}

async function readMessageBody(app: App, message: IndexedMessageRecord): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(normalizePath(message.filePath));
  if (!(file instanceof TFile)) return null;

  try {
    const raw = await app.vault.cachedRead(file);
    return stripFrontmatter(raw).trim();
  } catch {
    return null;
  }
}

async function writeEvent(
  app: App,
  message: IndexedMessageRecord,
  eventType: "delivered" | "read" | "acked",
  actor: string,
  createdAt: string
): Promise<void> {
  const plan = planEventWrite(message, eventType, actor, { createdAt });
  await ensureFolder(app, plan.folderPath);
  await app.vault.create(plan.filePath, plan.content);
  recordEventWrite(app, plan.record);
}

export async function writeMessage(app: App, opts: WriteMessageOptions): Promise<string> {
  const plan = planMessageWrite(opts);
  await ensureFolder(app, plan.folderPath);

  const file = await app.vault.create(plan.filePath, plan.content);
  recordMessageWrite(app, { ...plan.record, file });

  await ensureFolder(app, SIGNALS_ROOT);
  await app.vault.adapter.write(plan.signalPath, plan.signalContent);

  // Compatibility shim for legacy part inbox readers. Remove after migration to agents/bus/.
  const legacyInboxFolder = legacyInboxFolderPath(plan.record.to);
  await ensureFolder(app, legacyInboxFolder);
  await app.vault.create(
    legacyInboxFilePath(plan.record.to, plan.record.createdAt, plan.record.msgId),
    plan.content
  );

  return plan.filePath;
}

export async function readInbox(app: App, partName: string): Promise<InboxMessage[]> {
  const actor = normalizeAddress(partName, "to");
  const messages = listUnreadMessages(getBusIndex(app), actor);
  if (messages.length === 0) return [];

  const result: InboxMessage[] = [];
  for (const message of messages) {
    const body = await readMessageBody(app, message);
    if (body === null) continue;
    result.push(toInboxMessage(message, body));
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
  return listPartThreadsFromIndex(getBusIndex(app), address);
}

export function listAllThreads(app: App, addresses: Iterable<string>): InboxThreadSummary[] {
  return listAllThreadsFromIndex(getBusIndex(app), addresses);
}

export function listHumanThreads(app: App): InboxThreadSummary[] {
  return listHumanThreadsFromIndex(getBusIndex(app));
}

export const listHumanInboxThreads = listHumanThreads;

export async function getThread(app: App, threadId: string): Promise<InboxMessage[]> {
  const messages = getIndexedThreadMessages(getBusIndex(app), threadId);
  if (messages.length === 0) return [];

  const transcript: InboxMessage[] = [];
  for (const message of messages) {
    const body = await readMessageBody(app, message);
    if (body === null) continue;
    transcript.push(toInboxMessage(message, body));
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
  return unreadCountForActor(getBusIndex(app), partName);
}

export function unreadCountForAddresses(app: App, addresses: string[]): number {
  const index = getBusIndex(app);
  const normalized = Array.from(
    new Set(
      addresses
        .map((address) => normalizeAddress(address, "to"))
        .filter((address) => address.length > 0)
    )
  );

  return normalized.reduce(
    (total, address) => total + unreadCountForActor(index, address),
    0
  );
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
