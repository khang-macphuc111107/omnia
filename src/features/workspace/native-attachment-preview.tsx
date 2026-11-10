import { useEffect, useRef, useState } from "react";

import { ModalSurface } from "@/components/modal-surface";
import { desktop } from "@/lib/desktop";
import {
  createAttachmentBinaryPreview,
  type AttachmentBinaryPreview,
} from "./attachment-binary-preview";

const DEFAULT_LIMIT = 4 * 1024 * 1024;

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return "Could not read this attachment.";
}

/** Reads bytes only after a user opens the preview. No file data is retained
 * in localStorage, app snapshots, or message metadata. */
export function NativeAttachmentPreview({ attachmentId, name }: { attachmentId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [preview, setPreview] = useState<AttachmentBinaryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    setOpen(false);
    setPreview(null);
    setError(null);
    setBusy(false);
    return () => { requestVersion.current += 1; };
  }, [attachmentId]);

  const close = () => {
    requestVersion.current += 1;
    setOpen(false);
    setPreview(null);
    setBusy(false);
    setError(null);
  };

  const load = async (maxBytes: number) => {
    const version = ++requestVersion.current;
    setOpen(true);
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const receipt = await desktop.readAttachmentBinaryPreview({ attachmentId, maxBytes });
      const next = createAttachmentBinaryPreview(receipt, attachmentId);
      if (version === requestVersion.current) setPreview(next);
    } catch (cause) {
      if (version === requestVersion.current) setError(errorMessage(cause));
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };

  return <>
    <button type="button" className="button button--ghost" aria-label={`Preview ${name}`} onClick={() => void load(limit)}>Preview</button>
    {open ? <ModalSurface className="attachment-binary-preview" title={`Preview · ${name}`} ariaLabel={`Preview ${name}`} onClose={close}>
      <header className="attachment-binary-preview__toolbar">
        <label>Read limit <select aria-label="Attachment preview read limit" value={limit} disabled={busy} onChange={(event) => setLimit(Number(event.target.value))}>
          <option value={DEFAULT_LIMIT}>4 MiB</option>
          <option value={16 * 1024 * 1024}>16 MiB</option>
        </select></label>
        <button type="button" className="button button--secondary" disabled={busy} onClick={() => void load(limit)}>{busy ? "Reading…" : "Reload"}</button>
        <button type="button" className="button button--ghost" onClick={close}>Close</button>
      </header>
      {busy ? <p role="status">Reading and verifying the encrypted attachment…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {preview ? <div className="attachment-binary-preview__content">
        <dl className="attachment-binary-preview__metadata">
          <dt>Type</dt><dd>{preview.mediaType}</dd>
          <dt>Size</dt><dd>{preview.byteSize.toLocaleString()} bytes</dd>
          <dt>SHA-256</dt><dd><code>{preview.contentSha256}</code></dd>
        </dl>
        {preview.mediaKind === "image" && preview.mediaUrl ? <img className="attachment-binary-preview__media" src={preview.mediaUrl} alt={`Preview of ${name}`} /> : null}
        {preview.mediaKind === "video" && preview.mediaUrl ? <video className="attachment-binary-preview__media" src={preview.mediaUrl} aria-label={`Preview of ${name}`} controls preload="metadata" /> : null}
        {preview.mediaKind === "audio" && preview.mediaUrl ? <audio className="attachment-binary-preview__media" src={preview.mediaUrl} aria-label={`Preview of ${name}`} controls preload="metadata" /> : null}
        {preview.text !== null ? <details open><summary>UTF-8 text{preview.textTruncated ? " · first 64 KiB" : ""}</summary><pre tabIndex={0} aria-label="Attachment text"><code>{preview.text}</code></pre></details> : null}
        <details open={preview.mediaKind === null && preview.text === null}><summary>Hex and ASCII{preview.hexTruncated ? " · first 4 KiB" : ""}</summary><pre tabIndex={0} aria-label="Attachment hex"><code>{preview.hex || "Empty file"}</code></pre></details>
        {preview.mediaKind === null ? <p className="attachment-binary-preview__note">This view shows the verified file bytes. Office documents, PDF, archives and password-protected formats need a format decoder to display their contents.</p> : null}
      </div> : null}
    </ModalSurface> : null}
  </>;
}
