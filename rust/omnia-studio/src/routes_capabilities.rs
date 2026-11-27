//! Capability routes bridging `omnia-workspace-ops`, `omnia-connector-gateway`,
//! `omnia-media-capture`, and `omnia-remote-control` into Flagship Studio `/api/*`.

use crate::http::{HttpRequest, HttpResponse};
use crate::routes_legacy::StudioState;
use omnia_connector_gateway::{
    find_unsafe_prototype_key,
    opencode_compat::{
        evaluate_opencode_endpoint, AvailabilityReason, ConnectorAvailability,
        OpenCodeEndpointConfig, OpenCodeEndpointStatus,
    },
    proxy_router::{normalize_proxy_route_config, ProxyConfigPolicy},
    sanitize_and_inspect_url, UrlInspectionPolicy,
};
use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_media_capture::{
    browser_cdp::{probe_cdp_endpoint, CdpEndpointPolicy},
    capability::{CapabilityReport, CapabilityStatus},
    obs_v5::probe_obs_endpoint,
    window_capture::{
        probe_window_target_status, validate_capture_receipt, CaptureFrameReceipt,
        CapturePixelFormat, WindowCaptureError, WindowIdentity,
    },
};
use omnia_remote_control::{
    crypto::{decode_base64, sha256, sha256_hex, SessionKey},
    pairing::{
        complete_pairing_approver, complete_pairing_initiator, CapabilityScope, PairingApproval,
        PairingError, PairingOffer, PeerLeaseStore, SessionLease,
    },
    protocol::{
        ButtonAction, FrameEnvelope, FramePayload, KeyAction, MouseButton, PeerSession,
        ProtocolError, TouchAction, TouchPoint,
    },
    replay::REPLAY_WINDOW_SIZE,
};
use omnia_workspace_ops::{
    fs_ops::{
        read_snippet, read_text_file, rollback_write, unified_diff, write_atomic, LineEndingPolicy,
        WriteOptions,
    },
    path_guard::{is_reparse_point_metadata, relative_posix_path, resolve_contained_path},
    process_ops::{run_bounded_command, CommandSpec},
    WorkspaceOpsError,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;
use tokio::net::TcpStream;

const MAX_TREE_DEPTH: usize = 6;
const DEFAULT_TREE_DEPTH: usize = 2;
const MAX_TREE_ENTRIES: usize = 500;
const MAX_AUDIT_LOG_ENTRIES: usize = 256;
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
const MAX_EXEC_TIMEOUT_MS: u64 = 300_000;
const DEFAULT_LEASE_TTL_MS: u64 = 300_000;

fn is_unc_or_smb_path(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.starts_with(r"\\")
        || trimmed.starts_with("//")
        || trimmed.starts_with(r"\??\")
        || trimmed.starts_with("/??/")
}

fn unc_path_blocked_response() -> HttpResponse {
    HttpResponse::error(
        400,
        "unc_path_blocked",
        "UNC/SMB network paths are blocked for workspace operations.",
    )
}

/// Configured connector metadata retained in Studio state.
#[derive(Debug, Clone)]
pub struct ConnectorConfigRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub endpoint: Option<String>,
    pub allow_remote_https: bool,
    pub allow_private_endpoints: bool,
    pub strict_tls: bool,
}

/// Returns initial default connector records aligned with truthful offline/configured semantics.
#[must_use]
pub fn default_connector_configs() -> Vec<ConnectorConfigRecord> {
    let opencode_url = env::var("OMNIA_OPENCODE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    vec![
        ConnectorConfigRecord {
            id: "opencode".to_string(),
            name: "OpenCode Gateway".to_string(),
            kind: "opencode".to_string(),
            endpoint: opencode_url,
            allow_remote_https: false,
            allow_private_endpoints: false,
            strict_tls: true,
        },
        ConnectorConfigRecord {
            id: "proxy-router".to_string(),
            name: "Omnia Proxy Router".to_string(),
            kind: "proxy_router".to_string(),
            endpoint: None,
            allow_remote_https: false,
            allow_private_endpoints: false,
            strict_tls: true,
        },
    ]
}

#[derive(Debug)]
struct PairedSessionPair {
    host: PeerSession,
    controller: PeerSession,
    inbound_scopes: Vec<CapabilityScope>,
    outbound_scopes: Vec<CapabilityScope>,
}

/// Fail-closed in-memory state backing `/api/remote/*` pairing, leases, and frame verification.
#[derive(Debug)]
pub struct RemoteControlState {
    lease_store: PeerLeaseStore,
    sessions: BTreeMap<String, PairedSessionPair>,
    pairing_secret: Vec<u8>,
    nonce_counter: u64,
    audit_log: Vec<Value>,
}

impl Default for RemoteControlState {
    fn default() -> Self {
        let seed = format!(
            "omnia-studio-remote-ephemeral:{}:{}",
            std::process::id(),
            now_epoch_ms()
        );
        Self {
            lease_store: PeerLeaseStore::new(),
            sessions: BTreeMap::new(),
            pairing_secret: sha256(seed.as_bytes()).to_vec(),
            nonce_counter: 1,
            audit_log: Vec::new(),
        }
    }
}

impl RemoteControlState {
    fn next_nonce(&mut self, prefix: &str) -> String {
        let n = self.nonce_counter;
        self.nonce_counter = self.nonce_counter.saturating_add(1);
        format!("{prefix}-{n}")
    }

    fn record_audit(&mut self, entry: Value) {
        if self.audit_log.len() >= MAX_AUDIT_LOG_ENTRIES {
            let drain = self.audit_log.len() - MAX_AUDIT_LOG_ENTRIES + 1;
            self.audit_log.drain(0..drain);
        }
        self.audit_log.push(entry);
    }
}

/// Dispatches `/api/workspace/*`, `/api/connectors/*`, `/api/media/*`, and `/api/remote/*`.
/// Returns `None` when the request path belongs to legacy/static routing.
pub async fn dispatch_capability_route(
    state: &StudioState,
    req: &HttpRequest,
) -> Option<HttpResponse> {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/workspace/tree") => Some(handle_workspace_tree(state, req).await),
        ("GET", "/api/workspace/file") => Some(handle_workspace_file(state, req).await),
        ("POST", "/api/workspace/diff") => Some(handle_workspace_diff(state, req).await),
        ("POST", "/api/workspace/exec") => Some(handle_workspace_exec(state, req).await),

        ("GET", "/api/connectors/status") => Some(handle_connectors_status(state, req).await),
        ("POST", "/api/connectors/validate") => Some(handle_connectors_validate(state, req).await),

        ("GET", "/api/media/capabilities") => Some(handle_media_capabilities(req).await),
        ("GET", "/api/media/isolation") => Some(handle_media_isolation()),
        ("GET", "/api/media/windows") => Some(handle_media_windows()),
        ("GET", "/api/media/browser/cdp") => Some(handle_media_cdp(req).await),
        ("GET", "/api/media/obs/status") => Some(handle_media_obs(req).await),
        ("POST", "/api/media/capture/window") => Some(handle_media_window_capture(req)),

        ("GET", "/api/remote/status") => Some(handle_remote_status(state)),
        ("GET", "/api/remote/audit") => Some(handle_remote_audit(state)),
        ("POST", "/api/remote/pair") => Some(handle_remote_pair(state, req)),
        ("POST", "/api/remote/session") => Some(handle_remote_session(state, req)),
        ("POST", "/api/remote/input") => Some(handle_remote_input(state, req)),
        ("POST", "/api/remote/frame") => Some(handle_remote_frame(state, req)),

        (
            _,
            "/api/workspace/tree"
            | "/api/workspace/file"
            | "/api/workspace/diff"
            | "/api/workspace/exec"
            | "/api/connectors/status"
            | "/api/connectors/validate"
            | "/api/media/capabilities"
            | "/api/media/isolation"
            | "/api/media/windows"
            | "/api/media/browser/cdp"
            | "/api/media/obs/status"
            | "/api/media/capture/window"
            | "/api/remote/status"
            | "/api/remote/audit"
            | "/api/remote/pair"
            | "/api/remote/session"
            | "/api/remote/input"
            | "/api/remote/frame",
        ) => Some(HttpResponse::error(
            405,
            "method_not_allowed",
            "HTTP method not allowed for capability route.",
        )),

        _ => None,
    }
}

fn map_workspace_error(err: WorkspaceOpsError) -> HttpResponse {
    match err {
        WorkspaceOpsError::PathTraversal { .. }
        | WorkspaceOpsError::OutsideWorkspace { .. }
        | WorkspaceOpsError::ReparsePointDetected { .. }
        | WorkspaceOpsError::RollbackDirInsideWorkspace { .. }
        | WorkspaceOpsError::NulByteInPath { .. }
        | WorkspaceOpsError::EmptyPath
        | WorkspaceOpsError::ForbiddenPathPrefix { .. } => {
            HttpResponse::error(403, "workspace_access_denied", &err.to_string())
        }
        WorkspaceOpsError::Io { ref source, .. }
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            HttpResponse::error(404, "workspace_not_found", &err.to_string())
        }
        _ => HttpResponse::error(400, "workspace_operation_failed", &err.to_string()),
    }
}

fn should_skip_tree_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "target" | "build" | "__pycache__" | "node_modules" | ".vs"
    )
}

#[derive(Debug)]
struct TreeEntry {
    name: String,
    relative_path: String,
    kind: &'static str,
    bytes: u64,
    depth: usize,
}

fn collect_tree_entries(
    workspace_root: &Path,
    rel_subpath: &str,
    max_depth: usize,
) -> Result<(String, Vec<TreeEntry>, bool), WorkspaceOpsError> {
    let target = if rel_subpath.trim().is_empty() || rel_subpath.trim() == "." {
        omnia_workspace_ops::path_guard::resolve_workspace_root(workspace_root)?
    } else {
        resolve_contained_path(workspace_root, rel_subpath)?
    };
    let canonical_root = omnia_workspace_ops::path_guard::resolve_workspace_root(workspace_root)?;
    let target_meta = fs::symlink_metadata(&target).map_err(|source| WorkspaceOpsError::Io {
        operation: "symlink_metadata",
        path: target.display().to_string(),
        source,
    })?;
    if is_reparse_point_metadata(&target_meta) {
        return Err(WorkspaceOpsError::ReparsePointDetected {
            path: target.display().to_string(),
        });
    }
    if !target_meta.is_dir() {
        return Err(WorkspaceOpsError::NotADirectory {
            path: target.display().to_string(),
        });
    }

    let base_rel = relative_posix_path(&canonical_root, &target)?;
    let mut out = Vec::new();
    let mut truncated = false;
    walk_tree_recursive(
        &canonical_root,
        &target,
        1,
        max_depth,
        &mut out,
        &mut truncated,
    )?;

    Ok((base_rel, out, truncated))
}

fn walk_tree_recursive(
    canonical_root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<TreeEntry>,
    truncated: &mut bool,
) -> Result<(), WorkspaceOpsError> {
    if depth > max_depth || *truncated {
        return Ok(());
    }

    let rd = fs::read_dir(dir).map_err(|source| WorkspaceOpsError::Io {
        operation: "read_dir",
        path: dir.display().to_string(),
        source,
    })?;

    let mut children = Vec::new();
    for entry in rd {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if is_reparse_point_metadata(&meta) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if meta.is_dir() && should_skip_tree_dir(&name) {
            continue;
        }
        children.push((meta.is_dir(), name, path, meta.len()));
    }

    children.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    for (is_dir, name, path, len) in children {
        if out.len() >= MAX_TREE_ENTRIES {
            *truncated = true;
            break;
        }
        let Ok(contained) = resolve_contained_path(canonical_root, &path) else {
            continue;
        };
        let Ok(rel) = relative_posix_path(canonical_root, &contained) else {
            continue;
        };
        out.push(TreeEntry {
            name,
            relative_path: rel,
            kind: if is_dir { "dir" } else { "file" },
            bytes: if is_dir { 0 } else { len },
            depth,
        });
        if is_dir && depth < max_depth && !*truncated {
            walk_tree_recursive(
                canonical_root,
                &contained,
                depth + 1,
                max_depth,
                out,
                truncated,
            )?;
        }
    }

    Ok(())
}

async fn handle_workspace_tree(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let rel_path = req
        .query_param("path")
        .unwrap_or_default()
        .trim()
        .to_string();
    if is_unc_or_smb_path(&rel_path) {
        return unc_path_blocked_response();
    }
    let max_depth = match req
        .query_param("max_depth")
        .or_else(|| req.query_param("maxDepth"))
    {
        Some(raw) if !raw.trim().is_empty() => match raw.trim().parse::<usize>() {
            Ok(v) if (1..=MAX_TREE_DEPTH).contains(&v) => v,
            _ => {
                return HttpResponse::error(
                    400,
                    "invalid_max_depth",
                    "Query parameter 'max_depth' must be between 1 and 6.",
                );
            }
        },
        _ => DEFAULT_TREE_DEPTH,
    };

    let root = state.config.workspace_root.clone();
    let result =
        tokio::task::spawn_blocking(move || collect_tree_entries(&root, &rel_path, max_depth))
            .await;

    match result {
        Err(join_err) => HttpResponse::error(500, "workspace_task_failed", &join_err.to_string()),
        Ok(Err(err)) => map_workspace_error(err),
        Ok(Ok((base_rel, entries, truncated))) => {
            let items: Vec<Value> = entries
                .into_iter()
                .map(|entry| {
                    json!({
                        "name": entry.name,
                        "path": entry.relative_path,
                        "relativePath": entry.relative_path,
                        "kind": entry.kind,
                        "bytes": entry.bytes,
                        "sizeBytes": entry.bytes,
                        "depth": entry.depth,
                    })
                })
                .collect();
            HttpResponse::ok(json!({
                "ok": true,
                "root": state.config.workspace_root.display().to_string(),
                "path": base_rel,
                "maxDepth": max_depth,
                "truncated": truncated,
                "count": items.len(),
                "entries": items,
            }))
        }
    }
}

async fn handle_workspace_file(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let rel_path = match req.query_param("path") {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => {
            return HttpResponse::error(400, "missing_path", "Query parameter 'path' is required.");
        }
    };
    if is_unc_or_smb_path(&rel_path) {
        return unc_path_blocked_response();
    }

    let start_line_opt = match req
        .query_param("start_line")
        .or_else(|| req.query_param("startLine"))
    {
        Some(raw) if !raw.trim().is_empty() => match raw.trim().parse::<usize>() {
            Ok(v) if v >= 1 => Some(v),
            _ => {
                return HttpResponse::error(
                    400,
                    "invalid_line_range",
                    "Query parameter 'start_line' must be a positive integer.",
                );
            }
        },
        _ => None,
    };
    let end_line_opt = match req
        .query_param("end_line")
        .or_else(|| req.query_param("endLine"))
    {
        Some(raw) if !raw.trim().is_empty() => match raw.trim().parse::<usize>() {
            Ok(v) if v >= 1 => Some(v),
            _ => {
                return HttpResponse::error(
                    400,
                    "invalid_line_range",
                    "Query parameter 'end_line' must be a positive integer.",
                );
            }
        },
        _ => None,
    };

    let root = state.config.workspace_root.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Value, WorkspaceOpsError> {
        if start_line_opt.is_some() || end_line_opt.is_some() {
            let start = start_line_opt.unwrap_or(1);
            let end = end_line_opt.unwrap_or_else(|| start.saturating_add(199));
            let snip = read_snippet(
                &root,
                &rel_path,
                start,
                end,
                LineEndingPolicy::NormalizeToLf,
            )?;
            let lines: Vec<Value> = snip
                .lines
                .iter()
                .map(|line| {
                    json!({
                        "lineNumber": line.line_number,
                        "line_number": line.line_number,
                        "text": line.text,
                    })
                })
                .collect();
            let raw_content: String = snip
                .lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            Ok(json!({
                "ok": true,
                "path": snip.relative_path,
                "relativePath": snip.relative_path,
                "sha256": snip.sha256,
                "startLine": snip.start_line,
                "endLine": snip.end_line,
                "lineCount": snip.lines.len(),
                "totalLines": snip.total_lines,
                "lines": lines,
                "content": raw_content,
                "formatted": snip.formatted,
            }))
        } else {
            let read = read_text_file(&root, &rel_path, LineEndingPolicy::NormalizeToLf)?;
            let lines: Vec<Value> = read
                .content
                .lines()
                .enumerate()
                .map(|(idx, text)| {
                    json!({
                        "lineNumber": idx + 1,
                        "line_number": idx + 1,
                        "text": text,
                    })
                })
                .collect();
            Ok(json!({
                "ok": true,
                "path": read.relative_path,
                "relativePath": read.relative_path,
                "sha256": read.sha256,
                "rawSha256": read.raw_sha256,
                "hadCrlf": read.had_crlf,
                "byteLen": read.byte_len,
                "lineCount": read.line_count,
                "totalLines": read.line_count,
                "startLine": 1,
                "endLine": read.line_count,
                "lines": lines,
                "content": read.content,
            }))
        }
    })
    .await;

    match result {
        Err(join_err) => HttpResponse::error(500, "workspace_task_failed", &join_err.to_string()),
        Ok(Err(err)) => map_workspace_error(err),
        Ok(Ok(payload)) => HttpResponse::ok(payload),
    }
}

async fn handle_workspace_diff(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let rollback_requested = obj
        .get("rollback")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if rollback_requested {
        let Some(receipt_path) = obj
            .get("rollbackReceiptPath")
            .or_else(|| obj.get("receiptPath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return HttpResponse::error(
                400,
                "missing_receipt_path",
                "Field 'rollbackReceiptPath' is required when rollback=true.",
            );
        };
        if is_unc_or_smb_path(receipt_path) {
            return unc_path_blocked_response();
        }
        let rollback_root = state.config.rollback_root.clone();
        let workspace_root = state.config.workspace_root.clone();
        let receipt_owned = PathBuf::from(receipt_path);
        let outcome = tokio::task::spawn_blocking(move || -> Result<Value, WorkspaceOpsError> {
            let contained_receipt = resolve_contained_path(&rollback_root, &receipt_owned)?;
            let rb = rollback_write(&workspace_root, &contained_receipt)?;
            Ok(json!({
                "ok": true,
                "rolledBack": true,
                "receiptId": rb.receipt_id,
                "relativePath": rb.relative_path,
                "action": rb.action,
                "restoredSha256": rb.restored_sha256,
            }))
        })
        .await;
        return match outcome {
            Err(join_err) => {
                HttpResponse::error(500, "workspace_task_failed", &join_err.to_string())
            }
            Ok(Err(err)) => map_workspace_error(err),
            Ok(Ok(val)) => HttpResponse::ok(val),
        };
    }

    let Some(rel_path) = obj
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
    else {
        return HttpResponse::error(400, "missing_path", "Field 'path' is required.");
    };
    if is_unc_or_smb_path(&rel_path) {
        return unc_path_blocked_response();
    }

    let Some(after_content) = obj
        .get("content")
        .or_else(|| obj.get("after"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
    else {
        return HttpResponse::error(
            400,
            "missing_content",
            "Field 'content' (or 'after') string is required.",
        );
    };

    let before_override = obj
        .get("before")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let context_lines = obj
        .get("contextLines")
        .or_else(|| obj.get("context_lines"))
        .and_then(Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(3).min(20))
        .unwrap_or(3);
    let apply = obj.get("apply").and_then(Value::as_bool).unwrap_or(false);

    let workspace_root = state.config.workspace_root.clone();
    let rollback_root = state.config.rollback_root.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<Value, WorkspaceOpsError> {
        if apply {
            let options = WriteOptions {
                line_ending_policy: LineEndingPolicy::NormalizeToLf,
                create_parents: true,
                rollback_dir: Some(rollback_root.clone()),
                diff_context_lines: context_lines,
            };
            let receipt = write_atomic(&workspace_root, &rel_path, &after_content, &options)?;
            let rollback_json = receipt.rollback.as_ref().map(|rb| {
                json!({
                    "receiptId": rb.receipt_id,
                    "receiptPath": rb.receipt_path.display().to_string(),
                    "backupBlobPath": rb.backup_blob_path.as_ref().map(|p| p.display().to_string()),
                    "beforeSha256": rb.before_sha256,
                    "afterSha256": rb.after_sha256,
                })
            });
            return Ok(json!({
                "ok": true,
                "applied": true,
                "path": receipt.relative_path,
                "relativePath": receipt.relative_path,
                "existedBefore": receipt.existed_before,
                "beforeSha256": receipt.before_sha256,
                "afterSha256": receipt.after_sha256,
                "bytesWritten": receipt.bytes_written,
                "hadCrlfInput": receipt.had_crlf_input,
                "changed": receipt.diff.changed,
                "additions": receipt.diff.lines_added,
                "deletions": receipt.diff.lines_removed,
                "linesAdded": receipt.diff.lines_added,
                "linesRemoved": receipt.diff.lines_removed,
                "hunks": receipt.diff.hunk_count,
                "hunkCount": receipt.diff.hunk_count,
                "unifiedDiff": receipt.diff.unified_diff,
                "rollbackRoot": rollback_root.display().to_string(),
                "rollbackReceipt": rollback_json,
            }));
        }

        let canonical_root =
            omnia_workspace_ops::path_guard::resolve_workspace_root(&workspace_root)?;
        let target = resolve_contained_path(&canonical_root, &rel_path)?;
        let rel = relative_posix_path(&canonical_root, &target)?;

        let (existed_before, before_text) = if let Some(before) = before_override {
            (true, before)
        } else {
            match read_text_file(&canonical_root, &rel, LineEndingPolicy::NormalizeToLf) {
                Ok(read) => (true, read.content),
                Err(WorkspaceOpsError::Io { ref source, .. })
                    if source.kind() == std::io::ErrorKind::NotFound =>
                {
                    (false, String::new())
                }
                Err(other) => return Err(other),
            }
        };

        let after_lf = after_content.replace("\r\n", "\n").replace('\r', "\n");
        let before_lf = before_text.replace("\r\n", "\n").replace('\r', "\n");
        let summary = unified_diff(&rel, existed_before, &before_lf, &after_lf, context_lines);

        Ok(json!({
            "ok": true,
            "applied": false,
            "path": rel,
            "relativePath": rel,
            "existedBefore": existed_before,
            "changed": summary.changed,
            "additions": summary.lines_added,
            "deletions": summary.lines_removed,
            "linesAdded": summary.lines_added,
            "linesRemoved": summary.lines_removed,
            "hunks": summary.hunk_count,
            "hunkCount": summary.hunk_count,
            "unifiedDiff": summary.unified_diff,
            "rollbackRoot": rollback_root.display().to_string(),
            "rollbackReceipt": Value::Null,
        }))
    })
    .await;

    match result {
        Err(join_err) => HttpResponse::error(500, "workspace_task_failed", &join_err.to_string()),
        Ok(Err(err)) => map_workspace_error(err),
        Ok(Ok(val)) => HttpResponse::ok(val),
    }
}

async fn handle_workspace_exec(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let Some(program) = obj
        .get("program")
        .or_else(|| obj.get("command"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
    else {
        return HttpResponse::error(400, "missing_program", "Field 'program' is required.");
    };

    if is_unc_or_smb_path(&program) {
        return unc_path_blocked_response();
    }

    let args: Vec<String> = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();

    let timeout_ms = obj
        .get("timeoutMs")
        .or_else(|| obj.get("timeout_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_EXEC_TIMEOUT_MS);
    if timeout_ms == 0 || timeout_ms > MAX_EXEC_TIMEOUT_MS {
        return HttpResponse::error(
            400,
            "invalid_timeout",
            "Field 'timeoutMs' must be between 1 and 300000.",
        );
    }

    let mut spec = CommandSpec::new(program)
        .with_args(args)
        .with_timeout_ms(timeout_ms);

    if let Some(cwd) = obj
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_unc_or_smb_path(cwd) {
            return unc_path_blocked_response();
        }
        spec = spec.with_cwd(cwd);
    }

    if let Some(max_out) = obj
        .get("maxStdoutBytes")
        .or_else(|| obj.get("max_stdout_bytes"))
        .and_then(Value::as_u64)
    {
        spec = spec.with_max_stdout_bytes(usize::try_from(max_out).unwrap_or(65_536));
    }

    if let Some(max_err) = obj
        .get("maxStderrBytes")
        .or_else(|| obj.get("max_stderr_bytes"))
        .and_then(Value::as_u64)
    {
        spec = spec.with_max_stderr_bytes(usize::try_from(max_err).unwrap_or(65_536));
    }

    let workspace_root = state.config.workspace_root.clone();
    let result =
        tokio::task::spawn_blocking(move || run_bounded_command(&workspace_root, &spec)).await;

    match result {
        Err(join_err) => HttpResponse::error(500, "workspace_task_failed", &join_err.to_string()),
        Ok(Err(err)) => map_workspace_error(err),
        Ok(Ok(receipt)) => HttpResponse::ok(json!({
            "ok": true,
            "program": receipt.program,
            "args": receipt.args,
            "cwd": receipt.relative_cwd,
            "resolvedCwd": receipt.resolved_cwd,
            "success": receipt.success,
            "exitCode": receipt.exit_code,
            "exit_code": receipt.exit_code,
            "timedOut": receipt.timed_out,
            "timed_out": receipt.timed_out,
            "terminationReason": receipt.termination_reason,
            "durationMs": receipt.duration_ms,
            "stdout": receipt.stdout,
            "stderr": receipt.stderr,
            "stdoutTruncated": receipt.stdout_truncated,
            "stderrTruncated": receipt.stderr_truncated,
            "stdoutTotalBytes": receipt.stdout_total_bytes,
            "stderrTotalBytes": receipt.stderr_total_bytes,
        })),
    }
}

fn truthful_connector_status_tag(status: &OpenCodeEndpointStatus) -> &'static str {
    // Strictly avoid synthetic `"connected"` claim; report only configured, offline, blocked, or error.
    match status.status {
        ConnectorAvailability::Available => "configured",
        ConnectorAvailability::Unavailable => {
            if status.sanitized_base_url.is_some()
                && status.reason == AvailabilityReason::ProbeNotRun
            {
                "configured"
            } else {
                "offline"
            }
        }
        ConnectorAvailability::Blocked => "blocked",
        ConnectorAvailability::Error => "error",
    }
}

fn availability_reason_tag(reason: AvailabilityReason) -> &'static str {
    match reason {
        AvailabilityReason::Ready => "ready",
        AvailabilityReason::Unconfigured => "unconfigured",
        AvailabilityReason::ProbeNotRun => "probe_not_run",
        AvailabilityReason::InvalidUrl => "invalid_url",
        AvailabilityReason::ProbeFailed => "probe_failed",
        _ => "policy_rejected",
    }
}

async fn probe_loopback_endpoint(raw_url: &str, timeout: Duration) -> (bool, Option<String>) {
    let Ok(parsed) = url::Url::parse(raw_url) else {
        return (false, Some("Invalid URL for endpoint probe".to_string()));
    };
    let Some(host) = parsed.host_str() else {
        return (false, Some("URL host is missing".to_string()));
    };
    let Some(port) = parsed.port_or_known_default() else {
        return (false, Some("URL port is missing".to_string()));
    };
    let addr_text = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let Ok(addr) = addr_text.parse::<SocketAddr>() else {
        let Ok(resolved) = tokio::net::lookup_host(&addr_text).await else {
            return (
                false,
                Some("Could not resolve endpoint address".to_string()),
            );
        };
        if let Some(first) = resolved.into_iter().next() {
            return match tokio::time::timeout(timeout, TcpStream::connect(first)).await {
                Ok(Ok(_)) => (true, None),
                Ok(Err(err)) => (false, Some(format!("Connection refused: {err}"))),
                Err(_) => (false, Some("Endpoint probe timed out".to_string())),
            };
        }
        return (false, Some("No socket addresses resolved".to_string()));
    };
    match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
        Ok(Ok(_)) => (true, None),
        Ok(Err(err)) => (false, Some(format!("Connection refused: {err}"))),
        Err(_) => (false, Some("Endpoint probe timed out".to_string())),
    }
}

async fn evaluate_connector_record(record: &ConnectorConfigRecord, run_probe: bool) -> Value {
    if record.kind == "proxy_router" {
        return json!({
            "id": record.id,
            "name": record.name,
            "kind": record.kind,
            "status": "configured",
            "verified": true,
            "reason": "ready",
            "detail": "ProxyRouter anti-spoof and secret-redaction policy active.",
            "endpoint": record.endpoint,
        });
    }

    let cfg = OpenCodeEndpointConfig {
        base_url: record.endpoint.clone(),
        enabled: record.endpoint.is_some(),
        allow_remote_https: record.allow_remote_https,
        allow_private_endpoints: record.allow_private_endpoints,
        strict_tls: record.strict_tls,
        timeout_ms: 1_000,
    };

    let (probe_ok, probe_err) = if run_probe {
        if let Some(ref url) = record.endpoint {
            let inspect = sanitize_and_inspect_url(
                url,
                &UrlInspectionPolicy {
                    strict_tls: record.strict_tls,
                    allow_loopback_http: true,
                    allow_private_endpoints: record.allow_private_endpoints,
                    allow_non_loopback: record.allow_remote_https,
                    redact_signed_params: true,
                    allow_socks_schemes: false,
                },
            );
            if let Ok(info) = inspect {
                let (ok, err) =
                    probe_loopback_endpoint(&info.normalized_url, Duration::from_millis(800)).await;
                (Some(ok), err)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let eval = evaluate_opencode_endpoint(&cfg, probe_ok, probe_err.as_deref());
    let truthful_status = truthful_connector_status_tag(&eval);

    json!({
        "id": record.id,
        "name": record.name,
        "kind": record.kind,
        "status": truthful_status,
        "verified": eval.source_verified,
        "reason": availability_reason_tag(eval.reason),
        "detail": eval.detail,
        "endpoint": eval.sanitized_base_url,
        "origin": eval.origin,
        "isLoopback": eval.is_loopback,
    })
}

async fn handle_connectors_status(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let run_probe = req
        .query_param("probe")
        .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    let mut records = state
        .connectors
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| default_connector_configs());

    if let Some(ref runtime_url) = state.config.runtime_url {
        if !records.iter().any(|r| r.id == "omnia-runtime") {
            records.insert(
                0,
                ConnectorConfigRecord {
                    id: "omnia-runtime".to_string(),
                    name: "Omnia Runtime Bridge".to_string(),
                    kind: "omnia_runtime".to_string(),
                    endpoint: Some(runtime_url.clone()),
                    allow_remote_https: false,
                    allow_private_endpoints: false,
                    strict_tls: true,
                },
            );
        }
    } else if !records.iter().any(|r| r.id == "omnia-runtime") {
        records.insert(
            0,
            ConnectorConfigRecord {
                id: "omnia-runtime".to_string(),
                name: "Omnia Runtime Bridge".to_string(),
                kind: "omnia_runtime".to_string(),
                endpoint: None,
                allow_remote_https: false,
                allow_private_endpoints: false,
                strict_tls: true,
            },
        );
    }

    let mut connectors = Vec::with_capacity(records.len());
    for rec in &records {
        connectors.push(evaluate_connector_record(rec, run_probe).await);
    }

    let configured_count = connectors
        .iter()
        .filter(|c| c.get("status").and_then(Value::as_str) == Some("configured"))
        .count();
    let offline_count = connectors
        .iter()
        .filter(|c| c.get("status").and_then(Value::as_str) == Some("offline"))
        .count();
    let blocked_count = connectors
        .iter()
        .filter(|c| c.get("status").and_then(Value::as_str) == Some("blocked"))
        .count();

    HttpResponse::ok(json!({
        "ok": true,
        "truthfulnessPolicy": "NO_SYNTHETIC_CONNECTED_STATUS",
        "counts": {
            "total": connectors.len(),
            "configured": configured_count,
            "offline": offline_count,
            "blocked": blocked_count,
        },
        "connectors": connectors,
    }))
}

async fn handle_connectors_validate(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };
    let raw_val = Value::Object(obj.clone());
    if let Some(proto_path) = find_unsafe_prototype_key(&raw_val, "$") {
        return HttpResponse::error(
            403,
            "unsafe_prototype_key",
            &format!("Rejected prototype-pollution key at '{proto_path}'."),
        );
    }

    if let Some(route_cfg) = obj.get("routeConfig").or_else(|| obj.get("proxyConfig")) {
        match normalize_proxy_route_config(route_cfg, &ProxyConfigPolicy::default()) {
            Ok(normalized) => {
                return HttpResponse::ok(json!({
                    "ok": true,
                    "status": "configured",
                    "kind": "proxy_router",
                    "candidateCount": normalized.candidates.len(),
                    "strategy": normalized.strategy,
                    "detail": "Proxy route configuration validated without inline secrets or cycles.",
                }));
            }
            Err(err) => {
                let safe_msg = SecretRedactor::redact(&err.to_string());
                return HttpResponse::json(
                    400,
                    json!({
                        "ok": false,
                        "status": "blocked",
                        "error": "connector_validation_failed",
                        "detail": safe_msg,
                    }),
                );
            }
        }
    }

    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("custom-connector")
        .to_string();
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Custom Connector")
        .to_string();
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("opencode")
        .to_string();
    let base_url = obj
        .get("baseUrl")
        .or_else(|| obj.get("base_url"))
        .or_else(|| obj.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let allow_remote_https = obj
        .get("allowRemoteHttps")
        .or_else(|| obj.get("allow_remote_https"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow_private_endpoints = obj
        .get("allowPrivateEndpoints")
        .or_else(|| obj.get("allow_private_endpoints"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let strict_tls = obj
        .get("strictTls")
        .or_else(|| obj.get("strict_tls"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let run_probe = obj.get("probe").and_then(Value::as_bool).unwrap_or(false);
    let save = obj.get("save").and_then(Value::as_bool).unwrap_or(false);

    let record = ConnectorConfigRecord {
        id: id.clone(),
        name,
        kind,
        endpoint: base_url,
        allow_remote_https,
        allow_private_endpoints,
        strict_tls,
    };

    let evaluated = evaluate_connector_record(&record, run_probe).await;
    let status_tag = evaluated
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("offline");

    if save && status_tag != "blocked" && status_tag != "error" {
        if let Ok(mut guard) = state.connectors.lock() {
            if let Some(existing) = guard.iter_mut().find(|c| c.id == id) {
                *existing = record;
            } else {
                guard.push(record);
            }
        }
    }

    HttpResponse::ok(json!({
        "ok": true,
        "connector": evaluated,
        "status": status_tag,
    }))
}

fn serialize_capability_report(report: &CapabilityReport, name: &str) -> Value {
    let mut val = serde_json::to_value(report).unwrap_or_else(|_| json!({}));
    if let Some(map) = val.as_object_mut() {
        let adapter = map
            .get("adapter")
            .cloned()
            .unwrap_or_else(|| Value::String(name.to_string()));
        let status = map
            .get("status")
            .cloned()
            .unwrap_or_else(|| Value::String("unavailable".to_string()));
        let reason_code = map
            .get("reason_code")
            .cloned()
            .unwrap_or_else(|| Value::String("UNCONFIGURED".to_string()));
        let source_verified = map
            .get("source_verified")
            .cloned()
            .unwrap_or(Value::Bool(false));
        let endpoint_origin = map.get("endpoint_origin").cloned().unwrap_or(Value::Null);
        let latency_ms = map.get("latency_ms").cloned().unwrap_or(Value::Null);
        let detail = map
            .get("detail")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new()));

        map.insert("name".to_string(), Value::String(name.to_string()));
        map.insert("adapter".to_string(), adapter);
        map.insert("status".to_string(), status);
        map.insert("reasonCode".to_string(), reason_code);
        map.insert("sourceVerified".to_string(), source_verified);
        map.insert("endpointOrigin".to_string(), endpoint_origin);
        map.insert("latencyMs".to_string(), latency_ms);
        map.insert("detail".to_string(), detail);
    }
    val
}

fn parse_probe_timeout(req: &HttpRequest) -> Duration {
    let ms = req
        .query_param("timeout_ms")
        .or_else(|| req.query_param("timeoutMs"))
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|n| n.clamp(100, 3_000))
        .unwrap_or(600);
    Duration::from_millis(ms)
}

async fn handle_media_capabilities(req: &HttpRequest) -> HttpResponse {
    let cdp_url = req
        .query_param("cdp_url")
        .or_else(|| req.query_param("cdpUrl"))
        .filter(|s| !s.trim().is_empty());
    let obs_url = req
        .query_param("obs_url")
        .or_else(|| req.query_param("obsUrl"))
        .filter(|s| !s.trim().is_empty());
    let timeout = parse_probe_timeout(req);

    let res = tokio::task::spawn_blocking(move || {
        let (cdp_report, cdp_snapshot) =
            probe_cdp_endpoint(cdp_url.as_deref(), CdpEndpointPolicy::default(), timeout);
        let win_report = probe_window_target_status(None);
        let obs_report = probe_obs_endpoint(obs_url.as_deref(), false, timeout);
        (cdp_report, cdp_snapshot, win_report, obs_report)
    })
    .await;

    match res {
        Err(join_err) => HttpResponse::error(500, "media_probe_failed", &join_err.to_string()),
        Ok((cdp_report, cdp_snapshot, win_report, obs_report)) => {
            let caps = vec![
                serialize_capability_report(&cdp_report, "Browser CDP"),
                serialize_capability_report(&win_report, "Win32 Window Capture"),
                serialize_capability_report(&obs_report, "OBS WebSocket v5"),
            ];
            let available_count = [&cdp_report, &win_report, &obs_report]
                .iter()
                .filter(|r| r.status == CapabilityStatus::Available)
                .count();
            HttpResponse::ok(json!({
                "ok": true,
                "availableCount": available_count,
                "capabilities": caps,
                "cdpSnapshot": cdp_snapshot,
            }))
        }
    }
}

fn handle_media_isolation() -> HttpResponse {
    let matrix = omnia_media_capture::desktop_isolation::DesktopCapabilityMatrix::windows_11_truthful_default();
    HttpResponse::ok(json!({
        "ok": true,
        "matrix": matrix.to_json(),
    }))
}

fn handle_remote_audit(state: &StudioState) -> HttpResponse {
    let guard = state.remote.lock().expect("remote state mutex");
    let entries: Vec<Value> = guard
        .audit_log
        .iter()
        .map(omnia_core::SecretRedactor::redact_json)
        .collect();
    HttpResponse::ok(json!({
        "ok": true,
        "count": entries.len(),
        "auditLog": entries,
    }))
}

async fn handle_media_cdp(req: &HttpRequest) -> HttpResponse {
    let raw_url = req.query_param("url").filter(|s| !s.trim().is_empty());
    let allow_non_loopback = req
        .query_param("allow_non_loopback")
        .or_else(|| req.query_param("allowNonLoopback"))
        .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false);
    let timeout = parse_probe_timeout(req);

    let res = tokio::task::spawn_blocking(move || {
        let policy = CdpEndpointPolicy { allow_non_loopback };
        probe_cdp_endpoint(raw_url.as_deref(), policy, timeout)
    })
    .await;

    match res {
        Err(join_err) => HttpResponse::error(500, "media_probe_failed", &join_err.to_string()),
        Ok((report, snapshot)) => {
            let normalized = serialize_capability_report(&report, "Browser CDP");
            HttpResponse::ok(json!({
                "ok": true,
                "capability": normalized,
                "snapshot": snapshot,
            }))
        }
    }
}

async fn handle_media_obs(req: &HttpRequest) -> HttpResponse {
    let raw_url = req.query_param("url").filter(|s| !s.trim().is_empty());
    let allow_non_loopback = req
        .query_param("allow_non_loopback")
        .or_else(|| req.query_param("allowNonLoopback"))
        .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true"))
        .unwrap_or(false);
    let timeout = parse_probe_timeout(req);

    let res = tokio::task::spawn_blocking(move || {
        probe_obs_endpoint(raw_url.as_deref(), allow_non_loopback, timeout)
    })
    .await;

    match res {
        Err(join_err) => HttpResponse::error(500, "media_probe_failed", &join_err.to_string()),
        Ok(report) => {
            let normalized = serialize_capability_report(&report, "OBS WebSocket v5");
            HttpResponse::ok(json!({
                "ok": true,
                "capability": normalized,
            }))
        }
    }
}

fn parse_window_identity(val: &Value) -> Result<WindowIdentity, String> {
    if let Ok(ident) = serde_json::from_value::<WindowIdentity>(val.clone()) {
        return Ok(ident);
    }
    let obj = val
        .as_object()
        .ok_or_else(|| "window identity must be an object".to_string())?;
    let hwnd = obj
        .get("hwnd")
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing u64 hwnd".to_string())?;
    let pid_u64 = obj
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing u32 pid".to_string())?;
    let pid = u32::try_from(pid_u64).map_err(|_| "pid overflows u32".to_string())?;
    let process_create_time_100ns = obj
        .get("process_create_time_100ns")
        .or_else(|| obj.get("processCreateTime100ns"))
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing u64 process_create_time_100ns".to_string())?;
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing string title".to_string())?
        .to_string();
    let width = u32::try_from(
        obj.get("width")
            .and_then(Value::as_u64)
            .ok_or_else(|| "missing u32 width".to_string())?,
    )
    .map_err(|_| "width overflows u32".to_string())?;
    let height = u32::try_from(
        obj.get("height")
            .and_then(Value::as_u64)
            .ok_or_else(|| "missing u32 height".to_string())?,
    )
    .map_err(|_| "height overflows u32".to_string())?;
    let minimized = obj
        .get("minimized")
        .and_then(Value::as_bool)
        .ok_or_else(|| "missing bool minimized".to_string())?;
    Ok(WindowIdentity {
        hwnd,
        pid,
        process_create_time_100ns,
        title,
        width,
        height,
        minimized,
    })
}

fn handle_media_windows() -> HttpResponse {
    match omnia_workspace_ops::win32_window::list_visible_windows() {
        Ok(windows) => HttpResponse::ok(json!({
            "ok": true,
            "count": windows.len(),
            "windows": windows,
        })),
        Err(err) => HttpResponse::error(500, "window_enum_failed", &err.to_string()),
    }
}

fn handle_media_window_capture(req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let receipt_obj = obj
        .get("receipt")
        .and_then(Value::as_object)
        .unwrap_or(&obj);

    let has_raw_frame = receipt_obj.get("frame_bytes").is_some()
        || receipt_obj.get("frameBytes").is_some()
        || receipt_obj.get("frame_bytes_base64").is_some()
        || receipt_obj.get("frameBytesBase64").is_some();

    if !has_raw_frame {
        if let Some(hwnd) = receipt_obj
            .get("hwnd")
            .or_else(|| obj.get("hwnd"))
            .and_then(Value::as_u64)
            .filter(|&h| h > 0)
        {
            let max_dim = receipt_obj
                .get("maxDim")
                .or_else(|| receipt_obj.get("max_dim"))
                .and_then(Value::as_u64)
                .map(|d| d as u32)
                .unwrap_or(1920)
                .clamp(64, 8192);
            return match omnia_workspace_ops::win32_window::capture_window_png(
                isize::try_from(hwnd).unwrap_or(0),
                max_dim,
            ) {
                Ok(cap) => {
                    let digest = sha256_hex(&cap.png_bytes);
                    HttpResponse::ok(json!({
                        "ok": true,
                        "verified": true,
                        "hwnd": cap.hwnd,
                        "width": cap.width,
                        "height": cap.height,
                        "mimeType": "image/png",
                        "byteLen": cap.png_bytes.len(),
                        "sha256Hex": digest,
                        "pngBase64": omnia_core::base64_encode(&cap.png_bytes),
                    }))
                }
                Err(err) => HttpResponse::error(422, "win32_capture_failed", &err.to_string()),
            };
        }
    }

    let expected_val = receipt_obj
        .get("expected_target")
        .or_else(|| receipt_obj.get("expectedTarget"));
    let observed_val = receipt_obj
        .get("observed_target")
        .or_else(|| receipt_obj.get("observedTarget"));

    if expected_val.is_none() || observed_val.is_none() {
        let single_target = receipt_obj
            .get("window")
            .or(expected_val)
            .or(observed_val)
            .and_then(|v| parse_window_identity(v).ok());
        let probe = probe_window_target_status(single_target.as_ref());
        return HttpResponse::ok(json!({
            "ok": true,
            "verified": false,
            "capability": serialize_capability_report(&probe, "Win32 Window Capture"),
        }));
    }

    let expected_target = match parse_window_identity(expected_val.expect("checked")) {
        Ok(t) => t,
        Err(reason) => return HttpResponse::error(400, "invalid_expected_target", &reason),
    };
    let observed_target = match parse_window_identity(observed_val.expect("checked")) {
        Ok(t) => t,
        Err(reason) => return HttpResponse::error(400, "invalid_observed_target", &reason),
    };

    let frame_width = match receipt_obj
        .get("frame_width")
        .or_else(|| receipt_obj.get("frameWidth"))
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
    {
        Some(v) => v,
        None => {
            return HttpResponse::error(
                400,
                "missing_frame_width",
                "Field 'frameWidth' is required.",
            )
        }
    };
    let frame_height = match receipt_obj
        .get("frame_height")
        .or_else(|| receipt_obj.get("frameHeight"))
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
    {
        Some(v) => v,
        None => {
            return HttpResponse::error(
                400,
                "missing_frame_height",
                "Field 'frameHeight' is required.",
            )
        }
    };
    let pixel_format_raw = receipt_obj
        .get("pixel_format")
        .or_else(|| receipt_obj.get("pixelFormat"))
        .and_then(Value::as_str)
        .unwrap_or("bgra8");
    let pixel_format = match serde_json::from_value::<CapturePixelFormat>(Value::String(
        pixel_format_raw.to_string(),
    )) {
        Ok(fmt) => fmt,
        Err(err) => return HttpResponse::error(400, "invalid_pixel_format", &err.to_string()),
    };
    let byte_len = receipt_obj
        .get("byte_len")
        .or_else(|| receipt_obj.get("byteLen"))
        .and_then(Value::as_u64)
        .map(|n| usize::try_from(n).unwrap_or(0))
        .unwrap_or(0);
    let sha256_hex = receipt_obj
        .get("sha256_hex")
        .or_else(|| receipt_obj.get("sha256Hex"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let frame_bytes = if let Some(b64) = receipt_obj
        .get("frame_bytes_base64")
        .or_else(|| receipt_obj.get("frameBytesBase64"))
        .and_then(Value::as_str)
    {
        match decode_base64(b64) {
            Ok(bytes) => Some(bytes),
            Err(err) => {
                return HttpResponse::error(400, "invalid_frame_bytes", &err.to_string());
            }
        }
    } else {
        receipt_obj
            .get("frame_bytes")
            .or_else(|| receipt_obj.get("frameBytes"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()))
                    .collect::<Vec<u8>>()
            })
    };
    let non_blank_verified = receipt_obj
        .get("non_blank_verified")
        .or_else(|| receipt_obj.get("nonBlankVerified"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let receipt = CaptureFrameReceipt {
        expected_target,
        observed_target,
        frame_width,
        frame_height,
        pixel_format,
        byte_len,
        sha256_hex,
        frame_bytes,
        non_blank_verified,
    };

    let report = omnia_media_capture::window_capture::evaluate_capture_receipt(&receipt);
    let normalized = serialize_capability_report(&report, "Win32 Window Capture");

    match validate_capture_receipt(&receipt) {
        Ok(validated) => HttpResponse::ok(json!({
            "ok": true,
            "verified": true,
            "capability": normalized,
            "receipt": validated,
        })),
        Err(err) => {
            let status_code = match err {
                WindowCaptureError::BlankFrameDetected(_)
                | WindowCaptureError::FrameHashMismatch { .. }
                | WindowCaptureError::FrameSizeMismatch(_)
                | WindowCaptureError::EmptyFrameReceipt
                | WindowCaptureError::WindowMinimized => 422,
                _ => 400,
            };
            HttpResponse::json(
                status_code,
                json!({
                    "ok": false,
                    "verified": false,
                    "error": "window_capture_rejected",
                    "detail": err.to_string(),
                    "capability": normalized,
                }),
            )
        }
    }
}

fn lease_summary(lease: &SessionLease, now_ms: u64, highest_inbound_seq: u64) -> Value {
    let active = !lease.revoked && now_ms < lease.expires_at_ms;
    let digest_prefix: String = lease.shared_secret_digest.chars().take(12).collect();
    json!({
        "sessionId": lease.session_id,
        "localPeerId": lease.local_peer_id,
        "peerId": lease.peer_id,
        "active": active,
        "revoked": lease.revoked,
        "revocationReason": lease.revocation_reason,
        "issuedAtMs": lease.issued_at_ms,
        "expiresAtMs": lease.expires_at_ms,
        "inboundScopes": lease.allowed_scopes.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        "outboundScopes": lease.outbound_scopes.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        "highestInboundSeq": highest_inbound_seq,
        "digestPrefix": digest_prefix,
    })
}

fn parse_scope_list(
    val: Option<&Value>,
    defaults: &[CapabilityScope],
) -> Result<Vec<CapabilityScope>, String> {
    let Some(arr) = val.and_then(Value::as_array) else {
        return Ok(defaults.to_vec());
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let s = item
            .as_str()
            .ok_or_else(|| "capability scope must be a string".to_string())?;
        let scope = CapabilityScope::from_str(s.trim()).map_err(|err| err.to_string())?;
        out.push(scope);
    }
    Ok(out)
}

fn handle_remote_status(state: &StudioState) -> HttpResponse {
    let now_ms = u64::try_from(now_epoch_ms().max(1)).unwrap_or(1);
    let guard = state.remote.lock().expect("remote state mutex");

    let mut leases = Vec::with_capacity(guard.sessions.len());
    let mut active_count = 0usize;
    for pair in guard.sessions.values() {
        let lease = pair.host.lease();
        if !lease.revoked && now_ms < lease.expires_at_ms {
            active_count += 1;
        }
        leases.push(lease_summary(
            lease,
            now_ms,
            pair.host.highest_inbound_seq(),
        ));
    }

    let status = if active_count > 0 {
        "paired"
    } else {
        "unpaired_fail_closed"
    };
    let reason = if active_count > 0 {
        "ACTIVE_LEASE"
    } else {
        "UNPAIRED_FAIL_CLOSED"
    };
    let recent_audit: Vec<Value> = guard.audit_log.iter().rev().take(16).cloned().collect();

    HttpResponse::ok(json!({
        "ok": true,
        "status": status,
        "reason": reason,
        "protocol": "omnia-remote-control.v1",
        "failClosedDefault": true,
        "replayWindow": REPLAY_WINDOW_SIZE,
        "activeLeases": active_count,
        "totalLeases": leases.len(),
        "leases": leases,
        "auditLogCount": guard.audit_log.len(),
        "auditLog": recent_audit,
    }))
}

fn handle_remote_pair(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let now_ms = u64::try_from(now_epoch_ms().max(1)).unwrap_or(1);
    let mut guard = state.remote.lock().expect("remote state mutex");

    if let (Some(offer_val), Some(approval_val)) = (obj.get("offer"), obj.get("approval")) {
        let offer: PairingOffer = match serde_json::from_value(offer_val.clone()) {
            Ok(v) => v,
            Err(err) => {
                return HttpResponse::error(400, "invalid_offer", &err.to_string());
            }
        };
        let approval: PairingApproval = match serde_json::from_value(approval_val.clone()) {
            Ok(v) => v,
            Err(err) => {
                return HttpResponse::error(400, "invalid_approval", &err.to_string());
            }
        };
        let secret = guard.pairing_secret.clone();
        let (h_lease, h_key) = match complete_pairing_initiator(&offer, &approval, &secret, now_ms)
        {
            Ok(pair) => pair,
            Err(err) => return map_pairing_error(err),
        };
        let (c_lease, c_key) = match complete_pairing_approver(&offer, &approval, &secret, now_ms) {
            Ok(pair) => pair,
            Err(err) => return map_pairing_error(err),
        };
        return register_paired_pair(&mut guard, h_lease, h_key, c_lease, c_key, now_ms);
    }

    let session_id = obj
        .get("sessionId")
        .or_else(|| obj.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| guard.next_nonce("remote-sess"));
    let initiator_id = obj
        .get("initiatorId")
        .or_else(|| obj.get("initiator_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("studio-host")
        .to_string();
    let target_peer_id = obj
        .get("targetPeerId")
        .or_else(|| obj.get("target_peer_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("remote-controller")
        .to_string();

    let default_inbound = [
        CapabilityScope::MouseInput,
        CapabilityScope::KeyboardInput,
        CapabilityScope::TouchInput,
    ];
    let default_outbound = [CapabilityScope::ScreenStream];

    let offered_inbound = match parse_scope_list(
        obj.get("offeredInboundScopes")
            .or_else(|| obj.get("inboundScopes")),
        &default_inbound,
    ) {
        Ok(s) => s,
        Err(err) => return HttpResponse::error(400, "invalid_scopes", &err),
    };
    let offered_outbound = match parse_scope_list(
        obj.get("offeredOutboundScopes")
            .or_else(|| obj.get("outboundScopes")),
        &default_outbound,
    ) {
        Ok(s) => s,
        Err(err) => return HttpResponse::error(400, "invalid_scopes", &err),
    };
    let requested_outbound =
        match parse_scope_list(obj.get("requestedOutboundScopes"), &offered_inbound) {
            Ok(s) => s,
            Err(err) => return HttpResponse::error(400, "invalid_scopes", &err),
        };
    let accepted_inbound =
        match parse_scope_list(obj.get("acceptedInboundScopes"), &offered_outbound) {
            Ok(s) => s,
            Err(err) => return HttpResponse::error(400, "invalid_scopes", &err),
        };

    let lease_ttl_ms = obj
        .get("leaseTtlMs")
        .or_else(|| obj.get("lease_ttl_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_LEASE_TTL_MS)
        .clamp(1_000, 3_600_000);

    let offer_nonce = guard.next_nonce("offer");
    let approval_nonce = guard.next_nonce("approve");
    let secret = guard.pairing_secret.clone();

    let offer = match PairingOffer::create(
        &session_id,
        &initiator_id,
        &target_peer_id,
        &offer_nonce,
        offered_inbound,
        offered_outbound,
        now_ms,
        now_ms.saturating_add(30_000),
        lease_ttl_ms,
        &secret,
    ) {
        Ok(v) => v,
        Err(err) => return map_pairing_error(err),
    };

    let approval = match PairingApproval::approve(
        &offer,
        &target_peer_id,
        &approval_nonce,
        requested_outbound,
        accepted_inbound,
        &secret,
        now_ms,
    ) {
        Ok(v) => v,
        Err(err) => return map_pairing_error(err),
    };

    let (h_lease, h_key) = match complete_pairing_initiator(&offer, &approval, &secret, now_ms) {
        Ok(pair) => pair,
        Err(err) => return map_pairing_error(err),
    };
    let (c_lease, c_key) = match complete_pairing_approver(&offer, &approval, &secret, now_ms) {
        Ok(pair) => pair,
        Err(err) => return map_pairing_error(err),
    };

    register_paired_pair(&mut guard, h_lease, h_key, c_lease, c_key, now_ms)
}

fn register_paired_pair(
    guard: &mut RemoteControlState,
    h_lease: SessionLease,
    h_key: SessionKey,
    c_lease: SessionLease,
    c_key: SessionKey,
    now_ms: u64,
) -> HttpResponse {
    let session_id = h_lease.session_id.clone();
    let summary = lease_summary(&h_lease, now_ms, 0);
    let inbound_scopes = h_lease.allowed_scopes.clone();
    let outbound_scopes = h_lease.outbound_scopes.clone();

    if let Err(err) = guard.lease_store.register(h_lease.clone(), h_key.clone()) {
        return map_pairing_error(err);
    }
    let host_session = match PeerSession::new(h_lease, h_key) {
        Ok(s) => s,
        Err(err) => return map_protocol_error(err),
    };
    let controller_session = match PeerSession::new(c_lease, c_key) {
        Ok(s) => s,
        Err(err) => return map_protocol_error(err),
    };

    guard.sessions.insert(
        session_id.clone(),
        PairedSessionPair {
            host: host_session,
            controller: controller_session,
            inbound_scopes,
            outbound_scopes,
        },
    );
    guard.record_audit(json!({
        "event": "paired",
        "sessionId": session_id,
        "timestampMs": now_ms,
        "outcome": "accepted",
    }));

    HttpResponse::ok(json!({
        "ok": true,
        "status": "paired",
        "sessionId": session_id,
        "lease": summary,
    }))
}

fn map_pairing_error(err: PairingError) -> HttpResponse {
    let status = match err {
        PairingError::InvalidInput(_) => 400,
        PairingError::UnpairedPeer
        | PairingError::LeaseRevoked { .. }
        | PairingError::LeaseExpired { .. }
        | PairingError::ScopeDenied { .. }
        | PairingError::ScopeEscalation { .. }
        | PairingError::AuthenticationFailed
        | PairingError::HandshakeMismatch(_)
        | PairingError::KeyDigestMismatch => 403,
    };
    HttpResponse::error(status, "remote_pairing_rejected", &err.to_string())
}

fn map_protocol_error(err: ProtocolError) -> HttpResponse {
    let status = match err {
        ProtocolError::InvalidPayload(_)
        | ProtocolError::InvalidTimestamp
        | ProtocolError::Codec(_) => 400,
        ProtocolError::Pairing(ref p) => return map_pairing_error(p.clone()),
        ProtocolError::TamperedMac
        | ProtocolError::UnauthorizedSender { .. }
        | ProtocolError::SessionMismatch { .. }
        | ProtocolError::Replay(_)
        | ProtocolError::SessionDisconnected { .. } => 403,
    };
    HttpResponse::error(status, "remote_protocol_rejected", &err.to_string())
}

fn handle_remote_session(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let Some(session_id) = obj
        .get("sessionId")
        .or_else(|| obj.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HttpResponse::error(400, "missing_session_id", "Field 'sessionId' is required.");
    };

    let action = obj
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("inspect");
    let now_ms = u64::try_from(now_epoch_ms().max(1)).unwrap_or(1);

    let mut guard = state.remote.lock().expect("remote state mutex");
    if !guard.sessions.contains_key(session_id) {
        return HttpResponse::error(403, "unpaired_peer", "Session is not paired (fail closed).");
    }

    match action {
        "revoke" => {
            let reason = obj
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("revoked_by_studio");
            let summary = {
                let pair = guard.sessions.get_mut(session_id).expect("checked");
                pair.host.revoke(reason);
                pair.controller.revoke(reason);
                lease_summary(pair.host.lease(), now_ms, pair.host.highest_inbound_seq())
            };
            let _ = guard.lease_store.revoke(session_id, reason);
            guard.record_audit(json!({
                "event": "session_revoked",
                "sessionId": session_id,
                "reason": reason,
                "timestampMs": now_ms,
                "outcome": "revoked",
            }));
            HttpResponse::ok(json!({
                "ok": true,
                "sessionId": session_id,
                "revoked": true,
                "reason": reason,
                "lease": summary,
            }))
        }
        "inspect" => {
            let (summary, inbound, outbound) = {
                let pair = guard.sessions.get(session_id).expect("checked");
                let summary =
                    lease_summary(pair.host.lease(), now_ms, pair.host.highest_inbound_seq());
                let inbound: Vec<&'static str> =
                    pair.inbound_scopes.iter().map(|s| s.as_str()).collect();
                let outbound: Vec<&'static str> =
                    pair.outbound_scopes.iter().map(|s| s.as_str()).collect();
                (summary, inbound, outbound)
            };
            let audit: Vec<Value> = guard
                .audit_log
                .iter()
                .filter(|e| e.get("sessionId").and_then(Value::as_str) == Some(session_id))
                .cloned()
                .collect();
            HttpResponse::ok(json!({
                "ok": true,
                "sessionId": session_id,
                "lease": summary,
                "inboundScopes": inbound,
                "outboundScopes": outbound,
                "auditLog": audit,
            }))
        }
        _ => HttpResponse::error(
            400,
            "unsupported_action",
            "Supported actions are 'inspect' and 'revoke'.",
        ),
    }
}

fn parse_input_payload(obj: &serde_json::Map<String, Value>) -> Result<FramePayload, String> {
    if let Some(payload_val) = obj.get("payload") {
        if let Ok(payload) = serde_json::from_value::<FramePayload>(payload_val.clone()) {
            return Ok(payload);
        }
    }

    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| "Field 'kind' (or 'payload') is required.".to_string())?;

    match kind {
        "mouse_move" => Ok(FramePayload::MouseMove {
            x: obj
                .get("x")
                .and_then(Value::as_f64)
                .ok_or_else(|| "Field 'x' is required.".to_string())?,
            y: obj
                .get("y")
                .and_then(Value::as_f64)
                .ok_or_else(|| "Field 'y' is required.".to_string())?,
            display_id: u32::try_from(
                obj.get("displayId")
                    .or_else(|| obj.get("display_id"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
            .map_err(|_| "displayId overflows u32".to_string())?,
        }),
        "mouse_click" => {
            let button =
                MouseButton::from_str(obj.get("button").and_then(Value::as_str).unwrap_or("left"))
                    .map_err(|e| e.to_string())?;
            let action = ButtonAction::from_str(
                obj.get("action").and_then(Value::as_str).unwrap_or("click"),
            )
            .map_err(|e| e.to_string())?;
            Ok(FramePayload::MouseClick {
                x: obj
                    .get("x")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Field 'x' is required.".to_string())?,
                y: obj
                    .get("y")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| "Field 'y' is required.".to_string())?,
                button,
                action,
                display_id: u32::try_from(
                    obj.get("displayId")
                        .or_else(|| obj.get("display_id"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
                .map_err(|_| "displayId overflows u32".to_string())?,
            })
        }
        "key_event" => {
            let key_code = obj
                .get("keyCode")
                .or_else(|| obj.get("key_code"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Field 'keyCode' is required.".to_string())?
                .to_string();
            let action =
                KeyAction::from_str(obj.get("action").and_then(Value::as_str).unwrap_or("press"))
                    .map_err(|e| e.to_string())?;
            Ok(FramePayload::KeyEvent {
                key_code,
                action,
                shift: obj.get("shift").and_then(Value::as_bool).unwrap_or(false),
                ctrl: obj.get("ctrl").and_then(Value::as_bool).unwrap_or(false),
                alt: obj.get("alt").and_then(Value::as_bool).unwrap_or(false),
                meta: obj.get("meta").and_then(Value::as_bool).unwrap_or(false),
                repeat: obj.get("repeat").and_then(Value::as_bool).unwrap_or(false),
            })
        }
        "touch_event" => {
            let action =
                TouchAction::from_str(obj.get("action").and_then(Value::as_str).unwrap_or("start"))
                    .map_err(|e| e.to_string())?;
            let points: Vec<TouchPoint> = match obj.get("points") {
                Some(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
                None => Vec::new(),
            };
            Ok(FramePayload::TouchEvent {
                action,
                display_id: u32::try_from(
                    obj.get("displayId")
                        .or_else(|| obj.get("display_id"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                )
                .map_err(|_| "displayId overflows u32".to_string())?,
                points,
            })
        }
        "heartbeat" => Ok(FramePayload::Heartbeat {
            ping_nonce: obj
                .get("pingNonce")
                .or_else(|| obj.get("ping_nonce"))
                .and_then(Value::as_u64)
                .unwrap_or(1),
            echo_nonce: obj
                .get("echoNonce")
                .or_else(|| obj.get("echo_nonce"))
                .and_then(Value::as_u64),
        }),
        "disconnect_notice" => Ok(FramePayload::DisconnectNotice {
            reason: obj
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("disconnect")
                .to_string(),
            graceful: obj.get("graceful").and_then(Value::as_bool).unwrap_or(true),
        }),
        other => Err(format!("Unknown remote input payload kind '{other}'.")),
    }
}

fn handle_remote_input(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let now_ms = obj
        .get("nowMs")
        .or_else(|| obj.get("now_ms"))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| u64::try_from(now_epoch_ms().max(1)).unwrap_or(1));

    let mut guard = state.remote.lock().expect("remote state mutex");

    let env_candidate = obj.get("envelope").cloned().or_else(|| {
        if obj.contains_key("mac_hex") && obj.contains_key("payload") {
            Some(Value::Object(obj.clone()))
        } else {
            None
        }
    });

    if let Some(env_val) = env_candidate {
        let envelope: FrameEnvelope = match serde_json::from_value(env_val) {
            Ok(env) => env,
            Err(err) => {
                return HttpResponse::error(400, "invalid_envelope", &err.to_string());
            }
        };
        let session_id = envelope.session_id.clone();
        let Some(pair) = guard.sessions.get_mut(&session_id) else {
            return HttpResponse::error(
                403,
                "unpaired_peer",
                "Session is not paired (fail closed).",
            );
        };
        return match pair.host.open_inbound(&envelope, now_ms) {
            Ok(verified_payload) => {
                let highest_seq = pair.host.highest_inbound_seq();
                guard.record_audit(json!({
                    "event": "inbound_envelope",
                    "sessionId": session_id,
                    "seq": envelope.seq,
                    "timestampMs": now_ms,
                    "outcome": "accepted",
                }));
                HttpResponse::ok(json!({
                    "ok": true,
                    "accepted": true,
                    "sessionId": session_id,
                    "seq": envelope.seq,
                    "highestInboundSeq": highest_seq,
                    "payload": verified_payload,
                }))
            }
            Err(err) => {
                guard.record_audit(json!({
                    "event": "inbound_envelope",
                    "sessionId": session_id,
                    "seq": envelope.seq,
                    "timestampMs": now_ms,
                    "outcome": "rejected",
                    "detail": err.to_string(),
                }));
                map_protocol_error(err)
            }
        };
    }

    let Some(session_id) = obj
        .get("sessionId")
        .or_else(|| obj.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
    else {
        return HttpResponse::error(
            403,
            "unpaired_peer",
            "Paired 'sessionId' is required (fail closed).",
        );
    };

    let payload = match parse_input_payload(&obj) {
        Ok(p) => p,
        Err(msg) => return HttpResponse::error(400, "invalid_input_payload", &msg),
    };

    let Some(pair) = guard.sessions.get_mut(&session_id) else {
        return HttpResponse::error(403, "unpaired_peer", "Session is not paired (fail closed).");
    };

    let sealed = match pair.controller.seal_outbound(payload, now_ms) {
        Ok(env) => env,
        Err(err) => return map_protocol_error(err),
    };

    match pair.host.open_inbound(&sealed, now_ms) {
        Ok(opened) => {
            let highest_seq = pair.host.highest_inbound_seq();
            let seq = sealed.seq;
            guard.record_audit(json!({
                "event": "input_dispatch",
                "sessionId": session_id,
                "seq": seq,
                "timestampMs": now_ms,
                "outcome": "accepted",
            }));
            HttpResponse::ok(json!({
                "ok": true,
                "accepted": true,
                "sessionId": session_id,
                "seq": seq,
                "highestInboundSeq": highest_seq,
                "envelope": sealed,
                "payload": opened,
            }))
        }
        Err(err) => map_protocol_error(err),
    }
}

fn handle_remote_frame(state: &StudioState, req: &HttpRequest) -> HttpResponse {
    let obj = match req.json_object() {
        Ok(m) => m,
        Err(resp) => return resp,
    };

    let now_ms = obj
        .get("nowMs")
        .or_else(|| obj.get("now_ms"))
        .and_then(Value::as_u64)
        .unwrap_or_else(|| u64::try_from(now_epoch_ms().max(1)).unwrap_or(1));

    let Some(session_id) = obj
        .get("sessionId")
        .or_else(|| obj.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
    else {
        return HttpResponse::error(
            403,
            "unpaired_peer",
            "Paired 'sessionId' is required (fail closed).",
        );
    };

    let mut guard = state.remote.lock().expect("remote state mutex");
    let Some(pair) = guard.sessions.get_mut(&session_id) else {
        return HttpResponse::error(403, "unpaired_peer", "Session is not paired (fail closed).");
    };

    let frame_id = obj
        .get("frameId")
        .or_else(|| obj.get("frame_id"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let width =
        u32::try_from(obj.get("width").and_then(Value::as_u64).unwrap_or(1280)).unwrap_or(1280);
    let height =
        u32::try_from(obj.get("height").and_then(Value::as_u64).unwrap_or(720)).unwrap_or(720);
    let format = obj
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("bgra8")
        .to_string();
    let preview_base64 = obj
        .get("previewBase64")
        .or_else(|| obj.get("preview_base64"))
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let decoded_preview = match preview_base64.as_deref() {
        Some(b64) if !b64.trim().is_empty() => match decode_base64(b64.trim()) {
            Ok(bytes) => Some(bytes),
            Err(err) => {
                return HttpResponse::error(400, "invalid_preview_base64", &err.to_string());
            }
        },
        _ => None,
    };
    let explicit_byte_len = obj
        .get("byteLen")
        .or_else(|| obj.get("byte_len"))
        .and_then(Value::as_u64);
    let byte_len = match explicit_byte_len {
        Some(raw) => match u32::try_from(raw) {
            Ok(len) if len > 0 => len,
            _ => {
                return HttpResponse::error(
                    400,
                    "invalid_byte_len",
                    "Field 'byteLen' must be a positive u32 integer.",
                );
            }
        },
        None => match decoded_preview.as_ref() {
            Some(bytes) if !bytes.is_empty() => u32::try_from(bytes.len()).unwrap_or(u32::MAX),
            _ => {
                return HttpResponse::error(
                    400,
                    "missing_byte_len",
                    "Provide real 'byteLen' or non-empty 'previewBase64' frame bytes.",
                );
            }
        },
    };
    let sha256_hex_val = match obj
        .get("sha256Hex")
        .or_else(|| obj.get("sha256_hex"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(h) => h.to_string(),
        None => match decoded_preview.as_ref() {
            Some(bytes) if !bytes.is_empty() => sha256_hex(bytes),
            _ => {
                return HttpResponse::error(
                    400,
                    "missing_frame_digest",
                    "Provide real 'sha256Hex' or non-empty 'previewBase64' frame bytes (no fabricated digests).",
                );
            }
        },
    };
    let keyframe = obj.get("keyframe").and_then(Value::as_bool).unwrap_or(true);

    let payload = FramePayload::ScreenFrameHeader {
        frame_id,
        width,
        height,
        format,
        byte_len,
        sha256_hex: sha256_hex_val,
        keyframe,
        preview_base64,
    };

    let sealed = match pair.host.seal_outbound(payload, now_ms) {
        Ok(env) => env,
        Err(err) => return map_protocol_error(err),
    };

    match pair.controller.open_inbound(&sealed, now_ms) {
        Ok(opened) => {
            let seq = sealed.seq;
            guard.record_audit(json!({
                "event": "screen_frame",
                "sessionId": session_id,
                "seq": seq,
                "frameId": frame_id,
                "timestampMs": now_ms,
                "outcome": "accepted",
            }));
            HttpResponse::ok(json!({
                "ok": true,
                "accepted": true,
                "sessionId": session_id,
                "seq": seq,
                "frameId": frame_id,
                "envelope": sealed,
                "payload": opened,
            }))
        }
        Err(err) => map_protocol_error(err),
    }
}
