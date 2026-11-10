/**
 * Renderer-only Project Settings advanced preview.
 *
 * This contract deliberately models settings that are useful to inspect before
 * native Project policy storage exists. It contains no credentials, paths,
 * prompt bodies, permissions, or execution authority.
 */

export const PROJECT_ADVANCED_SETTINGS_SCHEMA = "omnia.project-advanced-settings-preview.v1" as const;

export type ProjectIconId =
  | "terminal"
  | "research"
  | "layers"
  | "spark"
  | "brackets"
  | "flask"
  | "book"
  | "rocket";

export type ProjectRoute =
  | "auto"
  | "quality-first"
  | "balanced"
  | "local-private";

export type ProjectContextMode = "no-roots" | "read-only" | "metadata-only" | "selected-files";
export type ProjectMemoryMode = "off" | "propose" | "auto-low-risk" | "custom";
export type ProjectSkillMode = "inherited" | "curated" | "manual" | "off";
export type ProjectRetention = "forever" | "30-days" | "90-days" | "manual";
export type ProjectExportMode = "redacted" | "metadata-excerpts" | "custom";
export type ProjectLifecycle = "active" | "archived-preview";

export interface ProjectAdvancedSettingsDraft {
  readonly icon: ProjectIconId;
  readonly accent: string;
  readonly route: ProjectRoute;
  readonly parameterPreset: "balanced" | "precise" | "creative" | "custom";
  readonly contextMode: ProjectContextMode;
  readonly memoryMode: ProjectMemoryMode;
  readonly skillMode: ProjectSkillMode;
  readonly retention: ProjectRetention;
  readonly exportMode: ProjectExportMode;
  readonly lifecycle: ProjectLifecycle;
}

export interface ProjectAdvancedPreset {
  readonly id: "coder" | "research" | "design";
  readonly label: string;
  readonly description: string;
  readonly values: ProjectAdvancedSettingsDraft;
}

export const PROJECT_ADVANCED_DEFAULTS: Readonly<ProjectAdvancedSettingsDraft> = Object.freeze({
  icon: "terminal",
  accent: "#23c6b8",
  route: "balanced",
  parameterPreset: "balanced",
  contextMode: "read-only",
  memoryMode: "propose",
  skillMode: "inherited",
  retention: "forever",
  exportMode: "redacted",
  lifecycle: "active",
});

export const PROJECT_ADVANCED_PRESETS: readonly ProjectAdvancedPreset[] = [
  {
    id: "coder",
    label: "Coder workspace",
    description: "Read-only source context, precise parameters, and a curated skill route.",
    values: {
      icon: "brackets",
      accent: "#38bdf8",
      route: "quality-first",
      parameterPreset: "precise",
      contextMode: "selected-files",
      memoryMode: "propose",
      skillMode: "curated",
      retention: "forever",
      exportMode: "redacted",
      lifecycle: "active",
    },
  },
  {
    id: "research",
    label: "Research notebook",
    description: "Evidence-first route with reviewable memory and portable excerpts.",
    values: {
      icon: "research",
      accent: "#f5b94c",
      route: "quality-first",
      parameterPreset: "precise",
      contextMode: "metadata-only",
      memoryMode: "propose",
      skillMode: "inherited",
      retention: "90-days",
      exportMode: "metadata-excerpts",
      lifecycle: "active",
    },
  },
  {
    id: "design",
    label: "Creative studio",
    description: "A colorful, flexible setup for drafts, media prompts, and rapid iteration.",
    values: {
      icon: "spark",
      accent: "#ff7a90",
      route: "balanced",
      parameterPreset: "creative",
      contextMode: "no-roots",
      memoryMode: "off",
      skillMode: "manual",
      retention: "30-days",
      exportMode: "custom",
      lifecycle: "active",
    },
  },
] as const;

export function cloneProjectAdvancedSettings(value: ProjectAdvancedSettingsDraft): ProjectAdvancedSettingsDraft {
  return { ...value };
}

export function equalProjectAdvancedSettings(
  left: ProjectAdvancedSettingsDraft,
  right: ProjectAdvancedSettingsDraft,
): boolean {
  return (Object.keys(PROJECT_ADVANCED_DEFAULTS) as Array<keyof ProjectAdvancedSettingsDraft>).every(
    (key) => left[key] === right[key],
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return isString(value) && options.includes(value as T);
}

const ICONS: readonly ProjectIconId[] = ["terminal", "research", "layers", "spark", "brackets", "flask", "book", "rocket"];
const ROUTES: readonly ProjectRoute[] = ["auto", "quality-first", "balanced", "local-private"];
const CONTEXT_MODES: readonly ProjectContextMode[] = ["no-roots", "read-only", "metadata-only", "selected-files"];
const MEMORY_MODES: readonly ProjectMemoryMode[] = ["off", "propose", "auto-low-risk", "custom"];
const SKILL_MODES: readonly ProjectSkillMode[] = ["inherited", "curated", "manual", "off"];
const RETENTIONS: readonly ProjectRetention[] = ["forever", "30-days", "90-days", "manual"];
const EXPORT_MODES: readonly ProjectExportMode[] = ["redacted", "metadata-excerpts", "custom"];
const LIFECYCLES: readonly ProjectLifecycle[] = ["active", "archived-preview"];
const PARAMETER_PRESETS: readonly ProjectAdvancedSettingsDraft["parameterPreset"][] = ["balanced", "precise", "creative", "custom"];

/**
 * Parse only the known settings vector. Unknown keys and malformed fields are
 * ignored, so importing a future/foreign bundle cannot grant capability.
 */
export function parseProjectAdvancedSettings(value: unknown): ProjectAdvancedSettingsDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.schema !== PROJECT_ADVANCED_SETTINGS_SCHEMA && envelope.schema !== undefined) return null;
  const record = envelope.settings && typeof envelope.settings === "object" && !Array.isArray(envelope.settings)
    ? envelope.settings as Record<string, unknown>
    : envelope;
  const knownKeys = ["icon", "accent", "route", "parameterPreset", "contextMode", "memoryMode", "skillMode", "retention", "exportMode", "lifecycle"];
  if (!knownKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key))) return null;
  const candidate: ProjectAdvancedSettingsDraft = {
    icon: oneOf(record.icon, ICONS) ? record.icon : PROJECT_ADVANCED_DEFAULTS.icon,
    accent: isString(record.accent) && /^#[0-9a-fA-F]{6}$/.test(record.accent) ? record.accent : PROJECT_ADVANCED_DEFAULTS.accent,
    route: oneOf(record.route, ROUTES) ? record.route : PROJECT_ADVANCED_DEFAULTS.route,
    parameterPreset: oneOf(record.parameterPreset, PARAMETER_PRESETS) ? record.parameterPreset : PROJECT_ADVANCED_DEFAULTS.parameterPreset,
    contextMode: oneOf(record.contextMode, CONTEXT_MODES) ? record.contextMode : PROJECT_ADVANCED_DEFAULTS.contextMode,
    memoryMode: oneOf(record.memoryMode, MEMORY_MODES) ? record.memoryMode : PROJECT_ADVANCED_DEFAULTS.memoryMode,
    skillMode: oneOf(record.skillMode, SKILL_MODES) ? record.skillMode : PROJECT_ADVANCED_DEFAULTS.skillMode,
    retention: oneOf(record.retention, RETENTIONS) ? record.retention : PROJECT_ADVANCED_DEFAULTS.retention,
    exportMode: oneOf(record.exportMode, EXPORT_MODES) ? record.exportMode : PROJECT_ADVANCED_DEFAULTS.exportMode,
    lifecycle: oneOf(record.lifecycle, LIFECYCLES) ? record.lifecycle : PROJECT_ADVANCED_DEFAULTS.lifecycle,
  };
  return candidate;
}

export function serializeProjectAdvancedSettings(
  projectId: string,
  projectName: string,
  settings: ProjectAdvancedSettingsDraft,
) {
  return {
    schema: PROJECT_ADVANCED_SETTINGS_SCHEMA,
    scope: "renderer-session" as const,
    projectId,
    projectName,
    settings: cloneProjectAdvancedSettings(settings),
    boundary: "Preview only; renderer-local; no native policy write, permission grant, provider request, filesystem mutation, or durable export receipt.",
  };
}
