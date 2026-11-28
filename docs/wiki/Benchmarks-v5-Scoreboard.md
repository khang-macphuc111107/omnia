# Benchmarks & v5 Scoreboard

Omnia includes a reproducible, Windows-native multi-axis benchmark harness under `tools/omnia-benchmark/` with zero-overhead telemetry proxy verification and independent integrity auditing (`D:\OmniaData\qa\v5-verify\wave3-final-audit.json`: `6/6` scopes PASS, `0` findings, `0` leaks, `0` `429`s, `0` secrets).

## Headline Results (`FINAL_SCOREBOARD_V5`)

| Benchmark Track | Verified Outcome |
| --- | --- |
| **Suite v5 (`502` trials, `4,859` wire rows)** | **`omnia` #1 `69/76 = 90.79%`** (`12.389 MiB` binary, `8.29-10.40 ms` `--version`, `80.6 MB` med RSS, `77.95%` KV) — statistically significant lead over all 6 peers (`goose 38.16%`, `codex 33.33%`, `opencode 32.89%`, `claude 27.14%`, `omp 18.18%`, `dsh 10.61%`, McNemar `p < 1e-5`). |
| **9/9 Windows-Runnable Public Suites (`146` rows)** | `omnia` #1 or tied #1 on `6/8` head-to-head agent suites at `5x-9x` lower RSS (`aider_polyglot 6/6`, `bfcl_v4 7/8`, `compaction_bench 5/6`, `longmemeval` #1 mean `0.4666`, `locomo 1/2`, `aa_lcr 3/6`, `livecodebench 4/6`, `tau2_bench 4/8`). |
| **All-51 HTMUSTC Models Catalog (`80` parallel trials)** | All `51/51` listed models probed (`20` live coding LLMs benchmarked in parallel; `31` returned upstream `HTTP 403` key-scope limits). `omnia` #1 Claude `5/7` (`65 MB` RSS), tied #1 GPT `6/10` (`8.3x` lower RSS than `codex`), Gemini `5/6` (`83.3%`). |
| **5-Level Effort Sweep (`low / medium / high / xhigh / max`)** | `65` parallel trials: `omnia` `5/5 (100%)` on `claude-sonnet-5-5`, `4/5` on `gpt-6.2-sol` (`48.1 MB` RSS), `10/10` on `gemini-3.8-flash`, `8/10` on `gemini-4-carbon`. |

## Honest External Boundaries (`DEFERRED_BOUNDARY`)

- Official Linux container grades for **`Terminal-Bench 4.1`** and **`SWE-bench Verified/Pro`** require Docker, Podman, or WSL2 Linux containers unavailable on the verification Windows host and remain honestly marked `DEFERRED_BOUNDARY` (never fabricated).
- See the live interactive scoreboard inside `omnia-studio.exe` (`Observability -> Benchmarks` tab) or the `FINAL_SCOREBOARD_V5.md` artifact attached to the `v5.0.0` GitHub Release.
