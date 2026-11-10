import { describe, expect, it, vi } from "vitest";
import { AutomationDomainError, BrainstormSession, CollaborationRun, GoalLedger, PromptEnhancement } from "./index";

describe("automation boundary behavior", () => {
  it("fails SHA-256 explicitly without changing state when hashing is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    try {
      const run = new CollaborationRun("task");
      await expect(run.recordAttempt({ id: "a", model: "model", prompt: "Intent", status: "succeeded", output: "Answer" }, 0)).rejects.toThrow(/hash_unavailable/);
      expect(run.snapshot()).toMatchObject({ revision: 0, attempts: [] });
      const enhancement = new PromptEnhancement("Original", []);
      await expect(enhancement.propose({ id: "p", proposedPrompt: "Suggested", selectedContextIds: [], rationale: "Reason" }, 0)).rejects.toThrow(AutomationDomainError);
      expect(enhancement.snapshot()).toMatchObject({ revision: 0, status: "idle" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects malformed or unknown replay commands and retains canonical task owners", () => {
    const ledger = new GoalLedger({ id: "root", objective: "Complete", plan: [{ id: "task", owner: "/root/worker", files: ["src/file.ts"], input: "Requirement", output: "Result", verification: "Test" }] });
    expect(GoalLedger.restore(ledger.serialize()).snapshot().goals[0]?.plan[0]?.owner).toBe("/root/worker");
    const corrupt = JSON.parse(ledger.serialize());
    corrupt.events.push({ type: "forged_complete", expectedRevision: 0 });
    expect(() => GoalLedger.restore(JSON.stringify(corrupt))).toThrow(/invalid_replay/);
    expect(() => GoalLedger.restore("{malformed")).toThrow(/invalid_replay/);
    const brainstorm = new BrainstormSession("g");
    const bad = JSON.parse(brainstorm.serialize()); bad.unknown = true;
    expect(() => BrainstormSession.restore(JSON.stringify(bad))).toThrow(/unknown/);
  });

  it("bounds total goal journal bytes and per-pass brainstorm evidence", () => {
    const plan = Array.from({ length: 128 }, (_, index) => ({ id: `t${index}`, owner: "builder", files: ["src/file.ts"], input: "a".repeat(8_192), output: "b".repeat(8_192), verification: "c".repeat(8_192) }));
    const ledger = new GoalLedger({ id: "root", objective: "Bounded", plan });
    expect(() => ledger.addChild("root", { id: "child", objective: "Too much", plan }, 0)).toThrow(/capacity/);
    expect(ledger.snapshot().revision).toBe(0);
    const brainstorm = new BrainstormSession("g");
    expect(() => brainstorm.recordPass({ id: "large", decisions: Array.from({ length: 32 }, (_, index) => ({ action: "fix", summary: `${index}${"s".repeat(8_180)}`, evidence: ["source:" + "e".repeat(1_000)] })) }, 0)).toThrow(/capacity/);
    expect(brainstorm.snapshot().passes).toEqual([]);
  });
});
