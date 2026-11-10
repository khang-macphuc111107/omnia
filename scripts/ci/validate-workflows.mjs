import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const JOB_NAME = /^[a-z][a-z0-9-]*$/;
const SHELLS = new Set(["bash", "sh", "pwsh", "powershell", "cmd", "cmd.exe", "python", "python3", "node"]);

function indentOf(line) {
  return line.match(/^\s*/u)?.[0].length ?? 0;
}

function stripYamlComment(value) {
  return value.replace(/\s+#.*$/u, "").trim();
}

function parseNeeds(value) {
  const normalized = stripYamlComment(value ?? "");
  if (!normalized) return [];
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean);
  }
  return normalized
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/gu, ""))
    .filter(Boolean);
}

function parseJobs(source) {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const errors = [];
  const jobs = new Map();
  const jobsLine = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsLine < 0) return { lines, jobs, errors: ["missing top-level jobs mapping"] };

  let current;
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (indent === 2) {
      const match = line.match(/^  ([A-Za-z0-9][A-Za-z0-9-]*):\s*(?:#.*)?$/u);
      if (!match) continue;
      const id = match[1];
      if (jobs.has(id)) errors.push(`duplicate job id "${id}"`);
      current = { id, line: index + 1, needs: [], runsOn: false, lines: [] };
      jobs.set(id, current);
      continue;
    }
    if (!current) continue;
    current.lines.push({ index, line, indent });
    if (indent === 4 && /^\s*runs-on:\s*\S/u.test(line)) current.runsOn = true;
    if (indent === 4) {
      const needsMatch = line.match(/^\s*needs:\s*(.*)$/u);
      if (needsMatch) current.needs.push(...parseNeeds(needsMatch[1]));
    }
    // A multiline needs list is uncommon, but accepting its scalar list form
    // keeps this check useful without pretending to be a full YAML parser.
    if (indent === 6 && /^\s*-\s*[A-Za-z0-9][A-Za-z0-9-]*\s*$/u.test(line)) {
      const item = line.trim().replace(/^-+\s*/u, "");
      const previous = lines[index - 1]?.trim() ?? "";
      if (previous === "needs:") current.needs.push(item);
    }
  }
  if (!jobs.size) errors.push("top-level jobs mapping is empty");
  return { lines, jobs, errors };
}

function detectCycles(jobs) {
  const visiting = new Set();
  const visited = new Set();
  const errors = [];
  function visit(id, chain) {
    if (visiting.has(id)) {
      errors.push(`needs dependency cycle: ${[...chain, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of jobs.get(id)?.needs ?? []) {
      if (jobs.has(dependency)) visit(dependency, [...chain, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of jobs.keys()) visit(id, []);
  return errors;
}

function validateExpressions(lines) {
  const errors = [];
  for (const [index, line] of lines.entries()) {
    const opens = (line.match(/\$\{\{/gu) ?? []).length;
    const closes = (line.match(/\}\}/gu) ?? []).length;
    if (opens !== closes) errors.push(`line ${index + 1}: unbalanced GitHub expression delimiters`);
  }
  return errors;
}

export function validateWorkflowSource(source, {
  file = "<fixture>",
  packageScripts = {},
  requireDiagnostics = false,
  requirePinnedActions = false,
} = {}) {
  const errors = [];
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const firstMeaningful = lines.find((line) => line.trim() && !line.trimStart().startsWith("#"))?.trim();
  if (!firstMeaningful?.startsWith("name:")) errors.push("missing workflow name");
  else {
    const workflowName = firstMeaningful.slice("name:".length).trim().replace(/^['"]|['"]$/gu, "");
    if (!workflowName || !WORKFLOW_NAME.test(workflowName)) errors.push("workflow name is empty or invalid");
  }
  if (!lines.some((line) => /^on:\s*(?:#.*)?$/u.test(line))) errors.push("missing top-level on mapping");
  if (/\bcontinue-on-error:\s*true\b/iu.test(source)) errors.push("continue-on-error: true is forbidden in required workflows");
  errors.push(...validateExpressions(lines));
  const permissionBlock = source.match(/^permissions:\s*\r?\n((?:[ \t]+[^\n]*\r?\n|\r?\n)*)/mu)?.[1] ?? "";
  if (/^\s+\S+:\s*write\s*(?:#.*)?$/mu.test(permissionBlock)
    || /^permissions:\s*write-all\s*(?:#.*)?$/mu.test(source)) {
    errors.push("workflow-wide write permissions are forbidden; scope write permissions to the publishing job");
  }
  if (requirePinnedActions) {
    for (const match of source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gmu)) {
      const action = match[1];
      if (action.startsWith("./")) continue;
      if (!/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u.test(action)) {
        errors.push(`immutable commit required for action "${action}"`);
      }
    }
  }

  const parsed = parseJobs(source);
  errors.push(...parsed.errors);
  for (const job of parsed.jobs.values()) {
    if (!JOB_NAME.test(job.id)) errors.push(`job "${job.id}" has an invalid id`);
    if (!job.runsOn) errors.push(`job "${job.id}" is missing runs-on`);
    for (const dependency of job.needs) {
      if (!parsed.jobs.has(dependency)) errors.push(`job "${job.id}" needs unknown job "${dependency}"`);
      if (dependency === job.id) errors.push(`job "${job.id}" needs itself`);
    }
    const jobSource = job.lines.map(({ line }) => line).join("\n");
    if (/(?:^|\s)(?:&\s+)?python(?:3)?\s+/mu.test(jobSource)) {
      if (!/uses:\s*actions\/setup-python@/u.test(jobSource)
        || !/python-version:\s*["']?\d+\.\d+(?:\.\d+)?["']?\s*(?:#.*)?$/mu.test(jobSource)) {
        errors.push(`job "${job.id}" runs Python contracts without a versioned setup-python step`);
      }
    }
  }
  errors.push(...detectCycles(parsed.jobs));

  for (const match of source.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/gu)) {
    const script = match[1];
    if (!Object.prototype.hasOwnProperty.call(packageScripts, script)) {
      errors.push(`npm run "${script}" has no package.json script`);
    }
  }
  for (const match of source.matchAll(/^\s*(?:-\s*)?shell:\s*([^\s#]+)\s*$/gmu)) {
    const shell = match[1].replace(/^['"]|['"]$/gu, "");
    if (!shell.includes("${{") && !SHELLS.has(shell)) errors.push(`unsupported shell "${shell}"`);
  }

  const uploadLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*uses:\s*actions\/upload-artifact@/u.test(line));
  for (const { index } of uploadLines) {
    const preceding = lines.slice(Math.max(0, index - 5), index).join("\n");
    if (!/^\s*if:\s*always\(\)\s*$/mu.test(preceding)) {
      errors.push(`artifact upload at line ${index + 1} must use if: always()`);
    }
  }
  if (requireDiagnostics && uploadLines.length === 0) {
    errors.push("required PR workflow has no diagnostics artifact upload");
  }

  if (/^jobs:\s*$/mu.test(source) && /quality-complete:/u.test(source)) {
    if (!/if:\s*always\(\)/u.test(source)) errors.push("quality aggregate must run with if: always()");
    if (!/NEEDS_RESULTS:\s*\$\{\{\s*toJSON\(needs\)\s*\}\}/u.test(source)) {
      errors.push("quality aggregate must pass toJSON(needs) to the fail-closed assertion");
    }
    if (!/scripts\/ci\/assert-job-results\.mjs/u.test(source)) {
      errors.push("quality aggregate must invoke assert-job-results.mjs");
    }
  }
  return { file, errors };
}

export async function validateWorkflowFiles({ cwd = process.cwd(), workflowDir = ".github/workflows" } = {}) {
  const packageData = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  const directory = path.join(cwd, workflowDir);
  const files = (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name)).sort();
  const results = [];
  for (const name of files) {
    const source = await readFile(path.join(directory, name), "utf8");
    results.push(validateWorkflowSource(source, {
      file: path.posix.join(workflowDir.replaceAll("\\", "/"), name),
      packageScripts: packageData.scripts ?? {},
      requireDiagnostics: ["ci.yml", "fast-feedback.yml", "rebuild.yml"].includes(name),
      requirePinnedActions: true,
    }));
  }
  const errors = results.flatMap((result) => result.errors.map((error) => `${result.file}: ${error}`));
  return { schemaVersion: 1, result: errors.length ? "failed" : "passed", files: results, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await validateWorkflowFiles();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
