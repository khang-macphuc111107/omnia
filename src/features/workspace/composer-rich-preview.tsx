import {
  Bold,
  Braces,
  CheckSquare2,
  Code2,
  ChevronDown,
  ChevronRight,
  Edit3,
  FileText,
  FunctionSquare,
  Heading2,
  Italic,
  Link2,
  List,
  ListTree,
  Quote,
  RotateCcw,
  Save,
  Sparkles,
  Strikethrough,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useMemo, useState } from "react";

// Keep the Markdown/GFM parser outside the eager chat/composer bundle. The
// composer preview is available immediately, while the heavier renderer is
// fetched only when the user opens the Rendered tab.
const LazyMessageMarkdown = lazy(async () => {
  const module = await import("./markdown");
  return { default: module.MessageMarkdown };
});

function MarkdownLoadingState({ content }: { content: string }) {
  // Keep the loading state useful for the first paint. The real Markdown
  // renderer is lazy-loaded, but inline math should still be visibly
  // discoverable instead of appearing as an opaque raw source string while
  // the module is in flight.
  return (
    <div className="message-markdown message-markdown--loading">
      {splitInlineMath(content).map((segment, index) =>
        segment.kind === "math" ? (
          <span
            key={`loading-math-${index}`}
            className="message-markdown__inline-math"
            title={`Inline LaTeX approximation: ${segment.source}`}
          >
            {segment.value}
          </span>
        ) : (
          <span key={`loading-text-${index}`}>{segment.value}</span>
        ),
      )}
    </div>
  );
}

export type ComposerPreviewMode = "rendered" | "wysiwym" | "outline" | "blocks" | "format" | "source";

export type ComposerPreviewBlockKind =
  | "heading"
  | "code"
  | "math"
  | "task-list"
  | "list"
  | "table"
  | "quote"
  | "divider"
  | "paragraph";

export type ComposerPreviewBlock = {
  kind: ComposerPreviewBlockKind;
  source: string;
  detail?: string;
  title?: string;
};

export type ComposerPreviewAnalysis = {
  blocks: ComposerPreviewBlock[];
  chars: number;
  lines: number;
  words: number;
  inlineMathCount: number;
  warnings: readonly string[];
};

export type ComposerInlineMathSegment =
  | { kind: "text"; value: string }
  | { kind: "math"; value: string; source: string };

export type ComposerFormatTokenKind = "bold" | "italic" | "strike" | "inline-code" | "link";

export type ComposerFormatToken = {
  kind: ComposerFormatTokenKind;
  source: string;
  line: number;
  blockIndex: number;
  detail?: string;
};

export type ComposerFormatCounts = {
  bold: number;
  italic: number;
  strike: number;
  inlineCode: number;
  links: number;
  headings: number;
  lists: number;
  taskLists: number;
  quotes: number;
  tables: number;
  codeBlocks: number;
  mathBlocks: number;
};

export type ComposerFormatAnalysis = {
  counts: ComposerFormatCounts;
  tokens: readonly ComposerFormatToken[];
  warnings: readonly string[];
  inspectedBlocks: number;
  omittedTokens: number;
};

const MAX_FORMAT_BLOCKS = 400;
const MAX_FORMAT_TOKENS = 96;

const EMPTY_FORMAT_COUNTS: ComposerFormatCounts = {
  bold: 0,
  italic: 0,
  strike: 0,
  inlineCode: 0,
  links: 0,
  headings: 0,
  lists: 0,
  taskLists: 0,
  quotes: 0,
  tables: 0,
  codeBlocks: 0,
  mathBlocks: 0,
};

type FormatRange = { start: number; end: number };

function maskRanges(value: string, ranges: readonly FormatRange[]): string {
  if (!ranges.length) return value;
  const characters = [...value];
  for (const range of ranges) {
    for (let index = Math.max(0, range.start); index < Math.min(characters.length, range.end); index += 1) {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function addFormatToken(
  tokens: ComposerFormatToken[],
  counts: ComposerFormatCounts,
  token: ComposerFormatToken,
): void {
  if (token.kind === "bold") counts.bold += 1;
  if (token.kind === "italic") counts.italic += 1;
  if (token.kind === "strike") counts.strike += 1;
  if (token.kind === "inline-code") counts.inlineCode += 1;
  if (token.kind === "link") counts.links += 1;
  tokens.push(token);
}

function formatLineTokens(
  line: string,
  lineNumber: number,
  blockIndex: number,
  counts: ComposerFormatCounts,
  tokens: ComposerFormatToken[],
): { malformedLink: boolean; unmatched: ComposerFormatTokenKind[] } {
  const codeRanges: FormatRange[] = [];
  const codePattern = /(`{1,3})(?!\s)([\s\S]*?\S)\1/g;
  for (const match of line.matchAll(codePattern)) {
    const start = match.index ?? 0;
    const source = match[0] ?? "";
    codeRanges.push({ start, end: start + source.length });
    addFormatToken(tokens, counts, {
      kind: "inline-code",
      source,
      line: lineNumber,
      blockIndex,
    });
  }

  const visible = maskRanges(line, codeRanges);
  const linkPattern = /!?\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  for (const match of visible.matchAll(linkPattern)) {
    const start = match.index ?? 0;
    const source = line.slice(start, start + (match[0]?.length ?? 0));
    const detail = match[2];
    if (!detail) continue;
    addFormatToken(tokens, counts, {
      kind: "link",
      source,
      line: lineNumber,
      blockIndex,
      detail,
    });
  }

  const tokenPatterns: readonly [ComposerFormatTokenKind, RegExp][] = [
    ["bold", /\*\*(?=\S)([^*\n]*?\S)\*\*/g],
    ["strike", /~~(?=\S)([^~\n]*?\S)~~/g],
    ["italic", /(?<!\*)\*(?!\s)([^*\n]*?\S)\*(?!\*)/g],
    ["italic", /(?<!_)_(?!\s)([^_\n]*?\S)_(?!_)/g],
  ];
  for (const [kind, pattern] of tokenPatterns) {
    for (const match of visible.matchAll(pattern)) {
      const start = match.index ?? 0;
      const source = line.slice(start, start + (match[0]?.length ?? 0));
      addFormatToken(tokens, counts, {
        kind,
        source,
        line: lineNumber,
        blockIndex,
      });
    }
  }

  const malformedLink = /!?\[[^\]\n]*\]\([^\)\n]*$/.test(visible);
  const unmatched: ComposerFormatTokenKind[] = [];
  const outsideCode = visible;
  const delimiterChecks: readonly [ComposerFormatTokenKind, RegExp, string][] = [
    ["bold", /\*\*/g, "**"],
    ["strike", /~~/g, "~~"],
  ];
  for (const [kind, pattern] of delimiterChecks) {
    const count = [...outsideCode.matchAll(pattern)].length;
    if (count % 2 === 1) unmatched.push(kind);
  }
  const singleStars = outsideCode.replace(/\*\*/g, "").match(/\*/g)?.length ?? 0;
  if (singleStars % 2 === 1) unmatched.push("italic");
  const singleUnderscores = outsideCode.replace(/__/g, "").match(/_/g)?.length ?? 0;
  if (singleUnderscores % 2 === 1) unmatched.push("italic");

  return { malformedLink, unmatched };
}

function formatTokenLabel(kind: ComposerFormatTokenKind): string {
  if (kind === "inline-code") return "inline code";
  if (kind === "strike") return "strikethrough";
  return kind;
}

/**
 * Produces a bounded, source-preserving formatting inventory for the composer.
 * It intentionally does not normalize or rewrite Markdown and never treats
 * this preview as a parsed rich-text document. Fenced code and block math are
 * counted as blocks but are not scanned for inline formatting tokens.
 */
export function analyzeComposerFormatting(content: string): ComposerFormatAnalysis {
  const structure = analyzeComposerPreview(content);
  const counts: ComposerFormatCounts = { ...EMPTY_FORMAT_COUNTS };
  const collectedTokens: ComposerFormatToken[] = [];
  const warnings = [...structure.warnings];
  const normalized = content.replace(/\r\n?/g, "\n");
  let cursor = 0;
  let inspectedBlocks = 0;

  for (const [blockIndex, block] of structure.blocks.entries()) {
    if (blockIndex >= MAX_FORMAT_BLOCKS) break;
    inspectedBlocks += 1;
    if (block.kind === "heading") counts.headings += 1;
    if (block.kind === "list" || block.kind === "task-list") counts.lists += 1;
    if (block.kind === "task-list") counts.taskLists += 1;
    if (block.kind === "quote") counts.quotes += 1;
    if (block.kind === "table") counts.tables += 1;
    if (block.kind === "code") counts.codeBlocks += 1;
    if (block.kind === "math") counts.mathBlocks += 1;

    const start = normalized.indexOf(block.source, cursor);
    const blockStart = start >= 0 ? start : cursor;
    const firstLine = normalized.slice(0, blockStart).split("\n").length;
    cursor = start >= 0 ? start + block.source.length : cursor;
    if (block.kind === "code" || block.kind === "math") continue;

    for (const [lineOffset, line] of block.source.split("\n").entries()) {
      const result = formatLineTokens(line, firstLine + lineOffset, blockIndex, counts, collectedTokens);
      if (result.malformedLink) warnings.push(`Possible incomplete link on line ${firstLine + lineOffset}.`);
      for (const kind of result.unmatched) warnings.push(`Unclosed ${formatTokenLabel(kind)} marker on line ${firstLine + lineOffset}.`);
    }
  }

  const uniqueWarnings = [...new Set(warnings)];
  const omittedTokens = Math.max(0, collectedTokens.length - MAX_FORMAT_TOKENS);
  if (structure.blocks.length > MAX_FORMAT_BLOCKS) {
    uniqueWarnings.push(`Formatting audit inspected the first ${MAX_FORMAT_BLOCKS} blocks; later blocks were omitted.`);
  }
  if (omittedTokens > 0) {
    uniqueWarnings.push(`Formatting token list capped at ${MAX_FORMAT_TOKENS}; counts still include omitted tokens.`);
  }

  return {
    counts,
    tokens: collectedTokens.slice(0, MAX_FORMAT_TOKENS),
    warnings: uniqueWarnings,
    inspectedBlocks,
    omittedTokens,
  };
}

const GREEK_SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  chi: "χ",
  delta: "δ",
  epsilon: "ε",
  eta: "η",
  gamma: "γ",
  lambda: "λ",
  mu: "μ",
  omega: "ω",
  phi: "φ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  theta: "θ",
  upsilon: "υ",
  xi: "ξ",
  zeta: "ζ",
};

const LATEX_SYMBOLS: Record<string, string> = {
  cdot: "·",
  div: "÷",
  geq: "≥",
  infty: "∞",
  leq: "≤",
  mapsto: "↦",
  neq: "≠",
  pm: "±",
  rightarrow: "→",
  times: "×",
  to: "→",
};

function trimMathSource(source: string): string {
  return source
    .trim()
    .replace(/^\$\$\s*/, "")
    .replace(/\s*\$\$$/, "")
    .replace(/^\$\s*/, "")
    .replace(/\s*\$$/, "")
    .replace(/^\\\[\s*/, "")
    .replace(/\s*\\\]$/, "")
    .replace(/^\\\(\s*/, "")
    .replace(/\s*\\\)$/, "")
    .trim();
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableBlock(lines: readonly string[]): boolean {
  return lines.length >= 2 && lines[0]!.includes("|") && isTableSeparator(lines[1]!);
}

/**
 * Provides a small, dependency-free approximation for the composer preview.
 * This intentionally is not a TeX renderer: the raw source remains visible
 * next to the approximation and the UI calls out the renderer-local boundary.
 */
export function formatLatexPreview(source: string): string {
  let value = trimMathSource(source).replace(/\s+/g, " ");
  value = value.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
  value = value.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
  value = value.replace(/([_^])\{([^{}]*)\}/g, "$1$2");
  value = value.replace(/\\([A-Za-z]+)/g, (token, name: string) =>
    GREEK_SYMBOLS[name] ?? LATEX_SYMBOLS[name] ?? token,
  );
  return value || "(empty equation)";
}

/**
 * Splits a plain Markdown line into text and inline math spans. This is a
 * deliberately small, non-TeX parser for the WYSIWYM surface: it preserves
 * the original source and only replaces the visual representation of
 * `$...$` / `\\(...\\)` spans with a local approximation.
 */
export function splitInlineMath(value: string): ComposerInlineMathSegment[] {
  const segments: ComposerInlineMathSegment[] = [];
  const pattern = /(?<![\\$])\$([^$\n]+)(?<!\\)\$(?!\$)|\\\(([^\n]+?)\\\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", value: value.slice(cursor, index) });
    const source = match[0];
    segments.push({ kind: "math", value: formatLatexPreview(source), source });
    cursor = index + source.length;
  }
  if (cursor < value.length) segments.push({ kind: "text", value: value.slice(cursor) });
  return segments.length ? segments : [{ kind: "text", value }];
}

function countInlineMath(value: string): number {
  const pattern = /(?<![\\$])\$([^$\n]+)(?<!\\)\$(?!\$)|\\\([^\n]+?\\\)/g;
  return [...value.matchAll(pattern)].length;
}

function isMathStart(line: string): boolean {
  return line.trim() === "$$" || line.trim() === "\\[";
}

function isMathEnd(line: string, delimiter: "$$" | "\\["): boolean {
  return delimiter === "$$" ? line.trim() === "$$" : line.trim() === "\\]";
}

function flushParagraph(lines: string[], blocks: ComposerPreviewBlock[]): void {
  if (!lines.length) return;
  const source = lines.join("\n");
  const firstLine = lines[0]!.trim();
  let kind: ComposerPreviewBlockKind = "paragraph";
  let detail: string | undefined;
  let title: string | undefined;

  if (isTableBlock(lines)) {
    kind = "table";
    const columnCount = tableCells(lines[0]!).length;
    const rowCount = Math.max(0, lines.length - 2);
    detail = `${columnCount} column${columnCount === 1 ? "" : "s"} · ${rowCount} data row${rowCount === 1 ? "" : "s"}`;
  } else if (/^#{1,6}\s+/.test(firstLine)) {
    kind = "heading";
    const heading = firstLine.match(/^(#{1,6})\s+(.+)$/);
    title = heading?.[2]?.trim() || "Untitled heading";
    detail = `${heading?.[1]?.length ?? 1} level`;
  } else if (/^\s*>/.test(firstLine)) {
    kind = "quote";
    detail = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  } else if (/^\s*[-+*]\s+\[[ xX]\]/.test(firstLine)) {
    kind = "task-list";
    detail = `${lines.length} task${lines.length === 1 ? "" : "s"}`;
  } else if (/^\s*(?:[-+*]|\d+[.)]|[A-Za-z]+[.)])\s+/.test(firstLine)) {
    kind = "list";
    detail = `${lines.length} item${lines.length === 1 ? "" : "s"}`;
  } else if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(firstLine)) {
    kind = "divider";
  }

  const block: ComposerPreviewBlock = { kind, source };
  if (detail !== undefined) block.detail = detail;
  if (title !== undefined) block.title = title;
  blocks.push(block);
  lines.length = 0;
}

export function analyzeComposerPreview(content: string): ComposerPreviewAnalysis {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const blocks: ComposerPreviewBlock[] = [];
  const warnings: string[] = [];
  const paragraph: string[] = [];
  let fence: { marker: "```" | "~~~"; language: string; lines: string[] } | null = null;
  let math: { delimiter: "$$" | "\\["; lines: string[] } | null = null;

  const flushFence = (closed = true) => {
    if (!fence) return;
    const sourceLines = [fence.marker + (fence.language ? fence.language : ""), ...fence.lines];
    if (closed) sourceLines.push(fence.marker);
    blocks.push({
      kind: "code",
      source: sourceLines.join("\n"),
      detail: fence.language || "text",
    });
    fence = null;
  };

  const flushMath = (closed = true) => {
    if (!math) return;
    const sourceLines = [math.delimiter, ...math.lines];
    if (closed) sourceLines.push(math.delimiter === "$$" ? "$$" : "\\]");
    blocks.push({
      kind: "math",
      source: sourceLines.join("\n"),
      detail: "LaTeX equation",
    });
    math = null;
  };

  for (const line of lines) {
    if (fence) {
      if (line.trim() === fence.marker) flushFence(true);
      else fence.lines.push(line);
      continue;
    }

    if (math) {
      if (isMathEnd(line, math.delimiter)) flushMath();
      else math.lines.push(line);
      continue;
    }

    const fenceMatch = line.match(/^\s{0,3}(```|~~~)\s*([^\s]*)\s*$/);
    if (fenceMatch) {
      flushParagraph(paragraph, blocks);
      fence = {
        marker: fenceMatch[1] as "```" | "~~~",
        language: fenceMatch[2] ?? "",
        lines: [],
      };
      continue;
    }

    if (isMathStart(line)) {
      flushParagraph(paragraph, blocks);
      math = { delimiter: line.trim() as "$$" | "\\[", lines: [] };
      continue;
    }

    if (!line.trim()) {
      flushParagraph(paragraph, blocks);
      continue;
    }
    paragraph.push(line);
  }

  if (fence) {
    warnings.push(`Unclosed ${fence.language || "code"} fence; the source remains unchanged.`);
    flushFence(false);
  }
  if (math) {
    warnings.push("Unclosed LaTeX block; the source remains unchanged.");
    flushMath(false);
  }
  flushParagraph(paragraph, blocks);

  // Count only ordinary Markdown blocks. Math/code blocks may contain `$...$`
  // as source text and must not inflate the inline-math summary.
  const inlineMathCount = blocks
    .filter((block) => block.kind !== "code" && block.kind !== "math")
    .reduce((total, block) => total + countInlineMath(block.source), 0);
  return {
    blocks,
    chars: content.length,
    lines: content ? lines.length : 0,
    words: content.trim() ? content.trim().split(/\s+/).length : 0,
    inlineMathCount,
    warnings,
  };
}

function blockIcon(kind: ComposerPreviewBlockKind) {
  if (kind === "heading") return <Heading2 size={14} />;
  if (kind === "code") return <Code2 size={14} />;
  if (kind === "math") return <FunctionSquare size={14} />;
  if (kind === "task-list") return <CheckSquare2 size={14} />;
  if (kind === "list") return <ListTree size={14} />;
  if (kind === "table") return <Table2 size={14} />;
  if (kind === "quote") return <Quote size={14} />;
  if (kind === "divider") return <Braces size={14} />;
  return <FileText size={14} />;
}

function InlineMathText({ value }: { value: string }) {
  return (
    <>
      {splitInlineMath(value).map((segment, index) =>
        segment.kind === "math" ? (
          <span
            key={`inline-math-${index}`}
            className="composer-rich-preview__inline-math"
            title={`Inline LaTeX approximation: ${segment.source}`}
          >
            {segment.value}
          </span>
        ) : (
          <span key={`inline-text-${index}`}>{segment.value}</span>
        ),
      )}
    </>
  );
}

function MathPreviewCard({ source }: { source: string }) {
  return (
    <section className="composer-rich-preview__math" aria-label="Math preview">
      <header className="composer-rich-preview__math-header">
        <span>
          <FunctionSquare size={14} aria-hidden="true" />
          Math preview
        </span>
        <small>LaTeX</small>
      </header>
      <div className="composer-rich-preview__math-render" aria-label="Renderer-local equation approximation">
        {formatLatexPreview(source)}
      </div>
      <code className="composer-rich-preview__math-source">{source}</code>
      <p>Renderer-local approximation · no TeX engine or provider was invoked.</p>
    </section>
  );
}

function RenderedPreview({ content, analysis }: { content: string; analysis: ComposerPreviewAnalysis }) {
  if (!content.trim()) {
    return <p className="composer-preview__empty">Nothing to preview yet. Start writing Markdown in the composer.</p>;
  }

  const mathBlocks = analysis.blocks.filter((block) => block.kind === "math");
  if (!mathBlocks.length) {
    return (
      <Suspense fallback={<MarkdownLoadingState content={content} />}>
        <LazyMessageMarkdown content={content} renderInlineMath />
      </Suspense>
    );
  }

  const segments: Array<{ type: "markdown" | "math"; value: string }> = [];
  let cursor = 0;
  for (const block of mathBlocks) {
    const index = content.indexOf(block.source, cursor);
    if (index < 0) continue;
    if (index > cursor) segments.push({ type: "markdown", value: content.slice(cursor, index) });
    segments.push({ type: "math", value: block.source });
    cursor = index + block.source.length;
  }
  if (cursor < content.length) segments.push({ type: "markdown", value: content.slice(cursor) });

  return (
    <div className="composer-rich-preview__rendered-stack">
      {segments.map((segment, index) =>
        segment.type === "math" ? (
          <MathPreviewCard key={`math-${index}`} source={segment.value} />
        ) : (
          <Suspense key={`markdown-${index}`} fallback={<MarkdownLoadingState content={segment.value} />}>
            <LazyMessageMarkdown content={segment.value} renderInlineMath />
          </Suspense>
        ),
      )}
    </div>
  );
}

function WysiwymPreview({ analysis }: { analysis: ComposerPreviewAnalysis }) {
  if (!analysis.blocks.length) {
    return <p className="composer-preview__empty">Add a heading, list, code block, or equation to see the WYSIWYM structure.</p>;
  }

  return (
    <div className="composer-rich-preview__wysiwym" aria-label="WYSIWYM draft structure">
      {analysis.blocks.map((block, index) => {
        const lines = block.source.split("\n");
        const firstLine = lines[0]?.trim() ?? "";
        const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
        const listLines = lines.filter((line) => /^\s*(?:[-+*]|\d+[.)]|[A-Za-z]+[.)])\s+/.test(line));
        const isMath = block.kind === "math";
        return (
          <article key={`${block.kind}-${index}`} className={`composer-rich-preview__wysiwym-block composer-rich-preview__wysiwym-block--${block.kind}`}>
            <header className="composer-rich-preview__wysiwym-header">
              <span className="composer-rich-preview__wysiwym-kind">
                <span className="composer-rich-preview__outline-icon" aria-hidden="true">{blockIcon(block.kind)}</span>
                <strong>{block.kind === "task-list" ? "Checklist" : block.kind}</strong>
              </span>
              <small>Block {index + 1}{block.detail ? ` · ${block.detail}` : ""}</small>
            </header>
            <div className="composer-rich-preview__wysiwym-content">
              {isMath ? (
                <MathPreviewCard source={block.source} />
              ) : block.kind === "heading" ? (
                <h3>{headingMatch?.[1] ?? block.title ?? firstLine.replace(/^#+\s*/, "")}</h3>
              ) : block.kind === "code" ? (
                <pre><code>{(() => {
                  const marker = firstLine.match(/^\s*(```|~~~)/)?.[1];
                  const hasClosingFence = Boolean(marker && lines.length > 1 && lines.at(-1)?.trim() === marker);
                  const codeLines = lines.slice(1, hasClosingFence ? -1 : undefined);
                  return codeLines.join("\n") || "(empty code block)";
                })()}</code></pre>
              ) : block.kind === "list" || block.kind === "task-list" ? (
                <ul className="composer-rich-preview__wysiwym-list">
                  {(listLines.length ? listLines : lines).map((line, lineIndex) => (
                    <li key={`${index}-line-${lineIndex}`}>
                      <InlineMathText value={line.replace(/^\s*(?:[-+*]|\d+[.)]|[A-Za-z]+[.)])\s+/, "").replace(/^\[[ xX]\]\s*/, "")} />
                    </li>
                  ))}
                </ul>
              ) : block.kind === "quote" ? (
                <blockquote><InlineMathText value={lines.map((line) => line.replace(/^\s*>\s?/, "")).join("\n")} /></blockquote>
              ) : block.kind === "table" ? (
                <table className="composer-rich-preview__wysiwym-table">
                  <thead>
                    <tr>{tableCells(lines[0] ?? "").map((cell, cellIndex) => <th key={`header-${cellIndex}`}>{cell || "(empty)"}</th>)}</tr>
                  </thead>
                  <tbody>
                    {lines.slice(2).map((line, rowIndex) => (
                      <tr key={`row-${rowIndex}`}>
                        {tableCells(line).map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}><InlineMathText value={cell} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : block.kind === "divider" ? (
                <hr />
              ) : (
                <p><InlineMathText value={block.source} /></p>
              )}
            </div>
            <details className="composer-rich-preview__wysiwym-source">
              <summary>Show source</summary>
              <code>{block.source}</code>
            </details>
          </article>
        );
      })}
      <p className="composer-rich-preview__wysiwym-note">WYSIWYM is a renderer-local structure preview; inline equations use a lightweight approximation and preserve the original Markdown source.</p>
    </div>
  );
}

const FORMAT_SUMMARY_ITEMS: readonly { key: keyof ComposerFormatCounts; label: string; icon: LucideIcon }[] = [
  { key: "bold", label: "Bold", icon: Bold },
  { key: "italic", label: "Italic", icon: Italic },
  { key: "strike", label: "Strike", icon: Strikethrough },
  { key: "inlineCode", label: "Inline code", icon: Code2 },
  { key: "links", label: "Links", icon: Link2 },
  { key: "headings", label: "Headings", icon: Heading2 },
  { key: "lists", label: "Lists", icon: List },
  { key: "taskLists", label: "Checklists", icon: CheckSquare2 },
  { key: "quotes", label: "Quotes", icon: Quote },
  { key: "tables", label: "Tables", icon: Table2 },
  { key: "codeBlocks", label: "Code blocks", icon: Braces },
  { key: "mathBlocks", label: "Math blocks", icon: FunctionSquare },
];

function ComposerFormatPreview({ analysis }: { analysis: ComposerFormatAnalysis }) {
  if (!analysis.inspectedBlocks) {
    return <p className="composer-preview__empty">Add Markdown to inspect its formatting inventory.</p>;
  }

  return (
    <section className="composer-rich-preview__format" aria-label="Formatting audit">
      <header className="composer-rich-preview__format-header">
        <div>
          <strong>Formatting audit</strong>
          <small>Source markers and block kinds · no rewrite</small>
        </div>
        <span>{analysis.inspectedBlocks} block{analysis.inspectedBlocks === 1 ? "" : "s"} inspected</span>
      </header>
      <div className="composer-rich-preview__format-summary" aria-label="Formatting counts">
        {FORMAT_SUMMARY_ITEMS.map((item) => (
          <div key={item.key} className="composer-rich-preview__format-stat">
            <item.icon size={14} aria-hidden="true" />
            <strong>{analysis.counts[item.key]}</strong>
            <small>{item.label}</small>
          </div>
        ))}
      </div>
      {analysis.tokens.length ? (
        <div className="composer-rich-preview__format-tokens" aria-label="Inline formatting tokens">
          <div className="composer-rich-preview__format-section-heading">
            <strong>Inline markers</strong>
            <small>{analysis.tokens.length}{analysis.omittedTokens ? ` of ${analysis.tokens.length + analysis.omittedTokens}` : ""} shown</small>
          </div>
          <ul>
            {analysis.tokens.map((token, index) => (
              <li key={`${token.kind}-${token.line}-${index}`}>
                <span className={`composer-rich-preview__format-token composer-rich-preview__format-token--${token.kind}`}>
                  {formatTokenLabel(token.kind)}
                </span>
                <code>{token.source}</code>
                <small>Line {token.line} · Block {token.blockIndex + 1}{token.detail ? ` · ${token.detail}` : ""}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="composer-rich-preview__format-empty">No inline markers detected in the inspected blocks.</p>
      )}
      {analysis.warnings.length ? (
        <div className="composer-rich-preview__format-warnings" role="status" aria-label="Formatting audit warnings">
          {analysis.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      <p className="composer-rich-preview__format-note">This inventory is a bounded renderer-local audit. It preserves the Markdown source and does not parse, persist, or send a rich-text document.</p>
    </section>
  );
}

type BlockEditorPreviewProps = {
  analysis: ComposerPreviewAnalysis;
  // `ComposerRichPreview` forwards these hooks from optional public props.
  // With `exactOptionalPropertyTypes`, an optional property does not accept
  // an explicitly forwarded `undefined` unless that value is part of the
  // property type. Keeping the union here preserves the preview's optional
  // behavior while allowing the JSX forwarding path to remain straightforward.
  onBlockSelect?: ((block: ComposerPreviewBlock, index: number) => void) | undefined;
  onBlockReplace?: ((block: ComposerPreviewBlock, index: number, replacement: string) => void) | undefined;
};

/**
 * A small block-oriented editing surface for the composer preview.
 *
 * The source editor remains the authority. This panel only keeps an unsaved
 * local draft for the selected block and hands an explicit replacement back
 * to the composer; it never writes a file or creates a native document.
 */
function BlockEditorPreview({ analysis, onBlockSelect, onBlockReplace }: BlockEditorPreviewProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (analysis.blocks.length === 0) {
      setSelectedIndex(0);
      setDrafts({});
      setCollapsed(new Set());
      return;
    }
    setSelectedIndex((current) => Math.min(current, analysis.blocks.length - 1));
    setDrafts({});
    setStatus(null);
  }, [analysis.blocks]);

  if (!analysis.blocks.length) {
    return <p className="composer-preview__empty">Add a block to open the local block editor.</p>;
  }

  const safeSelectedIndex = Math.min(selectedIndex, analysis.blocks.length - 1);
  const selectedBlock = analysis.blocks[safeSelectedIndex]!;
  const selectedDraft = drafts[safeSelectedIndex] ?? selectedBlock.source;
  const isDirty = selectedDraft !== selectedBlock.source;

  const selectBlock = (index: number) => {
    setSelectedIndex(index);
    setStatus(null);
  };

  const resetSelectedDraft = () => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[safeSelectedIndex];
      return next;
    });
    setStatus("Local block edit reset; the source draft is unchanged.");
  };

  const applySelectedDraft = () => {
    if (!onBlockReplace || !isDirty) return;
    onBlockReplace(selectedBlock, safeSelectedIndex, selectedDraft);
    setDrafts((current) => {
      const next = { ...current };
      delete next[safeSelectedIndex];
      return next;
    });
    setStatus("Block replacement applied to the renderer-session draft.");
  };

  return (
    <section className="composer-rich-preview__block-editor" aria-label="Block editor preview">
      <div className="composer-rich-preview__block-editor-layout">
        <div className="composer-rich-preview__block-list" role="listbox" aria-label="Draft blocks">
          {analysis.blocks.map((block, index) => {
            const isSelected = index === safeSelectedIndex;
            const isCollapsed = collapsed.has(index);
            const label = block.title ?? block.detail ?? block.kind.replace("-", " ");
            return (
              <article
                key={`${block.kind}-${index}`}
                className={isSelected ? "composer-rich-preview__block-card composer-rich-preview__block-card--selected" : "composer-rich-preview__block-card"}
                role="option"
                aria-selected={isSelected}
              >
                <div className="composer-rich-preview__block-card-heading">
                  <button
                    type="button"
                    className="composer-rich-preview__block-card-toggle"
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} block ${index + 1}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index); else next.add(index);
                      return next;
                    })}
                  >
                    {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button
                    type="button"
                    className="composer-rich-preview__block-card-select"
                    aria-label={`Edit block ${index + 1}: ${label}`}
                    onClick={() => selectBlock(index)}
                  >
                    <span className="composer-rich-preview__outline-icon" aria-hidden="true">{blockIcon(block.kind)}</span>
                    <span className="composer-rich-preview__outline-copy">
                      <strong>{label}</strong>
                      <small>{block.kind} · {block.source.split("\n").length} line{block.source.includes("\n") ? "s" : ""}</small>
                    </span>
                  </button>
                </div>
                {!isCollapsed ? <code className="composer-rich-preview__block-card-source">{block.source}</code> : null}
              </article>
            );
          })}
        </div>

        <div className="composer-rich-preview__block-editor-detail">
          <header className="composer-rich-preview__block-editor-detail-heading">
            <span>
              <Edit3 size={14} aria-hidden="true" />
            <strong>Edit block {safeSelectedIndex + 1}</strong>
            </span>
            <small>{selectedBlock.kind} · {isDirty ? "Local changes" : "Source"}</small>
          </header>
          <textarea
            aria-label={`Edit block ${safeSelectedIndex + 1} source`}
            value={selectedDraft}
            rows={10}
            spellCheck={false}
            onChange={(event) => {
              setDrafts((current) => ({ ...current, [safeSelectedIndex]: event.target.value }));
              setStatus(null);
            }}
          />
          <div className="composer-rich-preview__block-editor-actions">
            <button type="button" className="button button--ghost" onClick={resetSelectedDraft} disabled={!isDirty}>
              <RotateCcw size={13} /> Reset local edit
            </button>
            {onBlockSelect ? (
              <button type="button" className="button button--ghost" onClick={() => onBlockSelect(selectedBlock, safeSelectedIndex)}>
                Jump to source
              </button>
            ) : null}
            <button type="button" className="button button--secondary" onClick={applySelectedDraft} disabled={!onBlockReplace || !isDirty}>
              <Save size={13} /> Apply to draft
            </button>
          </div>
          {status ? <p className="composer-rich-preview__block-editor-status" role="status">{status}</p> : null}
          <p className="composer-rich-preview__block-editor-note">Edit stays local until you explicitly apply it. Undo/redo remains available in the composer.</p>
        </div>
      </div>
    </section>
  );
}

export interface ComposerRichPreviewProps {
  content: string;
  /**
   * Optional renderer-local navigation hook. When supplied, outline entries
   * become jump targets for the source editor; no file, provider, or native
   * document is read or mutated.
   */
  onBlockSelect?: (block: ComposerPreviewBlock, index: number) => void;
  /** Renderer-local replacement callback for the block editor preview. */
  onBlockReplace?: (block: ComposerPreviewBlock, index: number, replacement: string) => void;
}

export function ComposerRichPreview({ content, onBlockSelect, onBlockReplace }: ComposerRichPreviewProps) {
  const [mode, setMode] = useState<ComposerPreviewMode>("rendered");
  const previewId = useId();
  const analysis = useMemo(() => analyzeComposerPreview(content), [content]);
  const formatting = useMemo(() => analyzeComposerFormatting(content), [content]);
  const previewModes: readonly ComposerPreviewMode[] = ["rendered", "wysiwym", "outline", "blocks", "format", "source"];
  const focusMode = (next: ComposerPreviewMode) => {
    setMode(next);
    window.requestAnimationFrame(() => {
      document.getElementById(`${previewId}-${next}-tab`)?.focus();
    });
  };
  const selectModeByOffset = (current: ComposerPreviewMode, offset: number) => {
    const currentIndex = previewModes.indexOf(current);
    focusMode(previewModes[(currentIndex + offset + previewModes.length) % previewModes.length]!);
  };

  return (
    <div className="composer-rich-preview">
      <header className="composer-rich-preview__header">
        <div className="composer-rich-preview__title">
          <span className="composer-rich-preview__icon" aria-hidden="true"><Sparkles size={13} /></span>
          <span>
            <strong>Live draft preview</strong>
            <small>Markdown structure · renderer-local</small>
          </span>
        </div>
        <div
          className="composer-rich-preview__modes"
          role="tablist"
          aria-label="Preview modes"
          aria-orientation="horizontal"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              selectModeByOffset(mode, 1);
              return;
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              selectModeByOffset(mode, -1);
              return;
            }
            if (event.key === "Home") {
              event.preventDefault();
              focusMode(previewModes[0]!);
              return;
            }
            if (event.key === "End") {
              event.preventDefault();
              focusMode(previewModes[previewModes.length - 1]!);
            }
          }}
        >
          {([
            ["rendered", "Rendered"],
            ["wysiwym", "WYSIWYM"],
            ["outline", "Outline"],
            ["blocks", "Blocks"],
            ["format", "Format"],
            ["source", "Source"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${previewId}-${value}-tab`}
              aria-selected={mode === value}
              aria-controls={`${previewId}-${value}-panel`}
              tabIndex={mode === value ? 0 : -1}
              className={mode === value ? "composer-rich-preview__mode composer-rich-preview__mode--active" : "composer-rich-preview__mode"}
              onClick={() => focusMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="composer-rich-preview__stats" aria-label="Draft preview summary">
        <span>{analysis.blocks.length} blocks</span>
        <span>{analysis.words} words</span>
        <span>{analysis.chars.toLocaleString()} chars</span>
        {analysis.inlineMathCount ? <span>{analysis.inlineMathCount} inline math</span> : null}
      </div>
      {analysis.warnings.length ? (
        <div className="composer-rich-preview__warnings" role="status" aria-label="Draft preview warnings">
          {analysis.warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      <div className="composer-rich-preview__body">
        {mode === "rendered" ? (
          <div id={`${previewId}-rendered-panel`} role="tabpanel" aria-labelledby={`${previewId}-rendered-tab`} tabIndex={0}>
            <RenderedPreview content={content} analysis={analysis} />
          </div>
        ) : null}
        {mode === "wysiwym" ? (
          <div id={`${previewId}-wysiwym-panel`} role="tabpanel" aria-label="WYSIWYM draft structure" aria-labelledby={`${previewId}-wysiwym-tab`} tabIndex={0}>
            <WysiwymPreview analysis={analysis} />
          </div>
        ) : null}
        {mode === "source" ? (
          <div id={`${previewId}-source-panel`} role="tabpanel" aria-labelledby={`${previewId}-source-tab`} tabIndex={0}>
            {content.trim() ? <pre className="composer-rich-preview__source" aria-label="Markdown source preview">{content}</pre> : <p className="composer-preview__empty">Source is empty.</p>}
          </div>
        ) : null}
        {mode === "blocks" ? (
          <div id={`${previewId}-blocks-panel`} role="tabpanel" aria-labelledby={`${previewId}-blocks-tab`} tabIndex={0}>
            <BlockEditorPreview analysis={analysis} onBlockSelect={onBlockSelect} onBlockReplace={onBlockReplace} />
          </div>
        ) : null}
        {mode === "format" ? (
          <div id={`${previewId}-format-panel`} role="tabpanel" aria-labelledby={`${previewId}-format-tab`} tabIndex={0}>
            <ComposerFormatPreview analysis={formatting} />
          </div>
        ) : null}
        {mode === "outline" ? (
          <div id={`${previewId}-outline-panel`} role="tabpanel" aria-labelledby={`${previewId}-outline-tab`} tabIndex={0}>
            {analysis.blocks.length ? (
              <ol className="composer-rich-preview__outline" aria-label="Draft structure outline">
                {analysis.blocks.map((block, index) => {
                const label = block.title ?? block.detail ?? block.kind.replace("-", " ");
                const copy = (
                  <>
                    <span className="composer-rich-preview__outline-icon" aria-hidden="true">{blockIcon(block.kind)}</span>
                    <span className="composer-rich-preview__outline-copy">
                      <strong>{label}</strong>
                      <small>{block.kind} · {block.source.split("\n").length} line{block.source.includes("\n") ? "s" : ""}</small>
                    </span>
                  </>
                );

                return (
                  <li key={`${block.kind}-${index}`}>
                    {onBlockSelect ? (
                      <button
                        type="button"
                        className="composer-rich-preview__outline-jump"
                        aria-label={`Jump to block ${index + 1}: ${label}`}
                        onClick={() => onBlockSelect(block, index)}
                      >
                        {copy}
                      </button>
                    ) : copy}
                  </li>
                );
                })}
              </ol>
            ) : (
              <p className="composer-preview__empty">The outline will appear as you add headings, lists, code, and equations.</p>
            )}
          </div>
        ) : null}
      </div>
      <p className="composer-rich-preview__boundary">Preview only · no file read, native write, provider request, or durable save.</p>
    </div>
  );
}
