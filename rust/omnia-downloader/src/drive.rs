//! Pure-Rust Google Drive URL parser, official Drive REST API v3 client,
//! Google Workspace Docs/Sheets/Slides export MIME resolver, sanctioned public
//! large-file confirm-token handler, and recursive folder batch planner.
//!
//! Strict compliance invariants:
//! - Uses ONLY user-supplied OAuth Bearer token / API key or sanctioned public links.
//! - Zero browser cookie scraping, zero view-only circumvention (`canDownload=false` -> `BLOCKED_ACL_403`),
//!   zero CAPTCHA/anti-bot bypass (`/sorry/` -> zero-retry `429 AUTH_CHALLENGE_REQUIRED`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::{redirect, Client};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::batch::{BatchItem, BatchPlan};
use crate::handoff::{classify_http_response, VisibleHandoffManager};
use crate::privacy::PrivacyShield;
use crate::types::{
    safe_output_filename, validate_safe_local_path, DownloaderError, SecurityPolicy, DRM_SUPPORTED,
};

/// Default official Google Drive REST API v3 base URL.
pub const DEFAULT_DRIVE_API_BASE: &str = "https://www.googleapis.com/drive/v3";

/// Hard upper bound on Drive REST API v3 JSON response body reads (4 MiB).
pub const MAX_DRIVE_API_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Maximum redirect hops permitted during Drive API v3 calls (each hop SSRF-validated).
const MAX_DRIVE_REDIRECT_HOPS: usize = 10;

/// Maximum recursive folder depth allowed during folder batch planning.
pub const MAX_FOLDER_RECURSION_DEPTH: usize = 16;

/// Maximum files planned in a single recursive folder batch.
pub const MAX_FOLDER_BATCH_ITEMS: usize = 5_000;

/// Kind of Google Drive or Workspace resource identified from a URL or MIME type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveResourceKind {
    File,
    Folder,
    GoogleDoc,
    GoogleSheet,
    GoogleSlides,
    GoogleDrawing,
    GoogleScript,
}

/// Parsed reference to a Google Drive / Workspace resource extracted from a URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveResourceRef {
    pub file_id: String,
    pub kind: DriveResourceKind,
    pub resource_key: Option<String>,
    pub auth_user: Option<u32>,
    pub canonical_url: String,
}

/// Preferred export format for Google Workspace Docs/Sheets/Slides/Drawings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceExportFormat {
    /// Office-native format (`docx`, `xlsx`, `pptx`, `png`, `json`).
    #[default]
    OfficeNative,
    Pdf,
    Markdown,
    PlainText,
    Csv,
    Svg,
}

/// Resolved Google Workspace export target MIME and file extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceExportTarget {
    pub export_mime: String,
    pub extension: String,
}

/// Validates a Google Drive file/folder ID (`[A-Za-z0-9_-]{10,128}`).
#[must_use]
pub fn is_valid_drive_id(id: &str) -> bool {
    (10..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Parses Google Drive & Google Docs/Sheets/Slides/Drawings URLs in pure Rust.
///
/// Supported forms:
/// - `https://drive.google.com/file/d/<id>/view?resourcekey=<rk>`
/// - `https://drive.google.com/drive/folders/<id>` / `/drive/u/<n>/folders/<id>`
/// - `https://drive.google.com/open?id=<id>`
/// - `https://drive.google.com/uc?id=<id>&export=download`
/// - `https://docs.google.com/{document,spreadsheets,presentation,drawings}/d/<id>/edit`
pub fn parse_drive_url(raw_url: &str) -> Result<DriveResourceRef, DownloaderError> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|e| DownloaderError::InvalidInput(format!("invalid Google Drive URL: {e}")))?;

    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if host != "drive.google.com"
        && host != "docs.google.com"
        && host != "drive.usercontent.google.com"
    {
        return Err(DownloaderError::InvalidInput(format!(
            "host `{host}` is not a Google Drive/Docs domain"
        )));
    }

    let query_pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.into_owned()))
        .collect();
    let get_q = |name: &str| -> Option<String> {
        query_pairs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty())
    };

    let resource_key = get_q("resourcekey");
    let mut auth_user = get_q("authuser").and_then(|v| v.parse::<u32>().ok());

    let segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    // Extract optional `/u/<n>/` account index from path.
    for win in segments.windows(2) {
        if win[0].eq_ignore_ascii_case("u") {
            if let Ok(idx) = win[1].parse::<u32>() {
                auth_user.get_or_insert(idx);
            }
        }
    }

    let (file_id, kind) = if host == "docs.google.com" {
        let kind = match segments.first().copied().unwrap_or("") {
            "document" => DriveResourceKind::GoogleDoc,
            "spreadsheets" => DriveResourceKind::GoogleSheet,
            "presentation" => DriveResourceKind::GoogleSlides,
            "drawings" => DriveResourceKind::GoogleDrawing,
            other => {
                return Err(DownloaderError::InvalidInput(format!(
                    "unsupported docs.google.com path segment `{other}`"
                )));
            }
        };
        let d_pos = segments
            .iter()
            .position(|&s| s == "d")
            .ok_or_else(|| DownloaderError::InvalidInput("missing `/d/<id>` in Docs URL".into()))?;
        let id = segments.get(d_pos + 1).copied().unwrap_or("");
        (id.to_string(), kind)
    } else if let Some(f_pos) = segments.iter().position(|&s| s == "folders") {
        let id = segments.get(f_pos + 1).copied().unwrap_or("");
        (id.to_string(), DriveResourceKind::Folder)
    } else if let Some(d_pos) = segments.iter().position(|&s| s == "d") {
        let id = segments.get(d_pos + 1).copied().unwrap_or("");
        (id.to_string(), DriveResourceKind::File)
    } else if let Some(id) = get_q("id") {
        (id, DriveResourceKind::File)
    } else {
        return Err(DownloaderError::InvalidInput(
            "could not extract Google Drive file/folder ID from URL".into(),
        ));
    };

    if !is_valid_drive_id(&file_id) {
        return Err(DownloaderError::InvalidInput(format!(
            "invalid Google Drive resource ID `{file_id}`"
        )));
    }

    let canonical_url = match kind {
        DriveResourceKind::Folder => format!("https://drive.google.com/drive/folders/{file_id}"),
        DriveResourceKind::File => format!("https://drive.google.com/file/d/{file_id}/view"),
        DriveResourceKind::GoogleDoc => format!("https://docs.google.com/document/d/{file_id}"),
        DriveResourceKind::GoogleSheet => {
            format!("https://docs.google.com/spreadsheets/d/{file_id}")
        }
        DriveResourceKind::GoogleSlides => {
            format!("https://docs.google.com/presentation/d/{file_id}")
        }
        DriveResourceKind::GoogleDrawing => {
            format!("https://docs.google.com/drawings/d/{file_id}")
        }
        DriveResourceKind::GoogleScript => format!("https://script.google.com/d/{file_id}"),
    };

    Ok(DriveResourceRef {
        file_id,
        kind,
        resource_key,
        auth_user,
        canonical_url,
    })
}

/// Resolves Google Workspace MIME types (`application/vnd.google-apps.*`) to an official
/// export MIME type and output file extension. Returns `None` for regular binary files.
#[must_use]
pub fn resolve_workspace_export(
    google_mime: &str,
    preferred: WorkspaceExportFormat,
) -> Option<WorkspaceExportTarget> {
    let mk = |mime: &str, ext: &str| WorkspaceExportTarget {
        export_mime: mime.to_string(),
        extension: ext.to_string(),
    };
    match google_mime.trim() {
        "application/vnd.google-apps.document" => Some(match preferred {
            WorkspaceExportFormat::Pdf => mk("application/pdf", "pdf"),
            WorkspaceExportFormat::Markdown => mk("text/markdown", "md"),
            WorkspaceExportFormat::PlainText => mk("text/plain", "txt"),
            _ => mk(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "docx",
            ),
        }),
        "application/vnd.google-apps.spreadsheet" => Some(match preferred {
            WorkspaceExportFormat::Pdf => mk("application/pdf", "pdf"),
            WorkspaceExportFormat::Csv => mk("text/csv", "csv"),
            _ => mk(
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "xlsx",
            ),
        }),
        "application/vnd.google-apps.presentation" => Some(match preferred {
            WorkspaceExportFormat::Pdf => mk("application/pdf", "pdf"),
            WorkspaceExportFormat::PlainText => mk("text/plain", "txt"),
            _ => mk(
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "pptx",
            ),
        }),
        "application/vnd.google-apps.drawing" => Some(match preferred {
            WorkspaceExportFormat::Pdf => mk("application/pdf", "pdf"),
            WorkspaceExportFormat::Svg => mk("image/svg+xml", "svg"),
            _ => mk("image/png", "png"),
        }),
        "application/vnd.google-apps.script" => Some(mk(
            "application/vnd.google-apps.script+json",
            "json",
        )),
        _ => None,
    }
}

/// Parses Google Drive's sanctioned public large-file virus-scan confirmation HTML page
/// (`id="download-form"`, `action="https://drive.usercontent.google.com/download"`) and
/// constructs the confirmed download URL.
///
/// Security invariant: if `html` is a `/sorry/`, CAPTCHA, or sign-in wall, fails closed via
/// `VisibleHandoffManager` (`429 AUTH_CHALLENGE_REQUIRED` / `SignInRequired`, zero retries).
pub fn extract_drive_confirm_url(
    html: &str,
    file_id: &str,
    resource_key: Option<&str>,
    handoffs: &VisibleHandoffManager,
) -> Result<Option<String>, DownloaderError> {
    if !is_valid_drive_id(file_id) {
        return Err(DownloaderError::InvalidInput(format!(
            "invalid Google Drive file_id `{file_id}`"
        )));
    }
    let fallback_url = format!("https://drive.google.com/uc?id={file_id}&export=download");
    let gate = classify_http_response(200, &fallback_url, Some("text/html"), html);
    handoffs.enforce_classification(&fallback_url, gate)?;

    // Look for `<form ... id="download-form" ... action="...">`
    let lower = html.to_ascii_lowercase();
    let Some(form_pos) = lower.find("download-form") else {
        // Fallback: legacy `confirm=t` or `confirm=XXXX` query link inside sanitized anchor
        if let Some(tok) = extract_hidden_input_value(html, "confirm") {
            let mut url = Url::parse("https://drive.usercontent.google.com/download")
                .map_err(|e| DownloaderError::InvalidInput(e.to_string()))?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs.append_pair("id", file_id);
                pairs.append_pair("export", "download");
                pairs.append_pair("confirm", &tok);
                if let Some(rk) = resource_key {
                    pairs.append_pair("resourcekey", rk);
                }
            }
            return Ok(Some(url.to_string()));
        }
        return Ok(None);
    };

    let form_start = lower[..form_pos].rfind("<form").unwrap_or(form_pos);
    let form_slice = &html[form_start..];
    let form_end = form_slice
        .to_ascii_lowercase()
        .find("</form>")
        .map_or(form_slice.len(), |i| i + 7);
    let form_html = &form_slice[..form_end];

    let action = extract_html_attr(form_html, "action")
        .unwrap_or_else(|| "https://drive.usercontent.google.com/download".to_string());
    let mut target = Url::parse(&action).map_err(|e| {
        DownloaderError::InvalidInput(format!("invalid Drive confirm form action `{action}`: {e}"))
    })?;
    let host = target
        .host_str()
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if host != "drive.usercontent.google.com" && host != "drive.google.com" {
        return Err(DownloaderError::SecurityRejected(format!(
            "Drive confirm form action points to untrusted host `{host}`"
        )));
    }

    let id_val = extract_hidden_input_value(form_html, "id").unwrap_or_else(|| file_id.to_string());
    let export_val =
        extract_hidden_input_value(form_html, "export").unwrap_or_else(|| "download".to_string());
    let confirm_val =
        extract_hidden_input_value(form_html, "confirm").unwrap_or_else(|| "t".to_string());
    let uuid_val = extract_hidden_input_value(form_html, "uuid");
    let at_val = extract_hidden_input_value(form_html, "at");
    let rk_val = extract_hidden_input_value(form_html, "resourcekey")
        .or_else(|| resource_key.map(str::to_string));

    {
        let mut q = target.query_pairs_mut();
        q.clear();
        q.append_pair("id", &id_val);
        q.append_pair("export", &export_val);
        q.append_pair("confirm", &confirm_val);
        if let Some(u) = uuid_val {
            q.append_pair("uuid", &u);
        }
        if let Some(at) = at_val {
            q.append_pair("at", &at);
        }
        if let Some(rk) = rk_val {
            q.append_pair("resourcekey", &rk);
        }
    }

    Ok(Some(target.to_string()))
}

fn extract_html_attr(tag_html: &str, attr_name: &str) -> Option<String> {
    let needle = format!("{attr_name}=\"");
    let low = tag_html.to_ascii_lowercase();
    let idx = low.find(&needle)?;
    let start = idx + needle.len();
    let end = tag_html[start..].find('"')?;
    Some(tag_html[start..start + end].replace("&amp;", "&"))
}

fn extract_hidden_input_value(html: &str, field_name: &str) -> Option<String> {
    let low = html.to_ascii_lowercase();
    let mut offset = 0usize;
    while let Some(rel) = low[offset..].find("<input") {
        let start = offset + rel;
        let end = low[start..].find('>').map_or(html.len(), |i| start + i + 1);
        let tag = &html[start..end];
        if extract_html_attr(tag, "name")
            .is_some_and(|n| n.eq_ignore_ascii_case(field_name))
        {
            if let Some(val) = extract_html_attr(tag, "value") {
                return Some(val);
            }
        }
        offset = end;
    }
    None
}

/// User-supplied authentication credentials for the official Google Drive REST API v3.
///
/// Zero browser profile scraping — credentials must be explicitly supplied by the user.
#[derive(Clone, Default)]
pub enum DriveAuth {
    /// Unauthenticated public links only.
    #[default]
    None,
    /// User-supplied OAuth 2.0 Bearer access token.
    OAuthBearer(String),
    /// User-supplied Google API key (`?key=...`).
    ApiKey(String),
}

impl std::fmt::Debug for DriveAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "DriveAuth::None"),
            Self::OAuthBearer(_) => write!(f, "DriveAuth::OAuthBearer([REDACTED])"),
            Self::ApiKey(_) => write!(f, "DriveAuth::ApiKey([REDACTED])"),
        }
    }
}

/// Metadata returned by the official Google Drive REST API v3 `/files/{id}` endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriveFileMetadata {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<u64>,
    pub sha256_checksum: Option<String>,
    pub md5_checksum: Option<String>,
    pub resource_key: Option<String>,
    pub can_download: bool,
    pub is_folder: bool,
    pub export_target: Option<WorkspaceExportTarget>,
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
struct ApiFileCapabilities {
    #[serde(rename = "canDownload")]
    can_download: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ApiFileResponse {
    id: String,
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    size: Option<String>,
    #[serde(rename = "sha256Checksum")]
    sha256_checksum: Option<String>,
    #[serde(rename = "md5Checksum")]
    md5_checksum: Option<String>,
    #[serde(rename = "resourceKey")]
    resource_key: Option<String>,
    capabilities: Option<ApiFileCapabilities>,
}

#[derive(Debug, Deserialize)]
struct ApiFileListResponse {
    #[serde(default)]
    files: Vec<ApiFileResponse>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

/// Official Google Drive REST API v3 metadata & recursive folder batch resolver.
pub struct DriveResolver {
    client: Client,
    api_base: String,
    auth: DriveAuth,
    policy: SecurityPolicy,
    handoffs: VisibleHandoffManager,
}

impl DriveResolver {
    /// Creates a Drive resolver targeting official `https://www.googleapis.com/drive/v3`
    /// with automatic redirects disabled so every redirect hop is SSRF-validated.
    pub fn new(auth: DriveAuth) -> Result<Self, DownloaderError> {
        let client = Client::builder()
            .user_agent("OmniaDownloader/3.0 (DriveAPIv3)")
            .timeout(std::time::Duration::from_secs(30))
            .redirect(redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            api_base: DEFAULT_DRIVE_API_BASE.to_string(),
            auth,
            policy: SecurityPolicy::strict(),
            handoffs: VisibleHandoffManager::new(),
        })
    }

    /// Test-only constructor pointing at a local loopback mock Drive API v3 server.
    #[cfg(test)]
    pub fn with_test_base(api_base: impl Into<String>, auth: DriveAuth) -> Result<Self, DownloaderError> {
        let client = Client::builder()
            .no_proxy()
            .user_agent("OmniaDownloader/3.0 (DriveAPIv3-Test)")
            .timeout(std::time::Duration::from_secs(10))
            .redirect(redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            api_base: api_base.into().trim_end_matches('/').to_string(),
            auth,
            policy: SecurityPolicy::allow_loopback_for_tests(),
            handoffs: VisibleHandoffManager::new(),
        })
    }

    /// Builds an official Drive REST API v3 download or export URL for a validated `file_id`.
    ///
    /// Never panics on malformed IDs or base URLs and uses `path_segments_mut` to prevent
    /// path/query/fragment injection.
    pub fn build_api_download_url(
        &self,
        file_id: &str,
        export_mime: Option<&str>,
        resource_key: Option<&str>,
    ) -> Result<String, DownloaderError> {
        if !is_valid_drive_id(file_id) {
            return Err(DownloaderError::InvalidInput(format!(
                "invalid Google Drive file_id `{file_id}`"
            )));
        }
        let mut url = Url::parse(&self.api_base).map_err(|e| {
            DownloaderError::InvalidInput(format!("invalid Drive API base URL: {e}"))
        })?;
        {
            let mut segs = url.path_segments_mut().map_err(|()| {
                DownloaderError::InvalidInput("Drive API base URL cannot be a base".into())
            })?;
            segs.push("files");
            segs.push(file_id);
            if export_mime.is_some() {
                segs.push("export");
            }
        }
        {
            let mut q = url.query_pairs_mut();
            if let Some(mime) = export_mime {
                q.append_pair("mimeType", mime);
            } else {
                q.append_pair("alt", "media");
                q.append_pair("supportsAllDrives", "true");
            }
            if let Some(rk) = resource_key {
                q.append_pair("resourceKey", rk);
            }
            if let DriveAuth::ApiKey(ref key) = self.auth {
                q.append_pair("key", key);
            }
        }
        Ok(url.to_string())
    }

    /// Issues a Drive REST API v3 GET request with manual SSRF-validated redirects,
    /// cross-origin credential/resource-key stripping, and a strict [`MAX_DRIVE_API_BODY_BYTES`] read cap.
    async fn send_drive_get(
        &self,
        initial_url: &str,
        resource_key_header: Option<&str>,
    ) -> Result<(u16, String, Option<String>, String), DownloaderError> {
        let mut current_url = initial_url.to_string();
        let origin_parsed = Url::parse(&current_url).map_err(|e| {
            DownloaderError::InvalidInput(format!("invalid Drive API URL: {e}"))
        })?;

        for hop in 0..=MAX_DRIVE_REDIRECT_HOPS {
            self.policy.validate_url(&current_url)?;
            let parsed_cur = Url::parse(&current_url).map_err(|e| {
                DownloaderError::InvalidInput(format!("invalid Drive API redirect URL: {e}"))
            })?;
            let same_origin = PrivacyShield::is_same_origin(&origin_parsed, &parsed_cur);

            let mut req = self
                .client
                .get(&current_url)
                .header(USER_AGENT, "OmniaDownloader/3.0 (DriveAPIv3)");
            if same_origin {
                if let DriveAuth::OAuthBearer(ref token) = self.auth {
                    req = req.header(AUTHORIZATION, format!("Bearer {token}"));
                }
                if let Some(rk_hdr) = resource_key_header {
                    req = req.header("X-Goog-Drive-Resource-Keys", rk_hdr);
                }
            }

            let resp = req.send().await?;
            let status = resp.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == MAX_DRIVE_REDIRECT_HOPS {
                    return Err(DownloaderError::SecurityRejected(
                        "Drive API redirect chain exceeded maximum hops".into(),
                    ));
                }
                let loc = resp
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| DownloaderError::HttpStatus {
                        status,
                        detail: "Drive API redirect missing Location header".into(),
                    })?;
                let next_parsed = parsed_cur.join(loc).map_err(|e| {
                    DownloaderError::InvalidInput(format!(
                        "invalid Drive API redirect Location `{loc}`: {e}"
                    ))
                })?;
                let next_url = next_parsed.to_string();
                let redir_gate = classify_http_response(status, &next_url, None, "");
                self.handoffs.enforce_classification(&next_url, redir_gate)?;
                current_url = next_url;
                continue;
            }

            let final_url = resp.url().to_string();
            let content_type = resp
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);

            // Enforce strict bounded response body read (4 MiB cap) to prevent OOM.
            if let Some(cl) = resp.content_length() {
                if cl > MAX_DRIVE_API_BODY_BYTES as u64 {
                    return Err(DownloaderError::SecurityRejected(format!(
                        "Drive API response Content-Length {cl} exceeds {MAX_DRIVE_API_BODY_BYTES}-byte safety cap"
                    )));
                }
            }
            let mut body_bytes = Vec::new();
            let mut stream = resp.bytes_stream();
            while let Some(chunk_res) = stream.next().await {
                let chunk = chunk_res?;
                if body_bytes.len().saturating_add(chunk.len()) > MAX_DRIVE_API_BODY_BYTES {
                    return Err(DownloaderError::SecurityRejected(format!(
                        "Drive API response body exceeded {MAX_DRIVE_API_BODY_BYTES}-byte safety cap"
                    )));
                }
                body_bytes.extend_from_slice(&chunk);
            }
            let body = String::from_utf8_lossy(&body_bytes).into_owned();
            return Ok((status, final_url, content_type, body));
        }

        Err(DownloaderError::SecurityRejected(
            "Drive API redirect limit reached".into(),
        ))
    }

    /// Fetches official Drive REST API v3 metadata for `file_id`.
    ///
    /// Enforces `BLOCKED_ACL_403` (`can_download = false`, zero-retry) if HTTP 403 is returned
    /// OR if `capabilities.canDownload == Some(false)` (strict zero view-only circumvention).
    pub async fn get_metadata(
        &self,
        file_id: &str,
        resource_key: Option<&str>,
        export_format: WorkspaceExportFormat,
    ) -> Result<DriveFileMetadata, DownloaderError> {
        if !is_valid_drive_id(file_id) {
            return Err(DownloaderError::InvalidInput(format!(
                "invalid Google Drive file_id `{file_id}`"
            )));
        }

        let mut url = Url::parse(&self.api_base).map_err(|e| {
            DownloaderError::InvalidInput(format!("invalid Drive API base URL: {e}"))
        })?;
        {
            let mut segs = url.path_segments_mut().map_err(|()| {
                DownloaderError::InvalidInput("Drive API base URL cannot be a base".into())
            })?;
            segs.push("files");
            segs.push(file_id);
        }
        {
            let mut q = url.query_pairs_mut();
            q.append_pair(
                "fields",
                "id,name,mimeType,size,sha256Checksum,md5Checksum,resourceKey,capabilities(canDownload)",
            );
            q.append_pair("supportsAllDrives", "true");
            if let DriveAuth::ApiKey(ref key) = self.auth {
                q.append_pair("key", key);
            }
        }

        let rk_hdr = resource_key.map(|rk| format!("{file_id}/{rk}"));
        let (status, final_url, ct, body) = self
            .send_drive_get(url.as_str(), rk_hdr.as_deref())
            .await?;

        let gate = classify_http_response(status, &final_url, ct.as_deref(), &body);
        self.handoffs.enforce_classification(&final_url, gate)?;

        if !(200..300).contains(&status) {
            return Err(DownloaderError::HttpStatus {
                status,
                detail: format!("Drive API v3 /files/{file_id} returned HTTP {status}"),
            });
        }

        let raw: ApiFileResponse = serde_json::from_str(&body)?;
        if !is_valid_drive_id(&raw.id) {
            return Err(DownloaderError::SecurityRejected(format!(
                "untrusted Drive API metadata returned invalid file_id `{}`",
                raw.id
            )));
        }
        let can_download = raw
            .capabilities
            .as_ref()
            .and_then(|c| c.can_download)
            .unwrap_or(true);
        let is_folder = raw.mime_type == "application/vnd.google-apps.folder";
        if !is_folder && !can_download {
            return Err(DownloaderError::BlockedAcl403 {
                detail: format!(
                    "Drive file `{}` has capabilities.canDownload=false (view-only ACL enforced)",
                    raw.id
                ),
                can_download: false,
            });
        }

        let export_target = resolve_workspace_export(&raw.mime_type, export_format);
        let effective_rk = raw.resource_key.as_deref().or(resource_key);
        let download_url = self.build_api_download_url(
            &raw.id,
            export_target.as_ref().map(|t| t.export_mime.as_str()),
            effective_rk,
        )?;

        Ok(DriveFileMetadata {
            id: raw.id,
            name: raw.name,
            mime_type: raw.mime_type,
            size: raw.size.and_then(|s| s.parse::<u64>().ok()),
            sha256_checksum: raw.sha256_checksum,
            md5_checksum: raw.md5_checksum,
            resource_key: effective_rk.map(str::to_string),
            can_download,
            is_folder,
            export_target,
            download_url,
        })
    }

    /// Recursively traverses a Google Drive folder using official API v3 pagination
    /// (`nextPageToken`) with cycle detection, path/UNC/reparse/workspace-root safety guards,
    /// and depth cap, producing a [`BatchPlan`].
    pub async fn plan_folder_batch(
        &self,
        folder_id: &str,
        resource_key: Option<&str>,
        staging_dir: PathBuf,
        workspace_root: Option<&Path>,
        export_format: WorkspaceExportFormat,
        max_depth: usize,
    ) -> Result<BatchPlan, DownloaderError> {
        if !is_valid_drive_id(folder_id) {
            return Err(DownloaderError::InvalidInput(format!(
                "invalid Google Drive folder_id `{folder_id}`"
            )));
        }
        let safe_staging = validate_safe_local_path(&staging_dir, workspace_root)?;
        let depth_cap = max_depth.min(MAX_FOLDER_RECURSION_DEPTH);
        let mut visited_folders = BTreeSet::new();
        let mut items = Vec::new();
        let mut stack: Vec<(String, Option<String>, PathBuf, usize)> = vec![(
            folder_id.to_string(),
            resource_key.map(str::to_string),
            PathBuf::new(),
            0,
        )];

        while let Some((cur_folder, cur_rk, rel_dir, depth)) = stack.pop() {
            if depth > depth_cap || !visited_folders.insert(cur_folder.clone()) {
                continue;
            }
            let children = self
                .list_folder_children(&cur_folder, cur_rk.as_deref(), export_format)
                .await?;

            for child in children {
                if items.len() >= MAX_FOLDER_BATCH_ITEMS {
                    break;
                }
                let safe_name = safe_output_filename(&child.name)?;
                if child.is_folder {
                    if depth < depth_cap {
                        stack.push((
                            child.id,
                            child.resource_key,
                            rel_dir.join(&safe_name),
                            depth + 1,
                        ));
                    }
                    continue;
                }
                if !child.can_download {
                    // Strictly honor ACL: skip view-only files instead of circumventing.
                    continue;
                }
                let final_name = match &child.export_target {
                    Some(exp) if !safe_name.ends_with(&format!(".{}", exp.extension)) => {
                        format!("{safe_name}.{}", exp.extension)
                    }
                    _ => safe_name,
                };
                let dest_dir = if rel_dir.as_os_str().is_empty() {
                    safe_staging.clone()
                } else {
                    safe_staging.join(&rel_dir)
                };
                items.push(BatchItem {
                    url: child.download_url,
                    filename: Some(final_name),
                    destination_dir: dest_dir,
                    expected_sha256: child.sha256_checksum,
                    expected_size: child.size,
                    description: Some(format!("gdrive:{}", child.id)),
                });
            }
        }

        Ok(BatchPlan {
            plan_id: omnia_core::uuid_v4(),
            items,
            drm_supported: DRM_SUPPORTED,
        })
    }

    async fn list_folder_children(
        &self,
        folder_id: &str,
        resource_key: Option<&str>,
        export_format: WorkspaceExportFormat,
    ) -> Result<Vec<DriveFileMetadata>, DownloaderError> {
        let mut results = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let mut url = Url::parse(&self.api_base).map_err(|e| {
                DownloaderError::InvalidInput(format!("invalid Drive API base URL: {e}"))
            })?;
            {
                let mut segs = url.path_segments_mut().map_err(|()| {
                    DownloaderError::InvalidInput("Drive API base URL cannot be a base".into())
                })?;
                segs.push("files");
            }
            {
                let mut q = url.query_pairs_mut();
                q.append_pair("q", &format!("'{folder_id}' in parents and trashed = false"));
                q.append_pair("pageSize", "100");
                q.append_pair("includeItemsFromAllDrives", "true");
                q.append_pair("supportsAllDrives", "true");
                q.append_pair(
                    "fields",
                    "nextPageToken,files(id,name,mimeType,size,sha256Checksum,md5Checksum,resourceKey,capabilities(canDownload))",
                );
                if let Some(ref tok) = page_token {
                    q.append_pair("pageToken", tok);
                }
                if let DriveAuth::ApiKey(ref key) = self.auth {
                    q.append_pair("key", key);
                }
            }

            let rk_hdr = resource_key.map(|rk| format!("{folder_id}/{rk}"));
            let (status, final_url, ct, body) = self
                .send_drive_get(url.as_str(), rk_hdr.as_deref())
                .await?;

            let gate = classify_http_response(status, &final_url, ct.as_deref(), &body);
            self.handoffs.enforce_classification(&final_url, gate)?;
            if !(200..300).contains(&status) {
                return Err(DownloaderError::HttpStatus {
                    status,
                    detail: format!("Drive API v3 folder listing failed with HTTP {status}"),
                });
            }

            let list: ApiFileListResponse = serde_json::from_str(&body)?;
            for f in list.files {
                if !is_valid_drive_id(&f.id) {
                    return Err(DownloaderError::SecurityRejected(format!(
                        "untrusted Drive folder listing returned invalid file_id `{}`",
                        f.id
                    )));
                }
                let is_folder = f.mime_type == "application/vnd.google-apps.folder";
                let can_download = f
                    .capabilities
                    .as_ref()
                    .and_then(|c| c.can_download)
                    .unwrap_or(true);
                let export_target = resolve_workspace_export(&f.mime_type, export_format);
                let download_url = self.build_api_download_url(
                    &f.id,
                    export_target.as_ref().map(|t| t.export_mime.as_str()),
                    f.resource_key.as_deref(),
                )?;
                results.push(DriveFileMetadata {
                    id: f.id,
                    name: f.name,
                    mime_type: f.mime_type,
                    size: f.size.and_then(|s| s.parse::<u64>().ok()),
                    sha256_checksum: f.sha256_checksum,
                    md5_checksum: f.md5_checksum,
                    resource_key: f.resource_key,
                    can_download,
                    is_folder,
                    export_target,
                    download_url,
                });
            }

            match list.next_page_token.filter(|t| !t.is_empty()) {
                Some(tok) if results.len() < MAX_FOLDER_BATCH_ITEMS => page_token = Some(tok),
                _ => break,
            }
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_google_drive_and_workspace_url_variants() {
        let f = parse_drive_url(
            "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view?usp=sharing&resourcekey=0-xyz987",
        )
        .unwrap();
        assert_eq!(f.file_id, "1AbCdEfGhIjKlMnOpQrSt");
        assert_eq!(f.kind, DriveResourceKind::File);
        assert_eq!(f.resource_key.as_deref(), Some("0-xyz987"));

        let folder = parse_drive_url(
            "https://drive.google.com/drive/u/2/folders/1FolderIdExample_98765?resourcekey=0-rk1",
        )
        .unwrap();
        assert_eq!(folder.file_id, "1FolderIdExample_98765");
        assert_eq!(folder.kind, DriveResourceKind::Folder);
        assert_eq!(folder.auth_user, Some(2));

        let open_q = parse_drive_url("https://drive.google.com/open?id=1OpenQueryId_123456").unwrap();
        assert_eq!(open_q.file_id, "1OpenQueryId_123456");

        let sheet =
            parse_drive_url("https://docs.google.com/spreadsheets/d/1SheetDocId_123456/edit#gid=0")
                .unwrap();
        assert_eq!(sheet.kind, DriveResourceKind::GoogleSheet);
        assert_eq!(sheet.file_id, "1SheetDocId_123456");
    }

    #[test]
    fn resolves_workspace_export_mimes_and_public_confirm_form() {
        let docx = resolve_workspace_export(
            "application/vnd.google-apps.document",
            WorkspaceExportFormat::OfficeNative,
        )
        .unwrap();
        assert_eq!(docx.extension, "docx");

        let csv = resolve_workspace_export(
            "application/vnd.google-apps.spreadsheet",
            WorkspaceExportFormat::Csv,
        )
        .unwrap();
        assert_eq!(csv.export_mime, "text/csv");

        let pdf = resolve_workspace_export(
            "application/vnd.google-apps.presentation",
            WorkspaceExportFormat::Pdf,
        )
        .unwrap();
        assert_eq!(pdf.extension, "pdf");

        let handoffs = VisibleHandoffManager::new();
        let confirm_html = r#"<html><body>
            <form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
                <input type="hidden" name="id" value="1LargeFileId_123456">
                <input type="hidden" name="export" value="download">
                <input type="hidden" name="confirm" value="t">
                <input type="hidden" name="uuid" value="abcd-1234">
            </form></body></html>"#;
        let url = extract_drive_confirm_url(
            confirm_html,
            "1LargeFileId_123456",
            Some("0-rk"),
            &handoffs,
        )
        .unwrap()
        .unwrap();
        assert!(url.starts_with("https://drive.usercontent.google.com/download?"));
        assert!(url.contains("confirm=t"));
        assert!(url.contains("uuid=abcd-1234"));
        assert!(url.contains("resourcekey=0-rk"));

        // CAPTCHA / sorry HTML MUST fail closed with AuthChallengeRequired
        let sorry_html = "<html><body><div class=\"g-recaptcha\"></div>Our systems have detected unusual traffic</body></html>";
        let err = extract_drive_confirm_url(sorry_html, "1LargeFileId_123456", None, &handoffs)
            .unwrap_err();
        assert!(matches!(err, DownloaderError::AuthChallengeRequired { .. }));
        assert!(!err.is_retryable());
    }

    #[tokio::test]
    async fn drive_resolver_fetches_metadata_plans_recursive_folder_and_enforces_view_only_acl() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = match sock.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path_q = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/");

                    let (status_line, body) = if path_q.contains("/files/1ViewOnlyId_123456") {
                        (
                            "HTTP/1.1 200 OK",
                            r#"{"id":"1ViewOnlyId_123456","name":"secret.pdf","mimeType":"application/pdf","size":"2048","capabilities":{"canDownload":false}}"#,
                        )
                    } else if path_q.contains("/files/1DocFileId_1234567") {
                        (
                            "HTTP/1.1 200 OK",
                            r#"{"id":"1DocFileId_1234567","name":"Design Spec","mimeType":"application/vnd.google-apps.document","capabilities":{"canDownload":true}}"#,
                        )
                    } else if path_q.contains("1RootFolder_123456") {
                        (
                            "HTTP/1.1 200 OK",
                            r#"{"files":[{"id":"1SubFolder_1234567","name":"nested","mimeType":"application/vnd.google-apps.folder"},{"id":"1BinaryId_12345678","name":"weights.bin","mimeType":"application/octet-stream","size":"4096","capabilities":{"canDownload":true}},{"id":"1ViewOnlySkip_12345","name":"locked.pdf","mimeType":"application/pdf","capabilities":{"canDownload":false}}]}"#,
                        )
                    } else if path_q.contains("1SubFolder_1234567") {
                        (
                            "HTTP/1.1 200 OK",
                            r#"{"files":[{"id":"1SlideId_123456789","name":"Deck","mimeType":"application/vnd.google-apps.presentation","capabilities":{"canDownload":true}}]}"#,
                        )
                    } else {
                        ("HTTP/1.1 404 Not Found", r#"{"error":{"code":404}}"#)
                    };

                    let resp = format!(
                        "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });

        let resolver = DriveResolver::with_test_base(
            format!("http://{addr}/drive/v3"),
            DriveAuth::OAuthBearer("dummy_oauth_token_for_unit_test".into()),
        )
        .unwrap();

        // 1. Workspace Google Doc resolves export URL (.docx)
        let meta = resolver
            .get_metadata(
                "1DocFileId_1234567",
                None,
                WorkspaceExportFormat::OfficeNative,
            )
            .await
            .unwrap();
        assert_eq!(meta.export_target.as_ref().unwrap().extension, "docx");
        assert!(meta.download_url.contains("/export?mimeType="));

        // 2. View-only file (`canDownload=false`) MUST fail closed with BLOCKED_ACL_403!
        let err = resolver
            .get_metadata("1ViewOnlyId_123456", None, WorkspaceExportFormat::Pdf)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            DownloaderError::BlockedAcl403 {
                can_download: false,
                ..
            }
        ));
        assert!(!err.is_retryable());

        // 3. Recursive folder batch plans binary + nested exported slide, skipping view-only!
        let batch = resolver
            .plan_folder_batch(
                "1RootFolder_123456",
                None,
                PathBuf::from(r"D:\OmniaData\downloads\folder"),
                None,
                WorkspaceExportFormat::Pdf,
                4,
            )
            .await
            .unwrap();
        assert!(!batch.drm_supported);
        assert_eq!(batch.items.len(), 2);
        assert!(batch
            .items
            .iter()
            .any(|i| i.filename.as_deref() == Some("weights.bin")));
        assert!(batch
            .items
            .iter()
            .any(|i| i.filename.as_deref() == Some("Deck.pdf")));

        // 4. Regression (Defect #4): UNC staging path rejected upfront before network call!
        let unc_err = resolver
            .plan_folder_batch(
                "1RootFolder_123456",
                None,
                PathBuf::from(r"\\fileserver\share\folder"),
                None,
                WorkspaceExportFormat::Pdf,
                2,
            )
            .await
            .unwrap_err();
        assert!(matches!(unc_err, DownloaderError::ForbiddenPath { .. }));

        server.abort();
    }

    #[tokio::test]
    async fn drive_resolver_rejects_malformed_ids_ssrf_redirects_and_oversized_responses() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = match sock.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path_q = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/");

                    if path_q.contains("/files/1SsrfRedirect_1234") {
                        let resp = "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        let _ = sock.write_all(resp.as_bytes()).await;
                    } else if path_q.contains("/files/1OversizedResp_123") {
                        let fake_len = MAX_DRIVE_API_BODY_BYTES + 1024;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {fake_len}\r\nConnection: close\r\n\r\n"
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                    } else if path_q.contains("/files/1BadJsonId_1234567") {
                        let body = r#"{"id":"../admin?inject=1#frag","name":"evil.bin","mimeType":"application/octet-stream"}"#;
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = sock.write_all(resp.as_bytes()).await;
                    }
                });
            }
        });

        let resolver = DriveResolver::with_test_base(
            format!("http://{addr}/drive/v3"),
            DriveAuth::OAuthBearer("dummy_token_regression".into()),
        )
        .unwrap();

        // Defect #2: direct call with malformed file_id returns Err (zero panic!)
        assert!(matches!(
            resolver.build_api_download_url("../evil?a=1", None, None),
            Err(DownloaderError::InvalidInput(_))
        ));

        // Defect #2: untrusted Drive JSON with injected `id` fails closed!
        let bad_id_err = resolver
            .get_metadata("1BadJsonId_1234567", None, WorkspaceExportFormat::Pdf)
            .await
            .unwrap_err();
        assert!(matches!(bad_id_err, DownloaderError::SecurityRejected(_)));

        // Defect #3: 302 redirect to IMDS 169.254.169.254 blocked by SSRF guard!
        let ssrf_err = resolver
            .get_metadata("1SsrfRedirect_1234", None, WorkspaceExportFormat::Pdf)
            .await
            .unwrap_err();
        assert!(matches!(ssrf_err, DownloaderError::RangePolicy(_)));

        // Defect #3: oversized > 4 MiB response rejected before reading into RAM!
        let cap_err = resolver
            .get_metadata("1OversizedResp_123", None, WorkspaceExportFormat::Pdf)
            .await
            .unwrap_err();
        assert!(matches!(cap_err, DownloaderError::SecurityRejected(_)));

        server.abort();
    }
}
