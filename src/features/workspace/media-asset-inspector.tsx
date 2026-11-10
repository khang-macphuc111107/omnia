import { useMemo } from "react";
import { CheckCircle2, Clipboard, Download, FileJson2, Info, ShieldAlert } from "lucide-react";
import type { MediaGalleryKind, MediaGalleryStatus } from "./media-gallery-preview";

export type MediaAssetSource = "sample" | "history";
export type MediaAssetInspectionReadiness = "review" | "planned";
export type MediaAssetInspectionCheckState = "observed" | "not-observed" | "planned";

export type MediaAssetInspectorInput = {
  readonly id: string;
  readonly title: string;
  readonly kind: MediaGalleryKind;
  readonly subtitle: string;
  readonly detail: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly status: MediaGalleryStatus;
  readonly source: MediaAssetSource;
};

export type MediaAssetInspectionCheck = {
  readonly id: string;
  readonly label: string;
  readonly state: MediaAssetInspectionCheckState;
  readonly detail: string;
};

export type MediaAssetInspection = {
  readonly schema: "omnia.media-asset-inspector.preview.v1";
  readonly assetId: string;
  readonly title: string;
  readonly kind: MediaGalleryKind;
  readonly readiness: MediaAssetInspectionReadiness;
  readonly source: MediaAssetSource;
  readonly referenceHash: string;
  readonly bytesIncluded: false;
  readonly durableArtifact: false;
  readonly providerResult: "not-observed";
  readonly nativeReceipt: "not-observed";
  readonly endpointProbe: "not-observed";
  readonly checks: readonly MediaAssetInspectionCheck[];
};

/** Creates a deterministic, metadata-only inspection record for this renderer reference. */
export function buildMediaAssetInspection(item: MediaAssetInspectorInput): MediaAssetInspection {
  const readiness: MediaAssetInspectionReadiness = item.status === "attention" ? "review" : "planned";
  const referenceHash = previewReferenceHash([item.id, item.title, item.kind, item.detail, item.prompt].join("|"));

  return {
    schema: "omnia.media-asset-inspector.preview.v1",
    assetId: item.id,
    title: item.title,
    kind: item.kind,
    readiness,
    source: item.source,
    referenceHash,
    bytesIncluded: false,
    durableArtifact: false,
    providerResult: "not-observed",
    nativeReceipt: "not-observed",
    endpointProbe: "not-observed",
    checks: [
      {
        id: "reference-identity",
        label: "Reference identity",
        state: "observed",
        detail: `${item.source === "history" ? "Renderer history" : "Gallery sample"} record has a stable local ID.`,
      },
      {
        id: "media-bytes",
        label: "Media bytes",
        state: "not-observed",
        detail: "No image, video, or audio bytes were loaded for this preview.",
      },
      {
        id: "provider-provenance",
        label: "Provider provenance",
        state: "not-observed",
        detail: "Provider response, model receipt, and endpoint acceptance are unavailable.",
      },
      {
        id: "native-artifact",
        label: "Native artifact",
        state: "planned",
        detail: "Native file, durable artifact record, and filesystem locator remain planned.",
      },
    ],
  };
}

export function serializeMediaAssetInspection(inspection: MediaAssetInspection): string {
  return JSON.stringify(inspection, null, 2);
}

export type MediaAssetInspectorProps = {
  readonly item: MediaAssetInspectorInput;
  readonly exportSelected: boolean;
  readonly onToggleExport: () => void;
};

/** Metadata-only inspector; it does not claim bytes, provider output, or a native artifact. */
export function MediaAssetInspector({ item, exportSelected, onToggleExport }: MediaAssetInspectorProps) {
  const inspection = useMemo(() => buildMediaAssetInspection(item), [item]);
  const payload = useMemo(() => serializeMediaAssetInspection(inspection), [inspection]);
  const observedChecks = inspection.checks.filter((check) => check.state === "observed").length;

  const copyPayload = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(payload);
    }
  };

  const downloadPayload = () => {
    if (typeof document === "undefined") return;
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${item.id}-media-inspection.preview.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="media-asset-inspector" aria-label="Media asset inspector">
      <header className="media-asset-inspector__header">
        <div>
          <span className="eyebrow"><ShieldAlert size={12} aria-hidden="true" /> Reference inspection</span>
          <h5>Provenance &amp; readiness</h5>
          <p>Metadata-only preview for this direction; no media bytes are loaded.</p>
        </div>
        <span className={`media-asset-inspector__readiness media-asset-inspector__readiness--${inspection.readiness}`}>
          {inspection.readiness === "review" ? "Review" : "Planned"}
        </span>
      </header>

      <div className="media-asset-inspector__metrics" aria-label="Inspection summary">
        <span><strong>{observedChecks}/{inspection.checks.length}</strong><small>checks observed</small></span>
        <span><strong>{inspection.referenceHash}</strong><small>preview fingerprint</small></span>
        <span><strong>0 B</strong><small>bytes included</small></span>
      </div>

      <ul className="media-asset-inspector__checks">
        {inspection.checks.map((check) => (
          <li key={check.id}>
            {check.state === "observed" ? <CheckCircle2 size={14} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
            <div><strong>{check.label}</strong><span>{check.detail}</span></div>
            <em>{check.state}</em>
          </li>
        ))}
      </ul>

      <div className="media-asset-inspector__actions">
        <button type="button" className="button button--ghost button--compact" onClick={onToggleExport} aria-pressed={exportSelected}>
          <FileJson2 size={13} aria-hidden="true" /> {exportSelected ? "Included in export" : "Include in export"}
        </button>
        <button type="button" className="button button--ghost button--compact" onClick={copyPayload}>
          <Clipboard size={13} aria-hidden="true" /> Copy receipt
        </button>
        <button type="button" className="button button--ghost button--compact" onClick={downloadPayload}>
          <Download size={13} aria-hidden="true" /> Download
        </button>
      </div>

      <p className="media-asset-inspector__boundary"><Info size={13} aria-hidden="true" /> Preview only · renderer-local · no provider result, native receipt, durable artifact, or filesystem read.</p>
    </section>
  );
}

function previewReferenceHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `preview-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export default MediaAssetInspector;
