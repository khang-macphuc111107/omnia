const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server.cjs');
const catalog = require('./catalog.cjs');
const { spawnSync } = require('node:child_process');

test('catalog classifies every preview source and reconstructed shells explicitly', () => {
  assert.ok(catalog.length > 0);
  for (const entry of catalog) {
    assert.equal(typeof entry.sourceClassification, 'string', entry.id);
    assert.notEqual(entry.sourceClassification, '', entry.id);
  }
  assert.equal(catalog.find(entry => entry.id === 'orca').sourceClassification, 'reconstructed-shell-no-verified-upstream-assets');
});

test('desktop runtime audit reports entrypoint presence without claiming parity', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'runtime-audit.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity=unverified/);
});

test('electron contract audit remains explicit about static-only evidence', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'electron-contract-audit.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity=unverified/);
});

test('built Cherry Studio artifacts pass syntax checks without claiming runtime parity', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-artifact-audit.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /syntax=pass/);
});

test('completion audit fails closed while parity evidence is incomplete', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'completion-audit.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /runtime=unverified/);
});

test('catalog runtime audit reports candidates without claiming parity', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'catalog-runtime-audit.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity=unverified/);
});

test('IDE runtime audit records main/preload hashes and remains unverified', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'ide-runtime-audit.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity=unverified/);
  assert.match(result.stdout, /syntaxPass=/);
});

test('serves exact original bytes and resolves nested relative assets', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-upstream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'ui'));
  const html = Buffer.from('<!doctype html><script src="../runtime.js"></script>\n');
  fs.writeFileSync(path.join(dir, 'ui/index.html'), html);
  fs.writeFileSync(path.join(dir, 'runtime.js'), '/* original asset */');
  const server = createServer({ root: dir, entry: 'ui/index.html' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base);
  assert.equal(response.url, `${base}/ui/index.html`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), html);
  const asset = await fetch(new URL('../runtime.js', response.url));
  assert.equal(await asset.text(), '/* original asset */');
  const head = await fetch(`${base}/runtime.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const [url, status] of [['/api/download', 404], ['/missing.js', 404], ['/%ZZ', 400], ['/%2e%2e%2foutside.txt', 403], ['/..%5coutside.txt', 400]]) {
    assert.equal((await fetch(base + url)).status, status, url);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('rejects a junction escaping the asset root', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-upstream-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'index.html'), 'original');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const server = createServer({ root, entry: 'index.html' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/escape/private.txt`);
  assert.equal(response.status, 403);
});

test('missing source or build cannot become a successful mock preview', () => {
  assert.throws(() => createServer({ id: 'orca', entry: null, limitation: 'No verified original UI' }), /No verified original UI/);
  assert.throws(() => createServer({ root: path.join(os.tmpdir(), 'missing-upstream-' + Date.now()), entry: 'index.html' }), /ENOENT/);
});
