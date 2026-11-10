//! Export/import of the user's own agent data (sessions, prompt presets,
//! browser settings, `~/.omnia` config) as a plain folder.
//!
//! Secrets are never exported: provider profiles and API keys (the legacy
//! `omnia.sqlite3` and the OS credential store are not read), the browser
//! profile (cookies and sign-ins), downloads and file checkpoints stay local.
//! JSON config under `~/.omnia` has secret-looking keys removed.
//!
//! The logic lives in functions taking explicit directories so it is testable
//! without Tauri state.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::browser_profile::SETTINGS_FILE_NAME as BROWSER_SETTINGS_FILE;
use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::{omnia_home, HarnessHub};
use crate::harness_store::{HarnessStore, SessionBundle};
use crate::prompt_presets::{PresetStore, PromptPreset};

pub const FORMAT_VERSION: u32 = 1;
const MANIFEST: &str = "manifest.json";
const SESSIONS_DIR: &str = "sessions";
const PRESETS_FILE: &str = "agent-prompt-presets.json";
const HOME_DIR: &str = "omnia-home";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
const SKIPPED_HOME_DIRS: &[&str] = &[
    "bin",
    "cache",
    "tmp",
    "logs",
    "downloads",
    "node_modules",
    ".git",
];
const SECRET_KEY_WORDS: &[&str] = &[
    "apikey",
    "api_key",
    "api-key",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "credential",
];

fn failed(code: &'static str, message: impl Into<String>) -> NativeError {
    NativeError::new(code, message)
}

fn io_failed(what: &str) -> impl Fn(std::io::Error) -> NativeError + '_ {
    move |error| failed("data_portability_failed", format!("{what}: {error}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub name: String,
    pub count: usize,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format_version: u32,
    app: String,
    app_version: String,
    created_at: String,
    keys_excluded: bool,
    parts: Vec<Part>,
    #[serde(default)]
    excluded: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub parts: Vec<Part>,
    pub total_bytes: u64,
    pub keys_excluded: bool,
    /// Files left out of `~/.omnia` (secret-looking names, oversized, unreadable JSON).
    pub excluded_files: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub sessions: usize,
    pub presets: usize,
    pub files: usize,
    pub settings: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: Counts,
    pub skipped: Counts,
    /// Existing files or settings merge mode refused to overwrite.
    pub conflicts: Vec<String>,
    pub skipped_session_ids: Vec<String>,
    /// Where replaced data was moved to, when replace mode backed something up.
    pub backups: Vec<String>,
    pub restart_required: bool,
    /// Content-free evidence of the exact source manifest, version boundary,
    /// observed conflicts and completed import counts.
    pub receipt: Option<ImportReceipt>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportConflictReceipt {
    pub kind: &'static str,
    pub entity_id: String,
    pub incoming_sha256: String,
    pub existing_sha256: Option<String>,
    pub disposition: &'static str,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReceipt {
    pub schema_version: u32,
    pub id: String,
    pub source_manifest_sha256: String,
    pub source_format_version: u32,
    pub source_app_version: String,
    pub target_app_version: String,
    /// A differing app version is recorded, but never inferred to require a
    /// schema migration when the explicit transfer format is still supported.
    pub app_version_changed: bool,
    pub mode: ImportMode,
    pub imported: Counts,
    pub skipped: Counts,
    pub conflicts: Vec<ImportConflictReceipt>,
    pub backup_count: usize,
    pub restart_required: bool,
    pub completed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    Merge,
    Replace,
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A manifest-listed relative path: forward-slash segments only, never absolute or escaping.
fn safe_relative(raw: &str) -> NativeResult<PathBuf> {
    let bad = || {
        failed(
            "import_unsafe_path",
            format!("Refusing unsafe path in export: {raw}"),
        )
    };
    if raw.is_empty() || raw.starts_with('/') || raw.contains('\\') || raw.contains(':') {
        return Err(bad());
    }
    let mut path = PathBuf::new();
    for segment in raw.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.chars().any(char::is_control)
        {
            return Err(bad());
        }
        path.push(segment);
    }
    Ok(path)
}

fn is_secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".env")
        || SECRET_KEY_WORDS.iter().any(|word| lower.contains(word))
        || [".pem", ".key", ".pfx", ".p12", ".crt"]
            .iter()
            .any(|ext| lower.ends_with(ext))
}

/// Removes object keys that look like credentials; returns how many were removed.
fn scrub_secrets(value: &mut Value) -> usize {
    match value {
        Value::Object(map) => {
            let before = map.len();
            map.retain(|key, _| {
                let lower = key.to_ascii_lowercase();
                !SECRET_KEY_WORDS.iter().any(|word| lower.contains(word))
            });
            let mut removed = before - map.len();
            for child in map.values_mut() {
                removed += scrub_secrets(child);
            }
            removed
        }
        Value::Array(items) => items.iter_mut().map(scrub_secrets).sum(),
        _ => 0,
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_failed("create directory"))?;
    }
    let tmp = path.with_extension("omnia-tmp");
    fs::write(&tmp, bytes).map_err(io_failed("write file"))?;
    fs::rename(&tmp, path).map_err(io_failed("replace file"))
}

fn read_capped(path: &Path, cap: u64) -> NativeResult<Vec<u8>> {
    let meta = fs::symlink_metadata(path).map_err(io_failed("read file"))?;
    if !meta.is_file() {
        return Err(failed(
            "import_unsafe_path",
            format!("Not a regular file: {}", path.display()),
        ));
    }
    if meta.len() > cap {
        return Err(failed(
            "import_too_large",
            format!("File is too large: {}", path.display()),
        ));
    }
    fs::read(path).map_err(io_failed("read file"))
}

struct HomeFile {
    rel: String,
    path: PathBuf,
}

fn collect_home_files(root: &Path) -> Vec<HomeFile> {
    fn walk(dir: &Path, rel: &str, top: bool, out: &mut Vec<HomeFile>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if meta.is_dir() {
                if top && SKIPPED_HOME_DIRS.contains(&name.as_str()) {
                    continue;
                }
                walk(&entry.path(), &child, false, out);
            } else if meta.is_file() && safe_relative(&child).is_ok() {
                out.push(HomeFile {
                    rel: child,
                    path: entry.path(),
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", true, &mut out);
    out
}

fn unique_export_dir(dest: &Path, now: DateTime<Utc>) -> PathBuf {
    let base = format!("omnia-export-{}", now.format("%Y%m%d-%H%M%S"));
    let mut candidate = dest.join(&base);
    let mut n = 2;
    while candidate.exists() {
        candidate = dest.join(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// Writes an export under `dest_dir`. `app_data` is the app data dir (browser
/// settings live there); `home` is `~/.omnia` when it exists.
pub fn export_to(
    store: &HarnessStore,
    presets: &PresetStore,
    app_data: &Path,
    home: Option<&Path>,
    dest_dir: &Path,
    now: DateTime<Utc>,
) -> NativeResult<ExportResult> {
    if !dest_dir.is_dir() {
        return Err(failed(
            "export_destination_invalid",
            "The destination folder does not exist",
        ));
    }
    let out = unique_export_dir(dest_dir, now);
    fs::create_dir_all(&out).map_err(io_failed("create export folder"))?;
    match export_into(store, presets, app_data, home, &out, now) {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = fs::remove_dir_all(&out);
            Err(error)
        }
    }
}

fn export_into(
    store: &HarnessStore,
    presets: &PresetStore,
    app_data: &Path,
    home: Option<&Path>,
    out: &Path,
    now: DateTime<Utc>,
) -> NativeResult<ExportResult> {
    let mut parts = Vec::new();
    let mut total: u64 = 0;
    let mut excluded_files = Vec::new();
    let mut charge = |bytes: u64| -> NativeResult<()> {
        total += bytes;
        if total > MAX_TOTAL_BYTES {
            return Err(failed(
                "export_too_large",
                "The data is larger than the 512 MB export limit",
            ));
        }
        Ok(())
    };

    // Sessions: summary + transcript + journal, one file each.
    let bundles = store.export_bundles()?;
    let mut bytes = 0;
    for bundle in &bundles {
        let data = serde_json::to_vec(bundle)
            .map_err(|e| failed("data_portability_failed", e.to_string()))?;
        charge(data.len() as u64)?;
        bytes += data.len() as u64;
        write_atomic(
            &out.join(SESSIONS_DIR)
                .join(format!("{}.json", bundle.summary.id)),
            &data,
        )?;
    }
    parts.push(Part {
        name: "sessions".into(),
        count: bundles.len(),
        bytes,
        files: Vec::new(),
    });

    // Prompt presets.
    let list = presets.list()?;
    let data = serde_json::to_vec_pretty(&list)
        .map_err(|e| failed("data_portability_failed", e.to_string()))?;
    charge(data.len() as u64)?;
    write_atomic(&out.join(PRESETS_FILE), &data)?;
    parts.push(Part {
        name: "promptPresets".into(),
        count: list.len(),
        bytes: data.len() as u64,
        files: Vec::new(),
    });

    // Browser settings (flag + ffmpeg path only; the profile directory is never read).
    if let Ok(raw) = read_capped(&app_data.join(BROWSER_SETTINGS_FILE), 1024 * 1024) {
        if serde_json::from_slice::<Value>(&raw).is_ok() {
            charge(raw.len() as u64)?;
            write_atomic(&out.join(BROWSER_SETTINGS_FILE), &raw)?;
            parts.push(Part {
                name: "browserSettings".into(),
                count: 1,
                bytes: raw.len() as u64,
                files: Vec::new(),
            });
        }
    }

    // ~/.omnia user config.
    if let Some(home) = home.filter(|h| h.is_dir()) {
        let mut files = Vec::new();
        let mut bytes = 0;
        for file in collect_home_files(home) {
            let name = file.rel.rsplit('/').next().unwrap_or(&file.rel);
            if is_secret_name(name) {
                excluded_files.push(format!("{} (secret-looking name)", file.rel));
                continue;
            }
            let Ok(mut data) = read_capped(&file.path, MAX_FILE_BYTES) else {
                excluded_files.push(format!("{} (unreadable or over 8 MB)", file.rel));
                continue;
            };
            if file.rel.ends_with(".json") {
                match serde_json::from_slice::<Value>(&data) {
                    Ok(mut value) => {
                        if scrub_secrets(&mut value) > 0 {
                            data = serde_json::to_vec_pretty(&value)
                                .map_err(|e| failed("data_portability_failed", e.to_string()))?;
                        }
                    }
                    Err(_) => {
                        excluded_files.push(format!(
                            "{} (invalid JSON, cannot be checked for secrets)",
                            file.rel
                        ));
                        continue;
                    }
                }
            }
            charge(data.len() as u64)?;
            bytes += data.len() as u64;
            write_atomic(&out.join(HOME_DIR).join(safe_relative(&file.rel)?), &data)?;
            files.push(file.rel);
        }
        parts.push(Part {
            name: "omniaHome".into(),
            count: files.len(),
            bytes,
            files,
        });
    }

    let manifest = Manifest {
        format_version: FORMAT_VERSION,
        app: "omnia".into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: now.to_rfc3339(),
        keys_excluded: true,
        parts: parts.clone(),
        excluded: [
            "providerProfiles",
            "providerApiKeys",
            "browserProfile",
            "downloads",
            "checkpoints",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    };
    let data = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| failed("data_portability_failed", e.to_string()))?;
    write_atomic(&out.join(MANIFEST), &data)?;
    Ok(ExportResult {
        path: out.to_string_lossy().into_owned(),
        parts,
        total_bytes: total + data.len() as u64,
        keys_excluded: true,
        excluded_files,
    })
}

struct Validated {
    manifest: Manifest,
    manifest_sha256: String,
    bundles: Vec<SessionBundle>,
    presets: Option<Vec<PromptPreset>>,
    browser_settings: Option<Vec<u8>>,
    /// A bounded immutable read projection. Import uses the bytes validated
    /// here instead of reopening mutable source paths after session mutation.
    home_files: Option<Vec<(PathBuf, Vec<u8>)>>,
}

fn validate_source(src: &Path) -> NativeResult<Validated> {
    let src = src
        .canonicalize()
        .map_err(|_| failed("import_source_invalid", "The import folder does not exist"))?;
    if !src.is_dir() {
        return Err(failed(
            "import_source_invalid",
            "The import path is not a folder",
        ));
    }
    let manifest_bytes = read_capped(&src.join(MANIFEST), MAX_MANIFEST_BYTES).map_err(|_| {
        failed(
            "import_manifest_invalid",
            "manifest.json is missing or unreadable",
        )
    })?;
    let manifest_sha256 = hash_bytes(&manifest_bytes);
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| failed("import_manifest_invalid", "manifest.json is not valid"))?;
    if manifest.format_version != FORMAT_VERSION {
        return Err(failed(
            "import_version_unsupported",
            format!(
                "Unsupported export format version {}",
                manifest.format_version
            ),
        ));
    }
    if manifest.app != "omnia"
        || !manifest.keys_excluded
        || manifest.app_version.trim().is_empty()
        || manifest.app_version.len() > 128
        || DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
    {
        return Err(failed(
            "import_manifest_invalid",
            "The export identity, secret boundary, app version or creation timestamp is invalid",
        ));
    }
    let mut part_names = HashSet::new();
    if manifest.parts.len() > 4
        || manifest.parts.iter().any(|part| {
            !matches!(
                part.name.as_str(),
                "sessions" | "promptPresets" | "browserSettings" | "omniaHome"
            ) || !part_names.insert(part.name.clone())
        })
    {
        return Err(failed(
            "import_manifest_invalid",
            "The export has duplicate or unsupported parts",
        ));
    }
    let has = |name: &str| manifest.parts.iter().any(|part| part.name == name);
    let mut total: u64 = 0;
    let mut charge = |bytes: usize| -> NativeResult<()> {
        total += bytes as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(failed(
                "import_too_large",
                "The export is larger than the 512 MB limit",
            ));
        }
        Ok(())
    };

    let mut bundles = Vec::new();
    if has("sessions") {
        let dir = src.join(SESSIONS_DIR);
        if dir.is_dir() {
            let mut names: Vec<_> = fs::read_dir(&dir)
                .map_err(io_failed("read sessions"))?
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            let mut seen = HashSet::new();
            for name in names {
                let stem = name.strip_suffix(".json").filter(|s| is_valid_id(s));
                let Some(stem) = stem else {
                    return Err(failed(
                        "import_unsafe_path",
                        format!("Unexpected entry in sessions: {name}"),
                    ));
                };
                let raw = read_capped(&dir.join(&name), MAX_SESSION_BYTES)?;
                charge(raw.len())?;
                let bundle: SessionBundle = serde_json::from_slice(&raw).map_err(|_| {
                    failed(
                        "import_session_invalid",
                        format!("Session file is invalid: {name}"),
                    )
                })?;
                if bundle.summary.id != stem || !seen.insert(stem.to_owned()) {
                    return Err(failed(
                        "import_session_invalid",
                        format!("Session id does not match file: {name}"),
                    ));
                }
                bundles.push(bundle);
            }
        }
    }

    let presets = if has("promptPresets") {
        let raw = read_capped(&src.join(PRESETS_FILE), MAX_FILE_BYTES)?;
        charge(raw.len())?;
        Some(
            serde_json::from_slice::<Vec<PromptPreset>>(&raw)
                .map_err(|_| failed("import_presets_invalid", "Prompt presets file is invalid"))?,
        )
    } else {
        None
    };

    let browser_settings = if has("browserSettings") {
        let raw = read_capped(&src.join(BROWSER_SETTINGS_FILE), 1024 * 1024)?;
        serde_json::from_slice::<Value>(&raw).map_err(|_| {
            failed(
                "import_settings_invalid",
                "Browser settings file is invalid",
            )
        })?;
        Some(raw)
    } else {
        None
    };

    let home_files = match manifest.parts.iter().find(|part| part.name == "omniaHome") {
        None => None,
        Some(part) => {
            let root = src.join(HOME_DIR);
            let root = root
                .canonicalize()
                .map_err(|_| failed("import_manifest_invalid", "omnia-home folder is missing"))?;
            let mut files = Vec::new();
            let mut listed_paths = HashSet::new();
            for raw in &part.files {
                let rel = safe_relative(raw)?;
                if !listed_paths.insert(rel.clone()) {
                    return Err(failed(
                        "import_manifest_invalid",
                        format!("The export lists the same home file more than once: {raw}"),
                    ));
                }
                let source = root.join(&rel).canonicalize().map_err(|_| {
                    failed(
                        "import_manifest_invalid",
                        format!("Listed file is missing: {raw}"),
                    )
                })?;
                if !source.starts_with(&root) {
                    return Err(failed(
                        "import_unsafe_path",
                        format!("Refusing path outside the export: {raw}"),
                    ));
                }
                let size = fs::metadata(&source).map_err(io_failed("read file"))?;
                if !size.is_file() || size.len() > MAX_FILE_BYTES {
                    return Err(failed(
                        "import_unsafe_path",
                        format!("Not an importable file: {raw}"),
                    ));
                }
                let data = read_capped(&source, MAX_FILE_BYTES)?;
                charge(data.len())?;
                files.push((rel, data));
            }
            Some(files)
        }
    };

    Ok(Validated {
        manifest,
        manifest_sha256,
        bundles,
        presets,
        browser_settings,
        home_files,
    })
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hash_json(value: &impl Serialize) -> NativeResult<String> {
    serde_json::to_vec(value)
        .map(|bytes| hash_bytes(&bytes))
        .map_err(|error| failed("data_portability_failed", error.to_string()))
}

fn kept_existing_conflict(
    kind: &'static str,
    entity_id: impl Into<String>,
    incoming_sha256: String,
    existing_sha256: Option<String>,
    reason: &'static str,
) -> ImportConflictReceipt {
    ImportConflictReceipt {
        kind,
        entity_id: entity_id.into(),
        incoming_sha256,
        existing_sha256,
        disposition: "kept-existing",
        reason,
    }
}

fn unique_sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = path.with_file_name(format!("{name}.bak-{suffix}"));
    let mut candidate = base.clone();
    let mut n = 2;
    while candidate.exists() {
        candidate = PathBuf::from(format!("{}-{n}", base.display()));
        n += 1;
    }
    candidate
}

pub fn import_from(
    store: &HarnessStore,
    presets: &PresetStore,
    app_data: &Path,
    home: Option<&Path>,
    src: &Path,
    mode: ImportMode,
    now: DateTime<Utc>,
) -> NativeResult<ImportSummary> {
    let v = validate_source(src)?;
    let stamp = now.format("%Y%m%d-%H%M%S").to_string();
    let replace = mode == ImportMode::Replace;
    let mut summary = ImportSummary::default();
    let mut conflict_receipts = Vec::new();
    let backup_dir = app_data.join(format!("import-backup-{stamp}"));

    // Sessions.
    if !v.bundles.is_empty() || (replace && v.manifest.parts.iter().any(|p| p.name == "sessions")) {
        let existing = store.export_bundles()?;
        if replace {
            if !existing.is_empty() {
                for bundle in &existing {
                    let data = serde_json::to_vec(bundle)
                        .map_err(|e| failed("data_portability_failed", e.to_string()))?;
                    write_atomic(
                        &backup_dir
                            .join(SESSIONS_DIR)
                            .join(format!("{}.json", bundle.summary.id)),
                        &data,
                    )?;
                }
                summary
                    .backups
                    .push(backup_dir.to_string_lossy().into_owned());
            }
        } else {
            let existing: HashMap<_, _> = existing
                .iter()
                .map(|bundle| (bundle.summary.id.as_str(), bundle))
                .collect();
            for incoming in &v.bundles {
                if let Some(current) = existing.get(incoming.summary.id.as_str()) {
                    let incoming_hash = hash_json(incoming)?;
                    let current_hash = hash_json(current)?;
                    if incoming_hash != current_hash {
                        summary
                            .conflicts
                            .push(format!("sessions/{}", incoming.summary.id));
                        conflict_receipts.push(kept_existing_conflict(
                            "session",
                            &incoming.summary.id,
                            incoming_hash,
                            Some(current_hash),
                            "different-content",
                        ));
                    }
                }
            }
        }
        let (imported, skipped) = store.import_bundles(&v.bundles, replace)?;
        summary.imported.sessions = imported;
        summary.skipped.sessions = skipped.len();
        summary.skipped_session_ids = skipped;
    }

    // Prompt presets: merge by id.
    if let Some(incoming) = v.presets {
        let current = presets.list()?;
        if replace {
            if !current.is_empty() {
                write_atomic(
                    &backup_dir.join(PRESETS_FILE),
                    &serde_json::to_vec_pretty(&current)
                        .map_err(|e| failed("data_portability_failed", e.to_string()))?,
                )?;
                if !summary.backups.iter().any(|b| Path::new(b) == backup_dir) {
                    summary
                        .backups
                        .push(backup_dir.to_string_lossy().into_owned());
                }
            }
            for preset in &current {
                presets.delete(&preset.id)?;
            }
        }
        let known: HashMap<String, PromptPreset> = if replace {
            HashMap::new()
        } else {
            current.into_iter().map(|p| (p.id.clone(), p)).collect()
        };
        for preset in incoming {
            if let Some(existing) = known.get(&preset.id) {
                summary.skipped.presets += 1;
                let incoming_hash = hash_json(&preset)?;
                let existing_hash = hash_json(existing)?;
                if incoming_hash != existing_hash {
                    summary
                        .conflicts
                        .push(format!("prompt-presets/{}", preset.id));
                    conflict_receipts.push(kept_existing_conflict(
                        "preset",
                        &preset.id,
                        incoming_hash,
                        Some(existing_hash),
                        "different-content",
                    ));
                }
            } else if presets.save(preset).is_ok() {
                summary.imported.presets += 1;
            } else {
                summary.skipped.presets += 1;
            }
        }
    }

    // Browser settings.
    if let Some(raw) = v.browser_settings {
        let target = app_data.join(BROWSER_SETTINGS_FILE);
        match fs::read(&target) {
            Ok(existing) if existing == raw => summary.skipped.settings += 1,
            Ok(existing) if !replace => {
                summary.skipped.settings += 1;
                summary.conflicts.push(BROWSER_SETTINGS_FILE.to_owned());
                conflict_receipts.push(kept_existing_conflict(
                    "browser-settings",
                    BROWSER_SETTINGS_FILE,
                    hash_bytes(&raw),
                    Some(hash_bytes(&existing)),
                    "different-content",
                ));
            }
            existing => {
                if let Ok(existing) = existing {
                    write_atomic(&backup_dir.join(BROWSER_SETTINGS_FILE), &existing)?;
                    if !summary.backups.iter().any(|b| Path::new(b) == backup_dir) {
                        summary
                            .backups
                            .push(backup_dir.to_string_lossy().into_owned());
                    }
                }
                write_atomic(&target, &raw)?;
                summary.imported.settings += 1;
                summary.restart_required = true;
            }
        }
    }

    // ~/.omnia files.
    if let (Some(files), Some(home)) = (v.home_files, home) {
        if replace && home.exists() {
            let backup = unique_sibling(home, &stamp);
            fs::rename(home, &backup).map_err(io_failed("back up the existing ~/.omnia folder"))?;
            summary.backups.push(backup.to_string_lossy().into_owned());
        }
        fs::create_dir_all(home).map_err(io_failed("create ~/.omnia"))?;
        let home_root = home.canonicalize().map_err(io_failed("resolve ~/.omnia"))?;
        for (rel, data) in files {
            let target = home.join(&rel);
            let shown = rel.to_string_lossy().replace('\\', "/");
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(io_failed("create directory"))?;
                let canonical = parent
                    .canonicalize()
                    .map_err(io_failed("resolve directory"))?;
                if !canonical.starts_with(&home_root) {
                    return Err(failed(
                        "import_unsafe_path",
                        format!("Refusing path outside ~/.omnia: {shown}"),
                    ));
                }
            }
            match fs::symlink_metadata(&target) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    summary.conflicts.push(shown.clone());
                    conflict_receipts.push(kept_existing_conflict(
                        "home-file",
                        shown,
                        hash_bytes(&data),
                        None,
                        "unsafe-existing-link",
                    ));
                    summary.skipped.files += 1;
                }
                Ok(_) => {
                    let existing = read_capped(&target, MAX_FILE_BYTES);
                    if existing
                        .as_ref()
                        .is_ok_and(|existing| existing.as_slice() == data.as_slice())
                    {
                        summary.skipped.files += 1;
                    } else {
                        summary.conflicts.push(shown.clone());
                        conflict_receipts.push(kept_existing_conflict(
                            "home-file",
                            shown,
                            hash_bytes(&data),
                            existing.as_ref().ok().map(|bytes| hash_bytes(bytes)),
                            if existing.is_ok() {
                                "different-content"
                            } else {
                                "unreadable-existing"
                            },
                        ));
                        summary.skipped.files += 1;
                    }
                }
                Err(_) => {
                    write_atomic(&target, &data)?;
                    summary.imported.files += 1;
                }
            }
        }
    }
    summary.receipt = Some(ImportReceipt {
        schema_version: 1,
        id: format!("import_receipt_{}", uuid::Uuid::new_v4().simple()),
        source_manifest_sha256: v.manifest_sha256,
        source_format_version: v.manifest.format_version,
        app_version_changed: v.manifest.app_version != env!("CARGO_PKG_VERSION"),
        source_app_version: v.manifest.app_version,
        target_app_version: env!("CARGO_PKG_VERSION").to_owned(),
        mode,
        imported: summary.imported.clone(),
        skipped: summary.skipped.clone(),
        conflicts: conflict_receipts,
        backup_count: summary.backups.len(),
        restart_required: summary.restart_required,
        completed_at: now.to_rfc3339(),
    });
    Ok(summary)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDataExportRequest {
    pub dest_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDataImportRequest {
    pub src_dir: String,
    pub mode: ImportMode,
}

fn app_data(app: &AppHandle) -> NativeResult<PathBuf> {
    app.path().app_data_dir().map_err(|_| {
        failed(
            "data_portability_failed",
            "The app data folder is unavailable",
        )
    })
}

#[tauri::command]
pub async fn agent_data_export(
    app: AppHandle,
    hub: State<'_, HarnessHub>,
    request: AgentDataExportRequest,
) -> NativeResult<ExportResult> {
    let _idle = hub.idle_guard()?;
    export_to(
        hub.store(),
        hub.presets(),
        &app_data(&app)?,
        omnia_home().as_deref(),
        Path::new(&request.dest_dir),
        Utc::now(),
    )
}

#[tauri::command]
pub async fn agent_data_import(
    app: AppHandle,
    hub: State<'_, HarnessHub>,
    request: AgentDataImportRequest,
) -> NativeResult<ImportSummary> {
    let _idle = hub.idle_guard()?;
    import_from(
        hub.store(),
        hub.presets(),
        &app_data(&app)?,
        omnia_home().as_deref(),
        Path::new(&request.src_dir),
        request.mode,
        Utc::now(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_store::{AgentSessionSummary, SessionScope};
    use omnia_harness::permission::PermissionMode;
    use omnia_harness::prompt::SystemPromptMode;
    use serde_json::json;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnia-dp-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn summary(id: &str) -> AgentSessionSummary {
        AgentSessionSummary {
            id: id.into(),
            title: format!("Session {id}"),
            scope: SessionScope::Project,
            cwd: ".".into(),
            profile_id: "p".into(),
            model: "m".into(),
            permission_mode: PermissionMode::default(),
            rules: Vec::new(),
            reasoning_effort: None,
            fallback_models: Vec::new(),
            token_budget: None,
            tokens_used: 0,
            system_prompt: None,
            parent_id: None,
            settings_revision: 1,
            message_count: 0,
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    struct Fixture {
        store: HarnessStore,
        presets: PresetStore,
        app_data: PathBuf,
        home: PathBuf,
    }

    fn fixture(label: &str) -> Fixture {
        let app_data = temp(&format!("{label}-data"));
        let home = temp(&format!("{label}-home")).join(".omnia");
        Fixture {
            store: HarnessStore::in_memory().unwrap(),
            presets: PresetStore::new(&app_data),
            app_data,
            home,
        }
    }

    fn seed(f: &Fixture) {
        f.store.save_summary(&summary("s1")).unwrap();
        f.store.save_summary(&summary("s2")).unwrap();
        f.store
            .write_messages(
                "s1",
                &[serde_json::from_value(
                    json!({"role":"user","content":[{"type":"text","text":"hi"}]}),
                )
                .unwrap()],
                0,
            )
            .unwrap();
        f.store
            .append_event("s1", &json!({"type":"run_started"}))
            .unwrap();
        f.presets
            .save(PromptPreset {
                id: "pp1".into(),
                name: "Terse".into(),
                mode: SystemPromptMode::Append,
                text: "be brief".into(),
            })
            .unwrap();
        fs::write(
            f.app_data.join(BROWSER_SETTINGS_FILE),
            br#"{"keepSignIns":false}"#,
        )
        .unwrap();
        fs::create_dir_all(f.home.join("memory")).unwrap();
        fs::write(f.home.join("memory").join("notes.md"), "remember").unwrap();
        fs::write(
            f.home.join("mcp.json"),
            br#"{"servers":{"a":{"command":"x","env":{"GITHUB_TOKEN":"ghp_secret","MODE":"1"},"apiKey":"k"}}}"#,
        )
        .unwrap();
        fs::write(f.home.join(".env"), "TOKEN=1").unwrap();
        fs::create_dir_all(f.home.join("bin")).unwrap();
        fs::write(f.home.join("bin").join("ffmpeg.exe"), "binary").unwrap();
    }

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn export_then_import_round_trips_and_strips_secrets() {
        let src = fixture("src");
        seed(&src);
        let dest = temp("dest");
        let result = export_to(
            &src.store,
            &src.presets,
            &src.app_data,
            Some(&src.home),
            &dest,
            now(),
        )
        .unwrap();
        assert!(result.keys_excluded);
        let out = PathBuf::from(&result.path);
        assert!(out
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("omnia-export-"));
        let mcp = fs::read_to_string(out.join(HOME_DIR).join("mcp.json")).unwrap();
        assert!(!mcp.contains("ghp_secret") && !mcp.contains("apiKey") && mcp.contains("MODE"));
        assert!(!out.join(HOME_DIR).join(".env").exists());
        assert!(!out.join(HOME_DIR).join("bin").exists());
        assert!(result.excluded_files.iter().any(|f| f.starts_with(".env")));
        let manifest: Value =
            serde_json::from_slice(&fs::read(out.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest["formatVersion"], 1);
        assert_eq!(manifest["keysExcluded"], true);

        let dst = fixture("dst");
        let summary = import_from(
            &dst.store,
            &dst.presets,
            &dst.app_data,
            Some(&dst.home),
            &out,
            ImportMode::Merge,
            now(),
        )
        .unwrap();
        assert_eq!(summary.imported.sessions, 2);
        assert_eq!(summary.imported.presets, 1);
        assert_eq!(summary.imported.settings, 1);
        assert_eq!(summary.imported.files, 2);
        assert_eq!(dst.store.messages("s1").unwrap().len(), 1);
        assert_eq!(dst.store.list().unwrap().len(), 2);
        assert_eq!(dst.store.replay("s1").unwrap().events.len(), 1);
        assert_eq!(dst.presets.list().unwrap()[0].id, "pp1");
        assert_eq!(
            fs::read_to_string(dst.home.join("memory").join("notes.md")).unwrap(),
            "remember"
        );

        // Second merge skips everything and reports no conflicts for identical files.
        let again = import_from(
            &dst.store,
            &dst.presets,
            &dst.app_data,
            Some(&dst.home),
            &out,
            ImportMode::Merge,
            now(),
        )
        .unwrap();
        assert_eq!(again.imported.sessions, 0);
        assert_eq!(again.skipped.sessions, 2);
        assert_eq!(again.skipped_session_ids.len(), 2);
        assert_eq!(again.skipped.presets, 1);
        assert!(again.conflicts.is_empty());
    }

    #[test]
    fn update_settings_and_allow_unsigned_never_travel_with_exports() {
        // `allow_unsigned` lives only in <app data>/update_settings.json.  Neither export
        // nor import may carry it, so a crafted bundle cannot switch signature checking off.
        const UPDATE_SETTINGS: &str = "update_settings.json";
        let src = fixture("u-src");
        seed(&src);
        fs::write(
            src.app_data.join(UPDATE_SETTINGS),
            br#"{"feedUrl":"https://e.test/f","allowUnsigned":true}"#,
        )
        .unwrap();
        let dest = temp("u-dest");
        let result = export_to(
            &src.store,
            &src.presets,
            &src.app_data,
            Some(&src.home),
            &dest,
            now(),
        )
        .unwrap();
        let out = PathBuf::from(&result.path);
        assert!(!out.join(UPDATE_SETTINGS).exists());
        assert!(!out.join(HOME_DIR).join(UPDATE_SETTINGS).exists());

        // A hostile bundle that plants the file is ignored on import (merge and replace).
        fs::write(
            out.join(UPDATE_SETTINGS),
            br#"{"feedUrl":"https://evil.test/f","allowUnsigned":true}"#,
        )
        .unwrap();
        for mode in [ImportMode::Merge, ImportMode::Replace] {
            let dst = fixture("u-dst");
            import_from(
                &dst.store,
                &dst.presets,
                &dst.app_data,
                Some(&dst.home),
                &out,
                mode,
                now(),
            )
            .unwrap();
            assert!(!dst.app_data.join(UPDATE_SETTINGS).exists());
        }
    }

    #[test]
    fn merge_reports_conflicts_and_keeps_existing_files() {
        let src = fixture("c-src");
        seed(&src);
        let out = PathBuf::from(
            export_to(
                &src.store,
                &src.presets,
                &src.app_data,
                Some(&src.home),
                &temp("c-dest"),
                now(),
            )
            .unwrap()
            .path,
        );
        let dst = fixture("c-dst");
        fs::create_dir_all(dst.home.join("memory")).unwrap();
        fs::write(dst.home.join("memory").join("notes.md"), "local").unwrap();
        let summary = import_from(
            &dst.store,
            &dst.presets,
            &dst.app_data,
            Some(&dst.home),
            &out,
            ImportMode::Merge,
            now(),
        )
        .unwrap();
        assert_eq!(summary.conflicts, vec!["memory/notes.md".to_string()]);
        assert_eq!(
            fs::read_to_string(dst.home.join("memory").join("notes.md")).unwrap(),
            "local"
        );
        let receipt = summary.receipt.expect("completed import receipt");
        assert_eq!(receipt.source_format_version, FORMAT_VERSION);
        assert_eq!(receipt.source_manifest_sha256.len(), 64);
        assert_eq!(receipt.conflicts.len(), 1);
        assert_eq!(receipt.conflicts[0].entity_id, "memory/notes.md");
        assert_eq!(
            receipt.conflicts[0].incoming_sha256,
            hash_bytes(b"remember")
        );
        assert_eq!(
            receipt.conflicts[0].existing_sha256,
            Some(hash_bytes(b"local"))
        );
        assert_eq!(receipt.conflicts[0].disposition, "kept-existing");
    }

    #[test]
    fn cross_app_version_import_records_session_and_preset_conflicts_without_content() {
        let src = fixture("version-src");
        seed(&src);
        let out = PathBuf::from(
            export_to(
                &src.store,
                &src.presets,
                &src.app_data,
                Some(&src.home),
                &temp("version-dest"),
                now(),
            )
            .unwrap()
            .path,
        );
        let manifest_path = out.join(MANIFEST);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["appVersion"] = json!("0.0.1-before-migration");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let dst = fixture("version-dst");
        let mut current = summary("s1");
        current.title = "Local title must survive".into();
        dst.store.save_summary(&current).unwrap();
        dst.presets
            .save(PromptPreset {
                id: "pp1".into(),
                name: "Local preset".into(),
                mode: SystemPromptMode::Append,
                text: "private local text".into(),
            })
            .unwrap();

        let result = import_from(
            &dst.store,
            &dst.presets,
            &dst.app_data,
            Some(&dst.home),
            &out,
            ImportMode::Merge,
            now(),
        )
        .unwrap();
        assert_eq!(result.imported.sessions, 1);
        assert_eq!(result.skipped.sessions, 1);
        assert_eq!(
            dst.store.summary("s1").unwrap().title,
            "Local title must survive"
        );
        assert_eq!(dst.presets.list().unwrap()[0].name, "Local preset");
        let receipt = result.receipt.unwrap();
        assert!(receipt.app_version_changed);
        assert_eq!(receipt.source_app_version, "0.0.1-before-migration");
        assert_eq!(receipt.mode, ImportMode::Merge);
        assert_eq!(receipt.conflicts.len(), 2);
        assert_eq!(receipt.conflicts[0].kind, "session");
        assert_eq!(receipt.conflicts[1].kind, "preset");
        let payload = serde_json::to_string(&receipt).unwrap();
        assert!(!payload.contains("Local title must survive"));
        assert!(!payload.contains("private local text"));
        assert!(!payload.contains("be brief"));
    }

    #[test]
    fn manifest_boundary_and_duplicate_parts_fail_before_any_import() {
        let src = fixture("boundary-src");
        seed(&src);
        let out = PathBuf::from(
            export_to(
                &src.store,
                &src.presets,
                &src.app_data,
                Some(&src.home),
                &temp("boundary-dest"),
                now(),
            )
            .unwrap()
            .path,
        );
        let manifest_path = out.join(MANIFEST);
        let original: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        for field in ["app", "keysExcluded", "createdAt"] {
            let dst = fixture("boundary-dst");
            let mut manifest = original.clone();
            manifest[field] = match field {
                "app" => json!("unrelated-app"),
                "keysExcluded" => json!(false),
                _ => json!("not-a-timestamp"),
            };
            fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            assert_eq!(
                import_from(
                    &dst.store,
                    &dst.presets,
                    &dst.app_data,
                    Some(&dst.home),
                    &out,
                    ImportMode::Merge,
                    now()
                )
                .unwrap_err()
                .code,
                "import_manifest_invalid"
            );
            assert!(dst.store.list().unwrap().is_empty());
        }
        let mut manifest = original.clone();
        let duplicate = manifest["parts"][0].clone();
        manifest["parts"].as_array_mut().unwrap().push(duplicate);
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            validate_source(&out).err().unwrap().code,
            "import_manifest_invalid"
        );
        let mut duplicate_file_manifest = original.clone();
        for part in duplicate_file_manifest["parts"].as_array_mut().unwrap() {
            if part["name"] == "omniaHome" {
                let first = part["files"]
                    .as_array()
                    .and_then(|files| files.first())
                    .cloned();
                if let Some(first) = first {
                    part["files"].as_array_mut().unwrap().push(first);
                }
            }
        }
        fs::write(
            &manifest_path,
            serde_json::to_vec(&duplicate_file_manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(
            validate_source(&out).err().unwrap().code,
            "import_manifest_invalid"
        );
    }

    #[test]
    fn replace_backs_up_home_and_swaps_sessions() {
        let src = fixture("r-src");
        seed(&src);
        let out = PathBuf::from(
            export_to(
                &src.store,
                &src.presets,
                &src.app_data,
                Some(&src.home),
                &temp("r-dest"),
                now(),
            )
            .unwrap()
            .path,
        );
        let dst = fixture("r-dst");
        dst.store.save_summary(&summary("old")).unwrap();
        fs::create_dir_all(&dst.home).unwrap();
        fs::write(dst.home.join("keep.md"), "old").unwrap();
        let summary = import_from(
            &dst.store,
            &dst.presets,
            &dst.app_data,
            Some(&dst.home),
            &out,
            ImportMode::Replace,
            now(),
        )
        .unwrap();
        assert!(dst.store.summary("old").is_err());
        assert!(dst.store.summary("s1").is_ok());
        assert!(!dst.home.join("keep.md").exists());
        let backup = summary
            .backups
            .iter()
            .find(|b| b.contains(".bak-"))
            .expect("home backup");
        assert_eq!(
            fs::read_to_string(Path::new(backup).join("keep.md")).unwrap(),
            "old"
        );
        assert!(summary.backups.iter().any(|b| b.contains("import-backup-")));
    }

    #[test]
    fn traversal_and_bad_manifests_are_rejected() {
        let src = fixture("t-src");
        seed(&src);
        let out = PathBuf::from(
            export_to(
                &src.store,
                &src.presets,
                &src.app_data,
                Some(&src.home),
                &temp("t-dest"),
                now(),
            )
            .unwrap()
            .path,
        );
        let dst = fixture("t-dst");
        let manifest_path = out.join(MANIFEST);
        let original: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();

        for bad in ["../evil.txt", "/abs.txt", "C:/abs.txt", "a/../../b", "a\\b"] {
            let mut manifest = original.clone();
            for part in manifest["parts"].as_array_mut().unwrap() {
                if part["name"] == "omniaHome" {
                    part["files"].as_array_mut().unwrap().push(json!(bad));
                }
            }
            fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            let err = import_from(
                &dst.store,
                &dst.presets,
                &dst.app_data,
                Some(&dst.home),
                &out,
                ImportMode::Merge,
                now(),
            )
            .unwrap_err();
            assert_eq!(err.code, "import_unsafe_path", "{bad}");
        }
        assert!(dst.store.list().unwrap().is_empty());
        assert!(!dst.home.exists());

        let mut manifest = original.clone();
        manifest["formatVersion"] = json!(2);
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let err = import_from(
            &dst.store,
            &dst.presets,
            &dst.app_data,
            Some(&dst.home),
            &out,
            ImportMode::Merge,
            now(),
        )
        .unwrap_err();
        assert_eq!(err.code, "import_version_unsupported");
    }

    #[test]
    fn export_without_destination_fails_and_secret_names_detected() {
        let f = fixture("e");
        assert!(export_to(
            &f.store,
            &f.presets,
            &f.app_data,
            None,
            &f.app_data.join("missing"),
            now()
        )
        .is_err());
        assert!(
            is_secret_name("credentials.json")
                && is_secret_name("id.pem")
                && !is_secret_name("notes.md")
        );
        let mut value = json!({"a":{"Authorization":"x","keep":1},"list":[{"password":"p"}]});
        assert_eq!(scrub_secrets(&mut value), 2);
        assert_eq!(value, json!({"a":{"keep":1},"list":[{}]}));
    }
}
