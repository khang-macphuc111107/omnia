import { CheckCircle2, Eye, Info, ShieldAlert, XCircle } from "lucide-react";
import { useMemo } from "react";

import type { RoutedProviderModel } from "./provider-parameters";
import {
  assessComposerAttachmentCompatibility,
  composerAttachmentCompatibilityReason,
  summarizeComposerAttachmentCompatibility,
  type ComposerAttachmentCompatibilityStatus,
} from "./composer-attachment-compatibility-contract";
import type { ComposerAttachmentItem } from "./composer-attachments";

interface ComposerAttachmentCompatibilityProps {
  attachments: readonly ComposerAttachmentItem[];
  route: RoutedProviderModel | null;
}

function statusIcon(status: ComposerAttachmentCompatibilityStatus) {
  if (status === "compatible") return <CheckCircle2 size={13} aria-hidden="true" />;
  if (status === "blocked") return <XCircle size={13} aria-hidden="true" />;
  if (status === "preview-only") return <Eye size={13} aria-hidden="true" />;
  return <ShieldAlert size={13} aria-hidden="true" />;
}

function statusClass(status: ComposerAttachmentCompatibilityStatus): string {
  return `composer-attachment-compatibility__status composer-attachment-compatibility__status--${status}`;
}

export function ComposerAttachmentCompatibility({ attachments, route }: ComposerAttachmentCompatibilityProps) {
  const rows = useMemo(
    () => assessComposerAttachmentCompatibility(attachments, route),
    [attachments, route],
  );
  const summary = useMemo(() => summarizeComposerAttachmentCompatibility(rows), [rows]);
  if (rows.length === 0) return null;

  const routeLabel = route
    ? `${route.provider.name} · ${route.model.displayName}`
    : "No provider model selected";
  const reason = composerAttachmentCompatibilityReason(summary);

  return (
    <section className="composer-attachment-compatibility" aria-label="Attachment compatibility preview">
      <header className="composer-attachment-compatibility__header">
        <div>
          <span className="eyebrow">Attachment route fit</span>
          <h3>Compatibility preview</h3>
          <p>{routeLabel}</p>
        </div>
        <span className="composer-attachment-compatibility__badge">Preview only</span>
      </header>
      <div className="composer-attachment-compatibility__summary" role="status" aria-live="polite">
        <span><strong>{summary.compatible}</strong> compatible</span>
        <span><strong>{summary.review}</strong> review</span>
        <span><strong>{summary.blocked}</strong> blocked</span>
        {summary.previewOnly > 0 ? <span><strong>{summary.previewOnly}</strong> preview-only</span> : null}
      </div>
      <ul className="composer-attachment-compatibility__list">
        {rows.map((row) => (
          <li key={row.attachmentId} className="composer-attachment-compatibility__row">
            <span className={statusClass(row.status)}>{statusIcon(row.status)} {row.label}</span>
            <span className="composer-attachment-compatibility__copy">
              <strong title={row.name}>Attachment {rows.indexOf(row) + 1}</strong>
              <small>{row.modalityLabel} · {row.detail}</small>
            </span>
          </li>
        ))}
      </ul>
      <p className="composer-attachment-compatibility__boundary">
        <Info size={13} aria-hidden="true" />
        {reason ?? "Attachment compatibility is not available."} Provider upload, carrier planning, and dispatch remain gated.
      </p>
    </section>
  );
}
