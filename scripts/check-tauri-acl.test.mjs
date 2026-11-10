import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertCapability, assertFramePolicies } from "./check-tauri-acl.mjs";

const source = JSON.parse(await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

function generatedCapability() {
  const { $schema, ...capability } = structuredClone(source);
  return { ...capability, local: true };
}

test("source capability only grants reviewed permissions to the main webview", () => {
  assert.doesNotThrow(() => assertCapability("source", source, { generated: false }));
});

test("generated capability has the same narrow selector", () => {
  assert.doesNotThrow(() => assertCapability("generated", generatedCapability(), { generated: true }));
});

for (const generated of [false, true]) {
  for (const windows of [["main"], ["*"], []]) {
    test(`${generated ? "generated" : "source"} capability rejects windows selector ${JSON.stringify(windows)}`, () => {
      const capability = generated ? generatedCapability() : structuredClone(source);
      capability.windows = windows;
      assert.throws(() => assertCapability("mutated", capability, { generated }), /keys must be exactly/);
    });
  }
}

for (const webviews of [["*"], ["main", "omnia-editor"], ["main", "main"], []]) {
  test(`capability rejects expanded or malformed webview selector ${JSON.stringify(webviews)}`, () => {
    assert.throws(() => assertCapability("mutated", { ...source, webviews }, { generated: false }), /allowlist|duplicate/);
  });
}

test("capability rejects remote grants and unreviewed permissions", () => {
  assert.throws(() => assertCapability("mutated", { ...source, remote: { urls: ["*"] } }, { generated: false }), /keys must be exactly/);
  assert.throws(() => assertCapability("mutated", { ...source, permissions: [...source.permissions, "core:webview:allow-create-webview"] }, { generated: false }), /allowlist/);
});

test("release frames only artifacts while development can embed the editor", () => {
  assert.doesNotThrow(() => assertFramePolicies(config));
});

for (const extra of ["http://127.0.0.1:1430", "*", "'self'", "https:"]) {
  test(`release frame policy rejects extra source ${extra}`, () => {
    const changed = structuredClone(config);
    changed.app.security.csp += ` ${extra}`;
    assert.throws(() => assertFramePolicies(changed), /allowlist/);
  });
}

test("development retains editor framing and does not permit wildcards", () => {
  const missingEditor = structuredClone(config);
  missingEditor.app.security.devCsp = missingEditor.app.security.devCsp.replace(" http://127.0.0.1:1430", "");
  assert.throws(() => assertFramePolicies(missingEditor), /allowlist/);
  const wildcard = structuredClone(config);
  wildcard.app.security.devCsp += " *";
  assert.throws(() => assertFramePolicies(wildcard), /allowlist/);
});

test("CSP must have one explicit frame-src directive", () => {
  for (const csp of [null, "default-src 'self'", `${config.app.security.csp}; frame-src *`, config.app.security.csp.replace("frame-src", "frame-src-other")]) {
    const changed = structuredClone(config);
    changed.app.security.csp = csp;
    assert.throws(() => assertFramePolicies(changed), /CSP string|exactly one frame-src/);
  }
});
