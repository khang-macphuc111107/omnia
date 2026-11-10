export const SETTINGS_RECOVERY_SCHEMA = "omnia.settings-recovery.preview.v1" as const;
export const SETTINGS_RECOVERY_MAX_BYTES = 128 * 1024;

export type RecoveryGroupId = "appearance" | "composer" | "permissions" | "context" | "toolchain";

export type SettingsRecoveryGroups = {
  appearance: {
    theme: "Graphite dark" | "Slate dark" | "Ink dark";
    accentHex: string;
    density: "Comfortable" | "Compact" | "Spacious";
    motion: "Reduced" | "Standard" | "Full";
  };
  composer: {
    format: "Markdown" | "Rich Markdown" | "Document";
    math: boolean;
    toolbar: "Essential" | "Expanded" | "Custom";
    textScale: number;
  };
  permissions: {
    approval: "Ask each time" | "Ask on writes" | "Review after";
    terminal: "Ask every run" | "Allow in project" | "Disabled";
    network: "Ask per endpoint" | "Allow configured" | "Disabled";
    allowAll: boolean;
  };
  context: {
    scope: "Active chat" | "Active project" | "Workspace";
    includeMemory: boolean;
    tokenBudget: number;
    retentionDays: number;
  };
  toolchain: {
    compilerHint: string;
    autoDetect: boolean;
    browserApproval: "Ask before access" | "Ask on navigation" | "Disabled";
    pluginPolicy: "Manual activation" | "Ask each time" | "Allow selected";
  };
};

export type SettingsRecoverySnapshot = {
  schema: typeof SETTINGS_RECOVERY_SCHEMA;
  version: 1;
  label: string;
  createdAt: string;
  groups: Partial<SettingsRecoveryGroups>;
  executionDisposition: "preview-only";
  durableWrite: false;
};

export type SettingsRecoveryParseResult =
  | { ok: true; snapshot: SettingsRecoverySnapshot }
  | { ok: false; error: string };

export const RECOVERY_GROUPS: readonly RecoveryGroupId[] = [
  "appearance",
  "composer",
  "permissions",
  "context",
  "toolchain",
];

export const DEFAULT_SETTINGS_RECOVERY: SettingsRecoveryGroups = {
  appearance: { theme: "Graphite dark", accentHex: "#4F8CFF", density: "Comfortable", motion: "Reduced" },
  composer: { format: "Rich Markdown", math: true, toolbar: "Expanded", textScale: 100 },
  permissions: { approval: "Ask on writes", terminal: "Ask every run", network: "Ask per endpoint", allowAll: false },
  context: { scope: "Active project", includeMemory: true, tokenBudget: 64000, retentionDays: 30 },
  toolchain: { compilerHint: "Not detected · preview only", autoDetect: false, browserApproval: "Ask before access", pluginPolicy: "Manual activation" },
};

const GROUP_KEYS: Record<RecoveryGroupId, readonly string[]> = {
  appearance: ["theme", "accentHex", "density", "motion"],
  composer: ["format", "math", "toolbar", "textScale"],
  permissions: ["approval", "terminal", "network", "allowAll"],
  context: ["scope", "includeMemory", "tokenBudget", "retentionDays"],
  toolchain: ["compilerHint", "autoDetect", "browserApproval", "pluginPolicy"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function validateGroup(group: RecoveryGroupId, raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !GROUP_KEYS[group].includes(key))) return null;
  const checked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    let valid = false;
    switch (`${group}.${key}`) {
      case "appearance.theme": valid = oneOf(value, ["Graphite dark", "Slate dark", "Ink dark"]); break;
      case "appearance.accentHex": valid = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value); break;
      case "appearance.density": valid = oneOf(value, ["Comfortable", "Compact", "Spacious"]); break;
      case "appearance.motion": valid = oneOf(value, ["Reduced", "Standard", "Full"]); break;
      case "composer.format": valid = oneOf(value, ["Markdown", "Rich Markdown", "Document"]); break;
      case "composer.math": valid = typeof value === "boolean"; break;
      case "composer.toolbar": valid = oneOf(value, ["Essential", "Expanded", "Custom"]); break;
      case "composer.textScale": valid = typeof value === "number" && Number.isInteger(value) && value >= 80 && value <= 150; break;
      case "permissions.approval": valid = oneOf(value, ["Ask each time", "Ask on writes", "Review after"]); break;
      case "permissions.terminal": valid = oneOf(value, ["Ask every run", "Allow in project", "Disabled"]); break;
      case "permissions.network": valid = oneOf(value, ["Ask per endpoint", "Allow configured", "Disabled"]); break;
      case "permissions.allowAll": valid = typeof value === "boolean"; break;
      case "context.scope": valid = oneOf(value, ["Active chat", "Active project", "Workspace"]); break;
      case "context.includeMemory": valid = typeof value === "boolean"; break;
      case "context.tokenBudget": valid = typeof value === "number" && Number.isInteger(value) && value >= 4096 && value <= 1_000_000; break;
      case "context.retentionDays": valid = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3650; break;
      case "toolchain.compilerHint": valid = typeof value === "string" && value.length <= 120 && !/[\r\n\0]/.test(value); break;
      case "toolchain.autoDetect": valid = typeof value === "boolean"; break;
      case "toolchain.browserApproval": valid = oneOf(value, ["Ask before access", "Ask on navigation", "Disabled"]); break;
      case "toolchain.pluginPolicy": valid = oneOf(value, ["Manual activation", "Ask each time", "Allow selected"]); break;
    }
    if (!valid) return null;
    checked[key] = value;
  }
  return checked;
}

export function buildSettingsRecoverySnapshot(
  groups: Partial<SettingsRecoveryGroups>,
  label = "Omnia settings preview",
  createdAt = new Date().toISOString(),
): SettingsRecoverySnapshot {
  return {
    schema: SETTINGS_RECOVERY_SCHEMA,
    version: 1,
    label: label.trim().slice(0, 80) || "Omnia settings preview",
    createdAt,
    groups: structuredClone(groups),
    executionDisposition: "preview-only",
    durableWrite: false,
  };
}

export function serializeSettingsRecoverySnapshot(snapshot: SettingsRecoverySnapshot, format: "json" | "markdown" = "json"): string {
  if (format === "json") return JSON.stringify(snapshot, null, 2);
  const rows = RECOVERY_GROUPS.flatMap((group) => {
    const value = snapshot.groups[group];
    return value ? [`## ${group}`, ...Object.entries(value).map(([key, setting]) => `- ${key}: ${String(setting)}`), ""] : [];
  });
  return [`# ${snapshot.label}`, "", `Created: ${snapshot.createdAt}`, "", "> Preview only · renderer-local · no durable settings write.", "", ...rows].join("\n");
}

export function parseSettingsRecoverySnapshot(raw: string): SettingsRecoveryParseResult {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return { ok: false, error: "Paste or choose a settings bundle before staging it." };
  if (new TextEncoder().encode(source).byteLength > SETTINGS_RECOVERY_MAX_BYTES) {
    return { ok: false, error: "Settings bundle exceeds the 128 KB preview limit." };
  }
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value) || value.schema !== SETTINGS_RECOVERY_SCHEMA || value.version !== 1) {
      return { ok: false, error: "Unsupported Omnia settings schema or version." };
    }
    if (typeof value.label !== "string" || value.label.length > 80 || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
      return { ok: false, error: "Settings bundle label or timestamp is invalid." };
    }
    if (value.executionDisposition !== "preview-only" || value.durableWrite !== false || !isRecord(value.groups)) {
      return { ok: false, error: "Only renderer-local preview settings can be staged here." };
    }
    if (Object.keys(value.groups).some((key) => !RECOVERY_GROUPS.includes(key as RecoveryGroupId))) {
      return { ok: false, error: "Settings bundle contains an unsupported category." };
    }
    const groups: Partial<SettingsRecoveryGroups> = {};
    for (const group of RECOVERY_GROUPS) {
      const rawGroup = value.groups[group];
      if (rawGroup === undefined) continue;
      const checked = validateGroup(group, rawGroup);
      if (!checked) return { ok: false, error: `Settings in ${group} are invalid; nothing was staged.` };
      Object.assign(groups, { [group]: checked });
    }
    if (Object.keys(groups).length === 0) return { ok: false, error: "Bundle has no settings categories to stage." };
    return { ok: true, snapshot: buildSettingsRecoverySnapshot(groups, value.label, value.createdAt) };
  } catch {
    return { ok: false, error: "Settings import expects a valid Omnia JSON bundle; nothing was staged." };
  }
}
