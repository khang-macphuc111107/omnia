import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clipboard,
  Database,
  Download,
  Eye,
  FileJson2,
  Filter,
  LockKeyhole,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Undo2,
  Upload,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

export type IntakeSource = "conversation" | "feedback" | "memory" | "run" | "portable";
export type IntakeSensitivity = "low" | "moderate" | "high" | "restricted";
export type IntakeConsent = "not-required" | "pending" | "approved" | "declined";
export type IntakeRetention = "session" | "7-days" | "30-days" | "manual";
export type IntakeStatus = "ready" | "needs-review" | "blocked" | "excluded";
export type IntakeRedaction = "keep" | "mask" | "remove";
export type IntakeReviewFormat = "json" | "markdown";
export type IntakePurpose = "quality-review" | "preference-review" | "safety-review" | "private-analysis";

export type IntakeRecord = {
  id: string;
  title: string;
  source: IntakeSource;
  sourceLabel: string;
  purpose: string;
  provenance: string;
  sensitivity: IntakeSensitivity;
  consent: IntakeConsent;
  retention: IntakeRetention;
  redaction: IntakeRedaction;
  status: IntakeStatus;
  excerpt: string;
  fields: string[];
};

export type IntakeReviewSnapshot = {
  records: IntakeRecord[];
  purpose: IntakePurpose;
  retentionDefault: IntakeRetention;
  redactionDefault: IntakeRedaction;
  allowSensitive: boolean;
  requireConsent: boolean;
};

type IntakeHistory = {
  past: IntakeReviewSnapshot[];
  present: IntakeReviewSnapshot;
  future: IntakeReviewSnapshot[];
};

const sourceLabels: Record<IntakeSource, string> = {
  conversation: "Conversation",
  feedback: "Message feedback",
  memory: "Memory proposal",
  run: "Run outcome",
  portable: "Portable import",
};

const sensitivityLabels: Record<IntakeSensitivity, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  restricted: "Restricted",
};

const consentLabels: Record<IntakeConsent, string> = {
  "not-required": "Not required",
  pending: "Pending review",
  approved: "Approved in preview",
  declined: "Declined",
};

const retentionLabels: Record<IntakeRetention, string> = {
  session: "Session only",
  "7-days": "7 days",
  "30-days": "30 days",
  manual: "Manual review",
};

const redactionLabels: Record<IntakeRedaction, string> = {
  keep: "Keep fields",
  mask: "Mask sensitive fields",
  remove: "Remove from batch",
};

const statusLabels: Record<IntakeStatus, string> = {
  ready: "Ready",
  "needs-review": "Needs review",
  blocked: "Blocked",
  excluded: "Excluded",
};

const purposeLabels: Record<IntakePurpose, string> = {
  "quality-review": "Answer quality review",
  "preference-review": "Preference review",
  "safety-review": "Safety review",
  "private-analysis": "Private local analysis",
};

const sourceOrder: IntakeSource[] = ["conversation", "feedback", "memory", "run", "portable"];
const statusOrder: IntakeStatus[] = ["ready", "needs-review", "blocked", "excluded"];

export const seedIntakeRecords: IntakeRecord[] = [
  {
    id: "intake-feedback-001",
    title: "Helpful answer signal",
    source: "feedback",
    sourceLabel: "Chat feedback · renderer preview",
    purpose: "The user marked a response as accurate and actionable.",
    provenance: "Feedback card / session snapshot",
    sensitivity: "low",
    consent: "approved",
    retention: "30-days",
    redaction: "mask",
    status: "ready",
    excerpt: "Accurate · Actionable · Keep the answer concise.",
    fields: ["rating", "reason", "message revision"],
  },
  {
    id: "intake-feedback-002",
    title: "Correction and user rewrite",
    source: "feedback",
    sourceLabel: "Chat feedback · renderer preview",
    purpose: "A correction highlights where assumptions should be exposed earlier.",
    provenance: "Feedback + follow-up message projection",
    sensitivity: "moderate",
    consent: "approved",
    retention: "30-days",
    redaction: "mask",
    status: "needs-review",
    excerpt: "Incomplete answer followed by a user correction.",
    fields: ["rating", "correction excerpt", "message revision"],
  },
  {
    id: "intake-memory-001",
    title: "UI-first workflow preference",
    source: "memory",
    sourceLabel: "Memory proposal · renderer preview",
    purpose: "A repeated request suggests an incremental UI-first workflow preference.",
    provenance: "Memory proposal with 3 matching signals",
    sensitivity: "high",
    consent: "pending",
    retention: "manual",
    redaction: "mask",
    status: "blocked",
    excerpt: "Prefer visible UI slices before large logic changes.",
    fields: ["proposal text", "scope", "matching signal count"],
  },
  {
    id: "intake-run-001",
    title: "Renderer run outcome marker",
    source: "run",
    sourceLabel: "Run projection · renderer snapshot",
    purpose: "A local outcome marker can support deterministic review without provider payloads.",
    provenance: "Run projection · no provider receipt",
    sensitivity: "low",
    consent: "not-required",
    retention: "7-days",
    redaction: "keep",
    status: "ready",
    excerpt: "Completed preview run · outcome marker only.",
    fields: ["status", "stage", "preview timestamp"],
  },
  {
    id: "intake-conversation-001",
    title: "Conversation excerpt candidate",
    source: "conversation",
    sourceLabel: "Conversation transcript · renderer preview",
    purpose: "A short excerpt may help a reviewer inspect answer quality and assumptions.",
    provenance: "Conversation projection · exact source revision unavailable",
    sensitivity: "high",
    consent: "pending",
    retention: "manual",
    redaction: "mask",
    status: "needs-review",
    excerpt: "A small transcript excerpt awaiting purpose and consent review.",
    fields: ["message excerpt", "conversation ID", "source revision"],
  },
  {
    id: "intake-portable-001",
    title: "Imported benchmark note",
    source: "portable",
    sourceLabel: "Portable bundle · renderer preview",
    purpose: "An imported note is available for inspection but should not enter a batch by default.",
    provenance: "User-provided portable preview",
    sensitivity: "restricted",
    consent: "declined",
    retention: "session",
    redaction: "remove",
    status: "excluded",
    excerpt: "Declined portable item; retained only as a visible review record.",
    fields: ["note title", "portable metadata", "import filename"],
  },
];

export const initialIntakeReview: IntakeReviewSnapshot = {
  records: seedIntakeRecords,
  purpose: "quality-review",
  retentionDefault: "30-days",
  redactionDefault: "mask",
  allowSensitive: false,
  requireConsent: true,
};

const cloneRecord = (record: IntakeRecord): IntakeRecord => ({ ...record, fields: [...record.fields] });
const cloneSnapshot = (snapshot: IntakeReviewSnapshot): IntakeReviewSnapshot => ({
  ...snapshot,
  records: snapshot.records.map(cloneRecord),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function normalizeImportedRecord(value: unknown, index: number): IntakeRecord | null {
  if (!isRecord(value)) return null;
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 140) : "";
  if (!title) return null;
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((field): field is string => typeof field === "string").map((field) => field.slice(0, 80)).slice(0, 12)
    : [];
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 120) : `imported-intake-${index + 1}`,
    title,
    source: enumValue(value.source, sourceOrder, "portable"),
    sourceLabel: typeof value.sourceLabel === "string" && value.sourceLabel.trim() ? value.sourceLabel.trim().slice(0, 180) : "Portable import · renderer preview",
    purpose: typeof value.purpose === "string" && value.purpose.trim() ? value.purpose.trim().slice(0, 240) : "Imported review record.",
    provenance: typeof value.provenance === "string" && value.provenance.trim() ? value.provenance.trim().slice(0, 240) : "Portable import",
    sensitivity: enumValue(value.sensitivity, ["low", "moderate", "high", "restricted"] as const, "moderate"),
    consent: enumValue(value.consent, ["not-required", "pending", "approved", "declined"] as const, "pending"),
    retention: enumValue(value.retention, ["session", "7-days", "30-days", "manual"] as const, "session"),
    redaction: enumValue(value.redaction, ["keep", "mask", "remove"] as const, "mask"),
    status: enumValue(value.status, statusOrder, "needs-review"),
    excerpt: typeof value.excerpt === "string" && value.excerpt.trim() ? value.excerpt.trim().slice(0, 400) : "Imported record awaiting review.",
    fields,
  };
}

export function parseIntakeReviewPayload(raw: string): IntakeRecord[] {
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  if (!normalized) throw new Error("Paste an Omnia data-intake JSON bundle first.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("The data-intake preview payload is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed.schema !== "omnia.data-intake-learning-review.v1" || !Array.isArray(parsed.records)) {
    throw new Error("Expected an Omnia data-intake learning review bundle.");
  }
  const records = parsed.records.map(normalizeImportedRecord).filter((record): record is IntakeRecord => record !== null);
  if (records.length === 0) throw new Error("The bundle contains no valid intake records.");
  return records;
}

export function isIntakeRecordEligible(snapshot: IntakeReviewSnapshot, record: IntakeRecord): boolean {
  if (record.status === "blocked" || record.status === "excluded") return false;
  if (record.consent === "declined") return false;
  if (snapshot.requireConsent && record.consent === "pending") return false;
  if (!snapshot.allowSensitive && (record.sensitivity === "high" || record.sensitivity === "restricted")) return false;
  if (record.redaction === "remove") return false;
  return true;
}

export function selectEligibleIntakeRecords(snapshot: IntakeReviewSnapshot): IntakeRecord[] {
  return snapshot.records.filter((record) => isIntakeRecordEligible(snapshot, record));
}

export function serializeIntakeReview(snapshot: IntakeReviewSnapshot, format: IntakeReviewFormat): string {
  const eligible = selectEligibleIntakeRecords(snapshot);
  const payload = {
    schema: "omnia.data-intake-learning-review.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    policy: {
      purpose: snapshot.purpose,
      retentionDefault: snapshot.retentionDefault,
      redactionDefault: snapshot.redactionDefault,
      allowSensitive: snapshot.allowSensitive,
      requireConsent: snapshot.requireConsent,
    },
    eligibility: {
      totalRecords: snapshot.records.length,
      eligibleRecordIds: eligible.map((record) => record.id),
      excludedRecordIds: snapshot.records.filter((record) => !isIntakeRecordEligible(snapshot, record)).map((record) => record.id),
    },
    records: snapshot.records.map((record) => ({
      id: record.id,
      title: record.title,
      source: record.source,
      sourceLabel: record.sourceLabel,
      purpose: record.purpose,
      provenance: record.provenance,
      sensitivity: record.sensitivity,
      consent: record.consent,
      retention: record.retention,
      redaction: record.redaction,
      status: record.status,
      excerpt: record.excerpt,
      fields: record.fields,
      eligible: eligible.some((candidate) => candidate.id === record.id),
    })),
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia data intake / learning review preview",
    "",
    "> Renderer-local preview. No hidden collection, upload, model training, provider request, or durable write is performed.",
    "",
    `Purpose: ${purposeLabels[snapshot.purpose]} · default retention: ${retentionLabels[snapshot.retentionDefault]} · default redaction: ${redactionLabels[snapshot.redactionDefault]}.`,
    `Eligibility: ${eligible.length}/${snapshot.records.length} records · sensitive=${snapshot.allowSensitive ? "allowed in preview" : "held for review"} · consent=${snapshot.requireConsent ? "required" : "not required"}.`,
    "",
    ...snapshot.records.map((record) => `- **${record.title}** — ${sourceLabels[record.source]} · ${statusLabels[record.status]} · ${sensitivityLabels[record.sensitivity]} · ${isIntakeRecordEligible(snapshot, record) ? "eligible" : "held/excluded"}`),
  ].join("\n");
}

function downloadIntakeReview(payload: string, format: IntakeReviewFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-data-intake-review-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function statusIcon(status: IntakeStatus) {
  if (status === "ready") return <CheckCircle2 size={14} />;
  if (status === "blocked") return <LockKeyhole size={14} />;
  if (status === "excluded") return <XCircle size={14} />;
  return <AlertTriangle size={14} />;
}

export default function DataIntakeLearningReview() {
  const [history, setHistory] = useState<IntakeHistory>(() => ({ past: [], present: cloneSnapshot(initialIntakeReview), future: [] }));
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<IntakeSource | "all">("all");
  const [statusFilter, setStatusFilter] = useState<IntakeStatus | "all">("all");
  const [sensitivityFilter, setSensitivityFilter] = useState<IntakeSensitivity | "all">("all");
  const [selectedId, setSelectedId] = useState(seedIntakeRecords[0]?.id ?? null);
  const [exportFormat, setExportFormat] = useState<IntakeReviewFormat>("json");
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [status, setStatus] = useState("Data intake records are renderer-local preview facts.");

  const { present } = history;
  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return present.records.filter((record) => {
      if (sourceFilter !== "all" && record.source !== sourceFilter) return false;
      if (statusFilter !== "all" && record.status !== statusFilter) return false;
      if (sensitivityFilter !== "all" && record.sensitivity !== sensitivityFilter) return false;
      if (!normalized) return true;
      return `${record.title} ${record.sourceLabel} ${record.purpose} ${record.provenance} ${record.excerpt}`.toLowerCase().includes(normalized);
    });
  }, [present.records, query, sensitivityFilter, sourceFilter, statusFilter]);
  const selected = filteredRecords.find((record) => record.id === selectedId)
    ?? present.records.find((record) => record.id === selectedId)
    ?? filteredRecords[0]
    ?? null;
  const eligibleRecords = useMemo(() => selectEligibleIntakeRecords(present), [present]);
  const metrics = useMemo(() => ({
    total: present.records.length,
    eligible: eligibleRecords.length,
    review: present.records.filter((record) => record.status === "needs-review").length,
    blocked: present.records.filter((record) => record.status === "blocked").length,
    sensitive: present.records.filter((record) => record.sensitivity === "high" || record.sensitivity === "restricted").length,
  }), [eligibleRecords.length, present.records]);
  const exportPayload = useMemo(() => serializeIntakeReview(present, exportFormat), [exportFormat, present]);

  const commit = (next: IntakeReviewSnapshot, message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneSnapshot(current.present)], present: cloneSnapshot(next), future: [] }));
    setStatus(message);
  };

  const updateRecord = (recordId: string, patch: Partial<IntakeRecord>, message: string) => {
    commit({ ...present, records: present.records.map((record) => record.id === recordId ? { ...record, ...patch } : record) }, message);
  };

  const updatePolicy = <K extends keyof Omit<IntakeReviewSnapshot, "records">>(key: K, value: IntakeReviewSnapshot[K]) => {
    commit({ ...present, [key]: value }, "Intake review policy changed in the renderer preview.");
  };

  const applyDefaults = () => {
    commit({ ...present, records: present.records.map((record) => ({ ...record, retention: present.retentionDefault, redaction: present.redactionDefault })) }, "Default retention and redaction applied to preview records.");
  };

  const importRecords = () => {
    try {
      const imported = parseIntakeReviewPayload(importDraft);
      const existingIds = new Set(present.records.map((record) => record.id));
      const deduped = imported.filter((record) => !existingIds.has(record.id));
      if (deduped.length === 0) {
        setStatus("The import contained no new records; existing preview records were unchanged.");
        return;
      }
      commit({ ...present, records: [...present.records, ...deduped] }, `Staged ${deduped.length} imported intake record${deduped.length === 1 ? "" : "s"} in the renderer preview.`);
      setImportDraft("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The intake preview import failed safely.");
    }
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      setStatus("Undid the last data-intake preview change.");
      return { past: current.past.slice(0, -1), present: cloneSnapshot(previous), future: [cloneSnapshot(current.present), ...current.future] };
    });
  };
  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      setStatus("Redid the next data-intake preview change.");
      return { past: [...current.past, cloneSnapshot(current.present)], present: cloneSnapshot(next), future: current.future.slice(1) };
    });
  };
  const reset = () => {
    commit(initialIntakeReview, "Data-intake review preview reset to defaults.");
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no intake preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatus(`Copied the ${exportFormat.toUpperCase()} data-intake preview.`);
    } catch {
      setStatus("Clipboard access was denied; no intake preview was copied.");
    }
  };

  return (
    <section className="data-intake-review" aria-label="Data intake and learning review">
      <header className="data-intake-review__header">
        <div>
          <span className="eyebrow">Data intake / learning review</span>
          <h3>Make improvement data inspectable</h3>
          <p>Review source provenance, sensitivity, consent, retention, and redaction before a future evaluation or learning batch.</p>
        </div>
        <span className="data-intake-review__chip data-intake-review__chip--amber"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="data-intake-review__metrics" role="status" aria-label="Data intake review summary">
        <div><strong>{metrics.total}</strong><span>records</span></div>
        <div><strong>{metrics.eligible}</strong><span>eligible now</span></div>
        <div><strong>{metrics.review}</strong><span>needs review</span></div>
        <div><strong>{metrics.sensitive}</strong><span>sensitive</span></div>
      </div>

      <div className="data-intake-review__toolbar" role="toolbar" aria-label="Data intake review controls">
        <label className="data-intake-review__search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search intake records" placeholder="Search source, purpose, or provenance" /></label>
        <label><span>Source</span><select aria-label="Intake source filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as IntakeSource | "all")}><option value="all">All sources</option>{sourceOrder.map((source) => <option key={source} value={source}>{sourceLabels[source]}</option>)}</select></label>
        <label><span>Status</span><select aria-label="Intake status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as IntakeStatus | "all")}><option value="all">All statuses</option>{statusOrder.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
        <label><span>Sensitivity</span><select aria-label="Intake sensitivity filter" value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value as IntakeSensitivity | "all")}><option value="all">All levels</option>{Object.entries(sensitivityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo intake review change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo intake review change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset data intake review"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={() => setExportOpen((current) => !current)} aria-expanded={exportOpen} aria-controls="data-intake-review-export"><FileJson2 size={14} /> {exportOpen ? "Hide export" : "Preview export"}</button>
      </div>

      <section className="data-intake-review__policy" aria-label="Data intake policy preview">
        <div className="data-intake-review__policy-title"><ShieldCheck size={15} /><span><strong>Admission policy</strong><small>Choose what a future review batch may consider. These controls only affect this renderer session.</small></span></div>
        <label><span>Purpose</span><select aria-label="Intake review purpose" value={present.purpose} onChange={(event) => updatePolicy("purpose", event.target.value as IntakePurpose)}>{Object.entries(purposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Default retention</span><select aria-label="Default intake retention" value={present.retentionDefault} onChange={(event) => updatePolicy("retentionDefault", event.target.value as IntakeRetention)}>{Object.entries(retentionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Default redaction</span><select aria-label="Default intake redaction" value={present.redactionDefault} onChange={(event) => updatePolicy("redactionDefault", event.target.value as IntakeRedaction)}>{Object.entries(redactionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="data-intake-review__toggle"><input type="checkbox" checked={present.requireConsent} onChange={(event) => updatePolicy("requireConsent", event.target.checked)} /><span>Require consent</span></label>
        <label className="data-intake-review__toggle"><input type="checkbox" checked={present.allowSensitive} onChange={(event) => updatePolicy("allowSensitive", event.target.checked)} /><span>Allow sensitive in preview</span></label>
        <button type="button" className="button button--ghost" onClick={applyDefaults}><Filter size={13} /> Apply defaults</button>
      </section>

      <div className="data-intake-review__subtoolbar">
        <span className="data-intake-review__status" role="status" aria-live="polite">{status}</span>
        <div>
          <button type="button" className="button button--ghost" onClick={() => setImportOpen((current) => !current)} aria-expanded={importOpen} aria-controls="data-intake-review-import"><Upload size={14} /> {importOpen ? "Hide import" : "Import bundle"}</button>
          <span className="data-intake-review__boundary-chip"><Database size={12} /> {metrics.blocked} blocked by policy</span>
        </div>
      </div>

      {importOpen ? <section id="data-intake-review-import" className="data-intake-review__import" aria-label="Data intake import preview">
        <header><div><span className="eyebrow">Portable import preview</span><h4>Stage records without activating them</h4></div><span className="data-intake-review__chip data-intake-review__chip--teal">No durable write</span></header>
        <textarea value={importDraft} onChange={(event) => setImportDraft(event.target.value)} rows={6} aria-label="Data intake import payload" placeholder='{"schema":"omnia.data-intake-learning-review.v1","records":[{"title":"Review note","source":"portable"}]}' />
        <div className="data-intake-review__import-actions"><button type="button" className="button button--secondary" onClick={importRecords}><Check size={14} /> Stage valid records</button><button type="button" className="button button--ghost" onClick={() => setImportDraft("")}><RotateCcw size={14} /> Clear</button></div>
        <p className="data-intake-review__boundary"><LockKeyhole size={13} /> Parsing validates a renderer-local bundle only. It does not collect hidden data, upload records, train a model, approve consent, or write native storage.</p>
      </section> : null}

      {exportOpen ? <section id="data-intake-review-export" className="data-intake-review__export" aria-label="Data intake export preview">
        <header><div><span className="eyebrow">Portable review bundle</span><h4>{eligibleRecords.length} eligible records / {present.records.length} visible</h4></div><span className="data-intake-review__chip data-intake-review__chip--teal">Renderer-local</span></header>
        <div className="data-intake-review__export-toolbar"><label><span>Format</span><select aria-label="Data intake export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as IntakeReviewFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setStatus(downloadIntakeReview(exportPayload, exportFormat) ? "Downloaded a renderer-local intake review preview." : "Download is unavailable; no intake preview was exported.")}><Download size={14} /> Download</button></div>
        <pre className="data-intake-review__code" tabIndex={0}><code>{exportPayload}</code></pre>
      </section> : null}

      <div className="data-intake-review__layout">
        <div className="data-intake-review__list" role="list" aria-label="Data intake records">
          {filteredRecords.length === 0 ? <div className="data-intake-review__empty"><Database size={20} /><strong>No records match</strong><span>Adjust the filters or reset the preview.</span></div> : null}
          {filteredRecords.map((record) => <button key={record.id} type="button" role="listitem" aria-label={`${record.title} · ${sourceLabels[record.source]} · ${statusLabels[record.status]}`} aria-pressed={selected?.id === record.id} className={`data-intake-review__record${selected?.id === record.id ? " data-intake-review__record--selected" : ""}`} onClick={() => setSelectedId(record.id)}><span className={`data-intake-review__record-icon data-intake-review__record-icon--${record.status}`} aria-hidden="true">{statusIcon(record.status)}</span><span className="data-intake-review__record-copy"><strong>{record.title}</strong><small>{sourceLabels[record.source]} · {statusLabels[record.status]}</small><span><em className={`data-intake-review__chip data-intake-review__chip--${record.sensitivity}`}>{sensitivityLabels[record.sensitivity]}</em><em className="data-intake-review__chip">{record.consent === "pending" ? "Consent pending" : consentLabels[record.consent]}</em></span></span></button>)}
        </div>
        <aside className="data-intake-review__detail" aria-label="Selected data intake record">
          {selected ? <>
            <header><div><span className="eyebrow">Selected record</span><h4>{selected.title}</h4></div><span className={`data-intake-review__chip data-intake-review__chip--${selected.status}`}>{statusLabels[selected.status]}</span></header>
            <p className="data-intake-review__excerpt">{selected.excerpt}</p>
            <dl className="data-intake-review__facts"><div><dt>Source</dt><dd>{selected.sourceLabel}</dd></div><div><dt>Provenance</dt><dd>{selected.provenance}</dd></div><div><dt>Sensitivity</dt><dd>{sensitivityLabels[selected.sensitivity]}</dd></div><div><dt>Consent</dt><dd>{consentLabels[selected.consent]}</dd></div><div><dt>Retention</dt><dd>{retentionLabels[selected.retention]}</dd></div><div><dt>Redaction</dt><dd>{redactionLabels[selected.redaction]}</dd></div></dl>
            <div className="data-intake-review__fields"><strong>Visible fields</strong><span>{selected.fields.length ? selected.fields.join(" · ") : "No field names provided"}</span></div>
            <div className="data-intake-review__actions"><button type="button" className="button button--secondary" onClick={() => updateRecord(selected.id, { status: "ready" }, `${selected.title} marked ready in the renderer preview.`)}><CheckCircle2 size={14} /> Mark ready</button><button type="button" className="button button--ghost" onClick={() => updateRecord(selected.id, { consent: "approved", status: "needs-review" }, `${selected.title} consent marked approved in the renderer preview.`)}><ShieldCheck size={14} /> Approve in preview</button><button type="button" className="button button--ghost" onClick={() => updateRecord(selected.id, { status: "excluded" }, `${selected.title} excluded from the renderer preview batch.`)}><XCircle size={14} /> Exclude</button><button type="button" className="button button--ghost" onClick={() => updateRecord(selected.id, { retention: present.retentionDefault, redaction: present.redactionDefault }, `${selected.title} received the current default retention and redaction.`)}><RotateCcw size={14} /> Apply defaults</button></div>
            <p className="data-intake-review__detail-status" role="status">{isIntakeRecordEligible(present, selected) ? "Eligible under the current local policy." : "Held or excluded under the current local policy."}</p>
          </> : <div className="data-intake-review__empty"><Eye size={20} /><strong>Select a record</strong><span>Its provenance and review policy will appear here.</span></div>}
        </aside>
      </div>

      <p className="data-intake-review__boundary"><LockKeyhole size={14} /><span>Renderer-local only: no hidden user-data collection, model training, checkpointing, provider upload, native consent receipt, durable retention, filesystem read, or execution is performed by this surface.</span></p>
    </section>
  );
}
