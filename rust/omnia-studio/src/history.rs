//! Redacted immutable history pointer, manifest, receipt, body-index, and JSONL span reader.

use crate::config::StudioConfig;
use crate::http::{HttpRequest, HttpResponse};
use crate::telemetry::is_reparse_or_symlink;
use omnia_core::{sha256_hex, SecretRedactor};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BODY_JSONL_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_HISTORY_LIMIT: usize = 50;
const DEFAULT_MESSAGES_LIMIT: usize = 20;
const MAX_LIMIT: usize = 200;
const MAX_OFFSET: usize = 1_000_000;

/// Redacts secrets, local home/user-profile prefixes, emails, and access-bearing URLs.
#[must_use]
pub fn redact_history_text(input: &str) -> String {
    let mut out = SecretRedactor::redact(input);
    for env_key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = env::var(env_key) {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                out = out.replace(trimmed, "~");
                let slash = trimmed.replace('\\', "/");
                out = out.replace(&slash, "~");
            }
        }
    }
    out = redact_home_paths(&out);
    out = redact_emails_in_text(&out);
    redact_urls_in_text(&out)
}

/// Redacts all string values inside a JSON value using [`redact_history_text`].
#[must_use]
pub fn redact_history_json(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact_history_text(s)),
        Value::Array(arr) => Value::Array(arr.iter().map(redact_history_json).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), redact_history_json(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Handles `GET /api/history`.
pub fn handle_history(config: &StudioConfig, req: &HttpRequest) -> HttpResponse {
    let query_filter = match req.query_param("query") {
        Some(q) => {
            if q.len() > 256 || q.chars().any(|c| c.is_control()) {
                return HttpResponse::error(
                    400,
                    "invalid_history_query",
                    "Query filter exceeds length bound or contains control characters.",
                );
            }
            q.trim().to_ascii_lowercase()
        }
        None => String::new(),
    };
    let limit = match parse_bounded_usize(
        req.query_param("limit").as_deref(),
        DEFAULT_HISTORY_LIMIT,
        1,
        MAX_LIMIT,
    ) {
        Ok(v) => v,
        Err(msg) => return HttpResponse::error(400, "invalid_history_limit", &msg),
    };
    let offset = match parse_bounded_usize(req.query_param("offset").as_deref(), 0, 0, MAX_OFFSET) {
        Ok(v) => v,
        Err(msg) => return HttpResponse::error(400, "invalid_history_offset", &msg),
    };

    let store = match resolve_verified_history(config) {
        Ok(s) => s,
        Err(err) => return err.into_manifest_response(limit, offset),
    };

    let all_records = store
        .manifest
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut filtered = Vec::new();
    for rec in &all_records {
        let redacted = redact_history_json(rec);
        if query_filter.is_empty() || json_matches_filter(&redacted, &query_filter) {
            filtered.push(redacted);
        }
    }

    let total_matched = filtered.len();
    let end = offset.saturating_add(limit).min(total_matched);
    let page_records = if offset < total_matched {
        filtered[offset..end].to_vec()
    } else {
        Vec::new()
    };

    let counts = compute_manifest_counts(&store.manifest, &all_records);
    let completion = compute_manifest_completion(&store.manifest, &all_records);
    let state_str = derive_manifest_state(&counts);

    HttpResponse::json(
        200,
        json!({
            "ok": true,
            "schema": "omnia.history-manifest.v2",
            "state": state_str,
            "acquisitionState": state_str,
            "generationSource": store.generation_source,
            "generationId": store.generation_id,
            "rollbackUsed": store.rollback_used,
            "warnings": store.warnings,
            "manifestPath": redact_history_text(&store.manifest_path.display().to_string()),
            "manifestSha256": store.manifest_sha256,
            "totalMatched": total_matched,
            "limit": limit,
            "offset": offset,
            "counts": counts,
            "completion": completion,
            "records": page_records,
        }),
    )
}

/// Handles `GET /api/history/messages`.
pub fn handle_history_messages(config: &StudioConfig, req: &HttpRequest) -> HttpResponse {
    let record_id = req
        .query_param("record_id")
        .or_else(|| req.query_param("recordId"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if record_id.is_empty() || record_id.len() > 256 || record_id.chars().any(|c| c.is_control()) {
        return HttpResponse::error(
            400,
            "invalid_record_id",
            "record_id query parameter must be non-empty and free of control characters.",
        );
    }
    let limit = match parse_bounded_usize(
        req.query_param("limit").as_deref(),
        DEFAULT_MESSAGES_LIMIT,
        1,
        MAX_LIMIT,
    ) {
        Ok(v) => v,
        Err(msg) => return HttpResponse::error(400, "invalid_history_limit", &msg),
    };
    let offset = match parse_bounded_usize(req.query_param("offset").as_deref(), 0, 0, MAX_OFFSET) {
        Ok(v) => v,
        Err(msg) => return HttpResponse::error(400, "invalid_history_offset", &msg),
    };

    let store = match resolve_verified_history(config) {
        Ok(s) => s,
        Err(err) => return err.into_messages_response(&record_id, limit, offset),
    };

    let Some(span) = store.spans.get(&record_id) else {
        return HttpResponse::json(
            404,
            json!({
                "ok": false,
                "schema": "omnia.history-messages.v1",
                "recordId": record_id,
                "state": "not_found",
                "error": "history_record_not_found",
                "generationSource": store.generation_source,
                "generationId": store.generation_id,
                "messages": [],
                "totalMatched": 0,
                "limit": limit,
                "offset": offset,
            }),
        );
    };

    let Some(body_bytes) = store.body_bytes.as_deref() else {
        return HttpResponse::json(
            409,
            json!({
                "ok": false,
                "schema": "omnia.history-messages.v1",
                "recordId": record_id,
                "state": "blocked",
                "error": "history_body_unavailable",
                "messages": [],
                "totalMatched": 0,
                "limit": limit,
                "offset": offset,
            }),
        );
    };

    let Some(end_offset) = span.offset.checked_add(span.byte_length) else {
        return messages_blocked(&record_id, "history_span_overflow", limit, offset);
    };
    if end_offset > body_bytes.len() {
        return messages_blocked(&record_id, "history_span_out_of_bounds", limit, offset);
    }
    let slice = &body_bytes[span.offset..end_offset];
    if let Some(expected) = span.sha256.as_deref() {
        let actual = sha256_hex(slice);
        if actual != expected {
            return messages_blocked(&record_id, "history_span_sha256_mismatch", limit, offset);
        }
    }

    let text = match std::str::from_utf8(slice) {
        Ok(t) => t,
        Err(_) => return messages_blocked(&record_id, "history_span_invalid_utf8", limit, offset),
    };

    let mut messages = Vec::new();
    let mut last_seq: Option<i64> = None;
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
            return messages_blocked(&record_id, "history_span_malformed_jsonl", limit, offset);
        };
        if let Some(seq) = parsed
            .get("ordinal")
            .or_else(|| parsed.get("seq"))
            .and_then(Value::as_i64)
        {
            if let Some(prev) = last_seq {
                if seq <= prev {
                    return messages_blocked(
                        &record_id,
                        "history_non_monotonic_ordinal",
                        limit,
                        offset,
                    );
                }
            }
            last_seq = Some(seq);
        }
        messages.push(redact_history_json(&parsed));
    }

    let total_matched = messages.len();
    let end = offset.saturating_add(limit).min(total_matched);
    let paged = if offset < total_matched {
        messages[offset..end].to_vec()
    } else {
        Vec::new()
    };

    HttpResponse::json(
        200,
        json!({
            "ok": true,
            "schema": "omnia.history-messages.v1",
            "recordId": record_id,
            "state": "verified",
            "generationSource": store.generation_source,
            "generationId": store.generation_id,
            "rollbackUsed": store.rollback_used,
            "messages": paged,
            "totalMatched": total_matched,
            "limit": limit,
            "offset": offset,
        }),
    )
}

#[derive(Debug, Clone)]
struct SpanEntry {
    offset: usize,
    byte_length: usize,
    sha256: Option<String>,
}

struct VerifiedHistoryStore {
    generation_source: &'static str,
    generation_id: Option<String>,
    rollback_used: bool,
    warnings: Vec<String>,
    manifest_path: PathBuf,
    manifest_sha256: String,
    manifest: Value,
    spans: BTreeMap<String, SpanEntry>,
    body_bytes: Option<Vec<u8>>,
}

struct HistoryError {
    http_status: u16,
    state: &'static str,
    code: &'static str,
    detail: String,
    manifest_path: String,
}

impl HistoryError {
    fn unavailable(code: &'static str, detail: impl Into<String>, path: &str) -> Self {
        Self {
            http_status: 503,
            state: "unavailable",
            code,
            detail: detail.into(),
            manifest_path: path.to_string(),
        }
    }

    fn blocked(code: &'static str, detail: impl Into<String>, path: &str) -> Self {
        Self {
            http_status: 409,
            state: "blocked",
            code,
            detail: detail.into(),
            manifest_path: path.to_string(),
        }
    }

    fn into_manifest_response(self, limit: usize, offset: usize) -> HttpResponse {
        HttpResponse::json(
            self.http_status,
            json!({
                "ok": false,
                "schema": "omnia.history-manifest.v2",
                "state": self.state,
                "acquisitionState": self.state,
                "error": self.code,
                "detail": self.detail,
                "generationSource": "none",
                "rollbackUsed": false,
                "manifestPath": redact_history_text(&self.manifest_path),
                "records": [],
                "limit": limit,
                "offset": offset,
                "counts": {
                    "records": 0,
                    "verified": 0,
                    "partial": 0,
                    "blocked": 0,
                    "transcriptAvailable": 0,
                },
                "completion": {
                    "verified": [],
                    "partial": [],
                    "blocked": [],
                    "next": [],
                },
            }),
        )
    }

    fn into_messages_response(self, record_id: &str, limit: usize, offset: usize) -> HttpResponse {
        HttpResponse::json(
            self.http_status,
            json!({
                "ok": false,
                "schema": "omnia.history-messages.v1",
                "recordId": record_id,
                "state": self.state,
                "error": self.code,
                "detail": self.detail,
                "messages": [],
                "totalMatched": 0,
                "limit": limit,
                "offset": offset,
            }),
        )
    }
}

fn messages_blocked(record_id: &str, code: &str, limit: usize, offset: usize) -> HttpResponse {
    HttpResponse::json(
        409,
        json!({
            "ok": false,
            "schema": "omnia.history-messages.v1",
            "recordId": record_id,
            "state": "blocked",
            "error": code,
            "messages": [],
            "totalMatched": 0,
            "limit": limit,
            "offset": offset,
        }),
    )
}

fn resolve_verified_history(config: &StudioConfig) -> Result<VerifiedHistoryStore, HistoryError> {
    let explicit_ptr = config.history_pointer.clone().or_else(|| {
        config
            .history_root
            .as_ref()
            .map(|r| r.join("history-active.json"))
    });

    if let Some(pointer_path) = explicit_ptr {
        if !pointer_path.exists() {
            return Err(HistoryError::unavailable(
                "history_pointer_missing",
                "Configured history-active pointer does not exist.",
                &pointer_path.display().to_string(),
            ));
        }

        match load_from_pointer(config, &pointer_path, "active", false, Vec::new()) {
            Ok(store) => return Ok(store),
            Err(active_err) => {
                if let Some(prev_path) = previous_pointer_candidate(&pointer_path) {
                    if prev_path.exists() {
                        let warnings = vec![format!(
                            "Active history pointer rolled back to previous generation ({}: {}).",
                            active_err.code, active_err.detail
                        )];
                        if let Ok(store) =
                            load_from_pointer(config, &prev_path, "previous", true, warnings)
                        {
                            return Ok(store);
                        }
                    }
                }
                return Err(active_err);
            }
        }
    }

    if let Some(manifest_path) = config.history_manifest.as_ref() {
        if !manifest_path.exists() {
            return Err(HistoryError::unavailable(
                "history_manifest_missing",
                "Configured history manifest file does not exist.",
                &manifest_path.display().to_string(),
            ));
        }
        return load_verified_manifest(
            config,
            manifest_path,
            None,
            None,
            None,
            None,
            None,
            None,
            "legacy",
            None,
            false,
            Vec::new(),
        );
    }

    Err(HistoryError::unavailable(
        "history_not_configured",
        "No external history pointer, history root, or history manifest configured.",
        "",
    ))
}

fn previous_pointer_candidate(active_path: &Path) -> Option<PathBuf> {
    let file_name = active_path.file_name()?.to_string_lossy();
    let parent = active_path.parent()?;
    if file_name == "history-active.json" {
        Some(parent.join("history-active.previous.json"))
    } else {
        active_path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| parent.join(format!("{stem}.previous.json")))
    }
}

fn load_from_pointer(
    config: &StudioConfig,
    pointer_path: &Path,
    generation_source: &'static str,
    rollback_used: bool,
    warnings: Vec<String>,
) -> Result<VerifiedHistoryStore, HistoryError> {
    let ptr_str = pointer_path.display().to_string();
    ensure_safe_external_history_path(config, pointer_path, &ptr_str)?;
    let ptr_bytes = read_bounded_file(pointer_path, MAX_MANIFEST_BYTES, &ptr_str)?;
    let ptr_json: Value = serde_json::from_slice(&ptr_bytes).map_err(|_| {
        HistoryError::blocked(
            "history_pointer_invalid_json",
            "Pointer file is not valid JSON.",
            &ptr_str,
        )
    })?;

    let schema = ptr_json.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != "omnia.history-active.v1" {
        return Err(HistoryError::blocked(
            "history_pointer_schema_mismatch",
            format!("Unexpected history pointer schema '{schema}'."),
            &ptr_str,
        ));
    }

    let base_dir = pointer_path.parent().unwrap_or_else(|| Path::new("."));
    let generation_id = string_field(&ptr_json, &["generationId", "generation_id"]);
    let manifest_rel =
        string_field(&ptr_json, &["manifestPath", "manifest_path"]).ok_or_else(|| {
            HistoryError::blocked(
                "history_pointer_missing_manifest_path",
                "Pointer omits manifestPath.",
                &ptr_str,
            )
        })?;
    let manifest_sha = normalize_hex_64(
        string_field(&ptr_json, &["manifestSha256", "manifest_sha256"]).as_deref(),
    )
    .ok_or_else(|| {
        HistoryError::blocked(
            "history_pointer_missing_manifest_sha256",
            "Pointer omits valid 64-hex manifestSha256.",
            &ptr_str,
        )
    })?;

    let receipt_path = string_field(&ptr_json, &["receiptPath", "receipt_path"])
        .map(|p| resolve_rel(base_dir, &p));
    let receipt_sha =
        normalize_hex_64(string_field(&ptr_json, &["receiptSha256", "receipt_sha256"]).as_deref());
    let index_path = string_field(&ptr_json, &["bodyIndexPath", "body_index_path"])
        .map(|p| resolve_rel(base_dir, &p));
    let index_sha = normalize_hex_64(
        string_field(&ptr_json, &["bodyIndexSha256", "body_index_sha256"]).as_deref(),
    );
    let manifest_path = resolve_rel(base_dir, &manifest_rel);

    load_verified_manifest(
        config,
        &manifest_path,
        Some(&manifest_sha),
        receipt_path.as_deref(),
        receipt_sha.as_deref(),
        index_path.as_deref(),
        index_sha.as_deref(),
        generation_id,
        generation_source,
        Some(base_dir),
        rollback_used,
        warnings,
    )
}

#[allow(clippy::too_many_arguments)]
fn load_verified_manifest(
    config: &StudioConfig,
    manifest_path: &Path,
    expected_manifest_sha: Option<&str>,
    override_receipt_path: Option<&Path>,
    override_receipt_sha: Option<&str>,
    override_index_path: Option<&Path>,
    override_index_sha: Option<&str>,
    generation_id: Option<String>,
    generation_source: &'static str,
    pointer_base_dir: Option<&Path>,
    rollback_used: bool,
    warnings: Vec<String>,
) -> Result<VerifiedHistoryStore, HistoryError> {
    let man_str = manifest_path.display().to_string();
    ensure_safe_external_history_path(config, manifest_path, &man_str)?;
    if let Some(root_guard) = pointer_base_dir {
        ensure_contained_within(root_guard, manifest_path, &man_str)?;
    }

    let man_bytes = read_bounded_file(manifest_path, MAX_MANIFEST_BYTES, &man_str)?;
    let actual_man_sha = sha256_hex(&man_bytes);
    if let Some(exp) = expected_manifest_sha {
        if actual_man_sha != exp {
            return Err(HistoryError::blocked(
                "history_manifest_sha256_mismatch",
                "History manifest SHA-256 does not match active pointer.",
                &man_str,
            ));
        }
    }

    let manifest: Value = serde_json::from_slice(&man_bytes).map_err(|_| {
        HistoryError::blocked(
            "history_manifest_invalid_json",
            "History manifest is not valid JSON.",
            &man_str,
        )
    })?;
    let schema = manifest.get("schema").and_then(Value::as_str).unwrap_or("");
    if schema != "omnia.history-manifest.v2" {
        return Err(HistoryError::blocked(
            "history_manifest_schema_mismatch",
            format!("Unexpected history manifest schema '{schema}'."),
            &man_str,
        ));
    }

    let manifest_dir = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let containment_root = pointer_base_dir.unwrap_or(manifest_dir);

    let receipt_path = override_receipt_path.map(Path::to_path_buf).or_else(|| {
        string_field(&manifest, &["receiptPath", "receipt_path"])
            .or_else(|| {
                manifest
                    .get("receipt")
                    .and_then(|r| string_field(r, &["path", "receiptPath", "receipt_path"]))
            })
            .map(|p| resolve_rel(manifest_dir, &p))
    });
    let expected_receipt_sha = override_receipt_sha.map(str::to_string).or_else(|| {
        normalize_hex_64(
            string_field(&manifest, &["receiptSha256", "receipt_sha256"])
                .or_else(|| {
                    manifest
                        .get("receipt")
                        .and_then(|r| string_field(r, &["sha256", "receiptSha256"]))
                })
                .as_deref(),
        )
    });

    if let Some(rcpt_path) = receipt_path {
        let rcpt_str = rcpt_path.display().to_string();
        ensure_safe_external_history_path(config, &rcpt_path, &rcpt_str)?;
        ensure_contained_within(containment_root, &rcpt_path, &rcpt_str)?;
        let rcpt_bytes = read_bounded_file(&rcpt_path, MAX_MANIFEST_BYTES, &rcpt_str)?;
        if let Some(exp) = expected_receipt_sha.as_deref() {
            if sha256_hex(&rcpt_bytes) != exp {
                return Err(HistoryError::blocked(
                    "history_receipt_sha256_mismatch",
                    "Import receipt SHA-256 mismatch.",
                    &rcpt_str,
                ));
            }
        }
        let rcpt_json: Value = serde_json::from_slice(&rcpt_bytes).map_err(|_| {
            HistoryError::blocked(
                "history_receipt_invalid_json",
                "Import receipt is not valid JSON.",
                &rcpt_str,
            )
        })?;
        let r_schema = rcpt_json
            .get("schema")
            .and_then(Value::as_str)
            .unwrap_or("");
        if r_schema != "omnia.history-import-receipt.v1" {
            return Err(HistoryError::blocked(
                "history_receipt_schema_mismatch",
                format!("Unexpected import receipt schema '{r_schema}'."),
                &rcpt_str,
            ));
        }
        if let Some(rcpt_man_sha) = normalize_hex_64(
            string_field(&rcpt_json, &["manifestSha256", "manifest_sha256"]).as_deref(),
        ) {
            if rcpt_man_sha != actual_man_sha {
                return Err(HistoryError::blocked(
                    "history_receipt_manifest_hash_mismatch",
                    "Import receipt manifestSha256 disagrees with manifest.",
                    &rcpt_str,
                ));
            }
        }
        verify_receipt_counts(&manifest, &rcpt_json, &rcpt_str)?;
    }

    let index_path = override_index_path.map(Path::to_path_buf).or_else(|| {
        string_field(&manifest, &["bodyIndexPath", "body_index_path"])
            .or_else(|| {
                manifest
                    .get("bodyIndex")
                    .and_then(|b| string_field(b, &["path", "bodyIndexPath", "body_index_path"]))
            })
            .map(|p| resolve_rel(manifest_dir, &p))
    });
    let expected_index_sha = override_index_sha.map(str::to_string).or_else(|| {
        normalize_hex_64(
            string_field(&manifest, &["bodyIndexSha256", "body_index_sha256"])
                .or_else(|| {
                    manifest
                        .get("bodyIndex")
                        .and_then(|b| string_field(b, &["sha256", "bodyIndexSha256"]))
                })
                .as_deref(),
        )
    });

    let mut spans = BTreeMap::new();
    let mut body_bytes = None;
    if let Some(idx_path) = index_path {
        let idx_str = idx_path.display().to_string();
        ensure_safe_external_history_path(config, &idx_path, &idx_str)?;
        ensure_contained_within(containment_root, &idx_path, &idx_str)?;
        let idx_bytes = read_bounded_file(&idx_path, MAX_MANIFEST_BYTES, &idx_str)?;
        if let Some(exp) = expected_index_sha.as_deref() {
            if sha256_hex(&idx_bytes) != exp {
                return Err(HistoryError::blocked(
                    "history_body_index_sha256_mismatch",
                    "Body index SHA-256 mismatch.",
                    &idx_str,
                ));
            }
        }
        let idx_json: Value = serde_json::from_slice(&idx_bytes).map_err(|_| {
            HistoryError::blocked(
                "history_body_index_invalid_json",
                "History body index is not valid JSON.",
                &idx_str,
            )
        })?;
        let b_schema = idx_json.get("schema").and_then(Value::as_str).unwrap_or("");
        if b_schema != "omnia.history-body-index.v1" {
            return Err(HistoryError::blocked(
                "history_body_index_schema_mismatch",
                format!("Unexpected body index schema '{b_schema}'."),
                &idx_str,
            ));
        }

        let idx_dir = idx_path.parent().unwrap_or(manifest_dir);
        let body_rel = string_field(
            &idx_json,
            &["bodyPath", "body_path", "jsonlPath", "jsonl_path"],
        )
        .ok_or_else(|| {
            HistoryError::blocked(
                "history_body_path_missing",
                "Body index omits bodyPath.",
                &idx_str,
            )
        })?;
        let body_path = resolve_rel(idx_dir, &body_rel);
        let body_str = body_path.display().to_string();
        ensure_safe_external_history_path(config, &body_path, &body_str)?;
        ensure_contained_within(containment_root, &body_path, &body_str)?;
        let loaded_body = read_bounded_file(&body_path, MAX_BODY_JSONL_BYTES, &body_str)?;

        if let Some(exp_body_sha) =
            normalize_hex_64(string_field(&idx_json, &["bodySha256", "body_sha256"]).as_deref())
        {
            if sha256_hex(&loaded_body) != exp_body_sha {
                return Err(HistoryError::blocked(
                    "history_body_sha256_mismatch",
                    "History body JSONL SHA-256 mismatch.",
                    &body_str,
                ));
            }
        }

        spans = parse_and_verify_spans(&idx_json, &loaded_body, &idx_str)?;
        body_bytes = Some(loaded_body);
    }

    Ok(VerifiedHistoryStore {
        generation_source,
        generation_id,
        rollback_used,
        warnings,
        manifest_path: manifest_path.to_path_buf(),
        manifest_sha256: actual_man_sha,
        manifest,
        spans,
        body_bytes,
    })
}

fn verify_receipt_counts(
    manifest: &Value,
    receipt: &Value,
    err_path: &str,
) -> Result<(), HistoryError> {
    let man_records = manifest
        .get("records")
        .and_then(Value::as_array)
        .map(Vec::len);
    let rcpt_count = receipt
        .get("recordCount")
        .or_else(|| receipt.get("record_count"))
        .or_else(|| receipt.get("counts").and_then(|c| c.get("records")))
        .and_then(Value::as_u64);
    if let (Some(actual), Some(expected)) = (man_records, rcpt_count) {
        if actual as u64 != expected {
            return Err(HistoryError::blocked(
                "history_receipt_count_mismatch",
                format!(
                    "Import receipt recordCount ({expected}) mismatches manifest records ({actual})."
                ),
                err_path,
            ));
        }
    }
    Ok(())
}

fn parse_and_verify_spans(
    idx_json: &Value,
    body_bytes: &[u8],
    err_path: &str,
) -> Result<BTreeMap<String, SpanEntry>, HistoryError> {
    let mut map = BTreeMap::new();
    let entries = idx_json
        .get("spans")
        .or_else(|| idx_json.get("records"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            HistoryError::blocked(
                "history_body_index_missing_spans",
                "Body index must contain a spans/records array.",
                err_path,
            )
        })?;

    let mut intervals: Vec<(usize, usize)> = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(rec_id) = string_field(entry, &["recordId", "record_id", "id"]) else {
            return Err(HistoryError::blocked(
                "history_span_missing_id",
                "Body index span entry omits recordId.",
                err_path,
            ));
        };
        let offset = entry
            .get("offset")
            .or_else(|| entry.get("byteOffset"))
            .or_else(|| entry.get("byte_offset"))
            .and_then(Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| {
                HistoryError::blocked(
                    "history_span_invalid_offset",
                    "Span entry omits valid byte offset.",
                    err_path,
                )
            })?;
        let byte_length = entry
            .get("byteLength")
            .or_else(|| entry.get("byte_length"))
            .or_else(|| entry.get("length"))
            .and_then(Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
            .ok_or_else(|| {
                HistoryError::blocked(
                    "history_span_invalid_length",
                    "Span entry omits valid byteLength.",
                    err_path,
                )
            })?;
        let end = offset.checked_add(byte_length).ok_or_else(|| {
            HistoryError::blocked(
                "history_span_overflow",
                "Span byte range overflow.",
                err_path,
            )
        })?;
        if end > body_bytes.len() {
            return Err(HistoryError::blocked(
                "history_span_out_of_bounds",
                format!("Span for '{rec_id}' exceeds body JSONL byte length."),
                err_path,
            ));
        }

        let span_sha = normalize_hex_64(string_field(entry, &["sha256"]).as_deref());
        if let Some(exp) = span_sha.as_deref() {
            if sha256_hex(&body_bytes[offset..end]) != exp {
                return Err(HistoryError::blocked(
                    "history_span_sha256_mismatch",
                    format!("Span SHA-256 mismatch for '{rec_id}'."),
                    err_path,
                ));
            }
        }
        intervals.push((offset, end));
        map.insert(
            rec_id,
            SpanEntry {
                offset,
                byte_length,
                sha256: span_sha,
            },
        );
    }

    intervals.sort_unstable();
    for pair in intervals.windows(2) {
        if pair[0].1 > pair[1].0 {
            return Err(HistoryError::blocked(
                "history_span_overlap",
                "History body spans overlap illegally.",
                err_path,
            ));
        }
    }
    Ok(map)
}

fn ensure_safe_external_history_path(
    config: &StudioConfig,
    path: &Path,
    err_path: &str,
) -> Result<(), HistoryError> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(HistoryError::blocked(
            "history_path_traversal",
            "History path must not contain '..' traversal segments.",
            err_path,
        ));
    }
    if has_reparse_component(path) {
        return Err(HistoryError::blocked(
            "history_reparse_rejected",
            "History path traverses a symlink or NTFS reparse point.",
            err_path,
        ));
    }
    let Ok(canon) = fs::canonicalize(path) else {
        return Err(HistoryError::unavailable(
            "history_file_missing",
            "History artifact file is inaccessible or missing.",
            err_path,
        ));
    };
    if has_git_ancestor(&canon) {
        return Err(HistoryError::blocked(
            "history_inside_git_repo",
            "History artifacts must reside strictly outside any .git repository tree.",
            err_path,
        ));
    }
    for forbidden in [&config.workspace_root, &config.ui_root, &config.skills_root] {
        if let Ok(canon_forbidden) = fs::canonicalize(forbidden) {
            if canon.starts_with(&canon_forbidden) {
                return Err(HistoryError::blocked(
                    "history_inside_workspace",
                    "History artifacts must remain outside repository, UI, and skills roots.",
                    err_path,
                ));
            }
        }
    }
    Ok(())
}

fn ensure_contained_within(root: &Path, target: &Path, err_path: &str) -> Result<(), HistoryError> {
    let (Ok(canon_root), Ok(canon_target)) = (fs::canonicalize(root), fs::canonicalize(target))
    else {
        return Err(HistoryError::blocked(
            "history_containment_failed",
            "Unable to canonicalize history containment root.",
            err_path,
        ));
    };
    if !canon_target.starts_with(&canon_root) {
        return Err(HistoryError::blocked(
            "history_escaped_root",
            "History reference escapes its external store directory.",
            err_path,
        ));
    }
    Ok(())
}

fn has_reparse_component(path: &Path) -> bool {
    let mut acc = PathBuf::new();
    for comp in path.components() {
        acc.push(comp.as_os_str());
        if let Ok(meta) = fs::symlink_metadata(&acc) {
            if is_reparse_or_symlink(&meta) {
                return true;
            }
        }
    }
    false
}

fn has_git_ancestor(path: &Path) -> bool {
    let mut cursor: Option<&Path> = Some(path);
    while let Some(dir) = cursor {
        if dir.join(".git").exists() {
            return true;
        }
        cursor = dir.parent();
    }
    false
}

fn read_bounded_file(path: &Path, max_bytes: u64, err_path: &str) -> Result<Vec<u8>, HistoryError> {
    let meta = fs::symlink_metadata(path).map_err(|_| {
        HistoryError::unavailable("history_file_missing", "History file unreadable.", err_path)
    })?;
    if is_reparse_or_symlink(&meta) || !meta.is_file() {
        return Err(HistoryError::blocked(
            "history_not_regular_file",
            "History path must be a regular non-reparse file.",
            err_path,
        ));
    }
    if meta.len() > max_bytes {
        return Err(HistoryError::blocked(
            "history_file_too_large",
            "History file exceeds bounded byte limit.",
            err_path,
        ));
    }
    fs::read(path).map_err(|_| {
        HistoryError::unavailable(
            "history_read_failed",
            "Failed reading history file.",
            err_path,
        )
    })
}

fn resolve_rel(base_dir: &Path, raw: &str) -> PathBuf {
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        base_dir.join(candidate)
    }
}

fn string_field(obj: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn normalize_hex_64(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(trimmed.to_ascii_lowercase())
    } else {
        None
    }
}

fn compute_manifest_counts(manifest: &Value, records: &[Value]) -> Value {
    let mut verified = 0u64;
    let mut partial = 0u64;
    let mut blocked = 0u64;
    let mut transcript_available = 0u64;

    for rec in records {
        let state = rec
            .get("state")
            .or_else(|| rec.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("partial");
        match state {
            "verified" => verified += 1,
            "blocked" => blocked += 1,
            _ => partial += 1,
        }
        if rec
            .get("transcriptAvailable")
            .or_else(|| rec.get("transcript_available"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            transcript_available += 1;
        }
    }

    if let Some(explicit) = manifest.get("counts").and_then(Value::as_object) {
        return json!({
            "records": explicit.get("records").and_then(Value::as_u64).unwrap_or(records.len() as u64),
            "verified": explicit.get("verified").and_then(Value::as_u64).unwrap_or(verified),
            "partial": explicit.get("partial").and_then(Value::as_u64).unwrap_or(partial),
            "blocked": explicit.get("blocked").and_then(Value::as_u64).unwrap_or(blocked),
            "transcriptAvailable": explicit.get("transcriptAvailable").and_then(Value::as_u64).unwrap_or(transcript_available),
        });
    }

    json!({
        "records": records.len() as u64,
        "verified": verified,
        "partial": partial,
        "blocked": blocked,
        "transcriptAvailable": transcript_available,
    })
}

fn compute_manifest_completion(manifest: &Value, records: &[Value]) -> Value {
    if let Some(comp) = manifest.get("completion").and_then(Value::as_object) {
        return json!({
            "verified": comp.get("verified").cloned().unwrap_or_else(|| json!([])),
            "partial": comp.get("partial").cloned().unwrap_or_else(|| json!([])),
            "blocked": comp.get("blocked").cloned().unwrap_or_else(|| json!([])),
            "next": comp.get("next").cloned().unwrap_or_else(|| json!([])),
        });
    }
    let mut verified = Vec::new();
    let mut partial = Vec::new();
    let mut blocked = Vec::new();
    for rec in records {
        let Some(id) = string_field(rec, &["recordId", "record_id", "id"]) else {
            continue;
        };
        let state = rec
            .get("state")
            .or_else(|| rec.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("partial");
        match state {
            "verified" => verified.push(Value::String(id)),
            "blocked" => blocked.push(Value::String(id)),
            _ => partial.push(Value::String(id)),
        }
    }
    json!({
        "verified": verified,
        "partial": partial,
        "blocked": blocked,
        "next": [],
    })
}

fn derive_manifest_state(counts: &Value) -> &'static str {
    let total = counts.get("records").and_then(Value::as_u64).unwrap_or(0);
    let verified = counts.get("verified").and_then(Value::as_u64).unwrap_or(0);
    let partial = counts.get("partial").and_then(Value::as_u64).unwrap_or(0);
    let blocked = counts.get("blocked").and_then(Value::as_u64).unwrap_or(0);
    if total == 0 {
        "empty"
    } else if blocked > 0 || partial > 0 || verified < total {
        "partial"
    } else {
        "verified"
    }
}

fn json_matches_filter(val: &Value, needle_lower: &str) -> bool {
    match val {
        Value::String(s) => s.to_ascii_lowercase().contains(needle_lower),
        Value::Array(arr) => arr.iter().any(|v| json_matches_filter(v, needle_lower)),
        Value::Object(map) => map.values().any(|v| json_matches_filter(v, needle_lower)),
        _ => false,
    }
}

fn parse_bounded_usize(
    raw: Option<&str>,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, String> {
    let Some(s) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(default);
    };
    let parsed = s
        .parse::<usize>()
        .map_err(|_| format!("Invalid unsigned integer query parameter '{s}'."))?;
    if parsed < min || parsed > max {
        return Err(format!(
            "Parameter {parsed} outside allowed range [{min}, {max}]."
        ));
    }
    Ok(parsed)
}

fn redact_home_paths(input: &str) -> String {
    let mut out = input.to_string();
    for prefix in [
        r"C:\Users\",
        r"c:\Users\",
        r"C:/Users/",
        r"/Users/",
        r"/home/",
    ] {
        while let Some(pos) = out.find(prefix) {
            let start_user = pos + prefix.len();
            let rest = &out[start_user..];
            let user_len = rest
                .find(|c: char| c == '\\' || c == '/' || c.is_whitespace() || c == '"' || c == '\'')
                .unwrap_or(rest.len());
            if user_len == 0 {
                break;
            }
            out.replace_range(pos..start_user + user_len, "~");
        }
    }
    out
}

fn redact_emails_in_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for token in input.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let ws = &token[trimmed.len()..];
        let clean = trimmed.trim_matches(|c: char| matches!(c, '<' | '>' | ',' | ';' | '"' | '\''));
        if clean.contains('@')
            && clean.contains('.')
            && !clean.starts_with('@')
            && !clean.ends_with('@')
        {
            out.push_str("[REDACTED_EMAIL]");
            out.push_str(ws);
        } else {
            out.push_str(token);
        }
    }
    out
}

fn redact_urls_in_text(input: &str) -> String {
    let mut out = input.to_string();
    let schemes: HashSet<&str> = ["https://", "http://", "wss://", "ws://"]
        .into_iter()
        .collect();
    for scheme in schemes {
        while let Some(pos) = out.find(scheme) {
            let rest = &out[pos..];
            let end_rel = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | ')'))
                .unwrap_or(rest.len());
            out.replace_range(pos..pos + end_rel, "[REDACTED_URL]");
        }
    }
    out
}
