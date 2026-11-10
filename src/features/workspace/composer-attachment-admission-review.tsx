import { Clipboard, Download, Info, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";

import type { RoutedProviderModel } from "./provider-parameters";
import {
  reviewComposerAttachmentAdmission,
  serializeAttachmentAdmissionReview,
  summarizeAttachmentAdmission,
  type AttachmentAdmissionGateStatus,
  type AttachmentAdmissionReview,
} from "./composer-attachment-admission-review-contract";
import type { ComposerAttachmentItem } from "./composer-attachments";

function downloadReport(payload: string, format: "json" | "markdown"): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-attachment-admission.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const gateStatusLabel: Record<AttachmentAdmissionGateStatus, string> = {
  pass: "Pass",
  review: "Review",
  blocked: "Blocked",
  planned: "Planned",
};

function decisionLabel(review: AttachmentAdmissionReview): string {
  if (review.decision === "blocked") return "Blocked";
  if (review.decision === "review") return "Needs review";
  return "Planned · not admitted";
}

export function ComposerAttachmentAdmissionReview({
  attachments,
  route,
}: {
  readonly attachments: readonly ComposerAttachmentItem[];
  readonly route: RoutedProviderModel | null;
}) {
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("Admission review has not produced a native receipt.");
  const reviews = useMemo(() => reviewComposerAttachmentAdmission(attachments, route), [attachments, route]);
  const summary = useMemo(() => summarizeAttachmentAdmission(reviews), [reviews]);
  const selected = reviews.find((review) => review.attachmentId === selectedId) ?? reviews[0] ?? null;
  const payload = useMemo(() => serializeAttachmentAdmissionReview(reviews, format), [format, reviews]);

  if (reviews.length === 0) return null;

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no admission report was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus(`Copied the renderer-local ${format.toUpperCase()} admission report.`);
    } catch {
      setStatus("Clipboard access was denied; no admission report was copied.");
    }
  };

  return (
    <section className="composer-attachment-admission" aria-label="Attachment admission review">
      <header className="composer-attachment-admission__header">
        <div>
          <span className="eyebrow">Frozen input rehearsal</span>
          <h3><ShieldAlert size={15} /> Admission review</h3>
          <p>Inspect the gates a future native bridge must pass before any attachment can leave Omnia.</p>
        </div>
        <span className="composer-attachment-admission__badge">Preview only</span>
      </header>
      <div className="composer-attachment-admission__summary" role="status" aria-live="polite">
        <span><strong>{summary.blocked}</strong> blocked</span>
        <span><strong>{summary.review}</strong> review</span>
        <span><strong>{summary.planned}</strong> planned</span>
        <span><strong>{summary.total}</strong> attachment{summary.total === 1 ? "" : "s"}</span>
      </div>
      <div className="composer-attachment-admission__body">
        <div className="composer-attachment-admission__records" role="list" aria-label="Attachment admission records">
          {reviews.map((review, index) => (
            <button
              key={review.attachmentId}
              type="button"
              className={`composer-attachment-admission__record${selected?.attachmentId === review.attachmentId ? " is-selected" : ""}`}
              aria-pressed={selected?.attachmentId === review.attachmentId}
              onClick={() => setSelectedId(review.attachmentId)}
            >
              <span><strong title={review.name}>Attachment {index + 1}</strong><small>{review.kind} · {decisionLabel(review)}</small></span>
              <em className={`composer-attachment-admission__decision composer-attachment-admission__decision--${review.decision}`}>{review.decision}</em>
            </button>
          ))}
        </div>
        {selected ? (
          <article className="composer-attachment-admission__detail" aria-label={`Admission gates for ${selected.name}`}>
            <div className="composer-attachment-admission__detail-header"><span><strong title={selected.name}>Selected attachment</strong><small>{selected.kind} · {decisionLabel(selected)}</small></span><span className={`composer-attachment-admission__decision composer-attachment-admission__decision--${selected.decision}`}>{selected.decision}</span></div>
            <ul>
              {selected.gates.map((item) => (
                <li key={item.id} className={`composer-attachment-admission__gate composer-attachment-admission__gate--${item.status}`}>
                  <span><strong>{item.label}</strong><small>{gateStatusLabel[item.status]}</small></span>
                  <p>{item.detail}</p>
                </li>
              ))}
            </ul>
          </article>
        ) : null}
      </div>
      <div className="composer-attachment-admission__actions">
        <span className="composer-attachment-admission__status" role="status" aria-live="polite">{status}</span>
        <label><span>Report format</span><select aria-label="Attachment admission report format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" onClick={() => setStatus(downloadReport(payload, format) ? "Downloaded a renderer-local admission report." : "File download is unavailable; no report was exported.")}><Download size={13} /> Download</button>
      </div>
      <p className="composer-attachment-admission__boundary"><Info size={13} /> {summary.dispatchGated ? "Native admission, carrier upload, provider acceptance, and dispatch remain gated." : "No attachment is under review."} No file bytes, paths, secrets, or durable receipt are exposed by this preview.</p>
    </section>
  );
}

export default ComposerAttachmentAdmissionReview;
