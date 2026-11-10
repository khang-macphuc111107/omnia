import { assertDomain } from "./errors";
import {
  assertIntegerInRange,
  assertIsoTimestamp,
  assertNonBlank,
  type IsoTimestamp,
  type JsonObject,
} from "./shared";

/** Renderer/native-neutral feature flag primitives. A flag is configuration, not authority. */
export type FeatureFlagKind = "boolean" | "variant" | "number" | "string";
export type FeatureFlagState = "active" | "disabled" | "archived";
export type FeatureFlagScope = "global" | "workspace" | "project" | "user" | "session";
export type FeatureFlagEnvironment = "development" | "test" | "preview" | "staging" | "production" | "custom";
export type FeatureFlagValue = boolean | number | string;
export type FeatureFlagComparison =
  | "equals" | "not-equals" | "contains" | "starts-with" | "ends-with"
  | "greater-than" | "greater-than-or-equal" | "less-than" | "less-than-or-equal" | "exists";

export interface FeatureFlagVariant { readonly id: string; readonly label: string; readonly value: FeatureFlagValue; }
export interface FeatureFlagCondition {
  readonly attribute: string;
  readonly operator: FeatureFlagComparison;
  readonly value?: FeatureFlagValue | readonly FeatureFlagValue[];
}
export interface FeatureFlagRule {
  readonly id: string;
  readonly priority: number;
  readonly conditions: readonly FeatureFlagCondition[];
  readonly value: FeatureFlagValue;
  readonly environments?: readonly FeatureFlagEnvironment[];
  readonly rolloutPercentage?: number;
}
export interface FeatureFlagPrerequisite { readonly key: string; readonly expected: FeatureFlagValue; }
export interface FeatureFlagDefinition {
  readonly version: 1;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly kind: FeatureFlagKind;
  readonly scope: FeatureFlagScope;
  readonly state: FeatureFlagState;
  readonly defaultValue: FeatureFlagValue;
  readonly variants: readonly FeatureFlagVariant[];
  readonly rules: readonly FeatureFlagRule[];
  readonly prerequisites: readonly FeatureFlagPrerequisite[];
  readonly tags: readonly string[];
  readonly rolloutPercentage?: number;
  readonly stickinessAttribute?: string;
  readonly owner?: string;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
}
export interface FeatureFlagRegistry { readonly version: 1; readonly revision: number; readonly flags: readonly FeatureFlagDefinition[]; }
export interface FeatureFlagContext {
  readonly environment?: FeatureFlagEnvironment;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly attributes?: Readonly<Record<string, FeatureFlagValue | null>>;
}
export interface FeatureFlagEvaluationOptions {
  readonly overrides?: Readonly<Record<string, FeatureFlagValue>>;
  readonly visited?: ReadonlySet<string>;
}
export type FeatureFlagEvaluationSource = "missing" | "override" | "disabled" | "archived" | "prerequisite" | "rollout" | "rule" | "default";
export interface FeatureFlagEvaluation {
  readonly key: string;
  readonly found: boolean;
  readonly enabled: boolean;
  readonly value: FeatureFlagValue;
  readonly source: FeatureFlagEvaluationSource;
  readonly reason: string;
  readonly definitionRevision?: number;
  readonly matchedRuleId?: string;
}
export type FeatureFlagEvaluationMap = Readonly<Record<string, FeatureFlagEvaluation>>;
export type FeatureFlagRegistryIssueKind = "missing-prerequisite" | "prerequisite-cycle";
export interface FeatureFlagRegistryIssue {
  readonly kind: FeatureFlagRegistryIssueKind;
  readonly flagKey: string;
  readonly prerequisiteKey: string;
  readonly path: readonly string[];
  readonly message: string;
}
export interface FeatureFlagRegistryHealth {
  readonly registryRevision: number;
  readonly flagCount: number;
  readonly healthy: boolean;
  readonly issues: readonly FeatureFlagRegistryIssue[];
}
export interface FeatureFlagHistory {
  readonly past: readonly FeatureFlagRegistry[];
  readonly present: FeatureFlagRegistry;
  readonly future: readonly FeatureFlagRegistry[];
}
export interface CreateFeatureFlagInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: FeatureFlagKind;
  readonly scope?: FeatureFlagScope;
  readonly state?: FeatureFlagState;
  readonly defaultValue: FeatureFlagValue;
  readonly variants?: readonly FeatureFlagVariant[];
  readonly rules?: readonly FeatureFlagRule[];
  readonly prerequisites?: readonly FeatureFlagPrerequisite[];
  readonly tags?: readonly string[];
  readonly rolloutPercentage?: number;
  readonly stickinessAttribute?: string;
  readonly owner?: string;
}

const KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ATTRIBUTE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const KINDS: readonly FeatureFlagKind[] = ["boolean", "variant", "number", "string"];
const STATES: readonly FeatureFlagState[] = ["active", "disabled", "archived"];
const SCOPES: readonly FeatureFlagScope[] = ["global", "workspace", "project", "user", "session"];
const ENVIRONMENTS: readonly FeatureFlagEnvironment[] = ["development", "test", "preview", "staging", "production", "custom"];
const COMPARISONS: readonly FeatureFlagComparison[] = ["equals", "not-equals", "contains", "starts-with", "ends-with", "greater-than", "greater-than-or-equal", "less-than", "less-than-or-equal", "exists"];
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isValue(value: unknown): value is FeatureFlagValue { return typeof value === "boolean" || isFiniteNumber(value) || typeof value === "string"; }
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T { return typeof value === "string" && values.includes(value as T); }
function now(): IsoTimestamp { return new Date().toISOString(); }

function normalizeKey(value: string, label = "feature flag key"): string {
  const key = assertNonBlank(value, label, 160).toLowerCase();
  assertDomain(KEY_PATTERN.test(key), "invalid_argument", `${label} must be lowercase and segment separated.`, { key });
  return key;
}
function normalizeAttribute(value: string, label = "feature flag attribute"): string {
  const attribute = assertNonBlank(value, label, 128);
  assertDomain(ATTRIBUTE_PATTERN.test(attribute), "invalid_argument", `${label} contains unsupported characters.`, { attribute });
  return attribute;
}
function normalizePercentage(value: number, label: string): number {
  assertDomain(Number.isFinite(value) && value >= 0 && value <= 100, "invalid_argument", `${label} must be between 0 and 100.`, { value });
  return Math.round(value * 100) / 100;
}
function assertKind(value: FeatureFlagValue, kind: FeatureFlagKind, label: string): void {
  const valid = (kind === "boolean" && typeof value === "boolean") || (kind === "number" && isFiniteNumber(value)) || ((kind === "string" || kind === "variant") && typeof value === "string");
  assertDomain(valid, "invalid_argument", `${label} does not match feature flag kind ${kind}.`, { kind });
}
function normalizeVariant(variant: FeatureFlagVariant, kind: FeatureFlagKind): FeatureFlagVariant {
  const id = normalizeKey(variant.id, "feature flag variant ID");
  const label = assertNonBlank(variant.label, "feature flag variant label", 160);
  assertDomain(kind === "variant", "invalid_argument", "Variants are only valid for variant flags.");
  assertKind(variant.value, kind, "feature flag variant value");
  return Object.freeze({ id, label, value: variant.value });
}
function normalizeCondition(condition: FeatureFlagCondition): FeatureFlagCondition {
  const attribute = normalizeAttribute(condition.attribute);
  assertDomain(isOneOf(COMPARISONS, condition.operator), "invalid_argument", "Unknown feature flag comparison operator.");
  if (condition.operator === "exists") return Object.freeze({ attribute, operator: condition.operator });
  assertDomain(condition.value !== undefined, "invalid_argument", "A feature flag condition requires a value.");
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  assertDomain(values.length > 0 && values.every(isValue), "invalid_argument", "Feature flag condition value is invalid.");
  return Object.freeze({ attribute, operator: condition.operator, value: Array.isArray(condition.value) ? Object.freeze([...condition.value]) : condition.value });
}
function normalizeRule(rule: FeatureFlagRule, kind: FeatureFlagKind): FeatureFlagRule {
  const id = normalizeKey(rule.id, "feature flag rule ID");
  assertIntegerInRange(rule.priority, "feature flag rule priority", 0, 1_000_000);
  assertKind(rule.value, kind, "feature flag rule value");
  const conditions = Object.freeze(rule.conditions.map(normalizeCondition));
  const environments = rule.environments === undefined ? undefined : Object.freeze([...new Set(rule.environments)]);
  if (environments !== undefined) assertDomain(environments.every((environment) => isOneOf(ENVIRONMENTS, environment)), "invalid_argument", "Unknown feature flag rule environment.");
  const rolloutPercentage = rule.rolloutPercentage === undefined ? undefined : normalizePercentage(rule.rolloutPercentage, "feature flag rule rollout percentage");
  return Object.freeze({ id, priority: rule.priority, conditions, value: rule.value, ...(environments === undefined ? {} : { environments }), ...(rolloutPercentage === undefined ? {} : { rolloutPercentage }) });
}
function normalizeDefinition(input: FeatureFlagDefinition): FeatureFlagDefinition {
  assertDomain(input.version === 1, "invalid_argument", "Unsupported feature flag definition version.");
  const key = normalizeKey(input.key);
  const name = assertNonBlank(input.name, "feature flag name", 200);
  const description = input.description.trim();
  assertDomain(description.length <= 4_000, "invalid_argument", "Feature flag description is too long.");
  assertDomain(isOneOf(KINDS, input.kind) && isOneOf(STATES, input.state) && isOneOf(SCOPES, input.scope), "invalid_argument", "Unknown feature flag option.");
  assertKind(input.defaultValue, input.kind, "feature flag default value");
  assertIntegerInRange(input.revision, "feature flag revision", 1, Number.MAX_SAFE_INTEGER);
  assertIsoTimestamp(input.updatedAt, "feature flag update time");
  const variants = Object.freeze((input.variants ?? []).map((variant) => normalizeVariant(variant, input.kind)));
  if (input.kind === "variant") {
    assertDomain(variants.length > 0, "invalid_argument", "Variant flags must declare variants.");
    const ids = new Set<string>();
    for (const variant of variants) { assertDomain(!ids.has(variant.id), "conflict", "Feature flag variant IDs must be unique."); ids.add(variant.id); }
    assertDomain(variants.some((variant) => variant.value === input.defaultValue), "invalid_argument", "A variant default must match a declared variant.");
  } else assertDomain(variants.length === 0, "invalid_argument", "Only variant flags may declare variants.");
  const rules = Object.freeze((input.rules ?? []).map((rule) => normalizeRule(rule, input.kind)).sort((left, right) => left.priority - right.priority));
  const ruleIds = new Set<string>();
  for (const rule of rules) { assertDomain(!ruleIds.has(rule.id), "conflict", "Feature flag rule IDs must be unique."); ruleIds.add(rule.id); }
  const prerequisites = Object.freeze((input.prerequisites ?? []).map((prerequisite) => { const keyValue = normalizeKey(prerequisite.key, "feature flag prerequisite key"); assertDomain(isValue(prerequisite.expected), "invalid_argument", "Feature flag prerequisite expected value is invalid."); return Object.freeze({ key: keyValue, expected: prerequisite.expected }); }));
  const prerequisiteKeys = new Set<string>();
  for (const prerequisite of prerequisites) { assertDomain(prerequisite.key !== key, "invalid_argument", "A feature flag cannot depend on itself."); assertDomain(!prerequisiteKeys.has(prerequisite.key), "conflict", "Feature flag prerequisites must be unique."); prerequisiteKeys.add(prerequisite.key); }
  const tags = Object.freeze([...new Set((input.tags ?? []).map((tag) => assertNonBlank(tag, "feature flag tag", 80).toLowerCase()))]);
  const rolloutPercentage = input.rolloutPercentage === undefined ? undefined : normalizePercentage(input.rolloutPercentage, "feature flag rollout percentage");
  const stickinessAttribute = input.stickinessAttribute === undefined ? undefined : normalizeAttribute(input.stickinessAttribute, "feature flag stickiness attribute");
  const owner = input.owner === undefined ? undefined : assertNonBlank(input.owner, "feature flag owner", 160);
  return Object.freeze({ version: 1, key, name, description, kind: input.kind, scope: input.scope, state: input.state, defaultValue: input.defaultValue, variants, rules, prerequisites, tags, ...(rolloutPercentage === undefined ? {} : { rolloutPercentage }), ...(stickinessAttribute === undefined ? {} : { stickinessAttribute }), ...(owner === undefined ? {} : { owner }), revision: input.revision, updatedAt: input.updatedAt });
}

export function createFeatureFlag(input: CreateFeatureFlagInput, updatedAt = now()): FeatureFlagDefinition {
  const scope = input.scope ?? "global";
  const state = input.state ?? "active";
  assertDomain(isOneOf(KINDS, input.kind) && isOneOf(SCOPES, scope) && isOneOf(STATES, state), "invalid_argument", "Unknown feature flag option.");
  return normalizeDefinition({ version: 1, key: input.key, name: input.name, description: input.description ?? "", kind: input.kind, scope, state, defaultValue: input.defaultValue, variants: input.variants ?? [], rules: input.rules ?? [], prerequisites: input.prerequisites ?? [], tags: input.tags ?? [], ...(input.rolloutPercentage === undefined ? {} : { rolloutPercentage: input.rolloutPercentage }), ...(input.stickinessAttribute === undefined ? {} : { stickinessAttribute: input.stickinessAttribute }), ...(input.owner === undefined ? {} : { owner: input.owner }), revision: 1, updatedAt });
}
export function createFeatureFlagRegistry(flags: readonly FeatureFlagDefinition[] = []): FeatureFlagRegistry {
  const normalized = flags.map(normalizeDefinition); const keys = new Set<string>();
  for (const flag of normalized) { assertDomain(!keys.has(flag.key), "conflict", "Feature flag keys must be unique."); keys.add(flag.key); }
  return Object.freeze({ version: 1, revision: 1, flags: Object.freeze([...normalized]) });
}
export function getFeatureFlag(registry: FeatureFlagRegistry, key: string): FeatureFlagDefinition | undefined { const normalized = normalizeKey(key); return registry.flags.find((flag) => flag.key === normalized); }
export function upsertFeatureFlag(registry: FeatureFlagRegistry, definition: FeatureFlagDefinition, updatedAt = now()): FeatureFlagRegistry {
  const normalizedKey = normalizeKey(definition.key);
  const existing = registry.flags.find((flag) => flag.key === normalizedKey); const next = normalizeDefinition({ ...definition, key: normalizedKey, updatedAt, revision: existing ? existing.revision + 1 : definition.revision });
  const flags = existing ? registry.flags.map((flag) => flag.key === next.key ? next : flag) : [...registry.flags, next];
  return Object.freeze({ version: 1, revision: registry.revision + 1, flags: Object.freeze(flags) });
}
export function removeFeatureFlag(registry: FeatureFlagRegistry, key: string): FeatureFlagRegistry { const normalized = normalizeKey(key); const flags = registry.flags.filter((flag) => flag.key !== normalized); return flags.length === registry.flags.length ? registry : Object.freeze({ version: 1, revision: registry.revision + 1, flags: Object.freeze(flags) }); }
export function setFeatureFlagState(registry: FeatureFlagRegistry, key: string, state: FeatureFlagState, updatedAt = now()): FeatureFlagRegistry { const flag = getFeatureFlag(registry, key); assertDomain(flag !== undefined, "not_found", "Feature flag was not found.", { key }); return upsertFeatureFlag(registry, { ...flag, state }, updatedAt); }
export function setFeatureFlagRollout(registry: FeatureFlagRegistry, key: string, rolloutPercentage: number | undefined, updatedAt = now()): FeatureFlagRegistry {
  const flag = getFeatureFlag(registry, key);
  assertDomain(flag !== undefined, "not_found", "Feature flag was not found.", { key });
  if (rolloutPercentage !== undefined) return upsertFeatureFlag(registry, { ...flag, rolloutPercentage }, updatedAt);
  const withoutRollout = { ...flag };
  delete withoutRollout.rolloutPercentage;
  return upsertFeatureFlag(registry, withoutRollout, updatedAt);
}
export function createFeatureFlagHistory(registry = createFeatureFlagRegistry()): FeatureFlagHistory { return Object.freeze({ past: Object.freeze([]), present: registry, future: Object.freeze([]) }); }
export function commitFeatureFlagChange(history: FeatureFlagHistory, next: FeatureFlagRegistry): FeatureFlagHistory { return Object.freeze({ past: Object.freeze([...history.past, history.present]), present: next, future: Object.freeze([]) }); }
export function undoFeatureFlagChange(history: FeatureFlagHistory): FeatureFlagHistory { const previous = history.past.at(-1); return previous === undefined ? history : Object.freeze({ past: Object.freeze(history.past.slice(0, -1)), present: previous, future: Object.freeze([history.present, ...history.future]) }); }
export function redoFeatureFlagChange(history: FeatureFlagHistory): FeatureFlagHistory { const next = history.future[0]; return next === undefined ? history : Object.freeze({ past: Object.freeze([...history.past, history.present]), present: next, future: Object.freeze(history.future.slice(1)) }); }

function stableHash(value: string): number { let hash = 2_166_136_261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16_777_619); } return hash >>> 0; }
function bucketFor(flag: FeatureFlagDefinition, context: FeatureFlagContext): number { const explicit = flag.stickinessAttribute === undefined ? undefined : context.attributes?.[flag.stickinessAttribute]; const identity = explicit ?? context.userId ?? context.projectId ?? context.workspaceId ?? context.sessionId ?? "anonymous"; return (stableHash(`${flag.key}:${String(identity)}`) % 10_000) / 100; }
function attributeValue(context: FeatureFlagContext, attribute: string): FeatureFlagValue | null | undefined { if (attribute === "environment") return context.environment; if (attribute === "projectId") return context.projectId; if (attribute === "workspaceId") return context.workspaceId; if (attribute === "userId") return context.userId; if (attribute === "sessionId") return context.sessionId; return context.attributes?.[attribute]; }
function valuesEqual(left: FeatureFlagValue | null | undefined, right: FeatureFlagValue): boolean { return left === right; }
function overrideFor(options: FeatureFlagEvaluationOptions, key: string): FeatureFlagValue | undefined {
  const overrides = options.overrides;
  if (overrides === undefined) return undefined;
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const matchingKey = Object.keys(overrides).find((candidate) => candidate.trim().toLowerCase() === key);
  return matchingKey === undefined ? undefined : overrides[matchingKey];
}
function conditionMatches(condition: FeatureFlagCondition, context: FeatureFlagContext): boolean {
  const current = attributeValue(context, condition.attribute); if (condition.operator === "exists") return current !== undefined && current !== null; if (current === undefined || current === null || condition.value === undefined) return false;
  const expectedValues = Array.isArray(condition.value) ? condition.value : [condition.value];
  if (condition.operator === "equals") return expectedValues.some((expected) => valuesEqual(current, expected));
  if (condition.operator === "not-equals") return expectedValues.every((expected) => !valuesEqual(current, expected));
  if (typeof current === "string") return expectedValues.some((expected) => { const candidate = String(expected); if (condition.operator === "contains") return current.includes(candidate); if (condition.operator === "starts-with") return current.startsWith(candidate); if (condition.operator === "ends-with") return current.endsWith(candidate); return false; });
  if (typeof current === "number") { const expected = expectedValues.find(isFiniteNumber); if (expected === undefined) return false; if (condition.operator === "greater-than") return current > expected; if (condition.operator === "greater-than-or-equal") return current >= expected; if (condition.operator === "less-than") return current < expected; if (condition.operator === "less-than-or-equal") return current <= expected; }
  return false;
}
function enabledFor(value: FeatureFlagValue, flag: FeatureFlagDefinition): boolean { return flag.kind === "boolean" ? value === true : true; }
function evaluateInternal(registry: FeatureFlagRegistry, flag: FeatureFlagDefinition | undefined, context: FeatureFlagContext, options: FeatureFlagEvaluationOptions): FeatureFlagEvaluation | undefined {
  if (flag === undefined) return undefined; const visited = options.visited ?? new Set<string>(); if (visited.has(flag.key)) return { key: flag.key, found: true, enabled: false, value: flag.defaultValue, source: "prerequisite", reason: "Prerequisite cycle detected; fail closed.", definitionRevision: flag.revision }; const nextVisited = new Set(visited); nextVisited.add(flag.key);
  const override = overrideFor(options, flag.key); if (override !== undefined) { assertKind(override, flag.kind, "feature flag override value"); return { key: flag.key, found: true, enabled: enabledFor(override, flag), value: override, source: "override", reason: "Explicit caller-supplied override.", definitionRevision: flag.revision }; }
  if (flag.state === "archived") return { key: flag.key, found: true, enabled: false, value: flag.defaultValue, source: "archived", reason: "Archived flags are disabled.", definitionRevision: flag.revision };
  if (flag.state === "disabled") return { key: flag.key, found: true, enabled: false, value: flag.defaultValue, source: "disabled", reason: "Flag is disabled.", definitionRevision: flag.revision };
  for (const prerequisite of flag.prerequisites) { const dependency = evaluateInternal(registry, getFeatureFlag(registry, prerequisite.key), context, { ...options, visited: nextVisited }); if (dependency === undefined || !dependency.found || !valuesEqual(dependency.value, prerequisite.expected)) return { key: flag.key, found: true, enabled: false, value: flag.defaultValue, source: "prerequisite", reason: `Prerequisite ${prerequisite.key} did not match.`, definitionRevision: flag.revision }; }
  if (flag.rolloutPercentage !== undefined && bucketFor(flag, context) >= flag.rolloutPercentage) return { key: flag.key, found: true, enabled: enabledFor(flag.defaultValue, flag), value: flag.defaultValue, source: "rollout", reason: `Outside the ${flag.rolloutPercentage}% rollout.`, definitionRevision: flag.revision };
  for (const rule of flag.rules) { if (rule.environments !== undefined && (context.environment === undefined || !rule.environments.includes(context.environment))) continue; if (!rule.conditions.every((condition) => conditionMatches(condition, context))) continue; if (rule.rolloutPercentage !== undefined && bucketFor(flag, context) >= rule.rolloutPercentage) continue; return { key: flag.key, found: true, enabled: enabledFor(rule.value, flag), value: rule.value, source: "rule", reason: `Matched rule ${rule.id}.`, definitionRevision: flag.revision, matchedRuleId: rule.id }; }
  return { key: flag.key, found: true, enabled: enabledFor(flag.defaultValue, flag), value: flag.defaultValue, source: "default", reason: "No rule matched; using default.", definitionRevision: flag.revision };
}
export function evaluateFeatureFlag(registry: FeatureFlagRegistry, key: string, context: FeatureFlagContext = {}, options: FeatureFlagEvaluationOptions = {}): FeatureFlagEvaluation { const normalized = normalizeKey(key); return evaluateInternal(registry, getFeatureFlag(registry, normalized), context, options) ?? { key: normalized, found: false, enabled: false, value: false, source: "missing", reason: "Feature flag is not registered." }; }

/** Evaluate a caller-selected set of flags while preserving first-seen order. */
export function evaluateFeatureFlags(
  registry: FeatureFlagRegistry,
  keys: readonly string[],
  context: FeatureFlagContext = {},
  options: FeatureFlagEvaluationOptions = {},
): readonly FeatureFlagEvaluation[] {
  const seen = new Set<string>();
  const evaluations: FeatureFlagEvaluation[] = [];
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    evaluations.push(evaluateFeatureFlag(registry, normalized, context, options));
  }
  return Object.freeze(evaluations);
}

/** Evaluate every registered flag and expose a stable key-addressable result. */
export function evaluateAllFeatureFlags(
  registry: FeatureFlagRegistry,
  context: FeatureFlagContext = {},
  options: FeatureFlagEvaluationOptions = {},
): FeatureFlagEvaluationMap {
  const entries = registry.flags.map((flag) => [
    flag.key,
    evaluateFeatureFlag(registry, flag.key, context, options),
  ] as const);
  return Object.freeze(Object.fromEntries(entries) as FeatureFlagEvaluationMap);
}

/**
 * Inspect graph-level problems that are valid JSON but cannot produce a fully
 * explainable evaluation (for example a prerequisite typo or a dependency
 * cycle). Evaluation itself remains fail-closed for these cases.
 */
export function inspectFeatureFlagRegistry(registry: FeatureFlagRegistry): FeatureFlagRegistryHealth {
  const byKey = new Map(registry.flags.map((flag) => [flag.key, flag] as const));
  const issues: FeatureFlagRegistryIssue[] = [];
  const reported = new Set<string>();
  const report = (issue: FeatureFlagRegistryIssue): void => {
    const identity = `${issue.kind}:${issue.flagKey}:${issue.prerequisiteKey}:${issue.path.join("/")}`;
    if (reported.has(identity)) return;
    reported.add(identity);
    issues.push(Object.freeze(issue));
  };

  const visit = (rootKey: string, currentKey: string, path: readonly string[], active: ReadonlySet<string>): void => {
    const current = byKey.get(currentKey);
    if (current === undefined) return;
    for (const prerequisite of current.prerequisites) {
      const nextPath = [...path, current.key, prerequisite.key];
      if (!byKey.has(prerequisite.key)) {
        report({
          kind: "missing-prerequisite",
          flagKey: rootKey,
          prerequisiteKey: prerequisite.key,
          path: Object.freeze(nextPath),
          message: `Feature flag ${rootKey} references missing prerequisite ${prerequisite.key}.`,
        });
        continue;
      }
      if (active.has(prerequisite.key)) {
        report({
          kind: "prerequisite-cycle",
          flagKey: rootKey,
          prerequisiteKey: prerequisite.key,
          path: Object.freeze(nextPath),
          message: `Feature flag prerequisite cycle detected at ${prerequisite.key}.`,
        });
        continue;
      }
      visit(rootKey, prerequisite.key, nextPath, new Set([...active, prerequisite.key]));
    }
  };

  for (const flag of registry.flags) visit(flag.key, flag.key, [], new Set([flag.key]));
  return Object.freeze({
    registryRevision: registry.revision,
    flagCount: registry.flags.length,
    healthy: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function parseCondition(value: unknown): FeatureFlagCondition {
  assertDomain(isRecord(value) && isString(value.attribute) && isOneOf(COMPARISONS, value.operator), "invalid_argument", "Invalid feature flag condition.");
  if (value.value === undefined) return normalizeCondition({ attribute: value.attribute, operator: value.operator });
  if (Array.isArray(value.value)) {
    const values = value.value.map((entry) => {
      assertDomain(isValue(entry), "invalid_argument", "Invalid feature flag condition value.");
      return entry;
    });
    return normalizeCondition({ attribute: value.attribute, operator: value.operator, value: values });
  }
  assertDomain(isValue(value.value), "invalid_argument", "Invalid feature flag condition value.");
  return normalizeCondition({ attribute: value.attribute, operator: value.operator, value: value.value });
}
function parseVariant(value: unknown): FeatureFlagVariant { assertDomain(isRecord(value) && isString(value.id) && isString(value.label) && isValue(value.value), "invalid_argument", "Invalid feature flag variant."); return { id: value.id, label: value.label, value: value.value }; }
function parseRule(value: unknown): FeatureFlagRule { assertDomain(isRecord(value) && isString(value.id) && typeof value.priority === "number" && Array.isArray(value.conditions) && isValue(value.value), "invalid_argument", "Invalid feature flag rule."); assertDomain(value.conditions.every((condition) => isRecord(condition)), "invalid_argument", "Invalid feature flag rule conditions."); const environments = value.environments === undefined ? undefined : value.environments; assertDomain(environments === undefined || (Array.isArray(environments) && environments.every(isString)), "invalid_argument", "Invalid feature flag environments."); assertDomain(value.rolloutPercentage === undefined || isFiniteNumber(value.rolloutPercentage), "invalid_argument", "Invalid feature flag rule rollout."); return { id: value.id, priority: value.priority, conditions: value.conditions.map(parseCondition), value: value.value, ...(environments === undefined ? {} : { environments: environments as readonly FeatureFlagEnvironment[] }), ...(value.rolloutPercentage === undefined ? {} : { rolloutPercentage: value.rolloutPercentage }) }; }
function parseDefinition(value: unknown): FeatureFlagDefinition { assertDomain(isRecord(value), "invalid_argument", "Invalid feature flag definition."); assertDomain(value.version === 1 && isString(value.key) && isString(value.name) && isString(value.description), "invalid_argument", "Invalid feature flag definition metadata."); assertDomain(isOneOf(KINDS, value.kind) && isOneOf(SCOPES, value.scope) && isOneOf(STATES, value.state), "invalid_argument", "Invalid feature flag options."); assertDomain(isValue(value.defaultValue) && Array.isArray(value.variants) && Array.isArray(value.rules) && Array.isArray(value.prerequisites) && Array.isArray(value.tags), "invalid_argument", "Invalid feature flag values."); assertDomain(value.variants.every((variant) => isRecord(variant)) && value.rules.every((rule) => isRecord(rule)) && value.prerequisites.every((prerequisite) => isRecord(prerequisite)) && value.tags.every(isString), "invalid_argument", "Invalid feature flag collections."); assertDomain(value.prerequisites.every((prerequisite) => isString(prerequisite.key) && isValue(prerequisite.expected)), "invalid_argument", "Invalid feature flag prerequisite values."); assertDomain(typeof value.revision === "number" && Number.isInteger(value.revision) && isString(value.updatedAt), "invalid_argument", "Invalid feature flag revision metadata."); assertDomain(value.rolloutPercentage === undefined || isFiniteNumber(value.rolloutPercentage), "invalid_argument", "Invalid feature flag rollout."); assertDomain(value.stickinessAttribute === undefined || isString(value.stickinessAttribute), "invalid_argument", "Invalid feature flag stickiness attribute."); assertDomain(value.owner === undefined || isString(value.owner), "invalid_argument", "Invalid feature flag owner."); return normalizeDefinition({ version: 1, key: value.key, name: value.name, description: value.description, kind: value.kind, scope: value.scope, state: value.state, defaultValue: value.defaultValue, variants: value.variants.map(parseVariant), rules: value.rules.map(parseRule), prerequisites: value.prerequisites.map((prerequisite) => ({ key: prerequisite.key as string, expected: prerequisite.expected as FeatureFlagValue })), tags: value.tags, ...(value.rolloutPercentage === undefined ? {} : { rolloutPercentage: value.rolloutPercentage }), ...(value.stickinessAttribute === undefined ? {} : { stickinessAttribute: value.stickinessAttribute }), ...(value.owner === undefined ? {} : { owner: value.owner }), revision: value.revision, updatedAt: value.updatedAt }); }
export function deserializeFeatureFlagRegistry(input: string | unknown): FeatureFlagRegistry { const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input; assertDomain(isRecord(value) && value.version === 1 && typeof value.revision === "number" && Number.isInteger(value.revision) && Array.isArray(value.flags), "invalid_argument", "Invalid feature flag registry."); const flags = value.flags.map(parseDefinition); const registry = createFeatureFlagRegistry(flags); return Object.freeze({ ...registry, revision: value.revision }); }
export function serializeFeatureFlagRegistry(registry: FeatureFlagRegistry): string { return JSON.stringify(registry, null, 2); }
export function projectFeatureFlagSummary(registry: FeatureFlagRegistry): JsonObject { return { schema: "omnia.feature-flags.summary.v1", registryRevision: registry.revision, total: registry.flags.length, active: registry.flags.filter((flag) => flag.state === "active").length, disabled: registry.flags.filter((flag) => flag.state === "disabled").length, archived: registry.flags.filter((flag) => flag.state === "archived").length }; }
