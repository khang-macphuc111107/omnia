import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  blockIntegrationVersion,
  createIntegrationRegistry,
  disableIntegrationVersion,
  enableIntegrationVersion,
  getIntegrationVersion,
  installIntegrationVersion,
  invalidateIntegrationTrust,
  isIntegrationTrustCurrent,
  registerIntegrationVersion,
  replaceIntegrationVersion,
  resolveIntegrationVersion,
  trustIntegrationVersion,
  type IntegrationVersionManifest,
} from "./integration-registry";
import type { IntegrationId, IntegrationVersionId } from "./ids";

const id = <T extends string>(value: string) => value as T;
const now = "2026-10-17T00:00:00.000Z";
const later = "2026-10-17T00:01:00.000Z";
const digest = "a".repeat(64);

function manifest(overrides: Partial<IntegrationVersionManifest> = {}): IntegrationVersionManifest {
  return {
    schemaVersion: 1,
    id: id<IntegrationVersionId>("01K2H000000000000000000001"),
    integrationId: id<IntegrationId>("01K2H000000000000000000002"),
    canonicalName: "acme.markdown-tools",
    displayName: "Acme Markdown Tools",
    version: "1.0.0",
    kind: "formatter",
    origin: "local",
    transport: "in-process",
    manifestHash: digest,
    contentHash: digest,
    implementationHash: digest,
    schemaHash: digest,
    dependencyHash: digest,
    effectSetHash: digest,
    destinationSetHash: digest,
    requiredCapabilities: ["read_workspace", "write_workspace"],
    effects: ["workspace-read", "workspace-write"],
    destinations: ["workspace://active"],
    dataClasses: ["standard"],
    supportedEnvironments: ["isolated"],
    dependencies: [],
    limits: {
      maximumInputBytes: 10_000,
      maximumOutputBytes: 20_000,
      defaultTimeoutMs: 5_000,
    },
    registeredAt: now,
    ...overrides,
  };
}

describe("integration registry", () => {
  it("registers metadata as discovered and keeps it immutable", () => {
    const registry = registerIntegrationVersion(
      createIntegrationRegistry(),
      manifest(),
    );
    const entry = getIntegrationVersion(
      registry,
      id<IntegrationVersionId>("01K2H000000000000000000001"),
    );

    expect(entry.lifecycle).toBe("discovered");
    expect(entry.trust.state).toBe("untrusted");
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.integrations)).toBe(true);
    expect(Object.isFrozen(entry.manifest)).toBe(true);
    expect(Object.isFrozen(entry.trust.digest)).toBe(true);
    expect(() => resolveIntegrationVersion(registry, entry.manifest.id)).toThrowError(DomainError);
  });

  it("keeps install, trust, enable, and resolve as separate gates", () => {
    const versionId = id<IntegrationVersionId>("01K2H000000000000000000001");
    let registry = registerIntegrationVersion(createIntegrationRegistry(), manifest());

    expect(() => enableIntegrationVersion(registry, versionId, later)).toThrowError(DomainError);
    registry = installIntegrationVersion(registry, versionId, later);
    expect(getIntegrationVersion(registry, versionId).lifecycle).toBe("installed");
    expect(() => enableIntegrationVersion(registry, versionId, later)).toThrowError(DomainError);

    registry = trustIntegrationVersion(registry, versionId, {
      reviewedAt: later,
      reviewedBy: "user",
      reason: "Reviewed the package and declared workspace effects.",
    });
    expect(isIntegrationTrustCurrent(registry, versionId)).toBe(true);
    registry = enableIntegrationVersion(registry, versionId, later);
    expect(resolveIntegrationVersion(registry, versionId).lifecycle).toBe("enabled");
  });

  it("invalidates trust when a digest or declaration changes", () => {
    const versionId = id<IntegrationVersionId>("01K2H000000000000000000001");
    let registry = registerIntegrationVersion(createIntegrationRegistry(), manifest());
    registry = installIntegrationVersion(registry, versionId, later);
    registry = trustIntegrationVersion(registry, versionId, later);
    registry = enableIntegrationVersion(registry, versionId, later);

    const changed = manifest({
      implementationHash: "b".repeat(64),
      registeredAt: later,
    });
    registry = replaceIntegrationVersion(registry, changed);
    expect(getIntegrationVersion(registry, versionId).lifecycle).toBe("discovered");
    expect(getIntegrationVersion(registry, versionId).trust.state).toBe("untrusted");
    expect(isIntegrationTrustCurrent(registry, versionId)).toBe(false);

    registry = installIntegrationVersion(registry, versionId, later);
    registry = trustIntegrationVersion(registry, versionId, later);
    registry = enableIntegrationVersion(registry, versionId, later);
    registry = invalidateIntegrationTrust(registry, versionId, later, "Binary changed after review.");
    expect(getIntegrationVersion(registry, versionId).lifecycle).toBe("disabled");
    expect(getIntegrationVersion(registry, versionId).trust.state).toBe("stale");
    expect(() => resolveIntegrationVersion(registry, versionId)).toThrowError(DomainError);
  });

  it("rejects executable authority on skills and mismatched effect declarations", () => {
    expect(() =>
      registerIntegrationVersion(
        createIntegrationRegistry(),
        manifest({
           kind: "skill",
          requiredCapabilities: ["read_workspace"],
          effects: [],
          destinations: [],
        }),
      ),
    ).toThrowError(DomainError);

    expect(() =>
      registerIntegrationVersion(
        createIntegrationRegistry(),
        manifest({
          requiredCapabilities: ["read_workspace"],
          effects: ["workspace-write"],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("rejects duplicate identities and blocks require an explicit reason", () => {
    const versionId = id<IntegrationVersionId>("01K2H000000000000000000001");
    const first = registerIntegrationVersion(createIntegrationRegistry(), manifest());
    expect(() => registerIntegrationVersion(first, manifest())).toThrowError(DomainError);
    expect(() => blockIntegrationVersion(first, versionId, later, "")).toThrowError(DomainError);

    const installed = installIntegrationVersion(first, versionId, later);
    const blocked = blockIntegrationVersion(installed, versionId, later, "Package verification failed.");
    expect(getIntegrationVersion(blocked, versionId).lifecycle).toBe("blocked");
    expect(() => enableIntegrationVersion(blocked, versionId, later)).toThrowError(DomainError);
  });

  it("allows disabling an enabled version without pretending it is untrusted", () => {
    const versionId = id<IntegrationVersionId>("01K2H000000000000000000001");
    let registry = registerIntegrationVersion(createIntegrationRegistry(), manifest());
    registry = installIntegrationVersion(registry, versionId, later);
    registry = trustIntegrationVersion(registry, versionId, later);
    registry = enableIntegrationVersion(registry, versionId, later);
    registry = disableIntegrationVersion(registry, versionId, later);
    expect(getIntegrationVersion(registry, versionId).lifecycle).toBe("disabled");
    expect(isIntegrationTrustCurrent(registry, versionId)).toBe(true);
  });
});
