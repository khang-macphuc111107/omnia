export const CACHE_CONTEXT_ROUTE_SCHEMA = "omnia.cache-context-route-preview.v1" as const;

export type LocalCacheReuseMode = "disabled" | "safe-reuse" | "aggressive-reuse";
export type LocalCacheEncryption = "native-profile-key" | "project-key" | "disabled-by-policy";
export type LocalCacheEviction = "lru" | "ttl-lru" | "recompute-cost" | "sensitivity-aware" | "custom";
export type LocalCacheResponseReuse = "disabled" | "exact-input-review" | "freshness-policy-review";
export type CacheObjectKind =
  | "original"
  | "extraction"
  | "ocr"
  | "thumbnail"
  | "ast"
  | "embedding"
  | "summary"
  | "retrieval"
  | "compiled-context"
  | "tool-result"
  | "response";
export type ProviderCacheMode = "disabled" | "auto" | "implicit" | "explicit" | "provider-default";
export type ProviderCacheKeyStrategy = "provider-default" | "content-hash" | "project-route" | "manual";
export type ProviderCacheUnsupportedBehavior = "send-uncached" | "local-optimize" | "block";
export type ProviderCacheWarmup = "disabled" | "on-first-use" | "scheduled" | "manual";
export type CacheDataClass = "public" | "internal" | "confidential" | "restricted";
export type CacheInventoryDisplayFilter = "all" | "reusable" | "invalidated" | "unknown";

/**
 * A redacted inventory row for the user-managed cache preview.  The native
 * storage boundary is expected to provide the real object metadata later; the
 * renderer deliberately carries lineage labels and counters only, never
 * source bytes, prompt bodies, credentials, or cache handles.
 */
export type UserManagedCacheObject = {
  readonly id: string;
  readonly kind: CacheObjectKind;
  readonly label: string;
  readonly scope: "profile" | "project" | "chat";
  readonly dataClass: CacheDataClass;
  readonly bytes: number | null;
  readonly tokenEstimate: number | null;
  readonly lineage: string;
  readonly status: "warm" | "stale" | "expired" | "blocked" | "invalidated" | "unknown";
  readonly hitCount: number | null;
  readonly missCount: number | null;
  readonly lastUsedAt: string | null;
  readonly ttlSeconds: number | null;
  readonly pinned: boolean;
};

export type CacheContextSegmentKind =
  | "stable-instruction"
  | "project-instruction"
  | "tool-schema"
  | "source"
  | "user-input"
  | "telemetry";

export type CacheContextSegment = {
  readonly id: string;
  readonly label: string;
  readonly kind: CacheContextSegmentKind;
  readonly cacheClass: "static" | "slow" | "dynamic" | "never_cache";
  readonly selected: boolean;
  readonly tokenEstimate: number | null;
};

export type ProviderCacheEvidenceStatus =
  | "unknown"
  | "reported-hit"
  | "reported-miss"
  | "reported-write"
  | "reported-partial";

export type ProviderCacheEvidence = {
  readonly status: ProviderCacheEvidenceStatus;
  readonly source: "not-observed" | "provider-reported" | "adapter-verified";
  readonly providerLabel?: string;
  readonly readTokens?: number | null;
  readonly writeTokens?: number | null;
  readonly note?: string;
};

export type CacheContextRouteDraft = {
  readonly localMode: LocalCacheReuseMode;
  readonly localEncryption: LocalCacheEncryption;
  readonly localMaxBytes: number;
  readonly localTtlSeconds: number | null;
  readonly localEviction: LocalCacheEviction;
  readonly allowedObjectKinds: readonly CacheObjectKind[];
  readonly responseReuse: LocalCacheResponseReuse;
  readonly secureDelete: boolean;
  readonly providerMode: ProviderCacheMode;
  readonly stablePrefixPlanning: boolean;
  readonly providerTtlSeconds: number | null;
  readonly providerKeyStrategy: ProviderCacheKeyStrategy;
  readonly providerBreakpoints: readonly string[];
  readonly unsupportedBehavior: ProviderCacheUnsupportedBehavior;
  readonly warmup: ProviderCacheWarmup;
  readonly dataClassesAllowed: readonly CacheDataClass[];
  readonly invalidateOnSourceChange: boolean;
};

export const DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT: CacheContextRouteDraft = {
  localMode: "safe-reuse",
  localEncryption: "native-profile-key",
  localMaxBytes: 8 * 1024 * 1024 * 1024,
  localTtlSeconds: 24 * 60 * 60,
  localEviction: "ttl-lru",
  allowedObjectKinds: ["extraction", "ocr", "thumbnail", "ast", "embedding", "summary", "retrieval", "compiled-context", "tool-result"],
  responseReuse: "disabled",
  secureDelete: true,
  providerMode: "auto",
  stablePrefixPlanning: true,
  providerTtlSeconds: null,
  providerKeyStrategy: "provider-default",
  providerBreakpoints: [],
  unsupportedBehavior: "local-optimize",
  warmup: "on-first-use",
  dataClassesAllowed: ["public", "internal"],
  invalidateOnSourceChange: true,
};

export type CacheContextRouteProjection = {
  readonly schema: typeof CACHE_CONTEXT_ROUTE_SCHEMA;
  readonly local: {
    readonly enabled: boolean;
    readonly label: string;
    readonly detail: string;
    readonly objectKinds: readonly CacheObjectKind[];
    readonly policy: {
      readonly encryption: LocalCacheEncryption;
      readonly maxBytes: number | null;
      readonly defaultTtlSeconds: number | null;
      readonly eviction: LocalCacheEviction;
      readonly allowedObjectKinds: readonly CacheObjectKind[];
      readonly responseReuse: LocalCacheResponseReuse;
      readonly secureDelete: boolean;
      readonly dataClassesAllowed: readonly CacheDataClass[];
      readonly invalidateOnSourceChange: boolean;
    };
    readonly inventory: {
      readonly objects: readonly (UserManagedCacheObject & { readonly eligible: boolean; readonly eligibilityReason: string })[];
      readonly totalBytes: number | null;
      readonly maxBytes: number | null;
      readonly usagePercent: number | null;
      readonly objectCount: number;
      readonly eligibleCount: number;
      readonly excludedByPolicyCount: number;
      readonly pinnedCount: number;
      readonly staleCount: number;
      readonly expiredCount: number;
      readonly blockedCount: number;
      readonly invalidatedCount: number;
      readonly unknownCount: number;
      readonly hitCount: number | null;
      readonly missCount: number | null;
    };
  };
  readonly provider: {
    readonly mode: ProviderCacheMode;
    readonly label: string;
    readonly planState: "planned" | "not-planned" | "blocked";
    readonly evidenceStatus: ProviderCacheEvidenceStatus;
    readonly evidenceSource: ProviderCacheEvidence["source"];
    readonly detail: string;
    readonly readTokens: number | null;
    readonly writeTokens: number | null;
    readonly plan: {
      readonly stablePrefixPlanning: boolean;
      readonly ttlSeconds: number | null;
      readonly cacheKeyStrategy: ProviderCacheKeyStrategy;
      readonly cacheBreakpoints: readonly string[];
      readonly unsupportedBehavior: ProviderCacheUnsupportedBehavior;
      readonly warmup: ProviderCacheWarmup;
      readonly evidencePolicy: "provider-reported-only";
    };
  };
  readonly stablePrefix: {
    readonly planned: boolean;
    readonly includedSegmentIds: readonly string[];
    readonly omittedSegmentIds: readonly string[];
    readonly reasons: readonly string[];
    readonly estimatedTokens: number | null;
  };
  readonly invalidation: {
    readonly enabled: boolean;
    readonly reasons: readonly string[];
  };
  readonly boundary: readonly string[];
};

const BOUNDARY = [
  "Renderer-session preview only; no native cache policy was written.",
  "Local reuse can avoid work or tokens sent, but it cannot create provider cache billing evidence.",
  "Provider cache hit/read/write is accepted only from provider-reported or adapter-verified evidence.",
  "Credential bytes, raw prompt/response bodies, file bytes and cache handles are excluded.",
] as const;

function sumTokenEstimates(segments: readonly CacheContextSegment[]): number | null {
  if (segments.length === 0) return null;

  // A partial sum looks precise in the UI even when one included segment has
  // no estimate. Keep the aggregate unknown until every planned segment has a
  // valid estimate.
  let total = 0;
  for (const segment of segments) {
    const value = segment.tokenEstimate;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

function sumNullableCounters(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

function projectLocalInventory(
  objects: readonly UserManagedCacheObject[],
  maxBytes: number,
  draft: CacheContextRouteDraft,
): CacheContextRouteProjection["local"]["inventory"] {
  const safeObjects = objects.filter((object) => object.id.trim().length > 0 && object.label.trim().length > 0).map((object) => {
    const kindAllowed = draft.allowedObjectKinds.includes(object.kind);
    const dataClassAllowed = draft.dataClassesAllowed.includes(object.dataClass);
    const fresh = object.status === "warm";
    const eligible = draft.localMode !== "disabled" && kindAllowed && dataClassAllowed && fresh;
    const eligibilityReason = draft.localMode === "disabled"
      ? "Local reuse disabled"
      : !kindAllowed
        ? "Object kind excluded by policy"
        : !dataClassAllowed
          ? "Data class excluded by policy"
          : !fresh
            ? `Object status is ${object.status}`
            : "Eligible for local reuse in this preview";
    return { ...object, eligible, eligibilityReason };
  });
  const totalBytes = sumNullableCounters(safeObjects.map((object) => object.bytes));
  const usagePercent = totalBytes !== null && Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.min(100, Math.max(0, (totalBytes / maxBytes) * 100))
    : null;
  return {
    objects: safeObjects,
    totalBytes,
    maxBytes: Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : null,
    usagePercent,
    objectCount: safeObjects.length,
    eligibleCount: safeObjects.filter((object) => object.eligible).length,
    excludedByPolicyCount: safeObjects.filter((object) => !object.eligible).length,
    pinnedCount: safeObjects.filter((object) => object.pinned).length,
    staleCount: safeObjects.filter((object) => object.status === "stale").length,
    expiredCount: safeObjects.filter((object) => object.status === "expired").length,
    blockedCount: safeObjects.filter((object) => object.status === "blocked").length,
    invalidatedCount: safeObjects.filter((object) => object.status === "invalidated").length,
    unknownCount: safeObjects.filter((object) => object.status === "unknown").length,
    hitCount: sumNullableCounters(safeObjects.map((object) => object.hitCount)),
    missCount: sumNullableCounters(safeObjects.map((object) => object.missCount)),
  };
}

/**
 * Display categories are evidence states, not provider-cache billing states.
 * Stale/expired entries are candidates for invalidation, not already removed.
 * Blocked entries are known policy denials, not unknown observations.
 */
export function filterUserManagedCacheInventory(
  objects: CacheContextRouteProjection["local"]["inventory"]["objects"],
  filter: CacheInventoryDisplayFilter,
): CacheContextRouteProjection["local"]["inventory"]["objects"] {
  if (filter === "all") return objects;
  if (filter === "reusable") return objects.filter((object) => object.eligible);
  if (filter === "invalidated") return objects.filter((object) => object.status === "invalidated");
  return objects.filter((object) => object.status === "unknown");
}

function isStablePrefixSegment(segment: CacheContextSegment): boolean {
  return segment.selected && (segment.kind === "stable-instruction" || segment.kind === "project-instruction" || segment.kind === "tool-schema") && segment.cacheClass !== "dynamic" && segment.cacheClass !== "never_cache";
}

const PROVIDER_EVIDENCE_STATUSES: readonly ProviderCacheEvidenceStatus[] = [
  "unknown",
  "reported-hit",
  "reported-miss",
  "reported-write",
  "reported-partial",
];

const PROVIDER_EVIDENCE_SOURCES: readonly ProviderCacheEvidence["source"][] = [
  "not-observed",
  "provider-reported",
  "adapter-verified",
];

function isFiniteCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Provider evidence is an input boundary, not an authority boundary. Keep the
 * projection fail-closed when an adapter hands us malformed or incomplete
 * runtime data instead of letting an invalid receipt look like a cache hit.
 */
function normalizeProviderEvidence(input?: ProviderCacheEvidence): ProviderCacheEvidence {
  if (!input) {
    return {
      status: "unknown",
      source: "not-observed",
      readTokens: null,
      writeTokens: null,
    };
  }

  const candidateStatus = input.status as string;
  const candidateSource = input.source as string;
  const status = PROVIDER_EVIDENCE_STATUSES.includes(candidateStatus as ProviderCacheEvidenceStatus)
    ? candidateStatus as ProviderCacheEvidenceStatus
    : "unknown";
  const source = PROVIDER_EVIDENCE_SOURCES.includes(candidateSource as ProviderCacheEvidence["source"])
    ? candidateSource as ProviderCacheEvidence["source"]
    : "not-observed";
  const canClaimProviderEvidence = source === "provider-reported" || source === "adapter-verified";
  const safeStatus = status !== "unknown" && !canClaimProviderEvidence ? "unknown" : status;
  const hasAuthoritativeCacheEvidence = safeStatus !== "unknown" && canClaimProviderEvidence;
  const invalidCounterNotes: string[] = [];
  const readTokens = !hasAuthoritativeCacheEvidence || input.readTokens === null || input.readTokens === undefined
    ? null
    : isFiniteCounter(input.readTokens)
      ? input.readTokens
      : (invalidCounterNotes.push("read counter withheld because it was invalid"), null);
  const writeTokens = !hasAuthoritativeCacheEvidence || input.writeTokens === null || input.writeTokens === undefined
    ? null
    : isFiniteCounter(input.writeTokens)
      ? input.writeTokens
      : (invalidCounterNotes.push("write counter withheld because it was invalid"), null);
  const inputNote = typeof input.note === "string" ? input.note.trim() : "";
  const note = [inputNote, ...invalidCounterNotes].filter(Boolean).join(" · ");
  const normalized: ProviderCacheEvidence = {
    status: safeStatus,
    source,
    readTokens,
    writeTokens,
    ...(note ? { note } : {}),
  };
  return normalized;
}

function evidenceDetail(evidence: ProviderCacheEvidence, providerLabel: string): string {
  if (evidence.status === "unknown") return `${providerLabel}: provider cache evidence is unknown; local reuse is not counted as a hit.`;
  const source = evidence.source === "provider-reported" ? "provider-reported" : evidence.source === "adapter-verified" ? "adapter-verified" : "unverified";
  const counters = [
    evidence.readTokens === null || evidence.readTokens === undefined ? null : `${evidence.readTokens.toLocaleString()} read`,
    evidence.writeTokens === null || evidence.writeTokens === undefined ? null : `${evidence.writeTokens.toLocaleString()} written`,
  ].filter(Boolean).join(" · ");
  return `${providerLabel}: ${evidence.status.replace("reported-", "")} (${source})${counters ? ` · ${counters} input tokens` : ""}${evidence.note ? ` · ${evidence.note}` : ""}`;
}

export function buildCacheContextRouteProjection(input: {
  readonly draft?: Partial<CacheContextRouteDraft>;
  readonly segments?: readonly CacheContextSegment[];
  readonly localObjects?: readonly UserManagedCacheObject[];
  readonly providerEvidence?: ProviderCacheEvidence;
  readonly providerLabel?: string;
}): CacheContextRouteProjection {
  const draft: CacheContextRouteDraft = { ...DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT, ...input.draft };
  const segments = input.segments ?? [];
  const localObjects = input.localObjects ?? [];
  const evidence = normalizeProviderEvidence(input.providerEvidence);
  const providerLabel = input.providerLabel?.trim() || "Selected provider";
  const stableCandidates = segments.filter(isStablePrefixSegment);
  const selectedDynamic = segments.filter((segment) => segment.selected && !isStablePrefixSegment(segment));
  const prefixEnabled = draft.stablePrefixPlanning && draft.providerMode !== "disabled";
  const providerPlanState: CacheContextRouteProjection["provider"]["planState"] = draft.providerMode === "disabled"
    ? "blocked"
    : prefixEnabled && stableCandidates.length > 0
      ? "planned"
      : "not-planned";
  const reasons: string[] = [];
  if (draft.providerMode === "disabled") reasons.push("Provider-native cache hints are disabled.");
  if (!draft.stablePrefixPlanning) reasons.push("Stable-prefix planning is disabled.");
  if (stableCandidates.length === 0) reasons.push("No selected stable instruction, project, or tool-schema segment is eligible.");
  if (selectedDynamic.length > 0) reasons.push(`${selectedDynamic.length} selected dynamic segment${selectedDynamic.length === 1 ? " remains" : "s remain"} in the request tail.`);
  const includedSegmentIds = prefixEnabled ? stableCandidates.map((segment) => segment.id) : [];
  const includedSegments = segments.filter((segment) => includedSegmentIds.includes(segment.id));
  const omittedSegmentIds = segments.filter((segment) => segment.selected && !includedSegmentIds.includes(segment.id)).map((segment) => segment.id);
  const localEnabled = draft.localMode !== "disabled";
  const localLabel = draft.localMode === "disabled" ? "Local reuse disabled" : draft.localMode === "aggressive-reuse" ? "Aggressive local reuse" : "Safe local reuse";
  const localEncryptionLabel = draft.localEncryption === "native-profile-key"
    ? "Native-profile encrypted"
    : draft.localEncryption === "project-key"
      ? "Project-key encrypted"
      : "Encryption disabled by policy";
  const localDetail = localEnabled
    ? `${localEncryptionLabel} · ${draft.localEviction} eviction · ${draft.localTtlSeconds === null ? "no TTL" : `${Math.round(draft.localTtlSeconds / 3600)}h TTL`} · ${draft.allowedObjectKinds.length} object kinds`
    : "No local object or context reuse will be considered in this preview.";
  const invalidationReasons = draft.invalidateOnSourceChange
    ? ["source hash or access grant changes", "transform/model/tokenizer revision changes", "route, tool schema or context policy changes"]
    : ["source-change invalidation is disabled in this draft"];
  return {
    schema: CACHE_CONTEXT_ROUTE_SCHEMA,
    local: {
      enabled: localEnabled,
      label: localLabel,
      detail: localDetail,
      objectKinds: [...draft.allowedObjectKinds],
      policy: {
        encryption: draft.localEncryption,
        maxBytes: Number.isFinite(draft.localMaxBytes) && draft.localMaxBytes >= 0 ? draft.localMaxBytes : null,
        defaultTtlSeconds: draft.localTtlSeconds,
        eviction: draft.localEviction,
        allowedObjectKinds: [...draft.allowedObjectKinds],
        responseReuse: draft.responseReuse,
        secureDelete: draft.secureDelete,
        dataClassesAllowed: [...draft.dataClassesAllowed],
        invalidateOnSourceChange: draft.invalidateOnSourceChange,
      },
      inventory: projectLocalInventory(localObjects, draft.localMaxBytes, draft),
    },
    provider: {
      mode: draft.providerMode,
      label: providerLabel,
      planState: providerPlanState,
      evidenceStatus: evidence.status,
      evidenceSource: evidence.source,
      detail: evidenceDetail(evidence, providerLabel),
      readTokens: evidence.readTokens ?? null,
      writeTokens: evidence.writeTokens ?? null,
      plan: {
        stablePrefixPlanning: draft.stablePrefixPlanning,
        ttlSeconds: draft.providerTtlSeconds,
        cacheKeyStrategy: draft.providerKeyStrategy,
        cacheBreakpoints: [...draft.providerBreakpoints],
        unsupportedBehavior: draft.unsupportedBehavior,
        warmup: draft.warmup,
        evidencePolicy: "provider-reported-only",
      },
    },
    stablePrefix: {
      planned: providerPlanState === "planned",
      includedSegmentIds,
      omittedSegmentIds,
      reasons,
      estimatedTokens: sumTokenEstimates(includedSegments),
    },
    invalidation: {
      enabled: draft.invalidateOnSourceChange,
      reasons: invalidationReasons,
    },
    boundary: BOUNDARY,
  };
}

export type CacheContextRouteExportFormat = "json" | "markdown";

export function serializeCacheContextRoutePreview(
  projection: CacheContextRouteProjection,
  format: CacheContextRouteExportFormat = "json",
): string {
  if (format === "json") return JSON.stringify(projection, null, 2);
  const prefix = projection.stablePrefix.planned
    ? projection.stablePrefix.includedSegmentIds.join(", ") || "none"
    : "not planned";
  return [
    "# Omnia cache/context route preview",
    "",
    `- Local reuse: ${projection.local.label}`,
    `- Provider cache plan: ${projection.provider.planState}`,
    `- Provider evidence: ${projection.provider.evidenceStatus} (${projection.provider.evidenceSource})`,
    `- Stable prefix: ${prefix}`,
    `- Estimated stable-prefix tokens: ${projection.stablePrefix.estimatedTokens === null ? "unknown" : projection.stablePrefix.estimatedTokens.toLocaleString()}`,
    "",
    "## Boundary",
    ...projection.boundary.map((entry) => `- ${entry}`),
  ].join("\n");
}
