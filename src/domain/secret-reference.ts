import { assertDomain } from "./errors";
import {
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";

/**
 * A renderer-safe handle for a credential owned by the native secret broker.
 *
 * Omnia deliberately keeps the handle separate from the secret material. A
 * handle may be persisted in native metadata, but it must never be treated as
 * a credential value or sent to a provider directly by the renderer.
 */
export type SecretReferenceValue = string & { readonly __omniaSecretReference: unique symbol };

export type SecretReferenceKind =
  | "provider-credential"
  | "oauth-token"
  | "ssh-key"
  | "signing-key"
  | "webhook-secret"
  | "custom";

export type SecretReferenceStatus = "unknown" | "present" | "missing" | "locked" | "revoked";

export interface SecretReferenceScope {
  readonly kind: "profile" | "project" | "workspace" | "integration" | "global";
  readonly id?: string;
}

export interface SecretReference {
  readonly schemaVersion: 1;
  /** Opaque broker handle; never the raw secret bytes. */
  readonly reference: SecretReferenceValue;
  readonly kind: SecretReferenceKind;
  readonly displayName: string;
  readonly status: SecretReferenceStatus;
  readonly scope?: SecretReferenceScope;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastCheckedAt?: IsoTimestamp;
  readonly lastUsedAt?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  /** Metadata is portable-safe and must not contain secret-like keys. */
  readonly metadata: JsonObject;
}

export interface CreateSecretReferenceInput {
  readonly reference: string;
  readonly kind: SecretReferenceKind;
  readonly displayName: string;
  readonly status?: SecretReferenceStatus;
  readonly scope?: SecretReferenceScope;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly lastCheckedAt?: IsoTimestamp;
  readonly lastUsedAt?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export interface SecretReferenceStore {
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly references: readonly SecretReference[];
}

/** Export shape used by settings/workspace transfer. The actual handle is redacted. */
export interface PortableSecretReference {
  readonly schemaVersion: 1;
  readonly reference: "opaque://redacted-ref";
  readonly kind: SecretReferenceKind;
  readonly displayName: string;
  readonly status: SecretReferenceStatus;
  readonly scope?: SecretReferenceScope;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastCheckedAt?: IsoTimestamp;
  readonly lastUsedAt?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly metadata: JsonObject;
}

export interface PortableSecretReferenceStore {
  readonly version: 1;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly references: readonly PortableSecretReference[];
}

const SECRET_REFERENCE_KINDS: readonly SecretReferenceKind[] = [
  "provider-credential",
  "oauth-token",
  "ssh-key",
  "signing-key",
  "webhook-secret",
  "custom",
];
const SECRET_REFERENCE_STATUSES: readonly SecretReferenceStatus[] = [
  "unknown",
  "present",
  "missing",
  "locked",
  "revoked",
];
const SECRET_REFERENCE_SCOPE_KINDS: readonly SecretReferenceScope["kind"][] = [
  "profile",
  "project",
  "workspace",
  "integration",
  "global",
];

/**
 * Accepted broker handle forms are intentionally narrow. This blocks pasted
 * API keys, file paths, URLs, and bearer values while allowing existing native
 * prefixes such as `vault:`, `blob_key_`, and `opaque://`.
 */
const OPAQUE_REFERENCE_PATTERN = /^(?:opaque:\/\/|vault:|secret:|credential:|keyring:|blob_key_)[A-Za-z0-9][A-Za-z0-9._~:/-]{0,510}$/i;
const SECRET_LIKE_KEY = /(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization|cookie|session)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function assertSafeMetadata(value: unknown, path = "metadata"): asserts value is JsonObject {
  assertDomain(isRecord(value), "invalid_argument", `${path} must be a JSON object.`);
  for (const [key, entry] of Object.entries(value)) {
    assertDomain(!SECRET_LIKE_KEY.test(key), "invalid_argument", "Secret-like metadata keys are not allowed.", { path });
    assertDomain(isJsonValue(entry), "invalid_argument", `${path}.${key} must be JSON-compatible.`, { path });
    if (isRecord(entry)) assertSafeMetadata(entry, `${path}.${key}`);
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => {
        if (isRecord(child)) assertSafeMetadata(child, `${path}.${key}[${index}]`);
      });
    }
  }
}

function freezeMetadata(metadata: JsonObject): JsonObject {
  const freeze = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return Object.freeze(value.map(freeze));
    if (value !== null && typeof value === "object") {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
    }
    return value;
  };
  return freeze(metadata) as JsonObject;
}

function assertStatus(value: unknown): asserts value is SecretReferenceStatus {
  assertDomain(isOneOf(SECRET_REFERENCE_STATUSES, value), "invalid_argument", "Unknown secret reference status.");
}

function assertKind(value: unknown): asserts value is SecretReferenceKind {
  assertDomain(isOneOf(SECRET_REFERENCE_KINDS, value), "invalid_argument", "Unknown secret reference kind.");
}

function assertScope(scope: SecretReferenceScope | undefined): void {
  if (scope === undefined) return;
  assertDomain(isOneOf(SECRET_REFERENCE_SCOPE_KINDS, scope.kind), "invalid_argument", "Unknown secret reference scope.");
  if (scope.kind === "global") {
    assertDomain(scope.id === undefined, "invalid_argument", "Global secret scope cannot include an ID.");
  } else if (scope.id !== undefined) {
    assertNonBlank(scope.id, "secret reference scope ID", 320);
  }
}

function assertOptionalTimestamp(value: string | undefined, label: string): void {
  if (value !== undefined) assertIsoTimestamp(value, label);
}

/** Validates a broker handle without ever exposing or resolving secret bytes. */
export function assertSecretReference(value: string, label = "secret reference"): SecretReferenceValue {
  const normalized = assertNonBlank(value, label, 512);
  assertDomain(
    OPAQUE_REFERENCE_PATTERN.test(normalized) && !/[\s?#=%]/.test(normalized),
    "invalid_argument",
    `${label} must be an opaque native secret handle, not a raw credential, URL, or file path.`,
    { label },
  );
  return normalized as SecretReferenceValue;
}

export function isSecretReference(value: unknown): value is SecretReferenceValue {
  if (typeof value !== "string") return false;
  try {
    assertSecretReference(value);
    return true;
  } catch {
    return false;
  }
}

export function createSecretReference(input: CreateSecretReferenceInput): SecretReference {
  const reference = assertSecretReference(input.reference);
  assertKind(input.kind);
  const status = input.status ?? "unknown";
  assertStatus(status);
  assertIsoTimestamp(input.createdAt, "secret reference creation time");
  const updatedAt = input.updatedAt ?? input.createdAt;
  assertIsoTimestamp(updatedAt, "secret reference update time");
  assertOptionalTimestamp(input.lastCheckedAt, "secret reference check time");
  assertOptionalTimestamp(input.lastUsedAt, "secret reference use time");
  assertOptionalTimestamp(input.expiresAt, "secret reference expiry time");
  assertScope(input.scope);
  const metadata = input.metadata ?? {};
  assertSafeMetadata(metadata);
  const displayName = assertNonBlank(input.displayName, "secret reference display name", 160);
  return Object.freeze({
    schemaVersion: 1,
    reference,
    kind: input.kind,
    displayName,
    status,
    ...(input.scope === undefined ? {} : { scope: Object.freeze({ ...input.scope }) }),
    createdAt: input.createdAt,
    updatedAt,
    ...(input.lastCheckedAt === undefined ? {} : { lastCheckedAt: input.lastCheckedAt }),
    ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    metadata: freezeMetadata(metadata),
  });
}

export function isSecretReferenceUsable(reference: SecretReference, now: IsoTimestamp): boolean {
  assertIsoTimestamp(now, "secret reference evaluation time");
  if (reference.status !== "present") return false;
  return reference.expiresAt === undefined || Date.parse(reference.expiresAt) > Date.parse(now);
}

export function updateSecretReferenceStatus(
  reference: SecretReference,
  status: SecretReferenceStatus,
  updatedAt: IsoTimestamp,
): SecretReference {
  assertStatus(status);
  assertIsoTimestamp(updatedAt, "secret reference status time");
  assertDomain(
    reference.status !== "revoked" || status === "revoked",
    "invalid_state_transition",
    "A revoked secret reference cannot be reactivated.",
  );
  return Object.freeze({ ...reference, status, updatedAt, lastCheckedAt: updatedAt });
}

export function revokeSecretReference(reference: SecretReference, revokedAt: IsoTimestamp): SecretReference {
  return updateSecretReferenceStatus(reference, "revoked", revokedAt);
}

export function markSecretReferenceUsed(reference: SecretReference, usedAt: IsoTimestamp): SecretReference {
  assertIsoTimestamp(usedAt, "secret reference use time");
  assertDomain(reference.status === "present", "permission_denied", "Only a present secret reference can be used.");
  assertDomain(
    reference.expiresAt === undefined || Date.parse(reference.expiresAt) > Date.parse(usedAt),
    "permission_denied",
    "An expired secret reference cannot be used.",
  );
  return Object.freeze({ ...reference, lastUsedAt: usedAt, updatedAt: usedAt });
}

export function createSecretReferenceStore(
  references: readonly SecretReference[] = [],
  updatedAt: IsoTimestamp = new Date().toISOString(),
): SecretReferenceStore {
  assertIsoTimestamp(updatedAt, "secret reference store update time");
  const unique = new Map<string, SecretReference>();
  references.forEach((reference) => unique.set(reference.reference, reference));
  return Object.freeze({ version: 1, revision: 1, updatedAt, references: Object.freeze([...unique.values()]) });
}

export function upsertSecretReference(
  store: SecretReferenceStore,
  reference: SecretReference,
  updatedAt: IsoTimestamp = new Date().toISOString(),
): SecretReferenceStore {
  assertIsoTimestamp(updatedAt, "secret reference store update time");
  const references = store.references.filter((candidate) => candidate.reference !== reference.reference);
  return Object.freeze({
    ...store,
    revision: store.revision + 1,
    updatedAt,
    references: Object.freeze([...references, reference]),
  });
}

export function findSecretReference(
  store: SecretReferenceStore,
  reference: string,
): SecretReference | undefined {
  const normalized = assertSecretReference(reference);
  return store.references.find((candidate) => candidate.reference === normalized);
}

export function removeSecretReference(
  store: SecretReferenceStore,
  reference: string,
  updatedAt: IsoTimestamp = new Date().toISOString(),
): SecretReferenceStore {
  assertIsoTimestamp(updatedAt, "secret reference store update time");
  const normalized = assertSecretReference(reference);
  const references = store.references.filter((candidate) => candidate.reference !== normalized);
  if (references.length === store.references.length) return store;
  return Object.freeze({
    ...store,
    revision: store.revision + 1,
    updatedAt,
    references: Object.freeze(references),
  });
}

export function toPortableSecretReference(reference: SecretReference): PortableSecretReference {
  return Object.freeze({
    schemaVersion: 1,
    reference: "opaque://redacted-ref",
    kind: reference.kind,
    displayName: reference.displayName,
    status: reference.status,
    ...(reference.scope === undefined ? {} : { scope: reference.scope }),
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
    ...(reference.lastCheckedAt === undefined ? {} : { lastCheckedAt: reference.lastCheckedAt }),
    ...(reference.lastUsedAt === undefined ? {} : { lastUsedAt: reference.lastUsedAt }),
    ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt }),
    metadata: reference.metadata,
  });
}

export function toPortableSecretReferenceStore(store: SecretReferenceStore): PortableSecretReferenceStore {
  return Object.freeze({
    version: 1,
    revision: store.revision,
    updatedAt: store.updatedAt,
    references: Object.freeze(store.references.map(toPortableSecretReference)),
  });
}

export function serializeSecretReferenceStore(store: SecretReferenceStore): string {
  return JSON.stringify(store, null, 2);
}

export function serializePortableSecretReferenceStore(store: SecretReferenceStore): string {
  return JSON.stringify(toPortableSecretReferenceStore(store), null, 2);
}

function parseScope(value: unknown): SecretReferenceScope | undefined {
  if (value === undefined) return undefined;
  assertDomain(isRecord(value), "invalid_argument", "Invalid secret reference scope.");
  assertDomain(isOneOf(SECRET_REFERENCE_SCOPE_KINDS, value.kind), "invalid_argument", "Invalid secret reference scope kind.");
  if (value.kind === "global") {
    assertDomain(value.id === undefined, "invalid_argument", "Global secret scope cannot include an ID.");
    return { kind: "global" };
  }
  assertDomain(isString(value.id), "invalid_argument", "Scoped secret references require a scope ID.");
  return { kind: value.kind, id: assertNonBlank(value.id, "secret reference scope ID", 320) };
}

function parseSecretReference(value: unknown): SecretReference {
  assertDomain(isRecord(value), "invalid_argument", "Invalid secret reference.");
  assertDomain(value.schemaVersion === 1, "invalid_argument", "Unsupported secret reference version.");
  assertDomain(isString(value.reference), "invalid_argument", "Secret reference handle is missing.");
  assertKind(value.kind);
  assertDomain(isString(value.displayName), "invalid_argument", "Secret reference display name is missing.");
  assertStatus(value.status);
  assertDomain(isString(value.createdAt) && isString(value.updatedAt), "invalid_argument", "Secret reference timestamps are missing.");
  const scope = parseScope(value.scope);
  const metadata = value.metadata;
  assertSafeMetadata(metadata);
  return createSecretReference({
    reference: value.reference,
    kind: value.kind,
    displayName: value.displayName,
    status: value.status,
    ...(scope === undefined ? {} : { scope }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(isString(value.lastCheckedAt) ? { lastCheckedAt: value.lastCheckedAt } : {}),
    ...(isString(value.lastUsedAt) ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(isString(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
    metadata,
  });
}

export function deserializeSecretReferenceStore(input: string | unknown): SecretReferenceStore {
  const value: unknown = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  assertDomain(isRecord(value), "invalid_argument", "Invalid secret reference store.");
  assertDomain(value.version === 1, "invalid_argument", "Unsupported secret reference store version.");
  assertDomain(typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 1, "invalid_argument", "Invalid secret reference store revision.");
  assertDomain(isString(value.updatedAt) && Array.isArray(value.references), "invalid_argument", "Invalid secret reference store payload.");
  return Object.freeze({
    version: 1,
    revision: value.revision,
    updatedAt: value.updatedAt,
    references: Object.freeze(value.references.map(parseSecretReference)),
  });
}
