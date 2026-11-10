import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

export const STAGES = [
  "resume",
  "audit",
  "research",
  "synthesize",
  "plan",
  "implement",
  "verify",
  "review",
  "document",
  "publish",
  "next",
];

export const CANONICAL_DOCS = [
  "AGENTS.md",
  ".agents/skills/omnia-evidence-loop/SKILL.md",
  "docs/rebuild/GOAL.md",
  "docs/rebuild/WORKFLOW.md",
  "docs/rebuild/SPEC.md",
  "docs/rebuild/DOD.json",
  "docs/rebuild/SOURCE_REGISTER.json",
  "docs/rebuild/CHECKPOINT.md",
  "docs/rebuild/ASSIGNMENTS.md",
];

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(root, path) {
  const absolute = resolve(root, path);
  return sha256Bytes(readFileSync(absolute));
}

export function readJson(root, path) {
  const absolute = resolve(root, path);
  return JSON.parse(readFileSync(absolute, "utf8"));
}

export function canonicalPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

export function canonicalRepo(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/^git\+/, "").replace(/\/$/, "").replace(/\.git$/, "");
}

export function docHashes(root) {
  const result = {};
  for (const doc of CANONICAL_DOCS) {
    const absolute = resolve(root, doc);
    if (!existsSync(absolute)) continue;
    result[doc] = sha256File(root, doc);
  }
  return result;
}

export function withinRoot(root, candidate) {
  const rootReal = realpathSync(root);
  const absolute = resolve(root, candidate);
  let candidateReal;
  try {
    candidateReal = realpathSync(absolute);
  } catch {
    return false;
  }
  const rel = relative(rootReal, candidateReal);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${normalize("/")}`) && !isAbsolute(rel));
}

export function resolveEvidencePath(root, value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const candidate = isAbsolute(value) ? value : resolve(root, value);
  if (!existsSync(candidate) || !withinRoot(root, candidate)) return null;
  return candidate;
}

export function evidenceHash(root, value) {
  const absolute = resolveEvidencePath(root, value);
  if (!absolute) return null;
  return sha256Bytes(readFileSync(absolute));
}

export function parseImportSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\b(?:require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs];
}

export function resolveSourceImport(root, importer, specifier) {
  let base;
  if (specifier.startsWith("@/")) base = join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else return null;

  const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"].map((ext) => `${base}${ext}`)];
  for (const candidate of candidates) if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const index = join(base, `index${ext}`);
    if (existsSync(index) && statSync(index).isFile()) return realpathSync(index);
  }
  return null;
}

export function collectEntryGraph(root, entry = "src/main.tsx") {
  const start = resolve(root, entry);
  const files = new Map();
  const missing = [];
  const visit = (absolute) => {
    if (files.has(absolute)) return;
    if (!existsSync(absolute)) {
      missing.push(relative(root, absolute).replaceAll("\\", "/"));
      return;
    }
    const source = readFileSync(absolute, "utf8");
    files.set(absolute, source);
    for (const specifier of parseImportSpecifiers(source)) {
      const child = resolveSourceImport(root, absolute, specifier);
      if (child) visit(child);
      else if (specifier.startsWith(".") || specifier.startsWith("@/")) missing.push(`${relative(root, absolute).replaceAll("\\", "/")} -> ${specifier}`);
    }
  };
  visit(start);
  return { files, missing };
}

export function statusCounts(criteria = []) {
  return criteria.reduce((counts, criterion) => {
    const status = typeof criterion.status === "string" ? criterion.status : "planned";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, { planned: 0, in_progress: 0, partial: 0, blocked: 0, done: 0 });
}

export function validateCriterionEvidence(root, criterion) {
  const errors = [];
  if (!criterion || typeof criterion !== "object") return ["criterion is not an object"];
  const status = criterion.status ?? "planned";
  if (status === "done") {
    if (Array.isArray(criterion.blockers) && criterion.blockers.length) errors.push(`done criterion ${criterion.id ?? "(unknown)"} still has blockers`);
    if (!Array.isArray(criterion.evidence) || criterion.evidence.length === 0) errors.push(`done criterion ${criterion.id ?? "(unknown)"} has no direct evidence`);
    if (!isNonEmptyString(criterion.owner) || !isNonEmptyString(criterion.reviewer) || criterion.owner === criterion.reviewer) errors.push(`done criterion ${criterion.id ?? "(unknown)"} needs a distinct owner and reviewer`);
    for (const evidence of criterion.evidence ?? []) {
      const absolute = resolveEvidencePath(root, evidence?.path);
      if (!absolute) { errors.push(`criterion ${criterion.id ?? "(unknown)"} evidence path missing/outside root: ${evidence?.path}`); continue; }
      if (evidence.sha256 && evidenceHash(root, evidence.path) !== evidence.sha256) errors.push(`criterion ${criterion.id ?? "(unknown)"} evidence hash is stale: ${evidence.path}`);
      if (!isNonEmptyString(evidence.kind)) errors.push(`criterion ${criterion.id ?? "(unknown)"} evidence lacks kind: ${evidence.path}`);
    }
  }
  return errors;
}

export function validateResearchRegistry(registry) {
  const errors = [];
  const identities = new Set();
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.sources)) return ["SOURCE_REGISTER.json must have schemaVersion 1 and sources array"];
  for (const source of registry.sources) {
    const repo = canonicalRepo(source.canonicalRepo);
    const revision = isNonEmptyString(source.revision) ? source.revision.trim().toLowerCase() : "";
    const paths = Array.isArray(source.paths) ? source.paths : [];
    if (!repo || !revision || paths.length === 0) errors.push(`source ${source.id ?? "(unknown)"} needs canonicalRepo, revision and paths`);
    if (!isNonEmptyString(source.query) || !isNonEmptyString(source.retrievedAt) || !isNonEmptyString(source.novelty) || !isNonEmptyString(source.decision)) errors.push(`source ${source.id ?? "(unknown)"} lacks query/time/novelty/decision`);
    for (const item of paths) {
      const identity = `${repo}|${revision}|${canonicalPath(item.path)}`;
      if (identities.has(identity)) errors.push(`duplicate research source identity: ${identity}`);
      identities.add(identity);
      if (!isNonEmptyString(item.path) || !/^[a-f0-9]{64}$/i.test(item.sha256 ?? "")) errors.push(`source ${source.id ?? "(unknown)"} path needs path and sha256: ${item.path}`);
    }
  }
  return errors;
}

export function validateStageTransition(current, next) {
  if (!STAGES.includes(next)) return `invalid target stage: ${next}`;
  if (current == null) return next === "resume" ? null : `initial stage must be resume, got ${next}`;
  if (!STAGES.includes(current)) return `invalid current stage: ${current}`;
  if (next === current) return null;
  return STAGES.indexOf(next) === STAGES.indexOf(current) + 1 ? null : `invalid stage transition ${current} -> ${next}`;
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function result(ok, errors = [], warnings = [], details = {}) {
  return { ok, errors, warnings, ...details };
}

export function formatIssues(title, errors, warnings = []) {
  const lines = [`[${title}] ${errors.length ? "FAIL" : "PASS"}`];
  for (const issue of errors) lines.push(`ERROR ${issue}`);
  for (const issue of warnings) lines.push(`WARN ${issue}`);
  return lines.join("\n");
}

export function extensionOf(path) {
  return extname(path).toLowerCase();
}
