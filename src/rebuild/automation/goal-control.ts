import { AutomationDomainError, clone, json, object, readReplay, record, stableJson, text, uniqueIds } from "./common";

/**
 * Runtime-neutral control plane for goals, plans, prompts, tasks and queue
 * entries.  It is deliberately independent from the provider scheduler:
 * applying a planning revision is observable here, while a live-run change is
 * only `queued`/`deferred` until an adapter returns a receipt.
 */

export type ControlTargetKind = "goal" | "plan" | "prompt" | "task" | "queue" | "run";
export type ControlRunState = "not-started" | "idle" | "running" | "paused" | "terminal";
export type ControlAction =
  | "set-goal"
  | "edit-goal"
  | "remove-goal"
  | "queue"
  | "add-task"
  | "remove-task"
  | "steer"
  | "reorder"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "reconcile";
export type ControlDecision = "applied" | "queued" | "deferred" | "rejected" | "unknown";
export type ControlEffect = "read" | "reversible-write" | "execution-control" | "external-communication";
export type ActiveRunPolicy = "apply-at-safe-boundary" | "interrupt-new-attempt" | "queue-after-terminal" | "fork-parallel" | "not-applicable";

export interface ControlActor {
  kind: "user" | "agent" | "automation" | "recovery";
  principalId: string;
  delegationId?: string;
}

export interface GoalControlCommand {
  schemaVersion: 1;
  controlId: string;
  idempotencyKey: string;
  actor: ControlActor;
  target: { kind: ControlTargetKind; id: string };
  action: ControlAction;
  patch?: Record<string, unknown>;
  expectedVersion: number;
  runState: ControlRunState;
  activeRunPolicy: ActiveRunPolicy;
  effect: ControlEffect;
  requestedAtMs: number;
  reason: string;
}

export interface RuntimeCapabilities {
  steer: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  retry: boolean;
}

export interface ControlEntity {
  id: string;
  kind: ControlTargetKind;
  version: number;
  status: "draft" | "queued" | "active" | "paused" | "cancellation-requested" | "cancelled" | "completed" | "superseded";
  runState: ControlRunState;
  objective?: string;
  prompt?: string;
  taskIds: string[];
  metadata: Record<string, unknown>;
  tombstoned: boolean;
}

export interface ControlReceipt {
  schemaVersion: 1;
  controlId: string;
  idempotencyKey: string;
  decision: ControlDecision;
  target: { kind: ControlTargetKind; id: string };
  before: { version: number | null; status: ControlEntity["status"] | "missing"; runState: ControlRunState | null };
  after: { version: number | null; status: ControlEntity["status"] | "missing"; runState: ControlRunState | null };
  affectedIds: string[];
  canonicalPayloadHash: string;
  executionDisposition: "applied" | "queued" | "not-admitted" | "unknown";
  invalidation: { required: boolean; reason: string | null };
  /** A domain receipt is not proof of persistence in native storage. */
  durable: false;
  replayed: boolean;
  diagnostic: string | null;
  createdAtMs: number;
}

interface ControlEnvelope {
  schemaVersion: 1;
  kind: "goal-control";
  initial: RuntimeCapabilities;
  events: GoalControlCommand[];
  state: ControlEntity[];
}

const MAX_EVENTS = 4_096;
const MAX_ENTITIES = 1_024;
const MAX_TEXT = 16_384;
const DEFAULT_CAPABILITIES: RuntimeCapabilities = { steer: false, pause: false, resume: false, cancel: false, retry: false };

function id(value: unknown, field: string): string {
  const result = text(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) throw new AutomationDomainError("invalid_input", `${field} has an invalid identifier`);
  return result;
}

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AutomationDomainError("invalid_input", `${field} must be a non-negative safe integer`);
  return value;
}

function canonicalHash(value: unknown): string {
  // This is a local dedupe fingerprint. Native authorization still computes
  // its own cryptographic hash before a command can mutate durable storage.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(stableJson(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a-64:${hash.toString(16).padStart(16, "0")}`;
}

function capabilities(value: Partial<RuntimeCapabilities> | undefined): RuntimeCapabilities {
  const source = value ?? DEFAULT_CAPABILITIES;
  return { steer: Boolean(source.steer), pause: Boolean(source.pause), resume: Boolean(source.resume), cancel: Boolean(source.cancel), retry: Boolean(source.retry) };
}

function before(entity: ControlEntity | undefined): ControlReceipt["before"] {
  return entity ? { version: entity.version, status: entity.status, runState: entity.runState } : { version: null, status: "missing", runState: null };
}

function validateCommand(input: GoalControlCommand): GoalControlCommand {
  const value = object(input, ["schemaVersion", "controlId", "idempotencyKey", "actor", "target", "action", "patch", "expectedVersion", "runState", "activeRunPolicy", "effect", "requestedAtMs", "reason"], "control command");
  if (value.schemaVersion !== 1) throw new AutomationDomainError("invalid_input", "Unsupported control command schema");
  const actorValue = object(value.actor, ["kind", "principalId", "delegationId"], "actor");
  const targetValue = object(value.target, ["kind", "id"], "target");
  const actorKind = actorValue.kind;
  if (actorKind !== "user" && actorKind !== "agent" && actorKind !== "automation" && actorKind !== "recovery") throw new AutomationDomainError("invalid_input", "Invalid actor kind");
  const targetKind = targetValue.kind;
  if (targetKind !== "goal" && targetKind !== "plan" && targetKind !== "prompt" && targetKind !== "task" && targetKind !== "queue" && targetKind !== "run") throw new AutomationDomainError("invalid_input", "Invalid target kind");
  const action = value.action;
  const actions: ControlAction[] = ["set-goal", "edit-goal", "remove-goal", "queue", "add-task", "remove-task", "steer", "reorder", "pause", "resume", "cancel", "retry", "reconcile"];
  if (typeof action !== "string" || !actions.includes(action as ControlAction)) throw new AutomationDomainError("invalid_input", "Invalid control action");
  const runState = value.runState;
  const runStates: ControlRunState[] = ["not-started", "idle", "running", "paused", "terminal"];
  if (typeof runState !== "string" || !runStates.includes(runState as ControlRunState)) throw new AutomationDomainError("invalid_input", "Invalid run state");
  const policies: ActiveRunPolicy[] = ["apply-at-safe-boundary", "interrupt-new-attempt", "queue-after-terminal", "fork-parallel", "not-applicable"];
  if (typeof value.activeRunPolicy !== "string" || !policies.includes(value.activeRunPolicy as ActiveRunPolicy)) throw new AutomationDomainError("invalid_input", "Invalid active-run policy");
  const effects: ControlEffect[] = ["read", "reversible-write", "execution-control", "external-communication"];
  if (typeof value.effect !== "string" || !effects.includes(value.effect as ControlEffect)) throw new AutomationDomainError("invalid_input", "Invalid effect class");
  const patchValue = value.patch;
  let patch: Record<string, unknown> | undefined;
  if (patchValue !== undefined) {
    if (!record(patchValue)) throw new AutomationDomainError("invalid_input", "patch must be an object");
    patch = object(patchValue, Object.keys(patchValue), "patch");
  }
  const actor: ControlActor = { kind: actorKind, principalId: id(actorValue.principalId, "actor.principalId"), ...(actorValue.delegationId === undefined ? {} : { delegationId: id(actorValue.delegationId, "actor.delegationId") }) };
  return {
    schemaVersion: 1,
    controlId: id(value.controlId, "controlId"),
    idempotencyKey: text(value.idempotencyKey, "idempotencyKey", 512),
    actor,
    target: { kind: targetKind, id: id(targetValue.id, "target.id") },
    action: action as ControlAction,
    ...(patch === undefined ? {} : { patch: clone(patch) }),
    expectedVersion: nonNegative(value.expectedVersion, "expectedVersion"),
    runState: runState as ControlRunState,
    activeRunPolicy: value.activeRunPolicy as ActiveRunPolicy,
    effect: value.effect as ControlEffect,
    requestedAtMs: nonNegative(value.requestedAtMs, "requestedAtMs"),
    reason: text(value.reason, "reason", MAX_TEXT),
  };
}

function defaultEntity(command: GoalControlCommand): ControlEntity {
  const patch = command.patch ?? {};
  const objective = typeof patch.objective === "string" ? text(patch.objective, "patch.objective", MAX_TEXT, true) : undefined;
  const prompt = typeof patch.prompt === "string" ? text(patch.prompt, "patch.prompt", MAX_TEXT, true) : undefined;
  return {
    id: command.target.id,
    kind: command.target.kind,
    version: 0,
    status: command.action === "queue" ? "queued" : "draft",
    runState: command.runState,
    ...(objective === undefined ? {} : { objective }),
    ...(prompt === undefined ? {} : { prompt }),
    taskIds: [],
    metadata: {},
    tombstoned: false,
  };
}

function gate(command: GoalControlCommand, entity: ControlEntity | undefined, runtime: RuntimeCapabilities): { decision: ControlDecision; diagnostic: string | null; disposition: ControlReceipt["executionDisposition"] } {
  if (entity?.tombstoned || entity?.runState === "terminal" || entity?.status === "cancelled" || entity?.status === "completed" || entity?.status === "superseded") return { decision: "rejected", diagnostic: "Stored terminal entities cannot be mutated; create a new branch or goal.", disposition: "not-admitted" };
  if (command.runState === "terminal") return { decision: "rejected", diagnostic: "Terminal runs cannot be mutated; create a new branch or goal.", disposition: "not-admitted" };
  if ((command.action === "set-goal" || command.action === "add-task") && !entity) return { decision: "applied", diagnostic: null, disposition: "applied" };
  // A caller may describe a more restrictive runtime observation. It cannot
  // downgrade an already stored running state into an idle mutation.
  if (entity?.runState === "running" || command.runState === "running") {
    const supported = command.action === "steer" ? runtime.steer : command.action === "pause" ? runtime.pause : command.action === "resume" ? runtime.resume : command.action === "cancel" ? runtime.cancel : command.action === "retry" ? runtime.retry : false;
    if (supported) return { decision: "queued", diagnostic: "Accepted for the runtime safe boundary; provider application requires a runtime receipt.", disposition: "queued" };
    if (command.action === "edit-goal" || command.action === "remove-goal" || command.action === "queue" || command.action === "add-task" || command.action === "remove-task") return { decision: "queued", diagnostic: "Persisted as a future revision; active execution must reach a safe boundary before application.", disposition: "queued" };
    return { decision: "deferred", diagnostic: "The active runtime does not advertise this control capability.", disposition: "not-admitted" };
  }
  if (command.action === "resume" && command.runState !== "paused") return { decision: "rejected", diagnostic: "Resume requires a paused run.", disposition: "not-admitted" };
  if (command.action === "pause") return { decision: "rejected", diagnostic: "Pause requires a running run.", disposition: "not-admitted" };
  return { decision: "applied", diagnostic: null, disposition: "applied" };
}

function mutate(entity: ControlEntity, command: GoalControlCommand, decision: ControlDecision): void {
  const patch = command.patch ?? {};
  if (decision === "queued" || decision === "deferred") {
    if (decision === "queued" && (command.action === "remove-goal" || command.action === "cancel") && entity.status !== "cancellation-requested") {
      entity.status = "cancellation-requested";
      entity.version += 1;
    }
    return;
  }
  if (command.action === "remove-goal" || command.action === "cancel") {
    entity.status = "cancelled"; entity.tombstoned = true; entity.runState = "terminal";
  } else if (command.action === "pause") {
    entity.status = "paused"; entity.runState = "paused";
  } else if (command.action === "resume") {
    entity.status = "active"; entity.runState = "idle";
  } else if (command.action === "queue") {
    entity.status = "queued"; entity.runState = "not-started";
  } else if (command.action === "set-goal" || command.action === "edit-goal" || command.action === "steer" || command.action === "add-task" || command.action === "remove-task" || command.action === "reorder" || command.action === "retry" || command.action === "reconcile") {
    entity.status = command.runState === "running" ? "active" : entity.status === "draft" ? "draft" : "active";
    if (typeof patch.objective === "string") entity.objective = text(patch.objective, "patch.objective", MAX_TEXT, true);
    if (typeof patch.prompt === "string") entity.prompt = text(patch.prompt, "patch.prompt", MAX_TEXT, true);
    if (Array.isArray(patch.taskIds)) {
      const ids = patch.taskIds.map((entry) => id(entry, "patch.taskIds[]"));
      uniqueIds(ids, "patch.taskIds"); entity.taskIds = ids;
    }
    if (patch.metadata !== undefined) {
      if (!record(patch.metadata)) throw new AutomationDomainError("invalid_input", "patch.metadata must be an object");
      entity.metadata = clone(object(patch.metadata, Object.keys(patch.metadata), "patch.metadata"));
    }
  }
  entity.version += 1;
}

export class GoalControlPlane {
  private readonly entities = new Map<string, ControlEntity>();
  private readonly events: GoalControlCommand[] = [];
  private readonly receipts = new Map<string, ControlReceipt>();
  private readonly idempotency = new Map<string, string>();
  private readonly runtime: RuntimeCapabilities;
  private clock: number;

  constructor(runtime?: Partial<RuntimeCapabilities>, nowMs = 0) {
    this.runtime = capabilities(runtime);
    this.clock = nonNegative(nowMs, "nowMs");
  }

  get revision(): number { return this.events.length; }
  snapshot(): ControlEntity[] { return clone([...this.entities.values()]); }
  receiptsSnapshot(): ControlReceipt[] { return clone([...this.receipts.values()]); }
  eventsSnapshot(): GoalControlCommand[] { return clone(this.events); }

  apply(input: GoalControlCommand): ControlReceipt {
    const command = validateCommand(input);
    const hash = canonicalHash(command);
    const priorControl = this.idempotency.get(command.idempotencyKey);
    if (priorControl) {
      const prior = this.receipts.get(priorControl);
      if (!prior) throw new AutomationDomainError("integrity", "Idempotency index points to a missing receipt");
      if (prior.canonicalPayloadHash !== hash) throw new AutomationDomainError("payload_drift", "Idempotency key is bound to a different command");
      return { ...clone(prior), replayed: true };
    }
    if (this.receipts.has(command.controlId)) throw new AutomationDomainError("duplicate_control", "Control ID is already bound to an immutable command");
    if (this.events.length >= MAX_EVENTS) throw new AutomationDomainError("capacity", "Control journal capacity reached");
    const current = this.entities.get(command.target.id);
    if (current && current.kind !== command.target.kind) return this.record(command, hash, "rejected", "Target kind does not match the stored entity.", "not-admitted", current);
    if (!current && command.expectedVersion !== 0) return this.record(command, hash, "rejected", "CAS conflict: a missing entity requires expectedVersion 0.", "not-admitted", undefined);
    if (!current && (command.action === "set-goal" || command.action === "add-task") && this.entities.size >= MAX_ENTITIES) {
      throw new AutomationDomainError("capacity", "Control entity capacity reached");
    }
    if (!current && command.runState === "running" && ["steer", "pause", "resume", "cancel", "retry"].includes(command.action)) {
      const liveDecision = gate(command, undefined, this.runtime);
      if (liveDecision.decision === "queued" || liveDecision.decision === "deferred") {
        // Preserve an intent for an unknown provider run without inventing a
        // durable runtime entity.  The adapter must resolve the target and
        // return a provider receipt before any state is materialized.
        return this.record(command, hash, liveDecision.decision, liveDecision.diagnostic, liveDecision.disposition, undefined);
      }
    }
    if (command.action !== "set-goal" && command.action !== "add-task" && !current) return this.record(command, hash, "rejected", "Target entity does not exist.", "not-admitted", undefined);
    if (current && command.expectedVersion !== current.version) return this.record(command, hash, "rejected", `CAS conflict: expected ${command.expectedVersion}, current ${current.version}.`, "not-admitted", current);
    const decision = gate(command, current, this.runtime);
    // Prepare on an isolated candidate. A malformed patch must leave both the
    // stored entity and journal unchanged even if an earlier field validated.
    const entity = current ? clone(current) : defaultEntity(command);
    const beforeState = before(current);
    if (decision.decision === "applied") mutate(entity, command, decision.decision);
    else if (decision.decision === "queued" || decision.decision === "deferred") mutate(entity, command, decision.decision);
    if (!current && decision.decision !== "rejected") this.entities.set(entity.id, entity);
    const receipt = this.record(command, hash, decision.decision, decision.diagnostic, decision.disposition, entity, beforeState);
    if (decision.decision !== "rejected") this.entities.set(entity.id, entity);
    return receipt;
  }

  private record(command: GoalControlCommand, hash: string, decision: ControlDecision, diagnostic: string | null, disposition: ControlReceipt["executionDisposition"], entity?: ControlEntity, prior?: ControlReceipt["before"]): ControlReceipt {
    const beforeState = prior ?? before(this.entities.get(command.target.id));
    const afterState = entity ? before(entity) : beforeState;
    const receipt: ControlReceipt = {
      schemaVersion: 1, controlId: command.controlId, idempotencyKey: command.idempotencyKey, decision,
      target: clone(command.target), before: beforeState, after: afterState, affectedIds: [command.target.id],
      canonicalPayloadHash: hash, executionDisposition: disposition, invalidation: { required: ["edit-goal", "remove-goal", "steer", "add-task", "remove-task"].includes(command.action), reason: ["edit-goal", "remove-goal", "steer", "add-task", "remove-task"].includes(command.action) ? "future-revision-or-active-run-control" : null },
      durable: false, replayed: false, diagnostic, createdAtMs: Math.max(this.clock, command.requestedAtMs),
    };
    this.clock = receipt.createdAtMs;
    this.events.push(clone(command)); this.receipts.set(command.controlId, receipt); this.idempotency.set(command.idempotencyKey, command.controlId);
    return clone(receipt);
  }

  serialize(): string {
    // Receipts are derived by replaying the append-only commands. Keeping the
    // persisted envelope small also prevents a caller from smuggling a forged
    // receipt into recovery.
    const envelope: ControlEnvelope = { schemaVersion: 1, kind: "goal-control", initial: this.runtime, events: this.eventsSnapshot(), state: this.snapshot() };
    return json(envelope);
  }

  static restore(serialized: string, nowMs = 0): GoalControlPlane {
    const envelope = readReplay(serialized, "goal-control");
    const initial = object(envelope.initial, ["steer", "pause", "resume", "cancel", "retry"], "runtime capabilities") as unknown as RuntimeCapabilities;
    const plane = new GoalControlPlane(initial, nowMs);
    for (const event of envelope.events) plane.apply(event as GoalControlCommand);
    const expected = stableJson(envelope.state);
    if (stableJson(plane.snapshot()) !== expected) throw new AutomationDomainError("invalid_replay", "Control replay does not match saved state");
    return plane;
  }
}
