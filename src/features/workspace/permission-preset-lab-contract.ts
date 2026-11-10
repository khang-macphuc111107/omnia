import {
  PERMISSION_PRESETS,
  PERMISSION_SCOPE_LABELS,
  type PermissionMode,
  type PermissionPreset,
  type PermissionScope,
  type PermissionValues,
} from "./session-permission-contract";

export type PermissionPresetExpiry = "session" | "one-hour" | "one-day" | "custom" | "until-revoked";
export type PermissionPresetQuota = "unlimited" | "per-run" | "daily" | "custom";
export type PermissionPresetAudit = "minimal" | "standard" | "verbose";
export type PermissionPresetRevoke = "manual" | "after-run" | "on-expiry" | "on-error";
export type PermissionPresetScopeMode = "selected" | "all";
export type PermissionPresetLifecycleState = "draft" | "staged" | "revoked";

export const PERMISSION_PRESET_LAB_SCHEMA = "omnia.permission-preset-lab.preview.v1" as const;
export const PERMISSION_PRESET_LAB_VERSION = 1 as const;
export const PERMISSION_PRESET_LAB_BOUNDARY =
  "Renderer-local preset lifecycle preview only; no native grant, approval receipt, provider request, OS permission, or durable policy write was performed.";

export const PERMISSION_PRESET_EXPIRY_OPTIONS: readonly PermissionPresetExpiry[] = [
  "session",
  "one-hour",
  "one-day",
  "custom",
  "until-revoked",
];

export const PERMISSION_PRESET_QUOTA_OPTIONS: readonly PermissionPresetQuota[] = [
  "unlimited",
  "per-run",
  "daily",
  "custom",
];

export const PERMISSION_PRESET_AUDIT_OPTIONS: readonly PermissionPresetAudit[] = ["minimal", "standard", "verbose"];
export const PERMISSION_PRESET_REVOKE_OPTIONS: readonly PermissionPresetRevoke[] = ["manual", "after-run", "on-expiry", "on-error"];

export interface PermissionPresetLabDraft {
  readonly presetId: string;
  readonly permissionScope: PermissionScope;
  readonly scopeMode: PermissionPresetScopeMode;
  readonly expiry: PermissionPresetExpiry;
  readonly customExpiry: string;
  readonly quota: PermissionPresetQuota;
  readonly quotaValue: number;
  readonly audit: PermissionPresetAudit;
  readonly revoke: PermissionPresetRevoke;
  readonly state: PermissionPresetLifecycleState;
  readonly note: string;
}

export interface PermissionPresetLabPayload {
  readonly scope: typeof PERMISSION_PRESET_LAB_SCHEMA;
  readonly version: typeof PERMISSION_PRESET_LAB_VERSION;
  readonly presetId: string;
  readonly presetLabel: string;
  readonly permissionScope: PermissionScope;
  readonly scopeMode: PermissionPresetScopeMode;
  readonly permissions: PermissionValues;
  readonly lifecycle: {
    readonly state: PermissionPresetLifecycleState;
    readonly expiry: PermissionPresetExpiry;
    readonly customExpiry: string;
    readonly quota: PermissionPresetQuota;
    readonly quotaValue: number;
    readonly audit: PermissionPresetAudit;
    readonly revoke: PermissionPresetRevoke;
  };
  readonly note: string;
  readonly boundary: typeof PERMISSION_PRESET_LAB_BOUNDARY;
}

export type PermissionPresetLabDiffKey =
  | "presetId"
  | "permissionScope"
  | "scopeMode"
  | "expiry"
  | "customExpiry"
  | "quota"
  | "quotaValue"
  | "audit"
  | "revoke"
  | "state"
  | "note";

export interface PermissionPresetLabDiff {
  readonly key: PermissionPresetLabDiffKey;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

export const DEFAULT_PERMISSION_PRESET_LAB_DRAFT: PermissionPresetLabDraft = {
  presetId: "balanced",
  permissionScope: "workspace",
  scopeMode: "selected",
  expiry: "until-revoked",
  customExpiry: "",
  quota: "unlimited",
  quotaValue: 100,
  audit: "standard",
  revoke: "manual",
  state: "draft",
  note: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionScope(value: unknown): value is PermissionScope {
  return value === "session" || value === "chat" || value === "project" || value === "workspace";
}

function isPresetExpiry(value: unknown): value is PermissionPresetExpiry {
  return PERMISSION_PRESET_EXPIRY_OPTIONS.includes(value as PermissionPresetExpiry);
}

function isPresetQuota(value: unknown): value is PermissionPresetQuota {
  return PERMISSION_PRESET_QUOTA_OPTIONS.includes(value as PermissionPresetQuota);
}

function isPresetAudit(value: unknown): value is PermissionPresetAudit {
  return PERMISSION_PRESET_AUDIT_OPTIONS.includes(value as PermissionPresetAudit);
}

function isPresetRevoke(value: unknown): value is PermissionPresetRevoke {
  return PERMISSION_PRESET_REVOKE_OPTIONS.includes(value as PermissionPresetRevoke);
}

function presetForId(id: string): PermissionPreset {
  return PERMISSION_PRESETS.find((preset) => preset.id === id) ?? PERMISSION_PRESETS[0]!;
}

export function permissionPresetForDraft(draft: PermissionPresetLabDraft): PermissionPreset {
  return presetForId(draft.presetId);
}

export function permissionPresetLabelForDraft(draft: PermissionPresetLabDraft): string {
  return permissionPresetForDraft(draft).label;
}

export function permissionPresetScopeLabel(draft: PermissionPresetLabDraft): string {
  return draft.scopeMode === "all" ? "All preview scopes" : PERMISSION_SCOPE_LABELS[draft.permissionScope];
}

export function permissionPresetExpiryLabel(draft: PermissionPresetLabDraft): string {
  if (draft.expiry === "session") return "Current session";
  if (draft.expiry === "one-hour") return "1 hour";
  if (draft.expiry === "one-day") return "24 hours";
  if (draft.expiry === "custom") return draft.customExpiry ? `Until ${draft.customExpiry}` : "Custom time needed";
  return "Until revoked";
}

export function permissionPresetQuotaLabel(draft: PermissionPresetLabDraft): string {
  if (draft.quota === "unlimited") return "No quota";
  if (draft.quota === "per-run") return "1 run";
  if (draft.quota === "daily") return `${draft.quotaValue} actions / day`;
  return draft.quotaValue > 0 ? `${draft.quotaValue} actions` : "Custom quota needed";
}

export function permissionPresetAuditLabel(audit: PermissionPresetAudit): string {
  return audit === "minimal" ? "Minimal" : audit === "verbose" ? "Verbose" : "Standard";
}

export function permissionPresetRevokeLabel(revoke: PermissionPresetRevoke): string {
  if (revoke === "after-run") return "After one run";
  if (revoke === "on-expiry") return "When expiry is reached";
  if (revoke === "on-error") return "On policy error";
  return "Manual revoke";
}

export function normalizePermissionPresetLabDraft(
  value: Partial<PermissionPresetLabDraft> | undefined,
  fallback: PermissionPresetLabDraft = DEFAULT_PERMISSION_PRESET_LAB_DRAFT,
): PermissionPresetLabDraft {
  const next = { ...fallback, ...(value ?? {}) };
  const quotaValue = Number.isFinite(next.quotaValue) ? Math.max(1, Math.min(100_000, Math.round(next.quotaValue))) : fallback.quotaValue;
  return {
    presetId: typeof next.presetId === "string" && PERMISSION_PRESETS.some((preset) => preset.id === next.presetId) ? next.presetId : fallback.presetId,
    permissionScope: isPermissionScope(next.permissionScope) ? next.permissionScope : fallback.permissionScope,
    scopeMode: next.scopeMode === "all" ? "all" : "selected",
    expiry: isPresetExpiry(next.expiry) ? next.expiry : fallback.expiry,
    customExpiry: typeof next.customExpiry === "string" ? next.customExpiry.slice(0, 80) : fallback.customExpiry,
    quota: isPresetQuota(next.quota) ? next.quota : fallback.quota,
    quotaValue,
    audit: isPresetAudit(next.audit) ? next.audit : fallback.audit,
    revoke: isPresetRevoke(next.revoke) ? next.revoke : fallback.revoke,
    state: next.state === "staged" || next.state === "revoked" ? next.state : "draft",
    note: typeof next.note === "string" ? next.note.slice(0, 500) : fallback.note,
  };
}

export function permissionPresetDraftEqual(left: PermissionPresetLabDraft, right: PermissionPresetLabDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function permissionPresetDiffValue(draft: PermissionPresetLabDraft, key: PermissionPresetLabDiffKey): string {
  if (key === "presetId") return permissionPresetForDraft(draft).label;
  if (key === "permissionScope") return PERMISSION_SCOPE_LABELS[draft.permissionScope];
  if (key === "scopeMode") return draft.scopeMode === "all" ? "All preview scopes" : "Selected scope";
  if (key === "expiry") return permissionPresetExpiryLabel(draft);
  if (key === "customExpiry") return draft.customExpiry || "None";
  if (key === "quota") return draft.quota === "unlimited" ? "No quota" : draft.quota === "per-run" ? "One run" : draft.quota === "daily" ? "Daily quota" : "Custom quota";
  if (key === "quotaValue") return String(draft.quotaValue);
  if (key === "audit") return permissionPresetAuditLabel(draft.audit);
  if (key === "revoke") return permissionPresetRevokeLabel(draft.revoke);
  if (key === "state") return draft.state;
  return draft.note || "None";
}

const permissionPresetDiffFields: ReadonlyArray<readonly [PermissionPresetLabDiffKey, string]> = [
  ["presetId", "Preset"],
  ["permissionScope", "Scope"],
  ["scopeMode", "Scope mode"],
  ["expiry", "Expiry"],
  ["customExpiry", "Custom expiry"],
  ["quota", "Quota"],
  ["quotaValue", "Quota amount"],
  ["audit", "Audit detail"],
  ["revoke", "Revoke rule"],
  ["state", "Lifecycle state"],
  ["note", "Operator note"],
];

export function permissionPresetLabDiff(before: PermissionPresetLabDraft, after: PermissionPresetLabDraft): PermissionPresetLabDiff[] {
  return permissionPresetDiffFields.flatMap(([key, label]) => {
    const beforeValue = permissionPresetDiffValue(before, key);
    const afterValue = permissionPresetDiffValue(after, key);
    return beforeValue === afterValue ? [] : [{ key, label, before: beforeValue, after: afterValue }];
  });
}

export function safePermissionPresetLabPayload(draft: PermissionPresetLabDraft): PermissionPresetLabPayload {
  const preset = permissionPresetForDraft(draft);
  return {
    scope: PERMISSION_PRESET_LAB_SCHEMA,
    version: PERMISSION_PRESET_LAB_VERSION,
    presetId: preset.id,
    presetLabel: preset.label,
    permissionScope: draft.permissionScope,
    scopeMode: draft.scopeMode,
    permissions: { ...preset.values },
    lifecycle: {
      state: draft.state,
      expiry: draft.expiry,
      customExpiry: draft.customExpiry,
      quota: draft.quota,
      quotaValue: draft.quotaValue,
      audit: draft.audit,
      revoke: draft.revoke,
    },
    note: draft.note,
    boundary: PERMISSION_PRESET_LAB_BOUNDARY,
  };
}

export function serializePermissionPresetLab(draft: PermissionPresetLabDraft, format: "json" | "markdown"): string {
  const payload = safePermissionPresetLabPayload(draft);
  if (format === "json") return JSON.stringify(payload, null, 2);
  return [
    "# Omnia permission preset lifecycle preview",
    "",
    `- Preset: ${payload.presetLabel}`,
    `- Scope: ${permissionPresetScopeLabel(draft)}`,
    `- Scope target: ${PERMISSION_SCOPE_LABELS[draft.permissionScope]}`,
    `- Scope mode: ${draft.scopeMode}`,
    `- State: ${payload.lifecycle.state}`,
    `- Expiry: ${permissionPresetExpiryLabel(draft)}`,
    `- Quota: ${permissionPresetQuotaLabel(draft)}`,
    `- Audit: ${permissionPresetAuditLabel(draft.audit)}`,
    `- Revoke: ${permissionPresetRevokeLabel(draft.revoke)}`,
    `- Note: ${payload.note || "None"}`,
    "",
    `> ${PERMISSION_PRESET_LAB_BOUNDARY}`,
  ].join("\n");
}

function parsePermissionPresetLabJson(raw: string): PermissionPresetLabDraft | null {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed) || parsed.scope !== PERMISSION_PRESET_LAB_SCHEMA || parsed.version !== PERMISSION_PRESET_LAB_VERSION) return null;
    const lifecycle = isRecord(parsed.lifecycle) ? parsed.lifecycle : {};
    const presetId = typeof parsed.presetId === "string" ? parsed.presetId : "balanced";
    if (!PERMISSION_PRESETS.some((preset) => preset.id === presetId)) return null;
    return normalizePermissionPresetLabDraft({
      presetId,
      permissionScope: isPermissionScope(parsed.permissionScope) ? parsed.permissionScope : "workspace",
      scopeMode: parsed.scopeMode === "all" ? "all" : "selected",
      expiry: isPresetExpiry(lifecycle.expiry) ? lifecycle.expiry : "until-revoked",
      customExpiry: typeof lifecycle.customExpiry === "string" ? lifecycle.customExpiry : "",
      quota: isPresetQuota(lifecycle.quota) ? lifecycle.quota : "unlimited",
      quotaValue: typeof lifecycle.quotaValue === "number" ? lifecycle.quotaValue : 100,
      audit: isPresetAudit(lifecycle.audit) ? lifecycle.audit : "standard",
      revoke: isPresetRevoke(lifecycle.revoke) ? lifecycle.revoke : "manual",
      state: lifecycle.state === "staged" || lifecycle.state === "revoked" ? lifecycle.state : "draft",
      note: typeof parsed.note === "string" ? parsed.note : "",
    });
  } catch {
    return null;
  }
}

function markdownField(source: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^\\s*- ${escaped}:\\s*(.*?)\\s*$`, "im"));
  return match?.[1]?.trim() ?? null;
}

function presetIdFromMarkdownLabel(label: string): string | null {
  const normalized = label.trim().toLocaleLowerCase();
  return PERMISSION_PRESETS.find((preset) => preset.label.toLocaleLowerCase() === normalized)?.id ?? null;
}

function scopeFromMarkdownLabel(label: string): { permissionScope: PermissionScope; scopeMode: PermissionPresetScopeMode } | null {
  if (label === "All preview scopes") return { permissionScope: "workspace", scopeMode: "all" };
  const entry = (Object.entries(PERMISSION_SCOPE_LABELS) as Array<[PermissionScope, string]>).find(([, value]) => value === label);
  return entry ? { permissionScope: entry[0], scopeMode: "selected" } : null;
}

function parseMarkdownExpiry(value: string): Pick<PermissionPresetLabDraft, "expiry" | "customExpiry"> | null {
  if (value === "Current session") return { expiry: "session", customExpiry: "" };
  if (value === "1 hour") return { expiry: "one-hour", customExpiry: "" };
  if (value === "24 hours") return { expiry: "one-day", customExpiry: "" };
  if (value === "Until revoked") return { expiry: "until-revoked", customExpiry: "" };
  if (value === "Custom time needed") return { expiry: "custom", customExpiry: "" };
  if (value.startsWith("Until ")) return { expiry: "custom", customExpiry: value.slice("Until ".length).trim() };
  return null;
}

function parseMarkdownQuota(value: string): Pick<PermissionPresetLabDraft, "quota" | "quotaValue"> | null {
  if (value === "No quota") return { quota: "unlimited", quotaValue: 100 };
  if (value === "1 run") return { quota: "per-run", quotaValue: 1 };
  const daily = value.match(/^(\d+) actions \/ day$/);
  if (daily) return { quota: "daily", quotaValue: Number(daily[1]) };
  const custom = value.match(/^(\d+) actions$/);
  if (custom) return { quota: "custom", quotaValue: Number(custom[1]) };
  return null;
}

function parsePermissionPresetLabMarkdown(raw: string): PermissionPresetLabDraft | null {
  if (!/^\s*# Omnia permission preset lifecycle preview/im.test(raw)) return null;
  const presetId = presetIdFromMarkdownLabel(markdownField(raw, "Preset") ?? "");
  const scopeTarget = markdownField(raw, "Scope target") ?? markdownField(raw, "Scope") ?? "";
  const scopeSummary = markdownField(raw, "Scope") ?? "";
  const parsedScope = scopeFromMarkdownLabel(scopeTarget);
  const scope = parsedScope ? {
    permissionScope: parsedScope.permissionScope,
    scopeMode: markdownField(raw, "Scope mode") === "all" || scopeSummary === "All preview scopes" ? "all" as const : "selected" as const,
  } : scopeFromMarkdownLabel(scopeSummary);
  const expiry = parseMarkdownExpiry(markdownField(raw, "Expiry") ?? "");
  const quota = parseMarkdownQuota(markdownField(raw, "Quota") ?? "");
  const auditValue = markdownField(raw, "Audit");
  const revokeValue = markdownField(raw, "Revoke");
  const state = markdownField(raw, "State");
  if (!presetId || !scope || !expiry || !quota || !auditValue || !revokeValue || !state) return null;
  const audit = auditValue === "Minimal" ? "minimal" : auditValue === "Verbose" ? "verbose" : auditValue === "Standard" ? "standard" : null;
  const revoke = revokeValue === "After one run" ? "after-run" : revokeValue === "When expiry is reached" ? "on-expiry" : revokeValue === "On policy error" ? "on-error" : revokeValue === "Manual revoke" ? "manual" : null;
  if (!audit || !revoke || (state !== "draft" && state !== "staged" && state !== "revoked")) return null;
  const note = markdownField(raw, "Note");
  return normalizePermissionPresetLabDraft({
    presetId,
    permissionScope: scope.permissionScope,
    scopeMode: scope.scopeMode,
    expiry: expiry.expiry,
    customExpiry: expiry.customExpiry,
    quota: quota.quota,
    quotaValue: quota.quotaValue,
    audit,
    revoke,
    state,
    note: !note || note === "None" ? "" : note,
  });
}

export function parsePermissionPresetLab(raw: string): PermissionPresetLabDraft | null {
  const source = raw.replace(/^\uFEFF/, "").trim();
  if (!source) return null;
  if (source.startsWith("{")) return parsePermissionPresetLabJson(source);
  return parsePermissionPresetLabMarkdown(source);
}

/** Keeps the contract's dependency explicit for future native validation. */
export function permissionModeForPreset(draft: PermissionPresetLabDraft, id: keyof PermissionValues): PermissionMode {
  return permissionPresetForDraft(draft).values[id];
}
