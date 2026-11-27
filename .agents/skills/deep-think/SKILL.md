---
name: deep-think
description: Use when solving complex algorithms, mathematics, system architecture, subtle concurrency or state bugs, security invariants, high-stakes engineering tradeoffs, or formal proofs requiring multi-hypothesis exploration, executable falsification, and adversarial red-teaming.
metadata:
  short-description: Default-ON multi-hypothesis Deep Think, proofs, and red-team
---

# Deep Think: Multi-Hypothesis Reasoning, Executable Proof & Adversarial Falsification

Activate this Default-ON reasoning protocol (`omnia think` / Studio `DeepThink` engine / agent `deep_think` tool) for non-trivial logic, algorithmic complexity, concurrency, security invariants, distributed state machines, or architectural tradeoffs.

## Phase 1 — Formal Problem & Invariant Framing

Define the problem mathematically before proposing any implementation:
1. **Inputs, Outputs & Domain Bounds**: Exact types, sizes (`N`), latency/RAM/binary-size budgets, empty/null/malformed/overflow cases.
2. **Non-Negotiable Invariants**: Properties that MUST hold across every state transition (conservation, atomicity, idempotency, monotonicity, causal ordering, zero data loss, security/containment boundaries).
3. **Exposed Assumptions**: Explicitly surface hidden premises (clock drift, UTF-8 vs bytes, Windows file locks, single-node vs distributed, KV prefix immutability).
4. **Zero Stale-Fact Guessing**: If any invariant depends on an external API, spec, or library behavior, invoke `$deep-research` immediately to ground facts in primary `[S###]`/`[G###]` sources.

## Phase 2 — Tree-of-Thought Exploration (`>= 3` Distinct Branches)

Never anchor on the first plausible design. Record at least **3 genuinely distinct branches** via `deep_think(action="branch")` / `POST /api/v5/think/branch`:
- **Branch A — Baseline / Battle-Tested**: Lowest operational risk; establishes correctness floor.
- **Branch B — SOTA Optimal**: Best worst-case + amortized complexity, latency, memory footprint, or architectural cleanliness.
- **Branch C — Contrarian / Inversion**: Challenges a core assumption (eliminating mutable state, changing data layout, shifting trust/execution boundaries, precomputing).

Score each branch explicitly on worst-case AND amortized time/space complexity, failure modes under concurrency/partial failures/adversarial input, blast radius, and rollback cost.

## Phase 3 — Executable Proof & Empirical Falsification

Never rely on prose intuition when a deterministic check can prove or break a hypothesis:
1. **Differential Brute-Force Oracle**: Cross-check fast algorithms against exhaustive small-`N` brute-force baselines.
2. **Randomized Property / Fuzz Testing**: Target boundary invariants (`0`, `1`, `N-1`, `N`, duplicate keys, integer overflow, Unicode/CRLF/BOM, out-of-order events, retry storms, mid-crash recovery).
3. **Exact Machine Computation**: Compute arithmetic, contrast ratios, Wilson CIs, McNemar p-values, and byte budgets with scripts rather than mental arithmetic.
4. **Record Falsification Receipt**: Bind the exact command, exit code, and counterexample/pass receipt via `POST /api/v5/think/falsify`.

## Phase 4 — Cross-Model Adversarial Red-Team & Strike Escalation

1. **Active Destruction Pass**: Attempt to construct counterexamples that violate the winning branch's invariants (race conditions, stale caches, permission escalations, resource leaks, partial writes).
2. **Dual-Pool Distinct-Family Critique**: In high-stakes or `/swarm` runs, dispatch an independent verifier/challenger on an opposite model family (`Claude/GPT` vs `Gemini`, via `omnia-routing` `deep_think_primary` / `deep_think_verifier` distinct-family selector) with a clean context to prevent confirmation bias.
3. **3-Strike / 5-Strike Escalation**: After 3 consecutive failed attempts on one branch, force a root-cause rethink and switch branches; after 5 strikes, halt speculative patching, surface exact verified evidence + unknowns, and escalate cleanly.

## Phase 5 — Crisp Grounded Synthesis & 6-State Receipt

Conclude via `POST /api/v5/think/conclude` with zero rambling clutter:
1. **Verified Winner & Invariant Guarantees**: Direct design/answer + proven bounds.
2. **Rejected Alternatives Matrix**: Exact quantitative/invariant reasons losing branches were rejected.
3. **Proof & Epistemic Bands**: Tag assertions `[VERIFIED]` / `[INFERRED]` / `[GAP]` with executable receipts and `[S###]`/`[G###]` or `file://` line citations.
4. **6-State Receipt & Learning**: Emit `Verified | Partial | Unresolved | Blocked | Next | Exact Practical Limits`, and persist non-obvious invariants via `$super-plan-run-lifecycle` (`Lessons` / `Memory`).
