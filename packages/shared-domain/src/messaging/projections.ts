import { HUMAN_ADDRESS, normalizeAddress, normalizeReplyTo } from "./address";
import { decodeSourceNoteBody } from "./document";
import type {
  BusIndex,
  IndexedEventRecord,
  LifecycleViolation,
  IndexedMessageRecord,
  InboxMessage,
  InboxThreadSummary,
} from "./contracts";

const EVENT_PRECEDENCE = {
  delivered: 0,
  read: 1,
  acked: 2,
} as const;

export function eventKey(msgId: string, actor: string): string {
  return `${msgId}::${actor}`;
}

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMessages<MessageRecord extends IndexedMessageRecord>(messages: MessageRecord[]): MessageRecord[] {
  return messages.sort((a, b) => {
    const createdCompare = a.createdAt.localeCompare(b.createdAt);
    return createdCompare !== 0 ? createdCompare : a.msgId.localeCompare(b.msgId);
  });
}

function sortEvents(events: Iterable<IndexedEventRecord>): IndexedEventRecord[] {
  return [...events].sort((a, b) => {
    const keyCompare = eventKey(a.msgId, a.actor).localeCompare(eventKey(b.msgId, b.actor));
    if (keyCompare !== 0) return keyCompare;

    const createdCompare = a.createdAt.localeCompare(b.createdAt);
    if (createdCompare !== 0) return createdCompare;

    const typeCompare = EVENT_PRECEDENCE[a.eventType] - EVENT_PRECEDENCE[b.eventType];
    return typeCompare !== 0 ? typeCompare : a.filePath.localeCompare(b.filePath);
  });
}

function recordLifecycleViolation<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  event: IndexedEventRecord,
  reason: LifecycleViolation["reason"]
): void {
  index.lifecycleViolations.push({
    failClass: "invalid-event-lifecycle",
    reason,
    key: eventKey(event.msgId, event.actor),
    msgId: event.msgId,
    actor: event.actor,
    eventType: event.eventType,
    filePath: event.filePath,
  });
}

function insertUnreadMessage<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  message: MessageRecord
): void {
  if (index.readKeys.has(eventKey(message.msgId, message.to))) return;
  const unread = index.unreadByActor.get(message.to) ?? [];
  unread.push(message);
  sortMessages(unread);
  index.unreadByActor.set(message.to, unread);
  index.unreadCounts.set(message.to, (index.unreadCounts.get(message.to) ?? 0) + 1);
}

function removeUnreadMessage<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  msgId: string,
  actor: string
): void {
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

function applyEventRecord<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  event: IndexedEventRecord
): void {
  const key = eventKey(event.msgId, event.actor);

  if (event.eventType === "delivered") {
    index.deliveredKeys.add(key);
    return;
  }

  if (event.eventType === "read") {
    if (!index.deliveredKeys.has(key)) {
      recordLifecycleViolation(index, event, "read-without-delivered");
      return;
    }

    index.deliveredKeys.add(key);
    if (index.readKeys.has(key)) return;
    index.readKeys.add(key);
    removeUnreadMessage(index, event.msgId, event.actor);
    return;
  }

  if (!index.readKeys.has(key)) {
    recordLifecycleViolation(index, event, "acked-without-read");
    return;
  }

  index.deliveredKeys.add(key);
  index.readKeys.add(key);
}

function buildThreadSummary<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  threadId: string,
  messages: MessageRecord[],
  options: {
    primaryAddress?: string;
    unreadActors: Set<string>;
  }
): InboxThreadSummary | null {
  if (messages.length === 0) return null;

  const ordered = sortMessages([...messages]);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const participants = new Set<string>();

  for (const message of ordered) {
    participants.add(message.from);
    participants.add(message.to);
  }

  const participantList = [...participants];
  const primaryAddress = options.primaryAddress;
  const counterparty =
    primaryAddress
      ? participantList.find((address) => address !== primaryAddress) ?? last.from
      : last.from;

  return {
    threadId,
    subject: first.subject || last.subject || "Message",
    lastSender: last.from,
    lastTo: last.to,
    counterparty,
    participants: participantList,
    humanInvolved: participantList.includes(HUMAN_ADDRESS),
    lastActivityAt: last.createdAt,
    lastActivityAge: Math.max(0, Date.now() - parseTimestampMs(last.createdAt)),
    messageCount: ordered.length,
    hasUnread: ordered.some(
      (message) =>
        options.unreadActors.has(message.to) &&
        !index.readKeys.has(eventKey(message.msgId, message.to))
    ),
  };
}

function sortThreadSummaries(threads: InboxThreadSummary[]): InboxThreadSummary[] {
  return threads.sort((a, b) => {
    const activityCompare = parseTimestampMs(b.lastActivityAt) - parseTimestampMs(a.lastActivityAt);
    return activityCompare !== 0 ? activityCompare : a.threadId.localeCompare(b.threadId);
  });
}

function buildThreadList<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  options: {
    primaryAddress?: string;
    unreadActors?: Iterable<string>;
    includeMessage?: (message: MessageRecord) => boolean;
    includeThread?: (messages: MessageRecord[]) => boolean;
  }
): InboxThreadSummary[] {
  const primaryAddress = options.primaryAddress
    ? normalizeAddress(options.primaryAddress, "to")
    : undefined;
  const unreadActors = new Set(
    [...(options.unreadActors ?? (primaryAddress ? [primaryAddress] : []))].map((address) =>
      normalizeAddress(address, "to")
    )
  );
  const messagesByThread = new Map<string, MessageRecord[]>();

  for (const message of listIndexedMessages(index)) {
    const threadMessages = messagesByThread.get(message.threadId);
    if (threadMessages) {
      threadMessages.push(message);
      continue;
    }

    messagesByThread.set(message.threadId, [message]);
  }

  const summaries: InboxThreadSummary[] = [];
  for (const [threadId, messages] of messagesByThread) {
    const includeThread = options.includeThread
      ? options.includeThread(messages)
      : messages.some((message) => options.includeMessage?.(message) ?? true);
    if (!includeThread) continue;

    const summary = buildThreadSummary(index, threadId, messages, {
      primaryAddress,
      unreadActors,
    });
    if (summary) summaries.push(summary);
  }

  return sortThreadSummaries(summaries);
}

export function buildBusIndex<MessageRecord extends IndexedMessageRecord>(input: {
  messages: Iterable<MessageRecord>;
  events: Iterable<IndexedEventRecord>;
}): BusIndex<MessageRecord> {
  const messagesById = new Map<string, MessageRecord>();
  const unreadByActor = new Map<string, MessageRecord[]>();
  const unreadCounts = new Map<string, number>();
  const deliveredKeys = new Set<string>();
  const readKeys = new Set<string>();
  const lifecycleViolations: LifecycleViolation[] = [];

  for (const message of input.messages) {
    messagesById.set(message.msgId, message);
  }

  const index: BusIndex<MessageRecord> = {
    messagesById,
    unreadByActor,
    unreadCounts,
    deliveredKeys,
    readKeys,
    lifecycleViolations,
  };

  for (const event of sortEvents(input.events)) {
    applyEventRecord(index, event);
  }

  for (const message of messagesById.values()) {
    insertUnreadMessage(index, message);
  }

  return index;
}

export function recordMessageWrite<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  message: MessageRecord
): void {
  index.messagesById.set(message.msgId, message);
  insertUnreadMessage(index, message);
}

export function recordEventWrite<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  event: IndexedEventRecord
): void {
  applyEventRecord(index, event);
}

export function listIndexedMessages<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>
): MessageRecord[] {
  return sortMessages([...index.messagesById.values()]);
}

export function listUnreadMessages<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  actor: string
): MessageRecord[] {
  const normalizedActor = normalizeAddress(actor, "to");
  return sortMessages([...(index.unreadByActor.get(normalizedActor) ?? [])]);
}

export function getIndexedThreadMessages<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  threadId: string
): MessageRecord[] {
  const normalized = normalizeReplyTo(threadId);
  return listIndexedMessages(index).filter((message) => message.threadId === normalized);
}

export function toInboxMessage(message: IndexedMessageRecord, rawBody: string): InboxMessage {
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

export function listPartThreadsFromIndex<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  address: string
): InboxThreadSummary[] {
  const normalized = normalizeAddress(address, "to");
  return buildThreadList(index, {
    primaryAddress: normalized,
    unreadActors: [normalized],
    includeMessage: (message) => message.from === normalized || message.to === normalized,
  });
}

export function listAllThreadsFromIndex<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  addresses: Iterable<string>
): InboxThreadSummary[] {
  const visibleAddresses = new Set(
    [...addresses].map((address) => normalizeAddress(address, "to"))
  );
  if (visibleAddresses.size === 0) return [];

  return buildThreadList(index, {
    unreadActors: visibleAddresses,
    includeThread: (messages) =>
      messages.every(
        (message) => visibleAddresses.has(message.from) && visibleAddresses.has(message.to)
      ),
  });
}

export function listHumanThreadsFromIndex<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>
): InboxThreadSummary[] {
  return buildThreadList(index, {
    primaryAddress: HUMAN_ADDRESS,
    unreadActors: [HUMAN_ADDRESS],
    includeThread: (messages) =>
      messages.some((message) => message.from === HUMAN_ADDRESS || message.to === HUMAN_ADDRESS),
  });
}

export function unreadCountForActor<MessageRecord extends IndexedMessageRecord>(
  index: BusIndex<MessageRecord>,
  actor: string
): number {
  return index.unreadCounts.get(normalizeAddress(actor, "to")) ?? 0;
}
