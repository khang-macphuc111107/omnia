import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Download,
  FileText,
  FolderOpen,
  Layers3,
  Redo2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useWorkspaceStore } from "./store";

type SnapshotScope = "active-chat" | "active-project" | "workspace";
type SnapshotFormat = "json" | "markdown";

type SnapshotDraft = {
  label: string;
  scope: SnapshotScope;
  includeConversations: boolean;
  includeProjectMetadata: boolean;
  includeAttachmentMetadata: boolean;
  includeAppearance: boolean;
  includeDiagnostics: boolean;
};

type SnapshotHistory = {
  past: SnapshotDraft[];
  present: SnapshotDraft;
  future: SnapshotDraft[];
};

type SnapshotFacts = {
  projectCount: number;
  conversationCount: number;
  attachmentCount: number;
  activeProjectName: string | null;
  activeConversationTitle: string | null;
};

const defaultDraft: SnapshotDraft = {
  label: "Omnia workspace preview",
  scope: "active-project",
  includeConversations: true,
  includeProjectMetadata: true,
  includeAttachmentMetadata: true,
  includeAppearance: true,
  includeDiagnostics: false,
};

const scopeLabels: Record<SnapshotScope, string> = {
  "active-chat": "Active chat",
  "active-project": "Active project",
  workspace: "Entire workspace",
};

function cloneDraft(draft: SnapshotDraft): SnapshotDraft {
  return { ...draft };
}

function sameDraft(left: SnapshotDraft, right: SnapshotDraft): boolean {
  return (
    left.label === right.label &&
    left.scope === right.scope &&
    left.includeConversations === right.includeConversations &&
    left.includeProjectMetadata === right.includeProjectMetadata &&
    left.includeAttachmentMetadata === right.includeAttachmentMetadata &&
    left.includeAppearance === right.includeAppearance &&
    left.includeDiagnostics === right.includeDiagnostics
  );
}

function factsForScope(
  scope: SnapshotScope,
  activeProjectId: string,
  activeConversationId: string,
  projects: ReturnType<typeof useWorkspaceStore.getState>["projects"],
  conversations: ReturnType<typeof useWorkspaceStore.getState>["conversations"],
  attachments: ReturnType<typeof useWorkspaceStore.getState>["attachments"],
): SnapshotFacts {
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  ) ?? null;

  if (scope === "active-chat") {
    return {
      projectCount: activeConversation?.projectId ? 1 : 0,
      conversationCount: activeConversation ? 1 : 0,
      attachmentCount: activeConversation
        ? new Set(activeConversation.messages.flatMap((message) => message.attachments.map((attachment) => attachment.id))).size
        : 0,
      activeProjectName: activeProject?.name ?? activeConversation?.projectName ?? null,
      activeConversationTitle: activeConversation?.title ?? null,
    };
  }

  if (scope === "active-project") {
    const scopedConversations = conversations.filter(
      (conversation) => conversation.projectId === activeProjectId,
    );
    const scopedAttachments = attachments.filter((attachment) => attachment.projectId === activeProjectId);
    return {
      projectCount: activeProject ? 1 : 0,
      conversationCount: scopedConversations.length,
      attachmentCount: new Set(scopedAttachments.map((attachment) => attachment.id)).size,
      activeProjectName: activeProject?.name ?? null,
      activeConversationTitle: activeConversation?.title ?? null,
    };
  }

  return {
    projectCount: projects.length,
    conversationCount: conversations.length,
    attachmentCount: new Set(attachments.map((attachment) => attachment.id)).size,
    activeProjectName: activeProject?.name ?? null,
    activeConversationTitle: activeConversation?.title ?? null,
  };
}

function serializeSnapshot(
  draft: SnapshotDraft,
  facts: SnapshotFacts,
  format: SnapshotFormat,
  appearance: { theme: string; density: string },
): string {
  const included = [
    draft.includeConversations ? "conversation-index" : null,
    draft.includeProjectMetadata ? "project-metadata" : null,
    draft.includeAttachmentMetadata ? "attachment-metadata" : null,
    draft.includeAppearance ? "appearance-preferences" : null,
    draft.includeDiagnostics ? "redacted-diagnostics" : null,
  ].filter((value): value is string => value !== null);
  const payload = {
    schema: "omnia.workspace-snapshot-preview.v1",
    scope: "renderer-session",
    generatedAt: new Date().toISOString(),
    snapshot: {
      label: draft.label.trim() || "Untitled workspace preview",
      target: draft.scope,
      targetLabel: scopeLabels[draft.scope],
      included,
      counts: {
        projects: draft.includeProjectMetadata ? facts.projectCount : 0,
        conversations: draft.includeConversations ? facts.conversationCount : 0,
        attachmentMetadata: draft.includeAttachmentMetadata ? facts.attachmentCount : 0,
      },
      activeProject: draft.includeProjectMetadata ? facts.activeProjectName : null,
      activeConversation: draft.includeConversations ? facts.activeConversationTitle : null,
      appearance: draft.includeAppearance ? appearance : null,
      diagnostics: draft.includeDiagnostics
        ? { source: "renderer-preview", redaction: "content-and-secrets-excluded" }
        : null,
    },
    boundary:
      "Renderer-local composition preview only; it does not freeze native state, write files, copy prompt bodies, or create a durable restore point.",
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia workspace snapshot preview",
    "",
    "> Renderer-local composition preview only; no native snapshot or durable restore point is created.",
    "",
    `- Label: ${payload.snapshot.label}`,
    `- Scope: ${payload.snapshot.targetLabel}`,
    `- Included: ${included.length > 0 ? included.join(", ") : "nothing selected"}`,
    `- Projects: ${payload.snapshot.counts.projects}`,
    `- Conversations: ${payload.snapshot.counts.conversations}`,
    `- Attachment metadata: ${payload.snapshot.counts.attachmentMetadata}`,
    `- Diagnostics: ${draft.includeDiagnostics ? "redacted preview" : "excluded"}`,
  ].join("\n");
}

function downloadSnapshotPreview(payload: string, format: SnapshotFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workspace-snapshot-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function WorkspaceSnapshotPreview() {
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeConversationId = useWorkspaceStore((state) => state.activeConversationId);
  const projects = useWorkspaceStore((state) => state.projects);
  const conversations = useWorkspaceStore((state) => state.conversations);
  const attachments = useWorkspaceStore((state) => state.attachments);
  const theme = useWorkspaceStore((state) => state.theme);
  const density = useWorkspaceStore((state) => state.density);
  const [history, setHistory] = useState<SnapshotHistory>({
    past: [],
    present: cloneDraft(defaultDraft),
    future: [],
  });
  const [format, setFormat] = useState<SnapshotFormat>("json");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [status, setStatus] = useState(
    "Choose a scope and included metadata, then generate a local snapshot preview.",
  );
  const [exportStatus, setExportStatus] = useState("No native snapshot has been created.");
  const draft = history.present;
  const selectedContentCount = [
    draft.includeConversations,
    draft.includeProjectMetadata,
    draft.includeAttachmentMetadata,
    draft.includeAppearance,
    draft.includeDiagnostics,
  ].filter(Boolean).length;
  const facts = useMemo(
    () => factsForScope(draft.scope, activeProjectId, activeConversationId, projects, conversations, attachments),
    [activeConversationId, activeProjectId, attachments, conversations, draft.scope, projects],
  );
  const payload = useMemo(
    () => serializeSnapshot(draft, facts, format, { theme, density }),
    [draft, facts, format, density, theme],
  );

  const commit = (patch: Partial<SnapshotDraft>, nextStatus: string) => {
    setHistory((current) => {
      const next = { ...current.present, ...patch };
      if (sameDraft(next, current.present)) return current;
      return {
        past: [...current.past, cloneDraft(current.present)],
        present: next,
        future: [],
      };
    });
    setStatus(nextStatus);
  };

  const undo = () => {
    setHistory((current) => {
      const snapshot = current.past.at(-1);
      if (!snapshot) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneDraft(snapshot),
        future: [cloneDraft(current.present), ...current.future],
      };
    });
    setStatus("Undid the last workspace snapshot preview change.");
  };

  const redo = () => {
    setHistory((current) => {
      const snapshot = current.future[0];
      if (!snapshot) return current;
      return {
        past: [...current.past, cloneDraft(current.present)],
        present: cloneDraft(snapshot),
        future: current.future.slice(1),
      };
    });
    setStatus("Reapplied the next workspace snapshot preview change.");
  };

  const reset = () => {
    setHistory((current) => {
      if (sameDraft(current.present, defaultDraft)) return current;
      return {
        past: [...current.past, cloneDraft(current.present)],
        present: cloneDraft(defaultDraft),
        future: [],
      };
    });
    setStatus("Workspace snapshot preview reset to its safe defaults.");
  };

  const copyPreview = async () => {
    if (!navigator.clipboard?.writeText) {
      setExportStatus("Clipboard access is unavailable in this surface; no snapshot was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setExportStatus(`Copied the renderer-local ${format.toUpperCase()} snapshot preview.`);
    } catch {
      setExportStatus("Clipboard access was denied; no snapshot was copied.");
    }
  };

  const downloadPreview = () => {
    setExportStatus(
      downloadSnapshotPreview(payload, format)
        ? "Started a browser download of the renderer-local snapshot preview."
        : "Browser download is unavailable; no snapshot file was written.",
    );
  };

  return (
    <section className="workspace-snapshot-preview" aria-labelledby="workspace-snapshot-preview-title">
      <header className="workspace-snapshot-preview__header">
        <span className="workspace-snapshot-preview__mark" aria-hidden="true"><Archive size={17} /></span>
        <div>
          <span className="eyebrow">Portable workspace preview</span>
          <h3 id="workspace-snapshot-preview-title">Compose a snapshot before native storage exists</h3>
          <p>Preview the exact metadata Omnia could package later, with explicit scope and reversible choices.</p>
        </div>
        <span className="workspace-snapshot-preview__status"><Sparkles size={13} /> Renderer preview</span>
      </header>
      <span className="workspace-snapshot-preview__sr-only" role="status" aria-live="polite">{status}</span>

      <div className="workspace-snapshot-preview__form">
        <label>
          <span>Snapshot label</span>
          <input value={draft.label} onChange={(event) => commit({ label: event.target.value }, "Snapshot label changed in the renderer preview.")} aria-label="Workspace snapshot label" />
        </label>
        <label>
          <span>Capture scope</span>
          <select value={draft.scope} onChange={(event) => commit({ scope: event.target.value as SnapshotScope }, `${scopeLabels[event.target.value as SnapshotScope]} selected for the renderer preview.`)} aria-label="Workspace snapshot scope">
            <option value="active-chat">Active chat</option>
            <option value="active-project">Active project</option>
            <option value="workspace">Entire workspace</option>
          </select>
        </label>
      </div>

      <div className="workspace-snapshot-preview__option-bar">
        <span><strong>{selectedContentCount}/5</strong> metadata groups selected</span>
        <button
          type="button"
          className="button button--secondary"
          aria-expanded={optionsOpen}
          aria-controls="workspace-snapshot-preview-advanced"
          onClick={() => setOptionsOpen((open) => !open)}
        >
          {optionsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {optionsOpen ? "Hide options" : "Customize snapshot"}
        </button>
      </div>

      <div
        className="workspace-snapshot-preview__advanced"
        id="workspace-snapshot-preview-advanced"
        hidden={!optionsOpen}
      >
        <div className="workspace-snapshot-preview__history" role="toolbar" aria-label="Workspace snapshot preview history">
          <span>Reversible edits for this preview</span>
          <span>{history.past.length + history.future.length} preview steps</span>
          <button type="button" className="button button--ghost" onClick={undo} disabled={history.past.length === 0} aria-label="Undo workspace snapshot preview change"><Undo2 size={14} /> Undo</button>
          <button type="button" className="button button--ghost" onClick={redo} disabled={history.future.length === 0} aria-label="Redo workspace snapshot preview change"><Redo2 size={14} /> Redo</button>
          <button type="button" className="button button--ghost" onClick={reset} disabled={sameDraft(draft, defaultDraft)} aria-label="Reset workspace snapshot preview"><RotateCcw size={14} /> Reset</button>
        </div>

        <div className="workspace-snapshot-preview__include" role="group" aria-label="Workspace snapshot contents">
          <header><span><strong>Include in preview</strong><small>Only metadata is represented; prompt bodies and secret bytes are always excluded.</small></span><span>{selectedContentCount}/5 selected</span></header>
          {([
            ["includeConversations", "Conversation index", "Titles, counts, and active-chat identity", draft.includeConversations],
            ["includeProjectMetadata", "Project metadata", "Project name, scope, and workspace folder counts", draft.includeProjectMetadata],
            ["includeAttachmentMetadata", "Attachment metadata", "Names, kinds, and safe size summaries only", draft.includeAttachmentMetadata],
            ["includeAppearance", "Appearance preferences", "Theme and density preview values", draft.includeAppearance],
            ["includeDiagnostics", "Redacted diagnostics", "Renderer health markers without prompts or credentials", draft.includeDiagnostics],
          ] as const).map((entry) => {
            const [id, label, description, checked] = entry;
            return (
              <label className="workspace-snapshot-preview__include-row" key={id}>
                <input type="checkbox" checked={Boolean(checked)} onChange={(event) => commit({ [id]: event.target.checked } as Partial<SnapshotDraft>, `${String(label)} ${event.target.checked ? "included" : "excluded"} from the renderer preview.`)} aria-label={String(label)} />
                <span><strong>{label}</strong><small>{description}</small></span>
              </label>
            );
          })}
        </div>

        <div className="workspace-snapshot-preview__metrics" aria-label="Workspace snapshot preview summary">
          <article><FolderOpen size={15} /><strong>{facts.projectCount}</strong><small>Projects</small></article>
          <article><Layers3 size={15} /><strong>{facts.conversationCount}</strong><small>Conversations</small></article>
          <article><FileText size={15} /><strong>{facts.attachmentCount}</strong><small>Attachment metadata</small></article>
          <article><ShieldCheck size={15} /><strong>Redacted</strong><small>Content boundary</small></article>
        </div>
      </div>

      <div className="workspace-snapshot-preview__actions">
        <span><strong>{facts.activeProjectName ?? "No active project"}</strong><small>{facts.activeConversationTitle ?? "No active conversation"} · {scopeLabels[draft.scope]}</small></span>
        <button type="button" className="button button--primary" onClick={() => { setPreviewOpen(true); setStatus("Generated a renderer-local snapshot preview. No native state was frozen."); }}><Check size={14} /> Generate preview</button>
      </div>

      {previewOpen ? (
        <section className="workspace-snapshot-preview__export" aria-label="Workspace snapshot manifest preview">
          <div className="workspace-snapshot-preview__export-toolbar">
            <span><strong>Portable manifest preview</strong><small>{exportStatus}</small></span>
            <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as SnapshotFormat)} aria-label="Workspace snapshot export format"><option value="json">JSON</option><option value="markdown">Markdown</option></select></label>
            <button type="button" className="button button--secondary" onClick={() => void copyPreview()}><Clipboard size={14} /> Copy</button>
            <button type="button" className="button button--secondary" onClick={downloadPreview}><Download size={14} /> Browser download</button>
          </div>
          <pre><code>{payload}</code></pre>
          <p><ShieldCheck size={12} /> This is an inspectable renderer payload; it is not a native snapshot, backup, restore point, or filesystem write.</p>
        </section>
      ) : null}

      <aside className="workspace-snapshot-preview__boundary">
        <ShieldCheck size={16} />
        <div><strong>Boundary: preview only</strong><p>Omnia does not read files, freeze a run, persist a restore point, or send provider data from this surface. A future native snapshot contract must supply authoritative IDs, hashes, scope, and verification.</p></div>
      </aside>
    </section>
  );
}
