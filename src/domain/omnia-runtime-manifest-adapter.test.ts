import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import type { ExecutionEnvironment } from "./execution";
import type { MachineInstance, PersistentMachineResumeManifest } from "./machine-runtime";
import {
  createRuntimeAdapterManifest,
  deserializeRuntimeAdapterManifest,
  evaluateRuntimeAdapterCompatibility,
  serializeRuntimeAdapterManifest,
  type RuntimeAdapterManifest,
  type RuntimeAdapterManifestId,
} from "./omnia-runtime-manifest-adapter";

const hash = (character: string) => character.repeat(64);
const id = "runtime-adapter.hyper-v-vm.v1" as RuntimeAdapterManifestId;
const now = "2026-10-17T00:00:00.000Z";

function manifestInput(): RuntimeAdapterManifest {
  return {
    schemaVersion: 1,
    id,
    canonicalName: "hyper-v-vm",
    displayName: "Hyper-V VM runtime adapter",
    version: "1.0.0",
    status: "verified",
    providerKind: "hyper-v-vm",
    securityBoundary: "hypervisor-vm",
    platform: {
      os: "windows",
      architectures: ["x64"],
      translationVersion: "windows-11.0",
      translationHash: hash("a"),
    },
    supportedModes: ["isolated", "persistent"],
    modeSupport: [
      {
        mode: "persistent",
        capabilities: ["pure_compute", "read_workspace", "write_workspace", "use_network"],
        mountSources: ["temporary", "workspace-grant"],
        networkModes: ["offline", "allowlist"],
        persistenceKinds: ["resume", "snapshot"],
        resourceLimits: {
          maximumWallClockMs: 10_000,
          maximumCpuTimeMs: 9_000,
          maximumMemoryBytes: 4_000,
          maximumStorageBytes: 8_000,
          maximumNetworkBytes: 7_000,
          maximumProcessCount: 8,
        },
      },
      {
        mode: "isolated",
        capabilities: ["pure_compute"],
        mountSources: ["temporary"],
        networkModes: ["offline"],
        persistenceKinds: ["ephemeral"],
        resourceLimits: {},
      },
    ],
    runtimeAdapterHash: hash("b"),
    manifestHash: hash("c"),
    conformanceSuiteVersion: "1.0.0",
    conformanceSuiteHash: hash("d"),
    evidence: [
      {
        kind: "signed-package",
        reference: "package://hyper-v-vm/1.0.0",
        contentHash: hash("e"),
        observedAt: now,
      },
      {
        kind: "conformance-suite",
        reference: "suite://hyper-v-vm/1.0.0",
        contentHash: hash("f"),
        observedAt: now,
      },
      {
        kind: "platform-probe",
        reference: "probe://windows/x64",
        contentHash: hash("1"),
        observedAt: now,
      },
    ],
    registeredAt: now,
  };
}

function environment(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return {
    id: "01K8J000000000000000000001" as ExecutionEnvironment["id"],
    requestedMode: "persistent",
    mode: "persistent",
    lifecycle: "ready",
    trustBoundary: "trusted-local-host",
    enabledCapabilities: ["pure_compute", "read_workspace"],
    mounts: [
      {
        handle: "mount:workspace",
        displayName: "Workspace",
        source: "workspace-grant",
        permissions: { read: true, write: false, execute: false },
      },
    ],
    networkPolicy: {
      mode: "offline",
      allowedDestinations: [],
      allowInbound: false,
    },
    resourceBudget: {
      wallClockMs: 100,
      cpuTimeMs: 100,
      memoryBytes: 100,
      storageBytes: 100,
      networkBytes: 0,
      processCount: 1,
    },
    persistencePolicy: {
      kind: "resume",
      snapshotOnSuspend: false,
      maximumSnapshotCount: 0,
    },
    selectionReasonCodes: ["explicit-mode"],
    policyVersionHash: hash("2"),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function machine(overrides: Partial<MachineInstance> = {}): MachineInstance {
  return {
    id: "01K8J000000000000000000002" as MachineInstance["id"],
    environmentId: "01K8J000000000000000000001" as MachineInstance["environmentId"],
    providerKind: "hyper-v-vm",
    mode: "persistent",
    ownerScope: {
      kind: "project",
      profileId: "01K8J000000000000000000003" as never,
      projectId: "01K8J000000000000000000004" as never,
    },
    ownerScopeHash: hash("3"),
    lifecycle: "ready",
    generation: 1,
    templateHash: hash("4"),
    baseImageHash: hash("5"),
    runtimeAdapterHash: hash("b"),
    effectivePolicyHash: hash("6"),
    capabilitySetHash: hash("7"),
    mountSetHash: hash("8"),
    networkPolicyHash: hash("9"),
    attestationId: "01K8J000000000000000000005" as MachineInstance["attestationId"],
    attestationExpiresAt: "2026-10-18T00:00:00.000Z",
    driftStatus: "clean",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function resumeManifest(overrides: Partial<PersistentMachineResumeManifest> = {}): PersistentMachineResumeManifest {
  return {
    machineId: machine().id,
    machineGeneration: 1,
    ownerScopeHash: hash("3"),
    templateHash: hash("4"),
    baseImageHash: hash("5"),
    runtimeAdapterHash: hash("b"),
    effectivePolicyHash: hash("6"),
    capabilitySetHash: hash("7"),
    mountSetHash: hash("8"),
    networkPolicyHash: hash("9"),
    extensionSetHash: hash("a"),
    pendingOperationStatus: "none",
    excludedState: [
      "temporary-approvals",
      "temporary-grants",
      "administrator-state",
      "raw-secrets",
      "browser-sessions",
      "network-sessions",
      "processes",
    ],
    journalCursor: 0,
    createdAt: now,
    ...overrides,
  };
}

describe("runtime adapter manifest contract", () => {
  it("normalizes, sorts, and freezes a verified manifest", () => {
    const manifest = createRuntimeAdapterManifest(manifestInput());

    expect(manifest.supportedModes).toEqual(["isolated", "persistent"]);
    expect(manifest.modeSupport.map((entry) => entry.mode)).toEqual(["isolated", "persistent"]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.platform)).toBe(true);
    expect(Object.isFrozen(manifest.modeSupport[0])).toBe(true);
    expect(Object.isFrozen(manifest.evidence)).toBe(true);
  });

  it("rejects provider, boundary, and mode combinations outside the machine contract", () => {
    expect(() =>
      createRuntimeAdapterManifest({
        ...manifestInput(),
        providerKind: "windows-sandbox",
        securityBoundary: "windows-sandbox",
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createRuntimeAdapterManifest({
        ...manifestInput(),
        supportedModes: ["remote"],
        modeSupport: [
          {
            mode: "remote",
            capabilities: ["pure_compute"],
            mountSources: ["temporary"],
            networkModes: ["offline"],
            persistenceKinds: ["ephemeral"],
            resourceLimits: {},
          },
        ],
      }),
    ).toThrowError(DomainError);
  });

  it("returns compatible only when every supplied boundary agrees", () => {
    const manifest = createRuntimeAdapterManifest(manifestInput());
    expect(
      evaluateRuntimeAdapterCompatibility({
        manifest,
        environment: environment(),
        machine: machine(),
        resumeManifest: resumeManifest(),
        now,
      }),
    ).toEqual({
      compatible: true,
      adapterManifestId: id,
      runtimeAdapterHash: hash("b"),
      reasonCodes: [],
    });

    expect(
      evaluateRuntimeAdapterCompatibility({
        manifest,
        environment: environment({ enabledCapabilities: ["pure_compute", "execute_process"] }),
        machine: machine({ runtimeAdapterHash: hash("c"), driftStatus: "quarantine" }),
        resumeManifest: resumeManifest({ runtimeAdapterHash: hash("c") }),
        now,
      }).reasonCodes,
    ).toEqual([
      "capability-unsupported",
      "runtime-adapter-hash-mismatch",
      "machine-drifted",
      "resume-runtime-drift",
    ]);
  });

  it("fails closed on budgets, attestation expiry, and unknown JSON fields", () => {
    const manifest = createRuntimeAdapterManifest(manifestInput());
    expect(
      evaluateRuntimeAdapterCompatibility({
        manifest,
        environment: environment({
          resourceBudget: {
            wallClockMs: 20_000,
            cpuTimeMs: 100,
            memoryBytes: 100,
            storageBytes: 100,
            networkBytes: 0,
            processCount: 1,
          },
        }),
        machine: machine({ attestationExpiresAt: "2026-10-16T00:00:00.000Z" }),
        now,
      }).reasonCodes,
    ).toEqual(["resource-budget-exceeded", "machine-attestation-expired"]);

    const serialized = JSON.parse(serializeRuntimeAdapterManifest(manifest)) as Record<string, unknown>;
    serialized.unexpected = true;
    expect(() => deserializeRuntimeAdapterManifest(serialized)).toThrowError(DomainError);
  });
});
