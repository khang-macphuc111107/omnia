import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const rebuildRoot = join(root, "src", "rebuild");
const legacyRoots = ["src/agent", "src/components", "src/features", "src/styles", "src/labs"];
const sourceExt = /\.(?:[cm]?[jt]sx?|css)$/u;

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else if (sourceExt.test(entry.name)) result.push(path);
  }
  return result;
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function newSource() {
  return filesUnder(rebuildRoot);
}

function resolveLocalImport(owner, specifier) {
  const stem = specifier.startsWith("@/")
    ? join(root, "src", specifier.slice(2))
    : specifier.startsWith(".") ? resolve(owner, "..", specifier) : null;
  if (!stem) return null;
  for (const candidate of [stem, ...[".ts", ".tsx", ".css", ".json", ".mjs"].map((extension) => stem + extension), join(stem, "index.ts"), join(stem, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Missing local import ${specifier} in ${relative(root, owner)}`);
}

function sourceGraph(entry) {
  const pending = [entry];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const item of info.importedFiles) {
      const imported = resolveLocalImport(file, item.fileName);
      if (imported) pending.push(imported);
    }
  }
  return seen;
}

test("actual application entry graph excludes historical renderer source", () => {
  const permitted = (file) => {
    const name = relative(root, file).replaceAll("\\", "/");
    return name === "src/main.tsx" || name === "src/App.tsx" ||
      name.startsWith("src/rebuild/") ||
      (/^src\/(?:lib|domain)\//u.test(name) && !/\.(?:tsx|css)$/u.test(name));
  };
  const offenders = [...sourceGraph(join(root, "src", "main.tsx"))].filter((file) => !permitted(file)).map((file) => relative(root, file));
  assert.deepEqual(offenders, [], `legacy renderer reachable from entry: ${offenders.join(", ")}`);
});

test("clean-room renderer has source before a Done claim", () => {
  assert.ok(newSource().length > 0, "src/rebuild is empty; UI criteria remain incomplete");
});

test("new renderer does not import historical UI modules or styles", () => {
  const offenders = [];
  for (const file of newSource()) {
    const text = readFileSync(file, "utf8");
    if (/from\s+["'](?:@\/)?(?:agent|components|features|styles|labs)\//u.test(text)) {
      offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], `legacy UI imports: ${offenders.join(", ")}`);
});

test("new renderer does not introduce live editor or external iframe embedding", () => {
  const offenders = [];
  for (const file of newSource()) {
    const text = readFileSync(file, "utf8");
    let hasUnsafeFrame = false;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "iframe") {
        const attributes = node.attributes.properties;
        const srcDoc = attributes.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "srcDoc");
        const externalSrc = attributes.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "src");
        const sandbox = attributes.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "sandbox");
        const sandboxValue = sandbox && ts.isStringLiteral(sandbox.initializer) ? sandbox.initializer.text : null;
        // A local sandboxed artifact srcDoc is different from embedding a live app.
        if (!srcDoc || externalSrc || sandboxValue === null || /allow-same-origin/u.test(sandboxValue)) hasUnsafeFrame = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (hasUnsafeFrame || /real-vscode-workbench|vscode\.dev|codesandbox\.io|stackblitz\.com/iu.test(text)) {
      offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, [], `external/live embeds: ${offenders.join(", ")}`);
});

test("new source is not an exact file copy of the historical UI", () => {
  const oldHashes = new Map();
  for (const rootPath of legacyRoots.flatMap((path) => filesUnder(join(root, path)))) {
    const stat = statSync(rootPath);
    if (stat.size <= 1_500_000) oldHashes.set(digest(rootPath), relative(root, rootPath));
  }
  const duplicates = [];
  for (const file of newSource()) {
    const match = oldHashes.get(digest(file));
    if (match) duplicates.push(`${relative(root, file)} == ${match}`);
  }
  assert.deepEqual(duplicates, [], `exact copied UI files: ${duplicates.join(", ")}`);
});

test("canonical evidence documents exist before strict completion review", () => {
  const required = ["GOAL.md", "SPEC.md", "DOD.json", "SOURCE_REGISTER.json", "CHECKPOINT.md"];
  const missing = required.filter((name) => !existsSync(join(root, "docs", "rebuild", name)));
  assert.deepEqual(missing, [], `missing rebuild resume artifacts: ${missing.join(", ")}`);
});
