import type {
  NotificationItem,
  NotificationStatus,
} from "./notification-center-contract";

/**
 * Session-only status changes made from the notification center preview.
 *
 * The source projection remains immutable. These overrides are deliberately
 * kept outside the notification contract so a future native acknowledgement
 * bridge can replace this adapter without changing the renderer surface.
 */
export interface NotificationSessionOverride {
  readonly status: NotificationStatus;
  readonly readAt?: string | null;
  readonly snoozedUntil?: string | null;
}

export type NotificationSessionOverrides = Readonly<
  Record<string, NotificationSessionOverride>
>;

export const NOTIFICATION_SESSION_HISTORY_LIMIT = 20;
export const NOTIFICATION_SNOOZE_MINUTES = 15;

export function buildNotificationSessionOverride(
  status: NotificationStatus,
  changedAt: string,
  snoozedUntil?: string | null,
): NotificationSessionOverride {
  if (status === "unread") {
    return { status, readAt: null, snoozedUntil: null };
  }
  if (status === "read") {
    return { status, readAt: changedAt, snoozedUntil: null };
  }
  if (status === "snoozed") {
    return { status, readAt: null, snoozedUntil: snoozedUntil ?? null };
  }
  return { status, snoozedUntil: null };
}

function applyOverride(
  item: NotificationItem,
  override: NotificationSessionOverride,
): NotificationItem {
  const base = { ...item, status: override.status };
  if (override.status === "unread") {
    return { ...base, readAt: null, snoozedUntil: null };
  }
  if (override.status === "read") {
    return {
      ...base,
      readAt: override.readAt ?? item.readAt ?? null,
      snoozedUntil: null,
    };
  }
  if (override.status === "snoozed") {
    return {
      ...base,
      readAt: null,
      snoozedUntil: override.snoozedUntil ?? item.snoozedUntil ?? null,
    };
  }
  return {
    ...base,
    snoozedUntil: null,
    ...(override.readAt !== undefined ? { readAt: override.readAt } : {}),
  };
}

export function applyNotificationSessionOverrides(
  items: readonly NotificationItem[],
  overrides: NotificationSessionOverrides,
): NotificationItem[] {
  return items.map((item) => {
    const override = overrides[item.id];
    return override ? applyOverride(item, override) : item;
  });
}

export function buildSnoozedUntil(changedAt: string): string {
  const timestamp = Date.parse(changedAt);
  if (!Number.isFinite(timestamp)) return changedAt;
  return new Date(timestamp + NOTIFICATION_SNOOZE_MINUTES * 60_000).toISOString();
}

export function patchNotificationSessionOverrides(
  current: NotificationSessionOverrides,
  items: readonly NotificationItem[],
  status: NotificationStatus,
  changedAt: string,
): NotificationSessionOverrides {
  const next: Record<string, NotificationSessionOverride> = { ...current };
  const snoozedUntil = status === "snoozed" ? buildSnoozedUntil(changedAt) : undefined;
  for (const item of items) {
    next[item.id] = buildNotificationSessionOverride(status, changedAt, snoozedUntil);
  }
  return next;
}

export function clearNotificationSessionOverrides(
  current: NotificationSessionOverrides,
  ids: readonly string[],
): NotificationSessionOverrides {
  if (ids.length === 0) return current;
  const next: Record<string, NotificationSessionOverride> = { ...current };
  for (const id of ids) delete next[id];
  return next;
}

