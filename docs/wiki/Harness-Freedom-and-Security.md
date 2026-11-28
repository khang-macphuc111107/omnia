# Harness Freedom & Security Model

Omnia draws a sharp, transparent distinction between **unrestricted local harness autonomy** and **server/storage/third-party integrity**.

## 1. Local Coding-Agent Harness: Full Freedom by Default (`Steer #22`)

The agent harness should never artificially censor prompts or block local developer workflows. Upstream model APIs enforce their own model-side policies; Omnia's harness executes your authorized instructions cleanly:

- **Default Mode**: `ApprovalMode::Yolo` (`yolo`, `turbo`, `full-access`, `full`, `unrestricted`, `auto`, `auto-approve`) with `workspace_trusted = true` across `omnia` CLI, `omnia tui`, ACP stdio/HTTP, `omnia-studio`, and `ui-v5` (`SOLO`).
- **Zero Built-In Deny Rules**: `PermissionsEngine::default_rules()` returns an empty list (`Vec::new()`).
- **Unrestricted Paths & Egress**: In `Yolo`, `resolve_tool_path` allows cross-workspace absolute paths and symlinks, raises `MAX_READ_FILE_BYTES` to `64 MiB`, disables heuristic D6 taint downgrades, and defaults `web_fetch` / `research_vault` to `EgressPolicy::unrestricted()` (permitting `localhost`, LAN, custom ports, and public HTTP/HTTPS).
- **Explicit Opt-In Strict Mode**: Users who want strict containment or confirmation prompts can pass `--approval-mode plan | always-ask | always-ask-cached | write` or configure `PermissionsEngine::strict_safety_rules()`.

## 2. Loopback Server & Artifact Isolation

- `omnia-studio` and `omnia-runtime` bind strictly to loopback (`127.0.0.1` / `[::1]`), reject malformed HTTP smuggling (`Content-Length` / `Host` / `Origin` duplicates), enforce `Origin` / `Host` / `Sec-Fetch-Site` protections (`omnia-runtime` strictly bound-port), and coalesce RFC 9110 §5.3 multi-`Cookie` headers.
- `ArtifactCanvasDrawer` previews execute in `<iframe sandbox="allow-scripts">` with strict offline CSP (`default-src 'none'`; zero external CDN).

## 3. Privacy, Zero-Secret Hygiene & Third-Party Non-Bypass

- Repository commits are gated by `tools/omnia-consolidated-audit/audit.py --secret-scope all` (`0` secrets, `0` credentials, `0` private cookies/profiles).
- OmniDrive and Research Vault enforce `MANUAL_VISIBLE_BROWSER_ONLY` (`auto_solve_permitted: false`, `[BLOCKED_BY_CHALLENGE]`) — Omnia never automates CAPTCHA solving, DRM circumvention, or unauthorized login bypass.
