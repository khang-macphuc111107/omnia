# Task: Migrate `docpipe` SDK to Async v2 Plugin API with v1 Compatibility Shim

## Context
This workspace contains `docpipe`, a pure-Python (stdlib-only) document-processing SDK built around a synchronous v1 plugin API (`PluginBase.process(self, doc: dict) -> dict`) and `Pipeline.run(self, doc: dict) -> dict`.

Your goal is to refactor `docpipe` to introduce the **v2 async plugin API** with structured `Document`, `ExecutionContext`, cooperative `CancellationToken`, per-stage timing telemetry (`StageResult` / `ProcessResult`), and a clean v1 compatibility shim emitting `DeprecationWarning` — while keeping **100% backwards compatibility** with existing v1 callers and tests (`tests/test_legacy_v1.py` MUST pass unmodified).

Constraint: Use **Python 3.13 stdlib only** (no third-party packages).

---

## Required Changes

### 1. Core v2 Types & Shim in `docpipe/base.py` (re-exported in `docpipe/__init__.py`)

Define and export the following types from `docpipe/base.py` and re-export them from `docpipe/__init__.py` (alongside `Pipeline` and `default_plugins`):

1. **`PipelineCancelledError(Exception)`**
   - Exception raised when execution is cancelled via a `CancellationToken`.

2. **`CancellationToken`**
   - `__init__(self) -> None`: starts in non-cancelled state (`is_cancelled == False`).
   - `cancel(self, reason: str | None = None) -> None`: marks the token cancelled (storing optional reason).
   - `@property def is_cancelled(self) -> bool`: returns `True` once cancelled, `False` otherwise.
   - `raise_if_cancelled(self) -> None`: raises `PipelineCancelledError` if `is_cancelled` is `True`.

3. **`ExecutionContext`** (`@dataclass`)
   - `run_id: str = field(default_factory=lambda: uuid.uuid4().hex)`
   - `config: dict[str, Any] = field(default_factory=dict)`
   - `cancellation_token: CancellationToken = field(default_factory=CancellationToken)`
   - `stage_timings_ms: dict[str, float] = field(default_factory=dict)`
   - `warnings: list[str] = field(default_factory=list)`

4. **`Document`** (`@dataclass`)
   - `doc_id: str`
   - `text: str`
   - `metadata: dict[str, Any] = field(default_factory=dict)`
   - `chunks: list[str] = field(default_factory=list)`
   - Exact v1 `dict` <-> `Document` mapping:
     - `@classmethod def from_dict(cls, data: dict[str, Any]) -> Document`:
       - `doc_id`: `str(data.get("id", data.get("doc_id", "")))`
       - `text`: `str(data.get("text", ""))`
       - `metadata`: deep copy of `data.get("metadata")` (default `{}`)
       - `chunks`: shallow copy of `list(data.get("chunks") or [])`
       - **Extra top-level keys**: Any additional top-level keys in `data` (keys other than `"id"`, `"doc_id"`, `"text"`, `"metadata"`, `"chunks"`) MUST be preserved (e.g., via an internal/extra dict on `Document`) so that `Document.from_dict(d).to_dict()` losslessly retains them at top level!
     - `def to_dict(self) -> dict[str, Any]`:
       - Returns a fresh dictionary containing `"id": self.doc_id`, `"text": self.text`, `"metadata": copy.deepcopy(self.metadata)`, `"chunks": list(self.chunks)`, plus any preserved extra top-level keys.

5. **`StageResult`** (`@dataclass`)
   - `plugin_name: str`
   - `duration_ms: float`
   - `status: str` — one of `"ok"`, `"skipped"`, `"cancelled"`.

6. **`ProcessResult`** (`@dataclass`)
   - `document: Document`
   - `stage_results: list[StageResult]`
   - `total_duration_ms: float`
   - `cancelled: bool = False`
   - `warnings: list[str] = field(default_factory=list)`
   - `def to_dict(self) -> dict[str, Any]`: serializes to a JSON-compatible dict with keys `"document"` (`self.document.to_dict()`), `"stage_results"` (list of dicts with `plugin_name`, `duration_ms`, `status`), `"total_duration_ms"`, `"cancelled"`, `"warnings"`.

7. **`PluginBase` Dual-API & Deprecation Shim Rules**
   - `PluginBase` MUST allow subclasses to implement EITHER:
     - **v2 native plugin**: overrides `async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document` (without being forced to override `process()`), OR
     - **legacy v1 plugin**: overrides `def process(self, doc: dict[str, Any]) -> dict[str, Any]` (without implementing `process_v2()`).
   - Default `async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document` on `PluginBase`:
     - If the subclass overrides `process()` (legacy v1 plugin):
       1. Calls `ctx.cancellation_token.raise_if_cancelled()`.
       2. Emits a `DeprecationWarning` via `warnings.warn(..., DeprecationWarning, stacklevel=2)` whose message includes the plugin class name (e.g., `type(self).__name__`) and notes that the v1 `process()` API is deprecated in favor of `process_v2()`.
       3. Appends that warning message string to `ctx.warnings`.
       4. Invokes `result_dict = self.process(doc.to_dict())` and returns `Document.from_dict(result_dict)`.
     - If the subclass overrides NEITHER `process` nor `process_v2`, raises `NotImplementedError`.
   - Default `def process(self, doc: dict[str, Any]) -> dict[str, Any]` on `PluginBase`:
     - If the subclass overrides `process_v2()` (native v2 plugin): executes `self.process_v2(ExecutionContext(), Document.from_dict(doc))` synchronously and returns `result.to_dict()` **WITHOUT** emitting any `DeprecationWarning`.
     - If the subclass overrides NEITHER `process` nor `process_v2`, raises `NotImplementedError`.
   - Note: Executing a native v2 plugin (including all 4 built-in plugins) via `Pipeline.run_v2()`, `Pipeline.run()`, `plugin.process_v2()`, or `plugin.process()` MUST emit **ZERO** `DeprecationWarning`s.
   - Executing a legacy v1 subclass (overriding only `process(self, doc)`) via `Pipeline.run_v2()` OR `Pipeline.run()` MUST emit a `DeprecationWarning` and produce exact transformed output!

---

### 2. Migrate All 4 Built-in Plugins to Native Async `process_v2`

Update all four built-in plugins so each natively defines `async def process_v2(self, ctx: ExecutionContext, doc: Document) -> Document` (and removes any v1 `def process(...)` override so `PluginBase.process` bridges cleanly with zero warnings):

- `docpipe/plugins/normalize.py` (`NormalizePlugin`):
  - Calls `ctx.cancellation_token.raise_if_cancelled()`.
  - Reads optional overrides from `ctx.config.get("normalize", {})` (`"lowercase_slug"`, `"collapse_whitespace"`), falling back to constructor defaults.
  - Preserves exact normalization semantics (line endings, whitespace collapse, `metadata["title_slug"]`, `metadata["normalized"] = True`).
- `docpipe/plugins/redact.py` (`RedactPlugin`):
  - Calls `ctx.cancellation_token.raise_if_cancelled()`.
  - Reads optional overrides from `ctx.config.get("redact", {})` (`"replacement_email"`, `"replacement_ssn"`, `"replacement_card"`), falling back to constructor defaults.
  - Preserves exact redaction regexes and `metadata["redactions"]` / `metadata["redaction_count"]`.
- `docpipe/plugins/chunk.py` (`ChunkPlugin`):
  - Calls `ctx.cancellation_token.raise_if_cancelled()`.
  - Reads optional overrides from `ctx.config.get("chunk", {})` (`"chunk_size"`, `"overlap"`), validating `chunk_size > 0` and `0 <= overlap < chunk_size`.
  - Preserves exact overlapping word chunking into `doc.chunks` and `metadata["chunk_count"]`, `metadata["chunk_size"]`, `metadata["chunk_overlap"]`.
- `docpipe/plugins/enrich.py` (`EnrichPlugin`):
  - Calls `ctx.cancellation_token.raise_if_cancelled()`.
  - Reads optional override from `ctx.config.get("enrich", {})` (`"words_per_minute"`), validating `words_per_minute > 0`.
  - Preserves exact `metadata["word_count"]`, `metadata["char_count"]`, `metadata["content_sha256"]`, `metadata["reading_time_sec"]`.

---

### 3. Pipeline Async `run_v2` & Legacy Sync `run` in `docpipe/pipeline.py`

1. Add `async def run_v2(self, doc: Document | dict[str, Any], ctx: ExecutionContext | None = None, raise_on_cancel: bool = True) -> ProcessResult`:
   - If `ctx is None`, creates a fresh `ExecutionContext()`.
   - Converts `dict` input using `Document.from_dict(doc)` (or copies `Document` input so caller state is not mutated unexpectedly).
   - Sequentially runs each plugin via `await plugin.process_v2(ctx, current)`:
     - Checks `ctx.cancellation_token` **before** each plugin:
       - If already cancelled: raises `PipelineCancelledError` if `raise_on_cancel=True`; otherwise marks remaining plugins as `StageResult(plugin_name=p.name, duration_ms=0.0, status="skipped")`, sets `cancelled=True`, and stops immediately without running subsequent plugins.
     - Measures stage duration in milliseconds (`duration_ms >= 0.0`, using `time.perf_counter()`).
     - If `PipelineCancelledError` is raised during `plugin.process_v2`:
       - Records `StageResult(plugin_name=plugin.name, duration_ms=elapsed_ms, status="cancelled")` and `ctx.stage_timings_ms[plugin.name] = elapsed_ms`.
       - If `raise_on_cancel=True`, re-raises `PipelineCancelledError`.
       - If `raise_on_cancel=False`, marks remaining unexecuted plugins as `status="skipped"`, sets `cancelled=True`, and returns `ProcessResult`.
     - On stage success:
       - Records `StageResult(plugin_name=plugin.name, duration_ms=elapsed_ms, status="ok")` and `ctx.stage_timings_ms[plugin.name] = elapsed_ms`.
       - Checks `ctx.cancellation_token` **after** the stage completes: if cancelled, raises `PipelineCancelledError` (when `raise_on_cancel=True`), or marks remaining plugins `"skipped"`, sets `cancelled=True`, and stops (when `raise_on_cancel=False`).
   - Returns `ProcessResult(document=current, stage_results=stage_results, total_duration_ms=total_ms, cancelled=cancelled, warnings=list(ctx.warnings))`.

2. Keep `def run(self, doc: dict[str, Any]) -> dict[str, Any]` 100% backwards compatible:
   - Delegates through `run_v2` (safely handling both normal synchronous execution and active event loops) and returns `result.document.to_dict()`.
   - Existing `tests/test_legacy_v1.py` MUST continue to pass unmodified!

---

### 4. CLI Support in `docpipe/cli.py`

- Keep existing `python -m docpipe.cli --input <in.json> [--output <out.json>]` working identically for v1 JSON output.
- Add optional `--v2` flag: when passed, executes `Pipeline(default_plugins()).run_v2(doc)` and writes `result.to_dict()` as JSON (containing `"document"`, `"stage_results"`, `"total_duration_ms"`, `"cancelled"`, `"warnings"`).

---

## Verification

Run the existing legacy test suite to verify backwards compatibility:
```bash
python -m unittest discover -s tests -v
```
Add any additional v2 unit tests you find useful, while leaving `tests/test_legacy_v1.py` passing unmodified.
