import { assertDomain } from "./errors";
import type { ExecutionEnvironmentId } from "./ids";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";
import type { KernelCapability } from "./kernel-capability";
import { assertOpaqueResourceHandle } from "./resource-handle";

export { assertOpaqueResourceHandle } from "./resource-handle";

export type RequestedExecutionMode = "auto" | "persistent" | "isolated" | "remote";
export type ConcreteExecutionMode = Exclude<RequestedExecutionMode, "auto">;
export type ExecutionEnvironmentLifecycle =
  | "preparing"
  | "ready"
  | "suspended"
  | "snapshotting"
  | "stopped"
  | "failed";

export type ExecutionTrustBoundary =
  | "trusted-local-host"
  | "isolated-sandbox"
  | "managed-remote";

export interface ExecutionModeAvailability {
  readonly persistent: boolean;
  readonly isolated: boolean;
  readonly remote: boolean;
}

export interface ExecutionSelectionPolicy {
  readonly availability: ExecutionModeAvailability;
  /** Auto never falls back to remote merely because local modes are unavailable. */
  readonly defaultLocalMode: Exclude<ConcreteExecutionMode, "remote">;
  readonly allowedRemoteDestinations: readonly string[];
  readonly policyVersionHash: string;
}

export interface ExecutionRequirements {
  readonly requestedMode?: RequestedExecutionMode;
  /**
   * False for model-only chat/research. Auto keeps such a run environment-free
   * until an approved tool plan actually requires an execution boundary.
   */
  readonly requiresExecution: boolean;
  readonly inputTrust: "trusted" | "mixed" | "untrusted";
  readonly runsUnknownCode: boolean;
  readonly requiresDurableState: boolean;
  readonly requiresHostIntegration: boolean;
  readonly requiresPrivilegedHostAccess: boolean;
  readonly requiresRemoteEnvironment: boolean;
  readonly remoteDestination?: string;
  readonly durationClass: "interactive" | "long-running" | "always-on";
}

export type ExecutionSelectionReason =
  | "no-execution-required"
  | "explicit-mode"
  | "privileged-host-operation"
  | "host-integration"
  | "remote-resource-required"
  | "untrusted-input"
  | "unknown-code"
  | "durable-state"
  | "long-running-workload"
  | "policy-default"
  | "preferred-mode-unavailable";

export interface ExecutionModeConsideration {
  readonly mode: ConcreteExecutionMode;
  readonly eligible: boolean;
  readonly reason?: string;
}

export interface NoExecutionModeSelection {
  readonly requestedMode: "auto";
  readonly selectedMode: "none";
  readonly reasonCodes: readonly ["no-execution-required"];
  readonly considerations: readonly ExecutionModeConsideration[];
  readonly policyVersionHash: string;
}

export interface ConcreteExecutionModeSelection {
  readonly requestedMode: RequestedExecutionMode;
  readonly selectedMode: ConcreteExecutionMode;
  readonly reasonCodes: readonly ExecutionSelectionReason[];
  readonly considerations: readonly ExecutionModeConsideration[];
  readonly policyVersionHash: string;
}

export type ExecutionModeSelection =
  | NoExecutionModeSelection
  | ConcreteExecutionModeSelection;

export interface EnvironmentMount {
  /** Opaque native handle. Renderer-originated raw filesystem paths are forbidden. */
  readonly handle: string;
  readonly displayName: string;
  readonly source: "workspace-grant" | "app-data" | "temporary" | "network-drive-grant";
  readonly permissions: {
    readonly read: boolean;
    readonly write: boolean;
    readonly execute: boolean;
  };
}

export interface EnvironmentNetworkPolicy {
  readonly mode: "offline" | "allowlist" | "brokered";
  readonly allowedDestinations: readonly string[];
  readonly proxyProfileRef?: string;
  readonly dnsProfileRef?: string;
  readonly allowInbound: boolean;
}

export interface EnvironmentResourceBudget {
  readonly wallClockMs: number;
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly storageBytes: number;
  readonly networkBytes: number;
  readonly processCount: number;
}

export interface EnvironmentPersistencePolicy {
  readonly kind: "ephemeral" | "resume" | "snapshot";
  readonly snapshotOnSuspend: boolean;
  readonly maximumSnapshotCount: number;
}

export interface ExecutionEnvironment {
  readonly id: ExecutionEnvironmentId;
  readonly requestedMode: RequestedExecutionMode;
  readonly mode: ConcreteExecutionMode;
  readonly lifecycle: ExecutionEnvironmentLifecycle;
  readonly trustBoundary: ExecutionTrustBoundary;
  readonly enabledCapabilities: readonly KernelCapability[];
  readonly mounts: readonly EnvironmentMount[];
  readonly networkPolicy: EnvironmentNetworkPolicy;
  readonly resourceBudget: EnvironmentResourceBudget;
  readonly persistencePolicy: EnvironmentPersistencePolicy;
  readonly selectionReasonCodes: readonly ExecutionSelectionReason[];
  readonly policyVersionHash: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly failure?: {
    readonly code: string;
    readonly diagnosticId?: string;
  };
}

const ENVIRONMENT_TRANSITIONS = {
  preparing: ["ready", "stopped", "failed"],
  ready: ["suspended", "snapshotting", "stopped", "failed"],
  suspended: ["ready", "snapshotting", "stopped", "failed"],
  snapshotting: ["ready", "suspended", "stopped", "failed"],
  stopped: [],
  failed: [],
} as const satisfies Readonly<
  Record<ExecutionEnvironmentLifecycle, readonly ExecutionEnvironmentLifecycle[]>
>;

function normalizeDestination(value: string): string {
  const normalized = assertNonBlank(value, "remote destination", 2_048).toLowerCase();
  assertDomain(
    normalized !== "*" && !normalized.includes("\n") && !normalized.includes("\r"),
    "invalid_argument",
    "Remote destinations must be explicit and may not use a global wildcard.",
  );
  return normalized.replace(/\/$/, "");
}

function isModeAvailable(mode: ConcreteExecutionMode, availability: ExecutionModeAvailability): boolean {
  return availability[mode];
}

function assertRemoteAllowed(
  requirements: ExecutionRequirements,
  policy: ExecutionSelectionPolicy,
): void {
  assertDomain(
    requirements.remoteDestination !== undefined,
    "invalid_argument",
    "Remote execution requires an explicit destination.",
  );
  const destination = normalizeDestination(requirements.remoteDestination);
  const allowed = policy.allowedRemoteDestinations.map(normalizeDestination);
  assertDomain(
    allowed.includes(destination),
    "permission_denied",
    "Remote execution destination is not permitted by the active privacy policy.",
    { destination },
  );
}

function validateExplicitMode(
  mode: ConcreteExecutionMode,
  requirements: ExecutionRequirements,
  policy: ExecutionSelectionPolicy,
): void {
  assertDomain(
    isModeAvailable(mode, policy.availability),
    "unsupported_capability",
    `The requested ${mode} execution environment is unavailable.`,
    { mode },
  );
  if (mode === "isolated") {
    assertDomain(
      !requirements.requiresHostIntegration && !requirements.requiresPrivilegedHostAccess,
      "scope_violation",
      "An isolated environment cannot satisfy trusted host integration or privileged host access.",
    );
  }
  if (mode === "persistent") {
    assertDomain(
      !requirements.runsUnknownCode && requirements.inputTrust === "trusted",
      "scope_violation",
      "Unknown, mixed-trust, or untrusted input requires an isolated execution boundary.",
    );
  }
  if (mode === "remote") {
    assertDomain(
      !requirements.requiresHostIntegration && !requirements.requiresPrivilegedHostAccess,
      "scope_violation",
      "A remote environment cannot receive trusted local-host capabilities.",
    );
    assertRemoteAllowed(requirements, policy);
  }
  if (requirements.requiresRemoteEnvironment) {
    assertDomain(
      mode === "remote",
      "scope_violation",
      "This workload requires a specifically authorized remote environment.",
    );
  }
}

function requirementsNeedExecution(requirements: ExecutionRequirements): boolean {
  return (
    requirements.requiresExecution ||
    requirements.runsUnknownCode ||
    requirements.requiresDurableState ||
    requirements.requiresHostIntegration ||
    requirements.requiresPrivilegedHostAccess ||
    requirements.requiresRemoteEnvironment ||
    requirements.durationClass !== "interactive"
  );
}

/**
 * Resolves Auto deterministically. Remote execution is selected only when the
 * workload explicitly requires it and the destination is policy-allowed.
 */
export function resolveExecutionMode(
  requirements: ExecutionRequirements,
  policy: ExecutionSelectionPolicy,
): ExecutionModeSelection {
  assertSha256(policy.policyVersionHash, "execution policy version hash");
  assertDomain(
    policy.defaultLocalMode === "persistent" || policy.defaultLocalMode === "isolated",
    "invalid_argument",
    "The Auto default must remain inside a local trust boundary.",
  );
  assertDomain(
    !(requirements.runsUnknownCode && requirements.requiresPrivilegedHostAccess),
    "scope_violation",
    "Unknown code and privileged host access must be split into separately approved stages.",
  );

  const requestedMode = requirements.requestedMode ?? "auto";
  const considerations: ExecutionModeConsideration[] = (
    ["persistent", "isolated", "remote"] as const
  ).map((mode) => ({
    mode,
    eligible: isModeAvailable(mode, policy.availability),
    ...(isModeAvailable(mode, policy.availability)
      ? {}
      : { reason: "Environment provider is unavailable." }),
  }));

  if (!requirementsNeedExecution(requirements)) {
    assertDomain(
      requestedMode === "auto",
      "invalid_argument",
      "A tool-free run cannot request an explicit execution environment.",
      { requestedMode },
    );
    return Object.freeze({
      requestedMode: "auto",
      selectedMode: "none",
      reasonCodes: Object.freeze(["no-execution-required"] as const),
      considerations: Object.freeze(considerations.map((entry) => Object.freeze(entry))),
      policyVersionHash: policy.policyVersionHash,
    });
  }

  if (requestedMode !== "auto") {
    validateExplicitMode(requestedMode, requirements, policy);
    return Object.freeze({
      requestedMode,
      selectedMode: requestedMode,
      reasonCodes: Object.freeze(["explicit-mode"] as const),
      considerations: Object.freeze(considerations.map((entry) => Object.freeze(entry))),
      policyVersionHash: policy.policyVersionHash,
    });
  }

  let selectedMode: ConcreteExecutionMode;
  const reasonCodes: ExecutionSelectionReason[] = [];
  if (requirements.requiresPrivilegedHostAccess) {
    selectedMode = "persistent";
    reasonCodes.push("privileged-host-operation");
  } else if (requirements.requiresHostIntegration) {
    selectedMode = "persistent";
    reasonCodes.push("host-integration");
  } else if (requirements.requiresRemoteEnvironment) {
    assertRemoteAllowed(requirements, policy);
    selectedMode = "remote";
    reasonCodes.push("remote-resource-required");
  } else if (requirements.runsUnknownCode || requirements.inputTrust !== "trusted") {
    selectedMode = "isolated";
    reasonCodes.push(requirements.runsUnknownCode ? "unknown-code" : "untrusted-input");
  } else if (
    requirements.requiresDurableState ||
    requirements.durationClass === "always-on" ||
    requirements.durationClass === "long-running"
  ) {
    selectedMode = "persistent";
    if (requirements.requiresDurableState) reasonCodes.push("durable-state");
    if (requirements.durationClass !== "interactive") reasonCodes.push("long-running-workload");
  } else {
    selectedMode = policy.defaultLocalMode;
    reasonCodes.push("policy-default");
  }

  if (!isModeAvailable(selectedMode, policy.availability)) {
    const localFallback: Exclude<ConcreteExecutionMode, "remote"> =
      selectedMode === "persistent" ? "isolated" : "persistent";
    const fallbackIsSafe =
      reasonCodes.length === 1 &&
      reasonCodes[0] === "policy-default" &&
      isModeAvailable(localFallback, policy.availability) &&
      !(localFallback === "isolated" &&
        (requirements.requiresHostIntegration || requirements.requiresPrivilegedHostAccess)) &&
      !requirements.requiresRemoteEnvironment;
    assertDomain(
      fallbackIsSafe,
      "unsupported_capability",
      `No eligible execution environment can satisfy the ${selectedMode} workload requirements.`,
      { preferredMode: selectedMode },
    );
    selectedMode = localFallback;
    reasonCodes.push("preferred-mode-unavailable");
  }

  validateExplicitMode(selectedMode, requirements, policy);
  return Object.freeze({
    requestedMode,
    selectedMode,
    reasonCodes: Object.freeze(reasonCodes),
    considerations: Object.freeze(considerations.map((entry) => Object.freeze(entry))),
    policyVersionHash: policy.policyVersionHash,
  });
}

function assertBudgetValue(value: number, label: string, allowZero = false): void {
  assertDomain(
    Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0),
    "invalid_argument",
    `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer.`,
    { label, value },
  );
}

function expectedTrustBoundary(mode: ConcreteExecutionMode): ExecutionTrustBoundary {
  if (mode === "persistent") return "trusted-local-host";
  if (mode === "isolated") return "isolated-sandbox";
  return "managed-remote";
}

const HOST_ONLY_CAPABILITIES: ReadonlySet<KernelCapability> = new Set([
  "read_app_data",
  "control_computer",
  "request_admin",
  "access_secret_handle",
]);

function assertMountCapabilities(
  mount: EnvironmentMount,
  capabilities: ReadonlySet<KernelCapability>,
): void {
  const requiresReadWorkspace =
    mount.permissions.read &&
    (mount.source === "workspace-grant" || mount.source === "network-drive-grant");
  const requiresReadAppData = mount.permissions.read && mount.source === "app-data";
  const requiresWriteWorkspace =
    mount.permissions.write &&
    (mount.source === "workspace-grant" ||
      mount.source === "network-drive-grant" ||
      mount.source === "temporary");
  const requiresExecute = mount.permissions.execute;
  assertDomain(
    !requiresReadWorkspace || capabilities.has("read_workspace"),
    "scope_violation",
    "A readable workspace or network-drive mount requires read_workspace capability.",
    { handle: mount.handle },
  );
  assertDomain(
    !requiresReadAppData || capabilities.has("read_app_data"),
    "scope_violation",
    "An app-data mount requires read_app_data capability.",
    { handle: mount.handle },
  );
  assertDomain(
    !requiresWriteWorkspace || capabilities.has("write_workspace"),
    "scope_violation",
    "A writable workspace mount requires write_workspace capability.",
    { handle: mount.handle },
  );
  assertDomain(
    !requiresExecute || capabilities.has("execute_process"),
    "scope_violation",
    "An executable mount requires execute_process capability.",
    { handle: mount.handle },
  );
  assertDomain(
    !(mount.source === "app-data" && mount.permissions.write),
    "unsupported_capability",
    "App-data mounts are read-only in the execution contract.",
    { handle: mount.handle },
  );
}

export interface CreateExecutionEnvironmentInput {
  readonly id: ExecutionEnvironmentId;
  readonly selection: ExecutionModeSelection;
  readonly trustBoundary: ExecutionTrustBoundary;
  readonly enabledCapabilities: readonly KernelCapability[];
  readonly mounts: readonly EnvironmentMount[];
  readonly networkPolicy: EnvironmentNetworkPolicy;
  readonly resourceBudget: EnvironmentResourceBudget;
  readonly persistencePolicy: EnvironmentPersistencePolicy;
  readonly now: IsoTimestamp;
}

export function createExecutionEnvironment(
  input: CreateExecutionEnvironmentInput,
): ExecutionEnvironment {
  assertIsoTimestamp(input.now, "environment creation time");
  assertSha256(input.selection.policyVersionHash, "execution policy version hash");
  assertDomain(
    input.selection.selectedMode !== "none",
    "invalid_state_transition",
    "No execution environment may be created for an environment-free run.",
  );
  assertDomain(
    input.trustBoundary === expectedTrustBoundary(input.selection.selectedMode),
    "scope_violation",
    "Execution mode and trust boundary do not match.",
    { mode: input.selection.selectedMode, trustBoundary: input.trustBoundary },
  );
  const capabilitySet = new Set(input.enabledCapabilities);
  assertDomain(
    capabilitySet.size === input.enabledCapabilities.length,
    "invalid_argument",
    "Enabled environment capabilities must be unique.",
  );
  if (input.selection.selectedMode !== "persistent") {
    const invalidCapabilities = input.enabledCapabilities.filter((capability) =>
      HOST_ONLY_CAPABILITIES.has(capability),
    );
    assertDomain(
      invalidCapabilities.length === 0,
      "scope_violation",
      "Isolated and remote environments cannot receive trusted host-only capabilities.",
      { mode: input.selection.selectedMode, invalidCapabilities },
    );
  }

  const mountHandles = new Set<string>();
  const mounts = input.mounts.map((mount) => {
    const handle = assertOpaqueResourceHandle(mount.handle, "mount handle");
    assertDomain(!mountHandles.has(handle), "conflict", "Mount handle is already present.", {
      handle,
    });
    mountHandles.add(handle);
    assertDomain(
      mount.permissions.read || mount.permissions.write || mount.permissions.execute,
      "invalid_argument",
      "A mount must expose at least one permission.",
      { handle },
    );
    assertMountCapabilities(mount, capabilitySet);
    if (
      input.selection.selectedMode !== "persistent" &&
      (mount.source === "app-data" || mount.source === "network-drive-grant")
    ) {
      assertDomain(
        false,
        "scope_violation",
        "App-data and network-drive mounts require a trusted persistent host boundary.",
        { mode: input.selection.selectedMode, source: mount.source },
      );
    }
    return Object.freeze({
      ...mount,
      handle,
      displayName: assertNonBlank(mount.displayName, "mount display name", 260),
      permissions: Object.freeze({ ...mount.permissions }),
    });
  });

  const allowedDestinations = input.networkPolicy.allowedDestinations.map(normalizeDestination);
  assertDomain(
    new Set(allowedDestinations).size === allowedDestinations.length,
    "invalid_argument",
    "Network destinations must be unique.",
  );
  if (input.networkPolicy.mode === "offline") {
    assertDomain(
      allowedDestinations.length === 0 && !input.networkPolicy.allowInbound,
      "invalid_argument",
      "An offline environment cannot expose network destinations or inbound access.",
    );
  }
  if (input.networkPolicy.mode === "allowlist") {
    assertDomain(
      allowedDestinations.length > 0,
      "invalid_argument",
      "An allowlist network policy must include at least one destination.",
    );
  }
  assertDomain(
    input.networkPolicy.allowInbound === false,
    "unsupported_capability",
    "Inbound listeners are not enabled by the current kernel capability set.",
  );
  assertDomain(
    input.networkPolicy.mode === "offline" || capabilitySet.has("use_network"),
    "scope_violation",
    "A network-enabled environment requires use_network capability.",
  );
  if (input.networkPolicy.proxyProfileRef !== undefined) {
    assertOpaqueResourceHandle(input.networkPolicy.proxyProfileRef, "proxy profile reference");
  }
  if (input.networkPolicy.dnsProfileRef !== undefined) {
    assertOpaqueResourceHandle(input.networkPolicy.dnsProfileRef, "DNS profile reference");
  }

  assertBudgetValue(input.resourceBudget.wallClockMs, "wall-clock budget");
  assertBudgetValue(input.resourceBudget.cpuTimeMs, "CPU-time budget");
  assertBudgetValue(input.resourceBudget.memoryBytes, "memory budget");
  assertBudgetValue(input.resourceBudget.storageBytes, "storage budget");
  assertBudgetValue(input.resourceBudget.networkBytes, "network budget", true);
  assertBudgetValue(input.resourceBudget.processCount, "process-count budget");
  assertBudgetValue(
    input.persistencePolicy.maximumSnapshotCount,
    "maximum snapshot count",
    true,
  );
  assertDomain(
    input.selection.selectedMode !== "persistent" || input.persistencePolicy.kind === "resume",
    "invalid_argument",
    "Persistent environments must use resumable persistence.",
  );
  assertDomain(
    input.persistencePolicy.kind !== "ephemeral" ||
      (!input.persistencePolicy.snapshotOnSuspend &&
        input.persistencePolicy.maximumSnapshotCount === 0),
    "invalid_argument",
    "Ephemeral environments cannot retain snapshots.",
  );

  return Object.freeze({
    id: input.id,
    requestedMode: input.selection.requestedMode,
    mode: input.selection.selectedMode,
    lifecycle: "preparing",
    trustBoundary: input.trustBoundary,
    enabledCapabilities: Object.freeze([...input.enabledCapabilities]),
    mounts: Object.freeze(mounts),
    networkPolicy: Object.freeze({
      ...input.networkPolicy,
      allowedDestinations: Object.freeze(allowedDestinations),
    }),
    resourceBudget: Object.freeze({ ...input.resourceBudget }),
    persistencePolicy: Object.freeze({ ...input.persistencePolicy }),
    selectionReasonCodes: Object.freeze([...input.selection.reasonCodes]),
    policyVersionHash: input.selection.policyVersionHash,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function canTransitionExecutionEnvironment(
  from: ExecutionEnvironmentLifecycle,
  to: ExecutionEnvironmentLifecycle,
): boolean {
  return (ENVIRONMENT_TRANSITIONS[from] as readonly ExecutionEnvironmentLifecycle[]).includes(to);
}

export interface TransitionExecutionEnvironmentInput {
  readonly to: ExecutionEnvironmentLifecycle;
  readonly now: IsoTimestamp;
  readonly failure?: ExecutionEnvironment["failure"];
}

export function transitionExecutionEnvironment(
  environment: ExecutionEnvironment,
  input: TransitionExecutionEnvironmentInput,
): ExecutionEnvironment {
  assertIsoTimestamp(input.now, "environment transition time");
  assertDomain(
    canTransitionExecutionEnvironment(environment.lifecycle, input.to),
    "invalid_state_transition",
    `Environment cannot transition from ${environment.lifecycle} to ${input.to}.`,
    { environmentId: environment.id, from: environment.lifecycle, to: input.to },
  );
  assertDomain(
    Date.parse(input.now) >= Date.parse(environment.updatedAt),
    "invalid_argument",
    "Environment transition time cannot move backwards.",
  );
  if (input.to === "failed") {
    assertDomain(input.failure !== undefined, "invalid_argument", "A failed environment needs a typed failure.");
  } else {
    assertDomain(
      input.failure === undefined,
      "invalid_argument",
      "Failure metadata is only valid for a failed environment.",
    );
  }
  return Object.freeze({
    ...environment,
    lifecycle: input.to,
    updatedAt: input.now,
    ...(input.failure === undefined
      ? {}
      : {
          failure: Object.freeze({
            code: assertNonBlank(input.failure.code, "environment failure code", 160),
            ...(input.failure.diagnosticId === undefined
              ? {}
              : {
                  diagnosticId: assertNonBlank(
                    input.failure.diagnosticId,
                    "environment diagnostic ID",
                    256,
                  ),
                }),
          }),
        }),
  });
}

export function environmentAllowsDestination(
  environment: ExecutionEnvironment,
  destination: string,
): boolean {
  if (environment.lifecycle !== "ready") return false;
  if (environment.networkPolicy.mode === "offline") return false;
  return environment.networkPolicy.allowedDestinations.includes(normalizeDestination(destination));
}
