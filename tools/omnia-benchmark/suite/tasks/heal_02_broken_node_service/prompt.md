# Task: Recover Broken Node.js + Python Subprocess Event Bridge (`event_bridge`)

This repository contains `event_bridge`, a zero-dependency Node.js ESM service that routes NDJSON events, transforms them through a persistent Python subprocess worker (`py_worker/transform.py`), and writes NDJSON output via a batched writer protected by a PID lockfile (`.bridge.lock`).

Multiple cascading module, configuration, lockfile, Windows IPC/encoding, and async concurrency faults are currently breaking the service, its CLI, and its test suite.

## Requirements

Diagnose and repair all faults in the workspace so that:

1. The package remains a pure Node.js ES module (`"type": "module"` in `package.json`, zero npm packages) and all ESM imports/exports and JSON configs (`config/routes.json`) load cleanly.
2. Lockfile handling (`src/lock.mjs`) checks PID liveness (`process.kill(pid, 0)`, handling `ESRCH` and `EPERM` properly on Windows):
   - Automatically reclaims stale `.bridge.lock` files whose PID is no longer alive (or whose contents are corrupt).
   - Refuses to start (throwing `BridgeLockError`) when `.bridge.lock` is held by a genuinely live process.
   - Cleanly removes `.bridge.lock` upon shutdown (`stop()` / CLI exit).
3. The Node.js <-> Python stdin/stdout NDJSON subprocess bridge (`src/worker_client.mjs` and `py_worker/transform.py`) faithfully round-trips arbitrary UTF-8 Unicode payloads (including accented letters, CJK, and emoji), nested Windows backslash paths (`C:\Users\...`), multi-chunk large payloads, and Windows CRLF/LF line endings strictly per `README.md`.
4. `BatchWriter` (`src/writer.mjs`) safely handles concurrent `enqueue()` and `flush()` calls without dropping, duplicating, or interleaving NDJSON lines.
5. Both the test suite and the CLI pass cleanly:
   ```
   node test/bridge.test.mjs
   node src/cli.mjs --input data/sample_events.jsonl --output <output.jsonl>
   ```

## Constraints

- Use built-in Node.js ESM modules and Python 3.13 standard library only (zero third-party packages).
- Keep `"type": "module"` in `package.json`.
- Do **not** modify `data/sample_events.jsonl`, weaken tests in `test/bridge.test.mjs`, or simply delete `.bridge.lock` without fixing stale-lock reclamation and live-lock protection in `src/lock.mjs`.
