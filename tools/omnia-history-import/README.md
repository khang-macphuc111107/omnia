# Omnia history import

`import_history.py` creates a redacted, provenance-preserving manifest from
Codex and Antigravity metadata. It never copies raw chat bodies into the
repository. The default output directory is `D:\OmniaData\history\omnia`
when that volume exists, otherwise `~/.omnia-history`.

The manifest records source hashes, metadata and transcript availability,
redaction state, and explicit `verified`, `partial`, `blocked`, and `next`
states. Metadata-only indexes remain `partial`; the importer does not infer
that all chat bodies were acquired.

Each successful non-dry run writes immutable manifest, receipt, body, and index
artifacts whose filenames contain their SHA-256 values. `history-active.json`
is the authoritative generation selector. It records the exact manifest and
receipt filenames and hashes; the manifest and receipt also bind the body and
index hashes. Readers verify the selected artifacts, schemas, paths, byte
counts, and index spans before consuming history bodies.

Before advancing the active pointer, publication preserves the newest fully
verified prior pointer as `history-active.previous.json`. Readers can recover
from that pointer when the active pointer is missing or invalid. Recovery
still validates every artifact referenced by the previous pointer; it does not
trust a pointer merely because its filename contains `previous`.
If either pointer exists but no referenced generation validates, alias repair
fails explicitly instead of preserving a stale compatibility alias.

`history-manifest.json` and `history-receipt.json` are compatibility derivatives
and never select an authoritative generation. If a prior process stopped after
changing one derivative, the next run repairs both only from a fully verified
active or previous pointer generation.

Writers hold a nonblocking operating-system lock on `history-import.lock`
through discovery and publication. The stable lock file is not replaced or
deleted during normal operation; its byte lock is released when the process
closes the descriptor or exits. A competing writer fails with
`history_import_in_progress`.

Source inventories remain partial when transcript bodies are missing,
unsupported, truncated, mutable, or otherwise incomplete. Successful
publication proves artifact consistency for that snapshot; it does not prove
acquisition of all Codex or Antigravity history.

AGY surface extraction is selected from the storage shape rather than a fixed
surface-name allowlist. A root is sent through the schema-aware extractor when
it contains `conversation_summaries.db` or a `conversations` directory, so
development and future profile roots receive the same summary and trajectory
handling as the desktop and CLI roots. A root containing only migration
markers or unrelated files remains an explicit filesystem inventory.

Canonical conversation identities merge observations from multiple surfaces.
Each record keeps `details.source_evidence` as a sorted, duplicate-free list of
the original source name, path, snapshot hash, metadata kind, and summary hash.
An already merged record keeps those observations when imported again; its
combined display fields do not become a new source observation.

Codex rollout files are discovered below `codex_root/sessions` and streamed
without loading the tree into memory. Both plain `.jsonl` and Zstandard
`.jsonl.zst` files are supported. The importer extracts the verified
`event_msg`/`item_completed` `UserMessage` and `AgentMessage` shapes and keeps
other event types, malformed lines, decoder failures, identity mismatches, and
limit hits as explicit partial evidence. `response_item` entries are not
replayed because the sampled rollout shape contains duplicate message
observations. Each rollout file receives a source hash, and body index
provenance binds that hash to the messages observed from the file.

The rollout scan is bounded by `MAX_ROLLOUT_FILES` (100,000 files),
`MAX_ROLLOUT_LINES` (100,000 decoded lines),
`MAX_ROLLOUT_LINE_BYTES` (16 MiB per line), and
`MAX_ROLLOUT_DECODED_BYTES` (512 MiB per file). Reaching a bound leaves the
affected file and source in `partial` state so a successful publication cannot
be mistaken for complete live-tree acquisition.

```powershell
python -B tools/omnia-history-import/import_history.py
python -B tools/omnia-history-import/import_history.py --dry-run
python -B -m unittest discover -s tools/omnia-history-import -p "test_*.py"
```
