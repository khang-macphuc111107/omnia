import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-bundle-budget.mjs", import.meta.url));
const rebuild = "src/rebuild/rebuild-app.tsx";
const html = '<script type="module" src="/assets/index.js"></script>';

function fixture() {
  return {
    "index.html": {
      file: "assets/index.js", src: "index.html", isEntry: true,
      imports: ["_vendor-react.js"], dynamicImports: [rebuild],
    },
    "_vendor-react.js": { file: "assets/vendor-react.js", name: "vendor-react" },
    [rebuild]: {
      file: "assets/rebuild-app.js", src: rebuild, name: "rebuild-app",
      isDynamicEntry: true, imports: ["_vendor-react.js", "index.html"],
    },
  };
}

async function runGate(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnia-rebuild-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = fixture();
  options.mutate?.(manifest);
  await mkdir(path.join(root, ".vite"));
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, ".vite", "manifest.json"), options.rawManifest ?? JSON.stringify(manifest));
  await writeFile(path.join(root, "index.html"), options.html ?? html);
  for (const record of Object.values(manifest)) {
    if (!record || typeof record.file !== "string" || options.missing?.includes(record.file)) continue;
    const target = path.resolve(root, record.file.replace(/^\.\//, "").replace(/^\//, ""));
    // Malformed asset fixtures must never create files outside this test directory.
    if (!target.startsWith(`${root}${path.sep}`)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(options.sizes?.[record.file] ?? 1024, 32));
  }
  const result = spawnSync(process.execPath, [checker], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, OMNIA_BUNDLE_DIST: root },
  });
  assert.ifError(result.error);
  return result;
}

function rejected(result, reason) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, reason);
}

test("accepts the original renderer without retired Labs activity records", async (t) => {
  const result = await runGate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /src\/rebuild\/rebuild-app\.tsx/);
  assert.match(result.stdout, /legacy renderer.*absent/i);
});

test("follows static dependencies between multiple dynamic import hops", async (t) => {
  const result = await runGate(t, { mutate(m) {
    m["index.html"].dynamicImports = ["_bootstrap.js"];
    m["_bootstrap.js"] = { file: "assets/bootstrap.js", imports: ["_bridge.js"] };
    m["_bridge.js"] = { file: "assets/bridge.js", dynamicImports: [rebuild] };
  } });
  assert.equal(result.status, 0, result.stderr);
});

test("resolves a promoted renderer record by its exact source identity", async (t) => {
  const result = await runGate(t, { mutate(m) {
    m["_rebuild-app-fixture.js"] = m[rebuild];
    delete m[rebuild];
    m["index.html"].dynamicImports = ["_rebuild-app-fixture.js"];
  } });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects a bundle with no original renderer", async (t) => {
  rejected(await runGate(t, { mutate(m) {
    delete m[rebuild]; m["index.html"].dynamicImports = [];
  } }), /src\/rebuild\/rebuild-app\.tsx.*manifest record/);
});

test("rejects an orphan renderer record that the entry never loads", async (t) => {
  rejected(await runGate(t, { mutate(m) { m["index.html"].dynamicImports = []; } }), /rebuild-app.*not reachable/);
});

test("rejects eager original renderer imports even when a dynamic edge exists", async (t) => {
  rejected(await runGate(t, { mutate(m) { m["index.html"].imports.push(rebuild); } }), /rebuild-app.*eager startup/);
});

test("rejects eager aliases of the emitted original renderer asset", async (t) => {
  rejected(await runGate(t, { mutate(m) {
    m["_shared-renderer.js"] = { file: "assets/rebuild-app.js" };
    m["index.html"].imports.push("_shared-renderer.js");
  } }), /rebuild-app.*eager startup/);
});

test("requires the original renderer to be a Vite dynamic entry", async (t) => {
  rejected(await runGate(t, { mutate(m) { m[rebuild].isDynamicEntry = false; } }), /rebuild-app.*dynamic entry/);
});

test("requires the original renderer to emit JavaScript", async (t) => {
  rejected(await runGate(t, { mutate(m) { m[rebuild].file = "assets/rebuild-app.css"; } }), /rebuild-app.*JavaScript/);
});

test("rejects original renderer preloading from built HTML", async (t) => {
  rejected(await runGate(t, { html: `${html}<link rel="modulepreload" href="/assets/rebuild-app.js">` }), /rebuild-app.*eagerly referenced/);
});

test("rejects eager renderer imports from a second HTML startup module", async (t) => {
  rejected(await runGate(t, {
    html: `${html}<script type="module" src="/assets/startup-wrapper.js"></script>`,
    mutate(m) { m["_startup-wrapper.js"] = { file: "assets/startup-wrapper.js", imports: [rebuild] }; },
  }), /rebuild-app.*eager startup/);
});

test("rejects inline executable imports that bypass the manifest graph", async (t) => {
  rejected(await runGate(t, {
    html: `${html}<script type="module">import "/assets/labs.js";</script>`,
    mutate(m) { m["src/labs/labs-app.tsx"] = { file: "assets/labs.js", src: "src/labs/labs-app.tsx" }; },
  }), /inline executable script.*cannot be attested/);
});

test("allows inert JSON data and empty inline scripts", async (t) => {
  const result = await runGate(t, { html: `${html}<script type="application/json">{"hello":"world"}</script><script type="module"> </script>` });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects HTML that does not bootstrap the manifest entry", async (t) => {
  rejected(await runGate(t, { html: '<script type="module" src="/assets/stale.js"></script>' }), /index\.html.*entry asset/);
});

test("rejects unattested classic scripts in built HTML", async (t) => {
  rejected(await runGate(t, { html: `${html}<script src="/assets/unlisted.js"></script>` }), /index\.html.*unlisted\.js.*manifest/);
});

test("rejects remote scripts that bypass local build attestation", async (t) => {
  rejected(await runGate(t, { html: `${html}<script src="https://example.invalid/app.js"></script>` }), /script.*no local entry asset attestation/);
});

test("ignores commented preload tags and accepts relative built script paths", async (t) => {
  const result = await runGate(t, { html: '<!-- <link rel="modulepreload" href="/assets/rebuild-app.js"> --><script type="module" src="./assets/index.js"></script>' });
  assert.equal(result.status, 0, result.stderr);
});

for (const source of ["src/App.tsx", "src/labs/labs-app.tsx", "src/agent/shell.tsx", "src/features/workspace/markdown.tsx", "src/styles/tokens.css"]) {
  test(`rejects reachable legacy renderer source ${source}`, async (t) => {
    rejected(await runGate(t, { mutate(m) {
      m[source] = { file: "assets/retired.js", src: source };
      m[rebuild].dynamicImports = [source];
    } }), /legacy renderer.*reachable/i);
  });
}

test("rejects a promoted legacy implementation chunk without a source path", async (t) => {
  rejected(await runGate(t, { mutate(m) {
    m["_workspace-composer-hash.js"] = { file: "assets/workspace-composer-hash.js", name: "workspace-composer" };
    m["_vendor-react.js"].imports = ["_workspace-composer-hash.js"];
  } }), /legacy renderer.*workspace-composer.*reachable/i);
});

test("finds legacy dynamic imports behind a static dependency of a lazy chunk", async (t) => {
  rejected(await runGate(t, { mutate(m) {
    m[rebuild].imports.push("_bridge.js");
    m["_bridge.js"] = { file: "assets/bridge.js", dynamicImports: ["src/labs/labs-app.tsx"] };
    m["src/labs/labs-app.tsx"] = { file: "assets/labs.js", src: "src/labs/labs-app.tsx" };
  } }), /legacy renderer.*labs-app.*reachable/i);
});

test("rejects legacy scripts loaded directly by built HTML", async (t) => {
  rejected(await runGate(t, { html: `${html}<script type="module" src="/assets/labs.js"></script>`, mutate(m) {
    m["src/labs/labs-app.tsx"] = { file: "assets/labs.js", src: "src/labs/labs-app.tsx" };
  } }), /legacy renderer.*labs-app.*reachable/i);
});

test("accepts native contract and pure domain chunk identities", async (t) => {
  const result = await runGate(t, { mutate(m) {
    m[rebuild].imports.push("src/lib/desktop.ts", "src/domain/effort.ts");
    m["src/lib/desktop.ts"] = { file: "assets/desktop-client.js", src: "src/lib/desktop.ts", name: "desktop-client" };
    m["src/domain/effort.ts"] = { file: "assets/omnia-domain.js", src: "src/domain/effort.ts", name: "omnia-domain" };
  } });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects missing static manifest edge records", async (t) => {
  rejected(await runGate(t, { mutate(m) { m[rebuild].imports.push("_missing.js"); } }), /_missing\.js.*no manifest record/);
});

test("rejects missing dynamic manifest edge records", async (t) => {
  rejected(await runGate(t, { mutate(m) { m[rebuild].dynamicImports = ["_missing.js"]; } }), /_missing\.js.*no manifest record/);
});

test("terminates when static and dynamic manifest edges contain cycles", async (t) => {
  const result = await runGate(t, { mutate(m) { m[rebuild].dynamicImports = [rebuild, "index.html"]; } });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects missing emitted JavaScript", async (t) => {
  rejected(await runGate(t, { missing: ["assets/rebuild-app.js"] }), /manifest asset assets\/rebuild-app\.js is missing/);
});

test("rejects empty entry assets", async (t) => {
  rejected(await runGate(t, { sizes: { "assets/index.js": 0 } }), /assets\/index\.js.*empty/);
});

for (const rawManifest of ["{", "null", "[]"]) {
  test(`rejects invalid manifest ${rawManifest} with a gate diagnostic`, async (t) => {
    const result = await runGate(t, { rawManifest });
    rejected(result, /Bundle gate failed:.*manifest.*invalid/i);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
}

test("rejects malformed import lists with a gate diagnostic", async (t) => {
  const result = await runGate(t, { mutate(m) { m[rebuild].imports = "_vendor-react.js"; } });
  rejected(result, /manifest.*imports.*array/i);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("rejects null manifest records with a gate diagnostic", async (t) => {
  const result = await runGate(t, { mutate(m) { m[rebuild] = null; } });
  rejected(result, /manifest.*record.*invalid/i);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("rejects manifest asset paths outside the configured output", async (t) => {
  rejected(await runGate(t, { mutate(m) { m[rebuild].file = "../escaped.js"; } }), /asset path.*outside/i);
});

test("rejects ambiguous index manifest entries", async (t) => {
  rejected(await runGate(t, { mutate(m) { m["second.html"] = { file: "assets/second.js", src: "index.html", isEntry: true }; } }), /expected one Vite manifest entry.*found 2/);
});

for (const [bytes, expected] of [[500_000, 0], [500_001, 1]]) {
  test(`enforces the 500000-byte entry budget at ${bytes} bytes`, async (t) => {
    const result = await runGate(t, { sizes: { "assets/index.js": bytes } });
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.match(result.stderr, /entry assets\/index\.js.*500,001 B.*500,000 B/);
  });
}

for (const [bytes, expected] of [[307_200, 0], [307_201, 1]]) {
  test(`enforces the 307200-byte async chunk budget at ${bytes} bytes`, async (t) => {
    const result = await runGate(t, { sizes: { "assets/rebuild-app.js": bytes } });
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.match(result.stderr, /async chunk assets\/rebuild-app\.js.*307,201 B.*307,200 B/);
  });
}

for (const [extra, expected] of [[0, 0], [1, 1]]) {
  test(`enforces the 5120000-byte total budget at ${5_120_000 + extra} bytes`, async (t) => {
    const sizes = { "assets/index.js": 100_000 + extra, "assets/rebuild-app.js": 200_000, "assets/vendor-react.js": 20_000 };
    for (let i = 0; i < 16; i++) sizes[`assets/padding-${i}.js`] = 300_000;
    const result = await runGate(t, { sizes, mutate(m) {
      for (let i = 0; i < 16; i++) {
        m[`_padding-${i}.js`] = { file: `assets/padding-${i}.js` };
        m[rebuild].imports.push(`_padding-${i}.js`);
      }
    } });
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.match(result.stderr, /total JavaScript.*5,120,001 B.*5,120,000 B/);
  });
}

test("counts a shared emitted asset once", async (t) => {
  const result = await runGate(t, { sizes: { "assets/rebuild-app.js": 200_000 }, mutate(m) {
    for (let i = 0; i < 30; i++) {
      m[`_shared-${i}.js`] = { file: "assets/rebuild-app.js" };
      m[rebuild].imports.push(`_shared-${i}.js`);
    }
  } });
  assert.equal(result.status, 0, result.stderr);
});
