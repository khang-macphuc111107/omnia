import { Check, Clipboard, Download, FileCheck2, History, RotateCcw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

export type ProjectMetadataReceiptMode = "browser-preview" | "native-command";

export type ProjectMetadataReceiptOutcome = "applied" | "failed" | "blocked" | "no-op";

export type ProjectMetadataReceiptField = "name" | "description" | "instructions";

export interface ProjectMetadataVector {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

export interface ProjectMetadataReceiptPreview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly mode: ProjectMetadataReceiptMode;
  readonly outcome: ProjectMetadataReceiptOutcome;
  readonly changedFields: readonly ProjectMetadataReceiptField[];
  readonly expectedUpdatedAtMs: number | null;
  readonly observedUpdatedAtMs: number | null;
  readonly recordedAt: string;
  readonly detail: string;
  readonly authoritative: false;
  readonly durable: false;
}

export type ProjectMetadataReceiptExportFormat = "json" | "markdown";

export const PROJECT_METADATA_RECEIPT_PREVIEW_FORMAT = "omnia.project-metadata-receipt-preview.v1" as const;

export const PROJECT_METADATA_RECEIPT_PREVIEW_BOUNDARY =
  "Renderer-session observation only. It does not prove a durable mutation receipt, Project Twin revision, native replay, or restart recovery.";

const FIELD_ORDER: readonly ProjectMetadataReceiptField[] = ["name", "description", "instructions"];

const FIELD_LABELS: Record<ProjectMetadataReceiptField, string> = {
  name: "Project name",
  description: "Description",
  instructions: "Instructions",
};

function safeText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeCursor(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function changedProjectMetadataFields(
  before: ProjectMetadataVector,
  after: ProjectMetadataVector,
): ProjectMetadataReceiptField[] {
  return FIELD_ORDER.filter((field) => before[field] !== after[field]);
}

export function createProjectMetadataReceiptPreview({
  projectId,
  mode,
  outcome,
  before,
  after,
  expectedUpdatedAtMs,
  observedUpdatedAtMs,
  detail,
  sequence,
  recordedAt = new Date().toISOString(),
}: {
  readonly projectId: string;
  readonly mode: ProjectMetadataReceiptMode;
  readonly outcome: ProjectMetadataReceiptOutcome;
  readonly before: ProjectMetadataVector;
  readonly after: ProjectMetadataVector;
  readonly expectedUpdatedAtMs?: number | null;
  readonly observedUpdatedAtMs?: number | null;
  readonly detail: string;
  readonly sequence: number;
  readonly recordedAt?: string;
}): ProjectMetadataReceiptPreview {
  const normalizedProjectId = safeText(projectId, 160) || "unknown-project";
  const normalizedSequence = Number.isSafeInteger(sequence) && sequence > 0 ? sequence : 1;
  return {
    schemaVersion: 1,
    id: `project-metadata-preview:${normalizedProjectId}:${normalizedSequence}`,
    projectId: normalizedProjectId,
    mode,
    outcome,
    changedFields: changedProjectMetadataFields(before, after),
    expectedUpdatedAtMs: safeCursor(expectedUpdatedAtMs),
    observedUpdatedAtMs: safeCursor(observedUpdatedAtMs),
    recordedAt: safeText(recordedAt, 80) || new Date(0).toISOString(),
    detail: safeText(detail, 360) || "No detail was recorded.",
    authoritative: false,
    durable: false,
  };
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function safeReceipt(receipt: ProjectMetadataReceiptPreview): ProjectMetadataReceiptPreview {
  return {
    ...receipt,
    projectId: safeText(receipt.projectId, 160),
    id: safeText(receipt.id, 220),
    changedFields: receipt.changedFields.filter((field) => FIELD_ORDER.includes(field)),
    expectedUpdatedAtMs: safeCursor(receipt.expectedUpdatedAtMs),
    observedUpdatedAtMs: safeCursor(receipt.observedUpdatedAtMs),
    recordedAt: safeText(receipt.recordedAt, 80),
    detail: safeText(receipt.detail, 360),
    authoritative: false,
    durable: false,
  };
}

export function serializeProjectMetadataReceiptPreview(
  receipts: readonly ProjectMetadataReceiptPreview[],
  format: ProjectMetadataReceiptExportFormat,
): string {
  const safeReceipts = receipts.slice(0, 12).map(safeReceipt);
  if (format === "json") {
    return JSON.stringify(
      {
        format: PROJECT_METADATA_RECEIPT_PREVIEW_FORMAT,
        version: 1,
        scope: "renderer-session",
        authoritative: false,
        durable: false,
        boundary: PROJECT_METADATA_RECEIPT_PREVIEW_BOUNDARY,
        entryCount: safeReceipts.length,
        entries: safeReceipts,
      },
      null,
      2,
    );
  }

  return [
    "# Omnia Project metadata save observation preview",
    "",
    `> ${PROJECT_METADATA_RECEIPT_PREVIEW_BOUNDARY}`,
    "",
    `- Entries: ${safeReceipts.length}`,
    "- Scope: renderer-session",
    "- Authoritative: no",
    "- Durable: no",
    "",
    ...(safeReceipts.length > 0
      ? safeReceipts.flatMap((receipt, index) => [
          `## Observation ${index + 1}`,
          "",
          `- ID: ${markdownValue(receipt.id)}`,
          `- Project: ${markdownValue(receipt.projectId)}`,
          `- Mode: ${receipt.mode}`,
          `- Outcome: ${receipt.outcome}`,
          `- Changed fields: ${receipt.changedFields.length ? receipt.changedFields.map((field) => FIELD_LABELS[field]).join(", ") : "None"}`,
          `- Expected updatedAt: ${receipt.expectedUpdatedAtMs ?? "Unknown"}`,
          `- Observed updatedAt: ${receipt.observedUpdatedAtMs ?? "Not observed"}`,
          `- Recorded: ${markdownValue(receipt.recordedAt)}`,
          "",
          markdownValue(receipt.detail),
          "",
        ])
      : ["No save observation has been recorded in this renderer session.", ""]),
  ].join("\n");
}

export function downloadProjectMetadataReceiptPreview(
  payload: string,
  format: ProjectMetadataReceiptExportFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-metadata-receipt-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function projectMetadataReceiptFieldLabel(field: ProjectMetadataReceiptField): string {
  return FIELD_LABELS[field];
}

export interface ProjectMetadataReceiptPreviewProps {
  readonly projectId: string;
  readonly receipts: readonly ProjectMetadataReceiptPreview[];
  readonly onClear?: () => void;
}

const OUTCOME_LABELS: Record<ProjectMetadataReceiptOutcome, string> = {
  applied: "Applied",
  failed: "Failed",
  blocked: "Blocked",
  "no-op": "No change",
};

function modeLabel(mode: ProjectMetadataReceiptPreview["mode"]): string {
  return mode === "native-command" ? "Native command observed" : "Browser preview applied";
}

function formatCursor(value: number | null): string {
  return value === null ? "Not observed" : String(value);
}

/**
 * Shows a bounded, renderer-session observation trail beside Project metadata.
 * It intentionally uses receipt-shaped metadata without claiming a native
 * mutation receipt or a Project Twin revision.
 */
export function ProjectMetadataReceiptPreview({
  projectId,
  receipts,
  onClear,
}: ProjectMetadataReceiptPreviewProps) {
  const [format, setFormat] = useState<ProjectMetadataReceiptExportFormat>("json");
  const [status, setStatus] = useState("No observation has been exported.");
  const payload = useMemo(
    () => serializeProjectMetadataReceiptPreview(receipts, format),
    [format, receipts],
  );
  const appliedCount = receipts.filter((receipt) => receipt.outcome === "applied").length;
  const reviewCount = receipts.filter((receipt) => receipt.outcome === "failed" || receipt.outcome === "blocked").length;

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no observation preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied ${receipts.length} renderer-session observation${receipts.length === 1 ? "" : "s"}.`);
    } catch {
      setStatus("Clipboard access was denied; no observation preview was copied.");
    }
  };

  const download = () => {
    setStatus(
      downloadProjectMetadataReceiptPreview(payload, format)
        ? "Browser download started; no durable receipt file was written."
        : "Browser download is unavailable; no observation preview was written.",
    );
  };

  return (
    <section
      className="project-metadata-receipt-preview"
      aria-labelledby={`project-metadata-receipt-preview-title-${projectId}`}
    >
      <header className="project-metadata-receipt-preview__header">
        <div>
          <span className="eyebrow"><FileCheck2 size={13} /> Save observation</span>
          <h3 id={`project-metadata-receipt-preview-title-${projectId}`}>Project metadata receipt preview</h3>
          <p>See which save path was attempted and which metadata fields changed, without confusing a renderer observation with native authority.</p>
        </div>
        <span className="project-metadata-receipt-preview__badge"><ShieldCheck size={13} /> Session-only</span>
      </header>

      <div className="project-metadata-receipt-preview__metrics" aria-label="Project metadata observation summary">
        <span><strong>{receipts.length}</strong><small>observations</small></span>
        <span><strong>{appliedCount}</strong><small>applied</small></span>
        <span><strong>{reviewCount}</strong><small>needs review</small></span>
      </div>

      {receipts.length > 0 ? (
        <ol className="project-metadata-receipt-preview__list" aria-label="Project metadata save observations">
          {receipts.map((receipt) => (
            <li key={receipt.id} className={`project-metadata-receipt-preview__item project-metadata-receipt-preview__item--${receipt.outcome}`}>
              <div className="project-metadata-receipt-preview__item-heading">
                <span className="project-metadata-receipt-preview__item-icon"><History size={13} /></span>
                <div>
                  <strong>{modeLabel(receipt.mode)}</strong>
                  <small>{receipt.recordedAt} · {receipt.outcome === "failed" || receipt.outcome === "blocked" ? "Review required" : OUTCOME_LABELS[receipt.outcome]}</small>
                </div>
                <em>{OUTCOME_LABELS[receipt.outcome]}</em>
              </div>
              <p>{receipt.detail}</p>
              <dl>
                <div><dt>Changed fields</dt><dd>{receipt.changedFields.length ? receipt.changedFields.map(projectMetadataReceiptFieldLabel).join(" · ") : "None"}</dd></div>
                <div><dt>Expected cursor</dt><dd>{formatCursor(receipt.expectedUpdatedAtMs)}</dd></div>
                <div><dt>Observed cursor</dt><dd>{formatCursor(receipt.observedUpdatedAtMs)}</dd></div>
                <div><dt>Authority</dt><dd>Renderer observation</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <div className="project-metadata-receipt-preview__empty">
          <History size={18} />
          <strong>No save observation yet</strong>
          <small>Change Project metadata and save to record a bounded observation for this renderer session.</small>
        </div>
      )}

      <div className="project-metadata-receipt-preview__toolbar" role="toolbar" aria-label="Project metadata observation actions">
        <label>
          <span>Format</span>
          <select aria-label="Project metadata observation export format" value={format} onChange={(event) => setFormat(event.target.value as ProjectMetadataReceiptExportFormat)}>
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
          </select>
        </label>
        <span className="project-metadata-receipt-preview__status" role="status" aria-live="polite">{status}</span>
        <button type="button" className="button button--ghost" onClick={() => void copy()} disabled={receipts.length === 0}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" onClick={download} disabled={receipts.length === 0}><Download size={13} /> Download</button>
        {onClear ? <button type="button" className="button button--ghost" onClick={onClear} disabled={receipts.length === 0}><RotateCcw size={13} /> Clear</button> : null}
      </div>

      {receipts.length > 0 ? <pre className="project-metadata-receipt-preview__payload" aria-label="Project metadata observation export preview"><code>{payload}</code></pre> : null}

      <p className="project-metadata-receipt-preview__boundary"><Check size={13} /> {PROJECT_METADATA_RECEIPT_PREVIEW_BOUNDARY}</p>
    </section>
  );
}

export default ProjectMetadataReceiptPreview;
