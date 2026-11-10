# Original upstream asset previews

Resume of the interrupted original-UI extraction work (2026-11-04).

Run `node scripts/upstream-preview/server.cjs <id>` from the Omnia repository.
The catalog contains 12 application IDs and their original preview ports.
Existing launcher paths delegate to the same implementation.

The server redirects `/` to the exact upstream HTML entrypoint so relative asset
URLs resolve correctly. It never injects markup, invents chat output, simulates
download progress, or returns success for nonexistent APIs. It binds to loopback
and checks canonical paths to contain requests within the selected asset root.

`node scripts/upstream-preview/audit.cjs artifacts/upstream-ui/audit.json`
checks exact byte equality and SHA-256 of the HTTP response against the selected
file, direct local asset references, method rejection, missing APIs, malformed
URLs and path traversal. It uses temporary ports and closes its own servers.
Exit code 1 means at least one application is missing or failed; it is not a
reason to substitute a mock UI.

The JSON report includes `missingAssets`. A root-relative reference such as
Claude's `/manifest.json` is checked literally against the selected artifact
root. If the shipped extraction does not contain that file, the application
stays failed until the original artifact is found; the audit never synthesizes
an equivalent manifest.

## Boundaries

- Original Electron HTML generally requires its preload, IPC and native main
  process. Serving its files over HTTP does not recreate those contracts.
- The IDM page is its original browser-extension capture page. It requires the
  extension runtime and native host. It does not recover the Win32 application
  source. `gui/public` remains a previous reconstruction for reference and is
  no longer served by the original-UI launcher.
- Hermes, OpenCode, OpenHands and Cherry Studio need their upstream build and
  runtime. Missing compiled output causes a clear failure, never TSX-as-JS.
- Orca has only an Omnia reconstruction here; original UI provenance remains
  unresolved. Its old launcher now fails explicitly.
- File counts, unchanged counts over three scans and HTTP 200 do not establish
  completeness, provenance, standalone operation or behavioral parity.
- Catalog roots may traverse existing junctions. They are local evidence paths,
  not portable packaging. Backing up gitlinks does not back up dirty contents
  of embedded repositories.

The master objective remains open: verify provenance against original packages,
build the real source apps, restore their real runtimes, and exercise behavior
for every app. This milestone fixes preview substitution and adds an audit of
asset delivery; it does not mark the full extraction goal complete.
