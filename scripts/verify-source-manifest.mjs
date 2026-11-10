#!/usr/bin/env node

/**
 * Verify a source snapshot without mutating the repository.
 *
 * This intentionally lives beside create-source-manifest.mjs instead of
 * extending that historical writer.  Release evidence must be reproducible
 * and must never rewrite an older manifest just to make a check pass.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_MANIFEST_RELATIVE = "docs/releases/omnia-0.1.0-phase1-preview-source.sha256";

// Keep this policy explicit and reviewable.  It intentionally matches the
// historical writer's source tree policy, while also excluding local Cargo
// target caches that are never source provenance.
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".vite",
  ".cargo-target-test",
  ".cargo-target-verify",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const EXCLUDED_PREFIXES = Object.freeze([
  "artifacts/",
  "src-tauri/target/",
]);

function printHelp() {
  process.stdout.write(`Usage: node scripts/verify-source-manifest.mjs [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --manifest <path>  SHA-256 manifest to verify (default: historical Phase 1 manifest)\n`);
  process.stdout.write(`  --root <path>      Repository root (default: inferred from this script)\n`);
  process.stdout.write(`  --check            Strict verification mode; exits 1 on any mismatch (default: report only)\n`);
  process.stdout.write(`  --json             Emit a machine-readable JSON report only\n`);
  process.stdout.write(`  --quiet            Emit only the final status line\n`);
  process.stdout.write(`  --help             Show this help\n`);
}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    quiet: false,
    manifest: DEFAULT_MANIFEST_RELATIVE,
    root: DEFAULT_REPOSITORY_ROOT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function compareUtf8(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function normalizeRelativePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Manifest path is not a relative POSIX path: ${JSON.stringify(relativePath)}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Manifest path contains an unsafe segment: ${JSON.stringify(relativePath)}`);
  }

  return segments.join("/");
}

function isExcluded(relativePath, manifestRelativePath) {
  if (relativePath === manifestRelativePath) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return true;
  return false;
}

function ensureInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Path escapes repository root: ${candidate}`);
}

async function collectFiles(directory, root, manifestRelativePath, prefix = "", issues = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  const files = [];

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const normalized = normalizeRelativePath(relative);
    if (isExcluded(normalized, manifestRelativePath)) continue;

    const absolute = path.join(root, normalized.split("/").join(path.sep));
    ensureInsideRoot(root, absolute);

    if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      issues.push({ type: "symlink", path: normalized });
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, root, manifestRelativePath, normalized, issues)));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalized);
    }
  }

  return files;
}

async function sha256File(absolutePath) {
  const bytes = await readFile(absolutePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function parseManifest(text) {
  const entries = [];
  const issues = [];
  const exactPaths = new Set();
  const caseFoldedPaths = new Map();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = /^(?<digest>[a-fA-F0-9]{64})\s+(?<path>.+)$/.exec(line);
    if (!match) {
      issues.push({ type: "malformed-line", line: lineNumber, value: line });
      continue;
    }

    let relativePath;
    try {
      relativePath = normalizeRelativePath(match.groups.path.trim());
    } catch (error) {
      issues.push({ type: "unsafe-path", line: lineNumber, value: match.groups.path, message: error.message });
      continue;
    }

    const digest = match.groups.digest.toLowerCase();
    const foldedPath = relativePath.toLowerCase();
    if (exactPaths.has(relativePath)) {
      issues.push({ type: "duplicate-path", line: lineNumber, path: relativePath });
    }
    const previousPath = caseFoldedPaths.get(foldedPath);
    if (previousPath && previousPath !== relativePath) {
      issues.push({ type: "case-collision", line: lineNumber, path: relativePath, previousPath });
    }
    exactPaths.add(relativePath);
    caseFoldedPaths.set(foldedPath, relativePath);
    entries.push({ digest, path: relativePath, line: lineNumber });
  }

  const paths = entries.map((entry) => entry.path);
  const sortedPaths = [...paths].sort(compareUtf8);
  if (paths.some((value, index) => value !== sortedPaths[index])) {
    issues.push({ type: "non-deterministic-order" });
  }

  return { entries, issues };
}

async function verify(options) {
  const root = path.resolve(options.root);
  const manifestPath = path.resolve(root, options.manifest);
  await stat(root);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifestBytes = Buffer.from(manifestText, "utf8");
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");

  const manifestRelative = path.relative(root, manifestPath);
  const manifestInsideRoot = manifestRelative !== "" && !manifestRelative.startsWith("..") && !path.isAbsolute(manifestRelative);
  const manifestRelativePath = manifestInsideRoot ? normalizeRelativePath(manifestRelative) : "";
  const parsed = parseManifest(manifestText);
  const fileIssues = [...parsed.issues];
  const actualPaths = await collectFiles(root, root, manifestRelativePath, "", fileIssues);
  const expectedByPath = new Map(parsed.entries.map((entry) => [entry.path, entry.digest]));
  const actualByPath = new Map();
  const actualCaseFoldedPaths = new Map();

  const missing = [];
  const extra = [];
  const mismatched = [];

  for (const relativePath of actualPaths) {
    const absolutePath = path.join(root, relativePath.split("/").join(path.sep));
    const digest = await sha256File(absolutePath);
    actualByPath.set(relativePath, digest);
    const foldedPath = relativePath.toLowerCase();
    const previousPath = actualCaseFoldedPaths.get(foldedPath);
    if (previousPath && previousPath !== relativePath) {
      fileIssues.push({ type: "actual-case-collision", path: relativePath, previousPath });
    }
    actualCaseFoldedPaths.set(foldedPath, relativePath);
  }

  for (const entry of parsed.entries) {
    if (!actualByPath.has(entry.path)) {
      missing.push(entry.path);
      continue;
    }
    const actualDigest = actualByPath.get(entry.path);
    if (actualDigest !== entry.digest) {
      mismatched.push({ path: entry.path, expected: entry.digest, actual: actualDigest });
    }
  }
  for (const relativePath of actualPaths) {
    if (!expectedByPath.has(relativePath)) extra.push(relativePath);
  }

  missing.sort(compareUtf8);
  extra.sort(compareUtf8);
  mismatched.sort((left, right) => compareUtf8(left.path, right.path));
  const hasErrors = fileIssues.length > 0 || missing.length > 0 || extra.length > 0 || mismatched.length > 0;

  return {
    schemaVersion: 1,
    ok: !hasErrors,
    snapshotId: `source-manifest:sha256:${manifestHash}`,
    repositoryRoot: root,
    manifestPath,
    manifestSha256: manifestHash,
    policy: {
      excludedDirectoryNames: [...EXCLUDED_DIRECTORY_NAMES].sort(compareUtf8),
      excludedPrefixes: [...EXCLUDED_PREFIXES].sort(compareUtf8),
      pathOrder: "bytewise-utf8",
      symlinks: "rejected",
    },
    counts: {
      manifestEntries: parsed.entries.length,
      sourceFiles: actualPaths.length,
      missing: missing.length,
      extra: extra.length,
      mismatched: mismatched.length,
      structuralIssues: fileIssues.length,
    },
    missing,
    extra,
    mismatched,
    structuralIssues: fileIssues,
  };
}

function printHuman(report, quiet) {
  if (quiet) {
    process.stdout.write(`${report.ok ? "OK" : "FAIL"} ${report.snapshotId}\n`);
    return;
  }

  process.stdout.write(`${report.ok ? "PASS" : "FAIL"} source-manifest verification\n`);
  process.stdout.write(`  snapshot: ${report.snapshotId}\n`);
  process.stdout.write(`  manifest: ${report.manifestPath}\n`);
  process.stdout.write(`  entries: ${report.counts.manifestEntries}; files: ${report.counts.sourceFiles}\n`);
  process.stdout.write(`  missing: ${report.counts.missing}; extra: ${report.counts.extra}; mismatched: ${report.counts.mismatched}; structural: ${report.counts.structuralIssues}\n`);

  if (report.missing.length) process.stdout.write(`  missing paths:\n${report.missing.map((value) => `    - ${value}`).join("\n")}\n`);
  if (report.extra.length) process.stdout.write(`  extra paths:\n${report.extra.map((value) => `    - ${value}`).join("\n")}\n`);
  if (report.mismatched.length) {
    process.stdout.write(`  hash mismatches:\n${report.mismatched.map((value) => `    - ${value.path}: expected ${value.expected}, got ${value.actual}`).join("\n")}\n`);
  }
  if (report.structuralIssues.length) {
    process.stdout.write(`  structural issues:\n${report.structuralIssues.map((value) => `    - ${JSON.stringify(value)}`).join("\n")}\n`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  try {
    const report = await verify(options);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printHuman(report, options.quiet);
    // Keep the default invocation useful for inspection in local tooling. CI
    // and release lanes opt into the strict non-zero contract explicitly.
    if (options.check && !report.ok) process.exitCode = 1;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    if (options.json) process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    else process.stderr.write(`source-manifest verification error: ${failure.error}\n`);
    process.exitCode = 1;
  }
}

await main();
