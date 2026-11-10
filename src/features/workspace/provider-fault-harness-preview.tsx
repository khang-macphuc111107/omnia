import {
  AlertTriangle,
  Check,
  Clipboard,
  Download,
  FlaskConical,
  LockKeyhole,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  TimerReset,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

type FaultCategory = "Dispatch" | "Protocol" | "Streaming" | "Lifecycle" | "Recovery" | "Security";
type FaultCoverage = "Transport self-test" | "Integration partial" | "Planned";
type FaultSeverity = "critical" | "high" | "medium";
type ExportFormat = "json" | "markdown";
type ProviderFamily = "openai-compatible" | "anthropic" | "gemini";
type FragmentationStrategy = "coalesced" | "every-byte" | "fixed-size" | "seeded" | "protocol-boundaries" | "replay";
type CheckpointMode = "none" | "before-headers" | "after-partial-text" | "before-terminal";

type FaultCase = {
  readonly id: string;
  readonly category: FaultCategory;
  readonly title: string;
  readonly boundary: string;
  readonly assertion: string;
  readonly evidence: string;
  readonly coverage: FaultCoverage;
  readonly severity: FaultSeverity;
  readonly tags: readonly string[];
};

type HarnessDraft = {
  readonly providerFamily: ProviderFamily;
  readonly fragmentation: FragmentationStrategy;
  readonly seed: string;
  readonly requestLimit: number;
  readonly checkpoint: CheckpointMode;
  readonly allowSecondConnection: boolean;
};

const FAULT_CASES: readonly FaultCase[] = [
  { id: "PF-001", category: "Dispatch", title: "Before connection / request", boundary: "The provider connection is never opened.", assertion: "No dispatch transition or provider acceptance is recorded.", evidence: "No request capture; predispatch state remains authoritative.", coverage: "Integration partial", severity: "critical", tags: ["predispatch", "no-send"] },
  { id: "PF-002", category: "Dispatch", title: "Request captured, no response head", boundary: "The mock captures the request and then stays silent.", assertion: "Do not claim non-billable behavior without native no-send evidence.", evidence: "Request capture is visible to the test; acceptance remains unknown.", coverage: "Integration partial", severity: "critical", tags: ["ambiguity", "billing"] },
  { id: "PF-003", category: "Protocol", title: "204 No Content", boundary: "A successful HTTP status carries no streaming body.", assertion: "Reject as a protocol error; never complete the run.", evidence: "Typed response head plus empty body is a deterministic fixture.", coverage: "Transport self-test", severity: "high", tags: ["status", "empty-body"] },
  { id: "PF-004", category: "Protocol", title: "200 with non-SSE content type", boundary: "The response status is 200 but media type is not the adapter stream type.", assertion: "Reject before streaming projection mutation.", evidence: "Headers are captured before any body projection.", coverage: "Transport self-test", severity: "high", tags: ["content-type", "preflight"] },
  { id: "PF-005", category: "Streaming", title: "Empty SSE body and clean EOF", boundary: "The stream ends without an event or terminal marker.", assertion: "Never complete; classify as interruption or unknown.", evidence: "Clean EOF is distinct from adapter terminal evidence.", coverage: "Transport self-test", severity: "high", tags: ["eof", "terminal"] },
  { id: "PF-006", category: "Streaming", title: "Fragment at every byte boundary", boundary: "Every response byte is written as its own chunk.", assertion: "Normalized facts match the unfragmented stream.", evidence: "Deterministic every-byte fragmentation plan.", coverage: "Transport self-test", severity: "medium", tags: ["fragmentation", "replay"] },
  { id: "PF-007", category: "Streaming", title: "Split inside UTF-8 code point", boundary: "A multibyte code point is split across writes.", assertion: "Reassemble losslessly with no replacement character or duplicate text.", evidence: "Canonical fixture hash plus exact split offsets.", coverage: "Transport self-test", severity: "high", tags: ["utf8", "fragmentation"] },
  { id: "PF-008", category: "Streaming", title: "Split inside SSE delimiters", boundary: "CRLF/LF framing bytes arrive across separate writes.", assertion: "Decode each frame exactly once.", evidence: "Protocol-boundary fragmentation plan.", coverage: "Transport self-test", severity: "high", tags: ["sse", "delimiters"] },
  { id: "PF-009", category: "Protocol", title: "Malformed UTF-8 or JSON", boundary: "The body contains invalid encoding or a malformed event.", assertion: "Fail closed with a bounded sanitized error.", evidence: "Raw fixture bytes stay out of diagnostics.", coverage: "Transport self-test", severity: "high", tags: ["malformed", "sanitized"] },
  { id: "PF-010", category: "Protocol", title: "Frame exceeds configured bound", boundary: "One event is larger than the adapter frame limit.", assertion: "Abort with provider_frame_too_large.", evidence: "Bounded parser failure code is expected.", coverage: "Transport self-test", severity: "high", tags: ["limits", "memory"] },
  { id: "PF-011", category: "Protocol", title: "Stream exceeds configured bound", boundary: "The cumulative response exceeds the stream limit.", assertion: "Abort with provider_response_too_large.", evidence: "No unbounded body allocation is allowed.", coverage: "Transport self-test", severity: "high", tags: ["limits", "memory"] },
  { id: "PF-012", category: "Streaming", title: "Valid text then truncated frame", boundary: "Visible text is committed before an incomplete final event.", assertion: "Preserve committed partial text; never complete.", evidence: "Partial projection and terminal fact remain separate.", coverage: "Transport self-test", severity: "high", tags: ["partial", "truncated"] },
  { id: "PF-013", category: "Streaming", title: "Clean EOF without terminal evidence", boundary: "The adapter receives EOF with no recognized terminal fact.", assertion: "Use provider_stream_interrupted or outcome_unknown, never implicit stop.", evidence: "Terminal evidence is required by the frozen adapter contract.", coverage: "Transport self-test", severity: "critical", tags: ["eof", "unknown"] },
  { id: "PF-014", category: "Protocol", title: "OpenAI finish reason without [DONE]", boundary: "A non-null finish reason arrives without the optional sentinel.", assertion: "Complete only when the frozen adapter contract accepts the finish reason.", evidence: "Adapter-versioned terminal policy is inspectable.", coverage: "Integration partial", severity: "high", tags: ["openai", "terminal"] },
  { id: "PF-015", category: "Protocol", title: "Anthropic stop reason without message_stop", boundary: "A stop reason arrives before message_stop.", assertion: "Never complete until message_stop is durably recognized.", evidence: "Protocol-specific terminal requirement.", coverage: "Integration partial", severity: "high", tags: ["anthropic", "terminal"] },
  { id: "PF-016", category: "Protocol", title: "Gemini stream without finish reason", boundary: "Candidates arrive but no recognized finish reason follows.", assertion: "Never complete.", evidence: "Finish evidence is required for this adapter family.", coverage: "Integration partial", severity: "high", tags: ["gemini", "terminal"] },
  { id: "PF-017", category: "Protocol", title: "Event after terminal marker", boundary: "A late provider event appears after terminal evidence.", assertion: "Reject or audit it; never create a second terminal fact.", evidence: "Terminal cardinality is one per attempt.", coverage: "Integration partial", severity: "critical", tags: ["terminal", "late-event"] },
  { id: "PF-018", category: "Streaming", title: "Duplicate identical text events", boundary: "The same visible text event is delivered twice.", assertion: "Do not deduplicate unless producer identity proves replay.", evidence: "Content equality is not producer identity.", coverage: "Transport self-test", severity: "medium", tags: ["duplicate", "projection"] },
  { id: "PF-019", category: "Recovery", title: "Replay same durable producer event ID", boundary: "A committed event is replayed at the same cursor.", assertion: "Do not duplicate projection or usage.", evidence: "Idempotency is keyed by producer identity and cursor.", coverage: "Integration partial", severity: "critical", tags: ["replay", "idempotency"] },
  { id: "PF-020", category: "Streaming", title: "Usage before, during, and after text", boundary: "Usage facts arrive at multiple points in the stream.", assertion: "Per-attempt usage follows the accepted monotonic policy.", evidence: "Usage is distinct from visible text and terminal state.", coverage: "Integration partial", severity: "high", tags: ["usage", "ledger"] },
  { id: "PF-021", category: "Streaming", title: "Provider error event mid-stream", boundary: "An error event follows partial visible output.", assertion: "Keep partial projection auditable; fail or mark unknown once.", evidence: "One attempt terminal fact with preserved partial text.", coverage: "Integration partial", severity: "critical", tags: ["error", "partial"] },
  { id: "PF-022", category: "Security", title: "Error body / request-ID secret canary", boundary: "Synthetic canaries appear in request or provider error metadata.", assertion: "No canary reaches error, event, journal, UI, or log surfaces.", evidence: "Redaction scans metadata, never ordinary raw traffic.", coverage: "Integration partial", severity: "critical", tags: ["secret", "redaction"] },
  { id: "PF-023", category: "Lifecycle", title: "Renderer notification failure", boundary: "Native commit succeeds while a downstream notification fails.", assertion: "Provider execution and durable outcome remain unchanged.", evidence: "Renderer notification is downstream of durable commit.", coverage: "Planned", severity: "high", tags: ["notify", "commit"] },
  { id: "PF-024", category: "Lifecycle", title: "Journal append fault before projection", boundary: "The event append fails before projection update.", assertion: "Event and projection both roll back.", evidence: "Storage failpoint required; transport fixture alone is insufficient.", coverage: "Planned", severity: "critical", tags: ["journal", "rollback"] },
  { id: "PF-025", category: "Lifecycle", title: "Projection fault after append attempt", boundary: "Projection mutation fails after an append attempt.", assertion: "Event and projection both roll back atomically.", evidence: "Requires a native transaction failpoint.", coverage: "Planned", severity: "critical", tags: ["projection", "rollback"] },
  { id: "PF-026", category: "Recovery", title: "Crash after durable commit", boundary: "The process stops after event commit and before notification.", assertion: "Replay reconstructs the exact committed projection.", evidence: "Restart/replay evidence is not provided by the renderer.", coverage: "Planned", severity: "critical", tags: ["crash", "replay"] },
  { id: "PF-027", category: "Lifecycle", title: "Cancel before HTTP poll", boundary: "Cancellation wins before the adapter opens a connection.", assertion: "No request is captured; state proves predispatch cancellation.", evidence: "Requires native run-control and transport observation.", coverage: "Integration partial", severity: "high", tags: ["cancel", "predispatch"] },
  { id: "PF-028", category: "Lifecycle", title: "Cancel after request capture", boundary: "Cancellation arrives after possible send but before headers.", assertion: "Do not claim provider rejection or non-billing without evidence.", evidence: "Ambiguity is preserved as an outcome classification.", coverage: "Integration partial", severity: "critical", tags: ["cancel", "ambiguity"] },
  { id: "PF-029", category: "Lifecycle", title: "Cancel after headers", boundary: "Cancellation arrives after response headers but before first event.", assertion: "Persist correct acceptance or ambiguity evidence.", evidence: "Header observation is a distinct lifecycle point.", coverage: "Planned", severity: "critical", tags: ["cancel", "acceptance"] },
  { id: "PF-030", category: "Lifecycle", title: "Cancel after partial text", boundary: "Cancellation arrives after visible text.", assertion: "Preserve partial text and one interruption terminal fact.", evidence: "Partial projection must survive cancellation.", coverage: "Integration partial", severity: "high", tags: ["cancel", "partial"] },
  { id: "PF-031", category: "Recovery", title: "Timeout or reset after possible send", boundary: "Transport ends after a request may have left the machine.", assertion: "Mark outcome_unknown; do not auto-retry without idempotency.", evidence: "Retry is a new attempt only when explicitly permitted.", coverage: "Integration partial", severity: "critical", tags: ["timeout", "unknown"] },
  { id: "PF-032", category: "Recovery", title: "Two scripted connections after unknown", boundary: "A second connection is scripted after an ambiguous first attempt.", assertion: "Second connection requires explicit permitted retry/new attempt.", evidence: "Connection count is observable and bounded.", coverage: "Transport self-test", severity: "critical", tags: ["retry", "connections"] },
  { id: "PF-033", category: "Recovery", title: "Late event from old attempt", boundary: "An old attempt emits after a successor attempt starts.", assertion: "The late event cannot mutate the new attempt or active projection.", evidence: "Attempt lineage must gate event admission.", coverage: "Planned", severity: "critical", tags: ["lineage", "late-event"] },
  { id: "PF-034", category: "Recovery", title: "Concurrent same-attempt dispatch", boundary: "The same frozen input is submitted concurrently.", assertion: "Exactly one request reaches the mock server.", evidence: "Requires native idempotency/lease coordination.", coverage: "Planned", severity: "critical", tags: ["concurrency", "idempotency"] },
  { id: "PF-035", category: "Recovery", title: "Restart during partial run", boundary: "The process restarts while a stream is partially committed.", assertion: "Fixed-cursor replay has no gap/duplicate and live tail starts after watermark.", evidence: "Requires a clean temporary profile and native journal replay.", coverage: "Planned", severity: "critical", tags: ["restart", "cursor"] },
  { id: "PF-036", category: "Recovery", title: "Restart after terminal commit", boundary: "The process restarts after terminal evidence is committed.", assertion: "Exactly one terminal event and stable final projection remain.", evidence: "Requires durable storage and restart evidence.", coverage: "Planned", severity: "critical", tags: ["restart", "terminal"] },
  { id: "PF-037", category: "Recovery", title: "Rate limit with bounded retry metadata", boundary: "Provider returns a bounded retry hint.", assertion: "Apply structured retry policy; never unsafe automatic resend.", evidence: "Retry-after and policy revision must be inspectable.", coverage: "Integration partial", severity: "high", tags: ["rate-limit", "retry"] },
  { id: "PF-038", category: "Security", title: "Redirect to another origin", boundary: "A provider response attempts to redirect credentials elsewhere.", assertion: "Reject redirect; credential is not sent to another origin.", evidence: "Destination policy runs before secret access.", coverage: "Transport self-test", severity: "critical", tags: ["redirect", "egress"] },
  { id: "PF-039", category: "Security", title: "Oversized or stalled error body", boundary: "The error body is too large or never finishes.", assertion: "Terminate within bounds without an unbounded allocation or hang.", evidence: "Bounded read and timeout metadata are expected.", coverage: "Transport self-test", severity: "high", tags: ["limits", "timeout"] },
  { id: "PF-040", category: "Security", title: "Prompt / credential canary containment", boundary: "Synthetic prompt and credential canaries traverse the fixture.", assertion: "Canaries exist only in approved request capture, never durable diagnostics.", evidence: "The fixture is synthetic and redaction-scanned.", coverage: "Integration partial", severity: "critical", tags: ["canary", "redaction"] },
];

const CATEGORY_OPTIONS: readonly ("all" | FaultCategory)[] = ["all", "Dispatch", "Protocol", "Streaming", "Lifecycle", "Recovery", "Security"];
const COVERAGE_OPTIONS: readonly ("all" | FaultCoverage)[] = ["all", "Transport self-test", "Integration partial", "Planned"];
const PROVIDER_LABELS: Record<ProviderFamily, string> = {
  "openai-compatible": "OpenAI-compatible",
  anthropic: "Anthropic Messages",
  gemini: "Gemini Generate",
};
const FRAGMENTATION_LABELS: Record<FragmentationStrategy, string> = {
  coalesced: "Coalesced body",
  "every-byte": "Every byte",
  "fixed-size": "Fixed-size chunks",
  seeded: "Seeded deterministic",
  "protocol-boundaries": "Protocol boundaries",
  replay: "Replay recorded splits",
};
const CHECKPOINT_LABELS: Record<CheckpointMode, string> = {
  none: "No checkpoint",
  "before-headers": "Before response headers",
  "after-partial-text": "After partial text",
  "before-terminal": "Before terminal evidence",
};

const DEFAULT_DRAFT: HarnessDraft = {
  providerFamily: "openai-compatible",
  fragmentation: "protocol-boundaries",
  seed: "omnia-seed-040",
  requestLimit: 2_097_152,
  checkpoint: "before-terminal",
  allowSecondConnection: false,
};

function serializeScenario(selected: FaultCase, draft: HarnessDraft, format: ExportFormat): string {
  const payload = {
    schema: "omnia.provider-fault-harness.preview.v1",
    scope: "renderer-session",
    scenarioId: selected.id,
    fixtureRevision: "provider-fixtures.preview-2026-08",
    providerFamily: draft.providerFamily,
    providerLabel: PROVIDER_LABELS[draft.providerFamily],
    fragmentation: draft.fragmentation,
    seed: draft.seed,
    requestLimit: draft.requestLimit,
    checkpoint: draft.checkpoint,
    allowSecondConnection: draft.allowSecondConnection,
    expectedAssertion: selected.assertion,
    coverage: selected.coverage,
    boundary: "Test-only catalog preview; no provider request, native harness run, filesystem read, or durable write.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${selected.id} · ${selected.title}`,
    "",
    `- Provider family: ${PROVIDER_LABELS[draft.providerFamily]}`,
    `- Fragmentation: ${FRAGMENTATION_LABELS[draft.fragmentation]}`,
    `- Seed: ${draft.seed}`,
    `- Checkpoint: ${CHECKPOINT_LABELS[draft.checkpoint]}`,
    `- Request limit: ${draft.requestLimit.toLocaleString()} bytes`,
    `- Second connection: ${draft.allowSecondConnection ? "allowed in scenario preview" : "disabled"}`,
    `- Catalogue coverage: ${selected.coverage}`,
    "",
    `Boundary: ${selected.boundary}`,
    `Expected assertion: ${selected.assertion}`,
    "",
    "> Preview only · renderer-local · no durable write · the native Rust harness is cfg(test) and has no IPC or live-provider path.",
  ].join("\n");
}

function downloadText(filename: string, content: string, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return false;
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

function coverageClass(coverage: FaultCoverage): string {
  return coverage === "Transport self-test" ? "covered" : coverage === "Integration partial" ? "partial" : "planned";
}

function severityIcon(severity: FaultSeverity) {
  if (severity === "critical") return <XCircle size={13} aria-hidden="true" />;
  if (severity === "high") return <AlertTriangle size={13} aria-hidden="true" />;
  return <ShieldCheck size={13} aria-hidden="true" />;
}

export function ProviderFaultHarnessPreview() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | FaultCategory>("all");
  const [coverage, setCoverage] = useState<"all" | FaultCoverage>("all");
  const [selectedId, setSelectedId] = useState(FAULT_CASES[0]?.id ?? "PF-001");
  const [draft, setDraft] = useState<HarnessDraft>(DEFAULT_DRAFT);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState("Catalog preview ready; no native test runner is connected.");

  const filteredCases = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return FAULT_CASES.filter((fault) => {
      const haystack = `${fault.id} ${fault.title} ${fault.category} ${fault.boundary} ${fault.assertion} ${fault.tags.join(" ")}`.toLowerCase();
      return (!normalized || haystack.includes(normalized)) && (category === "all" || fault.category === category) && (coverage === "all" || fault.coverage === coverage);
    });
  }, [category, coverage, query]);

  const selected = filteredCases.find((fault) => fault.id === selectedId) ?? filteredCases[0] ?? null;
  const payload = selected ? serializeScenario(selected, draft, format) : "No fault scenario matches the current filters.";
  const counts = useMemo(() => ({
    total: FAULT_CASES.length,
    covered: FAULT_CASES.filter((fault) => fault.coverage === "Transport self-test").length,
    partial: FAULT_CASES.filter((fault) => fault.coverage === "Integration partial").length,
    planned: FAULT_CASES.filter((fault) => fault.coverage === "Planned").length,
  }), []);

  const updateDraft = <K extends keyof HarnessDraft>(key: K, value: HarnessDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus("Scenario draft updated locally; no native scenario was created.");
  };

  const prepareScenario = () => {
    if (!selected) return;
    setStatus(`${selected.id} scenario prepared in the renderer preview; no listener, provider request, or native test was started.`);
    setExportOpen(true);
  };

  const copyPayload = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; the scenario remains renderer-local.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`${format.toUpperCase()} scenario preview copied; no durable write was made.`);
    } catch {
      setStatus("Clipboard access was denied; no scenario was persisted.");
    }
  };

  const downloadPayload = () => {
    const ok = downloadText(`omnia-${selected?.id.toLowerCase() ?? "provider-fault"}.${format === "json" ? "json" : "md"}`, payload, format === "json" ? "application/json" : "text/markdown");
    setStatus(ok ? "Browser download started; no native harness artifact or receipt was created." : "Browser download is unavailable in this preview.");
  };

  return (
    <section className="provider-fault-harness" aria-labelledby="provider-fault-harness-heading">
      <header className="provider-fault-harness__header">
        <div className="provider-fault-harness__heading">
          <span className="provider-fault-harness__mark" aria-hidden="true"><FlaskConical size={17} /></span>
          <div>
            <span className="eyebrow"><TerminalSquare size={13} /> Provider fault harness</span>
            <h2 id="provider-fault-harness-heading">Inspect deterministic failure boundaries</h2>
            <p>Browse the 40-case provider fault catalogue and stage a redacted scenario shape before native adapter conformance is wired.</p>
          </div>
        </div>
        <span className="provider-fault-harness__badge"><LockKeyhole size={13} /> Test-only · Preview</span>
      </header>

      <div className="provider-fault-harness__metrics" aria-label="Provider fault harness summary">
        <article><FlaskConical size={15} /><strong>{counts.total}</strong><span>catalogued cases</span></article>
        <article><Check size={15} /><strong>{counts.covered}</strong><span>transport self-test</span></article>
        <article><AlertTriangle size={15} /><strong>{counts.partial}</strong><span>integration partial</span></article>
        <article><TimerReset size={15} /><strong>{counts.planned}</strong><span>planned lifecycle</span></article>
      </div>

      <div className="provider-fault-harness__toolbar" role="toolbar" aria-label="Provider fault harness filters">
        <label className="provider-fault-harness__search"><Search size={14} /><span className="sr-only">Search fault catalogue</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search PF id, boundary, or assertion" aria-label="Search fault catalogue" /></label>
        <label><span>Domain</span><select aria-label="Provider fault domain" value={category} onChange={(event) => setCategory(event.target.value as "all" | FaultCategory)}>{CATEGORY_OPTIONS.map((item) => <option key={item} value={item}>{item === "all" ? "All domains" : item}</option>)}</select></label>
        <label><span>Coverage</span><select aria-label="Provider fault coverage" value={coverage} onChange={(event) => setCoverage(event.target.value as "all" | FaultCoverage)}>{COVERAGE_OPTIONS.map((item) => <option key={item} value={item}>{item === "all" ? "All coverage" : item}</option>)}</select></label>
        <span className="provider-fault-harness__count" role="status" aria-label="Provider fault visible count" aria-live="polite">{filteredCases.length} of {FAULT_CASES.length} visible</span>
      </div>

      <div className="provider-fault-harness__body">
        <div className="provider-fault-harness__list" role="list" aria-label="Provider fault catalogue">
          {filteredCases.length ? filteredCases.map((fault) => (
            <div role="listitem" key={fault.id}>
              <button type="button" className={`provider-fault-card${selected?.id === fault.id ? " is-selected" : ""}`} title={`Inspect ${fault.id}: ${fault.title}`} onClick={() => setSelectedId(fault.id)} aria-label={`${fault.id}. ${fault.title}. ${fault.coverage}`}>
                <span className={`provider-fault-card__severity provider-fault-card__severity--${fault.severity}`}>{severityIcon(fault.severity)}<span>{fault.id}</span></span>
                <span className="provider-fault-card__copy"><strong>{fault.title}</strong><small>{fault.category} · {fault.boundary}</small></span>
                <span className={`provider-fault-card__coverage provider-fault-card__coverage--${coverageClass(fault.coverage)}`}>{fault.coverage}</span>
              </button>
            </div>
          )) : <div className="provider-fault-harness__empty"><Search size={17} /><strong>No fault matches</strong><span>Adjust the search or coverage filter.</span></div>}
        </div>

        <aside className="provider-fault-harness__detail" aria-label="Selected provider fault">
          {selected ? <>
            <div className="provider-fault-harness__detail-heading"><div><span className="eyebrow">{selected.category} · {selected.id}</span><h3>{selected.title}</h3></div><span className={`provider-fault-card__coverage provider-fault-card__coverage--${coverageClass(selected.coverage)}`}>{selected.coverage}</span></div>
            <p className="provider-fault-harness__summary">{selected.boundary}</p>
            <dl className="provider-fault-harness__facts"><div><dt>Required assertion</dt><dd>{selected.assertion}</dd></div><div><dt>Evidence shape</dt><dd>{selected.evidence}</dd></div><div><dt>Fixture tags</dt><dd>{selected.tags.join(" · ")}</dd></div></dl>

            <section className="provider-fault-harness__draft" aria-labelledby="provider-fault-draft-heading">
              <div className="provider-fault-harness__section-heading"><div><span className="eyebrow"><SlidersHorizontal size={13} /> Scenario shape</span><h4 id="provider-fault-draft-heading">Tune a deterministic fixture</h4></div><span className="provider-fault-harness__draft-badge">Renderer draft</span></div>
              <div className="provider-fault-harness__draft-grid">
                <label><span>Provider family</span><select value={draft.providerFamily} onChange={(event) => updateDraft("providerFamily", event.target.value as ProviderFamily)}>{Object.entries(PROVIDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Fragmentation</span><select value={draft.fragmentation} onChange={(event) => updateDraft("fragmentation", event.target.value as FragmentationStrategy)}>{Object.entries(FRAGMENTATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Checkpoint</span><select value={draft.checkpoint} onChange={(event) => updateDraft("checkpoint", event.target.value as CheckpointMode)}>{Object.entries(CHECKPOINT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Replay seed</span><input value={draft.seed} onChange={(event) => updateDraft("seed", event.target.value)} spellCheck={false} /></label>
                <label><span>Request limit (bytes)</span><input type="number" min={1} max={8_388_608} value={draft.requestLimit} onChange={(event) => updateDraft("requestLimit", Math.max(1, Number(event.target.value) || 1))} /></label>
                <label className="provider-fault-harness__toggle"><input type="checkbox" checked={draft.allowSecondConnection} onChange={(event) => updateDraft("allowSecondConnection", event.target.checked)} /><span><strong>Allow second connection</strong><small>Only meaningful for retry/unknown scenarios</small></span></label>
              </div>
              <div className="provider-fault-harness__draft-actions"><button type="button" className="button button--secondary" title="Prepare the selected fault scenario in the renderer preview" onClick={prepareScenario}><Play size={13} /> Prepare scenario preview</button><button type="button" className="button button--ghost" title="Reset the local fault scenario draft to defaults" onClick={() => { setDraft(DEFAULT_DRAFT); setStatus("Scenario draft reset; no native state changed."); }}><RotateCcw size={13} /> Reset draft</button><button type="button" className="button button--ghost" disabled title="Native test runner is cfg(test) only and has no renderer IPC">Run native harness <LockKeyhole size={13} /></button></div>
            </section>

            <p className="provider-fault-harness__boundary"><ShieldCheck size={14} /><span>Preview only · Renderer-local · No provider request · No native listener · No filesystem read/write · No durable test receipt. The checked-in Rust harness is local-only test infrastructure compiled under <code>cfg(test)</code>, not an app feature.</span></p>
          </> : <div className="provider-fault-harness__empty"><FlaskConical size={17} /><strong>Select a fault case</strong><span>Its boundary, assertion, and fixture shape appear here.</span></div>}
        </aside>
      </div>

      {exportOpen && selected ? <section className="provider-fault-harness__export" aria-label="Provider fault scenario export preview"><div className="provider-fault-harness__export-toolbar"><label><span>Format</span><select aria-label="Provider fault export format" title="Choose the fault scenario export format" value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" title="Copy the renderer-local fault scenario export" onClick={() => void copyPayload()}><Clipboard size={13} /> Copy</button><button type="button" className="button button--ghost" title="Download the renderer-local fault scenario export" onClick={downloadPayload}><Download size={13} /> Download</button></div><pre tabIndex={0}>{payload}</pre></section> : null}
      <p className="provider-fault-harness__status" role="status" aria-label="Provider fault harness status" aria-live="polite">{status}</p>
    </section>
  );
}

export default ProviderFaultHarnessPreview;
