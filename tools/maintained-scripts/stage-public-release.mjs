import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requiredFiles = [
  ".gitattributes", ".gitignore", "AGENTS.md", "README.md",
  "native/Cargo.toml", "native/Cargo.lock",
  "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs",
  "docs/storage-schema.sql", "package.json", "package-lock.json",
  "tools/maintained-scripts/stage-public-release.mjs",
  ".agents/skills/goal-plan-loop-dod/SKILL.md",
  ".agents/skills/deep-steer/SKILL.md",
];
const requiredDirectories = ["native", "src-tauri/crates", "src", "scripts", "docs", "tests"];
const forbiddenDirectories = new Set([
  ".git", "node_modules", "target", "dist", "backups", "quarantine",
  "repos", "publish-worktree", "localappdata", "roaming", "cursorapp",
  "logs", "downloads", "output", "tmp", ".cache", ".pytest_cache",
]);
const startedAt = new Date().toISOString();
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.resolve(process.env.OMNIA_SOURCE_ROOT || process.env.OMNIA_WORKSPACE_ROOT || scriptRoot);
const destination = path.resolve(process.env.OMNIA_EXPORT_DESTINATION ||
  path.join(process.env.OMNIA_DATA_ROOT || path.join(source, "..", "OmniaData"),
    "exports", `omnia-${startedAt.replace(/[:.]/g, "-")}`));

function git(args) {
  const result = spawnSync("git", ["-C", source, ...args], {
    encoding: null, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString("utf8").trim()}`);
  return result.stdout;
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertNoLinks(target) {
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Reparse/symlink boundary: ${cursor}`);
      if (!stat.isDirectory()) throw new Error(`Directory expected: ${cursor}`);
      if (fs.realpathSync.native(cursor).toLowerCase() !== path.resolve(cursor).toLowerCase()) {
        throw new Error(`Resolved path differs from requested path: ${cursor}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(cursor) === cursor) break;
  }
}

function validateName(name) {
  if (!name || name.includes("\\") || name.includes("\ufffd") || name.includes("\0")) {
    throw new Error(`Unsupported tracked path: ${JSON.stringify(name)}`);
  }
  const parts = name.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/u.test(part) ||
        /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      throw new Error(`Unsafe cross-platform tracked path: ${JSON.stringify(name)}`);
    }
    if (forbiddenDirectories.has(part.toLowerCase()) || /^target-/iu.test(part)) {
      throw new Error(`Generated/private directory is tracked: ${name}`);
    }
  }
  const basename = parts.at(-1).toLowerCase();
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    throw new Error(`Private environment file is tracked: ${name}`);
  }
}

function readTree(commit) {
  const raw = git(["ls-tree", "-rz", "--full-tree", commit]);
  const entries = [];
  const folded = new Set();
  for (const record of raw.toString("utf8").split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Malformed Git tree record.");
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const name = record.slice(separator + 1);
    validateName(name);
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`Unsupported symlink/submodule/tree entry: ${name} (${mode} ${type})`);
    }
    const foldedName = name.toLowerCase();
    if (folded.has(foldedName)) throw new Error(`Case-colliding tracked path: ${name}`);
    folded.add(foldedName);
    entries.push({ path: name, mode, oid });
  }
  const names = new Set(entries.map((entry) => entry.path));
  for (const name of requiredFiles) {
    if (!names.has(name)) throw new Error(`Required committed input missing: ${name}`);
  }
  for (const name of requiredDirectories) {
    if (!entries.some((entry) => entry.path.startsWith(`${name}/`))) {
      throw new Error(`Required committed directory missing: ${name}`);
    }
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (folded.has(parts.slice(0, i).join("/").toLowerCase())) {
        throw new Error(`File/directory collision: ${entry.path}`);
      }
    }
  }
  return entries;
}

async function fileHash(target) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function materialize(entries, objectFormat) {
  const child = spawn("git", ["-C", source, "cat-file", "--batch"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let failure;
  let stderr = "";
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", (error) => { failure = error; });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
  child.stdin.end(entries.map((entry) => entry.oid).join("\n") + "\n");
  let buffer = Buffer.alloc(0);
  let cursor = 0;
  let active;
  const output = [];
  try {
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (!active) {
          const newline = buffer.indexOf(10);
          if (newline < 0) {
            if (buffer.length > 200) throw new Error("Oversized Git object header.");
            break;
          }
          const header = buffer.subarray(0, newline).toString("ascii");
          buffer = buffer.subarray(newline + 1);
          const match = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(header);
          const entry = entries[cursor];
          if (!entry || !match || match[1] !== entry.oid) throw new Error(`Invalid Git object header: ${header}`);
          const bytes = Number(match[2]);
          if (!Number.isSafeInteger(bytes)) throw new Error(`Unsupported blob size: ${entry.path}`);
          const target = path.join(destination, ...entry.path.split("/"));
          if (!within(destination, target)) throw new Error(`Escaping export path: ${entry.path}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          assertNoLinks(path.dirname(target));
          active = {
            entry, bytes, remaining: bytes, target,
            fd: fs.openSync(target, "wx"),
            sha256: crypto.createHash("sha256"),
            object: crypto.createHash(objectFormat).update(`blob ${bytes}\0`),
          };
        }
        if (active.remaining) {
          const amount = Math.min(buffer.length, active.remaining);
          const piece = buffer.subarray(0, amount);
          let written = 0;
          while (written < piece.length) written += fs.writeSync(active.fd, piece, written, piece.length - written);
          active.sha256.update(piece);
          active.object.update(piece);
          active.remaining -= amount;
          buffer = buffer.subarray(amount);
          if (active.remaining) break;
        }
        if (!buffer.length) break;
        if (buffer[0] !== 10) throw new Error("Missing Git blob terminator.");
        buffer = buffer.subarray(1);
        fs.closeSync(active.fd);
        active.fd = null;
        if (active.object.digest("hex") !== active.entry.oid) throw new Error(`Blob identity mismatch: ${active.entry.path}`);
        const savedHash = await fileHash(active.target);
        if (savedHash !== active.sha256.digest("hex")) throw new Error(`Export readback mismatch: ${active.entry.path}`);
        if (process.platform !== "win32" && active.entry.mode === "100755") fs.chmodSync(active.target, 0o755);
        output.push({ ...active.entry, bytes: active.bytes, sha256: savedHash });
        active = undefined;
        cursor += 1;
      }
    }
    const result = await exited;
    if (failure) throw failure;
    if (result.code !== 0) throw new Error(`git cat-file failed (${result.code}): ${stderr}`);
    if (active || buffer.length || cursor !== entries.length) throw new Error("Incomplete Git object stream.");
    return output;
  } catch (error) {
    if (active?.fd != null) fs.closeSync(active.fd);
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
}

async function main() {
  if (within(source, destination) || within(destination, source)) {
    throw new Error("Export destination must be external to, and must not contain, the source.");
  }
  assertNoLinks(source);
  assertNoLinks(path.dirname(destination));
  const gitRoot = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (fs.realpathSync.native(gitRoot).toLowerCase() !== fs.realpathSync.native(source).toLowerCase()) {
    throw new Error("OMNIA_SOURCE_ROOT must be the actual repository root.");
  }
  const revision = process.env.OMNIA_EXPORT_REVISION || "HEAD";
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).toString("ascii").trim();
  const tree = git(["rev-parse", `${commit}^{tree}`]).toString("ascii").trim();
  const objectFormat = git(["rev-parse", "--show-object-format"]).toString("ascii").trim();
  if (!["sha1", "sha256"].includes(objectFormat)) throw new Error(`Unsupported Git object format: ${objectFormat}`);
  const entries = readTree(commit);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoLinks(path.dirname(destination));
  fs.mkdirSync(destination);
  const receiptPath = `${destination}.receipt.json`;
  const receipt = {
    schema: "omnia.committed-source-export.v1", startedAt, source, destination,
    commit, tree, objectFormat, state: "IN_PROGRESS",
    workingTreeIncluded: false, privacyReview: "REQUIRED", publication: "NOT_PERFORMED",
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  try {
    receipt.files = await materialize(entries, objectFormat);
    receipt.fileCount = receipt.files.length;
    receipt.bytes = receipt.files.reduce((total, entry) => total + entry.bytes, 0);
    receipt.state = "EXPORTED";
  } catch (error) {
    receipt.state = "FAILED_RETAINED_FOR_INSPECTION";
    receipt.error = error.message;
    throw error;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  }
  console.log(JSON.stringify({
    state: receipt.state, destination, receipt: receiptPath, commit, tree,
    files: receipt.fileCount, bytes: receipt.bytes,
    note: "Committed bytes only; privacy/license review and builds remain required before publication.",
  }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
