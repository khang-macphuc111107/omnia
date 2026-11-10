#!/usr/bin/env node
/**
 * Produce a bounded, credential-safe inventory of the upstream extraction corpus.
 * This is evidence about readable artifacts, not a parity or license claim.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const corpus = process.env.OMNIA_UPSTREAM_ROOT ?? "D:/Omnia/repos/omnia/upstream_extractions";
const out = process.env.OMNIA_CORPUS_INVENTORY ?? "docs/rebuild/research/CORPUS_INVENTORY.json";
const maxFilesPerModule = 2000;
const maxDepth = 6;
const skipNames = new Set(["node_modules", "assets", "cache", "cookies", "profiles", "profile", "sessions", "target", ".git", "dist", "build"]);
const skipPath = /(cookie|credential|secret|token|password|local state|crash|dump|browser data|login data)/i;
const sourceExt = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py", ".go", ".java", ".cs", ".cpp", ".h", ".md", ".json", ".toml", ".yaml", ".yml", ".html", ".css"]);
const manifestNames = new Set(["package.json", "Cargo.toml", "pyproject.toml", "README.md", "LICENSE", "LICENSE.md", "SPEC.md", "SPEC_AND_PROTOCOL.md", "SPEC_AND_ARCHITECTURE.md", "ARCHITECTURE_AND_CDP_SPEC.md"]);
const sampleLimit = 12;
const maxSampleBytes = 512 * 1024;

async function children(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}
async function walk(root) {
  const stack = [{ dir: root, depth: 0 }]; const files = []; let skipped = 0; let truncated = false;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    for (const entry of await children(dir)) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replaceAll("\\", "/");
      if (skipNames.has(entry.name) || skipPath.test(rel)) { skipped++; continue; }
      if (entry.isSymbolicLink()) { skipped++; continue; }
      if (entry.isDirectory()) {
        if (depth >= maxDepth) truncated = true;
        else stack.push({ dir: full, depth: depth + 1 });
      }
      else if (entry.isFile()) files.push({ full, rel, name: entry.name });
      if (files.length >= maxFilesPerModule) { truncated = true; stack.length = 0; break; }
    }
  }
  return { files, skipped, truncated };
}
const rootEntries = await children(corpus);
const modules = [];
for (const categoryEntry of rootEntries.filter((x) => x.isDirectory())) {
  for (const moduleEntry of await children(path.join(corpus, categoryEntry.name))) {
    if (!moduleEntry.isDirectory() || moduleEntry.name === "zalo-desktop") continue;
    const modulePath = path.join(corpus, categoryEntry.name, moduleEntry.name);
    const { files, skipped, truncated } = await walk(modulePath);
    const source = files.filter((x) => sourceExt.has(path.extname(x.name).toLowerCase()));
    const manifests = files.filter((x) => manifestNames.has(x.name)).slice(0, 12).map((x) => x.rel);
    const samples = [];
    for (const file of source.slice(0, sampleLimit)) {
      try {
        const stat = await fs.stat(file.full);
        if (stat.size > maxSampleBytes) continue;
        const bytes = await fs.readFile(file.full);
        samples.push({ path: `${categoryEntry.name}/${moduleEntry.name}/${file.rel}`, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), modifiedAt: stat.mtime.toISOString() });
      } catch { /* bounded inventory: unreadable files stay unverified */ }
    }
    modules.push({ id: `${categoryEntry.name}/${moduleEntry.name}`, category: categoryEntry.name, module: moduleEntry.name, observedFiles: files.length, observedSourceFiles: source.length, truncated, skippedSensitiveOrGenerated: skipped, manifests, samples, classification: source.length >= 20 ? "substantial-readable" : source.length > 0 ? "small-readable" : "artifact-or-empty" });
  }
}
modules.sort((a, b) => a.id.localeCompare(b.id));
const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), corpus: path.resolve(corpus), excludedModules: ["desktop-apps/zalo-desktop"], safety: { maxDepth, maxFilesPerModule, sampleLimit, maxSampleBytes, skippedPathPatterns: ["node_modules", "assets", "cache", "cookies", "profiles", "sessions", "target", "credential-like paths"], sampledContentHashing: true, sensitiveContentNeverRead: true }, summary: { categories: new Set(modules.map((m) => m.category)).size, modules: modules.length, readableModules: modules.filter((m) => m.observedSourceFiles > 0).length, substantialModules: modules.filter((m) => m.classification === "substantial-readable").length, truncatedModules: modules.filter((m) => m.truncated).length, hashedSamples: modules.reduce((n, m) => n + m.samples.length, 0) }, modules };
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result.summary));
