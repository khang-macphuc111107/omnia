import { describe, expect, it } from "vitest";

import {
  findProviderCapabilityMatch,
  isNativeProviderCapability,
  validateProviderEndpointCapabilitySnapshot,
  type ProviderEndpointCapabilitySnapshot,
} from "./provider-endpoint-capability";

const evidence = {
  kind: "official-documentation" as const,
  reference: "https://example.test/docs/responses",
  retrievedAt: "2026-10-01T00:00:00Z",
  contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expiresAt: "2026-12-01T00:00:00Z",
};

function snapshot(overrides: Partial<ProviderEndpointCapabilitySnapshot> = {}): ProviderEndpointCapabilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: "capability_01",
    providerProfileRevisionId: "provider_revision_01",
    adapterRevision: "omnia-adapter-v1",
    protocolFamily: "openai-responses",
    apiVersion: "v1",
    baseUrlHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    operations: ["responses", "models"],
    transports: ["http", "sse"],
    authSchemes: ["bearer"],
    modalities: ["text", "tool"],
    operationCapabilities: [
      {
        operation: "responses",
        direction: "generation",
        modality: "text",
        supportLevel: "documented-native",
        modelScope: "model-snapshot",
        modelSelectors: ["gpt-5"],
        carrierFormats: ["content-block"],
        mimeFamilies: ["text"],
        fidelity: "semantic-only",
        probeRequirement: "recommended",
        evidence: [evidence],
      },
    ],
    parameterSchemaId: null,
    errorPolicyRevisionId: "errors-v1",
    usageAuthority: "provider-final",
    freshness: "cached-fresh",
    createdAt: "2026-10-01T00:01:00Z",
    ...overrides,
  };
}

function capability(): NonNullable<ProviderEndpointCapabilitySnapshot["operationCapabilities"]>[number] {
  const value = snapshot().operationCapabilities?.[0];
  if (!value) throw new Error("test fixture capability is missing");
  return value;
}

describe("provider endpoint capability contract", () => {
  it("validates and deeply freezes an operation-scoped snapshot", () => {
    const validated = validateProviderEndpointCapabilitySnapshot(snapshot());
    expect(validated.protocolFamily).toBe("openai-responses");
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.operationCapabilities)).toBe(true);
    expect(findProviderCapabilityMatch(validated, {
      operation: "responses",
      modality: "text",
      modelId: "gpt-5",
      carrierFormat: "content-block",
      mimeFamily: "text",
    })?.supportLevel).toBe("documented-native");
    expect(isNativeProviderCapability(findProviderCapabilityMatch(validated, {
      operation: "responses",
      modelId: "gpt-5",
    }))).toBe(true);
  });

  it("requires the protocol's native operation and operation-scoped claims", () => {
    expect(() => validateProviderEndpointCapabilitySnapshot(snapshot({ operations: ["models"] }))).toThrow(/native operation/);
    expect(() => validateProviderEndpointCapabilitySnapshot(snapshot({
      operationCapabilities: [{
        ...capability(),
        operation: "video",
      }],
    }))).toThrow(/declared by its endpoint snapshot/);
  });

  it("rejects model-scoped claims without selectors and duplicate capability keys", () => {
    const withoutSelector = {
      ...capability(),
      modelSelectors: [],
    };
    expect(() => validateProviderEndpointCapabilitySnapshot(snapshot({ operationCapabilities: [withoutSelector] }))).toThrow(/Model-scoped/);

    const claim = snapshot().operationCapabilities?.[0];
    expect(() => validateProviderEndpointCapabilitySnapshot(snapshot({ operationCapabilities: [claim!, claim!] }))).toThrow(/must be unique/);
  });

  it("rejects malformed evidence and preserves adapter-gated claims as non-native", () => {
    const malformed = {
      ...capability(),
      evidence: [{ ...evidence, contentHash: "not-a-sha" }],
    };
    expect(() => validateProviderEndpointCapabilitySnapshot(snapshot({ operationCapabilities: [malformed] }))).toThrow(/SHA-256/);

    const adapterGated = validateProviderEndpointCapabilitySnapshot(snapshot({
      operationCapabilities: [{
        ...capability(),
        supportLevel: "adapter-gated",
      }],
    }));
    expect(isNativeProviderCapability(adapterGated.operationCapabilities?.[0] ?? null)).toBe(false);
  });
});
