import { assertDomain } from "./errors";
import type {
  IntegrationId,
  IntegrationVersionId,
} from "./ids";
import { assertPositiveSafeInteger, EXECUTION_MODE_VALUES, KERNEL_CAPABILITY_VALUES, uniqueValues } from "./agent-tool-contract-shared";
import type { ConcreteExecutionMode } from "./execution";
import type { KernelCapability } from "./kernel-capability";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/**
 * The common extension vocabulary.  These values describe a package or
 * endpoint, not an execution permission.  In particular, MCP is a transport
 * kind and is not a trust level.
 */
export type IntegrationKind =
  | "skill"
  | "tool"
  | "mcp-server"
  | "plugin"
  | "lsp-server"
  | "formatter"
  | "connector";

export type IntegrationOrigin =
  | "built-in"
  | "local"
  | "workspace"
  | "project"
  | "import"
  | "marketplace"
  | "remote";

export type IntegrationTrustState =
  | "untrusted"
  | "trusted"
  | "stale"
  | "revoked";

export type IntegrationLifecycle =
  | "discovered"
  | "installed"
  | "enabled"
  | "disabled"
  | "blocked";

/** Stable effect labels shared by tools, MCP, plugins and host integrations. */
export type IntegrationEffect =
  | "pure-compute"
  | "app-data-read"
  | "workspace-read"
  | "workspace-write"
  | "process-execution"
  | "network"
  | "external-side-effect"
  | "browser-control"
  | "computer-control"
  | "privileged-operation"
  | "secret-use";

export type IntegrationDataClass =
  | "public"
  | "standard"
  | "sensitive"
  | "secret";

export type IntegrationTransport =
  | "in-process"
  | "stdio"
  | "sse"
  | "streamable-http"
  | "websocket";

export interface IntegrationDependency {
  readonly name: string;
  readonly version: string;
  readonly digest?: string;
}

export interface IntegrationResourceLimits {
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly defaultTimeoutMs: number;
}

export interface IntegrationSignature {
  readonly algorithm: "ed25519" | "unknown";
  readonly keyId: string;
  readonly signatureHash: string;
}

export interface IntegrationProvenance {
  readonly publisher?: string;
  readonly sourceUri?: string;
  readonly signature?: IntegrationSignature;
}

/**
 * Immutable, content-addressed metadata for one exact integration version.
 * This record declares authority; it never grants authority by itself.
 */
export interface IntegrationVersionManifest {
  readonly schemaVersion: 1;
  readonly id: IntegrationVersionId;
  readonly integrationId: IntegrationId;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly version: string;
  readonly kind: IntegrationKind;
  readonly origin: IntegrationOrigin;
  readonly provenance?: IntegrationProvenance;
  readonly transport?: IntegrationTransport;
  readonly endpoint?: string;
  readonly manifestHash: string;
  readonly contentHash: string;
  readonly implementationHash: string;
  readonly schemaHash: string;
  readonly dependencyHash: string;
  readonly effectSetHash: string;
  readonly destinationSetHash: string;
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly effects: readonly IntegrationEffect[];
  readonly destinations: readonly string[];
  readonly dataClasses: readonly IntegrationDataClass[];
  readonly supportedEnvironments: readonly ConcreteExecutionMode[];
  readonly dependencies: readonly IntegrationDependency[];
  readonly limits: IntegrationResourceLimits;
  readonly registeredAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
}

export interface IntegrationDigest {
  readonly manifestHash: string;
  readonly contentHash: string;
  readonly implementationHash: string;
  readonly schemaHash: string;
  readonly dependencyHash: string;
  readonly effectSetHash: string;
  readonly destinationSetHash: string;
}

export interface IntegrationTrust {
  readonly state: IntegrationTrustState;
  /** The exact manifest/code/schema/dependency/effect set that was reviewed. */
  readonly digest: IntegrationDigest;
  readonly reviewedAt?: IsoTimestamp;
  readonly reviewedBy?: "user" | "policy" | "built-in";
  readonly reason?: string;
}

export interface IntegrationRegistration {
  readonly manifest: IntegrationVersionManifest;
  readonly lifecycle: IntegrationLifecycle;
  readonly trust: IntegrationTrust;
  readonly discoveredAt: IsoTimestamp;
  readonly installedAt?: IsoTimestamp;
  readonly enabledAt?: IsoTimestamp;
  readonly disabledAt?: IsoTimestamp;
  readonly blockedAt?: IsoTimestamp;
  readonly blockedReason?: string;
}

export interface IntegrationRegistry {
  readonly version: 1;
  readonly integrations: readonly IntegrationRegistration[];
}

export interface IntegrationTrustInput {
  readonly reviewedAt: IsoTimestamp;
  readonly reviewedBy?: "user" | "policy" | "built-in";
  readonly reason?: string;
}

export interface IntegrationLifecycleTransition {
  readonly to: IntegrationLifecycle;
  readonly at: IsoTimestamp;
  readonly reason?: string;
}

const INTEGRATION_KIND_VALUES: ReadonlySet<IntegrationKind> = new Set([
  "skill",
  "tool",
  "mcp-server",
  "plugin",
  "lsp-server",
  "formatter",
  "connector",
]);
const INTEGRATION_ORIGIN_VALUES: ReadonlySet<IntegrationOrigin> = new Set([
  "built-in",
  "local",
  "workspace",
  "project",
  "import",
  "marketplace",
  "remote",
]);
const INTEGRATION_TRUST_VALUES: ReadonlySet<IntegrationTrustState> = new Set([
  "untrusted",
  "trusted",
  "stale",
  "revoked",
]);
const INTEGRATION_LIFECYCLE_VALUES: ReadonlySet<IntegrationLifecycle> = new Set([
  "discovered",
  "installed",
  "enabled",
  "disabled",
  "blocked",
]);
const INTEGRATION_EFFECT_CAPABILITY = {
  "pure-compute": "pure_compute",
  "app-data-read": "read_app_data",
  "workspace-read": "read_workspace",
  "workspace-write": "write_workspace",
  "process-execution": "execute_process",
  network: "use_network",
  "external-side-effect": "external_side_effect",
  "browser-control": "control_browser",
  "computer-control": "control_computer",
  "privileged-operation": "request_admin",
  "secret-use": "access_secret_handle",
} as const satisfies Readonly<Record<IntegrationEffect, KernelCapability>>;
const INTEGRATION_EFFECT_VALUES: ReadonlySet<IntegrationEffect> = new Set(
  Object.keys(INTEGRATION_EFFECT_CAPABILITY) as IntegrationEffect[],
);
const INTEGRATION_DATA_CLASS_VALUES: ReadonlySet<IntegrationDataClass> = new Set([
  "public",
  "standard",
  "sensitive",
  "secret",
]);
const INTEGRATION_TRANSPORT_VALUES: ReadonlySet<IntegrationTransport> = new Set([
  "in-process",
  "stdio",
  "sse",
  "streamable-http",
  "websocket",
]);
const INTEGRATION_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const INTEGRATION_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const RESERVED_INTEGRATION_NAMESPACES = new Set(["kernel", "omnia", "system"]);
const INTEGRATION_LIFECYCLE_TRANSITIONS: Readonly<
  Record<IntegrationLifecycle, readonly IntegrationLifecycle[]>
> = {
  discovered: ["installed", "blocked"],
  installed: ["enabled", "disabled", "blocked"],
  enabled: ["disabled", "blocked"],
  disabled: ["enabled", "blocked"],
  blocked: ["discovered"],
};

function normalizeDestination(value: string): string {
  const normalized = assertNonBlank(value, "integration destination", 2_048);
  assertDomain(
    normalized !== "*" && !normalized.includes("\n") && !normalized.includes("\r"),
    "invalid_argument",
    "Integration destinations must be explicit and may not use a global wildcard.",
  );
  return normalized;
}

function assertEntityId(value: string, label: string): string {
  return assertNonBlank(value, label, 200);
}

function normalizeVersion(value: string): string {
  const version = assertNonBlank(value, "integration version", 64);
  assertDomain(
    INTEGRATION_VERSION_PATTERN.test(version),
    "invalid_argument",
    "Integration version is malformed.",
  );
  return version;
}

function normalizeName(value: string): string {
  const canonicalName = assertNonBlank(value, "integration canonical name", 160).toLowerCase();
  assertDomain(
    INTEGRATION_NAME_PATTERN.test(canonicalName),
    "invalid_argument",
    "Integration names must be lowercase and may contain namespace segments.",
    { canonicalName },
  );
  return canonicalName;
}

function digestForManifest(manifest: IntegrationVersionManifest): IntegrationDigest {
  return Object.freeze({
    manifestHash: manifest.manifestHash,
    contentHash: manifest.contentHash,
    implementationHash: manifest.implementationHash,
    schemaHash: manifest.schemaHash,
    dependencyHash: manifest.dependencyHash,
    effectSetHash: manifest.effectSetHash,
    destinationSetHash: manifest.destinationSetHash,
  });
}

function sameDigest(left: IntegrationDigest, right: IntegrationDigest): boolean {
  return (
    left.manifestHash === right.manifestHash &&
    left.contentHash === right.contentHash &&
    left.implementationHash === right.implementationHash &&
    left.schemaHash === right.schemaHash &&
    left.dependencyHash === right.dependencyHash &&
    left.effectSetHash === right.effectSetHash &&
    left.destinationSetHash === right.destinationSetHash
  );
}

function normalizeManifest(input: IntegrationVersionManifest): IntegrationVersionManifest {
  assertDomain(input.schemaVersion === 1, "invalid_argument", "Unsupported integration manifest version.");
  assertEntityId(input.id, "integration version ID");
  assertEntityId(input.integrationId, "integration ID");
  assertDomain(INTEGRATION_KIND_VALUES.has(input.kind), "invalid_argument", "Unknown integration kind.");
  assertDomain(INTEGRATION_ORIGIN_VALUES.has(input.origin), "invalid_argument", "Unknown integration origin.");
  const canonicalName = normalizeName(input.canonicalName);
  const namespace = canonicalName.split(".")[0] ?? "";
  assertDomain(
    input.origin === "built-in" || !RESERVED_INTEGRATION_NAMESPACES.has(namespace),
    "permission_denied",
    "Non-built-in integrations cannot register inside a reserved namespace.",
    { namespace },
  );
  const version = normalizeVersion(input.version);
  assertIsoTimestamp(input.registeredAt, "integration registration time");
  if (input.updatedAt !== undefined) {
    assertIsoTimestamp(input.updatedAt, "integration update time");
    assertDomain(
      Date.parse(input.updatedAt) >= Date.parse(input.registeredAt),
      "invalid_argument",
      "Integration update time cannot precede registration.",
    );
  }

  if (input.transport !== undefined) {
    assertDomain(
      INTEGRATION_TRANSPORT_VALUES.has(input.transport),
      "invalid_argument",
      "Unknown integration transport.",
    );
  }
  if (input.kind === "mcp-server") {
    assertDomain(input.transport !== undefined, "invalid_argument", "MCP servers must declare a transport.");
  }
  if (input.endpoint !== undefined) {
    assertNonBlank(input.endpoint, "integration endpoint", 4_096);
  }

  const requiredCapabilities = uniqueValues(input.requiredCapabilities, "Integration capabilities");
  assertDomain(
    requiredCapabilities.every((capability) => KERNEL_CAPABILITY_VALUES.has(capability)),
    "invalid_argument",
    "Integration manifest contains an unknown kernel capability.",
  );
  const effects = uniqueValues(input.effects, "Integration effects");
  assertDomain(
    effects.every((effect) => INTEGRATION_EFFECT_VALUES.has(effect)),
    "invalid_argument",
    "Integration manifest contains an unknown effect.",
  );
  const destinations = uniqueValues(
    input.destinations.map((destination) => normalizeDestination(destination)),
    "Integration destinations",
  );
  const dataClasses = uniqueValues(input.dataClasses, "Integration data classes");
  assertDomain(
    dataClasses.length > 0 && dataClasses.every((dataClass) => INTEGRATION_DATA_CLASS_VALUES.has(dataClass)),
    "invalid_argument",
    "Integration manifest must declare one or more recognized data classes.",
  );
  const supportedEnvironments = uniqueValues(input.supportedEnvironments, "Integration environments");
  assertDomain(
    supportedEnvironments.length > 0 &&
      supportedEnvironments.every((environment) => EXECUTION_MODE_VALUES.has(environment)),
    "invalid_argument",
    "Integration manifest must declare one or more recognized execution environments.",
  );

  if (input.kind === "skill") {
    assertDomain(
      requiredCapabilities.length === 0 && effects.length === 0 && destinations.length === 0,
      "scope_violation",
      "Skills provide instructions and resources; they cannot declare executable authority.",
    );
  } else {
    assertDomain(effects.length > 0, "invalid_argument", "Executable integrations must declare at least one effect.");
  }
  for (const effect of effects) {
    const capability = INTEGRATION_EFFECT_CAPABILITY[effect];
    assertDomain(
      requiredCapabilities.includes(capability),
      "scope_violation",
      "Every integration effect must have its matching kernel capability.",
      { effect, capability },
    );
  }
  const expectedCapabilities = new Set(effects.map((effect) => INTEGRATION_EFFECT_CAPABILITY[effect]));
  assertDomain(
    expectedCapabilities.size === requiredCapabilities.length &&
      requiredCapabilities.every((capability) => expectedCapabilities.has(capability)),
    "scope_violation",
    "Integration effects and requested capabilities must describe the same authority set.",
  );

  const dependencies = input.dependencies.map((dependency) => {
    const name = assertNonBlank(dependency.name, "integration dependency name", 160).toLowerCase();
    const version = normalizeVersion(dependency.version);
    const digest = dependency.digest === undefined ? undefined : assertSha256(dependency.digest, "integration dependency digest");
    return Object.freeze({
      name,
      version,
      ...(digest === undefined ? {} : { digest }),
    });
  });
  assertDomain(
    new Set(dependencies.map((dependency) => `${dependency.name}@${dependency.version}`)).size === dependencies.length,
    "invalid_argument",
    "Integration dependencies must be unique.",
  );
  assertPositiveSafeInteger(input.limits.maximumInputBytes, "Integration input byte limit");
  assertPositiveSafeInteger(input.limits.maximumOutputBytes, "Integration output byte limit");
  assertPositiveSafeInteger(input.limits.defaultTimeoutMs, "Integration timeout");

  const manifestHash = assertSha256(input.manifestHash, "integration manifest hash");
  const contentHash = assertSha256(input.contentHash, "integration content hash");
  const implementationHash = assertSha256(input.implementationHash, "integration implementation hash");
  const schemaHash = assertSha256(input.schemaHash, "integration schema hash");
  const dependencyHash = assertSha256(input.dependencyHash, "integration dependency hash");
  const effectSetHash = assertSha256(input.effectSetHash, "integration effect-set hash");
  const destinationSetHash = assertSha256(input.destinationSetHash, "integration destination-set hash");

  let provenance: IntegrationProvenance | undefined;
  if (input.provenance !== undefined) {
    const publisher = input.provenance.publisher === undefined
      ? undefined
      : assertNonBlank(input.provenance.publisher, "integration publisher", 240);
    const sourceUri = input.provenance.sourceUri === undefined
      ? undefined
      : assertNonBlank(input.provenance.sourceUri, "integration source URI", 4_096);
    let signature: IntegrationSignature | undefined;
    if (input.provenance.signature !== undefined) {
      const keyId = assertNonBlank(input.provenance.signature.keyId, "integration signature key ID", 512);
      const signatureHash = assertSha256(input.provenance.signature.signatureHash, "integration signature hash");
      signature = Object.freeze({
        algorithm: input.provenance.signature.algorithm,
        keyId,
        signatureHash,
      });
    }
    provenance = Object.freeze({
      ...(publisher === undefined ? {} : { publisher }),
      ...(sourceUri === undefined ? {} : { sourceUri }),
      ...(signature === undefined ? {} : { signature }),
    });
  }

  return Object.freeze({
    ...input,
    id: input.id,
    integrationId: input.integrationId,
    canonicalName,
    displayName: assertNonBlank(input.displayName, "integration display name", 160),
    version,
    ...(provenance === undefined ? {} : { provenance }),
    ...(input.endpoint === undefined ? {} : { endpoint: assertNonBlank(input.endpoint, "integration endpoint", 4_096) }),
    manifestHash,
    contentHash,
    implementationHash,
    schemaHash,
    dependencyHash,
    effectSetHash,
    destinationSetHash,
    requiredCapabilities,
    effects,
    destinations,
    dataClasses,
    supportedEnvironments,
    dependencies: Object.freeze(dependencies),
    limits: Object.freeze({ ...input.limits }),
  });
}

function freezeTrust(trust: IntegrationTrust): IntegrationTrust {
  assertDomain(INTEGRATION_TRUST_VALUES.has(trust.state), "invalid_argument", "Unknown integration trust state.");
  return Object.freeze({
    ...trust,
    digest: Object.freeze({ ...trust.digest }),
  });
}

function freezeRegistration(registration: IntegrationRegistration): IntegrationRegistration {
  return Object.freeze({
    ...registration,
    manifest: normalizeManifest(registration.manifest),
    trust: freezeTrust(registration.trust),
  });
}

function assertRegistry(registry: IntegrationRegistry): void {
  assertDomain(registry.version === 1, "invalid_argument", "Unsupported integration registry version.");
  assertDomain(Array.isArray(registry.integrations), "invalid_argument", "Integration registry entries must be an array.");
}

function findRegistration(registry: IntegrationRegistry, integrationVersionId: IntegrationVersionId): IntegrationRegistration {
  const registration = registry.integrations.find((entry) => entry.manifest.id === integrationVersionId);
  assertDomain(registration !== undefined, "not_found", "Integration version was not found.", {
    integrationVersionId,
  });
  return registration;
}

function replaceRegistration(
  registry: IntegrationRegistry,
  replacement: IntegrationRegistration,
): IntegrationRegistry {
  const index = registry.integrations.findIndex((entry) => entry.manifest.id === replacement.manifest.id);
  assertDomain(index >= 0, "not_found", "Integration version was not found for replacement.", {
    integrationVersionId: replacement.manifest.id,
  });
  const entries = [...registry.integrations];
  entries[index] = freezeRegistration(replacement);
  return Object.freeze({ ...registry, integrations: Object.freeze(entries) });
}

/** Creates an empty immutable registry. */
export function createIntegrationRegistry(): IntegrationRegistry {
  return Object.freeze({ version: 1, integrations: Object.freeze([]) });
}

/**
 * Registers metadata as discovered only.  Repository/remote metadata can
 * propose an integration, but registration never installs, trusts, enables,
 * or grants it.
 */
export function registerIntegrationVersion(
  registry: IntegrationRegistry,
  input: IntegrationVersionManifest,
): IntegrationRegistry {
  assertRegistry(registry);
  const manifest = normalizeManifest(input);
  assertDomain(
    !registry.integrations.some((entry) => entry.manifest.id === manifest.id),
    "conflict",
    "Integration version ID is already registered.",
    { integrationVersionId: manifest.id },
  );
  assertDomain(
    !registry.integrations.some(
      (entry) =>
        entry.manifest.canonicalName === manifest.canonicalName &&
        entry.manifest.version === manifest.version,
    ),
    "conflict",
    "The exact integration name and version are already registered.",
    { canonicalName: manifest.canonicalName, version: manifest.version },
  );
  const trust: IntegrationTrust = {
    state: "untrusted",
    digest: digestForManifest(manifest),
  };
  const registration = freezeRegistration({
    manifest,
    lifecycle: "discovered",
    trust,
    discoveredAt: manifest.registeredAt,
  });
  return Object.freeze({
    ...registry,
    integrations: Object.freeze([...registry.integrations, registration]),
  });
}

/** Returns metadata without treating it as executable or trusted. */
export function getIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
): IntegrationRegistration {
  assertRegistry(registry);
  return findRegistration(registry, integrationVersionId);
}

/** Installs a discovered version; install is deliberately not trust or enablement. */
export function installIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  at: IsoTimestamp,
): IntegrationRegistry {
  return transitionIntegrationLifecycle(registry, integrationVersionId, "installed", at);
}

/**
 * Records an explicit trust decision bound to every security-relevant digest.
 * A trusted entry still cannot execute until it is separately enabled.
 */
export function trustIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  input: IntegrationTrustInput | IsoTimestamp,
): IntegrationRegistry {
  assertRegistry(registry);
  const registration = findRegistration(registry, integrationVersionId);
  const trustInput: IntegrationTrustInput = typeof input === "string"
    ? { reviewedAt: input }
    : input;
  assertIsoTimestamp(trustInput.reviewedAt, "integration trust review time");
  assertDomain(
    registration.lifecycle !== "discovered" && registration.lifecycle !== "blocked",
    "invalid_state_transition",
    "An integration must be installed before it can be trusted.",
    { integrationVersionId },
  );
  assertDomain(
    Date.parse(trustInput.reviewedAt) >= Date.parse(registration.manifest.registeredAt),
    "invalid_argument",
    "Integration trust review time cannot precede registration.",
  );
  const trust: IntegrationTrust = {
    state: "trusted",
    digest: digestForManifest(registration.manifest),
    reviewedAt: trustInput.reviewedAt,
    ...(trustInput.reviewedBy === undefined ? {} : { reviewedBy: trustInput.reviewedBy }),
    ...(trustInput.reason === undefined ? {} : { reason: assertNonBlank(trustInput.reason, "integration trust reason", 1_000) }),
  };
  return replaceRegistration(registry, { ...registration, trust: freezeTrust(trust) });
}

/** Invalidates a trust decision when a package or declaration changes. */
export function invalidateIntegrationTrust(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  at: IsoTimestamp,
  reason?: string,
): IntegrationRegistry {
  assertRegistry(registry);
  assertIsoTimestamp(at, "integration trust invalidation time");
  const registration = findRegistration(registry, integrationVersionId);
  const trust: IntegrationTrust = {
    state: "stale",
    digest: digestForManifest(registration.manifest),
    ...(reason === undefined ? {} : { reason: assertNonBlank(reason, "integration trust invalidation reason", 1_000) }),
  };
  return replaceRegistration(registry, {
    ...registration,
    lifecycle: registration.lifecycle === "enabled" ? "disabled" : registration.lifecycle,
    trust: freezeTrust(trust),
    ...(registration.lifecycle === "enabled" ? { disabledAt: at } : {}),
  });
}

/** Revokes trust and stops an enabled integration. */
export function revokeIntegrationTrust(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  at: IsoTimestamp,
  reason?: string,
): IntegrationRegistry {
  assertRegistry(registry);
  assertIsoTimestamp(at, "integration trust revocation time");
  const registration = findRegistration(registry, integrationVersionId);
  const trust: IntegrationTrust = {
    state: "revoked",
    digest: digestForManifest(registration.manifest),
    ...(reason === undefined ? {} : { reason: assertNonBlank(reason, "integration trust revocation reason", 1_000) }),
  };
  return replaceRegistration(registry, {
    ...registration,
    lifecycle: registration.lifecycle === "enabled" ? "disabled" : registration.lifecycle,
    trust: freezeTrust(trust),
    ...(registration.lifecycle === "enabled" ? { disabledAt: at } : {}),
  });
}

/**
 * Performs one explicit lifecycle transition.  The overload accepts either a
 * compact `(target, at, reason)` form or a durable transition object.
 */
export function transitionIntegrationLifecycle(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  transition: IntegrationLifecycleTransition,
): IntegrationRegistry;
export function transitionIntegrationLifecycle(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  transition: IntegrationLifecycle,
  at: IsoTimestamp,
  reason?: string,
): IntegrationRegistry;
export function transitionIntegrationLifecycle(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  transitionOrTarget: IntegrationLifecycleTransition | IntegrationLifecycle,
  at?: IsoTimestamp,
  reason?: string,
): IntegrationRegistry {
  assertRegistry(registry);
  const registration = findRegistration(registry, integrationVersionId);
  const transition: IntegrationLifecycleTransition = typeof transitionOrTarget === "string"
    ? { to: transitionOrTarget, at: at as IsoTimestamp, ...(reason === undefined ? {} : { reason }) }
    : transitionOrTarget;
  assertDomain(INTEGRATION_LIFECYCLE_VALUES.has(transition.to), "invalid_argument", "Unknown integration lifecycle state.");
  assertIsoTimestamp(transition.at, "integration lifecycle transition time");
  const allowed = INTEGRATION_LIFECYCLE_TRANSITIONS[registration.lifecycle];
  assertDomain(
    allowed.includes(transition.to),
    "invalid_state_transition",
    `Cannot transition integration from ${registration.lifecycle} to ${transition.to}.`,
    { integrationVersionId, from: registration.lifecycle, to: transition.to },
  );
  if (transition.to === "enabled") {
    assertDomain(
      registration.trust.state === "trusted" && isIntegrationTrustCurrent(registry, integrationVersionId),
      "permission_denied",
      "An integration must have current explicit trust before it can be enabled.",
      { integrationVersionId },
    );
  }
  if (transition.to === "blocked") {
    assertDomain(
      transition.reason !== undefined && transition.reason.trim().length > 0,
      "invalid_argument",
      "Blocking an integration requires a reason.",
    );
  }
  const { blockedReason: currentBlockedReason, ...registrationWithoutBlockedReason } = registration;
  const next: IntegrationRegistration = {
    ...registrationWithoutBlockedReason,
    ...(transition.to !== "discovered" && currentBlockedReason === undefined ? {} :
      transition.to !== "discovered" && currentBlockedReason !== undefined ? { blockedReason: currentBlockedReason } : {}),
    lifecycle: transition.to,
    ...(transition.to === "installed" ? { installedAt: transition.at } : {}),
    ...(transition.to === "enabled" ? { enabledAt: transition.at } : {}),
    ...(transition.to === "disabled" ? { disabledAt: transition.at } : {}),
    ...(transition.to === "blocked"
      ? { blockedAt: transition.at, blockedReason: assertNonBlank(transition.reason ?? "", "integration block reason", 1_000) }
      : {}),
    ...(transition.to === "discovered"
      ? {
          trust: {
            state: "untrusted" as const,
            digest: digestForManifest(registration.manifest),
          },
        }
      : {}),
  };
  // exactOptionalPropertyTypes disallows an explicit undefined optional field;
  // omit the reset field when moving away from a blocked state instead.
  if (transition.to === "discovered") {
    const { blockedReason: _blockedReason, ...withoutBlockedReason } = next;
    return replaceRegistration(registry, withoutBlockedReason);
  }
  return replaceRegistration(registry, next);
}

export function enableIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  at: IsoTimestamp,
): IntegrationRegistry {
  return transitionIntegrationLifecycle(registry, integrationVersionId, "enabled", at);
}

export function disableIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  at: IsoTimestamp,
): IntegrationRegistry {
  return transitionIntegrationLifecycle(registry, integrationVersionId, "disabled", at);
}

export function blockIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  at: IsoTimestamp,
  reason: string,
): IntegrationRegistry {
  return transitionIntegrationLifecycle(registry, integrationVersionId, "blocked", at, reason);
}

/** Returns true only for a digest-current, explicitly trusted version. */
export function isIntegrationTrustCurrent(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
): boolean {
  assertRegistry(registry);
  const registration = findRegistration(registry, integrationVersionId);
  return registration.trust.state === "trusted" && sameDigest(registration.trust.digest, digestForManifest(registration.manifest));
}

/** Resolves only an enabled and currently trusted integration. */
export function resolveIntegrationVersion(
  registry: IntegrationRegistry,
  integrationVersionId: IntegrationVersionId,
  now?: IsoTimestamp,
): IntegrationRegistration {
  assertRegistry(registry);
  if (now !== undefined) {
    assertIsoTimestamp(now, "integration resolution time");
  }
  const registration = findRegistration(registry, integrationVersionId);
  assertDomain(
    registration.lifecycle === "enabled",
    "unsupported_capability",
    "Integration is not enabled.",
    { integrationVersionId },
  );
  assertDomain(
    isIntegrationTrustCurrent(registry, integrationVersionId),
    "permission_denied",
    "Integration trust is missing or stale.",
    { integrationVersionId },
  );
  return registration;
}

/** Replaces one exact version and resets lifecycle/trust to discovered/untrusted. */
export function replaceIntegrationVersion(
  registry: IntegrationRegistry,
  input: IntegrationVersionManifest,
): IntegrationRegistry {
  assertRegistry(registry);
  const manifest = normalizeManifest(input);
  const existing = findRegistration(registry, manifest.id);
  assertDomain(
    existing.manifest.integrationId === manifest.integrationId,
    "conflict",
    "An integration version ID cannot be moved to another integration.",
  );
  assertDomain(
    !registry.integrations.some(
      (entry) =>
        entry.manifest.id !== manifest.id &&
        entry.manifest.canonicalName === manifest.canonicalName &&
        entry.manifest.version === manifest.version,
    ),
    "conflict",
    "The exact integration name and version are already registered.",
  );
  const registration = freezeRegistration({
    manifest,
    lifecycle: "discovered",
    trust: { state: "untrusted", digest: digestForManifest(manifest) },
    discoveredAt: manifest.registeredAt,
  });
  return replaceRegistration(registry, registration);
}

/** Alias emphasizing that an update invalidates all prior trust. */
export const updateIntegrationVersion = replaceIntegrationVersion;
