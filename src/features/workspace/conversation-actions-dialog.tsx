import {
  Archive,
  Check,
  Clipboard,
  Download,
  FileJson,
  Flag,
  Pin,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ModalSurface } from "@/components/modal-surface";

import { useWorkspaceStore } from "./store";
import type { ConversationView } from "./types";

type ConversationActionsView = "manage" | "export";
type ConversationExportFormat = "json" | "markdown";

export interface ConversationActionsDialogProps {
  conversation: ConversationView;
  initialView?: ConversationActionsView;
  exportOnly?: boolean;
  onClose: () => void;
}

function exportConversation(
  conversation: ConversationView,
  format: ConversationExportFormat,
  includeDraft: boolean,
) {
  const boundary = "Renderer-local preview only. This export does not call the native bridge, choose a workspace path, or create a durable receipt.";
  const payload = {
    format: "omnia.conversation.preview.v1",
    scope: "renderer-session",
    exportedAt: new Date().toISOString(),
    boundary,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      project: conversation.projectName,
      branchId: conversation.activeBranchId,
      pinned: conversation.pinned,
      archived: conversation.archived,
      unread: conversation.unread,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      draftIncluded: includeDraft,
      draftLength: conversation.draft.length,
      draft: includeDraft ? conversation.draft : null,
    },
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      status: message.status,
      modelLabel: message.modelLabel,
      runId: message.runId,
      attachmentCount: message.attachments.length,
      branchIndex: message.branchIndex,
      branchCount: message.branchCount,
    })),
  };

  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    `# ${conversation.title} conversation preview`,
    "",
    `> ${boundary}`,
    "",
    `- Project: ${conversation.projectName ?? "Standalone Chat"}`,
    `- Messages: ${conversation.messages.length}`,
    `- Updated: ${conversation.updatedAt}`,
    `- Active branch: ${conversation.activeBranchId}`,
    `- Active draft: ${includeDraft ? `included (${conversation.draft.length} chars)` : "omitted"}`,
    "",
    "## Messages",
    "",
    ...conversation.messages.flatMap((message) => [
      `### ${message.role === "assistant" ? "Omnia" : "You"}${message.modelLabel ? ` · ${message.modelLabel}` : ""}`,
      "",
      message.content || "_No visible content in this renderer snapshot._",
      "",
      `- Status: ${message.status}`,
      `- Attachments: ${message.attachments.length}`,
      `- Branch: ${message.branchIndex}/${message.branchCount}`,
      "",
    ]),
    "## Active draft",
    "",
    includeDraft
      ? (conversation.draft.trim() || "_No active draft in this renderer snapshot._")
      : "_Active draft omitted by export option._",
    "",
  ].join("\n");
}

function downloadConversationPreview(payload: string, format: ConversationExportFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([payload], { type: format === "json" ? "application/json" : "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-conversation-preview.${format === "json" ? "json" : "md"}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (typeof URL.revokeObjectURL === "function") window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function ConversationActionsDialog({
  conversation,
  initialView = "manage",
  exportOnly = false,
  onClose,
}: ConversationActionsDialogProps) {
  const renameConversation = useWorkspaceStore((state) => state.renameConversation);
  const toggleConversationPinned = useWorkspaceStore((state) => state.toggleConversationPinned);
  const setConversationArchived = useWorkspaceStore((state) => state.setConversationArchived);
  const setConversationUnread = useWorkspaceStore((state) => state.setConversationUnread);
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const [view, setView] = useState<ConversationActionsView>(exportOnly ? "export" : initialView);
  const [title, setTitle] = useState(conversation.title);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [exportFormat, setExportFormat] = useState<ConversationExportFormat>("json");
  const [includeDraft, setIncludeDraft] = useState(true);
  const tabRefs = useRef<Record<ConversationActionsView, HTMLButtonElement | null>>({ manage: null, export: null });

  const exportPreview = useMemo(
    () => exportConversation(conversation, exportFormat, includeDraft),
    [conversation, exportFormat, includeDraft],
  );

  const saveTitle = () => {
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === conversation.title) {
      setStatus("Enter a different title to rename this Chat.");
      return;
    }
    renameConversation(conversation.id, nextTitle);
    setStatus("Chat title updated in the current renderer session.");
  };

  const copyExport = async () => {
    try {
      await navigator.clipboard?.writeText(exportPreview);
      setCopied(true);
      setStatus(`Transcript preview copied as ${exportFormat.toUpperCase()}${includeDraft ? " with the active draft" : " without the active draft"}.`);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setStatus("Clipboard access is unavailable in this preview.");
    }
  };

  const downloadExport = () => {
    const exported = downloadConversationPreview(exportPreview, exportFormat);
    setStatus(
      exported
        ? `Started a browser download of the renderer-local ${exportFormat.toUpperCase()} preview${includeDraft ? " with the active draft" : " without the active draft"}.`
        : "Browser download is unavailable in this preview; no transcript was written.",
    );
  };

  const focusTab = (next: ConversationActionsView) => {
    setView(next);
    tabRefs.current[next]?.focus({ preventScroll: true });
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: ConversationActionsView) => {
    if (exportOnly) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || (event.key === "ArrowLeft" && current === "export")
      ? "manage"
      : event.key === "End" || (event.key === "ArrowRight" && current === "manage")
        ? "export"
        : current;
    focusTab(next);
  };

  return (
    <ModalSurface
      className="conversation-actions-dialog"
      ariaLabel="Conversation actions"
      title="Conversation actions"
      description="Manage this Chat or review a renderer-local transcript export before any native export workflow exists."
      onClose={onClose}
    >
      <header className="conversation-actions-dialog__header">
        <div>
          <span className="eyebrow">Chat control surface</span>
          <h2>Conversation actions</h2>
          <p>{conversation.title}</p>
        </div>
        <button type="button" className="icon-button" aria-label="Close conversation actions" title="Close conversation actions" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <div className="conversation-actions-dialog__tabs" role="tablist" aria-label="Conversation action views" aria-orientation="horizontal">
        {!exportOnly ? (
          <button
            ref={(element) => { tabRefs.current.manage = element; }}
            id="conversation-actions-tab-manage"
            type="button"
            role="tab"
            aria-selected={view === "manage"}
            aria-controls="conversation-actions-manage"
            tabIndex={view === "manage" ? 0 : -1}
            className={view === "manage" ? "is-active" : ""}
            title="Manage Chat state and draft controls"
            onClick={() => setView("manage")}
            onKeyDown={(event) => handleTabKeyDown(event, "manage")}
          >
            <Flag size={14} aria-hidden="true" /> Manage Chat
          </button>
        ) : null}
        <button
          ref={(element) => { tabRefs.current.export = element; }}
          id="conversation-actions-tab-export"
          type="button"
          role="tab"
          aria-selected={view === "export"}
          aria-controls="conversation-actions-export"
          tabIndex={view === "export" ? 0 : -1}
          className={view === "export" ? "is-active" : ""}
          title="Preview or export this Chat transcript"
          onClick={() => setView("export")}
          onKeyDown={(event) => handleTabKeyDown(event, "export")}
        >
          <FileJson size={14} aria-hidden="true" /> Export preview
        </button>
      </div>

      {view === "manage" && !exportOnly ? (
        <section id="conversation-actions-manage" role="tabpanel" aria-labelledby="conversation-actions-tab-manage" tabIndex={0} className="conversation-actions-dialog__body">
          <div className="conversation-actions-dialog__hero">
            <span className="conversation-actions-dialog__hero-icon"><Flag size={18} aria-hidden="true" /></span>
            <div>
              <strong>Small controls, clear boundaries</strong>
              <p>These changes are immediately visible in this renderer session. Durable sync and native activity receipts remain planned.</p>
            </div>
          </div>

          <label className="conversation-actions-dialog__field">
            <span>Chat title</span>
            <div>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                aria-label="Chat title"
                placeholder="Name this Chat"
                data-dialog-initial-focus
              />
              <button type="button" className="button button--secondary" disabled={!title.trim() || title.trim() === conversation.title} title="Rename this Chat in the renderer session" onClick={saveTitle}>
                <Check size={14} aria-hidden="true" /> Rename
              </button>
            </div>
          </label>

          <div className="conversation-actions-dialog__grid" aria-label="Chat state controls">
            <button type="button" className="conversation-action-card" title={conversation.pinned ? "Remove this Chat from the pinned view" : "Keep this Chat near the top of the workspace"} onClick={() => { toggleConversationPinned(conversation.id); setStatus(conversation.pinned ? "Chat unpinned for this session." : "Chat pinned for this session."); }}>
              <span className="conversation-action-card__icon"><Pin size={16} aria-hidden="true" /></span>
              <span><strong>{conversation.pinned ? "Unpin Chat" : "Pin Chat"}</strong><small>{conversation.pinned ? "Remove it from the pinned view." : "Keep it near the top of the workspace."}</small></span>
            </button>
            <button type="button" className="conversation-action-card" title={conversation.unread ? "Mark this Chat as read" : "Mark this Chat as unread"} onClick={() => { setConversationUnread(conversation.id, !conversation.unread); setStatus(conversation.unread ? "Chat marked as read." : "Chat marked as unread."); }}>
              <span className="conversation-action-card__icon"><RotateCcw size={16} aria-hidden="true" /></span>
              <span><strong>{conversation.unread ? "Mark as read" : "Mark as unread"}</strong><small>Control the local attention marker.</small></span>
            </button>
            <button type="button" className="conversation-action-card" title="Clear only the active Chat draft" onClick={() => { updateDraft(""); setStatus("The active draft was reset in the renderer session."); }} disabled={!conversation.hasDraft && !conversation.draft.trim()}>
              <span className="conversation-action-card__icon"><RotateCcw size={16} aria-hidden="true" /></span>
              <span><strong>Reset active draft</strong><small>Clear only the current Chat draft.</small></span>
            </button>
            <button type="button" className="conversation-action-card conversation-action-card--danger" title={conversation.runState === "streaming" ? "Stop the active run before archiving" : conversation.archived ? "Restore this Chat from the archive" : "Archive this Chat in the renderer session"} onClick={() => { setConversationArchived(conversation.id, !conversation.archived); setStatus(conversation.archived ? "Chat restored from archive." : "Chat archived for this session."); }} disabled={conversation.runState === "streaming"}>
              <span className="conversation-action-card__icon"><Archive size={16} aria-hidden="true" /></span>
              <span><strong>{conversation.archived ? "Restore from archive" : "Archive Chat"}</strong><small>{conversation.runState === "streaming" ? "Stop the active run before archiving." : "Hide this Chat from active lists."}</small></span>
            </button>
            <button
              type="button"
              className="conversation-action-card"
              data-testid="conversation-action-rerun"
              title="Rerun the latest user prompt"
              onClick={() => {
                const lastUser = [...conversation.messages].reverse().find((m) => m.role === "user")?.content ?? conversation.draft;
                if (lastUser) updateDraft(lastUser);
                setStatus("Rerun prompt staged in the active composer.");
              }}
            >
              <span className="conversation-action-card__icon"><RotateCcw size={16} aria-hidden="true" /></span>
              <span><strong>Rerun</strong><small>Re-stage the latest user turn for immediate execution.</small></span>
            </button>
            <button
              type="button"
              className="conversation-action-card"
              data-testid="conversation-action-compare"
              title="Compare models side-by-side"
              onClick={() => {
                const lastUser = [...conversation.messages].reverse().find((m) => m.role === "user")?.content ?? conversation.draft;
                updateDraft(`/compare ${lastUser || "Evaluate side-by-side across selected models"}`);
                setStatus("Compare mode staged in the active composer.");
              }}
            >
              <span className="conversation-action-card__icon"><Flag size={16} aria-hidden="true" /></span>
              <span><strong>Compare</strong><small>Stage side-by-side multi-model comparison.</small></span>
            </button>
            <button
              type="button"
              className="conversation-action-card"
              data-testid="conversation-action-clone"
              title="Clone this conversation"
              onClick={() => {
                const cloneId = `${conversation.id}-clone-${Date.now()}`;
                const cloned: ConversationView = {
                  ...conversation,
                  id: cloneId,
                  title: `${conversation.title} (Clone)`,
                  updatedAt: new Date().toISOString(),
                };
                useWorkspaceStore.setState((state) => ({
                  conversations: [cloned, ...state.conversations],
                }));
                setStatus(`Cloned conversation as "${cloned.title}".`);
              }}
            >
              <span className="conversation-action-card__icon"><Clipboard size={16} aria-hidden="true" /></span>
              <span><strong>Clone</strong><small>Duplicate transcript and parameters into a new chat.</small></span>
            </button>
            <button
              type="button"
              className="conversation-action-card"
              data-testid="conversation-action-branch"
              title="Branch this conversation into an independent exploration path"
              onClick={() => {
                const branchConvId = `${conversation.id}-branch-${Date.now()}`;
                const branched: ConversationView = {
                  ...conversation,
                  id: branchConvId,
                  title: `${conversation.title} (Branch)`,
                  updatedAt: new Date().toISOString(),
                };
                useWorkspaceStore.setState((state) => ({
                  conversations: [branched, ...state.conversations],
                }));
                setStatus(`Branched conversation as "${branched.title}".`);
              }}
            >
              <span className="conversation-action-card__icon"><Flag size={16} aria-hidden="true" /></span>
              <span><strong>Branch</strong><small>Fork current transcript into a new exploration branch.</small></span>
            </button>
          </div>

          <div className="conversation-actions-dialog__boundary" role="note">
            <ShieldCheck size={15} aria-hidden="true" />
            <span><strong>Renderer-local controls</strong><small>Native persistence, cross-device sync, and durable audit receipts are not claimed by this surface.</small></span>
          </div>
        </section>
      ) : (
        <section id="conversation-actions-export" role="tabpanel" aria-labelledby="conversation-actions-tab-export" tabIndex={0} className="conversation-actions-dialog__body">
          <div className="conversation-actions-dialog__export-heading">
            <div>
              <span className="eyebrow">Renderer-local preview</span>
              <h3>Transcript package</h3>
              <p>{conversation.messages.length} {conversation.messages.length === 1 ? "message" : "messages"} · browser download optional</p>
            </div>
            <div className="conversation-actions-dialog__export-actions" role="toolbar" aria-label="Conversation export preview actions">
              <label>
                <span>Format</span>
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ConversationExportFormat)} aria-label="Conversation export format">
                  <option value="json">JSON</option>
                  <option value="markdown">Markdown</option>
                </select>
              </label>
              <label className="conversation-actions-dialog__checkbox">
                <input
                  type="checkbox"
                  checked={includeDraft}
                  onChange={(event) => setIncludeDraft(event.target.checked)}
                  aria-label="Include active draft"
                />
                <span>Include active draft</span>
              </label>
              <button type="button" className="button button--secondary" title="Copy the renderer-local transcript export" onClick={() => void copyExport()}>
                {copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />} {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="button button--ghost" title="Download the renderer-local transcript export" onClick={downloadExport}><Download size={14} aria-hidden="true" /> Download</button>
            </div>
          </div>
          <pre className="conversation-actions-dialog__code" tabIndex={0}><code>{exportPreview}</code></pre>
          <div className="conversation-actions-dialog__boundary" role="note">
            <Download size={15} aria-hidden="true" />
            <span><strong>Export boundary</strong><small>Copy and browser download serialize only this renderer snapshot. The active draft is optional and stays local to this preview. Native export, workspace path selection, and signed receipts remain planned.</small></span>
          </div>
        </section>
      )}

      {status ? <div className="conversation-actions-dialog__status" role="status" aria-live="polite">{status}</div> : null}
      <footer className="conversation-actions-dialog__footer">
        <span>Renderer preview · undo/redo for settings is planned in the next control-center pass.</span>
        <button type="button" className="button button--primary" title="Close this Chat action surface" onClick={onClose}>Done</button>
      </footer>
    </ModalSurface>
  );
}
