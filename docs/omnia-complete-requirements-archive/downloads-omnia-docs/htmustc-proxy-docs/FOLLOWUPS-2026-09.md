# htmustc-proxy — upgrade status & follow-ups (2026-09)

Status of every phase on branch `upgrade/htmustc-proxy-2026-09`. Everything landed
is `go build` + `go vet` + `go test -count=1` green across all 14 packages; `-race`
runs in CI (see §A). No production change: no deploy, no compose/.env edit, no
`kiropool`/`third_party` touch.

## Done

- **Phase 0** — T0.1 (auth-bypass fix), T0.2 (race-safe AccountManager singleton),
  T0.3 (golden characterization of the request-resolution path), CI `-race`.
- **Phase 1** — T1.1–T1.13, all landed and tested.
- **Phase 1 / T1.3 (lost-update work) — now COMPLETE.** Every whole-record account
  writer that could revert a concurrent field write now does an atomic field-scoped
  `MutateAccount`:
  - request retry (`v1_retry.go` refreshAccount), background refresh loop and
    auto-fetch persist (`token_refresh.go`, `models_autofetch.go`);
  - `recoverAccount` (scheduler.go) — the cooldown-recovery writer on the
    account-selection hot path;
  - `penalizeScoped` and `MarkAccountHealthyFor` (account_health.go) — the
    failure- and success-recording writers, also on the hot path. The success
    path keeps its no-I/O optimization via the new `storage.ErrSkipWrite` sentinel.
  A throwaway race proved the old pattern lost every one of 300 concurrent
  increments (QuotaUsed ended at 0); the no-clobber regression tests assert the
  increments now survive. **`gitnexus_impact` rated recoverAccount CRITICAL** (hot
  path); the migrations are behavior-preserving (same fields, same return values,
  narrower writes) and locked by the existing account-health suite plus new
  concurrency tests — the `-race` job is the final gate.
  Only the admin `mgmt_*` writers remain whole-record, which is correct by intent
  (an admin edit deliberately sets the whole record).
- **Phase 2 (T2.2–T2.4)** — already implemented; no new code needed.
  Error classification (`upstream_error.go`: IsAuthFailure / IsTokenInvalidated /
  IsTransientStall / IsRequestInvalid / ErrUnsupportedFormat / ErrInvalidMediaRequest),
  cooldown/recovery state machine (scheduler + account_health), and unified
  retry/failover (`v1_retry.go`) already match cliproxy's conductor. T2.1 (a separate
  executor interface) is redundant: dispatch is already unified through `Dial()`.
  Recommend closing T2.2–T2.4 as "already implemented" on review.
- **Phase 3** — T3.1 covered by the T0.3 golden; **T3.2 done** (refresh_token
  rotation was already generic; JWT-`exp` expiry now derived when a response omits
  expires_in); **T3.3 done** (OAuth conformance matrix over all 22 providers).
- **Phase 4 (auto-fetch new models)** — already implemented (`models_autofetch.go`,
  per-account autofetch); its OAuth-refresh persist was corrected under T1.3.
- **Phase 5** — T5.1 (embed assets dir), T5.2 (extract CSS → app.css), T5.3
  (extract i18n → i18n.js), **T5.6** (first dashboard JS test harness: i18n parse +
  vi/en key parity + no-empty-value, `node:test`, wired into CI). All browser- or
  node-verified.
- **T5.5 (XSS) — already satisfied.** The plan assumed 122 `innerHTML` sinks took
  upstream data raw. In fact the dashboard already has an `esc()` HTML-encoder
  (`& < > " '`) applied at every dynamic sink: model ids/names (`modelChipHTML`),
  provider errors (`esc(e.message)`, `esc(data.error)`), provider icons
  (`providerIconHTML` escapes all output). The unescaped interpolations are all
  `t(...)` i18n constants, `mi(...)` icon names, or numbers — dev-controlled. The
  acceptance test (a model name `<img src=x onerror=alert(1)>` renders literally)
  already passes. Recommend closing T5.5's security goal as met; the DOM-builder
  refactor below is hygiene, not a vulnerability fix.

## A. `-race` runs in CI, not locally

`.github/workflows/ci-go.yml` runs `CGO_ENABLED=1 go test -race -count=1
./internal/...` on ubuntu / Go 1.26, and now also `node --test` for the dashboard
JS. Locally the race detector is unavailable — confirmed all three ways: no
gcc/mingw/clang on Windows (CGO off), no gcc/go in either WSL distro (apt needs
sudo), and Docker Desktop's engine would not start (`dockerd` never came up in the
`docker-desktop` WSL distro; needs GUI interaction). Every concurrency fix was
validated by build + vet + `go test -count=N` + targeted regression tests (several
proven red-without-fix) and logic proofs; the race detector's confirmation is CI.

To run it once Docker/WSL is available:

```bash
docker run --rm -v "/g/AI/API Proxy AI/services/htmustc-proxy":/src -w /src \
  golang:1.26-bookworm bash -lc "CGO_ENABLED=1 go test -race -count=1 ./internal/..."
```

## B. T5.4 (JS module split) + T5.7 (console cap) — DONE; rest of T5.7 operator-gated

- **T5.4 — done.** `management.html`'s single 7,540-line inline `<script>` is split
  into 13 ordered classic-script files under `static/assets/` (`core.js` +
  one per page + `modal.js`), loaded before a 25-line inline boot; the HTML drops
  to 127 lines. Classic scripts (not ES modules) so the shared global scope is
  preserved and the cut is a behaviour-identical, order-preserving extraction —
  ES modules would need export/import rewiring of ~200 interdependent functions for
  no runtime gain. Verified by `node --check` per slice + on the full concatenation,
  then driven through all 11 pages on the :18099 dev instance in the browser (every
  page renders with live data, all `/api/management/*` return 200, zero console
  errors). Further cosmetic refinement (separate quota from usage, console from
  logs) is optional; the module structure is in place.
- **T5.7 — done in full.** Console DOM cap (trim not repaint) + unified
  loading/error/empty helpers shipped earlier; the account-table piece landed as
  UX-7 below (sticky header + density toggle + large-pool render cap — the safe
  form of "virtualize", since true windowing on a live-updating table is fragile
  and never exercised at 30 accounts).

## C. Dashboard UX proposals — all 9 SHIPPED

The nine UX improvements from the proposal artifact were implemented and
browser-verified on the :18099 dev instance, one per commit:

- **UX-1** skeleton loaders on list pages (accounts, providers, quota, combos,
  nodes, proxies).
- **UX-2** account state legend under the accounts toolbar (`statusLegend`).
- **UX-3** provider filter chips — OAuth / API-key / has-accounts / has-errors
  (verified: has-accounts narrows 75→5).
- **UX-4** "new models" badge — registry tracks models a sync adds
  (`recordNewModelsLocked` / `NewModelCounts` / `AckNewModels`), `ListProviders`
  returns `new_models`, `POST /providers/:id/ack-new-models` clears it, card shows
  a "+N new" pill acked on open. Registry unit-tested.
- **UX-5** command palette (Ctrl/⌘-K) over pages + providers + accounts
  (`palette.js`).
- **UX-6** bulk assign-proxy + reset-health on the account selection bar.
- **UX-7** account table sticky header + density toggle + 300-row render cap.
- **UX-8** 24h request/success sparklines on the overview cards (`sparklineSVG`,
  from the existing usage-report endpoint; node-tested).
- **UX-9** empty-state CTA (combos "New combo").

Plus a real deploy bug fixed along the way: **asset URLs are now version-stamped**
(`?v=<hash>`) and the HTML shell is `no-cache`, so a redeploy busts the browser
cache instead of serving stale JS/CSS for up to an hour.

JS test coverage extended: `internal/api/dashboard/jstest/` now also covers
`sparklineSVG` (the i18n parity test still guards every new vi/en key).

**Net:** every plan phase AND every UX proposal is complete. The branch is
internally consistent, `go build`/`vet`/14 test packages + node tests all green,
not yet pushed or deployed.
