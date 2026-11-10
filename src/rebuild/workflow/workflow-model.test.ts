import { describe, expect, it } from "vitest";
import type { TaskSummary } from "@/lib/desktop";
import { appendReport, completionBlockers, createGoalRequest, goalRevisionRequest, readCriteria, taskRequest, taskRevisionRequest, updateCriterion } from "./workflow-model";
import { goalSnapshot } from "./workflow-test-fixtures";

describe("workflow planning model", () => {
  it("creates a native draft scoped only to supported project/conversation identities", () => {
    const request = createGoalRequest({ sessionId: "session_display", projectId: "project_one" }, { title: "  Record goal  ", description: "Objective", criteriaText: "Pass 10 checks\nCapture native UI", plan: "Run then inspect", reason: "" }, "operation_one");
    expect(request).toMatchObject({ projectId: "project_one", title: "Record goal", status: "draft", idempotencyKey: "operation_one" });
    expect(request).not.toHaveProperty("conversationId");
    expect(request).not.toHaveProperty("sessionId");
    expect(JSON.parse(request.acceptanceCriteriaJson!)).toMatchObject([{ text: "Pass 10 checks", status: "planned", evidence: [] }, { text: "Capture native UI", status: "planned", evidence: [] }]);
  });

  it("rejects empty titles, invalid scope, NUL and oversize text before mutation", () => {
    const draft = { title: "", description: "", criteriaText: "", plan: "", reason: "" };
    expect(() => createGoalRequest({}, draft, "one")).toThrow(/title/i);
    expect(() => createGoalRequest({ conversationId: "session_wrong" }, { ...draft, title: "Goal" }, "one")).toThrow(/conversation/i);
    expect(() => createGoalRequest({}, { ...draft, title: "a\0b" }, "one")).toThrow(/NUL/i);
    expect(() => createGoalRequest({}, { ...draft, title: "x".repeat(501) }, "one")).toThrow(/500/);
  });

  it("guards immutable goal edits and retains acceptance, foreign metadata and roadmap", () => {
    const snapshot = goalSnapshot();
    const request = goalRevisionRequest(snapshot, { title: "New title", description: "", criteriaText: "ignored", plan: "New plan", reason: "New evidence" }, "edit_one");
    const payload = JSON.parse(request.payloadJson);
    expect(request).toMatchObject({ goalId: "goal_one", expectedCurrentRevisionId: "goal_revision_one" });
    expect(payload).toMatchObject({ schemaVersion: 1, title: "New title", description: null, status: "active", stateRevisionId: null, roadmap: { overview: "New plan", foreign: { preserve: true } }, metadata: { foreign: { preserve: true }, workflowUi: { revisionReason: "New evidence", previousRevisionId: "goal_revision_one", previousContentSha256: "a".repeat(64) } } });
    expect(payload.acceptanceCriteria[0].text).toBe("Handles failures");
    expect(snapshot.goal.title).toBe("Ship evidence");
  });

  it("keeps unknown criteria inspectable and only records Done with evidence", () => {
    const snapshot = goalSnapshot();
    snapshot.goal.acceptanceCriteriaJson = JSON.stringify(["Plain criterion", { requirement: "Other schema", untouched: 4 }]);
    expect(readCriteria(snapshot).map((row) => row.text)).toEqual(["Plain criterion", "Other schema"]);
    expect(() => updateCriterion(snapshot, 0, { text: "Plain criterion", threshold: "Pass", evidenceType: "receipt", status: "done", evidence: [] }, "one")).toThrow(/evidence/i);
    const payload = JSON.parse(updateCriterion(snapshot, 1, { text: "Other schema", threshold: "Pass", evidenceType: "receipt", status: "partial", evidence: ["receipt.json"] }, "one").payloadJson);
    expect(payload.acceptanceCriteria[0]).toBe("Plain criterion");
    expect(payload.acceptanceCriteria[1]).toMatchObject({ untouched: 4, status: "partial", evidence: ["receipt.json"] });
  });

  it("appends a report without implicitly changing goal or acceptance status", () => {
    const snapshot = goalSnapshot();
    const payload = JSON.parse(appendReport(snapshot, { summary: "Verified the renderer", evidenceText: "receipt.json", limitations: "No packaged capture", remainingWork: "Capture Windows" }, "report_one").payloadJson);
    expect(payload.status).toBe("active");
    expect(payload.acceptanceCriteria[0].status).toBe("planned");
    expect(payload.metadata).toMatchObject({ foreign: { preserve: true }, workflowUi: { reports: [{ summary: "Verified the renderer", evidence: ["receipt.json"], limitations: "No packaged capture", remainingWork: "Capture Windows", sourceRevisionId: "goal_revision_one" }] } });
    expect(() => appendReport(snapshot, { summary: "", evidenceText: "", limitations: "", remainingWork: "" }, "one")).toThrow(/summary/i);
  });

  it("does not infer completion from a plan, declared status or a populated report", () => {
    const snapshot = goalSnapshot();
    const tasks = [{ id: "task_one", status: "in_progress" }] as TaskSummary[];
    expect(completionBlockers(snapshot, tasks, false).join(" ")).toMatch(/acceptance|evidence/i);
    expect(completionBlockers(snapshot, tasks, false).join(" ")).toMatch(/task/i);
    expect(completionBlockers(snapshot, tasks, false).join(" ")).toMatch(/report/i);
    snapshot.goal.acceptanceCriteriaJson = JSON.stringify([{ text: "Pass", threshold: "All", evidenceType: "receipt", status: "done", evidence: ["checks.json"] }]);
    snapshot.goal.metadataJson = JSON.stringify({ workflowUi: { reports: [{ summary: "Ready", evidence: ["checks.json"], limitations: "", remainingWork: "" }] } });
    tasks[0]!.status = "completed";
    expect(completionBlockers(snapshot, tasks, false)).toEqual([]);
    expect(completionBlockers(snapshot, tasks, true).join(" ")).toMatch(/limit/i);
  });

  it("records atomic task fields while preserving unknown task metadata on revision", () => {
    const draft = { title: "Read source", description: "Inspect", owner: "research", filesText: "src/a.ts\nsrc/b.ts", input: "Pinned source", output: "Receipt", verification: "10 passing checks", evidenceText: "receipt.json", report: "Verified", reason: "Refresh" };
    const request = taskRequest(goalSnapshot(), draft, "task_one");
    expect(request).toMatchObject({ goalId: "goal_one", status: "pending" });
    expect(JSON.parse(request.metadataJson!)).toMatchObject({ workflowUi: { owner: "research", files: ["src/a.ts", "src/b.ts"], input: "Pinned source", output: "Receipt", verification: "10 passing checks", evidence: ["receipt.json"], report: "Verified" } });
    const task = { task: { id: "task_one", goalId: "goal_one", currentRevisionId: "task_revision_one", stateRevisionId: null, status: "in_progress", metadataJson: '{"foreign":4}', canonicalPayloadSha256: "b".repeat(64) } } as Parameters<typeof taskRevisionRequest>[0];
    const edit = taskRevisionRequest(task, draft, "edit");
    expect(JSON.parse(edit.payloadJson)).toMatchObject({ schemaVersion: 1, status: "in_progress", metadata: { foreign: 4, workflowUi: { owner: "research", previousRevisionId: "task_revision_one" } } });
    expect(edit.expectedCurrentRevisionId).toBe("task_revision_one");
    expect(() => taskRequest(goalSnapshot(), { ...draft, owner: "" }, "bad")).toThrow(/owner/i);
  });

  it("carries the native goal scope into a newly created task", () => {
    const goal = goalSnapshot("goal_project", "project_one");
    goal.goal.conversationId = "conversation_one";
    goal.goal.branchId = "branch_one";
    goal.goal.stateRevisionId = "state_revision_one";
    const draft = { title: "Scoped", description: "", owner: "qa", filesText: "src/a.ts", input: "Source", output: "Receipt", verification: "Pass", evidenceText: "", report: "", reason: "" };
    expect(taskRequest(goal, draft, "one")).toMatchObject({ goalId: "goal_project", projectId: "project_one", conversationId: "conversation_one", branchId: "branch_one", stateRevisionId: "state_revision_one" });
  });
});
