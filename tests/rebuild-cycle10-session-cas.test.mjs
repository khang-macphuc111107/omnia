import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

/** Run actual controller callbacks with in-memory state/IPC, never a native claim. */
function sessionHandlers(invoke) {
  const fileName = "src/rebuild/chat/chat-controller.ts";
  const source = readFileSync(resolve(root, fileName), "utf8");
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hook = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "useChatWorkspace");
  assert.ok(hook?.body, "Reviewed chat hook must remain present");
  const names = ["renameSession", "updateSettings"];
  const updateHelper = hook.body.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === "updateSession"));
  const declarations = names.map((name) => {
    const declaration = hook.body.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name));
    assert.ok(declaration, `Reviewed ${name} callback must remain present`);
    return declaration.getText(ast);
  });
  const helpers = ["mapSession", "normalizeEffort"].map((name) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(ast) ?? "");
  const compiled = ts.transpileModule([...helpers, ...(updateHelper ? [updateHelper.getText(ast)] : []), ...declarations, ...names.map((name) => `exports.${name} = ${name};`)].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  let state = [{ id: "session-1", title: "Original", scope: "non-project", profileId: "profile-1", model: "before", permissionMode: "ask_writes", settingsRevision: 4, messageCount: 0, updatedAtMs: 0, running: false }];
  const calls = [];
  const errors = [];
  const sessionsRef = {};
  Object.defineProperty(sessionsRef, "current", { get: () => state, set: (value) => { state = value; } });
  const context = {
    exports: {},
    useCallback: (callback) => callback,
    activeId: "session-1",
    activeSession: state[0],
    activeIdRef: { current: "session-1" },
    sessionsRef,
    sessionUpdateQueues: { current: new Map() },
    sessionUpdateErrors: { current: new Map() },
    disposedRef: { current: false },
    lifecycleRevision: { current: 0 },
    isDesktopRuntime: () => true,
    invokeCore: async (...args) => { calls.push(args); return invoke(...args); },
    setSessions: (value) => { state = typeof value === "function" ? value(state) : value; },
    setError: (error) => { errors.push(error); },
    setStatus: () => undefined,
  };
  vm.runInNewContext(compiled.outputText, context, { filename: fileName });
  return {
    ...context.exports,
    calls,
    errors,
    get session() { return state[0]; },
    patchSession(patch) { state = state.map((entry) => entry.id === "session-1" ? { ...entry, ...patch } : entry); },
    dispose() { context.disposedRef.current = true; },
  };
}

const acceptedSummary = (patch = {}) => ({ id: "session-1", title: "Original", cwd: "private-scratch", scope: "projectless", profileId: "profile-1", model: "before", permissionMode: "ask_writes", settingsRevision: 5, updatedAtMs: 100, ...patch });

test("a rejected native model CAS leaves applied model and revision unchanged", async () => {
  const handler = sessionHandlers(async () => { throw new Error("agent_session_revision_conflict"); });
  await handler.updateSettings({ model: "after" }).catch(() => undefined);
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.session.model, "before", "Rejected native settings must not appear applied");
  assert.equal(handler.session.settingsRevision, 4, "Rejected CAS must not consume a local revision");
});

test("a rejected native rename keeps the authoritative title", async () => {
  const handler = sessionHandlers(async () => { throw new Error("agent_session_revision_conflict"); });
  await handler.renameSession("New title").catch(() => undefined);
  assert.equal(handler.calls.length, 1);
  assert.equal(handler.session.title, "Original", "Rejected native rename must not appear saved");
  assert.equal(handler.session.settingsRevision, 4);
});

test("an accepted native rename adopts its returned settings revision", async () => {
  const handler = sessionHandlers(async () => acceptedSummary({ title: "New title" }));
  await handler.renameSession("New title");
  assert.equal(handler.calls[0][1].request.expectedSettingsRevision, 4);
  assert.equal(handler.session.title, "New title");
  assert.equal(handler.session.settingsRevision, 5, "Rename advances native settings revision too; the next edit must use it");
});

test("an accepted native model update uses the authoritative returned model", async () => {
  const handler = sessionHandlers(async () => acceptedSummary({ model: "native-resolved-model" }));
  await handler.updateSettings({ model: "requested-model" });
  assert.equal(handler.calls[0][1].request.expectedSettingsRevision, 4);
  assert.equal(handler.session.model, "native-resolved-model", "Native returned settings are authoritative");
  assert.equal(handler.session.settingsRevision, 5);
});

test("queued native settings edits use the last accepted revision in order", async () => {
  let finishFirst;
  const first = new Promise((yes) => { finishFirst = yes; });
  let dispatch = 0;
  const handler = sessionHandlers(async () => {
    dispatch += 1;
    return dispatch === 1 ? first : acceptedSummary({ model: "second", settingsRevision: 6 });
  });
  const one = handler.updateSettings({ model: "first" });
  const two = handler.updateSettings({ model: "second" });
  await Promise.resolve();
  assert.equal(handler.calls.length, 1, "Only one native CAS may be in flight for the session");
  finishFirst(acceptedSummary({ model: "first" }));
  await Promise.all([one, two]);
  assert.equal(handler.calls.length, 2);
  assert.deepEqual(handler.calls.map((call) => call[1].request.expectedSettingsRevision), [4, 5]);
  assert.equal(handler.session.model, "second");
  assert.equal(handler.session.settingsRevision, 6);
});

test("a delayed native settings reply cannot overwrite a newer applied revision", async () => {
  let finish;
  const reply = new Promise((yes) => { finish = yes; });
  const handler = sessionHandlers(async () => reply);
  const write = handler.updateSettings({ model: "requested" });
  await Promise.resolve();
  handler.patchSession({ model: "newer", settingsRevision: 6 });
  finish(acceptedSummary({ model: "old-native-response" }));
  await write;
  assert.equal(handler.session.model, "newer");
  assert.equal(handler.session.settingsRevision, 6);
});

test("a native settings reply for another session is not applied", async () => {
  const handler = sessionHandlers(async () => acceptedSummary({ id: "session-other", model: "wrong-session" }));
  await handler.updateSettings({ model: "requested" });
  assert.equal(handler.session.model, "before");
  assert.equal(handler.session.settingsRevision, 4);
  assert.ok(handler.errors.length > 0, "Identity mismatch must remain visible");
});

for (const revision of [4, 6]) {
  test(`a native CAS acknowledgement with revision ${revision} is rejected`, async () => {
    const handler = sessionHandlers(async () => acceptedSummary({ model: "invalid-revision", settingsRevision: revision }));
    await handler.updateSettings({ model: "requested" });
    assert.equal(handler.session.model, "before");
    assert.equal(handler.session.settingsRevision, 4);
    assert.ok(handler.errors.length > 0, "Nonconsecutive acknowledgement must remain visible");
  });
}

test("disposed chat workspace ignores an accepted settings completion", async () => {
  let finish;
  const reply = new Promise((yes) => { finish = yes; });
  const handler = sessionHandlers(async () => reply);
  const write = handler.updateSettings({ model: "requested" });
  await Promise.resolve();
  handler.dispose();
  finish(acceptedSummary({ model: "late" }));
  await write;
  assert.equal(handler.session.model, "before");
  assert.equal(handler.session.settingsRevision, 4);
});
