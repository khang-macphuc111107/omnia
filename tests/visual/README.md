# Visual test scopes

## CI recovery design and plan

The active entrypoint renders `src/rebuild` at every path. Historical visual
tests expect a different renderer at `/__visual` or `/`, including a fixture
readiness attribute and a retired externally hosted editor. Waiting longer for
that marker cannot make the current renderer satisfy those contracts.

The current renderer contract is the default Playwright suite. Historical
assertions and their snapshot files stay intact and can be selected with an
explicit archived host. This keeps the two evidence scopes reviewable.

Alternatives considered:

- Increasing per-test or job timeouts retains the route mismatch and delays the
  failure. Rejected.
- Importing historical UI into the active renderer would cross the original UI
  boundary. Rejected.
- Selecting the matching test and host contract preserves historical assertions
  while checking the app that ships. Selected.

Implementation plan:

1. Reproduce an unchanged fixture contract against the current entrypoint and
   retain its timeout, screenshot and page snapshot.
2. Add a behavioral runner-discovery regression. Watch it reject collecting
   obsolete UI contracts with the current renderer.
3. Select original-renderer contracts by default. Expose historical contracts in
   an explicit config requiring `OMNIA_VISUAL_BASE_URL`.
4. Check current navigation, preview capability boundaries, keyboard/focus,
   theme/draft reload, accessibility and supported viewport geometry. Capture
   actual preview screenshots without replacing historical snapshots.
5. Run the exact default visual command, negative host/config cases and an
   independent source review; record revision, source/log hashes and limitations
   in a new recovery receipt.

Review focus: collecting legacy tests accidentally, a remote editor reappearing,
incorrect native/live claims, lost state after switching/reloading, and missing
reports when a suite stalls.

## Current original renderer

```powershell
npm run test:visual
node --test tests/visual/runner-scope.node.mjs
```

This is browser preview evidence. It does not prove packaged Tauri delivery,
native WebView2, OS permissions or a live provider. Generated screenshots are
test artifacts, not approved screenshot baselines.

## Historical renderer and fixture

The historical specs and `__screenshots__` are retained unchanged. Run them only
against the matching historical renderer/fixture host:

```powershell
$env:OMNIA_VISUAL_BASE_URL = 'http://127.0.0.1:4174'
npx playwright test --config tests/visual/playwright.historical.config.ts
```

The current renderer at `/` is not that host. An explicitly requested
historical contract fails if its readiness/route contract is absent; it is not
silently skipped or relabeled as current renderer coverage.
