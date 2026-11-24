//! Moodle LMS, YouTube metadata/playlist, and bounded Web crawlers with strict
//! SSRF/IMDS/private-IP blocking and ReDoS-safe pattern guards for OmniDrive Pro v5.

use std::collections::{BTreeSet, VecDeque};
use std::time::Duration;

use reqwest::{redirect, Client};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::handoff::{classify_http_response, HttpGateClassification};
use crate::privacy::PrivacyShield;
use crate::types::{DownloaderError, SecurityPolicy, DRM_SUPPORTED};

const MAX_PATTERN_LEN: usize = 256;
const MAX_CRAWL_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_CRAWL_PAGES: usize = 32;
const MAX_CRAWL_DEPTH: usize = 3;

/// Validated ReDoS-free substring/glob filter matcher (blocks nested quantifiers & catastrophic shapes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFilterPattern {
    raw: String,
    lower_tokens: Vec<String>,
}

impl SafeFilterPattern {
    /// Compiles a filter glob (`*` wildcard tokens) after rejecting catastrophic ReDoS shapes.
    pub fn compile(pattern: &str) -> Result<Self, DownloaderError> {
        let trimmed = pattern.trim();
        if trimmed.len() > MAX_PATTERN_LEN {
            return Err(DownloaderError::InvalidInput(format!(
                "ReDoS guard: filter pattern length {} exceeds {MAX_PATTERN_LEN}",
                trimmed.len()
            )));
        }
        if has_redos_hazard(trimmed) {
            return Err(DownloaderError::InvalidInput(
                "ReDoS guard: catastrophic nested quantifier / backtracking group rejected".into(),
            ));
        }
        let lower_tokens = trimmed
            .to_ascii_lowercase()
            .split('*')
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect();
        Ok(Self {
            raw: trimmed.to_string(),
            lower_tokens,
        })
    }

    /// Returns `true` when `candidate` contains all non-empty `*`-separated segments in order (`O(n)`).
    #[must_use]
    pub fn matches(&self, candidate: &str) -> bool {
        if self.lower_tokens.is_empty() {
            return true;
        }
        let hay = candidate.to_ascii_lowercase();
        let mut cursor = 0usize;
        for tok in &self.lower_tokens {
            let Some(pos) = hay[cursor..].find(tok.as_str()) else {
                return false;
            };
            cursor += pos + tok.len();
        }
        true
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.raw
    }
}

/// Deterministic linear check rejecting classic nested-quantifier / high-nesting ReDoS payloads.
#[must_use]
pub fn has_redos_hazard(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut group_stack: Vec<bool> = Vec::new();
    let mut escaped = false;

    for (idx, &b) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if b == b'\\' {
            escaped = true;
            continue;
        }
        match b {
            b'(' => {
                if group_stack.len() >= 3 {
                    return true;
                }
                group_stack.push(false);
            }
            b')' => {
                let inner_has_quant = group_stack.pop().unwrap_or(false);
                let next_is_quant = idx + 1 < bytes.len()
                    && matches!(bytes[idx + 1], b'+' | b'*' | b'{' | b'?');
                if inner_has_quant && next_is_quant {
                    return true;
                }
                if next_is_quant {
                    if let Some(top) = group_stack.last_mut() {
                        *top = true;
                    }
                }
            }
            b'+' | b'*' | b'{' => {
                if let Some(top) = group_stack.last_mut() {
                    *top = true;
                }
                if idx + 1 < bytes.len() && matches!(bytes[idx + 1], b'+' | b'*') {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Extracted resource discovered by Moodle or Web crawlers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredCrawlResource {
    pub url: String,
    pub sanitized_url: String,
    pub label: String,
    pub category: String,
    pub section: Option<String>,
    pub source_kind: String,
}

/// Outcome of crawling a Moodle LMS page/course or general web tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlReport {
    pub crawler: String,
    pub root_url: String,
    pub pages_visited: usize,
    pub resources: Vec<DiscoveredCrawlResource>,
    pub warnings: Vec<String>,
    pub drm_supported: bool,
}

/// Parses Moodle LMS HTML (`mod/resource`, `mod/folder`, `mod/url`, `pluginfile.php`, `<source>`)
/// and validates every link against [`SecurityPolicy`].
pub fn extract_moodle_resources_from_html(
    html: &str,
    base_url: &str,
    policy: SecurityPolicy,
    filter: Option<&SafeFilterPattern>,
) -> Result<Vec<DiscoveredCrawlResource>, DownloaderError> {
    policy.validate_url(base_url)?;
    let base = Url::parse(base_url)
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid Moodle base URL: {e}")))?;

    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw_link in scan_attribute_urls(html) {
        let Ok(resolved) = base.join(&raw_link.url) else {
            continue;
        };
        let resolved_str = resolved.to_string();
        if policy.validate_url(&resolved_str).is_err() {
            continue;
        }
        let lower = resolved_str.to_ascii_lowercase();
        let is_moodle_asset = lower.contains("pluginfile.php")
            || lower.contains("/mod/resource/")
            || lower.contains("/mod/url/")
            || lower.contains("/mod/folder/")
            || lower.contains("/mod/page/")
            || lower.contains("forcedownload=1")
            || has_downloadable_extension(&lower);
        if !is_moodle_asset {
            continue;
        }
        if let Some(pat) = filter {
            if !pat.matches(&resolved_str) && !pat.matches(&raw_link.label) {
                continue;
            }
        }
        let sanitized = PrivacyShield::sanitize_for_receipt(&resolved_str);
        if !seen.insert(sanitized.clone()) {
            continue;
        }
        let category = classify_moodle_category(&lower);
        out.push(DiscoveredCrawlResource {
            url: resolved_str,
            sanitized_url: sanitized,
            label: raw_link.label,
            category,
            section: raw_link.section,
            source_kind: "moodle_lms".to_string(),
        });
    }
    Ok(out)
}

/// Crawls a Moodle course/page URL with strict SSRF & manual-auth gate checks.
pub async fn crawl_moodle_course(
    url: &str,
    cookie_header: Option<&str>,
    filter_pattern: Option<&str>,
    policy: SecurityPolicy,
) -> Result<CrawlReport, DownloaderError> {
    policy.validate_url(url)?;
    let filter = filter_pattern.map(SafeFilterPattern::compile).transpose()?;
    let html = fetch_html_guarded(url, cookie_header, policy).await?;
    let resources = extract_moodle_resources_from_html(&html, url, policy, filter.as_ref())?;
    Ok(CrawlReport {
        crawler: "moodle_lms".to_string(),
        root_url: PrivacyShield::sanitize_for_receipt(url),
        pages_visited: 1,
        resources,
        warnings: Vec::new(),
        drm_supported: DRM_SUPPORTED,
    })
}

/// Bounded SSRF-safe BFS Web link & media crawler.
pub async fn crawl_web_tree(
    root_url: &str,
    max_depth: usize,
    max_pages: usize,
    filter_pattern: Option<&str>,
    policy: SecurityPolicy,
) -> Result<CrawlReport, DownloaderError> {
    policy.validate_url(root_url)?;
    let root = Url::parse(root_url)
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid crawl URL: {e}")))?;
    let root_host = root.host_str().unwrap_or_default().to_ascii_lowercase();
    let filter = filter_pattern.map(SafeFilterPattern::compile).transpose()?;

    let depth_cap = max_depth.clamp(1, MAX_CRAWL_DEPTH);
    let page_cap = max_pages.clamp(1, MAX_CRAWL_PAGES);

    let mut queue = VecDeque::from([(root_url.to_string(), 0usize)]);
    let mut visited_pages = BTreeSet::new();
    let mut seen_resources = BTreeSet::new();
    let mut resources = Vec::new();
    let mut warnings = Vec::new();

    while let Some((current, depth)) = queue.pop_front() {
        if visited_pages.len() >= page_cap {
            break;
        }
        if !visited_pages.insert(current.clone()) {
            continue;
        }
        let Ok(html) = fetch_html_guarded(&current, None, policy).await else {
            warnings.push(format!(
                "skipped unreachable/gated page {}",
                PrivacyShield::sanitize_for_receipt(&current)
            ));
            continue;
        };
        let Ok(base) = Url::parse(&current) else {
            continue;
        };
        for link in scan_attribute_urls(&html) {
            let Ok(resolved) = base.join(&link.url) else {
                continue;
            };
            let resolved_str = resolved.to_string();
            if policy.validate_url(&resolved_str).is_err() {
                continue;
            }
            let lower = resolved_str.to_ascii_lowercase();
            let same_host = resolved
                .host_str()
                .is_some_and(|h| h.eq_ignore_ascii_case(&root_host));
            if has_downloadable_extension(&lower)
                || filter
                    .as_ref()
                    .is_some_and(|pat| pat.matches(&resolved_str) || pat.matches(&link.label))
            {
                let sanitized = PrivacyShield::sanitize_for_receipt(&resolved_str);
                if seen_resources.insert(sanitized.clone()) {
                    resources.push(DiscoveredCrawlResource {
                        url: resolved_str,
                        sanitized_url: sanitized,
                        label: link.label,
                        category: classify_moodle_category(&lower),
                        section: link.section,
                        source_kind: "web_crawler".to_string(),
                    });
                }
            } else if same_host && depth + 1 < depth_cap && visited_pages.len() + queue.len() < page_cap
            {
                queue.push_back((resolved_str, depth + 1));
            }
        }
    }

    Ok(CrawlReport {
        crawler: "web_bfs".to_string(),
        root_url: PrivacyShield::sanitize_for_receipt(root_url),
        pages_visited: visited_pages.len(),
        resources,
        warnings,
        drm_supported: DRM_SUPPORTED,
    })
}

/// Discovered non-DRM YouTube video/playlist inspection metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct YouTubeInspectResult {
    pub video_id: Option<String>,
    pub playlist_id: Option<String>,
    pub title: String,
    pub channel: Option<String>,
    pub duration_secs: Option<u64>,
    pub formats: Vec<YouTubeFormatOption>,
    pub entries: Vec<YouTubePlaylistEntry>,
    pub drm_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct YouTubeFormatOption {
    pub itag: Option<u64>,
    pub mime_type: String,
    pub quality_label: Option<String>,
    pub url: String,
    pub has_video: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct YouTubePlaylistEntry {
    pub video_id: String,
    pub title: String,
    pub url: String,
    pub duration_secs: Option<u64>,
}

/// Validates and extracts `(video_id, playlist_id)` from canonical YouTube URLs.
pub fn parse_youtube_url(raw_url: &str) -> Result<(Option<String>, Option<String>), DownloaderError> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid YouTube URL: {e}")))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_yt = host == "youtu.be"
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com");
    if !is_yt {
        return Err(DownloaderError::InvalidInput(
            "URL host is not a recognized YouTube domain".into(),
        ));
    }

    let mut video_id = None;
    let mut playlist_id = None;
    for (k, v) in parsed.query_pairs() {
        if k == "v" && is_safe_yt_id(&v) {
            video_id = Some(v.into_owned());
        } else if k == "list" && is_safe_yt_id(&v) {
            playlist_id = Some(v.into_owned());
        }
    }
    if video_id.is_none() && host == "youtu.be" {
        if let Some(seg) = parsed.path_segments().and_then(|mut s| s.next()) {
            if is_safe_yt_id(seg) {
                video_id = Some(seg.to_string());
            }
        }
    }
    if video_id.is_none() {
        let segs: Vec<&str> = parsed
            .path_segments()
            .map(|s| s.collect())
            .unwrap_or_default();
        if segs.len() >= 2 && matches!(segs[0], "shorts" | "embed" | "live") && is_safe_yt_id(segs[1]) {
            video_id = Some(segs[1].to_string());
        }
    }
    if video_id.is_none() && playlist_id.is_none() {
        return Err(DownloaderError::InvalidInput(
            "YouTube URL missing valid video (`v=`) or playlist (`list=`) identifier".into(),
        ));
    }
    Ok((video_id, playlist_id))
}

/// Parses an embedded `ytInitialPlayerResponse` JSON payload, refusing DRM / encrypted signatureCiphers.
pub fn parse_youtube_player_json(
    player_json: &Value,
    policy: SecurityPolicy,
) -> Result<YouTubeInspectResult, DownloaderError> {
    let details = player_json.get("videoDetails").and_then(Value::as_object);
    let video_id = details
        .and_then(|d| d.get("videoId"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let title = details
        .and_then(|d| d.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("YouTube Media")
        .to_string();
    let channel = details
        .and_then(|d| d.get("author"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let duration_secs = details
        .and_then(|d| d.get("lengthSeconds"))
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));

    let streaming = player_json
        .get("streamingData")
        .and_then(Value::as_object);
    if let Some(sd) = streaming {
        if sd.contains_key("licenseInfos") {
            return Err(DownloaderError::DrmUnsupported {
                detail: "YouTube stream declares DRM licenseInfos; drm_supported=false".into(),
            });
        }
    }

    let mut formats = Vec::new();
    for bucket in ["formats", "adaptiveFormats"] {
        if let Some(arr) = streaming
            .and_then(|s| s.get(bucket))
            .and_then(Value::as_array)
        {
            for item in arr {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                if let Some(raw_url) = obj.get("url").and_then(Value::as_str) {
                    if policy.validate_url(raw_url).is_ok() {
                        let mime_type = obj
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream")
                            .to_string();
                        let has_video = mime_type.starts_with("video/");
                        let has_audio =
                            mime_type.starts_with("audio/") || bucket == "formats";
                        formats.push(YouTubeFormatOption {
                            itag: obj.get("itag").and_then(Value::as_u64),
                            mime_type,
                            quality_label: obj
                                .get("qualityLabel")
                                .and_then(Value::as_str)
                                .map(ToString::to_string),
                            url: raw_url.to_string(),
                            has_video,
                            has_audio,
                        });
                    }
                }
            }
        }
    }

    Ok(YouTubeInspectResult {
        video_id,
        playlist_id: None,
        title,
        channel,
        duration_secs,
        formats,
        entries: Vec::new(),
        drm_supported: DRM_SUPPORTED,
    })
}

/// Inspects a YouTube video or playlist via `oEmbed` / public watch page without DRM bypass.
pub async fn inspect_youtube_url(
    raw_url: &str,
    policy: SecurityPolicy,
) -> Result<YouTubeInspectResult, DownloaderError> {
    policy.validate_url(raw_url)?;
    let (video_id, playlist_id) = parse_youtube_url(raw_url)?;
    let oembed_url = format!(
        "https://www.youtube.com/oembed?url={}&format=json",
        url_encode_component(raw_url.trim())
    );
    let mut title = "YouTube Video".to_string();
    let mut channel = None;
    if policy.validate_url(&oembed_url).is_ok() {
        if let Ok(body) = fetch_html_guarded(&oembed_url, None, policy).await {
            if let Ok(val) = serde_json::from_str::<Value>(&body) {
                if let Some(t) = val.get("title").and_then(Value::as_str) {
                    title = t.to_string();
                }
                channel = val
                    .get("author_name")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
            }
        }
    }

    Ok(YouTubeInspectResult {
        video_id,
        playlist_id,
        title,
        channel,
        duration_secs: None,
        formats: Vec::new(),
        entries: Vec::new(),
        drm_supported: DRM_SUPPORTED,
    })
}

async fn fetch_html_guarded(
    raw_url: &str,
    cookie_header: Option<&str>,
    policy: SecurityPolicy,
) -> Result<String, DownloaderError> {
    policy.validate_url(raw_url)?;
    let client = Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;

    let mut current = raw_url.to_string();
    for _hop in 0..5 {
        let mut req = client.get(&current);
        if let Some(c) = cookie_header.filter(|s| !s.trim().is_empty()) {
            if current.eq_ignore_ascii_case(raw_url) {
                req = req.header("Cookie", c);
            }
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(ToString::to_string);
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| DownloaderError::HttpStatus {
                    status,
                    detail: "redirect missing Location".into(),
                })?;
            let base = Url::parse(&current)
                .map_err(|e| DownloaderError::InvalidInput(e.to_string()))?;
            let next = base
                .join(loc)
                .map_err(|e| DownloaderError::InvalidInput(e.to_string()))?;
            let next_str = next.to_string();
            policy.validate_url(&next_str)?;
            if matches!(
                classify_http_response(status, &next_str, ct.as_deref(), ""),
                HttpGateClassification::AuthChallenge { .. }
            ) {
                return Err(DownloaderError::InvalidInput(
                    "MANUAL_VISIBLE_BROWSER_ONLY: challenge redirect detected".into(),
                ));
            }
            current = next_str;
            continue;
        }
        let bytes = resp.bytes().await?;
        let bounded = if bytes.len() > MAX_CRAWL_HTML_BYTES {
            &bytes[..MAX_CRAWL_HTML_BYTES]
        } else {
            &bytes[..]
        };
        let text = String::from_utf8_lossy(bounded).into_owned();
        if status >= 400 {
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!(
                    "crawler HTTP {status} on {}",
                    PrivacyShield::sanitize_for_receipt(&current)
                ),
            });
        }
        if matches!(
            classify_http_response(status, &current, ct.as_deref(), &text),
            HttpGateClassification::AuthChallenge { .. }
                | HttpGateClassification::SignInRequired { .. }
        ) {
            return Err(DownloaderError::InvalidInput(
                "MANUAL_VISIBLE_BROWSER_ONLY: login or challenge wall detected".into(),
            ));
        }
        return Ok(text);
    }
    Err(DownloaderError::InvalidInput(
        "crawler exceeded max redirect hops".into(),
    ))
}

struct RawHtmlLink {
    url: String,
    label: String,
    section: Option<String>,
}

fn scan_attribute_urls(html: &str) -> Vec<RawHtmlLink> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    for attr in ["href=", "src=", "data-url="] {
        let mut idx = 0usize;
        while let Some(pos) = lower[idx..].find(attr) {
            let start = idx + pos + attr.len();
            let rest = &html[start..];
            if let Some((val, consumed)) = extract_quoted_or_bare(rest) {
                if !val.is_empty() && !val.starts_with('#') && !val.starts_with("javascript:") {
                    out.push(RawHtmlLink {
                        url: val,
                        label: "Resource".to_string(),
                        section: None,
                    });
                }
                idx = start + consumed;
            } else {
                idx = start + 1;
            }
        }
    }
    out
}

fn extract_quoted_or_bare(rest: &str) -> Option<(String, usize)> {
    let b = rest.as_bytes();
    let first = *b.first()?;
    if first == b'"' || first == b'\'' {
        let end = rest[1..].find(first as char)?;
        return Some((rest[1..1 + end].trim().to_string(), end + 2));
    }
    let end = rest
        .find(|c: char| c.is_ascii_whitespace() || c == '>')
        .unwrap_or(rest.len());
    Some((rest[..end].trim().to_string(), end))
}

fn has_downloadable_extension(lower_url: &str) -> bool {
    let path = lower_url.split(['?', '#']).next().unwrap_or(lower_url);
    [
        ".pdf", ".docx", ".pptx", ".xlsx", ".zip", ".tar.gz", ".mp4", ".mkv", ".webm", ".m4a",
        ".mp3", ".m3u8", ".mpd", ".srt", ".vtt", ".csv",
    ]
    .iter()
    .any(|ext| path.ends_with(ext))
}

fn classify_moodle_category(lower_url: &str) -> String {
    if lower_url.ends_with(".m3u8") || lower_url.ends_with(".mpd") || lower_url.contains("video") {
        "media".to_string()
    } else if lower_url.contains(".pdf") || lower_url.contains("/mod/resource/") {
        "document".to_string()
    } else if lower_url.contains("/mod/folder/") {
        "folder".to_string()
    } else {
        "link".to_string()
    }
}

fn is_safe_yt_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn url_encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redos_guard_rejects_nested_quantifiers_and_allows_globs() {
        assert!(SafeFilterPattern::compile("(a+)+b").is_err());
        assert!(SafeFilterPattern::compile(&"a".repeat(300)).is_err());
        let pat = SafeFilterPattern::compile("*lecture*.pdf").expect("valid glob");
        assert!(pat.matches("https://lms.example.edu/files/Lecture_04_notes.pdf"));
        assert!(!pat.matches("https://lms.example.edu/files/syllabus.docx"));
    }

    #[test]
    fn moodle_extractor_filters_links_and_blocks_ssrf_targets() {
        let html = r#"
            <div class="course-content">
                <a href="https://lms.example.edu/pluginfile.php/123/mod_resource/content/1/week1.pdf">Week 1</a>
                <a href="http://169.254.169.254/latest/meta-data/iam.pdf">IMDS SSRF</a>
                <a href="/mod/folder/view.php?id=42">Folder</a>
            </div>
        "#;
        let links = extract_moodle_resources_from_html(
            html,
            "https://lms.example.edu/course/view.php?id=9",
            SecurityPolicy::strict(),
            None,
        )
        .expect("extract");
        assert_eq!(links.len(), 2);
        assert!(!links.iter().any(|l| l.url.contains("169.254.169.254")));
    }

    #[test]
    fn youtube_parser_handles_watch_short_and_blocks_drm() {
        let (v, l) =
            parse_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLtest123")
                .expect("parse yt");
        assert_eq!(v.as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(l.as_deref(), Some("PLtest123"));

        let drm_payload = serde_json::json!({
            "videoDetails": { "videoId": "abc123", "title": "Protected" },
            "streamingData": { "licenseInfos": [{ "drmFamily": "WIDEVINE" }] }
        });
        assert!(matches!(
            parse_youtube_player_json(&drm_payload, SecurityPolicy::strict()),
            Err(DownloaderError::DrmUnsupported { .. })
        ));
    }
}
