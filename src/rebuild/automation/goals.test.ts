import { describe, expect, it } from "vitest";
import { GoalLedger } from "./goals";

const task = (id = "task-1") => ({ id, owner: "builder", files: ["src/example.ts"], input: "Requirement", output: "Implementation", verification: "Focused test" });
const root = () => new GoalLedger({ id: "outer", objective: "Deliver the complete outcome", plan: [task()] });

describe("nested goal reports", () => {
  it("keeps the outer report pending after a child final and requires its own evidence", () => {
    const ledger = root();
    ledger.addChild("outer", { id: "child", objective: "Implement a slice", plan: [task("child-task")] }, 0);
    ledger.completeTask("child", "child-task", ["test:child"], 1);
    ledger.report({ id: "child-final", goalId: "child", kind: "final", summary: "Slice complete", evidence: ["receipt:child"] }, 2);
    expect(ledger.snapshot().goals.find((goal) => goal.id === "outer")).toMatchObject({ status: "active", reports: [] });
    ledger.completeTask("outer", "task-1", ["test:outer"], 3);
    expect(() => ledger.report({ id: "outer-final", goalId: "outer", kind: "final", summary: "Done", evidence: [] }, 4)).toThrow(/evidence/);
    const report = ledger.report({ id: "outer-final", goalId: "outer", kind: "final", summary: "Complete outcome", evidence: ["receipt:outer"] }, 4);
    expect(report.childReportIds).toEqual(["child-final"]);
    expect(ledger.snapshot().goals.find((goal) => goal.id === "outer")?.status).toBe("completed");
  });

  it("accepts partial progress without completing a goal and rejects premature final reports", () => {
    const ledger = root();
    ledger.report({ id: "partial", goalId: "outer", kind: "partial", summary: "Work remains", evidence: ["test:partial"] }, 0);
    expect(ledger.snapshot().goals[0]?.status).toBe("active");
    expect(() => ledger.report({ id: "premature", goalId: "outer", kind: "final", summary: "Not ready", evidence: ["test:any"] }, 1)).toThrow(/incomplete/);
  });

  it("rejects stale task updates, duplicate IDs, empty plans and missing atomic fields", () => {
    const ledger = root();
    expect(() => ledger.completeTask("outer", "task-1", ["test:ok"], 1)).toThrow(/stale/);
    expect(() => ledger.addChild("outer", { id: "outer", objective: "Duplicate", plan: [task()] }, 0)).toThrow(/duplicate/);
    expect(() => new GoalLedger({ id: "empty", objective: "Empty", plan: [] })).toThrow(/plan/);
    expect(() => new GoalLedger({ id: "invalid", objective: "Invalid", plan: [{ ...task(), owner: "" }] })).toThrow(/owner/);
    expect(ledger.snapshot().revision).toBe(0);
  });

  it("cancels the subtree with distinct reports and rejects late completion", () => {
    const ledger = root();
    ledger.addChild("outer", { id: "child", objective: "Slice", plan: [task()] }, 0);
    ledger.cancel("outer", "Stopped by user", 1);
    const state = ledger.snapshot();
    expect(state.goals.map((goal) => goal.status)).toEqual(["cancelled", "cancelled"]);
    expect(new Set(state.goals.flatMap((goal) => goal.reports.map((report) => report.id))).size).toBe(2);
    expect(() => ledger.completeTask("child", "task-1", ["late"], 2)).toThrow(/terminal/);
  });

  it("restores validated commands and protects snapshots from outside mutation", () => {
    const ledger = root();
    ledger.completeTask("outer", "task-1", ["test:ok"], 0);
    const snapshot = ledger.snapshot();
    snapshot.goals[0]!.plan[0]!.evidence.push("forged");
    expect(ledger.snapshot().goals[0]?.plan[0]?.evidence).toEqual(["test:ok"]);
    expect(GoalLedger.restore(ledger.serialize()).snapshot()).toEqual(ledger.snapshot());
    const corrupt = JSON.parse(ledger.serialize());
    corrupt.events[0].expectedRevision = 99;
    expect(() => GoalLedger.restore(JSON.stringify(corrupt))).toThrow(/stale/);
    expect(() => GoalLedger.restore('{"schemaVersion":9}')).toThrow();
  });

  it("blocks outer final reports while a child is active or cancelled", () => {
    const ledger = root();
    ledger.addChild("outer", { id: "child", objective: "Slice", plan: [task()] }, 0);
    ledger.completeTask("outer", "task-1", ["test:outer"], 1);
    expect(() => ledger.report({ id: "final", goalId: "outer", kind: "final", summary: "Done", evidence: ["test:outer"] }, 2)).toThrow(/incomplete/);
    ledger.cancel("child", "Stopped", 2);
    expect(() => ledger.report({ id: "final", goalId: "outer", kind: "final", summary: "Done", evidence: ["test:outer"] }, 3)).toThrow(/incomplete/);
  });

  it("rejects unknown report fields and forged completed state on reload", () => {
    const ledger = root();
    expect(() => ledger.report({ id: "p", goalId: "outer", kind: "partial", summary: "Progress", evidence: ["test:any"], secret: "hidden" } as never, 0)).toThrow(/unknown/);
    const corrupt = JSON.parse(ledger.serialize());
    corrupt.state.goals[0].status = "completed";
    expect(() => GoalLedger.restore(JSON.stringify(corrupt))).toThrow(/replay|snapshot/);
  });
});
