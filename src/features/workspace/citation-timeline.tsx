import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleDashed,
  Clipboard,
  Clock3,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  Globe2,
  Hash,
  Link2,
  MessageSquareText,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  Search,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { normalizeExternalHttpUrl } from "@/lib/external-url";

import {
  auditRunTimeline,
  effectiveCitationVerification,
  orderCitations,
  type CitationSourceType,
  type CitationVerificationState,
  type CitationView,
  type RunTimelineEventView,
  type RunTimelineSource,
  type RunTimelineStage,
  type RunTimelineStatus,
} from "./evidence-types";
import type { RunJournalHandoffProjection } from "./run-journal-handoff";
import {
  downloadRunTimelineExport,
  describeRunTimelineCoverage,
  serializeRunTimelineExport,
  type RunTimelineExportFormat,
  type RunTimelineReplayCoverage,
} from "./run-timeline-export";

const verificationCopy: Record<
  CitationVerificationState,
  { label: string; description: string }
> = {
  verified: {
    label: "Verified",
    description: "The persisted source span is present in the frozen run snapshot.",
  },
  unverified: {
    label: "Not verified",
    description: "The source is retained, but frozen-span verification is incomplete.",
  },
  mismatch: {
    label: "Mismatch",
    description: "The current source no longer matches the persisted citation evidence.",
  },
  unavailable: {
    label: "Unavailable",
    description: "The cited source cannot currently be opened or rechecked.",
  },
};

function sourceIcon(sourceType: CitationSourceType) {
  if (sourceType === "web" || sourceType === "connected-source") return <Globe2 size={15} />;
  if (sourceType === "conversation") return <MessageSquareText size={15} />;
  if (sourceType === "workspace") return <FileSearch size={15} />;
  return <FileText size={15} />;
}

function verificationIcon(state: CitationVerificationState) {
  if (state === "verified") return <ShieldCheck size={14} />;
  if (state === "mismatch") return <ShieldAlert size={14} />;
  if (state === "unavailable") return <XCircle size={14} />;
  return <CircleDashed size={14} />;
}

function formatEvidenceTime(value: string | null): string {
  if (!value) return "Not retained";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export interface CitationMarkerProps {
  citation: CitationView;
  onOpen: (citation: CitationView, markerId: string) => void;
}

export function CitationMarker({ citation, onOpen }: CitationMarkerProps) {
  const markerId = `citation-marker-${citation.id}`;
  const verification = effectiveCitationVerification(citation);
  const verificationLabel = verificationCopy[verification].label;

  return (
    <button
      id={markerId}
      type="button"
      className={`citation-marker citation-marker--${verification}`}
      aria-label={`Citation ${citation.displayIndex}: ${citation.title}. ${verificationLabel}.`}
      title={`${citation.title} · ${verificationLabel}`}
      onClick={() => onOpen(citation, markerId)}
    >
      {citation.displayIndex}
    </button>
  );
}

interface CitationStripProps {
  citations: readonly CitationView[];
  onOpen: (citation: CitationView, markerId: string) => void;
}

export function CitationStrip({ citations, onOpen }: CitationStripProps) {
  const ordered = orderCitations(citations);
  if (ordered.length === 0) return null;

  return (
    <aside className="citation-strip" aria-label={`${ordered.length} answer citations`}>
      <span className="citation-strip__label">
        <Link2 size={13} />
        Sources
      </span>
      <span className="citation-strip__markers">
        {ordered.map((citation) => (
          <CitationMarker key={citation.id} citation={citation} onOpen={onOpen} />
        ))}
      </span>
    </aside>
  );
}

export interface SourcesInspectorProps {
  citations: readonly CitationView[];
  selectedCitationId: string | null;
  onReturn: () => void;
}

export function SourcesInspector({
  citations,
  selectedCitationId,
  onReturn,
}: SourcesInspectorProps) {
  const ordered = useMemo(() => orderCitations(citations), [citations]);
  const selectedRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selectedCitationId) return;
    selectedRef.current?.focus({ preventScroll: true });
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [ordered, selectedCitationId]);

  if (ordered.length === 0) {
    return (
      <div className="inspector-scroll sources-inspector">
        <button type="button" className="sources-return" onClick={onReturn}>
          <ChevronLeft size={14} />
          Return to inspector
        </button>
        <section className="sources-hero">
          <span className="sources-hero__glyph"><SearchCheck size={21} /></span>
          <div>
            <span className="eyebrow">Sources</span>
            <h3>No cited sources</h3>
            <p>The selected answer has no persisted citation records.</p>
          </div>
        </section>
        <div className="inspector-notice">
          <AlertTriangle size={15} />
          <p>Omnia does not infer sources from links or answer text. Only harness-persisted citation evidence appears here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector-scroll sources-inspector">
      <section className="sources-hero">
        <span className="sources-hero__glyph"><SearchCheck size={21} /></span>
        <div>
          <span className="eyebrow">Answer evidence</span>
          <h3>{ordered.length} {ordered.length === 1 ? "source" : "sources"}</h3>
          <p>Persisted source records for this answer, ordered by their stable citation number.</p>
        </div>
      </section>

      <button type="button" className="sources-return" onClick={onReturn}>
        <ChevronLeft size={14} />
        Return to citation
      </button>

      <div className="source-evidence-list">
        {ordered.map((citation) => {
          const verification = effectiveCitationVerification(citation);
          const copy = verificationCopy[verification];
          const selected = citation.id === selectedCitationId;
          const safeUri = normalizeExternalHttpUrl(citation.uri);
          const sourceRange =
            citation.sourceStart !== null && citation.sourceEnd !== null
              ? `${citation.sourceStart}–${citation.sourceEnd}`
              : "Not retained";
          return (
            <article
              key={citation.id}
              ref={selected ? selectedRef : undefined}
              className={selected ? "source-evidence source-evidence--selected" : "source-evidence"}
              tabIndex={-1}
              aria-label={`Citation ${citation.displayIndex}: ${citation.title}`}
            >
              <header>
                <span className="source-evidence__index">{citation.displayIndex}</span>
                <span className="source-evidence__title">
                  <strong>{citation.title}</strong>
                  <small>{sourceIcon(citation.sourceType)} {citation.locatorLabel}</small>
                </span>
              </header>

              <blockquote>{citation.excerpt || "No excerpt was retained for display."}</blockquote>

              <div className={`source-verification source-verification--${verification}`}>
                {verificationIcon(verification)}
                <span>
                  <strong>{copy.label}</strong>
                  <small>{copy.description}</small>
                </span>
              </div>

              <dl className="source-provenance">
                <div><dt><Clock3 size={12} /> Retrieved</dt><dd>{formatEvidenceTime(citation.retrievedAt)}</dd></div>
                <div><dt><Hash size={12} /> Source span</dt><dd>{sourceRange}</dd></div>
                <div><dt><ShieldCheck size={12} /> Snapshot</dt><dd>{citation.snapshotId ?? "Not retained"}</dd></div>
              </dl>

              {safeUri ? (
                <a className="source-open-link" href={safeUri} target="_blank" rel="noopener noreferrer">
                  Open source <ExternalLink size={13} />
                </a>
              ) : (
                <span className="source-open-link source-open-link--disabled">No openable URI retained</span>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

const statusLabels: Record<RunTimelineStatus, string> = {
  pending: "Pending",
  running: "Running",
  complete: "Complete",
  stopped: "Stopped",
  warning: "Warning",
  failed: "Failed",
};

type RunTimelineViewFilter = "all" | "active" | "attention" | "completed";
type RunTimelineStageFilter = "all" | RunTimelineStage;
type RunTimelineSourceFilter = "all" | RunTimelineSource;

const runTimelineViewLabels: Record<RunTimelineViewFilter, string> = {
  all: "All events",
  active: "Active now",
  attention: "Needs attention",
  completed: "Completed",
};

function matchesRunTimelineViewFilter(
  event: RunTimelineEventView,
  filter: RunTimelineViewFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "active") return event.status === "pending" || event.status === "running";
  if (filter === "attention") {
    return event.status === "warning" || event.status === "failed" || event.status === "stopped";
  }
  return event.status === "complete";
}

function timelineFacetLabel(value: string): string {
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function runStatusIcon(status: RunTimelineStatus) {
  if (status === "complete") return <CheckCircle2 size={14} />;
  if (status === "failed") return <XCircle size={14} />;
  if (status === "warning") return <AlertTriangle size={14} />;
  return <CircleDashed size={14} />;
}

export interface RunTimelineProps {
  runId: string;
  events: readonly RunTimelineEventView[];
  coverage?: RunTimelineReplayCoverage;
  coverageReason?: string | null;
  handoff?: RunJournalHandoffProjection | null;
}

function RunTimelineCoverageNote({
  coverage,
  coverageReason,
  integrityIssueCount,
  handoff,
}: {
  readonly coverage: RunTimelineReplayCoverage;
  readonly coverageReason: string | null;
  readonly integrityIssueCount: number;
  readonly handoff: RunJournalHandoffProjection | null;
}) {
  const description = describeRunTimelineCoverage(
    coverage,
    coverageReason,
    integrityIssueCount,
  );
  const Icon =
    handoff?.status === "degraded"
      ? AlertTriangle
      : description.tone === "complete"
      ? ShieldCheck
      : description.tone === "warning"
        ? AlertTriangle
        : CircleDashed;
  const tone = handoff?.status === "degraded" ? "warning" : description.tone;

  return (
    <div
      className={`run-timeline-coverage run-timeline-coverage--${tone}`}
      role="note"
      aria-label="Run timeline coverage"
    >
      <Icon size={14} aria-hidden="true" />
      <span>
        <strong>{description.label}</strong>
        <small>{description.detail}</small>
        {handoff ? (
          <small
            className={`run-timeline-coverage__handoff run-timeline-coverage__handoff--${handoff.status}`}
            data-testid="run-timeline-handoff"
          >
            Handoff {handoff.status} · {handoff.bufferedEventCount} buffered event{handoff.bufferedEventCount === 1 ? "" : "s"}: {handoff.detail}
          </small>
        ) : null}
      </span>
    </div>
  );
}

function formatTimelineDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "Ongoing";
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "Unknown";
  const durationMs = ended - started;
  return durationMs < 1_000 ? `${durationMs.toLocaleString()} ms` : `${(durationMs / 1_000).toFixed(2)} s`;
}

function TimelineEventDetail({
  event,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
}: {
  readonly event: RunTimelineEventView | null;
  readonly canGoPrevious: boolean;
  readonly canGoNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  return (
    <aside className="run-timeline-detail" role="region" aria-label="Run event detail">
      {!event ? (
        <div className="run-timeline-detail__empty">
          <CircleDashed size={17} aria-hidden="true" />
          <strong>Select an event</strong>
          <small>Choose a row to inspect its retained identifiers, timing, and attribution.</small>
        </div>
      ) : (
        <>
          <header className="run-timeline-detail__header">
            <div>
              <span className="eyebrow">Selected event · #{event.sequence}</span>
              <h4>{event.summary}</h4>
              <p>{event.detail ?? "No additional event detail was retained."}</p>
            </div>
            <span className={`run-timeline-detail__status run-timeline-detail__status--${event.status}`}>
              {statusLabels[event.status]}
            </span>
          </header>
          <dl className="run-timeline-detail__facts">
            <div><dt>Event ID</dt><dd title={event.id}>{event.id}</dd></div>
            <div><dt>Type</dt><dd>{event.type}</dd></div>
            <div><dt>Stage</dt><dd>{timelineFacetLabel(event.stage)}</dd></div>
            <div><dt>Source</dt><dd>{timelineFacetLabel(event.source)}</dd></div>
            <div><dt>Started</dt><dd>{formatEvidenceTime(event.startedAt)}</dd></div>
            <div><dt>Ended</dt><dd>{event.endedAt ? formatEvidenceTime(event.endedAt) : "Not retained · ongoing"}</dd></div>
            <div><dt>Duration</dt><dd>{formatTimelineDuration(event.startedAt, event.endedAt)}</dd></div>
            <div><dt>Parent event</dt><dd title={event.parentEventId ?? undefined}>{event.parentEventId ?? "None retained"}</dd></div>
            <div><dt>Provider/model</dt><dd>{event.providerLabel ?? "Not retained"}</dd></div>
            <div><dt>Attempt</dt><dd>{event.attemptOrdinal === null ? "Not retained" : event.attemptOrdinal.toLocaleString()}</dd></div>
            <div><dt>Citations</dt><dd>{event.citationIds.length ? `${event.citationIds.length.toLocaleString()} retained` : "None retained"}</dd></div>
          </dl>
          <div className="run-timeline-detail__navigation" role="toolbar" aria-label="Run event navigation">
            <button type="button" className="button button--ghost" onClick={onPrevious} disabled={!canGoPrevious} aria-label="Previous timeline event">
              <ChevronLeft size={13} /> Previous
            </button>
            <button type="button" className="button button--ghost" onClick={onNext} disabled={!canGoNext} aria-label="Next timeline event">
              Next <ChevronRight size={13} />
            </button>
          </div>
          <p className="run-timeline-detail__boundary" role="note">
            <ShieldAlert size={13} aria-hidden="true" />
            Renderer-local detail of the replayed projection. Native payload, persistence, and provider authority remain separate.
          </p>
        </>
      )}
    </aside>
  );
}

export function RunTimeline({ runId, events, coverage = "unknown", coverageReason = null, handoff = null }: RunTimelineProps) {
  const audited = useMemo(() => auditRunTimeline(events, runId), [events, runId]);
  const [query, setQuery] = useState("");
  const [viewFilter, setViewFilter] = useState<RunTimelineViewFilter>("all");
  const [stageFilter, setStageFilter] = useState<RunTimelineStageFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<RunTimelineSourceFilter>("all");
  const [exportFormat, setExportFormat] = useState<RunTimelineExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const availableStages = useMemo(
    () => [...new Set(audited.events.map((event) => event.stage))].sort(),
    [audited.events],
  );
  const availableSources = useMemo(
    () => [...new Set(audited.events.map((event) => event.source))].sort(),
    [audited.events],
  );
  const statusSummary = useMemo(() => ({
    active: audited.events.filter((event) => event.status === "pending" || event.status === "running").length,
    attention: audited.events.filter((event) => event.status === "warning" || event.status === "failed" || event.status === "stopped").length,
    completed: audited.events.filter((event) => event.status === "complete").length,
  }), [audited.events]);
  const visibleEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return audited.events.filter((event) => {
      if (!matchesRunTimelineViewFilter(event, viewFilter)) return false;
      if (stageFilter !== "all" && event.stage !== stageFilter) return false;
      if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
      if (!normalizedQuery) return true;
      return `${event.summary} ${event.detail ?? ""} ${event.stage} ${event.type} ${event.providerLabel ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [audited.events, query, sourceFilter, stageFilter, viewFilter]);
  const selectedEvent = useMemo(
    () => audited.events.find((event) => event.id === selectedEventId) ?? null,
    [audited.events, selectedEventId],
  );
  const selectedVisibleIndex = selectedEvent
    ? visibleEvents.findIndex((event) => event.id === selectedEvent.id)
    : -1;

  useEffect(() => {
    if (selectedEventId && !visibleEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(null);
    }
  }, [selectedEventId, visibleEvents]);
  const exportPayload = useMemo(
    () => serializeRunTimelineExport({
      runId,
      events: audited.events,
      issues: audited.issues,
      coverage,
      coverageReason,
      format: exportFormat,
    }),
    [audited.events, audited.issues, coverage, coverageReason, exportFormat, runId],
  );

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no run timeline preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setCopied(true);
      setExportStatus(`Copied the renderer-local ${exportFormat.toUpperCase()} run timeline preview.`);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setExportStatus("Clipboard access was denied; no run timeline preview was copied.");
    }
  };

  const downloadExport = () => {
    const exported = downloadRunTimelineExport(exportPayload, exportFormat);
    setExportStatus(
      exported
        ? `Started a browser download of the renderer-local ${exportFormat.toUpperCase()} run timeline preview.`
        : "Browser download is unavailable in this preview; no run timeline file was written.",
    );
  };

  if (audited.events.length === 0) {
    return (
      <section className="inspector-section run-timeline-card">
        <span className="eyebrow">Durable event timeline</span>
        <RunTimelineCoverageNote
          coverage={coverage}
          coverageReason={coverageReason}
          integrityIssueCount={audited.issues.length}
          handoff={handoff}
        />
        <p className="inspector-muted-copy">No persisted run events are available for this projection.</p>
      </section>
    );
  }

  return (
    <section className="inspector-section run-timeline-card">
      <div className="run-timeline-card__header">
        <span className="eyebrow">Durable event timeline</span>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setExportOpen((open) => !open);
            setExportStatus(null);
          }}
          aria-expanded={exportOpen}
          aria-controls={`run-timeline-export-${runId}`}
        >
          <Download size={13} /> {exportOpen ? "Hide export" : "Preview export"}
        </button>
      </div>
      <RunTimelineCoverageNote
        coverage={coverage}
        coverageReason={coverageReason}
        integrityIssueCount={audited.issues.length}
        handoff={handoff}
      />
      <div className="run-timeline-summary" role="region" aria-label="Run event summary">
        <span><strong>{audited.events.length}</strong> events</span>
        <span><strong>{statusSummary.active}</strong> active</span>
        <span><strong>{statusSummary.attention}</strong> attention</span>
        <span><strong>{statusSummary.completed}</strong> completed</span>
      </div>
      {exportOpen ? (
        <div id={`run-timeline-export-${runId}`} className="run-timeline-export" role="region" aria-label="Run timeline export preview">
          <div className="run-timeline-export__toolbar" role="toolbar" aria-label="Run timeline export actions">
            <label>
              <span>Format</span>
              <select
                value={exportFormat}
                onChange={(event) => {
                  setExportFormat(event.target.value as RunTimelineExportFormat);
                  setExportStatus(null);
                }}
                aria-label="Run timeline export format"
              >
                <option value="json">JSON</option>
                <option value="markdown">Markdown</option>
              </select>
            </label>
            <button type="button" className="button button--secondary" onClick={() => void copyExport()}>
              {copied ? <Check size={13} /> : <Clipboard size={13} />} {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="button button--ghost" onClick={downloadExport}>
              <Download size={13} /> Download
            </button>
          </div>
          <pre className="run-timeline-export__code" tabIndex={0}><code>{exportPayload}</code></pre>
          <div className="run-timeline-export__boundary" role="note">
            <ShieldAlert size={13} />
            <span>Renderer-local preview of replayed timeline facts. Native export, complete-coverage proof, and durable receipts remain unavailable.</span>
          </div>
          {exportStatus ? <p className="run-timeline-export__status" role="status" aria-live="polite">{exportStatus}</p> : null}
        </div>
      ) : null}
      {audited.issues.length > 0 ? (
        <div className="timeline-integrity-warning" role="alert">
          <AlertTriangle size={14} />
          <span>
            <strong>Incomplete event journal</strong>
            {audited.issues.map((issue) => <small key={issue}>{issue}</small>)}
          </span>
        </div>
      ) : null}
      <div className="run-timeline-card__controls" role="toolbar" aria-label="Run timeline filters">
        <label className="run-timeline-card__search">
          <Search size={13} aria-hidden="true" />
          <span className="sr-only">Search run timeline</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search events"
            aria-label="Search run timeline"
          />
        </label>
        <label>
          <span>View</span>
          <select
            value={viewFilter}
            onChange={(event) => setViewFilter(event.target.value as RunTimelineViewFilter)}
            aria-label="Filter run timeline view"
          >
            {Object.entries(runTimelineViewLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Stage</span>
          <select
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value as RunTimelineStageFilter)}
            aria-label="Filter run timeline stage"
          >
            <option value="all">All stages</option>
            {availableStages.map((stage) => <option key={stage} value={stage}>{timelineFacetLabel(stage)}</option>)}
          </select>
        </label>
        <label>
          <span>Source</span>
          <select
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value as RunTimelineSourceFilter)}
            aria-label="Filter run timeline source"
          >
            <option value="all">All sources</option>
            {availableSources.map((source) => <option key={source} value={source}>{timelineFacetLabel(source)}</option>)}
          </select>
        </label>
        <span className="run-timeline-card__count" aria-live="polite">
          {visibleEvents.length} of {audited.events.length} events
        </span>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => {
            setQuery("");
            setViewFilter("all");
            setStageFilter("all");
            setSourceFilter("all");
          }}
          disabled={!query && viewFilter === "all" && stageFilter === "all" && sourceFilter === "all"}
        >
          <RotateCcw size={13} /> Reset
        </button>
      </div>
      <div className="run-timeline-inspector-body">
        {visibleEvents.length > 0 ? (
          <ol className="run-event-list">
            {visibleEvents.map((event) => {
              const selected = event.id === selectedEventId;
              return (
                <li key={event.id} className={`run-event run-event--${event.status}${selected ? " run-event--selected" : ""}`}>
                  <span className="run-event__dot">{runStatusIcon(event.status)}</span>
                  <button
                    type="button"
                    className="run-event__select"
                    onClick={() => setSelectedEventId(selected ? null : event.id)}
                    aria-label={`Inspect event ${event.sequence}: ${event.summary}`}
                    aria-pressed={selected}
                  >
                    <span className="run-event__meta">
                      <strong>{event.summary}</strong>
                      <span>{statusLabels[event.status]}</span>
                    </span>
                    {event.detail ? <p>{event.detail}</p> : null}
                    <time>
                      #{event.sequence} · {event.stage.replaceAll("-", " ")} · {formatEvidenceTime(event.startedAt)}
                    </time>
                    {event.providerLabel || event.attemptOrdinal !== null ? (
                      <small className="run-event__attribution">
                        {[event.providerLabel, event.attemptOrdinal === null ? null : `attempt ${event.attemptOrdinal}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="run-timeline-empty" role="status">
            <Search size={16} aria-hidden="true" />
            <strong>No matching timeline events</strong>
            <small>Try another search or reset the view.</small>
          </div>
        )}
        <TimelineEventDetail
          event={selectedEvent}
          canGoPrevious={selectedVisibleIndex > 0}
          canGoNext={selectedVisibleIndex >= 0 && selectedVisibleIndex < visibleEvents.length - 1}
          onPrevious={() => {
            if (selectedVisibleIndex > 0) {
              const previous = visibleEvents[selectedVisibleIndex - 1];
              if (previous) setSelectedEventId(previous.id);
            }
          }}
          onNext={() => {
            if (selectedVisibleIndex >= 0 && selectedVisibleIndex < visibleEvents.length - 1) {
              const next = visibleEvents[selectedVisibleIndex + 1];
              if (next) setSelectedEventId(next.id);
            }
          }}
        />
      </div>
    </section>
  );
}
