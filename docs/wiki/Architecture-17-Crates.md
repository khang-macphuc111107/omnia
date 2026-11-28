# Architecture — 17 Pure-Rust Crates

Omnia compiles as a unified **17-crate Rust Cargo workspace** (`edition = "2021"`, `winsqlite3` FFI, `windows-sys`) with zero C++/CMake build steps in active source.

## Core & Subsystem Crates (13)

| Crate | Primary Responsibilities |
| --- | --- |
| `omnia-winsqlite` | Safe `winsqlite3` FFI, SQLite WAL mode, explicit rollback hygiene, and OS `LockFileEx` cooperative process leases. |
| `omnia-core` | RFC 8259 JSON parser/serializer with checked integers, UTF-8/UTF-16 & Vietnamese shorthand/typo normalization, SHA-256/BLAKE3, and secret redactor. |
| `omnia-storage` | `SessionStore` and `HarnessStore` persistence with bounded keyset pagination. |
| `omnia-routing` | Deterministic `DynamicProviderRouter` across all 51 catalog models (default `EffortLevel::Max`), circuit breakers, quota reservations, and zero-mutation `simulate: true`. |
| `omnia-graph` | 2-way all-to-all `PeerMeshGraph` (`A <-> B` duplex mesh, `disjoint_paths`, `max_hops`/`epoch` cycle guards) and `GraphifyIndex` (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`). |
| `omnia-harness` | `ResearchVault` (Local `[S###]` + Global `[G###]` SQLite WAL BM25+RRF RAG), `DeepThink` engine, 12-Artifact `ArtifactOS`, `MemoryGraph`, `SkillRegistry` (22 active + 1,001 Cold Vault + 24 pipelines), `RichComposer`, and additive `SteerQueue` (`token_budget = NULL`). |
| `omnia-connector-gateway` | AdGuard-tolerant loopback HTTP parsing, RFC 9110 §5.3 multi-`Cookie` coalescing, `ProxyHealthState`, and external harness compatibility bridges. |
| `omnia-workspace-ops` | `path_guard`, atomic UTF-8 LF `fs_ops`, `egress` (`Unrestricted`, `PublicOnly`, `LoopbackOnly`, `DenyAll`), `net_diag` (IP/DNS/Proxy/TLS + Speedtest/Bufferbloat `A+..F`), `hardware`, `shell_compactor`, and `process_ops`. |
| `omnia-media-capture` | CDP browser hooks, desktop isolation, OBS v5 framing, and DPI-clamped window capture contracts (`<= 8192 px`). |
| `omnia-remote-control` | Pairing, cryptographic sequencing, and replay-protected remote control primitives. |
| `omnia-agent` | `SuperHarnessManager`, `NativeSuperEngine`, 4-tier Prefix-0 KV invariance, SSE token-progress watchdog, ACP stdio/HTTP/WS, Tree-sitter CST `WorkspaceGraphIndex`, `LazyLspManager`, Hashline/BlockDiff/`apply_patch`, `TurnCheckpointStore`, `PermissionsEngine` (default `Yolo`), QuickJS PTC sandbox, and ConPTY sessions. |
| `omnia-downloader` | `OmniDownloader Pro` / `OmniDrive` multi-stream HTTP, Google Drive, HLS/DASH, smart clip range, `SitePolicyRegistry`, and non-bypass `VisibleHandoffManager`. |
| `omnia-notebook` | NotebookLM++ (`Atelier`) ingestion, citation grounding, Whisper bridge, and `11/11` structured Studio artifact builders (v2 `Quiz`, `MindMap`, `AudioOverview` 2-host turns). |

## Executable & Shell Crates (4 -> 5 Release Binaries)

- **`omnia-cli` -> `omnia.exe`** (`12.389 MiB`, `mimalloc`, standalone build LAST to prevent workspace feature unification bloat).
- **`omnia-studio` -> `omnia-studio.exe`** (`35.695 MiB` with `--features embed-ui`, loopback HTTP/JSON-RPC/WS host serving `ui-v5` with fallback to modular `ui/`).
- **`omnia-runtime` -> `omnia-runtime.exe`** (`15.356 MiB`, strict bound-port loopback provider/catalog runtime).
- **`omnia-native` -> `omnia-native.exe` + `omnia_qa_seed.exe`** (`0.366 MiB` + `0.222 MiB`, Win32 + DWM Dark/Mica + Direct2D + COM UIA + `--studio` WebView2 host).
