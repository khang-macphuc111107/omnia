import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  bridgeModalityForMediaType,
  createMultimodalBridgePlan,
  type BridgeCapabilitySnapshot,
  type BridgePolicy,
  type BridgeSourceArtifact,
  type CreateMultimodalBridgePlanInput,
} from "./multimodal-bridge";

const hash = (character: string) => character.repeat(64);

function artifact(overrides: Partial<BridgeSourceArtifact> = {}): BridgeSourceArtifact {
  return {
    artifactId: "attachment-image-1",
    filename: "diagram.png",
    mediaType: "image/png",
    modality: "image",
    byteSize: 4_096,
    contentSha256: hash("a"),
    sourceSelector: "region:page=1;x=0;y=0;width=640;height=480",
    dataClasses: ["standard", "user-file"],
    ...overrides,
  };
}

function capabilitySnapshot(overrides: Partial<BridgeCapabilitySnapshot> = {}): BridgeCapabilitySnapshot {
  return {
    snapshotId: "capability-snapshot-1",
    providerProfileRevisionId: "provider-revision-1",
    operationId: "responses",
    modelProfileRevisionId: "model-revision-1",
    apiVersion: "2026-01",
    observedAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-08-16T00:00:00.000Z",
    freshness: "live-probe",
    claims: [
      {
        modality: "image",
        supportLevel: "documented-native",
        modelScope: "model-snapshot",
        modelSelectors: ["model-revision-1"],
        allowedMediaTypes: ["image/png", "image/jpeg"],
        maxBytes: 8 * 1024 * 1024,
        fidelity: "semantic-and-visual",
        evidenceIds: ["probe-image-1"],
      },
    ],
    ...overrides,
  };
}

function policy(overrides: Partial<BridgePolicy> = {}): BridgePolicy {
  return {
    revisionId: "policy-1",
    dataBoundary: "approved-provider",
    egressDecision: "approved",
    allowedDataClasses: ["standard", "user-file"],
    allowLocalTransforms: true,
    allowSpecialistBridge: true,
    allowHybridVerification: true,
    allowSurrogateToPrimary: true,
    allowHumanReview: true,
    localTransformFidelity: "semantic-and-visual",
    approvalReceiptId: "approval-1",
    ...overrides,
  };
}

function input(overrides: Partial<CreateMultimodalBridgePlanInput> = {}): CreateMultimodalBridgePlanInput {
  return {
    schemaVersion: 1,
    requestedMode: "auto",
    artifacts: [artifact()],
    capabilitySnapshot: capabilitySnapshot(),
    policy: policy(),
    fidelity: {
      decisiveDimensions: ["content", "layout", "provenance"],
      allowDegradation: false,
      requireHumanReviewOnAmbiguity: false,
    },
    sourceManifestDigest: hash("b"),
    now: "2026-08-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("multimodal bridge planner", () => {
  it.each([
    ["image/png", "image"],
    ["audio/ogg", "audio"],
    ["video/mp4", "video"],
    ["application/pdf", "pdf"],
    ["text/plain", "document"],
    ["text/csv", "spreadsheet"],
    ["application/zip", "archive"],
    ["text/x-rust", "code"],
    ["application/json", "structured-data"],
    ["application/x-hdf5", "scientific-artifact"],
  ] as const)("maps trusted MIME %s to %s", (mediaType, modality) => {
    expect(bridgeModalityForMediaType(mediaType)).toBe(modality);
  });

  it("rejects a canonical MIME value that has no trusted modality mapping", () => {
    expect(bridgeModalityForMediaType("application/octet-stream")).toBeNull();
    expect(() =>
      createMultimodalBridgePlan(
        input({
          artifacts: [
            artifact({
              mediaType: "application/octet-stream",
              modality: "document",
            }),
          ],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("rejects a caller modality that disagrees with the trusted MIME mapping", () => {
    expect(() =>
      createMultimodalBridgePlan(
        input({
          artifacts: [artifact({ modality: "document" })],
        }),
      ),
    ).toThrowError(DomainError);
  });

  it.each(["image/png; charset=utf-8", "IMAGE/PNG", " image/png"]) (
    "rejects non-canonical capability MIME %s instead of silently normalizing it",
    (allowedMediaType) => {
      expect(() =>
        createMultimodalBridgePlan(
          input({
            capabilitySnapshot: capabilitySnapshot({
              claims: [
                {
                  ...capabilitySnapshot().claims[0]!,
                  allowedMediaTypes: [allowedMediaType],
                },
              ],
            }),
          }),
        ),
      ).toThrowError(DomainError);
    },
  );

  it("selects direct-native only for an exact fresh operation/model/MIME capability", () => {
    const plan = createMultimodalBridgePlan(input());

    expect(plan.resolvedMode).toBe("direct-native");
    expect(plan.disposition).toBe("ready");
    expect(plan.selectedReasonCodes).toEqual([
      "native-capability-exact-match",
      "provider-egress-approved",
    ]);
    expect(plan.stages.map((stage) => stage.kind)).toEqual(["admit", "direct-deliver"]);
    expect(plan.providerWirePayload).toBeNull();
    expect(JSON.stringify(plan)).not.toMatch(/base64|file:\/\/|[A-Z]:\\/i);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.sourceArtifacts)).toBe(true);
  });

  it("uses an isolated local transform when native capability is absent and egress is denied", () => {
    const plan = createMultimodalBridgePlan(
      input({
        capabilitySnapshot: capabilitySnapshot({
          claims: [
            {
              ...capabilitySnapshot().claims[0]!,
              supportLevel: "unsupported",
            },
          ],
        }),
        policy: policy({
          dataBoundary: "local-only",
          egressDecision: "denied",
          allowSpecialistBridge: false,
          allowHybridVerification: false,
          allowSurrogateToPrimary: false,
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("local-transform");
    expect(plan.dataBoundary).toBe("local-only");
    expect(plan.egressDecision).toBe("not-required");
    expect(plan.stages.every((stage) => stage.boundary === "local-only")).toBe(true);
  });

  it("never treats a not-required decision as an implicit provider-egress grant", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "direct-only",
        policy: policy({
          dataBoundary: "approved-provider",
          egressDecision: "not-required",
          approvalReceiptId: null,
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("unsupported");
    expect(
      plan.rejectedAlternatives.find((item) => item.mode === "direct-native")?.reasonCodes,
    ).toContain("provider-egress-not-approved");
  });

  it("can choose a specialist bridge without claiming target-native support", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "specialist-bridge-model",
        capabilitySnapshot: capabilitySnapshot({
          claims: [
            {
              ...capabilitySnapshot().claims[0]!,
              supportLevel: "bridge-required",
            },
          ],
          specialistBridge: {
            providerProfileRevisionId: "bridge-provider-1",
            operationId: "vision-describe",
            modelProfileRevisionId: "vision-model-1",
            apiVersion: "2026-01",
            supportedModalities: ["image"],
            fidelity: "semantic-and-visual",
            evidenceIds: ["bridge-probe-1"],
          },
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("specialist-bridge-model");
    expect(plan.selectedReasonCodes).toContain("specialist-bridge-approved");
    expect(plan.stages.map((stage) => stage.kind)).toEqual(["admit", "specialist-bridge"]);
    expect(plan.modelProfileRevisionId).toBe("model-revision-1");
  });

  it("rejects a specialist bridge with no capability evidence", () => {
    expect(() =>
      createMultimodalBridgePlan(
        input({
          requestedMode: "specialist-bridge-model",
          capabilitySnapshot: capabilitySnapshot({
            specialistBridge: {
              providerProfileRevisionId: "bridge-provider-1",
              operationId: "vision-describe",
              modelProfileRevisionId: "vision-model-1",
              apiVersion: "2026-01",
              supportedModalities: ["image"],
              fidelity: "semantic-and-visual",
              evidenceIds: [],
            },
          }),
        }),
      ),
    ).toThrowError(DomainError);
  });

  it("does not dispatch through a specialist route using a stale capability snapshot", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "specialist-bridge-model",
        capabilitySnapshot: capabilitySnapshot({
          freshness: "cached-stale",
          specialistBridge: {
            providerProfileRevisionId: "bridge-provider-1",
            operationId: "vision-describe",
            modelProfileRevisionId: "vision-model-1",
            apiVersion: "2026-01",
            supportedModalities: ["image"],
            fidelity: "semantic-and-visual",
            evidenceIds: ["bridge-probe-1"],
          },
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("unsupported");
    expect(
      plan.rejectedAlternatives.find((item) => item.mode === "specialist-bridge-model")
        ?.reasonCodes,
    ).toContain("native-capability-stale");
  });

  it("uses hybrid verification when both local and specialist routes are authorized", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "hybrid-ensemble",
        capabilitySnapshot: capabilitySnapshot({
          claims: [
            {
              ...capabilitySnapshot().claims[0]!,
              supportLevel: "bridge-required",
            },
          ],
          specialistBridge: {
            providerProfileRevisionId: "bridge-provider-1",
            operationId: "vision-describe",
            modelProfileRevisionId: "vision-model-1",
            apiVersion: "2026-01",
            supportedModalities: ["image"],
            fidelity: "semantic-and-visual",
            evidenceIds: ["bridge-probe-1"],
          },
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("hybrid-ensemble");
    expect(plan.stages.map((stage) => stage.kind)).toEqual(["admit", "local-transform", "hybrid-verify"]);
  });

  it("makes surrogate delivery to the primary model explicit and reconcilable", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "surrogate-to-primary",
        capabilitySnapshot: capabilitySnapshot({
          claims: [
            {
              ...capabilitySnapshot().claims[0]!,
              supportLevel: "bridge-required",
            },
          ],
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("surrogate-to-primary");
    expect(plan.stages.map((stage) => stage.kind)).toEqual([
      "admit",
      "local-transform",
      "surrogate-package",
      "primary-deliver",
    ]);
    expect(plan.stages.at(-1)).toMatchObject({
      boundary: "approved-provider",
      cancellationBoundary: "reconcile-required",
    });
  });

  it("returns truthful unsupported when stale capability and every fallback is disallowed", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "direct-only",
        capabilitySnapshot: capabilitySnapshot({
          freshness: "cached-stale",
        }),
        policy: policy({
          allowLocalTransforms: false,
          allowSpecialistBridge: false,
          allowHybridVerification: false,
          allowSurrogateToPrimary: false,
          allowHumanReview: false,
        }),
      }),
    );

    expect(plan.resolvedMode).toBe("unsupported");
    expect(plan.disposition).toBe("unsupported");
    expect(plan.selectedReasonCodes).toContain("policy-denies-all-routes");
    expect(plan.rejectedAlternatives.find((item) => item.mode === "direct-native")?.reasonCodes).toContain("native-capability-stale");
  });

  it("rejects provider routes when a data class is not approved", () => {
    const plan = createMultimodalBridgePlan(
      input({
        requestedMode: "direct-native",
        policy: policy({ allowedDataClasses: ["standard"] }),
      }),
    );

    expect(plan.resolvedMode).toBe("unsupported");
    expect(plan.egressDecision).toBe("not-required");
    expect(plan.rejectedAlternatives.find((item) => item.mode === "direct-native")?.reasonCodes).toContain("data-class-not-approved");
  });

  it("keeps source selector and hash provenance while rejecting filesystem locations", () => {
    const plan = createMultimodalBridgePlan(input());
    expect(plan.sourceArtifacts[0]).toMatchObject({
      artifactId: "attachment-image-1",
      contentSha256: hash("a"),
      sourceSelector: "region:page=1;x=0;y=0;width=640;height=480",
    });

    expect(() =>
      createMultimodalBridgePlan(
        input({ artifacts: [artifact({ sourceSelector: "C:\\Users\\khang\\secret.pdf" })] }),
      ),
    ).toThrowError(DomainError);
  });

  it("keeps derived content boundary explicit and never grants instructions", () => {
    const plan = createMultimodalBridgePlan(input({ requestedMode: "local-transform" }));
    expect(plan.untrustedDataTreatment).toBe("data-not-control");
    expect(plan.stages.every((stage) => stage.outputIsUntrustedData)).toBe(true);
  });
});
