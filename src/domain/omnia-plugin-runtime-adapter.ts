import { assertDomain } from "./errors";
import {
  deserializeOmniaPluginRegistry,
  resolveOmniaPlugin,
  type OmniaPluginDependency,
  type OmniaPluginKind,
  type OmniaPluginRegistration,
  type OmniaPluginRegistry,
  type OmniaPluginRegistryQuery,
  type OmniaPluginSource,
  type OmniaPluginStatus,
  type OmniaPluginTrust,
} from "./omnia-plugin-registry";

// Keep the query contract available from the runtime-adapter module for
// callers that historically imported it from this layer.
export type { OmniaPluginRegistryQuery } from "./omnia-plugin-registry";

/** Version of the renderer/native-safe plugin runtime projection. */
export const OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION = 1 as const;

export type OmniaPluginDependencyState =
  | "satisfied"
  | "missing"
  | "optional-missing"
  | "not-installed"
  | "not-enabled"
  | "blocked"
  | "untrusted";

export interface OmniaPluginDependencyCheck {
  readonly dependency: OmniaPluginDependency;
  readonly state: OmniaPluginDependencyState;
  readonly registrationId?: string;
  readonly version?: string;
}

export type OmniaPluginReadinessReason =
  | "already-enabled"
  | "install-required"
  | "trust-review-required"
  | "trust-revoked"
  | "blocked"
  | "missing-dependency"
  | "optional-dependency-missing"
  | "dependency-not-installed"
  | "dependency-not-enabled"
  | "dependency-blocked"
  | "dependency-untrusted"
  | "dependency-cycle";

export interface OmniaPluginActivationReadiness {
  readonly pluginId: string;
  readonly status: OmniaPluginStatus;
  readonly trust: OmniaPluginTrust;
  readonly canEnable: boolean;
  readonly canResolve: boolean;
  readonly reasons: readonly OmniaPluginReadinessReason[];
  readonly dependencies: readonly OmniaPluginDependencyCheck[];
}

export interface OmniaPluginRegistrySummary {
  readonly total: number;
  readonly available: number;
  readonly installed: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly blocked: number;
  readonly trusted: number;
  readonly reviewed: number;
  readonly unreviewed: number;
  readonly revoked: number;
  readonly dependencyCount: number;
  readonly contributionCount: number;
  readonly requestedCapabilityCount: number;
}

export interface OmniaPluginRuntimeCard {
  readonly id: string;
  readonly displayName: string;
  readonly name: string;
  readonly version: string;
  readonly kind: OmniaPluginKind;
  readonly source: OmniaPluginSource;
  readonly status: OmniaPluginStatus;
  readonly trust: OmniaPluginTrust;
  readonly selected: boolean;
  readonly tags: readonly string[];
  readonly contributionCount: number;
  readonly requestedCapabilityCount: number;
  readonly readiness: OmniaPluginActivationReadiness;
}

export interface OmniaPluginRuntimeSnapshot {
  readonly version: typeof OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly selectedPluginId: string | null;
  readonly summary: OmniaPluginRegistrySummary;
  readonly plugins: readonly OmniaPluginRuntimeCard[];
}

function assertTimestamp(value: string, label: string): string {
  assertDomain(typeof value === "string" && Number.isFinite(Date.parse(value)), "invalid_argument", `${label} must be a valid timestamp.`);
  return value;
}

function normalizeSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeTag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

function assertLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  assertDomain(Number.isSafeInteger(value) && value > 0, "invalid_argument", "Plugin query limit must be a positive safe integer.");
  return value;
}

function registrationFor(registry: OmniaPluginRegistry, pluginId: string): OmniaPluginRegistration {
  const registration = registry.plugins.find((candidate) => candidate.manifest.id === pluginId);
  assertDomain(registration !== undefined, "not_found", "Plugin was not found.", { pluginId });
  return registration;
}

function dependencyCycle(registry: OmniaPluginRegistry, rootId: string): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pluginId: string): boolean => {
    if (visiting.has(pluginId)) return true;
    if (visited.has(pluginId)) return false;
    const registration = registry.plugins.find((candidate) => candidate.manifest.id === pluginId);
    if (registration === undefined) return false;
    visiting.add(pluginId);
    for (const dependency of registration.manifest.dependencies) {
      if (visit(dependency.id)) return true;
    }
    visiting.delete(pluginId);
    visited.add(pluginId);
    return false;
  };
  return visit(rootId);
}

function checkDependency(registry: OmniaPluginRegistry, dependency: OmniaPluginDependency): OmniaPluginDependencyCheck {
  const registration = registry.plugins.find((candidate) => candidate.manifest.id === dependency.id);
  if (registration === undefined) {
    return Object.freeze({
      dependency,
      state: dependency.optional === true ? "optional-missing" : "missing",
    });
  }
  if (registration.status === "blocked") {
    return Object.freeze({ dependency, state: "blocked", registrationId: registration.manifest.id, version: registration.manifest.version });
  }
  if (registration.trust === "unverified") {
    return Object.freeze({ dependency, state: "untrusted", registrationId: registration.manifest.id, version: registration.manifest.version });
  }
  if (registration.trust === "revoked") {
    return Object.freeze({ dependency, state: "untrusted", registrationId: registration.manifest.id, version: registration.manifest.version });
  }
  if (registration.status === "available") {
    return Object.freeze({ dependency, state: "not-installed", registrationId: registration.manifest.id, version: registration.manifest.version });
  }
  if (registration.status !== "enabled") {
    return Object.freeze({ dependency, state: "not-enabled", registrationId: registration.manifest.id, version: registration.manifest.version });
  }
  return Object.freeze({ dependency, state: "satisfied", registrationId: registration.manifest.id, version: registration.manifest.version });
}

/**
 * Computes plugin dependency and trust readiness without granting any native
 * authority.  A native broker must still evaluate capabilities before launch.
 */
export function inspectOmniaPluginActivation(
  registry: OmniaPluginRegistry,
  pluginId: string,
): OmniaPluginActivationReadiness {
  const registration = registrationFor(registry, pluginId);
  const dependencies = Object.freeze(registration.manifest.dependencies.map((dependency) => checkDependency(registry, dependency)));
  const reasons: OmniaPluginReadinessReason[] = [];
  if (registration.status === "enabled") reasons.push("already-enabled");
  if (registration.status === "available") reasons.push("install-required");
  if (registration.status === "blocked") reasons.push("blocked");
  if (registration.trust === "unverified") reasons.push("trust-review-required");
  if (registration.trust === "revoked") reasons.push("trust-revoked");
  for (const dependency of dependencies) {
    if (dependency.state === "missing") reasons.push("missing-dependency");
    if (dependency.state === "optional-missing") reasons.push("optional-dependency-missing");
    if (dependency.state === "not-installed") reasons.push("dependency-not-installed");
    if (dependency.state === "not-enabled") reasons.push("dependency-not-enabled");
    if (dependency.state === "blocked") reasons.push("dependency-blocked");
    if (dependency.state === "untrusted") reasons.push("dependency-untrusted");
  }
  if (dependencyCycle(registry, pluginId)) reasons.push("dependency-cycle");
  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  const dependencyReady = dependencies.every((dependency) => dependency.state === "satisfied" || dependency.state === "optional-missing");
  const ownTrustReady = registration.trust === "reviewed" || registration.trust === "verified";
  const ownInstallReady = registration.status === "installed" || registration.status === "disabled" || registration.status === "enabled";
  const canResolve = registration.status === "enabled" && ownTrustReady && dependencyReady && !uniqueReasons.includes("dependency-cycle");
  // An already-enabled plugin has no enable transition left to perform.  Keep
  // `canResolve` true for the active runtime path, but expose `canEnable=false`
  // so renderer controls do not offer a no-op action.
  const canEnable = registration.status !== "enabled"
    && ownInstallReady
    && ownTrustReady
    && dependencyReady
    && !uniqueReasons.includes("dependency-cycle");
  return Object.freeze({
    pluginId: registration.manifest.id,
    status: registration.status,
    trust: registration.trust,
    canEnable,
    canResolve,
    reasons: uniqueReasons,
    dependencies,
  });
}

/** Returns catalog records matching the optional renderer query. */
export function queryOmniaPluginRegistry(
  registry: OmniaPluginRegistry,
  query: OmniaPluginRegistryQuery = {},
): readonly OmniaPluginRegistration[] {
  const search = normalizeSearch(query.search);
  const tag = normalizeTag(query.tag);
  const limit = assertLimit(query.limit);
  const filtered = registry.plugins.filter((registration) => {
    const manifest = registration.manifest;
    // An explicit status=blocked query is an intentional opt-in.  The default
    // catalog view still hides blocked plugins unless callers set
    // `includeBlocked` (or ask for the blocked status directly).
    if (!query.includeBlocked && query.status !== "blocked" && registration.status === "blocked") return false;
    if (query.kind !== undefined && manifest.kind !== query.kind) return false;
    if (query.source !== undefined && manifest.source !== query.source) return false;
    if (query.status !== undefined && registration.status !== query.status) return false;
    if (query.trust !== undefined && registration.trust !== query.trust) return false;
    if (tag !== undefined && !manifest.tags.some((candidate) => candidate.toLocaleLowerCase() === tag)) return false;
    if (search !== undefined) {
      const haystack = [manifest.id, manifest.name, manifest.displayName, manifest.description, ...manifest.tags].join(" ").toLocaleLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((left, right) => {
    const display = left.manifest.displayName.localeCompare(right.manifest.displayName);
    return display || left.manifest.id.localeCompare(right.manifest.id);
  });
  return Object.freeze(limit === undefined ? sorted : sorted.slice(0, limit));
}

export function summarizeOmniaPluginRegistry(registry: OmniaPluginRegistry): OmniaPluginRegistrySummary {
  const count = (status: OmniaPluginStatus) => registry.plugins.filter((plugin) => plugin.status === status).length;
  const trustCount = (trust: OmniaPluginTrust) => registry.plugins.filter((plugin) => plugin.trust === trust).length;
  return Object.freeze({
    total: registry.plugins.length,
    available: count("available"),
    installed: count("installed"),
    enabled: count("enabled"),
    disabled: count("disabled"),
    blocked: count("blocked"),
    trusted: trustCount("verified"),
    reviewed: trustCount("reviewed"),
    unreviewed: trustCount("unverified"),
    revoked: trustCount("revoked"),
    dependencyCount: registry.plugins.reduce((total, plugin) => total + plugin.manifest.dependencies.length, 0),
    contributionCount: registry.plugins.reduce((total, plugin) => total + plugin.manifest.contributions.length, 0),
    requestedCapabilityCount: registry.plugins.reduce((total, plugin) => total + plugin.manifest.requestedCapabilities.length, 0),
  });
}

export function buildOmniaPluginRuntimeSnapshot(
  registry: OmniaPluginRegistry,
  now: string,
): OmniaPluginRuntimeSnapshot {
  assertTimestamp(now, "Plugin runtime snapshot time");
  const plugins = Object.freeze(registry.plugins.map((registration) => Object.freeze({
    id: registration.manifest.id,
    displayName: registration.manifest.displayName,
    name: registration.manifest.name,
    version: registration.manifest.version,
    kind: registration.manifest.kind,
    source: registration.manifest.source,
    status: registration.status,
    trust: registration.trust,
    selected: registry.selectedPluginId === registration.manifest.id,
    tags: Object.freeze([...registration.manifest.tags]),
    contributionCount: registration.manifest.contributions.length,
    requestedCapabilityCount: registration.manifest.requestedCapabilities.length,
    readiness: inspectOmniaPluginActivation(registry, registration.manifest.id),
  })));
  return Object.freeze({
    version: OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION,
    generatedAt: now,
    selectedPluginId: registry.selectedPluginId ?? null,
    summary: summarizeOmniaPluginRegistry(registry),
    plugins,
  });
}

/** Resolve a plugin only after checking dependency readiness as well. */
export function resolveOmniaPluginWithDependencies(
  registry: OmniaPluginRegistry,
  pluginId: string,
): OmniaPluginRegistration {
  const readiness = inspectOmniaPluginActivation(registry, pluginId);
  assertDomain(readiness.canResolve, "permission_denied", "Plugin dependencies or trust are not ready.", {
    pluginId,
    reasons: readiness.reasons,
  });
  return resolveOmniaPlugin(registry, pluginId);
}

export function serializeOmniaPluginRuntimeSnapshot(snapshot: OmniaPluginRuntimeSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function deserializeOmniaPluginRuntimeSnapshot(input: string | unknown): OmniaPluginRuntimeSnapshot {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(typeof value === "object" && value !== null && !Array.isArray(value), "invalid_argument", "Invalid plugin runtime snapshot.");
  const record = value as Record<string, unknown>;
  assertDomain(record.version === OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION, "invalid_argument", "Unsupported plugin runtime snapshot version.");
  assertTimestamp(String(record.generatedAt), "Plugin runtime snapshot time");
  assertDomain(record.selectedPluginId === null || typeof record.selectedPluginId === "string", "invalid_argument", "Invalid selected plugin ID.");
  assertDomain(record.summary !== null && typeof record.summary === "object" && !Array.isArray(record.summary), "invalid_argument", "Invalid plugin runtime summary.");
  assertDomain(Array.isArray(record.plugins), "invalid_argument", "Plugin runtime cards must be an array.");
  assertDomain(record.plugins.every((plugin) => plugin !== null && typeof plugin === "object" && !Array.isArray(plugin)), "invalid_argument", "Invalid plugin runtime card.");
  return Object.freeze({
    version: OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION,
    generatedAt: record.generatedAt as string,
    selectedPluginId: record.selectedPluginId as string | null,
    summary: record.summary as OmniaPluginRegistrySummary,
    plugins: Object.freeze(record.plugins as OmniaPluginRuntimeCard[]),
  });
}

export interface OmniaPluginRuntimeAdapter {
  readonly version: typeof OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION;
  readonly query: (registry: OmniaPluginRegistry, query?: OmniaPluginRegistryQuery) => readonly OmniaPluginRegistration[];
  readonly summarize: (registry: OmniaPluginRegistry) => OmniaPluginRegistrySummary;
  readonly inspect: (registry: OmniaPluginRegistry, pluginId: string) => OmniaPluginActivationReadiness;
  readonly buildSnapshot: (registry: OmniaPluginRegistry, now: string) => OmniaPluginRuntimeSnapshot;
  readonly resolve: (registry: OmniaPluginRegistry, pluginId: string) => OmniaPluginRegistration;
  readonly deserializeRegistry: (input: string | unknown) => OmniaPluginRegistry;
}

export function createOmniaPluginRuntimeAdapter(): OmniaPluginRuntimeAdapter {
  return Object.freeze({
    version: OMNIA_PLUGIN_RUNTIME_ADAPTER_SCHEMA_VERSION,
    query: queryOmniaPluginRegistry,
    summarize: summarizeOmniaPluginRegistry,
    inspect: inspectOmniaPluginActivation,
    buildSnapshot: buildOmniaPluginRuntimeSnapshot,
    resolve: resolveOmniaPluginWithDependencies,
    deserializeRegistry: deserializeOmniaPluginRegistry,
  });
}
