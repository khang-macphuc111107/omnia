import type { ArtifactKind } from "./types";

/**
 * CSP injected as the first element of every sandboxed artifact document. The
 * iframe is also sandboxed (no same-origin, no popups, no top navigation), so
 * this is defense in depth: no network of any kind, inline script/style only.
 */
export const ARTIFACT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";
/** SVG never needs script. */
const SVG_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** `sandbox` attribute per kind. Never `allow-same-origin`, `allow-top-navigation` or `allow-popups`. */
export function artifactSandbox(kind: ArtifactKind): string {
  return kind === "svg" ? "" : "allow-scripts";
}

function cspMeta(csp: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
}

/** Complete `srcdoc` for an html or svg artifact; the CSP meta precedes all artifact content. */
export function artifactDocument(kind: "html" | "svg", content: string): string {
  const head = `<!doctype html><meta charset="utf-8">${cspMeta(kind === "svg" ? SVG_CSP : ARTIFACT_CSP)}`;
  if (kind === "svg") {
    return `${head}<style>html,body{margin:0;height:100%}body{display:grid;place-items:center}svg{max-width:100%;max-height:100vh}</style>${content}`;
  }
  return head + content.replace(/^\s*<!doctype[^>]*>/i, "");
}

export const CSV_MAX_ROWS = 500;
export const CSV_MAX_COLUMNS = 50;

export interface ParsedCsv {
  /** Header plus at most `CSV_MAX_ROWS` data rows. */
  rows: string[][];
  /** Rows beyond the cap that were not kept in `rows`. */
  hiddenRows: number;
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF), capped for rendering. */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let total = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    total += 1;
    if (rows.length < CSV_MAX_ROWS + 1) rows.push(row.slice(0, CSV_MAX_COLUMNS));
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else field += ch;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, hiddenRows: Math.max(0, total - rows.length) };
}

/** Fence long enough to contain any backtick run in `code`. */
export function fenceCode(code: string, language: string | undefined): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language ?? ""}\n${code}\n${fence}`;
}
