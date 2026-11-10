import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyWindowsBundles } from "./verify-windows-bundles.mjs";

const revision = "a".repeat(40);
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnia-bundle-test-"));
  await mkdir(path.join(dir, "msi"));
  await mkdir(path.join(dir, "nsis"));
  return dir;
}
async function populate(dir) {
  await writeFile(path.join(dir, "msi", "omnia.msi"), "MSI fixture");
  await writeFile(path.join(dir, "nsis", "omnia-setup.exe"), "NSIS fixture");
}

test("both installer formats produce deterministic checksums bound to an immutable revision", async () => {
  const dir = await fixture();
  await populate(dir);
  const report = await verifyWindowsBundles({ dir, revision });
  assert.equal(report.result, "passed");
  assert.equal(report.files.length, 2);
  assert.equal(report.revision, revision);
  for (const file of report.files) {
    assert.ok(file.bytes > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/u);
  }
  const original = await readFile(path.join(dir, "SHA256SUMS.txt"), "utf8");
  await verifyWindowsBundles({ dir, revision });
  assert.equal(await readFile(path.join(dir, "SHA256SUMS.txt"), "utf8"), original);
  assert.equal(JSON.parse(await readFile(path.join(dir, "bundle-manifest.json"), "utf8")).revision, revision);
});

for (const mode of ["arbitrary-only", "missing-msi", "missing-nsis", "empty-msi", "empty-nsis"]) {
  test(`rejects ${mode} payloads instead of publishing a checksum-only success`, async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "unrelated.txt"), "not an installer");
    if (mode !== "arbitrary-only") {
      if (mode !== "missing-msi") await writeFile(path.join(dir, "msi", "omnia.msi"), mode === "empty-msi" ? "" : "MSI");
      if (mode !== "missing-nsis") await writeFile(path.join(dir, "nsis", "omnia.exe"), mode === "empty-nsis" ? "" : "NSIS");
    }
    await assert.rejects(verifyWindowsBundles({ dir, revision }), /Missing required|nonempty/);
  });
}

test("a directory with an installer suffix cannot satisfy the payload gate", async () => {
  const dir = await fixture();
  await mkdir(path.join(dir, "msi", "not-a-file.msi"));
  await writeFile(path.join(dir, "nsis", "omnia.exe"), "NSIS");
  await assert.rejects(verifyWindowsBundles({ dir, revision }), /nonempty regular file/);
});

test("a junction to an outside directory cannot satisfy the payload gate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omnia-bundle-junction-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "omnia-bundle-outside-"));
  await writeFile(path.join(outside, "outside.msi"), "outside");
  await symlink(outside, path.join(dir, "msi"), process.platform === "win32" ? "junction" : "dir");
  await mkdir(path.join(dir, "nsis"));
  await assert.rejects(verifyWindowsBundles({ dir, revision }), /real directory|escapes/);
});

for (const invalid of [undefined, "main", "b".repeat(7), "G".repeat(40)]) {
  test(`rejects mutable or malformed revision ${invalid}`, async () => {
    await assert.rejects(verifyWindowsBundles({ dir: ".", revision: invalid }), /immutable/);
  });
}
