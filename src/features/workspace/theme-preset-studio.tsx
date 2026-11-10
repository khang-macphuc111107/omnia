import {
  Check,
  Clipboard,
  Download,
  FileJson2,
  GitCompare,
  PackageOpen,
  Palette,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";

import {
  buildThemePresetBundle,
  parseThemePresetBundle,
  serializeThemePresetBundle,
  themePresetDifferenceKeys,
  type ThemePreset,
  type ThemePresetEnergy,
  type ThemePresetFormat,
  type ThemePresetGeometry,
  type ThemePresetRoleColors,
  type ThemePresetSignal,
  type ThemePresetSource,
  type ThemePresetSurface,
} from "./theme-preset-studio-contract";
import "@/styles/theme-preset-studio.css";

type StudioState = { presets: ThemePreset[]; selectedId: string; compareId: string };
type StudioHistory = { past: StudioState[]; present: StudioState; future: StudioState[] };

const BUILTIN_PRESETS: ThemePreset[] = [
  {
    id: "theme-coder-night", name: "Coder Night", description: "Dark-first blue, teal, amber, and coral signals for dense engineering sessions.", tags: ["coding", "dark", "balanced"], logoId: "logo-01-open-aperture", logoName: "Open aperture", paletteName: "Tidal Spectrum", surface: "graphite", geometry: "soft", signal: "soft-glow", energy: "balanced", roleColors: ["#2563EB", "#0F766E", "#D97706", "#E11D48"], source: "builtin", status: "active", updatedAt: "2026-09-27T00:00:00.000Z",
  },
  {
    id: "theme-terminal-mint", name: "Terminal Mint", description: "Crisp terminal geometry with mint progress signals and a low-noise canvas.", tags: ["terminal", "build", "focused"], logoId: "logo-07-corner-frame", logoName: "Corner frame", paletteName: "Terminal Teal", surface: "ink", geometry: "sharp", signal: "edge", energy: "expressive", roleColors: ["#23C6B8", "#149E92", "#F5B94C", "#FF7A7A"], source: "builtin", status: "preview", updatedAt: "2026-09-27T00:00:00.000Z",
  },
  {
    id: "theme-research-slate", name: "Research Slate", description: "Calmer slate surfaces and restrained signals for reading, notes, and long context.", tags: ["research", "reading", "quiet"], logoId: "logo-08-hex-ring", logoName: "Hex ring", paletteName: "Steel Signal", surface: "slate", geometry: "pill", signal: "solid", energy: "quiet", roleColors: ["#4F8CFF", "#19B7A5", "#E7A83C", "#EE6D8A"], source: "builtin", status: "preview", updatedAt: "2026-09-27T00:00:00.000Z",
  },
  {
    id: "theme-ember-review", name: "Ember Review", description: "Warm review accents with explicit alert and focus separation for code review.", tags: ["review", "alerts", "expressive"], logoId: "logo-12-diamond-gate", logoName: "Diamond gate", paletteName: "Ember Grid", surface: "graphite", geometry: "soft", signal: "solid", energy: "expressive", roleColors: ["#E07A3F", "#3F7DFF", "#D95D83", "#48B86B"], source: "builtin", status: "preview", updatedAt: "2026-09-27T00:00:00.000Z",
  },
  {
    id: "theme-command-cyan", name: "Command Cyan", description: "High-clarity cyan routing accents for command palettes, automation, and orchestration.", tags: ["automation", "routing", "high-clarity"], logoId: "logo-03-cli-prompt", logoName: "CLI prompt", paletteName: "Command Cyan", surface: "ink", geometry: "sharp", signal: "edge", energy: "balanced", roleColors: ["#38BDF8", "#0E9ED5", "#F5B94C", "#6EE7B7"], source: "builtin", status: "preview", updatedAt: "2026-09-27T00:00:00.000Z",
  },
];

const roleLabels = ["Primary", "Support", "Alert", "Focus"] as const;
const initialState: StudioState = { presets: BUILTIN_PRESETS, selectedId: BUILTIN_PRESETS[0]!.id, compareId: BUILTIN_PRESETS[1]!.id };

function clonePreset(preset: ThemePreset): ThemePreset {
  return { ...preset, tags: [...preset.tags], roleColors: [...preset.roleColors] as ThemePresetRoleColors };
}

function cloneState(state: StudioState): StudioState {
  return { presets: state.presets.map(clonePreset), selectedId: state.selectedId, compareId: state.compareId };
}

function sourceLabel(source: ThemePresetSource): string {
  return source === "builtin" ? "Built-in" : source === "session" ? "Session copy" : "Imported";
}

function downloadText(payload: string, format: ThemePresetFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-theme-presets-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the theme preset file."));
    reader.readAsText(file);
  });
}

export function ThemePresetStudio() {
  const [history, setHistory] = useState<StudioHistory>({ past: [], present: cloneState(initialState), future: [] });
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<ThemePresetSource | "all">("all");
  const [status, setStatus] = useState("Choose a theme preset to inspect and tune it in this renderer session.");
  const [format, setFormat] = useState<ThemePresetFormat>("json");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState("No bundle exported yet.");
  const [customName, setCustomName] = useState("");
  const [customTags, setCustomTags] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const draft = history.present;
  const selected = draft.presets.find((preset) => preset.id === draft.selectedId) ?? draft.presets[0] ?? null;
  const comparison = draft.presets.find((preset) => preset.id === draft.compareId && preset.id !== selected?.id) ?? null;
  const visiblePresets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return draft.presets.filter((preset) => {
      if (sourceFilter !== "all" && preset.source !== sourceFilter) return false;
      return !needle || [preset.name, preset.description, preset.logoName, preset.paletteName, ...preset.tags].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [draft.presets, query, sourceFilter]);
  const bundle = useMemo(() => buildThemePresetBundle({ presets: draft.presets, selectedPresetId: draft.selectedId }), [draft]);
  const payload = useMemo(() => serializeThemePresetBundle(bundle, format), [bundle, format]);
  const sampleStyle = selected ? {
    "--theme-primary": selected.roleColors[0],
    "--theme-support": selected.roleColors[1],
    "--theme-alert": selected.roleColors[2],
    "--theme-focus": selected.roleColors[3],
  } as CSSProperties : undefined;

  const commit = (next: StudioState, message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneState(current.present)], present: cloneState(next), future: [] }));
    setStatus(message);
  };

  const updateSelected = (patch: Partial<ThemePreset>, message: string) => {
    if (!selected) return;
    commit({ ...cloneState(draft), presets: draft.presets.map((preset) => preset.id === selected.id ? { ...clonePreset(preset), ...patch, updatedAt: new Date().toISOString() } : clonePreset(preset)) }, message);
  };

  const undo = () => setHistory((current) => current.past.length === 0 ? current : { past: current.past.slice(0, -1), present: cloneState(current.past[current.past.length - 1]!), future: [cloneState(current.present), ...current.future] });
  const redo = () => setHistory((current) => current.future.length === 0 ? current : { past: [...current.past, cloneState(current.present)], present: cloneState(current.future[0]!), future: current.future.slice(1) });
  const reset = () => {
    commit(cloneState(initialState), "Theme preset catalog reset to built-in renderer preview defaults.");
    setQuery("");
    setSourceFilter("all");
  };

  const saveCustom = () => {
    if (!selected) return;
    const name = customName.trim() || `${selected.name} copy`;
    const id = `theme-session-${Date.now()}`;
    const custom: ThemePreset = { ...clonePreset(selected), id, name, tags: [...new Set([...selected.tags, ...customTags.split(",").map((tag) => tag.trim()).filter(Boolean)])].slice(0, 12), source: "session", status: "preview", updatedAt: new Date().toISOString() };
    commit({ presets: [...draft.presets.map(clonePreset), custom], selectedId: id, compareId: selected.id }, `${name} saved as a renderer-local theme preset.`);
    setCustomName("");
    setCustomTags("");
  };

  const removePreset = (presetId = selected?.id) => {
    const target = draft.presets.find((preset) => preset.id === presetId);
    if (!target || target.source === "builtin") return;
    const remaining = draft.presets.filter((preset) => preset.id !== target.id);
    const fallback = remaining[0];
    commit({ presets: remaining, selectedId: fallback?.id ?? "", compareId: remaining.find((preset) => preset.id !== fallback?.id)?.id ?? "" }, `${target.name} removed from this renderer session.`);
  };

  const copyPayload = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no bundle was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setExportStatus(`Copied the renderer-local ${format.toUpperCase()} theme preset bundle.`);
    } catch {
      setExportStatus("Clipboard access was denied; no bundle was copied.");
    }
  };

  const importFile = async (file: File) => {
    let result;
    try {
      result = parseThemePresetBundle(await readText(file));
    } catch {
      setStatus("The theme preset file could not be read; no changes were staged.");
      return;
    }
    if (!result.ok) {
      setStatus(result.error);
      return;
    }
    const imported = result.bundle.presets.map((preset) => ({ ...clonePreset(preset), source: "imported" as const, status: "preview" as const }));
    const ids = new Set(draft.presets.map((preset) => preset.id));
    const safe = imported.map((preset, index) => ids.has(preset.id) ? { ...preset, id: `imported-${Date.now()}-${index}-${preset.id}` } : preset);
    const nextSelected = safe[0]?.id ?? draft.selectedId;
    commit({ presets: [...draft.presets.map(clonePreset), ...safe], selectedId: nextSelected, compareId: draft.selectedId }, `Imported ${safe.length} theme preset${safe.length === 1 ? "" : "s"} into this renderer session.`);
    setImportOpen(false);
  };

  if (!selected) return null;

  return (
    <section className="theme-preset-studio settings-section" aria-labelledby="theme-preset-studio-title">
      <header className="theme-preset-studio__header">
        <span className="theme-preset-studio__mark" aria-hidden="true"><Palette size={18} /></span>
        <div><span className="eyebrow">Theme preset studio · renderer preview</span><h2 id="theme-preset-studio-title">Compose a complete Omnia look</h2><p>Pair logo direction, palette roles, surfaces, geometry, and signal treatment into a reusable visual preset.</p></div>
        <span className="theme-preset-studio__badge"><Sparkles size={13} aria-hidden="true" /> Preview only</span>
      </header>

      <div className="theme-preset-studio__boundary" role="note"><ShieldCheck size={16} aria-hidden="true" /><span>Renderer-local · reversible in this session · no durable write · no provider request · no native theme mutation.</span></div>

      <div className="theme-preset-studio__toolbar" role="toolbar" aria-label="Theme preset studio controls">
        <label className="theme-preset-studio__search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search theme presets</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search themes, palettes, logos, tags…" aria-label="Search theme presets" /></label>
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as ThemePresetSource | "all")} aria-label="Theme preset source filter"><option value="all">All sources</option><option value="builtin">Built-in</option><option value="session">Session copies</option><option value="imported">Imported</option></select>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo theme preset change"><Undo2 size={14} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo theme preset change"><Redo2 size={14} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset theme preset studio"><RotateCcw size={14} /> Reset</button>
      </div>

      <div className="theme-preset-studio__layout">
        <section className="theme-preset-studio__catalog" aria-label="Theme preset catalog">
          <header><span><strong>{visiblePresets.length} visible preset{visiblePresets.length === 1 ? "" : "s"}</strong><small>Select a preset to tune or compare it.</small></span><span>{draft.presets.length} in session</span></header>
          <div className="theme-preset-studio__cards" role="list">
            {visiblePresets.map((preset) => {
              const active = preset.id === selected.id;
              return <article key={preset.id} className={active ? "theme-preset-card is-selected" : "theme-preset-card"} role="listitem">
                <button type="button" className="theme-preset-card__select" onClick={() => commit({ ...cloneState(draft), selectedId: preset.id }, `${preset.name} selected for theme preview.`)} aria-pressed={active} aria-label={`Select ${preset.name} theme preset`}>
                  <span className="theme-preset-card__swatches">{preset.roleColors.map((color) => <i key={color} style={{ background: color }} />)}</span>
                  <span className="theme-preset-card__copy"><strong>{preset.name}</strong><small>{preset.description}</small><span>{preset.tags.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}</span></span>
                  <span className={`theme-preset-card__status status-${preset.status}`}>{preset.status}</span>
                  {active ? <Check size={14} aria-label="Selected" /> : null}
                </button>
                {preset.source !== "builtin" ? <button type="button" className="theme-preset-card__remove" onClick={() => removePreset(preset.id)} aria-label={`Remove ${preset.name} theme preset`}><Trash2 size={13} /></button> : null}
              </article>;
            })}
          </div>
        </section>

        <section className="theme-preset-studio__detail" aria-label="Selected theme preset detail">
          <header><div><span className="eyebrow">Selected preset</span><h3>{selected.name}</h3><p>{selected.description}</p></div><span className="theme-preset-studio__source">{sourceLabel(selected.source)}</span></header>
          <div className="theme-preset-studio__meta"><span><b>Logo</b>{selected.logoName}</span><span><b>Palette</b>{selected.paletteName}</span><span><b>Tags</b>{selected.tags.length}</span></div>
          <div className="theme-preset-studio__controls">
            <label><span>Surface</span><select value={selected.surface} onChange={(event) => updateSelected({ surface: event.target.value as ThemePresetSurface }, `Surface set to ${event.target.value}.`)} aria-label="Theme preset surface"><option value="graphite">Graphite</option><option value="slate">Slate</option><option value="ink">Ink</option></select></label>
            <label><span>Geometry</span><select value={selected.geometry} onChange={(event) => updateSelected({ geometry: event.target.value as ThemePresetGeometry }, `Geometry set to ${event.target.value}.`)} aria-label="Theme preset geometry"><option value="sharp">Sharp</option><option value="soft">Soft</option><option value="pill">Pill</option></select></label>
            <label><span>Signal</span><select value={selected.signal} onChange={(event) => updateSelected({ signal: event.target.value as ThemePresetSignal }, `Signal treatment set to ${event.target.value}.`)} aria-label="Theme preset signal"><option value="solid">Solid</option><option value="soft-glow">Soft glow</option><option value="edge">Edge</option></select></label>
            <label><span>Energy</span><select value={selected.energy} onChange={(event) => updateSelected({ energy: event.target.value as ThemePresetEnergy }, `Accent energy set to ${event.target.value}.`)} aria-label="Theme preset energy"><option value="quiet">Quiet</option><option value="balanced">Balanced</option><option value="expressive">Expressive</option></select></label>
          </div>
          <div className="theme-preset-studio__roles" aria-label="Theme preset role colors">
            {roleLabels.map((label, index) => <label key={label}><span>{label}</span><input type="color" value={selected.roleColors[index]} onChange={(event) => { const colors = [...selected.roleColors] as ThemePresetRoleColors; colors[index] = event.target.value.toUpperCase(); updateSelected({ roleColors: colors }, `${label} color updated.`); }} aria-label={`${label} theme role color`} /><code>{selected.roleColors[index]}</code></label>)}
          </div>
          <div className={`theme-preset-studio__sample sample-${selected.surface} sample-${selected.geometry} sample-${selected.signal}`} style={sampleStyle} aria-label="Theme preset visual sample">
            <div className="theme-preset-studio__sample-rail"><span /><span /><span /><span /></div><div className="theme-preset-studio__sample-main"><div><strong><span className="theme-preset-studio__sample-logo"><PackageOpen size={15} /></span>Omnia / {selected.name}</strong><em>{selected.energy}</em></div><div className="theme-preset-studio__sample-grid">{roleLabels.map((label, index) => <article key={label}><small>{label}</small><strong>{selected.roleColors[index]}</strong></article>)}</div></div>
          </div>
          <div className="theme-preset-studio__actions"><button type="button" className="button button--secondary" onClick={() => updateSelected({ status: "active" }, `${selected.name} staged as the active renderer preview; no native theme changed.`)}><Check size={14} /> Stage preview</button><button type="button" className="button button--ghost" onClick={() => { setCustomName(`${selected.name} copy`); setCustomTags(selected.tags.join(", ")); }}><Plus size={14} /> Prepare copy</button>{selected.source !== "builtin" ? <button type="button" className="button button--ghost" onClick={() => removePreset()}><Trash2 size={14} /> Remove</button> : null}</div>

          <label className="theme-preset-studio__compare"><span><GitCompare size={14} /> Compare with</span><select value={draft.compareId} onChange={(event) => setHistory((current) => ({ ...current, present: { ...cloneState(current.present), compareId: event.target.value } }))} aria-label="Compare theme preset with"><option value="">No comparison</option>{draft.presets.filter((preset) => preset.id !== selected.id).map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
          {comparison ? <div className="theme-preset-studio__diff" role="region" aria-label="Theme preset comparison"><header><strong>{comparison.name}</strong><span>{themePresetDifferenceKeys(selected, comparison).length} style differences</span></header><div className="theme-preset-studio__diff-grid">{([["Surface", selected.surface, comparison.surface], ["Geometry", selected.geometry, comparison.geometry], ["Signal", selected.signal, comparison.signal], ["Energy", selected.energy, comparison.energy], ["Logo", selected.logoName, comparison.logoName], ["Palette", selected.paletteName, comparison.paletteName]] as const).map(([label, current, other]) => <div key={label} className={current === other ? "is-same" : "is-different"}><span>{label}</span><strong>{current}</strong><small>{comparison.name}: {other}</small></div>)}</div></div> : null}
        </section>
      </div>

      <section className="theme-preset-studio__authoring" aria-label="Save custom theme preset"><header><div><span className="eyebrow">Preset authoring</span><h3>Save a tuned variant</h3><p>Copy the selected composition into a renderer-session preset and add your own tags.</p></div><Plus size={16} aria-hidden="true" /></header><div><label><span>Name</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. Rust reviewer" aria-label="Custom theme preset name" /></label><label><span>Extra tags</span><input value={customTags} onChange={(event) => setCustomTags(event.target.value)} placeholder="rust, review, local" aria-label="Custom theme preset tags" /></label><button type="button" className="button button--secondary" onClick={saveCustom}><Plus size={14} /> Save session preset</button></div></section>

      <section className="theme-preset-studio__export" aria-label="Theme preset bundle export"><div className="theme-preset-studio__export-head"><div><span className="eyebrow">Portable catalog</span><h3>Export or import theme presets</h3><p>Use JSON for round trips or Markdown for a readable review handoff.</p></div><span role="status" aria-live="polite">{exportStatus}</span></div><div className="theme-preset-studio__export-actions"><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as ThemePresetFormat)} aria-label="Theme preset export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><input ref={importRef} type="file" accept="application/json,.json" hidden aria-label="Import theme preset bundle" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} /><button type="button" className="button button--ghost" onClick={() => setImportOpen((value) => !value)} aria-expanded={importOpen}>{importOpen ? <X size={14} /> : <Upload size={14} />} {importOpen ? "Hide import" : "Import JSON"}</button><button type="button" className="button button--secondary" onClick={() => setPreviewOpen((value) => !value)} aria-expanded={previewOpen}>{previewOpen ? <X size={14} /> : <FileJson2 size={14} />} {previewOpen ? "Hide bundle" : "Inspect bundle"}</button><button type="button" className="button button--ghost" onClick={() => void copyPayload()}><Clipboard size={14} /> Copy</button><button type="button" className="button button--ghost" onClick={() => setExportStatus(downloadText(payload, format) ? "Browser download started; no native preset file was written." : "Browser download is unavailable; no file was written.")}><Download size={14} /> Download</button></div>{importOpen ? <div className="theme-preset-studio__import"><p>Select an Omnia theme preset JSON bundle. Imported entries are appended as preview-only session copies.</p><button type="button" className="button button--secondary" onClick={() => importRef.current?.click()}>Choose JSON file</button></div> : null}{previewOpen ? <pre aria-label="Theme preset bundle payload"><code>{payload}</code></pre> : null}</section>

      <p className="theme-preset-studio__status" role="status" aria-live="polite">{status}</p>
      <p className="theme-preset-studio__footer"><ShieldCheck size={13} aria-hidden="true" /> Theme presets are renderer-session metadata only. Staging a preview does not change native tokens, app icons, provider routing, permissions, files, or durable profile settings.</p>
    </section>
  );
}

export default ThemePresetStudio;
