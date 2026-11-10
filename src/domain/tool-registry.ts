import { assertDomain } from "./errors";
import type { KernelCapability } from "./kernel-capability";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import {
  assertPositiveSafeInteger,
  EXECUTION_MODE_VALUES,
  KERNEL_CAPABILITY_VALUES,
  type ToolVersionId,
  uniqueValues,
} from "./agent-tool-contract-shared";

export type ToolTrust =
  "built-in" | "signed-extension" | "local-unverified" | "remote";
export type ToolExposure = "eager" | "deferred" | "harness-only";
export type ToolEffect =
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

export interface ToolResourceLimits {
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly defaultTimeoutMs: number;
}

/**
 * Immutable identity and authority declaration for one exact tool version.
 * Tool descriptions, aliases, skills, models, and agents never add authority;
 * the required capability list is only a request to the kernel broker.
 */
export interface ToolVersionManifest {
  readonly schemaVersion: 1;
  readonly id: ToolVersionId;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly version: string;
  readonly origin: ToolTrust;
  readonly exposure: ToolExposure;
  readonly manifestHash: string;
  readonly implementationHash: string;
  readonly inputSchemaHash: string;
  readonly outputSchemaHash: string;
  readonly capabilitySetHash: string;
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly effects: readonly ToolEffect[];
  readonly supportedEnvironments: readonly (
    "persistent" | "isolated" | "remote"
  )[];
  readonly limits: ToolResourceLimits;
  readonly cancellation: "cooperative" | "forceable" | "unsupported";
  readonly idempotency: "none" | "same-invocation-key";
  readonly registeredAt: IsoTimestamp;
  readonly disabledAt?: IsoTimestamp;
}

export interface ToolRegistry {
  readonly version: 1;
  readonly tools: readonly ToolVersionManifest[];
}

const TOOL_EFFECT_CAPABILITY = {
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
} as const satisfies Readonly<Record<ToolEffect, KernelCapability>>;

const RESERVED_TOOL_NAMESPACES = new Set(["kernel", "omnia", "system"]);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const TOOL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const TOOL_TRUST_VALUES: ReadonlySet<ToolTrust> = new Set([
  "built-in",
  "signed-extension",
  "local-unverified",
  "remote",
]);
const TOOL_EXPOSURE_VALUES: ReadonlySet<ToolExposure> = new Set([
  "eager",
  "deferred",
  "harness-only",
]);
const TOOL_EFFECT_VALUES: ReadonlySet<ToolEffect> = new Set(
  Object.keys(TOOL_EFFECT_CAPABILITY) as ToolEffect[],
);
function normalizeToolName(value: string): string {
  const canonicalName = assertNonBlank(
    value,
    "tool canonical name",
    160,
  ).toLowerCase();
  assertDomain(
    TOOL_NAME_PATTERN.test(canonicalName),
    "invalid_argument",
    "Tool names must be lowercase and namespace-qualified.",
    { canonicalName },
  );
  return canonicalName;
}

function validateToolManifest(input: ToolVersionManifest): ToolVersionManifest {
  assertDomain(
    input.schemaVersion === 1,
    "invalid_argument",
    "Unsupported tool manifest version.",
  );
  assertDomain(
    TOOL_TRUST_VALUES.has(input.origin),
    "invalid_argument",
    "Unknown tool trust class.",
  );
  assertDomain(
    TOOL_EXPOSURE_VALUES.has(input.exposure),
    "invalid_argument",
    "Unknown tool exposure policy.",
  );
  assertDomain(
    input.cancellation === "cooperative" ||
      input.cancellation === "forceable" ||
      input.cancellation === "unsupported",
    "invalid_argument",
    "Unknown tool cancellation contract.",
  );
  assertDomain(
    input.idempotency === "none" || input.idempotency === "same-invocation-key",
    "invalid_argument",
    "Unknown tool idempotency contract.",
  );
  const canonicalName = normalizeToolName(input.canonicalName);
  const namespace = canonicalName.split(".")[0] ?? "";
  assertDomain(
    input.origin === "built-in" || !RESERVED_TOOL_NAMESPACES.has(namespace),
    "permission_denied",
    "Extensions cannot register tools inside a reserved namespace.",
    { namespace },
  );
  const version = assertNonBlank(input.version, "tool version", 64);
  assertDomain(
    TOOL_VERSION_PATTERN.test(version),
    "invalid_argument",
    "Tool version is malformed.",
  );
  assertIsoTimestamp(input.registeredAt, "tool registration time");
  if (input.disabledAt !== undefined) {
    assertIsoTimestamp(input.disabledAt, "tool disable time");
    assertDomain(
      Date.parse(input.disabledAt) >= Date.parse(input.registeredAt),
      "invalid_argument",
      "Tool disable time cannot precede registration.",
    );
  }

  const requiredCapabilities = uniqueValues(
    input.requiredCapabilities,
    "Tool capabilities",
  );
  assertDomain(
    requiredCapabilities.every((capability) =>
      KERNEL_CAPABILITY_VALUES.has(capability),
    ),
    "invalid_argument",
    "Tool manifest contains an unknown kernel capability.",
  );
  const capabilitySet = new Set(requiredCapabilities);
  const effects = uniqueValues(input.effects, "Tool effects");
  assertDomain(
    effects.length > 0,
    "invalid_argument",
    "A tool must declare at least one effect.",
  );
  assertDomain(
    effects.every((effect) => TOOL_EFFECT_VALUES.has(effect)),
    "invalid_argument",
    "Tool manifest contains an unknown effect.",
  );
  for (const effect of effects) {
    const requiredCapability = TOOL_EFFECT_CAPABILITY[effect];
    assertDomain(
      capabilitySet.has(requiredCapability),
      "scope_violation",
      "Every declared tool effect must have its matching kernel capability.",
      { effect, requiredCapability },
    );
  }
  const expectedCapabilities = new Set(
    effects.map((effect) => TOOL_EFFECT_CAPABILITY[effect]),
  );
  assertDomain(
    expectedCapabilities.size === capabilitySet.size &&
      requiredCapabilities.every((capability) =>
        expectedCapabilities.has(capability),
      ),
    "scope_violation",
    "Tool effects and requested kernel capabilities must describe the same authority set.",
  );

  const supportedEnvironments = uniqueValues(
    input.supportedEnvironments,
    "Supported tool environments",
  );
  assertDomain(
    supportedEnvironments.length > 0,
    "invalid_argument",
    "A callable tool must support at least one execution environment.",
  );
  assertDomain(
    supportedEnvironments.every((mode) => EXECUTION_MODE_VALUES.has(mode)),
    "invalid_argument",
    "Tool manifest contains an unknown execution mode.",
  );
  assertPositiveSafeInteger(
    input.limits.maximumInputBytes,
    "Tool input byte limit",
  );
  assertPositiveSafeInteger(
    input.limits.maximumOutputBytes,
    "Tool output byte limit",
  );
  assertPositiveSafeInteger(input.limits.defaultTimeoutMs, "Tool timeout");
  const manifestHash = assertSha256(input.manifestHash, "tool manifest hash");
  const implementationHash = assertSha256(
    input.implementationHash,
    "tool implementation hash",
  );
  const inputSchemaHash = assertSha256(
    input.inputSchemaHash,
    "tool input schema hash",
  );
  const outputSchemaHash = assertSha256(
    input.outputSchemaHash,
    "tool output schema hash",
  );
  const capabilitySetHash = assertSha256(
    input.capabilitySetHash,
    "tool capability-set hash",
  );
  return Object.freeze({
    ...input,
    canonicalName,
    displayName: assertNonBlank(input.displayName, "tool display name", 160),
    version,
    manifestHash,
    implementationHash,
    inputSchemaHash,
    outputSchemaHash,
    capabilitySetHash,
    requiredCapabilities,
    effects,
    supportedEnvironments,
    limits: Object.freeze({ ...input.limits }),
  });
}

export function createToolRegistry(): ToolRegistry {
  return Object.freeze({ version: 1, tools: Object.freeze([]) });
}

export function registerToolVersion(
  registry: ToolRegistry,
  input: ToolVersionManifest,
): ToolRegistry {
  assertDomain(
    registry.version === 1,
    "invalid_argument",
    "Unsupported tool registry version.",
  );
  const manifest = validateToolManifest(input);
  assertDomain(
    !registry.tools.some((tool) => tool.id === manifest.id),
    "conflict",
    "Tool version ID is already registered.",
    { toolVersionId: manifest.id },
  );
  assertDomain(
    !registry.tools.some(
      (tool) =>
        tool.canonicalName === manifest.canonicalName &&
        tool.version === manifest.version,
    ),
    "conflict",
    "The exact tool name and version are already registered.",
    { canonicalName: manifest.canonicalName, version: manifest.version },
  );
  return Object.freeze({
    ...registry,
    tools: Object.freeze([...registry.tools, manifest]),
  });
}

export function resolveToolVersion(
  registry: ToolRegistry,
  toolVersionId: ToolVersionId,
  caller: "model" | "harness",
  now: IsoTimestamp,
): ToolVersionManifest {
  assertIsoTimestamp(now, "tool resolution time");
  const tool = registry.tools.find(
    (candidate) => candidate.id === toolVersionId,
  );
  assertDomain(tool !== undefined, "not_found", "Tool version was not found.", {
    toolVersionId,
  });
  assertDomain(
    tool.disabledAt === undefined ||
      Date.parse(tool.disabledAt) > Date.parse(now),
    "unsupported_capability",
    "Tool version is disabled.",
    { toolVersionId },
  );
  assertDomain(
    caller === "harness" || tool.exposure !== "harness-only",
    "permission_denied",
    "This tool is not exposed to model-authored calls.",
    { toolVersionId },
  );
  return tool;
}
