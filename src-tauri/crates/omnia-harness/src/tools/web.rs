//! web_fetch and web_search.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{finish, parse_input, truncate_chars};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

pub(super) const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 OmniaAgent/0.1";
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const DEFAULT_MAX_CHARS: usize = 20_000;
const HARD_MAX_CHARS: usize = 100_000;

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static regex"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("cannot build HTTP client: {error}"))
}

// ------------------------------------------------------------ HTML -> text

pub(crate) fn decode_entities(text: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    regex(&RE, r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);")
        .replace_all(text, |caps: &regex::Captures| {
            let name = &caps[1];
            let decoded = if let Some(hex) = name.strip_prefix("#x") {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match name {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    "mdash" => Some('\u{2014}'),
                    "ndash" => Some('\u{2013}'),
                    "hellip" => Some('\u{2026}'),
                    "copy" => Some('\u{a9}'),
                    "laquo" => Some('\u{ab}'),
                    "raquo" => Some('\u{bb}'),
                    "rsquo" => Some('\u{2019}'),
                    "lsquo" => Some('\u{2018}'),
                    "ldquo" => Some('\u{201c}'),
                    "rdquo" => Some('\u{201d}'),
                    "middot" => Some('\u{b7}'),
                    _ => None,
                }
            };
            decoded.map_or_else(|| caps[0].to_string(), |c| c.to_string())
        })
        .into_owned()
}

pub(crate) fn strip_tags(html: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let text = regex(&RE, r"(?s)<[^>]*>").replace_all(html, "");
    decode_entities(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Extracts `<title>` text, if any.
pub(crate) fn html_title(html: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let caps = regex(&RE, r"(?is)<title[^>]*>(.*?)</title>").captures(html)?;
    let title = strip_tags(&caps[1]);
    (!title.is_empty()).then_some(title)
}

/// Converts HTML into readable markdown-ish text.
pub(crate) fn html_to_text(html: &str) -> String {
    static COMMENT: OnceLock<Regex> = OnceLock::new();
    static SKIP: OnceLock<Regex> = OnceLock::new();
    static ANCHOR: OnceLock<Regex> = OnceLock::new();
    static HEAD_OPEN: OnceLock<Regex> = OnceLock::new();
    static HEAD_CLOSE: OnceLock<Regex> = OnceLock::new();
    static LI: OnceLock<Regex> = OnceLock::new();
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static HREF: OnceLock<Regex> = OnceLock::new();
    static PRE: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    static STRONG: OnceLock<Regex> = OnceLock::new();
    static EM: OnceLock<Regex> = OnceLock::new();
    static CELL: OnceLock<Regex> = OnceLock::new();
    static IMG: OnceLock<Regex> = OnceLock::new();

    let mut text = regex(&COMMENT, r"(?s)<!--.*?-->")
        .replace_all(html, "")
        .into_owned();
    // The regex crate has no backreferences, so each skipped element is matched explicitly.
    for tag in [
        "script", "style", "noscript", "svg", "head", "template", "iframe",
    ] {
        let _ = &SKIP;
        let re = Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}\s*>")).expect("static regex");
        text = re.replace_all(&text, "").into_owned();
    }
    // <pre> blocks become fenced code; their content is parked behind a marker so
    // the whitespace collapsing below cannot flatten the indentation.
    let mut code_blocks: Vec<String> = Vec::new();
    text = regex(&PRE, r"(?is)<pre\b[^>]*>(.*?)</pre\s*>")
        .replace_all(&text, |caps: &regex::Captures| {
            let raw = Regex::new(r"(?s)<[^>]*>")
                .expect("static regex")
                .replace_all(&caps[1], "")
                .into_owned();
            let code = decode_entities(&raw);
            code_blocks.push(code.trim_matches('\n').trim_end().to_string());
            format!("\n\n\u{e000}{}\u{e001}\n\n", code_blocks.len() - 1)
        })
        .into_owned();
    text = regex(&CODE, r"(?is)<code\b[^>]*>(.*?)</code\s*>")
        .replace_all(&text, |caps: &regex::Captures| wrap_inline("`", &caps[1]))
        .into_owned();
    text = regex(
        &STRONG,
        r"(?is)<(?:strong|b)\b[^>]*>(.*?)</(?:strong|b)\s*>",
    )
    .replace_all(&text, |caps: &regex::Captures| wrap_inline("**", &caps[1]))
    .into_owned();
    text = regex(&EM, r"(?is)<(?:em|i)\b[^>]*>(.*?)</(?:em|i)\s*>")
        .replace_all(&text, |caps: &regex::Captures| wrap_inline("*", &caps[1]))
        .into_owned();
    text = regex(
        &IMG,
        r#"(?is)<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>"#,
    )
    .replace_all(&text, |caps: &regex::Captures| {
        let alt = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map_or("", |m| m.as_str());
        if alt.trim().is_empty() {
            String::new()
        } else {
            format!("[image: {}]", alt.trim())
        }
    })
    .into_owned();
    text = regex(&CELL, r"(?i)</t[dh]\s*>")
        .replace_all(&text, " | ")
        .into_owned();
    let href = regex(
        &HREF,
        r#"(?is)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#,
    );
    text = regex(&ANCHOR, r"(?is)<a\b([^>]*)>(.*?)</a\s*>")
        .replace_all(&text, |caps: &regex::Captures| {
            let target = href.captures(&caps[1]).and_then(|c| {
                c.get(1)
                    .or_else(|| c.get(2))
                    .or_else(|| c.get(3))
                    .map(|m| m.as_str().to_string())
            });
            let label = strip_tags(&caps[2]);
            match target {
                Some(target)
                    if !label.is_empty()
                        && !target.starts_with('#')
                        && !target.to_ascii_lowercase().starts_with("javascript:") =>
                {
                    format!("[{label}]({})", decode_entities(&target))
                }
                _ => label,
            }
        })
        .into_owned();
    text = regex(&HEAD_OPEN, r"(?i)<h([1-6])\b[^>]*>")
        .replace_all(&text, |caps: &regex::Captures| {
            let level: usize = caps[1].parse().unwrap_or(1);
            format!("\n\n{} ", "#".repeat(level))
        })
        .into_owned();
    text = regex(&HEAD_CLOSE, r"(?i)</h[1-6]\s*>")
        .replace_all(&text, "\n\n")
        .into_owned();
    text = regex(&LI, r"(?i)<li\b[^>]*>")
        .replace_all(&text, "\n- ")
        .into_owned();
    text = regex(
        &BLOCK,
        r"(?i)</?(?:p|div|section|article|main|header|footer|nav|aside|ul|ol|table|tr|blockquote|pre|form|hr|br|dl|dt|dd|figure|figcaption|details|summary)\b[^>]*>",
    )
    .replace_all(&text, "\n")
    .into_owned();
    text = regex(&TAGS, r"(?s)<[^>]*>")
        .replace_all(&text, "")
        .into_owned();
    let text = decode_entities(&text);

    let mut out = Vec::new();
    let mut blank = false;
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if !blank && !out.is_empty() {
                out.push(String::new());
            }
            blank = true;
        } else {
            out.push(line);
            blank = false;
        }
    }
    let mut joined = out.join("\n").trim().to_string();
    for (index, code) in code_blocks.iter().enumerate() {
        joined = joined.replace(
            &format!("\u{e000}{index}\u{e001}"),
            &format!("```\n{code}\n```"),
        );
    }
    joined
}

fn wrap_inline(marker: &str, inner_html: &str) -> String {
    // Tags only: entities stay encoded until the final decode, after tag stripping.
    let bare = Regex::new(r"(?s)<[^>]*>")
        .expect("static regex")
        .replace_all(inner_html, "")
        .into_owned();
    let inner = bare.split_whitespace().collect::<Vec<_>>().join(" ");
    if inner.is_empty() {
        String::new()
    } else {
        format!("{marker}{inner}{marker}")
    }
}

// ----------------------------------------------------------------- web_fetch

#[derive(Default)]
pub struct WebFetchTool;

#[derive(Deserialize)]
struct FetchArgs {
    url: String,
    max_chars: Option<usize>,
}

#[async_trait]
impl Tool for WebFetchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "web_fetch".into(),
            description: "Fetch a web page over HTTP(S) and return it as readable text (HTML is \
converted to markdown-like text with links preserved; JSON and plain text are returned as-is). \
Follows redirects, 30 s timeout, 5 MB download cap. Output is truncated to `max_chars` \
(default 20000, max 100000). Only http:// and https:// URLs are allowed. Use web_search first when \
you do not know the URL."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Absolute http(s) URL."},
                    "max_chars": {"type": "integer", "minimum": 100, "maximum": 100000, "description": "Maximum characters of content to return (default 20000)."}
                },
                "required": ["url"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::Network
    }

    fn describe(&self, input: &Value) -> String {
        format!("Fetch {}", input["url"].as_str().unwrap_or("?"))
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let work = fetch(input);
        tokio::select! {
            result = work => finish(result),
            _ = ctx.cancel.cancelled() => Err(super::cancelled()),
        }
    }
}

pub(super) fn validate_url(raw: &str) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(raw.trim()).map_err(|error| format!("invalid URL `{raw}`: {error}"))?;
    match url.scheme() {
        "http" | "https" if url.username().is_empty() && url.password().is_none() => Ok(url),
        "http" | "https" => Err("URL credentials are not allowed".into()),
        other => Err(format!(
            "unsupported URL scheme `{other}`; only http and https are allowed"
        )),
    }
}

async fn fetch(input: Value) -> Result<ToolOutput, String> {
    let args: FetchArgs = parse_input(input)?;
    let url = validate_url(&args.url)?;
    let max_chars = args
        .max_chars
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(100, HARD_MAX_CHARS);
    let mut response = client()?
        .get(url)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        )
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut body: Vec<u8> = Vec::new();
    let mut capped = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("failed reading body: {error}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_BODY_BYTES {
            body.truncate(MAX_BODY_BYTES);
            capped = true;
            break;
        }
    }
    let is_html = content_type.contains("html") || content_type.contains("xml");
    let is_text = is_html
        || content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("javascript")
        || content_type.is_empty();
    if !is_text {
        return Err(format!(
            "{final_url} returned non-text content ({content_type}, {} bytes)",
            body.len()
        ));
    }
    let raw = String::from_utf8_lossy(&body).into_owned();
    let (title, text) = if is_html || raw.trim_start().starts_with('<') {
        (html_title(&raw), html_to_text(&raw))
    } else {
        (None, raw)
    };
    let total = text.chars().count();
    let mut out = format!("URL: {final_url}\nStatus: {}\n", status.as_u16());
    if let Some(title) = title {
        out.push_str(&format!("Title: {title}\n"));
    }
    out.push('\n');
    out.push_str(&truncate_chars(&text, max_chars));
    if total > max_chars {
        out.push_str(&format!(
            "\n\n[truncated: showing {max_chars} of {total} characters]"
        ));
    } else if capped {
        out.push_str("\n\n[download capped at 5 MB]");
    }
    Ok(ToolOutput {
        content: vec![crate::Block::text(out)],
        is_error: !status.is_success(),
    })
}

// ---------------------------------------------------------------- web_search

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// A search provider. Implement this to plug in more engines (see SearxngBackend, BraveBackend).
#[async_trait]
pub trait SearchBackend: Send + Sync {
    fn name(&self) -> &str;
    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, String>;
}

/// Keyless backend scraping DuckDuckGo's HTML endpoint.
#[derive(Default)]
pub struct DuckDuckGoBackend;

impl DuckDuckGoBackend {
    /// Unwraps DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` redirect links.
    pub(crate) fn clean_url(href: &str) -> String {
        let href = decode_entities(href);
        let absolute = if href.starts_with("//") {
            format!("https:{href}")
        } else {
            href
        };
        if let Ok(parsed) = reqwest::Url::parse(&absolute) {
            if parsed
                .host_str()
                .is_some_and(|h| h.ends_with("duckduckgo.com"))
                && parsed.path().starts_with("/l/")
            {
                if let Some((_, target)) = parsed.query_pairs().find(|(k, _)| k == "uddg") {
                    return target.into_owned();
                }
            }
        }
        absolute
    }

    pub(crate) fn parse(html: &str, max_results: usize) -> Vec<SearchResult> {
        static TITLE: OnceLock<Regex> = OnceLock::new();
        static SNIPPET: OnceLock<Regex> = OnceLock::new();
        static HREF: OnceLock<Regex> = OnceLock::new();
        let title_re = regex(
            &TITLE,
            r#"(?is)<a\b([^>]*class\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>(.*?)</a\s*>"#,
        );
        let snippet_re = regex(
            &SNIPPET,
            r#"(?is)<(?:a|div|td)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>(.*?)</(?:a|div|td)\s*>"#,
        );
        let href_re = regex(&HREF, r#"(?is)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')"#);
        let titles: Vec<_> = title_re.captures_iter(html).collect();
        let mut results = Vec::new();
        for (index, caps) in titles.iter().enumerate() {
            let Some(href) = href_re
                .captures(&caps[1])
                .and_then(|c| c.get(1).or_else(|| c.get(2)))
            else {
                continue;
            };
            let end_of_title = caps.get(0).map_or(0, |m| m.end());
            let next_start = titles
                .get(index + 1)
                .and_then(|c| c.get(0))
                .map_or(html.len(), |m| m.start());
            let snippet = snippet_re
                .captures(&html[end_of_title..next_start])
                .map(|c| strip_tags(&c[1]))
                .unwrap_or_default();
            let url = Self::clean_url(href.as_str());
            if !url.starts_with("http") {
                continue;
            }
            results.push(SearchResult {
                title: strip_tags(&caps[2]),
                url,
                snippet,
            });
            if results.len() >= max_results {
                break;
            }
        }
        results
    }
}

#[async_trait]
impl SearchBackend for DuckDuckGoBackend {
    fn name(&self) -> &str {
        "duckduckgo"
    }

    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
        let response = client()?
            .get("https://html.duckduckgo.com/html/")
            .query(&[("q", query)])
            .send()
            .await
            .map_err(|error| format!("search request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "search backend returned HTTP {}",
                response.status()
            ));
        }
        let html = response
            .text()
            .await
            .map_err(|error| format!("failed reading search results: {error}"))?;
        Ok(Self::parse(&html, max_results))
    }
}

/// SearXNG instance backend (`<base>/search?q=..&format=json`). The instance must
/// have the JSON output format enabled.
pub struct SearxngBackend {
    base: String,
}

impl SearxngBackend {
    pub fn new(base_url: &str) -> Result<Self, String> {
        let url = validate_url(base_url)?;
        Ok(Self {
            base: url.as_str().trim_end_matches('/').to_string(),
        })
    }

    pub(crate) fn parse(body: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
        let value: Value = serde_json::from_str(body).map_err(|error| {
            format!("SearXNG returned invalid JSON (is the json format enabled?): {error}")
        })?;
        Ok(collect_results(&value["results"], "content", max_results))
    }
}

/// Maps a JSON array of `{title, url, <snippet_key>}` items to results.
fn collect_results(items: &Value, snippet_key: &str, max_results: usize) -> Vec<SearchResult> {
    items
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let url = item["url"].as_str()?.to_string();
                    url.starts_with("http").then(|| SearchResult {
                        title: strip_tags(item["title"].as_str().unwrap_or(&url)),
                        snippet: strip_tags(item[snippet_key].as_str().unwrap_or("")),
                        url,
                    })
                })
                .take(max_results)
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl SearchBackend for SearxngBackend {
    fn name(&self) -> &str {
        "searxng"
    }

    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
        let response = client()?
            .get(format!("{}/search", self.base))
            .query(&[("q", query), ("format", "json")])
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|error| format!("SearXNG request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("SearXNG returned HTTP {}", response.status()));
        }
        let body = response
            .text()
            .await
            .map_err(|error| format!("failed reading SearXNG results: {error}"))?;
        Self::parse(&body, max_results)
    }
}

const BRAVE_ENDPOINT: &str = "https://api.search.brave.com";

/// Brave Search API backend. The key is supplied by the caller (env/config),
/// never read from stored credentials.
pub struct BraveBackend {
    endpoint: String,
    api_key: String,
}

impl BraveBackend {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self::with_endpoint(BRAVE_ENDPOINT, api_key)
    }

    /// Custom API origin (tests, proxies).
    pub fn with_endpoint(endpoint: &str, api_key: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.trim_end_matches('/').to_string(),
            api_key: api_key.into(),
        }
    }

    pub(crate) fn parse(body: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
        let value: Value = serde_json::from_str(body)
            .map_err(|error| format!("Brave returned invalid JSON: {error}"))?;
        Ok(collect_results(
            &value["web"]["results"],
            "description",
            max_results,
        ))
    }
}

#[async_trait]
impl SearchBackend for BraveBackend {
    fn name(&self) -> &str {
        "brave"
    }

    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
        let count = max_results.clamp(1, 20).to_string();
        let response = client()?
            .get(format!("{}/res/v1/web/search", self.endpoint))
            .query(&[("q", query), ("count", count.as_str())])
            .header("Accept", "application/json")
            .header("X-Subscription-Token", &self.api_key)
            .send()
            .await
            .map_err(|error| format!("Brave request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Brave Search returned HTTP {}", response.status()));
        }
        let body = response
            .text()
            .await
            .map_err(|error| format!("failed reading Brave results: {error}"))?;
        Self::parse(&body, max_results)
    }
}

/// Tries each backend in order; moves on after an error or an empty result.
pub struct FallbackBackend {
    backends: Vec<Arc<dyn SearchBackend>>,
}

impl FallbackBackend {
    pub fn new(backends: Vec<Arc<dyn SearchBackend>>) -> Self {
        Self { backends }
    }
}

#[async_trait]
impl SearchBackend for FallbackBackend {
    fn name(&self) -> &str {
        "fallback"
    }

    async fn search(&self, query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
        let mut errors = Vec::new();
        for backend in &self.backends {
            match backend.search(query, max_results).await {
                Ok(results) if !results.is_empty() => return Ok(results),
                Ok(_) => {}
                Err(error) => errors.push(format!("{}: {error}", backend.name())),
            }
        }
        if errors.len() == self.backends.len() && !errors.is_empty() {
            return Err(format!("all search backends failed: {}", errors.join("; ")));
        }
        Ok(Vec::new())
    }
}

/// Search backend selection. `order` is the fallback order; unknown or
/// unconfigured names are skipped, and DuckDuckGo (keyless) is the last resort
/// when nothing else is usable.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchConfig {
    /// Backend names in preference order: `searxng`, `brave`, `duckduckgo`.
    /// Empty means the default order (searxng, brave, duckduckgo).
    pub order: Vec<String>,
    pub searxng_url: Option<String>,
    pub brave_api_key: Option<String>,
    /// Override of the Brave API origin (tests).
    pub brave_endpoint: Option<String>,
}

impl SearchConfig {
    /// Reads `OMNIA_SEARCH_BACKENDS` (comma list), `OMNIA_SEARXNG_URL` and
    /// `OMNIA_BRAVE_API_KEY` from the process environment.
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let clean = |name: &str| {
            get(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Self {
            order: clean("OMNIA_SEARCH_BACKENDS")
                .map(|list| {
                    list.split(',')
                        .map(|item| item.trim().to_ascii_lowercase())
                        .filter(|item| !item.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            searxng_url: clean("OMNIA_SEARXNG_URL"),
            brave_api_key: clean("OMNIA_BRAVE_API_KEY"),
            brave_endpoint: None,
        }
    }

    /// Builds the ordered backend chain.
    pub fn build(&self) -> Arc<dyn SearchBackend> {
        let default_order = ["searxng", "brave", "duckduckgo"].map(String::from);
        let order = if self.order.is_empty() {
            &default_order[..]
        } else {
            &self.order[..]
        };
        let mut chain: Vec<Arc<dyn SearchBackend>> = Vec::new();
        for name in order {
            match name.as_str() {
                "searxng" => {
                    if let Some(Ok(backend)) = self.searxng_url.as_deref().map(SearxngBackend::new)
                    {
                        chain.push(Arc::new(backend));
                    }
                }
                "brave" => {
                    if let Some(key) = &self.brave_api_key {
                        chain.push(Arc::new(match &self.brave_endpoint {
                            Some(endpoint) => BraveBackend::with_endpoint(endpoint, key.clone()),
                            None => BraveBackend::new(key.clone()),
                        }));
                    }
                }
                "duckduckgo" | "ddg" => chain.push(Arc::new(DuckDuckGoBackend)),
                _ => {}
            }
        }
        match chain.len() {
            0 => Arc::new(DuckDuckGoBackend),
            1 => chain.remove(0),
            _ => Arc::new(FallbackBackend::new(chain)),
        }
    }
}

pub struct WebSearchTool {
    backend: Arc<dyn SearchBackend>,
}

impl WebSearchTool {
    pub fn new(backend: Arc<dyn SearchBackend>) -> Self {
        Self { backend }
    }
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new(SearchConfig::from_env().build())
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    max_results: Option<usize>,
}

pub(crate) fn format_results(results: &[SearchResult]) -> String {
    if results.is_empty() {
        return "No results found.".into();
    }
    results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let mut entry = format!("{}. {}\n   {}", i + 1, r.title, r.url);
            if !r.snippet.is_empty() {
                entry.push_str(&format!("\n   {}", r.snippet));
            }
            entry
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[async_trait]
impl Tool for WebSearchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "web_search".into(),
            description: "Search the web and return result titles, URLs and snippets. Use \
web_fetch afterwards to read a promising result in full. Prefer specific queries; include the \
current year for time-sensitive topics."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query."},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 20, "description": "Maximum number of results (default 8)."}
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::Network
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Search the web for `{}`",
            input["query"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args: SearchArgs = match parse_input(input) {
            Ok(args) => args,
            Err(error) => return Ok(ToolOutput::error(error)),
        };
        if args.query.trim().is_empty() {
            return Ok(ToolOutput::error("query must not be empty"));
        }
        let max = args.max_results.unwrap_or(8).clamp(1, 20);
        tokio::select! {
            result = self.backend.search(&args.query, max) => {
                finish(result.map(|r| ToolOutput::text(format_results(&r))))
            }
            _ = ctx.cancel.cancelled() => Err(super::cancelled()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DDG_FIXTURE: &str = r#"
<div class="results">
 <div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
   <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F&amp;rut=abc">Rust <b>Programming</b> Language</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust-lang.org%2F&amp;rut=abc">A language empowering everyone to build <b>reliable</b> software &amp; more.</a>
 </div>
 <div class="result">
  <h2 class="result__title">
   <a class="result__a" rel="nofollow" href="https://doc.rust-lang.org/book/">The Book</a>
  </h2>
  <a class="result__snippet">Learn Rust.</a>
 </div>
 <div class="result">
  <a class="result__a" href="https://example.com/third">Third</a>
 </div>
</div>"#;

    #[test]
    fn parses_duckduckgo_results() {
        let results = DuckDuckGoBackend::parse(DDG_FIXTURE, 10);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://www.rust-lang.org/");
        assert_eq!(
            results[0].snippet,
            "A language empowering everyone to build reliable software & more."
        );
        assert_eq!(results[1].url, "https://doc.rust-lang.org/book/");
        assert_eq!(results[1].snippet, "Learn Rust.");
        assert_eq!(results[2].snippet, "");
        assert_eq!(DuckDuckGoBackend::parse(DDG_FIXTURE, 2).len(), 2);
        let text = format_results(&results);
        assert!(text.starts_with("1. Rust Programming Language\n   https://www.rust-lang.org/"));
        assert_eq!(format_results(&[]), "No results found.");
    }

    #[test]
    fn html_to_readable_text() {
        let html = r##"<!doctype html><html><head><title>Hi &amp; bye</title><style>p{color:red}</style></head>
<body><script>var x = "<p>no</p>";</script>
<h1>Heading</h1><p>Some <b>bold</b>   text with a <a href="https://x.dev/a?b=1&amp;c=2">link</a>.</p>
<ul><li>one</li><li>two &lt;3</li></ul><!-- comment --><a href="#top">skip</a><br>end&nbsp;&#33;</body></html>"##;
        assert_eq!(html_title(html).as_deref(), Some("Hi & bye"));
        let text = html_to_text(html);
        assert!(text.starts_with("# Heading"), "{text}");
        assert!(text.contains("Some **bold** text with a [link](https://x.dev/a?b=1&c=2)."));
        assert!(text.contains("- one\n- two <3"));
        assert!(
            !text.contains("no</p>") && !text.contains("color:red") && !text.contains("comment")
        );
        assert!(text.contains("skip") && !text.contains("(#top)"));
        assert!(text.ends_with("end !"));
    }

    #[test]
    fn rejects_bad_schemes() {
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("ftp://example.com").is_err());
        assert!(validate_url("not a url").is_err());
        assert!(validate_url("https://example.com/x").is_ok());
    }

    #[tokio::test]
    async fn fetch_rejects_non_http_without_network() {
        let out = WebFetchTool
            .call(
                &ToolContext::new("."),
                json!({"url": "file:///C:/secret.txt"}),
            )
            .await
            .unwrap();
        assert!(out.is_error);
    }

    struct Fake;
    #[async_trait]
    impl SearchBackend for Fake {
        fn name(&self) -> &str {
            "fake"
        }
        async fn search(&self, query: &str, max: usize) -> Result<Vec<SearchResult>, String> {
            Ok(vec![
                SearchResult {
                    title: query.into(),
                    url: "https://a.test".into(),
                    snippet: "s".into()
                };
                max.min(2)
            ])
        }
    }

    #[tokio::test]
    async fn search_tool_uses_pluggable_backend() {
        let tool = WebSearchTool::new(Arc::new(Fake));
        let out = tool
            .call(
                &ToolContext::new("."),
                json!({"query": "q", "max_results": 5}),
            )
            .await
            .unwrap();
        let crate::Block::Text { text } = &out.content[0] else {
            panic!()
        };
        assert!(text.contains("1. q") && text.contains("2. q") && !text.contains("3."));
    }

    #[test]
    fn html_to_markdown_code_and_emphasis() {
        let html = "<h2>Install</h2><p>Run <code>cargo add Vec&lt;T&gt;</code> and <em>enjoy</em>.</p>\
<pre><code class=\"language-rust\">fn main() {\n    println!(\"&lt;hi&gt;\");\n}\n</code></pre>\
<ol><li>first</li><li>second</li></ol><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>\
<img src=\"x.png\" alt=\"logo\">";
        let text = html_to_text(html);
        assert!(text.starts_with("## Install"), "{text}");
        assert!(
            text.contains("Run `cargo add Vec<T>` and *enjoy*."),
            "{text}"
        );
        assert!(
            text.contains("```\nfn main() {\n    println!(\"<hi>\");\n}\n```"),
            "{text}"
        );
        assert!(text.contains("- first\n- second"), "{text}");
        assert!(
            text.contains("a | b |") && text.contains("1 | 2 |"),
            "{text}"
        );
        assert!(text.contains("[image: logo]"), "{text}");
    }

    /// Local HTTP server; `handler` maps the request head to (status, body).
    /// Returns the origin and the captured request heads.
    async fn mock_server(
        handler: impl Fn(&str) -> (u16, String) + Send + Sync + 'static,
    ) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                // TCP reads may return a single byte. Wait for the complete
                // request head before recording it or producing the response.
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                let head = tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let n = socket.read(&mut chunk).await.unwrap();
                        assert!(n > 0, "fixture request ended before headers");
                        assert!(buf.len() + n <= 32 * 1024, "fixture headers too large");
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(end) = buf.windows(4).position(|part| part == b"\r\n\r\n") {
                            break String::from_utf8_lossy(&buf[..end + 4]).into_owned();
                        }
                    }
                })
                .await
                .expect("fixture header deadline");
                let (status, body) = handler(&head);
                log.lock().unwrap().push(head);
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (origin, seen)
    }

    #[tokio::test]
    async fn searxng_backend_against_mock() {
        let (origin, seen) = mock_server(|_| {
            (
                200,
                r#"{"results":[{"title":"Rust <b>Lang</b>","url":"https://www.rust-lang.org/","content":"A &amp; B"},{"title":"bad","url":"javascript:x"},{"title":"Two","url":"https://two.test/"}]}"#.into(),
            )
        })
        .await;
        let backend = SearxngBackend::new(&format!("{origin}/")).unwrap();
        let results = backend.search("rust lang", 5).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Lang");
        assert_eq!(results[0].snippet, "A & B");
        let head = seen.lock().unwrap()[0].clone();
        assert!(head.starts_with("GET /search?"), "{head}");
        assert!(
            head.contains("format=json") && head.contains("q=rust+lang"),
            "{head}"
        );
        assert!(SearxngBackend::new("ftp://x").is_err());
    }

    #[tokio::test]
    async fn brave_backend_sends_key_and_parses() {
        let (origin, seen) = mock_server(|_| {
            (
                200,
                r#"{"web":{"results":[{"title":"T","url":"https://t.test/","description":"d <strong>x</strong>"}]}}"#.into(),
            )
        })
        .await;
        let backend = BraveBackend::with_endpoint(&origin, "k-123");
        let results = backend.search("q", 3).await.unwrap();
        assert_eq!(
            results,
            vec![SearchResult {
                title: "T".into(),
                url: "https://t.test/".into(),
                snippet: "d x".into()
            }]
        );
        let head = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(head.starts_with("get /res/v1/web/search?"), "{head}");
        assert!(
            head.contains("x-subscription-token: k-123") && head.contains("count=3"),
            "{head}"
        );
    }

    #[tokio::test]
    async fn config_orders_backends_and_falls_back() {
        // First backend (SearXNG) fails with 500, second (Brave) answers.
        let (down, _) = mock_server(|_| (500, "{}".into())).await;
        let (up, _) = mock_server(|_| {
            (
                200,
                r#"{"web":{"results":[{"title":"ok","url":"https://ok.test/"}]}}"#.into(),
            )
        })
        .await;
        let config = SearchConfig {
            order: vec!["searxng".into(), "brave".into(), "nonsense".into()],
            searxng_url: Some(down),
            brave_api_key: Some("k".into()),
            brave_endpoint: Some(up),
        };
        let results = config.build().search("q", 5).await.unwrap();
        assert_eq!(results[0].title, "ok");

        let brave_only = SearchConfig {
            order: vec!["brave".into()],
            ..config.clone()
        };
        assert_eq!(brave_only.build().name(), "brave");

        // All failing -> aggregated error naming both.
        let (down2, _) = mock_server(|_| (500, "{}".into())).await;
        let failing = SearchConfig {
            order: vec!["searxng".into(), "brave".into()],
            searxng_url: Some(down2.clone()),
            brave_api_key: Some("k".into()),
            brave_endpoint: Some(down2),
        };
        let error = failing.build().search("q", 5).await.unwrap_err();
        assert!(
            error.contains("searxng") && error.contains("brave"),
            "{error}"
        );
    }

    #[test]
    fn config_from_lookup_and_defaults() {
        let config = SearchConfig::from_lookup(|name| match name {
            "OMNIA_SEARCH_BACKENDS" => Some(" Brave , DuckDuckGo ".into()),
            "OMNIA_BRAVE_API_KEY" => Some("abc".into()),
            "OMNIA_SEARXNG_URL" => Some("  ".into()),
            _ => None,
        });
        assert_eq!(config.order, vec!["brave", "duckduckgo"]);
        assert_eq!(config.brave_api_key.as_deref(), Some("abc"));
        assert!(config.searxng_url.is_none());
        assert_eq!(config.build().name(), "fallback");
        assert_eq!(SearchConfig::default().build().name(), "duckduckgo");
    }

    #[tokio::test]
    async fn web_fetch_converts_html_to_markdown_via_local_server() {
        let (origin, _) = mock_server(|_| {
            (
                200,
                "<html><head><title>T</title></head><body><h1>Hi</h1><ul><li>a</li></ul><pre>x\n  y</pre></body></html>".into(),
            )
        })
        .await;
        let out = WebFetchTool
            .call(
                &ToolContext::new("."),
                json!({"url": format!("{origin}/p")}),
            )
            .await
            .unwrap();
        let crate::Block::Text { text } = &out.content[0] else {
            panic!()
        };
        assert!(
            text.contains("# Hi") && text.contains("- a") && text.contains("```\nx\n  y\n```"),
            "{text}"
        );
    }
}
