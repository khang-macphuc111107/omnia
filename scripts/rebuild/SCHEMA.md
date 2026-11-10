# Rebuild gate schemas

The gate uses JSON so a future agent can resume without relying on chat context.
All paths are repository-relative forward-slash paths. Hashes are lowercase
SHA-256. A passed gate is structural evidence and does not by itself prove
product behavior, native execution or live provider parity.

## DoD

```json
{
  "schemaVersion": 1,
  "criteria": [{
    "id": "RB-001",
    "category": "ui|native|research|...",
    "requirement": "human requirement in one sentence",
    "acceptance": "observable threshold",
    "verification": "exact command/runtime observation",
    "requiredEvidence": ["test", "native", "live", "capture"],
    "dependencies": [],
    "owner": "agent identity",
    "status": "planned|in_progress|partial|blocked|done",
    "mandatory": true,
    "evidence": [{"path": "docs/rebuild/receipts/foo.json", "kind": "test", "sha256": "..."}],
    "review": {
      "author": "implementer",
      "reviewer": "independent-agent",
      "reviewedAt": "2026-11-08T00:00:00.000Z",
      "result": "passed",
      "unresolved": [],
      "evidence": {"path": "docs/rebuild/receipts/review.json", "sha256": "..."},
      "sourceFiles": [{"path": "src/rebuild/example.tsx", "sha256": "..."}]
    },
    "blockers": []
  }]
}
```

`done` requires every declared evidence kind, zero blockers, all dependencies
done and an independent review. Command receipts are JSON v1 with `result:
"passed"`, `scope`, `recordedAt`, `command`, `exitCode: 0`, a hashed `output`
file, and hashed `sourceFiles`. `native` and `live` scopes cannot be replaced by
preview/fixture. `capture` additionally binds actual media and environment.

## Research

`SOURCE_REGISTER.json` keeps `{schemaVersion:1,sources:[...]}`. New cycle
research entries add `canonicalRepo`, `revision`, `license`, `query`,
`retrievedAt`, `path`, `sha256`, `observation`, `strength`, `weakness`,
`impact`, `decision` (`apply|reject|defer`) and `sourceEvidence` with the same
hash. Identity is canonical repo + revision + exact source path; content hashes
also reject repeated material. The cycle records the baseline and requires a
fresh timestamp and source each research stage.

## Cycle

`cycle.mjs --new --id ... --criterion RB-001 --author ...` creates a cycle at
`resume`. Ordered transitions are `resume → audit → research → synthesize → plan
→ implement → verify → review → document → publish → next`. Skipping stages,
missing receipts, stale canonical-document hashes, self-review and unresolved
blockers fail. `--failure --reason` increments generation and returns to
`implement`; `--cancel --reason` records a terminal cancellation. A milestone
never changes the DoD status automatically.
