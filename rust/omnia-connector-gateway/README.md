# `omnia-connector-gateway`

Typed, offline-clean Rust (`edition = "2021"`, `#![forbid(unsafe_code)]`) connector gateway contracts for Omnia across OpenCode, CodexPatched, `htmustc-proxy`, Gemini Notebook, and Google Drive Downloader.

## Modules

- `opencode_compat`: OpenCode WHATWG SSE event stream & `Permission.Request`/`Reply` normalizer, `/v1/responses` MCP namespace lowering & restoration (`functions` pseudo-root guard), strict URL/relative-path validation, and truthful availability reporting (`source_verified` strictly `false` unless `available`).
- `codex_patched`: CodexPatched JSONL rollout parser, `GoalRecord` / `CodexGoalQueueLedger` enforcing `token_budget: Option<u64>` remains `None` unless `explicit_user_budget == true` and `> 0`, zero-drop `ADDITIVE_INTAKE` monotonic `seq` queue, `TurnSteer` validator, and secret/PII/home-path redaction.
- `proxy_router`: Deterministic failover scheduler & 4-state health / circuit-breaker model (`healthy`, `cooldown`, `tripped`, `unavailable`) aligned with `htmustc-proxy` and `DynamicProviderRouter`, exempting `400`/`409`/`413`/`422` client faults and emitting secret-free `RoutingReceipt` payloads.
- `artifact_intake`: Gemini Notebook & Google Drive Downloader canonical intake manifest normalizer with SHA-256 verification, cross-artifact duplicate detection (`ERR_DUPLICATE_ID_HASH_CONFLICT`), archive/Win32 filename/byte-range guards, and mandatory stripping/redaction of `access_bearing_url`, signed URLs, cookies, and PII.
- `gemini_share`: Public Gemini share URL gatekeeper (explicitly refusing `auth_required` / `captcha_blocked`), Google WIZ `batchexecute` (`ujx1Bf` / `otAQ7b`) frame decoder, paginated transcript normalizer (`omnia.gemini-share-transcript.v1`), completeness verification, and strict redaction + prototype-key rejection.

## Verification

All builds and checks use an external target directory:

```powershell
$env:CARGO_TARGET_DIR = "D:\OmniaData\build\agy-connector-gateway-20261114"
cargo fmt --manifest-path D:\Omnia\rust\omnia-connector-gateway\Cargo.toml -- --check
cargo clippy --offline --manifest-path D:\Omnia\rust\omnia-connector-gateway\Cargo.toml --all-targets -- -D warnings
cargo test --offline --manifest-path D:\Omnia\rust\omnia-connector-gateway\Cargo.toml
```
