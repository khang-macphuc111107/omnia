import {
  CircleDashed,
  Clipboard,
  FileJson2,
  Layers3,
  LockKeyhole,
  RotateCcw,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { MemoryView, ProjectView, SkillView } from "./types";

export type ContextReceiptComponentKind = "memory" | "skill";
export type ContextReceiptComponentState = "candidate" | "not-observed";
export type ContextReceiptProvenanceState = "renderer-candidate" | "not-observed";

export interface ContextReceiptProvenance {
  /** Stable renderer reference for the candidate source. */
  readonly sourceId: string;
  /** Derived preview version; this is not a native revision or package hash. */
  readonly sourceVersionId: string;
  readonly sourceLabel: string;
  readonly state: ContextReceiptProvenanceState;
}

export interface ContextReceiptComponentRow {
  readonly id: string;
  readonly kind: ContextReceiptComponentKind;
  readonly label: string;
  readonly detail: string;
  readonly metadata: string;
  readonly state: ContextReceiptComponentState;
  readonly provenance: ContextReceiptProvenance;
}

export interface ContextMemorySkillReceiptModel {
  readonly messageId: string | null;
  readonly runId: string | null;
  readonly contextRevisionId: string | null;
  readonly rows: readonly ContextReceiptComponentRow[];
  readonly memoryCount: number;
  readonly skillCount: number;
  readonly scopeLabel: string;
  readonly boundary: string;
}

export type ContextRerunExclusionReason = "not-needed" | "sensitive" | "out-of-scope" | "other";
export type ContextRerunSurface = "context" | "run";

export interface ContextRerunPreview {
  readonly schema: "omnia.context-rerun.preview.v1";
  readonly state: "draft-only";
  readonly sourceRunId: string | null;
  readonly sourceContextRevisionId: string | null;
  readonly candidateSnapshot: "current-renderer-projection";
  readonly includedCandidateIds: readonly string[];
  readonly candidateRefs: readonly {
    readonly id: string;
    readonly kind: ContextReceiptComponentKind;
    readonly sourceId: string;
    readonly sourceVersionId: string;
    readonly provenanceState: ContextReceiptProvenanceState;
  }[];
  readonly excludedCandidates: readonly {
    readonly id: string;
    readonly kind: ContextReceiptComponentKind;
    readonly reason: ContextRerunExclusionReason;
  }[];
  readonly effects: {
    readonly queued: false;
    readonly providerDispatch: false;
    readonly nativeContextFreeze: false;
    readonly durableWrite: false;
  };
  readonly note: string;
}

const EXCLUSION_REASON_LABELS: Record<ContextRerunExclusionReason, string> = {
  "not-needed": "Not needed",
  sensitive: "Sensitive",
  "out-of-scope": "Out of scope",
  other: "Other",
};

export function buildContextRerunPreview(
  model: ContextMemorySkillReceiptModel,
  sourceRunId: string | null,
  exclusions: Readonly<Record<string, ContextRerunExclusionReason>>,
): ContextRerunPreview {
  const excludedCandidates = model.rows
    .filter((row) => exclusions[row.id] !== undefined)
    .map((row) => ({ id: row.id, kind: row.kind, reason: exclusions[row.id]! }));
  const excludedIds = new Set(excludedCandidates.map((item) => item.id));
  return {
    schema: "omnia.context-rerun.preview.v1",
    state: "draft-only",
    sourceRunId,
    sourceContextRevisionId: model.contextRevisionId,
    candidateSnapshot: "current-renderer-projection",
    includedCandidateIds: model.rows.filter((row) => !excludedIds.has(row.id)).map((row) => row.id),
    candidateRefs: model.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      sourceId: row.provenance.sourceId,
      sourceVersionId: row.provenance.sourceVersionId,
      provenanceState: row.provenance.state,
    })),
    excludedCandidates,
    effects: {
      queued: false,
      providerDispatch: false,
      nativeContextFreeze: false,
      durableWrite: false,
    },
    note: "The exact source-run context was not hydrated. This draft only filters currently visible renderer candidates and does not rerun the model.",
  };
}

function projectMemoryMatches(memory: MemoryView, project: ProjectView | undefined): boolean {
  if (memory.status !== "active") return false;
  if (memory.scopeLabel === "Global") return true;
  return project ? memory.scopeLabel.toLowerCase().includes(project.name.toLowerCase()) : false;
}

function projectSkillMatches(skill: SkillView, project: ProjectView | undefined): boolean {
  if (!skill.enabled || skill.scope === "Manual") return false;
  return skill.scope === "Global" || project !== undefined;
}

function memoryRow(memory: MemoryView): ContextReceiptComponentRow {
  const title = memory.title?.trim() || memory.content;
  const confidence = memory.confidence === null ? "explicit" : `${Math.round(memory.confidence * 100)}% confidence`;
  return {
    id: `memory:${memory.id}`,
    kind: "memory",
    label: title,
    detail: `Memory · ${memory.scopeLabel} · ${memory.sourceLabel}`,
    metadata: `${memory.kind} · ${memory.origin} · ${confidence}`,
    state: "candidate",
    provenance: {
      sourceId: memory.id,
      sourceVersionId: `memory:${memory.id}:renderer-preview`,
      sourceLabel: memory.sourceLabel,
      state: "not-observed",
    },
  };
}

function skillRow(skill: SkillView): ContextReceiptComponentRow {
  return {
    id: `skill:${skill.id}`,
    kind: "skill",
    label: skill.name,
    detail: `Skill · ${skill.scope} · v${skill.version}`,
    metadata: `${skill.source} · ${skill.trust} · ${skill.permissions.length} permission${skill.permissions.length === 1 ? "" : "s"}`,
    state: "candidate",
    provenance: {
      sourceId: skill.id,
      sourceVersionId: `skill:${skill.id}:v${skill.version}:renderer-preview`,
      sourceLabel: `${skill.source} · v${skill.version}`,
      state: "not-observed",
    },
  };
}

export function buildContextMemorySkillReceiptModel({
  project,
  memories,
  skills,
  messageId,
  runId,
  contextRevisionId,
}: {
  readonly project?: ProjectView | undefined;
  readonly memories: readonly MemoryView[];
  readonly skills: readonly SkillView[];
  readonly messageId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly contextRevisionId?: string | null | undefined;
}): ContextMemorySkillReceiptModel {
  const memoryRows = memories.filter((memory) => projectMemoryMatches(memory, project)).map(memoryRow);
  const skillRows = skills.filter((skill) => projectSkillMatches(skill, project)).map(skillRow);
  const rows = [...memoryRows, ...skillRows];
  const scopeLabel = runId
    ? `Run ${runId}`
    : messageId
      ? `Answer ${messageId}`
      : project
        ? `Project ${project.name}`
        : "Standalone Inbox";

  return {
    messageId: messageId ?? null,
    runId: runId ?? null,
    contextRevisionId: contextRevisionId ?? null,
    rows,
    memoryCount: memoryRows.length,
    skillCount: skillRows.length,
    scopeLabel,
    boundary: rows.length > 0
      ? "Candidate projection only. These records are not proof that memory or skills were selected, injected, persisted, or applied to a provider request."
      : "No active memory or enabled Global/Project skill candidates are visible for this scope; absence is not proof that a native context snapshot was empty.",
  };
}

function componentIcon(kind: ContextReceiptComponentKind) {
  return kind === "memory" ? <Layers3 size={13} /> : <Wrench size={13} />;
}

function stateLabel(state: ContextReceiptComponentState): string {
  return state === "candidate" ? "Candidate" : "Not observed";
}

export function ContextMemorySkillReceipt({
  project,
  memories,
  skills,
  messageId,
  runId,
  contextRevisionId,
  surface = "context",
}: {
  readonly project?: ProjectView | undefined;
  readonly memories: readonly MemoryView[];
  readonly skills: readonly SkillView[];
  readonly messageId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly contextRevisionId?: string | null | undefined;
  readonly surface?: ContextRerunSurface;
}) {
  const model = buildContextMemorySkillReceiptModel({
    project,
    memories,
    skills,
    messageId,
    runId,
    contextRevisionId,
  });
  const scopeKey = runId?.trim() || messageId?.trim() || "unlinked-run";
  const [exclusionsByScope, setExclusionsByScope] = useState<Record<string, Record<string, ContextRerunExclusionReason>>>({});
  const [rerunPreparedByScope, setRerunPreparedByScope] = useState<Record<string, boolean>>({});
  const exclusions = exclusionsByScope[scopeKey] ?? {};
  const rerunPreview = useMemo(() => buildContextRerunPreview(model, runId ?? null, exclusions), [exclusions, model, runId]);
  const rerunPreviewPayload = useMemo(() => JSON.stringify(rerunPreview, null, 2), [rerunPreview]);

  const setExclusion = (rowId: string, reason: ContextRerunExclusionReason | null) => {
    setExclusionsByScope((current) => {
      const nextForScope = { ...(current[scopeKey] ?? {}) };
      if (reason === null) delete nextForScope[rowId];
      else nextForScope[rowId] = reason;
      return { ...current, [scopeKey]: nextForScope };
    });
    setRerunPreparedByScope((current) => ({ ...current, [scopeKey]: false }));
  };

  const prepareRerunPreview = () => {
    setRerunPreparedByScope((current) => ({ ...current, [scopeKey]: true }));
  };

  const copyRerunPreview = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(rerunPreviewPayload);
    } catch {
      // Clipboard permissions vary by browser; the visible payload remains available below.
    }
  };

  return (
    <section className="inspector-section context-memory-skill-receipt" data-testid="context-memory-skill-receipt">
      <header>
        <div>
          <span className="inspector-section__icon inspector-section__icon--green"><FileJson2 size={15} /></span>
          <span>
            <strong>{surface === "run" ? "Memory & skills rerun preview" : "Memory & skills receipt"}</strong>
            <small>{model.scopeLabel} · renderer candidate projection</small>
          </span>
        </div>
        <span className="context-memory-skill-receipt__scope">Preview</span>
      </header>

      <div className="context-memory-skill-receipt__summary" role="status" aria-label="Memory and skills candidate summary">
        <span><strong>{model.memoryCount}</strong> memory</span>
        <span><strong>{model.skillCount}</strong> skill</span>
        <span><strong>{model.rows.length}</strong> total</span>
      </div>

      {model.rows.length > 0 ? (
        <div className="context-memory-skill-receipt__rows" role="list" aria-label="Context component candidates">
          {model.rows.map((row) => (
            <article key={row.id} className={`context-memory-skill-receipt__row context-memory-skill-receipt__row--${row.kind}`} role="listitem">
              <span className="context-memory-skill-receipt__icon" aria-hidden="true">{componentIcon(row.kind)}</span>
              <span className="context-memory-skill-receipt__copy">
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
                <em>{row.metadata}</em>
                <code className="context-memory-skill-receipt__provenance" title="Renderer-derived candidate reference">
                  {row.provenance.sourceVersionId} · {row.provenance.state === "not-observed" ? "Not observed" : "Renderer candidate"}
                </code>
              </span>
              {surface === "run" ? (
                <label className="context-memory-skill-receipt__exclude">
                  <input
                    type="checkbox"
                    checked={exclusions[row.id] !== undefined}
                    disabled={!runId}
                    aria-label={`Exclude ${row.label} from rerun preview`}
                    onChange={(event) => setExclusion(row.id, event.target.checked ? "not-needed" : null)}
                  />
                  <span>{exclusions[row.id] === undefined ? "Include" : "Excluded"}</span>
                </label>
              ) : (
                <span className="context-memory-skill-receipt__state">{stateLabel(row.state)}</span>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="context-memory-skill-receipt__empty">
          <Sparkles size={15} />
          <span>No active memory or enabled Global/Project skill candidates are visible.</span>
        </div>
      )}

      <p className="context-memory-skill-receipt__revision">
        <LockKeyhole size={13} />
        <span>Context revision: <code>{model.contextRevisionId ?? "Not frozen"}</code></span>
      </p>
      {surface === "run" ? (
        <section className="context-memory-skill-receipt__rerun" aria-label="Rerun context preview">
          <div className="context-memory-skill-receipt__rerun-heading">
            <span><strong>Prepare a rerun draft</strong><small>{Object.keys(exclusions).length} candidate exclusions · no exact frozen context</small></span>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setExclusionsByScope((current) => ({ ...current, [scopeKey]: {} }));
                setRerunPreparedByScope((current) => ({ ...current, [scopeKey]: false }));
              }}
              disabled={Object.keys(exclusions).length === 0}
            >
              <RotateCcw size={13} /> Clear
            </button>
          </div>
          {Object.entries(exclusions).map(([rowId, reason]) => {
            const row = model.rows.find((candidate) => candidate.id === rowId);
            if (!row) return null;
            return (
              <label className="context-memory-skill-receipt__reason" key={rowId}>
                <span>{row.label}</span>
                <select aria-label={`Exclusion reason for ${row.label}`} value={reason} onChange={(event) => setExclusion(rowId, event.target.value as ContextRerunExclusionReason)}>
                  {Object.entries(EXCLUSION_REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            );
          })}
          <div className="context-memory-skill-receipt__rerun-actions">
            <button type="button" className="button button--secondary" onClick={prepareRerunPreview} disabled={!runId}>
              <FileJson2 size={14} /> Prepare rerun preview
            </button>
            {!runId ? <small>Run ID unavailable; rerun preview is disabled.</small> : null}
          </div>
          {rerunPreparedByScope[scopeKey] ? (
            <div className="context-memory-skill-receipt__rerun-result" role="status" aria-live="polite">
              <header><strong>Draft preview only · not queued</strong><button type="button" className="button button--ghost" onClick={() => void copyRerunPreview()}><Clipboard size={13} /> Copy JSON</button></header>
              <pre tabIndex={0}><code>{rerunPreviewPayload}</code></pre>
            </div>
          ) : null}
          <p className="context-memory-skill-receipt__rerun-boundary">Exclusion affects only this renderer-session draft. It cannot alter an existing answer, prove what the source run used, queue a new run, freeze context, or dispatch to a provider.</p>
        </section>
      ) : null}
      <p className="context-memory-skill-receipt__boundary"><CircleDashed size={13} /><span>{model.boundary}</span></p>
    </section>
  );
}

export default ContextMemorySkillReceipt;
