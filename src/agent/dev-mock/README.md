# Dev mock backend (browser only, never in production)

Run `npm run dev:fast` and open `http://127.0.0.1:1420/?mock=long` to render the real AgentShell with fake data and no Tauri backend. Other scenarios: `?mock=empty` (no sessions) and `?mock=error` (startup failure).
Extra flags: `&stream=0` stops the fake live stream, `&split=1` opens split view, and `&session=<id>` picks which session opens first.
How it works: `src/main.tsx` dynamic-imports this folder only when `import.meta.env.DEV` is set, the page is not in Tauri and the URL has `?mock`. It then fakes `window.__TAURI_INTERNALS__` with `@tauri-apps/api/mocks`, which covers every invoke, event and window call.
Fixtures (`fixtures.ts`) are built to show layout bugs: long, unbroken and CJK/Vietnamese/emoji text, wide code and tables, a 300-line tool output, a subagent, an approval, a plan, diffs, downloads and artifacts.
Overflow scan: `node scripts/ui-overflow-scan.mjs --out <dir>` (see the header of that script).
