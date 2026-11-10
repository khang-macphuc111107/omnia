import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const packageData = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const workflows = new URL('../../.github/workflows/', import.meta.url);

test('every npm run command in every workflow names an existing package script', async () => {
  const missing = [];
  for (const file of await readdir(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const source = await readFile(new URL(file, workflows), 'utf8');
    for (const match of source.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
      if (!packageData.scripts[match[1]]) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('static contracts include the checksum-pinned workflow linter', async () => {
  const source = await readFile(new URL('run-static-checks.mjs', import.meta.url), 'utf8');
  assert.match(source, /node\('workflow-lint', 'scripts\/ci\/lint-workflows\.mjs'\)/);
  assert.match(packageData.scripts['check:workflows'], /lint-workflows\.mjs/);
});

test('CI includes Node script regressions that Vitest intentionally excludes', () => {
  const command = packageData.scripts['test:ci'] ?? '';
  for (const required of ['scripts/ci/*.test.mjs', 'scripts/rebuild/*.test.mjs',
    'scripts/generate-design-tokens.test.mjs', 'scripts/verify-release-version.test.mjs',
    'scripts/check-bundle-budget.test.mjs', 'tests/rebuild-cycle10-*.test.mjs']) {
    assert.ok(command.includes(required), `Missing regression target: ${required}`);
  }
});

test('quality retains native/storage/visual jobs and has a fail-closed aggregate', async () => {
  const source = await readFile(new URL('ci.yml', workflows), 'utf8');
  for (const id of ['renderer', 'native', 'native-shell', 'storage-contract', 'visual-contract', 'quality-complete']) {
    assert.match(source, new RegExp(`^  ${id}:`, 'm'));
  }
  assert.match(source, /NEEDS_RESULTS:\s*\$\{\{ toJSON\(needs\) \}\}/);
  assert.match(source, /node scripts\/ci\/assert-job-results\.mjs/);
  assert.doesNotMatch(source, /continue-on-error:\s*true/);
  const aggregate = source.split(/^  quality-complete:\s*$/m)[1] ?? '';
  assert.match(aggregate, /needs:\s*\[[^\]]*\bnative-shell\b[^\]]*\]/);
  assert.match(aggregate, /quality\.txt/);
  assert.match(aggregate, /write-diagnostic-manifest\.mjs/);
  assert.match(aggregate, /uses:\s*actions\/upload-artifact@/);
});

test('independent native shell checks its own package without Node provisioning', async () => {
  const source = await readFile(new URL('ci.yml', workflows), 'utf8');
  const job = source.split(/^  native-shell:\s*$/m)[1]?.split(/^  renderer:\s*$/m)[0] ?? '';
  for (const command of ['fmt', 'test', 'clippy', 'build']) {
    assert.match(job, new RegExp(`cargo ${command} --manifest-path native/Cargo\\.toml`));
  }
  assert.match(job, /--locked --all-targets/);
  assert.match(job, /--locked --release/);
  assert.match(job, /if:\s*always\(\)/);
  assert.doesNotMatch(job, /actions\/setup-node|npm (?:ci|install)/);
});

test('all PR workflows upload diagnostics even on failures or cancellations', async () => {
  for (const file of ['ci.yml', 'fast-feedback.yml', 'rebuild.yml']) {
    const source = await readFile(new URL(file, workflows), 'utf8');
    assert.match(source, /if:\s*always\(\)/, file);
    assert.match(source, /uses:\s*actions\/upload-artifact@/, file);
  }
});

test('every substantive CI job writes a missing-file manifest before its diagnostic upload', async () => {
  for (const file of ['ci.yml', 'fast-feedback.yml', 'rebuild.yml', 'release.yml']) {
    const source = await readFile(new URL(file, workflows), 'utf8');
    assert.match(source, /node scripts\/ci\/write-diagnostic-manifest\.mjs/, file);
    assert.match(source, /--expect [a-z][a-z0-9-]*\.txt/, file);
    assert.doesNotMatch(source, /continue-on-error:\s*true/, file);
  }
});

test('rebuild and release gates execute the checksum-pinned platform linter', async () => {
  for (const file of ['rebuild.yml', 'release.yml']) {
    const source = await readFile(new URL(file, workflows), 'utf8');
    assert.match(source, /npm run check:workflows/, file);
    assert.match(source, /artifacts\/ci\/workflow-lint\//, file);
  }
});

test('release validation provisions browser runtime and runs complete evidence gates', async () => {
  const source = await readFile(new URL('release.yml', workflows), 'utf8');
  for (const required of [
    'agent-browser@0.41.2',
    'agent-browser install',
    'npm run check:static',
    'npm run test:ci',
    'npm run rebuild:check',
    'scripts/rebuild/validate.mjs',
    'scripts/rebuild/architecture-guard.mjs',
    'npx playwright install chromium',
    'npm run test:visual',
    'npm run check:bundle',
    'validate-spec.ps1',
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), required);
  assert.match(source, /ref: refs\/tags\/\$\{\{ github\.event_name/);
  assert.match(source, /git rev-parse --verify "refs\/tags\/\$\(\$env:RELEASE_TAG\)\^\{commit\}"/);
  assert.match(source, /needs\.validate\.outputs\.sha/);
});

test('release builds the renderer before checking bundle budgets', async () => {
  const source = await readFile(new URL('release.yml', workflows), 'utf8');
  const buildIndex = source.indexOf('- name: Build web distribution');
  const bundleIndex = source.indexOf('- name: Check active renderer bundle budgets');
  assert.ok(buildIndex >= 0, 'release build step is missing');
  assert.ok(bundleIndex >= 0, 'release bundle gate is missing');
  assert.ok(buildIndex < bundleIndex, 'bundle budget gate must run after the renderer build');
  const buildBlock = source.slice(buildIndex, bundleIndex);
  assert.match(buildBlock, /npm run build:renderer/u);
});

test('Windows storage contracts pin a hosted Python payload and retain its version receipt', async () => {
  const ci = await readFile(new URL('ci.yml', workflows), 'utf8');
  const release = await readFile(new URL('release.yml', workflows), 'utf8');
  for (const source of [ci, release]) {
    assert.match(source, /actions\/setup-python@[a-f0-9]{40}/);
    assert.match(source, /python-version:\s*"3\.13\.17"/);
    assert.match(source, /python --version/);
    assert.match(source, /python-version\.txt/);
  }
  assert.doesNotMatch(ci, /python-version:\s*"3\.13\.18"/);
  assert.doesNotMatch(release, /python-version:\s*"3\.13\.18"/);
});

test('release write permission is scoped to the bundle publisher', async () => {
  const source = await readFile(new URL('release.yml', workflows), 'utf8');
  assert.match(source, /^permissions:\s*\r?\n\s+contents:\s+read\s*$/mu);
  const bundle = source.split(/^  windows-bundle:/m)[1] ?? '';
  assert.match(bundle, /^\s+permissions:\s*\r?\n\s+contents:\s+write\s*$/mu);
  const validate = source.split(/^  validate:/m)[1]?.split(/^  windows-bundle:/m)[0] ?? '';
  assert.doesNotMatch(validate, /contents:\s*write/u);
});

test('Windows bundle verification requires both installer families and immutable revision', async () => {
  const source = await readFile(new URL('release.yml', workflows), 'utf8');
  assert.match(source, /verify-windows-bundles\.mjs/);
  assert.match(source, /bundle-manifest\.json/);
  assert.match(packageData.scripts['test:ci'], /scripts\/ci\/\*\.test\.mjs/);
});

test('release payload artifacts fail if missing and shell scripts use tag environment values', async () => {
  const source = await readFile(new URL('release.yml', workflows), 'utf8');
  for (const name of ['Upload web distribution', 'Upload bundle checksums']) {
    const step = source.split(`- name: ${name}`)[1]?.split(/      - name:/)[0];
    assert.ok(step, name);
    assert.match(step, /if-no-files-found: error/, name);
  }
  assert.doesNotMatch(source, /\$tag = if \('\$\{\{ github\.event_name \}\}'/);
  assert.match(source, /gh release upload \$env:RELEASE_TAG/);
});

test('quality checks renderer/native command parity and static contracts explicitly', async () => {
  const source = await readFile(new URL('ci.yml', workflows), 'utf8');
  assert.match(source, /npm run check:static/);
  assert.match(source, /npm run test:ci/);
  assert.match(source, /npm run typecheck/);
  assert.match(source, /npm run check:bundle/);
});

test('renderer runtime contracts install a pinned browser harness and expose its binary', async () => {
  const source = await readFile(new URL('ci.yml', workflows), 'utf8');
  assert.match(source, /agent-browser@0\.41\.2/);
  assert.match(source, /agent-browser install/);
  assert.match(source, /AGENT_BROWSER_BIN=\$binary/);
  assert.match(source, /agent-browser-install\.txt/);
});

test('renderer and native diagnostics continue after an earlier check fails', async () => {
  const source = await readFile(new URL('ci.yml', workflows), 'utf8');
  for (const step of [
    'Check static contracts and native command parity',
    'Typecheck application and browser-test configuration',
    'Test workflow, release and script regressions',
    'Run full application test suite',
    'Build production renderer',
    'Check active renderer bundle budgets',
    'Check native formatting',
    'Check native Clippy',
    'Verify native test loader',
    'Run native workspace tests',
  ]) {
    const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(source, new RegExp(`- name: ${escaped}\\s+if: always\\(\\)`));
  }
});

test('Git preserves receipt-bound file bytes on Windows and Linux', async () => {
  const attributes = await readFile(new URL('../../.gitattributes', import.meta.url), 'utf8');
  assert.ok(attributes.split(/\r?\n/).includes('* text=auto eol=lf'), 'canonical source hashes need deterministic checkout line endings');
  for (const pattern of [
    'docs/rebuild/receipts/** -text',
    'docs/rebuild/audit/** -text',
    'docs/rebuild/research/snapshots/** -text',
    'artifacts/** -text',
  ]) {
    assert.ok(attributes.split(/\r?\n/).includes(pattern), `missing exact-byte rule: ${pattern}`);
  }
  assert.doesNotMatch(attributes, /^\* -text$/m, 'regular source and workflow files must remain normal text');
});

test('storage regressions and real diagnostic logs run in required CI', async () => {
  const source = await readFile(new URL('ci.yml', workflows), 'utf8');
  assert.match(source, /test_state_revision_schema_verifier\.py/);
  assert.match(source, /Tee-Object[^\n]*artifacts\/ci\/storage/);
  assert.match(source, /if \(\$contractFailed\) \{ exit 1 \}/);
});

test('default visual contract selects current renderer and retains historical command', () => {
  assert.match(packageData.scripts['test:visual:contract'], /rebuild-renderer\.spec\.ts/);
  assert.match(packageData.scripts['test:visual:historical'], /playwright\.historical\.config\.ts/);
  assert.match(packageData.scripts['test:ci'], /tests\/visual\/runner-scope\.node\.mjs/);
});
