import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildContextRunEvidenceModel, ContextRunEvidenceCard } from "./context-run-evidence";
import { buildProjectContextAvailability } from "./project-context-availability-contract";

const project = {
  id: "project_omnia",
  name: "Omnia",
  description: "Workspace",
  accent: "#4f8cff",
  instructions: "Keep renderer boundaries explicit.",
  modelProfileId: "model_profile_default",
  conversationCount: 1,
  contextHealth: "ready" as const,
  pinned: false,
  folders: [
    {
      id: "folder_src",
      displayName: "Omnia source",
      canonicalPath: "C:/workspace/omnia",
      state: "ready" as const,
      scope: "read-only" as const,
      fileCount: 12,
      chunkCount: null,
      lastIndexedAt: null,
      localOnly: true,
    },
  ],
};

describe("ContextRunEvidenceCard", () => {
  it("builds an honest run-linked evidence model without inventing a context revision", () => {
    const model = buildContextRunEvidenceModel({
      surface: "run",
      project,
      conversationId: "conversation_1",
      runId: "run_1",
      memories: [{
        id: "memory_1",
        title: "Preference",
        content: "Use concise reports.",
        scopeLabel: "Omnia",
        kind: "preference",
        status: "active",
        origin: "explicit",
        confidence: 0.9,
        sourceLabel: "Chat",
        lastUsedLabel: null,
      }],
      skills: [{
        id: "skill_1",
        name: "TypeScript",
        description: "Type safety",
        version: "1.0.0",
        icon: "◇",
        source: "Built in",
        trust: "Verified",
        enabled: true,
        scope: "Project",
        tokenFootprint: 120,
        permissions: [],
      }],
    });

    expect(model.rows.find((row) => row.id === "run")?.value).toBe("run_1");
    expect(model.rows.find((row) => row.id === "context-revision")?.value).toBe("Not frozen");
    expect(model.rows.find((row) => row.id === "context-revision")?.state).toBe("planned");
    expect(model.rows.find((row) => row.id === "memory")?.value).toBe("1 active");
    expect(model.rows.find((row) => row.id === "skills")?.value).toBe("1 enabled");
    expect(model.boundary).toMatch(/durable lineage receipt/);
  });

  it("renders blocked access and explicit preview boundary states", () => {
    render(<ContextRunEvidenceCard surface="context" project={{ ...project, contextHealth: "missing-access", folders: [{ id: "folder_src", displayName: "Omnia source", canonicalPath: "C:/workspace/omnia", state: "permission-lost", scope: "read-only", fileCount: 12, chunkCount: null, lastIndexedAt: null, localOnly: true }] }} conversationId="conversation_1" />);

    const card = screen.getByTestId("context-run-evidence-context");
    expect(card).toBeInTheDocument();
    expect(card.querySelectorAll(".context-run-evidence__state--blocked")).toHaveLength(3);
    expect(card).toHaveTextContent(/No file read, retrieval, provider dispatch/);
    expect(card).toHaveTextContent(/Access missing/);
  });

  it("maps explicit native context evidence to current, stale, and failed states", () => {
    const current = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: {
        revisionId: "ctx-42",
        sourceEventWatermark: 91,
        state: "current",
      },
    });
    const currentModel = buildContextRunEvidenceModel({
      surface: "context",
      project,
      contextAvailability: current,
      contextRevisionId: current.evidence.revisionId,
    });
    const currentRow = currentModel.rows.find((row) => row.id === "context-revision");
    expect(currentRow).toMatchObject({ value: "ctx-42", state: "reported" });
    expect(currentRow?.detail).toMatch(/source watermark 91/);
    const currentRunModel = buildContextRunEvidenceModel({
      surface: "run",
      project,
      contextAvailability: current,
      runId: "run_1",
    });
    expect(currentRunModel.boundary).toMatch(/native context revision is observed/i);
    expect(currentRunModel.boundary).toMatch(/link to this run.*not proven/i);

    const stale = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: { revisionId: "ctx-41", sourceEventWatermark: 90, state: "stale" },
    });
    const staleRow = buildContextRunEvidenceModel({
      surface: "context",
      project,
      contextAvailability: stale,
      contextRevisionId: stale.evidence.revisionId,
    }).rows.find((row) => row.id === "context-revision");
    expect(staleRow).toMatchObject({ value: "ctx-41", state: "preview" });
    expect(staleRow?.detail).toMatch(/stale/i);

    const failed = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: { revisionId: "ctx-40", sourceEventWatermark: 89, state: "failed" },
    });
    const failedRow = buildContextRunEvidenceModel({
      surface: "context",
      project,
      contextAvailability: failed,
      contextRevisionId: failed.evidence.revisionId,
    }).rows.find((row) => row.id === "context-revision");
    expect(failedRow).toMatchObject({ value: "ctx-40", state: "blocked" });
    expect(failedRow?.detail).toMatch(/failed/i);
  });

  it("fails closed when current access or budget health invalidates a prior revision", () => {
    const blocked = buildProjectContextAvailability({
      health: "missing-access",
      nativeEvidence: {
        revisionId: "ctx-denied",
        sourceEventWatermark: 100,
        state: "current",
      },
    });
    const row = buildContextRunEvidenceModel({
      surface: "run",
      project: { ...project, contextHealth: "missing-access" },
      contextAvailability: blocked,
      contextRevisionId: blocked.evidence.revisionId,
    }).rows.find((item) => item.id === "context-revision");
    expect(row).toMatchObject({ value: "ctx-denied", state: "blocked" });
    expect(row?.detail).toMatch(/historical|access/i);

    const noAvailabilityRow = buildContextRunEvidenceModel({
      surface: "context",
      project: { ...project, contextHealth: "over-budget" },
      contextRevisionId: "ctx-budget",
    }).rows.find((item) => item.id === "context-revision");
    expect(noAvailabilityRow).toMatchObject({ value: "ctx-budget", state: "blocked" });

    const malformedCurrentAvailability = buildProjectContextAvailability({
      health: "ready",
      nativeEvidence: { revisionId: "ctx-unrelated", sourceEventWatermark: 21, state: "current" },
    });
    const mismatchedRow = buildContextRunEvidenceModel({
      surface: "context",
      project: { ...project, contextHealth: "missing-access" },
      contextAvailability: malformedCurrentAvailability,
    }).rows.find((item) => item.id === "context-revision");
    expect(mismatchedRow?.state).toBe("blocked");
  });
});
