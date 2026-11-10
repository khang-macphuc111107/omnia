# Harness eval suite

Deterministic, offline evals of the real harness (agent loop, built-in tools,
permissions, hooks, checkpoints, compaction, fallback, budget, subagents,
memory). Only the model is replaced by a scripted provider
(`omnia_harness::eval::ScriptedProvider`). No network, no credentials.

Run: `cargo test --offline -p omnia-harness --test eval_suite -- --nocapture`
(prints a summary table; failures are listed per scenario).

## Scenario format (`evals/<name>.json`, `name` must equal the file stem)

- `workspace.files` / `workspace.docx`: fixture written to a temp dir.
- `permission_mode`, `rules`, `tools` (`builtin`, `read_only`, `builtin_memory`, `builtin_task`),
  `hooks` (same shape as the `hooks` object of `.omnia/settings.json`), `config` overrides.
- `approval`: `{decisions: [allow|always|deny...], default, feedback}` answers ask prompts.
- `prompts`: user turns, run in order on one transcript.
- `script`: assistant turns. A request takes the first unused turn of its `kind`
  (`main`, `compaction`, `subagent`) whose `when_model` / `when_last_result_contains`
  match. Turn fields: `say`, `tool_calls`, `usage`, `error`, `times`, `stop`.
  Unmatched requests and unused turns fail the scenario (`allow_unused_turns` opts out).
- `expect`: `run_error`, `stop`, `turns`, `tokens`, `files`, `proposed`/`executed`
  (exact/ordered/includes/excludes/count), `results`/`no_results`, `events`
  (snake_case event tag -> count range), `models_requested`, `requests`
  (system prompt / message checks), `history_len`, `final_text_contains`.
- `restore_checkpoint` + `after_restore`: restore a prompt's checkpoint, check files.
- `requires: ["default_shell"]`: skipped (SKIP) when PowerShell/bash is unavailable.

## Live mode (not run by default, plumbing only)

`run_scenario_with(path, RunOptions { provider: Some(real_provider) })` swaps the
scripted model for any `Provider` and skips script bookkeeping. Build the provider
from a profile in your own harness binary (e.g. gated on `OMNIA_EVAL_LIVE=1`);
the suite itself never does this. Only model-independent assertions (files,
events, permission outcomes) are meaningful live; `models_requested`, exact
`proposed`/`executed` lists and `final_text_contains` are scripted-run checks.
