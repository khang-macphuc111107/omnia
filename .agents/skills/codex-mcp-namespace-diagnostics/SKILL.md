---
name: codex-mcp-namespace-diagnostics
description: Diagnose and repair Codex unsupported call MCP/collaboration dispatch failures, /v1/responses SSE namespace stripping, code_mode V8 text() execution, Windows MCP cold-start timeouts, and logs_2.sqlite plugin/skill manifest warnings.
metadata:
  short-description: Codex MCP namespace routing, code_mode contract, and manifest audit
---

# Codex MCP Namespace & Runtime Diagnostics

Use this workflow whenever Codex tools (`mcp__*`, `collaboration`, `clock`) fail with `unsupported call`, MCP namespaces detach at turn start, or `logs_2.sqlite` reports startup manifest, skill, or hook warnings.

## 1. Four-Layer `unsupported call` Triage

Isolate the exact failure layer before mutating configuration:

1. **Native Binary / CLI Check**: Verify the underlying binary directly (for example `agent-browser --version`, `agent-browser doctor`) without touching user browser sessions.
2. **One-Shot Stdio JSON-RPC Handshake**: Send `initialize` and `tools/list` over stdio to confirm protocol version and tool schemas.
3. **Router Namespace Audit (`router.rs:365`)**:
   - In Codex `0.167.0+`, all MCP servers, `clock`, and `collaboration` are wrapped in `"type": "namespace"`.
   - Every `/v1/responses` `function_call` item MUST carry `"namespace": "<ns>"` alongside `"name": "<inner_tool>"`. If a third-party gateway strips `"namespace"`, `router.rs:365` emits `unsupported call: <inner_tool>`.
   - Verify the local namespace-restoring proxy shim health (`http://127.0.0.1:18789/healthz` -> `~/.codex/proxy/htmustc-namespace-shim.mjs`) and ensure pseudo-namespace `ns.name == "functions"` in `additional_tools` (`catalog_tool_message.rs:37`) stays mapped to root functions (never `function_call.namespace = "functions"`).
4. **Bounded Ephemeral Probe**:
   - Always pass `stdin=DEVNULL` and `-c model_providers.<provider>.request_max_retries=1 -c model_providers.<provider>.stream_max_retries=1` when running `codex.exe exec --ephemeral` so probes never hang on open stdin or high retry caps.

## 2. `features.code_mode = true` & Collaboration Rules

- **Output Helper**: Inside Codex `exec` (V8 isolate), emit text with **`text(value)`** (never `output_text(value)`, which throws `ReferenceError`, and never `console.log`).
- **Direct Tool Boundary**: `collaboration` tools (`spawn_agent`, `wait_agent`, `list_agents`, `followup_task`, `send_message`) and `cua_repl` are excluded from `globalThis.tools`; invoke them as direct tool calls through a namespace-preserving `/v1/responses` endpoint.

## 3. Windows Host & Manifest Hygiene

- **MCP `npx` Cold-Start**: Rust `Command` resolves `PATHEXT`, so bare `npx` does not cause `WinError 2`, but cold package resolution can exceed Codex's 10s default handshake timeout and detach deferred namespaces. Use `command = "npx.cmd"` and `startup_timeout_sec = 30`.
- **Plugin & Skill Manifest Limits (`logs_2.sqlite`)**:
  - Keep `.codex-plugin/plugin.json` `interface.defaultPrompt[*]` `<= 128` characters.
  - Keep `agents/openai.yaml` `icon_small` / `icon_large` under `./assets/<icon>` (or resolving strictly inside `<plugin_root>/assets/`).
  - Run `quick_validate.py` on all `SKILL.md` files (keep custom keys nested under `metadata:`).
- **Antigravity CLI (`agy`)**: Check presence on Windows PowerShell with `Get-Command agy -ErrorAction SilentlyContinue`, and always pass Go `time.Duration` units to `--print-timeout` (for example `10m` or `600s`; default is `0s`).
