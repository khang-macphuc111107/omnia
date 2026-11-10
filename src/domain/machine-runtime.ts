import { assertDomain } from "./errors";
import type {
  EntityId,
  ConversationId,
  ExecutionEnvironmentId,
  ProfileId,
  ProjectId,
  RunId,
} from "./ids";
import { parseEntityId } from "./ids";
import type {
  ConcreteExecutionMode,
  ExecutionModeSelection,
} from "./execution";
import {
  assertIsoTimestamp,
  assertNonBlank,
  assertSha256,
  type IsoTimestamp,
} from "./shared";

export type MachineInstanceId = EntityId<"machine-instance">;
export type MachineLeaseId = EntityId<"machine-lease">;
export type MachineSnapshotId = EntityId<"machine-snapshot">;
export type MachineAttestationId = EntityId<"machine-attestation">;
export type MachineDriftReportId = EntityId<"machine-drift-report">;

export type MachineProviderKind =
  | "windows-sandbox"
  | "hyper-v-vm"
  | "hyper-v-isolated-container"
  | "managed-remote-vm";

export type MachineSecurityBoundary =
  | "windows-sandbox"
  | "hypervisor-vm"
  | "hyper-v-isolated-container"
  | "managed-remote-vm";

export type MachineLifecycle =
  | "provisioning"
  | "ready"
  | "leased"
  | "suspending"
  | "suspended"
  | "snapshotting"
  | "restoring"
  | "resetting"
  | "quarantined"
  | "stopping"
  | "stopped"
  | "failed";

export type MachineOwnerScope =
  | {
      readonly kind: "project";
      readonly profileId: ProfileId;
      readonly projectId: ProjectId;
    }
  | {
      readonly kind: "conversation";
      readonly profileId: ProfileId;
      readonly conversationId: ConversationId;
    }
  | {
      readonly kind: "run";
      readonly profileId: ProfileId;
      readonly runId: RunId;
    };

export interface MachineAttestation {
  readonly id: MachineAttestationId;
  readonly machineId: MachineInstanceId;
  readonly machineGeneration: number;
  readonly status: "passed" | "failed";
  readonly securityBoundary: MachineSecurityBoundary;
  readonly runtimeAdapterHash: string;
  readonly baseImageHash: string;
  readonly effectivePolicyHash: string;
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
  readonly evidenceHash: string;
  readonly standardUserToken: boolean;
  readonly administratorTokenPresent: boolean;
  readonly ambientHostProfileMounted: boolean;
  readonly ambientHostDriveMounted: boolean;
  readonly ambientSecretHandleCount: number;
  readonly clipboardEnabled: boolean;
  readonly deviceBridgeCount: number;
  readonly inboundListenerCount: number;
  readonly jobLimitsApplied: boolean;
  readonly networkPolicyApplied: boolean;
  readonly mountPolicyApplied: boolean;
  readonly providerHealthPassed: boolean;
  readonly attestedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface MachineInstance {
  readonly id: MachineInstanceId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly providerKind: MachineProviderKind;
  readonly mode: ConcreteExecutionMode;
  readonly ownerScope: MachineOwnerScope;
  readonly ownerScopeHash: string;
  readonly lifecycle: MachineLifecycle;
  /** Incremented after every reset, restore, or replacement. Stale leases fail closed. */
  readonly generation: number;
  readonly templateHash: string;
  readonly baseImageHash: string;
  readonly runtimeAdapterHash: string;
  readonly effectivePolicyHash: string;
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
  readonly attestationId: MachineAttestationId;
  readonly attestationExpiresAt: IsoTimestamp;
  readonly driftStatus: "clean" | "review-required" | "quarantine";
  readonly activeLeaseId?: MachineLeaseId;
  readonly currentSnapshotId?: MachineSnapshotId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly failure?: {
    readonly code: string;
    readonly diagnosticId?: string;
  };
}

export interface MachineLease {
  readonly id: MachineLeaseId;
  readonly machineId: MachineInstanceId;
  readonly machineGeneration: number;
  readonly environmentId: ExecutionEnvironmentId;
  readonly runId: RunId;
  readonly state: "active" | "released" | "expired" | "revoked";
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
  readonly effectivePolicyHash: string;
  readonly acquiredAt: IsoTimestamp;
  readonly heartbeatAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly closedAt?: IsoTimestamp;
}

export const REQUIRED_SNAPSHOT_EXCLUSIONS = [
  "secrets",
  "approvals",
  "temporary-grants",
  "processes",
  "volatile-memory",
  "network-sessions",
  "browser-sessions",
  "device-sessions",
] as const;

export type MachineSnapshotExclusion = (typeof REQUIRED_SNAPSHOT_EXCLUSIONS)[number];

export interface MachineSnapshot {
  readonly id: MachineSnapshotId;
  readonly machineId: MachineInstanceId;
  readonly sourceGeneration: number;
  readonly ownerScopeHash: string;
  readonly templateHash: string;
  readonly baseImageHash: string;
  readonly runtimeAdapterHash: string;
  readonly effectivePolicyHash: string;
  readonly fileSystemStateHash: string;
  readonly manifestHash: string;
  readonly parentSnapshotId?: MachineSnapshotId;
  readonly consistency: "production-checkpoint" | "filesystem-consistent";
  readonly excludedState: readonly MachineSnapshotExclusion[];
  readonly sizeBytes: number;
  readonly createdAt: IsoTimestamp;
  readonly verifiedAt: IsoTimestamp;
}

export type MachineDriftKind =
  | "base-image"
  | "runtime-adapter"
  | "policy"
  | "capability-set"
  | "mount-set"
  | "network-policy"
  | "package-state"
  | "filesystem-state"
  | "secret-scan"
  | "attestation"
  | "clock";

export interface MachineDriftFinding {
  readonly kind: MachineDriftKind;
  readonly severity: "info" | "warning" | "critical";
  readonly code: string;
  readonly expectedHash?: string;
  readonly observedHash?: string;
}

export interface MachineDriftReport {
  readonly id: MachineDriftReportId;
  readonly machineId: MachineInstanceId;
  readonly machineGeneration: number;
  readonly status: "clean" | "review-required" | "quarantine";
  readonly findings: readonly MachineDriftFinding[];
  readonly reportHash: string;
  readonly observedAt: IsoTimestamp;
}

const MACHINE_TRANSITIONS = {
  provisioning: ["ready", "quarantined", "stopping", "failed"],
  ready: ["leased", "suspending", "snapshotting", "resetting", "quarantined", "stopping", "failed"],
  leased: ["ready", "quarantined", "stopping", "failed"],
  suspending: ["suspended", "quarantined", "failed"],
  suspended: ["restoring", "snapshotting", "resetting", "quarantined", "stopping", "failed"],
  snapshotting: ["ready", "suspended", "quarantined", "failed"],
  restoring: ["ready", "quarantined", "failed"],
  resetting: ["ready", "quarantined", "failed"],
  quarantined: ["resetting", "stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: [],
  failed: ["quarantined", "stopping"],
} as const satisfies Readonly<Record<MachineLifecycle, readonly MachineLifecycle[]>>;

function validatedId<TKind extends string>(value: EntityId<TKind>, label: string): EntityId<TKind> {
  return parseEntityId<TKind>(value, label);
}

function assertSafePositiveInteger(value: number, label: string, allowZero = false): void {
  assertDomain(
    Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0),
    "invalid_argument",
    `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer.`,
    { label, value },
  );
}

function assertChronology(start: string, end: string, label: string): void {
  assertIsoTimestamp(start, `${label} start`);
  assertIsoTimestamp(end, `${label} end`);
  assertDomain(
    Date.parse(end) > Date.parse(start),
    "invalid_argument",
    `${label} end must be after its start.`,
  );
}

function expectedBoundary(providerKind: MachineProviderKind): MachineSecurityBoundary {
  if (providerKind === "windows-sandbox") return "windows-sandbox";
  if (providerKind === "hyper-v-vm") return "hypervisor-vm";
  if (providerKind === "hyper-v-isolated-container") return "hyper-v-isolated-container";
  return "managed-remote-vm";
}

function assertProviderSupportsMode(
  providerKind: MachineProviderKind,
  mode: ConcreteExecutionMode,
): void {
  const supported =
    (providerKind === "windows-sandbox" && mode === "isolated") ||
    (providerKind === "hyper-v-vm" && (mode === "persistent" || mode === "isolated")) ||
    (providerKind === "hyper-v-isolated-container" && mode === "isolated") ||
    (providerKind === "managed-remote-vm" && mode === "remote");
  assertDomain(
    supported,
    "unsupported_capability",
    "The machine provider cannot satisfy the selected execution mode.",
    { providerKind, mode },
  );
}

function assertScopeForMode(scope: MachineOwnerScope, mode: ConcreteExecutionMode): void {
  validatedId(scope.profileId, "machine owner profile ID");
  if (scope.kind === "project") validatedId(scope.projectId, "machine owner project ID");
  if (scope.kind === "conversation") {
    validatedId(scope.conversationId, "machine owner conversation ID");
  }
  if (scope.kind === "run") validatedId(scope.runId, "machine owner run ID");

  assertDomain(
    mode !== "persistent" || scope.kind !== "run",
    "scope_violation",
    "A persistent machine must be owned by a project or conversation, never by an implicit global or run-only scope.",
  );
  assertDomain(
    mode !== "isolated" || scope.kind === "run",
    "scope_violation",
    "An isolated machine is single-run by default and must use run ownership.",
  );
}

export function createMachineAttestation(input: MachineAttestation): MachineAttestation {
  const id = validatedId(input.id, "machine attestation ID");
  const machineId = validatedId(input.machineId, "machine instance ID");
  assertSafePositiveInteger(input.machineGeneration, "machine generation");
  assertChronology(input.attestedAt, input.expiresAt, "machine attestation");
  const hashes = {
    runtimeAdapterHash: assertSha256(input.runtimeAdapterHash, "runtime adapter hash"),
    baseImageHash: assertSha256(input.baseImageHash, "base image hash"),
    effectivePolicyHash: assertSha256(input.effectivePolicyHash, "effective policy hash"),
    capabilitySetHash: assertSha256(input.capabilitySetHash, "capability-set hash"),
    mountSetHash: assertSha256(input.mountSetHash, "mount-set hash"),
    networkPolicyHash: assertSha256(input.networkPolicyHash, "network-policy hash"),
    evidenceHash: assertSha256(input.evidenceHash, "attestation evidence hash"),
  };
  assertSafePositiveInteger(input.ambientSecretHandleCount, "ambient secret handle count", true);
  assertSafePositiveInteger(input.deviceBridgeCount, "device bridge count", true);
  assertSafePositiveInteger(input.inboundListenerCount, "inbound listener count", true);

  if (input.status === "passed") {
    assertDomain(
      input.standardUserToken && !input.administratorTokenPresent,
      "scope_violation",
      "A passed machine attestation requires a standard-user token and no administrator token.",
    );
    assertDomain(
      !input.ambientHostProfileMounted &&
        !input.ambientHostDriveMounted &&
        input.ambientSecretHandleCount === 0,
      "scope_violation",
      "A passed machine attestation cannot expose ambient host profile, drive, or secret access.",
    );
    assertDomain(
      !input.clipboardEnabled && input.deviceBridgeCount === 0 && input.inboundListenerCount === 0,
      "scope_violation",
      "Clipboard, device bridges, and inbound listeners are disabled at the machine boundary.",
    );
    assertDomain(
      input.jobLimitsApplied &&
        input.networkPolicyApplied &&
        input.mountPolicyApplied &&
        input.providerHealthPassed,
      "invalid_state_transition",
      "A passed machine attestation must verify resource, network, mount, and provider controls.",
    );
  }

  return Object.freeze({ ...input, id, machineId, ...hashes });
}

export interface CreateMachineInstanceInput {
  readonly id: MachineInstanceId;
  readonly environmentId: ExecutionEnvironmentId;
  readonly selection: ExecutionModeSelection;
  readonly providerKind: MachineProviderKind;
  readonly ownerScope: MachineOwnerScope;
  readonly ownerScopeHash: string;
  readonly templateHash: string;
  readonly attestation: MachineAttestation;
  readonly now: IsoTimestamp;
}

export function createMachineInstance(input: CreateMachineInstanceInput): MachineInstance {
  assertIsoTimestamp(input.now, "machine creation time");
  const id = validatedId(input.id, "machine instance ID");
  const environmentId = validatedId(input.environmentId, "execution environment ID");
  assertDomain(
    input.selection.selectedMode !== "none",
    "invalid_state_transition",
    "An environment-free run cannot provision a machine.",
  );
  const mode = input.selection.selectedMode;
  assertProviderSupportsMode(input.providerKind, mode);
  assertScopeForMode(input.ownerScope, mode);
  const attestation = createMachineAttestation(input.attestation);
  assertDomain(
    attestation.machineId === id && attestation.machineGeneration === 1,
    "scope_violation",
    "Initial attestation must belong to generation 1 of the machine being created.",
  );
  assertDomain(
    attestation.status === "passed" && attestation.securityBoundary === expectedBoundary(input.providerKind),
    "invalid_state_transition",
    "A machine cannot be created from a failed or mismatched attestation.",
  );
  assertDomain(
    Date.parse(attestation.attestedAt) <= Date.parse(input.now) &&
      Date.parse(input.now) < Date.parse(attestation.expiresAt),
    "invalid_argument",
    "Initial machine attestation must be current at creation time.",
  );

  return Object.freeze({
    id,
    environmentId,
    providerKind: input.providerKind,
    mode,
    ownerScope: Object.freeze({ ...input.ownerScope }),
    ownerScopeHash: assertSha256(input.ownerScopeHash, "owner-scope hash"),
    lifecycle: "provisioning",
    generation: 1,
    templateHash: assertSha256(input.templateHash, "machine template hash"),
    baseImageHash: attestation.baseImageHash,
    runtimeAdapterHash: attestation.runtimeAdapterHash,
    effectivePolicyHash: attestation.effectivePolicyHash,
    capabilitySetHash: attestation.capabilitySetHash,
    mountSetHash: attestation.mountSetHash,
    networkPolicyHash: attestation.networkPolicyHash,
    attestationId: attestation.id,
    attestationExpiresAt: attestation.expiresAt,
    driftStatus: "clean",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export interface TransitionMachineInput {
  readonly to: MachineLifecycle;
  readonly now: IsoTimestamp;
  readonly failure?: MachineInstance["failure"];
}

export function transitionMachine(
  machine: MachineInstance,
  input: TransitionMachineInput,
): MachineInstance {
  assertIsoTimestamp(input.now, "machine transition time");
  assertDomain(
    Date.parse(input.now) >= Date.parse(machine.updatedAt),
    "invalid_argument",
    "Machine transition time cannot move backwards.",
  );
  assertDomain(
    (MACHINE_TRANSITIONS[machine.lifecycle] as readonly MachineLifecycle[]).includes(input.to),
    "invalid_state_transition",
    `Machine cannot transition from ${machine.lifecycle} to ${input.to}.`,
    { machineId: machine.id, from: machine.lifecycle, to: input.to },
  );
  assertDomain(
    machine.activeLeaseId === undefined ||
      input.to === "ready" ||
      input.to === "quarantined" ||
      input.to === "stopping" ||
      input.to === "failed",
    "invalid_state_transition",
    "A leased machine must close or quarantine its active lease before another lifecycle operation.",
  );
  if (input.to === "failed") {
    assertDomain(input.failure !== undefined, "invalid_argument", "A failed machine needs a typed failure.");
  } else {
    assertDomain(input.failure === undefined, "invalid_argument", "Failure metadata is only valid when entering failed state.");
  }
  return Object.freeze({
    ...machine,
    lifecycle: input.to,
    updatedAt: input.now,
    ...(input.failure === undefined
      ? {}
      : {
          failure: Object.freeze({
            code: assertNonBlank(input.failure.code, "machine failure code", 160),
            ...(input.failure.diagnosticId === undefined
              ? {}
              : {
                  diagnosticId: assertNonBlank(
                    input.failure.diagnosticId,
                    "machine diagnostic ID",
                    256,
                  ),
                }),
          }),
        }),
  });
}

export interface RotateMachineGenerationInput {
  readonly attestation: MachineAttestation;
  readonly now: IsoTimestamp;
  readonly snapshotId?: MachineSnapshotId;
}

export function rotateMachineGeneration(
  machine: MachineInstance,
  input: RotateMachineGenerationInput,
): MachineInstance {
  assertDomain(
    machine.lifecycle === "resetting" || machine.lifecycle === "restoring",
    "invalid_state_transition",
    "Only a resetting or restoring machine may rotate its generation.",
  );
  assertDomain(
    machine.activeLeaseId === undefined,
    "conflict",
    "A machine generation cannot rotate while a lease is active.",
  );
  assertIsoTimestamp(input.now, "machine generation rotation time");
  const attestation = createMachineAttestation(input.attestation);
  assertDomain(
    attestation.machineId === machine.id && attestation.machineGeneration === machine.generation + 1,
    "scope_violation",
    "Replacement attestation must belong to the next generation of the same machine.",
  );
  assertDomain(
    attestation.status === "passed" && attestation.securityBoundary === expectedBoundary(machine.providerKind),
    "invalid_state_transition",
    "A replacement generation requires a passing provider-matched attestation.",
  );
  assertDomain(
    attestation.effectivePolicyHash === machine.effectivePolicyHash &&
      attestation.capabilitySetHash === machine.capabilitySetHash &&
      attestation.mountSetHash === machine.mountSetHash &&
      attestation.networkPolicyHash === machine.networkPolicyHash,
    "scope_violation",
    "Reset or restore cannot silently widen policy, capability, mount, or network scope.",
  );

  const {
    currentSnapshotId: previousSnapshotId,
    failure: previousFailure,
    ...retainedMachine
  } = machine;
  void previousSnapshotId;
  void previousFailure;

  return Object.freeze({
    ...retainedMachine,
    lifecycle: "ready",
    generation: machine.generation + 1,
    baseImageHash: attestation.baseImageHash,
    runtimeAdapterHash: attestation.runtimeAdapterHash,
    attestationId: attestation.id,
    attestationExpiresAt: attestation.expiresAt,
    driftStatus: "clean",
    ...(input.snapshotId === undefined
      ? {}
      : { currentSnapshotId: validatedId(input.snapshotId, "machine snapshot ID") }),
    updatedAt: input.now,
  });
}

export interface AcquireMachineLeaseInput {
  readonly id: MachineLeaseId;
  readonly runId: RunId;
  readonly expectedGeneration: number;
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
  readonly effectivePolicyHash: string;
  readonly now: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export function acquireMachineLease(
  machine: MachineInstance,
  input: AcquireMachineLeaseInput,
): { readonly machine: MachineInstance; readonly lease: MachineLease } {
  assertDomain(machine.lifecycle === "ready", "conflict", "Only a ready machine can be leased.");
  assertDomain(machine.activeLeaseId === undefined, "conflict", "Machine already has an active lease.");
  assertDomain(machine.driftStatus === "clean", "invalid_state_transition", "Drifted machines cannot be leased.");
  assertDomain(
    input.expectedGeneration === machine.generation,
    "conflict",
    "Machine generation changed before lease acquisition.",
  );
  assertChronology(input.now, input.expiresAt, "machine lease");
  assertDomain(
    Date.parse(input.now) < Date.parse(machine.attestationExpiresAt),
    "invalid_state_transition",
    "Machine attestation expired before lease acquisition.",
  );
  const capabilitySetHash = assertSha256(input.capabilitySetHash, "lease capability-set hash");
  const mountSetHash = assertSha256(input.mountSetHash, "lease mount-set hash");
  const networkPolicyHash = assertSha256(input.networkPolicyHash, "lease network-policy hash");
  const effectivePolicyHash = assertSha256(input.effectivePolicyHash, "lease effective-policy hash");
  assertDomain(
    capabilitySetHash === machine.capabilitySetHash &&
      mountSetHash === machine.mountSetHash &&
      networkPolicyHash === machine.networkPolicyHash &&
      effectivePolicyHash === machine.effectivePolicyHash,
    "scope_violation",
    "Lease authority must exactly match the attested machine envelope.",
  );

  const id = validatedId(input.id, "machine lease ID");
  const lease = Object.freeze({
    id,
    machineId: machine.id,
    machineGeneration: machine.generation,
    environmentId: machine.environmentId,
    runId: validatedId(input.runId, "lease run ID"),
    state: "active" as const,
    capabilitySetHash,
    mountSetHash,
    networkPolicyHash,
    effectivePolicyHash,
    acquiredAt: input.now,
    heartbeatAt: input.now,
    expiresAt: input.expiresAt,
  });
  return Object.freeze({
    lease,
    machine: Object.freeze({
      ...machine,
      lifecycle: "leased" as const,
      activeLeaseId: id,
      updatedAt: input.now,
    }),
  });
}

export function assertMachineLeaseUsable(
  machine: MachineInstance,
  lease: MachineLease,
  now: IsoTimestamp,
): void {
  assertIsoTimestamp(now, "lease validation time");
  assertDomain(lease.state === "active", "permission_denied", "Machine lease is not active.");
  assertDomain(
    machine.lifecycle === "leased" && machine.activeLeaseId === lease.id,
    "permission_denied",
    "Machine does not recognize the active lease.",
  );
  assertDomain(
    lease.machineId === machine.id &&
      lease.environmentId === machine.environmentId &&
      lease.machineGeneration === machine.generation,
    "permission_denied",
    "Machine lease is stale or belongs to another environment generation.",
  );
  assertDomain(
    Date.parse(now) >= Date.parse(lease.acquiredAt) && Date.parse(now) < Date.parse(lease.expiresAt),
    "permission_denied",
    "Machine lease is outside its validity window.",
  );
  assertDomain(
    lease.capabilitySetHash === machine.capabilitySetHash &&
      lease.mountSetHash === machine.mountSetHash &&
      lease.networkPolicyHash === machine.networkPolicyHash &&
      lease.effectivePolicyHash === machine.effectivePolicyHash,
    "permission_denied",
    "Machine security envelope changed after lease acquisition.",
  );
}

export function renewMachineLease(
  machine: MachineInstance,
  lease: MachineLease,
  input: { readonly now: IsoTimestamp; readonly expiresAt: IsoTimestamp },
): MachineLease {
  assertMachineLeaseUsable(machine, lease, input.now);
  assertChronology(input.now, input.expiresAt, "renewed machine lease");
  assertDomain(
    Date.parse(input.now) >= Date.parse(lease.heartbeatAt),
    "invalid_argument",
    "Lease heartbeat time cannot move backwards.",
  );
  return Object.freeze({ ...lease, heartbeatAt: input.now, expiresAt: input.expiresAt });
}

export function closeMachineLease(
  machine: MachineInstance,
  lease: MachineLease,
  input: {
    readonly outcome: "released" | "expired" | "revoked";
    readonly now: IsoTimestamp;
    readonly quarantineMachine?: boolean;
  },
): { readonly machine: MachineInstance; readonly lease: MachineLease } {
  assertIsoTimestamp(input.now, "lease close time");
  assertDomain(lease.state === "active", "conflict", "Only an active lease can be closed.");
  assertDomain(
    machine.activeLeaseId === lease.id && lease.machineGeneration === machine.generation,
    "conflict",
    "Lease is not the active lease for the current machine generation.",
  );
  assertDomain(
    Date.parse(input.now) >= Date.parse(lease.heartbeatAt),
    "invalid_argument",
    "Lease close time cannot precede the last heartbeat.",
  );
  const { activeLeaseId: closedLeaseId, ...releasedMachine } = machine;
  void closedLeaseId;
  return Object.freeze({
    lease: Object.freeze({ ...lease, state: input.outcome, closedAt: input.now }),
    machine: Object.freeze({
      ...releasedMachine,
      lifecycle: input.quarantineMachine ? "quarantined" : "ready",
      driftStatus: input.quarantineMachine ? "quarantine" : machine.driftStatus,
      updatedAt: input.now,
    }),
  });
}

export interface CreateMachineSnapshotInput {
  readonly id: MachineSnapshotId;
  readonly parentSnapshotId?: MachineSnapshotId;
  readonly fileSystemStateHash: string;
  readonly manifestHash: string;
  readonly consistency: MachineSnapshot["consistency"];
  readonly excludedState: readonly MachineSnapshotExclusion[];
  readonly sizeBytes: number;
  readonly createdAt: IsoTimestamp;
  readonly verifiedAt: IsoTimestamp;
}

export function createVerifiedMachineSnapshot(
  machine: MachineInstance,
  input: CreateMachineSnapshotInput,
): MachineSnapshot {
  assertDomain(machine.mode === "persistent", "unsupported_capability", "Only persistent machines retain snapshots.");
  assertDomain(
    machine.lifecycle === "suspended" && machine.activeLeaseId === undefined,
    "invalid_state_transition",
    "A persistent machine must be suspended and unleased before snapshot verification.",
  );
  assertChronology(input.createdAt, input.verifiedAt, "machine snapshot verification");
  assertSafePositiveInteger(input.sizeBytes, "machine snapshot size", true);
  const exclusions = [...new Set(input.excludedState)];
  assertDomain(
    exclusions.length === input.excludedState.length &&
      REQUIRED_SNAPSHOT_EXCLUSIONS.every((value) => exclusions.includes(value)),
    "scope_violation",
    "Machine snapshots must explicitly exclude secrets, approvals, volatile processes, sessions, and temporary grants.",
  );
  return Object.freeze({
    id: validatedId(input.id, "machine snapshot ID"),
    machineId: machine.id,
    sourceGeneration: machine.generation,
    ownerScopeHash: machine.ownerScopeHash,
    templateHash: machine.templateHash,
    baseImageHash: machine.baseImageHash,
    runtimeAdapterHash: machine.runtimeAdapterHash,
    effectivePolicyHash: machine.effectivePolicyHash,
    fileSystemStateHash: assertSha256(input.fileSystemStateHash, "snapshot filesystem-state hash"),
    manifestHash: assertSha256(input.manifestHash, "snapshot manifest hash"),
    ...(input.parentSnapshotId === undefined
      ? {}
      : { parentSnapshotId: validatedId(input.parentSnapshotId, "parent machine snapshot ID") }),
    consistency: input.consistency,
    excludedState: Object.freeze(exclusions),
    sizeBytes: input.sizeBytes,
    createdAt: input.createdAt,
    verifiedAt: input.verifiedAt,
  });
}

export function attachMachineSnapshot(
  machine: MachineInstance,
  snapshot: MachineSnapshot,
  now: IsoTimestamp,
): MachineInstance {
  assertIsoTimestamp(now, "snapshot attachment time");
  assertDomain(
    machine.lifecycle === "suspended" &&
      snapshot.machineId === machine.id &&
      snapshot.sourceGeneration === machine.generation,
    "scope_violation",
    "Snapshot must belong to the suspended machine's current generation.",
  );
  assertDomain(
    snapshot.ownerScopeHash === machine.ownerScopeHash &&
      snapshot.templateHash === machine.templateHash &&
      snapshot.effectivePolicyHash === machine.effectivePolicyHash,
    "scope_violation",
    "Snapshot ownership, template, and policy must match the machine.",
  );
  return Object.freeze({ ...machine, currentSnapshotId: snapshot.id, updatedAt: now });
}

export function createMachineDriftReport(
  machine: MachineInstance,
  input: {
    readonly id: MachineDriftReportId;
    readonly findings: readonly MachineDriftFinding[];
    readonly reportHash: string;
    readonly observedAt: IsoTimestamp;
  },
): MachineDriftReport {
  assertIsoTimestamp(input.observedAt, "machine drift observation time");
  const findings = input.findings.map((finding) => {
    const expectedHash = finding.expectedHash === undefined
      ? undefined
      : assertSha256(finding.expectedHash, "drift expected hash");
    const observedHash = finding.observedHash === undefined
      ? undefined
      : assertSha256(finding.observedHash, "drift observed hash");
    return Object.freeze({
      ...finding,
      code: assertNonBlank(finding.code, "drift finding code", 160),
      ...(expectedHash === undefined ? {} : { expectedHash }),
      ...(observedHash === undefined ? {} : { observedHash }),
    });
  });
  const status = findings.some((finding) => finding.severity === "critical")
    ? "quarantine"
    : findings.some((finding) => finding.severity === "warning")
      ? "review-required"
      : "clean";
  return Object.freeze({
    id: validatedId(input.id, "machine drift report ID"),
    machineId: machine.id,
    machineGeneration: machine.generation,
    status,
    findings: Object.freeze(findings),
    reportHash: assertSha256(input.reportHash, "machine drift report hash"),
    observedAt: input.observedAt,
  });
}

export function applyMachineDriftReport(
  machine: MachineInstance,
  report: MachineDriftReport,
): MachineInstance {
  assertDomain(
    report.machineId === machine.id && report.machineGeneration === machine.generation,
    "scope_violation",
    "Drift report belongs to another machine generation.",
  );
  const lifecycle = report.status === "quarantine" ? "quarantined" : machine.lifecycle;
  return Object.freeze({
    ...machine,
    lifecycle,
    driftStatus: report.status,
    updatedAt: report.observedAt,
  });
}

export type MachineCandidateRejection =
  | "mode-mismatch"
  | "scope-mismatch"
  | "template-mismatch"
  | "base-image-mismatch"
  | "runtime-mismatch"
  | "policy-mismatch"
  | "capability-mismatch"
  | "mount-mismatch"
  | "network-mismatch"
  | "not-reusable-state"
  | "active-lease"
  | "drifted"
  | "attestation-expired";

export interface MachineCandidateConsideration {
  readonly machineId: MachineInstanceId;
  readonly eligible: boolean;
  readonly rejectionReasons: readonly MachineCandidateRejection[];
}

export type MachineAcquisitionPlan =
  | {
      readonly action: "none";
      readonly selectedMode: "none";
      readonly reasonCodes: readonly ["no-execution-required"];
      readonly considerations: readonly MachineCandidateConsideration[];
    }
  | {
      readonly action: "reuse" | "restore";
      readonly selectedMode: "persistent";
      readonly machineId: MachineInstanceId;
      readonly generation: number;
      readonly capabilitySetHash: string;
      readonly reasonCodes: readonly string[];
      readonly considerations: readonly MachineCandidateConsideration[];
    }
  | {
      readonly action: "provision";
      readonly selectedMode: ConcreteExecutionMode;
      readonly capabilitySetHash: string;
      readonly reasonCodes: readonly string[];
      readonly considerations: readonly MachineCandidateConsideration[];
    };

export interface PlanMachineAcquisitionInput {
  readonly selection: ExecutionModeSelection;
  readonly ownerScopeHash: string;
  readonly templateHash: string;
  readonly baseImageHash: string;
  readonly runtimeAdapterHash: string;
  readonly effectivePolicyHash: string;
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
  readonly candidates: readonly MachineInstance[];
  readonly now: IsoTimestamp;
}

export function planMachineAcquisition(
  input: PlanMachineAcquisitionInput,
): MachineAcquisitionPlan {
  assertIsoTimestamp(input.now, "machine acquisition planning time");
  const expected = {
    ownerScopeHash: assertSha256(input.ownerScopeHash, "requested owner-scope hash"),
    templateHash: assertSha256(input.templateHash, "requested machine template hash"),
    baseImageHash: assertSha256(input.baseImageHash, "requested base-image hash"),
    runtimeAdapterHash: assertSha256(input.runtimeAdapterHash, "requested runtime-adapter hash"),
    effectivePolicyHash: assertSha256(input.effectivePolicyHash, "requested effective-policy hash"),
    capabilitySetHash: assertSha256(input.capabilitySetHash, "requested capability-set hash"),
    mountSetHash: assertSha256(input.mountSetHash, "requested mount-set hash"),
    networkPolicyHash: assertSha256(input.networkPolicyHash, "requested network-policy hash"),
  };

  const considerations = input.candidates.map((candidate) => {
    const rejectionReasons: MachineCandidateRejection[] = [];
    const selectedMode = input.selection.selectedMode;
    if (selectedMode !== "none" && candidate.mode !== selectedMode) rejectionReasons.push("mode-mismatch");
    if (candidate.ownerScopeHash !== expected.ownerScopeHash) rejectionReasons.push("scope-mismatch");
    if (candidate.templateHash !== expected.templateHash) rejectionReasons.push("template-mismatch");
    if (candidate.baseImageHash !== expected.baseImageHash) rejectionReasons.push("base-image-mismatch");
    if (candidate.runtimeAdapterHash !== expected.runtimeAdapterHash) rejectionReasons.push("runtime-mismatch");
    if (candidate.effectivePolicyHash !== expected.effectivePolicyHash) rejectionReasons.push("policy-mismatch");
    if (candidate.capabilitySetHash !== expected.capabilitySetHash) rejectionReasons.push("capability-mismatch");
    if (candidate.mountSetHash !== expected.mountSetHash) rejectionReasons.push("mount-mismatch");
    if (candidate.networkPolicyHash !== expected.networkPolicyHash) rejectionReasons.push("network-mismatch");
    if (candidate.lifecycle !== "ready" && candidate.lifecycle !== "suspended") {
      rejectionReasons.push("not-reusable-state");
    }
    if (candidate.activeLeaseId !== undefined) rejectionReasons.push("active-lease");
    if (candidate.driftStatus !== "clean") rejectionReasons.push("drifted");
    if (Date.parse(input.now) >= Date.parse(candidate.attestationExpiresAt)) {
      rejectionReasons.push("attestation-expired");
    }
    return Object.freeze({
      machineId: candidate.id,
      eligible: rejectionReasons.length === 0,
      rejectionReasons: Object.freeze(rejectionReasons),
    });
  });

  if (input.selection.selectedMode === "none") {
    return Object.freeze({
      action: "none",
      selectedMode: "none",
      reasonCodes: Object.freeze(["no-execution-required"] as const),
      considerations: Object.freeze(considerations),
    });
  }

  // Isolated and remote machines start clean for each acquisition in this contract.
  // Future pooling requires a separately attested zeroization receipt.
  if (input.selection.selectedMode !== "persistent") {
    return Object.freeze({
      action: "provision",
      selectedMode: input.selection.selectedMode,
      capabilitySetHash: expected.capabilitySetHash,
      reasonCodes: Object.freeze(["fresh-boundary-required"]),
      considerations: Object.freeze(considerations),
    });
  }

  const eligible = input.candidates
    .filter((_candidate, index) => considerations[index]?.eligible)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ready = eligible.find((candidate) => candidate.lifecycle === "ready");
  if (ready !== undefined) {
    return Object.freeze({
      action: "reuse",
      selectedMode: "persistent",
      machineId: ready.id,
      generation: ready.generation,
      capabilitySetHash: expected.capabilitySetHash,
      reasonCodes: Object.freeze(["exact-compatible-persistent-machine"]),
      considerations: Object.freeze(considerations),
    });
  }
  const suspended = eligible.find(
    (candidate) => candidate.lifecycle === "suspended" && candidate.currentSnapshotId !== undefined,
  );
  if (suspended !== undefined) {
    return Object.freeze({
      action: "restore",
      selectedMode: "persistent",
      machineId: suspended.id,
      generation: suspended.generation,
      capabilitySetHash: expected.capabilitySetHash,
      reasonCodes: Object.freeze(["verified-persistent-snapshot"]),
      considerations: Object.freeze(considerations),
    });
  }
  return Object.freeze({
    action: "provision",
    selectedMode: "persistent",
    capabilitySetHash: expected.capabilitySetHash,
    reasonCodes: Object.freeze(["no-exact-compatible-machine"]),
    considerations: Object.freeze(considerations),
  });
}

export const REQUIRED_RESUME_EXCLUSIONS = [
  "temporary-approvals",
  "temporary-grants",
  "administrator-state",
  "raw-secrets",
  "browser-sessions",
  "network-sessions",
  "processes",
] as const;

export type MachineResumeExclusion = (typeof REQUIRED_RESUME_EXCLUSIONS)[number];

export interface PersistentMachineResumeManifest {
  readonly machineId: MachineInstanceId;
  readonly machineGeneration: number;
  readonly ownerScopeHash: string;
  readonly templateHash: string;
  readonly baseImageHash: string;
  readonly runtimeAdapterHash: string;
  readonly effectivePolicyHash: string;
  readonly capabilitySetHash: string;
  readonly mountSetHash: string;
  readonly networkPolicyHash: string;
  readonly extensionSetHash: string;
  readonly currentSnapshotId?: MachineSnapshotId;
  readonly currentSnapshotManifestHash?: string;
  readonly pendingOperationStatus: "none" | "queryable" | "outcome-unknown";
  readonly excludedState: readonly MachineResumeExclusion[];
  readonly journalCursor: number;
  readonly createdAt: IsoTimestamp;
}

export type PersistentMachineResumeDecision =
  | {
      readonly action: "resume" | "reattest" | "restore" | "recreate";
      readonly reasonCodes: readonly string[];
    }
  | {
      readonly action: "blocked";
      readonly reasonCodes: readonly string[];
    };

export interface EvaluatePersistentMachineResumeInput {
  readonly manifest: PersistentMachineResumeManifest;
  readonly machine: MachineInstance;
  readonly currentExtensionSetHash: string;
  readonly snapshotVerified: boolean;
  readonly currentSnapshotManifestHash?: string;
  readonly journalCaughtUp: boolean;
  readonly now: IsoTimestamp;
}

export function evaluatePersistentMachineResume(
  input: EvaluatePersistentMachineResumeInput,
): PersistentMachineResumeDecision {
  const { manifest, machine } = input;
  assertIsoTimestamp(input.now, "machine resume evaluation time");
  assertIsoTimestamp(manifest.createdAt, "machine resume manifest time");
  assertSafePositiveInteger(manifest.machineGeneration, "resume machine generation");
  assertSafePositiveInteger(manifest.journalCursor, "resume journal cursor", true);
  const exclusions = [...new Set(manifest.excludedState)];
  assertDomain(
    exclusions.length === manifest.excludedState.length &&
      REQUIRED_RESUME_EXCLUSIONS.every((value) => exclusions.includes(value)),
    "scope_violation",
    "Resume manifest must explicitly exclude temporary authority, secrets, sessions, processes, and administrator state.",
  );

  const hashes = {
    ownerScopeHash: assertSha256(manifest.ownerScopeHash, "resume owner-scope hash"),
    templateHash: assertSha256(manifest.templateHash, "resume template hash"),
    baseImageHash: assertSha256(manifest.baseImageHash, "resume base-image hash"),
    runtimeAdapterHash: assertSha256(manifest.runtimeAdapterHash, "resume runtime-adapter hash"),
    effectivePolicyHash: assertSha256(manifest.effectivePolicyHash, "resume effective-policy hash"),
    capabilitySetHash: assertSha256(manifest.capabilitySetHash, "resume capability-set hash"),
    mountSetHash: assertSha256(manifest.mountSetHash, "resume mount-set hash"),
    networkPolicyHash: assertSha256(manifest.networkPolicyHash, "resume network-policy hash"),
    extensionSetHash: assertSha256(manifest.extensionSetHash, "resume extension-set hash"),
    currentExtensionSetHash: assertSha256(input.currentExtensionSetHash, "current extension-set hash"),
  };
  if (manifest.currentSnapshotManifestHash !== undefined) {
    assertSha256(manifest.currentSnapshotManifestHash, "resume snapshot manifest hash");
  }
  if (input.currentSnapshotManifestHash !== undefined) {
    assertSha256(input.currentSnapshotManifestHash, "current snapshot manifest hash");
  }

  const blocked: string[] = [];
  if (machine.mode !== "persistent") blocked.push("not-persistent");
  if (manifest.machineId !== machine.id) blocked.push("machine-identity-mismatch");
  if (manifest.machineGeneration !== machine.generation) blocked.push("stale-machine-generation");
  if (hashes.ownerScopeHash !== machine.ownerScopeHash) blocked.push("owner-scope-drift");
  if (hashes.effectivePolicyHash !== machine.effectivePolicyHash) blocked.push("policy-drift");
  if (hashes.capabilitySetHash !== machine.capabilitySetHash) blocked.push("capability-drift");
  if (hashes.mountSetHash !== machine.mountSetHash) blocked.push("mount-drift");
  if (hashes.networkPolicyHash !== machine.networkPolicyHash) blocked.push("network-drift");
  if (manifest.pendingOperationStatus === "outcome-unknown") blocked.push("outcome-unknown");
  if (!input.journalCaughtUp) blocked.push("journal-not-caught-up");
  if (machine.lifecycle === "leased") blocked.push("machine-already-leased");
  if (machine.lifecycle === "quarantined" || machine.driftStatus === "quarantine") {
    blocked.push("machine-quarantined");
  }
  if (blocked.length > 0) {
    return Object.freeze({ action: "blocked", reasonCodes: Object.freeze(blocked) });
  }

  const recreate: string[] = [];
  if (hashes.templateHash !== machine.templateHash) recreate.push("template-drift");
  if (hashes.baseImageHash !== machine.baseImageHash) recreate.push("base-image-drift");
  if (hashes.runtimeAdapterHash !== machine.runtimeAdapterHash) recreate.push("runtime-drift");
  if (hashes.extensionSetHash !== hashes.currentExtensionSetHash) recreate.push("extension-drift");
  if (machine.lifecycle === "stopped" || machine.lifecycle === "failed") {
    recreate.push("machine-not-running");
  }
  if (recreate.length > 0) {
    return Object.freeze({ action: "recreate", reasonCodes: Object.freeze(recreate) });
  }

  if (machine.lifecycle === "suspended") {
    const snapshotMatches =
      input.snapshotVerified &&
      manifest.currentSnapshotId !== undefined &&
      manifest.currentSnapshotId === machine.currentSnapshotId &&
      manifest.currentSnapshotManifestHash !== undefined &&
      manifest.currentSnapshotManifestHash === input.currentSnapshotManifestHash;
    return snapshotMatches
      ? Object.freeze({ action: "restore", reasonCodes: Object.freeze(["verified-snapshot"]) })
      : Object.freeze({ action: "blocked", reasonCodes: Object.freeze(["snapshot-not-verified"]) });
  }

  if (machine.lifecycle !== "ready") {
    return Object.freeze({
      action: "blocked",
      reasonCodes: Object.freeze(["machine-transition-in-progress"]),
    });
  }
  if (machine.driftStatus === "review-required") {
    return Object.freeze({ action: "reattest", reasonCodes: Object.freeze(["drift-review-required"]) });
  }
  if (Date.parse(input.now) >= Date.parse(machine.attestationExpiresAt)) {
    return Object.freeze({ action: "reattest", reasonCodes: Object.freeze(["attestation-expired"]) });
  }
  return Object.freeze({ action: "resume", reasonCodes: Object.freeze(["exact-resume-manifest"]) });
}
