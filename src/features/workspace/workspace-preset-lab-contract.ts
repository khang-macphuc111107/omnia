export const WORKSPACE_PRESET_SCHEMA = "omnia.workspace-preset-preview.v1" as const;
export const WORKSPACE_PRESET_MAX_BYTES = 512 * 1024;

export type WorkspacePresetKind =
  | "workspace"
  | "project"
  | "chat"
  | "permissions"
  | "appearance"
  | "export";

export type WorkspacePresetStatus = "active" | "preview" | "planned";
export type WorkspacePresetSource = "builtin" | "session" | "imported";
export type WorkspacePresetFormat = "json" | "markdown";
export type WorkspacePresetImportConflictPolicy = "keep-both" | "skip-duplicates" | "replace-session";

export interface WorkspacePreset {
  id: string;
  name: string;
  kind: WorkspacePresetKind;
  description: string;
  tags: string[];
  updatedAt: string;
  values: Record<string, string>;
  status: WorkspacePresetStatus;
  source: WorkspacePresetSource;
}

export interface WorkspacePresetBundle {
  schema: typeof WORKSPACE_PRESET_SCHEMA;
  version: 1;
  generatedAt: string;
  scope: "renderer-session";
  selectedPresetId: string;
  presets: WorkspacePreset[];
  boundary: {
    rendererOnly: true;
    noDurableWrite: true;
    noProviderRequest: true;
    noPermissionGrant: true;
  };
}

export type WorkspacePresetImportConflictReason = "matching-id" | "matching-name-and-kind";

export interface WorkspacePresetImportConflict {
  incoming: WorkspacePreset;
  existing: WorkspacePreset;
  reason: WorkspacePresetImportConflictReason;
  canReplace: boolean;
}

export type WorkspacePresetParseResult =
  | { ok: true; bundle: WorkspacePresetBundle }
  | { ok: false; error: string };

const PRESET_KINDS: readonly WorkspacePresetKind[] = [
  "workspace",
  "project",
  "chat",
  "permissions",
  "appearance",
  "export",
];
const PRESET_STATUSES: readonly WorkspacePresetStatus[] = ["active", "preview", "planned"];
const PRESET_SOURCES: readonly WorkspacePresetSource[] = ["builtin", "session", "imported"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) return null;
  return [...new Set(value.map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
}

function normalizedValues(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 24) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== "string") return null;
    const normalizedKey = key.trim().slice(0, 80);
    if (!normalizedKey) continue;
    result[normalizedKey] = item.trim().slice(0, 240);
  }
  return result;
}

function presetNameKey(preset: WorkspacePreset): string {
  return `${preset.kind}:${preset.name.trim().toLocaleLowerCase()}`;
}

/**
 * Returns a renderer-session conflict projection for an import. Matching IDs
 * take precedence over matching name/category pairs. Built-in presets are
 * intentionally never replaceable; the caller may keep both or skip them.
 */
export function findWorkspacePresetImportConflicts(
  existing: readonly WorkspacePreset[],
  incoming: readonly WorkspacePreset[],
): WorkspacePresetImportConflict[] {
  const byId = new Map(existing.map((preset) => [preset.id, preset]));
  const byName = new Map(existing.map((preset) => [presetNameKey(preset), preset]));
  const conflicts: WorkspacePresetImportConflict[] = [];
  for (const preset of incoming) {
    const matchingId = byId.get(preset.id);
    const matchingName = byName.get(presetNameKey(preset));
    const existingPreset = matchingId ?? matchingName;
    if (!existingPreset) continue;
    conflicts.push({
      incoming: preset,
      existing: existingPreset,
      reason: matchingId ? "matching-id" : "matching-name-and-kind",
      canReplace: existingPreset.source !== "builtin",
    });
  }
  return conflicts;
}

function normalizePreset(value: unknown, index: number): WorkspacePreset | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 120) : `imported-${index + 1}`;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 160) : "Imported preset";
  const description = typeof value.description === "string" ? value.description.trim().slice(0, 500) : "Imported renderer-local preset.";
  const tags = normalizedTags(value.tags);
  const values = normalizedValues(value.values);
  if (!id || !name || !tags || !values || !isOneOf(value.kind, PRESET_KINDS)) return null;
  const status = isOneOf(value.status, PRESET_STATUSES) ? value.status : "preview";
  const source = isOneOf(value.source, PRESET_SOURCES) ? value.source : "imported";
  const updatedAt = validDate(value.updatedAt) ? value.updatedAt : new Date(0).toISOString();
  return { id, name, kind: value.kind, description, tags, updatedAt, values, status, source };
}

function parseBundle(value: unknown): WorkspacePresetParseResult {
  if (!isRecord(value)) return { ok: false, error: "Preset bundle must be a JSON object." };
  if (value.schema !== WORKSPACE_PRESET_SCHEMA || value.version !== 1) {
    return { ok: false, error: "Unsupported Omnia preset schema or version." };
  }
  if (value.scope !== "renderer-session" || !validDate(value.generatedAt)) {
    return { ok: false, error: "Preset scope or generatedAt is invalid." };
  }
  if (!Array.isArray(value.presets) || value.presets.length > 100) {
    return { ok: false, error: "Preset bundle must contain between 0 and 100 presets." };
  }
  const presets: WorkspacePreset[] = [];
  for (const [index, item] of value.presets.entries()) {
    const preset = normalizePreset(item, index);
    if (!preset) return { ok: false, error: `Preset ${index + 1} is invalid.` };
    presets.push(preset);
  }
  if (typeof value.selectedPresetId !== "string") return { ok: false, error: "selectedPresetId is missing." };
  return {
    ok: true,
    bundle: {
      schema: WORKSPACE_PRESET_SCHEMA,
      version: 1,
      generatedAt: value.generatedAt,
      scope: "renderer-session",
      selectedPresetId: value.selectedPresetId,
      presets,
      boundary: {
        rendererOnly: true,
        noDurableWrite: true,
        noProviderRequest: true,
        noPermissionGrant: true,
      },
    },
  };
}

export function buildWorkspacePresetBundle(input: {
  presets: readonly WorkspacePreset[];
  selectedPresetId: string;
  generatedAt?: string;
}): WorkspacePresetBundle {
  return {
    schema: WORKSPACE_PRESET_SCHEMA,
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: "renderer-session",
    selectedPresetId: input.selectedPresetId,
    presets: input.presets.map((preset) => ({ ...preset, tags: [...preset.tags], values: { ...preset.values } })),
    boundary: {
      rendererOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noPermissionGrant: true,
    },
  };
}

export function serializeWorkspacePresetBundle(
  bundle: WorkspacePresetBundle,
  format: WorkspacePresetFormat = "json",
): string {
  if (format === "json") return JSON.stringify(bundle, null, 2);
  const lines = [
    "# Omnia workspace preset preview",
    "",
    "> Preview only · renderer-local · no durable write · no provider request.",
    "",
    `- Presets: ${bundle.presets.length}`,
    `- Selected: ${bundle.presets.find((preset) => preset.id === bundle.selectedPresetId)?.name ?? "None"}`,
    `- Generated: ${bundle.generatedAt}`,
    "",
    "## Catalog",
  ];
  for (const preset of bundle.presets) {
    lines.push(`- **${preset.name}** (${preset.kind}, ${preset.status}) — ${preset.description}`);
    lines.push(`  - Tags: ${preset.tags.length > 0 ? preset.tags.join(", ") : "none"}`);
    for (const [key, value] of Object.entries(preset.values)) lines.push(`  - ${key}: ${value}`);
  }
  lines.push("", "## Boundary", "- Renderer-local session preview only.", "- No durable write, provider request, permission grant, or native preset revision.");
  return lines.join("\n");
}

export function parseWorkspacePresetBundle(raw: string): WorkspacePresetParseResult {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return { ok: false, error: "Paste or choose a preset bundle before importing." };
  if (new TextEncoder().encode(source).byteLength > WORKSPACE_PRESET_MAX_BYTES) {
    return { ok: false, error: "Preset bundle exceeds the 512 KB preview limit." };
  }
  try {
    return parseBundle(JSON.parse(source) as unknown);
  } catch {
    return { ok: false, error: "Preset import expects an Omnia JSON bundle; no changes were staged." };
  }
}
