import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardArchitecture } from "./architecture-guard.mjs";

async function project(source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnia-architecture-guard-"));
  await mkdir(path.join(root, "src/rebuild"), { recursive: true });
  await writeFile(path.join(root, "src/main.tsx"), source, "utf8");
  await writeFile(path.join(root, "src/rebuild/app.tsx"), "export const App = () => null;\n", "utf8");
  return root;
}

test("accepts an original rebuild entry and rejects legacy renderer import", async () => {
  const good = await project('import { App } from "./rebuild/app";\nvoid App;\n');
  const result = await guardArchitecture(good, { checkCopies: false });
  assert.equal(result.violations.length, 0);
  const bad = await project('import "./agent/agent-shell";\n');
  await assert.rejects(guardArchitecture(bad, { checkCopies: false }), /unresolved local import|legacy/);
});

test("rejects external app embedding and computed module paths", async () => {
  const iframe = await project('export function App() { return <iframe src="https://example.com" />; }\n');
  await assert.rejects(guardArchitecture(iframe, { checkCopies: false }), /embedded app element/);
  const computed = await project('const name = "./rebuild/app"; void import(name);\n');
  await assert.rejects(guardArchitecture(computed, { checkCopies: false }), /computed dynamic import/);
});
