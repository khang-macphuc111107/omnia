import { describe, expect, it } from "vitest";

import { ChatEventGate } from "./chat-controller";

describe("ChatEventGate", () => {
  it("accepts a monotonic journal sequence and rejects duplicate delivery", () => {
    const gate = new ChatEventGate();
    expect(gate.accept({ sessionId: "s1", sequence: 4, event: { type: "run_started", runId: "run-a" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 4, event: { type: "run_started", runId: "run-a" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: 3, event: { type: "stream", runId: "run-a" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: 5, event: { type: "stream", runId: "run-a" } })).toBe(true);
  });

  it("drops a late event from a previous run even when it arrives after a new run", () => {
    const gate = new ChatEventGate();
    expect(gate.accept({ sessionId: "s1", sequence: 1, event: { type: "run_started", runId: "run-a" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 2, event: { type: "run_started", runId: "run-b" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 3, event: { type: "ask_user", runId: "run-a" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: 4, event: { type: "ask_user", runId: "run-b" } })).toBe(true);
  });

  it("accepts legacy events without sequence while preserving the run fence", () => {
    const gate = new ChatEventGate();
    expect(gate.accept({ sessionId: "s1", event: { type: "run_started", runId: "run-a" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", event: { type: "ask_user", request: { runId: "run-a" } } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", event: { type: "ask_user", request: { runId: "run-stale" } } })).toBe(false);
  });

  it("rejects malformed payloads and supports a session reset", () => {
    const gate = new ChatEventGate();
    expect(gate.accept({ sessionId: "", event: { type: "run_started" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: -1, event: { type: "run_started" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: 1, event: { type: "run_started", runId: "run-a" } })).toBe(true);
    gate.reset("s1");
    expect(gate.accept({ sessionId: "s1", sequence: 1, event: { type: "run_started", runId: "run-b" } })).toBe(true);
  });

  it("does not let a retired run-start identity replace a fresh run", () => {
    const gate = new ChatEventGate();
    expect(gate.accept({ sessionId: "s1", sequence: 1, event: { type: "run_started", runId: "run-a" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 2, event: { type: "run_completed", runId: "run-a" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 3, event: { type: "run_started", runId: "run-b" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 4, event: { type: "run_started", runId: "run-a" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: 5, event: { type: "stream", runId: "run-b" } })).toBe(true);
  });

  it("only advances the accepted sequence after the run identity fence passes", () => {
    const gate = new ChatEventGate();
    expect(gate.accept({ sessionId: "s1", sequence: 1, event: { type: "run_started", runId: "run-a" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 2, event: { type: "run_started", runId: "run-b" } })).toBe(true);
    expect(gate.accept({ sessionId: "s1", sequence: 100, event: { type: "stream", runId: "run-a" } })).toBe(false);
    expect(gate.accept({ sessionId: "s1", sequence: 3, event: { type: "stream", runId: "run-b" } })).toBe(true);
  });
});

