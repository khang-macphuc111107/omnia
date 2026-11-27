---
name: deep-research
description: Use when a task requires multi-source web or academic investigation, official specs or docs verification, SOTA or competitive comparison, persistent local and global RAG retrieval, inline citation provenance, or an auditable Sources Searched Viewed and Extracted ledger inside Omnia.
metadata:
  short-description: Default-ON Deep Research, persistent RAG, and S/G citation ledger
---

# Deep Research: Active Web Search, Extraction, Persistent Local/Global RAG & Citation Ledger

Execute this 6-stage Default-ON research pipeline whenever accuracy depends on live web facts, primary specifications, papers, release versions, competitive analysis, or multi-source synthesis (`omnia research` / Studio `ResearchSourceDrawer` / agent `deep_research` tool).

## Stage 0 — Recall Persistent Local & Global RAG + Memory First

Before issuing fresh searches, compound existing verified knowledge:
1. Query **Local Workspace RAG** (`<workspace>/.agents/research/`, `[S###]`) and **Global Vault RAG** (`D:\OmniaData\research-vault\`, `[G###]`) via `deep_research(action="query", scope="local_global")` or `POST /api/v5/rag/query`.
2. Recall prior architectural/domain lessons via `memory_recall` / `POST /api/memory/recall`.
3. Anchor all version, API, pricing, CVE, and benchmark claims to explicit publication and retrieval timestamps — never rely on stale pre-training memory.

## Stage 1 — Orthogonal Axis Decomposition

Split complex topics into **4–8 orthogonal axes** before searching:
- **Primary Specs & Official Docs**: RFCs, vendor docs, changelogs, commit SHAs, source repositories.
- **Peer-Reviewed Papers & Benchmarks**: arXiv, OpenAlex, Europe PMC, reproducible quantitative suites.
- **Production Engineering & Failure Modes**: Postmortems, GitHub issues, latency/memory/cost bounds.
- **Disconfirming Counter-Evidence**: Targeted queries for regressions, tradeoffs, and edge cases.
- **Local Workspace Grounding**: Cross-check against actual repository code (`GraphifyIndex` / CST symbol search).

## Stage 2 — Multi-Backend Parallel Active Search

Run orthogonal queries in parallel with polite per-domain pacing and SSRF protection:
- **Web Backends**: Tavily / Exa / Brave (when configured via CredMan/env) + DuckDuckGo HTML SERP + Wikipedia.
- **Academic Backends**: arXiv Atom API + OpenAlex Works API + Europe PMC REST API.
- **No Silent Bypass**: Never attempt CAPTCHA solving, paywall circumvention, or credential scraping. Classify failures honestly using the typed taxonomy: `NeedLogin` (`[AUTH_REQUIRED]`), `PlatformBlocked` (`[BLOCKED_BY_CHALLENGE]`), `RateLimited`, `UpstreamBroken`, `Timeout`, `NotFound`.

## Stage 3 — Live URL Extraction, Redirect Resolution & Persistent RAG Indexing

Do not stop at shallow snippets when primary depth matters:
1. **Fetch & Unwrap Redirects**: Resolve redirect URLs (`grounding-api-redirect/...`) to canonical URLs, extract heading-preserving Markdown (`<article>`/`<main>`, headings, lists, tables, code, `title`, `canonical`, `published_at`), and deduplicate via `xxh3` / SHA-256.
2. **Dual-Tier Persistence**: Save snapshots atomically (`tmp + sync + rename` with Windows AV-lock retry) into Local (`[S###]`) or Global (`[G###]`) SQLite WAL + JSONL/Markdown vault; index heading-aware overlapping chunks for Okapi BM25 + exact-phrase/heading boost + source authority + Reciprocal Rank Fusion (RRF).
3. **Structured Table Extraction**: Cache multi-source search sets under `result_set_id` and project clean comparison columns via `POST /api/v5/research/table`.

## Stage 4 — Iterative Gap-Closing & Executable Verification

1. Query freshly indexed chunks across every sub-question; identify single-source gaps, missing dates, or contradictions.
2. Run 1–3 targeted follow-up waves to resolve gaps or source conflicts with primary documentation.
3. **Executable Ground-Truth Edge**: Whenever a claim is locally testable (version, CLI flag, math, codebase symbol, API contract), verify it with a read-only local probe instead of repeating blog prose.

## Stage 5 — Adversarial Skeptic Audit & 5-Tier Evidence Grading

Record key claims in the vault (`POST /api/v5/research/claim`) with explicit self-consistency checks and grade every consequential assertion:
- **`[VERIFIED]`** — Directly observed in primary source code, verbatim official spec, or local executable test.
- **`[CORROBORATED]`** — Independently confirmed by `>= 2` authoritative primary sources.
- **`[SINGLE-SOURCE]`** — Supported by only one source (cite source ID and publication date).
- **`[CONFLICT]`** — Authoritative sources disagree (state both claims, dates, and divergence cause).
- **`[UNVERIFIED/GAP]`** — Insufficient reliable evidence; state exact gap or `[BLOCKED_BY_CHALLENGE]` / `[AUTH_REQUIRED]` boundary honestly.

## Stage 6 — Inline Citations, Mandatory Source Ledger & Dossier Export

1. Attach inline **`[S###]`** (local/web extracted) and **`[G###]`** (global persistent RAG) citations to every factual, numeric, or comparative claim.
2. Include a mandatory **"Sources (Searched, Viewed & Extracted)"** PRISMA-grade ledger listing every inspected source with ID, canonical URL/path, domain, status (`searched` | `viewed` | `extracted` | `ingested` | `blocked` | `failed`), reliability tier, SHA-256/excerpt, and retrieval date.
3. Export substantial investigations via `GET /api/v5/research/export?format=markdown|json` and retain durable architectural takeaways into `Memory` / `Lessons`.
