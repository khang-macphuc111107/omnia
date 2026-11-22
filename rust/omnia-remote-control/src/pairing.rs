//! Explicit two-way pairing ceremony, directional capability leases, and fail-closed revocation/expiry checks.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::str::FromStr;

use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, SerializeStruct, Serializer};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::crypto::{
    constant_time_eq, decode_hex_32, derive_session_key, hmac_sha256_hex, push_len_prefixed,
    verify_hmac_sha256_hex, SessionKey,
};

/// Maximum length of peer/session/nonce identifiers in bytes.
pub const MAX_IDENTIFIER_LEN: usize = 128;

/// Capability scopes authorized independently per traffic direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapabilityScope {
    /// Receiving or sending screen frame headers and frame metadata.
    ScreenStream,
    /// Receiving or sending mouse movement and click events.
    MouseInput,
    /// Receiving or sending keyboard input events.
    KeyboardInput,
    /// Receiving or sending touch pointer events.
    TouchInput,
}

impl CapabilityScope {
    /// Canonical wire identifier for this scope.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ScreenStream => "screen_stream",
            Self::MouseInput => "mouse_input",
            Self::KeyboardInput => "keyboard_input",
            Self::TouchInput => "touch_input",
        }
    }
}

impl fmt::Display for CapabilityScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CapabilityScope {
    type Err = PairingError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "screen_stream" => Ok(Self::ScreenStream),
            "mouse_input" => Ok(Self::MouseInput),
            "keyboard_input" => Ok(Self::KeyboardInput),
            "touch_input" => Ok(Self::TouchInput),
            _ => Err(PairingError::InvalidInput(format!(
                "unknown capability scope: {s}"
            ))),
        }
    }
}

impl Serialize for CapabilityScope {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CapabilityScope {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(de::Error::custom)
    }
}

/// Traffic direction relative to the local node holding a [`SessionLease`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameDirection {
    /// Frame received from remote `peer_id` (checked against `lease.allowed_scopes`).
    Inbound,
    /// Frame transmitted by `local_peer_id` (checked against `lease.outbound_scopes`).
    Outbound,
}

impl FrameDirection {
    /// Canonical string representation for diagnostics and audit records.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inbound => "inbound",
            Self::Outbound => "outbound",
        }
    }
}

impl fmt::Display for FrameDirection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Errors raised during pairing, capability negotiation, or lease validation.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PairingError {
    /// Peer or session is not paired or is missing required pairing metadata.
    #[error("unpaired or unknown peer/session (fail closed)")]
    UnpairedPeer,
    /// Pairing offer or lease has been explicitly revoked.
    #[error("session lease revoked: {reason}")]
    LeaseRevoked { reason: String },
    /// Pairing offer or session lease has expired.
    #[error("lease or offer expired at {now_ms}ms (expires_at_ms={expires_at_ms}ms)")]
    LeaseExpired { now_ms: u64, expires_at_ms: u64 },
    /// Peer attempted to request or exercise a scope outside its granted capability set.
    #[error("scope escalation or unauthorized {direction} scope '{scope}' for peer '{peer_id}'")]
    ScopeDenied {
        direction: FrameDirection,
        peer_id: String,
        scope: CapabilityScope,
    },
    /// Pairing approval tried to claim scopes not offered in the pairing offer.
    #[error("scope escalation rejected for {direction} scope '{scope}'")]
    ScopeEscalation {
        direction: &'static str,
        scope: CapabilityScope,
    },
    /// Pairing handshake MAC verification failed.
    #[error("pairing authentication failed (MAC mismatch)")]
    AuthenticationFailed,
    /// Approval metadata did not match the offer metadata.
    #[error("pairing mismatch: {0}")]
    HandshakeMismatch(&'static str),
    /// Session key did not match `lease.shared_secret_digest`.
    #[error("session key digest does not match lease shared_secret_digest")]
    KeyDigestMismatch,
    /// Malformed identifier, nonce, timestamp, or TTL.
    #[error("invalid pairing input: {0}")]
    InvalidInput(String),
}

/// Validates an identifier (`session_id`, `peer_id`, or `nonce`) against safe ASCII bounds.
pub(crate) fn validate_identifier(name: &'static str, value: &str) -> Result<(), PairingError> {
    if value.is_empty() || value.len() > MAX_IDENTIFIER_LEN {
        return Err(PairingError::InvalidInput(format!(
            "{name} length must be within 1..={MAX_IDENTIFIER_LEN} bytes"
        )));
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return Err(PairingError::InvalidInput(format!(
            "{name} contains disallowed characters"
        )));
    }
    Ok(())
}

fn normalize_scopes(scopes: &[CapabilityScope]) -> Vec<CapabilityScope> {
    let unique: BTreeSet<CapabilityScope> = scopes.iter().copied().collect();
    unique.into_iter().collect()
}

fn verify_subset(
    requested: &[CapabilityScope],
    allowed: &[CapabilityScope],
    direction: &'static str,
) -> Result<(), PairingError> {
    for &scope in requested {
        if !allowed.contains(&scope) {
            return Err(PairingError::ScopeEscalation { direction, scope });
        }
    }
    Ok(())
}

/// Authenticated pairing offer created by the initiating peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingOffer {
    pub session_id: String,
    pub initiator_id: String,
    pub target_peer_id: String,
    pub offer_nonce: String,
    /// Maximum scopes the initiator allows `target_peer_id` to send inbound.
    pub offered_inbound_scopes: Vec<CapabilityScope>,
    /// Maximum scopes the initiator offers to send outbound to `target_peer_id`.
    pub offered_outbound_scopes: Vec<CapabilityScope>,
    pub created_at_ms: u64,
    pub offer_expires_at_ms: u64,
    pub lease_ttl_ms: u64,
    pub offer_mac_hex: String,
}

impl PairingOffer {
    /// Creates and authenticates a new pairing offer using a shared pairing secret.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        session_id: impl Into<String>,
        initiator_id: impl Into<String>,
        target_peer_id: impl Into<String>,
        offer_nonce: impl Into<String>,
        offered_inbound_scopes: Vec<CapabilityScope>,
        offered_outbound_scopes: Vec<CapabilityScope>,
        created_at_ms: u64,
        offer_expires_at_ms: u64,
        lease_ttl_ms: u64,
        pairing_secret: &[u8],
    ) -> Result<Self, PairingError> {
        let session_id = session_id.into();
        let initiator_id = initiator_id.into();
        let target_peer_id = target_peer_id.into();
        let offer_nonce = offer_nonce.into();

        if pairing_secret.is_empty() {
            return Err(PairingError::InvalidInput(
                "pairing_secret must not be empty".to_string(),
            ));
        }
        validate_identifier("session_id", &session_id)?;
        validate_identifier("initiator_id", &initiator_id)?;
        validate_identifier("target_peer_id", &target_peer_id)?;
        validate_identifier("offer_nonce", &offer_nonce)?;
        if initiator_id == target_peer_id {
            return Err(PairingError::InvalidInput(
                "initiator_id and target_peer_id must be distinct".to_string(),
            ));
        }
        if created_at_ms == 0 || offer_expires_at_ms <= created_at_ms {
            return Err(PairingError::InvalidInput(
                "offer_expires_at_ms must be greater than positive created_at_ms".to_string(),
            ));
        }
        if lease_ttl_ms == 0 {
            return Err(PairingError::InvalidInput(
                "lease_ttl_ms must be greater than 0".to_string(),
            ));
        }

        let offered_inbound_scopes = normalize_scopes(&offered_inbound_scopes);
        let offered_outbound_scopes = normalize_scopes(&offered_outbound_scopes);

        let mut offer = Self {
            session_id,
            initiator_id,
            target_peer_id,
            offer_nonce,
            offered_inbound_scopes,
            offered_outbound_scopes,
            created_at_ms,
            offer_expires_at_ms,
            lease_ttl_ms,
            offer_mac_hex: String::new(),
        };
        let transcript = offer.signing_bytes();
        offer.offer_mac_hex = hmac_sha256_hex(pairing_secret, &transcript);
        Ok(offer)
    }

    fn signing_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(256);
        buf.extend_from_slice(b"omnia-remote-control:v1:pairing-offer");
        push_len_prefixed(&mut buf, self.session_id.as_bytes());
        push_len_prefixed(&mut buf, self.initiator_id.as_bytes());
        push_len_prefixed(&mut buf, self.target_peer_id.as_bytes());
        push_len_prefixed(&mut buf, self.offer_nonce.as_bytes());
        push_scopes(&mut buf, &self.offered_inbound_scopes);
        push_scopes(&mut buf, &self.offered_outbound_scopes);
        buf.extend_from_slice(&self.created_at_ms.to_be_bytes());
        buf.extend_from_slice(&self.offer_expires_at_ms.to_be_bytes());
        buf.extend_from_slice(&self.lease_ttl_ms.to_be_bytes());
        buf
    }

    /// Verifies offer structure, expiry at `now_ms`, and constant-time MAC.
    pub fn verify(&self, pairing_secret: &[u8], now_ms: u64) -> Result<(), PairingError> {
        if pairing_secret.is_empty() {
            return Err(PairingError::InvalidInput(
                "pairing_secret must not be empty".to_string(),
            ));
        }
        validate_identifier("session_id", &self.session_id)?;
        validate_identifier("initiator_id", &self.initiator_id)?;
        validate_identifier("target_peer_id", &self.target_peer_id)?;
        validate_identifier("offer_nonce", &self.offer_nonce)?;
        if self.initiator_id == self.target_peer_id {
            return Err(PairingError::HandshakeMismatch(
                "initiator_id and target_peer_id must differ",
            ));
        }
        if self.lease_ttl_ms == 0
            || self.created_at_ms == 0
            || self.offer_expires_at_ms <= self.created_at_ms
        {
            return Err(PairingError::InvalidInput(
                "offer timestamps or TTL are invalid".to_string(),
            ));
        }
        verify_hmac_sha256_hex(pairing_secret, &self.signing_bytes(), &self.offer_mac_hex)
            .map_err(|_| PairingError::AuthenticationFailed)?;
        if now_ms >= self.offer_expires_at_ms {
            return Err(PairingError::LeaseExpired {
                now_ms,
                expires_at_ms: self.offer_expires_at_ms,
            });
        }
        Ok(())
    }
}

/// Authenticated pairing acceptance sent by the target peer after verifying [`PairingOffer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingApproval {
    pub session_id: String,
    pub approver_id: String,
    pub initiator_id: String,
    pub approval_nonce: String,
    /// Scopes the approver requests to send outbound to the initiator (subset of `offer.offered_inbound_scopes`).
    pub requested_outbound_scopes: Vec<CapabilityScope>,
    /// Scopes the approver accepts inbound from the initiator (subset of `offer.offered_outbound_scopes`).
    pub accepted_inbound_scopes: Vec<CapabilityScope>,
    pub approved_at_ms: u64,
    pub approval_mac_hex: String,
}

impl PairingApproval {
    /// Verifies `offer`, enforces non-escalation, and produces a MAC-authenticated approval.
    pub fn approve(
        offer: &PairingOffer,
        approver_id: impl Into<String>,
        approval_nonce: impl Into<String>,
        requested_outbound_scopes: Vec<CapabilityScope>,
        accepted_inbound_scopes: Vec<CapabilityScope>,
        pairing_secret: &[u8],
        now_ms: u64,
    ) -> Result<Self, PairingError> {
        offer.verify(pairing_secret, now_ms)?;
        let approver_id = approver_id.into();
        let approval_nonce = approval_nonce.into();

        validate_identifier("approver_id", &approver_id)?;
        validate_identifier("approval_nonce", &approval_nonce)?;
        if approver_id != offer.target_peer_id {
            return Err(PairingError::HandshakeMismatch(
                "approver_id does not match offer.target_peer_id",
            ));
        }
        if approval_nonce == offer.offer_nonce {
            return Err(PairingError::HandshakeMismatch(
                "approval_nonce must not reuse offer_nonce",
            ));
        }
        if now_ms < offer.created_at_ms {
            return Err(PairingError::HandshakeMismatch(
                "approved_at_ms cannot precede offer.created_at_ms",
            ));
        }

        let requested_outbound_scopes = normalize_scopes(&requested_outbound_scopes);
        let accepted_inbound_scopes = normalize_scopes(&accepted_inbound_scopes);

        verify_subset(
            &requested_outbound_scopes,
            &offer.offered_inbound_scopes,
            "approver_outbound",
        )?;
        verify_subset(
            &accepted_inbound_scopes,
            &offer.offered_outbound_scopes,
            "approver_inbound",
        )?;

        let mut approval = Self {
            session_id: offer.session_id.clone(),
            approver_id,
            initiator_id: offer.initiator_id.clone(),
            approval_nonce,
            requested_outbound_scopes,
            accepted_inbound_scopes,
            approved_at_ms: now_ms,
            approval_mac_hex: String::new(),
        };
        let transcript = approval.signing_bytes(offer);
        approval.approval_mac_hex = hmac_sha256_hex(pairing_secret, &transcript);
        Ok(approval)
    }

    fn signing_bytes(&self, offer: &PairingOffer) -> Vec<u8> {
        let mut buf = Vec::with_capacity(256);
        buf.extend_from_slice(b"omnia-remote-control:v1:pairing-approval");
        push_len_prefixed(&mut buf, self.session_id.as_bytes());
        push_len_prefixed(&mut buf, self.approver_id.as_bytes());
        push_len_prefixed(&mut buf, self.initiator_id.as_bytes());
        push_len_prefixed(&mut buf, offer.offer_nonce.as_bytes());
        push_len_prefixed(&mut buf, offer.offer_mac_hex.as_bytes());
        push_len_prefixed(&mut buf, self.approval_nonce.as_bytes());
        push_scopes(&mut buf, &self.requested_outbound_scopes);
        push_scopes(&mut buf, &self.accepted_inbound_scopes);
        buf.extend_from_slice(&self.approved_at_ms.to_be_bytes());
        buf
    }
}

/// Active capability lease bound to a paired peer and session key digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLease {
    pub session_id: String,
    pub local_peer_id: String,
    pub peer_id: String,
    /// Scopes remote `peer_id` is authorized to exercise inbound against `local_peer_id`.
    pub allowed_scopes: Vec<CapabilityScope>,
    /// Scopes `local_peer_id` is authorized to send outbound to remote `peer_id`.
    pub outbound_scopes: Vec<CapabilityScope>,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub revoked: bool,
    pub revocation_reason: Option<String>,
    /// Lowercase SHA-256 hex digest of the derived 32-byte symmetric session key.
    pub shared_secret_digest: String,
}

impl SessionLease {
    /// Checks that the lease represents a paired, non-revoked, unexpired session.
    pub fn is_active(&self, now_ms: u64) -> Result<(), PairingError> {
        if self.session_id.is_empty()
            || self.local_peer_id.is_empty()
            || self.peer_id.is_empty()
            || decode_hex_32(&self.shared_secret_digest).is_err()
        {
            return Err(PairingError::UnpairedPeer);
        }
        if self.revoked {
            let reason = self
                .revocation_reason
                .clone()
                .unwrap_or_else(|| "explicitly revoked".to_string());
            return Err(PairingError::LeaseRevoked { reason });
        }
        if self.issued_at_ms == 0
            || self.expires_at_ms <= self.issued_at_ms
            || now_ms >= self.expires_at_ms
        {
            return Err(PairingError::LeaseExpired {
                now_ms,
                expires_at_ms: self.expires_at_ms,
            });
        }
        Ok(())
    }

    /// Authorizes an inbound or outbound capability against this lease at `now_ms`.
    pub fn authorize(
        &self,
        direction: FrameDirection,
        required_scope: Option<CapabilityScope>,
        now_ms: u64,
    ) -> Result<(), PairingError> {
        self.is_active(now_ms)?;
        if let Some(scope) = required_scope {
            let permitted = match direction {
                FrameDirection::Inbound => self.allowed_scopes.contains(&scope),
                FrameDirection::Outbound => self.outbound_scopes.contains(&scope),
            };
            if !permitted {
                return Err(PairingError::ScopeDenied {
                    direction,
                    peer_id: self.peer_id.clone(),
                    scope,
                });
            }
        }
        Ok(())
    }

    /// Verifies in constant time that `key` matches `self.shared_secret_digest`.
    pub fn matches_key(&self, key: &SessionKey) -> Result<(), PairingError> {
        let digest = key.digest_hex();
        if constant_time_eq(digest.as_bytes(), self.shared_secret_digest.as_bytes()) {
            Ok(())
        } else {
            Err(PairingError::KeyDigestMismatch)
        }
    }

    /// Explicitly revokes this lease so all subsequent checks fail closed.
    pub fn revoke(&mut self, reason: impl Into<String>) {
        self.revoked = true;
        self.revocation_reason = Some(reason.into());
    }
}

fn verify_offer_and_approval(
    offer: &PairingOffer,
    approval: &PairingApproval,
    pairing_secret: &[u8],
    now_ms: u64,
) -> Result<(SessionKey, u64), PairingError> {
    offer.verify(pairing_secret, now_ms)?;
    validate_identifier("approver_id", &approval.approver_id)?;
    validate_identifier("approval_nonce", &approval.approval_nonce)?;

    if approval.session_id != offer.session_id {
        return Err(PairingError::HandshakeMismatch("session_id mismatch"));
    }
    if approval.initiator_id != offer.initiator_id {
        return Err(PairingError::HandshakeMismatch("initiator_id mismatch"));
    }
    if approval.approver_id != offer.target_peer_id {
        return Err(PairingError::HandshakeMismatch(
            "approver_id does not match target_peer_id",
        ));
    }
    if approval.approval_nonce == offer.offer_nonce {
        return Err(PairingError::HandshakeMismatch(
            "approval_nonce must differ from offer_nonce",
        ));
    }
    if approval.approved_at_ms < offer.created_at_ms
        || approval.approved_at_ms >= offer.offer_expires_at_ms
    {
        return Err(PairingError::HandshakeMismatch(
            "approved_at_ms outside valid offer window",
        ));
    }

    verify_hmac_sha256_hex(
        pairing_secret,
        &approval.signing_bytes(offer),
        &approval.approval_mac_hex,
    )
    .map_err(|_| PairingError::AuthenticationFailed)?;

    verify_subset(
        &approval.requested_outbound_scopes,
        &offer.offered_inbound_scopes,
        "approver_outbound",
    )?;
    verify_subset(
        &approval.accepted_inbound_scopes,
        &offer.offered_outbound_scopes,
        "approver_inbound",
    )?;

    let expires_at_ms = approval
        .approved_at_ms
        .checked_add(offer.lease_ttl_ms)
        .ok_or_else(|| PairingError::InvalidInput("lease expires_at_ms overflow".to_string()))?;

    let key = derive_session_key(
        pairing_secret,
        &offer.session_id,
        &offer.initiator_id,
        &approval.approver_id,
        &offer.offer_nonce,
        &approval.approval_nonce,
    )
    .map_err(|err| PairingError::InvalidInput(err.to_string()))?;

    Ok((key, expires_at_ms))
}

/// Completes pairing on the initiator side, yielding its directional [`SessionLease`] and [`SessionKey`].
pub fn complete_pairing_initiator(
    offer: &PairingOffer,
    approval: &PairingApproval,
    pairing_secret: &[u8],
    now_ms: u64,
) -> Result<(SessionLease, SessionKey), PairingError> {
    let (key, expires_at_ms) = verify_offer_and_approval(offer, approval, pairing_secret, now_ms)?;
    let lease = SessionLease {
        session_id: offer.session_id.clone(),
        local_peer_id: offer.initiator_id.clone(),
        peer_id: approval.approver_id.clone(),
        allowed_scopes: normalize_scopes(&approval.requested_outbound_scopes),
        outbound_scopes: normalize_scopes(&approval.accepted_inbound_scopes),
        issued_at_ms: approval.approved_at_ms,
        expires_at_ms,
        revoked: false,
        revocation_reason: None,
        shared_secret_digest: key.digest_hex(),
    };
    Ok((lease, key))
}

/// Completes pairing on the approver side, yielding its complementary [`SessionLease`] and [`SessionKey`].
pub fn complete_pairing_approver(
    offer: &PairingOffer,
    approval: &PairingApproval,
    pairing_secret: &[u8],
    now_ms: u64,
) -> Result<(SessionLease, SessionKey), PairingError> {
    let (key, expires_at_ms) = verify_offer_and_approval(offer, approval, pairing_secret, now_ms)?;
    let lease = SessionLease {
        session_id: offer.session_id.clone(),
        local_peer_id: approval.approver_id.clone(),
        peer_id: offer.initiator_id.clone(),
        allowed_scopes: normalize_scopes(&approval.accepted_inbound_scopes),
        outbound_scopes: normalize_scopes(&approval.requested_outbound_scopes),
        issued_at_ms: approval.approved_at_ms,
        expires_at_ms,
        revoked: false,
        revocation_reason: None,
        shared_secret_digest: key.digest_hex(),
    };
    Ok((lease, key))
}

/// Fail-closed in-memory store tracking paired leases and session keys by `session_id`.
#[derive(Debug, Default)]
pub struct PeerLeaseStore {
    entries: HashMap<String, (SessionLease, SessionKey)>,
}

impl PeerLeaseStore {
    /// Creates an empty lease store (all lookups fail closed until paired).
    #[must_use]
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Registers a verified lease and its matching session key.
    pub fn register(&mut self, lease: SessionLease, key: SessionKey) -> Result<(), PairingError> {
        validate_identifier("session_id", &lease.session_id)?;
        validate_identifier("local_peer_id", &lease.local_peer_id)?;
        validate_identifier("peer_id", &lease.peer_id)?;
        lease.matches_key(&key)?;
        self.entries.insert(lease.session_id.clone(), (lease, key));
        Ok(())
    }

    /// Retrieves an active lease and key for `(session_id, peer_id)`, failing closed otherwise.
    pub fn get_active(
        &self,
        session_id: &str,
        peer_id: &str,
        now_ms: u64,
    ) -> Result<(&SessionLease, &SessionKey), PairingError> {
        let (lease, key) = self
            .entries
            .get(session_id)
            .ok_or(PairingError::UnpairedPeer)?;
        if lease.peer_id != peer_id {
            return Err(PairingError::UnpairedPeer);
        }
        lease.is_active(now_ms)?;
        lease.matches_key(key)?;
        Ok((lease, key))
    }

    /// Explicitly revokes a stored session lease.
    pub fn revoke(
        &mut self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<(), PairingError> {
        let (lease, _) = self
            .entries
            .get_mut(session_id)
            .ok_or(PairingError::UnpairedPeer)?;
        lease.revoke(reason);
        Ok(())
    }
}

fn push_scopes(buf: &mut Vec<u8>, scopes: &[CapabilityScope]) {
    let count = u32::try_from(scopes.len()).unwrap_or(u32::MAX);
    buf.extend_from_slice(&count.to_be_bytes());
    for scope in scopes {
        push_len_prefixed(buf, scope.as_str().as_bytes());
    }
}

pub(crate) fn reject_unknown_keys(
    map: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), String> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("unknown field '{key}'"));
        }
    }
    Ok(())
}

pub(crate) fn take_string(map: &Map<String, Value>, key: &str) -> Result<String, String> {
    map.get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("missing or non-string field '{key}'"))
}

pub(crate) fn take_u64(map: &Map<String, Value>, key: &str) -> Result<u64, String> {
    map.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing or non-u64 field '{key}'"))
}

pub(crate) fn take_bool(map: &Map<String, Value>, key: &str) -> Result<bool, String> {
    map.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("missing or non-bool field '{key}'"))
}

fn take_scopes(map: &Map<String, Value>, key: &str) -> Result<Vec<CapabilityScope>, String> {
    let arr = map
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing or non-array field '{key}'"))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = item
            .as_str()
            .ok_or_else(|| format!("non-string scope entry in '{key}'"))?;
        let scope = CapabilityScope::from_str(s).map_err(|err| err.to_string())?;
        out.push(scope);
    }
    Ok(out)
}

impl Serialize for PairingOffer {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("PairingOffer", 10)?;
        s.serialize_field("session_id", &self.session_id)?;
        s.serialize_field("initiator_id", &self.initiator_id)?;
        s.serialize_field("target_peer_id", &self.target_peer_id)?;
        s.serialize_field("offer_nonce", &self.offer_nonce)?;
        s.serialize_field("offered_inbound_scopes", &self.offered_inbound_scopes)?;
        s.serialize_field("offered_outbound_scopes", &self.offered_outbound_scopes)?;
        s.serialize_field("created_at_ms", &self.created_at_ms)?;
        s.serialize_field("offer_expires_at_ms", &self.offer_expires_at_ms)?;
        s.serialize_field("lease_ttl_ms", &self.lease_ttl_ms)?;
        s.serialize_field("offer_mac_hex", &self.offer_mac_hex)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for PairingOffer {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        reject_unknown_keys(
            &map,
            &[
                "session_id",
                "initiator_id",
                "target_peer_id",
                "offer_nonce",
                "offered_inbound_scopes",
                "offered_outbound_scopes",
                "created_at_ms",
                "offer_expires_at_ms",
                "lease_ttl_ms",
                "offer_mac_hex",
            ],
        )
        .map_err(de::Error::custom)?;

        Ok(Self {
            session_id: take_string(&map, "session_id").map_err(de::Error::custom)?,
            initiator_id: take_string(&map, "initiator_id").map_err(de::Error::custom)?,
            target_peer_id: take_string(&map, "target_peer_id").map_err(de::Error::custom)?,
            offer_nonce: take_string(&map, "offer_nonce").map_err(de::Error::custom)?,
            offered_inbound_scopes: take_scopes(&map, "offered_inbound_scopes")
                .map_err(de::Error::custom)?,
            offered_outbound_scopes: take_scopes(&map, "offered_outbound_scopes")
                .map_err(de::Error::custom)?,
            created_at_ms: take_u64(&map, "created_at_ms").map_err(de::Error::custom)?,
            offer_expires_at_ms: take_u64(&map, "offer_expires_at_ms")
                .map_err(de::Error::custom)?,
            lease_ttl_ms: take_u64(&map, "lease_ttl_ms").map_err(de::Error::custom)?,
            offer_mac_hex: take_string(&map, "offer_mac_hex").map_err(de::Error::custom)?,
        })
    }
}

impl Serialize for PairingApproval {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("PairingApproval", 8)?;
        s.serialize_field("session_id", &self.session_id)?;
        s.serialize_field("approver_id", &self.approver_id)?;
        s.serialize_field("initiator_id", &self.initiator_id)?;
        s.serialize_field("approval_nonce", &self.approval_nonce)?;
        s.serialize_field("requested_outbound_scopes", &self.requested_outbound_scopes)?;
        s.serialize_field("accepted_inbound_scopes", &self.accepted_inbound_scopes)?;
        s.serialize_field("approved_at_ms", &self.approved_at_ms)?;
        s.serialize_field("approval_mac_hex", &self.approval_mac_hex)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for PairingApproval {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        reject_unknown_keys(
            &map,
            &[
                "session_id",
                "approver_id",
                "initiator_id",
                "approval_nonce",
                "requested_outbound_scopes",
                "accepted_inbound_scopes",
                "approved_at_ms",
                "approval_mac_hex",
            ],
        )
        .map_err(de::Error::custom)?;

        Ok(Self {
            session_id: take_string(&map, "session_id").map_err(de::Error::custom)?,
            approver_id: take_string(&map, "approver_id").map_err(de::Error::custom)?,
            initiator_id: take_string(&map, "initiator_id").map_err(de::Error::custom)?,
            approval_nonce: take_string(&map, "approval_nonce").map_err(de::Error::custom)?,
            requested_outbound_scopes: take_scopes(&map, "requested_outbound_scopes")
                .map_err(de::Error::custom)?,
            accepted_inbound_scopes: take_scopes(&map, "accepted_inbound_scopes")
                .map_err(de::Error::custom)?,
            approved_at_ms: take_u64(&map, "approved_at_ms").map_err(de::Error::custom)?,
            approval_mac_hex: take_string(&map, "approval_mac_hex").map_err(de::Error::custom)?,
        })
    }
}

impl Serialize for SessionLease {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("SessionLease", 10)?;
        s.serialize_field("session_id", &self.session_id)?;
        s.serialize_field("local_peer_id", &self.local_peer_id)?;
        s.serialize_field("peer_id", &self.peer_id)?;
        s.serialize_field("allowed_scopes", &self.allowed_scopes)?;
        s.serialize_field("outbound_scopes", &self.outbound_scopes)?;
        s.serialize_field("issued_at_ms", &self.issued_at_ms)?;
        s.serialize_field("expires_at_ms", &self.expires_at_ms)?;
        s.serialize_field("revoked", &self.revoked)?;
        s.serialize_field("revocation_reason", &self.revocation_reason)?;
        s.serialize_field("shared_secret_digest", &self.shared_secret_digest)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for SessionLease {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        reject_unknown_keys(
            &map,
            &[
                "session_id",
                "local_peer_id",
                "peer_id",
                "allowed_scopes",
                "outbound_scopes",
                "issued_at_ms",
                "expires_at_ms",
                "revoked",
                "revocation_reason",
                "shared_secret_digest",
            ],
        )
        .map_err(de::Error::custom)?;

        let revocation_reason = match map.get("revocation_reason") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                return Err(de::Error::custom(
                    "field 'revocation_reason' must be string or null",
                ))
            }
        };

        Ok(Self {
            session_id: take_string(&map, "session_id").map_err(de::Error::custom)?,
            local_peer_id: take_string(&map, "local_peer_id").map_err(de::Error::custom)?,
            peer_id: take_string(&map, "peer_id").map_err(de::Error::custom)?,
            allowed_scopes: take_scopes(&map, "allowed_scopes").map_err(de::Error::custom)?,
            outbound_scopes: take_scopes(&map, "outbound_scopes").map_err(de::Error::custom)?,
            issued_at_ms: take_u64(&map, "issued_at_ms").map_err(de::Error::custom)?,
            expires_at_ms: take_u64(&map, "expires_at_ms").map_err(de::Error::custom)?,
            revoked: take_bool(&map, "revoked").map_err(de::Error::custom)?,
            revocation_reason,
            shared_secret_digest: take_string(&map, "shared_secret_digest")
                .map_err(de::Error::custom)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"shared-pairing-passphrase-2026";

    #[test]
    fn two_way_pairing_happy_path_produces_complementary_leases_and_matching_digest() {
        let offer = PairingOffer::create(
            "sess-01",
            "host-workstation",
            "controller-laptop",
            "offer-nonce-1",
            vec![CapabilityScope::MouseInput, CapabilityScope::KeyboardInput],
            vec![CapabilityScope::ScreenStream],
            1_000,
            5_000,
            60_000,
            SECRET,
        )
        .expect("offer valid");

        let approval = PairingApproval::approve(
            &offer,
            "controller-laptop",
            "approval-nonce-1",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            SECRET,
            1_200,
        )
        .expect("approval valid");

        let (host_lease, host_key) =
            complete_pairing_initiator(&offer, &approval, SECRET, 1_300).expect("host completes");
        let (ctrl_lease, ctrl_key) =
            complete_pairing_approver(&offer, &approval, SECRET, 1_300).expect("ctrl completes");

        assert_eq!(host_key.as_bytes(), ctrl_key.as_bytes());
        assert_eq!(
            host_lease.shared_secret_digest,
            ctrl_lease.shared_secret_digest
        );
        assert_eq!(host_lease.expires_at_ms, 61_200);
        assert_eq!(host_lease.allowed_scopes, vec![CapabilityScope::MouseInput]);
        assert_eq!(
            host_lease.outbound_scopes,
            vec![CapabilityScope::ScreenStream]
        );
        assert_eq!(
            ctrl_lease.allowed_scopes,
            vec![CapabilityScope::ScreenStream]
        );
        assert_eq!(
            ctrl_lease.outbound_scopes,
            vec![CapabilityScope::MouseInput]
        );
        assert!(format!("{host_key:?}").contains("<redacted>"));

        let json = serde_json::to_string(&host_lease).expect("serialize lease");
        let parsed: SessionLease = serde_json::from_str(&json).expect("deserialize lease");
        assert_eq!(parsed, host_lease);
    }

    #[test]
    fn pairing_rejects_scope_escalation_in_both_directions() {
        let offer = PairingOffer::create(
            "sess-02",
            "host-a",
            "peer-b",
            "nonce-a",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            1_000,
            5_000,
            30_000,
            SECRET,
        )
        .expect("offer valid");

        // Escalation 1: approver asks to send KeyboardInput when only MouseInput was offered.
        let err = PairingApproval::approve(
            &offer,
            "peer-b",
            "nonce-b",
            vec![CapabilityScope::MouseInput, CapabilityScope::KeyboardInput],
            vec![CapabilityScope::ScreenStream],
            SECRET,
            1_500,
        )
        .expect_err("must reject outbound escalation");
        assert_eq!(
            err,
            PairingError::ScopeEscalation {
                direction: "approver_outbound",
                scope: CapabilityScope::KeyboardInput,
            }
        );

        // Escalation 2: forged approval claiming TouchInput accepted from initiator when not offered.
        let mut forged = PairingApproval::approve(
            &offer,
            "peer-b",
            "nonce-c",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            SECRET,
            1_500,
        )
        .expect("baseline approval");
        forged
            .accepted_inbound_scopes
            .push(CapabilityScope::TouchInput);
        forged.approval_mac_hex = hmac_sha256_hex(SECRET, &forged.signing_bytes(&offer));
        let err2 = complete_pairing_initiator(&offer, &forged, SECRET, 1_600)
            .expect_err("must reject forged inbound escalation");
        assert_eq!(
            err2,
            PairingError::ScopeEscalation {
                direction: "approver_inbound",
                scope: CapabilityScope::TouchInput,
            }
        );
    }

    #[test]
    fn pairing_rejects_expired_offer_and_tampered_mac() {
        let mut offer = PairingOffer::create(
            "sess-03",
            "host-a",
            "peer-b",
            "nonce-1",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            1_000,
            2_000,
            10_000,
            SECRET,
        )
        .expect("offer valid");

        assert!(matches!(
            offer.verify(SECRET, 2_000),
            Err(PairingError::LeaseExpired {
                now_ms: 2_000,
                expires_at_ms: 2_000
            })
        ));

        offer.lease_ttl_ms = 999_999;
        assert_eq!(
            offer.verify(SECRET, 1_500),
            Err(PairingError::AuthenticationFailed)
        );
    }

    #[test]
    fn unpaired_revoked_and_expired_leases_fail_closed() {
        let unpaired = SessionLease {
            session_id: String::new(),
            local_peer_id: "host".to_string(),
            peer_id: String::new(),
            allowed_scopes: vec![CapabilityScope::MouseInput],
            outbound_scopes: vec![],
            issued_at_ms: 1_000,
            expires_at_ms: 10_000,
            revoked: false,
            revocation_reason: None,
            shared_secret_digest: String::new(),
        };
        assert_eq!(unpaired.is_active(2_000), Err(PairingError::UnpairedPeer));

        let offer = PairingOffer::create(
            "sess-04",
            "host-a",
            "peer-b",
            "n1",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            1_000,
            5_000,
            10_000,
            SECRET,
        )
        .expect("offer");
        let approval = PairingApproval::approve(
            &offer,
            "peer-b",
            "n2",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            SECRET,
            1_500,
        )
        .expect("approval");
        let (mut lease, _key) =
            complete_pairing_initiator(&offer, &approval, SECRET, 1_500).expect("lease");

        // Expiry boundary check (issued 1500 + ttl 10000 = 11500).
        assert!(lease.is_active(11_499).is_ok());
        assert_eq!(
            lease.is_active(11_500),
            Err(PairingError::LeaseExpired {
                now_ms: 11_500,
                expires_at_ms: 11_500,
            })
        );

        lease.revoke("user ended remote control");
        assert!(matches!(
            lease.is_active(2_000),
            Err(PairingError::LeaseRevoked { .. })
        ));
    }

    #[test]
    fn lease_store_rejects_unpaired_and_revoked_peers() {
        let offer = PairingOffer::create(
            "sess-05",
            "host-a",
            "peer-b",
            "n1",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            1_000,
            5_000,
            20_000,
            SECRET,
        )
        .expect("offer");
        let approval = PairingApproval::approve(
            &offer,
            "peer-b",
            "n2",
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
            SECRET,
            1_500,
        )
        .expect("approval");
        let (lease, key) =
            complete_pairing_initiator(&offer, &approval, SECRET, 1_500).expect("lease");

        let mut store = PeerLeaseStore::new();
        assert!(matches!(
            store.get_active("sess-05", "peer-b", 2_000),
            Err(PairingError::UnpairedPeer)
        ));

        store.register(lease, key).expect("registered");
        assert!(store.get_active("sess-05", "peer-b", 2_000).is_ok());
        assert!(matches!(
            store.get_active("sess-05", "impostor-peer", 2_000),
            Err(PairingError::UnpairedPeer)
        ));

        store
            .revoke("sess-05", "manual panic button")
            .expect("revoked");
        assert!(matches!(
            store.get_active("sess-05", "peer-b", 2_000),
            Err(PairingError::LeaseRevoked { .. })
        ));
    }
}
