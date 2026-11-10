import type { NotificationItem } from "./notification-center-contract";

/**
 * Renderer-only lanes for the notification triage cockpit.
 *
 * The existing notification contract owns lifecycle state and broad kind
 * filters. These lanes are deliberately a view concern so native delivery,
 * durable acknowledgement, and provider scheduling remain out of scope.
 */
export type NotificationTriageLane =
  | "all"
  | "needs-input"
  | "urgent"
  | "failures"
  | "quiet";

export type NotificationTriageSort =
  | "priority"
  | "newest"
  | "oldest"
  | "source"
  | "title";

export interface NotificationTriageQuery {
  readonly lane: NotificationTriageLane;
  readonly source: string;
  readonly sort: NotificationTriageSort;
}

export const ALL_NOTIFICATION_TRIAGE_SOURCES = "all" as const;

const PRIORITY_RANK: Record<NotificationItem["priority"], number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const TRIAGE_LANE_VALUES: readonly NotificationTriageLane[] = [
  "all",
  "needs-input",
  "urgent",
  "failures",
  "quiet",
];

const TRIAGE_SORT_VALUES: readonly NotificationTriageSort[] = [
  "priority",
  "newest",
  "oldest",
  "source",
  "title",
];

export const NOTIFICATION_TRIAGE_LANE_LABELS: Record<NotificationTriageLane, string> = {
  all: "All triage",
  "needs-input": "Needs input",
  urgent: "Urgent & high",
  failures: "Failures",
  quiet: "Quiet / resolved",
};

export const NOTIFICATION_TRIAGE_SORT_LABELS: Record<NotificationTriageSort, string> = {
  priority: "Priority first",
  newest: "Newest first",
  oldest: "Oldest first",
  source: "Source A–Z",
  title: "Title A–Z",
};

function occurredAtMs(item: NotificationItem): number {
  const timestamp = Date.parse(item.occurredAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Stable source key used by the dynamic source selector. */
export function notificationTriageSourceKey(item: NotificationItem): string {
  return item.sourceType?.trim() || item.sourceLabel.trim() || "unknown";
}

/** Returns deterministic source options from the current renderer projection. */
export function listNotificationTriageSources(items: readonly NotificationItem[]): string[] {
  return Array.from(new Set(items.map(notificationTriageSourceKey))).sort((left, right) => left.localeCompare(right));
}

export function notificationTriageLaneMatches(
  item: NotificationItem,
  lane: NotificationTriageLane,
): boolean {
  switch (lane) {
    case "needs-input":
      return item.requiresInput;
    case "urgent":
      return item.priority === "urgent" || item.priority === "high";
    case "failures":
      return item.kind === "failure";
    case "quiet":
      return !item.requiresInput && item.status !== "unread" && item.kind !== "failure";
    case "all":
    default:
      return true;
  }
}

export function filterNotificationTriageItems(
  items: readonly NotificationItem[],
  query: Pick<NotificationTriageQuery, "lane" | "source">,
): NotificationItem[] {
  return items.filter((item) => (
    notificationTriageLaneMatches(item, query.lane) &&
    (query.source === ALL_NOTIFICATION_TRIAGE_SOURCES || notificationTriageSourceKey(item) === query.source)
  ));
}

export function sortNotificationTriageItems(
  items: readonly NotificationItem[],
  sort: NotificationTriageSort,
): NotificationItem[] {
  return [...items].sort((left, right) => {
    if (sort === "priority") {
      const priorityDelta = PRIORITY_RANK[right.priority] - PRIORITY_RANK[left.priority];
      if (priorityDelta !== 0) return priorityDelta;
      const inputDelta = Number(right.requiresInput) - Number(left.requiresInput);
      if (inputDelta !== 0) return inputDelta;
      const dateDelta = occurredAtMs(right) - occurredAtMs(left);
      if (dateDelta !== 0) return dateDelta;
    } else if (sort === "newest") {
      const dateDelta = occurredAtMs(right) - occurredAtMs(left);
      if (dateDelta !== 0) return dateDelta;
    } else if (sort === "oldest") {
      const dateDelta = occurredAtMs(left) - occurredAtMs(right);
      if (dateDelta !== 0) return dateDelta;
    } else if (sort === "source") {
      const sourceDelta = notificationTriageSourceKey(left).localeCompare(notificationTriageSourceKey(right));
      if (sourceDelta !== 0) return sourceDelta;
    } else if (sort === "title") {
      const titleDelta = left.title.localeCompare(right.title);
      if (titleDelta !== 0) return titleDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

export function buildNotificationTriageView(
  items: readonly NotificationItem[],
  query: NotificationTriageQuery,
): NotificationItem[] {
  return sortNotificationTriageItems(filterNotificationTriageItems(items, query), query.sort);
}

export function isNotificationTriageLane(value: string): value is NotificationTriageLane {
  return TRIAGE_LANE_VALUES.includes(value as NotificationTriageLane);
}

export function isNotificationTriageSort(value: string): value is NotificationTriageSort {
  return TRIAGE_SORT_VALUES.includes(value as NotificationTriageSort);
}

