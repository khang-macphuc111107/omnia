import { Check, Clipboard, Download, Fingerprint, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectOverviewView, ProjectView } from "./types";
import {
  changedProjectMetadataFields,
  type ProjectMetadataReceiptPreview,
  type ProjectMetadataReceiptField,
  type ProjectMetadataVector,
} from "./project-metadata-receipt-preview";

export type ProjectMetadataProvenanceSource = "native-record" | "renderer-session-preview";
export type ProjectMetadataProvenanceFreshness =
  | "native-current"
  | "draft-pending"
  | "renderer-session-only"
  | "native-not-observed";
export type ProjectMetadataProvenanceExportFormat = "json" | "markdown";

export interface ProjectMetadataProvenancePreview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly source: ProjectMetadataProvenanceSource;
  readonly freshness: ProjectMetadataProvenanceFreshness;
  readonly changedFields: readonly ProjectMetadataReceiptField[];
  readonly fieldLengths: Readonly<Record<ProjectMetadataReceiptField, number>>;
  readonly baselineDigest: string;
  readonly draftDigest: string;
  readonly nativeUpdatedAtMs: number | null;
  readonly overviewRevisionId: string | null;
  readonly projectTwinRevisionId: string | null;
  readonly sourceEventWatermark: number | null;
  /** This is a renderer observation ID, not a native mutation receipt. */
  readonly latestObservationId: string | null;
  readonly observedAt: string;
  readonly authoritative: false;
  readonly durable: false;
}

export const PROJECT_METADATA_PROVENANCE_PREVIEW_FORMAT =
  "omnia.project-metadata-provenance-preview.v1" as const;

export const PROJECT_METADATA_PROVENANCE_PREVIEW_BOUNDARY =
  "Renderer-local provenance projection only. Digests and cursors are review metadata. It does not prove a native mutation receipt, Project Twin revision, replay authority, or cross-restart persistence.";

const FIELD_ORDER: readonly ProjectMetadataReceiptField[] = ["name", "description", "instructions"];
const FIELD_LABELS: Record<ProjectMetadataReceiptField, string> = {
  name: "Project name",
  description: "Description",
  instructions: "Instructions",
};

const SOURCE_LABELS: Record<ProjectMetadataProvenanceSource, string> = {
  "native-record": "Native Project record",
  "renderer-session-preview": "Renderer session preview",
};

const FRESHNESS_LABELS: Record<ProjectMetadataProvenanceFreshness, string> = {
  "native-current": "Native cursor observed",
  "draft-pending": "Draft differs from baseline",
  "renderer-session-only": "Session-only projection",
  "native-not-observed": "Native cursor not observed",
};

function safeText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeCursor(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeId(value: string, fallback: string): string {
  return safeText(value, 160) || fallback;
}

/**
 * A compact deterministic digest for UI comparison. It is intentionally not
 * presented as a cryptographic hash or tamper-proof provenance primitive.
 */
export function previewDigest(vector: ProjectMetadataVector): string {
  const source = FIELD_ORDER.map((field) => `${field}:${vector[field].trim()}`).join("\u001f");
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-preview-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function freshnessFor({
  source,
  changedFields,
  nativeUpdatedAtMs,
}: {
  readonly source: ProjectMetadataProvenanceSource;
  readonly changedFields: readonly ProjectMetadataReceiptField[];
  readonly nativeUpdatedAtMs: number | null;
}): ProjectMetadataProvenanceFreshness {
  if (changedFields.length > 0) return "draft-pending";
  if (source === "native-record" && nativeUpdatedAtMs !== null) return "native-current";
  if (source === "renderer-session-preview") return "renderer-session-only";
  return "native-not-observed";
}

export function createProjectMetadataProvenancePreview({
  projectId,
  source,
  baseline,
  draft,
  nativeUpdatedAtMs,
  overview,
  latestObservationId,
  observedAt = new Date().toISOString(),
}: {
  readonly projectId: string;
  readonly source: ProjectMetadataProvenanceSource;
  readonly baseline: ProjectMetadataVector;
  readonly draft: ProjectMetadataVector;
  readonly nativeUpdatedAtMs?: number | null;
  readonly overview?: Pick<
    ProjectOverviewView,
    "overviewRevisionId" | "projectTwinRevisionId" | "sourceEventWatermark"
  > | null;
  readonly latestObservationId?: string | null;
  readonly observedAt?: string;
}): ProjectMetadataProvenancePreview {
  const normalizedProjectId = safeId(projectId, "unknown-project");
  const normalizedNativeCursor = safeCursor(nativeUpdatedAtMs);
  const changedFields = changedProjectMetadataFields(baseline, draft);
  const normalizedObservedAt = safeText(observedAt, 80) || new Date(0).toISOString();
  return {
    schemaVersion: 1,
    id: `project-metadata-provenance-preview:${normalizedProjectId}:${previewDigest(draft)}`,
    projectId: normalizedProjectId,
    source,
    freshness: freshnessFor({ source, changedFields, nativeUpdatedAtMs: normalizedNativeCursor }),
    changedFields,
    fieldLengths: {
      name: draft.name.length,
      description: draft.description.length,
      instructions: draft.instructions.length,
    },
    baselineDigest: previewDigest(baseline),
    draftDigest: previewDigest(draft),
    nativeUpdatedAtMs: normalizedNativeCursor,
    overviewRevisionId: overview?.overviewRevisionId ? safeText(overview.overviewRevisionId, 160) : null,
    projectTwinRevisionId: overview?.projectTwinRevisionId ? safeText(overview.projectTwinRevisionId, 160) : null,
    sourceEventWatermark: safeCursor(overview?.sourceEventWatermark),
    latestObservationId: latestObservationId ? safeText(latestObservationId, 220) : null,
    observedAt: normalizedObservedAt,
    authoritative: false,
    durable: false,
  };
}

function safeSnapshot(snapshot: ProjectMetadataProvenancePreview): ProjectMetadataProvenancePreview {
  return {
    ...snapshot,
    id: safeText(snapshot.id, 220),
    projectId: safeText(snapshot.projectId, 160),
    changedFields: snapshot.changedFields.filter((field) => FIELD_ORDER.includes(field)),
    fieldLengths: {
      name: Number.isSafeInteger(snapshot.fieldLengths.name) && snapshot.fieldLengths.name >= 0 ? snapshot.fieldLengths.name : 0,
      description: Number.isSafeInteger(snapshot.fieldLengths.description) && snapshot.fieldLengths.description >= 0 ? snapshot.fieldLengths.description : 0,
      instructions: Number.isSafeInteger(snapshot.fieldLengths.instructions) && snapshot.fieldLengths.instructions >= 0 ? snapshot.fieldLengths.instructions : 0,
    },
    baselineDigest: safeText(snapshot.baselineDigest, 80),
    draftDigest: safeText(snapshot.draftDigest, 80),
    nativeUpdatedAtMs: safeCursor(snapshot.nativeUpdatedAtMs),
    overviewRevisionId: snapshot.overviewRevisionId ? safeText(snapshot.overviewRevisionId, 160) : null,
    projectTwinRevisionId: snapshot.projectTwinRevisionId ? safeText(snapshot.projectTwinRevisionId, 160) : null,
    sourceEventWatermark: safeCursor(snapshot.sourceEventWatermark),
    latestObservationId: snapshot.latestObservationId ? safeText(snapshot.latestObservationId, 220) : null,
    observedAt: safeText(snapshot.observedAt, 80),
    authoritative: false,
    durable: false,
  };
}

function markdownValue(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function serializeProjectMetadataProvenancePreview(
  snapshot: ProjectMetadataProvenancePreview,
  format: ProjectMetadataProvenanceExportFormat,
): string {
  const safe = safeSnapshot(snapshot);
  if (format === "json") {
    return JSON.stringify(
      {
        format: PROJECT_METADATA_PROVENANCE_PREVIEW_FORMAT,
        version: 1,
        scope: "renderer-session",
        authoritative: false,
        durable: false,
        boundary: PROJECT_METADATA_PROVENANCE_PREVIEW_BOUNDARY,
        snapshot: safe,
      },
      null,
      2,
    );
  }

  return [
    "# Omnia Project metadata provenance preview",
    "",
    `> ${PROJECT_METADATA_PROVENANCE_PREVIEW_BOUNDARY}`,
    "",
    `- Project: ${markdownValue(safe.projectId)}`,
    `- Source: ${SOURCE_LABELS[safe.source]}`,
    `- Freshness: ${FRESHNESS_LABELS[safe.freshness]}`,
    `- Changed fields: ${safe.changedFields.length ? safe.changedFields.map((field) => FIELD_LABELS[field]).join(", ") : "None"}`,
    `- Baseline digest: ${markdownValue(safe.baselineDigest)}`,
    `- Draft digest: ${markdownValue(safe.draftDigest)}`,
    `- Native updatedAt cursor: ${safe.nativeUpdatedAtMs ?? "Not observed"}`,
    `- Overview revision: ${safe.overviewRevisionId ?? "Not hydrated"}`,
    `- Project Twin revision: ${safe.projectTwinRevisionId ?? "Not hydrated"}`,
    `- Source watermark: ${safe.sourceEventWatermark ?? "Not observed"}`,
    `- Latest observation: ${safe.latestObservationId ?? "None"}`,
    `- Observed: ${markdownValue(safe.observedAt)}`,
    "",
    "## Field coverage",
    "",
    ...FIELD_ORDER.map((field) => `- ${FIELD_LABELS[field]}: ${safe.fieldLengths[field]} characters${safe.changedFields.includes(field) ? " · changed" : " · unchanged"}`),
    "",
  ].join("\n");
}

export function downloadProjectMetadataProvenancePreview(
  payload: string,
  format: ProjectMetadataProvenanceExportFormat,
): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-project-metadata-provenance-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function projectMetadataProvenanceSourceLabel(source: ProjectMetadataProvenanceSource): string {
  return SOURCE_LABELS[source];
}

export function projectMetadataProvenanceFreshnessLabel(freshness: ProjectMetadataProvenanceFreshness): string {
  return FRESHNESS_LABELS[freshness];
}

export interface ProjectMetadataProvenancePreviewProps {
  readonly project: Pick<ProjectView, "id" | "name" | "overview" | "nativeUpdatedAtMs">;
  readonly source: ProjectMetadataProvenanceSource;
  readonly baseline: ProjectMetadataVector;
  readonly draft: ProjectMetadataVector;
  readonly latestObservation: ProjectMetadataReceiptPreview | null;
}

export function ProjectMetadataProvenancePreview({
  project,
  source,
  baseline,
  draft,
  latestObservation,
}: ProjectMetadataProvenancePreviewProps) {
  const [format, setFormat] = useState<ProjectMetadataProvenanceExportFormat>("json");
  const [status, setStatus] = useState("Provenance snapshot is renderer-local.");
  const snapshot = useMemo(
    () => createProjectMetadataProvenancePreview({
      projectId: project.id,
      source,
      baseline,
      draft,
      nativeUpdatedAtMs: project.nativeUpdatedAtMs ?? null,
      overview: project.overview ?? null,
      latestObservationId: latestObservation?.id ?? null,
    }),
    [baseline, draft, latestObservation?.id, project, source],
  );
  const payload = useMemo(
    () => serializeProjectMetadataProvenancePreview(snapshot, format),
    [format, snapshot],
  );
  const changedLabels = snapshot.changedFields.map((field) => FIELD_LABELS[field]);

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no provenance preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied renderer-local provenance preview.");
    } catch {
      setStatus("Clipboard access was denied; no provenance preview was copied.");
    }
  };

  const download = () => {
    setStatus(
      downloadProjectMetadataProvenancePreview(payload, format)
        ? "Browser download started; no durable provenance file was written."
        : "Browser download is unavailable; no provenance file was written.",
    );
  };

  return (
    <section
      className="project-metadata-provenance-preview"
      aria-labelledby={`project-metadata-provenance-preview-title-${project.id}`}
    >
      <header className="project-metadata-provenance-preview__header">
        <div>
          <span className="eyebrow"><Fingerprint size={13} /> Provenance snapshot</span>
          <h3 id={`project-metadata-provenance-preview-title-${project.id}`}>Project metadata provenance</h3>
          <p>Inspect the visible baseline, draft delta, and revision pointers before treating a metadata save as authoritative.</p>
        </div>
        <span className="project-metadata-provenance-preview__badge"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="project-metadata-provenance-preview__metrics" aria-label="Project metadata provenance summary">
        <span><strong>{projectMetadataProvenanceSourceLabel(snapshot.source)}</strong><small>Source</small></span>
        <span><strong>{projectMetadataProvenanceFreshnessLabel(snapshot.freshness)}</strong><small>Freshness</small></span>
        <span><strong>{snapshot.changedFields.length}</strong><small>Changed fields</small></span>
      </div>

      <dl className="project-metadata-provenance-preview__facts">
        <div><dt>Project</dt><dd>{project.name}</dd></div>
        <div><dt>Native updatedAt</dt><dd>{snapshot.nativeUpdatedAtMs ?? "Not observed"}</dd></div>
        <div><dt>Overview revision</dt><dd>{snapshot.overviewRevisionId ?? "Not hydrated"}</dd></div>
        <div><dt>Project Twin revision</dt><dd>{snapshot.projectTwinRevisionId ?? "Not hydrated"}</dd></div>
        <div><dt>Source watermark</dt><dd>{snapshot.sourceEventWatermark ?? "Not observed"}</dd></div>
        <div><dt>Latest observation</dt><dd>{snapshot.latestObservationId ?? "None"}</dd></div>
        <div><dt>Baseline digest</dt><dd>{snapshot.baselineDigest}</dd></div>
        <div><dt>Draft digest</dt><dd>{snapshot.draftDigest}</dd></div>
      </dl>

      <div className="project-metadata-provenance-preview__delta" role="status" aria-live="polite">
        <strong>Visible delta</strong>
        <span>{changedLabels.length > 0 ? changedLabels.join(" · ") : "No metadata fields differ from the baseline."}</span>
      </div>

      <div className="project-metadata-provenance-preview__toolbar" role="toolbar" aria-label="Project metadata provenance actions">
        <label>
          <span>Format</span>
          <select aria-label="Project metadata provenance export format" value={format} onChange={(event) => setFormat(event.target.value as ProjectMetadataProvenanceExportFormat)}>
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
          </select>
        </label>
        <span className="project-metadata-provenance-preview__status" role="status" aria-live="polite">{status}</span>
        <button type="button" className="button button--ghost" onClick={() => void copy()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" onClick={download}><Download size={13} /> Download</button>
      </div>

      <pre className="project-metadata-provenance-preview__payload" aria-label="Project metadata provenance export preview"><code>{payload}</code></pre>
      <p className="project-metadata-provenance-preview__boundary"><Check size={13} /> {PROJECT_METADATA_PROVENANCE_PREVIEW_BOUNDARY}</p>
    </section>
  );
}

export default ProjectMetadataProvenancePreview;
