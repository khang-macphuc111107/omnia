#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const usage = `Usage:
  node scripts/ci/write-diagnostic-manifest.mjs --job NAME --dir PATH [--expect FILE ...]

The command records which expected diagnostic files were produced. Missing files
are reported in the manifest and do not change the exit status: an earlier
workflow step remains the authoritative pass/fail result.`;

function parseArgs(args) {
  const options = { expected: [] };
  const valueFlags = new Set(["--job", "--dir", "--expect"]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help") return { help: true };
    if (!valueFlags.has(flag) || index + 1 >= args.length) {
      throw new Error(`Unknown option or missing value: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--expect") options.expected.push(value);
    else options[flag.slice(2)] = value;
  }
  return options;
}

async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeEnv() {
  const names = [
    "GITHUB_JOB",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW",
    "GITHUB_REF",
    "GITHUB_EVENT_NAME",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "ImageOS",
    "ImageVersion",
  ];
  return Object.fromEntries(names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
}

export async function writeDiagnosticManifest({
  cwd = process.cwd(),
  job,
  dir,
  expected = [],
  now = new Date(),
} = {}) {
  if (!job || !/^[a-z][a-z0-9-]*$/u.test(job)) throw new Error("--job must be a lowercase identifier");
  if (!dir || path.isAbsolute(dir) || !within(path.resolve(cwd), path.resolve(cwd, dir))) {
    throw new Error("--dir must be relative and stay inside the workspace");
  }
  const outputDir = path.resolve(cwd, dir);
  const resolvedCwd = await realpath(cwd);
  const resolvedOutputDir = await realpath(outputDir);
  if (!within(resolvedCwd, resolvedOutputDir)) throw new Error("--dir must stay inside the workspace");
  const rows = [];
  for (const relativePath of [...new Set(expected)]) {
    if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)
      || relativePath.includes("\\") || !within(outputDir, path.resolve(outputDir, relativePath))) {
      throw new Error("--expect paths must stay inside --dir");
    }
    const filePath = path.join(outputDir, relativePath);
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !within(resolvedOutputDir, await realpath(filePath))) {
        throw new Error("--expect paths must stay inside --dir and cannot be symlinks");
      }
      rows.push({
        path: path.relative(cwd, filePath).replaceAll("\\", "/"),
        exists: metadata.isFile(),
        bytes: metadata.isFile() ? metadata.size : null,
        sha256: metadata.isFile() ? await hashFile(filePath) : null,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      rows.push({
        path: path.relative(cwd, filePath).replaceAll("\\", "/"),
        exists: false,
        bytes: null,
        sha256: null,
      });
    }
  }
  const missing = rows.filter((row) => !row.exists).map((row) => row.path);
  const manifest = {
    schemaVersion: 1,
    job,
    result: missing.length ? "missing-files" : "complete",
    generatedAt: now.toISOString(),
    cwd: path.relative(process.cwd(), cwd).replaceAll("\\", "/") || ".",
    environment: safeEnv(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    expectedCount: rows.length,
    presentCount: rows.length - missing.length,
    missing,
    files: rows,
    limitations: [
      "A missing file can indicate an early checkout/setup/action failure; inspect the GitHub job log for steps before this manifest.",
      "This manifest is diagnostic evidence and never converts a failed workflow step into success.",
    ],
  };
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
      process.exitCode = 0;
    } else {
      const manifest = await writeDiagnosticManifest(options);
      console.log(`diagnostic manifest: ${manifest.result}; ${manifest.presentCount}/${manifest.expectedCount} expected files present`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exitCode = 1;
  }
}

