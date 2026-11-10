import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  ListPlus,
  MessageCircle,
  Quote,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  createSelectionReferenceDraft,
  createTextSelectionAnchor,
  formatSelectionReferencePreview,
  selectionReferenceOriginId,
  stableTextHash,
  type SelectionReferenceMode,
  type SelectionSourceKind,
  type SelectionReferenceDraft,
  type TextSelectionAnchor,
} from "./selection-reference";
import { useSelectionReferenceStore } from "./selection-reference-store";

/**
 * A DOMRect cannot be relied on as a durable value and is not available in
 * jsdom. Keep only the scalar viewport coordinates needed by the renderer
 * action surface, with a zeroed fallback for non-layout test environments.
 */
export interface SelectionSurfaceRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface CapturedTextSelection {
  readonly anchor: TextSelectionAnchor;
  readonly rect: SelectionSurfaceRect;
}

/**
 * Returns focus to the rendered source that produced a reference. This is a
 * renderer-only convenience: it never resolves a native receipt or opens an
 * external URL. A missing source is reported to the caller so the UI can keep
 * the stale/unavailable boundary explicit instead of pretending to navigate.
 */
export function focusSelectionReferenceOrigin(reference: SelectionReferenceDraft): boolean {
  if (typeof document === "undefined") return false;
  const target = document.getElementById(selectionReferenceOriginId(reference.anchor));
  if (!(target instanceof HTMLElement)) return false;
  target.focus({ preventScroll: true });
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  return true;
}

export interface CaptureSelectionInput {
  readonly root: HTMLElement;
  readonly selection: Selection | null | undefined;
  readonly sourceKind: SelectionSourceKind;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly capturedAt?: string;
}

function containsNode(root: Node, node: Node): boolean {
  return root === node || root.contains(node);
}

/**
 * Converts a DOM Range boundary to an offset in the rendered textContent of
 * the source root. Using a Range instead of walking text nodes preserves the
 * browser's own whitespace/text normalization for markdown, code and tables.
 */
export function renderedTextOffset(root: HTMLElement, container: Node, offset: number): number {
  if (!containsNode(root, container)) {
    throw new Error("Selection boundary is outside the source root.");
  }

  const boundary = document.createRange();
  boundary.selectNodeContents(root);
  boundary.setEnd(container, Math.max(0, offset));
  return boundary.toString().length;
}

function rectFromRange(range: Range): SelectionSurfaceRect {
  const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  if (!rect) {
    return Object.freeze({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });
  }
  return Object.freeze({
    top: Number.isFinite(rect.top) ? rect.top : 0,
    right: Number.isFinite(rect.right) ? rect.right : 0,
    bottom: Number.isFinite(rect.bottom) ? rect.bottom : 0,
    left: Number.isFinite(rect.left) ? rect.left : 0,
    width: Number.isFinite(rect.width) ? rect.width : 0,
    height: Number.isFinite(rect.height) ? rect.height : 0,
  });
}

function selectionIdFor(sourceId: string, sourceRevisionId: string, startOffset: number, endOffset: number): string {
  return `selection_${sourceId}_${sourceRevisionId}_${startOffset}_${endOffset}`.slice(0, 256);
}

/**
 * Captures a selection only when the complete range belongs to the supplied
 * source root. It fails closed for collapsed, blank, malformed or cross-root
 * selections and creates the exact revision-bound anchor used by the stale
 * re-anchoring contract.
 */
export function captureTextSelection(input: CaptureSelectionInput): CapturedTextSelection | null {
  const selection = input.selection;
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!containsNode(input.root, range.startContainer) || !containsNode(input.root, range.endContainer)) {
    return null;
  }

  const sourceText = input.root.textContent ?? "";
  const exactText = range.toString();
  if (!exactText.trim() || !sourceText) return null;

  let startOffset: number;
  let endOffset: number;
  try {
    startOffset = renderedTextOffset(input.root, range.startContainer, range.startOffset);
    endOffset = renderedTextOffset(input.root, range.endContainer, range.endOffset);
  } catch {
    return null;
  }
  if (endOffset <= startOffset || endOffset > sourceText.length) return null;

  try {
    const anchor = createTextSelectionAnchor({
      selectionId: selectionIdFor(input.sourceId, input.sourceRevisionId, startOffset, endOffset),
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceRevisionId: input.sourceRevisionId,
      sourceText,
      startOffset,
      endOffset,
      ...(input.capturedAt === undefined ? {} : { capturedAt: input.capturedAt }),
    });
    return Object.freeze({ anchor, rect: rectFromRange(range) });
  } catch {
    return null;
  }
}

function actionLabel(mode: SelectionReferenceMode): string {
  if (mode === "reply") return "Reply to selection";
  if (mode === "quote") return "Quote selection";
  return "Add selection as context";
}

export interface SelectionReferenceToolbarProps {
  readonly captured: CapturedTextSelection;
  readonly sourceLabel: string;
  readonly onReference: (mode: SelectionReferenceMode) => void;
  readonly onDismiss: () => void;
}

/** A compact, keyboard-accessible action surface anchored to selected text. */
export function SelectionReferenceToolbar({
  captured,
  sourceLabel,
  onReference,
  onDismiss,
}: SelectionReferenceToolbarProps) {
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(captured.rect.bottom + 8);
  const [left, setLeft] = useState(captured.rect.left);

  useEffect(() => {
    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const width = toolbarRef.current?.getBoundingClientRect().width ?? 330;
    setTop(Math.max(8, captured.rect.bottom + 8));
    setLeft(Math.max(8, Math.min(captured.rect.left, viewportWidth - width - 8)));
  }, [captured.rect.bottom, captured.rect.left]);

  const copy = async () => {
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await clipboard.writeText(captured.anchor.exactText);
      setCopied(true);
      setAnnouncement("Copied selected text to the clipboard.");
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard permission is optional. The exact selection remains visible
      // in the toolbar and can still be attached as a reference.
      setAnnouncement("Clipboard is unavailable; the selected text remains in this preview.");
    }
  };

  const style: CSSProperties = { top, left };
  const excerptId = `selection-reference-toolbar-excerpt-${stableTextHash(captured.anchor.selectionId)}`;
  return (
    <div
      ref={toolbarRef}
      className="selection-reference-toolbar"
      role="toolbar"
      aria-label={`Actions for selected text from ${sourceLabel}`}
      aria-describedby={excerptId}
      style={style}
      onPointerDown={(event) => event.preventDefault()}
    >
      <span id={excerptId} className="selection-reference-toolbar__excerpt" title={captured.anchor.exactText}>
        {captured.anchor.exactText.replace(/\s+/g, " ").trim()}
      </span>
      <span className="selection-reference-toolbar__actions">
        <button
          type="button"
          title={actionLabel("reply")}
          aria-label={actionLabel("reply")}
          onClick={() => onReference("reply")}
        >
          <MessageCircle size={14} aria-hidden="true" />
          <span>Reply</span>
        </button>
        <button
          type="button"
          title={actionLabel("quote")}
          aria-label={actionLabel("quote")}
          onClick={() => onReference("quote")}
        >
          <Quote size={14} aria-hidden="true" />
          <span>Quote</span>
        </button>
        <button
          type="button"
          title={actionLabel("context")}
          aria-label={actionLabel("context")}
          onClick={() => onReference("context")}
        >
          <ListPlus size={14} aria-hidden="true" />
          <span>Context</span>
        </button>
        <button type="button" title="Copy selected text" aria-label="Copy selected text" onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
        <button type="button" title="Dismiss selection actions" aria-label="Dismiss selection actions" onClick={onDismiss}>
          <X size={14} aria-hidden="true" />
        </button>
      </span>
      {announcement ? (
        <span className="selection-reference-toolbar__status" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      ) : null}
    </div>
  );
}

export interface SelectableReferenceContentProps {
  readonly children: ReactNode;
  readonly sourceKind: SelectionSourceKind;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly sourceLabel: string;
  readonly authorLabel?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Wraps rendered content with selection capture. The wrapper owns only
 * renderer state; provider payloads remain blocked until native admission
 * creates an immutable context receipt.
 */
export function SelectableReferenceContent({
  children,
  sourceKind,
  sourceId,
  sourceRevisionId,
  sourceLabel,
  authorLabel,
  disabled = false,
  className,
}: SelectableReferenceContentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [captured, setCaptured] = useState<CapturedTextSelection | null>(null);
  const addReference = useSelectionReferenceStore((state) => state.addReference);
  const setActiveSelection = useSelectionReferenceStore((state) => state.setActiveSelection);

  useEffect(() => {
    if (!captured) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (rootRef.current?.contains(target) || toolbarRef.current?.contains(target))) return;
      setCaptured(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCaptured(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [captured]);

  const capture = () => {
    if (disabled || !rootRef.current) return;
    const next = captureTextSelection({
      root: rootRef.current,
      selection: typeof window === "undefined" ? null : window.getSelection(),
      sourceKind,
      sourceId,
      sourceRevisionId,
    });
    setCaptured(next);
  };

  const attachReference = (mode: SelectionReferenceMode) => {
    if (!captured) return;
    try {
      const reference = createSelectionReferenceDraft({
        anchor: captured.anchor,
        mode,
        sourceLabel,
        ...(authorLabel === undefined ? {} : { authorLabel }),
        intent: actionLabel(mode),
      });
      addReference(reference);
      setActiveSelection(captured.anchor.selectionId);
      setCaptured(null);
      window.getSelection()?.removeAllRanges();
    } catch {
      // The anchor constructor already fails closed for stale/invalid input.
      // No renderer action should turn that into an unsafe reference.
    }
  };

  return (
    <div className="selection-reference-container">
      <div
        ref={rootRef}
        id={selectionReferenceOriginId({ sourceKind, sourceId })}
        data-selection-source-kind={sourceKind}
        data-selection-source-id={sourceId}
        tabIndex={-1}
        className={className ? `selection-reference-root ${className}` : "selection-reference-root"}
        onMouseUp={capture}
      >
        {children}
      </div>
      {captured ? (
        <div ref={toolbarRef}>
          <SelectionReferenceToolbar
            captured={captured}
            sourceLabel={sourceLabel}
            onReference={attachReference}
            onDismiss={() => setCaptured(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

export interface SelectionReferenceTrayProps {
  readonly className?: string;
  /** Optional host hook; returning to the rendered source is the default. */
  readonly onOpenOriginal?: (reference: SelectionReferenceDraft) => void;
}

/**
 * Shows renderer-only references waiting in the next composer request. The
 * tray is deliberately explicit about native binding being pending, so a
 * reference can never disappear silently into an unbound provider payload.
 */
export function SelectionReferenceTray({ className, onOpenOriginal }: SelectionReferenceTrayProps) {
  const references = useSelectionReferenceStore((state) => state.references);
  const removeReference = useSelectionReferenceStore((state) => state.removeReference);
  const clearReferences = useSelectionReferenceStore((state) => state.clearReferences);
  const reorderReference = useSelectionReferenceStore((state) => state.reorderReference);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  if (references.length === 0) return null;

  const openOriginal = (reference: SelectionReferenceDraft) => {
    if (onOpenOriginal) {
      onOpenOriginal(reference);
      setAnnouncement(`Opened original ${reference.sourceLabel} in this preview.`);
      return;
    }
    const focused = focusSelectionReferenceOrigin(reference);
    setAnnouncement(
      focused
        ? `Returned to original ${reference.sourceLabel}.`
        : `Original ${reference.sourceLabel} is not mounted in this preview.`,
    );
  };

  return (
    <section className={className ? `composer-reference-tray ${className}` : "composer-reference-tray"} aria-label="Selected references for the next message">
      <header className="composer-reference-tray__header">
        <span>
          <Quote size={14} aria-hidden="true" />
          <strong>{references.length} selected reference{references.length === 1 ? "" : "s"}</strong>
        </span>
        <span>
          <small>Preview only until native context binding is admitted</small>
          <button
            type="button"
            onClick={() => {
              clearReferences();
              setAnnouncement("Cleared all selected references.");
            }}
            aria-label="Clear selected references"
            title="Clear selected references"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </header>
      <ol className="composer-reference-tray__list">
        {references.map((reference, index) => (
          <li key={reference.id} className="composer-reference-chip">
            <span className="composer-reference-chip__body">
              <strong>{reference.mode}</strong>
              <span title={reference.anchor.exactText}>{formatSelectionReferencePreview(reference)}</span>
            </span>
            <span className="composer-reference-chip__actions">
              <button
                type="button"
                onClick={() => openOriginal(reference)}
                aria-label={`Open original ${reference.sourceLabel}`}
                title="Open original"
              >
                <ExternalLink size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => {
                  reorderReference(reference.id, "up");
                  setAnnouncement(`Moved reference ${index + 1} up.`);
                }}
                aria-label={`Move reference ${index + 1} up`}
                title="Move reference up"
              >
                <ArrowUp size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={index === references.length - 1}
                onClick={() => {
                  reorderReference(reference.id, "down");
                  setAnnouncement(`Moved reference ${index + 1} down.`);
                }}
                aria-label={`Move reference ${index + 1} down`}
                title="Move reference down"
              >
                <ArrowDown size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  removeReference(reference.id);
                  setAnnouncement(`Removed reference ${index + 1}.`);
                }}
                aria-label={`Remove reference ${index + 1}`}
                title="Remove reference"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {announcement ? (
        <p className="composer-reference-tray__status" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      ) : null}
    </section>
  );
}

/** Utility used by tests and future action implementations. */
export function selectionReferencePromptPreview(references: readonly ReturnType<typeof createSelectionReferenceDraft>[]): string {
  return references.map((reference) => formatSelectionReferencePreview(reference)).join("\n\n");
}
