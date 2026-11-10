import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspace = process.cwd();
const twinDirectory = path.join(workspace, "docs", "project-twin");
const catalogPath = path.join(twinDirectory, "catalog.json");
const generatedFiles = new Set([
  "docs/project-twin/manifest.json",
  "docs/project-twin/graph.json",
  "docs/project-twin/atlas.html",
  "docs/project-twin/atlas.css",
  "docs/project-twin/atlas.js",
]);
const excludedDirectoryNames = new Set([
  ".git",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "target",
  // Vitest/Playwright write transient receipts here while the workspace is
  // being validated. They are not source evidence and must not churn the
  // Project Twin snapshot between bootstrap and check.
  "test-results",
  ".cargo-target-test",
  ".cargo-target-verify",
]);
const excludedPrefixes = [
  "artifacts/",
  "src-tauri/target/",
  // Vendored upstream research bundles are reference material rather than
  // current-tree source evidence; hashing tens of thousands of files here
  // makes an otherwise local UI edit needlessly churn the Twin revision.
  "research/upstreams/",
];
const excludedSuffixes = [".log", ".out"];
const excludedTransientFiles = new Set([
  ".ipc-target-current.txt",
  "kernel-test-output.txt",
  "machine-test-output.txt",
  "telemetry-test-output.txt",
  "visual-list-exit.txt",
  "visual-list-output.txt",
  "vitest-drawer.json",
]);
const generatedRevisionTimestamp = "2026-08-14T00:00:00Z";
const catalogSchemaPath = "./catalog.schema.json";
const allowedStatuses = new Set([
  "accepted",
  "implemented",
  "verified",
  "partial",
  "preview",
  "planned",
  "deferred",
  "blocked",
]);
const allowedEvidenceClasses = new Set([
  "source_fact",
  "static_analysis",
  "runtime",
  "test",
  "screenshot",
  "audit",
  "user_annotation",
  "ai_interpretation",
  "inference",
]);
const safeIdPattern = /^[a-z0-9][a-z0-9._-]*$/;

function toRelativePath(value) {
  return path.relative(workspace, value).replaceAll("\\", "/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      generatedFiles.has(relative) ||
      excludedPrefixes.some((value) => relative.startsWith(value)) ||
      excludedSuffixes.some((value) => relative.endsWith(value)) ||
      excludedTransientFiles.has(relative)
    ) continue;
    if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) continue;

    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files;
}

async function hashWorkspaceFiles() {
  const relativeFiles = await collectFiles(workspace);
  const hashes = new Map();
  const lineCounts = new Map();
  for (const relative of relativeFiles) {
    const bytes = await readFile(path.join(workspace, relative));
    hashes.set(relative, sha256(bytes));
    lineCounts.set(relative, countSourceLines(bytes));
  }
  const lines = relativeFiles.map((relative) => `${hashes.get(relative)}  ${relative}\n`).join("");
  return {
    files: relativeFiles,
    hashes,
    lineCounts,
    snapshotHash: sha256(lines),
  };
}

function countSourceLines(bytes) {
  if (bytes.length === 0) return 0;
  let lineCount = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lineCount += 1;
  }
  return lineCount + (bytes.at(-1) === 0x0a ? 0 : 1);
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value, requiredKeys, optionalKeys, label) {
  assertRecord(value, label);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}.`);
  }
  for (const key of requiredKeys) {
    if (!(key in value)) throw new Error(`${label} is missing required field ${key}.`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSafeId(value, label) {
  const id = requireString(value, label);
  if (!safeIdPattern.test(id)) {
    throw new Error(`${label} must use lowercase identifier characters only.`);
  }
  return id;
}

function requireArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? "a non-empty" : "an"} array.`);
  }
  return value;
}

function requireWorkspaceRelativePath(value, label) {
  const pathName = requireString(value, label);
  if (
    pathName.includes("\\") ||
    path.posix.isAbsolute(pathName) ||
    pathName === "." ||
    pathName === ".." ||
    pathName.startsWith("../") ||
    pathName.endsWith("/") ||
    path.posix.normalize(pathName) !== pathName
  ) {
    throw new Error(`${label} must be a normalized workspace-relative POSIX path.`);
  }
  return pathName;
}

function validateSourceRefShape(sourceRef, label) {
  assertExactKeys(sourceRef, ["path", "startLine", "endLine"], [], label);
  requireWorkspaceRelativePath(sourceRef.path, `${label}.path`);
  if (!Number.isSafeInteger(sourceRef.startLine) || sourceRef.startLine < 1) {
    throw new Error(`${label}.startLine must be a positive safe integer.`);
  }
  if (!Number.isSafeInteger(sourceRef.endLine) || sourceRef.endLine < sourceRef.startLine) {
    throw new Error(`${label}.endLine must be a safe integer at or after startLine.`);
  }
}

function validateCatalogShape(catalog) {
  assertExactKeys(
    catalog,
    ["$schema", "schemaVersion", "projectId", "title", "nodes", "edges", "evidence"],
    [],
    "Project Twin catalog",
  );
  if (catalog.$schema !== catalogSchemaPath) {
    throw new Error(`Project Twin catalog must declare ${catalogSchemaPath}.`);
  }
  if (catalog.schemaVersion !== 1 || catalog.projectId !== "omnia") {
    throw new Error("Project Twin catalog must use schemaVersion 1 and projectId omnia.");
  }
  requireString(catalog.title, "Project Twin catalog.title");
  requireArray(catalog.nodes, "Project Twin catalog.nodes", { nonEmpty: true });
  requireArray(catalog.edges, "Project Twin catalog.edges", { nonEmpty: true });
  requireArray(catalog.evidence, "Project Twin catalog.evidence", { nonEmpty: true });

  for (const [index, node] of catalog.nodes.entries()) {
    const label = `Project Twin node[${index}]`;
    assertExactKeys(
      node,
      ["id", "type", "label", "status", "description", "sourceRefs", "evidenceIds"],
      [],
      label,
    );
    requireSafeId(node.id, `${label}.id`);
    requireSafeId(node.type, `${label}.type`);
    requireString(node.label, `${label}.label`);
    requireString(node.description, `${label}.description`);
    if (!allowedStatuses.has(node.status)) throw new Error(`${label}.status is unsupported.`);
    requireArray(node.sourceRefs, `${label}.sourceRefs`, { nonEmpty: true }).forEach(
      (sourceRef, sourceRefIndex) =>
        validateSourceRefShape(sourceRef, `${label}.sourceRefs[${sourceRefIndex}]`),
    );
    requireArray(node.evidenceIds, `${label}.evidenceIds`, { nonEmpty: true }).forEach(
      (evidenceId, evidenceIndex) => requireSafeId(evidenceId, `${label}.evidenceIds[${evidenceIndex}]`),
    );
  }

  for (const [index, edge] of catalog.edges.entries()) {
    const label = `Project Twin edge[${index}]`;
    assertExactKeys(
      edge,
      ["id", "type", "source", "target", "evidenceClass", "evidenceIds"],
      ["confidence"],
      label,
    );
    requireSafeId(edge.id, `${label}.id`);
    requireSafeId(edge.type, `${label}.type`);
    requireSafeId(edge.source, `${label}.source`);
    requireSafeId(edge.target, `${label}.target`);
    if (!allowedEvidenceClasses.has(edge.evidenceClass)) {
      throw new Error(`${label}.evidenceClass is unsupported.`);
    }
    requireArray(edge.evidenceIds, `${label}.evidenceIds`, { nonEmpty: true }).forEach(
      (evidenceId, evidenceIndex) => requireSafeId(evidenceId, `${label}.evidenceIds[${evidenceIndex}]`),
    );
    if (edge.evidenceClass === "inference") {
      if (typeof edge.confidence !== "number" || edge.confidence < 0 || edge.confidence > 1) {
        throw new Error(`${label}.confidence is required for inference evidence and must be between zero and one.`);
      }
    } else if (edge.confidence !== undefined) {
      throw new Error(`${label}.confidence is only valid for inference evidence.`);
    }
  }

  for (const [index, evidence] of catalog.evidence.entries()) {
    const label = `Project Twin evidence[${index}]`;
    assertExactKeys(evidence, ["id", "class", "path"], [], label);
    requireSafeId(evidence.id, `${label}.id`);
    if (!allowedEvidenceClasses.has(evidence.class)) {
      throw new Error(`${label}.class is unsupported.`);
    }
    requireWorkspaceRelativePath(evidence.path, `${label}.path`);
  }
}

async function readCatalog() {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  validateCatalogShape(catalog);
  return catalog;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function contentHashFor(pathName, hashes) {
  const hash = hashes.get(pathName);
  if (!hash) throw new Error(`Project Twin source reference does not exist in the source snapshot: ${pathName}`);
  return hash;
}

function hydrateSourceRefs(nodeId, sourceRefs, hashes, lineCounts) {
  return sourceRefs.map((sourceRef) => {
    const contentHash = contentHashFor(sourceRef.path, hashes);
    const lineCount = lineCounts.get(sourceRef.path);
    if (!Number.isSafeInteger(lineCount)) {
      throw new Error(`Project Twin source reference has no line count: ${sourceRef.path}`);
    }
    if (sourceRef.endLine > lineCount) {
      throw new Error(
        `Project Twin node ${nodeId} source reference exceeds ${sourceRef.path} line count ` +
          `(${sourceRef.startLine}-${sourceRef.endLine}, file has ${lineCount}).`,
      );
    }
    return {
      path: sourceRef.path,
      startLine: sourceRef.startLine,
      endLine: sourceRef.endLine,
      contentHash,
    };
  });
}

function hydrateEvidence(catalog, hashes) {
  return catalog.evidence.map((evidence) => ({
    id: evidence.id,
    class: evidence.class,
    path: evidence.path,
    contentHash: contentHashFor(evidence.path, hashes),
    stale: false,
  }));
}

function hydrateGraph(catalog, hashes, lineCounts, snapshotHash, revisionId) {
  const nodeIds = catalog.nodes.map((node) => node.id);
  const edgeIds = catalog.edges.map((edge) => edge.id);
  const evidenceIds = catalog.evidence.map((evidence) => evidence.id);
  assertUnique(nodeIds, "node id");
  assertUnique(edgeIds, "edge id");
  assertUnique(evidenceIds, "evidence id");

  const nodeSet = new Set(nodeIds);
  const evidenceSet = new Set(evidenceIds);
  const nodes = catalog.nodes.map((node) => {
    for (const evidenceId of node.evidenceIds) {
      if (!evidenceSet.has(evidenceId)) throw new Error(`Node ${node.id} references unknown evidence ${evidenceId}`);
    }
    return {
      id: node.id,
      type: node.type,
      label: node.label,
      status: node.status,
      description: node.description,
      sourceRefs: hydrateSourceRefs(node.id, node.sourceRefs, hashes, lineCounts),
      evidenceIds: [...node.evidenceIds],
    };
  });

  const edges = catalog.edges.map((edge) => {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) {
      throw new Error(`Edge ${edge.id} references an unknown node.`);
    }
    for (const evidenceId of edge.evidenceIds) {
      if (!evidenceSet.has(evidenceId)) throw new Error(`Edge ${edge.id} references unknown evidence ${evidenceId}`);
    }
    return {
      id: edge.id,
      type: edge.type,
      source: edge.source,
      target: edge.target,
      provenance: { kind: "catalog", path: "docs/project-twin/catalog.json" },
      evidenceClass: edge.evidenceClass,
      evidenceIds: [...edge.evidenceIds],
      // Keep the edge self-describing when it is copied out of the graph.
      // The graph-level snapshot is not enough for consumers that inspect a
      // single edge or retain it across a later Twin refresh.
      sourceSnapshot: { kind: "filesystem", hash: snapshotHash },
      sourceRevision: revisionId,
      createdAt: generatedRevisionTimestamp,
      ...(edge.evidenceClass === "inference" ? { confidence: edge.confidence } : {}),
      stale: false,
    };
  });

  return {
    schemaVersion: 1,
    projectId: catalog.projectId,
    revisionId,
    sourceSnapshot: { kind: "filesystem", hash: snapshotHash },
    nodes,
    edges,
    evidence: hydrateEvidence(catalog, hashes),
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileEntry(pathName, kind, contentHash, generated = false, dependsOn = []) {
  return {
    path: pathName,
    contentHash,
    kind,
    generated,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function renderAtlasCss() {
  return `:root {\n  color-scheme: light dark;\n  font-family: "Segoe UI", system-ui, sans-serif;\n  background: #101319;\n  color: #eef2f7;\n  --surface: #171c24;\n  --surface-raised: #202733;\n  --border: #394454;\n  --muted: #aab5c4;\n  --accent: #73b7ff;\n  --warning: #f6c76f;\n  --danger: #ff9a9a;\n}\n\n* { box-sizing: border-box; }\nbody { margin: 0; min-width: 320px; background: #101319; }\nmain { width: min(1400px, 100%); margin: 0 auto; padding: 24px; }\nh1 { margin: 0 0 8px; font-size: clamp(1.5rem, 2.3vw, 2.2rem); }\np { line-height: 1.5; }\n.muted { color: var(--muted); }\n.toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 160px 160px; gap: 12px; margin: 20px 0; }\nlabel { display: grid; gap: 6px; color: var(--muted); font-size: 0.875rem; }\ninput, select, button { min-height: 42px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font: inherit; background: var(--surface); color: inherit; }\nbutton { cursor: pointer; }\nbutton:hover, button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }\n.summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }\n.badge { border: 1px solid var(--border); border-radius: 999px; padding: 6px 10px; background: var(--surface); }\n.layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.9fr); gap: 16px; align-items: start; }\n.panel { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); overflow: hidden; }\n.panel h2 { margin: 0; padding: 14px 16px; font-size: 1rem; border-bottom: 1px solid var(--border); }\n.node-list { display: grid; gap: 8px; padding: 12px; max-height: 66vh; overflow: auto; }\n.node { display: grid; gap: 5px; text-align: left; width: 100%; background: var(--surface-raised); }\n.node[data-selected="true"] { border-color: var(--accent); }\n.node-title { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }\n.node-label { font-weight: 650; }\n.node-type { color: var(--muted); font-size: 0.8rem; }\n.status { font-size: 0.78rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.03em; }\n.status-implemented, .status-verified, .status-accepted { color: #8de0a7; }\n.status-partial, .status-preview, .status-planned { color: var(--warning); }\n.status-blocked, .status-deferred { color: var(--danger); }\n.detail { padding: 16px; min-height: 220px; }\n.detail h3 { margin-top: 0; }\n.detail ul { padding-left: 20px; }\na { color: var(--accent); }\ntable { width: 100%; border-collapse: collapse; font-size: 0.9rem; }\nth, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }\nth { color: var(--muted); font-weight: 600; }\n.edge-panel { margin-top: 16px; overflow: auto; }\n@media (max-width: 760px) { .toolbar, .layout { grid-template-columns: 1fr; } main { padding: 16px; } .node-list { max-height: none; } }\n`;
}

function renderAtlasJs() {
  return `(() => {\n  const data = JSON.parse(document.querySelector("#twin-data").textContent);\n  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));\n  const query = document.querySelector("#query");\n  const type = document.querySelector("#type");\n  const status = document.querySelector("#status");\n  const nodeList = document.querySelector("#node-list");\n  const detail = document.querySelector("#detail");\n  const edgeBody = document.querySelector("#edge-body");\n  const count = document.querySelector("#count");\n  let selectedId = data.nodes[0]?.id ?? null;\n\n  const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#039;" }[character]));\n  const sourceLink = (sourceRef) => {\n    const line = sourceRef.startLine === sourceRef.endLine ? sourceRef.startLine : sourceRef.startLine + "-" + sourceRef.endLine;\n    return '<li><a href="../' + encodeURI(sourceRef.path) + '" target="_blank" rel="noreferrer">' + escapeHtml(sourceRef.path) + ':' + line + '</a></li>';\n  };\n\n  function filteredNodes() {\n    const needle = query.value.trim().toLowerCase();\n    return data.nodes.filter((node) => {\n      const matchesQuery = !needle || [node.id, node.label, node.type, node.description].join(" ").toLowerCase().includes(needle);\n      const matchesType = type.value === "all" || node.type === type.value;\n      const matchesStatus = status.value === "all" || node.status === status.value;\n      return matchesQuery && matchesType && matchesStatus;\n    });\n  }\n\n  function renderDetail(node) {\n    if (!node) { detail.innerHTML = '<p class="muted">No node matches the current filters.</p>'; return; }\n    detail.innerHTML = '<h3>' + escapeHtml(node.label) + '</h3>' +\n      '<p><span class="status status-' + escapeHtml(node.status) + '">' + escapeHtml(node.status) + '</span> · <span class="node-type">' + escapeHtml(node.type) + '</span></p>' +\n      '<p>' + escapeHtml(node.description) + '</p>' +\n      '<h4>Source references</h4><ul>' + node.sourceRefs.map(sourceLink).join("") + '</ul>' +\n      '<h4>Evidence IDs</h4><p class="muted">' + escapeHtml(node.evidenceIds.join(", ")) + '</p>';\n  }\n\n  function renderEdges() {\n    edgeBody.innerHTML = data.edges.map((edge) => {\n      const source = nodesById.get(edge.source);\n      const target = nodesById.get(edge.target);\n      return '<tr><td>' + escapeHtml(source?.label ?? edge.source) + '</td><td>' + escapeHtml(edge.type) + '</td><td>' + escapeHtml(target?.label ?? edge.target) + '</td><td>' + escapeHtml(edge.evidenceClass) + '</td><td>' + (edge.stale ? 'stale' : 'current') + '</td></tr>';\n    }).join("");\n  }\n\n  function render() {\n    const nodes = filteredNodes();\n    if (!nodes.some((node) => node.id === selectedId)) selectedId = nodes[0]?.id ?? null;\n    count.textContent = nodes.length + " of " + data.nodes.length + " nodes";\n    nodeList.innerHTML = nodes.map((node) => '<button class="node" data-node-id="' + escapeHtml(node.id) + '" data-selected="' + (node.id === selectedId) + '">' +\n      '<span class="node-title"><span class="node-label">' + escapeHtml(node.label) + '</span><span class="status status-' + escapeHtml(node.status) + '">' + escapeHtml(node.status) + '</span></span>' +\n      '<span class="node-type">' + escapeHtml(node.type) + ' · ' + escapeHtml(node.id) + '</span>' +\n      '<span class="muted">' + escapeHtml(node.description) + '</span></button>').join("");\n    nodeList.querySelectorAll("[data-node-id]").forEach((button) => button.addEventListener("click", () => { selectedId = button.dataset.nodeId; render(); }));\n    renderDetail(nodesById.get(selectedId));\n  }\n\n  const addOptions = (select, values) => values.sort().forEach((value) => { const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option); });\n  addOptions(type, [...new Set(data.nodes.map((node) => node.type))]);\n  addOptions(status, [...new Set(data.nodes.map((node) => node.status))]);\n  [query, type, status].forEach((control) => control.addEventListener("input", render));\n  document.querySelector("#revision").textContent = data.revisionId;\n  document.querySelector("#snapshot").textContent = data.sourceSnapshot.hash;\n  renderEdges();\n  render();\n})();\n`;
}

function renderAtlasHtml(graph) {
  const embeddedGraph = JSON.stringify(graph).replaceAll("<", "\\u003c");
  return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Omnia Project Twin Atlas</title>\n  <link rel="stylesheet" href="./atlas.css">\n</head>\n<body>\n  <main>\n    <header>\n      <p class="muted">Offline Project Twin atlas · no network requests</p>\n      <h1>Omnia current-tree atlas</h1>\n      <p class="muted">Revision <code id="revision">loading</code> · source snapshot <code id="snapshot">loading</code></p>\n    </header>\n    <section class="toolbar" aria-label="Atlas filters">\n      <label>Search nodes<input id="query" type="search" placeholder="project, storage, provider…" autocomplete="off"></label>\n      <label>Type<select id="type"><option value="all">All types</option></select></label>\n      <label>Status<select id="status"><option value="all">All statuses</option></select></label>\n    </section>\n    <p id="count" class="muted" role="status"></p>\n    <section class="layout">\n      <section class="panel" aria-labelledby="nodes-title"><h2 id="nodes-title">Nodes</h2><div id="node-list" class="node-list" role="list"></div></section>\n      <aside class="panel" aria-labelledby="detail-title"><h2 id="detail-title">Selected node</h2><div id="detail" class="detail"></div></aside>\n    </section>\n    <section class="panel edge-panel" aria-labelledby="edges-title"><h2 id="edges-title">Evidence-linked edges</h2><table><thead><tr><th scope="col">Source</th><th scope="col">Relationship</th><th scope="col">Target</th><th scope="col">Evidence class</th><th scope="col">Freshness</th></tr></thead><tbody id="edge-body"></tbody></table></section>\n    <p class="muted">Status labels are evidence boundaries, not promises. Open source links to inspect the exact referenced files and lines.</p>\n  </main>\n  <script id="twin-data" type="application/json">${embeddedGraph}</script>\n  <script src="./atlas.js" defer></script>\n</body>\n</html>\n`;
}

async function buildOutputs() {
  const catalog = await readCatalog();
  const snapshot = await hashWorkspaceFiles();
  const revisionId = `twin-${snapshot.snapshotHash.slice(0, 16)}`;
  const graph = hydrateGraph(
    catalog,
    snapshot.hashes,
    snapshot.lineCounts,
    snapshot.snapshotHash,
    revisionId,
  );
  const atlasCss = renderAtlasCss();
  const atlasJs = renderAtlasJs().replaceAll('href="../', 'href="../../');
  const atlasHtml = renderAtlasHtml(graph);
  const graphText = json(graph);

  const generatedHashes = new Map([
    ["docs/project-twin/graph.json", sha256(graphText)],
    ["docs/project-twin/atlas.html", sha256(atlasHtml)],
    ["docs/project-twin/atlas.css", sha256(atlasCss)],
    ["docs/project-twin/atlas.js", sha256(atlasJs)],
  ]);
  const sourceHash = (pathName) => contentHashFor(pathName, snapshot.hashes);
  const manifest = {
    schemaVersion: 1,
    projectId: catalog.projectId,
    revisionId,
    sourceSnapshot: { kind: "filesystem", hash: snapshot.snapshotHash },
    documents: [
      fileEntry("README.md", "root-readme", sourceHash("README.md")),
      fileEntry("docs/PRODUCT_SPEC.md", "product-spec", sourceHash("docs/PRODUCT_SPEC.md")),
      fileEntry("docs/IMPLEMENTATION_STATUS.md", "implementation-status", sourceHash("docs/IMPLEMENTATION_STATUS.md")),
      fileEntry("docs/project-twin/catalog.json", "twin-catalog", sourceHash("docs/project-twin/catalog.json")),
      fileEntry("docs/project-twin/catalog.schema.json", "twin-catalog-schema", sourceHash("docs/project-twin/catalog.schema.json")),
      fileEntry("docs/project-twin/README.md", "twin-overview", sourceHash("docs/project-twin/README.md")),
      fileEntry("docs/project-twin/graph.schema.json", "twin-graph-schema", sourceHash("docs/project-twin/graph.schema.json")),
      fileEntry("docs/omnia-ultra/project-twin/README.md", "normative-twin-contract", sourceHash("docs/omnia-ultra/project-twin/README.md")),
      fileEntry("docs/omnia-ultra/project-twin/graph-and-atlas.md", "normative-graph-contract", sourceHash("docs/omnia-ultra/project-twin/graph-and-atlas.md")),
      fileEntry("docs/omnia-ultra/project-twin/update-provenance-staleness.md", "normative-staleness-contract", sourceHash("docs/omnia-ultra/project-twin/update-provenance-staleness.md")),
    ],
    graphs: [
      fileEntry("docs/project-twin/graph.json", "canonical-graph", generatedHashes.get("docs/project-twin/graph.json"), true, ["docs/project-twin/catalog.json"]),
    ],
    atlas: [
      fileEntry("docs/project-twin/atlas.html", "atlas-html", generatedHashes.get("docs/project-twin/atlas.html"), true, ["docs/project-twin/graph.json"]),
      fileEntry("docs/project-twin/atlas.css", "atlas-css", generatedHashes.get("docs/project-twin/atlas.css"), true),
      fileEntry("docs/project-twin/atlas.js", "atlas-javascript", generatedHashes.get("docs/project-twin/atlas.js"), true, ["docs/project-twin/graph.json"]),
    ],
    evidence: graph.evidence.map((evidence) => ({
      evidenceId: evidence.id,
      class: evidence.class,
      path: evidence.path,
      contentHash: evidence.contentHash,
      stale: evidence.stale,
    })),
    staleItems: [],
    userOwnedSections: [
      "docs/project-twin/catalog.json",
      "docs/project-twin/catalog.schema.json",
      "docs/project-twin/README.md",
    ],
  };

  return new Map([
    ["docs/project-twin/manifest.json", json(manifest)],
    ["docs/project-twin/graph.json", graphText],
    ["docs/project-twin/atlas.html", atlasHtml],
    ["docs/project-twin/atlas.css", atlasCss],
    ["docs/project-twin/atlas.js", atlasJs],
  ]);
}

const checkOnly = process.argv.includes("--check");
const outputs = await buildOutputs();
await mkdir(twinDirectory, { recursive: true });
const mismatches = [];

for (const [relative, contents] of outputs) {
  const absolute = path.join(workspace, relative);
  let current = null;
  try {
    current = await readFile(absolute, "utf8");
  } catch {
    // A missing output is reported below in check mode and created otherwise.
  }
  if (checkOnly) {
    if (current !== contents) mismatches.push(relative);
  } else if (current !== contents) {
    await writeFile(absolute, contents, "utf8");
  }
}

if (checkOnly && mismatches.length > 0) {
  process.stderr.write(`Project Twin check failed; refresh generated outputs:\n- ${mismatches.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  const manifest = JSON.parse(outputs.get("docs/project-twin/manifest.json"));
  process.stdout.write(`Project Twin ${checkOnly ? "check" : "bootstrap"} OK: ${manifest.revisionId} (${manifest.sourceSnapshot.hash})\n`);
}
