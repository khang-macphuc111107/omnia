import { assertDomain } from "./errors";
import { assertIsoTimestamp, assertNonBlank, type IsoTimestamp, type JsonObject } from "./shared";

/**
 * Native/renderer-neutral automation contract.
 *
 * The studio preview intentionally keeps its own presentation model. This
 * module is the small durable boundary that a native scheduler can consume
 * later without coupling scheduling to React state or provider credentials.
 */

export type OmniaAutomationStatus = "draft" | "active" | "paused" | "archived";
export type OmniaAutomationTrigger =
  | "manual"
  | "event"
  | "schedule"
  | "cron"
  | "calendar"
  | "artifact-completion";
export type OmniaAutomationAction = "chat" | "research" | "export" | "notify";
export type OmniaAutomationScope = "chat" | "project" | "workspace";
export type OmniaAutomationConnector =
  | "none"
  | "google-calendar"
  | "microsoft-calendar"
  | "github"
  | "slack"
  | "email"
  | "webhook";
export type OmniaAutomationConnectorPermission =
  | "not-connected"
  | "read-only"
  | "draft-only"
  | "write-review";
export type OmniaAutomationAuditRetention = "session" | "30-days" | "forever-preview";
export type OmniaAutomationApproval = "auto-preview" | "review-changes" | "always-ask";
export type OmniaAutomationRetryPolicy = "none" | "once" | "three";
export type OmniaAutomationMissedRunPolicy = "skip" | "catch-up" | "ask";
export type OmniaAutomationConcurrency = "serial" | "parallel-2" | "parallel-4";
export type OmniaAutomationNotification = "in-app" | "in-app-email" | "in-app-chat";

export type OmniaAutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface OmniaAutomationCondition {
  readonly field: string;
  readonly operator: "exists" | "equals" | "contains" | "greater-than" | "less-than";
  readonly value?: string;
}

export interface OmniaAutomationSchedule {
  /** Cron expression or a provider-specific calendar recurrence. */
  readonly expression?: string;
  readonly timezone: string;
  readonly nextRunAt?: IsoTimestamp;
}

export interface OmniaAutomationDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly status: OmniaAutomationStatus;
  readonly trigger: OmniaAutomationTrigger;
  readonly triggerDetail: string;
  readonly action: OmniaAutomationAction;
  readonly scope: OmniaAutomationScope;
  readonly connector: OmniaAutomationConnector;
  readonly connectorPermission: OmniaAutomationConnectorPermission;
  readonly connectorIdentity?: string;
  readonly auditRetention: OmniaAutomationAuditRetention;
  readonly approval: OmniaAutomationApproval;
  readonly retry: OmniaAutomationRetryPolicy;
  readonly missedRun: OmniaAutomationMissedRunPolicy;
  readonly concurrency: OmniaAutomationConcurrency;
  readonly notification: OmniaAutomationNotification;
  readonly timezone: string;
  readonly schedule?: OmniaAutomationSchedule;
  readonly conditions: readonly OmniaAutomationCondition[];
  readonly dependency?: string;
  readonly budget?: string;
  readonly metadata: JsonObject;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface OmniaAutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly status: OmniaAutomationRunStatus;
  readonly trigger: OmniaAutomationTrigger;
  readonly attempt: number;
  readonly queuedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly error?: string;
  readonly resultRef?: string;
  readonly metadata: JsonObject;
}

export interface OmniaAutomationRuntime {
  readonly version: 1;
  readonly automations: readonly OmniaAutomationDefinition[];
  readonly runs: readonly OmniaAutomationRun[];
  readonly maxRunHistory: number;
}

/**
 * Reserved run-metadata key used by the cadence poller. The value is a stable
 * `${automationId}@${nextRunAt}` occurrence key, allowing a native scheduler
 * or renderer controller to poll repeatedly without enqueueing the same
 * projected occurrence twice.
 */
export const OMNIA_SCHEDULE_OCCURRENCE_METADATA_KEY = "__omniaScheduleOccurrence" as const;

export type OmniaAutomationPollSkipReason = "already-enqueued" | "already-processed" | "concurrency-limit";

export interface OmniaAutomationPollSkipped {
  readonly automationId: string;
  readonly occurrence: string;
  /** Newer scheduler callers use `occurrenceKey`; the legacy `occurrence`
   * field remains available for renderer/runtime compatibility. */
  readonly occurrenceKey?: string;
  readonly reason: OmniaAutomationPollSkipReason;
}

export interface OmniaAutomationPollResult {
  readonly runtime: OmniaAutomationRuntime;
  readonly queuedRunIds: readonly string[];
  readonly skipped: readonly OmniaAutomationPollSkipped[];
  /** Optional on the legacy result; populated by the canonical poller. */
  readonly queuedAutomationIds?: readonly string[];
}

/** Reserved run metadata key used to make a scheduler poll idempotent. */
export const OMNIA_AUTOMATION_SCHEDULE_OCCURRENCE_KEY = "__omnia.scheduleOccurrence";

export type OmniaAutomationDuePollSkipReason = OmniaAutomationPollSkipReason;

export interface OmniaAutomationDuePollSkip extends OmniaAutomationPollSkipped {
  readonly occurrenceKey: string;
  readonly reason: OmniaAutomationDuePollSkipReason;
}

export interface OmniaAutomationDuePollResult extends OmniaAutomationPollResult {
  readonly runtime: OmniaAutomationRuntime;
  readonly queuedRunIds: readonly string[];
  readonly queuedAutomationIds: readonly string[];
  readonly skipped: readonly OmniaAutomationDuePollSkip[];
}

const STATUSES: readonly OmniaAutomationStatus[] = ["draft", "active", "paused", "archived"];
const TRIGGERS: readonly OmniaAutomationTrigger[] = ["manual", "event", "schedule", "cron", "calendar", "artifact-completion"];
const ACTIONS: readonly OmniaAutomationAction[] = ["chat", "research", "export", "notify"];
const SCOPES: readonly OmniaAutomationScope[] = ["chat", "project", "workspace"];
const CONNECTORS: readonly OmniaAutomationConnector[] = ["none", "google-calendar", "microsoft-calendar", "github", "slack", "email", "webhook"];
const CONNECTOR_PERMISSIONS: readonly OmniaAutomationConnectorPermission[] = ["not-connected", "read-only", "draft-only", "write-review"];
const AUDIT_RETENTIONS: readonly OmniaAutomationAuditRetention[] = ["session", "30-days", "forever-preview"];
const APPROVALS: readonly OmniaAutomationApproval[] = ["auto-preview", "review-changes", "always-ask"];
const RETRIES: readonly OmniaAutomationRetryPolicy[] = ["none", "once", "three"];
const MISSED_RUNS: readonly OmniaAutomationMissedRunPolicy[] = ["skip", "catch-up", "ask"];
const CONCURRENCIES: readonly OmniaAutomationConcurrency[] = ["serial", "parallel-2", "parallel-4"];
const NOTIFICATIONS: readonly OmniaAutomationNotification[] = ["in-app", "in-app-email", "in-app-chat"];
const RUN_STATUSES: readonly OmniaAutomationRunStatus[] = ["queued", "running", "succeeded", "failed", "cancelled", "skipped"];
const CONDITION_OPERATORS: readonly OmniaAutomationCondition["operator"][] = ["exists", "equals", "contains", "greater-than", "less-than"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): IsoTimestamp {
  return new Date().toISOString();
}

function maxConcurrency(value: OmniaAutomationConcurrency): number {
  return value === "parallel-4" ? 4 : value === "parallel-2" ? 2 : 1;
}

function scheduleOccurrenceKey(automationId: string, nextRunAt: IsoTimestamp): string {
  return `${automationId}@${nextRunAt}`;
}

function activeRuns(runtime: OmniaAutomationRuntime, automationId: string): number {
  const automation = runtime.automations.find((candidate) => candidate.id === automationId);
  if (automation === undefined) return 0;
  return runtime.runs.filter((run) => run.automationId === automationId && (run.status === "queued" || run.status === "running")).length;
}

function assertAutomationId(value: string): string {
  return assertNonBlank(value, "automation ID", 256);
}

function assertRunId(value: string): string {
  return assertNonBlank(value, "automation run ID", 256);
}

function parseJsonObject(value: unknown, label: string): JsonObject {
  assertDomain(isRecord(value), "invalid_argument", `${label} must be an object.`);
  return { ...(value as JsonObject) };
}

function parseCondition(value: unknown): OmniaAutomationCondition {
  assertDomain(isRecord(value) && isString(value.field) && isOneOf(CONDITION_OPERATORS, value.operator), "invalid_argument", "Invalid automation condition.");
  const result: OmniaAutomationCondition = {
    field: assertNonBlank(value.field, "automation condition field", 512),
    operator: value.operator,
    ...(isString(value.value) ? { value: value.value } : {}),
  };
  if (result.operator !== "exists") assertDomain(result.value !== undefined && result.value.trim().length > 0, "invalid_argument", "Non-exists automation conditions require a value.");
  return result;
}

function validateDefinition(definition: OmniaAutomationDefinition): OmniaAutomationDefinition {
  assertAutomationId(definition.id);
  assertNonBlank(definition.name, "automation name", 256);
  assertDomain(isOneOf(STATUSES, definition.status), "invalid_argument", "Unsupported automation status.");
  assertDomain(isOneOf(TRIGGERS, definition.trigger), "invalid_argument", "Unsupported automation trigger.");
  assertDomain(isOneOf(ACTIONS, definition.action), "invalid_argument", "Unsupported automation action.");
  assertDomain(isOneOf(SCOPES, definition.scope), "invalid_argument", "Unsupported automation scope.");
  assertDomain(isOneOf(CONNECTORS, definition.connector), "invalid_argument", "Unsupported automation connector.");
  assertDomain(isOneOf(CONNECTOR_PERMISSIONS, definition.connectorPermission), "invalid_argument", "Unsupported connector permission.");
  assertDomain(isOneOf(AUDIT_RETENTIONS, definition.auditRetention), "invalid_argument", "Unsupported audit retention.");
  assertDomain(isOneOf(APPROVALS, definition.approval), "invalid_argument", "Unsupported approval route.");
  assertDomain(isOneOf(RETRIES, definition.retry), "invalid_argument", "Unsupported retry policy.");
  assertDomain(isOneOf(MISSED_RUNS, definition.missedRun), "invalid_argument", "Unsupported missed-run policy.");
  assertDomain(isOneOf(CONCURRENCIES, definition.concurrency), "invalid_argument", "Unsupported concurrency policy.");
  assertDomain(isOneOf(NOTIFICATIONS, definition.notification), "invalid_argument", "Unsupported notification policy.");
  assertNonBlank(definition.triggerDetail, "automation trigger detail", 2_000);
  assertNonBlank(definition.timezone, "automation timezone", 128);
  assertIsoTimestamp(definition.createdAt, "automation creation time");
  assertIsoTimestamp(definition.updatedAt, "automation update time");
  assertDomain(Date.parse(definition.updatedAt) >= Date.parse(definition.createdAt), "invalid_argument", "Automation update time cannot predate creation.");
  assertDomain(new Set(definition.conditions.map((condition) => condition.field)).size === definition.conditions.length, "conflict", "Automation condition fields must be unique.");
  definition.conditions.forEach(parseCondition);
  if (definition.schedule !== undefined) {
    assertNonBlank(definition.schedule.timezone, "automation schedule timezone", 128);
    if (definition.schedule.expression !== undefined) assertNonBlank(definition.schedule.expression, "automation schedule expression", 512);
    if (definition.schedule.nextRunAt !== undefined) assertIsoTimestamp(definition.schedule.nextRunAt, "automation next run time");
  }
  if (definition.trigger === "schedule" || definition.trigger === "cron" || definition.trigger === "calendar") {
    assertDomain(definition.schedule !== undefined, "invalid_argument", "Cadence automation triggers require a schedule.");
  }
  if (definition.connector === "none") assertDomain(definition.connectorPermission === "not-connected", "invalid_argument", "A disconnected automation cannot grant connector access.");
  if (definition.connector !== "none") assertDomain(definition.connectorPermission !== "not-connected", "invalid_argument", "A connected automation must declare connector permission.");
  return definition;
}

function validateRun(run: OmniaAutomationRun): OmniaAutomationRun {
  assertRunId(run.id);
  assertAutomationId(run.automationId);
  assertDomain(isOneOf(RUN_STATUSES, run.status), "invalid_argument", "Unsupported automation run status.");
  assertDomain(isOneOf(TRIGGERS, run.trigger), "invalid_argument", "Unsupported automation run trigger.");
  assertDomain(Number.isSafeInteger(run.attempt) && run.attempt >= 1, "invalid_argument", "Automation run attempt must be a positive integer.");
  assertIsoTimestamp(run.queuedAt, "automation run queue time");
  if (run.startedAt !== undefined) assertIsoTimestamp(run.startedAt, "automation run start time");
  if (run.finishedAt !== undefined) assertIsoTimestamp(run.finishedAt, "automation run finish time");
  if (run.startedAt !== undefined) assertDomain(Date.parse(run.startedAt) >= Date.parse(run.queuedAt), "invalid_argument", "Automation run start cannot predate queue time.");
  if (run.finishedAt !== undefined) assertDomain(run.startedAt !== undefined && Date.parse(run.finishedAt) >= Date.parse(run.startedAt), "invalid_argument", "Automation run finish requires a valid start time.");
  if (run.status === "queued") assertDomain(run.startedAt === undefined && run.finishedAt === undefined, "invalid_argument", "Queued automation runs cannot have execution timestamps.");
  if (run.status === "running") assertDomain(run.startedAt !== undefined && run.finishedAt === undefined, "invalid_argument", "Running automation runs require a start time and no finish time.");
  if (["succeeded", "failed", "cancelled", "skipped"].includes(run.status)) assertDomain(run.finishedAt !== undefined, "invalid_argument", "Terminal automation runs require a finish time.");
  return run;
}

/** Creates an empty scheduler state suitable for renderer previews or native persistence. */
export function createOmniaAutomationRuntime(maxRunHistory = 500): OmniaAutomationRuntime {
  assertDomain(Number.isSafeInteger(maxRunHistory) && maxRunHistory > 0, "invalid_argument", "Automation run history bound must be a positive integer.");
  return { version: 1, automations: [], runs: [], maxRunHistory };
}

/** Adds or replaces an automation by stable ID. */
export function upsertOmniaAutomation(runtime: OmniaAutomationRuntime, definition: OmniaAutomationDefinition): OmniaAutomationRuntime {
  validateDefinition(definition);
  const exists = runtime.automations.some((candidate) => candidate.id === definition.id);
  const automations = exists
    ? runtime.automations.map((candidate) => candidate.id === definition.id ? definition : candidate)
    : [...runtime.automations, definition];
  return { ...runtime, automations };
}

/** Applies a lifecycle transition without changing the rest of the definition. */
export function setOmniaAutomationStatus(runtime: OmniaAutomationRuntime, automationId: string, status: OmniaAutomationStatus, updatedAt = now()): OmniaAutomationRuntime {
  assertAutomationId(automationId);
  assertDomain(isOneOf(STATUSES, status), "invalid_argument", "Unsupported automation status.");
  const current = runtime.automations.find((candidate) => candidate.id === automationId);
  assertDomain(current !== undefined, "not_found", "Automation was not found.", { automationId });
  const next: OmniaAutomationDefinition = { ...current, status, updatedAt };
  validateDefinition(next);
  return { ...runtime, automations: runtime.automations.map((candidate) => candidate.id === automationId ? next : candidate) };
}

/** Queues one manual/event execution, enforcing the definition's concurrency policy. */
export function enqueueOmniaAutomationRun(runtime: OmniaAutomationRuntime, automationId: string, trigger?: OmniaAutomationTrigger, metadata: JsonObject = {}, queuedAt = now()): OmniaAutomationRuntime {
  assertAutomationId(automationId);
  const automation = runtime.automations.find((candidate) => candidate.id === automationId);
  assertDomain(automation !== undefined, "not_found", "Automation was not found.", { automationId });
  assertDomain(automation.status === "active" || automation.status === "draft", "invalid_state_transition", "Only active or draft automations can be queued.", { automationId, status: automation.status });
  const pending = activeRuns(runtime, automationId);
  assertDomain(pending < maxConcurrency(automation.concurrency), "conflict", "Automation concurrency limit reached.", { automationId, concurrency: automation.concurrency });
  const run: OmniaAutomationRun = { id: makeId("automation_run"), automationId, status: "queued", trigger: trigger ?? automation.trigger, attempt: 1, queuedAt, metadata: { ...metadata } };
  return { ...runtime, runs: [...runtime.runs, run].slice(-runtime.maxRunHistory) };
}

export function startOmniaAutomationRun(runtime: OmniaAutomationRuntime, runId: string, startedAt = now()): OmniaAutomationRuntime {
  const run = runtime.runs.find((candidate) => candidate.id === runId);
  assertDomain(run !== undefined, "not_found", "Automation run was not found.", { runId });
  assertDomain(run.status === "queued", "invalid_state_transition", "Only queued automation runs can start.", { runId, status: run.status });
  const next: OmniaAutomationRun = { ...run, status: "running", startedAt };
  validateRun(next);
  return { ...runtime, runs: runtime.runs.map((candidate) => candidate.id === runId ? next : candidate) };
}

export function finishOmniaAutomationRun(runtime: OmniaAutomationRuntime, runId: string, status: Exclude<OmniaAutomationRunStatus, "queued" | "running">, options: { readonly error?: string; readonly resultRef?: string; readonly finishedAt?: IsoTimestamp; } = {}): OmniaAutomationRuntime {
  const run = runtime.runs.find((candidate) => candidate.id === runId);
  assertDomain(run !== undefined, "not_found", "Automation run was not found.", { runId });
  assertDomain(run.status === "running" || run.status === "queued", "invalid_state_transition", "Only queued or running automation runs can finish.", { runId, status: run.status });
  const startedAt = run.startedAt ?? run.queuedAt;
  const next: OmniaAutomationRun = { ...run, status, startedAt, finishedAt: options.finishedAt ?? now(), ...(options.error !== undefined ? { error: options.error } : {}), ...(options.resultRef !== undefined ? { resultRef: options.resultRef } : {}) };
  if (status === "failed") assertDomain(typeof next.error === "string" && next.error.trim().length > 0, "invalid_argument", "Failed automation runs require an error.");
  if (status === "succeeded") assertDomain(next.error === undefined, "invalid_argument", "Successful automation runs cannot carry an error.");
  validateRun(next);
  return { ...runtime, runs: runtime.runs.map((candidate) => candidate.id === runId ? next : candidate) };
}

/** Returns definitions whose next cadence is due at `at`; no cron parser is implied. */
export function listDueOmniaAutomations(runtime: OmniaAutomationRuntime, at = now()): readonly OmniaAutomationDefinition[] {
  assertIsoTimestamp(at, "automation due-check time");
  return Object.freeze(runtime.automations.filter((automation) => automation.status === "active" && automation.schedule?.nextRunAt !== undefined && Date.parse(automation.schedule.nextRunAt) <= Date.parse(at)));
}

/**
 * Polls the currently projected cadence occurrences and queues each due
 * occurrence at most once.
 *
 * This deliberately does not parse or advance cron/calendar expressions. The
 * owner of the schedule (normally the native scheduler or a provider adapter)
 * is responsible for advancing `schedule.nextRunAt` after a successful
 * enqueue/dispatch. Until then, repeated polls are idempotent because the
 * occurrence key is persisted in run metadata. A full concurrency window is
 * reported as a soft skip so a later poll can retry after a running execution
 * finishes; no synthetic skipped run is written to history.
 */
export function pollDueOmniaAutomations(runtime: OmniaAutomationRuntime, at = now()): OmniaAutomationDuePollResult {
  validateOmniaAutomationRuntime(runtime);
  assertIsoTimestamp(at, "automation due-check time");

  let next = runtime;
  const queuedRunIds: string[] = [];
  const queuedAutomationIds: string[] = [];
  const skipped: OmniaAutomationDuePollSkip[] = [];

  for (const automation of listDueOmniaAutomations(runtime, at)) {
    const nextRunAt = automation.schedule?.nextRunAt;
    // listDueOmniaAutomations guarantees this branch, but retaining the guard
    // makes the function robust if that helper gains a broader projection.
    if (nextRunAt === undefined) continue;
    const occurrence = scheduleOccurrenceKey(automation.id, nextRunAt);
    // Keep the newer colon-delimited key alongside the original at-delimited
    // key so snapshots created by either scheduler lane remain idempotent.
    const occurrenceKey = `${automation.id}:${nextRunAt}`;

    const alreadyEnqueued = next.runs.some(
      (run) => run.automationId === automation.id && (
        run.metadata[OMNIA_SCHEDULE_OCCURRENCE_METADATA_KEY] === occurrence
        || run.metadata[OMNIA_AUTOMATION_SCHEDULE_OCCURRENCE_KEY] === occurrenceKey
        || run.metadata[OMNIA_AUTOMATION_SCHEDULE_OCCURRENCE_KEY] === occurrence
      ),
    );
    if (alreadyEnqueued) {
      skipped.push({ automationId: automation.id, occurrence, occurrenceKey, reason: "already-processed" });
      continue;
    }

    if (activeRuns(next, automation.id) >= maxConcurrency(automation.concurrency)) {
      skipped.push({ automationId: automation.id, occurrence, occurrenceKey, reason: "concurrency-limit" });
      continue;
    }

    next = enqueueOmniaAutomationRun(
      next,
      automation.id,
      automation.trigger,
      {
        [OMNIA_SCHEDULE_OCCURRENCE_METADATA_KEY]: occurrence,
        [OMNIA_AUTOMATION_SCHEDULE_OCCURRENCE_KEY]: occurrenceKey,
      },
      at,
    );
    const queued = next.runs.find(
      (run) => run.automationId === automation.id
        && run.metadata[OMNIA_SCHEDULE_OCCURRENCE_METADATA_KEY] === occurrence
        && run.metadata[OMNIA_AUTOMATION_SCHEDULE_OCCURRENCE_KEY] === occurrenceKey,
    );
    assertDomain(queued !== undefined, "invalid_state_transition", "Queued automation run was not retained in runtime history.", { automationId: automation.id, occurrence });
    queuedRunIds.push(queued.id);
    queuedAutomationIds.push(automation.id);
  }

  validateOmniaAutomationRuntime(next);
  return Object.freeze({
    runtime: next,
    queuedRunIds: Object.freeze(queuedRunIds),
    queuedAutomationIds: Object.freeze(queuedAutomationIds),
    skipped: Object.freeze(skipped),
  });
}

export function validateOmniaAutomationRuntime(runtime: OmniaAutomationRuntime): OmniaAutomationRuntime {
  assertDomain(runtime.version === 1, "invalid_argument", "Unsupported automation runtime version.");
  assertDomain(Number.isSafeInteger(runtime.maxRunHistory) && runtime.maxRunHistory > 0, "invalid_argument", "Automation run history bound must be a positive integer.");
  assertDomain(new Set(runtime.automations.map((automation) => automation.id)).size === runtime.automations.length, "conflict", "Automation IDs must be unique.");
  assertDomain(new Set(runtime.runs.map((run) => run.id)).size === runtime.runs.length, "conflict", "Automation run IDs must be unique.");
  runtime.automations.forEach(validateDefinition);
  const ids = new Set(runtime.automations.map((automation) => automation.id));
  runtime.runs.forEach((run) => { validateRun(run); assertDomain(ids.has(run.automationId), "not_found", "Automation run references an unknown automation.", { runId: run.id, automationId: run.automationId }); });
  return runtime;
}

function parseSchedule(value: unknown): OmniaAutomationSchedule {
  assertDomain(isRecord(value) && isString(value.timezone), "invalid_argument", "Invalid automation schedule.");
  return { timezone: assertNonBlank(value.timezone, "automation schedule timezone", 128), ...(isString(value.expression) ? { expression: value.expression } : {}), ...(isString(value.nextRunAt) ? { nextRunAt: value.nextRunAt } : {}) };
}

function parseDefinition(value: unknown): OmniaAutomationDefinition {
  assertDomain(isRecord(value) && isString(value.id) && isString(value.name) && isOneOf(STATUSES, value.status) && isOneOf(TRIGGERS, value.trigger) && isString(value.triggerDetail) && isOneOf(ACTIONS, value.action) && isOneOf(SCOPES, value.scope) && isOneOf(CONNECTORS, value.connector) && isOneOf(CONNECTOR_PERMISSIONS, value.connectorPermission) && isOneOf(AUDIT_RETENTIONS, value.auditRetention) && isOneOf(APPROVALS, value.approval) && isOneOf(RETRIES, value.retry) && isOneOf(MISSED_RUNS, value.missedRun) && isOneOf(CONCURRENCIES, value.concurrency) && isOneOf(NOTIFICATIONS, value.notification) && isString(value.timezone) && Array.isArray(value.conditions) && isString(value.createdAt) && isString(value.updatedAt), "invalid_argument", "Invalid automation definition.");
  const definition: OmniaAutomationDefinition = {
    id: value.id,
    name: value.name,
    ...(isString(value.description) ? { description: value.description } : {}),
    status: value.status,
    trigger: value.trigger,
    triggerDetail: value.triggerDetail,
    action: value.action,
    scope: value.scope,
    connector: value.connector,
    connectorPermission: value.connectorPermission,
    ...(isString(value.connectorIdentity) ? { connectorIdentity: value.connectorIdentity } : {}),
    auditRetention: value.auditRetention,
    approval: value.approval,
    retry: value.retry,
    missedRun: value.missedRun,
    concurrency: value.concurrency,
    notification: value.notification,
    timezone: value.timezone,
    ...(isRecord(value.schedule) ? { schedule: parseSchedule(value.schedule) } : {}),
    conditions: value.conditions.map(parseCondition),
    ...(isString(value.dependency) ? { dependency: value.dependency } : {}),
    ...(isString(value.budget) ? { budget: value.budget } : {}),
    metadata: parseJsonObject(value.metadata ?? {}, "automation metadata"),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  return validateDefinition(definition);
}

function parseRun(value: unknown): OmniaAutomationRun {
  assertDomain(isRecord(value) && isString(value.id) && isString(value.automationId) && isOneOf(RUN_STATUSES, value.status) && isOneOf(TRIGGERS, value.trigger) && typeof value.attempt === "number" && isString(value.queuedAt), "invalid_argument", "Invalid automation run.");
  const run: OmniaAutomationRun = { id: value.id, automationId: value.automationId, status: value.status, trigger: value.trigger, attempt: value.attempt, queuedAt: value.queuedAt, ...(isString(value.startedAt) ? { startedAt: value.startedAt } : {}), ...(isString(value.finishedAt) ? { finishedAt: value.finishedAt } : {}), ...(isString(value.error) ? { error: value.error } : {}), ...(isString(value.resultRef) ? { resultRef: value.resultRef } : {}), metadata: parseJsonObject(value.metadata ?? {}, "automation run metadata") };
  return validateRun(run);
}

export function deserializeOmniaAutomationRuntime(input: string | unknown): OmniaAutomationRuntime {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value) && value.version === 1 && Array.isArray(value.automations) && Array.isArray(value.runs) && typeof value.maxRunHistory === "number", "invalid_argument", "Invalid Omnia automation runtime.");
  const runtime: OmniaAutomationRuntime = { version: 1, automations: value.automations.map(parseDefinition), runs: value.runs.map(parseRun), maxRunHistory: value.maxRunHistory };
  return validateOmniaAutomationRuntime(runtime);
}

export function serializeOmniaAutomationRuntime(runtime: OmniaAutomationRuntime): string {
  validateOmniaAutomationRuntime(runtime);
  return JSON.stringify(runtime, null, 2);
}

/** Utility for callers building an automation from the studio's option sets. */
export function createDefaultOmniaAutomation(name = "Untitled automation", createdAt = now()): OmniaAutomationDefinition {
  const definition: OmniaAutomationDefinition = {
    id: makeId("automation"),
    name: name.trim() || "Untitled automation",
    status: "draft",
    trigger: "manual",
    triggerDetail: "Run on demand",
    action: "chat",
    scope: "workspace",
    connector: "none",
    connectorPermission: "not-connected",
    auditRetention: "session",
    approval: "always-ask",
    retry: "none",
    missedRun: "skip",
    concurrency: "serial",
    notification: "in-app",
    timezone: "UTC",
    conditions: [],
    metadata: {},
    createdAt,
    updatedAt: createdAt,
  };
  return validateDefinition(definition);
}

/** Returns a shallow immutable projection useful for settings/automation lists. */
export function summarizeOmniaAutomation(runtime: OmniaAutomationRuntime, automationId: string): { readonly automation: OmniaAutomationDefinition; readonly activeRuns: number; readonly completedRuns: number; readonly failedRuns: number } {
  const automation = runtime.automations.find((candidate) => candidate.id === automationId);
  assertDomain(automation !== undefined, "not_found", "Automation was not found.", { automationId });
  const runs = runtime.runs.filter((run) => run.automationId === automationId);
  return Object.freeze({ automation, activeRuns: runs.filter((run) => run.status === "queued" || run.status === "running").length, completedRuns: runs.filter((run) => run.status === "succeeded").length, failedRuns: runs.filter((run) => run.status === "failed").length });
}
