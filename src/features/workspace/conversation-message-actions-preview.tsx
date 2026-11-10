import {
  ArrowDownToLine,
  Bookmark,
  Check,
  GitBranch,
  Pencil,
  RefreshCw,
  Sparkles,
  Volume2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useWorkspaceStore } from "./store";
import type { ArtifactView, ChatMessage } from "./types";
import { recordMessageAction } from "./message-action-history-session";

export type ConversationMessagePreviewAction =
  | "edit"
  | "branch"
  | "continue"
  | "regenerate"
  | "read-aloud"
  | "artifact";

interface ActionMeta {
  label: string;
  title: string;
  eyebrow: string;
  description: string;
  primaryLabel: string;
  icon: LucideIcon;
}

const ACTION_META: Record<ConversationMessagePreviewAction, ActionMeta> = {
  edit: {
    label: "Edit and branch preview",
    title: "Edit message",
    eyebrow: "Draft revision",
    description: "Rehearse a message edit without replacing the visible transcript.",
    primaryLabel: "Load edited draft",
    icon: Pencil,
  },
  branch: {
    label: "Branch from here preview",
    title: "Create a branch candidate",
    eyebrow: "Alternate path",
    description: "Name a possible path from this message before a native branch bridge exists.",
    primaryLabel: "Stage branch preview",
    icon: GitBranch,
  },
  continue: {
    label: "Continue response preview",
    title: "Continue response",
    eyebrow: "Continuation candidate",
    description: "Choose a direction for the next assistant turn and inspect the intent without sending a provider request.",
    primaryLabel: "Prepare continuation preview",
    icon: ArrowDownToLine,
  },
  regenerate: {
    label: "Regenerate response preview",
    title: "Prepare a regeneration",
    eyebrow: "Retry candidate",
    description: "Choose a retry style and inspect the action intent without sending a provider request.",
    primaryLabel: "Prepare retry preview",
    icon: RefreshCw,
  },
  "read-aloud": {
    label: "Read aloud preview",
    title: "Read aloud",
    eyebrow: "Voice rehearsal",
    description: "Configure a local read-aloud rehearsal for this response.",
    primaryLabel: "Queue voice preview",
    icon: Volume2,
  },
  artifact: {
    label: "Save as artifact preview",
    title: "Stage an artifact",
    eyebrow: "Artifact draft",
    description: "Shape an artifact candidate while keeping durable saving explicit.",
    primaryLabel: "Stage artifact preview",
    icon: Bookmark,
  },
};

function defaultArtifactTitle(message: ChatMessage): string {
  const firstLine = message.content.split(/\r?\n/)[0]?.trim();
  if (firstLine) return firstLine.replace(/^#+\s*/, "").slice(0, 72);
  return message.role === "assistant" ? "Omnia response" : "Conversation draft";
}

function boundaryCopy(action: ConversationMessagePreviewAction): string {
  if (action === "edit") {
    return "Renderer-local only · the original message stays unchanged · native edit-as-branch is planned.";
  }
  if (action === "branch") {
    return "Preview only · no durable branch, promotion, merge, or rollback is created.";
  }
  if (action === "continue") {
    return "Preview only · no provider request, continuation run, token spend, or native receipt is created.";
  }
  if (action === "regenerate") {
    return "Preview only · no provider request, token spend, or retry receipt is created.";
  }
  if (action === "read-aloud") {
    return "Renderer-local voice settings · no audio upload, native speech receipt, or durable transcript is created.";
  }
  return "Renderer-local artifact draft · no file write, upload, or durable artifact revision is created.";
}

/**
 * Small, intentionally renderer-local action workbench for message affordances.
 *
 * The existing native contracts remain available to the desktop bridge, but a
 * browser preview should still let a user inspect the shape of each action
 * instead of presenting a dead disabled button.
 */
export function ConversationMessageActionPreview({
  action,
  message,
  conversationId,
}: {
  action: ConversationMessagePreviewAction;
  message: ChatMessage;
  conversationId?: string;
}) {
  const updateDraft = useWorkspaceStore((state) => state.updateDraft);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [editValue, setEditValue] = useState(message.content);
  const [branchName, setBranchName] = useState("");
  const [continuationMode, setContinuationMode] = useState("follow-thread");
  const [regenerateMode, setRegenerateMode] = useState("retry-current");
  const [voicePreset, setVoicePreset] = useState("browser-default");
  const [voiceRate, setVoiceRate] = useState("1");
  const [artifactTitle, setArtifactTitle] = useState(() => defaultArtifactTitle(message));
  const [artifactType, setArtifactType] = useState<ArtifactView["type"]>("Markdown");
  const meta = ACTION_META[action];
  const Icon = meta.icon;
  const panelId = useId();
  const titleId = `${panelId}-title`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) setEditValue(message.content);
  }, [message.content, open]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent("omnia:close-floating-menus", { detail: { source: panelId } }));
    const frame = window.requestAnimationFrame(() => {
      const firstField = document.getElementById(panelId)?.querySelector<HTMLElement>(
        "textarea, input, select, button",
      );
      firstField?.focus({ preventScroll: true });
    });
    const onCloseFloating = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== panelId) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("omnia:close-floating-menus", onCloseFloating);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("omnia:close-floating-menus", onCloseFloating);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, panelId]);

  const announce = (nextStatus: string) => {
    setStatus(nextStatus);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const handlePrimary = () => {
    const record = (label: string) => {
      if (!conversationId) return;
      recordMessageAction({
        conversationId,
        messageId: message.id,
        role: message.role,
        action,
        label,
      });
    };
    if (action === "edit") {
      updateDraft(editValue);
      record("Edited draft loaded");
      announce("Edited draft loaded into the composer. Renderer-local preview only.");
      return;
    }
    if (action === "branch") {
      const label = branchName.trim() || "Untitled branch candidate";
      record(`Branch candidate staged · ${label}`);
      announce(`Branch candidate “${label}” staged in this renderer session. No native branch was created.`);
      return;
    }
    if (action === "continue") {
      const label = continuationMode === "follow-thread"
        ? "follow the current thread"
        : continuationMode === "add-examples"
          ? "add examples and edge cases"
          : "summarize first, then continue";
      record(`Continuation prepared · ${label}`);
      announce(`Continuation candidate prepared: ${label}. No provider request was sent; provider dispatch remains planned.`);
      return;
    }
    if (action === "regenerate") {
      const label = regenerateMode === "retry-current"
        ? "retry current settings"
        : regenerateMode === "concise"
          ? "concise answer"
          : "deeper explanation";
      record(`Regeneration prepared · ${label}`);
      announce(`Regeneration candidate prepared: ${label}. Provider dispatch remains planned.`);
      return;
    }
    if (action === "read-aloud") {
      record(`Voice preview queued · ${voicePreset} · ${voiceRate}×`);
      announce(`Voice preview queued with ${voicePreset === "browser-default" ? "browser default" : voicePreset} at ${voiceRate}×. No audio was generated.`);
      return;
    }
    record(`Artifact staged · ${artifactTitle.trim() || "Untitled artifact"}`);
    announce(`Artifact “${artifactTitle.trim() || "Untitled artifact"}” (${artifactType}) staged as a renderer preview. Durable save remains planned.`);
  };

  return (
    <span ref={rootRef} className="conversation-message-action-preview">
      <button
        ref={triggerRef}
        type="button"
        title={meta.label}
        aria-label={meta.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setOpen((value) => !value);
          setStatus(null);
        }}
      >
        {open ? <X size={14} /> : <Icon size={14} />}
      </button>

      {open ? (
        <section id={panelId} className="conversation-message-action-preview__panel" role="dialog" aria-labelledby={titleId}>
          <header>
            <div>
              <span className="eyebrow">{meta.eyebrow}</span>
              <h3 id={titleId}>{meta.title}</h3>
            </div>
            <Sparkles size={14} aria-hidden="true" />
          </header>
          <p className="conversation-message-action-preview__description">{meta.description}</p>

          {action === "edit" ? (
            <label className="conversation-message-action-preview__field">
              <span>Edited message</span>
              <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={5} />
            </label>
          ) : null}

          {action === "branch" ? (
            <label className="conversation-message-action-preview__field">
              <span>Branch name</span>
              <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="e.g. Explore a local route" />
            </label>
          ) : null}

          {action === "continue" ? (
            <label className="conversation-message-action-preview__field">
              <span>Continuation style</span>
              <select value={continuationMode} onChange={(event) => setContinuationMode(event.target.value)}>
                <option value="follow-thread">Follow the current thread</option>
                <option value="add-examples">Add examples and edge cases</option>
                <option value="summarize-next">Summarize first, then continue</option>
              </select>
            </label>
          ) : null}

          {action === "regenerate" ? (
            <label className="conversation-message-action-preview__field">
              <span>Retry style</span>
              <select value={regenerateMode} onChange={(event) => setRegenerateMode(event.target.value)}>
                <option value="retry-current">Retry with current settings</option>
                <option value="concise">Ask for a more concise answer</option>
                <option value="deeper">Ask for a deeper explanation</option>
              </select>
            </label>
          ) : null}

          {action === "read-aloud" ? (
            <div className="conversation-message-action-preview__fields">
              <label className="conversation-message-action-preview__field">
                <span>Voice preset</span>
                <select value={voicePreset} onChange={(event) => setVoicePreset(event.target.value)}>
                  <option value="browser-default">Browser default</option>
                  <option value="calm">Calm narrator</option>
                  <option value="bright">Bright explainer</option>
                </select>
              </label>
              <label className="conversation-message-action-preview__field">
                <span>Rate</span>
                <select value={voiceRate} onChange={(event) => setVoiceRate(event.target.value)}>
                  <option value="0.8">0.8× slower</option>
                  <option value="1">1× natural</option>
                  <option value="1.2">1.2× faster</option>
                </select>
              </label>
            </div>
          ) : null}

          {action === "artifact" ? (
            <div className="conversation-message-action-preview__fields">
              <label className="conversation-message-action-preview__field">
                <span>Artifact title</span>
                <input value={artifactTitle} onChange={(event) => setArtifactTitle(event.target.value)} />
              </label>
              <label className="conversation-message-action-preview__field">
                <span>Format</span>
                <select value={artifactType} onChange={(event) => setArtifactType(event.target.value as ArtifactView["type"])}>
                  <option value="Markdown">Markdown</option>
                  <option value="Code">Code</option>
                  <option value="Diagram">Diagram</option>
                  <option value="Data">Data</option>
                </select>
              </label>
            </div>
          ) : null}

          <p className="conversation-message-action-preview__boundary">{boundaryCopy(action)}</p>
          <footer>
            <button
              type="button"
              className="button button--ghost"
              title="Close this message action preview"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
              }}
            >
              Cancel
            </button>
            <button type="button" className="button button--secondary" onClick={handlePrimary} title={meta.primaryLabel}>
              <Check size={14} /> {meta.primaryLabel}
            </button>
          </footer>
        </section>
      ) : null}

      {status ? <span className="conversation-message-action-preview__status" role="status" aria-live="polite">{status}</span> : null}
    </span>
  );
}
