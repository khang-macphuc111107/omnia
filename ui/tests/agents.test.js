// Unit tests for the Agents view helpers (pure functions; no DOM required).
// Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { t, setLang } from '../app/core/i18n.js';
import '../app/core/strings.js';
import '../app/views/agents/strings.js';
import {
  layoutMesh, hitTest, edgeEndpoints, arrowHead, nodeCode, effectiveSelection, nextPulse, pulseEdges,
  logMessages, provenanceView, stateView, countLinks, defaultPair, describeRoute, maxSeq, normalizeGraph, easeOutCubic
} from '../app/views/agents/mesh.js';
import { groupEntities, defaultRoot, normalizeDepth, normalizeDirection, readTraverse, confidencePercent } from '../app/views/agents/code-graph.js';

// setLang() touches document.documentElement.lang; Node has no DOM.
globalThis.document = globalThis.document || { documentElement: { lang: 'vi' } };

const nodes = [
  { id: 'verifier', role: 'verifier', label: 'Independent Verifier' },
  { id: 'coordinator', role: 'coordinator', label: 'Coordinator' },
  { id: 'rust-core', role: 'specialist', label: 'Rust Core' },
  { id: 'ui-atelier', role: 'specialist', label: 'UI Atelier' }
];

test('layout is deterministic: coordinator centred, others on the ellipse ordered by id', () => {
  const a = layoutMesh(nodes, 800, 500);
  const b = layoutMesh([...nodes].reverse(), 800, 500);
  assert.deepEqual([...a.entries()], [...b.entries()]);
  assert.deepEqual([a.get('coordinator').x, a.get('coordinator').y], [400, 250]);
  const top = a.get('rust-core'); // first on the ring, at twelve o'clock
  assert.ok(Math.abs(top.x - 400) < 1e-9 && top.y < 250);
  assert.equal(layoutMesh([], 800, 500).size, 0);
  assert.equal(layoutMesh(nodes, 0, 500).size, 0);
  assert.equal(layoutMesh([{ id: 'solo', role: 'worker' }], 400, 300).get('solo').x, 200);
});

test('hit-testing picks the nearest disc and misses empty space', () => {
  const layout = layoutMesh(nodes, 800, 500);
  const p = layout.get('ui-atelier');
  assert.equal(hitTest(layout, p.x + 5, p.y - 5), 'ui-atelier');
  assert.equal(hitTest(layout, 5, 5), null);
});

test('edge geometry trims to the rings and arrowheads point at the tip', () => {
  const seg = edgeEndpoints({ x: 0, y: 0, r: 20 }, { x: 100, y: 0, r: 20 }, 2);
  assert.equal(seg.x1, 22);
  assert.equal(seg.x2, 78);
  const [tip, l, r] = arrowHead(78, 0, 0, 10);
  assert.deepEqual(tip, [78, 0]);
  assert.ok(l[0] < 78 && r[0] < 78 && l[1] * r[1] < 0);
  assert.equal(easeOutCubic(2), 1);
});

test('node codes and selection fallbacks', () => {
  assert.equal(nodeCode({ label: 'UI Atelier' }), 'UA');
  assert.equal(nodeCode({ label: 'Coordinator' }), 'COO');
  assert.equal(nodeCode({ label: 'Rust Core' }), 'RC');
  assert.equal(effectiveSelection(nodes, 'rust-core').id, 'rust-core');
  assert.equal(effectiveSelection(nodes, 'gone').id, 'coordinator');
  assert.equal(effectiveSelection([], 'x'), null);
});

test('pulse only for messages newer than the baseline; none on the first load', () => {
  const messages = [
    { seq: 1, from: 'a', to: 'b', recipients: ['b'] },
    { seq: 2, from: 'b', to: '@all', recipients: ['a', 'c', 'b'] }
  ];
  assert.equal(nextPulse(null, messages), null);
  assert.equal(nextPulse(2, messages), null);
  assert.deepEqual(nextPulse(1, messages), { seq: 2, edges: [{ from: 'b', to: 'a' }, { from: 'b', to: 'c' }] });
  assert.deepEqual(pulseEdges(messages[0]), [{ from: 'a', to: 'b' }]);
  assert.equal(maxSeq(messages), 2);
  assert.equal(describeRoute(messages[1]), 'a, c, b');
});

test('message log is newest first and capped at 50', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1 }));
  const log = logMessages(many);
  assert.equal(log.length, 50);
  assert.equal(log[0].seq, 80);
});

test('provenance, state, link counts and send defaults', () => {
  assert.equal(provenanceView('EXTRACTED').variant, 'ok');
  assert.equal(provenanceView('INFERRED').variant, 'info');
  assert.equal(provenanceView('AMBIGUOUS').variant, 'warn');
  assert.equal(stateView('ACTIVE').variant, 'ok');
  assert.equal(stateView('INACTIVE').variant, 'warn');
  assert.deepEqual(countLinks([{ mode: 'Duplex' }, { mode: 'Directed' }, {}]), { duplex: 2, directed: 1 });
  assert.deepEqual(defaultPair(nodes, 'ui-atelier'), { from: 'ui-atelier', to: 'coordinator' });
  assert.deepEqual(defaultPair(nodes, null, { from: 'gone', to: '@all' }), { from: 'coordinator', to: '@all' });
  assert.deepEqual(normalizeGraph(null).nodes, []);
});

test('code graph helpers: grouping, filtering, root, depth, traverse reading', () => {
  const entities = [
    { id: 'b', kind: 'skill', label: 'Định tuyến', path: 'x' },
    { id: 'a', kind: 'artifact', label: 'A', path: 'y' },
    { id: 'c', kind: 'skill', label: 'C', path: 'z' }
  ];
  const groups = groupEntities(entities);
  assert.deepEqual(groups.map((g) => [g.kind, g.count]), [['artifact', 1], ['skill', 2]]);
  assert.deepEqual(groupEntities(entities, 'dinh').map((g) => g.items.map((i) => i.id)), [['b']]);
  assert.equal(defaultRoot(entities, [{ from: 'c', to: 'a' }, { from: 'c', to: 'b' }]), 'c');
  assert.equal(defaultRoot([], []), '');
  assert.equal(normalizeDepth(0), 1);
  assert.equal(normalizeDepth(99), 8);
  assert.equal(normalizeDepth('x', 3), 3);
  assert.equal(normalizeDirection('Sideways'), 'Both');
  assert.equal(readTraverse({}).empty, true);
  assert.equal(readTraverse({ visited: ['a'], edges: [] }).entityCount, 1);
  assert.equal(confidencePercent(3500), 35);
  assert.equal(confidencePercent(undefined), null);
});

test('every agents string key used in the sources exists in vi and en', () => {
  const src = readFileSync(new URL('../app/views/agents/index.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/\bt\('(agents\.[\w.]+)'/g)].map((m) => m[1]));
  for (const role of ['coordinator', 'specialist', 'worker', 'verifier']) keys.add(`agents.role.${role}`);
  for (const dir of ['Both', 'Forward', 'Reverse']) keys.add(`agents.dir.${dir}`);
  assert.ok(keys.size > 60);
  for (const lang of ['vi', 'en']) {
    setLang(lang);
    for (const key of keys) {
      const missing = t(key) === key && t(`${key}.one`) === `${key}.one`;
      assert.equal(missing, false, `${lang}: ${key}`);
    }
  }
  setLang('vi');
});
