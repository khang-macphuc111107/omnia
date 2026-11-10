import {
  Check,
  Copy,
  Download,
  FileJson,
  History,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  Upload,
  Redo2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  COMPOSER_DRAFT_MODES,
  importComposerPortableDraft,
  serializeComposerDraftBundle,
  serializeComposerDraftMarkdown,
  type ComposerDraftPortableFormat,
  type ComposerDraftMode,
} from "./composer-draft-contract";
import type { ComposerDraftHistoryController } from "./composer-draft-history";
import { compareComposerDraftVersions, summarizeComposerDraftVersion } from "./composer-draft-versions";

interface DraftSnapshot {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

interface DraftStudioSession {
  mode: ComposerDraftMode;
  snapshots: DraftSnapshot[];
  comparisonSnapshotId: string;
  comparison: {
    snapshotId: string;
    snapshotContent: string;
    currentContent: string;
    result: ReturnType<typeof compareComposerDraftVersions>;
  } | null;
}

export interface ComposerDraftStudioProps {
  conversationId: string;
  draft: string;
  controller: ComposerDraftHistoryController;
  disabled?: boolean;
  /**
   * Chat keeps the primary message editor above optional draft tooling so the
   * first viewport reads as a conversation. Standalone Draft Studio previews
   * stay expanded by default for backwards-compatible inspection.
   */
  initiallyExpanded?: boolean;
}

const defaultSession = (): DraftStudioSession => ({ mode: "chat", snapshots: [], comparisonSnapshotId: "", comparison: null });

function downloadDraft(filename: string, payload: string, format: ComposerDraftPortableFormat) {
  const blob = new Blob([payload], {
    type: format === "json" ? "application/json" : "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("The selected file could not be read."));
    reader.readAsText(file);
  });
}

export function ComposerDraftStudio({
  conversationId,
  draft,
  controller,
  disabled = false,
  initiallyExpanded = true,
}: ComposerDraftStudioProps) {
  const sessionsRef = useRef<Record<string, DraftStudioSession>>({});
  const [, forceRender] = useState(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [snapshotName, setSnapshotName] = useState("");
  const [portableFormat, setPortableFormat] = useState<ComposerDraftPortableFormat>("json");
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const session = sessionsRef.current[conversationId] ?? (sessionsRef.current[conversationId] = defaultSession());
  const selectedMode = COMPOSER_DRAFT_MODES.find((mode) => mode.id === session.mode) ?? COMPOSER_DRAFT_MODES[0]!;

  const mutateSession = (mutator: (current: DraftStudioSession) => void) => {
    mutator(session);
    forceRender((value) => value + 1);
  };

  const setMode = (mode: ComposerDraftMode) => {
    mutateSession((current) => {
      current.mode = mode;
    });
    setStatus({ tone: "success", message: `Draft intent set to ${COMPOSER_DRAFT_MODES.find((item) => item.id === mode)?.label ?? mode}.` });
  };

  const applyTemplate = () => {
    if (!selectedMode.template) {
      setStatus({ tone: "success", message: "Chat mode starts with a blank draft; no template was inserted." });
      return;
    }
    const nextDraft = draft.trim()
      ? `${draft.trimEnd()}\n\n${selectedMode.template}`
      : selectedMode.template;
    controller.update(nextDraft, "studio");
    setStatus({ tone: "success", message: `${selectedMode.label} starter appended to this renderer draft.` });
  };

  const saveSnapshot = () => {
    const name = snapshotName.trim();
    if (!name) {
      setStatus({ tone: "error", message: "Enter a name before saving a draft snapshot." });
      return;
    }
    const snapshot: DraftSnapshot = {
      id: `draft-snapshot-${Date.now()}-${session.snapshots.length}`,
      name,
      content: draft,
      createdAt: new Date().toISOString(),
    };
    mutateSession((current) => {
      current.snapshots = [snapshot, ...current.snapshots.filter((item) => item.name !== name)].slice(0, 20);
      current.comparisonSnapshotId = snapshot.id;
      current.comparison = null;
    });
    setSnapshotName("");
    setStatus({ tone: "success", message: `Snapshot “${name}” saved for this renderer session.` });
  };

  const compareWithCurrent = () => {
    const snapshot = session.snapshots.find((item) => item.id === session.comparisonSnapshotId);
    if (!snapshot) {
      setStatus({ tone: "error", message: "Choose a saved snapshot before comparing versions." });
      return;
    }
    mutateSession((current) => {
      current.comparison = {
        snapshotId: snapshot.id,
        snapshotContent: snapshot.content,
        currentContent: draft,
        result: compareComposerDraftVersions(snapshot.content, draft),
      };
    });
    setStatus({ tone: "success", message: `Compared current draft with “${snapshot.name}”; this diff is renderer-session-only.` });
  };

  const restoreSnapshot = (snapshot: DraftSnapshot) => {
    controller.update(snapshot.content, "studio");
    setStatus({ tone: "success", message: `Snapshot “${snapshot.name}” restored. Undo can return to the previous draft.` });
  };

  const removeSnapshot = (snapshot: DraftSnapshot) => {
    mutateSession((current) => {
      current.snapshots = current.snapshots.filter((item) => item.id !== snapshot.id);
      if (current.comparisonSnapshotId === snapshot.id) current.comparisonSnapshotId = "";
      if (current.comparison?.snapshotId === snapshot.id) current.comparison = null;
    });
    setStatus({ tone: "success", message: `Snapshot “${snapshot.name}” removed from this renderer session.` });
  };

  const clearSnapshots = () => {
    if (session.snapshots.length === 0) {
      setStatus({ tone: "success", message: "There are no renderer-session snapshots to clear." });
      return;
    }
    mutateSession((current) => {
      current.snapshots = [];
      current.comparisonSnapshotId = "";
      current.comparison = null;
    });
    setStatus({ tone: "success", message: "All draft snapshots were cleared from this renderer session." });
  };

  const resetDraft = () => {
    if (draft.length === 0) {
      setStatus({ tone: "success", message: "The current draft is already empty." });
      return;
    }
    controller.reset();
    setStatus({ tone: "success", message: "Current draft reset. Undo can restore the previous content." });
  };

  const portableDraftPayload = () => {
    const options = {
      conversationId,
      mode: session.mode,
      title: snapshotName.trim() || selectedMode.label,
      content: draft,
    };
    return portableFormat === "json"
      ? serializeComposerDraftBundle(options)
      : serializeComposerDraftMarkdown(options);
  };

  const exportDraft = () => {
    const payload = portableDraftPayload();
    const extension = portableFormat === "json" ? "json" : "md";
    downloadDraft(`omnia-draft-${conversationId}.${extension}`, payload, portableFormat);
    setStatus({
      tone: "success",
      message: `Portable ${portableFormat === "json" ? "JSON bundle" : "Markdown draft"} exported through this browser preview.`,
    });
  };

  const copyDraft = async () => {
    const payload = portableDraftPayload();
    const label = portableFormat === "json" ? "JSON bundle" : "Markdown draft";
    if (!navigator.clipboard?.writeText) {
      setStatus({ tone: "error", message: `Clipboard access is unavailable in this surface; no ${label.toLowerCase()} was copied.` });
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setStatus({ tone: "success", message: `Portable ${label} copied from this renderer preview.` });
    } catch {
      setStatus({ tone: "error", message: `Clipboard access was denied; no ${label.toLowerCase()} was copied.` });
    }
  };

  const importDraft = async (file: File) => {
    try {
      const result = importComposerPortableDraft(await readFileText(file));
      if (!result.ok) throw new Error(result.errors.join(" "));
      controller.update(result.bundle.content, "studio");
      mutateSession((current) => {
        current.mode = result.bundle.mode;
      });
      const sourceNote = result.source === "plain-markdown" || result.bundle.conversationId === conversationId
        ? ""
        : " The source conversation differs; it was applied only to the current conversation.";
      const sourceLabel = result.source === "json"
        ? "JSON bundle"
        : result.source === "markdown"
          ? "portable Markdown draft"
          : "plain Markdown draft";
      setStatus({ tone: "success", message: `${sourceLabel} imported.${sourceNote}` });
    } catch (error) {
      setStatus({ tone: "error", message: error instanceof Error ? error.message : "Draft bundle could not be imported." });
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <section className="composer-draft-studio" aria-label="Draft Studio">
      <header className="composer-draft-studio__header">
        <div className="composer-draft-studio__title">
          <span className="composer-draft-studio__icon" aria-hidden="true"><History size={14} /></span>
          <span>
            <strong>Draft Studio</strong>
            <small>Renderer-session controls · per conversation</small>
          </span>
        </div>
        <button
          type="button"
          className="composer-draft-studio__collapse"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse Draft Studio" : "Expand Draft Studio"}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          <span>{expanded ? "Collapse" : "Expand"}</span>
        </button>
      </header>

      {expanded ? (
        <div className="composer-draft-studio__body">
          <div className="composer-draft-studio__modes" role="radiogroup" aria-label="Draft intent">
            {COMPOSER_DRAFT_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={session.mode === mode.id}
                className={`composer-draft-mode composer-draft-mode--${mode.tone}${session.mode === mode.id ? " composer-draft-mode--active" : ""}`}
                onClick={() => setMode(mode.id)}
                disabled={disabled}
              >
                <span className="composer-draft-mode__dot" aria-hidden="true" />
                <span>
                  <strong>{mode.label}</strong>
                  <small>{mode.description}</small>
                </span>
              </button>
            ))}
          </div>

          <div className="composer-draft-studio__actions" role="group" aria-label="Draft history actions">
            <button type="button" className="button button--secondary" aria-label="Undo draft change" disabled={disabled || !controller.canUndo} onClick={controller.undo}>
              <Undo2 size={13} /> Undo <span className="composer-draft-count">{controller.undoCount}</span>
            </button>
            <button type="button" className="button button--secondary" aria-label="Redo draft change" disabled={disabled || !controller.canRedo} onClick={controller.redo}>
              <Redo2 size={13} /> Redo <span className="composer-draft-count">{controller.redoCount}</span>
            </button>
            <button type="button" className="button button--ghost" aria-label="Reset current draft" disabled={disabled} onClick={resetDraft}>
              <RotateCcw size={13} /> Reset
            </button>
            <button type="button" className="button button--ghost" onClick={applyTemplate} disabled={disabled}>
              <Plus size={13} /> Insert {selectedMode.label} starter
            </button>
          </div>

          <div className="composer-draft-studio__snapshot-row">
            <label htmlFor="composer-draft-snapshot-name">
              <span>
                <strong>Draft snapshot name</strong>
                <small>Keep a local checkpoint before a rewrite</small>
              </span>
              <input
                id="composer-draft-snapshot-name"
                aria-label="Draft snapshot name"
                value={snapshotName}
                onChange={(event) => setSnapshotName(event.target.value)}
                placeholder="e.g. Before refactor"
                maxLength={80}
                disabled={disabled}
              />
            </label>
            <button type="button" className="button button--secondary" aria-label="Save draft snapshot" onClick={saveSnapshot} disabled={disabled}>
              <Save size={13} /> Save snapshot
            </button>
          </div>

          <section className="composer-draft-studio__snapshots" aria-label="Draft snapshots">
            <div className="composer-draft-studio__section-heading">
              <span><FileJson size={13} /> Saved draft snapshots</span>
              <span className="composer-draft-studio__section-actions">
                <small>{session.snapshots.length}/20</small>
                <button type="button" className="button button--ghost" aria-label="Clear all draft snapshots" onClick={clearSnapshots} disabled={disabled || session.snapshots.length === 0}>
                  <Trash2 size={12} /> Clear
                </button>
              </span>
            </div>
            {session.snapshots.length > 0 ? (
              <ul role="list" aria-label="Saved draft snapshots">
                {session.snapshots.map((snapshot) => (
                  <li key={snapshot.id} className="composer-draft-snapshot">
                    <span>
                      <strong>{snapshot.name}</strong>
                      <small>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.content.length.toLocaleString()} chars</small>
                    </span>
                    <span className="composer-draft-snapshot__actions">
                      <button type="button" className="button button--ghost" aria-label={`Restore snapshot ${snapshot.name}`} onClick={() => restoreSnapshot(snapshot)} disabled={disabled}>
                        Restore
                      </button>
                      <button type="button" className="icon-button" aria-label={`Remove snapshot ${snapshot.name}`} onClick={() => removeSnapshot(snapshot)} disabled={disabled}>
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="composer-draft-studio__empty">No snapshots yet. Save one before experimenting with a long draft.</p>
            )}
          </section>

          <section className="composer-draft-studio__compare" aria-label="Draft version comparison">
            <div className="composer-draft-studio__compare-heading">
              <span><strong>Compare versions</strong><small>Saved checkpoint vs. current draft · line-level preview</small></span>
              <label>
                <span className="sr-only">Version to compare</span>
                <select
                  aria-label="Version to compare"
                  value={session.comparisonSnapshotId}
                  onChange={(event) => mutateSession((current) => {
                    current.comparisonSnapshotId = event.target.value;
                    current.comparison = null;
                  })}
                  disabled={disabled || session.snapshots.length === 0}
                >
                  <option value="">Choose saved snapshot</option>
                  {session.snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.name}</option>)}
                </select>
              </label>
              <button type="button" className="button button--secondary" onClick={compareWithCurrent} disabled={disabled || !session.comparisonSnapshotId}>
                Compare now
              </button>
            </div>
            {(() => {
              const comparison = session.comparison;
              const snapshot = comparison ? session.snapshots.find((item) => item.id === comparison.snapshotId) : null;
              if (!comparison || !snapshot) {
                return <p className="composer-draft-studio__empty">Save a checkpoint, choose it, then compare it with the current composer draft.</p>;
              }
              const stale = comparison.currentContent !== draft || comparison.snapshotContent !== snapshot.content;
              const beforeStats = summarizeComposerDraftVersion(comparison.snapshotContent);
              const afterStats = summarizeComposerDraftVersion(comparison.currentContent);
              const result = comparison.result;
              return (
                <div className="composer-draft-compare-result" role="region" aria-label="Draft version diff">
                  <div className="composer-draft-compare-result__summary">
                    <span><strong>{snapshot.name}</strong><small>Saved checkpoint · {beforeStats.words} words</small></span>
                    <span aria-hidden="true">→</span>
                    <span><strong>Current draft</strong><small>{stale ? "Draft changed · compare again" : `Compared · ${afterStats.words} words`}</small></span>
                    <span className="composer-draft-compare-result__stats">{beforeStats.lines} → {afterStats.lines} lines · {result.addedLines} added · {result.removedLines} removed · {result.characterDelta >= 0 ? "+" : ""}{result.characterDelta} chars · ~{result.estimatedTokenDelta >= 0 ? "+" : ""}{result.estimatedTokenDelta} tokens</span>
                  </div>
                  {result.tooLarge ? (
                    <p className="composer-draft-studio__empty" role="status">This pair is too large for an interactive line diff. Character and estimated token deltas are still available.</p>
                  ) : result.changed ? (
                    <ol className="composer-draft-compare-diff" aria-label="Version line changes">
                      {result.preview.map((line, index) => (
                        <li key={`${line.kind}-${line.lineNumber}-${index}`} className={`composer-draft-compare-diff__line composer-draft-compare-diff__line--${line.kind}`}>
                          <span>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : "·"}</span>
                          <code>{line.text || " "}</code>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="composer-draft-studio__empty" role="status">No content changes between these two versions.</p>
                  )}
                  {result.truncated ? <small className="composer-draft-compare-result__note">Showing the first {result.preview.length} changed/context lines.</small> : null}
                  <p className="composer-draft-compare-result__boundary">Text-only renderer preview. No durable revision, artifact history, or provider comparison is created.</p>
                </div>
              );
            })()}
          </section>

          <div className="composer-draft-studio__portable" aria-label="Portable draft import and export">
            <div className="composer-draft-studio__portable-heading">
              <span>
                <strong>Portable draft</strong>
                <small>Move a draft as JSON or ordinary Markdown</small>
              </span>
              <label>
                <span className="sr-only">Portable draft format</span>
                <select
                  aria-label="Portable draft format"
                  value={portableFormat}
                  onChange={(event) => setPortableFormat(event.target.value as ComposerDraftPortableFormat)}
                  disabled={disabled}
                >
                  <option value="json">JSON bundle</option>
                  <option value="markdown">Markdown</option>
                </select>
              </label>
            </div>
            <div className="composer-draft-studio__io" role="group" aria-label="Draft import and export">
            <button type="button" className="button button--ghost" onClick={() => void copyDraft()} disabled={disabled}>
              <Copy size={13} /> Copy {portableFormat === "json" ? "JSON" : "Markdown"}
            </button>
            <button type="button" className="button button--ghost" onClick={exportDraft} disabled={disabled}>
              <Download size={13} /> Export {portableFormat === "json" ? "JSON" : "Markdown"}
            </button>
            <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()} disabled={disabled}>
              <Upload size={13} /> Import file
            </button>
            <input
              ref={importInputRef}
              className="sr-only"
              type="file"
              accept="application/json,text/markdown,text/plain,.json,.md,.markdown,.txt"
              aria-label="Import portable draft"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importDraft(file);
              }}
            />
            </div>
            <p className="composer-draft-studio__portable-note">
              Markdown stays readable outside Omnia. Omnia metadata is only a local comment when exported from this preview.
            </p>
          </div>

          {status ? (
            <div className={`composer-draft-studio__status composer-draft-studio__status--${status.tone}`} role={status.tone === "error" ? "alert" : "status"} aria-live="polite" aria-label="Draft session status">
              <Check size={13} aria-hidden="true" />
              <span>{status.message}</span>
            </div>
          ) : null}
          <p className="composer-draft-studio__boundary" role="note">
            Draft history, snapshots and portable JSON/Markdown import/export stay in this renderer session. Browser downloads do not choose a workspace path or create a native receipt; native draft persistence, provider behavior and team sync are planned separately.
          </p>
        </div>
      ) : null}
    </section>
  );
}
