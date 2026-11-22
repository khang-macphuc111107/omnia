# `omnia-remote-control` (`INT-08`)

Standalone Rust 2021 library implementing the paired two-way remote screen and
input control wire protocol for Omnia (`INT-08`).

## Architecture & Modules

- `src/crypto.rs`: Pure-Rust RFC 2104 HMAC-SHA256 over `sha2::Sha256`,
  constant-time equality and tag verification, domain-separated `SessionKey`
  derivation (with redacted `Debug` and zeroize-on-drop), lowercase hex codec,
  and Base64 helpers (`base64 = "0.23"`).
- `src/pairing.rs`: Explicit two-way pairing handshake (`PairingOffer` and
  `PairingApproval`) preventing scope escalation in either direction, producing
  complementary directional `SessionLease` records (`peer_id`, `allowed_scopes`,
  `outbound_scopes`, `expires_at_ms`, `revoked`, `shared_secret_digest`) and a
  fail-closed `PeerLeaseStore`.
- `src/replay.rs`: Strictly monotonic `SequenceGenerator` starting at `1` and a
  64-packet sliding bitmap `ReplayWindow` rejecting zero, duplicate, and
  out-of-window sequence numbers.
- `src/protocol.rs`: Bounded JSON `FrameEnvelope` and `FramePayload`
  (`ScreenFrameHeader`, `MouseMove`, `MouseClick`, `KeyEvent`, `TouchEvent`,
  `Heartbeat`, `DisconnectNotice`), validating normalized `[0.0, 1.0]` screen
  and touch coordinates, bounded screen/preview sizes, directional scope
  authorization, constant-time MAC verification prior to replay-window
  mutation, and secret-free `AuditRecord` logging via `PeerSession`.
- `src/transport.rs`: Length-prefixed `write_frame` / `read_frame` wire
  framing (`4`-byte big-endian length header capped at `64 KiB` prior to
  allocation) plus authenticated IPv4 loopback TCP helpers (`127.0.0.1:0`).

## Out-of-Source Build & Test (`DOD-06`)

Always configure `CARGO_TARGET_DIR` outside `D:\Omnia`:

```powershell
$env:CARGO_TARGET_DIR = "D:\OmniaData\build\agy-remote-control-20261114"
cargo fmt --manifest-path D:\Omnia\rust\omnia-remote-control\Cargo.toml --check
cargo test --offline --manifest-path D:\Omnia\rust\omnia-remote-control\Cargo.toml
```

Zero `target/` artifacts are ever placed inside `D:\Omnia`.
