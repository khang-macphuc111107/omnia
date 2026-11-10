import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  FileText,
  Filter,
  Link2,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Upload,
  Undo2,
  Redo2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type LedgerTab = "claims" | "sources" | "coverage" | "quality" | "import" | "export";
type SourceKind = "paper" | "documentation" | "dataset" | "conversation" | "web";
type SourceQuality = "primary" | "secondary" | "tertiary";
type SourceFreshness = "current" | "dated" | "unknown";
type ClaimStatus = "supported" | "needs review" | "unresolved" | "contradicts";
type StatementType = "observed" | "inferred" | "planned";
type ExportFormat = "json" | "markdown";

export interface CitationLedgerSource {
  id: string;
  title: string;
  kind: SourceKind;
  locator: string;
  author: string;
  year: string;
  excerpt: string;
  quality: SourceQuality;
  freshness: SourceFreshness;
}

export interface CitationLedgerClaim {
  id: string;
  claim: string;
  section: string;
  sourceIds: string[];
  status: ClaimStatus;
  confidence: number;
  statementType: StatementType;
  note: string;
}

interface LedgerSnapshot {
  claims: CitationLedgerClaim[];
  sources: CitationLedgerSource[];
}

export type CitationQualitySignal = "review-ready" | "source-review" | "claim-review" | "blocked";
export type CitationQualitySort = "priority" | "claim" | "section";

export interface CitationQualityReview {
  claimId: string;
  claim: string;
  section: string;
  signal: CitationQualitySignal;
  linkedSourceCount: number;
  primarySourceCount: number;
  currentSourceCount: number;
  datedSourceCount: number;
  unknownFreshnessCount: number;
  missingSourceCount: number;
  reasons: string[];
}

export interface CitationQualitySummary {
  totalClaims: number;
  reviewReady: number;
  sourceReview: number;
  claimReview: number;
  blocked: number;
  primarySourceLinks: number;
  currentSourceLinks: number;
  datedSourceLinks: number;
  unknownFreshnessLinks: number;
}

const tabs: readonly [LedgerTab, string][] = [
  ["claims", "Claims"],
  ["sources", "Sources"],
  ["coverage", "Coverage"],
  ["quality", "Quality"],
  ["import", "Import"],
  ["export", "Export"],
];

const sourceKindLabels: Record<SourceKind, string> = {
  paper: "Paper",
  documentation: "Documentation",
  dataset: "Dataset",
  conversation: "Conversation",
  web: "Web source",
};

const sourceQualityLabels: Record<SourceQuality, string> = {
  primary: "Primary",
  secondary: "Secondary",
  tertiary: "Tertiary",
};

const sourceFreshnessLabels: Record<SourceFreshness, string> = {
  current: "Current",
  dated: "Dated",
  unknown: "Unknown",
};

const claimStatusLabels: Record<ClaimStatus, string> = {
  supported: "Supported",
  "needs review": "Needs review",
  unresolved: "Unresolved",
  contradicts: "Contradicts",
};

const citationQualitySignalLabels: Record<CitationQualitySignal, string> = {
  "review-ready": "Ready for human check",
  "source-review": "Source review",
  "claim-review": "Claim review",
  blocked: "Blocked",
};

const citationQualityPriority: Record<CitationQualitySignal, number> = {
  blocked: 0,
  "claim-review": 1,
  "source-review": 2,
  "review-ready": 3,
};

const seedSources: CitationLedgerSource[] = [
  {
    id: "source-harness",
    title: "Harness architecture notes",
    kind: "documentation",
    locator: "Omnia design docs · harness/architecture",
    author: "Omnia design group",
    year: "2026",
    excerpt: "Freeze intent, context, route, and idempotency before provider dispatch.",
    quality: "primary",
    freshness: "current",
  },
  {
    id: "source-context",
    title: "Context compiler research",
    kind: "paper",
    locator: "Research collection · context/compiler",
    author: "Research working group",
    year: "2025",
    excerpt: "Selected evidence needs scope, revision, hash, reason, and a visible omission record.",
    quality: "secondary",
    freshness: "current",
  },
  {
    id: "source-memory",
    title: "Local-first memory discussion",
    kind: "conversation",
    locator: "Research notebook · memory review",
    author: "Renderer-local conversation",
    year: "2026",
    excerpt: "Memory proposals should stay reviewable and reversible; inferred facts must not silently become context.",
    quality: "secondary",
    freshness: "unknown",
  },
  {
    id: "source-provider",
    title: "Provider freshness scratchpad",
    kind: "web",
    locator: "Connected source placeholder · not retrieved",
    author: "Not observed",
    year: "—",
    excerpt: "Freshness and live source checks remain planned until an approved connector exists.",
    quality: "tertiary",
    freshness: "unknown",
  },
];

const seedClaims: CitationLedgerClaim[] = [
  {
    id: "claim-provenance",
    claim: "Provenance should survive synthesis and remain inspectable after summarization.",
    section: "Architecture",
    sourceIds: ["source-harness", "source-context"],
    status: "supported",
    confidence: 88,
    statementType: "inferred",
    note: "Keep source identity, revision, and omission reasons visible beside the conclusion.",
  },
  {
    id: "claim-uncertainty",
    claim: "Uncertainty belongs beside the answer instead of being hidden in a footnote.",
    section: "Research quality",
    sourceIds: ["source-memory"],
    status: "needs review",
    confidence: 64,
    statementType: "inferred",
    note: "Attach a direct source span or mark the sentence as an explicit product hypothesis.",
  },
  {
    id: "claim-route",
    claim: "Route choice is part of the evidence a reviewer needs to understand.",
    section: "Provider routing",
    sourceIds: ["source-harness"],
    status: "supported",
    confidence: 81,
    statementType: "observed",
    note: "A future native receipt should connect route, model, context, and policy revision.",
  },
  {
    id: "claim-freshness",
    claim: "A citation can become stale while the original answer remains useful as historical context.",
    section: "Open questions",
    sourceIds: ["source-provider"],
    status: "unresolved",
    confidence: 42,
    statementType: "planned",
    note: "Requires a connector and a frozen retrieval snapshot before this can be treated as evidence.",
  },
];

type LedgerImportResult =
  | { ok: true; snapshot: LedgerSnapshot }
  | { ok: false; error: string };

type ImportConflictPolicy = "keep-local" | "use-imported";
const MAX_LEDGER_IMPORT_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function parseLedgerImport(raw: string): LedgerImportResult {
  if (!raw.trim()) return { ok: false, error: "Paste a ledger JSON package or choose a .json file." };
  if (new Blob([raw]).size > MAX_LEDGER_IMPORT_BYTES) return { ok: false, error: "Ledger JSON exceeds the 64 KB import limit." };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This is not valid JSON. Check the pasted text or export a fresh ledger package." };
  }

  if (!isRecord(value) || value.schema !== "omnia.academic-citation-ledger.preview.v1") {
    return { ok: false, error: "Unsupported package. Import a JSON file exported from Omnia Citation Ledger." };
  }
  if (!Array.isArray(value.claims) || !Array.isArray(value.sources)) {
    return { ok: false, error: "The package needs both claims and sources arrays." };
  }
  if (value.claims.length > 300 || value.sources.length > 300) {
    return { ok: false, error: "Ledger JSON exceeds the 300-record import limit for claims or sources." };
  }

  const sourceKinds: readonly SourceKind[] = ["paper", "documentation", "dataset", "conversation", "web"];
  const sourceQualities: readonly SourceQuality[] = ["primary", "secondary", "tertiary"];
  const sourceFreshness: readonly SourceFreshness[] = ["current", "dated", "unknown"];
  const claimStatuses: readonly ClaimStatus[] = ["supported", "needs review", "unresolved", "contradicts"];
  const statementTypes: readonly StatementType[] = ["observed", "inferred", "planned"];
  const sources: CitationLedgerSource[] = [];
  const sourceIds = new Set<string>();

  for (const [index, candidate] of value.sources.entries()) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id.length > 128
      || typeof candidate.title !== "string" || !candidate.title.trim() || candidate.title.length > 500
      || !isOneOf(candidate.kind, sourceKinds)
      || typeof candidate.locator !== "string" || !candidate.locator.trim() || candidate.locator.length > 2_000
      || typeof candidate.author !== "string" || candidate.author.length > 300
      || typeof candidate.year !== "string" || candidate.year.length > 100
      || typeof candidate.excerpt !== "string" || candidate.excerpt.length > 8_000
      || !isOneOf(candidate.quality, sourceQualities)
      || !isOneOf(candidate.freshness, sourceFreshness)
    ) {
      return { ok: false, error: `Source ${index + 1} is missing valid ledger metadata.` };
    }
    if (sourceIds.has(candidate.id)) return { ok: false, error: `Duplicate source ID: ${candidate.id}` };
    sourceIds.add(candidate.id);
    sources.push({
      id: candidate.id,
      title: candidate.title,
      kind: candidate.kind,
      locator: candidate.locator,
      author: candidate.author,
      year: candidate.year,
      excerpt: candidate.excerpt,
      quality: candidate.quality,
      freshness: candidate.freshness,
    });
  }

  const claims: CitationLedgerClaim[] = [];
  const claimIds = new Set<string>();
  for (const [index, candidate] of value.claims.entries()) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id.length > 128
      || typeof candidate.claim !== "string" || !candidate.claim.trim() || candidate.claim.length > 2_000
      || typeof candidate.section !== "string" || candidate.section.length > 300
      || !Array.isArray(candidate.sourceIds) || candidate.sourceIds.length > 300
      || !candidate.sourceIds.every((id) => typeof id === "string")
      || new Set(candidate.sourceIds).size !== candidate.sourceIds.length
      || !isOneOf(candidate.status, claimStatuses)
      || typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 100
      || !isOneOf(candidate.statementType, statementTypes)
      || typeof candidate.note !== "string" || candidate.note.length > 8_000
    ) {
      return { ok: false, error: `Claim ${index + 1} is missing valid ledger metadata.` };
    }
    if (claimIds.has(candidate.id)) return { ok: false, error: `Duplicate claim ID: ${candidate.id}` };
    claimIds.add(candidate.id);
    if (candidate.sourceIds.some((id) => !sourceIds.has(id))) {
      return { ok: false, error: `Claim “${candidate.claim}” links to a source that is missing from this package.` };
    }
    claims.push({
      id: candidate.id,
      claim: candidate.claim,
      section: candidate.section,
      sourceIds: [...candidate.sourceIds],
      status: candidate.status,
      confidence: candidate.confidence,
      statementType: candidate.statementType,
      note: candidate.note,
    });
  }

  return { ok: true, snapshot: { claims, sources } };
}

function mergeRecords<T extends { id: string }>(current: readonly T[], incoming: readonly T[], policy: ImportConflictPolicy): T[] {
  const merged = [...current];
  for (const record of incoming) {
    const index = merged.findIndex((existing) => existing.id === record.id);
    if (index < 0) merged.push(record);
    else if (policy === "use-imported") merged[index] = record;
  }
  return merged;
}

function cloneClaims(claims: readonly CitationLedgerClaim[]): CitationLedgerClaim[] {
  return claims.map((claim) => ({ ...claim, sourceIds: [...claim.sourceIds] }));
}

function statusIcon(status: ClaimStatus) {
  if (status === "supported") return <CheckCircle2 size={14} />;
  if (status === "contradicts") return <XCircle size={14} />;
  if (status === "needs review") return <AlertTriangle size={14} />;
  return <Target size={14} />;
}

function qualitySignalIcon(signal: CitationQualitySignal) {
  if (signal === "review-ready") return <CheckCircle2 size={14} />;
  if (signal === "blocked") return <XCircle size={14} />;
  if (signal === "claim-review") return <Target size={14} />;
  return <AlertTriangle size={14} />;
}

export function buildCitationQualityReview(
  claim: CitationLedgerClaim,
  sources: readonly CitationLedgerSource[],
): CitationQualityReview {
  const linkedSources = claim.sourceIds
    .map((sourceId) => sources.find((source) => source.id === sourceId))
    .filter((source): source is CitationLedgerSource => Boolean(source));
  const missingSourceCount = claim.sourceIds.length - linkedSources.length;
  const primarySourceCount = linkedSources.filter((source) => source.quality === "primary").length;
  const currentSourceCount = linkedSources.filter((source) => source.freshness === "current").length;
  const datedSourceCount = linkedSources.filter((source) => source.freshness === "dated").length;
  const unknownFreshnessCount = linkedSources.filter((source) => source.freshness === "unknown").length;
  const reasons: string[] = [];

  if (missingSourceCount > 0) reasons.push(`${missingSourceCount} linked source record${missingSourceCount === 1 ? " is" : "s are"} missing.`);
  if (claim.sourceIds.length === 0) reasons.push("No source record is linked to this claim.");
  if (claim.status === "contradicts") reasons.push("The claim is marked as contradicting its linked evidence.");
  else if (claim.status === "unresolved") reasons.push("The claim is unresolved and needs a human decision.");
  else if (claim.status === "needs review") reasons.push("The claim status still requires human review.");
  if (datedSourceCount > 0) reasons.push(`${datedSourceCount} linked source${datedSourceCount === 1 ? " is" : "s are"} dated.`);
  if (unknownFreshnessCount > 0) reasons.push(`${unknownFreshnessCount} linked source freshness value${unknownFreshnessCount === 1 ? " is" : "s are"} unknown.`);
  if (linkedSources.some((source) => source.quality === "tertiary")) reasons.push("At least one linked source is marked tertiary.");

  let signal: CitationQualitySignal = "review-ready";
  if (missingSourceCount > 0 || claim.sourceIds.length === 0) signal = "blocked";
  else if (claim.status !== "supported") signal = "claim-review";
  else if (datedSourceCount > 0 || unknownFreshnessCount > 0 || linkedSources.some((source) => source.quality === "tertiary")) signal = "source-review";
  if (reasons.length === 0) reasons.push("Linked metadata is internally consistent; human source and claim review is still required.");

  return {
    claimId: claim.id,
    claim: claim.claim,
    section: claim.section,
    signal,
    linkedSourceCount: linkedSources.length,
    primarySourceCount,
    currentSourceCount,
    datedSourceCount,
    unknownFreshnessCount,
    missingSourceCount,
    reasons,
  };
}

export function buildCitationQualitySummary(
  claims: readonly CitationLedgerClaim[],
  sources: readonly CitationLedgerSource[],
): CitationQualitySummary {
  const reviews = claims.map((claim) => buildCitationQualityReview(claim, sources));
  return {
    totalClaims: reviews.length,
    reviewReady: reviews.filter((review) => review.signal === "review-ready").length,
    sourceReview: reviews.filter((review) => review.signal === "source-review").length,
    claimReview: reviews.filter((review) => review.signal === "claim-review").length,
    blocked: reviews.filter((review) => review.signal === "blocked").length,
    primarySourceLinks: reviews.reduce((sum, review) => sum + review.primarySourceCount, 0),
    currentSourceLinks: reviews.reduce((sum, review) => sum + review.currentSourceCount, 0),
    datedSourceLinks: reviews.reduce((sum, review) => sum + review.datedSourceCount, 0),
    unknownFreshnessLinks: reviews.reduce((sum, review) => sum + review.unknownFreshnessCount, 0),
  };
}

export function sortCitationQualityReviews(
  reviews: readonly CitationQualityReview[],
  sort: CitationQualitySort,
): CitationQualityReview[] {
  return [...reviews].sort((left, right) => {
    if (sort === "priority") {
      const priorityDifference = citationQualityPriority[left.signal] - citationQualityPriority[right.signal];
      if (priorityDifference !== 0) return priorityDifference;
    } else {
      const keyDifference = (sort === "claim" ? left.claim : left.section)
        .localeCompare(sort === "claim" ? right.claim : right.section, undefined, { sensitivity: "base" });
      if (keyDifference !== 0) return keyDifference;
    }
    return left.claim.localeCompare(right.claim, undefined, { sensitivity: "base" });
  });
}

function formatExport(format: ExportFormat, claims: readonly CitationLedgerClaim[], sources: readonly CitationLedgerSource[]) {
  const coverage = {
    totalClaims: claims.length,
    linkedClaims: claims.filter((claim) => claim.sourceIds.length > 0).length,
    supportedClaims: claims.filter((claim) => claim.status === "supported").length,
    attentionClaims: claims.filter((claim) => claim.status !== "supported").length,
    heuristicPercent: claims.length ? Math.round((claims.filter((claim) => claim.sourceIds.length > 0 && claim.status === "supported").length / claims.length) * 100) : 0,
  };
  const qualitySummary = buildCitationQualitySummary(claims, sources);
  const qualitySignals = claims.map((claim) => buildCitationQualityReview(claim, sources));
  const payload = {
    schema: "omnia.academic-citation-ledger.preview.v1",
    scope: "renderer-session",
    claims,
    sources,
    coverage,
    qualitySummary,
    qualitySignals,
    retrieval: "not-run-in-preview",
    sourceVerification: "not-run-in-preview",
    nativeRuntime: "not-tested-by-this-preview",
    durableWrite: false,
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  const sourceLines = sources.map((source) => `- ${source.title} (${sourceKindLabels[source.kind]}, ${sourceQualityLabels[source.quality]}) — ${source.locator}`).join("\n");
  const claimLines = claims.map((claim) => `- [${claim.status === "supported" ? "x" : " "}] ${claim.claim} — ${claim.status}; sources: ${claim.sourceIds.length || "none"}`).join("\n");
  const qualityLines = qualitySignals.map((review) => `- ${citationQualitySignalLabels[review.signal]} · ${review.claim} — ${review.reasons.join(" ")}`).join("\n");
  return `# Academic citation ledger preview\n\n- Scope: renderer session\n- Coverage heuristic: ${coverage.heuristicPercent}%\n- Linked claims: ${coverage.linkedClaims}/${coverage.totalClaims}\n- Supported claims: ${coverage.supportedClaims}\n- Quality review signals: ${qualitySummary.reviewReady} ready · ${qualitySummary.sourceReview} source review · ${qualitySummary.claimReview} claim review · ${qualitySummary.blocked} blocked\n\n## Claims\n\n${claimLines || "- No claims in this preview."}\n\n## Quality review signals\n\n${qualityLines || "- No quality signals in this preview."}\n\n## Sources\n\n${sourceLines || "- No sources in this preview."}\n\n> Preview only · quality signals prioritize human review; they do not verify sources or claims.\n`;
}

export function AcademicCitationLedgerPreview() {
  const [tab, setTab] = useState<LedgerTab>("claims");
  const [claims, setClaims] = useState<CitationLedgerClaim[]>(() => cloneClaims(seedClaims));
  const [sources, setSources] = useState<CitationLedgerSource[]>(() => seedSources.map((source) => ({ ...source })));
  const [history, setHistory] = useState<LedgerSnapshot[]>([]);
  const [future, setFuture] = useState<LedgerSnapshot[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ClaimStatus | "all">("all");
  const [sourceKindFilter, setSourceKindFilter] = useState<SourceKind | "all">("all");
  const [qualityFilter, setQualityFilter] = useState<CitationQualitySignal | "all">("all");
  const [qualitySort, setQualitySort] = useState<CitationQualitySort>("priority");
  const [selectedClaimId, setSelectedClaimId] = useState(seedClaims[0]?.id ?? "");
  const [selectedSourceId, setSelectedSourceId] = useState(seedSources[0]?.id ?? "");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [status, setStatus] = useState("Ledger is a renderer-local preview.");
  const [newSourceTitle, setNewSourceTitle] = useState("");
  const [newSourceLocator, setNewSourceLocator] = useState("");
  const [newSourceKind, setNewSourceKind] = useState<SourceKind>("documentation");
  const [importInput, setImportInput] = useState("");
  const [importFileName, setImportFileName] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [importConflictPolicy, setImportConflictPolicy] = useState<ImportConflictPolicy>("keep-local");
  const importFileRef = useRef<HTMLInputElement>(null);

  const filteredClaims = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return claims.filter((claim) => {
      if (statusFilter !== "all" && claim.status !== statusFilter) return false;
      if (!needle) return true;
      const sourceText = claim.sourceIds.map((id) => sources.find((source) => source.id === id)?.title ?? "").join(" ");
      return `${claim.claim} ${claim.section} ${claim.note} ${sourceText}`.toLowerCase().includes(needle);
    });
  }, [claims, query, sources, statusFilter]);

  const filteredSources = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sources.filter((source) => {
      if (sourceKindFilter !== "all" && source.kind !== sourceKindFilter) return false;
      if (!needle) return true;
      return `${source.title} ${source.author} ${source.locator} ${source.excerpt}`.toLowerCase().includes(needle);
    });
  }, [query, sourceKindFilter, sources]);

  const selectedClaim = filteredClaims.find((claim) => claim.id === selectedClaimId) ?? filteredClaims[0] ?? null;
  const selectedSource = filteredSources.find((source) => source.id === selectedSourceId) ?? filteredSources[0] ?? null;
  const linkedClaims = claims.filter((claim) => claim.sourceIds.length > 0).length;
  const supportedClaims = claims.filter((claim) => claim.status === "supported").length;
  const attentionClaims = claims.filter((claim) => claim.status !== "supported").length;
  const coveragePercent = claims.length ? Math.round((claims.filter((claim) => claim.sourceIds.length > 0 && claim.status === "supported").length / claims.length) * 100) : 0;
  const qualityReviews = useMemo(() => claims.map((claim) => buildCitationQualityReview(claim, sources)), [claims, sources]);
  const visibleQualityReviews = useMemo(() => {
    const filtered = qualityFilter === "all" ? qualityReviews : qualityReviews.filter((review) => review.signal === qualityFilter);
    return sortCitationQualityReviews(filtered, qualitySort);
  }, [qualityFilter, qualityReviews, qualitySort]);
  const qualitySummary = useMemo(() => buildCitationQualitySummary(claims, sources), [claims, sources]);
  const exportPayload = useMemo(() => formatExport(exportFormat, claims, sources), [claims, exportFormat, sources]);
  const importResult = useMemo(() => parseLedgerImport(importInput), [importInput]);
  const importConflicts = importResult.ok
    ? {
      claims: importResult.snapshot.claims.filter((claim) => claims.some((current) => current.id === claim.id)).length,
      sources: importResult.snapshot.sources.filter((source) => sources.some((current) => current.id === source.id)).length,
    }
    : null;

  useEffect(() => {
    if (filteredClaims.length > 0 && !filteredClaims.some((claim) => claim.id === selectedClaimId)) setSelectedClaimId(filteredClaims[0]?.id ?? "");
  }, [filteredClaims, selectedClaimId]);

  useEffect(() => {
    if (filteredSources.length > 0 && !filteredSources.some((source) => source.id === selectedSourceId)) setSelectedSourceId(filteredSources[0]?.id ?? "");
  }, [filteredSources, selectedSourceId]);

  const commitClaims = (nextClaims: CitationLedgerClaim[], message: string) => {
    setHistory((entries) => [...entries.slice(-19), { claims: cloneClaims(claims), sources: sources.map((source) => ({ ...source })) }]);
    setFuture([]);
    setClaims(nextClaims);
    setStatus(message);
  };

  const commitLedger = (nextClaims: CitationLedgerClaim[], nextSources: CitationLedgerSource[], message: string) => {
    setHistory((entries) => [...entries.slice(-19), { claims: cloneClaims(claims), sources: sources.map((source) => ({ ...source })) }]);
    setFuture([]);
    setClaims(nextClaims);
    setSources(nextSources);
    setStatus(message);
  };

  const updateSelectedClaim = (patch: Partial<CitationLedgerClaim>, message: string) => {
    if (!selectedClaim) return;
    commitClaims(claims.map((claim) => claim.id === selectedClaim.id ? { ...claim, ...patch, sourceIds: patch.sourceIds ? [...patch.sourceIds] : claim.sourceIds } : claim), message);
  };

  const setVisibleStatus = (nextStatus: ClaimStatus) => {
    if (!filteredClaims.length) return;
    const visibleIds = new Set(filteredClaims.map((claim) => claim.id));
    commitClaims(claims.map((claim) => visibleIds.has(claim.id) ? { ...claim, status: nextStatus } : claim), `Marked ${filteredClaims.length} visible claim${filteredClaims.length === 1 ? "" : "s"} ${nextStatus}.`);
  };

  const reviewClaim = (claimId: string) => {
    setQuery("");
    setStatusFilter("all");
    setSelectedClaimId(claimId);
    setTab("claims");
    setStatus("Opened the selected claim for renderer-local human review.");
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [...entries, { claims: cloneClaims(claims), sources: sources.map((source) => ({ ...source })) }]);
    setClaims(cloneClaims(previous.claims));
    setSources(previous.sources.map((source) => ({ ...source })));
    setStatus("Undid the last citation-ledger action.");
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((entries) => entries.slice(0, -1));
    setHistory((entries) => [...entries, { claims: cloneClaims(claims), sources: sources.map((source) => ({ ...source })) }]);
    setClaims(cloneClaims(next.claims));
    setSources(next.sources.map((source) => ({ ...source })));
    setStatus("Redid the citation-ledger action.");
  };

  const toggleSourceForClaim = (sourceId: string) => {
    if (!selectedClaim) return;
    const sourceIds = selectedClaim.sourceIds.includes(sourceId)
      ? selectedClaim.sourceIds.filter((id) => id !== sourceId)
      : [...selectedClaim.sourceIds, sourceId];
    updateSelectedClaim({ sourceIds }, sourceIds.includes(sourceId) ? "Linked a renderer-local source to this claim." : "Removed the renderer-local source link.");
  };

  const addSource = () => {
    const title = newSourceTitle.trim();
    const locator = newSourceLocator.trim();
    if (!title || !locator) {
      setStatus("Add a source title and locator before creating a ledger entry.");
      return;
    }
    const id = `source-preview-${Date.now()}`;
    const newSource: CitationLedgerSource = {
      id,
      title,
      kind: newSourceKind,
      locator,
      author: "Added in preview",
      year: "—",
      excerpt: "No excerpt entered yet; human verification is still required.",
      quality: "secondary",
      freshness: "unknown",
    };
    const nextSources = [...sources, newSource];
    commitLedger(claims, nextSources, "Added a renderer-local source record; no source was fetched.");
    setSelectedSourceId(id);
    setNewSourceTitle("");
    setNewSourceLocator("");
  };

  const applyImport = () => {
    if (!importResult.ok) return;
    const incoming = importResult.snapshot;
    const nextClaims = importMode === "replace"
      ? cloneClaims(incoming.claims)
      : mergeRecords(claims, incoming.claims.map((claim) => ({ ...claim, sourceIds: [...claim.sourceIds] })), importConflictPolicy);
    const nextSources = importMode === "replace"
      ? incoming.sources.map((source) => ({ ...source }))
      : mergeRecords(sources, incoming.sources.map((source) => ({ ...source })), importConflictPolicy);
    commitLedger(nextClaims, nextSources, `${importMode === "replace" ? "Replaced" : "Merged"} ${incoming.claims.length} claims and ${incoming.sources.length} sources from the renderer-local package.`);
    setQuery("");
    setStatusFilter("all");
    setSourceKindFilter("all");
    setSelectedClaimId(nextClaims[0]?.id ?? "");
    setSelectedSourceId(nextSources[0]?.id ?? "");
  };

  const loadImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImportFileName(file.name);
    if (file.size > MAX_LEDGER_IMPORT_BYTES) {
      setImportInput("");
      setStatus("Ledger JSON exceeds the 64 KB import limit; no file was read.");
      return;
    }
    try {
      setImportInput(await file.text());
    } catch {
      setImportInput("");
      setStatus("The selected file could not be read in this preview.");
    }
  };

  const reset = () => {
    setClaims(cloneClaims(seedClaims));
    setSources(seedSources.map((source) => ({ ...source })));
    setHistory([]);
    setFuture([]);
    setQuery("");
    setStatusFilter("all");
    setSourceKindFilter("all");
    setSelectedClaimId(seedClaims[0]?.id ?? "");
    setSelectedSourceId(seedSources[0]?.id ?? "");
    setStatus("Citation ledger preview reset.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable in this preview.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied the renderer-local ${exportFormat.toUpperCase()} citation ledger.`);
    } catch {
      setStatus("Clipboard access was denied; nothing was copied.");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportPayload], { type: exportFormat === "json" ? "application/json" : "text/markdown" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-academic-citation-ledger.${exportFormat === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`Started a browser download of the renderer-local ${exportFormat.toUpperCase()} ledger.`);
  };

  return (
    <section className="academic-citation-ledger" aria-labelledby="academic-citation-ledger-heading">
      <header className="academic-citation-ledger__header">
        <div>
          <span className="eyebrow"><BookOpen size={14} /> Academic · evidence ledger</span>
          <h2 id="academic-citation-ledger-heading">Citation ledger</h2>
          <p>Map claims to source records, expose review gaps, and keep evidence quality visible while drafting.</p>
        </div>
        <div className="academic-citation-ledger__header-actions">
          <span className="academic-citation-ledger__badge"><Sparkles size={12} /> Renderer-local preview</span>
          <span className="academic-citation-ledger__status-line" role="status" aria-live="polite">{status}</span>
          <button type="button" className="button button--ghost" onClick={reset}><RotateCcw size={13} /> Reset</button>
          <div className="academic-citation-ledger__history" role="group" aria-label="Citation ledger history">
            <button type="button" className="button button--ghost" onClick={undo} disabled={history.length === 0} aria-label="Undo citation ledger action" title="Undo"><Undo2 size={13} /></button>
            <button type="button" className="button button--ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo citation ledger action" title="Redo"><Redo2 size={13} /></button>
          </div>
        </div>
      </header>

      <div className="academic-citation-ledger__boundary" role="note">
        <ShieldCheck size={15} />
        <span><strong>Evidence stays honest.</strong> This ledger uses illustrative records only. No URL retrieval, source verification, provider request, native receipt, or durable write runs in this preview.</span>
      </div>

      <div className="academic-citation-ledger__metrics" aria-label="Citation ledger summary">
        <div><Target size={16} /><span><small>Claims</small><strong>{claims.length}</strong><em>{linkedClaims} linked</em></span></div>
        <div><CheckCircle2 size={16} /><span><small>Supported</small><strong>{supportedClaims}</strong><em>reviewed in preview</em></span></div>
        <div><AlertTriangle size={16} /><span><small>Attention</small><strong>{attentionClaims}</strong><em>needs a human check</em></span></div>
        <div><Link2 size={16} /><span><small>Coverage</small><strong>{coveragePercent}%</strong><em>heuristic only</em></span></div>
      </div>

      <nav className="academic-citation-ledger__tabs" role="tablist" aria-label="Citation ledger views">
        {tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} aria-controls={`academic-citation-ledger-panel-${value}`} className={tab === value ? "is-active" : ""} onClick={() => setTab(value)}>{label}{value === "claims" ? <small>{claims.length}</small> : value === "sources" ? <small>{sources.length}</small> : value === "quality" ? <small>{qualitySummary.blocked + qualitySummary.claimReview + qualitySummary.sourceReview}</small> : null}</button>)}
      </nav>

      {tab === "claims" ? <section id="academic-citation-ledger-panel-claims" role="tabpanel" className="academic-citation-ledger__panel">
        <div className="academic-citation-ledger__toolbar">
          <label className="academic-citation-ledger__search"><Search size={14} /><span className="sr-only">Search claims and sources</span><input aria-label="Search claims and sources" placeholder="Search claims, sections, or sources" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span>Status</span><select aria-label="Claim status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ClaimStatus | "all")}><option value="all">All statuses</option>{Object.entries(claimStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button type="button" className="button button--ghost" onClick={() => setVisibleStatus("supported")} disabled={filteredClaims.length === 0}><Check size={13} /> Mark visible supported</button>
          <span className="academic-citation-ledger__result-count"><Filter size={13} /> {filteredClaims.length} of {claims.length} claims</span>
        </div>
        <div className="academic-citation-ledger__split">
          <div className="academic-citation-ledger__list" aria-label="Claim ledger entries">
            {filteredClaims.length === 0 ? <div className="academic-citation-ledger__empty"><Search size={18} /><strong>No matching claims</strong><span>Clear the query or status filter to inspect the full ledger.</span></div> : filteredClaims.map((claim) => <button key={claim.id} type="button" className={`academic-citation-ledger__claim ${selectedClaim?.id === claim.id ? "is-selected" : ""}`} onClick={() => setSelectedClaimId(claim.id)}><span className={`academic-citation-ledger__status academic-citation-ledger__status--${claim.status.replaceAll(" ", "-")}`}>{statusIcon(claim.status)} {claimStatusLabels[claim.status]}</span><strong>{claim.claim}</strong><small>{claim.section} · {claim.sourceIds.length} source{claim.sourceIds.length === 1 ? "" : "s"} · {claim.confidence}% confidence</small></button>)}
          </div>
          {selectedClaim ? <article className="academic-citation-ledger__detail" aria-label="Selected claim details"><div className="academic-citation-ledger__detail-heading"><div><span className="eyebrow">Claim detail</span><h3>{selectedClaim.claim}</h3><span className={`academic-citation-ledger__status academic-citation-ledger__status--${selectedClaim.status.replaceAll(" ", "-")}`}>{statusIcon(selectedClaim.status)} {claimStatusLabels[selectedClaim.status]}</span></div><span className="academic-citation-ledger__detail-id">{selectedClaim.id}</span></div><div className="academic-citation-ledger__detail-grid"><label><span>Evidence status</span><select aria-label="Selected claim evidence status" value={selectedClaim.status} onChange={(event) => updateSelectedClaim({ status: event.target.value as ClaimStatus }, "Updated claim evidence status in the preview.")}>{Object.entries(claimStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Statement type</span><select aria-label="Selected claim statement type" value={selectedClaim.statementType} onChange={(event) => updateSelectedClaim({ statementType: event.target.value as StatementType }, "Updated claim statement type in the preview.")}><option value="observed">Observed</option><option value="inferred">Inferred</option><option value="planned">Planned</option></select></label><label><span>Confidence ({selectedClaim.confidence}%)</span><input aria-label="Selected claim confidence" type="range" min="0" max="100" step="1" value={selectedClaim.confidence} onChange={(event) => updateSelectedClaim({ confidence: Number(event.target.value) }, "Updated the renderer-local confidence estimate.")} /></label><label><span>Section</span><input aria-label="Selected claim section" value={selectedClaim.section} onChange={(event) => updateSelectedClaim({ section: event.target.value }, "Updated the renderer-local claim section.")} /></label></div><label className="academic-citation-ledger__note"><span>Reviewer note</span><textarea aria-label="Selected claim reviewer note" rows={3} value={selectedClaim.note} onChange={(event) => updateSelectedClaim({ note: event.target.value }, "Updated the renderer-local reviewer note.")} /></label><fieldset className="academic-citation-ledger__source-links"><legend>Linked source records ({selectedClaim.sourceIds.length})</legend>{sources.map((source) => <label key={source.id}><input type="checkbox" checked={selectedClaim.sourceIds.includes(source.id)} onChange={() => toggleSourceForClaim(source.id)} /><span><strong>{source.title}</strong><small>{sourceKindLabels[source.kind]} · {source.locator}</small></span></label>)}</fieldset><p className="academic-citation-ledger__detail-boundary"><ShieldCheck size={14} /> Linking a source changes this renderer session only; it does not verify support or alter the draft automatically.</p></article> : <div className="academic-citation-ledger__empty"><Target size={18} /><strong>{filteredClaims.length === 0 ? "No visible claim details" : "Select a claim"}</strong><span>{filteredClaims.length === 0 ? "Clear the current filters to restore a claim." : "Choose a visible claim to inspect its evidence links."}</span></div>}
        </div>
      </section> : null}

      {tab === "sources" ? <section id="academic-citation-ledger-panel-sources" role="tabpanel" className="academic-citation-ledger__panel">
        <div className="academic-citation-ledger__toolbar"><label className="academic-citation-ledger__search"><Search size={14} /><span className="sr-only">Search source records</span><input aria-label="Search source records" placeholder="Search source title, author, or locator" value={query} onChange={(event) => setQuery(event.target.value)} /></label><label><span>Source type</span><select aria-label="Source type filter" value={sourceKindFilter} onChange={(event) => setSourceKindFilter(event.target.value as SourceKind | "all")}><option value="all">All source types</option>{Object.entries(sourceKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="academic-citation-ledger__result-count"><Filter size={13} /> {filteredSources.length} of {sources.length} sources</span></div>
        <div className="academic-citation-ledger__source-layout"><div className="academic-citation-ledger__source-list">{filteredSources.length === 0 ? <div className="academic-citation-ledger__empty"><Search size={18} /><strong>No matching sources</strong><span>Clear the query or source-type filter to inspect the full ledger.</span></div> : filteredSources.map((source) => <button type="button" key={source.id} className={`academic-citation-ledger__source-card ${selectedSource?.id === source.id ? "is-selected" : ""}`} onClick={() => setSelectedSourceId(source.id)}><span className="academic-citation-ledger__source-kind">{sourceKindLabels[source.kind]}</span><strong>{source.title}</strong><small>{source.locator}</small><span className="academic-citation-ledger__source-meta"><span>{sourceQualityLabels[source.quality]}</span><span>{sourceFreshnessLabels[source.freshness]}</span></span></button>)}</div>{selectedSource ? <article className="academic-citation-ledger__source-detail"><span className="eyebrow">Source record</span><h3>{selectedSource.title}</h3><p>{selectedSource.excerpt}</p><dl><div><dt>Kind</dt><dd>{sourceKindLabels[selectedSource.kind]}</dd></div><div><dt>Locator</dt><dd>{selectedSource.locator}</dd></div><div><dt>Author / year</dt><dd>{selectedSource.author} · {selectedSource.year}</dd></div><div><dt>Quality</dt><dd>{sourceQualityLabels[selectedSource.quality]}</dd></div><div><dt>Freshness</dt><dd>{sourceFreshnessLabels[selectedSource.freshness]}</dd></div></dl><p className="academic-citation-ledger__detail-boundary"><Link2 size={14} /> No URL or content was fetched; this is a source metadata projection only.</p></article> : null}</div>
        <div className="academic-citation-ledger__add-source"><span className="eyebrow">Add a local record</span><div><label><span>Title</span><input aria-label="New source title" placeholder="Source title" value={newSourceTitle} onChange={(event) => setNewSourceTitle(event.target.value)} /></label><label><span>Locator</span><input aria-label="New source locator" placeholder="Notebook, paper, or document locator" value={newSourceLocator} onChange={(event) => setNewSourceLocator(event.target.value)} /></label><label><span>Type</span><select aria-label="New source kind" value={newSourceKind} onChange={(event) => setNewSourceKind(event.target.value as SourceKind)}>{Object.entries(sourceKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="button button--secondary" onClick={addSource}><Plus size={13} /> Add source</button></div></div>
      </section> : null}

      {tab === "coverage" ? <section id="academic-citation-ledger-panel-coverage" role="tabpanel" className="academic-citation-ledger__panel"><div className="academic-citation-ledger__coverage-head"><div><span className="eyebrow">Claim × evidence</span><h3>Coverage review</h3><p>Use this view to spot unsupported or stale-looking claims before a human review.</p></div><strong>{coveragePercent}% heuristic coverage</strong></div><div className="academic-citation-ledger__coverage-list">{claims.map((claim) => { const linked = claim.sourceIds.map((id) => sources.find((source) => source.id === id)?.title).filter((title): title is string => Boolean(title)); const review = qualityReviews.find((candidate) => candidate.claimId === claim.id) ?? buildCitationQualityReview(claim, sources); return <article key={claim.id} className="academic-citation-ledger__coverage-row"><div><span className={`academic-citation-ledger__status academic-citation-ledger__status--${claim.status.replaceAll(" ", "-")}`}>{statusIcon(claim.status)} {claimStatusLabels[claim.status]}</span><strong>{claim.claim}</strong><small>{claim.section} · {claim.statementType} · {claim.confidence}% confidence</small></div><div className="academic-citation-ledger__coverage-evidence"><div className="academic-citation-ledger__coverage-meter" aria-label={`${linked.length} of ${sources.length} sources linked to ${claim.claim}`}><span><i style={{ width: `${Math.min(100, linked.length ? Math.max(18, linked.length * 34) : 0)}%` }} /></span><strong>{linked.length} source{linked.length === 1 ? "" : "s"}</strong><small>{linked.length ? linked.join(" · ") : "No linked source"}</small></div><div className="academic-citation-ledger__quality-review"><span className={`academic-citation-ledger__quality-signal academic-citation-ledger__quality-signal--${review.signal}`}>{qualitySignalIcon(review.signal)} {citationQualitySignalLabels[review.signal]}</span><strong>{review.primarySourceCount} primary · {review.currentSourceCount} current</strong><small>{review.reasons.join(" ")}</small></div></div></article>; })}</div><p className="academic-citation-ledger__detail-boundary"><AlertTriangle size={14} /> Coverage is a review heuristic; quality signals are review heuristics too, not citation validators. They do not verify source content, claim scope, or freshness.</p></section> : null}

      {tab === "quality" ? <section id="academic-citation-ledger-panel-quality" role="tabpanel" className="academic-citation-ledger__panel"><div className="academic-citation-ledger__coverage-head"><div><span className="eyebrow">Human review queue</span><h3>Citation quality triage</h3><p>Prioritize which claim–source links need attention using explicit metadata signals. This preview never decides that a source is true.</p></div><strong>{qualitySummary.reviewReady} ready · {qualitySummary.blocked} blocked</strong></div><div className="academic-citation-ledger__quality-summary" aria-label="Citation quality summary"><div><small>Ready for human check</small><strong>{qualitySummary.reviewReady}</strong><span>Supported claims with consistent metadata</span></div><div><small>Source review</small><strong>{qualitySummary.sourceReview}</strong><span>Dated, unknown, or tertiary source signals</span></div><div><small>Claim review</small><strong>{qualitySummary.claimReview}</strong><span>Unresolved, contradicting, or needs-review status</span></div><div><small>Blocked</small><strong>{qualitySummary.blocked}</strong><span>No linked source or missing source record</span></div></div><div className="academic-citation-ledger__quality-toolbar"><label><span>Signal</span><select aria-label="Citation quality signal filter" value={qualityFilter} onChange={(event) => setQualityFilter(event.target.value as CitationQualitySignal | "all")}><option value="all">All signals</option>{Object.entries(citationQualitySignalLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Sort</span><select aria-label="Citation quality sort order" value={qualitySort} onChange={(event) => setQualitySort(event.target.value as CitationQualitySort)}><option value="priority">Review priority</option><option value="claim">Claim A–Z</option><option value="section">Section A–Z</option></select></label><span role="status">{visibleQualityReviews.length} of {qualityReviews.length} claims</span>{qualityFilter !== "all" ? <button type="button" className="button button--ghost" onClick={() => setQualityFilter("all")}>Clear signal filter</button> : null}</div><div className="academic-citation-ledger__quality-list">{visibleQualityReviews.length === 0 ? <div className="academic-citation-ledger__empty"><Filter size={18} /><strong>No claims match this signal</strong><span>Choose another signal to continue triage.</span></div> : visibleQualityReviews.map((review) => <article key={review.claimId} className="academic-citation-ledger__quality-row"><div><span className={`academic-citation-ledger__quality-signal academic-citation-ledger__quality-signal--${review.signal}`}>{qualitySignalIcon(review.signal)} {citationQualitySignalLabels[review.signal]}</span><strong>{review.claim}</strong><small>{review.section} · {review.linkedSourceCount} linked source{review.linkedSourceCount === 1 ? "" : "s"}</small></div><div><strong>{review.primarySourceCount} primary · {review.currentSourceCount} current · {review.unknownFreshnessCount} unknown freshness</strong><small>{review.reasons.join(" ")}</small></div><button type="button" className="button button--secondary academic-citation-ledger__quality-review-action" onClick={() => reviewClaim(review.claimId)}>Review claim</button></article>)}</div><p className="academic-citation-ledger__detail-boundary"><ShieldCheck size={14} /> Quality triage is renderer-local and metadata-based. No retrieval, source verification, provider call, or durable write occurred.</p></section> : null}

      {tab === "import" ? <section id="academic-citation-ledger-panel-import" role="tabpanel" className="academic-citation-ledger__panel">
        <div className="academic-citation-ledger__import-heading"><div><span className="eyebrow">Portable evidence map</span><h3>Import a citation ledger</h3><p>Bring back an Omnia ledger export or merge records from another draft. Nothing is saved outside this renderer session.</p></div><span className="academic-citation-ledger__badge"><Upload size={12} /> User-selected JSON</span></div>
        <div className="academic-citation-ledger__import-controls">
          <label><span>Import mode</span><select aria-label="Citation ledger import mode" value={importMode} onChange={(event) => setImportMode(event.target.value as "merge" | "replace")}><option value="merge">Merge by record ID</option><option value="replace">Replace current ledger</option></select></label>
          {importMode === "merge" ? <label><span>When IDs overlap</span><select aria-label="Import conflict policy" value={importConflictPolicy} onChange={(event) => setImportConflictPolicy(event.target.value as ImportConflictPolicy)}><option value="keep-local">Keep current records</option><option value="use-imported">Use imported records</option></select></label> : null}
          <button type="button" className="button button--secondary" onClick={() => importFileRef.current?.click()}><Upload size={13} /> Choose JSON file</button>
          <input ref={importFileRef} className="sr-only" type="file" accept="application/json,.json" aria-label="Choose citation ledger JSON file" onChange={(event) => { void loadImportFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
          {importFileName ? <span className="academic-citation-ledger__import-filename">{importFileName}</span> : null}
        </div>
        <label className="academic-citation-ledger__import-input"><span>Paste exported JSON</span><textarea aria-label="Citation ledger JSON import" rows={9} value={importInput} onChange={(event) => { setImportInput(event.target.value); setImportFileName(""); }} placeholder={'Paste a package with schema "omnia.academic-citation-ledger.preview.v1"…'} /></label>
        <div className={`academic-citation-ledger__import-preview ${importResult.ok ? "is-valid" : "is-invalid"}`} role="status" aria-live="polite">
          {importResult.ok ? <><CheckCircle2 size={16} /><div><strong>Package ready · {importResult.snapshot.claims.length} claims · {importResult.snapshot.sources.length} sources</strong><span>{importMode === "replace" ? "The current ledger will be replaced; Undo remains available." : `${importConflicts?.claims ?? 0} claim IDs and ${importConflicts?.sources ?? 0} source IDs overlap. ${importConflictPolicy === "keep-local" ? "Current matching records will be kept." : "Matching records will use imported values."}`}</span></div></> : <><AlertTriangle size={16} /><div><strong>Waiting for a valid ledger package</strong><span>{importResult.error}</span></div></>}
        </div>
        <div className="academic-citation-ledger__import-actions"><button type="button" className="button button--secondary" onClick={applyImport} disabled={!importResult.ok}>{importMode === "replace" ? "Replace ledger" : "Merge into ledger"}</button><button type="button" className="button button--ghost" onClick={() => { setImportInput(""); setImportFileName(""); }}>Clear import</button><span>Imported records are validated before use and all changes can be undone.</span></div>
        <div className="academic-citation-ledger__export-boundary"><ShieldCheck size={14} /><span>Metadata only: import does not fetch sources, trust citation claims, execute embedded content, or write durable app data. Markdown exports are for reading and are not importable.</span></div>
      </section> : null}

      {tab === "export" ? <section id="academic-citation-ledger-panel-export" role="tabpanel" className="academic-citation-ledger__panel"><div className="academic-citation-ledger__export-toolbar"><label><span>Format</span><select aria-label="Citation ledger export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button></div><pre tabIndex={0}><code>{exportPayload}</code></pre><div className="academic-citation-ledger__export-boundary"><FileText size={14} /><span>Export is a renderer-local preview package. It contains metadata and illustrative links only; it does not include fetched source content or create a durable file.</span></div></section> : null}

      <p className="academic-citation-ledger__footer"><BookOpen size={14} /> Preview only · renderer-local · no retrieval, source verification, provider call, native receipt, or durable write.</p>
    </section>
  );
}

export default AcademicCitationLedgerPreview;
