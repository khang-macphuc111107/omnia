import type { DiscoveryCatalog, DiscoveryModel } from "./model-discovery";

/**
 * Stable identity used when a renderer session chooses a provider model.
 * Provider credentials, endpoints and secret handles never enter this type.
 */
export interface CatalogRouteIdentity {
  providerProfileId: string;
  modelId: string;
}

export type CatalogRouteState = "available" | "stale" | "disappeared" | "unsupported";

export interface CatalogSnapshot {
  profileId: string;
  discoveredAt: string;
  models: DiscoveryModel[];
  snapshotId: string;
  snapshotHash: string;
  hashAlgorithm: "sha256" | "fnv1a32-fallback";
  snapshotAuthority: "native" | "renderer";
  previousSnapshotId?: string;
}

export interface CatalogRoute {
  identity: CatalogRouteIdentity;
  snapshotId: string;
  snapshotHash: string;
  snapshotAuthority: CatalogSnapshot["snapshotAuthority"];
  model: DiscoveryModel;
  state: CatalogRouteState;
  reason: string | null;
}

export interface RouteResolution {
  identity: CatalogRouteIdentity;
  route: CatalogRoute | null;
  dispatchable: boolean;
  state: CatalogRouteState | "unknown";
  reason: string;
}

const text = (value: unknown, label: string, limit = 512): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
};

const finiteDate = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid catalog discovery timestamp");
  return parsed;
};

function validateModel(model: DiscoveryModel): DiscoveryModel {
  const id = text(model.id, "model id");
  const displayName = text(model.displayName, "model display name");
  const source = text(model.capabilities.source, "capability source", 128);
  if (model.ownedBy !== null) text(model.ownedBy, "model owner");
  if (model.createdAt !== null && !Number.isFinite(model.createdAt)) throw new Error("Invalid model creation time");
  if (typeof model.capabilities.streaming !== "boolean") throw new Error("Invalid streaming capability");
  for (const key of ["tools", "vision", "reasoning"] as const) {
    const value = model.capabilities[key];
    if (value !== null && typeof value !== "boolean") throw new Error(`Invalid ${key} capability`);
  }
  return {
    id,
    displayName,
    ownedBy: model.ownedBy,
    createdAt: model.createdAt,
    capabilities: { ...model.capabilities, source },
  };
}

function canonicalCatalog(catalog: DiscoveryCatalog): string {
  const profileId = text(catalog.profileId, "provider profile id", 256);
  const discoveredAt = text(catalog.discoveredAt, "catalog discovery timestamp", 64);
  finiteDate(discoveredAt);
  if (!Array.isArray(catalog.models) || catalog.models.length > 2_000) throw new Error("Invalid catalog models");
  const seen = new Set<string>();
  const models = catalog.models.map(validateModel).sort((left, right) => left.id.localeCompare(right.id));
  for (const model of models) {
    if (seen.has(model.id)) throw new Error("Duplicate model id in catalog");
    seen.add(model.id);
  }
  return JSON.stringify({ profileId, discoveredAt, models });
}

function nativeSnapshotLineage(catalog: DiscoveryCatalog): { id: string; hash: string } | null {
  if (catalog.snapshotId == null && catalog.snapshotSha256 == null) return null;
  if (typeof catalog.snapshotId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(catalog.snapshotId)) throw new Error("Invalid native snapshot id");
  if (typeof catalog.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(catalog.snapshotSha256)) throw new Error("Invalid native snapshot hash");
  return { id: catalog.snapshotId, hash: catalog.snapshotSha256.toLowerCase() };
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function digestCanonical(value: string): Promise<{ hash: string; algorithm: CatalogSnapshot["hashAlgorithm"] }> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { hash, algorithm: "sha256" };
  }
  return { hash: fnv1a32(value), algorithm: "fnv1a32-fallback" };
}

/** Builds a deterministic, credential-free snapshot lineage record. */
export async function createCatalogSnapshot(catalog: DiscoveryCatalog, previousSnapshotId?: string): Promise<CatalogSnapshot> {
  const canonical = canonicalCatalog(catalog);
  const parsed = JSON.parse(canonical) as Pick<DiscoveryCatalog, "profileId" | "discoveredAt" | "models">;
  const digest = await digestCanonical(canonical);
  const native = nativeSnapshotLineage(catalog);
  return {
    profileId: parsed.profileId,
    discoveredAt: parsed.discoveredAt,
    models: parsed.models,
    snapshotId: native?.id ?? `catalog:${parsed.profileId}:${digest.hash.slice(0, 16)}`,
    snapshotHash: native?.hash ?? digest.hash,
    hashAlgorithm: digest.algorithm,
    snapshotAuthority: native ? "native" : "renderer",
    ...(previousSnapshotId ? { previousSnapshotId: text(previousSnapshotId, "previous snapshot id", 256) } : {}),
  };
}

function identityKey(identity: CatalogRouteIdentity): string {
  return `${text(identity.providerProfileId, "provider profile id", 256)}\u0000${text(identity.modelId, "model id")}`;
}

/**
 * Reconciles a fresh snapshot against the previous one. A model omitted by the
 * provider is retained as a non-dispatchable `disappeared` route so a session
 * can explain why a previously selected model is no longer usable.
 */
export function reconcileCatalogRoutes(current: CatalogSnapshot, previous?: CatalogSnapshot, nowMs = Date.now(), staleAfterMs = 15 * 60_000): CatalogRoute[] {
  const age = Math.max(0, nowMs - finiteDate(current.discoveredAt));
  const snapshotState: CatalogRouteState = age > staleAfterMs ? "stale" : "available";
  const routes = new Map<string, CatalogRoute>();
  for (const model of current.models) {
    const identity = { providerProfileId: current.profileId, modelId: model.id } satisfies CatalogRouteIdentity;
    routes.set(identityKey(identity), {
      identity,
      snapshotId: current.snapshotId,
      snapshotHash: current.snapshotHash,
      snapshotAuthority: current.snapshotAuthority,
      model,
      state: model.capabilities.streaming === false ? "unsupported" : snapshotState,
      reason: model.capabilities.streaming === false
        ? "The provider did not advertise streaming support for this model."
        : snapshotState === "stale" ? "Catalog snapshot is older than the freshness window." : null,
    });
  }
  if (previous && previous.profileId === current.profileId) {
    for (const model of previous.models) {
      const identity = { providerProfileId: previous.profileId, modelId: model.id } satisfies CatalogRouteIdentity;
      if (routes.has(identityKey(identity))) continue;
      routes.set(identityKey(identity), {
        identity,
        snapshotId: previous.snapshotId,
        snapshotHash: previous.snapshotHash,
        snapshotAuthority: previous.snapshotAuthority,
        model,
        state: "disappeared",
        reason: "The latest provider catalog no longer advertises this model.",
      });
    }
  }
  return [...routes.values()].sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
}

export function resolveCatalogRoute(routes: readonly CatalogRoute[], identity: CatalogRouteIdentity): RouteResolution {
  const route = routes.find((entry) => entry.identity.providerProfileId === identity.providerProfileId && entry.identity.modelId === identity.modelId) ?? null;
  if (!route) return { identity, route: null, dispatchable: false, state: "unknown", reason: "The provider/model identity is absent from the discovered catalog." };
  if (route.state !== "available") return { identity, route, dispatchable: false, state: route.state, reason: route.reason ?? "The selected route is not dispatchable." };
  return { identity, route, dispatchable: true, state: "available", reason: "Route is present in the current catalog snapshot." };
}

/** Small stateful facade for consumers that refresh catalogs over time. */
export class CatalogRouteAdapter {
  private current: CatalogSnapshot | null = null;
  private previous: CatalogSnapshot | null = null;
  private routes: CatalogRoute[] = [];

  getSnapshot(): CatalogSnapshot | null { return this.current; }
  getRoutes(): readonly CatalogRoute[] { return this.routes; }

  setSnapshot(snapshot: CatalogSnapshot, nowMs = Date.now()): void {
    if (this.current && snapshot.profileId !== this.current.profileId) {
      this.previous = null;
    } else {
      this.previous = this.current;
    }
    this.current = snapshot;
    this.routes = reconcileCatalogRoutes(snapshot, this.previous ?? undefined, nowMs);
  }

  resolve(identity: CatalogRouteIdentity): RouteResolution {
    return resolveCatalogRoute(this.routes, identity);
  }
}
