export const WORKSPACE_EXPORT_SCHEMA = "omnia.workspace-export.preview.v1" as const;
export const WORKSPACE_EXPORT_MAX_BYTES = 512 * 1024;

export type WorkspaceExportFormat = "json" | "markdown" | "jsonl";
export type WorkspaceExportScope = "active-chat" | "active-project" | "workspace" | "custom";
export type WorkspaceExportRedaction = "safe" | "developer" | "full-preview";

export type WorkspaceExportRecordKind =
  | "conversation"
  | "project"
  | "memory"
  | "skill"
  | "provider"
  | "artifact"
  | "attachment"
  | "run"
  | "diagnostic"
  | "appearance";

export interface WorkspaceExportRecord {
  kind: WorkspaceExportRecordKind;
  id: string;
  label: string;
  summary: string;
  metadata: Record<string, string | number | boolean | null>;
}

export type WorkspaceExportDiffStatus =
  | "unchanged"
  | "changed"
  | "imported-only"
  | "current-only";

export interface WorkspaceExportRecordDiff {
  key: string;
  kind: WorkspaceExportRecordKind;
  id: string;
  status: WorkspaceExportDiffStatus;
  imported: WorkspaceExportRecord | null;
  current: WorkspaceExportRecord | null;
  changedFields: string[];
}

export interface WorkspaceExportSelection {
  conversations: boolean;
  projects: boolean;
  memories: boolean;
  skills: boolean;
  providers: boolean;
  artifacts: boolean;
  attachments: boolean;
  runs: boolean;
  diagnostics: boolean;
  appearance: boolean;
}

export interface WorkspaceExportProjection {
  schema: typeof WORKSPACE_EXPORT_SCHEMA;
  scope: WorkspaceExportScope;
  redaction: WorkspaceExportRedaction;
  generatedAt: string;
  selection: WorkspaceExportSelection;
  counts: Record<WorkspaceExportRecordKind, number>;
  records: WorkspaceExportRecord[];
  boundary: {
    rendererOnly: true;
    noDurableWrite: true;
    noProviderRequest: true;
    metadataOnly: true;
  };
}

export interface WorkspaceExportInput {
  scope: WorkspaceExportScope;
  redaction: WorkspaceExportRedaction;
  generatedAt: string;
  selection: WorkspaceExportSelection;
  records: WorkspaceExportRecord[];
}

const DIFF_FIELD_ORDER = ["label", "summary", "metadata"] as const;

function comparableRecord(record: WorkspaceExportRecord): string {
  const metadata = Object.fromEntries(
    Object.entries(record.metadata).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    kind: record.kind,
    id: record.id,
    label: record.label,
    summary: record.summary,
    metadata,
  });
}

function changedRecordFields(
  imported: WorkspaceExportRecord,
  current: WorkspaceExportRecord,
): string[] {
  const changed = new Set<string>();
  if (imported.label !== current.label) changed.add("label");
  if (imported.summary !== current.summary) changed.add("summary");

  const metadataKeys = new Set([
    ...Object.keys(imported.metadata),
    ...Object.keys(current.metadata),
  ]);
  if ([...metadataKeys].some((key) => imported.metadata[key] !== current.metadata[key])) {
    changed.add("metadata");
  }

  return DIFF_FIELD_ORDER.filter((field) => changed.has(field));
}

/**
 * Compare two normalized renderer export projections by the stable kind/id
 * identity. This is an inspection aid only: it does not validate provenance,
 * verify integrity, or apply either side to workspace state.
 */
export function compareWorkspaceExportRecords(input: {
  importedRecords: readonly WorkspaceExportRecord[];
  currentRecords: readonly WorkspaceExportRecord[];
}): WorkspaceExportRecordDiff[] {
  const importedByKey = new Map<string, WorkspaceExportRecord>();
  const currentByKey = new Map<string, WorkspaceExportRecord>();

  for (const record of input.importedRecords) {
    const normalized = normalizeRecord(record);
    importedByKey.set(`${normalized.kind}:${normalized.id}`, normalized);
  }
  for (const record of input.currentRecords) {
    const normalized = normalizeRecord(record);
    currentByKey.set(`${normalized.kind}:${normalized.id}`, normalized);
  }

  const keys = [...new Set([...importedByKey.keys(), ...currentByKey.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );

  return keys.map((key) => {
    const imported = importedByKey.get(key) ?? null;
    const current = currentByKey.get(key) ?? null;
    const status: WorkspaceExportDiffStatus = !imported
      ? "current-only"
      : !current
        ? "imported-only"
        : comparableRecord(imported) === comparableRecord(current)
          ? "unchanged"
          : "changed";
    return {
      key,
      kind: imported?.kind ?? current!.kind,
      id: imported?.id ?? current!.id,
      status,
      imported,
      current,
      changedFields: imported && current ? changedRecordFields(imported, current) : [],
    };
  });
}

const RECORD_KINDS: WorkspaceExportRecordKind[] = [
  "conversation",
  "project",
  "memory",
  "skill",
  "provider",
  "artifact",
  "attachment",
  "run",
  "diagnostic",
  "appearance",
];

const SCOPE_VALUES: WorkspaceExportScope[] = [
  "active-chat",
  "active-project",
  "workspace",
  "custom",
];

const REDACTION_VALUES: WorkspaceExportRedaction[] = [
  "safe",
  "developer",
  "full-preview",
];

const SELECTION_KEYS: (keyof WorkspaceExportSelection)[] = [
  "conversations",
  "projects",
  "memories",
  "skills",
  "providers",
  "artifacts",
  "attachments",
  "runs",
  "diagnostics",
  "appearance",
];

const REDACTION_LABELS: Record<WorkspaceExportRedaction, string> = {
  safe: "Safe preview",
  developer: "Developer trace",
  "full-preview": "Full metadata preview",
};

function emptyCounts(): Record<WorkspaceExportRecordKind, number> {
  return RECORD_KINDS.reduce(
    (counts, kind) => {
      counts[kind] = 0;
      return counts;
    },
    {} as Record<WorkspaceExportRecordKind, number>,
  );
}

function normalizeRecord(record: WorkspaceExportRecord): WorkspaceExportRecord {
  return {
    kind: record.kind,
    id: record.id.trim().slice(0, 160),
    label: record.label.trim().slice(0, 240),
    summary: record.summary.trim().slice(0, 500),
    metadata: Object.fromEntries(
      Object.entries(record.metadata).slice(0, 32).map(([key, value]) => [
        key.slice(0, 80),
        typeof value === "string" ? value.slice(0, 240) : value,
      ]),
    ),
  };
}

function isWorkspaceExportScope(value: unknown): value is WorkspaceExportScope {
  return typeof value === "string" && SCOPE_VALUES.includes(value as WorkspaceExportScope);
}

function isWorkspaceExportRedaction(value: unknown): value is WorkspaceExportRedaction {
  return typeof value === "string" && REDACTION_VALUES.includes(value as WorkspaceExportRedaction);
}

function isWorkspaceExportSelection(value: unknown): value is WorkspaceExportSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return (
    Object.keys(selection).length === SELECTION_KEYS.length &&
    Object.keys(selection).every((key) => SELECTION_KEYS.includes(key as keyof WorkspaceExportSelection)) &&
    SELECTION_KEYS.every((key) => typeof selection[key] === "boolean")
  );
}

function normalizeSelection(selection: unknown): WorkspaceExportSelection {
  const candidate = selection && typeof selection === "object" ? (selection as Record<string, unknown>) : {};
  return {
    conversations: candidate.conversations === true,
    projects: candidate.projects === true,
    memories: candidate.memories === true,
    skills: candidate.skills === true,
    providers: candidate.providers === true,
    artifacts: candidate.artifacts === true,
    attachments: candidate.attachments === true,
    runs: candidate.runs === true,
    diagnostics: candidate.diagnostics === true,
    appearance: candidate.appearance === true,
  };
}

export function buildWorkspaceExportProjection(input: WorkspaceExportInput): WorkspaceExportProjection {
  const records = input.records
    .filter((record) => RECORD_KINDS.includes(record.kind))
    .map(normalizeRecord);
  const counts = emptyCounts();
  for (const record of records) counts[record.kind] += 1;

  return {
    schema: WORKSPACE_EXPORT_SCHEMA,
    scope: input.scope,
    redaction: input.redaction,
    generatedAt: input.generatedAt,
    selection: normalizeSelection(input.selection),
    counts,
    records,
    boundary: {
      rendererOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
      metadataOnly: true,
    },
  };
}

export function workspaceExportSummary(projection: WorkspaceExportProjection): string {
  const total = projection.records.length;
  const enabledKinds = RECORD_KINDS.filter((kind) => projection.counts[kind] > 0).length;
  return `${total} metadata records across ${enabledKinds} categories · ${REDACTION_LABELS[projection.redaction]}`;
}

export function serializeWorkspaceExport(
  projection: WorkspaceExportProjection,
  format: WorkspaceExportFormat,
): string {
  if (format === "json") return `${JSON.stringify(projection, null, 2)}\n`;
  if (format === "jsonl") {
    return [
      JSON.stringify({
        schema: projection.schema,
        scope: projection.scope,
        redaction: projection.redaction,
        generatedAt: projection.generatedAt,
        selection: projection.selection,
        boundary: projection.boundary,
      }),
      ...projection.records.map((record) => JSON.stringify(record)),
    ].join("\n") + "\n";
  }

  const lines = [
    "# Omnia workspace export preview",
    "",
    `- Schema: ${projection.schema}`,
    `- Scope: ${projection.scope}`,
    `- Redaction: ${REDACTION_LABELS[projection.redaction]}`,
    `- Generated: ${projection.generatedAt}`,
    `- Records: ${projection.records.length}`,
    "- Boundary: renderer-only metadata preview; no durable write; no provider request",
    "",
    "## Categories",
    "",
  ];
  for (const kind of RECORD_KINDS) lines.push(`- ${kind}: ${projection.counts[kind]}`);
  lines.push("", "## Records", "");
  for (const record of projection.records) {
    lines.push(`### ${record.label || record.id}`, "", `- Kind: ${record.kind}`, `- ID: ${record.id}`, `- ${record.summary}`, "");
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is WorkspaceExportRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== "string" ||
    !RECORD_KINDS.includes(record.kind as WorkspaceExportRecordKind) ||
    typeof record.id !== "string" ||
    record.id.trim().length === 0 ||
    typeof record.label !== "string" ||
    typeof record.summary !== "string" ||
    !record.metadata ||
    typeof record.metadata !== "object" ||
    Array.isArray(record.metadata)
  ) {
    return false;
  }
  const metadata = record.metadata as Record<string, unknown>;
  return Object.entries(metadata).every(
    ([key, item]) =>
      key.trim().length > 0 &&
      key.length <= 80 &&
      (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean"),
  );
}

export function parseWorkspaceExport(text: string): WorkspaceExportProjection {
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) throw new Error("The export is empty.");
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_EXPORT_MAX_BYTES) {
    throw new Error("The export exceeds the 512 KB preview limit.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    const lines = source.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("Only Omnia JSON or JSONL previews can be imported here.");
    try {
      parsed = lines.map((line) => JSON.parse(line));
    } catch {
      throw new Error("The export is not valid JSON or JSONL.");
    }
  }

  const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!candidate || typeof candidate !== "object") throw new Error("The export manifest is invalid.");
  const manifest = candidate as Record<string, unknown>;
  if (manifest.schema !== WORKSPACE_EXPORT_SCHEMA) throw new Error("Unsupported Omnia export schema.");
  if (!isWorkspaceExportScope(manifest.scope) || !isWorkspaceExportRedaction(manifest.redaction) || typeof manifest.generatedAt !== "string") {
    throw new Error("The export manifest is missing scope, redaction, or timestamp.");
  }
  if (manifest.generatedAt.trim().length === 0 || !Number.isFinite(Date.parse(manifest.generatedAt))) {
    throw new Error("The export manifest timestamp is invalid.");
  }
  if (!isWorkspaceExportSelection(manifest.selection)) {
    throw new Error("The export manifest selection is invalid.");
  }
  const recordValues: unknown[] = Array.isArray(parsed)
    ? parsed.slice(1)
    : Array.isArray((parsed as Record<string, unknown>).records)
      ? ((parsed as Record<string, unknown>).records as unknown[])
      : [];
  if (!recordValues.every(isRecord)) throw new Error("The export contains an invalid record.");
  const records = recordValues.filter(isRecord);

  return buildWorkspaceExportProjection({
    scope: manifest.scope as WorkspaceExportScope,
    redaction: manifest.redaction as WorkspaceExportRedaction,
    generatedAt: manifest.generatedAt,
    selection: manifest.selection,
    records,
  });
}

export function downloadWorkspaceExport(
  projection: WorkspaceExportProjection,
  format: WorkspaceExportFormat,
): void {
  if (typeof document === "undefined") return;
  const extension = format === "markdown" ? "md" : format;
  const blob = new Blob([serializeWorkspaceExport(projection, format)], {
    type: format === "markdown" ? "text/markdown" : "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `omnia-workspace-export-preview.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
