import {
  AlignLeft,
  Check,
  Keyboard,
  RotateCcw,
  Settings2,
  WrapText,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type ComposerEditorWrapMode = "soft" | "off";

export type ComposerEditorPreferences = {
  wrap: ComposerEditorWrapMode;
  spellCheck: boolean;
  autoContinue: boolean;
};

export const DEFAULT_COMPOSER_EDITOR_PREFERENCES: ComposerEditorPreferences = {
  wrap: "soft",
  spellCheck: true,
  autoContinue: true,
};

export type ComposerEditorDraftSummary = {
  chars: number;
  words: number;
  lines: number;
  line: number;
  column: number;
  selectedChars: number;
};

/**
 * Computes source-editor metrics without parsing the draft into rich nodes.
 * The summary is intentionally renderer-local and safe to show while a draft
 * is incomplete, inside a code fence, or contains malformed Markdown.
 */
export function summarizeComposerEditorDraft(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerEditorDraftSummary {
  const start = Math.max(0, Math.min(value.length, Math.min(selectionStart, selectionEnd)));
  const end = Math.max(0, Math.min(value.length, Math.max(selectionStart, selectionEnd)));
  const beforeCaret = value.slice(0, start);
  const lineBreaks = value.match(/\n/g)?.length ?? 0;
  const lineStart = beforeCaret.lastIndexOf("\n") + 1;

  return {
    chars: value.length,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
    lines: Math.max(1, lineBreaks + 1),
    line: lineBreaks + 1,
    column: start - lineStart + 1,
    selectedChars: end - start,
  };
}

export interface ComposerEditorWorkbenchProps {
  readonly draft: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly preferences: ComposerEditorPreferences;
  readonly onPreferencesChange: (preferences: ComposerEditorPreferences) => void;
  readonly onResetPreferences: () => void;
}

function preferenceLabel(preferences: ComposerEditorPreferences): string {
  const wrap = preferences.wrap === "soft" ? "wrap" : "no wrap";
  const spell = preferences.spellCheck ? "spellcheck" : "spellcheck off";
  return `${wrap} · ${spell}`;
}

export function ComposerEditorWorkbench({
  draft,
  selectionStart,
  selectionEnd,
  preferences,
  onPreferencesChange,
  onResetPreferences,
}: ComposerEditorWorkbenchProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const summary = useMemo(
    () => summarizeComposerEditorDraft(draft, selectionStart, selectionEnd),
    [draft, selectionEnd, selectionStart],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const update = (patch: Partial<ComposerEditorPreferences>) => {
    onPreferencesChange({ ...preferences, ...patch });
  };

  return (
    <div ref={rootRef} className="composer-editor-workbench popover-anchor">
      <button
        type="button"
        className={open ? "composer-editor-workbench__trigger composer-editor-workbench__trigger--active" : "composer-editor-workbench__trigger"}
        aria-label="Editor tools"
        aria-expanded={open}
        aria-controls={open ? "composer-editor-workbench-panel" : undefined}
        title={`Editor tools · ${preferenceLabel(preferences)}`}
        onClick={() => setOpen((current) => !current)}
      >
        <Settings2 size={13} aria-hidden="true" />
        <span>Editor tools</span>
      </button>
      {open ? (
        <section
          id="composer-editor-workbench-panel"
          className="composer-popover composer-editor-workbench__panel"
          role="dialog"
          aria-label="Editor workbench"
        >
          <header className="composer-editor-workbench__header">
            <div>
              <strong>Editor workbench</strong>
              <small>Source-first Markdown drafting controls</small>
            </div>
            <span className="composer-editor-workbench__badge">Session-only</span>
          </header>

          <div className="composer-editor-workbench__stats" aria-label="Draft cursor statistics">
            <div><span>Line</span><strong>{summary.line}</strong></div>
            <div><span>Column</span><strong>{summary.column}</strong></div>
            <div><span>Selection</span><strong>{summary.selectedChars.toLocaleString()}</strong></div>
            <div><span>Words</span><strong>{summary.words.toLocaleString()}</strong></div>
            <div><span>Lines</span><strong>{summary.lines.toLocaleString()}</strong></div>
            <div><span>Chars</span><strong>{summary.chars.toLocaleString()}</strong></div>
          </div>

          <div className="composer-editor-workbench__section" aria-label="Editor preferences">
            <div className="composer-editor-workbench__section-heading">
              <span><AlignLeft size={13} aria-hidden="true" /><strong>Editor preferences</strong></span>
              <button type="button" className="composer-editor-workbench__reset" onClick={onResetPreferences}>
                <RotateCcw size={12} aria-hidden="true" /> Reset
              </button>
            </div>
            <div className="composer-editor-workbench__preference-grid">
              <div className="composer-editor-workbench__preference">
                <span className="composer-editor-workbench__preference-label"><WrapText size={13} aria-hidden="true" />Wrap lines</span>
                <div className="composer-editor-workbench__segmented" role="group" aria-label="Wrap lines">
                  {(["soft", "off"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={preferences.wrap === value}
                      className={preferences.wrap === value ? "composer-editor-workbench__segment composer-editor-workbench__segment--active" : "composer-editor-workbench__segment"}
                      onClick={() => update({ wrap: value })}
                    >
                      {value === "soft" ? "Soft" : "Off"}
                    </button>
                  ))}
                </div>
              </div>
              <label className="composer-editor-workbench__check">
                <input
                  type="checkbox"
                  checked={preferences.spellCheck}
                  onChange={(event) => update({ spellCheck: event.target.checked })}
                />
                <span><strong>Spellcheck</strong><small>Browser-local hints</small></span>
              </label>
              <label className="composer-editor-workbench__check">
                <input
                  type="checkbox"
                  checked={preferences.autoContinue}
                  onChange={(event) => update({ autoContinue: event.target.checked })}
                />
                <span><strong>Continue blocks</strong><small>Lists and fenced code on Enter</small></span>
              </label>
            </div>
          </div>

          <div className="composer-editor-workbench__section" aria-label="Editor shortcuts">
            <div className="composer-editor-workbench__section-heading">
              <span><Keyboard size={13} aria-hidden="true" /><strong>Quick shortcuts</strong></span>
            </div>
            <div className="composer-editor-workbench__shortcut-grid">
              <span><kbd>Ctrl/Cmd</kbd> + <kbd>B</kbd><small>Bold</small></span>
              <span><kbd>Ctrl/Cmd</kbd> + <kbd>I</kbd><small>Italic</small></span>
              <span><kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd><small>Indent</small></span>
              <span><kbd>Ctrl/Cmd</kbd> + <kbd>Z</kbd><small>Undo</small></span>
            </div>
          </div>

          <p className="composer-editor-workbench__boundary">
            <Check size={12} aria-hidden="true" /> Preferences and metrics live in this renderer session. No file, provider, native, or durable editor state is written.
          </p>
        </section>
      ) : null}
    </div>
  );
}
