import {
  extractHabitat,
  normalizeAddress,
  normalizeMessageType,
  normalizePrivacy,
  normalizeReplyTo,
  normalizeSubject,
} from "./address";
import {
  buildEventFrontmatter,
  buildMessageFrontmatter,
  buildSignalContent,
  encodeSourceNoteBody,
} from "./document";
import {
  canonicalTimestamp,
  eventFilePath,
  eventFolderPath,
  messageFilePath,
  messageFolderPath,
  signalFilePath,
} from "./layout";
import type {
  EventType,
  EventWritePlan,
  IndexedMessageRecord,
  MessageWritePlan,
  WriteMessageOptions,
} from "./contracts";

function randomUuid(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    throw new Error("crypto.randomUUID() is unavailable");
  }
  return uuid.toLowerCase();
}

export function planMessageWrite(
  opts: WriteMessageOptions,
  options: { createdAt?: string; msgId?: string } = {}
): MessageWritePlan {
  const to = normalizeAddress(opts.to, "to");
  const from = normalizeAddress(opts.from, "from");
  const msgId = (options.msgId ?? randomUuid()).toLowerCase();
  const replyTo = normalizeReplyTo(opts.replyTo);
  const threadId = (opts.threadId?.trim() || replyTo || msgId).toLowerCase();
  const createdAt = options.createdAt ?? canonicalTimestamp();
  const privacy = normalizePrivacy(opts.privacy);
  const record: IndexedMessageRecord = {
    filePath: messageFilePath(privacy, createdAt, msgId),
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

  const body = encodeSourceNoteBody(record.sourceNote, opts.body);
  return {
    record,
    folderPath: messageFolderPath(privacy, createdAt),
    filePath: record.filePath,
    content: `${buildMessageFrontmatter(record)}\n\n${body}`,
    signalPath: signalFilePath(record.to),
    signalContent: buildSignalContent(record, createdAt),
  };
}

export function planEventWrite(
  message: Pick<IndexedMessageRecord, "msgId" | "threadId" | "privacy">,
  eventType: EventType,
  actor: string,
  options: { createdAt?: string; eventId?: string } = {}
): EventWritePlan {
  const createdAt = options.createdAt ?? canonicalTimestamp();
  const eventId = (options.eventId ?? randomUuid()).toLowerCase();
  const normalizedActor = normalizeAddress(actor, "to");
  const filePath = eventFilePath(message.privacy, createdAt, eventType, message.msgId, eventId);

  return {
    eventId,
    record: {
      filePath,
      msgId: message.msgId,
      threadId: message.threadId,
      eventType,
      actor: normalizedActor,
      privacy: message.privacy,
      createdAt,
    },
    folderPath: eventFolderPath(message.privacy, createdAt),
    filePath,
    content: `${buildEventFrontmatter(
      eventId,
      { msgId: message.msgId, threadId: message.threadId },
      eventType,
      normalizedActor,
      createdAt
    )}\n`,
  };
}
