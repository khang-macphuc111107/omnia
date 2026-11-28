//! Browser-captured network media classification, fragment suppression, and volatile-param deduplication.
//!
//! Pure Rust (`#![forbid(unsafe_code)]`), porting `omnia-download/src/detect.rs` cleanly without extra crate deps.

use serde::{Deserialize, Serialize};
use url::Url;

use crate::types::DRM_SUPPORTED;

const MIN_MEDIA_BYTES: u64 = 64 * 1024;
const MIN_IMAGE_BYTES: u64 = 256 * 1024;

/// Volatile query parameter keys stripped when generating canonical stream deduplication keys.
const VOLATILE_QUERY_KEYS: &[&str] = &[
    "expires",
    "expire",
    "exp",
    "token",
    "auth",
    "hdnts",
    "hdnea",
    "sig",
    "signature",
    "policy",
    "key-pair-id",
    "range",
    "rn",
    "rbuf",
    "sq",
    "dur",
    "ei",
    "id",
    "lmt",
    "ip",
    "c",
    "mv",
    "mvi",
    "pl",
    "sparams",
    "x-amz-algorithm",
    "x-amz-credential",
    "x-amz-date",
    "x-amz-expires",
    "x-amz-signedheaders",
    "x-amz-signature",
    "x-amz-security-token",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
];

/// Classified kind of a browser-sniffed media or file response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectedMediaKind {
    Hls,
    Dash,
    Video,
    Audio,
    Pdf,
    Archive,
    Document,
    Image,
    Other,
}

/// Structured browser-sniffer candidate record safe for Studio/UI presentation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedMediaCandidate {
    pub url: String,
    pub dedupe_key: String,
    pub kind: DetectedMediaKind,
    pub mime_type: Option<String>,
    pub content_length: Option<u64>,
    pub drm_supported: bool,
}

/// Generates a stable deduplication key by removing fragment + volatile CDN/tracking query parameters.
#[must_use]
pub fn media_dedupe_key(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    let Ok(mut parsed) = Url::parse(trimmed) else {
        return trimmed.split('#').next().unwrap_or(trimmed).to_string();
    };
    parsed.set_fragment(None);
    let kept: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| {
            let low = k.to_ascii_lowercase();
            !VOLATILE_QUERY_KEYS.contains(&low.as_str())
                && !low.starts_with("utm_")
                && !low.starts_with("x-amz-")
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        parsed.set_query(None);
    } else {
        let mut pairs = parsed.query_pairs_mut();
        pairs.clear();
        for (k, v) in kept {
            pairs.append_pair(&k, &v);
        }
    }
    parsed.to_string()
}

fn looks_like_transport_fragment(path_low: &str) -> bool {
    if path_low.ends_with(".ts")
        || path_low.ends_with(".m4s")
        || path_low.ends_with(".cmfv")
        || path_low.ends_with(".cmfa")
        || path_low.ends_with(".m4f")
    {
        return true;
    }
    let file_part = path_low.rsplit('/').next().unwrap_or(path_low);
    file_part.starts_with("seg-")
        || file_part.starts_with("seg_")
        || file_part.starts_with("frag-")
        || file_part.starts_with("chunk-")
        || file_part.starts_with("init-")
        || file_part.starts_with("init.")
}

/// Classifies a captured HTTP/Browser resource, suppressing small fragments, beacons, and tiny thumbnails.
#[must_use]
pub fn classify_captured_media(
    raw_url: &str,
    mime_type: Option<&str>,
    content_length: Option<u64>,
) -> Option<DetectedMediaCandidate> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" && scheme != "blob" {
        return None;
    }

    let path_low = parsed.path().to_ascii_lowercase();
    let mime_low = mime_type.map(|m| {
        m.split(';')
            .next()
            .unwrap_or(m)
            .trim()
            .to_ascii_lowercase()
    });

    if looks_like_transport_fragment(&path_low) {
        return None;
    }

    let kind = if path_low.ends_with(".m3u8")
        || mime_low
            .as_deref()
            .is_some_and(|m| m == "application/vnd.apple.mpegurl" || m == "application/x-mpegurl")
    {
        DetectedMediaKind::Hls
    } else if path_low.ends_with(".mpd")
        || mime_low
            .as_deref()
            .is_some_and(|m| m == "application/dash+xml")
    {
        DetectedMediaKind::Dash
    } else if mime_low.as_deref().is_some_and(|m| m.starts_with("video/"))
        || [".mp4", ".m4v", ".webm", ".mkv", ".mov", ".flv", ".avi"]
            .iter()
            .any(|ext| path_low.ends_with(ext))
    {
        if content_length.is_some_and(|n| n > 0 && n < MIN_MEDIA_BYTES) {
            return None;
        }
        DetectedMediaKind::Video
    } else if mime_low.as_deref().is_some_and(|m| m.starts_with("audio/"))
        || [".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"]
            .iter()
            .any(|ext| path_low.ends_with(ext))
    {
        if content_length.is_some_and(|n| n > 0 && n < MIN_MEDIA_BYTES) {
            return None;
        }
        DetectedMediaKind::Audio
    } else if path_low.ends_with(".pdf") || mime_low.as_deref() == Some("application/pdf") {
        DetectedMediaKind::Pdf
    } else if [".zip", ".7z", ".rar", ".tar", ".gz", ".xz"]
        .iter()
        .any(|ext| path_low.ends_with(ext))
    {
        DetectedMediaKind::Archive
    } else if [".docx", ".xlsx", ".pptx", ".csv", ".epub"]
        .iter()
        .any(|ext| path_low.ends_with(ext))
    {
        DetectedMediaKind::Document
    } else if mime_low.as_deref().is_some_and(|m| m.starts_with("image/"))
        || [".png", ".jpg", ".jpeg", ".webp", ".avif"]
            .iter()
            .any(|ext| path_low.ends_with(ext))
    {
        if content_length.is_none_or(|n| n < MIN_IMAGE_BYTES) {
            return None;
        }
        DetectedMediaKind::Image
    } else {
        return None;
    };

    Some(DetectedMediaCandidate {
        url: trimmed.to_string(),
        dedupe_key: media_dedupe_key(trimmed),
        kind,
        mime_type: mime_low,
        content_length,
        drm_supported: DRM_SUPPORTED,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_fragments_tiny_assets_and_dedupes_volatile_tokens() {
        assert!(
            classify_captured_media("https://cdn.example.org/hls/seg_001.ts", Some("video/mp2t"), Some(200_000))
                .is_none()
        );
        assert!(
            classify_captured_media("https://cdn.example.org/video/init-0.m4s", Some("video/mp4"), Some(1200))
                .is_none()
        );
        assert!(
            classify_captured_media("https://cdn.example.org/thumb.jpg", Some("image/jpeg"), Some(12_000))
                .is_none()
        );

        let hls = classify_captured_media(
            "https://cdn.example.org/live/master.m3u8?hdnts=exp=123~hmac=deadbeef&utm_source=x",
            Some("application/vnd.apple.mpegurl"),
            None,
        )
        .unwrap();
        assert_eq!(hls.kind, DetectedMediaKind::Hls);
        assert_eq!(hls.dedupe_key, "https://cdn.example.org/live/master.m3u8");
        assert!(!hls.drm_supported);
    }
}
