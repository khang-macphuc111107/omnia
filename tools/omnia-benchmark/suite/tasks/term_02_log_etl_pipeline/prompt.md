# Task: Multi-Format Telemetry ETL Pipeline

Build a deterministic Python 3 CLI ETL tool `pipeline.py` in the current working directory that ingests mixed-format telemetry logs (`*.jsonl` and `*.csv`) joined against `regions.tsv`, cleans/validates/deduplicates events, computes regional latency percentiles and error rates, flags high-latency anomalies, and emits a SHA-256 audit manifest.

## CLI Interface

```bash
python pipeline.py --input <input_dir> --output <output_dir>
```

- Must work on **any** input directory containing `regions.tsv` and one or more `*.jsonl` / `*.csv` files (do **not** hardcode `data/` or specific filenames).
- Create `<output_dir>` automatically if it does not exist.
- Before finishing, you **must** execute `python pipeline.py --input data --output output` to generate the outputs for the workspace dataset.

## Input Specification

1. **Region Lookup Table (`<input_dir>/regions.tsv`)**:
   - UTF-8 (may start with a UTF-8 BOM `\ufeff`).
   - Tab-separated with header: `region_code\tregion_name\ttimezone`.

2. **Log Files (`<input_dir>/*.jsonl` and `<input_dir>/*.csv`)**:
   - Discover all files directly inside `<input_dir>` ending with `.jsonl` or `.csv`.
   - Process files in **ascending lexicographical filename order** (`sorted` by basename, e.g., `access_2026_01.jsonl` before `access_2026_02.csv`), and line-by-line within each file.
   - Strip UTF-8 BOM (`\ufeff`) when reading any input file (e.g., open with `encoding="utf-8-sig"`).
   - Skip completely blank / whitespace-only lines without counting them as malformed.

3. **Event Schema & Validation Rules**:
   Every record must contain all 6 required fields: `event_id`, `timestamp`, `user_id`, `region`, `latency_ms`, `status`.
   If **any** parsing or validation check below fails, increment `malformed_count` by 1 and discard the record (do **not** record its `event_id` as seen and do **not** increment `duplicate_count`):
   - **JSONL (`*.jsonl`)**: Line must parse as a JSON object (`dict`).
   - **CSV (`*.csv`)**: Row must match the header column count (no missing columns and no extra columns beyond the header).
   - **`event_id`**: Present, string (not null/number/bool in JSON), non-empty after `.strip()`. Use trimmed value.
   - **`user_id`**: Present, string (not null/number/bool in JSON), non-empty after `.strip()`. Use trimmed value.
   - **`region`**: Present, string, trimmed value must exist as a `region_code` in `regions.tsv`.
   - **`timestamp`**: Present and parseable as either:
     - **Epoch milliseconds**: non-negative integer (an `int` excluding `bool` in JSON, or an ASCII digits-only string like `"1769904000250"`). Convert to UTC (`secs, ms = divmod(epoch_ms, 1000)`).
     - **ISO-8601 with explicit timezone**: string with explicit `Z` or `±HH:MM` offset (e.g., `2026-01-15T10:20:30Z`, `2026-01-15T10:20:30.250Z`, `2026-01-15T17:20:30+07:00`). **Reject** naive timestamps lacking timezone info or invalid dates.
     - Normalize all valid timestamps to UTC string format `YYYY-MM-DDTHH:MM:SS.fffZ` (millisecond precision, 3 zero-padded digits).
   - **`latency_ms`**: Present, finite numeric value (reject `bool`, `None`, empty string, `NaN`, `±Inf`, non-numeric strings), and **`latency_ms >= 0`** (negative latencies are malformed).
   - **`status`**: Present, integer (in JSON: `int` excluding `bool`, or an ASCII integer string; in CSV: ASCII integer string matching `^\d+$`), with **`100 <= status <= 599`**.

4. **Deduplication Rule**:
   - Applied **only** to records that pass all validation checks above.
   - Keep the **first** valid occurrence of each `event_id` (in ascending filename order, then line order).
   - Any subsequent valid record with an already-seen `event_id` increments `duplicate_count` by 1 and is discarded.

## Metrics & Formulas

Compute metrics over all valid deduplicated events grouped by `region` (include every region that has `count >= 1`, keyed by `region_code` in ascending alphabetical order):

- **`region_name`**: Lookup from `regions.tsv`.
- **`count`**: Number of valid deduplicated events in that region.
- **`unique_users`**: Number of distinct `user_id` values in that region.
- **`error_rate`**: Fraction of valid deduplicated events in that region with **`status >= 500`**, rounded to 4 decimal places (`round(errors / count, 4)`).
- **Nearest-Rank Percentiles (`p50_ms`, `p95_ms`, `p99_ms`)**:
  For the region's sorted ascending latency list `xs` of length `n >= 1` and percentile `p` in `{50, 95, 99}`:
  ```python
  idx = math.ceil((p / 100.0) * n) - 1
  raw_val = xs[max(0, min(n - 1, idx))]
  ```
  Report `round(raw_val, 2)` in `summary.json`.

## Output Files (inside `<output_dir>`)

1. **`summary.json`** (UTF-8, valid JSON, LF line endings):
   ```json
   {
     "total_valid_events": 304,
     "malformed_count": 38,
     "duplicate_count": 24,
     "regions": {
       "ap-south": {
         "region_name": "Asia Pacific South",
         "count": 76,
         "unique_users": 24,
         "error_rate": 0.0789,
         "p50_ms": 105.5,
         "p95_ms": 740.25,
         "p99_ms": 2150.0
       }
     }
   }
   ```

2. **`anomalies.csv`** (UTF-8 without BOM, LF `\n` line endings):
   - Header: `event_id,timestamp_utc,region,user_id,latency_ms,status`
   - Include every valid deduplicated event where **`latency_ms > 3 * region_raw_p50_ms`** (where `region_raw_p50_ms` is that event's region's exact nearest-rank p50 latency).
   - Format `latency_ms` with exactly 2 decimal places (`f"{latency_ms:.2f}"`).
   - Sort rows ascending by `(timestamp_utc, event_id)`.

3. **`audit.sha256`** (UTF-8 without BOM, LF `\n` line endings):
   - Standard two-line `sha256sum` format (lowercase 64-char hex digest, **two spaces**, filename), sorted alphabetically by filename:
     ```text
     <sha256_hex>  anomalies.csv
     <sha256_hex>  summary.json
     ```
   - Digests must match the exact bytes written to `<output_dir>/anomalies.csv` and `<output_dir>/summary.json`.

## Constraints
- Use only the Python 3 standard library.
- Do not modify any files in `data/`.
- Work only inside the current working directory.
