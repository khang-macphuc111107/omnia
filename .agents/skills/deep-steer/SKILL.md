---
name: deep-steer
description: Safely steer an active goal, task, or general graph through authorized compare-and-swap mutations, supersession, cancellation, and auditable control receipts.
---

# Deep steer

Use this skill when an operator or authorized agent changes work that is queued, running, paused, blocked, or represented by a general graph. It owns mutation intent and control-plane safety; it does not claim that a provider or process applied the change.

## Classify conversational intake first

The arrival mechanism does not determine intent. If the user says they use
steer to send additional requests quickly, queue additive requirements and
continue the interrupted deliverable before consuming the next item. Apply
current-work corrections at a safe boundary; preserve remaining task IDs and
continuation state. Explicit cancellation, stop or incompatible replacement
still supersedes the named work. An appended planning item is recorded intake,
not a native queue/control receipt. Use the runtime contract below only when
an actual goal/task/run mutation is requested.

## Contract

Capture target goal/task/graph identity, current head revision, requested operation, actor, authority, delegation, reason, affected nodes and edges, expected postconditions, safety boundary, and rollback or compensation plan. Operations include `pause`, `resume`, `reprioritize`, `replace`, `supersede`, `cancel`, `retry`, `rewire`, `add`, `remove`, and `set_policy`.

Require explicit policy for cycles, in-flight work, already delivered effects, unknown outcomes, graph revisions, dependency invalidation, and concurrent operators. Use compare-and-swap expected-head checks and immutable operation records. Reject stale revisions and payload drift instead of silently merging conflicting intent.

Cancel/remove and retry admission must atomically compare the same target head
and generation. Accepted cancellation/removal fences older workers and prevents
new retries; retain a durable tombstone and attempt lineage. Record late
completion as an observation of its original attempt without reviving a
removed target. Reconcile previously transmitted effects independently, and
create a new target identity under fresh authority if work is intentionally
recreated.

## Workflow

1. Read the current goal/task/graph head and lifecycle events.
2. Authenticate the caller and verify authority, delegation, target scope, and effect class.
3. Compute an impact set: affected nodes, queues, leases, dependencies, external effects, and compensations.
4. Simulate the requested mutation against the current graph and policy.
5. Append a mutation intent with idempotency key and expected head; do not overwrite history.
6. Record accepted, rejected, superseded, cancel-requested, or outcome-unknown status.
7. Re-read the head and affected projections; verify postconditions and invariants.
8. If live delivery is claimed, obtain independent provider/process observation; storage receipts alone are insufficient.
9. On conflict or failure, preserve both versions, explain the rejection, and provide a bounded recovery path.

## Evidence receipt

Include caller/session identity, authority source, delegation, target identity, before head/hash, operation payload/hash, affected set, simulation result, CAS result, lifecycle events, after head/hash, conflicts, rollback/compensation pointer, and independent effect evidence. Keep secrets and session data out of artifacts.

## Routing

Use `omnia-goal-planning` for planning and user goal CRUD; `deep-general-graph-orchestration` for graph execution semantics; `deep-authorization-matrix` for authorization policy; `deep-queue` for queue admission/order; `deep-orchestrator` for run lifecycle. A successful control-plane write is not proof of dispatch or completion.

## Definition of done

Steering is complete only when the requested operation is accepted or rejected durably, stale/conflicting mutations are handled, affected state is read back at the expected revision, and any external effect is separately verified or marked unknown.
