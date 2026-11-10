import type { ConversationView } from "./types";
import type { RunTimelineEventView } from "./evidence-types";
import type {
  RunCheckpointProjection,
  RunControlOperationProjection,
} from "./run-control-projection";

/**
 * A deliberately bounded projection for the compact background-work strip.
 *
 * The native scheduler/agent/task inspector is not connected to the renderer
 * yet. This module therefore accepts only facts already visible in a Chat or
 * a replayed native run projection. It never manufactures a task, provider
 * request, approval, or durable queue entry from a button click.
 */
export type BackgroundWorkKind =
  | "conversation-run"
  | "run-timeline"
  | "run-control"
  | "checkpoint";

export type BackgroundWorkState =
  | "queued"
  | "running"
  | "waiting"
  | "attention"
  | "completed"
  | "cancelled";

export type BackgroundWorkDurability =
  | "renderer-session"
  | "native-projection"
  | "planned";

export type BackgroundWorkAction = "inspect" | "open-chat";

export interface BackgroundWorkItem {
  readonly id: string;
  readonly kind: BackgroundWorkKind;
  readonly state: BackgroundWorkState;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string | null;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly updatedAt: string;
  readonly durability: BackgroundWorkDurability;
  readonly attention: boolean;
  readonly actions: readonly BackgroundWorkAction[];
}

export interface BackgroundWorkCounts {
  readonly total: number;
  readonly active: number;
  readonly queued: number;
  readonly waiting: number;
  readonly attention: number;
  readonly completed: number;
}

export interface BackgroundWorkProjection {
  readonly schemaVersion: 1;
  readonly items: readonly BackgroundWorkItem[];
  readonly counts: BackgroundWorkCounts;
  readonly generatedAt: string;
  readonly boundary: string;
  readonly missingCapabilities: readonly string[];
}

export interface BackgroundWorkProjectionInput {
  readonly conversations: readonly ConversationView[];
  readonly runTimelineEvents?: readonly RunTimelineEventView[];
  readonly runControlOperations?: readonly RunControlOperationProjection[];
  readonly checkpoints?: readonly RunCheckpointProjection[];
  readonly generatedAt?: string;
}

export const BACKGROUND_WORK_BOUNDARY =
  "Renderer-safe background-work projection. It reflects visible Chat state and replayed native receipts; it does not schedule work, dispatch providers, mutate queues, or claim a durable agent/task runtime.";

const MISSING_CAPABILITIES = Object.freeze([
  "durable task/goal queue",
  "agent/subagent identity and leases",
  "approval inbox",
  "scheduler and trigger persistence",
  "tool, terminal, browser, and artifact event streams",
]);

const ATTENTION_RUN_CONTROL_STATUSES = new Set([
  "blocked",
  "rejected",
  "cancelled",
  "failed",
  "stale-head",
  "payload-drift",
  "reconciliation-required",
]);

function latestTimelineEvents(
  events: readonly RunTimelineEventView[],
): Map<string, RunTimelineEventView> {
  const latest = new Map<string, RunTimelineEventView>();
  for (const event of events) {
    const previous = latest.get(event.runId);
    if (
      previous === undefined ||
      event.sequence > previous.sequence ||
      (event.sequence === previous.sequence && event.id.localeCompare(previous.id) > 0)
    ) {
      latest.set(event.runId, event);
    }
  }
  return latest;
}

function itemPriority(item: BackgroundWorkItem): number {
  if (item.state === "attention") return 0;
  if (item.state === "running") return 1;
  if (item.state === "queued") return 2;
  if (item.state === "waiting") return 3;
  return 4;
}

function safeUpdatedAt(value: string | null | undefined): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return "1970-01-01T00:00:00.000Z";
  }
  return value;
}

function compareItems(left: BackgroundWorkItem, right: BackgroundWorkItem): number {
  return (
    itemPriority(left) - itemPriority(right) ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function itemFromConversation(conversation: ConversationView): BackgroundWorkItem | null {
  if (conversation.runState === null) return null;
  const state: BackgroundWorkState =
    conversation.runState === "streaming"
      ? "running"
      : conversation.runState === "queued"
        ? "queued"
        : "attention";
  const detail =
    state === "running"
      ? "Assistant response is still streaming."
      : state === "queued"
        ? "Waiting for the active run slot."
        : "The last visible run needs attention.";
  return Object.freeze({
    id: `conversation:${conversation.id}`,
    kind: "conversation-run",
    state,
    title: conversation.title || "Untitled Chat",
    subtitle: state === "running" ? "Active Chat" : state === "queued" ? "Queued Chat" : "Run attention",
    detail,
    conversationId: conversation.id,
    runId: null,
    updatedAt: safeUpdatedAt(conversation.updatedAt),
    durability: "renderer-session",
    attention: state === "attention",
    actions: Object.freeze(["inspect", "open-chat"] as const),
  });
}

function itemFromTimeline(
  event: RunTimelineEventView,
  conversationById: ReadonlyMap<string, ConversationView>,
): BackgroundWorkItem {
  const conversation = [...conversationById.values()].find((candidate) =>
    candidate.messages.some((message) => message.runId === event.runId),
  );
  const state: BackgroundWorkState =
    event.status === "failed" || event.status === "warning"
      ? "attention"
      : event.status === "stopped"
        ? "cancelled"
        : event.status === "complete"
          ? "completed"
          : event.status === "pending"
            ? "queued"
            : "running";
  return Object.freeze({
    id: `run:${event.runId}`,
    kind: "run-timeline",
    state,
    title: conversation?.title || event.summary || "Background run",
    subtitle: event.summary,
    detail: event.providerLabel ? `Provider/model: ${event.providerLabel}` : null,
    conversationId: conversation?.id ?? null,
    runId: event.runId,
    updatedAt: safeUpdatedAt(event.endedAt ?? event.startedAt),
    durability: "native-projection",
    attention: state === "attention",
    actions: Object.freeze(
      conversation ? (["inspect", "open-chat"] as const) : (["inspect"] as const),
    ),
  });
}

function itemFromRunControl(
  projection: RunControlOperationProjection,
): BackgroundWorkItem {
  const operation = projection.operation;
  const attention = ATTENTION_RUN_CONTROL_STATUSES.has(projection.status);
  const state: BackgroundWorkState = attention
    ? "attention"
    : projection.status === "resolved"
      ? "waiting"
      : projection.status === "applied" || projection.status === "already-applied"
        ? "completed"
        : "waiting";
  const detail =
    projection.diagnostic ??
    projection.blockedReason ??
    `Run-control operation ${operation.kind.replaceAll("-", " ")}.`;
  return Object.freeze({
    id: `control:${operation.operationId}`,
    kind: "run-control",
    state,
    title: `${operation.kind.replaceAll("-", " ")} request`,
    subtitle: projection.status.replaceAll("-", " "),
    detail,
    conversationId: operation.conversationId,
    runId: operation.sourceRunId,
    updatedAt: safeUpdatedAt(operation.stateBase.resolvedAt || operation.createdAt),
    durability:
      projection.durability === "durable" || projection.durability === "replayed"
        ? "native-projection"
        : "renderer-session",
    attention,
    actions: Object.freeze(["inspect"] as const),
  });
}

function itemFromCheckpoint(
  projection: RunCheckpointProjection,
): BackgroundWorkItem {
  const checkpoint = projection.checkpoint;
  const attention = projection.reconciliationRequired;
  const state: BackgroundWorkState = attention
    ? "attention"
    : checkpoint.status === "paused"
      ? "waiting"
        : checkpoint.status === "checkpointing" || checkpoint.status === "requested" || checkpoint.status === "resuming"
          ? "running"
          : "cancelled";
  return Object.freeze({
    id: `checkpoint:${checkpoint.checkpointId}`,
    kind: "checkpoint",
    state,
    title: "Run checkpoint",
    subtitle: attention ? "Reconciliation required" : checkpoint.status,
    detail: projection.warning,
    conversationId: null,
    runId: checkpoint.runId,
    updatedAt: safeUpdatedAt(checkpoint.createdAt),
    durability: "native-projection",
    attention,
    actions: Object.freeze(["inspect"] as const),
  });
}

function countsFor(items: readonly BackgroundWorkItem[]): BackgroundWorkCounts {
  return Object.freeze({
    total: items.length,
    active: items.filter((item) => item.state === "running").length,
    queued: items.filter((item) => item.state === "queued").length,
    waiting: items.filter((item) => item.state === "waiting").length,
    attention: items.filter((item) => item.attention).length,
    completed: items.filter((item) => item.state === "completed" || item.state === "cancelled").length,
  });
}

/**
 * Builds the compact projection consumed by an attention strip or a future
 * background-work inspector. Duplicate run-timeline/control/checkpoint facts
 * are kept visible because they represent different evidence layers, while
 * conversation cards are suppressed when a native timeline card exists for
 * the same run.
 */
export function projectBackgroundWork(
  input: BackgroundWorkProjectionInput,
): BackgroundWorkProjection {
  const conversationById = new Map(input.conversations.map((conversation) => [conversation.id, conversation]));
  const timelineByRunId = latestTimelineEvents(input.runTimelineEvents ?? []);
  const nativeRunIds = new Set(timelineByRunId.keys());
  const items: BackgroundWorkItem[] = [];

  for (const conversation of input.conversations) {
    const item = itemFromConversation(conversation);
    if (item === null) continue;
    const visibleRunIds = conversation.messages
      .map((message) => message.runId)
      .filter((runId): runId is string => runId !== null);
    if (!visibleRunIds.some((runId) => nativeRunIds.has(runId))) items.push(item);
  }

  for (const event of timelineByRunId.values()) items.push(itemFromTimeline(event, conversationById));
  for (const projection of input.runControlOperations ?? []) items.push(itemFromRunControl(projection));
  for (const projection of input.checkpoints ?? []) items.push(itemFromCheckpoint(projection));

  const ordered = Object.freeze([...items].sort(compareItems));
  return Object.freeze({
    schemaVersion: 1,
    items: ordered,
    counts: countsFor(ordered),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    boundary: BACKGROUND_WORK_BOUNDARY,
    missingCapabilities: MISSING_CAPABILITIES,
  });
}
