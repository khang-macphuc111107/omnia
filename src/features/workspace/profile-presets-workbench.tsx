import {
  Check,
  Download,
  FlaskConical,
  Plus,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  createDefaultParameterSettings,
  importParameterSettings,
  serializeParameterSettings,
} from "./parameter-settings-contract";
import { selectableModelProfiles } from "./provider-catalog";
import { useWorkspaceStore } from "./store";
import type { ParameterSettings } from "./types";

type Preset = {
  id: string;
  name: string;
  description: string;
  tone: string;
  parameters: Partial<ParameterSettings>;
  custom?: boolean;
};

const presets: Preset[] = [
  { id: "precise", name: "Precise", description: "Deterministic drafting, extraction, and code review.", tone: "steel", parameters: { temperature: 0.2, topP: 0.8, maxOutputTokens: 4096, reasoningEffort: "high" } },
  { id: "balanced", name: "Balanced", description: "A practical default for everyday project work.", tone: "teal", parameters: { temperature: 0.7, topP: 0.95, maxOutputTokens: 4096, reasoningEffort: "medium" } },
  { id: "creative", name: "Creative", description: "More variation for ideation, writing, and exploration.", tone: "amber", parameters: { temperature: 1.1, topP: 1, maxOutputTokens: 6144, reasoningEffort: "low" } },
  { id: "research", name: "Research", description: "Longer answers with deliberate reasoning enabled.", tone: "coral", parameters: { temperature: 0.45, topP: 0.9, maxOutputTokens: 8192, reasoningEffort: "max", reasoningBudgetTokens: 12000 } },
];

function readPresetFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The preset file could not be read."));
    reader.readAsText(file);
  });
}

function downloadJson(contents: string, filename: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

interface ProfilePresetsWorkbenchProps {
  /**
   * The parameter inspector already renders the full ParameterHistoryControls
   * surface. Keep the profile cards focused on presets there so the same
   * undo/redo actions are not duplicated in one inspector panel.
   */
  readonly showHistoryControls?: boolean;
}

export function ProfilePresetsWorkbench({ showHistoryControls = true }: ProfilePresetsWorkbenchProps = {}) {
  const parameters = useWorkspaceStore((state) => state.parameters);
  const parameterUndoStack = useWorkspaceStore((state) => state.parameterUndoStack);
  const parameterRedoStack = useWorkspaceStore((state) => state.parameterRedoStack);
  const providers = useWorkspaceStore((state) => state.providers);
  const modelProfileId = useWorkspaceStore((state) => state.modelProfileId);
  const replaceParameters = useWorkspaceStore((state) => state.replaceParameters);
  const undoParameterChange = useWorkspaceStore((state) => state.undoParameterChange);
  const redoParameterChange = useWorkspaceStore((state) => state.redoParameterChange);
  const setModelProfile = useWorkspaceStore((state) => state.setModelProfile);
  const resetParameters = useWorkspaceStore((state) => state.resetParameters);
  const [activeId, setActiveId] = useState("balanced");
  const [customName, setCustomName] = useState("");
  const [customPresets, setCustomPresets] = useState<Preset[]>([]);
  const [status, setStatus] = useState("Preset changes are renderer-local and reversible in this session.");
  const importInputRef = useRef<HTMLInputElement>(null);
  const profiles = useMemo(() => selectableModelProfiles(providers), [providers]);
  const availablePresets = useMemo(() => [...presets, ...customPresets], [customPresets]);
  const active = availablePresets.find((preset) => preset.id === activeId) ?? presets[1]!;
  const applyPreset = (preset: Preset) => {
    setActiveId(preset.id);
    replaceParameters(preset.parameters);
    setStatus(`${preset.name} applied to the renderer parameter preview.`);
  };
  const saveCustomPreset = () => {
    const name = customName.trim();
    if (!name) return;
    const id = `custom-${Date.now()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset"}`;
    const preset: Preset = {
      id,
      name,
      description: "A renderer-local snapshot of the current generation parameters.",
      tone: "custom",
      parameters: { ...parameters },
      custom: true,
    };
    setCustomPresets((current) => [...current, preset]);
    setActiveId(id);
    setCustomName("");
    setStatus(`${name} saved for this renderer session. Native profile persistence was not changed.`);
  };
  const removeCustomPreset = (preset: Preset) => {
    if (!preset.custom) return;
    setCustomPresets((current) => current.filter((candidate) => candidate.id !== preset.id));
    if (activeId === preset.id) setActiveId("balanced");
    setStatus(`${preset.name} removed from this renderer session.`);
  };
  const exportParameters = () => {
    const slug = (active.name || "parameters").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "parameters";
    const serialized = serializeParameterSettings(parameters, { scope: "profile", name: active.name });
    setStatus(
      downloadJson(serialized, `omnia-profile-${slug}.json`)
        ? "Profile parameter JSON exported. Native profile storage remains untouched."
        : "File download is unavailable in this surface; no profile JSON was exported.",
    );
  };
  const importParameters = async (file: File) => {
    try {
      const result = importParameterSettings(await readPresetFile(file), parameters);
      if (!result.ok) throw new Error(result.errors.join(" "));
      if (result.changedKeys.length === 0) {
        setStatus("The imported profile already matches the current renderer parameters.");
        return;
      }
      replaceParameters(result.parameters);
      const importedPreset: Preset = {
        id: `imported-${Date.now()}`,
        name: "Imported profile",
        description: "A renderer-local snapshot imported from a parameter settings bundle.",
        tone: "custom",
        parameters: { ...result.parameters },
        custom: true,
      };
      setCustomPresets((current) => [...current, importedPreset]);
      setActiveId(importedPreset.id);
      setStatus(
        result.warnings.length > 0
          ? `Profile JSON imported with notes: ${result.warnings.join(" ")}`
          : `Profile JSON imported; ${result.changedKeys.length} parameter values changed in the renderer.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? `Profile import failed: ${error.message}` : "Profile import failed.");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };
  const isDefault = Object.entries(createDefaultParameterSettings()).every(
    ([key, value]) => Object.is(parameters[key as keyof ParameterSettings], value),
  );

  return (
    <section className="profile-presets-workbench" aria-labelledby="profile-presets-title">
      <header className="profile-presets-workbench__header">
        <span className="profile-presets-workbench__icon"><SlidersHorizontal size={17} /></span>
        <span><span className="eyebrow">Renderer preview</span><h2 id="profile-presets-title">Profiles & presets</h2><p>Switch a starting profile, capture custom snapshots, and move parameter JSON between sessions.</p></span>
        <span className="profile-presets-workbench__status"><FlaskConical size={13} /> Local preview</span>
      </header>
      {showHistoryControls ? (
        <div className="profile-presets-workbench__history" role="toolbar" aria-label="Profile parameter history">
          <span><strong>{parameterUndoStack.length}</strong> undo steps · <strong>{parameterRedoStack.length}</strong> redo steps</span>
          <div>
            <button type="button" className="button button--ghost" onClick={() => { undoParameterChange(); setStatus("Undid the last renderer parameter change."); }} disabled={parameterUndoStack.length === 0} aria-label="Undo profile parameter change"><Undo2 size={13} /> Undo</button>
            <button type="button" className="button button--ghost" onClick={() => { redoParameterChange(); setStatus("Reapplied the next renderer parameter change."); }} disabled={parameterRedoStack.length === 0} aria-label="Redo profile parameter change"><Redo2 size={13} /> Redo</button>
            <button type="button" className="button button--ghost" onClick={() => { resetParameters(); setActiveId("balanced"); setStatus("Renderer parameters reset to defaults."); }} disabled={isDefault}><RotateCcw size={13} /> Reset</button>
          </div>
        </div>
      ) : null}
      <div className="profile-presets-workbench__grid" role="list" aria-label="Generation presets">
        {availablePresets.map((preset) => {
          const selected = active.id === preset.id;
          return <div className="profile-preset-shell" role="listitem" key={preset.id}>
            <button type="button" className={`profile-preset profile-preset--${preset.tone}${selected ? " profile-preset--selected" : ""}`} onClick={() => applyPreset(preset)} aria-pressed={selected} aria-label={`Apply ${preset.name} preset`}>
              <span className="profile-preset__top"><strong>{preset.name}</strong>{selected ? <Check size={14} /> : <Sparkles size={14} />}</span>
              <small>{preset.description}</small>
              <span className="profile-preset__meta">Temperature {preset.parameters.temperature} · {preset.parameters.reasoningEffort} reasoning</span>
            </button>
            {preset.custom ? <button type="button" className="profile-preset__remove" onClick={() => removeCustomPreset(preset)} aria-label={`Remove ${preset.name} custom preset`} title={`Remove ${preset.name}`}><Trash2 size={13} /></button> : null}
          </div>;
        })}
      </div>
      <div className="profile-presets-workbench__row">
        <label><span>Model profile</span><select value={modelProfileId} onChange={(event) => setModelProfile(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName} · {profile.providerName}</option>)}</select></label>
        <div className="profile-presets-workbench__actions">
          <button type="button" className="button button--secondary" onClick={exportParameters}><Download size={14} /> Export JSON</button>
          <button type="button" className="button button--secondary" onClick={() => importInputRef.current?.click()}><Upload size={14} /> Import JSON</button>
          <input ref={importInputRef} className="sr-only" type="file" accept="application/json,.json" aria-label="Import profile parameter JSON" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importParameters(file); }} />
        </div>
      </div>
      <div className="profile-presets-workbench__custom"><label><span>Save a custom preset</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. TypeScript reviewer" aria-label="Save a custom preset" /></label><button type="button" className="button button--secondary" disabled={!customName.trim()} onClick={saveCustomPreset}><Plus size={14} /> Save preset</button><small>Current values: {parameters.temperature.toFixed(2)} temperature · {parameters.maxOutputTokens.toLocaleString()} max tokens</small></div>
      <p className="profile-presets-workbench__feedback" role="status">{status}</p>
      <p className="profile-presets-workbench__boundary">Changes, custom presets, and import/export are renderer-local. Native profile persistence, team sync, and provider execution remain separate planned contracts.</p>
    </section>
  );
}
