import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  buildContextMemorySkillReceiptModel,
  buildContextRerunPreview,
  ContextMemorySkillReceipt,
} from "./context-memory-skill-receipt";
import type { MemoryView, ProjectView, SkillView } from "./types";

const project: ProjectView = {
  id: "project-1",
  name: "Omnia",
  description: "Test project",
  accent: "#34d399",
  instructions: "Keep evidence explicit.",
  modelProfileId: "profile-1",
  conversationCount: 1,
  contextHealth: "ready",
  pinned: false,
  folders: [],
};

const memories: MemoryView[] = [
  {
    id: "memory-global",
    title: "Preferred language",
    content: "Vietnamese",
    scopeLabel: "Global",
    kind: "preference",
    status: "active",
    origin: "explicit",
    confidence: null,
    sourceLabel: "User profile",
    lastUsedLabel: null,
  },
  {
    id: "memory-project",
    title: "Project constraint",
    content: "Keep preview boundaries explicit.",
    scopeLabel: "Omnia",
    kind: "constraint",
    status: "active",
    origin: "inferred",
    confidence: 0.9,
    sourceLabel: "Conversation",
    lastUsedLabel: null,
  },
  {
    id: "memory-archived",
    title: "Archived fact",
    content: "Do not show",
    scopeLabel: "Omnia",
    kind: "project-fact",
    status: "archived",
    origin: "imported",
    confidence: 0.6,
    sourceLabel: "Import",
    lastUsedLabel: null,
  },
];

const skills: SkillView[] = [
  {
    id: "skill-global",
    name: "Research",
    description: "Research helper",
    version: "1.0.0",
    icon: "",
    source: "Built in",
    trust: "Verified",
    enabled: true,
    scope: "Global",
    tokenFootprint: 120,
    permissions: ["Read sources"],
  },
  {
    id: "skill-project",
    name: "Coder",
    description: "Coding helper",
    version: "2.1.0",
    icon: "",
    source: "Local",
    trust: "Reviewed",
    enabled: true,
    scope: "Project",
    tokenFootprint: 240,
    permissions: ["Read workspace", "Suggest edits"],
  },
  {
    id: "skill-manual",
    name: "Manual only",
    description: "Not automatically active",
    version: "1.0.0",
    icon: "",
    source: "Imported",
    trust: "Unreviewed",
    enabled: true,
    scope: "Manual",
    tokenFootprint: 40,
    permissions: [],
  },
];

describe("ContextMemorySkillReceipt", () => {
  it("projects active scoped memories and enabled non-manual skills", () => {
    const model = buildContextMemorySkillReceiptModel({
      project,
      memories,
      skills,
      messageId: "answer-1",
      runId: "run-1",
      contextRevisionId: "ctx-1",
    });

    expect(model.memoryCount).toBe(2);
    expect(model.skillCount).toBe(2);
    expect(model.rows.map((row) => row.label)).toEqual([
      "Preferred language",
      "Project constraint",
      "Research",
      "Coder",
    ]);
    expect(model.rows[0]?.provenance).toEqual({
      sourceId: "memory-global",
      sourceVersionId: "memory:memory-global:renderer-preview",
      sourceLabel: "User profile",
      state: "not-observed",
    });
    expect(model.rows[3]?.provenance.sourceVersionId).toBe("skill:skill-project:v2.1.0:renderer-preview");
    expect(model.boundary).toMatch(/not proof/i);
  });

  it("keeps standalone scope from claiming project memory or skill activation", () => {
    const model = buildContextMemorySkillReceiptModel({ project: undefined, memories, skills });

    expect(model.memoryCount).toBe(1);
    expect(model.skillCount).toBe(1);
    expect(model.scopeLabel).toBe("Standalone Inbox");
  });

  it("renders revision and honest empty state", () => {
    render(
      <ContextMemorySkillReceipt
        project={project}
        memories={[]}
        skills={[]}
        contextRevisionId={null}
      />,
    );

    expect(screen.getByTestId("context-memory-skill-receipt")).toHaveTextContent(/No active memory/i);
    expect(screen.getByText(/Not frozen/i)).toBeInTheDocument();
    expect(screen.getByText(/absence is not proof/i)).toBeInTheDocument();
  });

  it("builds a fail-closed rerun draft with excluded candidate reasons", () => {
    const model = buildContextMemorySkillReceiptModel({
      project,
      memories,
      skills,
      runId: "run-1",
      contextRevisionId: "ctx-1",
    });
    const preview = buildContextRerunPreview(model, "run-1", {
      "memory:memory-project": "sensitive",
    });

    expect(preview.schema).toBe("omnia.context-rerun.preview.v1");
    expect(preview.includedCandidateIds).not.toContain("memory:memory-project");
    expect(preview.candidateRefs).toContainEqual({
      id: "memory:memory-project",
      kind: "memory",
      sourceId: "memory-project",
      sourceVersionId: "memory:memory-project:renderer-preview",
      provenanceState: "not-observed",
    });
    expect(preview.excludedCandidates).toEqual([
      { id: "memory:memory-project", kind: "memory", reason: "sensitive" },
    ]);
    expect(preview.effects).toEqual({
      queued: false,
      providerDispatch: false,
      nativeContextFreeze: false,
      durableWrite: false,
    });
  });

  it("lets a run-scoped preview exclude a candidate and prepare a local JSON draft", () => {
    render(
      <ContextMemorySkillReceipt
        project={project}
        memories={memories}
        skills={skills}
        runId="run-1"
        contextRevisionId="ctx-1"
        surface="run"
      />,
    );

    fireEvent.click(screen.getByLabelText(/Exclude Project constraint from rerun preview/i));
    expect(screen.getByText(/memory:memory-project:renderer-preview/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Not observed/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 candidate exclusions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Prepare rerun preview/i }));
    expect(screen.getByText(/Draft preview only · not queued/i)).toBeInTheDocument();
    expect(screen.getByText(/omnia.context-rerun.preview.v1/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot alter an existing answer/i)).toBeInTheDocument();
  });
});
