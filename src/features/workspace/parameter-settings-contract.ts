import type { ParameterSettings } from "./types";

/**
 * Renderer-facing contract for the conversation parameter drawer.
 *
 * The store currently owns the live values, while this module owns the
 * vocabulary shared by controls, reset/history actions, and import/export.
 * Keeping the contract data-only makes it safe to reuse from a future native
 * settings surface without coupling it to React, Zustand, or Tauri.
 */

export const PARAMETER_SETTINGS_SCHEMA_VERSION = 1 as const;
export const PARAMETER_SETTINGS_BUNDLE_KIND = "omnia.parameter-settings" as const;

export type ParameterSettingsSchemaVersion = typeof PARAMETER_SETTINGS_SCHEMA_VERSION;
export type ParameterSettingsBundleKind = typeof PARAMETER_SETTINGS_BUNDLE_KIND;
export type ParameterSettingKey = keyof ParameterSettings;
export type ParameterSettingsScope = "chat" | "project" | "profile";
export type ParameterSettingsGroupId =
  | "sampling"
  | "reasoning"
  | "output"
  | "tools"
  | "transport"
  | "provider";
export type ParameterControl = "range" | "number" | "select" | "toggle" | "textarea";

export interface ParameterOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ParameterFieldDefinition {
  readonly key: ParameterSettingKey;
  readonly label: string;
  readonly description: string;
  readonly group: ParameterSettingsGroupId;
  readonly control: ParameterControl;
  readonly defaultValue: ParameterSettings[ParameterSettingKey];
  readonly advanced: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly ParameterOption[];
  /** Whether the value can be sent by every route or needs capability checks. */
  readonly availability: "universal" | "capability" | "preview-only";
}

export interface ParameterSettingsGroupDefinition {
  readonly id: ParameterSettingsGroupId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export const DEFAULT_PARAMETER_SETTINGS: Readonly<ParameterSettings> = Object.freeze({
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  minP: 0,
  maxOutputTokens: 4096,
  reasoningEffort: "medium",
  reasoningBudgetTokens: null,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: null,
  stopSequences: "",
  streaming: true,
  jsonMode: false,
  jsonSchema: "",
  logprobs: false,
  topLogprobs: 0,
  parallelToolCalls: true,
  promptCaching: true,
  toolChoice: "auto",
  serviceTier: "auto",
  timeoutMs: 120000,
  maxRetries: 2,
  providerExtensions: "{}",
});

export const PARAMETER_SETTINGS_GROUPS: readonly ParameterSettingsGroupDefinition[] = [
  {
    id: "sampling",
    label: "Sampling",
    description: "Control variation, probability cut-offs, penalties, and stop sequences.",
    order: 10,
  },
  {
    id: "reasoning",
    label: "Reasoning",
    description: "Choose model reasoning effort and an optional budget.",
    order: 20,
  },
  {
    id: "output",
    label: "Output",
    description: "Set response length, streaming, and structured-output preferences.",
    order: 30,
  },
  {
    id: "tools",
    label: "Tools",
    description: "Choose how compatible models may call tools during a run.",
    order: 40,
  },
  {
    id: "transport",
    label: "Transport & retry",
    description: "Configure request timing and retry behavior for future native routes.",
    order: 50,
  },
  {
    id: "provider",
    label: "Provider extensions",
    description: "Provider-specific switches and namespaced extension payloads.",
    order: 60,
  },
] as const;

const REASONING_OPTIONS: readonly ParameterOption[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Maximum" },
];

const TOOL_CHOICE_OPTIONS: readonly ParameterOption[] = [
  { value: "auto", label: "Auto", description: "Let the model decide when tools are useful." },
  { value: "none", label: "None", description: "Do not allow tool calls for this run." },
  { value: "required", label: "Required", description: "Require a compatible tool call." },
];

const SERVICE_TIER_OPTIONS: readonly ParameterOption[] = [
  { value: "auto", label: "Auto" },
  { value: "default", label: "Default" },
  { value: "priority", label: "Priority" },
  { value: "flex", label: "Flex" },
];

/**
 * All controls are declared once, in drawer order. UI code can render a
 * compact subset by filtering `advanced`, while import/export and reset
 * actions still cover the complete settings vector.
 */
export const PARAMETER_SETTINGS_FIELDS: readonly ParameterFieldDefinition[] = [
  {
    key: "temperature",
    label: "Temperature",
    description: "Higher values make output more varied; lower values make it more deterministic.",
    group: "sampling",
    control: "range",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.temperature,
    advanced: false,
    min: 0,
    max: 2,
    step: 0.05,
    availability: "universal",
  },
  {
    key: "topP",
    label: "Top P",
    description: "Limit sampling to the smallest probability mass that reaches this value.",
    group: "sampling",
    control: "range",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.topP,
    advanced: false,
    min: 0.05,
    max: 1,
    step: 0.05,
    availability: "universal",
  },
  {
    key: "topK",
    label: "Top K",
    description: "Limit sampling to the K most likely next tokens.",
    group: "sampling",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.topK,
    advanced: true,
    min: 0,
    max: 500,
    step: 1,
    availability: "capability",
  },
  {
    key: "minP",
    label: "Min P",
    description: "Drop tokens whose probability is below a fraction of the best token.",
    group: "sampling",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.minP,
    advanced: true,
    min: 0,
    max: 1,
    step: 0.01,
    availability: "capability",
  },
  {
    key: "frequencyPenalty",
    label: "Frequency penalty",
    description: "Discourage tokens that have already appeared frequently in the output.",
    group: "sampling",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.frequencyPenalty,
    advanced: true,
    min: -2,
    max: 2,
    step: 0.1,
    availability: "capability",
  },
  {
    key: "presencePenalty",
    label: "Presence penalty",
    description: "Discourage repeating a token once it has appeared at least once.",
    group: "sampling",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.presencePenalty,
    advanced: true,
    min: -2,
    max: 2,
    step: 0.1,
    availability: "capability",
  },
  {
    key: "seed",
    label: "Seed",
    description: "Use a fixed integer seed where the routed provider supports reproducibility.",
    group: "sampling",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.seed,
    advanced: true,
    min: -2147483648,
    max: 2147483647,
    step: 1,
    availability: "capability",
  },
  {
    key: "stopSequences",
    label: "Stop sequences",
    description: "Stop generation when any non-empty line is encountered.",
    group: "sampling",
    control: "textarea",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.stopSequences,
    advanced: true,
    availability: "capability",
  },
  {
    key: "reasoningEffort",
    label: "Reasoning effort",
    description: "Select the requested reasoning depth when the model advertises reasoning support.",
    group: "reasoning",
    control: "select",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.reasoningEffort,
    advanced: false,
    options: REASONING_OPTIONS,
    availability: "capability",
  },
  {
    key: "reasoningBudgetTokens",
    label: "Reasoning budget",
    description: "Optional token budget for provider-native reasoning implementations.",
    group: "reasoning",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.reasoningBudgetTokens,
    advanced: true,
    min: 0,
    max: 200000,
    step: 1,
    availability: "capability",
  },
  {
    key: "maxOutputTokens",
    label: "Max output tokens",
    description: "Upper bound for visible output tokens in a single response.",
    group: "output",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.maxOutputTokens,
    advanced: false,
    min: 1,
    max: 32768,
    step: 1,
    availability: "universal",
  },
  {
    key: "streaming",
    label: "Stream response",
    description: "Render incremental output as provider deltas arrive.",
    group: "output",
    control: "toggle",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.streaming,
    advanced: false,
    availability: "preview-only",
  },
  {
    key: "jsonMode",
    label: "JSON response",
    description: "Request a structured JSON response from compatible models.",
    group: "output",
    control: "toggle",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.jsonMode,
    advanced: false,
    availability: "capability",
  },
  {
    key: "jsonSchema",
    label: "JSON schema",
    description: "Optional schema for structured output; native translation is not wired in this preview.",
    group: "output",
    control: "textarea",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.jsonSchema,
    advanced: true,
    availability: "preview-only",
  },
  {
    key: "parallelToolCalls",
    label: "Parallel tool calls",
    description: "Allow independent compatible tool calls to be issued together.",
    group: "tools",
    control: "toggle",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.parallelToolCalls,
    advanced: false,
    availability: "capability",
  },
  {
    key: "toolChoice",
    label: "Tool choice",
    description: "Set the canonical tool-use policy for the routed model.",
    group: "tools",
    control: "select",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.toolChoice,
    advanced: true,
    options: TOOL_CHOICE_OPTIONS,
    availability: "capability",
  },
  {
    key: "timeoutMs",
    label: "Timeout",
    description: "Maximum request duration in milliseconds for a future native gateway.",
    group: "transport",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.timeoutMs,
    advanced: true,
    min: 1000,
    max: 1800000,
    step: 1000,
    availability: "preview-only",
  },
  {
    key: "maxRetries",
    label: "Max retries",
    description: "Retry budget for transient failures, subject to provider safety rules.",
    group: "transport",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.maxRetries,
    advanced: true,
    min: 0,
    max: 8,
    step: 1,
    availability: "preview-only",
  },
  {
    key: "logprobs",
    label: "Return log probabilities",
    description: "Request token-level probability observations when the provider supports them.",
    group: "provider",
    control: "toggle",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.logprobs,
    advanced: true,
    availability: "capability",
  },
  {
    key: "topLogprobs",
    label: "Top logprobs",
    description: "Number of alternative token probabilities to include when logprobs are enabled.",
    group: "provider",
    control: "number",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.topLogprobs,
    advanced: true,
    min: 0,
    max: 20,
    step: 1,
    availability: "capability",
  },
  {
    key: "promptCaching",
    label: "Prompt caching",
    description: "Use provider-native cache hints where the selected route supports them.",
    group: "provider",
    control: "toggle",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.promptCaching,
    advanced: true,
    availability: "capability",
  },
  {
    key: "serviceTier",
    label: "Service tier",
    description: "Select a provider service tier when the adapter exposes one.",
    group: "provider",
    control: "select",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.serviceTier,
    advanced: true,
    options: SERVICE_TIER_OPTIONS,
    availability: "capability",
  },
  {
    key: "providerExtensions",
    label: "Provider extensions",
    description: "Namespaced JSON for provider-specific options after capability validation.",
    group: "provider",
    control: "textarea",
    defaultValue: DEFAULT_PARAMETER_SETTINGS.providerExtensions,
    advanced: true,
    availability: "preview-only",
  },
] as const;

export const PARAMETER_SETTINGS_KEYS: readonly ParameterSettingKey[] = PARAMETER_SETTINGS_FIELDS.map(
  (field) => field.key,
);

const PARAMETER_SETTINGS_KEY_SET = new Set<string>(PARAMETER_SETTINGS_KEYS);
const PARAMETER_SETTINGS_FIELD_MAP = new Map<ParameterSettingKey, ParameterFieldDefinition>(
  PARAMETER_SETTINGS_FIELDS.map((field) => [field.key, field]),
);

export interface ParameterSettingsBundle {
  readonly kind: ParameterSettingsBundleKind;
  readonly schemaVersion: ParameterSettingsSchemaVersion;
  readonly scope: ParameterSettingsScope;
  readonly name: string | null;
  readonly exportedAt: string;
  readonly parameters: ParameterSettings;
}

export interface CreateParameterSettingsBundleOptions {
  readonly scope?: ParameterSettingsScope;
  readonly name?: string | null;
  readonly exportedAt?: string;
}

export interface ParameterSettingsImportResult {
  readonly ok: boolean;
  readonly parameters: ParameterSettings;
  readonly changedKeys: readonly ParameterSettingKey[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly sourceVersion: number | null;
}

export function createDefaultParameterSettings(): ParameterSettings {
  return { ...DEFAULT_PARAMETER_SETTINGS };
}

export function parameterField<K extends ParameterSettingKey>(key: K): ParameterFieldDefinition | undefined {
  return PARAMETER_SETTINGS_FIELD_MAP.get(key);
}

export function parameterFieldsForGroup(
  group: ParameterSettingsGroupId,
  options: { readonly advanced?: boolean } = {},
): readonly ParameterFieldDefinition[] {
  return PARAMETER_SETTINGS_FIELDS.filter(
    (field) => field.group === group && (options.advanced === undefined || field.advanced === options.advanced),
  );
}

export function changedParameterKeys(
  parameters: ParameterSettings,
  baseline: ParameterSettings = DEFAULT_PARAMETER_SETTINGS,
): readonly ParameterSettingKey[] {
  return PARAMETER_SETTINGS_KEYS.filter((key) => !Object.is(parameters[key], baseline[key]));
}

export function resetParameterSetting<K extends ParameterSettingKey>(
  parameters: ParameterSettings,
  key: K,
  baseline: ParameterSettings = DEFAULT_PARAMETER_SETTINGS,
): ParameterSettings {
  return { ...parameters, [key]: baseline[key] };
}

export function resetParameterGroup(
  parameters: ParameterSettings,
  group: ParameterSettingsGroupId,
  baseline: ParameterSettings = DEFAULT_PARAMETER_SETTINGS,
): ParameterSettings {
  const next = { ...parameters };
  for (const field of parameterFieldsForGroup(group)) {
    const key = field.key;
    Object.assign(next, { [key]: baseline[key] });
  }
  return next;
}

export function createParameterSettingsBundle(
  parameters: ParameterSettings,
  options: CreateParameterSettingsBundleOptions = {},
): ParameterSettingsBundle {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw new Error("Parameter settings export timestamp must be a valid ISO date.");
  }
  return {
    kind: PARAMETER_SETTINGS_BUNDLE_KIND,
    schemaVersion: PARAMETER_SETTINGS_SCHEMA_VERSION,
    scope: options.scope ?? "chat",
    name: options.name?.trim() || null,
    exportedAt,
    parameters: { ...parameters },
  };
}

export function serializeParameterSettings(
  parameters: ParameterSettings,
  options: CreateParameterSettingsBundleOptions = {},
): string {
  return `${JSON.stringify(createParameterSettingsBundle(parameters, options), null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInput(source: string | unknown): { value: unknown; errors: string[] } {
  if (typeof source !== "string") return { value: source, errors: [] };
  try {
    return { value: JSON.parse(source) as unknown, errors: [] };
  } catch (cause) {
    return {
      value: null,
      errors: [cause instanceof Error ? `Settings JSON is invalid: ${cause.message}` : "Settings JSON is invalid."],
    };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function validateParameterValue(key: ParameterSettingKey, value: unknown): boolean {
  switch (key) {
    case "temperature":
      return isNumberInRange(value, 0, 2);
    case "topP":
      return isNumberInRange(value, 0.05, 1);
    case "topK":
      return isIntegerInRange(value, 0, 500);
    case "minP":
      return isNumberInRange(value, 0, 1);
    case "maxOutputTokens":
      return isIntegerInRange(value, 1, 32768);
    case "reasoningEffort":
      return value === "off" || value === "low" || value === "medium" || value === "high" || value === "max";
    case "reasoningBudgetTokens":
      return value === null || isIntegerInRange(value, 0, 200000);
    case "frequencyPenalty":
    case "presencePenalty":
      return isNumberInRange(value, -2, 2);
    case "seed":
      return value === null || isIntegerInRange(value, -2147483648, 2147483647);
    case "stopSequences":
    case "jsonSchema":
    case "providerExtensions":
      return typeof value === "string";
    case "streaming":
    case "jsonMode":
    case "logprobs":
    case "parallelToolCalls":
    case "promptCaching":
      return typeof value === "boolean";
    case "topLogprobs":
      return isIntegerInRange(value, 0, 20);
    case "toolChoice":
      return value === "auto" || value === "none" || value === "required";
    case "serviceTier":
      return value === "auto" || value === "default" || value === "priority" || value === "flex";
    case "timeoutMs":
      return isIntegerInRange(value, 1000, 1800000);
    case "maxRetries":
      return isIntegerInRange(value, 0, 8);
  }
}

function parameterPayloadFromInput(value: unknown): {
  payload: Record<string, unknown> | null;
  sourceVersion: number | null;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { payload: null, sourceVersion: null, warnings, errors: ["Settings import must be a JSON object."] };
  }

  const sourceVersion = typeof value.schemaVersion === "number" ? value.schemaVersion : null;
  if ("kind" in value && value.kind !== PARAMETER_SETTINGS_BUNDLE_KIND) {
    errors.push(`Unsupported settings bundle kind: ${String(value.kind)}.`);
  }
  if (sourceVersion !== null && sourceVersion > PARAMETER_SETTINGS_SCHEMA_VERSION) {
    errors.push(`Settings bundle version ${sourceVersion} is newer than this preview supports.`);
  }
  if (sourceVersion !== null && (!Number.isInteger(sourceVersion) || sourceVersion < 1)) {
    errors.push("Settings bundle schemaVersion must be a positive integer.");
  }
  if (sourceVersion === null) warnings.push("Imported an unversioned settings object; defaults were used for omitted fields.");

  const parameters = value.parameters;
  if (parameters === undefined) {
    warnings.push("Imported a flat settings object without a `parameters` envelope.");
    return { payload: value, sourceVersion, warnings, errors };
  }
  if (!isRecord(parameters)) {
    errors.push("Settings bundle `parameters` must be an object.");
    return { payload: null, sourceVersion, warnings, errors };
  }
  return { payload: parameters, sourceVersion, warnings, errors };
}

/**
 * Imports either a versioned bundle produced by `serializeParameterSettings`
 * or a flat object for convenient copy/paste. Invalid values are rejected and
 * leave the supplied baseline untouched; nothing is silently clamped.
 */
export function importParameterSettings(
  source: string | unknown,
  baseline: ParameterSettings = createDefaultParameterSettings(),
): ParameterSettingsImportResult {
  const parsed = parseInput(source);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      parameters: { ...baseline },
      changedKeys: [],
      warnings: [],
      errors: parsed.errors,
      sourceVersion: null,
    };
  }

  const envelope = parameterPayloadFromInput(parsed.value);
  const next = { ...baseline };
  const errors = [...envelope.errors];
  const warnings = [...envelope.warnings];
  if (envelope.payload === null) {
    return {
      ok: false,
      parameters: next,
      changedKeys: [],
      warnings,
      errors,
      sourceVersion: envelope.sourceVersion,
    };
  }

  for (const [rawKey, value] of Object.entries(envelope.payload)) {
    if (!PARAMETER_SETTINGS_KEY_SET.has(rawKey)) {
      warnings.push(`Ignored unknown parameter “${rawKey}”.`);
      continue;
    }
    const key = rawKey as ParameterSettingKey;
    if (!validateParameterValue(key, value)) {
      errors.push(`Invalid value for ${key}; the baseline value was kept.`);
      continue;
    }
    Object.assign(next, { [key]: value });
  }

  return {
    ok: errors.length === 0,
    parameters: next,
    changedKeys: changedParameterKeys(next, baseline),
    warnings,
    errors,
    sourceVersion: envelope.sourceVersion,
  };
}
