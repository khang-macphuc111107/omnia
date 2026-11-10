/**
 * Small, deterministic helpers for the renderer-local Draft Studio timeline.
 *
 * These helpers intentionally compare text only. They do not create a native
 * revision, hash an artifact, or imply that a provider saw either version.
 */

export interface ComposerDraftLinePreview {
  readonly kind: "same" | "added" | "removed";
  readonly lineNumber: number;
  readonly text: string;
}

export interface ComposerDraftVersionStats {
  readonly characters: number;
  readonly lines: number;
  readonly words: number;
}

export interface ComposerDraftVersionComparison {
  readonly changed: boolean;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly characterDelta: number;
  readonly estimatedTokenDelta: number;
  readonly preview: readonly ComposerDraftLinePreview[];
  readonly truncated: boolean;
  readonly tooLarge: boolean;
}

export function summarizeComposerDraftVersion(content: string): ComposerDraftVersionStats {
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const words = content.trim() ? content.trim().split(/\s+/u).length : 0;
  return {
    characters: content.length,
    lines,
    words,
  };
}

/**
 * Produces an intentionally bounded LCS line comparison. The matrix has a
 * strict cell cap so comparing two very large drafts cannot monopolize the
 * renderer; that case returns character statistics without pretending its
 * line counts are exact.
 */
export function compareComposerDraftVersions(
  base: string,
  candidate: string,
  maxPreviewLines = 12,
): ComposerDraftVersionComparison {
  const baseLines = base.length === 0 ? [] : base.split(/\r?\n/);
  const candidateLines = candidate.length === 0 ? [] : candidate.split(/\r?\n/);
  const matrixCells = (baseLines.length + 1) * (candidateLines.length + 1);
  if (matrixCells > 90_000) {
    return {
      changed: base !== candidate,
      addedLines: 0,
      removedLines: 0,
      characterDelta: candidate.length - base.length,
      estimatedTokenDelta: Math.ceil((candidate.length - base.length) / 4),
      preview: [],
      truncated: false,
      tooLarge: true,
    };
  }

  const columns = candidateLines.length + 1;
  const lcs = new Uint32Array(matrixCells);
  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let candidateIndex = candidateLines.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const cell = baseIndex * columns + candidateIndex;
      lcs[cell] = baseLines[baseIndex] === candidateLines[candidateIndex]
      ? lcs[(baseIndex + 1) * columns + candidateIndex + 1]! + 1
        : Math.max(lcs[(baseIndex + 1) * columns + candidateIndex]!, lcs[cell + 1]!);
    }
  }

  let addedLines = 0;
  let removedLines = 0;
  const preview: ComposerDraftLinePreview[] = [];
  let baseIndex = 0;
  let candidateIndex = 0;
  let lineNumber = 1;
  let truncated = false;
  while (baseIndex < baseLines.length || candidateIndex < candidateLines.length) {
    if (baseIndex < baseLines.length && candidateIndex < candidateLines.length && baseLines[baseIndex] === candidateLines[candidateIndex]) {
      if (preview.length < maxPreviewLines) preview.push({ kind: "same", lineNumber, text: baseLines[baseIndex]! });
      else truncated = true;
      baseIndex += 1;
      candidateIndex += 1;
      lineNumber += 1;
      continue;
    }

    const baseCanBeRemoved = baseIndex < baseLines.length;
    const candidateCanBeAdded = candidateIndex < candidateLines.length;
    const preferAdd = candidateCanBeAdded && (
      !baseCanBeRemoved
      || lcs[baseIndex * columns + candidateIndex + 1]! >= lcs[(baseIndex + 1) * columns + candidateIndex]!
    );
    if (preferAdd) {
      addedLines += 1;
      if (preview.length < maxPreviewLines) preview.push({ kind: "added", lineNumber, text: candidateLines[candidateIndex]! });
      else truncated = true;
      candidateIndex += 1;
      lineNumber += 1;
      continue;
    }
    removedLines += 1;
    if (preview.length < maxPreviewLines) preview.push({ kind: "removed", lineNumber, text: baseLines[baseIndex]! });
    else truncated = true;
    baseIndex += 1;
  }

  return {
    changed: addedLines > 0 || removedLines > 0 || base !== candidate,
    addedLines,
    removedLines,
    characterDelta: candidate.length - base.length,
    estimatedTokenDelta: Math.round((candidate.length - base.length) / 4),
    preview,
    truncated,
    tooLarge: false,
  };
}
