import { describe, expect, it } from "vitest";

import {
  buildTrainingCheckpointManifest,
  serializeTrainingCheckpointManifest,
  validateTrainingCheckpointManifest,
} from "./training-checkpoint-preview";

describe("training checkpoint manifest preview", () => {
  it("keeps best and latest markers distinct under the default policy", () => {
    const manifest = buildTrainingCheckpointManifest({
      runName: "Quality rehearsal",
      epochs: 3,
      evaluationCadence: "Every 250 steps",
      checkpointPolicy: "Keep best + latest",
    });

    expect(manifest.records.map((record) => record.id)).toEqual([
      "checkpoint-best-validation",
      "checkpoint-latest-final",
    ]);
    expect(manifest.records[0]?.status).toBe("approval-required");
    expect(manifest.records[1]?.epoch).toBe(3);
    expect(manifest.boundary.checkpointWrite).toBe(false);
  });

  it("does not invent a best checkpoint for latest-only retention", () => {
    const manifest = buildTrainingCheckpointManifest({
      runName: "Latest only",
      epochs: 2,
      evaluationCadence: "End of epoch",
      checkpointPolicy: "Keep latest only",
    });

    expect(manifest.records).toHaveLength(1);
    expect(manifest.plan.retentionSummary).toMatch(/one latest/i);
  });

  it("serializes a redacted markdown export and rejects boundary drift", () => {
    const manifest = buildTrainingCheckpointManifest({
      runName: "Markdown rehearsal",
      epochs: 4,
      evaluationCadence: "Every 100 steps",
      checkpointPolicy: "Manual approval per checkpoint",
    });
    const markdown = serializeTrainingCheckpointManifest(manifest, "markdown");

    expect(markdown).toMatch(/Preview only/);
    expect(markdown).toMatch(/model weights/);
    expect(validateTrainingCheckpointManifest(JSON.parse(serializeTrainingCheckpointManifest(manifest)))).toEqual(manifest);

    expect(() => validateTrainingCheckpointManifest({
      ...manifest,
      boundary: { ...manifest.boundary, checkpointWrite: true },
    })).toThrow(/boundary\.checkpointWrite must remain false/i);
  });
});

