import type { EventType, PrivacyTier } from "./contracts";

export const BUS_ROOT = "agents/bus";
export const SIGNALS_ROOT = `${BUS_ROOT}/derived/signals`;

export function normalizeVaultPath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/$/, "");
}

export function canonicalTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

export function filenameTimestamp(timestamp: string): string {
  return timestamp.replace(/:/g, "");
}

export function messageFolderPath(privacy: PrivacyTier, createdAt: string): string {
  return normalizeVaultPath(
    `${BUS_ROOT}/${privacy}/messages/${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}`
  );
}

export function eventFolderPath(privacy: PrivacyTier, createdAt: string): string {
  return normalizeVaultPath(
    `${BUS_ROOT}/${privacy}/events/${createdAt.slice(0, 4)}/${createdAt.slice(5, 7)}`
  );
}

export function messageFilePath(privacy: PrivacyTier, createdAt: string, msgId: string): string {
  return normalizeVaultPath(
    `${messageFolderPath(privacy, createdAt)}/${filenameTimestamp(createdAt)}__${msgId}.md`
  );
}

export function eventFilePath(
  privacy: PrivacyTier,
  createdAt: string,
  eventType: EventType,
  msgId: string,
  eventId: string
): string {
  return normalizeVaultPath(
    `${eventFolderPath(privacy, createdAt)}/${filenameTimestamp(createdAt)}__${eventType}__${msgId}__${eventId}.md`
  );
}

export function signalSlug(address: string): string {
  return address.replace(/@/g, "_at_");
}

export function signalFilePath(address: string): string {
  return normalizeVaultPath(`${SIGNALS_ROOT}/${signalSlug(address)}.json`);
}
