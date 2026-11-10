import {
  Archive,
  Check,
  Clipboard,
  Download,
  FileJson,
  FolderOpen,
  GitCompare,
  History,
  Import,
  Layers3,
  LayoutDashboard,
  MessageSquareText,
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
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useWorkspaceStore } from "./store";
import {
  buildWorkspacePresetBundle,
  findWorkspacePresetImportConflicts,
  parseWorkspacePresetBundle,
  serializeWorkspacePresetBundle,
  type WorkspacePreset,
  type WorkspacePresetBundle,
  type WorkspacePresetFormat,
  type WorkspacePresetImportConflictPolicy,
  type WorkspacePresetKind,
} from "./workspace-preset-lab-contract";
import type { WorkspacePresetStatus } from "./workspace-preset-lab-contract";
import "@/styles/workspace-preset-lab.css";

type PresetState = {
  presets: WorkspacePreset[];
  selectedId: string;
  compareId: string;
};

type PresetHistory = {
  past: PresetState[];
  present: PresetState;
  future: PresetState[];
};

type PresetLifecycleKind = "change" | "review" | "export";

type PresetLifecycleEntry = {
  id: string;
  at: string;
  kind: PresetLifecycleKind;
  message: string;
  presetCount: number;
  selectedName: string;
};

const KIND_LABELS: Record<WorkspacePresetKind | "all", string> = {
  all: "All presets",
  workspace: "Workspace",
  project: "Project",
  chat: "Chat",
  permissions: "Permissions",
  appearance: "Appearance",
  export: "Export",
};

const KIND_ICONS: Record<WorkspacePresetKind | "all", LucideIcon> = {
  all: Layers3,
  workspace: LayoutDashboard,
  project: FolderOpen,
  chat: MessageSquareText,
  permissions: ShieldCheck,
  appearance: Palette,
  export: Download,
};

const STATUS_LABELS: Record<WorkspacePresetStatus, string> = {
  active: "Active",
  preview: "Preview",
  planned: "Planned",
};

const BUILT_IN_PRESETS: WorkspacePreset[] = [
  {
    id: "workspace-coder",
    name: "Coder cockpit",
    kind: "workspace",
    description: "Fast keyboard-first defaults for coding, review, and local project navigation.",
    tags: ["coding", "focused", "dark"],
    updatedAt: "2026-09-21T00:00:00.000Z",
    values: { Theme: "Graphite dark", Density: "Comfortable", "Default route": "Balanced", "Shortcut hints": "Visible" },
    status: "active",
    source: "builtin",
  },
  {
    id: "project-research",
    name: "Research desk",
    kind: "project",
    description: "Evidence-first project context with deliberate reasoning and review checkpoints.",
    tags: ["research", "citations", "review"],
    updatedAt: "2026-09-21T00:00:00.000Z",
    values: { "Model route": "Quality first", Memory: "Suggestions require approval", Skills: "Evidence-first pack", Export: "Redacted preview" },
    status: "preview",
    source: "builtin",
  },
  {
    id: "chat-draft",
    name: "Draft sprint",
    kind: "chat",
    description: "A lightweight chat setup for iterating quickly without changing project defaults.",
    tags: ["chat", "drafting", "fast"],
    updatedAt: "2026-09-21T00:00:00.000Z",
    values: { Mode: "Create", Parameters: "Balanced", "Draft retention": "Session-only", "Review gate": "Ask before external action" },
    status: "preview",
    source: "builtin",
  },
  {
    id: "permissions-review",
    name: "Review gates",
    kind: "permissions",
    description: "A cautious capability posture that keeps every native action behind an explicit review.",
    tags: ["permissions", "safe", "review"],
    updatedAt: "2026-09-21T00:00:00.000Z",
    values: { Workspace: "Prompt", Project: "Prompt", Chat: "Prompt", Run: "Deny by default" },
    status: "preview",
    source: "builtin",
  },
  {
    id: "appearance-build-amber",
    name: "Build Amber",
    kind: "appearance",
    description: "Modern coder-oriented contrast with a warm amber command accent.",
    tags: ["brand", "amber", "contrast"],
    updatedAt: "2026-09-21T00:00:00.000Z",
    values: { Theme: "Dark", Accent: "#E7A23C", Surface: "Graphite", Motion: "System" },
    status: "active",
    source: "builtin",
  },
  {
    id: "export-portable",
    name: "Portable handoff",
    kind: "export",
    description: "A compact, redacted metadata package for moving work between Omnia previews.",
    tags: ["portable", "handoff", "redacted"],
    updatedAt: "2026-09-21T00:00:00.000Z",
    values: { Scope: "Active project", Format: "JSON", Redaction: "Safe preview", Attachments: "Metadata only" },
    status: "planned",
    source: "builtin",
  },
];

const INITIAL_STATE: PresetState = {
  presets: BUILT_IN_PRESETS,
  selectedId: "workspace-coder",
  compareId: "project-research",
};

function cloneState(state: PresetState): PresetState {
  return {
    presets: state.presets.map((preset) => ({ ...preset, tags: [...preset.tags], values: { ...preset.values } })),
    selectedId: state.selectedId,
    compareId: state.compareId,
  };
}

let lifecycleSequence = 0;

function createLifecycleEntry(message: string, state: PresetState, kind: PresetLifecycleKind = "change"): PresetLifecycleEntry {
  return {
    id: `preset-lifecycle-${Date.now()}-${lifecycleSequence++}`,
    at: new Date().toISOString(),
    kind,
    message,
    presetCount: state.presets.length,
    selectedName: state.presets.find((preset) => preset.id === state.selectedId)?.name ?? "No selected preset",
  };
}

function lifecycleTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The preset bundle could not be read."));
    reader.readAsText(file);
  });
}

function downloadText(payload: string, format: WorkspacePresetFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workspace-presets-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function sameKeys(left: WorkspacePreset, right: WorkspacePreset): string[] {
  return [...new Set([...Object.keys(left.values), ...Object.keys(right.values)])].sort();
}

export function WorkspacePresetLab() {
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const activeProject = useWorkspaceStore((state) => state.projects.find((project) => project.id === activeProjectId));
  const activeConversation = useWorkspaceStore((state) => state.conversations.find((conversation) => conversation.id === activeConversationId));
  const [history, setHistory] = useState<PresetHistory>({ past: [], present: cloneState(INITIAL_STATE), future: [] });
  const [lifecycleHistory, setLifecycleHistory] = useState<PresetLifecycleEntry[]>(() => [createLifecycleEntry("Preset catalog initialized from built-in defaults.", INITIAL_STATE)]);
  const [kindFilter, setKindFilter] = useState<WorkspacePresetKind | "all">("all");
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState<WorkspacePresetFormat>("json");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [status, setStatus] = useState("Preset changes stay in this renderer session until a native settings contract exists.");
  const [exportStatus, setExportStatus] = useState("No preset bundle has been exported.");
  const [customName, setCustomName] = useState("");
  const [customKind, setCustomKind] = useState<WorkspacePresetKind>("workspace");
  const [customTags, setCustomTags] = useState("");
  const [stagedImport, setStagedImport] = useState<WorkspacePresetBundle | null>(null);
  const [importPolicy, setImportPolicy] = useState<WorkspacePresetImportConflictPolicy>("keep-both");
  const importRef = useRef<HTMLInputElement>(null);

  const draft = history.present;
  const selected = draft.presets.find((preset) => preset.id === draft.selectedId) ?? draft.presets[0] ?? null;
  const comparison = draft.presets.find((preset) => preset.id === draft.compareId) ?? null;
  const visiblePresets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return draft.presets.filter((preset) => {
      if (kindFilter !== "all" && preset.kind !== kindFilter) return false;
      if (!normalizedQuery) return true;
      return [preset.name, preset.description, preset.kind, ...preset.tags].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [draft.presets, kindFilter, query]);
  const kindCounts = useMemo(() => {
    return (Object.keys(KIND_LABELS) as Array<WorkspacePresetKind | "all">).reduce<Record<string, number>>((counts, key) => {
      counts[key] = key === "all" ? draft.presets.length : draft.presets.filter((preset) => preset.kind === key).length;
      return counts;
    }, {});
  }, [draft.presets]);
  const bundle = useMemo(() => buildWorkspacePresetBundle({ presets: draft.presets, selectedPresetId: draft.selectedId }), [draft.presets, draft.selectedId]);
  const payload = useMemo(() => serializeWorkspacePresetBundle(bundle, format), [bundle, format]);
  const stagedConflicts = useMemo(
    () => stagedImport ? findWorkspacePresetImportConflicts(draft.presets, stagedImport.presets) : [],
    [draft.presets, stagedImport],
  );

  const recordLifecycle = (message: string, state: PresetState = draft, kind: PresetLifecycleKind = "change") => {
    setLifecycleHistory((current) => [...current, createLifecycleEntry(message, state, kind)].slice(-40));
  };

  const commit = (next: PresetState, nextStatus: string) => {
    setHistory((current) => ({ past: [...current.past, cloneState(current.present)].slice(-20), present: cloneState(next), future: [] }));
    recordLifecycle(nextStatus, next);
    setStatus(nextStatus);
  };

  const selectPreset = (id: string) => {
    if (id === draft.selectedId) return;
    commit({ ...cloneState(draft), selectedId: id }, `Selected ${draft.presets.find((preset) => preset.id === id)?.name ?? "preset"} for this renderer preview.`);
  };

  const saveCustom = () => {
    const name = customName.trim();
    if (!name) return;
    const base = selected ?? BUILT_IN_PRESETS[0]!;
    const id = `session-${Date.now()}-${slugify(name)}`;
    const custom: WorkspacePreset = {
      ...base,
      id,
      name,
      kind: customKind,
      tags: [...new Set(customTags.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 12),
      updatedAt: new Date().toISOString(),
      source: "session",
      status: "preview",
      description: `Renderer-local snapshot based on ${base.name}.`,
    };
    commit({ presets: [...draft.presets, custom], selectedId: id, compareId: base.id }, `${name} saved as a renderer-local custom preset.`);
    setCustomName("");
    setCustomTags("");
  };

  const removeCustom = (preset: WorkspacePreset) => {
    if (preset.source === "builtin") return;
    const remaining = draft.presets.filter((candidate) => candidate.id !== preset.id);
    const fallback = remaining.find((candidate) => candidate.source === "builtin") ?? remaining[0];
    if (!fallback) return;
    commit({ ...cloneState(draft), presets: remaining, selectedId: draft.selectedId === preset.id ? fallback.id : draft.selectedId, compareId: draft.compareId === preset.id ? fallback.id : draft.compareId }, `${preset.name} removed from this renderer session.`);
  };

  const undo = () => {
    const previous = history.past.at(-1);
    if (!previous) return;
    setHistory((current) => ({ past: current.past.slice(0, -1), present: cloneState(previous), future: [cloneState(current.present), ...current.future] }));
    recordLifecycle("Undid the last workspace preset change.", previous);
    setStatus("Undid the last workspace preset change.");
  };

  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory((current) => ({ past: [...current.past, cloneState(current.present)], present: cloneState(next), future: current.future.slice(1) }));
    recordLifecycle("Reapplied the next workspace preset change.", next);
    setStatus("Reapplied the next workspace preset change.");
  };

  const clearLifecycleHistory = () => {
    setLifecycleHistory([]);
    setStatus("Preset lifecycle history cleared; the current catalog is unchanged.");
  };

  const reset = () => {
    commit(cloneState(INITIAL_STATE), "Preset catalog reset to the built-in renderer preview defaults.");
  };

  const copyPayload = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no preset bundle was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setExportStatus(`Copied the renderer-local ${format.toUpperCase()} preset bundle.`);
      recordLifecycle(`Copied the renderer-local ${format.toUpperCase()} preset bundle.`, draft, "export");
    } catch {
      setExportStatus("Clipboard access was denied; no preset bundle was copied.");
    }
  };

  const importFile = async (file: File) => {
    try {
      const result = parseWorkspacePresetBundle(await readFileText(file));
      if (!result.ok) throw new Error(result.error);
      setStagedImport(result.bundle);
      const message = `Staged ${result.bundle.presets.length} imported preset${result.bundle.presets.length === 1 ? "" : "s"} for review.`;
      recordLifecycle(message, draft, "review");
      setStatus(message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Preset import failed closed; no changes were staged.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const applyImport = () => {
    if (!stagedImport) return;
    const conflictByIncomingId = new Map(stagedConflicts.map((conflict) => [conflict.incoming.id, conflict]));
    const blockedExistingIds = new Set<string>();
    const usedIds = new Set(draft.presets.map((preset) => preset.id));
    const imported: WorkspacePreset[] = [];
    let skipped = 0;
    let replaced = 0;
    let builtinFallbacks = 0;
    const importStamp = Date.now();
    stagedImport.presets.forEach((preset, index) => {
      const conflict = conflictByIncomingId.get(preset.id);
      if (conflict && importPolicy === "skip-duplicates") {
        skipped += 1;
        return;
      }
      if (conflict && importPolicy === "replace-session" && conflict.canReplace) {
        blockedExistingIds.add(conflict.existing.id);
        replaced += 1;
      } else if (conflict && importPolicy === "replace-session" && !conflict.canReplace) {
        builtinFallbacks += 1;
      }
      const baseId = `imported-${importStamp}-${index}-${slugify(preset.name)}`;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
      usedIds.add(id);
      imported.push({
        ...preset,
        id,
        source: "imported",
        status: preset.status === "active" ? "preview" : preset.status,
      });
    });
    const remaining = draft.presets.filter((preset) => !blockedExistingIds.has(preset.id));
    const first = imported[0];
    const nextSelectedId = first?.id ?? draft.selectedId;
    const nextCompareId = blockedExistingIds.has(draft.compareId) ? (remaining.find((preset) => preset.id !== nextSelectedId)?.id ?? nextSelectedId) : draft.compareId;
    commit({ presets: [...remaining, ...imported], selectedId: nextSelectedId, compareId: nextCompareId }, `Applied ${imported.length} imported preset${imported.length === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}${replaced ? `, replaced ${replaced}` : ""}${builtinFallbacks ? `, kept ${builtinFallbacks} built-in conflict${builtinFallbacks === 1 ? "" : "s"}` : ""} in the renderer session.`);
    setStagedImport(null);
  };

  const exportPayload = () => {
    const downloaded = downloadText(payload, format);
    const message = downloaded ? "Browser download started; no native preset file was written." : "Browser download is unavailable; no preset file was written.";
    if (downloaded) recordLifecycle(`Exported the renderer-local ${format.toUpperCase()} preset bundle.`, draft, "export");
    setExportStatus(message);
  };

  return (
    <section className="workspace-preset-lab settings-section" aria-labelledby="workspace-preset-lab-title">
      <header className="workspace-preset-lab__header">
        <span className="workspace-preset-lab__mark" aria-hidden="true"><PackageOpen size={18} /></span>
        <div>
          <span className="eyebrow">Preset control plane · renderer preview</span>
          <h2 id="workspace-preset-lab-title">Workspace Preset Lab</h2>
          <p>Collect reusable workspace, project, chat, permission, appearance, and export starting points in one inspectable catalog.</p>
        </div>
        <span className="workspace-preset-lab__badge"><Sparkles size={13} aria-hidden="true" /> Preview only</span>
      </header>

      <div className="workspace-preset-lab__boundary" role="note">
        <ShieldCheck size={16} aria-hidden="true" /> <span>Renderer-local · reversible in this session · no durable write · no provider request · no permission grant. Native preset storage and sync remain Planned.</span>
      </div>

      <div className="workspace-preset-lab__context" aria-label="Current workspace context">
        <span><strong>{activeProject?.name ?? "Standalone workspace"}</strong><small>Current project context</small></span>
        <span><strong>{activeConversation?.title ?? "No active chat"}</strong><small>Current chat context</small></span>
        <span><strong>{draft.presets.length}</strong><small>Presets in session</small></span>
        <span><strong>{history.past.length + history.future.length}</strong><small>History steps</small></span>
      </div>

      <div className="workspace-preset-lab__toolbar" role="toolbar" aria-label="Workspace preset catalog controls">
        <label className="workspace-preset-lab__search"><Search size={14} aria-hidden="true" /><span className="sr-only">Search presets</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search presets, tags, or values…" aria-label="Search presets" /></label>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo workspace preset change"><Undo2 size={14} aria-hidden="true" /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo workspace preset change"><Redo2 size={14} aria-hidden="true" /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset workspace preset catalog"><RotateCcw size={14} aria-hidden="true" /> Reset</button>
        <button type="button" className="button button--secondary" onClick={() => importRef.current?.click()}><Import size={14} aria-hidden="true" /> Import bundle</button>
        <input ref={importRef} className="sr-only" type="file" accept="application/json,.json" aria-label="Import workspace preset bundle" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
      </div>

      <div className="workspace-preset-lab__filters" role="tablist" aria-label="Preset categories">
        {(Object.keys(KIND_LABELS) as Array<WorkspacePresetKind | "all">).map((kind) => {
          const Icon = KIND_ICONS[kind];
          return <button key={kind} type="button" role="tab" aria-selected={kindFilter === kind} className={kindFilter === kind ? "workspace-preset-filter is-active" : "workspace-preset-filter"} onClick={() => setKindFilter(kind)}><Icon size={14} aria-hidden="true" />{KIND_LABELS[kind]}<b>{kindCounts[kind]}</b></button>;
        })}
      </div>

      <div className="workspace-preset-lab__layout">
        <section className="workspace-preset-lab__catalog" aria-label="Workspace preset catalog">
          <header><span><strong>{visiblePresets.length} visible preset{visiblePresets.length === 1 ? "" : "s"}</strong><small>Select one to inspect values and compare it with another preset.</small></span><span className="workspace-preset-lab__catalog-hint">{kindFilter === "all" ? "All categories" : KIND_LABELS[kindFilter]}</span></header>
          <div className="workspace-preset-lab__cards" role="list">
            {visiblePresets.length === 0 ? <p className="workspace-preset-lab__empty">No presets match this search.</p> : visiblePresets.map((preset) => {
              const selectedPreset = selected?.id === preset.id;
              const Icon = KIND_ICONS[preset.kind];
              return <article key={preset.id} className={selectedPreset ? "workspace-preset-card is-selected" : "workspace-preset-card"} role="listitem">
                <button type="button" className="workspace-preset-card__select" onClick={() => selectPreset(preset.id)} aria-pressed={selectedPreset} aria-label={`Select ${preset.name} preset`}>
                  <span className="workspace-preset-card__icon" aria-hidden="true"><Icon size={16} aria-hidden="true" /></span>
                  <span className="workspace-preset-card__copy"><strong>{preset.name}</strong><small>{preset.description}</small><span>{preset.tags.map((tag) => <em key={tag}>{tag}</em>)}</span></span>
                  <span className={`workspace-preset-card__status status-${preset.status}`}>{STATUS_LABELS[preset.status]}</span>
                </button>
                {preset.source !== "builtin" ? <button type="button" className="workspace-preset-card__remove" onClick={() => removeCustom(preset)} aria-label={`Remove ${preset.name} preset`} title={`Remove ${preset.name}`}><Trash2 size={13} aria-hidden="true" /></button> : null}
              </article>;
            })}
          </div>
        </section>

        <section className="workspace-preset-lab__detail" aria-label="Selected workspace preset detail">
          {selected ? <>
            <header><div><span className="eyebrow">Selected preset</span><h3>{selected.name}</h3><p>{selected.description}</p></div><span className={`workspace-preset-card__status status-${selected.status}`}>{STATUS_LABELS[selected.status]}</span></header>
            <div className="workspace-preset-lab__detail-meta"><span>{KIND_LABELS[selected.kind]}</span><span>{selected.source === "builtin" ? "Built-in" : "Session copy"}</span><span>{selected.tags.length} tags</span></div>
            <dl className="workspace-preset-lab__values">{Object.entries(selected.values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
            <label className="workspace-preset-lab__compare"><span><GitCompare size={14} aria-hidden="true" /> Compare with</span><select value={draft.compareId} onChange={(event) => commit({ ...cloneState(draft), compareId: event.target.value }, `Comparison target changed to ${draft.presets.find((preset) => preset.id === event.target.value)?.name ?? "preset"}.`)} aria-label="Compare selected preset with"><option value="">No comparison</option>{draft.presets.filter((preset) => preset.id !== selected.id).map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
            {comparison ? <div className="workspace-preset-lab__diff" aria-label="Preset comparison"><header><strong>Compare values</strong><span>{sameKeys(selected, comparison).filter((key) => selected.values[key] !== comparison.values[key]).length} differences</span></header><div className="workspace-preset-lab__diff-grid">{sameKeys(selected, comparison).map((key) => <div key={key} className={selected.values[key] === comparison.values[key] ? "is-same" : "is-different"}><span>{key}</span><strong>{selected.values[key] ?? "Not set"}</strong><small>{comparison.name}: {comparison.values[key] ?? "Not set"}</small></div>)}</div></div> : null}
          </> : <p className="workspace-preset-lab__empty">Select a preset to inspect it.</p>}
        </section>
      </div>

      <section className="workspace-preset-lab__history" aria-labelledby="workspace-preset-lab-history-title">
        <header>
          <div><span className="eyebrow">Renderer-session timeline</span><h3 id="workspace-preset-lab-history-title">Preset lifecycle history</h3><p>Inspect recent catalog actions, including review and export events, without implying durable settings writes.</p></div>
          <div className="workspace-preset-lab__history-actions"><span className="workspace-preset-lab__history-badge">{lifecycleHistory.length} event{lifecycleHistory.length === 1 ? "" : "s"}</span><button type="button" className="button button--ghost" onClick={clearLifecycleHistory} disabled={lifecycleHistory.length === 0} aria-label="Clear workspace preset lifecycle history"><RotateCcw size={13} aria-hidden="true" /> Clear</button></div>
        </header>
        {lifecycleHistory.length > 0 ? <ol className="workspace-preset-lab__timeline" aria-label="Workspace preset lifecycle events">{[...lifecycleHistory].reverse().slice(0, 8).map((entry, index) => <li key={entry.id} className={`workspace-preset-lab__timeline-entry is-${entry.kind}`}>
          <span className="workspace-preset-lab__timeline-marker" aria-hidden="true"><History size={13} /></span>
          <div><strong>{index === 0 ? "Current" : entry.message}</strong>{index === 0 ? <small>{entry.message}</small> : null}<span>{lifecycleTime(entry.at)} · {entry.presetCount} preset{entry.presetCount === 1 ? "" : "s"} · selected {entry.selectedName}</span></div>
        </li>)}</ol> : <p className="workspace-preset-lab__history-empty">No lifecycle events retained. The current renderer catalog is unchanged.</p>}
        <p className="workspace-preset-lab__history-boundary"><ShieldCheck size={13} aria-hidden="true" /> Timeline entries are renderer-session metadata only; clearing history does not reset the catalog, write native files, or call a provider.</p>
      </section>

      <section className="workspace-preset-lab__authoring" aria-label="Save custom workspace preset">
        <header><div><span className="eyebrow">Preset authoring</span><h3>Capture a custom starting point</h3></div><Plus size={16} aria-hidden="true" /></header>
        <div className="workspace-preset-lab__authoring-grid">
          <label><span>Name</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="e.g. TypeScript reviewer" aria-label="Custom preset name" /></label>
          <label><span>Category</span><select value={customKind} onChange={(event) => setCustomKind(event.target.value as WorkspacePresetKind)} aria-label="Custom preset category">{(Object.keys(KIND_LABELS).filter((key) => key !== "all") as WorkspacePresetKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}</select></label>
          <label><span>Tags</span><input value={customTags} onChange={(event) => setCustomTags(event.target.value)} placeholder="coding, review, local" aria-label="Custom preset tags" /></label>
          <button type="button" className="button button--secondary" onClick={saveCustom} disabled={!customName.trim()}><Plus size={14} aria-hidden="true" /> Save from selected</button>
        </div>
        <small className="workspace-preset-lab__authoring-note">The selected preset values are copied into the new session preset; edit the underlying workbench later when native profile authoring is connected.</small>
      </section>

      <section className="workspace-preset-lab__export" aria-label="Workspace preset bundle export">
        <header><div><span className="eyebrow">Portable catalog</span><h3>Preview, copy, or download</h3><p>{exportStatus}</p></div><FileJson size={17} aria-hidden="true" /></header>
        <div className="workspace-preset-lab__export-actions"><label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as WorkspacePresetFormat)} aria-label="Workspace preset export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label><button type="button" className="button button--secondary" onClick={() => setPreviewOpen((current) => !current)} aria-expanded={previewOpen}>{previewOpen ? <X size={14} aria-hidden="true" /> : <FileJson size={14} aria-hidden="true" />}{previewOpen ? "Hide preview" : "Inspect bundle"}</button><button type="button" className="button button--ghost" onClick={() => void copyPayload()}><Clipboard size={14} aria-hidden="true" /> Copy</button><button type="button" className="button button--ghost" onClick={exportPayload}><Download size={14} aria-hidden="true" /> Download</button></div>
        {previewOpen ? <pre aria-label="Workspace preset bundle payload"><code>{payload}</code></pre> : null}
      </section>

      {stagedImport ? <section className="workspace-preset-lab__staged" aria-label="Staged workspace preset import"><header><div><span className="eyebrow">Import review</span><h3>{stagedImport.presets.length} preset{stagedImport.presets.length === 1 ? "" : "s"} staged</h3><p>Review conflicts before adding renderer-session copies. Built-in presets remain immutable.</p></div><button type="button" className="button button--ghost" onClick={() => setStagedImport(null)}><X size={14} aria-hidden="true" /> Dismiss</button></header>
        <div className="workspace-preset-lab__import-policy">
          <label><span>Conflict policy</span><select value={importPolicy} onChange={(event) => setImportPolicy(event.target.value as WorkspacePresetImportConflictPolicy)} aria-label="Workspace preset import conflict policy"><option value="keep-both">Keep both</option><option value="skip-duplicates">Skip duplicates</option><option value="replace-session">Replace matching session copy</option></select></label>
          <div className="workspace-preset-lab__import-summary"><strong>{stagedConflicts.length} conflict{stagedConflicts.length === 1 ? "" : "s"} detected</strong><span>{stagedConflicts.length === 0 ? "No matching name/category or ID in the current catalog." : "Conflicts are preview-only until you apply the selected policy."}</span></div>
        </div>
        {stagedConflicts.length > 0 ? <ul className="workspace-preset-lab__conflicts">{stagedConflicts.slice(0, 8).map((conflict) => <li key={`${conflict.incoming.id}-${conflict.existing.id}`}><div><strong>{conflict.incoming.name}</strong><span>{KIND_LABELS[conflict.incoming.kind]} · {conflict.reason === "matching-id" ? "matching ID" : "matching name/category"}</span></div><em>{conflict.canReplace ? "Session copy replaceable" : "Built-in locked"}</em></li>)}</ul> : null}
        <ul>{stagedImport.presets.slice(0, 8).map((preset) => <li key={`${preset.id}-${preset.name}`}><strong>{preset.name}</strong><span>{KIND_LABELS[preset.kind]} · {preset.tags.join(", ") || "untagged"}</span></li>)}</ul><button type="button" className="button button--primary" onClick={applyImport}><Check size={14} aria-hidden="true" /> Apply to renderer session</button></section> : null}

      <p className="workspace-preset-lab__status" role="status" aria-live="polite">{status}</p>
      <p className="workspace-preset-lab__footer"><Archive size={13} aria-hidden="true" /> Presets describe future settings composition. They do not mutate native profile files, grant permissions, activate skills, freeze context, call providers, or create durable revisions.</p>
    </section>
  );
}

export default WorkspacePresetLab;
