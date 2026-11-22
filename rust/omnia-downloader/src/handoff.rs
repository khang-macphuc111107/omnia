//! Visible browser handoff manager (`MANUAL_VISIBLE_BROWSER_ONLY`) and fail-closed
//! challenge / ACL / DRM classification.
//!
//! Security & compliance invariants:
//! - `DRM_SUPPORTED = false`
//! - `AUTO_SOLVE_PERMITTED = false`
//! - `EXECUTION_MODE = "MANUAL_VISIBLE_BROWSER_ONLY"`
//! - Zero automated CAPTCHA/Turnstile/hCaptcha/reCAPTCHA/Altcha PoW solving.
//! - Zero retry on `429 AUTH_CHALLENGE_REQUIRED` or `403 BLOCKED_ACL_403`.

use std::collections::BTreeMap;

use omnia_connector_gateway::artifact_intake::DownloadExecutionMode;
use omnia_core::uuid_v4;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::privacy::PrivacyShield;
use crate::types::{current_epoch_ms, DownloaderError, DRM_SUPPORTED};

/// Mandatory execution mode for human-gated authentication or challenge flows.
pub const EXECUTION_MODE_MANUAL_VISIBLE_BROWSER: &str = "MANUAL_VISIBLE_BROWSER_ONLY";

/// Hard invariant: automated challenge solving is unconditionally disabled.
pub const AUTO_SOLVE_PERMITTED: bool = false;

/// Reason a download cannot proceed automatically and requires fail-closed policy action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum HandoffReason {
    /// HTTP `429` or challenge interstitial (`google.com/sorry`, Turnstile, reCAPTCHA, hCaptcha, Altcha).
    AuthChallengeRequired,
    /// HTTP `403` access control refusal (`canDownload=false`, view-only or denied permission).
    BlockedAcl403,
    /// HTTP `401` or sign-in redirect requiring user-consented manual login in a visible browser.
    SignInRequired,
    /// Commercial DRM detected (`pssh`, `SAMPLE-AES`, Widevine/PlayReady/FairPlay) — hard refusal.
    DrmUnsupported,
}

/// Lifecycle state of a tracked visible-browser handoff ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffStatus {
    PendingUserAction,
    CompletedByUser,
    Cancelled,
    RefusedPolicy,
}

/// Auditable, secret-free ticket describing a required manual visible-browser handoff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisibleHandoffTicket {
    pub ticket_id: String,
    pub sanitized_url: String,
    pub reason: HandoffReason,
    pub execution_mode: String,
    pub gateway_mode: DownloadExecutionMode,
    pub auto_solve_permitted: bool,
    pub challenge_required: bool,
    pub drm_supported: bool,
    pub retryable: bool,
    pub status: HandoffStatus,
    pub guidance: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Classification result from inspecting an HTTP status/URL/body for policy gates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpGateClassification {
    /// Response is clear to process normally.
    Clear,
    /// `429 AUTH_CHALLENGE_REQUIRED` — zero-retry fail-closed.
    AuthChallenge { detail: String },
    /// `403 BLOCKED_ACL_403` (`can_download = false`) — zero-retry fail-closed.
    BlockedAcl403 { detail: String },
    /// `401` or login redirect — zero-retry manual visible browser sign-in.
    SignInRequired { detail: String },
}

/// Inspects an HTTP response status, final URL, content type, and optional body snippet
/// to deterministically classify CAPTCHA/anti-bot challenges, Google `/sorry/` pages,
/// sign-in gates, and Drive `403` ACL blocks.
#[must_use]
pub fn classify_http_response(
    status: u16,
    final_url: &str,
    content_type: Option<&str>,
    body_snippet: &str,
) -> HttpGateClassification {
    let url_low = final_url.to_ascii_lowercase();
    let body_low = body_snippet.to_ascii_lowercase();
    let ct_low = content_type.unwrap_or("").to_ascii_lowercase();

    // 1. Explicit Google /sorry/ or anti-bot/CAPTCHA interstitial URL or HTML markers.
    let url_is_sorry = url_low.contains("/sorry/")
        || url_low.contains("/sorry?")
        || url_low.contains("ipv4.google.com/sorry")
        || url_low.contains("cdn-cgi/challenge-platform");

    let body_is_challenge = (ct_low.contains("html") || ct_low.contains("json") || ct_low.is_empty())
        && (body_low.contains("g-recaptcha")
            || body_low.contains("cf-turnstile")
            || body_low.contains("h-captcha")
            || body_low.contains("hcaptcha")
            || body_low.contains("altcha-widget")
            || body_low.contains("unusual traffic from your computer network")
            || body_low.contains("auth_challenge_required")
            || body_low.contains("just a moment...")
            || body_low.contains("verify you are human")
            || body_low.contains("/sorry/index"));

    if url_is_sorry || body_is_challenge {
        return HttpGateClassification::AuthChallenge {
            detail: format!("anti-bot/CAPTCHA challenge detected (HTTP {status})"),
        };
    }

    // 2. Drive / server 403 ACL blocks (`canDownload: false`, permission denied, view-only).
    if status == 403 {
        let detail = if body_low.contains("candownload") && body_low.contains("false") {
            "resource has capabilities.canDownload=false (view-only / ACL restricted)".to_string()
        } else if body_low.contains("cannotdownloadfile")
            || body_low.contains("insufficientfilepermissions")
            || body_low.contains("forbidden")
            || body_low.contains("access denied")
        {
            "access denied by upstream ACL (403 Forbidden)".to_string()
        } else {
            "HTTP 403 Forbidden blocked by upstream ACL".to_string()
        };
        return HttpGateClassification::BlockedAcl403 { detail };
    }

    // 3. Explicit sign-in wall or 401 Unauthorized.
    if status == 401
        || url_low.contains("accounts.google.com/servicelogin")
        || url_low.contains("accounts.google.com/v3/signin")
    {
        return HttpGateClassification::SignInRequired {
            detail: format!("upstream requires interactive user sign-in (HTTP {status})"),
        };
    }

    HttpGateClassification::Clear
}

/// Manages manual visible-browser handoff tickets (`MANUAL_VISIBLE_BROWSER_ONLY`).
///
/// Guarantees:
/// - `auto_solve_permitted` is ALWAYS `false`.
/// - `drm_supported` is ALWAYS `false`.
/// - Stored URLs are always secret-redacted via [`PrivacyShield::sanitize_for_receipt`].
#[derive(Debug, Default)]
pub struct VisibleHandoffManager {
    tickets: RwLock<BTreeMap<String, VisibleHandoffTicket>>,
}

impl VisibleHandoffManager {
    /// Creates an empty handoff manager.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates and records a new secret-free handoff ticket.
    pub fn create_ticket(
        &self,
        raw_url: &str,
        reason: HandoffReason,
        detail: impl AsRef<str>,
    ) -> VisibleHandoffTicket {
        let now = current_epoch_ms();
        let sanitized_url = PrivacyShield::sanitize_for_receipt(raw_url);
        let (status, challenge_required, guidance) = match reason {
            HandoffReason::AuthChallengeRequired => (
                HandoffStatus::PendingUserAction,
                true,
                format!(
                    "Open the target URL in a visible browser window and complete verification manually ({}). Automated solving is strictly disabled.",
                    detail.as_ref()
                ),
            ),
            HandoffReason::SignInRequired => (
                HandoffStatus::PendingUserAction,
                true,
                format!(
                    "Sign in interactively via a visible browser or provide an authorized OAuth token ({}).",
                    detail.as_ref()
                ),
            ),
            HandoffReason::BlockedAcl403 => (
                HandoffStatus::RefusedPolicy,
                false,
                format!(
                    "Resource owner denied download access ({}). Request permission from the owner; access-control bypass is disabled.",
                    detail.as_ref()
                ),
            ),
            HandoffReason::DrmUnsupported => (
                HandoffStatus::RefusedPolicy,
                false,
                format!(
                    "Commercial DRM media cannot be downloaded or decrypted ({}). drm_supported=false.",
                    detail.as_ref()
                ),
            ),
        };

        let ticket = VisibleHandoffTicket {
            ticket_id: uuid_v4(),
            sanitized_url,
            reason,
            execution_mode: EXECUTION_MODE_MANUAL_VISIBLE_BROWSER.to_string(),
            gateway_mode: DownloadExecutionMode::ManualVisibleBrowserOnly,
            auto_solve_permitted: AUTO_SOLVE_PERMITTED,
            challenge_required,
            drm_supported: DRM_SUPPORTED,
            retryable: false,
            status,
            guidance,
            created_at_ms: now,
            updated_at_ms: now,
        };

        self.tickets
            .write()
            .insert(ticket.ticket_id.clone(), ticket.clone());
        ticket
    }

    /// Converts an [`HttpGateClassification`] into a fail-closed [`DownloaderError`]
    /// while recording a handoff ticket when applicable.
    pub fn enforce_classification(
        &self,
        raw_url: &str,
        classification: HttpGateClassification,
    ) -> Result<(), DownloaderError> {
        match classification {
            HttpGateClassification::Clear => Ok(()),
            HttpGateClassification::AuthChallenge { detail } => {
                let ticket = self.create_ticket(
                    raw_url,
                    HandoffReason::AuthChallengeRequired,
                    &detail,
                );
                Err(DownloaderError::AuthChallengeRequired {
                    detail,
                    ticket: Box::new(ticket),
                })
            }
            HttpGateClassification::BlockedAcl403 { detail } => {
                let _ = self.create_ticket(raw_url, HandoffReason::BlockedAcl403, &detail);
                Err(DownloaderError::BlockedAcl403 {
                    detail,
                    can_download: false,
                })
            }
            HttpGateClassification::SignInRequired { detail } => {
                let ticket = self.create_ticket(raw_url, HandoffReason::SignInRequired, &detail);
                Err(DownloaderError::SignInRequired {
                    detail,
                    ticket: Box::new(ticket),
                })
            }
        }
    }

    /// Records a DRM refusal ticket and returns [`DownloaderError::DrmUnsupported`].
    pub fn refuse_drm(&self, raw_url: &str, detail: impl Into<String>) -> DownloaderError {
        let detail = detail.into();
        let _ = self.create_ticket(raw_url, HandoffReason::DrmUnsupported, &detail);
        DownloaderError::DrmUnsupported { detail }
    }

    /// Marks a pending ticket as completed by the user after interactive verification.
    pub fn mark_completed_by_user(&self, ticket_id: &str) -> Option<VisibleHandoffTicket> {
        let mut map = self.tickets.write();
        let ticket = map.get_mut(ticket_id)?;
        if ticket.status == HandoffStatus::PendingUserAction {
            ticket.status = HandoffStatus::CompletedByUser;
            ticket.updated_at_ms = current_epoch_ms();
        }
        Some(ticket.clone())
    }

    /// Cancels a pending handoff ticket.
    pub fn cancel_ticket(&self, ticket_id: &str) -> Option<VisibleHandoffTicket> {
        let mut map = self.tickets.write();
        let ticket = map.get_mut(ticket_id)?;
        if ticket.status == HandoffStatus::PendingUserAction {
            ticket.status = HandoffStatus::Cancelled;
            ticket.updated_at_ms = current_epoch_ms();
        }
        Some(ticket.clone())
    }

    /// Retrieves a ticket by ID.
    #[must_use]
    pub fn get_ticket(&self, ticket_id: &str) -> Option<VisibleHandoffTicket> {
        self.tickets.read().get(ticket_id).cloned()
    }

    /// Lists all tracked handoff tickets ordered by ticket ID.
    #[must_use]
    pub fn list_tickets(&self) -> Vec<VisibleHandoffTicket> {
        self.tickets.read().values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_sorry_and_captcha_trigger_zero_retry_auth_challenge() {
        let mgr = VisibleHandoffManager::new();
        let class = classify_http_response(
            429,
            "https://www.google.com/sorry/index?continue=https://drive.google.com/uc?id=abc",
            Some("text/html"),
            "<html>Our systems have detected unusual traffic from your computer network</html>",
        );
        let err = mgr
            .enforce_classification(
                "https://drive.google.com/uc?id=abc&token=dummy_secret_value",
                class,
            )
            .unwrap_err();
        assert!(!err.is_retryable());
        assert_eq!(err.error_code(), "AUTH_CHALLENGE_REQUIRED");
        match err {
            DownloaderError::AuthChallengeRequired { ticket, .. } => {
                assert_eq!(ticket.execution_mode, "MANUAL_VISIBLE_BROWSER_ONLY");
                assert!(!ticket.auto_solve_permitted);
                assert!(!ticket.drm_supported);
                assert!(ticket.challenge_required);
                assert!(!ticket.retryable);
                assert!(!ticket.sanitized_url.contains("dummy_secret_value"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn acl_403_is_zero_retry_can_download_false() {
        let mgr = VisibleHandoffManager::new();
        let class = classify_http_response(
            403,
            "https://www.googleapis.com/drive/v3/files/abc12345678",
            Some("application/json"),
            r#"{"error":{"errors":[{"reason":"cannotDownloadFile"}]}}"#,
        );
        let err = mgr
            .enforce_classification("https://drive.google.com/file/d/abc12345678/view", class)
            .unwrap_err();
        assert!(!err.is_retryable());
        assert_eq!(err.error_code(), "BLOCKED_ACL_403");
        assert!(matches!(
            err,
            DownloaderError::BlockedAcl403 {
                can_download: false,
                ..
            }
        ));
    }
}
