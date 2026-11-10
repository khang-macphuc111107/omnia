export type DiagnosticPreviewLevel = "info" | "success" | "warning" | "error";

export type DiagnosticPreviewCategory =
  | "runtime"
  | "navigation"
  | "composer"
  | "provider"
  | "storage";

export interface DiagnosticPreviewEvent {
  id: string;
  occurredAt: string;
  level: DiagnosticPreviewLevel;
  category: DiagnosticPreviewCategory;
  title: string;
  detail: string;
  source: string;
}

export type DiagnosticPreviewFormat = "json" | "jsonl";

export type DiagnosticExportScope = "visible" | "all";

export interface DiagnosticExportPreview {
  scope: DiagnosticExportScope;
  format: DiagnosticPreviewFormat;
  eventCount: number;
  generatedAt: string;
  redactionPolicy: typeof DIAGNOSTIC_REDACTION_POLICY;
  dataPlanes: readonly string[];
  excludedData: readonly string[];
  retention: "download-only";
  validation: {
    status: "ready";
    checks: readonly string[];
  };
}

export const DIAGNOSTIC_PREVIEW_SCOPE = "omnia-renderer-diagnostics-preview" as const;
export const DIAGNOSTIC_PREVIEW_VERSION = 1 as const;
export const DIAGNOSTIC_REDACTION_POLICY = "renderer-safe-v2" as const;

export const DIAGNOSTIC_EXPORT_DATA_PLANES = Object.freeze([
  "Event summaries",
  "Severity, category, source, and timestamps",
  "Renderer session scope and export manifest",
]);

export const DIAGNOSTIC_EXPORT_EXCLUDED_DATA = Object.freeze([
  "Prompt and response bodies",
  "Provider headers, credentials, and cookies",
  "Raw tool payloads, hidden reasoning, and local paths",
  "Native crash dumps, durable logs, and filesystem evidence",
]);

const DIAGNOSTIC_EXPORT_VALIDATION_CHECKS = Object.freeze([
  "Allowlisted event fields only",
  "Sensitive-looking values redacted",
  "Timestamps normalized to ISO-8601",
]);

const BOUNDARY =
  "Renderer-local preview only. Prompt bodies, credentials, cookies, raw secrets, and raw local paths are excluded.";

const SENSITIVE_FIELD_PATTERN =
  "(?:authorization|auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|secret|password|passwd|pwd|credential|credentials|cookie|set-cookie|session(?:[_ -]?id)?|signature|sig|x-amz-(?:credential|signature|security-token))";

function sanitizeControlCharacters(value: string): string {
  // Keep line breaks/tabs useful in a preview, but remove terminal/bidi controls
  // that can hide or reorder diagnostic content when copied elsewhere.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, " ");
}

function sanitizeDiagnosticTimestamp(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "unknown";
}

function isDiagnosticPreviewLevel(value: unknown): value is DiagnosticPreviewLevel {
  return value === "info" || value === "success" || value === "warning" || value === "error";
}

function isDiagnosticPreviewCategory(value: unknown): value is DiagnosticPreviewCategory {
  return value === "runtime" || value === "navigation" || value === "composer" || value === "provider" || value === "storage";
}

/**
 * Redact untrusted text before it is shown or exported as diagnostics.
 *
 * This is intentionally a defense-in-depth pass. The serializer below also
 * uses an explicit field allowlist, so adding an arbitrary field to a runtime
 * event cannot silently put raw payloads into an export.
 */
export function redactDiagnosticText(value: unknown): string {
  const input = sanitizeControlCharacters(value == null ? "" : String(value));

  return input
    // PEM/private-key blocks must be removed before line-oriented patterns.
    .replace(/-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    // URL user-info applies to HTTP(S), file, and custom provider schemes.
    .replace(/\b([a-z][a-z\d+.-]*):\/\/[^\s/@:]+:[^\s/@]+@/gi, "$1://[REDACTED_CREDENTIAL]@")
    // Header-style cookie values are never useful in a renderer preview.
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]*?(?=\r?$|\r?\n|\s\|\s)/gim, "$1: [REDACTED_COOKIE]")
    // Bearer/basic/digest credentials can appear outside a full URL.
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic|digest|token)\s+[^\s,;]+/gi, "$1[REDACTED_CREDENTIAL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED_TOKEN]")
    // Structured key/value fields and signed URL parameters. Keep the key and
    // delimiter visible for debugging while dropping the value completely.
    .replace(
      new RegExp(`([?&]${SENSITIVE_FIELD_PATTERN}=)[^&#\\s]*`, "gi"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`([\\"']?${SENSITIVE_FIELD_PATTERN}[\\"']?\\s*[=:]\\s*)(?!\\[REDACTED(?:_[A-Z]+)?\\])(?:\\"[^\\"]*\\"|'[^']*'|[^\\s,;}}\\]\\)]+)`, "gi"),
      "$1[REDACTED]",
    )
    // Common provider, CI, cloud, package-manager, and JWT token shapes.
    .replace(/\b(?:gh[pousr]_|github_pat_|npm_|xox[baprs]-|glpat-|pypi-|hf_|AIza|AKIA|ASIA|sk|pk|rk|r8|dop_v1_)[A-Za-z0-9_\-]{8,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/g, "[REDACTED_JWT]")
    // Email addresses are personal identifiers and often appear in provider
    // errors; they are not needed to identify a renderer event.
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    // Windows drive, UNC/device, and common Unix home/temp/workspace paths.
    .replace(/\b[A-Za-z]:[\\/][^\r\n<>|?*\"']+/g, "[REDACTED_PATH]")
    .replace(/(?:\\\\\?\\|\\\\\.\\|\\\\Device\\|\\\\)[^\r\n<>|?*\"']+/gi, "[REDACTED_PATH]")
    .replace(/~[\\/][^\r\n<>|?*\"']+/g, "[REDACTED_PATH]")
    .replace(/\/(?:Users|home|root|tmp|var(?:\/tmp)?|private(?:\/tmp)?|mnt|workspace|workspaces|opt|srv|etc)\/[^\r\n<>|?*\"']+/gi, "[REDACTED_PATH]");
}

export function sanitizeDiagnosticEvent(
  event: DiagnosticPreviewEvent,
): DiagnosticPreviewEvent {
  return {
    // Keep this as an explicit allowlist. Do not spread `event`: renderer
    // callers may receive native/provider-shaped objects with payload fields.
    id: redactDiagnosticText(event.id).slice(0, 160),
    occurredAt: sanitizeDiagnosticTimestamp(event.occurredAt),
    level: isDiagnosticPreviewLevel(event.level) ? event.level : "info",
    category: isDiagnosticPreviewCategory(event.category) ? event.category : "runtime",
    title: redactDiagnosticText(event.title).slice(0, 240),
    detail: redactDiagnosticText(event.detail).slice(0, 2_000),
    source: redactDiagnosticText(event.source).slice(0, 160),
  };
}

export function createDiagnosticPreviewEvents(input: {
  appName: string;
  appVersion: string;
  tauri: boolean;
  now?: Date;
}): DiagnosticPreviewEvent[] {
  const now = input.now ?? new Date();
  const atOffset = (seconds: number) => new Date(now.getTime() - seconds * 1_000).toISOString();
  const runtimeLabel = input.tauri ? "Tauri desktop" : "browser preview";

  return [
    {
      id: "preview-runtime-ready",
      occurredAt: atOffset(8),
      level: "success",
      category: "runtime",
      title: "Renderer workspace ready",
      detail: `${input.appName} ${input.appVersion} opened in ${runtimeLabel}. Native diagnostic collection was not started.`,
      source: "workspace-shell",
    },
    {
      id: "preview-navigation-settings",
      occurredAt: atOffset(6),
      level: "info",
      category: "navigation",
      title: "Settings preview opened",
      detail: "The Diagnostics & export category is visible in the renderer session.",
      source: "settings-screen",
    },
    {
      id: "preview-provider-boundary",
      occurredAt: atOffset(4),
      level: "warning",
      category: "provider",
      title: "Provider payload logging excluded",
      detail: "Only renderer-safe provider labels and health states may enter this preview. Request and response bodies remain excluded.",
      source: "provider-boundary",
    },
    {
      id: "preview-storage-boundary",
      occurredAt: atOffset(2),
      level: "info",
      category: "storage",
      title: "Native evidence unavailable",
      detail: "Durable logs, native storage health, crash reports, and filesystem evidence remain planned behind the desktop bridge.",
      source: "diagnostics-preview",
    },
  ];
}

export function serializeDiagnosticPreview(
  events: readonly DiagnosticPreviewEvent[],
  format: DiagnosticPreviewFormat,
  generatedAt = new Date().toISOString(),
): string {
  const safeEvents = events.map(sanitizeDiagnosticEvent);
  const manifest = {
    scope: DIAGNOSTIC_PREVIEW_SCOPE,
    version: DIAGNOSTIC_PREVIEW_VERSION,
    redactionPolicy: DIAGNOSTIC_REDACTION_POLICY,
    generatedAt: sanitizeDiagnosticTimestamp(generatedAt),
    boundary: BOUNDARY,
    eventCount: safeEvents.length,
    dataPlanes: DIAGNOSTIC_EXPORT_DATA_PLANES,
    excludedData: DIAGNOSTIC_EXPORT_EXCLUDED_DATA,
    retention: "download-only" as const,
    validation: {
      status: "ready" as const,
      checks: DIAGNOSTIC_EXPORT_VALIDATION_CHECKS,
    },
  };

  if (format === "jsonl") {
    return [
      JSON.stringify({ type: "manifest", ...manifest }),
      ...safeEvents.map((event) => JSON.stringify({ type: "event", ...event })),
    ].join("\n");
  }

  return JSON.stringify({ ...manifest, events: safeEvents }, null, 2);
}

export function buildDiagnosticExportPreview(input: {
  events: readonly DiagnosticPreviewEvent[];
  scope: DiagnosticExportScope;
  format: DiagnosticPreviewFormat;
  generatedAt?: string;
}): DiagnosticExportPreview {
  const safeEvents = input.events.map(sanitizeDiagnosticEvent);
  return {
    scope: input.scope,
    format: input.format,
    eventCount: safeEvents.length,
    generatedAt: sanitizeDiagnosticTimestamp(input.generatedAt ?? new Date().toISOString()),
    redactionPolicy: DIAGNOSTIC_REDACTION_POLICY,
    dataPlanes: DIAGNOSTIC_EXPORT_DATA_PLANES,
    excludedData: DIAGNOSTIC_EXPORT_EXCLUDED_DATA,
    retention: "download-only",
    validation: {
      status: "ready",
      checks: DIAGNOSTIC_EXPORT_VALIDATION_CHECKS,
    },
  };
}
