// Omnia Studio UI — safe Markdown renderer (no DOM, no dependencies).
//
//   renderMarkdown(text, { attachments, labels }) → SafeHtml
//
// Safety model: every piece of user text goes through escapeHtml before it is placed in
// markup, and the only markup that is ever emitted is built here from fixed templates.
// Links are shown as "text (url)" and are never turned into anchors, images never load.
//
// Supported: headings, **bold**, *italic* / _italic_, __underline__, ~~strike~~, `code`,
// fenced code (highlighted, with a copy button), bullet / numbered / task lists (nested),
// tables, > quotes, --- rules, $inline$ and $$display$$ math (lib/latex.js) and
// [[att:<8 hex>]] attachment chips.

import { escapeHtml, raw } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { fmtBytes } from '../core/i18n.js';
import { highlight } from './highlight.js';
import { mathToString } from './latex.js';

export const ATTACHMENT_TOKEN = /\[\[att:([0-9a-f]{8})\]\]/g;

export function attachmentToken(sha256) {
  return `[[att:${String(sha256).slice(0, 8)}]]`;
}

/** Short ids of every attachment token in the text, in order of appearance. */
export function findAttachmentIds(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(ATTACHMENT_TOKEN)) out.push(match[1]);
  return out;
}

const DEFAULT_LABELS = { copy: 'Copy', plain: 'text', copyCode: 'Copy code', taskDone: 'done', taskOpen: 'to do' };

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const isSpace = (ch) => ch === undefined || /\s/.test(ch);
const isWord = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Finds a valid $…$ starting at index i (text[i] === '$'); returns { end, content } or null. */
export function findInlineMath(text, i) {
  if (text[i] !== '$' || text[i + 1] === '$' || isSpace(text[i + 1])) return null;
  let k = i + 1;
  while (k < text.length) {
    k = text.indexOf('$', k);
    if (k < 0) return null;
    if (text[k - 1] === '\\') {
      k += 1;
      continue;
    }
    if (isSpace(text[k - 1]) || /\d/.test(text[k + 1] ?? '') || k === i + 1) {
      k += 1;
      continue;
    }
    return { end: k + 1, content: text.slice(i + 1, k) };
  }
  return null;
}

/** Finds the closing delimiter for emphasis; returns its index or -1. */
function closeDelimiter(text, from, delimiter) {
  let k = from;
  while (k < text.length) {
    k = text.indexOf(delimiter, k);
    if (k < 0) return -1;
    if (k > from && !isSpace(text[k - 1]) && text[k - 1] !== '\\') return k;
    k += delimiter.length;
  }
  return -1;
}

const LINK = /^\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)/;
const ATT_CHIP = /^\[\[att:([0-9a-f]{8})\]\]/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!$~|>]/;

function attachmentChip(id, ctx) {
  const att = ctx.attachments.get(id);
  if (!att) {
    return `<span class="att">${icon('file', { size: 'sm' }).value}<span class="mono">att:${escapeHtml(id)}</span></span>`;
  }
  return `<span class="att">${icon('file', { size: 'sm' }).value}<span>${escapeHtml(att.name)}</span><span class="mono">${escapeHtml(fmtBytes(att.size))} · ${escapeHtml(id)}</span></span>`;
}

function inline(text, ctx, depth = 0) {
  if (depth > 6) return escapeHtml(text);
  let out = '';
  let buf = '';
  const flush = () => {
    if (buf) out += escapeHtml(buf);
    buf = '';
  };
  const push = (html) => {
    flush();
    out += html;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push('<br>');
      i += 1;
      continue;
    }
    if (ch === '`') {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, i + run);
      while (close >= 0 && text[close + run] === '`') close = text.indexOf(fence, close + run + 1);
      if (close > i + run - 1 && close >= 0) {
        let code = text.slice(i + run, close);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        push(`<code>${escapeHtml(code)}</code>`);
        i = close + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const close = text.indexOf('$$', i + 2);
        if (close > i + 2) {
          push(mathToString(text.slice(i + 2, close), true));
          i = close + 2;
          continue;
        }
      } else {
        const math = findInlineMath(text, i);
        if (math) {
          push(mathToString(math.content, false));
          i = math.end;
          continue;
        }
      }
    }
    if (ch === '[' && text[i + 1] === '[') {
      const chip = ATT_CHIP.exec(rest);
      if (chip) {
        push(attachmentChip(chip[1], ctx));
        i += chip[0].length;
        continue;
      }
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const image = ch === '!';
      const link = LINK.exec(image ? rest.slice(1) : rest);
      if (link) {
        push(`${inline(link[1], ctx, depth + 1)} <span class="mono muted text-xs">(${escapeHtml(link[2])})</span>`);
        i += link[0].length + (image ? 1 : 0);
        continue;
      }
    }
    if (ch === '*' && text[i + 1] === '*') {
      const close = closeDelimiter(text, i + 2, '**');
      if (close > i + 2 && !isSpace(text[i + 2])) {
        push(`<strong>${inline(text.slice(i + 2, close), ctx, depth + 1)}</strong>`);
        i = close + 2;
        continue;
      }
    }
    if (ch === '_' && text[i + 1] === '_') {
      const close = closeDelimiter(text, i + 2, '__');
      if (close > i + 2 && !isSpace(text[i + 2])) {
        push(`<u>${inline(text.slice(i + 2, close), ctx, depth + 1)}</u>`);
        i = close + 2;
        continue;
      }
    }
    if (ch === '~' && text[i + 1] === '~') {
      const close = closeDelimiter(text, i + 2, '~~');
      if (close > i + 2 && !isSpace(text[i + 2])) {
        push(`<s>${inline(text.slice(i + 2, close), ctx, depth + 1)}</s>`);
        i = close + 2;
        continue;
      }
    }
    if (ch === '*' && text[i + 1] !== '*' && !isSpace(text[i + 1])) {
      let k = i + 1;
      let close = -1;
      while (k < text.length) {
        k = text.indexOf('*', k);
        if (k < 0) break;
        if (text[k + 1] !== '*' && text[k - 1] !== '*' && !isSpace(text[k - 1]) && text[k - 1] !== '\\') {
          close = k;
          break;
        }
        k += 1;
      }
      if (close > i + 1) {
        push(`<em>${inline(text.slice(i + 1, close), ctx, depth + 1)}</em>`);
        i = close + 1;
        continue;
      }
    }
    if (ch === '_' && text[i + 1] !== '_' && !isSpace(text[i + 1]) && !isWord(text[i - 1])) {
      let k = i + 1;
      let close = -1;
      while (k < text.length) {
        k = text.indexOf('_', k);
        if (k < 0) break;
        if (text[k + 1] !== '_' && text[k - 1] !== '_' && !isSpace(text[k - 1]) && !isWord(text[k + 1]) && text[k - 1] !== '\\') {
          close = k;
          break;
        }
        k += 1;
      }
      if (close > i + 1) {
        push(`<em>${inline(text.slice(i + 1, close), ctx, depth + 1)}</em>`);
        i = close + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let cell = '';
  let tick = false;
  let math = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '`') {
      tick = !tick;
      cell += ch;
    } else if (ch === '$' && !tick) {
      math = !math;
      cell += ch;
    } else if (ch === '|' && !tick && !math) {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell) {
  const c = cell.trim();
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  return c.startsWith(':') ? 'left' : '';
}

function paragraph(text, ctx) {
  const body = inline(text, ctx);
  // A <table> inside <p> would be hoisted out by the HTML parser, so use a <div> then.
  const tag = body.includes('<table') ? 'div' : 'p';
  return `<${tag}>${body}</${tag}>`;
}

function codeBlock(code, info, ctx) {
  const [langWord = '', ...restWords] = String(info ?? '').trim().split(/\s+/);
  const lang = langWord.replace(/[^\w+#.-]/g, '').slice(0, 24);
  const extra = restWords.join(' ').slice(0, 80);
  const label = lang ? (extra ? `${lang} · ${extra}` : lang) : ctx.labels.plain;
  return (
    `<div class="code-block"><div class="code-block__bar"><span class="mono">${escapeHtml(label)}</span>` +
    `<button type="button" class="btn btn--ghost btn--sm" data-action="copy-code" aria-label="${escapeHtml(ctx.labels.copyCode)}">${icon('copy', { size: 'sm' }).value}${escapeHtml(ctx.labels.copy)}</button></div>` +
    `<pre><code>${highlight(code, lang).value}</code></pre></div>`
  );
}

function isBlockStart(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    /^\s*\$\$/.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-') && next.includes('|'))
  );
}

function renderList(lines, start, ctx) {
  const first = LIST_ITEM.exec(lines[start]);
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || indentOf(lines[i]) !== base || /\d/.test(match[2]) !== ordered) break;
    let text = match[3];
    let task = null;
    const taskMatch = TASK.exec(text);
    if (taskMatch) {
      task = taskMatch[1].toLowerCase() === 'x';
      text = taskMatch[2];
    }
    i += 1;
    const child = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        let k = i;
        while (k < lines.length && lines[k].trim() === '') k += 1;
        if (k < lines.length && indentOf(lines[k]) > base) {
          while (i < k) {
            child.push('');
            i += 1;
          }
          continue;
        }
        break;
      }
      if (indentOf(line) > base) {
        child.push(line);
        i += 1;
        continue;
      }
      break;
    }
    let childHtml = '';
    if (child.length) {
      const min = Math.min(...child.filter((l) => l.trim()).map(indentOf));
      childHtml = blocks(child.map((l) => (l.trim() ? l.slice(Math.min(min, l.length - l.trimStart().length)) : '')), ctx);
    }
    const body = inline(text, ctx);
    if (task === null) items.push(`<li>${body}${childHtml}</li>`);
    else {
      items.push(
        `<li class="task"><input type="checkbox" disabled${task ? ' checked' : ''} aria-label="${escapeHtml(task ? ctx.labels.taskDone : ctx.labels.taskOpen)}"><span>${body}${childHtml}</span></li>`
      );
    }
    while (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1]) && indentOf(lines[i + 1]) === base) i += 1;
  }
  const tag = ordered ? 'ol' : 'ul';
  const attr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : '';
  return { html: `<${tag}${attr}>${items.join('')}</${tag}>`, next: i };
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length) {
        const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}\\s*$`);
        if (closing.test(lines[i])) break;
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      out.push(codeBlock(body.join('\n'), fence[2], ctx));
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        out.push(mathToString(trimmed.slice(2, -2), true));
        i += 1;
        continue;
      }
      if (trimmed === '$$' || !trimmed.slice(2).includes('$$')) {
        const body = [trimmed.slice(2)];
        let k = i + 1;
        let closed = false;
        while (k < lines.length) {
          const probe = lines[k];
          const at = probe.indexOf('$$');
          if (at >= 0) {
            body.push(probe.slice(0, at));
            closed = true;
            break;
          }
          body.push(probe);
          k += 1;
        }
        if (closed) {
          out.push(mathToString(body.join('\n'), true));
          i = k + 1;
          continue;
        }
      }
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2], ctx)}</h${level}>`);
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      out.push(`<blockquote>${blocks(quoted, ctx)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      if (head.length === aligns.length) {
        const style = (n) => (aligns[n] ? ` style="text-align: ${aligns[n]}"` : '');
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          const cells = splitRow(lines[i]);
          rows.push(`<tr>${head.map((_, n) => `<td${style(n)}>${inline(cells[n] ?? '', ctx)}</td>`).join('')}</tr>`);
          i += 1;
        }
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((cell, n) => `<th${style(n)}>${inline(cell, ctx)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
        );
        continue;
      }
    }
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, i, ctx);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(paragraph(para.map((l) => l.replace(/\s+$/, '')).join('\n'), ctx));
  }
  return out.join('');
}

function attachmentMap(attachments) {
  const map = new Map();
  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (att && typeof att.sha256 === 'string') map.set(att.sha256.slice(0, 8), att);
  }
  return map;
}

/** String form (tests, caching). Always escaped. */
export function markdownToString(text, { attachments = [], labels = {} } = {}) {
  const ctx = { attachments: attachmentMap(attachments), labels: { ...DEFAULT_LABELS, ...labels } };
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return blocks(lines, ctx);
}

/** SafeHtml for the Markdown/LaTeX source. */
export function renderMarkdown(text, options = {}) {
  return raw(markdownToString(text, options));
}

/** True when the text contains LaTeX math ($…$ or $$…$$) outside code. */
export function hasLatex(text) {
  const source = String(text ?? '')
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  if (/\$\$[\s\S]*?\S[\s\S]*?\$\$/.test(source)) return true;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
    } else if (source[i] === '$' && findInlineMath(source, i)) {
      return true;
    }
  }
  return false;
}
