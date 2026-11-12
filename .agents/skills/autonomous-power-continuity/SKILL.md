---
name: autonomous-power-continuity
description: Execute complex engineering goals end-to-end by hydrating full multi-host history and Graphify bidirectional code-knowledge context first, orchestrating 2-way all-to-all peer-mesh swarms with disjoint ownership, verifying via live runtime and browser QA, and running anti-overconfidence verifier audits.
metadata:
  short-description: Full-context hydration, 2-way peer-mesh swarm, and anti-overconfidence QA
---

# Autonomous Power Continuity

Drive multi-requirement engineering runs to falsifiable completion without partial-context blind spots, 1-way bottlenecks, file-edit collisions, premature victory declarations, or lost follow-up items.

## 1. Full-Context Hydration & Graphify-First Navigation Gate

Before proposing changes or writing code, hydrate the complete operational picture:
- **Conversation & Handoff History**: Read active thread history, prior multi-host session ledgers (Codex, Antigravity App/IDE/CLI, Claude), and collaborator handoff docs so earlier user mandates and subtle corrections are never forgotten.
- **Workspace Governance & Architecture**: Inspect `README.md`, `AGENTS.md`, `GOAL.md`, `DOD.md`, `CHECKPOINT.md`, `DECISIONS.md`, `.gitignore`, and owning source modules directly rather than relying on stale summaries.
- **Graphify Deterministic Graph-First Navigation**: Prefer deterministic AST + docs + SQL schema + config + PDF relationship graphs (`detect -> extract -> build -> cluster -> analyze -> report`) with symmetric **forward and reverse** edge traversal and explicit provenance tags (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) before falling back to noisy whole-repo grep dumps.
- **Linked Resources & External Docs**: Fetch and inspect every user-supplied URL, document, screenshot, or reference repo. Record exact retrieval status (`verified`, `login_walled`, `rate_limited`, `unverified`) honestly—never guess or fabricate unseen document contents.
- **Additive Steer Intake**: Combine with `additive-steer-queue` so mid-run user prompts append to the active requirement ledger without cancelling unfinished work and without setting artificial `token_budget` caps.

## 2. Bidirectional All-to-All Peer-Mesh Swarm & Disjoint Ownership

Model multi-agent collaboration as a **2-way general peer graph (`PeerMeshGraph`, `A <-> B` duplex links)** rather than a rigid 1-way parent-to-child tree or DAG-only pipeline (pair with `deep-general-graph-orchestration`):
1. **All-to-All Duplex Links (`A <-> B`)**: Any agent node (`coordinator`, `worker`, `specialist`, `verifier`, `subagent`) can communicate and negotiate in both directions with any peer (`sibling <-> sibling`, `author <-> build-runner <-> verifier`, `child <-> parent`) using cursor-based `read_since(seq)` wakeup instead of polling loops.
2. **Bounded Cyclic Negotiation**: Permit intentional feedback cycles (such as `author <-> verifier` or `architect <-> specialist` refinement loops) governed by explicit `max_hops`, `epoch`, and measurable convergence predicates.
3. **Disjoint Owned Paths (`disjoint_paths`)**: Give every peer an explicit allowlist of owned files/directories and reject overlapping concurrent write scopes so two linked peers never mutate the same file simultaneously.
4. **Serialized Shared Locks & Targeted Wakeups**: Route workspace-wide compiler/package locks (such as Cargo with externalized `CARGO_TARGET_DIR`) through a single designated runner, wake only the next acting peer(s) on peer-to-peer handoffs, and wake `@coordinator` only on final verified deliverables or cross-lane blockers.

## 3. Live Runtime / Browser QA & Anti-Overconfidence Audit

Treat "it compiled" or "the file was written" as an intermediate checkpoint, never as Definition of Done:
- **Focused + Broad Automated Checks**: Run unit tests, integration suites, schema/frontmatter validators (`quick_validate.py`), formatting checks (`rustfmt --check`), and whitespace/EOL hygiene (`git diff --check`, pure UTF-8 `LF`).
- **Live Surface Verification**: For UI, desktop, CLI, or web deliverables, execute real runtime/window/UIA/browser checks (accessibility controls, layout clipping/DPI geometry, interactive state transitions, offline asset integrity).
- **Independent Read-Only Verifier Pass**: Route completed slices through a separate read-only auditor mandated to hunt for missing requirements, edge-case regressions, broken links, PowerShell/shell escape artifacts, and secret/credential leaks before signing off.

## 4. Continuous Learning & Three-Way Skill Parity

After verified findings, bug root causes, or user workflow corrections:
- Check existing notes and skills first to avoid duplicate boilerplate stubs.
- Record concise, secret-free provenance notes in durable memory and codify reusable procedures as validated skills (`SKILL.md` + `agents/openai.yaml`) synchronized across Codex (`~/.codex/skills`), Omnia (`<repo>/.agents/skills`), and Antigravity (`~/.gemini/config/skills.json` + `~/.gemini/GEMINI.md`).
- Apply `/learn` and continuous skill/rule evolutions directly under the user's standing auto-accept authorization (`ALWAYS_ACCEPT_LEARN`) after structural and secret-redaction validation, without blocking on manual proposal confirmation (while keeping permission and security boundaries intact).
