import { assertDomain } from "./errors";
import {
  createExecutionEnvironment,
  resolveExecutionMode,
  transitionExecutionEnvironment,
  type CreateExecutionEnvironmentInput,
  type ExecutionEnvironment,
  type ExecutionRequirements,
  type ExecutionSelectionPolicy,
  type ExecutionModeSelection,
  type EnvironmentMount,
  type EnvironmentNetworkPolicy,
  type EnvironmentPersistencePolicy,
  type EnvironmentResourceBudget,
} from "./execution";
import type { EntityId, ExecutionEnvironmentId, RunId } from "./ids";
import { parseEntityId } from "./ids";
import {
  acquireMachineLease,
  assertMachineLeaseUsable,
  closeMachineLease,
  planMachineAcquisition,
  rotateMachineGeneration,
  transitionMachine,
  renewMachineLease,
  type AcquireMachineLeaseInput,
  type MachineAcquisitionPlan,
  type MachineAttestation,
  type MachineInstance,
  type MachineLease,
  type MachineLifecycle,
} from "./machine-runtime";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

/** Stable identity for one pure runtime orchestration record. */
export type RuntimeControllerId = EntityId<"runtime-controller">;

/**
 * Controller lifecycle is deliberately narrower than either the environment or
 * machine lifecycle. It describes what the orchestration boundary can safely
 * offer to its caller, not what a native provider may be doing internally.
 */
export type RuntimeControllerLifecycle =
  | "planned"
  | "preparing"
  | "ready"
  | "leased"
  | "suspended"
  | "stopping"
  | "stopped"
  | "failed"
  | "blocked";

export interface RuntimeMachineEnvelope {
  readonly ownerScopeHash: string;
  readonly templateHash: string;
  readonly baseImageHash: string;
  readonly runtimeAdapterHash: string;
  readonly effectivePolicyHash: string;
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
}

/**
 * The machine planning inputs are kept separately from the execution mode
 * resolver. This prevents a model-only run from accidentally acquiring a
 * machine merely because a caller supplied a candidate list.
 */
export interface RuntimeMachinePlanningInput extends RuntimeMachineEnvelope {
  readonly candidates: readonly MachineInstance[];
}

export interface RuntimeControllerPlan {
  readonly version: 1;
  readonly selection: ExecutionModeSelection;
  readonly acquisition: MachineAcquisitionPlan;
  readonly machineEnvelope?: RuntimeMachineEnvelope;
}

export interface PlanRuntimeControllerInput {
  readonly requirements: ExecutionRequirements;
  readonly policy: ExecutionSelectionPolicy;
  readonly machine?: RuntimeMachinePlanningInput;
  readonly now: IsoTimestamp;
}

export interface RuntimeControllerFailure {
  readonly code: string;
  readonly diagnosticId?: string;
}

export interface RuntimeController {
  readonly version: 1;
  readonly id: RuntimeControllerId;
  readonly runId: RunId;
  readonly lifecycle: RuntimeControllerLifecycle;
  readonly plan: RuntimeControllerPlan;
  readonly environment?: ExecutionEnvironment;
  readonly machine?: MachineInstance;
  readonly lease?: MachineLease;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly failure?: RuntimeControllerFailure;
}

function controllerId(value: RuntimeControllerId): RuntimeControllerId {
  return parseEntityId<"runtime-controller">(value, "runtime controller ID");
}

function runId(value: RunId): RunId {
  return parseEntityId<"run">(value, "runtime controller run ID");
}

function assertControllerTime(now: IsoTimestamp, previous: IsoTimestamp, label: string): void {
  assertIsoTimestamp(now, label);
  assertDomain(
    Date.parse(now) >= Date.parse(previous),
    "invalid_argument",
    `${label} cannot move backwards.`,
  );
}

function freezeEnvelope(input: RuntimeMachineEnvelope): RuntimeMachineEnvelope {
  return Object.freeze({
    ownerScopeHash: assertSha256(input.ownerScopeHash, "runtime owner-scope hash"),
    templateHash: assertSha256(input.templateHash, "runtime template hash"),
    baseImageHash: assertSha256(input.baseImageHash, "runtime base-image hash"),
    runtimeAdapterHash: assertSha256(input.runtimeAdapterHash, "runtime adapter hash"),
    effectivePolicyHash: assertSha256(input.effectivePolicyHash, "runtime effective-policy hash"),
    capabilitySetHash: assertSha256(input.capabilitySetHash, "runtime capability-set hash"),
    mountSetHash: assertSha256(input.mountSetHash, "runtime mount-set hash"),
    networkPolicyHash: assertSha256(input.networkPolicyHash, "runtime network-policy hash"),
  });
}

function machineMatchesEnvelope(machine: MachineInstance, envelope: RuntimeMachineEnvelope): void {
  assertDomain(
    machine.ownerScopeHash === envelope.ownerScopeHash,
    "scope_violation",
    "Runtime machine owner scope does not match the frozen acquisition envelope.",
  );
  assertDomain(
    machine.templateHash === envelope.templateHash &&
      machine.baseImageHash === envelope.baseImageHash &&
      machine.runtimeAdapterHash === envelope.runtimeAdapterHash,
    "invalid_state_transition",
    "Runtime machine image or adapter does not match the frozen acquisition envelope.",
  );
  assertDomain(
    machine.effectivePolicyHash === envelope.effectivePolicyHash &&
      machine.capabilitySetHash === envelope.capabilitySetHash &&
      machine.mountSetHash === envelope.mountSetHash &&
      machine.networkPolicyHash === envelope.networkPolicyHash,
    "scope_violation",
    "Runtime machine security envelope does not match the frozen acquisition envelope.",
  );
}

function selectedMode(plan: RuntimeControllerPlan): "none" | "persistent" | "isolated" | "remote" {
  return plan.selection.selectedMode;
}

function assertPlanIntegrity(plan: RuntimeControllerPlan): void {
  assertDomain(plan.version === 1, "invalid_argument", "Unsupported runtime controller plan version.");
  assertSha256(plan.selection.policyVersionHash, "runtime policy version hash");
  const mode = selectedMode(plan);
  if (mode === "none") {
    assertDomain(
      plan.acquisition.action === "none" && plan.acquisition.selectedMode === "none",
      "invalid_state_transition",
      "An environment-free selection cannot carry a machine acquisition action.",
    );
    assertDomain(
      plan.machineEnvelope === undefined,
      "invalid_state_transition",
      "An environment-free selection cannot carry a machine envelope.",
    );
    return;
  }
  assertDomain(
    plan.acquisition.selectedMode === mode,
    "invalid_state_transition",
    "Machine acquisition mode must match the selected execution mode.",
  );
  assertDomain(plan.machineEnvelope !== undefined, "invalid_state_transition", "Executable plans require a machine envelope.");
  const envelope = freezeEnvelope(plan.machineEnvelope);
  assertDomain(
    plan.acquisition.capabilitySetHash === envelope.capabilitySetHash,
    "scope_violation",
    "Machine acquisition capability scope must match the frozen runtime envelope.",
  );
  if (plan.acquisition.action === "reuse" || plan.acquisition.action === "restore") {
    assertDomain(plan.acquisition.machineId !== undefined, "invalid_state_transition", "Reusable acquisition plans require a machine ID.");
    assertDomain(plan.acquisition.generation !== undefined, "invalid_state_transition", "Reusable acquisition plans require a machine generation.");
    parseEntityId(plan.acquisition.machineId, "runtime acquisition machine ID");
    assertDomain(
      Number.isSafeInteger(plan.acquisition.generation) && plan.acquisition.generation > 0,
      "invalid_argument",
      "Reusable acquisition plans require a positive machine generation.",
    );
  }
}

/** Resolve the environment and machine acquisition decisions without side effects. */
export function planRuntimeController(input: PlanRuntimeControllerInput): RuntimeControllerPlan {
  assertIsoTimestamp(input.now, "runtime controller planning time");
  const selection = resolveExecutionMode(input.requirements, input.policy);
  if (selection.selectedMode === "none") {
    return Object.freeze({
      version: 1,
      selection,
      acquisition: Object.freeze({
        action: "none",
        selectedMode: "none",
        reasonCodes: Object.freeze(["no-execution-required"] as const),
        considerations: Object.freeze([]),
      }),
    });
  }

  assertDomain(input.machine !== undefined, "invalid_argument", "Executable runtime planning requires a machine envelope.");
  const envelope = freezeEnvelope(input.machine);
  const acquisition = planMachineAcquisition({
    selection,
    ownerScopeHash: envelope.ownerScopeHash,
    templateHash: envelope.templateHash,
    baseImageHash: envelope.baseImageHash,
    runtimeAdapterHash: envelope.runtimeAdapterHash,
    effectivePolicyHash: envelope.effectivePolicyHash,
    capabilitySetHash: envelope.capabilitySetHash,
    mountSetHash: envelope.mountSetHash,
    networkPolicyHash: envelope.networkPolicyHash,
    candidates: input.machine.candidates,
    now: input.now,
  });
  return Object.freeze({
    version: 1,
    selection,
    acquisition,
    machineEnvelope: envelope,
  });
}

/** Backwards-friendly alias for callers that name the operation explicitly. */
export const planRuntimeExecution = planRuntimeController;

export interface CreateRuntimeControllerInput {
  readonly id: RuntimeControllerId;
  readonly runId: RunId;
  readonly plan: RuntimeControllerPlan;
  readonly now: IsoTimestamp;
}

export function createRuntimeController(input: CreateRuntimeControllerInput): RuntimeController {
  assertIsoTimestamp(input.now, "runtime controller creation time");
  const plan = Object.freeze({
    ...input.plan,
    ...(input.plan.machineEnvelope === undefined
      ? {}
      : { machineEnvelope: freezeEnvelope(input.plan.machineEnvelope) }),
  });
  assertPlanIntegrity(plan);
  return Object.freeze({
    version: 1,
    id: controllerId(input.id),
    runId: runId(input.runId),
    lifecycle: "planned",
    plan,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function replaceController(
  controller: RuntimeController,
  patch: Omit<Partial<RuntimeController>, "id" | "runId" | "plan" | "createdAt"> & {
    readonly updatedAt: IsoTimestamp;
  },
): RuntimeController {
  assertControllerTime(patch.updatedAt, controller.updatedAt, "runtime controller update time");
  return Object.freeze({ ...controller, ...patch });
}

export type RuntimeEnvironmentInput = Omit<CreateExecutionEnvironmentInput, "selection" | "now">;

/** Attach a policy-validated environment. Native provisioning remains separate. */
export function attachRuntimeEnvironment(
  controller: RuntimeController,
  input: RuntimeEnvironmentInput,
  now: IsoTimestamp,
): RuntimeController {
  assertDomain(controller.lifecycle === "planned", "invalid_state_transition", "Runtime environment can only be attached to a planned controller.");
  assertDomain(selectedMode(controller.plan) !== "none", "invalid_state_transition", "Model-only runs must not receive an execution environment.");
  assertDomain(controller.environment === undefined, "conflict", "Runtime controller already has an environment.");
  const environment = createExecutionEnvironment({ ...input, selection: controller.plan.selection, now });
  return replaceController(controller, { environment, lifecycle: "preparing", updatedAt: now });
}

/** Bind a provider-returned machine to the exact environment and plan envelope. */
export function bindRuntimeMachine(
  controller: RuntimeController,
  machine: MachineInstance,
): RuntimeController {
  assertDomain(controller.environment !== undefined, "invalid_state_transition", "A runtime environment must be attached before binding a machine.");
  assertDomain(controller.machine === undefined, "conflict", "Runtime controller already has a machine.");
  assertDomain(controller.plan.machineEnvelope !== undefined, "invalid_state_transition", "Executable runtime plan is missing its machine envelope.");
  assertDomain(machine.environmentId === controller.environment.id, "scope_violation", "Machine belongs to another execution environment.");
  assertDomain(machine.mode === selectedMode(controller.plan), "scope_violation", "Machine mode does not match the selected runtime mode.");
  machineMatchesEnvelope(machine, controller.plan.machineEnvelope);

  const acquisition = controller.plan.acquisition;
  if (acquisition.action === "reuse" || acquisition.action === "restore") {
    assertDomain(machine.id === acquisition.machineId, "scope_violation", "Bound machine does not match the planned reusable machine.");
    assertDomain(machine.generation === acquisition.generation, "conflict", "Bound machine generation changed after planning.");
  }
  if (acquisition.action === "restore") {
    assertDomain(machine.lifecycle === "suspended", "invalid_state_transition", "A restore plan requires a suspended machine.");
  }
  if (acquisition.action === "reuse") {
    assertDomain(machine.lifecycle === "ready", "invalid_state_transition", "A reuse plan requires a ready machine.");
  }
  if (acquisition.action === "provision") {
    assertDomain(
      machine.lifecycle === "provisioning" || machine.lifecycle === "ready",
      "invalid_state_transition",
      "A provision plan requires a newly provisioned or ready machine.",
    );
  }
  assertDomain(
    machine.lifecycle === "provisioning" || machine.lifecycle === "ready" || machine.lifecycle === "suspended",
    "invalid_state_transition",
    "A runtime controller can only bind a provisioning, ready, or suspended machine.",
  );
  const lifecycle: RuntimeControllerLifecycle = machine.lifecycle === "suspended" ? "suspended" : "preparing";
  // Existing reusable/suspended machines commonly have an older provider
  // timestamp than the newly-created controller/environment. Binding is a
  // controller event, so never move the orchestration clock backwards merely
  // because the provider record predates this run.
  const updatedAt = Date.parse(machine.updatedAt) >= Date.parse(controller.updatedAt)
    ? machine.updatedAt
    : controller.updatedAt;
  return replaceController(controller, { machine, lifecycle, updatedAt });
}

/** Alias used by native adapters that call the operation an attachment. */
export const attachRuntimeMachine = bindRuntimeMachine;

/** Mark the environment and newly provisioned machine ready for a lease. */
export function markRuntimeControllerReady(
  controller: RuntimeController,
  now: IsoTimestamp,
): RuntimeController {
  assertDomain(controller.environment !== undefined && controller.machine !== undefined, "invalid_state_transition", "Runtime readiness requires both an environment and a machine.");
  assertDomain(controller.lifecycle === "preparing", "invalid_state_transition", "Only a preparing runtime controller can become ready.");
  let environment = controller.environment;
  let machine = controller.machine;
  if (environment.lifecycle === "preparing") {
    environment = transitionExecutionEnvironment(environment, { to: "ready", now });
  } else {
    assertDomain(environment.lifecycle === "ready", "invalid_state_transition", "Environment is not ready for dispatch.");
  }
  if (machine.lifecycle === "provisioning") {
    machine = transitionMachine(machine, { to: "ready", now });
  }
  assertDomain(machine.lifecycle === "ready", "invalid_state_transition", "Machine is not ready for dispatch.");
  return replaceController(controller, { environment, machine, lifecycle: "ready", updatedAt: now });
}

export const prepareRuntimeController = markRuntimeControllerReady;

function assertLeaseRun(controller: RuntimeController, input: AcquireMachineLeaseInput): void {
  assertDomain(input.runId === controller.runId, "scope_violation", "Lease run does not match the runtime controller run.");
}

/** Acquire the single exclusive lease after both boundaries are ready. */
export function acquireRuntimeControllerLease(
  controller: RuntimeController,
  input: AcquireMachineLeaseInput,
): RuntimeController {
  assertDomain(controller.lifecycle === "ready", "invalid_state_transition", "Only a ready runtime controller can acquire a lease.");
  assertDomain(controller.environment !== undefined && controller.machine !== undefined, "invalid_state_transition", "Lease acquisition requires an environment and machine.");
  assertDomain(controller.environment.lifecycle === "ready", "invalid_state_transition", "Execution environment is not ready.");
  assertDomain(controller.machine.lifecycle === "ready", "invalid_state_transition", "Machine is not ready.");
  assertLeaseRun(controller, input);
  const acquired = acquireMachineLease(controller.machine, input);
  return replaceController(controller, {
    machine: acquired.machine,
    lease: acquired.lease,
    lifecycle: "leased",
    updatedAt: input.now,
  });
}

export const acquireRuntimeLease = acquireRuntimeControllerLease;

/** Revalidate all lease and envelope fences immediately before side effects. */
export function assertRuntimeControllerDispatchable(
  controller: RuntimeController,
  now: IsoTimestamp,
): void {
  assertDomain(controller.lifecycle === "leased", "permission_denied", "Runtime controller is not leased.");
  assertDomain(controller.environment !== undefined && controller.machine !== undefined && controller.lease !== undefined, "permission_denied", "Runtime controller lease state is incomplete.");
  assertDomain(controller.environment.lifecycle === "ready", "permission_denied", "Execution environment is not ready.");
  assertDomain(controller.plan.machineEnvelope !== undefined, "permission_denied", "Runtime controller plan is missing its machine envelope.");
  machineMatchesEnvelope(controller.machine, controller.plan.machineEnvelope);
  assertMachineLeaseUsable(controller.machine, controller.lease, now);
}

export function renewRuntimeControllerLease(
  controller: RuntimeController,
  input: { readonly now: IsoTimestamp; readonly expiresAt: IsoTimestamp },
): RuntimeController {
  assertDomain(controller.machine !== undefined && controller.lease !== undefined, "invalid_state_transition", "Runtime controller has no active lease.");
  assertDomain(controller.lifecycle === "leased", "invalid_state_transition", "Only a leased runtime controller can renew a lease.");
  const lease = renewMachineLease(controller.machine, controller.lease, input);
  return replaceController(controller, { lease, updatedAt: input.now });
}

export const renewRuntimeLease = renewRuntimeControllerLease;

export function closeRuntimeControllerLease(
  controller: RuntimeController,
  input: {
    readonly outcome: "released" | "expired" | "revoked";
    readonly now: IsoTimestamp;
    readonly quarantineMachine?: boolean;
  },
): RuntimeController {
  assertDomain(controller.machine !== undefined && controller.lease !== undefined, "invalid_state_transition", "Runtime controller has no active lease.");
  assertDomain(controller.lifecycle === "leased", "invalid_state_transition", "Only a leased runtime controller can close a lease.");
  const closed = closeMachineLease(controller.machine, controller.lease, input);
  const lifecycle: RuntimeControllerLifecycle = closed.machine.lifecycle === "quarantined" ? "blocked" : "ready";
  return replaceController(controller, {
    machine: closed.machine,
    lease: closed.lease,
    lifecycle,
    updatedAt: input.now,
  });
}

export const releaseRuntimeControllerLease = closeRuntimeControllerLease;

/** Suspend a ready, unleased persistent runtime without retaining authority. */
export function suspendRuntimeController(
  controller: RuntimeController,
  now: IsoTimestamp,
): RuntimeController {
  assertDomain(controller.lifecycle === "ready", "invalid_state_transition", "Only a ready runtime controller can be suspended.");
  assertDomain(controller.environment !== undefined && controller.machine !== undefined, "invalid_state_transition", "Suspension requires an environment and machine.");
  assertDomain(controller.lease === undefined, "conflict", "A leased runtime controller must close its lease before suspension.");
  assertDomain(controller.machine.mode === "persistent", "unsupported_capability", "Only persistent runtimes may be suspended.");
  const machine = transitionMachine(controller.machine, { to: "suspending", now });
  const suspendedMachine = transitionMachine(machine, { to: "suspended", now });
  const environment = transitionExecutionEnvironment(controller.environment, { to: "suspended", now });
  return replaceController(controller, { environment, machine: suspendedMachine, lifecycle: "suspended", updatedAt: now });
}

/** Restore a suspended persistent runtime with a fresh, passing attestation. */
export function restoreRuntimeController(
  controller: RuntimeController,
  input: { readonly attestation: MachineAttestation; readonly now: IsoTimestamp; readonly snapshotId?: MachineInstance["currentSnapshotId"] },
): RuntimeController {
  assertDomain(controller.lifecycle === "suspended", "invalid_state_transition", "Only a suspended runtime controller can be restored.");
  assertDomain(controller.environment !== undefined && controller.machine !== undefined, "invalid_state_transition", "Restore requires an environment and machine.");
  assertDomain(controller.lease === undefined, "conflict", "A suspended runtime cannot retain an active lease.");
  const restoring = transitionMachine(controller.machine, { to: "restoring", now: input.now });
  const machine = rotateMachineGeneration(restoring, { attestation: input.attestation, now: input.now, ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }) });
  const environment = transitionExecutionEnvironment(controller.environment, { to: "ready", now: input.now });
  return replaceController(controller, { environment, machine, lifecycle: "ready", updatedAt: input.now });
}

export const resumeRuntimeController = restoreRuntimeController;

/** Reset a ready runtime and rotate its generation without widening authority. */
export function resetRuntimeController(
  controller: RuntimeController,
  input: { readonly attestation: MachineAttestation; readonly now: IsoTimestamp },
): RuntimeController {
  assertDomain(controller.lifecycle === "ready", "invalid_state_transition", "Only a ready runtime controller can be reset.");
  assertDomain(controller.environment !== undefined && controller.machine !== undefined, "invalid_state_transition", "Reset requires an environment and machine.");
  assertDomain(controller.lease === undefined, "conflict", "A ready runtime must close its lease before reset.");
  const resetting = transitionMachine(controller.machine, { to: "resetting", now: input.now });
  const machine = rotateMachineGeneration(resetting, { attestation: input.attestation, now: input.now });
  return replaceController(controller, { machine, updatedAt: input.now });
}

/** Stop a runtime only after its lease and temporary authority are gone. */
export function stopRuntimeController(
  controller: RuntimeController,
  now: IsoTimestamp,
): RuntimeController {
  assertDomain(controller.lifecycle === "ready" || controller.lifecycle === "suspended", "invalid_state_transition", "Only a ready or suspended runtime controller can stop.");
  assertDomain(controller.environment !== undefined && controller.machine !== undefined, "invalid_state_transition", "Stopping requires an environment and machine.");
  assertDomain(controller.lease === undefined, "conflict", "A runtime lease must be closed before stopping.");
  const environment = transitionExecutionEnvironment(controller.environment, { to: "stopped", now });
  let machine = controller.machine;
  if (machine.lifecycle === "ready" || machine.lifecycle === "suspended") {
    machine = transitionMachine(machine, { to: "stopping", now });
    machine = transitionMachine(machine, { to: "stopped", now });
  }
  return replaceController(controller, { environment, machine, lifecycle: "stopped", updatedAt: now });
}

export function failRuntimeController(
  controller: RuntimeController,
  input: { readonly code: string; readonly diagnosticId?: string; readonly now: IsoTimestamp },
): RuntimeController {
  assertNonBlank(input.code, "runtime failure code", 160);
  assertControllerTime(input.now, controller.updatedAt, "runtime failure time");
  const failure = Object.freeze({
    code: input.code.trim(),
    ...(input.diagnosticId === undefined ? {} : { diagnosticId: assertNonBlank(input.diagnosticId, "runtime diagnostic ID", 256) }),
  });
  let environment = controller.environment;
  if (environment !== undefined && environment.lifecycle !== "stopped" && environment.lifecycle !== "failed") {
    const canFail = environment.lifecycle === "preparing" || environment.lifecycle === "ready" || environment.lifecycle === "suspended" || environment.lifecycle === "snapshotting";
    if (canFail) environment = transitionExecutionEnvironment(environment, { to: "failed", now: input.now, failure });
  }
  let machine = controller.machine;
  if (machine !== undefined && machine.lifecycle !== "stopped" && machine.lifecycle !== "failed") {
    const canFail: readonly MachineLifecycle[] = ["provisioning", "ready", "leased", "suspending", "suspended", "snapshotting", "restoring", "resetting", "quarantined", "stopping"];
    if (canFail.includes(machine.lifecycle)) machine = transitionMachine(machine, { to: "failed", now: input.now, failure });
  }
  return replaceController(controller, {
    ...(environment === undefined ? {} : { environment }),
    ...(machine === undefined ? {} : { machine }),
    lifecycle: "failed",
    failure,
    updatedAt: input.now,
  });
}

export function serializeRuntimeController(controller: RuntimeController): string {
  assertPlanIntegrity(controller.plan);
  return JSON.stringify(controller, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROLLER_LIFECYCLES: readonly RuntimeControllerLifecycle[] = [
  "planned",
  "preparing",
  "ready",
  "leased",
  "suspended",
  "stopping",
  "stopped",
  "failed",
  "blocked",
];

/**
 * Hydrates the controller envelope without pretending that arbitrary native
 * machine/environment payloads are trusted. Full nested validation remains the
 * responsibility of their respective domain constructors.
 */
export function deserializeRuntimeController(input: string | unknown): RuntimeController {
  const value: unknown = typeof input === "string" ? JSON.parse(input) as unknown : input;
  assertDomain(isRecord(value), "invalid_argument", "Invalid runtime controller payload.");
  assertDomain(value.version === 1, "invalid_argument", "Unsupported runtime controller version.");
  assertDomain(typeof value.id === "string" && typeof value.runId === "string", "invalid_argument", "Runtime controller identity is invalid.");
  assertDomain(typeof value.lifecycle === "string" && CONTROLLER_LIFECYCLES.includes(value.lifecycle as RuntimeControllerLifecycle), "invalid_argument", "Runtime controller lifecycle is invalid.");
  assertDomain(typeof value.createdAt === "string" && typeof value.updatedAt === "string", "invalid_argument", "Runtime controller timestamps are invalid.");
  assertIsoTimestamp(value.createdAt, "runtime controller creation time");
  assertIsoTimestamp(value.updatedAt, "runtime controller update time");
  assertDomain(Date.parse(value.updatedAt) >= Date.parse(value.createdAt), "invalid_argument", "Runtime controller update time cannot precede creation time.");
  assertDomain(isRecord(value.plan), "invalid_argument", "Runtime controller plan is missing.");
  const plan = value.plan as unknown as RuntimeControllerPlan;
  assertPlanIntegrity(plan);
  const result: RuntimeController = {
    version: 1,
    id: controllerId(value.id as RuntimeControllerId),
    runId: runId(value.runId as RunId),
    lifecycle: value.lifecycle as RuntimeControllerLifecycle,
    plan,
    ...(value.environment === undefined ? {} : { environment: value.environment as ExecutionEnvironment }),
    ...(value.machine === undefined ? {} : { machine: value.machine as MachineInstance }),
    ...(value.lease === undefined ? {} : { lease: value.lease as MachineLease }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.failure === undefined ? {} : { failure: value.failure as RuntimeControllerFailure }),
  };
  if (selectedMode(result.plan) === "none") {
    assertDomain(
      result.environment === undefined && result.machine === undefined && result.lease === undefined,
      "invalid_state_transition",
      "An environment-free runtime controller cannot carry environment, machine, or lease state.",
    );
    assertDomain(
      result.lifecycle === "planned" || result.lifecycle === "failed",
      "invalid_state_transition",
      "An environment-free runtime controller can only be planned or failed.",
    );
  } else {
    assertDomain(
      result.lifecycle === "planned" || result.lifecycle === "failed" || result.environment !== undefined,
      "invalid_state_transition",
      "A prepared runtime controller must carry an execution environment.",
    );
  }
  if (result.lifecycle === "leased") assertDomain(result.lease !== undefined && result.machine !== undefined, "invalid_state_transition", "A leased runtime controller must carry a machine lease.");
  return Object.freeze(result);
}

/** Compact read-only projection for inspectors and renderer adapters. */
export interface RuntimeControllerSummary {
  readonly id: RuntimeControllerId;
  readonly runId: RunId;
  readonly lifecycle: RuntimeControllerLifecycle;
  readonly selectedMode: RuntimeControllerPlan["selection"]["selectedMode"];
  readonly acquisitionAction: MachineAcquisitionPlan["action"];
  readonly environmentId?: ExecutionEnvironmentId;
  readonly machineId?: MachineInstance["id"];
  readonly machineGeneration?: number;
  readonly leaseId?: MachineLease["id"];
  readonly policyVersionHash: string;
  readonly updatedAt: IsoTimestamp;
}

export function summarizeRuntimeController(controller: RuntimeController): RuntimeControllerSummary {
  return Object.freeze({
    id: controller.id,
    runId: controller.runId,
    lifecycle: controller.lifecycle,
    selectedMode: controller.plan.selection.selectedMode,
    acquisitionAction: controller.plan.acquisition.action,
    ...(controller.environment === undefined ? {} : { environmentId: controller.environment.id }),
    ...(controller.machine === undefined ? {} : { machineId: controller.machine.id, machineGeneration: controller.machine.generation }),
    ...(controller.lease === undefined ? {} : { leaseId: controller.lease.id }),
    policyVersionHash: controller.plan.selection.policyVersionHash,
    updatedAt: controller.updatedAt,
  });
}

// Keep these imports visible in generated declaration files for adapter authors
// that construct the environment input from the controller surface.
export type { EnvironmentMount, EnvironmentNetworkPolicy, EnvironmentPersistencePolicy, EnvironmentResourceBudget };
