import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { selectRelease, verifyArchive, downloadArchive } from "./lint-workflows.mjs";

test("workflow linter pins version and digest for both CI platforms", () => {
  for (const platform of ["win32", "linux"]) {
    const release = selectRelease(platform, "x64");
    assert.equal(release.version, "1.7.12");
    assert.match(release.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(release.url.startsWith("https://github.com/rhysd/actionlint/releases/download/v1.7.12/"));
  }
  assert.throws(() => selectRelease("unsupported", "x64"), /Unsupported/u);
});

test("workflow linter rejects modified archive bytes before extraction", () => {
  const bytes = Buffer.from("verified release");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifyArchive(bytes, { sha256 }), sha256);
  assert.throws(() => verifyArchive(Buffer.from("tampered"), { sha256 }), /checksum mismatch/u);
});

test("workflow linter fails on download HTTP errors", async () => {
  const release = selectRelease("linux", "x64");
  await assert.rejects(
    () => downloadArchive(release, { fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/u,
  );
});

test("workflow linter does not accept an unverified download", async () => {
  const release = selectRelease("linux", "x64");
  await assert.rejects(
    () => downloadArchive(release, {
      fetchImpl: async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => Buffer.from("wrong") }),
    }),
    /checksum mismatch/u,
  );
});
