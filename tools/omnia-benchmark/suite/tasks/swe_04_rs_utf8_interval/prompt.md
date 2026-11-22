# Task: Fix Rust UTF-8 Excerpting, Half-Open Interval Algebra, and Batch Span Edits

You are working on a zero-dependency Rust library (`span_index`) in the current workspace.
Run `cargo test` to see existing public tests pass. However, four production bugs have been reported across `src/text.rs`, `src/interval.rs`, and `src/lib.rs`:

1. **UTF-8 char-boundary panic (`src/text.rs` -> `excerpt_around`)**:
   `excerpt_around(s: &str, byte_pos: usize, radius_bytes: usize) -> &str` currently slices `&s[start..end]` directly at raw byte offsets, panicking whenever `byte_pos`, `byte_pos - radius`, or `byte_pos + radius` falls inside a multi-byte UTF-8 codepoint (e.g., Vietnamese diacritics, CJK, emoji).
   - Clamp `byte_pos` to `s.len()`.
   - Snap `start = pos.saturating_sub(radius_bytes)` **downward** (floor) to the nearest valid UTF-8 char boundary (`<= start`).
   - Snap `end = pos.saturating_add(radius_bytes).min(s.len())` **upward** (ceil) to the nearest valid UTF-8 char boundary (`>= end`, capped at `s.len()`).

2. **Half-open interval merge bugs (`src/interval.rs` -> `merge_intervals`)**:
   Intervals are half-open `[start, end)` (ignore empty/inverted spans where `start >= end`).
   - Adjacent intervals (`[0, 5)` and `[5, 10)`) MUST be merged into `[0, 10)`.
   - Unsorted and nested intervals (e.g., `[0, 10)` followed by `[2, 4)`) MUST preserve the larger `end` (`[0, 10)`), never shrinking `end`.

3. **Interval subtraction splitting bug (`src/interval.rs` -> `subtract_intervals`)**:
   `subtract_intervals(base: &[Span], remove: &[Span]) -> Vec<Span>` must first normalize/merge both sets, then compute the exact set difference `base \ remove`. When a removed interval lies strictly inside a base interval (e.g., `[0, 10) \ [3, 7)`), BOTH the left `[0, 3)` AND right `[7, 10)` remainders must be emitted in sorted order.

4. **Batch span replacement bug (`src/lib.rs` -> `apply_replacements`)**:
   `apply_replacements(input: &str, edits: &[Replacement]) -> Result<String, SpanError>` currently mutates offsets left-to-right without compensating for length deltas and fails to detect overlaps or invalid UTF-8 boundaries.
   - Validate every edit: `start <= end <= input.len()` and both `start` and `end` are UTF-8 char boundaries (`Err(SpanError::InvalidBounds)` otherwise).
   - Detect overlapping edits: two edits overlap if their non-empty ranges intersect (`prev.end > cur.start`), OR if two zero-length insertions target the exact same offset (`Err(SpanError::Overlap)`). Adjacent non-overlapping edits (`prev.end == cur.start`, e.g., `[0, 3)` and `[3, 6)`) are valid!
   - Apply all valid edits simultaneously with respect to the **original** `input` byte offsets (order of `edits` slice must not matter).

Keep all existing public tests passing and ensure `cargo test` compiles cleanly with zero warnings.
