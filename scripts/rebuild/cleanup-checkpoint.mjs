#!/usr/bin/env node
/**
 * Safe cleanup checkpoint: inventory only. It never deletes or moves files.
 * Destructive cleanup requires an explicit, reviewed quarantine manifest.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(process.env.OMNIA_CLEAN_ROOT ?? "D:/Omnia");
const output = path.resolve(process.env.OMNIA_CLEAN_RECEIPT ?? "docs/rebuild/receipts/cleanup-checkpoint.json");
const rootResolved = path.parse(root).root === root ? root : root;
const scratch = /\.(tmp|log)$/i;
const obvious = /^(test_|\.tmp-)/i;

async function hash(file) {
  const bytes = await fs.readFile(file);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const entries = [];
for (const entry of await fs.readdir(rootResolved, { withFileTypes: true })) {
  const full = path.join(rootResolved, entry.name);
  if (!entry.isFile()) {
    entries.push({ path: entry.name, kind: "directory-or-unknown", action: "retain-unclassified" });
    continue;
  }
  const meta = await hash(full);
  const candidate = scratch.test(entry.name) || obvious.test(entry.name);
  entries.push({ path: entry.name, kind: candidate ? "obvious-scratch-candidate" : "root-file",
    action: candidate ? "quarantine-only-after-review" : "retain", ...meta });
}
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify({
  schemaVersion: 1, recordedAt: new Date().toISOString(), root: rootResolved,
  destructiveAction: "none", entries,
  limits: ["top-level inventory only", "directories were not recursively classified",
    "unknown/user/source files are retained", "manual reviewed manifest required for moves"],
}, null, 2)}\n`);
console.log(JSON.stringify({ result: "passed", root: rootResolved, entries: entries.length, output }));
