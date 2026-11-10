import {
  Activity,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  Download,
  Film,
  Image,
  Network,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Waves,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  DEFAULT_MEDIA_ENDPOINT_PROFILES,
  MEDIA_ENDPOINT_PROFILE_FORMAT,
  type MediaEndpointEnvironment,
  type MediaEndpointMode,
  type MediaEndpointProfile,
} from "./media-endpoint-profile-studio";
import "../../styles/media-endpoint-console-preview.css";

type ConsoleMode = MediaEndpointMode | "all";
type EnvironmentFilter = "all" | MediaEndpointEnvironment;

const MODES: readonly { id: ConsoleMode; label: string; icon: typeof Image }[] = [
  { id: "all", label: "All media", icon: Waves },
  { id: "image", label: "Image", icon: Image },
  { id: "video", label: "Video", icon: Film },
  { id: "audio", label: "Audio", icon: AudioLines },
];

const modeCapability: Record<MediaEndpointMode, keyof Pick<MediaEndpointProfile, "supportsImage" | "supportsVideo" | "supportsAudio">> = {
  image: "supportsImage",
  video: "supportsVideo",
  audio: "supportsAudio",
};

const modeModel: Record<MediaEndpointMode, keyof Pick<MediaEndpointProfile, "imageModel" | "videoModel" | "audioModel">> = {
  image: "imageModel",
  video: "videoModel",
  audio: "audioModel",
};

const modeLabel: Record<MediaEndpointMode, string> = { image: "Image", video: "Video", audio: "Audio" };
const environmentLabel: Record<MediaEndpointEnvironment, string> = {
  cloud: "Cloud",
  "self-hosted": "Self-hosted",
  loopback: "Loopback",
  offline: "Offline preview",
};

export function mediaEndpointConsoleExport(profiles: readonly MediaEndpointProfile[]): string {
  return JSON.stringify({
    format: MEDIA_ENDPOINT_PROFILE_FORMAT,
    scope: "renderer-session",
    profiles: profiles.map((profile) => ({ ...profile, credentialRef: profile.credentialRef || profile.authMode !== "none" ? "opaque://redacted-ref" : "" })),
    health: "not-probed",
    boundary: ["Preview only", "Renderer-local", "No durable write", "No provider request"],
  }, null, 2);
}

function modelFor(profile: MediaEndpointProfile, mode: MediaEndpointMode): string {
  return profile[modeModel[mode]] || "No model hint";
}

function supported(profile: MediaEndpointProfile, mode: MediaEndpointMode): boolean {
  return profile[modeCapability[mode]];
}

export function MediaEndpointConsolePreview() {
  const [mode, setMode] = useState<ConsoleMode>("all");
  const [environment, setEnvironment] = useState<EnvironmentFilter>("all");
  const [query, setQuery] = useState("");
  const [declaredOnly, setDeclaredOnly] = useState(false);
  const [activeId, setActiveId] = useState(DEFAULT_MEDIA_ENDPOINT_PROFILES[0]!.id);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState("Endpoint health is unknown until a native probe exists.");

  const filteredProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return DEFAULT_MEDIA_ENDPOINT_PROFILES.filter((profile) => {
      const modeMatch = mode === "all" || supported(profile, mode);
      const environmentMatch = environment === "all" || profile.environment === environment;
      const declaredMatch = !declaredOnly || (mode === "all"
        ? profile.supportsImage || profile.supportsVideo || profile.supportsAudio
        : supported(profile, mode));
      const searchMatch = !needle || `${profile.name} ${profile.providerLabel} ${profile.endpoint} ${profile.imageModel} ${profile.videoModel} ${profile.audioModel}`.toLowerCase().includes(needle);
      return modeMatch && environmentMatch && declaredMatch && searchMatch;
    });
  }, [declaredOnly, environment, mode, query]);

  const activeProfile = filteredProfiles.find((profile) => profile.id === activeId) ?? filteredProfiles[0] ?? null;
  const declarationCount = DEFAULT_MEDIA_ENDPOINT_PROFILES.reduce((count, profile) => count + Number(profile.supportsImage) + Number(profile.supportsVideo) + Number(profile.supportsAudio), 0);

  const exportJson = mediaEndpointConsoleExport(DEFAULT_MEDIA_ENDPOINT_PROFILES);
  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportJson);
      setNotice("Redacted profile bundle copied from this renderer preview.");
    } catch {
      setNotice("Clipboard is unavailable; the bundle remains visible below for manual copy.");
      setExportOpen(true);
    }
  };
  const downloadExport = () => {
    const blobUrl = URL.createObjectURL(new Blob([exportJson], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = "omnia-media-endpoint-console.preview.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    setNotice("Redacted profile bundle downloaded; no native settings were changed.");
  };

  return (
    <section className="media-endpoint-console" aria-labelledby="media-endpoint-console-title">
      <header className="media-endpoint-console__header">
        <span className="media-endpoint-console__mark"><Network size={17} /></span>
        <div>
          <span className="eyebrow">Media routing · console</span>
          <h3 id="media-endpoint-console-title">Endpoint landscape</h3>
          <p>Compare image, video, and audio route declarations before a native capability snapshot is available.</p>
        </div>
        <span className="media-endpoint-console__preview"><ShieldAlert size={12} /> Preview only</span>
      </header>

      <div className="media-endpoint-console__metrics" aria-label="Media endpoint overview">
        <article><strong>{DEFAULT_MEDIA_ENDPOINT_PROFILES.length}</strong><span>Route profiles</span></article>
        <article><strong>{declarationCount}</strong><span>Declared capabilities</span></article>
        <article><strong>0</strong><span>Verified live</span></article>
        <article className="media-endpoint-console__health"><Activity size={14} /><span><strong>Not probed</strong><small>Health unknown</small></span></article>
      </div>

      <nav className="media-endpoint-console__modes" aria-label="Filter media routes by modality">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={mode === id ? "is-active" : ""} aria-pressed={mode === id} onClick={() => setMode(id)}>
            <Icon size={14} /> {label}
            {id !== "all" ? <small>{DEFAULT_MEDIA_ENDPOINT_PROFILES.filter((profile) => supported(profile, id)).length}</small> : null}
          </button>
        ))}
      </nav>

      <div className="media-endpoint-console__filters">
        <label className="media-endpoint-console__search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search providers, routes, models" aria-label="Search media endpoint routes" /></label>
        <label><span>Environment</span><select aria-label="Filter media routes by environment" value={environment} onChange={(event) => setEnvironment(event.target.value as EnvironmentFilter)}>
          <option value="all">All environments</option><option value="cloud">Cloud</option><option value="self-hosted">Self-hosted</option><option value="loopback">Loopback</option><option value="offline">Offline preview</option>
        </select></label>
        <label className="media-endpoint-console__declared"><input type="checkbox" checked={declaredOnly} onChange={(event) => setDeclaredOnly(event.target.checked)} /> Declared for selected modality</label>
        <span className="media-endpoint-console__count">{filteredProfiles.length} of {DEFAULT_MEDIA_ENDPOINT_PROFILES.length} routes</span>
      </div>

      <div className="media-endpoint-console__layout">
        <div className="media-endpoint-console__route-list" role="list" aria-label="Media endpoint route profiles">
          {filteredProfiles.length ? filteredProfiles.map((profile) => (
            <button type="button" key={profile.id} className={`media-endpoint-console__route${profile.id === activeProfile?.id ? " is-selected" : ""}`} aria-pressed={profile.id === activeProfile?.id} onClick={() => setActiveId(profile.id)}>
              <span className="media-endpoint-console__route-icon">{profile.environment === "cloud" ? <Cloud size={14} /> : <Network size={14} />}</span>
              <span className="media-endpoint-console__route-copy"><strong>{profile.name}</strong><small>{profile.providerLabel} · {environmentLabel[profile.environment]}</small><span className="media-endpoint-console__endpoint">{profile.endpoint}</span></span>
              <span className="media-endpoint-console__route-state"><CircleHelp size={13} /> Unverified</span>
              <ChevronRight size={14} />
            </button>
          )) : <div className="media-endpoint-console__empty"><SlidersHorizontal size={17} /><strong>No routes match</strong><small>Change modality, environment, or search terms.</small></div>}
        </div>

        {activeProfile ? <aside className="media-endpoint-console__detail" aria-label={`${activeProfile.name} route details`}>
          <header><span className="eyebrow">Selected route</span><h4>{activeProfile.name}</h4><p>{activeProfile.providerLabel} · {environmentLabel[activeProfile.environment]}</p></header>
          <div className="media-endpoint-console__detail-url"><small>Base endpoint</small><span className="media-endpoint-console__endpoint">{activeProfile.endpoint}</span></div>
          <div className="media-endpoint-console__modality-grid" aria-label="Route modality matrix">
            {(["image", "video", "audio"] as const).map((item) => {
              const Icon = MODES.find((candidate) => candidate.id === item)!.icon;
              const isDeclared = supported(activeProfile, item);
              return <article key={item} className={isDeclared ? "is-declared" : ""}><span><Icon size={13} />{modeLabel[item]}</span><strong>{isDeclared ? "Declared" : "Not declared"}</strong><small>{isDeclared ? modelFor(activeProfile, item) : "No route hint"}</small></article>;
            })}
          </div>
          <dl className="media-endpoint-console__facts"><div><dt>Protocol</dt><dd>{activeProfile.protocol}</dd></div><div><dt>Auth</dt><dd>{activeProfile.authMode === "none" ? "None declared" : "Opaque reference only"}</dd></div><div><dt>Cost</dt><dd>{activeProfile.costPolicy === "metered" ? "Metered · unverified" : activeProfile.costPolicy === "local" ? "Local · unverified" : "Unknown"}</dd></div><div><dt>Fallback</dt><dd>{DEFAULT_MEDIA_ENDPOINT_PROFILES.find((profile) => profile.id === activeProfile.fallbackProfileId)?.name ?? "None"}</dd></div></dl>
          <p className="media-endpoint-console__warning"><ShieldAlert size={13} /> Capability flags and model names are user-authored hints. No live endpoint, authentication, price, or failover behavior has been verified.</p>
        </aside> : null}
      </div>

      <div className="media-endpoint-console__export-bar"><span><strong>Portable route snapshot</strong><small>Credential references are redacted; provider responses and media bytes are excluded.</small></span><div><button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)}>{exportOpen ? "Hide JSON" : "Preview JSON"}</button><button type="button" className="button button--ghost" onClick={() => void copyExport()}><Copy size={12} /> Copy</button><button type="button" className="button button--secondary" onClick={downloadExport}><Download size={12} /> Export</button></div></div>
      {exportOpen ? <pre className="media-endpoint-console__export-preview" aria-label="Redacted media route export"><code>{exportJson}</code></pre> : null}
      <p className="media-endpoint-console__boundary" role="status" aria-live="polite"><Check size={13} /> <span>{notice}</span> <span>Renderer-local · No durable write · No provider request · nativeRuntime: not-tested-by-this-probe</span></p>
    </section>
  );
}

export default MediaEndpointConsolePreview;
