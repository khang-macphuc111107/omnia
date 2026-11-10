import { describe, expect, it } from "vitest";
import { createGroundedResearchWorkflow } from "./research-workflow";
import { workflowCoverage } from "./workflow-contract";

describe("grounded research workflow", () => {
  it("creates dependent atomic tasks with measurable acceptance criteria and no fabricated verification", () => {
    const result = createGroundedResearchWorkflow({ prompt: "Latest source-grounded research", now: "2026-11-07T12:00:00.000Z", policy: { maxQueries: 3 }, planIterations: 3 });
    expect(result.execution.queries).toHaveLength(3);
    expect(result.workflow.tasks).toHaveLength(4);
    expect(result.workflow.tasks[0]?.criteria[0]?.minimum).toBe("3/3 query receipts");
    expect(result.workflow.tasks[1]?.dependsOn).toEqual([result.workflow.tasks[0]?.id]);
    expect(result.workflow.tasks[2]?.dependsOn).toEqual([result.workflow.tasks[1]?.id]);
    expect(result.workflow.tasks[3]?.dependsOn).toEqual([result.workflow.tasks[2]?.id]);
    expect(result.workflow.maxIterations).toBe(3);
    expect(workflowCoverage(result.workflow)).toMatchObject({ criteriaVerified: 0, criteriaTotal: 8, percent: 0 });
  });
});
