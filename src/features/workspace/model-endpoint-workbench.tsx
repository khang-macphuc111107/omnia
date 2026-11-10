import {
  Activity,
  Braces,
  Check,
  Clipboard,
  Copy,
  Download,
  FileJson2,
  FlaskConical,
  Globe2,
  Layers3,
  LockKeyhole,
  Network,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Redo2,
} from "lucide-react";
import { useMemo, useState, type ChangeEvent, type ReactNode } from "react";

import {
  endpointBuilderPresets,
  endpointOperationLabel,
  endpointRoutePreview,
  validateEndpointBuilder,
} from "./provider-endpoint-builder";
import type { ProviderView } from "./types";

type EndpointTab = "endpoint" | "operations" | "parameters" | "evidence";
type ProtocolFamily =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-gemini"
  | "ollama-native"
  | "custom";
type Transport = "http" | "sse" | "websocket" | "polling";
type AuthScheme = "none" | "bearer" | "api-key-header" | "oauth2" | "custom";
type Freshness = "unknown" | "manual" | "cached-stale" | "cached-fresh" | "live-probe";
type SupportLevel =
  | "documented-native"
  | "model-gated"
  | "adapter-gated"
  | "bridge-required"
  | "unsupported"
  | "unknown";
type OperationId =
  | "responses"
  | "chat-completions"
  | "messages"
  | "generate-content"
  | "stream-content"
  | "embeddings"
  | "models"
  | "files"
  | "batches"
  | "images"
  | "video"
  | "audio"
  | "custom";
type ParameterId =
  | "temperature"
  | "maxOutputTokens"
  | "reasoningEffort"
  | "responseFormat"
  | "tools"
  | "vision";
type ParameterSource = "app-default" | "model-profile" | "provider-profile" | "request";

type EndpointOperation = {
  readonly id: OperationId;
  readonly label: string;
  readonly detail: string;
  readonly modality: string;
  readonly defaultSupport: SupportLevel;
};

type EndpointDraft = {
  name: string;
  providerId: string;
  protocolFamily: ProtocolFamily;
  apiVersion: string;
  baseUrl: string;
  transport: Transport;
  authScheme: AuthScheme;
  modelHint: string;
  operations: OperationId[];
  support: Record<OperationId, SupportLevel>;
  freshness: Freshness;
  adapterRevision: string;
  evidenceNote: string;
  parameters: Record<ParameterId, { value: string; source: ParameterSource }>;
};

type EndpointHistory = {
  past: EndpointDraft[];
  present: EndpointDraft;
  future: EndpointDraft[];
};

const operationCatalog: readonly EndpointOperation[] = [
  { id: "responses", label: "Responses", detail: "Unified response generation with tool and structured-output lanes.", modality: "text · tool · structured", defaultSupport: "documented-native" },
  { id: "chat-completions", label: "Chat completions", detail: "Message-oriented text generation for OpenAI-shaped adapters.", modality: "text · streaming", defaultSupport: "adapter-gated" },
  { id: "messages", label: "Messages", detail: "Anthropic-style content blocks and streamed message events.", modality: "text · content blocks", defaultSupport: "adapter-gated" },
  { id: "generate-content", label: "Generate content", detail: "Gemini-style generation and model-scoped content parts.", modality: "text · image input", defaultSupport: "adapter-gated" },
  { id: "stream-content", label: "Stream content", detail: "Incremental provider events with explicit partial outcome handling.", modality: "text · events", defaultSupport: "model-gated" },
  { id: "embeddings", label: "Embeddings", detail: "Vector representation requests for retrieval and ranking workflows.", modality: "embedding", defaultSupport: "unknown" },
  { id: "models", label: "Model discovery", detail: "Catalog refresh and manual model fallback metadata.", modality: "metadata", defaultSupport: "documented-native" },
  { id: "files", label: "Files & uploads", detail: "Provider file handles, upload policy, and retention metadata.", modality: "file · document", defaultSupport: "unknown" },
  { id: "batches", label: "Batch jobs", detail: "Asynchronous batch lifecycle and idempotency planning.", modality: "async job", defaultSupport: "unknown" },
  { id: "images", label: "Image generation", detail: "Prompt-to-image capability remains operation and model scoped.", modality: "image output", defaultSupport: "bridge-required" },
  { id: "video", label: "Video generation", detail: "Long-running media jobs and polling/webhook lifecycle.", modality: "video output", defaultSupport: "bridge-required" },
  { id: "audio", label: "Audio", detail: "Speech, transcription, and audio carrier planning.", modality: "audio", defaultSupport: "unknown" },
  { id: "custom", label: "Custom operation", detail: "Declarative adapter operation with explicit mapping and evidence.", modality: "adapter-defined", defaultSupport: "adapter-gated" },
];

const parameterCatalog: readonly { id: ParameterId; label: string; detail: string; kind: "number" | "select" | "toggle" }[] = [
  { id: "temperature", label: "Temperature", detail: "Cross-provider sampling intent; translation remains adapter-specific.", kind: "number" },
  { id: "maxOutputTokens", label: "Max output tokens", detail: "Provider/model limit is not inferred from a label.", kind: "number" },
  { id: "reasoningEffort", label: "Reasoning effort", detail: "Only sent when the selected model and adapter support it.", kind: "select" },
  { id: "responseFormat", label: "Response format", detail: "Structured output may require a model-scoped capability snapshot.", kind: "select" },
  { id: "tools", label: "Tool calls", detail: "Capability declaration only in this preview.", kind: "toggle" },
  { id: "vision", label: "Vision input", detail: "Attachment support is operation/model/carrier scoped.", kind: "toggle" },
];

const protocolOptions: readonly { value: ProtocolFamily; label: string; version: string }[] = [
  { value: "openai-responses", label: "OpenAI Responses", version: "v1" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions", version: "v1" },
  { value: "anthropic-messages", label: "Anthropic Messages", version: "2023-06-01" },
  { value: "google-gemini", label: "Google Gemini", version: "v1beta" },
  { value: "ollama-native", label: "Ollama native", version: "v1" },
  { value: "custom", label: "Custom adapter", version: "custom" },
];

const cloneDraft = (draft: EndpointDraft): EndpointDraft => ({
  ...draft,
  operations: [...draft.operations],
  support: { ...draft.support },
  parameters: Object.fromEntries(
    Object.entries(draft.parameters).map(([id, parameter]) => [id, { ...parameter }]),
  ) as EndpointDraft["parameters"],
});

function protocolFromProvider(provider: ProviderView | undefined): ProtocolFamily {
  const value = `${provider?.providerType ?? ""} ${provider?.kind ?? ""}`.toLowerCase();
  if (value.includes("anthropic")) return "anthropic-messages";
  if (value.includes("gemini")) return "google-gemini";
  if (value.includes("ollama")) return "ollama-native";
  if (value.includes("openai")) return "openai-responses";
  return "openai-chat-completions";
}

function protocolLabel(protocol: ProtocolFamily): string {
  return protocolOptions.find((option) => option.value === protocol)?.label ?? "Custom adapter";
}

function freshnessLabel(freshness: Freshness): string {
  return freshness === "live-probe"
    ? "Live probe (planned)"
    : freshness === "cached-fresh"
      ? "Cached fresh (unverified)"
      : freshness === "cached-stale"
        ? "Cached stale"
        : freshness === "manual"
          ? "Manual evidence"
          : "Unknown / not observed";
}

function supportLabel(level: SupportLevel): string {
  return level.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function initialDraft(providers: ProviderView[]): EndpointDraft {
  const provider = providers[0];
  const protocolFamily = protocolFromProvider(provider);
  const selectedModel = provider?.models[0];
  const support = Object.fromEntries(
    operationCatalog.map((operation) => [operation.id, operation.defaultSupport]),
  ) as Record<OperationId, SupportLevel>;
  return {
    name: provider ? `${provider.name} endpoint snapshot` : "New endpoint snapshot",
    providerId: provider?.id ?? "unassigned",
    protocolFamily,
    apiVersion: protocolOptions.find((option) => option.value === protocolFamily)?.version ?? "v1",
    baseUrl: provider?.endpoint ?? "https://api.example.com/v1",
    transport: protocolFamily === "ollama-native" ? "http" : "sse",
    authScheme: provider?.authScheme === "none" ? "none" : "bearer",
    modelHint: selectedModel?.providerModelId ?? "",
    operations: protocolFamily === "anthropic-messages" ? ["messages", "stream-content", "models"] : ["responses", "stream-content", "models"],
    support,
    freshness: "unknown",
    adapterRevision: "adapter.preview.unverified",
    evidenceNote: "No native capability snapshot is available in the browser preview.",
    parameters: {
      temperature: { value: "0.7", source: "model-profile" },
      maxOutputTokens: { value: "4096", source: "model-profile" },
      reasoningEffort: { value: "medium", source: "model-profile" },
      responseFormat: { value: "text", source: "app-default" },
      tools: { value: "true", source: "model-profile" },
      vision: { value: "false", source: "provider-profile" },
    },
  };
}

function exportJson(draft: EndpointDraft): string {
  return JSON.stringify(
    {
      format: "omnia.model-endpoint-workbench.preview.v1",
      scope: "renderer-session",
      endpoint: {
        ...draft,
        baseUrl: draft.baseUrl || "",
      },
      boundary: ["Preview only", "Renderer-local", "No provider request", "No durable write", "No capability receipt"],
    },
    null,
    2,
  );
}

function exportMarkdown(draft: EndpointDraft): string {
  const operations = draft.operations.map((id) => {
    const operation = operationCatalog.find((item) => item.id === id);
    return `- ${operation?.label ?? id}: ${supportLabel(draft.support[id])}`;
  });
  return [
    "# Omnia model endpoint snapshot (preview)",
    "",
    "> Preview only · Renderer-local · No provider request · No durable write",
    "",
    `- Name: ${draft.name}`,
    `- Protocol: ${protocolLabel(draft.protocolFamily)} ${draft.apiVersion}`,
    `- Base URL: ${draft.baseUrl}`,
    `- Transport: ${draft.transport}`,
    `- Auth shape: ${draft.authScheme}`,
    `- Freshness: ${freshnessLabel(draft.freshness)}`,
    `- Adapter revision: ${draft.adapterRevision}`,
    "",
    "## Selected operations",
    ...operations,
    "",
    `Evidence note: ${draft.evidenceNote}`,
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
  return <p className="model-endpoint-workbench__boundary"><LockKeyhole size={14} />{children}</p>;
}

export function ModelEndpointWorkbench({ providers }: { readonly providers: ProviderView[] }) {
  const [history, setHistory] = useState<EndpointHistory>(() => {
    const draft = initialDraft(providers);
    return { past: [], present: draft, future: [] };
  });
  const [activeTab, setActiveTab] = useState<EndpointTab>("endpoint");
  const [selectedOperation, setSelectedOperation] = useState<OperationId>("responses");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [status, setStatus] = useState("Endpoint metadata is a renderer-local draft; no provider request was sent.");
  const draft = history.present;
  const builderInput = useMemo(() => ({
    name: draft.name,
    protocolFamily: draft.protocolFamily,
    apiVersion: draft.apiVersion,
    baseUrl: draft.baseUrl,
    transport: draft.transport,
    authScheme: draft.authScheme,
    modelHint: draft.modelHint,
    operations: draft.operations,
  }), [draft]);
  const builderValidation = useMemo(() => validateEndpointBuilder(builderInput), [builderInput]);
  const routePreviews = useMemo(() => endpointRoutePreview(builderInput), [builderInput]);
  const selectedOperationRecord = operationCatalog.find((operation) => operation.id === selectedOperation) ?? operationCatalog[0]!;
  const selectedOperationEnabled = draft.operations.includes(selectedOperation);
  const enabledOperations = useMemo(
    () => operationCatalog.filter((operation) => draft.operations.includes(operation.id)),
    [draft.operations],
  );

  const commit = (next: EndpointDraft, message: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneDraft(current.present)],
      present: cloneDraft(next),
      future: [],
    }));
    setStatus(message);
  };

  const update = (patch: Partial<EndpointDraft>, message = "Endpoint draft changed in this renderer session.") => {
    commit({ ...draft, ...patch }, message);
  };

  const updateParameter = (id: ParameterId, patch: Partial<EndpointDraft["parameters"][ParameterId]>) => {
    update(
      { parameters: { ...draft.parameters, [id]: { ...draft.parameters[id], ...patch } } },
      `${parameterCatalog.find((parameter) => parameter.id === id)?.label ?? "Parameter"} override updated locally.`,
    );
  };

  const toggleOperation = (id: OperationId) => {
    const operations = draft.operations.includes(id)
      ? draft.operations.filter((operation) => operation !== id)
      : [...draft.operations, id];
    update({ operations }, `${operationCatalog.find((operation) => operation.id === id)?.label ?? id} operation selection changed locally.`);
    setSelectedOperation(id);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneDraft(previous), future: [cloneDraft(current.present), ...current.future] };
    });
    setStatus("Undid the last endpoint preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneDraft(current.present)], present: cloneDraft(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next endpoint preview change.");
  };

  const reset = () => {
    commit(initialDraft(providers), "Endpoint snapshot preview reset to visible provider metadata.");
    setSelectedPresetId("");
  };

  const applyPreset = () => {
    const preset = endpointBuilderPresets.find((item) => item.id === selectedPresetId);
    if (!preset) return;
    update(
      {
        protocolFamily: preset.protocolFamily,
        apiVersion: preset.apiVersion,
        baseUrl: preset.baseUrl,
        transport: preset.transport,
        authScheme: preset.authScheme,
        operations: [...preset.operations],
      },
      `${preset.label} preset applied to the renderer endpoint draft.`,
    );
    setSelectedOperation(preset.operations[0] ?? "responses");
  };

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

  const selectProtocol = (event: ChangeEvent<HTMLSelectElement>) => {
    const protocolFamily = event.target.value as ProtocolFamily;
    const option = protocolOptions.find((item) => item.value === protocolFamily);
    const operations = protocolFamily === "anthropic-messages"
      ? ["messages", "stream-content", "models"] as OperationId[]
      : protocolFamily === "google-gemini"
        ? ["generate-content", "stream-content", "models"] as OperationId[]
        : protocolFamily === "ollama-native"
          ? ["chat-completions", "models"] as OperationId[]
          : ["responses", "stream-content", "models"] as OperationId[];
    update({ protocolFamily, apiVersion: option?.version ?? "v1", operations }, `${protocolLabel(protocolFamily)} selected for the renderer endpoint preview.`);
  };

  const setParameterValue = (id: ParameterId, value: string) => updateParameter(id, { value });

  const renderParameterControl = (parameter: (typeof parameterCatalog)[number]) => {
    const current = draft.parameters[parameter.id];
    if (parameter.kind === "toggle") {
      return <input type="checkbox" checked={current.value === "true"} onChange={(event) => setParameterValue(parameter.id, String(event.target.checked))} aria-label={`${parameter.label} enabled`} />;
    }
    if (parameter.kind === "select") {
      const options = parameter.id === "reasoningEffort"
        ? ["off", "low", "medium", "high", "max"]
        : ["text", "json", "json-schema", "provider-default"];
      return <select value={current.value} onChange={(event) => setParameterValue(parameter.id, event.target.value)} aria-label={parameter.label}>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select>;
    }
    return <input type="number" value={current.value} min={parameter.id === "temperature" ? 0 : 1} max={parameter.id === "temperature" ? 2 : 1_000_000} step={parameter.id === "temperature" ? 0.1 : 1} onChange={(event) => setParameterValue(parameter.id, event.target.value)} aria-label={parameter.label} />;
  };

  return (
    <section className="model-endpoint-workbench" aria-labelledby="model-endpoint-workbench-title">
      <header className="model-endpoint-workbench__header">
        <span className="model-endpoint-workbench__icon"><Network size={18} /></span>
        <span>
          <span className="eyebrow">Renderer-local capability lab</span>
          <h2 id="model-endpoint-workbench-title">Model Endpoint Workbench</h2>
          <p>Shape protocol, operation, parameter, and evidence metadata before a native adapter snapshot exists.</p>
        </span>
        <span className="model-endpoint-workbench__badge"><Sparkles size={13} /> Preview only</span>
      </header>

      <div className="model-endpoint-workbench__stats" aria-label="Model endpoint preview metrics">
        <span><strong>{enabledOperations.length}</strong><small>Selected operations</small></span>
        <span><strong>{protocolLabel(draft.protocolFamily)}</strong><small>Protocol family</small></span>
        <span><strong>{freshnessLabel(draft.freshness).split(" ")[0]}</strong><small>Evidence freshness</small></span>
        <span><strong>0</strong><small>Live requests</small></span>
      </div>

      <div className="model-endpoint-workbench__history" role="toolbar" aria-label="Model endpoint preview history">
        <span><strong>Reversible endpoint draft</strong><small>{status}</small></span>
        <span className="model-endpoint-workbench__history-count">{history.past.length + history.future.length} steps</span>
        <span className="model-endpoint-workbench__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo endpoint preview change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo endpoint preview change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset endpoint preview"><RotateCcw size={13} /> Reset</button>
        </span>
      </div>

      <div className="model-endpoint-workbench__tabs" role="tablist" aria-label="Model endpoint workbench views">
        {([
          ["endpoint", "Endpoint", Globe2],
          ["operations", "Operations", Layers3],
          ["parameters", "Parameters", SlidersHorizontal],
          ["evidence", "Evidence & export", FileJson2],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} id={`model-endpoint-tab-${id}`} type="button" role="tab" aria-selected={activeTab === id} aria-controls={`model-endpoint-panel-${id}`} tabIndex={activeTab === id ? 0 : -1} className={activeTab === id ? "model-endpoint-workbench__tab model-endpoint-workbench__tab--active" : "model-endpoint-workbench__tab"} onClick={() => setActiveTab(id)}>
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      <div id={`model-endpoint-panel-${activeTab}`} role="tabpanel" aria-labelledby={`model-endpoint-tab-${activeTab}`} className="model-endpoint-workbench__panel" tabIndex={0}>
        {activeTab === "endpoint" ? (
          <>
          <div className="model-endpoint-workbench__endpoint-grid">
            <label><span>Snapshot name</span><input value={draft.name} onChange={(event) => update({ name: event.target.value })} aria-label="Endpoint snapshot name" /></label>
            <label><span>Protocol family</span><select value={draft.protocolFamily} onChange={selectProtocol} aria-label="Endpoint protocol family">{protocolOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            <label className="model-endpoint-workbench__field--wide"><span>Base URL <small>Metadata string only</small></span><input value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} spellCheck={false} aria-label="Endpoint base URL" /></label>
            <label><span>API version</span><input value={draft.apiVersion} onChange={(event) => update({ apiVersion: event.target.value })} aria-label="Endpoint API version" /></label>
            <label><span>Transport</span><select value={draft.transport} onChange={(event) => update({ transport: event.target.value as Transport })} aria-label="Endpoint transport"><option value="http">HTTP</option><option value="sse">HTTP + SSE</option><option value="websocket">WebSocket</option><option value="polling">HTTP + polling</option></select></label>
            <label><span>Auth scheme</span><select value={draft.authScheme} onChange={(event) => update({ authScheme: event.target.value as AuthScheme })} aria-label="Endpoint auth scheme"><option value="none">None</option><option value="bearer">Bearer</option><option value="api-key-header">API key header</option><option value="oauth2">OAuth 2</option><option value="custom">Custom</option></select></label>
            <label><span>Model ID hint <small>Optional fallback</small></span><input value={draft.modelHint} onChange={(event) => update({ modelHint: event.target.value })} placeholder="automatic / undiscovered" aria-label="Endpoint model ID hint" /></label>
            <div className="model-endpoint-workbench__endpoint-callout"><ShieldCheck size={15} /><span><strong>Credential boundary</strong><small>Only an auth shape is modeled here. Secret values and opaque handles never enter this renderer workbench.</small></span></div>
          </div>
          <div className="model-endpoint-workbench__builder-tools">
            <div>
              <span className="eyebrow">Endpoint builder</span>
              <h3>Start from a protocol preset</h3>
              <p>Presets fill the visible metadata only. Review every route before a future native adapter can use it.</p>
            </div>
            <div className="model-endpoint-workbench__builder-actions">
              <label>
                <span>Endpoint preset</span>
                <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)} aria-label="Endpoint preset">
                  <option value="">Choose a starting point…</option>
                  {endpointBuilderPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}
                </select>
              </label>
              <button type="button" className="button button--ghost" onClick={applyPreset} disabled={!selectedPresetId} aria-label="Apply endpoint preset">
                <Sparkles size={13} /> Apply preset
              </button>
            </div>
          </div>
          <div className={builderValidation.valid ? "model-endpoint-workbench__builder-review model-endpoint-workbench__builder-review--ready" : "model-endpoint-workbench__builder-review model-endpoint-workbench__builder-review--needs-review"}>
            <div className="model-endpoint-workbench__builder-review-heading">
              <span><ShieldCheck size={14} /><strong>{builderValidation.valid ? "Ready for review" : "Needs endpoint fixes"}</strong></span>
              <small>{builderValidation.issues.filter((issue) => issue.severity === "error").length} errors · {builderValidation.issues.filter((issue) => issue.severity === "warning").length} warnings</small>
            </div>
            {builderValidation.issues.length > 0 ? <ul>{builderValidation.issues.map((issue) => <li key={`${issue.field}-${issue.message}`}><strong>{issue.severity === "error" ? "Error" : "Warning"}</strong> {issue.message}</li>)}</ul> : <p>URL shape, protocol metadata, and selected operation set are internally consistent in this preview.</p>}
          </div>
          <div className="model-endpoint-workbench__route-preview" aria-label="Endpoint route preview">
            <div className="model-endpoint-workbench__route-preview-heading">
              <span><Network size={14} /><strong>Request route preview</strong></span>
              <small>{routePreviews.length} selected route{routePreviews.length === 1 ? "" : "s"} · no request sent</small>
            </div>
            {routePreviews.length > 0 ? <div className="model-endpoint-workbench__route-list">{routePreviews.map((route) => <div className="model-endpoint-route" key={`${route.operationId}-${route.path}`}>
              <span className="model-endpoint-route__method">{route.method}</span>
              <span className="model-endpoint-route__copy"><strong>{endpointOperationLabel(route.operationId)}</strong><code>{route.path}</code><small>{route.note}{route.stream ? " · streaming" : ""}</small></span>
              <span className="model-endpoint-route__url" title={route.absoluteUrl}>{route.absoluteUrl}</span>
            </div>)}</div> : <p className="model-endpoint-workbench__route-empty">Choose an operation to preview its method and path.</p>}
          </div>
          </>
        ) : null}

        {activeTab === "operations" ? (
          <div className="model-endpoint-workbench__operations-layout">
            <div className="model-endpoint-workbench__operation-list" role="list" aria-label="Endpoint operations">
              {operationCatalog.map((operation) => {
                const selected = draft.operations.includes(operation.id);
                return <div key={operation.id} role="listitem"><button type="button" className={selected ? "model-endpoint-operation model-endpoint-operation--selected" : "model-endpoint-operation"} aria-pressed={selected} onClick={() => { setSelectedOperation(operation.id); toggleOperation(operation.id); }}>
                  <span className="model-endpoint-operation__check">{selected ? <Check size={13} /> : null}</span>
                  <span><strong>{operation.label}</strong><small>{operation.modality}</small></span>
                  <em>{supportLabel(draft.support[operation.id])}</em>
                </button></div>;
              })}
            </div>
            <aside className="model-endpoint-workbench__operation-detail" aria-label="Selected endpoint operation details">
              <span className="eyebrow">Operation contract</span>
              <h3>{selectedOperationRecord.label}</h3>
              <p>{selectedOperationRecord.detail}</p>
              <div className="model-endpoint-workbench__detail-metrics"><span><strong>{selectedOperationEnabled ? "Included" : "Excluded"}</strong><small>In snapshot</small></span><span><strong>{selectedOperationRecord.modality}</strong><small>Modality hint</small></span></div>
              <label><span>Support level <small>Evidence-scoped</small></span><select value={draft.support[selectedOperation]} onChange={(event) => update({ support: { ...draft.support, [selectedOperation]: event.target.value as SupportLevel } })} aria-label="Selected operation support level">{(["documented-native", "model-gated", "adapter-gated", "bridge-required", "unsupported", "unknown"] as SupportLevel[]).map((level) => <option value={level} key={level}>{supportLabel(level)}</option>)}</select></label>
              <p className="model-endpoint-workbench__operation-note"><FlaskConical size={14} /> A capability probe, adapter fixture, or user override would be required before dispatch.</p>
            </aside>
          </div>
        ) : null}

        {activeTab === "parameters" ? (
          <div className="model-endpoint-workbench__parameters">
            <div className="model-endpoint-workbench__parameters-heading"><div><span className="eyebrow">Schema-driven controls</span><h3>Requested parameter intent</h3><p>Every value keeps its visible inheritance source so unsupported fields can be surfaced instead of silently dropped.</p></div><span className="model-endpoint-workbench__parameter-badge"><Braces size={13} /> Adapter translation planned</span></div>
            <div className="model-endpoint-workbench__parameter-list">
              {parameterCatalog.map((parameter) => {
                const current = draft.parameters[parameter.id];
                return <div key={parameter.id} className="model-endpoint-parameter"><span className="model-endpoint-parameter__copy"><strong>{parameter.label}</strong><small>{parameter.detail}</small></span><span className="model-endpoint-parameter__control">{renderParameterControl(parameter)}</span><label className="model-endpoint-parameter__source"><span>Source</span><select value={current.source} onChange={(event) => updateParameter(parameter.id, { source: event.target.value as ParameterSource })} aria-label={`${parameter.label} source`}><option value="app-default">App default</option><option value="model-profile">Model profile</option><option value="provider-profile">Provider profile</option><option value="request">This request</option></select></label></div>;
              })}
            </div>
            <Boundary>Requested, translated, effective, ignored, and rejected values will require a native adapter receipt. This preview only records the requested intent.</Boundary>
          </div>
        ) : null}

        {activeTab === "evidence" ? (
          <div className="model-endpoint-workbench__evidence">
            <div className="model-endpoint-workbench__evidence-grid"><article><span><Network size={14} /> Protocol snapshot</span><strong>{protocolLabel(draft.protocolFamily)}</strong><small>{draft.apiVersion} · {draft.transport}</small></article><article><span><Activity size={14} /> Freshness</span><strong>{freshnessLabel(draft.freshness)}</strong><small>No native timestamp in browser preview</small></article><article><span><Braces size={14} /> Adapter revision</span><strong>{draft.adapterRevision}</strong><small>Renderer label only</small></article><article><span><ShieldCheck size={14} /> Capability authority</span><strong>Not available</strong><small>Manual or native evidence required</small></article></div>
            <div className="model-endpoint-workbench__evidence-form"><label><span>Freshness classification</span><select value={draft.freshness} onChange={(event) => update({ freshness: event.target.value as Freshness })} aria-label="Endpoint evidence freshness"><option value="unknown">Unknown / not observed</option><option value="manual">Manual evidence</option><option value="cached-stale">Cached stale</option><option value="cached-fresh">Cached fresh (unverified)</option><option value="live-probe">Live probe (planned)</option></select></label><label><span>Adapter revision label</span><input value={draft.adapterRevision} onChange={(event) => update({ adapterRevision: event.target.value })} aria-label="Endpoint adapter revision" /></label><label className="model-endpoint-workbench__field--wide"><span>Evidence note</span><textarea value={draft.evidenceNote} onChange={(event) => update({ evidenceNote: event.target.value })} rows={4} aria-label="Endpoint evidence note" /></label></div>
            <div className="model-endpoint-workbench__export"><div><span className="eyebrow">Portable snapshot</span><h3>Take the endpoint plan with you</h3><p>Exports omit credential values, prompts, provider payloads, and native receipts.</p></div><div className="model-endpoint-workbench__export-actions"><button type="button" className="button button--ghost" onClick={() => void copy(exportJson(draft), "Endpoint JSON")}><Copy size={13} /> Copy JSON</button><button type="button" className="button button--ghost" onClick={() => void copy(exportMarkdown(draft), "Endpoint Markdown")}><Clipboard size={13} /> Copy Markdown</button><button type="button" className="button button--ghost" onClick={() => downloadText("omnia-model-endpoint.preview.json", exportJson(draft), "application/json")}><Download size={13} /> Download</button></div><pre aria-label="Model endpoint JSON preview">{exportJson(draft)}</pre></div>
          </div>
        ) : null}
      </div>

      <Boundary>{status} Preview only · Renderer-local · No provider request · No durable write. Native capability snapshots, probes, adapter conformance, secret storage, HTTP dispatch, and model discovery remain outside this surface.</Boundary>
    </section>
  );
}
