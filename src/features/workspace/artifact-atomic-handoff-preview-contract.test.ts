import { describe, expect, it } from "vitest";

import {
  buildArtifactAtomicIdempotencyKey,
  createArtifactAtomicHandoffPreview,
  evaluateArtifactAtomicHandoffPreflight,
  fingerprintArtifactAtomicIntent,
  serializeArtifactAtomicHandoffPreview,
} from "./artifact-atomic-handoff-preview-contract";

const target = {
  kind: "chat-message" as const,
  projectId: "project-omnia",
  targetId: "message-preview",
  conversationId: "conversation-preview",
  branchId: "branch-main",
  modelProfileRevisionId: "",
};

describe("artifact atomic handoff preview contract", () => {
  it("freezes one source revision and stable retry identity", () => {
    const operation = createArtifactAtomicHandoffPreview({
      artifactId: "artifact-1",
      revision: 3,
      target,
      now: 1_000,
    });

    expect(operation).toMatchObject({
      schema: "omnia.artifact-atomic-handoff.preview.v1",
      operationType: "artifact.bind-to-target",
      sourceArtifactIds: ["artifact-1"],
      sourceRevision: 3,
      phase: "ready",
      outcome: "pending",
    });
    expect(operation.idempotencyKey).toBe(buildArtifactAtomicIdempotencyKey({ artifactId: "artifact-1", revision: 3, target }));
    expect(operation.operationId).toMatch(/^artifact-bind-op-/);
    expect(operation.boundary).toMatch(/no native artifact bind/i);
  });

  it("changes the key when source revision or destination changes", () => {
    const base = buildArtifactAtomicIdempotencyKey({ artifactId: "artifact-1", revision: 3, target });
    expect(buildArtifactAtomicIdempotencyKey({ artifactId: "artifact-1", revision: 4, target })).not.toBe(base);
    expect(buildArtifactAtomicIdempotencyKey({ artifactId: "artifact-2", revision: 3, target })).not.toBe(base);
    expect(buildArtifactAtomicIdempotencyKey({ artifactId: "artifact-1", revision: 3, target: { ...target, targetId: "message-other" } })).not.toBe(base);
    expect(fingerprintArtifactAtomicIntent("same")).toBe(fingerprintArtifactAtomicIntent("same"));
  });

  it("keeps native receipt as review while blocking missing scope facts", () => {
    const operation = createArtifactAtomicHandoffPreview({ artifactId: "artifact-1", revision: 3, target });
    const ready = evaluateArtifactAtomicHandoffPreflight(operation);
    expect(ready.status).toBe("review");
    expect(ready.canStagePreview).toBe(true);
    expect(ready.checks.find((item) => item.id === "native-receipt")?.state).toBe("review");

    const blocked = evaluateArtifactAtomicHandoffPreflight(createArtifactAtomicHandoffPreview({
      artifactId: "artifact-1",
      revision: 3,
      target: { ...target, targetId: "", branchId: "" },
    }));
    expect(blocked.status).toBe("blocked");
    expect(blocked.canStagePreview).toBe(false);
    expect(blocked.blockingReason).toMatch(/destination identity|chat and branch/i);
  });

  it("requires a model revision only for bridge destinations and serializes a reviewable payload", () => {
    const bridgeTarget = { ...target, kind: "bridge-plan" as const, targetId: "bridge-1" };
    const missing = evaluateArtifactAtomicHandoffPreflight(createArtifactAtomicHandoffPreview({ artifactId: "artifact-1", revision: 1, target: bridgeTarget }));
    expect(missing.status).toBe("blocked");
    expect(missing.checks.find((item) => item.id === "bridge-model")?.state).toBe("blocked");

    const operation = createArtifactAtomicHandoffPreview({ artifactId: "artifact-1", revision: 1, target: { ...bridgeTarget, modelProfileRevisionId: "profile-rev-1" } });
    const preflight = evaluateArtifactAtomicHandoffPreflight(operation);
    const serialized = serializeArtifactAtomicHandoffPreview(operation, preflight);
    expect(preflight.status).toBe("review");
    expect(JSON.parse(serialized)).toMatchObject({ operation: { sourceArtifactIds: ["artifact-1"] }, preflight: { canStagePreview: true } });
  });
});

