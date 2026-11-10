import { describe, expect, it } from "vitest";
import { AskUserEnvelopeBroker, AskUserEnvelopeError, parseAskUserDecision, parseAskUserRequest } from "./ask-user-envelope";

const request = (patch: Record<string, unknown> = {}) => ({
  kind: "ask_user.request", requestId: "question-1", sessionId: "session-1", runId: "run-1", prompt: "Choose a path",
  options: [{ id: "recommended", label: "Recommended", recommended: true }, { id: "manual", label: "Manual" }], allowFreeText: true,
  recommendedOptionIds: ["recommended"], revision: 1, createdAtMs: 1_000, expiresAtMs: null, ...patch,
});
const decision = (patch: Record<string, unknown> = {}) => ({
  kind: "ask_user.decision", requestId: "question-1", sessionId: "session-1", runId: "run-1", revision: 1,
  action: "select", optionId: "recommended", text: null, reason: null, ...patch,
});
const broker = (now = 2_000) => new AskUserEnvelopeBroker("session-1", "run-1", () => now);

describe("typed ask-user envelope", () => {
  it("rejects unknown fields so secrets cannot cross the envelope", () => {
    expect(() => parseAskUserRequest({ ...request(), secret: "must not cross" } as unknown)).toThrowError(/unknown field/);
  });
  it("rejects duplicate options and recommended ids that are not options", () => {
    expect(() => parseAskUserRequest({ ...request(), options: [{ id: "a", label: "A" }, { id: "a", label: "A2" }] })).toThrowError(AskUserEnvelopeError);
    expect(() => parseAskUserRequest({ ...request(), recommendedOptionIds: ["missing"] })).toThrowError(AskUserEnvelopeError);
  });
  it("opens a session/run-bound request and exposes a defensive snapshot", () => {
    const state = broker(); const opened = state.open(request()); opened.prompt = "mutated";
    expect(state.pendingRequests()[0]?.request.prompt).toBe("Choose a path");
  });
  it("rejects wrong session and wrong run before delivery", () => {
    const state = broker(); state.open(request());
    expect(() => state.decide(decision({ sessionId: "other" }))).toThrowError(/different session/);
    expect(() => state.decide(decision({ runId: "other" }))).toThrowError(/different run/);
  });
  it("accepts a selected option and rejects a duplicate late answer", () => {
    const state = broker(); state.open(request());
    expect(state.decide(decision())).toMatchObject({ status: "answered", action: "select", optionId: "recommended" });
    expect(() => state.decide(decision())).toThrowError(AskUserEnvelopeError);
    expect(() => state.decide(decision())).toThrowError(/no longer pending/);
  });
  it("supports free text and edit only when the request permits it", () => {
    const state = broker(); state.open(request({ requestId: "free", allowFreeText: true }));
    expect(state.decide(decision({ requestId: "free", action: "free_text", optionId: null, text: "custom answer" }))).toMatchObject({ status: "answered", text: "custom answer" });
    const locked = broker(); locked.open(request({ requestId: "locked", allowFreeText: false }));
    expect(() => locked.decide(decision({ requestId: "locked", action: "edit", optionId: null, text: "not allowed" }))).toThrowError(/disabled/);
  });
  it("supports approve, reject and explicit cancel outcomes", () => {
    const approved = broker(); approved.open(request({ requestId: "approve" }));
    expect(approved.decide(decision({ requestId: "approve", action: "approve", optionId: null }))).toMatchObject({ status: "answered", action: "approve" });
    const rejected = broker(); rejected.open(request({ requestId: "reject" }));
    expect(rejected.decide(decision({ requestId: "reject", action: "reject", optionId: null, reason: "Not now" }))).toMatchObject({ status: "rejected", action: "reject", reason: "Not now" });
    const cancelled = broker(); cancelled.open(request({ requestId: "cancel" }));
    expect(cancelled.cancel("cancel")).toMatchObject({ status: "cancelled", action: "cancel", reason: "user_cancelled" });
  });
  it("rejects stale revisions and unknown request ids", () => {
    const state = broker(); state.open(request());
    expect(() => state.decide(decision({ revision: 2 }))).toThrowError(/stale/);
    expect(() => state.decide(decision({ requestId: "missing" }))).toThrowError(/unknown/);
  });
  it("expires timed-out requests, records a tombstone and rejects late answers", () => {
    const state = new AskUserEnvelopeBroker("session-1", "run-1", () => 5_000);
    state.open(request({ expiresAtMs: 4_000 }));
    expect(() => state.decide(decision())).toThrowError(/expired/);
    expect(() => state.decide(decision())).toThrowError(AskUserEnvelopeError);
    expect(() => state.cancel("question-1")).toThrowError(/expired/);
  });
  it("closes all pending requests with bounded cancellation receipts", () => {
    const state = broker(); state.open(request()); state.open(request({ requestId: "question-2" }));
    expect(state.close("run_shutdown")).toHaveLength(2);
    expect(state.pendingRequests()).toHaveLength(0);
    expect(() => state.open(request({ requestId: "question-3" }))).toThrowError(/closed/);
  });
  it("rejects malformed decisions and unknown envelope fields", () => {
    expect(() => parseAskUserDecision({ ...decision(), action: "unknown" })).toThrowError(AskUserEnvelopeError);
    expect(() => parseAskUserDecision({ ...decision(), select: true })).toThrowError(/unknown field/);
    expect(() => parseAskUserDecision({ ...decision(), action: "select", optionId: null })).toThrowError(/requires optionId/);
  });
});

