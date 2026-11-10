# Nested repository reference audit

Generated 2026-11-11 from `REFERENCE_AUDIT.json`. The search used repository text files while excluding vendored upstream trees, node_modules, target, artifacts and lock/map files. It is a triage signal, not a proof of semantic dependency.

| Candidate | Text hits | Decision |
|---|---:|---|
| `LocalAppData\OmniaGitResearch` | 1 | manual-review-required |
| `LocalAppData\OmniaResearch\aider` | 20 | manual-review-required |
| `LocalAppData\OmniaResearch\continue` | 4853 | manual-review-required |
| `LocalAppData\OmniaResearch\opencode` | 232 | manual-review-required |
| `repos\omnia\research\upstreams\anthropic-claude-code` | 7 | manual-review-required |
| `repos\omnia\research\upstreams\claude-code` | 436 | manual-review-required |
| `repos\omnia\research\upstreams\claude-code-official` | 4 | manual-review-required |
| `repos\omnia\research\upstreams\deepseek-harness` | 34 | manual-review-required |
| `repos\omnia\research\upstreams\openai-codex` | 71 | manual-review-required |
| `repos\omnia\upstream_extractions\cli\kimi-cli` | 173 | manual-review-required |
| `repos\omnia\upstream_extractions\desktop-apps\cherry-studio` | 314 | manual-review-required |
| `repos\omnia\upstream_extractions\desktop-apps\herdr-app` | 77 | manual-review-required |
| `repos\omnia\upstream_extractions\desktop-apps\herdr-app\vendor\ghostty` | 1273 | manual-review-required |
| `repos\omnia\upstream_extractions\downloaders\gdrive-downloader` | 11 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\herdr-core` | 124 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\herdr-core\vendor\ghostty` | 1273 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\hermes-agent` | 22 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\kimi-code` | 814 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\opencode` | 232 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\openhands` | 2786 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\openhands-agent-sdk` | 7 | manual-review-required |
| `repos\omnia\upstream_extractions\harnesses\openhands-automation` | 36 | manual-review-required |
| `repos\omnia\upstream_extractions\notebooks\gemini-notebook` | 18 | manual-review-required |
| `upstream_tools\rea` | 0 | no-text-reference-found |

## Rule

- Any text hit requires manual path/semantics review before moving.
- A zero-hit result does not prove a repository is unused; generated paths, runtime configuration and non-text references still require inspection.
- No nested `.git` metadata was removed or moved as a result of this audit.
