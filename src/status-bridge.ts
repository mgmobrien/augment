export type StatusBridgeSessionInput = {
  name: string;
  status: string;
  lastActivityMs: number;
};

export type StatusBridgeSessionSummary = StatusBridgeSessionInput & {
  statusLabel: string;
};

export type StatusBridgeSnapshot = {
  label: string;
  activeSessionCount: number;
  recentSessions: StatusBridgeSessionSummary[];
};

const ACTIVE_SESSION_LIMIT = 5;
const INACTIVE_SESSION_STATUSES = new Set(["crashed", "exited"]);

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  tool: "Tool",
  waiting: "Waiting",
  running: "Running",
  shell: "Shell",
  idle: "Idle",
  crashed: "Crashed",
  exited: "Exited",
};

function normalizeSessionName(rawName: string): string {
  const trimmed = rawName.trim();
  return trimmed || "Terminal";
}

function normalizeStatus(rawStatus: string): string {
  const trimmed = rawStatus.trim().toLowerCase();
  return trimmed || "shell";
}

function normalizeLastActivityMs(rawLastActivityMs: number): number {
  return Number.isFinite(rawLastActivityMs) ? rawLastActivityMs : 0;
}

export function isStatusBridgeSessionActive(status: string): boolean {
  return !INACTIVE_SESSION_STATUSES.has(normalizeStatus(status));
}

export function formatStatusBridgeStatusLabel(status: string): string {
  const normalized = normalizeStatus(status);
  return STATUS_LABELS[normalized] ?? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}

export function summarizeStatusBridgeSessions(
  sessions: StatusBridgeSessionInput[]
): StatusBridgeSnapshot {
  const activeSessions = sessions
    .map((session) => ({
      name: normalizeSessionName(session.name),
      status: normalizeStatus(session.status),
      lastActivityMs: normalizeLastActivityMs(session.lastActivityMs),
    }))
    .filter((session) => isStatusBridgeSessionActive(session.status))
    .sort((left, right) => {
      if (left.lastActivityMs !== right.lastActivityMs) {
        return right.lastActivityMs - left.lastActivityMs;
      }
      return left.name.localeCompare(right.name);
    });

  const activeSessionCount = activeSessions.length;

  return {
    label: activeSessionCount > 0 ? `Augment · ${activeSessionCount} active` : "Augment",
    activeSessionCount,
    recentSessions: activeSessions.slice(0, ACTIVE_SESSION_LIMIT).map((session) => ({
      ...session,
      statusLabel: formatStatusBridgeStatusLabel(session.status),
    })),
  };
}
