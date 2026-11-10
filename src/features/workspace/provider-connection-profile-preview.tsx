import {
  Check,
  Clipboard,
  Copy,
  Download,
  FileJson,
  Globe2,
  HardDrive,
  Import,
  Network,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Redo2,
  WandSparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { ProviderView } from "./types";

type ConnectionProtocol = "openai-compatible" | "anthropic-messages" | "gemini-generate" | "custom-http";
type ConnectionEnvironment = "cloud" | "self-hosted" | "loopback" | "lan";
type AuthMode = "opaque-secret" | "api-key-header" | "bearer" | "none";
type NetworkPolicy = "public-https" | "private-grant" | "loopback-only" | "offline";
type DataResidency = "provider-default" | "regional" | "local-only";
type ProfileState = "draft" | "ready" | "needs-review";

type ConnectionProfile = {
  id: string;
  name: string;
  providerId: string;
  providerLabel: string;
  endpoint: string;
  protocol: ConnectionProtocol;
  environment: ConnectionEnvironment;
  authMode: AuthMode;
  networkPolicy: NetworkPolicy;
  dataResidency: DataResidency;
  modelId: string;
  timeoutMs: number;
  maxRetries: number;
  streaming: boolean;
  structuredOutputs: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  credentialRef: string;
  notes: string;
  state: ProfileState;
};

type ProfileHistory = {
  past: ConnectionProfile[][];
  present: ConnectionProfile[];
  future: ConnectionProfile[][];
};

const PROFILE_FORMAT = "omnia.provider-connection-profile.preview.v1";
const PROFILE_LIMIT = 512 * 1024;

const cloneProfiles = (profiles: ConnectionProfile[]): ConnectionProfile[] =>
  profiles.map((profile) => ({ ...profile }));

function protocolForProvider(provider: ProviderView): ConnectionProtocol {
  const normalized = `${provider.providerType} ${provider.kind}`.toLowerCase();
  if (normalized.includes("anthropic")) return "anthropic-messages";
  if (normalized.includes("gemini")) return "gemini-generate";
  if (normalized.includes("custom")) return "custom-http";
  return "openai-compatible";
}

function environmentForProvider(provider: ProviderView): ConnectionEnvironment {
  if (provider.kind === "Local") {
    return provider.endpoint.includes("127.0.0.1") || provider.endpoint.includes("localhost")
      ? "loopback"
      : "self-hosted";
  }
  return "cloud";
}

function networkForEnvironment(environment: ConnectionEnvironment): NetworkPolicy {
  if (environment === "loopback") return "loopback-only";
  if (environment === "lan" || environment === "self-hosted") return "private-grant";
  return "public-https";
}

function profileFromProvider(provider: ProviderView, index: number): ConnectionProfile {
  const model = provider.models[0];
  const environment = environmentForProvider(provider);
  return {
    id: `connection-profile-${provider.id}`,
    name: `${provider.name} · ${environment === "cloud" ? "Cloud" : "Private"}`,
    providerId: provider.id,
    providerLabel: provider.name,
    endpoint: provider.endpoint,
    protocol: protocolForProvider(provider),
    environment,
    authMode: provider.authScheme === "none" ? "none" : "opaque-secret",
    networkPolicy: networkForEnvironment(environment),
    dataResidency: environment === "cloud" ? "provider-default" : "local-only",
    modelId: model?.providerModelId ?? "",
    timeoutMs: 30_000 + index * 5_000,
    maxRetries: 2,
    streaming: true,
    structuredOutputs: model?.capabilities.includes("json") ?? false,
    tools: model?.capabilities.includes("tools") ?? false,
    vision: model?.capabilities.includes("vision") ?? false,
    reasoning: model?.capabilities.includes("reasoning") ?? false,
    credentialRef: provider.credentialState === "present" ? "opaque://credential-ref" : "",
    notes: "Seeded from visible provider metadata. Edit this draft before a future native save.",
    state: provider.source === "native" && provider.state === "connected" ? "ready" : "needs-review",
  };
}

function fallbackProfile(): ConnectionProfile {
  return {
    id: "connection-profile-new",
    name: "New connection profile",
    providerId: "unassigned",
    providerLabel: "Unassigned provider",
    endpoint: "https://api.example.com/v1",
    protocol: "openai-compatible",
    environment: "cloud",
    authMode: "opaque-secret",
    networkPolicy: "public-https",
    dataResidency: "provider-default",
    modelId: "",
    timeoutMs: 30_000,
    maxRetries: 2,
    streaming: true,
    structuredOutputs: true,
    tools: true,
    vision: false,
    reasoning: false,
    credentialRef: "",
    notes: "Renderer-local draft. Credential values are intentionally never entered here.",
    state: "draft",
  };
}

function initialProfiles(providers: ProviderView[]): ConnectionProfile[] {
  return providers.length > 0 ? providers.map(profileFromProvider) : [fallbackProfile()];
}

function profileStatus(profile: ConnectionProfile): { label: string; tone: "ready" | "warning" | "draft" } {
  if (profile.state === "ready") return { label: "Ready preview", tone: "ready" };
  if (profile.state === "needs-review") return { label: "Needs review", tone: "warning" };
  return { label: "Draft", tone: "draft" };
}

function preflight(profile: ConnectionProfile): string[] {
  const warnings: string[] = [];
  try {
    const url = new URL(profile.endpoint);
    if (profile.environment === "cloud" && url.protocol !== "https:") {
      warnings.push("Cloud endpoints should use HTTPS.");
    }
    if (profile.environment === "loopback" && !["localhost", "127.0.0.1", "::1"].some((host) => url.hostname === host)) {
      warnings.push("Loopback mode expects localhost, 127.0.0.1, or ::1.");
    }
  } catch {
    warnings.push("Endpoint is not a valid absolute URL.");
  }
  if (profile.authMode !== "none" && !profile.credentialRef.trim()) {
    warnings.push("No opaque credential reference is attached yet.");
  }
  if (profile.networkPolicy === "private-grant" && profile.environment === "cloud") {
    warnings.push("Private-network grant is unusual for a cloud profile; review the destination.");
  }
  if (!profile.modelId.trim()) warnings.push("Model ID is still automatic / undiscovered.");
  if (profile.timeoutMs < 2_000) warnings.push("Timeout below 2 seconds may be too aggressive for streaming.");
  return warnings;
}

function exportJson(profiles: ConnectionProfile[]): string {
  return JSON.stringify(
    {
      format: PROFILE_FORMAT,
      scope: "renderer-session",
      exportedAt: new Date().toISOString(),
      profiles: profiles.map(({ credentialRef: _credentialRef, ...profile }) => ({
        ...profile,
        credentialRef: profile.providerId === "unassigned" ? "" : "opaque://redacted-ref",
      })),
      boundary: ["Preview only", "Renderer-local", "No durable write", "No provider request"],
    },
    null,
    2,
  );
}

function exportMarkdown(profiles: ConnectionProfile[]): string {
  return [
    "# Omnia provider connection profiles (preview)",
    "",
    "> Preview only · Renderer-local · No durable write · No provider request",
    "",
    ...profiles.flatMap((profile) => {
      const warnings = preflight(profile);
      return [
        `## ${profile.name}`,
        `- Provider: ${profile.providerLabel}`,
        `- Endpoint: ${profile.endpoint}`,
        `- Protocol: ${profile.protocol}`,
        `- Environment: ${profile.environment}`,
        `- Network policy: ${profile.networkPolicy}`,
        `- Model: ${profile.modelId || "Automatic / undiscovered"}`,
        `- State: ${profileStatus(profile).label}`,
        `- Preflight: ${warnings.length === 0 ? "No local warnings" : warnings.join(" ")}`,
        "",
      ];
    }),
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

export function ProviderConnectionProfilePreview({ providers }: { providers: ProviderView[] }) {
  const [history, setHistory] = useState<ProfileHistory>(() => {
    const profiles = initialProfiles(providers);
    return { past: [], present: profiles, future: [] };
  });
  const [selectedId, setSelectedId] = useState(() => history.present[0]?.id ?? "connection-profile-new");
  const [query, setQuery] = useState("");
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [status, setStatus] = useState("Profiles are renderer-local snapshots; native provider settings are unchanged.");
  const profiles = history.present;
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0] ?? null;
  const selectedWarnings = selected ? preflight(selected) : [];
  const visibleProfiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return profiles;
    return profiles.filter((profile) => `${profile.name} ${profile.providerLabel} ${profile.endpoint} ${profile.modelId}`.toLowerCase().includes(normalized));
  }, [profiles, query]);

  const commit = (nextProfiles: ConnectionProfile[], message: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneProfiles(current.present)],
      present: cloneProfiles(nextProfiles),
      future: [],
    }));
    setStatus(message);
  };

  const updateSelected = (patch: Partial<ConnectionProfile>) => {
    if (!selected) return;
    commit(profiles.map((profile) => profile.id === selected.id ? { ...profile, ...patch, state: "draft" } : profile), "Profile draft changed in this renderer session.");
  };

  const addProfile = () => {
    const base = selected ? { ...selected } : fallbackProfile();
    const id = `connection-profile-${Date.now()}`;
    const next = { ...base, id, name: `${base.name} copy`, state: "draft" as const, notes: "Duplicated renderer-local profile. Review endpoint and permissions before a future native save." };
    commit([next, ...profiles], "Duplicated a profile in the renderer preview.");
    setSelectedId(id);
  };

  const removeSelected = () => {
    if (!selected || profiles.length <= 1) return;
    const next = profiles.filter((profile) => profile.id !== selected.id);
    commit(next, `${selected.name} removed from the renderer preview.`);
    setSelectedId(next[0]?.id ?? "connection-profile-new");
  };

  const undo = () => {
    setHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return { past: current.past.slice(0, -1), present: cloneProfiles(snapshot), future: [cloneProfiles(current.present), ...current.future] };
    });
    setStatus("Undid the last profile preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return { past: [...current.past, cloneProfiles(current.present)], present: cloneProfiles(snapshot), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next profile preview change.");
  };

  const reset = () => {
    const next = initialProfiles(providers);
    commit(next, "Provider connection profile preview reset to visible provider defaults.");
    setSelectedId(next[0]?.id ?? "connection-profile-new");
  };

  const validate = () => {
    if (!selected) return;
    const warnings = preflight(selected);
    updateSelected({ state: warnings.length === 0 ? "ready" : "needs-review" });
    setStatus(warnings.length === 0
      ? "Local preflight passed. No provider request was sent."
      : `${warnings.length} local review item${warnings.length === 1 ? "" : "s"} found. No provider request was sent.`);
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

  const importProfiles = () => {
    if (importText.length > PROFILE_LIMIT) {
      setStatus("Import rejected: profile bundle is larger than 512 KB.");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(importText.replace(/^\uFEFF/, ""));
      const records = parsed && typeof parsed === "object" && "profiles" in parsed && Array.isArray(parsed.profiles)
        ? parsed.profiles
        : Array.isArray(parsed) ? parsed : [];
      const normalized = records.filter((record): record is Partial<ConnectionProfile> => Boolean(record && typeof record === "object" && "name" in record && "endpoint" in record)).map((record, index) => ({
        ...fallbackProfile(),
        ...record,
        id: typeof record.id === "string" ? record.id : `connection-profile-import-${Date.now()}-${index}`,
        name: String(record.name),
        endpoint: String(record.endpoint),
        providerLabel: typeof record.providerLabel === "string" ? record.providerLabel : "Imported provider",
        credentialRef: "",
        state: "draft" as const,
      }));
      if (normalized.length === 0) throw new Error("No profile records found.");
      commit(normalized, `${normalized.length} profile${normalized.length === 1 ? "" : "s"} staged in the renderer preview.`);
      setSelectedId(normalized[0]!.id);
      setImportText("");
      setShowImport(false);
    } catch {
      setStatus("Import rejected: expected a valid Omnia profile bundle or an array of profile records.");
    }
  };

  const profileState = selected ? profileStatus(selected) : null;

  return (
    <section className="provider-profile-preview" aria-labelledby="provider-profile-preview-title">
      <header className="provider-profile-preview__header">
        <span className="provider-profile-preview__icon"><SlidersHorizontal size={18} /></span>
        <span>
          <span className="eyebrow">Renderer-local profile lab</span>
          <h2 id="provider-profile-preview-title">Connection profiles</h2>
          <p>Shape reusable provider routes without exposing credentials or starting a live request.</p>
        </span>
        <span className="provider-profile-preview__badge"><ShieldCheck size={13} /> Preview only</span>
      </header>

      <div className="provider-profile-preview__stats" aria-label="Connection profile preview metrics">
        <span><strong>{profiles.length}</strong><small>Profiles</small></span>
        <span><strong>{profiles.filter((profile) => profile.state === "ready").length}</strong><small>Ready preview</small></span>
        <span><strong>{profiles.filter((profile) => profile.networkPolicy !== "public-https").length}</strong><small>Private policies</small></span>
        <span><strong>0</strong><small>Secrets in renderer</small></span>
      </div>

      <div className="provider-profile-preview__toolbar">
        <label className="provider-profile-preview__search"><Globe2 size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter profiles, providers, models" aria-label="Filter connection profiles" />{query ? <button type="button" aria-label="Clear profile filter" onClick={() => setQuery("")}><X size={13} /></button> : null}</label>
        <button type="button" className="button button--secondary" onClick={addProfile}><Plus size={14} /> Duplicate profile</button>
        <button type="button" className="button button--ghost" onClick={() => setShowImport((value) => !value)} aria-expanded={showImport} aria-controls="provider-profile-import"><Import size={14} /> Import</button>
      </div>

      {showImport ? (
        <div className="provider-profile-preview__import" id="provider-profile-import">
          <label><span>Paste a profile bundle <small>JSON · max 512 KB</small></span><textarea value={importText} onChange={(event) => setImportText(event.target.value)} rows={5} placeholder='{"profiles":[{"name":"Local coding","endpoint":"http://127.0.0.1:11434/v1"}]}' /></label>
          <div><button type="button" className="button button--secondary" onClick={importProfiles} disabled={!importText.trim()}><FileJson size={14} /> Stage import</button><button type="button" className="button button--ghost" onClick={() => { setImportText(""); setShowImport(false); }}><X size={14} /> Close</button></div>
        </div>
      ) : null}

      <div className="provider-profile-preview__layout">
        <aside className="provider-profile-preview__list" aria-label="Connection profile list">
          {visibleProfiles.length > 0 ? visibleProfiles.map((profile) => {
            const state = profileStatus(profile);
            return <button type="button" key={profile.id} className={profile.id === selected?.id ? "provider-profile-card provider-profile-card--active" : "provider-profile-card"} onClick={() => setSelectedId(profile.id)} aria-pressed={profile.id === selected?.id}>
              <span className="provider-profile-card__mark"><Network size={15} /></span>
              <span><strong>{profile.name}</strong><small>{profile.providerLabel} · {profile.environment}</small></span>
              <em className={`provider-profile-card__state provider-profile-card__state--${state.tone}`}>{state.label}</em>
            </button>;
          }) : <div className="provider-profile-preview__empty"><HardDrive size={20} /><strong>No matching profiles</strong><small>Clear the filter or duplicate a profile.</small></div>}
        </aside>

        <div className="provider-profile-preview__editor">
          {selected && profileState ? <>
            <header className="provider-profile-preview__editor-header">
              <div><span className="eyebrow">{selected.providerLabel}</span><h3>{selected.name}</h3><p>{selected.id} · credentials stay opaque</p></div>
              <span className={`provider-profile-preview__state provider-profile-preview__state--${profileState.tone}`}>{profileState.label}</span>
            </header>

            <div className="provider-profile-preview__form">
              <label><span>Profile name</span><input value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
              <label><span>Provider label</span><input value={selected.providerLabel} onChange={(event) => updateSelected({ providerLabel: event.target.value })} /></label>
              <label className="provider-profile-preview__field--wide"><span>Base URL <small>Preview string only</small></span><input value={selected.endpoint} onChange={(event) => updateSelected({ endpoint: event.target.value })} spellCheck={false} /></label>
              <label><span>Protocol</span><select value={selected.protocol} onChange={(event) => updateSelected({ protocol: event.target.value as ConnectionProtocol })}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic-messages">Anthropic Messages</option><option value="gemini-generate">Gemini Generate</option><option value="custom-http">Custom HTTP (planned)</option></select></label>
              <label><span>Environment</span><select value={selected.environment} onChange={(event) => { const environment = event.target.value as ConnectionEnvironment; updateSelected({ environment, networkPolicy: networkForEnvironment(environment) }); }}><option value="cloud">Cloud</option><option value="self-hosted">Self-hosted</option><option value="loopback">Loopback</option><option value="lan">LAN</option></select></label>
              <label><span>Auth mode</span><select value={selected.authMode} onChange={(event) => updateSelected({ authMode: event.target.value as AuthMode })}><option value="opaque-secret">Opaque secret ref</option><option value="api-key-header">API key header</option><option value="bearer">Bearer token</option><option value="none">No authentication</option></select></label>
              <label><span>Network policy</span><select value={selected.networkPolicy} onChange={(event) => updateSelected({ networkPolicy: event.target.value as NetworkPolicy })}><option value="public-https">Public HTTPS</option><option value="private-grant">Private network grant</option><option value="loopback-only">Loopback only</option><option value="offline">Offline / no egress</option></select></label>
              <label><span>Data residency</span><select value={selected.dataResidency} onChange={(event) => updateSelected({ dataResidency: event.target.value as DataResidency })}><option value="provider-default">Provider default</option><option value="regional">Regional route</option><option value="local-only">Local only</option></select></label>
              <label><span>Model ID hint</span><input value={selected.modelId} onChange={(event) => updateSelected({ modelId: event.target.value })} placeholder="automatic / undiscovered" /></label>
            </div>

            <details className="provider-profile-preview__advanced">
              <summary><span><strong>Advanced request profile</strong><small>Timeouts, retries, capability declarations, and safe metadata</small></span><SlidersHorizontal size={15} /></summary>
              <div className="provider-profile-preview__advanced-grid">
                <label><span>Timeout (ms)</span><input type="number" min={500} max={300000} step={500} value={selected.timeoutMs} onChange={(event) => updateSelected({ timeoutMs: Number(event.target.value) || 0 })} /></label>
                <label><span>Max retries</span><input type="number" min={0} max={8} value={selected.maxRetries} onChange={(event) => updateSelected({ maxRetries: Number(event.target.value) || 0 })} /></label>
                <label className="provider-profile-preview__toggle"><input type="checkbox" checked={selected.streaming} onChange={(event) => updateSelected({ streaming: event.target.checked })} /><span><strong>Streaming</strong><small>Show incremental text events</small></span></label>
                <label className="provider-profile-preview__toggle"><input type="checkbox" checked={selected.structuredOutputs} onChange={(event) => updateSelected({ structuredOutputs: event.target.checked })} /><span><strong>Structured output</strong><small>Expose JSON/schema route</small></span></label>
                <label className="provider-profile-preview__toggle"><input type="checkbox" checked={selected.tools} onChange={(event) => updateSelected({ tools: event.target.checked })} /><span><strong>Tools</strong><small>Capability declaration only</small></span></label>
                <label className="provider-profile-preview__toggle"><input type="checkbox" checked={selected.vision} onChange={(event) => updateSelected({ vision: event.target.checked })} /><span><strong>Vision</strong><small>Capability declaration only</small></span></label>
                <label className="provider-profile-preview__toggle"><input type="checkbox" checked={selected.reasoning} onChange={(event) => updateSelected({ reasoning: event.target.checked })} /><span><strong>Reasoning</strong><small>Capability declaration only</small></span></label>
                <label className="provider-profile-preview__field--wide"><span>Opaque credential reference <small>No secret value is accepted</small></span><input value={selected.credentialRef} onChange={(event) => updateSelected({ credentialRef: event.target.value.replace(/\s/g, "") })} placeholder="opaque://credential-ref" /></label>
                <label className="provider-profile-preview__field--wide"><span>Notes</span><textarea value={selected.notes} onChange={(event) => updateSelected({ notes: event.target.value })} rows={3} /></label>
              </div>
            </details>

            <div className="provider-profile-preview__preflight" role="status" aria-live="polite">
              <div><span className="provider-profile-preview__preflight-icon"><WandSparkles size={15} /></span><span><strong>Local preflight</strong><small>Checks shape and policy only; no endpoint request is sent.</small></span></div>
              {selectedWarnings.length === 0 ? <p className="provider-profile-preview__preflight-ok"><Check size={14} /> No local review items.</p> : <ul>{selectedWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            </div>

            <div className="provider-profile-preview__actions">
              <span className="provider-profile-preview__history" role="toolbar" aria-label="Connection profile history"><button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo connection profile change"><Undo2 size={13} /> Undo</button><button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo connection profile change"><Redo2 size={13} /> Redo</button><button type="button" className="button button--ghost" onClick={reset} aria-label="Reset connection profiles"><RotateCcw size={13} /> Reset</button></span>
              <span><button type="button" className="button button--secondary" onClick={validate}><ShieldCheck size={14} /> Run local preflight</button><button type="button" className="button button--danger-ghost" onClick={removeSelected} disabled={profiles.length <= 1}><Trash2 size={14} /> Remove</button></span>
            </div>

            <div className="provider-profile-preview__export"><span><strong>Portable preview</strong><small>Secrets, raw prompts, and native receipts are excluded.</small></span><span><button type="button" className="button button--ghost" onClick={() => void copy(exportJson(profiles), "Profile JSON")}><Copy size={13} /> Copy JSON</button><button type="button" className="button button--ghost" onClick={() => void copy(exportMarkdown(profiles), "Profile Markdown")}><Clipboard size={13} /> Copy Markdown</button><button type="button" className="button button--ghost" onClick={() => downloadText("omnia-provider-profiles.preview.json", exportJson(profiles), "application/json")}><Download size={13} /> Download</button></span></div>
          </> : <div className="provider-profile-preview__empty"><HardDrive size={22} /><h3>Select a profile</h3><p>Choose a connection draft to inspect its route and policy.</p></div>}
        </div>
      </div>

      <p className="provider-profile-preview__boundary"><ShieldCheck size={14} /> {status} Preview only · Renderer-local · No provider request · No durable write. Native credential storage, provider discovery, HTTP probes, durable profile persistence, and model dispatch remain outside this renderer preview.</p>
    </section>
  );
}
