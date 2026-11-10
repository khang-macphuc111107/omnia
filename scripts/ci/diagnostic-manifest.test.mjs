import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDiagnosticManifest } from "./write-diagnostic-manifest.mjs";

test("diagnostic manifest records current files and hashes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "omnia-ci-manifest-"));
  await mkdir(path.join(cwd, "artifacts"), { recursive: true });
  await writeFile(path.join(cwd, "artifacts", "check.txt"), "pass\n");
  const result = await writeDiagnosticManifest({
    cwd,
    job: "renderer",
    dir: "artifacts",
    expected: ["check.txt"],
    now: new Date("2026-11-09T00:00:00.000Z"),
  });
  assert.equal(result.result, "complete");
  assert.equal(result.presentCount, 1);
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/u);
  const saved = JSON.parse(await readFile(path.join(cwd, "artifacts", "manifest.json"), "utf8"));
  assert.deepEqual(saved, result);
});

test("missing diagnostic output remains visible without masking the original failure", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "omnia-ci-manifest-"));
  await mkdir(path.join(cwd, "artifacts"), { recursive: true });
  const result = await writeDiagnosticManifest({
    cwd,
    job: "native",
    dir: "artifacts",
    expected: ["fmt.txt", "tests.txt"],
  });
  assert.equal(result.result, "missing-files");
  assert.deepEqual(result.missing, ["artifacts/fmt.txt", "artifacts/tests.txt"]);
});

test("manifest rejects paths that could escape its diagnostic directory", async () => {
  await assert.rejects(
    () => writeDiagnosticManifest({
      cwd: process.cwd(),
      job: "renderer",
      dir: "artifacts/ci",
      expected: ["../secrets.txt"],
    }),
    /stay inside/u,
  );
});

test("manifest records resolved runner and Node versions without copying credentials", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "omnia-ci-environment-"));
  await mkdir(path.join(cwd, "artifacts"), { recursive: true });
  const variables = {
    ImageOS: "win25",
    ImageVersion: "20261108.1.0",
    RUNNER_OS: "Windows",
    RUNNER_ARCH: "X64",
    GITHUB_TOKEN: "never-export-this-test-token",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, variables);
    const result = await writeDiagnosticManifest({ cwd, job: "renderer", dir: "artifacts" });
    assert.deepEqual(result.runtime, {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
    assert.equal(result.environment.ImageVersion, "20261108.1.0");
    assert.equal(result.environment.ImageOS, "win25");
    assert.equal(result.environment.RUNNER_OS, "Windows");
    assert.equal(result.environment.RUNNER_ARCH, "X64");
    assert.ok(!JSON.stringify(result).includes("never-export-this-test-token"));
    assert.ok(!Object.hasOwn(result.environment, "GITHUB_TOKEN"));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
