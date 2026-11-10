import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
function compiledModule(relative, globals = {}, omit = new Set()) {
  const source = readFileSync(resolve(root, relative), "utf8");
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter((node) => !ts.isImportDeclaration(node) && !(ts.isFunctionDeclaration(node) && omit.has(node.name?.text))).map((node) => node.getText(ast)).join("\n");
  const { outputText } = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  vm.runInNewContext(outputText, { exports, crypto: webcrypto, TextEncoder, ...globals }, { filename: relative });
  return exports;
}
function workflow(scope = { projectId: "project_old" }, overrides = {}) {
  const model = compiledModule("src/rebuild/workflow/workflow-model.ts");
  const { WorkflowController } = compiledModule("src/rebuild/workflow/workflow-controller.ts", model, new Set(["createNativeWorkflowApi"]));
  let reject;
  const pending = new Promise((_, no) => { reject = no; });
  let writes = 0;
  const api = { available: () => true, createGoal: () => { writes += 1; return writes === 1 ? pending : Promise.reject({ code: "permission_denied", message: "Second write rejected by test dependency" }); }, listGoals: async () => [], ...overrides };
  return { controller: new WorkflowController(api, scope), reject, draft: { ...model.EMPTY_GOAL, title: "Original intent" }, get writes() { return writes; } };
}
const unknown = { code: "transport_closed", message: "Native delivery outcome unknown", acceptance: "unknown", retryable: true };

test("unknown workflow writes remain fenced when switching away and back", async () => {
  const run = workflow();
  const first = run.controller.createGoal(run.draft);
  run.reject(unknown);
  await first;
  assert.equal(run.controller.getSnapshot().mutationUncertain, true);
  run.controller.setScope({ projectId: "project_other" });
  run.controller.setScope({ projectId: "project_old" });
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 1, "Returning to a scope must require reconciliation before a second write");
});

test("a write that becomes unknown after scope change is fenced on return", async () => {
  const run = workflow();
  const first = run.controller.createGoal(run.draft);
  run.controller.setScope({ projectId: "project_other" });
  run.reject(unknown);
  await first;
  run.controller.setScope({ projectId: "project_old" });
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 1, "A stale UI epoch cannot erase an unknown accepted native mutation");
});

test("display-only chat session context does not bypass a native-scope fence", async () => {
  const run = workflow({ projectId: "project_old", sessionId: "chat_old" });
  const first = run.controller.createGoal(run.draft);
  run.reject(unknown);
  await first;
  run.controller.setScope({ sessionId: "chat_new", projectId: "project_old" });
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 1, "Harness session IDs are display context, not different native workflow scopes");
});

test("refreshing another native scope does not reconcile the original write", async () => {
  const run = workflow();
  const first = run.controller.createGoal(run.draft);
  run.reject(unknown);
  await first;
  run.controller.setScope({ projectId: "project_other" });
  await run.controller.refresh();
  run.controller.setScope({ projectId: "project_old" });
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 1, "An unrelated list result cannot acknowledge an original-scope write");
});

test("failed native reconciliation retains the unknown write fence", async () => {
  const run = workflow(undefined, { listGoals: async () => { throw { code: "transport_closed", message: "Read failed" }; } });
  const first = run.controller.createGoal(run.draft);
  run.reject(unknown);
  await first;
  await run.controller.refresh();
  assert.equal(run.controller.getSnapshot().mutationUncertain, true);
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 1);
});

test("authoritative current-scope reconciliation permits a later explicit write", async () => {
  const run = workflow();
  const first = run.controller.createGoal(run.draft);
  run.reject(unknown);
  await first;
  await run.controller.refresh();
  assert.equal(run.controller.getSnapshot().mutationUncertain, false);
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 2, "A reconciled scope may accept a new explicit user mutation");
});

test("a cancelled reconciliation read cannot clear the unknown fence", async () => {
  let finish;
  const reading = new Promise((yes) => { finish = yes; });
  const run = workflow(undefined, { listGoals: () => reading });
  const first = run.controller.createGoal(run.draft);
  run.reject(unknown);
  await first;
  const refresh = run.controller.refresh();
  run.controller.cancelRead();
  finish([]);
  await refresh;
  assert.equal(run.controller.getSnapshot().mutationUncertain, true);
  await run.controller.createGoal(run.draft);
  assert.equal(run.writes, 1);
});
