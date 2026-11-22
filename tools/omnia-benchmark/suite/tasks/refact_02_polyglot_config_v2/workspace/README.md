# Polyglot Event Service (Python + Node.js)

Dual-runtime event CLI & library workspace containing:
- `spec/protocol_v2.md`: Target Event Protocol v2 formal specification
- `fixtures/v1_events.jsonl`: Golden legacy v1 event fixture stream
- `py_service/`: Python 3.13 stdlib-only service (`events.py`, `cli.py`, `test_events.py`)
- `js_client/`: Node.js ESM client (`src/events.mjs`, `src/cli.mjs`, `test/events.test.mjs`)

## Running Existing Tests
```bash
python -m unittest py_service/test_events.py -v
node js_client/test/events.test.mjs
```

## CLI Commands (both runtimes)
Python:
```bash
python -m py_service.cli emit --type user.login --tags "web,auth" --payload-json '{"user":"alice"}'
python -m py_service.cli ingest --input fixtures/v1_events.jsonl --output out.jsonl
python -m py_service.cli verify --input out.jsonl
```
Node.js:
```bash
node js_client/src/cli.mjs emit --type user.login --tags "web,auth" --payload-json '{"user":"alice"}'
node js_client/src/cli.mjs ingest --input fixtures/v1_events.jsonl --output out.jsonl
node js_client/src/cli.mjs verify --input out.jsonl
```
