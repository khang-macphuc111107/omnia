# `omnia-media-capture` (`INT-07`)

Standalone Rust 2021 contract library for truthful browser CDP discovery, Win32 window capture identity & frame receipt verification, and OBS Studio WebSocket v5 (`obs-websocket` 5.x) framing & challenge-response authentication.

## Modules

- [`src/capability.rs`](src/capability.rs): `CapabilityStatus::{Available, Unavailable, Blocked, StaleTarget, Error}`, machine-readable `CapabilityReason` codes, `CapabilityReport` (enforcing `source_verified == false` whenever `status != Available`), shared loopback URL validation, and bounded loopback TCP/HTTP probes (`probe_loopback_tcp`, `probe_loopback_url_tcp`).
- [`src/browser_cdp.rs`](src/browser_cdp.rs): `validate_loopback_cdp_url` (`127.0.0.1` / `localhost` / `[::1]` unless opted in via `CdpEndpointPolicy`), `parse_cdp_version` (`/json/version`), `parse_cdp_list` (`/json/list`), and live loopback `probe_cdp_endpoint`.
- [`src/window_capture.rs`](src/window_capture.rs): `WindowIdentity { hwnd, pid, process_create_time_100ns, title, width, height, minimized }`, `validate_window_target`, `validate_capture_receipt`, and `evaluate_capture_receipt` detecting stale HWND/PID reuse, minimized (`Blocked`) or zero-area (`StaleTarget`) windows, geometry drift, SHA-256/byte-size mismatches, and blank/all-zero/uniform frames.
- [`src/obs_v5.rs`](src/obs_v5.rs): `obs-websocket` 5.x codec (`parse_hello_op0`, `build_identify_op1`, `parse_identify_op1`, `build_request_op6`, `parse_request_op6`, `parse_request_response_op7`), `compute_obs_v5_auth` (`Base64(SHA256(Base64(SHA256(password + salt)) + challenge))`), `validate_obs_ws_url`, and `probe_obs_endpoint`.

## Out-of-Source Build & Verification (`DOD-06`)

Always build and test with an external `CARGO_TARGET_DIR` outside `D:\Omnia`:

```powershell
$env:CARGO_TARGET_DIR = "D:\OmniaData\build\agy-media-capture-20261114"
cargo fmt --manifest-path D:\Omnia\rust\omnia-media-capture\Cargo.toml --check
cargo test --offline --manifest-path D:\Omnia\rust\omnia-media-capture\Cargo.toml
```

Zero `target/` artifacts belong inside `D:\Omnia\rust\omnia-media-capture\`.
