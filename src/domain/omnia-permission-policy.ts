export type PermissionCapability =
  | "read-app"
  | "write-app"
  | "read-workspace"
  | "write-workspace"
  | "execute-process"
  | "use-network"
  | "control-browser"
  | "control-computer"
  | "access-secrets";

export type PermissionScope = "global" | "project" | "workspace" | "session";
export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionPreset = "safe" | "read-write" | "allow-all" | "custom";

export type PermissionRule = {
  readonly capability: PermissionCapability;
  readonly scope: PermissionScope;
  readonly effect: PermissionEffect;
};

export type PermissionPolicy = {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly preset: PermissionPreset;
  readonly rules: readonly PermissionRule[];
  readonly revision: number;
  readonly updatedAt: string;
};

export type PermissionHistory = {
  readonly past: readonly PermissionPolicy[];
  readonly present: PermissionPolicy;
  readonly future: readonly PermissionPolicy[];
};

const capabilities: readonly PermissionCapability[] = [
  "read-app", "write-app", "read-workspace", "write-workspace", "execute-process",
  "use-network", "control-browser", "control-computer", "access-secrets",
];
const scopes: readonly PermissionScope[] = ["global", "project", "workspace", "session"];
const effects: readonly PermissionEffect[] = ["allow", "deny", "ask"];
const presets: readonly PermissionPreset[] = ["safe", "read-write", "allow-all", "custom"];

function now(): string { return new Date().toISOString(); }
function id(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === "string" && values.includes(value as T); }

function defaultRules(preset: Exclude<PermissionPreset, "custom">): readonly PermissionRule[] {
  const read: PermissionRule[] = capabilities.filter((capability) => capability === "read-app" || capability === "read-workspace").map((capability) => ({ capability, scope: "session", effect: "allow" }));
  if (preset === "safe") return [...read, { capability: "write-app", scope: "session", effect: "ask" }, { capability: "write-workspace", scope: "workspace", effect: "ask" }, { capability: "execute-process", scope: "project", effect: "deny" }, { capability: "use-network", scope: "global", effect: "ask" }, { capability: "control-browser", scope: "session", effect: "deny" }, { capability: "control-computer", scope: "session", effect: "deny" }, { capability: "access-secrets", scope: "global", effect: "deny" }];
  if (preset === "read-write") return capabilities.map((capability) => ({ capability, scope: capability.includes("workspace") ? "workspace" : "session", effect: capability === "execute-process" || capability === "access-secrets" ? "ask" : "allow" }));
  return capabilities.map((capability) => ({ capability, scope: "global", effect: "allow" }));
}

export function createPermissionPolicy(input: Partial<Pick<PermissionPolicy, "id" | "name" | "preset" | "rules">> = {}): PermissionPolicy {
  const preset = input.preset ?? "safe";
  const rules = input.rules ?? (preset === "custom" ? [] : defaultRules(preset));
  return { version: 1, id: input.id?.trim() || id("policy"), name: input.name?.trim() || `${preset} permissions`, preset, rules: [...rules], revision: 1, updatedAt: now() };
}

export function evaluatePermission(policy: PermissionPolicy, capability: PermissionCapability, scope: PermissionScope): PermissionEffect {
  const exact = policy.rules.find((rule) => rule.capability === capability && rule.scope === scope);
  const global = policy.rules.find((rule) => rule.capability === capability && rule.scope === "global");
  return exact?.effect ?? global?.effect ?? "ask";
}

export function updatePermissionRule(policy: PermissionPolicy, rule: PermissionRule, updatedAt = now()): PermissionPolicy {
  const rules = policy.rules.filter((candidate) => !(candidate.capability === rule.capability && candidate.scope === rule.scope));
  return { ...policy, preset: "custom", rules: [...rules, rule], revision: policy.revision + 1, updatedAt };
}

export function resetPermissionPolicy(policy: PermissionPolicy, preset: PermissionPreset = "safe", updatedAt = now()): PermissionPolicy {
  return { ...policy, preset, rules: preset === "custom" ? [] : defaultRules(preset), revision: policy.revision + 1, updatedAt };
}

export function createPermissionHistory(policy = createPermissionPolicy()): PermissionHistory { return { past: [], present: policy, future: [] }; }
export function commitPermissionChange(history: PermissionHistory, next: PermissionPolicy): PermissionHistory { return { past: [...history.past, history.present], present: next, future: [] }; }
export function undoPermissionChange(history: PermissionHistory): PermissionHistory { const previous = history.past.at(-1); return previous ? { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] } : history; }
export function redoPermissionChange(history: PermissionHistory): PermissionHistory { const next = history.future[0]; return next ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) } : history; }

function parseRule(value: unknown): PermissionRule {
  if (!isRecord(value) || !isOneOf(capabilities, value.capability) || !isOneOf(scopes, value.scope) || !isOneOf(effects, value.effect)) throw new Error("Invalid permission rule");
  return { capability: value.capability, scope: value.scope, effect: value.effect };
}

export function deserializePermissionPolicy(input: string | unknown): PermissionPolicy {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!isRecord(value) || value.version !== 1 || !isString(value.id) || !isString(value.name) || !isOneOf(presets, value.preset) || !Array.isArray(value.rules) || typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1 || !isString(value.updatedAt)) throw new Error("Invalid permission policy");
  return { version: 1, id: value.id, name: value.name, preset: value.preset, rules: value.rules.map(parseRule), revision: value.revision, updatedAt: value.updatedAt };
}

export function serializePermissionPolicy(policy: PermissionPolicy): string { return JSON.stringify(policy, null, 2); }
