export type ComposerEditorDirection = "indent" | "outdent";

export type ComposerEditorChange = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  handled: boolean;
};

export type ComposerInlineMarker = "**" | "*" | "~~" | "`";

export type ComposerListStyle = "bullet" | "numbered" | "lettered" | "checklist";

export type ComposerHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Returns whether the current selection is already wrapped in a Markdown
 * inline marker. This is intentionally a small source-level check: the
 * composer still stores plain Markdown text and does not create rich-text
 * nodes in the renderer.
 */
export function isMarkdownInlineActive(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: ComposerInlineMarker,
): boolean {
  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  if (start === end) return false;

  const selected = value.slice(start, end);
  const singleMarkerIsPartOfStrong = marker === "*"
    && (
      (selected.startsWith("**") && selected.endsWith("**"))
      || (start >= 2 && value.slice(start - 2, start) === "**")
      || value.slice(end, end + 2) === "**"
    );
  if (singleMarkerIsPartOfStrong) return false;

  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    return true;
  }

  return (
    start >= marker.length
    && value.slice(start - marker.length, start) === marker
    && value.slice(end, end + marker.length) === marker
  );
}

type ParsedListLine = {
  quotePrefix: string;
  indent: string;
  continuation: string;
  content: string;
};

const DEFAULT_INDENT = "  ";

function clampPosition(value: string, position: number): number {
  return Math.max(0, Math.min(value.length, position));
}

function lineStartAt(value: string, position: number): number {
  return value.lastIndexOf("\n", Math.max(0, position) - 1) + 1;
}

function lineEndAt(value: string, position: number): number {
  const end = value.indexOf("\n", position);
  return end === -1 ? value.length : end;
}

function isInsideFencedCode(value: string, lineStart: number): boolean {
  let fenceCharacter: "`" | "~" | null = null;
  let fenceLength = 0;

  for (const line of value.slice(0, lineStart).split("\n")) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!fence) continue;

    const fenceToken = fence[1]!;
    const character = fenceToken[0] as "`" | "~";
    if (fenceCharacter === null) {
      fenceCharacter = character;
      fenceLength = fenceToken.length;
      continue;
    }

    if (character === fenceCharacter && fenceToken.length >= fenceLength) {
      fenceCharacter = null;
      fenceLength = 0;
    }
  }

  return fenceCharacter !== null;
}

function parseListLine(line: string): ParsedListLine | null {
  const task = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)([-+*])([ \t]+)\[([ xX])\]([ \t]*)(.*)$/);
  if (task && (task[6]!.length > 0 || task[7]!.length === 0)) {
    return {
      quotePrefix: task[1]!,
      indent: task[2]!,
      continuation: `${task[3]!}${task[4]!}[ ]${task[6]!}`,
      content: task[7]!,
    };
  }

  const unordered = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)([-+*])([ \t]+)(.*)$/);
  if (unordered) {
    return {
      quotePrefix: unordered[1]!,
      indent: unordered[2]!,
      continuation: `${unordered[3]!}${unordered[4]!}`,
      content: unordered[5]!,
    };
  }

  // Alphabetic list markers may be multi-letter (for example `AA.` after
  // `Z.`). Keeping the full marker lets continuation work past the first
  // alphabet rather than treating `AA.` as ordinary paragraph text.
  const ordered = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)(\d+|[A-Za-z]+)([.)])([ \t]+)(.*)$/);
  if (ordered) {
    const numberToken = ordered[3]!;
    const nextNumber = /^\d+$/.test(numberToken)
      ? String(Number.parseInt(numberToken, 10) + 1).padStart(numberToken.length, "0")
      : nextAlphabeticMarker(numberToken);
    return {
      quotePrefix: ordered[1]!,
      indent: ordered[2]!,
      continuation: `${nextNumber}${ordered[4]!}${ordered[5]!}`,
      content: ordered[6]!,
    };
  }

  return null;
}

function nextAlphabeticMarker(marker: string): string {
  const uppercase = marker === marker.toUpperCase();
  const alphabet = marker.toLowerCase();
  let carry = 1;
  let result = "";
  for (let index = alphabet.length - 1; index >= 0; index -= 1) {
    const code = alphabet.charCodeAt(index) - 97 + carry;
    carry = code >= 26 ? 1 : 0;
    result = String.fromCharCode(97 + (code % 26)) + result;
  }
  if (carry > 0) result = "a" + result;
  return uppercase ? result.toUpperCase() : result;
}

function unchanged(value: string, selectionStart: number, selectionEnd: number): ComposerEditorChange {
  return { value, selectionStart, selectionEnd, handled: false };
}

type ParsedMarkdownListPrefix = {
  linePrefix: string;
  marker: string;
  content: string;
  style: ComposerListStyle | null;
};

type ParsedMarkdownHeadingPrefix = {
  linePrefix: string;
  marker: string;
  content: string;
  level: ComposerHeadingLevel | null;
};

/**
 * Parses only the line prefix needed by the formatting toolbar. The source
 * remains plain Markdown; this is deliberately not a full Markdown parser.
 */
function parseMarkdownListPrefix(line: string): ParsedMarkdownListPrefix {
  const task = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)([-+*])([ \t]+)\[([ xX])\]([ \t]*)(.*)$/);
  if (task) {
    return {
      linePrefix: `${task[1]!}${task[2]!}`,
      marker: `${task[3]!}${task[4]!}[${task[5]!.toLowerCase()}]${task[6]!}`,
      content: task[7]!,
      style: "checklist",
    };
  }

  const unordered = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)([-+*])([ \t]+)(.*)$/);
  if (unordered) {
    return {
      linePrefix: `${unordered[1]!}${unordered[2]!}`,
      marker: `${unordered[3]!}${unordered[4]!}`,
      content: unordered[5]!,
      style: "bullet",
    };
  }

  const ordered = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)(\d+|[A-Za-z]+)([.)])([ \t]+)(.*)$/);
  if (ordered) {
    const token = ordered[3]!;
    return {
      linePrefix: `${ordered[1]!}${ordered[2]!}`,
      marker: `${token}${ordered[4]!}${ordered[5]!}`,
      content: ordered[6]!,
      style: /^\d+$/.test(token) ? "numbered" : "lettered",
    };
  }

  const plain = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)(.*)$/);
  return {
    linePrefix: `${plain?.[1] ?? ""}${plain?.[2] ?? ""}`,
    marker: "",
    content: plain?.[3] ?? line,
    style: null,
  };
}

function composerListMarker(style: ComposerListStyle): string {
  if (style === "checklist") return "- [ ] ";
  if (style === "numbered") return "1. ";
  if (style === "lettered") return "a. ";
  return "- ";
}

function parseMarkdownHeadingPrefix(line: string): ParsedMarkdownHeadingPrefix {
  const heading = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)(#{1,6})([ \t]+|$)(.*)$/);
  if (heading) {
    const level = heading[3]!.length as ComposerHeadingLevel;
    return {
      linePrefix: `${heading[1]!}${heading[2]!}`,
      marker: `${heading[3]!}${heading[4]!}`,
      content: heading[5]!,
      level,
    };
  }

  const plain = line.match(/^((?: {0,3}>[ \t]*)*)([ \t]*)(.*)$/);
  return {
    linePrefix: `${plain?.[1] ?? ""}${plain?.[2] ?? ""}`,
    marker: "",
    content: plain?.[3] ?? line,
    level: null,
  };
}

/**
 * Applies or removes a Markdown ATX heading marker across all selected lines.
 * This keeps the source editor authoritative and remaps the selection so the
 * formatted block remains selected after React updates the controlled input.
 */
export function toggleMarkdownHeading(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  level: ComposerHeadingLevel,
): ComposerEditorChange {
  const selected = selectedLines(value, selectionStart, selectionEnd);
  const meaningful = selected.lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return unchanged(value, selectionStart, selectionEnd);

  const parsedLines = selected.lines.map(parseMarkdownHeadingPrefix);
  const canRemove = meaningful.every((line) => parseMarkdownHeadingPrefix(line).level === level);
  const edits: PrefixEdit[] = [];
  let originalOffset = selected.start;
  const marker = `${"#".repeat(level)} `;
  const transformedLines = parsedLines.map((parsed, index) => {
    const line = selected.lines[index]!;
    if (line.trim().length === 0) {
      originalOffset += line.length + 1;
      return line;
    }

    if (canRemove) {
      if (parsed.marker.length > 0) {
        edits.push({
          position: originalOffset + parsed.linePrefix.length,
          removed: parsed.marker.length,
          inserted: "",
        });
      }
      originalOffset += line.length + 1;
      return `${parsed.linePrefix}${parsed.content}`;
    }

    edits.push({
      position: originalOffset + parsed.linePrefix.length,
      removed: parsed.marker.length,
      inserted: marker,
    });
    originalOffset += line.length + 1;
    return `${parsed.linePrefix}${marker}${parsed.content}`;
  });

  const transformedBlock = transformedLines.join("\n");
  const nextValue = `${value.slice(0, selected.start)}${transformedBlock}${value.slice(selected.end)}`;
  return {
    value: nextValue,
    selectionStart: mapPosition(selectionStart, edits),
    selectionEnd: mapPosition(selectionEnd, edits),
    handled: nextValue !== value,
  };
}

/**
 * Inserts a Markdown link and selects the URL placeholder for immediate
 * replacement. The label remains source text, so this is still undoable draft
 * editing rather than a rich-text mutation.
 */
export function insertMarkdownLink(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  fallback = "link text",
): ComposerEditorChange {
  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  const label = value.slice(start, end) || fallback;
  const url = "https://";
  const insertion = `[${label}](${url})`;
  const nextValue = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  const urlStart = start + label.length + 3;
  return {
    value: nextValue,
    selectionStart: urlStart,
    selectionEnd: urlStart + url.length,
    handled: nextValue !== value,
  };
}

function selectedLines(value: string, selectionStart: number, selectionEnd: number): {
  start: number;
  end: number;
  lines: string[];
} {
  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  const firstLineStart = lineStartAt(value, start);
  const lastSelectedPosition = end > start ? end - 1 : end;
  const blockEnd = lineEndAt(value, lastSelectedPosition);
  return {
    start: firstLineStart,
    end: blockEnd,
    lines: value.slice(firstLineStart, blockEnd).split("\n"),
  };
}

/**
 * Reports whether all non-empty lines touched by the selection use one list
 * style. This powers `aria-pressed` without pretending the textarea is a rich
 * text document.
 */
export function isMarkdownListActive(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  style: ComposerListStyle,
): boolean {
  const { lines } = selectedLines(value, selectionStart, selectionEnd);
  const meaningful = lines.filter((line) => line.trim().length > 0);
  return meaningful.length > 0 && meaningful.every((line) => parseMarkdownListPrefix(line).style === style);
}

/**
 * Reports whether every non-empty line touched by the current selection has
 * the supplied line prefix. This is intentionally source-level state for the
 * toolbar (not a rich-text document query), and keeps the blockquote button
 * in sync with the same toggle operation used to apply/remove the prefix.
 */
export function isMarkdownLinePrefixActive(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
): boolean {
  if (!prefix) return false;
  const { lines } = selectedLines(value, selectionStart, selectionEnd);
  const meaningful = lines.filter((line) => line.trim().length > 0);
  return meaningful.length > 0 && meaningful.every((line) => line.startsWith(prefix));
}

/**
 * Applies or removes a Markdown list marker across every line touched by the
 * selection. Existing bullet/numbered/task markers are replaced instead of
 * being nested accidentally, and selection endpoints are remapped after the
 * edit so toolbar clicks remain predictable.
 */
export function toggleMarkdownListPrefix(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  style: ComposerListStyle,
): ComposerEditorChange {
  const selected = selectedLines(value, selectionStart, selectionEnd);
  const target = composerListMarker(style);
  const meaningful = selected.lines.filter((line) => line.trim().length > 0);
  if (meaningful.length === 0) return unchanged(value, selectionStart, selectionEnd);

  const canRemove = meaningful.every((line) => parseMarkdownListPrefix(line).style === style);
  const edits: PrefixEdit[] = [];
  let originalOffset = selected.start;
  const transformedLines = selected.lines.map((line) => {
    const parsed = parseMarkdownListPrefix(line);
    const isBlank = line.trim().length === 0;
    if (isBlank) {
      originalOffset += line.length + 1;
      return line;
    }

    if (canRemove) {
      edits.push({ position: originalOffset + parsed.linePrefix.length, removed: parsed.marker.length, inserted: "" });
      originalOffset += line.length + 1;
      return `${parsed.linePrefix}${parsed.content}`;
    }

    edits.push({
      position: originalOffset + parsed.linePrefix.length,
      removed: parsed.marker.length,
      inserted: target,
    });
    originalOffset += line.length + 1;
    return `${parsed.linePrefix}${target}${parsed.content}`;
  });

  const transformedBlock = transformedLines.join("\n");
  const nextValue = `${value.slice(0, selected.start)}${transformedBlock}${value.slice(selected.end)}`;
  return {
    value: nextValue,
    selectionStart: mapPosition(selectionStart, edits),
    selectionEnd: mapPosition(selectionEnd, edits),
    handled: nextValue !== value,
  };
}

/**
 * Wraps the current selection in a Markdown inline marker and toggles the
 * marker off when it already surrounds the selection. This is intentionally
 * text-only: the renderer does not parse or persist rich-text nodes.
 */
export function toggleMarkdownInline(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: ComposerInlineMarker,
  fallback = "text",
): ComposerEditorChange {
  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  const selected = value.slice(start, end);

  // Prefer unwrapping markers immediately adjacent to the selection. This
  // makes a second click on Bold/Italic/Code/Strike predictable even when the
  // user selected only the text inside the markers.
  if (
    start >= marker.length &&
    value.slice(start - marker.length, start) === marker &&
    value.slice(end, end + marker.length) === marker
  ) {
    const nextValue = `${value.slice(0, start - marker.length)}${selected}${value.slice(end + marker.length)}`;
    return {
      value: nextValue,
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
      handled: nextValue !== value,
    };
  }

  // If the selection includes its own markers, remove those too. This covers
  // keyboard selection and pasted Markdown without requiring exact cursor
  // placement around the delimiters.
  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const unwrapped = selected.slice(marker.length, -marker.length);
    const nextValue = `${value.slice(0, start)}${unwrapped}${value.slice(end)}`;
    return {
      value: nextValue,
      selectionStart: start,
      selectionEnd: start + unwrapped.length,
      handled: nextValue !== value,
    };
  }

  const body = selected || fallback;
  const insertion = `${marker}${body}${marker}`;
  const nextValue = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  return {
    value: nextValue,
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + body.length,
    handled: nextValue !== value,
  };
}

/**
 * Adds or removes a line prefix (for example `> ` for a blockquote) across
 * every Markdown line touched by the selection. The operation is undoable via
 * the composer draft history and remaps the selection after the edit.
 */
export function toggleMarkdownLinePrefix(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  prefix: string,
): ComposerEditorChange {
  if (!prefix) return unchanged(value, selectionStart, selectionEnd);

  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  const firstLineStart = lineStartAt(value, start);
  const lastSelectedPosition = end > start ? end - 1 : end;
  const blockEnd = lineEndAt(value, lastSelectedPosition);
  const block = value.slice(firstLineStart, blockEnd);
  const lines = block.split("\n");
  const prefixPattern = prefix === "> " ? /^( {0,3}>[ \t]?)/ : null;
  const canRemove = Boolean(prefixPattern) && lines.every((line) => !line.trim() || prefixPattern!.test(line));
  const edits: PrefixEdit[] = [];
  let originalOffset = firstLineStart;

  const transformedLines = lines.map((line) => {
    if (canRemove && prefixPattern) {
      const match = line.match(prefixPattern);
      const removed = match?.[1]?.length ?? 0;
      if (removed > 0) edits.push({ position: originalOffset, removed, inserted: "" });
      originalOffset += line.length + 1;
      return line.slice(removed);
    }

    edits.push({ position: originalOffset, removed: 0, inserted: prefix });
    originalOffset += line.length + 1;
    return `${prefix}${line}`;
  });

  const transformedBlock = transformedLines.join("\n");
  const nextValue = `${value.slice(0, firstLineStart)}${transformedBlock}${value.slice(blockEnd)}`;
  return {
    value: nextValue,
    selectionStart: mapPosition(start, edits),
    selectionEnd: mapPosition(end, edits),
    handled: nextValue !== value,
  };
}

/**
 * Continues the Markdown list at a collapsed caret. The caller can keep its
 * normal Enter-to-submit behavior when `handled` is false.
 */
export function continueMarkdownListAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerEditorChange {
  const start = clampPosition(value, selectionStart);
  const end = clampPosition(value, selectionEnd);
  if (start !== end) return unchanged(value, start, end);

  const currentLineStart = lineStartAt(value, start);
  if (isInsideFencedCode(value, currentLineStart)) return unchanged(value, start, end);

  const currentLineEnd = lineEndAt(value, currentLineStart);
  const currentLine = value.slice(currentLineStart, currentLineEnd);
  const parsed = parseListLine(currentLine);
  if (!parsed) return unchanged(value, start, end);

  const markerLength = parsed.quotePrefix.length + parsed.indent.length + parsed.continuation.length;
  if (start - currentLineStart < markerLength) return unchanged(value, start, end);

  if (parsed.content.trim().length === 0) {
    // Pressing Enter on an empty marker exits the list. Keep a blockquote
    // prefix, if present, but remove indentation and the list marker itself.
    const replacement = parsed.quotePrefix;
    const nextValue = `${value.slice(0, currentLineStart)}${replacement}${value.slice(currentLineEnd)}`;
    const nextCursor = currentLineStart + replacement.length;
    return {
      value: nextValue,
      selectionStart: nextCursor,
      selectionEnd: nextCursor,
      handled: nextValue !== value,
    };
  }

  const continuation = `${parsed.quotePrefix}${parsed.indent}${parsed.continuation}`;
  const nextValue = `${value.slice(0, start)}\n${continuation}${value.slice(start)}`;
  const nextCursor = start + 1 + continuation.length;
  return {
    value: nextValue,
    selectionStart: nextCursor,
    selectionEnd: nextCursor,
    handled: true,
  };
}

/**
 * Inserts a newline instead of allowing the composer to submit while the
 * caret is inside a fenced code block. Leading whitespace on the current line
 * is carried onto the new line so code drafting feels like an editor while
 * the source remains plain Markdown.
 */
export function continueMarkdownCodeBlockAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerEditorChange {
  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  const currentLineStart = lineStartAt(value, start);
  if (!isInsideFencedCode(value, currentLineStart)) return unchanged(value, start, end);

  const beforeSelection = value.slice(currentLineStart, start);
  const indentation = beforeSelection.match(/^[\t ]*/)?.[0] ?? "";
  const nextValue = `${value.slice(0, start)}\n${indentation}${value.slice(end)}`;
  const nextCursor = start + 1 + indentation.length;
  return {
    value: nextValue,
    selectionStart: nextCursor,
    selectionEnd: nextCursor,
    handled: true,
  };
}

type PrefixEdit = {
  position: number;
  removed: number;
  inserted: string;
};

function mapPosition(position: number, edits: PrefixEdit[]): number {
  let delta = 0;

  for (const edit of edits) {
    if (position < edit.position) break;

    if (position <= edit.position + edit.removed) {
      return edit.position + delta + edit.inserted.length;
    }

    delta += edit.inserted.length - edit.removed;
  }

  return position + delta;
}

/**
 * Indents or outdents every Markdown line touched by the current selection.
 * Selection endpoints are remapped so the editor can restore the same block
 * after React updates the controlled textarea.
 */
export function indentMarkdownSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: ComposerEditorDirection,
): ComposerEditorChange {
  const start = clampPosition(value, Math.min(selectionStart, selectionEnd));
  const end = clampPosition(value, Math.max(selectionStart, selectionEnd));
  const firstLineStart = lineStartAt(value, start);
  const lastSelectedPosition = end > start ? end - 1 : end;
  const blockEnd = lineEndAt(value, lastSelectedPosition);
  const block = value.slice(firstLineStart, blockEnd);
  const lines = block.split("\n");
  const edits: PrefixEdit[] = [];

  let originalOffset = firstLineStart;
  const transformedLines = lines.map((line) => {
    if (direction === "indent") {
      edits.push({ position: originalOffset, removed: 0, inserted: DEFAULT_INDENT });
      originalOffset += line.length + 1;
      return `${DEFAULT_INDENT}${line}`;
    }

    const removable = line.startsWith("\t") ? 1 : Math.min(DEFAULT_INDENT.length, line.match(/^ */)?.[0].length ?? 0);
    if (removable > 0) {
      edits.push({ position: originalOffset, removed: removable, inserted: "" });
    }
    originalOffset += line.length + 1;
    return line.slice(removable);
  });

  const transformedBlock = transformedLines.join("\n");
  const nextValue = `${value.slice(0, firstLineStart)}${transformedBlock}${value.slice(blockEnd)}`;
  const nextSelectionStart = mapPosition(start, edits);
  const nextSelectionEnd = mapPosition(end, edits);

  return {
    value: nextValue,
    selectionStart: nextSelectionStart,
    selectionEnd: nextSelectionEnd,
    handled: nextValue !== value,
  };
}
