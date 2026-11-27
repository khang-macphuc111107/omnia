//! Web Fetch, Multi-Backend Web & Academic Literature Search, Challenge Classification,
//! and Isolated CDP Browser Automation Tools (`omnia-media-capture`).
//!
//! Enforces:
//! - Fail-closed SSRF / DNS-rebinding egress checks (`omnia_workspace_ops::egress`)
//! - Typed `agent-reach`-style error taxonomy (`NeedLogin`, `PlatformBlocked`, `RateLimited`,
//!   `UpstreamBroken`, `Timeout`, `NotFound`, `BadInput`, `SsrfBlocked`) with ZERO CAPTCHA/auth bypass
//! - Polite per-domain concurrency & rate pacing (e.g., arXiv `<= 1 req / 3s`, Europe PMC `<= 1 req / s`)
//! - Multi-backend parallel fan-out: Tavily / Exa / Brave (when configured) + DuckDuckGo HTML SERP
//!   + Wikipedia REST + arXiv Atom API + OpenAlex Works API + Europe PMC REST (`OPEN_ACCESS:y`)
//! - Heading/list/code-preserving HTML->Markdown extraction wrapped in untrusted data-plane sanitization
//! - Strictly isolated headless/windowed CDP browser sessions (`D:\OmniaData\tmp\omnia-cdp-*`, zero Thorium)

use crate::sanitizer::sanitize_untrusted_text;
use anyhow::{bail, Context, Result};
use futures_util::future::join_all;
use omnia_media_capture::browser_cdp::{
    launch_isolated_browser, CdpSession, IsolatedBrowserHandle, IsolatedBrowserLaunchOptions,
};
use omnia_workspace_ops::egress::{validate_egress_url_with_dns, EgressPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};

const DEFAULT_FETCH_MAX_BYTES: usize = 768 * 1024;
const USER_AGENT_STRING: &str = "OmniaAgent/5.0 (+https://github.com/khang-macphuc111107/omnia)";
static BROWSER_SID_SEQ: AtomicU64 = AtomicU64::new(1);

/// Typed read-only web/platform error taxonomy (`agent-reach` / honest non-bypass contract).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum WebSourceErrorKind {
    NeedLogin,
    PlatformBlocked,
    RateLimited { retry_after_secs: u64 },
    UpstreamBroken,
    Timeout,
    NotFound,
    BadInput,
    SsrfBlocked,
}

impl WebSourceErrorKind {
    #[must_use]
    pub const fn as_tag(&self) -> &'static str {
        match self {
            Self::NeedLogin => "[AUTH_REQUIRED]",
            Self::PlatformBlocked => "[BLOCKED_BY_CHALLENGE]",
            Self::RateLimited { .. } => "[RATE_LIMITED]",
            Self::UpstreamBroken => "[UPSTREAM_BROKEN]",
            Self::Timeout => "[TIMEOUT]",
            Self::NotFound => "[NOT_FOUND]",
            Self::BadInput => "[BAD_INPUT]",
            Self::SsrfBlocked => "[SSRF_BLOCKED]",
        }
    }

    #[must_use]
    pub const fn retry_permitted(&self) -> bool {
        !matches!(
            self,
            Self::NeedLogin | Self::PlatformBlocked | Self::SsrfBlocked | Self::BadInput
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebFetchOutcome {
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub text: String,
    pub truncated: bool,
}

/// Rich structured fetch outcome carrying canonical URL, title, published date, challenge flag,
/// BLAKE3 digest, and heading-preserving Markdown extraction for `ResearchVault` ingestion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredWebFetch {
    pub requested_url: String,
    pub canonical_url: String,
    pub domain: String,
    pub status: u16,
    pub content_type: String,
    pub title: String,
    pub published_at: Option<String>,
    pub markdown: String,
    pub blake3_hex: String,
    pub truncated: bool,
    pub source_stage: String,
    pub error_kind: Option<WebSourceErrorKind>,
    pub note: Option<String>,
}

/// Search scope selecting web, academic literature, or combined multi-backend fan-out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchScope {
    Web,
    Academic,
    #[default]
    All,
}

impl WebSearchScope {
    #[must_use]
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim).unwrap_or("all").to_ascii_lowercase().as_str() {
            "web" => Self::Web,
            "academic" | "papers" | "literature" | "scholar" => Self::Academic,
            _ => Self::All,
        }
    }
}

/// Parameters for multi-backend active search (`keenable-web` / `science` literature filters).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WebSearchOptions {
    pub query: String,
    pub limit: usize,
    pub scope: WebSearchScope,
    pub site: Option<String>,
    pub published_after: Option<String>,
    pub published_before: Option<String>,
}

/// Canonical search hit returned across web and academic literature connectors.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub provider: String,
    pub source_kind: String,
    pub title: String,
    pub url: String,
    pub canonical_url: String,
    pub domain: String,
    pub snippet: String,
    pub published_at: Option<String>,
    pub authors: Vec<String>,
    pub doi: Option<String>,
    pub cited_by_count: Option<u64>,
    pub pdf_url: Option<String>,
    pub excerpt_triage_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchBundle {
    pub query: String,
    pub effective_query: String,
    pub scope: WebSearchScope,
    pub providers_queried: Vec<String>,
    pub provider_errors: Vec<String>,
    pub hits: Vec<WebSearchHit>,
}

struct DomainPacer {
    locks: Mutex<HashMap<String, Arc<Semaphore>>>,
    last_hit: Mutex<HashMap<String, Instant>>,
}

impl DomainPacer {
    fn global() -> &'static Self {
        static PACER: OnceLock<DomainPacer> = OnceLock::new();
        PACER.get_or_init(|| Self {
            locks: Mutex::new(HashMap::new()),
            last_hit: Mutex::new(HashMap::new()),
        })
    }

    fn min_interval_for_host(host: &str) -> Duration {
        let lower = host.to_ascii_lowercase();
        if lower.contains("arxiv.org") {
            Duration::from_millis(3_100)
        } else if lower.contains("ebi.ac.uk") || lower.contains("europepmc.org") {
            Duration::from_millis(1_050)
        } else if lower.contains("openalex.org") {
            Duration::from_millis(200)
        } else {
            Duration::from_millis(250)
        }
    }

    async fn acquire_permit(&self, host: &str) -> tokio::sync::OwnedSemaphorePermit {
        let key = host.to_ascii_lowercase();
        let sem = {
            let mut map = self.locks.lock().await;
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(2)))
                .clone()
        };
        let permit = sem.acquire_owned().await.expect("semaphore open");
        let min_gap = Self::min_interval_for_host(&key);
        let wait_for = {
            let mut hits = self.last_hit.lock().await;
            let now = Instant::now();
            let delay = hits
                .get(&key)
                .and_then(|prev| min_gap.checked_sub(now.saturating_duration_since(*prev)));
            let next_stamp = delay.map_or(now, |d| now + d);
            hits.insert(key, next_stamp);
            delay
        };
        if let Some(d) = wait_for {
            tokio::time::sleep(d).await;
        }
        permit
    }
}

/// Unwraps known search/grounding redirect wrappers (`grounding-api-redirect`, DDG `uddg=`, etc.)
/// into the clean canonical destination URL when present.
#[must_use]
pub fn unwrap_redirect_url(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    let Ok(parsed) = reqwest::Url::parse(trimmed) else {
        return trimmed.to_owned();
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host.ends_with("duckduckgo.com") || host.contains("google.com") {
        for (k, v) in parsed.query_pairs() {
            if matches!(k.as_ref(), "uddg" | "url" | "q" | "u")
                && (v.starts_with("http://") || v.starts_with("https://"))
            {
                return v.into_owned();
            }
        }
    }
    trimmed.to_owned()
}

/// Extracts lowercase hostname from an HTTP(S) URL.
#[must_use]
pub fn url_domain(raw_url: &str) -> String {
    reqwest::Url::parse(raw_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

/// Detects anti-bot CAPTCHA/Turnstile/Cloudflare challenges and login walls honestly without bypass.
#[must_use]
pub fn detect_web_challenge(
    status: u16,
    final_url: &str,
    body_sample: &str,
) -> Option<(WebSourceErrorKind, &'static str)> {
    let lower_url = final_url.to_ascii_lowercase();
    let sample = &body_sample[..body_sample.len().min(12_000)];
    let lower = sample.to_ascii_lowercase();

    if status == 429 {
        return Some((
            WebSourceErrorKind::RateLimited {
                retry_after_secs: 30,
            },
            "HTTP 429 Too Many Requests",
        ));
    }
    if status == 401 || status == 407 {
        return Some((WebSourceErrorKind::NeedLogin, "HTTP 401/407 authentication required"));
    }
    if lower_url.contains("google.com/sorry")
        || lower.contains("cf-turnstile")
        || lower.contains("challenges.cloudflare.com")
        || lower.contains("just a moment...")
        || lower.contains("verify you are human")
        || lower.contains("g-recaptcha")
        || lower.contains("hcaptcha.com")
        || lower.contains("enable javascript and cookies to continue")
        || (status == 403 && (lower.contains("cloudflare") || lower.contains("attention required")))
    {
        return Some((
            WebSourceErrorKind::PlatformBlocked,
            "Anti-bot/CAPTCHA challenge detected — non-bypass policy active",
        ));
    }
    if status == 403
        || lower_url.contains("/login")
        || lower_url.contains("/signin")
        || lower_url.contains("accounts.google.com/servicelogin")
    {
        return Some((
            WebSourceErrorKind::NeedLogin,
            "Authentication or login wall required — non-bypass policy active",
        ));
    }
    if status == 404 {
        return Some((WebSourceErrorKind::NotFound, "HTTP 404 Not Found"));
    }
    if status >= 500 {
        return Some((WebSourceErrorKind::UpstreamBroken, "Upstream HTTP 5xx error"));
    }
    None
}

/// Fetches a public URL after strict SSRF + DNS non-private IP validation and returns rich
/// Markdown, metadata, BLAKE3 hash, and honest non-bypass challenge classification.
pub async fn web_fetch_structured(
    url: &str,
    raw: bool,
    max_chars: usize,
) -> Result<StructuredWebFetch> {
    let unwrapped = unwrap_redirect_url(url);
    let policy = EgressPolicy::public_web();
    let (target, _addrs) = validate_egress_url_with_dns(&unwrapped, &policy)
        .map_err(|e| anyhow::anyhow!("SSRF/egress blocked `{unwrapped}`: {e}"))?;

    let host = url_domain(&target.normalized_url);
    let _permit = DomainPacer::global().acquire_permit(&host).await;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            if validate_egress_url_with_dns(attempt.url().as_str(), &EgressPolicy::public_web())
                .is_err()
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent(USER_AGENT_STRING)
        .build()?;

    let resp = client
        .get(&target.normalized_url)
        .send()
        .await
        .with_context(|| format!("fetch {}", target.normalized_url))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().as_str().to_owned();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = resp.bytes().await?;
    let clipped = if bytes.len() > DEFAULT_FETCH_MAX_BYTES {
        &bytes[..DEFAULT_FETCH_MAX_BYTES]
    } else {
        &bytes[..]
    };
    let raw_str = String::from_utf8_lossy(clipped).into_owned();
    let mut challenge = detect_web_challenge(status, &final_url, &raw_str);
    if let Some((WebSourceErrorKind::RateLimited { retry_after_secs }, _)) = challenge.as_mut() {
        if let Some(ra) = retry_after {
            *retry_after_secs = ra.clamp(1, 300);
        }
    }

    let is_html = ct.to_ascii_lowercase().contains("text/html")
        || ct.to_ascii_lowercase().contains("application/xhtml");
    let (title, canonical_meta, published_at) = if is_html {
        extract_html_metadata(&raw_str)
    } else {
        (String::new(), None, None)
    };
    let canonical_url = canonical_meta
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .unwrap_or_else(|| final_url.clone());

    let extracted = if !raw && is_html {
        extract_html_to_markdown(&raw_str)
    } else {
        raw_str.clone()
    };
    let limit = max_chars.clamp(256, 64_000);
    let (body, truncated) = if extracted.chars().count() > limit {
        (extracted.chars().take(limit).collect::<String>(), true)
    } else {
        (extracted, bytes.len() > DEFAULT_FETCH_MAX_BYTES)
    };
    let wrapped = sanitize_untrusted_text(&body, "web_fetch");
    let digest = blake3::hash(wrapped.cleaned.as_bytes()).to_hex().to_string();

    let (source_stage, error_kind, note) = match challenge {
        Some((WebSourceErrorKind::PlatformBlocked, msg)) => (
            "blocked".to_owned(),
            Some(WebSourceErrorKind::PlatformBlocked),
            Some(msg.to_owned()),
        ),
        Some((WebSourceErrorKind::NeedLogin, msg)) => (
            "auth_required".to_owned(),
            Some(WebSourceErrorKind::NeedLogin),
            Some(msg.to_owned()),
        ),
        Some((kind, msg)) => ("failed".to_owned(), Some(kind), Some(msg.to_owned())),
        None => ("extracted".to_owned(), None, None),
    };

    Ok(StructuredWebFetch {
        requested_url: target.normalized_url,
        canonical_url: canonical_url.clone(),
        domain: url_domain(&canonical_url),
        status,
        content_type: ct,
        title: if title.is_empty() {
            url_domain(&canonical_url)
        } else {
            title
        },
        published_at,
        markdown: wrapped.cleaned,
        blake3_hex: digest,
        truncated,
        source_stage,
        error_kind,
        note,
    })
}

/// Fetches a public URL after strict SSRF + DNS non-private IP validation and converts HTML -> clean text.
pub async fn web_fetch(url: &str, raw: bool, max_chars: usize) -> Result<WebFetchOutcome> {
    let structured = web_fetch_structured(url, raw, max_chars).await?;
    let text = if let Some(ref kind) = structured.error_kind {
        format!(
            "{} {} ({})\n{}",
            kind.as_tag(),
            structured.note.as_deref().unwrap_or("blocked"),
            structured.canonical_url,
            structured.markdown
        )
    } else {
        structured.markdown
    };
    Ok(WebFetchOutcome {
        url: structured.canonical_url,
        status: structured.status,
        content_type: structured.content_type,
        text,
        truncated: structured.truncated,
    })
}

/// Multi-backend parallel web & academic literature search (`Tavily`/`Exa`/`Brave` + DDG HTML SERP
/// + Wikipedia + arXiv Atom + OpenAlex Works + Europe PMC Open Access).
pub async fn web_search_multi(opts: &WebSearchOptions) -> Result<WebSearchBundle> {
    let base_q = opts.query.trim();
    if base_q.is_empty() {
        bail!("web_search query must not be empty");
    }
    let lim = if opts.limit == 0 {
        8
    } else {
        opts.limit.clamp(1, 20)
    };
    let mut effective_q = base_q.to_owned();
    if let Some(ref site) = opts.site {
        let s = site.trim().trim_start_matches("site:");
        if !s.is_empty() && !effective_q.to_ascii_lowercase().contains("site:") {
            effective_q = format!("site:{s} {effective_q}");
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(18))
        .user_agent(USER_AGENT_STRING)
        .build()?;

    let mut providers_queried = Vec::new();
    let mut provider_errors = Vec::new();
    let mut all_hits: Vec<WebSearchHit> = Vec::new();

    let run_web = matches!(opts.scope, WebSearchScope::Web | WebSearchScope::All);
    let run_academic = matches!(opts.scope, WebSearchScope::Academic | WebSearchScope::All);

    if run_web {
        let mut got_primary = false;
        if let Some(tavily_key) = resolve_search_key("OMNIA_TAVILY_API_KEY", "omnia:web:tavily") {
            providers_queried.push("tavily".to_owned());
            match search_tavily(&client, &tavily_key, &effective_q, lim).await {
                Ok(hits) if !hits.is_empty() => {
                    all_hits.extend(hits);
                    got_primary = true;
                }
                Ok(_) => {}
                Err(e) => provider_errors.push(format!("tavily: {e}")),
            }
        }
        if !got_primary {
            if let Some(exa_key) = resolve_search_key("OMNIA_EXA_API_KEY", "omnia:web:exa") {
                providers_queried.push("exa".to_owned());
                match search_exa(&client, &exa_key, &effective_q, lim, opts.published_after.as_deref()).await {
                    Ok(hits) if !hits.is_empty() => {
                        all_hits.extend(hits);
                        got_primary = true;
                    }
                    Ok(_) => {}
                    Err(e) => provider_errors.push(format!("exa: {e}")),
                }
            }
        }
        if !got_primary {
            if let Some(brave_key) = resolve_search_key("OMNIA_BRAVE_API_KEY", "omnia:web:brave") {
                providers_queried.push("brave".to_owned());
                match search_brave(&client, &brave_key, &effective_q, lim).await {
                    Ok(hits) if !hits.is_empty() => {
                        all_hits.extend(hits);
                        got_primary = true;
                    }
                    Ok(_) => {}
                    Err(e) => provider_errors.push(format!("brave: {e}")),
                }
            }
        }
        if !got_primary {
            providers_queried.push("duckduckgo_html".to_owned());
            providers_queried.push("wikipedia".to_owned());
            let (ddg_res, wiki_res) = tokio::join!(
                search_ddg_html_or_ia(&client, &effective_q, lim),
                search_wikipedia(&client, base_q, lim.min(5))
            );
            match ddg_res {
                Ok(h) => all_hits.extend(h),
                Err(e) => provider_errors.push(format!("duckduckgo: {e}")),
            }
            match wiki_res {
                Ok(h) => all_hits.extend(h),
                Err(e) => provider_errors.push(format!("wikipedia: {e}")),
            }
        }
    }

    if run_academic {
        providers_queried.push("arxiv".to_owned());
        providers_queried.push("openalex".to_owned());
        providers_queried.push("europepmc".to_owned());
        let ac_lim = lim.min(6);
        let (arxiv_res, openalex_res, epmc_res) = tokio::join!(
            search_arxiv(&client, base_q, ac_lim),
            search_openalex(
                &client,
                base_q,
                ac_lim,
                opts.published_after.as_deref(),
                opts.published_before.as_deref()
            ),
            search_europepmc(&client, base_q, ac_lim)
        );
        match arxiv_res {
            Ok(h) => all_hits.extend(h),
            Err(e) => provider_errors.push(format!("arxiv: {e}")),
        }
        match openalex_res {
            Ok(h) => all_hits.extend(h),
            Err(e) => provider_errors.push(format!("openalex: {e}")),
        }
        match epmc_res {
            Ok(h) => all_hits.extend(h),
            Err(e) => provider_errors.push(format!("europepmc: {e}")),
        }
    }

    // Deduplicate by canonical URL preserving provider priority order.
    let mut seen_urls = BTreeSet::new();
    let mut deduped = Vec::new();
    for hit in all_hits {
        let key = hit.canonical_url.trim().to_ascii_lowercase();
        if key.is_empty() || !seen_urls.insert(key) {
            continue;
        }
        deduped.push(hit);
        if deduped.len() >= lim * 2 {
            break;
        }
    }

    Ok(WebSearchBundle {
        query: base_q.to_owned(),
        effective_query: effective_q,
        scope: opts.scope,
        providers_queried,
        provider_errors,
        hits: deduped,
    })
}

/// Parallel multi-query wave fan-out (deduplicating URLs across all sub-queries).
pub async fn web_search_wave(
    queries: &[String],
    limit_per_query: usize,
    scope: WebSearchScope,
    site: Option<&str>,
) -> Result<Vec<WebSearchBundle>> {
    let futs = queries.iter().take(6).map(|q| {
        let opts = WebSearchOptions {
            query: q.clone(),
            limit: limit_per_query,
            scope,
            site: site.map(str::to_owned),
            ..Default::default()
        };
        async move { web_search_multi(&opts).await }
    });
    let results = join_all(futs).await;
    let bundles: Vec<WebSearchBundle> = results.into_iter().flatten().collect();
    Ok(bundles)
}

/// Runs a web search using configured Tavily/Exa/Brave credentials or public DDG HTML + Wikipedia fallback.
pub async fn web_search(query: &str, limit: usize) -> Result<Value> {
    let bundle = web_search_multi(&WebSearchOptions {
        query: query.to_owned(),
        limit,
        scope: WebSearchScope::Web,
        ..Default::default()
    })
    .await?;
    Ok(json!({
        "provider": bundle.providers_queried.join("+"),
        "query": bundle.query,
        "effectiveQuery": bundle.effective_query,
        "providerErrors": bundle.provider_errors,
        "results": bundle.hits,
    }))
}

async fn search_tavily(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global().acquire_permit("api.tavily.com").await;
    let resp = client
        .post("https://api.tavily.com/search")
        .json(&json!({
            "api_key": api_key,
            "query": query,
            "max_results": limit,
        }))
        .send()
        .await?;
    let status = resp.status();
    let body: Value = resp.json().await?;
    if !status.is_success() {
        bail!("Tavily HTTP {status}");
    }
    let mut out = Vec::new();
    if let Some(arr) = body.get("results").and_then(Value::as_array) {
        for item in arr.iter().take(limit) {
            let raw_u = item.get("url").and_then(Value::as_str).unwrap_or("");
            let canon = unwrap_redirect_url(raw_u);
            if canon.is_empty() {
                continue;
            }
            out.push(WebSearchHit {
                provider: "tavily".to_owned(),
                source_kind: "web".to_owned(),
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(query)
                    .to_owned(),
                url: raw_u.to_owned(),
                canonical_url: canon.clone(),
                domain: url_domain(&canon),
                snippet: sanitize_untrusted_text(
                    item.get("content").and_then(Value::as_str).unwrap_or(""),
                    "tavily",
                )
                .cleaned,
                published_at: item
                    .get("published_date")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                authors: Vec::new(),
                doi: None,
                cited_by_count: None,
                pdf_url: None,
                excerpt_triage_only: true,
            });
        }
    }
    Ok(out)
}

async fn search_exa(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    limit: usize,
    published_after: Option<&str>,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global().acquire_permit("api.exa.ai").await;
    let mut payload = json!({ "query": query, "numResults": limit });
    if let Some(after) = published_after {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("startPublishedDate".to_owned(), json!(after));
        }
    }
    let resp = client
        .post("https://api.exa.ai/search")
        .header("x-api-key", api_key)
        .json(&payload)
        .send()
        .await?;
    let status = resp.status();
    let body: Value = resp.json().await?;
    if !status.is_success() {
        bail!("Exa HTTP {status}");
    }
    let mut out = Vec::new();
    if let Some(arr) = body.get("results").and_then(Value::as_array) {
        for item in arr.iter().take(limit) {
            let raw_u = item.get("url").and_then(Value::as_str).unwrap_or("");
            let canon = unwrap_redirect_url(raw_u);
            if canon.is_empty() {
                continue;
            }
            out.push(WebSearchHit {
                provider: "exa".to_owned(),
                source_kind: "web".to_owned(),
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(query)
                    .to_owned(),
                url: raw_u.to_owned(),
                canonical_url: canon.clone(),
                domain: url_domain(&canon),
                snippet: sanitize_untrusted_text(
                    item.get("text")
                        .or_else(|| item.get("snippet"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    "exa",
                )
                .cleaned,
                published_at: item
                    .get("publishedDate")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                authors: Vec::new(),
                doi: None,
                cited_by_count: None,
                pdf_url: None,
                excerpt_triage_only: true,
            });
        }
    }
    Ok(out)
}

async fn search_brave(
    client: &reqwest::Client,
    api_key: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global()
        .acquire_permit("api.search.brave.com")
        .await;
    let mut url = reqwest::Url::parse("https://api.search.brave.com/res/v1/web/search")?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("count", &limit.to_string());
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await?;
    let status = resp.status();
    let body: Value = resp.json().await?;
    if !status.is_success() {
        bail!("Brave Search HTTP {status}");
    }
    let mut out = Vec::new();
    if let Some(arr) = body
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(Value::as_array)
    {
        for item in arr.iter().take(limit) {
            let raw_u = item.get("url").and_then(Value::as_str).unwrap_or("");
            let canon = unwrap_redirect_url(raw_u);
            if canon.is_empty() {
                continue;
            }
            out.push(WebSearchHit {
                provider: "brave".to_owned(),
                source_kind: "web".to_owned(),
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(query)
                    .to_owned(),
                url: raw_u.to_owned(),
                canonical_url: canon.clone(),
                domain: url_domain(&canon),
                snippet: sanitize_untrusted_text(
                    item.get("description").and_then(Value::as_str).unwrap_or(""),
                    "brave",
                )
                .cleaned,
                published_at: item
                    .get("age")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                authors: Vec::new(),
                doi: None,
                cited_by_count: None,
                pdf_url: None,
                excerpt_triage_only: true,
            });
        }
    }
    Ok(out)
}

async fn search_ddg_html_or_ia(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global()
        .acquire_permit("html.duckduckgo.com")
        .await;
    let mut html_url = reqwest::Url::parse("https://html.duckduckgo.com/html/")?;
    html_url.query_pairs_mut().append_pair("q", query);
    if let Ok(resp) = client.get(html_url).send().await {
        if resp.status().is_success() {
            if let Ok(body) = resp.text().await {
                let parsed = parse_ddg_html_results(&body, limit);
                if !parsed.is_empty() {
                    return Ok(parsed);
                }
            }
        }
    }

    // Fallback to DuckDuckGo Instant Answer JSON API
    let mut ia_url = reqwest::Url::parse("https://api.duckduckgo.com/")?;
    ia_url
        .query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "json")
        .append_pair("no_html", "1")
        .append_pair("skip_disambig", "1");
    let resp = client.get(ia_url).send().await?;
    let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    let mut out = Vec::new();
    if let Some(abs) = body
        .get("AbstractText")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let u = body.get("AbstractURL").and_then(Value::as_str).unwrap_or("");
        if !u.is_empty() {
            let canon = unwrap_redirect_url(u);
            out.push(WebSearchHit {
                provider: "duckduckgo_ia".to_owned(),
                source_kind: "web".to_owned(),
                title: body
                    .get("Heading")
                    .and_then(Value::as_str)
                    .unwrap_or(query)
                    .to_owned(),
                url: u.to_owned(),
                canonical_url: canon.clone(),
                domain: url_domain(&canon),
                snippet: sanitize_untrusted_text(abs, "ddg").cleaned,
                published_at: None,
                authors: Vec::new(),
                doi: None,
                cited_by_count: None,
                pdf_url: None,
                excerpt_triage_only: true,
            });
        }
    }
    if let Some(rel) = body.get("RelatedTopics").and_then(Value::as_array) {
        for item in rel.iter().take(limit) {
            if let (Some(txt), Some(first_url)) = (
                item.get("Text").and_then(Value::as_str),
                item.get("FirstURL").and_then(Value::as_str),
            ) {
                let canon = unwrap_redirect_url(first_url);
                out.push(WebSearchHit {
                    provider: "duckduckgo_ia".to_owned(),
                    source_kind: "web".to_owned(),
                    title: txt.chars().take(80).collect(),
                    url: first_url.to_owned(),
                    canonical_url: canon.clone(),
                    domain: url_domain(&canon),
                    snippet: sanitize_untrusted_text(txt, "ddg").cleaned,
                    published_at: None,
                    authors: Vec::new(),
                    doi: None,
                    cited_by_count: None,
                    pdf_url: None,
                    excerpt_triage_only: true,
                });
            }
        }
    }
    Ok(out)
}

/// Deterministic parser for DuckDuckGo HTML SERP (`result__a` + `result__snippet`).
#[must_use]
pub fn parse_ddg_html_results(html: &str, limit: usize) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit {
        let Some(pos) = html[cursor..].find("result__a") else {
            break;
        };
        let tag_start = html[..cursor + pos].rfind('<').unwrap_or(cursor + pos);
        let Some(gt_rel) = html[tag_start..].find('>') else {
            break;
        };
        let open_tag = &html[tag_start..tag_start + gt_rel];
        let after_open = tag_start + gt_rel + 1;
        let Some(close_rel) = html[after_open..].find("</a>") else {
            cursor = after_open;
            continue;
        };
        let raw_title = decode_html_entities(&strip_tags_inline(&html[after_open..after_open + close_rel]));
        let raw_href = extract_attr(open_tag, "href").unwrap_or_default();
        let fixed_href = if raw_href.starts_with("//") {
            format!("https:{raw_href}")
        } else {
            raw_href
        };
        let canon = unwrap_redirect_url(&fixed_href);

        // Find optional snippet before next result__a
        let next_window_end = html[after_open + close_rel..]
            .find("result__a")
            .map_or(html.len(), |n| after_open + close_rel + n);
        let slice = &html[after_open + close_rel..next_window_end];
        let snippet = if let Some(sp) = slice.find("result__snippet") {
            if let Some(sgt) = slice[sp..].find('>') {
                let s_body = &slice[sp + sgt + 1..];
                let s_end = s_body
                    .find("</a>")
                    .or_else(|| s_body.find("</div>"))
                    .or_else(|| s_body.find("</span>"))
                    .unwrap_or_else(|| s_body.len().min(400));
                decode_html_entities(&strip_tags_inline(&s_body[..s_end]))
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        cursor = after_open + close_rel + 4;
        if (canon.starts_with("http://") || canon.starts_with("https://"))
            && !raw_title.trim().is_empty()
        {
            hits.push(WebSearchHit {
                provider: "duckduckgo_html".to_owned(),
                source_kind: "web".to_owned(),
                title: raw_title.trim().to_owned(),
                url: fixed_href,
                canonical_url: canon.clone(),
                domain: url_domain(&canon),
                snippet: sanitize_untrusted_text(snippet.trim(), "ddg_html").cleaned,
                published_at: None,
                authors: Vec::new(),
                doi: None,
                cited_by_count: None,
                pdf_url: None,
                excerpt_triage_only: true,
            });
        }
    }
    hits
}

async fn search_wikipedia(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global()
        .acquire_permit("en.wikipedia.org")
        .await;
    let mut url = reqwest::Url::parse("https://en.wikipedia.org/w/api.php")?;
    url.query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("list", "search")
        .append_pair("srsearch", query)
        .append_pair("srlimit", &limit.to_string())
        .append_pair("format", "json")
        .append_pair("utf8", "1");
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        bail!("Wikipedia HTTP {}", resp.status());
    }
    let body: Value = resp.json().await?;
    let mut out = Vec::new();
    if let Some(arr) = body
        .get("query")
        .and_then(|q| q.get("search"))
        .and_then(Value::as_array)
    {
        for item in arr.iter().take(limit) {
            let title = item.get("title").and_then(Value::as_str).unwrap_or("");
            if title.is_empty() {
                continue;
            }
            let slug = title.replace(' ', "_");
            let u = format!("https://en.wikipedia.org/wiki/{slug}");
            let snip = decode_html_entities(&strip_tags_inline(
                item.get("snippet").and_then(Value::as_str).unwrap_or(""),
            ));
            out.push(WebSearchHit {
                provider: "wikipedia".to_owned(),
                source_kind: "web".to_owned(),
                title: title.to_owned(),
                url: u.clone(),
                canonical_url: u,
                domain: "en.wikipedia.org".to_owned(),
                snippet: sanitize_untrusted_text(&snip, "wikipedia").cleaned,
                published_at: item
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                authors: Vec::new(),
                doi: None,
                cited_by_count: None,
                pdf_url: None,
                excerpt_triage_only: true,
            });
        }
    }
    Ok(out)
}

async fn search_arxiv(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global()
        .acquire_permit("export.arxiv.org")
        .await;
    let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query")?;
    url.query_pairs_mut()
        .append_pair("search_query", &format!("all:{query}"))
        .append_pair("start", "0")
        .append_pair("max_results", &limit.to_string())
        .append_pair("sortBy", "relevance");
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        bail!("arXiv HTTP {}", resp.status());
    }
    let xml = resp.text().await?;
    Ok(parse_arxiv_atom(&xml, limit))
}

/// Deterministic zero-dependency Atom XML parser for arXiv API responses.
#[must_use]
pub fn parse_arxiv_atom(xml: &str, limit: usize) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let mut cursor = 0usize;
    while hits.len() < limit {
        let Some(start_rel) = xml[cursor..].find("<entry>") else {
            break;
        };
        let entry_start = cursor + start_rel + 7;
        let Some(end_rel) = xml[entry_start..].find("</entry>") else {
            break;
        };
        let entry = &xml[entry_start..entry_start + end_rel];
        cursor = entry_start + end_rel + 8;

        let id_url = extract_xml_tag(entry, "id").unwrap_or_default();
        let title = normalize_ws(&decode_html_entities(
            &extract_xml_tag(entry, "title").unwrap_or_default(),
        ));
        let summary = normalize_ws(&decode_html_entities(
            &extract_xml_tag(entry, "summary").unwrap_or_default(),
        ));
        let published = extract_xml_tag(entry, "published");
        let doi = extract_xml_tag(entry, "arxiv:doi");
        let mut authors = Vec::new();
        let mut a_cur = 0usize;
        while let Some(ap) = entry[a_cur..].find("<author>") {
            let as_idx = a_cur + ap + 8;
            if let Some(ae) = entry[as_idx..].find("</author>") {
                if let Some(name) = extract_xml_tag(&entry[as_idx..as_idx + ae], "name") {
                    authors.push(normalize_ws(&name));
                }
                a_cur = as_idx + ae + 9;
            } else {
                break;
            }
        }
        let canon = id_url.trim().to_owned();
        if canon.is_empty() || title.is_empty() {
            continue;
        }
        let pdf_url = canon
            .replace("/abs/", "/pdf/")
            .trim_end_matches('/')
            .to_owned();
        hits.push(WebSearchHit {
            provider: "arxiv".to_owned(),
            source_kind: "academic".to_owned(),
            title,
            url: canon.clone(),
            canonical_url: canon.clone(),
            domain: url_domain(&canon),
            snippet: sanitize_untrusted_text(&summary, "arxiv").cleaned,
            published_at: published,
            authors,
            doi,
            cited_by_count: None,
            pdf_url: Some(pdf_url),
            excerpt_triage_only: true,
        });
    }
    hits
}

async fn search_openalex(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    published_after: Option<&str>,
    published_before: Option<&str>,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global()
        .acquire_permit("api.openalex.org")
        .await;
    let mut url = reqwest::Url::parse("https://api.openalex.org/works")?;
    let mut filters = Vec::new();
    if let Some(after) = published_after.filter(|s| !s.trim().is_empty()) {
        filters.push(format!("from_publication_date:{}", after.trim()));
    }
    if let Some(before) = published_before.filter(|s| !s.trim().is_empty()) {
        filters.push(format!("to_publication_date:{}", before.trim()));
    }
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("search", query)
            .append_pair("per-page", &limit.to_string())
            .append_pair(
                "select",
                "id,doi,display_name,publication_date,cited_by_count,open_access,authorships,primary_location",
            );
        if !filters.is_empty() {
            qp.append_pair("filter", &filters.join(","));
        }
        if let Some(key) = resolve_search_key("OPENALEX_API_KEY", "omnia:web:openalex") {
            qp.append_pair("api_key", &key);
        }
    }
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        bail!("OpenAlex HTTP {}", resp.status());
    }
    let body: Value = resp.json().await?;
    Ok(parse_openalex_works(&body, limit))
}

/// Deterministic parser for OpenAlex `/works` JSON responses.
#[must_use]
pub fn parse_openalex_works(body: &Value, limit: usize) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let Some(arr) = body.get("results").and_then(Value::as_array) else {
        return hits;
    };
    for item in arr.iter().take(limit) {
        let title = item
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let doi = item
            .get("doi")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let oa_url = item
            .get("open_access")
            .and_then(|o| o.get("oa_url"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let landing = item
            .get("primary_location")
            .and_then(|p| p.get("landing_page_url"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let work_url = landing
            .or_else(|| doi.clone())
            .or_else(|| item.get("id").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        if title.is_empty() || work_url.is_empty() {
            continue;
        }
        let authors: Vec<String> = item
            .get("authorships")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|au| {
                        au.get("author")
                            .and_then(|x| x.get("display_name"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .take(6)
                    .collect()
            })
            .unwrap_or_default();
        let cited = item.get("cited_by_count").and_then(Value::as_u64);
        let pub_date = item
            .get("publication_date")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let snippet = format!(
            "{} | cited_by={} | oa={}",
            authors.join(", "),
            cited.unwrap_or(0),
            oa_url.as_deref().unwrap_or("none")
        );
        hits.push(WebSearchHit {
            provider: "openalex".to_owned(),
            source_kind: "academic".to_owned(),
            title: title.to_owned(),
            url: work_url.clone(),
            canonical_url: work_url.clone(),
            domain: url_domain(&work_url),
            snippet: sanitize_untrusted_text(&snippet, "openalex").cleaned,
            published_at: pub_date,
            authors,
            doi,
            cited_by_count: cited,
            pdf_url: oa_url,
            excerpt_triage_only: true,
        });
    }
    hits
}

async fn search_europepmc(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebSearchHit>> {
    let _p = DomainPacer::global()
        .acquire_permit("www.ebi.ac.uk")
        .await;
    let mut url = reqwest::Url::parse("https://www.ebi.ac.uk/europepmc/webservices/rest/search")?;
    // Enforce open-access-only policy matching `literature-search-europepmc` skill contract.
    let oa_query = format!("({query}) AND OPEN_ACCESS:y");
    url.query_pairs_mut()
        .append_pair("query", &oa_query)
        .append_pair("format", "json")
        .append_pair("resultType", "core")
        .append_pair("pageSize", &limit.to_string());
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        bail!("Europe PMC HTTP {}", resp.status());
    }
    let body: Value = resp.json().await?;
    Ok(parse_europepmc_results(&body, limit))
}

/// Deterministic parser for Europe PMC REST JSON responses (`OPEN_ACCESS:y`).
#[must_use]
pub fn parse_europepmc_results(body: &Value, limit: usize) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let Some(arr) = body
        .get("resultList")
        .and_then(|r| r.get("result"))
        .and_then(Value::as_array)
    else {
        return hits;
    };
    for item in arr.iter().take(limit) {
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let pmcid = item.get("pmcid").and_then(Value::as_str);
        let pmid = item.get("pmid").and_then(Value::as_str);
        let doi = item.get("doi").and_then(Value::as_str).map(str::to_owned);
        let url = if let Some(pmc) = pmcid {
            format!("https://europepmc.org/article/PMC/{pmc}")
        } else if let Some(pm) = pmid {
            format!("https://europepmc.org/article/MED/{pm}")
        } else if let Some(ref d) = doi {
            format!("https://doi.org/{d}")
        } else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        let abstract_txt = item
            .get("abstractText")
            .and_then(Value::as_str)
            .unwrap_or("");
        let authors: Vec<String> = item
            .get("authorString")
            .and_then(Value::as_str)
            .map(|s| {
                s.split(',')
                    .map(|a| a.trim().to_owned())
                    .filter(|a| !a.is_empty())
                    .take(6)
                    .collect()
            })
            .unwrap_or_default();
        let cited = item.get("citedByCount").and_then(Value::as_u64);
        let pub_date = item
            .get("firstPublicationDate")
            .or_else(|| item.get("pubYear"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let pdf_url = pmcid.map(|pmc| {
            format!("https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmc}&blobtype=pdf")
        });
        hits.push(WebSearchHit {
            provider: "europepmc".to_owned(),
            source_kind: "academic".to_owned(),
            title: title.to_owned(),
            url: url.clone(),
            canonical_url: url.clone(),
            domain: url_domain(&url),
            snippet: sanitize_untrusted_text(abstract_txt, "europepmc").cleaned,
            published_at: pub_date,
            authors,
            doi,
            cited_by_count: cited,
            pdf_url,
            excerpt_triage_only: true,
        });
    }
    hits
}

fn resolve_search_key(env_name: &str, cred_target: &str) -> Option<String> {
    if let Ok(v) = std::env::var(env_name) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_owned());
        }
    }
    if let Ok(Some(sec)) = omnia_core::credentials::CredentialStore::resolve_secret(cred_target) {
        if let Ok(v) = sec.expose_for_wire() {
            if !v.trim().is_empty() {
                return Some(v.trim().to_owned());
            }
        }
    }
    None
}

struct LiveBrowserEntry {
    handle: Option<IsolatedBrowserHandle>,
    cdp: Arc<CdpSession>,
    last_screenshot_b64: Option<String>,
}

/// Session manager for isolated agentic CDP browsers (never touches user's live Thorium).
#[derive(Clone, Default)]
pub struct BrowserToolManager {
    sessions: Arc<Mutex<HashMap<String, LiveBrowserEntry>>>,
}

impl std::fmt::Debug for BrowserToolManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserToolManager").finish()
    }
}

impl BrowserToolManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn launch(&self, headless: bool, initial_url: Option<String>) -> Result<Value> {
        if let Some(ref u) = initial_url {
            validate_browser_target_url(u)?;
        }
        let opts = IsolatedBrowserLaunchOptions {
            headless,
            initial_url,
            ..Default::default()
        };
        let handle = launch_isolated_browser(opts)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        let cdp = CdpSession::connect(&handle.ws_browser_url)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        let sid = format!("browser-{}", BROWSER_SID_SEQ.fetch_add(1, Ordering::Relaxed));
        let info = json!({
            "session_id": sid,
            "pid": handle.pid,
            "debug_port": handle.debug_port,
            "user_data_dir": handle.user_data_dir.to_string_lossy(),
            "ws_browser_url": handle.ws_browser_url,
        });
        self.sessions.lock().await.insert(
            sid,
            LiveBrowserEntry {
                handle: Some(handle),
                cdp,
                last_screenshot_b64: None,
            },
        );
        Ok(info)
    }

    pub async fn navigate(&self, session_id: &str, url: &str) -> Result<Value> {
        validate_browser_target_url(url)?;
        let cdp = self.get_cdp(session_id).await?;
        cdp.navigate(url).await.map_err(|e| anyhow::anyhow!(e))?;
        cdp.snapshot_dom_summary()
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    pub async fn click(
        &self,
        session_id: &str,
        selector: Option<&str>,
        x: Option<f64>,
        y: Option<f64>,
    ) -> Result<Value> {
        let cdp = self.get_cdp(session_id).await?;
        if let Some(sel) = selector {
            cdp.click_selector(sel)
                .await
                .map_err(|e| anyhow::anyhow!(e))
        } else if let (Some(px), Some(py)) = (x, y) {
            cdp.click_at(px, py, Some("agent click"))
                .await
                .map_err(|e| anyhow::anyhow!(e))
        } else {
            bail!("browser click requires either `selector` or (`x`, `y`)");
        }
    }

    pub async fn type_text(&self, session_id: &str, text: &str) -> Result<Value> {
        let cdp = self.get_cdp(session_id).await?;
        cdp.type_text(text).await.map_err(|e| anyhow::anyhow!(e))
    }

    pub async fn eval_js(&self, session_id: &str, expression: &str) -> Result<Value> {
        let cdp = self.get_cdp(session_id).await?;
        cdp.eval_js(expression)
            .await
            .map_err(|e| anyhow::anyhow!(e))
    }

    pub async fn screenshot(&self, session_id: &str) -> Result<String> {
        let cdp = self.get_cdp(session_id).await?;
        let b64 = cdp
            .screenshot_png_base64()
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        if let Some(entry) = self.sessions.lock().await.get_mut(session_id) {
            entry.last_screenshot_b64 = Some(b64.clone());
        }
        Ok(b64)
    }

    pub async fn close(&self, session_id: &str) -> bool {
        if let Some(entry) = self.sessions.lock().await.remove(session_id) {
            entry.cdp.close().await;
            if let Some(h) = entry.handle {
                h.shutdown();
            }
            true
        } else {
            false
        }
    }

    async fn get_cdp(&self, session_id: &str) -> Result<Arc<CdpSession>> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|e| Arc::clone(&e.cdp))
            .ok_or_else(|| anyhow::anyhow!("unknown browser session `{session_id}`"))
    }
}

fn validate_browser_target_url(url: &str) -> Result<()> {
    let trimmed = url.trim();
    if trimmed == "about:blank" || trimmed.starts_with("data:text/html") {
        return Ok(());
    }
    let policy = EgressPolicy {
        mode: omnia_workspace_ops::egress::EgressMode::PublicAndLoopback,
        verify_dns_non_private: false,
        ..EgressPolicy::default()
    };
    validate_egress_url_with_dns(trimmed, &policy)
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!("browser URL blocked by policy `{trimmed}`: {e}"))
}

fn extract_html_metadata(html: &str) -> (String, Option<String>, Option<String>) {
    let lower = html.to_ascii_lowercase();
    let title = if let Some(ts) = lower.find("<title") {
        if let Some(gt) = lower[ts..].find('>') {
            let body_start = ts + gt + 1;
            lower[body_start..]
                .find("</title>")
                .map(|te| normalize_ws(&decode_html_entities(&html[body_start..body_start + te])))
                .unwrap_or_default()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let mut canonical = None;
    let mut published = None;
    let mut cur = 0usize;
    while let Some(pos) = lower[cur..].find('<') {
        let start = cur + pos;
        let Some(gt) = html[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + gt + 1];
        let tag_l = &lower[start..start + gt + 1];
        if tag_l.starts_with("<link") && tag_l.contains("canonical") {
            if let Some(href) = extract_attr(tag, "href") {
                canonical = Some(href);
            }
        } else if tag_l.starts_with("<meta")
            && (tag_l.contains("article:published_time")
                || tag_l.contains("pubdate")
                || tag_l.contains("datepublished")
                || tag_l.contains("dc.date"))
        {
            if let Some(c) = extract_attr(tag, "content") {
                if !c.trim().is_empty() {
                    published = Some(c);
                }
            }
        }
        cur = start + gt + 1;
        if cur > 64_000 {
            break;
        }
    }
    (title, canonical, published)
}

/// Converts HTML into heading/list/code-preserving Markdown preferring `<article>`/`<main>` content.
#[must_use]
pub fn extract_html_to_markdown(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let focused = extract_primary_region(html, &lower);
    let f_lower = focused.to_ascii_lowercase();

    let mut out = String::with_capacity(focused.len());
    let mut i = 0usize;
    let mut in_pre = false;
    while i < focused.len() {
        let rest_l = &f_lower[i..];
        let mut skipped = false;
        for tag in ["<script", "<style", "<noscript", "<svg", "<nav", "<footer", "<aside"] {
            if rest_l.starts_with(tag) {
                let end_tag = format!("</{}>", &tag[1..]);
                if let Some(rel_end) = rest_l.find(&end_tag) {
                    i += rel_end + end_tag.len();
                    out.push('\n');
                    skipped = true;
                    break;
                }
            }
        }
        if skipped {
            continue;
        }
        if let Some(ch) = focused[i..].chars().next() {
            if ch == '<' {
                if let Some(rel_gt) = focused[i..].find('>') {
                    let tb = f_lower[i + 1..i + rel_gt].trim();
                    let tag_name = tb
                        .split(|c: char| c.is_ascii_whitespace() || c == '/')
                        .next()
                        .unwrap_or("");
                    if tb.starts_with("h1") {
                        out.push_str("\n# ");
                    } else if tb.starts_with("h2") {
                        out.push_str("\n## ");
                    } else if tb.starts_with("h3") {
                        out.push_str("\n### ");
                    } else if tb.starts_with("h4") {
                        out.push_str("\n#### ");
                    } else if tb.starts_with("li") {
                        out.push_str("\n- ");
                    } else if tb.starts_with("pre") {
                        in_pre = true;
                        out.push_str("\n```\n");
                    } else if tb.starts_with("/pre") {
                        in_pre = false;
                        out.push_str("\n```\n");
                    } else if (tb.starts_with("code") || tb.starts_with("/code")) && !in_pre {
                        out.push('`');
                    } else if tb.starts_with("td") || tb.starts_with("th") {
                        out.push_str(" | ");
                    } else if matches!(
                        tag_name,
                        "p" | "br" | "tr" | "blockquote" | "section" | "article" | "div"
                    ) || tb.starts_with("/p")
                        || tb.starts_with("/h")
                        || tb.starts_with("/tr")
                        || tb.starts_with("/li")
                        || tb.starts_with("/div")
                    {
                        out.push('\n');
                    } else {
                        out.push(' ');
                    }
                    i += rel_gt + 1;
                    continue;
                }
            }
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }

    let decoded = decode_html_entities(&out);
    let mut clean_lines = Vec::new();
    let mut in_fence = false;
    for raw_line in decoded.lines() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            clean_lines.push(trimmed.to_owned());
            continue;
        }
        if in_fence {
            clean_lines.push(raw_line.trim_end().to_owned());
            continue;
        }
        let collapsed = normalize_ws(trimmed);
        if !collapsed.is_empty() {
            clean_lines.push(collapsed);
        }
    }
    clean_lines.join("\n")
}

fn extract_primary_region<'a>(html: &'a str, lower: &str) -> &'a str {
    for tag in ["<article", "<main"] {
        if let Some(start) = lower.find(tag) {
            let close = format!("</{}>", &tag[1..]);
            if let Some(end_rel) = lower[start..].rfind(&close) {
                let slice = &html[start..start + end_rel + close.len()];
                if slice.len() >= 120 {
                    return slice;
                }
            }
        }
    }
    html
}

/// Strips script/style blocks and HTML tags into readable plain lines without executing scripts.
#[must_use]
pub fn strip_html_to_readable_text(html: &str) -> String {
    extract_html_to_markdown(html)
}

fn strip_tags_inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    normalize_ws(&out)
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let pos = lower.find(&needle)?;
    let rest = tag[pos + needle.len()..].trim_start();
    if let Some(q) = rest.chars().next() {
        if q == '"' || q == '\'' {
            let inner = &rest[1..];
            let end = inner.find(q)?;
            return Some(decode_html_entities(&inner[..end]));
        }
    }
    let end = rest
        .find(|c: char| c.is_ascii_whitespace() || c == '>')
        .unwrap_or(rest.len());
    Some(decode_html_entities(&rest[..end]))
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let pos = xml.find(&open)?;
    let after_open = &xml[pos + open.len()..];
    let gt = after_open.find('>')?;
    let body = &after_open[gt + 1..];
    let end = body.find(&close)?;
    Some(body[..end].trim().to_owned())
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn web_fetch_rejects_ssrf_private_and_imds_urls() {
        assert!(web_fetch("http://169.254.169.254/latest/meta-data/", false, 2048)
            .await
            .is_err());
        assert!(web_fetch("http://127.0.0.1:9999/secret", false, 2048)
            .await
            .is_err());
        assert!(web_fetch("http://10.0.0.1/", false, 2048)
            .await
            .is_err());
    }

    #[test]
    fn html_extractor_strips_scripts_and_preserves_markdown_headings_and_code() {
        let html = "<html><head><title>Doc Title</title><style>.a{color:red}</style><script>alert(1)</script></head><body><nav>Menu</nav><article><h1>Title</h1><p>Hello &amp; world</p><ul><li>Item 1</li></ul><pre><code>fn main() {}</code></pre></article></body></html>";
        let md = extract_html_to_markdown(html);
        assert!(md.contains("# Title"));
        assert!(md.contains("Hello & world"));
        assert!(md.contains("- Item 1"));
        assert!(md.contains("fn main() {}"));
        assert!(!md.contains("alert(1)"));
        assert!(!md.contains("color:red"));
        assert!(!md.contains("Menu"));
    }

    #[test]
    fn challenge_classifier_reports_captcha_and_login_honestly_without_bypass() {
        let cf = detect_web_challenge(403, "https://example.org/doc", "<html>Just a moment... cf-turnstile</html>");
        assert_eq!(cf.as_ref().map(|(k, _)| k), Some(&WebSourceErrorKind::PlatformBlocked));
        assert!(!WebSourceErrorKind::PlatformBlocked.retry_permitted());

        let auth = detect_web_challenge(401, "https://example.org/private", "Unauthorized");
        assert_eq!(auth.as_ref().map(|(k, _)| k), Some(&WebSourceErrorKind::NeedLogin));
        assert!(!WebSourceErrorKind::NeedLogin.retry_permitted());

        assert_eq!(
            unwrap_redirect_url("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fspec"),
            "https://example.org/spec"
        );
    }

    #[test]
    fn ddg_html_and_academic_parsers_extract_structured_hits_offline() {
        let ddg_html = r#"<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Frust">Rust Guide</a><a class="result__snippet">Fast &amp; safe systems programming.</a></div>"#;
        let ddg_hits = parse_ddg_html_results(ddg_html, 5);
        assert_eq!(ddg_hits.len(), 1);
        assert_eq!(ddg_hits[0].canonical_url, "https://example.org/rust");
        assert!(ddg_hits[0].snippet.contains("Fast & safe"));

        let arxiv_xml = r#"<feed><entry><id>http://arxiv.org/abs/2601.12345v1</id><title>KV Cache Invariance</title><summary>Zero prefix drift.</summary><published>2026-01-15T00:00:00Z</published><author><name>Ada Lovelace</name></author></entry></feed>"#;
        let arxiv_hits = parse_arxiv_atom(arxiv_xml, 5);
        assert_eq!(arxiv_hits.len(), 1);
        assert_eq!(arxiv_hits[0].provider, "arxiv");
        assert_eq!(arxiv_hits[0].authors, vec!["Ada Lovelace"]);
        assert_eq!(
            arxiv_hits[0].pdf_url.as_deref(),
            Some("http://arxiv.org/pdf/2601.12345v1")
        );

        let oa_json = json!({
            "results": [{
                "id": "https://openalex.org/W123",
                "doi": "https://doi.org/10.1000/test",
                "display_name": "Graph RAG Benchmarks",
                "publication_date": "2026-03-01",
                "cited_by_count": 42,
                "open_access": { "oa_url": "https://example.org/paper.pdf" },
                "authorships": [{ "author": { "display_name": "Alan Turing" } }]
            }]
        });
        let oa_hits = parse_openalex_works(&oa_json, 5);
        assert_eq!(oa_hits.len(), 1);
        assert_eq!(oa_hits[0].cited_by_count, Some(42));
        assert_eq!(oa_hits[0].authors, vec!["Alan Turing"]);

        let epmc_json = json!({
            "resultList": {
                "result": [{
                    "title": "Open Access Biomedical Study",
                    "pmcid": "PMC9999999",
                    "doi": "10.1000/epmc",
                    "authorString": "Curie M, Franklin R",
                    "citedByCount": 19,
                    "firstPublicationDate": "2026-02-10",
                    "abstractText": "Verified open access abstract."
                }]
            }
        });
        let epmc_hits = parse_europepmc_results(&epmc_json, 5);
        assert_eq!(epmc_hits.len(), 1);
        assert_eq!(epmc_hits[0].canonical_url, "https://europepmc.org/article/PMC/PMC9999999");
        assert_eq!(epmc_hits[0].authors, vec!["Curie M", "Franklin R"]);
    }
}
