import {
  Check,
  Clipboard,
  Copy,
  Download,
  FileJson,
  Globe2,
  HardDrive,
  Import,
  Layers3,
  Network,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type MediaEndpointMode = "image" | "video" | "audio";
export type MediaEndpointProtocol = "openai-compatible" | "custom-http" | "native-preview";
export type MediaEndpointEnvironment = "cloud" | "self-hosted" | "loopback" | "offline";
export type MediaEndpointAuthMode = "opaque-secret" | "api-key-header" | "bearer" | "none";
export type MediaEndpointProfileState = "draft" | "ready" | "needs-review";
export type MediaEndpointCostPolicy = "unknown" | "metered" | "local";

export type MediaEndpointProfile = {
  id: string;
  name: string;
  providerLabel: string;
  endpoint: string;
  protocol: MediaEndpointProtocol;
  environment: MediaEndpointEnvironment;
  authMode: MediaEndpointAuthMode;
  credentialRef: string;
  region: string;
  fallbackProfileId: string;
  imageModel: string;
  videoModel: string;
  audioModel: string;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  streaming: boolean;
  batch: boolean;
  timeoutMs: number;
  maxRetries: number;
  costPolicy: MediaEndpointCostPolicy;
  notes: string;
  state: MediaEndpointProfileState;
};

export const MEDIA_ENDPOINT_PROFILE_FORMAT = "omnia.media-endpoint-profiles.preview.v1" as const;
const PROFILE_IMPORT_LIMIT = 512 * 1024;

export const DEFAULT_MEDIA_ENDPOINT_PROFILES: readonly MediaEndpointProfile[] = [
  {
    id: "omnia-preview",
    name: "Omnia preview route",
    providerLabel: "Renderer rehearsal",
    endpoint: "preview://not-connected",
    protocol: "native-preview",
    environment: "offline",
    authMode: "none",
    credentialRef: "",
    region: "auto",
    fallbackProfileId: "",
    imageModel: "omnia-image-preview",
    videoModel: "omnia-motion-preview",
    audioModel: "omnia-voice-preview",
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: true,
    streaming: true,
    batch: false,
    timeoutMs: 30_000,
    maxRetries: 0,
    costPolicy: "unknown",
    notes: "Safe rehearsal route. No request leaves the renderer and no media bytes are produced.",
    state: "draft",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible gateway",
    providerLabel: "User-configured gateway",
    endpoint: "https://your-gateway.example/v1",
    protocol: "openai-compatible",
    environment: "cloud",
    authMode: "opaque-secret",
    credentialRef: "",
    region: "us-east",
    fallbackProfileId: "local-gateway",
    imageModel: "image-model-id",
    videoModel: "video-model-id",
    audioModel: "audio-model-id",
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: true,
    streaming: true,
    batch: true,
    timeoutMs: 60_000,
    maxRetries: 2,
    costPolicy: "metered",
    notes: "Shape a future cloud route without entering a secret in the renderer.",
    state: "needs-review",
  },
  {
    id: "local-gateway",
    name: "Local model gateway",
    providerLabel: "Self-hosted runtime",
    endpoint: "http://127.0.0.1:8000/v1",
    protocol: "openai-compatible",
    environment: "loopback",
    authMode: "none",
    credentialRef: "",
    region: "local",
    fallbackProfileId: "omnia-preview",
    imageModel: "local-image-model",
    videoModel: "local-video-model",
    audioModel: "local-audio-model",
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: true,
    streaming: true,
    batch: false,
    timeoutMs: 90_000,
    maxRetries: 1,
    costPolicy: "local",
    notes: "Loopback route for a future self-hosted media runtime.",
    state: "needs-review",
  },
];

type ProfileFilter = "all" | MediaEndpointProfileState;
type ExportFormat = "json" | "markdown";
type ProfileHistory = {
  past: MediaEndpointProfile[][];
  present: MediaEndpointProfile[];
  future: MediaEndpointProfile[][];
};

export type MediaEndpointProfileStudioProps = {
  selectedProfileId?: string;
  onApplyProfile?: (profile: MediaEndpointProfile) => void;
};

const cloneProfiles = (profiles: readonly MediaEndpointProfile[]): MediaEndpointProfile[] =>
  profiles.map((profile) => ({ ...profile }));

function profileLabel(state: MediaEndpointProfileState): string {
  if (state === "ready") return "Ready preview";
  if (state === "needs-review") return "Needs review";
  return "Draft";
}

function profileTone(state: MediaEndpointProfileState): "ready" | "warning" | "draft" {
  if (state === "ready") return "ready";
  if (state === "needs-review") return "warning";
  return "draft";
}

export function preflightMediaEndpointProfile(profile: MediaEndpointProfile): string[] {
  const warnings: string[] = [];
  if (profile.environment === "offline") {
    if (!profile.endpoint.startsWith("preview://")) warnings.push("Offline mode expects a preview or non-network route.");
  } else {
    try {
      const url = new URL(profile.endpoint);
      if (profile.environment === "cloud" && url.protocol !== "https:") warnings.push("Cloud endpoints should use HTTPS.");
      if (profile.environment === "loopback" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        warnings.push("Loopback mode expects localhost, 127.0.0.1, or ::1.");
      }
    } catch {
      warnings.push("Endpoint is not a valid absolute URL.");
    }
  }
  if (profile.authMode !== "none" && !profile.credentialRef.trim()) warnings.push("No opaque credential reference is attached yet.");
  if (!profile.supportsImage && !profile.supportsVideo && !profile.supportsAudio) warnings.push("Enable at least one media capability.");
  if (profile.supportsImage && !profile.imageModel.trim()) warnings.push("Image capability has no model hint.");
  if (profile.supportsVideo && !profile.videoModel.trim()) warnings.push("Video capability has no model hint.");
  if (profile.supportsAudio && !profile.audioModel.trim()) warnings.push("Audio capability has no model hint.");
  if (profile.timeoutMs < 2_000) warnings.push("Timeout below 2 seconds may be too aggressive for media jobs.");
  if (profile.maxRetries > 8) warnings.push("Retry count is above the preview safety recommendation of 8.");
  return warnings;
}

export function exportMediaEndpointProfilesJson(profiles: readonly MediaEndpointProfile[]): string {
  return JSON.stringify({
    format: MEDIA_ENDPOINT_PROFILE_FORMAT,
    scope: "renderer-session",
    profiles: profiles.map((profile) => ({
      ...profile,
      credentialRef: profile.credentialRef ? "opaque://redacted-ref" : "",
    })),
    boundary: ["Preview only", "Renderer-local", "No durable write", "No provider request"],
  }, null, 2);
}

export function exportMediaEndpointProfilesMarkdown(profiles: readonly MediaEndpointProfile[]): string {
  return [
    "# Omnia media endpoint profiles (preview)",
    "",
    "> Preview only · Renderer-local · No durable write · No provider request",
    "",
    ...profiles.flatMap((profile) => [
      `## ${profile.name}`,
      `- Provider: ${profile.providerLabel}`,
      `- Endpoint: ${profile.endpoint}`,
      `- Environment: ${profile.environment}`,
      `- Region: ${profile.region}`,
      `- Models: image=${profile.imageModel || "none"}, video=${profile.videoModel || "none"}, audio=${profile.audioModel || "none"}`,
      `- Capabilities: ${[profile.supportsImage && "image", profile.supportsVideo && "video", profile.supportsAudio && "audio"].filter(Boolean).join(", ") || "none"}`,
      `- State: ${profileLabel(profile.state)}`,
      `- Preflight: ${preflightMediaEndpointProfile(profile).join(" ") || "No local warnings"}`,
      "",
    ]),
  ].join("\n");
}

function downloadProfileExport(filename: string, content: string, mime: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined") return false;
  const href = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
  return true;
}

function fallbackProfile(): MediaEndpointProfile {
  return {
    ...DEFAULT_MEDIA_ENDPOINT_PROFILES[0]!,
    id: "media-profile-new",
    name: "New media endpoint profile",
    providerLabel: "Unassigned provider",
    endpoint: "https://api.example.com/v1",
    protocol: "openai-compatible",
    environment: "cloud",
    authMode: "opaque-secret",
    notes: "Renderer-local draft. Credentials are intentionally never entered here.",
    state: "draft",
  };
}

export function MediaEndpointProfileStudio({ selectedProfileId, onApplyProfile }: MediaEndpointProfileStudioProps) {
  const [history, setHistory] = useState<ProfileHistory>(() => ({
    past: [],
    present: cloneProfiles(DEFAULT_MEDIA_ENDPOINT_PROFILES),
    future: [],
  }));
  const [activeId, setActiveId] = useState(selectedProfileId ?? DEFAULT_MEDIA_ENDPOINT_PROFILES[0]!.id);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProfileFilter>("all");
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [importText, setImportText] = useState("");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [status, setStatus] = useState("Profiles are renderer-local snapshots; native provider settings are unchanged.");

  const profiles = history.present;
  const selected = profiles.find((profile) => profile.id === activeId) ?? profiles[0] ?? null;
  const selectedWarnings = selected ? preflightMediaEndpointProfile(selected) : [];

  useEffect(() => {
    if (selectedProfileId && profiles.some((profile) => profile.id === selectedProfileId)) setActiveId(selectedProfileId);
  }, [profiles, selectedProfileId]);

  const visibleProfiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return profiles.filter((profile) => {
      const matchesFilter = filter === "all" || profile.state === filter;
      const matchesQuery = !normalized || `${profile.name} ${profile.providerLabel} ${profile.endpoint} ${profile.imageModel} ${profile.videoModel} ${profile.audioModel}`.toLowerCase().includes(normalized);
      return matchesFilter && matchesQuery;
    });
  }, [filter, profiles, query]);

  const commit = (nextProfiles: readonly MediaEndpointProfile[], message: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneProfiles(current.present)],
      present: cloneProfiles(nextProfiles),
      future: [],
    }));
    setStatus(message);
  };

  const updateSelected = (patch: Partial<MediaEndpointProfile>) => {
    if (!selected) return;
    commit(profiles.map((profile) => profile.id === selected.id ? { ...profile, ...patch, state: "draft" } : profile), "Profile draft changed in this renderer session.");
  };

  const addProfile = () => {
    const base = selected ? { ...selected } : fallbackProfile();
    const id = `media-profile-${Date.now()}`;
    const next = { ...base, id, name: `${base.name} copy`, state: "draft" as const, notes: "Duplicated renderer-local profile. Review route and capabilities before a future native save." };
    commit([next, ...profiles], "Duplicated a media endpoint profile in the renderer preview.");
    setActiveId(id);
  };

  const addNewProfile = () => {
    const next = fallbackProfile();
    const id = `media-profile-${Date.now()}`;
    commit([{ ...next, id }, ...profiles], "Created a new media endpoint profile in the renderer preview.");
    setActiveId(id);
  };

  const removeSelected = () => {
    if (!selected || profiles.length <= 1) return;
    const next = profiles.filter((profile) => profile.id !== selected.id);
    commit(next, `${selected.name} removed from the renderer preview.`);
    setActiveId(next[0]?.id ?? "omnia-preview");
  };

  const undo = () => {
    setHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return { past: current.past.slice(0, -1), present: cloneProfiles(snapshot), future: [cloneProfiles(current.present), ...current.future] };
    });
    setStatus("Undid the last renderer-local profile change.");
  };

  const redo = () => {
    setHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return { past: [...current.past, cloneProfiles(current.present)], present: cloneProfiles(snapshot), future: current.future.slice(1) };
    });
    setStatus("Redid the next renderer-local profile change.");
  };

  const reset = () => {
    commit(DEFAULT_MEDIA_ENDPOINT_PROFILES, "Media endpoint profiles reset to renderer-local defaults.");
    setActiveId(selectedProfileId ?? "omnia-preview");
  };

  const validate = () => {
    if (!selected) return;
    const warnings = preflightMediaEndpointProfile(selected);
    updateSelected({ state: warnings.length === 0 ? "ready" : "needs-review" });
    setStatus(warnings.length === 0 ? "Local preflight passed. No provider request was sent." : `${warnings.length} local review item${warnings.length === 1 ? "" : "s"} found. No provider request was sent.`);
  };

  const importProfiles = () => {
    if (importText.length > PROFILE_IMPORT_LIMIT) {
      setStatus("Import rejected: profile bundle is larger than 512 KB.");
      return;
    }
    try {
      const parsed: unknown = JSON.parse(importText.replace(/^\uFEFF/, ""));
      const records = parsed && typeof parsed === "object" && "profiles" in parsed && Array.isArray(parsed.profiles)
        ? parsed.profiles
        : Array.isArray(parsed) ? parsed : [];
      const normalized = records.filter((record): record is Partial<MediaEndpointProfile> => Boolean(record && typeof record === "object" && "name" in record && "endpoint" in record)).map((record, index) => ({
        ...fallbackProfile(),
        ...record,
        id: typeof record.id === "string" ? record.id : `media-profile-import-${Date.now()}-${index}`,
        name: String(record.name),
        endpoint: String(record.endpoint),
        providerLabel: typeof record.providerLabel === "string" ? record.providerLabel : "Imported provider",
        credentialRef: "",
        state: "draft" as const,
      }));
      if (normalized.length === 0) throw new Error("No profile records found.");
      commit(normalized, `${normalized.length} media profile${normalized.length === 1 ? "" : "s"} staged in the renderer preview.`);
      setActiveId(normalized[0]!.id);
      setImportText("");
      setShowImport(false);
    } catch {
      setStatus("Import rejected: expected a valid Omnia media profile bundle or an array of profile records.");
    }
  };

  const exportPayload = exportFormat === "json" ? exportMediaEndpointProfilesJson(profiles) : exportMediaEndpointProfilesMarkdown(profiles);

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
    <section className="media-endpoint-profile-studio" aria-labelledby="media-endpoint-profile-studio-title">
      <header className="media-endpoint-profile-studio__header">
        <span className="media-endpoint-profile-studio__icon"><Network size={16} /></span>
        <span>
          <span className="eyebrow">Endpoint profile studio</span>
          <h3 id="media-endpoint-profile-studio-title">Routes, models, and capabilities</h3>
          <p>Keep media routes reusable and inspectable before a future native provider handoff.</p>
        </span>
        <span className="media-endpoint-profile-studio__badge"><ShieldCheck size={12} /> Preview only</span>
      </header>

      <div className="media-endpoint-profile-studio__stats" aria-label="Media endpoint profile metrics">
        <span><strong>{profiles.length}</strong><small>Profiles</small></span>
        <span><strong>{profiles.filter((profile) => profile.state === "ready").length}</strong><small>Ready preview</small></span>
        <span><strong>{profiles.filter((profile) => profile.supportsVideo).length}</strong><small>Video capable</small></span>
        <span><strong>0</strong><small>Secrets in renderer</small></span>
      </div>

      <div className="media-endpoint-profile-studio__toolbar">
        <label className="media-endpoint-profile-studio__search"><Globe2 size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter profiles, providers, models" aria-label="Filter media endpoint profiles" />{query ? <button type="button" aria-label="Clear media profile filter" onClick={() => setQuery("")}><X size={12} /></button> : null}</label>
        <label className="media-endpoint-profile-studio__filter"><span>State</span><select aria-label="Filter media endpoint profile state" value={filter} onChange={(event) => setFilter(event.target.value as ProfileFilter)}><option value="all">All</option><option value="ready">Ready</option><option value="needs-review">Needs review</option><option value="draft">Draft</option></select></label>
        <button type="button" className="button button--secondary" onClick={addNewProfile}><Plus size={13} /> New profile</button>
        <button type="button" className="button button--ghost" onClick={addProfile}><Copy size={13} /> Duplicate</button>
        <button type="button" className="button button--ghost" onClick={() => setShowImport((value) => !value)} aria-expanded={showImport}><Import size={13} /> Import</button>
      </div>

      {showImport ? <div className="media-endpoint-profile-studio__import" id="media-endpoint-profile-import">
        <label><span>Paste a profile bundle <small>JSON · max 512 KB</small></span><textarea value={importText} onChange={(event) => setImportText(event.target.value)} rows={4} placeholder='{"profiles":[{"name":"Local video","endpoint":"http://127.0.0.1:8000/v1"}]}' /></label>
        <div><button type="button" className="button button--secondary" onClick={importProfiles} disabled={!importText.trim()}><FileJson size={13} /> Stage import</button><button type="button" className="button button--ghost" onClick={() => { setImportText(""); setShowImport(false); }}><X size={13} /> Close</button></div>
      </div> : null}

      <div className="media-endpoint-profile-studio__layout">
        <aside className="media-endpoint-profile-studio__list" aria-label="Media endpoint profile list">
          {visibleProfiles.length > 0 ? visibleProfiles.map((profile) => <button type="button" key={profile.id} className={profile.id === selected?.id ? "media-endpoint-profile-card media-endpoint-profile-card--active" : "media-endpoint-profile-card"} onClick={() => setActiveId(profile.id)} aria-pressed={profile.id === selected?.id}>
            <span className="media-endpoint-profile-card__mark"><Network size={14} /></span>
            <span><strong>{profile.name}</strong><small>{profile.providerLabel} · {profile.environment}</small></span>
            <em className={`media-endpoint-profile-card__state media-endpoint-profile-card__state--${profileTone(profile.state)}`}>{profileLabel(profile.state)}</em>
          </button>) : <div className="media-endpoint-profile-studio__empty"><HardDrive size={18} /><strong>No matching profiles</strong><small>Clear the filter or create a profile.</small></div>}
        </aside>

        <div className="media-endpoint-profile-studio__editor">
          {selected ? <>
            <header className="media-endpoint-profile-studio__editor-header"><div><span className="eyebrow">{selected.providerLabel}</span><h4>{selected.name}</h4><p>{selected.id} · credentials stay opaque</p></div><span className={`media-endpoint-profile-studio__state media-endpoint-profile-studio__state--${profileTone(selected.state)}`}>{profileLabel(selected.state)}</span></header>

            <div className="media-endpoint-profile-studio__form">
              <label><span>Profile name</span><input aria-label="Media profile name" value={selected.name} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
              <label><span>Provider label</span><input aria-label="Media profile provider" value={selected.providerLabel} onChange={(event) => updateSelected({ providerLabel: event.target.value })} /></label>
              <label className="media-endpoint-profile-studio__field--wide"><span>Endpoint URL <small>Preview string only</small></span><input aria-label="Media profile endpoint URL" value={selected.endpoint} onChange={(event) => updateSelected({ endpoint: event.target.value })} spellCheck={false} /></label>
              <label><span>Protocol</span><select aria-label="Media profile protocol" value={selected.protocol} onChange={(event) => updateSelected({ protocol: event.target.value as MediaEndpointProtocol })}><option value="native-preview">Omnia preview</option><option value="openai-compatible">OpenAI-compatible</option><option value="custom-http">Custom HTTP</option></select></label>
              <label><span>Environment</span><select aria-label="Media profile environment" value={selected.environment} onChange={(event) => updateSelected({ environment: event.target.value as MediaEndpointEnvironment })}><option value="cloud">Cloud</option><option value="self-hosted">Self-hosted</option><option value="loopback">Loopback</option><option value="offline">Offline / preview</option></select></label>
              <label><span>Auth mode</span><select aria-label="Media profile auth mode" value={selected.authMode} onChange={(event) => updateSelected({ authMode: event.target.value as MediaEndpointAuthMode })}><option value="opaque-secret">Opaque secret ref</option><option value="api-key-header">API key header</option><option value="bearer">Bearer token</option><option value="none">No authentication</option></select></label>
              <label><span>Region / placement</span><select aria-label="Media profile region" value={selected.region} onChange={(event) => updateSelected({ region: event.target.value })}><option value="auto">Auto</option><option value="us-east">US East</option><option value="us-west">US West</option><option value="eu-west">EU West</option><option value="local">Local machine</option></select></label>
              <label><span>Fallback profile</span><select aria-label="Media profile fallback" value={selected.fallbackProfileId} onChange={(event) => updateSelected({ fallbackProfileId: event.target.value })}><option value="">No fallback</option>{profiles.filter((profile) => profile.id !== selected.id).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
              <label className="media-endpoint-profile-studio__field--wide"><span>Opaque credential reference <small>No secret value is accepted</small></span><input aria-label="Media profile credential reference" value={selected.credentialRef} onChange={(event) => updateSelected({ credentialRef: event.target.value.replace(/\s/g, "") })} placeholder="opaque://credential-ref" /></label>
            </div>

            <details className="media-endpoint-profile-studio__advanced" open>
              <summary><span><strong>Model and capability matrix</strong><small>Separate image, video, and audio routes with explicit feature flags.</small></span><SlidersHorizontal size={14} /></summary>
              <div className="media-endpoint-profile-studio__advanced-grid">
                <label><span>Image model hint</span><input aria-label="Image model hint" value={selected.imageModel} onChange={(event) => updateSelected({ imageModel: event.target.value })} /></label>
                <label><span>Video model hint</span><input aria-label="Video model hint" value={selected.videoModel} onChange={(event) => updateSelected({ videoModel: event.target.value })} /></label>
                <label><span>Audio model hint</span><input aria-label="Audio model hint" value={selected.audioModel} onChange={(event) => updateSelected({ audioModel: event.target.value })} /></label>
                <label><span>Cost policy</span><select aria-label="Media profile cost policy" value={selected.costPolicy} onChange={(event) => updateSelected({ costPolicy: event.target.value as MediaEndpointCostPolicy })}><option value="unknown">Unknown</option><option value="metered">Metered</option><option value="local">Local / self-hosted</option></select></label>
                <label><span>Timeout (ms)</span><input aria-label="Media profile timeout" type="number" min={500} max={300000} step={500} value={selected.timeoutMs} onChange={(event) => updateSelected({ timeoutMs: Number(event.target.value) || 0 })} /></label>
                <label><span>Max retries</span><input aria-label="Media profile retries" type="number" min={0} max={12} value={selected.maxRetries} onChange={(event) => updateSelected({ maxRetries: Number(event.target.value) || 0 })} /></label>
                <label className="media-endpoint-profile-studio__toggle"><input type="checkbox" checked={selected.supportsImage} onChange={(event) => updateSelected({ supportsImage: event.target.checked })} /><span><strong>Supports image</strong><small>Image generation capability declaration</small></span></label>
                <label className="media-endpoint-profile-studio__toggle"><input type="checkbox" checked={selected.supportsVideo} onChange={(event) => updateSelected({ supportsVideo: event.target.checked })} /><span><strong>Supports video</strong><small>Video or storyboard capability declaration</small></span></label>
                <label className="media-endpoint-profile-studio__toggle"><input type="checkbox" checked={selected.supportsAudio} onChange={(event) => updateSelected({ supportsAudio: event.target.checked })} /><span><strong>Supports audio</strong><small>Voice or sound generation capability declaration</small></span></label>
                <label className="media-endpoint-profile-studio__toggle"><input type="checkbox" checked={selected.streaming} onChange={(event) => updateSelected({ streaming: event.target.checked })} /><span><strong>Streaming</strong><small>Future incremental preview updates</small></span></label>
                <label className="media-endpoint-profile-studio__toggle"><input type="checkbox" checked={selected.batch} onChange={(event) => updateSelected({ batch: event.target.checked })} /><span><strong>Batch requests</strong><small>Future multi-variant dispatch hint</small></span></label>
                <label className="media-endpoint-profile-studio__field--wide"><span>Notes</span><textarea aria-label="Media profile notes" value={selected.notes} onChange={(event) => updateSelected({ notes: event.target.value })} rows={3} /></label>
              </div>
            </details>

            <div className="media-endpoint-profile-studio__preflight" role="status" aria-live="polite"><div><span className="media-endpoint-profile-studio__preflight-icon"><ShieldCheck size={14} /></span><span><strong>Local preflight</strong><small>Checks shape and policy only; no endpoint request is sent.</small></span></div>{selectedWarnings.length === 0 ? <p className="media-endpoint-profile-studio__preflight-ok"><Check size={13} /> No local review items.</p> : <ul>{selectedWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div>

            <div className="media-endpoint-profile-studio__actions"><span><button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo media profile change"><Undo2 size={12} /> Undo</button><button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo media profile change"><Redo2 size={12} /> Redo</button><button type="button" className="button button--ghost" onClick={reset} aria-label="Reset media endpoint profiles"><RotateCcw size={12} /> Reset</button></span><span><button type="button" className="button button--secondary" onClick={validate}><ShieldCheck size={13} /> Run preflight</button><button type="button" className="button button--primary" onClick={() => { onApplyProfile?.(selected); setStatus(`Applied ${selected.name} to the media draft; no provider request was sent.`); }}><Layers3 size={13} /> Apply to draft</button><button type="button" className="button button--danger-ghost" onClick={removeSelected} disabled={profiles.length <= 1}><Trash2 size={13} /> Remove</button></span></div>
          </> : <div className="media-endpoint-profile-studio__empty"><HardDrive size={20} /><h4>Select a profile</h4><p>Choose a route draft to inspect its models and policies.</p></div>}
        </div>
      </div>

      <div className="media-endpoint-profile-studio__export"><span><strong>Portable profile bundle</strong><small>Credentials, media bytes, native receipts, and provider responses are excluded.</small></span><span><button type="button" className="button button--ghost" onClick={() => setShowExport((value) => !value)}><FileJson size={12} /> {showExport ? "Hide export" : "Preview export"}</button><button type="button" className="button button--ghost" onClick={() => void copy(exportMediaEndpointProfilesJson(profiles), "Profile JSON")}><Copy size={12} /> Copy JSON</button><button type="button" className="button button--ghost" onClick={() => downloadProfileExport("omnia-media-endpoint-profiles.preview.json", exportMediaEndpointProfilesJson(profiles), "application/json")}><Download size={12} /> Download</button></span></div>
      {showExport ? <div className="media-endpoint-profile-studio__export-preview"><label><span>Format</span><select aria-label="Media endpoint profile export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><pre><code>{exportPayload}</code></pre><p><Clipboard size={12} /> Browser-session export only; no durable profile write occurs.</p></div> : null}

      <p className="media-endpoint-profile-studio__boundary"><ShieldCheck size={13} /> {status} Preview only · Renderer-local · No provider request · No durable write. Secret storage, endpoint discovery, capability probes, dispatch, health, and failover remain native-owned and unverified.</p>
    </section>
  );
}

export default MediaEndpointProfileStudio;
