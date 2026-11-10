import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputFiles = ["src/styles/tokens.generated.css", "src/design-system/tokens.generated.ts"];

async function createFixture(t) {
  const prefix = path.join(tmpdir(), "omnia-token-check-");
  const root = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(path.isAbsolute(root) && root.startsWith(prefix), "cleanup must stay inside the test fixture");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "docs/ui"), { recursive: true });
  for (const file of ["scripts/generate-design-tokens.mjs", "docs/ui/design-tokens.json"]) {
    await copyFile(path.join(repositoryRoot, file), path.join(root, file));
  }
  const scriptPath = path.join(root, "scripts/generate-design-tokens.mjs");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  };
  const generated = run();
  assert.equal(generated.status, 0, generated.stderr);
  const readOutputs = () => Promise.all(outputFiles.map((file) => readFile(path.join(root, file))));
  return { root, run, readOutputs };
}

const endings = [
  { name: "LF", formats: ["lf", "lf"] },
  { name: "CRLF CSS and LF TypeScript", formats: ["crlf", "lf"] },
  { name: "LF CSS and CRLF TypeScript", formats: ["lf", "crlf"] },
  { name: "CRLF", formats: ["crlf", "crlf"] },
  { name: "mixed LF and CRLF", formats: ["mixed", "mixed"] },
];

for (const { name, formats } of endings) {
  test(`check mode accepts ${name} outputs without rewriting either file`, async (t) => {
    const fixture = await createFixture(t);
    for (const [index, file] of outputFiles.entries()) {
      const outputPath = path.join(fixture.root, file);
      const text = (await readFile(outputPath, "utf8")).replace(/\r\n/g, "\n");
      let newline = 0;
      const formatted = text.replace(/\n/g, () => {
        newline += 1;
        return formats[index] === "crlf" || (formats[index] === "mixed" && newline % 2 === 0) ? "\r\n" : "\n";
      });
      await writeFile(outputPath, formatted, "utf8");
    }
    const before = await fixture.readOutputs();
    const checked = fixture.run("--check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Design token outputs match/);
    assert.deepEqual(await fixture.readOutputs(), before, "check mode must preserve the existing bytes");
  });
}

for (const file of outputFiles) {
  const label = file.endsWith(".css") ? "CSS" : "TypeScript";
  const changes = [
    {
      name: "a changed generated value with CRLF line endings",
      mutate: (text) => (label === "CSS"
        ? text.replace("--font-small: var(--font-micro);", "--font-small: var(--font-title);")
        : text.replace("BREAKPOINTS.compact", "BREAKPOINTS.wide")).replace(/\n/g, "\r\n"),
    },
    { name: "added trailing whitespace", mutate: (text) => `${text} ` },
    { name: "a standalone carriage return", mutate: (text) => text.replace("\n", "\r") },
    { name: "a missing final newline", mutate: (text) => text.slice(0, -1) },
  ];

  for (const { name, mutate } of changes) {
    test(`check mode rejects ${name} in ${label} without repairing the drift`, async (t) => {
      const fixture = await createFixture(t);
      const outputPath = path.join(fixture.root, file);
      const original = (await readFile(outputPath, "utf8")).replace(/\r\n/g, "\n");
      const changed = mutate(original);
      assert.notEqual(changed, original, "the fixture must introduce a real difference");
      await writeFile(outputPath, changed, "utf8");
      const before = await fixture.readOutputs();
      const checked = fixture.run("--check");
      assert.equal(checked.status, 1, checked.stderr);
      assert.ok(checked.stderr.includes(path.basename(file)), checked.stderr);
      assert.match(checked.stderr, /has drifted/);
      assert.doesNotMatch(checked.stdout, /Design token outputs match/);
      assert.deepEqual(await fixture.readOutputs(), before, "rejected check mode must preserve both files");
    });
  }

  test(`check mode rejects a missing ${label} output without regenerating it`, async (t) => {
    const fixture = await createFixture(t);
    const outputPath = path.join(fixture.root, file);
    const otherFile = outputFiles.find((candidate) => candidate !== file);
    const otherPath = path.join(fixture.root, otherFile);
    const otherBefore = await readFile(otherPath);
    await unlink(outputPath);
    const checked = fixture.run("--check");
    assert.equal(checked.status, 1, checked.stderr);
    assert.ok(checked.stderr.includes(path.basename(file)), checked.stderr);
    assert.match(checked.stderr, /is missing/);
    assert.doesNotMatch(checked.stdout, /Design token outputs match/);
    await assert.rejects(readFile(outputPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(otherPath), otherBefore);
  });
}
