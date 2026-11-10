import { describe, expect, it } from "vitest";

import {
  createMediaGenerationEndpointPlan,
  type CreateMediaGenerationEndpointPlanInput,
} from "./media-generation-endpoint";
import type { ProviderEndpointCapabilitySnapshot } from "./provider-endpoint-capability";

const hash = (character: string) => character.repeat(64);

function snapshot(overrides: Partial<ProviderEndpointCapabilitySnapshot> = {}): ProviderEndpointCapabilitySnapshot {
  return {
    schemaVersion: 1,
    snapshotId: "capability-images-1",
    providerProfileRevisionId: "provider-images-v1",
    adapterRevision: "omnia-images-adapter-v1",
    protocolFamily: "openai-responses",
    apiVersion: "2026-01",
    operations: ["responses", "images", "models"],
    transports: ["http"],
    authSchemes: ["bearer"],
    modalities: ["image", "text"],
    operationCapabilities: [
      {
        operation: "images",
        direction: "generation",
        modality: "image",
        supportLevel: "model-gated",
        modelScope: "model-snapshot",
        modelSelectors: ["image-model-1"],
        carrierFormats: ["content-block"],
        mimeFamilies: ["image"],
        fidelity: "semantic-and-visual",
        probeRequirement: "recommended",
        constraints: { maxWidth: 2048, maxHeight: 2048, maxItems: 4 },
        evidence: [{
          kind: "official-documentation",
          reference: "https://example.test/images",
          retrievedAt: "2026-10-01T00:00:00Z",
          contentHash: hash("e"),
          expiresAt: "2026-12-01T00:00:00Z",
        }],
      },
    ],
    parameterSchemaId: null,
    errorPolicyRevisionId: "errors-v1",
    freshness: "cached-fresh",
    createdAt: "2026-10-01T00:01:00Z",
    ...overrides,
  };
}

function input(overrides: Partial<CreateMediaGenerationEndpointPlanInput> = {}): CreateMediaGenerationEndpointPlanInput {
  return {
    schemaVersion: 1,
    now: "2026-10-20T00:00:00Z",
    requestId: "request-1",
    jobId: "job-1",
    modality: "image",
    operation: "text-to-image",
    promptRevisionId: "prompt-revision-1",
    promptSha256: hash("a"),
    inputArtifactIds: ["artifact-1"],
    parameters: { aspectRatio: "16:9", width: 1024, height: 1024, variantCount: 2 },
    modelId: "image-model-1",
    capabilitySnapshot: snapshot(),
    ...overrides,
  };
}

describe("media generation endpoint plan", () => {
  it("admits a native model-gated route while withholding provider bytes", () => {
    const plan = createMediaGenerationEndpointPlan(input());
    expect(plan.disposition).toBe("ready");
    expect(plan.reasons).toEqual(["provider-payload-withheld"]);
    expect(plan.capabilitySupportLevel).toBe("model-gated");
    expect(plan.capabilityEvidence[0]?.reference).toContain("/images");
    expect(plan.providerWirePayload).toBeNull();
    expect(plan.idempotencyKey).toContain("provider-images-v1");
    expect(plan.requestFingerprint).toHaveLength(64);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/prompt text|base64|file:\/\//i);
  });

  it("is deterministic across parameter key order", () => {
    const left = createMediaGenerationEndpointPlan(input());
    const right = createMediaGenerationEndpointPlan(input({ parameters: { variantCount: 2, height: 1024, width: 1024, aspectRatio: "16:9" } }));
    expect(right.requestFingerprint).toBe(left.requestFingerprint);
    expect(right.planId).toBe(left.planId);
  });

  it("blocks stale or adapter-gated capability evidence", () => {
    const stale = createMediaGenerationEndpointPlan(input({ capabilitySnapshot: snapshot({ freshness: "cached-stale" }) }));
    expect(stale.disposition).toBe("blocked");
    expect(stale.reasons).toContain("capability-stale");

    const gated = createMediaGenerationEndpointPlan(input({ capabilitySnapshot: snapshot({
      operationCapabilities: [{
        ...snapshot().operationCapabilities![0]!,
        supportLevel: "adapter-gated",
      }],
    }) }));
    expect(gated.disposition).toBe("blocked");
    expect(gated.reasons).toContain("capability-not-native");
  });

  it("rejects model and parameter mismatches without silently downgrading", () => {
    const unknownModel = createMediaGenerationEndpointPlan(input({ modelId: "other-model" }));
    expect(unknownModel.disposition).toBe("unsupported");
    expect(unknownModel.reasons).toContain("capability-not-found");

    const oversized = createMediaGenerationEndpointPlan(input({ parameters: { aspectRatio: "16:9", width: 4096, height: 1024 } }));
    expect(oversized.disposition).toBe("blocked");
    expect(oversized.reasons).toContain("constraint-exceeded");

    const wrongModality = createMediaGenerationEndpointPlan(input({ modality: "video", operation: "text-to-image" }));
    expect(wrongModality.disposition).toBe("unsupported");
    expect(wrongModality.reasons).toContain("unsupported-modality");
  });

  it("requires the prompt revision and hash boundary", () => {
    expect(() => createMediaGenerationEndpointPlan(input({ promptSha256: "not-a-hash" }))).toThrow(/SHA-256/i);
    expect(() => createMediaGenerationEndpointPlan(input({ negativePromptRevisionId: "negative-1" }))).toThrow(/supplied together/i);
  });
});
