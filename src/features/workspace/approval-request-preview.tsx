import {
  Check,
  ClipboardCheck,
  Copy,
  Download,
  LockKeyhole,
  Redo2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  APPROVAL_EXPIRY_LABELS,
  APPROVAL_NETWORK_LABELS,
  APPROVAL_OPERATION_LABELS,
  APPROVAL_REQUEST_BOUNDARY,
  APPROVAL_REQUEST_PRESETS,
  APPROVAL_SANDBOX_LABELS,
  APPROVAL_SCOPE_LABELS,
  APPROVAL_SECRETS_LABELS,
  APPROVAL_STATE_LABELS,
  DEFAULT_APPROVAL_REQUEST,
  approvalRequestEqual,
  approvalRequestReviewHint,
  approvalRequestRisk,
  approvalRequestValidation,
  serializeApprovalRequest,
  type ApprovalExpiry,
  type ApprovalNetwork,
  type ApprovalOperation,
  type ApprovalRequestDraft,
  type ApprovalSandbox,
  type ApprovalScope,
  type ApprovalSecrets,
} from "./approval-request-preview-contract";

function downloadText(filename: string, text: string, type: string): boolean {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const OPERATION_OPTIONS = Object.entries(APPROVAL_OPERATION_LABELS) as [ApprovalOperation, string][];
const SCOPE_OPTIONS = Object.entries(APPROVAL_SCOPE_LABELS) as [ApprovalScope, string][];
const EXPIRY_OPTIONS = Object.entries(APPROVAL_EXPIRY_LABELS) as [ApprovalExpiry, string][];
const SANDBOX_OPTIONS = Object.entries(APPROVAL_SANDBOX_LABELS) as [ApprovalSandbox, string][];
const NETWORK_OPTIONS = Object.entries(APPROVAL_NETWORK_LABELS) as [ApprovalNetwork, string][];
const SECRET_OPTIONS = Object.entries(APPROVAL_SECRETS_LABELS) as [ApprovalSecrets, string][];

function sameShape(left: ApprovalRequestDraft, right: ApprovalRequestDraft): boolean {
  return approvalRequestEqual({ ...left, state: "draft" }, { ...right, state: "draft" });
}

export function ApprovalRequestPreview({ projectId }: { readonly projectId?: string | null | undefined }) {
  const [draft, setDraft] = useState<ApprovalRequestDraft>(DEFAULT_APPROVAL_REQUEST);
  const [past, setPast] = useState<ApprovalRequestDraft[]>([]);
  const [future, setFuture] = useState<ApprovalRequestDraft[]>([]);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState(projectId
    ? "Project-scoped approval request draft ready. It stays in this renderer session."
    : "Approval request draft ready. It stays in this renderer session.");

  const risk = approvalRequestRisk(draft);
  const validation = useMemo(() => approvalRequestValidation(draft), [draft]);
  const serialized = useMemo(() => serializeApprovalRequest(draft, format), [draft, format]);
  const activePreset = useMemo(
    () => APPROVAL_REQUEST_PRESETS.find((preset) => sameShape({ ...preset.values, state: "draft" }, draft)),
    [draft],
  );

  const commit = (next: ApprovalRequestDraft, message: string) => {
    if (approvalRequestEqual(next, draft)) {
      setStatus("That approval request preview already matches the current draft.");
      return;
    }
    setPast((current) => [...current, draft].slice(-40));
    setDraft(next);
    setFuture([]);
    setStatus(message);
  };

  const patch = (changes: Partial<ApprovalRequestDraft>, message: string) => {
    commit({ ...draft, ...changes, state: "draft" }, message);
  };

  const applyPreset = (presetId: string) => {
    const preset = APPROVAL_REQUEST_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    commit({ ...preset.values, state: "draft" }, `${preset.label} loaded into the renderer approval rehearsal.`);
  };

  const markNeedsReview = () => {
    if (validation.length > 0) {
      commit({ ...draft, state: "needs-review" }, `Needs review: ${validation[0]}`);
      return;
    }
    commit({ ...draft, state: "needs-review" }, "Request marked for review. No native approval was issued.");
  };

  const stage = () => {
    if (validation.length > 0) {
      setStatus(`Cannot stage this preview yet: ${validation.join(" ")}`);
      return;
    }
    commit({ ...draft, state: "staged" }, "Request staged for a future native review. No approval receipt was created.");
  };

  const revoke = () => commit({ ...draft, state: "revoked" }, "Request revoked in the renderer preview. Native authority was not changed.");
  const restore = () => commit({ ...draft, state: "draft" }, "Request restored to a draft for editing.");

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((current) => current.slice(0, -1));
    setFuture((current) => [draft, ...current]);
    setDraft(previous);
    setStatus("Undid one approval request preview change.");
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((current) => current.slice(1));
    setPast((current) => [...current, draft].slice(-40));
    setDraft(next);
    setStatus("Redid one approval request preview change.");
  };

  const reset = () => commit(DEFAULT_APPROVAL_REQUEST, "Approval request preview reset to the safe inspect draft.");

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; the approval request remains visible and no durable export was created.");
      return;
    }
    try {
      await navigator.clipboard.writeText(serialized);
      setStatus(`${format.toUpperCase()} approval request preview copied. It remains renderer-local.`);
    } catch {
      setStatus("Clipboard write failed; no durable approval export was created.");
    }
  };

  const exportPreview = () => {
    const extension = format === "json" ? "json" : "md";
    const downloaded = downloadText(
      `omnia-approval-request${projectId ? `-${projectId}` : ""}.${extension}`,
      serialized,
      format === "json" ? "application/json" : "text/markdown",
    );
    setStatus(downloaded ? "Approval request preview download started; native authority is unchanged." : "Browser download is unavailable; the preview remains renderer-local.");
  };

  return (
    <section className="approval-request-preview" aria-labelledby="approval-request-preview-title">
      <header className="approval-request-preview__header">
        <span className="approval-request-preview__icon"><ClipboardCheck size={18} /></span>
        <div>
          <span className="eyebrow">{projectId ? "Project-scoped renderer rehearsal" : "Exact operation review"}</span>
          <h2 id="approval-request-preview-title">Approval Request Preview</h2>
          <p>Shape the exact operation, target, expiry, sandbox, network, and secret boundary before a future native broker can evaluate it.</p>
        </div>
        <span className="approval-request-preview__status"><ShieldCheck size={13} /> Renderer-local</span>
      </header>

      <div className="approval-request-preview__metrics" aria-label="Approval request summary">
        <article><strong>{APPROVAL_STATE_LABELS[draft.state]}</strong><span>Review state</span></article>
        <article><strong className={`is-${risk}`}>{risk}</strong><span>Risk signal</span></article>
        <article><strong>{validation.length}</strong><span>Validation notes</span></article>
        <article><strong>{past.length}/{future.length}</strong><span>Undo / redo</span></article>
      </div>

      <section className="approval-request-preview__presets" aria-labelledby="approval-request-presets-title">
        <div className="approval-request-preview__section-heading"><div><span className="eyebrow">Fast starting points</span><h3 id="approval-request-presets-title">Load a request shape</h3></div><ShieldAlert size={16} /></div>
        <div className="approval-request-preview__preset-grid" role="list" aria-label="Approval request presets">
          {APPROVAL_REQUEST_PRESETS.map((preset) => (
            <button type="button" key={preset.id} className={`approval-request-preset approval-request-preset--${preset.tone}${activePreset?.id === preset.id ? " is-selected" : ""}`} onClick={() => applyPreset(preset.id)} aria-pressed={activePreset?.id === preset.id} aria-label={`Load ${preset.label} approval request preset`}>
              <span><strong>{preset.label}</strong>{activePreset?.id === preset.id ? <Check size={13} /> : null}</span>
              <small>{preset.description}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="approval-request-preview__form" aria-labelledby="approval-request-form-title">
        <div className="approval-request-preview__section-heading"><div><span className="eyebrow">Exact request fields</span><h3 id="approval-request-form-title">What would need approval?</h3></div><LockKeyhole size={16} /></div>
        <div className="approval-request-preview__form-grid">
          <label><span>Operation</span><select aria-label="Approval request operation" value={draft.operation} onChange={(event) => patch({ operation: event.target.value as ApprovalOperation }, "Operation changed in the renderer approval preview.")}>{OPERATION_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span>Approval scope</span><select aria-label="Approval request scope" value={draft.scope} onChange={(event) => patch({ scope: event.target.value as ApprovalScope }, "Approval scope changed in the renderer preview.")}>{SCOPE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="approval-request-preview__wide"><span>Exact target</span><input aria-label="Approval request target" value={draft.target} onChange={(event) => patch({ target: event.target.value }, "Exact target changed in the renderer approval preview.")} placeholder="workspace://current-project/src" /></label>
          <label className="approval-request-preview__wide"><span>Rationale</span><textarea aria-label="Approval request rationale" value={draft.rationale} onChange={(event) => patch({ rationale: event.target.value }, "Approval rationale changed in the renderer preview.")} rows={2} placeholder="Why is this operation needed?" /></label>
          <label><span>Expiry</span><select aria-label="Approval request expiry" value={draft.expiry} onChange={(event) => patch({ expiry: event.target.value as ApprovalExpiry }, "Approval expiry changed in the renderer preview.")}>{EXPIRY_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {draft.expiry === "custom" ? <label><span>Custom expiry</span><input aria-label="Approval request custom expiry" type="datetime-local" value={draft.customExpiry} onChange={(event) => patch({ customExpiry: event.target.value }, "Custom expiry changed in the renderer preview.")} /></label> : null}
          <label><span>Sandbox</span><select aria-label="Approval request sandbox" value={draft.sandbox} onChange={(event) => patch({ sandbox: event.target.value as ApprovalSandbox }, "Sandbox boundary changed in the renderer preview.")}>{SANDBOX_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span>Network</span><select aria-label="Approval request network" value={draft.network} onChange={(event) => patch({ network: event.target.value as ApprovalNetwork }, "Network boundary changed in the renderer preview.")}>{NETWORK_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span>Secrets</span><select aria-label="Approval request secrets" value={draft.secrets} onChange={(event) => patch({ secrets: event.target.value as ApprovalSecrets }, "Secret handling changed in the renderer preview.")}>{SECRET_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </div>
        {validation.length > 0 ? <div className="approval-request-preview__validation" role="alert"><ShieldAlert size={14} /><div><strong>Review before staging</strong><ul>{validation.map((item) => <li key={item}>{item}</li>)}</ul></div></div> : null}
        <p className="approval-request-preview__hint"><ShieldCheck size={13} /> {approvalRequestReviewHint(draft)}</p>
      </section>

      <section className="approval-request-preview__lifecycle" aria-labelledby="approval-request-lifecycle-title">
        <div className="approval-request-preview__section-heading"><div><span className="eyebrow">Renderer rehearsal</span><h3 id="approval-request-lifecycle-title">Review lifecycle</h3></div><span className={`approval-request-preview__state approval-request-preview__state--${draft.state}`}>{APPROVAL_STATE_LABELS[draft.state]}</span></div>
        <div className="approval-request-preview__lifecycle-actions" role="toolbar" aria-label="Approval request lifecycle actions">
          <button type="button" className="button button--ghost" onClick={markNeedsReview} disabled={draft.state === "revoked"}><ShieldAlert size={13} /> Mark needs review</button>
          <button type="button" className="button button--secondary" onClick={stage} disabled={draft.state === "staged" || draft.state === "revoked"}><ClipboardCheck size={13} /> Stage for review</button>
          <button type="button" className="button button--ghost" onClick={revoke} disabled={draft.state === "revoked"}><X size={13} /> Revoke preview</button>
          <button type="button" className="button button--ghost" onClick={restore} disabled={draft.state !== "revoked"}><RotateCcw size={13} /> Restore draft</button>
        </div>
        <p className="approval-request-preview__boundary"><LockKeyhole size={13} /> Staged means “ready for a future native decision” only. It is not a grant, receipt, sandbox attestation, secret resolution, provider request, or execution.</p>
      </section>

      <div className="approval-request-preview__actions" role="toolbar" aria-label="Approval request preview controls">
        <button type="button" className="button button--ghost" onClick={undo} disabled={past.length === 0} aria-label="Undo approval request preview change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo approval request preview change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} disabled={approvalRequestEqual(draft, DEFAULT_APPROVAL_REQUEST)}><RotateCcw size={14} /> Reset</button>
        <span>{past.length} undo · {future.length} redo</span>
      </div>

      <section className="approval-request-preview__export" aria-labelledby="approval-request-export-title">
        <div className="approval-request-preview__section-heading"><div><span className="eyebrow">Portable rehearsal</span><h3 id="approval-request-export-title">Request package</h3></div><Download size={16} /></div>
        <p>Inspect or export the request shape without credentials, secret bytes, native receipts, or executable payloads.</p>
        <div className="approval-request-preview__export-actions">
          <label><span>Format</span><select aria-label="Approval request export format" value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <button type="button" className="button button--ghost" onClick={() => void copy()}><Copy size={13} /> Copy</button>
          <button type="button" className="button button--ghost" onClick={exportPreview}><Download size={13} /> Download</button>
        </div>
        <pre aria-label="Approval request preview export">{serialized}</pre>
      </section>

      <p className="approval-request-preview__boundary"><LockKeyhole size={14} /> {APPROVAL_REQUEST_BOUNDARY}</p>
      <p className="approval-request-preview__status-line" role="status" aria-live="polite"><span aria-hidden="true" /> {status}</p>
    </section>
  );
}

