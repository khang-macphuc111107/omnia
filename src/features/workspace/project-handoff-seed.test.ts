import { describe, expect, it } from "vitest";

import { buildProjectHandoffSeed, buildProjectPlanChatDraft } from "./project-handoff-seed";
import type { ProjectPlanPreview } from "./project-planning-preview";

const plan: ProjectPlanPreview = {
  objective: "Ship a bounded preview.",
  nonGoals: [],
  assumptions: [],
  constraints: [],
  architecture: [],
  phases: [
    {
      id: "phase-one",
      title: "Foundation",
      objective: "Make the scope explicit.",
      window: "Now",
      status: "active",
      tasks: [
        {
          id: "task-scope",
          title: "Map the scope",
          status: "done",
          owner: "You",
          dependsOn: [],
          acceptance: "A scope map is visible.",
          artifact: "Scope map",
          risk: null,
        },
        {
          id: "task-handoff",
          title: "Prepare the handoff brief",
          status: "active",
          owner: "Planner",
          dependsOn: ["task-scope", "task-missing"],
          acceptance: "The next owner can review the brief.",
          artifact: "Handoff brief",
          risk: "Native approval is not hydrated.",
        },
      ],
    },
  ],
};

describe("buildProjectHandoffSeed", () => {
  it("carries task ownership, acceptance, dependencies, and boundary into a local brief", () => {
    const seed = buildProjectHandoffSeed(plan, "task-handoff");

    expect(seed).toMatchObject({
      schema: "omnia.project-handoff-seed.preview.v1",
      taskId: "task-handoff",
      phaseTitle: "Foundation",
      owner: "Planner",
      artifact: "Handoff brief",
      acceptance: "The next owner can review the brief.",
      risk: "Native approval is not hydrated.",
    });
    expect(seed?.dependencies).toEqual([
      { id: "task-scope", title: "Map the scope" },
      { id: "task-missing", title: null },
    ]);
    expect(seed?.brief).toContain("task-missing (unresolved)");
    expect(seed?.boundary).toMatch(/no scheduler item/i);
  });

  it("selects the active task by default and remains empty for an empty plan", () => {
    expect(buildProjectHandoffSeed(plan)?.taskId).toBe("task-handoff");
    expect(buildProjectHandoffSeed({ ...plan, phases: [] })).toBeNull();
  });

  it("produces an editable bounded Chat draft with unresolved dependencies visible", () => {
    const seed = buildProjectHandoffSeed(plan, "task-handoff")!;
    const draft = buildProjectPlanChatDraft("Omnia", seed);
    expect(draft).toContain("Draft from Project Plan preview");
    expect(draft).toContain("Task: Prepare the handoff brief");
    expect(draft).toContain("task-missing (unresolved)");
    expect(draft).toContain("Acceptance: The next owner can review the brief.");
    expect(buildProjectPlanChatDraft("Omnia", { ...seed, acceptance: "A".repeat(9000) })).toContain("Draft shortened");
  });
});
