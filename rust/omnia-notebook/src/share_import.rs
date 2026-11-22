//! Live pure-Rust Public Gemini Share (`https://share.gemini.google/<id>` and
//! `https://gemini.google.com/share/<id>`) importer wired directly to
//! `omnia-connector-gateway::gemini_share` with zero-retry fail-closed
//! `429 AUTH_CHALLENGE_REQUIRED` circuit breaking and `VisibleHandoffManager`
//! (`MANUAL_VISIBLE_BROWSER_ONLY`).

use std::sync::Arc;
use std::time::Duration;

use omnia_connector_gateway::gemini_share::{
    parse_gemini_share_transcript_pages, validate_gemini_share_url, GeminiShareError,
    GeminiShareTranscript,
};
use omnia_core::{now_epoch_ms, SecretRedactor};
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::error::NotebookError;
use crate::ingestion::chunk_text_semantically;
use crate::policy::{AuthChallengeCircuitBreaker, VisibleHandoffManager, MAX_CHUNK_BYTES};
use crate::source_library::{
    SourceKind, SourceLibrary, SourceRecord, SourceRegistrationInput,
};
use crate::store::{NotebookStore, NotebookTurnRecord};

/// Maximum public share HTTP response body accepted (matches the 64 MiB WIZ decoder ceiling).
pub const MAX_SHARE_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// Result of importing a public Gemini share thread into a notebook.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShareImportOutcome {
    pub notebook_id: String,
    pub share_id: Option<String>,
    pub normalized_url: String,
    pub source: SourceRecord,
    pub deduplicated: bool,
    pub imported_turns: usize,
    pub cursor_exhausted: bool,
    pub redacted_fields: Vec<String>,
}

/// Configuration for the live HTTP public share importer.
#[derive(Debug, Clone)]
pub struct ShareImporterConfig {
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub user_agent: String,
    /// Test-only loopback override URL strictly gated out of production builds.
    #[cfg(any(test, feature = "test-loopback"))]
    pub fetch_url_override: Option<String>,
}

impl Default for ShareImporterConfig {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(20),
            user_agent: "OmniaNotebook/0.1 (+public-share-importer)".to_string(),
            #[cfg(any(test, feature = "test-loopback"))]
            fetch_url_override: None,
        }
    }
}

/// Live pure-Rust public `share.gemini.google/<id>` importer enforcing strict zero-retry
/// `429 AUTH_CHALLENGE_REQUIRED` circuit breaking.
#[derive(Debug, Clone)]
pub struct PublicShareImporter {
    store: Arc<NotebookStore>,
    library: SourceLibrary,
    circuit_breaker: Arc<AuthChallengeCircuitBreaker>,
    handoff: Arc<VisibleHandoffManager>,
    config: ShareImporterConfig,
}

impl PublicShareImporter {
    #[must_use]
    pub fn new(
        store: Arc<NotebookStore>,
        library: SourceLibrary,
        circuit_breaker: Arc<AuthChallengeCircuitBreaker>,
        handoff: Arc<VisibleHandoffManager>,
        config: ShareImporterConfig,
    ) -> Self {
        Self {
            store,
            library,
            circuit_breaker,
            handoff,
            config,
        }
    }

    /// Return a copy of this importer with an explicit loopback HTTP fetch override
    /// (compiled ONLY in tests or when the non-default `test-loopback` feature is enabled).
    #[cfg(any(test, feature = "test-loopback"))]
    #[must_use]
    pub fn with_fetch_url_override(&self, override_url: impl Into<String>) -> Self {
        let mut cfg = self.config.clone();
        cfg.fetch_url_override = Some(override_url.into());
        Self {
            store: Arc::clone(&self.store),
            library: self.library.clone(),
            circuit_breaker: Arc::clone(&self.circuit_breaker),
            handoff: Arc::clone(&self.handoff),
            config: cfg,
        }
    }

    /// Deterministically decode and import one or more raw Google WIZ `batchexecute` (`ujx1Bf`)
    /// response payloads for a validated public Gemini share URL into `notebook_id`.
    ///
    /// If the URL or payload hits an auth or CAPTCHA gate, immediately trips the zero-retry
    /// `429 AUTH_CHALLENGE_REQUIRED` circuit breaker and emits a `MANUAL_VISIBLE_BROWSER_ONLY` ticket.
    pub fn import_public_share_pages(
        &self,
        notebook_id: &str,
        share_url: &str,
        raw_batchexecute_pages: &[&str],
    ) -> Result<ShareImportOutcome, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        // Fail closed immediately if circuit breaker is already tripped (0 retries!).
        self.circuit_breaker.check_allowed()?;

        let url_info = match validate_gemini_share_url(share_url) {
            Ok(info) => info,
            Err(err @ (GeminiShareError::AuthRequired { .. } | GeminiShareError::CaptchaBlocked { .. })) => {
                return Err(self
                    .circuit_breaker
                    .trip(&self.handoff, share_url, &err.to_string()));
            }
            Err(err) => return Err(NotebookError::GeminiShare(err)),
        };

        let transcript =
            match parse_gemini_share_transcript_pages(raw_batchexecute_pages, Some(&url_info.normalized_url), true) {
                Ok(t) => t,
                Err(err @ (GeminiShareError::AuthRequired { .. } | GeminiShareError::CaptchaBlocked { .. })) => {
                    return Err(self.circuit_breaker.trip(
                        &self.handoff,
                        &url_info.normalized_url,
                        &err.to_string(),
                    ));
                }
                Err(err) => return Err(NotebookError::GeminiShare(err)),
            };

        self.persist_transcript(notebook_id, &url_info.normalized_url, &transcript)
    }

    /// Live async pure-Rust HTTP fetch + WIZ decode + notebook ingestion for a public
    /// `share.gemini.google/<id>` or `gemini.google.com/share/<id>` URL.
    ///
    /// Enforces **zero automatic retries** on HTTP 429, 401, 403, auth redirects, or CAPTCHA gates:
    /// trips [`AuthChallengeCircuitBreaker`] immediately and returns `429 AUTH_CHALLENGE_REQUIRED`
    /// with a [`crate::policy::VisibleHandoffTicket`] (`MANUAL_VISIBLE_BROWSER_ONLY`).
    pub async fn fetch_and_import_public_share(
        &self,
        notebook_id: &str,
        share_url: &str,
    ) -> Result<ShareImportOutcome, NotebookError> {
        let _ = self.library.require_notebook(notebook_id)?;
        self.circuit_breaker.check_allowed()?;

        let url_info = match validate_gemini_share_url(share_url) {
            Ok(info) => info,
            Err(err @ (GeminiShareError::AuthRequired { .. } | GeminiShareError::CaptchaBlocked { .. })) => {
                return Err(self
                    .circuit_breaker
                    .trip(&self.handoff, share_url, &err.to_string()));
            }
            Err(err) => return Err(NotebookError::GeminiShare(err)),
        };

        #[cfg(any(test, feature = "test-loopback"))]
        let target_url = if let Some(ref override_raw) = self.config.fetch_url_override {
            validate_loopback_test_override(override_raw)?
        } else {
            url_info.normalized_url.clone()
        };
        #[cfg(not(any(test, feature = "test-loopback")))]
        let target_url = url_info.normalized_url.clone();

        // Never follow redirects blindly so redirects to `google.com/sorry` or `accounts.google.com`
        // trip the fail-closed circuit breaker immediately with zero retries.
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(self.config.connect_timeout)
            .timeout(self.config.request_timeout)
            .user_agent(&self.config.user_agent)
            .build()
            .map_err(|e| NotebookError::Http(format!("failed building reqwest client: {e}")))?;

        let response = client
            .get(&target_url)
            .header("Accept", "text/html,application/json,text/plain;q=0.9")
            .send()
            .await
            .map_err(|e| NotebookError::Http(format!("failed fetching public share: {e}")))?;

        let status = response.status();
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        // Zero-retry fail-closed check on 429 / 401 / 403.
        if status == StatusCode::TOO_MANY_REQUESTS
            || status == StatusCode::UNAUTHORIZED
            || status == StatusCode::FORBIDDEN
        {
            return Err(self.circuit_breaker.trip(
                &self.handoff,
                &url_info.normalized_url,
                &format!("upstream returned HTTP {} requiring interactive verification", status.as_u16()),
            ));
        }

        // Inspect redirects explicitly for auth/CAPTCHA gates.
        if status.is_redirection() {
            let loc_low = location.as_deref().unwrap_or("").to_ascii_lowercase();
            if loc_low.contains("google.com/sorry")
                || loc_low.contains("accounts.google.com")
                || loc_low.contains("consent.google.com")
                || loc_low.contains("signin")
            {
                return Err(self.circuit_breaker.trip(
                    &self.handoff,
                    &url_info.normalized_url,
                    "public share redirected to authentication or CAPTCHA gate",
                ));
            }
            return Err(NotebookError::Http(format!(
                "unexpected HTTP {} redirect while fetching public share",
                status.as_u16()
            )));
        }

        if !status.is_success() {
            return Err(NotebookError::Http(format!(
                "public share endpoint returned HTTP {}",
                status.as_u16()
            )));
        }

        // Bounded streaming body read (never buffers more than the WIZ decoder's 64 MiB ceiling).
        if response
            .content_length()
            .is_some_and(|len| len > MAX_SHARE_RESPONSE_BYTES as u64)
        {
            return Err(NotebookError::SecurityRejected {
                code: "SHARE_RESPONSE_TOO_LARGE",
                reason: format!(
                    "public share response declares more than {MAX_SHARE_RESPONSE_BYTES} bytes"
                ),
            });
        }
        let mut response = response;
        let mut body_bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| NotebookError::Http(format!("failed reading share response body: {e}")))?
        {
            if body_bytes.len().saturating_add(chunk.len()) > MAX_SHARE_RESPONSE_BYTES {
                return Err(NotebookError::SecurityRejected {
                    code: "SHARE_RESPONSE_TOO_LARGE",
                    reason: format!(
                        "public share response exceeded {MAX_SHARE_RESPONSE_BYTES} bytes while streaming"
                    ),
                });
            }
            body_bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8_lossy(&body_bytes).into_owned();

        if detect_challenge_markers(&body) {
            return Err(self.circuit_breaker.trip(
                &self.handoff,
                &url_info.normalized_url,
                "response body contained AUTH_CHALLENGE_REQUIRED / CAPTCHA / Google sign-in gate",
            ));
        }

        self.import_public_share_pages(notebook_id, &url_info.normalized_url, &[body.as_str()])
    }

    fn persist_transcript(
        &self,
        notebook_id: &str,
        normalized_url: &str,
        transcript: &GeminiShareTranscript,
    ) -> Result<ShareImportOutcome, NotebookError> {
        let title = if transcript.title.trim().is_empty() {
            format!(
                "Gemini Public Share ({})",
                transcript.share_id.as_deref().unwrap_or("thread")
            )
        } else {
            transcript.title.clone()
        };
        let markdown = render_share_transcript_markdown(&title, normalized_url, transcript);
        let chunks = chunk_text_semantically(&markdown, MAX_CHUNK_BYTES);
        let share_slug = transcript
            .share_id
            .as_deref()
            .unwrap_or("share")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect::<String>();
        let filename = format!("gemini_share_{share_slug}.md");

        let reg = self.library.register_source(SourceRegistrationInput {
            notebook_id: notebook_id.to_string(),
            remote_id: transcript.share_id.clone(),
            title: title.clone(),
            filename,
            mime_type: Some("text/markdown".to_string()),
            source_kind_override: Some(SourceKind::TranscriptShare),
            raw_bytes: markdown.into_bytes(),
            chunks,
            ingestion_stage: "public_gemini_share_import".to_string(),
            provenance: "EXTRACTED".to_string(),
            metadata: json!({
                "schema_version": transcript.schema_version,
                "source_url": normalized_url,
                "share_id": transcript.share_id,
                "published_timestamp": transcript.published_timestamp,
                "turns_total": transcript.summary.turns_total,
                "cursor_exhausted": transcript.cursor_exhausted,
                "redaction_applied": transcript.redaction_applied,
            }),
        })?;

        // Also record imported public share turns into `notebook_turns` when newly inserted.
        let mut imported_turns = 0usize;
        if !reg.deduplicated {
            let existing_turn_count = self.store.list_turns(notebook_id)?.len();
            let now = now_epoch_ms();
            for (offset, turn) in transcript.turns.iter().enumerate() {
                let model_label = turn
                    .model_name
                    .clone()
                    .or_else(|| turn.model_id.clone())
                    .unwrap_or_else(|| "gemini-shared".to_string());
                let citations = vec![format!("[{}:0]", reg.source.source_id)];
                let record = NotebookTurnRecord {
                    turn_id: format!("trn_{}", Uuid::new_v4().simple()),
                    notebook_id: notebook_id.to_string(),
                    turn_index: existing_turn_count + offset,
                    surface: "gemini".to_string(),
                    role: "imported_share".to_string(),
                    prompt_text: SecretRedactor::redact(&turn.prompt_text),
                    response_markdown: SecretRedactor::redact(&turn.response_markdown),
                    model_id: model_label,
                    effort_level: "medium".to_string(),
                    quotes: Vec::new(),
                    citations,
                    created_at_ms: now + offset as i64,
                };
                self.store.insert_turn(&record)?;
                imported_turns += 1;
            }
        }

        Ok(ShareImportOutcome {
            notebook_id: notebook_id.to_string(),
            share_id: transcript.share_id.clone(),
            normalized_url: normalized_url.to_string(),
            source: reg.source,
            deduplicated: reg.deduplicated,
            imported_turns,
            cursor_exhausted: transcript.cursor_exhausted,
            redacted_fields: transcript.redacted_fields.clone(),
        })
    }
}

#[cfg(any(test, feature = "test-loopback"))]
fn validate_loopback_test_override(raw: &str) -> Result<String, NotebookError> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| {
        NotebookError::SecurityRejected {
            code: "INVALID_FETCH_OVERRIDE",
            reason: format!("invalid loopback fetch override URL: {e}"),
        }
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(NotebookError::SecurityRejected {
            code: "SSRF_OVERRIDE_REJECTED",
            reason: "fetch override URL must not embed credentials".to_string(),
        });
    }
    let host = parsed.host_str().unwrap_or("");
    let is_loopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1";
    if !is_loopback || !matches!(parsed.scheme(), "http" | "https") {
        return Err(NotebookError::SecurityRejected {
            code: "SSRF_OVERRIDE_REJECTED",
            reason: format!(
                "fetch_url_override strictly permits loopback test servers only; rejected host '{host}'"
            ),
        });
    }
    Ok(parsed.to_string())
}

fn detect_challenge_markers(body: &str) -> bool {
    let prefix_len = body.len().min(16_384);
    let mut end = prefix_len;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    let low = body[..end].to_ascii_lowercase();
    low.contains("auth_challenge_required")
        || low.contains("google.com/sorry")
        || low.contains("g-recaptcha")
        || low.contains("unusual traffic from your computer network")
        || low.contains("accounts.google.com/servicelogin")
        || low.contains("accounts.google.com/v3/signin")
        || low.contains("consent.google.com")
}

fn render_share_transcript_markdown(
    title: &str,
    normalized_url: &str,
    transcript: &GeminiShareTranscript,
) -> String {
    let mut md = format!("# {title}\n\n- **Source URL:** {normalized_url}\n");
    if let Some(sid) = &transcript.share_id {
        md.push_str(&format!("- **Share ID:** `{sid}`\n"));
    }
    if let Some(ts) = &transcript.published_timestamp {
        md.push_str(&format!("- **Published:** {ts}\n"));
    }
    md.push_str(&format!(
        "- **Turns:** {}\n",
        transcript.summary.turns_total
    ));

    for turn in &transcript.turns {
        md.push_str(&format!("\n## Turn {}\n", turn.turn_index + 1));
        if let Some(m) = turn.model_name.as_deref().or(turn.model_id.as_deref()) {
            md.push_str(&format!("_Model: {m}_\n\n"));
        }
        if !turn.prompt_text.trim().is_empty() {
            md.push_str(&format!("### Prompt\n\n{}\n", turn.prompt_text.trim()));
        }
        if !turn.search_queries.is_empty() {
            md.push_str("\n### Search Queries\n");
            for q in &turn.search_queries {
                md.push_str(&format!("- {q}\n"));
            }
        }
        if !turn.thinking_steps.is_empty() {
            md.push_str("\n### Thinking Steps\n");
            for step in &turn.thinking_steps {
                md.push_str(&format!("- **{}**: {}\n", step.header, step.body));
            }
        }
        if !turn.response_markdown.trim().is_empty() {
            md.push_str(&format!(
                "\n### Response\n\n{}\n",
                turn.response_markdown.trim()
            ));
        }
        if !turn.grounding_citations.is_empty() {
            md.push_str("\n### Grounding Citations\n");
            for gc in &turn.grounding_citations {
                for item in &gc.items {
                    if let Some(url) = &item.url {
                        md.push_str(&format!("- [{}]({url})\n", item.title));
                    } else if !item.title.is_empty() {
                        md.push_str(&format!("- {}\n", item.title));
                    }
                }
            }
        }
    }
    SecretRedactor::redact(&md)
}
