import {
  extractHabitat,
  normalizeAddress,
  normalizeMessageType,
  normalizePrivacy,
  normalizeReplyTo,
} from "./address";
import type { EventType, IndexedEventRecord, IndexedMessageRecord, PrivacyTier } from "./contracts";

const SOURCE_NOTE_PREFIX = "<!-- source_note:";
const SOURCE_NOTE_SUFFIX = "-->";

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function encodeSourceNoteBody(sourceNote: string, body: string): string {
  const trimmedNote = sourceNote.trim();
  if (!trimmedNote) return body;
  const escapedNote = trimmedNote.replace(/-->/g, "-- >");
  const prefix = `${SOURCE_NOTE_PREFIX} ${escapedNote} ${SOURCE_NOTE_SUFFIX}`;
  return body ? `${prefix}\n\n${body}` : prefix;
}

export function decodeSourceNoteBody(rawBody: string): { sourceNote: string; body: string } {
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

export function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? raw.slice(match[0].length) : raw;
}

function parseFrontmatterScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

export function parseRawFrontmatter(raw: string): Record<string, unknown> | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return null;

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    frontmatter[key] = parseFrontmatterScalar(line.slice(separator + 1));
  }

  return Object.keys(frontmatter).length > 0 ? frontmatter : null;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function parseIndexedMessageRecord(
  frontmatter: Record<string, unknown> | null,
  filePath: string,
  privacy: PrivacyTier
): IndexedMessageRecord | null {
  if (!frontmatter) return null;

  const msgId = asString(frontmatter.msg_id).toLowerCase();
  const from = normalizeAddress(asString(frontmatter.from), "from");
  const to = normalizeAddress(asString(frontmatter.to), "to");
  if (!msgId || !to) return null;

  const replyTo = normalizeReplyTo(asString(frontmatter.reply_to));

  return {
    filePath,
    msgId,
    threadId: asString(frontmatter.thread_id) || msgId,
    from,
    to,
    msgType: normalizeMessageType(asString(frontmatter.msg_type)),
    subject: asString(frontmatter.subject) || "Message",
    replyTo,
    createdAt: asString(frontmatter.created_at),
    habitat: extractHabitat(from),
    privacy: normalizePrivacy(asString(frontmatter.privacy) || privacy),
    sourceNote: asString(frontmatter.source_note),
  };
}

export function parseIndexedEventRecord(
  frontmatter: Record<string, unknown> | null,
  filePath: string,
  privacy: PrivacyTier
): IndexedEventRecord | null {
  if (!frontmatter) return null;

  const eventType = asString(frontmatter.event_type) as EventType;
  if (eventType !== "delivered" && eventType !== "read" && eventType !== "acked") {
    return null;
  }

  const msgId = asString(frontmatter.msg_id).toLowerCase();
  const actor = normalizeAddress(asString(frontmatter.actor), "to");
  if (!msgId || !actor) return null;

  return {
    filePath,
    msgId,
    threadId: asString(frontmatter.thread_id),
    eventType,
    actor,
    privacy: normalizePrivacy(asString(frontmatter.privacy) || privacy),
    createdAt: asString(frontmatter.created_at),
  };
}

export function buildMessageFrontmatter(message: IndexedMessageRecord): string {
  const lines = [
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
    "---",
  ];

  if (message.replyTo) {
    lines.splice(lines.length - 1, 0, `reply_to: ${message.replyTo}`);
  }

  return lines.join("\n");
}

export function buildEventFrontmatter(
  eventId: string,
  message: Pick<IndexedMessageRecord, "msgId" | "threadId">,
  eventType: EventType,
  actor: string,
  createdAt: string
): string {
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

export function buildSignalContent(
  message: Pick<IndexedMessageRecord, "to" | "msgId" | "threadId">,
  createdAt: string
): string {
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
