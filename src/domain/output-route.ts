import { assertDomain } from "./errors";
import type {
  BranchId,
  ConversationId,
  ProfileId,
  ProjectId,
  RunId,
  TaskId,
} from "./ids";
import { assertIntegerInRange, assertNonBlank } from "./shared";

/**
 * The committed event position at which a producer was created.
 *
 * Event cursors are deliberately represented as a non-negative safe integer
 * at the renderer boundary. Native transports may encode the value as an
 * opaque token, but the projection must still be monotonic and comparable.
 */
export type EventCursor = number;

/**
 * Immutable destination captured before a run, background producer, or
 * subagent starts work.
 *
 * `activeBranchId` or any other navigation state is intentionally absent:
 * changing the visible branch cannot redirect an existing producer.
 */
export interface OutputRoute {
  readonly profileId: ProfileId;
  readonly projectId?: ProjectId;
  readonly conversationId: ConversationId;
  readonly branchId: BranchId;
  readonly taskId?: TaskId;
  readonly runId: RunId;
  readonly producerId: string;
  readonly createdAtCursor: EventCursor;
}

const OUTPUT_ROUTE_KEYS = [
  "profileId",
  "projectId",
  "conversationId",
  "branchId",
  "taskId",
  "runId",
  "producerId",
  "createdAtCursor",
] as const;

type OutputRouteRecord = Record<string, unknown>;

function isRecord(value: unknown): value is OutputRouteRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: OutputRouteRecord): void {
  const allowed = new Set<string>(OUTPUT_ROUTE_KEYS);
  for (const key of Object.keys(value)) {
    assertDomain(allowed.has(key), "invalid_argument", `Unknown output route field: ${key}.`, {
      field: key,
    });
  }
}

function assertRouteId(value: unknown, label: string): asserts value is string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} is required.`, { label });
  assertNonBlank(value, label, 512);
}

function assertOptionalRouteId(value: unknown, label: string): void {
  assertDomain(
    value === undefined || typeof value === "string",
    "invalid_argument",
    `${label} must be a string when provided.`,
    { label },
  );
  if (value !== undefined) assertNonBlank(value, label, 512);
}

function normalizeRouteId<T extends string>(value: T, label: string): T {
  return assertNonBlank(value, label, 512) as T;
}

/** Validates the monotonic event position captured by a producer. */
export function assertEventCursor(value: unknown, label = "Event cursor"): asserts value is EventCursor {
  assertDomain(
    typeof value === "number" && Number.isSafeInteger(value),
    "invalid_argument",
    `${label} must be a safe integer.`,
    { value, label },
  );
  assertIntegerInRange(value, label, 0, Number.MAX_SAFE_INTEGER);
}

/** Parses an event cursor received from a transport or persistence layer. */
export function parseEventCursor(value: unknown, label = "Event cursor"): EventCursor {
  assertEventCursor(value, label);
  return value;
}

/** Throws when a value does not satisfy the immutable output-route contract. */
export function assertOutputRoute(value: unknown): asserts value is OutputRoute {
  assertDomain(isRecord(value), "invalid_argument", "Output route must be an object.");
  assertKnownKeys(value);
  assertRouteId(value.profileId, "Output route profile ID");
  assertOptionalRouteId(value.projectId, "Output route project ID");
  assertRouteId(value.conversationId, "Output route conversation ID");
  assertRouteId(value.branchId, "Output route branch ID");
  assertOptionalRouteId(value.taskId, "Output route task ID");
  assertRouteId(value.runId, "Output route run ID");
  assertRouteId(value.producerId, "Output route producer ID");
  assertEventCursor(value.createdAtCursor, "Output route creation cursor");
}

/**
 * Creates a deeply immutable (flat primitive) route snapshot. The returned
 * object is safe to retain in a run and to pass across renderer boundaries.
 */
export function createOutputRoute(input: OutputRoute): OutputRoute {
  assertOutputRoute(input);
  return Object.freeze({
    profileId: normalizeRouteId(input.profileId, "Output route profile ID"),
    ...(input.projectId === undefined
      ? {}
      : { projectId: normalizeRouteId(input.projectId, "Output route project ID") }),
    conversationId: normalizeRouteId(input.conversationId, "Output route conversation ID"),
    branchId: normalizeRouteId(input.branchId, "Output route branch ID"),
    ...(input.taskId === undefined
      ? {}
      : { taskId: normalizeRouteId(input.taskId, "Output route task ID") }),
    runId: normalizeRouteId(input.runId, "Output route run ID"),
    producerId: assertNonBlank(input.producerId, "Output route producer ID", 512),
    createdAtCursor: input.createdAtCursor,
  });
}

/** Alias used by callers that make the immutability boundary explicit. */
export function freezeOutputRoute(input: OutputRoute): OutputRoute {
  return createOutputRoute(input);
}

/** Parses and freezes a route received over IPC, persistence, or import. */
export function parseOutputRoute(value: unknown): OutputRoute {
  assertOutputRoute(value);
  return createOutputRoute(value);
}

/** Non-throwing shape guard for untrusted transport values. */
export function isOutputRoute(value: unknown): value is OutputRoute {
  try {
    assertOutputRoute(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a deterministic identity key for a route. It includes every route
 * field, including the creation cursor, so two producers cannot accidentally
 * share a destination identity after a replay or branch fork.
 */
export function outputRouteKey(route: OutputRoute): string {
  const canonical = createOutputRoute(route);
  return JSON.stringify([
    canonical.profileId,
    canonical.projectId ?? null,
    canonical.conversationId,
    canonical.branchId,
    canonical.taskId ?? null,
    canonical.runId,
    canonical.producerId,
    canonical.createdAtCursor,
  ]);
}

/** Compares two immutable routes without depending on object identity. */
export function outputRoutesEqual(left: OutputRoute, right: OutputRoute): boolean {
  return outputRouteKey(left) === outputRouteKey(right);
}

