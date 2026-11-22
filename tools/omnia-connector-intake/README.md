# Omnia Connector Intake (`tools/omnia-connector-intake`)

Deterministic Python 3 standard-library contracts and CLI normalizing non-secret intake payloads from verified external sources into Omnia C++20 schemas:

1. **Proxy Route & Circuit-Breaker Normalizer (`normalize_proxy_route_config`)**
   - Source contract: `D:\htmustc-proxy` (`internal/config/config.go`, `internal/api/handler/mgmt_account_redact.go`, `internal/proxy/scheduler.go`, `internal/proxy/account_health.go`, `internal/proxy/upstream_error.go`, `internal/proxy/combo.go`).
   - Target schema: Omnia `DynamicProviderRouter` (`cpp/include/omnia/routing/dynamic_router.hpp`).
   - Enforces allowlist-first credential sanitization (refusing/redacting literal `Bearer`, `sk-`, `AIza`, `ghp_`/`github_pat_`, PEM, cookie, password, and query/userinfo secrets while accepting `${ENV_VAR}`/`env:VAR`), TLS/SSRF endpoint inspection, duration bounds, client-fault exemption (`400/409/413/422`), combo fallback cycle detection, and rejection of spoofing/anti-bot bypass options.

2. **Notebook Conversion & Citation Validator (`validate_notebook_bundle`)**
   - Source contract: `Gemini Notebook` (`src/manifestGenerator.js`, `src/sourceIdentity.js`, `src/ingestionEngine.js`, `src/richPreviewService.js`, `src/interactionStore.js`).
   - Target schema: Omnia `MemoryGraph` & `GraphifyProvenance` (`cpp/include/omnia/harness/memory_graph.hpp`, `cpp/include/omnia/graph/graphify_index.hpp`).
   - Enforces `is_valid_memory_namespace`, path-traversal rejection, private disk-path field stripping (`localPath`, `diskPath`, `fullPath`, `originalPath`), MIME/extension allowlisting, XXE (`<!DOCTYPE`/`<!ENTITY`) guards, chunk/archive-depth limits, encrypted PDF classification, and unambiguous citation target resolution (`remote_id`/`source_id` vs duplicate titles).

3. **Resumable Range & SHA-256 Download Manifest Validator (`validate_download_manifest`)**
   - Source contract: `Google Drive Downloader` (`src/idm_core/idmDynamicSegmenter.js`, `src/omni_drive_pro/resumeJournal.js`, `src/omni_drive_pro/protocolDiagnostics.js`, `src/omni_drive_pro/captureBundleStore.js`, `src/omni_drive_pro/privacyShield.js`).
   - Target schema: Omnia `PayloadBlob` media/attachment intake (`cpp/include/omnia/harness/composer_steer.hpp`).
   - Enforces contiguous byte-range completeness, gap/overlap detection without double-counting, HTTP `If-Range` / ETag strength classification, 64-hex SHA-256 / CRC32C / MD5 format checks, Win32/POSIX filename sanitization (`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`, bidi control removal), tracking query stripping preserving signed parameter names (values redacted), prototype-pollution key rejection, extension origin allowlisting, and `MANUAL_VISIBLE_BROWSER_ONLY` (`drm_supported=false`) boundaries.

## Usage & Verification

Always run Python with `-B` so zero `__pycache__` or `.pyc` files are created inside `D:\Omnia`:

```powershell
# Run focused unit tests
python -B -m unittest discover -s D:\Omnia\tools\omnia-connector-intake -p "test_*.py" -v

# Validate a connector payload in strict mode
python -B D:\Omnia\tools\omnia-connector-intake\cli.py normalize-proxy --input payload.json --strict
python -B D:\Omnia\tools\omnia-connector-intake\cli.py validate-notebook --input bundle.json --strict
python -B D:\Omnia\tools\omnia-connector-intake\cli.py validate-download --input manifest.json --strict
python -B D:\Omnia\tools\omnia-connector-intake\cli.py inspect-bundle --input composite.json --strict
```
