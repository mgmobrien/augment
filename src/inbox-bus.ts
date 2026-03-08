import { App, TFile, TFolder } from "obsidian";
import { normalizePath } from "obsidian";

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
  to: string;       // part name, e.g. "stack"
  from: string;     // sender, e.g. "user", "stack@vault"
  subject: string;
  body: string;
  threadId?: string;
  msgType?: string;
  replyTo?: string;
  habitat?: string;
  privacy?: string;
  sourceNote?: string;  // note title where message was composed
}

// Vault-level part inbox root: agents/parts/{name}/inbox/
function inboxPath(partName: string): string {
  return normalizePath(`agents/parts/${partName}/inbox`);
}

function readPath(partName: string): string {
  return normalizePath(`agents/parts/${partName}/inbox/read`);
}

function generateMsgId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Write a message file to a vault part's inbox. */
export async function writeMessage(
  app: App,
  opts: WriteMessageOptions
): Promise<string> {
  const {
    to,
    from,
    subject,
    body,
    threadId = "",
    msgType = "message",
    replyTo = "",
    habitat = "vault",
    privacy = "local",
    sourceNote = "",
  } = opts;

  const inbox = inboxPath(to);

  // Ensure inbox dir exists
  if (!app.vault.getAbstractFileByPath(inbox)) {
    await app.vault.createFolder(inbox);
  }
  const readDir = readPath(to);
  if (!app.vault.getAbstractFileByPath(readDir)) {
    await app.vault.createFolder(readDir);
  }

  const msgId = generateMsgId();
  const now = isoNow();
  // Filename: YYYY-MM-DDTHHMM-{msgId}.md (URL-safe, sortable)
  const datePart = now.slice(0, 16).replace(":", "").replace("T", "T");
  const filename = `${datePart}-${msgId}.md`;
  const filePath = normalizePath(`${inbox}/${filename}`);

  const content = [
    "---",
    `msg_id: ${msgId}`,
    `thread_id: ${threadId}`,
    `from: ${from}`,
    `to: ${to}@vault`,
    `msg_type: ${msgType}`,
    `subject: ${subject}`,
    `reply_to: ${replyTo}`,
    `created_at: ${now}`,
    `habitat: ${habitat}`,
    `privacy: ${privacy}`,
    `source_note: ${sourceNote}`,
    "---",
    "",
    body,
  ].join("\n");

  await app.vault.create(filePath, content);
  return filePath;
}

/** Read all unread messages for a part. Does NOT acknowledge (move) them. */
export async function readInbox(
  app: App,
  partName: string
): Promise<InboxMessage[]> {
  const inbox = inboxPath(partName);
  const folder = app.vault.getAbstractFileByPath(inbox);
  if (!(folder instanceof TFolder)) return [];

  const messages: InboxMessage[] = [];
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    // Skip files in read/ subdirectory (they appear as TFolder children)
    if (child.path.includes("/read/")) continue;

    try {
      const raw = await app.vault.cachedRead(child);
      const msg = parseMessage(raw, child.path);
      if (msg) messages.push(msg);
    } catch {
      // skip unreadable files
    }
  }

  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Read and acknowledge unread messages — moves them to inbox/read/. */
export async function readAndAcknowledgeInbox(
  app: App,
  partName: string
): Promise<InboxMessage[]> {
  const messages = await readInbox(app, partName);
  if (messages.length === 0) return [];

  const readDir = readPath(partName);
  if (!app.vault.getAbstractFileByPath(readDir)) {
    await app.vault.createFolder(readDir);
  }

  for (const msg of messages) {
    const file = app.vault.getAbstractFileByPath(msg.filePath);
    if (!(file instanceof TFile)) continue;
    const destPath = normalizePath(`${readDir}/${file.name}`);
    try {
      // Copy content to read/ then delete original (Obsidian has no move API
      // that preserves links; for inbox files links don't matter).
      const content = await app.vault.read(file);
      await app.vault.create(destPath, content);
      await app.vault.delete(file);
    } catch {
      // If dest already exists (duplicate), just delete source
      try { await app.vault.delete(file); } catch { /* ignore */ }
    }
  }

  return messages;
}

/** Count unread messages for a part (cheap filesystem check). */
export function unreadCount(app: App, partName: string): number {
  const inbox = inboxPath(partName);
  const folder = app.vault.getAbstractFileByPath(inbox);
  if (!(folder instanceof TFolder)) return 0;
  return folder.children.filter(
    (c): c is TFile =>
      c instanceof TFile &&
      c.extension === "md" &&
      !c.path.includes("/read/")
  ).length;
}

/** Discover all vault parts that have inbox directories. */
export function discoverVaultParts(app: App): string[] {
  const partsFolder = app.vault.getAbstractFileByPath("agents/parts");
  if (!(partsFolder instanceof TFolder)) return [];
  return partsFolder.children
    .filter((c): c is TFolder => c instanceof TFolder)
    .filter((f) => app.vault.getAbstractFileByPath(`${f.path}/inbox`) instanceof TFolder)
    .map((f) => f.name)
    .sort();
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseMessage(raw: string, filePath: string): InboxMessage | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const body = raw.slice(fmMatch[0].length).trim();

  const get = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };

  return {
    msgId: get("msg_id"),
    threadId: get("thread_id"),
    from: get("from"),
    to: get("to"),
    msgType: get("msg_type") || "message",
    subject: get("subject"),
    replyTo: get("reply_to"),
    createdAt: get("created_at"),
    habitat: get("habitat") || "vault",
    privacy: get("privacy") || "local",
    sourceNote: get("source_note"),
    body,
    filePath,
  };
}
