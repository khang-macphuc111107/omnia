import { describe, expect, it } from "vitest";

import {
  createIntegrationRuntimeAdapter,
  deriveIntegrationExecutionRequirements,
  planIntegrationRuntime,
} from "./omnia-integration-runtime-adapter";
import type { IntegrationRegistration, IntegrationVersionManifest } from "./integration-registry";
import type { IntegrationId, IntegrationVersionId } from "./ids";

const id = <T extends string>(value: string) => value as T;
const digest = "a".repeat(64);
const now = "2026-10-17T00:00:00.000Z";

function manifest(overrides: Partial<IntegrationVersionManifest> = {}): IntegrationVersionManifest {
  return {
    schemaVersion: 1,
    id: id<IntegrationVersionId>("01K2H000000000000000000001"),
    integrationId: id<IntegrationId>("01K2H000000000000000000002"),
    canonicalName: "acme.workspace-tool",
    displayName: "Acme Workspace Tool",
    version: "1.0.0",
    kind: "tool",
    origin: "local",
    transport: "in-process",
    manifestHash: digest,
    contentHash: digest,
    implementationHash: digest,
    schemaHash: digest,
    dependencyHash: digest,
    effectSetHash: digest,
    destinationSetHash: digest,
    requiredCapabilities: ["read_workspace"],
    effects: ["workspace-read"],
    destinations: ["workspace://active"],
    dataClasses: ["standard"],
    supportedEnvironments: ["isolated"],
    dependencies: [],
    limits: { maximumInputBytes: 1000, maximumOutputBytes: 1000, defaultTimeoutMs: 1000 },
    registeredAt: now,
    ...overrides,
  };
}

function enabledRegistration(input: IntegrationVersionManifest): IntegrationRegistration {
  return {
    manifest: input,
    lifecycle: "enabled",
    trust: {
      state: "trusted",
      digest: {
        manifestHash: input.manifestHash,
        contentHash: input.contentHash,
        implementationHash: input.implementationHash,
        schemaHash: input.schemaHash,
        dependencyHash: input.dependencyHash,
        effectSetHash: input.effectSetHash,
        destinationSetHash: input.destinationSetHash,
      },
    },
    discoveredAt: now,
  };
}

const policy = {
  availability: { persistent: true, isolated: true, remote: false },
  defaultLocalMode: "isolated" as const,
  allowedRemoteDestinations: [],
  policyVersionHash: digest,
};

describe("integration runtime adapter", () => {
  it("translates manifest authority without widening it", () => {
    const registration = enabledRegistration(manifest());
    const requirements = deriveIntegrationExecutionRequirements(registration);

    expect(requirements.requiredCapabilities).toEqual(["read_workspace"]);
    expect(requirements.requiresExecution).toBe(true);
    expect(requirements.requiresHostIntegration).toBe(true);
    expect(requirements.runsUnknownCode).toBe(true);
    expect(requirements.supportedEnvironments).toEqual(["isolated"]);
  });

  it("keeps instruction-only skills environment-free", () => {
    const skill = manifest({
      canonicalName: "acme.instructions",
      kind: "skill",
      origin: "built-in",
      requiredCapabilities: [],
      effects: [],
      destinations: [],
    });
    const registry = { version: 1 as const, integrations: [enabledRegistration(skill)] };
    const plan = planIntegrationRuntime({
      registry,
      integrationVersionId: skill.id,
      policy,
      now,
    });

    expect(plan.controllerPlan.selection.selectedMode).toBe("none");
    expect(plan.controllerPlan.machineEnvelope).toBeUndefined();
  });

  it("provides a stable injectable adapter facade", () => {
    const adapter = createIntegrationRuntimeAdapter();
    expect(adapter.version).toBe(1);
    expect(adapter.plan).toBe(planIntegrationRuntime);
  });
});

