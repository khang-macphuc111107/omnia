import {
  Clipboard,
  Database,
  Download,
  Eye,
  LockKeyhole,
  Pin,
  RotateCcw,
  Route,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  buildCacheContextRouteProjection,
  DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT,
  filterUserManagedCacheInventory,
  serializeCacheContextRoutePreview,
  type CacheInventoryDisplayFilter,
  type CacheContextRouteDraft,
  type CacheContextRouteProjection,
  type CacheContextSegment,
  type CacheContextSegmentKind,
  type ProviderCacheEvidence,
  type ProviderCacheMode,
  type ProviderCacheUnsupportedBehavior,
  type UserManagedCacheObject,
} from "./cache-context-routing-contract";

const DEFAULT_SEGMENTS: readonly CacheContextSegment[] = [
  { id: "system", label: "System + safety instructions", kind: "stable-instruction", cacheClass: "static", selected: true, tokenEstimate: 520 },
  { id: "project", label: "Project instructions", kind: "project-instruction", cacheClass: "slow", selected: true, tokenEstimate: 280 },
  { id: "tools", label: "Tool schemas", kind: "tool-schema", cacheClass: "slow", selected: true, tokenEstimate: 460 },
  { id: "sources", label: "Selected source excerpts", kind: "source", cacheClass: "slow", selected: true, tokenEstimate: 980 },
  { id: "prompt", label: "Current user prompt", kind: "user-input", cacheClass: "dynamic", selected: true, tokenEstimate: 180 },
  { id: "telemetry", label: "Volatile telemetry", kind: "telemetry", cacheClass: "never_cache", selected: false, tokenEstimate: null },
];

const SEGMENT_KIND_LABELS: Record<CacheContextSegmentKind, string> = {
  "stable-instruction": "stable instruction",
  "project-instruction": "project instruction",
  "tool-schema": "tool schema",
  source: "source",
  "user-input": "dynamic input",
  telemetry: "telemetry",
};

export const DEFAULT_USER_MANAGED_CACHE_OBJECTS: readonly UserManagedCacheObject[] = [
  {
    id: "cache-project-context",
    kind: "compiled-context",
    label: "Project context manifest",
    scope: "project",
    dataClass: "internal",
    bytes: 196 * 1024,
    tokenEstimate: 1240,
    lineage: "project instructions + selected source revisions",
    status: "warm",
    hitCount: 18,
    missCount: 3,
    lastUsedAt: "2026-09-30T08:30:00Z",
    ttlSeconds: 86400,
    pinned: true,
  },
  {
    id: "cache-ocr-readme",
    kind: "ocr",
    label: "README extraction",
    scope: "project",
    dataClass: "public",
    bytes: 512 * 1024,
    tokenEstimate: 980,
    lineage: "README.md · extraction revision 3",
    status: "stale",
    hitCount: 6,
    missCount: 4,
    lastUsedAt: "2026-09-29T19:12:00Z",
    ttlSeconds: 21600,
    pinned: false,
  },
  {
    id: "cache-retrieval-index",
    kind: "retrieval",
    label: "Retrieval candidate set",
    scope: "chat",
    dataClass: "internal",
    bytes: 768 * 1024,
    tokenEstimate: 620,
    lineage: "query normalization + index watermark 42",
    status: "expired",
    hitCount: 2,
    missCount: 8,
    lastUsedAt: "2026-09-28T11:04:00Z",
    ttlSeconds: 3600,
    pinned: false,
  },
];

function downloadPreview(payload: string, format: "json" | "markdown"): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-cache-context-route-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unknown";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatLastUsed(value: string | null): string {
  if (!value) return "Last use unknown";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `Last used ${new Date(timestamp).toLocaleString()}` : "Last use unknown";
}

export interface CacheContextRoutingPreviewProps {
  readonly initialDraft?: Partial<CacheContextRouteDraft>;
  readonly segments?: readonly CacheContextSegment[];
  readonly initialLocalObjects?: readonly UserManagedCacheObject[];
  readonly providerEvidence?: ProviderCacheEvidence;
  readonly providerLabel?: string;
  readonly displayFilter?: CacheInventoryDisplayFilter;
  readonly onDisplayFilterChange?: (filter: CacheInventoryDisplayFilter) => void;
  readonly onDraftChange?: (draft: CacheContextRouteDraft, projection: CacheContextRouteProjection) => void;
}

export function CacheContextRoutingPreview({
  initialDraft,
  segments = DEFAULT_SEGMENTS,
  initialLocalObjects = DEFAULT_USER_MANAGED_CACHE_OBJECTS,
  providerEvidence,
  providerLabel = "Selected provider",
  displayFilter,
  onDisplayFilterChange,
  onDraftChange,
}: CacheContextRoutingPreviewProps) {
  const [draft, setDraft] = useState<CacheContextRouteDraft>(() => ({ ...DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT, ...initialDraft }));
  const [showPlan, setShowPlan] = useState(true);
  const [showInventory, setShowInventory] = useState(false);
  const [localDisplayFilter, setLocalDisplayFilter] = useState<CacheInventoryDisplayFilter>("all");
  const [localObjects, setLocalObjects] = useState<readonly UserManagedCacheObject[]>(() => [...initialLocalObjects]);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Cache planning stays in this renderer preview.");
  const buildProjection = (nextDraft: CacheContextRouteDraft, nextObjects = localObjects): CacheContextRouteProjection => buildCacheContextRouteProjection({
    draft: nextDraft,
    segments,
    localObjects: nextObjects,
    providerLabel,
    ...(providerEvidence ? { providerEvidence } : {}),
  });
  const projection = useMemo(
    () => buildProjection(draft),
    [draft, localObjects, providerEvidence, providerLabel, segments],
  );
  const activeDisplayFilter = displayFilter ?? localDisplayFilter;
  const visibleInventoryObjects = useMemo(
    () => filterUserManagedCacheInventory(projection.local.inventory.objects, activeDisplayFilter),
    [activeDisplayFilter, projection.local.inventory.objects],
  );
  const payload = useMemo(() => serializeCacheContextRoutePreview(projection, format), [format, projection]);

  const update = (patch: Partial<CacheContextRouteDraft>, message = "Cache/context route draft changed in the renderer preview.") => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      const nextProjection = buildProjection(next);
      onDraftChange?.(next, nextProjection);
      return next;
    });
    setStatus(message);
  };

  const reset = () => {
    const next = { ...DEFAULT_CACHE_CONTEXT_ROUTE_DRAFT };
    const nextObjects = [...initialLocalObjects];
    setDraft(next);
    setLocalObjects(nextObjects);
    setLocalDisplayFilter("all");
    onDisplayFilterChange?.("all");
    onDraftChange?.(next, buildProjection(next, nextObjects));
    setStatus("Cache/context route draft reset to defaults.");
  };

  const updateObject = (id: string, patch: Partial<UserManagedCacheObject>, message: string) => {
    setLocalObjects((current) => {
      const nextObjects = current.map((object) => object.id === id ? { ...object, ...patch } : object);
      onDraftChange?.(draft, buildProjection(draft, nextObjects));
      return nextObjects;
    });
    setStatus(message);
  };

  const invalidateStale = () => {
    setLocalObjects((current) => {
      const nextObjects = current.map((object) => !object.pinned && (object.status === "stale" || object.status === "expired")
        ? { ...object, status: "invalidated" as const }
        : object);
      onDraftChange?.(draft, buildProjection(draft, nextObjects));
      return nextObjects;
    });
    setStatus("Unpinned stale/expired objects marked invalidated in the renderer preview; pinned objects were preserved and no native object was deleted.");
  };

  const inventoryPayload = useMemo(() => JSON.stringify({
    schema: "omnia.user-managed-cache-inventory-preview.v1",
    displayFilter: activeDisplayFilter,
    exportScope: "all-redacted-objects",
    inventory: projection.local.inventory,
    boundary: projection.boundary,
  }, null, 2), [activeDisplayFilter, projection]);

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no cache/context preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied the renderer-local ${format.toUpperCase()} cache/context preview.`);
    } catch {
      setStatus("Clipboard access was denied; nothing was copied.");
    }
  };

  return (
    <section className="cache-context-routing-preview" aria-labelledby="cache-context-routing-title">
      <header className="cache-context-routing-preview__header">
        <span className="cache-context-routing-preview__icon"><Route size={16} aria-hidden="true" /></span>
        <span><span className="eyebrow">Renderer-local cache planner</span><h3 id="cache-context-routing-title">Cache, context &amp; route plan</h3><p>Shape local reuse and provider-native hints while keeping billing evidence and authority boundaries explicit.</p></span>
        <span className="cache-context-routing-preview__badge"><ShieldCheck size={12} aria-hidden="true" /> Preview only</span>
      </header>

      <div className="cache-context-routing-preview__history" role="toolbar" aria-label="Cache and context route controls">
        <span><strong>Reversible draft</strong><small>{status}</small></span>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset cache and context route draft" title="Reset cache and context route draft"><RotateCcw size={12} /> Reset</button>
      </div>

      <div className="cache-context-routing-preview__form">
        <label><span><Database size={12} /> Local reuse</span><select value={draft.localMode} onChange={(event) => update({ localMode: event.target.value as CacheContextRouteDraft["localMode"] })} aria-label="Local cache reuse mode"><option value="disabled">Disabled</option><option value="safe-reuse">Safe reuse</option><option value="aggressive-reuse">Aggressive reuse</option></select></label>
        <label><span><Route size={12} /> Provider cache hints</span><select value={draft.providerMode} onChange={(event) => update({ providerMode: event.target.value as ProviderCacheMode })} aria-label="Provider cache hint mode"><option value="disabled">Disabled</option><option value="auto">Auto</option><option value="implicit">Implicit</option><option value="explicit">Explicit</option><option value="provider-default">Provider default</option></select></label>
        <label><span>Unsupported provider behavior</span><select value={draft.unsupportedBehavior} onChange={(event) => update({ unsupportedBehavior: event.target.value as ProviderCacheUnsupportedBehavior })} aria-label="Unsupported provider cache behavior"><option value="local-optimize">Optimize locally</option><option value="send-uncached">Send uncached</option><option value="block">Block route</option></select></label>
        <label><span>Local TTL</span><select value={draft.localTtlSeconds === null ? "none" : String(draft.localTtlSeconds)} onChange={(event) => update({ localTtlSeconds: event.target.value === "none" ? null : Number(event.target.value) })} aria-label="Local cache retention"><option value="3600">1 hour</option><option value="21600">6 hours</option><option value="86400">24 hours</option><option value="604800">7 days</option><option value="none">No TTL</option></select></label>
        <label className="cache-context-routing-preview__check"><input type="checkbox" checked={draft.stablePrefixPlanning} onChange={(event) => update({ stablePrefixPlanning: event.target.checked }, event.target.checked ? "Stable-prefix planning enabled." : "Stable-prefix planning disabled.")} /> Plan stable prefix <small>preserve dynamic tail order</small></label>
        <label className="cache-context-routing-preview__check"><input type="checkbox" checked={draft.invalidateOnSourceChange} onChange={(event) => update({ invalidateOnSourceChange: event.target.checked }, event.target.checked ? "Source-change invalidation enabled." : "Source-change invalidation disabled.")} /> Invalidate on source change</label>
      </div>

      <details className="cache-context-routing-preview__advanced" open>
        <summary><span><Database size={13} /> User-managed cache policy</span><small>renderer-only · storage, protection &amp; retention</small></summary>
        <div className="cache-context-routing-preview__advanced-grid">
          <label><span>Encryption boundary</span><select value={draft.localEncryption} onChange={(event) => update({ localEncryption: event.target.value as CacheContextRouteDraft["localEncryption"] })} aria-label="Local cache encryption boundary"><option value="native-profile-key">Native profile key</option><option value="project-key">Project key</option><option value="disabled-by-policy">Disabled by policy</option></select></label>
          <label><span>Maximum storage</span><select value={String(draft.localMaxBytes)} onChange={(event) => update({ localMaxBytes: Number(event.target.value) })} aria-label="Local cache maximum storage"><option value={1073741824}>1 GiB</option><option value={4294967296}>4 GiB</option><option value={8589934592}>8 GiB</option><option value={17179869184}>16 GiB</option><option value={68719476736}>64 GiB</option></select></label>
          <label><span>Eviction policy</span><select value={draft.localEviction} onChange={(event) => update({ localEviction: event.target.value as CacheContextRouteDraft["localEviction"] })} aria-label="Local cache eviction policy"><option value="lru">Least recently used</option><option value="ttl-lru">TTL + least recently used</option><option value="recompute-cost">Recompute cost</option><option value="sensitivity-aware">Sensitivity aware</option><option value="custom">Custom policy</option></select></label>
          <label><span>Response reuse</span><select value={draft.responseReuse} onChange={(event) => update({ responseReuse: event.target.value as CacheContextRouteDraft["responseReuse"] })} aria-label="Local response reuse policy"><option value="disabled">Disabled</option><option value="exact-input-review">Exact input + review</option><option value="freshness-policy-review">Freshness policy + review</option></select></label>
          <label className="cache-context-routing-preview__check"><input type="checkbox" checked={draft.secureDelete} onChange={(event) => update({ secureDelete: event.target.checked }, event.target.checked ? "Secure-delete intent enabled in the renderer preview." : "Secure-delete intent disabled in the renderer preview.")} /> Secure-delete intent <small>native deletion remains unavailable</small></label>
          <fieldset className="cache-context-routing-preview__choice-group"><legend>Allowed object kinds</legend>{(["extraction", "ocr", "thumbnail", "ast", "embedding", "summary", "retrieval", "compiled-context", "tool-result", "response", "original"] as const).map((kind) => <label key={kind}><input type="checkbox" checked={draft.allowedObjectKinds.includes(kind)} onChange={(event) => update({ allowedObjectKinds: event.target.checked ? [...new Set([...draft.allowedObjectKinds, kind])] : draft.allowedObjectKinds.filter((value) => value !== kind) })} />{kind}</label>)}</fieldset>
          <fieldset className="cache-context-routing-preview__choice-group"><legend>Data classes eligible</legend>{(["public", "internal", "confidential", "restricted"] as const).map((dataClass) => <label key={dataClass}><input type="checkbox" checked={draft.dataClassesAllowed.includes(dataClass)} onChange={(event) => update({ dataClassesAllowed: event.target.checked ? [...new Set([...draft.dataClassesAllowed, dataClass])] : draft.dataClassesAllowed.filter((value) => value !== dataClass) })} />{dataClass}</label>)}</fieldset>
        </div>
      </details>

      <details className="cache-context-routing-preview__advanced">
        <summary><span><Route size={13} /> Provider-native cache plan</span><small>attempt hinting only on supported routes</small></summary>
        <div className="cache-context-routing-preview__advanced-grid">
          <label><span>Provider cache TTL</span><select value={draft.providerTtlSeconds === null ? "provider" : String(draft.providerTtlSeconds)} onChange={(event) => update({ providerTtlSeconds: event.target.value === "provider" ? null : Number(event.target.value) })} aria-label="Provider cache TTL preview"><option value="provider">Provider default</option><option value="3600">1 hour</option><option value="21600">6 hours</option><option value="86400">24 hours</option><option value="604800">7 days</option></select></label>
          <label><span>Cache key strategy</span><select value={draft.providerKeyStrategy} onChange={(event) => update({ providerKeyStrategy: event.target.value as CacheContextRouteDraft["providerKeyStrategy"] })} aria-label="Provider cache key strategy preview"><option value="provider-default">Provider default</option><option value="content-hash">Content hash</option><option value="project-route">Project + route</option><option value="manual">Manual</option></select></label>
          <label><span>Warm-up behavior</span><select value={draft.warmup} onChange={(event) => update({ warmup: event.target.value as CacheContextRouteDraft["warmup"] })} aria-label="Provider cache warmup preview"><option value="disabled">Disabled</option><option value="on-first-use">On first use</option><option value="scheduled">Scheduled</option><option value="manual">Manual</option></select></label>
          <label className="cache-context-routing-preview__advanced-wide"><span>Provider breakpoint labels</span><input value={draft.providerBreakpoints.join(", ")} onChange={(event) => update({ providerBreakpoints: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} aria-label="Provider cache breakpoints preview" placeholder="system, tools" /></label>
        </div>
        <p className="cache-context-routing-preview__provider-note">These are planned adapter inputs. They do not make a provider persist a cache or bill cached tokens; unsupported routes follow the selected fallback.</p>
      </details>

      <div className="cache-context-routing-preview__summary" aria-label="Cache and context route summary">
        <article><span>Local reuse</span><strong>{projection.local.label}</strong><small>{projection.local.detail}</small></article>
        <article><span>User cache inventory</span><strong>{projection.local.inventory.objectCount} objects · {formatBytes(projection.local.inventory.totalBytes)}</strong><small>{projection.local.inventory.hitCount === null ? "Hit count unknown" : `${projection.local.inventory.hitCount} hits`} · {projection.local.inventory.staleCount + projection.local.inventory.expiredCount} need review</small></article>
        <article><span>Provider plan</span><strong>{projection.provider.planState}</strong><small>{projection.provider.detail}</small></article>
        <article><span>Stable prefix</span><strong>{projection.stablePrefix.estimatedTokens === null ? "Unknown tokens" : `${projection.stablePrefix.estimatedTokens.toLocaleString()} tokens`}</strong><small>{projection.stablePrefix.includedSegmentIds.length} segment{projection.stablePrefix.includedSegmentIds.length === 1 ? "" : "s"} planned · {projection.stablePrefix.omittedSegmentIds.length} omitted</small></article>
      </div>

      <div className="cache-context-routing-preview__inventory-toolbar" role="toolbar" aria-label="User-managed cache inventory controls">
        <button type="button" className="cache-context-routing-preview__details-toggle" aria-expanded={showInventory} onClick={() => setShowInventory((value) => !value)}><span><Eye size={13} /> {showInventory ? "Hide" : "Inspect"} user-managed cache</span><span>{projection.local.inventory.usagePercent === null ? "usage unknown" : `${projection.local.inventory.usagePercent.toFixed(0)}% used`}</span></button>
        <button type="button" className="button button--ghost" onClick={invalidateStale} disabled={!projection.local.inventory.objects.some((object) => !object.pinned && (object.status === "stale" || object.status === "expired"))} aria-label="Invalidate stale and expired cache objects" title="Mark unpinned stale and expired objects invalidated in this renderer preview; pinned objects stay untouched"><Trash2 size={12} /> Invalidate stale</button>
        <button type="button" className="button button--ghost" onClick={() => setStatus(downloadPreview(inventoryPayload, "json") ? "Downloaded renderer-local full cache inventory manifest." : "Download unavailable in this surface; no inventory file was written.")} aria-label="Export user-managed cache inventory" title="Export all redacted cache inventory metadata, regardless of display filter"><Download size={12} /> Export inventory</button>
      </div>

      {showInventory ? <div className="cache-context-routing-preview__inventory" role="region" aria-label="User-managed cache inventory">
        <div className="cache-context-routing-preview__inventory-stats">
          <span><strong>{formatBytes(projection.local.inventory.totalBytes)}</strong><small>stored of {formatBytes(projection.local.inventory.maxBytes)}</small></span>
          <span><strong>{projection.local.inventory.pinnedCount}</strong><small>pinned objects</small></span>
          <span><strong>{projection.local.inventory.missCount === null ? "Unknown" : projection.local.inventory.missCount}</strong><small>misses observed</small></span>
        </div>
        <div className="cache-context-routing-preview__inventory-filter">
          <label htmlFor="local-cache-inventory-filter">View
            <select id="local-cache-inventory-filter" aria-label="Local cache display filter" value={activeDisplayFilter} title="Filter redacted local objects; this does not change cache policy or provider billing" onChange={(event) => { const next = event.target.value as CacheInventoryDisplayFilter; setLocalDisplayFilter(next); onDisplayFilterChange?.(next); }}>
              <option value="all">All</option><option value="reusable">Reusable</option><option value="invalidated">Invalidated</option><option value="unknown">Unknown</option>
            </select>
          </label>
          <small aria-live="polite">{visibleInventoryObjects.length} of {projection.local.inventory.objectCount} shown · stale/expired are not invalidated until rehearsed</small>
        </div>
        <div className="cache-context-routing-preview__inventory-list" role="list" aria-label="Redacted local cache objects">
          {visibleInventoryObjects.map((object) => <article key={object.id} role="listitem" className="cache-context-routing-preview__inventory-item">
            <div className="cache-context-routing-preview__inventory-main"><span><strong>{object.label}</strong><small>{object.kind} · {object.scope} · {object.dataClass}</small><small>{object.lineage}</small></span><em className={`cache-context-routing-preview__cache-status cache-context-routing-preview__cache-status--${object.status}`}>{object.status}</em></div>
            <div className="cache-context-routing-preview__inventory-meta"><span>{formatBytes(object.bytes)} · {object.tokenEstimate === null ? "token estimate unknown" : `${object.tokenEstimate.toLocaleString()} tokens`}</span><span>{formatLastUsed(object.lastUsedAt)} · {object.ttlSeconds === null ? "no TTL" : `${Math.round(object.ttlSeconds / 3600)}h TTL`}</span><span>{object.hitCount === null ? "hits unknown" : `${object.hitCount} hits`} · {object.missCount === null ? "misses unknown" : `${object.missCount} misses`}</span></div>
            <button type="button" className="button button--ghost" onClick={() => updateObject(object.id, { pinned: !object.pinned }, object.pinned ? `${object.label} unpinned in the renderer preview.` : `${object.label} pinned in the renderer preview.`)} aria-label={`${object.pinned ? "Unpin" : "Pin"} ${object.label}`}><Pin size={12} /> {object.pinned ? "Pinned" : "Pin"}</button>
          </article>)}
          {visibleInventoryObjects.length === 0 ? <p className="cache-context-routing-preview__inventory-empty" role="status">No {activeDisplayFilter === "all" ? "cache" : activeDisplayFilter} objects in this renderer preview. Stale/expired objects stay in All until invalidation is rehearsed.</p> : null}
        </div>
        <p className="cache-context-routing-preview__inventory-note"><LockKeyhole size={12} /> Demo inventory rows are seeded, redacted renderer data—not a disk scan or user data. Invalidate, pin, export and secure-delete controls rehearse user intent; no native cache object, file, key or provider handle is changed.</p>
      </div> : null}

      <button type="button" className="cache-context-routing-preview__details-toggle" aria-expanded={showPlan} onClick={() => setShowPlan((value) => !value)}><span><Route size={13} /> {showPlan ? "Hide" : "Show"} prefix plan</span><span>{projection.provider.evidenceStatus}</span></button>
      {showPlan ? <div className="cache-context-routing-preview__segments" role="list" aria-label="Cache context segment plan">
        {segments.map((segment) => {
          const included = projection.stablePrefix.includedSegmentIds.includes(segment.id);
          const omitted = projection.stablePrefix.omittedSegmentIds.includes(segment.id);
          return <div key={segment.id} role="listitem" className={included ? "cache-context-routing-preview__segment cache-context-routing-preview__segment--included" : "cache-context-routing-preview__segment"}><span><strong>{segment.label}</strong><small>{SEGMENT_KIND_LABELS[segment.kind]} · {segment.cacheClass}</small></span><em>{included ? "stable prefix" : omitted ? "dynamic / omitted" : "not selected"}</em></div>;
        })}
        {projection.stablePrefix.reasons.length > 0 ? <p className="cache-context-routing-preview__reasons">{projection.stablePrefix.reasons.join(" ")}</p> : null}
      </div> : null}

      <div className="cache-context-routing-preview__transfer" role="toolbar" aria-label="Cache context route export">
        <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")} aria-label="Cache context route export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={12} /> Copy</button>
        <button type="button" className="button button--ghost" onClick={() => setStatus(downloadPreview(payload, format) ? `Downloaded renderer-local ${format.toUpperCase()} cache/context preview.` : "Download unavailable in this surface; no file was written.")}><Download size={12} /> Download</button>
      </div>

      <p className="cache-context-routing-preview__boundary"><LockKeyhole size={13} aria-hidden="true" /> Local reuse is not provider cache billing. This preview never sends cache hints, compiles context, calls a provider, stores credentials, or persists policy.</p>
    </section>
  );
}

export default CacheContextRoutingPreview;
