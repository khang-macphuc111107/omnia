import { assertDomain } from "./errors";
import type { KernelCapability } from "./kernel-capability";
import {
  assertIsoTimestamp,
  assertNonBlank,
  freezeJson,
  type IsoTimestamp,
  type JsonValue,
} from "./shared";

/**
 * Renderer/native neutral plugin catalog.  A registration is metadata and
 * configuration only; it never grants a plugin process or capability access.
 * The native broker is still responsible for evaluating the requested
 * capabilities before an enabled plugin can execute.
 */
export type OmniaPluginKind =
  | "plugin"
  | "skill-bundle"
  | "mcp-bridge"
  | "lsp-server"
  | "formatter"
  | "connector";

export type OmniaPluginSource =
  | "built-in"
  | "local"
  | "workspace"
  | "import"
  | "marketplace"
  | "remote";

export type OmniaPluginTrust = "unverified" | "reviewed" | "verified" | "revoked";
export type OmniaPluginStatus =
  | "available"
  | "installed"
  | "enabled"
  | "disabled"
  | "blocked";

export type OmniaPluginSettingType =
  | "string"
  | "multiline"
  | "number"
  | "boolean"
  | "select"
  | "json";

export interface OmniaPluginDependency {
  readonly id: string;
  readonly versionRange: string;
  readonly optional?: boolean;
}

export interface OmniaPluginContribution {
  readonly id: string;
  readonly kind:
    | "command"
    | "panel"
    | "activity"
    | "editor"
    | "prompt"
    | "provider"
    | "agent";
  readonly label: string;
  readonly description?: string;
}

export interface OmniaPluginSetting {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly type: OmniaPluginSettingType;
  readonly defaultValue: JsonValue;
  readonly options?: readonly string[];
  readonly required?: boolean;
  readonly secret?: boolean;
}

export interface OmniaPluginManifest {
  readonly schemaVersion: 1;
  /** Stable logical ID.  Versions are carried by `version`. */
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string;
  readonly kind: OmniaPluginKind;
  readonly source: OmniaPluginSource;
  readonly author?: string;
  readonly homepage?: string;
  readonly entrypoint?: string;
  readonly endpoint?: string;
  readonly requestedCapabilities: readonly KernelCapability[];
  readonly dependencies: readonly OmniaPluginDependency[];
  readonly contributions: readonly OmniaPluginContribution[];
  readonly settings: readonly OmniaPluginSetting[];
  readonly tags: readonly string[];
  readonly compatibility: readonly string[];
  readonly manifestHash?: string;
  readonly contentHash?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
}

export interface OmniaPluginRegistration {
  readonly manifest: OmniaPluginManifest;
  readonly status: OmniaPluginStatus;
  readonly trust: OmniaPluginTrust;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly registeredAt: IsoTimestamp;
  readonly installedAt?: IsoTimestamp;
  readonly enabledAt?: IsoTimestamp;
  readonly disabledAt?: IsoTimestamp;
  readonly blockedAt?: IsoTimestamp;
  readonly blockedReason?: string;
}

export interface OmniaPluginRegistry {
  readonly version: 1;
  readonly plugins: readonly OmniaPluginRegistration[];
  readonly selectedPluginId?: string;
}

/** Optional filters used when querying the renderer-safe plugin registry. */
export interface OmniaPluginRegistryQuery {
  readonly search?: string;
  readonly kind?: OmniaPluginKind;
  readonly source?: OmniaPluginSource;
  readonly status?: OmniaPluginStatus;
  readonly trust?: OmniaPluginTrust;
  readonly tag?: string;
  readonly includeBlocked?: boolean;
  readonly limit?: number;
}

export interface OmniaPluginTrustInput {
  readonly trust: Exclude<OmniaPluginTrust, "unverified">;
  readonly at: IsoTimestamp;
  readonly reason?: string;
}

const PLUGIN_KINDS: readonly OmniaPluginKind[] = [
  "plugin",
  "skill-bundle",
  "mcp-bridge",
  "lsp-server",
  "formatter",
  "connector",
];
const PLUGIN_SOURCES: readonly OmniaPluginSource[] = [
  "built-in",
  "local",
  "workspace",
  "import",
  "marketplace",
  "remote",
];
const PLUGIN_TRUST: readonly OmniaPluginTrust[] = ["unverified", "reviewed", "verified", "revoked"];
const PLUGIN_STATUSES: readonly OmniaPluginStatus[] = [
  "available",
  "installed",
  "enabled",
  "disabled",
  "blocked",
];
const SETTING_TYPES: readonly OmniaPluginSettingType[] = [
  "string",
  "multiline",
  "number",
  "boolean",
  "select",
  "json",
];
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry));
  return isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry));
}

function normalizeId(value: string, label: string): string {
  const id = assertNonBlank(value, label, 160).toLowerCase();
  assertDomain(ID_PATTERN.test(id), "invalid_argument", `${label} must be a lowercase namespaced identifier.`);
  return id;
}

function normalizeVersion(value: string): string {
  const version = assertNonBlank(value, "plugin version", 64);
  assertDomain(VERSION_PATTERN.test(version), "invalid_argument", "Plugin version is malformed.");
  return version;
}

function normalizeSetting(setting: OmniaPluginSetting): OmniaPluginSetting {
  assertDomain(SETTING_TYPES.includes(setting.type), "invalid_argument", "Unknown plugin setting type.");
  const key = normalizeId(setting.key, "plugin setting key");
  const label = assertNonBlank(setting.label, "plugin setting label", 160);
  assertDomain(isJsonValue(setting.defaultValue), "invalid_argument", "Plugin setting default must be JSON-compatible.");
  if (setting.type === "select") {
    assertDomain(
      setting.options !== undefined && setting.options.length > 0,
      "invalid_argument",
      "Select settings must declare options.",
    );
  }
  if (setting.options !== undefined) {
    const options = setting.options.map((option) => assertNonBlank(option, "plugin setting option", 240));
    assertDomain(new Set(options).size === options.length, "invalid_argument", "Plugin setting options must be unique.");
    return Object.freeze({
      ...setting,
      key,
      label,
      ...(setting.description === undefined ? {} : { description: assertNonBlank(setting.description, "plugin setting description", 2_000) }),
      options: Object.freeze(options),
    });
  }
  return Object.freeze({
    ...setting,
    key,
    label,
    ...(setting.description === undefined ? {} : { description: assertNonBlank(setting.description, "plugin setting description", 2_000) }),
  });
}

function normalizeManifest(input: OmniaPluginManifest): OmniaPluginManifest {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported plugin manifest version.");
  const id = normalizeId(input.id, "plugin ID");
  const name = normalizeId(input.name, "plugin name");
  const displayName = assertNonBlank(input.displayName, "plugin display name", 160);
  const version = normalizeVersion(input.version);
  const description = assertNonBlank(input.description, "plugin description", 4_000);
  assertDomain(isOneOf(PLUGIN_KINDS, input.kind), "invalid_argument", "Unknown plugin kind.");
  assertDomain(isOneOf(PLUGIN_SOURCES, input.source), "invalid_argument", "Unknown plugin source.");
  assertIsoTimestamp(input.createdAt, "plugin creation time");
  if (input.updatedAt !== undefined) {
    assertIsoTimestamp(input.updatedAt, "plugin update time");
    assertDomain(Date.parse(input.updatedAt) >= Date.parse(input.createdAt), "invalid_argument", "Plugin update time cannot precede creation.");
  }
  const requestedCapabilities = Object.freeze([...new Set(input.requestedCapabilities)]);
  const dependencies = input.dependencies.map((dependency) => {
    const dependencyId = normalizeId(dependency.id, "plugin dependency ID");
    const versionRange = assertNonBlank(dependency.versionRange, "plugin dependency version range", 160);
    return Object.freeze({
      id: dependencyId,
      versionRange,
      ...(dependency.optional === undefined ? {} : { optional: dependency.optional }),
    });
  });
  assertDomain(
    new Set(dependencies.map((dependency) => dependency.id)).size === dependencies.length,
    "invalid_argument",
    "Plugin dependencies must be unique.",
  );
  const contributions = input.contributions.map((contribution) => Object.freeze({
    id: normalizeId(contribution.id, "plugin contribution ID"),
    kind: contribution.kind,
    label: assertNonBlank(contribution.label, "plugin contribution label", 160),
    ...(contribution.description === undefined ? {} : { description: assertNonBlank(contribution.description, "plugin contribution description", 2_000) }),
  }));
  assertDomain(new Set(contributions.map((contribution) => contribution.id)).size === contributions.length, "invalid_argument", "Plugin contributions must be unique.");
  const settings = input.settings.map(normalizeSetting);
  assertDomain(new Set(settings.map((setting) => setting.key)).size === settings.length, "invalid_argument", "Plugin setting keys must be unique.");
  const tags = Object.freeze([...new Set(input.tags.map((tag) => assertNonBlank(tag, "plugin tag", 80).toLowerCase()))]);
  const compatibility = Object.freeze([...new Set(input.compatibility.map((value) => assertNonBlank(value, "plugin compatibility", 160)))]);
  return Object.freeze({
    ...input,
    id,
    name,
    displayName,
    version,
    description,
    requestedCapabilities,
    dependencies: Object.freeze(dependencies),
    contributions: Object.freeze(contributions),
    settings: Object.freeze(settings),
    tags,
    compatibility,
    ...(input.author === undefined ? {} : { author: assertNonBlank(input.author, "plugin author", 240) }),
    ...(input.homepage === undefined ? {} : { homepage: assertNonBlank(input.homepage, "plugin homepage", 4_096) }),
    ...(input.entrypoint === undefined ? {} : { entrypoint: assertNonBlank(input.entrypoint, "plugin entrypoint", 4_096) }),
    ...(input.endpoint === undefined ? {} : { endpoint: assertNonBlank(input.endpoint, "plugin endpoint", 4_096) }),
  });
}

function defaultSettings(manifest: OmniaPluginManifest): Readonly<Record<string, JsonValue>> {
  return Object.freeze(Object.fromEntries(manifest.settings.map((setting) => [setting.key, freezeJson(setting.defaultValue)])));
}

function assertRegistry(registry: OmniaPluginRegistry): void {
  assertDomain(registry.version === 1, "invalid_argument", "Unsupported plugin registry version.");
  assertDomain(Array.isArray(registry.plugins), "invalid_argument", "Plugin registry entries must be an array.");
}

function findPlugin(registry: OmniaPluginRegistry, pluginId: string): OmniaPluginRegistration {
  const id = normalizeId(pluginId, "plugin ID");
  const plugin = registry.plugins.find((candidate) => candidate.manifest.id === id);
  assertDomain(plugin !== undefined, "not_found", "Plugin was not found.", { pluginId: id });
  return plugin;
}

function replacePlugin(registry: OmniaPluginRegistry, replacement: OmniaPluginRegistration): OmniaPluginRegistry {
  const index = registry.plugins.findIndex((plugin) => plugin.manifest.id === replacement.manifest.id);
  assertDomain(index >= 0, "not_found", "Plugin was not found for replacement.");
  const plugins = [...registry.plugins];
  plugins[index] = Object.freeze(replacement);
  return Object.freeze({ ...registry, plugins: Object.freeze(plugins) });
}

function transitionAllowed(from: OmniaPluginStatus, to: OmniaPluginStatus): boolean {
  if (from === "available") return to === "installed" || to === "blocked";
  if (from === "installed") return to === "enabled" || to === "disabled" || to === "blocked";
  if (from === "enabled") return to === "disabled" || to === "blocked";
  if (from === "disabled") return to === "enabled" || to === "blocked";
  return to === "available";
}

/** Creates an immutable, empty plugin registry. */
export function createOmniaPluginRegistry(): OmniaPluginRegistry {
  return Object.freeze({ version: 1, plugins: Object.freeze([]) });
}

/** Registers metadata only; installation and authority are separate actions. */
export function registerOmniaPlugin(
  registry: OmniaPluginRegistry,
  manifestInput: OmniaPluginManifest,
): OmniaPluginRegistry {
  assertRegistry(registry);
  const manifest = normalizeManifest(manifestInput);
  assertDomain(!registry.plugins.some((plugin) => plugin.manifest.id === manifest.id), "conflict", "Plugin ID is already registered.", { pluginId: manifest.id });
  const registration: OmniaPluginRegistration = Object.freeze({
    manifest,
    status: "available",
    trust: manifest.source === "built-in" ? "verified" : "unverified",
    settings: defaultSettings(manifest),
    registeredAt: manifest.createdAt,
  });
  return Object.freeze({ ...registry, plugins: Object.freeze([...registry.plugins, registration]) });
}

/** Explicitly replaces a registration and resets its lifecycle/trust state. */
export function replaceOmniaPlugin(
  registry: OmniaPluginRegistry,
  manifestInput: OmniaPluginManifest,
): OmniaPluginRegistry {
  assertRegistry(registry);
  const manifest = normalizeManifest(manifestInput);
  const existing = findPlugin(registry, manifest.id);
  const settings: Record<string, JsonValue> = {};
  for (const setting of manifest.settings) {
    const existingValue = existing.settings[setting.key];
    settings[setting.key] = existingValue === undefined ? setting.defaultValue : existingValue;
  }
  return replacePlugin(registry, Object.freeze({
    manifest,
    status: "available",
    trust: manifest.source === "built-in" ? "verified" : "unverified",
    settings: Object.freeze(settings),
    registeredAt: existing.registeredAt,
  }));
}

export function setOmniaPluginTrust(
  registry: OmniaPluginRegistry,
  pluginId: string,
  input: OmniaPluginTrustInput,
): OmniaPluginRegistry {
  assertRegistry(registry);
  const plugin = findPlugin(registry, pluginId);
  assertIsoTimestamp(input.at, "plugin trust review time");
  assertDomain(Date.parse(input.at) >= Date.parse(plugin.manifest.createdAt), "invalid_argument", "Plugin trust review cannot precede plugin creation.");
  if (input.trust === "revoked") {
    return replacePlugin(registry, {
      ...plugin,
      trust: "revoked",
      status: plugin.status === "enabled" ? "disabled" : plugin.status,
      ...(plugin.status === "enabled" ? { disabledAt: input.at } : {}),
    });
  }
  return replacePlugin(registry, { ...plugin, trust: input.trust });
}

export function transitionOmniaPlugin(
  registry: OmniaPluginRegistry,
  pluginId: string,
  status: OmniaPluginStatus,
  at: IsoTimestamp,
  reason?: string,
): OmniaPluginRegistry {
  assertRegistry(registry);
  const plugin = findPlugin(registry, pluginId);
  assertDomain(isOneOf(PLUGIN_STATUSES, status), "invalid_argument", "Unknown plugin status.");
  assertIsoTimestamp(at, "plugin lifecycle time");
  assertDomain(transitionAllowed(plugin.status, status), "invalid_state_transition", `Cannot transition plugin from ${plugin.status} to ${status}.`);
  if (status === "enabled") {
    assertDomain(plugin.trust === "reviewed" || plugin.trust === "verified", "permission_denied", "Plugin must be reviewed before it can be enabled.");
  }
  if (status === "blocked") {
    assertDomain(reason !== undefined && reason.trim().length > 0, "invalid_argument", "Blocking a plugin requires a reason.");
  }
  const next: OmniaPluginRegistration = {
    ...plugin,
    status,
    ...(status === "installed" ? { installedAt: at } : {}),
    ...(status === "enabled" ? { enabledAt: at } : {}),
    ...(status === "disabled" ? { disabledAt: at } : {}),
    ...(status === "blocked" ? { blockedAt: at, blockedReason: assertNonBlank(reason ?? "", "plugin block reason", 1_000) } : {}),
    ...(status === "available" ? { trust: "unverified" as const } : {}),
  };
  return replacePlugin(registry, next);
}

export function installOmniaPlugin(registry: OmniaPluginRegistry, pluginId: string, at: IsoTimestamp): OmniaPluginRegistry {
  return transitionOmniaPlugin(registry, pluginId, "installed", at);
}

export function enableOmniaPlugin(registry: OmniaPluginRegistry, pluginId: string, at: IsoTimestamp): OmniaPluginRegistry {
  return transitionOmniaPlugin(registry, pluginId, "enabled", at);
}

export function disableOmniaPlugin(registry: OmniaPluginRegistry, pluginId: string, at: IsoTimestamp): OmniaPluginRegistry {
  return transitionOmniaPlugin(registry, pluginId, "disabled", at);
}

export function blockOmniaPlugin(registry: OmniaPluginRegistry, pluginId: string, at: IsoTimestamp, reason: string): OmniaPluginRegistry {
  return transitionOmniaPlugin(registry, pluginId, "blocked", at, reason);
}

export function selectOmniaPlugin(registry: OmniaPluginRegistry, pluginId: string): OmniaPluginRegistry {
  const plugin = findPlugin(registry, pluginId);
  return Object.freeze({ ...registry, selectedPluginId: plugin.manifest.id });
}

export function updateOmniaPluginSettings(
  registry: OmniaPluginRegistry,
  pluginId: string,
  values: Readonly<Record<string, JsonValue>>,
): OmniaPluginRegistry {
  assertRegistry(registry);
  const plugin = findPlugin(registry, pluginId);
  const schema = new Map(plugin.manifest.settings.map((setting) => [setting.key, setting]));
  for (const [key, value] of Object.entries(values)) {
    const setting = schema.get(key);
    assertDomain(setting !== undefined, "invalid_argument", "Unknown plugin setting.", { pluginId, key });
    assertDomain(isJsonValue(value), "invalid_argument", "Plugin setting value must be JSON-compatible.", { pluginId, key });
    if (setting.type === "select") {
      assertDomain(typeof value === "string" && setting.options?.includes(value), "invalid_argument", "Plugin setting value is not one of the declared options.", { pluginId, key });
    }
    if (setting.type === "number") assertDomain(typeof value === "number" && Number.isFinite(value), "invalid_argument", "Plugin number setting must be finite.", { pluginId, key });
    if (setting.type === "boolean") assertDomain(typeof value === "boolean", "invalid_argument", "Plugin boolean setting must be boolean.", { pluginId, key });
  }
  return replacePlugin(registry, { ...plugin, settings: Object.freeze({ ...plugin.settings, ...values }) });
}

export function resetOmniaPluginSettings(registry: OmniaPluginRegistry, pluginId: string): OmniaPluginRegistry {
  const plugin = findPlugin(registry, pluginId);
  return replacePlugin(registry, { ...plugin, settings: defaultSettings(plugin.manifest) });
}

/** Resolves only an enabled, reviewed/verified, non-revoked plugin. */
export function resolveOmniaPlugin(registry: OmniaPluginRegistry, pluginId: string): OmniaPluginRegistration {
  assertRegistry(registry);
  const plugin = findPlugin(registry, pluginId);
  assertDomain(plugin.status === "enabled", "unsupported_capability", "Plugin is not enabled.");
  assertDomain(plugin.trust === "reviewed" || plugin.trust === "verified", "permission_denied", "Plugin trust is missing or revoked.");
  return plugin;
}

export function serializeOmniaPluginRegistry(registry: OmniaPluginRegistry): string {
  assertRegistry(registry);
  return JSON.stringify(registry, null, 2);
}

function parseManifest(value: unknown): OmniaPluginManifest {
  assertDomain(isRecord(value), "invalid_argument", "Invalid plugin manifest.");
  const manifest = value as Partial<OmniaPluginManifest>;
  assertDomain(isOneOf(PLUGIN_KINDS, manifest.kind), "invalid_argument", "Invalid plugin kind.");
  assertDomain(isOneOf(PLUGIN_SOURCES, manifest.source), "invalid_argument", "Invalid plugin source.");
  assertDomain(Array.isArray(manifest.requestedCapabilities), "invalid_argument", "Plugin capabilities must be an array.");
  assertDomain(Array.isArray(manifest.dependencies), "invalid_argument", "Plugin dependencies must be an array.");
  assertDomain(Array.isArray(manifest.contributions), "invalid_argument", "Plugin contributions must be an array.");
  assertDomain(Array.isArray(manifest.settings), "invalid_argument", "Plugin settings must be an array.");
  assertDomain(Array.isArray(manifest.tags), "invalid_argument", "Plugin tags must be an array.");
  assertDomain(Array.isArray(manifest.compatibility), "invalid_argument", "Plugin compatibility must be an array.");
  return normalizeManifest(manifest as OmniaPluginManifest);
}

function parseRegistration(value: unknown): OmniaPluginRegistration {
  assertDomain(isRecord(value), "invalid_argument", "Invalid plugin registration.");
  const registration = value as Partial<OmniaPluginRegistration>;
  const manifest = parseManifest(registration.manifest);
  assertDomain(isOneOf(PLUGIN_STATUSES, registration.status), "invalid_argument", "Invalid plugin status.");
  assertDomain(isOneOf(PLUGIN_TRUST, registration.trust), "invalid_argument", "Invalid plugin trust state.");
  assertDomain(isRecord(registration.settings), "invalid_argument", "Plugin settings must be an object.");
  assertDomain(typeof registration.registeredAt === "string", "invalid_argument", "Plugin registration time is required.");
  assertIsoTimestamp(registration.registeredAt, "plugin registration time");
  const settings = Object.fromEntries(Object.entries(registration.settings).map(([key, value]) => {
    assertDomain(isJsonValue(value), "invalid_argument", "Plugin setting value must be JSON-compatible.");
    return [key, freezeJson(value)];
  }));
  return Object.freeze({
    manifest,
    status: registration.status,
    trust: registration.trust,
    settings: Object.freeze(settings),
    registeredAt: registration.registeredAt,
    ...(typeof registration.installedAt === "string" ? { installedAt: registration.installedAt } : {}),
    ...(typeof registration.enabledAt === "string" ? { enabledAt: registration.enabledAt } : {}),
    ...(typeof registration.disabledAt === "string" ? { disabledAt: registration.disabledAt } : {}),
    ...(typeof registration.blockedAt === "string" ? { blockedAt: registration.blockedAt } : {}),
    ...(typeof registration.blockedReason === "string" ? { blockedReason: registration.blockedReason } : {}),
  });
}

export function deserializeOmniaPluginRegistry(input: string | unknown): OmniaPluginRegistry {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value), "invalid_argument", "Invalid plugin registry.");
  assertDomain(value.version === 1 && Array.isArray(value.plugins), "invalid_argument", "Invalid plugin registry version or entries.");
  const plugins = value.plugins.map(parseRegistration);
  assertDomain(new Set(plugins.map((plugin) => plugin.manifest.id)).size === plugins.length, "conflict", "Plugin IDs must be unique.");
  return Object.freeze({
    version: 1,
    plugins: Object.freeze(plugins),
    ...(typeof value.selectedPluginId === "string" ? { selectedPluginId: normalizeId(value.selectedPluginId, "selected plugin ID") } : {}),
  });
}
