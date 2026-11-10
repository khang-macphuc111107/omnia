import type { NotificationFilter } from "./notification-center-contract";
import type { NotificationChannelFilter } from "./notification-center-channels";
import type {
  NotificationTriageLane,
  NotificationTriageQuery,
  NotificationTriageSort,
} from "./notification-center-triage";

/**
 * A complete renderer-local notification queue view.
 *
 * The snapshot deliberately contains only view state. It is not a delivery
 * rule, scheduler, permission grant, or durable notification acknowledgement.
 */
export interface NotificationTriageViewState {
  readonly filter: NotificationFilter;
  readonly query: string;
  readonly lane: NotificationTriageLane;
  readonly source: string;
  readonly sort: NotificationTriageSort;
  readonly channelFilter: NotificationChannelFilter;
}

export interface NotificationTriageSavedView {
  readonly id: string;
  readonly name: string;
  readonly state: NotificationTriageViewState;
  readonly savedAt: string;
}

export interface NotificationTriageViewDefaults {
  readonly filter: NotificationFilter;
  readonly query: string;
  readonly lane: NotificationTriageLane;
  readonly source: string;
  readonly sort: NotificationTriageSort;
  readonly channelFilter: NotificationChannelFilter;
}

export const NOTIFICATION_TRIAGE_VIEW_HISTORY_LIMIT = 12;
export const DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE: NotificationTriageViewState = {
  filter: "all",
  query: "",
  lane: "all",
  source: "all",
  sort: "priority",
  channelFilter: "all",
};

const FILTER_VALUES: readonly NotificationFilter[] = [
  "all",
  "unread",
  "snoozed",
  "dismissed",
  "attention",
  "failures",
  "completions",
  "indexing",
  "approvals",
];

const LANE_VALUES: readonly NotificationTriageLane[] = [
  "all",
  "needs-input",
  "urgent",
  "failures",
  "quiet",
];

const SORT_VALUES: readonly NotificationTriageSort[] = [
  "priority",
  "newest",
  "oldest",
  "source",
  "title",
];

const CHANNEL_VALUES: readonly NotificationChannelFilter[] = [
  "all",
  "in-app",
  "toast",
  "screen-reader",
  "background",
];

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function safeText(value: unknown, fallback: string, maxLength = 120): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim().slice(0, maxLength);
  return text || fallback;
}

export function normalizeNotificationTriageViewState(
  input?: Partial<NotificationTriageViewState> | null,
): NotificationTriageViewState {
  const source = input ?? {};
  return {
    filter: enumValue(source.filter, FILTER_VALUES, DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE.filter),
    query: safeText(source.query, "", 240),
    lane: enumValue(source.lane, LANE_VALUES, DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE.lane),
    source: safeText(source.source, DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE.source, 160),
    sort: enumValue(source.sort, SORT_VALUES, DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE.sort),
    channelFilter: enumValue(source.channelFilter, CHANNEL_VALUES, DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE.channelFilter),
  };
}

export function notificationTriageViewStateToQuery(
  state: NotificationTriageViewState,
): NotificationTriageQuery {
  return {
    lane: state.lane,
    source: state.source,
    sort: state.sort,
  };
}

export function normalizeNotificationTriageViewName(value: unknown, fallback = "Untitled triage view", maxLength = 80): string {
  return safeText(value, fallback, maxLength);
}

export function nextNotificationTriageViewId(
  views: readonly NotificationTriageSavedView[],
  prefix = "triage-view",
): string {
  const used = new Set(views.map((view) => view.id));
  let index = views.length + 1;
  let candidate = `${prefix}-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}

export function createNotificationTriageSavedView(input: {
  readonly id?: string;
  readonly name?: string;
  readonly state?: Partial<NotificationTriageViewState> | null;
  readonly savedAt?: string;
}): NotificationTriageSavedView {
  return {
    id: normalizeNotificationTriageViewName(input.id, "triage-view-1", 160),
    name: normalizeNotificationTriageViewName(input.name),
    state: normalizeNotificationTriageViewState(input.state),
    savedAt: safeText(input.savedAt, new Date().toISOString(), 80),
  };
}

export function updateNotificationTriageSavedView(
  view: NotificationTriageSavedView,
  patch: Partial<Pick<NotificationTriageSavedView, "name" | "savedAt">> & {
    readonly state?: Partial<NotificationTriageViewState> | null;
  },
): NotificationTriageSavedView {
  return {
    ...view,
    ...(patch.name !== undefined ? { name: normalizeNotificationTriageViewName(patch.name, view.name) } : {}),
    ...(patch.savedAt !== undefined ? { savedAt: safeText(patch.savedAt, view.savedAt, 80) } : {}),
    ...(patch.state !== undefined ? { state: normalizeNotificationTriageViewState({ ...view.state, ...patch.state }) } : {}),
  };
}

export function trimNotificationTriageSavedViews(
  views: readonly NotificationTriageSavedView[],
): NotificationTriageSavedView[] {
  return views.slice(-NOTIFICATION_TRIAGE_VIEW_HISTORY_LIMIT);
}
