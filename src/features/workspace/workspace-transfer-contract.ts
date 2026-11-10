export const WORKSPACE_TRANSFER_SCHEMA = "omnia.workspace-transfer.preview.v1" as const;
export const WORKSPACE_TRANSFER_MAX_BYTES = 512 * 1024;

export type WorkspaceTransferMode = "export" | "import" | "handoff";
export type WorkspaceTransferScope = "active-chat" | "active-project" | "workspace" | "custom";
export type WorkspaceTransferFormat = "json" | "jsonl" | "markdown";
export type WorkspaceTransferRedaction = "safe" | "developer" | "full-metadata";
export type WorkspaceTransferProfile = "portable" | "support" | "recovery";

export interface WorkspaceTransferSelection {
  conversations: boolean;
  projects: boolean;
  memoryCandidates: boolean;
  skills: boolean;
  artifacts: boolean;
  attachments: boolean;
  runEvidence: boolean;
}

export interface WorkspaceTransferManifest {
  schema: typeof WORKSPACE_TRANSFER_SCHEMA;
  version: 1;
  generatedAt: string;
  mode: WorkspaceTransferMode;
  scope: WorkspaceTransferScope;
  profile: WorkspaceTransferProfile;
  format: WorkspaceTransferFormat;
  redaction: WorkspaceTransferRedaction;
  target: string;
  selection: WorkspaceTransferSelection;
  counts: Record<keyof WorkspaceTransferSelection, number>;
  estimatedBytes: number;
  records: number;
  warnings: string[];
  executionDisposition: "preview-only";
  durableWrite: false;
}

export type WorkspaceTransferParseResult =
  | { ok: true; manifest: WorkspaceTransferManifest }
  | { ok: false; error: string };

export const DEFAULT_WORKSPACE_TRANSFER_SELECTION: WorkspaceTransferSelection = {
  conversations: true,
  projects: true,
  memoryCandidates: false,
  skills: false,
  artifacts: true,
  attachments: true,
  runEvidence: false,
};

const MODES: readonly WorkspaceTransferMode[] = ["export", "import", "handoff"];
const SCOPES: readonly WorkspaceTransferScope[] = ["active-chat", "active-project", "workspace", "custom"];
const FORMATS: readonly WorkspaceTransferFormat[] = ["json", "jsonl", "markdown"];
const REDACTIONS: readonly WorkspaceTransferRedaction[] = ["safe", "developer", "full-metadata"];
const PROFILES: readonly WorkspaceTransferProfile[] = ["portable", "support", "recovery"];
const SELECTION_KEYS: readonly (keyof WorkspaceTransferSelection)[] = [
  "conversations",
  "projects",
  "memoryCandidates",
  "skills",
  "artifacts",
  "attachments",
  "runEvidence",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cloneSelection(selection: WorkspaceTransferSelection): WorkspaceTransferSelection {
  return { ...selection };
}

function normalizeCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null;
  return value;
}

export function buildWorkspaceTransferManifest(input: {
  mode: WorkspaceTransferMode;
  scope: WorkspaceTransferScope;
  profile: WorkspaceTransferProfile;
  format: WorkspaceTransferFormat;
  redaction: WorkspaceTransferRedaction;
  target: string;
  selection: WorkspaceTransferSelection;
  counts: Record<keyof WorkspaceTransferSelection, number>;
  estimatedBytes: number;
  records: number;
  generatedAt?: string;
  warnings?: readonly string[];
}): WorkspaceTransferManifest {
  const counts = Object.fromEntries(
    SELECTION_KEYS.map((key) => [key, Math.max(0, Math.round(input.counts[key] ?? 0))]),
  ) as Record<keyof WorkspaceTransferSelection, number>;
  return {
    schema: WORKSPACE_TRANSFER_SCHEMA,
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode,
    scope: input.scope,
    profile: input.profile,
    format: input.format,
    redaction: input.redaction,
    target: input.target.trim() || "Omnia workspace",
    selection: cloneSelection(input.selection),
    counts,
    estimatedBytes: Math.max(0, Math.round(input.estimatedBytes)),
    records: Math.max(0, Math.round(input.records)),
    warnings: [...(input.warnings ?? [])],
    executionDisposition: "preview-only",
    durableWrite: false,
  };
}

export function serializeWorkspaceTransferManifest(
  manifest: WorkspaceTransferManifest,
  format: WorkspaceTransferFormat = manifest.format,
): string {
  if (format === "json") return JSON.stringify({ ...manifest, format }, null, 2);
  if (format === "jsonl") {
    const header = JSON.stringify({ schema: WORKSPACE_TRANSFER_SCHEMA, version: 1, format, scope: "renderer-session" });
    const summary = JSON.stringify({ type: "manifest", ...manifest, format });
    return `${header}\n${summary}`;
  }
  const selected = SELECTION_KEYS.filter((key) => manifest.selection[key]);
  const countLines = SELECTION_KEYS.map((key) => `- ${key}: ${manifest.counts[key]}`);
  return [
    "# Omnia workspace transfer preview",
    "",
    "> Preview only · renderer-local · no durable write · no provider request.",
    "",
    `- Mode: ${manifest.mode}`,
    `- Scope: ${manifest.scope}`,
    `- Profile: ${manifest.profile}`,
    `- Target: ${manifest.target}`,
    `- Format: ${format}`,
    `- Redaction: ${manifest.redaction}`,
    `- Records: ${manifest.records}`,
    `- Estimated bytes: ${manifest.estimatedBytes}`,
    `- Selected: ${selected.length > 0 ? selected.join(", ") : "nothing"}`,
    "",
    "## Counts",
    ...countLines,
    "",
    "## Warnings",
    ...(manifest.warnings.length > 0 ? manifest.warnings.map((warning) => `- ${warning}`) : ["- None"]),
  ].join("\n");
}

function validateManifest(value: unknown): WorkspaceTransferParseResult {
  if (!isRecord(value)) return { ok: false, error: "Transfer manifest must be a JSON object." };
  if (value.schema !== WORKSPACE_TRANSFER_SCHEMA || value.version !== 1) {
    return { ok: false, error: "Unsupported Omnia transfer schema or version." };
  }
  if (!isValidDate(value.generatedAt)) return { ok: false, error: "Transfer generatedAt must be a valid date." };
  if (!isOneOf(value.mode, MODES) || !isOneOf(value.scope, SCOPES) || !isOneOf(value.profile, PROFILES)) {
    return { ok: false, error: "Transfer mode, scope, or profile is invalid." };
  }
  if (!isOneOf(value.format, FORMATS) || !isOneOf(value.redaction, REDACTIONS)) {
    return { ok: false, error: "Transfer format or redaction mode is invalid." };
  }
  if (typeof value.target !== "string" || value.target.length > 240) return { ok: false, error: "Transfer target is invalid." };
  if (value.executionDisposition !== "preview-only" || value.durableWrite !== false) {
    return { ok: false, error: "Only preview-only transfer manifests can be staged here." };
  }
  const selectionValue = value.selection;
  const countsValue = value.counts;
  if (!isRecord(selectionValue) || !isRecord(countsValue)) return { ok: false, error: "Transfer selection/counts are missing." };
  const selection = {} as WorkspaceTransferSelection;
  const counts = {} as Record<keyof WorkspaceTransferSelection, number>;
  for (const key of SELECTION_KEYS) {
    if (typeof selectionValue[key] !== "boolean") return { ok: false, error: `Transfer selection.${key} must be boolean.` };
    const count = normalizeCount(countsValue[key]);
    if (count === null) return { ok: false, error: `Transfer counts.${key} must be a non-negative integer.` };
    selection[key] = selectionValue[key] as boolean;
    counts[key] = count;
  }
  const estimatedBytes = normalizeCount(value.estimatedBytes);
  const records = normalizeCount(value.records);
  if (estimatedBytes === null || records === null) return { ok: false, error: "Transfer size and record counts are invalid." };
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    return { ok: false, error: "Transfer warnings must be strings." };
  }
  return {
    ok: true,
    manifest: {
      schema: WORKSPACE_TRANSFER_SCHEMA,
      version: 1,
      generatedAt: value.generatedAt,
      mode: value.mode,
      scope: value.scope,
      profile: value.profile,
      format: value.format,
      redaction: value.redaction,
      target: value.target.trim() || "Omnia workspace",
      selection,
      counts,
      estimatedBytes,
      records,
      warnings: [...value.warnings],
      executionDisposition: "preview-only",
      durableWrite: false,
    },
  };
}

export function parseWorkspaceTransferManifest(raw: string): WorkspaceTransferParseResult {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return { ok: false, error: "Paste a transfer manifest before staging it." };
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_TRANSFER_MAX_BYTES) {
    return { ok: false, error: "Transfer manifest exceeds the 512 KB preview limit." };
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    return validateManifest(parsed);
  } catch {
    return { ok: false, error: "Transfer import expects an Omnia JSON manifest; no changes were staged." };
  }
}
