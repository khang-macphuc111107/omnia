//! Web Fetch, Web Search & Isolated CDP Browser Automation Tools (`omnia-media-capture`).
//!
//! Enforces fail-closed SSRF / DNS-rebinding egress checks (`omnia_workspace_ops::egress`),
//! HTML->text extraction wrapped in untrusted data-plane sanitization, and strictly isolated
//! headless/windowed CDP browser sessions (`D:\OmniaData\tmp\omnia-cdp-*`, zero Thorium).

use crate::sanitizer::sanitize_untrusted_text;
use anyhow::{bail, Context, Result};
use omnia_media_capture::browser_cdp::{
    launch_isolated_browser, CdpSession, IsolatedBrowserHandle, IsolatedBrowserLaunchOptions,
};
use omnia_workspace_ops::egress::{validate_egress_url_with_dns, EgressPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

const DEFAULT_FETCH_MAX_BYTES: usize = 512 * 1024;
static BROWSER_SID_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebFetchOutcome {
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub text: String,
    pub truncated: bool,
}

/// Fetches a public URL after strict SSRF + DNS non-private IP validation and converts HTML -> clean text.
pub async fn web_fetch(url: &str, raw: bool, max_chars: usize) -> Result<WebFetchOutcome> {
    let policy = EgressPolicy::public_web();
    let (target, _addrs) = validate_egress_url_with_dns(url, &policy)
        .map_err(|e| anyhow::anyhow!("SSRF/egress blocked `{url}`: {e}"))?;

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
        .user_agent("OmniaAgent/5.0")
        .build()?;

    let resp = client
        .get(&target.normalized_url)
        .send()
        .await
        .with_context(|| format!("fetch {}", target.normalized_url))?;
    let status = resp.status().as_u16();
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
    let extracted = if !raw && ct.to_ascii_lowercase().contains("text/html") {
        strip_html_to_readable_text(&raw_str)
    } else {
        raw_str
    };
    let limit = max_chars.clamp(256, 64_000);
    let (text, truncated) = if extracted.chars().count() > limit {
        (
            extracted.chars().take(limit).collect::<String>(),
            true,
        )
    } else {
        (extracted, bytes.len() > DEFAULT_FETCH_MAX_BYTES)
    };

    let wrapped = sanitize_untrusted_text(&text, "web_fetch");
    Ok(WebFetchOutcome {
        url: target.normalized_url,
        status,
        content_type: ct,
        text: wrapped.cleaned,
        truncated,
    })
}

/// Runs a web search using configured Tavily/Exa/Brave credentials or public DuckDuckGo HTML fallback.
pub async fn web_search(query: &str, limit: usize) -> Result<Value> {
    let q = query.trim();
    if q.is_empty() {
        bail!("web_search query must not be empty");
    }
    let lim = limit.clamp(1, 15);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .user_agent("OmniaAgent/5.0")
        .build()?;

    if let Some(tavily_key) = resolve_search_key("OMNIA_TAVILY_API_KEY", "omnia:web:tavily") {
        let resp = client
            .post("https://api.tavily.com/search")
            .json(&json!({
                "api_key": tavily_key,
                "query": q,
                "max_results": lim,
            }))
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await?;
        if !status.is_success() {
            bail!("Tavily search HTTP {status}");
        }
        return Ok(json!({ "provider": "tavily", "query": q, "results": body.get("results").cloned().unwrap_or(Value::Null) }));
    }

    if let Some(exa_key) = resolve_search_key("OMNIA_EXA_API_KEY", "omnia:web:exa") {
        let resp = client
            .post("https://api.exa.ai/search")
            .header("x-api-key", exa_key)
            .json(&json!({ "query": q, "numResults": lim }))
            .send()
            .await?;
        let status = resp.status();
        let body: Value = resp.json().await?;
        if !status.is_success() {
            bail!("Exa search HTTP {status}");
        }
        return Ok(json!({ "provider": "exa", "query": q, "results": body.get("results").cloned().unwrap_or(Value::Null) }));
    }

    // Public DuckDuckGo Instant Answer API fallback (strictly SSRF-validated)
    let mut url = reqwest::Url::parse("https://api.duckduckgo.com/")?;
    url.query_pairs_mut()
        .append_pair("q", q)
        .append_pair("format", "json")
        .append_pair("no_html", "1")
        .append_pair("skip_disambig", "1");
    let resp = client.get(url).send().await?;
    let body: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    let mut results = Vec::new();
    if let Some(abs) = body
        .get("AbstractText")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        results.push(json!({
            "title": body.get("Heading").and_then(Value::as_str).unwrap_or(q),
            "url": body.get("AbstractURL").and_then(Value::as_str).unwrap_or(""),
            "snippet": abs,
        }));
    }
    if let Some(rel) = body.get("RelatedTopics").and_then(Value::as_array) {
        for item in rel.iter().take(lim) {
            if let (Some(txt), Some(first_url)) = (
                item.get("Text").and_then(Value::as_str),
                item.get("FirstURL").and_then(Value::as_str),
            ) {
                results.push(json!({
                    "title": txt.chars().take(80).collect::<String>(),
                    "url": first_url,
                    "snippet": txt,
                }));
            }
        }
    }
    Ok(json!({ "provider": "duckduckgo", "query": q, "results": results }))
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
        let mut opts = IsolatedBrowserLaunchOptions::default();
        opts.headless = headless;
        if let Some(ref u) = initial_url {
            validate_browser_target_url(u)?;
            opts.initial_url = Some(u.clone());
        }
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

/// Strips script/style blocks and HTML tags into readable plain lines without executing scripts.
#[must_use]
pub fn strip_html_to_readable_text(html: &str) -> String {
    let mut cleaned = String::with_capacity(html.len());
    let lower = html.to_ascii_lowercase();
    let mut i = 0usize;
    while i < html.len() {
        let rest_lower = &lower[i..];
        let mut skipped = false;
        for tag in ["<script", "<style", "<noscript"] {
            if rest_lower.starts_with(tag) {
                let end_tag = format!("</{}>", &tag[1..]);
                if let Some(rel_end) = rest_lower.find(&end_tag) {
                    i += rel_end + end_tag.len();
                    cleaned.push(' ');
                    skipped = true;
                    break;
                }
            }
        }
        if skipped {
            continue;
        }
        if let Some(ch) = html[i..].chars().next() {
            if ch == '<' {
                if let Some(rel_gt) = html[i..].find('>') {
                    let tag_body = &lower[i + 1..i + rel_gt];
                    if tag_body.starts_with("p")
                        || tag_body.starts_with("/p")
                        || tag_body.starts_with("br")
                        || tag_body.starts_with("li")
                        || tag_body.starts_with("/h")
                        || tag_body.starts_with("/div")
                        || tag_body.starts_with("/tr")
                    {
                        cleaned.push('\n');
                    } else {
                        cleaned.push(' ');
                    }
                    i += rel_gt + 1;
                    continue;
                }
            }
            cleaned.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }

    let decoded = cleaned
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");

    decoded
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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
    fn html_extractor_strips_scripts_and_preserves_text() {
        let html = "<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Title</h1><p>Hello &amp; world</p></body></html>";
        let txt = strip_html_to_readable_text(html);
        assert!(txt.contains("Title"));
        assert!(txt.contains("Hello & world"));
        assert!(!txt.contains("alert(1)"));
        assert!(!txt.contains("color:red"));
    }
}
