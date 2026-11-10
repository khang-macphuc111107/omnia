import { Clipboard, Copy, GitBranch, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import type { ArtifactView } from "./types";
import {
  createArtifactAtomicHandoffPreview,
  evaluateArtifactAtomicHandoffPreflight,
  serializeArtifactAtomicHandoffPreview,
  type ArtifactAtomicTargetKind,
} from "./artifact-atomic-handoff-preview-contract";

export interface ArtifactAtomicHandoffPreviewProps {
  readonly artifact: ArtifactView;
  readonly revision: number;
}

function projectScopeFor(artifact: ArtifactView): string {
  return `project-${artifact.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "preview"}`;
}

function targetDefaultFor(artifact: ArtifactView, kind: ArtifactAtomicTargetKind): string {
  const stem = artifact.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "artifact";
  if (kind === "project-library") return `${projectScopeFor(artifact)}-library`;
  if (kind === "bridge-plan") return `bridge-${stem}`;
  return `chat-${stem}`;
}

export function ArtifactAtomicHandoffPreview({ artifact, revision }: ArtifactAtomicHandoffPreviewProps) {
  const [targetKind, setTargetKind] = useState<ArtifactAtomicTargetKind>("chat-message");
  const [projectId, setProjectId] = useState(() => projectScopeFor(artifact));
  const [targetId, setTargetId] = useState(() => targetDefaultFor(artifact, "chat-message"));
  const [conversationId, setConversationId] = useState("conversation-preview");
  const [branchId, setBranchId] = useState("branch-main");
  const [modelProfileRevisionId, setModelProfileRevisionId] = useState("");
  const [status, setStatus] = useState("No native bind receipt has been created.");

  const target = useMemo(() => ({
    kind: targetKind,
    projectId,
    targetId,
    conversationId,
    branchId,
    modelProfileRevisionId,
  }), [branchId, conversationId, modelProfileRevisionId, projectId, targetId, targetKind]);

  const operation = useMemo(() => createArtifactAtomicHandoffPreview({
    artifactId: artifact.id,
    revision,
    target,
  }), [artifact.id, revision, target]);
  const preflight = useMemo(() => evaluateArtifactAtomicHandoffPreflight(operation), [operation]);
  const payload = useMemo(() => serializeArtifactAtomicHandoffPreview(operation, preflight), [operation, preflight]);

  const changeTargetKind = (next: ArtifactAtomicTargetKind) => {
    setTargetKind(next);
    setTargetId(targetDefaultFor(artifact, next));
    if (next !== "bridge-plan") setModelProfileRevisionId("");
    setStatus("Updated the renderer-local destination; recheck the handoff before copying.");
  };

  const copyPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard access is unavailable; no handoff preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied the renderer-local atomic handoff preview.");
    } catch {
      setStatus("Clipboard access was denied; no handoff preview was copied.");
    }
  };

  return (
    <details className="artifact-atomic-handoff" aria-label="Atomic artifact handoff rehearsal">
      <summary className="artifact-atomic-handoff__summary">
        <span><GitBranch size={14} /> Atomic handoff rehearsal</span>
        <span className={`artifact-atomic-handoff__status artifact-atomic-handoff__status--${preflight.status}`}>
          {preflight.status === "ready" ? "Ready to stage" : preflight.status === "blocked" ? "Blocked" : "Review"}
        </span>
      </summary>
      <div className="artifact-atomic-handoff__body">
        <header className="artifact-atomic-handoff__header">
          <div>
            <span className="eyebrow">Exact source + destination</span>
            <h4>Freeze the artifact intent before a future native bind</h4>
            <p>One source revision, one explicit target, and one retry key. This is a renderer rehearsal only.</p>
          </div>
          <span className="artifact-atomic-handoff__boundary"><ShieldCheck size={13} /> Preview only</span>
        </header>

        <div className="artifact-atomic-handoff__source" aria-label="Frozen source artifact">
          <span><small>Source artifact</small><strong>{artifact.name}</strong></span>
          <span><small>Revision</small><strong>v{revision}</strong></span>
          <span><small>Exact set</small><strong>1 artifact</strong></span>
          <span><small>Operation</small><code>{operation.operationId}</code></span>
        </div>

        <div className="artifact-atomic-handoff__fields">
          <label>
            <span>Destination</span>
            <select aria-label="Artifact handoff destination" value={targetKind} onChange={(event) => changeTargetKind(event.target.value as ArtifactAtomicTargetKind)}>
              <option value="chat-message">Chat message</option>
              <option value="project-library">Project library</option>
              <option value="bridge-plan">Multimodal bridge plan</option>
            </select>
          </label>
          <label>
            <span>Project scope</span>
            <input aria-label="Artifact handoff project scope" value={projectId} onChange={(event) => setProjectId(event.target.value)} />
          </label>
          <label>
            <span>Destination ID</span>
            <input aria-label="Artifact handoff destination id" value={targetId} onChange={(event) => setTargetId(event.target.value)} />
          </label>
          {targetKind === "chat-message" ? (
            <>
              <label>
                <span>Conversation</span>
                <input aria-label="Artifact handoff conversation id" value={conversationId} onChange={(event) => setConversationId(event.target.value)} />
              </label>
              <label>
                <span>Branch</span>
                <input aria-label="Artifact handoff branch id" value={branchId} onChange={(event) => setBranchId(event.target.value)} />
              </label>
            </>
          ) : null}
          {targetKind === "bridge-plan" ? (
            <label>
              <span>Model profile revision</span>
              <input aria-label="Artifact handoff model profile revision" value={modelProfileRevisionId} onChange={(event) => setModelProfileRevisionId(event.target.value)} placeholder="profile-revision-…" />
            </label>
          ) : null}
        </div>

        <div className="artifact-atomic-handoff__key"><small>Retry identity</small><code>{operation.idempotencyKey}</code></div>

        <div className="artifact-atomic-handoff__checks" aria-label="Artifact handoff preflight checks">
          {preflight.checks.map((item) => (
            <div key={item.id} className={`artifact-atomic-handoff__check artifact-atomic-handoff__check--${item.state}`}>
              <span><strong>{item.label}</strong><small>{item.state}</small></span>
              <p>{item.detail}</p>
            </div>
          ))}
        </div>

        <div className="artifact-atomic-handoff__actions">
          <span className="artifact-atomic-handoff__live-status" role="status" aria-live="polite">{status}</span>
          <button type="button" className="button button--ghost" onClick={() => void copyPreview()}><Clipboard size={13} /> Copy JSON</button>
          <button
            type="button"
            className="button button--secondary"
            disabled={!preflight.canStagePreview}
            title={preflight.canStagePreview ? "Stage this renderer-local handoff preview" : preflight.blockingReason ?? "Resolve the blocked checks first"}
            onClick={() => setStatus("Staged the renderer-local handoff intent; native binding remains unavailable.")}
          >
            <Copy size={13} /> Stage preview
          </button>
        </div>
        <p className="artifact-atomic-handoff__boundary-copy">{preflight.boundary}</p>
      </div>
    </details>
  );
}

export default ArtifactAtomicHandoffPreview;

