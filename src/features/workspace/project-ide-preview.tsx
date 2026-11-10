import {
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Copy,
  Diff,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  GitCompare,
  Hash,
  ListChecks,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  TerminalSquare,
  Undo2,
  WrapText,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { ProjectView } from "./types";
import { ProjectIdeProblemsPreview } from "./project-ide-problems-preview";
import { TerminalCompilerPreview } from "./terminal-compiler-preview";
import { GitCiWorkbenchPreview } from "./git-ci-workbench-preview";

type IdeView = "editor" | "diff" | "outline" | "problems" | "terminal" | "ship";

type EditorPreferences = {
  lineNumbers: boolean;
  wordWrap: boolean;
  showWhitespace: boolean;
};

const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  lineNumbers: true,
  wordWrap: false,
  showWhitespace: false,
};

type PreviewFile = {
  id: string;
  name: string;
  path: string;
  kind: "folder" | "typescript" | "markdown" | "css" | "test" | "json";
  content: string;
  symbolSummary: string[];
};

const PREVIEW_FILES: PreviewFile[] = [
  {
    id: "readme",
    name: "README.md",
    path: "README.md",
    kind: "markdown",
    content: "# Omnia workspace\n\nA renderer-local project surface for planning, coding, and review.\n\n> Preview snapshot · no workspace file was read.",
    symbolSummary: ["Omnia workspace", "Preview snapshot"],
  },
  {
    id: "main",
    name: "main.ts",
    path: "src/main.ts",
    kind: "typescript",
    content: 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n\nexport const runtime = "renderer-preview";\n',
    symbolSummary: ["greet(name: string)", "runtime"],
  },
  {
    id: "router",
    name: "router.ts",
    path: "src/router.ts",
    kind: "typescript",
    content: 'export type Route = "chat" | "project" | "library";\n\nexport function resolveRoute(route: Route): string {\n  return `/workspace/${route}`;\n}\n',
    symbolSummary: ["Route", "resolveRoute(route: Route)"],
  },
  {
    id: "theme",
    name: "tokens.css",
    path: "src/styles/tokens.css",
    kind: "css",
    content: ":root {\n  --accent: #4f8cff;\n  --surface: #121722;\n  --text: #e8edf7;\n}\n",
    symbolSummary: [":root", "--accent", "--surface", "--text"],
  },
  {
    id: "test",
    name: "main.test.ts",
    path: "src/main.test.ts",
    kind: "test",
    content: 'import { describe, expect, it } from "vitest";\nimport { greet } from "./main";\n\ndescribe("greet", () => {\n  it("returns a friendly message", () => {\n    expect(greet("coder")).toContain("coder");\n  });\n});\n',
    symbolSummary: ["greet", "returns a friendly message"],
  },
  {
    id: "package",
    name: "package.json",
    path: "package.json",
    kind: "json",
    content: '{\n  "name": "omnia-workspace",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run"\n  }\n}\n',
    symbolSummary: ["name", "scripts.dev", "scripts.test"],
  },
];

function fileIcon(file: PreviewFile) {
  if (file.kind === "folder") return <Folder size={14} />;
  if (file.kind === "markdown") return <FileText size={14} />;
  if (file.kind === "css") return <Hash size={14} />;
  if (file.kind === "test") return <Check size={14} />;
  return <FileCode2 size={14} />;
}

function cloneFiles(): Record<string, string> {
  return Object.fromEntries(PREVIEW_FILES.map((file) => [file.id, file.content]));
}

export function ProjectIdePreview({ project }: { readonly project: ProjectView }) {
  const [selectedId, setSelectedId] = useState("main");
  const [query, setQuery] = useState("");
  const [branch, setBranch] = useState("preview/main");
  const [ideView, setIdeView] = useState<IdeView>("editor");
  const [editing, setEditing] = useState(false);
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false);
  const [editorPreferences, setEditorPreferences] = useState<EditorPreferences>(DEFAULT_EDITOR_PREFERENCES);
  const [drafts, setDrafts] = useState<Record<string, string>>(cloneFiles);
  const [history, setHistory] = useState<Record<string, string>[]>([]);
  const [status, setStatus] = useState("Preview snapshot loaded · no workspace file was read");
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const editorSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const editorSettingsPanelRef = useRef<HTMLDivElement>(null);

  const selectedFile = PREVIEW_FILES.find((file) => file.id === selectedId) ?? PREVIEW_FILES[0]!;
  const selectedContent = drafts[selectedFile.id] ?? selectedFile.content;
  const changed = selectedContent !== selectedFile.content;
  const filteredFiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return PREVIEW_FILES;
    return PREVIEW_FILES.filter((file) => `${file.path} ${file.name}`.toLowerCase().includes(needle));
  }, [query]);

  const activeFilteredFile = filteredFiles.find((file) => file.id === selectedFile.id) ?? filteredFiles[0];

  useEffect(() => {
    if (!editorSettingsOpen) return;

    function dismissEditorSettings(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (editorSettingsPanelRef.current?.contains(target)) return;
      if (editorSettingsTriggerRef.current?.contains(target)) return;
      setEditorSettingsOpen(false);
    }

    function handleEditorSettingsKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setEditorSettingsOpen(false);
      editorSettingsTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", dismissEditorSettings);
    document.addEventListener("keydown", handleEditorSettingsKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismissEditorSettings);
      document.removeEventListener("keydown", handleEditorSettingsKeyDown);
    };
  }, [editorSettingsOpen]);

  useEffect(() => {
    // A toolbar popover should never remain over a different IDE surface or file.
    setEditorSettingsOpen(false);
  }, [ideView, selectedId]);

  useEffect(() => {
    if (!editorSettingsOpen) return;
    // Move focus into the settings dialog so keyboard and assistive technology
    // users receive an immediate context change after opening the popover.
    const firstControl = editorSettingsPanelRef.current?.querySelector<HTMLElement>("input")
      ?? editorSettingsPanelRef.current?.querySelector<HTMLElement>("button");
    firstControl?.focus();
  }, [editorSettingsOpen]);

  useEffect(() => {
    function handleKeyboardShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "p") {
        event.preventDefault();
        fileSearchRef.current?.focus();
        setStatus("Quick open focused · search is renderer-local");
      } else if (key === "s") {
        event.preventDefault();
        setStatus("Save rehearsal acknowledged · no durable write");
      }
    }

    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, []);

  function openPreviewFile(file: PreviewFile) {
    setSelectedId(file.id);
    setIdeView("editor");
    setStatus(`${file.path} opened from preview snapshot`);
  }

  function handleFileTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (filteredFiles.length === 0) return;

    const activeIndex = Math.max(0, filteredFiles.findIndex((file) => file.id === activeFilteredFile?.id));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = Math.min(filteredFiles.length - 1, activeIndex + 1);
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = Math.max(0, activeIndex - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = filteredFiles.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    event.currentTarget.focus();
    openPreviewFile(filteredFiles[nextIndex]!);
  }

  function updateContent(value: string) {
    setHistory((previous) => [...previous.slice(-9), drafts]);
    setDrafts((previous) => ({ ...previous, [selectedFile.id]: value }));
    setStatus("Unsaved renderer-local edit · native filesystem is untouched");
  }

  function resetFile() {
    setDrafts((previous) => ({ ...previous, [selectedFile.id]: selectedFile.content }));
    setStatus(`${selectedFile.path} reset in preview · no durable write`);
  }

  function undoEdit() {
    const previous = history.at(-1);
    if (!previous) return;
    setDrafts(previous);
    setHistory((items) => items.slice(0, -1));
    setStatus("Undo applied to renderer-local IDE preview");
  }

  async function copyCode() {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · code remains visible in preview");
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedContent);
      setStatus(`${selectedFile.path} copied · renderer-local only`);
    } catch {
      setStatus("Clipboard unavailable · code remains visible in preview");
    }
  }

  async function copyPath() {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard unavailable · path remains visible in preview");
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedFile.path);
      setStatus(`${selectedFile.path} path copied · renderer-local only`);
    } catch {
      setStatus("Clipboard unavailable · path remains visible in preview");
    }
  }

  function resetEditorPreferences() {
    setEditorPreferences(DEFAULT_EDITOR_PREFERENCES);
    setStatus("Editor preferences reset in preview");
  }

  function toggleEditorPreference(key: keyof EditorPreferences) {
    setEditorPreferences((previous) => ({ ...previous, [key]: !previous[key] }));
    setStatus("Editor preference updated · renderer-local only");
  }

  return (
    <section className="project-ide-preview" aria-labelledby="project-ide-preview-heading">
      <header className="project-ide-preview__header">
        <div>
          <span className="eyebrow">Coder workspace preview</span>
          <h3 id="project-ide-preview-heading">Project IDE surface</h3>
          <p>Shape files, review a diff, and rehearse a run without touching the local workspace.</p>
        </div>
        <span className="project-ide-preview__boundary"><Code2 size={14} /> Renderer-local</span>
      </header>

      <div className="project-ide-preview__summary">
        <span><strong>{project.name}</strong><small>Preview project</small></span>
        <label><GitBranch size={13} /><span className="sr-only">IDE branch preview</span><select value={branch} onChange={(event) => { setBranch(event.target.value); setStatus(`Branch ${event.target.value} selected in preview`); }} aria-label="IDE branch preview"><option>preview/main</option><option>preview/experiment</option><option>preview/review</option></select><ChevronDown size={12} /></label>
        <span className="project-ide-preview__summary-status"><span className="status-dot status-dot--success" />{changed ? "Changes pending" : "Clean preview"}</span>
      </div>

      <div className="project-ide-preview__toolbar" role="toolbar" aria-label="Project IDE preview actions">
        <label className="project-ide-preview__search"><Search size={14} /><span className="sr-only">Search preview files</span><input ref={fileSearchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files · Ctrl+P" aria-label="Search preview files" /></label>
        <div className="project-ide-preview__view-switch" role="group" aria-label="IDE preview view">
          <button type="button" className={ideView === "editor" ? "is-active" : ""} onClick={() => setIdeView("editor")} aria-pressed={ideView === "editor"} title="Open the synthetic code editor"><Code2 size={13} /> Editor</button>
          <button type="button" className={ideView === "diff" ? "is-active" : ""} onClick={() => setIdeView("diff")} aria-pressed={ideView === "diff"} title="Review renderer-local changes"><GitCompare size={13} /> Diff</button>
          <button type="button" className={ideView === "outline" ? "is-active" : ""} onClick={() => setIdeView("outline")} aria-pressed={ideView === "outline"} title="Browse symbols in the selected preview file"><Hash size={13} /> Outline</button>
          <button type="button" className={ideView === "problems" ? "is-active" : ""} onClick={() => setIdeView("problems")} aria-pressed={ideView === "problems"} title="Review synthetic diagnostics"><ListChecks size={13} /> Problems</button>
          <button type="button" className={ideView === "terminal" ? "is-active" : ""} onClick={() => setIdeView("terminal")} aria-pressed={ideView === "terminal"} title="Open terminal and compiler rehearsal"><TerminalSquare size={13} /> Terminal</button>
          <button type="button" className={ideView === "ship" ? "is-active" : ""} onClick={() => setIdeView("ship")} aria-pressed={ideView === "ship"} title="Review Git and CI/CD rehearsal"><GitPullRequest size={13} /> Ship</button>
        </div>
        <div className="project-ide-preview__toolbar-actions">
          <button type="button" className="button button--ghost" onClick={() => void copyPath()} aria-label={`Copy path for ${selectedFile.path}`}><Clipboard size={13} /> Path</button>
          <button ref={editorSettingsTriggerRef} type="button" className="button button--ghost" onClick={() => setEditorSettingsOpen((value) => !value)} aria-label="Open editor preview settings" aria-expanded={editorSettingsOpen} aria-controls="project-ide-editor-settings" aria-haspopup="dialog" title="Open editor preview settings"><Settings2 size={13} /> Editor</button>
          {editorSettingsOpen ? <div ref={editorSettingsPanelRef} id="project-ide-editor-settings" className="project-ide-preview__settings" role="dialog" aria-modal="false" aria-label="Editor preview settings" aria-describedby="project-ide-editor-settings-help">
            <div className="project-ide-preview__settings-heading"><strong>Editor preview</strong><button type="button" className="button button--ghost" onClick={resetEditorPreferences}>Reset</button></div>
            <label><input type="checkbox" checked={editorPreferences.lineNumbers} onChange={() => toggleEditorPreference("lineNumbers")} /> Show line numbers</label>
            <label><input type="checkbox" checked={editorPreferences.wordWrap} onChange={() => toggleEditorPreference("wordWrap")} /> Word wrap <WrapText size={12} /></label>
            <label><input type="checkbox" checked={editorPreferences.showWhitespace} onChange={() => toggleEditorPreference("showWhitespace")} /> Show whitespace</label>
            <small id="project-ide-editor-settings-help">Ctrl+S is a save rehearsal; it never writes the workspace.</small>
          </div> : null}
        </div>
        <button type="button" className="button button--ghost" onClick={undoEdit} disabled={history.length === 0} aria-label="Undo IDE preview edit"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={resetFile} disabled={!changed} aria-label="Reset current IDE preview file"><RotateCcw size={13} /> Reset</button>
      </div>

      <div className="project-ide-preview__workspace">
        <aside className="project-ide-preview__tree" aria-label="Preview file tree">
          <div className="project-ide-preview__tree-heading"><span><Folder size={14} /> {project.name.toLowerCase().replace(/\s+/g, "-")}</span><small>{filteredFiles.length} files</small></div>
          <div
            className="project-ide-preview__tree-list"
            role="listbox"
            aria-label="Preview files"
            aria-activedescendant={activeFilteredFile ? `project-ide-file-${activeFilteredFile.id}` : undefined}
            aria-describedby="project-ide-file-tree-help"
            aria-keyshortcuts="ArrowDown ArrowUp Home End"
            tabIndex={filteredFiles.length > 0 ? 0 : -1}
            onKeyDown={handleFileTreeKeyDown}
          >
            {filteredFiles.map((file, index) => <button
              key={file.id}
              id={`project-ide-file-${file.id}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={file.id === selectedFile.id}
              aria-posinset={index + 1}
              aria-setsize={filteredFiles.length}
              className={file.id === selectedFile.id ? "is-active" : ""}
              onClick={() => openPreviewFile(file)}
            ><span className={`project-ide-preview__file-icon project-ide-preview__file-icon--${file.kind}`}>{fileIcon(file)}</span><span>{file.path}</span>{drafts[file.id] !== file.content ? <em>•</em> : null}</button>)}
          </div>
          <span id="project-ide-file-tree-help" className="sr-only">Use Arrow Up or Arrow Down to move through preview files. Home and End jump to the first or last file.</span>
          {filteredFiles.length === 0 ? <div className="project-ide-preview__tree-empty">No preview files match this search.</div> : null}
        </aside>

        <div className="project-ide-preview__main">
          <div className="project-ide-preview__tabs" role="tablist" aria-label="Open preview files">
            <button id={`project-ide-tab-${selectedFile.id}`} type="button" role="tab" aria-selected="true" aria-controls="project-ide-file-panel" tabIndex={0} className="is-active" title="Keep the current preview file active" onClick={() => setStatus(`${selectedFile.path} is already the active preview file.`)}><span className={`project-ide-preview__file-icon project-ide-preview__file-icon--${selectedFile.kind}`} aria-hidden="true">{fileIcon(selectedFile)}</span>{selectedFile.name}{changed ? <em aria-label="unsaved changes">•</em> : null}</button>
            <span className="project-ide-preview__path">{selectedFile.path}</span>
          </div>

          <div id="project-ide-file-panel" role="tabpanel" aria-labelledby={`project-ide-tab-${selectedFile.id}`} tabIndex={0} className="project-ide-preview__file-panel">
          {ideView === "editor" ? <div className="project-ide-preview__editor-shell">
            <div className="project-ide-preview__editor-toolbar"><span><span className="status-dot status-dot--success" />{editing ? "Editing preview" : "Read-only preview"}</span><div><button type="button" className="button button--ghost" onClick={() => void copyCode()} aria-label={`Copy code for ${selectedFile.path}`} title="Copy the selected preview code"><Copy size={13} /> Copy</button><button type="button" className="button button--ghost" onClick={() => setEditing((value) => !value)} aria-label={editing ? "Done" : "Edit preview"} title={editing ? "Finish the renderer-local edit" : "Edit the renderer-local preview file"}>{editing ? <Check size={13} /> : <Code2 size={13} />}{editing ? "Done" : "Edit preview"}</button></div></div>
            {editing ? <textarea aria-label={`Edit ${selectedFile.path}`} className={`project-ide-preview__code-input${editorPreferences.wordWrap ? " project-ide-preview__code-input--wrap" : ""}`} value={selectedContent} onChange={(event) => updateContent(event.target.value)} spellCheck={false} /> : <pre className={`project-ide-preview__code${editorPreferences.wordWrap ? " project-ide-preview__code--wrap" : ""}${editorPreferences.showWhitespace ? " project-ide-preview__code--whitespace" : ""}`} tabIndex={0} aria-label={`Preview code for ${selectedFile.path}`}>{selectedContent.split("\n").map((line, index) => <span key={`${selectedFile.id}-${index}`}><b className={editorPreferences.lineNumbers ? undefined : "is-hidden"}>{String(index + 1).padStart(2, "0")}</b><code>{editorPreferences.showWhitespace ? (line ? line.replace(/\t/g, "→").replace(/ /g, "·") : "·") : (line || " ")}</code></span>)}</pre>}
          </div> : null}

          {ideView === "diff" ? <div className="project-ide-preview__diff" role="region" aria-label="Preview diff"><header><span><Diff size={14} /> Working tree diff</span><small>{changed ? "1 file changed" : "No changes"}</small></header>{changed ? <><div className="project-ide-preview__diff-line project-ide-preview__diff-line--remove">- Original content is kept as a baseline.</div><div className="project-ide-preview__diff-line project-ide-preview__diff-line--add">+ Renderer-local edits are ready for review.</div><pre>{selectedContent}</pre></> : <div className="project-ide-preview__diff-empty"><Check size={18} /><strong>Preview is clean</strong><small>Edit a file to see a diff rehearsal.</small></div>}</div> : null}

          {ideView === "outline" ? <div className="project-ide-preview__outline" role="region" aria-label="Preview outline"><header><span><Hash size={14} /> Symbols in {selectedFile.name}</span><small>{selectedFile.symbolSummary.length} symbols</small></header>{selectedFile.symbolSummary.map((symbol) => <button key={symbol} type="button" onClick={() => setStatus(`Symbol ${symbol} selected in preview`)}><span><Sparkles size={13} /></span><code>{symbol}</code><ChevronDown size={12} /></button>)}</div> : null}

          {ideView === "problems" ? <ProjectIdeProblemsPreview selectedPath={selectedFile.path} onOpenFile={(path) => { const match = PREVIEW_FILES.find((file) => file.path === path); if (match) setSelectedId(match.id); setIdeView("editor"); setStatus(`${path} opened from Problems preview`); }} /> : null}

          {ideView === "terminal" ? <TerminalCompilerPreview projectName={project.name} filePath={selectedFile.path} /> : null}

          {ideView === "ship" ? <GitCiWorkbenchPreview projectName={project.name} /> : null}
          </div>

          <div className="project-ide-preview__actions" role="toolbar" aria-label="IDE preview run actions"><span><TerminalSquare size={13} /> Actions are rehearsals only</span><button type="button" className="button button--secondary" onClick={() => setStatus("Run preview queued · no process was started")} title="Queue a renderer-local run rehearsal"><Play size={13} /> Run preview</button><button type="button" className="button button--ghost" onClick={() => setStatus("Review request prepared in renderer preview")} title="Prepare a renderer-local review request">Request review</button><span className="project-ide-preview__status" role="status" aria-live="polite">{status}</span></div>
        </div>
      </div>

      <p className="project-ide-preview__boundary-note"><Clipboard size={14} /> This IDE uses synthetic preview files. It does not read or write folders, execute terminals, call providers, create branches, or persist changes. Native IDE integration remains Planned.</p>
    </section>
  );
}
