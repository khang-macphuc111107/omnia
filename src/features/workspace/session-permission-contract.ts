import { useCallback, useSyncExternalStore } from "react";

import {
  Camera,
  Database,
  Download,
  FolderOpen,
  Globe2,
  KeyRound,
  Laptop,
  Mic2,
  Network,
  Terminal,
  type LucideIcon,
} from "lucide-react";

export type PermissionMode = "prompt" | "allow" | "deny";
export type PermissionScope = "session" | "chat" | "project" | "workspace";
export type PermissionFamily = "Files" | "Network" | "Execution" | "Desktop" | "Media" | "Secrets" | "Workspace";
export type PermissionId =
  | "files.read"
  | "files.write"
  | "files.delete"
  | "network.public"
  | "network.local"
  | "execution.terminal"
  | "execution.process"
  | "desktop.browser"
  | "desktop.computer"
  | "media.microphone"
  | "media.camera"
  | "secrets.read"
  | "workspace.index"
  | "workspace.export";

export type PermissionDefinition = {
  readonly id: PermissionId;
  readonly label: string;
  readonly family: PermissionFamily;
  readonly description: string;
  readonly risk: "low" | "medium" | "high";
  readonly icon: LucideIcon;
};

export type PermissionValues = Record<PermissionId, PermissionMode>;

export interface PermissionScopeHistory {
  readonly past: readonly PermissionValues[];
  readonly future: readonly PermissionValues[];
}

export interface PermissionPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tone: "mint" | "amber" | "blue" | "coral";
  readonly values: PermissionValues;
}

/**
 * A renderer-only finding that a narrower draft is more permissive than its
 * immediate parent draft. It is a review signal, never an effective grant.
 */
export interface PermissionScopeExpansion {
  readonly scope: PermissionScope;
  readonly parentScope: PermissionScope;
  readonly permissionId: PermissionId;
  readonly parentMode: PermissionMode;
  readonly mode: PermissionMode;
}

/**
 * A renderer-local change between two permission policy drafts. The labels
 * come from the allowlisted definitions above so a diff names the concrete
 * capability rather than exposing an abstract scope-only claim.
 */
export interface PermissionDiffEntry {
  readonly permissionId: PermissionId;
  readonly label: string;
  readonly family: PermissionFamily;
  readonly risk: PermissionDefinition["risk"];
  readonly kind: "added" | "removed" | "changed";
  readonly before: PermissionMode;
  readonly after: PermissionMode;
  readonly direction: "increase" | "decrease";
}

export interface PermissionDiff {
  readonly added: readonly PermissionDiffEntry[];
  readonly removed: readonly PermissionDiffEntry[];
  readonly changed: readonly PermissionDiffEntry[];
  readonly entries: readonly PermissionDiffEntry[];
  readonly increases: readonly PermissionDiffEntry[];
  readonly decreases: readonly PermissionDiffEntry[];
  readonly highRiskIncreases: readonly PermissionDiffEntry[];
  readonly changedCount: number;
}

export interface PermissionHistoryDiff {
  readonly revision: number;
  readonly before: PermissionValues;
  readonly after: PermissionValues;
  readonly diff: PermissionDiff;
}

export interface PermissionSessionHistory {
  readonly past: readonly PermissionValues[];
  readonly present: PermissionValues;
  readonly future: readonly PermissionValues[];
  /** The scope currently being edited in the renderer preview. */
  readonly activeScope: PermissionScope;
  /** Session-local policy drafts keyed by scope; never a native grant. */
  readonly valuesByScope: Readonly<Record<PermissionScope, PermissionValues>>;
  /** Independent undo/redo stacks keyed by scope so switching scope never discards edits. */
  readonly historyByScope: Readonly<Record<PermissionScope, PermissionScopeHistory>>;
}

export type PermissionExportFormat = "json" | "markdown";

export const PERMISSION_PREVIEW_SCHEMA = "renderer-permission-preview" as const;
export const PERMISSION_PREVIEW_VERSION = 1 as const;
export const PERMISSION_PREVIEW_SCOPE = "renderer-session" as const;
export const PERMISSION_PREVIEW_BOUNDARY =
  "Renderer-local permission preview only; no native grant, approval receipt, execution, provider request, or durable policy write was performed.";

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  { id: "files.read", label: "Read project files", family: "Files", description: "Inspect text and metadata from an explicitly scoped workspace.", risk: "low", icon: FolderOpen },
  { id: "files.write", label: "Write project files", family: "Files", description: "Create or update files after a native confirmation boundary.", risk: "high", icon: FolderOpen },
  { id: "files.delete", label: "Delete project files", family: "Files", description: "Remove files or folders from a future workspace grant.", risk: "high", icon: FolderOpen },
  { id: "network.public", label: "Reach public network", family: "Network", description: "Call approved HTTPS destinations through a provider route.", risk: "medium", icon: Globe2 },
  { id: "network.local", label: "Reach local network", family: "Network", description: "Access loopback or private destinations with an explicit grant.", risk: "high", icon: Network },
  { id: "execution.terminal", label: "Run terminal commands", family: "Execution", description: "Execute a command in a policy-bounded process environment.", risk: "high", icon: Terminal },
  { id: "execution.process", label: "Spawn child processes", family: "Execution", description: "Start a child process or compiler outside the renderer sandbox.", risk: "high", icon: Terminal },
  { id: "desktop.browser", label: "Control a browser", family: "Desktop", description: "Navigate or interact with a browser automation surface.", risk: "high", icon: Laptop },
  { id: "desktop.computer", label: "Control the desktop", family: "Desktop", description: "Use keyboard, pointer, or window automation on Windows.", risk: "high", icon: Laptop },
  { id: "media.microphone", label: "Use microphone", family: "Media", description: "Capture microphone input for a future voice workflow.", risk: "medium", icon: Mic2 },
  { id: "media.camera", label: "Use camera", family: "Media", description: "Capture camera frames for a future multimodal workflow.", risk: "high", icon: Camera },
  { id: "secrets.read", label: "Read secret references", family: "Secrets", description: "Resolve an opaque credential reference inside a native broker.", risk: "high", icon: KeyRound },
  { id: "workspace.index", label: "Index workspace context", family: "Workspace", description: "Build a retrieval projection from an approved workspace scope.", risk: "medium", icon: Database },
  { id: "workspace.export", label: "Export workspace artifacts", family: "Workspace", description: "Prepare a redacted project or run export for the user.", risk: "medium", icon: Download },
] as const;

export const PERMISSION_IDS = PERMISSION_DEFINITIONS.map(({ id }) => id) as PermissionId[];

export const PERMISSION_SCOPE_LABELS: Record<PermissionScope, string> = {
  session: "Current session",
  chat: "Current chat",
  project: "Current project",
  workspace: "Workspace default",
};

export const PERMISSION_FAMILY_OPTIONS: readonly (PermissionFamily | "all")[] = ["all", "Files", "Network", "Execution", "Desktop", "Media", "Secrets", "Workspace"];

export function clonePermissionValues(values: PermissionValues): PermissionValues {
  return { ...values };
}

export function permissionValuesEqual(left: PermissionValues, right: PermissionValues): boolean {
  return PERMISSION_IDS.every((id) => left[id] === right[id]);
}

function allPermissionValues(mode: PermissionMode): PermissionValues {
  return Object.fromEntries(PERMISSION_IDS.map((id) => [id, mode])) as PermissionValues;
}

export const DEFAULT_PERMISSION_VALUES: PermissionValues = Object.fromEntries(
  PERMISSION_DEFINITIONS.map((definition) => [
    definition.id,
    definition.id === "files.read"
      ? "allow"
      : definition.id === "files.delete" || definition.id === "execution.process" || definition.id === "desktop.computer" || definition.id === "secrets.read"
        ? "deny"
        : "prompt",
  ]),
) as PermissionValues;

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Read by default, ask before side effects, deny high-risk desktop and secret access.",
    tone: "blue",
    values: DEFAULT_PERMISSION_VALUES,
  },
  {
    id: "allow-all",
    label: "Allow all (preview)",
    description: "Show every capability as allowed for UI exploration; this never grants native authority.",
    tone: "coral",
    values: allPermissionValues("allow"),
  },
  {
    id: "lockdown",
    label: "Lockdown",
    description: "Deny every capability until a future native approval flow is ready.",
    tone: "amber",
    values: allPermissionValues("deny"),
  },
  {
    id: "research",
    label: "Research flow",
    description: "Allow reading, indexing, public research routes, and exports while keeping execution gated.",
    tone: "mint",
    values: {
      ...allPermissionValues("deny"),
      "files.read": "allow",
      "network.public": "allow",
      "workspace.index": "allow",
      "workspace.export": "allow",
      "media.microphone": "prompt",
    },
  },
] as const;

export function modeLabel(mode: PermissionMode): string {
  return mode === "allow" ? "Allow" : mode === "deny" ? "Deny" : "Ask every time";
}

export function permissionModeCounts(values: PermissionValues): Record<PermissionMode, number> {
  return {
    allow: PERMISSION_IDS.filter((id) => values[id] === "allow").length,
    prompt: PERMISSION_IDS.filter((id) => values[id] === "prompt").length,
    deny: PERMISSION_IDS.filter((id) => values[id] === "deny").length,
  };
}

export function permissionPresetLabel(values: PermissionValues): string {
  return PERMISSION_PRESETS.find((preset) => permissionValuesEqual(preset.values, values))?.label ?? "Custom policy";
}

export function permissionMarkdown(scope: PermissionScope, values: PermissionValues): string {
  const rows = PERMISSION_DEFINITIONS.map((definition) => `| ${definition.label} | ${definition.family} | ${modeLabel(values[definition.id])} | ${definition.risk} |`);
  return [
    "# Omnia permission preview",
    "",
    `- Scope: ${PERMISSION_SCOPE_LABELS[scope]}`,
    `- Preset: ${permissionPresetLabel(values)}`,
    `- Status: ${PERMISSION_PREVIEW_BOUNDARY}`,
    "",
    "| Capability | Family | Mode | Risk |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "> Allow all is a visual policy preset only. It does not bypass native policy, provider refusal, or OS permissions.",
  ].join("\n");
}

export function safePermissionPreviewPayload(scope: PermissionScope, values: PermissionValues) {
  return {
    scope: PERMISSION_PREVIEW_SCHEMA,
    version: PERMISSION_PREVIEW_VERSION,
    permissionScope: scope,
    preset: permissionPresetLabel(values),
    permissions: clonePermissionValues(values),
    boundary: PERMISSION_PREVIEW_BOUNDARY,
  } as const;
}

export function serializePermissionPreview(scope: PermissionScope, values: PermissionValues, format: PermissionExportFormat): string {
  const payload = safePermissionPreviewPayload(scope, values);
  return format === "json" ? JSON.stringify(payload, null, 2) : permissionMarkdown(scope, values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePermissionValues(value: unknown, fallback: PermissionValues = DEFAULT_PERMISSION_VALUES): PermissionValues {
  const payload = isRecord(value) && isRecord(value.permissions) ? value.permissions : value;
  if (!isRecord(payload)) return clonePermissionValues(fallback);
  const next = clonePermissionValues(fallback);
  for (const id of PERMISSION_IDS) {
    const mode = payload[id];
    if (mode === "allow" || mode === "prompt" || mode === "deny") next[id] = mode;
  }
  return next;
}

export function parsePermissionPreview(raw: string): { readonly permissionScope: PermissionScope; readonly values: PermissionValues } | null {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed) || parsed.scope !== PERMISSION_PREVIEW_SCHEMA || parsed.version !== PERMISSION_PREVIEW_VERSION) return null;
    const permissionScope = parsed.permissionScope;
    if (permissionScope !== "session" && permissionScope !== "chat" && permissionScope !== "project" && permissionScope !== "workspace") return null;
    if (!isRecord(parsed.permissions)) return null;
    for (const id of PERMISSION_IDS) {
      const mode = parsed.permissions[id];
      if (mode !== "allow" && mode !== "prompt" && mode !== "deny") return null;
    }
    return { permissionScope, values: normalizePermissionValues(parsed.permissions) };
  } catch {
    return null;
  }
}

function cloneHistory(value: PermissionSessionHistory): PermissionSessionHistory {
  return {
    past: value.past.map(clonePermissionValues),
    present: clonePermissionValues(value.present),
    future: value.future.map(clonePermissionValues),
    activeScope: value.activeScope,
    valuesByScope: cloneScopedPermissionValues(value.valuesByScope),
    historyByScope: cloneScopedPermissionHistory(value.historyByScope),
  };
}

export const PERMISSION_SCOPES: readonly PermissionScope[] = ["session", "chat", "project", "workspace"];

/** Least-specific to most-specific renderer preview drafts. */
export const PERMISSION_SCOPE_HIERARCHY: readonly PermissionScope[] = ["workspace", "project", "chat", "session"];

function permissionModeRank(mode: PermissionMode): number {
  return mode === "deny" ? 0 : mode === "prompt" ? 1 : 2;
}

/**
 * Compares two renderer policy drafts without granting, persisting, or
 * validating native authority. `added` means a capability moved from deny to
 * a usable mode; `removed` means it moved to deny; prompt/allow transitions
 * remain in `changed`.
 */
export function diffPermissionValues(
  before: PermissionValues,
  after: PermissionValues,
): PermissionDiff {
  const entries: PermissionDiffEntry[] = [];
  for (const definition of PERMISSION_DEFINITIONS) {
    const previous = before[definition.id];
    const next = after[definition.id];
    if (previous === next) continue;
    const kind = previous === "deny"
      ? "added"
      : next === "deny"
        ? "removed"
        : "changed";
    entries.push({
      permissionId: definition.id,
      label: definition.label,
      family: definition.family,
      risk: definition.risk,
      kind,
      before: previous,
      after: next,
      direction: permissionModeRank(next) > permissionModeRank(previous) ? "increase" : "decrease",
    });
  }
  const added = entries.filter((entry) => entry.kind === "added");
  const removed = entries.filter((entry) => entry.kind === "removed");
  const changed = entries.filter((entry) => entry.kind === "changed");
  const increases = entries.filter((entry) => entry.direction === "increase");
  const decreases = entries.filter((entry) => entry.direction === "decrease");
  return {
    added,
    removed,
    changed,
    entries,
    increases,
    decreases,
    highRiskIncreases: increases.filter((entry) => entry.risk === "high"),
    changedCount: entries.length,
  };
}

/**
 * Projects the active scope's undo snapshots into a compact, newest-last
 * history. This is a view model only; selecting a row never mutates policy.
 */
export function permissionHistoryDiffs(
  history: PermissionScopeHistory,
  present: PermissionValues,
): readonly PermissionHistoryDiff[] {
  const snapshots = [...history.past, present];
  if (snapshots.length < 2) return [];
  return snapshots.slice(1).map((after, index) => {
    const before = snapshots[index]!;
    return {
      revision: index + 1,
      before: clonePermissionValues(before),
      after: clonePermissionValues(after),
      diff: diffPermissionValues(before, after),
    };
  });
}

/**
 * Returns only proposed increases in permissiveness between adjacent preview
 * drafts. Native policy, grant scope, approvals, provider policy, and OS
 * checks still decide whether any operation may happen.
 */
export function permissionScopeExpansions(
  valuesByScope: Readonly<Record<PermissionScope, PermissionValues>>,
): readonly PermissionScopeExpansion[] {
  const expansions: PermissionScopeExpansion[] = [];
  for (let index = 1; index < PERMISSION_SCOPE_HIERARCHY.length; index += 1) {
    const parentScope = PERMISSION_SCOPE_HIERARCHY[index - 1]!;
    const scope = PERMISSION_SCOPE_HIERARCHY[index]!;
    const parentValues = valuesByScope[parentScope];
    const values = valuesByScope[scope];
    for (const permissionId of PERMISSION_IDS) {
      if (permissionModeRank(values[permissionId]) > permissionModeRank(parentValues[permissionId])) {
        expansions.push({
          scope,
          parentScope,
          permissionId,
          parentMode: parentValues[permissionId],
          mode: values[permissionId],
        });
      }
    }
  }
  return expansions;
}

function cloneScopedPermissionValues(
  values: Readonly<Record<PermissionScope, PermissionValues>>,
): Record<PermissionScope, PermissionValues> {
  return Object.fromEntries(
    PERMISSION_SCOPES.map((scope) => [scope, clonePermissionValues(values[scope])]),
  ) as Record<PermissionScope, PermissionValues>;
}

function cloneScopedPermissionHistory(
  values: Readonly<Record<PermissionScope, PermissionScopeHistory>>,
): Record<PermissionScope, PermissionScopeHistory> {
  return Object.fromEntries(
    PERMISSION_SCOPES.map((scope) => [scope, {
      past: values[scope].past.map(clonePermissionValues),
      future: values[scope].future.map(clonePermissionValues),
    }]),
  ) as unknown as Record<PermissionScope, PermissionScopeHistory>;
}

function scopedValuesWithPresent(
  values: Readonly<Record<PermissionScope, PermissionValues>>,
  scope: PermissionScope,
  present: PermissionValues,
): Record<PermissionScope, PermissionValues> {
  const next = cloneScopedPermissionValues(values);
  next[scope] = clonePermissionValues(present);
  return next;
}

function defaultScopedPermissionValues(): Record<PermissionScope, PermissionValues> {
  return cloneScopedPermissionValues({
    session: DEFAULT_PERMISSION_VALUES,
    chat: DEFAULT_PERMISSION_VALUES,
    project: DEFAULT_PERMISSION_VALUES,
    workspace: DEFAULT_PERMISSION_VALUES,
  });
}

function defaultScopedPermissionHistory(): Record<PermissionScope, PermissionScopeHistory> {
  return Object.fromEntries(
    PERMISSION_SCOPES.map((scope) => [scope, { past: [], future: [] }]),
  ) as unknown as Record<PermissionScope, PermissionScopeHistory>;
}

function scopedHistoryWithActive(
  history: Readonly<Record<PermissionScope, PermissionScopeHistory>>,
  scope: PermissionScope,
  next: PermissionScopeHistory,
): Record<PermissionScope, PermissionScopeHistory> {
  const result = cloneScopedPermissionHistory(history);
  result[scope] = {
    past: next.past.map(clonePermissionValues),
    future: next.future.map(clonePermissionValues),
  };
  return result;
}

export type PermissionDraftContext = string;
export const DEFAULT_PERMISSION_DRAFT_CONTEXT = "workspace";

/** A Project's renderer-only permission drafts never share state with another Project. */
export function projectPermissionDraftContext(projectId: string | null | undefined): PermissionDraftContext {
  return projectId ? `project:${projectId}` : DEFAULT_PERMISSION_DRAFT_CONTEXT;
}

function createPermissionSession(): PermissionSessionHistory {
  return {
    past: [],
    present: clonePermissionValues(DEFAULT_PERMISSION_VALUES),
    future: [],
    activeScope: "workspace",
    valuesByScope: defaultScopedPermissionValues(),
    historyByScope: defaultScopedPermissionHistory(),
  };
}

const sessions = new Map<PermissionDraftContext, PermissionSessionHistory>([
  [DEFAULT_PERMISSION_DRAFT_CONTEXT, createPermissionSession()],
]);
const listenersByContext = new Map<PermissionDraftContext, Set<() => void>>();

function sessionFor(context: PermissionDraftContext): PermissionSessionHistory {
  let current = sessions.get(context);
  if (!current) {
    current = createPermissionSession();
    sessions.set(context, current);
  }
  return current;
}

function publish(next: PermissionSessionHistory, context: PermissionDraftContext): PermissionSessionHistory {
  const published = cloneHistory(next);
  sessions.set(context, published);
  listenersByContext.get(context)?.forEach((listener) => listener());
  return published;
}

export function getPermissionSession(context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT): PermissionSessionHistory {
  return sessionFor(context);
}

export function subscribePermissionSession(
  listener: () => void,
  context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT,
): () => void {
  const listeners = listenersByContext.get(context) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByContext.set(context, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByContext.delete(context);
  };
}

export function usePermissionSession(context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT): PermissionSessionHistory {
  const subscribe = useCallback((listener: () => void) => subscribePermissionSession(listener, context), [context]);
  const snapshot = useCallback(() => getPermissionSession(context), [context]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function permissionValuesForScope(
  scope: PermissionScope,
  context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT,
): PermissionValues {
  return clonePermissionValues(sessionFor(context).valuesByScope[scope]);
}

/** Changes only the renderer scope currently being edited in this context. */
export function setPermissionScope(
  scope: PermissionScope,
  context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT,
): PermissionValues {
  const session = sessionFor(context);
  if (scope === session.activeScope) return session.present;
  const next = session.valuesByScope[scope];
  const nextHistory = session.historyByScope[scope];
  publish({
    past: nextHistory.past,
    present: clonePermissionValues(next),
    future: nextHistory.future,
    activeScope: scope,
    valuesByScope: session.valuesByScope,
    historyByScope: session.historyByScope,
  }, context);
  return sessionFor(context).present;
}

export function replacePermissionValues(
  values: unknown,
  scope?: PermissionScope,
  context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT,
): PermissionValues {
  const session = sessionFor(context);
  const targetScope = scope ?? session.activeScope;
  const current = session.valuesByScope[targetScope];
  const next = normalizePermissionValues(values, current);
  if (permissionValuesEqual(next, current)) return targetScope === session.activeScope ? session.present : clonePermissionValues(next);
  const valuesByScope = cloneScopedPermissionValues(session.valuesByScope);
  valuesByScope[targetScope] = clonePermissionValues(next);
  const active = targetScope === session.activeScope;
  const nextPast = active ? [...session.past, clonePermissionValues(session.present)].slice(-50) : session.past;
  const nextFuture = active ? [] : session.future;
  publish({
    past: nextPast,
    present: active ? clonePermissionValues(next) : session.present,
    future: nextFuture,
    activeScope: session.activeScope,
    valuesByScope,
    historyByScope: active
      ? scopedHistoryWithActive(session.historyByScope, session.activeScope, { past: nextPast, future: nextFuture })
      : session.historyByScope,
  }, context);
  return next;
}

/**
 * Applies one renderer-only draft to every permission scope in one logical
 * preview operation. Each changed scope keeps its own undo entry and clears
 * only its own redo stack; this never creates a native grant or approval.
 */
export function replacePermissionValuesForAllScopes(
  values: unknown,
  context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT,
): PermissionValues {
  const session = sessionFor(context);
  const valuesByScope = cloneScopedPermissionValues(session.valuesByScope);
  const historyByScope = cloneScopedPermissionHistory(session.historyByScope);
  let changed = false;

  for (const scope of PERMISSION_SCOPES) {
    const current = session.valuesByScope[scope];
    const next = normalizePermissionValues(values, current);
    if (permissionValuesEqual(next, current)) continue;

    const scopeHistory = historyByScope[scope];
    valuesByScope[scope] = clonePermissionValues(next);
    historyByScope[scope] = {
      past: [...scopeHistory.past, clonePermissionValues(current)].slice(-50),
      future: [],
    };
    changed = true;
  }

  if (!changed) return session.present;

  const activeHistory = historyByScope[session.activeScope];
  publish({
    past: activeHistory.past,
    present: clonePermissionValues(valuesByScope[session.activeScope]),
    future: activeHistory.future,
    activeScope: session.activeScope,
    valuesByScope,
    historyByScope,
  }, context);
  return sessionFor(context).present;
}

export function updatePermissionValues(
  patch: Partial<PermissionValues>,
  context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT,
): PermissionValues {
  const session = sessionFor(context);
  return replacePermissionValues({ ...session.present, ...patch }, undefined, context);
}

export function undoPermissionPreview(context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT): PermissionValues {
  const session = sessionFor(context);
  const previous = session.past.at(-1);
  if (!previous) return session.present;
  publish({
    past: session.past.slice(0, -1),
    present: previous,
    future: [clonePermissionValues(session.present), ...session.future],
    activeScope: session.activeScope,
    valuesByScope: scopedValuesWithPresent(session.valuesByScope, session.activeScope, previous),
    historyByScope: scopedHistoryWithActive(session.historyByScope, session.activeScope, {
      past: session.past.slice(0, -1),
      future: [clonePermissionValues(session.present), ...session.future],
    }),
  }, context);
  return sessionFor(context).present;
}

export function redoPermissionPreview(context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT): PermissionValues {
  const session = sessionFor(context);
  const next = session.future[0];
  if (!next) return session.present;
  publish({
    past: [...session.past, clonePermissionValues(session.present)].slice(-50),
    present: next,
    future: session.future.slice(1),
    activeScope: session.activeScope,
    valuesByScope: scopedValuesWithPresent(session.valuesByScope, session.activeScope, next),
    historyByScope: scopedHistoryWithActive(session.historyByScope, session.activeScope, {
      past: [...session.past, clonePermissionValues(session.present)].slice(-50),
      future: session.future.slice(1),
    }),
  }, context);
  return sessionFor(context).present;
}

export function resetPermissionPreview(context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT): PermissionValues {
  const session = sessionFor(context);
  if (permissionValuesEqual(session.present, DEFAULT_PERMISSION_VALUES)) return session.present;
  publish({
    past: [...session.past, clonePermissionValues(session.present)].slice(-50),
    present: DEFAULT_PERMISSION_VALUES,
    future: [],
    activeScope: session.activeScope,
    valuesByScope: scopedValuesWithPresent(session.valuesByScope, session.activeScope, DEFAULT_PERMISSION_VALUES),
    historyByScope: scopedHistoryWithActive(session.historyByScope, session.activeScope, {
      past: [...session.past, clonePermissionValues(session.present)].slice(-50),
      future: [],
    }),
  }, context);
  return sessionFor(context).present;
}

/** Resets every renderer-local scope while keeping the currently selected scope visible. */
export function resetAllPermissionPreviews(context: PermissionDraftContext = DEFAULT_PERMISSION_DRAFT_CONTEXT): void {
  const session = sessionFor(context);
  const activeScope = session.activeScope;
  const valuesByScope = defaultScopedPermissionValues();
  const historyByScope = defaultScopedPermissionHistory();
  publish({
    past: [],
    present: clonePermissionValues(valuesByScope[activeScope]),
    future: [],
    activeScope,
    valuesByScope,
    historyByScope,
  }, context);
}

/** Test/preview helper; state never leaves this renderer module. */
export function resetPermissionSession(context?: PermissionDraftContext): void {
  const contexts = context
    ? [context]
    : [...new Set([...sessions.keys(), ...listenersByContext.keys()])];
  for (const key of contexts) {
    sessions.set(key, createPermissionSession());
    listenersByContext.get(key)?.forEach((listener) => listener());
  }
}
