import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const distDirectory = path.resolve(process.cwd(), process.env.OMNIA_BUNDLE_DIST ?? "dist");
const manifestPath = path.join(distDirectory, ".vite", "manifest.json");
const indexPath = path.join(distDirectory, "index.html");
const rebuildSource = "src/rebuild/rebuild-app.tsx";
const kib = 1024;
const budgets = Object.freeze({
  entryJavaScriptBytes: 500_000,
  asyncChunkBytes: 300 * kib,
  totalJavaScriptBytes: 5_000 * kib,
});

function formatBytes(value) {
  return `${value.toLocaleString("en-US")} B (${(value / kib).toFixed(2)} KiB)`;
}

function normalizeAssetPath(source) {
  const normalized = source.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  const relative = path.relative(distDirectory, path.resolve(distDirectory, normalized));
  if (!normalized || /[:?#\0]/.test(normalized) || source.startsWith("//") ||
      normalized.split("/").includes("..") || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`manifest asset path ${source} is outside the configured build output or invalid`);
  }
  return normalized;
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest object is invalid");
  for (const [key, record] of Object.entries(value)) {
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.file !== "string") {
      throw new Error(`manifest record ${key} is invalid`);
    }
    normalizeAssetPath(record.file);
    for (const edge of ["imports", "dynamicImports"]) {
      if (record[edge] !== undefined && (!Array.isArray(record[edge]) || record[edge].some((item) => typeof item !== "string" || !item))) {
        throw new Error(`manifest ${key}.${edge} must be an array of nonempty record keys`);
      }
    }
    for (const identity of ["src", "name"]) {
      if (record[identity] !== undefined && typeof record[identity] !== "string") {
        throw new Error(`manifest record ${key}.${identity} is invalid`);
      }
    }
  }
  return value;
}

let manifest;
let indexHtml;
try {
  const [manifestSource, htmlSource] = await Promise.all([readFile(manifestPath, "utf8"), readFile(indexPath, "utf8")]);
  manifest = validateManifest(JSON.parse(manifestSource));
  indexHtml = htmlSource;
} catch (cause) {
  process.stderr.write(`Bundle gate failed: Vite build output or manifest is missing/invalid. Run npm run build first. (${cause instanceof Error ? cause.message : "unknown error"})\n`);
  process.exit(1);
}

const manifestEntries = Object.entries(manifest);
const htmlEntries = manifestEntries.filter(([key, record]) => record.isEntry === true && (key === "index.html" || record.src === "index.html"));
if (htmlEntries.length !== 1) {
  process.stderr.write(`Bundle gate failed: expected one Vite manifest entry for index.html, found ${htmlEntries.length}.\n`);
  process.exit(1);
}

const [entryKey, entryRecord] = htmlEntries[0];
const entryAsset = normalizeAssetPath(entryRecord.file);
const violations = new Set();
const javascriptAssets = new Set(manifestEntries.map(([, record]) => normalizeAssetPath(record.file)).filter((file) => file.endsWith(".js")));
const assetSizes = new Map();
for (const asset of javascriptAssets) {
  try {
    const bytes = (await readFile(path.join(distDirectory, asset))).byteLength;
    assetSizes.set(asset, bytes);
    if (bytes === 0) violations.add(`manifest asset ${asset} is empty`);
  } catch (cause) {
    violations.add(`manifest asset ${asset} is missing (${cause instanceof Error ? cause.message : "unknown error"})`);
  }
}

const entryBytes = assetSizes.get(entryAsset) ?? 0;
if (!javascriptAssets.has(entryAsset)) violations.add(`index.html entry asset ${entryAsset} is not JavaScript`);
const largestAsync = [...assetSizes.entries()].filter(([asset]) => asset !== entryAsset)
  .reduce((largest, current) => current[1] > largest[1] ? current : largest, ["none", 0]);
const totalBytes = [...assetSizes.values()].reduce((total, value) => total + value, 0);
if (entryBytes > budgets.entryJavaScriptBytes) {
  violations.add(`entry ${entryAsset} is ${formatBytes(entryBytes)} (budget ${formatBytes(budgets.entryJavaScriptBytes)})`);
}
if (largestAsync[1] > budgets.asyncChunkBytes) {
  violations.add(`async chunk ${largestAsync[0]} is ${formatBytes(largestAsync[1])} (budget ${formatBytes(budgets.asyncChunkBytes)})`);
}
if (totalBytes > budgets.totalJavaScriptBytes) {
  violations.add(`total JavaScript is ${formatBytes(totalBytes)} (budget ${formatBytes(budgets.totalJavaScriptBytes)})`);
}

function graph(roots, includeDynamic) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const key = pending.pop();
    if (visited.has(key)) continue;
    visited.add(key);
    if (!Object.hasOwn(manifest, key)) {
      violations.add(`${key} is reachable but has no manifest record`);
      continue;
    }
    pending.push(...(manifest[key].imports ?? []));
    // Traverse static edges at every lazy hop too; a shared dependency can
    // itself import another lazy module. Both kinds of cycle are bounded.
    if (includeDynamic) pending.push(...(manifest[key].dynamicImports ?? []));
  }
  return visited;
}

function attribute(attributes, name) {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

const moduleScripts = new Set();
const scriptAssets = new Set();
const eagerAssets = new Set();
const uncommentedHtml = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
for (const [, attributes, body] of uncommentedHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
  const type = attribute(attributes, "type")?.trim().toLowerCase();
  if (!attribute(attributes, "src") && body.trim() && !["application/json", "application/ld+json"].includes(type)) {
    violations.add("index.html inline executable script cannot be attested by the local manifest graph");
  }
}
for (const [, tag, attributes] of uncommentedHtml.matchAll(/<(script|link)\b([^>]*)>/gi)) {
  const script = tag.toLowerCase() === "script";
  const reference = attribute(attributes, script ? "src" : "href");
  const rel = attribute(attributes, "rel") ?? "";
  if (!reference || (!script && !/(?:^|\s)(?:modulepreload|preload)(?:\s|$)/i.test(rel))) continue;
  // Remote scripts cannot be attested by this local build manifest.
  if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(reference)) {
    if (script) violations.add(`index.html script ${reference} has no local entry asset attestation`);
    continue;
  }
  let asset;
  try { asset = normalizeAssetPath(reference.split(/[?#]/)[0]); }
  catch (cause) { violations.add(cause.message); continue; }
  eagerAssets.add(asset);
  if (script) scriptAssets.add(asset);
  if (script && attribute(attributes, "type")?.toLowerCase() === "module") moduleScripts.add(asset);
}
if (!moduleScripts.has(entryAsset)) violations.add(`dist/index.html does not load the manifest entry asset ${entryAsset} as a module script`);

const htmlRoots = manifestEntries.filter(([, record]) => eagerAssets.has(normalizeAssetPath(record.file))).map(([key]) => key);
for (const asset of scriptAssets) {
  if (!manifestEntries.some(([, record]) => normalizeAssetPath(record.file) === asset)) {
    violations.add(`index.html script ${asset} has no manifest entry asset record`);
  }
}
const eagerStartup = graph([entryKey, ...htmlRoots], false);
const applicationGraph = graph([entryKey], true);
const reachable = graph([entryKey, ...htmlRoots], true);
const rebuildEntries = manifestEntries.filter(([key, record]) => key === rebuildSource || record.src === rebuildSource);
if (rebuildEntries.length !== 1) {
  violations.add(`${rebuildSource} must have exactly one Vite manifest record (found ${rebuildEntries.length})`);
} else {
  const [rebuildKey, rebuildRecord] = rebuildEntries[0];
  const rebuildAsset = normalizeAssetPath(rebuildRecord.file);
  if (rebuildRecord.isDynamicEntry !== true) violations.add(`${rebuildSource} must be a Vite dynamic entry`);
  if (!javascriptAssets.has(rebuildAsset)) violations.add(`${rebuildSource} must emit a JavaScript asset`);
  if (!applicationGraph.has(rebuildKey)) violations.add(`${rebuildSource} is not reachable from the index.html application graph`);
  if ([...eagerStartup].some((key) => Object.hasOwn(manifest, key) && normalizeAssetPath(manifest[key].file) === rebuildAsset)) {
    violations.add(`${rebuildSource} is reachable through the eager startup import graph`);
  }
  if (rebuildAsset === entryAsset) violations.add(`${rebuildSource} was folded into the startup entry asset`);
  if (eagerAssets.has(rebuildAsset)) violations.add(`${rebuildRecord.file} is eagerly referenced by dist/index.html`);
}

function legacyIdentity(key, record) {
  for (const source of [key, record.src].filter(Boolean)) {
    const normalized = source.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized.startsWith("src/") && normalized !== "src/main.tsx" &&
        !normalized.startsWith("src/rebuild/") && !/^src\/domain\/.+\.ts$/.test(normalized) &&
        !["src/lib/desktop.ts", "src/lib/core-protocol.ts"].includes(normalized)) return source;
  }
  // Rollup shared chunks can omit their original source path. Keep known
  // retired renderer chunk identities forbidden after such promotion.
  const retiredChunk = /(?:^|[\\/_-])(?:labs-app|labs-shell|workspace-composer|workspace-store|workspace-catalog|project-planning|screens)(?:[.\\/_-]|$)|(?:^|[\\/_])App(?:[.-]|$)/i;
  return [key, record.name, record.file].filter(Boolean).find((identity) => retiredChunk.test(identity));
}
for (const key of reachable) {
  if (!Object.hasOwn(manifest, key)) continue;
  const legacy = legacyIdentity(key, manifest[key]);
  if (legacy) violations.add(`legacy renderer ${legacy} is reachable from the built application`);
}

if (violations.size) {
  process.stderr.write(`Bundle gate failed:\n- ${[...violations].join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write([
    "Bundle gate OK (Vite manifest verified):",
    `- manifest entry: ${entryKey} -> ${entryAsset}`,
    `- original renderer: ${rebuildSource} (lazy application entry)`,
    `- entry: ${formatBytes(entryBytes)} / ${formatBytes(budgets.entryJavaScriptBytes)}`,
    `- JavaScript chunks: ${javascriptAssets.size} total; largest async ${largestAsync[0]} at ${formatBytes(largestAsync[1])} / ${formatBytes(budgets.asyncChunkBytes)}`,
    `- total JavaScript: ${formatBytes(totalBytes)} / ${formatBytes(budgets.totalJavaScriptBytes)}`,
    "- reachable legacy renderer manifest identities: absent",
    "- scope: emitted chunk graph; run rebuild:architecture for bundled source import/copy checks",
  ].join("\n") + "\n");
}
