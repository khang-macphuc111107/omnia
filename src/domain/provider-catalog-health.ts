import { assertDomain } from "./errors";
import type { EntityId, ModelProfileId, ProviderConnectionId } from "./ids";
import type { ModelDescriptor } from "./provider";
import {
  parseProviderErrorClass,
  projectProviderHealth,
  type ProviderErrorClass,
  type ProviderHealthObservation,
  type ProviderHealthPolicy,
  type ProviderHealthProjection,
  type ProviderHealthState,
} from "./telemetry";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

export type ModelCatalogSnapshotId = EntityId<"model-catalog-snapshot">;
export type ModelCatalogRefreshReceiptId =
  EntityId<"model-catalog-refresh-receipt">;
export type ModelCatalogFallbackReceiptId =
  EntityId<"model-catalog-fallback-receipt">;
export type ModelDescriptorRevisionId = EntityId<"model-descriptor-revision">;

export type ModelCatalogSource =
  "provider-live" | "signed-curated" | "adapter-static" | "user-custom";

/**
 * One immutable descriptor revision inside a catalog snapshot. Provider model
 * names are not capability evidence; the exact descriptor revision and hash
 * must be frozen into a provider attempt before dispatch.
 */
export interface CatalogModelRevision {
  readonly revisionId: ModelDescriptorRevisionId;
  readonly descriptorSha256: string;
  readonly aliases: readonly string[];
  readonly descriptor: ModelDescriptor;
}

/**
 * A successful discovery result. The snapshot never changes after creation;
 * 304/revalidation evidence is represented by a separate refresh receipt.
 */
export interface ModelCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly id: ModelCatalogSnapshotId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerDefinitionRevisionId: string;
  readonly providerDefinitionSha256: string;
  readonly endpointFingerprintSha256: string;
  readonly adapterVersion: string;
  readonly catalogRevision: string;
  readonly contentSha256: string;
  readonly source: ModelCatalogSource;
  readonly observedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly models: readonly CatalogModelRevision[];
  readonly metadata: JsonObject;
}

export interface CreateModelCatalogSnapshotInput extends Omit<
  ModelCatalogSnapshot,
  "schemaVersion" | "models" | "metadata"
> {
  readonly models: readonly CatalogModelRevision[];
  readonly metadata?: JsonObject;
}

export type ModelCatalogRefreshOutcome =
  "succeeded" | "not-modified" | "failed";

export interface ModelCatalogRefreshReceipt {
  readonly schemaVersion: 1;
  readonly id: ModelCatalogRefreshReceiptId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerDefinitionRevisionId: string;
  readonly providerDefinitionSha256: string;
  readonly endpointFingerprintSha256: string;
  readonly adapterVersion: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly outcome: ModelCatalogRefreshOutcome;
  /** Present for succeeded and not-modified outcomes only. */
  readonly snapshotId?: ModelCatalogSnapshotId;
  /** A 304-style revalidation extends validity without mutating the snapshot. */
  readonly revalidatedUntil?: IsoTimestamp;
  readonly errorClass?: ProviderErrorClass;
  /** Renderer-safe stable code only; never a provider body or raw exception. */
  readonly diagnosticCode?: string;
}

export interface CreateModelCatalogRefreshReceiptInput extends Omit<
  ModelCatalogRefreshReceipt,
  "schemaVersion"
> {}

export interface StaleCatalogFallbackAuthorization {
  readonly receiptId: ModelCatalogFallbackReceiptId;
  readonly decisionRef: string;
  readonly maxStaleMs: number;
}

export interface ResolveModelCatalogInput {
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerDefinitionRevisionId: string;
  readonly providerDefinitionSha256: string;
  readonly endpointFingerprintSha256: string;
  readonly adapterVersion: string;
  readonly now: IsoTimestamp;
  readonly snapshots: readonly ModelCatalogSnapshot[];
  readonly refreshReceipts: readonly ModelCatalogRefreshReceipt[];
  /** Absence means stale fallback is denied. */
  readonly staleFallback?: StaleCatalogFallbackAuthorization;
}

export type ModelCatalogUnavailableReason =
  | "catalog-missing"
  | "provider-definition-drift"
  | "endpoint-drift"
  | "adapter-version-drift"
  | "stale-fallback-not-authorized"
  | "stale-window-exceeded";

export interface ModelCatalogFallbackReceipt {
  readonly schemaVersion: 1;
  readonly id: ModelCatalogFallbackReceiptId;
  readonly decisionRef: string;
  readonly providerConnectionId: ProviderConnectionId;
  readonly snapshotId: ModelCatalogSnapshotId;
  readonly snapshotContentSha256: string;
  readonly reason: "catalog-expired" | "refresh-failed";
  readonly staleByMs: number;
  readonly authorizedMaxStaleMs: number;
  readonly createdAt: IsoTimestamp;
  readonly triggeringRefreshReceiptId?: ModelCatalogRefreshReceiptId;
}

export type ModelCatalogResolution =
  | {
      readonly state: "fresh";
      readonly snapshot: ModelCatalogSnapshot;
      readonly effectiveExpiresAt: IsoTimestamp;
      readonly latestRefreshReceipt: ModelCatalogRefreshReceipt | null;
    }
  | {
      readonly state: "stale-last-known-good";
      readonly snapshot: ModelCatalogSnapshot;
      readonly effectiveExpiresAt: IsoTimestamp;
      readonly latestRefreshReceipt: ModelCatalogRefreshReceipt | null;
      readonly fallbackReceipt: ModelCatalogFallbackReceipt;
    }
  | {
      readonly state: "unavailable";
      readonly reason: ModelCatalogUnavailableReason;
    };

export type CatalogModelUnavailableReason =
  | ModelCatalogUnavailableReason
  | "requested-model-missing"
  | "model-hidden"
  | "model-descriptor-expired";

export type CatalogModelResolution =
  | {
      readonly state: "resolved";
      readonly catalog: Extract<
        ModelCatalogResolution,
        { readonly state: "fresh" | "stale-last-known-good" }
      >;
      readonly model: CatalogModelRevision;
    }
  | {
      readonly state: "unavailable";
      readonly reason: CatalogModelUnavailableReason;
    };

/** Exact, byte-free model/catalog provenance stored with a prepared attempt. */
export interface FrozenCatalogModelSelection {
  readonly schemaVersion: 1;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerDefinitionRevisionId: string;
  readonly providerDefinitionSha256: string;
  readonly endpointFingerprintSha256: string;
  readonly adapterVersion: string;
  readonly catalogSnapshotId: ModelCatalogSnapshotId;
  readonly catalogRevision: string;
  readonly catalogContentSha256: string;
  readonly catalogFreshness: "fresh" | "stale-last-known-good";
  readonly modelProfileId: ModelProfileId;
  readonly providerModelId: string;
  readonly modelDescriptorRevisionId: ModelDescriptorRevisionId;
  readonly modelDescriptorSha256: string;
  readonly frozenAt: IsoTimestamp;
  readonly fallbackReceiptId?: ModelCatalogFallbackReceiptId;
  readonly fallbackDecisionRef?: string;
}

export type ProviderCatalogHealthState = ProviderHealthState;

export type ProviderCatalogHealthReason =
  | "catalog-unavailable"
  | "catalog-stale"
  | "connection-health-unknown"
  | "connection-degraded"
  | "connection-unavailable"
  | "model-health-unknown"
  | "model-degraded"
  | "model-unavailable";

export interface ProviderCatalogHealthProjection {
  readonly state: ProviderCatalogHealthState;
  readonly catalogState: ModelCatalogResolution["state"];
  readonly connection: ProviderHealthProjection;
  readonly model: ProviderHealthProjection | null;
  readonly reasons: readonly ProviderCatalogHealthReason[];
}

export interface ProjectProviderCatalogHealthInput {
  readonly catalog: ModelCatalogResolution;
  readonly observations: readonly ProviderHealthObservation[];
  readonly providerConnectionId: ProviderConnectionId;
  readonly modelProfileId: ModelProfileId | null;
  readonly policy: ProviderHealthPolicy;
}

const MAX_CATALOG_MODELS = 20_000;
const MAX_ALIASES_PER_MODEL = 128;
const MAX_DESCRIPTOR_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 20_000;

const MODEL_CATALOG_SOURCES: ReadonlySet<ModelCatalogSource> = new Set([
  "provider-live",
  "signed-curated",
  "adapter-static",
  "user-custom",
]);

const REFRESH_OUTCOMES: ReadonlySet<ModelCatalogRefreshOutcome> = new Set([
  "succeeded",
  "not-modified",
  "failed",
]);

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const ALWAYS_SENSITIVE_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "passwd",
  "password",
  "secret",
  "secrets",
]);

const TOKEN_CREDENTIAL_PREFIXES: ReadonlySet<string> = new Set([
  "access",
  "api",
  "auth",
  "authorization",
  "bearer",
  "id",
  "identity",
  "oauth",
  "refresh",
  "session",
]);

const KEY_CREDENTIAL_PREFIXES: ReadonlySet<string> = new Set([
  "api",
  "auth",
  "client",
  "private",
  "secret",
]);

const MERGED_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "accesstoken",
  "apikey",
  "authorizationtoken",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "privatekey",
  "refreshtoken",
  "sessionid",
]);

function assertNonNegativeSafeInteger(value: number, label: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    "invalid_argument",
    `${label} must be a non-negative safe integer.`,
    { label, value },
  );
  return value;
}

function normalizeSecurityKey(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isPrototypePollutionKey(value: string): boolean {
  return PROTOTYPE_POLLUTION_KEYS.has(value.trim().toLowerCase());
}

function isCredentialLikeKey(value: string): boolean {
  const normalized = normalizeSecurityKey(value);
  if (normalized.length === 0) return false;
  if (MERGED_CREDENTIAL_KEYS.has(normalized) || normalized === "token")
    return true;
  const segments = normalized.split("_");
  if (segments.some((segment) => ALWAYS_SENSITIVE_KEY_SEGMENTS.has(segment)))
    return true;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    if (
      (next === "token" && TOKEN_CREDENTIAL_PREFIXES.has(current ?? "")) ||
      (next === "key" && KEY_CREDENTIAL_PREFIXES.has(current ?? "")) ||
      (current === "session" && next === "id") ||
      (current === "auth" && next === "header")
    ) {
      return true;
    }
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    if (!Object.isFrozen(current)) Object.freeze(current);
  }
  return value;
}

function assertBoundedJsonTree(
  value: unknown,
  label: string,
  rejectCredentialKeys: boolean,
): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    assertDomain(
      nodes <= MAX_JSON_NODES && current.depth <= MAX_JSON_DEPTH,
      "invalid_argument",
      `${label} is too deeply nested or too large.`,
    );
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      assertDomain(
        Number.isFinite(current.value),
        "invalid_argument",
        `${label} must contain only finite JSON numbers.`,
      );
      continue;
    }
    assertDomain(
      typeof current.value === "object",
      "invalid_argument",
      `${label} must be JSON-compatible.`,
    );
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    assertDomain(
      prototype === Object.prototype || prototype === null,
      "invalid_argument",
      `${label} must contain only plain JSON objects.`,
    );
    for (const [key, child] of Object.entries(current.value)) {
      assertDomain(
        key.length > 0 && key.length <= 160,
        "invalid_argument",
        `${label} contains an invalid object key.`,
      );
      assertDomain(
        !isPrototypePollutionKey(key),
        "permission_denied",
        `${label} cannot contain prototype-related fields.`,
      );
      if (rejectCredentialKeys) {
        assertDomain(
          !isCredentialLikeKey(key),
          "permission_denied",
          `${label} cannot contain credential-like fields.`,
        );
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function cloneJsonBounded<T>(value: T, label: string, maxBytes: number): T {
  assertBoundedJsonTree(value, label, false);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    assertDomain(
      false,
      "invalid_argument",
      `${label} must be JSON-compatible.`,
    );
  }
  assertDomain(
    serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <= maxBytes,
    "invalid_argument",
    `${label} exceeds its serialized size limit.`,
    { maxBytes },
  );
  return deepFreeze(JSON.parse(serialized) as T);
}

function assertSafeExtensionJson(value: JsonObject): void {
  assertBoundedJsonTree(value, "Catalog extension metadata", true);
}

function assertSafeDiagnosticCode(value: string): string {
  const code = assertNonBlank(value, "catalog diagnostic code", 160);
  assertDomain(
    /^[a-z0-9][a-z0-9._:-]*$/i.test(code) && !isCredentialLikeKey(code),
    "invalid_argument",
    "Catalog diagnostic code must be a stable renderer-safe identifier.",
  );
  return code;
}

function assertModelDescriptor(
  revision: CatalogModelRevision,
  providerConnectionId: ProviderConnectionId,
  snapshotObservedAt: IsoTimestamp,
): CatalogModelRevision {
  const descriptor = revision.descriptor;
  assertDomain(
    descriptor.connectionId === providerConnectionId,
    "scope_violation",
    "Catalog model belongs to a different provider connection.",
  );
  assertNonBlank(descriptor.id, "model profile ID", 256);
  assertNonBlank(revision.revisionId, "model descriptor revision ID", 256);
  const descriptorSha256 = assertSha256(
    revision.descriptorSha256,
    "model descriptor content hash",
  );
  const providerModelId = assertNonBlank(
    descriptor.providerModelId,
    "provider model ID",
    512,
  );
  const displayName = assertNonBlank(
    descriptor.displayName,
    "model display name",
    240,
  );
  assertIsoTimestamp(descriptor.discoveredAt, "model discovery time");
  assertDomain(
    Date.parse(descriptor.discoveredAt) <= Date.parse(snapshotObservedAt),
    "invalid_argument",
    "A model cannot be discovered after its catalog snapshot.",
  );
  if (descriptor.expiresAt !== undefined) {
    assertIsoTimestamp(descriptor.expiresAt, "model descriptor expiry");
    assertDomain(
      Date.parse(descriptor.expiresAt) > Date.parse(descriptor.discoveredAt),
      "invalid_argument",
      "Model descriptor expiry must follow discovery.",
    );
  }
  const aliases = revision.aliases.map((alias) =>
    assertNonBlank(alias, "model alias", 240),
  );
  assertDomain(
    aliases.length <= MAX_ALIASES_PER_MODEL &&
      new Set(aliases).size === aliases.length,
    "invalid_argument",
    "Model aliases must be unique and bounded.",
  );
  if (descriptor.pricing !== undefined) {
    assertIsoTimestamp(
      descriptor.pricing.observedAt,
      "model pricing observation time",
    );
    assertNonBlank(descriptor.pricing.currency, "model pricing currency", 16);
    for (const value of [
      descriptor.pricing.inputMicrounitsPerMillionTokens,
      descriptor.pricing.cachedInputMicrounitsPerMillionTokens,
      descriptor.pricing.outputMicrounitsPerMillionTokens,
    ]) {
      if (value !== undefined)
        assertNonNegativeSafeInteger(value, "model price");
    }
  }
  for (const capability of [
    descriptor.capabilities.inputModalities,
    descriptor.capabilities.outputModalities,
    descriptor.capabilities.streaming,
    descriptor.capabilities.tools,
    descriptor.capabilities.parallelTools,
    descriptor.capabilities.structuredOutput,
    descriptor.capabilities.jsonSchema,
    descriptor.capabilities.reasoning,
    descriptor.capabilities.promptCaching,
    descriptor.capabilities.backgroundMode,
    descriptor.capabilities.contextWindowTokens,
    descriptor.capabilities.maxOutputTokens,
    descriptor.capabilities.supportedRoles,
    ...Object.values(descriptor.capabilities.native),
  ]) {
    assertIsoTimestamp(
      capability.observedAt,
      "model capability observation time",
    );
    assertDomain(
      Date.parse(capability.observedAt) <= Date.parse(snapshotObservedAt),
      "invalid_argument",
      "A capability observation cannot postdate its catalog snapshot.",
    );
  }
  for (const value of [
    descriptor.capabilities.contextWindowTokens.value,
    descriptor.capabilities.maxOutputTokens.value,
  ]) {
    if (value !== null)
      assertNonNegativeSafeInteger(value, "model token limit");
  }
  assertSafeExtensionJson(descriptor.extensions);
  const frozenDescriptor = cloneJsonBounded(
    {
      ...descriptor,
      providerModelId,
      displayName,
    },
    "model descriptor",
    MAX_DESCRIPTOR_BYTES,
  );
  return Object.freeze({
    revisionId: revision.revisionId,
    descriptorSha256,
    aliases: Object.freeze([...aliases]),
    descriptor: frozenDescriptor,
  });
}

export function createModelCatalogSnapshot(
  input: CreateModelCatalogSnapshotInput,
): ModelCatalogSnapshot {
  assertDomain(
    MODEL_CATALOG_SOURCES.has(input.source),
    "invalid_argument",
    "Model catalog source is not recognized.",
  );
  assertIsoTimestamp(input.observedAt, "model catalog observation time");
  assertIsoTimestamp(input.expiresAt, "model catalog expiry time");
  assertDomain(
    Date.parse(input.expiresAt) > Date.parse(input.observedAt),
    "invalid_argument",
    "Model catalog expiry must follow observation time.",
  );
  assertDomain(
    input.models.length <= MAX_CATALOG_MODELS,
    "invalid_argument",
    "Model catalog contains too many entries.",
    { maxModels: MAX_CATALOG_MODELS },
  );
  const models = input.models
    .map((model) =>
      assertModelDescriptor(
        model,
        input.providerConnectionId,
        input.observedAt,
      ),
    )
    .sort(
      (left, right) =>
        left.descriptor.providerModelId.localeCompare(
          right.descriptor.providerModelId,
        ) ||
        String(left.descriptor.id).localeCompare(String(right.descriptor.id)),
    );
  assertDomain(
    new Set(models.map((model) => model.descriptor.id)).size === models.length,
    "conflict",
    "Model catalog contains duplicate model profile IDs.",
  );
  assertDomain(
    new Set(models.map((model) => model.descriptor.providerModelId)).size ===
      models.length,
    "conflict",
    "Model catalog contains duplicate provider model IDs.",
  );
  assertDomain(
    new Set(models.map((model) => model.revisionId)).size === models.length,
    "conflict",
    "Model catalog contains duplicate descriptor revision IDs.",
  );
  const metadata = input.metadata ?? {};
  assertSafeExtensionJson(metadata);
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    providerConnectionId: input.providerConnectionId,
    providerDefinitionRevisionId: assertNonBlank(
      input.providerDefinitionRevisionId,
      "provider definition revision ID",
      256,
    ),
    providerDefinitionSha256: assertSha256(
      input.providerDefinitionSha256,
      "provider definition hash",
    ),
    endpointFingerprintSha256: assertSha256(
      input.endpointFingerprintSha256,
      "provider endpoint fingerprint",
    ),
    adapterVersion: assertNonBlank(
      input.adapterVersion,
      "provider adapter version",
      256,
    ),
    catalogRevision: assertNonBlank(
      input.catalogRevision,
      "model catalog revision",
      256,
    ),
    contentSha256: assertSha256(
      input.contentSha256,
      "model catalog content hash",
    ),
    source: input.source,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
    models: Object.freeze(models),
    metadata: cloneJsonBounded(
      metadata,
      "catalog metadata",
      MAX_METADATA_BYTES,
    ),
  });
}

export function createModelCatalogRefreshReceipt(
  input: CreateModelCatalogRefreshReceiptInput,
): ModelCatalogRefreshReceipt {
  assertDomain(
    REFRESH_OUTCOMES.has(input.outcome),
    "invalid_argument",
    "Model catalog refresh outcome is not recognized.",
  );
  assertIsoTimestamp(input.startedAt, "catalog refresh start time");
  assertIsoTimestamp(input.finishedAt, "catalog refresh finish time");
  assertDomain(
    Date.parse(input.finishedAt) >= Date.parse(input.startedAt),
    "invalid_argument",
    "Catalog refresh cannot finish before it starts.",
  );
  const succeeded = input.outcome === "succeeded";
  const notModified = input.outcome === "not-modified";
  const failed = input.outcome === "failed";
  const errorClass =
    input.errorClass === undefined ? undefined : parseProviderErrorClass(input.errorClass);
  assertDomain(
    (succeeded || notModified) === (input.snapshotId !== undefined),
    "invalid_argument",
    "Successful catalog refresh evidence must identify its exact snapshot.",
  );
  assertDomain(
    notModified === (input.revalidatedUntil !== undefined),
    "invalid_argument",
    "Only a not-modified receipt may extend snapshot validity.",
  );
  assertDomain(
    failed === (input.errorClass !== undefined),
    "invalid_argument",
    "A failed catalog refresh requires a typed error class and successful refreshes cannot carry one.",
  );
  assertDomain(
    input.errorClass === undefined || errorClass !== undefined,
    "invalid_argument",
    "Catalog refresh error class is not recognized.",
  );
  if (input.revalidatedUntil !== undefined) {
    assertIsoTimestamp(input.revalidatedUntil, "catalog revalidation expiry");
    assertDomain(
      Date.parse(input.revalidatedUntil) > Date.parse(input.finishedAt),
      "invalid_argument",
      "Catalog revalidation expiry must follow the refresh.",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    providerConnectionId: input.providerConnectionId,
    providerDefinitionRevisionId: assertNonBlank(
      input.providerDefinitionRevisionId,
      "provider definition revision ID",
      256,
    ),
    providerDefinitionSha256: assertSha256(
      input.providerDefinitionSha256,
      "provider definition hash",
    ),
    endpointFingerprintSha256: assertSha256(
      input.endpointFingerprintSha256,
      "provider endpoint fingerprint",
    ),
    adapterVersion: assertNonBlank(
      input.adapterVersion,
      "provider adapter version",
      256,
    ),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
    ...(input.revalidatedUntil === undefined
      ? {}
      : { revalidatedUntil: input.revalidatedUntil }),
    ...(errorClass === undefined ? {} : { errorClass }),
    ...(input.diagnosticCode === undefined
      ? {}
      : { diagnosticCode: assertSafeDiagnosticCode(input.diagnosticCode) }),
  });
}

function unavailable(
  reason: ModelCatalogUnavailableReason,
): ModelCatalogResolution {
  return Object.freeze({ state: "unavailable", reason });
}

function latestReceipt(
  receipts: readonly ModelCatalogRefreshReceipt[],
): ModelCatalogRefreshReceipt | null {
  return (
    [...receipts].sort(
      (left, right) =>
        Date.parse(right.finishedAt) - Date.parse(left.finishedAt) ||
        String(right.id).localeCompare(String(left.id)),
    )[0] ?? null
  );
}

export function resolveModelCatalog(
  input: ResolveModelCatalogInput,
): ModelCatalogResolution {
  assertIsoTimestamp(input.now, "model catalog resolution time");
  const providerDefinitionRevisionId = assertNonBlank(
    input.providerDefinitionRevisionId,
    "provider definition revision ID",
    256,
  );
  const providerDefinitionSha256 = assertSha256(
    input.providerDefinitionSha256,
    "provider definition hash",
  );
  const endpointFingerprintSha256 = assertSha256(
    input.endpointFingerprintSha256,
    "provider endpoint fingerprint",
  );
  const adapterVersion = assertNonBlank(
    input.adapterVersion,
    "provider adapter version",
    256,
  );
  const nowMs = Date.parse(input.now);
  const providerSnapshots = input.snapshots.filter(
    (snapshot) =>
      snapshot.providerConnectionId === input.providerConnectionId &&
      Date.parse(snapshot.observedAt) <= nowMs,
  );
  if (providerSnapshots.length === 0) return unavailable("catalog-missing");
  const definitionSnapshots = providerSnapshots.filter(
    (snapshot) =>
      snapshot.providerDefinitionRevisionId === providerDefinitionRevisionId &&
      snapshot.providerDefinitionSha256 === providerDefinitionSha256,
  );
  if (definitionSnapshots.length === 0)
    return unavailable("provider-definition-drift");
  const endpointSnapshots = definitionSnapshots.filter(
    (snapshot) =>
      snapshot.endpointFingerprintSha256 === endpointFingerprintSha256,
  );
  if (endpointSnapshots.length === 0) return unavailable("endpoint-drift");
  const adapterSnapshots = endpointSnapshots.filter(
    (snapshot) => snapshot.adapterVersion === adapterVersion,
  );
  if (adapterSnapshots.length === 0)
    return unavailable("adapter-version-drift");
  const snapshot = [...adapterSnapshots].sort(
    (left, right) =>
      Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
      String(right.id).localeCompare(String(left.id)),
  )[0];
  if (snapshot === undefined) return unavailable("catalog-missing");

  const receipts = input.refreshReceipts.filter(
    (receipt) =>
      receipt.providerConnectionId === input.providerConnectionId &&
      receipt.providerDefinitionRevisionId === providerDefinitionRevisionId &&
      receipt.providerDefinitionSha256 === providerDefinitionSha256 &&
      receipt.endpointFingerprintSha256 === endpointFingerprintSha256 &&
      receipt.adapterVersion === adapterVersion &&
      Date.parse(receipt.finishedAt) <= nowMs &&
      (receipt.snapshotId === undefined || receipt.snapshotId === snapshot.id),
  );
  const newestReceipt = latestReceipt(receipts);
  const revalidatedUntilMs = receipts.reduce(
    (current, receipt) =>
      receipt.outcome === "not-modified" &&
      receipt.revalidatedUntil !== undefined
        ? Math.max(current, Date.parse(receipt.revalidatedUntil))
        : current,
    Date.parse(snapshot.expiresAt),
  );
  const effectiveExpiresAt = new Date(revalidatedUntilMs).toISOString();
  if (nowMs < revalidatedUntilMs) {
    return Object.freeze({
      state: "fresh",
      snapshot,
      effectiveExpiresAt,
      latestRefreshReceipt: newestReceipt,
    });
  }

  if (input.staleFallback === undefined) {
    return unavailable("stale-fallback-not-authorized");
  }
  const maxStaleMs = assertNonNegativeSafeInteger(
    input.staleFallback.maxStaleMs,
    "maximum stale catalog age",
  );
  const staleByMs = nowMs - revalidatedUntilMs;
  if (staleByMs > maxStaleMs) return unavailable("stale-window-exceeded");
  const triggeringFailure = receipts
    .filter(
      (receipt) =>
        receipt.outcome === "failed" &&
        Date.parse(receipt.finishedAt) >= revalidatedUntilMs,
    )
    .sort(
      (left, right) =>
        Date.parse(right.finishedAt) - Date.parse(left.finishedAt),
    )[0];
  const fallbackReceipt: ModelCatalogFallbackReceipt = Object.freeze({
    schemaVersion: 1,
    id: input.staleFallback.receiptId,
    decisionRef: assertNonBlank(
      input.staleFallback.decisionRef,
      "catalog fallback decision",
      512,
    ),
    providerConnectionId: input.providerConnectionId,
    snapshotId: snapshot.id,
    snapshotContentSha256: snapshot.contentSha256,
    reason:
      triggeringFailure === undefined ? "catalog-expired" : "refresh-failed",
    staleByMs,
    authorizedMaxStaleMs: maxStaleMs,
    createdAt: input.now,
    ...(triggeringFailure === undefined
      ? {}
      : { triggeringRefreshReceiptId: triggeringFailure.id }),
  });
  return Object.freeze({
    state: "stale-last-known-good",
    snapshot,
    effectiveExpiresAt,
    latestRefreshReceipt: newestReceipt,
    fallbackReceipt,
  });
}

export function resolveCatalogModel(
  catalog: ModelCatalogResolution,
  modelProfileId: ModelProfileId,
  now: IsoTimestamp,
): CatalogModelResolution {
  assertIsoTimestamp(now, "catalog model resolution time");
  if (catalog.state === "unavailable") {
    return Object.freeze({ state: "unavailable", reason: catalog.reason });
  }
  const model = catalog.snapshot.models.find(
    (candidate) => candidate.descriptor.id === modelProfileId,
  );
  if (model === undefined) {
    return Object.freeze({
      state: "unavailable",
      reason: "requested-model-missing",
    });
  }
  if (model.descriptor.hidden) {
    return Object.freeze({ state: "unavailable", reason: "model-hidden" });
  }
  if (
    model.descriptor.expiresAt !== undefined &&
    Date.parse(model.descriptor.expiresAt) <= Date.parse(now)
  ) {
    return Object.freeze({
      state: "unavailable",
      reason: "model-descriptor-expired",
    });
  }
  return Object.freeze({ state: "resolved", catalog, model });
}

export function freezeCatalogModelSelection(
  resolution: CatalogModelResolution,
  frozenAt: IsoTimestamp,
): FrozenCatalogModelSelection {
  assertIsoTimestamp(frozenAt, "catalog model freeze time");
  assertDomain(
    resolution.state === "resolved",
    "invalid_state_transition",
    "An unavailable catalog model cannot be frozen for dispatch.",
  );
  const { catalog, model } = resolution;
  const snapshot = catalog.snapshot;
  return Object.freeze({
    schemaVersion: 1,
    providerConnectionId: snapshot.providerConnectionId,
    providerDefinitionRevisionId: snapshot.providerDefinitionRevisionId,
    providerDefinitionSha256: snapshot.providerDefinitionSha256,
    endpointFingerprintSha256: snapshot.endpointFingerprintSha256,
    adapterVersion: snapshot.adapterVersion,
    catalogSnapshotId: snapshot.id,
    catalogRevision: snapshot.catalogRevision,
    catalogContentSha256: snapshot.contentSha256,
    catalogFreshness: catalog.state,
    modelProfileId: model.descriptor.id,
    providerModelId: model.descriptor.providerModelId,
    modelDescriptorRevisionId: model.revisionId,
    modelDescriptorSha256: model.descriptorSha256,
    frozenAt,
    ...(catalog.state === "fresh"
      ? {}
      : {
          fallbackReceiptId: catalog.fallbackReceipt.id,
          fallbackDecisionRef: catalog.fallbackReceipt.decisionRef,
        }),
  });
}

function healthReason(
  scope: "connection" | "model",
  state: ProviderHealthState,
): ProviderCatalogHealthReason | null {
  if (state === "healthy") return null;
  if (scope === "connection") {
    if (state === "unknown") return "connection-health-unknown";
    if (state === "degraded") return "connection-degraded";
    return "connection-unavailable";
  }
  if (state === "unknown") return "model-health-unknown";
  if (state === "degraded") return "model-degraded";
  return "model-unavailable";
}

function effectiveHealthState(
  catalog: ModelCatalogResolution,
  connection: ProviderHealthProjection,
  model: ProviderHealthProjection | null,
): ProviderHealthState {
  if (
    catalog.state === "unavailable" ||
    connection.state === "unavailable" ||
    model?.state === "unavailable"
  ) {
    return "unavailable";
  }
  if (connection.state === "unknown" || model?.state === "unknown")
    return "unknown";
  if (
    catalog.state === "stale-last-known-good" ||
    connection.state === "degraded" ||
    model?.state === "degraded"
  ) {
    return "degraded";
  }
  return "healthy";
}

/**
 * Connection, model, and catalog health remain separate projections. A fresh
 * catalog alone never manufactures a healthy provider/model badge.
 */
export function projectProviderCatalogHealth(
  input: ProjectProviderCatalogHealthInput,
): ProviderCatalogHealthProjection {
  if (input.catalog.state !== "unavailable") {
    assertDomain(
      input.catalog.snapshot.providerConnectionId ===
        input.providerConnectionId,
      "scope_violation",
      "Catalog health projection crossed provider connections.",
    );
  }
  const connectionObservations = input.observations.filter(
    (observation) =>
      observation.scope.providerConnectionId === input.providerConnectionId &&
      observation.scope.modelProfileId === undefined,
  );
  const connection = projectProviderHealth(
    connectionObservations,
    input.providerConnectionId,
    null,
    input.policy,
  );
  const model =
    input.modelProfileId === null
      ? null
      : projectProviderHealth(
          input.observations.filter(
            (observation) =>
              observation.scope.providerConnectionId ===
                input.providerConnectionId &&
              observation.scope.modelProfileId === input.modelProfileId,
          ),
          input.providerConnectionId,
          input.modelProfileId,
          input.policy,
        );
  const reasons: ProviderCatalogHealthReason[] = [];
  if (input.catalog.state === "unavailable")
    reasons.push("catalog-unavailable");
  else if (input.catalog.state === "stale-last-known-good")
    reasons.push("catalog-stale");
  const connectionReason = healthReason("connection", connection.state);
  if (connectionReason !== null) reasons.push(connectionReason);
  if (model !== null) {
    const modelReason = healthReason("model", model.state);
    if (modelReason !== null) reasons.push(modelReason);
  }
  return Object.freeze({
    state: effectiveHealthState(input.catalog, connection, model),
    catalogState: input.catalog.state,
    connection,
    model,
    reasons: Object.freeze(reasons),
  });
}
