import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./stage-public-release.mjs", import.meta.url));
const baseFiles = [
  ".gitattributes", ".gitignore", "AGENTS.md", "README.md",
  "CMakeLists.txt", "CMakePresets.json",
  "cpp/CMakeLists.txt", "cpp/src/main.cpp",
  "native/CMakeLists.txt", "native/src/main.cpp",
  "ui/index.html", "ui/app/main.js",
  "docs/storage-schema.sql", "docs/workspace/DECISIONS.md",
  "tools/maintained-scripts/stage-public-release.mjs",
  ".agents/skills/goal-plan-loop-dod/SKILL.md",
  ".agents/skills/deep-steer/SKILL.md",
  ".agents/skills/deep-cpp-native/SKILL.md",
];

function git(root, args, check = true) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (check) assert.equal(result.status, 0, result.stderr);
  return result;
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omnia-export-test-"));
  t.after(() => {
    const resolved = fs.realpathSync.native(base);
    const tempRoot = fs.realpathSync.native(os.tmpdir());
    const relative = path.relative(tempRoot, resolved);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
    assert.ok(path.basename(resolved).startsWith("omnia-export-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const source = path.join(base, "source");
  fs.mkdirSync(source);
  git(source, ["init", "-q"]);
  git(source, ["config", "user.name", "Export fixture"]);
  git(source, ["config", "user.email", "fixture@example.invalid"]);
  git(source, ["config", "core.autocrlf", "false"]);
  for (const name of baseFiles) {
    const target = path.join(source, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, name === ".gitattributes" ? "* -text\n" : `fixture ${name}\n`);
  }
  const destination = path.join(base, "exports", "candidate");
  return { base, source, destination };
}

function commit(source) {
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "fixture"]);
  return git(source, ["rev-parse", "HEAD"]).stdout.trim();
}

function run(f, extra = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: {
      ...process.env, OMNIA_SOURCE_ROOT: f.source,
      OMNIA_EXPORT_DESTINATION: f.destination, OMNIA_EXPORT_REVISION: "HEAD", ...extra,
    },
  });
}

test("exports committed native, skills, tooling and binary/Unicode paths", (t) => {
  const f = fixture(t);
  const special = path.join(f.source, "docs", "Tiếng Việt and spaces.bin");
  const binary = Buffer.from([0, 10, 13, 255, 128, 65]);
  fs.writeFileSync(special, binary);
  fs.appendFileSync(path.join(f.source, ".gitattributes"), "native export-ignore\n");
  const head = commit(f.source);
  fs.writeFileSync(path.join(f.source, "README.md"), "uncommitted working text\n");
  fs.writeFileSync(path.join(f.source, "not-committed.txt"), "not admitted\n");
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(`${f.destination}.receipt.json`, "utf8"));
  assert.equal(receipt.commit, head);
  assert.equal(receipt.fileCount, baseFiles.length + 1);
  assert.equal(receipt.state, "EXPORTED");
  assert.equal(receipt.workingTreeIncluded, false);
  assert.equal(fs.readFileSync(path.join(f.destination, "README.md"), "utf8"), "fixture README.md\n");
  assert.deepEqual(fs.readFileSync(path.join(f.destination, "docs", path.basename(special))), binary);
  assert.equal(fs.existsSync(path.join(f.destination, "native", "CMakeLists.txt")), true);
  assert.equal(fs.existsSync(path.join(f.destination, "cpp", "CMakeLists.txt")), true);
  assert.equal(fs.existsSync(path.join(f.destination, "ui", "index.html")), true);
  assert.equal(fs.existsSync(path.join(f.destination, ".agents", "skills", "deep-cpp-native", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(f.destination, ".git")), false);
  assert.equal(fs.existsSync(path.join(f.destination, "not-committed.txt")), false);
  assert.equal(fs.existsSync(path.join(f.destination, ".agents", "skills", "deep-steer", "SKILL.md")), true);
});

test("refuses missing committed required inputs before output", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.source, "docs", "storage-schema.sql"));
  commit(f.source);
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required committed input missing: docs\/storage-schema.sql/u);
  assert.equal(fs.existsSync(f.destination), false);
});

test("refuses existing export without replacing contents", (t) => {
  const f = fixture(t);
  commit(f.source);
  fs.mkdirSync(f.destination, { recursive: true });
  fs.writeFileSync(path.join(f.destination, "owner.txt"), "preserve\n");
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(f.destination, "owner.txt"), "utf8"), "preserve\n");
  assert.equal(fs.existsSync(path.join(f.destination, "native")), false);
});

test("refuses destinations inside or containing source", (t) => {
  const f = fixture(t);
  commit(f.source);
  for (const destination of [f.source, path.join(f.source, "artifacts"), f.base]) {
    const result = run(f, { OMNIA_EXPORT_DESTINATION: destination });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be external/u);
  }
});

test("refuses tracked private environment files", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, ".env"), "fixture_only=no_secret\n");
  commit(f.source);
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Private environment file is tracked/u);
  assert.equal(fs.existsSync(f.destination), false);
});

test("refuses generated paths regardless of Windows case", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, "TARGET"));
  fs.writeFileSync(path.join(f.source, "TARGET", "generated.txt"), "not source\n");
  commit(f.source);
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Generated\/private directory is tracked/u);
  assert.equal(fs.existsSync(f.destination), false);
});

test("refuses Git symlink entries without following", (t) => {
  const f = fixture(t);
  commit(f.source);
  const blob = spawnSync("git", ["-C", f.source, "hash-object", "-w", "--stdin"], {
    encoding: "utf8", input: "../outside\n", windowsHide: true,
  });
  assert.equal(blob.status, 0, blob.stderr);
  git(f.source, ["update-index", "--add", "--cacheinfo", `120000,${blob.stdout.trim()},link`]);
  git(f.source, ["commit", "-qm", "symlink entry"]);
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported symlink\/submodule/u);
  assert.equal(fs.existsSync(f.destination), false);
});

test("refuses a reparse destination parent", (t) => {
  const f = fixture(t);
  commit(f.source);
  const owned = path.join(f.base, "owned");
  const alias = path.join(f.base, "alias");
  fs.mkdirSync(owned);
  fs.symlinkSync(owned, alias, process.platform === "win32" ? "junction" : "dir");
  const result = run(f, { OMNIA_EXPORT_DESTINATION: path.join(alias, "candidate") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reparse\/symlink boundary/u);
  assert.equal(fs.existsSync(path.join(owned, "candidate")), false);
});

test("refuses retired Rust and Cargo files before creating output", (t) => {
  for (const retired of ["native/src/legacy.rs", "native/Cargo.toml", "Cargo.lock"]) {
    const f = fixture(t);
    const target = path.join(f.source, ...retired.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// retired\n");
    commit(f.source);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Retired Rust\/Cargo file is tracked/u);
    assert.equal(fs.existsSync(f.destination), false);
  }
});

test("exports live repository HEAD cleanly into external temp directory", (t) => {
  const liveRoot = path.resolve(path.dirname(script), "../..");
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "omnia-live-export-test-"));
  const destination = path.join(tempBase, "candidate");
  t.after(() => {
    const resolved = fs.realpathSync.native(tempBase);
    const tempRoot = fs.realpathSync.native(os.tmpdir());
    const relative = path.relative(tempRoot, resolved);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
    assert.ok(path.basename(resolved).startsWith("omnia-live-export-test-"));
    fs.rmSync(`${destination}.receipt.json`, { force: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const expectedHead = git(liveRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: {
      ...process.env,
      OMNIA_SOURCE_ROOT: liveRoot,
      OMNIA_EXPORT_DESTINATION: destination,
      OMNIA_EXPORT_REVISION: "HEAD",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(`${destination}.receipt.json`, "utf8"));
  assert.equal(receipt.state, "EXPORTED");
  assert.equal(receipt.commit, expectedHead);
  assert.ok(receipt.fileCount >= 160);
  assert.equal(fs.existsSync(path.join(destination, "CMakeLists.txt")), true);
  assert.equal(fs.existsSync(path.join(destination, "cpp", "CMakeLists.txt")), true);
  assert.equal(fs.existsSync(path.join(destination, "native", "CMakeLists.txt")), true);
  assert.equal(fs.existsSync(path.join(destination, "ui", "index.html")), true);
});
