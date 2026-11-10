import {
  CheckSquare2,
  Clipboard,
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  List,
  Search,
  ShieldCheck,
  Star,
  Square,
  TreePine,
} from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

type PreviewFile = {
  id: string;
  name: string;
  extension: string;
  size: string;
  modified: string;
  language: string;
  summary: string;
  content: string;
};

type PreviewFolder = {
  id: string;
  name: string;
  children: Array<PreviewFolder | PreviewFile>;
};

function isFolder(entry: PreviewFolder | PreviewFile): entry is PreviewFolder {
  return "children" in entry;
}

const SAMPLE_ROOT: PreviewFolder = {
  id: "root",
  name: "omnia-workspace",
  children: [
    {
      id: "src",
      name: "src",
      children: [
        {
          id: "app-tsx",
          name: "App.tsx",
          extension: "tsx",
          size: "12.8 KB",
          modified: "Today, 10:42",
          language: "TypeScript React",
          summary: "The renderer entry point and workspace shell composition.",
          content: `import { ActivityRail } from "@/features/workspace/activity-rail";\nimport { ConversationView } from "@/features/workspace/conversation-view";\n\nexport function Workspace() {\n  return (\n    <main className="workspace-shell">\n      <ActivityRail />\n      <ConversationView />\n    </main>\n  );\n}`,
        },
        {
          id: "tokens-css",
          name: "tokens.css",
          extension: "css",
          size: "8.1 KB",
          modified: "Yesterday, 16:18",
          language: "CSS",
          summary: "Semantic color, spacing, and surface tokens for the dark theme.",
          content: `:root {\n  color-scheme: dark;\n  --surface: #15191d;\n  --surface-raised: #1d2328;\n  --text-primary: #edf0ed;\n  --text-secondary: #a6b0b3;\n  --accent-teal: #52c7b2;\n}`,
        },
        {
          id: "store-ts",
          name: "store.ts",
          extension: "ts",
          size: "21.4 KB",
          modified: "Sep 23, 2026",
          language: "TypeScript",
          summary: "Renderer projection state and workspace UI actions.",
          content: `export type WorkspaceMode = "chat" | "project";\n\nexport interface WorkspaceSelection {\n  projectId: string | null;\n  conversationId: string | null;\n  mode: WorkspaceMode;\n}`,
        },
      ],
    },
    {
      id: "docs",
      name: "docs",
      children: [
        {
          id: "readme-md",
          name: "README.md",
          extension: "md",
          size: "5.6 KB",
          modified: "Today, 09:12",
          language: "Markdown",
          summary: "Project overview, local setup, and the renderer/native boundary.",
          content: `# Omnia\n\nA chat-first workspace for projects, research, and creative work.\n\n## Current preview\n\n- Dark renderer UI\n- Session-local workbench previews\n- Native operations remain explicitly gated\n\n> This sample is illustrative. The browser does not read the repository filesystem.`,
        },
        {
          id: "file-studio-md",
          name: "file-artifact-studio.md",
          extension: "md",
          size: "2.2 KB",
          modified: "Sep 22, 2026",
          language: "Markdown",
          summary: "Target design for file ingestion, viewers, and artifact lineage.",
          content: `# File and artifact studio\n\nKeep originals, derivatives, tools, parameters, hashes, and transformations connected.\n\nThe user should be able to inspect exactly what a provider receives.`,
        },
      ],
    },
    {
      id: "public",
      name: "public",
      children: [
        {
          id: "omnia-svg",
          name: "omnia-mark.svg",
          extension: "svg",
          size: "1.4 KB",
          modified: "Sep 21, 2026",
          language: "SVG",
          summary: "A compact geometric mark used by the renderer preview.",
          content: `<svg viewBox="0 0 48 48" role="img" aria-label="Omnia mark">\n  <path d="M24 5 43 38H5L24 5Z" fill="none" stroke="currentColor" stroke-width="3"/>\n  <circle cx="24" cy="27" r="5" fill="currentColor"/>\n</svg>`,
        },
      ],
    },
    {
      id: "package-json",
      name: "package.json",
      children: [],
    },
  ],
};

// Keep the sample package manifest in the same file type as other preview data.
const PACKAGE_FILE: PreviewFile = {
  id: "package-json-file",
  name: "package.json",
  extension: "json",
  size: "3.7 KB",
  modified: "Today, 10:03",
  language: "JSON",
  summary: "Scripts and dependency metadata for the web renderer preview.",
  content: `{"name":"omnia","private":true,"scripts":{"dev":"vite --host 127.0.0.1","build":"vite build","typecheck:app":"tsc -p tsconfig.app.json --noEmit"}}`,
};

const ROOT: PreviewFolder = {
  ...SAMPLE_ROOT,
  children: SAMPLE_ROOT.children.map((entry) => entry.id === "package-json" ? PACKAGE_FILE : entry),
};

function getFileIcon(extension: string): ReactNode {
  if (["ts", "tsx", "js", "jsx", "rs", "py", "css", "html"].includes(extension)) return <FileCode2 size={14} />;
  if (["json", "toml", "yaml", "yml"].includes(extension)) return <FileJson2 size={14} />;
  if (["md", "txt"].includes(extension)) return <FileText size={14} />;
  return <File size={14} />;
}

function flattenFiles(folder: PreviewFolder, parentPath = ""): Array<PreviewFile & { path: string }> {
  return folder.children.flatMap((entry) => {
    const path = `${parentPath}/${entry.name}`;
    return isFolder(entry) ? flattenFiles(entry, path) : [{ ...entry, path }];
  });
}

type FileWithPath = PreviewFile & { path: string };

function buildSelectionExport(files: FileWithPath[], format: "json" | "markdown"): string {
  const manifest = {
    schema: "omnia.workspace-file-selection.preview.v1",
    boundary: "renderer-local",
    previewOnly: true,
    contentIncluded: false,
    files: files.map(({ id, name, path, extension, language, size, modified, summary }) => ({
      id,
      name,
      path,
      extension,
      language,
      size,
      modified,
      summary,
    })),
  };
  if (format === "json") return JSON.stringify(manifest, null, 2);
  return [
    "# Omnia workspace file selection",
    "",
    "- Preview only · renderer-local",
    "- File contents omitted; no disk read or durable file was created",
    "",
    ...files.map((file) => `- **${file.name}** · ${file.path} · ${file.language} · ${file.size}`),
  ].join("\n");
}

function folderHasVisibleFile(folder: PreviewFolder, visibleFileIds: Set<string>): boolean {
  return folder.children.some((entry) =>
    isFolder(entry) ? folderHasVisibleFile(entry, visibleFileIds) : visibleFileIds.has(entry.id),
  );
}

function FileTree({
  folder,
  depth,
  expanded,
  selectedId,
  favorites,
  selectedFileIds,
  visibleFileIds,
  autoExpandFiltered,
  onToggle,
  onSelect,
  onFavorite,
  onToggleSelection,
}: {
  folder: PreviewFolder;
  depth: number;
  expanded: Set<string>;
  selectedId: string;
  favorites: Set<string>;
  selectedFileIds: Set<string>;
  visibleFileIds: Set<string>;
  autoExpandFiltered: boolean;
  onToggle: (id: string) => void;
  onSelect: (file: PreviewFile) => void;
  onFavorite: (id: string) => void;
  onToggleSelection: (id: string) => void;
}) {
  return <>
    {folder.children.filter((entry) => isFolder(entry) ? folderHasVisibleFile(entry, visibleFileIds) : visibleFileIds.has(entry.id)).map((entry) => {
      const hasVisibleDescendant = isFolder(entry) && folderHasVisibleFile(entry, visibleFileIds);
      const isOpen = expanded.has(entry.id) || Boolean(autoExpandFiltered && hasVisibleDescendant);
      if (isFolder(entry)) return <div key={entry.id}>
        <button
          type="button"
          className="workspace-file-browser__tree-row workspace-file-browser__tree-row--folder"
          style={{ "--tree-depth": depth } as CSSProperties}
          onClick={() => onToggle(entry.id)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Collapse" : "Expand"} folder ${entry.name}`}
          title={`${isOpen ? "Collapse" : "Expand"} folder ${entry.name}`}
        >
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{entry.name}</span><small>{entry.children.length}</small>
        </button>
        {isOpen ? <FileTree folder={entry} depth={depth + 1} expanded={expanded} selectedId={selectedId} favorites={favorites} selectedFileIds={selectedFileIds} visibleFileIds={visibleFileIds} autoExpandFiltered={autoExpandFiltered} onToggle={onToggle} onSelect={onSelect} onFavorite={onFavorite} onToggleSelection={onToggleSelection} /> : null}
      </div>;
      const isFavorite = favorites.has(entry.id);
      const isSelectedForBatch = selectedFileIds.has(entry.id);
      return <div key={entry.id} className={`workspace-file-browser__tree-file ${selectedId === entry.id ? "is-selected" : ""}`} style={{ "--tree-depth": depth } as CSSProperties}>
        <input className="workspace-file-browser__batch-check" type="checkbox" aria-label={`Select ${entry.name}`} checked={isSelectedForBatch} onChange={() => onToggleSelection(entry.id)} />
        <button type="button" className="workspace-file-browser__tree-row" onClick={() => onSelect(entry)} aria-current={selectedId === entry.id ? "true" : undefined} aria-label={`Open ${entry.name}`} title={`Open ${entry.name}`}>
          <span className="workspace-file-browser__tree-spacer" />{getFileIcon(entry.extension)}<span>{entry.name}</span>
        </button>
        <button type="button" className={`workspace-file-browser__star ${isFavorite ? "is-favorite" : ""}`} aria-label={`${isFavorite ? "Unstar" : "Star"} ${entry.name}`} aria-pressed={isFavorite} onClick={() => onFavorite(entry.id)}><Star size={12} fill={isFavorite ? "currentColor" : "none"} /></button>
      </div>;
    })}
  </>;
}

export function WorkspaceFileBrowserPreview() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"tree" | "list">("tree");
  const [expanded, setExpanded] = useState(() => new Set(["src", "docs", "public"]));
  const [selectedId, setSelectedId] = useState("readme-md");
  const [favorites, setFavorites] = useState(() => new Set(["app-tsx"]));
  const [selectedFileIds, setSelectedFileIds] = useState(() => new Set<string>());
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [exportFormat, setExportFormat] = useState<"json" | "markdown">("json");
  const [exportOpen, setExportOpen] = useState(false);
  const files = useMemo(() => flattenFiles(ROOT), []);
  const selected = files.find((file) => file.id === selectedId) ?? files[0];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFiles = files.filter((file) => {
    const matchesQuery = !normalizedQuery || `${file.name} ${file.extension} ${file.path} ${file.language} ${file.summary}`.toLowerCase().includes(normalizedQuery);
    return matchesQuery && (!favoritesOnly || favorites.has(file.id));
  });
  const visibleFileIds = useMemo(() => new Set(visibleFiles.map((file) => file.id)), [visibleFiles]);
  const selectedIsVisible = selected ? visibleFileIds.has(selected.id) : false;
  const selectedFiles = files.filter((file) => selectedFileIds.has(file.id));
  const selectionExportPayload = useMemo(() => buildSelectionExport(selectedFiles, exportFormat), [selectedFiles, exportFormat]);

  const toggleFolder = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleFavorite = (id: string) => setFavorites((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleSelection = (id: string) => setSelectedFileIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const selectVisible = () => setSelectedFileIds((current) => new Set([...current, ...visibleFiles.map((file) => file.id)]));
  const clearSelection = () => setSelectedFileIds(new Set());
  const setFavoriteForSelection = (favorite: boolean) => setFavorites((current) => {
    const next = new Set(current);
    selectedFiles.forEach((file) => favorite ? next.add(file.id) : next.delete(file.id));
    return next;
  });
  const copySelectionExport = async () => {
    if (selectedFiles.length === 0) return;
    try { await navigator.clipboard?.writeText(selectionExportPayload); } catch { /* clipboard is optional in browser preview */ }
  };
  const downloadSelectionExport = () => {
    if (selectedFiles.length === 0) return;
    const blob = new Blob([selectionExportPayload], { type: exportFormat === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `omnia-workspace-file-selection.${exportFormat === "json" ? "json" : "md"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const selectFile = (file: PreviewFile) => setSelectedId(file.id);

  return <section className="workspace-file-browser" aria-labelledby="workspace-file-browser-title">
    <header className="workspace-file-browser__header">
      <div className="workspace-file-browser__heading">
        <span className="workspace-file-browser__mark"><HardDrive size={17} /></span>
        <div><span className="eyebrow">Files · sample index</span><h2 id="workspace-file-browser-title">Workspace File Browser</h2><p>Browse a small illustrative project tree and inspect a local-only file preview.</p></div>
      </div>
      <span className="workspace-file-browser__preview-badge"><ShieldCheck size={13} /> Preview only</span>
    </header>

    <div className="workspace-file-browser__notice" role="note" aria-label="Workspace file browser boundary">
      <ShieldCheck size={14} /><span>Sample files are bundled UI fixtures. This surface does not read your drives, open the displayed paths, or send file contents to a model.</span>
    </div>

    <div className="workspace-file-browser__toolbar" role="toolbar" aria-label="Workspace file browser controls">
      <label className="workspace-file-browser__search"><Search size={14} /><span className="sr-only">Search sample files</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files, paths, types…" /></label>
      <button type="button" className={`button ${favoritesOnly ? "button--secondary" : "button--ghost"}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}><Star size={13} /> Starred</button>
      <div className="workspace-file-browser__view-switch" role="group" aria-label="File browser view">
        <button type="button" className={view === "tree" ? "is-active" : ""} aria-pressed={view === "tree"} onClick={() => setView("tree")}><TreePine size={13} /> Tree</button>
        <button type="button" className={view === "list" ? "is-active" : ""} aria-pressed={view === "list"} onClick={() => setView("list")}><List size={13} /> List</button>
      </div>
    </div>

    <div className="workspace-file-browser__batch" role="group" aria-label="Batch file selection actions">
      <span className="workspace-file-browser__selection-count"><CheckSquare2 size={13} /> {selectedFiles.length} selected · {visibleFiles.length} visible</span>
      <button type="button" className="button button--ghost" onClick={selectVisible} disabled={!visibleFiles.length}><CheckSquare2 size={13} /> Select visible</button>
      <button type="button" className="button button--ghost" onClick={clearSelection} disabled={!selectedFiles.length}><Square size={13} /> Clear selection</button>
      <button type="button" className="button button--ghost" onClick={() => setFavoriteForSelection(true)} disabled={!selectedFiles.length}><Star size={13} /> Star selected</button>
      <button type="button" className="button button--ghost" onClick={() => setFavoriteForSelection(false)} disabled={!selectedFiles.length}><Star size={13} /> Unstar selected</button>
      <button type="button" className="button button--secondary" onClick={() => setExportOpen(true)} disabled={!selectedFiles.length}><Download size={13} /> Export selection</button>
    </div>

    <div className="workspace-file-browser__body">
      <aside className="workspace-file-browser__explorer" aria-label="Sample workspace files">
        <div className="workspace-file-browser__root-line"><FolderOpen size={14} /><strong>{ROOT.name}</strong><span>{visibleFiles.length} files</span></div>
        {view === "tree" ? <div className="workspace-file-browser__tree" role="tree" aria-label="Sample file tree">
          {visibleFiles.length ? <FileTree folder={ROOT} depth={0} expanded={expanded} selectedId={selected?.id ?? ""} favorites={favorites} selectedFileIds={selectedFileIds} visibleFileIds={visibleFileIds} autoExpandFiltered={Boolean(normalizedQuery || favoritesOnly)} onToggle={toggleFolder} onSelect={selectFile} onFavorite={toggleFavorite} onToggleSelection={toggleSelection} /> : <div className="workspace-file-browser__empty">No sample files match this filter.</div>}
        </div> : <div className="workspace-file-browser__list" role="list" aria-label="Sample files">
          {visibleFiles.length ? visibleFiles.map((file) => {
            const isFavorite = favorites.has(file.id);
            const isBatchSelected = selectedFileIds.has(file.id);
            return <div key={file.id} role="listitem" className="workspace-file-browser__list-item">
              <input className="workspace-file-browser__batch-check" type="checkbox" aria-label={`Select ${file.name}`} checked={isBatchSelected} onChange={() => toggleSelection(file.id)} />
              <button type="button" className={`workspace-file-browser__list-row ${selected?.id === file.id ? "is-selected" : ""}`} aria-label={`Open ${file.name}`} onClick={() => selectFile(file)}>
                {getFileIcon(file.extension)}<span><strong>{file.name}</strong><small>{file.path}</small></span><small>{file.size}</small>
              </button>
              <button type="button" className={`workspace-file-browser__list-star workspace-file-browser__star ${isFavorite ? "is-favorite" : ""}`} aria-label={`${isFavorite ? "Unstar" : "Star"} ${file.name}`} aria-pressed={isFavorite} onClick={() => toggleFavorite(file.id)}><Star size={12} fill={isFavorite ? "currentColor" : "none"} /></button>
            </div>;
          }) : <div className="workspace-file-browser__empty">No sample files match this filter.</div>}
        </div>}
        <div className="workspace-file-browser__explorer-foot">Fixture catalog · {files.length} files · read-only</div>
      </aside>

      {selected && selectedIsVisible ? <section className="workspace-file-browser__preview" aria-label={`Preview of ${selected.name}`}>
        <div className="workspace-file-browser__breadcrumbs"><span>{ROOT.name}</span><ChevronRight size={12} /><span>{selected.path.split("/").slice(1, -1).join(" / ") || "root"}</span><ChevronRight size={12} /><strong>{selected.name}</strong></div>
        <div className="workspace-file-browser__file-heading">
          <span className="workspace-file-browser__file-icon">{getFileIcon(selected.extension)}</span>
          <div><h3>{selected.name}</h3><p>{selected.summary}</p></div>
          <button type="button" className={`workspace-file-browser__star workspace-file-browser__star--large ${favorites.has(selected.id) ? "is-favorite" : ""}`} aria-label={`${favorites.has(selected.id) ? "Unstar" : "Star"} ${selected.name}`} aria-pressed={favorites.has(selected.id)} onClick={() => toggleFavorite(selected.id)}><Star size={15} fill={favorites.has(selected.id) ? "currentColor" : "none"} /></button>
        </div>
        <div className="workspace-file-browser__metadata"><span>{selected.language}</span><span>{selected.size}</span><span>Modified {selected.modified}</span><span>Sample content</span></div>
        <pre className="workspace-file-browser__code" tabIndex={0} aria-label={`Illustrative contents of ${selected.name}`}><code>{selected.content}</code></pre>
        <div className="workspace-file-browser__file-footer"><ShieldCheck size={13} /><span>Illustrative text only · not read from disk · not attached to Chat · no durable file was created</span></div>
      </section> : <section className="workspace-file-browser__preview workspace-file-browser__preview--empty" aria-label="File preview hidden">
        <span className="workspace-file-browser__file-icon"><Search size={15} /></span>
        <div><h3>Preview hidden by current filters</h3><p>The selected sample is outside the visible file set. Clear the search and starred-only filter to restore it. Sample content is illustrative and not read from disk.</p></div>
        <button type="button" className="button button--ghost" onClick={() => { setQuery(""); setFavoritesOnly(false); }}>Clear filters</button>
      </section>}
    </div>

    {exportOpen ? <section className="workspace-file-browser__batch-export" aria-label="Selected file export preview">
      <header><div><span className="eyebrow">Portable selection manifest</span><h3>Export selected files</h3></div><span>{selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"}</span></header>
      <div className="workspace-file-browser__batch-export-toolbar">
        <label><span>Format</span><select aria-label="Selected file export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "json" | "markdown")}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
        <button type="button" className="button button--ghost" onClick={() => void copySelectionExport()}><Clipboard size={13} /> Copy</button>
        <button type="button" className="button button--secondary" onClick={downloadSelectionExport}><Download size={13} /> Download</button>
        <button type="button" className="button button--ghost" onClick={() => setExportOpen(false)}>Close</button>
      </div>
      <pre tabIndex={0} aria-label="Selected file export payload"><code>{selectionExportPayload}</code></pre>
      <p><ShieldCheck size={13} /> Metadata only · file contents omitted · renderer-local preview · no disk read, upload, or durable write.</p>
    </section> : null}
  </section>;
}

export default WorkspaceFileBrowserPreview;
