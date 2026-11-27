// Omnia Studio UI — LaTeX subset → typographic HTML (no fonts, no CDN, no DOM).
//
//   renderMath('\\frac{a}{b}')                  → SafeHtml <span class="math" role="math">…
//   renderMath('E=mc^2', { display: true })     → SafeHtml <span class="math-display" role="math">…
//   mathToString(tex, display)                  → plain string (for tests / composition)
//
// Emits only the classes defined in components.css §5: .math .math-display .mfrac(__num|__den)
// .mop(__sym|__lim) .msqrt(__rad) .mvec .mmatrix, plus <sup>/<sub>. Every character that
// comes from the input is escaped; unknown commands are shown literally (never dropped).

import { escapeHtml, raw } from '../core/dom.js';

const MAX_INPUT = 4000;
const MAX_DEPTH = 32;
const THIN = ' ';
const REL_SPACE = ' ';

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  hbar: 'ℏ', ell: 'ℓ', nabla: '∇', partial: '∂', infty: '∞', emptyset: '∅', angle: '∠', prime: '′', degree: '°',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
  cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', mid: '∣', parallel: '∥', perp: '⊥',
  dagger: '†', ddagger: '‡', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', wedge: '∧', vee: '∨', cap: '∩', cup: '∪', setminus: '∖',
  sqrt: '√'
};

// Relations and arrows get a little air on both sides.
const RELATIONS = {
  neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥', ll: '≪', gg: '≫', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃',
  cong: '≅', propto: '∝', in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  implies: '⟹', iff: '⟺', mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵', rightleftharpoons: '⇌', leftrightharpoons: '⇋',
  uparrow: '↑', downarrow: '↓'
};

const BIG_SYMBOL_OPS = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁' };
const TEXT_LIMIT_OPS = new Set(['lim', 'max', 'min', 'sup', 'inf', 'limsup', 'liminf', 'argmax', 'argmin']);
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'log', 'ln', 'lg', 'exp', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'Pr', 'hom', 'tr', 'rank']);
const DOUBLE_STRUCK = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', H: 'ℍ', P: 'ℙ', E: '𝔼' };
const COMBINING = { hat: '̂', widehat: '̂', bar: '̄', overline: '̅', tilde: '̃', widetilde: '̃', dot: '̇', ddot: '̈', check: '̌', breve: '̆', acute: '́', grave: '̀' };
const PUNCT_ESCAPES = { '{': '{', '}': '}', '%': '%', $: '$', '&': '&', _: '_', '#': '#', '|': '‖', ',': THIN, ';': ' ', ':': ' ', ' ': ' ', '!': '', '\\': ' ' };

function readCommandName(ctx) {
  // ctx.i points just after the backslash.
  const { s } = ctx;
  if (ctx.i >= s.length) return '';
  if (/[A-Za-z]/.test(s[ctx.i])) {
    const start = ctx.i;
    while (ctx.i < s.length && /[A-Za-z]/.test(s[ctx.i])) ctx.i += 1;
    return s.slice(start, ctx.i);
  }
  const one = s[ctx.i];
  ctx.i += 1;
  return one;
}

function skipSpaces(ctx) {
  while (ctx.i < ctx.s.length && /\s/.test(ctx.s[ctx.i])) ctx.i += 1;
}

/** Reads a balanced {…} group verbatim (without the outer braces). ctx.i must be at '{'. */
function readRawGroup(ctx) {
  const { s } = ctx;
  let depth = 0;
  const start = ctx.i + 1;
  for (let k = ctx.i; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === '\\') {
      k += 1;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        ctx.i = k + 1;
        return s.slice(start, k);
      }
    }
  }
  ctx.i = s.length;
  return s.slice(start);
}

function readBracket(ctx) {
  skipSpaces(ctx);
  if (ctx.s[ctx.i] !== '[') return null;
  const end = ctx.s.indexOf(']', ctx.i + 1);
  if (end < 0) return null;
  const value = ctx.s.slice(ctx.i + 1, end);
  ctx.i = end + 1;
  return value;
}

function sub(ctx, source) {
  return parseSequence({ s: source, i: 0, depth: ctx.depth + 1, func: false });
}

function parseArg(ctx) {
  skipSpaces(ctx);
  if (ctx.i >= ctx.s.length) return '';
  if (ctx.s[ctx.i] === '{') return sub(ctx, readRawGroup(ctx));
  return parseAtom(ctx).html;
}

function splitTop(source, separator) {
  // Splits on `separator` ("&" or "\\\\") outside braces and nested \begin…\end.
  const parts = [];
  let depth = 0;
  let env = 0;
  let last = 0;
  for (let k = 0; k < source.length; k += 1) {
    const ch = source[k];
    if (ch === '\\') {
      if (source.startsWith('\\begin', k)) env += 1;
      else if (source.startsWith('\\end', k)) env = Math.max(0, env - 1);
      if (separator === '\\\\' && source[k + 1] === '\\' && depth === 0 && env === 0) {
        parts.push(source.slice(last, k));
        k += 1;
        last = k + 1;
        continue;
      }
      k += 1;
    } else if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (separator === '&' && ch === '&' && depth === 0 && env === 0) {
      parts.push(source.slice(last, k));
      last = k + 1;
    }
  }
  parts.push(source.slice(last));
  return parts;
}

function renderEnvironment(ctx, name) {
  const { s } = ctx;
  const endTag = `\\end{${name}}`;
  if (name === 'array') {
    skipSpaces(ctx);
    if (s[ctx.i] === '{') readRawGroup(ctx);
  }
  const close = s.indexOf(endTag, ctx.i);
  const body = close < 0 ? s.slice(ctx.i) : s.slice(ctx.i, close);
  ctx.i = close < 0 ? s.length : close + endTag.length;
  const rows = splitTop(body, '\\\\').map((row) => row.trim()).filter((row, index, all) => row !== '' || index < all.length - 1);
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  const cells = rows.map((row) => splitTop(row, '&').map((cell) => `<td>${sub(ctx, cell.trim())}</td>`).join(''));
  const table = `<table class="mmatrix" role="presentation"><tbody>${cells.map((row) => `<tr>${row}</tr>`).join('')}</tbody></table>`;
  return name === 'cases' ? `<span>{</span>${table}` : table;
}

function limitsOp(ctx, symbolHtml, isText) {
  let lower = null;
  let upper = null;
  for (;;) {
    skipSpaces(ctx);
    const ch = ctx.s[ctx.i];
    if (ch === '_' && lower === null) {
      ctx.i += 1;
      lower = parseArg(ctx);
    } else if (ch === '^' && upper === null) {
      ctx.i += 1;
      upper = parseArg(ctx);
    } else break;
  }
  if (lower === null && upper === null) {
    return isText ? `<span>${symbolHtml}</span>${THIN}` : `<span class="mop"><span class="mop__sym">${symbolHtml}</span></span>`;
  }
  const symbol = `<span class="mop__sym"${isText ? ' style="font-size: 1em"' : ''}>${symbolHtml}</span>`;
  return `<span class="mop">${upper !== null ? `<span class="mop__lim">${upper}</span>` : ''}${symbol}${lower !== null ? `<span class="mop__lim">${lower}</span>` : ''}</span>`;
}

function command(ctx, name) {
  const result = { html: '', op: false, func: false };
  switch (name) {
    case 'frac':
    case 'dfrac':
    case 'tfrac': {
      const num = parseArg(ctx);
      const den = parseArg(ctx);
      result.html = `<span class="mfrac"><span class="mfrac__num">${num}</span><span class="mfrac__den">${den}</span></span>`;
      return result;
    }
    case 'sqrt': {
      const index = readBracket(ctx);
      const body = parseArg(ctx);
      result.html = `${index !== null ? `<sup>${sub(ctx, index)}</sup>` : ''}<span class="msqrt">√<span class="msqrt__rad">${body}</span></span>`;
      return result;
    }
    case 'mathbf':
    case 'boldsymbol':
    case 'bm':
    case 'textbf':
      result.html = `<span class="mvec">${parseArg(ctx)}</span>`;
      return result;
    case 'vec':
      result.html = `<span class="mvec">${parseArg(ctx)}⃗</span>`;
      return result;
    case 'mathrm':
    case 'mathit':
    case 'mathsf':
    case 'mathcal':
    case 'mathscr':
    case 'operatorname':
    case 'displaystyle':
    case 'textstyle':
      result.html = name === 'displaystyle' || name === 'textstyle' ? '' : `<span>${parseArg(ctx)}</span>`;
      return result;
    case 'mathbb': {
      const letter = parseArg(ctx).replace(/<[^>]*>/g, '');
      result.html = DOUBLE_STRUCK[letter] || letter;
      return result;
    }
    case 'text':
    case 'textrm':
    case 'textit':
    case 'mbox': {
      skipSpaces(ctx);
      const text = ctx.s[ctx.i] === '{' ? readRawGroup(ctx) : ctx.s[ctx.i++] || '';
      result.html = `<span>${escapeHtml(text)}</span>`;
      return result;
    }
    case 'left':
    case 'right':
      if (ctx.s[ctx.i] === '.') ctx.i += 1;
      return result;
    case 'big':
    case 'Big':
    case 'bigg':
    case 'Bigg':
    case 'limits':
    case 'nolimits':
    case 'mathop':
      return result;
    case 'begin': {
      skipSpaces(ctx);
      const env = ctx.s[ctx.i] === '{' ? readRawGroup(ctx) : '';
      result.html = renderEnvironment(ctx, env);
      return result;
    }
    case 'end':
      skipSpaces(ctx);
      if (ctx.s[ctx.i] === '{') readRawGroup(ctx);
      return result;
    case 'xrightarrow':
    case 'xleftarrow':
    case 'xlongequal': {
      const below = readBracket(ctx);
      const above = parseArg(ctx);
      const arrow = name === 'xleftarrow' ? '⟵' : name === 'xlongequal' ? '＝' : '⟶';
      result.html = `<span class="mop"><span class="mop__lim">${above}</span><span class="mop__sym" style="font-size: 1em">${arrow}</span>${below !== null ? `<span class="mop__lim">${sub(ctx, below)}</span>` : ''}</span>`;
      result.op = true;
      return result;
    }
    case 'quad':
      result.html = '  ';
      return result;
    case 'qquad':
      result.html = '    ';
      return result;
    default:
  }

  if (Object.prototype.hasOwnProperty.call(COMBINING, name)) {
    result.html = `${parseArg(ctx)}${COMBINING[name]}`;
    return result;
  }
  if (name === 'underline') {
    result.html = `<span style="text-decoration: underline">${parseArg(ctx)}</span>`;
    return result;
  }
  if (Object.prototype.hasOwnProperty.call(BIG_SYMBOL_OPS, name)) {
    result.html = limitsOp(ctx, BIG_SYMBOL_OPS[name], false);
    return result;
  }
  if (TEXT_LIMIT_OPS.has(name)) {
    result.html = limitsOp(ctx, escapeHtml(name), true);
    return result;
  }
  if (FUNCTIONS.has(name)) {
    result.html = `<span>${escapeHtml(name)}</span>`;
    result.func = true;
    return result;
  }
  if (Object.prototype.hasOwnProperty.call(RELATIONS, name)) {
    result.html = `${REL_SPACE}${RELATIONS[name]}${REL_SPACE}`;
    result.op = true;
    return result;
  }
  if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
    result.html = escapeHtml(SYMBOLS[name]);
    result.op = ['times', 'cdot', 'div', 'pm', 'mp', 'ast', 'oplus', 'otimes', 'cap', 'cup', 'land', 'lor', 'wedge', 'vee', 'setminus'].includes(name);
    if (result.op) result.html = `${REL_SPACE}${result.html}${REL_SPACE}`;
    return result;
  }
  if (name.length === 1 && Object.prototype.hasOwnProperty.call(PUNCT_ESCAPES, name)) {
    result.html = escapeHtml(PUNCT_ESCAPES[name]);
    return result;
  }
  result.html = escapeHtml(`\\${name}`); // unknown command: show it, never swallow it
  return result;
}

/** Parses one atom (command, group or single character). Never returns without consuming input. */
function parseAtom(ctx) {
  const { s } = ctx;
  const ch = s[ctx.i];
  if (ch === '\\') {
    ctx.i += 1;
    return command(ctx, readCommandName(ctx));
  }
  if (ch === '{') return { html: sub(ctx, readRawGroup(ctx)), op: false, func: false };
  ctx.i += 1;
  switch (ch) {
    case '-':
      return { html: '−', op: true, minus: true, func: false };
    case '=':
    case '<':
    case '>':
      return { html: `${REL_SPACE}${escapeHtml(ch)}${REL_SPACE}`, op: true, func: false };
    case '+':
      return { html: `${REL_SPACE}+${REL_SPACE}`, op: true, plus: true, func: false };
    case "'":
      return { html: '′', op: false, func: false };
    case '~':
      return { html: ' ', op: false, func: false };
    case '(':
    case '[':
    case ',':
      return { html: escapeHtml(ch), op: true, open: true, func: false };
    default:
      return { html: escapeHtml(ch), op: false, func: false };
  }
}

function parseSequence(ctx) {
  let out = '';
  let prevOp = true; // true at the start: a leading "-" is unary
  while (ctx.i < ctx.s.length) {
    skipSpaces(ctx);
    if (ctx.i >= ctx.s.length) break;
    const ch = ctx.s[ctx.i];
    if (ch === '}') {
      ctx.i += 1; // stray closing brace
      continue;
    }
    if (ctx.depth > MAX_DEPTH) {
      out += escapeHtml(ctx.s.slice(ctx.i));
      ctx.i = ctx.s.length;
      break;
    }
    let atom;
    if (ch === '^' || ch === '_') atom = { html: '', op: false, func: false };
    else atom = parseAtom(ctx);

    let html = atom.html;
    if (atom.minus && !prevOp) html = `${REL_SPACE}−${REL_SPACE}`;
    if (atom.plus && prevOp) html = '+';

    let sup = null;
    let low = null;
    for (;;) {
      skipSpaces(ctx);
      const mark = ctx.s[ctx.i];
      if (mark === '^' && sup === null) {
        ctx.i += 1;
        sup = parseArg(ctx);
      } else if (mark === '_' && low === null) {
        ctx.i += 1;
        low = parseArg(ctx);
      } else break;
    }
    if (sup !== null) html += `<sup>${sup === '∘' ? '°' : sup}</sup>`;
    if (low !== null) html += `<sub>${low}</sub>`;
    if (atom.func) html += THIN;

    out += html;
    prevOp = Boolean(atom.op) && !(sup !== null || low !== null);
  }
  return out;
}

/** Plain-string renderer (used by tests and by renderMath). */
export function mathToString(tex, display = false) {
  const source = String(tex ?? '').trim();
  const cls = display ? 'math-display' : 'math';
  if (source.length > MAX_INPUT) return `<span class="${cls}" role="math">${escapeHtml(source)}</span>`;
  const body = parseSequence({ s: source, i: 0, depth: 0, func: false });
  return `<span class="${cls}" role="math">${body}</span>`;
}

/** SafeHtml for the math in `tex`. */
export function renderMath(tex, { display = false } = {}) {
  return raw(mathToString(tex, display));
}
