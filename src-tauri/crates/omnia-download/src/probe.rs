//! Resource probing: size, range support, validators, file name.

use crate::error::{DownloadError, Result};
use crate::fsutil::sanitize_file_name;
use crate::request::RequestSpec;
use percent_encoding::percent_decode_str;
use reqwest::header::HeaderMap;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// URL after redirects.
    pub final_url: String,
    pub size: Option<u64>,
    pub accept_ranges: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
    pub file_name: String,
}

fn hdr(h: &HeaderMap, name: &str) -> Option<String> {
    h.get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
}

/// Parse a `Content-Disposition` header value (RFC 6266) and return the suggested file name.
/// `filename*=UTF-8''...` wins over `filename=`.
pub fn parse_content_disposition(value: &str) -> Option<String> {
    let mut plain: Option<String> = None;
    let mut extended: Option<String> = None;
    for (key, val) in split_params(value) {
        match key.as_str() {
            "filename*" => {
                // charset'lang'percent-encoded
                let mut parts = val.splitn(3, '\'');
                let charset = parts.next().unwrap_or("").to_ascii_lowercase();
                let _lang = parts.next();
                if let Some(enc) = parts.next() {
                    let bytes: Vec<u8> = percent_decode_str(enc).collect();
                    let s = if charset == "iso-8859-1" {
                        bytes.iter().map(|&b| b as char).collect()
                    } else {
                        String::from_utf8_lossy(&bytes).into_owned()
                    };
                    extended = Some(s);
                }
            }
            "filename" => plain = Some(val),
            _ => {}
        }
    }
    extended
        .or(plain)
        .map(|s| sanitize_file_name(&s))
        .filter(|s| !s.is_empty())
}

/// Split `a; b=c; d="e;f"` into lowercase-key / unquoted-value pairs (skipping the disposition type).
fn split_params(value: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut esc = false;
    for c in value.chars() {
        if in_q {
            if esc {
                cur.push(c);
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_q = false;
                cur.push(c);
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            in_q = true;
            cur.push(c);
        } else if c == ';' {
            parts.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    parts.push(cur);
    for p in parts.into_iter().skip(1) {
        if let Some((k, v)) = p.split_once('=') {
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|x| x.strip_suffix('"'))
                .unwrap_or(v);
            out.push((k.trim().to_ascii_lowercase(), v.to_string()));
        }
    }
    out
}

/// File name from the last URL path segment (percent-decoded), if any.
pub fn file_name_from_url(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let seg = parsed.path_segments()?.rfind(|s| !s.is_empty())?;
    let decoded = percent_decode_str(seg).decode_utf8_lossy().into_owned();
    let s = sanitize_file_name(&decoded);
    (!s.is_empty()).then_some(s)
}

fn total_from_content_range(v: &str) -> Option<u64> {
    // bytes 0-0/1234
    v.rsplit('/').next()?.trim().parse().ok()
}

/// Probe a URL: HEAD first, then a `Range: bytes=0-0` GET to confirm range support.
pub async fn probe(client: &Client, spec: &RequestSpec) -> Result<ProbeResult> {
    let mut size = None;
    let mut accept_ranges = false;
    let mut etag = None;
    let mut last_modified = None;
    let mut content_type = None;
    let mut disposition = None;
    let mut final_url = spec.url.clone();
    let mut got_any = false;

    if spec.is_get() {
        let mut head = spec.clone();
        head.method = "HEAD".into();
        head.body = None;
        if let Ok(resp) = head.send(client, None).await {
            if resp.status().is_success() {
                got_any = true;
                final_url = resp.url().to_string();
                let h = resp.headers();
                size = hdr(h, "content-length").and_then(|v| v.parse().ok());
                accept_ranges = hdr(h, "accept-ranges")
                    .is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
                etag = hdr(h, "etag");
                last_modified = hdr(h, "last-modified");
                content_type = hdr(h, "content-type");
                disposition = hdr(h, "content-disposition");
            }
        }
    }

    // Range GET: authoritative for range support, and the only option when HEAD failed.
    let resp = spec.send(client, Some("bytes=0-0")).await?;
    let status = resp.status();
    if !status.is_success() {
        if got_any {
            // HEAD worked but GET refused; trust HEAD.
        } else {
            return Err(DownloadError::Status(status.as_u16()));
        }
    } else {
        got_any = true;
        final_url = resp.url().to_string();
        let h = resp.headers();
        if status == StatusCode::PARTIAL_CONTENT {
            accept_ranges = true;
            if let Some(t) = hdr(h, "content-range").and_then(|v| total_from_content_range(&v)) {
                size = Some(t);
            }
        } else {
            // 200: the server ignored the Range header.
            accept_ranges = false;
            if size.is_none() {
                size = hdr(h, "content-length").and_then(|v| v.parse().ok());
            }
        }
        etag = hdr(h, "etag").or(etag);
        last_modified = hdr(h, "last-modified").or(last_modified);
        content_type = hdr(h, "content-type").or(content_type);
        disposition = hdr(h, "content-disposition").or(disposition);
    }
    if !got_any {
        return Err(DownloadError::Network("probe failed".into()));
    }

    let file_name = disposition
        .as_deref()
        .and_then(parse_content_disposition)
        .or_else(|| file_name_from_url(&final_url))
        .or_else(|| file_name_from_url(&spec.url))
        .unwrap_or_else(|| "download".to_string());

    Ok(ProbeResult {
        final_url,
        size,
        accept_ranges,
        etag,
        last_modified,
        content_type,
        file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_variants() {
        assert_eq!(
            parse_content_disposition(r#"attachment; filename="a b.zip""#).as_deref(),
            Some("a b.zip")
        );
        assert_eq!(
            parse_content_disposition("attachment; filename=plain.bin").as_deref(),
            Some("plain.bin")
        );
        assert_eq!(
            parse_content_disposition(
                r#"attachment; filename="fallback.txt"; filename*=UTF-8''%E2%82%AC%20rates.txt"#
            )
            .as_deref(),
            Some("\u{20ac} rates.txt")
        );
        assert_eq!(
            parse_content_disposition(r#"attachment; filename="../../etc/passwd""#).as_deref(),
            Some("_.._etc_passwd")
        );
        assert_eq!(
            parse_content_disposition(r#"attachment; filename="a;b.txt""#).as_deref(),
            Some("a;b.txt")
        );
        assert_eq!(parse_content_disposition("inline"), None);
    }

    #[test]
    fn url_names() {
        assert_eq!(
            file_name_from_url("http://h/p/My%20File.mp4?x=1").as_deref(),
            Some("My File.mp4")
        );
        assert_eq!(file_name_from_url("http://h/").as_deref(), None);
        assert_eq!(file_name_from_url("http://h/dir/").as_deref(), Some("dir"));
    }
}
