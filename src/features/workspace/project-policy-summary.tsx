import {
  Bot,
  ChevronDown,
  Clipboard,
  CircleAlert,
  Database,
  Download,
  Gauge,
  Layers3,
  RotateCcw,
  Route,
  ShieldCheck,
  Sparkles,
  Undo2,
  Redo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { providerStateLabel, resolveAutoModel, selectableModelProfiles } from "./provider-catalog";
import { buildContextEstimate } from "./context-estimate";
import type { CacheInventoryDisplayFilter } from "./cache-context-routing-contract";
import type { ProjectContextAvailability } from "./project-context-availability-contract";
import type { ProviderView } from "./types";

export type ProjectPolicyContextMode =
  | "auto"
  | "partial"
  | "full"
  | "summary-plus-sources"
  | "manifest-only"
  | "retrieval-on-demand"
  | "fresh"
  | "forked-snapshot";

export type ProjectPolicyCompactionMode =
  | "disabled"
  | "manual"
  | "prompt-triggered"
  | "threshold"
  | "predictive"
  | "auto";

export type ProjectPolicyLocalCacheMode = "disabled" | "safe-reuse" | "aggressive-reuse";
export type ProjectPolicyCacheHandoffMode = "local-only" | "provider-hint-when-supported" | "hybrid";
export type ProjectPolicyCacheKeyStrategy = "content-hash" | "source-revision" | "request-scoped";
export type ProjectPolicyAutoStrategy = "deterministic" | "adaptive-shadow" | "learned-promotion";
export type ProjectPolicyExportFormat = "json" | "markdown";

export interface ProjectPolicyDraft {
  readonly mainModelProfileId: string;
  readonly subagentModelProfileId: string;
  readonly autoStrategy: ProjectPolicyAutoStrategy;
  readonly contextMode: ProjectPolicyContextMode;
  /** Context delivery mode for child/subagent work; independent from the main run. */
  readonly subagentContextMode: ProjectPolicyContextMode;
  readonly contextBudget: number;
  /** Renderer-local source toggles shared with the Context Workbench. */
  readonly includeMemories: boolean;
  readonly includeSkills: boolean;
  readonly compactionMode: ProjectPolicyCompactionMode;
  readonly compactionThreshold: number;
  readonly compactionTokenThreshold: number | null;
  readonly compactionCostThresholdMicrounits: number | null;
  readonly compactionLatencyThresholdMs: number | null;
  readonly localCacheMode: ProjectPolicyLocalCacheMode;
  readonly localCacheTtlHours: number;
  readonly cacheHandoffMode: ProjectPolicyCacheHandoffMode;
  readonly cacheKeyStrategy: ProjectPolicyCacheKeyStrategy;
  readonly invalidateOnSourceChange: boolean;
  readonly localCacheDisplayFilter: CacheInventoryDisplayFilter;
  readonly detailsOpen: boolean;
}

export interface ProjectPolicySummaryProps {
  readonly projectName: string;
  readonly providers: readonly ProviderView[];
  readonly initialMainModelProfileId: string;
  readonly contextAvailability: ProjectContextAvailability;
  readonly contextSourceCount: number;
  readonly contextSelectedCount: number;
  readonly contextEstimatedTokens: number | null;
  readonly contextMemoryCount?: number;
  readonly contextSkillCount?: number;
  /** Optional host-owned renderer history so tab switches do not discard the draft. */
  readonly initialHistory?: ProjectPolicyHistory | undefined;
  readonly onHistoryChange?: (history: ProjectPolicyHistory) => void;
}

const CONTEXT_MODE_LABELS: Record<ProjectPolicyContextMode, string> = {
  auto: "Auto",
  partial: "Partial",
  full: "Full",
  "summary-plus-sources": "Summary + sources",
  "manifest-only": "Manifest only",
  "retrieval-on-demand": "Retrieval on demand",
  fresh: "Fresh snapshot",
  "forked-snapshot": "Forked snapshot",
};

const COMPACTION_MODE_LABELS: Record<ProjectPolicyCompactionMode, string> = {
  disabled: "Disabled",
  manual: "Manual",
  "prompt-triggered": "Prompt-triggered",
  threshold: "Threshold",
  predictive: "Predictive",
  auto: "Auto",
};

const CACHE_MODE_LABELS: Record<ProjectPolicyLocalCacheMode, string> = {
  disabled: "Disabled",
  "safe-reuse": "Reuse safe artifacts",
  "aggressive-reuse": "Aggressive reuse",
};

const CACHE_HANDOFF_LABELS: Record<ProjectPolicyCacheHandoffMode, string> = {
  "local-only": "Local only",
  "provider-hint-when-supported": "Provider hint when supported",
  hybrid: "Hybrid",
};

const CACHE_KEY_LABELS: Record<ProjectPolicyCacheKeyStrategy, string> = {
  "content-hash": "Content hash",
  "source-revision": "Source revision",
  "request-scoped": "Request scoped",
};

const DEFAULT_POLICY: Omit<ProjectPolicyDraft, "mainModelProfileId"> = {
  subagentModelProfileId: "auto",
  autoStrategy: "deterministic",
  contextMode: "auto",
  subagentContextMode: "partial",
  contextBudget: 3200,
  includeMemories: true,
  includeSkills: true,
  compactionMode: "threshold",
  compactionThreshold: 78,
  compactionTokenThreshold: null,
  compactionCostThresholdMicrounits: null,
  compactionLatencyThresholdMs: null,
  localCacheMode: "safe-reuse",
  localCacheTtlHours: 24,
  cacheHandoffMode: "local-only",
  cacheKeyStrategy: "content-hash",
  invalidateOnSourceChange: true,
  localCacheDisplayFilter: "all",
  detailsOpen: false,
};

function makeDefaultPolicy(mainModelProfileId: string): ProjectPolicyDraft {
  return { ...DEFAULT_POLICY, mainModelProfileId: mainModelProfileId || "auto" };
}

export function makeDefaultProjectPolicyHistory(mainModelProfileId: string): ProjectPolicyHistory {
  return {
    past: [],
    present: makeDefaultPolicy(mainModelProfileId),
    future: [],
    coalescedKey: null,
  };
}

function normalizePolicy(policy: Partial<ProjectPolicyDraft>, fallbackMainModelProfileId = "auto"): ProjectPolicyDraft {
  return {
    ...makeDefaultPolicy(fallbackMainModelProfileId),
    ...policy,
    mainModelProfileId: policy.mainModelProfileId || fallbackMainModelProfileId || "auto",
    subagentContextMode: policy.subagentContextMode ?? "partial",
    cacheHandoffMode: policy.cacheHandoffMode ?? "local-only",
    cacheKeyStrategy: policy.cacheKeyStrategy ?? "content-hash",
    localCacheDisplayFilter: policy.localCacheDisplayFilter ?? "all",
    includeMemories: policy.includeMemories ?? true,
    includeSkills: policy.includeSkills ?? true,
  };
}

function clonePolicy(policy: ProjectPolicyDraft): ProjectPolicyDraft {
  return normalizePolicy(policy);
}

export type ProjectPolicyHistory = {
  past: ProjectPolicyDraft[];
  present: ProjectPolicyDraft;
  future: ProjectPolicyDraft[];
  /** The active range gesture, kept in state so the updater stays pure. */
  coalescedKey: string | null;
};

function cloneHistory(history: ProjectPolicyHistory): ProjectPolicyHistory {
  return {
    past: history.past.map(clonePolicy),
    present: clonePolicy(history.present),
    future: history.future.map(clonePolicy),
    coalescedKey: history.coalescedKey,
  };
}

/**
 * Apply a context/policy patch from a host-owned renderer control.
 *
 * This keeps Context Workbench edits in the same reversible history as the
 * Snapshot policy controls. It is intentionally renderer-local; no native
 * policy or provider route is changed here.
 */
export function applyProjectPolicyHistoryPatch(
  history: ProjectPolicyHistory,
  patch: Partial<ProjectPolicyDraft>,
  coalescedKey: string | null = null,
): ProjectPolicyHistory {
  const current = cloneHistory(history);
  const next = normalizePolicy({ ...current.present, ...patch }, current.present.mainModelProfileId);
  if (Object.keys(patch).every((key) => current.present[key as keyof ProjectPolicyDraft] === next[key as keyof ProjectPolicyDraft])) return history;
  const coalesce = Boolean(coalescedKey && current.coalescedKey === coalescedKey);
  return {
    past: coalesce ? current.past : [...current.past, clonePolicy(current.present)],
    present: next,
    future: [],
    coalescedKey,
  };
}

function modelLabel(profiles: ReturnType<typeof selectableModelProfiles>, profileId: string): string {
  if (profileId === "auto") return "Automatic route";
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return profile ? `${profile.displayName} · ${profile.providerName}` : "Unknown profile";
}

function modelCatalogLabel(
  profiles: ReturnType<typeof selectableModelProfiles>,
  providers: readonly ProviderView[],
  profileId: string,
): string {
  if (profileId === "auto") return "Preview routing policy";
  const profile = profiles.find((candidate) => candidate.id === profileId);
  const provider = profile?.connectionId ? providers.find((candidate) => candidate.id === profile.connectionId) : undefined;
  if (provider?.source === "demo") return "Demo catalog · renderer only";
  if (provider?.source === "preview") return "Preview catalog · renderer only";
  if (provider?.source === "native") return "Native catalog metadata · no route write";
  return "Catalog provenance unavailable";
}

export type ProjectRouteEvidenceState = "candidate" | "preview" | "unknown" | "unavailable";

export interface ProjectRouteEvidence {
  readonly profileId: string;
  readonly modelLabel: string;
  readonly providerLabel: string;
  readonly sourceLabel: string;
  readonly contextLabel: string;
  readonly capabilitiesLabel: string;
  readonly state: ProjectRouteEvidenceState;
  readonly stateLabel: string;
  readonly detail: string;
}

/**
 * Builds a small, truthful route receipt for the policy summary. It is
 * deliberately metadata-only: even a connected native provider is reported
 * as a candidate because this renderer surface never dispatches a request or
 * persists a route decision.
 */
export function buildProjectRouteEvidence(
  profiles: ReturnType<typeof selectableModelProfiles>,
  providers: readonly ProviderView[],
  profileId: string,
): ProjectRouteEvidence {
  const requestedAuto = profileId === "auto";
  const profile = requestedAuto ? resolveAutoModel([...providers]) : profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    return {
      profileId,
      modelLabel: requestedAuto ? "No connected candidate" : `Unavailable profile · ${profileId}`,
      providerLabel: "Provider metadata unavailable",
      sourceLabel: requestedAuto ? "Automatic route · unresolved" : "Catalog entry unavailable",
      contextLabel: "Context not reported",
      capabilitiesLabel: "No capabilities declared",
      state: requestedAuto ? "unknown" : "unavailable",
      stateLabel: requestedAuto ? "Unknown" : "Unavailable",
      detail: requestedAuto
        ? "Auto remains unresolved because no connected, available provider model is visible in this renderer catalog."
        : "The selected profile is not present in the current provider catalog snapshot.",
    };
  }

  const provider = profile.connectionId
    ? providers.find((candidate) => candidate.id === profile.connectionId)
    : undefined;
  const nativeCandidate = provider?.source === "native" && provider.state === "connected";
  const previewCatalog = provider?.source === "demo" || provider?.source === "preview";
  const unavailable = provider?.state === "error" || provider?.state === "not-configured" || profile.status === "unavailable";
  const state: ProjectRouteEvidenceState = nativeCandidate
    ? "candidate"
    : previewCatalog
      ? "preview"
      : unavailable
        ? "unavailable"
        : "unknown";
  const stateLabel = state === "candidate"
    ? "Candidate"
    : state === "preview"
      ? "Preview catalog"
      : state === "unavailable"
        ? "Unavailable"
        : "Unknown";
  const providerLabel = provider?.name ?? profile.providerName;
  const sourceLabel = requestedAuto
    ? `Automatic candidate · ${provider?.source === "native" ? "native metadata" : provider?.source === "demo" ? "demo catalog" : provider?.source === "preview" ? "configuration preview" : "source unknown"}`
    : modelCatalogLabel(profiles, providers, profile.id);
  const capabilitiesLabel = profile.capabilities.length > 0
    ? profile.capabilities.join(" · ")
    : "No capabilities declared";
  const providerState = provider ? providerStateLabel(provider) : "provider state not hydrated";
  const detail = state === "candidate"
    ? "Connected native metadata makes this an eligible candidate; route selection and dispatch remain unverified."
    : state === "preview"
      ? "This catalog entry is useful for rehearsal only; no provider request or billing result is available."
      : state === "unavailable"
        ? `The visible provider/model state is not ready (${providerState}); keep this route out of native dispatch until revalidated.`
        : `Route evidence is incomplete (${providerState}); the renderer will not treat it as a successful provider route.`;

  return {
    profileId,
    modelLabel: profile.displayName,
    providerLabel,
    sourceLabel,
    contextLabel: profile.contextLabel,
    capabilitiesLabel,
    state,
    stateLabel,
    detail,
  };
}

function contextPolicyDetail(
  mode: ProjectPolicyContextMode,
  selectedCount: number,
  sourceCount: number,
  estimatedTokens: number | null,
  budget: number,
  availability: ProjectContextAvailability,
): string {
  const estimate = buildContextEstimate({ estimatedTokens, projectHealth: availability.health });
  const detail = estimate.tokens === null
    ? estimate.status === "withheld"
      ? "token estimate withheld · context is blocked"
      : "token estimate unavailable"
    : `~${estimate.tokens.toLocaleString()} / ${budget.toLocaleString()} tokens · ${estimate.tokens <= budget ? "within preview budget" : "over preview budget"}`;
  return `${CONTEXT_MODE_LABELS[mode]} · ${selectedCount}/${sourceCount} referenced folders · ${detail}${estimate.tokens === null ? "" : " · renderer estimate, not tokenizer output"}`;
}

const POLICY_EXPORT_BOUNDARY = [
  "This export contains renderer-session policy metadata only.",
  "No native route, context, compaction or cache policy was written.",
  "No provider request, billing assertion or adaptive model training was performed.",
  "Credential bytes, raw prompt/response bodies, cookies, file bytes and local paths are excluded.",
] as const;

function markdownInline(value: string): string {
  return value.replace(/`/g, "\\`").replace(/\r?\n/g, " ").trim();
}

function parseOptionalIntegerThreshold(value: string, minimum: number): number | null | undefined {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined;
}

export function serializeProjectPolicyPreview(
  projectName: string,
  policy: ProjectPolicyDraft,
  profiles: ReturnType<typeof selectableModelProfiles>,
  contextAvailability: ProjectContextAvailability,
  contextEstimatedTokens: number | null = null,
  contextMemoryCount = 0,
  contextSkillCount = 0,
  providers: readonly ProviderView[] = [],
): string {
  const estimate = buildContextEstimate({ estimatedTokens: contextEstimatedTokens, projectHealth: contextAvailability.health });
  const mainRoute = buildProjectRouteEvidence(profiles, providers, policy.mainModelProfileId);
  const subagentRoute = buildProjectRouteEvidence(profiles, providers, policy.subagentModelProfileId);
  const autoRoute = buildProjectRouteEvidence(profiles, providers, "auto");
  const payload = {
    schema: "omnia.project-policy-preview.v1",
    scope: "renderer-session",
    projectName,
    route: {
      main: { profileId: policy.mainModelProfileId, label: modelLabel(profiles, policy.mainModelProfileId) },
      subagent: { profileId: policy.subagentModelProfileId, label: modelLabel(profiles, policy.subagentModelProfileId) },
      autoStrategy: policy.autoStrategy,
      evidence: {
        main: mainRoute,
        subagent: subagentRoute,
        autoCandidate: autoRoute,
      },
    },
    context: {
      mode: policy.contextMode,
      mainMode: policy.contextMode,
      subagentMode: policy.subagentContextMode,
      budgetTokens: policy.contextBudget,
      referencedFolders: { selected: contextAvailability.folders.referenced, total: contextAvailability.folders.total },
      sources: {
        memories: { included: policy.includeMemories, available: contextMemoryCount },
        skills: { included: policy.includeSkills, available: contextSkillCount },
      },
      estimatedInputTokens: estimate.tokens,
      estimate: {
        status: estimate.status,
        source: estimate.status === "heuristic" ? "renderer-heuristic-not-tokenizer" : "not-available-in-renderer-preview",
        reason: estimate.status === "withheld"
          ? "withheld-because-context-is-blocked"
          : estimate.status === "unknown"
            ? "no-estimate-was-provided"
            : "not-a-provider-tokenizer-result",
      },
      compaction: {
        mode: policy.compactionMode,
        tokenThreshold: policy.compactionTokenThreshold,
        contextPercentageThreshold: policy.compactionThreshold / 100,
        costThresholdMicrounits: policy.compactionCostThresholdMicrounits,
        latencyThresholdMs: policy.compactionLatencyThresholdMs,
      },
      availability: contextAvailability.label,
    },
    cache: {
      localReuse: {
        mode: policy.localCacheMode,
        ttlHours: policy.localCacheTtlHours,
        handoffMode: policy.cacheHandoffMode,
        keyStrategy: policy.cacheKeyStrategy,
        invalidateOnSourceChange: policy.invalidateOnSourceChange,
        displayFilter: policy.localCacheDisplayFilter,
      },
      providerReported: {
        status: "unknown",
        reason: "not-inspected-by-policy-draft",
      },
    },
    boundary: POLICY_EXPORT_BOUNDARY,
  } as const;
  return JSON.stringify(payload, null, 2);
}

export function serializeProjectPolicyMarkdown(
  projectName: string,
  policy: ProjectPolicyDraft,
  profiles: ReturnType<typeof selectableModelProfiles>,
  contextAvailability: ProjectContextAvailability,
  contextEstimatedTokens: number | null = null,
  contextMemoryCount = 0,
  contextSkillCount = 0,
  providers: readonly ProviderView[] = [],
): string {
  const estimate = buildContextEstimate({ estimatedTokens: contextEstimatedTokens, projectHealth: contextAvailability.health });
  const mainRoute = buildProjectRouteEvidence(profiles, providers, policy.mainModelProfileId);
  const subagentRoute = buildProjectRouteEvidence(profiles, providers, policy.subagentModelProfileId);
  const autoRoute = buildProjectRouteEvidence(profiles, providers, "auto");
  const contextEstimate = estimate.tokens === null
    ? estimate.status === "withheld"
      ? "Unknown — withheld because context is blocked"
      : "Unknown — no estimate was provided"
    : `~${estimate.tokens.toLocaleString()} / ${policy.contextBudget.toLocaleString()} tokens (renderer heuristic)`;
  return [
    "# Omnia project policy preview",
    "",
    "- Scope: `renderer-session`",
    `- Project: \`${markdownInline(projectName)}\``,
    "",
    "## Route",
    `- Main-agent: ${markdownInline(modelLabel(profiles, policy.mainModelProfileId))}`,
    `- Subagent: ${markdownInline(modelLabel(profiles, policy.subagentModelProfileId))}`,
    `- Auto strategy: \`${policy.autoStrategy}\` (illustrative renderer preview)`,
    `- Main route evidence: ${markdownInline(mainRoute.stateLabel)} · ${markdownInline(mainRoute.modelLabel)} · ${markdownInline(mainRoute.sourceLabel)}`,
    `- Subagent route evidence: ${markdownInline(subagentRoute.stateLabel)} · ${markdownInline(subagentRoute.modelLabel)} · ${markdownInline(subagentRoute.sourceLabel)}`,
    `- Auto candidate: ${markdownInline(autoRoute.stateLabel)} · ${markdownInline(autoRoute.modelLabel)} · ${markdownInline(autoRoute.sourceLabel)}`,
    "",
    "## Context delivery",
    `- Mode: ${CONTEXT_MODE_LABELS[policy.contextMode]}`,
    `- Subagent mode: ${CONTEXT_MODE_LABELS[policy.subagentContextMode]}`,
    `- Referenced folders: ${contextAvailability.folders.referenced}/${contextAvailability.folders.total}`,
    `- Include active memories: ${policy.includeMemories ? "yes" : "no"} (${contextMemoryCount} available)`,
    `- Include enabled skills: ${policy.includeSkills ? "yes" : "no"} (${contextSkillCount} available)`,
    `- Input budget: ${policy.contextBudget.toLocaleString()} tokens`,
    `- Estimated input: ${contextEstimate}`,
    `- Compaction: ${COMPACTION_MODE_LABELS[policy.compactionMode]}; context at ${policy.compactionThreshold}%; token threshold ${policy.compactionTokenThreshold === null ? "not set" : `${policy.compactionTokenThreshold.toLocaleString()} tokens`}; cost threshold ${policy.compactionCostThresholdMicrounits === null ? "not set" : `${policy.compactionCostThresholdMicrounits.toLocaleString()} microunits`}; latency threshold ${policy.compactionLatencyThresholdMs === null ? "not set" : `${policy.compactionLatencyThresholdMs.toLocaleString()} ms`}`,
    `- Availability: ${markdownInline(contextAvailability.label)}`,
    "",
    "## Local reuse",
    `- Mode: ${CACHE_MODE_LABELS[policy.localCacheMode]}`,
    `- Retention: ${policy.localCacheTtlHours} hour${policy.localCacheTtlHours === 1 ? "" : "s"}`,
    `- Cache handoff rehearsal: ${CACHE_HANDOFF_LABELS[policy.cacheHandoffMode]}`,
    `- Cache key strategy: ${CACHE_KEY_LABELS[policy.cacheKeyStrategy]}`,
    `- Invalidate on source-context change: ${policy.invalidateOnSourceChange ? "yes" : "no"}`,
    `- Inventory display: ${policy.localCacheDisplayFilter} (renderer-only; does not alter cache objects)`,
    "- Provider-reported cache: Unknown — not inspected by this draft",
    "",
    "## Boundary",
    ...POLICY_EXPORT_BOUNDARY.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function downloadPolicy(payload: string, format: ProjectPolicyExportFormat): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const isJson = format === "json";
  const url = URL.createObjectURL(new Blob([payload], { type: isJson ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-policy-preview.${isJson ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ProjectPolicySummary({
  projectName,
  providers,
  initialMainModelProfileId,
  contextAvailability,
  contextSourceCount,
  contextSelectedCount,
  contextEstimatedTokens,
  contextMemoryCount = 0,
  contextSkillCount = 0,
  initialHistory,
  onHistoryChange,
}: ProjectPolicySummaryProps) {
  const profiles = useMemo(() => selectableModelProfiles([...providers]), [providers]);
  const [history, setHistory] = useState<ProjectPolicyHistory>(() => ({
    ...(initialHistory ? cloneHistory(initialHistory) : makeDefaultProjectPolicyHistory(initialMainModelProfileId)),
  }));
  // Keep the host-owned project history and this summary's local draft in a
  // two-way sync without echoing a stale local value back to the host while an
  // externally supplied history is still being adopted. Local event handlers
  // mark their next value so the adoption effect can distinguish that case.
  const pendingLocalHistoryRef = useRef<ProjectPolicyHistory | null>(null);
  const syncingIncomingHistoryRef = useRef(false);
  const [status, setStatus] = useState("Policy choices stay in this renderer preview.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ProjectPolicyExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Export contains policy metadata only; credential bytes and native receipts are excluded.");
  const policy = history.present;

  // Context and cache controls elsewhere in the Deck can update the same
  // project-scoped history. Adopt that exact object so Undo/Redo and exports
  // observe the shared draft without a clone-and-notify feedback loop.
  useEffect(() => {
    if (!initialHistory || history === initialHistory || pendingLocalHistoryRef.current === history) return;
    syncingIncomingHistoryRef.current = true;
    setHistory(initialHistory);
  }, [history, initialHistory]);

  useEffect(() => {
    if (pendingLocalHistoryRef.current === history) {
      pendingLocalHistoryRef.current = null;
      onHistoryChange?.(history);
      return;
    }
    if (syncingIncomingHistoryRef.current) {
      syncingIncomingHistoryRef.current = false;
      return;
    }
    onHistoryChange?.(history);
  }, [history, onHistoryChange]);

  const commit = (patch: Partial<ProjectPolicyDraft>, message: string, coalesceKey?: string) => {
    const next = { ...history.present, ...patch };
    if (Object.keys(patch).every((key) => history.present[key as keyof ProjectPolicyDraft] === next[key as keyof ProjectPolicyDraft])) return;
    const coalesce = Boolean(coalesceKey && history.coalescedKey === coalesceKey);
    const nextHistory: ProjectPolicyHistory = {
      past: coalesce ? history.past : [...history.past, clonePolicy(history.present)],
      present: next,
      future: [],
      coalescedKey: coalesceKey ?? null,
    };
    pendingLocalHistoryRef.current = nextHistory;
    setHistory(nextHistory);
    setStatus(message);
  };

  const undo = () => {
    const previous = history.past.at(-1);
    if (!previous) return;
    const nextHistory: ProjectPolicyHistory = { past: history.past.slice(0, -1), present: clonePolicy(previous), future: [clonePolicy(history.present), ...history.future], coalescedKey: null };
    pendingLocalHistoryRef.current = nextHistory;
    setHistory(nextHistory);
    setStatus("Undid the last Project policy preview change.");
  };

  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    const nextHistory: ProjectPolicyHistory = { past: [...history.past, clonePolicy(history.present)], present: clonePolicy(next), future: history.future.slice(1), coalescedKey: null };
    pendingLocalHistoryRef.current = nextHistory;
    setHistory(nextHistory);
    setStatus("Reapplied the next Project policy preview change.");
  };

  const reset = () => {
    const defaults = makeDefaultPolicy(initialMainModelProfileId);
    if (Object.keys(defaults).every((key) => history.present[key as keyof ProjectPolicyDraft] === defaults[key as keyof ProjectPolicyDraft])) return;
    const nextHistory: ProjectPolicyHistory = { past: [...history.past, clonePolicy(history.present)], present: defaults, future: [], coalescedKey: null };
    pendingLocalHistoryRef.current = nextHistory;
    setHistory(nextHistory);
    setStatus("Project policy preview reset to defaults.");
  };

  const clearCoalescing = () => {
    if (history.coalescedKey === null) return;
    const nextHistory = { ...history, coalescedKey: null };
    pendingLocalHistoryRef.current = nextHistory;
    setHistory(nextHistory);
  };

  const jsonPayload = useMemo(
    () => serializeProjectPolicyPreview(projectName, policy, profiles, contextAvailability, contextEstimatedTokens, contextMemoryCount, contextSkillCount, providers),
    [contextAvailability, contextEstimatedTokens, contextMemoryCount, contextSkillCount, policy, profiles, projectName, providers],
  );
  const markdownPayload = useMemo(
    () => serializeProjectPolicyMarkdown(projectName, policy, profiles, contextAvailability, contextEstimatedTokens, contextMemoryCount, contextSkillCount, providers),
    [contextAvailability, contextEstimatedTokens, contextMemoryCount, contextSkillCount, policy, profiles, projectName, providers],
  );
  const exportPayload = exportFormat === "json" ? jsonPayload : markdownPayload;
  const exportLabel = exportFormat === "json" ? "JSON" : "Markdown";

  const copyExport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportStatus("Clipboard unavailable; no policy was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied the renderer-local policy ${exportLabel} preview.`);
    } catch {
      setExportStatus("Clipboard access was denied; nothing was copied.");
    }
  };

  const mainLabel = modelLabel(profiles, policy.mainModelProfileId);
  const subagentLabel = modelLabel(profiles, policy.subagentModelProfileId);
  const mainCatalogLabel = modelCatalogLabel(profiles, providers, policy.mainModelProfileId);
  const subagentCatalogLabel = modelCatalogLabel(profiles, providers, policy.subagentModelProfileId);
  const routeEvidence = [
    { slot: "Main agent", evidence: buildProjectRouteEvidence(profiles, providers, policy.mainModelProfileId) },
    { slot: "Subagent", evidence: buildProjectRouteEvidence(profiles, providers, policy.subagentModelProfileId) },
    { slot: "Auto candidate", evidence: buildProjectRouteEvidence(profiles, providers, "auto") },
  ] as const;
  const contextDetail = contextPolicyDetail(policy.contextMode, contextSelectedCount, contextSourceCount, contextEstimatedTokens, policy.contextBudget, contextAvailability);
  const subagentContextDetail = contextPolicyDetail(policy.subagentContextMode, contextSelectedCount, contextSourceCount, contextEstimatedTokens, policy.contextBudget, contextAvailability);

  return (
    <section className="project-policy-summary" aria-labelledby="project-policy-summary-title">
      <header className="project-policy-summary__header">
        <div>
          <span className="eyebrow"><Sparkles size={12} aria-hidden="true" /> Policy summary</span>
          <h3 id="project-policy-summary-title">Shape the next run without touching native state</h3>
          <p>Separate main-agent and subagent routing, context delivery, compaction, and user-side reuse policy in one reversible draft.</p>
        </div>
        <span className="project-policy-summary__badge"><ShieldCheck size={12} aria-hidden="true" /> Renderer-local</span>
      </header>

      <div className="project-policy-summary__history" role="toolbar" aria-label="Project policy preview history">
        <span><strong>Reversible policy draft</strong><small>{status}</small></span>
        <span className="project-policy-summary__steps">{history.past.length + history.future.length} steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo Project policy preview change" title="Undo Project policy preview change"><Undo2 size={12} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo Project policy preview change" title="Redo Project policy preview change"><Redo2 size={12} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset Project policy preview" title="Reset Project policy preview to defaults"><RotateCcw size={12} /> Reset</button>
      </div>

      <div className="project-policy-summary__route-grid">
        <label className="project-policy-summary__field"><span><Bot size={13} /> Main-agent model</span><select aria-label="Main-agent model preview" value={policy.mainModelProfileId} onChange={(event) => commit({ mainModelProfileId: event.target.value }, "Main-agent model changed in the renderer preview.")}>{!profiles.some((profile) => profile.id === policy.mainModelProfileId) ? <option value={policy.mainModelProfileId}>Unavailable profile · {policy.mainModelProfileId}</option> : null}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.providerName}</option>)}</select><small>{mainLabel} · {mainCatalogLabel} · project run owner</small></label>
        <label className="project-policy-summary__field"><span><Bot size={13} /> Subagent model</span><select aria-label="Subagent model preview" value={policy.subagentModelProfileId} onChange={(event) => commit({ subagentModelProfileId: event.target.value }, "Subagent model changed in the renderer preview.")}>{!profiles.some((profile) => profile.id === policy.subagentModelProfileId) ? <option value={policy.subagentModelProfileId}>Unavailable profile · {policy.subagentModelProfileId}</option> : null}{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.providerName}</option>)}</select><small>{subagentLabel} · {subagentCatalogLabel} · child route preview, no spawn</small></label>
        <label className="project-policy-summary__field"><span><Gauge size={13} /> Auto strategy</span><select aria-label="Auto strategy preview" value={policy.autoStrategy} onChange={(event) => commit({ autoStrategy: event.target.value as ProjectPolicyAutoStrategy }, "Auto strategy changed in the renderer preview.")}><option value="deterministic">Deterministic rules · renderer preview</option><option value="adaptive-shadow" disabled>Adaptive shadow · planned</option><option value="learned-promotion" disabled>Learned promotion · planned</option></select><small>Auto remains illustrative until evaluated policy data is wired; no native route is selected.</small></label>
      </div>

      <section className="project-policy-summary__route-evidence" aria-labelledby="project-policy-route-evidence-title">
        <div className="project-policy-summary__route-evidence-heading">
          <span><Route size={13} /> Route evidence</span>
          <em>metadata only</em>
        </div>
        <div className="project-policy-summary__route-evidence-grid">
          {routeEvidence.map(({ slot, evidence }) => (
            <article className={`project-policy-summary__route-evidence-card project-policy-summary__route-evidence-card--${evidence.state}`} key={slot}>
              <div className="project-policy-summary__route-evidence-card-heading">
                <span>{slot}</span>
                <em>{evidence.stateLabel}</em>
              </div>
              <strong>{evidence.modelLabel}</strong>
              <small>{evidence.providerLabel} · {evidence.contextLabel}</small>
              <small>{evidence.capabilitiesLabel}</small>
              <p>{evidence.detail}</p>
            </article>
          ))}
        </div>
        <p className="project-policy-summary__route-evidence-boundary"><ShieldCheck size={12} /> A candidate or preview label is not a dispatch receipt. This panel does not call a provider, reserve quota, grant permissions, or persist a route.</p>
      </section>

      <div className="project-policy-summary__section-grid">
        <article className="project-policy-summary__card">
          <div className="project-policy-summary__card-heading"><span><Layers3 size={14} /> Context delivery</span><em>{CONTEXT_MODE_LABELS[policy.contextMode]}</em></div>
          <label className="project-policy-summary__field"><span>Main-agent delivery</span><select aria-label="Context delivery mode preview" value={policy.contextMode} onChange={(event) => commit({ contextMode: event.target.value as ProjectPolicyContextMode }, "Main-agent context delivery mode changed in the renderer preview.")}>{Object.entries(CONTEXT_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="project-policy-summary__field"><span>Subagent delivery</span><select aria-label="Subagent context delivery mode preview" value={policy.subagentContextMode} onChange={(event) => commit({ subagentContextMode: event.target.value as ProjectPolicyContextMode }, "Subagent context delivery mode changed in the renderer preview.")}>{Object.entries(CONTEXT_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="project-policy-summary__range"><span>Input budget <output>{policy.contextBudget.toLocaleString()} tokens</output></span><input aria-label="Context input budget preview" type="range" min="800" max="12000" step="200" value={policy.contextBudget} onChange={(event) => commit({ contextBudget: Number(event.target.value) }, "Context budget changed in the renderer preview.", "context-budget")} onPointerUp={clearCoalescing} onKeyUp={clearCoalescing} onBlur={clearCoalescing} /></label>
          <label className="project-policy-summary__check"><input aria-label="Include active memories in context preview" type="checkbox" checked={policy.includeMemories} onChange={(event) => commit({ includeMemories: event.target.checked }, "Active memory inclusion changed in the renderer preview.")} /> Include active memories <small>({contextMemoryCount} available)</small></label>
          <label className="project-policy-summary__check"><input aria-label="Include enabled skills in context preview" type="checkbox" checked={policy.includeSkills} onChange={(event) => commit({ includeSkills: event.target.checked }, "Enabled skill inclusion changed in the renderer preview.")} /> Include enabled skills <small>({contextSkillCount} available)</small></label>
          <small className="project-policy-summary__detail">Main: {contextDetail}</small>
          <small className="project-policy-summary__detail">Subagent: {subagentContextDetail}</small>
        </article>

        <article className="project-policy-summary__card">
          <div className="project-policy-summary__card-heading"><span><RotateCcw size={14} /> Compaction policy</span><em>{COMPACTION_MODE_LABELS[policy.compactionMode]}</em></div>
          <label className="project-policy-summary__field"><span>Trigger</span><select aria-label="Compaction trigger preview" value={policy.compactionMode} onChange={(event) => commit({ compactionMode: event.target.value as ProjectPolicyCompactionMode }, "Compaction trigger changed in the renderer preview.")}>{Object.entries(COMPACTION_MODE_LABELS).map(([value, label]) => <option key={value} value={value} disabled={value === "predictive" || value === "auto"}>{label}{value === "predictive" || value === "auto" ? " · planned" : ""}</option>)}</select></label>
          <label className="project-policy-summary__range"><span>Threshold <output>{policy.compactionThreshold}%</output></span><input aria-label="Compaction threshold preview" type="range" min="40" max="95" step="1" value={policy.compactionThreshold} disabled={policy.compactionMode === "disabled"} onChange={(event) => commit({ compactionThreshold: Number(event.target.value) }, "Compaction threshold changed in the renderer preview.", "compaction-threshold")} onPointerUp={clearCoalescing} onKeyUp={clearCoalescing} onBlur={clearCoalescing} /></label>
          <div className="project-policy-summary__threshold-grid" aria-label="Additional compaction thresholds">
            <label className="project-policy-summary__field"><span>Token threshold</span><input aria-label="Compaction token threshold preview" type="number" min="1" step="1" inputMode="numeric" placeholder="Not set" value={policy.compactionTokenThreshold ?? ""} disabled={policy.compactionMode === "disabled"} onChange={(event) => { const value = parseOptionalIntegerThreshold(event.target.value, 1); if (value !== undefined) commit({ compactionTokenThreshold: value }, "Compaction token threshold changed in the renderer preview."); }} /></label>
            <label className="project-policy-summary__field"><span>Cost threshold · microunits</span><input aria-label="Compaction cost threshold preview" type="number" min="0" step="1" inputMode="numeric" placeholder="Not set" value={policy.compactionCostThresholdMicrounits ?? ""} disabled={policy.compactionMode === "disabled"} onChange={(event) => { const value = parseOptionalIntegerThreshold(event.target.value, 0); if (value !== undefined) commit({ compactionCostThresholdMicrounits: value }, "Compaction cost threshold changed in the renderer preview."); }} /></label>
            <label className="project-policy-summary__field"><span>Latency threshold · ms</span><input aria-label="Compaction latency threshold preview" type="number" min="0" step="1" inputMode="numeric" placeholder="Not set" value={policy.compactionLatencyThresholdMs ?? ""} disabled={policy.compactionMode === "disabled"} onChange={(event) => { const value = parseOptionalIntegerThreshold(event.target.value, 0); if (value !== undefined) commit({ compactionLatencyThresholdMs: value }, "Compaction latency threshold changed in the renderer preview."); }} /></label>
          </div>
          <small className="project-policy-summary__detail">{policy.compactionMode === "disabled" ? "Threshold is ignored while compaction is disabled. Additional limits are ignored too." : "Unset limits remain null. Compaction is only a renderer draft; no trigger runs and raw history is unchanged."}</small>
        </article>

        <article className="project-policy-summary__card">
          <div className="project-policy-summary__card-heading"><span><Database size={14} /> User-side cache</span><em>{CACHE_MODE_LABELS[policy.localCacheMode]}</em></div>
          <label className="project-policy-summary__field"><span>Reuse policy</span><select aria-label="User-side cache reuse policy preview" value={policy.localCacheMode} onChange={(event) => commit({ localCacheMode: event.target.value as ProjectPolicyLocalCacheMode }, "User-side cache policy changed in the renderer preview.")}>{Object.entries(CACHE_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="project-policy-summary__field"><span>Retention window</span><select aria-label="User-side cache retention preview" value={policy.localCacheTtlHours} onChange={(event) => commit({ localCacheTtlHours: Number(event.target.value) }, "User-side cache retention changed in the renderer preview.")}><option value="1">1 hour</option><option value="6">6 hours</option><option value="24">24 hours</option><option value="168">7 days</option></select></label>
          <label className="project-policy-summary__field"><span>Cache handoff rehearsal</span><select aria-label="Cache handoff rehearsal preview" value={policy.cacheHandoffMode} onChange={(event) => commit({ cacheHandoffMode: event.target.value as ProjectPolicyCacheHandoffMode }, "Cache handoff rehearsal changed in the renderer preview.")}>{Object.entries(CACHE_HANDOFF_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="project-policy-summary__field"><span>Cache key strategy</span><select aria-label="Cache key strategy preview" value={policy.cacheKeyStrategy} onChange={(event) => commit({ cacheKeyStrategy: event.target.value as ProjectPolicyCacheKeyStrategy }, "Cache key strategy changed in the renderer preview.")}>{Object.entries(CACHE_KEY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="project-policy-summary__check"><input type="checkbox" checked={policy.invalidateOnSourceChange} onChange={(event) => commit({ invalidateOnSourceChange: event.target.checked }, "Cache invalidation policy changed in the renderer preview.")} /> Invalidate when source context changes</label>
          <small className="project-policy-summary__detail">Inventory view: {policy.localCacheDisplayFilter}. Filter objects in the cache planner below; its display selection shares this draft's Undo/Redo history.</small>
          <small className="project-policy-summary__detail">Local reuse and cache-key choices are draft metadata. Provider cache status is unknown here; selecting a handoff rehearsal does not send a provider hint or prove cache billing.</small>
        </article>
      </div>

      <button type="button" className="project-policy-summary__details-toggle" aria-expanded={policy.detailsOpen} onClick={() => commit({ detailsOpen: !policy.detailsOpen }, policy.detailsOpen ? "Policy evidence details collapsed." : "Policy evidence details expanded.")}><span><CircleAlert size={13} /> Evidence and authority boundary</span><ChevronDown size={14} className={policy.detailsOpen ? "is-open" : ""} /></button>
      {policy.detailsOpen ? <div className="project-policy-summary__evidence" role="status"><div><strong>Context</strong><span>{contextAvailability.label}</span><small>{contextAvailability.reason}</small></div><div><strong>Provider cache</strong><span>Unknown · not inspected by this draft</span><small>This panel does not inspect provider-reported counters; local reuse is not provider cache evidence.</small></div><div><strong>Permissions</strong><span>No authority increase</span><small>Route selection does not grant tools, filesystem, network, agent or compiler authority.</small></div></div> : null}

      <div className="project-policy-summary__export-toolbar" role="toolbar" aria-label="Project policy preview export"><label className="project-policy-summary__format"><span>Format</span><select aria-label="Project policy export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ProjectPolicyExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span className="project-policy-summary__export-status" role="status" aria-live="polite">{exportStatus}</span><button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="project-policy-summary-export"><Download size={13} /> {exportOpen ? `Hide policy ${exportLabel}` : `Inspect policy ${exportLabel}`}</button><button type="button" className="button button--ghost" onClick={() => void copyExport()} aria-label={`Copy renderer-local policy ${exportLabel} to the clipboard`} title={`Copy renderer-local policy ${exportLabel} to the clipboard`}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={() => { setExportStatus(downloadPolicy(exportPayload, exportFormat) ? `Downloaded renderer-local policy ${exportLabel} preview.` : "Download unavailable in this surface; nothing was written."); }} title={`Download renderer-local policy ${exportLabel}`}><Download size={13} /> Download</button></div>
      {exportOpen ? <pre id="project-policy-summary-export" className="project-policy-summary__export" tabIndex={0} aria-label={`Project policy ${exportLabel} preview`}><code>{exportPayload}</code></pre> : null}

      <p className="project-policy-summary__boundary"><ShieldCheck size={13} /> This draft is renderer-session only. It does not persist settings, compile context, spawn agents, call providers, create provider cache, or train/adapt a model.</p>
    </section>
  );
}

export default ProjectPolicySummary;
