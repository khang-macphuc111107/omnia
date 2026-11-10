import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

/** Execute the actual callback with in-memory dependencies; never native IPC. */
function questionHandler(question) {
  const fileName = "src/rebuild/chat/chat-controller.ts";
  const source = readFileSync(resolve(root, fileName), "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hook = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "useChatWorkspace");
  assert.ok(hook?.body, "Reviewed chat hook must remain present");
  const declaration = hook.body.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === "answerQuestion"));
  assert.ok(declaration, "Reviewed answerQuestion callback must remain present");
  const compiled = ts.transpileModule(`${declaration.getText(ast)}\nexports.answerQuestion = answerQuestion;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const calls = [];
  const errors = [];
  const context = {
    exports: {},
    useCallback: (callback) => callback,
    activeId: "session-1",
    activeSession: { localOnly: false },
    questions: { "session-1": [question] },
    isDesktopRuntime: () => true,
    invokeCore: async (...args) => { calls.push(args); },
    setQuestions: () => undefined,
    setError: (error) => { errors.push(error); },
  };
  vm.runInNewContext(compiled.outputText, context, { filename: fileName });
  return { answerQuestion: context.exports.answerQuestion, calls, errors };
}

const question = (allowFreeText = false) => ({ id: "question-1", prompt: "Choose a strategy", options: ["Recommended strategy", "Alternative"], allowFreeText, runId: "run-1", revision: 1 });

test("option-only ask-user requests accept an advertised option", async () => {
  const handler = questionHandler(question());
  await handler.answerQuestion("question-1", "Recommended strategy");
  assert.equal(handler.calls.length, 1, "A valid option must be submitted even when free text is disabled");
  assert.equal(handler.calls[0][0], "agent_user_input");
  assert.equal(handler.calls[0][1].request.answer, "Recommended strategy");
});

test("option-only ask-user requests reject unadvertised free text", async () => {
  const handler = questionHandler(question());
  await handler.answerQuestion("question-1", "Unadvertised custom text");
  assert.equal(handler.calls.length, 0);
  assert.match(handler.errors.at(-1), /free.text|provided options/i);
});

test("option-only ask-user requests still allow explicit cancellation", async () => {
  const handler = questionHandler(question());
  await handler.answerQuestion("question-1", null);
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0][1].request.answer, null);
});

test("free-text ask-user requests accept an explicit custom answer", async () => {
  const handler = questionHandler(question(true));
  await handler.answerQuestion("question-1", "A custom strategy");
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.calls[0][1].request.answer, "A custom strategy");
});
