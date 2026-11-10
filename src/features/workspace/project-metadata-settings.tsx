import { AlertTriangle, Check, RefreshCw, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  desktop,
  isDesktopRuntime,
  type AppRuntimeInfo,
  type NativeCommandError,
} from "@/lib/desktop";

import type { ProjectView } from "./types";
import { useWorkspaceStore } from "./store";
import ProjectMetadataReceiptPreview from "./project-metadata-receipt-preview";
import {
  changedProjectMetadataFields,
  createProjectMetadataReceiptPreview,
  type ProjectMetadataReceiptOutcome,
} from "./project-metadata-receipt-preview";
import ProjectMetadataProvenancePreview from "./project-metadata-provenance-preview";

type ProjectMetadataDraft = Pick<ProjectView, "name" | "description" | "instructions">;

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_INSTRUCTIONS_LENGTH = 20_000;
const MAX_RECEIPT_PREVIEW_ENTRIES = 12;

function draftFromProject(project: ProjectView): ProjectMetadataDraft {
  return {
    name: project.name,
    description: project.description,
    instructions: project.instructions,
  };
}

function trimDraft(draft: ProjectMetadataDraft): ProjectMetadataDraft {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
  };
}

function sameDraft(left: ProjectMetadataDraft, right: ProjectMetadataDraft): boolean {
  return left.name === right.name && left.description === right.description && left.instructions === right.instructions;
}

function metadataFingerprint(draft: ProjectMetadataDraft, nativeUpdatedAtMs: number | null): string {
  return [draft.name, draft.description, draft.instructions, nativeUpdatedAtMs ?? "none"].join("\u001f");
}

function commandErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<NativeCommandError>;
  return typeof candidate.code === "string" ? candidate.code : null;
}

/**
 * Project metadata editor. The browser path is intentionally a session-only
 * preview; the desktop path uses the native optimistic-concurrency cursor and
 * applies the returned record only after the native command succeeds.
 */
export function ProjectMetadataSettings({
  project,
  runtime,
}: {
  readonly project: ProjectView;
  readonly runtime: AppRuntimeInfo;
}) {
  const patchProjectMetadata = useWorkspaceStore((state) => state.patchProjectMetadata);
  const [draft, setDraft] = useState<ProjectMetadataDraft>(() => draftFromProject(project));
  const [editingBaseline, setEditingBaseline] = useState<ProjectMetadataDraft>(() => draftFromProject(project));
  const [editingBaselineCursor, setEditingBaselineCursor] = useState<number | null>(() => project.nativeUpdatedAtMs ?? null);
  const [driftAcknowledgedFor, setDriftAcknowledgedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("No metadata changes staged.");
  const [error, setError] = useState<string | null>(null);
  const [receiptSequence, setReceiptSequence] = useState(0);
  const [receipts, setReceipts] = useState<ReturnType<typeof createProjectMetadataReceiptPreview>[]>([]);

  useEffect(() => {
    const nextBaseline = draftFromProject(project);
    setDraft(nextBaseline);
    setEditingBaseline(nextBaseline);
    setEditingBaselineCursor(project.nativeUpdatedAtMs ?? null);
    setDriftAcknowledgedFor(null);
    setStatus("No metadata changes staged.");
    setError(null);
    setReceiptSequence(0);
    setReceipts([]);
  }, [project.id]);

  const normalizedDraft = useMemo(() => trimDraft(draft), [draft]);
  const currentProjectMetadata = useMemo(() => trimDraft(draftFromProject(project)), [project]);
  const baseline = useMemo(() => trimDraft(editingBaseline), [editingBaseline]);
  const currentProjectFingerprint = useMemo(
    () => metadataFingerprint(currentProjectMetadata, project.nativeUpdatedAtMs ?? null),
    [currentProjectMetadata, project.nativeUpdatedAtMs],
  );
  const metadataDrifted = !sameDraft(baseline, currentProjectMetadata) ||
    editingBaselineCursor !== (project.nativeUpdatedAtMs ?? null);
  const unacknowledgedDrift = metadataDrifted && driftAcknowledgedFor !== currentProjectFingerprint;
  const dirty = !sameDraft(normalizedDraft, baseline);
  const nativeRuntime = runtime.tauri && isDesktopRuntime();
  const valid = normalizedDraft.name.length > 0 &&
    normalizedDraft.name.length <= MAX_NAME_LENGTH &&
    normalizedDraft.description.length <= MAX_DESCRIPTION_LENGTH &&
    normalizedDraft.instructions.length <= MAX_INSTRUCTIONS_LENGTH;

  const update = (field: keyof ProjectMetadataDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
    setStatus("Unsaved project metadata changes.");
  };

  const reset = () => {
    setDraft(currentProjectMetadata);
    setEditingBaseline(currentProjectMetadata);
    setEditingBaselineCursor(project.nativeUpdatedAtMs ?? null);
    setDriftAcknowledgedFor(null);
    setError(null);
    setStatus("Draft reset to the latest visible project metadata.");
  };

  const useLatestProjectValues = () => {
    setDraft(currentProjectMetadata);
    setEditingBaseline(currentProjectMetadata);
    setEditingBaselineCursor(project.nativeUpdatedAtMs ?? null);
    setDriftAcknowledgedFor(null);
    setError(null);
    setStatus("Draft replaced with the latest visible Project metadata.");
  };

  const keepDraftAfterDrift = () => {
    setDriftAcknowledgedFor(currentProjectFingerprint);
    setStatus("Keeping this draft; saving it may overwrite newer Project metadata.");
  };

  const recordObservation = (
    outcome: ProjectMetadataReceiptOutcome,
    after: ProjectMetadataDraft,
    detail: string,
    observedUpdatedAtMs?: number | null,
  ) => {
    const nextSequence = receiptSequence + 1;
    setReceiptSequence(nextSequence);
    const observation = createProjectMetadataReceiptPreview({
      projectId: project.id,
      mode: nativeRuntime ? "native-command" : "browser-preview",
      outcome,
      before: trimDraft(baseline),
      after,
      expectedUpdatedAtMs: nativeRuntime ? project.nativeUpdatedAtMs ?? 0 : null,
      observedUpdatedAtMs: observedUpdatedAtMs ?? null,
      detail,
      sequence: nextSequence,
    });
    setReceipts((current) => [observation, ...current].slice(0, MAX_RECEIPT_PREVIEW_ENTRIES));
  };

  const save = async () => {
    const next = trimDraft(draft);
    if (!next.name) {
      setError("Project name is required.");
      setStatus("Nothing was saved.");
      recordObservation("blocked", next, "Save was blocked because the Project name is required.");
      return;
    }
    if (!valid) {
      setError("Keep the project name, description, and instructions within their visible limits.");
      setStatus("Nothing was saved.");
      recordObservation("blocked", next, "Save was blocked because one or more metadata fields exceeded their visible limits.");
      return;
    }
    if (!dirty) {
      setStatus("No changes to save.");
      recordObservation("no-op", next, "Save was requested with no metadata changes in the current draft.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (!nativeRuntime) {
        patchProjectMetadata(project.id, next);
        setDraft(next);
        setEditingBaseline(next);
        setEditingBaselineCursor(project.nativeUpdatedAtMs ?? null);
        setDriftAcknowledgedFor(null);
        setStatus("Saved renderer-local preview metadata. No durable native write occurred.");
        recordObservation("applied", next, "Renderer-local metadata preview applied. No durable native write occurred.");
        return;
      }

      const record = await desktop.updateProjectMetadata({
        projectId: project.id,
        name: next.name,
        description: next.description,
        instructions: next.instructions,
        expectedUpdatedAtMs: project.nativeUpdatedAtMs ?? 0,
      });
      patchProjectMetadata(project.id, {
        name: record.name,
        description: record.description ?? "",
        instructions: record.instructions ?? "",
      }, record.updatedAtMs);
      setDraft({
        name: record.name,
        description: record.description ?? "",
        instructions: record.instructions ?? "",
      });
      setEditingBaseline({
        name: record.name,
        description: record.description ?? "",
        instructions: record.instructions ?? "",
      });
      setEditingBaselineCursor(record.updatedAtMs);
      setDriftAcknowledgedFor(null);
      setStatus("Saved to native project metadata.");
      recordObservation("applied", {
        name: record.name,
        description: record.description ?? "",
        instructions: record.instructions ?? "",
      }, "Native project_update returned a Project record. This UI records the acknowledgement but not a durable mutation receipt.", record.updatedAtMs);
    } catch (caught) {
      const code = commandErrorCode(caught);
      if (code === "project_conflict") {
        setError("This Project changed elsewhere. Refresh the workspace before saving again.");
        setStatus("Save blocked by optimistic concurrency.");
        recordObservation("blocked", next, "Native project_update was blocked by optimistic concurrency; no visible Project overwrite occurred.");
      } else {
        setError("The native Project update failed; your draft is still available to retry.");
        setStatus("Save failed without changing the visible Project.");
        recordObservation("failed", next, "Native project_update failed; the draft remains available and the visible Project was not changed.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section project-metadata-settings" aria-labelledby="project-metadata-settings-title">
      <header>
        <div>
          <span className="eyebrow">Project configuration</span>
          <h2 id="project-metadata-settings-title">Project metadata</h2>
          <p>{nativeRuntime ? "Edit the native Project record with an optimistic concurrency guard." : "Shape the metadata in this browser preview before native persistence is connected."}</p>
        </div>
        <span className={nativeRuntime ? "settings-preview-chip settings-preview-chip--native" : "settings-preview-chip"}>
          {nativeRuntime ? "Native write" : "Preview only"}
        </span>
      </header>

      <div className="project-metadata-settings__fields">
        <label>
          <span>Project name <small>Required</small></span>
          <input
            value={draft.name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => update("name", event.target.value)}
            aria-label="Project name"
            placeholder="e.g. Omnia Desktop"
          />
          <small className="project-metadata-settings__counter">{draft.name.length}/{MAX_NAME_LENGTH}</small>
        </label>
        <label>
          <span>Short description <small>Optional</small></span>
          <input
            value={draft.description}
            maxLength={MAX_DESCRIPTION_LENGTH}
            onChange={(event) => update("description", event.target.value)}
            aria-label="Project description"
            placeholder="What belongs in this Project?"
          />
          <small className="project-metadata-settings__counter">{draft.description.length}/{MAX_DESCRIPTION_LENGTH}</small>
        </label>
        <label className="project-metadata-settings__wide-field">
          <span>Instructions <small>Optional project-scoped guidance</small></span>
          <textarea
            value={draft.instructions}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            onChange={(event) => update("instructions", event.target.value)}
            aria-label="Project instructions"
            rows={6}
            placeholder="How should Omnia approach work in this Project?"
          />
          <small className="project-metadata-settings__counter">{draft.instructions.length}/{MAX_INSTRUCTIONS_LENGTH}</small>
        </label>
      </div>

      <div className="project-metadata-settings__footer">
        <div className={`project-metadata-settings__status${error ? " project-metadata-settings__status--error" : ""}`} role="status" aria-live="polite">
          {error ? <AlertTriangle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          <span>{error ?? status}</span>
        </div>
        <div className="settings-action-row hit-target-control">
          <button type="button" className="button button--ghost" onClick={reset} disabled={saving || !dirty}>
            <RotateCcw size={14} /> Reset draft
          </button>
          <button type="button" className="button button--primary" onClick={() => void save()} disabled={saving || !dirty || !valid}>
            <Save size={14} /> {saving ? "Saving…" : nativeRuntime ? "Save metadata" : "Apply preview"}
          </button>
        </div>
      </div>
      {unacknowledgedDrift ? (
        <div className="project-metadata-settings__drift" role="alert">
          <div className="project-metadata-settings__drift-copy">
            <RefreshCw size={15} aria-hidden="true" />
            <span>
              <strong>Project metadata changed while this draft was open.</strong>
              <small>
                Review the latest visible values before saving. Changed fields: {changedProjectMetadataFields(baseline, currentProjectMetadata).join(", ") || "cursor only"}.
              </small>
            </span>
          </div>
          <div className="project-metadata-settings__drift-actions">
            <button type="button" className="button button--ghost" onClick={useLatestProjectValues} disabled={saving}>
              <RefreshCw size={13} /> Use latest values
            </button>
            <button type="button" className="button button--secondary" onClick={keepDraftAfterDrift} disabled={saving}>
              Keep my draft
            </button>
          </div>
        </div>
      ) : null}
      <p className="project-metadata-settings__boundary">
        {nativeRuntime
          ? "Native save returns a new updatedAt cursor. A conflict never overwrites the newer Project record."
          : "Preview edits update only the current renderer session; they do not write SQLite, provider settings, permissions, or files."}
      </p>
      <ProjectMetadataProvenancePreview
        project={project}
        source={nativeRuntime ? "native-record" : "renderer-session-preview"}
        baseline={trimDraft(baseline)}
        draft={normalizedDraft}
        latestObservation={receipts[0] ?? null}
      />
      <ProjectMetadataReceiptPreview
        projectId={project.id}
        receipts={receipts}
        onClear={() => {
          setReceipts([]);
          setReceiptSequence(0);
          setStatus("Save observation history cleared for this renderer session.");
        }}
      />
    </section>
  );
}

export default ProjectMetadataSettings;
