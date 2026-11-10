import { assertDomain } from "./errors";
import { createEntityId, type EntityId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";
import type { TelemetryScope } from "./telemetry";

/** A bounded, renderer/native-neutral event kind used by the learning loop. */
export type OmniaLearningTelemetryEventKind =
  | "metric"
  | "feedback"
  | "run-outcome"
  | "training-signal"
  | "checkpoint"
  | "system";

export type OmniaLearningConsent = "none" | "session" | "explicit";
export type OmniaTelemetryMetricType = "counter" | "gauge" | "histogram";
export type OmniaLearningRunStatus = "planned" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type OmniaTelemetryEventId = EntityId<"omnia-telemetry-event">;
export type OmniaLearningRunId = EntityId<"omnia-learning-run">;
export type OmniaLearningStepId = EntityId<"omnia-learning-step">;
export type OmniaLearningCheckpointId = EntityId<"omnia-learning-checkpoint">;

export interface OmniaTelemetryEvent {
  readonly schemaVersion: 1;
  readonly id: OmniaTelemetryEventId;
  readonly kind: OmniaLearningTelemetryEventKind;
  readonly name: string;
  readonly occurredAt: IsoTimestamp;
  readonly source: string;
  readonly metricType?: OmniaTelemetryMetricType;
  readonly value?: number;
  readonly unit?: string;
  /** Low-cardinality labels only; raw prompts, responses, headers and payloads are forbidden. */
  readonly labels: Readonly<Record<string, string>>;
  readonly attributes: JsonObject;
  readonly scope?: TelemetryScope;
  readonly consent: OmniaLearningConsent;
  readonly trainable: boolean;
}

export interface CreateOmniaTelemetryEventInput
  extends Omit<OmniaTelemetryEvent, "schemaVersion" | "id" | "name" | "occurredAt" | "source" | "labels" | "attributes"> {
  readonly id?: OmniaTelemetryEventId;
  readonly name: string;
  readonly occurredAt?: IsoTimestamp;
  readonly source: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly attributes?: JsonObject;
}

export interface OmniaTelemetryCollectorOptions {
  readonly maxEvents?: number;
  readonly now?: () => IsoTimestamp;
}

export type OmniaTelemetryListener = (event: OmniaTelemetryEvent) => void;

export interface OmniaMetricEventOptions {
  readonly metricType?: OmniaTelemetryMetricType;
  readonly unit?: string;
  readonly source?: string;
  readonly occurredAt?: IsoTimestamp;
  readonly labels?: Readonly<Record<string, string>>;
  readonly attributes?: JsonObject;
  readonly scope?: TelemetryScope;
  readonly consent?: OmniaLearningConsent;
  readonly trainable?: boolean;
}

export interface OmniaFeedbackEventOptions {
  readonly source?: string;
  readonly occurredAt?: IsoTimestamp;
  readonly labels?: Readonly<Record<string, string>>;
  readonly attributes?: JsonObject;
  readonly scope?: TelemetryScope;
  readonly consent?: OmniaLearningConsent;
  readonly trainable?: boolean;
}

export interface OmniaTelemetryAggregate {
  readonly name: string;
  readonly eventCount: number;
  readonly numericSamples: number;
  readonly sum: number | null;
  readonly mean: number | null;
  readonly minimum: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly maximum: number | null;
  readonly latestAt: IsoTimestamp | null;
  readonly byMetricType: Readonly<Partial<Record<OmniaTelemetryMetricType, number>>>;
}

export interface OmniaLearningDatasetPolicy {
  readonly requireExplicitConsent: boolean;
  readonly includeText: boolean;
  readonly includeAttributes: boolean;
  readonly maxExamples: number;
}

export const DEFAULT_OMNIA_LEARNING_DATASET_POLICY: OmniaLearningDatasetPolicy = Object.freeze({
  requireExplicitConsent: true,
  includeText: false,
  includeAttributes: true,
  maxExamples: 10_000,
});

export interface OmniaLearningExample {
  readonly id: string;
  readonly sourceEventId: OmniaTelemetryEventId;
  readonly kind: OmniaLearningTelemetryEventKind;
  readonly name: string;
  readonly occurredAt: IsoTimestamp;
  readonly source: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly attributes: JsonObject;
  readonly textIncluded: boolean;
}

export interface OmniaLearningDatasetProjection {
  readonly schema: "omnia.learning-dataset.v1";
  readonly generatedAt: IsoTimestamp;
  readonly policy: OmniaLearningDatasetPolicy;
  readonly totalEvents: number;
  readonly eligibleEvents: number;
  readonly heldEvents: number;
  readonly examples: readonly OmniaLearningExample[];
  readonly exclusions: Readonly<Record<string, number>>;
}

export interface OmniaLearningCheckpoint {
  readonly id: OmniaLearningCheckpointId;
  readonly runId: OmniaLearningRunId;
  readonly step: number;
  readonly createdAt: IsoTimestamp;
  readonly label: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly artifactRef?: string;
}

export interface OmniaLearningRun {
  readonly schemaVersion: 1;
  readonly id: OmniaLearningRunId;
  readonly name: string;
  readonly mode: "supervised" | "preference" | "distillation" | "retrieval" | "evaluation";
  readonly status: OmniaLearningRunStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly step: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly checkpoints: readonly OmniaLearningCheckpoint[];
  readonly dataset?: OmniaLearningDatasetProjection;
  readonly failureReason?: string;
}

export interface CreateOmniaLearningRunInput {
  readonly id?: OmniaLearningRunId;
  readonly name: string;
  readonly mode: OmniaLearningRun["mode"];
  readonly now?: IsoTimestamp;
  readonly dataset?: OmniaLearningDatasetProjection;
}

export interface OmniaLearningStepInput {
  readonly step: number;
  readonly now?: IsoTimestamp;
  readonly metrics?: Readonly<Record<string, number>>;
}

export interface OmniaLearningCheckpointInput {
  readonly label: string;
  readonly step?: number;
  readonly now?: IsoTimestamp;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly artifactRef?: string;
}

const DEFAULT_MAX_EVENTS = 5_000;
const MAX_MAX_EVENTS = 100_000;
const MAX_LABELS = 32;
const MAX_ATTRIBUTES = 64;
const MAX_STRING = 512;

function assertBoundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  assertDomain(Number.isSafeInteger(value) && value >= minimum && value <= maximum, "invalid_argument", `${label} is out of bounds.`, { value, minimum, maximum });
  return value;
}

function normalizeMetricMap(values: Readonly<Record<string, number>> | undefined, label: string): Readonly<Record<string, number>> {
  if (values === undefined) return Object.freeze({});
  const entries = Object.entries(values);
  assertDomain(entries.length <= 128, "invalid_argument", `${label} contains too many entries.`);
  const normalized: Record<string, number> = {};
  for (const [key, value] of entries) {
    const normalizedKey = assertNonBlank(key, `${label} key`, 120).toLowerCase();
    assertDomain(Number.isFinite(value), "invalid_argument", `${label} values must be finite.`, { key: normalizedKey });
    normalized[normalizedKey] = value;
  }
  return Object.freeze(normalized);
}

function normalizeLabels(labels: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const entries = Object.entries(labels ?? {});
  assertDomain(entries.length <= MAX_LABELS, "invalid_argument", "Telemetry labels exceed the bounded limit.");
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    const normalizedKey = assertNonBlank(key, "telemetry label key", 80).toLowerCase();
    normalized[normalizedKey] = assertNonBlank(value, `telemetry label ${normalizedKey}`, MAX_STRING);
  }
  return Object.freeze(normalized);
}

function normalizeAttributes(attributes: JsonObject | undefined): JsonObject {
  const value = attributes ?? {};
  assertDomain(Object.keys(value).length <= MAX_ATTRIBUTES, "invalid_argument", "Telemetry attributes exceed the bounded limit.");
  return freezeJson(value);
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

function normalizeEvent(input: CreateOmniaTelemetryEventInput, now: () => IsoTimestamp): OmniaTelemetryEvent {
  const occurredAt = input.occurredAt ?? now();
  assertIsoTimestamp(occurredAt, "telemetry event time");
  const name = assertNonBlank(input.name, "telemetry event name", 200);
  const source = assertNonBlank(input.source, "telemetry event source", 200);
  const unit = input.unit === undefined ? undefined : assertNonBlank(input.unit, "telemetry unit", 80);
  const value = input.value;
  assertDomain(value === undefined || Number.isFinite(value), "invalid_argument", "Telemetry metric value must be finite.");
  assertDomain(input.kind !== "metric" || input.metricType !== undefined, "invalid_argument", "Metric events require a metric type.");
  assertDomain(input.kind === "metric" || input.metricType === undefined, "invalid_argument", "Only metric events may define a metric type.");
  return Object.freeze({
    schemaVersion: 1,
    id: input.id ?? createEntityId<"omnia-telemetry-event">(),
    kind: input.kind,
    name,
    occurredAt,
    source,
    ...(input.metricType === undefined ? {} : { metricType: input.metricType }),
    ...(value === undefined ? {} : { value }),
    ...(unit === undefined ? {} : { unit }),
    labels: normalizeLabels(input.labels),
    attributes: normalizeAttributes(input.attributes),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    consent: input.consent,
    trainable: input.trainable,
  });
}

/**
 * Bounded event collector. It intentionally records operational metadata only;
 * model prompts, responses, credentials and tool payloads must stay outside this
 * surface unless a caller explicitly projects an approved training example.
 */
export class OmniaTelemetryCollector {
  readonly maxEvents: number;
  private readonly now: () => IsoTimestamp;
  private events: OmniaTelemetryEvent[] = [];
  private readonly listeners = new Set<OmniaTelemetryListener>();

  constructor(options: OmniaTelemetryCollectorOptions = {}) {
    this.maxEvents = assertBoundedInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, "telemetry maxEvents", 1, MAX_MAX_EVENTS);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get size(): number {
    return this.events.length;
  }

  record(input: CreateOmniaTelemetryEventInput): OmniaTelemetryEvent {
    const event = normalizeEvent(input, this.now);
    this.events = [...this.events, event].slice(-this.maxEvents);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Telemetry observers must never break the operation being observed.
      }
    }
    return event;
  }

  subscribe(listener: OmniaTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recordMetric(name: string, value: number, options: OmniaMetricEventOptions = {}): OmniaTelemetryEvent {
    return this.record({
      kind: "metric",
      name,
      value,
      metricType: options.metricType ?? "gauge",
      source: options.source ?? "runtime",
      ...(options.unit === undefined ? {} : { unit: options.unit }),
      ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      consent: options.consent ?? "none",
      trainable: options.trainable ?? false,
    });
  }

  recordFeedback(name: string, options: OmniaFeedbackEventOptions = {}): OmniaTelemetryEvent {
    return this.record({
      kind: "feedback",
      name,
      source: options.source ?? "feedback",
      ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      consent: options.consent ?? "none",
      trainable: options.trainable ?? false,
    });
  }

  recordMany(inputs: readonly CreateOmniaTelemetryEventInput[]): readonly OmniaTelemetryEvent[] {
    return Object.freeze(inputs.map((input) => this.record(input)));
  }

  snapshot(): readonly OmniaTelemetryEvent[] {
    return Object.freeze([...this.events]);
  }

  clear(): void {
    this.events = [];
  }

  dispose(): void {
    this.events = [];
    this.listeners.clear();
  }

  aggregate(name?: string): readonly OmniaTelemetryAggregate[] {
    const groups = new Map<string, OmniaTelemetryEvent[]>();
    for (const event of this.events) {
      if (name !== undefined && event.name !== name) continue;
      const group = groups.get(event.name) ?? [];
      group.push(event);
      groups.set(event.name, group);
    }
    return Object.freeze([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([groupName, events]) => {
      const values = events.flatMap((event) => event.value === undefined ? [] : [event.value]);
      const sum = values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
      const byMetricType: Partial<Record<OmniaTelemetryMetricType, number>> = {};
      for (const event of events) if (event.metricType !== undefined) byMetricType[event.metricType] = (byMetricType[event.metricType] ?? 0) + 1;
      return Object.freeze({
        name: groupName,
        eventCount: events.length,
        numericSamples: values.length,
        sum,
        mean: sum === null ? null : sum / values.length,
        minimum: values.length === 0 ? null : Math.min(...values),
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        maximum: values.length === 0 ? null : Math.max(...values),
        latestAt: events.at(-1)?.occurredAt ?? null,
        byMetricType: Object.freeze(byMetricType),
      });
    }));
  }
}

function normalizeDatasetPolicy(policy: Partial<OmniaLearningDatasetPolicy> | undefined): OmniaLearningDatasetPolicy {
  const merged = { ...DEFAULT_OMNIA_LEARNING_DATASET_POLICY, ...(policy ?? {}) };
  return Object.freeze({
    requireExplicitConsent: merged.requireExplicitConsent,
    includeText: merged.includeText,
    includeAttributes: merged.includeAttributes,
    maxExamples: assertBoundedInteger(merged.maxExamples, "learning maxExamples", 1, 100_000),
  });
}

/** Converts approved telemetry into a bounded metadata-first dataset manifest. */
export function projectOmniaLearningDataset(
  events: readonly OmniaTelemetryEvent[],
  policy?: Partial<OmniaLearningDatasetPolicy>,
  generatedAt = new Date().toISOString(),
): OmniaLearningDatasetProjection {
  assertIsoTimestamp(generatedAt, "learning dataset generation time");
  const normalizedPolicy = normalizeDatasetPolicy(policy);
  const exclusions: Record<string, number> = {};
  const examples: OmniaLearningExample[] = [];
  const exclude = (reason: string): void => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  for (const event of events) {
    if (!event.trainable) { exclude("not-trainable"); continue; }
    if (normalizedPolicy.requireExplicitConsent && event.consent !== "explicit") { exclude("consent-required"); continue; }
    if (examples.length >= normalizedPolicy.maxExamples) { exclude("max-examples"); continue; }
    examples.push(Object.freeze({
      id: `${event.id}:${examples.length}`,
      sourceEventId: event.id,
      kind: event.kind,
      name: event.name,
      occurredAt: event.occurredAt,
      source: event.source,
      labels: event.labels,
      attributes: normalizedPolicy.includeAttributes ? event.attributes : Object.freeze({}),
      textIncluded: normalizedPolicy.includeText,
    }));
  }
  return Object.freeze({
    schema: "omnia.learning-dataset.v1",
    generatedAt,
    policy: normalizedPolicy,
    totalEvents: events.length,
    eligibleEvents: examples.length,
    heldEvents: events.length - examples.length,
    examples: Object.freeze(examples),
    exclusions: Object.freeze(exclusions),
  });
}

function normalizeMetricRecord(metrics: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> {
  return normalizeMetricMap(metrics, "learning metric");
}

/** Pure lifecycle helpers make native training adapters replaceable without coupling the renderer to an ML framework. */
export function createOmniaLearningRun(input: CreateOmniaLearningRunInput): OmniaLearningRun {
  const now = input.now ?? new Date().toISOString();
  assertIsoTimestamp(now, "learning run creation time");
  return Object.freeze({
    schemaVersion: 1,
    id: input.id ?? createEntityId<"omnia-learning-run">(),
    name: assertNonBlank(input.name, "learning run name", 200),
    mode: input.mode,
    status: "planned",
    createdAt: now,
    updatedAt: now,
    step: 0,
    metrics: Object.freeze({}),
    checkpoints: Object.freeze([]),
    ...(input.dataset === undefined ? {} : { dataset: input.dataset }),
  });
}

export function startOmniaLearningRun(run: OmniaLearningRun, now = new Date().toISOString()): OmniaLearningRun {
  assertIsoTimestamp(now, "learning run start time");
  assertDomain(run.status === "planned" || run.status === "paused", "invalid_state_transition", "Only planned or paused learning runs can start.");
  return Object.freeze({ ...run, status: "running", updatedAt: now });
}

export function recordOmniaLearningStep(run: OmniaLearningRun, input: OmniaLearningStepInput): OmniaLearningRun {
  const now = input.now ?? new Date().toISOString();
  assertIsoTimestamp(now, "learning step time");
  assertDomain(run.status === "running", "invalid_state_transition", "Learning steps require a running learning run.");
  assertBoundedInteger(input.step, "learning step", run.step, Number.MAX_SAFE_INTEGER);
  return Object.freeze({ ...run, updatedAt: now, step: input.step, metrics: normalizeMetricRecord({ ...run.metrics, ...(input.metrics ?? {}) }) });
}

export function addOmniaLearningCheckpoint(run: OmniaLearningRun, input: OmniaLearningCheckpointInput): OmniaLearningRun {
  const now = input.now ?? new Date().toISOString();
  assertIsoTimestamp(now, "learning checkpoint time");
  assertDomain(run.status === "running" || run.status === "paused", "invalid_state_transition", "A checkpoint requires a running or paused learning run.");
  const step = input.step ?? run.step;
  assertBoundedInteger(step, "checkpoint step", 0, run.step);
  const checkpoint: OmniaLearningCheckpoint = Object.freeze({
    id: createEntityId<"omnia-learning-checkpoint">(),
    runId: run.id,
    step,
    createdAt: now,
    label: assertNonBlank(input.label, "checkpoint label", 200),
    metrics: normalizeMetricRecord({ ...run.metrics, ...(input.metrics ?? {}) }),
    ...(input.artifactRef === undefined ? {} : { artifactRef: assertNonBlank(input.artifactRef, "checkpoint artifact reference", 1_000) }),
  });
  return Object.freeze({ ...run, updatedAt: now, checkpoints: Object.freeze([...run.checkpoints, checkpoint]) });
}

export function finishOmniaLearningRun(run: OmniaLearningRun, status: Extract<OmniaLearningRunStatus, "completed" | "failed" | "cancelled">, now = new Date().toISOString(), failureReason?: string): OmniaLearningRun {
  assertIsoTimestamp(now, "learning run finish time");
  assertDomain(run.status === "running" || run.status === "paused" || run.status === "planned", "invalid_state_transition", "Learning run is already terminal.");
  const reason = failureReason === undefined ? undefined : assertNonBlank(failureReason, "learning failure reason", 2_000);
  return Object.freeze({ ...run, status, updatedAt: now, ...(reason === undefined ? {} : { failureReason: reason }) });
}
