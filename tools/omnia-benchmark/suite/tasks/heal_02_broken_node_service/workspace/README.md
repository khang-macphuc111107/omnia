# `event_bridge` Service Specification

`event_bridge` is a zero-dependency Node.js ESM + Python 3.13 subprocess event routing and transformation pipeline.

## Architecture

1. **Configuration (`config/routes.json` & `src/config.mjs`)**
   - Strict JSON config defining `default_channel` and `routes` (mapping `event.type` to `{ channel, priority, tag }`).
   - Unknown event types fall back to `{ channel: config.default_channel, priority: "normal", tag: "GENERAL" }`.

2. **PID Lockfile Guard (`src/lock.mjs`)**
   - Default lockfile path: `.bridge.lock` at the workspace root (overridable via `lockPath` option or `--lock`).
   - Lockfile JSON format: `{"pid": <integer>, "created_at": "<ISO-8601 UTC timestamp>"}`.
   - On `acquire()`:
     - If the lockfile exists, parse its `pid` and test whether that PID is currently alive (`process.kill(pid, 0)`: `ESRCH` means dead; `EPERM` means alive; non-integer or `<= 0` or invalid JSON means stale).
     - If the owning PID is **alive**, throw `BridgeLockError`.
     - If the owning PID is **dead** (stale lock), reclaim the lockfile by overwriting it with the current process's PID and timestamp.
   - On `release()`:
     - Remove the lockfile cleanly (ignoring `ENOENT`), provided this manager acquired it.

3. **Python Subprocess Transformation (`src/worker_client.mjs` & `py_worker/transform.py`)**
   - Node spawns `python py_worker/transform.py` (using `process.env.PYTHON_BIN || process.env.PYTHON || 'python'`) and exchanges newline-delimited UTF-8 JSON (NDJSON) over stdin/stdout.
   - Both sides must enforce UTF-8 regardless of the host OS default codepage (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, and `sys.stdin.reconfigure(encoding="utf-8")` / `sys.stdout.reconfigure(encoding="utf-8", newline="\n")`).
   - Node must properly buffer stdout across arbitrary chunk boundaries and tolerate both `\n` and `\r\n` line terminators.
   - Input payload sent to Python:
     ```json
     {
       "id": "evt-001",
       "type": "order.created",
       "message": "Order for café 東京 🚀",
       "source_path": "C:\\Users\\dev\\docs\\new\\test_file.txt",
       "amount": 42.5,
       "route": { "channel": "orders", "priority": "high", "tag": "SALES" }
     }
     ```
   - Transformed JSON object emitted by Python (one compact JSON line per event):
     - `id`: string (unchanged)
     - `type`: string (unchanged)
     - `channel`: `route.channel`
     - `priority`: `route.priority`
     - `tag`: `route.tag`
     - `message`: exact verbatim Unicode string (must NOT alter characters or escape sequences)
     - `message_length`: exact Unicode codepoint length (`len(message)` in Python)
     - `source_path`: exact verbatim string if provided (preserving Windows backslashes `\` verbatim), or `""` if omitted/null
     - `path_segments`: array of non-empty path segments produced by splitting `source_path` on BOTH `\` and `/` (e.g. `"C:\\Users\\dev\\docs\\new\\test_file.txt"` -> `["C:", "Users", "khang", "docs", "new", "test_file.txt"]`), or `[]` if empty
     - `formatted_label`: `"[<tag>] <id>: <message>"`
     - `amount`: numeric `amount` if present and not null, else `null`
     - `processed`: `true`

4. **Concurrent Batch Output Writer (`src/writer.mjs`)**
   - Buffers serialized JSON lines and flushes to disk when `buffer.length >= batchSize` or when `flush()` / `close()` is called.
   - Must serialize concurrent `enqueue()` and `flush()` calls so that every enqueued record is written **exactly once** as an intact, non-interleaved JSON line.

## Programmatic API (`src/index.mjs`)

Named exports:
- `EventBridge`
- `BridgeLockError`
- `RouteEngine`
- `BatchWriter`
- `loadConfig`

`EventBridge` constructor options:
- `configPath?: string`
- `lockPath?: string`
- `outputPath?: string | null`
- `batchSize?: number` (default `10`)
- `pythonBin?: string`

`EventBridge` methods:
- `await bridge.start()`
- `await bridge.transformEvent(event)` -> transformed object
- `await bridge.enqueue(event)` -> transforms and enqueues to `BatchWriter`, returns transformed object
- `await bridge.flush()` -> flushes pending batch writes to disk
- `await bridge.processFile(inputPath)` -> processes every NDJSON line from `inputPath`, flushes, returns processed count
- `await bridge.stop()` -> flushes writer, shuts down Python worker cleanly, and releases lockfile

## CLI Usage

```
node src/cli.mjs --input data/sample_events.jsonl --output out.jsonl [--lock .bridge.lock] [--config config/routes.json] [--batch-size 10]
```

## Test Suite

```
node test/bridge.test.mjs
```
