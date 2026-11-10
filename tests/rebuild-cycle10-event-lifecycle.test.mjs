import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

/**
 * Execute the real gate without loading React/Tauri. This proves the gate's
 * in-process domain behavior only, never native IPC delivery or a packaged app.
 */
function eventGate() {
  const fileName = "src/rebuild/chat/chat-controller.ts";
  const source = readFileSync(resolve(root, fileName), "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const gate = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "ChatEventGate");
  const runId = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "readRunId");
  assert.ok(gate && runId, "Reviewed gate and run-ID reader must remain present");
  const compiled = ts.transpileModule(`${gate.getText(ast)}\n${runId.getText(ast)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const context = { exports: {} };
  vm.runInNewContext(compiled.outputText, context, { filename: fileName });
  return new context.exports.ChatEventGate();
}

for (const terminal of ["run_completed", "run_finished", "cancelled", "error"]) {
  test(`same-run stream is rejected after ${terminal}`, () => {
    const gate = eventGate();
    assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
    assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: terminal, runId: "run-1" } }), true);
    assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "stream", runId: "run-1", event: { type: "text_delta", text: "late" } } }), false,
      "Terminal state must prevent late same-run text from changing the transcript");
  });
  test(`same-run question is rejected after ${terminal}`, () => {
    const gate = eventGate();
    assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
    assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: terminal, runId: "run-1" } }), true);
    assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "ask_user", runId: "run-1", id: "late-question", prompt: "Stale question" } }), false,
      "Terminal state must prevent a late same-run question from reopening actionable input");
  });
}

test("turn completion does not close the whole run", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "turn_completed", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "turn_started", runId: "run-1", turn: 2 } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 4, event: { type: "stream", runId: "run-1", event: { type: "text_delta", text: "next turn" } } }), true);
});

test("a fresh run can stream after the previous run terminalizes", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "run_completed", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "run_started", runId: "run-2" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 4, event: { type: "stream", runId: "run-2", event: { type: "text_delta", text: "current" } } }), true);
});

test("terminal state is isolated to its session", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-2", sequence: 1, event: { type: "run_started", runId: "run-2" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "cancelled", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-2", sequence: 2, event: { type: "stream", runId: "run-2", event: { type: "text_delta", text: "active" } } }), true);
});

test("a late same-run turn cannot reopen a terminal run", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "run_completed", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "turn_started", runId: "run-1", turn: 2 } }), false,
    "A late turn_started from the completed run must not clear its terminal fence");
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 4, event: { type: "stream", runId: "run-1", event: { type: "text_delta", text: "late" } } }), false,
    "A late delta after a rejected turn_started must remain blocked");
});

test("a terminal run identity cannot be reused to reopen the run", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "cancelled", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "run_started", runId: "run-1" } }), false,
    "The completed identity cannot be reused to reopen a terminal run");
});

test("an ID-less start cannot reopen terminal work", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "cancelled", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 4, event: { type: "run_started" } }), false,
    "An ID-less start cannot be distinguished from a late replay after terminalization");
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 5, event: { type: "stream", event: { type: "text_delta", text: "ambiguous" } } }), false,
    "ID-less events remain fenced until a new run identity is observed");
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 6, event: { type: "run_started", runId: "run-2" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 7, event: { type: "stream", runId: "run-2", event: { type: "text_delta", text: "current" } } }), true);
});

test("an old turn start cannot replace the active run fence", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "run_started", runId: "run-2" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "turn_started", runId: "run-1" } }), false,
    "A stale turn must not replace the active run ID");
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 4, event: { type: "ask_user", runId: "run-1", id: "stale", prompt: "Do not show" } }), false);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 5, event: { type: "stream", runId: "run-2", event: { type: "text_delta", text: "current" } } }), true,
    "Rejecting an old turn must preserve the current run fence");
});

test("a rejected prior-run event cannot advance the accepted sequence watermark", () => {
  const gate = eventGate();
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 1, event: { type: "run_started", runId: "run-1" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 2, event: { type: "run_started", runId: "run-2" } }), true);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 100, event: { type: "stream", runId: "run-1", event: { type: "text_delta", text: "stale" } } }), false);
  assert.equal(gate.accept({ sessionId: "session-1", sequence: 3, event: { type: "stream", runId: "run-2", event: { type: "text_delta", text: "current" } } }), true,
    "A run-identity rejection must not poison the accepted sequence watermark");
});
