export const THEME_PRESET_SCHEMA = "omnia.theme-preset-studio.v1" as const;
export const THEME_PRESET_MAX_BYTES = 256 * 1024;

export type ThemePresetSurface = "graphite" | "slate" | "ink";
export type ThemePresetGeometry = "sharp" | "soft" | "pill";
export type ThemePresetSignal = "solid" | "soft-glow" | "edge";
export type ThemePresetEnergy = "quiet" | "balanced" | "expressive";
export type ThemePresetSource = "builtin" | "session" | "imported";
export type ThemePresetStatus = "active" | "preview" | "planned";
export type ThemePresetFormat = "json" | "markdown";
export type ThemePresetRoleColors = [string, string, string, string];

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  logoId: string;
  logoName: string;
  paletteName: string;
  surface: ThemePresetSurface;
  geometry: ThemePresetGeometry;
  signal: ThemePresetSignal;
  energy: ThemePresetEnergy;
  roleColors: ThemePresetRoleColors;
  source: ThemePresetSource;
  status: ThemePresetStatus;
  updatedAt: string;
}

export interface ThemePresetBundle {
  schema: typeof THEME_PRESET_SCHEMA;
  version: 1;
  generatedAt: string;
  scope: "renderer-session";
  selectedPresetId: string;
  presets: ThemePreset[];
  boundary: {
    rendererOnly: true;
    noDurableWrite: true;
    noProviderRequest: true;
    noNativeThemeMutation: true;
  };
}

export type ThemePresetParseResult =
  | { ok: true; bundle: ThemePresetBundle }
  | { ok: false; error: string };

const SURFACES: readonly ThemePresetSurface[] = ["graphite", "slate", "ink"];
const GEOMETRIES: readonly ThemePresetGeometry[] = ["sharp", "soft", "pill"];
const SIGNALS: readonly ThemePresetSignal[] = ["solid", "soft-glow", "edge"];
const ENERGIES: readonly ThemePresetEnergy[] = ["quiet", "balanced", "expressive"];
const SOURCES: readonly ThemePresetSource[] = ["builtin", "session", "imported"];
const STATUSES: readonly ThemePresetStatus[] = ["active", "preview", "planned"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function hex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function normalizedTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) return null;
  return [...new Set(value.map((tag) => tag.trim().slice(0, 36)).filter(Boolean))].slice(0, 12);
}

function normalizedColors(value: unknown): ThemePresetRoleColors | null {
  if (!Array.isArray(value) || value.length !== 4 || value.some((color) => !hex(color))) return null;
  return value.map((color) => color.trim().toUpperCase()) as ThemePresetRoleColors;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizePreset(value: unknown, index: number): ThemePreset | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim().slice(0, 120) : `imported-theme-${index + 1}`;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 120) : "Imported theme preset";
  const description = typeof value.description === "string" ? value.description.trim().slice(0, 360) : "Imported renderer-local theme preset.";
  const tags = normalizedTags(value.tags);
  const roleColors = normalizedColors(value.roleColors);
  if (!id || !name || !tags || !roleColors) return null;
  if (!oneOf(value.surface, SURFACES) || !oneOf(value.geometry, GEOMETRIES) || !oneOf(value.signal, SIGNALS) || !oneOf(value.energy, ENERGIES)) return null;
  if (typeof value.logoId !== "string" || typeof value.logoName !== "string" || typeof value.paletteName !== "string") return null;
  return {
    id,
    name,
    description,
    tags,
    logoId: value.logoId.trim().slice(0, 120),
    logoName: value.logoName.trim().slice(0, 120),
    paletteName: value.paletteName.trim().slice(0, 120),
    surface: value.surface,
    geometry: value.geometry,
    signal: value.signal,
    energy: value.energy,
    roleColors,
    source: oneOf(value.source, SOURCES) ? value.source : "imported",
    status: oneOf(value.status, STATUSES) ? value.status : "preview",
    updatedAt: validDate(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function buildThemePresetBundle(input: {
  presets: readonly ThemePreset[];
  selectedPresetId: string;
  generatedAt?: string;
}): ThemePresetBundle {
  return {
    schema: THEME_PRESET_SCHEMA,
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: "renderer-session",
    selectedPresetId: input.selectedPresetId,
    presets: input.presets.map((preset) => ({ ...preset, tags: [...preset.tags], roleColors: [...preset.roleColors] as ThemePresetRoleColors })),
    boundary: {
      rendererOnly: true,
      noDurableWrite: true,
      noProviderRequest: true,
      noNativeThemeMutation: true,
    },
  };
}

export function serializeThemePresetBundle(bundle: ThemePresetBundle, format: ThemePresetFormat = "json"): string {
  if (format === "json") return JSON.stringify(bundle, null, 2);
  const lines = [
    "# Omnia theme preset studio preview",
    "",
    "> Preview only · renderer-local · reversible in this session · no native theme mutation.",
    "",
    `- Presets: ${bundle.presets.length}`,
    `- Selected: ${bundle.presets.find((preset) => preset.id === bundle.selectedPresetId)?.name ?? "None"}`,
    `- Generated: ${bundle.generatedAt}`,
    "",
    "## Catalog",
  ];
  for (const preset of bundle.presets) {
    lines.push(`- **${preset.name}** (${preset.status}) — ${preset.description}`);
    lines.push(`  - Logo: ${preset.logoName} · palette: ${preset.paletteName}`);
    lines.push(`  - Surface: ${preset.surface} · geometry: ${preset.geometry} · signal: ${preset.signal} · energy: ${preset.energy}`);
    lines.push(`  - Roles: ${preset.roleColors.join(", ")}`);
    lines.push(`  - Tags: ${preset.tags.length > 0 ? preset.tags.join(", ") : "none"}`);
  }
  lines.push("", "## Boundary", "- Renderer-local session preview only.", "- No durable write, provider request, native theme mutation, or permission grant.");
  return lines.join("\n");
}

export function parseThemePresetBundle(raw: string): ThemePresetParseResult {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return { ok: false, error: "Choose or paste a theme preset bundle before importing." };
  if (new TextEncoder().encode(source).byteLength > THEME_PRESET_MAX_BYTES) return { ok: false, error: "Theme preset bundle exceeds the 256 KB preview limit." };
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value) || value.schema !== THEME_PRESET_SCHEMA || value.version !== 1) return { ok: false, error: "Unsupported Omnia theme preset schema or version." };
    if (value.scope !== "renderer-session" || !validDate(value.generatedAt) || typeof value.selectedPresetId !== "string") return { ok: false, error: "Theme preset scope, generatedAt, or selectedPresetId is invalid." };
    if (!Array.isArray(value.presets) || value.presets.length > 80) return { ok: false, error: "Theme preset bundle must contain between 0 and 80 presets." };
    const presets: ThemePreset[] = [];
    for (const [index, item] of value.presets.entries()) {
      const preset = normalizePreset(item, index);
      if (!preset) return { ok: false, error: `Theme preset ${index + 1} is invalid.` };
      presets.push(preset);
    }
    return {
      ok: true,
      bundle: buildThemePresetBundle({ presets, selectedPresetId: value.selectedPresetId, generatedAt: value.generatedAt }),
    };
  } catch {
    return { ok: false, error: "Theme preset import expects an Omnia JSON bundle; no changes were staged." };
  }
}

export function themePresetDifferenceKeys(left: ThemePreset, right: ThemePreset): string[] {
  const keys: Array<keyof ThemePreset> = ["logoName", "paletteName", "surface", "geometry", "signal", "energy"];
  return keys.filter((key) => left[key] !== right[key]).map((key) => String(key));
}
