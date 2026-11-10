/**
 * Renderer-owned selection reference primitives.
 *
 * These values are intentionally draft-only. Native persistence, provider
 * input freezing and revision graph admission must consume an immutable
 * native receipt before a reference can be described as dispatchable.
 */

export type SelectionSourceKind =
  | "assistant-message"
  | "user-message"
  | "source"
  | "artifact"
  | "tool"
  | "terminal"
  | "unknown";

export type SelectionReferenceMode = "quote" | "reply" | "context";

export type SelectionStaleReason =
  | "source-changed"
  | "ambiguous-reanchor"
  | "missing-source"
  | "invalid";

export interface TextSelectionAnchor {
  readonly schemaVersion: 1;
  readonly selectionId: string;
  readonly sourceKind: SelectionSourceKind;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly exactText: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly surroundingText: string;
  readonly surroundingHash: string;
  readonly semanticFingerprint: string;
  readonly stale: boolean;
  readonly staleReason?: SelectionStaleReason;
  readonly capturedAt: string;
}

export interface SelectionReferenceDraft {
  readonly id: string;
  readonly anchor: TextSelectionAnchor;
  readonly mode: SelectionReferenceMode;
  readonly sourceLabel: string;
  readonly authorLabel?: string;
  readonly intent?: string;
  readonly createdAt: string;
}

export interface CreateTextSelectionAnchorInput {
  readonly selectionId: string;
  readonly sourceKind: SelectionSourceKind;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly sourceText: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly capturedAt?: string;
}

const SURROUNDING_RADIUS = 48;

function assertNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be blank.`);
  return value;
}

function assertRange(input: Pick<CreateTextSelectionAnchorInput, "sourceText" | "startOffset" | "endOffset">): void {
  if (!Number.isSafeInteger(input.startOffset) || !Number.isSafeInteger(input.endOffset)) {
    throw new Error("Selection offsets must be safe integers.");
  }
  if (input.startOffset < 0 || input.endOffset <= input.startOffset) {
    throw new Error("Selection range must contain at least one character.");
  }
  if (input.endOffset > input.sourceText.length) {
    throw new Error("Selection range exceeds the source text.");
  }
}

/** A stable, non-cryptographic fingerprint for renderer-side anchor matching. */
export function stableTextHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function surroundingFor(sourceText: string, startOffset: number, endOffset: number): string {
  const start = Math.max(0, startOffset - SURROUNDING_RADIUS);
  const end = Math.min(sourceText.length, endOffset + SURROUNDING_RADIUS);
  return sourceText.slice(start, end);
}

function semanticFingerprintFor(sourceText: string, startOffset: number, endOffset: number): string {
  const selected = sourceText.slice(startOffset, endOffset).replace(/\s+/g, " ").trim();
  return stableTextHash(selected.toLocaleLowerCase());
}

/**
 * Creates an exact text anchor. The source slice is checked before the object
 * is created so a DOM selection can never silently point at another span.
 */
export function createTextSelectionAnchor(input: CreateTextSelectionAnchorInput): TextSelectionAnchor {
  assertNonBlank(input.selectionId, "Selection ID");
  assertNonBlank(input.sourceId, "Source ID");
  assertNonBlank(input.sourceRevisionId, "Source revision ID");
  assertRange(input);

  const exactText = input.sourceText.slice(input.startOffset, input.endOffset);
  if (!exactText) throw new Error("Selection text must not be empty.");

  return Object.freeze({
    schemaVersion: 1 as const,
    selectionId: input.selectionId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceRevisionId: input.sourceRevisionId,
    exactText,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    surroundingText: surroundingFor(input.sourceText, input.startOffset, input.endOffset),
    surroundingHash: stableTextHash(surroundingFor(input.sourceText, input.startOffset, input.endOffset)),
    semanticFingerprint: semanticFingerprintFor(input.sourceText, input.startOffset, input.endOffset),
    stale: false,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  });
}

function findOccurrences(sourceText: string, needle: string): number[] {
  const occurrences: number[] = [];
  let cursor = 0;
  while (cursor <= sourceText.length - needle.length) {
    const index = sourceText.indexOf(needle, cursor);
    if (index < 0) break;
    occurrences.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return occurrences;
}

function reanchored(
  anchor: TextSelectionAnchor,
  sourceText: string,
  sourceRevisionId: string,
  startOffset: number,
): TextSelectionAnchor {
  const endOffset = startOffset + anchor.exactText.length;
  const surroundingText = surroundingFor(sourceText, startOffset, endOffset);
  // Omit a previous staleReason instead of assigning `undefined`; this keeps
  // exactOptionalPropertyTypes semantics intact while clearing stale state.
  const { staleReason: _previousStaleReason, ...anchorWithoutStaleReason } = anchor;
  return Object.freeze({
    ...anchorWithoutStaleReason,
    sourceRevisionId,
    startOffset,
    endOffset,
    surroundingText,
    surroundingHash: stableTextHash(surroundingText),
    semanticFingerprint: semanticFingerprintFor(sourceText, startOffset, endOffset),
    stale: false,
  });
}

function staleAnchor(
  anchor: TextSelectionAnchor,
  sourceRevisionId: string,
  reason: SelectionStaleReason,
): TextSelectionAnchor {
  return Object.freeze({
    ...anchor,
    sourceRevisionId,
    stale: true,
    staleReason: reason,
  });
}

/**
 * Re-anchors against a newer immutable source revision.
 *
 * Exact text is preferred. If it appears more than once, the old surrounding
 * fingerprint may disambiguate one candidate. Otherwise the reference is
 * marked stale and must be relinked by the user; nearby text is never guessed.
 */
export function reanchorTextSelection(
  anchor: TextSelectionAnchor,
  sourceText: string | null | undefined,
  sourceRevisionId: string,
): TextSelectionAnchor {
  if (!sourceText) return staleAnchor(anchor, sourceRevisionId, "missing-source");
  const occurrences = findOccurrences(sourceText, anchor.exactText);
  if (occurrences.length === 1) {
    const [onlyOccurrence] = occurrences;
    if (onlyOccurrence !== undefined) {
      return reanchored(anchor, sourceText, sourceRevisionId, onlyOccurrence);
    }
  }
  if (occurrences.length === 0) return staleAnchor(anchor, sourceRevisionId, "source-changed");

  const matchingContext = occurrences.filter((startOffset) => {
    const endOffset = startOffset + anchor.exactText.length;
    const surroundingText = surroundingFor(sourceText, startOffset, endOffset);
    return stableTextHash(surroundingText) === anchor.surroundingHash;
  });
  if (matchingContext.length === 1) {
    const [matchingOccurrence] = matchingContext;
    if (matchingOccurrence !== undefined) {
      return reanchored(anchor, sourceText, sourceRevisionId, matchingOccurrence);
    }
  }
  return staleAnchor(anchor, sourceRevisionId, "ambiguous-reanchor");
}

export function isUsableSelectionAnchor(anchor: TextSelectionAnchor): boolean {
  return !anchor.stale && anchor.exactText.trim().length > 0 && anchor.endOffset > anchor.startOffset;
}

export function selectionReferenceId(anchor: TextSelectionAnchor, mode: SelectionReferenceMode): string {
  return `reference_${stableTextHash(`${anchor.selectionId}:${anchor.sourceRevisionId}:${anchor.startOffset}:${anchor.endOffset}:${mode}`)}`;
}

/** Stable DOM target used to return from a composer reference to its source. */
export function selectionReferenceOriginId(
  source: Pick<TextSelectionAnchor, "sourceKind" | "sourceId">,
): string {
  return `selection-origin_${stableTextHash(`${source.sourceKind}:${source.sourceId}`)}`;
}

export function createSelectionReferenceDraft(input: {
  readonly anchor: TextSelectionAnchor;
  readonly mode: SelectionReferenceMode;
  readonly sourceLabel: string;
  readonly authorLabel?: string;
  readonly intent?: string;
  readonly createdAt?: string;
}): SelectionReferenceDraft {
  assertNonBlank(input.sourceLabel, "Selection source label");
  if (!isUsableSelectionAnchor(input.anchor)) {
    throw new Error("A stale or empty selection cannot be attached as a reference.");
  }
  return Object.freeze({
    id: selectionReferenceId(input.anchor, input.mode),
    anchor: input.anchor,
    mode: input.mode,
    sourceLabel: input.sourceLabel,
    ...(input.authorLabel === undefined ? {} : { authorLabel: input.authorLabel }),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

/**
 * Human-readable draft snippet used by a future native context compiler.
 * This is not a provider payload and must not be used as dispatch authority.
 */
export function formatSelectionReferencePreview(reference: SelectionReferenceDraft): string {
  const quote = reference.anchor.exactText.replace(/\n/g, "\n> ");
  const author = reference.authorLabel ? ` · ${reference.authorLabel}` : "";
  return `> ${quote}\n\n— ${reference.sourceLabel}${author}`;
}
