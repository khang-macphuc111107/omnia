// Unit tests for the Workspace view's pure modules. Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../app/core/strings.js';
import '../app/views/chat/strings.js';
import { t } from '../app/core/i18n.js';
import {
  emptyChat, sanitizeChat, buildPolicy, estimateTokens, routeFromResponse, routeFromError, receiptMessage,
  selectedScore, rejectedScores, scoreShares, trimMessages, MAX_MESSAGES, chatKey, pendingRoute, cancelledRoute
} from '../app/views/chat/local-store.js';
import { createRunTracker } from '../app/views/chat/run-control.js';
import {
  diffEdit, insertAtCaret, wrapInline, toggleLinePrefix, insertBlock, tableSnippet, insertToken, removeToken
} from '../app/views/chat/format.js';
import {
  effectivePlacement, addAttachment, removeAttachment, splitBySize, MAX_FILE_BYTES, withEffectivePlacement, describeFiles
} from '../app/views/chat/attachments.js';
import { filterTemplates, categoryCounts, templateTitle, insertionText, gridStep } from '../app/views/chat/templates.js';
import { threadHtml } from '../app/views/chat/thread.js';
import { inspectorHtml } from '../app/views/chat/inspector.js';
import { composerHtml } from '../app/views/chat/composer.js';
import { html } from '../app/core/dom.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = '9f2c41ab' + 'b'.repeat(56);

// ---------------------------------------------------------------------------
// strings
// ---------------------------------------------------------------------------

test('every chat string exists in both languages', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../app/views/chat/strings.js', import.meta.url), 'utf8'));
  const [vi, en] = source.split(/\n {2}en: \{/);
  const keys = (block) => new Set(Array.from(block.matchAll(/^\s{4}'?([A-Za-z.]+)'?: /gm)).map((m) => m[1]));
  const viKeys = keys(vi);
  const enKeys = keys(en);
  assert.ok(viKeys.size > 150);
  assert.deepEqual([...viKeys].filter((k) => !enKeys.has(k)), []);
  assert.deepEqual([...enKeys].filter((k) => !viKeys.has(k)), []);
});

// ---------------------------------------------------------------------------
// local store
// ---------------------------------------------------------------------------

test('policy: math_derivation only when the text has LaTeX, tokens follow the heuristic', () => {
  assert.deepEqual(buildPolicy('hello'), { taskClass: 'code_generation', estimatedTokens: 1026, privacyTier: 'enterprise_zdr', requireStreaming: true });
  assert.equal(buildPolicy('solve $x^2=4$').taskClass, 'math_derivation');
  assert.equal(buildPolicy('cost $5 and $6').taskClass, 'code_generation');
  assert.equal(estimateTokens(0), 1024);
  assert.equal(estimateTokens(3000), 2024);
  assert.equal(estimateTokens(1), 1025);
  assert.equal(chatKey('abc'), 'omnia.ui.chat.abc');
});

test('routeFromResponse distinguishes routed and fenced; errors keep the code', () => {
  const policy = buildPolicy('x');
  const routed = routeFromResponse({ ok: true, selectedCandidateId: 'p1', status: 'ROUTED_DETERMINISTIC', receipt: { receiptId: 'rdec-1' } }, policy);
  assert.equal(routed.state, 'routed');
  assert.equal(routed.selectedCandidateId, 'p1');
  const fenced = routeFromResponse({ ok: false, selectedCandidateId: null, status: 'FENCED_OPERATOR_RECOVERY_REQUIRED', receipt: { receiptId: 'rdec-2' } }, policy);
  assert.equal(fenced.state, 'fenced');
  assert.equal(fenced.receipt.receiptId, 'rdec-2');
  const failed = routeFromError({ code: 'network' }, policy);
  assert.deepEqual([failed.state, failed.errorCode, failed.receipt], ['error', 'network', null]);
  assert.equal(routeFromError(new Error('x'), policy).errorCode, 'unknown');
  assert.equal(pendingRoute(policy).state, 'pending');
});

test('sanitizeChat enforces the schema, caps messages and flags interrupted routes', () => {
  assert.deepEqual(sanitizeChat(null), emptyChat());
  assert.deepEqual(sanitizeChat('junk'), emptyChat());
  const messages = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => ({
    id: `m${i}`, role: 'assistant', markdown: `t${i}`, createdAt: 1, attachments: [{ sha256: 'bad' }, { sha256: SHA_A, name: 'f', size: 3, mime: 'text/plain', placement: 'weird' }],
    route: { state: i === MAX_MESSAGES + 4 ? 'pending' : 'routed', policy: { x: 1 } }
  }));
  const chat = sanitizeChat({ v: 1, messages: [...messages, null, { id: '' }], draft: { text: 'd', rev: 4, attachments: [{ sha256: SHA_B, name: 'n', size: 1, mime: 'a/b', placement: 'inline' }] } });
  assert.equal(chat.messages.length, MAX_MESSAGES);
  assert.equal(chat.messages[0].id, 'm5');
  assert.equal(chat.messages[0].role, 'user');
  assert.deepEqual(chat.messages[0].attachments.map((a) => [a.id, a.placement]), [['aaaaaaaa', 'tray']]);
  assert.equal(chat.messages.at(-1).route.state, 'error');
  assert.equal(chat.messages.at(-1).route.errorCode, 'interrupted');
  assert.equal(chat.draft.rev, 4);
  assert.equal(chat.draft.attachments[0].id, '9f2c41ab');
  const inflight = sanitizeChat({ messages: [{ id: 'k', markdown: '', route: { state: 'pending' } }] }, (id) => id === 'k');
  assert.equal(inflight.messages[0].route.state, 'pending');
  assert.equal(trimMessages([1, 2, 3]).length, 3);
});

test('receipt helpers pick the focused or newest receipt and the winning score', () => {
  const route = (state, receiptId, selected, scores = []) => ({ state, selectedCandidateId: selected, receipt: receiptId ? { receiptId, scores, selectedRoute: selected } : null, status: '', errorCode: '', policy: null });
  const messages = [
    { id: 'a', route: route('routed', 'rdec-1', 'p1') },
    { id: 'b', route: route('fenced', 'rdec-2', null, [{ candidateId: 'p1', eligible: false, rejectedReason: 'x' }, { candidateId: 'p2', eligible: true }]) },
    { id: 'c', route: route('pending', null, null) }
  ];
  assert.equal(receiptMessage(messages).id, 'b');
  assert.equal(receiptMessage(messages, 'a').id, 'a');
  assert.equal(receiptMessage([], null), null);
  assert.deepEqual(rejectedScores(messages[1].route).map((s) => s.candidateId), ['p1']);
  const winner = route('routed', 'r', 'p2', [{ candidateId: 'p2', capabilityScore: 40, privacyScore: 20, quotaScore: 20, latencyScore: 10, reliabilityScore: 10, totalScore: 100 }]);
  const score = selectedScore(winner);
  assert.equal(score.candidateId, 'p2');
  const { parts, shares } = scoreShares(score);
  assert.deepEqual(parts, [40, 20, 20, 10, 10]);
  assert.equal(Math.round(shares.reduce((a, b) => a + b, 0)), 100);
  assert.equal(selectedScore(messages[1].route), null);
  assert.deepEqual(scoreShares({}).shares, [0, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

test('diffEdit finds the minimal replacement', () => {
  assert.equal(diffEdit('abc', 'abc'), null);
  assert.deepEqual(diffEdit('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' });
  assert.deepEqual(diffEdit('abcd', 'ad'), { from: 1, to: 3, insert: '' });
  assert.deepEqual(diffEdit('', 'x'), { from: 0, to: 0, insert: 'x' });
});

test('wrapInline wraps, unwraps and handles empty selections', () => {
  assert.deepEqual(wrapInline({ value: 'a word b', start: 2, end: 6 }, '**'), { value: 'a **word** b', start: 4, end: 8 });
  assert.deepEqual(wrapInline({ value: 'a **word** b', start: 4, end: 8 }, '**'), { value: 'a word b', start: 2, end: 6 });
  assert.deepEqual(wrapInline({ value: 'a **word** b', start: 2, end: 10 }, '**'), { value: 'a word b', start: 2, end: 6 });
  assert.deepEqual(wrapInline({ value: 'ab', start: 1, end: 1 }, '*'), { value: 'a**b', start: 2, end: 2 });
  assert.deepEqual(wrapInline({ value: 'a**b', start: 2, end: 2 }, '*'), { value: 'ab', start: 1, end: 1 });
  assert.deepEqual(wrapInline({ value: 'x', start: 0, end: 1 }, '__'), { value: '__x__', start: 2, end: 3 });
});

test('toggleLinePrefix handles headings, lists, tasks, quotes', () => {
  assert.equal(toggleLinePrefix({ value: 'title', start: 0, end: 0 }, 'heading').value, '## title');
  assert.equal(toggleLinePrefix({ value: '## title', start: 0, end: 0 }, 'heading').value, '### title');
  assert.equal(toggleLinePrefix({ value: '### title', start: 0, end: 0 }, 'heading').value, 'title');
  assert.equal(toggleLinePrefix({ value: '# title', start: 0, end: 0 }, 'heading').value, '## title');
  const bullet = toggleLinePrefix({ value: 'a\nb\n\nc', start: 0, end: 6 }, 'bullet');
  assert.equal(bullet.value, '- a\n- b\n\n- c');
  assert.equal(toggleLinePrefix({ value: bullet.value, start: bullet.start, end: bullet.end }, 'bullet').value, 'a\nb\n\nc');
  assert.equal(toggleLinePrefix({ value: 'a\nb\nc', start: 0, end: 5 }, 'numbered').value, '1. a\n2. b\n3. c');
  assert.equal(toggleLinePrefix({ value: '- a\n- b', start: 0, end: 7 }, 'numbered').value, '1. a\n2. b');
  assert.equal(toggleLinePrefix({ value: '- a', start: 0, end: 0 }, 'task').value, '- [ ] a');
  assert.equal(toggleLinePrefix({ value: '- [ ] a', start: 0, end: 0 }, 'task').value, 'a');
  assert.equal(toggleLinePrefix({ value: 'q', start: 1, end: 1 }, 'quote').value, '> q');
  assert.equal(toggleLinePrefix({ value: '', start: 0, end: 0 }, 'bullet').value, '- ');
  assert.equal(toggleLinePrefix({ value: 'x\ny', start: 3, end: 3 }, 'quote').value, 'x\n> y');
});

test('insert helpers: caret snippets, blocks, tokens', () => {
  assert.deepEqual(insertAtCaret({ value: 'ab', start: 1, end: 1 }, '$x$'), { value: 'a$x$b', start: 4, end: 4 });
  assert.deepEqual(insertAtCaret({ value: 'abc', start: 1, end: 2 }, 'Z'), { value: 'aZc', start: 2, end: 2 });
  const table = tableSnippet((n) => `C${n}`);
  assert.equal(table.split('\n').length, 3);
  assert.equal(insertBlock({ value: 'a', start: 1, end: 1 }, table).value.startsWith('a\n| C1'), true);
  assert.equal(insertBlock({ value: '', start: 0, end: 0 }, 'B').value, 'B');
  assert.deepEqual(insertToken({ value: 'see', start: 3, end: 3 }, '[[att:11111111]]'), { value: 'see [[att:11111111]] ', start: 21, end: 21 });
  assert.equal(insertToken({ value: 'a b', start: 2, end: 2 }, 'T').value, 'a T b');
  assert.equal(removeToken('see T here', 'T'), 'see here');
  assert.equal(removeToken('T and T', 'T'), 'and');
  assert.equal(removeToken('end T', 'T'), 'end');
  assert.equal(removeToken('none', 'T'), 'none');
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

test('attachments: dedupe by digest, merge placements, effective placement follows the text', () => {
  const rec = (sha, placement) => ({ id: sha.slice(0, 8), name: 'f', size: 1, mime: 'a/b', sha256: sha, placement });
  const first = addAttachment([], rec(SHA_A, 'tray'));
  assert.equal(first.reused, false);
  const again = addAttachment(first.list, rec(SHA_A, 'inline'));
  assert.equal(again.reused, true);
  assert.equal(again.list.length, 1);
  assert.equal(again.list[0].placement, 'both');
  assert.equal(addAttachment(again.list, rec(SHA_A, 'both')).list[0].placement, 'both');
  assert.equal(addAttachment(again.list, rec(SHA_B, 'tray')).list.length, 2);
  assert.deepEqual(removeAttachment(again.list, 'aaaaaaaa'), []);

  const inline = rec(SHA_A, 'inline');
  assert.equal(effectivePlacement(inline, 'x [[att:aaaaaaaa]] y'), 'inline');
  assert.equal(effectivePlacement(inline, 'token removed'), 'tray');
  assert.equal(effectivePlacement(rec(SHA_A, 'both'), '[[att:aaaaaaaa]]'), 'both');
  assert.equal(effectivePlacement(rec(SHA_A, 'both'), ''), 'tray');
  assert.equal(effectivePlacement(rec(SHA_A, 'tray'), '[[att:aaaaaaaa]]'), 'both');
  assert.deepEqual(withEffectivePlacement([inline], '').map((a) => a.placement), ['tray']);
});

test('attachments: the 25 MB limit and hashing real bytes', async () => {
  assert.equal(MAX_FILE_BYTES, 25 * 1024 * 1024);
  const { accepted, rejected } = splitBySize([{ size: 10 }, { size: MAX_FILE_BYTES }, { size: MAX_FILE_BYTES + 1 }]);
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 1);
  const file = { name: 'a.txt', size: 3, type: 'text/plain', arrayBuffer: async () => new TextEncoder().encode('abc').buffer };
  const broken = { name: 'b.bin', size: 1, type: '', arrayBuffer: async () => { throw new Error('denied'); } };
  const [ok, bad] = await describeFiles([file, broken]);
  assert.equal(ok.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(ok.id, 'ba7816bf');
  assert.equal(ok.error, null);
  assert.ok(bad.error);
  assert.equal(bad.mime, 'application/octet-stream');
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

const TEMPLATES = [
  { id: 'math-integral', category: 'Mathematics', title: 'Improper Integral', symbol: '∫', latex: '\\int_0^\\infty f(x)\\,dx', description: 'Integral', placeholders: [] },
  { id: 'phys-maxwell-curl', category: 'Physics', title: 'Maxwell-Faraday Induction', symbol: '∇×E', latex: '\\nabla \\times \\mathbf{E}', description: 'Induction', placeholders: [] },
  { id: 'chem-gibbs', category: 'Chemistry', title: 'Gibbs Free Energy', symbol: 'ΔG°', latex: '\\Delta G^\\circ', description: 'Free energy', placeholders: [] },
  { id: 'future-new', category: 'Mathematics', title: 'Brand New', symbol: '?', latex: 'x', description: '', placeholders: [] }
];

test('template search is accent-insensitive and works in both languages', () => {
  assert.deepEqual(filterTemplates(TEMPLATES, { query: 'tich phan' }).map((x) => x.id), ['math-integral']);
  assert.deepEqual(filterTemplates(TEMPLATES, { query: 'Tích phân' }).map((x) => x.id), ['math-integral']);
  assert.deepEqual(filterTemplates(TEMPLATES, { query: 'maxwell' }).map((x) => x.id), ['phys-maxwell-curl']);
  assert.deepEqual(filterTemplates(TEMPLATES, { query: 'hoa hoc' }).map((x) => x.id), ['chem-gibbs']);
  assert.deepEqual(filterTemplates(TEMPLATES, { category: 'Mathematics' }).map((x) => x.id), ['math-integral', 'future-new']);
  assert.deepEqual(filterTemplates(TEMPLATES, { category: 'Physics', query: 'gibbs' }), []);
  assert.deepEqual(categoryCounts(TEMPLATES), { all: 4, Mathematics: 2, Physics: 1, Chemistry: 1 });
  assert.equal(templateTitle(TEMPLATES[0], 'vi'), 'Tích phân suy rộng');
  assert.equal(templateTitle(TEMPLATES[0], 'en'), 'Improper Integral');
  assert.equal(templateTitle(TEMPLATES[3], 'vi'), 'Brand New');
  assert.equal(insertionText(TEMPLATES[0]), '$\\int_0^\\infty f(x)\\,dx$');
});

test('gridStep moves through a grid and leaves it from the top row', () => {
  assert.equal(gridStep(0, 'ArrowRight', 3, 7), 1);
  assert.equal(gridStep(6, 'ArrowRight', 3, 7), 6);
  assert.equal(gridStep(4, 'ArrowDown', 3, 7), 4);
  assert.equal(gridStep(3, 'ArrowDown', 3, 7), 6);
  assert.equal(gridStep(1, 'ArrowUp', 3, 7), null);
  assert.equal(gridStep(4, 'ArrowUp', 3, 7), 1);
  assert.equal(gridStep(2, 'Home', 3, 7), 0);
  assert.equal(gridStep(2, 'End', 3, 7), 6);
  assert.equal(gridStep(0, 'ArrowLeft', 3, 0), null);
});

// ---------------------------------------------------------------------------
// templates of markup (escaping and states)
// ---------------------------------------------------------------------------

const EVIL = '<img src=x onerror=alert(1)>';

function message(id, route, extra = {}) {
  return { id, role: 'user', markdown: `hello ${EVIL}`, attachments: [], createdAt: Date.UTC(2026, 10, 13, 12, 0, 0), route, ...extra };
}

test('thread markup escapes user content and renders each route state', () => {
  const policy = buildPolicy('x');
  const receipt = {
    receiptId: 'rdec-9', reservedTokens: 2048, policyClass: 'zero_data_retention:high', policyHash: 'sha256:abc', promptRedacted: true, secretsExposed: 0, sequenceId: 9,
    scores: [{ candidateId: 'cloud', eligible: false, rejectedReason: 'privacy_boundary_violation' }]
  };
  const chat = {
    messages: [
      message('p', pendingRoute(policy)),
      message('r', { state: 'routed', selectedCandidateId: 'google-gemini-3-1-pro', receipt, status: 'ROUTED_DETERMINISTIC', errorCode: '', policy }),
      message('f', { state: 'fenced', selectedCandidateId: null, receipt, status: 'FENCED_OPERATOR_RECOVERY_REQUIRED', errorCode: '', policy }),
      message('e', { state: 'error', selectedCandidateId: null, receipt: null, status: '', errorCode: 'network', policy }),
      message('i', { state: 'error', selectedCandidateId: null, receipt: null, status: '', errorCode: 'interrupted', policy })
    ],
    draft: { text: '', rev: 0, attachments: [] }
  };
  const out = String(threadHtml({ sessionState: 'ready', sessionId: 's', error: null, chat, bannerHidden: false, stagger: true }));
  assert.equal(out.includes(EVIL), false);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /Chế độ cục bộ/);
  assert.equal((out.match(/Không gửi tới provider — chưa có runtime hội thoại\./g) || []).length, 5);
  assert.match(out, /data-state="pending"[\s\S]*aria-busy|aria-busy="true"[^>]*data-state="pending"/);
  assert.match(out, /google-gemini-3-1-pro/);
  assert.match(out, /rdec-9/);
  assert.match(out, /giữ chỗ 2\.048 token/);
  assert.match(out, /data-action="view-receipt" data-id="r"/);
  assert.match(out, /status--warn/);
  assert.match(out, /privacy_boundary_violation/);
  assert.match(out, /data-action="retry-route" data-id="e"/);
  assert.match(out, /data-action="retry-route" data-id="i"/);
  assert.match(out, /Không kết nối được omnia-studio\.exe/);
  assert.match(out, /class="msg enter" data-key="m-p" style="--i: 0"/);
  const later = String(threadHtml({ sessionState: 'ready', sessionId: 's', error: null, chat, bannerHidden: true, stagger: false }));
  assert.equal(later.includes('Chế độ cục bộ'), false);
  assert.equal(later.includes('--i:'), false);
});

test('thread states: loading, empty, unknown, no sessions', () => {
  const base = { sessionId: 'zzz', error: null, chat: emptyChat(), bannerHidden: false, stagger: false };
  assert.match(String(threadHtml({ ...base, sessionState: 'loading' })), /aria-busy="true"/);
  assert.match(String(threadHtml({ ...base, sessionState: 'ready' })), /Phiên này chưa có tin nhắn/);
  const unknown = String(threadHtml({ ...base, sessionState: 'unknown', sessionId: EVIL }));
  assert.match(unknown, /Không tìm thấy phiên/);
  assert.equal(unknown.includes(EVIL), false);
  assert.match(unknown, /href="#\/chat"/);
  const none = String(threadHtml({ ...base, sessionState: 'empty' }));
  assert.match(none, /data-action="new-session"/);
});

test('inspector shows the receipt, steer queue and draft attachments', () => {
  const policy = buildPolicy('x');
  const receipt = {
    receiptId: 'rdec-9', reservedTokens: 2048, policyClass: 'zdr:high', policyHash: 'sha256:abc', promptRedacted: true, secretsExposed: 0, sequenceId: 9, estimatedCostMicrounits: null,
    scores: [
      { candidateId: 'win', eligible: true, capabilityScore: 40, privacyScore: 20, quotaScore: 18, latencyScore: 19, reliabilityScore: 30, totalScore: 100 },
      { candidateId: 'lose', eligible: false, rejectedReason: 'quota_stale' }
    ]
  };
  const view = {
    chat: {
      messages: [message('r', { state: 'routed', selectedCandidateId: 'win', receipt, status: '', errorCode: '', policy })],
      draft: { text: `see [[att:${SHA_A.slice(0, 8)}]]`, rev: 3, attachments: [{ id: SHA_A.slice(0, 8), name: EVIL, size: 4820, mime: 'application/json', sha256: SHA_A, placement: 'tray' }] }
    },
    steer: { status: 'ready', tokenBudget: null, error: null, updatedAt: 1, items: [{ id: 's1', seq: 1, text: EVIL, mode: 'ADDITIVE_INTAKE', status: 'completed' }, { id: 's2', seq: 2, text: 'two', mode: 'ADDITIVE_INTAKE', status: 'in_progress' }] },
    steerForm: { mode: 'additive', busy: false, error: '' },
    sections: { receipt: true, steer: true, atts: true },
    receiptFocus: null
  };
  const out = String(inspectorHtml(view));
  assert.equal(out.includes(EVIL), false);
  assert.match(out, /rdec-9/);
  assert.match(out, /class="stackbar" role="img"/);
  assert.match(out, /100 \/ 100/);
  assert.match(out, /quota_stale/);
  assert.match(out, /href="#\/routing"/);
  assert.match(out, /token_budget = null/);
  assert.ok(out.indexOf('#2') < out.indexOf('#1'), 'newest steer item first');
  assert.match(out, /Hoàn tất/);
  assert.match(out, /Đang xử lý/);
  assert.match(out, new RegExp(SHA_A));
  assert.match(out, /data-action="copy-sha"/);
  assert.match(out, /Nội dòng \+ Khay|Nội dòng/);
  assert.match(out, /<details class="disclosure" data-section="atts" open>/);
  const closed = String(inspectorHtml({ ...view, sections: { receipt: false, steer: false, atts: false } }));
  assert.equal(/<details[^>]* open/.test(closed), false);
  const empty = String(inspectorHtml({ ...view, chat: { messages: [], draft: { text: '', rev: 0, attachments: [] } }, steer: { status: 'error', items: [], error: { code: 'network' }, tokenBudget: null, updatedAt: 0 } }));
  assert.match(empty, /Chưa có receipt cho phiên này/);
  assert.match(empty, /Không tải được hàng đợi steer/);
});

test('composer markup: toolbar, popover cards render math (never raw TeX), tray, footer rev', () => {
  const view = {
    draft: { text: 'a [[att:aaaaaaaa]]', rev: 14, attachments: [{ id: 'aaaaaaaa', name: 'r.json', size: 4820, mime: 'application/json', sha256: SHA_A, placement: 'tray' }] },
    previewOn: true,
    previewHtml: html`<p>preview</p>`,
    popover: { open: true, category: 'all', query: '', index: 0 },
    templates: { status: 'ready', items: TEMPLATES, error: null },
    drop: null,
    saveState: 'saved',
    canSend: true
  };
  const out = String(composerHtml(view));
  assert.match(out, /data-editor/);
  assert.match(out, /role="toolbar"/);
  assert.match(out, /aria-label="In đậm \(Ctrl\+B trong ô soạn\)"/);
  assert.match(out, /aria-expanded="true"/);
  assert.match(out, /aria-pressed="true"/);
  assert.match(out, /class="tpl-card enter" type="button" data-key="tpl-math-integral"/);
  assert.match(out, /<span class="mop">/);
  assert.equal(out.includes('\\int'), false, 'raw TeX must not be shown on template cards');
  assert.equal(out.includes('\\nabla'), false);
  assert.match(out, /Tích phân suy rộng/);
  assert.match(out, /Bản nháp đã lưu · rev 14/);
  assert.match(out, /Nội dòng \+ Khay/);
  assert.match(out, /data-role="preview"/);
  assert.match(out, /type="file" multiple hidden/);
  assert.equal(/<button[^>]*data-action="send"[^>]*disabled/.test(out), false);

  const dirty = String(composerHtml({ ...view, saveState: 'dirty', canSend: false, popover: { open: false, category: 'all', query: '' }, previewOn: false, drop: 'input' }));
  assert.match(dirty, /Đang lưu bản nháp/);
  assert.match(dirty, /data-action="send"[^>]*disabled/);
  assert.equal(dirty.includes('chat-popover'), false);
  assert.equal(dirty.includes('data-role="preview"'), false);
  assert.match(dirty, /Thả để chèn tại con trỏ/);

  const filtered = String(composerHtml({ ...view, popover: { open: true, category: 'Physics', query: 'zzz-no-match', index: 0 } }));
  assert.match(filtered, /Không có mẫu khớp “zzz-no-match”/);
  const failed = String(composerHtml({ ...view, templates: { status: 'error', items: [], error: { code: 'network' } } }));
  assert.match(failed, /Không tải được mẫu công thức/);
  assert.match(failed, /data-action="tpl-reload"/);
});

test('english strings resolve through t()', () => {
  assert.equal(t('chat.noteLocal'), 'Không gửi tới provider — chưa có runtime hội thoại.');
  assert.equal(t('chat.tplCount', { count: 1 }), '1 mẫu');
  assert.equal(t('chat.tplCount', { count: 4 }), '4 mẫu');
});

// ---------------------------------------------------------------------------
// AUD-24: explicit run cancellation, AbortController & clean interrupted card
// ---------------------------------------------------------------------------

test('AUD-24: aborted route produces cancelled state (never error/routed) and survives reload', () => {
  const policy = buildPolicy('cancel me');
  const aborted = routeFromError({ code: 'aborted' }, policy);
  assert.equal(aborted.state, 'cancelled');
  assert.equal(aborted.errorCode, 'aborted');
  assert.equal(aborted.status, 'CANCELLED_BY_USER');

  const stored = sanitizeChat({
    v: 1,
    messages: [{ id: 'm-cancel', role: 'user', markdown: 'x', createdAt: 100, attachments: [], route: cancelledRoute(policy, { chatStopped: true, routerCancelled: true }) }],
    draft: { text: '', rev: 0, attachments: [] }
  });
  assert.equal(stored.messages[0].route.state, 'cancelled');
  assert.equal(stored.messages[0].route.cancelAck.routerCancelled, true);
});

test('AUD-24: thread renders live Cancel button while pending and clean cancelled card with Retry', () => {
  const policy = buildPolicy('x');
  const chat = {
    messages: [
      message('p1', pendingRoute(policy)),
      message('c1', cancelledRoute(policy, { chatStopped: true, routerCancelled: true }))
    ],
    draft: { text: '', rev: 0, attachments: [] }
  };
  const out = String(threadHtml({ sessionState: 'ready', sessionId: 's1', error: null, chat, bannerHidden: true, stagger: false }));
  assert.match(out, /data-action="cancel-route" data-id="p1"/);
  assert.match(out, /data-state="cancelled"/);
  assert.match(out, /Đã huỷ yêu cầu định tuyến theo lệnh của bạn/);
  assert.match(out, /Đã xác nhận huỷ trên server/);
  assert.match(out, /data-action="retry-route" data-id="c1"/);

  const insp = String(inspectorHtml({
    chat: { messages: [chat.messages[1]], draft: { text: '', rev: 0, attachments: [] } },
    steer: { status: 'ready', tokenBudget: null, error: null, updatedAt: 1, items: [] },
    steerForm: { mode: 'additive', busy: false, error: '' },
    sections: { receipt: true, steer: false, atts: false },
    receiptFocus: null
  }));
  assert.match(insp, /Đã huỷ/);
  assert.match(insp, /Đã huỷ yêu cầu định tuyến theo lệnh của bạn/);
});

test('AUD-24: createRunTracker aborts AbortController, calls /api/chat/stop + /api/router/cancel, and allows retry', async () => {
  const stopCalls = [];
  const cancelCalls = [];
  const updates = [];
  let decideAttempt = 0;
  let capturedSignal = null;

  const client = {
    router: {
      decide(policy, { signal } = {}) {
        decideAttempt += 1;
        capturedSignal = signal;
        if (decideAttempt === 1) {
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject({ code: 'aborted' }), { once: true });
          });
        }
        return Promise.resolve({
          ok: true,
          selectedCandidateId: 'omnia-primary',
          status: 'ROUTED_DETERMINISTIC',
          receipt: { receiptId: 'rdec-retry-1', reservedTokens: 1024 }
        });
      },
      async cancel(body) {
        cancelCalls.push(body);
        return { ok: true, cancelled: true };
      }
    },
    chat: {
      async stop(body) {
        stopCalls.push(body);
        return { ok: true, aborted: true };
      }
    }
  };

  const tracker = createRunTracker({ client });
  const policy = { ...buildPolicy('solve x'), idempotencyKey: 'chat:sess-1:msg-1' };
  const runPromise = tracker.runDecide('sess-1', 'msg-1', policy, {
    onUpdate: (sid, mid, route) => updates.push({ sid, mid, route })
  });

  assert.equal(tracker.isInflight('sess-1', 'msg-1'), true);
  assert.equal(capturedSignal.aborted, false);

  const finalCancelled = await tracker.cancelRoute('sess-1', 'msg-1', {
    onUpdate: (sid, mid, route) => updates.push({ sid, mid, route })
  });
  await runPromise;

  assert.equal(capturedSignal.aborted, true);
  assert.equal(tracker.isInflight('sess-1', 'msg-1'), false);
  assert.equal(stopCalls.length, 1);
  assert.equal(cancelCalls.length, 1);
  assert.equal(stopCalls[0].sessionId, 'sess-1');
  assert.equal(stopCalls[0].messageId, 'msg-1');
  assert.equal(cancelCalls[0].idempotencyKey, 'chat:sess-1:msg-1');
  assert.equal(finalCancelled.state, 'cancelled');
  assert.deepEqual(finalCancelled.cancelAck, { pendingReconcile: false, chatStopped: true, routerCancelled: true });
  assert.equal(updates.every((u) => u.route.state === 'cancelled'), true);

  // Retry after cancellation succeeds cleanly and transitions to routed.
  const retried = await tracker.runDecide('sess-1', 'msg-1', policy, {
    onUpdate: (sid, mid, route) => updates.push({ sid, mid, route })
  });
  assert.equal(retried.state, 'routed');
  assert.equal(retried.selectedCandidateId, 'omnia-primary');
});
