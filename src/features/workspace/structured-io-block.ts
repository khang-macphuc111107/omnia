export type StructuredBlockSourceKind =
  | "prompt"
  | "assistant"
  | "tool-input"
  | "tool-output"
  | "command"
  | "stdout"
  | "stderr"
  | "build-log"
  | "test-log"
  | "trace"
  | "artifact"
  | "request"
  | "response";

export type StructuredBlockFormat =
  | "plain"
  | "markdown"
  | "latex"
  | "code"
  | "shell"
  | "ansi"
  | "json"
  | "jsonl"
  | "yaml"
  | "toml"
  | "xml"
  | "html"
  | "css"
  | "sql"
  | "csv"
  | "tsv"
  | "diff"
  | "patch"
  | "stack-trace"
  | "test-report"
  | "compiler-diagnostic"
  | "http"
  | "sse"
  | "table"
  | "binary-metadata"
  | "unknown";

export type StructuredBlockChannel = "input" | "output" | "stdout" | "stderr" | "system" | "tool" | "trace" | "mixed";
export type StructuredBlockStreamState = "complete" | "streaming" | "truncated" | "interrupted" | "malformed";

export interface StructuredBlockConfig {
  readonly sourceKind: StructuredBlockSourceKind;
  readonly channel: StructuredBlockChannel;
  readonly streamState: StructuredBlockStreamState;
  readonly formatOverride: StructuredBlockFormat | "auto";
  readonly language: string;
}

export interface StructuredBlockDetection {
  readonly format: StructuredBlockFormat;
  readonly language: string | null;
  readonly confidence: number;
}

export interface StructuredBlockPreview {
  readonly schemaVersion: 1;
  readonly blockId: string;
  readonly sourceKind: StructuredBlockSourceKind;
  readonly format: StructuredBlockFormat;
  readonly language: string | null;
  readonly detectionConfidence: number | null;
  readonly sourceHash: string;
  readonly parserRevision: string;
  readonly highlighterRevision: string;
  readonly streamState: StructuredBlockStreamState;
  readonly channel: StructuredBlockChannel;
  readonly redactionClass: null;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly sourceArtifactId: null;
  readonly createdAt: string;
}

export const DEFAULT_STRUCTURED_BLOCK_CONFIG: StructuredBlockConfig = {
  sourceKind: "assistant",
  channel: "output",
  streamState: "complete",
  formatOverride: "auto",
  language: "",
};

const FORMAT_LABELS: Readonly<Record<StructuredBlockFormat, string>> = {
  plain: "Plain text",
  markdown: "Markdown",
  latex: "LaTeX",
  code: "Source code",
  shell: "Shell",
  ansi: "ANSI terminal",
  json: "JSON",
  jsonl: "JSONL",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  csv: "CSV",
  tsv: "TSV",
  diff: "Unified diff",
  patch: "Patch",
  "stack-trace": "Stack trace",
  "test-report": "Test report",
  "compiler-diagnostic": "Compiler diagnostic",
  http: "HTTP",
  sse: "SSE/event stream",
  table: "Table",
  "binary-metadata": "Binary metadata",
  unknown: "Unknown",
};

export const STRUCTURED_BLOCK_FORMATS = Object.freeze(
  (Object.keys(FORMAT_LABELS) as StructuredBlockFormat[]).map((id) => ({ id, label: FORMAT_LABELS[id] })),
);

export function normalizeStructuredSource(source: string): string {
  return source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** A deterministic renderer preview hash; this is not a cryptographic receipt. */
export function structuredPreviewHash(source: string): string {
  let hash = 0x811c9dc5;
  for (const codePoint of source) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function jsonLooksLikeJsonl(lines: readonly string[]): boolean {
  const candidates = lines.filter((line) => line.trim().length > 0);
  return candidates.length > 1 && candidates.every((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

export function detectStructuredFormat(source: string): StructuredBlockDetection {
  const normalized = normalizeStructuredSource(source);
  const trimmed = normalized.trim();
  if (!trimmed) return { format: "plain", language: null, confidence: 0.35 };
  const fence = trimmed.match(/^```([\w+#.-]*)\s*\n/i);
  if (fence) {
    const language = fence[1]?.toLowerCase() || "text";
    const format: StructuredBlockFormat = ["sh", "bash", "zsh", "shell", "powershell", "ps1"].includes(language)
      ? "shell"
      : language === "json" ? "json"
        : language === "yaml" || language === "yml" ? "yaml"
          : language === "sql" ? "sql"
            : language === "html" ? "html"
              : language === "css" ? "css"
                : "code";
    return { format, language, confidence: 0.98 };
  }
  if (/\x1b\[[0-?]*[ -/]*[@-~]/.test(normalized)) return { format: "ansi", language: null, confidence: 0.99 };
  if (/^\s*(?:diff --git|index [0-9a-f]+\.\.[0-9a-f]+|@@ -\d+)/m.test(normalized)) return { format: "diff", language: null, confidence: 0.94 };
  if (/^\s*(?:at .+\(.+\)|Traceback \(most recent call last\)|Error: )/m.test(normalized)) return { format: "stack-trace", language: null, confidence: 0.9 };
  if (/^\s*(?:GET|POST|PUT|PATCH|DELETE|HTTP)\s+\S+/m.test(normalized) || /^HTTP\/\d\.\d\s+\d+/m.test(normalized)) return { format: "http", language: null, confidence: 0.9 };
  try {
    JSON.parse(trimmed);
    return { format: "json", language: "json", confidence: 0.99 };
  } catch {
    if (jsonLooksLikeJsonl(normalized.split("\n"))) return { format: "jsonl", language: "json", confidence: 0.97 };
  }
  if (/^\s*(?:---|\.\.\.)\s*$/.test(trimmed) || /^\s*[\w.-]+:\s+\S+/m.test(normalized)) return { format: "yaml", language: "yaml", confidence: 0.78 };
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)\b/i.test(trimmed)) return { format: "sql", language: "sql", confidence: 0.94 };
  if (/^\s*#{1,6}\s+|\*\*[^*]+\*\*|^\s*[-*+]\s+/m.test(normalized)) return { format: "markdown", language: "markdown", confidence: 0.82 };
  if (/^\s*(?:[$#]\s+|PS [A-Z]:\\|npm\s+(?:run|install)|cargo\s+(?:build|test|run))/m.test(normalized)) return { format: "shell", language: "shell", confidence: 0.85 };
  return { format: "plain", language: null, confidence: 0.45 };
}

export function buildStructuredBlockPreview(
  source: string,
  config: StructuredBlockConfig = DEFAULT_STRUCTURED_BLOCK_CONFIG,
  options: { readonly blockId?: string; readonly createdAt?: string } = {},
): StructuredBlockPreview {
  const normalized = normalizeStructuredSource(source);
  const detected = detectStructuredFormat(normalized);
  const explicit = config.formatOverride !== "auto";
  const format = explicit ? config.formatOverride : detected.format;
  const language = config.language.trim() || (explicit && format !== detected.format ? null : detected.language);
  return {
    schemaVersion: 1,
    blockId: options.blockId ?? "preview:structured-io:block",
    sourceKind: config.sourceKind,
    format,
    language,
    detectionConfidence: explicit ? null : detected.confidence,
    sourceHash: structuredPreviewHash(source),
    parserRevision: "renderer-preview.parser.v1",
    highlighterRevision: "renderer-preview.highlighter.v1",
    streamState: config.streamState,
    channel: config.channel,
    redactionClass: null,
    lineCount: source ? source.split(/\r\n?|\n/).length : 0,
    byteCount: new TextEncoder().encode(source).byteLength,
    sourceArtifactId: null,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

export function sourceLinesForStructuredBlock(source: string, view: "raw" | "normalized"): string[] {
  const value = view === "normalized" ? normalizeStructuredSource(source) : source;
  return value ? value.split("\n") : [];
}
