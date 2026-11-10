import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  HardDrive,
  Info,
  Laptop,
  RefreshCw,
  ShieldCheck,
  Thermometer,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

type ReadinessTone = "unknown" | "required" | "planned" | "blocked";

type ReadinessCheck = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: string;
  readonly tone: ReadinessTone;
};

type LocalModelRole = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly posture: string;
};

const AUDIT_SNAPSHOT = "2026-08-14";

const readinessChecks: readonly ReadinessCheck[] = [
  {
    id: "runtime",
    label: "Runtime discovery",
    detail: "No Ollama, llama-server, or LM Studio executable was resolved in the audit snapshot.",
    status: "Not observed",
    tone: "unknown",
  },
  {
    id: "payload",
    label: "Model payload",
    detail: "No verified local model files were found in the inspected stores.",
    status: "Not observed",
    tone: "unknown",
  },
  {
    id: "storage",
    label: "Storage and runtime plan",
    detail: "A user-approved root, runtime choice, quota, and rollback plan are required before acquisition.",
    status: "Approval required",
    tone: "required",
  },
  {
    id: "integrity",
    label: "Integrity and license gate",
    detail: "Exact source, revision, hash, license, and supply-chain checks must precede promotion.",
    status: "Required before download",
    tone: "required",
  },
  {
    id: "benchmark",
    label: "Benchmark evidence",
    detail: "Role-specific quality, latency, resource, stability, and privacy evidence is not available yet.",
    status: "Planned",
    tone: "planned",
  },
  {
    id: "fallback",
    label: "Hybrid fallback",
    detail: "Local routes need an explicit fallback policy; local capability is not a cloud-product replacement claim.",
    status: "Policy required",
    tone: "required",
  },
];

const roles: readonly LocalModelRole[] = [
  {
    id: "assistant-code",
    label: "Small chat and code assistant",
    detail: "A compact quantized candidate may fit this hardware, subject to measured context and speed.",
    posture: "Planning inference",
  },
  {
    id: "retrieval",
    label: "Embedding and reranking",
    detail: "Specialist retrieval components are a more realistic first local workload than frontier chat.",
    posture: "Candidate review",
  },
  {
    id: "vision-speech",
    label: "OCR, vision, and speech",
    detail: "Each modality needs its own model, runtime, license, and smoke-test evidence.",
    posture: "Candidate review",
  },
  {
    id: "frontier-parity",
    label: "Frontier cloud replacement",
    detail: "The current snapshot does not support a claim of full local parity for research, multimodal, or coding agents.",
    posture: "Not evidenced",
  },
];

const hostFacts = [
  { label: "CPU", value: "Intel Core i5-10300H · 4 cores / 8 logical" },
  { label: "Memory", value: "Approximately 15.8 GiB system RAM" },
  { label: "GPU", value: "NVIDIA GTX 1650 Ti · approximately 4 GiB VRAM" },
  { label: "Storage", value: "C: approximately 23.2 GiB free · D: approximately 953.5 GiB free" },
] as const;

const cloneChecks = () => readinessChecks.map((check) => ({ ...check }));

function toneIcon(tone: ReadinessTone) {
  if (tone === "unknown") return <Info size={14} />;
  if (tone === "planned") return <RefreshCw size={14} />;
  if (tone === "blocked") return <XCircle size={14} />;
  return <AlertTriangle size={14} />;
}

function toneLabel(tone: ReadinessTone) {
  if (tone === "unknown") return "Unknown evidence";
  if (tone === "planned") return "Planned gate";
  if (tone === "blocked") return "Blocked";
  return "Required gate";
}

function downloadText(filename: string, content: string) {
  if (typeof document === "undefined") return;
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export function LocalModelReadinessPreview() {
  const defaultRole = roles[0]!;
  const [storageRoot, setStorageRoot] = useState("D: data volume");
  const [selectedRole, setSelectedRole] = useState(defaultRole.id);
  const [includeFallback, setIncludeFallback] = useState(true);
  const [status, setStatus] = useState(
    "Audit snapshot loaded; no native filesystem or runtime probe was started.",
  );
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const selectedRoleRecord = roles.find((role) => role.id === selectedRole) ?? defaultRole;
  const checks = useMemo(() => cloneChecks(), []);
  const payload = useMemo(
    () =>
      JSON.stringify(
        {
          schema: "omnia.local-model-readiness.preview.v1",
          source: `Audit snapshot ${AUDIT_SNAPSHOT}`,
          host: hostFacts,
          runtimeDiscovery: "not-observed",
          modelPayload: "not-observed",
          selectedRole: selectedRoleRecord.label,
          storageRoot,
          hybridFallback: includeFallback,
          gates: checks.map(({ id, status, tone }) => ({ id, status, tone })),
          boundary: "renderer-local; no filesystem probe, runtime discovery, download, benchmark, provider request, or native receipt",
        },
        null,
        2,
      ),
    [checks, includeFallback, selectedRoleRecord.label, storageRoot],
  );

  const refreshPreview = () => {
    const now = new Date();
    const label = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setRefreshedAt(label);
    setStatus(`Renderer preview refreshed at ${label}; no native probe or filesystem scan was performed.`);
  };

  const copyPayload = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable; no readiness brief was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus("Copied the redacted readiness brief; no durable file was written.");
    } catch {
      setStatus("Clipboard write failed; no readiness brief was copied.");
    }
  };

  return (
    <section className="local-model-readiness" aria-labelledby="local-model-readiness-title">
      <header className="local-model-readiness__header">
        <span className="local-model-readiness__icon" aria-hidden="true"><Laptop size={18} /></span>
        <span>
          <span className="eyebrow">Local runtime posture</span>
          <h2 id="local-model-readiness-title">Local Model Readiness</h2>
          <p>Turn the host audit into an honest acquisition and evidence plan before choosing a local model.</p>
        </span>
        <span className="local-model-readiness__badge"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="local-model-readiness__boundary" role="note">
        <Info size={15} />
        <span>Historical host snapshot from <strong>{AUDIT_SNAPSHOT}</strong>. Refresh CPU/GPU, disk, runtime, and model-store evidence before acting; this surface only projects that audit and does not inspect the filesystem, discover runtimes, download models, or prove local parity.</span>
      </div>

      <div className="local-model-readiness__summary" aria-label="Local model readiness summary">
        <article><span>Runtime</span><strong>Not observed</strong><small>No executable receipt</small></article>
        <article><span>Model payload</span><strong>Not observed</strong><small>No verified files</small></article>
        <article><span>Preferred volume</span><strong>D: data volume</strong><small>More headroom in audit</small></article>
        <article><span>Parity claim</span><strong>Not evidenced</strong><small>Benchmark gate required</small></article>
      </div>

      <div className="local-model-readiness__controls" aria-label="Local model planning controls">
        <label><span>Planning role</span><select value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)} aria-label="Planning role">{roles.map((role) => <option value={role.id} key={role.id}>{role.label}</option>)}</select></label>
        <label><span>Candidate storage root</span><select value={storageRoot} onChange={(event) => setStorageRoot(event.target.value)} aria-label="Candidate storage root"><option value="D: data volume">D: data volume · preferred in audit</option><option value="C: system volume">C: system volume · limited headroom</option><option value="User-selected later">User-selected later</option></select></label>
        <label className="local-model-readiness__toggle"><input type="checkbox" aria-label="Require hybrid fallback" checked={includeFallback} onChange={(event) => setIncludeFallback(event.target.checked)} /><span><strong>Require hybrid fallback</strong><small>Planning policy only; does not enable a route.</small></span></label>
      </div>

      <div className="local-model-readiness__role-callout" role="note">
        <div><span className="eyebrow">Selected role</span><strong>{selectedRoleRecord.label}</strong><p>{selectedRoleRecord.detail}</p></div>
        <span className="local-model-readiness__role-status">{selectedRoleRecord.posture}</span>
      </div>

      <div className="local-model-readiness__facts" aria-label="Audited host facts">
        <div className="local-model-readiness__section-heading"><span><HardDrive size={14} /> Host facts</span><small>Read-only audit snapshot</small></div>
        <div className="local-model-readiness__fact-grid">{hostFacts.map((fact) => <article key={fact.label}><strong>{fact.label}</strong><span>{fact.value}</span></article>)}</div>
        <div className="local-model-readiness__fact-note"><Thermometer size={14} /><span>Hardware fit is a planning inference. Exact model candidates still need current source, license, resource, thermal, latency, stability, and quality evidence.</span></div>
      </div>

      <div className="local-model-readiness__checks" aria-label="Readiness gates">
        <div className="local-model-readiness__section-heading"><span><CheckCircle2 size={14} /> Readiness gates</span><small>{checks.filter((check) => check.tone === "unknown").length} unknown · {checks.filter((check) => check.tone === "required").length} required</small></div>
        <div className="local-model-readiness__check-grid">{checks.map((check) => <article key={check.id} className={`local-model-readiness__check local-model-readiness__check--${check.tone}`}><span className="local-model-readiness__check-icon">{toneIcon(check.tone)}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div><span className="local-model-readiness__check-status"><b>{check.status}</b><em>{toneLabel(check.tone)}</em></span></article>)}</div>
      </div>

      <div className="local-model-readiness__actions">
        <button type="button" className="button button--primary" onClick={refreshPreview}><RefreshCw size={14} /> Refresh preview</button>
        <button type="button" className="button button--secondary" onClick={() => void copyPayload()}><Clipboard size={14} /> Copy readiness brief</button>
        <button type="button" className="button button--secondary" onClick={() => downloadText("omnia-local-model-readiness.preview.json", payload)}><Download size={14} /> Download JSON</button>
      </div>
      <p className="local-model-readiness__status" role="status" aria-live="polite">{status}{refreshedAt ? ` Last preview refresh: ${refreshedAt}.` : ""}</p>
      <pre className="local-model-readiness__payload" aria-label="Local model readiness JSON preview">{payload}</pre>
      <p className="local-model-readiness__footer"><ShieldCheck size={13} /> Renderer-local planning projection · no provider request · no credential lookup · no filesystem authority · no runtime launch · no durable write.</p>
    </section>
  );
}

export default LocalModelReadinessPreview;
