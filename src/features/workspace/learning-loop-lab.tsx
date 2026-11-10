import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clipboard,
  Database,
  Download,
  Eye,
  FileJson2,
  Flag,
  History,
  LockKeyhole,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
  Redo2,
} from "lucide-react";
import { useMemo, useState } from "react";

type LearningEventKind = "signal" | "feedback" | "proposal" | "approval" | "evaluation";
type LearningEventStage = "captured" | "review" | "ready" | "blocked";
type LearningExportFormat = "json" | "markdown";
type LearningBatchObjective = "quality" | "preference" | "safety";
export type LearningReviewCadence = "daily" | "weekly" | "monthly";
type LearningDataRowFilter = "all" | "eligible" | "held";
type LearningDataSplitFilter = "all" | "train" | "validation" | "held-out";
export type LearningReviewDecision = "unreviewed" | "include" | "approval" | "exclude";
type LearningReviewFilter = "all" | LearningReviewDecision;

export type LearningReviewSchedule = {
  enabled: boolean;
  cadence: LearningReviewCadence;
  interval: number;
  startDate: string;
  localTime: string;
  weekday: number;
  monthDay: number;
};

export type LearningEvent = {
  id: string;
  kind: LearningEventKind;
  stage: LearningEventStage;
  title: string;
  detail: string;
  source: string;
  evidence: string;
  impact: string;
  nextAction: string;
  confidence: number;
  occurredAt: string;
};

export type LearningSnapshot = {
  events: LearningEvent[];
  includeFeedback: boolean;
  includeApprovedMemories: boolean;
  includeRunOutcomes: boolean;
  /** Renderer-session triage decisions. Native consent/approval remains unavailable. */
  reviewDecisions?: Record<string, LearningReviewDecision>;
  batchName: string;
  batchObjective: LearningBatchObjective;
  batchLimit: number;
  batchConfidenceFloor: number;
  /** Renderer-session rehearsal only; no timer or native scheduler is created. */
  reviewSchedule?: LearningReviewSchedule;
};

export type LearningDataPreviewRow = {
  id: string;
  title: string;
  source: string;
  split: Exclude<LearningDataSplitFilter, "all">;
  eligibility: "eligible" | "held";
  consent: "approved preview" | "pending review" | "not recorded";
  redaction: "metadata only" | "masked preview";
  retention: "session preview" | "7-day preview" | "30-day preview";
  reviewDecision: LearningReviewDecision;
  reason: string;
};

const seedEvents: LearningEvent[] = [
  {
    id: "loop-feedback-001",
    kind: "feedback",
    stage: "review",
    title: "Helpful answer signal",
    detail: "The user marked a response as accurate and actionable.",
    source: "Message feedback · renderer preview",
    evidence: "Helpful · Accurate · Actionable",
    impact: "Raises confidence in concise coding explanations.",
    nextAction: "Keep as a reviewable positive example.",
    confidence: 0.92,
    occurredAt: "2 min ago",
  },
  {
    id: "loop-feedback-002",
    kind: "feedback",
    stage: "captured",
    title: "Correction signal",
    detail: "A response was marked incomplete and followed by a user correction.",
    source: "Message feedback · renderer preview",
    evidence: "Not helpful · Incomplete",
    impact: "Highlights where answers should expose assumptions earlier.",
    nextAction: "Attach the correction before evaluation.",
    confidence: 0.84,
    occurredAt: "8 min ago",
  },
  {
    id: "loop-memory-001",
    kind: "proposal",
    stage: "review",
    title: "Workflow preference candidate",
    detail: "A repeated request suggests the user prefers UI-first incremental slices.",
    source: "Memory proposal · renderer snapshot",
    evidence: "3 matching conversation signals",
    impact: "Could shape future planning and progress updates.",
    nextAction: "Request explicit approval before activation.",
    confidence: 0.78,
    occurredAt: "14 min ago",
  },
  {
    id: "loop-approval-001",
    kind: "approval",
    stage: "blocked",
    title: "Memory activation gate",
    detail: "A proposed memory is waiting for a user decision.",
    source: "Memory policy · renderer preview",
    evidence: "Approval receipt not available in preview",
    impact: "No durable memory change can occur yet.",
    nextAction: "Keep blocked until a native approval decision exists.",
    confidence: 1,
    occurredAt: "18 min ago",
  },
  {
    id: "loop-eval-001",
    kind: "evaluation",
    stage: "ready",
    title: "Quality checkpoint",
    detail: "The current preview has enough labeled signals for a small evaluation pass.",
    source: "Learning loop inspector · renderer preview",
    evidence: "4 labeled events · 2 outcome classes",
    impact: "Provides a deterministic quality trend, not a trained model.",
    nextAction: "Run the local rubric preview and compare deltas.",
    confidence: 0.7,
    occurredAt: "22 min ago",
  },
  {
    id: "loop-run-001",
    kind: "signal",
    stage: "captured",
    title: "Run outcome captured",
    detail: "A completed renderer run supplied a latency and outcome marker.",
    source: "Run projection · renderer snapshot",
    evidence: "Completed · no provider receipt",
    impact: "Can be used as context for evaluation once native lineage exists.",
    nextAction: "Keep the event local until a durable journal is available.",
    confidence: 0.62,
    occurredAt: "31 min ago",
  },
];

const kindLabels: Record<LearningEventKind, string> = {
  signal: "Signal",
  feedback: "Feedback",
  proposal: "Proposal",
  approval: "Approval",
  evaluation: "Evaluation",
};

const stageLabels: Record<LearningEventStage, string> = {
  captured: "Captured",
  review: "Needs review",
  ready: "Ready",
  blocked: "Blocked",
};

const batchObjectiveLabels: Record<LearningBatchObjective, string> = {
  quality: "Answer quality",
  preference: "User preference",
  safety: "Safety / policy",
};

const reviewDecisionLabels: Record<LearningReviewDecision, string> = {
  unreviewed: "Unreviewed",
  include: "Include",
  approval: "Needs approval",
  exclude: "Exclude",
};

export const DEFAULT_LEARNING_REVIEW_SCHEDULE: LearningReviewSchedule = {
  enabled: false,
  cadence: "weekly",
  interval: 1,
  startDate: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`,
  localTime: "09:00",
  weekday: 1,
  monthDay: 1,
};

const REVIEW_WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const cloneSnapshot = (value: LearningSnapshot): LearningSnapshot => ({
  events: value.events.map((event) => ({ ...event })),
  includeFeedback: value.includeFeedback,
  includeApprovedMemories: value.includeApprovedMemories,
  includeRunOutcomes: value.includeRunOutcomes,
  reviewDecisions: { ...(value.reviewDecisions ?? {}) },
  batchName: value.batchName,
  batchObjective: value.batchObjective,
  batchLimit: value.batchLimit,
  batchConfidenceFloor: value.batchConfidenceFloor,
  reviewSchedule: { ...(value.reviewSchedule ?? DEFAULT_LEARNING_REVIEW_SCHEDULE) },
});

const initialSnapshot: LearningSnapshot = {
  events: seedEvents,
  includeFeedback: true,
  includeApprovedMemories: true,
  includeRunOutcomes: false,
  reviewDecisions: {},
  batchName: "Weekly quality review",
  batchObjective: "quality",
  batchLimit: 12,
  batchConfidenceFloor: 0,
  reviewSchedule: DEFAULT_LEARNING_REVIEW_SCHEDULE,
};

const stageOrder: LearningEventStage[] = ["captured", "review", "ready", "blocked"];

function reviewDecisionFor(snapshot: LearningSnapshot, event: LearningEvent): LearningReviewDecision {
  return snapshot.reviewDecisions?.[event.id] ?? "unreviewed";
}

function isLearningEventEligible(snapshot: LearningSnapshot, event: LearningEvent): boolean {
  const reviewDecision = reviewDecisionFor(snapshot, event);
  if (reviewDecision === "exclude" || reviewDecision === "approval") return false;
  if (event.stage === "blocked") return false;
  if (event.confidence < snapshot.batchConfidenceFloor) return false;
  if (event.kind === "feedback") return snapshot.includeFeedback;
  if (event.kind === "proposal" || event.kind === "approval") return snapshot.includeApprovedMemories;
  if (event.kind === "signal") return snapshot.includeRunOutcomes;
  return true;
}

function selectEligibleLearningEvents(snapshot: LearningSnapshot, events: LearningEvent[]): LearningEvent[] {
  return events.filter((event) => isLearningEventEligible(snapshot, event)).slice(0, snapshot.batchLimit);
}

function stableLearningBucket(id: string): number {
  return Array.from(id).reduce((bucket, character) => ((bucket * 31) + character.charCodeAt(0)) % 10, 7);
}

function parseLearningLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** Calculates a next local review occurrence for display only; it never schedules work. */
export function computeNextLearningReviewOccurrence(input: {
  schedule: LearningReviewSchedule;
  now: Date;
}): Date | null {
  const { schedule, now } = input;
  const anchor = parseLearningLocalDate(schedule.startDate);
  const time = /^(\d{2}):(\d{2})$/.exec(schedule.localTime);
  if (!schedule.enabled || !anchor || !time || !Number.isInteger(schedule.interval) || schedule.interval < 1 || schedule.interval > 365) return null;
  const hours = Number(time[1]);
  const minutes = Number(time[2]);
  if (hours > 23 || minutes > 59) return null;
  if (schedule.cadence === "weekly" && (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6)) return null;
  if (schedule.cadence === "monthly" && (!Number.isInteger(schedule.monthDay) || schedule.monthDay < 1 || schedule.monthDay > 28)) return null;

  const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const anchorDay = dayStart(anchor);
  const today = dayStart(now);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  for (let offset = 0; offset <= 366 * 6; offset += 1) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    if (day < anchorDay) continue;
    let matches = false;
    if (schedule.cadence === "daily") {
      matches = Math.round((day.getTime() - anchorDay.getTime()) / millisecondsPerDay) % schedule.interval === 0;
    } else if (schedule.cadence === "weekly") {
      if (day.getDay() === schedule.weekday) {
        const anchorWeek = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), anchorDay.getDate() - anchorDay.getDay());
        const dayWeek = new Date(day.getFullYear(), day.getMonth(), day.getDate() - day.getDay());
        const weeks = Math.round((dayWeek.getTime() - anchorWeek.getTime()) / (millisecondsPerDay * 7));
        matches = weeks >= 0 && weeks % schedule.interval === 0;
      }
    } else if (schedule.cadence === "monthly") {
      const months = (day.getFullYear() - anchorDay.getFullYear()) * 12 + day.getMonth() - anchorDay.getMonth();
      matches = months >= 0 && months % schedule.interval === 0 && day.getDate() === schedule.monthDay;
    }
    if (!matches) continue;
    const occurrence = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
    if (occurrence.getTime() > now.getTime()) return occurrence;
  }
  return null;
}

function formatLearningOccurrence(value: Date | null): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(value)
    : "No upcoming occurrence in the next six years";
}

function learningPreviewSplit(id: string): LearningDataPreviewRow["split"] {
  const bucket = stableLearningBucket(id);
  if (bucket <= 1) return "validation";
  if (bucket === 9) return "held-out";
  return "train";
}

function learningPreviewReason(snapshot: LearningSnapshot, event: LearningEvent, eligible: boolean): string {
  const reviewDecision = reviewDecisionFor(snapshot, event);
  if (reviewDecision === "exclude") return "Excluded by the renderer-session review decision.";
  if (reviewDecision === "approval") return "Held until an explicit approval decision is available.";
  if (event.stage === "blocked") return "Blocked stage; native approval evidence is unavailable.";
  if (event.confidence < snapshot.batchConfidenceFloor) return "Below the current confidence floor.";
  if (event.kind === "feedback" && !snapshot.includeFeedback) return "Feedback excluded by the local input policy.";
  if ((event.kind === "proposal" || event.kind === "approval") && !snapshot.includeApprovedMemories) return "Memory-derived signal excluded by the local input policy.";
  if (event.kind === "signal" && !snapshot.includeRunOutcomes) return "Run outcomes excluded by the local input policy.";
  return eligible ? "Eligible under the current renderer policy." : "Held by the current renderer policy.";
}

export function buildLearningDataPreview(snapshot: LearningSnapshot, events: LearningEvent[] = snapshot.events): LearningDataPreviewRow[] {
  return events.map((event) => {
    const eligible = isLearningEventEligible(snapshot, event);
    const consent = event.kind === "proposal" || event.kind === "approval"
      ? "pending review"
      : event.kind === "feedback"
        ? "approved preview"
        : "not recorded";
    return {
      id: event.id,
      title: event.title,
      source: event.source,
      split: learningPreviewSplit(event.id),
      eligibility: eligible ? "eligible" : "held",
      consent,
      redaction: event.kind === "proposal" || event.kind === "approval" ? "masked preview" : "metadata only",
      retention: event.kind === "feedback" ? "30-day preview" : event.kind === "signal" ? "7-day preview" : "session preview",
      reviewDecision: reviewDecisionFor(snapshot, event),
      reason: learningPreviewReason(snapshot, event, eligible),
    };
  });
}

function serializeLearningLoop(snapshot: LearningSnapshot, events: LearningEvent[], format: LearningExportFormat): string {
  const eligibleEvents = selectEligibleLearningEvents(snapshot, events);
  const dataPreview = buildLearningDataPreview(snapshot, events);
  const payload = {
    schema: "omnia.learning-loop-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    policy: {
      includeFeedback: snapshot.includeFeedback,
      includeApprovedMemories: snapshot.includeApprovedMemories,
      includeRunOutcomes: snapshot.includeRunOutcomes,
    },
    batch: {
      name: snapshot.batchName,
      objective: snapshot.batchObjective,
      limit: snapshot.batchLimit,
      confidenceFloor: snapshot.batchConfidenceFloor,
      eligibleEventIds: eligibleEvents.map((event) => event.id),
      reviewDecisions: Object.fromEntries(events.map((event) => [event.id, reviewDecisionFor(snapshot, event)])),
    },
    schedulePreview: {
      ...((snapshot.reviewSchedule ?? DEFAULT_LEARNING_REVIEW_SCHEDULE)),
      nextOccurrence: formatLearningOccurrence(computeNextLearningReviewOccurrence({
        schedule: snapshot.reviewSchedule ?? DEFAULT_LEARNING_REVIEW_SCHEDULE,
        now: new Date(),
      })),
      boundary: "Display-only local calculation; no timer, background job, notification, scheduler, or review batch is created.",
    },
    dataPreview: {
      rowCount: dataPreview.length,
      eligibleRowCount: dataPreview.filter((row) => row.eligibility === "eligible").length,
      heldRowCount: dataPreview.filter((row) => row.eligibility === "held").length,
      rawPayloadIncluded: false,
      fields: ["id", "title", "source", "split", "eligibility", "consent", "redaction", "retention", "reviewDecision", "reason"],
    },
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      stage: event.stage,
      title: event.title,
      source: event.source,
      evidence: event.evidence,
      confidence: event.confidence,
      occurredAt: event.occurredAt,
      reviewDecision: reviewDecisionFor(snapshot, event),
    })),
  };

  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia learning loop preview",
    "",
    "> Renderer-local preview. No model training, provider request, or durable write is performed.",
    "",
    `Policy: feedback=${snapshot.includeFeedback ? "included" : "excluded"}; approved memories=${snapshot.includeApprovedMemories ? "included" : "excluded"}; run outcomes=${snapshot.includeRunOutcomes ? "included" : "excluded"}.`,
    `Batch: ${snapshot.batchName} · objective=${batchObjectiveLabels[snapshot.batchObjective]} · limit=${snapshot.batchLimit} · confidence>=${Math.round(snapshot.batchConfidenceFloor * 100)}% · eligible=${eligibleEvents.length}.`,
    `Review schedule: ${(snapshot.reviewSchedule ?? DEFAULT_LEARNING_REVIEW_SCHEDULE).enabled ? "enabled draft" : "paused"} · ${formatLearningOccurrence(computeNextLearningReviewOccurrence({ schedule: snapshot.reviewSchedule ?? DEFAULT_LEARNING_REVIEW_SCHEDULE, now: new Date() }))} · no scheduler is created.`,
    `Data preview: ${dataPreview.length} metadata rows · ${dataPreview.filter((row) => row.eligibility === "eligible").length} eligible · raw payload excluded.`,
    "",
    ...events.map((event) => `- **${event.title}** — ${kindLabels[event.kind]} · ${stageLabels[event.stage]} · ${reviewDecisionLabels[reviewDecisionFor(snapshot, event)]} · ${Math.round(event.confidence * 100)}% confidence`),
  ].join("\n");
}

function downloadLearningLoop(payload: string, format: LearningExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-learning-loop-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function stageForAdvance(event: LearningEvent): LearningEventStage {
  if (event.stage === "blocked") return "review";
  if (event.stage === "captured") return "review";
  if (event.stage === "review") return "ready";
  return "ready";
}

export default function LearningLoopLab() {
  const [history, setHistory] = useState<{ past: LearningSnapshot[]; present: LearningSnapshot; future: LearningSnapshot[] }>({
    past: [],
    present: cloneSnapshot(initialSnapshot),
    future: [],
  });
  const [kindFilter, setKindFilter] = useState<LearningEventKind | "all">("all");
  const [stageFilter, setStageFilter] = useState<LearningEventStage | "all">("all");
  const [reviewFilter, setReviewFilter] = useState<LearningReviewFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(seedEvents[0]?.id ?? null);
  const [exportFormat, setExportFormat] = useState<LearningExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [dataPreviewOpen, setDataPreviewOpen] = useState(false);
  const [dataRowFilter, setDataRowFilter] = useState<LearningDataRowFilter>("all");
  const [dataSplitFilter, setDataSplitFilter] = useState<LearningDataSplitFilter>("all");
  const [status, setStatus] = useState("Learning events are renderer-local preview facts.");

  const { present } = history;
  const reviewSchedule = present.reviewSchedule ?? DEFAULT_LEARNING_REVIEW_SCHEDULE;
  const nextReviewOccurrence = useMemo(() => computeNextLearningReviewOccurrence({ schedule: reviewSchedule, now: new Date() }), [reviewSchedule]);
  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return present.events.filter((event) => {
      if (kindFilter !== "all" && event.kind !== kindFilter) return false;
      if (stageFilter !== "all" && event.stage !== stageFilter) return false;
      if (reviewFilter !== "all" && reviewDecisionFor(present, event) !== reviewFilter) return false;
      if (!normalized) return true;
      return `${event.title} ${event.detail} ${event.source} ${event.evidence}`.toLowerCase().includes(normalized);
    });
  }, [kindFilter, present, query, reviewFilter, stageFilter]);

  const selected = filteredEvents.find((event) => event.id === selectedId)
    ?? present.events.find((event) => event.id === selectedId)
    ?? filteredEvents[0]
    ?? null;
  const metrics = useMemo(() => ({
    total: present.events.length,
    review: present.events.filter((event) => event.stage === "review").length,
    ready: present.events.filter((event) => event.stage === "ready").length,
    blocked: present.events.filter((event) => event.stage === "blocked").length,
    confidence: present.events.length === 0 ? 0 : Math.round((present.events.reduce((sum, event) => sum + event.confidence, 0) / present.events.length) * 100),
  }), [present.events]);
  const eligibleEvents = useMemo(() => selectEligibleLearningEvents(present, present.events), [present]);
  const evaluationSummary = useMemo(() => {
    const highConfidence = eligibleEvents.filter((event) => event.confidence >= 0.8).length;
    const needsReview = eligibleEvents.filter((event) => event.stage === "review").length;
    const ready = eligibleEvents.filter((event) => event.stage === "ready").length;
    const meanConfidence = eligibleEvents.length === 0
      ? 0
      : Math.round((eligibleEvents.reduce((sum, event) => sum + event.confidence, 0) / eligibleEvents.length) * 100);
    return { highConfidence, needsReview, ready, meanConfidence };
  }, [eligibleEvents]);
  const dataPreviewRows = useMemo(() => buildLearningDataPreview(present), [present]);
  const visibleDataPreviewRows = useMemo(() => dataPreviewRows.filter((row) => {
    if (dataRowFilter !== "all" && row.eligibility !== dataRowFilter) return false;
    if (dataSplitFilter !== "all" && row.split !== dataSplitFilter) return false;
    return true;
  }), [dataPreviewRows, dataRowFilter, dataSplitFilter]);
  const exportPayload = useMemo(() => serializeLearningLoop(present, filteredEvents, exportFormat), [exportFormat, filteredEvents, present]);

  const commit = (next: LearningSnapshot, message: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneSnapshot(current.present)],
      present: cloneSnapshot(next),
      future: [],
    }));
    setStatus(message);
  };

  const updateEvent = (eventId: string, patch: Partial<LearningEvent>, message: string) => {
    commit({
      ...present,
      events: present.events.map((event) => event.id === eventId ? { ...event, ...patch } : event),
    }, message);
  };

  const updateReviewDecision = (eventId: string, decision: LearningReviewDecision) => {
    const reviewDecisions = { ...(present.reviewDecisions ?? {}) };
    if (decision === "unreviewed") delete reviewDecisions[eventId];
    else reviewDecisions[eventId] = decision;
    commit({ ...present, reviewDecisions }, `${reviewDecisionLabels[decision]} decision staged in the renderer preview.`);
  };

  const togglePolicy = (key: "includeFeedback" | "includeApprovedMemories" | "includeRunOutcomes") => {
    commit({ ...present, [key]: !present[key] }, "Learning data policy changed in the renderer preview.");
  };

  const updateBatch = <K extends "batchName" | "batchObjective" | "batchLimit" | "batchConfidenceFloor">(key: K, value: LearningSnapshot[K]) => {
    commit({ ...present, [key]: value }, "Review batch configuration changed in the renderer preview.");
  };

  const updateReviewSchedule = (patch: Partial<LearningReviewSchedule>) => {
    commit({ ...present, reviewSchedule: { ...reviewSchedule, ...patch } }, "Review schedule rehearsal changed in the renderer preview.");
  };

  const simulateEvaluation = () => {
    if (eligibleEvents.length === 0) {
      setStatus("No eligible events are available for this renderer-local batch preview.");
      return;
    }
    const average = Math.round((eligibleEvents.reduce((sum, event) => sum + event.confidence, 0) / eligibleEvents.length) * 100);
    setStatus(`Simulated ${present.batchName}: ${eligibleEvents.length} examples · ${average}% confidence. No model was trained.`);
  };

  const advanceSelected = () => {
    if (!selected) return;
    updateEvent(selected.id, { stage: stageForAdvance(selected) }, `${selected.title} advanced in the renderer preview.`);
  };

  const replaySelected = () => {
    if (!selected) return;
    updateEvent(selected.id, { stage: "captured", occurredAt: "just now" }, `${selected.title} replayed as a captured preview signal.`);
  };

  const resetSelected = () => {
    if (!selected) return;
    const original = seedEvents.find((event) => event.id === selected.id);
    if (!original) return;
    updateEvent(selected.id, original, `${selected.title} reset to the seeded renderer preview.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      setStatus("Undid the last learning-loop preview change.");
      return { past: current.past.slice(0, -1), present: cloneSnapshot(previous), future: [cloneSnapshot(current.present), ...current.future] };
    });
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      setStatus("Redid the next learning-loop preview change.");
      return { past: [...current.past, cloneSnapshot(current.present)], present: cloneSnapshot(next), future: current.future.slice(1) };
    });
  };

  const resetAll = () => {
    if (JSON.stringify(present) === JSON.stringify(initialSnapshot)) {
      setStatus("Learning loop preview is already at its defaults.");
      return;
    }
    commit(initialSnapshot, "Learning loop preview reset to defaults.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no learning-loop preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied ${filteredEvents.length} learning-loop events as ${exportFormat.toUpperCase()}.`);
    } catch {
      setStatus("Clipboard access was denied; no learning-loop preview was copied.");
    }
  };

  return (
    <section className="learning-loop" aria-label="Learning loop lab">
      <header className="learning-loop__header">
        <div><span className="eyebrow">Learning loop lab</span><h3>Make improvement inspectable</h3><p>Trace feedback, memory proposals, approvals, and evaluation without silently training a model.</p></div>
        <span className="memory-studio__chip memory-studio__chip--amber"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="learning-loop__metrics" role="status" aria-label="Learning loop summary">
        <div><strong>{metrics.total}</strong><span>events</span></div>
        <div><strong>{metrics.review}</strong><span>needs review</span></div>
        <div><strong>{metrics.ready}</strong><span>ready</span></div>
        <div><strong>{metrics.confidence}%</strong><span>mean confidence</span></div>
      </div>

      <div className="learning-loop__stages" aria-label="Learning loop stages">
        {stageOrder.map((stage, index) => <div key={stage} className={`learning-loop__stage learning-loop__stage--${stage}`}><span>{index + 1}</span><strong>{stageLabels[stage]}</strong><small>{present.events.filter((event) => event.stage === stage).length} events</small></div>)}
      </div>

      <div className="learning-loop__toolbar" role="toolbar" aria-label="Learning loop filters and history">
        <label className="learning-loop__search"><Activity size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search learning loop events" placeholder="Search feedback, source, or evidence" /></label>
        <label><span>Kind</span><select aria-label="Learning loop kind" value={kindFilter} onChange={(event) => setKindFilter(event.target.value as LearningEventKind | "all")}><option value="all">All kinds</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Stage</span><select aria-label="Learning loop stage" value={stageFilter} onChange={(event) => setStageFilter(event.target.value as LearningEventStage | "all")}><option value="all">All stages</option>{Object.entries(stageLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Review</span><select aria-label="Learning loop review decision" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as LearningReviewFilter)}><option value="all">All decisions</option>{Object.entries(reviewDecisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo learning loop preview change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo learning loop preview change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={resetAll} aria-label="Reset learning loop preview"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--ghost" onClick={() => setBatchOpen((current) => !current)} aria-expanded={batchOpen} aria-controls="learning-loop-batch"><Flag size={13} /> {batchOpen ? "Hide batch" : "Review batch"}</button>
        <button type="button" className="button button--ghost" onClick={() => setScheduleOpen((current) => !current)} aria-expanded={scheduleOpen} aria-controls="learning-loop-schedule"><CalendarClock size={13} /> {scheduleOpen ? "Hide schedule" : "Review schedule"}</button>
        <button type="button" className="button button--ghost" onClick={() => setDataPreviewOpen((current) => !current)} aria-expanded={dataPreviewOpen} aria-controls="learning-loop-data-preview"><Database size={13} /> {dataPreviewOpen ? "Hide data" : "Data preview"}</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="learning-loop-export"><FileJson2 size={14} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      <div className="learning-loop__policy" aria-label="Learning data policy">
        <div><ShieldCheck size={15} /><span><strong>Input policy</strong><small>Choose which renderer events would be eligible for a future review batch.</small></span></div>
        <label><input type="checkbox" checked={present.includeFeedback} onChange={() => togglePolicy("includeFeedback")} /> Feedback</label>
        <label><input type="checkbox" checked={present.includeApprovedMemories} onChange={() => togglePolicy("includeApprovedMemories")} /> Approved memories</label>
        <label><input type="checkbox" checked={present.includeRunOutcomes} onChange={() => togglePolicy("includeRunOutcomes")} /> Run outcomes</label>
      </div>

      {batchOpen ? <section id="learning-loop-batch" className="learning-loop__batch" aria-label="Learning review batch preview">
        <header><div><span className="eyebrow">Review batch preview</span><h4>Shape the next evaluation slice</h4></div><span className="memory-studio__chip memory-studio__chip--teal">Renderer-local</span></header>
        <div className="learning-loop__batch-controls">
          <label><span>Batch name</span><input aria-label="Learning batch name" value={present.batchName} onChange={(event) => updateBatch("batchName", event.target.value)} /></label>
          <label><span>Objective</span><select aria-label="Learning batch objective" value={present.batchObjective} onChange={(event) => updateBatch("batchObjective", event.target.value as LearningBatchObjective)}><option value="quality">Answer quality</option><option value="preference">User preference</option><option value="safety">Safety / policy</option></select></label>
          <label><span>Max examples</span><input aria-label="Learning batch maximum examples" type="number" min={1} max={100} value={present.batchLimit} onChange={(event) => updateBatch("batchLimit", Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /></label>
          <label><span>Min confidence</span><input aria-label="Learning batch minimum confidence" type="number" min={0} max={100} step={5} value={Math.round(present.batchConfidenceFloor * 100)} onChange={(event) => updateBatch("batchConfidenceFloor", Math.min(1, Math.max(0, Number(event.target.value) / 100 || 0)))} /></label>
        </div>
        <div className="learning-loop__batch-summary"><strong>{eligibleEvents.length} eligible examples</strong><span>from {present.events.length} renderer events · blocked events excluded</span><button type="button" className="button button--secondary" onClick={simulateEvaluation}><Play size={13} /> Simulate evaluation</button></div>
        <div className="learning-loop__batch-metrics" role="status" aria-label="Learning batch evaluation summary">
          <div><strong>{evaluationSummary.meanConfidence}%</strong><span>mean confidence</span></div>
          <div><strong>{evaluationSummary.highConfidence}</strong><span>high-confidence</span></div>
          <div><strong>{evaluationSummary.needsReview}</strong><span>needs review</span></div>
          <div><strong>{evaluationSummary.ready}</strong><span>ready</span></div>
        </div>
        <div className="learning-loop__batch-list" role="list" aria-label="Eligible learning batch events">
          {eligibleEvents.length === 0 ? <span className="learning-loop__batch-empty">Enable an input policy or advance an event to stage a local example.</span> : eligibleEvents.map((event) => <span key={event.id} role="listitem" className="learning-loop__batch-item"><CheckCircle2 size={13} /> {event.title}<small>{kindLabels[event.kind]} · {Math.round(event.confidence * 100)}%</small></span>)}
        </div>
        <p className="learning-loop__batch-boundary"><LockKeyhole size={13} /> This only previews a labeled review slice. It does not train, fine-tune, upload, approve, checkpoint, or change provider weights.</p>
      </section> : null}

      {scheduleOpen ? <section id="learning-loop-schedule" className="learning-loop__schedule" aria-label="Learning review schedule preview">
        <header><div><span className="eyebrow">Review cadence · configuration rehearsal</span><h4>Plan the next human review</h4><p>Set a cadence for a future review queue. The date below is calculated locally from this draft.</p></div><span className="memory-studio__chip memory-studio__chip--amber">Preview only</span></header>
        <label className="learning-loop__schedule-toggle"><input aria-label="Enable review schedule draft" type="checkbox" checked={reviewSchedule.enabled} onChange={(event) => updateReviewSchedule({ enabled: event.target.checked })} /><span><strong>Enable schedule draft</strong><small>This changes only the visible renderer-session configuration.</small></span></label>
        <div className="learning-loop__schedule-fields">
          <label><span>Cadence</span><select aria-label="Learning review cadence" value={reviewSchedule.cadence} onChange={(event) => updateReviewSchedule({ cadence: event.target.value as LearningReviewCadence })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
          <label><span>Repeat every</span><span className="learning-loop__schedule-interval"><input aria-label="Learning review interval" type="number" min={1} max={365} value={reviewSchedule.interval} onChange={(event) => updateReviewSchedule({ interval: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })} /><small>{reviewSchedule.cadence === "daily" ? "day(s)" : reviewSchedule.cadence === "weekly" ? "week(s)" : "month(s)"}</small></span></label>
          {reviewSchedule.cadence === "weekly" ? <label><span>Review day</span><select aria-label="Learning review weekday" value={reviewSchedule.weekday} onChange={(event) => updateReviewSchedule({ weekday: Number(event.target.value) })}>{REVIEW_WEEKDAY_LABELS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label> : null}
          {reviewSchedule.cadence === "monthly" ? <label><span>Day of month</span><select aria-label="Learning review month day" value={reviewSchedule.monthDay} onChange={(event) => updateReviewSchedule({ monthDay: Number(event.target.value) })}>{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}</select></label> : null}
          <label><span>Start date</span><input aria-label="Learning review start date" type="date" value={reviewSchedule.startDate} onChange={(event) => updateReviewSchedule({ startDate: event.target.value })} /></label>
          <label><span>Local review time</span><input aria-label="Learning review time" type="time" value={reviewSchedule.localTime} onChange={(event) => updateReviewSchedule({ localTime: event.target.value })} /></label>
        </div>
        <div className="learning-loop__schedule-next" aria-label="Next learning review occurrence"><CalendarClock size={15} /><span><strong>{reviewSchedule.enabled ? formatLearningOccurrence(nextReviewOccurrence) : "Paused · no occurrence preview"}</strong><small>{reviewSchedule.cadence === "daily" ? `Every ${reviewSchedule.interval} day(s)` : reviewSchedule.cadence === "weekly" ? `Every ${reviewSchedule.interval} week(s) on ${REVIEW_WEEKDAY_LABELS[reviewSchedule.weekday]}` : `Every ${reviewSchedule.interval} month(s) on day ${reviewSchedule.monthDay}`} · {Intl.DateTimeFormat().resolvedOptions().timeZone || "Local timezone"}</small></span></div>
        <p className="learning-loop__schedule-boundary"><LockKeyhole size={13} /> Renderer-local schedule rehearsal only: no timer, background task, reminder, notification, review execution, training, or durable scheduler is created.</p>
      </section> : null}

      {dataPreviewOpen ? <section id="learning-loop-data-preview" className="learning-loop__data-preview" aria-label="Learning data preview">
        <header><div><span className="eyebrow">Data inventory / split preview</span><h4>Inspect what a future batch would see</h4><p>Metadata-only rows expose source, consent, redaction, retention, and eligibility without revealing raw message payloads.</p></div><span className="memory-studio__chip memory-studio__chip--teal">No raw payload</span></header>
        <div className="learning-loop__data-summary" role="status" aria-label="Learning data preview summary">
          <div><strong>{dataPreviewRows.length}</strong><span>visible rows</span></div>
          <div><strong>{dataPreviewRows.filter((row) => row.eligibility === "eligible").length}</strong><span>eligible</span></div>
          <div><strong>{dataPreviewRows.filter((row) => row.eligibility === "held").length}</strong><span>held / excluded</span></div>
          <div><strong>{dataPreviewRows.filter((row) => row.redaction === "masked preview").length}</strong><span>masked preview</span></div>
        </div>
        <div className="learning-loop__data-toolbar" role="toolbar" aria-label="Learning data preview filters">
          <label><span>Rows</span><select aria-label="Learning data row filter" value={dataRowFilter} onChange={(event) => setDataRowFilter(event.target.value as LearningDataRowFilter)}><option value="all">All rows</option><option value="eligible">Eligible only</option><option value="held">Held / excluded</option></select></label>
          <label><span>Preview split</span><select aria-label="Learning data split filter" value={dataSplitFilter} onChange={(event) => setDataSplitFilter(event.target.value as LearningDataSplitFilter)}><option value="all">All splits</option><option value="train">Train preview</option><option value="validation">Validation preview</option><option value="held-out">Held-out preview</option></select></label>
          <span className="learning-loop__data-count" role="status" aria-live="polite">Showing {visibleDataPreviewRows.length} of {dataPreviewRows.length} metadata rows</span>
        </div>
        <div className="learning-loop__data-table" role="table" aria-label="Learning data preview rows">
          <div className="learning-loop__data-row learning-loop__data-row--header" role="row"><span role="columnheader">Source</span><span role="columnheader">Split</span><span role="columnheader">Eligibility</span><span role="columnheader">Review / consent</span></div>
          {visibleDataPreviewRows.length === 0 ? <div className="learning-loop__data-empty" role="row"><span role="cell">No data rows match the current filters.</span></div> : visibleDataPreviewRows.map((row) => <div key={row.id} className={`learning-loop__data-row learning-loop__data-row--${row.eligibility}`} role="row"><span className="learning-loop__data-source" role="cell"><strong>{row.title}</strong><small>{row.source}</small></span><span role="cell"><em className="learning-loop__data-chip">{row.split}</em></span><span role="cell"><em className={`learning-loop__data-chip learning-loop__data-chip--${row.eligibility}`}>{row.eligibility === "eligible" ? "Eligible" : "Held"}</em><small>{row.reason}</small></span><span role="cell"><strong>{reviewDecisionLabels[row.reviewDecision]}</strong><small>{row.consent} · {row.redaction} · {row.retention}</small></span></div>)}
        </div>
        <p className="learning-loop__data-boundary"><LockKeyhole size={13} /> This is a deterministic renderer-session projection. It does not read hidden files, collect system-wide keys, approve consent, create a durable dataset, upload records, or imply that train/validation splits were dispatched.</p>
      </section> : null}

      {exportOpen ? <section id="learning-loop-export" className="learning-loop__export" aria-label="Learning loop export preview">
        <header><div><span className="eyebrow">Renderer-local export</span><h4>{filteredEvents.length} filtered events</h4></div><span className="memory-studio__chip memory-studio__chip--teal">No durable write</span></header>
        <div className="learning-loop__export-toolbar"><label><span>Format</span><select aria-label="Learning loop export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as LearningExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><span className="learning-loop__status" role="status" aria-live="polite">{status}</span><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadLearningLoop(exportPayload, exportFormat) ? "Downloaded a renderer-local learning-loop preview." : "Download is unavailable; no preview was exported.")}><Download size={14} /> Download</button></div>
        <pre className="learning-loop__code" tabIndex={0}><code>{exportPayload}</code></pre>
      </section> : null}

      <div className="learning-loop__layout">
        <div className="learning-loop__events" role="list" aria-label="Learning loop events">
          {filteredEvents.length === 0 ? <div className="memory-studio__empty"><Flag size={20} /><strong>No learning events match</strong><span>Adjust the filters or reset the preview.</span></div> : null}
          {filteredEvents.map((event) => <button key={event.id} type="button" aria-pressed={selected?.id === event.id} className={`learning-loop__event${selected?.id === event.id ? " learning-loop__event--selected" : ""}`} onClick={() => setSelectedId(event.id)}><span className={`learning-loop__event-icon learning-loop__event-icon--${event.kind}`} aria-hidden="true">{event.kind === "feedback" ? <CheckCircle2 size={15} /> : event.kind === "proposal" ? <Sparkles size={15} /> : event.kind === "approval" ? <ShieldCheck size={15} /> : event.kind === "evaluation" ? <Eye size={15} /> : <Activity size={15} />}</span><span className="learning-loop__event-copy"><strong>{event.title}</strong><small>{kindLabels[event.kind]} · {stageLabels[event.stage]} · {event.occurredAt}</small><em>{Math.round(event.confidence * 100)}% confidence</em></span></button>)}
        </div>
        <aside className="learning-loop__detail" aria-label="Selected learning loop event">
          {selected ? <>
            <header><div><span className="eyebrow">Selected event</span><h4>{selected.title}</h4></div><span className={`memory-studio__chip memory-studio__chip--${selected.stage === "ready" ? "teal" : selected.stage === "blocked" ? "amber" : "active"}`}>{stageLabels[selected.stage]}</span></header>
            <p className="learning-loop__detail-copy">{selected.detail}</p>
            <dl className="memory-studio__facts"><div><dt>Kind</dt><dd>{kindLabels[selected.kind]}</dd></div><div><dt>Source</dt><dd>{selected.source}</dd></div><div><dt>Evidence</dt><dd>{selected.evidence}</dd></div><div><dt>Review decision</dt><dd>{reviewDecisionLabels[reviewDecisionFor(present, selected)]}</dd></div><div><dt>Impact</dt><dd>{selected.impact}</dd></div><div><dt>Next action</dt><dd>{selected.nextAction}</dd></div></dl>
            <div className="learning-loop__review-actions" role="group" aria-label="Learning event review decision"><span>Review decision</span><button type="button" className="button button--secondary" aria-pressed={reviewDecisionFor(present, selected) === "include"} onClick={() => updateReviewDecision(selected.id, "include")}>Include</button><button type="button" className="button button--ghost" aria-pressed={reviewDecisionFor(present, selected) === "approval"} onClick={() => updateReviewDecision(selected.id, "approval")}>Needs approval</button><button type="button" className="button button--ghost" aria-pressed={reviewDecisionFor(present, selected) === "exclude"} onClick={() => updateReviewDecision(selected.id, "exclude")}>Exclude</button><button type="button" className="button button--ghost" aria-pressed={reviewDecisionFor(present, selected) === "unreviewed"} onClick={() => updateReviewDecision(selected.id, "unreviewed")}>Clear</button></div>
            <div className="learning-loop__actions"><button type="button" className="button button--secondary" onClick={advanceSelected}><Play size={14} /> Advance preview</button><button type="button" className="button button--ghost" onClick={replaySelected}><History size={14} /> Replay signal</button><button type="button" className="button button--ghost" onClick={resetSelected}><RotateCcw size={14} /> Reset event</button></div>
            <p className="learning-loop__detail-status" role="status">{status}</p>
          </> : <div className="memory-studio__empty"><AlertTriangle size={20} /><strong>Select a learning event</strong><span>Its evidence and next action will appear here.</span></div>}
        </aside>
      </div>

      <div className="learning-loop__boundary"><LockKeyhole size={14} /><span>Renderer-local only: no model training, weight update, provider upload, native approval, durable memory write, or checkpoint is performed by this lab.</span></div>
    </section>
  );
}
