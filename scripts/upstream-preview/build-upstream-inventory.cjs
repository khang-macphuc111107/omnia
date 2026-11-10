#!/usr/bin/env node

/**
 * Build a conservative inventory of the material under upstream_extractions.
 *
 * This is deliberately an inventory, not a copier.  Upstream extractions mix
 * source repositories, production bundles, native binaries and browser
 * profiles.  Copying that tree into Omnia would make credentials/cache files
 * look like source and would make provenance impossible to audit.  The report
 * therefore records what can be used through an adapter and what must remain
 * evidence-only.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(
  process.env.OMNIA_REPO_ROOT || path.resolve(__dirname, "../.."),
);
const extractionRoot = path.join(repoRoot, "upstream_extractions");
const artifactRoot = path.join(repoRoot, "artifacts", "upstream-ui");
const jsonPath = path.join(artifactRoot, "upstream-inventory-current.json");
const markdownPath = path.join(repoRoot, "docs", "UPSTREAM_INTEGRATION_INVENTORY.md");

const categories = [
  "browser",
  "cli",
  "desktop-apps",
  "downloaders",
  "harnesses",
  "ide",
  "notebooks",
  "proxies",
  "research",
  "tools",
  "web-apis",
];

// These directories are runtime state, dependency material or build caches.
// They are recorded as exclusions rather than silently treated as source.
const excludedDirectoryNames = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".turbo",
  ".next",
  ".cache",
  "Cache",
  "Code Cache",
  "GPUCache",
  "Crashpad",
  "component_crx_cache",
  "Service Worker",
  "Session Storage",
  "Local Storage",
  "IndexedDB",
  "File System",
  "ShaderCache",
  "DawnGraphiteCache",
  "segmentation_platform",
  "chrome_canary_profile",
  // Unpacked production dependencies are runtime material, not source. The
  // production `out`, `dist`, `build` and `resources` trees remain in scope so
  // the inventory can point to actual UI/assets for an isolated adapter.
  "node_modules.asar.unpacked",
]);

// Match secrets and browser/runtime state, while allowing legitimate source
// modules such as `session.ts` and `auth.ts` to remain source evidence.
const sensitivePathPattern = /(?:^|[\\/])(?:cookie|cookies|profile|session storage|local storage|indexeddb|login data|web data|network[\\/]cookies|crashpad)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\.|$)|credentials?\.(?:json|ya?ml)|secrets?\.(?:json|ya?ml)|.*(?:private[_ -]?key|api[_ -]?key|access[_ -]?token).*)$/i;
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".cs", ".css", ".go", ".h", ".hh", ".hpp",
  ".html", ".java", ".js", ".jsx", ".json", ".md", ".mjs", ".mts", ".py",
  ".ps1", ".rs", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx",
  ".vue", ".wasm", ".xml", ".yaml", ".yml",
]);
const manifestNames = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "cargo.toml", "cargo.lock", "go.mod", "go.sum", "pyproject.toml",
  "requirements.txt", "requirements-dev.txt", "uv.lock", "poetry.lock",
  "gemfile", "composer.json", "deno.json", "deno.jsonc",
]);
const licensePattern = /^(?:license|licence|copying|notice|patents)(?:\.|$)/i;
const readmePattern = /^readme(?:\.|$)/i;
const entryPattern = /^(?:main|index|server|cli|app|run|start)(?:\.[^.]+)?$/i;
const binaryExtensions = new Set([
  ".appx", ".bin", ".crx", ".dll", ".dmg", ".exe", ".ico", ".node", ".nupkg",
  ".pdb", ".pak", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".so",
  ".dylib", ".7z", ".zip", ".tar", ".gz", ".mp3", ".mp4", ".mov", ".ttf",
  ".woff", ".woff2", ".wasm",
]);
const fileRecordLimit = 400;
const hashRecordLimit = 80;

function rel(value) {
  return path.relative(repoRoot, value).split(path.sep).join("/");
}

function runGit(args, cwd = repoRoot) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function sha256(filePath) {
  try {
    const stat = fs.statSync(filePath);
    // Hashing large production bundles makes the inventory slow and does not
    // add useful provenance.  Their path/size/mtime remain in the report.
    if (stat.size > 2 * 1024 * 1024) return null;
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function safeJson(filePath) {
  try {
    if (fs.statSync(filePath).size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isSensitive(relativePath) {
  return sensitivePathPattern.test(relativePath);
}

function integrationFor(category, moduleName, facts) {
  const name = `${category}/${moduleName}`.toLowerCase();
  if (facts.sensitiveFileCount > 0 || facts.runtimeProfileDetected) {
    return {
      mode: "evidence-only",
      reason: "contains runtime/profile or credential-shaped material; expose through a scoped adapter",
    };
  }
  if (name.includes("browser") || category === "browser") {
    return { mode: "adapter-first", reason: "use CDP/WebView2 boundary; do not embed a profile or copy browser state" };
  }
  if (category === "desktop-apps" || category === "ide") {
    return { mode: "isolated-runtime", reason: "launch the verified entrypoint in a worker and bridge only declared IPC" };
  }
  if (category === "cli" || category === "harnesses") {
    return { mode: "process-adapter", reason: "invoke the real upstream CLI/harness and preserve exit code, stdout and cancellation" };
  }
  if (category === "downloaders") {
    return { mode: "native-adapter", reason: "keep range/resume logic behind the downloader capability contract" };
  }
  if (category === "web-apis" || category === "proxies") {
    return { mode: "network-adapter", reason: "route through an explicit provider/session boundary; credentials stay outside the repo" };
  }
  if (category === "research" || category === "notebooks") {
    return { mode: "workflow-adapter", reason: "compose the real engine as a goal step with citations and evidence" };
  }
  return { mode: "review", reason: "no automatic runtime integration contract has been proven" };
}

function classify(category, moduleName, facts) {
  const name = `${category}/${moduleName}`.toLowerCase();
  if (facts.sensitiveFileCount > 0 || facts.runtimeProfileDetected) return "runtime-state-or-profile";
  if (name.includes("reconstructed") || name.includes("wrapper") || name.includes("fixture")) {
    return "reconstructed-or-test-artifact";
  }
  if (facts.sourceFiles > 0 && facts.manifestFiles.length > 0) return "upstream-source-or-buildable-tree";
  if (facts.sourceFiles > 0) return "source-or-extracted-code";
  if (facts.binaryFiles > 0 || facts.totalFiles > 0) return "bundle-or-native-artifact";
  return "empty-or-unreadable";
}

function moduleInventory(category, moduleDir) {
  const moduleName = path.basename(moduleDir);
  const files = [];
  const excluded = [];
  const symlinks = [];
  const realpaths = new Map();
  const stack = [moduleDir];
  let totalBytes = 0;
  let allFileCount = 0;
  let sourceFiles = 0;
  let binaryFiles = 0;
  let sensitiveFileCount = 0;
  let runtimeProfileDetected = false;
  const manifestFiles = [];
  const licenseFiles = [];
  const readmeFiles = [];
  const entryCandidates = [];
  const packageMetadata = [];
  let hashedRecords = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      excluded.push({ path: rel(dir), reason: `read-error:${error.code || "unknown"}` });
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = rel(absolute);
      if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) {
        excluded.push({ path: relative, reason: "runtime/dependency/cache directory" });
        if (/profile/i.test(entry.name)) runtimeProfileDetected = true;
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(absolute);
      } catch (error) {
        excluded.push({ path: relative, reason: `stat-error:${error.code || "unknown"}` });
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = null;
        try { target = fs.realpathSync(absolute); } catch { /* broken link is evidence */ }
        symlinks.push({ path: relative, target: target ? rel(target) : null, targetOutsideRepo: target ? !target.startsWith(repoRoot) : null });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      const size = stat.size;
      allFileCount += 1;
      totalBytes += size;
      const extension = path.extname(entry.name).toLowerCase();
      const sensitive = isSensitive(relative);
      const source = sourceExtensions.has(extension) && !binaryExtensions.has(extension);
      if (source) sourceFiles += 1;
      if (binaryExtensions.has(extension) || !source) binaryFiles += 1;
      if (sensitive) {
        sensitiveFileCount += 1;
        runtimeProfileDetected = runtimeProfileDetected || /profile|cookie|session|login data/i.test(relative);
      }
      const baseLower = entry.name.toLowerCase();
      if (manifestNames.has(baseLower)) manifestFiles.push(relative);
      if (licensePattern.test(entry.name)) licenseFiles.push(relative);
      if (readmePattern.test(entry.name)) readmeFiles.push(relative);
      if (entryPattern.test(entry.name) || /^bin[\\/]/i.test(path.relative(moduleDir, absolute))) {
        if (entryCandidates.length < 40) entryCandidates.push(relative);
      }
      if (baseLower === "package.json" && !sensitive) {
        const packageJson = safeJson(absolute);
        if (packageJson) {
          packageMetadata.push({
            path: relative,
            name: typeof packageJson.name === "string" ? packageJson.name : null,
            version: typeof packageJson.version === "string" ? packageJson.version : null,
            license: packageJson.license || packageJson.licenses || null,
            private: packageJson.private === true,
            main: typeof packageJson.main === "string" ? packageJson.main : null,
            bin: packageJson.bin || null,
            scripts: packageJson.scripts && typeof packageJson.scripts === "object"
              ? Object.keys(packageJson.scripts).sort()
              : [],
          });
        }
      }
      // Keep a bounded sample in JSON.  The aggregate counters above still
      // cover every traversed file, while the sample is enough for reviewers
      // to inspect extension, sensitivity and representative hashes.
      if (files.length < fileRecordLimit) {
        const hashable = !sensitive && hashedRecords < hashRecordLimit &&
          (manifestNames.has(baseLower) || licensePattern.test(entry.name) || readmePattern.test(entry.name) || entryPattern.test(entry.name));
        const digest = hashable ? sha256(absolute) : null;
        if (digest) hashedRecords += 1;
        files.push({
          path: relative,
          bytes: size,
          extension: extension || null,
          kind: source ? "source" : "binary-or-asset",
          sensitive,
          sha256: digest,
        });
      }
    }
  }

  // Detect a junction/symlink alias without traversing it.  A realpath lookup
  // is intentionally best-effort: Windows junctions can disappear while an
  // extraction is being updated.
  try { realpaths.set(moduleDir, fs.realpathSync(moduleDir)); } catch { /* ignore */ }

  const facts = {
    totalFiles: allFileCount,
    totalBytes,
    sourceFiles,
    binaryFiles,
    sensitiveFileCount,
    runtimeProfileDetected,
    manifestFiles: manifestFiles.sort(),
  };
  return {
    id: `${category}/${moduleName}`,
    category,
    name: moduleName,
    root: rel(moduleDir),
    gitHead: runGit(["rev-parse", "HEAD"], moduleDir),
    sourceClassification: classify(category, moduleName, facts),
    integration: integrationFor(category, moduleName, facts),
    facts: {
      ...facts,
      licenseSignal: licenseFiles.length > 0 || packageMetadata.some((p) => p.license),
      fileRecordLimit,
      hashRecordLimit,
      recordsTruncated: facts.totalFiles > fileRecordLimit,
    },
    manifests: manifestFiles.sort(),
    licenses: licenseFiles.sort(),
    readmes: readmeFiles.sort(),
    entryCandidates: entryCandidates.sort(),
    packageMetadata,
    symlinks,
    excluded,
    // Keep file-level evidence for consumers that need a precise pointer, but
    // never include content from sensitive paths and never materialize copies.
    files,
  };
}

function toMarkdown(report) {
  const lines = [
    "# Omnia upstream integration inventory",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository commit: ${report.repoCommit || "unknown"}`,
    "",
    "This report inventories `upstream_extractions` for adapter work. It does not copy upstream code, claim behavioral parity, or turn browser profiles and credentials into source artifacts.",
    "",
    "## Coverage",
    "",
    `- Categories scanned: **${report.summary.categoriesScanned} / ${report.summary.categoriesExpected}**`,
    `- Modules scanned: **${report.summary.modulesScanned}**`,
    `- Files represented: **${report.summary.filesRepresented.toLocaleString()}**`,
    `- Source-like files: **${report.summary.sourceFiles.toLocaleString()}**`,
    `- Binary/asset files: **${report.summary.binaryFiles.toLocaleString()}**`,
    `- Sensitive/runtime-shaped files withheld from content hashing: **${report.summary.sensitiveFileCount.toLocaleString()}**`,
    `- Modules with a license signal: **${report.summary.modulesWithLicenseSignal} / ${report.summary.modulesScanned}**`,
    "",
    "A module is not considered complete because it has a manifest or a successful build. Runtime, provider, authentication and IPC parity remain separate gates.",
    "",
    "## Module matrix",
    "",
    "| Module | Classification | Files | Source | Bytes | Integration mode | License signal |",
    "| --- | --- | ---: | ---: | ---: | --- | :---: |",
  ];
  for (const item of report.modules) {
    lines.push(`| \`${item.id}\` | ${item.sourceClassification} | ${item.facts.totalFiles.toLocaleString()} | ${item.facts.sourceFiles.toLocaleString()} | ${item.facts.totalBytes.toLocaleString()} | ${item.integration.mode} | ${item.facts.licenseSignal ? "yes" : "unknown"} |`);
  }
  lines.push(
    "",
    "## Integration rules",
    "",
    "- `process-adapter`: invoke the real upstream entrypoint; forward stdout/stderr, exit status, cancellation and resource limits.",
    "- `isolated-runtime`: keep production desktop/IDE assets in a worker or borrowed runtime and bridge only declared IPC. Do not merge Electron chrome into Omnia's shell.",
    "- `adapter-first`: use CDP/WebView2 or the extension/native-host protocol. Browser profiles are evidence and must remain outside the source/runtime package.",
    "- `network-adapter`: keep credentials and provider sessions in the OS credential store or explicit session boundary.",
    "- `evidence-only`: preserve the artifact and provenance but do not load it as executable Omnia source.",
    "",
    "## Review before wiring",
    "",
    "1. Check the module's `gitHead`, manifest and license evidence against the upstream repository or installed package.",
    "2. Add a capability adapter with a bounded command/IPC contract and an audit harness. A `200` response, process spawn, or static import is not behavioral parity.",
    "3. Keep sensitive files, cookies, local state, crash dumps and caches excluded. The inventory marks these paths so a future sync can preserve them as evidence without shipping them.",
    "4. Record build/runtime output in `artifacts/upstream-ui` and update the module's separate DoD status.",
    "",
    "The JSON report contains file pointers and hashes for reproducible review. Hashes are intentionally omitted for sensitive paths and files larger than 2 MiB; path/size evidence remains available.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  if (!fs.existsSync(extractionRoot)) {
    throw new Error(`upstream_extractions not found: ${extractionRoot}`);
  }
  const modules = [];
  const missingCategories = [];
  for (const category of categories) {
    const categoryDir = path.join(extractionRoot, category);
    if (!fs.existsSync(categoryDir)) {
      missingCategories.push(category);
      continue;
    }
    let entries = [];
    try { entries = fs.readdirSync(categoryDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || excludedDirectoryNames.has(entry.name)) continue;
      modules.push(moduleInventory(category, path.join(categoryDir, entry.name)));
    }
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const summary = modules.reduce((acc, item) => {
    acc.modulesScanned += 1;
    acc.filesRepresented += item.facts.totalFiles;
    acc.sourceFiles += item.facts.sourceFiles;
    acc.binaryFiles += item.facts.binaryFiles;
    acc.totalBytes += item.facts.totalBytes;
    acc.sensitiveFileCount += item.facts.sensitiveFileCount;
    acc.modulesWithLicenseSignal += item.facts.licenseSignal ? 1 : 0;
    return acc;
  }, {
    categoriesExpected: categories.length,
    categoriesScanned: categories.length - missingCategories.length,
    modulesScanned: 0,
    filesRepresented: 0,
    sourceFiles: 0,
    binaryFiles: 0,
    totalBytes: 0,
    sensitiveFileCount: 0,
    modulesWithLicenseSignal: 0,
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version, hostname: os.hostname() },
    repoRoot: rel(repoRoot),
    extractionRoot: rel(extractionRoot),
    repoCommit: runGit(["rev-parse", "HEAD"]),
    scope: "upstream_extractions first-level modules; runtime profiles and dependency/cache directories are explicitly excluded from traversal",
    missingCategories,
    summary,
    modules,
  };
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, toMarkdown(report));
  process.stdout.write(JSON.stringify({
    json: rel(jsonPath),
    markdown: rel(markdownPath),
    summary,
    missingCategories,
  }, null, 2) + "\n");
}

main();

