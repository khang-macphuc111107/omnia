import type { NotificationChannel, NotificationItem } from "./notification-center-contract";

export type NotificationChannelFilter = NotificationChannel | "all";

export type NotificationChannelPreferences = Readonly<Record<NotificationChannel, boolean>>;

export interface NotificationChannelImpact {
  readonly totalItems: number;
  readonly deliverableItems: number;
  readonly suppressedItems: number;
  readonly byChannel: Readonly<Record<NotificationChannel, {
    readonly availableItems: number;
    readonly enabled: boolean;
    readonly affectedItems: number;
  }>>;
}

export const NOTIFICATION_CHANNEL_VALUES: readonly NotificationChannel[] = [
  "in-app",
  "toast",
  "screen-reader",
  "background",
];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  "in-app": "In-app center",
  toast: "Toast preview",
  "screen-reader": "Screen reader",
  background: "Background route",
};

export const NOTIFICATION_CHANNEL_DESCRIPTIONS: Record<NotificationChannel, string> = {
  "in-app": "Keep the signal in Omnia's attention center.",
  toast: "Preview a compact transient alert surface.",
  "screen-reader": "Keep an accessible announcement route visible.",
  background: "Keep a background-work route available for later native wiring.",
};

export const DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES: NotificationChannelPreferences = {
  "in-app": true,
  toast: true,
  "screen-reader": true,
  background: true,
};

export function normalizeNotificationChannelPreferences(
  input?: Partial<NotificationChannelPreferences> | null,
): NotificationChannelPreferences {
  return {
    ...DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES,
    ...(input ?? {}),
  };
}

export function notificationChannelLabel(channel: NotificationChannel): string {
  return NOTIFICATION_CHANNEL_LABELS[channel];
}

export function notificationChannelEnabled(
  preferences: NotificationChannelPreferences,
  channel: NotificationChannel,
): boolean {
  return preferences[channel] === true;
}

export function notificationHasEnabledChannel(
  item: NotificationItem,
  preferences: NotificationChannelPreferences,
): boolean {
  return item.channels.some((channel) => notificationChannelEnabled(preferences, channel));
}

export function notificationChannelMatches(
  item: NotificationItem,
  filter: NotificationChannelFilter,
): boolean {
  return filter === "all" || item.channels.includes(filter);
}

/**
 * Applies the renderer-local channel selector and enabled-channel preview.
 * An item is suppressed only when none of its declared channels is enabled.
 */
export function filterNotificationChannelItems(
  items: readonly NotificationItem[],
  filter: NotificationChannelFilter,
  preferences: NotificationChannelPreferences,
): NotificationItem[] {
  return items.filter((item) => (
    notificationChannelMatches(item, filter) && notificationHasEnabledChannel(item, preferences)
  ));
}

export function buildNotificationChannelImpact(
  items: readonly NotificationItem[],
  input?: Partial<NotificationChannelPreferences> | null,
): NotificationChannelImpact {
  const preferences = normalizeNotificationChannelPreferences(input);
  const byChannel = Object.fromEntries(
    NOTIFICATION_CHANNEL_VALUES.map((channel) => {
      const availableItems = items.filter((item) => item.channels.includes(channel)).length;
      return [channel, {
        availableItems,
        enabled: notificationChannelEnabled(preferences, channel),
        affectedItems: availableItems > 0 && !notificationChannelEnabled(preferences, channel) ? availableItems : 0,
      }];
    }),
  ) as Record<NotificationChannel, {
    readonly availableItems: number;
    readonly enabled: boolean;
    readonly affectedItems: number;
  }>;
  const deliverableItems = items.filter((item) => notificationHasEnabledChannel(item, preferences)).length;
  return {
    totalItems: items.length,
    deliverableItems,
    suppressedItems: items.length - deliverableItems,
    byChannel,
  };
}

