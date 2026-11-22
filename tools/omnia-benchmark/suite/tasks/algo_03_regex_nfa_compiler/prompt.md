# ReDoS-Immune Linear-Time Regex Engine (Thompson NFA / PikeVM)

Implement a linear-time, ReDoS-immune regular expression compiler and matcher in `solution.py` using **Python 3.13 standard library only** — and **STRICTLY WITHOUT** using Python's `re` module or any external regex / subprocess engine.

## Strict Prohibition

Your solution (including any helper modules in the workspace) **MUST NOT** import, reference, or invoke:
- `re`, `_sre`, `sre_compile`, `sre_parse`, `sre_constants`, `regex`, `fnmatch`, `glob`
- `subprocess`, `multiprocessing`, `ctypes`, `pty`, `os.system`, `os.popen`, `eval`, `exec`, `__import__`, `importlib`

This restriction is enforced by both static AST inspection and runtime import/call guards. You may freely use pure-Python stdlib helpers such as `dataclasses`, `typing`, `enum`, `collections`, etc.

## Required Public API (`solution.py`)

```python
class RegexSyntaxError(ValueError):
    """Raised when a regex pattern has invalid syntax."""

class MatchResult:
    span: tuple[int, int]  # (start, end) indices in text, 0 <= start <= end <= len(text)
    def group(self, i: int = 0) -> str | None: ...
    def groups(self) -> tuple[str | None, ...]: ...

class CompiledPattern:
    def fullmatch(self, text: str) -> MatchResult | None: ...
    def match(self, text: str) -> MatchResult | None: ...
    def search(self, text: str) -> MatchResult | None: ...
    def findall(self, text: str) -> list[str]: ...

def compile_pattern(pattern: str) -> CompiledPattern: ...
```

### API Semantics

1. **`MatchResult`**:
   - `span`: `(start, end)` half-open slice indices in `text`.
   - `group(i=0)`:
     - `i == 0` returns the full matched substring `text[start:end]`.
     - `1 <= i <= K` (where `K` is the number of capturing groups in the pattern) returns the matched substring for capturing group `i`, or `None` if group `i` did not participate in the winning match.
     - Raises `IndexError` if `i < 0` or `i > K`.
   - `groups()`: returns a `tuple` of length `K` containing `(group(1), ..., group(K))` (or `()` if `K == 0`).

2. **`CompiledPattern`**:
   - `fullmatch(text)`: matches only if the pattern matches the **entire** string (`span == (0, len(text))`).
   - `match(text)`: matches only starting at index `0` (`span[0] == 0`).
   - `search(text)`: scans `text` for the earliest starting index `0 <= start <= len(text)` at which the pattern matches.
   - `findall(text)`: returns a `list[str]` of all non-overlapping full matched substrings (`group(0)`), scanning left-to-right from `pos = 0` while `pos <= len(text)`:
     - Find the earliest match starting at index `>= pos` (evaluating anchors `^` and `$` against the **original** `text`, so `^` only matches at index `0` and `$` only matches at `len(text)`).
     - If no match is found, stop.
     - Append `m.group(0)` to the result list.
     - If `m.span[1] > m.span[0]`, set `pos = m.span[1]`.
     - If `m.span[1] == m.span[0]` (empty match), set `pos = m.span[1] + 1` so scanning always terminates.

## Supported Regex Syntax & Exact Semantics

### Atoms & Character Matching

1. **Literals**: Ordinary characters match themselves literally.
2. **Dot `.`**: Matches any single character **except** `\n`.
3. **Shorthand & Character Escapes** (outside `[...]`):
   - `\d`: ASCII digit `[0-9]`
   - `\w`: ASCII word character `[a-zA-Z0-9_]`
   - `\s`: ASCII whitespace `[ \t\r\n\f\v]`
   - `\n`, `\t`, `\r`: newline, tab, carriage return
   - Escaped metacharacters: `\.`, `\\`, `\*`, `\+`, `\?`, `\(`, `\)`, `\[`, `\]`, `\{`, `\}`, `\|`, `\^`, `\$` match the literal character.
   - A trailing lone `\` at the end of the pattern raises `RegexSyntaxError`.
4. **Character Classes `[...]` and `[^...]`**:
   - `[abc]` matches any character in the class; `[^abc]` matches any character **not** in the class (including `\n`, unless `\n` is listed inside the class).
   - Character ranges like `[a-z]`, `[0-9]`, `[a-zA-Z0-9_]` match all characters with `ord(lo) <= ord(ch) <= ord(hi)`. An inverted range where `ord(lo) > ord(hi)` (e.g. `[z-a]`) raises `RegexSyntaxError`.
   - A `-` at the very start of the class (immediately after `[` or `[^`) or immediately before the closing `]` is treated as a literal `'-'`.
   - Inside `[...]`, escapes `\d`, `\w`, `\s`, `\n`, `\t`, `\r`, `\]`, `\\`, `\-`, `\^`, `\[` are supported (and any other escaped punctuation matches itself literally).
   - Empty classes (`[]`, `[^]`) or unclosed `[` raise `RegexSyntaxError`.
5. **Anchors**:
   - `^`: matches only at index `0` of `text`.
   - `$`: matches only at index `len(text)` of `text`.
   - Quantifying an anchor directly (e.g., `^*`, `$+`) raises `RegexSyntaxError`.

### Grouping, Alternation, and Quantifiers

6. **Capturing Groups `(...)`**:
   - Numbered `1..K` by opening parenthesis order. Nested groups are supported.
   - Empty groups `()` are valid and match the empty string `""`.
   - If a capturing group matches multiple times inside a quantifier (e.g., `([a-z])+` on `"abc"`), it captures the **last** iteration's substring (`"c"`). Following standard Perl / Python `re` / PikeVM semantics, each capturing group retains its most recent match and is not cleared if a later iteration of an enclosing loop skips an optional inner group (e.g., `((a)?b)+` on `"abb"` yields `("b", "a")`).
   - Unmatched optional groups return `None`.
   - Unmatched `(` or `)` raises `RegexSyntaxError`.
7. **Alternation `a|b`**:
   - Lowest precedence (below concatenation and quantifiers). Empty branches (`a|`, `|b`, `(|a)`) are valid.
   - **Leftmost-First Priority (Perl / PikeVM semantics)**:
     - Earliest match start position wins.
     - At the same start position, the **left** branch of `|` has strictly higher priority than the **right** branch (e.g., `(a|ab)` `.match("ab")` returns `"a"`, while `(ab|a)b` `.match("ab")` falls through to the right branch and returns `"ab"` with group 1 = `"a"`).
8. **Greedy Quantifiers**:
   - `*` (0 or more), `+` (1 or more), `?` (0 or 1), `{m}` (exactly `m`), `{m,}` (`m` or more), `{m,n}` (between `m` and `n` inclusive, `0 <= m <= n`).
   - All quantifiers are **greedy** (prefer more repetitions over fewer).
   - Zero-width quantified loops (e.g., `(a*)*`, `(a?)+`, `()*`) must terminate without infinite looping.
   - Invalid quantifiers MUST raise `RegexSyntaxError`:
     - Quantifier with no preceding atom (e.g., `*abc`, `+a`, `?a`, `{2}a`, `(|*a)`, `(*a)`).
     - Stacked greedy quantifiers (e.g., `a**`, `a+*`, `a++`, `a{2}{3}`).
     - Malformed `{...}` quantifiers (e.g., `a{5,2}`, `a{}`, `a{,3}`, `a{abc}`, unclosed `a{2`).

## Complexity & ReDoS Immunity

Your engine MUST execute in **$O(N \cdot M)$ worst-case time** (where $N = \text{len}(\text{text})$ and $M$ is compiled NFA size) using Thompson NFA / PikeVM state simulation with per-character state deduplication — NOT exponential backtracking.

ReDoS torture tests including `(a+)+b` on `'a'*80 + 'c'`, `(a|a?)+b` on `'a'*60 + 'c'`, `((a+)+)+b` on `'a'*60 + 'c'`, `(a|aa)+b` on `'a'*80 + 'c'`, and `(a+)+b` on `'a'*80 + 'b'` must EACH complete in **`< 0.1` seconds**!

## Local Testing

A small sample test script `test_sample.py` is included in the workspace:

```bash
python test_sample.py
```
