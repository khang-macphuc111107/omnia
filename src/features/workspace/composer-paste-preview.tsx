import { Check, Clipboard, Download, Eye, FileText, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";

import {
  composerPastePreviewExcerpt,
  downloadComposerPastePreview,
  formatComposerPasteMetrics,
  projectComposerPasteFile,
  type ComposerPasteAssessment,
} from "./composer-paste";

export interface ComposerPastePreviewProps {
  readonly assessment: ComposerPasteAssessment;
  readonly notice: string;
  readonly onDismiss: () => void;
}

/**
 * File-conversion rehearsal for a threshold-crossing paste. This is an
 * intentionally browser-safe projection: it exposes the future file UX while
 * keeping the exact text inline and never claiming native ingestion.
 */
export function ComposerPastePreview({
  assessment,
  notice,
  onDismiss,
}: ComposerPastePreviewProps) {
  const projection = useMemo(() => projectComposerPasteFile(assessment), [assessment]);
  const [showContents, setShowContents] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const copyText = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; the inline text remains unchanged.");
      return;
    }
    try {
      await navigator.clipboard.writeText(projection.sourceText);
      setStatus("Copied the plain-text paste preview. No file or attachment was created.");
    } catch {
      setStatus("Clipboard access was denied; no paste preview was copied.");
    }
  };

  const downloadText = () => {
    setStatus(
      downloadComposerPastePreview(projection)
        ? `Browser download started for ${projection.suggestedName}; no native file receipt was created.`
        : "Browser download is unavailable; no file was written.",
    );
  };

  return (
    <section className="composer-paste-preview" role="status" aria-live="polite" aria-label="Large paste conversion preview">
      <header className="composer-paste-preview__header">
        <div className="composer-paste-preview__heading">
          <span className="composer-paste-preview__icon" aria-hidden="true"><FileText size={15} /></span>
          <div>
            <strong>Large paste conversion preview</strong>
            <p>{notice}</p>
          </div>
        </div>
        <button type="button" className="composer-paste-preview__dismiss" onClick={onDismiss} aria-label="Dismiss large paste preview" title="Dismiss large paste preview">
          <X size={14} />
        </button>
      </header>

      <div className="composer-paste-preview__badges" aria-label="Paste preview boundaries">
        <span><ShieldCheck size={12} /> Preview only</span>
        <span>Renderer-local</span>
        <span>No durable write</span>
      </div>

      <div className="composer-paste-preview__file" aria-label="Projected paste file">
        <div className="composer-paste-preview__file-icon" aria-hidden="true"><FileText size={18} /></div>
        <div className="composer-paste-preview__file-copy">
          <strong>{projection.suggestedName}</strong>
          <span>{projection.mediaType} · {formatComposerPasteMetrics(assessment)}</span>
          <small>Preview hash: {projection.previewHash}{projection.richClipboardDetected ? " · rich clipboard detected" : ""}</small>
        </div>
        <button type="button" className="button button--ghost" onClick={() => setShowContents((open) => !open)} aria-expanded={showContents} aria-controls="composer-paste-preview-content">
          <Eye size={13} /> {showContents ? "Hide preview" : "Open preview"}
        </button>
      </div>

      {showContents ? (
        <pre id="composer-paste-preview-content" className="composer-paste-preview__content" tabIndex={0}><code>{composerPastePreviewExcerpt(projection.sourceText)}</code></pre>
      ) : null}

      <div className="composer-paste-preview__actions" role="group" aria-label="Paste preview actions">
        <button type="button" className="button button--ghost" onClick={() => void copyText()}><Clipboard size={13} /> Copy text</button>
        <button type="button" className="button button--secondary" onClick={downloadText}><Download size={13} /> Download .txt</button>
        <button type="button" className="button button--ghost" onClick={onDismiss}><Check size={13} /> Keep inline</button>
      </div>

      <div className="composer-paste-preview__planned" aria-label="Native paste actions planned">
        <span>When native ingestion is connected:</span>
        <button type="button" disabled title="Native clipboard-to-file conversion is planned">Send full file</button>
        <button type="button" disabled title="Native range extraction is planned">Send selected range</button>
        <button type="button" disabled title="Native summarize-before-send is planned">Summarize first</button>
      </div>

      {status ? <p className="composer-paste-preview__status">{status}</p> : null}
      <p className="composer-paste-preview__boundary">The exact plain text stays in the composer. This preview does not read a file, upload clipboard bytes, call a provider, or create a native attachment/lineage receipt.</p>
    </section>
  );
}
