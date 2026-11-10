import { assertDomain } from "./errors";
import {
  planRuntimeController,
  type PlanRuntimeControllerInput,
  type RuntimeControllerPlan,
  type RuntimeMachinePlanningInput,
} from "./omnia-runtime-controller";
import {
  resolveIntegrationVersion,
  type IntegrationRegistration,
  type IntegrationRegistry,
} from "./integration-registry";
import type {
  ConcreteExecutionMode,
  ExecutionRequirements,
  ExecutionSelectionPolicy,
  RequestedExecutionMode,
} from "./execution";
import type { IntegrationVersionId } from "./ids";
import type { KernelCapability } from "./kernel-capability";
import { assertIsoTimestamp, type IsoTimestamp } from "./shared";

/** Version of the renderer/native-safe integration planning projection. */
export const INTEGRATION_RUNTIME_ADAPTER_SCHEMA_VERSION = 1 as const;

export interface IntegrationRuntimeRequirements extends ExecutionRequirements {
  readonly integrationVersionId: IntegrationVersionId;
  readonly requiredCapabilities: readonly KernelCapability[];
  readonly supportedEnvironments: readonly ConcreteExecutionMode[];
}

export interface IntegrationRuntimePlan {
  readonly version: typeof INTEGRATION_RUNTIME_ADAPTER_SCHEMA_VERSION;
  readonly integrationVersionId: IntegrationVersionId;
  readonly manifestHash: string;
  readonly implementationHash: string;
  readonly registration: IntegrationRegistration;
  readonly requirements: IntegrationRuntimeRequirements;
  readonly controllerPlan: RuntimeControllerPlan;
}

export interface PlanIntegrationRuntimeInput {
  readonly registry: IntegrationRegistry;
  readonly integrationVersionId: IntegrationVersionId;
  readonly policy: ExecutionSelectionPolicy;
  readonly now: IsoTimestamp;
  readonly requestedMode?: RequestedExecutionMode;
  readonly machine?: RuntimeMachinePlanningInput;
}

const HOST_CAPABILITIES: ReadonlySet<KernelCapability> = new Set([
  "read_app_data",
  "read_workspace",
  "write_workspace",
  "execute_process",
  "control_browser",
  "control_computer",
  "request_admin",
  "access_secret_handle",
]);

export function deriveIntegrationExecutionRequirements(
  registration: IntegrationRegistration,
  requestedMode?: RequestedExecutionMode,
): IntegrationRuntimeRequirements {
  const manifest = registration.manifest;
  const requiredCapabilities = Object.freeze([...manifest.requiredCapabilities]);
  const requiresExecution = manifest.kind !== "skill";
  const requiresHostIntegration = requiredCapabilities.some((capability) => HOST_CAPABILITIES.has(capability));
  const requiresPrivilegedHostAccess = requiredCapabilities.includes("request_admin");
  const requiresRemoteEnvironment = manifest.supportedEnvironments.length === 1 && manifest.supportedEnvironments[0] === "remote";
  const remoteDestination = requiresRemoteEnvironment ? manifest.destinations[0] : undefined;

  return Object.freeze({
    // Skills are non-executable by contract.  A caller cannot turn one into
    // an environment-bearing workload by supplying an explicit mode.
    requestedMode: manifest.kind === "skill" ? "auto" : (requestedMode ?? "auto"),
    requiresExecution,
    inputTrust: manifest.origin === "built-in" ? "trusted" : "untrusted",
    runsUnknownCode: requiresExecution && manifest.origin !== "built-in",
    requiresDurableState: false,
    requiresHostIntegration,
    requiresPrivilegedHostAccess,
    requiresRemoteEnvironment,
    ...(remoteDestination === undefined ? {} : { remoteDestination }),
    durationClass: "interactive" as const,
    integrationVersionId: manifest.id,
    requiredCapabilities,
    supportedEnvironments: Object.freeze([...manifest.supportedEnvironments]),
  });
}

function assertSupportedMode(
  requirements: IntegrationRuntimeRequirements,
  selection: RuntimeControllerPlan["selection"],
): void {
  if (selection.selectedMode === "none") return;
  assertDomain(
    requirements.supportedEnvironments.includes(selection.selectedMode),
    "unsupported_capability",
    "The integration does not declare support for the selected execution environment.",
    {
      integrationVersionId: requirements.integrationVersionId,
      selectedMode: selection.selectedMode,
      supportedEnvironments: requirements.supportedEnvironments,
    },
  );
}

/**
 * Converts one resolved integration manifest into a deterministic runtime
 * controller plan. Resolution is deliberately the first operation: an
 * installed, stale, blocked, or untrusted integration never reaches runtime
 * planning.
 */
export function planIntegrationRuntime(input: PlanIntegrationRuntimeInput): IntegrationRuntimePlan {
  assertIsoTimestamp(input.now, "integration runtime planning time");
  const registration = resolveIntegrationVersion(input.registry, input.integrationVersionId, input.now);
  const requirements = deriveIntegrationExecutionRequirements(registration, input.requestedMode);

  const controllerInput: PlanRuntimeControllerInput = {
    requirements,
    policy: input.policy,
    now: input.now,
    ...(input.machine === undefined ? {} : { machine: input.machine }),
  };
  const controllerPlan = planRuntimeController(controllerInput);
  assertSupportedMode(requirements, controllerPlan.selection);
  return Object.freeze({
    version: INTEGRATION_RUNTIME_ADAPTER_SCHEMA_VERSION,
    integrationVersionId: registration.manifest.id,
    manifestHash: registration.manifest.manifestHash,
    implementationHash: registration.manifest.implementationHash,
    registration,
    requirements,
    controllerPlan,
  });
}

/** Small object adapter for callers that prefer dependency injection. */
export interface IntegrationRuntimeAdapter {
  readonly version: typeof INTEGRATION_RUNTIME_ADAPTER_SCHEMA_VERSION;
  readonly plan: (input: PlanIntegrationRuntimeInput) => IntegrationRuntimePlan;
}

export function createIntegrationRuntimeAdapter(): IntegrationRuntimeAdapter {
  return Object.freeze({
    version: INTEGRATION_RUNTIME_ADAPTER_SCHEMA_VERSION,
    plan: planIntegrationRuntime,
  });
}
