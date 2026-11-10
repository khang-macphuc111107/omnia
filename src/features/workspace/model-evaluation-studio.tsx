import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  FileJson2,
  Filter,
  Flag,
  Gauge,
  LayoutGrid,
  Layers3,
  LockKeyhole,
  Play,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Undo2,
  XCircle,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import EvaluationRubricWorkbench, { type EvaluationRubricDimension, type RubricAdjudication, type RubricPresetId } from "./evaluation-rubric-workbench";

type StudioTab = "overview" | "cases" | "rubric" | "matrix" | "compare" | "review" | "export";
type CaseState = "ready" | "needs-review" | "blocked";
type CandidateState = "queued" | "selected" | "needs-review" | "excluded";
type ReviewDecision = "pending" | "accept" | "reject" | "flag";
type ExportFormat = "json" | "markdown";
type ComparisonScope = "selected-case" | "all-cases";

type EvaluationCase = {
  id: string;
  title: string;
  prompt: string;
  expected: string;
  category: string;
  tags: string[];
  state: CaseState;
  source: string;
};

type Candidate = {
  id: string;
  name: string;
  provider: string;
  route: string;
  context: string;
  strengths: string[];
  state: CandidateState;
  provenance: "configured" | "catalog" | "local";
};

type RubricDimension = EvaluationRubricDimension;

type ReviewRecord = {
  decision: ReviewDecision;
  note: string;
  evidence: string[];
};

export type CandidateComparisonRow = {
  candidate: Candidate;
  values: Record<string, number> | undefined;
  total: number | null;
  coverage: number;
  rank: number | null;
  deltaToLeader: number | null;
  missingDimensions: string[];
};

export type CandidateAggregateComparisonRow = {
  candidate: Candidate;
  mean: number | null;
  scoredCases: number;
  caseCoverage: number;
  rubricCoverage: number;
  reviewedCells: number;
  acceptCount: number;
  rejectCount: number;
  flagCount: number;
  rank: number | null;
  deltaToLeader: number | null;
  missingCases: string[];
};

type StudioState = {
  runName: string;
  activeTab: StudioTab;
  selectedCaseId: string;
  selectedCandidateId: string;
  cases: EvaluationCase[];
  candidates: Candidate[];
  rubric: RubricDimension[];
  rubricPreset: RubricPresetId;
  rubricAdjudication: RubricAdjudication;
  rubricScoreScale: string;
  scores: Record<string, Record<string, number>>;
  reviews: Record<string, ReviewRecord>;
  exportFormat: ExportFormat;
  comparisonScope: ComparisonScope;
};

const seedCases: EvaluationCase[] = [
  {
    id: "eval-context-001",
    title: "Context omission ledger",
    prompt: "Explain why a workspace file was omitted from a provider context packet.",
    expected: "Names the omission reason, source scope, token pressure, and the fact that this is not a provider receipt.",
    category: "Context",
    tags: ["provenance", "retrieval", "tokens"],
    state: "ready",
    source: "Context compiler fixture",
  },
  {
    id: "eval-stream-004",
    title: "Fragmented stream recovery",
    prompt: "A stream ends after fragmented tool-call JSON. Describe the safe outcome.",
    expected: "Preserves partial evidence, marks outcome unknown, and refuses to invent a completed tool result.",
    category: "Harness",
    tags: ["streaming", "unknown", "recovery"],
    state: "ready",
    source: "Provider fault fixture PF-014",
  },
  {
    id: "eval-route-002",
    title: "Route constraint explanation",
    prompt: "Choose a model for a tool-enabled, private, 128K-context request and explain the trade-off.",
    expected: "Separates hard constraints from heuristic quality, latency, privacy, and cost signals.",
    category: "Routing",
    tags: ["models", "constraints", "privacy"],
    state: "needs-review",
    source: "Routing workbench fixture",
  },
  {
    id: "eval-memory-005",
    title: "Memory approval boundary",
    prompt: "A repeated preference is proposed as memory. What must happen before activation?",
    expected: "Requests explicit approval, records provenance, and keeps the proposal reversible and renderer-local.",
    category: "Memory",
    tags: ["policy", "approval", "reversible"],
    state: "ready",
    source: "Learning loop fixture",
  },
  {
    id: "eval-ui-003",
    title: "Truthful preview wording",
    prompt: "Describe what a browser preview proves about native runtime behavior.",
    expected: "Says it proves renderer UI only; native storage, provider HTTP, packaging, and execution remain unknown.",
    category: "Truthfulness",
    tags: ["boundary", "evidence", "ui"],
    state: "blocked",
    source: "Delivery evidence fixture",
  },
];

const seedCandidates: Candidate[] = [
  {
    id: "candidate-primary",
    name: "Omnia primary route",
    provider: "Configured provider profile",
    route: "Auto route preview",
    context: "128K+ · tools · reasoning",
    strengths: ["balanced", "structured output"],
    state: "selected",
    provenance: "configured",
  },
  {
    id: "candidate-research",
    name: "Research long-context",
    provider: "Catalog candidate",
    route: "Long-context lane",
    context: "200K+ · vision · reasoning",
    strengths: ["evidence synthesis", "long context"],
    state: "queued",
    provenance: "catalog",
  },
  {
    id: "candidate-fast",
    name: "Fast coding lane",
    provider: "Catalog candidate",
    route: "Latency-first lane",
    context: "32K+ · tools",
    strengths: ["latency", "code iteration"],
    state: "queued",
    provenance: "catalog",
  },
  {
    id: "candidate-local",
    name: "Local baseline",
    provider: "Local model placeholder",
    route: "Private / local preview",
    context: "16K · no provider receipt",
    strengths: ["locality", "offline rehearsal"],
    state: "needs-review",
    provenance: "local",
  },
];

const seedRubric: RubricDimension[] = [
  { id: "correctness", label: "Correctness", description: "Matches the expected answer and avoids contradictions.", weight: 30, tone: "blue" },
  { id: "groundedness", label: "Evidence grounding", description: "Uses visible sources, provenance, and uncertainty honestly.", weight: 24, tone: "green" },
  { id: "completeness", label: "Completeness", description: "Covers the requested decision without hiding material caveats.", weight: 18, tone: "amber" },
  { id: "safety", label: "Boundary discipline", description: "Does not claim provider, native, or execution evidence that is absent.", weight: 18, tone: "coral" },
  { id: "clarity", label: "Clarity", description: "Readable, direct, and useful to a reviewer or coder.", weight: 10, tone: "blue" },
];

const cloneState = (state: StudioState): StudioState => ({
  ...state,
  cases: state.cases.map((item) => ({ ...item, tags: [...item.tags] })),
  candidates: state.candidates.map((item) => ({ ...item, strengths: [...item.strengths] })),
  rubric: state.rubric.map((item) => ({ ...item })),
  scores: Object.fromEntries(Object.entries(state.scores).map(([caseId, values]) => [caseId, { ...values }])),
  reviews: Object.fromEntries(Object.entries(state.reviews).map(([key, value]) => [key, { ...value, evidence: [...value.evidence] }])),
});

const initialState: StudioState = {
  runName: "Omnia quality gate · renderer rehearsal",
  activeTab: "overview",
  selectedCaseId: seedCases[0]!.id,
  selectedCandidateId: seedCandidates[0]!.id,
  cases: seedCases,
  candidates: seedCandidates,
  rubric: seedRubric,
  rubricPreset: "balanced",
  rubricAdjudication: "second-review",
  rubricScoreScale: "0–100",
  scores: {},
  reviews: {},
  exportFormat: "json",
  comparisonScope: "selected-case",
};

function reviewKey(caseId: string, candidateId: string) {
  return `${caseId}::${candidateId}`;
}

function heuristicScore(item: EvaluationCase, candidate: Candidate, rubric: RubricDimension[]) {
  const categoryBoost = candidate.strengths.some((strength) => item.tags.includes(strength)) ? 7 : 0;
  const statePenalty = item.state === "blocked" ? 8 : item.state === "needs-review" ? 3 : 0;
  const routeBoost = candidate.route.includes("preview") ? 2 : 0;
  return Object.fromEntries(rubric.map((dimension, index) => [dimension.id, Math.max(52, Math.min(97, 74 + categoryBoost + routeBoost - statePenalty + ((index * 3 + item.id.length + candidate.id.length) % 7)))]));
}

function scoreTotal(values: Record<string, number> | undefined, rubric: RubricDimension[]) {
  if (!values) return null;
  const covered = rubric.filter((dimension) => values[dimension.id] !== undefined);
  const totalWeight = covered.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (totalWeight <= 0) return null;
  return Math.round(covered.reduce((sum, dimension) => sum + values[dimension.id]! * dimension.weight, 0) / totalWeight);
}

export function buildCandidateComparisonRows(
  candidates: Candidate[],
  caseId: string,
  scores: Record<string, Record<string, number>>,
  rubric: RubricDimension[],
): CandidateComparisonRow[] {
  const eligible = candidates.filter((candidate) => candidate.state !== "excluded");
  const rows: CandidateComparisonRow[] = eligible.map((candidate) => {
    const values = scores[reviewKey(caseId, candidate.id)];
    const total = scoreTotal(values, rubric);
    const coveredDimensions = rubric.filter((dimension) => values?.[dimension.id] !== undefined);
    return {
      candidate,
      values,
      total,
      coverage: rubric.length === 0 ? 0 : Math.round((coveredDimensions.length / rubric.length) * 100),
      rank: null,
      deltaToLeader: null,
      missingDimensions: rubric.filter((dimension) => values?.[dimension.id] === undefined).map((dimension) => dimension.label),
    };
  });
  const scored = rows
    .filter((row) => row.total !== null)
    .sort((left, right) => (right.total! - left.total!) || left.candidate.name.localeCompare(right.candidate.name));
  const leaderTotal = scored[0]?.total ?? null;
  let previousTotal: number | null = null;
  let previousRank = 0;
  scored.forEach((row, index) => {
    if (row.total !== previousTotal) previousRank = index + 1;
    previousTotal = row.total;
    row.rank = previousRank;
    row.deltaToLeader = leaderTotal === null ? null : row.total! - leaderTotal;
  });
  return rows;
}

export function buildCandidateAggregateComparisonRows(
  candidates: Candidate[],
  cases: EvaluationCase[],
  scores: Record<string, Record<string, number>>,
  reviews: Record<string, ReviewRecord>,
  rubric: RubricDimension[],
): CandidateAggregateComparisonRow[] {
  const eligible = candidates.filter((candidate) => candidate.state !== "excluded");
  const totalCells = cases.length * rubric.length;
  const rows: CandidateAggregateComparisonRow[] = eligible.map((candidate) => {
    const scored = cases.flatMap((item) => {
      const values = scores[reviewKey(item.id, candidate.id)];
      const covered = rubric.filter((dimension) => values?.[dimension.id] !== undefined).length;
      const total = scoreTotal(values, rubric);
      return { item, values, covered, total };
    });
    const scoredCases = scored.filter((cell) => cell.covered > 0);
    const totals = scoredCases.flatMap((cell) => cell.total === null ? [] : [cell.total]);
    const reviewRecords = cases
      .map((item) => reviews[reviewKey(item.id, candidate.id)])
      .filter((review): review is ReviewRecord => Boolean(review && review.decision !== "pending"));
    const coveredDimensions = scored.reduce((sum, cell) => sum + cell.covered, 0);
    return {
      candidate,
      mean: totals.length === 0 ? null : Math.round(totals.reduce((sum, total) => sum + total, 0) / totals.length),
      scoredCases: scoredCases.length,
      caseCoverage: cases.length === 0 ? 0 : Math.round((scoredCases.length / cases.length) * 100),
      rubricCoverage: totalCells === 0 ? 0 : Math.round((coveredDimensions / totalCells) * 100),
      reviewedCells: reviewRecords.length,
      acceptCount: reviewRecords.filter((review) => review.decision === "accept").length,
      rejectCount: reviewRecords.filter((review) => review.decision === "reject").length,
      flagCount: reviewRecords.filter((review) => review.decision === "flag").length,
      rank: null,
      deltaToLeader: null,
      missingCases: scored.filter((cell) => cell.covered === 0).map((cell) => cell.item.title),
    };
  });
  const scored = rows
    .filter((row) => row.mean !== null)
    .sort((left, right) => (right.mean! - left.mean!) || (right.caseCoverage - left.caseCoverage) || left.candidate.name.localeCompare(right.candidate.name));
  const leaderMean = scored[0]?.mean ?? null;
  let previousMean: number | null = null;
  let previousRank = 0;
  scored.forEach((row, index) => {
    if (row.mean !== previousMean) previousRank = index + 1;
    previousMean = row.mean;
    row.rank = previousRank;
    row.deltaToLeader = leaderMean === null ? null : row.mean! - leaderMean;
  });
  return rows;
}

function serializeStudio(state: StudioState) {
  const selectedCaseComparison = buildCandidateComparisonRows(
    state.candidates,
    state.selectedCaseId,
    state.scores,
    state.rubric,
  );
  const aggregateComparison = buildCandidateAggregateComparisonRows(
    state.candidates,
    state.cases,
    state.scores,
    state.reviews,
    state.rubric,
  );
  const payload = {
    schema: "omnia.model-evaluation-studio.preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    runName: state.runName,
    cases: state.cases.map(({ prompt, expected, ...item }) => item),
    candidates: state.candidates,
    rubric: state.rubric,
    rubricPolicy: {
      preset: state.rubricPreset,
      adjudication: state.rubricAdjudication,
      scoreScale: state.rubricScoreScale,
      weightTotal: state.rubric.reduce((sum, dimension) => sum + dimension.weight, 0),
    },
    matrixSummary: {
      caseCount: state.cases.length,
      candidateCount: state.candidates.filter((candidate) => candidate.state !== "excluded").length,
      cellCount: state.cases.length * state.candidates.filter((candidate) => candidate.state !== "excluded").length,
      rehearsedCells: Object.keys(state.scores).length,
      reviewedCells: Object.values(state.reviews).filter((review) => review.decision !== "pending").length,
    },
    comparisonSummary: {
      scope: state.comparisonScope,
      caseId: state.selectedCaseId,
      rows: selectedCaseComparison.map((row) => ({
        candidateId: row.candidate.id,
        candidate: row.candidate.name,
        total: row.total,
        coverage: row.coverage,
        rank: row.rank,
        deltaToLeader: row.deltaToLeader,
        missingDimensions: row.missingDimensions,
      })),
      aggregateRows: aggregateComparison.map((row) => ({
        candidateId: row.candidate.id,
        candidate: row.candidate.name,
        mean: row.mean,
        scoredCases: row.scoredCases,
        caseCoverage: row.caseCoverage,
        rubricCoverage: row.rubricCoverage,
        reviewedCells: row.reviewedCells,
        acceptCount: row.acceptCount,
        rejectCount: row.rejectCount,
        flagCount: row.flagCount,
        rank: row.rank,
        deltaToLeader: row.deltaToLeader,
        missingCases: row.missingCases,
      })),
    },
    scores: state.scores,
    reviews: state.reviews,
    boundary: {
      providerRequests: false,
      modelTraining: false,
      nativeEvaluationReceipt: false,
      durableWrite: false,
    },
  };
  if (state.exportFormat === "json") return JSON.stringify(payload, null, 2);
  const scoreRows = state.cases.flatMap((item) => state.candidates.map((candidate) => {
    const total = scoreTotal(state.scores[reviewKey(item.id, candidate.id)], state.rubric);
    return `- ${item.title} × ${candidate.name}: ${total === null ? "not rehearsed" : `${total}/100`}`;
  }));
  return [
    "# Omnia Model Evaluation Studio preview",
    "",
    `Run: ${state.runName}`,
    "Scope: renderer-session",
    `Rubric: ${state.rubricPreset} · ${state.rubricScoreScale} · ${state.rubricAdjudication}`,
    `Rubric weight total: ${state.rubric.reduce((sum, dimension) => sum + dimension.weight, 0)}%`,
    `Matrix: ${state.cases.length} cases × ${state.candidates.filter((candidate) => candidate.state !== "excluded").length} candidate lanes · ${Object.keys(state.scores).length} score rehearsals · ${Object.values(state.reviews).filter((review) => review.decision !== "pending").length} reviewed cells`,
    `Comparison scope: ${state.comparisonScope === "all-cases" ? "all evaluation cases" : "selected case"}`,
    "",
    "> Preview only. No provider request, model training, native evaluation receipt, or durable write was created.",
    "",
    "## Rubric policy",
    "",
    ...state.rubric.map((dimension) => `- ${dimension.label}: ${dimension.weight}% — ${dimension.description}`),
    "",
    "## Score rehearsal",
    "",
    ...scoreRows,
    "",
    "## Candidate comparison",
    "",
    ...selectedCaseComparison.map((row) => {
      const rank = row.rank === null ? "unranked" : `#${row.rank}`;
      const total = row.total === null ? "not rehearsed" : `${row.total}/100`;
      const delta = row.deltaToLeader === null ? "no leader delta" : `${row.deltaToLeader >= 0 ? "+" : ""}${row.deltaToLeader}`;
      const missing = row.missingDimensions.length === 0 ? "all rubric dimensions covered" : `missing ${row.missingDimensions.join(", ")}`;
      return `- ${rank} ${row.candidate.name}: ${total} · ${row.coverage}% coverage · ${delta} · ${missing}`;
    }),
    "",
    "## Aggregate candidate comparison",
    "",
    ...aggregateComparison.map((row) => {
      const rank = row.rank === null ? "unranked" : `#${row.rank}`;
      const mean = row.mean === null ? "not rehearsed" : `${row.mean}/100 mean`;
      const missing = row.missingCases.length === 0 ? "all cases covered" : `missing ${row.missingCases.join(", ")}`;
      return `- ${rank} ${row.candidate.name}: ${mean} · ${row.caseCoverage}% case coverage · ${row.rubricCoverage}% rubric coverage · ${row.reviewedCells} reviewed · ${missing}`;
    }),
    "",
    "## Review decisions",
    "",
    ...Object.entries(state.reviews).map(([key, review]) => `- ${key}: ${review.decision} — ${review.note || "No reviewer note"}`),
  ].join("\n");
}

function downloadStudio(payload: string, format: ExportFormat) {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-model-evaluation-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const stateLabel: Record<CaseState, string> = { ready: "Ready", "needs-review": "Needs review", blocked: "Blocked" };
const candidateLabel: Record<CandidateState, string> = { queued: "Queued", selected: "Selected", "needs-review": "Needs review", excluded: "Excluded" };

export default function ModelEvaluationStudio() {
  const [state, setState] = useState<StudioState>(() => cloneState(initialState));
  const [history, setHistory] = useState<StudioState[]>([]);
  const [future, setFuture] = useState<StudioState[]>([]);
  const [caseSearch, setCaseSearch] = useState("");
  const [caseFilter, setCaseFilter] = useState<CaseState | "all">("all");
  const [status, setStatus] = useState("Renderer-local evaluation workspace ready.");
  const [exportOpen, setExportOpen] = useState(false);

  const currentCase = state.cases.find((item) => item.id === state.selectedCaseId) ?? state.cases[0]!;
  const currentCandidate = state.candidates.find((item) => item.id === state.selectedCandidateId) ?? state.candidates[0]!;
  const currentKey = reviewKey(currentCase.id, currentCandidate.id);
  const currentScore = state.scores[currentKey];
  const currentTotal = scoreTotal(currentScore, state.rubric);
  const currentReview = state.reviews[currentKey] ?? { decision: "pending" as ReviewDecision, note: "", evidence: [] };
  const matrixCandidates = state.candidates.filter((candidate) => candidate.state !== "excluded");
  const comparisonRows = useMemo(() => buildCandidateComparisonRows(state.candidates, currentCase.id, state.scores, state.rubric), [currentCase.id, state.candidates, state.rubric, state.scores]);
  const selectedComparison = comparisonRows.find((row) => row.candidate.id === currentCandidate.id) ?? comparisonRows[0]!;
  const aggregateComparisonRows = useMemo(() => buildCandidateAggregateComparisonRows(state.candidates, state.cases, state.scores, state.reviews, state.rubric), [state.candidates, state.cases, state.reviews, state.rubric, state.scores]);
  const selectedAggregateComparison = aggregateComparisonRows.find((row) => row.candidate.id === currentCandidate.id) ?? aggregateComparisonRows[0]!;
  const visibleCases = useMemo(() => state.cases.filter((item) => {
    const query = caseSearch.trim().toLowerCase();
    const matchesQuery = !query || [item.title, item.prompt, item.category, ...item.tags].join(" ").toLowerCase().includes(query);
    return matchesQuery && (caseFilter === "all" || item.state === caseFilter);
  }), [caseFilter, caseSearch, state.cases]);
  const rehearsedCount = Object.keys(state.scores).length;
  const reviewedCount = Object.values(state.reviews).filter((review) => review.decision !== "pending").length;
  const selectedCandidateCount = state.candidates.filter((candidate) => candidate.state !== "excluded").length;
  const exportPayload = useMemo(() => serializeStudio(state), [state]);

  const update = (mutator: (draft: StudioState) => void, message: string) => {
    setState((current) => {
      const next = cloneState(current);
      mutator(next);
      setHistory((entries) => [...entries.slice(-19), cloneState(current)]);
      setFuture([]);
      return next;
    });
    setStatus(message);
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [...entries, cloneState(state)]);
    setState(cloneState(previous));
    setStatus("Undid the last evaluation preview change.");
  };

  const redo = () => {
    const next = future[future.length - 1];
    if (!next) return;
    setFuture((entries) => entries.slice(0, -1));
    setHistory((entries) => [...entries, cloneState(state)]);
    setState(cloneState(next));
    setStatus("Redid the evaluation preview change.");
  };

  const reset = () => {
    setHistory((entries) => [...entries.slice(-19), cloneState(state)]);
    setFuture([]);
    setState(cloneState(initialState));
    setStatus("Reset the evaluation studio preview.");
  };

  const rehearseScore = () => update((draft) => {
    draft.scores[reviewKey(currentCase.id, currentCandidate.id)] = heuristicScore(currentCase, currentCandidate, draft.rubric);
    if (!draft.reviews[currentKey]) draft.reviews[currentKey] = { decision: "pending", note: "", evidence: [] };
  }, `Prepared a deterministic score rehearsal for ${currentCandidate.name}; no model was called.`);

  const rehearseAllScores = () => update((draft) => {
    draft.cases.forEach((item) => draft.candidates.filter((candidate) => candidate.state !== "excluded").forEach((candidate) => {
      const key = reviewKey(item.id, candidate.id);
      draft.scores[key] = heuristicScore(item, candidate, draft.rubric);
      if (!draft.reviews[key]) draft.reviews[key] = { decision: "pending", note: "", evidence: [] };
    }));
  }, `Prepared deterministic score rehearsals for ${matrixCandidates.length} candidates across ${state.cases.length} cases; no model was called.`);

  const setReviewDecision = (decision: ReviewDecision) => update((draft) => {
    const key = reviewKey(currentCase.id, currentCandidate.id);
    draft.reviews[key] = { ...(draft.reviews[key] ?? { note: "", evidence: [] }), decision };
  }, `Reviewer decision set to ${decision}; no durable review receipt was created.`);

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable in this preview environment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`${state.exportFormat.toUpperCase()} preview copied; no durable write was made.`);
    } catch {
      setStatus("Clipboard write was unavailable; the preview remains renderer-local.");
    }
  };

  const tabs: Array<{ id: StudioTab; label: string; icon: typeof BarChart3 }> = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "cases", label: "Eval cases", icon: Layers3 },
    { id: "rubric", label: "Rubric", icon: SlidersHorizontal },
    { id: "matrix", label: "Matrix", icon: LayoutGrid },
    { id: "compare", label: "Compare", icon: Gauge },
    { id: "review", label: "Review", icon: ShieldCheck },
    { id: "export", label: "Export", icon: FileJson2 },
  ];

  return (
    <section className="model-evaluation-studio" aria-labelledby="model-evaluation-studio-title">
      <header className="model-evaluation-studio__header">
        <div className="model-evaluation-studio__title">
          <span className="eyebrow"><Sparkles size={14} /> Evaluation lab</span>
          <h2 id="model-evaluation-studio-title">Model Evaluation Studio</h2>
          <p>Compose evaluation sets, compare candidate routes, and leave reviewable score evidence in one focused workspace.</p>
        </div>
        <div className="model-evaluation-studio__header-actions">
          <span className="model-evaluation-studio__badge"><Eye size={13} /> Preview only</span>
          <button type="button" className="button button--secondary" onClick={undo} disabled={!history.length} aria-label="Undo evaluation preview change"><Undo2 size={14} /> Undo</button>
          <button type="button" className="button button--secondary" onClick={redo} disabled={!future.length} aria-label="Redo evaluation preview change"><Redo2 size={14} /> Redo</button>
          <button type="button" className="button button--secondary" onClick={reset}><RotateCcw size={14} /> Reset</button>
        </div>
      </header>

      <div className="model-evaluation-studio__boundary" role="note">
        <LockKeyhole size={14} /> Renderer-local rehearsal. No provider request, model training, benchmark claim, native evaluation receipt, or durable write is performed.
      </div>

      <div className="model-evaluation-studio__controls" aria-label="Evaluation studio controls">
        <label><span>Run label</span><input value={state.runName} onChange={(event) => update((draft) => { draft.runName = event.target.value; }, "Updated the renderer-local evaluation run label.")} /></label>
        <label><span>Case search</span><span className="model-evaluation-studio__search"><Search size={14} /><input value={caseSearch} onChange={(event) => setCaseSearch(event.target.value)} placeholder="Search cases, tags, categories" /></span></label>
        <label><span>Status filter</span><span className="model-evaluation-studio__select"><Filter size={14} /><select value={caseFilter} onChange={(event) => setCaseFilter(event.target.value as CaseState | "all")}><option value="all">All cases</option><option value="ready">Ready</option><option value="needs-review">Needs review</option><option value="blocked">Blocked</option></select></span></label>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="model-evaluation-export"><FileJson2 size={14} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      <div className="model-evaluation-studio__metrics" role="status" aria-label="Evaluation studio summary">
        <span><strong>{state.cases.length}</strong><small>eval cases</small></span>
        <span><strong>{selectedCandidateCount}</strong><small>candidate lanes</small></span>
        <span><strong>{rehearsedCount}</strong><small>score rehearsals</small></span>
        <span><strong>{reviewedCount}</strong><small>review decisions</small></span>
        <span><strong>{currentTotal === null ? "—" : `${currentTotal}/100`}</strong><small>selected score</small></span>
      </div>

      <div className="model-evaluation-studio__tabs" role="tablist" aria-label="Model evaluation views">
        {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={state.activeTab === id} aria-controls={`model-evaluation-panel-${id}`} className={state.activeTab === id ? "is-active" : ""} onClick={() => update((draft) => { draft.activeTab = id; }, `Opened ${label} view.`)}><Icon size={14} /> {label}</button>)}
      </div>

      <div className="model-evaluation-studio__body">
        {state.activeTab === "overview" ? (
          <div id="model-evaluation-panel-overview" role="tabpanel" className="model-evaluation-studio__overview">
            <div className="model-evaluation-studio__column">
              <div className="model-evaluation-studio__card-heading"><span><ListIcon /> Selected evaluation case</span><span className={`model-evaluation-studio__state model-evaluation-studio__state--${currentCase.state}`}>{stateLabel[currentCase.state]}</span></div>
              <article className="model-evaluation-studio__selected-case">
                <div><span className="eyebrow">{currentCase.category} · {currentCase.source}</span><h3>{currentCase.title}</h3><p>{currentCase.prompt}</p></div>
                <div className="model-evaluation-studio__expected"><strong>Expected review lens</strong><span>{currentCase.expected}</span></div>
                <div className="model-evaluation-studio__chips">{currentCase.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              </article>
              <div className="model-evaluation-studio__action-row"><button type="button" className="button button--primary" onClick={rehearseScore}><Play size={14} /> Prepare score rehearsal</button><button type="button" className="button button--secondary" onClick={() => update((draft) => { draft.activeTab = "review"; }, "Opened the reviewer workspace.")}><ShieldCheck size={14} /> Open review</button></div>
            </div>
            <div className="model-evaluation-studio__column">
              <div className="model-evaluation-studio__card-heading"><span><Star size={14} /> Candidate queue</span><span className="model-evaluation-studio__muted">{state.candidates.filter((candidate) => candidate.state === "selected").length} selected</span></div>
              <div className="model-evaluation-studio__candidate-list">{state.candidates.map((candidate) => <button key={candidate.id} type="button" className={`model-evaluation-studio__candidate ${candidate.id === currentCandidate.id ? "is-selected" : ""} ${candidate.state === "excluded" ? "is-excluded" : ""}`} onClick={() => update((draft) => { draft.selectedCandidateId = candidate.id; }, `Selected ${candidate.name} for the preview lane.`)}><span className="model-evaluation-studio__candidate-icon"><Gauge size={14} /></span><span className="model-evaluation-studio__candidate-copy"><strong>{candidate.name}</strong><small>{candidate.provider} · {candidate.route}</small><small>{candidate.context}</small></span><span className={`model-evaluation-studio__state model-evaluation-studio__state--${candidate.state}`}>{candidateLabel[candidate.state]}</span></button>)}</div>
              <p className="model-evaluation-studio__hint"><AlertTriangle size={13} /> Candidate labels and scores are illustrative route metadata, not live model availability or benchmark results.</p>
            </div>
          </div>
        ) : null}

        {state.activeTab === "cases" ? (
          <div id="model-evaluation-panel-cases" role="tabpanel" className="model-evaluation-studio__cases-layout">
            <div className="model-evaluation-studio__case-list" role="list" aria-label="Evaluation case list">{visibleCases.map((item) => <button key={item.id} type="button" aria-label={item.title} className={`model-evaluation-studio__case-row ${item.id === currentCase.id ? "is-selected" : ""}`} onClick={() => update((draft) => { draft.selectedCaseId = item.id; }, `Selected evaluation case ${item.title}.`)}><span><strong>{item.title}</strong><small>{item.category} · {item.source}</small></span><span className={`model-evaluation-studio__state model-evaluation-studio__state--${item.state}`}>{stateLabel[item.state]}</span></button>)}</div>
            <article className="model-evaluation-studio__card model-evaluation-studio__case-detail"><div className="model-evaluation-studio__card-heading"><span><Eye size={14} /> Case detail</span><span className="model-evaluation-studio__muted">{currentCase.id}</span></div><h3>{currentCase.title}</h3><p className="model-evaluation-studio__prompt">{currentCase.prompt}</p><div className="model-evaluation-studio__detail-grid"><div><strong>Expected answer lens</strong><span>{currentCase.expected}</span></div><div><strong>Source</strong><span>{currentCase.source}</span></div><div><strong>Tags</strong><span>{currentCase.tags.join(" · ")}</span></div><div><strong>Dispatch</strong><span>Not prepared in this preview</span></div></div><button type="button" className="button button--primary" onClick={rehearseScore}><Play size={14} /> Prepare selected case score</button></article>
          </div>
        ) : null}

        {state.activeTab === "rubric" ? (
          <div id="model-evaluation-panel-rubric" role="tabpanel" className="model-evaluation-studio__rubric">
            <div className="model-evaluation-studio__card-heading"><span><SlidersHorizontal size={14} /> Weighted reviewer rubric</span><span className="model-evaluation-studio__muted">{state.rubric.reduce((sum, item) => sum + item.weight, 0)}% total</span></div>
            <EvaluationRubricWorkbench
              dimensions={state.rubric}
              preset={state.rubricPreset}
              adjudication={state.rubricAdjudication}
              scoreScale={state.rubricScoreScale}
              onChange={(dimensions, options = {}) => update((draft) => {
                draft.rubric = dimensions;
                if (options.preset !== undefined) draft.rubricPreset = options.preset;
                if (options.adjudication !== undefined) draft.rubricAdjudication = options.adjudication;
                if (options.scoreScale !== undefined) draft.rubricScoreScale = options.scoreScale;
              }, options.message ?? "Updated the renderer-local evaluation rubric.")}
              onStatus={setStatus}
            />
            <p className="model-evaluation-studio__hint"><SlidersHorizontal size={13} /> Weight and criterion changes affect only the deterministic score preview. They do not alter a provider evaluator or create a benchmark protocol.</p>
          </div>
        ) : null}

        {state.activeTab === "matrix" ? (
          <div id="model-evaluation-panel-matrix" role="tabpanel" className="model-evaluation-studio__matrix-layout">
            <section className="model-evaluation-studio__matrix-card" aria-label="Evaluation run matrix">
              <div className="model-evaluation-studio__card-heading"><span><LayoutGrid size={14} /> Case × candidate status</span><span className="model-evaluation-studio__muted">{state.cases.length} cases · {matrixCandidates.length} candidate lanes</span></div>
              <p className="model-evaluation-studio__matrix-note">Select a cell to inspect its input and available evidence. Empty cells mean no score rehearsal is recorded in this renderer session.</p>
              <div className="model-evaluation-studio__matrix-scroll" role="region" aria-label="Evaluation matrix grid" tabIndex={0}>
                <div className="model-evaluation-studio__matrix-table" role="table" aria-label="Evaluation cases by candidate lanes" style={{ "--evaluation-matrix-columns": matrixCandidates.length } as CSSProperties}>
                  <div className="model-evaluation-studio__matrix-row model-evaluation-studio__matrix-row--header" role="row">
                    <span role="columnheader">Evaluation case</span>
                    {matrixCandidates.map((candidate) => <span key={candidate.id} role="columnheader" title={`${candidate.name} · ${candidate.provenance}`}>{candidate.name}</span>)}
                  </div>
                  {state.cases.map((item) => (
                    <div className="model-evaluation-studio__matrix-row" role="row" key={item.id}>
                      <span className="model-evaluation-studio__matrix-case" role="rowheader"><strong>{item.title}</strong><small>{item.category} · {stateLabel[item.state]}</small></span>
                      {matrixCandidates.map((candidate) => {
                        const key = reviewKey(item.id, candidate.id);
                        const values = state.scores[key];
                        const total = scoreTotal(values, state.rubric);
                        const review = state.reviews[key];
                        const cellStatus = review && review.decision !== "pending"
                          ? `Reviewed · ${review.decision}`
                          : total !== null ? "Scored · preview" : item.state === "blocked" ? "Case blocked" : "Not rehearsed";
                        const selected = item.id === currentCase.id && candidate.id === currentCandidate.id;
                        return (
                          <div role="cell" key={candidate.id}>
                            <button
                              type="button"
                              className={`model-evaluation-studio__matrix-cell ${selected ? "is-selected" : ""} ${total !== null ? "has-score" : ""}`}
                              aria-label={`${item.title} × ${candidate.name}: ${total === null ? "No score" : `score ${total} of 100`}; ${cellStatus}`}
                              aria-pressed={selected}
                              onClick={() => update((draft) => { draft.selectedCaseId = item.id; draft.selectedCandidateId = candidate.id; }, `Selected ${item.title} × ${candidate.name} in the evaluation matrix.`)}
                            >
                              <strong>{total === null ? "—" : `${total}/100`}</strong><small>{cellStatus}</small>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
              <div className="model-evaluation-studio__matrix-legend"><span><i className="is-scored" /> Score rehearsal available</span><span><i /> No rehearsal recorded</span><span>Blocked case labels are review cues, not execution errors.</span></div>
            </section>

            <aside className="model-evaluation-studio__matrix-inspector" aria-label="Selected evaluation cell inspector">
              <div className="model-evaluation-studio__card-heading"><span><Eye size={14} /> Cell inspector</span><span className="model-evaluation-studio__score-pill">{currentTotal === null ? "Not scored" : `${currentTotal}/100`}</span></div>
              <h3>{currentCase.title}</h3>
              <p className="model-evaluation-studio__matrix-candidate">{currentCandidate.name} · {currentCandidate.provenance} · illustrative route metadata</p>
              <div className="model-evaluation-studio__matrix-evidence">
                <section><strong>Input</strong><p>{currentCase.prompt}</p></section>
                <section><strong>Output</strong><p>Not observed — this preview contains no candidate response.</p></section>
                <section><strong>Assertions</strong><p>Reference lens only: {currentCase.expected} No assertion was executed or marked pass/fail.</p></section>
                <section><strong>Ratings</strong>{currentScore ? <ul>{state.rubric.map((dimension) => <li key={dimension.id}><span>{dimension.label}</span><b>{currentScore[dimension.id]}/100</b></li>)}</ul> : <p>No score rehearsal is recorded for this cell.</p>}<small>Human review: {currentReview.decision === "pending" ? "pending" : currentReview.decision} · {currentReview.evidence.length} evidence cues checked</small></section>
                <section><strong>Usage</strong><p>Not observed — no provider run, token usage, latency, or cost data is present.</p></section>
                <section><strong>Trace</strong><p>Not observed — no run ID, provider events, or execution trace was created.</p></section>
              </div>
              <div className="model-evaluation-studio__action-row"><button type="button" className="button button--primary" onClick={rehearseScore}><Play size={14} /> Prepare score rehearsal</button><button type="button" className="button button--secondary" onClick={() => update((draft) => { draft.activeTab = "review"; }, "Opened reviewer controls for the selected matrix cell.")}><ShieldCheck size={14} /> Review cell</button></div>
              <p className="model-evaluation-studio__boundary"><LockKeyhole size={13} /> Score rehearsals are deterministic heuristics. This inspector does not invent output, assertion results, usage, or trace evidence.</p>
            </aside>
          </div>
        ) : null}

        {state.activeTab === "compare" ? (
          <div id="model-evaluation-panel-compare" role="tabpanel" className="model-evaluation-studio__compare">
            <div className="model-evaluation-studio__card-heading"><span><BarChart3 size={14} /> Candidate comparison</span><span className="model-evaluation-studio__muted">{state.comparisonScope === "all-cases" ? "All evaluation cases" : `Case: ${currentCase.title}`}</span></div>
            <div className="model-evaluation-studio__compare-toolbar" aria-label="Comparison controls">
              <label><span>Comparison scope</span><select aria-label="Comparison scope" value={state.comparisonScope} onChange={(event) => update((draft) => { draft.comparisonScope = event.target.value as ComparisonScope; }, `Switched comparison scope to ${event.target.value === "all-cases" ? "all evaluation cases" : "the selected case"}.`)}><option value="selected-case">Selected case</option><option value="all-cases">All evaluation cases</option></select></label>
              {state.comparisonScope === "all-cases" ? <span className="model-evaluation-studio__compare-scope-note"><Layers3 size={13} /> Aggregate mean uses rehearsed cells only; empty cells remain visible as missing.</span> : <span className="model-evaluation-studio__compare-scope-note"><Eye size={13} /> Dimension-level scores for the selected case.</span>}
            </div>
            <p className="model-evaluation-studio__compare-note">Rank, coverage, and leader delta summarize renderer-local score rehearsals only. A missing dimension or case means no local score was prepared; it is not a provider failure or benchmark result.</p>
            {state.comparisonScope === "all-cases" ? (
              <div className="model-evaluation-studio__compare-layout">
                <div className="model-evaluation-studio__compare-table model-evaluation-studio__aggregate-table" role="table" aria-label="Aggregate candidate score comparison">
                  <div className="model-evaluation-studio__aggregate-row model-evaluation-studio__aggregate-row--header" role="row">
                    <span role="columnheader">Candidate</span><span role="columnheader">Mean</span><span role="columnheader">Cases</span><span role="columnheader">Rubric</span><span role="columnheader">Reviewed</span><span role="columnheader">Accept</span><span role="columnheader">Flag</span><span role="columnheader">Rank</span><span role="columnheader">Δ leader</span>
                  </div>
                  {aggregateComparisonRows.map((row) => <button key={row.candidate.id} type="button" role="row" className={`model-evaluation-studio__aggregate-row ${row.candidate.id === currentCandidate.id ? "is-selected" : ""}`} onClick={() => update((draft) => { draft.selectedCandidateId = row.candidate.id; }, `Selected ${row.candidate.name} for aggregate comparison.`)}>
                    <span><strong>{row.candidate.name}</strong><small>{row.candidate.provenance} · {row.candidate.state}</small></span>
                    <span className="model-evaluation-studio__compare-total">{row.mean === null ? "Not rehearsed" : `${row.mean}/100`}</span><span>{row.scoredCases}/{state.cases.length} · {row.caseCoverage}%</span><span>{row.rubricCoverage}%</span><span>{row.reviewedCells}</span><span>{row.acceptCount}</span><span>{row.flagCount}</span><span className="model-evaluation-studio__compare-rank">{row.rank === null ? "—" : `#${row.rank}`}</span><span>{row.deltaToLeader === null ? "—" : `${row.deltaToLeader >= 0 ? "+" : ""}${row.deltaToLeader}`}</span>
                  </button>)}
                </div>
                <aside className="model-evaluation-studio__compare-inspector" aria-label="Selected aggregate comparison details">
                  <div className="model-evaluation-studio__card-heading"><span><Gauge size={14} /> Aggregate comparison</span><span className="model-evaluation-studio__score-pill">{selectedAggregateComparison.mean === null ? "Not rehearsed" : `${selectedAggregateComparison.mean}/100 mean`}</span></div>
                  <h3>{selectedAggregateComparison.candidate.name}</h3>
                  <div className="model-evaluation-studio__compare-facts"><span><strong>Rank</strong><small>{selectedAggregateComparison.rank === null ? "Unranked" : `#${selectedAggregateComparison.rank}`}</small></span><span><strong>Case coverage</strong><small>{selectedAggregateComparison.caseCoverage}% · {selectedAggregateComparison.scoredCases}/{state.cases.length}</small></span><span><strong>Rubric coverage</strong><small>{selectedAggregateComparison.rubricCoverage}% of all dimensions</small></span><span><strong>Reviewed</strong><small>{selectedAggregateComparison.reviewedCells} cells · {selectedAggregateComparison.acceptCount} accepted</small></span></div>
                  <div className="model-evaluation-studio__compare-missing"><strong>Cases without a score rehearsal</strong>{selectedAggregateComparison.missingCases.length === 0 ? <p>All evaluation cases have at least one local rubric value.</p> : <ul>{selectedAggregateComparison.missingCases.map((item) => <li key={item}>{item}</li>)}</ul>}</div>
                  <p className="model-evaluation-studio__boundary"><LockKeyhole size={13} /> Aggregate mean and coverage are session-local heuristics. They do not prove model quality, provider availability, latency, cost, or evaluator agreement.</p>
                </aside>
              </div>
            ) : (
              <div className="model-evaluation-studio__compare-layout">
                <div className="model-evaluation-studio__compare-table" role="table" aria-label="Candidate score comparison">
                  <div className="model-evaluation-studio__compare-row model-evaluation-studio__compare-row--header" role="row" style={{ "--evaluation-compare-columns": state.rubric.length } as CSSProperties}>
                    <span role="columnheader">Candidate</span><span role="columnheader">Rank</span>{state.rubric.map((dimension) => <span key={dimension.id} role="columnheader">{dimension.label}</span>)}<span role="columnheader">Total</span><span role="columnheader">Coverage</span><span role="columnheader">Δ leader</span>
                  </div>
                  {comparisonRows.map((row) => <button key={row.candidate.id} type="button" role="row" className={`model-evaluation-studio__compare-row ${row.candidate.id === currentCandidate.id ? "is-selected" : ""}`} style={{ "--evaluation-compare-columns": state.rubric.length } as CSSProperties} onClick={() => update((draft) => { draft.selectedCandidateId = row.candidate.id; }, `Selected ${row.candidate.name} for comparison.`)}>
                    <span><strong>{row.candidate.name}</strong><small>{row.candidate.provenance} · {row.candidate.state}</small></span>
                    <span className="model-evaluation-studio__compare-rank">{row.rank === null ? "—" : `#${row.rank}`}</span>
                    {state.rubric.map((dimension) => <span key={dimension.id}>{row.values ? `${row.values[dimension.id]}/100` : "—"}</span>)}
                    <span className="model-evaluation-studio__compare-total">{row.total === null ? "Not rehearsed" : `${row.total}/100`}</span>
                    <span>{row.coverage}%</span>
                    <span>{row.deltaToLeader === null ? "—" : `${row.deltaToLeader >= 0 ? "+" : ""}${row.deltaToLeader}`}</span>
                  </button>)}
                </div>
                <aside className="model-evaluation-studio__compare-inspector" aria-label="Selected comparison details">
                  <div className="model-evaluation-studio__card-heading"><span><Gauge size={14} /> Selected comparison</span><span className="model-evaluation-studio__score-pill">{selectedComparison.total === null ? "Not rehearsed" : `${selectedComparison.total}/100`}</span></div>
                  <h3>{selectedComparison.candidate.name}</h3>
                  <div className="model-evaluation-studio__compare-facts"><span><strong>Rank</strong><small>{selectedComparison.rank === null ? "Unranked" : `#${selectedComparison.rank}`}</small></span><span><strong>Coverage</strong><small>{selectedComparison.coverage}% of rubric dimensions</small></span><span><strong>Delta to leader</strong><small>{selectedComparison.deltaToLeader === null ? "Not available" : `${selectedComparison.deltaToLeader >= 0 ? "+" : ""}${selectedComparison.deltaToLeader} points`}</small></span></div>
                  <div className="model-evaluation-studio__compare-missing"><strong>Missing score dimensions</strong>{selectedComparison.missingDimensions.length === 0 ? <p>All rubric dimensions have a local score rehearsal.</p> : <ul>{selectedComparison.missingDimensions.map((dimension) => <li key={dimension}>{dimension}</li>)}</ul>}</div>
                  <p className="model-evaluation-studio__boundary"><LockKeyhole size={13} /> Coverage counts stored rubric values only. It does not prove model quality, provider availability, latency, cost, or evaluator agreement.</p>
                </aside>
              </div>
            )}
            <div className="model-evaluation-studio__action-row"><button type="button" className="button button--primary" onClick={rehearseScore}><Play size={14} /> Rehearse selected candidate</button>{state.comparisonScope === "all-cases" ? <button type="button" className="button button--secondary" onClick={rehearseAllScores}><Layers3 size={14} /> Prepare all score rehearsals</button> : null}<span className="model-evaluation-studio__hint"><Gauge size={13} /> Scores are deterministic heuristics, not live quality, cost, or latency measurements.</span></div>
          </div>
        ) : null}

        {state.activeTab === "review" ? (
          <div id="model-evaluation-panel-review" role="tabpanel" className="model-evaluation-studio__review-layout"><article className="model-evaluation-studio__card"><div className="model-evaluation-studio__card-heading"><span><ShieldCheck size={14} /> Reviewer decision</span><span className="model-evaluation-studio__muted">{currentCase.title} × {currentCandidate.name}</span></div><div className="model-evaluation-studio__decision-grid">{(["accept", "reject", "flag"] as const).map((decision) => <button key={decision} type="button" className={`model-evaluation-studio__decision model-evaluation-studio__decision--${decision} ${currentReview.decision === decision ? "is-active" : ""}`} onClick={() => setReviewDecision(decision)}>{decision === "accept" ? <CheckCircle2 size={16} /> : decision === "reject" ? <XCircle size={16} /> : <Flag size={16} />}<span><strong>{decision === "accept" ? "Accept" : decision === "reject" ? "Reject" : "Flag for review"}</strong><small>{decision === "accept" ? "Meets the selected rubric." : decision === "reject" ? "Fails a material criterion." : "Needs a second look."}</small></span></button>)}</div><label className="model-evaluation-studio__review-note"><span>Reviewer note</span><textarea value={currentReview.note} placeholder="Write an evidence-bound note for this score..." onChange={(event) => update((draft) => { const key = reviewKey(currentCase.id, currentCandidate.id); draft.reviews[key] = { ...(draft.reviews[key] ?? { decision: "pending", evidence: [] }), note: event.target.value }; }, "Updated the renderer-local reviewer note.")} /></label><div className="model-evaluation-studio__evidence-checks">{["Expected answer covered", "Boundary wording verified", "Source/provenance visible", "Needs second reviewer"].map((label) => <label key={label}><input type="checkbox" checked={currentReview.evidence.includes(label)} onChange={(event) => update((draft) => { const key = reviewKey(currentCase.id, currentCandidate.id); const record = draft.reviews[key] ?? { decision: "pending", note: "", evidence: [] }; record.evidence = event.target.checked ? [...record.evidence, label] : record.evidence.filter((item) => item !== label); draft.reviews[key] = record; }, `Updated evidence checklist: ${label}.`)} /><span>{label}</span></label>)}</div><p className="model-evaluation-studio__boundary"><LockKeyhole size={13} /> Review decisions remain in this renderer session. No evaluator API, training label, or durable approval receipt is created.</p></article><aside className="model-evaluation-studio__card model-evaluation-studio__review-summary"><div className="model-evaluation-studio__card-heading"><span><Gauge size={14} /> Selected evidence</span><span className="model-evaluation-studio__score-pill">{currentTotal === null ? "Not rehearsed" : `${currentTotal}/100`}</span></div><ul>{currentScore ? state.rubric.map((dimension) => <li key={dimension.id}><span>{dimension.label}</span><strong>{currentScore[dimension.id]}/100</strong></li>) : <li className="is-empty">Prepare a score rehearsal to review dimension evidence.</li>}</ul></aside></div>
        ) : null}

        {state.activeTab === "export" ? (
          <div id="model-evaluation-panel-export" role="tabpanel" className="model-evaluation-studio__export"><div className="model-evaluation-studio__export-toolbar"><label><span>Format</span><select value={state.exportFormat} onChange={(event) => update((draft) => { draft.exportFormat = event.target.value as ExportFormat; }, `Selected ${event.target.value.toUpperCase()} export preview.`)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadStudio(exportPayload, state.exportFormat) ? "Browser download started; no native export receipt was created." : "Browser download is unavailable in this preview environment.")}><Download size={14} /> Download</button></div><pre aria-label={`${state.exportFormat === "json" ? "JSON" : "Markdown"} model evaluation export preview`}>{exportPayload}</pre><p className="model-evaluation-studio__hint"><FileJson2 size={13} /> Export contains renderer-visible metadata only; hidden prompts, credentials, provider payloads, and native receipts are not included.</p></div>
        ) : null}
      </div>

      {exportOpen ? <section id="model-evaluation-export" className="model-evaluation-studio__export model-evaluation-studio__export--drawer" aria-label="Model evaluation export preview"><div className="model-evaluation-studio__card-heading"><span><FileJson2 size={14} /> Quick export preview</span><button type="button" className="button button--ghost" onClick={() => setExportOpen(false)}>Close</button></div><pre>{exportPayload}</pre></section> : null}
      <p className="model-evaluation-studio__status" role="status" aria-live="polite">{status}</p>
    </section>
  );
}

function ListIcon() {
  return <Filter size={14} />;
}
