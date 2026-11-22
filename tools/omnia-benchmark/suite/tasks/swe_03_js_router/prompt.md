# Issue Report: ESM Trie Router Precedence Backtracking, `%2F` Decoding & Async Error Middleware Bugs

Work strictly inside the current working directory. This is a pure Node.js ESM (`"type": "module"`) package with zero third-party npm dependencies. You can run the existing public tests with:

```bash
node tests/basic.test.mjs
```

## Background

`mini-trie-router` implements an HTTP trie router and Express-style middleware pipeline across four modules:
- `src/query.mjs`: URL path segmentation, percent-decoding, and query-string parsing.
- `src/trie.mjs`: Segment trie supporting static segments (`/users/settings`), named parameters (`/users/:id`), and terminal catch-all wildcards (`/files/*filepath`, matching 1 or more remaining segments).
- `src/middleware.mjs`: Synchronous and `async` middleware pipeline supporting 3-argument normal middleware `(req, res, next)` and 4-argument error middleware `(err, req, res, next)`.
- `src/router.mjs`: High-level `Router` orchestrating global middlewares, trie matching, route-level handlers, and error handling.

The baseline public test suite passes, but three bugs have been reported in production.

## Bug 1: Trie Precedence & Backtracking After Dead-End Static / Param Prefixes (`src/trie.mjs`)

1. **Strict precedence** at every segment depth must be:
   `static` > `:param` > `*wildcard`
2. **Full backtracking**: If a higher-priority branch (e.g. a `static` child or `:param` child) leads to a dead end — either because subsequent segments do not match OR because the terminal node has no handler registered for the requested HTTP `method` — the trie MUST backtrack and try the lower-priority branches (`:param`, then `*wildcard`) in strict precedence order!
   - Example A: Routes `GET /users/profile/settings` and `GET /users/:id/posts` are registered. Request `GET /users/profile/posts` MUST backtrack out of static `'profile'` and match `/users/:id/posts` with `params = { id: 'profile' }`.
   - Example B: Routes `POST /items/special` and `GET /items/:id` are registered. Request `GET /items/special` MUST backtrack out of static `'special'` (no `GET` handler) and match `GET /items/:id` with `params = { id: 'special' }`.
   - Example C: Routes `GET /api/v1/health` and `GET /api/*rest` are registered. Request `GET /api/v1/unknown` MUST backtrack out of static `'v1'` and match `GET /api/*rest` with `params = { rest: 'v1/unknown' }`.
   - Example D: Routes `GET /files/*path` and `GET /files/:id` are registered. Request `GET /files/doc1` MUST prefer `:param` (`{ id: 'doc1' }`) over `*wildcard`!

## Bug 2: Percent-Encoded `%2F` Split Before Per-Segment Decoding (`src/query.mjs`)

- `parseRequestUrl(rawUrl)` MUST split the raw pathname on literal `'/'` characters **BEFORE** calling `decodeURIComponent` on each individual segment!
- Currently, `decodeURIComponent` is applied to the entire pathname before splitting, which splits `%2F` (`'/'`) into extra path segments and breaks `:param` routes like `/files/:filename/meta` when requested as `/files/docs%2F2026%2Freport.pdf/meta` (which MUST match with `params.filename === 'docs/2026/report.pdf'`).
- Query strings (`?a=1&b=hello%20world`) must continue to be parsed cleanly. If a path segment contains invalid percent-encoding (e.g. `%ZZ`), `parseRequestUrl` should throw a `URIError`.

## Bug 3: Async Error Forwarding & Chained Error Middleware (`src/middleware.mjs`)

In `runPipeline(middlewares, req, res)`:
1. Normal middlewares (`fn.length < 4`, i.e. `(req, res, next)`) and error middlewares (`fn.length === 4`, i.e. `(err, req, res, next)`) may be synchronous OR `async` (returning a Promise).
2. If a normal middleware throws synchronously, returns a rejected Promise (`async` throw/rejection), OR calls `next(err)`, execution MUST enter error mode and skip all remaining normal middlewares until the next 4-argument error middleware `(err, req, res, next)` is invoked with that error.
3. If an error middleware itself calls `next(newErr)`, throws synchronously, OR returns a rejected Promise, the new/forwarded error MUST continue to the **next downstream** 4-argument error middleware (rather than being dropped or skipping downstream error handlers!).
4. If an error middleware calls `next()` (with no error argument), normal execution resumes at the next normal middleware.
5. If an error middleware handles the response without calling `next()` and without throwing/rejecting, the pipeline completes cleanly.
6. If an error reaches the end of the pipeline unhandled, `runPipeline` rejects with that error (which `Router.handle` catches and maps to HTTP 500).

## Requirements

- Fix all three root causes in `src/trie.mjs`, `src/query.mjs`, and `src/middleware.mjs` (and `src/router.mjs` if needed).
- Keep all existing public APIs and `tests/basic.test.mjs` passing.
- Verify with `node tests/basic.test.mjs` plus additional tests covering every scenario above.
