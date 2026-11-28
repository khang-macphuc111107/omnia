# Flagship Studio UI (`ui-v5` & `omnia-studio.exe`)

Launch `omnia-studio.exe` (loopback `http://127.0.0.1:8787`) or `omnia-native.exe --studio` (Win32 DWM Mica WebView2 desktop host) for a 100% offline-bundled (`0` external CDN) SolidJS + Tailwind v4 studio across **4 WCAG AA/AAA themes** (`Obsidian`, `Alabaster`, `Blueprint`, `Titanium`; `16/16` Playwright 4x4 checks `>= 5.94:1`).

## Unified 6-App Flagship Capabilities

1. **AI Studio & Parallel Multi-Model Arena (`AI Studio & Arena` tab)**:
   - Compare **2-4 models in parallel** (`POST /api/v5/arena/compare`) with live TTFT, total latency, tok/s, token breakdown, 6-decimal USD, JSON Schema validation badge, lexical side-by-side diff, and 1-click Winner Vote feeding a persistent SQLite WAL **Elo Leaderboard**.
   - **Parameter & Structured Output Inspector**: Temperature (`0.0-2.0`), Top-P, Max Tokens, Stop Sequences, System Prompt, JSON Schema editor with 4 templates, live pre-send token/cost estimator, **Get Code** (`curl`, Python `httpx`/`openai`, TypeScript `fetch`, Rust `reqwest`), and **Omnia Gems / Personas** CRUD.
2. **Live Interactive Artifact Canvas (`Ctrl+K` -> Canvas / `/canvas` / code block pills)**:
   - Split-pane drawer supporting **Live Preview**, **Editable Code**, **Split**, and **Diff** across HTML, SVG, Mermaid, Markdown, Code, CSV, and JSON.
   - HTML/SVG runs inside `<iframe sandbox="allow-scripts">` with strict offline CSP (`default-src 'none'`; zero CDN), version scrubber (`v1/v2/v3`), download, and inline "Refine in Omnia".
3. **ChatGPT Tree Branching & Claude Thinking/Tool Accordions (`Chat` workbench)**:
   - Defaults to **`SOLO` (YOLO / Full Access / Auto-Approve)**; inline Focus Mode pills (`SOLO YOLO | Perplexity Web | Academic | Deep Research | Deep Think | Arena`), Gem selector, live pre-send cost badge, Voice Dictation, Thread Export (`MD`/`HTML`/`JSON`), `< 1/N >` branch switcher (`Edit & Branch`, `Regenerate`, `Fork Thread`), and collapsible Reasoning + Tool-Call timelines.
4. **Perplexity Pro Answer Engine (`ResearchSourceDrawer` + `POST /api/v5/research/answer`)**:
   - Focus Modes (`web | academic | code | rag | deep`), Top Source Carousel with clickable `[S###]`/`[G###]` citations, auto-generated Related Follow-Up chips, PRISMA ledger, and editable multi-step Deep Research plans.
5. **NotebookLM++ (`Atelier` workbench)**:
   - All `11/11` Studio artifact formats (`audio_overview`, `mind_map`, `flashcards`, `quiz`, `slide_deck`, `data_table`, `infographic`, `briefing`, `study_guide`, `faq`, `timeline`), per-source grounding checkboxes, interactive SVG pan/zoom Mind Map, graded MCQ Quiz, spaced-repetition Flashcards, and 2-Host Podcast Audio Overview player (`SpeechSynthesis`, speed `0.75x-2x`, interactive "Join Podcast" ask).
6. **Observatory, Mission Lifecycle OS, OmniDrive v3.0 & Swarm**:
   - 10-Dimension Observatory (telemetry percentiles, native Rust speedtest/bufferbloat `A+..F`, persistent Router Lab Trip/Reset, live v5 Benchmark Scoreboard, Global Privacy Mask `P`), 12-Artifact Mission Lifecycle OS + Deep Think Lab, 4-Tab OmniDrive Protocol Studio, 1,001-Skill Cold Vault, IDE (`CodeMirror 6` + `xterm.js` ConPTY), and Isolated Browser CDP workbench.
