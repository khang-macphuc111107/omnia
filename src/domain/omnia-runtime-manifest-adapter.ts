import { assertDomain } from "./errors";
import type {
  ConcreteExecutionMode,
  EnvironmentMount,
  EnvironmentNetworkPolicy,
  EnvironmentPersistencePolicy,
  EnvironmentResourceBudget,
  ExecutionEnvironment,
} from "./execution";
import type { EntityId } from "./ids";
import type { KernelCapability } from "./kernel-capability";
import type {
  MachineInstance,
  MachineProviderKind,
  MachineSecurityBoundary,
  PersistentMachineResumeManifest,
} from "./machine-runtime";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/**
 * Declarative runtime-provider metadata.  This is intentionally a manifest,
 * not an executable adapter: it cannot grant authority, start a process, or
 * widen a network/mount policy.  Native code remains responsible for proving
 * that the declared translation was actually applied.
 */

export const RUNTIME_ADAPTER_MANIFEST_SCHEMA_VERSION = 1 as const;

export type RuntimeAdapterManifestId = EntityId<"runtime-adapter-manifest">;
export type RuntimeAdapterManifestStatus = "experimental" | "verified" | "revoked";
export type RuntimeAdapterArchitecture = "x64" | "arm64";
export type RuntimeAdapterEvidenceKind =
  | "signed-package"
  | "conformance-suite"
  | "platform-probe"
  | "policy-translation";

export interface RuntimeAdapterPlatformDescriptor {
  readonly os: "windows";
  readonly architectures: readonly RuntimeAdapterArchitecture[];
  readonly translationVersion: string;
  readonly translationHash: string;
}

export interface RuntimeAdapterResourceLimits {
  readonly maximumWallClockMs?: number;
  readonly maximumCpuTimeMs?: number;
  readonly maximumMemoryBytes?: number;
  readonly maximumStorageBytes?: number;
  readonly maximumNetworkBytes?: number;
  readonly maximumProcessCount?: number;
}

/**
 * The adapter's translation envelope for one concrete execution mode.  These
 * values describe what the provider can translate and verify; they do not
 * enable any capability in an environment by themselves.
 */
export interface RuntimeAdapterModeSupport {
  readonly mode: ConcreteExecutionMode;
  readonly capabilities: readonly KernelCapability[];
  readonly mountSources: readonly EnvironmentMount["source"][];
  readonly networkModes: readonly EnvironmentNetworkPolicy["mode"][];
  readonly persistenceKinds: readonly EnvironmentPersistencePolicy["kind"][];
  readonly resourceLimits: RuntimeAdapterResourceLimits;
}

export interface RuntimeAdapterEvidence {
  readonly kind: RuntimeAdapterEvidenceKind;
  readonly reference: string;
  readonly contentHash: string;
  readonly observedAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export interface RuntimeAdapterManifest {
  readonly schemaVersion: typeof RUNTIME_ADAPTER_MANIFEST_SCHEMA_VERSION;
  readonly id: RuntimeAdapterManifestId;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly version: string;
  readonly status: RuntimeAdapterManifestStatus;
  readonly providerKind: MachineProviderKind;
  readonly securityBoundary: MachineSecurityBoundary;
  readonly platform: RuntimeAdapterPlatformDescriptor;
  readonly supportedModes: readonly ConcreteExecutionMode[];
  readonly modeSupport: readonly RuntimeAdapterModeSupport[];
  /** Hash of the adapter implementation/translation used by machine attestation. */
  readonly runtimeAdapterHash: string;
  /** Hash of this exact normalized declarative manifest. */
  readonly manifestHash: string;
  readonly conformanceSuiteVersion: string;
  readonly conformanceSuiteHash: string;
  readonly evidence: readonly RuntimeAdapterEvidence[];
  readonly registeredAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
}

export type RuntimeAdapterManifestInput = RuntimeAdapterManifest;

export type RuntimeAdapterCompatibilityReason =
  | "adapter-revoked"
  | "mode-unsupported"
  | "provider-kind-mismatch"
  | "runtime-adapter-hash-mismatch"
  | "platform-translation-expired"
  | "capability-unsupported"
  | "mount-source-unsupported"
  | "network-mode-unsupported"
  | "persistence-kind-unsupported"
  | "resource-budget-exceeded"
  | "machine-drifted"
  | "machine-attestation-expired"
  | "resume-runtime-drift";

export interface RuntimeAdapterCompatibility {
  readonly compatible: boolean;
  readonly adapterManifestId: RuntimeAdapterManifestId;
  readonly runtimeAdapterHash: string;
  readonly reasonCodes: readonly RuntimeAdapterCompatibilityReason[];
}

export interface EvaluateRuntimeAdapterCompatibilityInput {
  readonly manifest: RuntimeAdapterManifest;
  readonly environment?: ExecutionEnvironment;
  readonly machine?: MachineInstance;
  readonly resumeManifest?: PersistentMachineResumeManifest;
  readonly now?: IsoTimestamp;
}

const MACHINE_PROVIDER_BOUNDARIES: Readonly<Record<MachineProviderKind, MachineSecurityBoundary>> = {
  "windows-sandbox": "windows-sandbox",
  "hyper-v-vm": "hypervisor-vm",
  "hyper-v-isolated-container": "hyper-v-isolated-container",
  "managed-remote-vm": "managed-remote-vm",
};

const MACHINE_PROVIDER_MODES: Readonly<Record<MachineProviderKind, readonly ConcreteExecutionMode[]>> = {
  "windows-sandbox": ["isolated"],
  "hyper-v-vm": ["persistent", "isolated"],
  "hyper-v-isolated-container": ["isolated"],
  "managed-remote-vm": ["remote"],
};

const ADAPTER_STATUS_VALUES: ReadonlySet<RuntimeAdapterManifestStatus> = new Set([
  "experimental",
  "verified",
  "revoked",
]);
const ARCHITECTURE_VALUES: ReadonlySet<RuntimeAdapterArchitecture> = new Set(["x64", "arm64"]);
const EVIDENCE_KIND_VALUES: ReadonlySet<RuntimeAdapterEvidenceKind> = new Set([
  "signed-package",
  "conformance-suite",
  "platform-probe",
  "policy-translation",
]);
const MODE_VALUES: ReadonlySet<ConcreteExecutionMode> = new Set([
  "persistent",
  "isolated",
  "remote",
]);
const MOUNT_SOURCE_VALUES: ReadonlySet<EnvironmentMount["source"]> = new Set([
  "workspace-grant",
  "app-data",
  "temporary",
  "network-drive-grant",
]);
const NETWORK_MODE_VALUES: ReadonlySet<EnvironmentNetworkPolicy["mode"]> = new Set([
  "offline",
  "allowlist",
  "brokered",
]);
const PERSISTENCE_KIND_VALUES: ReadonlySet<EnvironmentPersistencePolicy["kind"]> = new Set([
  "ephemeral",
  "resume",
  "snapshot",
]);
const CAPABILITY_VALUES: ReadonlySet<KernelCapability> = new Set([
  "pure_compute",
  "read_app_data",
  "read_workspace",
  "write_workspace",
  "execute_process",
  "use_network",
  "external_side_effect",
  "control_browser",
  "control_computer",
  "request_admin",
  "access_secret_handle",
]);

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "id",
  "canonicalName",
  "displayName",
  "version",
  "status",
  "providerKind",
  "securityBoundary",
  "platform",
  "supportedModes",
  "modeSupport",
  "runtimeAdapterHash",
  "manifestHash",
  "conformanceSuiteVersion",
  "conformanceSuiteHash",
  "evidence",
  "registeredAt",
  "updatedAt",
]);

const PLATFORM_FIELDS = new Set(["os", "architectures", "translationVersion", "translationHash"]);
const MODE_SUPPORT_FIELDS = new Set([
  "mode",
  "capabilities",
  "mountSources",
  "networkModes",
  "persistenceKinds",
  "resourceLimits",
]);
const RESOURCE_LIMIT_FIELDS = new Set([
  "maximumWallClockMs",
  "maximumCpuTimeMs",
  "maximumMemoryBytes",
  "maximumStorageBytes",
  "maximumNetworkBytes",
  "maximumProcessCount",
]);
const EVIDENCE_FIELDS = new Set(["kind", "reference", "contentHash", "observedAt", "expiresAt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assertDomain(isRecord(value), "invalid_argument", `${label} must be an object.`, { label });
}

function assertNoUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    assertDomain(allowed.has(key), "invalid_argument", `${label} contains an unknown field.`, { label, key });
  }
}

function assertString(value: unknown, label: string, maxLength = 512): string {
  assertDomain(typeof value === "string", "invalid_argument", `${label} must be a string.`, { label });
  return assertNonBlank(value, label, maxLength);
}

function assertEnum<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  assertDomain(typeof value === "string" && values.has(value as T), "invalid_argument", `${label} is invalid.`, { label });
  return value as T;
}

function uniqueSorted<T extends string>(values: readonly T[], label: string): readonly T[] {
  const normalized = [...values];
  assertDomain(new Set(normalized).size === normalized.length, "invalid_argument", `${label} must be unique.`, { label });
  normalized.sort((left, right) => left.localeCompare(right));
  return Object.freeze(normalized);
}

function assertPositiveOrZero(value: unknown, label: string): number {
  assertDomain(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "invalid_argument", `${label} must be a non-negative safe integer.`, { label });
  return value;
}

function normalizeResourceLimits(input: RuntimeAdapterResourceLimits): RuntimeAdapterResourceLimits {
  const normalized: Record<string, number> = {};
  const entries: readonly (readonly [keyof RuntimeAdapterResourceLimits, string])[] = [
    ["maximumWallClockMs", "maximum wall-clock budget"],
    ["maximumCpuTimeMs", "maximum CPU-time budget"],
    ["maximumMemoryBytes", "maximum memory budget"],
    ["maximumStorageBytes", "maximum storage budget"],
    ["maximumNetworkBytes", "maximum network budget"],
    ["maximumProcessCount", "maximum process-count budget"],
  ];
  for (const [key, label] of entries) {
    const value = input[key];
    if (value !== undefined) normalized[key] = assertPositiveOrZero(value, label);
  }
  return Object.freeze(normalized) as RuntimeAdapterResourceLimits;
}

function normalizeModeSupport(input: RuntimeAdapterModeSupport): RuntimeAdapterModeSupport {
  const mode = assertEnum(input.mode, MODE_VALUES, "runtime adapter mode");
  const capabilities = uniqueSorted(
    input.capabilities.map((value) => assertEnum(value, CAPABILITY_VALUES, "runtime adapter capability")),
    "runtime adapter capabilities",
  );
  const mountSources = uniqueSorted(
    input.mountSources.map((value) => assertEnum(value, MOUNT_SOURCE_VALUES, "runtime adapter mount source")),
    "runtime adapter mount sources",
  );
  const networkModes = uniqueSorted(
    input.networkModes.map((value) => assertEnum(value, NETWORK_MODE_VALUES, "runtime adapter network mode")),
    "runtime adapter network modes",
  );
  const persistenceKinds = uniqueSorted(
    input.persistenceKinds.map((value) => assertEnum(value, PERSISTENCE_KIND_VALUES, "runtime adapter persistence kind")),
    "runtime adapter persistence kinds",
  );
  assertDomain(
    networkModes.includes("offline") || capabilities.includes("use_network"),
    "scope_violation",
    "A runtime adapter that translates networked environments must declare use_network support.",
    { mode },
  );
  return Object.freeze({
    mode,
    capabilities,
    mountSources,
    networkModes,
    persistenceKinds,
    resourceLimits: normalizeResourceLimits(input.resourceLimits),
  });
}

function normalizeEvidence(input: RuntimeAdapterEvidence): RuntimeAdapterEvidence {
  const kind = assertEnum(input.kind, EVIDENCE_KIND_VALUES, "runtime adapter evidence kind");
  const observedAt = assertString(input.observedAt, "runtime adapter evidence time", 64);
  assertIsoTimestamp(observedAt, "runtime adapter evidence time");
  const expiresAt = input.expiresAt === undefined ? undefined : assertString(input.expiresAt, "runtime adapter evidence expiry", 64);
  if (expiresAt !== undefined) {
    assertIsoTimestamp(expiresAt, "runtime adapter evidence expiry");
    assertDomain(Date.parse(expiresAt) > Date.parse(observedAt), "invalid_argument", "Runtime adapter evidence expiry must be after observation.");
  }
  return Object.freeze({
    kind,
    reference: assertString(input.reference, "runtime adapter evidence reference", 2_048),
    contentHash: assertSha256(input.contentHash, "runtime adapter evidence content hash"),
    observedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

function normalizeManifest(input: RuntimeAdapterManifestInput): RuntimeAdapterManifest {
  assertDomain(input.schemaVersion === RUNTIME_ADAPTER_MANIFEST_SCHEMA_VERSION, "invalid_argument", "Unsupported runtime adapter manifest version.");
  const id = assertString(input.id, "runtime adapter manifest ID", 128) as RuntimeAdapterManifestId;
  const providerKind = assertEnum(input.providerKind, new Set<MachineProviderKind>([
    "windows-sandbox",
    "hyper-v-vm",
    "hyper-v-isolated-container",
    "managed-remote-vm",
  ]), "runtime adapter provider kind");
  const securityBoundary = assertEnum(input.securityBoundary, new Set<MachineSecurityBoundary>([
    "windows-sandbox",
    "hypervisor-vm",
    "hyper-v-isolated-container",
    "managed-remote-vm",
  ]), "runtime adapter security boundary");
  assertDomain(securityBoundary === MACHINE_PROVIDER_BOUNDARIES[providerKind], "scope_violation", "Runtime adapter provider and security boundary do not match.");
  const supportedModes = uniqueSorted(
    input.supportedModes.map((value) => assertEnum(value, MODE_VALUES, "runtime adapter supported mode")),
    "runtime adapter supported modes",
  );
  const providerModes = MACHINE_PROVIDER_MODES[providerKind];
  assertDomain(supportedModes.every((mode) => providerModes.includes(mode)), "unsupported_capability", "Runtime adapter declares a mode that its provider kind cannot implement.", { providerKind });
  const modeSupport = input.modeSupport.map(normalizeModeSupport);
  assertDomain(new Set(modeSupport.map((entry) => entry.mode)).size === modeSupport.length, "invalid_argument", "Runtime adapter mode support entries must be unique.");
  assertDomain(modeSupport.length === supportedModes.length && modeSupport.every((entry) => supportedModes.includes(entry.mode)), "invalid_argument", "Runtime adapter mode support must exactly match supported modes.");
  const sortedModeSupport = Object.freeze([...modeSupport].sort((left, right) => left.mode.localeCompare(right.mode)));

  assertDomain(input.platform.os === "windows", "unsupported_capability", "Only Windows runtime adapters are supported by this contract.");
  const architectures = uniqueSorted(
    input.platform.architectures.map((value) => assertEnum(value, ARCHITECTURE_VALUES, "runtime adapter architecture")),
    "runtime adapter architectures",
  );
  assertDomain(architectures.length > 0, "invalid_argument", "Runtime adapter must declare at least one architecture.");
  const translationVersion = assertString(input.platform.translationVersion, "runtime adapter translation version", 128);
  const translationHash = assertSha256(input.platform.translationHash, "runtime adapter translation hash");
  const status = assertEnum(input.status, ADAPTER_STATUS_VALUES, "runtime adapter manifest status");
  const registeredAt = assertString(input.registeredAt, "runtime adapter registration time", 64);
  assertIsoTimestamp(registeredAt, "runtime adapter registration time");
  const updatedAt = input.updatedAt === undefined ? undefined : assertString(input.updatedAt, "runtime adapter update time", 64);
  if (updatedAt !== undefined) {
    assertIsoTimestamp(updatedAt, "runtime adapter update time");
    assertDomain(Date.parse(updatedAt) >= Date.parse(registeredAt), "invalid_argument", "Runtime adapter update time cannot precede registration time.");
  }
  const evidence = input.evidence.map(normalizeEvidence);
  assertDomain(evidence.length > 0, "invalid_argument", "Runtime adapter must carry evidence.");
  assertDomain(evidence.some((entry) => entry.kind === "conformance-suite"), "invalid_argument", "Runtime adapter evidence must include a conformance-suite receipt.");
  assertDomain(evidence.some((entry) => entry.kind === "platform-probe"), "invalid_argument", "Runtime adapter evidence must include a platform-probe receipt.");
  const now = Date.now();
  if (status === "verified") {
    assertDomain(evidence.every((entry) => entry.expiresAt === undefined || Date.parse(entry.expiresAt) > now), "invalid_state_transition", "A verified runtime adapter cannot carry expired evidence.");
  }
  return Object.freeze({
    schemaVersion: RUNTIME_ADAPTER_MANIFEST_SCHEMA_VERSION,
    id,
    canonicalName: assertString(input.canonicalName, "runtime adapter canonical name", 128),
    displayName: assertString(input.displayName, "runtime adapter display name", 256),
    version: assertString(input.version, "runtime adapter version", 128),
    status,
    providerKind,
    securityBoundary,
    platform: Object.freeze({ os: "windows", architectures, translationVersion, translationHash }),
    supportedModes,
    modeSupport: sortedModeSupport,
    runtimeAdapterHash: assertSha256(input.runtimeAdapterHash, "runtime adapter implementation hash"),
    manifestHash: assertSha256(input.manifestHash, "runtime adapter manifest hash"),
    conformanceSuiteVersion: assertString(input.conformanceSuiteVersion, "runtime adapter conformance-suite version", 128),
    conformanceSuiteHash: assertSha256(input.conformanceSuiteHash, "runtime adapter conformance-suite hash"),
    evidence: Object.freeze([...evidence].sort((left, right) => `${left.kind}:${left.reference}`.localeCompare(`${right.kind}:${right.reference}`))),
    registeredAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });
}

/** Creates and normalizes an immutable declarative runtime adapter manifest. */
export function createRuntimeAdapterManifest(input: RuntimeAdapterManifestInput): RuntimeAdapterManifest {
  return normalizeManifest(input);
}

function compareBudget(
  requested: EnvironmentResourceBudget,
  limits: RuntimeAdapterResourceLimits,
): boolean {
  return (
    (limits.maximumWallClockMs === undefined || requested.wallClockMs <= limits.maximumWallClockMs) &&
    (limits.maximumCpuTimeMs === undefined || requested.cpuTimeMs <= limits.maximumCpuTimeMs) &&
    (limits.maximumMemoryBytes === undefined || requested.memoryBytes <= limits.maximumMemoryBytes) &&
    (limits.maximumStorageBytes === undefined || requested.storageBytes <= limits.maximumStorageBytes) &&
    (limits.maximumNetworkBytes === undefined || requested.networkBytes <= limits.maximumNetworkBytes) &&
    (limits.maximumProcessCount === undefined || requested.processCount <= limits.maximumProcessCount)
  );
}

/**
 * Evaluates all supplied boundaries without mutating them.  Any mismatch is a
 * hard incompatibility; callers must not use this report to widen authority.
 */
export function evaluateRuntimeAdapterCompatibility(
  input: EvaluateRuntimeAdapterCompatibilityInput,
): RuntimeAdapterCompatibility {
  const manifest = normalizeManifest(input.manifest);
  const reasonCodes: RuntimeAdapterCompatibilityReason[] = [];
  if (manifest.status === "revoked") reasonCodes.push("adapter-revoked");
  const now = input.now === undefined ? undefined : assertString(input.now, "runtime adapter compatibility time", 64);
  if (now !== undefined) assertIsoTimestamp(now, "runtime adapter compatibility time");
  const modeSupport = input.environment === undefined
    ? undefined
    : manifest.modeSupport.find((entry) => entry.mode === input.environment?.mode);

  if (input.environment !== undefined) {
    const environment = input.environment;
    if (!manifest.supportedModes.includes(environment.mode)) reasonCodes.push("mode-unsupported");
    if (modeSupport === undefined) {
      reasonCodes.push("mode-unsupported");
    } else {
      if (environment.enabledCapabilities.some((capability) => !modeSupport.capabilities.includes(capability))) reasonCodes.push("capability-unsupported");
      if (environment.mounts.some((mount) => !modeSupport.mountSources.includes(mount.source))) reasonCodes.push("mount-source-unsupported");
      if (!modeSupport.networkModes.includes(environment.networkPolicy.mode)) reasonCodes.push("network-mode-unsupported");
      if (!modeSupport.persistenceKinds.includes(environment.persistencePolicy.kind)) reasonCodes.push("persistence-kind-unsupported");
      if (!compareBudget(environment.resourceBudget, modeSupport.resourceLimits)) reasonCodes.push("resource-budget-exceeded");
    }
  }

  if (input.machine !== undefined) {
    const machine = input.machine;
    if (machine.providerKind !== manifest.providerKind) reasonCodes.push("provider-kind-mismatch");
    if (!manifest.supportedModes.includes(machine.mode)) reasonCodes.push("mode-unsupported");
    if (machine.runtimeAdapterHash !== manifest.runtimeAdapterHash) reasonCodes.push("runtime-adapter-hash-mismatch");
    if (machine.driftStatus !== "clean") reasonCodes.push("machine-drifted");
    if (now !== undefined && Date.parse(now) >= Date.parse(machine.attestationExpiresAt)) reasonCodes.push("machine-attestation-expired");
  }

  if (input.resumeManifest !== undefined && input.resumeManifest.runtimeAdapterHash !== manifest.runtimeAdapterHash) {
    reasonCodes.push("resume-runtime-drift");
  }

  const uniqueReasons = Object.freeze([...new Set(reasonCodes)]);
  return Object.freeze({
    compatible: uniqueReasons.length === 0,
    adapterManifestId: manifest.id,
    runtimeAdapterHash: manifest.runtimeAdapterHash,
    reasonCodes: uniqueReasons,
  });
}

export function assertRuntimeAdapterCompatible(input: EvaluateRuntimeAdapterCompatibilityInput): void {
  const result = evaluateRuntimeAdapterCompatibility(input);
  assertDomain(result.compatible, "unsupported_capability", "Runtime adapter manifest is incompatible with the requested runtime boundary.", {
    adapterManifestId: result.adapterManifestId,
    reasonCodes: result.reasonCodes,
  });
}

function parseRuntimeAdapterManifestPayload(input: string | unknown): RuntimeAdapterManifestInput {
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) as unknown : input;
  } catch {
    throw new Error("Invalid runtime adapter manifest JSON.");
  }
  assertRecord(value, "runtime adapter manifest payload");
  assertNoUnknownFields(value, TOP_LEVEL_FIELDS, "runtime adapter manifest");
  assertRecord(value.platform, "runtime adapter platform");
  assertNoUnknownFields(value.platform, PLATFORM_FIELDS, "runtime adapter platform");
  assertRecord(value.platform, "runtime adapter platform");
  assertDomain(Array.isArray(value.supportedModes), "invalid_argument", "Runtime adapter supported modes must be an array.");
  assertDomain(Array.isArray(value.modeSupport), "invalid_argument", "Runtime adapter mode support must be an array.");
  assertDomain(Array.isArray(value.evidence), "invalid_argument", "Runtime adapter evidence must be an array.");
  for (const entry of value.modeSupport) {
    assertRecord(entry, "runtime adapter mode support");
    assertNoUnknownFields(entry, MODE_SUPPORT_FIELDS, "runtime adapter mode support");
    assertRecord(entry.resourceLimits, "runtime adapter resource limits");
    assertNoUnknownFields(entry.resourceLimits, RESOURCE_LIMIT_FIELDS, "runtime adapter resource limits");
  }
  for (const entry of value.evidence) {
    assertRecord(entry, "runtime adapter evidence");
    assertNoUnknownFields(entry, EVIDENCE_FIELDS, "runtime adapter evidence");
  }
  return value as unknown as RuntimeAdapterManifestInput;
}

export function deserializeRuntimeAdapterManifest(input: string | unknown): RuntimeAdapterManifest {
  return normalizeManifest(parseRuntimeAdapterManifestPayload(input));
}

export function serializeRuntimeAdapterManifest(manifest: RuntimeAdapterManifest): string {
  return JSON.stringify(normalizeManifest(manifest), null, 2);
}

