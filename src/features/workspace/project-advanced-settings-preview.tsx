import {
  Archive,
  BookOpen,
  Braces,
  Check,
  Clipboard,
  Download,
  FlaskConical,
  Layers3,
  RotateCcw,
  Sparkles,
  Terminal,
  Upload,
  Undo2,
  Redo2,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import {
  cloneProjectAdvancedSettings,
  equalProjectAdvancedSettings,
  parseProjectAdvancedSettings,
  PROJECT_ADVANCED_DEFAULTS,
  PROJECT_ADVANCED_PRESETS,
  serializeProjectAdvancedSettings,
  type ProjectAdvancedSettingsDraft,
  type ProjectContextMode,
  type ProjectExportMode,
  type ProjectIconId,
  type ProjectMemoryMode,
  type ProjectRetention,
  type ProjectRoute,
  type ProjectSkillMode,
} from "./project-advanced-settings-contract";
import type { ProjectView } from "./types";

interface HistoryState {
  readonly past: ProjectAdvancedSettingsDraft[];
  readonly present: ProjectAdvancedSettingsDraft;
  readonly future: ProjectAdvancedSettingsDraft[];
}

const ICONS: readonly { id: ProjectIconId; label: string; icon: LucideIcon }[] = [
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "research", label: "Research", icon: FlaskConical },
  { id: "layers", label: "Layers", icon: Layers3 },
  { id: "spark", label: "Creative", icon: Sparkles },
  { id: "brackets", label: "Code", icon: Braces },
  { id: "flask", label: "Science", icon: FlaskConical },
  { id: "book", label: "Notebook", icon: BookOpen },
  { id: "rocket", label: "Build", icon: Rocket },
];

const ROUTE_LABELS: Record<ProjectRoute, string> = {
  auto: "Automatic",
  "quality-first": "Quality first",
  balanced: "Balanced",
  "local-private": "Local & private",
};
const CONTEXT_LABELS: Record<ProjectContextMode, string> = {
  "no-roots": "No roots",
  "read-only": "Read-only roots",
  "metadata-only": "Metadata only",
  "selected-files": "Selected files",
};
const MEMORY_LABELS: Record<ProjectMemoryMode, string> = {
  off: "Off",
  propose: "Suggest · review first",
  "auto-low-risk": "Auto · low-risk preview",
  custom: "Custom",
};
const SKILL_LABELS: Record<ProjectSkillMode, string> = {
  inherited: "Inherit project catalog",
  curated: "Curated set",
  manual: "Manual only",
  off: "Off",
};
const RETENTION_LABELS: Record<ProjectRetention, string> = {
  forever: "Until removed",
  "30-days": "30 days",
  "90-days": "90 days",
  manual: "Ask before cleanup",
};
const EXPORT_LABELS: Record<ProjectExportMode, string> = {
  redacted: "Redacted metadata",
  "metadata-excerpts": "Metadata + excerpts",
  custom: "Custom selection",
};

function selectedIcon(iconId: ProjectIconId) {
  return ICONS.find((item) => item.id === iconId) ?? ICONS[0]!;
}

function downloadJson(filename: string, payload: string) {
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Project policy workbench is deliberately a renderer-session preview. */
export function ProjectAdvancedSettingsPreview({ project }: { readonly project: ProjectView }) {
  const [history, setHistory] = useState<HistoryState>(() => ({
    past: [],
    present: cloneProjectAdvancedSettings(PROJECT_ADVANCED_DEFAULTS as ProjectAdvancedSettingsDraft),
    future: [],
  }));
  const [status, setStatus] = useState("Advanced defaults are a preview; no native Project policy is loaded.");
  const [importError, setImportError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const values = history.present;
  const dirty = useMemo(
    () => !equalProjectAdvancedSettings(values, PROJECT_ADVANCED_DEFAULTS as ProjectAdvancedSettingsDraft),
    [values],
  );
  const SelectedIcon = selectedIcon(values.icon).icon;
  const exportText = useMemo(
    () => JSON.stringify(serializeProjectAdvancedSettings(project.id, project.name, values), null, 2),
    [project.id, project.name, values],
  );

  useEffect(() => {
    setHistory({
      past: [],
      present: cloneProjectAdvancedSettings(PROJECT_ADVANCED_DEFAULTS as ProjectAdvancedSettingsDraft),
      future: [],
    });
    setStatus("Advanced preview reset for this Project; no native state changed.");
    setImportError(null);
  }, [project.id]);

  const update = <K extends keyof ProjectAdvancedSettingsDraft>(key: K, value: ProjectAdvancedSettingsDraft[K]) => {
    setHistory((current) => ({
      past: [...current.past, cloneProjectAdvancedSettings(current.present)].slice(-40),
      present: { ...current.present, [key]: value },
      future: [],
    }));
    setImportError(null);
    setStatus("Unsaved advanced renderer-preview changes.");
  };

  const applyPreset = (presetId: string) => {
    const preset = PROJECT_ADVANCED_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setHistory((current) => ({
      past: [...current.past, cloneProjectAdvancedSettings(current.present)].slice(-40),
      present: cloneProjectAdvancedSettings(preset.values),
      future: [],
    }));
    setStatus(`${preset.label} preset applied to this preview only.`);
  };

  const undo = () => setHistory((current) => {
    if (!current.past.length) return current;
    const previous = current.past[current.past.length - 1]!;
    setStatus("Undid the latest advanced preview change.");
    return { past: current.past.slice(0, -1), present: cloneProjectAdvancedSettings(previous), future: [cloneProjectAdvancedSettings(current.present), ...current.future].slice(0, 40) };
  });

  const redo = () => setHistory((current) => {
    if (!current.future.length) return current;
    const [next, ...future] = current.future;
    if (!next) return current;
    setStatus("Redid the advanced preview change.");
    return { past: [...current.past, cloneProjectAdvancedSettings(current.present)].slice(-40), present: cloneProjectAdvancedSettings(next), future };
  });

  const reset = () => {
    setHistory((current) => ({
      past: [...current.past, cloneProjectAdvancedSettings(current.present)].slice(-40),
      present: cloneProjectAdvancedSettings(PROJECT_ADVANCED_DEFAULTS as ProjectAdvancedSettingsDraft),
      future: [],
    }));
    setStatus("Advanced settings reset to preview defaults; no native policy changed.");
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setImportError(null);
    if (!file) return;
    if (file.size > 64 * 1024) {
      setImportError("Import is limited to 64 KB.");
      setStatus("Import rejected; the preview was not changed.");
      return;
    }
    try {
      const parsed = parseProjectAdvancedSettings(JSON.parse(await file.text()));
      if (!parsed) throw new Error("schema");
      setHistory((current) => ({
        past: [...current.past, cloneProjectAdvancedSettings(current.present)].slice(-40),
        present: parsed,
        future: [],
      }));
      setStatus("Imported advanced settings into this renderer session. Nothing was written natively.");
    } catch {
      setImportError("This file is not a valid Omnia advanced Project settings bundle.");
      setStatus("Import rejected; the preview was not changed.");
    }
  };

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      setStatus("Copied JSON preview bundle to clipboard; no file or Project record was written.");
    } catch {
      setStatus("Clipboard is unavailable here; download the JSON preview instead.");
    }
  };

  return (
    <section className="project-advanced-settings" aria-label="Advanced Project settings preview">
      <header className="project-advanced-settings__header">
        <div className="project-advanced-settings__identity">
          <span className="project-advanced-settings__mark" style={{ "--project-advanced-accent": values.accent } as CSSProperties}>
            <SelectedIcon size={18} aria-hidden="true" />
          </span>
          <div>
            <span className="eyebrow">Project policy workbench · preview</span>
            <h2>Advanced settings</h2>
            <p>Stage how this workspace could look and behave. Every value below remains renderer-local.</p>
          </div>
        </div>
        <span className="project-advanced-settings__preview-badge"><Check size={12} /> Preview only</span>
      </header>

      <div className="project-advanced-settings__toolbar" aria-label="Advanced settings history and presets">
        <span><strong>{dirty ? "Draft changed" : "Defaults"}</strong><small>{history.past.length} undoable changes</small></span>
        <div className="hit-target-control">
          <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo advanced Project settings"><Undo2 size={14} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo advanced Project settings"><Redo2 size={14} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} disabled={!dirty} aria-label="Reset advanced Project settings"><RotateCcw size={14} /> Reset</button>
        </div>
      </div>

      <div className="project-advanced-settings__preset-grid" aria-label="Project setup presets">
        {PROJECT_ADVANCED_PRESETS.map((preset) => (
          <button key={preset.id} type="button" className="project-advanced-settings__preset" onClick={() => applyPreset(preset.id)}>
            <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
            <span>Preview preset</span>
          </button>
        ))}
      </div>

      <div className="project-advanced-settings__grid">
        <section className="project-advanced-settings__card" aria-label="Identity and appearance">
          <div className="project-advanced-settings__card-heading"><span className="eyebrow">01 · Identity</span><h3>Make this Project recognizable</h3></div>
          <div className="project-advanced-settings__icon-grid" role="group" aria-label="Project icon">
            {ICONS.map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" className={values.icon === id ? "is-selected" : ""} aria-pressed={values.icon === id} aria-label={`Project icon ${label}`} onClick={() => update("icon", id)}><Icon size={17} /><span>{label}</span></button>
            ))}
          </div>
          <label className="project-advanced-settings__color"><span>Project accent <small>{values.accent.toUpperCase()}</small></span><input type="color" value={values.accent} aria-label="Project accent color" onChange={(event) => update("accent", event.target.value)} /><small>Preview swatch · does not modify app-wide theme or icon assets.</small></label>
          <div className="project-advanced-settings__sample" style={{ "--project-advanced-accent": values.accent } as CSSProperties}><span className="project-advanced-settings__sample-mark"><SelectedIcon size={16} /></span><span><strong>{project.name}</strong><small>{project.description || "Project description preview"}</small></span><em>Project</em></div>
        </section>

        <section className="project-advanced-settings__card" aria-label="Routing defaults">
          <div className="project-advanced-settings__card-heading"><span className="eyebrow">02 · Defaults</span><h3>Model and generation</h3></div>
          <label><span>Preferred route <small>Not validated against an endpoint</small></span><select value={values.route} onChange={(event) => update("route", event.target.value as ProjectRoute)}><option value="auto">Automatic route</option><option value="quality-first">Quality first</option><option value="balanced">Balanced</option><option value="local-private">Local &amp; private</option></select></label>
          <label><span>Parameter preset <small>Parameters are not applied to a run</small></span><select value={values.parameterPreset} onChange={(event) => update("parameterPreset", event.target.value as ProjectAdvancedSettingsDraft["parameterPreset"])}><option value="balanced">Balanced</option><option value="precise">Precise</option><option value="creative">Creative</option><option value="custom">Custom</option></select></label>
          <div className="project-advanced-settings__value-card"><span>Current preview</span><strong>{ROUTE_LABELS[values.route]}</strong><small>{values.parameterPreset} generation profile · no provider request</small></div>
        </section>

        <section className="project-advanced-settings__card" aria-label="Context, memory and skills">
          <div className="project-advanced-settings__card-heading"><span className="eyebrow">03 · Workspace context</span><h3>Choose what this Project may use</h3></div>
          <label><span>Workspace context <small>Existing grants are unchanged</small></span><select value={values.contextMode} onChange={(event) => update("contextMode", event.target.value as ProjectContextMode)}><option value="no-roots">No roots</option><option value="read-only">Read-only roots</option><option value="metadata-only">Metadata only</option><option value="selected-files">Selected files</option></select></label>
          <label><span>Memory behavior <small>No durable memory lifecycle exists here</small></span><select value={values.memoryMode} onChange={(event) => update("memoryMode", event.target.value as ProjectMemoryMode)}><option value="off">Off</option><option value="propose">Suggest · review first</option><option value="auto-low-risk">Auto · low-risk preview</option><option value="custom">Custom</option></select></label>
          <label><span>Skills behavior <small>Does not install or inject skills</small></span><select value={values.skillMode} onChange={(event) => update("skillMode", event.target.value as ProjectSkillMode)}><option value="inherited">Inherit project catalog</option><option value="curated">Curated set</option><option value="manual">Manual only</option><option value="off">Off</option></select></label>
          <div className="project-advanced-settings__chip-row"><span>{CONTEXT_LABELS[values.contextMode]}</span><span>{MEMORY_LABELS[values.memoryMode]}</span><span>{SKILL_LABELS[values.skillMode]}</span></div>
        </section>

        <section className="project-advanced-settings__card" aria-label="Retention, export and lifecycle">
          <div className="project-advanced-settings__card-heading"><span className="eyebrow">04 · Data and lifecycle</span><h3>Set future handling preferences</h3></div>
          <label><span>Retention preference <small>Preference only; no deletion scheduler</small></span><select value={values.retention} onChange={(event) => update("retention", event.target.value as ProjectRetention)}><option value="forever">Until removed</option><option value="30-days">30 days</option><option value="90-days">90 days</option><option value="manual">Ask before cleanup</option></select></label>
          <label><span>Export default <small>Export content remains explicitly selected</small></span><select value={values.exportMode} onChange={(event) => update("exportMode", event.target.value as ProjectExportMode)}><option value="redacted">Redacted metadata</option><option value="metadata-excerpts">Metadata + excerpts</option><option value="custom">Custom selection</option></select></label>
          <label className="project-advanced-settings__lifecycle"><span><strong>Project lifecycle</strong><small>{values.lifecycle === "active" ? "Active in this preview" : "Archive intent preview; no conversations or data are moved"}</small></span><button type="button" className="button button--secondary" aria-label={values.lifecycle === "active" ? "Preview archive" : "Restore preview"} aria-pressed={values.lifecycle === "archived-preview"} onClick={() => update("lifecycle", values.lifecycle === "active" ? "archived-preview" : "active")}><Archive size={14} /> {values.lifecycle === "active" ? "Preview archive" : "Restore preview"}</button></label>
          <div className="project-advanced-settings__value-card"><span>Data defaults</span><strong>{RETENTION_LABELS[values.retention]} · {EXPORT_LABELS[values.exportMode]}</strong><small>Retention is not enforced · export includes no secret or raw file bytes.</small></div>
        </section>
      </div>

      <section className="project-advanced-settings__portable" aria-label="Import and export advanced Project settings">
        <div><span className="eyebrow">Portable preview</span><h3>Keep or move this settings draft</h3><p>Export contains only the visible typed settings vector and Project identity metadata.</p></div>
        <div className="project-advanced-settings__portable-actions hit-target-control">
          <button type="button" className="button button--secondary" onClick={() => downloadJson(`omnia-project-settings-${project.id}.json`, exportText)}><Download size={14} /> Export JSON</button>
          <button type="button" className="button button--secondary" onClick={() => void copyExport()}><Clipboard size={14} /> Copy JSON</button>
          <button type="button" className="button button--secondary" onClick={() => importInputRef.current?.click()}><Upload size={14} /> Import JSON</button>
          <input ref={importInputRef} type="file" accept="application/json,.json" aria-label="Import advanced Project settings JSON" onChange={(event) => void importFile(event)} hidden />
        </div>
        {importError ? <p className="project-advanced-settings__error" role="alert">{importError}</p> : null}
        <pre aria-label="Advanced Project settings JSON preview"><code>{exportText}</code></pre>
        <p className="project-advanced-settings__status" role="status" aria-live="polite">{status}</p>
      </section>

      <p className="project-advanced-settings__boundary">Renderer-session preview only. Changes never update Project metadata, SQLite, provider routing, workspace grants, native permissions, memory, skills, retention, archive state, or files.</p>
    </section>
  );
}

export default ProjectAdvancedSettingsPreview;
