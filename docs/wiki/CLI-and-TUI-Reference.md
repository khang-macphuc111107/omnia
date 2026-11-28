# CLI & `ratatui` TUI Reference (`omnia.exe`)

`omnia.exe` is a lean, single-binary Rust CLI and interactive terminal cockpit (**`12.389 MiB`**, warm `--version` **`8.29-10.40 ms`**, `--profile-startup` **`0.08-0.12 ms` / `5.67 MiB` RSS**).

## Core Commands

```powershell
# Version, startup profile & ACP JSON-RPC 2.0 server
omnia --version
omnia --profile-startup
omnia --acp

# Autonomous coding agent (defaults to YOLO / Full-Access / Auto-Approve & effort=max)
omnia run "Refactor parser and run tests" --workspace D:\my-repo
omnia run "Read-only audit" --approval-mode plan --effort xhigh

# Interactive ratatui TUI Cockpit
omnia tui

# Parallel Multi-Model Arena (2-4 models simultaneously)
omnia arena "Compare lock-free queues in Rust vs C++" --models claude-sonnet-5-5,gpt-6.2-sol,gemini-4-carbon --effort max --json

# Default-ON Deep Research, Dual-Tier RAG, Deep Think & 12-Artifact Lifecycle OS
omnia research "Rust 2024 edition async closures" --export
omnia rag sources
omnia rag status
omnia rag query "sqlite wal rollback"
omnia think start "Evaluate lock-free ring buffer design"
omnia lifecycle status

# Bilingual 1,001-Skill Cold Vault & Native Network Diagnostics
omnia skills doctor
omnia skills route "deep research"
omnia skills pipelines
omnia net --offline --json --privacy-mask
```

## Approval Modes

- **Default**: `yolo` (`turbo`, `full-access`, `full`, `unrestricted`, `auto`, `auto-approve`) — zero built-in deny rules, unrestricted cross-workspace paths (`64 MiB` read cap), unrestricted `web_fetch` egress, and automatic tool execution.
- **Explicit Opt-In Strict Modes**: `--approval-mode plan | always-ask | always-ask-cached | write`.

## `ratatui` TUI Highlights (`omnia tui`)

- Status HUD shows live **`YOLO · AUTO`**, **`FOCUS:<MODE>`**, **`GEM:<BADGE>`**, model/effort, CPU/RAM/VRAM/Ports, and `budget:NULL`.
- **`F4`**: 10-state Observatory, Research & Lifecycle side drawer.
- **`F5`**: Global Privacy Mask (redacts IPs, paths, and tokens on screen).
- Key Slash Commands: `/mode`, `/effort`, `/model`, `/arena <m1,m2> <prompt>`, `/persona [list|use <name>|off]`, `/focus <web|academic|code|rag|deep>`, `/fork [label|list|switch <id>]`, `/research`, `/think`, `/lifecycle`, `/skills`, `/net`, `/rewind`, `/help`.
