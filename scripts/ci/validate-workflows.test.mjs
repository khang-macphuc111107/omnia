import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflowSource } from "./validate-workflows.mjs";

const scripts = { "check:static": "", "test:ci": "" };
const valid = `name: quality
on:
  pull_request:
jobs:
  build:
    runs-on: windows-latest
    steps:
      - run: npm run check:static
      - name: diagnostics
        if: always()
        uses: actions/upload-artifact@v4
  quality-complete:
    if: always()
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - env:
          NEEDS_RESULTS: \${{ toJSON(needs) }}
        run: node scripts/ci/assert-job-results.mjs
`;

test("workflow validator accepts the supported CI shape", () => {
  const result = validateWorkflowSource(valid, { packageScripts: scripts, requireDiagnostics: true });
  assert.deepEqual(result.errors, []);
});

test("workflow validator rejects an unknown need and a dependency cycle", () => {
  const source = `name: broken
on:
  pull_request:
jobs:
  first:
    needs: second
    runs-on: ubuntu-latest
    steps:
      - run: npm run check:static
  second:
    needs: first, missing
    runs-on: ubuntu-latest
    steps:
      - run: npm run check:static
`;
  const result = validateWorkflowSource(source, { packageScripts: scripts });
  assert.ok(result.errors.some((error) => /unknown job "missing"/u.test(error)));
  assert.ok(result.errors.some((error) => /dependency cycle/u.test(error)));
});

test("workflow validator rejects missing scripts, malformed expressions and unsupported shells", () => {
  const source = `name: broken
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - shell: fish
        run: npm run does-not-exist
      - run: echo "\${{ github.sha }"
`;
  const result = validateWorkflowSource(source, { packageScripts: scripts });
  assert.ok(result.errors.some((error) => /no package\.json script/u.test(error)));
  assert.ok(result.errors.some((error) => /unbalanced GitHub expression/u.test(error)));
  assert.ok(result.errors.some((error) => /unsupported shell/u.test(error)));
});

test("required PR workflows must upload diagnostics and must not allow errors", () => {
  const source = `name: required
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: npm run check:static
`;
  const result = validateWorkflowSource(source, { packageScripts: scripts, requireDiagnostics: true });
  assert.ok(result.errors.some((error) => /diagnostics artifact/u.test(error)));
  assert.ok(result.errors.some((error) => /continue-on-error/u.test(error)));
});

test("workflow validation rejects Python contracts without a provisioned interpreter in the same job", () => {
  const source = `name: release
on:
  workflow_dispatch:
jobs:
  validate:
    runs-on: windows-latest
    steps:
      - run: python scripts/verify-state-revision-schema.py
`;
  assert.ok(validateWorkflowSource(source).errors.some((error) => /Python.*setup-python/u.test(error)));
  const provisioned = source.replace(
    "    steps:",
    '    steps:\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.13.17"',
  );
  assert.deepEqual(validateWorkflowSource(provisioned).errors, []);
});

test("workflow validation rejects workflow-wide write permission and accepts job-scoped release write", () => {
  const source = `name: release
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  bundle:
    runs-on: windows-latest
    steps:
      - run: node scripts/ci/verify-windows-bundles.mjs
`;
  assert.ok(validateWorkflowSource(source).errors.some((error) => /workflow-wide.*write/u.test(error)));
  const scoped = source.replace("contents: write", "contents: read")
    .replace("  bundle:\n", "  bundle:\n    permissions:\n      contents: write\n");
  assert.deepEqual(validateWorkflowSource(scoped).errors, []);
});

test("strict dependency validation rejects mutable action refs and accepts immutable action commits", () => {
  const source = `name: quality
on:
  pull_request:
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
`;
  const options = { requirePinnedActions: true };
  assert.ok(validateWorkflowSource(source, options).errors.some((error) => /immutable.*action/u.test(error)));
  const pinned = source.replace("@v4", "@11d5960a326750d5838078e36cf38b85af677262");
  assert.deepEqual(validateWorkflowSource(pinned, options).errors, []);
});
