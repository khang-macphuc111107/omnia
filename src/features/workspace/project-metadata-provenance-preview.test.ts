import { describe, expect, it } from "vitest";

import {
  createProjectMetadataProvenancePreview,
  PROJECT_METADATA_PROVENANCE_PREVIEW_BOUNDARY,
  serializeProjectMetadataProvenancePreview,
} from "./project-metadata-provenance-preview";

const baseline = {
  name: "Omnia",
  description: "Workspace",
  instructions: "Be precise.",
} as const;

describe("project metadata provenance preview contract", () => {
  it("captures a bounded draft delta without exporting metadata contents", () => {
    const snapshot = createProjectMetadataProvenancePreview({
      projectId: "project:omnia",
      source: "native-record",
      baseline,
      draft: { ...baseline, instructions: "Be precise and explicit." },
      nativeUpdatedAtMs: 42,
      overview: {
        overviewRevisionId: null,
        projectTwinRevisionId: null,
        sourceEventWatermark: null,
      },
      latestObservationId: "project-metadata-preview:project:omnia:1",
      observedAt: "2026-09-25T10:00:00.000Z",
    });

    expect(snapshot.freshness).toBe("draft-pending");
    expect(snapshot.changedFields).toEqual(["instructions"]);
    expect(snapshot.nativeUpdatedAtMs).toBe(42);
    expect(snapshot.latestObservationId).toContain("project-metadata-preview");
    expect(snapshot.draftDigest).not.toBe(snapshot.baselineDigest);

    const json = serializeProjectMetadataProvenancePreview(snapshot, "json");
    const parsed = JSON.parse(json) as { snapshot: Record<string, unknown>; boundary: string };
    expect(parsed.boundary).toContain("does not prove a native mutation receipt");
    expect(parsed.snapshot).not.toHaveProperty("name");
    expect(parsed.snapshot).not.toHaveProperty("description");
    expect(parsed.snapshot).not.toHaveProperty("instructions");
  });

  it("keeps browser previews session-only when there is no native cursor", () => {
    const snapshot = createProjectMetadataProvenancePreview({
      projectId: "project-1",
      source: "renderer-session-preview",
      baseline,
      draft: baseline,
      nativeUpdatedAtMs: null,
    });

    expect(snapshot.freshness).toBe("renderer-session-only");
    expect(snapshot.nativeUpdatedAtMs).toBeNull();
    expect(snapshot.projectTwinRevisionId).toBeNull();
    expect(serializeProjectMetadataProvenancePreview(snapshot, "markdown")).toContain(
      PROJECT_METADATA_PROVENANCE_PREVIEW_BOUNDARY,
    );
  });

  it("redacts malformed cursors and bounds provenance identifiers", () => {
    const snapshot = createProjectMetadataProvenancePreview({
      projectId: `${"x".repeat(220)}\nsecret`,
      source: "native-record",
      baseline,
      draft: baseline,
      nativeUpdatedAtMs: Number.POSITIVE_INFINITY,
      overview: {
        overviewRevisionId: `${"r".repeat(220)}\nsecret`,
        projectTwinRevisionId: "twin-1",
        sourceEventWatermark: -1,
      },
      latestObservationId: `${"o".repeat(260)}\nsecret`,
    });

    expect(snapshot.projectId.length).toBeLessThanOrEqual(160);
    expect(snapshot.projectId).not.toContain("\n");
    expect(snapshot.nativeUpdatedAtMs).toBeNull();
    expect(snapshot.overviewRevisionId?.length).toBeLessThanOrEqual(160);
    expect(snapshot.sourceEventWatermark).toBeNull();
    expect(snapshot.latestObservationId?.length).toBeLessThanOrEqual(220);
  });
});
