// Unit tests for the pure rendering libraries (ui/app/lib). Run: node --test ui/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Hex, sha256Bytes, digestBytes } from '../app/lib/sha256.js';
import { mathToString, renderMath } from '../app/lib/latex.js';
import { highlight, normalizeLang } from '../app/lib/highlight.js';
import { markdownToString, renderMarkdown, hasLatex, findAttachmentIds, attachmentToken } from '../app/lib/markdown.js';
import { isSafe } from '../app/core/dom.js';

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

test('sha256 matches the standard vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('Tiếng Việt'), createHash('sha256').update('Tiếng Việt').digest('hex'));
});

test('sha256 agrees with node:crypto around the block boundaries', () => {
  for (const size of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000, 70000]) {
    const bytes = new Uint8Array(size).map((_, i) => (i * 31 + size) & 0xff);
    assert.equal(sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'), `size ${size}`);
  }
});

test('sha256 works on a view into a larger buffer and digestBytes resolves the same hex', async () => {
  const backing = new Uint8Array(300).map((_, i) => i & 0xff);
  const view = backing.subarray(7, 211);
  const expected = createHash('sha256').update(view).digest('hex');
  assert.equal(sha256Bytes(view), expected);
  assert.equal(await digestBytes(view), expected);
  assert.equal(await digestBytes(view.slice().buffer), expected);
});

// ---------------------------------------------------------------------------
// latex
// ---------------------------------------------------------------------------

test('latex renders fractions, scripts and Greek letters with the shared classes', () => {
  const out = mathToString('\\frac{a}{b^2} + \\alpha_i');
  assert.match(out, /^<span class="math" role="math">/);
  assert.match(out, /<span class="mfrac"><span class="mfrac__num">a<\/span><span class="mfrac__den">b<sup>2<\/sup><\/span><\/span>/);
  assert.match(out, /α<sub>i<\/sub>/);
});

test('latex display mode uses math-display', () => {
  assert.match(mathToString('x', true), /^<span class="math-display" role="math">/);
  assert.ok(isSafe(renderMath('x')));
});

test('latex renders big operators, roots, vectors and matrices', () => {
  assert.match(mathToString('\\sum_{i=1}^{n} x_i'), /<span class="mop"><span class="mop__lim">n<\/span><span class="mop__sym">∑<\/span><span class="mop__lim">i = 1<\/span><\/span>/);
  assert.match(mathToString('\\sqrt[3]{a-b}'), /<sup>3<\/sup><span class="msqrt">√<span class="msqrt__rad">a − b<\/span><\/span>/);
  assert.match(mathToString('\\nabla \\times \\mathbf{E}'), /∇ × <span class="mvec">E<\/span>/);
  const matrix = mathToString('\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}');
  assert.match(matrix, /<table class="mmatrix"/);
  assert.equal((matrix.match(/<tr>/g) || []).length, 2);
  assert.equal((matrix.match(/<td>/g) || []).length, 4);
});

test('latex handles every server template without leaking raw TeX', () => {
  const latex = [
    '\\sum_{i=1}^{n} x_i', '\\int_0^\\infty f(x)\\,dx', '\\frac{\\partial f}{\\partial x}', '\\nabla \\cdot \\mathbf{F}',
    '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', '\\lim_{n \\to \\infty} a_n', 'i\\hbar \\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi',
    '\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}', '\\Delta E = h\\nu = \\frac{hc}{\\lambda}',
    '\\langle \\psi \\mid \\hat{O} \\mid \\phi \\rangle', '\\Phi_B = \\iint_{S} \\mathbf{B} \\cdot d\\mathbf{A}',
    'a\\text{A} + b\\text{B} \\rightleftharpoons c\\text{C} + d\\text{D}', '\\text{Reactants} \\xrightarrow[\\text{Pt}]{\\Delta} \\text{Products}',
    '\\text{p}K_a = -\\log_{10} K_a', '\\Delta G^\\circ = \\Delta H^\\circ - T\\Delta S^\\circ'
  ];
  for (const tex of latex) {
    const out = mathToString(tex);
    assert.equal(/\\[a-zA-Z]/.test(out), false, `raw command left in: ${tex} → ${out}`);
  }
  assert.match(mathToString('\\Delta G^\\circ'), /<sup>°<\/sup>/);
});

test('latex escapes hostile input and shows unknown commands literally', () => {
  const out = mathToString('<img src=x onerror=alert(1)> \\unknowncmd{x} "q"');
  assert.equal(out.includes('<img'), false);
  assert.match(out, /&lt;/);
  assert.match(out, /\\unknowncmd/);
  assert.equal(out.includes('onerror=alert(1)>'), false);
});

test('latex survives deep nesting, stray braces and unterminated groups', () => {
  assert.doesNotThrow(() => mathToString('{'.repeat(200) + 'x' + '}'.repeat(200)));
  assert.doesNotThrow(() => mathToString('\\frac{a'));
  assert.doesNotThrow(() => mathToString('\\begin{pmatrix} a & b'));
  assert.doesNotThrow(() => mathToString('}}{{^_\\'));
  assert.ok(mathToString('x'.repeat(5000)).length > 5000);
});

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

test('highlight wraps tokens and escapes everything', () => {
  const out = String(highlight('struct Foo { int x = 42; } // <b>c</b>\n#include <x>', 'cpp'));
  assert.match(out, /<span class="tok-kw">struct<\/span>/);
  assert.match(out, /<span class="tok-type">Foo<\/span>/);
  assert.match(out, /<span class="tok-num">42<\/span>/);
  assert.match(out, /<span class="tok-cmt">\/\/ &lt;b&gt;c&lt;\/b&gt;<\/span>/);
  assert.match(out, /<span class="tok-pre">#include<\/span>/);
  assert.equal(out.includes('<b>'), false);
});

test('highlight strings, functions and unknown languages', () => {
  assert.match(String(highlight('call("a<b>", 1)', 'js')), /<span class="tok-fn">call<\/span>\(<span class="tok-str">&quot;a&lt;b&gt;&quot;<\/span>/);
  assert.equal(String(highlight('<script>x</script>', 'klingon')), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(normalizeLang('C++'), 'cpp');
  assert.equal(normalizeLang('PowerShell'), 'ps');
  assert.equal(normalizeLang(''), 'plain');
});

test('highlight leaves unterminated strings and comments inside their token', () => {
  assert.doesNotThrow(() => highlight('"abc\nnext', 'cpp'));
  assert.match(String(highlight('/* open', 'cpp')), /tok-cmt/);
});

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

test('markdown escapes raw HTML and never produces anchors, images or inline handlers', () => {
  const out = markdownToString('<script>alert(1)</script> [x](javascript:alert(1)) ![i](http://a/b.png) <a href="x" onclick="y">z</a>');
  assert.equal(out.includes('<script'), false);
  assert.equal(out.includes('<a '), false);
  assert.equal(out.includes('<img'), false);
  assert.equal(/onclick=/.test(out.replace(/&quot;/g, '"')) && out.includes('<a'), false);
  assert.match(out, /<span class="mono muted text-xs">\(javascript:alert\(1\)/);
  assert.match(out, /\(http:\/\/a\/b\.png\)/);
});

test('markdown inline formatting', () => {
  const out = markdownToString('**b** *i* _j_ __u__ ~~s~~ `c<d>` snake_case_name');
  assert.match(out, /<strong>b<\/strong>/);
  assert.match(out, /<em>i<\/em>/);
  assert.match(out, /<em>j<\/em>/);
  assert.match(out, /<u>u<\/u>/);
  assert.match(out, /<s>s<\/s>/);
  assert.match(out, /<code>c&lt;d&gt;<\/code>/);
  assert.match(out, /snake_case_name/);
});

test('markdown headings, lists, tasks, quotes, rules', () => {
  const out = markdownToString('# H1\n\n- a\n  - b\n- [x] done\n- [ ] todo\n\n3. c\n4. d\n\n> q1\n> q2\n\n---');
  assert.match(out, /<h1>H1<\/h1>/);
  assert.match(out, /<ul><li>a<ul><li>b<\/li><\/ul><\/li>/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled checked/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled aria-label/);
  assert.match(out, /<ol start="3"><li>c<\/li><li>d<\/li><\/ol>/);
  assert.match(out, /<blockquote><p>q1<br>q2<\/p><\/blockquote>/);
  assert.match(out, /<hr>/);
});

test('markdown tables with alignment and escaped pipes', () => {
  const out = markdownToString('| A | B |\n|:--|--:|\n| 1 | `x\\|y` |\n| <i> | 3 |');
  assert.match(out, /<th style="text-align: left">A<\/th><th style="text-align: right">B<\/th>/);
  assert.match(out, /<td style="text-align: right"><code>x\|y<\/code><\/td>/);
  assert.match(out, /&lt;i&gt;/);
});

test('markdown fenced code gets the code-block chrome, language label, copy button and tokens', () => {
  const out = markdownToString('```cpp session.hpp\nint x = 1; // <hi>\n```\n\n```\nplain <b>\n```', { labels: { copy: 'Sao chép', plain: 'văn bản' } });
  assert.match(out, /<div class="code-block"><div class="code-block__bar"><span class="mono">cpp · session\.hpp<\/span>/);
  assert.match(out, /data-action="copy-code"/);
  assert.match(out, /Sao chép<\/button>/);
  assert.match(out, /<pre><code><span class="tok-kw">int<\/span> x = <span class="tok-num">1<\/span>; <span class="tok-cmt">\/\/ &lt;hi&gt;<\/span><\/code><\/pre>/);
  assert.match(out, /<span class="mono">văn bản<\/span>/);
  assert.match(out, /plain &lt;b&gt;/);
});

test('markdown keeps an unterminated fence as code instead of dropping the text', () => {
  const out = markdownToString('```js\nconst a = 1;');
  assert.match(out, /tok-kw">const/);
});

test('markdown math: inline, display, currency and escaped dollars', () => {
  const out = markdownToString('Energy $E=mc^2$ costs $5 and $6 and \\$7.\n\n$$\n\\frac{a}{b}\n$$\n\n$$x^2$$');
  assert.match(out, /<span class="math" role="math">E = mc<sup>2<\/sup><\/span>/);
  assert.match(out, /costs \$5 and \$6 and \$7\./);
  assert.equal((out.match(/class="math-display"/g) || []).length, 2);
  assert.match(out, /mfrac/);
});

test('markdown puts a paragraph with a matrix in a div so the table is not hoisted', () => {
  const out = markdownToString('see $\\begin{bmatrix} a \\\\ b \\end{bmatrix}$ here');
  assert.match(out, /^<div>see <span class="math"/);
});

test('markdown attachment chips use metadata when known and the id otherwise', () => {
  const sha = '9f2c41ab' + '0'.repeat(56);
  const out = markdownToString(`file ${attachmentToken(sha)} and [[att:deadbeef]]`, { attachments: [{ name: 'a<b>.json', size: 4820, sha256: sha }] });
  assert.match(out, /<span class="att">/);
  assert.match(out, /a&lt;b&gt;\.json/);
  assert.match(out, /4,7 KB · 9f2c41ab/);
  assert.match(out, /att:deadbeef/);
  assert.deepEqual(findAttachmentIds('x [[att:9f2c41ab]] y [[att:nothex]] [[att:00ff00ff]]'), ['9f2c41ab', '00ff00ff']);
});

test('markdown renderMarkdown returns SafeHtml and tolerates empty or odd input', () => {
  assert.ok(isSafe(renderMarkdown('x')));
  assert.equal(markdownToString(''), '');
  assert.equal(markdownToString(null), '');
  assert.doesNotThrow(() => markdownToString('| a |\n|---|\n'.repeat(3) + '*'.repeat(50) + '[' + '_'.repeat(30)));
  assert.doesNotThrow(() => markdownToString('> '.repeat(40) + 'deep'));
});

test('hasLatex detects math outside code only', () => {
  assert.equal(hasLatex('plain text'), false);
  assert.equal(hasLatex('costs $5 and $6'), false);
  assert.equal(hasLatex('x $a^2$ y'), true);
  assert.equal(hasLatex('$$ \\int f $$'), true);
  assert.equal(hasLatex('`$a$`'), false);
  assert.equal(hasLatex('```\n$a$\n```'), false);
  assert.equal(hasLatex('\\$a\\$'), false);
});
