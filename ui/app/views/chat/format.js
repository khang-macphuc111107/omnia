// Omnia Studio UI — pure text-editing helpers for the composer (no DOM).
//
// Every function takes and returns an editor state { value, start, end } (selection offsets),
// so toolbar buttons, Ctrl+B/I/U and palette commands share one tested implementation.

/** Smallest replacement turning `before` into `after`: { from, to, insert } or null when equal. */
export function diffEdit(before, after) {
  if (before === after) return null;
  let from = 0;
  const limit = Math.min(before.length, after.length);
  while (from < limit && before[from] === after[from]) from += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}

const clamp = (state) => {
  const length = state.value.length;
  const start = Math.max(0, Math.min(state.start ?? length, length));
  const end = Math.max(start, Math.min(state.end ?? start, length));
  return { value: state.value, start, end };
};

/** Replace the selection with `snippet`; the caret ends after it. */
export function insertAtCaret(input, snippet) {
  const { value, start, end } = clamp(input);
  const next = value.slice(0, start) + snippet + value.slice(end);
  const caret = start + snippet.length;
  return { value: next, start: caret, end: caret };
}

/**
 * Wrap the selection in `open`/`close` (Markdown emphasis). A second application unwraps.
 * An empty selection inserts the placeholder and selects it.
 */
export function wrapInline(input, open, close = open, placeholder = '') {
  const { value, start, end } = clamp(input);
  const selected = value.slice(start, end);

  // Selection sits inside an existing wrapper: remove it.
  if (value.slice(Math.max(0, start - open.length), start) === open && value.slice(end, end + close.length) === close && (selected || placeholder === '')) {
    const next = value.slice(0, start - open.length) + selected + value.slice(end + close.length);
    return { value: next, start: start - open.length, end: end - open.length };
  }
  // Selection includes the wrapper itself: remove it.
  if (selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  const body = selected || placeholder;
  const next = value.slice(0, start) + open + body + close + value.slice(end);
  return { value: next, start: start + open.length, end: start + open.length + body.length };
}

const PREFIX = {
  heading: /^#{1,6}[ \t]+/,
  bullet: /^[ \t]*[-*+][ \t]+(?!\[[ xX]\][ \t])/,
  numbered: /^[ \t]*\d{1,9}[.)][ \t]+/,
  task: /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/,
  quote: /^[ \t]*>[ \t]?/
};

function lineRange(value, start, end) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  // A selection that ends right after a newline does not include the following line.
  const probe = end > start && value[end - 1] === '\n' ? end - 1 : end;
  let to = value.indexOf('\n', probe);
  if (to < 0) to = value.length;
  return { from, to };
}

/**
 * Toggle a line prefix on the selected lines. kind: heading | bullet | numbered | task | quote.
 * Headings cycle "## " → "### " → none; the other kinds toggle on and off.
 */
export function toggleLinePrefix(input, kind) {
  const state = clamp(input);
  const { value, start, end } = state;
  const { from, to } = lineRange(value, start, end);
  const lines = value.slice(from, to).split('\n');
  const single = lines.length === 1;
  const touched = lines.map((line, index) => ({ line, index })).filter(({ line }) => single || line.trim() !== '');
  const pattern = PREFIX[kind];

  let result;
  if (kind === 'heading') {
    result = lines.map((line) => {
      if (!single && line.trim() === '') return line;
      const match = /^(#{1,6})[ \t]+/.exec(line);
      if (!match) return `## ${line}`;
      const level = match[1].length;
      if (level >= 3) return line.slice(match[0].length);
      return `${'#'.repeat(level + 1)} ${line.slice(match[0].length)}`;
    });
  } else {
    const allHave = touched.length > 0 && touched.every(({ line }) => pattern.test(line));
    let number = 0;
    result = lines.map((line) => {
      if (!single && line.trim() === '') return line;
      if (allHave) return line.replace(pattern, '');
      // Replace a different list/quote prefix instead of stacking them.
      const bare = ['bullet', 'numbered', 'task'].includes(kind)
        ? line.replace(PREFIX.task, '').replace(PREFIX.bullet, '').replace(PREFIX.numbered, '')
        : line.replace(pattern, '');
      number += 1;
      if (kind === 'bullet') return `- ${bare}`;
      if (kind === 'numbered') return `${number}. ${bare}`;
      if (kind === 'task') return `- [ ] ${bare}`;
      return `> ${bare}`;
    });
  }
  const replaced = result.join('\n');
  const next = value.slice(0, from) + replaced + value.slice(to);
  if (start === end) {
    const caret = from + replaced.length;
    return { value: next, start: caret, end: caret };
  }
  return { value: next, start: from, end: from + replaced.length };
}

/** Insert a block (table, etc.) on its own lines. */
export function insertBlock(input, block) {
  const { value, start, end } = clamp(input);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n';
  const insert = `${lead}${block}${trail}`;
  const caret = start + lead.length + block.length;
  return { value: before + insert + after, start: caret, end: caret };
}

/** Markdown table skeleton; the header labels are localised by the caller. */
export function tableSnippet(columnLabel) {
  const header = [1, 2, 3].map((n) => columnLabel(n));
  const separator = header.map(() => '---');
  return [`| ${header.join(' | ')} |`, `| ${separator.join(' | ')} |`, `| ${header.map(() => '  ').join(' | ')} |`].join('\n');
}

/** Insert `token` at the selection with single spaces around it where needed. */
export function insertToken(input, token) {
  const { value, start, end } = clamp(input);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after !== '' && /^\s/.test(after) ? '' : ' ';
  const insert = `${lead}${token}${trail}`;
  const caret = start + insert.length;
  return { value: before + insert + after, start: caret, end: caret };
}

/** Remove every occurrence of `token` (and one adjoining space) from the text. */
export function removeToken(value, token) {
  let out = '';
  let index = 0;
  for (;;) {
    const at = value.indexOf(token, index);
    if (at < 0) {
      out += value.slice(index);
      break;
    }
    out += value.slice(index, at);
    index = at + token.length;
    if (value[index] === ' ' && (out === '' || out.endsWith(' ') || out.endsWith('\n'))) index += 1;
    else if (out.endsWith(' ') && (index >= value.length || value[index] === '\n')) out = out.slice(0, -1);
  }
  return out;
}
