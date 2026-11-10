import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Copy,
  Download,
  Gauge,
  Globe2,
  History,
  LockKeyhole,
  Network,
  RotateCcw,
  Search,
  ShieldAlert,
  Timer,
  Undo2,
  Redo2,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { formatProviderCheckTime } from "./provider-catalog";
import type { ProviderView } from "./types";

type HealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";
type HealthScenario = "catalog-observed" | "latency-warning" | "auth-failure" | "timeout" | "not-observed";
type HealthTab = "overview" | "detail" | "history" | "export";

type EndpointHealthRecord = {
  id: string;
  providerId: string;
  providerName: string;
  endpoint: string;
  providerState: ProviderView["state"];
  status: HealthStatus;
  scenario: HealthScenario;
  latencyMs: number | null;
  checkedAt: string | null;
  modelCount: number;
  protocol: string;
  evidence: string;
  issue: string;
  enabled: boolean;
};

type HealthHistory = {
  past: EndpointHealthRecord[][];
  present: EndpointHealthRecord[];
  future: EndpointHealthRecord[][];
};

const HEALTH_FORMAT = "omnia.provider-endpoint-health.preview.v1";

const scenarioCatalog: readonly { value: HealthScenario; label: string; detail: string }[] = [
  { value: "catalog-observed", label: "Catalog state", detail: "Keep the visible provider state and latency metadata." },
  { value: "latency-warning", label: "Latency warning", detail: "Rehearse a slow but potentially reachable endpoint." },
  { value: "auth-failure", label: "Auth rejected", detail: "Rehearse an authentication or permission failure." },
  { value: "timeout", label: "Request timeout", detail: "Rehearse no response before the configured deadline." },
  { value: "not-observed", label: "Not observed", detail: "Clear the check evidence without touching provider settings." },
];

const statusLabel: Record<HealthStatus, string> = {
  healthy: "Healthy preview",
  degraded: "Degraded preview",
  unavailable: "Unavailable preview",
  unknown: "Not observed",
};

const cloneRecords = (records: EndpointHealthRecord[]) => records.map((record) => ({ ...record }));

function protocolForProvider(provider: ProviderView): string {
  const value = `${provider.providerType} ${provider.kind}`.toLowerCase();
  if (value.includes("anthropic")) return "Anthropic Messages";
  if (value.includes("gemini")) return "Google Gemini";
  if (value.includes("ollama") || provider.kind === "Local") return "OpenAI-compatible / local";
  return "OpenAI-compatible";
}

function initialScenario(provider: ProviderView): HealthScenario {
  if (provider.state === "validating" || !provider.lastCheckedAt) return "not-observed";
  if (provider.state === "error") return "auth-failure";
  if (provider.state === "degraded" || (provider.latencyMs ?? 0) >= 500) return "latency-warning";
  return "catalog-observed";
}

function recordFromProvider(provider: ProviderView): EndpointHealthRecord {
  const scenario = initialScenario(provider);
  return recordWithScenario(provider, scenario);
}

function recordWithScenario(provider: ProviderView, scenario: HealthScenario): EndpointHealthRecord {
  const source = provider.source === "native" ? "Native profile metadata" : provider.source === "demo" ? "Demo catalog seed" : "Renderer catalog";
  const baseLatency = provider.latencyMs;
  const status: HealthStatus = scenario === "catalog-observed"
    ? provider.state === "connected" ? "healthy" : provider.state === "degraded" ? "degraded" : "unknown"
    : scenario === "latency-warning" ? "degraded"
      : scenario === "not-observed" ? "unknown" : "unavailable";
  const latencyMs = scenario === "latency-warning" ? Math.max(baseLatency ?? 620, 620) : scenario === "timeout" ? null : scenario === "not-observed" ? null : baseLatency;
  const issue = scenario === "catalog-observed"
    ? provider.errorMessage ?? (provider.state === "connected" ? "No issue in the visible catalog state." : `Provider is ${provider.state.replaceAll("-", " ")}.`)
    : scenario === "latency-warning" ? "Response latency is above the preview warning threshold (500 ms)."
      : scenario === "auth-failure" ? "The configured credential or permission would need review."
        : scenario === "timeout" ? "No response was observed before the preview timeout window."
          : "No endpoint check receipt is available in this renderer session.";
  return {
    id: `endpoint-health-${provider.id}`,
    providerId: provider.id,
    providerName: provider.name,
    endpoint: provider.endpoint,
    providerState: provider.state,
    status,
    scenario,
    latencyMs,
    checkedAt: scenario === "not-observed" ? null : provider.lastCheckedAt,
    modelCount: provider.models.length || provider.modelCount,
    protocol: protocolForProvider(provider),
    evidence: source,
    issue,
    enabled: provider.enabled,
  };
}

function healthTone(status: HealthStatus): string {
  return `provider-endpoint-health__status provider-endpoint-health__status--${status}`;
}

function latencyLabel(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

function exportJson(records: EndpointHealthRecord[], selectedId: string | null): string {
  return JSON.stringify({
    format: HEALTH_FORMAT,
    scope: "renderer-session",
    selectedId,
    records,
    boundary: ["Preview only", "Renderer-local", "No provider request", "No durable write", "No credential lookup"],
  }, null, 2);
}

function exportMarkdown(records: EndpointHealthRecord[]): string {
  return [
    "# Omnia endpoint health (preview)",
    "",
    "> Preview only · Renderer-local · No provider request · No durable write",
    "",
    "| Provider | Status | Latency | Checked | Evidence | Issue |",
    "| --- | --- | ---: | --- | --- | --- |",
    ...records.map((record) => `| ${record.providerName} | ${statusLabel[record.status]} | ${latencyLabel(record.latencyMs)} | ${record.checkedAt ? formatProviderCheckTime(record.checkedAt) : "Not observed"} | ${record.evidence} | ${record.issue} |`),
  ].join("\n");
}

function downloadText(filename: string, content: string, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

function Boundary({ children }: { readonly children: ReactNode }) {
  return <p className="provider-endpoint-health__boundary"><LockKeyhole size={13} /> <span>{children}</span></p>;
}

export function ProviderEndpointHealthPreview({ providers }: { readonly providers: ProviderView[] }) {
  const [history, setHistory] = useState<HealthHistory>(() => {
    const records = providers.map(recordFromProvider);
    return { past: [], present: records, future: [] };
  });
  const [selectedId, setSelectedId] = useState(() => providers[0] ? `endpoint-health-${providers[0].id}` : null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<HealthStatus | "all">("all");
  const [activeTab, setActiveTab] = useState<HealthTab>("overview");
  const [status, setStatus] = useState("Endpoint health is a renderer-local projection; no probe was sent.");
  const records = history.present;
  const selected = records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery = !normalized || `${record.providerName} ${record.endpoint} ${record.protocol} ${record.issue}`.toLowerCase().includes(normalized);
      return matchesQuery && (statusFilter === "all" || record.status === statusFilter);
    });
  }, [query, records, statusFilter]);

  const commit = (next: EndpointHealthRecord[], message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneRecords(current.present)], present: cloneRecords(next), future: [] }));
    setStatus(message);
  };

  const updateSelected = (scenario: HealthScenario) => {
    if (!selected) return;
    const provider = providers.find((item) => item.id === selected.providerId);
    if (!provider) return;
    const next = records.map((record) => record.id === selected.id ? recordWithScenario(provider, scenario) : record);
    commit(next, `${scenarioCatalog.find((item) => item.value === scenario)?.label ?? "Scenario"} rehearsed for ${selected.providerName}.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneRecords(previous), future: [cloneRecords(current.present), ...current.future] };
    });
    setStatus("Undid the last endpoint-health preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneRecords(current.present)], present: cloneRecords(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next endpoint-health preview change.");
  };

  const reset = () => {
    commit(providers.map(recordFromProvider), "Endpoint-health preview reset to visible provider metadata.");
  };

  const json = exportJson(records, selected?.id ?? null);
  const markdown = exportMarkdown(records);
  const copy = async (content: string, label: string) => {
    if (!navigator.clipboard?.writeText) {
      setStatus(`${label} could not be copied because clipboard access is unavailable.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setStatus(`${label} copied from the renderer preview.`);
    } catch {
      setStatus(`${label} could not be copied because clipboard access was denied.`);
    }
  };

  return (
    <section className="provider-endpoint-health" aria-labelledby="provider-endpoint-health-title">
      <header className="provider-endpoint-health__header">
        <span className="provider-endpoint-health__icon"><Activity size={17} /></span>
        <span><span className="eyebrow">Provider route observability</span><h2 id="provider-endpoint-health-title">Endpoint Health</h2><p>Compare endpoint readiness, latency bands, and failure classes before a native health receipt exists.</p></span>
        <span className="provider-endpoint-health__badge"><Gauge size={12} /> Preview only</span>
      </header>

      <div className="provider-endpoint-health__metrics" aria-label="Endpoint health summary">
        <span><strong>{visible.length}</strong><small>visible endpoints</small></span>
        <span><strong>{records.filter((record) => record.status === "healthy").length}</strong><small>healthy preview</small></span>
        <span><strong>{records.filter((record) => record.status === "degraded" || record.status === "unavailable").length}</strong><small>need attention</small></span>
        <span><strong>0</strong><small>live probes sent</small></span>
      </div>

      <div className="provider-endpoint-health__history" role="toolbar" aria-label="Endpoint health history">
        <span><strong>Reversible health rehearsal</strong><small>{status}</small></span>
        <span className="provider-endpoint-health__history-count">{history.past.length + history.future.length} steps</span>
        <span className="provider-endpoint-health__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo endpoint health change"><Undo2 size={12} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo endpoint health change"><Redo2 size={12} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset endpoint health preview"><RotateCcw size={12} /> Reset</button>
        </span>
      </div>

      <nav className="provider-endpoint-health__tabs" role="tablist" aria-label="Endpoint health views">
        {([ ["overview", "Overview", Activity], ["detail", "Selected route", Network], ["history", "Check history", History], ["export", "Export", Download] ] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? "is-active" : ""} onClick={() => setActiveTab(id)}><Icon size={13} />{label}</button>
        ))}
      </nav>

      {activeTab === "overview" ? (
        <div className="provider-endpoint-health__overview">
          <div className="provider-endpoint-health__filters" role="search">
            <label className="provider-endpoint-health__search"><Search size={14} /><span className="sr-only">Search endpoints</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search provider, endpoint, issue" aria-label="Search endpoints" /></label>
            <label><span>Health</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as HealthStatus | "all")} aria-label="Filter endpoint health"><option value="all">All statuses</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="unavailable">Unavailable</option><option value="unknown">Not observed</option></select></label>
            <span className="provider-endpoint-health__count" role="status">{visible.length} visible</span>
          </div>
          <div className="provider-endpoint-health__body">
            <div className="provider-endpoint-health__list" role="list" aria-label="Endpoint health records">
              {visible.map((record) => <div key={record.id} role="listitem"><button type="button" className={selected?.id === record.id ? "provider-endpoint-health__record is-selected" : "provider-endpoint-health__record"} onClick={() => setSelectedId(record.id)} aria-label={`Inspect ${record.providerName} endpoint`}>
                <span className={healthTone(record.status)}><span />{statusLabel[record.status]}</span>
                <span className="provider-endpoint-health__record-copy"><strong>{record.providerName}</strong><small>{record.endpoint}</small></span>
                <span className="provider-endpoint-health__record-meta"><b>{latencyLabel(record.latencyMs)}</b><small>{record.modelCount} models</small></span>
              </button></div>)}
              {!visible.length ? <div className="provider-endpoint-health__empty"><Search size={16} /><strong>No endpoint matches</strong><span>Adjust the query or status filter.</span></div> : null}
            </div>
            {selected ? <aside className="provider-endpoint-health__summary" aria-label="Selected endpoint health summary">
              <span className="eyebrow">Selected route</span><h3>{selected.providerName}</h3><p>{selected.endpoint}</p>
              <span className={healthTone(selected.status)}><span />{statusLabel[selected.status]}</span>
              <div className="provider-endpoint-health__signal-grid"><span><strong>{latencyLabel(selected.latencyMs)}</strong><small>latency band</small></span><span><strong>{selected.modelCount || "—"}</strong><small>catalog models</small></span><span><strong>{selected.protocol}</strong><small>protocol hint</small></span><span><strong>{selected.checkedAt ? formatProviderCheckTime(selected.checkedAt) : "Not observed"}</strong><small>last check label</small></span></div>
              <label className="provider-endpoint-health__scenario"><span>Probe scenario <small>Renderer rehearsal only</small></span><select value={selected.scenario} onChange={(event) => updateSelected(event.target.value as HealthScenario)} aria-label="Probe scenario">{scenarioCatalog.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
              <p className="provider-endpoint-health__issue"><AlertTriangle size={14} /><span>{selected.issue}</span></p>
              <button type="button" className="button button--secondary" onClick={() => setActiveTab("detail")}><ShieldAlert size={13} /> Inspect check details</button>
            </aside> : null}
          </div>
        </div>
      ) : null}

      {activeTab === "detail" && selected ? <div className="provider-endpoint-health__detail"><div className="provider-endpoint-health__detail-heading"><div><span className="eyebrow">Route evidence</span><h3>{selected.providerName}</h3><p>{selected.endpoint}</p></div><span className={healthTone(selected.status)}><span />{statusLabel[selected.status]}</span></div><div className="provider-endpoint-health__checks"><article><CheckCircle2 size={15} /><div><strong>Endpoint shape</strong><small>{selected.endpoint ? "Absolute endpoint metadata is present." : "No endpoint metadata is available."}</small></div><em>{selected.endpoint ? "Ready" : "Missing"}</em></article><article><Timer size={15} /><div><strong>Latency signal</strong><small>{selected.latencyMs === null ? "No latency sample is available." : `Preview sample: ${selected.latencyMs} ms.`}</small></div><em>{selected.latencyMs === null ? "Unknown" : selected.latencyMs >= 500 ? "Review" : "Ready"}</em></article><article><ShieldAlert size={15} /><div><strong>Auth / permission</strong><small>{selected.scenario === "auth-failure" ? selected.issue : "No auth failure was rehearsed in this view."}</small></div><em>{selected.scenario === "auth-failure" ? "Review" : "Not exercised"}</em></article><article><Globe2 size={15} /><div><strong>Model discovery</strong><small>{selected.modelCount ? `${selected.modelCount} catalog model${selected.modelCount === 1 ? "" : "s"} visible.` : "No catalog models are visible."}</small></div><em>{selected.modelCount ? "Catalog" : "Unknown"}</em></article></div><Boundary>These checks explain a renderer projection only. DNS, TLS, auth, quota, provider HTTP, retries, and native persistence are not exercised here.</Boundary></div> : null}

      {activeTab === "history" ? <div className="provider-endpoint-health__history-panel"><header><div><span className="eyebrow">Timeline projection</span><h3>Endpoint check history</h3><p>Each row is derived from the current preview record; no probe log is being written.</p></div><span><History size={15} /> {records.length} routes</span></header><div className="provider-endpoint-health__timeline">{records.map((record) => <article key={record.id}><span className={healthTone(record.status)}><span />{statusLabel[record.status]}</span><div><strong>{record.providerName}</strong><small>{record.checkedAt ? formatProviderCheckTime(record.checkedAt) : "Not observed"} · {record.evidence}</small><p>{record.issue}</p></div><b>{latencyLabel(record.latencyMs)}</b></article>)}</div><Boundary>History is a renderer-local projection and can be reset at any time. It is not a durable health ledger or a provider SLA statement.</Boundary></div> : null}

      {activeTab === "export" ? <div className="provider-endpoint-health__export"><header><div><span className="eyebrow">Portable inspection bundle</span><h3>Export endpoint health</h3><p>Useful for handoff and design review; credential bytes, provider payloads, and native receipts are excluded.</p></div><div className="provider-endpoint-health__export-actions"><button type="button" className="button button--ghost" onClick={() => void copy(json, "Endpoint health JSON")}><Copy size={13} /> Copy JSON</button><button type="button" className="button button--ghost" onClick={() => void copy(markdown, "Endpoint health Markdown")}><Clipboard size={13} /> Copy Markdown</button><button type="button" className="button button--ghost" onClick={() => downloadText("omnia-endpoint-health.preview.json", json, "application/json")}><Download size={13} /> Download</button></div></header><pre aria-label="Endpoint health export preview">{json}</pre><Boundary>Preview only · Renderer-local · No provider request · No durable write · No credential lookup.</Boundary></div> : null}

      <Boundary>{status} Preview only · Renderer-local · No live probe, provider request, credential lookup, retry, quota read, or durable write.</Boundary>
    </section>
  );
}
