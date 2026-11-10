import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { resolvePortableFile, sha256 } from "./workflow.mjs";

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|css)$/i;
const TEST_FILE = /(?:\.(?:test|spec)\.[^.]+$|(?:^|\/)__tests__\/)/;
const PURE_HOST_FILES = new Set(["src/lib/desktop.ts", "src/lib/core-protocol.ts"]);
const PACKAGES = [
  "react", "react-dom", "lucide-react", "clsx", "zustand", "sonner",
  "@tauri-apps/api", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener",
  "@tauri-apps/plugin-store", "@tauri-apps/plugin-os", "@tauri-apps/plugin-window-state",
  "@tanstack/react-query", "@tanstack/react-virtual",
];
const isNew = (relative) => relative.startsWith("src/rebuild/");
const isPure = (relative) => PURE_HOST_FILES.has(relative) || (relative.startsWith("src/domain/") && relative.endsWith(".ts"));

async function inventory(root, relative) {
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return []; }
  const groups = await Promise.all(entries.map(async (entry) => {
    const item = `${relative}/${entry.name}`;
    if (entry.isDirectory() && !entry.name.startsWith(".")) return inventory(root, item);
    return entry.isFile() && SOURCE_EXTENSION.test(item) && !TEST_FILE.test(item) ? [item] : [];
  }));
  return groups.flat();
}

function allowedPackage(specifier) {
  return PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

async function resolveImport(root, from, specifier) {
  const withoutQuery = specifier.replace(/\?(?:raw|url|inline)$/, "");
  const relative = withoutQuery.startsWith("@/") ? `src/${withoutQuery.slice(2)}`
    : withoutQuery.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), withoutQuery)) : null;
  if (!relative) {
    if (!allowedPackage(specifier)) throw new Error(`${from}: external package is outside the new UI allowlist: ${specifier}`);
    return null;
  }
  const candidates = [relative, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".json"].map((ext) => `${relative}${ext}`),
    ...["index.ts", "index.tsx", "index.js", "index.css"].map((entry) => `${relative}/${entry}`)];
  for (const candidate of candidates) {
    try {
      const resolved = await resolvePortableFile(root, candidate);
      return { relative: candidate, resolved };
    } catch (error) {
      if (/traversal|outside checkout|Absolute evidence/.test(error.message)) throw error;
    }
  }
  throw new Error(`${from}: unresolved local import ${specifier}`);
}

function parseScript(source, relative) {
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(relative) ? ts.ScriptKind.TSX : /\.jsx$/.test(relative) ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
}

function importsFromScript(sourceFile, violations) {
  const imports = [];
  const addExpression = (expression, node, kind) => {
    if (expression && ts.isStringLiteralLike(expression)) imports.push(expression.text);
    else violations.push(`${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}: computed ${kind} cannot be audited statically`);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) addExpression(node.moduleSpecifier, node, "import/export");
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) addExpression(node.moduleReference.expression, node, "require");
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) addExpression(node.arguments[0], node, "dynamic import/require");
      const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
      const first = node.arguments[0];
      if ((method === "createElement" || method === "jsx" || method === "jsxs") && first && ts.isStringLiteralLike(first) && /^(iframe|webview|object|embed)$/i.test(first.text)) violations.push(`${sourceFile.fileName}: programmatic embedded app surface ${first.text}`);
      if (/^(startIdeWorkspace|startSovereignIde|attachIdeWorkspace)$/.test(method)) violations.push(`${sourceFile.fileName}: retired external editor runtime ${method}`);
      for (const argument of node.arguments) if (ts.isStringLiteralLike(argument) && /(?:__omnia_browser_proxy|__omnia_ide|ide_workspace_start|127\.0\.0\.1:1430)/i.test(argument.text)) violations.push(`${sourceFile.fileName}: legacy app/editor proxy use`);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile).toLowerCase();
      if (["iframe", "webview", "embed", "object"].includes(tag)) violations.push(`${sourceFile.fileName}: embedded app element <${tag}>; use Omnia native surfaces`);
    }
    if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) && /<\s*(?:iframe|webview|embed|object)\b/i.test(node.text)) violations.push(`${sourceFile.fileName}: HTML embedded app element`);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function sourceTokens(source, relative) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(relative) ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, source);
  const tokens = [];
  let token;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return tokens;
}

function copyFingerprints(source, relative) {
  const tokens = relative.endsWith(".css") ? source.replace(/\/\*[\s\S]*?\*\//g, "").split(/\s+/).filter(Boolean) : sourceTokens(source, relative);
  const signatures = new Set();
  const normalized = tokens.join(" ");
  if (normalized.length >= 400) signatures.add(`file:${sha256(normalized)}`);
  // A substantial verbatim-block heuristic cannot prove visual/design originality.
  for (let index = 0; index + 180 <= tokens.length; index += 45) {
    const block = tokens.slice(index, index + 180).join(" ");
    if (block.length >= 1100) signatures.add(`block:${sha256(block)}`);
  }
  return signatures;
}

export async function guardArchitecture(root, { entry = "src/main.tsx", requireRebuildImport = true, checkCopies = true } = {}) {
  await resolvePortableFile(root, entry);
  const rebuildFiles = await inventory(root, "src/rebuild");
  const queue = [entry, ...rebuildFiles];
  const visited = new Set();
  const newSignatures = new Map();
  const violations = [];
  while (queue.length > 0) {
    const relative = queue.shift();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const file = await resolvePortableFile(root, relative);
    if (!SOURCE_EXTENSION.test(relative)) continue;
    const source = await readFile(file, "utf8");
    const isEntry = relative === entry || relative === "src/App.tsx";
    if (!isEntry && !isNew(relative) && !isPure(relative)) {
      violations.push(`${relative}: legacy or unapproved renderer import`);
      continue;
    }
    if (isNew(relative) && checkCopies) for (const signature of copyFingerprints(source, relative)) if (!newSignatures.has(signature)) newSignatures.set(signature, relative);
    let imports;
    if (relative.endsWith(".css")) {
      imports = [...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)].map((match) => match[1]);
      if (/@import\s+(?:url\(\s*)?(?!["'])/i.test(source)) violations.push(`${relative}: unparsed stylesheet @import`);
    } else {
      imports = importsFromScript(parseScript(source, relative), violations);
      if (isPure(relative) && imports.some((item) => item === "react" || item.startsWith("react/"))) violations.push(`${relative}: native/domain contract imports React`);
    }
    for (const specifier of imports) {
      try { const resolved = await resolveImport(root, relative, specifier); if (resolved) queue.push(resolved.relative); }
      catch (error) { violations.push(error.message); }
    }
  }
  if (requireRebuildImport && ![...visited].some(isNew)) violations.push(`${entry}: does not load the original src/rebuild renderer`);
  if (checkCopies && newSignatures.size > 0) {
    const legacyFiles = (await inventory(root, "src")).filter((relative) => !isNew(relative) && relative !== entry && relative !== "src/App.tsx" && /\.(tsx|jsx|css)$/.test(relative));
    for (const relative of legacyFiles) {
      const source = await readFile(await resolvePortableFile(root, relative), "utf8");
      for (const signature of copyFingerprints(source, relative)) {
        const freshFile = newSignatures.get(signature);
        if (freshFile) { violations.push(`${freshFile}: substantial verbatim UI source matches ${relative}`); break; }
      }
    }
  }
  if (violations.length) throw new Error(`Architecture guard failed:\n${[...new Set(violations)].join("\n")}`);
  return { entry, graphFiles: [...visited].sort(), rebuildFiles, copyDetection: checkCopies ? "verbatim-block heuristic" : "disabled", violations: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await guardArchitecture(process.cwd());
    console.log(JSON.stringify({ schemaVersion: 1, result: "passed", ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
