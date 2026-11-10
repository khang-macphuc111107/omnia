import {
  Check,
  Copy,
  Download,
  Eye,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  MonitorCog,
  Network,
  Redo2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_POLICY_BOUNDARY,
  SECURITY_POLICY_PROFILES,
  SECURITY_PROFILE_DESCRIPTIONS,
  SECURITY_PROFILE_LABELS,
  compareSecurityPolicyProfiles,
  normalizeSecurityPolicy,
  parseSecurityPolicyPreview,
  safeSecurityPolicyPayload,
  securityPolicyDiff,
  securityPolicyEqual,
  securityPolicyFieldLabel,
  securityPolicyGateCount,
  securityPolicyRiskCount,
  securityPolicyStatusLabel,
  serializeSecurityPolicy,
  type SecurityPolicyDraft,
  type SecurityProfileId,
} from "./security-policy-preview-contract";

type PolicyField = Exclude<keyof SecurityPolicyDraft, "profile">;

const FIELD_OPTIONS: Record<PolicyField, readonly string[]> = {
  confirmation: ["high-risk", "side-effects", "every-operation"],
  unknownOperations: ["deny", "prompt", "preview-allow"],
  network: ["approved-hosts", "public-https", "offline"],
  filesystem: ["approved-roots", "workspace-roots", "preview-all"],
  secrets: ["opaque-reference", "prompt-each-use", "blocked"],
  telemetry: ["redacted", "minimal", "off"],
  desktop: ["blocked", "prompt", "preview-only"],
};

const FIELD_META: Record<PolicyField, { label: string; description: string; icon: typeof Network }> = {
  confirmation: { label: "Confirmation", description: "When a future broker would ask before side effects.", icon: ShieldCheck },
  unknownOperations: { label: "Unknown operations", description: "How requests outside the declared catalog are treated.", icon: ShieldAlert },
  network: { label: "Network", description: "The visible transport boundary for provider and research routes.", icon: Network },
  filesystem: { label: "Filesystem", description: "The visible path boundary for workspace and artifact operations.", icon: FolderOpen },
  secrets: { label: "Secrets", description: "How credentials and secret references are represented in a future native flow.", icon: KeyRound },
  telemetry: { label: "Telemetry", description: "The amount of redacted evidence a future diagnostics layer may retain.", icon: Eye },
  desktop: { label: "Desktop automation", description: "Whether future window, keyboard, or OS automation would require review.", icon: MonitorCog },
};

function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The security policy preview file could not be read."));
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

export function SecurityPolicyPreview({ projectId }: { readonly projectId?: string | null | undefined }) {
  const [policy, setPolicy] = useState<SecurityPolicyDraft>(() => projectId ? { ...DEFAULT_SECURITY_POLICY } : DEFAULT_SECURITY_POLICY);
  const [past, setPast] = useState<SecurityPolicyDraft[]>([]);
  const [future, setFuture] = useState<SecurityPolicyDraft[]>([]);
  const [comparisonLeft, setComparisonLeft] = useState<SecurityProfileId>("balanced");
  const [comparisonRight, setComparisonRight] = useState<SecurityProfileId>("developer");
  const [format, setFormat] = useState<"json" | "markdown">("json");
  const [status, setStatus] = useState("Security policy controls are ready in this renderer session.");
  const importRef = useRef<HTMLInputElement>(null);

  const diff = useMemo(() => securityPolicyDiff(DEFAULT_SECURITY_POLICY, policy), [policy]);
  const serialized = useMemo(() => serializeSecurityPolicy(policy, format), [format, policy]);
  const payload = useMemo(() => safeSecurityPolicyPayload(policy), [policy]);
  const profileEntries = Object.entries(SECURITY_POLICY_PROFILES) as [SecurityProfileId, SecurityPolicyDraft][];
  const profileComparison = useMemo(
    () => compareSecurityPolicyProfiles(comparisonLeft, comparisonRight),
    [comparisonLeft, comparisonRight],
  );
  const commit = (next: SecurityPolicyDraft, message: string) => {
    const normalized = normalizeSecurityPolicy(next);
    if (securityPolicyEqual(normalized, policy)) {
      setStatus("That security policy preview already matches the current draft.");
      return;
    }
    setPast((current) => [...current, policy].slice(-40));
    setPolicy(normalized);
    setFuture([]);
    setStatus(message);
  };

  const applyProfile = (profile: SecurityProfileId) => commit(
    SECURITY_POLICY_PROFILES[profile],
    `${SECURITY_PROFILE_LABELS[profile]} selected for the renderer policy preview.`,
  );

  const updateField = (field: PolicyField, value: string) => commit(
    { ...policy, [field]: value },
    `${FIELD_META[field].label} changed in the renderer policy preview.`,
  );

  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    setPast((current) => current.slice(0, -1));
    setFuture((current) => [policy, ...current]);
    setPolicy(previous);
    setStatus("Undid one security policy preview change. No native authority was changed.");
  };

  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((current) => current.slice(1));
    setPast((current) => [...current, policy].slice(-40));
    setPolicy(next);
    setStatus("Redid one security policy preview change. No native authority was changed.");
  };

  const reset = () => commit(DEFAULT_SECURITY_POLICY, "Security policy preview reset to Balanced defaults.");

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; the policy preview remains visible and no durable export was created.");
      return;
    }
    try {
      await navigator.clipboard.writeText(serialized);
      setStatus(`${format.toUpperCase()} security policy preview copied. It remains renderer-local.`);
    } catch {
      setStatus("Clipboard write failed; no durable security policy export was created.");
    }
  };

  const exportPreview = () => {
    const extension = format === "json" ? "json" : "md";
    const downloaded = downloadText(`omnia-security-policy.${extension}`, serialized, format === "json" ? "application/json" : "text/markdown");
    setStatus(downloaded ? "Security policy preview download started; native policy is unchanged." : "Browser download is unavailable; the preview remains renderer-local.");
  };

  const importPreview = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseSecurityPolicyPreview(await readText(file));
      if (!parsed) throw new Error("This is not an Omnia security policy preview JSON file.");
      commit(parsed, "Imported security policy preview applied to this renderer session. Native policy remains unchanged.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Security policy preview import failed.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  return (
    <section className="security-policy-preview" aria-labelledby="security-policy-preview-title">
      <header className="security-policy-preview__header">
        <span className="security-policy-preview__icon"><ShieldCheck size={18} /></span>
        <div>
          <span className="eyebrow">{projectId ? "Project-scoped renderer draft" : "Capability policy studio"}</span>
          <h2 id="security-policy-preview-title">Security policy preview</h2>
          <p>Compare guardrail profiles and shape a future approval policy before native broker authority is connected.</p>
        </div>
        <span className="security-policy-preview__status"><LockKeyhole size={13} /> {projectId ? "Project draft · session-only" : "Preview only"}</span>
      </header>

      <div className="security-policy-preview__metrics" aria-label="Security policy summary">
        <article><strong>{securityPolicyStatusLabel(policy)}</strong><span>Current posture</span></article>
        <article><strong>{securityPolicyRiskCount(policy)}</strong><span>Review signals</span></article>
        <article><strong>{securityPolicyGateCount(policy)}</strong><span>Fail-closed gates</span></article>
        <article><strong>{diff.length}</strong><span>Changes from Balanced</span></article>
      </div>

      <section className="security-policy-preview__profiles" aria-labelledby="security-policy-profile-title">
        <div className="security-policy-preview__section-heading"><div><span className="eyebrow">Starting points</span><h3 id="security-policy-profile-title">Choose a security posture</h3></div><ShieldCheck size={16} /></div>
        <div className="security-policy-preview__profile-grid" role="list" aria-label="Security policy profiles">
          {profileEntries.map(([id, candidate]) => {
            const selected = policy.profile === id;
            return <button type="button" key={id} className={`security-policy-profile security-policy-profile--${id}${selected ? " is-selected" : ""}`} onClick={() => applyProfile(id)} aria-pressed={selected} aria-label={`Use ${SECURITY_PROFILE_LABELS[id]} security profile`}>
              <span className="security-policy-profile__top"><strong>{SECURITY_PROFILE_LABELS[id]}</strong>{selected ? <Check size={14} /> : <ShieldCheck size={13} />}</span>
              <small>{SECURITY_PROFILE_DESCRIPTIONS[id]}</small>
              <span className="security-policy-profile__signals"><em>{securityPolicyRiskCount(candidate)} review signals</em><em>{securityPolicyGateCount(candidate)} gates</em></span>
            </button>;
          })}
        </div>
      </section>

      <section className="security-policy-preview__compare" aria-labelledby="security-policy-compare-title">
        <div className="security-policy-preview__section-heading"><div><span className="eyebrow">Built-in profile review</span><h3 id="security-policy-compare-title">Compare guardrail profiles</h3></div><ShieldAlert size={16} /></div>
        <p className="security-policy-preview__compare-copy">Compare the declared profile shapes before choosing one. Counts are descriptive preview signals, not effective native-policy evaluation.</p>
        <div className="security-policy-preview__compare-selectors">
          <label><span>Profile A</span><select value={comparisonLeft} onChange={(event) => setComparisonLeft(event.target.value as SecurityProfileId)} aria-label="Compare left security profile">{profileEntries.map(([id]) => <option value={id} key={id}>{SECURITY_PROFILE_LABELS[id]}</option>)}</select></label>
          <span aria-hidden="true">→</span>
          <label><span>Profile B</span><select value={comparisonRight} onChange={(event) => setComparisonRight(event.target.value as SecurityProfileId)} aria-label="Compare right security profile">{profileEntries.map(([id]) => <option value={id} key={id}>{SECURITY_PROFILE_LABELS[id]}</option>)}</select></label>
        </div>
        <div className="security-policy-preview__compare-metrics" aria-label="Profile comparison summary">
          <article><strong>{profileComparison.differences.length}</strong><span>Different controls</span></article>
          <article><strong>{profileComparison.leftReviewSignals} → {profileComparison.rightReviewSignals}</strong><span>Review signals</span></article>
          <article><strong>{profileComparison.leftFailClosedGates} → {profileComparison.rightFailClosedGates}</strong><span>Fail-closed gates</span></article>
        </div>
        {profileComparison.differences.length > 0 ? <div className="security-policy-preview__diff" role="list" aria-label="Profile comparison differences">
          {profileComparison.differences.map((change) => <div className="security-policy-diff-row" role="listitem" key={change.key}><strong>{change.label}</strong><span>{securityPolicyFieldLabel(change.key, change.before)}</span><b aria-hidden="true">→</b><em>{securityPolicyFieldLabel(change.key, change.after)}</em></div>)}
        </div> : <p className="security-policy-preview__empty">These profiles have the same preview values for every policy dimension.</p>}
      </section>

      <section className="security-policy-preview__controls" aria-labelledby="security-policy-controls-title">
        <div className="security-policy-preview__section-heading"><div><span className="eyebrow">Fine-grained controls</span><h3 id="security-policy-controls-title">Policy dimensions</h3></div><Network size={16} /></div>
        <div className="security-policy-preview__control-grid">
          {(Object.keys(FIELD_META) as PolicyField[]).map((field) => {
            const meta = FIELD_META[field];
            const Icon = meta.icon;
            return <label className="security-policy-control" key={field}>
              <span className="security-policy-control__label"><Icon size={14} /><span><strong>{meta.label}</strong><small>{meta.description}</small></span></span>
              <select value={policy[field]} onChange={(event) => updateField(field, event.target.value)} aria-label={`Security policy ${meta.label}`}>
                {FIELD_OPTIONS[field].map((value) => <option value={value} key={value}>{securityPolicyFieldLabel(field, value)}</option>)}
              </select>
            </label>;
          })}
        </div>
      </section>

      <section className="security-policy-preview__review" aria-labelledby="security-policy-review-title">
        <div className="security-policy-preview__section-heading"><div><span className="eyebrow">Review before native promotion</span><h3 id="security-policy-review-title">Change summary</h3></div><ShieldAlert size={16} /></div>
        {diff.length > 0 ? <div className="security-policy-preview__diff" role="list" aria-label="Security policy changes from Balanced">
          {diff.map((change) => <div className="security-policy-diff-row" role="listitem" key={change.key}><strong>{change.label}</strong><span>{securityPolicyFieldLabel(change.key, change.before)}</span><b aria-hidden="true">→</b><em>{securityPolicyFieldLabel(change.key, change.after)}</em></div>)}
        </div> : <p className="security-policy-preview__empty">Balanced defaults are active; no policy dimensions differ in this renderer draft.</p>}
        <p className="security-policy-preview__review-note"><ShieldAlert size={13} /> Review signals are heuristic UI guidance only. They do not calculate effective native policy, approve a grant, or bypass provider/OS refusal.</p>
      </section>

      <div className="security-policy-preview__actions" role="toolbar" aria-label="Security policy preview controls">
        <button type="button" className="button button--ghost" onClick={undo} disabled={past.length === 0} aria-label="Undo security policy preview change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={future.length === 0} aria-label="Redo security policy preview change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} disabled={securityPolicyEqual(policy, DEFAULT_SECURITY_POLICY)}><RotateCcw size={14} /> Reset</button>
        <span className="security-policy-preview__history-count">{past.length} undo · {future.length} redo</span>
      </div>

      <section className="security-policy-preview__export" aria-labelledby="security-policy-export-title">
        <div className="security-policy-preview__section-heading"><div><span className="eyebrow">Portable preview</span><h3 id="security-policy-export-title">Policy package</h3></div><Download size={16} /></div>
        <p>Inspect or move this session-only policy as JSON or Markdown. The export contains no secrets, credentials, native approval receipt, or OS permission.</p>
        <div className="security-policy-preview__export-actions">
          <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as "json" | "markdown")} aria-label="Security policy export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <button type="button" className="button button--ghost" onClick={() => void copy()}><Copy size={13} /> Copy</button>
          <button type="button" className="button button--ghost" onClick={exportPreview}><Download size={13} /> Download</button>
          <button type="button" className="button button--ghost" onClick={() => importRef.current?.click()}><Upload size={13} /> Import JSON</button>
          <input ref={importRef} hidden type="file" accept="application/json,.json" aria-label="Import security policy preview JSON" onChange={(event) => void importPreview(event.target.files?.[0])} />
        </div>
        <pre aria-label="Security policy preview export">{format === "json" ? JSON.stringify(payload, null, 2) : serialized}</pre>
      </section>

      <p className="security-policy-preview__boundary"><LockKeyhole size={14} /> {SECURITY_POLICY_BOUNDARY}</p>
      <p className="security-policy-preview__status-line" role="status"><span aria-hidden="true" /> {status}</p>
    </section>
  );
}
