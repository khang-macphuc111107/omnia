# Dynamic provider and model routing requirements

**Status:** `SPECIFICATION_ONLY`  
**Owner:** `PRODUCT-CHAT` / provider-runtime owner  
**Parent:** `OMNIA-ROOT-CLEAN-2026-11-11`  
**Evidence rule:** a configured provider, wrapper, mock, fixture or successful
HTTP response does not qualify the runtime contract.

## Purpose

Select a provider/model route for each request using the request's capability,
quality, privacy, budget, latency and reliability constraints plus current
resource state. The decision must be explainable and replayable without
exposing credentials or private prompt content.

## Inputs

### Request policy

- Required capability: text, vision, audio, tool use, structured output,
  streaming, context length and modality limits.
- Quality target and task risk; deadline and latency budget.
- Privacy, data-residency, retention and authorization boundary.
- Maximum estimated and actual cost, token budget and emergency reserve policy.
- Allowed providers/models, forbidden providers/models and fallback scope.
- Cancellation, retry and idempotency key.

### Provider/model registry

Each route candidate needs a stable ID, provider ID, model ID, adapter family,
capabilities, context/output limits, pricing version, region/data policy,
credential reference (never the secret), enabled state, compatibility notes and
last qualification receipt. Registry metadata is not health proof.

### Resource state

Record a time-bounded snapshot for each candidate:

- Remaining quota and quota window, reservation amount and emergency reserve.
- Estimated cost, reconciled cost, currency/unit and missing-usage semantics.
- EWMA and p95 latency, timeout/error rate, retry-after and rate-limit state.
- Circuit state (`closed`, `open`, `half_open`), last success/failure and
  freshness timestamp.
- Concurrent reservation count, capacity limits and stale-data marker.

Unknown, stale or contradictory values must remain explicit. Do not silently
convert unknown quota or usage to zero.

## Decision and execution contract

1. Normalize the request and policy without changing user meaning.
2. Filter candidates by authorization, privacy, capability and compatibility.
3. Reject candidates with stale or insufficient quota unless an explicit
   emergency policy allows them.
4. Estimate tokens/cost and reserve quota atomically with an idempotency key.
5. Score eligible candidates deterministically using the recorded policy:
   capability fit, privacy fit, remaining budget, latency health, reliability,
   user preference and route priority. Ties resolve by stable candidate ID.
6. Append a **route decision receipt** containing policy hash, candidate
   snapshot hashes, score inputs, selected route, rejected reasons, reservation
   ID, deadline and limits. Do not include prompt text or secrets.
7. Dispatch with cancellation and retry fencing. A retry must not spend a
   second reservation unless reconciliation proves the first attempt did not
   reach the provider or a new reservation is explicitly admitted.
8. Append an **outcome receipt** containing attempt ID, provider response class,
   observed usage or `usage_unknown`, actual cost or `cost_unknown`, latency,
   retry-after, cancellation state, reconciliation result and release/charge.
9. Reconcile the reservation exactly once. A late provider response must be
   fenced from a cancelled or superseded run.
10. Update health metrics and preserve the route decision for replay/audit.

## Failure and recovery cases

The implementation and tests must cover:

- no eligible route after privacy/capability filtering;
- quota exhausted, quota stale, quota window rollover and emergency reserve;
- simultaneous reservations and idempotent duplicate dispatch;
- provider outage, timeout, retry-after storm and circuit transitions;
- estimate/actual cost mismatch and missing usage headers;
- partial stream, cancellation, client disconnect and late remote outcome;
- fallback that would cross a privacy, region, authorization or capability
  boundary;
- model disabled or registry/pricing revision changed after reservation;
- restart between reservation, dispatch and reconciliation;
- unknown remote outcome requiring explicit operator/recovery state.

## Storage and ownership rules

Before adding tables or duplicate ledgers, inspect and map the existing
`provider_profiles`, `provider_models`, message token/cost fields, generations,
run attempts and append-only run journals. Extend one owning model when its
invariants fit; otherwise record a migration and compatibility plan. Never
store raw credentials, prompt bodies or access-bearing URLs in receipts.

Receipts must be append-only or content-addressed, have schema versions,
monotonic timestamps/sequence IDs, source revision and redaction rules. A
reconciliation record must point to its reservation and outcome IDs.

## Metrics and acceptance

The route implementation must report, by provider/model and policy class:

- reservation success/failure and stale-state rate;
- estimated versus actual tokens and cost, including unknown usage;
- p50/p95/p99 latency, timeout/error and retry-after rates;
- circuit transitions, fallback frequency and privacy-boundary rejections;
- orphaned reservations, unreconciled outcomes and recovery age.

Acceptance requires:

- deterministic decisions from a frozen registry/resource snapshot;
- atomic concurrent reservation and exactly-once reconciliation;
- privacy-safe fallback and authorization checks;
- restart and late-outcome recovery;
- receipts that permit independent replay without secrets;
- real provider or packaged-runtime evidence for each claimed path.

Unit and fixture tests may establish local invariants, but they do not prove
provider delivery, quota truth, billing accuracy or production latency. Those
remain separately labelled runtime evidence.
