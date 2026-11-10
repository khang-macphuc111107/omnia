import {
  Check,
  Clipboard,
  Download,
  Edit3,
  FileJson2,
  FolderOpen,
  LockKeyhole,
  Plus,
  Redo2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { ProjectView, WorkspaceFolderView } from "./types";

type GrantScope = WorkspaceFolderView["scope"];
type GrantState = WorkspaceFolderView["state"];

type GrantDraft = {
  displayName: string;
  canonicalPath: string;
  scope: GrantScope;
  state: GrantState;
  localOnly: boolean;
};

type GrantHistory = {
  past: WorkspaceFolderView[][];
  present: WorkspaceFolderView[];
  future: WorkspaceFolderView[][];
};

type GrantExportFormat = "json" | "markdown";

const scopeOptions: Array<{ value: GrantScope; label: string; description: string }> = [
  { value: "read-only", label: "Read-only", description: "List and read files; no writes or execution." },
  { value: "metadata", label: "Metadata only", description: "Show names and metadata without file contents." },
  { value: "selected-files", label: "Selected files", description: "Preview a future allowlist of individual files." },
  { value: "full-index", label: "Full index", description: "Planned indexing scope; no index is created in preview." },
];

const stateOptions: Array<{ value: GrantState; label: string }> = [
  { value: "referenced", label: "Referenced" },
  { value: "indexing", label: "Indexing preview" },
  { value: "ready", label: "Ready preview" },
  { value: "partial", label: "Partial" },
  { value: "permission-lost", label: "Permission lost" },
  { value: "offline", label: "Offline" },
];

function cloneFolders(folders: readonly WorkspaceFolderView[]): WorkspaceFolderView[] {
  return folders.map((folder) => ({ ...folder }));
}

function workspaceSlug(name: string): string {
  return name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function defaultDraft(project: ProjectView): GrantDraft {
  return {
    displayName: `${project.name} workspace`,
    canonicalPath: `C:\\Workspace\\${workspaceSlug(project.name)}`,
    scope: "read-only",
    state: "referenced",
    localOnly: true,
  };
}

function folderFromDraft(draft: GrantDraft, id: string): WorkspaceFolderView {
  const pathSegments = draft.canonicalPath.split(/[\\/]/).filter(Boolean);
  const displayName = draft.displayName.trim() || pathSegments.at(-1) || "Workspace";
  return {
    id,
    displayName,
    canonicalPath: draft.canonicalPath.trim(),
    state: draft.state,
    scope: draft.scope,
    fileCount: draft.state === "ready" ? 0 : null,
    chunkCount: draft.state === "ready" && draft.scope === "full-index" ? 0 : null,
    lastIndexedAt: null,
    localOnly: draft.localOnly,
  };
}

function folderStateLabel(state: GrantState): string {
  return state === "indexing" ? "Indexing preview" : state.replaceAll("-", " ");
}

function scopeLabel(scope: GrantScope): string {
  return scopeOptions.find((option) => option.value === scope)?.label ?? scope;
}

function nextPreviewId(): string {
  return `preview-folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function serializeGrantPreview(
  project: ProjectView,
  folders: readonly WorkspaceFolderView[],
  format: GrantExportFormat,
): string {
  const payload = {
    schema: "omnia.workspace-grants.preview.v1",
    scope: "renderer-session",
    project: { id: project.id, name: project.name },
    grants: folders.map((folder) => ({
      id: folder.id,
      displayName: folder.displayName,
      canonicalPath: folder.canonicalPath,
      scope: folder.scope,
      state: folder.state,
      localOnly: folder.localOnly,
    })),
    boundary: "Renderer-local preview only; no filesystem read, native grant, indexing task, or provider upload was performed.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${project.name} workspace grants preview`,
    "",
    "> Renderer-local preview only; no filesystem read or native grant was performed.",
    "",
    ...folders.map((folder) => `- ${folder.displayName} · ${folder.scope} · ${folder.state} · ${folder.canonicalPath}`),
    "",
    "No indexing task, provider upload, or durable write was performed.",
  ].join("\n");
}

function downloadGrantPreview(payload: string, format: GrantExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workspace-grants-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ProjectWorkspaceGrantPreview({ project }: { readonly project: ProjectView }) {
  const fieldPrefix = useId();
  const displayNameId = `${fieldPrefix}-display-name`;
  const workspacePathId = `${fieldPrefix}-workspace-path`;
  const scopeId = `${fieldPrefix}-scope`;
  const stateId = `${fieldPrefix}-state`;
  const localOnlyId = `${fieldPrefix}-local-only`;
  const [history, setHistory] = useState<GrantHistory>(() => ({
    past: [],
    present: cloneFolders(project.folders),
    future: [],
  }));
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GrantDraft>(() => defaultDraft(project));
  const [status, setStatus] = useState("Workspace grants stay in this renderer preview.");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<GrantExportFormat>("json");
  const [exportStatus, setExportStatus] = useState("Access map preview is ready.");

  useEffect(() => {
    setHistory({ past: [], present: cloneFolders(project.folders), future: [] });
    setEditorOpen(false);
    setEditingFolderId(null);
    setDraft(defaultDraft(project));
    setStatus("Workspace grants reset for the selected project; nothing was persisted.");
    setExportOpen(false);
    setExportFormat("json");
    setExportStatus("Access map preview is ready.");
  }, [project.id]);

  const commit = (next: WorkspaceFolderView[], nextStatus: string) => {
    setHistory((current) => ({
      past: [...current.past, cloneFolders(current.present)],
      present: cloneFolders(next),
      future: [],
    }));
    setStatus(nextStatus);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneFolders(previous),
        future: [cloneFolders(current.present), ...current.future],
      };
    });
    setStatus("Undid the last workspace-grant preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, cloneFolders(current.present)],
        present: cloneFolders(next),
        future: current.future.slice(1),
      };
    });
    setStatus("Reapplied the next workspace-grant preview change.");
  };

  const reset = () => {
    const defaults = cloneFolders(project.folders);
    if (JSON.stringify(defaults) === JSON.stringify(history.present)) {
      setStatus("Workspace-grant preview is already at the selected project's defaults.");
      return;
    }
    commit(defaults, "Workspace-grant preview reset to the selected project's defaults.");
    setEditorOpen(false);
    setEditingFolderId(null);
  };

  const beginAdd = () => {
    setEditingFolderId(null);
    setDraft(defaultDraft(project));
    setEditorOpen(true);
    setStatus("Drafting a renderer-local workspace grant; no folder picker or file read was started.");
  };

  const beginEdit = (folder: WorkspaceFolderView) => {
    setEditingFolderId(folder.id);
    setDraft({
      displayName: folder.displayName,
      canonicalPath: folder.canonicalPath,
      scope: folder.scope,
      state: folder.state,
      localOnly: folder.localOnly,
    });
    setEditorOpen(true);
    setStatus(`Editing ${folder.displayName} in the renderer preview.`);
  };

  const saveDraft = () => {
    const canonicalPath = draft.canonicalPath.trim();
    if (!canonicalPath) {
      setStatus("Enter a workspace path before applying this preview grant.");
      return;
    }
    const nextFolder = folderFromDraft(draft, editingFolderId ?? nextPreviewId());
    const next = editingFolderId
      ? history.present.map((folder) => (folder.id === editingFolderId ? nextFolder : folder))
      : [nextFolder, ...history.present];
    commit(
      next,
      editingFolderId
        ? `Updated ${nextFolder.displayName} in the renderer-local grant preview.`
        : `Added ${nextFolder.displayName} to the renderer-local grant preview.`,
    );
    setEditorOpen(false);
    setEditingFolderId(null);
  };

  const revoke = (folder: WorkspaceFolderView) => {
    commit(
      history.present.filter((item) => item.id !== folder.id),
      `Revoked ${folder.displayName} in the renderer-local preview; source files were not deleted.`,
    );
  };

  const exportPayload = serializeGrantPreview(project, history.present, exportFormat);

  const copyExport = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable; no access map was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPayload);
      setExportStatus(`Copied the renderer-local access map as ${exportFormat.toUpperCase()}.`);
    } catch {
      setExportStatus("Clipboard access was denied; no access map was copied.");
    }
  };

  return (
    <section className="project-workspace-grant-preview" aria-labelledby="workspace-grant-preview-title">
      <header className="project-workspace-grant-preview__header">
        <div>
          <span className="eyebrow">Renderer-local access map</span>
          <h3 id="workspace-grant-preview-title">Workspace grants</h3>
          <p>Preview which local scopes belong to this project before the native bridge is connected.</p>
        </div>
        <span className="project-workspace-grant-preview__boundary"><ShieldCheck size={13} /> No durable write</span>
      </header>

      <div className="project-workspace-grant-preview__summary" role="status" aria-live="polite">
        <span><strong>{history.present.length}</strong><small>preview grant{history.present.length === 1 ? "" : "s"}</small></span>
        <span><strong>{history.present.filter((folder) => folder.scope === "read-only").length}</strong><small>read-only</small></span>
        <span><strong>{history.present.filter((folder) => folder.state === "ready").length}</strong><small>ready preview</small></span>
        <small>{status}</small>
      </div>

      <div className="project-workspace-grant-preview__toolbar" role="toolbar" aria-label="Workspace grant preview history">
        <span className="project-workspace-grant-preview__steps">{history.past.length + history.future.length} steps</span>
        <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo workspace grant preview change"><Undo2 size={13} /> Undo</button>
        <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo workspace grant preview change"><Redo2 size={13} /> Redo</button>
        <button type="button" className="button button--ghost" onClick={reset} aria-label="Reset workspace grant preview"><RotateCcw size={13} /> Reset</button>
        <button type="button" className="button button--secondary" onClick={beginAdd}><Plus size={13} /> Add grant in preview</button>
        <button type="button" className="button button--ghost" onClick={() => setExportOpen((value) => !value)} aria-expanded={exportOpen} aria-controls="workspace-grant-export-preview"><FileJson2 size={13} /> {exportOpen ? "Hide export" : "Preview access map"}</button>
      </div>

      {exportOpen ? (
        <section id="workspace-grant-export-preview" className="project-workspace-grant-preview__export" aria-label="Workspace grant export preview">
          <header><div><span className="eyebrow">Renderer-local export</span><strong>Workspace access map</strong></div><span className="project-workspace-grant-preview__export-chip">No durable write</span></header>
          <div className="project-workspace-grant-preview__export-toolbar" role="toolbar" aria-label="Workspace grant export actions">
            <label htmlFor={`${fieldPrefix}-export-format`}><span>Format</span><select id={`${fieldPrefix}-export-format`} aria-label="Workspace grant export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as GrantExportFormat)}><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <span role="status" aria-live="polite">{exportStatus}</span>
            <button type="button" className="button button--ghost" onClick={() => void copyExport()}><Clipboard size={13} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={() => setExportStatus(downloadGrantPreview(exportPayload, exportFormat) ? "Downloaded the renderer-local access map; native project state is unchanged." : "File download is unavailable; no access map was exported.")}><Download size={13} /> Download</button>
          </div>
          <pre tabIndex={0}><code>{exportPayload}</code></pre>
          <p><LockKeyhole size={13} /> Export includes the selected preview paths and scopes only. It does not create a native permission receipt or upload files.</p>
        </section>
      ) : null}

      {editorOpen ? (
        <form className="project-workspace-grant-preview__editor" aria-label="Workspace grant preview editor" onSubmit={(event) => { event.preventDefault(); saveDraft(); }}>
          <header>
            <div>
              <span className="eyebrow">{editingFolderId ? "Edit preview grant" : "New preview grant"}</span>
              <strong>{editingFolderId ? "Adjust scope without touching the filesystem" : "Describe the workspace scope Omnia should show"}</strong>
            </div>
            <button type="button" className="icon-button icon-button--small" aria-label="Close workspace grant editor" onClick={() => setEditorOpen(false)}><X size={13} /></button>
          </header>
          <div className="project-workspace-grant-preview__form-grid">
            <label htmlFor={displayNameId}><span>Display name</span><input id={displayNameId} value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="e.g. Omnia source" /></label>
            <label htmlFor={workspacePathId}><span>Workspace path</span><input id={workspacePathId} value={draft.canonicalPath} onChange={(event) => setDraft((current) => ({ ...current, canonicalPath: event.target.value }))} placeholder="C:\\Workspace\\Project" spellCheck={false} /></label>
            <label htmlFor={scopeId}><span>Access scope</span><select id={scopeId} aria-label="Access scope" value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as GrantScope }))}>{scopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{scopeOptions.find((option) => option.value === draft.scope)?.description}</small></label>
            <label htmlFor={stateId}><span>Preview state</span><select id={stateId} aria-label="Preview state" value={draft.state} onChange={(event) => setDraft((current) => ({ ...current, state: event.target.value as GrantState }))}>{stateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>State is descriptive only; no indexing task starts here.</small></label>
          </div>
          <label className="project-workspace-grant-preview__check" htmlFor={localOnlyId}><input id={localOnlyId} type="checkbox" checked={draft.localOnly} onChange={(event) => setDraft((current) => ({ ...current, localOnly: event.target.checked }))} /><span><strong>Keep this grant local-only</strong><small>Do not imply team sync or provider upload.</small></span></label>
          <div className="project-workspace-grant-preview__editor-actions"><button type="button" className="button button--ghost" onClick={() => setEditorOpen(false)}>Cancel</button><button type="submit" className="button button--primary" disabled={!draft.canonicalPath.trim()}><Check size={13} /> Apply preview</button></div>
        </form>
      ) : null}

      <div className="project-workspace-grant-preview__list">
        {history.present.length > 0 ? history.present.map((folder) => (
          <article key={folder.id} className="project-workspace-grant-preview__row">
            <span className="project-workspace-grant-preview__icon"><FolderOpen size={15} /></span>
            <span className="project-workspace-grant-preview__copy"><strong>{folder.displayName}</strong><small>{folder.canonicalPath}</small></span>
            <span className="project-workspace-grant-preview__scope">{scopeLabel(folder.scope)}</span>
            <span className={`project-workspace-grant-preview__state project-workspace-grant-preview__state--${folder.state}`}><span className="sr-only">State: </span>{folderStateLabel(folder.state)}</span>
            <span className="project-workspace-grant-preview__row-actions">
              <button type="button" className="icon-button icon-button--small" aria-label={`Edit ${folder.displayName} grant preview`} onClick={() => beginEdit(folder)}><Edit3 size={13} /></button>
              <button type="button" className="icon-button icon-button--small" aria-label={`Revoke ${folder.displayName} grant preview`} onClick={() => revoke(folder)}><Trash2 size={13} /></button>
            </span>
          </article>
        )) : (
          <div className="project-workspace-grant-preview__empty"><FolderOpen size={19} /><strong>No workspace grants in this preview</strong><small>Add a grant to explore scope, state, and undo behavior. No folder is read or created.</small></div>
        )}
      </div>

      <p className="project-workspace-grant-preview__footer"><LockKeyhole size={13} /> Preview only: this surface does not open a folder picker, read files, index content, execute code, upload data, or mutate native project state.</p>
    </section>
  );
}
