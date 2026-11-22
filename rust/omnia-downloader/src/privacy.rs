//! `ProviderRegistry` (23 providers / 10 categories), RFC 6265 `ScopedCookieJar`
//! with cross-origin strip, and raw `&`-segment CDN HMAC-safe `PrivacyShield`.

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDateTime, Utc};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::pacing::PacingMode;
use crate::types::DRM_SUPPORTED;

/// 10 canonical provider categories for OmniDrive Pro / OmniDownloader Pro.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCategory {
    CloudStorage,
    WorkspaceDocs,
    ObjectStorage,
    CdnEdge,
    CodeHosting,
    AiDatasets,
    AcademicLms,
    PackageRegistry,
    StreamingManifest,
    DirectHttp,
}

/// Static definition of a supported download provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderDefinition {
    pub id: String,
    pub name: String,
    pub category: ProviderCategory,
    pub host_patterns: Vec<String>,
    pub supports_ranges: bool,
    pub default_streams: usize,
    pub pacing_mode: PacingMode,
    /// Always `false` — commercial DRM decryption is strictly unsupported.
    pub drm_supported: bool,
}

/// Registry containing 23 built-in providers spanning 10 categories.
#[derive(Debug, Clone)]
pub struct ProviderRegistry {
    providers: Vec<ProviderDefinition>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderRegistry {
    /// Builds the default registry with 23 provider definitions across 10 categories.
    #[must_use]
    pub fn new() -> Self {
        let p = |id: &str,
                 name: &str,
                 category: ProviderCategory,
                 hosts: &[&str],
                 supports_ranges: bool,
                 default_streams: usize,
                 pacing_mode: PacingMode| ProviderDefinition {
            id: id.to_string(),
            name: name.to_string(),
            category,
            host_patterns: hosts.iter().map(|h| (*h).to_string()).collect(),
            supports_ranges,
            default_streams,
            pacing_mode,
            drm_supported: DRM_SUPPORTED,
        };

        let providers = vec![
            // 1. CloudStorage (4)
            p("google_drive", "Google Drive", ProviderCategory::CloudStorage, &["drive.google.com", "drive.usercontent.google.com", "www.googleapis.com"], true, 16, PacingMode::Adaptive),
            p("onedrive", "Microsoft OneDrive", ProviderCategory::CloudStorage, &["onedrive.live.com", "1drv.ms", "sharepoint.com"], true, 8, PacingMode::Adaptive),
            p("dropbox", "Dropbox", ProviderCategory::CloudStorage, &["dropbox.com", "dl.dropboxusercontent.com"], true, 16, PacingMode::Adaptive),
            p("box_cloud", "Box", ProviderCategory::CloudStorage, &["box.com", "dl.boxcloud.com"], true, 8, PacingMode::Adaptive),
            // 2. WorkspaceDocs (3)
            p("google_docs", "Google Docs Export", ProviderCategory::WorkspaceDocs, &["docs.google.com"], false, 1, PacingMode::Polite),
            p("google_sheets", "Google Sheets Export", ProviderCategory::WorkspaceDocs, &["sheets.google.com"], false, 1, PacingMode::Polite),
            p("google_slides", "Google Slides Export", ProviderCategory::WorkspaceDocs, &["slides.google.com"], false, 1, PacingMode::Polite),
            // 3. ObjectStorage (3)
            p("aws_s3", "Amazon S3", ProviderCategory::ObjectStorage, &["s3.amazonaws.com", ".s3.amazonaws.com", ".s3."], true, 32, PacingMode::Turbo),
            p("gcs", "Google Cloud Storage", ProviderCategory::ObjectStorage, &["storage.googleapis.com", "storage.cloud.google.com"], true, 32, PacingMode::Turbo),
            p("cloudflare_r2", "Cloudflare R2", ProviderCategory::ObjectStorage, &["r2.cloudflarestorage.com", "r2.dev"], true, 32, PacingMode::Turbo),
            // 4. CdnEdge (2)
            p("cloudfront", "Amazon CloudFront", ProviderCategory::CdnEdge, &["cloudfront.net"], true, 32, PacingMode::Turbo),
            p("akamai", "Akamai Edge CDN", ProviderCategory::CdnEdge, &["akamaized.net", "akamaihd.net", "edgesuite.net"], true, 16, PacingMode::Adaptive),
            // 5. CodeHosting (2)
            p("github_releases", "GitHub Releases", ProviderCategory::CodeHosting, &["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"], true, 16, PacingMode::Adaptive),
            p("gitlab_artifacts", "GitLab Artifacts", ProviderCategory::CodeHosting, &["gitlab.com"], true, 8, PacingMode::Adaptive),
            // 6. AiDatasets (2)
            p("huggingface_hub", "Hugging Face Hub", ProviderCategory::AiDatasets, &["huggingface.co", "hf.co", "cdn-lfs.hf.co"], true, 32, PacingMode::Turbo),
            p("kaggle_datasets", "Kaggle Datasets", ProviderCategory::AiDatasets, &["kaggle.com", "storage.googleapis.com/kaggle-data-sets"], true, 8, PacingMode::Adaptive),
            // 7. AcademicLms (2)
            p("arxiv", "arXiv Preprints", ProviderCategory::AcademicLms, &["arxiv.org", "export.arxiv.org"], true, 2, PacingMode::Polite),
            p("moodle_lms", "Moodle LMS", ProviderCategory::AcademicLms, &["moodle.org", "moodlecloud.com"], true, 4, PacingMode::Polite),
            // 8. PackageRegistry (2)
            p("pypi", "PyPI / Python Hosted", ProviderCategory::PackageRegistry, &["files.pythonhosted.org", "pypi.org"], true, 8, PacingMode::Adaptive),
            p("npm_registry", "npm Registry", ProviderCategory::PackageRegistry, &["registry.npmjs.org"], true, 8, PacingMode::Adaptive),
            // 9. StreamingManifest (2)
            p("hls_m3u8", "HLS Media Playlist (.m3u8)", ProviderCategory::StreamingManifest, &[".m3u8"], false, 8, PacingMode::Adaptive),
            p("dash_mpd", "MPEG-DASH Manifest (.mpd)", ProviderCategory::StreamingManifest, &[".mpd"], true, 8, PacingMode::Adaptive),
            // 10. DirectHttp (1)
            p("generic_http", "Direct HTTP/HTTPS", ProviderCategory::DirectHttp, &["*"], true, 16, PacingMode::Adaptive),
        ];

        Self { providers }
    }

    /// Returns all registered provider definitions.
    #[must_use]
    pub fn list(&self) -> &[ProviderDefinition] {
        &self.providers
    }

    /// Distinct categories represented in this registry.
    #[must_use]
    pub fn categories(&self) -> Vec<ProviderCategory> {
        let mut cats: Vec<ProviderCategory> = self.providers.iter().map(|p| p.category).collect();
        cats.sort();
        cats.dedup();
        cats
    }

    /// Resolves the best-matching provider definition for `raw_url`.
    #[must_use]
    pub fn resolve_url(&self, raw_url: &str) -> &ProviderDefinition {
        let lower = raw_url.to_ascii_lowercase();
        let host = Url::parse(raw_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default();
        let path_part = lower.split('?').next().unwrap_or(&lower);

        // Check streaming manifest extensions first.
        if path_part.ends_with(".m3u8") {
            if let Some(p) = self.providers.iter().find(|p| p.id == "hls_m3u8") {
                return p;
            }
        }
        if path_part.ends_with(".mpd") {
            if let Some(p) = self.providers.iter().find(|p| p.id == "dash_mpd") {
                return p;
            }
        }

        // Docs/Sheets/Slides path disambiguation on docs.google.com
        if host == "docs.google.com" {
            if path_part.contains("/spreadsheets/") {
                if let Some(p) = self.providers.iter().find(|p| p.id == "google_sheets") {
                    return p;
                }
            } else if path_part.contains("/presentation/") {
                if let Some(p) = self.providers.iter().find(|p| p.id == "google_slides") {
                    return p;
                }
            } else if let Some(p) = self.providers.iter().find(|p| p.id == "google_docs") {
                return p;
            }
        }

        for def in &self.providers {
            if def.id == "generic_http" {
                continue;
            }
            for pat in &def.host_patterns {
                if pat.starts_with('.') && pat.ends_with('.') {
                    if host.contains(pat.as_str()) {
                        return def;
                    }
                } else if host == *pat || host.ends_with(&format!(".{pat}")) {
                    return def;
                }
            }
        }

        self.providers
            .iter()
            .find(|p| p.id == "generic_http")
            .expect("generic_http always registered")
    }
}

/// Known analytics / tracking query keys stripped by [`PrivacyShield::sanitize_live_url`]
/// without disturbing CDN HMAC parameters.
const TRACKING_QUERY_KEYS: &[&str] = &[
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_reader",
    "utm_name",
    "fbclid",
    "gclid",
    "dclid",
    "yclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "_ga",
    "_gl",
    "spm",
    "ref_src",
    "si",
];

/// Secret/signed query keys redacted in receipts (logs, SQLite, UI).
const RECEIPT_SECRET_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "auth",
    "authorization",
    "key",
    "api_key",
    "apikey",
    "secret",
    "client_secret",
    "password",
    "passwd",
    "sig",
    "signature",
    "policy",
    "key-pair-id",
    "hdnts",
    "hdnea",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "x-goog-signature",
    "x-goog-credential",
    "x-goog-api-key",
    "cookie",
    "session",
    "sid",
];

/// CDN HMAC-safe raw `&`-segment URL privacy shield & cross-origin header guard.
pub struct PrivacyShield;

impl PrivacyShield {
    /// Strips tracking query parameters (`utm_*`, `fbclid`, `gclid`, etc.) by slicing
    /// the raw `&`-delimited query string directly — NEVER percent-decoding or re-encoding
    /// remaining segments so Akamai (`~`, `/`, `*`), CloudFront (`Policy`, `Signature`),
    /// AWS SigV4 (`X-Amz-Credential=a/b/c`), and GCS HMAC signatures stay byte-exact!
    #[must_use]
    pub fn sanitize_live_url(raw_url: &str) -> String {
        let (before_frag, frag) = match raw_url.split_once('#') {
            Some((b, f)) => (b, Some(f)),
            None => (raw_url, None),
        };
        let Some((base, raw_query)) = before_frag.split_once('?') else {
            return raw_url.to_string();
        };

        let mut kept: Vec<&str> = Vec::new();
        for segment in raw_query.split('&') {
            if segment.is_empty() {
                continue;
            }
            let key = segment.split_once('=').map_or(segment, |(k, _)| k);
            let key_low = key.to_ascii_lowercase();
            if is_tracking_key(&key_low) {
                continue;
            }
            // Keep raw segment untouched (preserves `~`, `/`, `+`, `=`, `%2F`, etc.)!
            kept.push(segment);
        }

        let mut out = if kept.is_empty() {
            base.to_string()
        } else {
            format!("{base}?{}", kept.join("&"))
        };
        if let Some(f) = frag {
            out.push('#');
            out.push_str(f);
        }
        out
    }

    /// Produces a secret-free URL safe for logs, SQLite, `.part.meta`, and Studio API receipts:
    /// strips tracking params, redacts signed/secret query values to `[REDACTED]`, and drops fragments.
    #[must_use]
    pub fn sanitize_for_receipt(raw_url: &str) -> String {
        let without_frag = raw_url.split_once('#').map_or(raw_url, |(b, _)| b);
        let Some((base, raw_query)) = without_frag.split_once('?') else {
            return strip_userinfo_from_base(without_frag);
        };
        let clean_base = strip_userinfo_from_base(base);
        let mut parts: Vec<String> = Vec::new();
        for segment in raw_query.split('&') {
            if segment.is_empty() {
                continue;
            }
            if let Some((key, _val)) = segment.split_once('=') {
                let low = key.to_ascii_lowercase();
                if is_tracking_key(&low) {
                    continue;
                }
                if is_receipt_secret_key(&low) {
                    parts.push(format!("{key}=[REDACTED]"));
                } else {
                    parts.push(segment.to_string());
                }
            } else if !is_tracking_key(&segment.to_ascii_lowercase()) {
                parts.push(segment.to_string());
            }
        }
        if parts.is_empty() {
            clean_base
        } else {
            format!("{clean_base}?{}", parts.join("&"))
        }
    }

    /// Returns `true` when two URLs share identical `(scheme, host, effective_port)`.
    #[must_use]
    pub fn is_same_origin(a: &Url, b: &Url) -> bool {
        a.scheme().eq_ignore_ascii_case(b.scheme())
            && a.host_str().map(str::to_ascii_lowercase)
                == b.host_str().map(str::to_ascii_lowercase)
            && a.port_or_known_default() == b.port_or_known_default()
    }

    /// Strips sensitive headers (`Authorization`, `Cookie`, `Proxy-Authorization`) when
    /// navigating or redirecting across different origins.
    #[must_use]
    pub fn filter_headers_for_target(
        headers: &BTreeMap<String, String>,
        origin_url: &Url,
        target_url: &Url,
    ) -> BTreeMap<String, String> {
        if Self::is_same_origin(origin_url, target_url) {
            return headers.clone();
        }
        headers
            .iter()
            .filter(|(k, _)| {
                let low = k.to_ascii_lowercase();
                !matches!(
                    low.as_str(),
                    "authorization" | "cookie" | "proxy-authorization" | "x-api-key" | "x-goog-api-key"
                )
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

fn is_tracking_key(low: &str) -> bool {
    TRACKING_QUERY_KEYS.contains(&low) || low.starts_with("utm_")
}

fn is_receipt_secret_key(low: &str) -> bool {
    RECEIPT_SECRET_KEYS.contains(&low)
        || low.ends_with("_token")
        || low.ends_with("_secret")
        || low.ends_with("_key")
        || low.ends_with("_sig")
        || low.ends_with("_signature")
        || low.starts_with("x-amz-")
        || low.starts_with("x-goog-")
}

fn strip_userinfo_from_base(base: &str) -> String {
    let Some((scheme, rest)) = base.split_once("://") else {
        return base.to_string();
    };
    let auth_end = rest.find('/').unwrap_or(rest.len());
    let auth = &rest[..auth_end];
    let path = &rest[auth_end..];
    if let Some((_, host_port)) = auth.rsplit_once('@') {
        format!("{scheme}://{host_port}{path}")
    } else {
        base.to_string()
    }
}

/// Public suffix list guard preventing overly broad cookies (e.g. `Domain=.com` or `Domain=.co.uk`).
const PUBLIC_SUFFIXES: &[&str] = &[
    "com",
    "org",
    "net",
    "edu",
    "gov",
    "io",
    "dev",
    "app",
    "co",
    "uk",
    "co.uk",
    "org.uk",
    "ac.uk",
    "com.au",
    "com.vn",
    "edu.vn",
    "gov.vn",
    "co.jp",
    "ne.jp",
    "googleapis.com",
    "googleusercontent.com",
    "amazonaws.com",
    "cloudfront.net",
    "github.io",
    "pages.dev",
    "r2.dev",
];

/// A single RFC 6265 scoped HTTP cookie stored in memory only (never serialized to logs/receipts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub host_only: bool,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub expires_epoch_secs: Option<i64>,
}

/// RFC 6265 / 6265bis scoped in-memory cookie jar enforcing strict origin/domain/path/Secure
/// isolation and cross-origin cookie stripping.
#[derive(Debug, Default)]
pub struct ScopedCookieJar {
    cookies: RwLock<Vec<ScopedCookie>>,
}

impl ScopedCookieJar {
    /// Creates an empty scoped cookie jar.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Stores a cookie parsed from an HTTP `Set-Cookie` header received from `origin_url`.
    /// Returns `true` if accepted, or `false` if rejected by RFC 6265 domain/PSL/security checks.
    pub fn store_set_cookie(&self, origin_url: &Url, set_cookie_header: &str) -> bool {
        self.store_set_cookie_at(origin_url, set_cookie_header, Utc::now().timestamp())
    }

    /// Deterministic variant of [`Self::store_set_cookie`] taking an explicit `now_epoch_secs`.
    pub fn store_set_cookie_at(
        &self,
        origin_url: &Url,
        set_cookie_header: &str,
        now_epoch_secs: i64,
    ) -> bool {
        let Some(origin_host) = origin_url.host_str().map(str::to_ascii_lowercase) else {
            return false;
        };
        let is_https = origin_url.scheme().eq_ignore_ascii_case("https");

        let mut parts = set_cookie_header.split(';');
        let Some(name_val) = parts.next() else {
            return false;
        };
        let Some((raw_name, raw_val)) = name_val.split_once('=') else {
            return false;
        };
        let name = raw_name.trim();
        let value = raw_val.trim();
        if name.is_empty()
            || name.bytes().any(|b| b <= 0x20 || b == 0x7F || b == b';')
            || value.bytes().any(|b| b < 0x20 || b == 0x7F)
        {
            return false;
        }

        let mut domain_attr: Option<String> = None;
        let mut path_attr: Option<String> = None;
        let mut secure = false;
        let mut http_only = false;
        let mut expires_epoch_secs: Option<i64> = None;
        let mut has_max_age = false;

        for attr in parts {
            let trimmed = attr.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some((k, v)) = trimmed.split_once('=') {
                let kl = k.trim().to_ascii_lowercase();
                let vv = v.trim();
                match kl.as_str() {
                    "domain" => {
                        let cleaned = vv.trim_start_matches('.').to_ascii_lowercase();
                        if !cleaned.is_empty() {
                            domain_attr = Some(cleaned);
                        }
                    }
                    "path" if vv.starts_with('/') => {
                        path_attr = Some(vv.to_string());
                    }
                    "max-age" => {
                        if let Ok(secs) = vv.parse::<i64>() {
                            has_max_age = true;
                            expires_epoch_secs = Some(if secs <= 0 {
                                i64::MIN
                            } else {
                                now_epoch_secs.saturating_add(secs)
                            });
                        }
                    }
                    "expires" if !has_max_age => {
                        if let Some(ts) = parse_cookie_expires(vv) {
                            expires_epoch_secs = Some(ts);
                        }
                    }
                    _ => {}
                }
            } else {
                match trimmed.to_ascii_lowercase().as_str() {
                    "secure" => secure = true,
                    "httponly" => http_only = true,
                    _ => {}
                }
            }
        }

        // RFC 6265bis cookie prefixes: `__Secure-` requires Secure + HTTPS; `__Host-` requires Secure + HTTPS + no Domain + Path=/
        if name.starts_with("__Secure-") && (!secure || !is_https) {
            return false;
        }
        if name.starts_with("__Host-")
            && (!secure || !is_https || domain_attr.is_some() || path_attr.as_deref() != Some("/"))
        {
            return false;
        }

        let (domain, host_only) = match domain_attr {
            Some(dom) => {
                // Reject public suffixes and cross-domain cookie planting!
                if is_public_suffix(&dom) || !domain_matches(&origin_host, &dom) {
                    return false;
                }
                (dom, false)
            }
            None => (origin_host, true),
        };

        let path = path_attr.unwrap_or_else(|| default_cookie_path(origin_url.path()));
        let cookie = ScopedCookie {
            name: name.to_string(),
            value: value.to_string(),
            domain,
            host_only,
            path,
            secure,
            http_only,
            expires_epoch_secs,
        };

        let mut jar = self.cookies.write();
        jar.retain(|c| {
            !(c.name == cookie.name && c.domain == cookie.domain && c.path == cookie.path)
        });
        if cookie
            .expires_epoch_secs
            .is_none_or(|exp| exp > now_epoch_secs)
        {
            jar.push(cookie);
        }
        true
    }

    /// Builds an RFC 6265 `Cookie` header value for `target_url`, automatically stripping
    /// cookies that belong to other origins/domains, mismatched paths, expired cookies,
    /// or `Secure` cookies when `target_url` is plain `http://`.
    ///
    /// If `previous_origin` is provided and differs from `target_url`'s registrable host scope,
    /// cross-origin cookies from `previous_origin` are strictly excluded.
    #[must_use]
    pub fn cookie_header_for(
        &self,
        target_url: &Url,
        previous_origin: Option<&Url>,
    ) -> Option<String> {
        self.cookie_header_for_at(target_url, previous_origin, Utc::now().timestamp())
    }

    /// Deterministic variant of [`Self::cookie_header_for`] at explicit `now_epoch_secs`.
    #[must_use]
    pub fn cookie_header_for_at(
        &self,
        target_url: &Url,
        previous_origin: Option<&Url>,
        now_epoch_secs: i64,
    ) -> Option<String> {
        let target_host = target_url.host_str()?.to_ascii_lowercase();
        let is_https = target_url.scheme().eq_ignore_ascii_case("https");
        let target_path = target_url.path();

        // Cross-origin redirect guard: if redirecting away from `previous_origin` to an unrelated
        // host that does not domain-match, never leak cookies across domains.
        let cross_origin_strip_domain = previous_origin
            .and_then(|prev| prev.host_str().map(str::to_ascii_lowercase))
            .filter(|prev_host| {
                prev_host != &target_host
                    && !domain_matches(&target_host, prev_host)
                    && !domain_matches(prev_host, &target_host)
            });

        let jar = self.cookies.read();
        let mut matched: Vec<&ScopedCookie> = jar
            .iter()
            .filter(|c| {
                if let Some(exp) = c.expires_epoch_secs {
                    if exp <= now_epoch_secs {
                        return false;
                    }
                }
                if c.secure && !is_https {
                    return false;
                }
                if let Some(ref stripped_prev) = cross_origin_strip_domain {
                    if domain_matches(stripped_prev, &c.domain) {
                        return false;
                    }
                }
                let host_ok = if c.host_only {
                    target_host == c.domain
                } else {
                    domain_matches(&target_host, &c.domain)
                };
                host_ok && path_matches(target_path, &c.path)
            })
            .collect();

        if matched.is_empty() {
            return None;
        }
        // RFC 6265 §5.4: longer paths come first.
        matched.sort_by(|a, b| b.path.len().cmp(&a.path.len()).then(a.name.cmp(&b.name)));
        let header = matched
            .into_iter()
            .map(|c| format!("{}={}", c.name, c.value))
            .collect::<Vec<_>>()
            .join("; ");
        Some(header)
    }

    /// Number of stored cookies currently in the jar.
    #[must_use]
    pub fn len(&self) -> usize {
        self.cookies.read().len()
    }

    /// Returns `true` if no cookies are stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.cookies.read().is_empty()
    }

    /// Clears all cookies from memory.
    pub fn clear(&self) {
        self.cookies.write().clear();
    }
}

fn is_public_suffix(domain: &str) -> bool {
    let low = domain.trim_matches('.').to_ascii_lowercase();
    !low.contains('.') || PUBLIC_SUFFIXES.contains(&low.as_str())
}

fn domain_matches(host: &str, domain: &str) -> bool {
    if host == domain {
        return true;
    }
    host.len() > domain.len()
        && host.ends_with(domain)
        && host.as_bytes()[host.len() - domain.len() - 1] == b'.'
}

fn path_matches(request_path: &str, cookie_path: &str) -> bool {
    if request_path == cookie_path {
        return true;
    }
    if request_path.starts_with(cookie_path) {
        return cookie_path.ends_with('/')
            || request_path.as_bytes().get(cookie_path.len()) == Some(&b'/');
    }
    false
}

fn default_cookie_path(uri_path: &str) -> String {
    if !uri_path.starts_with('/') {
        return "/".to_string();
    }
    match uri_path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(idx) => uri_path[..idx].to_string(),
    }
}

fn parse_cookie_expires(raw: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc2822(raw) {
        return Some(dt.timestamp());
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%a, %d %b %Y %H:%M:%S GMT") {
        return Some(naive.and_utc().timestamp());
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%a, %d-%b-%Y %H:%M:%S GMT") {
        return Some(naive.and_utc().timestamp());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_registry_has_exact_23_providers_across_10_categories() {
        let reg = ProviderRegistry::new();
        assert_eq!(reg.list().len(), 23);
        assert_eq!(reg.categories().len(), 10);
        assert!(reg.list().iter().all(|p| !p.drm_supported));

        assert_eq!(
            reg.resolve_url("https://drive.google.com/file/d/abc123456789/view").id,
            "google_drive"
        );
        assert_eq!(
            reg.resolve_url("https://docs.google.com/spreadsheets/d/abc123456789/edit").id,
            "google_sheets"
        );
        assert_eq!(
            reg.resolve_url("https://cdn.example.org/video/master.m3u8?hdnts=abc").id,
            "hls_m3u8"
        );
        assert_eq!(
            reg.resolve_url("https://cdn.example.org/stream/manifest.mpd").id,
            "dash_mpd"
        );
        assert_eq!(
            reg.resolve_url("https://unknown.example.org/file.bin").id,
            "generic_http"
        );
    }

    #[test]
    fn privacy_shield_preserves_akamai_cloudfront_sigv4_hmac_tokens_byte_exact() {
        let akamai = "https://media.akamaized.net/path/file.mp4?hdnts=exp=1799999999~acl=/*~hmac=deadbeef1234&utm_source=twitter&fbclid=xyz999";
        let cleaned = PrivacyShield::sanitize_live_url(akamai);
        assert_eq!(
            cleaned,
            "https://media.akamaized.net/path/file.mp4?hdnts=exp=1799999999~acl=/*~hmac=deadbeef1234"
        );

        let sigv4 = "https://bucket.s3.amazonaws.com/a.bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE/20261122/us-east-1/s3/aws4_request&X-Amz-Signature=abc123&gclid=dropme";
        let cleaned_s3 = PrivacyShield::sanitize_live_url(sigv4);
        assert!(cleaned_s3.contains("X-Amz-Credential=AKIAEXAMPLE/20261122/us-east-1/s3/aws4_request"));
        assert!(cleaned_s3.contains("X-Amz-Signature=abc123"));
        assert!(!cleaned_s3.contains("gclid"));

        // Receipt sanitizer MUST redact signed values while retaining parameter names.
        let receipt = PrivacyShield::sanitize_for_receipt(sigv4);
        assert!(receipt.contains("X-Amz-Signature=[REDACTED]"));
        assert!(receipt.contains("X-Amz-Credential=[REDACTED]"));
        assert!(!receipt.contains("abc123"));
    }

    #[test]
    fn scoped_cookie_jar_enforces_rfc6265_and_cross_origin_strip() {
        let jar = ScopedCookieJar::new();
        let drive_url = Url::parse("https://drive.google.com/uc?id=abc").unwrap();
        let sub_url = Url::parse("https://sub.drive.google.com/download").unwrap();
        let http_drive = Url::parse("http://drive.google.com/uc").unwrap();
        let third_party = Url::parse("https://cdn.example.net/payload.bin").unwrap();

        // Reject public suffix planting!
        assert!(!jar.store_set_cookie_at(&drive_url, "evil=1; Domain=.com", 1_000));
        // Reject cross-domain planting!
        assert!(!jar.store_set_cookie_at(&drive_url, "evil=1; Domain=example.net", 1_000));
        // Accept valid Secure cookie on drive.google.com
        assert!(jar.store_set_cookie_at(
            &drive_url,
            "session_pref=ok; Domain=drive.google.com; Path=/; Secure; HttpOnly; Max-Age=3600",
            1_000
        ));
        // Accept host-only cookie
        assert!(jar.store_set_cookie_at(&drive_url, "host_only=yes; Path=/uc", 1_000));

        // Same HTTPS origin gets both cookies (longer path first)
        let hdr = jar.cookie_header_for_at(&drive_url, None, 1_100).unwrap();
        assert_eq!(hdr, "host_only=yes; session_pref=ok");

        // Subdomain gets only Domain cookie, NOT host-only cookie
        let sub_hdr = jar.cookie_header_for_at(&sub_url, None, 1_100).unwrap();
        assert_eq!(sub_hdr, "session_pref=ok");

        // Plain HTTP MUST NOT receive Secure cookie
        let http_hdr = jar.cookie_header_for_at(&http_drive, None, 1_100).unwrap();
        assert_eq!(http_hdr, "host_only=yes");

        // Cross-origin target receives ZERO cookies from drive.google.com!
        assert_eq!(
            jar.cookie_header_for_at(&third_party, Some(&drive_url), 1_100),
            None
        );

        // Expired cookie disappears after Max-Age
        assert_eq!(jar.cookie_header_for_at(&sub_url, None, 5_000), None);
    }
}
