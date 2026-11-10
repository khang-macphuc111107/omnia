//! Host side of the agent `artifact` tool: list, read, export and open
//! artifacts that the harness stored under `<workspace>/.omnia/artifacts`.

use omnia_harness::tools::artifact::{self, ArtifactContent, ArtifactKind, ArtifactMeta};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::http::{self, header, Method, StatusCode};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::HarnessHub;

/// Same lockdown the renderer injects into its sandboxed preview: no network
/// (`connect-src`/`default-src 'none'`), no forms, no `<base>` rewriting, inline
/// script/style and data/blob images only.
///
/// What this does NOT do: CSP cannot stop navigation (`navigate-to` was removed
/// from the spec and is not implemented by browsers).  In the in-app frame the
/// iframe `sandbox` (without `allow-top-navigation` and `allow-popups`) is what
/// blocks top-level navigation and new windows; the frame can still navigate
/// itself, e.g. a clicked link or `location = ...` inside the frame.  Residual
/// risk: an artifact can replace its own frame content with a page from the
/// network.  When opened in the system browser (see `agent_artifact_open_browser`)
/// there is no sandbox at all, so only this CSP applies and links/top-level
/// navigation work normally; script cannot read other origins, but the page
/// can be navigated away.
const PREVIEW_CSP: &str = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsListRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub session_id: String,
    pub id: String,
    #[serde(default)]
    pub version: Option<u32>,
}

fn failed(error: String) -> NativeError {
    NativeError::new("artifact_failed", error)
}

#[tauri::command]
pub fn agent_artifacts_list(
    hub: State<'_, HarnessHub>,
    request: ArtifactsListRequest,
) -> NativeResult<Vec<ArtifactMeta>> {
    let cwd = hub.session_workspace(&request.session_id)?;
    Ok(artifact::list(&cwd, &request.session_id))
}

#[tauri::command]
pub fn agent_artifact_get(
    hub: State<'_, HarnessHub>,
    request: ArtifactRef,
) -> NativeResult<ArtifactContent> {
    let cwd = hub.session_workspace(&request.session_id)?;
    artifact::read(&cwd, &request.session_id, &request.id, request.version).map_err(failed)
}

/// Native "Save as" for one version. Returns the saved path, or `None` when
/// the user cancels the dialog.
#[tauri::command]
pub async fn agent_artifact_export(
    app: AppHandle,
    hub: State<'_, HarnessHub>,
    request: ArtifactRef,
) -> NativeResult<Option<String>> {
    let cwd = hub.session_workspace(&request.session_id)?;
    let item =
        artifact::read(&cwd, &request.session_id, &request.id, request.version).map_err(failed)?;
    let name = export_file_name(&item.meta);
    let ext = export_extension(&item.meta);
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Export artifact")
        .set_file_name(&name)
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| {
        NativeError::new(
            "unsupported_file_reference",
            "The selected file cannot be represented as a local path",
        )
    })?;
    std::fs::write(&path, item.content.as_bytes())
        .map_err(|error| NativeError::io("artifact_export_failed", error))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Writes an html/svg artifact to a temp file and opens it in the default
/// browser. The file carries the same restrictive CSP as the in-app preview.
#[tauri::command]
pub fn agent_artifact_open_browser(
    app: AppHandle,
    hub: State<'_, HarnessHub>,
    request: ArtifactRef,
) -> NativeResult<()> {
    let cwd = hub.session_workspace(&request.session_id)?;
    let item =
        artifact::read(&cwd, &request.session_id, &request.id, request.version).map_err(failed)?;
    let document = browser_document(&item).map_err(failed)?;
    let dir = std::env::temp_dir().join("omnia-artifacts");
    let file = write_browser_file(&dir, &document)?;
    app.opener()
        .open_path(file.to_string_lossy(), None::<&str>)
        .map_err(|error| NativeError::new("artifact_open_failed", error.to_string()))
}

/// Writes `document` to a fresh randomly named file inside `dir` (created if
/// needed).  The name never derives from artifact data; the file is created with
/// `create_new` (never overwrites, never follows a pre-planted link) and its
/// canonical location is verified to be inside the canonical `dir` first.
fn write_browser_file(dir: &std::path::Path, document: &str) -> NativeResult<std::path::PathBuf> {
    use std::io::Write;
    let open_failed = |error: std::io::Error| NativeError::io("artifact_open_failed", error);
    std::fs::create_dir_all(dir).map_err(open_failed)?;
    let root = dunce::canonicalize(dir).map_err(open_failed)?;
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|_| {
        NativeError::new("artifact_open_failed", "secure randomness is unavailable")
    })?;
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let file = root.join(format!("omnia-artifact-{name}.html"));
    if file.parent() != Some(root.as_path()) {
        return Err(NativeError::new(
            "artifact_open_failed",
            "refusing to write outside the artifact temp folder",
        ));
    }
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(open_failed)?;
    let contained = dunce::canonicalize(&file).map_err(open_failed)?;
    if contained.parent() != Some(root.as_path()) {
        drop(handle);
        let _ = std::fs::remove_file(&file);
        return Err(NativeError::new(
            "artifact_open_failed",
            "refusing to write outside the artifact temp folder",
        ));
    }
    handle.write_all(document.as_bytes()).map_err(open_failed)?;
    Ok(file)
}

// ---------------------------------------------------------------------------
// In-app preview: a dedicated `omnia-artifact` URI scheme. The renderer asks
// for a short-lived capability URL and frames it; the app CSP (script-src
// 'self') therefore never applies to artifact scripts, which get their own
// locked-down CSP via response headers instead.
// ---------------------------------------------------------------------------

pub const PREVIEW_SCHEME: &str = "omnia-artifact";
const PREVIEW_TTL: Duration = Duration::from_secs(30 * 60);
const PREVIEW_MAX_TOKENS: usize = 256;
/// Origins that may frame a preview: WebView2 (Windows), other platforms, dev server.
const APP_ORIGINS: &str = "http://tauri.localhost https://tauri.localhost tauri://localhost http://localhost:1420 http://127.0.0.1:1420";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewTarget {
    pub session_id: String,
    pub id: String,
    pub version: u32,
}

/// In-memory token -> artifact capability table.
#[derive(Default)]
pub struct PreviewTokens {
    entries: Mutex<HashMap<String, (PreviewTarget, Instant)>>,
}

impl PreviewTokens {
    /// Stores `target` under `token`, valid for `PREVIEW_TTL` from `now`.
    pub fn insert(&self, token: String, target: PreviewTarget, now: Instant) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, (_, expires)| *expires > now);
        while entries.len() >= PREVIEW_MAX_TOKENS {
            let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, (_, e))| *e)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            entries.remove(&oldest);
        }
        entries.insert(token, (target, now + PREVIEW_TTL));
    }

    /// Mints a fresh unguessable token (128 random bits, hex).
    pub fn mint(&self, target: PreviewTarget, now: Instant) -> Result<String, String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "secure randomness is unavailable".to_string())?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.insert(token.clone(), target, now);
        Ok(token)
    }

    pub fn lookup(&self, token: &str, now: Instant) -> Option<PreviewTarget> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries
            .get(token)
            .filter(|(_, expires)| *expires > now)
            .map(|(t, _)| t.clone())
    }
}

/// `/<32 hex>` or `/<32 hex>/` -> the token.
pub fn token_from_path(path: &str) -> Option<&str> {
    let token = path.strip_prefix('/')?;
    let token = token.strip_suffix('/').unwrap_or(token);
    (token.len() == 32
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(token)
}

/// URL the webview loads for a minted token.
pub fn preview_url(token: &str) -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://{PREVIEW_SCHEME}.localhost/{token}/")
    } else {
        format!("{PREVIEW_SCHEME}://localhost/{token}/")
    }
}

/// `(Content-Type, Content-Security-Policy)` for an artifact kind; `None` when it has no in-app frame preview.
pub fn preview_headers(kind: ArtifactKind) -> Option<(&'static str, String)> {
    let tail = format!("frame-ancestors {APP_ORIGINS}; form-action 'none'; base-uri 'none'");
    match kind {
        ArtifactKind::Html => Some((
            "text/html; charset=utf-8",
            format!("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; {tail}"),
        )),
        ArtifactKind::Svg => Some((
            "image/svg+xml",
            format!("default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; {tail}"),
        )),
        _ => None,
    }
}

fn plain(status: StatusCode) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Vec::new())
        .expect("static response")
}

/// Builds the response for one request. `load` fetches the artifact for a valid token.
pub fn preview_response(
    method: &Method,
    path: &str,
    tokens: &PreviewTokens,
    now: Instant,
    load: impl FnOnce(&PreviewTarget) -> Result<ArtifactContent, String>,
) -> http::Response<Vec<u8>> {
    if method != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(target) = token_from_path(path).and_then(|t| tokens.lookup(t, now)) else {
        return plain(StatusCode::NOT_FOUND);
    };
    let Ok(item) = load(&target) else {
        return plain(StatusCode::NOT_FOUND);
    };
    let Some((content_type, csp)) = preview_headers(item.meta.kind) else {
        return plain(StatusCode::NOT_FOUND);
    };
    http::Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, csp)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .body(item.content.into_bytes())
        .expect("valid response")
}

/// Handler for the `omnia-artifact` scheme (registered in `run`).
pub fn handle_preview_request(
    app: &AppHandle,
    request: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let tokens = app.state::<PreviewTokens>();
    preview_response(
        request.method(),
        request.uri().path(),
        &tokens,
        Instant::now(),
        |target| {
            let hub = app.state::<HarnessHub>();
            let cwd = hub
                .session_workspace(&target.session_id)
                .map_err(|e| e.message)?;
            artifact::read(&cwd, &target.session_id, &target.id, Some(target.version))
        },
    )
}

/// Mints a short-lived capability URL for framing one html/svg artifact version.
#[tauri::command]
pub fn agent_artifact_preview_url(
    hub: State<'_, HarnessHub>,
    tokens: State<'_, PreviewTokens>,
    request: ArtifactRef,
) -> NativeResult<String> {
    let cwd = hub.session_workspace(&request.session_id)?;
    let item =
        artifact::read(&cwd, &request.session_id, &request.id, request.version).map_err(failed)?;
    if preview_headers(item.meta.kind).is_none() {
        return Err(failed(
            "only html and svg artifacts have a frame preview".into(),
        ));
    }
    let token = tokens
        .mint(
            PreviewTarget {
                session_id: request.session_id,
                id: item.meta.id.clone(),
                version: item.version,
            },
            Instant::now(),
        )
        .map_err(failed)?;
    Ok(preview_url(&token))
}

fn code_extension(language: Option<&str>) -> &'static str {
    match language.map(|l| l.trim().to_ascii_lowercase()).as_deref() {
        Some("python" | "py") => "py",
        Some("javascript" | "js") => "js",
        Some("typescript" | "ts") => "ts",
        Some("rust" | "rs") => "rs",
        Some("json") => "json",
        Some("css") => "css",
        Some("sql") => "sql",
        Some("bash" | "sh" | "shell") => "sh",
        Some("go") => "go",
        Some("yaml" | "yml") => "yaml",
        _ => "txt",
    }
}

fn export_extension(meta: &ArtifactMeta) -> String {
    match meta.kind {
        ArtifactKind::Html => "html".into(),
        ArtifactKind::Markdown => "md".into(),
        ArtifactKind::Svg => "svg".into(),
        ArtifactKind::Mermaid => "mmd".into(),
        ArtifactKind::Csv => "csv".into(),
        ArtifactKind::Code => code_extension(meta.language.as_deref()).into(),
    }
}

fn export_file_name(meta: &ArtifactMeta) -> String {
    let stem: String = meta
        .title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let stem = stem.trim().trim_matches('-').trim();
    // Only a suggestion for the save dialog; never derived from ids or paths.
    let stem = if stem.is_empty() { "artifact" } else { stem };
    format!("{stem}.{}", export_extension(meta))
}

/// Standalone page for the system browser.  The CSP lives in a `<meta>` tag
/// (see `PREVIEW_CSP` for what it does and does not restrict).
fn browser_document(item: &ArtifactContent) -> Result<String, String> {
    match item.meta.kind {
        ArtifactKind::Html | ArtifactKind::Svg => Ok(format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{PREVIEW_CSP}\"></head><body>{}</body></html>",
            item.content
        )),
        _ => Err("only html and svg artifacts can be opened in the browser".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_harness::tools::artifact::ArtifactInput;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("omnia-artifact-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(kind: ArtifactKind, title: &str, language: Option<&str>) -> ArtifactContent {
        let cwd = scratch();
        let meta = artifact::create(
            &cwd,
            "s",
            ArtifactInput {
                title: Some(title.into()),
                kind: Some(kind),
                language: language.map(str::to_owned),
                content: "<p>hi</p>".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let item = artifact::read(&cwd, "s", &meta.id, None).unwrap();
        let _ = std::fs::remove_dir_all(&cwd);
        item
    }

    fn target() -> PreviewTarget {
        PreviewTarget {
            session_id: "s".into(),
            id: "a1".into(),
            version: 2,
        }
    }

    #[test]
    fn tokens_are_random_lookup_and_expire() {
        let tokens = PreviewTokens::default();
        let t0 = Instant::now();
        let a = tokens.mint(target(), t0).unwrap();
        let b = tokens.mint(target(), t0).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert_eq!(token_from_path(&format!("/{a}/")), Some(a.as_str()));
        assert_eq!(tokens.lookup(&a, t0), Some(target()));
        assert_eq!(
            tokens.lookup(&a, t0 + PREVIEW_TTL - Duration::from_secs(1)),
            Some(target())
        );
        assert_eq!(tokens.lookup(&a, t0 + PREVIEW_TTL), None);
        assert_eq!(tokens.lookup(&"0".repeat(32), t0), None);
    }

    #[test]
    fn token_table_is_bounded_and_purges_expired() {
        let tokens = PreviewTokens::default();
        let t0 = Instant::now();
        for i in 0..PREVIEW_MAX_TOKENS + 10 {
            tokens.insert(
                format!("{i:032x}"),
                target(),
                t0 + Duration::from_millis(i as u64),
            );
        }
        assert_eq!(tokens.entries.lock().unwrap().len(), PREVIEW_MAX_TOKENS);
        assert_eq!(tokens.lookup(&format!("{:032x}", 0), t0), None);
        tokens.insert("f".repeat(32), target(), t0 + PREVIEW_TTL * 2);
        assert_eq!(tokens.entries.lock().unwrap().len(), 1);
    }

    #[test]
    fn token_paths_are_strict() {
        let ok = "ab".repeat(16);
        assert_eq!(token_from_path(&format!("/{ok}")), Some(ok.as_str()));
        assert_eq!(token_from_path("/"), None);
        assert_eq!(token_from_path(&format!("/{ok}/extra")), None);
        assert_eq!(token_from_path(&format!("/../{ok}")), None);
        assert_eq!(token_from_path(&format!("/{}", "AB".repeat(16))), None);
        assert_eq!(token_from_path("/short"), None);
    }

    #[test]
    fn preview_headers_lock_down_html_and_svg_only() {
        let (ct, csp) = preview_headers(ArtifactKind::Html).unwrap();
        assert_eq!(ct, "text/html; charset=utf-8");
        for part in [
            "default-src 'none'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline'",
            "img-src data: blob:",
            "font-src data:",
            "connect-src 'none'",
            "frame-ancestors http://tauri.localhost",
            "form-action 'none'",
            "base-uri 'none'",
        ] {
            assert!(csp.contains(part), "{part} missing from {csp}");
        }
        let (ct, csp) = preview_headers(ArtifactKind::Svg).unwrap();
        assert_eq!(ct, "image/svg+xml");
        assert!(csp.contains("script-src 'none'") && !csp.contains("unsafe-inline'; style"));
        assert!(preview_headers(ArtifactKind::Markdown).is_none());
        assert!(preview_headers(ArtifactKind::Csv).is_none());
    }

    #[test]
    fn preview_response_serves_only_valid_get_with_security_headers() {
        let tokens = PreviewTokens::default();
        let now = Instant::now();
        let token = tokens.mint(target(), now).unwrap();
        let path = format!("/{token}/");
        let load = |t: &PreviewTarget| {
            assert_eq!((t.id.as_str(), t.version), ("a1", 2));
            Ok(sample(ArtifactKind::Html, "Page", None))
        };
        let ok = preview_response(&Method::GET, &path, &tokens, now, load);
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()["content-type"], "text/html; charset=utf-8");
        assert_eq!(ok.headers()["x-content-type-options"], "nosniff");
        assert_eq!(ok.headers()["cache-control"], "no-store");
        assert!(ok.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("connect-src 'none'"));
        assert_eq!(ok.body().as_slice(), b"<p>hi</p>");

        let never =
            |_: &PreviewTarget| -> Result<ArtifactContent, String> { panic!("must not load") };
        assert_eq!(
            preview_response(&Method::POST, &path, &tokens, now, never).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            preview_response(
                &Method::GET,
                &format!("/{}/", "0".repeat(32)),
                &tokens,
                now,
                never
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            preview_response(&Method::GET, &path, &tokens, now + PREVIEW_TTL, never).status(),
            StatusCode::NOT_FOUND
        );
        let failing = |_: &PreviewTarget| -> Result<ArtifactContent, String> { Err("gone".into()) };
        assert_eq!(
            preview_response(&Method::GET, &path, &tokens, now, failing).status(),
            StatusCode::NOT_FOUND
        );
        let md = |_: &PreviewTarget| Ok(sample(ArtifactKind::Markdown, "Doc", None));
        assert_eq!(
            preview_response(&Method::GET, &path, &tokens, now, md).status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn preview_url_uses_the_platform_form() {
        let url = preview_url("abc");
        if cfg!(windows) {
            assert_eq!(url, "http://omnia-artifact.localhost/abc/");
        } else {
            assert_eq!(url, "omnia-artifact://localhost/abc/");
        }
    }

    #[test]
    fn export_names_are_sanitized_and_typed() {
        let item = sample(ArtifactKind::Html, "A/B: \"page\"?", None);
        assert_eq!(export_file_name(&item.meta), "A-B- -page.html");
        let item = sample(ArtifactKind::Code, "Script", Some("Python"));
        assert_eq!(export_file_name(&item.meta), "Script.py");
        let item = sample(ArtifactKind::Code, "Unknown", Some("brainfuck"));
        assert_eq!(export_file_name(&item.meta), "Unknown.txt");
    }

    #[test]
    fn browser_document_is_html_svg_only_and_carries_csp() {
        let html = browser_document(&sample(ArtifactKind::Html, "Page", None)).unwrap();
        assert!(html.contains("Content-Security-Policy"));
        assert!(html.contains("connect-src 'none'"));
        assert!(html.contains("<p>hi</p>"));
        assert!(browser_document(&sample(ArtifactKind::Svg, "Pic", None)).is_ok());
        assert!(browser_document(&sample(ArtifactKind::Markdown, "Doc", None)).is_err());
    }

    #[test]
    fn browser_files_are_random_contained_and_never_overwrite() {
        let base = scratch().join("omnia-artifacts");
        let a = write_browser_file(&base, "<p>a</p>").unwrap();
        let b = write_browser_file(&base, "<p>b</p>").unwrap();
        assert_ne!(a, b);
        let root = dunce::canonicalize(&base).unwrap();
        for file in [&a, &b] {
            assert_eq!(file.parent(), Some(root.as_path()));
            let name = file.file_name().unwrap().to_string_lossy().into_owned();
            let hex = name
                .strip_prefix("omnia-artifact-")
                .and_then(|n| n.strip_suffix(".html"))
                .unwrap();
            assert_eq!(hex.len(), 16);
            assert!(hex
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        }
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "<p>a</p>");
        let _ = std::fs::remove_dir_all(base.parent().unwrap());
    }

    #[test]
    fn tampered_meta_id_cannot_reach_export_or_open_names() {
        let cwd = scratch();
        let meta = artifact::create(
            &cwd,
            "s",
            ArtifactInput {
                title: Some("T".into()),
                kind: Some(ArtifactKind::Html),
                content: "<p>x</p>".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let meta_path = artifact::artifacts_root(&cwd)
            .join(&meta.id)
            .join("meta.json");
        let text = std::fs::read_to_string(&meta_path).unwrap();
        std::fs::write(
            &meta_path,
            text.replace(
                &format!("\"id\": \"{}\"", meta.id),
                "\"id\": \"../../evil\"",
            ),
        )
        .unwrap();
        assert!(artifact::read(&cwd, "s", &meta.id, None).is_err());
        assert!(artifact::list(&cwd, "s").is_empty());
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn export_name_falls_back_without_using_the_id() {
        let mut item = sample(ArtifactKind::Html, "///", None);
        item.meta.id = "../../evil".into();
        assert_eq!(export_file_name(&item.meta), "artifact.html");
    }

    #[test]
    fn host_reads_are_session_scoped_and_reject_traversal() {
        let cwd = scratch();
        let meta = artifact::create(
            &cwd,
            "mine",
            ArtifactInput {
                title: Some("T".into()),
                kind: Some(ArtifactKind::Csv),
                content: "a,b\n1,2".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(artifact::list(&cwd, "mine").len(), 1);
        assert!(artifact::list(&cwd, "theirs").is_empty());
        assert!(artifact::read(&cwd, "theirs", &meta.id, None).is_err());
        assert!(artifact::read(&cwd, "mine", "../etc", None).is_err());
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
