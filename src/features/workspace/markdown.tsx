import { MessageSquareText, Quote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { normalizeExternalHttpUrl } from "@/lib/external-url";
import { captureTextSelection, type CapturedTextSelection } from "./selection-reference-surface";
import { setWorkspaceSurface } from "./workspace-mode-switcher";

import "@/styles/review-message-content.css";

export interface CodeBlockLocation {
  language: string;
  filename?: string | undefined;
  lineRange?: string | undefined;
}

export interface MessageMarkdownProps {
  content: string;
  streaming?: boolean;
  /** Used only when the fenced block itself does not include a file locator. */
  filename?: string | undefined;
  lineRange?: string | undefined;
  /** An explicit editor operation supplied by the IDE host, never a synthetic patch. */
  onApplyCode?: ((code: string) => void) | undefined;
  applyLabel?: string | undefined;
  onOpenInIde?: (code: string, location: CodeBlockLocation) => void;
  /**
   * Keep the conversation renderer's default source-faithful behavior, while
   * allowing the composer to opt into a small renderer-local inline LaTeX
   * approximation. This never invokes a TeX engine or changes the Markdown
   * source that would be sent to a provider.
   */
  renderInlineMath?: boolean;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeHtml(value: string): string {
  if (typeof document === "undefined") {
    return value
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(?:x27|39);/gi, "'");
  }
  const element = document.createElement("textarea");
  element.innerHTML = value;
  return element.value;
}

const LANGUAGE_KEYWORDS: Record<string, ReadonlySet<string>> = {
  javascript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield".split(" ")),
  typescript: new Set("abstract any as asserts async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of package private protected public readonly require return set static string super switch symbol this throw try type typeof undefined unique unknown var void while with yield".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  css: new Set("important media supports layer container keyframes from to".split(" ")),
  bash: new Set("case coproc do done elif else esac eval fi for function if in select then time until while".split(" ")),
  rust: new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
  cpp: new Set("alignas alignof asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_cast struct switch template this throw true try typedef typename union unsigned using virtual void volatile wchar_t while".split(" ")),
  java: new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true false try void volatile while".split(" ")),
  go: new Set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" ")),
  sql: new Set("select from where join left right inner outer full on as insert into values update set delete create table alter drop index primary key references group by order having limit offset distinct union all and or not null true false in exists case when then else end asc desc with returning".split(" ")),
};

const TYPE_WORDS = new Set("any bigint bool boolean byte char double f32 f64 float i8 i16 i32 i64 i128 int isize long never number object short str string symbol u8 u16 u32 u64 u128 uint unknown usize void".split(" "));

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  css: "css",
  json: "json",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  py: "python",
  python: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  rs: "rust",
  rust: "rust",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  "c++": "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "java",
  csharp: "java",
  java: "java",
  go: "go",
  sql: "sql",
};

function codeTokenPattern(language: string): RegExp {
  const normalized = LANGUAGE_ALIASES[language.toLowerCase()] ?? "text";
  const comment = normalized === "python" || normalized === "bash"
    ? "(?<comment>#[^\\n]*)"
    : normalized === "sql"
      ? "(?<comment>--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)"
    : normalized === "css"
      ? "(?<comment>\\/\\*[\\s\\S]*?\\*\\/)"
      : normalized === "json"
        ? "(?!)"
        : "(?<comment>\\/\\/[\\s\\S]*?$|\\/\\*[\\s\\S]*?\\*\\/)";
  const string = "(?<string>\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)";
  const number = "(?<number>\\b(?:0[xX][\\da-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)";
  const keyword = normalized === "json" ? "(?!)" : "(?<keyword>\\b[A-Za-z_$][\\w$]*\\b)";
  return new RegExp(`${comment}|${string}|${number}|${keyword}`, "gm");
}

/**
 * Adds small, dependency-free syntax cues to common fenced-code languages.
 * micromark has already HTML-escaped the code payload; decode it to plain
 * text and escape every emitted fragment again so user code stays inert.
 */
function highlightCode(encodedCode: string, language: string): string {
  const source = decodeHtml(encodedCode);
  const normalized = LANGUAGE_ALIASES[language.toLowerCase()] ?? "text";
  const keywords = LANGUAGE_KEYWORDS[normalized];
  const tokenPattern = codeTokenPattern(normalized);
  let cursor = 0;
  let output = "";

  const appendPlain = (value: string) => {
    if (normalized === "json") {
      const jsonString = /("(?:\\\\.|[^"\\\\])*")(?=\\s*:)/g;
      let stringCursor = 0;
      for (const match of value.matchAll(jsonString)) {
        const index = match.index ?? 0;
        output += escapeAttribute(value.slice(stringCursor, index));
        output += `<span class="syntax-property">${escapeAttribute(match[0])}</span>`;
        stringCursor = index + match[0].length;
      }
      output += escapeAttribute(value.slice(stringCursor));
      return;
    }
    output += escapeAttribute(value);
  };

  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    appendPlain(source.slice(cursor, index));
    let tokenClass: string | undefined;
    if (match.groups?.comment !== undefined) tokenClass = "syntax-comment cmt";
    else if (match.groups?.string !== undefined) {
      tokenClass = normalized === "json" && /^\s*:/.test(source.slice(index + token.length))
        ? "syntax-property str"
        : "syntax-string str";
    }
    else if (match.groups?.number !== undefined) tokenClass = "syntax-number num";
    else if (match.groups?.keyword !== undefined) {
      const word = match.groups.keyword;
      if (TYPE_WORDS.has(word) && normalized !== "json") tokenClass = "syntax-type ty";
      else if (keywords?.has(normalized === "sql" ? word.toLowerCase() : word)) tokenClass = "syntax-keyword kw";
      else if (/^[$A-Z_a-z][$\w]*$/.test(word) && /^\s*(?:=\s*)?\(/.test(source.slice(index + token.length))) {
        tokenClass = "syntax-function fn";
      }
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word) && normalized !== "text" && normalized !== "json") tokenClass = "syntax-type ty";
    }
    output += tokenClass
      ? `<span class="${tokenClass}">${escapeAttribute(token)}</span>`
      : escapeAttribute(token);
    cursor = index + token.length;
  }
  appendPlain(source.slice(cursor));
  return output;
}

function decorateLinks(html: string): string {
  return html.replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_match, rawHref: string, children: string) => {
    const safeHref = normalizeExternalHttpUrl(decodeHtml(rawHref));
    if (!safeHref) return `<span class="unsafe-external-link">${children}</span>`;
    return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">${children}<span aria-hidden="true" class="markdown-external-link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 7h10v10M7 17 17 7"/></svg></span></a>`;
  });
}

const codeIcon = (paths: string) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const CODE_FILE_ICON = codeIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6m-10 5-2 2 2 2m4-4 2 2-2 2"/>');
const CODE_TS_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="1" y="1" width="14" height="14" rx="3" fill="#3178c6"/><path d="M4.2 6.2h4.4M6.4 6.2v5.6M12.7 7.1c-.3-.5-.9-.8-1.6-.8-.9 0-1.5.5-1.5 1.2 0 1.5 3.1.9 3.1 2.6 0 .8-.7 1.3-1.7 1.3-.8 0-1.4-.3-1.8-.9" stroke="#ffffff" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CODE_JS_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="1" y="1" width="14" height="14" rx="3" fill="#eab308"/><path d="M7.2 6.2v4.1c0 .9-.6 1.4-1.4 1.4-.6 0-1.1-.3-1.3-.8M12.7 7.1c-.3-.5-.9-.8-1.6-.8-.9 0-1.5.5-1.5 1.2 0 1.5 3.1.9 3.1 2.6 0 .8-.7 1.3-1.7 1.3-.8 0-1.4-.3-1.8-.9" stroke="#111318" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CODE_RS_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(251, 146, 60, 0.18)" stroke="#fb923c" stroke-width="1.3"/><circle cx="8" cy="8" r="3.2" stroke="#fb923c" stroke-width="1.4"/><path d="M8 3.2v1.4M8 11.4v1.4M3.2 8h1.4M11.4 8h1.4" stroke="#fb923c" stroke-width="1.4" stroke-linecap="round"/></svg>';
const CODE_JSON_ICON = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="1" y="1" width="14" height="14" rx="3" fill="rgba(250, 204, 21, 0.15)" stroke="#facc15" stroke-width="1.25"/><path d="M6.2 4.5c-1 0-1.4.5-1.4 1.3v1.1c0 .6-.4 1.1-1 1.1.6 0 1 .5 1 1.1v1.1c0 .8.4 1.3 1.4 1.3M9.8 4.5c1 0 1.4.5 1.4 1.3v1.1c0 .6.4 1.1 1 1.1-.6 0-1 .5-1 1.1v1.1c0 .8-.4 1.3-1.4 1.3" stroke="#facc15" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CODE_IDE_ICON = codeIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11m5-7-2 2 2 2m3-4 2 2-2 2"/>');
const CODE_APPLY_ICON = codeIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6m-11 7 2 2 4-4"/>');
const CODE_COPY_ICON = codeIcon('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>');
const CODE_COPIED_ICON = codeIcon('<path d="m5 12 4 4L19 6"/>');

function codeFileIconFor(filename: string | undefined, language: string): string {
  const normLang = LANGUAGE_ALIASES[language.toLowerCase()] ?? language.toLowerCase();
  const cleanFile = (filename ?? "").toLowerCase();
  if (normLang === "typescript" || /\.[cm]?tsx?$/.test(cleanFile)) return CODE_TS_ICON;
  if (normLang === "javascript" || /\.[cm]?jsx?$/.test(cleanFile)) return CODE_JS_ICON;
  if (normLang === "rust" || /\.rs$/.test(cleanFile)) return CODE_RS_ICON;
  if (normLang === "json" || /\.(?:json|toml|ya?ml)$/.test(cleanFile)) return CODE_JSON_ICON;
  return CODE_FILE_ICON;
}

function languageFromFilename(filename: string): string {
  return LANGUAGE_ALIASES[filename.split(".").at(-1)?.toLowerCase() ?? ""] ?? "text";
}

function parseCodeLocation(info: string): CodeBlockLocation {
  const first = info.trim().split(/\s+/)[0] ?? "";
  const language = LANGUAGE_ALIASES[first.toLowerCase()] ?? (first.includes(".") ? languageFromFilename(first.replace(/:\d.*$/, "")) : first || "text");
  const explicitFilename = /(?:filename|file|title)=["']([^"']+)["']|(?:filename|file|title)=([^\s]+)/.exec(info);
  const path = explicitFilename?.[1] ?? explicitFilename?.[2]
    ?? info.split(/\s+/).find((part) => /(?:^|[/\\])[\w.@-]+(?:[/\\][\w.@-]+)*\.[a-z][a-z0-9]*(?::\d+(?:[-–]\d+)?)?$/i.test(part));
  const fileMatch = path ? /^(.*?)(?::(\d+(?:[-–]\d+)?))?$/.exec(path) : null;
  const lineRange = /(?:lines|line)=["']?(\d+(?:[-–]\d+)?)/.exec(info)?.[1] ?? fileMatch?.[2];
  return {
    language,
    ...(fileMatch?.[1] ? { filename: fileMatch[1] } : {}),
    ...(lineRange ? { lineRange } : {}),
  };
}

/** Match by source rather than block index, so indented code cannot shift file labels. */
function fencedCodeLocations(content: string): { source: string; location: CodeBlockLocation }[] {
  const result: { source: string; location: CodeBlockLocation }[] = [];
  let fence: string | null = null;
  let info = "";
  let lines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
      if (close.test(line)) {
        result.push({ source: lines.join("\n"), location: parseCodeLocation(info) });
        fence = null;
      } else lines.push(line);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening) {
      fence = opening[1]!;
      info = opening[2] ?? "";
      lines = [];
    }
  }
  if (fence) result.push({ source: lines.join("\n").replace(/\n$/, ""), location: parseCodeLocation(info) });
  return result;
}

function decorateCodeBlocks(html: string, content: string, copiedBlock: number | null, options: Pick<MessageMarkdownProps, "filename" | "lineRange" | "onApplyCode" | "applyLabel">): string {
  const locations = fencedCodeLocations(content);
  let index = 0;
  return html.replace(/<pre><code(?: class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (_match, className: string | undefined, code: string) => {
    const blockIndex = index;
    index += 1;
    const source = decodeHtml(code).replace(/\n$/, "");
    const locationIndex = locations.findIndex((entry) => entry.source === source);
    const location = locationIndex >= 0 ? locations.splice(locationIndex, 1)[0]!.location : { language: className?.replace(/^language-/, "") || "text" };
    const language = location.language;
    const filename = location.filename ?? options.filename;
    const lineRange = location.lineRange ?? options.lineRange;
    const label = filename ? `${filename}${lineRange ? `:${lineRange}` : ""}` : language;
    const action = options.onApplyCode ? "apply" : "open-ide";
    const actionLabel = options.onApplyCode ? options.applyLabel ?? "Apply to editor" : "Open in IDE";
    const fileIconSvg = codeFileIconFor(filename, language);
    return [
      `<figure class="code-block" data-code-block-index="${blockIndex}" data-code-language="${escapeAttribute(language)}"${filename ? ` data-code-filename="${escapeAttribute(filename)}"` : ""}${lineRange ? ` data-code-lines="${escapeAttribute(lineRange)}"` : ""}>`,
      '<figcaption class="code-block__header" data-selection-exclude="true">',
      `<span class="code-block__filename" title="${escapeAttribute(label)}"><span class="code-block__file-icon" data-file-type="${escapeAttribute(language)}">${fileIconSvg}</span><span>${escapeAttribute(label)}</span></span>`,
      '<span class="code-block__actions">',
      `<button type="button" class="icon-button code-block__action" title="${escapeAttribute(actionLabel)}" aria-label="${escapeAttribute(actionLabel)}" data-markdown-action="${action}">${options.onApplyCode ? CODE_APPLY_ICON : CODE_IDE_ICON}</button>`,
      `<button type="button" class="icon-button code-block__action" title="Copy code" aria-label="Copy code" data-markdown-action="copy"${copiedBlock === blockIndex ? ' data-copied="true"' : ""}>${copiedBlock === blockIndex ? CODE_COPIED_ICON : CODE_COPY_ICON}</button>`,
      `</span></figcaption><pre><code class="language-${escapeAttribute(LANGUAGE_ALIASES[language.toLowerCase()] ?? language)}">${highlightCode(code, language)}</code></pre></figure>`,
    ].join("");
  });
}

const INLINE_MATH_PATTERN = /(?<![\\$])\$([^$\n]+)(?<!\\)\$(?!\$)|\\\(([^\n]+?)\\\)/g;

const INLINE_MATH_SYMBOLS: Record<string, string> = {
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

function formatInlineMath(source: string): string {
  let value = source
    .trim()
    .replace(/^\$\s*/, "")
    .replace(/\s*\$$/, "")
    .replace(/^\\\(\s*/, "")
    .replace(/\s*\\\)$/, "")
    .replace(/\s+/g, " ");
  value = value.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
  value = value.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
  value = value.replace(/([_^])\{([^{}]*)\}/g, "$1$2");
  return value.replace(/\\([A-Za-z]+)/g, (token, name: string) => INLINE_MATH_SYMBOLS[name] ?? token) || "(empty equation)";
}

function isMathExcludedElement(element: Element): boolean {
  return ["PRE", "CODE", "SCRIPT", "STYLE", "A", "BUTTON"].includes(element.tagName);
}

function collectInlineMathTextNodes(root: Node, nodes: Text[]): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      nodes.push(child as Text);
      continue;
    }
    if (child.nodeType === 1 && isMathExcludedElement(child as Element)) continue;
    collectInlineMathTextNodes(child, nodes);
  }
}

/**
 * Decorate only ordinary rendered text nodes so inline math remains inert in
 * code spans, links and generated code-block controls. The source remains in
 * the original Markdown string and is exposed on each chip for inspection.
 */
function decorateInlineMath(html: string): string {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const textNodes: Text[] = [];
  collectInlineMathTextNodes(template.content, textNodes);

  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? "";
    INLINE_MATH_PATTERN.lastIndex = 0;
    if (!INLINE_MATH_PATTERN.test(value)) continue;
    INLINE_MATH_PATTERN.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of value.matchAll(INLINE_MATH_PATTERN)) {
      const index = match.index ?? 0;
      if (index > cursor) fragment.append(document.createTextNode(value.slice(cursor, index)));
      const source = match[0];
      const chip = document.createElement("span");
      chip.className = "message-markdown__inline-math";
      chip.dataset.mathSource = source;
      chip.title = `Inline LaTeX approximation: ${source}`;
      chip.setAttribute("aria-label", `Inline LaTeX approximation: ${source}`);
      chip.textContent = formatInlineMath(source);
      fragment.append(chip);
      cursor = index + source.length;
    }
    if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)));
    textNode.replaceWith(fragment);
  }
  return template.innerHTML;
}

/**
 * micromark correctly treats the parenthesis in `\(...\)` as escapable
 * Markdown punctuation, so preserve those delimiter backslashes as entities
 * in ordinary prose before parsing. Fenced and inline code are deliberately
 * left byte-for-byte alone; the math decorator also skips their output nodes.
 */
function preserveInlineMathDelimiters(content: string): string {
  const lines = content.split("\n");
  let fenceMarker: "```" | "~~~" | null = null;
  return lines.map((line) => {
    const fence = line.match(/^\s{0,3}(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
    if (fenceMarker) {
      if (line.trim() === fenceMarker) fenceMarker = null;
      return line;
    }
    if (fence) {
      fenceMarker = fence;
      return line;
    }
    if (/^(?: {4,}|\t)/.test(line)) return line;
    let cursor = 0;
    let output = "";
    for (const match of line.matchAll(/(`+).*?\1/g)) {
      const index = match.index ?? 0;
      output += line.slice(cursor, index).replace(/\\([()])/g, "&#92;$1");
      output += match[0];
      cursor = index + match[0].length;
    }
    return output + line.slice(cursor).replace(/\\([()])/g, "&#92;$1");
  }).join("\n");
}

function renderInlineMarkdown(source: string): string {
  const codeSpans: string[] = [];
  const escapedChars: string[] = [];
  let text = source.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks: string, code: string) => {
    const id = codeSpans.length;
    codeSpans.push(`<code>${escapeAttribute(code)}</code>`);
    return `\u0000CODE_${id}\u0000`;
  });
  text = text.replace(/&#92;/g, "\u0000BS\u0000");
  text = text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, ch: string) => {
    const id = escapedChars.length;
    escapedChars.push(escapeAttribute(ch));
    return `\u0000ESC_${id}\u0000`;
  });
  text = escapeAttribute(text);
  text = text.replace(/&lt;(https?:\/\/[^&>]+)&gt;/g, '<a href="$1">$1</a>');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label: string, href: string) => {
    return `<a href="${href}">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<strong>${a ?? b ?? ""}</strong>`);
  text = text.replace(/\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)/g, (_m, a: string | undefined, b: string | undefined) => `<em>${a ?? b ?? ""}</em>`);
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  text = text.replace(/\u0000ESC_(\d+)\u0000/g, (_m, idx: string) => escapedChars[Number(idx)] ?? "");
  text = text.replace(/\u0000BS\u0000/g, "\\");
  text = text.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idx: string) => codeSpans[Number(idx)] ?? "");
  return text;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseTableAlignments(delimiterLine: string): string[] {
  return splitTableRow(delimiterLine).map((col) => {
    const trimmed = col.trim();
    if (/^:-+:$/.test(trimmed)) return ' align="center"';
    if (/^-+:$/.test(trimmed)) return ' align="right"';
    if (/^:-+$/.test(trimmed)) return ' align="left"';
    return "";
  });
}

function renderGfmMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const info = (fenceMatch[2] ?? "").trim();
      const first = info.split(/\s+/)[0] ?? "";
      const closeRe = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const body = escapeAttribute(codeLines.join("\n"));
      const langAttr = first ? ` class="language-${escapeAttribute(first)}"` : "";
      blocks.push(`<pre><code${langAttr}>${body}${codeLines.length > 0 ? "\n" : ""}</code></pre>`);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      const codeLines: string[] = [];
      while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]!) || !lines[i]!.trim())) {
        const current = lines[i]!;
        codeLines.push(current.startsWith("\t") ? current.slice(1) : current.replace(/^ {1,4}/, ""));
        i += 1;
      }
      while (codeLines.length > 0 && !codeLines[codeLines.length - 1]!.trim()) codeLines.pop();
      blocks.push(`<pre><code>${escapeAttribute(codeLines.join("\n"))}\n</code></pre>`);
      continue;
    }

    const headingMatch = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2]!)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line)) {
      blocks.push("<hr />");
      i += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^ {0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${renderGfmMarkdown(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1]!)
    ) {
      const headers = splitTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1]!);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      const headHtml = `<thead><tr>${headers.map((h, idx) => `<th${alignments[idx] ?? ""}>${renderInlineMarkdown(h)}</th>`).join("")}</tr></thead>`;
      const bodyHtml = rows.length
        ? `<tbody>${rows.map((r) => `<tr>${headers.map((_, idx) => `<td${alignments[idx] ?? ""}>${renderInlineMarkdown(r[idx] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      blocks.push(`<table>${headHtml}${bodyHtml}</table>`);
      continue;
    }

    const ulMatch = /^ {0,3}[-*+]\s+(.*)$/.exec(line);
    const olMatch = /^ {0,3}\d+\.\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const tag = isOrdered ? "ol" : "ul";
      const itemRe = isOrdered ? /^ {0,3}\d+\.\s+(.*)$/ : /^ {0,3}[-*+]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const match = itemRe.exec(lines[i]!);
        if (!match) break;
        let itemText = match[1]!;
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
        if (taskMatch) {
          const checked = taskMatch[1]!.toLowerCase() === "x" ? ' checked=""' : "";
          itemText = `<input type="checkbox" disabled=""${checked} /> ${renderInlineMarkdown(taskMatch[2]!)}`;
        } else {
          itemText = renderInlineMarkdown(itemText);
        }
        items.push(`<li>${itemText}</li>`);
        i += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^ {0,3}(?:`{3,}|~{3,}|#{1,6}\s|>|[-*+]\s|\d+\.\s)/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push(`<p>${renderInlineMarkdown(paraLines.join("\n"))}</p>`);
  }

  return blocks.join("\n");
}

function renderMarkdownHtml(content: string, copiedBlock: number | null, renderInlineMath: boolean, options: Pick<MessageMarkdownProps, "filename" | "lineRange" | "onApplyCode" | "applyLabel">): string {
  const source = renderInlineMath ? preserveInlineMathDelimiters(content) : content;
  const html = renderGfmMarkdown(source);
  const withMath = renderInlineMath ? decorateInlineMath(html) : html;
  return decorateCodeBlocks(decorateLinks(withMath), content, copiedBlock, options);
}

export const OPEN_CODE_IN_IDE_EVENT = "omnia:open-code-in-ide";
export interface OpenCodeInIdeRequest extends CodeBlockLocation { code: string }
let pendingIdeRequest: OpenCodeInIdeRequest | null = null;

/** Opening a file is a navigation request, never permission to apply its code. */
export function takePendingCodeInIdeRequest(): OpenCodeInIdeRequest | null {
  const request = pendingIdeRequest;
  pendingIdeRequest = null;
  return request;
}

export function MessageMarkdown({ content, streaming = false, renderInlineMath = false, filename, lineRange, onApplyCode, applyLabel, onOpenInIde }: MessageMarkdownProps) {
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimeout.current) clearTimeout(copyTimeout.current); }, []);
  const html = useMemo(
    () => renderMarkdownHtml(content, copiedBlock, renderInlineMath, { filename, lineRange, onApplyCode, applyLabel }),
    [content, renderInlineMath, copiedBlock, filename, lineRange, onApplyCode, applyLabel],
  );

  const handleClick = useCallback(async (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-markdown-action]");
    if (!button) return;
    const figure = button.closest<HTMLElement>("[data-code-block-index]");
    const blockIndex = Number(figure?.dataset.codeBlockIndex);
    if (!figure || !Number.isInteger(blockIndex)) return;
    const action = button.dataset.markdownAction;
    if (action !== "apply" && action !== "open-ide" && action !== "copy") return;
    const root = event.currentTarget;
    const actionSelector = `[data-code-block-index="${blockIndex}"] [data-markdown-action="${action}"]`;
    const updateAction = (update: () => void) => {
      const previousFocus = root.ownerDocument.activeElement;
      const restoreFocus = previousFocus === root.querySelector(actionSelector);
      update();
      if (!restoreFocus) return;
      // Updating decorated HTML replaces the controls. Keep keyboard focus on
      // the same action, but never pull it back from another focused control.
      window.requestAnimationFrame(() => {
        if (!root.isConnected) return;
        const activeElement = root.ownerDocument.activeElement;
        if (activeElement !== root.ownerDocument.body && activeElement !== previousFocus) return;
        root.querySelector<HTMLButtonElement>(actionSelector)?.focus({ preventScroll: true });
      });
    };
    const code = (figure.querySelector("code")?.textContent ?? "").replace(/\n$/, "");
    if (action === "apply") {
      onApplyCode?.(code);
      return;
    }
    if (action === "open-ide") {
      const location: CodeBlockLocation = {
        language: figure.dataset.codeLanguage ?? "text",
        ...(figure.dataset.codeFilename ? { filename: figure.dataset.codeFilename } : {}),
        ...(figure.dataset.codeLines ? { lineRange: figure.dataset.codeLines } : {}),
      };
      if (onOpenInIde) onOpenInIde(code, location);
      else {
        pendingIdeRequest = { code, ...location };
        setWorkspaceSurface("code");
        window.dispatchEvent(new CustomEvent<OpenCodeInIdeRequest>(OPEN_CODE_IN_IDE_EVENT, { detail: pendingIdeRequest }));
      }
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(code);
      setCopyError(null);
      updateAction(() => setCopiedBlock(blockIndex));
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => updateAction(() => setCopiedBlock((current) => (current === blockIndex ? null : current))), 1600);
    } catch {
      setCopyError("Could not copy code. Select the code and copy it manually.");
    }
  }, [onApplyCode, onOpenInIde]);

  return (
    <>
      <div
        className={streaming ? "message-markdown message-markdown--streaming" : "message-markdown"}
        onClick={(event) => void handleClick(event)}
        dangerouslySetInnerHTML={{
          __html: `${html}${streaming ? '<span class="stream-caret" aria-hidden="true"></span>' : ""}`,
        }}
      />
      {copiedBlock !== null ? <span className="sr-only" role="status">Code copied</span> : null}
      {copyError ? <p className="code-block__error" role="alert">{copyError}</p> : null}
    </>
  );
}

export const Markdown = MessageMarkdown;

export interface AssistantTextSelectionProps {
  children: ReactNode;
  sourceId: string;
  sourceRevisionId?: string;
  onQuote: (text: string) => void;
  onAskInSideChat: (text: string) => void;
  disabled?: boolean;
}

/** No fallback text or whole-message action: a real, in-root Range is required. */
export function AssistantTextSelection({ children, sourceId, sourceRevisionId = sourceId, onQuote, onAskInSideChat, disabled = false }: AssistantTextSelectionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [captured, setCaptured] = useState<CapturedTextSelection | null>(null);

  const capture = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (disabled || !root || !selection || selection.rangeCount < 1) { setCaptured(null); return; }
    const range = selection.getRangeAt(0);
    // Do not mistake selected code-header labels or controls for assistant prose.
    if (Array.from(root.querySelectorAll("button, input, textarea, [data-selection-exclude]")).some((element) => {
      try { return range.intersectsNode(element); } catch { return true; }
    })) { setCaptured(null); return; }
    setCaptured(captureTextSelection({ root, selection, sourceKind: "assistant-message", sourceId, sourceRevisionId }));
  }, [disabled, sourceId, sourceRevisionId]);

  useEffect(() => {
    const selectionChanged = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount < 1) setCaptured(null);
      else if (captured) capture();
    };
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && (rootRef.current?.contains(event.target) || toolbarRef.current?.contains(event.target))) return;
      setCaptured(null);
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") setCaptured(null); };
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", keydown);
    };
  }, [capture, captured]);

  useEffect(() => { setCaptured(null); }, [sourceId, sourceRevisionId, disabled]);

  const act = (callback: (text: string) => void) => {
    if (!captured) return;
    callback(captured.anchor.exactText);
    setCaptured(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="assistant-selection-content">
      <div ref={rootRef} data-selection-source-kind="assistant-message" data-selection-source-id={sourceId} onMouseUp={capture} onKeyUp={capture}>{children}</div>
      {captured ? (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Selected text actions"
          className="assistant-selection-toolbar"
          style={{ top: Math.max(8, Math.min(captured.rect.top - 38, window.innerHeight - 44)), left: Math.max(8, Math.min(captured.rect.left, window.innerWidth - 242)) }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" title="Quote" aria-label="Quote" onClick={() => act(onQuote)}><Quote size={14} strokeWidth={1.75} aria-hidden="true" /><span>Quote</span></button>
          <button type="button" title="Ask in side chat" aria-label="Ask in side chat" onClick={() => act(onAskInSideChat)}><MessageSquareText size={14} strokeWidth={1.75} aria-hidden="true" /><span>Ask in side chat</span></button>
        </div>
      ) : null}
    </div>
  );
}
