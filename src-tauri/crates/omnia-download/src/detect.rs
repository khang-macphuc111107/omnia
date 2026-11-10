//! Classification of captured network responses for the "media found" list.
//!
//! Only used for listing; `dedupe_key` is for grouping in the UI and must never be used
//! to fetch (volatile query parameters are removed from it).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DetectedKind {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub kind: DetectedKind,
    pub url: String,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    /// Lower-case extension without dot, if the URL path has one.
    pub extension: Option<String>,
    /// Suggested file name (Content-Disposition or URL path).
    pub file_name: Option<String>,
    /// HLS / DASH manifest (needs the stream pipeline rather than a plain download).
    pub is_manifest: bool,
    /// URL with volatile query parameters removed. Grouping only.
    pub dedupe_key: String,
}

const MIN_MEDIA_BYTES: u64 = 64 * 1024;
const MIN_IMAGE_BYTES: u64 = 256 * 1024;

const VOLATILE_PARAMS: &[&str] = &[
    "range",
    "bytestart",
    "byteend",
    "start",
    "end",
    "rn",
    "rbuf",
    "expires",
    "expire",
    "exp",
    "e",
    "st",
    "token",
    "signature",
    "sig",
    "policy",
    "key-pair-id",
    "hdnts",
    "hdnea",
    "auth",
    "_",
    "t",
    "ts",
    "timestamp",
    "cachebust",
    "x-amz-signature",
    "x-amz-date",
    "x-amz-expires",
    "x-amz-credential",
    "x-amz-security-token",
    "x-amz-algorithm",
    "x-amz-signedheaders",
];

fn ext_kind(ext: &str) -> Option<DetectedKind> {
    use DetectedKind::*;
    Some(match ext {
        "m3u8" | "m3u" => Hls,
        "mpd" => Dash,
        "mp4" | "m4v" | "webm" | "mkv" | "mov" | "avi" | "flv" | "wmv" | "ogv" | "3gp" | "mpg"
        | "mpeg" => Video,
        "mp3" | "m4a" | "aac" | "flac" | "wav" | "ogg" | "oga" | "opus" | "wma" | "weba" => Audio,
        "pdf" => Pdf,
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" => Archive,
        "exe" | "msi" | "iso" | "dmg" | "apk" | "deb" | "rpm" | "pkg" | "appimage" => Other,
        "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" | "csv" | "odt" | "ods" | "odp"
        | "rtf" | "epub" => Document,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "avif" => Image,
        _ => return None,
    })
}

fn mime_kind(mime: &str) -> Option<DetectedKind> {
    use DetectedKind::*;
    let m = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(match m.as_str() {
        "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/mpegurl"
        | "audio/x-mpegurl" => Hls,
        "application/dash+xml" => Dash,
        "application/pdf" => Pdf,
        "application/zip"
        | "application/x-zip-compressed"
        | "application/x-rar-compressed"
        | "application/vnd.rar"
        | "application/x-7z-compressed"
        | "application/gzip"
        | "application/x-gzip"
        | "application/x-tar"
        | "application/x-bzip2"
        | "application/x-xz"
        | "application/zstd" => Archive,
        "application/x-msdownload"
        | "application/x-msi"
        | "application/x-iso9660-image"
        | "application/x-apple-diskimage"
        | "application/vnd.android.package-archive"
        | "application/x-dosexec" => Other,
        "text/csv"
        | "application/msword"
        | "application/vnd.ms-excel"
        | "application/vnd.ms-powerpoint"
        | "application/rtf"
        | "application/epub+zip"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Document,
        "video/mp2t" | "video/mp2ts" => return None, // HLS transport segments
        "image/svg+xml" => return None,
        s if s.starts_with("video/") => Video,
        s if s.starts_with("audio/") => Audio,
        s if s.starts_with("image/") => Image,
        _ => return None,
    })
}

fn is_manifest_segment(path: &str, ext: Option<&str>, content_type: Option<&str>) -> bool {
    let ct = content_type
        .map(|c| c.to_ascii_lowercase())
        .unwrap_or_default();
    if ct.starts_with("video/mp2t") {
        return true;
    }
    if let Some("ts" | "m4s" | "m4f" | "cmfv" | "cmfa" | "cmft" | "fmp4") = ext {
        return true;
    }
    let file = path.rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    let stem = file.rsplit_once('.').map_or(file.as_str(), |(s, _)| s);
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in stem.chars() {
        if c.is_ascii_alphabetic() {
            cur.push(c);
        } else {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    let has_key = tokens
        .iter()
        .any(|t| ["seg", "segment", "frag", "fragment", "chunk", "init"].contains(&t.as_str()));
    let segmenty =
        has_key && (stem.chars().any(|c| c.is_ascii_digit()) || tokens.iter().any(|t| t == "init"));
    match ext {
        // .aac / small mp4 fragments are only treated as segments when they look like them.
        Some("aac" | "mp4" | "m4a" | "m4v" | "mp3") => segmenty,
        _ => false,
    }
}

/// Remove volatile query parameters and fragment, lower-case scheme/host, sort remaining params.
pub fn dedupe_key(url: &str) -> String {
    let Ok(mut u) = url::Url::parse(url) else {
        return url.to_string();
    };
    u.set_fragment(None);
    let mut kept: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| !VOLATILE_PARAMS.contains(&k.to_ascii_lowercase().as_str()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    kept.sort();
    if kept.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(kept);
    }
    u.to_string()
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// Classify a response. Returns `None` for things not worth listing (pages, scripts, fonts,
/// tiny media, HLS/DASH fragments, ...).
pub fn classify(
    url: &str,
    content_type: Option<&str>,
    content_length: Option<u64>,
    response_headers: &[(String, String)],
) -> Option<Detected> {
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let path = parsed.path().to_ascii_lowercase();
    let ext = path
        .rsplit('/')
        .next()
        .and_then(|f| f.rsplit_once('.'))
        .map(|(_, e)| e.to_string())
        .filter(|e| !e.is_empty() && e.len() <= 8);
    let content_type = content_type.or_else(|| header(response_headers, "content-type"));
    let disposition = header(response_headers, "content-disposition");
    let file_name = disposition
        .and_then(crate::probe::parse_content_disposition)
        .or_else(|| crate::probe::file_name_from_url(url));

    // Total size: Content-Range total for partial responses beats the part length.
    let size = header(response_headers, "content-range")
        .and_then(|v| v.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok())
        .or(content_length);

    if is_manifest_segment(&path, ext.as_deref(), content_type) {
        return None;
    }

    let by_mime = content_type.and_then(mime_kind);
    let by_ext = ext.as_deref().and_then(ext_kind);
    let attachment = disposition.is_some_and(|d| {
        d.trim_start()
            .to_ascii_lowercase()
            .starts_with("attachment")
    });

    // Manifests first: never size-filtered.
    let manifest = [by_mime, by_ext]
        .into_iter()
        .flatten()
        .find(|k| matches!(k, DetectedKind::Hls | DetectedKind::Dash));
    let kind = match manifest {
        Some(k) => k,
        None => {
            // Generic types defer to the extension (octet-stream etc. are not in mime_kind).
            let from_name = file_name
                .as_deref()
                .and_then(|n| n.rsplit_once('.'))
                .and_then(|(_, e)| ext_kind(&e.to_ascii_lowercase()));
            let named = if attachment {
                from_name.or(Some(DetectedKind::Other))
            } else {
                None
            };
            by_mime.or(by_ext).or(named)?
        }
    };

    let is_manifest = matches!(kind, DetectedKind::Hls | DetectedKind::Dash);
    if !is_manifest {
        match kind {
            DetectedKind::Video | DetectedKind::Audio
                if size.is_some_and(|s| s < MIN_MEDIA_BYTES) =>
            {
                return None
            }
            DetectedKind::Image if size.is_none_or(|s| s < MIN_IMAGE_BYTES) => return None,
            _ => {}
        }
        if size == Some(0) {
            return None;
        }
    }

    Some(Detected {
        kind,
        url: url.to_string(),
        content_type: content_type.map(str::to_string),
        content_length: size,
        extension: ext,
        file_name,
        is_manifest,
        dedupe_key: dedupe_key(url),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use DetectedKind::*;

    fn kind(url: &str, ct: Option<&str>, len: Option<u64>) -> Option<DetectedKind> {
        classify(url, ct, len, &[]).map(|d| d.kind)
    }

    #[test]
    #[allow(clippy::type_complexity)]
    fn classification_table() {
        let big = Some(5_000_000);
        let cases: &[(&str, Option<&str>, Option<u64>, Option<DetectedKind>)] = &[
            (
                "https://x.test/a/master.m3u8?tok=1",
                None,
                Some(300),
                Some(Hls),
            ),
            (
                "https://x.test/play",
                Some("application/vnd.apple.mpegurl"),
                None,
                Some(Hls),
            ),
            (
                "https://x.test/play",
                Some("application/x-mpegURL; charset=utf-8"),
                Some(10),
                Some(Hls),
            ),
            ("https://x.test/m.mpd", None, Some(2000), Some(Dash)),
            (
                "https://x.test/m",
                Some("application/dash+xml"),
                None,
                Some(Dash),
            ),
            ("https://x.test/v.mp4", Some("video/mp4"), big, Some(Video)),
            ("https://x.test/v.webm", None, big, Some(Video)),
            (
                "https://x.test/v.mkv",
                Some("application/octet-stream"),
                big,
                Some(Video),
            ),
            ("https://x.test/v.mov", None, None, Some(Video)),
            ("https://x.test/s.mp3", Some("audio/mpeg"), big, Some(Audio)),
            ("https://x.test/s.m4a", None, big, Some(Audio)),
            ("https://x.test/s.flac", None, big, Some(Audio)),
            ("https://x.test/s.wav", None, big, Some(Audio)),
            (
                "https://x.test/d.pdf",
                Some("application/pdf"),
                Some(30_000),
                Some(Pdf),
            ),
            ("https://x.test/d.zip", None, Some(30_000), Some(Archive)),
            ("https://x.test/d.rar", None, big, Some(Archive)),
            ("https://x.test/d.7z", None, big, Some(Archive)),
            (
                "https://x.test/setup.exe",
                Some("application/octet-stream"),
                big,
                Some(Other),
            ),
            ("https://x.test/setup.msi", None, big, Some(Other)),
            ("https://x.test/disk.iso", None, big, Some(Other)),
            ("https://x.test/app.dmg", None, big, Some(Other)),
            ("https://x.test/app.apk", None, big, Some(Other)),
            ("https://x.test/r.docx", None, Some(20_000), Some(Document)),
            ("https://x.test/r.xlsx", None, Some(20_000), Some(Document)),
            ("https://x.test/r.pptx", None, Some(20_000), Some(Document)),
            (
                "https://x.test/r.csv",
                Some("text/csv"),
                Some(2_000),
                Some(Document),
            ),
            ("https://x.test/p.jpg", Some("image/jpeg"), big, Some(Image)),
            // filtered out
            (
                "https://x.test/tiny.mp4",
                Some("video/mp4"),
                Some(10_000),
                None,
            ),
            ("https://x.test/tiny.mp3", None, Some(10_000), None),
            (
                "https://x.test/icon.png",
                Some("image/png"),
                Some(2_000),
                None,
            ),
            ("https://x.test/index.html", Some("text/html"), big, None),
            (
                "https://x.test/app.js",
                Some("application/javascript"),
                big,
                None,
            ),
            ("https://x.test/seg-001.ts", Some("video/mp2t"), big, None),
            ("https://x.test/stream/0001.ts", None, big, None),
            (
                "https://x.test/v/chunk-0004.m4s",
                Some("video/iso.segment"),
                big,
                None,
            ),
            (
                "https://x.test/audio/frag_12.aac",
                Some("audio/aac"),
                big,
                None,
            ),
            (
                "https://x.test/video/segment-7.mp4",
                Some("video/mp4"),
                big,
                None,
            ),
            (
                "https://x.test/video/init.mp4",
                Some("video/mp4"),
                big,
                None,
            ),
            ("blob:https://x.test/uuid", Some("video/mp4"), big, None),
        ];
        for (url, ct, len, want) in cases {
            assert_eq!(kind(url, *ct, *len), *want, "{url}");
        }
    }

    #[test]
    fn disposition_and_range_size() {
        let h = vec![
            (
                "Content-Disposition".to_string(),
                "attachment; filename=\"report.bin\"".to_string(),
            ),
            (
                "Content-Range".to_string(),
                "bytes 0-99/9000000".to_string(),
            ),
        ];
        let d = classify(
            "https://x.test/dl?id=3",
            Some("application/octet-stream"),
            Some(100),
            &h,
        )
        .unwrap();
        assert_eq!(d.kind, Other);
        assert_eq!(d.file_name.as_deref(), Some("report.bin"));
        assert_eq!(d.content_length, Some(9_000_000));
        assert!(!d.is_manifest);
        assert!(classify(
            "https://x.test/dl?id=3",
            Some("application/octet-stream"),
            Some(100),
            &[]
        )
        .is_none());
    }

    #[test]
    fn dedupe_ignores_volatile_params() {
        let a = dedupe_key("https://cdn.test/v.mp4?id=5&expires=1&token=aa&range=0-100#x");
        let b = dedupe_key("https://cdn.test/v.mp4?token=bb&id=5&range=100-200&expires=9");
        assert_eq!(a, b);
        assert_eq!(a, "https://cdn.test/v.mp4?id=5");
        assert_ne!(a, dedupe_key("https://cdn.test/v.mp4?id=6"));
        assert_eq!(
            dedupe_key("https://cdn.test/v.mp4?token=1"),
            "https://cdn.test/v.mp4"
        );
        let d = classify(
            "https://cdn.test/v.mp4?id=5&token=1",
            Some("video/mp4"),
            Some(9_000_000),
            &[],
        )
        .unwrap();
        assert_eq!(d.url, "https://cdn.test/v.mp4?id=5&token=1");
    }
}
