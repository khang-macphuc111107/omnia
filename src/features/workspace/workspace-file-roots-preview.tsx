import {
  Check,
  Clipboard,
  Download,
  FileJson2,
  FolderOpen,
  HardDrive,
  Import,
  LockKeyhole,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  TimerReset,
  Undo2,
  X,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

type RootKind = "project" | "research" | "cache" | "archive";
type RootScope = "read-only" | "metadata" | "selected-files" | "full-index";
type RootIndexing = "off" | "on-demand" | "continuous";
type RootState = "ready" | "review" | "offline";
type ExportFormat = "json" | "markdown";
type IndexParser = "auto" | "source" | "documents" | "media-metadata";
type IndexChunking = "semantic" | "fixed" | "line-aware";
type IndexRefresh = "manual" | "on-change" | "daily";

type WorkspaceRoot = {
  id: string;
  label: string;
  path: string;
  kind: RootKind;
  scope: RootScope;
  indexing: RootIndexing;
  state: RootState;
  enabled: boolean;
  includeInContext: boolean;
  followSymlinks: boolean;
  exclude: string[];
};

type RootDraft = Omit<WorkspaceRoot, "id" | "state" | "exclude"> & { exclude: string };
type History = { past: WorkspaceRoot[][]; present: WorkspaceRoot[]; future: WorkspaceRoot[][] };
type IndexPlan = {
  parser: IndexParser;
  chunking: IndexChunking;
  refresh: IndexRefresh;
  maxFileSizeMb: number;
  maxFilesPerRoot: number;
  includeExtensions: string;
  respectIgnoreFiles: boolean;
  extractArchiveMetadata: boolean;
};
type IndexPlanHistory = { past: IndexPlan[]; present: IndexPlan; future: IndexPlan[] };

const ROOT_KIND_OPTIONS: Array<{ value: RootKind; label: string }> = [
  { value: "project", label: "Project source" },
  { value: "research", label: "Research / notes" },
  { value: "cache", label: "Cache / generated" },
  { value: "archive", label: "Archive / reference" },
];

const ROOT_SCOPE_OPTIONS: Array<{ value: RootScope; label: string; detail: string }> = [
  { value: "read-only", label: "Read-only", detail: "Allow future list/read operations only." },
  { value: "metadata", label: "Metadata only", detail: "Show names and metadata without file contents." },
  { value: "selected-files", label: "Selected files", detail: "Use a future explicit file allowlist." },
  { value: "full-index", label: "Full index", detail: "Plan indexing; no index is created here." },
];

const ROOT_INDEXING_OPTIONS: Array<{ value: RootIndexing; label: string }> = [
  { value: "off", label: "No indexing" },
  { value: "on-demand", label: "On demand" },
  { value: "continuous", label: "Continuous (planned)" },
];

const INDEX_PARSER_OPTIONS: Array<{ value: IndexParser; label: string; detail: string }> = [
  { value: "auto", label: "Auto by file type", detail: "Choose a bounded parser from the extension." },
  { value: "source", label: "Source-aware", detail: "Prefer code, config, and Markdown structure." },
  { value: "documents", label: "Documents", detail: "Prefer text/document extraction rules." },
  { value: "media-metadata", label: "Media metadata", detail: "Keep media to metadata candidates only." },
];

const INDEX_CHUNKING_OPTIONS: Array<{ value: IndexChunking; label: string; detail: string }> = [
  { value: "semantic", label: "Semantic sections", detail: "Plan headings and nearby context together." },
  { value: "fixed", label: "Fixed window", detail: "Plan predictable token-sized windows." },
  { value: "line-aware", label: "Line-aware", detail: "Preserve source line boundaries for citations." },
];

const INDEX_REFRESH_OPTIONS: Array<{ value: IndexRefresh; label: string; detail: string }> = [
  { value: "manual", label: "Manual rescan", detail: "Only an explicit future rescan may refresh it." },
  { value: "on-change", label: "On change (planned)", detail: "Watchers remain planned and disconnected." },
  { value: "daily", label: "Daily (planned)", detail: "A scheduler would be required later." },
];

const DEFAULT_INDEX_PLAN: IndexPlan = {
  parser: "auto",
  chunking: "line-aware",
  refresh: "manual",
  maxFileSizeMb: 8,
  maxFilesPerRoot: 20_000,
  includeExtensions: ".ts, .tsx, .js, .md, .json, .rs, .py",
  respectIgnoreFiles: true,
  extractArchiveMetadata: false,
};

const DEFAULT_ROOTS: WorkspaceRoot[] = [
  {
    id: "root-omnia",
    label: "Omnia source",
    path: "C:\\Users\\khang\\source\\repos\\omnia",
    kind: "project",
    scope: "read-only",
    indexing: "on-demand",
    state: "ready",
    enabled: true,
    includeInContext: true,
    followSymlinks: false,
    exclude: ["node_modules", "dist", "target"],
  },
  {
    id: "root-research",
    label: "Research vault",
    path: "D:\\Research",
    kind: "research",
    scope: "metadata",
    indexing: "off",
    state: "review",
    enabled: true,
    includeInContext: false,
    followSymlinks: false,
    exclude: [".git", "private"],
  },
  {
    id: "root-archive",
    label: "Reference archive",
    path: "E:\\Omnia\\archive",
    kind: "archive",
    scope: "selected-files",
    indexing: "on-demand",
    state: "offline",
    enabled: false,
    includeInContext: false,
    followSymlinks: false,
    exclude: [],
  },
];

function cloneRoots(roots: readonly WorkspaceRoot[]): WorkspaceRoot[] {
  return roots.map((root) => ({ ...root, exclude: [...root.exclude] }));
}

function nextRootId(): string {
  return `root-preview-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function scopeLabel(scope: RootScope): string {
  return ROOT_SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope;
}

function kindLabel(kind: RootKind): string {
  return ROOT_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function indexingLabel(indexing: RootIndexing): string {
  return ROOT_INDEXING_OPTIONS.find((option) => option.value === indexing)?.label ?? indexing;
}

function serializeRoots(roots: readonly WorkspaceRoot[], format: ExportFormat, indexPlan: IndexPlan): string {
  const payload = {
    schema: "omnia.workspace-file-roots.preview.v1",
    scope: "renderer-session",
    indexPlan,
    roots: roots.map(({ id, ...root }) => ({ id, ...root })),
    boundary: {
      rendererOnly: true,
      noFilesystemRead: true,
      noNativeGrant: true,
      noIndexingTask: true,
      noProviderUpload: true,
      noDurableWrite: true,
    },
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia workspace file roots preview",
    "",
    "> Renderer-local session preview; no filesystem was inspected and no native root grant was created.",
    "",
    "## Index plan",
    "",
    `- Parser: ${INDEX_PARSER_OPTIONS.find((option) => option.value === indexPlan.parser)?.label ?? indexPlan.parser}`,
    `- Chunking: ${INDEX_CHUNKING_OPTIONS.find((option) => option.value === indexPlan.chunking)?.label ?? indexPlan.chunking}`,
    `- Refresh: ${INDEX_REFRESH_OPTIONS.find((option) => option.value === indexPlan.refresh)?.label ?? indexPlan.refresh}`,
    `- Limits: ${indexPlan.maxFileSizeMb} MB per file · ${indexPlan.maxFilesPerRoot.toLocaleString()} files per root`,
    `- Extensions: ${indexPlan.includeExtensions || "all"}`,
    `- Ignore files: ${indexPlan.respectIgnoreFiles ? "respected" : "not selected"}`,
    `- Archive metadata: ${indexPlan.extractArchiveMetadata ? "candidate" : "off"}`,
    "",
    "## Roots",
    "",
    ...roots.map((root) => `- **${root.label}** · ${scopeLabel(root.scope)} · ${root.path} · ${root.enabled ? "enabled" : "disabled"}`),
    "",
    "No indexing task, provider upload, durable write, or compiler execution was performed.",
  ].join("\n");
}

function downloadText(payload: string, format: ExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workspace-file-roots-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function draftFromRoot(root: WorkspaceRoot): RootDraft {
  return {
    label: root.label,
    path: root.path,
    kind: root.kind,
    scope: root.scope,
    indexing: root.indexing,
    enabled: root.enabled,
    includeInContext: root.includeInContext,
    followSymlinks: root.followSymlinks,
    exclude: root.exclude.join(", "),
  };
}

function defaultDraft(): RootDraft {
  return {
    label: "New workspace root",
    path: "C:\\Workspace\\new-root",
    kind: "project",
    scope: "read-only",
    indexing: "off",
    enabled: true,
    includeInContext: false,
    followSymlinks: false,
    exclude: "node_modules, dist, target",
  };
}

function parseIndexPlan(value: unknown): IndexPlan | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<IndexPlan>;
  const parser = INDEX_PARSER_OPTIONS.some((option) => option.value === candidate.parser) ? candidate.parser as IndexParser : DEFAULT_INDEX_PLAN.parser;
  const chunking = INDEX_CHUNKING_OPTIONS.some((option) => option.value === candidate.chunking) ? candidate.chunking as IndexChunking : DEFAULT_INDEX_PLAN.chunking;
  const refresh = INDEX_REFRESH_OPTIONS.some((option) => option.value === candidate.refresh) ? candidate.refresh as IndexRefresh : DEFAULT_INDEX_PLAN.refresh;
  const maxFileSizeMb = typeof candidate.maxFileSizeMb === "number" && Number.isFinite(candidate.maxFileSizeMb) ? Math.max(1, Math.min(512, Math.round(candidate.maxFileSizeMb))) : DEFAULT_INDEX_PLAN.maxFileSizeMb;
  const maxFilesPerRoot = typeof candidate.maxFilesPerRoot === "number" && Number.isFinite(candidate.maxFilesPerRoot) ? Math.max(1, Math.min(1_000_000, Math.round(candidate.maxFilesPerRoot))) : DEFAULT_INDEX_PLAN.maxFilesPerRoot;
  return {
    parser,
    chunking,
    refresh,
    maxFileSizeMb,
    maxFilesPerRoot,
    includeExtensions: typeof candidate.includeExtensions === "string" ? candidate.includeExtensions : DEFAULT_INDEX_PLAN.includeExtensions,
    respectIgnoreFiles: candidate.respectIgnoreFiles !== false,
    extractArchiveMetadata: candidate.extractArchiveMetadata === true,
  };
}

export function WorkspaceFileRootsPreview() {
  const prefix = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<History>({ past: [], present: cloneRoots(DEFAULT_ROOTS), future: [] });
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | RootState>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RootDraft>(defaultDraft);
  const [exportOpen, setExportOpen] = useState(false);
  const [indexPlanOpen, setIndexPlanOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Access map preview is ready.");
  const [status, setStatus] = useState("Roots are renderer-local and session-only.");
  const [importStatus, setImportStatus] = useState("No import staged.");
  const [indexPlanHistory, setIndexPlanHistory] = useState<IndexPlanHistory>({
    past: [],
    present: { ...DEFAULT_INDEX_PLAN },
    future: [],
  });
  const [indexPlanStatus, setIndexPlanStatus] = useState("Indexing plan is renderer-local and not scheduled.");

  const visibleRoots = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return history.present.filter((root) => {
      const matchesSearch = !needle || `${root.label} ${root.path} ${root.kind} ${root.scope}`.toLowerCase().includes(needle);
      return matchesSearch && (stateFilter === "all" || root.state === stateFilter);
    });
  }, [history.present, query, stateFilter]);

  const commit = (next: WorkspaceRoot[], message: string) => {
    setHistory((current) => ({ past: [...current.past, cloneRoots(current.present)], present: cloneRoots(next), future: [] }));
    setStatus(message);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: cloneRoots(previous), future: [cloneRoots(current.present), ...current.future] };
    });
    setStatus("Undid the last file-root preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, cloneRoots(current.present)], present: cloneRoots(next), future: current.future.slice(1) };
    });
    setStatus("Reapplied the next file-root preview change.");
  };

  const reset = () => {
    if (JSON.stringify(history.present) === JSON.stringify(DEFAULT_ROOTS)) {
      setStatus("File-root preview is already at its defaults.");
      return;
    }
    commit(cloneRoots(DEFAULT_ROOTS), "Reset file-root preview to the built-in defaults.");
    setEditorOpen(false);
    setEditingId(null);
  };

  const updateIndexPlan = <K extends keyof IndexPlan>(key: K, value: IndexPlan[K]) => {
    setIndexPlanHistory((current) => ({
      past: [...current.past, { ...current.present }],
      present: { ...current.present, [key]: value },
      future: [],
    }));
    setIndexPlanStatus("Updated the renderer-local indexing plan; no scan or watcher started.");
  };

  const undoIndexPlan = () => {
    setIndexPlanHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: { ...previous }, future: [{ ...current.present }, ...current.future] };
    });
    setIndexPlanStatus("Undid the last indexing-plan preview change.");
  };

  const redoIndexPlan = () => {
    setIndexPlanHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, { ...current.present }], present: { ...next }, future: current.future.slice(1) };
    });
    setIndexPlanStatus("Reapplied the next indexing-plan preview change.");
  };

  const resetIndexPlan = () => {
    if (JSON.stringify(indexPlanHistory.present) === JSON.stringify(DEFAULT_INDEX_PLAN)) {
      setIndexPlanStatus("Indexing plan is already at its defaults.");
      return;
    }
    setIndexPlanHistory((current) => ({ past: [...current.past, { ...current.present }], present: { ...DEFAULT_INDEX_PLAN }, future: [] }));
    setIndexPlanStatus("Reset indexing-plan preview to the built-in defaults.");
  };

  const beginAdd = () => {
    setEditingId(null);
    setDraft(defaultDraft());
    setEditorOpen(true);
    setStatus("Drafting a renderer-local file root; no folder picker or file read was started.");
  };

  const beginEdit = (root: WorkspaceRoot) => {
    setEditingId(root.id);
    setDraft(draftFromRoot(root));
    setEditorOpen(true);
    setStatus(`Editing ${root.label} in the renderer preview.`);
  };

  const saveDraft = () => {
    if (!draft.path.trim()) {
      setStatus("Enter a root path before applying this preview.");
      return;
    }
    const root: WorkspaceRoot = {
      id: editingId ?? nextRootId(),
      label: draft.label.trim() || draft.path.trim().split(/[\\/]/).filter(Boolean).at(-1) || "Workspace root",
      path: draft.path.trim(),
      kind: draft.kind,
      scope: draft.scope,
      indexing: draft.indexing,
      state: "review",
      enabled: draft.enabled,
      includeInContext: draft.includeInContext,
      followSymlinks: draft.followSymlinks,
      exclude: draft.exclude.split(",").map((item) => item.trim()).filter(Boolean),
    };
    const next = editingId ? history.present.map((item) => item.id === editingId ? root : item) : [root, ...history.present];
    commit(next, editingId ? `Updated ${root.label} in the file-root preview.` : `Added ${root.label} to the file-root preview.`);
    setEditorOpen(false);
    setEditingId(null);
  };

  const toggleRoot = (id: string, key: "enabled" | "includeInContext" | "followSymlinks") => {
    const root = history.present.find((item) => item.id === id);
    if (!root) return;
    commit(history.present.map((item) => item.id === id ? { ...item, [key]: !item[key] } : item), `${key === "enabled" ? (root.enabled ? "Disabled" : "Enabled") : key === "includeInContext" ? (root.includeInContext ? "Excluded" : "Included") : (root.followSymlinks ? "Stopped following" : "Will follow")} ${root.label} in the preview.`);
  };

  const removeRoot = (id: string) => {
    const root = history.present.find((item) => item.id === id);
    if (!root) return;
    commit(history.present.filter((item) => item.id !== id), `Removed ${root.label} from the renderer preview; no folder or file was deleted.`);
  };

  const exportPayload = serializeRoots(history.present, exportFormat, indexPlanHistory.present);

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no access map was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied the renderer-local roots map as ${exportFormat.toUpperCase()}.`);
    } catch {
      setExportStatus("Clipboard access was denied; no access map was copied.");
    }
  };

  const stageImport = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const value = JSON.parse(String(reader.result)) as { schema?: string; roots?: unknown; indexPlan?: unknown };
        if (value.schema !== "omnia.workspace-file-roots.preview.v1" || !Array.isArray(value.roots)) throw new Error("schema");
        const imported = value.roots.filter((item): item is WorkspaceRoot => Boolean(item && typeof item === "object" && "path" in item && typeof (item as { path?: unknown }).path === "string")).map((item) => ({
          ...item,
          id: `imported-${nextRootId()}`,
          label: typeof item.label === "string" ? item.label : "Imported root",
          kind: ROOT_KIND_OPTIONS.some((option) => option.value === item.kind) ? item.kind : "project",
          scope: ROOT_SCOPE_OPTIONS.some((option) => option.value === item.scope) ? item.scope : "read-only",
          indexing: ROOT_INDEXING_OPTIONS.some((option) => option.value === item.indexing) ? item.indexing : "off",
          state: "review" as RootState,
          enabled: item.enabled !== false,
          includeInContext: item.includeInContext === true,
          followSymlinks: item.followSymlinks === true,
          exclude: Array.isArray(item.exclude) ? item.exclude.filter((entry): entry is string => typeof entry === "string") : [],
        }));
        if (!imported.length) throw new Error("empty");
        commit([...imported, ...history.present], `Staged ${imported.length} imported file-root candidate${imported.length === 1 ? "" : "s"} in the renderer preview.`);
        const importedPlan = parseIndexPlan(value.indexPlan);
        if (importedPlan) {
          setIndexPlanHistory((current) => ({ past: [...current.past, { ...current.present }], present: importedPlan, future: [] }));
          setIndexPlanStatus("Imported the indexing-plan candidate into the renderer preview.");
        }
        setImportStatus(`${imported.length} root${imported.length === 1 ? "" : "s"} imported as review candidates.`);
      } catch {
        setImportStatus("Import rejected: expected an Omnia workspace-file-roots preview bundle.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <section className="workspace-file-roots-preview" aria-labelledby="workspace-file-roots-preview-title">
      <header className="workspace-file-roots-preview__header">
        <div className="workspace-file-roots-preview__title-wrap">
          <span className="workspace-file-roots-preview__mark"><HardDrive size={18} /></span>
          <div>
            <span className="eyebrow">Storage & backup · renderer preview</span>
            <h2 id="workspace-file-roots-preview-title">Workspace file roots</h2>
            <p>Model the folders and drives Omnia may use later, with explicit scope, indexing, exclusions, and context inclusion.</p>
          </div>
        </div>
        <span className="workspace-file-roots-preview__boundary"><ShieldCheck size={13} /> No durable write</span>
      </header>

      <div className="workspace-file-roots-preview__notice" role="note" aria-label="Workspace file roots preview boundary">
        <LockKeyhole size={14} /> Preview only: no filesystem read, folder picker, native grant, indexing task, provider upload, compiler execution, or durable persistence is connected.
      </div>

      <div className="workspace-file-roots-preview__summary" role="status" aria-live="polite">
        <span><strong>{history.present.length}</strong><small>roots</small></span>
        <span><strong>{history.present.filter((root) => root.enabled).length}</strong><small>enabled</small></span>
        <span><strong>{history.present.filter((root) => root.includeInContext).length}</strong><small>in context</small></span>
        <span><strong>{history.present.filter((root) => root.state === "offline").length}</strong><small>offline</small></span>
        <small>{status}</small>
      </div>

      <div className="workspace-file-roots-preview__toolbar" role="toolbar" aria-label="Workspace file roots preview actions">
        <label className="workspace-file-roots-preview__search"><Search size={14} /><span className="sr-only">Search workspace file roots</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search labels, paths, scopes…" /></label>
        <label className="workspace-file-roots-preview__filter"><span>Status</span><select aria-label="Workspace file roots status filter" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as "all" | RootState)}><option value="all">All</option><option value="ready">Ready</option><option value="review">Needs review</option><option value="offline">Offline</option></select></label>
        <span className="workspace-file-roots-preview__steps">{history.past.length + history.future.length} steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={!history.past.length} aria-label="Undo workspace file root preview change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={!history.future.length} aria-label="Redo workspace file root preview change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset workspace file roots preview"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={beginAdd}><Plus size={13} /> Add root</button>
        <button type="button" className={`button ${indexPlanOpen ? "button--secondary" : "button--ghost"}`} onClick={() => setIndexPlanOpen((value) => !value)} aria-expanded={indexPlanOpen} aria-controls={`${prefix}-index-plan`}><SlidersHorizontal size={13} /> {indexPlanOpen ? "Hide index plan" : "Index plan"}</button>
        <button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls={`${prefix}-export`}><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Export / import"}</button>
      </div>

      {indexPlanOpen ? <section id={`${prefix}-index-plan`} className="workspace-file-roots-preview__index-plan" aria-label="Workspace indexing plan preview">
        <header>
          <div><span className="eyebrow">Retrieval preparation · preview only</span><strong>Indexing policy rehearsal</strong><p>Shape parser, chunking, refresh, and bounded file limits before a native indexer exists.</p></div>
          <span className="workspace-file-roots-preview__export-chip"><TimerReset size={13} /> Not scheduled</span>
        </header>
        <div className="workspace-file-roots-preview__index-grid">
          <label htmlFor={`${prefix}-parser`}><span>Parser strategy</span><select id={`${prefix}-parser`} aria-label="Parser strategy" value={indexPlanHistory.present.parser} onChange={(event) => updateIndexPlan("parser", event.target.value as IndexParser)}>{INDEX_PARSER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{INDEX_PARSER_OPTIONS.find((option) => option.value === indexPlanHistory.present.parser)?.detail}</small></label>
          <label htmlFor={`${prefix}-chunking`}><span>Chunking strategy</span><select id={`${prefix}-chunking`} aria-label="Chunking strategy" value={indexPlanHistory.present.chunking} onChange={(event) => updateIndexPlan("chunking", event.target.value as IndexChunking)}>{INDEX_CHUNKING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{INDEX_CHUNKING_OPTIONS.find((option) => option.value === indexPlanHistory.present.chunking)?.detail}</small></label>
          <label htmlFor={`${prefix}-refresh`}><span>Refresh policy</span><select id={`${prefix}-refresh`} aria-label="Refresh policy" value={indexPlanHistory.present.refresh} onChange={(event) => updateIndexPlan("refresh", event.target.value as IndexRefresh)}>{INDEX_REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{INDEX_REFRESH_OPTIONS.find((option) => option.value === indexPlanHistory.present.refresh)?.detail}</small></label>
          <label htmlFor={`${prefix}-max-size`}><span>Max file size (MB)</span><input id={`${prefix}-max-size`} aria-label="Max file size (MB)" type="number" min={1} max={512} value={indexPlanHistory.present.maxFileSizeMb} onChange={(event) => updateIndexPlan("maxFileSizeMb", Math.max(1, Math.min(512, Number(event.target.value) || 1)))} /><small>Bounded input; no file size was measured.</small></label>
          <label htmlFor={`${prefix}-max-files`}><span>Max files per root</span><input id={`${prefix}-max-files`} aria-label="Max files per root" type="number" min={1} max={1000000} value={indexPlanHistory.present.maxFilesPerRoot} onChange={(event) => updateIndexPlan("maxFilesPerRoot", Math.max(1, Math.min(1000000, Number(event.target.value) || 1)))} /><small>Planning limit only; no directory was enumerated.</small></label>
          <label htmlFor={`${prefix}-extensions`}><span>Included extensions</span><input id={`${prefix}-extensions`} aria-label="Included extensions" value={indexPlanHistory.present.includeExtensions} onChange={(event) => updateIndexPlan("includeExtensions", event.target.value)} placeholder=".ts, .md, .json" /><small>Comma-separated allowlist preview.</small></label>
        </div>
        <div className="workspace-file-roots-preview__checks workspace-file-roots-preview__checks--index"><label><input type="checkbox" checked={indexPlanHistory.present.respectIgnoreFiles} onChange={(event) => updateIndexPlan("respectIgnoreFiles", event.target.checked)} /><span><strong>Respect ignore files</strong><small>Honor future .gitignore/.omniaignore rules.</small></span></label><label><input type="checkbox" checked={indexPlanHistory.present.extractArchiveMetadata} onChange={(event) => updateIndexPlan("extractArchiveMetadata", event.target.checked)} /><span><strong>Archive metadata only</strong><small>Plan archive listing without unpacking contents.</small></span></label></div>
        <div className="workspace-file-roots-preview__index-actions"><span role="status" aria-live="polite">{indexPlanStatus}</span><span>{indexPlanHistory.past.length + indexPlanHistory.future.length} plan steps</span><button type="button" className="button button--ghost" onClick={undoIndexPlan} disabled={!indexPlanHistory.past.length}>Undo</button><button type="button" className="button button--ghost" onClick={redoIndexPlan} disabled={!indexPlanHistory.future.length}>Redo</button><button type="button" className="button button--ghost" onClick={resetIndexPlan}>Reset plan</button></div>
        <p className="workspace-file-roots-preview__index-boundary"><LockKeyhole size={13} /> This is a policy preview. It does not enumerate files, parse content, create embeddings, start a watcher/scheduler, call a provider, or persist an index.</p>
      </section> : null}

      {exportOpen ? <section id={`${prefix}-export`} className="workspace-file-roots-preview__export" aria-label="Workspace file roots export and import preview">
        <header><div><span className="eyebrow">Portable preview bundle</span><strong>Root access map</strong></div><span className="workspace-file-roots-preview__export-chip">Session-only</span></header>
        <div className="workspace-file-roots-preview__export-toolbar" role="toolbar" aria-label="Workspace file roots export actions">
          <label htmlFor={`${prefix}-format`}><span>Format</span><select id={`${prefix}-format`} aria-label="Workspace file roots export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
          <span role="status" aria-live="polite">{exportStatus}</span>
          <button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
          <button type="button" className="button button--secondary" onClick={() => setExportStatus(downloadText(exportPayload, exportFormat) ? "Downloaded preview bundle; native state is unchanged." : "File download is unavailable; no bundle was exported.")}><Download size={13} /> Download</button>
          <label className="workspace-file-roots-preview__import"><Import size={13} /><span>Import preview bundle</span><input ref={fileInputRef} type="file" accept="application/json,.json" aria-label="Import workspace file roots preview bundle" onChange={(event) => { stageImport(event.target.files?.[0]); event.target.value = ""; }} /></label>
        </div>
        <p className="workspace-file-roots-preview__import-status" role="status">{importStatus}</p>
        <pre tabIndex={0} aria-label="Workspace file roots bundle payload"><code>{exportPayload}</code></pre>
        <p><LockKeyhole size={13} /> Export contains configured preview metadata only. No filesystem was inspected; paths are not read and file contents are never included.</p>
      </section> : null}

      {editorOpen ? <form className="workspace-file-roots-preview__editor" aria-label="Workspace file root preview editor" onSubmit={(event) => { event.preventDefault(); saveDraft(); }}>
        <header><div><span className="eyebrow">{editingId ? "Edit preview root" : "New preview root"}</span><strong>Describe a root without touching the filesystem</strong></div><button type="button" className="icon-button icon-button--small" aria-label="Close workspace file root editor" onClick={() => setEditorOpen(false)}><X size={13} /></button></header>
        <div className="workspace-file-roots-preview__form-grid">
          <label htmlFor={`${prefix}-label`}><span>Display name</span><input id={`${prefix}-label`} value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} placeholder="e.g. Omnia source" /></label>
          <label htmlFor={`${prefix}-path`}><span>Root path</span><input id={`${prefix}-path`} value={draft.path} onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))} placeholder="C:\\Workspace\\Project" spellCheck={false} /></label>
          <label htmlFor={`${prefix}-kind`}><span>Root kind</span><select id={`${prefix}-kind`} value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as RootKind }))}>{ROOT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label htmlFor={`${prefix}-scope`}><span>Access scope</span><select id={`${prefix}-scope`} value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as RootScope }))}>{ROOT_SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{ROOT_SCOPE_OPTIONS.find((option) => option.value === draft.scope)?.detail}</small></label>
          <label htmlFor={`${prefix}-indexing`}><span>Indexing plan</span><select id={`${prefix}-indexing`} value={draft.indexing} onChange={(event) => setDraft((current) => ({ ...current, indexing: event.target.value as RootIndexing }))}>{ROOT_INDEXING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label htmlFor={`${prefix}-exclude`}><span>Exclude patterns</span><input id={`${prefix}-exclude`} value={draft.exclude} onChange={(event) => setDraft((current) => ({ ...current, exclude: event.target.value }))} placeholder="node_modules, .git" /><small>Comma-separated preview patterns.</small></label>
        </div>
        <div className="workspace-file-roots-preview__checks"><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>Enabled</strong><small>Keep this root available in the future policy.</small></span></label><label><input type="checkbox" checked={draft.includeInContext} onChange={(event) => setDraft((current) => ({ ...current, includeInContext: event.target.checked }))} /><span><strong>Include in context</strong><small>Candidate only; no provider request is built.</small></span></label><label><input type="checkbox" checked={draft.followSymlinks} onChange={(event) => setDraft((current) => ({ ...current, followSymlinks: event.target.checked }))} /><span><strong>Follow links</strong><small>Planned traversal preference; not executed.</small></span></label></div>
        <div className="workspace-file-roots-preview__editor-actions"><button type="button" className="button button--ghost" onClick={() => setEditorOpen(false)}>Cancel</button><button type="submit" className="button button--primary" disabled={!draft.path.trim()}><Check size={13} /> Apply preview</button></div>
      </form> : null}

      <div className="workspace-file-roots-preview__list" role="list" aria-label="Workspace file roots">
        {visibleRoots.length ? visibleRoots.map((root) => <article key={root.id} className={`workspace-file-roots-preview__row workspace-file-roots-preview__row--${root.state}`} role="listitem">
          <span className="workspace-file-roots-preview__icon"><FolderOpen size={15} /></span>
          <span className="workspace-file-roots-preview__copy"><strong>{root.label}</strong><small>{root.path}</small><em>{kindLabel(root.kind)} · {indexingLabel(root.indexing)} · excludes {root.exclude.length || "none"}</em></span>
          <span className="workspace-file-roots-preview__badges"><span className="workspace-file-roots-preview__scope">{scopeLabel(root.scope)}</span><span className="workspace-file-roots-preview__state">{root.state === "review" ? "Needs review" : root.state}</span></span>
          <span className="workspace-file-roots-preview__toggles"><label title="Enable root in preview"><input type="checkbox" checked={root.enabled} onChange={() => toggleRoot(root.id, "enabled")} /><span>Enabled</span></label><label title="Include root in context preview"><input type="checkbox" checked={root.includeInContext} onChange={() => toggleRoot(root.id, "includeInContext")} /><span>Context</span></label></span>
          <span className="workspace-file-roots-preview__row-actions"><button type="button" className="icon-button icon-button--small" aria-label={`Edit ${root.label} file root preview`} onClick={() => beginEdit(root)}><HardDrive size={13} /></button><button type="button" className="icon-button icon-button--small" aria-label={`Remove ${root.label} file root preview`} onClick={() => removeRoot(root.id)}><Trash2 size={13} /></button></span>
        </article>) : <div className="workspace-file-roots-preview__empty"><FolderOpen size={20} /><strong>No roots match this view</strong><small>Adjust the search or status filter, or add a renderer-local root candidate.</small></div>}
      </div>

      <footer className="workspace-file-roots-preview__footer"><LockKeyhole size={13} /> Renderer-local preview only. The app does not inspect drives, follow links, index content, execute commands, upload data, or mutate native workspace policy from this surface.</footer>
    </section>
  );
}

export default WorkspaceFileRootsPreview;
