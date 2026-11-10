import { assertDomain } from "./errors";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  freezeJson,
  type IsoTimestamp,
  type JsonObject,
  type JsonValue,
} from "./shared";

/**
 * Portable, JSON-only data transfer contracts for Omnia.
 *
 * This module deliberately does not know how a native store, filesystem, or
 * cloud sync service works.  It gives those adapters one validated envelope
 * that can be exported/imported without leaking provider credentials or
 * relying on renderer state.
 */

export type OmniaTransferItemKind =
  | "chat-session"
  | "project"
  | "memory"
  | "provider"
  | "permission-policy"
  | "editor-document"
  | "media-job"
  | "agent-state"
  | "event-log"
  | "integration"
  | "custom";

export type OmniaTransferConflictPolicy =
  | "prefer-newer"
  | "prefer-existing"
  | "reject";

export interface OmniaTransferItem<T extends JsonValue = JsonValue> {
  readonly kind: OmniaTransferItemKind;
  readonly id: string;
  /** Monotonic caller-owned revision for deterministic merge decisions. */
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly value: T;
}

export interface OmniaTransferManifest {
  readonly format: "omnia.transfer";
  readonly schemaVersion: 1;
  readonly itemCount: number;
  readonly kinds: readonly OmniaTransferItemKind[];
  /** A deterministic non-cryptographic fingerprint of the item payload. */
  readonly fingerprint: string;
}

export interface OmniaTransferBundle {
  readonly format: "omnia.transfer";
  readonly schemaVersion: 1;
  readonly bundleId: string;
  readonly createdAt: IsoTimestamp;
  readonly source?: string;
  readonly metadata: JsonObject;
  readonly items: readonly OmniaTransferItem[];
  readonly manifest: OmniaTransferManifest;
}

export interface CreateOmniaTransferBundleInput {
  readonly bundleId?: string;
  readonly createdAt?: IsoTimestamp;
  readonly source?: string;
  readonly metadata?: JsonObject;
  readonly items?: readonly OmniaTransferItem[];
}

export interface CreateOmniaTransferItemInput<T extends JsonValue = JsonValue> {
  readonly kind: OmniaTransferItemKind;
  readonly id: string;
  readonly revision?: number;
  readonly updatedAt: IsoTimestamp;
  readonly value: T;
}

export interface OmniaTransferMergeReport {
  readonly bundle: OmniaTransferBundle;
  readonly added: readonly string[];
  readonly replaced: readonly string[];
  readonly kept: readonly string[];
  readonly conflicts: readonly string[];
}

export interface OmniaTransferSelection {
  readonly kinds?: readonly OmniaTransferItemKind[];
  readonly ids?: readonly string[];
}

const ITEM_KINDS: readonly OmniaTransferItemKind[] = [
  "chat-session",
  "project",
  "memory",
  "provider",
  "permission-policy",
  "editor-document",
  "media-job",
  "agent-state",
  "event-log",
  "integration",
  "custom",
];
const ITEM_KIND_SET: ReadonlySet<OmniaTransferItemKind> = new Set(ITEM_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) {
    // JSON objects are plain records.  Treating Date/Map/Set/class instances
    // as records would silently change their value when crossing the JSON
    // boundary (for example, Date becomes a string and Map becomes {}).
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Object.values(value).every(isJsonValue);
  }
  return false;
}

function normalizeId(value: string, label: string): string {
  return assertNonBlank(value, label, 512);
}

function itemKey(item: Pick<OmniaTransferItem, "kind" | "id">): string {
  return `${item.kind}:${item.id}`;
}

function createBundleId(timestamp: string): string {
  return `transfer_${timestamp.replace(/[^0-9]/g, "").slice(-17)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** Stable JSON is useful for reproducible exports and merge fingerprints. */
function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  // Use code-unit ordering rather than localeCompare so fingerprints do not
  // vary with the host's locale.
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

/**
 * FNV-1a 64 is intentionally named a fingerprint, not a security hash.  It
 * is synchronous and available in both the browser and Tauri renderer.  A
 * native adapter may add a cryptographic digest alongside this field.
 */
function fingerprint(value: JsonValue): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(stableJson(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

function itemFingerprintInput(items: readonly OmniaTransferItem[]): JsonValue {
  return items.map((item) => ({
    kind: item.kind,
    id: item.id,
    revision: item.revision,
    updatedAt: item.updatedAt,
    value: item.value,
  }));
}

function normalizeItem<T extends JsonValue>(input: CreateOmniaTransferItemInput<T>): OmniaTransferItem<T> {
  assertDomain(isRecord(input), "invalid_argument", "Transfer item must be an object.");
  assertDomain(ITEM_KIND_SET.has(input.kind), "invalid_argument", "Unsupported transfer item kind.", {
    kind: input.kind,
  });
  const id = normalizeId(input.id, "transfer item ID");
  const revision = input.revision ?? 1;
  assertIntegerInRange(revision, "transfer item revision", 1, Number.MAX_SAFE_INTEGER);
  assertIsoTimestamp(input.updatedAt, "transfer item update time");
  assertDomain(isJsonValue(input.value), "invalid_argument", "Transfer item value must be JSON-compatible.", {
    kind: input.kind,
    id,
  });
  return Object.freeze({
    kind: input.kind,
    id,
    revision,
    updatedAt: input.updatedAt,
    value: freezeJson(input.value),
  });
}

function buildManifest(items: readonly OmniaTransferItem[]): OmniaTransferManifest {
  const kinds = ITEM_KINDS.filter((kind) => items.some((item) => item.kind === kind));
  return Object.freeze({
    format: "omnia.transfer",
    schemaVersion: 1,
    itemCount: items.length,
    kinds: Object.freeze(kinds),
    fingerprint: fingerprint(itemFingerprintInput(items)),
  });
}

function buildBundle(input: {
  readonly bundleId: string;
  readonly createdAt: IsoTimestamp;
  readonly source?: string;
  readonly metadata: JsonObject;
  readonly items: readonly OmniaTransferItem[];
}): OmniaTransferBundle {
  assertDomain(isJsonValue(input.metadata) && isRecord(input.metadata), "invalid_argument", "Transfer metadata must be a JSON object.");
  const seen = new Set<string>();
  for (const item of input.items) {
    const key = itemKey(item);
    assertDomain(!seen.has(key), "conflict", "Transfer bundle contains a duplicate item.", { key });
    seen.add(key);
  }
  const items = Object.freeze([...input.items]);
  return Object.freeze({
    format: "omnia.transfer",
    schemaVersion: 1,
    bundleId: normalizeId(input.bundleId, "transfer bundle ID"),
    createdAt: input.createdAt,
    ...(input.source === undefined ? {} : { source: assertNonBlank(input.source, "transfer source", 512) }),
    metadata: freezeJson(input.metadata),
    items,
    manifest: buildManifest(items),
  });
}

export function createOmniaTransferItem<T extends JsonValue>(
  input: CreateOmniaTransferItemInput<T>,
): OmniaTransferItem<T> {
  return normalizeItem(input);
}

export function createOmniaTransferBundle(
  input: CreateOmniaTransferBundleInput = {},
): OmniaTransferBundle {
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertIsoTimestamp(createdAt, "transfer creation time");
  const bundleId = input.bundleId?.trim() || createBundleId(createdAt);
  const metadata = input.metadata ?? {};
  assertDomain(isJsonValue(metadata), "invalid_argument", "Transfer metadata must be JSON-compatible.");
  const items = (input.items ?? []).map((item) => normalizeItem(item));
  return buildBundle({
    bundleId,
    createdAt,
    ...(input.source === undefined ? {} : { source: input.source }),
    metadata,
    items,
  });
}

export function validateOmniaTransferBundle(bundle: OmniaTransferBundle): void {
  assertDomain(isRecord(bundle), "invalid_argument", "Transfer bundle must be an object.");
  assertDomain(bundle.format === "omnia.transfer", "invalid_argument", "Unsupported transfer format.");
  assertDomain(bundle.schemaVersion === 1, "invalid_argument", "Unsupported transfer schema version.");
  assertDomain(typeof bundle.bundleId === "string", "invalid_argument", "Transfer bundle ID is required.");
  assertIsoTimestamp(bundle.createdAt, "transfer creation time");
  normalizeId(bundle.bundleId, "transfer bundle ID");
  if (bundle.source !== undefined) {
    assertDomain(typeof bundle.source === "string", "invalid_argument", "Transfer source must be a string.");
    assertNonBlank(bundle.source, "transfer source", 512);
  }
  assertDomain(isJsonValue(bundle.metadata) && isRecord(bundle.metadata), "invalid_argument", "Transfer metadata must be a JSON object.");
  assertDomain(isRecord(bundle.manifest), "invalid_argument", "Transfer manifest is required.");
  assertDomain(bundle.manifest.format === "omnia.transfer", "invalid_argument", "Transfer manifest format is invalid.");
  assertDomain(bundle.manifest.schemaVersion === 1, "invalid_argument", "Transfer manifest schema version is invalid.");
  assertDomain(Array.isArray(bundle.items), "invalid_argument", "Transfer items must be an array.");
  const normalizedItems = bundle.items.map((item) => normalizeItem(item));
  const expected = buildManifest(normalizedItems);
  assertDomain(bundle.manifest.itemCount === expected.itemCount, "conflict", "Transfer manifest item count is stale.");
  assertDomain(
    bundle.manifest.fingerprint === expected.fingerprint,
    "conflict",
    "Transfer manifest fingerprint does not match its items.",
  );
  assertDomain(
    JSON.stringify(bundle.manifest.kinds) === JSON.stringify(expected.kinds),
    "conflict",
    "Transfer manifest kind index does not match its items.",
  );
}

export function addOmniaTransferItem<T extends JsonValue>(
  bundle: OmniaTransferBundle,
  input: CreateOmniaTransferItemInput<T>,
): OmniaTransferBundle {
  validateOmniaTransferBundle(bundle);
  const item = normalizeItem(input);
  assertDomain(
    !bundle.items.some((candidate) => itemKey(candidate) === itemKey(item)),
    "conflict",
    "Transfer item already exists in this bundle.",
    { key: itemKey(item) },
  );
  return buildBundle({
    bundleId: bundle.bundleId,
    createdAt: bundle.createdAt,
    ...(bundle.source === undefined ? {} : { source: bundle.source }),
    metadata: bundle.metadata,
    items: [...bundle.items, item],
  });
}

export function removeOmniaTransferItem(
  bundle: OmniaTransferBundle,
  kind: OmniaTransferItemKind,
  id: string,
): OmniaTransferBundle {
  validateOmniaTransferBundle(bundle);
  assertDomain(ITEM_KIND_SET.has(kind), "invalid_argument", "Unsupported transfer item kind.", { kind });
  const normalizedId = normalizeId(id, "transfer item ID");
  return buildBundle({
    bundleId: bundle.bundleId,
    createdAt: bundle.createdAt,
    ...(bundle.source === undefined ? {} : { source: bundle.source }),
    metadata: bundle.metadata,
    items: bundle.items.filter((item) => item.kind !== kind || item.id !== normalizedId),
  });
}

export function selectOmniaTransferItems(
  bundle: OmniaTransferBundle,
  selection: OmniaTransferSelection = {},
): readonly OmniaTransferItem[] {
  validateOmniaTransferBundle(bundle);
  const kinds = selection.kinds === undefined ? undefined : new Set(selection.kinds);
  const ids = selection.ids === undefined ? undefined : new Set(selection.ids);
  return Object.freeze(
    bundle.items.filter(
      (item) => (kinds === undefined || kinds.has(item.kind)) && (ids === undefined || ids.has(item.id)),
    ),
  );
}

function chooseIncoming(
  current: OmniaTransferItem,
  incoming: OmniaTransferItem,
  policy: OmniaTransferConflictPolicy,
): "incoming" | "current" | "reject" {
  if (policy === "prefer-existing") return "current";
  if (policy === "reject") return "reject";
  if (incoming.revision !== current.revision) return incoming.revision > current.revision ? "incoming" : "current";
  return Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt) ? "incoming" : "current";
}

export function mergeOmniaTransferBundles(
  current: OmniaTransferBundle,
  incoming: OmniaTransferBundle,
  policy: OmniaTransferConflictPolicy = "prefer-newer",
): OmniaTransferMergeReport {
  validateOmniaTransferBundle(current);
  validateOmniaTransferBundle(incoming);
  const byKey = new Map(current.items.map((item) => [itemKey(item), item]));
  const added: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  const conflicts: string[] = [];
  for (const item of incoming.items) {
    const key = itemKey(item);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, item);
      added.push(key);
      continue;
    }
    const choice = chooseIncoming(existing, item, policy);
    if (choice === "incoming") {
      byKey.set(key, item);
      replaced.push(key);
    } else if (choice === "current") {
      kept.push(key);
    } else {
      conflicts.push(key);
    }
  }
  assertDomain(conflicts.length === 0, "conflict", "Transfer merge encountered conflicting items.", {
    conflicts,
  });
  const items = [...byKey.values()].sort((left, right) => itemKey(left).localeCompare(itemKey(right)));
  const bundle = buildBundle({
    bundleId: current.bundleId,
    createdAt: current.createdAt,
    ...(current.source === undefined ? {} : { source: current.source }),
    metadata: current.metadata,
    items,
  });
  return Object.freeze({
    bundle,
    added: Object.freeze(added),
    replaced: Object.freeze(replaced),
    kept: Object.freeze(kept),
    conflicts: Object.freeze(conflicts),
  });
}

export function serializeOmniaTransferBundle(bundle: OmniaTransferBundle): string {
  validateOmniaTransferBundle(bundle);
  return JSON.stringify(bundle, null, 2);
}

function parseTransferItem(value: unknown): OmniaTransferItem {
  assertDomain(isRecord(value), "invalid_argument", "Transfer item must be an object.");
  assertDomain(typeof value.kind === "string", "invalid_argument", "Transfer item kind is required.");
  assertDomain(typeof value.id === "string", "invalid_argument", "Transfer item ID is required.");
  assertDomain(typeof value.revision === "number", "invalid_argument", "Transfer item revision is required.");
  assertDomain(typeof value.updatedAt === "string", "invalid_argument", "Transfer item timestamp is required.");
  return normalizeItem({
    kind: value.kind as OmniaTransferItemKind,
    id: value.id,
    revision: value.revision,
    updatedAt: value.updatedAt,
    value: value.value as JsonValue,
  });
}

export function deserializeOmniaTransferBundle(input: string | unknown): OmniaTransferBundle {
  let value: unknown;
  try {
    value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  } catch {
    throw new Error("Invalid Omnia transfer JSON.");
  }
  assertDomain(isRecord(value), "invalid_argument", "Transfer bundle must be an object.");
  assertDomain(value.format === "omnia.transfer", "invalid_argument", "Unsupported transfer format.");
  assertDomain(value.schemaVersion === 1, "invalid_argument", "Unsupported transfer schema version.");
  assertDomain(typeof value.bundleId === "string", "invalid_argument", "Transfer bundle ID is required.");
  assertDomain(typeof value.createdAt === "string", "invalid_argument", "Transfer creation time is required.");
  assertDomain(value.source === undefined || typeof value.source === "string", "invalid_argument", "Transfer source must be a string.");
  assertDomain(isRecord(value.metadata), "invalid_argument", "Transfer metadata must be an object.");
  assertDomain(Array.isArray(value.items), "invalid_argument", "Transfer items must be an array.");
  assertDomain(isRecord(value.manifest), "invalid_argument", "Transfer manifest is required.");
  assertDomain(value.manifest.format === "omnia.transfer", "invalid_argument", "Transfer manifest format is invalid.");
  assertDomain(value.manifest.schemaVersion === 1, "invalid_argument", "Transfer manifest schema version is invalid.");
  const items = value.items.map(parseTransferItem);
  assertDomain(typeof value.manifest.itemCount === "number", "invalid_argument", "Transfer item count is required.");
  assertDomain(Array.isArray(value.manifest.kinds), "invalid_argument", "Transfer kind index is required.");
  assertDomain(typeof value.manifest.fingerprint === "string", "invalid_argument", "Transfer fingerprint is required.");
  const bundle = buildBundle({
    bundleId: value.bundleId,
    createdAt: value.createdAt,
    ...(value.source === undefined ? {} : { source: value.source }),
    metadata: value.metadata as JsonObject,
    items,
  });
  assertDomain(bundle.manifest.itemCount === value.manifest.itemCount, "conflict", "Transfer item count is stale.");
  assertDomain(bundle.manifest.fingerprint === value.manifest.fingerprint, "conflict", "Transfer fingerprint is invalid.");
  validateOmniaTransferBundle(bundle);
  return bundle;
}
