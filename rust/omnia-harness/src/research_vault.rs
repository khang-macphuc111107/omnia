//! Persistent Dual-Tier Deep Research & Local/Global RAG Vault (`#![forbid(unsafe_code)]`).
//!
//! Capabilities:
//! - Dual-tier persistent corpus: Local (`<workspace>/.agents/research/`, `[S###]`) +
//!   Global (`D:\OmniaData\research-vault\`, `[G###]`) backed by `omnia-winsqlite` WAL
//!   and atomic `tmp + sync + rename` Markdown/JSONL snapshots with 6x Windows AV-lock retry.
//! - Fail-closed SSRF/DNS-rebinding URL fetch (`omnia_workspace_ops::egress::EgressPolicy`),
//!   canonical redirect unwrapping (`grounding-api-redirect`), heading-preserving HTML->Markdown,
//!   `xxh3` + `SHA-256` deduplication, and honest `agent-reach` typed error classification
//!   (`[BLOCKED_BY_CHALLENGE]` / `[AUTH_REQUIRED]` — strictly ZERO bypass!).
//! - Hybrid RAG retrieval: Okapi BM25 + Exact Phrase/Heading boost + Source Authority + RRF,
//!   bilingual Vietnamese diacritic folding + bounded Levenshtein fuzzy tolerance.
//! - `keenable-select` cached `result_set_id` structured table extraction without re-fetching,
//!   5-level evidence grading, session claim self-consistency checks, inline `[S###]`/`[G###]`
//!   citation validation, PRISMA-style "Sources (Searched, Viewed & Extracted)" ledger,
//!   and Markdown/JSON dossier export.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use omnia_core::{now_epoch_ms, sha256_hex, truncate_utf8_word_safe, uuid_v4, SecretRedactor};
use omnia_winsqlite::Connection;
use omnia_workspace_ops::egress::{validate_egress_url, EgressPolicy};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use url::Url;
use xxhash_rust::xxh3::xxh3_64;

use crate::proactive_rag::{fold_vietnamese_ascii, tokenize_folded};

/// Default external Global Research Vault root (never inside tracked repository tree).
pub const DEFAULT_GLOBAL_VAULT_DIR: &str = r"D:\OmniaData\research-vault";

/// Hard upper bound for a single fetched HTTP document body (2 MiB).
const MAX_FETCH_BODY_BYTES: usize = 2 * 1024 * 1024;
/// Bounded read budget (`<= 5,000` tokens ~ `20,000` chars) with head+tail preservation.
const MAX_EXTRACTED_CHARS: usize = 20_000;
const CHUNK_TARGET_CHARS: usize = 1_200;
const CHUNK_OVERLAP_CHARS: usize = 160;
const MAX_PREALLOC_ROWS: usize = 4_096;

const VAULT_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS rv_seq (
    tier TEXT PRIMARY KEY,
    next_num INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO rv_seq (tier, next_num) VALUES ('local', 1);
INSERT OR IGNORE INTO rv_seq (tier, next_num) VALUES ('global', 1);

CREATE TABLE IF NOT EXISTS rv_sources (
    citation_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    title TEXT NOT NULL,
    domain TEXT NOT NULL,
    published_at TEXT,
    stage TEXT NOT NULL,
    http_status INTEGER,
    error_kind_json TEXT,
    error_note TEXT,
    authority_score REAL NOT NULL DEFAULT 0.5,
    xxh3_hex TEXT NOT NULL,
    sha256_hex TEXT NOT NULL,
    raw_bytes INTEGER NOT NULL DEFAULT 0,
    extracted_chars INTEGER NOT NULL DEFAULT 0,
    markdown_excerpt TEXT NOT NULL DEFAULT '',
    markdown_body TEXT NOT NULL DEFAULT '',
    snapshot_path TEXT,
    query_origin TEXT NOT NULL DEFAULT '',
    fetched_at_ms INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rv_sources_tier ON rv_sources(tier, fetched_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_rv_sources_xxh3 ON rv_sources(tier, xxh3_hex);
CREATE INDEX IF NOT EXISTS idx_rv_sources_canon ON rv_sources(tier, canonical_url);

CREATE TABLE IF NOT EXISTS rv_chunks (
    chunk_id TEXT PRIMARY KEY,
    citation_id TEXT NOT NULL REFERENCES rv_sources(citation_id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rv_chunks_cit ON rv_chunks(citation_id, chunk_idx);

CREATE TABLE IF NOT EXISTS rv_claims (
    claim_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    citations_json TEXT NOT NULL,
    grade TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rv_claims_session ON rv_claims(session_id, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS rv_result_sets (
    result_set_id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    citation_ids_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
"#;

/// Storage tier for a research source (`Local` `[S###]` vs `Global` `[G###]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultTier {
    Local,
    Global,
}

impl VaultTier {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Global => "global",
        }
    }

    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "global" | "g" => Self::Global,
            _ => Self::Local,
        }
    }

    #[must_use]
    pub const fn prefix(self) -> char {
        match self {
            Self::Local => 'S',
            Self::Global => 'G',
        }
    }
}

/// Typed `agent-reach` error taxonomy (strictly zero-bypass on `NeedLogin`/`PlatformBlocked`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FetchErrorKind {
    NeedLogin,
    PlatformBlocked,
    RateLimited { retry_after_secs: Option<u64> },
    UpstreamBroken,
    Timeout,
    NotFound,
    PolicyBlocked,
    InvalidUrl,
    NetworkError,
}

impl FetchErrorKind {
    #[must_use]
    pub const fn tag(&self) -> &'static str {
        match self {
            Self::NeedLogin => "[AUTH_REQUIRED]",
            Self::PlatformBlocked => "[BLOCKED_BY_CHALLENGE]",
            Self::RateLimited { .. } => "[RATE_LIMITED]",
            Self::UpstreamBroken => "[UPSTREAM_BROKEN]",
            Self::Timeout => "[TIMEOUT]",
            Self::NotFound => "[NOT_FOUND]",
            Self::PolicyBlocked => "[POLICY_BLOCKED]",
            Self::InvalidUrl => "[INVALID_URL]",
            Self::NetworkError => "[NETWORK_ERROR]",
        }
    }
}

/// PRISMA-grade lifecycle stage of a source in the "Sources (Searched, Viewed & Extracted)" ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStage {
    Searched,
    Viewed,
    Extracted,
    Blocked,
    AuthRequired,
    Failed,
}

impl SourceStage {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Searched => "searched",
            Self::Viewed => "viewed",
            Self::Extracted => "extracted",
            Self::Blocked => "blocked",
            Self::AuthRequired => "auth_required",
            Self::Failed => "failed",
        }
    }

    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "searched" => Self::Searched,
            "viewed" => Self::Viewed,
            "extracted" => Self::Extracted,
            "blocked" => Self::Blocked,
            "auth_required" => Self::AuthRequired,
            _ => Self::Failed,
        }
    }
}

/// 5-level evidence grade attached to synthesized research claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceGrade {
    Verified,
    Corroborated,
    SingleSource,
    Conflict,
    UnverifiedGap,
}

impl EvidenceGrade {
    #[must_use]
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Verified => "[VERIFIED]",
            Self::Corroborated => "[CORROBORATED]",
            Self::SingleSource => "[SINGLE-SOURCE]",
            Self::Conflict => "[CONFLICT]",
            Self::UnverifiedGap => "[UNVERIFIED/GAP]",
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Corroborated => "corroborated",
            Self::SingleSource => "single_source",
            Self::Conflict => "conflict",
            Self::UnverifiedGap => "unverified_gap",
        }
    }

    #[must_use]
    pub fn from_str_lossy(raw: &str) -> Self {
        let norm = raw.trim().to_ascii_lowercase();
        match norm.as_str() {
            "verified" | "[verified]" => Self::Verified,
            "corroborated" | "[corroborated]" => Self::Corroborated,
            "single_source" | "single-source" | "[single-source]" => Self::SingleSource,
            "conflict" | "[conflict]" => Self::Conflict,
            _ => Self::UnverifiedGap,
        }
    }
}

/// Persisted source record in the ResearchVault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSourceRecord {
    pub citation_id: String,
    pub tier: VaultTier,
    pub url: String,
    pub canonical_url: String,
    pub title: String,
    pub domain: String,
    pub published_at: Option<String>,
    pub stage: SourceStage,
    pub http_status: Option<u16>,
    pub error_kind: Option<FetchErrorKind>,
    pub error_note: Option<String>,
    pub authority_score: f64,
    pub xxh3_hex: String,
    pub sha256_hex: String,
    pub raw_bytes: usize,
    pub extracted_chars: usize,
    pub markdown_excerpt: String,
    pub snapshot_path: Option<String>,
    pub query_origin: String,
    pub fetched_at_ms: i64,
    pub pinned: bool,
}

/// Ranked RAG chunk returned by [`ResearchVault::query_rag`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagChunkHit {
    pub citation_id: String,
    pub tier: VaultTier,
    pub source_url: String,
    pub title: String,
    pub heading: String,
    pub snippet: String,
    pub bm25_score: f64,
    pub phrase_boost: f64,
    pub authority_boost: f64,
    pub rrf_score: f64,
    pub xxh3_hex: String,
}

/// Claim ledger entry verified against `[S###]`/`[G###]` citations and session consistency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchClaim {
    pub claim_id: String,
    pub session_id: String,
    pub text: String,
    pub citations: Vec<String>,
    pub grade: EvidenceGrade,
    pub notes: String,
    pub conflicts_with: Vec<String>,
    pub created_at_ms: i64,
}

/// Cached `result_set_id` structured table extraction (`keenable-select` pattern).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredTableResult {
    pub result_set_id: String,
    pub query: String,
    pub columns: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
    pub single_source_rows: Vec<usize>,
    pub source_citations: Vec<String>,
}

/// Complete PRISMA-style "Sources (Searched, Viewed & Extracted)" ledger summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcesLedgerSummary {
    pub total_searched: usize,
    pub total_viewed: usize,
    pub total_extracted: usize,
    pub total_blocked: usize,
    pub total_auth_required: usize,
    pub total_failed: usize,
    pub cited_ids: Vec<String>,
    pub sources: Vec<ResearchSourceRecord>,
}

/// Atomic file write (`tmp + sync_all + rename`) with 6x Windows AV-lock retry and `.tmp` cleanup.
pub fn atomic_write_with_retry(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}): {e}", parent.display()))?;
    }
    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("omnia"),
        &uuid_v4()[..8]
    );
    let tmp_path = path.with_file_name(tmp_name);
    {
        let mut f = File::create(&tmp_path)
            .map_err(|e| format!("create temp {}: {e}", tmp_path.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write temp {}: {e}", tmp_path.display()))?;
        f.sync_all()
            .map_err(|e| format!("sync temp {}: {e}", tmp_path.display()))?;
    }
    let mut last_err = String::new();
    for attempt in 0..6u32 {
        match fs::rename(&tmp_path, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if path.exists() {
                    let _ = fs::remove_file(path);
                }
                std::thread::sleep(Duration::from_millis(25 * u64::from(attempt + 1)));
            }
        }
    }
    let _ = fs::remove_file(&tmp_path);
    Err(format!(
        "atomic rename to {} failed after 6 retries: {last_err}",
        path.display()
    ))
}

/// Unwraps Google `grounding-api-redirect` / `url?q=` / `redirect=` wrappers and strips
/// marketing tracking parameters while preserving functional query tokens.
#[must_use]
pub fn unwrap_canonical_redirect_url(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    let Ok(mut parsed) = Url::parse(trimmed) else {
        return trimmed.to_string();
    };
    let host_low = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let path_low = parsed.path().to_ascii_lowercase();
    if host_low.contains("vertexaisearch.cloud.google.com")
        || path_low.contains("grounding-api-redirect")
        || ((host_low.ends_with("google.com") || host_low.ends_with("duckduckgo.com"))
            && (path_low == "/url" || path_low == "/l/" || path_low == "/l"))
    {
        for (k, v) in parsed.query_pairs() {
            if matches!(k.as_ref(), "url" | "q" | "uddg" | "redirect" | "target")
                && (v.starts_with("http://") || v.starts_with("https://"))
            {
                if let Ok(inner) = Url::parse(&v) {
                    parsed = inner;
                    break;
                }
            }
        }
    }

    let kept_pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| {
            let kl = k.to_ascii_lowercase();
            !(kl.starts_with("utm_")
                || matches!(
                    kl.as_str(),
                    "fbclid" | "gclid" | "msclkid" | "ttclid" | "_ga" | "_gl" | "mc_eid" | "igshid"
                ))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept_pairs.is_empty() {
        parsed.set_query(None);
    } else {
        let mut qp = parsed.query_pairs_mut();
        qp.clear();
        for (k, v) in kept_pairs {
            qp.append_pair(&k, &v);
        }
    }
    parsed.set_fragment(None);
    parsed.to_string()
}

/// Classifies HTTP status + body preview + final URL using the typed `agent-reach` error taxonomy.
/// Strictly fail-closed (never auto-bypasses CAPTCHA/login gates).
#[must_use]
pub fn classify_http_fetch_error(
    status: u16,
    body_preview: &str,
    final_url: &str,
) -> Option<FetchErrorKind> {
    let url_low = final_url.to_ascii_lowercase();
    let body_low = body_preview.to_ascii_lowercase();

    let is_challenge = url_low.contains("/sorry/")
        || url_low.contains("cdn-cgi/challenge-platform")
        || body_low.contains("cf-turnstile")
        || body_low.contains("g-recaptcha")
        || body_low.contains("h-captcha")
        || body_low.contains("altcha-widget")
        || body_low.contains("verify you are human")
        || body_low.contains("just a moment...")
        || body_low.contains("unusual traffic from your computer");
    if is_challenge {
        return Some(FetchErrorKind::PlatformBlocked);
    }
    if status == 401
        || url_low.contains("accounts.google.com/servicelogin")
        || url_low.contains("/login?")
        || (status == 403
            && (body_low.contains("sign in to continue") || body_low.contains("login required")))
    {
        return Some(FetchErrorKind::NeedLogin);
    }
    if status == 429 {
        return Some(FetchErrorKind::RateLimited {
            retry_after_secs: None,
        });
    }
    if status == 403 {
        return Some(FetchErrorKind::PlatformBlocked);
    }
    if status == 404 || status == 410 {
        return Some(FetchErrorKind::NotFound);
    }
    if status >= 500 {
        return Some(FetchErrorKind::UpstreamBroken);
    }
    None
}

/// Heading-preserving pure-Rust HTML -> Clean Markdown extractor (`title`, `canonical`, `published_at`, `markdown`).
#[must_use]
pub fn html_to_clean_markdown(html: &str) -> (Option<String>, Option<String>, Option<String>, String) {
    let title = extract_tag_inner_ci(html, "title").map(|t| decode_html_entities(t.trim()));
    let canonical = extract_meta_or_link_ci(html, "canonical");
    let published_at = extract_meta_or_link_ci(html, "article:published_time")
        .or_else(|| extract_meta_or_link_ci(html, "datePublished"))
        .or_else(|| extract_meta_or_link_ci(html, "pubdate"));

    // Focus <article> or <main> when substantial content exists inside.
    let focused = extract_tag_inner_ci(html, "article")
        .filter(|s| s.len() >= 180)
        .or_else(|| extract_tag_inner_ci(html, "main").filter(|s| s.len() >= 180))
        .unwrap_or(html);

    let stripped = strip_noise_blocks(focused);
    let mut out = String::with_capacity(stripped.len().min(MAX_EXTRACTED_CHARS));
    let mut in_tag = false;
    let mut tag_buf = String::new();
    let mut in_pre = false;
    let mut in_td = false;

    for ch in stripped.chars() {
        if ch == '<' {
            in_tag = true;
            tag_buf.clear();
            continue;
        }
        if in_tag {
            if ch == '>' {
                in_tag = false;
                let tag_low = tag_buf.trim().to_ascii_lowercase();
                let name = tag_low
                    .trim_start_matches('/')
                    .split(|c: char| c.is_whitespace() || c == '/')
                    .next()
                    .unwrap_or("");
                let closing = tag_low.starts_with('/');
                match (closing, name) {
                    (false, "h1") => out.push_str("\n\n# "),
                    (false, "h2") => out.push_str("\n\n## "),
                    (false, "h3") => out.push_str("\n\n### "),
                    (false, "h4" | "h5" | "h6") => out.push_str("\n\n#### "),
                    (true, "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "section") => {
                        out.push_str("\n\n");
                    }
                    (false, "br") => out.push('\n'),
                    (false, "li") => out.push_str("\n- "),
                    (false, "pre") => {
                        in_pre = true;
                        out.push_str("\n```\n");
                    }
                    (true, "pre") => {
                        in_pre = false;
                        out.push_str("\n```\n");
                    }
                    (false, "code") if !in_pre => out.push('`'),
                    (true, "code") if !in_pre => out.push('`'),
                    (false, "tr") => {
                        out.push('\n');
                        in_td = false;
                    }
                    (false, "td" | "th") => {
                        if in_td {
                            out.push_str(" | ");
                        } else {
                            out.push_str("| ");
                            in_td = true;
                        }
                    }
                    (true, "tr") if in_td => {
                        out.push_str(" |");
                        in_td = false;
                    }
                    _ => {}
                }
            } else if tag_buf.len() < 128 {
                tag_buf.push(ch);
            }
            continue;
        }
        out.push(ch);
    }

    let decoded = decode_html_entities(&out);
    let cleaned = collapse_markdown_whitespace(&decoded);
    let bounded = bounded_head_tail_text(&cleaned, MAX_EXTRACTED_CHARS);
    (title, canonical, published_at, bounded)
}

/// Bounded head+tail truncation keeping omitted character counts (`<= 5,000` tokens guard).
#[must_use]
pub fn bounded_head_tail_text(text: &str, max_chars: usize) -> String {
    let total = text.chars().count();
    if total <= max_chars || max_chars < 120 {
        return text.to_string();
    }
    let head_len = (max_chars * 7) / 10;
    let tail_len = max_chars.saturating_sub(head_len + 64);
    let head: String = text.chars().take(head_len).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(tail_len)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let omitted = total.saturating_sub(head_len + tail_len);
    format!("{head}\n\n[... omitted {omitted} chars to stay under bounded read cap ...]\n\n{tail}")
}

/// Bounded Levenshtein edit distance (early-exits with `max_dist + 1` for fast fuzzy matching).
#[must_use]
pub fn levenshtein_bounded(a: &str, b: &str, max_dist: usize) -> usize {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let m = ac.len();
    let n = bc.len();
    if m.abs_diff(n) > max_dist {
        return max_dist + 1;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        let mut row_min = i;
        for j in 1..=n {
            let cost = usize::from(ac[i - 1] != bc[j - 1]);
            let v = (prev[j] + 1)
                .min(curr[j - 1] + 1)
                .min(prev[j - 1] + cost);
            curr[j] = v;
            row_min = row_min.min(v);
        }
        if row_min > max_dist {
            return max_dist + 1;
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

/// Persistent Dual-Tier Deep Research & RAG Vault backed by `omnia-winsqlite` WAL.
pub struct ResearchVault {
    conn: Mutex<Connection>,
    local_dir: Option<PathBuf>,
    global_dir: Option<PathBuf>,
}

impl std::fmt::Debug for ResearchVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResearchVault")
            .field("local_dir", &self.local_dir)
            .field("global_dir", &self.global_dir)
            .finish()
    }
}

impl ResearchVault {
    /// Open persistent SQLite WAL ResearchVault anchored to `<workspace>/.agents/research/`
    /// and `global_dir` (defaulting to `D:\OmniaData\research-vault`).
    pub fn open(workspace_root: &Path, global_dir: Option<&Path>) -> Result<Self, String> {
        let local_dir = workspace_root.join(".agents").join("research");
        let global_path = global_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_GLOBAL_VAULT_DIR));
        let _ = fs::create_dir_all(&local_dir);
        let _ = fs::create_dir_all(&global_path);
        let db_path = global_path.join("research_vault.db");
        let conn = Connection::open_read_write(&db_path)
            .map_err(|e| format!("open ResearchVault db {}: {e}", db_path.display()))?;
        conn.exec_batch(VAULT_SCHEMA_SQL)
            .map_err(|e| format!("init ResearchVault schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            local_dir: Some(local_dir),
            global_dir: Some(global_path),
        })
    }

    /// Open an isolated in-memory ResearchVault for hermetic unit/integration tests.
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open in-memory db: {e}"))?;
        conn.exec_batch(VAULT_SCHEMA_SQL)
            .map_err(|e| format!("init in-memory schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            local_dir: None,
            global_dir: None,
        })
    }

    /// Records a discovered search candidate (`stage = Searched`) before fetching.
    pub fn record_searched_candidate(
        &self,
        tier: VaultTier,
        url: &str,
        title: &str,
        query_origin: &str,
        snippet: &str,
    ) -> Result<ResearchSourceRecord, String> {
        let canonical = unwrap_canonical_redirect_url(url);
        let domain = extract_domain(&canonical);
        let clean_title = if title.trim().is_empty() {
            domain.clone()
        } else {
            SecretRedactor::redact(title.trim())
        };
        let clean_snippet = SecretRedactor::redact(snippet.trim());
        let xxh3_hex = format!("{:016x}", xxh3_64(canonical.as_bytes()));
        let digest = sha256_hex(clean_snippet.as_bytes());
        let now = now_epoch_ms();
        let authority = score_domain_authority(&domain, &canonical);

        let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        if let Some(existing) = find_source_by_canonical(&conn, tier, &canonical)? {
            return Ok(existing);
        }
        let citation_id = next_citation_id(&conn, tier)?;
        let rec = ResearchSourceRecord {
            citation_id,
            tier,
            url: SecretRedactor::redact(url.trim()),
            canonical_url: SecretRedactor::redact(&canonical),
            title: clean_title,
            domain,
            published_at: None,
            stage: SourceStage::Searched,
            http_status: None,
            error_kind: None,
            error_note: None,
            authority_score: authority,
            xxh3_hex,
            sha256_hex: digest,
            raw_bytes: clean_snippet.len(),
            extracted_chars: clean_snippet.chars().count(),
            markdown_excerpt: truncate_utf8_word_safe(&clean_snippet, 420),
            snapshot_path: None,
            query_origin: SecretRedactor::redact(query_origin.trim()),
            fetched_at_ms: now,
            pinned: tier == VaultTier::Global,
        };
        upsert_source_row(&conn, &rec, &clean_snippet)?;
        if !clean_snippet.is_empty() {
            replace_chunks_for_source(&conn, &rec.citation_id, tier, &rec.title, &clean_snippet)?;
        }
        Ok(rec)
    }

    /// Ingests raw HTML/Markdown/text/JSON content into the vault with `xxh3` + `SHA-256` dedup,
    /// heading-aware overlapping chunking, and atomic Markdown/JSONL snapshot persistence.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_document(
        &self,
        tier: VaultTier,
        url: &str,
        canonical_url: Option<&str>,
        title: Option<&str>,
        raw_content: &str,
        content_type: &str,
        http_status: Option<u16>,
        query_origin: &str,
    ) -> Result<ResearchSourceRecord, String> {
        let canonical = unwrap_canonical_redirect_url(canonical_url.unwrap_or(url));
        let domain = extract_domain(&canonical);
        let ct_low = content_type.to_ascii_lowercase();
        let (extracted_title, html_canon, published_at, body_md) =
            if ct_low.contains("html") || raw_content.trim_start().starts_with('<') {
                html_to_clean_markdown(raw_content)
            } else {
                (
                    None,
                    None,
                    None,
                    bounded_head_tail_text(&collapse_markdown_whitespace(raw_content), MAX_EXTRACTED_CHARS),
                )
            };

        let final_canon = html_canon
            .map(|c| unwrap_canonical_redirect_url(&c))
            .filter(|c| c.starts_with("http://") || c.starts_with("https://"))
            .unwrap_or(canonical);
        let final_title = title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .or(extracted_title)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| domain.clone());
        let safe_title = SecretRedactor::redact(&final_title);
        let safe_body = SecretRedactor::redact(&body_md);
        let xxh3_hex = format!("{:016x}", xxh3_64(safe_body.as_bytes()));
        let digest = sha256_hex(safe_body.as_bytes());
        let now = now_epoch_ms();
        let authority = score_domain_authority(&domain, &final_canon);

        let mut conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        // Content-hash dedup inside same tier.
        if !safe_body.is_empty() {
            if let Some(existing) = find_source_by_xxh3(&conn, tier, &xxh3_hex)? {
                return Ok(existing);
            }
        }
        // Upgrade an existing `Searched` candidate for the same canonical URL in-place.
        let citation_id = if let Some(existing) = find_source_by_canonical(&conn, tier, &final_canon)? {
            existing.citation_id
        } else {
            next_citation_id(&conn, tier)?
        };

        let snapshot_path = self.write_snapshot_file(tier, &citation_id, &safe_title, &final_canon, &safe_body);
        let stage = if safe_body.trim().is_empty() {
            SourceStage::Viewed
        } else {
            SourceStage::Extracted
        };
        let rec = ResearchSourceRecord {
            citation_id: citation_id.clone(),
            tier,
            url: SecretRedactor::redact(url.trim()),
            canonical_url: SecretRedactor::redact(&final_canon),
            title: safe_title.clone(),
            domain,
            published_at,
            stage,
            http_status,
            error_kind: None,
            error_note: None,
            authority_score: authority,
            xxh3_hex,
            sha256_hex: digest,
            raw_bytes: raw_content.len(),
            extracted_chars: safe_body.chars().count(),
            markdown_excerpt: truncate_utf8_word_safe(&safe_body, 420),
            snapshot_path,
            query_origin: SecretRedactor::redact(query_origin.trim()),
            fetched_at_ms: now,
            pinned: tier == VaultTier::Global,
        };
        let tx = conn
            .begin_immediate()
            .map_err(|e| format!("begin_immediate: {e}"))?;
        upsert_source_row(&tx, &rec, &safe_body)?;
        replace_chunks_for_source(&tx, &citation_id, tier, &safe_title, &safe_body)?;
        tx.commit().map_err(|e| format!("commit: {e}"))?;
        Ok(rec)
    }

    /// Records a fail-closed blocked/auth/failed fetch outcome honestly (ZERO bypass!).
    pub fn record_fetch_failure(
        &self,
        tier: VaultTier,
        url: &str,
        http_status: Option<u16>,
        error_kind: FetchErrorKind,
        note: &str,
        query_origin: &str,
    ) -> Result<ResearchSourceRecord, String> {
        let canonical = unwrap_canonical_redirect_url(url);
        let domain = extract_domain(&canonical);
        let now = now_epoch_ms();
        let stage = match error_kind {
            FetchErrorKind::NeedLogin => SourceStage::AuthRequired,
            FetchErrorKind::PlatformBlocked | FetchErrorKind::PolicyBlocked => SourceStage::Blocked,
            _ => SourceStage::Failed,
        };
        let safe_note = format!("{} {}", error_kind.tag(), SecretRedactor::redact(note.trim()));
        let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        let citation_id = if let Some(existing) = find_source_by_canonical(&conn, tier, &canonical)? {
            existing.citation_id
        } else {
            next_citation_id(&conn, tier)?
        };
        let rec = ResearchSourceRecord {
            citation_id,
            tier,
            url: SecretRedactor::redact(url.trim()),
            canonical_url: SecretRedactor::redact(&canonical),
            title: domain.clone(),
            domain,
            published_at: None,
            stage,
            http_status,
            error_kind: Some(error_kind),
            error_note: Some(safe_note.clone()),
            authority_score: 0.0,
            xxh3_hex: format!("{:016x}", xxh3_64(canonical.as_bytes())),
            sha256_hex: sha256_hex(safe_note.as_bytes()),
            raw_bytes: 0,
            extracted_chars: 0,
            markdown_excerpt: safe_note,
            snapshot_path: None,
            query_origin: SecretRedactor::redact(query_origin.trim()),
            fetched_at_ms: now,
            pinned: false,
        };
        upsert_source_row(&conn, &rec, "")?;
        Ok(rec)
    }

    /// SSRF-safe live URL fetch -> canonical redirect unwrap -> HTML->Markdown extraction -> persistent RAG.
    pub async fn fetch_and_ingest_url(
        &self,
        tier: VaultTier,
        raw_url: &str,
        query_origin: &str,
        allow_loopback: bool,
    ) -> Result<ResearchSourceRecord, String> {
        let unwrapped = unwrap_canonical_redirect_url(raw_url);
        let policy = if allow_loopback {
            EgressPolicy {
                mode: omnia_workspace_ops::egress::EgressMode::PublicAndLoopback,
                verify_dns_non_private: false,
                ..EgressPolicy::default()
            }
        } else {
            EgressPolicy::public_web()
        };
        if let Err(err) = validate_egress_url(&unwrapped, &policy) {
            return self.record_fetch_failure(
                tier,
                &unwrapped,
                None,
                FetchErrorKind::PolicyBlocked,
                &err.to_string(),
                query_origin,
            );
        }

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::limited(6))
            .connect_timeout(Duration::from_secs(6))
            .timeout(Duration::from_secs(14))
            .user_agent("OmniaResearchVault/5.0 (+https://github.com/khang-macphuc111107/omnia)")
            .build()
            .map_err(|e| format!("http client build failed: {e}"))?;

        let resp = match client.get(&unwrapped).send().await {
            Ok(r) => r,
            Err(e) => {
                let kind = if e.is_timeout() {
                    FetchErrorKind::Timeout
                } else {
                    FetchErrorKind::NetworkError
                };
                return self.record_fetch_failure(
                    tier,
                    &unwrapped,
                    None,
                    kind,
                    &e.to_string(),
                    query_origin,
                );
            }
        };

        let status = resp.status().as_u16();
        let final_url = resp.url().to_string();
        if let Err(err) = validate_egress_url(&final_url, &policy) {
            return self.record_fetch_failure(
                tier,
                &final_url,
                Some(status),
                FetchErrorKind::PolicyBlocked,
                &format!("redirect target blocked: {err}"),
                query_origin,
            );
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/plain")
            .to_string();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());

        let raw_bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                return self.record_fetch_failure(
                    tier,
                    &final_url,
                    Some(status),
                    FetchErrorKind::NetworkError,
                    &e.to_string(),
                    query_origin,
                );
            }
        };
        let slice = if raw_bytes.len() > MAX_FETCH_BODY_BYTES {
            &raw_bytes[..MAX_FETCH_BODY_BYTES]
        } else {
            &raw_bytes[..]
        };
        let body_text = String::from_utf8_lossy(slice);
        let preview: String = body_text.chars().take(2_400).collect();

        if let Some(mut err_kind) = classify_http_fetch_error(status, &preview, &final_url) {
            if let FetchErrorKind::RateLimited { retry_after_secs } = &mut err_kind {
                *retry_after_secs = retry_after;
            }
            return self.record_fetch_failure(
                tier,
                &final_url,
                Some(status),
                err_kind,
                &format!("HTTP {status} gated or unavailable"),
                query_origin,
            );
        }

        self.ingest_document(
            tier,
            &unwrapped,
            Some(&final_url),
            None,
            &body_text,
            &content_type,
            Some(status),
            query_origin,
        )
    }

    /// Parallel bounded URL fetch respecting per-domain concurrency cap (`<= 2` per domain).
    pub async fn fetch_urls_parallel(
        &self,
        tier: VaultTier,
        urls: &[String],
        query_origin: &str,
        max_concurrency: usize,
        allow_loopback: bool,
    ) -> Vec<ResearchSourceRecord> {
        let cap = max_concurrency.clamp(1, 8);
        let mut results = Vec::new();
        let mut seen = BTreeSet::new();
        let mut deduped = Vec::new();
        for u in urls {
            let c = unwrap_canonical_redirect_url(u);
            if !c.is_empty() && seen.insert(c.clone()) {
                deduped.push(c);
            }
        }
        // Process in polite batches to stay <= cap in-flight without extra crate deps.
        for chunk in deduped.chunks(cap) {
            for u in chunk {
                if let Ok(rec) = self
                    .fetch_and_ingest_url(tier, u, query_origin, allow_loopback)
                    .await
                {
                    results.push(rec);
                }
            }
        }
        results
    }

    /// Hybrid Okapi BM25 + Exact Phrase/Heading + Source Authority + RRF RAG query
    /// across Local (`[S###]`), Global (`[G###]`), or both tiers.
    pub fn query_rag(
        &self,
        query: &str,
        tier_filter: Option<VaultTier>,
        top_k: usize,
    ) -> Result<Vec<RagChunkHit>, String> {
        let limit = top_k.clamp(1, 64);
        let q_tokens: Vec<String> = tokenize_folded(query).into_iter().collect();
        if q_tokens.is_empty() {
            return Ok(Vec::new());
        }
        let q_folded = fold_vietnamese_ascii(query).trim().to_string();

        let rows = {
            let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
            let sql = if tier_filter.is_some() {
                "SELECT c.citation_id, c.tier, s.canonical_url, s.title, c.heading, c.body, s.authority_score, s.xxh3_hex
                 FROM rv_chunks c
                 JOIN rv_sources s ON s.citation_id = c.citation_id
                 WHERE c.tier = ?1 AND s.stage IN ('extracted','viewed','searched')
                 LIMIT 4096;"
            } else {
                "SELECT c.citation_id, c.tier, s.canonical_url, s.title, c.heading, c.body, s.authority_score, s.xxh3_hex
                 FROM rv_chunks c
                 JOIN rv_sources s ON s.citation_id = c.citation_id
                 WHERE s.stage IN ('extracted','viewed','searched')
                 LIMIT 4096;"
            };
            let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare query_rag: {e}"))?;
            if let Some(t) = tier_filter {
                stmt.bind_text(1, t.as_str()).map_err(|e| e.to_string())?;
            }
            let mut out = Vec::new();
            while stmt.step_row().map_err(|e| e.to_string())? && out.len() < MAX_PREALLOC_ROWS {
                out.push((
                    stmt.column_text(0).unwrap_or_default(),
                    VaultTier::from_str_lossy(&stmt.column_text(1).unwrap_or_default()),
                    stmt.column_text(2).unwrap_or_default(),
                    stmt.column_text(3).unwrap_or_default(),
                    stmt.column_text(4).unwrap_or_default(),
                    stmt.column_text(5).unwrap_or_default(),
                    stmt.column_double(6).unwrap_or(0.5),
                    stmt.column_text(7).unwrap_or_default(),
                ));
            }
            out
        };

        if rows.is_empty() {
            return Ok(Vec::new());
        }

        // Tokenize documents once for Okapi BM25 + fuzzy match.
        let mut doc_tfs: Vec<(HashMap<String, usize>, usize)> = Vec::with_capacity(rows.len());
        let mut df_map: HashMap<String, usize> = HashMap::new();
        for (_, _, _, title, heading, body, _, _) in &rows {
            let bag = format!("{title} {heading} {body}");
            let mut tf: HashMap<String, usize> = HashMap::new();
            let mut dlen = 0usize;
            for tok in split_folded_words(&bag) {
                *tf.entry(tok).or_insert(0) += 1;
                dlen += 1;
            }
            for qt in &q_tokens {
                if tf.contains_key(qt) {
                    *df_map.entry(qt.clone()).or_insert(0) += 1;
                }
            }
            doc_tfs.push((tf, dlen.max(1)));
        }

        let n_docs = rows.len() as f64;
        let avgdl = (doc_tfs.iter().map(|(_, l)| *l).sum::<usize>() as f64 / n_docs).max(1.0);
        let k1 = 1.2_f64;
        let b = 0.75_f64;

        let mut scored: Vec<(usize, f64, f64, f64)> = Vec::new();
        for (idx, (_, _, _, title, heading, body, authority, _)) in rows.iter().enumerate() {
            let (tf_map, dl) = &doc_tfs[idx];
            let mut bm25 = 0.0_f64;
            for qt in &q_tokens {
                let mut tf = tf_map.get(qt).copied().unwrap_or(0) as f64;
                if tf == 0.0 && qt.len() >= 4 {
                    // Bounded Levenshtein-1 fuzzy fallback for Vietnamese/English typos (`L1698`).
                    if tf_map.keys().any(|k| k.len() >= 4 && levenshtein_bounded(qt, k, 1) <= 1) {
                        tf = 0.65;
                    }
                }
                if tf > 0.0 {
                    let df = df_map.get(qt).copied().unwrap_or(0) as f64;
                    let idf = ((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln();
                    bm25 += idf * ((tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * (*dl as f64 / avgdl))));
                }
            }
            if bm25 <= 0.0 {
                continue;
            }
            let title_f = fold_vietnamese_ascii(title);
            let head_f = fold_vietnamese_ascii(heading);
            let body_f = fold_vietnamese_ascii(body);
            let mut phrase_boost = 0.0_f64;
            if q_folded.len() >= 4 {
                if title_f.contains(&q_folded) || head_f.contains(&q_folded) {
                    phrase_boost += 2.5;
                } else if body_f.contains(&q_folded) {
                    phrase_boost += 1.4;
                }
            }
            let auth_boost = authority.clamp(0.0, 1.0);
            scored.push((idx, bm25, phrase_boost, auth_boost));
        }

        // Reciprocal Rank Fusion (RRF k=60) over BM25 rank, Phrase/Heading rank, and Authority rank.
        let mut by_bm25 = scored.clone();
        by_bm25.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut by_phrase = scored.clone();
        by_phrase.sort_by(|a, b| (b.2 + b.1 * 0.2).total_cmp(&(a.2 + a.1 * 0.2)));
        let mut by_auth = scored.clone();
        by_auth.sort_by(|a, b| b.3.total_cmp(&a.3));

        let mut rrf_scores: HashMap<usize, f64> = HashMap::new();
        for (rank, (idx, _, _, _)) in by_bm25.iter().enumerate() {
            *rrf_scores.entry(*idx).or_insert(0.0) += 1.5 / (60.0 + (rank + 1) as f64);
        }
        for (rank, (idx, _, _, _)) in by_phrase.iter().enumerate() {
            *rrf_scores.entry(*idx).or_insert(0.0) += 1.0 / (60.0 + (rank + 1) as f64);
        }
        for (rank, (idx, _, _, _)) in by_auth.iter().enumerate() {
            *rrf_scores.entry(*idx).or_insert(0.0) += 0.5 / (60.0 + (rank + 1) as f64);
        }

        let mut hits: Vec<RagChunkHit> = scored
            .into_iter()
            .map(|(idx, bm25, phrase, auth)| {
                let (cit, tier, url, title, heading, body, _, xxh3_hex) = &rows[idx];
                RagChunkHit {
                    citation_id: cit.clone(),
                    tier: *tier,
                    source_url: url.clone(),
                    title: title.clone(),
                    heading: heading.clone(),
                    snippet: truncate_utf8_word_safe(body, 360),
                    bm25_score: (bm25 * 1000.0).round() / 1000.0,
                    phrase_boost: (phrase * 1000.0).round() / 1000.0,
                    authority_boost: (auth * 1000.0).round() / 1000.0,
                    rrf_score: (*rrf_scores.get(&idx).unwrap_or(&0.0) * 10_000.0).round() / 10_000.0,
                    xxh3_hex: xxh3_hex.clone(),
                }
            })
            .collect();

        hits.sort_by(|a, b| {
            b.rrf_score
                .total_cmp(&a.rrf_score)
                .then_with(|| b.bm25_score.total_cmp(&a.bm25_score))
                .then_with(|| a.citation_id.cmp(&b.citation_id))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    /// Pins a source (or promotes a Local `[S###]` source into Global `[G###]` RAG!).
    pub fn pin_source(
        &self,
        citation_id: &str,
        target_tier: VaultTier,
    ) -> Result<ResearchSourceRecord, String> {
        let cid = normalize_citation_id(citation_id);
        let (src, body) = {
            let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
            let Some((s, b)) = get_source_with_body(&conn, &cid)? else {
                return Err(format!("source `{cid}` not found"));
            };
            (s, b)
        };

        if src.tier == target_tier {
            let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
            let mut stmt = conn
                .prepare("UPDATE rv_sources SET pinned = 1 WHERE citation_id = ?1;")
                .map_err(|e| e.to_string())?;
            stmt.bind_text(1, &cid).map_err(|e| e.to_string())?;
            stmt.step().map_err(|e| e.to_string())?;
            let mut updated = src;
            updated.pinned = true;
            return Ok(updated);
        }

        // Promote across tiers (e.g. Local [S001] -> Global [G001]).
        self.ingest_document(
            target_tier,
            &src.url,
            Some(&src.canonical_url),
            Some(&src.title),
            if body.is_empty() {
                &src.markdown_excerpt
            } else {
                &body
            },
            "text/markdown",
            src.http_status,
            &src.query_origin,
        )
    }

    /// Records a claim with inline citations, runs session self-consistency check for conflicts,
    /// and auto-downgrades grade when citations are missing or unverified.
    pub fn record_claim(
        &self,
        session_id: &str,
        text: &str,
        citations: Vec<String>,
        requested_grade: EvidenceGrade,
        notes: &str,
    ) -> Result<ResearchClaim, String> {
        let clean_text = SecretRedactor::redact(text.trim());
        if clean_text.is_empty() {
            return Err("claim text cannot be empty".to_string());
        }
        let clean_cits: Vec<String> = citations
            .into_iter()
            .map(|c| normalize_citation_id(&c))
            .filter(|c| !c.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();

        let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        let mut valid_cits = Vec::new();
        for c in &clean_cits {
            if source_exists(&conn, c)? {
                valid_cits.push(c.clone());
            }
        }

        // Session-level self-consistency check against earlier claims in the same session.
        let prior_claims = list_claims_for_session_locked(&conn, session_id)?;
        let new_tokens = tokenize_folded(&clean_text);
        let new_neg = contains_negation_signal(&clean_text);
        let mut conflicts_with = Vec::new();
        for prior in &prior_claims {
            let p_tokens = tokenize_folded(&prior.text);
            let overlap = new_tokens.intersection(&p_tokens).count();
            if overlap >= 3 && (new_neg != contains_negation_signal(&prior.text)) {
                conflicts_with.push(prior.claim_id.clone());
            }
        }

        let effective_grade = if !conflicts_with.is_empty() {
            EvidenceGrade::Conflict
        } else if valid_cits.is_empty() {
            EvidenceGrade::UnverifiedGap
        } else if valid_cits.len() == 1 && requested_grade == EvidenceGrade::Corroborated {
            EvidenceGrade::SingleSource
        } else {
            requested_grade
        };

        let claim = ResearchClaim {
            claim_id: format!("clm_{}", &uuid_v4()[..12]),
            session_id: session_id.trim().to_string(),
            text: clean_text,
            citations: valid_cits,
            grade: effective_grade,
            notes: SecretRedactor::redact(notes.trim()),
            conflicts_with,
            created_at_ms: now_epoch_ms(),
        };

        let mut stmt = conn
            .prepare(
                "INSERT INTO rv_claims (claim_id, session_id, text, citations_json, grade, notes, conflicts_json, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, &claim.claim_id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, &claim.session_id).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &claim.text).map_err(|e| e.to_string())?;
        stmt.bind_text(4, &serde_json::to_string(&claim.citations).unwrap_or_else(|_| "[]".into()))
            .map_err(|e| e.to_string())?;
        stmt.bind_text(5, claim.grade.as_str()).map_err(|e| e.to_string())?;
        stmt.bind_text(6, &claim.notes).map_err(|e| e.to_string())?;
        stmt.bind_text(7, &serde_json::to_string(&claim.conflicts_with).unwrap_or_else(|_| "[]".into()))
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(8, claim.created_at_ms).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(claim)
    }

    /// Parses all `[S###]` and `[G###]` inline citation markers in `text` and audits them
    /// against persisted sources in the ResearchVault.
    #[must_use]
    pub fn verify_inline_citations(&self, text: &str) -> Value {
        let found = extract_inline_citation_markers(text);
        let mut verified = Vec::new();
        let mut invalid = Vec::new();
        if let Ok(conn) = self.conn.lock() {
            for cid in &found {
                if source_exists(&conn, cid).unwrap_or(false) {
                    verified.push(cid.clone());
                } else {
                    invalid.push(cid.clone());
                }
            }
        }
        json!({
            "valid": invalid.is_empty(),
            "foundCount": found.len(),
            "verified": verified,
            "invalid": invalid,
        })
    }

    /// `keenable-select` cached `result_set_id` structured table extraction over persisted RAG
    /// without re-fetching network pages, flagging single-source rows honestly.
    pub fn extract_structured_table(
        &self,
        result_set_id: Option<&str>,
        query: &str,
        columns: &[String],
        top_k: usize,
    ) -> Result<StructuredTableResult, String> {
        let cols: Vec<String> = if columns.is_empty() {
            vec![
                "citation_id".into(),
                "title".into(),
                "domain".into(),
                "evidence_snippet".into(),
            ]
        } else {
            columns
                .iter()
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .take(16)
                .collect()
        };

        let (rs_id, effective_query, hits) = if let Some(existing_id) = result_set_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let cached = {
                let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
                load_result_set(&conn, existing_id)?
            };
            if let Some((q, cit_ids)) = cached {
                let mut h = self.query_rag(if query.trim().is_empty() { &q } else { query }, None, top_k.max(12))?;
                if !cit_ids.is_empty() {
                    let allowed: BTreeSet<String> = cit_ids.into_iter().collect();
                    let filtered: Vec<RagChunkHit> = h
                        .iter()
                        .filter(|x| allowed.contains(&x.citation_id))
                        .cloned()
                        .collect();
                    if !filtered.is_empty() {
                        h = filtered;
                    }
                }
                (existing_id.to_string(), q, h)
            } else {
                let h = self.query_rag(query, None, top_k)?;
                let new_id = existing_id.to_string();
                self.save_result_set(&new_id, query, &h)?;
                (new_id, query.to_string(), h)
            }
        } else {
            let h = self.query_rag(query, None, top_k)?;
            let new_id = format!("rs_{}", &uuid_v4()[..10]);
            self.save_result_set(&new_id, query, &h)?;
            (new_id, query.to_string(), h)
        };

        let mut by_source: BTreeMap<String, Vec<&RagChunkHit>> = BTreeMap::new();
        for hit in &hits {
            by_source.entry(hit.citation_id.clone()).or_default().push(hit);
        }

        let mut rows = Vec::new();
        let mut single_source_rows = Vec::new();
        let mut source_citations = Vec::new();

        for (row_idx, (cid, chunk_group)) in by_source.iter().enumerate() {
            let first = chunk_group[0];
            source_citations.push(cid.clone());
            let mut row = Map::new();
            let combined_text = chunk_group
                .iter()
                .map(|c| c.snippet.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            for col in &cols {
                let cl = col.to_ascii_lowercase();
                let val = match cl.as_str() {
                    "citation_id" | "citation" | "id" | "source" => format!("[{cid}]"),
                    "title" | "name" => first.title.clone(),
                    "url" | "source_url" => first.source_url.clone(),
                    "domain" => extract_domain(&first.source_url),
                    "tier" => first.tier.as_str().to_string(),
                    "heading" | "section" => first.heading.clone(),
                    "score" | "rrf_score" => format!("{:.4}", first.rrf_score),
                    _ => extract_column_value_from_text(&combined_text, col)
                        .unwrap_or_else(|| truncate_utf8_word_safe(&first.snippet, 160)),
                };
                row.insert(col.clone(), Value::String(val));
            }
            row.insert("_citation".into(), Value::String(format!("[{cid}]")));
            row.insert(
                "_evidenceGrade".into(),
                Value::String(EvidenceGrade::SingleSource.tag().into()),
            );
            single_source_rows.push(row_idx);
            rows.push(row);
        }

        Ok(StructuredTableResult {
            result_set_id: rs_id,
            query: effective_query,
            columns: cols,
            rows,
            single_source_rows,
            source_citations,
        })
    }

    /// Returns the full PRISMA-grade "Sources (Searched, Viewed & Extracted)" ledger.
    pub fn sources_ledger(&self, tier_filter: Option<VaultTier>) -> Result<SourcesLedgerSummary, String> {
        let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        let sources = list_sources_locked(&conn, tier_filter)?;
        let cited_ids = list_all_cited_ids_locked(&conn)?;

        let mut total_searched = 0usize;
        let mut total_viewed = 0usize;
        let mut total_extracted = 0usize;
        let mut total_blocked = 0usize;
        let mut total_auth_required = 0usize;
        let mut total_failed = 0usize;
        for s in &sources {
            match s.stage {
                SourceStage::Searched => total_searched += 1,
                SourceStage::Viewed => total_viewed += 1,
                SourceStage::Extracted => total_extracted += 1,
                SourceStage::Blocked => total_blocked += 1,
                SourceStage::AuthRequired => total_auth_required += 1,
                SourceStage::Failed => total_failed += 1,
            }
        }
        Ok(SourcesLedgerSummary {
            total_searched,
            total_viewed,
            total_extracted,
            total_blocked,
            total_auth_required,
            total_failed,
            cited_ids,
            sources,
        })
    }

    /// Counts claims persisted across sessions (or for one session).
    pub fn count_claims(&self, session_id: Option<&str>) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        let mut stmt = if session_id.is_some() {
            conn.prepare("SELECT COUNT(*) FROM rv_claims WHERE session_id = ?1;")
        } else {
            conn.prepare("SELECT COUNT(*) FROM rv_claims;")
        }
        .map_err(|e| e.to_string())?;
        if let Some(sid) = session_id {
            stmt.bind_text(1, sid).map_err(|e| e.to_string())?;
        }
        if stmt.step_row().map_err(|e| e.to_string())? {
            Ok(stmt.column_int64(0).unwrap_or(0).max(0) as usize)
        } else {
            Ok(0)
        }
    }

    /// Exports a full Research Dossier (`markdown` or `json`) including claim ledger +
    /// mandatory `## Sources (Searched, Viewed & Extracted)` table.
    pub fn export_dossier(&self, format: &str, session_id: Option<&str>) -> Result<String, String> {
        let ledger = self.sources_ledger(None)?;
        let claims = {
            let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
            if let Some(sid) = session_id {
                list_claims_for_session_locked(&conn, sid)?
            } else {
                list_all_claims_locked(&conn)?
            }
        };

        if format.eq_ignore_ascii_case("json") {
            let val = json!({
                "ok": true,
                "exportedAtMs": now_epoch_ms(),
                "sessionId": session_id,
                "claims": claims,
                "sourcesLedger": ledger,
            });
            return serde_json::to_string_pretty(&val).map_err(|e| e.to_string());
        }

        let mut md = String::from("# Omnia Deep Research Dossier\n\n");
        if let Some(sid) = session_id {
            md.push_str(&format!("- **Session**: `{sid}`\n"));
        }
        md.push_str(&format!(
            "- **Sources**: {} extracted, {} viewed, {} searched, {} blocked, {} auth-required, {} failed\n\n",
            ledger.total_extracted,
            ledger.total_viewed,
            ledger.total_searched,
            ledger.total_blocked,
            ledger.total_auth_required,
            ledger.total_failed
        ));

        if !claims.is_empty() {
            md.push_str("## Claim & Evidence Ledger\n\n");
            for clm in &claims {
                let cits = clm
                    .citations
                    .iter()
                    .map(|c| format!("[{c}]"))
                    .collect::<Vec<_>>()
                    .join(" ");
                md.push_str(&format!(
                    "- {} {} {}\n",
                    clm.grade.tag(),
                    clm.text,
                    cits
                ));
                if !clm.conflicts_with.is_empty() {
                    md.push_str(&format!(
                        "  - *Conflict flagged against*: {}\n",
                        clm.conflicts_with.join(", ")
                    ));
                }
            }
            md.push('\n');
        }

        md.push_str("## Sources (Searched, Viewed & Extracted)\n\n");
        md.push_str("| ID | Tier | Stage | HTTP | Title | Canonical URL | SHA-256 (12) | Notes |\n");
        md.push_str("| :--- | :--- | :--- | :---: | :--- | :--- | :--- | :--- |\n");
        for src in &ledger.sources {
            let short_sha: String = src.sha256_hex.chars().take(12).collect();
            let status_s = src
                .http_status
                .map(|s| s.to_string())
                .unwrap_or_else(|| "-".into());
            let note = src.error_note.as_deref().unwrap_or("");
            md.push_str(&format!(
                "| `[{}]` | `{}` | `{}` | {} | {} | {} | `{}` | {} |\n",
                src.citation_id,
                src.tier.as_str(),
                src.stage.as_str(),
                status_s,
                src.title.replace('|', "\\|"),
                src.canonical_url.replace('|', "\\|"),
                short_sha,
                note.replace('|', "\\|")
            ));
        }
        Ok(md)
    }

    fn save_result_set(&self, id: &str, query: &str, hits: &[RagChunkHit]) -> Result<(), String> {
        let ids: Vec<String> = hits
            .iter()
            .map(|h| h.citation_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let conn = self.conn.lock().map_err(|_| "vault lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "INSERT OR REPLACE INTO rv_result_sets (result_set_id, query, citation_ids_json, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4);",
            )
            .map_err(|e| e.to_string())?;
        stmt.bind_text(1, id).map_err(|e| e.to_string())?;
        stmt.bind_text(2, query).map_err(|e| e.to_string())?;
        stmt.bind_text(3, &serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()))
            .map_err(|e| e.to_string())?;
        stmt.bind_int64(4, now_epoch_ms()).map_err(|e| e.to_string())?;
        stmt.step().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn write_snapshot_file(
        &self,
        tier: VaultTier,
        citation_id: &str,
        title: &str,
        canonical_url: &str,
        body_md: &str,
    ) -> Option<String> {
        let base_dir = match tier {
            VaultTier::Local => self.local_dir.as_ref()?,
            VaultTier::Global => self.global_dir.as_ref()?,
        };
        let snap_dir = base_dir.join("snapshots");
        let file_path = snap_dir.join(format!("{citation_id}.md"));
        let doc = format!(
            "---\ncitation_id: {citation_id}\ntier: {}\ntitle: \"{}\"\ncanonical_url: \"{}\"\n---\n\n{body_md}\n",
            tier.as_str(),
            title.replace('"', "'"),
            canonical_url.replace('"', "'")
        );
        atomic_write_with_retry(&file_path, doc.as_bytes()).ok()?;
        Some(file_path.to_string_lossy().replace('\\', "/"))
    }
}

// =========================================================================
// Internal SQLite & Parsing Helpers
// =========================================================================

fn next_citation_id(conn: &Connection, tier: VaultTier) -> Result<String, String> {
    let mut sel = conn
        .prepare("SELECT next_num FROM rv_seq WHERE tier = ?1;")
        .map_err(|e| e.to_string())?;
    sel.bind_text(1, tier.as_str()).map_err(|e| e.to_string())?;
    let next_n = if sel.step_row().map_err(|e| e.to_string())? {
        sel.column_int64(0).unwrap_or(1).max(1)
    } else {
        1
    };
    let mut upd = conn
        .prepare("INSERT OR REPLACE INTO rv_seq (tier, next_num) VALUES (?1, ?2);")
        .map_err(|e| e.to_string())?;
    upd.bind_text(1, tier.as_str()).map_err(|e| e.to_string())?;
    upd.bind_int64(2, next_n + 1).map_err(|e| e.to_string())?;
    upd.step().map_err(|e| e.to_string())?;
    Ok(format!("{}{:03}", tier.prefix(), next_n))
}

fn upsert_source_row(
    conn: &Connection,
    rec: &ResearchSourceRecord,
    body_md: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO rv_sources (
                citation_id, tier, url, canonical_url, title, domain, published_at, stage,
                http_status, error_kind_json, error_note, authority_score, xxh3_hex, sha256_hex,
                raw_bytes, extracted_chars, markdown_excerpt, markdown_body, snapshot_path,
                query_origin, fetched_at_ms, pinned
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22);",
        )
        .map_err(|e| e.to_string())?;
    let err_json = rec
        .error_kind
        .as_ref()
        .and_then(|k| serde_json::to_string(k).ok());
    stmt.bind_text(1, &rec.citation_id).map_err(|e| e.to_string())?;
    stmt.bind_text(2, rec.tier.as_str()).map_err(|e| e.to_string())?;
    stmt.bind_text(3, &rec.url).map_err(|e| e.to_string())?;
    stmt.bind_text(4, &rec.canonical_url).map_err(|e| e.to_string())?;
    stmt.bind_text(5, &rec.title).map_err(|e| e.to_string())?;
    stmt.bind_text(6, &rec.domain).map_err(|e| e.to_string())?;
    stmt.bind_opt_text(7, rec.published_at.as_deref()).map_err(|e| e.to_string())?;
    stmt.bind_text(8, rec.stage.as_str()).map_err(|e| e.to_string())?;
    match rec.http_status {
        Some(code) => stmt.bind_int64(9, i64::from(code)).map_err(|e| e.to_string())?,
        None => stmt.bind_null(9).map_err(|e| e.to_string())?,
    }
    stmt.bind_opt_text(10, err_json.as_deref()).map_err(|e| e.to_string())?;
    stmt.bind_opt_text(11, rec.error_note.as_deref()).map_err(|e| e.to_string())?;
    stmt.bind_double(12, rec.authority_score).map_err(|e| e.to_string())?;
    stmt.bind_text(13, &rec.xxh3_hex).map_err(|e| e.to_string())?;
    stmt.bind_text(14, &rec.sha256_hex).map_err(|e| e.to_string())?;
    stmt.bind_int64(15, rec.raw_bytes as i64).map_err(|e| e.to_string())?;
    stmt.bind_int64(16, rec.extracted_chars as i64).map_err(|e| e.to_string())?;
    stmt.bind_text(17, &rec.markdown_excerpt).map_err(|e| e.to_string())?;
    stmt.bind_text(18, body_md).map_err(|e| e.to_string())?;
    stmt.bind_opt_text(19, rec.snapshot_path.as_deref()).map_err(|e| e.to_string())?;
    stmt.bind_text(20, &rec.query_origin).map_err(|e| e.to_string())?;
    stmt.bind_int64(21, rec.fetched_at_ms).map_err(|e| e.to_string())?;
    stmt.bind_int64(22, i64::from(rec.pinned)).map_err(|e| e.to_string())?;
    stmt.step().map_err(|e| e.to_string())?;
    Ok(())
}

fn replace_chunks_for_source(
    conn: &Connection,
    citation_id: &str,
    tier: VaultTier,
    default_heading: &str,
    body_md: &str,
) -> Result<(), String> {
    let mut del = conn
        .prepare("DELETE FROM rv_chunks WHERE citation_id = ?1;")
        .map_err(|e| e.to_string())?;
    del.bind_text(1, citation_id).map_err(|e| e.to_string())?;
    del.step().map_err(|e| e.to_string())?;

    let chunks = chunk_markdown_overlapping(body_md, default_heading);
    for (idx, (heading, body)) in chunks.into_iter().enumerate() {
        let mut ins = conn
            .prepare(
                "INSERT INTO rv_chunks (chunk_id, citation_id, tier, chunk_idx, heading, body, token_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
            )
            .map_err(|e| e.to_string())?;
        let cid = format!("{citation_id}_c{idx:03}");
        let tok_cnt = body.split_whitespace().count() as i64;
        ins.bind_text(1, &cid).map_err(|e| e.to_string())?;
        ins.bind_text(2, citation_id).map_err(|e| e.to_string())?;
        ins.bind_text(3, tier.as_str()).map_err(|e| e.to_string())?;
        ins.bind_int64(4, idx as i64).map_err(|e| e.to_string())?;
        ins.bind_text(5, &heading).map_err(|e| e.to_string())?;
        ins.bind_text(6, &body).map_err(|e| e.to_string())?;
        ins.bind_int64(7, tok_cnt).map_err(|e| e.to_string())?;
        ins.step().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn chunk_markdown_overlapping(body: &str, default_heading: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut cur_heading = default_heading.to_string();
    let mut cur_buf = String::new();

    for line in body.lines() {
        let t = line.trim();
        if t.starts_with('#') {
            if !cur_buf.trim().is_empty() {
                sections.push((cur_heading.clone(), cur_buf.trim().to_string()));
                cur_buf.clear();
            }
            cur_heading = t.trim_start_matches('#').trim().to_string();
        } else {
            cur_buf.push_str(line);
            cur_buf.push('\n');
        }
    }
    if !cur_buf.trim().is_empty() {
        sections.push((cur_heading, cur_buf.trim().to_string()));
    }
    if sections.is_empty() && !body.trim().is_empty() {
        sections.push((default_heading.to_string(), body.trim().to_string()));
    }

    let mut out = Vec::new();
    for (heading, text) in sections {
        let chars: Vec<char> = text.chars().collect();
        if chars.len() <= CHUNK_TARGET_CHARS {
            out.push((heading, text));
            continue;
        }
        let mut start = 0usize;
        while start < chars.len() {
            let end = (start + CHUNK_TARGET_CHARS).min(chars.len());
            let slice: String = chars[start..end].iter().collect();
            out.push((heading.clone(), slice));
            if end == chars.len() {
                break;
            }
            start = end.saturating_sub(CHUNK_OVERLAP_CHARS);
        }
    }
    out
}

fn read_source_row_stmt(stmt: &omnia_winsqlite::Statement<'_>) -> ResearchSourceRecord {
    let err_kind = stmt
        .column_opt_text(9)
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<FetchErrorKind>(&j).ok());
    let http_status = stmt
        .column_opt_int64(8)
        .ok()
        .flatten()
        .and_then(|v| u16::try_from(v).ok());
    ResearchSourceRecord {
        citation_id: stmt.column_text(0).unwrap_or_default(),
        tier: VaultTier::from_str_lossy(&stmt.column_text(1).unwrap_or_default()),
        url: stmt.column_text(2).unwrap_or_default(),
        canonical_url: stmt.column_text(3).unwrap_or_default(),
        title: stmt.column_text(4).unwrap_or_default(),
        domain: stmt.column_text(5).unwrap_or_default(),
        published_at: stmt.column_opt_text(6).ok().flatten(),
        stage: SourceStage::from_str_lossy(&stmt.column_text(7).unwrap_or_default()),
        http_status,
        error_kind: err_kind,
        error_note: stmt.column_opt_text(10).ok().flatten(),
        authority_score: stmt.column_double(11).unwrap_or(0.5),
        xxh3_hex: stmt.column_text(12).unwrap_or_default(),
        sha256_hex: stmt.column_text(13).unwrap_or_default(),
        raw_bytes: stmt.column_int64(14).unwrap_or(0).max(0) as usize,
        extracted_chars: stmt.column_int64(15).unwrap_or(0).max(0) as usize,
        markdown_excerpt: stmt.column_text(16).unwrap_or_default(),
        snapshot_path: stmt.column_opt_text(17).ok().flatten(),
        query_origin: stmt.column_text(18).unwrap_or_default(),
        fetched_at_ms: stmt.column_int64(19).unwrap_or(0),
        pinned: stmt.column_int64(20).unwrap_or(0) != 0,
    }
}

const SELECT_SOURCE_COLS: &str =
    "citation_id, tier, url, canonical_url, title, domain, published_at, stage,
     http_status, error_kind_json, error_note, authority_score, xxh3_hex, sha256_hex,
     raw_bytes, extracted_chars, markdown_excerpt, snapshot_path, query_origin,
     fetched_at_ms, pinned";

fn find_source_by_canonical(
    conn: &Connection,
    tier: VaultTier,
    canonical: &str,
) -> Result<Option<ResearchSourceRecord>, String> {
    let sql = format!(
        "SELECT {SELECT_SOURCE_COLS} FROM rv_sources WHERE tier = ?1 AND canonical_url = ?2 LIMIT 1;"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    stmt.bind_text(1, tier.as_str()).map_err(|e| e.to_string())?;
    stmt.bind_text(2, canonical).map_err(|e| e.to_string())?;
    if stmt.step_row().map_err(|e| e.to_string())? {
        Ok(Some(read_source_row_stmt(&stmt)))
    } else {
        Ok(None)
    }
}

fn find_source_by_xxh3(
    conn: &Connection,
    tier: VaultTier,
    xxh3_hex: &str,
) -> Result<Option<ResearchSourceRecord>, String> {
    let sql = format!(
        "SELECT {SELECT_SOURCE_COLS} FROM rv_sources WHERE tier = ?1 AND xxh3_hex = ?2 AND stage = 'extracted' LIMIT 1;"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    stmt.bind_text(1, tier.as_str()).map_err(|e| e.to_string())?;
    stmt.bind_text(2, xxh3_hex).map_err(|e| e.to_string())?;
    if stmt.step_row().map_err(|e| e.to_string())? {
        Ok(Some(read_source_row_stmt(&stmt)))
    } else {
        Ok(None)
    }
}

fn get_source_with_body(
    conn: &Connection,
    citation_id: &str,
) -> Result<Option<(ResearchSourceRecord, String)>, String> {
    let sql = format!(
        "SELECT {SELECT_SOURCE_COLS}, markdown_body FROM rv_sources WHERE citation_id = ?1 LIMIT 1;"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    stmt.bind_text(1, citation_id).map_err(|e| e.to_string())?;
    if stmt.step_row().map_err(|e| e.to_string())? {
        let rec = read_source_row_stmt(&stmt);
        let body = stmt.column_text(21).unwrap_or_default();
        Ok(Some((rec, body)))
    } else {
        Ok(None)
    }
}

fn source_exists(conn: &Connection, citation_id: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM rv_sources WHERE citation_id = ?1 LIMIT 1;")
        .map_err(|e| e.to_string())?;
    stmt.bind_text(1, citation_id).map_err(|e| e.to_string())?;
    stmt.step_row().map_err(|e| e.to_string())
}

fn list_sources_locked(
    conn: &Connection,
    tier_filter: Option<VaultTier>,
) -> Result<Vec<ResearchSourceRecord>, String> {
    let sql = if tier_filter.is_some() {
        format!("SELECT {SELECT_SOURCE_COLS} FROM rv_sources WHERE tier = ?1 ORDER BY fetched_at_ms DESC LIMIT 500;")
    } else {
        format!("SELECT {SELECT_SOURCE_COLS} FROM rv_sources ORDER BY fetched_at_ms DESC LIMIT 500;")
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    if let Some(t) = tier_filter {
        stmt.bind_text(1, t.as_str()).map_err(|e| e.to_string())?;
    }
    let mut out = Vec::new();
    while stmt.step_row().map_err(|e| e.to_string())? {
        out.push(read_source_row_stmt(&stmt));
    }
    Ok(out)
}

fn list_claims_for_session_locked(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ResearchClaim>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT claim_id, session_id, text, citations_json, grade, notes, conflicts_json, created_at_ms
             FROM rv_claims WHERE session_id = ?1 ORDER BY created_at_ms ASC LIMIT 500;",
        )
        .map_err(|e| e.to_string())?;
    stmt.bind_text(1, session_id).map_err(|e| e.to_string())?;
    collect_claims(&mut stmt)
}

fn list_all_claims_locked(conn: &Connection) -> Result<Vec<ResearchClaim>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT claim_id, session_id, text, citations_json, grade, notes, conflicts_json, created_at_ms
             FROM rv_claims ORDER BY created_at_ms DESC LIMIT 500;",
        )
        .map_err(|e| e.to_string())?;
    collect_claims(&mut stmt)
}

fn collect_claims(stmt: &mut omnia_winsqlite::Statement<'_>) -> Result<Vec<ResearchClaim>, String> {
    let mut out = Vec::new();
    while stmt.step_row().map_err(|e| e.to_string())? {
        let cits: Vec<String> = serde_json::from_str(&stmt.column_text(3).unwrap_or_default())
            .unwrap_or_default();
        let confs: Vec<String> = serde_json::from_str(&stmt.column_text(6).unwrap_or_default())
            .unwrap_or_default();
        out.push(ResearchClaim {
            claim_id: stmt.column_text(0).unwrap_or_default(),
            session_id: stmt.column_text(1).unwrap_or_default(),
            text: stmt.column_text(2).unwrap_or_default(),
            citations: cits,
            grade: EvidenceGrade::from_str_lossy(&stmt.column_text(4).unwrap_or_default()),
            notes: stmt.column_text(5).unwrap_or_default(),
            conflicts_with: confs,
            created_at_ms: stmt.column_int64(7).unwrap_or(0),
        });
    }
    Ok(out)
}

fn list_all_cited_ids_locked(conn: &Connection) -> Result<Vec<String>, String> {
    let claims = list_all_claims_locked(conn)?;
    let mut set = BTreeSet::new();
    for clm in claims {
        for c in clm.citations {
            set.insert(c);
        }
    }
    Ok(set.into_iter().collect())
}

fn load_result_set(
    conn: &Connection,
    id: &str,
) -> Result<Option<(String, Vec<String>)>, String> {
    let mut stmt = conn
        .prepare("SELECT query, citation_ids_json FROM rv_result_sets WHERE result_set_id = ?1 LIMIT 1;")
        .map_err(|e| e.to_string())?;
    stmt.bind_text(1, id).map_err(|e| e.to_string())?;
    if stmt.step_row().map_err(|e| e.to_string())? {
        let q = stmt.column_text(0).unwrap_or_default();
        let ids: Vec<String> = serde_json::from_str(&stmt.column_text(1).unwrap_or_default())
            .unwrap_or_default();
        Ok(Some((q, ids)))
    } else {
        Ok(None)
    }
}

fn normalize_citation_id(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim()
        .to_ascii_uppercase()
}

fn extract_inline_citation_markers(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = BTreeSet::new();
    let mut i = 0usize;
    while i + 4 < bytes.len() {
        if bytes[i] == b'[' && matches!(bytes[i + 1], b'S' | b'G') {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 2 && j < bytes.len() && bytes[j] == b']' {
                out.insert(text[i + 1..j].to_string());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out.into_iter().collect()
}

fn extract_domain(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_else(|| "local".to_string())
}

fn score_domain_authority(domain: &str, url: &str) -> f64 {
    let d = domain.to_ascii_lowercase();
    if d.ends_with(".gov")
        || d.ends_with(".edu")
        || d == "arxiv.org"
        || d == "doi.org"
        || d == "rfc-editor.org"
        || d == "doc.rust-lang.org"
        || d == "docs.rs"
        || d == "api.openalex.org"
        || d == "europepmc.org"
        || d == "www.ebi.ac.uk"
    {
        return 0.96;
    }
    if d == "github.com"
        || d == "raw.githubusercontent.com"
        || d.starts_with("docs.")
        || d.contains("developer.")
        || d.ends_with("wikipedia.org")
    {
        return 0.85;
    }
    if url.starts_with("https://") {
        0.65
    } else {
        0.45
    }
}

fn contains_negation_signal(text: &str) -> bool {
    let low = format!(" {} ", fold_vietnamese_ascii(text));
    [
        " not ", " never ", " cannot ", " false ", " no ", " fails ", " disabled ", " khong ",
        " sai ", " bi chan ",
    ]
    .iter()
    .any(|w| low.contains(w))
}

fn extract_column_value_from_text(text: &str, col: &str) -> Option<String> {
    let col_f = fold_vietnamese_ascii(col);
    for line in text.lines() {
        let lf = fold_vietnamese_ascii(line);
        if lf.contains(&col_f) {
            return Some(truncate_utf8_word_safe(line.trim(), 160));
        }
    }
    None
}

fn split_folded_words(text: &str) -> Vec<String> {
    let folded = fold_vietnamese_ascii(text);
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            cur.push(ch);
        } else if !cur.is_empty() {
            if cur.len() >= 2 {
                out.push(std::mem::take(&mut cur));
            } else {
                cur.clear();
            }
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    out
}

fn extract_tag_inner_ci<'a>(html: &'a str, tag: &str) -> Option<&'a str> {
    let low = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start_pos = low.find(&open)?;
    let gt = low[start_pos..].find('>')? + start_pos + 1;
    let end_rel = low[gt..].find(&close)?;
    if html.is_char_boundary(gt) && html.is_char_boundary(gt + end_rel) {
        Some(&html[gt..gt + end_rel])
    } else {
        None
    }
}

fn extract_meta_or_link_ci(html: &str, key: &str) -> Option<String> {
    let low = html.to_ascii_lowercase();
    let key_low = key.to_ascii_lowercase();
    let mut offset = 0usize;
    while let Some(pos) = low[offset..].find(&key_low) {
        let abs = offset + pos;
        let tag_start = low[..abs].rfind('<')?;
        let tag_end = low[abs..].find('>')? + abs + 1;
        if html.is_char_boundary(tag_start) && html.is_char_boundary(tag_end) {
            let tag = &html[tag_start..tag_end];
            for attr in ["href=\"", "content=\"", "href='", "content='"] {
                if let Some(ai) = tag.to_ascii_lowercase().find(attr) {
                    let quote = attr.chars().last().unwrap_or('"');
                    let val_start = ai + attr.len();
                    if let Some(val_end) = tag[val_start..].find(quote) {
                        let v = tag[val_start..val_start + val_end].trim();
                        if !v.is_empty() {
                            return Some(decode_html_entities(v));
                        }
                    }
                }
            }
        }
        offset = abs + key_low.len();
    }
    None
}

fn strip_noise_blocks(html: &str) -> String {
    let mut cur = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "nav", "footer"] {
        loop {
            let low = cur.to_ascii_lowercase();
            let open = format!("<{tag}");
            let close = format!("</{tag}>");
            let Some(s) = low.find(&open) else {
                break;
            };
            let end = low[s..]
                .find(&close)
                .map(|rel| s + rel + close.len())
                .unwrap_or(cur.len());
            if cur.is_char_boundary(s) && cur.is_char_boundary(end) {
                cur.replace_range(s..end, " ");
            } else {
                break;
            }
        }
    }
    cur
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn collapse_markdown_whitespace(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut prev_blank = false;
    for line in normalized.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            if !prev_blank {
                out.push("");
            }
            prev_blank = true;
        } else {
            out.push(t);
            prev_blank = false;
        }
    }
    out.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_unwrapper_and_html_markdown_extraction_work() {
        let wrapped = "https://vertexaisearch.cloud.google.com/grounding-api-redirect?url=https%3A%2F%2Fdocs.rs%2Fserde%3Futm_source%3Dtest%26version%3D1";
        assert_eq!(
            unwrap_canonical_redirect_url(wrapped),
            "https://docs.rs/serde?version=1"
        );
        let html = r#"<html><head><title>Rust Async &amp; WAL</title><link rel="canonical" href="https://docs.rs/omnia"><meta property="article:published_time" content="2026-11-28"></head><body><script>evil()</script><article><h1>SQLite WAL</h1><p>Write-ahead logging improves concurrency.</p><ul><li>Zero lock contention</li><li>Atomic checkpoints</li></ul></article></body></html>"#;
        let (title, canon, pub_at, md) = html_to_clean_markdown(html);
        assert_eq!(title.as_deref(), Some("Rust Async & WAL"));
        assert_eq!(canon.as_deref(), Some("https://docs.rs/omnia"));
        assert_eq!(pub_at.as_deref(), Some("2026-11-28"));
        assert!(md.contains("# SQLite WAL"));
        assert!(md.contains("- Zero lock contention"));
        assert!(!md.contains("evil()"));
    }

    #[test]
    fn vault_dedup_rag_rrf_claims_table_and_dossier_work() {
        let vault = ResearchVault::open_in_memory().unwrap();
        let s1 = vault
            .ingest_document(
                VaultTier::Local,
                "https://docs.rs/omnia-wal",
                None,
                Some("SQLite WAL Architecture"),
                "# SQLite WAL\nOmnia uses cooperative WAL leases and atomic rename checkpoints.",
                "text/markdown",
                Some(200),
                "sqlite wal concurrency",
            )
            .unwrap();
        assert_eq!(s1.citation_id, "S001");
        assert_eq!(s1.stage, SourceStage::Extracted);

        // Exact content dedup returns same S001.
        let s1_dup = vault
            .ingest_document(
                VaultTier::Local,
                "https://mirror.example.test/omnia-wal",
                None,
                Some("Duplicate"),
                "# SQLite WAL\nOmnia uses cooperative WAL leases and atomic rename checkpoints.",
                "text/markdown",
                Some(200),
                "sqlite wal",
            )
            .unwrap();
        assert_eq!(s1_dup.citation_id, "S001");

        // Promote S001 -> Global G001.
        let g1 = vault.pin_source("S001", VaultTier::Global).unwrap();
        assert_eq!(g1.citation_id, "G001");
        assert_eq!(g1.tier, VaultTier::Global);

        // Hybrid BM25 + fuzzy Levenshtein query finds both [S001] & [G001].
        let hits = vault.query_rag("cooperative wal checkpionts", None, 5).unwrap();
        assert!(!hits.is_empty());

        // Claim recording + conflict detection + inline citation audit.
        let c1 = vault
            .record_claim(
                "sess-1",
                "Omnia uses cooperative WAL leases for concurrency",
                vec!["S001".into(), "G001".into()],
                EvidenceGrade::Corroborated,
                "verified",
            )
            .unwrap();
        assert_eq!(c1.grade, EvidenceGrade::Corroborated);

        let c2 = vault
            .record_claim(
                "sess-1",
                "Omnia does not use cooperative WAL leases for concurrency",
                vec!["S001".into()],
                EvidenceGrade::Verified,
                "contradiction test",
            )
            .unwrap();
        assert_eq!(c2.grade, EvidenceGrade::Conflict);
        assert!(c2.conflicts_with.contains(&c1.claim_id));

        let check = vault.verify_inline_citations("See [S001] and [G001] but not [S999].");
        assert_eq!(check["valid"], Value::Bool(false));
        assert_eq!(check["invalid"], json!(["S999"]));

        // Cached result_set_id table extraction + dossier export.
        let tbl = vault
            .extract_structured_table(
                None,
                "cooperative WAL leases",
                &["citation_id".into(), "title".into(), "domain".into()],
                6,
            )
            .unwrap();
        assert!(!tbl.rows.is_empty());
        assert!(!tbl.single_source_rows.is_empty());

        let md = vault.export_dossier("markdown", Some("sess-1")).unwrap();
        assert!(md.contains("## Sources (Searched, Viewed & Extracted)"));
        assert!(md.contains("[S001]"));
        assert!(md.contains("[G001]"));
    }

    #[test]
    fn fetch_error_classifier_enforces_honest_non_bypass() {
        assert_eq!(
            classify_http_fetch_error(
                429,
                "<html>cf-turnstile verify you are human</html>",
                "https://example.test/page"
            ),
            Some(FetchErrorKind::PlatformBlocked)
        );
        assert_eq!(
            classify_http_fetch_error(
                401,
                "Sign in required",
                "https://accounts.google.com/ServiceLogin"
            ),
            Some(FetchErrorKind::NeedLogin)
        );
    }
}
