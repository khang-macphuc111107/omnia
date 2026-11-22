//! `omnia-remote-control` — Paired two-way remote screen and input control protocol (`INT-08`).
//!
//! Security & correctness invariants:
//! - Pure-Rust RFC 2104 HMAC-SHA256 over `sha2::Sha256` with constant-time MAC verification.
//! - Explicit two-way pairing (`PairingOffer` + `PairingApproval`) yielding directional
//!   [`SessionLease`] capabilities with expiry, revocation, and fail-closed defaults.
//! - Sliding 64-packet anti-replay window (`ReplayWindow`) and strictly monotonic outgoing
//!   [`SequenceGenerator`], verified only after cryptographic MAC authentication.
//! - Bounded wire framing (`64 KiB` max envelope) with normalized `[0.0, 1.0]` screen/touch
//!   coordinates and per-direction scope checks.

#![forbid(unsafe_code)]

pub mod crypto;
pub mod pairing;
pub mod protocol;
pub mod replay;
pub mod transport;

pub use crypto::{
    constant_time_eq, constant_time_eq_32, decode_base64, decode_hex_32, derive_session_key,
    encode_base64, encode_hex, hmac_sha256, hmac_sha256_hex, sha256, sha256_hex,
    verify_hmac_sha256_hex, CryptoError, SessionKey, SHA256_DIGEST_BYTES,
};
pub use pairing::{
    complete_pairing_approver, complete_pairing_initiator, CapabilityScope, FrameDirection,
    PairingApproval, PairingError, PairingOffer, PeerLeaseStore, SessionLease, MAX_IDENTIFIER_LEN,
};
pub use protocol::{
    AuditOutcome, AuditRecord, ButtonAction, FrameEnvelope, FramePayload, KeyAction, MouseButton,
    PeerSession, ProtocolError, TouchAction, TouchPoint, MAX_AUDIT_RECORDS,
    MAX_DISCONNECT_REASON_LEN, MAX_DISPLAY_ID, MAX_FRAME_WIRE_BYTES, MAX_INLINE_PREVIEW_BYTES,
    MAX_KEY_CODE_LEN, MAX_PREVIEW_BASE64_LEN, MAX_SCREEN_FRAME_BYTES, MAX_SCREEN_HEIGHT,
    MAX_SCREEN_WIDTH, MAX_TOUCH_POINTS,
};
pub use replay::{ReplayError, ReplayWindow, SequenceGenerator, REPLAY_WINDOW_SIZE};
pub use transport::{
    bind_loopback_listener, configure_stream, connect_loopback, read_frame,
    recv_authenticated_frame, send_authenticated_frame, write_frame, TransportError,
};
