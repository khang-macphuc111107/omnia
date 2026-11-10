import {
  Bold,
  Check,
  Clipboard,
  Clock3,
  Code2,
  Download,
  FileJson,
  FileText,
  Image as ImageIcon,
  Italic,
  LayoutPanelLeft,
  List,
  ListChecks,
  ListOrdered,
  MessageSquarePlus,
  Minus,
  Quote,
  Redo2,
  RotateCcw,
  Search,
  Square,
  SquareCheck,
  SplitSquareHorizontal,
  Sigma,
  Type,
  Undo2,
  Upload,
  Video,
  Table2,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import {
  importArtifactDocument,
  serializeArtifactDocumentBundle,
  serializeArtifactDocumentMarkdown,
  type ArtifactDocumentPortableFormat,
} from "./artifact-document-io";
import type { ArtifactView } from "./types";
import { ArtifactAtomicHandoffPreview } from "./artifact-atomic-handoff-preview";

type StudioLayout = "split" | "editor" | "rendered";
type FormattingAction = "bold" | "italic" | "heading" | "bullet" | "checklist" | "ordered" | "quote" | "code" | "math" | "table" | "divider" | "image" | "video";
type StructureFilter = "all" | "headings" | "content" | "lists" | "code" | "math" | "media" | "tables";

interface EditorHistory {
  past: string[];
  future: string[];
}

interface DraftCheckpoint {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly sequence: number;
}

interface DraftAnnotation {
  readonly id: string;
  readonly label: string;
  readonly quote: string;
  readonly start: number;
  readonly end: number;
  readonly sequence: number;
}

interface SelectionRange {
  start: number;
  end: number;
}

export interface ArtifactDocumentStudioPreviewProps {
  artifact: ArtifactView;
  revision: number;
}

interface OutlineEntry {
  readonly id: string;
  readonly level: number;
  readonly label: string;
  readonly start: number;
}

interface StructureBlock {
  readonly id: string;
  readonly kind: Exclude<StructureFilter, "all">;
  readonly label: string;
  readonly detail: string;
  readonly start: number;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "section";
}

function artifactTitle(artifact: ArtifactView): string {
  return artifact.name.replace(/\.[^/.]+$/, "") || artifact.name;
}

function starterDocument(artifact: ArtifactView, revision: number): string {
  const title = artifactTitle(artifact);
  if (artifact.type === "Code") {
    return [
      `# ${title}`,
      "",
      "```json",
      "{",
      `  \"artifact\": \"${artifact.name}\",`,
      `  \"revision\": ${revision},`,
      `  \"project\": \"${artifact.projectName}\"`,
      "}",
      "```",
      "",
      "> Renderer-local document studio draft.",
    ].join("\n");
  }
  if (artifact.type === "Data") {
    return [
      `# ${title}`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Revision | ${revision} |`,
      `| Size | ${artifact.sizeLabel} |`,
      `| Project | ${artifact.projectName} |`,
      "",
      "The table is a renderer-local preview of the artifact metadata.",
    ].join("\n");
  }
  if (artifact.type === "Diagram") {
    return [
      `# ${title}`,
      "",
      "```mermaid",
      "flowchart LR",
      `  source[${artifact.name}] --> revision[Revision ${revision}]`,
      "  revision --> review[Review draft]",
      "```",
      "",
      "Diagram source is shown as text until a sandboxed renderer is available.",
    ].join("\n");
  }
  return [
    `# ${title}`,
    "",
    "## Summary",
    "",
    `This renderer-local draft represents revision ${revision} of **${artifact.name}**.`,
    "",
    "## Working notes",
    "",
    "Edit this draft to rehearse document structure, then inspect the rendered view.",
    "",
    "> Native artifact bytes, hashes, revision mutation, and export receipts remain planned.",
  ].join("\n");
}

function outlineFor(source: string): OutlineEntry[] {
  const seen = new Map<string, number>();
  let offset = 0;
  return source.split("\n").flatMap((line) => {
    const lineStart = offset;
    offset += line.length + 1;
    const match = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (!match) return [];
    const label = match[2];
    const marker = match[1];
    if (!label || !marker) return [];
    const base = slugify(label);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return [{ id: `${base}-${count}`, level: marker.length, label, start: lineStart }];
  });
}

function structureFor(source: string): StructureBlock[] {
  const lines = source.split("\n");
  const blocks: StructureBlock[] = [];
  let offset = 0;
  let inCode = false;
  let codeStart = 0;
  let codeLanguage = "text";
  let inMath = false;
  let mathStart = 0;
  let listCounter = 0;
  let paragraphStart: number | null = null;

  const flushParagraph = (endOffset: number) => {
    if (paragraphStart === null) return;
    blocks.push({
      id: `paragraph-${paragraphStart}`,
      kind: "content",
      label: "Paragraph",
      detail: `${Math.max(1, endOffset - paragraphStart)} characters`,
      start: paragraphStart,
    });
    paragraphStart = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineStart = offset;
    const nextOffset = offset + line.length + 1;
    if (line.startsWith("```")) {
      flushParagraph(lineStart);
      if (!inCode) {
        inCode = true;
        codeStart = lineStart;
        codeLanguage = line.slice(3).trim() || "text";
      } else {
        blocks.push({
          id: `code-${codeStart}`,
          kind: "code",
          label: "Code block",
          detail: codeLanguage,
          start: codeStart,
        });
        inCode = false;
        codeLanguage = "text";
      }
      offset = nextOffset;
      continue;
    }
    if (inCode) {
      offset = nextOffset;
      continue;
    }
    if (line.trim() === "$$") {
      flushParagraph(lineStart);
      if (!inMath) {
        inMath = true;
        mathStart = lineStart;
      } else {
        blocks.push({ id: `math-${mathStart}`, kind: "math", label: "Math block", detail: "LaTeX", start: mathStart });
        inMath = false;
      }
      offset = nextOffset;
      continue;
    }
    if (inMath) {
      offset = nextOffset;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph(lineStart);
      const label = heading[2]?.trim() || "Untitled heading";
      blocks.push({
        id: `heading-${lineStart}`,
        kind: "headings",
        label: `Heading · ${label}`,
        detail: `Level ${heading[1]?.length ?? 1}`,
        start: lineStart,
      });
      offset = nextOffset;
      continue;
    }
    const listMatch = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      flushParagraph(lineStart);
      const checklist = /^\s*[-*]\s+\[[ xX]\]/.test(line);
      const ordered = /^\s*\d+[.)]/.test(line);
      let itemCount = 1;
      let cursor = index + 1;
      while (cursor < lines.length && /^\s*(?:[-*]|\d+[.)])\s+/.test(lines[cursor] ?? "")) {
        itemCount += 1;
        cursor += 1;
      }
      let blockEnd = lineStart;
      for (let itemIndex = index; itemIndex < cursor; itemIndex += 1) blockEnd += (lines[itemIndex]?.length ?? 0) + 1;
      listCounter += 1;
      blocks.push({
        id: `list-${lineStart}-${listCounter}`,
        kind: "lists",
        label: checklist ? "Checklist" : ordered ? "Numbered list" : "Bullet list",
        detail: `${itemCount} ${itemCount === 1 ? "item" : "items"}`,
        start: lineStart,
      });
      index = cursor - 1;
      offset = blockEnd;
      continue;
    }
    const media = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (media) {
      flushParagraph(lineStart);
      const isVideo = (media[1] ?? "").toLowerCase().startsWith("video:");
      blocks.push({ id: `media-${lineStart}`, kind: "media", label: isVideo ? "Video reference" : "Image reference", detail: media[2] ?? "local reference", start: lineStart });
      offset = nextOffset;
      continue;
    }
    if (/^\|/.test(line) && isMarkdownTableDivider(lines[index + 1] ?? "")) {
      flushParagraph(lineStart);
      blocks.push({ id: `table-${lineStart}`, kind: "tables", label: "Markdown table", detail: `${tableCells(line).length} columns`, start: lineStart });
      offset = nextOffset;
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph(lineStart);
      blocks.push({ id: `divider-${lineStart}`, kind: "content", label: "Divider", detail: "Horizontal rule", start: lineStart });
      offset = nextOffset;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph(lineStart);
      blocks.push({ id: `quote-${lineStart}`, kind: "content", label: "Quote", detail: "Blockquote", start: lineStart });
      offset = nextOffset;
      continue;
    }
    if (line.trim()) {
      paragraphStart ??= lineStart;
    } else {
      flushParagraph(lineStart);
    }
    offset = nextOffset;
  }
  if (inCode) blocks.push({ id: `code-${codeStart}`, kind: "code", label: "Code block", detail: codeLanguage, start: codeStart });
  if (inMath) blocks.push({ id: `math-${mathStart}`, kind: "math", label: "Math block", detail: "LaTeX", start: mathStart });
  flushParagraph(source.length);
  return blocks;
}

function plainTextMetrics(source: string): { words: number; characters: number } {
  const words = source.trim() ? source.trim().split(/\s+/u).length : 0;
  return { words, characters: source.length };
}

function selectedRange(source: string, selection: SelectionRange, prefix: string, suffix = prefix): { source: string; selection: SelectionRange } {
  const selected = source.slice(selection.start, selection.end) || "text";
  const next = `${source.slice(0, selection.start)}${prefix}${selected}${suffix}${source.slice(selection.end)}`;
  return {
    source: next,
    selection: {
      start: selection.start + prefix.length,
      end: selection.start + prefix.length + selected.length,
    },
  };
}

function prefixedLines(source: string, selection: SelectionRange, prefix: string): { source: string; selection: SelectionRange } {
  const lineStart = source.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const lineEnd = source.indexOf("\n", selection.end);
  const blockEnd = lineEnd === -1 ? source.length : lineEnd;
  const block = source.slice(lineStart, blockEnd);
  const nextBlock = block
    .split("\n")
    .map((line) => line.startsWith(prefix) ? line : `${prefix}${line}`)
    .join("\n");
  return {
    source: `${source.slice(0, lineStart)}${nextBlock}${source.slice(blockEnd)}`,
    selection: {
      start: selection.start + prefix.length,
      end: selection.end + prefix.length * (nextBlock.split("\n").length),
    },
  };
}

function orderedLines(source: string, selection: SelectionRange): { source: string; selection: SelectionRange } {
  const lineStart = source.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const lineEnd = source.indexOf("\n", selection.end);
  const blockEnd = lineEnd === -1 ? source.length : lineEnd;
  const block = source.slice(lineStart, blockEnd);
  let index = 1;
  const nextBlock = block.split("\n").map((line) => {
    const existing = line.match(/^\s*(\d+)[.)]\s+/);
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const content = existing ? line.slice(existing[0].length) : line.trimStart();
    const marker = `${index++}. `;
    return `${indent}${marker}${content}`;
  }).join("\n");
  const addedMarkers = nextBlock.split("\n").length * 3;
  return {
    source: `${source.slice(0, lineStart)}${nextBlock}${source.slice(blockEnd)}`,
    selection: { start: selection.start + 3, end: selection.end + addedMarkers },
  };
}

function checklistLines(source: string, selection: SelectionRange): { source: string; selection: SelectionRange } {
  const lineStart = source.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const lineEnd = source.indexOf("\n", selection.end);
  const blockEnd = lineEnd === -1 ? source.length : lineEnd;
  const block = source.slice(lineStart, blockEnd);
  const nextBlock = block
    .split("\n")
    .map((line) => {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const content = line.replace(/^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s*)?/, "");
      return `${indent}- [ ] ${content}`;
    })
    .join("\n");
  const prefixLength = "- [ ] ".length;
  return {
    source: `${source.slice(0, lineStart)}${nextBlock}${source.slice(blockEnd)}`,
    selection: {
      start: selection.start + prefixLength,
      end: selection.end + prefixLength * nextBlock.split("\n").length,
    },
  };
}

function tableSnippet(source: string, selection: SelectionRange): { source: string; selection: SelectionRange } {
  const selected = source.slice(selection.start, selection.end).trim() || "Value";
  const value = selected.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const snippet = [
    "| Column | Value |",
    "| --- | --- |",
    `| Item | ${value} |`,
  ].join("\n");
  const next = `${source.slice(0, selection.start)}${snippet}${source.slice(selection.end)}`;
  return {
    source: next,
    selection: {
      start: selection.start + "| Column | ".length,
      end: selection.start + "| Column | Value".length,
    },
  };
}

function dividerSnippet(source: string, selection: SelectionRange): { source: string; selection: SelectionRange } {
  const prefix = selection.start > 0 && source[selection.start - 1] !== "\n" ? "\n\n" : "";
  const suffix = selection.end < source.length && source[selection.end] !== "\n" ? "\n\n" : "\n";
  const snippet = `${prefix}---${suffix}`;
  const next = `${source.slice(0, selection.start)}${snippet}${source.slice(selection.end)}`;
  const caret = selection.start + snippet.length;
  return { source: next, selection: { start: caret, end: caret } };
}

function blockSnippet(source: string, selection: SelectionRange, opening: string, closing: string, placeholder: string): { source: string; selection: SelectionRange } {
  const selected = source.slice(selection.start, selection.end) || placeholder;
  const value = `${opening}\n${selected}\n${closing}`;
  const next = `${source.slice(0, selection.start)}${value}${source.slice(selection.end)}`;
  return {
    source: next,
    selection: {
      start: selection.start + opening.length + 1,
      end: selection.start + opening.length + 1 + selected.length,
    },
  };
}

function mediaSnippet(source: string, selection: SelectionRange, kind: "image" | "video"): { source: string; selection: SelectionRange } {
  const selected = source.slice(selection.start, selection.end).trim() || (kind === "image" ? "alt text" : "video title");
  const value = kind === "image"
    ? `![${selected}](https://example.com/image.png)`
    : `![video: ${selected}](https://example.com/video.mp4)`;
  const next = `${source.slice(0, selection.start)}${value}${source.slice(selection.end)}`;
  return { source: next, selection: { start: selection.start, end: selection.start + value.length } };
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutStart = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = withoutStart.endsWith("|") ? withoutStart.slice(0, -1) : withoutStart;
  return withoutEnd.split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isMarkdownTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function safeInlineLinkTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (/^(?:https?:|mailto:|#|\/|\.\.?\/)/i.test(trimmed)) return trimmed;
  return undefined;
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const patterns: Array<{ kind: "code" | "link" | "strong" | "strike" | "emphasis"; expression: RegExp }> = [
    { kind: "code", expression: /`([^`]+)`/ },
    { kind: "link", expression: /\[([^\]]+)\]\(([^)\s]+)\)/ },
    { kind: "strong", expression: /(\*\*|__)(.+?)\1/ },
    { kind: "strike", expression: /~~(.+?)~~/ },
    { kind: "emphasis", expression: /(\*|_)(.+?)\1/ },
  ];

  let next: { kind: (typeof patterns)[number]["kind"]; match: RegExpExecArray; index: number } | undefined;
  for (const pattern of patterns) {
    const match = pattern.expression.exec(value);
    if (!match || match.index < 0) continue;
    if (!next || match.index < next.index) next = { kind: pattern.kind, match, index: match.index };
  }
  if (!next) return value ? [value] : [];

  const before = value.slice(0, next.index);
  const after = value.slice(next.index + next.match[0].length);
  const nodes: ReactNode[] = [];
  if (before) nodes.push(before);

  if (next.kind === "code") {
    nodes.push(<code className="artifact-document-studio__render-inline-code" key={`${keyPrefix}-code`}>{next.match[1]}</code>);
  } else if (next.kind === "link") {
    const label = next.match[1] ?? "link";
    const target = next.match[2] ?? "";
    const href = safeInlineLinkTarget(target);
    nodes.push(
      href ? (
        <a className="artifact-document-studio__render-link" href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined} key={`${keyPrefix}-link`}>
          {renderInline(label, `${keyPrefix}-link-label`)}
        </a>
      ) : (
        <span className="artifact-document-studio__render-link is-unavailable" title={`Unsupported link target: ${target}`} key={`${keyPrefix}-link`}>
          {renderInline(label, `${keyPrefix}-link-label`)}
        </span>
      ),
    );
  } else if (next.kind === "strong") {
    nodes.push(<strong key={`${keyPrefix}-strong`}>{renderInline(next.match[2] ?? "", `${keyPrefix}-strong-body`)}</strong>);
  } else if (next.kind === "strike") {
    nodes.push(<del key={`${keyPrefix}-strike`}>{renderInline(next.match[1] ?? "", `${keyPrefix}-strike-body`)}</del>);
  } else {
    nodes.push(<em key={`${keyPrefix}-emphasis`}>{renderInline(next.match[2] ?? "", `${keyPrefix}-emphasis-body`)}</em>);
  }

  nodes.push(...renderInline(after, `${keyPrefix}-after`));
  return nodes;
}

function renderDocument(source: string, onToggleChecklist?: (lineIndex: number, checked: boolean) => void) {
  const lines = source.split("\n");
  const output: ReactNode[] = [];
  let inCode = false;
  let codeLanguage = "text";
  let codeLines: string[] = [];
  let inMath = false;
  let mathLines: string[] = [];

  const flushCode = () => {
    if (!inCode) return;
    output.push(
      <pre className="artifact-document-studio__render-code" key={`code-${output.length}`}>
        <code data-language={codeLanguage}>{codeLines.join("\n")}</code>
      </pre>,
    );
    codeLines = [];
  };

  const flushMath = () => {
    if (!inMath) return;
    output.push(
      <pre className="artifact-document-studio__render-math" key={`math-${output.length}`}>
        <span>LaTeX preview · renderer-local</span>
        <code data-language="latex">{mathLines.join("\n")}</code>
      </pre>,
    );
    mathLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
        codeLanguage = "text";
      } else {
        inCode = true;
        codeLanguage = line.slice(3).trim() || "text";
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (line.trim() === "$$") {
      if (inMath) {
        flushMath();
        inMath = false;
      } else {
        inMath = true;
      }
      continue;
    }
    if (inMath) {
      mathLines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      const marker = heading[1];
      const label = heading[2];
      if (!marker || !label) continue;
      const Heading = `h${marker.length}` as "h1" | "h2" | "h3";
      output.push(<Heading key={`heading-${index}`}>{renderInline(label, `heading-${index}`)}</Heading>);
      continue;
    }
    const orderedItem = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (orderedItem) {
      const groupStart = index;
      const items: Array<{ number: number; label: string }> = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = candidate.match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (!match) break;
        items.push({ number: Number.parseInt(match[1] ?? "1", 10), label: match[2] ?? "" });
        index += 1;
      }
      output.push(
        <ol className="artifact-document-studio__render-list artifact-document-studio__render-ordered-list" start={items[0]?.number ?? 1} key={`ordered-${groupStart}`}>
          {items.map((item, itemIndex) => <li key={`ordered-${groupStart}-${itemIndex}`}>{renderInline(item.label, `ordered-${groupStart}-${itemIndex}`)}</li>)}
        </ol>,
      );
      index -= 1;
      continue;
    }

    const checklistItem = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(.*)$/);
    if (checklistItem) {
      const groupStart = index;
      const items: Array<{ checked: boolean; label: string; lineIndex: number }> = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = candidate.match(/^\s*[-*]\s+\[([ xX])\]\s*(.*)$/);
        if (!match) break;
        items.push({ checked: match[1]?.toLowerCase() === "x", label: match[2] ?? "", lineIndex: index });
        index += 1;
      }
      output.push(
        <ul className="artifact-document-studio__render-list artifact-document-studio__render-checklist-list" key={`checklist-${groupStart}`}>
          {items.map((item, itemIndex) => (
            <li className="artifact-document-studio__render-checklist" key={`checklist-${groupStart}-${itemIndex}`}>
              {onToggleChecklist ? (
                <button
                  type="button"
                  className="artifact-document-studio__render-checklist-toggle"
                  aria-label={`${item.checked ? "Mark incomplete" : "Mark complete"}: ${item.label || "untitled item"}`}
                  aria-pressed={item.checked}
                  onClick={() => onToggleChecklist(item.lineIndex, !item.checked)}
                >
                  {item.checked ? <SquareCheck size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
                </button>
              ) : item.checked ? <SquareCheck size={14} aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
              {renderInline(item.label, `checklist-${groupStart}-${itemIndex}`)}
            </li>
          ))}
        </ul>,
      );
      index -= 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const groupStart = index;
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        const match = candidate.match(/^\s*[-*]\s+(.*)$/);
        if (!match || /^\s*[-*]\s+\[([ xX])\]/.test(candidate)) break;
        items.push(match[1] ?? "");
        index += 1;
      }
      output.push(
        <ul className="artifact-document-studio__render-list" key={`list-${groupStart}`}>
          {items.map((item, itemIndex) => <li key={`list-${groupStart}-${itemIndex}`}>{renderInline(item, `list-${groupStart}-${itemIndex}`)}</li>)}
        </ul>,
      );
      index -= 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      output.push(<blockquote key={`quote-${index}`}>{renderInline(line.replace(/^>\s?/, ""), `quote-${index}`)}</blockquote>);
      continue;
    }
    const media = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (media) {
      const alt = media[1] ?? "media";
      const target = media[2] ?? "";
      const video = alt.toLowerCase().startsWith("video:");
      output.push(
        <figure className={`artifact-document-studio__render-media${video ? " is-video" : ""}`} key={`media-${index}`}>
          <div role="img" aria-label={`${video ? "Video" : "Image"} reference preview`}>
            {video ? "Video reference" : "Image reference"}
          </div>
          <figcaption>{video ? alt.slice("video:".length).trim() || "Untitled video" : alt} · {target} · no network fetch</figcaption>
        </figure>,
      );
      continue;
    }
    if (/^\|/.test(line) && isMarkdownTableDivider(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      index += 1;
      const rows: string[][] = [];
      while (/^\|/.test(lines[index + 1] ?? "")) {
        index += 1;
        rows.push(tableCells(lines[index] ?? ""));
      }
      output.push(
        <div className="artifact-document-studio__render-table-wrap" key={`table-${index}`}>
          <table className="artifact-document-studio__render-table" aria-label="Markdown table preview">
            <thead><tr>{headers.map((header, cellIndex) => <th key={`${header}-${cellIndex}`} scope="col">{renderInline(header, `table-header-${index}-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{headers.map((_, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{renderInline(row[cellIndex] ?? "", `table-cell-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      output.push(<hr key={`divider-${index}`} className="artifact-document-studio__render-divider" />);
      continue;
    }
    if (/^\|/.test(line)) {
      output.push(<code className="artifact-document-studio__render-table-line" key={`table-line-${index}`}>{line}</code>);
      continue;
    }
    if (line.trim()) output.push(<p key={`paragraph-${index}`}>{renderInline(line, `paragraph-${index}`)}</p>);
  }
  flushCode();
  flushMath();
  return output;
}

function browserDownload(source: string, fileName: string, format: ArtifactDocumentPortableFormat): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([source], {
    type: format === "json" ? "application/json" : "text/markdown;charset=utf-8",
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

export function ArtifactDocumentStudioPreview({
  artifact,
  revision,
}: ArtifactDocumentStudioPreviewProps) {
  const baseline = useMemo(() => starterDocument(artifact, revision), [artifact, revision]);
  const [source, setSource] = useState(baseline);
  const [layout, setLayout] = useState<StudioLayout>("split");
  const [copied, setCopied] = useState(false);
  const [portableFormat, setPortableFormat] = useState<ArtifactDocumentPortableFormat>("markdown");
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [structureFilter, setStructureFilter] = useState<StructureFilter>("all");
  const [status, setStatus] = useState("Renderer-local draft is ready.");
  const [history, setHistory] = useState<EditorHistory>({ past: [], future: [] });
  const [checkpoints, setCheckpoints] = useState<readonly DraftCheckpoint[]>([]);
  const [checkpointName, setCheckpointName] = useState("");
  const [annotations, setAnnotations] = useState<readonly DraftAnnotation[]>([]);
  const [annotationNote, setAnnotationNote] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef(source);
  const historyRef = useRef(history);
  const baselineRef = useRef(baseline);
  const checkpointSequenceRef = useRef(0);
  const annotationSequenceRef = useRef(0);
  const outline = useMemo(() => outlineFor(source), [source]);
  const structure = useMemo(() => structureFor(source), [source]);
  const visibleStructure = useMemo(
    () => structureFilter === "all"
      ? structure
      : structure.filter((block) => structureFilter === "content" ? block.kind === "content" : block.kind === structureFilter),
    [structure, structureFilter],
  );
  const metrics = useMemo(() => plainTextMetrics(source), [source]);
  const rendered = useMemo(() => renderDocument(source), [source]);
  const findMatches = useMemo(() => {
    if (!findQuery) return [];
    const matches: number[] = [];
    let cursor = 0;
    while (cursor < source.length) {
      const match = source.indexOf(findQuery, cursor);
      if (match === -1) break;
      matches.push(match);
      cursor = match + Math.max(1, findQuery.length);
    }
    return matches;
  }, [findQuery, source]);
  const dirty = source !== baseline;

  useEffect(() => {
    if (baselineRef.current === baseline) return;
    baselineRef.current = baseline;
    sourceRef.current = baseline;
    historyRef.current = { past: [], future: [] };
    setSource(baseline);
    setHistory(historyRef.current);
    checkpointSequenceRef.current = 0;
    setCheckpoints([]);
    setCheckpointName("");
    annotationSequenceRef.current = 0;
    setAnnotations([]);
    setAnnotationNote("");
    setStructureFilter("all");
    setCopied(false);
    setStatus("Loaded the selected artifact revision into a renderer-local draft.");
  }, [baseline]);

  const restoreSelection = (selection?: SelectionRange) => {
    if (!selection) return;
    const apply = () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(selection.start, selection.end);
    };
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(apply);
    else setTimeout(apply, 0);
  };

  const commitSource = (next: string, nextStatus: string, selection?: SelectionRange) => {
    const current = sourceRef.current;
    if (next === current) {
      setStatus(nextStatus);
      restoreSelection(selection);
      return;
    }
    const nextHistory: EditorHistory = {
      past: [...historyRef.current.past, current].slice(-50),
      future: [],
    };
    historyRef.current = nextHistory;
    sourceRef.current = next;
    setHistory(nextHistory);
    setSource(next);
    setCopied(false);
    setStatus(nextStatus);
    restoreSelection(selection);
  };

  const undoDraft = () => {
    const currentHistory = historyRef.current;
    const previous = currentHistory.past.at(-1);
    if (previous === undefined) {
      setStatus("Nothing to undo in this renderer-local draft.");
      return;
    }
    const nextHistory: EditorHistory = {
      past: currentHistory.past.slice(0, -1),
      future: [...currentHistory.future, sourceRef.current].slice(-50),
    };
    historyRef.current = nextHistory;
    sourceRef.current = previous;
    setHistory(nextHistory);
    setSource(previous);
    setCopied(false);
    setStatus("Undid the last renderer-local draft change.");
  };

  const redoDraft = () => {
    const currentHistory = historyRef.current;
    const nextValue = currentHistory.future.at(-1);
    if (nextValue === undefined) {
      setStatus("Nothing to redo in this renderer-local draft.");
      return;
    }
    const nextHistory: EditorHistory = {
      past: [...currentHistory.past, sourceRef.current].slice(-50),
      future: currentHistory.future.slice(0, -1),
    };
    historyRef.current = nextHistory;
    sourceRef.current = nextValue;
    setHistory(nextHistory);
    setSource(nextValue);
    setCopied(false);
    setStatus("Redid the renderer-local draft change.");
  };

  const applyFormatting = (action: FormattingAction) => {
    const editor = editorRef.current;
    const current = sourceRef.current;
    const selection = {
      start: editor?.selectionStart ?? current.length,
      end: editor?.selectionEnd ?? current.length,
    };
    let result: { source: string; selection: SelectionRange };
    if (action === "bold") result = selectedRange(current, selection, "**");
    else if (action === "italic") result = selectedRange(current, selection, "*");
    else if (action === "heading") result = prefixedLines(current, selection, "# ");
    else if (action === "bullet") result = prefixedLines(current, selection, "- ");
    else if (action === "checklist") result = checklistLines(current, selection);
    else if (action === "ordered") result = orderedLines(current, selection);
    else if (action === "quote") result = prefixedLines(current, selection, "> ");
    else if (action === "code") result = blockSnippet(current, selection, "```text", "```", "code");
    else if (action === "math") result = blockSnippet(current, selection, "$$", "$$", "x^2 + y^2 = z^2");
    else if (action === "table") result = tableSnippet(current, selection);
    else if (action === "divider") result = dividerSnippet(current, selection);
    else result = mediaSnippet(current, selection, action);
    commitSource(result.source, `Applied ${action} formatting locally; no native revision was created.`, result.selection);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      applyFormatting("bold");
      return;
    }
    if (modifier && event.key.toLowerCase() === "i") {
      event.preventDefault();
      applyFormatting("italic");
      return;
    }
    if (modifier && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      undoDraft();
      return;
    }
    if (modifier && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
      event.preventDefault();
      redoDraft();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    const editor = event.currentTarget;
    if (editor.selectionStart !== editor.selectionEnd) return;
    const current = sourceRef.current;
    const caret = editor.selectionStart;
    const lineStart = current.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    const linePrefix = current.slice(lineStart, caret);
    const match = linePrefix.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
    if (!match) return;
    event.preventDefault();
    const indent = match[1] ?? "";
    const marker = match[2] ?? "-";
    const body = match[3] ?? "";
    const checklist = body.match(/^\[[ xX]\]\s*(.*)$/);
    const checklistBody = checklist?.[1] ?? null;
    if (!body.trim() || (checklist !== null && !checklistBody?.trim())) {
      const next = `${current.slice(0, lineStart)}${indent}\n${current.slice(caret)}`;
      commitSource(next, "Exited the empty Markdown list locally.", { start: lineStart + indent.length, end: lineStart + indent.length });
      return;
    }
    const nextMarker = /^\d/.test(marker)
      ? `${Number.parseInt(marker, 10) + 1}${marker.endsWith(")") ? ")" : "."} `
      : `${marker} `;
    const insertion = `\n${indent}${nextMarker}${checklist ? "[ ] " : ""}`;
    const next = `${current.slice(0, caret)}${insertion}${current.slice(caret)}`;
    const nextCaret = caret + insertion.length;
    commitSource(next, "Continued the Markdown list locally.", { start: nextCaret, end: nextCaret });
  };

  const portablePayload = useMemo(() => {
    const input = {
      artifactName: artifact.name,
      projectName: artifact.projectName,
      revision,
      content: source,
    };
    return portableFormat === "json"
      ? serializeArtifactDocumentBundle(input)
      : serializeArtifactDocumentMarkdown(input);
  }, [artifact.name, artifact.projectName, portableFormat, revision, source]);

  const copyDraft = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no draft was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setStatus("Copied the renderer-local draft; no native artifact was changed.");
    } catch {
      setStatus("Clipboard write failed; no native artifact was changed.");
    }
  };

  const copyPortable = async () => {
    if (!navigator.clipboard?.writeText) {
      setStatus("Clipboard is unavailable; no portable payload was copied.");
      return;
    }
    try {
      await navigator.clipboard.writeText(portablePayload);
      setStatus(`Copied the portable ${portableFormat === "json" ? "JSON bundle" : "Markdown draft"}; no native artifact was changed.`);
    } catch {
      setStatus("Clipboard write failed; no portable payload was copied.");
    }
  };

  const resetDraft = () => {
    const nextHistory: EditorHistory = { past: [], future: [] };
    historyRef.current = nextHistory;
    sourceRef.current = baseline;
    setHistory(nextHistory);
    setSource(baseline);
    setCopied(false);
    setStatus("Draft reset to the selected revision preview; local history was cleared.");
    restoreSelection({ start: 0, end: 0 });
  };

  const saveCheckpoint = () => {
    checkpointSequenceRef.current += 1;
    const sequence = checkpointSequenceRef.current;
    const label = checkpointName.trim() || `Checkpoint ${sequence}`;
    const checkpoint: DraftCheckpoint = {
      id: `draft-checkpoint-${sequence}`,
      label,
      source: sourceRef.current,
      sequence,
    };
    setCheckpoints((current) => [...current, checkpoint].slice(-12));
    setCheckpointName("");
    setStatus(`Saved renderer-local checkpoint “${label}”; no native revision was created.`);
  };

  const restoreCheckpoint = (checkpoint: DraftCheckpoint) => {
    commitSource(checkpoint.source, `Restored renderer-local checkpoint “${checkpoint.label}”; no native revision was created.`);
  };

  const clearCheckpoints = () => {
    if (checkpoints.length === 0) {
      setStatus("No renderer-local checkpoints to clear.");
      return;
    }
    setCheckpoints([]);
    setStatus("Cleared renderer-local checkpoints; no native artifact was changed.");
  };

  const selectedReviewRange = (): SelectionRange => {
    const editor = editorRef.current;
    const current = sourceRef.current;
    const selectionStart = editor?.selectionStart ?? current.length;
    const selectionEnd = editor?.selectionEnd ?? selectionStart;
    if (selectionEnd > selectionStart) return { start: selectionStart, end: selectionEnd };
    const lineStart = current.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const lineEnd = current.indexOf("\n", selectionStart);
    const end = lineEnd === -1 ? current.length : lineEnd;
    return { start: lineStart, end: Math.max(lineStart, end) };
  };

  const addReviewNote = () => {
    const label = annotationNote.trim();
    if (!label) {
      setStatus("Enter a review note before adding a renderer-local annotation.");
      return;
    }
    const range = selectedReviewRange();
    const quote = sourceRef.current.slice(range.start, range.end).trim() || "Cursor position";
    annotationSequenceRef.current += 1;
    const sequence = annotationSequenceRef.current;
    const annotation: DraftAnnotation = {
      id: `draft-annotation-${sequence}`,
      label,
      quote,
      start: range.start,
      end: range.end,
      sequence,
    };
    setAnnotations((current) => [...current, annotation].slice(-24));
    setAnnotationNote("");
    setStatus(`Added renderer-local review note “${label}”; no native artifact was changed.`);
  };

  const focusReviewNote = (annotation: DraftAnnotation) => {
    if (layout === "rendered") setLayout("split");
    const focus = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const start = Math.max(0, Math.min(annotation.start, sourceRef.current.length));
      const end = Math.max(start, Math.min(annotation.end, sourceRef.current.length));
      editor.focus();
      editor.setSelectionRange(start, end);
      setStatus(`Focused review note “${annotation.label}” in the renderer-local draft.`);
    };
    if (layout === "rendered") setTimeout(focus, 0);
    else focus();
  };

  const removeReviewNote = (annotation: DraftAnnotation) => {
    setAnnotations((current) => current.filter((candidate) => candidate.id !== annotation.id));
    setStatus(`Removed renderer-local review note “${annotation.label}”.`);
  };

  const clearReviewNotes = () => {
    if (annotations.length === 0) {
      setStatus("No renderer-local review notes to clear.");
      return;
    }
    setAnnotations([]);
    setStatus("Cleared renderer-local review notes; no native artifact was changed.");
  };

  const addSection = () => {
    const next = `${sourceRef.current.trimEnd()}\n\n## New section\n\nAdd renderer-local notes here.`;
    commitSource(next, "Added a renderer-local section; no revision was created.");
  };

  const focusMatch = (start: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(start, start + findQuery.length);
  };

  const findNext = () => {
    if (!findQuery) {
      setStatus("Enter text to find in this renderer-local draft.");
      return;
    }
    if (findMatches.length === 0) {
      setStatus(`No matches for “${findQuery}”.`);
      return;
    }
    const cursor = editorRef.current?.selectionEnd ?? -1;
    const next = findMatches.find((match) => match > cursor) ?? findMatches[0];
    if (next === undefined) return;
    focusMatch(next);
    const position = findMatches.indexOf(next) + 1;
    setStatus(`Match ${position} of ${findMatches.length} for “${findQuery}”.`);
  };

  const replaceCurrent = () => {
    if (!findQuery) {
      setStatus("Enter text to find before replacing.");
      return;
    }
    const editor = editorRef.current;
    const selectedStart = editor?.selectionStart ?? -1;
    const selectedEnd = editor?.selectionEnd ?? -1;
    const selected = selectedStart >= 0 && selectedEnd >= selectedStart
      ? sourceRef.current.slice(selectedStart, selectedEnd)
      : "";
    const start = selected === findQuery
      ? selectedStart
      : (findMatches[0] ?? -1);
    if (start < 0) {
      setStatus(`No matches for “${findQuery}”.`);
      return;
    }
    const next = `${sourceRef.current.slice(0, start)}${replaceQuery}${sourceRef.current.slice(start + findQuery.length)}`;
    commitSource(next, `Replaced one match locally; no native revision was created.`, {
      start,
      end: start + replaceQuery.length,
    });
  };

  const replaceAll = () => {
    if (!findQuery) {
      setStatus("Enter text to find before replacing.");
      return;
    }
    if (findMatches.length === 0) {
      setStatus(`No matches for “${findQuery}”.`);
      return;
    }
    const next = sourceRef.current.split(findQuery).join(replaceQuery);
    const count = findMatches.length;
    commitSource(next, `Replaced ${count} matches locally; no native revision was created.`);
  };

  const downloadDraft = () => {
    const extension = portableFormat === "json" ? "json" : "md";
    const downloaded = browserDownload(portablePayload, `${artifactTitle(artifact)}-preview-v${revision}.${extension}`, portableFormat);
    setStatus(downloaded
      ? `Started a browser download of the ${portableFormat === "json" ? "JSON bundle" : "Markdown draft"} preview.`
      : "Browser download is unavailable; no file was written.");
  };

  const importDraft = async (file: File) => {
    try {
      const raw = typeof file.text === "function"
        ? await file.text()
        : await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
            reader.onerror = () => reject(reader.error ?? new Error("The selected document could not be read."));
            reader.readAsText(file);
          });
      const result = importArtifactDocument(raw);
      if (!result.ok) throw new Error(result.errors.join(" "));
      const sourceLabel = result.source === "json"
        ? "JSON bundle"
        : result.source === "markdown"
          ? "portable Markdown draft"
          : "plain Markdown draft";
      const identityNote = result.bundle.artifactName !== artifact.name
        ? " The source artifact differs; it was applied only to this renderer preview."
        : "";
      commitSource(result.bundle.content, `Imported ${sourceLabel}.${identityNote} No native revision was created.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Artifact document could not be imported.");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const jumpToHeading = (entry: OutlineEntry) => {
    if (layout === "rendered") setLayout("split");
    const focusHeading = () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(entry.start, entry.start);
      setStatus(`Focused “${entry.label}” in the renderer-local draft.`);
    };
    if (layout === "rendered") setTimeout(focusHeading, 0);
    else focusHeading();
  };

  const focusStructureBlock = (block: StructureBlock) => {
    if (layout === "rendered") setLayout("split");
    const focusBlock = () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(block.start, block.start);
      setStatus(`Focused ${block.label.toLowerCase()} in the renderer-local draft.`);
    };
    if (layout === "rendered") setTimeout(focusBlock, 0);
    else focusBlock();
  };

  return (
    <section className="artifact-document-studio" aria-label={`Document studio preview for ${artifact.name}`}>
      <header className="artifact-document-studio__header">
        <div>
          <span className="eyebrow">Document studio</span>
          <h3>{artifact.name}</h3>
          <p>Revision {revision} · renderer-local draft · {artifact.projectName}</p>
        </div>
        <span className="artifact-document-studio__badge"><WandSparkles size={13} /> Preview only</span>
      </header>

      <div className="artifact-document-studio__toolbar" role="toolbar" aria-label="Document studio actions">
        <label>
          <span>View</span>
          <select value={layout} onChange={(event) => setLayout(event.target.value as StudioLayout)} aria-label="Document studio view">
            <option value="split">Split editor</option>
            <option value="editor">Editor only</option>
            <option value="rendered">Rendered only</option>
          </select>
        </label>
        <button type="button" className="button button--ghost" onClick={addSection}><LayoutPanelLeft size={14} /> Add section</button>
        <button type="button" className="button button--ghost" onClick={resetDraft}><RotateCcw size={14} /> Reset</button>
        <label className="artifact-document-studio__format">
          <span>Portable format</span>
          <select aria-label="Artifact document portable format" value={portableFormat} onChange={(event) => setPortableFormat(event.target.value as ArtifactDocumentPortableFormat)}>
            <option value="markdown">Markdown</option>
            <option value="json">JSON bundle</option>
          </select>
        </label>
        <button type="button" className="button button--secondary" onClick={() => void copyDraft()}>{copied ? <Check size={14} /> : <Clipboard size={14} />} {copied ? "Copied" : "Copy draft"}</button>
        <button type="button" className="button button--ghost" onClick={() => void copyPortable()}><FileJson size={14} /> Copy portable</button>
        <button type="button" className="button button--secondary" onClick={downloadDraft} title={`Download ${portableFormat === "json" ? "JSON" : "Markdown"} artifact draft`}><Download size={14} /> Download</button>
        <button type="button" className="button button--ghost" onClick={() => importInputRef.current?.click()}><Upload size={14} /> Import</button>
        <input
          ref={importInputRef}
          className="sr-only"
          type="file"
          accept="application/json,text/markdown,text/plain,.json,.md,.markdown,.txt"
          aria-label="Import artifact document"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importDraft(file);
          }}
        />
      </div>

      <div className="artifact-document-studio__metrics" aria-label="Draft metrics">
        <span><strong>{metrics.words}</strong> words</span>
        <span><strong>{metrics.characters}</strong> characters</span>
        <span><strong>{outline.length}</strong> outline entries</span>
        <span><strong>{annotations.length}</strong> review notes</span>
        <span className={dirty ? "is-dirty" : ""}>{dirty ? "Draft edited" : "Revision baseline"}</span>
      </div>

      <ArtifactAtomicHandoffPreview artifact={artifact} revision={revision} />

      <section className="artifact-document-studio__checkpoints" aria-label="Renderer-local draft checkpoints">
        <div className="artifact-document-studio__section-heading"><Clock3 size={14} /><strong>Draft checkpoints</strong><span>{checkpoints.length}/12 · session only</span></div>
        <div className="artifact-document-studio__checkpoint-create">
          <label>
            <span>Checkpoint name</span>
            <input
              aria-label="Checkpoint name"
              value={checkpointName}
              onChange={(event) => setCheckpointName(event.target.value)}
              placeholder="e.g. before methods rewrite"
              maxLength={80}
            />
          </label>
          <button type="button" className="button button--secondary" onClick={saveCheckpoint}>Save checkpoint</button>
          <button type="button" className="button button--ghost" aria-label="Clear checkpoints" onClick={clearCheckpoints} disabled={checkpoints.length === 0}>Clear</button>
        </div>
        {checkpoints.length > 0 ? (
          <ol className="artifact-document-studio__checkpoint-list">
            {checkpoints.map((checkpoint) => (
              <li key={checkpoint.id}>
                <span>
                  <strong>{checkpoint.label}</strong>
                  <small>{plainTextMetrics(checkpoint.source).words} words · local checkpoint {checkpoint.sequence}</small>
                </span>
                <button type="button" className="button button--ghost" aria-label={`Restore checkpoint ${checkpoint.label}`} onClick={() => restoreCheckpoint(checkpoint)}>Restore</button>
              </li>
            ))}
          </ol>
        ) : <p className="artifact-document-studio__checkpoint-empty">Save a named draft state before a risky rewrite. Checkpoints are renderer-local and disappear when this preview closes.</p>}
      </section>

      <section className="artifact-document-studio__annotations" aria-label="Renderer-local review notes">
        <div className="artifact-document-studio__section-heading"><MessageSquarePlus size={14} /><strong>Review notes</strong><span>{annotations.length}/24 · session only</span></div>
        <div className="artifact-document-studio__annotation-create">
          <label>
            <span>Review note</span>
            <input
              aria-label="Review note"
              value={annotationNote}
              onChange={(event) => setAnnotationNote(event.target.value)}
              placeholder="e.g. Verify this source claim"
              maxLength={160}
            />
          </label>
          <span className="artifact-document-studio__annotation-selection">
            Select text in the draft, or leave the caret on a line to anchor this note.
          </span>
          <button type="button" className="button button--secondary" onClick={addReviewNote}><MessageSquarePlus size={14} /> Add note</button>
          <button type="button" className="button button--ghost" aria-label="Clear review notes" onClick={clearReviewNotes} disabled={annotations.length === 0}>Clear</button>
        </div>
        {annotations.length > 0 ? (
          <ol className="artifact-document-studio__annotation-list">
            {annotations.map((annotation) => {
              const currentQuote = source.slice(annotation.start, annotation.end).trim();
              const anchorChanged = currentQuote !== annotation.quote;
              return (
                <li key={annotation.id}>
                  <div>
                    <strong>{annotation.label}</strong>
                    <small>
                      {anchorChanged ? "Anchor changed after a draft edit" : `Anchored to “${annotation.quote}”`}
                    </small>
                  </div>
                  <span>
                    <button type="button" className="button button--ghost" aria-label={`Focus review note ${annotation.label}`} onClick={() => focusReviewNote(annotation)}>Focus</button>
                    <button type="button" className="button button--ghost" aria-label={`Remove review note ${annotation.label}`} onClick={() => removeReviewNote(annotation)}>Remove</button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="artifact-document-studio__annotation-empty">Add a local note to keep a question or follow-up beside a draft passage. Notes are not embedded in the artifact and disappear when this preview closes.</p>
        )}
      </section>

      <div className={`artifact-document-studio__body artifact-document-studio__body--${layout}`}>
        <aside className="artifact-document-studio__outline" aria-label="Document outline">
          <div className="artifact-document-studio__section-heading"><FileText size={14} /><strong>Outline</strong></div>
          {outline.length > 0 ? (
            <ol>
              {outline.map((entry) => (
                <li key={entry.id} style={{ paddingInlineStart: `${(entry.level - 1) * 10}px` }}>
                  <button type="button" aria-label={`Go to heading ${entry.label}`} onClick={() => jumpToHeading(entry)}>{entry.label}</button>
                </li>
              ))}
            </ol>
          ) : <p>No headings yet. Add one with Markdown `#` syntax.</p>}
          <section className="artifact-document-studio__structure" aria-label="Document structure">
            <div className="artifact-document-studio__section-heading"><LayoutPanelLeft size={14} /><strong>Structure</strong><span>{structure.length} blocks</span></div>
            <label className="artifact-document-studio__structure-filter">
              <span>Show</span>
              <select aria-label="Structure block filter" value={structureFilter} onChange={(event) => setStructureFilter(event.target.value as StructureFilter)}>
                <option value="all">All blocks</option>
                <option value="headings">Headings</option>
                <option value="content">Text & quotes</option>
                <option value="lists">Lists</option>
                <option value="code">Code</option>
                <option value="math">Math</option>
                <option value="media">Media</option>
                <option value="tables">Tables</option>
              </select>
            </label>
            {visibleStructure.length > 0 ? (
              <ol className="artifact-document-studio__structure-list">
                {visibleStructure.map((block) => (
                  <li key={block.id}>
                    <button type="button" aria-label={`Focus ${block.label}`} onClick={() => focusStructureBlock(block)}>
                      <span>{block.label}</span><small>{block.detail}</small>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="artifact-document-studio__structure-empty">No blocks match this filter.</p>}
          </section>
          <div className="artifact-document-studio__boundary">
            <SplitSquareHorizontal size={14} />
            <span><strong>Safe preview boundary</strong><small>Edits stay in this renderer session. Native artifact bytes, hashes, version mutation, and export receipts remain planned.</small></span>
          </div>
        </aside>

        {layout !== "rendered" ? (
          <div className="artifact-document-studio__editor">
            <div className="artifact-document-studio__section-heading"><FileText size={14} /><strong>Draft source</strong><span>Markdown shortcuts</span></div>
            <div className="artifact-document-studio__editor-toolbar" role="toolbar" aria-label="Draft formatting tools">
              <div className="artifact-document-studio__editor-tool-group" role="group" aria-label="Inline formatting">
                <button type="button" className="button button--ghost" aria-label="Bold selection" title="Bold (Ctrl+B)" onClick={() => applyFormatting("bold")}><Bold size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Italic selection" title="Italic (Ctrl+I)" onClick={() => applyFormatting("italic")}><Italic size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Heading" title="Heading" onClick={() => applyFormatting("heading")}><Type size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Quote" title="Quote" onClick={() => applyFormatting("quote")}><Quote size={14} /></button>
              </div>
              <div className="artifact-document-studio__editor-tool-group" role="group" aria-label="List formatting">
                <button type="button" className="button button--ghost" aria-label="Bullet list" title="Bullet list" onClick={() => applyFormatting("bullet")}><List size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Checklist" title="Checklist" onClick={() => applyFormatting("checklist")}><ListChecks size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Numbered list" title="Numbered list" onClick={() => applyFormatting("ordered")}><ListOrdered size={14} /></button>
              </div>
              <div className="artifact-document-studio__editor-tool-group" role="group" aria-label="Block inserts">
                <button type="button" className="button button--ghost" aria-label="Code block" title="Code block" onClick={() => applyFormatting("code")}><Code2 size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Math block" title="LaTeX math block" onClick={() => applyFormatting("math")}><Sigma size={14} aria-hidden="true" /></button>
                <button type="button" className="button button--ghost" aria-label="Table starter" title="Markdown table starter" onClick={() => applyFormatting("table")}><Table2 size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Horizontal rule" title="Horizontal rule" onClick={() => applyFormatting("divider")}><Minus size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Image reference" title="Image reference (no network fetch)" onClick={() => applyFormatting("image")}><ImageIcon size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Video reference" title="Video reference (no network fetch)" onClick={() => applyFormatting("video")}><Video size={14} aria-hidden="true" /></button>
              </div>
              <div className="artifact-document-studio__editor-tool-group" role="group" aria-label="Draft history">
                <button type="button" className="button button--ghost" aria-label="Undo draft" title="Undo draft (Ctrl+Z)" disabled={history.past.length === 0} onClick={undoDraft}><Undo2 size={14} /></button>
                <button type="button" className="button button--ghost" aria-label="Redo draft" title="Redo draft (Ctrl+Y)" disabled={history.future.length === 0} onClick={redoDraft}><Redo2 size={14} /></button>
              </div>
            </div>
            <div className="artifact-document-studio__findbar" role="search" aria-label="Find and replace in draft">
              <label>
                <span>Find</span>
                <input
                  aria-label="Find in draft"
                  value={findQuery}
                  onChange={(event) => setFindQuery(event.target.value)}
                  placeholder="Search this draft"
                />
              </label>
              <label>
                <span>Replace</span>
                <input
                  aria-label="Replace in draft"
                  value={replaceQuery}
                  onChange={(event) => setReplaceQuery(event.target.value)}
                  placeholder="Replacement text"
                />
              </label>
              <span className="artifact-document-studio__find-count" aria-live="polite">
                {findQuery ? `${findMatches.length} ${findMatches.length === 1 ? "match" : "matches"}` : "Type to search"}
              </span>
              <button type="button" className="button button--ghost" onClick={findNext} aria-label="Find next match"><Search size={14} /> Find next</button>
              <button type="button" className="button button--ghost" onClick={replaceCurrent} aria-label="Replace current match">Replace</button>
              <button type="button" className="button button--ghost" onClick={replaceAll} aria-label="Replace all matches">Replace all</button>
            </div>
            <textarea
              ref={editorRef}
              id="artifact-draft-editor"
              value={source}
              onChange={(event) => commitSource(event.target.value, "Draft changed locally; no native revision was created.")}
              onKeyDown={handleEditorKeyDown}
              aria-label="Artifact draft editor"
              spellCheck={false}
            />
            <small className="artifact-document-studio__editor-hint">Enter continues Markdown lists. Shift+Enter inserts a plain line break. Formatting and history stay in this renderer session.</small>
          </div>
        ) : null}

        {layout !== "editor" ? (
          <article className="artifact-document-studio__rendered" aria-label="Rendered document preview">
            <div className="artifact-document-studio__section-heading"><FileText size={14} /><strong>Rendered preview</strong><span>deterministic local rendering</span></div>
            <div className="artifact-document-studio__rendered-content">{rendered}</div>
          </article>
        ) : null}
      </div>

      <p className="artifact-document-studio__status" role="status" aria-label="Document studio status" aria-live="polite">{status}</p>
      <details className="artifact-document-studio__portable-preview">
        <summary><FileJson size={13} /> Preview portable {portableFormat === "json" ? "JSON" : "Markdown"} payload</summary>
        <pre><code>{portablePayload}</code></pre>
        <small>Import/export is browser-session only; no native artifact bytes, revision, hash, or receipt is created.</small>
      </details>
    </section>
  );
}
