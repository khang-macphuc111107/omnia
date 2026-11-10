import { describe, expect, it } from "vitest";

import {
  buildProjectContextAvailability,
  buildProjectContextAvailabilityForProject,
  nativeContextEvidenceFromOverview,
  projectContextHealthLabel,
} from "./project-context-availability-contract";

describe("project context availability contract", () => {
  it("keeps renderer ready references honest", () => {
    const availability = buildProjectContextAvailability({
      health: "ready",
      folders: [
        { state: "ready", scope: "read-only" },
        { state: "referenced", scope: "metadata" },
      ],
    });

    expect(availability.label).toBe("Referenced · not indexed");
    expect(availability.surfaceStatus).toBe("preview");
    expect(availability.evidence.state).toBe("renderer-projection");
    expect(availability.evidence.revisionId).toBeNull();
    expect(availability.folders).toEqual({
      total: 2,
      referenced: 2,
      unavailable: 0,
      indexingOrPartial: 0,
    });
    expect(availability.capabilities.read).toBe("unavailable");
    expect(availability.capabilities.compile).toBe("planned");
    expect(availability.capabilities.dispatch).toBe("unavailable");
    expect(availability.canDispatchProviderInput).toBe(false);
  });

  it("blocks missing access and over-budget context before compile", () => {
    const missingAccess = buildProjectContextAvailability({
      health: "missing-access",
      folders: [{ state: "permission-lost", scope: "read-only" }],
    });
    expect(missingAccess.surfaceStatus).toBe("unavailable");
    expect(missingAccess.reasonCode).toBe("native_access_missing");
    expect(missingAccess.folders.unavailable).toBe(1);
    expect(missingAccess.capabilities.compile).toBe("unavailable");
    expect(missingAccess.canDispatchProviderInput).toBe(false);

    const overBudget = buildProjectContextAvailability({ health: "over-budget" });
    expect(overBudget.tone).toBe("warning");
    expect(overBudget.reasonCode).toBe("preview_budget_exceeded");
    expect(overBudget.capabilities.compile).toBe("unavailable");
  });

  it("supports explicit native current, stale, and failed evidence", () => {
    const current = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: {
        revisionId: "ctx-42",
        sourceEventWatermark: 91,
        state: "current",
      },
    });
    expect(current.label).toBe("Compiled · native evidence");
    expect(current.surfaceStatus).toBe("verified");
    expect(current.evidence).toEqual({
      state: "native-current",
      revisionId: "ctx-42",
      sourceEventWatermark: 91,
    });
    expect(current.capabilities.read).toBe("verified");
    expect(current.capabilities.compile).toBe("verified");
    expect(current.capabilities.dispatch).toBe("unavailable");
    expect(current.canDispatchProviderInput).toBe(false);

    const stale = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: { revisionId: "ctx-41", sourceEventWatermark: 90, state: "stale" },
    });
    expect(stale.surfaceStatus).toBe("preview");
    expect(stale.reasonCode).toBe("native_revision_stale");
    expect(stale.canDispatchProviderInput).toBe(false);

    const failed = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: { revisionId: "ctx-40", sourceEventWatermark: 89, state: "failed" },
    });
    expect(failed.surfaceStatus).toBe("unavailable");
    expect(failed.reasonCode).toBe("native_revision_failed");
    expect(failed.capabilities.compile).toBe("planned");
    expect(failed.canDispatchProviderInput).toBe(false);
  });

  it("fails closed when a current native revision conflicts with access or budget denial", () => {
    const deniedAccess = buildProjectContextAvailability({
      health: "missing-access",
      nativeEvidence: {
        revisionId: "ctx-denied",
        sourceEventWatermark: 100,
        state: "current",
      },
    });
    expect(deniedAccess.label).toBe("Access needed");
    expect(deniedAccess.surfaceStatus).toBe("unavailable");
    expect(deniedAccess.reasonCode).toBe("native_access_missing");
    expect(deniedAccess.evidence).toEqual({
      state: "native-stale",
      revisionId: "ctx-denied",
      sourceEventWatermark: 100,
    });
    expect(deniedAccess.capabilities.read).toBe("unavailable");
    expect(deniedAccess.capabilities.compile).toBe("unavailable");
    expect(deniedAccess.canDispatchProviderInput).toBe(false);

    const overBudget = buildProjectContextAvailability({
      health: "over-budget",
      nativeEvidence: {
        revisionId: "ctx-budget",
        sourceEventWatermark: 101,
        state: "current",
      },
    });
    expect(overBudget.label).toBe("Over budget preview");
    expect(overBudget.surfaceStatus).toBe("preview");
    expect(overBudget.reasonCode).toBe("preview_budget_exceeded");
    expect(overBudget.evidence.state).toBe("native-stale");
    expect(overBudget.capabilities.read).toBe("unavailable");
    expect(overBudget.capabilities.compile).toBe("unavailable");
  });

  it("provides one shared label mapping for all project surfaces", () => {
    expect(projectContextHealthLabel("ready")).toBe("Referenced · not indexed");
    expect(projectContextHealthLabel("not-compiled")).toBe("Not compiled");
    expect(projectContextHealthLabel("indexing")).toBe("Indexing preview");
    expect(projectContextHealthLabel("over-budget")).toBe("Over budget preview");
    expect(projectContextHealthLabel("missing-access")).toBe("Access needed");
  });

  it("derives explicit native evidence from overview status and watermark", () => {
    const base = {
      contextRevisionId: "ctx-17",
      sourceEventWatermark: 17,
    } as const;

    expect(nativeContextEvidenceFromOverview({ ...base, status: "current" })).toEqual({
      revisionId: "ctx-17",
      sourceEventWatermark: 17,
      state: "current",
    });
    expect(nativeContextEvidenceFromOverview({ ...base, status: "stale" })?.state).toBe("stale");
    expect(nativeContextEvidenceFromOverview({ ...base, status: "superseded" })?.state).toBe("stale");
    expect(nativeContextEvidenceFromOverview({ ...base, status: "failed" })?.state).toBe("failed");
    expect(nativeContextEvidenceFromOverview({ ...base, status: "candidate" })).toBeNull();
    expect(nativeContextEvidenceFromOverview({ ...base, status: "unknown" })).toBeNull();
    expect(nativeContextEvidenceFromOverview({ ...base, status: "current", sourceEventWatermark: null })).toBeNull();
    expect(nativeContextEvidenceFromOverview({ ...base, status: "current", contextRevisionId: null })).toBeNull();
    expect(nativeContextEvidenceFromOverview({ ...base, status: "current", sourceEventWatermark: -1 })).toBeNull();
  });

  it("preserves overview native evidence through the project adapter", () => {
    const availability = buildProjectContextAvailabilityForProject({
      contextHealth: "ready",
      folders: [],
      overview: {
        contextRevisionId: "ctx-17",
        sourceEventWatermark: 17,
        status: "current" as const,
      },
    });

    expect(availability.label).toBe("Compiled · native evidence");
    expect(availability.evidence).toEqual({
      state: "native-current",
      revisionId: "ctx-17",
      sourceEventWatermark: 17,
    });
    expect(availability.capabilities.read).toBe("verified");
    expect(availability.canDispatchProviderInput).toBe(false);
  });

  it("keeps overview evidence historical when access or budget is blocked", () => {
    const project = {
      contextHealth: "missing-access" as const,
      folders: [],
      overview: {
        contextRevisionId: "ctx-17",
        sourceEventWatermark: 17,
        status: "current" as const,
      },
    };

    const availability = buildProjectContextAvailabilityForProject(project);
    expect(availability.surfaceStatus).toBe("unavailable");
    expect(availability.evidence.state).toBe("native-stale");
    expect(availability.capabilities.read).toBe("unavailable");
    expect(availability.canDispatchProviderInput).toBe(false);
  });
});
