export type PrivacyTier = "local" | "shared";
export type MessageType = "message" | "request" | "response" | "error";
export type EventType = "delivered" | "read" | "acked";

export interface InboxMessage {
  msgId: string;
  threadId: string;
  from: string;
  to: string;
  msgType: MessageType;
  subject: string;
  replyTo: string;
  createdAt: string;
  habitat: string;
  privacy: PrivacyTier;
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

export interface InboxThreadSummary {
  threadId: string;
  subject: string;
  lastSender: string;
  lastTo: string;
  counterparty: string;
  participants: string[];
  humanInvolved: boolean;
  lastActivityAt: string;
  lastActivityAge: number;
  messageCount: number;
  hasUnread: boolean;
}

export interface IndexedMessageRecord {
  filePath: string;
  msgId: string;
  threadId: string;
  from: string;
  to: string;
  msgType: MessageType;
  subject: string;
  replyTo: string;
  createdAt: string;
  habitat: string;
  privacy: PrivacyTier;
  sourceNote: string;
}

export interface IndexedEventRecord {
  filePath: string;
  msgId: string;
  threadId: string;
  eventType: EventType;
  actor: string;
  privacy: PrivacyTier;
  createdAt: string;
}

export interface LifecycleViolation {
  failClass: "invalid-event-lifecycle";
  reason: "read-without-delivered" | "acked-without-read";
  key: string;
  msgId: string;
  actor: string;
  eventType: EventType;
  filePath: string;
}

export interface BusIndex<MessageRecord extends IndexedMessageRecord = IndexedMessageRecord> {
  messagesById: Map<string, MessageRecord>;
  unreadByActor: Map<string, MessageRecord[]>;
  unreadCounts: Map<string, number>;
  deliveredKeys: Set<string>;
  readKeys: Set<string>;
  lifecycleViolations: LifecycleViolation[];
}

export interface MessageWritePlan {
  record: IndexedMessageRecord;
  folderPath: string;
  filePath: string;
  content: string;
  signalPath: string;
  signalContent: string;
}

export interface EventWritePlan {
  eventId: string;
  record: IndexedEventRecord;
  folderPath: string;
  filePath: string;
  content: string;
}
