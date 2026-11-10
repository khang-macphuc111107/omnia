import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

export const STAGES = Object.freeze([
  "resume", "audit", "research", "synthesize", "plan", "implement",
  "verify", "review", "document", "publish", "next",
]);

export const CANONICAL_DOCUMENTS = Object.freeze([
  "AGENTS.md", ".agents/skills/omnia-evidence-loop/SKILL.md",
  "docs/rebuild/GOAL.md", "docs/rebuild/WORKFLOW.md", "docs/rebuild/SPEC.md",
  "docs/rebuild/DOD.json", "docs/rebuild/SOURCE_REGISTER.json",
  "docs/rebuild/CHECKPOINT.md", "docs/rebuild/ASSIGNMENTS.md",
]);

export const SPEC_CHECKLIST = Object.freeze([
  "requirements_traced", "input_changes_reviewed", "contracts_and_resources",
  "ui_states_and_tokens", "tests_match_source", "claims_are_scoped",
  "negative_cases_and_gaps", "independent_review", "canonical_docs_reread",
  "readme_release_consistent",
]);

const STATUSES = new Set(["planned", "in_progress", "partial", "blocked", "done"]);
const HASH = /^[a-f\d]{64}$/i;
const execFileAsync = promisify(execFile);
const VERIFICATION_KINDS = new Set([
  "test", "native", "live", "runtime", "build", "performance", "accessibility", "ci",
]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableSha256(bytes) {
  // Git's text/eol attributes intentionally permit CRLF on a Windows
  // worktree while hosted runners read the same committed file as LF. Keep
  // evidence strict for content changes, but treat that transport-only
  // difference as equivalent for UTF-8 text files. Binary evidence remains
  // byte exact because NUL bytes opt out of normalization.
  if (bytes.includes(0)) return null;
  const textValue = bytes.toString("utf8");
  if (!Buffer.from(textValue, "utf8").equals(bytes)) return null;
  const normalized = Buffer.from(textValue.replace(/\r\n?/gu, "\n"), "utf8");
  return sha256(normalized);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function iso(value) {
  return text(value) && Number.isFinite(Date.parse(value));
}

/** Evidence must resolve to a real file inside the checkout, including symlinks. */
export async function resolvePortableFile(root, relative) {
  invariant(text(relative), "Evidence path is missing");
  invariant(!relative.includes("\\"), `Use repository-relative forward-slash paths: ${relative}`);
  invariant(!path.isAbsolute(relative) && !/^[a-z]:/i.test(relative), `Absolute evidence path: ${relative}`);
  const pieces = relative.split("/");
  invariant(!pieces.includes("..") && !pieces.includes("."), `Evidence path traversal: ${relative}`);
  const [actualRoot, actualFile] = await Promise.all([
    realpath(root), realpath(path.resolve(root, relative)),
  ]);
  const inside = path.relative(actualRoot, actualFile);
  invariant(inside !== "" && !inside.startsWith(`..${path.sep}`) && inside !== ".." && !path.isAbsolute(inside),
    `Evidence resolves outside checkout: ${relative}`);
  invariant((await stat(actualFile)).isFile(), `Evidence is not a file: ${relative}`);
  return actualFile;
}

export async function fileReference(root, relative, kind) {
  const file = await resolvePortableFile(root, relative);
  return { path: relative, sha256: sha256(await readFile(file)), ...(kind ? { kind } : {}) };
}

export async function verifyReference(root, reference, context = "Evidence") {
  invariant(reference && typeof reference === "object", `${context}: missing file reference`);
  invariant(HASH.test(reference.sha256 ?? ""), `${context}: missing SHA-256 for ${reference.path ?? "file"}`);
  const file = await resolvePortableFile(root, reference.path);
  const bytes = await readFile(file);
  const expected = reference.sha256.toLowerCase();
  const raw = sha256(bytes);
  const portable = portableSha256(bytes);
  invariant(raw === expected || portable === expected,
    `${context}: stale hash for ${reference.path}`);
  const actual = { path: reference.path, sha256: raw };
  return actual;
}

export async function readJson(root, relative) {
  return JSON.parse(await readFile(await resolvePortableFile(root, relative), "utf8"));
}

export async function snapshotDocuments(root) {
  const entries = await Promise.all(CANONICAL_DOCUMENTS.map((relative) => fileReference(root, relative)));
  return entries;
}

export async function validateReadSnapshot(root, snapshot, label, { current = true } = {}) {
  invariant(Array.isArray(snapshot), `${label}: missing read snapshot`);
  const byPath = new Map(snapshot.map((entry) => [entry.path, entry]));
  invariant(byPath.size === snapshot.length, `${label}: duplicate document path`);
  for (const required of CANONICAL_DOCUMENTS) {
    const entry = byPath.get(required);
    invariant(entry && HASH.test(entry.sha256 ?? ""), `${label}: missing document ${required}`);
    if (current) await verifyReference(root, entry, label);
  }
}

export function canonicalRepository(value) {
  invariant(text(value), "Research canonicalRepo is missing");
  const candidate = /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}` : value;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error(`Invalid repository URL: ${value}`); }
  invariant(parsed.protocol === "https:" && !parsed.username && !parsed.password,
    `Research requires HTTPS repository without credentials: ${value}`);
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const segments = parsed.pathname.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  invariant(segments.length >= 2, `Repository owner/name missing: ${value}`);
  if (parsed.hostname === "github.com") {
    invariant(segments.length === 2, `Use canonical GitHub repository root: ${value}`);
    return `https://github.com/${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
  }
  return `${parsed.origin}/${segments.join("/")}`;
}

export function researchIdentity(entry) {
  return `${canonicalRepository(entry.canonicalRepo)}\u0000${entry.revision}\u0000${entry.path}`;
}

export function flattenSources(register) {
  invariant(register?.schemaVersion === 1 && Array.isArray(register.sources), "Invalid source register schema");
  return register.sources.flatMap((source) => {
    const paths = Array.isArray(source.paths) ? source.paths : source.path ? [source] : [];
    return paths.map((entry) => ({
      sourceId: source.id, canonicalRepo: source.canonicalRepo, revision: source.revision,
      path: entry.path, sha256: entry.sha256,
    }));
  });
}

export async function validateSourceRegister(root, register) {
  const entries = flattenSources(register);
  const ids = new Set();
  const identities = new Set();
  for (const source of register.sources) {
    invariant(text(source.id) && !ids.has(source.id), "Research registry source ID missing or duplicated");
    ids.add(source.id);
    canonicalRepository(source.canonicalRepo);
    invariant(text(source.revision) && Array.isArray(source.paths) && source.paths.length > 0,
      `${source.id}: source revision/paths missing`);
    invariant(text(source.query) && iso(source.retrievedAt) && text(source.novelty),
      `${source.id}: research query/time/novelty missing`);
    invariant(text(source.license) && /^(apply|reject|defer)(?:$|-)/.test(source.decision ?? ""),
      `${source.id}: license or decision missing`);
    invariant(!/^apply/.test(source.decision) || !/^(unknown|unverified|none|pending|proprietary)$/i.test(source.license.trim()),
      `${source.id}: unresolved license cannot be adopted`);
    invariant(Array.isArray(source.strengths) && source.strengths.length > 0 && source.strengths.every(text) &&
      Array.isArray(source.weaknesses) && source.weaknesses.length > 0 && source.weaknesses.every(text),
      `${source.id}: observed strengths/weaknesses missing`);
    for (const item of source.paths) {
      invariant(text(item.path) && !item.path.split(/[\\/]/).some((p) => p === ".." || p === ".") &&
        !path.isAbsolute(item.path) && !/^[a-z]:/i.test(item.path), `${source.id}: invalid source path`);
      invariant(HASH.test(item.sha256 ?? ""), `${source.id}: source path needs a valid SHA-256: ${item.path}`);
      const identity = researchIdentity({ ...source, path: item.path });
      invariant(!identities.has(identity), `Duplicate research source/revision/path: ${item.path}`);
      identities.add(identity);
      if (item.sourceEvidence) {
        await verifyReference(root, item.sourceEvidence, "Registry source snapshot");
        invariant(item.sourceEvidence.sha256.toLowerCase() === item.sha256.toLowerCase(), `${source.id}: snapshot hash differs`);
      }
    }
  }
  return { sources: register.sources.length, paths: entries.length };
}

export async function validateNovelResearch(root, entries, baseline = [], { since } = {}) {
  invariant(Array.isArray(entries) && entries.length > 0, "Research needs at least one newly reviewed OSS source");
  const identities = new Set(baseline.map(researchIdentity));
  const hashes = new Set(baseline.map((entry) => entry.sha256?.toLowerCase()).filter(Boolean));
  for (const entry of entries) {
    const identity = researchIdentity(entry);
    invariant(text(entry.revision) && text(entry.path), "Research revision/path missing");
    invariant(!entry.path.split(/[\\/]/).includes(".."), "Research source path traversal");
    invariant(HASH.test(entry.sha256 ?? ""), "Research source SHA-256 missing");
    invariant(text(entry.license) && !/^(unknown|unverified|proprietary|none|pending)$/i.test(entry.license.trim()),
      `Research OSS license unresolved for ${entry.canonicalRepo}`);
    invariant(text(entry.query) && iso(entry.retrievedAt), "Research query/timestamp missing");
    if (since) invariant(Date.parse(entry.retrievedAt) >= Date.parse(since), "Research fetch predates this cycle");
    invariant(["apply", "reject", "defer"].includes(entry.decision), "Research disposition must be apply/reject/defer");
    invariant(text(entry.observation) && text(entry.strength) && text(entry.weakness) && text(entry.impact),
      "Research requires source observation, strength, weakness and concrete impact");
    invariant(!identities.has(identity), `Duplicate research source/revision/path: ${entry.path}`);
    invariant(!hashes.has(entry.sha256.toLowerCase()), `Research content already seen: ${entry.path}`);
    await verifyReference(root, entry.sourceEvidence, "Reviewed source snapshot");
    invariant(entry.sourceEvidence.sha256.toLowerCase() === entry.sha256.toLowerCase(),
      `Research source hash differs from snapshot: ${entry.path}`);
    identities.add(identity);
    hashes.add(entry.sha256.toLowerCase());
  }
}

async function validateReceipt(root, evidence) {
  await verifyReference(root, evidence);
  if (!VERIFICATION_KINDS.has(evidence.kind) && evidence.kind !== "capture") return;
  invariant(evidence.path.endsWith(".json"), `Machine-verifiable ${evidence.kind} evidence must be a JSON receipt`);
  const receipt = await readJson(root, evidence.path);
  invariant(receipt.schemaVersion === 1 && receipt.result === "passed", `Receipt is not passed: ${evidence.path}`);
  invariant(text(receipt.scope) && iso(receipt.recordedAt), `Receipt scope/time missing: ${evidence.path}`);
  if (evidence.kind === "native") invariant(receipt.scope === "native" || receipt.scope === "packaged-desktop",
    `Fixture/preview does not prove native runtime: ${evidence.path}`);
  if (evidence.kind === "live") invariant(receipt.scope === "live-provider" || receipt.scope === "live-service",
    `Fixture/preview does not prove live service: ${evidence.path}`);
  if (evidence.kind !== "capture") {
    invariant(text(receipt.command) && receipt.exitCode === 0, `Command/zero exit missing: ${evidence.path}`);
    await verifyReference(root, receipt.output, "Command output");
  }
  invariant(Array.isArray(receipt.sourceFiles) && receipt.sourceFiles.length > 0,
    `Receipt must bind tested source files: ${evidence.path}`);
  for (const source of receipt.sourceFiles) await verifyReference(root, source, "Receipt tested source");
  if (evidence.kind === "capture") {
    invariant(Array.isArray(receipt.media) && receipt.media.length > 0 && text(receipt.environment),
      `Capture must bind actual media/environment: ${evidence.path}`);
    for (const media of receipt.media) await verifyReference(root, media, "Capture media");
  }
  return receipt;
}

function referencesCover(actual, expected, label) {
  invariant(Array.isArray(actual), `${label}: binding list missing`);
  const map = new Map(actual.map((entry) => [entry.path, entry.sha256?.toLowerCase()]));
  invariant(map.size === actual.length, `${label}: duplicate binding path`);
  for (const entry of expected) invariant(map.get(entry.path) === entry.sha256.toLowerCase(),
    `${label}: does not cover ${entry.path}`);
}

async function evidenceBindings(root, evidence) {
  const sources = new Map();
  const receipts = [];
  for (const entry of evidence) {
    if (entry.kind === "source") sources.set(entry.path, entry);
    if (VERIFICATION_KINDS.has(entry.kind) || entry.kind === "capture") {
      const receipt = await validateReceipt(root, entry);
      receipts.push({ path: entry.path, sha256: entry.sha256 });
      for (const source of receipt.sourceFiles) sources.set(source.path, source);
    }
  }
  return { sourceFiles: [...sources.values()], testEvidence: receipts };
}

export async function validateReview(root, review, author, label = "Review", expected = {}) {
  invariant(review && text(review.reviewer) && text(review.author), `${label}: independent reviewer missing`);
  invariant(review.author === author, `${label}: author identity does not match owner`);
  invariant(review.reviewer !== author, `${label}: author cannot self-approve`);
  invariant(iso(review.reviewedAt), `${label}: review timestamp missing`);
  invariant(review.result === "passed" && Array.isArray(review.unresolved) && review.unresolved.length === 0,
    `${label}: unresolved review findings`);
  await verifyReference(root, review.evidence, label);
  invariant(review.evidence.path.endsWith(".json"), `${label}: review receipt must be JSON`);
  const receipt = await readJson(root, review.evidence.path);
  invariant(receipt.schemaVersion === 1 && receipt.result === "passed" && Array.isArray(receipt.unresolved) &&
    receipt.unresolved.length === 0, `${label}: review receipt has unresolved findings or is not passed`);
  invariant(receipt.author === review.author && receipt.reviewer === review.reviewer &&
    receipt.reviewedAt === review.reviewedAt, `${label}: review receipt identity/time differs from declaration`);
  invariant(Array.isArray(receipt.criteria) && receipt.criteria.length > 0, `${label}: review receipt criterion IDs missing`);
  const ids = receipt.criteria.map((entry) => typeof entry === "string" ? entry : entry?.id);
  invariant(ids.every(text) && new Set(ids).size === ids.length, `${label}: review criterion IDs invalid`);
  for (const id of expected.criteria ?? []) invariant(ids.includes(id), `${label}: review receipt does not cover criterion ${id}`);
  for (const item of receipt.criteria.filter((entry) => typeof entry === "object")) invariant(item.result === "passed" &&
    Array.isArray(item.unresolved) && item.unresolved.length === 0, `${label}: criterion has unresolved receipt findings`);
  invariant(Array.isArray(review.sourceFiles) && review.sourceFiles.length > 0, `${label}: reviewed source binding missing`);
  for (const source of review.sourceFiles) await verifyReference(root, source, "Reviewed source");
  invariant(Array.isArray(receipt.sourceFiles) && receipt.sourceFiles.length > 0, `${label}: review receipt source bindings missing`);
  for (const source of receipt.sourceFiles) await verifyReference(root, source, "Review receipt source");
  referencesCover(receipt.sourceFiles, review.sourceFiles, `${label} receipt source`);
  referencesCover(review.sourceFiles, receipt.sourceFiles, `${label} declared source`);
  referencesCover(review.sourceFiles, expected.sourceFiles ?? [], `${label} source coverage`);
  referencesCover(receipt.sourceFiles, expected.sourceFiles ?? [], `${label} receipt source coverage`);
  for (const list of [review.testEvidence, receipt.testEvidence]) {
    referencesCover(list, expected.testEvidence ?? [], `${label} test receipt coverage`);
    for (const entry of list) await verifyReference(root, entry, `${label} test evidence`);
  }
}

export async function validateDod(root, dod, { complete = false, skipEvidence = false } = {}) {
  invariant(dod?.schemaVersion === 1 && Array.isArray(dod.criteria) && dod.criteria.length > 0, "Invalid or empty DoD schema");
  const byId = new Map();
  const counts = { planned: 0, in_progress: 0, partial: 0, blocked: 0, done: 0, total: dod.criteria.length };
  for (const criterion of dod.criteria) {
    invariant(text(criterion.id) && !byId.has(criterion.id), `Missing/duplicate criterion ID: ${criterion.id}`);
    invariant(text(criterion.requirement) && text(criterion.category) && text(criterion.owner), `${criterion.id}: missing requirement/category/owner`);
    invariant(criterion.acceptance && criterion.verification, `${criterion.id}: observable acceptance/verification missing`);
    invariant(STATUSES.has(criterion.status), `${criterion.id}: invalid status ${criterion.status}`);
    invariant(Array.isArray(criterion.dependencies) && Array.isArray(criterion.evidence) && Array.isArray(criterion.blockers),
      `${criterion.id}: dependencies/evidence/blockers must be arrays`);
    invariant(Array.isArray(criterion.requiredEvidence) && criterion.requiredEvidence.length > 0,
      `${criterion.id}: requiredEvidence is empty`);
    counts[criterion.status]++;
    byId.set(criterion.id, criterion);
  }
  for (const criterion of dod.criteria) {
    for (const dependency of criterion.dependencies) {
      invariant(dependency !== criterion.id && byId.has(dependency), `${criterion.id}: invalid dependency ${dependency}`);
      if (criterion.status === "done") invariant(byId.get(dependency).status === "done",
        `${criterion.id}: dependency ${dependency} is not Done`);
    }
    for (const evidence of criterion.evidence) {
      if (skipEvidence) {
        await resolvePortableFile(root, evidence.path);
        invariant(text(evidence.kind) && HASH.test(evidence.sha256 ?? ""), `${criterion.id}: malformed evidence reference`);
      } else await validateReceipt(root, evidence);
    }
    if (criterion.status === "blocked") invariant(criterion.blockers.length > 0, `${criterion.id}: blocked without blocker record`);
    for (const blocker of criterion.blockers) invariant(blocker && text(blocker.cause) && Array.isArray(blocker.attempts) &&
      blocker.attempts.length > 0 && blocker.attempts.every(text) && text(blocker.resolution) && text(blocker.workaround) &&
      text(blocker.nextAction), `${criterion.id}: blocker needs cause, real attempts, resolution, workaround and nextAction`);
    if (criterion.status !== "done") continue;
    invariant(criterion.blockers.length === 0, `${criterion.id}: Done cannot retain unresolved blockers`);
    const kinds = new Set(criterion.evidence.map((entry) => entry.kind));
    for (const kind of criterion.requiredEvidence) invariant(kinds.has(kind), `${criterion.id}: missing required ${kind} evidence`);
    await validateReview(root, criterion.review, criterion.owner, `${criterion.id} review`, {
      criteria: [criterion.id], ...await evidenceBindings(root, criterion.evidence),
    });
  }
  // Dependency cycles can otherwise remain hidden until all nodes are marked done.
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    invariant(!visiting.has(id), `DoD dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  const mandatory = dod.criteria.filter((criterion) => criterion.mandatory !== false);
  counts.mandatoryTotal = mandatory.length;
  counts.mandatoryDone = mandatory.filter((criterion) => criterion.status === "done").length;
  counts.complete = counts.mandatoryDone === counts.mandatoryTotal;
  if (complete) invariant(counts.complete, `Product incomplete: ${counts.mandatoryDone}/${counts.mandatoryTotal} mandatory criteria Done`);
  return counts;
}

export async function createCycle(root, { id, author, criteria, register, revision = null, now = new Date().toISOString() }) {
  invariant(/^[a-z\d][a-z\d_-]{0,95}$/i.test(id ?? ""), "Cycle ID must be a portable name (max 96 characters)");
  invariant(text(author), "Cycle author missing");
  invariant(Array.isArray(criteria) && criteria.length > 0 && criteria.every(text), "Select at least one criterion");
  invariant(new Set(criteria).size === criteria.length, "Duplicate selected criterion");
  return {
    schemaVersion: 1, id, author, criteria, revision, createdAt: now, status: "active",
    stage: "resume", generation: 1, history: [{ stage: "resume", generation: 1, at: now, event: "started" }],
    reads: { before: await snapshotDocuments(root), after: [] },
    baselineResearch: flattenSources(register), research: [], artifacts: [],
    checklist: {}, review: null,
  };
}

async function validateArtifact(root, cycle, stage) {
  const entries = cycle.artifacts.filter((entry) => entry.stage === stage && entry.generation === cycle.generation);
  invariant(entries.length > 0, `${stage}: required artifact missing for generation ${cycle.generation}`);
  for (const artifact of entries) await verifyReference(root, artifact, `${stage} artifact`);
  return entries;
}

async function typedArtifacts(root, cycle, stage) {
  const artifacts = await validateArtifact(root, cycle, stage);
  const records = [];
  for (const artifact of artifacts) {
    invariant(artifact.path.endsWith(".json"), `${stage}: typed JSON receipt required`);
    const record = await readJson(root, artifact.path);
    invariant(record.schemaVersion === 1 && record.stage === stage && record.cycleId === cycle.id && iso(record.recordedAt),
      `${stage}: receipt schema/stage/cycle/time mismatch`);
    records.push(record);
  }
  return records;
}

function criterionCoverage(selected, rows, label) {
  const covered = new Set();
  for (const row of rows) {
    invariant(Array.isArray(row.criteria) && row.criteria.length > 0 && row.criteria.every((id) => selected.includes(id)),
      `${label}: invalid or unselected criterion IDs`);
    row.criteria.forEach((id) => covered.add(id));
  }
  for (const id of selected) invariant(covered.has(id), `${label}: selected criterion ${id} is not covered`);
}

function outputPath(relative) {
  return text(relative) && !path.isAbsolute(relative) && !/^[a-z]:/i.test(relative) &&
    !relative.includes("\\") && !relative.split("/").some((piece) => piece === ".." || piece === "." || piece === "");
}

async function validatePlan(root, cycle) {
  const records = await typedArtifacts(root, cycle, "plan");
  const allTasks = [];
  for (const record of records) {
    const budget = record.passBudget ?? 3;
    invariant(Number.isInteger(budget) && budget >= 0 && budget <= 10, "plan: passBudget must be 0–10 (default 3)");
    invariant(Array.isArray(record.passes) && record.passes.length <= budget, "plan: useful passes exceed budget");
    record.passes.forEach((pass, index) => invariant(pass?.index === index + 1 && text(pass.decision), "plan: passes need ordered useful decisions"));
    if (budget === 0) invariant(record.passes.length === 0 && record.stopReason === "disabled", "plan: zero pass budget must be explicitly disabled");
    else if (record.passes.length < budget) invariant(record.stopReason === "no-new-decision" && text(record.stopDetail), "plan: early stop needs no-new-decision explanation");
    else invariant(record.stopReason === "budget-exhausted", "plan: completed passes need budget-exhausted stop reason");
    invariant(Array.isArray(record.tasks) && record.tasks.length > 0, "plan: atomic tasks missing");
    for (const task of record.tasks) {
      invariant(text(task.id) && text(task.owner) && Array.isArray(task.dependencies), "plan: task ID/owner/dependencies missing");
      invariant(Array.isArray(task.inputs) && task.inputs.length > 0 && task.inputs.every(text) &&
        Array.isArray(task.outputs) && task.outputs.length > 0 && task.outputs.every(outputPath), "plan: task inputs/outputs missing or invalid");
      invariant(Array.isArray(task.acceptance) && task.acceptance.length > 0 && task.acceptance.every((entry) =>
        text(entry.metric) && ["eq", "lte", "gte"].includes(entry.operator) && Number.isFinite(entry.value)), "plan: measurable task acceptance missing");
      invariant(Array.isArray(task.verification) && task.verification.length > 0 && task.verification.every((entry) =>
        text(entry.command) && Number.isInteger(entry.expectedExitCode) && entry.expectedExitCode === 0), "plan: verification command/zero exit threshold missing");
      allTasks.push(task);
    }
  }
  const taskMap = new Map(allTasks.map((task) => [task.id, task]));
  invariant(taskMap.size === allTasks.length, "plan: duplicate task ID");
  for (const task of allTasks) for (const id of task.dependencies) invariant(id !== task.id && taskMap.has(id), "plan: task dependency missing/self-referential");
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => { invariant(!visiting.has(id), "plan: task dependency cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of taskMap.get(id).dependencies) visit(dep); visiting.delete(id); visited.add(id); };
  allTasks.forEach((task) => visit(task.id));
  criterionCoverage(cycle.criteria, allTasks, "plan");
}

async function validateSynthesis(root, cycle) {
  const records = await typedArtifacts(root, cycle, "synthesize");
  for (const record of records) {
    invariant(Array.isArray(record.observations) && record.observations.length > 0, "synthesize: source observations missing");
    for (const entry of record.observations) invariant(text(entry.source) && text(entry.observation) && text(entry.strength) &&
      text(entry.weakness) && text(entry.decision) && Array.isArray(entry.criteria) && entry.criteria.length > 0 &&
      entry.criteria.every((id) => cycle.criteria.includes(id)), "synthesize: observation/strength/weakness/decision/criterion missing");
    for (const entry of record.observations) invariant(cycle.research.some((source) =>
      canonicalRepository(source.canonicalRepo) === canonicalRepository(entry.source)),
      "synthesize: observation source is not bound to this cycle's reviewed research");
    const workbench = record.workbench;
    invariant(workbench && Array.isArray(workbench.sourceFiles) && workbench.sourceFiles.length > 0,
      "synthesize: runnable workbench source binding missing");
    for (const source of workbench.sourceFiles) await verifyReference(root, source, "Synthesis workbench source");
    invariant(workbench.buildEvidence?.kind === "build", "synthesize: workbench build receipt missing");
    const build = await validateReceipt(root, workbench.buildEvidence);
    referencesCover(build.sourceFiles, workbench.sourceFiles, "Synthesis workbench build source");
  }
}

async function validateImplementation(root, cycle) {
  const records = await typedArtifacts(root, cycle, "implement");
  const changes = [];
  for (const record of records) {
    invariant(Array.isArray(record.changes) && record.changes.length > 0 && Array.isArray(record.limitations) &&
      record.limitations.every(text), "implement: changes/explicit limitations list missing");
    for (const change of record.changes) {
      invariant(text(change.owner) && text(change.summary) && Array.isArray(change.sourceFiles) && change.sourceFiles.length > 0,
        "implement: owner/summary/source binding missing");
      for (const source of change.sourceFiles) await verifyReference(root, source, "Implementation source");
      changes.push(change);
    }
  }
  criterionCoverage(cycle.criteria, changes, "implement");
}

async function cycleReviewBindings(root, cycle) {
  const sources = new Map();
  const testEvidence = [];
  for (const artifact of cycle.artifacts.filter((entry) => entry.generation === cycle.generation && entry.stage === "implement")) {
    const record = await readJson(root, artifact.path);
    for (const change of record.changes ?? []) for (const source of change.sourceFiles ?? []) sources.set(source.path, source);
  }
  const bound = await evidenceBindings(root, cycle.artifacts.filter((entry) => entry.generation === cycle.generation && entry.stage === "verify"));
  for (const source of bound.sourceFiles) sources.set(source.path, source);
  testEvidence.push(...bound.testEvidence);
  return { criteria: cycle.criteria, sourceFiles: [...sources.values()], testEvidence };
}

async function git(root, args) {
  const result = await execFileAsync("git", args, { cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return result.stdout.trim();
}

async function validatePublication(root, cycle, dod) {
  const records = await typedArtifacts(root, cycle, "publish");
  for (const record of records) {
    invariant(record.phase === "published" && /^[a-f\d]{40}$/i.test(record.commit ?? "") &&
      /^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(record.tag ?? "") && /^\d+\.\d+\.\d+$/.test(record.version ?? ""),
      "publish: post-publication commit/tag/version proof missing");
    invariant(record.tag === `v${record.version}` || record.tag.startsWith(`v${record.version}-`), "publish: tag/version mismatch");
    const remote = canonicalRepository(record.remote);
    invariant(/^[a-z\d][a-z\d._/-]*$/i.test(record.branch ?? "") && !record.branch.includes(".."), "publish: branch missing or invalid");
    invariant(record.readme?.path === "README.md", "publish: current README binding missing");
    await verifyReference(root, record.readme, "Published README");
    invariant(Array.isArray(record.screenshots) && record.screenshots.length > 0, "publish: screenshots missing");
    for (const media of record.screenshots) {
      invariant(/\.(png|jpe?g|webp)$/i.test(media.path ?? ""), "publish: screenshot must be an image artifact");
      await verifyReference(root, media, "Published screenshot");
    }
    invariant(Array.isArray(record.openCriteria) && new Set(record.openCriteria).size === record.openCriteria.length,
      "publish: explicit open criteria missing");
    const open = dod.criteria.filter((criterion) => criterion.status !== "done").map((criterion) => criterion.id);
    invariant(open.length === record.openCriteria.length && open.every((id) => record.openCriteria.includes(id)), "publish: remaining criteria differ from DoD");
    const publication = record.publication;
    invariant(publication && text(publication.command) && publication.exitCode === 0 && publication.remoteCommit === record.commit &&
      publication.tagCommit === record.commit, "publish: successful push/remote/tag proof missing");
    await verifyReference(root, publication.output, "Publication command output");
    const packageData = await readJson(root, "package.json");
    invariant(packageData.version === record.version, "publish: package version differs from release");
    invariant(await git(root, ["rev-parse", `${record.commit}^{commit}`]) === record.commit, "publish: local commit missing");
    invariant(await git(root, ["rev-parse", `${record.tag}^{commit}`]) === record.commit, "publish: local tag points elsewhere");
    const remoteName = record.remoteName ?? "origin";
    invariant(/^[a-z\d][a-z\d_-]*$/i.test(remoteName), "publish: invalid remote name");
    invariant(canonicalRepository(await git(root, ["remote", "get-url", remoteName])) === remote, "publish: configured remote differs from receipt");
    const remoteRefs = await git(root, ["ls-remote", record.remote, `refs/heads/${record.branch}`, `refs/tags/${record.tag}`, `refs/tags/${record.tag}^{}`]);
    const refs = new Map(remoteRefs.split(/\r?\n/).filter(Boolean).map((line) => { const [hash, ref] = line.split(/\s+/); return [ref, hash]; }));
    invariant(/^[a-f\d]{40}$/i.test(refs.get(`refs/heads/${record.branch}`) ?? ""), "publish: remote branch missing");
    invariant((refs.get(`refs/tags/${record.tag}^{}`) ?? refs.get(`refs/tags/${record.tag}`)) === record.commit, "publish: remote tag missing or points elsewhere");
  }
}

export async function validateStageExit(root, cycle, context) {
  const { dod } = context;
  switch (cycle.stage) {
    case "resume":
      await validateReadSnapshot(root, cycle.reads?.before, "Before implementation reads");
      break;
    case "audit":
      invariant(cycle.criteria.every((id) => dod.criteria.some((criterion) => criterion.id === id)), "Selected criterion is not in DoD");
      await validateArtifact(root, cycle, "audit");
      break;
    case "research":
      await validateNovelResearch(root, cycle.research, cycle.baselineResearch, { since: cycle.createdAt });
      await validateArtifact(root, cycle, "research");
      break;
    case "synthesize": await validateSynthesis(root, cycle); break;
    case "plan": await validatePlan(root, cycle); break;
    case "implement": await validateImplementation(root, cycle); break;
    case "verify": {
      const evidence = cycle.artifacts.filter((entry) => entry.stage === "verify" && entry.generation === cycle.generation);
      invariant(evidence.length > 0 && evidence.some((entry) => VERIFICATION_KINDS.has(entry.kind)), "verify: passing command receipt missing");
      for (const artifact of evidence) await validateReceipt(root, artifact);
      break;
    }
    case "review":
      await validateReview(root, cycle.review, cycle.author, "Cycle review", await cycleReviewBindings(root, cycle));
      break;
    case "document":
      for (const item of SPEC_CHECKLIST) invariant(cycle.checklist?.[item] === true, `Spec reread checklist incomplete: ${item}`);
      await validateReadSnapshot(root, cycle.reads?.after, "After implementation reads");
      await validateArtifact(root, cycle, "document");
      break;
    case "publish":
      await validateReadSnapshot(root, cycle.reads?.after, "Publication docs");
      await validatePublication(root, cycle, dod);
      break;
    case "next":
      break;
    default: throw new Error(`Unknown stage ${cycle.stage}`);
  }
}

export async function advanceCycle(root, original, { to, event = "advance", reason, now = new Date().toISOString() }, context) {
  const cycle = structuredClone(original);
  invariant(cycle.schemaVersion === 1 && STAGES.includes(cycle.stage), "Invalid cycle schema/stage");
  invariant(cycle.status === "active", `Cycle is ${cycle.status}; cannot advance`);
  if (event === "cancel") {
    invariant(text(reason), "Cancellation reason missing");
    cycle.status = "cancelled";
    cycle.history.push({ stage: cycle.stage, generation: cycle.generation, at: now, event, reason });
    return cycle;
  }
  if (event === "failure") {
    invariant(["implement", "verify", "review", "document", "publish"].includes(cycle.stage), "Failure reset requires an implementation stage");
    invariant(text(reason), "Failure diagnosis missing");
    cycle.generation++;
    cycle.stage = "implement";
    cycle.review = null;
    cycle.reads.after = [];
    cycle.checklist = {};
    cycle.history.push({ stage: "implement", generation: cycle.generation, at: now, event, reason });
    return cycle;
  }
  invariant(event === "advance", `Unknown workflow event ${event}`);
  const next = STAGES[STAGES.indexOf(cycle.stage) + 1];
  invariant(next && to === next, `Stage skip rejected: ${cycle.stage} → ${to}; expected ${next ?? "end"}`);
  await validateStageExit(root, cycle, context);
  cycle.stage = next;
  cycle.history.push({ stage: next, generation: cycle.generation, at: now, event });
  if (next === "next") cycle.status = "completed";
  return cycle;
}

export async function validateCycle(root, cycle, context, { milestone = false } = {}) {
  invariant(cycle?.schemaVersion === 1 && STAGES.includes(cycle.stage), "Invalid cycle schema/stage");
  invariant(["active", "completed", "cancelled"].includes(cycle.status), "Invalid cycle status");
  invariant(text(cycle.author) && Array.isArray(cycle.criteria) && cycle.criteria.length > 0, "Cycle author/criteria missing");
  invariant(Array.isArray(cycle.history) && cycle.history.length > 0, "Cycle transition history missing");
  invariant(cycle.criteria.every((id) => context.dod.criteria.some((criterion) => criterion.id === id)) &&
    new Set(cycle.criteria).size === cycle.criteria.length, "Cycle selected criteria missing/duplicated");
  let previous = "resume";
  let generation = 1;
  let terminal = false;
  let lastAt = -Infinity;
  const completedGenerations = new Map();
  for (let index = 0; index < cycle.history.length; index++) {
    const item = cycle.history[index];
    invariant(iso(item.at) && STAGES.includes(item.stage), "Invalid cycle history entry");
    invariant(!terminal, "Cycle history continues after terminal cancellation/completion");
    invariant(Date.parse(item.at) >= lastAt, "Cycle history time moved backwards");
    lastAt = Date.parse(item.at);
    if (index === 0) invariant(item.event === "started" && item.stage === "resume", "Cycle must start at resume");
    else if (item.event === "advance") {
      invariant(item.stage === STAGES[STAGES.indexOf(previous) + 1], "History contains skipped stage");
      completedGenerations.set(previous, generation);
    }
    else if (item.event === "failure") {
      invariant(["implement", "verify", "review", "document", "publish"].includes(previous) &&
        item.stage === "implement" && text(item.reason) && item.generation === generation + 1, "Invalid failure reset history");
      generation++;
      for (const stage of STAGES.slice(STAGES.indexOf("implement"))) completedGenerations.delete(stage);
    } else {
      invariant(item.event === "cancel" && text(item.reason) && item.stage === previous, "Unknown/invalid history event");
      terminal = true;
    }
    invariant(item.generation === generation, "Invalid cycle generation history");
    previous = item.stage;
    if (item.stage === "next") terminal = true;
  }
  invariant(previous === cycle.stage && generation === cycle.generation, "Cycle state differs from history");
  const last = cycle.history.at(-1);
  if (cycle.status === "completed") invariant(cycle.stage === "next" && last.event === "advance", "Cycle completed status requires full history through next");
  if (cycle.status === "cancelled") invariant(last.event === "cancel" && cycle.stage !== "next", "Cycle cancelled status requires terminal cancel event");
  if (cycle.status === "active") invariant(cycle.stage !== "next" && last.event !== "cancel", "Cycle active status conflicts with terminal history");
  await validateReadSnapshot(root, cycle.reads?.before, "Input documents", {
    current: STAGES.indexOf(cycle.stage) < STAGES.indexOf("implement"),
  });
  for (const artifact of cycle.artifacts ?? []) await verifyReference(root, artifact, "Cycle artifact");
  if (STAGES.indexOf(cycle.stage) > STAGES.indexOf("research")) {
    await validateNovelResearch(root, cycle.research, cycle.baselineResearch, { since: cycle.createdAt });
  }
  if (STAGES.indexOf(cycle.stage) > STAGES.indexOf("review")) await validateReview(root, cycle.review, cycle.author,
    "Cycle review", await cycleReviewBindings(root, cycle));
  if (STAGES.indexOf(cycle.stage) > STAGES.indexOf("document")) {
    for (const item of SPEC_CHECKLIST) invariant(cycle.checklist?.[item] === true, `Spec reread checklist incomplete: ${item}`);
    await validateReadSnapshot(root, cycle.reads?.after, "Post-implementation documents");
  }
  if (milestone) invariant(["publish", "next"].includes(cycle.stage) && cycle.status !== "cancelled", "Cycle has not reached a publishable milestone");
  // Revalidate each completed stage so editing history cannot bypass evidence guards.
  const reached = STAGES.indexOf(cycle.stage);
  for (const stage of STAGES.slice(0, reached)) {
    if (stage === "resume") continue; // Initial hashes are historical after implementation.
    const completedGeneration = completedGenerations.get(stage);
    invariant(Number.isInteger(completedGeneration), `${stage}: completed stage generation missing`);
    await validateStageExit(root, { ...cycle, stage, generation: completedGeneration }, context);
  }
  return { id: cycle.id, stage: cycle.stage, status: cycle.status, generation: cycle.generation };
}
