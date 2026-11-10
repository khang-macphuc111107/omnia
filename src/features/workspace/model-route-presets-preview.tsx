import {
  Check,
  Clipboard,
  Download,
  LockKeyhole,
  Plus,
  Redo2,
  RotateCcw,
  Route,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { selectableModelProfiles } from "./provider-catalog";
import {
  BUILT_IN_MODEL_ROUTE_PRESETS,
  parseModelRoutePresetPreviewImport,
  serializeModelRoutePresetPreview,
  type ContextDeliveryMode,
  type DataResidency,
  type ImportedModelRoutePreset,
  type ModelRouteFallbackConsent,
  type ModelRoutePreference,
  type ModelRoutePreset,
  type ModelRoutePresetExportFormat,
  type ReasoningEffort,
} from "./model-route-preset-contract";
import type { ProviderView } from "./types";

type PresetHistory = {
  readonly past: ModelRoutePreset[];
  readonly present: ModelRoutePreset;
  readonly future: ModelRoutePreset[];
};

const clonePreset = (preset: ModelRoutePreset): ModelRoutePreset => ({ ...preset });

const contextOptions: ReadonlyArray<{ readonly value: ContextDeliveryMode; readonly label: string }> = [
  { value: "auto", label: "Auto · inspectable budget" },
  { value: "full", label: "Full authorized context" },
  { value: "summary-plus-sources", label: "Summary + sources" },
  { value: "manifest-only", label: "Manifest only" },
  { value: "retrieval-on-demand", label: "Retrieval on demand" },
];

const effortOptions: ReadonlyArray<{ readonly value: ReasoningEffort; readonly label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const residencyOptions: ReadonlyArray<{ readonly value: DataResidency; readonly label: string }> = [
  { value: "any", label: "Any connected destination" },
  { value: "same-region", label: "Same region when reported" },
  { value: "local-only", label: "Local runtime only" },
];

const preferenceOptions: ReadonlyArray<{ readonly value: ModelRoutePreference; readonly label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "quality", label: "Prefer quality" },
  { value: "balanced", label: "Balanced" },
  { value: "local", label: "Local only" },
];

const consentOptions: ReadonlyArray<{ readonly value: ModelRouteFallbackConsent; readonly label: string }> = [
  { value: "never", label: "Never switch" },
  { value: "same-connection", label: "Same connection" },
  { value: "approved-connections", label: "Approved connections" },
];

function readPresetFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The route preset file could not be read."));
    reader.readAsText(file);
  });
}

function downloadPresetPreview(payload: string, format: ModelRoutePresetExportFormat): boolean {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-model-route-presets.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ModelRoutePresetsPreview({
  providers,
  modelProfileId,
  onApplyPreset,
}: {
  readonly providers: ProviderView[];
  readonly modelProfileId: string;
  readonly onApplyPreset: (preset: ModelRoutePreset) => void;
}) {
  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const [customPresets, setCustomPresets] = useState<ModelRoutePreset[]>([]);
  const [activeId, setActiveId] = useState(BUILT_IN_MODEL_ROUTE_PRESETS[0]!.id);
  const [history, setHistory] = useState<PresetHistory>({
    past: [],
    present: clonePreset(BUILT_IN_MODEL_ROUTE_PRESETS[0]!),
    future: [],
  });
  const [presetName, setPresetName] = useState("");
  const [status, setStatus] = useState("Preset edits stay in this renderer session until you apply one to the route preview.");
  const [exportFormat, setExportFormat] = useState<ModelRoutePresetExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Export excludes credentials, provider payloads, and native route authority.");
  const [importText, setImportText] = useState("");
  const [importReview, setImportReview] = useState<ImportedModelRoutePreset[] | null>(null);
  const [importStatus, setImportStatus] = useState("Paste a route preset bundle or choose a JSON file to review it.");
  const importInputRef = useRef<HTMLInputElement>(null);
  const availablePresets = useMemo(() => [...BUILT_IN_MODEL_ROUTE_PRESETS, ...customPresets], [customPresets]);
  const profileMap = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const exportPayload = useMemo(
    () => serializeModelRoutePresetPreview(availablePresets, activeId, exportFormat),
    [activeId, availablePresets, exportFormat],
  );
  const selectedProfile = profileMap.get(history.present.modelProfileId);

  const updateDraft = (patch: Partial<ModelRoutePreset>, message = "Route preset draft changed in the renderer preview.") => {
    setHistory((current) => ({
      past: [...current.past, clonePreset(current.present)],
      present: { ...current.present, ...patch },
      future: [],
    }));
    setStatus(message);
  };

  const choosePreset = (preset: ModelRoutePreset) => {
    setActiveId(preset.id);
    setHistory((current) => ({ past: [...current.past, clonePreset(current.present)], present: clonePreset(preset), future: [] }));
    setStatus(`${preset.name} loaded into the reversible route preset draft.`);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: clonePreset(previous), future: [clonePreset(current.present), ...current.future] };
    });
    setStatus("Undid the last route preset edit.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, clonePreset(current.present)], present: clonePreset(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next route preset edit.");
  };

  const reset = () => {
    const fallback = BUILT_IN_MODEL_ROUTE_PRESETS[0]!;
    setActiveId(fallback.id);
    setHistory((current) => ({ past: [...current.past, clonePreset(current.present)], present: clonePreset(fallback), future: [] }));
    setStatus("Route preset draft reset to the General · Auto defaults.");
  };

  const saveCustomPreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "route";
    const preset: ModelRoutePreset = {
      ...clonePreset(history.present),
      id: `route-custom-${Date.now()}-${slug}`,
      name,
      description: "A renderer-local model route preset snapshot.",
      tone: "custom",
      custom: true,
    };
    setCustomPresets((current) => [...current, preset]);
    setActiveId(preset.id);
    setHistory((current) => ({ past: [...current.past, clonePreset(current.present)], present: clonePreset(preset), future: [] }));
    setPresetName("");
    setStatus(`${name} saved for this renderer session. Native route settings were not changed.`);
  };

  const removeCustomPreset = (preset: ModelRoutePreset) => {
    if (!preset.custom) return;
    setCustomPresets((current) => current.filter((candidate) => candidate.id !== preset.id));
    if (activeId === preset.id) reset();
    setStatus(`${preset.name} removed from this renderer session.`);
  };

  const applyDraft = () => {
    if (!profileMap.has(history.present.modelProfileId)) {
      setStatus(`${history.present.name} points to an unavailable model route; choose another model before applying.`);
      return;
    }
    onApplyPreset(clonePreset(history.present));
    setStatus(`${history.present.name} applied to the route preview. Provider dispatch remains unobserved.`);
  };

  const reviewImport = () => {
    const result = parseModelRoutePresetPreviewImport(importText);
    if (!result.ok) {
      setImportReview(null);
      setImportStatus(result.reason);
      return;
    }
    const existingNames = new Set(availablePresets.map((preset) => preset.name.toLocaleLowerCase()));
    const conflicts = result.presets.filter((preset) => existingNames.has(preset.name.toLocaleLowerCase()));
    if (conflicts.length) {
      setImportReview(null);
      setImportStatus(`Rename duplicate preset names before import: ${conflicts.map((preset) => preset.name).join(", ")}.`);
      return;
    }
    setImportReview(result.presets);
    const unavailable = result.presets.filter((preset) => !profileMap.has(preset.modelProfileId)).length;
    setImportStatus(`${result.presets.length} preset${result.presets.length === 1 ? "" : "s"} reviewed. ${unavailable ? `${unavailable} refer to unavailable model routes.` : "All model routes are currently available."}`);
  };

  const addReviewedPresets = () => {
    if (!importReview?.length) return;
    setCustomPresets((current) => [...current, ...importReview.map((preset, index) => ({ ...preset, id: `${preset.id}-${Date.now().toString(36)}-${index}` }))]);
    setImportStatus(`${importReview.length} route preset${importReview.length === 1 ? "" : "s"} added to this renderer session. Native settings were not changed.`);
    setImportReview(null);
  };

  const readImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setImportText(await readPresetFile(file));
      setImportReview(null);
      setImportStatus(`${file.name} loaded for review. Nothing has been imported yet.`);
    } catch {
      setImportStatus("The selected JSON file could not be read in this browser preview.");
    }
  };

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard is unavailable; no route preset preview was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied ${exportFormat === "json" ? "JSON" : "Markdown"} route preset preview. No durable write was made.`);
    } catch {
      setExportStatus("Clipboard access was denied; no route preset preview was copied.");
    }
  };

  return (
    <section className="model-route-presets-preview" aria-labelledby="model-route-presets-title">
      <header className="model-route-presets-preview__header">
        <span className="model-route-presets-preview__icon"><Route size={16} /></span>
        <span><span className="eyebrow">Renderer-local route library</span><h3 id="model-route-presets-title">Model route presets</h3><p>Compose a reusable model, context, effort, privacy, quality, and latency policy before native route resolution exists.</p></span>
        <span className="model-route-presets-preview__badge"><Sparkles size={12} /> Preview only</span>
      </header>

      <div className="model-route-presets-preview__grid" role="list" aria-label="Model route presets">
        {availablePresets.map((preset) => {
          const available = profileMap.has(preset.modelProfileId);
          const selected = activeId === preset.id;
          return (
            <article className={selected ? `model-route-preset model-route-preset--${preset.tone} model-route-preset--selected` : `model-route-preset model-route-preset--${preset.tone}`} role="listitem" key={preset.id}>
              <button type="button" className="model-route-preset__select" onClick={() => choosePreset(preset)} aria-pressed={selected} aria-label={`Edit ${preset.name} route preset`}>
                <span className="model-route-preset__swatch"><Route size={13} /></span>
                <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
                {selected ? <Check size={14} /> : null}
              </button>
              <div className="model-route-preset__meta"><span>{preset.modelProfileId}</span><span>{preset.contextMode}</span><span>{preset.dataResidency}</span></div>
              <button type="button" className="button button--ghost model-route-preset__apply" onClick={() => { choosePreset(preset); if (available) onApplyPreset(preset); }} disabled={!available} aria-label={`Use ${preset.name} route preset`} title={!available ? `Unavailable model route: ${preset.modelProfileId}` : undefined}><Route size={12} /> Use preset</button>
              {preset.custom ? <button type="button" className="model-route-preset__remove" onClick={() => removeCustomPreset(preset)} aria-label={`Remove ${preset.name} route preset`}><Trash2 size={13} /></button> : null}
            </article>
          );
        })}
      </div>

      <div className="model-route-presets-preview__history" role="toolbar" aria-label="Model route preset history">
        <span><strong>Reversible preset draft</strong><small>{status}</small></span>
        <span className="model-route-presets-preview__history-count">{history.past.length + history.future.length} steps</span>
        <span className="model-route-presets-preview__history-actions">
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo route preset edit"><Undo2 size={12} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo route preset edit"><Redo2 size={12} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset route preset draft"><RotateCcw size={12} /> Reset</button>
        </span>
      </div>

      <div className="model-route-presets-preview__editor" aria-label="Model route preset editor">
        <div className="model-route-presets-preview__editor-heading"><span><strong>Edit preset draft</strong><small>{selectedProfile ? `Current catalog route: ${selectedProfile.displayName}` : "Selected model is unavailable in this catalog snapshot."}</small></span><span className={modelProfileId === history.present.modelProfileId ? "model-route-presets-preview__current model-route-presets-preview__current--active" : "model-route-presets-preview__current"}>{modelProfileId === history.present.modelProfileId ? "Active route" : "Draft only"}</span></div>
        <div className="model-route-presets-preview__form">
          <label><span>Model route</span><select value={history.present.modelProfileId} onChange={(event) => updateDraft({ modelProfileId: event.target.value })} aria-label="Preset model route">{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.providerName}</option>)}</select></label>
          <label><span>Route preference</span><select value={history.present.preference} onChange={(event) => updateDraft({ preference: event.target.value as ModelRoutePreference })} aria-label="Preset route preference">{preferenceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Fallback consent</span><select value={history.present.consent} onChange={(event) => updateDraft({ consent: event.target.value as ModelRouteFallbackConsent })} aria-label="Preset fallback consent">{consentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Context delivery</span><select value={history.present.contextMode} onChange={(event) => updateDraft({ contextMode: event.target.value as ContextDeliveryMode })} aria-label="Preset context delivery">{contextOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Reasoning effort</span><select value={history.present.reasoningEffort} onChange={(event) => updateDraft({ reasoningEffort: event.target.value as ReasoningEffort })} aria-label="Preset reasoning effort">{effortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Data residency</span><select value={history.present.dataResidency} onChange={(event) => updateDraft({ dataResidency: event.target.value as DataResidency })} aria-label="Preset data residency">{residencyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label><span>Quality floor <output>{history.present.qualityFloor}</output></span><input type="range" min="0" max="100" step="5" value={history.present.qualityFloor} onChange={(event) => updateDraft({ qualityFloor: Number(event.target.value) })} aria-label="Preset quality floor" /></label>
          <label><span>Latency budget</span><select value={history.present.maxLatencyMs === null ? "any" : String(history.present.maxLatencyMs)} onChange={(event) => updateDraft({ maxLatencyMs: event.target.value === "any" ? null : Number(event.target.value) })} aria-label="Preset latency budget"><option value="any">Any reported latency</option><option value="500">500 ms</option><option value="800">800 ms</option><option value="1200">1,200 ms</option><option value="1500">1,500 ms</option><option value="3000">3,000 ms</option></select></label>
        </div>
        <div className="model-route-presets-preview__editor-actions">
          <label><span>Save current draft as</span><input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="e.g. CSE deep review" aria-label="Model route preset name" /></label>
          <button type="button" className="button button--secondary" onClick={saveCustomPreset} disabled={!presetName.trim()}><Plus size={13} /> Save preset</button>
          <button type="button" className="button button--primary" onClick={applyDraft} disabled={!selectedProfile} aria-label="Apply model route preset draft"><Check size={13} /> Apply to route</button>
        </div>
      </div>

      <div className="model-route-presets-preview__transfer">
        <div className="model-route-presets-preview__transfer-heading"><span><strong>Portable preset preview</strong><small>Review, copy, download, or stage an import in this session. Secrets and native authority never enter the bundle.</small></span><label><span>Format</span><select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ModelRoutePresetExportFormat)} aria-label="Model route preset export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label></div>
        <div className="model-route-presets-preview__transfer-actions"><button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={12} /> Copy</button><button type="button" className="button button--secondary" onClick={() => setExportStatus(downloadPresetPreview(exportPayload, exportFormat) ? "Downloaded the renderer-local route preset preview." : "Browser download is unavailable; no route preset was downloaded.")}><Download size={12} /> Download</button><span role="status">{exportStatus}</span></div>
        <pre tabIndex={0} aria-label="Model route preset export preview">{exportPayload}</pre>
        <div className="model-route-presets-preview__import">
          <div><strong>Import route presets</strong><small>Review JSON before adding up to 20 custom presets to this session.</small></div>
          <textarea rows={4} value={importText} onChange={(event) => { setImportText(event.target.value); setImportReview(null); }} aria-label="Model route preset JSON import" placeholder="Paste an Omnia model route preset preview JSON bundle…" />
          <div className="model-route-presets-preview__import-actions"><input ref={importInputRef} type="file" accept="application/json,.json" hidden aria-label="Choose model route preset JSON file" onChange={(event) => { void readImportFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /><button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()}><Upload size={12} /> Choose file</button><button type="button" className="button button--secondary" onClick={reviewImport} disabled={!importText.trim()}>Review import</button><button type="button" className="button button--secondary" onClick={addReviewedPresets} disabled={!importReview?.length}>Add reviewed</button></div>
          {importReview?.length ? <ul className="model-route-presets-preview__import-review" aria-label="Reviewed model route presets">{importReview.map((preset) => <li key={preset.id}><strong>{preset.name}</strong><span>{preset.modelProfileId} · {preset.contextMode} · {profileMap.has(preset.modelProfileId) ? "available" : "unavailable"}</span></li>)}</ul> : null}
          <p className="model-route-presets-preview__import-status" role="status">{importStatus}</p>
        </div>
      </div>

      <p className="model-route-presets-preview__boundary"><LockKeyhole size={13} /> Presets are deterministic renderer drafts. They do not freeze context, call a provider, grant fallback consent, alter native settings, or prove which model handles a future run.</p>
    </section>
  );
}
