import {
  AlertTriangle,
  BellRing,
  Check,
  Clipboard,
  Clock3,
  Download,
  Eye,
  ExternalLink,
  Filter,
  History,
  Info,
  RotateCcw,
  Redo2,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { BackgroundWorkRow } from "./background-work-inspector";
import {
  buildNotificationCenterProjection,
  downloadNotificationCenterExport,
  parseNotificationCenterPreview,
  notificationCenterSummary,
  serializeNotificationCenter,
  type NotificationAction,
  type NotificationCenterFormat,
  type NotificationChannel,
  type NotificationFilter,
  type NotificationItem,
  type NotificationKind,
  type NotificationStatus,
} from "./notification-center-contract";
import {
  ALL_NOTIFICATION_TRIAGE_SOURCES,
  buildNotificationTriageView,
  listNotificationTriageSources,
  NOTIFICATION_TRIAGE_LANE_LABELS,
  NOTIFICATION_TRIAGE_SORT_LABELS,
  notificationTriageLaneMatches,
  type NotificationTriageLane,
  type NotificationTriageSort,
} from "./notification-center-triage";
import {
  buildNotificationChannelImpact,
  DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES,
  filterNotificationChannelItems,
  NOTIFICATION_CHANNEL_DESCRIPTIONS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_CHANNEL_VALUES,
  normalizeNotificationChannelPreferences,
  notificationChannelEnabled,
  type NotificationChannelFilter,
  type NotificationChannelPreferences,
} from "./notification-center-channels";
import {
  createNotificationTriageSavedView,
  DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE,
  nextNotificationTriageViewId,
  NOTIFICATION_TRIAGE_VIEW_HISTORY_LIMIT,
  normalizeNotificationTriageViewName,
  trimNotificationTriageSavedViews,
  updateNotificationTriageSavedView,
  type NotificationTriageSavedView,
  type NotificationTriageViewState,
} from "./notification-center-triage-views";
import {
  applyNotificationSessionOverrides,
  NOTIFICATION_SESSION_HISTORY_LIMIT,
  patchNotificationSessionOverrides,
  type NotificationSessionOverrides,
} from "./notification-center-session";
import {
  appendNotificationExportHistory,
  buildNotificationExportHistoryEntry,
  notificationExportDeliveryLabel,
  notificationExportHistorySummary,
  type NotificationExportDelivery,
  type NotificationExportHistoryEntry,
} from "./notification-center-export-history";

export interface NotificationCenterPreviewProps {
  readonly items?: readonly NotificationItem[];
  readonly onOpenItem?: (item: NotificationItem) => void;
  readonly title?: string;
}

const PREVIEW_NOW = "2026-09-20T10:00:00.000Z";

const fallbackItems: readonly NotificationItem[] = [
  {
    id: "preview-approval",
    dedupeKey: "preview-approval",
    kind: "approval",
    title: "Review the next workspace handoff",
    summary: "A renderer-only handoff is ready for your review before any native dispatch would be considered.",
    status: "unread",
    priority: "urgent",
    occurredAt: "2026-09-20T09:54:00.000Z",
    sourceLabel: "Background work preview",
    sourceType: "background-work",
    requiresInput: true,
    channels: ["in-app", "screen-reader"],
    actions: [
      { id: "review", label: "Review", kind: "review", disposition: "available" },
      { id: "snooze", label: "Snooze", kind: "snooze", disposition: "planned" },
    ],
  },
  {
    id: "preview-completion",
    dedupeKey: "preview-completion",
    kind: "completion",
    title: "Renderer gates are ready to inspect",
    summary: "The current preview snapshot has typecheck and renderer-build evidence attached to it.",
    status: "unread",
    priority: "normal",
    occurredAt: "2026-09-20T09:43:00.000Z",
    sourceLabel: "Delivery evidence",
    sourceType: "release-evidence",
    requiresInput: false,
    channels: ["in-app", "screen-reader"],
    actions: [
      { id: "open-evidence", label: "Open evidence", kind: "open-run", disposition: "available" },
      { id: "copy", label: "Copy summary", kind: "copy", disposition: "available" },
    ],
  },
  {
    id: "preview-native-boundary",
    dedupeKey: "preview-native-boundary",
    kind: "failure",
    title: "Native delivery is not connected",
    summary: "OS notifications, durable acknowledgement, and background scheduling remain outside this renderer preview.",
    status: "read",
    priority: "high",
    occurredAt: "2026-09-20T09:31:00.000Z",
    sourceLabel: "Native boundary status",
    sourceType: "native-boundary",
    requiresInput: false,
    channels: ["in-app"],
    actions: [
      { id: "copy-boundary", label: "Copy boundary", kind: "copy", disposition: "available" },
      { id: "retry-native", label: "Retry connection", kind: "retry", disposition: "planned" },
    ],
  },
  {
    id: "preview-indexing",
    dedupeKey: "preview-indexing",
    kind: "indexing",
    title: "Research sources are available in preview",
    summary: "Visible notebook and citation projections can be reviewed without a provider request or durable write.",
    status: "read",
    priority: "low",
    occurredAt: "2026-09-20T09:10:00.000Z",
    sourceLabel: "Research notebook",
    sourceType: "research",
    requiresInput: false,
    channels: ["in-app"],
    actions: [
      { id: "open-research", label: "Open research", kind: "open-chat", disposition: "planned" },
    ],
  },
];

const kindLabels: Record<NotificationKind, string> = {
  attention: "Attention",
  completion: "Completed",
  failure: "Failure",
  indexing: "Indexing",
  approval: "Approval",
  info: "Info",
};

const filterLabels: Record<NotificationFilter, string> = {
  all: "All",
  unread: "Unread",
  snoozed: "Snoozed",
  dismissed: "Dismissed",
  attention: "Attention",
  failures: "Failures",
  completions: "Completions",
  indexing: "Indexing",
  approvals: "Approvals",
};

const statusLabels: Record<NotificationItem["status"], string> = {
  unread: "Unread",
  read: "Read",
  snoozed: "Snoozed",
  dismissed: "Dismissed",
};

function itemKindForRow(row: BackgroundWorkRow): NotificationKind {
  if (row.state === "needs-input" || row.state === "ready-for-review") return "approval";
  if (row.state === "failed" || row.state === "outcome-unknown") return "failure";
  if (row.state === "completed") return "completion";
  if (row.state === "working" || row.state === "queued") return "indexing";
  return "info";
}

function readableAge(value: string, reference = PREVIEW_NOW): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const referenceTimestamp = Date.parse(reference);
  const seconds = Math.max(0, Math.round(((Number.isFinite(referenceTimestamp) ? referenceTimestamp : Date.now()) - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function actionsForRow(row: BackgroundWorkRow): readonly NotificationAction[] {
  const actions: NotificationAction[] = [
    {
      id: `${row.id}:open`,
      label: row.sourceThreadId ? "Open chat" : "Open run",
      kind: row.sourceThreadId ? "open-chat" : "open-run",
      disposition: row.sourceThreadId ? "available" : "planned",
    },
    {
      id: `${row.id}:copy`,
      label: "Copy summary",
      kind: "copy",
      disposition: "available",
    },
  ];
  if (row.state === "failed" || row.state === "outcome-unknown") {
    actions.push({ id: `${row.id}:retry`, label: "Retry", kind: "retry", disposition: "planned" });
  }
  if (row.state === "needs-input" || row.state === "ready-for-review") {
    actions.push({ id: `${row.id}:review`, label: "Review", kind: "review", disposition: "available" });
  }
  return actions;
}

export function notificationItemsFromBackgroundRows(
  rows: readonly BackgroundWorkRow[],
): readonly NotificationItem[] {
  return rows.map((row) => {
    const kind = itemKindForRow(row);
    const requiresInput = row.state === "needs-input" || row.state === "ready-for-review";
    return {
      id: `background:${row.id}`,
      dedupeKey: `background:${row.id}:${row.state}`,
      kind,
      title: row.name,
      summary: row.summary,
      status: requiresInput || row.state === "failed" ? "unread" : "read",
      priority: requiresInput ? "urgent" : kind === "failure" ? "high" : kind === "completion" ? "normal" : "low",
      occurredAt: row.createdAt,
      sourceLabel: row.environmentLabel ?? "Background work",
      sourceType: row.kind,
      ...(row.sourceThreadId ? { conversationId: row.sourceThreadId } : {}),
      ...(row.kind === "run" ? { runId: row.id } : {}),
      requiresInput,
      channels: requiresInput ? ["in-app", "toast", "screen-reader"] : ["in-app", "screen-reader"],
      actions: actionsForRow(row),
      ...(row.eventCount && row.eventCount > 1 ? { occurrenceCount: row.eventCount } : {}),
    } satisfies NotificationItem;
  });
}

function iconForKind(kind: NotificationKind) {
  if (kind === "completion") return <Check size={16} />;
  if (kind === "failure") return <X size={16} />;
  if (kind === "approval" || kind === "attention") return <AlertTriangle size={16} />;
  if (kind === "indexing") return <Clock3 size={16} />;
  return <Info size={16} />;
}

function actionResult(action: NotificationAction): string {
  if (action.disposition === "planned") {
    return `${action.label} is planned; no native operation was started in this preview.`;
  }
  if (action.kind === "copy") return "Summary copied in the renderer session; no durable write was made.";
  if (action.kind === "review") return "Review surface selected in this renderer session; native acknowledgement is not connected.";
  return `${action.label} rehearsed in the renderer session; no provider request or native dispatch was started.`;
}

interface NotificationOverrideHistory {
  readonly past: readonly NotificationSessionOverrides[];
  readonly present: NotificationSessionOverrides;
  readonly future: readonly NotificationSessionOverrides[];
}

interface NotificationChannelPreferenceHistory {
  readonly past: readonly NotificationChannelPreferences[];
  readonly present: NotificationChannelPreferences;
  readonly future: readonly NotificationChannelPreferences[];
}

interface NotificationTriageSavedViewHistory {
  readonly past: readonly NotificationTriageSavedView[][];
  readonly present: readonly NotificationTriageSavedView[];
  readonly future: readonly NotificationTriageSavedView[][];
}

const EMPTY_NOTIFICATION_OVERRIDES: NotificationSessionOverrides = {};
const EMPTY_CHANNEL_PREFERENCE_HISTORY: NotificationChannelPreferenceHistory = {
  past: [],
  present: DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES,
  future: [],
};
const EMPTY_TRIAGE_SAVED_VIEW_HISTORY: NotificationTriageSavedViewHistory = { past: [], present: [], future: [] };

function lifecycleActionsForItem(item: NotificationItem): readonly NotificationAction[] {
  const readAction: NotificationAction = item.status === "unread"
    ? { id: `${item.id}:mark-read`, label: "Mark read", kind: "mark-read", disposition: "available" }
    : { id: `${item.id}:mark-unread`, label: "Mark unread", kind: "mark-unread", disposition: "available" };
  const dismissAction: NotificationAction = item.status === "dismissed"
    ? { id: `${item.id}:restore`, label: "Restore", kind: "restore", disposition: "available" }
    : { id: `${item.id}:dismiss`, label: "Dismiss", kind: "dismiss", disposition: "available" };
  const snoozeAction: NotificationAction = item.status === "snoozed"
    ? { id: `${item.id}:unsnooze`, label: "Restore", kind: "restore", disposition: "available" }
    : { id: `${item.id}:snooze`, label: "Snooze 15m", kind: "snooze", disposition: "available" };
  return [readAction, dismissAction, snoozeAction];
}

export function NotificationCenterPreview({
  items = fallbackItems,
  onOpenItem,
  title = "Notification center",
}: NotificationCenterPreviewProps) {
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [query, setQuery] = useState("");
  const [triageLane, setTriageLane] = useState<NotificationTriageLane>("all");
  const [triageSource, setTriageSource] = useState<string>(ALL_NOTIFICATION_TRIAGE_SOURCES);
  const [triageSort, setTriageSort] = useState<NotificationTriageSort>("priority");
  const [channelFilter, setChannelFilter] = useState<NotificationChannelFilter>("all");
  const [channelPreferenceHistory, setChannelPreferenceHistory] = useState<NotificationChannelPreferenceHistory>(EMPTY_CHANNEL_PREFERENCE_HISTORY);
  const [channelPreferenceStatus, setChannelPreferenceStatus] = useState("Channel preferences are renderer-session only.");
  const [savedViewHistory, setSavedViewHistory] = useState<NotificationTriageSavedViewHistory>(EMPTY_TRIAGE_SAVED_VIEW_HISTORY);
  const [activeSavedViewId, setActiveSavedViewId] = useState("");
  const [savedViewName, setSavedViewName] = useState("");
  const [savedViewStatus, setSavedViewStatus] = useState("Saved triage views stay in this renderer session.");
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [importedItems, setImportedItems] = useState<readonly NotificationItem[] | null>(null);
  const [actionStatus, setActionStatus] = useState("Renderer-local attention projection; no durable acknowledgement.");
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<"replace" | "merge">("replace");
  const [importPayload, setImportPayload] = useState("");
  const [importStatus, setImportStatus] = useState("Paste a JSON notification projection to rehearse an import.");
  const [format, setFormat] = useState<NotificationCenterFormat>("json");
  const [exportStatus, setExportStatus] = useState("Renderer-session export; no durable write.");
  const [exportHistory, setExportHistory] = useState<readonly NotificationExportHistoryEntry[]>([]);
  const [exportHistoryOpen, setExportHistoryOpen] = useState(false);
  const [historyPreviewId, setHistoryPreviewId] = useState<string | null>(null);
  const [overrideHistory, setOverrideHistory] = useState<NotificationOverrideHistory>({
    past: [],
    present: EMPTY_NOTIFICATION_OVERRIDES,
    future: [],
  });
  const generatedAt = useMemo(() => PREVIEW_NOW, []);
  const activeItems = importedItems ?? items;
  const sessionItems = useMemo(
    () => applyNotificationSessionOverrides(activeItems, overrideHistory.present),
    [activeItems, overrideHistory.present],
  );
  const projection = useMemo(
    () => buildNotificationCenterProjection({ items: sessionItems, generatedAt, selectedFilter: filter }),
    [filter, generatedAt, sessionItems],
  );
  const triageSources = useMemo(() => listNotificationTriageSources(activeItems), [activeItems]);
  const channelImpact = useMemo(
    () => buildNotificationChannelImpact(projection.items, channelPreferenceHistory.present),
    [channelPreferenceHistory.present, projection.items],
  );
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const searchedItems = normalized
      ? projection.items.filter((item) =>
          [item.title, item.summary, item.sourceLabel, item.sourceType ?? "", item.kind, item.priority]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalized),
        )
      : [...projection.items];
    const channelItems = filterNotificationChannelItems(
      searchedItems,
      channelFilter,
      channelPreferenceHistory.present,
    );
    return buildNotificationTriageView(channelItems, {
      lane: triageLane,
      source: triageSource,
      sort: triageSort,
    });
  }, [channelFilter, channelPreferenceHistory.present, projection.items, query, triageLane, triageSort, triageSource]);
  const triageCounts = useMemo(
    () => ({
      all: projection.items.length,
      needsInput: projection.items.filter((item) => notificationTriageLaneMatches(item, "needs-input")).length,
      urgent: projection.items.filter((item) => notificationTriageLaneMatches(item, "urgent")).length,
      failures: projection.items.filter((item) => notificationTriageLaneMatches(item, "failures")).length,
      quiet: projection.items.filter((item) => notificationTriageLaneMatches(item, "quiet")).length,
    }),
    [projection.items],
  );
  const selectedItems = useMemo(
    () => visibleItems.filter((item) => selectedIds.has(item.id)),
    [selectedIds, visibleItems],
  );
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const exportProjection = useMemo(
    () => buildNotificationCenterProjection({ items: visibleItems, generatedAt, selectedFilter: filter }),
    [filter, generatedAt, visibleItems],
  );
  const exportPayload = useMemo(
    () => serializeNotificationCenter(exportProjection, format),
    [exportProjection, format],
  );
  const historyPreview = useMemo(
    () => exportHistory.find((entry) => entry.id === historyPreviewId) ?? null,
    [exportHistory, historyPreviewId],
  );
  const visibleExportPayload = historyPreview?.payload ?? exportPayload;
  const visibleExportFormat = historyPreview?.format ?? format;
  const currentTriageViewState: NotificationTriageViewState = {
    filter,
    query,
    lane: triageLane,
    source: triageSource,
    sort: triageSort,
    channelFilter,
  };
  const activeSavedView = savedViewHistory.present.find((view) => view.id === activeSavedViewId) ?? null;
  const activeViewIsCurrent = activeSavedView
    ? JSON.stringify(activeSavedView.state) === JSON.stringify(currentTriageViewState)
      && normalizeNotificationTriageViewName(savedViewName, activeSavedView.name) === activeSavedView.name
    : false;

  useEffect(() => {
    const activeIds = new Set(activeItems.map((item) => item.id));
    setSelectedIds((current) => {
      const next = new Set(Array.from(current).filter((id) => activeIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [activeItems]);

  useEffect(() => {
    if (triageSource !== ALL_NOTIFICATION_TRIAGE_SOURCES && !triageSources.includes(triageSource)) {
      setTriageSource(ALL_NOTIFICATION_TRIAGE_SOURCES);
    }
  }, [triageSource, triageSources]);

  const commitOverrides = (next: NotificationSessionOverrides, message: string) => {
    setOverrideHistory((current) => {
      if (current.present === next || JSON.stringify(current.present) === JSON.stringify(next)) return current;
      return {
        past: [...current.past, current.present].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT),
        present: next,
        future: [],
      };
    });
    setActionStatus(message);
  };

  const applyStatusToItems = (
    targetItems: readonly NotificationItem[],
    status: NotificationStatus,
    message: string,
  ) => {
    if (targetItems.length === 0) {
      setActionStatus("No visible notifications match this action.");
      return;
    }
    const changedAt = generatedAt;
    const next = patchNotificationSessionOverrides(
      overrideHistory.present,
      targetItems,
      status,
      changedAt,
    );
    commitOverrides(next, message);
  };

  const toggleItemSelection = (itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const selectVisibleItems = () => {
    if (visibleItems.length === 0) {
      setActionStatus("No visible notifications match this selection.");
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleItems.forEach((item) => next.add(item.id));
      return next;
    });
    setActionStatus(`${visibleItems.length} visible notification${visibleItems.length === 1 ? "" : "s"} selected in the renderer session.`);
  };

  const clearVisibleSelection = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleItems.forEach((item) => next.delete(item.id));
      return next;
    });
    setActionStatus("Cleared selection for the current notification view.");
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setActionStatus("Cleared notification selection in the renderer session.");
  };

  const applyStatusToSelected = (status: NotificationStatus, message: string) => {
    applyStatusToItems(selectedItems, status, message);
    if (selectedItems.length > 0) setSelectedIds(new Set());
  };

  const undoStatus = () => {
    setOverrideHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      setActionStatus("Undid the last notification status change in this renderer session.");
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future].slice(0, NOTIFICATION_SESSION_HISTORY_LIMIT),
      };
    });
  };

  const redoStatus = () => {
    setOverrideHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      setActionStatus("Redid the notification status change in this renderer session.");
      return {
        past: [...current.past, current.present].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT),
        present: next,
        future: current.future.slice(1),
      };
    });
  };

  const resetStatus = () => {
    if (Object.keys(overrideHistory.present).length === 0) {
      setActionStatus("Notification status is already at the source projection.");
      return;
    }
    commitOverrides(EMPTY_NOTIFICATION_OVERRIDES, "Reset notification status to the source projection for this session.");
  };

  const updateChannelPreference = (channel: NotificationChannel, enabled: boolean) => {
    setChannelPreferenceHistory((current) => {
      const nextPreferences = normalizeNotificationChannelPreferences({ ...current.present, [channel]: enabled });
      if (JSON.stringify(nextPreferences) === JSON.stringify(current.present)) return current;
      return {
        past: [...current.past, current.present].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT),
        present: nextPreferences,
        future: [],
      };
    });
    setChannelPreferenceStatus(`${NOTIFICATION_CHANNEL_LABELS[channel]} ${enabled ? "enabled" : "muted"} for this renderer session; native subscriptions were not changed.`);
  };

  const undoChannelPreferences = () => {
    setChannelPreferenceHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      setChannelPreferenceStatus("Undid the last channel preference change in this renderer session.");
      return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future].slice(0, NOTIFICATION_SESSION_HISTORY_LIMIT) };
    });
  };

  const redoChannelPreferences = () => {
    setChannelPreferenceHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      setChannelPreferenceStatus("Redid the channel preference change in this renderer session.");
      return { past: [...current.past, current.present].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT), present: next, future: current.future.slice(1) };
    });
  };

  const resetChannelPreferences = () => {
    setChannelPreferenceHistory((current) => ({
      past: JSON.stringify(current.present) === JSON.stringify(DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES)
        ? current.past
        : [...current.past, current.present].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT),
      present: DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES,
      future: [],
    }));
    setChannelFilter("all");
    setChannelPreferenceStatus("Notification channel preferences reset for this renderer session; native subscriptions were not changed.");
  };

  const applyTriageViewState = (state: NotificationTriageViewState) => {
    setFilter(state.filter);
    setQuery(state.query);
    setTriageLane(state.lane);
    setTriageSource(state.source === ALL_NOTIFICATION_TRIAGE_SOURCES || triageSources.includes(state.source)
      ? state.source
      : ALL_NOTIFICATION_TRIAGE_SOURCES);
    setTriageSort(state.sort);
    setChannelFilter(state.channelFilter);
  };

  const commitSavedTriageViews = (views: readonly NotificationTriageSavedView[], message: string) => {
    setSavedViewHistory((current) => ({
      past: [...current.past, [...current.present]].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT),
      present: trimNotificationTriageSavedViews(views),
      future: [],
    }));
    setSavedViewStatus(message);
  };

  const undoSavedTriageViews = () => {
    const previous = savedViewHistory.past.at(-1);
    if (!previous) return;
    setSavedViewHistory((current) => ({
      past: current.past.slice(0, -1),
      present: previous,
      future: [[...current.present], ...current.future].slice(0, NOTIFICATION_SESSION_HISTORY_LIMIT),
    }));
    const restoredActiveView = previous.find((view) => view.id === activeSavedViewId);
    if (restoredActiveView) {
      setSavedViewName(restoredActiveView.name);
    } else if (activeSavedViewId) {
      setActiveSavedViewId("");
      setSavedViewName("");
    }
    setSavedViewStatus("Undid the last saved triage-view change in this renderer session.");
  };

  const redoSavedTriageViews = () => {
    const next = savedViewHistory.future[0];
    if (!next) return;
    setSavedViewHistory((current) => ({
      past: [...current.past, [...current.present]].slice(-NOTIFICATION_SESSION_HISTORY_LIMIT),
      present: next,
      future: current.future.slice(1),
    }));
    const restoredActiveView = next.find((view) => view.id === activeSavedViewId);
    if (restoredActiveView) {
      setSavedViewName(restoredActiveView.name);
    } else if (activeSavedViewId) {
      setActiveSavedViewId("");
      setSavedViewName("");
    }
    setSavedViewStatus("Redid the saved triage-view change in this renderer session.");
  };

  const saveTriageView = () => {
    const name = normalizeNotificationTriageViewName(savedViewName, "");
    if (!name) {
      setSavedViewStatus("Enter a name for this triage view.");
      return;
    }
    const duplicate = savedViewHistory.present.find((view) => view.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0);
    if (duplicate) {
      setSavedViewStatus("That name is already in use. Select the view and choose Update view, or rename this one.");
      return;
    }
    if (savedViewHistory.present.length >= NOTIFICATION_TRIAGE_VIEW_HISTORY_LIMIT) {
      setSavedViewStatus(`This renderer session already has ${NOTIFICATION_TRIAGE_VIEW_HISTORY_LIMIT} saved triage views. Delete one to make room.`);
      return;
    }
    const view = createNotificationTriageSavedView({
      id: nextNotificationTriageViewId(savedViewHistory.present),
      name,
      state: currentTriageViewState,
      savedAt: generatedAt,
    });
    commitSavedTriageViews([...savedViewHistory.present, view], `Saved “${view.name}” for this renderer session.`);
    setActiveSavedViewId(view.id);
  };

  const updateTriageView = () => {
    if (!activeSavedView) return;
    const name = normalizeNotificationTriageViewName(savedViewName, activeSavedView.name);
    const duplicate = savedViewHistory.present.find((view) => view.id !== activeSavedView.id && view.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0);
    if (duplicate) {
      setSavedViewStatus("Another saved triage view already uses that name.");
      return;
    }
    const views = savedViewHistory.present.map((view) => view.id === activeSavedView.id
      ? updateNotificationTriageSavedView(view, { name, state: currentTriageViewState, savedAt: generatedAt })
      : view);
    commitSavedTriageViews(views, `Updated “${name}” for this renderer session.`);
  };

  const deleteTriageView = () => {
    if (!activeSavedView) return;
    commitSavedTriageViews(savedViewHistory.present.filter((view) => view.id !== activeSavedView.id), `Deleted “${activeSavedView.name}” from this renderer session.`);
    setActiveSavedViewId("");
    setSavedViewName("");
  };

  const selectTriageView = (viewId: string) => {
    setActiveSavedViewId(viewId);
    if (!viewId) {
      setSavedViewName("");
      applyTriageViewState(DEFAULT_NOTIFICATION_TRIAGE_VIEW_STATE);
      setSavedViewStatus("Manual triage controls reset to their defaults.");
      return;
    }
    const view = savedViewHistory.present.find((candidate) => candidate.id === viewId);
    if (!view) return;
    setSavedViewName(view.name);
    applyTriageViewState(view.state);
    setSavedViewStatus(`Applied “${view.name}” in this renderer session; no durable configuration was changed.`);
  };

  const resetImportedProjection = () => {
    if (!importedItems) {
      setImportStatus("The source projection is already active.");
      return;
    }
    setImportedItems(null);
    setOverrideHistory({ past: [], present: EMPTY_NOTIFICATION_OVERRIDES, future: [] });
    setSelectedIds(new Set());
    setSelectedId(items[0]?.id ?? null);
    setImportStatus("Returned to the incoming source projection; no durable write was made.");
    setActionStatus("Source projection restored in this renderer session.");
  };

  const applyImportPreview = () => {
    const parsed = parseNotificationCenterPreview(importPayload);
    if (!parsed) {
      setImportStatus("Import rejected: expected a valid JSON notification projection with the preview boundary intact.");
      return;
    }
    const nextItems = importMode === "replace"
      ? [...parsed.items]
      : [...activeItems, ...parsed.items];
    setImportedItems(nextItems);
    setOverrideHistory({ past: [], present: EMPTY_NOTIFICATION_OVERRIDES, future: [] });
    setSelectedIds(new Set());
    setFilter(parsed.selectedFilter);
    setSelectedId(nextItems[0]?.id ?? null);
    setImportStatus(
      `${importMode === "replace" ? "Replaced" : "Merged"} ${parsed.items.length} imported notification${parsed.items.length === 1 ? "" : "s"} in the renderer session; no durable write was made.`,
    );
    setActionStatus("Imported notification projection is active in this renderer session.");
  };

  const handleAction = (item: NotificationItem, action: NotificationAction) => {
    if (action.disposition === "unavailable") return;
    if ((action.kind === "open-chat" || action.kind === "open-run") && onOpenItem) onOpenItem(item);
    if (action.kind === "mark-read") {
      applyStatusToItems([item], "read", "Marked notification read in the renderer session; no durable acknowledgement was made.");
    } else if (action.kind === "mark-unread") {
      applyStatusToItems([item], "unread", "Marked notification unread in the renderer session; no durable acknowledgement was made.");
    } else if (action.kind === "dismiss") {
      applyStatusToItems([item], "dismissed", "Dismissed notification in the renderer session; native dismissal is not connected.");
    } else if (action.kind === "snooze") {
      applyStatusToItems([item], "snoozed", "Snoozed notification for 15 minutes in the renderer session; no scheduler was started.");
    } else if (action.kind === "restore") {
      applyStatusToItems([item], "unread", "Restored notification to unread in the renderer session; no durable acknowledgement was made.");
    }
    setSelectedId(item.id);
    if (!["mark-read", "mark-unread", "dismiss", "snooze", "restore"].includes(action.kind)) {
      setActionStatus(actionResult(action));
    }
  };

  const recordExport = (delivery: NotificationExportDelivery, message: string, source: NotificationExportHistoryEntry | null = historyPreview) => {
    const sourceEntry = source ?? undefined;
    const entry = buildNotificationExportHistoryEntry({
      delivery,
      format: sourceEntry?.format ?? format,
      generatedAt: sourceEntry?.generatedAt ?? generatedAt,
      itemCount: sourceEntry?.itemCount ?? visibleItems.length,
      filter: sourceEntry?.filter ?? filter,
      lane: sourceEntry?.lane ?? triageLane,
      source: sourceEntry?.source ?? triageSource,
      sort: sourceEntry?.sort ?? triageSort,
      query: sourceEntry?.query ?? query,
      payload: sourceEntry?.payload ?? exportPayload,
    });
    if (!entry) {
      setExportStatus(`${message} History was not retained because this payload exceeds the preview history budget.`);
      return;
    }
    setExportHistory((current) => appendNotificationExportHistory(current, entry));
    setHistoryPreviewId(entry.id);
    setExportHistoryOpen(true);
    setExportStatus(`${message} Retained as a renderer-session history entry.`);
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable in this preview environment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(visibleExportPayload);
      recordExport("copy", `${visibleExportFormat.toUpperCase()} preview copied; no durable write was made.`);
    } catch {
      setExportStatus("Clipboard write was unavailable; the projection remains renderer-local.");
    }
  };

  const downloadExport = () => {
    const started = downloadNotificationCenterExport(visibleExportPayload, visibleExportFormat);
    if (started) {
      recordExport("download", `${visibleExportFormat.toUpperCase()} browser download started; no native export receipt was created.`);
      return;
    }
    setExportStatus("Browser download is unavailable in this preview environment.");
  };

  const clearExportHistory = () => {
    setExportHistory([]);
    setHistoryPreviewId(null);
    setExportStatus("Cleared notification export history in the renderer session; no durable write was made.");
  };

  return (
    <section className="notification-center-preview" aria-label="Notification center preview">
      <header className="notification-center-preview__header">
        <div>
          <span className="eyebrow"><BellRing size={13} /> Attention stream</span>
          <h2>{title}</h2>
          <p>{notificationCenterSummary(projection)}. Filter, inspect, and rehearse actions from the current renderer projection.</p>
        </div>
        <span className="notification-center-preview__badge"><Eye size={12} /> Renderer-local</span>
      </header>

      <div className="notification-center-preview__metrics" aria-label="Notification counts">
        <button type="button" className={filter === "all" ? "is-active" : ""} title="Show all notifications" aria-label={`Show all notifications (${projection.counts.all})`} onClick={() => setFilter("all")}><strong>{projection.counts.all}</strong><span>Total</span></button>
        <button type="button" className={filter === "unread" ? "is-active" : ""} title="Show unread notifications" aria-label={`Show unread notifications (${projection.counts.unread})`} onClick={() => setFilter("unread")}><strong>{projection.counts.unread}</strong><span>Unread</span></button>
        <button type="button" className={filter === "attention" ? "is-active" : ""} title="Show notifications needing attention" aria-label={`Show notifications needing attention (${projection.counts.attention})`} onClick={() => setFilter("attention")}><strong>{projection.counts.attention}</strong><span>Attention</span></button>
        <button type="button" className={filter === "failures" ? "is-active" : ""} title="Show notification failures" aria-label={`Show notification failures (${projection.counts.failures})`} onClick={() => setFilter("failures")}><strong>{projection.counts.failures}</strong><span>Failures</span></button>
      </div>

      <nav className="notification-center-preview__filters" aria-label="Notification filters" role="tablist">
        {(Object.keys(filterLabels) as NotificationFilter[]).map((value) => (
          <button key={value} type="button" role="tab" title={`Filter notifications: ${filterLabels[value]}`} aria-selected={filter === value} className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>
            {filterLabels[value]}
          </button>
        ))}
      </nav>

      <section className="notification-center-preview__triage" aria-label="Notification triage center">
        <header className="notification-center-preview__triage-header">
          <div>
            <span className="eyebrow"><Filter size={13} /> Triage cockpit</span>
            <h3>Notification triage center</h3>
            <p>Prioritize attention, choose a source lane, and keep quiet signals out of the active queue.</p>
          </div>
          <span className="notification-center-preview__triage-count" aria-live="polite">{visibleItems.length} shown · {projection.items.length} in filter</span>
        </header>
        <div className="notification-center-preview__triage-lanes" role="group" aria-label="Notification triage lanes">
          {(Object.keys(NOTIFICATION_TRIAGE_LANE_LABELS) as NotificationTriageLane[]).map((lane) => {
            const count = lane === "all"
              ? triageCounts.all
              : lane === "needs-input"
                ? triageCounts.needsInput
                : lane === "urgent"
                  ? triageCounts.urgent
                  : lane === "failures"
                    ? triageCounts.failures
                    : triageCounts.quiet;
            return (
              <button
                key={lane}
                type="button"
                className={triageLane === lane ? "is-active" : ""}
                title={`Show ${NOTIFICATION_TRIAGE_LANE_LABELS[lane].toLowerCase()} notification triage`}
                onClick={() => setTriageLane(lane)}
                aria-pressed={triageLane === lane}
              >
                <strong>{count}</strong>
                <span>{NOTIFICATION_TRIAGE_LANE_LABELS[lane]}</span>
              </button>
            );
          })}
        </div>
        <div className="notification-center-preview__triage-toolbar" role="toolbar" aria-label="Notification triage controls">
          <label>
            <span>Source lane</span>
            <select aria-label="Notification triage source" title="Filter the queue by notification source" value={triageSource} onChange={(event) => setTriageSource(event.target.value)}>
              <option value={ALL_NOTIFICATION_TRIAGE_SOURCES}>All sources</option>
              {triageSources.map((source) => <option key={source} value={source}>{source}</option>)}
            </select>
          </label>
          <label>
            <span>Sort queue</span>
            <select aria-label="Notification triage sort" title="Choose how the notification queue is sorted" value={triageSort} onChange={(event) => setTriageSort(event.target.value as NotificationTriageSort)}>
              {(Object.keys(NOTIFICATION_TRIAGE_SORT_LABELS) as NotificationTriageSort[]).map((sort) => <option key={sort} value={sort}>{NOTIFICATION_TRIAGE_SORT_LABELS[sort]}</option>)}
            </select>
          </label>
          <label>
            <span>Channel</span>
            <select aria-label="Notification channel filter" title="Filter the queue by delivery channel" value={channelFilter} onChange={(event) => setChannelFilter(event.target.value as NotificationChannelFilter)}>
              <option value="all">All channels</option>
              {NOTIFICATION_CHANNEL_VALUES.map((channel) => <option key={channel} value={channel}>{NOTIFICATION_CHANNEL_LABELS[channel]}</option>)}
            </select>
          </label>
          <span className="notification-center-preview__triage-toolbar-hint"><SlidersHorizontal size={13} /> {triageLane === "all" ? "All triage lanes" : NOTIFICATION_TRIAGE_LANE_LABELS[triageLane]} · {triageSource === ALL_NOTIFICATION_TRIAGE_SOURCES ? "all sources" : triageSource}</span>
          <button
            type="button"
            className="button button--ghost"
            title="Reset notification triage lane, source, and sort"
            onClick={() => { setTriageLane("all"); setTriageSource(ALL_NOTIFICATION_TRIAGE_SOURCES); setTriageSort("priority"); }}
            disabled={triageLane === "all" && triageSource === ALL_NOTIFICATION_TRIAGE_SOURCES && triageSort === "priority"}
          >
            Reset triage
          </button>
        </div>
        <section className="notification-center-preview__saved-views" aria-label="Saved notification triage views">
          <div className="notification-center-preview__saved-heading">
            <span><strong>Saved triage views</strong><small>Capture filter, lane, source, sort, search, and channel state together.</small></span>
            <span className="notification-center-preview__saved-boundary">Renderer session · no durable write</span>
          </div>
          <div className="notification-center-preview__saved-controls">
            <label>
              <span>Saved view</span>
              <select aria-label="Saved notification triage view" title="Choose a saved triage view or manual controls" value={activeSavedViewId} onChange={(event) => selectTriageView(event.target.value)}>
                <option value="">Manual current controls</option>
                {savedViewHistory.present.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
              </select>
            </label>
            <label>
              <span>Name</span>
              <input value={savedViewName} title="Name the renderer-local triage view before saving" onChange={(event) => setSavedViewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); activeSavedView ? updateTriageView() : saveTriageView(); } }} placeholder="e.g. Urgent provider queue" aria-label="New notification triage view name" />
            </label>
            <div className="notification-center-preview__saved-actions">
              <button type="button" className="button button--secondary" title="Save the current notification triage controls as a renderer-local view" onClick={saveTriageView} disabled={!savedViewName.trim() || Boolean(activeSavedView)}><Save size={12} /> Save as</button>
              <button type="button" className="button button--ghost" title="Update the selected renderer-local notification triage view" onClick={updateTriageView} disabled={!activeSavedView || activeViewIsCurrent}><Save size={12} /> Update</button>
              <button type="button" className="button button--ghost" title="Delete the selected renderer-local notification triage view" onClick={deleteTriageView} disabled={!activeSavedView} aria-label="Delete saved notification triage view"><Trash2 size={12} /></button>
              <button type="button" className="button button--ghost" title="Undo the last saved notification triage view change" onClick={undoSavedTriageViews} disabled={savedViewHistory.past.length === 0} aria-label="Undo saved notification triage view change"><Undo2 size={12} /> Undo</button>
              <button type="button" className="button button--ghost" title="Redo the last saved notification triage view change" onClick={redoSavedTriageViews} disabled={savedViewHistory.future.length === 0} aria-label="Redo saved notification triage view change"><Redo2 size={12} /> Redo</button>
            </div>
          </div>
          <p className="notification-center-preview__saved-status" aria-live="polite">{savedViewStatus}</p>
        </section>
        <div className="notification-center-preview__channel-preferences" aria-label="Notification channel preferences">
          <div className="notification-center-preview__channel-heading">
            <span><strong>Channel preferences</strong><small>{channelImpact.deliverableItems}/{channelImpact.totalItems} visible items have an enabled route</small></span>
            <div className="notification-center-preview__channel-actions">
              <button type="button" className="button button--ghost" title="Undo the last notification channel preference change" onClick={undoChannelPreferences} disabled={channelPreferenceHistory.past.length === 0} aria-label="Undo channel preference change"><Undo2 size={12} /> Undo</button>
              <button type="button" className="button button--ghost" title="Redo the last notification channel preference change" onClick={redoChannelPreferences} disabled={channelPreferenceHistory.future.length === 0} aria-label="Redo channel preference change"><Redo2 size={12} /> Redo</button>
              <button type="button" className="button button--ghost" title="Reset all notification channel preferences to defaults" onClick={resetChannelPreferences} disabled={JSON.stringify(channelPreferenceHistory.present) === JSON.stringify(DEFAULT_NOTIFICATION_CHANNEL_PREFERENCES)}>Reset channels</button>
            </div>
          </div>
          <div className="notification-center-preview__channel-grid">
            {NOTIFICATION_CHANNEL_VALUES.map((channel) => {
              const impact = channelImpact.byChannel[channel];
              const enabled = notificationChannelEnabled(channelPreferenceHistory.present, channel);
              return (
                <label key={channel} className={`notification-center-preview__channel-card${enabled ? " is-enabled" : " is-muted"}`}>
                  <input type="checkbox" checked={enabled} onChange={(event) => updateChannelPreference(channel, event.target.checked)} aria-label={`Enable ${NOTIFICATION_CHANNEL_LABELS[channel]}`} />
                  <span><strong>{NOTIFICATION_CHANNEL_LABELS[channel]}</strong><small>{NOTIFICATION_CHANNEL_DESCRIPTIONS[channel]}</small><em>{impact.availableItems} available · {impact.affectedItems} suppressed</em></span>
                </label>
              );
            })}
          </div>
          <p className="notification-center-preview__channel-status" aria-live="polite">{channelPreferenceStatus}</p>
          <small className="notification-center-preview__channel-boundary">Session-only channel rehearsal. It does not alter native notification subscriptions or delivery permissions.</small>
        </div>
      </section>

      <div className="notification-center-preview__search">
        <label htmlFor="notification-center-search">Search notifications</label>
        <div className="notification-center-preview__search-control">
          <Search size={13} aria-hidden="true" />
          <input id="notification-center-search" type="search" title="Search notifications by title, source, kind, or priority" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, source, kind, or priority" />
          {query ? <button type="button" title="Clear notification search" aria-label="Clear notification search" onClick={() => setQuery("")}><X size={13} /></button> : null}
        </div>
      </div>

      <div className="notification-center-preview__session-toolbar" role="toolbar" aria-label="Notification session controls">
        <span className="notification-center-preview__session-summary">
          {Object.keys(overrideHistory.present).length > 0
            ? `${Object.keys(overrideHistory.present).length} session status override${Object.keys(overrideHistory.present).length === 1 ? "" : "s"}`
            : "Source statuses"}
        </span>
        <div className="notification-center-preview__session-actions">
          <button
            type="button"
            className="button button--ghost"
            title="Mark visible notifications read in this renderer session"
            onClick={() => applyStatusToItems(visibleItems, "read", "Marked visible notifications read in the renderer session; no durable acknowledgement was made.")}
            disabled={!visibleItems.some((item) => item.status === "unread")}
          >
            Mark visible read
          </button>
          <button
            type="button"
            className="button button--ghost"
            title="Restore dismissed visible notifications to unread in this renderer session"
            onClick={() => applyStatusToItems(visibleItems.filter((item) => item.status === "dismissed"), "unread", "Restored dismissed notifications to unread in the renderer session.")}
            disabled={!visibleItems.some((item) => item.status === "dismissed")}
          >
            Restore dismissed
          </button>
          <button type="button" className="button button--ghost" title="Undo the last notification status change" onClick={undoStatus} disabled={overrideHistory.past.length === 0}>Undo</button>
          <button type="button" className="button button--ghost" title="Redo the last notification status change" onClick={redoStatus} disabled={overrideHistory.future.length === 0}>Redo</button>
          <button type="button" className="button button--ghost" title="Reset renderer-local notification statuses" onClick={resetStatus} disabled={Object.keys(overrideHistory.present).length === 0}>Reset statuses</button>
        </div>
      </div>

      <div className="notification-center-preview__selection-toolbar" role="toolbar" aria-label="Notification selection controls">
        <span className="notification-center-preview__selection-summary">
          {selectedItems.length > 0
            ? `${selectedItems.length} selected in view${selectedIds.size > selectedItems.length ? ` · ${selectedIds.size} total` : ""}`
            : "Select notifications for bulk actions"}
        </span>
        <div className="notification-center-preview__selection-actions">
          <button type="button" className="button button--ghost" title="Select all visible notifications" onClick={selectVisibleItems} disabled={visibleItems.length === 0}>Select visible</button>
          <button type="button" className="button button--ghost" title="Clear selection for visible notifications" onClick={clearVisibleSelection} disabled={selectedItems.length === 0}>Clear visible</button>
          <button type="button" className="button button--ghost" title="Mark selected notifications read in this renderer session" onClick={() => applyStatusToSelected("read", "Marked selected notifications read in the renderer session; no durable acknowledgement was made.")} disabled={!selectedItems.some((item) => item.status === "unread")}>Mark selected read</button>
          <button type="button" className="button button--ghost" title="Snooze selected notifications in this renderer session" onClick={() => applyStatusToSelected("snoozed", "Snoozed selected notifications for 15 minutes in the renderer session; no scheduler was started.")} disabled={selectedItems.length === 0}>Snooze selected</button>
          <button type="button" className="button button--ghost" title="Dismiss selected notifications in this renderer session" onClick={() => applyStatusToSelected("dismissed", "Dismissed selected notifications in the renderer session; native dismissal is not connected.")} disabled={selectedItems.length === 0}>Dismiss selected</button>
          <button type="button" className="button button--ghost" title="Restore selected notifications to unread" onClick={() => applyStatusToSelected("unread", "Restored selected notifications to unread in the renderer session; no durable acknowledgement was made.")} disabled={!selectedItems.some((item) => item.status === "dismissed" || item.status === "snoozed")}>Restore selected</button>
          <button type="button" className="button button--ghost" title="Clear the notification selection" onClick={clearSelection} disabled={selectedIds.size === 0}>Clear selection</button>
        </div>
      </div>

      <div className="notification-center-preview__body">
        <div className="notification-center-preview__list" role="list" aria-label={`${visibleItems.length} visible notification${visibleItems.length === 1 ? "" : "s"}`}>
          {visibleItems.length === 0 ? <p className="notification-center-preview__empty">No notifications match the current filter.</p> : null}
          {visibleItems.map((item) => (
            <article key={item.id} aria-label={item.title} className={`notification-center-preview__item notification-center-preview__item--${item.kind} ${selected?.id === item.id ? "is-selected" : ""}`} role="listitem">
              <div className="notification-center-preview__item-head">
                <label className="notification-center-preview__item-select">
                  <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleItemSelection(item.id)} aria-label={`Select ${item.title}`} />
                  <span className="sr-only">Select notification</span>
                </label>
                <button type="button" className="notification-center-preview__item-main" title={`Inspect notification: ${item.title}`} onClick={() => setSelectedId(item.id)} aria-pressed={selected?.id === item.id}>
                  <span className="notification-center-preview__item-icon" aria-hidden="true">{iconForKind(item.kind)}</span>
                  <span className="notification-center-preview__item-copy"><strong>{item.title}</strong><span>{item.summary}</span><small>{item.sourceLabel} · {readableAge(item.occurredAt, generatedAt)}</small></span>
                  <span className={`notification-center-preview__priority notification-center-preview__priority--${item.priority}`}>{item.priority}</span>
                </button>
              </div>
              <div className="notification-center-preview__item-footer">
                <span className="notification-center-preview__kind">{kindLabels[item.kind]} · {statusLabels[item.status]}{item.occurrenceCount && item.occurrenceCount > 1 ? ` · ${item.occurrenceCount} occurrences` : ""}</span>
                <div className="notification-center-preview__actions" aria-label={`${item.title} actions`}>
                  {item.actions.slice(0, 2).map((action) => <button key={action.id} type="button" className="button button--ghost" title={`${action.label}${action.disposition === "planned" ? " (planned)" : action.disposition === "unavailable" ? " (unavailable)" : ""}`} disabled={action.disposition === "unavailable"} onClick={() => handleAction(item, action)}>{action.kind === "open-chat" || action.kind === "open-run" ? <ExternalLink size={12} /> : action.kind === "retry" ? <RotateCcw size={12} /> : <Check size={12} />}{action.label}{action.disposition === "planned" ? " · planned" : ""}</button>)}
                  {lifecycleActionsForItem(item).slice(0, 2).map((action) => <button key={action.id} type="button" className="button button--ghost notification-center-preview__lifecycle-action" title={action.label} onClick={() => handleAction(item, action)}>{action.kind === "snooze" ? <Clock3 size={12} /> : action.kind === "dismiss" ? <X size={12} /> : <Check size={12} />}{action.label}</button>)}
                </div>
              </div>
            </article>
          ))}
        </div>

        <aside className="notification-center-preview__detail" aria-label={selected ? `Selected notification ${selected.title}` : "Notification details"}>
          {selected ? <>
            <span className="eyebrow"><Info size={13} /> Selected notification</span>
            <h3>{selected.title}</h3>
            <p>{selected.summary}</p>
            <dl>
              <div><dt>Kind</dt><dd>{kindLabels[selected.kind]}</dd></div>
              <div><dt>Priority</dt><dd>{selected.priority}</dd></div>
              <div><dt>Source</dt><dd>{selected.sourceLabel}</dd></div>
              <div><dt>Channels</dt><dd>{selected.channels.join(", ")}</dd></div>
              <div><dt>Requires input</dt><dd>{selected.requiresInput ? "Yes" : "No"}</dd></div>
            </dl>
            <div className="notification-center-preview__detail-actions" aria-label="Selected notification actions">
              {selected.actions.map((action) => <button key={action.id} type="button" className="button button--secondary" title={`${action.label}${action.disposition === "planned" ? " (planned)" : action.disposition === "unavailable" ? " (unavailable)" : ""}`} disabled={action.disposition === "unavailable"} onClick={() => handleAction(selected, action)}>{action.label}{action.disposition === "planned" ? " · planned" : ""}</button>)}
            </div>
            <div className="notification-center-preview__detail-actions notification-center-preview__detail-actions--lifecycle" aria-label="Selected notification status actions">
              {lifecycleActionsForItem(selected).map((action) => <button key={action.id} type="button" className="button button--ghost" title={action.label} onClick={() => handleAction(selected, action)}>{action.label}</button>)}
            </div>
          </> : <p className="notification-center-preview__empty">Select a notification to inspect its projected metadata.</p>}
        </aside>
      </div>

      <p className="notification-center-preview__status" role="status" aria-live="polite">{actionStatus}</p>
      <section className="notification-center-preview__export" aria-label="Notification center export preview">
        <header><div><span className="eyebrow"><Clipboard size={13} /> Portable projection</span><h3>Export the visible signal</h3></div><button type="button" className="button button--secondary" title={exportOpen ? "Hide notification export preview" : "Preview renderer-local notification export"} onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="notification-center-export-preview"><Clipboard size={13} /> {exportOpen ? "Hide export" : "Preview export"}</button></header>
        {exportOpen ? <div id="notification-center-export-preview" className="notification-center-preview__export-body"><div className="notification-center-preview__export-toolbar"><label><span>Format</span><select aria-label="Notification center export format" title="Choose the notification export format" value={format} onChange={(event) => { setFormat(event.target.value as NotificationCenterFormat); setHistoryPreviewId(null); }}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" title="Copy the renderer-local notification export" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" title="Download the renderer-local notification export" onClick={downloadExport}><Download size={13} /> Download</button><button type="button" className="button button--ghost" title="Pin the current notification export in session history" onClick={() => recordExport("snapshot", "Pinned the current notification export preview.")}><History size={13} /> Pin snapshot</button><button type="button" className="button button--ghost" title={exportHistoryOpen ? "Hide notification export history" : "Show notification export history"} onClick={() => setExportHistoryOpen((value) => !value)} aria-expanded={exportHistoryOpen} aria-controls="notification-center-export-history"><History size={13} /> {exportHistoryOpen ? "Hide history" : `History${exportHistory.length ? ` (${exportHistory.length})` : ""}`}</button><button type="button" className="button button--ghost" title={importOpen ? "Hide notification export import" : "Open notification export import"} onClick={() => setImportOpen((value) => !value)} aria-expanded={importOpen}>{importOpen ? "Hide import" : "Import preview"}</button><button type="button" className="button button--ghost" title="Reset the imported notification projection" onClick={resetImportedProjection} disabled={!importedItems}>Reset source</button></div>{importOpen ? <div className="notification-center-preview__import"><div className="notification-center-preview__import-controls" role="group" aria-label="Notification import controls"><label><span>Import mode</span><select aria-label="Notification center import mode" title="Choose whether to replace or merge notification records" value={importMode} onChange={(event) => setImportMode(event.target.value as "replace" | "merge")}><option value="replace">Replace current projection</option><option value="merge">Merge into current projection</option></select></label><span className="notification-center-preview__import-note">JSON only · fail-closed boundary validation</span></div><textarea aria-label="Notification center import payload" title="Paste a JSON notification projection to validate in the renderer preview" value={importPayload} onChange={(event) => setImportPayload(event.target.value)} rows={6} placeholder="Paste a JSON notification projection exported by Omnia here." /><div className="notification-center-preview__import-actions"><button type="button" className="button button--secondary" title="Validate and apply the notification import preview" onClick={applyImportPreview}>Apply import preview</button><button type="button" className="button button--ghost" title="Clear the notification import draft" onClick={() => { setImportPayload(""); setImportStatus("Paste a JSON notification projection to rehearse an import."); }}>Clear draft</button></div><p className="notification-center-preview__import-status" role="status" aria-live="polite">{importStatus}</p></div> : null}<pre tabIndex={0} aria-label={`${historyPreview ? "Historical " : ""}${visibleExportFormat === "json" ? "JSON" : "Markdown"} notification export preview`}>{visibleExportPayload}</pre>{exportHistoryOpen ? <section id="notification-center-export-history" className="notification-center-preview__history" aria-label="Notification export history"><header><div><span className="eyebrow"><History size={13} /> Session history</span><h4>Recent export snapshots</h4><p>Copy, download, or pin actions stay available for this renderer session only.</p></div><button type="button" className="button button--ghost" title="Clear renderer-session notification export history" onClick={clearExportHistory} disabled={exportHistory.length === 0}><Trash2 size={13} /> Clear history</button></header>{exportHistory.length === 0 ? <p className="notification-center-preview__history-empty">No export snapshots retained yet. Pin the current preview to keep a quick comparison point.</p> : <div className="notification-center-preview__history-list" role="list">{exportHistory.map((entry) => <button key={entry.id} type="button" role="listitem" className={historyPreviewId === entry.id ? "is-active" : ""} aria-label={`Inspect ${entry.format.toUpperCase()} notification export snapshot from ${entry.generatedAt}`} title="Inspect this notification export snapshot" aria-pressed={historyPreviewId === entry.id} onClick={() => { setHistoryPreviewId(entry.id); setFormat(entry.format); setExportStatus(`Inspecting ${notificationExportDeliveryLabel(entry.delivery).toLocaleLowerCase()} from the renderer-session export history.`); }}><strong>{entry.format.toUpperCase()} · {notificationExportDeliveryLabel(entry.delivery)}</strong><span>{notificationExportHistorySummary(entry)}</span><small>{entry.generatedAt}</small></button>)}</div>}{historyPreview ? <div className="notification-center-preview__history-selected" role="region" aria-label="Selected historical notification export"><span className="eyebrow">Selected snapshot</span><strong>{notificationExportHistorySummary(historyPreview)}</strong><p>Previewing the retained payload; current filters remain unchanged.</p><button type="button" className="button button--ghost" title="Return to the current notification export preview" onClick={() => setHistoryPreviewId(null)}>Return to current export</button></div> : null}</section> : null}<p className="notification-center-preview__export-status" role="status" aria-live="polite">{exportStatus}</p></div> : null}
      </section>
      <p className="notification-center-preview__boundary"><BellRing size={14} /> Native delivery, durable acknowledgement, OS notifications, provider dispatch, and background scheduling are not connected.</p>
    </section>
  );
}

export default NotificationCenterPreview;
