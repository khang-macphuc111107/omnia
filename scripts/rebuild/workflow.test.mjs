import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createCycle, advanceCycle, validateCycle, validateDod, validateNovelResearch, validateStageExit, fileReference, snapshotDocuments, SPEC_CHECKLIST, STAGES } from "./workflow.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnia-rebuild-gate-"));
  for (const relative of [".agents/skills/omnia-evidence-loop", "docs/rebuild"]) await mkdir(path.join(root, relative), { recursive: true });
  const files = {
    "AGENTS.md": "contract",
    ".agents/skills/omnia-evidence-loop/SKILL.md": "skill",
    "docs/rebuild/GOAL.md": "goal",
    "docs/rebuild/WORKFLOW.md": "workflow",
    "docs/rebuild/SPEC.md": "spec",
    "docs/rebuild/DOD.json": "dod",
    "docs/rebuild/SOURCE_REGISTER.json": "sources",
    "docs/rebuild/CHECKPOINT.md": "checkpoint",
    "docs/rebuild/ASSIGNMENTS.md": "assignments",
  };
  for (const [relative, content] of Object.entries(files)) await writeFile(path.join(root, relative), content);
  await mkdir(path.join(root, "src/rebuild"), { recursive: true });
  await writeFile(path.join(root, "src/main.tsx"), 'import "./rebuild/app.tsx";\n');
  await writeFile(path.join(root, "src/rebuild/app.tsx"), 'export const app = "original";\n');
  await writeFile(path.join(root, "source.txt"), "tested source");
  await writeFile(path.join(root, "other.txt"), "unrelated source");
  await writeFile(path.join(root, "output.txt"), "passing test output");
  await writeFile(path.join(root, "docs/rebuild/DOD.json"), JSON.stringify(dod()));
  await writeFile(path.join(root, "docs/rebuild/SOURCE_REGISTER.json"), JSON.stringify({ schemaVersion: 1, sources: [] }));
  return root;
}

function dod(status = "planned") {
  return { schemaVersion: 1, criteria: [{ id: "RB-1", category: "gate", requirement: "Gate", acceptance: "observable", verification: "receipt", requiredEvidence: ["test"], dependencies: [], owner: "root", status, evidence: [], blockers: [], review: null }] };
}

test("rejects forged Done without evidence and independent review", async () => {
  const root = await fixture();
  await assert.rejects(validateDod(root, dod("done")), /missing required test evidence|review/);
});

test("rejects duplicate or pre-cycle research and requires source snapshot", async () => {
  const root = await fixture();
  const entry = { canonicalRepo: "https://github.com/example/repo", revision: "abc", path: "src/x.ts", license: "MIT", query: "new", retrievedAt: new Date().toISOString(), decision: "defer", observation: "o", strength: "s", weakness: "w", impact: "i", sha256: "a".repeat(64), sourceEvidence: { path: "docs/rebuild/WORKFLOW.md", sha256: "b".repeat(64) } };
  await assert.rejects(validateNovelResearch(root, [entry], [], { since: new Date(Date.now() - 1000).toISOString() }), /stale hash|differs/);
  await assert.rejects(validateNovelResearch(root, [entry, entry], [], { since: new Date(Date.now() - 1000).toISOString() }), /stale hash|differs/);
});

test("accepts CRLF transport for a receipt hashed from the committed LF text", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "portable.txt"), "line one\r\nline two\r\n");
  const expected = await fileReference(root, "portable.txt");
  const lfHash = (await readFile(path.join(root, "portable.txt"), "utf8"))
    .replace(/\r\n?/gu, "\n");
  const { createHash } = await import("node:crypto");
  expected.sha256 = createHash("sha256").update(lfHash).digest("hex");
  const { verifyReference } = await import("./workflow.mjs");
  const verified = await verifyReference(root, expected, "portable evidence");
  assert.match(verified.sha256, /^[a-f0-9]{64}$/u);
});

test("rejects skipped stages and cancellation requires a reason", async () => {
  const root = await fixture();
  const register = { schemaVersion: 1, sources: [] };
  const cycle = await createCycle(root, { id: "cycle-1", author: "root", criteria: ["RB-1"], register });
  await assert.rejects(advanceCycle(root, cycle, { to: "implement", event: "advance" }, { dod: dod() }), /skip/);
  await assert.rejects(advanceCycle(root, cycle, { event: "cancel" }, { dod: dod() }), /reason/);
  const cancelled = await advanceCycle(root, cycle, { event: "cancel", reason: "user stopped" }, { dod: dod() });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(STAGES.slice(0, 2), ["resume", "audit"]);
});

test("cycle failure creates a new generation and returns to implementation", async () => {
  const root = await fixture();
  const cycle = await createCycle(root, { id: "cycle-2", author: "root", criteria: ["RB-1"], register: { schemaVersion: 1, sources: [] } });
  const failed = await advanceCycle(root, { ...cycle, stage: "verify", history: [...cycle.history, { stage: "audit", generation: 1, at: new Date().toISOString(), event: "advance" }, { stage: "research", generation: 1, at: new Date().toISOString(), event: "advance" }, { stage: "synthesize", generation: 1, at: new Date().toISOString(), event: "advance" }, { stage: "plan", generation: 1, at: new Date().toISOString(), event: "advance" }, { stage: "implement", generation: 1, at: new Date().toISOString(), event: "advance" }, { stage: "verify", generation: 1, at: new Date().toISOString(), event: "advance" }] }, { event: "failure", reason: "test failed" }, { dod: dod() });
  assert.equal(failed.stage, "implement");
  assert.equal(failed.generation, 2);
});

async function json(root, relative, value) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
  return fileReference(root, relative);
}

async function commandReceipt(root, relative = "test-receipt.json", sources = ["source.txt"]) {
  return json(root, relative, { schemaVersion: 1, result: "passed", scope: "fixture", recordedAt: "2026-11-08T00:00:00.000Z", command: "node --test fixture.test.mjs", exitCode: 0, output: await fileReference(root, "output.txt"), sourceFiles: await Promise.all(sources.map((p) => fileReference(root, p))) });
}

async function reviewFixture(root, criterion) {
  const sourceFiles = [await fileReference(root, "source.txt")];
  const testEvidence = criterion.evidence.filter((e) => e.kind === "test").map(({path,sha256}) => ({path,sha256}));
  const receipt = { schemaVersion: 1, author: "root", reviewer: "independent", reviewedAt: new Date().toISOString(), result: "passed", unresolved: [], criteria: ["RB-1"], sourceFiles, testEvidence };
  const evidence = await json(root, "review.json", receipt);
  criterion.review = { author: receipt.author, reviewer: receipt.reviewer, reviewedAt: receipt.reviewedAt, result: receipt.result, unresolved: [], sourceFiles, testEvidence, evidence };
  return receipt;
}

async function evidencedDod(root) {
  const value = dod("done");
  value.criteria[0].requiredEvidence = ["source", "test"];
  value.criteria[0].evidence = [await fileReference(root, "source.txt", "source"), { ...await commandReceipt(root), kind: "test" }];
  await reviewFixture(root, value.criteria[0]);
  return value;
}

async function cycleFixture(root, target = "verify") {
  const cycle = await createCycle(root, { id: "typed-cycle", author: "root", criteria: ["RB-1"], register: { schemaVersion: 1, sources: [] } });
  const source = await fileReference(root, "source.txt");
  const testReceipt = { ...await commandReceipt(root), kind: "test" };
  const buildReceipt = { ...await commandReceipt(root, "build.json"), kind: "build" };
  const artifact = async (stage, value) => ({ ...await json(root, `${stage}.json`, { schemaVersion: 1, stage, cycleId: cycle.id, recordedAt: new Date().toISOString(), ...value }), stage, generation: 1 });
  cycle.artifacts.push(await artifact("audit", { observations: ["gap"] }));
  cycle.research.push({ canonicalRepo: "https://github.com/example/novel", revision: "abc", path: "source.txt", sha256: source.sha256, license: "MIT", query: "everything agent", retrievedAt: new Date().toISOString(), decision: "defer", observation: "Observed source", strength: "Small contract", weakness: "Fixture only", impact: "RB-1", sourceEvidence: source });
  cycle.artifacts.push(await artifact("research", { observations: ["novel fixture"] }));
  cycle.artifacts.push(await artifact("synthesize", { observations: [{ source: "https://github.com/example/novel", observation: "Observed boundary", strength: "Explicit", weakness: "Fixture", decision: "defer", criteria: ["RB-1"] }], workbench: { sourceFiles: [source], buildEvidence: buildReceipt } }));
  cycle.artifacts.push(await artifact("plan", { passBudget: 3, passes: [{ index: 1, decision: "Use typed acceptance" }], stopReason: "no-new-decision", stopDetail: "Additional passes added no decision", tasks: [{ id: "task-1", criteria: ["RB-1"], owner: "root", dependencies: [], inputs: ["source.txt"], outputs: ["source.txt"], acceptance: [{ metric: "failed tests", operator: "eq", value: 0 }], verification: [{ command: "node --test fixture.test.mjs", expectedExitCode: 0 }] }] }));
  cycle.artifacts.push(await artifact("implement", { changes: [{ criteria: ["RB-1"], owner: "root", summary: "Implement fixture", sourceFiles: [source] }], limitations: ["Fixture only"] }));
  cycle.artifacts.push({ ...testReceipt, stage: "verify", generation: 1 });
  let current = cycle;
  while (current.stage !== target) current = await advanceCycle(root, current, { to: STAGES[STAGES.indexOf(current.stage) + 1] }, { dod: dod() });
  return current;
}

test("failure recovery reuses immutable pre-implementation artifacts and validates", async () => {
  const root = await fixture();
  const original = await cycleFixture(root);
  const recovered = await advanceCycle(root, original, { event: "failure", reason: "diagnosed transient test failure" }, { dod: dod() });
  assert.equal((await validateCycle(root, recovered, { dod: dod() })).generation, 2);
  const impl = recovered.artifacts.find((e) => e.stage === "implement");
  recovered.artifacts.push({ ...impl, generation: 2 });
  const verify = recovered.artifacts.find((e) => e.stage === "verify");
  recovered.artifacts.push({ ...verify, generation: 2 });
  const next = await advanceCycle(root, recovered, { to: "verify" }, { dod: dod() });
  assert.equal((await validateCycle(root, next, { dod: dod() })).stage, "verify");
});

test("failure recovery rejects changed carried source instead of inventing a new audit", async () => {
  const root = await fixture();
  const recovered = await advanceCycle(root, await cycleFixture(root), { event: "failure", reason: "diagnosed" }, { dod: dod() });
  await writeFile(path.join(root, "audit.json"), "changed");
  await assert.rejects(validateCycle(root, recovered, { dod: dod() }), /stale hash/);
});

test("completed and cancelled statuses must agree with stage and history", async () => {
  const root = await fixture();
  const cycle = await createCycle(root, { id: "state", author: "root", criteria: ["RB-1"], register: { schemaVersion: 1, sources: [] } });
  await assert.rejects(validateCycle(root, { ...cycle, status: "completed" }, { dod: dod() }), /completed|status/);
  await assert.rejects(validateCycle(root, { ...cycle, status: "cancelled" }, { dod: dod() }), /cancel|status/);
});

test("Done review covers the criterion source and tested source", async () => {
  const root = await fixture();
  const good = await evidencedDod(root);
  assert.equal((await validateDod(root, good, { complete: true })).complete, true);
  good.criteria[0].evidence.push(await fileReference(root, "other.txt", "source"));
  await assert.rejects(validateDod(root, good), /review.*cover|review.*source|unreviewed/i);
});

test("review declaration cannot overrule unresolved or mismatching receipt", async () => {
  const root = await fixture();
  const value = await evidencedDod(root);
  const criterion = value.criteria[0];
  const receipt = JSON.parse(await readFile(path.join(root, "review.json"), "utf8"));
  receipt.result = "changes_required";
  receipt.unresolved = ["source not inspected"];
  criterion.review.evidence = await json(root, "review.json", receipt);
  await assert.rejects(validateDod(root, value), /receipt|unresolved/i);
});

test("review must bind required criterion IDs and command receipts", async () => {
  const root = await fixture();
  const value = await evidencedDod(root);
  const receipt = JSON.parse(await readFile(path.join(root, "review.json"), "utf8"));
  receipt.criteria = ["different-id"];
  value.criteria[0].review.evidence = await json(root, "review.json", receipt);
  await assert.rejects(validateDod(root, value), /criterion|criteria/i);
  receipt.criteria = ["RB-1"];
  receipt.testEvidence = [];
  value.criteria[0].review.evidence = await json(root, "review.json", receipt);
  await assert.rejects(validateDod(root, value), /receipt|test evidence/i);
});

test("all blocker records require real attempts, workaround and next action", async () => {
  const root = await fixture();
  for (const status of ["partial", "blocked"]) {
    const value = dod(status);
    value.criteria[0].blockers = [{ cause: "blocked", attempts: [null], resolution: "fix" }];
    await assert.rejects(validateDod(root, value), /blocker|attempt/i);
    value.criteria[0].blockers = [{ cause: "blocked", attempts: ["read source"], resolution: "fix", workaround: "explicit unavailable state", nextAction: "implement native seam" }];
    assert.equal((await validateDod(root, value))[status], 1);
  }
});

test("typed plan rejects arbitrary Markdown, excess passes and unbounded tasks", async () => {
  const root = await fixture();
  const cycle = await cycleFixture(root, "plan");
  const a = cycle.artifacts.find((e) => e.stage === "plan");
  const valid = JSON.parse(await readFile(path.join(root, a.path), "utf8"));
  for (const broken of [{ passBudget: 11 }, { tasks: [] }, { passes: [{ index: 1, decision: "" }] }, { tasks: [{ ...valid.tasks[0], acceptance: [] }] }]) {
    Object.assign(a, await json(root, a.path, { ...valid, ...broken }));
    await assert.rejects(validateStageExit(root, cycle, { dod: dod() }), /plan|task|pass|acceptance/i);
  }
});

test("synthesis must bind runnable workbench source and passing build", async () => {
  const root = await fixture();
  const cycle = await cycleFixture(root, "synthesize");
  const a = cycle.artifacts.find((e) => e.stage === "synthesize");
  Object.assign(a, await json(root, a.path, { schemaVersion: 1, stage: "synthesize", cycleId: cycle.id, recordedAt: new Date().toISOString(), observations: ["read source"] }));
  await assert.rejects(validateStageExit(root, cycle, { dod: dod() }), /synthes|workbench|observation/i);
});

test("publication exit cannot be satisfied with an arbitrary hashed file", async () => {
  const root = await fixture();
  const cycle = await cycleFixture(root);
  cycle.stage = "publish";
  cycle.reads.after = await snapshotDocuments(root);
  cycle.artifacts.push({ ...await fileReference(root, "source.txt"), stage: "publish", generation: 1 });
  await assert.rejects(validateStageExit(root, cycle, { dod: dod() }), /publish|JSON|Unexpected/i);
});

test("default check rejects stale cycle while structural-only diagnostic is explicit", async () => {
  const root = await fixture();
  const cycle = await createCycle(root, { id: "stale", author: "root", criteria: ["RB-1"], register: { schemaVersion: 1, sources: [] } });
  await json(root, ".agents/checkpoints/rebuild-cycle.json", cycle);
  await writeFile(path.join(root, "docs/rebuild/SPEC.md"), "changed spec");
  const cli = fileURLToPath(new URL("./check.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /stale hash/);
  const structural = spawnSync(process.execPath, [cli, "--structural-only"], { cwd: root, encoding: "utf8" });
  assert.equal(structural.status, 0, structural.stderr);
  assert.equal(JSON.parse(structural.stdout).scope, "structural-only");
});

test("default registry check rejects malformed source hashes", async () => {
  const root = await fixture();
  const register = { schemaVersion: 1, sources: [{ id: "bad", canonicalRepo: "https://github.com/example/repo", revision: "abc", license: "MIT", query: "everything", retrievedAt: new Date().toISOString(), novelty: "new", decision: "defer", strengths: ["s"], weaknesses: ["w"], paths: [{ path: "source.txt", sha256: "not-hashed" }] }] };
  await json(root, "docs/rebuild/SOURCE_REGISTER.json", register);
  const cycle = await createCycle(root, { id: "registry", author: "root", criteria: ["RB-1"], register });
  await json(root, ".agents/checkpoints/rebuild-cycle.json", cycle);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check.mjs", import.meta.url))], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /SHA-256|sha256|hash/);
});

test("structural-only mode intentionally skips receipt freshness but still checks references", async () => {
  const root = await fixture();
  const value = dod("partial");
  value.criteria[0].evidence = [{ path: "source.txt", kind: "test", sha256: "a".repeat(64) }];
  assert.equal((await validateDod(root, value, { skipEvidence: true })).partial, 1);
  await assert.rejects(validateDod(root, value), /stale hash/);
});

test("full failure recovery advances through independent review and document reread", async () => {
  const root = await fixture();
  let cycle = await advanceCycle(root, await cycleFixture(root), { event: "failure", reason: "regression diagnosed and fixed" }, { dod: dod() });
  for (const stage of ["implement", "verify"]) {
    const old = cycle.artifacts.find((entry) => entry.stage === stage);
    cycle.artifacts.push({ ...old, generation: 2 });
  }
  cycle = await advanceCycle(root, cycle, { to: "verify" }, { dod: dod() });
  cycle = await advanceCycle(root, cycle, { to: "review" }, { dod: dod() });
  const criterion = (await evidencedDod(root)).criteria[0];
  cycle.review = criterion.review;
  cycle = await advanceCycle(root, cycle, { to: "document" }, { dod: dod() });
  cycle.checklist = Object.fromEntries(SPEC_CHECKLIST.map((name) => [name, true]));
  cycle.reads.after = await snapshotDocuments(root);
  cycle.artifacts.push({ ...await json(root, "document.json", { reviewed: true }), stage: "document", generation: 2 });
  cycle = await advanceCycle(root, cycle, { to: "publish" }, { dod: dod() });
  assert.equal((await validateCycle(root, cycle, { dod: dod() }, { milestone: true })).stage, "publish");
  assert.equal(cycle.status, "active");
  await writeFile(path.join(root, "docs/rebuild/SPEC.md"), "drift after final reread");
  await assert.rejects(validateCycle(root, cycle, { dod: dod() }, { milestone: true }), /stale hash/);
});

test("cycle review cannot bind an unrelated implementation or test", async () => {
  const root = await fixture();
  const cycle = await cycleFixture(root, "review");
  cycle.review = (await evidencedDod(root)).criteria[0].review;
  const unrelated = await fileReference(root, "other.txt");
  const receipt = JSON.parse(await readFile(path.join(root, "review.json"), "utf8"));
  receipt.sourceFiles = [unrelated];
  cycle.review.sourceFiles = [unrelated];
  cycle.review.evidence = await json(root, "review.json", receipt);
  await assert.rejects(validateStageExit(root, cycle, { dod: dod() }), /source coverage.*does not cover/);
});

test("planning rejects cycles and criteria omitted from atomic tasks", async () => {
  const root = await fixture();
  const cycle = await cycleFixture(root, "plan");
  const artifact = cycle.artifacts.find((entry) => entry.stage === "plan");
  const record = JSON.parse(await readFile(path.join(root, artifact.path), "utf8"));
  const first = record.tasks[0];
  first.dependencies = ["task-2"];
  record.tasks.push({ ...first, id: "task-2", dependencies: ["task-1"] });
  Object.assign(artifact, await json(root, artifact.path, record));
  await assert.rejects(validateStageExit(root, cycle, { dod: dod() }), /dependency cycle/);
});

test("synthesis rejects source observations outside reviewed research", async () => {
  const root = await fixture();
  const cycle = await cycleFixture(root, "synthesize");
  const artifact = cycle.artifacts.find((entry) => entry.stage === "synthesize");
  const record = JSON.parse(await readFile(path.join(root, artifact.path), "utf8"));
  record.observations[0].source = "https://github.com/unread/repo";
  Object.assign(artifact, await json(root, artifact.path, record));
  await assert.rejects(validateStageExit(root, cycle, { dod: dod() }), /not bound/);
});

test("structural-only mode cannot be combined with milestone or completion", async () => {
  const root = await fixture();
  const cli = fileURLToPath(new URL("./check.mjs", import.meta.url));
  for (const flag of ["--milestone", "--complete"]) {
    const result = spawnSync(process.execPath, [cli, "--structural-only", flag], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot claim/);
  }
});
