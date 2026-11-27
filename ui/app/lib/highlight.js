// Omnia Studio UI — small deterministic syntax highlighter (no dependencies, no DOM).
//
//   highlight(code, 'cpp')  → SafeHtml with <span class="tok-kw|type|str|num|cmt|fn|pre">
//   normalizeLang('c++')    → 'cpp'
// Everything is escaped before it is wrapped, so the output is safe to inject.

import { escapeHtml, raw } from '../core/dom.js';

const words = (list) => new Set(list.split(/\s+/).filter(Boolean));

const CPP_KEYWORDS = words(`alignas alignof asm auto bool break case catch char class co_await co_return co_yield concept const
  consteval constexpr constinit const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern
  false final float for friend goto if inline int long mutable namespace new noexcept nullptr operator override private protected
  public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template
  this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile while`);
const CPP_TYPES = words(`std string string_view span vector map unordered_map set array optional variant tuple pair unique_ptr
  shared_ptr weak_ptr mutex lock_guard scoped_lock atomic thread uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t
  size_t ptrdiff_t wchar_t HRESULT HWND WPARAM LPARAM LRESULT DWORD BOOL sqlite3 sqlite3_stmt`);

const JS_KEYWORDS = words(`async await break case catch class const continue debugger default delete do else export extends
  false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof
  undefined var void while with yield as get set interface type enum implements readonly declare namespace`);
const JS_TYPES = words(`Array Boolean Date Error Map Number Object Promise Proxy RegExp Set String Symbol WeakMap WeakSet JSON Math
  string number boolean any unknown never void bigint`);

const PY_KEYWORDS = words(`and as assert async await break class continue def del elif else except False finally for from global
  if import in is lambda None nonlocal not or pass raise return True try while with yield match case`);
const PY_TYPES = words(`int float str bool list dict set tuple bytes object type Exception self cls`);

const SH_KEYWORDS = words(`if then else elif fi for while until do done case esac in function select time return exit break
  continue local export readonly declare unset set shift source alias echo cd`);
const PS_KEYWORDS = words(`begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach
  from function if in param process return switch throw trap try until using var while workflow`);

const JSON_KEYWORDS = words('true false null');
const CMAKE_KEYWORDS = words(`if else elseif endif foreach endforeach while endwhile function endfunction macro endmacro set
  option project add_executable add_library target_link_libraries target_include_directories find_package include`);
const SQL_KEYWORDS = words(`select from where insert into values update set delete create table index view drop alter add
  primary key foreign references not null default and or join left right inner outer on group by order having limit offset as
  distinct union all pragma begin commit rollback`);

const LANGS = {
  cpp: { keywords: CPP_KEYWORDS, types: CPP_TYPES, line: ['//'], block: ['/*', '*/'], strings: ['"', "'"], preproc: true, fn: true },
  js: { keywords: JS_KEYWORDS, types: JS_TYPES, line: ['//'], block: ['/*', '*/'], strings: ['"', "'", '`'], fn: true },
  py: { keywords: PY_KEYWORDS, types: PY_TYPES, line: ['#'], strings: ['"""', "'''", '"', "'"], fn: true },
  sh: { keywords: SH_KEYWORDS, types: new Set(), line: ['#'], strings: ['"', "'"], fn: false },
  ps: { keywords: PS_KEYWORDS, types: new Set(), line: ['#'], strings: ['"', "'"], fn: false, ci: true },
  json: { keywords: JSON_KEYWORDS, types: new Set(), line: [], strings: ['"'], fn: false },
  cmake: { keywords: CMAKE_KEYWORDS, types: new Set(), line: ['#'], strings: ['"'], fn: true, ci: true },
  sql: { keywords: SQL_KEYWORDS, types: new Set(), line: ['--'], block: ['/*', '*/'], strings: ["'", '"'], fn: false, ci: true },
  plain: null
};

const ALIASES = {
  c: 'cpp', 'c++': 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp', hxx: 'cpp', cs: 'cpp', java: 'cpp', rust: 'cpp', rs: 'cpp', go: 'cpp',
  js: 'js', javascript: 'js', mjs: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js',
  py: 'py', python: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh',
  ps: 'ps', ps1: 'ps', powershell: 'ps', pwsh: 'ps',
  json: 'json', jsonc: 'json',
  cmake: 'cmake',
  sql: 'sql', sqlite: 'sql'
};

/** Maps a fence info word ("c++", "TypeScript") to a highlighter id; unknown → 'plain'. */
export function normalizeLang(lang) {
  const key = String(lang ?? '').trim().toLowerCase();
  return ALIASES[key] || 'plain';
}

function span(cls, text) {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

function readString(code, start, quote) {
  const triple = quote.length === 3;
  let i = start + quote.length;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\' && !triple) {
      i += 2;
      continue;
    }
    if (code.startsWith(quote, i)) return i + quote.length;
    if (ch === '\n' && !triple && quote !== '`') return i; // unterminated: stop at end of line
    i += 1;
  }
  return code.length;
}

const NUMBER = /^(?:0[xX][0-9a-fA-F']+|0[bB][01']+|\d[\d']*(?:\.\d+)?(?:[eE][+-]?\d+)?)[uUlLfF]*/;
const IDENT = /^[A-Za-z_$][\w$]*/;

/** Returns SafeHtml. `lang` may be any fence word; unknown languages are escaped and left plain. */
export function highlight(code, lang = '') {
  const text = String(code ?? '');
  const spec = LANGS[normalizeLang(lang)];
  if (!spec) return raw(escapeHtml(text));

  let out = '';
  let plain = '';
  const flush = () => {
    if (plain) out += escapeHtml(plain);
    plain = '';
  };
  const emit = (cls, value) => {
    flush();
    out += span(cls, value);
  };

  let i = 0;
  let lineStart = true;
  while (i < text.length) {
    const ch = text[i];

    if (spec.block && text.startsWith(spec.block[0], i)) {
      const end = text.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = end < 0 ? text.length : end + spec.block[1].length;
      emit('cmt', text.slice(i, stop));
      i = stop;
      lineStart = false;
      continue;
    }
    const lineMarker = spec.line.find((marker) => text.startsWith(marker, i));
    if (lineMarker) {
      let stop = text.indexOf('\n', i);
      if (stop < 0) stop = text.length;
      emit('cmt', text.slice(i, stop));
      i = stop;
      continue;
    }
    const quote = spec.strings.find((q) => text.startsWith(q, i));
    if (quote) {
      const stop = readString(text, i, quote);
      emit('str', text.slice(i, stop));
      i = stop;
      lineStart = false;
      continue;
    }
    if (spec.preproc && ch === '#' && lineStart) {
      const match = /^#\s*[a-z_]+/.exec(text.slice(i, i + 40));
      if (match) {
        emit('pre', match[0]);
        i += match[0].length;
        lineStart = false;
        continue;
      }
    }
    if (/\d/.test(ch)) {
      const match = NUMBER.exec(text.slice(i, i + 64));
      if (match) {
        emit('num', match[0]);
        i += match[0].length;
        lineStart = false;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = IDENT.exec(text.slice(i, i + 128));
      const word = match[0];
      const probe = spec.ci ? word.toLowerCase() : word;
      const next = text[i + word.length];
      if (spec.keywords.has(probe)) emit('kw', word);
      else if (spec.types.has(word)) emit('type', word);
      else if (spec.fn && next === '(') emit('fn', word);
      else if (/^[A-Z][a-z0-9]/.test(word) && spec !== LANGS.json && spec !== LANGS.sql) emit('type', word);
      else plain += word;
      i += word.length;
      lineStart = false;
      continue;
    }
    plain += ch;
    if (ch === '\n') lineStart = true;
    else if (ch !== ' ' && ch !== '\t') lineStart = false;
    i += 1;
  }
  flush();
  return raw(out);
}
