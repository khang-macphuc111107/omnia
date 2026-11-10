import { describe, expect, it } from "vitest";
import { BrainstormSession } from "./brainstorm";

const decision = (summary = "Add missing test") => ({ action: "add" as const, summary, evidence: ["source:requirement"] });

describe("bounded brainstorming", () => {
  it("defaults to three useful passes and stops at the cap", () => {
    const session = new BrainstormSession("goal");
    for (let index = 0; index < 3; index += 1) session.recordPass({ id: `pass-${index}`, decisions: [decision(`Decision ${index}`)] }, index);
    expect(session.snapshot()).toMatchObject({ maxPasses: 3, status: "stopped", stopReason: "pass_limit", revision: 3 });
    expect(() => session.recordPass({ id: "late", decisions: [decision()] }, 3)).toThrow(/terminal/);
  });

  it("accepts zero and ten and rejects fractional, negative and unbounded settings", () => {
    expect(new BrainstormSession("goal", 0).snapshot()).toMatchObject({ status: "stopped", stopReason: "disabled", passes: [] });
    const max = new BrainstormSession("goal", 10);
    for (let index = 0; index < 10; index += 1) max.recordPass({ id: `p${index}`, decisions: [decision(`D${index}`)] }, index);
    expect(max.snapshot().passes).toHaveLength(10);
    for (const invalid of [-1, 11, 1.5, NaN, Infinity]) expect(() => new BrainstormSession("goal", invalid)).toThrow(/0.*10/);
  });

  it("records evidence-backed no-action and converges early on repeated decisions", () => {
    const session = new BrainstormSession("goal");
    session.recordPass({ id: "first", decisions: [decision()] }, 0);
    session.recordPass({ id: "repeat", decisions: [decision()] }, 1);
    expect(session.snapshot()).toMatchObject({ status: "stopped", stopReason: "no_new_decision" });
    const noAction = new BrainstormSession("goal");
    noAction.recordPass({ id: "none", decisions: [{ action: "no_action", summary: "No further change is supported", evidence: ["review:clean"] }] }, 0);
    expect(noAction.snapshot().stopReason).toBe("no_new_decision");
  });

  it("rejects empty decisions, missing evidence, contradictory no-action and stale passes", () => {
    const session = new BrainstormSession("goal");
    expect(() => session.recordPass({ id: "empty", decisions: [] }, 0)).toThrow(/decision/);
    expect(() => session.recordPass({ id: "no-proof", decisions: [{ ...decision(), evidence: [] }] }, 0)).toThrow(/evidence/);
    expect(() => session.recordPass({ id: "mixed", decisions: [decision(), { action: "no_action", summary: "No action", evidence: ["proof"] }] }, 0)).toThrow(/no_action/);
    expect(() => session.recordPass({ id: "stale", decisions: [decision()] }, 1)).toThrow(/stale/);
    expect(session.snapshot().passes).toHaveLength(0);
  });

  it("retains cancellation and replay state without exposing mutable internals", () => {
    const session = new BrainstormSession("goal");
    session.recordPass({ id: "pass", decisions: [decision()] }, 0);
    session.cancel("User stopped the process", 1);
    expect(BrainstormSession.restore(session.serialize()).snapshot()).toEqual(session.snapshot());
    session.snapshot().passes[0]!.decisions[0]!.evidence.push("forged");
    expect(session.snapshot().passes[0]?.decisions[0]?.evidence).toEqual(["source:requirement"]);
    expect(() => session.recordPass({ id: "late", decisions: [decision()] }, 2)).toThrow(/terminal/);
  });

  it("stops when a pass only recombines earlier decisions and rejects forged reload", () => {
    const session = new BrainstormSession("goal", 10);
    session.recordPass({ id: "one", decisions: [decision("A"), decision("B")] }, 0);
    session.recordPass({ id: "two", decisions: [decision("B")] }, 1);
    expect(session.snapshot().stopReason).toBe("no_new_decision");
    const corrupt = JSON.parse(session.serialize()); corrupt.state.status = "active";
    expect(() => BrainstormSession.restore(JSON.stringify(corrupt))).toThrow(/replay|snapshot/);
  });
});
