export const MODEL_ROUTE_PRESET_SCHEMA = "omnia.model-route-preset-preview.v1" as const;
export const MAX_MODEL_ROUTE_PRESET_IMPORT_BYTES = 64 * 1024;
export const MAX_IMPORTED_MODEL_ROUTE_PRESETS = 20;

export type ModelRoutePreference = "auto" | "quality" | "balanced" | "local";
export type ModelRouteFallbackConsent = "never" | "same-connection" | "approved-connections";
export type ContextDeliveryMode = "auto" | "full" | "summary-plus-sources" | "manifest-only" | "retrieval-on-demand";
export type ReasoningEffort = "auto" | "low" | "medium" | "high";
export type DataResidency = "any" | "local-only" | "same-region";

export type ModelRoutePreset = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tone: "blue" | "teal" | "amber" | "coral" | "violet" | "custom";
  readonly modelProfileId: string;
  readonly preference: ModelRoutePreference;
  readonly consent: ModelRouteFallbackConsent;
  readonly contextMode: ContextDeliveryMode;
  readonly reasoningEffort: ReasoningEffort;
  readonly dataResidency: DataResidency;
  readonly qualityFloor: number;
  readonly maxLatencyMs: number | null;
  readonly custom?: boolean;
};

export const BUILT_IN_MODEL_ROUTE_PRESETS: readonly ModelRoutePreset[] = [
  {
    id: "route-general",
    name: "General · Auto",
    description: "A broad default that leaves model selection to the current automatic policy.",
    tone: "blue",
    modelProfileId: "auto",
    preference: "auto",
    consent: "never",
    contextMode: "auto",
    reasoningEffort: "auto",
    dataResidency: "any",
    qualityFloor: 70,
    maxLatencyMs: 1200,
  },
  {
    id: "route-coder-fast",
    name: "Coder · Fast",
    description: "Keep feedback quick for implementation loops while retaining a usable quality floor.",
    tone: "teal",
    modelProfileId: "local-fast",
    preference: "local",
    consent: "never",
    contextMode: "summary-plus-sources",
    reasoningEffort: "medium",
    dataResidency: "local-only",
    qualityFloor: 65,
    maxLatencyMs: 500,
  },
  {
    id: "route-research-grounded",
    name: "Research · Grounded",
    description: "Favor long context and source anchors before considering an approved fallback.",
    tone: "amber",
    modelProfileId: "long-context",
    preference: "quality",
    consent: "approved-connections",
    contextMode: "full",
    reasoningEffort: "high",
    dataResidency: "same-region",
    qualityFloor: 88,
    maxLatencyMs: 1500,
  },
  {
    id: "route-private-local",
    name: "Private · Local",
    description: "Keep the candidate and context delivery policy local-first for sensitive drafts.",
    tone: "violet",
    modelProfileId: "local-fast",
    preference: "local",
    consent: "never",
    contextMode: "manifest-only",
    reasoningEffort: "medium",
    dataResidency: "local-only",
    qualityFloor: 60,
    maxLatencyMs: 800,
  },
  {
    id: "route-multimodal",
    name: "Multimodal · Flexible",
    description: "Pin a vision-capable model and preserve a reviewable route if it becomes unavailable.",
    tone: "coral",
    modelProfileId: "quality",
    preference: "quality",
    consent: "same-connection",
    contextMode: "retrieval-on-demand",
    reasoningEffort: "high",
    dataResidency: "any",
    qualityFloor: 82,
    maxLatencyMs: 1200,
  },
];

export type ModelRoutePresetExportFormat = "json" | "markdown";

type ModelRoutePresetExport = {
  readonly schema: typeof MODEL_ROUTE_PRESET_SCHEMA;
  readonly scope: "renderer-session";
  readonly executionDisposition: "preview-only";
  readonly currentPresetId: string;
  readonly presets: readonly ModelRoutePreset[];
  readonly boundary: readonly string[];
};

const boundary = [
  "Renderer-session preview only",
  "No native routing policy was written",
  "No provider request, fallback attempt, or context freeze was dispatched",
  "No durable preset or route receipt was created",
] as const;

export function serializeModelRoutePresetPreview(
  presets: readonly ModelRoutePreset[],
  currentPresetId: string,
  format: ModelRoutePresetExportFormat,
): string {
  const payload: ModelRoutePresetExport = {
    schema: MODEL_ROUTE_PRESET_SCHEMA,
    scope: "renderer-session",
    executionDisposition: "preview-only",
    currentPresetId,
    presets: presets.map((preset) => ({ ...preset, custom: Boolean(preset.custom) })),
    boundary,
  };
  if (format === "json") return JSON.stringify(payload, null, 2);

  const rows = payload.presets.length > 0
    ? payload.presets.map((preset) => `- ${preset.name}: ${preset.modelProfileId}, ${preset.contextMode}, ${preset.reasoningEffort}, ${preset.dataResidency}`).join("\n")
    : "- No route presets in this renderer session.";
  return [
    "# Omnia model route preset preview",
    "",
    `Current preset: ${payload.currentPresetId}`,
    "",
    "## Presets",
    rows,
    "",
    "## Boundary",
    ...boundary.map((entry) => `- ${entry}`),
  ].join("\n");
}

export type ImportedModelRoutePreset = Omit<ModelRoutePreset, "custom"> & { readonly custom: true };
export type ModelRoutePresetImportResult =
  | { readonly ok: true; readonly presets: ImportedModelRoutePreset[] }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreference(value: unknown): value is ModelRoutePreference {
  return value === "auto" || value === "quality" || value === "balanced" || value === "local";
}

function isConsent(value: unknown): value is ModelRouteFallbackConsent {
  return value === "never" || value === "same-connection" || value === "approved-connections";
}

function isContextMode(value: unknown): value is ContextDeliveryMode {
  return value === "auto" || value === "full" || value === "summary-plus-sources" || value === "manifest-only" || value === "retrieval-on-demand";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

function isDataResidency(value: unknown): value is DataResidency {
  return value === "any" || value === "local-only" || value === "same-region";
}

function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function parseModelRoutePresetPreviewImport(text: string): ModelRoutePresetImportResult {
  if (new TextEncoder().encode(text).byteLength > MAX_MODEL_ROUTE_PRESET_IMPORT_BYTES) {
    return { ok: false, reason: `Import is larger than ${MAX_MODEL_ROUTE_PRESET_IMPORT_BYTES / 1024} KB.` };
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Import must be valid JSON." };
  }
  if (!isRecord(input) || input.schema !== MODEL_ROUTE_PRESET_SCHEMA || input.scope !== "renderer-session" || input.executionDisposition !== "preview-only" || !Array.isArray(input.presets)) {
    return { ok: false, reason: "This is not a supported Omnia model route preset preview bundle." };
  }
  if (input.presets.length === 0 || input.presets.length > MAX_IMPORTED_MODEL_ROUTE_PRESETS) {
    return { ok: false, reason: `Choose between 1 and ${MAX_IMPORTED_MODEL_ROUTE_PRESETS} route presets.` };
  }

  const names = new Set<string>();
  const presets: ImportedModelRoutePreset[] = [];
  for (const [index, candidate] of input.presets.entries()) {
    if (!isRecord(candidate)
      || typeof candidate.name !== "string"
      || !candidate.name.trim()
      || candidate.name.trim().length > 80
      || typeof candidate.description !== "string"
      || !isPreference(candidate.preference)
      || !isConsent(candidate.consent)
      || !isContextMode(candidate.contextMode)
      || !isReasoningEffort(candidate.reasoningEffort)
      || !isDataResidency(candidate.dataResidency)
      || typeof candidate.modelProfileId !== "string"
      || candidate.modelProfileId.length === 0
      || candidate.modelProfileId.length > 160
      || !boundedNumber(candidate.qualityFloor, 0, 100)
      || !(candidate.maxLatencyMs === null || boundedNumber(candidate.maxLatencyMs, 100, 10_000))) {
      return { ok: false, reason: `Route preset ${index + 1} has invalid or missing fields.` };
    }
    const name = candidate.name.trim();
    const normalizedName = name.toLocaleLowerCase();
    if (names.has(normalizedName)) return { ok: false, reason: `The import contains duplicate preset name “${name}”.` };
    names.add(normalizedName);
    presets.push({
      id: `route-import-${index}-${normalizedName.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset"}`,
      name,
      description: candidate.description.trim().slice(0, 240) || "Imported renderer-local route preset.",
      tone: "custom",
      modelProfileId: candidate.modelProfileId,
      preference: candidate.preference,
      consent: candidate.consent,
      contextMode: candidate.contextMode,
      reasoningEffort: candidate.reasoningEffort,
      dataResidency: candidate.dataResidency,
      qualityFloor: candidate.qualityFloor,
      maxLatencyMs: candidate.maxLatencyMs,
      custom: true,
    });
  }
  return { ok: true, presets };
}
