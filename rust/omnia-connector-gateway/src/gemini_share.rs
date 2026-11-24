//! Public Gemini share (`https://share.gemini.google/<id>`,
//! `https://gemini.google.com/share/<id>`) URL gatekeeper, Google WIZ
//! `batchexecute` (`ujx1Bf` / `otAQ7b`) decoder, transcript normalizer,
//! completeness checker, and strict secret/cookie/signed-URL/PII redactor.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use serde::{Serialize, Serializer};
use serde_json::{json, Map, Value};
use thiserror::Error;
use url::Url;

use crate::{
    detect_json_secrets, find_unsafe_prototype_key, has_bidi_controls, has_control_chars,
    impl_str_enum_serde, is_safe_placeholder, redact_emails, redact_json_value,
    redact_private_disk_paths, redact_secrets_in_text, sanitize_and_inspect_url,
    strip_bidi_controls, SanitizedUrlInfo, UrlInspectionPolicy, UrlSanitizeError, REDACTED_SECRET,
    REDACTED_URL, SECRET_QUERY_PARAMS, SIGNED_URL_PRESERVED_PARAMS, UNSAFE_PROTOTYPE_KEYS,
};

/// Canonical schema version tag for extracted Gemini share transcripts.
pub const GEMINI_SHARE_SCHEMA_VERSION: &str = "omnia.gemini-share-transcript.v1";

const MAX_RAW_BATCHEXECUTE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PAGINATION_PAGES: usize = 128;

/// Errors emitted by Gemini share validation, WIZ decoding, and transcript extraction.
#[derive(Debug, Error)]
pub enum GeminiShareError {
    #[error("invalid Gemini share URL: {0}")]
    InvalidUrl(#[from] UrlSanitizeError),
    #[error("authentication required ({reason:?}): {detail}")]
    AuthRequired {
        reason: GeminiShareBlockReason,
        detail: String,
    },
    #[error("CAPTCHA or anti-bot gate blocked ({reason:?}): {detail}")]
    CaptchaBlocked {
        reason: GeminiShareBlockReason,
        detail: String,
    },
    #[error("Gemini share URL rejected ({reason:?}): {detail}")]
    PolicyRejected {
        reason: GeminiShareBlockReason,
        detail: String,
    },
    #[error("unsafe prototype key detected at '{0}'")]
    UnsafePrototypeKey(String),
    #[error("malformed WIZ batchexecute payload: {0}")]
    MalformedPayload(String),
    #[error("transcript completeness verification failed: {0}")]
    IncompleteTranscript(String),
}

/// Taxonomy of accepted/rejected states for Gemini share URLs and responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GeminiShareBlockReason {
    Ok,
    AuthRequired,
    CaptchaBlocked,
    InsecureScheme,
    UnsupportedHost,
    UnsupportedPort,
    InvalidShareId,
    EmbeddedCredentials,
    SecretInQuery,
}

impl GeminiShareBlockReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::AuthRequired => "auth_required",
            Self::CaptchaBlocked => "captcha_blocked",
            Self::InsecureScheme => "insecure_scheme",
            Self::UnsupportedHost => "unsupported_host",
            Self::UnsupportedPort => "unsupported_port",
            Self::InvalidShareId => "invalid_share_id",
            Self::EmbeddedCredentials => "embedded_credentials",
            Self::SecretInQuery => "secret_in_query",
        }
    }
}

impl FromStr for GeminiShareBlockReason {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ok" => Ok(Self::Ok),
            "auth_required" => Ok(Self::AuthRequired),
            "captcha_blocked" => Ok(Self::CaptchaBlocked),
            "insecure_scheme" => Ok(Self::InsecureScheme),
            "unsupported_host" => Ok(Self::UnsupportedHost),
            "unsupported_port" => Ok(Self::UnsupportedPort),
            "invalid_share_id" => Ok(Self::InvalidShareId),
            "embedded_credentials" => Ok(Self::EmbeddedCredentials),
            "secret_in_query" => Ok(Self::SecretInQuery),
            other => Err(format!("unknown GeminiShareBlockReason '{other}'")),
        }
    }
}

impl_str_enum_serde!(GeminiShareBlockReason);

/// Validated public Gemini share URL descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiShareUrlInfo {
    pub share_id: String,
    pub normalized_url: String,
    pub host: String,
    pub origin: String,
    pub url_info: SanitizedUrlInfo,
}

impl GeminiShareUrlInfo {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "valid": true,
            "reason": GeminiShareBlockReason::Ok,
            "share_id": self.share_id,
            "normalized_url": self.normalized_url,
            "host": self.host,
            "origin": self.origin,
        })
    }
}

impl Serialize for GeminiShareUrlInfo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Decoded `ujx1Bf` page payload extracted from a `wrb.fr` frame.
#[derive(Debug, Clone, PartialEq)]
pub struct GeminiUjx1BfPage {
    pub cursor: Option<String>,
    pub turns: Vec<Value>,
    pub title: Option<String>,
    pub header_conversation_id: Option<String>,
    pub share_id: Option<String>,
    pub published_timestamp: Option<String>,
    pub raw_root: Value,
}

impl GeminiUjx1BfPage {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "cursor": self.cursor,
            "turns_count": self.turns.len(),
            "title": self.title,
            "header_conversation_id": self.header_conversation_id,
            "share_id": self.share_id,
            "published_timestamp": self.published_timestamp,
        })
    }
}

/// Result of decoding a WIZ `batchexecute` payload (`ujx1Bf` pages + optional `otAQ7b` model map).
#[derive(Debug, Clone, PartialEq)]
pub struct BatchexecuteDecoded {
    pub pages: Vec<GeminiUjx1BfPage>,
    pub model_map: BTreeMap<String, String>,
    pub frame_count: usize,
    pub errors: Vec<Value>,
}

impl BatchexecuteDecoded {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let pages_json: Vec<Value> = self.pages.iter().map(GeminiUjx1BfPage::to_json).collect();
        json!({
            "pages": pages_json,
            "model_map": self.model_map,
            "frame_count": self.frame_count,
            "errors": self.errors,
        })
    }
}

/// Attachment record extracted from `turn[2][0][4]` (uploaded files) or `turn[2][15]` (pasted blocks).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiAttachmentRecord {
    pub kind: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub url: Option<String>,
    pub text: Option<String>,
    pub size_bytes: Option<u64>,
}

impl GeminiAttachmentRecord {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "name": self.name,
            "mime_type": self.mime_type,
            "url": self.url,
            "text": self.text,
            "size_bytes": self.size_bytes,
        })
    }
}

impl Serialize for GeminiAttachmentRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Source citation interleaved inside a `draft[37][1]` thinking step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiSourceCitation {
    pub favicon: Option<String>,
    pub url: Option<String>,
    pub title: String,
}

impl GeminiSourceCitation {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "favicon": self.favicon,
            "url": self.url,
            "title": self.title,
        })
    }
}

impl Serialize for GeminiSourceCitation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Thinking step extracted from `draft[37][1]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiThinkingStep {
    pub action: String,
    pub provider: Option<String>,
    pub header: String,
    pub body: String,
    pub sources: Vec<GeminiSourceCitation>,
}

impl GeminiThinkingStep {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let sources_json: Vec<Value> = self
            .sources
            .iter()
            .map(GeminiSourceCitation::to_json)
            .collect();
        json!({
            "action": self.action,
            "provider": self.provider,
            "header": self.header,
            "body": self.body,
            "sources": sources_json,
        })
    }
}

impl Serialize for GeminiThinkingStep {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Grounding citation entry inside `draft[2][1]` items.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiGroundingItem {
    pub url: Option<String>,
    pub title: String,
    pub snippet: Option<String>,
    pub publisher: Option<String>,
}

impl GeminiGroundingItem {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "url": self.url,
            "title": self.title,
            "snippet": self.snippet,
            "publisher": self.publisher,
        })
    }
}

impl Serialize for GeminiGroundingItem {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Grounding citation span + items extracted from `draft[2][1]`.
#[derive(Debug, Clone, PartialEq)]
pub struct GeminiGroundingCitation {
    pub span: Value,
    pub items: Vec<GeminiGroundingItem>,
}

impl GeminiGroundingCitation {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let items_json: Vec<Value> = self
            .items
            .iter()
            .map(GeminiGroundingItem::to_json)
            .collect();
        json!({
            "span": self.span,
            "items": items_json,
        })
    }
}

impl Serialize for GeminiGroundingCitation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Normalized turn extracted from a `ujx1Bf` share page.
#[derive(Debug, Clone, PartialEq)]
pub struct GeminiShareTurn {
    pub turn_index: usize,
    pub conversation_id: Option<String>,
    pub turn_id: String,
    pub prompt_text: String,
    pub attachments: Vec<GeminiAttachmentRecord>,
    pub search_queries: Vec<String>,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub response_id: Option<String>,
    pub response_markdown: String,
    pub thinking_steps: Vec<GeminiThinkingStep>,
    pub grounding_citations: Vec<GeminiGroundingCitation>,
}

impl GeminiShareTurn {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let attachments_json: Vec<Value> = self
            .attachments
            .iter()
            .map(GeminiAttachmentRecord::to_json)
            .collect();
        let thinking_json: Vec<Value> = self
            .thinking_steps
            .iter()
            .map(GeminiThinkingStep::to_json)
            .collect();
        let grounding_json: Vec<Value> = self
            .grounding_citations
            .iter()
            .map(GeminiGroundingCitation::to_json)
            .collect();
        json!({
            "turn_index": self.turn_index,
            "conversation_id": self.conversation_id,
            "turn_id": self.turn_id,
            "prompt_text": self.prompt_text,
            "attachments": attachments_json,
            "search_queries": self.search_queries,
            "model_id": self.model_id,
            "model_name": self.model_name,
            "response_id": self.response_id,
            "response_markdown": self.response_markdown,
            "thinking_steps": thinking_json,
            "grounding_citations": grounding_json,
        })
    }
}

impl Serialize for GeminiShareTurn {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Summary and completeness metrics for an extracted Gemini share transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiExtractionSummary {
    pub turns_total: usize,
    pub turns_with_thinking: usize,
    pub thinking_steps_total: usize,
    pub turns_with_sources: usize,
    pub unique_sources_total: usize,
    pub search_queries_total: usize,
    pub attachments_total: usize,
    pub empty_turns_total: usize,
    pub cursor_exhausted: bool,
}

impl GeminiExtractionSummary {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "turns_total": self.turns_total,
            "turns_with_thinking": self.turns_with_thinking,
            "thinking_steps_total": self.thinking_steps_total,
            "turns_with_sources": self.turns_with_sources,
            "unique_sources_total": self.unique_sources_total,
            "search_queries_total": self.search_queries_total,
            "attachments_total": self.attachments_total,
            "empty_turns_total": self.empty_turns_total,
            "cursor_exhausted": self.cursor_exhausted,
        })
    }

    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.cursor_exhausted && self.turns_total > 0 && self.empty_turns_total == 0
    }
}

impl Serialize for GeminiExtractionSummary {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Complete extracted transcript matching `omnia.gemini-share-transcript.v1`.
#[derive(Debug, Clone, PartialEq)]
pub struct GeminiShareTranscript {
    pub schema_version: String,
    pub source_url: String,
    pub share_id: Option<String>,
    pub title: String,
    pub published_timestamp: Option<String>,
    pub cursor_exhausted: bool,
    pub next_cursor: Option<String>,
    pub pages_processed: usize,
    pub model_map: BTreeMap<String, String>,
    pub turns: Vec<GeminiShareTurn>,
    pub summary: GeminiExtractionSummary,
    pub redaction_applied: bool,
    pub redacted_fields: Vec<String>,
}

impl GeminiShareTranscript {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let turns_json: Vec<Value> = self.turns.iter().map(GeminiShareTurn::to_json).collect();
        let mut val = json!({
            "schema_version": self.schema_version,
            "source_url": self.source_url,
            "share_id": self.share_id,
            "title": self.title,
            "published_timestamp": self.published_timestamp,
            "cursor_exhausted": self.cursor_exhausted,
            "next_cursor": self.next_cursor,
            "pages_processed": self.pages_processed,
            "model_map": self.model_map,
            "turns": turns_json,
            "summary": self.summary.to_json(),
            "redaction_applied": self.redaction_applied,
            "redacted_fields": self.redacted_fields,
        });
        if self.redaction_applied && !detect_json_secrets(&val).is_empty() {
            let (cleaned, _) = redact_json_value(&val);
            val = cleaned;
        }
        val
    }
}

impl Serialize for GeminiShareTranscript {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

fn is_valid_share_id(share_id: &str) -> bool {
    let bytes = share_id.as_bytes();
    (4..=128).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn is_gemini_app_path(path_low: &str) -> bool {
    if path_low == "/app" || path_low.starts_with("/app/") || path_low.starts_with("/signin") {
        return true;
    }
    if let Some(rest) = path_low.strip_prefix("/u/") {
        if let Some((digits, tail)) = rest.split_once('/') {
            return !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit())
                && (tail == "app" || tail.starts_with("app/"));
        }
    }
    false
}

/// Validates a public Gemini share URL (`https://share.gemini.google/<id>` or
/// `https://gemini.google.com/share/<id>`), explicitly refusing private `/app/...`
/// (`auth_required`) and `google.com/sorry` CAPTCHA redirects (`captcha_blocked`).
pub fn validate_gemini_share_url(raw_url: &str) -> Result<GeminiShareUrlInfo, GeminiShareError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(GeminiShareError::InvalidUrl(UrlSanitizeError::Empty));
    }
    if has_control_chars(trimmed) || has_bidi_controls(trimmed) {
        return Err(GeminiShareError::InvalidUrl(UrlSanitizeError::ControlChars));
    }

    let parsed = Url::parse(trimmed)
        .map_err(|e| GeminiShareError::InvalidUrl(UrlSanitizeError::Malformed(e.to_string())))?;
    let host = parsed
        .host_str()
        .map(|h| h.trim_end_matches('.').to_ascii_lowercase())
        .ok_or(GeminiShareError::InvalidUrl(UrlSanitizeError::MissingHost))?;
    let path_low = parsed.path().to_ascii_lowercase();

    // Check CAPTCHA gates first so sorry redirects with `continue=...` stay `captcha_blocked`.
    if (host == "google.com" || host.ends_with(".google.com"))
        && (path_low == "/sorry" || path_low.starts_with("/sorry/") || host.starts_with("sorry."))
    {
        return Err(GeminiShareError::CaptchaBlocked {
            reason: GeminiShareBlockReason::CaptchaBlocked,
            detail: "Refused google.com/sorry CAPTCHA gate without bypassing anti-bot controls"
                .to_string(),
        });
    }

    // Check private authenticated Google/Gemini surfaces (`auth_required`).
    if host == "accounts.google.com"
        || (host == "gemini.google.com" && is_gemini_app_path(&path_low))
    {
        return Err(GeminiShareError::AuthRequired {
            reason: GeminiShareBlockReason::AuthRequired,
            detail: "Refused private authenticated Gemini/Google URL without bypassing auth"
                .to_string(),
        });
    }

    let policy = UrlInspectionPolicy {
        strict_tls: true,
        allow_loopback_http: false,
        allow_private_endpoints: false,
        allow_non_loopback: true,
        redact_signed_params: true,
        allow_socks_schemes: false,
    };
    let info = sanitize_and_inspect_url(trimmed, &policy)?;

    if info.had_embedded_credentials {
        return Err(GeminiShareError::PolicyRejected {
            reason: GeminiShareBlockReason::EmbeddedCredentials,
            detail: "Gemini share URL must not embed credentials".to_string(),
        });
    }
    if info.had_query_secrets {
        return Err(GeminiShareError::PolicyRejected {
            reason: GeminiShareBlockReason::SecretInQuery,
            detail: "Gemini share URL must not carry secret query parameters".to_string(),
        });
    }
    if info.non_tls_remote || info.scheme != "https" {
        return Err(GeminiShareError::PolicyRejected {
            reason: GeminiShareBlockReason::InsecureScheme,
            detail: "Public Gemini share URLs require HTTPS".to_string(),
        });
    }
    if host != "share.gemini.google" && host != "gemini.google.com" {
        return Err(GeminiShareError::PolicyRejected {
            reason: GeminiShareBlockReason::UnsupportedHost,
            detail: format!("Host '{host}' is not an allowed Gemini share host"),
        });
    }
    if info.port != 443 {
        return Err(GeminiShareError::PolicyRejected {
            reason: GeminiShareBlockReason::UnsupportedPort,
            detail: "Non-standard port rejected for Gemini share URL".to_string(),
        });
    }

    let segments: Vec<&str> = parsed.path().split('/').filter(|s| !s.is_empty()).collect();
    let (share_id, canonical_path) = match host.as_str() {
        "share.gemini.google" if segments.len() == 1 => {
            (segments[0].to_string(), format!("/{}", segments[0]))
        }
        "gemini.google.com" if segments.len() == 2 && segments[0] == "share" => {
            (segments[1].to_string(), format!("/share/{}", segments[1]))
        }
        _ => {
            return Err(GeminiShareError::PolicyRejected {
                reason: GeminiShareBlockReason::InvalidShareId,
                detail: "Expected https://share.gemini.google/<id> or https://gemini.google.com/share/<id>"
                    .to_string(),
            });
        }
    };

    if !is_valid_share_id(&share_id) {
        return Err(GeminiShareError::PolicyRejected {
            reason: GeminiShareBlockReason::InvalidShareId,
            detail: "Share ID failed strict alphanumeric/hyphen/underscore check".to_string(),
        });
    }

    let normalized_url = if let Ok(mut rebuilt) = Url::parse(&info.normalized_url) {
        rebuilt.set_path(&canonical_path);
        rebuilt
            .as_str()
            .replace("%5BREDACTED_SECRET%5D", REDACTED_SECRET)
    } else {
        format!("https://{host}{canonical_path}")
    };

    Ok(GeminiShareUrlInfo {
        share_id,
        normalized_url,
        host,
        origin: info.origin.clone(),
        url_info: info,
    })
}

/// Comprehensive text redactor reusing `omnia-connector-gateway` primitives plus
/// `Cookie:` header stripping, bare `SID=` pair redaction, and inline signed/secret URL scrubbing.
#[must_use]
pub fn redact_text(input: &str) -> (String, Vec<String>) {
    if input.is_empty() {
        return (String::new(), Vec::new());
    }
    let mut hits = BTreeSet::new();

    let (no_bidi, bidi_changed) = strip_bidi_controls(input);
    if bidi_changed {
        hits.insert("BIDI_CONTROLS_STRIPPED".to_string());
    }

    let (step1, secret_hits) = redact_secrets_in_text(&no_bidi);
    for h in secret_hits {
        hits.insert(h);
    }

    let step2 = redact_cookie_headers_and_sid(&step1, &mut hits);
    let step3 = redact_inline_urls(&step2, &mut hits);

    let (step4, path_changed) = redact_private_disk_paths(&step3);
    if path_changed {
        hits.insert("PRIVATE_DISK_PATH".to_string());
    }

    let (step5, email_changed) = redact_emails(&step4);
    if email_changed {
        hits.insert("PII_EMAIL".to_string());
    }

    (step5, hits.into_iter().collect())
}

fn redact_cookie_headers_and_sid(input: &str, hits: &mut BTreeSet<String>) -> String {
    let mut lines_out = Vec::new();
    for line in input.split_inclusive('\n') {
        let (body, nl) = if let Some(stripped) = line.strip_suffix('\n') {
            (stripped, "\n")
        } else {
            (line, "")
        };
        let trimmed_start = body.trim_start();
        let low = trimmed_start.to_ascii_lowercase();
        let prefix_len = body.len() - trimmed_start.len();
        if let Some(colon_rel) = low
            .strip_prefix("cookie:")
            .or_else(|| low.strip_prefix("set-cookie:"))
            .map(|rest| trimmed_start.len() - rest.len())
        {
            let val = body[prefix_len + colon_rel..].trim();
            if !val.is_empty() && !is_safe_placeholder(val) {
                hits.insert("COOKIE_HEADER".to_string());
                lines_out.push(format!(
                    "{} {REDACTED_SECRET}{nl}",
                    &body[..prefix_len + colon_rel]
                ));
                continue;
            }
        }
        lines_out.push(format!("{}{nl}", redact_inline_sid_pairs(body, hits)));
    }
    lines_out.concat()
}

fn redact_inline_sid_pairs(input: &str, hits: &mut BTreeSet<String>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        let boundary_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        if boundary_ok
            && i + 4 < bytes.len()
            && bytes[i..i + 3].eq_ignore_ascii_case(b"sid")
            && bytes[i + 3] == b'='
        {
            let val_start = i + 4;
            let mut val_end = val_start;
            while val_end < bytes.len()
                && !bytes[val_end].is_ascii_whitespace()
                && !matches!(bytes[val_end], b';' | b'"' | b'\'' | b'&' | b',' | b'}')
            {
                val_end += 1;
            }
            let val = &input[val_start..val_end];
            if val.len() >= 6 && !is_safe_placeholder(val) {
                out.push_str(&input[i..val_start]);
                out.push_str(REDACTED_SECRET);
                hits.insert("COOKIE_SECRET:SID".to_string());
                i = val_end;
                continue;
            }
        }
        let ch = input[i..].chars().next().expect("valid utf8 boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn redact_inline_urls(input: &str, hits: &mut BTreeSet<String>) -> String {
    if !input.contains("http://") && !input.contains("https://") {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find("https://").or_else(|| rest.find("http://")) {
        // Pick earliest match between http:// and https://
        let idx_http = rest.find("http://");
        let idx_https = rest.find("https://");
        let start = match (idx_http, idx_https) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => idx,
        };
        out.push_str(&rest[..start]);
        let candidate_slice = &rest[start..];
        let mut end = 0;
        for ch in candidate_slice.chars() {
            if ch.is_whitespace() || matches!(ch, '<' | '>' | '\'' | '"' | ']') {
                break;
            }
            end += ch.len_utf8();
        }
        let mut raw_url = &candidate_slice[..end];
        let mut trailing = "";
        while let Some(last) = raw_url.chars().last() {
            if matches!(last, '.' | ',' | ';' | ':') {
                let cut = raw_url.len() - last.len_utf8();
                trailing = &candidate_slice[cut..end];
                raw_url = &raw_url[..cut];
            } else if last == ')' {
                let opens = raw_url.bytes().filter(|b| *b == b'(').count();
                let closes = raw_url.bytes().filter(|b| *b == b')').count();
                if closes > opens {
                    let cut = raw_url.len() - 1;
                    trailing = &candidate_slice[cut..end];
                    raw_url = &raw_url[..cut];
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        let (cleaned, flags) = sanitize_gemini_url(raw_url);
        for f in flags {
            hits.insert(f);
        }
        out.push_str(&cleaned.unwrap_or_else(|| REDACTED_URL.to_string()));
        out.push_str(trailing);
        rest = &candidate_slice[end..];
    }
    out.push_str(rest);
    out
}

fn sanitize_gemini_url(raw_url: &str) -> (Option<String>, Vec<String>) {
    let (no_bidi, _) = strip_bidi_controls(raw_url);
    let trimmed = no_bidi.trim();
    if trimmed.is_empty() {
        return (None, Vec::new());
    }
    if has_control_chars(trimmed) {
        return (None, vec!["URL_CONTROL_CHARS_STRIPPED".to_string()]);
    }
    let low = trimmed.to_ascii_lowercase();
    if low.starts_with("data:image/") {
        if low[..low.len().min(32)].contains("svg") {
            return (None, vec!["UNSAFE_SVG_DATA_URI_STRIPPED".to_string()]);
        }
        return (Some(trimmed.to_string()), Vec::new());
    }
    if !low.starts_with("https://") && !low.starts_with("http://") {
        return (None, vec!["UNSAFE_NON_HTTP_URL_STRIPPED".to_string()]);
    }

    let policy = UrlInspectionPolicy {
        strict_tls: false,
        allow_loopback_http: true,
        allow_private_endpoints: true,
        allow_non_loopback: true,
        redact_signed_params: true,
        allow_socks_schemes: false,
    };
    let Ok(info) = sanitize_and_inspect_url(trimmed, &policy) else {
        return (
            Some(REDACTED_URL.to_string()),
            vec!["MALFORMED_URL_REDACTED".to_string()],
        );
    };

    let mut flags = Vec::new();
    if info.had_embedded_credentials {
        flags.push("URL_USERINFO_STRIPPED".to_string());
    }
    if info.had_query_secrets {
        flags.push("URL_QUERY_SECRET_REDACTED".to_string());
    }
    if !info.preserved_signed_params.is_empty() {
        flags.push("URL_SIGNED_PARAMS_REDACTED".to_string());
    }
    if !info.stripped_tracking_params.is_empty() {
        flags.push("URL_TRACKING_STRIPPED".to_string());
    }

    let mut cleaned = info
        .normalized_url
        .replace("%5BREDACTED_SECRET%5D", REDACTED_SECRET);

    // Also scrub GoogleAccessId or inline emails inside query parameters.
    if cleaned.contains("GoogleAccessId=") {
        if let Ok(mut parsed) = Url::parse(&cleaned) {
            let mut pairs: Vec<(String, String)> = Vec::new();
            let mut modified = false;
            for (k, v) in parsed.query_pairs() {
                let kl = k.to_ascii_lowercase();
                if (kl == "googleaccessid"
                    || SIGNED_URL_PRESERVED_PARAMS.contains(&kl.as_str())
                    || SECRET_QUERY_PARAMS.contains(&kl.as_str()))
                    && !is_safe_placeholder(&v)
                {
                    pairs.push((k.into_owned(), REDACTED_SECRET.to_string()));
                    modified = true;
                    continue;
                }
                pairs.push((k.into_owned(), v.into_owned()));
            }
            if modified {
                flags.push("URL_SIGNED_PARAMS_REDACTED".to_string());
                let mut qp = parsed.query_pairs_mut();
                qp.clear();
                for (k, v) in &pairs {
                    qp.append_pair(k, v);
                }
                drop(qp);
                cleaned = parsed
                    .as_str()
                    .replace("%5BREDACTED_SECRET%5D", REDACTED_SECRET);
            }
        }
    }

    let (no_email, email_changed) = redact_emails(&cleaned);
    if email_changed {
        flags.push("URL_EMAIL_REDACTED".to_string());
        cleaned = no_email;
    }

    (Some(cleaned), flags)
}

fn detect_html_gate(raw_text: &str) -> Option<GeminiShareError> {
    let prefix_len = raw_text.len().min(8192);
    // Walk back to char boundary if needed.
    let mut end = prefix_len;
    while end > 0 && !raw_text.is_char_boundary(end) {
        end -= 1;
    }
    let low = raw_text[..end].to_ascii_lowercase();
    if !low.contains("<html") && !low.contains("<!doctype html") {
        return None;
    }
    if low.contains("google.com/sorry")
        || low.contains("g-recaptcha")
        || low.contains("unusual traffic from your computer network")
        || low.contains("recaptcha/api.js")
    {
        return Some(GeminiShareError::CaptchaBlocked {
            reason: GeminiShareBlockReason::CaptchaBlocked,
            detail: "HTML response hit CAPTCHA gate".to_string(),
        });
    }
    if low.contains("accounts.google.com/servicelogin")
        || low.contains("accounts.google.com/v3/signin")
        || low.contains("sign in - google accounts")
        || low.contains("consent.google.com")
    {
        return Some(GeminiShareError::AuthRequired {
            reason: GeminiShareBlockReason::AuthRequired,
            detail: "HTML response hit authentication gate".to_string(),
        });
    }
    None
}

fn skip_xssi_prefix(text: &str, mut pos: usize) -> usize {
    let bytes = text.as_bytes();
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if text[pos..].starts_with(")]}'") {
        pos += 4;
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
    }
    pos
}

fn unix_seconds_to_iso_utc(secs: i64, nanos: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;

    // Howard Hinnant civil-from-days conversion.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }

    if nanos > 0 {
        let micro = (nanos / 1_000).clamp(0, 999_999);
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{micro:06}Z")
    } else {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    }
}

fn format_published_timestamp(raw_val: Option<&Value>) -> Option<String> {
    let val = raw_val?;
    match val {
        Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Value::Number(num) => {
            let raw = num.as_i64().or_else(|| num.as_f64().map(|f| f as i64))?;
            let secs = if raw > 1_000_000_000_000 {
                raw / 1000
            } else {
                raw
            };
            Some(unix_seconds_to_iso_utc(secs, 0))
        }
        Value::Array(arr) => {
            let secs = arr
                .first()
                .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))?;
            let nanos = arr.get(1).and_then(Value::as_i64).unwrap_or(0);
            Some(unix_seconds_to_iso_utc(secs, nanos))
        }
        _ => None,
    }
}

fn parse_ot_aq7b_model_map(payload: &Value) -> BTreeMap<String, String> {
    let mut models = BTreeMap::new();
    match payload {
        Value::Object(map) => {
            for (k, v) in map {
                if UNSAFE_PROTOTYPE_KEYS.contains(&k.as_str()) {
                    continue;
                }
                if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    models.insert(k.clone(), s.to_string());
                } else if let Some(obj) = v.as_object() {
                    let label = obj
                        .get("name")
                        .or_else(|| obj.get("display_name"))
                        .or_else(|| obj.get("label"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if let Some(l) = label {
                        models.insert(k.clone(), l.to_string());
                    }
                }
            }
        }
        Value::Array(items) => {
            let candidates = if items.len() == 1 {
                if let Some(inner) = items[0].as_array() {
                    if inner.first().and_then(Value::as_array).is_some() {
                        inner.as_slice()
                    } else {
                        items.as_slice()
                    }
                } else {
                    items.as_slice()
                }
            } else {
                items.as_slice()
            };
            for entry in candidates {
                if let Some(obj) = entry.as_object() {
                    let mid = obj
                        .get("id")
                        .or_else(|| obj.get("model_id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    let mname = obj
                        .get("name")
                        .or_else(|| obj.get("display_name"))
                        .or_else(|| obj.get("label"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty());
                    if let (Some(id), Some(name)) = (mid, mname) {
                        models.insert(id.to_string(), name.to_string());
                    }
                } else if let Some(arr) = entry.as_array() {
                    if arr.len() >= 2 {
                        let mid = arr[0]
                            .as_str()
                            .map(|s| s.trim().to_string())
                            .or_else(|| arr[0].as_i64().map(|n| n.to_string()));
                        let label = arr[1..].iter().find_map(|cell| {
                            cell.as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string)
                                .or_else(|| {
                                    cell.as_array()
                                        .and_then(|sub| sub.first())
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_string)
                                })
                        });
                        if let (Some(id), Some(name)) = (mid, label) {
                            if !id.is_empty() {
                                models.insert(id, name);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    models
}

fn parse_ujx1bf_root(root: &Value) -> Result<GeminiUjx1BfPage, GeminiShareError> {
    let root_arr = root.as_array().ok_or_else(|| {
        GeminiShareError::MalformedPayload("ujx1Bf payload must be a JSON array".to_string())
    })?;
    let container = root_arr.first().and_then(Value::as_array).ok_or_else(|| {
        GeminiShareError::MalformedPayload("ujx1Bf payload missing root[0] array".to_string())
    })?;

    let cursor = container
        .first()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let turns = container
        .get(1)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut header_conversation_id = None;
    let mut title = None;
    if let Some(meta) = container.get(2).and_then(Value::as_array) {
        header_conversation_id = meta
            .first()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        title = meta
            .get(1)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }

    let share_id = container
        .get(3)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let published_timestamp = format_published_timestamp(container.get(4));

    Ok(GeminiUjx1BfPage {
        cursor,
        turns,
        title,
        header_conversation_id,
        share_id,
        published_timestamp,
        raw_root: root.clone(),
    })
}

/// Decodes a Google WIZ `batchexecute` HTTP body (`)]}'`, length-prefixed JSON `wrb.fr` frames)
/// into `ujx1Bf` pages and optional `otAQ7b` model maps while rejecting prototype keys & auth/CAPTCHA gates.
pub fn parse_batchexecute_ujx1bf(raw_text: &str) -> Result<BatchexecuteDecoded, GeminiShareError> {
    if raw_text.len() > MAX_RAW_BATCHEXECUTE_BYTES {
        return Err(GeminiShareError::MalformedPayload(
            "batchexecute payload exceeds 64 MiB limit".to_string(),
        ));
    }
    let cleaned = raw_text.strip_prefix('\u{feff}').unwrap_or(raw_text);
    if cleaned.trim().is_empty() {
        return Err(GeminiShareError::MalformedPayload(
            "batchexecute payload is empty".to_string(),
        ));
    }
    if let Some(gate_err) = detect_html_gate(cleaned) {
        return Err(gate_err);
    }

    let mut chunks: Vec<Value> = Vec::new();
    let mut pos = skip_xssi_prefix(cleaned, 0);
    let len = cleaned.len();

    while pos < len {
        pos = skip_xssi_prefix(cleaned, pos);
        if pos >= len {
            break;
        }
        let slice = &cleaned[pos..];
        let (line, advance) = match slice.find('\n') {
            Some(nl) => (&slice[..nl], nl + 1),
            None => (slice, slice.len()),
        };
        if !line.trim().is_empty() && line.trim().bytes().all(|b| b.is_ascii_digit()) {
            pos += advance;
            pos = skip_xssi_prefix(cleaned, pos);
            if pos >= len {
                break;
            }
        }

        let mut stream = serde_json::Deserializer::from_str(&cleaned[pos..]).into_iter::<Value>();
        let val = match stream.next() {
            Some(Ok(v)) => v,
            Some(Err(e)) => {
                return Err(GeminiShareError::MalformedPayload(format!(
                    "failed parsing batchexecute JSON at offset {pos}: {e}"
                )));
            }
            None => break,
        };
        if let Some(unsafe_path) = find_unsafe_prototype_key(&val, "$") {
            return Err(GeminiShareError::UnsafePrototypeKey(unsafe_path));
        }
        let consumed = stream.byte_offset();
        if consumed == 0 {
            return Err(GeminiShareError::MalformedPayload(format!(
                "zero-progress JSON frame at offset {pos}"
            )));
        }
        chunks.push(val);
        pos += consumed;
    }

    if chunks.is_empty() {
        return Err(GeminiShareError::MalformedPayload(
            "no batchexecute JSON chunks found".to_string(),
        ));
    }

    let mut pages = Vec::new();
    let mut model_map = BTreeMap::new();
    let mut frame_count = 0usize;
    let mut errors = Vec::new();

    for chunk in chunks {
        let Some(arr) = chunk.as_array() else {
            continue;
        };
        let envelopes: Vec<&Vec<Value>> = if arr.first().and_then(Value::as_str).is_some() {
            vec![arr]
        } else {
            arr.iter().filter_map(Value::as_array).collect()
        };

        for env in envelopes {
            let Some(tag) = env.first().and_then(Value::as_str) else {
                continue;
            };
            if tag == "er" {
                errors.push(Value::Array(env.clone()));
                continue;
            }
            if tag != "wrb.fr" {
                continue;
            }
            frame_count += 1;

            let rpc_id = env.get(1).and_then(Value::as_str).unwrap_or("");
            let raw_payload = env.get(2).unwrap_or(&Value::Null);
            let error_info = env.get(5).filter(|v| !v.is_null());

            if raw_payload.is_null() {
                if let Some(err_val) = error_info {
                    let err_txt = err_val.to_string().to_ascii_lowercase();
                    if err_txt.contains("unauthenticated")
                        || err_val == &json!([7])
                        || err_val == &json!(7)
                    {
                        return Err(GeminiShareError::AuthRequired {
                            reason: GeminiShareBlockReason::AuthRequired,
                            detail: "WIZ RPC returned unauthenticated status".to_string(),
                        });
                    }
                    if err_txt.contains("captcha") || err_txt.contains("sorry") {
                        return Err(GeminiShareError::CaptchaBlocked {
                            reason: GeminiShareBlockReason::CaptchaBlocked,
                            detail: "WIZ RPC returned CAPTCHA block".to_string(),
                        });
                    }
                    errors.push(json!({ "rpc_id": rpc_id, "error": err_val }));
                }
                continue;
            }

            let parsed_payload: Value = if let Some(s) = raw_payload.as_str() {
                serde_json::from_str(s).map_err(|e| {
                    GeminiShareError::MalformedPayload(format!(
                        "invalid JSON inside wrb.fr payload for '{rpc_id}': {e}"
                    ))
                })?
            } else {
                raw_payload.clone()
            };

            if let Some(unsafe_path) = find_unsafe_prototype_key(&parsed_payload, "$") {
                return Err(GeminiShareError::UnsafePrototypeKey(unsafe_path));
            }

            match rpc_id {
                "ujx1Bf" => {
                    pages.push(parse_ujx1bf_root(&parsed_payload)?);
                }
                "otAQ7b" => {
                    model_map.extend(parse_ot_aq7b_model_map(&parsed_payload));
                }
                _ => {}
            }
        }
    }

    Ok(BatchexecuteDecoded {
        pages,
        model_map,
        frame_count,
        errors,
    })
}

fn clean_text_field(
    raw: &str,
    redact: bool,
    field: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> String {
    if !redact {
        return raw.to_string();
    }
    let (cleaned, hits) = redact_text(raw);
    for h in hits {
        redacted_fields.insert(format!("{field}:{h}"));
    }
    cleaned
}

fn clean_url_field(
    raw: Option<&str>,
    redact: bool,
    field: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> Option<String> {
    let trimmed = raw.map(str::trim).filter(|s| !s.is_empty())?;
    if !redact {
        return Some(trimmed.to_string());
    }
    let (cleaned, flags) = sanitize_gemini_url(trimmed);
    for f in flags {
        redacted_fields.insert(format!("{field}:{f}"));
    }
    cleaned
}

#[derive(Default)]
struct UploadListParts {
    url: Option<String>,
    name: Option<String>,
    mime: Option<String>,
    size: Option<u64>,
}

fn visit_upload_list_cell(
    cell: &Value,
    redact: bool,
    field_prefix: &str,
    redacted_fields: &mut BTreeSet<String>,
    parts: &mut UploadListParts,
) {
    match cell {
        Value::Null | Value::Bool(_) => {}
        Value::Number(n) => {
            if parts.size.is_none() {
                if let Some(u) = n.as_u64() {
                    parts.size = Some(u);
                }
            }
        }
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return;
            }
            if (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
                && parts.url.is_none()
            {
                parts.url = clean_url_field(
                    Some(trimmed),
                    redact,
                    &format!("{field_prefix}.url"),
                    redacted_fields,
                );
            } else if trimmed.contains('/')
                && !trimmed.contains(' ')
                && trimmed.len() < 96
                && !trimmed.rsplit('/').next().unwrap_or("").contains('.')
                && parts.mime.is_none()
            {
                parts.mime = Some(trimmed.to_string());
            } else if parts.name.is_none() {
                parts.name = Some(clean_text_field(
                    trimmed,
                    redact,
                    &format!("{field_prefix}.name"),
                    redacted_fields,
                ));
            }
        }
        Value::Array(items) => {
            for sub in items {
                visit_upload_list_cell(sub, redact, field_prefix, redacted_fields, parts);
            }
        }
        Value::Object(_) => {}
    }
}

fn parse_upload_item(
    item: &Value,
    redact: bool,
    field_prefix: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> Option<GeminiAttachmentRecord> {
    match item {
        Value::Null | Value::Bool(_) => None,
        Value::Object(map) => {
            let raw_name = map
                .get("name")
                .or_else(|| map.get("filename"))
                .or_else(|| map.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("uploaded-file");
            let mime_type = map
                .get("mime_type")
                .or_else(|| map.get("mime"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let url = clean_url_field(
                map.get("url")
                    .or_else(|| map.get("uri"))
                    .and_then(Value::as_str),
                redact,
                &format!("{field_prefix}.url"),
                redacted_fields,
            );
            let size_bytes = map.get("size_bytes").and_then(Value::as_u64);
            Some(GeminiAttachmentRecord {
                kind: "uploaded_file".to_string(),
                name: clean_text_field(
                    raw_name,
                    redact,
                    &format!("{field_prefix}.name"),
                    redacted_fields,
                ),
                mime_type,
                url,
                text: None,
                size_bytes,
            })
        }
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return None;
            }
            if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                Some(GeminiAttachmentRecord {
                    kind: "uploaded_file".to_string(),
                    name: "uploaded-file".to_string(),
                    mime_type: None,
                    url: clean_url_field(
                        Some(trimmed),
                        redact,
                        &format!("{field_prefix}.url"),
                        redacted_fields,
                    ),
                    text: None,
                    size_bytes: None,
                })
            } else {
                Some(GeminiAttachmentRecord {
                    kind: "uploaded_file".to_string(),
                    name: clean_text_field(
                        trimmed,
                        redact,
                        &format!("{field_prefix}.name"),
                        redacted_fields,
                    ),
                    mime_type: None,
                    url: None,
                    text: None,
                    size_bytes: None,
                })
            }
        }
        Value::Array(arr) if !arr.is_empty() => {
            let mut parts = UploadListParts::default();
            visit_upload_list_cell(item, redact, field_prefix, redacted_fields, &mut parts);
            if parts.url.is_some() || parts.name.is_some() || parts.mime.is_some() {
                Some(GeminiAttachmentRecord {
                    kind: "uploaded_file".to_string(),
                    name: parts.name.unwrap_or_else(|| "uploaded-file".to_string()),
                    mime_type: parts.mime,
                    url: parts.url,
                    text: None,
                    size_bytes: parts.size,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

fn parse_pasted_item(
    item: &Value,
    redact: bool,
    field_prefix: &str,
    idx: usize,
    redacted_fields: &mut BTreeSet<String>,
) -> Option<GeminiAttachmentRecord> {
    match item {
        Value::Null | Value::Bool(_) => None,
        Value::Object(map) => {
            let text_raw = map
                .get("text")
                .or_else(|| map.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let name_raw = map
                .get("name")
                .or_else(|| map.get("title"))
                .and_then(Value::as_str);
            if text_raw.is_empty() && name_raw.is_none() {
                return None;
            }
            let mime = map
                .get("mime_type")
                .or_else(|| map.get("mime"))
                .and_then(Value::as_str)
                .unwrap_or("text/plain")
                .to_string();
            let fallback_name = format!("pasted-block-{}", idx + 1);
            Some(GeminiAttachmentRecord {
                kind: "pasted_block".to_string(),
                name: clean_text_field(
                    name_raw.unwrap_or(&fallback_name),
                    redact,
                    &format!("{field_prefix}.name"),
                    redacted_fields,
                ),
                mime_type: Some(mime),
                url: None,
                text: Some(clean_text_field(
                    text_raw,
                    redact,
                    &format!("{field_prefix}.text"),
                    redacted_fields,
                )),
                size_bytes: Some(text_raw.len() as u64),
            })
        }
        Value::String(s) => {
            if s.trim().is_empty() {
                return None;
            }
            Some(GeminiAttachmentRecord {
                kind: "pasted_block".to_string(),
                name: format!("pasted-block-{}", idx + 1),
                mime_type: Some("text/plain".to_string()),
                url: None,
                text: Some(clean_text_field(
                    s,
                    redact,
                    &format!("{field_prefix}.text"),
                    redacted_fields,
                )),
                size_bytes: Some(s.len() as u64),
            })
        }
        Value::Array(arr) if !arr.is_empty() => {
            let text_raw = arr.first().and_then(|v| {
                v.as_str().or_else(|| {
                    v.as_array()
                        .and_then(|sub| sub.first())
                        .and_then(Value::as_str)
                })
            });
            let name_raw = arr.get(1).and_then(Value::as_str);
            if text_raw.is_none() && name_raw.is_none() {
                return None;
            }
            let text_str = text_raw.unwrap_or("");
            let mime = arr
                .get(2)
                .and_then(Value::as_str)
                .unwrap_or("text/plain")
                .to_string();
            let fallback_name = format!("pasted-block-{}", idx + 1);
            Some(GeminiAttachmentRecord {
                kind: "pasted_block".to_string(),
                name: clean_text_field(
                    name_raw.unwrap_or(&fallback_name),
                    redact,
                    &format!("{field_prefix}.name"),
                    redacted_fields,
                ),
                mime_type: Some(mime),
                url: None,
                text: Some(clean_text_field(
                    text_str,
                    redact,
                    &format!("{field_prefix}.text"),
                    redacted_fields,
                )),
                size_bytes: Some(text_str.len() as u64),
            })
        }
        _ => None,
    }
}

fn extract_attachments(
    prompt_node: Option<&Value>,
    redact: bool,
    turn_idx: usize,
    redacted_fields: &mut BTreeSet<String>,
) -> Vec<GeminiAttachmentRecord> {
    let Some(p_arr) = prompt_node.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut attachments = Vec::new();

    // 1. Uploaded files at `t[2][0][4]`.
    if let Some(inner) = p_arr.first().and_then(Value::as_array) {
        if let Some(uploads) = inner.get(4).and_then(Value::as_array) {
            for (idx, item) in uploads.iter().enumerate() {
                if let Some(rec) = parse_upload_item(
                    item,
                    redact,
                    &format!("turns[{turn_idx}].attachments[{idx}]"),
                    redacted_fields,
                ) {
                    attachments.push(rec);
                }
            }
        }
    }

    // 2. Explicitly ignore scalar boolean `t[2][8] = false` (must never be treated as attachments).
    if matches!(p_arr.get(8), Some(Value::Bool(_))) {
        // Deliberately ignored.
    }

    // 3. Pasted blocks at `t[2][15]`.
    if let Some(raw_pasted) = p_arr.get(15) {
        match raw_pasted {
            Value::String(s) if !s.trim().is_empty() => {
                attachments.push(GeminiAttachmentRecord {
                    kind: "pasted_block".to_string(),
                    name: "pasted-text-1".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    url: None,
                    text: Some(clean_text_field(
                        s,
                        redact,
                        &format!("turns[{turn_idx}].pasted[0]"),
                        redacted_fields,
                    )),
                    size_bytes: Some(s.len() as u64),
                });
            }
            Value::Array(items) if !items.is_empty() => {
                let single_tuple = items.iter().all(|x| !x.is_array() && !x.is_object())
                    && items.first().and_then(Value::as_str).is_some();
                if single_tuple {
                    if let Some(rec) = parse_pasted_item(
                        raw_pasted,
                        redact,
                        &format!("turns[{turn_idx}].pasted[0]"),
                        0,
                        redacted_fields,
                    ) {
                        attachments.push(rec);
                    }
                } else {
                    for (p_idx, item) in items.iter().enumerate() {
                        if let Some(rec) = parse_pasted_item(
                            item,
                            redact,
                            &format!("turns[{turn_idx}].pasted[{p_idx}]"),
                            p_idx,
                            redacted_fields,
                        ) {
                            attachments.push(rec);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    attachments
}

fn normalize_thinking_sources(
    raw_sources: Option<&Value>,
    redact: bool,
    field_prefix: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> Vec<GeminiSourceCitation> {
    let Some(arr) = raw_sources.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (idx, src) in arr.iter().enumerate() {
        if let Some(map) = src.as_object() {
            let url = clean_url_field(
                map.get("url").and_then(Value::as_str),
                redact,
                &format!("{field_prefix}[{idx}].url"),
                redacted_fields,
            );
            let favicon = clean_url_field(
                map.get("favicon").and_then(Value::as_str),
                redact,
                &format!("{field_prefix}[{idx}].favicon"),
                redacted_fields,
            );
            let title = clean_text_field(
                map.get("title").and_then(Value::as_str).unwrap_or(""),
                redact,
                &format!("{field_prefix}[{idx}].title"),
                redacted_fields,
            );
            if url.is_some() || !title.is_empty() {
                out.push(GeminiSourceCitation {
                    favicon,
                    url,
                    title,
                });
            }
        } else if let Some(pair) = src.as_array() {
            let mut favicon = None;
            let mut url = None;
            let mut title = String::new();
            if pair.len() >= 3 {
                let s0 = pair[0].as_str();
                let s1 = pair[1].as_str();
                let s2 = pair[2].as_str();
                if s1.is_some_and(|u| {
                    let t = u.trim();
                    t.starts_with("http://") || t.starts_with("https://")
                }) {
                    favicon = clean_url_field(
                        s0,
                        redact,
                        &format!("{field_prefix}[{idx}].favicon"),
                        redacted_fields,
                    );
                    url = clean_url_field(
                        s1,
                        redact,
                        &format!("{field_prefix}[{idx}].url"),
                        redacted_fields,
                    );
                    title = clean_text_field(
                        s2.unwrap_or(""),
                        redact,
                        &format!("{field_prefix}[{idx}].title"),
                        redacted_fields,
                    );
                } else if s0.is_some_and(|u| {
                    let t = u.trim();
                    t.starts_with("http://") || t.starts_with("https://")
                }) {
                    url = clean_url_field(
                        s0,
                        redact,
                        &format!("{field_prefix}[{idx}].url"),
                        redacted_fields,
                    );
                    title = clean_text_field(
                        s1.unwrap_or(""),
                        redact,
                        &format!("{field_prefix}[{idx}].title"),
                        redacted_fields,
                    );
                    favicon = clean_url_field(
                        s2,
                        redact,
                        &format!("{field_prefix}[{idx}].favicon"),
                        redacted_fields,
                    );
                } else {
                    favicon = clean_url_field(
                        s0,
                        redact,
                        &format!("{field_prefix}[{idx}].favicon"),
                        redacted_fields,
                    );
                    url = clean_url_field(
                        s1,
                        redact,
                        &format!("{field_prefix}[{idx}].url"),
                        redacted_fields,
                    );
                    title = clean_text_field(
                        s2.unwrap_or(""),
                        redact,
                        &format!("{field_prefix}[{idx}].title"),
                        redacted_fields,
                    );
                }
            } else if pair.len() == 2 {
                let s0 = pair[0].as_str();
                let s1 = pair[1].as_str();
                if s1.is_some_and(|u| {
                    let t = u.trim();
                    t.starts_with("http://") || t.starts_with("https://")
                }) {
                    favicon = clean_url_field(
                        s0,
                        redact,
                        &format!("{field_prefix}[{idx}].favicon"),
                        redacted_fields,
                    );
                    url = clean_url_field(
                        s1,
                        redact,
                        &format!("{field_prefix}[{idx}].url"),
                        redacted_fields,
                    );
                } else if s0.is_some_and(|u| {
                    let t = u.trim();
                    t.starts_with("http://") || t.starts_with("https://")
                }) {
                    url = clean_url_field(
                        s0,
                        redact,
                        &format!("{field_prefix}[{idx}].url"),
                        redacted_fields,
                    );
                    title = clean_text_field(
                        s1.unwrap_or(""),
                        redact,
                        &format!("{field_prefix}[{idx}].title"),
                        redacted_fields,
                    );
                }
            }
            if url.is_some() || !title.is_empty() {
                out.push(GeminiSourceCitation {
                    favicon,
                    url,
                    title,
                });
            }
        }
    }
    out
}

fn extract_thinking_steps(
    draft: &[Value],
    redact: bool,
    turn_idx: usize,
    redacted_fields: &mut BTreeSet<String>,
) -> Vec<GeminiThinkingStep> {
    let Some(node37) = draft.get(37).and_then(Value::as_array) else {
        return Vec::new();
    };
    let Some(raw_steps) = node37.get(1).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut steps = Vec::new();
    for (s_idx, item) in raw_steps.iter().enumerate() {
        let prefix = format!("turns[{turn_idx}].thinking_steps[{s_idx}]");
        if let Some(map) = item.as_object() {
            let action = map
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("think")
                .to_string();
            let provider = map
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string);
            let header = clean_text_field(
                map.get("header").and_then(Value::as_str).unwrap_or(""),
                redact,
                &format!("{prefix}.header"),
                redacted_fields,
            );
            let body = clean_text_field(
                map.get("body").and_then(Value::as_str).unwrap_or(""),
                redact,
                &format!("{prefix}.body"),
                redacted_fields,
            );
            let sources = normalize_thinking_sources(
                map.get("sources"),
                redact,
                &format!("{prefix}.sources"),
                redacted_fields,
            );
            steps.push(GeminiThinkingStep {
                action,
                provider,
                header,
                body,
                sources,
            });
        } else if let Some(arr) = item.as_array() {
            if arr.is_empty() {
                continue;
            }
            let mut action = "think".to_string();
            let mut provider = None;
            let mut header_raw = String::new();
            let mut body_raw = String::new();
            let mut raw_sources = None;

            if arr.len() >= 5 {
                action = arr[0].as_str().unwrap_or("think").to_string();
                provider = arr[1].as_str().map(str::to_string);
                header_raw = arr[2].as_str().unwrap_or("").to_string();
                if let Some(s) = arr[3].as_str() {
                    body_raw = s.to_string();
                } else if let Some(lines) = arr[3].as_array() {
                    body_raw = lines
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                raw_sources = Some(&arr[4]);
            } else if arr.len() == 4 {
                action = arr[0].as_str().unwrap_or("think").to_string();
                provider = arr[1].as_str().map(str::to_string);
                header_raw = arr[2].as_str().unwrap_or("").to_string();
                if arr[3].is_array() {
                    raw_sources = Some(&arr[3]);
                } else {
                    body_raw = arr[3].as_str().unwrap_or("").to_string();
                }
            } else if arr.len() == 3 {
                if arr[2].is_array() {
                    header_raw = arr[0].as_str().unwrap_or("").to_string();
                    body_raw = arr[1].as_str().unwrap_or("").to_string();
                    raw_sources = Some(&arr[2]);
                } else {
                    action = arr[0].as_str().unwrap_or("think").to_string();
                    header_raw = arr[1].as_str().unwrap_or("").to_string();
                    body_raw = arr[2].as_str().unwrap_or("").to_string();
                }
            } else if arr.len() == 2 {
                header_raw = arr[0].as_str().unwrap_or("").to_string();
                body_raw = arr[1].as_str().unwrap_or("").to_string();
            } else {
                body_raw = arr[0].as_str().unwrap_or("").to_string();
            }

            let sources = normalize_thinking_sources(
                raw_sources,
                redact,
                &format!("{prefix}.sources"),
                redacted_fields,
            );
            steps.push(GeminiThinkingStep {
                action,
                provider,
                header: clean_text_field(
                    &header_raw,
                    redact,
                    &format!("{prefix}.header"),
                    redacted_fields,
                ),
                body: clean_text_field(
                    &body_raw,
                    redact,
                    &format!("{prefix}.body"),
                    redacted_fields,
                ),
                sources,
            });
        }
    }
    steps
}

fn normalize_span(
    raw_span: &Value,
    redact: bool,
    field_prefix: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> Value {
    match raw_span {
        Value::Object(map) => {
            let mut out = Map::new();
            for key in ["start", "end", "start_index", "end_index"] {
                if let Some(v) = map.get(key).filter(|v| v.is_number()) {
                    out.insert(key.to_string(), v.clone());
                }
            }
            if let Some(txt) = map.get("text").and_then(Value::as_str) {
                out.insert(
                    "text".to_string(),
                    Value::String(clean_text_field(
                        txt,
                        redact,
                        &format!("{field_prefix}.text"),
                        redacted_fields,
                    )),
                );
            }
            Value::Object(out)
        }
        Value::Array(arr) => {
            if arr.len() >= 2 && arr[0].is_number() && arr[1].is_number() {
                let mut out = Map::new();
                out.insert("start".to_string(), arr[0].clone());
                out.insert("end".to_string(), arr[1].clone());
                if let Some(txt) = arr.get(2).and_then(Value::as_str) {
                    out.insert(
                        "text".to_string(),
                        Value::String(clean_text_field(
                            txt,
                            redact,
                            &format!("{field_prefix}.text"),
                            redacted_fields,
                        )),
                    );
                }
                Value::Object(out)
            } else {
                Value::Array(
                    arr.iter()
                        .enumerate()
                        .map(|(i, v)| match v {
                            Value::String(s) => Value::String(clean_text_field(
                                s,
                                redact,
                                &format!("{field_prefix}[{i}]"),
                                redacted_fields,
                            )),
                            other => other.clone(),
                        })
                        .collect(),
                )
            }
        }
        Value::String(s) => {
            Value::String(clean_text_field(s, redact, field_prefix, redacted_fields))
        }
        other => other.clone(),
    }
}

fn normalize_grounding_item(
    item: &Value,
    redact: bool,
    field_prefix: &str,
    redacted_fields: &mut BTreeSet<String>,
) -> Option<GeminiGroundingItem> {
    if let Some(map) = item.as_object() {
        let url = clean_url_field(
            map.get("url").and_then(Value::as_str),
            redact,
            &format!("{field_prefix}.url"),
            redacted_fields,
        );
        let title = clean_text_field(
            map.get("title").and_then(Value::as_str).unwrap_or(""),
            redact,
            &format!("{field_prefix}.title"),
            redacted_fields,
        );
        let snippet = map.get("snippet").and_then(Value::as_str).map(|s| {
            clean_text_field(
                s,
                redact,
                &format!("{field_prefix}.snippet"),
                redacted_fields,
            )
        });
        let publisher = map.get("publisher").and_then(Value::as_str).map(|s| {
            clean_text_field(
                s,
                redact,
                &format!("{field_prefix}.publisher"),
                redacted_fields,
            )
        });
        if url.is_some() || !title.is_empty() || snippet.is_some() {
            return Some(GeminiGroundingItem {
                url,
                title,
                snippet,
                publisher,
            });
        }
        return None;
    }

    let arr = item.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let (raw_url, pub_hint) = if let Some(sub) = arr[0].as_array() {
        (
            sub.first().and_then(Value::as_str),
            sub.get(1).and_then(Value::as_str),
        )
    } else {
        (arr[0].as_str(), None)
    };
    let url = clean_url_field(
        raw_url,
        redact,
        &format!("{field_prefix}.url"),
        redacted_fields,
    );
    let title = clean_text_field(
        arr.get(1).and_then(Value::as_str).unwrap_or(""),
        redact,
        &format!("{field_prefix}.title"),
        redacted_fields,
    );
    let snippet = arr.get(2).and_then(Value::as_str).map(|s| {
        clean_text_field(
            s,
            redact,
            &format!("{field_prefix}.snippet"),
            redacted_fields,
        )
    });
    let publisher = arr.get(3).and_then(Value::as_str).or(pub_hint).map(|s| {
        clean_text_field(
            s,
            redact,
            &format!("{field_prefix}.publisher"),
            redacted_fields,
        )
    });
    if url.is_some() || !title.is_empty() || snippet.is_some() {
        Some(GeminiGroundingItem {
            url,
            title,
            snippet,
            publisher,
        })
    } else {
        None
    }
}

fn extract_grounding_citations(
    draft: &[Value],
    redact: bool,
    turn_idx: usize,
    redacted_fields: &mut BTreeSet<String>,
) -> Vec<GeminiGroundingCitation> {
    let Some(node2) = draft.get(2).and_then(Value::as_array) else {
        return Vec::new();
    };
    let Some(raw_groups) = node2.get(1).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (g_idx, group) in raw_groups.iter().enumerate() {
        let prefix = format!("turns[{turn_idx}].grounding_citations[{g_idx}]");
        if let Some(map) = group.as_object() {
            let span = map
                .get("span")
                .map(|s| normalize_span(s, redact, &format!("{prefix}.span"), redacted_fields))
                .unwrap_or(Value::Null);
            let mut items = Vec::new();
            if let Some(raw_items) = map.get("items").and_then(Value::as_array) {
                for (i_idx, item) in raw_items.iter().enumerate() {
                    if let Some(norm) = normalize_grounding_item(
                        item,
                        redact,
                        &format!("{prefix}.items[{i_idx}]"),
                        redacted_fields,
                    ) {
                        items.push(norm);
                    }
                }
            }
            if !span.is_null() || !items.is_empty() {
                out.push(GeminiGroundingCitation { span, items });
            }
        } else if let Some(arr) = group.as_array() {
            if arr.len() >= 2 && arr[1].is_array() {
                let span =
                    normalize_span(&arr[0], redact, &format!("{prefix}.span"), redacted_fields);
                let raw_items_arr = arr[1].as_array().expect("checked array");
                let flat_single = raw_items_arr
                    .first()
                    .and_then(Value::as_str)
                    .is_some_and(|u| u.starts_with("http://") || u.starts_with("https://"));
                let mut items = Vec::new();
                if flat_single {
                    if let Some(norm) = normalize_grounding_item(
                        &arr[1],
                        redact,
                        &format!("{prefix}.items[0]"),
                        redacted_fields,
                    ) {
                        items.push(norm);
                    }
                } else {
                    for (i_idx, item) in raw_items_arr.iter().enumerate() {
                        if let Some(norm) = normalize_grounding_item(
                            item,
                            redact,
                            &format!("{prefix}.items[{i_idx}]"),
                            redacted_fields,
                        ) {
                            items.push(norm);
                        }
                    }
                }
                if !span.is_null() || !items.is_empty() {
                    out.push(GeminiGroundingCitation { span, items });
                }
            } else if let Some(norm) = normalize_grounding_item(
                group,
                redact,
                &format!("{prefix}.items[0]"),
                redacted_fields,
            ) {
                out.push(GeminiGroundingCitation {
                    span: Value::Null,
                    items: vec![norm],
                });
            }
        }
    }
    out
}

fn extract_turn(
    raw_turn: &Value,
    turn_idx: usize,
    header_conv_id: Option<&str>,
    model_map: &BTreeMap<String, String>,
    redact: bool,
    redacted_fields: &mut BTreeSet<String>,
) -> Result<GeminiShareTurn, GeminiShareError> {
    let arr = raw_turn.as_array().ok_or_else(|| {
        GeminiShareError::MalformedPayload(format!("turn[{turn_idx}] must be a JSON array"))
    })?;

    let mut conversation_id = header_conv_id.map(str::to_string);
    let mut turn_id = String::new();
    if let Some(t0) = arr.first() {
        if let Some(id_pair) = t0.as_array() {
            if id_pair.len() >= 2 {
                if let Some(cid) = id_pair[0].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    conversation_id = Some(cid.to_string());
                }
                turn_id = id_pair[1]
                    .as_str()
                    .or_else(|| id_pair[0].as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
            } else if let Some(tid) = id_pair.first().and_then(Value::as_str) {
                turn_id = tid.trim().to_string();
            }
        } else if let Some(tid) = t0.as_str() {
            turn_id = tid.trim().to_string();
            if conversation_id.is_none() && !turn_id.is_empty() {
                conversation_id = Some(turn_id.clone());
            }
        }
    }

    let prompt_node = arr.get(2);
    let raw_prompt = prompt_node
        .and_then(Value::as_array)
        .and_then(|p| p.first())
        .and_then(|p0| {
            p0.as_array()
                .and_then(|inner| inner.first())
                .and_then(Value::as_str)
                .or_else(|| p0.as_str())
        })
        .unwrap_or("");
    let prompt_text = clean_text_field(
        raw_prompt,
        redact,
        &format!("turns[{turn_idx}].prompt_text"),
        redacted_fields,
    );
    let attachments = extract_attachments(prompt_node, redact, turn_idx, redacted_fields);

    let resp_node = arr.get(3).and_then(Value::as_array);
    let mut search_queries = Vec::new();
    if let Some(queries) = resp_node.and_then(|r| r.get(1)).and_then(Value::as_array) {
        for (q_idx, q) in queries.iter().enumerate() {
            let q_str = q
                .as_str()
                .or_else(|| {
                    q.as_array()
                        .and_then(|sub| sub.first())
                        .and_then(Value::as_str)
                })
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(qs) = q_str {
                search_queries.push(clean_text_field(
                    qs,
                    redact,
                    &format!("turns[{turn_idx}].search_queries[{q_idx}]"),
                    redacted_fields,
                ));
            }
        }
    }

    let model_id = resp_node.and_then(|r| r.get(14)).and_then(|v| {
        v.as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| v.as_i64().map(|n| n.to_string()))
            .or_else(|| {
                v.as_array().and_then(|a| {
                    a.first().and_then(|x| {
                        x.as_str()
                            .map(|s| s.trim().to_string())
                            .or_else(|| x.as_i64().map(|n| n.to_string()))
                    })
                })
            })
    });
    let model_name = model_id
        .as_deref()
        .and_then(|id| model_map.get(id))
        .map(|lbl| {
            clean_text_field(
                lbl,
                redact,
                &format!("turns[{turn_idx}].model_name"),
                redacted_fields,
            )
        });

    let draft: &[Value] = resp_node
        .and_then(|r| r.first())
        .and_then(Value::as_array)
        .and_then(|drafts| {
            drafts
                .first()
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .or(Some(drafts.as_slice()))
        })
        .unwrap_or(&[]);

    let response_id = draft
        .first()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let raw_resp_md = draft
        .get(1)
        .and_then(|v| {
            v.as_array()
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .or_else(|| v.as_str())
        })
        .unwrap_or("");
    let response_markdown = clean_text_field(
        raw_resp_md,
        redact,
        &format!("turns[{turn_idx}].response_markdown"),
        redacted_fields,
    );

    let thinking_steps = extract_thinking_steps(draft, redact, turn_idx, redacted_fields);
    let grounding_citations = extract_grounding_citations(draft, redact, turn_idx, redacted_fields);

    Ok(GeminiShareTurn {
        turn_index: turn_idx,
        conversation_id,
        turn_id,
        prompt_text,
        attachments,
        search_queries,
        model_id,
        model_name,
        response_id,
        response_markdown,
        thinking_steps,
        grounding_citations,
    })
}

fn compute_summary(turns: &[GeminiShareTurn], cursor_exhausted: bool) -> GeminiExtractionSummary {
    let mut turns_with_thinking = 0usize;
    let mut thinking_steps_total = 0usize;
    let mut turns_with_sources = 0usize;
    let mut unique_urls = BTreeSet::new();
    let mut search_queries_total = 0usize;
    let mut attachments_total = 0usize;
    let mut empty_turns_total = 0usize;

    for turn in turns {
        let prompt_ok = !turn.prompt_text.trim().is_empty() || !turn.attachments.is_empty();
        let resp_ok = !turn.response_markdown.trim().is_empty() || !turn.thinking_steps.is_empty();
        if !prompt_ok || !resp_ok {
            empty_turns_total += 1;
        }

        if !turn.thinking_steps.is_empty() {
            turns_with_thinking += 1;
            thinking_steps_total += turn.thinking_steps.len();
        }

        let mut turn_has_source = false;
        for step in &turn.thinking_steps {
            for src in &step.sources {
                if let Some(u) = src.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    unique_urls.insert(u.to_string());
                    turn_has_source = true;
                } else if !src.title.trim().is_empty() {
                    turn_has_source = true;
                }
            }
        }
        for gc in &turn.grounding_citations {
            for item in &gc.items {
                if let Some(u) = item.url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    unique_urls.insert(u.to_string());
                    turn_has_source = true;
                } else if !item.title.trim().is_empty() {
                    turn_has_source = true;
                }
            }
        }
        if turn_has_source {
            turns_with_sources += 1;
        }

        search_queries_total += turn.search_queries.len();
        attachments_total += turn.attachments.len();
    }

    GeminiExtractionSummary {
        turns_total: turns.len(),
        turns_with_thinking,
        thinking_steps_total,
        turns_with_sources,
        unique_sources_total: unique_urls.len(),
        search_queries_total,
        attachments_total,
        empty_turns_total,
        cursor_exhausted,
    }
}

/// Parses a single or concatenated multi-page WIZ `batchexecute` payload into a normalized
/// `GeminiShareTranscript` (`omnia.gemini-share-transcript.v1`), applying strict redaction
/// when `redact == true`.
pub fn parse_gemini_share_transcript(
    raw_text: &str,
    source_url: Option<&str>,
    redact: bool,
) -> Result<GeminiShareTranscript, GeminiShareError> {
    parse_gemini_share_transcript_pages(&[raw_text], source_url, redact)
}

/// Parses one or more paginated WIZ `batchexecute` responses into a single deduplicated
/// `GeminiShareTranscript` with cursor-exhaustion and completeness tracking.
pub fn parse_gemini_share_transcript_pages(
    raw_pages: &[&str],
    source_url: Option<&str>,
    redact: bool,
) -> Result<GeminiShareTranscript, GeminiShareError> {
    let mut redacted_fields = BTreeSet::new();
    let (validated_url, url_share_id) = match source_url.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let info = validate_gemini_share_url(raw)?;
            if redact
                && (!info.url_info.stripped_tracking_params.is_empty()
                    || !info.url_info.preserved_signed_params.is_empty())
            {
                redacted_fields.insert("source_url:sanitized".to_string());
            }
            (info.normalized_url, Some(info.share_id))
        }
        None => (String::new(), None),
    };

    let mut all_pages = Vec::new();
    let mut model_map = BTreeMap::new();
    for raw_chunk in raw_pages {
        let decoded = parse_batchexecute_ujx1bf(raw_chunk)?;
        all_pages.extend(decoded.pages);
        model_map.extend(decoded.model_map);
    }

    if all_pages.is_empty() {
        return Err(GeminiShareError::MalformedPayload(
            "no ujx1Bf pages found in batchexecute payload".to_string(),
        ));
    }

    let mut title = None;
    let mut share_id = url_share_id;
    let mut published_timestamp = None;
    let mut header_conv_id = None;

    let mut seen_cursors = BTreeSet::new();
    let mut seen_turn_keys = BTreeSet::new();
    let mut turns = Vec::new();
    let mut last_cursor = None;
    let mut cursor_cycle = false;

    for (page_idx, page) in all_pages.iter().enumerate() {
        if page_idx >= MAX_PAGINATION_PAGES {
            break;
        }
        if title.is_none() {
            if let Some(t) = page.title.as_deref() {
                title = Some(clean_text_field(t, redact, "title", &mut redacted_fields));
            }
        }
        if share_id.is_none() {
            share_id = page.share_id.clone();
        }
        if published_timestamp.is_none() {
            published_timestamp = page.published_timestamp.clone();
        }
        if header_conv_id.is_none() {
            header_conv_id = page.header_conversation_id.clone();
        }

        for raw_turn in &page.turns {
            let next_idx = turns.len();
            let parsed_turn = extract_turn(
                raw_turn,
                next_idx,
                header_conv_id.as_deref(),
                &model_map,
                redact,
                &mut redacted_fields,
            )?;
            let dedup_key = (
                if parsed_turn.turn_id.is_empty() {
                    format!("idx:{next_idx}")
                } else {
                    parsed_turn.turn_id.clone()
                },
                parsed_turn.response_id.clone().unwrap_or_default(),
            );
            if !parsed_turn.turn_id.is_empty() && seen_turn_keys.contains(&dedup_key) {
                continue;
            }
            seen_turn_keys.insert(dedup_key);
            turns.push(parsed_turn);
        }

        last_cursor = page.cursor.clone();
        if let Some(c) = &last_cursor {
            if !seen_cursors.insert(c.clone()) {
                cursor_cycle = true;
                break;
            }
        }
    }

    let cursor_exhausted = last_cursor.is_none() && !cursor_cycle;
    let summary = compute_summary(&turns, cursor_exhausted);

    let clean_model_map: BTreeMap<String, String> = model_map
        .into_iter()
        .map(|(k, v)| {
            let cleaned =
                clean_text_field(&v, redact, &format!("model_map.{k}"), &mut redacted_fields);
            (k, cleaned)
        })
        .collect();

    Ok(GeminiShareTranscript {
        schema_version: GEMINI_SHARE_SCHEMA_VERSION.to_string(),
        source_url: validated_url,
        share_id,
        title: title.unwrap_or_default(),
        published_timestamp,
        cursor_exhausted,
        next_cursor: last_cursor,
        pages_processed: all_pages.len(),
        model_map: clean_model_map,
        turns,
        summary,
        redaction_applied: redact,
        redacted_fields: redacted_fields.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_chunk(envelopes: Value) -> String {
        let s = serde_json::to_string(&envelopes).expect("serialize envelope");
        format!("{}\n{s}\n", s.len())
    }

    struct SampleTurnInput<'a> {
        conv_id: &'a str,
        turn_id: &'a str,
        prompt: &'a str,
        resp_id: &'a str,
        resp_md: &'a str,
        uploads: Value,
        pasted: Value,
        queries: Value,
        model_id: &'a str,
        thinking_steps: Value,
        grounding: Value,
        turn_2_8_flag: bool,
    }

    fn sample_turn(spec: SampleTurnInput<'_>) -> Value {
        let mut prompt_node = vec![Value::Null; 16];
        prompt_node[0] = json!([spec.prompt, null, null, null, spec.uploads]);
        prompt_node[8] = Value::Bool(spec.turn_2_8_flag);
        prompt_node[15] = spec.pasted;

        let mut draft = vec![Value::Null; 38];
        draft[0] = Value::String(spec.resp_id.to_string());
        draft[1] = json!([spec.resp_md]);
        draft[2] = json!([null, spec.grounding]);
        draft[37] = json!([null, spec.thinking_steps]);

        let mut resp_node = vec![Value::Null; 15];
        resp_node[0] = Value::Array(vec![Value::Array(draft)]);
        resp_node[1] = spec.queries;
        resp_node[14] = Value::String(spec.model_id.to_string());

        json!([[spec.conv_id, spec.turn_id], null, prompt_node, resp_node])
    }

    #[test]
    fn validates_public_share_urls_and_refuses_auth_and_captcha_gates() {
        let ok1 =
            validate_gemini_share_url("https://share.gemini.google/1f2021de30e9?utm_source=x")
                .expect("share.gemini.google accepted");
        assert_eq!(ok1.share_id, "1f2021de30e9");
        assert_eq!(
            ok1.normalized_url,
            "https://share.gemini.google/1f2021de30e9"
        );

        let ok2 = validate_gemini_share_url("https://gemini.google.com/share/abcd_1234/")
            .expect("gemini.google.com/share accepted");
        assert_eq!(ok2.share_id, "abcd_1234");
        assert_eq!(
            ok2.normalized_url,
            "https://gemini.google.com/share/abcd_1234"
        );

        for auth_url in [
            "https://gemini.google.com/app/private_chat_1",
            "https://gemini.google.com/u/0/app/private_chat_2",
            "https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app",
        ] {
            assert!(
                matches!(
                    validate_gemini_share_url(auth_url),
                    Err(GeminiShareError::AuthRequired {
                        reason: GeminiShareBlockReason::AuthRequired,
                        ..
                    })
                ),
                "expected AuthRequired for {auth_url}"
            );
        }

        for captcha_url in [
            "https://www.google.com/sorry/index?continue=https://share.gemini.google/1f2021de30e9",
            "https://google.com/sorry/index",
        ] {
            assert!(
                matches!(
                    validate_gemini_share_url(captcha_url),
                    Err(GeminiShareError::CaptchaBlocked {
                        reason: GeminiShareBlockReason::CaptchaBlocked,
                        ..
                    })
                ),
                "expected CaptchaBlocked for {captcha_url}"
            );
        }

        assert!(matches!(
            validate_gemini_share_url("https://user:dummy_password@share.gemini.google/1f2021de30e9"),
            Err(GeminiShareError::PolicyRejected {
                reason: GeminiShareBlockReason::EmbeddedCredentials,
                ..
            })
        ));
    }

    #[test]
    fn decodes_wiz_ujx1bf_with_thinking_sources_grounding_and_ignores_turn_2_8_false() {
        let turn1 = sample_turn(SampleTurnInput {
            conv_id: "c_rust_1",
            turn_id: "r_rust_1",
            prompt: "Analyze WIZ batchexecute extraction",
            resp_id: "rc_rust_1",
            resp_md: "Grounded Rust summary.",
            uploads: json!([[
                "https://example.org/files/spec.pdf",
                "spec.pdf",
                "application/pdf",
                1024
            ]]),
            pasted: json!([["fn parse() {}", "parse.rs", "text/rust"]]),
            queries: json!(["gemini ujx1Bf", "draft 37 thinking"]),
            model_id: "model_pro_25",
            thinking_steps: json!([[
                "search",
                "google_search",
                "Searching WIZ format",
                "Inspecting draft[37][1] thoughts and interleaved sources.",
                [
                    [
                        "https://example.com/favicon.ico",
                        "https://example.com/wiz",
                        "WIZ Spec"
                    ],
                    [
                        "https://example.org/favicon.ico",
                        "https://example.org/notes",
                        "Notes"
                    ]
                ]
            ]]),
            grounding: json!([[
                [0, 22, "Grounded Rust summary."],
                [[
                    "https://example.com/wiz?utm_source=copy",
                    "WIZ Spec",
                    "Length-prefixed wrb.fr frames",
                    "Example Docs"
                ]]
            ]]),
            turn_2_8_flag: false,
        });

        let ujx_root = json!([[
            null,
            [turn1],
            ["c_rust_1", "Rust Gemini Share \u{1F680}"],
            "1f2021de30e9",
            [1731542400, 0]
        ]]);
        let ot_payload = json!([["model_pro_25", "Gemini 2.5 Pro"]]);

        let raw = format!(
            ")]}}'\n\n{}",
            make_chunk(json!([
                [
                    "wrb.fr",
                    "otAQ7b",
                    ot_payload.to_string(),
                    null,
                    null,
                    null,
                    "generic"
                ],
                [
                    "wrb.fr",
                    "ujx1Bf",
                    ujx_root.to_string(),
                    null,
                    null,
                    null,
                    "generic"
                ],
                ["di", 42]
            ]))
        );

        let transcript = parse_gemini_share_transcript(
            &raw,
            Some("https://share.gemini.google/1f2021de30e9"),
            true,
        )
        .expect("transcript parses");

        assert_eq!(transcript.schema_version, GEMINI_SHARE_SCHEMA_VERSION);
        assert_eq!(transcript.share_id.as_deref(), Some("1f2021de30e9"));
        assert_eq!(
            transcript.published_timestamp.as_deref(),
            Some("2024-11-14T00:00:00Z")
        );
        assert!(transcript.cursor_exhausted);
        assert!(transcript.summary.is_complete());
        assert_eq!(transcript.turns.len(), 1);
        let t = &transcript.turns[0];
        assert_eq!(t.attachments.len(), 2);
        assert_eq!(t.attachments[0].kind, "uploaded_file");
        assert_eq!(t.attachments[1].kind, "pasted_block");
        assert_eq!(t.model_name.as_deref(), Some("Gemini 2.5 Pro"));
        assert_eq!(t.thinking_steps.len(), 1);
        assert_eq!(t.thinking_steps[0].sources.len(), 2);
        assert_eq!(t.grounding_citations.len(), 1);
        assert_eq!(
            t.grounding_citations[0].items[0].url.as_deref(),
            Some("https://example.com/wiz")
        );
        assert_eq!(transcript.summary.unique_sources_total, 2);
        assert_eq!(transcript.summary.search_queries_total, 2);
        assert_eq!(transcript.summary.attachments_total, 2);

        let as_json = transcript.to_json();
        assert_eq!(as_json["schema_version"], GEMINI_SHARE_SCHEMA_VERSION);
    }

    #[test]
    fn supports_pagination_and_enforces_redaction_and_prototype_rejection() {
        let fake_sk = format!("{}-{}", "sk", "dummy_rust_secret_123456");
        let fake_pem = format!(
            "-----BEGIN {}-----\nMIIE_DUMMY_RUST\n-----END {}-----",
            "RSA PRIVATE KEY", "RSA PRIVATE KEY"
        );
        let fake_cookie = "__Secure-1PSID=dummy_cookie_secret_987654; SID=dummy_sid_123456";
        let signed_url = "https://cdn.example.test/file.pdf?X-Amz-Signature=dummy_amz_sig_999&X-Goog-Signature=dummy_goog_sig_888&utm_source=x";
        let prompt_str = format!("Prompt with {fake_sk} and C:\\Users\\DummyWinUser\\note.txt");
        let resp_str = format!(
            "Bearer dummy_bearer_token_99999\n{fake_cookie}\n{fake_pem}\n{signed_url}\nalice@example.test"
        );

        let t1 = sample_turn(SampleTurnInput {
            conv_id: "c_pg",
            turn_id: "r_pg_1",
            prompt: &prompt_str,
            resp_id: "rc_pg_1",
            resp_md: &resp_str,
            uploads: json!([]),
            pasted: json!(null),
            queries: json!([]),
            model_id: "model_flash",
            thinking_steps: json!([]),
            grounding: json!([]),
            turn_2_8_flag: false,
        });
        let t2 = sample_turn(SampleTurnInput {
            conv_id: "c_pg",
            turn_id: "r_pg_2",
            prompt: "Second turn /home/dummyposix/doc.md",
            resp_id: "rc_pg_2",
            resp_md: "Clean second response",
            uploads: json!([]),
            pasted: json!(null),
            queries: json!([]),
            model_id: "model_flash",
            thinking_steps: json!([]),
            grounding: json!([]),
            turn_2_8_flag: true,
        });

        let page1 = format!(
            ")]}}'\n{}",
            make_chunk(json!([[
                "wrb.fr",
                "ujx1Bf",
                json!([[
                    "next_cur_2",
                    [t1.clone()],
                    ["c_pg", "Paged Share"],
                    "pg_share_1",
                    1731542400
                ]])
                .to_string(),
                null,
                null,
                null,
                "generic"
            ]]))
        );
        let page2 = format!(
            ")]}}'\n{}",
            make_chunk(json!([[
                "wrb.fr",
                "ujx1Bf",
                json!([[
                    null,
                    [t1, t2],
                    ["c_pg", "Paged Share"],
                    "pg_share_1",
                    1731542400
                ]])
                .to_string(),
                null,
                null,
                null,
                "generic"
            ]]))
        );

        let partial = parse_gemini_share_transcript(&page1, None, true).expect("page 1 parses");
        assert!(!partial.cursor_exhausted);
        assert!(!partial.summary.is_complete());

        let full = parse_gemini_share_transcript_pages(
            &[&page1, &page2],
            Some("https://share.gemini.google/pg_share_1"),
            true,
        )
        .expect("multi-page parses");
        assert!(full.cursor_exhausted);
        assert!(full.summary.is_complete());
        assert_eq!(full.turns.len(), 2);

        let dumped = full.to_json().to_string();
        assert_eq!(
            serde_json::to_value(&full).expect("serde Serialize matches to_json"),
            full.to_json()
        );
        for forbidden in [
            "dummy_rust_secret_123456",
            "dummy_cookie_secret_987654",
            "dummy_sid_123456",
            "MIIE_DUMMY_RUST",
            "dummy_amz_sig_999",
            "dummy_goog_sig_888",
            "dummy_bearer_token_99999",
            "alice@example.test",
            "DummyWinUser",
            "dummyposix",
        ] {
            assert!(
                !dumped.contains(forbidden),
                "leaked sensitive material: {forbidden}"
            );
        }
        assert!(detect_json_secrets(&full.to_json()).is_empty());

        // Cookie header redaction
        let (clean_hdr, hdr_hits) =
            redact_text("Cookie: SID=dummy_sid_cookie_777; HSID=dummy_hsid_888");
        assert!(!clean_hdr.contains("dummy_sid_cookie_777"));
        assert!(!hdr_hits.is_empty());

        // Ensure standard `)]}'` + unsafe prototype key inside payload triggers `UnsafePrototypeKey`.
        let evil_valid = r#")]}'
[["wrb.fr","ujx1Bf","{\"__proto__\":{\"polluted\":true}}",null,null,null,"generic"]]"#;
        assert!(matches!(
            parse_batchexecute_ujx1bf(evil_valid),
            Err(GeminiShareError::UnsafePrototypeKey(_))
        ));

        let evil_constructor = r#")]}'
[["wrb.fr","ujx1Bf","{\"constructor\":{\"x\":1}}",null,null,null,"generic"]]"#;
        assert!(matches!(
            parse_batchexecute_ujx1bf(evil_constructor),
            Err(GeminiShareError::UnsafePrototypeKey(_))
        ));

        let html_captcha =
            "<html><title>Sorry</title><body>google.com/sorry g-recaptcha</body></html>";
        assert!(matches!(
            parse_batchexecute_ujx1bf(html_captcha),
            Err(GeminiShareError::CaptchaBlocked { .. })
        ));

        let wiz_unauth = r#")]}'
[["wrb.fr","ujx1Bf",null,null,null,[7],"generic"]]"#;
        assert!(matches!(
            parse_batchexecute_ujx1bf(wiz_unauth),
            Err(GeminiShareError::AuthRequired { .. })
        ));

        // Empty turn fails completeness check.
        let empty_t = sample_turn(SampleTurnInput {
            conv_id: "c_empty",
            turn_id: "r_empty",
            prompt: "",
            resp_id: "rc_empty",
            resp_md: "",
            uploads: json!([]),
            pasted: json!(null),
            queries: json!([]),
            model_id: "model_flash",
            thinking_steps: json!([]),
            grounding: json!([]),
            turn_2_8_flag: false,
        });
        let raw_empty = format!(
            ")]}}'\n{}",
            make_chunk(json!([[
                "wrb.fr",
                "ujx1Bf",
                json!([[
                    null,
                    [empty_t],
                    ["c_empty", "Empty"],
                    "empty_share_1",
                    1731542400
                ]])
                .to_string(),
                null,
                null,
                null,
                "generic"
            ]]))
        );
        let tr_empty =
            parse_gemini_share_transcript(&raw_empty, None, true).expect("parses empty turn");
        assert_eq!(tr_empty.summary.empty_turns_total, 1);
        assert!(!tr_empty.summary.is_complete());
    }
}
