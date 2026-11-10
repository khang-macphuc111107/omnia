import { Check, CircleAlert, Clipboard, Download, Redo2, RotateCcw, Route, Search, ShieldCheck, Sparkles, Undo2, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { resolveAutoModel, selectableModelProfiles } from "./provider-catalog";
import { parseRoutingProfilePreviewImport, type ImportedRoutingProfile } from "./routing-profile-import";
import { ModelRouterPreview } from "./model-router-preview";
import { ModelRoutePresetsPreview } from "./model-route-presets-preview";
import { ModelRouteFitLab } from "./model-route-fit-lab";
import type { ModelRoutePreset } from "./model-route-preset-contract";
import { ProviderFallbackRehearsal } from "./provider-fallback-rehearsal";
import { ProviderRouteComparePreview } from "./provider-route-compare-preview";
import { RoutingInheritancePreview } from "./routing-inheritance-preview";
import { RoleRoutingPreview } from "./role-routing-preview";
import type { ProviderView } from "./types";

export type RoutingPreference = "auto" | "quality" | "balanced" | "local";
export type FallbackConsent = "never" | "same-connection" | "approved-connections";
export type RoutingProfileExportFormat = "json" | "markdown";

const routingPreferences: ReadonlyArray<{
  readonly value: RoutingPreference;
  readonly label: string;
  readonly detail: string;
}> = [
  { value: "auto", label: "Automatic", detail: "Uses the selected automatic route when one is available." },
  { value: "quality", label: "Prefer quality", detail: "Keeps the chosen model explicit; scoring is not wired yet." },
  { value: "balanced", label: "Balanced", detail: "Keeps the chosen model explicit; latency scoring is not wired yet." },
  { value: "local", label: "Local only", detail: "Only local candidates are selectable in this preview." },
];

const fallbackConsent: ReadonlyArray<{
  readonly value: FallbackConsent;
  readonly label: string;
  readonly detail: string;
}> = [
  { value: "never", label: "Never switch", detail: "A failed attempt remains on its selected route." },
  { value: "same-connection", label: "Same connection", detail: "Planned - a same-provider fallback would still require a new attempt." },
  { value: "approved-connections", label: "Approved connections", detail: "Planned - every destination needs explicit data-class approval." },
];

type RoutingPreview = {
  preference: RoutingPreference;
  consent: FallbackConsent;
};

type RoutingHistory = {
  past: RoutingPreview[];
  present: RoutingPreview;
  future: RoutingPreview[];
};

type RoutingProfile = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly preference: RoutingPreference;
  readonly consent: FallbackConsent;
  readonly modelProfileId: string;
  readonly custom?: boolean;
};

type RoutingProfilePreviewExport = {
  readonly preference: RoutingPreference;
  readonly consent: FallbackConsent;
  readonly modelProfileId: string;
  readonly resolvedModel: string;
  readonly savedProfiles: ReadonlyArray<Pick<RoutingProfile, "id" | "name" | "description" | "preference" | "consent" | "modelProfileId" | "custom">>;
};

const DEFAULT_ROUTING_PREVIEW: RoutingPreview = { preference: "auto", consent: "never" };

const builtInRoutingProfiles: readonly RoutingProfile[] = [
  {
    id: "routing-default",
    name: "Automatic",
    description: "Let the current automatic route choose the first available model.",
    preference: "auto",
    consent: "never",
    modelProfileId: "auto",
  },
  {
    id: "routing-quality",
    name: "Quality first",
    description: "Pin the current model while keeping fallback disabled.",
    preference: "quality",
    consent: "never",
    modelProfileId: "auto",
  },
  {
    id: "routing-local",
    name: "Local & private",
    description: "Only expose local candidates in this renderer preview.",
    preference: "local",
    consent: "never",
    modelProfileId: "auto",
  },
];

const cloneRoutingPreview = (value: RoutingPreview): RoutingPreview => ({ ...value });

export function serializeRoutingProfilePreview(
  snapshot: RoutingProfilePreviewExport,
  format: RoutingProfileExportFormat,
): string {
  const boundary = [
    "Renderer-session preview only",
    "No native routing policy was written",
    "No provider fallback was authorized or dispatched",
    "No durable routing receipt was created",
  ];
  const payload = {
    schema: "omnia.routing-profile-preview.v1",
    scope: "renderer-session",
    executionDisposition: "preview-only",
    route: {
      preference: snapshot.preference,
      fallbackConsent: snapshot.consent,
      modelProfileId: snapshot.modelProfileId,
      resolvedModel: snapshot.resolvedModel,
    },
    savedProfiles: snapshot.savedProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      preference: profile.preference,
      fallbackConsent: profile.consent,
      modelProfileId: profile.modelProfileId,
      source: profile.custom ? "renderer-session" : "built-in-preview",
    })),
    boundary,
  };

  if (format === "json") return JSON.stringify(payload, null, 2);

  const profileLines = payload.savedProfiles.length > 0
    ? payload.savedProfiles.map((profile) => `- ${profile.name}: ${profile.preference}, ${profile.fallbackConsent}, ${profile.modelProfileId} (${profile.source})`).join("\n")
    : "- No saved routing profiles in this renderer session.";
  return [
    "# Omnia routing profile preview",
    "",
    "## Current next-run route",
    `- Preference: ${payload.route.preference}`,
    `- Fallback consent: ${payload.route.fallbackConsent}`,
    `- Model profile: ${payload.route.modelProfileId}`,
    `- Resolved model: ${payload.route.resolvedModel}`,
    "",
    "## Saved profiles",
    profileLines,
    "",
    "## Boundary",
    ...boundary.map((entry) => `- ${entry}`),
  ].join("\n");
}

function downloadRoutingProfilePreview(payload: string, format: RoutingProfileExportFormat): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-routing-profile-preview.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

export function RoutingWorkbench({
  providers,
  modelProfileId,
  onModelProfileChange,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onModelProfileChange: (profileId: string) => void;
}) {
  const [history, setHistory] = useState<RoutingHistory>({
    past: [],
    present: cloneRoutingPreview(DEFAULT_ROUTING_PREVIEW),
    future: [],
  });
  const [candidateQuery, setCandidateQuery] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState("all");
  const [historyStatus, setHistoryStatus] = useState("Routing policy changes stay in this renderer preview.");
  const [customProfiles, setCustomProfiles] = useState<RoutingProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profileStatus, setProfileStatus] = useState("Profiles are renderer-local snapshots.");
  const [profileExportFormat, setProfileExportFormat] = useState<RoutingProfileExportFormat>("json");
  const [profileExportStatus, setProfileExportStatus] = useState("Portable preview excludes credentials, native policy, and routing receipts.");
  const [profileImportText, setProfileImportText] = useState("");
  const [profileImportReview, setProfileImportReview] = useState<ImportedRoutingProfile[] | null>(null);
  const [profileImportStatus, setProfileImportStatus] = useState("Paste a routing preview bundle or choose a JSON file to review it.");
  const profileImportInputRef = useRef<HTMLInputElement>(null);
  const { preference, consent } = history.present;
  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const candidates = profiles.filter((profile) => profile.id !== "auto");
  const capabilityOptions = useMemo(
    () => Array.from(new Set(candidates.flatMap((candidate) => candidate.capabilities))).sort(),
    [candidates],
  );
  const autoModel = resolveAutoModel(providers);
  const selected = profiles.find((profile) => profile.id === modelProfileId) ?? profiles[0];
  const localCandidateCount = candidates.filter((candidate) => {
    const provider = providers.find((item) => item.id === candidate.connectionId);
    return provider?.kind === "Local";
  }).length;
  const eligibleCandidates = preference === "local"
    ? candidates.filter((candidate) => providers.find((provider) => provider.id === candidate.connectionId)?.kind === "Local")
    : candidates;
  const visibleCandidates = useMemo(() => {
    const normalized = candidateQuery.trim().toLowerCase();
    return eligibleCandidates.filter((candidate) => {
      const matchesQuery = !normalized
        || `${candidate.displayName} ${candidate.providerName} ${candidate.providerModelId} ${candidate.contextLabel}`.toLowerCase().includes(normalized);
      const matchesCapability = capabilityFilter === "all" || candidate.capabilities.some((capability) => capability === capabilityFilter);
      return matchesQuery && matchesCapability;
    });
  }, [candidateQuery, capabilityFilter, eligibleCandidates]);
  const fallback = fallbackConsent.find((item) => item.value === consent)!;
  const availableRoutingProfiles = useMemo(() => [...builtInRoutingProfiles, ...customProfiles], [customProfiles]);
  const profileExportPayload = useMemo(() => serializeRoutingProfilePreview({
    preference,
    consent,
    modelProfileId,
    resolvedModel: selected?.id === "auto"
      ? (autoModel ? `${autoModel.providerName} · ${autoModel.displayName}` : "No connected model has been reported")
      : `${selected?.providerName ?? "Unknown provider"} · ${selected?.displayName ?? "Unknown model"}`,
    savedProfiles: availableRoutingProfiles,
  }, profileExportFormat), [autoModel, availableRoutingProfiles, consent, modelProfileId, preference, profileExportFormat, selected]);

  const updatePreview = (patch: Partial<RoutingPreview>) => {
    setHistory((current) => ({
      past: [...current.past, cloneRoutingPreview(current.present)],
      present: { ...current.present, ...patch },
      future: [],
    }));
    setHistoryStatus("Routing policy changed in the renderer preview.");
  };

  const undo = () => {
    setHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneRoutingPreview(snapshot),
        future: [cloneRoutingPreview(current.present), ...current.future],
      };
    });
    setHistoryStatus("Undid the last routing preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return {
        past: [...current.past, cloneRoutingPreview(current.present)],
        present: cloneRoutingPreview(snapshot),
        future: current.future.slice(1),
      };
    });
    setHistoryStatus("Reapplied the next routing preview change.");
  };

  const reset = () => {
    setHistory((current) => ({
      past: [...current.past, cloneRoutingPreview(current.present)],
      present: cloneRoutingPreview(DEFAULT_ROUTING_PREVIEW),
      future: [],
    }));
    setHistoryStatus("Routing policy preview reset to defaults.");
  };

  const clearCandidateFilters = () => {
    setCandidateQuery("");
    setCapabilityFilter("all");
  };

  const applyRoutingProfile = (profile: RoutingProfile) => {
    if (!profiles.some((candidate) => candidate.id === profile.modelProfileId)) {
      setProfileStatus(`${profile.name} points to an unavailable model route. Choose another route before applying it.`);
      return;
    }
    updatePreview({ preference: profile.preference, consent: profile.consent });
    onModelProfileChange(profile.modelProfileId);
    setProfileStatus(`${profile.name} applied to the renderer routing preview.`);
  };

  const saveRoutingProfile = () => {
    const name = profileName.trim();
    if (!name) return;
    const profile: RoutingProfile = {
      id: `routing-custom-${Date.now()}`,
      name,
      description: "A renderer-local snapshot of the current route policy and model.",
      preference,
      consent,
      modelProfileId,
      custom: true,
    };
    setCustomProfiles((current) => [...current, profile]);
    setProfileName("");
    setProfileStatus(`${name} saved for this renderer session. Native routing persistence was not changed.`);
  };

  const removeRoutingProfile = (profile: RoutingProfile) => {
    if (!profile.custom) return;
    setCustomProfiles((current) => current.filter((item) => item.id !== profile.id));
    setProfileStatus(`${profile.name} removed from this renderer session.`);
  };

  const reviewRoutingProfileImport = () => {
    const result = parseRoutingProfilePreviewImport(profileImportText);
    if (!result.ok) {
      setProfileImportReview(null);
      setProfileImportStatus(result.reason);
      return;
    }
    const existingNames = new Set(availableRoutingProfiles.map((profile) => profile.name.trim().toLocaleLowerCase()));
    const conflicts = result.profiles.filter((profile) => existingNames.has(profile.name.toLocaleLowerCase()));
    if (conflicts.length) {
      setProfileImportReview(null);
      setProfileImportStatus(`Rename duplicate profile names before import: ${conflicts.map((profile) => profile.name).join(", ")}.`);
      return;
    }
    setProfileImportReview(result.profiles);
    const unavailable = result.profiles.filter((profile) => !profiles.some((candidate) => candidate.id === profile.modelProfileId)).length;
    setProfileImportStatus(`${result.profiles.length} profile${result.profiles.length === 1 ? "" : "s"} reviewed. ${unavailable ? `${unavailable} refer to unavailable model routes and will be non-applicable.` : "All model routes are currently available."}`);
  };

  const addReviewedRoutingProfiles = () => {
    if (!profileImportReview?.length) return;
    const importBatch = Date.now().toString(36);
    setCustomProfiles((current) => [...current, ...profileImportReview.map((profile, index) => ({ ...profile, id: `${profile.id}-${importBatch}-${index}` }))]);
    setProfileImportStatus(`${profileImportReview.length} profile${profileImportReview.length === 1 ? "" : "s"} added to this renderer session. No native settings were changed.`);
    setProfileImportReview(null);
  };

  const readRoutingProfileFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) {
      setProfileImportText("");
      setProfileImportReview(null);
      setProfileImportStatus("Import file is larger than 64 KB.");
      return;
    }
    try {
      setProfileImportText(await file.text());
      setProfileImportReview(null);
      setProfileImportStatus(`${file.name} loaded for review. Nothing has been imported yet.`);
    } catch {
      setProfileImportStatus("The selected JSON file could not be read in this browser preview.");
    }
  };

  const copyRoutingProfilePreview = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setProfileExportStatus("Clipboard is unavailable; no routing preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(profileExportPayload);
      setProfileExportStatus(`Copied ${profileExportFormat === "json" ? "JSON" : "Markdown"} routing preview. No durable write was made.`);
    } catch {
      setProfileExportStatus("Clipboard access was denied; no routing preview was copied.");
    }
  };

  const downloadProfilePreview = () => {
    setProfileExportStatus(
      downloadRoutingProfilePreview(profileExportPayload, profileExportFormat)
        ? `Downloaded ${profileExportFormat === "json" ? "JSON" : "Markdown"} renderer-local routing preview.`
        : "Browser download is unavailable; no routing preview was downloaded.",
    );
  };

  const applyModelRoutePreset = (preset: ModelRoutePreset) => {
    updatePreview({ preference: preset.preference, consent: preset.consent });
    onModelProfileChange(preset.modelProfileId);
    setProfileStatus(`${preset.name} applied to the renderer routing preview.`);
  };

  const moveCandidateFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!visibleCandidates.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? visibleCandidates.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + visibleCandidates.length) % visibleCandidates.length;
    document.getElementById(`routing-candidate-${visibleCandidates[nextIndex]!.id}`)?.focus();
  };

  return (
    <section className="routing-workbench" aria-labelledby="routing-workbench-title">
      <header className="routing-workbench__header">
        <span className="routing-workbench__icon"><Route size={18} /></span>
        <span>
          <span className="eyebrow">Renderer preview</span>
          <h2 id="routing-workbench-title">Routing Workbench</h2>
          <p>Inspect the intended text route before a run. Policy persistence, scoring, retries, and fallback dispatch remain native work.</p>
        </span>
        <span className="routing-workbench__status"><CircleAlert size={13} /> Preview only</span>
      </header>

      <div className="routing-workbench__controls">
        <label>
          <span>Route preference</span>
          <select value={preference} onChange={(event) => updatePreview({ preference: event.target.value as RoutingPreference })}>
            {routingPreferences.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <small>{routingPreferences.find((option) => option.value === preference)?.detail}</small>
        </label>
        <label>
          <span>Fallback consent</span>
          <select value={consent} onChange={(event) => updatePreview({ consent: event.target.value as FallbackConsent })}>
            {fallbackConsent.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <small>{fallback.detail}</small>
        </label>
      </div>

      <RoleRoutingPreview
        providers={providers}
        modelProfileId={modelProfileId}
        onModelProfileChange={onModelProfileChange}
      />

      <ModelRoutePresetsPreview
        providers={providers}
        modelProfileId={modelProfileId}
        onApplyPreset={applyModelRoutePreset}
      />

      <ModelRouteFitLab
        providers={providers}
        modelProfileId={modelProfileId}
        onModelProfileChange={onModelProfileChange}
      />

      <ModelRouterPreview
        providers={providers}
        modelProfileId={modelProfileId}
        onModelProfileChange={onModelProfileChange}
      />

      <ProviderRouteComparePreview
        providers={providers}
        modelProfileId={modelProfileId}
        onModelProfileChange={onModelProfileChange}
      />

      <ProviderFallbackRehearsal
        candidates={candidates}
        consent={consent}
      />

      <div className="routing-workbench__history" role="toolbar" aria-label="Routing preview history">
        <span className="routing-workbench__history-copy"><strong>Reversible policy preview</strong><small>{historyStatus}</small></span>
        <span className="routing-workbench__history-count" aria-label={`${history.past.length} undo steps and ${history.future.length} redo steps`}>
          {history.past.length + history.future.length} steps
        </span>
        <span className="routing-workbench__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo routing preview change" title="Undo routing preview change"><Undo2 size={13} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo routing preview change" title="Redo routing preview change"><Redo2 size={13} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset routing preview" title="Reset routing preview to defaults"><RotateCcw size={13} /> Reset</button>
        </span>
      </div>

      <div className="routing-workbench__profiles" aria-label="Saved routing profiles">
        <div className="routing-workbench__profiles-heading">
          <span><strong>Routing profiles</strong><small>Save a reusable route policy without changing native settings.</small></span>
          <span className="routing-workbench__profiles-status" role="status">{profileStatus}</span>
        </div>
        <div className="routing-workbench__profile-list" role="list">
          {availableRoutingProfiles.map((profile) => {
            const modelRouteAvailable = profiles.some((candidate) => candidate.id === profile.modelProfileId);
            return (
              <div className="routing-profile" role="listitem" key={profile.id}>
                <button type="button" className="routing-profile__apply" onClick={() => applyRoutingProfile(profile)} disabled={!modelRouteAvailable} aria-label={`Apply ${profile.name} routing profile`} title={!modelRouteAvailable ? `Unavailable model route: ${profile.modelProfileId}` : undefined}>
                  <span className="routing-profile__mark"><Route size={13} /></span>
                  <span><strong>{profile.name}</strong><small>{profile.description}{!modelRouteAvailable ? ` · Unavailable route: ${profile.modelProfileId}` : ""}</small></span>
                </button>
                {profile.custom ? <button type="button" className="routing-profile__remove" onClick={() => removeRoutingProfile(profile)} aria-label={`Remove ${profile.name} routing profile`}><X size={13} /></button> : null}
              </div>
            );
          })}
        </div>
        <div className="routing-workbench__profile-create">
          <label><span>Save current route as</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="e.g. Fast local coding" aria-label="Routing profile name" /></label>
          <button type="button" className="button button--secondary" disabled={!profileName.trim()} onClick={saveRoutingProfile}><Sparkles size={13} /> Save profile</button>
        </div>
        <div className="routing-workbench__profile-export">
          <div>
            <strong>Portable routing preview</strong>
            <small>Review and take the visible session policy with you; secrets, native authority, and durable receipts are excluded.</small>
          </div>
          <div className="routing-workbench__profile-export-actions">
            <label>
              <span>Format</span>
              <select value={profileExportFormat} onChange={(event) => setProfileExportFormat(event.target.value as RoutingProfileExportFormat)} aria-label="Routing profile export format">
                <option value="json">JSON</option>
                <option value="markdown">Markdown</option>
              </select>
            </label>
            <button type="button" className="button button--secondary" onClick={() => void copyRoutingProfilePreview()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadProfilePreview}><Download size={13} /> Download</button>
          </div>
          <p className="routing-workbench__profile-export-status" role="status">{profileExportStatus}</p>
          <pre tabIndex={0} aria-label="Routing profile export preview">{profileExportPayload}</pre>
          <div className="routing-workbench__profile-import">
            <div><strong>Import routing profiles</strong><small>Review a JSON bundle before adding its presets to this session. Maximum 64 KB and 24 profiles.</small></div>
            <textarea rows={5} value={profileImportText} onChange={(event) => { setProfileImportText(event.target.value); setProfileImportReview(null); }} aria-label="Routing profile JSON import" placeholder="Paste an Omnia routing profile preview JSON bundle…" />
            <div className="routing-workbench__profile-import-actions">
              <input ref={profileImportInputRef} type="file" accept="application/json,.json" hidden aria-label="Choose routing profile JSON file" onChange={(event) => { void readRoutingProfileFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              <button type="button" className="button button--ghost" onClick={() => profileImportInputRef.current?.click()}>Choose JSON file</button>
              <button type="button" className="button button--secondary" onClick={reviewRoutingProfileImport} disabled={!profileImportText.trim()}>Review import</button>
              <button type="button" className="button button--secondary" onClick={addReviewedRoutingProfiles} disabled={!profileImportReview?.length}>Add reviewed profiles</button>
            </div>
            {profileImportReview?.length ? <ul className="routing-workbench__profile-import-review" aria-label="Reviewed routing profiles">{profileImportReview.map((profile) => <li key={profile.id}><strong>{profile.name}</strong><span>{profile.preference} · {profile.consent} · {profiles.some((candidate) => candidate.id === profile.modelProfileId) ? profile.modelProfileId : `Unavailable · ${profile.modelProfileId}`}</span></li>)}</ul> : null}
            <p className="routing-workbench__profile-export-status" role="status">{profileImportStatus}</p>
          </div>
        </div>
      </div>

      <RoutingInheritancePreview
        providers={providers}
        modelProfileId={modelProfileId}
        onModelProfileChange={onModelProfileChange}
      />

      <div className="routing-workbench__resolved" role="status">
        <Sparkles size={16} />
        <span>
          <strong>Resolved for the next chat run</strong>
          <small>{selected?.id === "auto" ? (autoModel ? `${autoModel.providerName} · ${autoModel.displayName}` : "No connected model has been reported") : `${selected?.providerName ?? "Unknown provider"} · ${selected?.displayName ?? "Unknown model"}`}</small>
        </span>
        <span className="routing-workbench__route-mode">{selected?.id === "auto" ? "Auto route" : "Pinned route"}</span>
      </div>

      <div className="routing-workbench__candidate-header">
        <span><strong>Eligible candidates</strong><small>{visibleCandidates.length} shown{preference === "local" ? ` · ${localCandidateCount} local` : ""}</small></span>
        <button type="button" className={modelProfileId === "auto" ? "routing-workbench__auto routing-workbench__auto--selected" : "routing-workbench__auto"} onClick={() => onModelProfileChange("auto")}>
          {modelProfileId === "auto" ? <Check size={14} /> : <Route size={14} />} Use automatic route
        </button>
      </div>
      <div className="routing-workbench__candidate-filters" aria-label="Route candidate filters">
        <label className="routing-workbench__candidate-search">
          <Search size={14} />
          <input
            value={candidateQuery}
            onChange={(event) => setCandidateQuery(event.target.value)}
            placeholder="Search model or provider"
            aria-label="Search route candidates"
          />
          {candidateQuery ? <button type="button" aria-label="Clear route candidate search" onClick={() => setCandidateQuery("")}><X size={13} /></button> : null}
        </label>
        <label>
          <span>Capability</span>
          <select value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)} aria-label="Route capability filter">
            <option value="all">All capabilities</option>
            {capabilityOptions.map((capability) => <option key={capability} value={capability}>{capability}</option>)}
          </select>
        </label>
        <button type="button" className="button button--ghost" onClick={clearCandidateFilters} disabled={!candidateQuery && capabilityFilter === "all"} aria-label="Reset route candidate filters" title="Reset route candidate filters"><RotateCcw size={13} /> Reset</button>
      </div>
      {visibleCandidates.length > 0 ? (
        <div className="routing-workbench__candidates" role="list" aria-label="Eligible model routes">
          {visibleCandidates.map((candidate, index) => {
            const isSelected = candidate.id === modelProfileId;
            return (
              <div role="listitem" key={candidate.id}>
                <button id={`routing-candidate-${candidate.id}`} type="button" className={isSelected ? "routing-candidate routing-candidate--selected" : "routing-candidate"} onClick={() => onModelProfileChange(candidate.id)} onKeyDown={(event) => moveCandidateFocus(event, index)} aria-pressed={isSelected}>
                  <span className="routing-candidate__mark">{isSelected ? <Check size={15} /> : <Route size={15} />}</span>
                  <span className="routing-candidate__copy"><strong>{candidate.displayName}</strong><small>{candidate.providerName} · {candidate.contextLabel}</small></span>
                  <span className="routing-candidate__tags">{candidate.capabilities.slice(0, 3).map((capability) => <small key={capability}>{capability}</small>)}</span>
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="routing-workbench__empty"><ShieldCheck size={18} /><span><strong>No eligible route</strong><small>{preference === "local" ? "No connected local model is available." : "Connect and validate a provider to expose a model route."}</small></span></div>
      )}
      <p className="routing-workbench__boundary"><ShieldCheck size={14} /> The UI does not store a policy, authorize another provider, or send a fallback request. A future route change must be visible and recorded as a separate attempt.</p>
    </section>
  );
}
