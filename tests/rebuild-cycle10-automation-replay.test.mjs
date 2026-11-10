import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const automationRoot = resolve(root, "src/rebuild/automation");

/** Run actual renderer domain source without React, Tauri, storage or a model. */
function automationModule(name) {
  const cache = new Map();
  function load(fileName) {
    const file = resolve(automationRoot, fileName);
    assert.ok(file.startsWith(`${automationRoot}\\`) || file.startsWith(`${automationRoot}/`), "Only reviewed automation source may load");
    if (cache.has(file)) return cache.get(file).exports;
    const source = readFileSync(file, "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    const module = { exports: {} };
    cache.set(file, module);
    const require = (specifier) => {
      assert.ok(specifier.startsWith("."), `Unexpected dependency ${specifier}`);
      return load(resolve(dirname(file), `${specifier}.ts`));
    };
    vm.runInNewContext(compiled.outputText, { exports: module.exports, module, require, TextEncoder, structuredClone, crypto: webcrypto }, { filename: file });
    return module.exports;
  }
  return load(`${name}.ts`);
}

const participants = [
  { agentId: "builder", goalId: "goal-1", role: "implementer", allowedRecipientIds: ["reviewer"] },
  { agentId: "reviewer", goalId: "goal-1", role: "reviewer", allowedRecipientIds: ["builder"] },
];
const message = { id: "message-1", senderId: "builder", recipientId: "reviewer", goalId: "goal-1", role: "implementer", body: "Please review the receipt.", idempotencyKey: "send-1" };
const task = (id = "task-1") => ({ id, owner: "builder", files: ["src/example.ts"], input: "Requirement", output: "Implementation", verification: "Focused test" });

test("a legitimate discussion with a delivered message survives reload", async () => {
  const { DiscussionChannel } = automationModule("discussion");
  const channel = new DiscussionChannel("goal-1", participants);
  channel.send(message, 0, "builder");
  const restored = await DiscussionChannel.restore(channel.serialize());
  assert.deepEqual(restored.snapshot(), channel.snapshot());
});

test("an outer goal cannot finalize while its child is still active", () => {
  const { GoalLedger } = automationModule("goals");
  const ledger = new GoalLedger({ id: "outer", objective: "Complete outcome", plan: [task()] });
  ledger.addChild("outer", { id: "child", objective: "Required slice", plan: [task("child-task")] }, 0);
  ledger.completeTask("outer", "task-1", ["test:outer"], 1);
  assert.throws(() => ledger.report({ id: "outer-final", goalId: "outer", kind: "final", summary: "Complete", evidence: ["receipt:outer"] }, 2), /child|incomplete/i,
    "A terminal outer goal would orphan the child's required final evidence");
  assert.equal(ledger.snapshot().goals.find((goal) => goal.id === "outer").status, "active");
});

test("zero-pass brainstorming cannot reload into an active state", async () => {
  const { BrainstormSession } = automationModule("brainstorm");
  const session = new BrainstormSession("goal-1", 0);
  const forged = JSON.parse(session.serialize());
  forged.state.status = "active";
  forged.state.stopReason = null;
  await assert.rejects(async () => BrainstormSession.restore(JSON.stringify(forged)), /replay|state|disabled|pass/i,
    "Reload must validate the zero-pass stop invariant, not trust the status field");
});

test("enhancement reload rejects changed proposal bytes with an unchanged receipt hash", async () => {
  const { PromptEnhancement } = automationModule("enhancement");
  const enhancement = new PromptEnhancement("Preserve original intent", []);
  await enhancement.propose({ id: "proposal-1", proposedPrompt: "Preserve original intent and collect evidence", selectedContextIds: [], rationale: "Add verification" }, 0);
  const forged = JSON.parse(enhancement.serialize());
  forged.state.proposal.proposedPrompt = "Altered after the reviewed hash was recorded";
  await assert.rejects(async () => PromptEnhancement.restore(JSON.stringify(forged)), /hash|lineage|replay/i,
    "A reloaded proposal must not accept bytes inconsistent with its hash receipt");
});

test("collaboration reload rejects changed attempt output with an unchanged hash", async () => {
  const { CollaborationRun } = automationModule("collaboration");
  const run = new CollaborationRun("task-1");
  await run.recordAttempt({ id: "attempt-1", model: "model-a", prompt: "Solve the task", status: "succeeded", output: "Reviewed result" }, 0);
  const forged = JSON.parse(run.serialize());
  forged.state.attempts[0].output = "Altered output";
  await assert.rejects(async () => CollaborationRun.restore(JSON.stringify(forged)), /hash|lineage|replay/i,
    "Attempt output must still match its recorded lineage after reload");
});
