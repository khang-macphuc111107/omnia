import {
  Ban,
  Check,
  Clock3,
  Copy,
  Download,
  FileClock,
  Gauge,
  LockKeyhole,
  Redo2,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  PERMISSION_PRESETS,
  PERMISSION_SCOPE_LABELS,
  type PermissionPreset,
  type PermissionScope,
} from "./session-permission-contract";
import {
  DEFAULT_PERMISSION_PRESET_LAB_DRAFT,
  PERMISSION_PRESET_AUDIT_OPTIONS,
  PERMISSION_PRESET_EXPIRY_OPTIONS,
  PERMISSION_PRESET_LAB_BOUNDARY,
  PERMISSION_PRESET_QUOTA_OPTIONS,
  PERMISSION_PRESET_REVOKE_OPTIONS,
  normalizePermissionPresetLabDraft,
  parsePermissionPresetLab,
  permissionPresetAuditLabel,
  permissionPresetDraftEqual,
  permissionPresetExpiryLabel,
  permissionPresetLabDiff,
  permissionPresetForDraft,
  permissionPresetQuotaLabel,
  permissionPresetRevokeLabel,
  permissionPresetScopeLabel,
  serializePermissionPresetLab,
  type PermissionPresetAudit,
  type PermissionPresetExpiry,
  type PermissionPresetLabDraft,
  type PermissionPresetQuota,
  type PermissionPresetRevoke,
} from "./permission-preset-lab-contract";

function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The preset lifecycle file could not be read."));
    reader.readAsText(file);
  });
}

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

const expiryLabels: Record<PermissionPresetExpiry, string> = {
  session: "Current session",
  "one-hour": "1 hour",
  "one-day": "24 hours",
  custom: "Custom end time",
  "until-revoked": "Until revoked",
};

const quotaLabels: Record<PermissionPresetQuota, string> = {
  unlimited: "No quota",
  "per-run": "One run",
  daily: "Daily quota",
  custom: "Custom quota",
};

const auditLabels: Record<PermissionPresetAudit, string> = {
  minimal: "Minimal",
  standard: "Standard",
  verbose: "Verbose",
};

const revokeLabels: Record<PermissionPresetRevoke, string> = {
  manual: "Manual revoke",
  "after-run": "After one run",
  "on-expiry": "When expiry is reached",
  "on-error": "On policy error",
};

function updateDraftState(draft: PermissionPresetLabDraft, patch: Partial<PermissionPresetLabDraft>): PermissionPresetLabDraft {
  return normalizePermissionPresetLabDraft({ ...draft, ...patch, state: patch.state ?? "draft" });
}

export function PermissionPresetLab({ projectId }: { readonly projectId?: string | null | undefined }) {
  const [draft, setDraft] = useState<PermissionPresetLabDraft>(() => projectId
    ? { ...DEFAULT_PERMISSION_PRESET_LAB_DRAFT, permissionScope: "project" }
    : DEFAULT_PERMISSION_PRESET_LAB_DRAFT);
  const [past, setPast] = useState<PermissionPresetLabDraft[]>([]);
  const [future, setFuture] = useState<PermissionPresetLabDraft[]>([]);
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Preset lifecycle options are ready in this renderer session.");
  const [stagedImport, setStagedImport] = useState<PermissionPresetLabDraft | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const preset = useMemo(() => permissionPresetForDraft(draft), [draft]);
  const permissionCounts = useMemo(() => {
    return Object.values(preset.values).reduce((counts, mode) => {
      counts[mode] += 1;
      return counts;
    }, { allow: 0, prompt: 0, deny: 0 });
  }, [preset]);
  const serialized = useMemo(() => serializePermissionPresetLab(draft, format), [draft, format]);
  const previousDraft = past.at(-1);
  const nextDraft = future[0];
  const previousDiff = useMemo(() => previousDraft ? permissionPresetLabDiff(previousDraft, draft) : [], [previousDraft, draft]);
  const nextDiff = useMemo(() => nextDraft ? permissionPresetLabDiff(draft, nextDraft) : [], [draft, nextDraft]);
  const stagedDiff = useMemo(() => stagedImport ? permissionPresetLabDiff(draft, stagedImport) : [], [draft, stagedImport]);

  const commit = (next: PermissionPresetLabDraft, nextStatus: string) => {
    if (permissionPresetDraftEqual(next, draft)) {
      setStatus("That lifecycle preview already matches the current draft.");
      return;
    }
    setPast((current) => [...current, draft].slice(-40));
    setDraft(next);
    setFuture([]);
    setStatus(nextStatus);
  };

  const patch = (values: Partial<PermissionPresetLabDraft>, message: string) => {
    commit(updateDraftState(draft, values), message);
  };

  const applyPreset = (nextPreset: PermissionPreset) => {
    patch({ presetId: nextPreset.id }, `${nextPreset.label} selected for the lifecycle preview.`);
  };

  const stage = () => {
    commit(normalizePermissionPresetLabDraft({ ...draft, state: "staged" }), `${preset.label} staged for ${permissionPresetScopeLabel(draft)}. No native grant was created.`);
  };

  const revoke = () => {
    commit(normalizePermissionPresetLabDraft({ ...draft, state: "revoked" }), "Preset lifecycle preview revoked. Native permissions were not changed.");
  };

  const reset = () => {
    commit(DEFAULT_PERMISSION_PRESET_LAB_DRAFT, "Preset lifecycle preview reset to defaults.");
  };

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((current) => current.slice(0, -1));
    setFuture((current) => [draft, ...current]);
    setDraft(previous);
    setStatus("Undid one preset lifecycle preview change.");
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((current) => current.slice(1));
    setPast((current) => [...current, draft].slice(-40));
    setDraft(next);
    setStatus("Redid one preset lifecycle preview change.");
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; the lifecycle preview remains visible and no durable export was created.");
      return;
    }
    try {
      await navigator.clipboard.writeText(serialized);
      setStatus(`${format.toUpperCase()} lifecycle preview copied. It remains renderer-local.`);
    } catch {
      setStatus("Clipboard write failed; no durable lifecycle export was created.");
    }
  };

  const exportPreview = () => {
    const extension = format === "json" ? "json" : "md";
    const downloaded = downloadText(`omnia-permission-preset-${draft.presetId}.${extension}`, serialized, format === "json" ? "application/json" : "text/markdown");
    setStatus(downloaded ? "Lifecycle preview download started; native policy is unchanged." : "Browser download is unavailable; no durable lifecycle export was created.");
  };

  const importPreview = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parsePermissionPresetLab(await readText(file));
      if (!parsed) throw new Error("This is not an Omnia permission preset lifecycle JSON file.");
      setStagedImport(parsed);
      setStatus(`${permissionPresetForDraft(parsed).label} import staged for review. Native permissions remain unchanged.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Permission preset lifecycle import failed.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const applyImported = () => {
    if (!stagedImport) return;
    commit(stagedImport, `${permissionPresetForDraft(stagedImport).label} lifecycle import applied to the renderer session. Native permissions remain unchanged.`);
    setStagedImport(null);
  };

  return (
    <section className="permission-preset-lab" aria-labelledby="permission-preset-lab-title">
      <header className="permission-preset-lab__header">
        <span className="permission-preset-lab__icon"><SlidersHorizontal size={17} /></span>
        <div>
          <span className="eyebrow">{projectId ? "Project-scoped capability rehearsal" : "Scoped capability rehearsal"}</span>
          <h2 id="permission-preset-lab-title">Permission Preset Lab</h2>
          <p>{projectId
            ? "Shape this Project’s expiry, quota, audit, and revoke preview. It remains session-only until a native broker and durable policy exist."
            : "Shape expiry, quota, audit, and revoke behavior around a capability preset before a native broker exists."}</p>
        </div>
        <span className="permission-preset-lab__status"><Sparkles size={13} /> {projectId ? "Project draft · session-only" : "Preview only"}</span>
      </header>

      <div className="permission-preset-lab__metrics" aria-label="Permission preset lifecycle summary">
        <article><strong>{preset.label}</strong><span>Preset</span></article>
        <article><strong>{permissionPresetScopeLabel(draft)}</strong><span>Scope target</span></article>
        <article><strong>{draft.state}</strong><span>Lifecycle state</span></article>
        <article><strong>{permissionCounts.allow}/{permissionCounts.prompt}/{permissionCounts.deny}</strong><span>Allow / ask / deny</span></article>
      </div>

      <section className="permission-preset-lab__presets" aria-labelledby="permission-preset-lab-presets-title">
        <div className="permission-preset-lab__section-heading"><div><span className="eyebrow">Starting points</span><h3 id="permission-preset-lab-presets-title">Choose a capability profile</h3></div><ShieldCheck size={16} /></div>
        <div className="permission-preset-lab__preset-grid" role="list" aria-label="Permission lifecycle presets">
          {PERMISSION_PRESETS.map((candidate) => {
            const selected = candidate.id === draft.presetId;
            return <div role="listitem" key={candidate.id}>
              <button type="button" className={`permission-lab-preset permission-lab-preset--${candidate.tone}${selected ? " is-selected" : ""}`} onClick={() => applyPreset(candidate)} aria-label={`Select ${candidate.label} permission preset`} aria-pressed={selected}>
                <span className="permission-lab-preset__top"><strong>{candidate.label}</strong>{selected ? <Check size={14} /> : <Sparkles size={13} />}</span>
                <small>{candidate.description}</small>
              </button>
            </div>;
          })}
        </div>
      </section>

      <div className="permission-preset-lab__form">
        <label><span>Target scope</span><select value={draft.permissionScope} onChange={(event) => patch({ permissionScope: event.target.value as PermissionScope }, "Target scope changed in the renderer preview.")}><option value="session">{PERMISSION_SCOPE_LABELS.session}</option><option value="chat">{PERMISSION_SCOPE_LABELS.chat}</option><option value="project">{PERMISSION_SCOPE_LABELS.project}</option><option value="workspace">{PERMISSION_SCOPE_LABELS.workspace}</option></select></label>
        <label className="permission-preset-lab__check-field"><input type="checkbox" checked={draft.scopeMode === "all"} onChange={(event) => patch({ scopeMode: event.target.checked ? "all" : "selected" }, event.target.checked ? "Fan-out to all scopes enabled for preview." : "Selected-scope targeting restored.")} /><span>Stage for all scopes</span><small>Preview fan-out only; each scope still needs native approval.</small></label>
        <label><span><Clock3 size={13} /> Expiry</span><select value={draft.expiry} onChange={(event) => patch({ expiry: event.target.value as PermissionPresetExpiry }, "Expiry policy changed in the renderer preview.")}>{PERMISSION_PRESET_EXPIRY_OPTIONS.map((value) => <option value={value} key={value}>{expiryLabels[value]}</option>)}</select></label>
        {draft.expiry === "custom" ? <label><span>Custom expiry</span><input type="datetime-local" value={draft.customExpiry} onChange={(event) => patch({ customExpiry: event.target.value }, "Custom expiry changed in the renderer preview.")} /></label> : null}
        <label><span><Gauge size={13} /> Quota</span><select value={draft.quota} onChange={(event) => patch({ quota: event.target.value as PermissionPresetQuota }, "Quota policy changed in the renderer preview.")}>{PERMISSION_PRESET_QUOTA_OPTIONS.map((value) => <option value={value} key={value}>{quotaLabels[value]}</option>)}</select></label>
        {draft.quota === "daily" || draft.quota === "custom" ? <label><span>Quota amount</span><input type="number" min={1} max={100000} step={1} value={draft.quotaValue} onChange={(event) => patch({ quotaValue: Number(event.target.value) }, "Quota amount changed in the renderer preview.")} /></label> : null}
        <label><span><FileClock size={13} /> Audit detail</span><select value={draft.audit} onChange={(event) => patch({ audit: event.target.value as PermissionPresetAudit }, "Audit detail changed in the renderer preview.")}>{PERMISSION_PRESET_AUDIT_OPTIONS.map((value) => <option value={value} key={value}>{auditLabels[value]}</option>)}</select></label>
        <label><span><Ban size={13} /> Revoke rule</span><select value={draft.revoke} onChange={(event) => patch({ revoke: event.target.value as PermissionPresetRevoke }, "Revoke rule changed in the renderer preview.")}>{PERMISSION_PRESET_REVOKE_OPTIONS.map((value) => <option value={value} key={value}>{revokeLabels[value]}</option>)}</select></label>
        <label className="permission-preset-lab__note"><span>Operator note</span><textarea value={draft.note} maxLength={500} onChange={(event) => patch({ note: event.target.value }, "Operator note updated in the renderer preview.")} placeholder="Why is this scope/preset needed?" /></label>
      </div>

      <section className="permission-preset-lab__summary" aria-labelledby="permission-preset-lab-summary-title">
        <div className="permission-preset-lab__section-heading"><div><span className="eyebrow">Review before staging</span><h3 id="permission-preset-lab-summary-title">Lifecycle summary</h3></div><LockKeyhole size={16} /></div>
        <div className="permission-preset-lab__summary-grid">
          <span><strong>Scope</strong><em>{permissionPresetScopeLabel(draft)}</em></span>
          <span><strong>Expiry</strong><em>{permissionPresetExpiryLabel(draft)}</em></span>
          <span><strong>Quota</strong><em>{permissionPresetQuotaLabel(draft)}</em></span>
          <span><strong>Audit</strong><em>{permissionPresetAuditLabel(draft.audit)}</em></span>
          <span><strong>Revoke</strong><em>{permissionPresetRevokeLabel(draft.revoke)}</em></span>
          <span><strong>State</strong><em className={`is-${draft.state}`}>{draft.state}</em></span>
        </div>
        <p><LockKeyhole size={13} /> Staging is a renderer rehearsal. It does not grant the preset, extend a lease, bypass provider refusal, or change OS/UAC/ACL permissions.</p>
      </section>

      <div className="permission-preset-lab__actions" role="toolbar" aria-label="Permission preset lifecycle controls">
        <button type="button" className="button button--secondary" onClick={stage} disabled={draft.state === "staged"}><Check size={13} /> Stage preview</button>
        <button type="button" className="button button--ghost" onClick={revoke} disabled={draft.state === "revoked"}><Ban size={13} /> Revoke preview</button>
        <span className="permission-preset-lab__history-count">{past.length} undo · {future.length} redo</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={past.length === 0} aria-label="Undo permission preset lifecycle change"><Undo2 size={13} /></button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo permission preset lifecycle change"><Redo2 size={13} /></button>
        <button type="button" className="button button--ghost" onClick={reset} disabled={permissionPresetDraftEqual(draft, DEFAULT_PERMISSION_PRESET_LAB_DRAFT)}><RotateCcw size={13} /> Reset</button>
      </div>

      <section className="permission-preset-lab__history" aria-labelledby="permission-preset-lab-history-title">
        <div className="permission-preset-lab__section-heading">
          <div><span className="eyebrow">Renderer-session timeline</span><h3 id="permission-preset-lab-history-title">History &amp; diff</h3></div>
          <span className="permission-preset-lab__history-badge">{past.length} undo · {future.length} redo</span>
        </div>
        <div className="permission-preset-lab__history-grid">
          <article className="permission-preset-lab__history-card">
            <span className="eyebrow">Previous revision</span>
            <strong>{previousDraft ? permissionPresetForDraft(previousDraft).label : "Start of session"}</strong>
            {previousDiff.length ? <ul>{previousDiff.slice(0, 4).map((change) => <li key={`previous-${change.key}`}><span>{change.label}</span><em>{change.before} → {change.after}</em></li>)}</ul> : <p>No earlier renderer change is staged.</p>}
          </article>
          <article className="permission-preset-lab__history-card is-current">
            <span className="eyebrow">Current preview</span>
            <strong>{preset.label}</strong>
            <p>{permissionPresetScopeLabel(draft)} · {draft.state}</p>
            <span className="permission-preset-lab__history-current">Active renderer draft</span>
          </article>
          <article className="permission-preset-lab__history-card">
            <span className="eyebrow">Next redo revision</span>
            <strong>{nextDraft ? permissionPresetForDraft(nextDraft).label : "No queued redo"}</strong>
            {nextDiff.length ? <ul>{nextDiff.slice(0, 4).map((change) => <li key={`next-${change.key}`}><span>{change.label}</span><em>{change.before} → {change.after}</em></li>)}</ul> : <p>Redo history is empty.</p>}
          </article>
        </div>
        <p className="permission-preset-lab__history-boundary"><LockKeyhole size={13} /> Diff values are renderer-session previews only; undo/redo does not grant, revoke, or persist native permissions.</p>
      </section>

      <section className="permission-preset-lab__export" aria-labelledby="permission-preset-lab-export-title">
        <div className="permission-preset-lab__section-heading"><div><span className="eyebrow">Portable preview</span><h3 id="permission-preset-lab-export-title">Lifecycle package</h3></div><SlidersHorizontal size={16} /></div>
        <p>Move the preset metadata between renderer sessions as JSON or Markdown. The package contains no secret material or native approval receipt; imports are staged for diff review.</p>
        <div className="permission-preset-lab__export-actions">
          <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <button type="button" className="button button--ghost" onClick={() => void copy()}><Copy size={13} /> Copy</button>
          <button type="button" className="button button--ghost" onClick={exportPreview}><Download size={13} /> Download</button>
          <button type="button" className="button button--ghost" onClick={() => importRef.current?.click()}><Upload size={13} /> Import package</button>
          <input ref={importRef} type="file" accept="application/json,text/markdown,.json,.md,.markdown" hidden aria-label="Import permission preset lifecycle JSON" onChange={(event) => void importPreview(event.target.files?.[0])} />
        </div>
        <pre aria-label="Permission preset lifecycle export">{serialized}</pre>
      </section>

      {stagedImport ? <section className="permission-preset-lab__staged-import" aria-labelledby="permission-preset-lab-import-title">
        <div className="permission-preset-lab__section-heading">
          <div><span className="eyebrow">Import review</span><h3 id="permission-preset-lab-import-title">{permissionPresetForDraft(stagedImport).label} staged</h3></div>
          <button type="button" className="button button--ghost" onClick={() => { setStagedImport(null); setStatus("Staged permission import dismissed; current draft is unchanged."); }}><Ban size={13} /> Dismiss</button>
        </div>
        <p>Review the incoming lifecycle diff before applying it to this renderer session.</p>
        {stagedDiff.length ? <ul>{stagedDiff.slice(0, 8).map((change) => <li key={`import-${change.key}`}><span>{change.label}</span><em>{change.before} → {change.after}</em></li>)}</ul> : <p>No changes detected; applying would keep the current renderer draft.</p>}
        <div className="permission-preset-lab__staged-actions"><button type="button" className="button button--secondary" onClick={applyImported}><Check size={13} /> Apply imported preview</button><span>Renderer-local only · no native grant</span></div>
      </section> : null}

      <p className="permission-preset-lab__boundary"><ShieldCheck size={14} /> {PERMISSION_PRESET_LAB_BOUNDARY}</p>
      <p className="permission-preset-lab__status-line" role="status"><span aria-hidden="true" /> {status}</p>
    </section>
  );
}
