import type { MessageType, PrivacyTier } from "./contracts";

export const HUMAN_ADDRESS = "user@vault";

export function normalizeAddress(raw: string, kind: "to" | "from"): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return kind === "from" ? HUMAN_ADDRESS : "@vault";
  if (kind === "from" && trimmed === "user") return HUMAN_ADDRESS;
  if (trimmed.includes("@")) return trimmed;
  return `${trimmed}@vault`;
}

export function extractHabitat(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1 || at === address.length - 1) return "vault";
  return address.slice(at + 1);
}

export function normalizePrivacy(value?: string): PrivacyTier {
  return value?.trim().toLowerCase() === "shared" ? "shared" : "local";
}

export function normalizeMessageType(value?: string): MessageType {
  switch (value?.trim().toLowerCase()) {
    case "request":
    case "response":
    case "error":
      return value.trim().toLowerCase() as MessageType;
    default:
      return "message";
  }
}

export function normalizeReplyTo(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function normalizeSubject(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "Message";
  return compact.slice(0, 120);
}
