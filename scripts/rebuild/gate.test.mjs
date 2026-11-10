import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRepo, collectEntryGraph, docHashes, evidenceHash, validateCriterionEvidence, validateResearchRegistry, validateStageTransition } from "./gate-lib.mjs";

test("canonical repo and source identity normalization are stable", () => {
  assert.equal(canonicalRepo("HTTPS://GitHub.com/Org/Repo.git/"), "https://github.com/org/repo");
});

test("evidence hash changes when evidence changes", () => {
  const root = mkdtempSync(join(tmpdir(), "omnia-gate-"));
  writeFileSync(join(root, "evidence.txt"), "before\n");
  const first = evidenceHash(root, "evidence.txt");
  writeFileSync(join(root, "evidence.txt"), "after\n");
  assert.notEqual(first, evidenceHash(root, "evidence.txt"));
});

test("entry graph reports missing relative imports", () => {
  const root = mkdtempSync(join(tmpdir(), "omnia-graph-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tsx"), 'import "./rebuild/App";\n');
  const graph = collectEntryGraph(root);
  assert.deepEqual(graph.missing, ["src/main.tsx -> ./rebuild/App"]);
});

test("canonical hashes include only existing documents", () => {
  const root = mkdtempSync(join(tmpdir(), "omnia-hashes-"));
  mkdirSync(join(root, "docs/rebuild"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "contract\n");
  assert.equal(typeof docHashes(root)["AGENTS.md"], "string");
  assert.equal(docHashes(root)["docs/rebuild/GOAL.md"], undefined);
});

test("forged done criterion without evidence or independent review is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "omnia-done-"));
  const errors = validateCriterionEvidence(root, { id: "X", status: "done", owner: "same", reviewer: "same", evidence: [], blockers: [] });
  assert.ok(errors.some((error) => error.includes("no direct evidence")));
  assert.ok(errors.some((error) => error.includes("distinct owner")));
});

test("changed evidence is rejected by stored hash", () => {
  const root = mkdtempSync(join(tmpdir(), "omnia-stale-"));
  writeFileSync(join(root, "receipt.md"), "v1");
  const before = evidenceHash(root, "receipt.md");
  writeFileSync(join(root, "receipt.md"), "v2");
  const errors = validateCriterionEvidence(root, { id: "X", status: "done", owner: "a", reviewer: "b", evidence: [{ path: "receipt.md", kind: "test", sha256: before }], blockers: [] });
  assert.ok(errors.some((error) => error.includes("stale")));
});

test("stage jumps and initial non-resume transitions are rejected", () => {
  assert.match(validateStageTransition(null, "implement"), /initial stage/);
  assert.match(validateStageTransition("audit", "implement"), /invalid stage transition/);
  assert.equal(validateStageTransition("verify", "review"), null);
});

test("research identity repeats are rejected", () => {
  const entry = { id: "a", canonicalRepo: "https://github.com/acme/tool.git", revision: "ABC", query: "new super tool", retrievedAt: "2026-11-08T00:00:00Z", novelty: "new path", decision: "defer", paths: [{ path: "src/main.ts", sha256: "a".repeat(64) }, { path: "src/main.ts", sha256: "b".repeat(64) }] };
  const errors = validateResearchRegistry({ schemaVersion: 1, sources: [entry] });
  assert.ok(errors.some((error) => error.includes("duplicate research source identity")));
});
