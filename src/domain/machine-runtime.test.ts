import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type {
  ExecutionEnvironmentId,
  ProfileId,
  ProjectId,
  RunId,
} from "./ids";
import type { ExecutionModeSelection } from "./execution";
import {
  REQUIRED_RESUME_EXCLUSIONS,
  REQUIRED_SNAPSHOT_EXCLUSIONS,
  acquireMachineLease,
  applyMachineDriftReport,
  assertMachineLeaseUsable,
  attachMachineSnapshot,
  closeMachineLease,
  createMachineAttestation,
  createMachineDriftReport,
  createMachineInstance,
  createVerifiedMachineSnapshot,
  evaluatePersistentMachineResume,
  planMachineAcquisition,
  renewMachineLease,
  rotateMachineGeneration,
  transitionMachine,
  type MachineAttestation,
  type MachineAttestationId,
  type MachineInstance,
  type MachineInstanceId,
  type MachineLeaseId,
  type MachineSnapshotId,
} from "./machine-runtime";

const id = <T extends string>(value: string) => value as T;
const hash = (character: string) => character.repeat(64);
const now = "2026-08-13T00:00:00.000Z";
const attestationExpiry = "2026-08-13T01:00:00.000Z";
const profileId = id<ProfileId>("01K2H000000000000000000101");
const projectId = id<ProjectId>("01K2H000000000000000000102");
const runId = id<RunId>("01K2H000000000000000000104");
const environmentId = id<ExecutionEnvironmentId>("01K2H000000000000000000105");
const machineId = id<MachineInstanceId>("01K2H000000000000000000106");

const persistentSelection: ExecutionModeSelection = {
  requestedMode: "auto",
  selectedMode: "persistent",
  reasonCodes: ["durable-state"],
  considerations: [],
  policyVersionHash: hash("a"),
};

const isolatedSelection: ExecutionModeSelection = {
  requestedMode: "auto",
  selectedMode: "isolated",
  reasonCodes: ["unknown-code"],
  considerations: [],
  policyVersionHash: hash("a"),
};

function attestation(
  overrides: Partial<MachineAttestation> = {},
): MachineAttestation {
  return {
    id: id<MachineAttestationId>("01K2H000000000000000000107"),
    machineId,
    machineGeneration: 1,
    status: "passed",
    securityBoundary: "hypervisor-vm",
    runtimeAdapterHash: hash("b"),
    baseImageHash: hash("c"),
    effectivePolicyHash: hash("d"),
    capabilitySetHash: hash("e"),
    mountSetHash: hash("f"),
    networkPolicyHash: hash("1"),
    evidenceHash: hash("2"),
    standardUserToken: true,
    administratorTokenPresent: false,
    ambientHostProfileMounted: false,
    ambientHostDriveMounted: false,
    ambientSecretHandleCount: 0,
    clipboardEnabled: false,
    deviceBridgeCount: 0,
    inboundListenerCount: 0,
    jobLimitsApplied: true,
    networkPolicyApplied: true,
    mountPolicyApplied: true,
    providerHealthPassed: true,
    attestedAt: "2026-08-12T23:59:00.000Z",
    expiresAt: attestationExpiry,
    ...overrides,
  };
}

function persistentMachine(): MachineInstance {
  const provisioned = createMachineInstance({
    id: machineId,
    environmentId,
    selection: persistentSelection,
    providerKind: "hyper-v-vm",
    ownerScope: { kind: "project", profileId, projectId },
    ownerScopeHash: hash("3"),
    templateHash: hash("4"),
    attestation: attestation(),
    now,
  });
  return transitionMachine(provisioned, {
    to: "ready",
    now: "2026-08-13T00:00:01.000Z",
  });
}

function acquisitionInput(machine: MachineInstance) {
  return {
    selection: persistentSelection,
    ownerScopeHash: machine.ownerScopeHash,
    templateHash: machine.templateHash,
    baseImageHash: machine.baseImageHash,
    runtimeAdapterHash: machine.runtimeAdapterHash,
    effectivePolicyHash: machine.effectivePolicyHash,
    capabilitySetHash: machine.capabilitySetHash,
    mountSetHash: machine.mountSetHash,
    networkPolicyHash: machine.networkPolicyHash,
    candidates: [machine],
    now: "2026-08-13T00:00:02.000Z",
  } as const;
}

describe("machine provider, scope, and attestation boundary", () => {
  it("requires an isolated machine to be run-scoped and rejects provider/mode ambiguity", () => {
    const isolatedId = id<MachineInstanceId>("01K2H000000000000000000108");
    const isolatedAttestation = attestation({
      id: id<MachineAttestationId>("01K2H000000000000000000109"),
      machineId: isolatedId,
      securityBoundary: "windows-sandbox",
    });

    expect(() =>
      createMachineInstance({
        id: isolatedId,
        environmentId,
        selection: isolatedSelection,
        providerKind: "windows-sandbox",
        ownerScope: { kind: "project", profileId, projectId },
        ownerScopeHash: hash("3"),
        templateHash: hash("4"),
        attestation: isolatedAttestation,
        now,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createMachineInstance({
        id: isolatedId,
        environmentId,
        selection: isolatedSelection,
        providerKind: "hyper-v-isolated-container",
        ownerScope: { kind: "run", profileId, runId },
        ownerScopeHash: hash("3"),
        templateHash: hash("4"),
        attestation: isolatedAttestation,
        now,
      }),
    ).toThrowError(DomainError);
  });

  it("fails a supposedly healthy attestation if ambient authority is present", () => {
    expect(() =>
      createMachineAttestation(
        attestation({ administratorTokenPresent: true }),
      ),
    ).toThrowError(DomainError);
    expect(() =>
      createMachineAttestation(
        attestation({ ambientHostProfileMounted: true }),
      ),
    ).toThrowError(DomainError);
    expect(() =>
      createMachineAttestation(
        attestation({ clipboardEnabled: true }),
      ),
    ).toThrowError(DomainError);
  });

  it("never treats persistent mode as persistent administrator authority", () => {
    expect(persistentMachine()).toMatchObject({
      mode: "persistent",
      lifecycle: "ready",
      driftStatus: "clean",
    });
    expect(attestation()).toMatchObject({
      standardUserToken: true,
      administratorTokenPresent: false,
      ambientSecretHandleCount: 0,
    });
  });
});

describe("deterministic Auto machine acquisition", () => {
  it("reuses only an exact-compatible, attested persistent machine", () => {
    const machine = persistentMachine();
    expect(planMachineAcquisition(acquisitionInput(machine))).toMatchObject({
      action: "reuse",
      selectedMode: "persistent",
      machineId,
      generation: 1,
      reasonCodes: ["exact-compatible-persistent-machine"],
    });

    expect(
      planMachineAcquisition({
        ...acquisitionInput(machine),
        capabilitySetHash: hash("9"),
      }),
    ).toMatchObject({
      action: "provision",
      reasonCodes: ["no-exact-compatible-machine"],
      considerations: [
        { eligible: false, rejectionReasons: ["capability-mismatch"] },
      ],
    });
  });

  it("does not pool isolated or remote machines without a zeroization contract", () => {
    const selection = { ...acquisitionInput(persistentMachine()), selection: isolatedSelection };
    expect(planMachineAcquisition(selection)).toMatchObject({
      action: "provision",
      selectedMode: "isolated",
      reasonCodes: ["fresh-boundary-required"],
    });
  });

  it("keeps model-only chat machine-free", () => {
    const machine = persistentMachine();
    const noExecution: ExecutionModeSelection = {
      requestedMode: "auto",
      selectedMode: "none",
      reasonCodes: ["no-execution-required"],
      considerations: [],
      policyVersionHash: hash("a"),
    };
    expect(
      planMachineAcquisition({ ...acquisitionInput(machine), selection: noExecution }),
    ).toMatchObject({ action: "none", selectedMode: "none" });
  });
});

describe("machine leases and generation fencing", () => {
  it("binds each lease to exact machine generation and authority hashes", () => {
    const machine = persistentMachine();
    const acquired = acquireMachineLease(machine, {
      id: id<MachineLeaseId>("01K2H00000000000000000010A"),
      runId,
      expectedGeneration: 1,
      capabilitySetHash: machine.capabilitySetHash,
      mountSetHash: machine.mountSetHash,
      networkPolicyHash: machine.networkPolicyHash,
      effectivePolicyHash: machine.effectivePolicyHash,
      now: "2026-08-13T00:00:02.000Z",
      expiresAt: "2026-08-13T00:05:00.000Z",
    });

    expect(() =>
      assertMachineLeaseUsable(
        acquired.machine,
        acquired.lease,
        "2026-08-13T00:00:03.000Z",
      ),
    ).not.toThrow();
    const renewed = renewMachineLease(acquired.machine, acquired.lease, {
      now: "2026-08-13T00:01:00.000Z",
      expiresAt: "2026-08-13T00:06:00.000Z",
    });
    const closed = closeMachineLease(acquired.machine, renewed, {
      outcome: "released",
      now: "2026-08-13T00:02:00.000Z",
    });
    expect(closed.machine.lifecycle).toBe("ready");
    expect("activeLeaseId" in closed.machine).toBe(false);
    expect(closed.lease.state).toBe("released");

    const resetting = transitionMachine(closed.machine, {
      to: "resetting",
      now: "2026-08-13T00:02:01.000Z",
    });
    const generation2 = rotateMachineGeneration(resetting, {
      attestation: attestation({
        id: id<MachineAttestationId>("01K2H00000000000000000010B"),
        machineGeneration: 2,
        attestedAt: "2026-08-13T00:02:01.000Z",
        expiresAt: "2026-08-13T01:02:01.000Z",
      }),
      now: "2026-08-13T00:02:02.000Z",
    });
    expect(generation2.generation).toBe(2);
    expect(() =>
      assertMachineLeaseUsable(generation2, acquired.lease, "2026-08-13T00:02:03.000Z"),
    ).toThrowError(DomainError);
  });

  it("refuses a lease whose requested envelope is wider than attestation", () => {
    const machine = persistentMachine();
    expect(() =>
      acquireMachineLease(machine, {
        id: id<MachineLeaseId>("01K2H00000000000000000010C"),
        runId,
        expectedGeneration: 1,
        capabilitySetHash: hash("9"),
        mountSetHash: machine.mountSetHash,
        networkPolicyHash: machine.networkPolicyHash,
        effectivePolicyHash: machine.effectivePolicyHash,
        now: "2026-08-13T00:00:02.000Z",
        expiresAt: "2026-08-13T00:05:00.000Z",
      }),
    ).toThrowError(DomainError);
  });
});

describe("snapshot, drift, and persistent resume", () => {
  function suspendedMachineWithSnapshot() {
    const machine = transitionMachine(persistentMachine(), {
      to: "suspending",
      now: "2026-08-13T00:00:02.000Z",
    });
    const suspended = transitionMachine(machine, {
      to: "suspended",
      now: "2026-08-13T00:00:03.000Z",
    });
    const snapshot = createVerifiedMachineSnapshot(suspended, {
      id: id<MachineSnapshotId>("01K2H00000000000000000010D"),
      fileSystemStateHash: hash("5"),
      manifestHash: hash("6"),
      consistency: "production-checkpoint",
      excludedState: REQUIRED_SNAPSHOT_EXCLUSIONS,
      sizeBytes: 4_096,
      createdAt: "2026-08-13T00:00:04.000Z",
      verifiedAt: "2026-08-13T00:00:05.000Z",
    });
    return { snapshot, machine: attachMachineSnapshot(suspended, snapshot, "2026-08-13T00:00:06.000Z") };
  }

  it("requires snapshots to exclude every authority and live-session class", () => {
    const suspended = transitionMachine(
      transitionMachine(persistentMachine(), {
        to: "suspending",
        now: "2026-08-13T00:00:02.000Z",
      }),
      { to: "suspended", now: "2026-08-13T00:00:03.000Z" },
    );
    expect(() =>
      createVerifiedMachineSnapshot(suspended, {
        id: id<MachineSnapshotId>("01K2H00000000000000000010E"),
        fileSystemStateHash: hash("5"),
        manifestHash: hash("6"),
        consistency: "filesystem-consistent",
        excludedState: REQUIRED_SNAPSHOT_EXCLUSIONS.filter((value) => value !== "approvals"),
        sizeBytes: 1,
        createdAt: "2026-08-13T00:00:04.000Z",
        verifiedAt: "2026-08-13T00:00:05.000Z",
      }),
    ).toThrowError(DomainError);
  });

  it("resumes only an exact manifest and restores only a verified snapshot", () => {
    const { machine, snapshot } = suspendedMachineWithSnapshot();
    const manifest = {
      machineId: machine.id,
      machineGeneration: machine.generation,
      ownerScopeHash: machine.ownerScopeHash,
      templateHash: machine.templateHash,
      baseImageHash: machine.baseImageHash,
      runtimeAdapterHash: machine.runtimeAdapterHash,
      effectivePolicyHash: machine.effectivePolicyHash,
      capabilitySetHash: machine.capabilitySetHash,
      mountSetHash: machine.mountSetHash,
      networkPolicyHash: machine.networkPolicyHash,
      extensionSetHash: hash("7"),
      currentSnapshotId: snapshot.id,
      currentSnapshotManifestHash: snapshot.manifestHash,
      pendingOperationStatus: "none" as const,
      excludedState: REQUIRED_RESUME_EXCLUSIONS,
      journalCursor: 42,
      createdAt: "2026-08-13T00:00:06.000Z",
    };
    expect(
      evaluatePersistentMachineResume({
        manifest,
        machine,
        currentExtensionSetHash: hash("7"),
        snapshotVerified: true,
        currentSnapshotManifestHash: snapshot.manifestHash,
        journalCaughtUp: true,
        now: "2026-08-13T00:00:07.000Z",
      }),
    ).toEqual({ action: "restore", reasonCodes: ["verified-snapshot"] });

    expect(
      evaluatePersistentMachineResume({
        manifest: { ...manifest, pendingOperationStatus: "outcome-unknown" },
        machine,
        currentExtensionSetHash: hash("7"),
        snapshotVerified: true,
        currentSnapshotManifestHash: snapshot.manifestHash,
        journalCaughtUp: true,
        now: "2026-08-13T00:00:07.000Z",
      }),
    ).toMatchObject({ action: "blocked", reasonCodes: ["outcome-unknown"] });
  });

  it("quarantines critical drift and prevents future leases", () => {
    const machine = persistentMachine();
    const report = createMachineDriftReport(machine, {
      id: id("01K2H00000000000000000010F"),
      findings: [
        {
          kind: "secret-scan",
          severity: "critical",
          code: "ambient_secret_detected",
        },
      ],
      reportHash: hash("8"),
      observedAt: "2026-08-13T00:00:02.000Z",
    });
    const quarantined = applyMachineDriftReport(machine, report);
    expect(quarantined).toMatchObject({ lifecycle: "quarantined", driftStatus: "quarantine" });
    expect(() =>
      acquireMachineLease(quarantined, {
        id: id<MachineLeaseId>("01K2H00000000000000000010G"),
        runId,
        expectedGeneration: 1,
        capabilitySetHash: quarantined.capabilitySetHash,
        mountSetHash: quarantined.mountSetHash,
        networkPolicyHash: quarantined.networkPolicyHash,
        effectivePolicyHash: quarantined.effectivePolicyHash,
        now: "2026-08-13T00:00:03.000Z",
        expiresAt: "2026-08-13T00:05:00.000Z",
      }),
    ).toThrowError(DomainError);
  });

  it("re-evaluates drift instead of silently restoring temporary authority", () => {
    const machine = persistentMachine();
    const manifest = {
      machineId: machine.id,
      machineGeneration: machine.generation,
      ownerScopeHash: machine.ownerScopeHash,
      templateHash: machine.templateHash,
      baseImageHash: machine.baseImageHash,
      runtimeAdapterHash: machine.runtimeAdapterHash,
      effectivePolicyHash: machine.effectivePolicyHash,
      capabilitySetHash: machine.capabilitySetHash,
      mountSetHash: machine.mountSetHash,
      networkPolicyHash: machine.networkPolicyHash,
      extensionSetHash: hash("7"),
      pendingOperationStatus: "none" as const,
      excludedState: REQUIRED_RESUME_EXCLUSIONS.filter(
        (value) => value !== "temporary-approvals",
      ),
      journalCursor: 0,
      createdAt: now,
    };
    expect(() =>
      evaluatePersistentMachineResume({
        manifest,
        machine,
        currentExtensionSetHash: hash("7"),
        snapshotVerified: false,
        journalCaughtUp: true,
        now: "2026-08-13T00:00:02.000Z",
      }),
    ).toThrowError(DomainError);

    expect(
      evaluatePersistentMachineResume({
        manifest: { ...manifest, excludedState: REQUIRED_RESUME_EXCLUSIONS },
        machine: { ...machine, effectivePolicyHash: hash("9") },
        currentExtensionSetHash: hash("7"),
        snapshotVerified: false,
        journalCaughtUp: true,
        now: "2026-08-13T00:00:02.000Z",
      }),
    ).toMatchObject({ action: "blocked", reasonCodes: ["policy-drift"] });
  });
});
