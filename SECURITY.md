# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `5.x` (`master`) | Active support |
| `< 5.0` (archived snapshots) | Archived / read-only |

## Security Architecture & Boundaries

Omnia separates **local developer autonomy** from **network/storage hygiene**:

1. **Full-Freedom Local Harness (`ApprovalMode::Yolo` Default)**:
   - Omnia's local coding-agent harness defaults to `YOLO / Turbo / Full-Access / Auto-Approve` with empty `PermissionsEngine::default_rules()`, cross-workspace file access, and unrestricted `web_fetch` egress so developers are never artificially blocked by the local harness.
   - Users who want strict local guardrails can explicitly opt into `--approval-mode plan | always-ask | always-ask-cached | write` and `PermissionsEngine::strict_safety_rules()`.
2. **Loopback Server & Protocol Hardening**:
   - `omnia-studio` and `omnia-runtime` bind strictly to loopback (`127.0.0.1` / `[::1]`), reject duplicate `Content-Length` / `Host` / `Origin` request smuggling, enforce `Origin`, `Host`, and `Sec-Fetch-Site` protections, and coalesce RFC 9110 §5.3 multi-`Cookie` headers cleanly.
   - `omnia-studio` `ArtifactCanvasDrawer` renders HTML/SVG previews inside `<iframe sandbox="allow-scripts">` with strict offline CSP (`default-src 'none'`; zero external CDN).
3. **Zero-Secret Hygiene & Non-Bypass Boundaries**:
   - All commits are scanned by `tools/omnia-consolidated-audit/audit.py --secret-scope all` (`0` secrets, `0` credentials, `0` private cookies/profiles).
   - OmniDrive and Research Vault enforce `MANUAL_VISIBLE_BROWSER_ONLY` (`auto_solve_permitted: false`, `[BLOCKED_BY_CHALLENGE]`) and do not automate CAPTCHA solving, DRM circumvention, or unauthorized authentication bypass.

## Reporting a Vulnerability

Please do **not** open public GitHub issues for security vulnerabilities or leaked credentials.

1. Use **GitHub Private Vulnerability Reporting** (`Security -> Advisories -> Report a vulnerability`) on `https://github.com/khang-macphuc111107/omnia/security/advisories/new`.
2. Include the affected crate/route/binary, reproduction steps, and impact assessment.
3. We acknowledge reports within 72 hours and coordinate a verified fix and release advisory.
