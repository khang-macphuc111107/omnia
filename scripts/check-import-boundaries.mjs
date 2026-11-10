import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const sourceRoot = path.join(repositoryRoot, "src");

const codeExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const testFilePattern = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/i;
const importPattern = /\b(?:import\s+(?:(?:type\s+)?[^"'`\n;]*?\s+from\s+)?|export\s+(?:[^"'`\n;]*?\s+from\s+)?|import\s*\(\s*)["']([^"']+)["']/g;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && codeExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

function relativeSourcePath(filePath) {
  return path.relative(sourceRoot, filePath).replaceAll(path.sep, "/");
}

function isTestOnlyFile(filePath) {
  const relative = relativeSourcePath(filePath);
  return relative.startsWith("test/") || testFilePattern.test(relative);
}

function isVisualFixtureFile(filePath) {
  return relativeSourcePath(filePath).startsWith("visual-fixtures/");
}

function isWorkspaceMockDataFile(filePath) {
  return relativeSourcePath(filePath) === "features/workspace/mock-data.ts";
}

function resolveLocalImport(importer, specifier) {
  let candidate;
  if (specifier.startsWith("@/")) {
    candidate = path.join(sourceRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidate = path.resolve(path.dirname(importer), specifier);
  } else {
    return null;
  }

  const candidates = [candidate];
  if (!path.extname(candidate)) {
    for (const extension of codeExtensions) candidates.push(`${candidate}${extension}`);
    for (const extension of codeExtensions) candidates.push(path.join(candidate, `index${extension}`));
  }

  return (
    candidates.find(
      (filePath) =>
        filePath.startsWith(sourceRoot) && codeExtensions.has(path.extname(filePath).toLowerCase()),
    ) ?? null
  );
}

function describeBoundary(importer, target) {
  const importerRelative = relativeSourcePath(importer);
  const targetRelative = relativeSourcePath(target);

  if (isTestOnlyFile(target)) {
    return `production module imports test-only module ${targetRelative}`;
  }
  if (isVisualFixtureFile(target) && importerRelative !== "main.tsx") {
    return `production module imports browser visual fixture ${targetRelative}`;
  }
  if (isWorkspaceMockDataFile(target)) {
    return `production module imports browser-preview mock data ${targetRelative}`;
  }
  return null;
}

const allSourceFiles = await collectSourceFiles(sourceRoot);
const productionFiles = allSourceFiles.filter(
  (filePath) => !isTestOnlyFile(filePath) && !isVisualFixtureFile(filePath),
);
const violations = [];
let localImportsChecked = 0;

for (const importer of productionFiles) {
  const source = await readFile(importer, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const target = resolveLocalImport(importer, specifier);
    if (!target) continue;
    localImportsChecked += 1;
    const boundary = describeBoundary(importer, target);
    if (boundary) {
      const line = source.slice(0, match.index ?? 0).split(/\r?\n/).length;
      violations.push(`${relativeSourcePath(importer)}:${line}: ${boundary}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Import boundary contract failed: ${violations.length} violation(s) across ${localImportsChecked} local import(s).\n${violations
      .sort()
      .map((violation) => `- ${violation}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Import boundary contract OK: ${productionFiles.length} production module(s), ${localImportsChecked} local import(s) checked; test, visual-fixture, and browser-preview mock boundaries are clean.\n`,
  );
}
