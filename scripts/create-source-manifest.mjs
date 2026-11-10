import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.cwd();
const outputRelative = "docs/releases/omnia-0.1.0-phase1-preview-source.sha256";
const excludedDirectories = new Set([
  ".git",
  ".vite",
  ".cargo-target-test",
  ".cargo-target-verify",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const excludedPrefixes = ["artifacts/", "src-tauri/target/"];

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

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === outputRelative || excludedPrefixes.some((value) => relative.startsWith(value))) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Source manifest does not permit symlinks: ${relative}`);
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push(relative.replaceAll("\\", "/"));
    }
  }
  return files;
}

const files = await collectFiles(workspace);
const lines = [];
for (const relative of files) {
  const bytes = await readFile(path.join(workspace, relative));
  const digest = createHash("sha256").update(bytes).digest("hex");
  lines.push(`${digest}  ${relative}`);
}

const outputPath = path.join(workspace, outputRelative);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
const manifestHash = createHash("sha256").update(lines.join("\n") + "\n").digest("hex");
process.stdout.write(`${manifestHash}  ${outputRelative}\n`);
