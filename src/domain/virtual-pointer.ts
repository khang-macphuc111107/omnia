import { assertDomain } from "./errors";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
} from "./shared";

/** A logical pointer. It never represents or moves the host's physical cursor. */
export type PointerTransport =
  | "semantic"
  | "browser-cdp"
  | "native-uia"
  | "isolated-desktop"
  | "vm"
  | "remote";
export type PointerCoordinateSpace =
  | "screen"
  | "window-client"
  | "browser-viewport"
  | "document"
  | "uia-element"
  | "remote-frame";
export type PointerSessionStatus =
  | "created"
  | "ready"
  | "acting"
  | "waiting-observation"
  | "paused"
  | "yielded"
  | "lost"
  | "closed";
export type PointerHumanPriority = "pause" | "queue" | "ask" | "continue-semantic-only";
export type PointerButton = "left" | "middle" | "right" | "back" | "forward";
export type PointerActionKind =
  | "move-to-element" | "hover-element" | "click-element" | "click-coordinate"
  | "double-click" | "right-click" | "middle-click" | "drag-element" | "drag-path"
  | "scroll-element" | "scroll-viewport" | "focus-element" | "invoke" | "toggle"
  | "expand" | "collapse" | "select-option" | "set-value" | "screenshot"
  | "snapshot-dom" | "snapshot-accessibility-tree" | "yield-to-human" | "pause"
  | "resume" | "stop";
export type PointerActionStatus =
  | "planned" | "policy-checked" | "approval-required" | "approved" | "denied"
  | "target-bound" | "dispatched" | "acknowledged" | "rejected" | "timed-out"
  | "interrupted" | "observed" | "verified" | "outcome-unknown" | "failed";

export interface PointerPosition {
  readonly x: number;
  readonly y: number;
  readonly coordinateSpace: PointerCoordinateSpace;
}

/** Opaque target identity; generations reject stale windows, tabs, or machines. */
export interface PointerTargetBinding {
  readonly targetId: string;
  readonly targetKind: "window" | "process" | "browser-tab" | "webview" | "remote-device" | "virtual-display" | "surface";
  readonly targetGeneration: number;
  readonly targetScopeHash: string;
  readonly processId?: number;
  readonly processStartTime?: IsoTimestamp;
  readonly windowId?: string;
  readonly windowGeneration?: number;
  readonly browserContextId?: string;
  readonly browserTargetId?: string;
  readonly frameId?: string;
  readonly documentEpoch?: string;
  readonly uiaRuntimeId?: string;
  readonly automationId?: string;
  readonly remoteDeviceId?: string;
  readonly machineId?: string;
  readonly machineGeneration?: number;
}

export interface PointerContainment {
  readonly kind: "target-surface" | "element";
  readonly width: number;
  readonly height: number;
  readonly transformRevision: number;
  readonly transformId: string;
  readonly frameId?: string;
  readonly capturedAt?: IsoTimestamp;
}
export interface PointerOverlayPolicy {
  readonly visible: boolean;
  readonly color: string;
  readonly label?: string;
  readonly trail: boolean;
  readonly clickRipple: boolean;
  readonly reducedMotion: boolean;
}
export interface PointerElementAnchor {
  readonly role?: string;
  readonly accessibleName?: string;
  readonly selector?: string;
  readonly automationId?: string;
  readonly boundingBox?: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly semanticFingerprint?: string;
}
export interface PointerAction {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly pointerId: string;
  readonly ownerRunId: string;
  readonly kind: PointerActionKind;
  readonly status: PointerActionStatus;
  readonly transport: PointerTransport;
  readonly targetBinding: PointerTargetBinding;
  readonly transformRevision: number;
  readonly position?: PointerPosition;
  readonly anchor?: PointerElementAnchor;
  readonly buttons?: readonly PointerButton[];
  readonly dryRun: boolean;
  readonly approvalRequired: boolean;
  readonly requestedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly observationId?: string;
  readonly failureReason?: string;
}
export interface PointerSession {
  readonly schemaVersion: 1;
  readonly pointerId: string;
  readonly ownerRunId: string;
  readonly ownerAgentId?: string;
  readonly targetBinding: PointerTargetBinding;
  readonly transport: PointerTransport;
  readonly coordinateSpace: PointerCoordinateSpace;
  readonly position?: PointerPosition;
  readonly targetElement?: PointerElementAnchor;
  readonly containment: PointerContainment;
  readonly overlay: PointerOverlayPolicy;
  readonly status: PointerSessionStatus;
  readonly humanPriority: PointerHumanPriority;
  readonly actions: readonly PointerAction[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly revision: number;
  readonly lastActionId?: string;
}
export interface CreatePointerSessionInput {
  readonly schemaVersion?: 1;
  readonly pointerId: string;
  readonly ownerRunId: string;
  readonly ownerAgentId?: string;
  readonly targetBinding: PointerTargetBinding;
  readonly transport: PointerTransport;
  readonly coordinateSpace: PointerCoordinateSpace;
  readonly position?: PointerPosition;
  readonly targetElement?: PointerElementAnchor;
  readonly containment: PointerContainment;
  readonly overlay?: Partial<PointerOverlayPolicy>;
  readonly humanPriority?: PointerHumanPriority;
  readonly createdAt: IsoTimestamp;
}
export interface CreatePointerActionInput {
  readonly schemaVersion?: 1;
  readonly id: string;
  readonly ownerRunId?: string;
  readonly kind: PointerActionKind;
  readonly transport?: PointerTransport;
  readonly targetBinding?: PointerTargetBinding;
  readonly transformRevision?: number;
  readonly position?: PointerPosition;
  readonly anchor?: PointerElementAnchor;
  readonly buttons?: readonly PointerButton[];
  readonly dryRun?: boolean;
  readonly approvalRequired?: boolean;
  readonly requestedAt?: IsoTimestamp;
  readonly status?: PointerActionStatus;
}

const transports = new Set<PointerTransport>(["semantic", "browser-cdp", "native-uia", "isolated-desktop", "vm", "remote"]);
const spaces = new Set<PointerCoordinateSpace>(["screen", "window-client", "browser-viewport", "document", "uia-element", "remote-frame"]);
const sessionStatuses = new Set<PointerSessionStatus>(["created", "ready", "acting", "waiting-observation", "paused", "yielded", "lost", "closed"]);
const priorities = new Set<PointerHumanPriority>(["pause", "queue", "ask", "continue-semantic-only"]);
const buttons = new Set<PointerButton>(["left", "middle", "right", "back", "forward"]);
const targetKinds = new Set<PointerTargetBinding["targetKind"]>(["window", "process", "browser-tab", "webview", "remote-device", "virtual-display", "surface"]);
const actionKinds = new Set<PointerActionKind>([
  "move-to-element", "hover-element", "click-element", "click-coordinate", "double-click", "right-click", "middle-click", "drag-element", "drag-path", "scroll-element", "scroll-viewport", "focus-element", "invoke", "toggle", "expand", "collapse", "select-option", "set-value", "screenshot", "snapshot-dom", "snapshot-accessibility-tree", "yield-to-human", "pause", "resume", "stop",
]);
const actionStatuses = new Set<PointerActionStatus>([
  "planned", "policy-checked", "approval-required", "approved", "denied", "target-bound", "dispatched", "acknowledged", "rejected", "timed-out", "interrupted", "observed", "verified", "outcome-unknown", "failed",
]);
const idMax = 256;
const reasonMax = 1_000;
const actionMax = 10_000;

function freeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach((entry) => freeze(entry));
  else if (value !== null && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((entry) => freeze(entry));
  return Object.freeze(value);
}
function enumValue<T extends string>(set: ReadonlySet<T>, value: T, label: string): T {
  assertDomain(set.has(value), "invalid_argument", `Unknown ${label}.`, { label, value });
  return value;
}
function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", `${label} must be an object.`);
}
function anchor(value: PointerElementAnchor): PointerElementAnchor {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", "Pointer element anchor must be an object.");
  assertDomain(Object.keys(value).length > 0, "invalid_argument", "Pointer element anchor cannot be empty.");
  const record = value as unknown as Record<string, unknown>;
  assertKnownKeys(record, ["role", "accessibleName", "selector", "automationId", "boundingBox", "semanticFingerprint"], "pointer anchor");
  const textFields: readonly [keyof Pick<PointerElementAnchor, "role" | "accessibleName" | "selector" | "automationId" | "semanticFingerprint">, string][] = [
    ["role", "pointer anchor role"],
    ["accessibleName", "pointer anchor accessible name"],
    ["selector", "pointer anchor selector"],
    ["automationId", "pointer anchor automation ID"],
    ["semanticFingerprint", "pointer anchor fingerprint"],
  ];
  for (const [field, label] of textFields) {
    const text = record[field];
    if (text !== undefined) {
      assertDomain(typeof text === "string", "invalid_argument", `${label} must be a string.`);
      assertNonBlank(text as string, label, idMax);
    }
  }
  const boxValue = record.boundingBox;
  if (boxValue !== undefined) {
    assertDomain(boxValue !== null && typeof boxValue === "object" && !Array.isArray(boxValue), "invalid_argument", "Pointer anchor bounds must be an object.");
    const box = boxValue as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    assertDomain([box.x, box.y, box.width, box.height].every((entry) => typeof entry === "number" && Number.isFinite(entry)), "invalid_argument", "Pointer anchor bounds must be finite.");
    assertDomain((box.width as number) > 0 && (box.height as number) > 0, "invalid_argument", "Pointer anchor dimensions must be positive.");
  }
  return freeze({ ...value });
}
function target(value: PointerTargetBinding): PointerTargetBinding {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", "Pointer target binding must be an object.");
  assertKnownKeys(value, ["targetId", "targetKind", "targetGeneration", "targetScopeHash", "processId", "processStartTime", "windowId", "windowGeneration", "browserContextId", "browserTargetId", "frameId", "documentEpoch", "uiaRuntimeId", "automationId", "remoteDeviceId", "machineId", "machineGeneration"], "pointer target");
  enumValue(targetKinds, value.targetKind, "pointer target kind");
  assertNonBlank(value.targetId, "pointer target ID", idMax);
  assertIntegerInRange(value.targetGeneration, "pointer target generation", 0, Number.MAX_SAFE_INTEGER);
  assertNonBlank(value.targetScopeHash, "pointer target scope hash", idMax);
  if (value.processId !== undefined) assertIntegerInRange(value.processId, "pointer process ID", 0, 2 ** 31 - 1);
  if (value.processStartTime !== undefined) assertIsoTimestamp(value.processStartTime, "pointer process start time");
  if (value.windowGeneration !== undefined) assertIntegerInRange(value.windowGeneration, "pointer window generation", 0, Number.MAX_SAFE_INTEGER);
  if (value.machineGeneration !== undefined) assertIntegerInRange(value.machineGeneration, "pointer machine generation", 0, Number.MAX_SAFE_INTEGER);
  Object.entries(value).forEach(([key, entry]) => {
    if (entry !== undefined && typeof entry === "string") assertNonBlank(entry, `pointer ${key}`, idMax);
  });
  return freeze({ ...value, targetId: value.targetId.trim(), targetScopeHash: value.targetScopeHash.trim() });
}
function containment(value: PointerContainment): PointerContainment {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", "Pointer containment must be an object.");
  assertKnownKeys(value, ["kind", "width", "height", "transformRevision", "transformId", "frameId", "capturedAt"], "pointer containment");
  enumValue(new Set(["target-surface", "element"] as const), value.kind, "pointer containment kind");
  assertIntegerInRange(value.width, "pointer containment width", 1, 1_000_000);
  assertIntegerInRange(value.height, "pointer containment height", 1, 1_000_000);
  assertIntegerInRange(value.transformRevision, "pointer transform revision", 0, Number.MAX_SAFE_INTEGER);
  assertNonBlank(value.transformId, "pointer transform ID", idMax);
  if (value.frameId !== undefined) assertNonBlank(value.frameId, "pointer frame ID", idMax);
  if (value.capturedAt !== undefined) assertIsoTimestamp(value.capturedAt, "pointer transform capture time");
  return freeze({ ...value, transformId: value.transformId.trim() });
}
function position(value: PointerPosition, bounds: PointerContainment): PointerPosition {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", "Pointer position must be an object.");
  enumValue(spaces, value.coordinateSpace, "pointer coordinate space");
  assertDomain(Number.isFinite(value.x) && Number.isFinite(value.y), "invalid_argument", "Pointer coordinates must be finite.");
  if (value.coordinateSpace !== "uia-element") {
    assertDomain(value.x >= 0 && value.x <= bounds.width && value.y >= 0 && value.y <= bounds.height, "invalid_argument", "Pointer coordinates must remain inside target containment.");
  }
  return freeze({ ...value });
}
function overlay(value: Partial<PointerOverlayPolicy> | undefined): PointerOverlayPolicy {
  if (value !== undefined) {
    assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", "Pointer overlay must be an object.");
    assertKnownKeys(value, ["visible", "color", "label", "trail", "clickRipple", "reducedMotion"], "pointer overlay");
  }
  const color = value?.color ?? "#23d5ff";
  assertNonBlank(color, "pointer overlay color", idMax);
  if (value?.label !== undefined) assertNonBlank(value.label, "pointer overlay label", idMax);
  for (const [label, entry] of [
    ["visible", value?.visible],
    ["trail", value?.trail],
    ["clickRipple", value?.clickRipple],
    ["reducedMotion", value?.reducedMotion],
  ] as const) {
    if (entry !== undefined) assertDomain(typeof entry === "boolean", "invalid_argument", `Pointer overlay ${label} must be a boolean.`);
  }
  return freeze({ visible: value?.visible ?? true, color: color.trim(), ...(value?.label === undefined ? {} : { label: value.label.trim() }), trail: value?.trail ?? false, clickRipple: value?.clickRipple ?? true, reducedMotion: value?.reducedMotion ?? false });
}
function sameTarget(left: PointerTargetBinding, right: PointerTargetBinding): boolean {
  const fields: readonly (keyof PointerTargetBinding)[] = [
    "targetId", "targetKind", "targetGeneration", "targetScopeHash", "processId", "processStartTime",
    "windowId", "windowGeneration", "browserContextId", "browserTargetId", "frameId", "documentEpoch",
    "uiaRuntimeId", "automationId", "remoteDeviceId", "machineId", "machineGeneration",
  ];
  return fields.every((field) => left[field] === right[field]);
}
function assertKnownKeys(value: unknown, allowed: readonly string[], label: string): void {
  assertObject(value, `Pointer ${label}`);
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    assertDomain(keys.has(key), "invalid_argument", `Unknown ${label} field: ${key}.`, { field: key });
  }
}
function buttonsOf(value: readonly PointerButton[]): readonly PointerButton[] {
  const result = value.map((entry) => enumValue(buttons, entry, "pointer button"));
  assertDomain(new Set(result).size === result.length, "invalid_argument", "Pointer buttons must be unique.");
  return freeze([...result]);
}
function validateAction(value: PointerAction, session: PointerSession): PointerAction {
  assertDomain(value.schemaVersion === 1, "invalid_argument", "Unsupported pointer action schema.");
  assertNonBlank(value.id, "pointer action ID", idMax);
  assertDomain(value.pointerId === session.pointerId, "scope_violation", "Pointer action belongs to another pointer session.");
  assertDomain(value.ownerRunId === session.ownerRunId, "scope_violation", "Pointer action belongs to another run.");
  enumValue(actionKinds, value.kind, "pointer action kind");
  enumValue(actionStatuses, value.status, "pointer action status");
  enumValue(transports, value.transport, "pointer transport");
  const normalizedTarget = target(value.targetBinding);
  assertDomain(sameTarget(normalizedTarget, session.targetBinding), "scope_violation", "Pointer action target binding is stale or outside the session scope.");
  assertIntegerInRange(value.transformRevision, "pointer action transform revision", 0, Number.MAX_SAFE_INTEGER);
  assertDomain(value.transformRevision === session.containment.transformRevision, "conflict", "Pointer action uses a stale coordinate transform.", { expected: session.containment.transformRevision, actual: value.transformRevision });
  assertDomain(typeof value.dryRun === "boolean", "invalid_argument", "Pointer action dryRun must be a boolean.");
  assertDomain(typeof value.approvalRequired === "boolean", "invalid_argument", "Pointer action approvalRequired must be a boolean.");
  assertIsoTimestamp(value.requestedAt, "pointer action request time");
  assertIsoTimestamp(value.updatedAt, "pointer action update time");
  assertDomain(Date.parse(value.updatedAt) >= Date.parse(value.requestedAt), "invalid_argument", "Pointer action timestamps cannot move backwards.");
  const normalizedPosition = value.position === undefined ? undefined : position(value.position, session.containment);
  if (normalizedPosition !== undefined) {
    assertDomain(normalizedPosition.coordinateSpace === session.coordinateSpace, "invalid_argument", "Pointer action coordinate space must match the session coordinate space.");
  }
  const normalizedAnchor = value.anchor === undefined ? undefined : anchor(value.anchor);
  const normalizedButtons = value.buttons === undefined ? undefined : buttonsOf(value.buttons);
  if (value.observationId !== undefined) assertNonBlank(value.observationId, "pointer observation ID", idMax);
  if (value.failureReason !== undefined) assertNonBlank(value.failureReason, "pointer action failure reason", reasonMax);
  return freeze({
    ...value,
    targetBinding: normalizedTarget,
    ...(normalizedPosition === undefined ? {} : { position: normalizedPosition }),
    ...(normalizedAnchor === undefined ? {} : { anchor: normalizedAnchor }),
    ...(normalizedButtons === undefined ? {} : { buttons: normalizedButtons }),
  });
}

export function createPointerSession(input: CreatePointerSessionInput): PointerSession {
  assertDomain(input.schemaVersion === undefined || input.schemaVersion === 1, "invalid_argument", "Unsupported pointer session schema.");
  assertIsoTimestamp(input.createdAt, "pointer session creation time");
  enumValue(transports, input.transport, "pointer transport");
  enumValue(spaces, input.coordinateSpace, "pointer coordinate space");
  enumValue(priorities, input.humanPriority ?? "pause", "pointer human-priority policy");
  const bounds = containment(input.containment);
  const normalizedPosition = input.position === undefined ? undefined : position(input.position, bounds);
  if (normalizedPosition !== undefined) assertDomain(normalizedPosition.coordinateSpace === input.coordinateSpace, "invalid_argument", "Pointer position coordinate space must match the session coordinate space.");
  assertNonBlank(input.pointerId, "pointer ID", idMax);
  assertNonBlank(input.ownerRunId, "pointer owner run ID", idMax);
  if (input.ownerAgentId !== undefined) assertNonBlank(input.ownerAgentId, "pointer owner agent ID", idMax);
  return freeze({ schemaVersion: 1, pointerId: input.pointerId.trim(), ownerRunId: input.ownerRunId.trim(), ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId.trim() }), targetBinding: target(input.targetBinding), transport: input.transport, coordinateSpace: input.coordinateSpace, ...(normalizedPosition === undefined ? {} : { position: normalizedPosition }), ...(input.targetElement === undefined ? {} : { targetElement: anchor(input.targetElement) }), containment: bounds, overlay: overlay(input.overlay), status: "created", humanPriority: input.humanPriority ?? "pause", actions: freeze([]), createdAt: input.createdAt, updatedAt: input.createdAt, revision: 0 });
}

export type PointerSessionTransition = "ready" | "begin-action" | "await-observation" | "pause" | "resume" | "yield" | "rebind" | "lose-target" | "close";
export function transitionPointerSession(session: PointerSession, transition: PointerSessionTransition, at: IsoTimestamp): PointerSession {
  assertIsoTimestamp(at, "pointer session transition time");
  assertDomain(Date.parse(at) >= Date.parse(session.updatedAt), "invalid_argument", "Pointer session timestamps cannot move backwards.");
  const next: PointerSessionStatus = transition === "ready" || transition === "resume" || transition === "rebind" ? "ready" : transition === "begin-action" ? "acting" : transition === "await-observation" ? "waiting-observation" : transition === "pause" ? "paused" : transition === "yield" ? "yielded" : transition === "lose-target" ? "lost" : "closed";
  const allowed: Readonly<Record<PointerSessionStatus, readonly PointerSessionStatus[]>> = { created: ["ready", "paused", "lost", "closed"], ready: ["acting", "paused", "yielded", "lost", "closed"], acting: ["waiting-observation", "paused", "yielded", "lost", "closed"], "waiting-observation": ["ready", "paused", "yielded", "lost", "closed"], paused: ["ready", "yielded", "lost", "closed"], yielded: ["ready", "paused", "lost", "closed"], lost: ["ready", "closed"], closed: [] };
  assertDomain(allowed[session.status].includes(next), "invalid_state_transition", `Pointer session cannot transition from ${session.status} to ${next}.`);
  return freeze({ ...session, status: next, updatedAt: at, revision: session.revision + 1 });
}

export function appendPointerAction(session: PointerSession, input: CreatePointerActionInput | PointerAction, at = ("updatedAt" in input ? input.updatedAt : undefined) ?? new Date().toISOString()): PointerSession {
  assertIsoTimestamp(at, "pointer action append time");
  assertDomain(session.status !== "closed", "invalid_state_transition", "Cannot append an action to a closed pointer session.");
  assertDomain(Date.parse(at) >= Date.parse(session.updatedAt), "invalid_argument", "Pointer action append time cannot move backwards.");
  const action: PointerAction = "pointerId" in input ? input : { schemaVersion: 1, id: input.id, pointerId: session.pointerId, ownerRunId: input.ownerRunId ?? session.ownerRunId, kind: input.kind, status: input.status ?? (input.dryRun ? "planned" : input.approvalRequired ? "approval-required" : "policy-checked"), transport: input.transport ?? session.transport, targetBinding: input.targetBinding ?? session.targetBinding, transformRevision: input.transformRevision ?? session.containment.transformRevision, ...(input.position === undefined ? {} : { position: input.position }), ...(input.anchor === undefined ? {} : { anchor: input.anchor }), ...(input.buttons === undefined ? {} : { buttons: input.buttons }), dryRun: input.dryRun ?? false, approvalRequired: input.approvalRequired ?? false, requestedAt: input.requestedAt ?? at, updatedAt: at };
  assertDomain(!session.actions.some((entry) => entry.id === action.id), "conflict", "Pointer action ID already exists in this session.");
  assertDomain(session.actions.length < actionMax, "invalid_argument", `Pointer sessions cannot contain more than ${actionMax} actions.`);
  assertDomain(Date.parse(action.requestedAt) >= Date.parse(session.updatedAt), "invalid_argument", "Pointer action request time cannot predate the session update.");
  assertDomain(Date.parse(action.updatedAt) <= Date.parse(at), "invalid_argument", "Pointer action update time cannot exceed its append time.");
  const normalized = validateAction(action, session);
  const nextStatus = normalized.status === "dispatched" || normalized.status === "acknowledged" ? "acting" : normalized.status === "observed" || normalized.status === "verified" ? "waiting-observation" : session.status;
  return freeze({ ...session, status: nextStatus, ...(normalized.position === undefined ? {} : { position: normalized.position }), actions: freeze([...session.actions, normalized]), lastActionId: normalized.id, updatedAt: at, revision: session.revision + 1 });
}

export function parsePointerSession(value: unknown): PointerSession {
  assertDomain(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_argument", "Pointer session must be an object.");
  const input = value as PointerSession;
  assertKnownKeys(input, ["schemaVersion", "pointerId", "ownerRunId", "ownerAgentId", "targetBinding", "transport", "coordinateSpace", "position", "targetElement", "containment", "overlay", "status", "humanPriority", "actions", "createdAt", "updatedAt", "revision", "lastActionId"], "pointer session");
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported pointer session schema.");
  const base = createPointerSession({ schemaVersion: 1, pointerId: input.pointerId, ownerRunId: input.ownerRunId, ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId }), targetBinding: input.targetBinding, transport: input.transport, coordinateSpace: input.coordinateSpace, ...(input.position === undefined ? {} : { position: input.position }), ...(input.targetElement === undefined ? {} : { targetElement: input.targetElement }), containment: input.containment, ...(input.overlay === undefined ? {} : { overlay: input.overlay }), ...(input.humanPriority === undefined ? {} : { humanPriority: input.humanPriority }), createdAt: input.createdAt });
  enumValue(sessionStatuses, input.status, "pointer session status");
  assertIsoTimestamp(input.updatedAt, "pointer session update time");
  assertIntegerInRange(input.revision, "pointer session revision", 0, Number.MAX_SAFE_INTEGER);
  assertDomain(Array.isArray(input.actions), "invalid_argument", "Persisted pointer actions must be an array.");
  assertDomain(input.actions.length <= actionMax, "invalid_argument", `Pointer sessions cannot contain more than ${actionMax} actions.`);
  assertDomain(input.revision >= input.actions.length, "invalid_argument", "Pointer session revision cannot be lower than its action count.");
  let result = freeze({ ...base, status: input.status, updatedAt: input.updatedAt, revision: input.revision });
  const seenActionIds = new Set<string>();
  let previousActionAt = input.createdAt;
  for (const entry of input.actions) {
    assertDomain(entry !== null && typeof entry === "object" && !Array.isArray(entry), "invalid_argument", "Persisted pointer action must be an object.");
    assertKnownKeys(entry, ["schemaVersion", "id", "pointerId", "ownerRunId", "kind", "status", "transport", "targetBinding", "transformRevision", "position", "anchor", "buttons", "dryRun", "approvalRequired", "requestedAt", "updatedAt", "observationId", "failureReason"], "pointer action");
    const action = validateAction(entry as PointerAction, result);
    assertDomain(Date.parse(action.requestedAt) >= Date.parse(previousActionAt), "invalid_argument", "Pointer action history cannot move backwards.");
    assertDomain(Date.parse(action.updatedAt) <= Date.parse(input.updatedAt), "invalid_argument", "Pointer action update cannot occur after the session update.");
    previousActionAt = action.updatedAt;
    assertDomain(!seenActionIds.has(action.id), "conflict", "Persisted pointer action IDs must be unique.", { actionId: action.id });
    seenActionIds.add(action.id);
    result = freeze({ ...result, actions: freeze([...result.actions, action]), lastActionId: action.id });
  }
  if (input.lastActionId !== undefined) assertDomain(result.lastActionId === input.lastActionId, "invalid_argument", "Persisted pointer lastActionId does not match its action history.");
  return result;
}
export function serializePointerSession(session: PointerSession): string { return JSON.stringify(parsePointerSession(session)); }

export interface PointerSessionStorage {
  load(pointerId: string): Promise<PointerSession | null>;
  list(ownerRunId?: string): Promise<readonly PointerSession[]>;
  save(session: PointerSession, expectedRevision?: number): Promise<{ readonly status: "saved"; readonly revision: number } | { readonly status: "conflict"; readonly currentRevision: number | null; readonly expectedRevision: number | null }>;
  remove(pointerId: string, expectedRevision?: number): Promise<boolean>;
}
export class InMemoryPointerSessionStorage implements PointerSessionStorage {
  private readonly values = new Map<string, string>();
  async load(pointerId: string): Promise<PointerSession | null> { const id = assertNonBlank(pointerId, "pointer ID", idMax); const value = this.values.get(id); return value === undefined ? null : parsePointerSession(JSON.parse(value)); }
  async list(ownerRunId?: string): Promise<readonly PointerSession[]> { if (ownerRunId !== undefined) assertNonBlank(ownerRunId, "pointer owner run ID", idMax); return freeze([...this.values.values()].map((value) => parsePointerSession(JSON.parse(value))).filter((session) => ownerRunId === undefined || session.ownerRunId === ownerRunId)); }
  async save(session: PointerSession, expectedRevision?: number): Promise<{ readonly status: "saved"; readonly revision: number } | { readonly status: "conflict"; readonly currentRevision: number | null; readonly expectedRevision: number | null }> {
    const parsed = parsePointerSession(session);
    if (expectedRevision !== undefined) assertIntegerInRange(expectedRevision, "expected pointer revision", 0, Number.MAX_SAFE_INTEGER);
    const old = this.values.get(parsed.pointerId);
    const currentRevision = old === undefined ? null : parsePointerSession(JSON.parse(old)).revision;
    // Revision zero is the explicit compare-and-swap token for an empty
    // pointer record. This keeps first-write CAS useful without requiring a
    // nullable renderer value.
    if (expectedRevision !== undefined && !(expectedRevision === 0 && currentRevision === null) && expectedRevision !== currentRevision) return freeze({ status: "conflict", currentRevision, expectedRevision });
    this.values.set(parsed.pointerId, serializePointerSession(parsed));
    return freeze({ status: "saved", revision: parsed.revision });
  }
  async remove(pointerId: string, expectedRevision?: number): Promise<boolean> {
    const id = assertNonBlank(pointerId, "pointer ID", idMax); const old = this.values.get(id); if (old === undefined) return false;
    if (expectedRevision !== undefined) { assertIntegerInRange(expectedRevision, "expected pointer revision", 0, Number.MAX_SAFE_INTEGER); const current = parsePointerSession(JSON.parse(old)).revision; assertDomain(current === expectedRevision, "conflict", "Pointer session revision changed before removal.", { expectedRevision, currentRevision: current }); }
    this.values.delete(id); return true;
  }
}
export function createInMemoryPointerSessionStorage(): InMemoryPointerSessionStorage { return new InMemoryPointerSessionStorage(); }
