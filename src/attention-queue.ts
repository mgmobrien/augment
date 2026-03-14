export type AttentionSessionInput<TId> = {
  id: TId;
  status: string;
  unreadActivity?: number;
  lastActivityMs?: number;
};

export type AttentionSessionSummary<TId> = {
  id: TId;
  status: string;
  unreadActivity: number;
  lastActivityMs: number;
  hasUnreadActivity: boolean;
  isWaiting: boolean;
};

export type AttentionSnapshot<TId> = {
  attentionCount: number;
  unreadSessionCount: number;
  waitingSessionCount: number;
  badgeText: string;
  ariaLabel: string;
  ordered: AttentionSessionSummary<TId>[];
};

function normalizeStatus(rawStatus: string): string {
  const trimmed = rawStatus.trim().toLowerCase();
  return trimmed || "shell";
}

function normalizeUnreadActivity(rawUnreadActivity: number | undefined): number {
  if (!Number.isFinite(rawUnreadActivity)) return 0;
  return Math.max(0, Math.floor(rawUnreadActivity as number));
}

function normalizeLastActivityMs(rawLastActivityMs: number | undefined): number {
  if (!Number.isFinite(rawLastActivityMs)) return 0;
  return Math.max(0, Math.floor(rawLastActivityMs as number));
}

function attentionSortValue(lastActivityMs: number): number {
  return lastActivityMs > 0 ? lastActivityMs : Number.MAX_SAFE_INTEGER;
}

export function summarizeAttentionSessions<TId>(
  sessions: AttentionSessionInput<TId>[]
): AttentionSnapshot<TId> {
  const ordered = sessions
    .map((session) => {
      const status = normalizeStatus(session.status);
      const unreadActivity = normalizeUnreadActivity(session.unreadActivity);
      const lastActivityMs = normalizeLastActivityMs(session.lastActivityMs);
      return {
        id: session.id,
        status,
        unreadActivity,
        lastActivityMs,
        hasUnreadActivity: unreadActivity > 0,
        isWaiting: status === "waiting",
      };
    })
    .filter((session) => session.hasUnreadActivity || session.isWaiting)
    .sort((left, right) => {
      if (left.hasUnreadActivity !== right.hasUnreadActivity) {
        return left.hasUnreadActivity ? -1 : 1;
      }
      if (left.unreadActivity !== right.unreadActivity) {
        return right.unreadActivity - left.unreadActivity;
      }
      if (left.isWaiting !== right.isWaiting) {
        return left.isWaiting ? -1 : 1;
      }

      const leftSortValue = attentionSortValue(left.lastActivityMs);
      const rightSortValue = attentionSortValue(right.lastActivityMs);
      if (leftSortValue !== rightSortValue) {
        return leftSortValue - rightSortValue;
      }

      return left.status.localeCompare(right.status);
    });

  const attentionCount = ordered.length;
  const unreadSessionCount = ordered.filter((session) => session.hasUnreadActivity).length;
  const waitingSessionCount = ordered.filter((session) => session.isWaiting).length;

  let ariaLabel = "No sessions need attention";
  if (attentionCount > 0) {
    const parts = [`${attentionCount} session${attentionCount !== 1 ? "s" : ""} need attention`];
    if (unreadSessionCount > 0) {
      parts.push(`${unreadSessionCount} with unread activity`);
    }
    if (waitingSessionCount > 0) {
      parts.push(`${waitingSessionCount} waiting for input`);
    }
    ariaLabel = parts.join("; ");
  }

  const badgeText =
    attentionCount === 0
      ? ""
      : unreadSessionCount > 0
        ? `⚡ ${attentionCount} · ${unreadSessionCount} unread`
        : `⚡ ${attentionCount}`;

  return {
    attentionCount,
    unreadSessionCount,
    waitingSessionCount,
    badgeText,
    ariaLabel,
    ordered,
  };
}
