# Omnia nested repository registry

Generated from `REPO_REGISTRY.json` on 2026-11-11. This is an inventory and classification receipt; it is not proof that a repository is safe to flatten.

| Path | Class | GiB | Dirty entries | Branch | Metadata |
|---|---|---:|---:|---|---|
| `repo-original-20261001` | independent-product | 0.016 | 2 | `master` | directory |
| `_cleanup-quarantine-20261013\repos\omnia-research\harnesses\deepseek-harness` | other | 0.089 | 0 | `` | directory |
| `_cleanup-quarantine-20261013\repos\omnia-research\harnesses\openai-codex` | other | 0.092 | 0 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-latest\00` | other | 5.325 | 2 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-latest\01` | other | 0.218 | 43 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-latest\02` | other | 0.019 | 51 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-latest\03` | other | 0.077 | 1 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-rFQ20n\00` | other | 5.325 | 2 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-rFQ20n\01` | other | 0.218 | 43 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-rFQ20n\02` | other | 0.001 | 50 | `` | directory |
| `backups\omnia-dirty-trees-Qo2K58\restore-rFQ20n\03` | other | 0.077 | 1 | `` | directory |
| `LocalAppData\OmniaGitResearch` | other | 0.059 | 0 | `` | directory |
| `LocalAppData\OmniaResearch\aider` | other | 0.136 | 0 | `` | directory |
| `LocalAppData\OmniaResearch\continue` | other | 0.441 | 0 | `` | directory |
| `LocalAppData\OmniaResearch\opencode` | other | 0.144 | 0 | `` | directory |
| `repos\omnia` | other | 283.58 | 3158 | `omnia/m0-snapshot` | directory |
| `repos\omnia-public` | other | 0.542 | 0 | `main` | directory |
| `repos\omnia\.skills\leanrea` | other | 0 | 0 | `main` | directory |
| `repos\omnia\.skills\rea` | other | 0.219 | 0 | `main` | directory |
| `repos\omnia\.skills\replica-skill` | other | 0 | 0 | `main` | directory |
| `repos\omnia\.toolchains\openhands-uv-cache\sdists-v10` | other | 0.556 | 0 | `` | gitfile |
| `repos\omnia\.toolchains\proxy-third-party-20261105\grok2api` | other | 0.012 | 0 | `main` | directory |
| `repos\omnia\research\upstreams\anthropic-claude-code` | other | 0.026 | 0 | `main` | directory |
| `repos\omnia\research\upstreams\claude-code` | other | 0.039 | 0 | `main` | directory |
| `repos\omnia\research\upstreams\claude-code-official` | other | 0.026 | 0 | `` | directory |
| `repos\omnia\research\upstreams\deepseek-harness` | other | 0.215 | 0 | `` | directory |
| `repos\omnia\research\upstreams\openai-codex` | other | 0.183 | 0 | `` | directory |
| `repos\omnia\upstream_extractions\cli\kimi-cli` | other | 0.324 | 0 | `main` | directory |
| `repos\omnia\upstream_extractions\desktop-apps\cherry-studio` | other | 4.224 | 0 | `main` | directory |
| `repos\omnia\upstream_extractions\desktop-apps\herdr-app` | other | 16.984 | 1 | `master` | directory |
| `repos\omnia\upstream_extractions\desktop-apps\herdr-app\vendor\ghostty` | other | 0.113 | 0 | `` | gitfile |
| `repos\omnia\upstream_extractions\downloaders\gdrive-downloader` | other | 1.798 | 0 | `master` | directory |
| `repos\omnia\upstream_extractions\harnesses\herdr-core` | other | 2.842 | 0 | `master` | directory |
| `repos\omnia\upstream_extractions\harnesses\herdr-core\vendor\ghostty` | other | 0.113 | 0 | `` | gitfile |
| `repos\omnia\upstream_extractions\harnesses\hermes-agent` | other | 1.97 | 0 | `main` | directory |
| `repos\omnia\upstream_extractions\harnesses\kimi-code` | other | 1.057 | 0 | `main` | directory |
| `repos\omnia\upstream_extractions\harnesses\opencode` | other | 3.925 | 43 | `dev` | directory |
| `repos\omnia\upstream_extractions\harnesses\openhands` | other | 1.856 | 0 | `main` | directory |
| `repos\omnia\upstream_extractions\harnesses\openhands-agent-sdk` | other | 0.388 | 0 | `` | directory |
| `repos\omnia\upstream_extractions\harnesses\openhands-automation` | other | 0.294 | 0 | `` | directory |
| `repos\omnia\upstream_extractions\notebooks\gemini-notebook` | other | 1.304 | 50 | `master` | directory |
| `upstream_tools\rea` | other | 0.853 | 0 | `main` | directory |

## Mutation policy

- `primary-product`, `linked-worktree`, and `recovery-immutable` entries are not flattening candidates.
- `research-upstream` and `upstream-extraction` entries may be relocated only after path-reference audit and a source-preserving manifest.
- A root Git clean status does not imply a child repository is clean.
- The 283.58 GiB primary product tree has 3,158 dirty entries and remains the owning source.
