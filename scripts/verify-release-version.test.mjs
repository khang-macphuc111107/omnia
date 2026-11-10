import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const verifierPath = fileURLToPath(new URL("./verify-release-version.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "omnia-release-version-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^omnia-release-version-/);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, "src-tauri"));
  writeFileSync(path.join(root, "package.json"), '{"version":"0.1.0"}\n');
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), '{"version":"0.1.0"}\n');
  writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), '[package]\nname = "omnia-desktop"\nversion = "0.1.0"\n');
  return root;
}

function runVerifier(root, args = [], environment = {}) {
  const env = { ...process.env, ...environment };
  if (!("RELEASE_TAG" in environment)) delete env.RELEASE_TAG;
  return spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("release workflow accepts a rebuild milestone only after matching its manifest base", {
  skip: process.platform !== "win32" && "Release workflow uses PowerShell on Windows",
}, (t) => {
  const root = fixture(t);
  const workflow = readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  const gate = workflow.split(/^      - name: Verify tag and package versions agree\r?$/m)[1]?.split(/^      - name:/m)[0];
  assert.ok(gate, "Release workflow must keep its version gate");
  const runMatch = gate.match(/^        run: \|\r?\n([\s\S]*)/m);
  assert.ok(runMatch, "Release version step must provide an executable run block");
  const source = runMatch[1].replace(/^          /gm, "")
    .replaceAll("${{ github.event_name }}", "workflow_dispatch")
    .replaceAll("${{ inputs.tag }}", "v0.1.0-rebuild-0010")
    .replaceAll("${{ github.ref_name }}", "v0.1.0-rebuild-0010");
  if (existsSync(verifierPath)) {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(verifierPath, path.join(root, "scripts", "verify-release-version.mjs"));
  }
  mkdirSync(path.join(root, "artifacts", "ci", "release", "validate"), { recursive: true });
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'\n${source}`], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: "v0.1.0-rebuild-0010" },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stdout, /Release version verified: v0\.1\.0-rebuild-0010/);
});

for (const tag of ["v0.1.0", "v0.1.0-rebuild-0000", "v0.1.0-rebuild-0010", "v0.1.0-rebuild-9999"]) {
  test(`accepts ${tag} when all manifest versions match`, (t) => {
    const result = runVerifier(fixture(t), [tag]);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /Release version verified:/);
    assert.ok(result.stdout.includes(tag));
    assert.equal(result.stderr, "");
  });
}

test("accepts a stable multi-digit semantic version without normalizing it", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "package.json"), '{"version":"12.34.567"}\n');
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), '{"version":"12.34.567"}\n');
  writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), '[package]\nversion = "12.34.567"\n');
  const result = runVerifier(root, ["v12.34.567"]);
  assert.equal(result.status, 0, result.stderr);
});

for (const tag of [
  "0.1.0", "V0.1.0", "v0.1", "v0.1.0.0", "v00.1.0", "v0.01.0", "v0.1.00",
  "v0.1.0-rc.1", "v0.1.0-beta", "v0.1.0+build.10", "v0.1.0-rebuild", "v0.1.0-rebuild-",
  "v0.1.0-rebuild-10", "v0.1.0-rebuild-00100", "v0.1.0-rebuild-abcd", "v0.1.0-Rebuild-0010",
  "v0.1.0-rebuild-0010-extra", "v0.1.0-rebuild-0010+meta", " v0.1.0", "v0.1.0 ",
  "v0.1.0\n", "v0.1.0-rebuild-0010\r\n", "v0.1.0/other", "v0.1.0';exit 0;#", "",
]) {
  test(`rejects unsupported or malformed tag ${JSON.stringify(tag)}`, (t) => {
    const result = runVerifier(fixture(t), [tag]);
    assert.equal(result.status, 1, result.stderr || String(result.error));
    assert.match(result.stderr, /Release tag must use/);
    assert.doesNotMatch(result.stdout, /Release version verified:/);
  });
}

for (const tag of ["v0.1.0", "v0.1.0-rebuild-0010"]) {
  for (const [manifest, content] of [
    ["package.json", '{"version":"0.2.0"}\n'],
    ["src-tauri/tauri.conf.json", '{"version":"0.2.0"}\n'],
    ["src-tauri/Cargo.toml", '[package]\nversion = "0.2.0"\n'],
  ]) {
    test(`rejects ${tag} when ${manifest} has a different base version`, (t) => {
      const root = fixture(t);
      writeFileSync(path.join(root, manifest), content);
      const result = runVerifier(root, [tag]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /does not match manifest versions/);
      assert.match(result.stderr, /package=/);
      assert.match(result.stderr, /tauri=/);
      assert.match(result.stderr, /cargo=/);
      assert.doesNotMatch(result.stdout, /Release version verified:/);
    });
  }
}

test("does not strip a prerelease suffix from manifest versions", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "package.json"), '{"version":"0.1.0-rebuild-0010"}\n');
  const result = runVerifier(root, ["v0.1.0-rebuild-0010"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not match manifest versions/);
});

test("rejects an unrelated stable or rebuild base even when all manifests agree", (t) => {
  const root = fixture(t);
  for (const tag of ["v0.2.0", "v0.2.0-rebuild-0010"]) {
    const result = runVerifier(root, [tag]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /does not match manifest versions/);
  }
});

for (const manifest of ["package.json", "src-tauri/tauri.conf.json"]) {
  for (const content of ["{not json}", "{}", '{"version":1}', '[]']) {
    test(`rejects invalid or missing version in ${manifest}: ${content}`, (t) => {
      const root = fixture(t);
      writeFileSync(path.join(root, manifest), content);
      const result = runVerifier(root, ["v0.1.0"]);
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(manifest), result.stderr);
      assert.doesNotMatch(result.stdout, /Release version verified:/);
    });
  }
}

test("reads Cargo's package version rather than an earlier dependency or workspace version", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), [
    "[workspace.package]", 'version = "99.0.0"', "[dependencies.example]", 'version = "88.0.0"',
    "[package]", 'name = "omnia-desktop"', 'version = "0.1.0"', "[dependencies]", 'example = "77"', "",
  ].join("\n"));
  const result = runVerifier(root, ["v0.1.0-rebuild-0010"]);
  assert.equal(result.status, 0, result.stderr);
});

test("supports literal Cargo version strings, comments, CRLF and UTF-8 BOM manifests", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "package.json"), '\ufeff{"version":"0.1.0"}\r\n');
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), '\ufeff{"version":"0.1.0"}\r\n');
  writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), "\ufeff[package] # application\r\nversion = '0.1.0' # release base\r\n");
  const result = runVerifier(root, ["v0.1.0"]);
  assert.equal(result.status, 0, result.stderr);
});

for (const content of [
  '[workspace.package]\nversion = "0.1.0"\n',
  '[package]\nversion.workspace = true\n',
  '[package]\nversion = "0.1.0"\nversion = "0.1.0"\n',
  '[package]\nversion = "0.1.0"\n[package]\nversion = "0.1.0"\n',
]) {
  test(`rejects Cargo without one explicit package version: ${JSON.stringify(content)}`, (t) => {
    const root = fixture(t);
    writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), content);
    const result = runVerifier(root, ["v0.1.0"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /src-tauri\/Cargo\.toml/);
    assert.doesNotMatch(result.stdout, /Release version verified:/);
  });
}

test("fails when a required manifest cannot be read", (t) => {
  const root = fixture(t);
  rmSync(path.join(root, "src-tauri", "tauri.conf.json"));
  const result = runVerifier(root, ["v0.1.0"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /src-tauri\/tauri\.conf\.json/);
});

test("reads a workflow tag from RELEASE_TAG without interpolating shell code", (t) => {
  const result = runVerifier(fixture(t), [], { RELEASE_TAG: "v0.1.0-rebuild-0010" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /v0\.1\.0-rebuild-0010/);
});

test("a malformed explicit tag cannot fall back to a valid environment tag", (t) => {
  const result = runVerifier(fixture(t), [""], { RELEASE_TAG: "v0.1.0" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Release tag must use/);
});

test("rejects a missing release tag", (t) => {
  const result = runVerifier(fixture(t));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Release tag must use/);
});

test("rejects extra CLI arguments", (t) => {
  const result = runVerifier(fixture(t), ["v0.1.0", "ignored"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Usage:/);
});
