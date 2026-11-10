/** New Omnia editor model. Native grants and writable browser handles stay distinct. */
export const MAX_EDITOR_BYTES = 2 * 1024 * 1024;
export const MAX_HIGHLIGHT_CHARACTERS = 120_000;
export const MAX_DIRECTORY_ENTRIES = 2_000;

export type IdeOrigin = "native" | "handle" | "import";

export interface IdeRoot {
  id: string;
  name: string;
  displayPath: string;
  origin: IdeOrigin;
  readOnly: boolean;
}

export interface IdeEntry {
  rootId: string;
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  byteSize: number | null;
}

export interface IdeListing {
  rootId: string;
  relativePath: string;
  entries: IdeEntry[];
  truncated: boolean;
}

export interface IdeDocument {
  id: string;
  rootId: string;
  relativePath: string;
  name: string;
  origin: IdeOrigin;
  content: string;
  version: string;
  saveMode: "original" | "copy";
}

export interface IdeTab {
  instanceId: number;
  document: IdeDocument;
  content: string;
  baseline: string;
  editRevision: number;
  saving: boolean;
  conflict: string | null;
  sourceState: "current" | "changed" | "missing" | "unknown";
  sourceSnapshot: IdeDocument | null;
  checking: boolean;
}

export interface IdeMatch { from: number; to: number }
export interface SyntaxToken { text: string; kind: "text" | "keyword" | "string" | "number" | "comment" | "punctuation" }

export class IdeAccessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "IdeAccessError";
  }
}

/** The renderer only forwards relative paths; the native grant boundary is authoritative. */
export function normalizeRelativePath(value: string, allowRoot = false): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f:]/.test(value)) {
    throw new IdeAccessError("invalid_path", "Use a relative file path without control characters or a drive prefix.");
  }
  const path = value.replace(/\\/g, "/");
  if (path === "" && allowRoot) return "";
  if (!path || path.startsWith("/") || path.endsWith("/")) {
    throw new IdeAccessError("invalid_path", "The file path must remain inside its selected folder.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new IdeAccessError("invalid_path", "Parent traversal and empty path segments are not allowed.");
  }
  return segments.join("/");
}

export function documentId(rootId: string, relativePath: string): string {
  return `${rootId}:${normalizeRelativePath(relativePath)}`;
}

let tabSequence = 0;
export function createTab(document: IdeDocument): IdeTab {
  const editorText = document.content.replace(/\r\n/g, "\n");
  return { instanceId: ++tabSequence, document, content: editorText, baseline: editorText, editRevision: 0, saving: false, conflict: null, sourceState: "current", sourceSnapshot: null, checking: false };
}

export function serializeEditorText(content: string, original: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return original.includes("\r\n") && !original.replace(/\r\n/g, "").includes("\n") ? normalized.replace(/\n/g, "\r\n") : normalized;
}

export function editTab(tab: IdeTab, content: string): IdeTab {
  return { ...tab, content, editRevision: tab.editRevision + 1 };
}

/** A save commits the submitted snapshot, retaining edits made while the write awaited I/O. */
export function completeTabSave(tab: IdeTab, saved: IdeDocument, submittedContent: string): IdeTab {
  return { ...tab, document: saved, baseline: submittedContent, saving: false, conflict: null, sourceState: "current", sourceSnapshot: null };
}

export function isTabDirty(tab: IdeTab): boolean { return tab.content !== tab.baseline; }

export function findInText(content: string, query: string, caseSensitive = false): IdeMatch[] {
  if (!query) return [];
  const matches: IdeMatch[] = [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
  for (const match of content.matchAll(pattern)) {
    if (matches.length >= 10_000) break;
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return matches;
}

export function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript JSX", js: "JavaScript", jsx: "JavaScript JSX", json: "JSON", md: "Markdown", markdown: "Markdown", rs: "Rust", py: "Python", css: "CSS", html: "HTML", htm: "HTML", c: "C", cpp: "C++", h: "C", go: "Go", java: "Java", sql: "SQL", yaml: "YAML", yml: "YAML", toml: "TOML", sh: "Shell", ps1: "PowerShell" };
  return languages[extension ?? ""] ?? "Plain text";
}

/** Lexical color only, never HTML execution or a claim of language-server diagnostics. */
export function tokenizeSource(content: string): SyntaxToken[] {
  if (content.length > MAX_HIGHLIGHT_CHARACTERS) return [{ text: content, kind: "text" }];
  const pattern = /(?:\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(?:async|await|break|case|catch|class|const|continue|def|else|enum|export|false|fn|for|from|function|if|impl|import|in|interface|let|match|new|null|pub|return|self|static|struct|super|switch|this|throw|trait|true|try|type|undefined|use|var|void|while|yield)\b|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|[{}()[\];,.]/g;
  const result: SyntaxToken[] = [];
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const from = match.index;
    if (from > cursor) result.push({ text: content.slice(cursor, from), kind: "text" });
    const value = match[0];
    const kind: SyntaxToken["kind"] = value.startsWith("//") || value.startsWith("/*") || value.startsWith("#") ? "comment" : /^["'`]/.test(value) ? "string" : /^\d/.test(value) ? "number" : /^[{}()[\];,.]$/.test(value) ? "punctuation" : "keyword";
    result.push({ text: value, kind });
    cursor = from + value.length;
  }
  if (cursor < content.length) result.push({ text: content.slice(cursor), kind: "text" });
  return result;
}

export function describeIdeError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "The file operation failed. Your current edits are retained.";
}
