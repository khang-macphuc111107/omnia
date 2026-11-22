use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
const MAX_SKILL_BYTES: u64 = 256 * 1024;
const MAX_TOTAL_SKILL_BYTES: u64 = 4 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 96;
const MAX_QUERY_BYTES: usize = 2048;
const MAX_SEARCH_BYTES: usize = 256;
const DEFAULT_LIMIT: usize = 32;
const MAX_LIMIT: usize = 100;
const EXPECTED_COMMIT: &str = "2d2065fb4520fa3f3f2bcf61cff26ec8b7eba4b5";
const EXPECTED_URL: &str = "https://github.com/K-Dense-AI/scientific-agent-skills";
const EXPECTED_SCHEMA_V1: &str = "omnia.kdense.projections.v1";
const EXPECTED_SCHEMA_V3: &str = "omnia.kdense.projection-manifest.v3";
const EXPECTED_LICENSE_SHA256: &str =
    "09b02a3c9df3053c55531d503357a9c7cde275970e6c3ceaa1ddf5f0e90b40c1";
const EXPECTED_LICENSE_BYTES: usize = 1068;
const RUNTIME_ADMISSION: &str = "not_admitted";

#[derive(Clone, Debug)]
pub struct SkillCatalog {
    state: CatalogState,
}

#[derive(Clone, Debug)]
enum CatalogState {
    Unavailable { code: String, detail: String },
    Error { code: String, detail: String },
    Ready(Arc<CatalogSnapshot>),
}

#[derive(Clone, Debug)]
struct CatalogSnapshot {
    upstream_url: String,
    upstream_commit: String,
    license_spdx: String,
    entries: BTreeMap<String, SkillEntry>,
}

#[derive(Clone, Debug)]
struct SkillEntry {
    name: String,
    upstream_skill_path: String,
    upstream_url: String,
    upstream_commit: String,
    license_spdx: String,
    relative_path: String,
    bytes: usize,
    sha256: String,
    content: String,
}

#[derive(Debug)]
pub enum QueryError {
    Invalid(String),
    Unavailable { code: String, detail: String },
    Error { code: String, detail: String },
    NotFound,
}

impl SkillCatalog {
    pub fn load(root_raw: Option<&str>, manifest_raw: Option<&str>) -> Self {
        let (Some(root_raw), Some(manifest_raw)) = (root_raw, manifest_raw) else {
            return Self::unavailable("skills_unavailable", "skill catalog is not configured");
        };
        if root_raw.trim().is_empty() || manifest_raw.trim().is_empty() {
            return Self::unavailable("skills_unavailable", "skill catalog is not configured");
        }

        match load_snapshot(root_raw, manifest_raw) {
            Ok(snapshot) => Self {
                state: CatalogState::Ready(Arc::new(snapshot)),
            },
            Err(error) => Self {
                state: CatalogState::Error {
                    code: "skills_manifest_invalid".to_string(),
                    detail: error,
                },
            },
        }
    }

    fn unavailable(code: &str, detail: &str) -> Self {
        Self {
            state: CatalogState::Unavailable {
                code: code.to_string(),
                detail: detail.to_string(),
            },
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.state, CatalogState::Ready(_))
    }

    pub fn state_value(&self) -> Value {
        match &self.state {
            CatalogState::Ready(snapshot) => json!({
                "state": "ready",
                "runtimeAdmission": RUNTIME_ADMISSION,
                "execution": false,
                "upstream": {
                    "url": snapshot.upstream_url,
                    "commit": snapshot.upstream_commit,
                    "license": snapshot.license_spdx,
                },
                "count": snapshot.entries.len(),
            }),
            CatalogState::Unavailable { code, detail } | CatalogState::Error { code, detail } => {
                json!({
                    "state": if matches!(&self.state, CatalogState::Unavailable { .. }) {
                        "unavailable"
                    } else {
                        "error"
                    },
                    "error": code,
                    "detail": detail,
                    "runtimeAdmission": RUNTIME_ADMISSION,
                    "execution": false,
                })
            }
        }
    }

    pub fn discovery(&self, raw_query: &str) -> Result<Value, QueryError> {
        let params = parse_query(raw_query, QueryMode::Discovery)?;
        let search = params.query.as_deref().unwrap_or("");
        match &self.state {
            CatalogState::Ready(snapshot) => {
                let limit = params.limit;
                let skills = snapshot
                    .entries
                    .values()
                    .filter(|entry| {
                        search.is_empty()
                            || entry.name.contains(search)
                            || entry.upstream_skill_path.contains(search)
                    })
                    .take(limit)
                    .map(skill_metadata)
                    .collect::<Vec<_>>();
                Ok(json!({
                    "state": "ready",
                    "runtimeAdmission": RUNTIME_ADMISSION,
                    "execution": false,
                    "upstream": {
                        "url": snapshot.upstream_url,
                        "commit": snapshot.upstream_commit,
                        "license": snapshot.license_spdx,
                    },
                    "query": search,
                    "limit": limit,
                    "count": skills.len(),
                    "skills": skills,
                }))
            }
            CatalogState::Unavailable { code, detail } => Ok(json!({
                "state": "unavailable",
                "error": code,
                "detail": detail,
                "runtimeAdmission": RUNTIME_ADMISSION,
                "execution": false,
                "skills": [],
            })),
            CatalogState::Error { code, detail } => Ok(json!({
                "state": "error",
                "error": code,
                "detail": detail,
                "runtimeAdmission": RUNTIME_ADMISSION,
                "execution": false,
                "skills": [],
            })),
        }
    }

    pub fn content(&self, raw_query: &str) -> Result<Value, QueryError> {
        let params = parse_query(raw_query, QueryMode::Content)?;
        let name = params
            .name
            .ok_or_else(|| QueryError::Invalid("name is required".to_string()))?;
        match &self.state {
            CatalogState::Ready(snapshot) => {
                let entry = snapshot.entries.get(&name).ok_or(QueryError::NotFound)?;
                Ok(json!({
                    "state": "ready",
                    "runtimeAdmission": RUNTIME_ADMISSION,
                    "execution": false,
                    "upstream": {
                        "url": entry.upstream_url,
                        "commit": entry.upstream_commit,
                        "skillPath": entry.upstream_skill_path,
                        "license": entry.license_spdx,
                    },
                    "name": entry.name,
                    "relativePath": entry.relative_path,
                    "bytes": entry.bytes,
                    "sha256": entry.sha256,
                    "content": entry.content,
                }))
            }
            CatalogState::Unavailable { code, detail } => Err(QueryError::Unavailable {
                code: code.clone(),
                detail: detail.clone(),
            }),
            CatalogState::Error { code, detail } => Err(QueryError::Error {
                code: code.clone(),
                detail: detail.clone(),
            }),
        }
    }
}

fn skill_metadata(entry: &SkillEntry) -> Value {
    json!({
        "name": entry.name,
        "upstreamSkillPath": entry.upstream_skill_path,
        "upstreamUrl": entry.upstream_url,
        "upstreamCommit": entry.upstream_commit,
        "license": entry.license_spdx,
        "relativePath": entry.relative_path,
        "bytes": entry.bytes,
        "sha256": entry.sha256,
        "execution": false,
        "runtimeAdmission": RUNTIME_ADMISSION,
    })
}

struct QueryParams {
    query: Option<String>,
    limit: usize,
    name: Option<String>,
}

#[derive(Clone, Copy)]
enum QueryMode {
    Discovery,
    Content,
}

fn parse_query(raw_query: &str, mode: QueryMode) -> Result<QueryParams, QueryError> {
    if raw_query.len() > MAX_QUERY_BYTES {
        return Err(QueryError::Invalid(
            "query exceeds the 2 KiB limit".to_string(),
        ));
    }
    let mut query = None;
    let mut limit = None;
    let mut name = None;
    if raw_query.is_empty() {
        return Ok(QueryParams {
            query,
            limit: DEFAULT_LIMIT,
            name,
        });
    }
    for pair in raw_query.split('&') {
        if pair.is_empty() {
            return Err(QueryError::Invalid(
                "query contains an empty parameter".to_string(),
            ));
        }
        let (raw_key, raw_value) = pair
            .split_once('=')
            .ok_or_else(|| QueryError::Invalid("query parameter must contain '='".to_string()))?;
        let key = decode_component(raw_key)?;
        let value = decode_component(raw_value)?;
        match key.as_str() {
            "query" | "q" if matches!(mode, QueryMode::Discovery) => {
                if query.is_some() || value.len() > MAX_SEARCH_BYTES {
                    return Err(QueryError::Invalid(
                        "query parameter is duplicated or too long".to_string(),
                    ));
                }
                reject_controls(&value)?;
                query = Some(value);
            }
            "limit" if matches!(mode, QueryMode::Discovery) => {
                if limit.is_some() {
                    return Err(QueryError::Invalid(
                        "limit parameter is duplicated".to_string(),
                    ));
                }
                let parsed = value.parse::<usize>().map_err(|_| {
                    QueryError::Invalid("limit must be a decimal integer".to_string())
                })?;
                if !(1..=MAX_LIMIT).contains(&parsed) {
                    return Err(QueryError::Invalid(
                        "limit must be between 1 and 100".to_string(),
                    ));
                }
                limit = Some(parsed);
            }
            "name" if matches!(mode, QueryMode::Content) => {
                if name.is_some() {
                    return Err(QueryError::Invalid(
                        "name parameter is duplicated".to_string(),
                    ));
                }
                validate_name(&value)?;
                name = Some(value);
            }
            _ => return Err(QueryError::Invalid("unknown query parameter".to_string())),
        }
    }
    Ok(QueryParams {
        query,
        limit: limit.unwrap_or(DEFAULT_LIMIT),
        name,
    })
}

fn decode_component(raw: &str) -> Result<String, QueryError> {
    let mut bytes = Vec::with_capacity(raw.len());
    let input = raw.as_bytes();
    let mut index = 0;
    while index < input.len() {
        match input[index] {
            b'+' => bytes.push(b' '),
            b'%' => {
                if index + 2 >= input.len() {
                    return Err(QueryError::Invalid(
                        "query contains an incomplete escape".to_string(),
                    ));
                }
                let high = hex(input[index + 1]).ok_or_else(|| {
                    QueryError::Invalid("query contains an invalid escape".to_string())
                })?;
                let low = hex(input[index + 2]).ok_or_else(|| {
                    QueryError::Invalid("query contains an invalid escape".to_string())
                })?;
                bytes.push((high << 4) | low);
                index += 2;
            }
            byte => bytes.push(byte),
        }
        index += 1;
    }
    String::from_utf8(bytes)
        .map_err(|_| QueryError::Invalid("query contains invalid UTF-8".to_string()))
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn reject_controls(value: &str) -> Result<(), QueryError> {
    if value.chars().any(|ch| ch.is_control()) {
        return Err(QueryError::Invalid(
            "query contains control characters".to_string(),
        ));
    }
    Ok(())
}

fn reject_text_controls(value: &str) -> Result<(), ()> {
    if value
        .chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(());
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), QueryError> {
    if name.is_empty() || name.len() > MAX_NAME_BYTES || !name.starts_with("kdense-") {
        return Err(QueryError::Invalid("skill name is malformed".to_string()));
    }
    if !name
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(QueryError::Invalid("skill name is malformed".to_string()));
    }
    Ok(())
}

fn load_snapshot(root_raw: &str, manifest_raw: &str) -> Result<CatalogSnapshot, String> {
    let root = canonical_dir(root_raw)?;
    let manifest_path = configured_file(manifest_raw)?;
    let manifest_bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES)?;
    let manifest_text = std::str::from_utf8(&manifest_bytes)
        .map_err(|_| "skill manifest must be valid UTF-8".to_string())?;
    let document: Value = serde_json::from_str(manifest_text)
        .map_err(|_| "skill manifest must be valid JSON".to_string())?;

    let schema = required_string(&document, "schema")?;
    if schema != EXPECTED_SCHEMA_V1 && schema != EXPECTED_SCHEMA_V3 {
        return Err("skill manifest schema is unsupported".to_string());
    }
    let upstream = document
        .get("upstream")
        .ok_or_else(|| "skill manifest upstream metadata is missing".to_string())?;
    let upstream_url = required_string(upstream, "url")?;
    if upstream_url != EXPECTED_URL {
        return Err("skill manifest upstream URL is not pinned".to_string());
    }
    let upstream_commit = required_string(upstream, "commit")?;
    if upstream_commit != EXPECTED_COMMIT || upstream_commit.len() != 40 {
        return Err("skill manifest upstream commit is not pinned".to_string());
    }
    let license_spdx = if let Some(value) = upstream.get("license").and_then(Value::as_str) {
        value.to_string()
    } else {
        required_string(
            upstream
                .get("license")
                .ok_or_else(|| "skill manifest license metadata is missing".to_string())?,
            "spdx",
        )?
    };
    if license_spdx != "MIT" {
        return Err("skill manifest license is unsupported".to_string());
    }
    let normalization = document
        .get("normalization")
        .ok_or_else(|| "skill manifest normalization metadata is missing".to_string())?;
    if required_string(normalization, "encoding")? != "UTF-8"
        || required_string(normalization, "line_endings")? != "LF"
    {
        return Err("skill manifest normalization is unsupported".to_string());
    }
    let admission = document
        .get("admission")
        .and_then(Value::as_str)
        .ok_or_else(|| "skill manifest admission is missing".to_string())?;
    if admission != "research_projection_only" {
        return Err("skill manifest admission is unsupported".to_string());
    }
    let runtime_not_admitted = document
        .get("runtime_admission")
        .and_then(Value::as_str)
        .map(|value| value == RUNTIME_ADMISSION)
        .or_else(|| {
            document
                .get("policy")
                .and_then(|policy| policy.get("production_runtime_admission"))
                .and_then(Value::as_bool)
                .map(|value| !value)
        })
        .unwrap_or(false);
    if !runtime_not_admitted {
        return Err("skill manifest runtime admission is unsupported".to_string());
    }

    let skills = document
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| "skill manifest skills list is missing".to_string())?;
    if skills.is_empty() || skills.len() > MAX_ENTRIES {
        return Err("skill manifest skills list is outside bounds".to_string());
    }
    let mut entries = BTreeMap::new();
    let mut total_bytes = 0_u64;
    let mut seen = HashSet::new();
    for skill in skills {
        let name = required_string(skill, "name")?;
        validate_name(&name).map_err(|_| "skill manifest contains an invalid name".to_string())?;
        if !seen.insert(name.clone()) {
            return Err("skill manifest contains duplicate names".to_string());
        }
        let projected_name = skill
            .get("projected_name")
            .and_then(Value::as_str)
            .unwrap_or(&name);
        if projected_name != name {
            return Err("skill manifest projected name does not match name".to_string());
        }
        let entry_commit = skill
            .get("upstream_commit")
            .and_then(Value::as_str)
            .unwrap_or(&upstream_commit);
        if entry_commit != upstream_commit {
            return Err("skill manifest entry commit is not pinned".to_string());
        }
        let upstream_skill_path = required_string(skill, "upstream_skill_path")?;
        if !is_safe_upstream_path(&upstream_skill_path) {
            return Err("skill manifest upstream path is unsafe".to_string());
        }
        let relative_path = format!("{name}/SKILL.md");
        let entry_root = safe_child_dir(&root, name.as_str())?;
        let skill_path = safe_child_file(&entry_root, "SKILL.md")?;
        let license_path = safe_child_file(&entry_root, "LICENSE.md")?;
        let skill_bytes = read_bounded(&skill_path, MAX_SKILL_BYTES)?;
        let content = std::str::from_utf8(&skill_bytes)
            .map_err(|_| "projected skill is not valid UTF-8".to_string())?;
        if content.as_bytes().contains(&b'\r') {
            return Err("projected skill must use LF line endings".to_string());
        }
        reject_text_controls(content)
            .map_err(|_| "projected skill contains control data".to_string())?;
        let sha256 = sha256_hex(&skill_bytes);
        validate_file_declaration(skill, &relative_path, skill_bytes.len(), &sha256)?;
        let license_bytes = read_bounded(&license_path, MAX_SKILL_BYTES)?;
        let (expected_license_sha, expected_license_bytes) = license_expectation(upstream)?;
        if license_bytes.len() != expected_license_bytes
            || sha256_hex(&license_bytes) != expected_license_sha
        {
            return Err("projected license does not match the pinned MIT license".to_string());
        }
        total_bytes = total_bytes
            .checked_add(skill_bytes.len() as u64)
            .ok_or_else(|| "projected skill size overflow".to_string())?;
        if total_bytes > MAX_TOTAL_SKILL_BYTES {
            return Err("projected skill catalog exceeds the size limit".to_string());
        }
        entries.insert(
            name.clone(),
            SkillEntry {
                name,
                upstream_skill_path,
                upstream_url: upstream_url.clone(),
                upstream_commit: upstream_commit.clone(),
                license_spdx: license_spdx.clone(),
                relative_path,
                bytes: skill_bytes.len(),
                sha256,
                content: content.to_string(),
            },
        );
    }
    Ok(CatalogSnapshot {
        upstream_url,
        upstream_commit,
        license_spdx,
        entries,
    })
}

fn required_string(object: &Value, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("skill manifest field {key} is missing"))
}

fn license_expectation(upstream: &Value) -> Result<(String, usize), String> {
    let license = upstream
        .get("license")
        .ok_or_else(|| "skill manifest license metadata is missing".to_string())?;
    let (sha, bytes) = if let Some(sha) = license.get("sha256").and_then(Value::as_str) {
        let bytes = license
            .get("bytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| "skill manifest license bytes are missing".to_string())?;
        (
            sha.to_ascii_lowercase(),
            usize::try_from(bytes).map_err(|_| "license bytes are outside bounds".to_string())?,
        )
    } else if let Some(sha) = license
        .get("canonical_git_blob_sha256")
        .and_then(Value::as_str)
    {
        let bytes = license
            .get("canonical_git_blob_bytes")
            .and_then(Value::as_u64)
            .ok_or_else(|| "skill manifest license bytes are missing".to_string())?;
        (
            sha.to_ascii_lowercase(),
            usize::try_from(bytes).map_err(|_| "license bytes are outside bounds".to_string())?,
        )
    } else {
        return Err("skill manifest license hash is missing".to_string());
    };
    if sha != EXPECTED_LICENSE_SHA256 || bytes != EXPECTED_LICENSE_BYTES {
        return Err("skill manifest license is not pinned to the upstream MIT file".to_string());
    }
    Ok((sha, bytes))
}

fn validate_file_declaration(
    skill: &Value,
    expected_path: &str,
    expected_bytes: usize,
    expected_sha256: &str,
) -> Result<(), String> {
    let declaration = skill.get("skill_file");
    let declaration =
        declaration.ok_or_else(|| "skill manifest SKILL.md declaration is missing".to_string())?;
    let relative_path = declaration
        .get("relative_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "skill manifest SKILL.md path is missing".to_string())?;
    let bytes = declaration
        .get("bytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| "skill manifest SKILL.md bytes are missing".to_string())?;
    let sha = declaration
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "skill manifest SKILL.md hash is missing".to_string())?;
    if relative_path != expected_path
        || usize::try_from(bytes).ok() != Some(expected_bytes)
        || sha.len() != 64
        || !sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !sha.eq_ignore_ascii_case(expected_sha256)
    {
        return Err("projected SKILL.md does not match the manifest hash".to_string());
    }
    Ok(())
}

fn is_safe_upstream_path(path: &str) -> bool {
    !path.is_empty()
        && path.starts_with("skills/")
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\\'))
}

fn canonical_dir(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("skill root must be an absolute directory".to_string());
    }
    ensure_no_reparse_path(path)?;
    let canonical = fs::canonicalize(path).map_err(|_| "skill root is unavailable".to_string())?;
    if !canonical.is_dir() {
        return Err("skill root is not a directory".to_string());
    }
    ensure_no_reparse_path(&canonical)?;
    Ok(canonical)
}

fn configured_file(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("skill manifest must be an absolute file".to_string());
    }
    ensure_no_reparse_path(path)?;
    let canonical =
        fs::canonicalize(path).map_err(|_| "skill manifest is unavailable".to_string())?;
    if !canonical.is_file() {
        return Err("skill manifest is not a file".to_string());
    }
    ensure_no_reparse_path(&canonical)?;
    Ok(canonical)
}

fn safe_child_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_name(name).map_err(|_| "skill path is unsafe".to_string())?;
    let path = root.join(name);
    ensure_no_reparse_components(root, &path)?;
    let canonical = fs::canonicalize(&path)
        .map_err(|_| "projected skill directory is unavailable".to_string())?;
    if !canonical.starts_with(root) || !canonical.is_dir() {
        return Err("projected skill directory escapes the configured root".to_string());
    }
    Ok(canonical)
}

fn safe_child_file(parent: &Path, file_name: &str) -> Result<PathBuf, String> {
    let path = parent.join(file_name);
    ensure_no_reparse_components(parent, &path)?;
    let canonical =
        fs::canonicalize(&path).map_err(|_| "projected skill file is unavailable".to_string())?;
    if !canonical.starts_with(parent) || !canonical.is_file() {
        return Err("projected skill file escapes the configured root".to_string());
    }
    Ok(canonical)
}

fn ensure_no_reparse_components(root: &Path, candidate: &Path) -> Result<(), String> {
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| "skill path escapes the configured root".to_string())?;
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("skill path contains traversal".to_string());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "projected skill path is unavailable".to_string())?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err("projected skill path contains a reparse point".to_string());
        }
    }
    Ok(())
}

fn ensure_no_reparse_path(path: &Path) -> Result<(), String> {
    let mut ancestors = path.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for current in ancestors {
        let metadata = fs::symlink_metadata(current)
            .map_err(|_| "configured skill path is unavailable".to_string())?;
        if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err("configured skill path contains a reparse point".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "configured skill file is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err("configured skill file exceeds its size limit".to_string());
    }
    let file = File::open(path).map_err(|_| "configured skill file is unreadable".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "configured skill file is unreadable".to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("configured skill file exceeds its size limit".to_string());
    }
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (PathBuf, PathBuf, String) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("omnia-skills-{unique}"));
        let skill_dir = root.join("kdense-test");
        fs::create_dir_all(&skill_dir).expect("fixture root");
        let content = "# Test skill\n\nLine one.\n";
        fs::write(skill_dir.join("SKILL.md"), content).expect("skill");
        let license =
            include_bytes!("../../../.agents/skills/kdense-citation-management/LICENSE.md");
        fs::write(skill_dir.join("LICENSE.md"), license).expect("license");
        let license_sha = sha256_hex(license);
        let skill_sha = sha256_hex(content.as_bytes());
        let manifest = json!({
            "schema": EXPECTED_SCHEMA_V1,
            "upstream": {
                "url": EXPECTED_URL,
                "commit": EXPECTED_COMMIT,
                "license": {"spdx":"MIT","file":"LICENSE.md","sha256":license_sha,"bytes":license.len()}
            },
            "normalization": {"encoding":"UTF-8","line_endings":"LF"},
            "admission":"research_projection_only",
            "runtime_admission":RUNTIME_ADMISSION,
            "skills":[{
                "name":"kdense-test",
                "projected_name":"kdense-test",
                "upstream_skill_path":"skills/test",
                "skill_file":{"relative_path":"kdense-test/SKILL.md","bytes":content.len(),"sha256":skill_sha}
            }]
        });
        let manifest_path = root.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&manifest).expect("manifest"),
        )
        .expect("manifest file");
        (root, manifest_path, content.to_string())
    }

    #[test]
    fn loads_pinned_catalog_and_serves_deterministic_content() {
        let (root, manifest, content) = fixture();
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(catalog.is_ready());
        let discovery = catalog
            .discovery("query=kdense&limit=1")
            .expect("discovery");
        assert_eq!(discovery["count"], 1);
        let served = catalog.content("name=kdense-test").expect("content");
        assert_eq!(served["content"], content);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_malformed_query_and_duplicate_names() {
        assert!(parse_query("limit=0", QueryMode::Discovery).is_err());
        assert!(parse_query("query=%FF", QueryMode::Discovery).is_err());
        assert!(parse_query("query=a&query=b", QueryMode::Discovery).is_err());
        assert!(parse_query("name=kdense-test", QueryMode::Discovery).is_err());
        assert!(parse_query("query=kdense-test", QueryMode::Content).is_err());
        let (root, manifest, _) = fixture();
        let mut value: Value =
            serde_json::from_slice(&fs::read(&manifest).expect("manifest")).expect("json");
        value["skills"][0]["name"] = json!("kdense-test");
        let duplicate = value["skills"][0].clone();
        value["skills"]
            .as_array_mut()
            .expect("skills")
            .push(duplicate);
        fs::write(&manifest, serde_json::to_vec(&value).expect("manifest")).expect("write");
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(!catalog.is_ready());
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn rewrite_manifest(manifest: &Path, mutate: impl FnOnce(&mut Value)) {
        let mut value: Value =
            serde_json::from_slice(&fs::read(manifest).expect("manifest")).expect("json");
        mutate(&mut value);
        fs::write(manifest, serde_json::to_vec(&value).expect("manifest")).expect("write");
    }

    #[test]
    fn rejects_missing_and_mismatched_skill_file_declarations() {
        let cases = [
            "missing",
            "relative_path",
            "bytes",
            "sha256",
            "malformed_sha256",
        ];
        for case in cases {
            let (root, manifest, _) = fixture();
            rewrite_manifest(&manifest, |value| {
                let skill = &mut value["skills"][0];
                match case {
                    "missing" => {
                        skill
                            .as_object_mut()
                            .expect("skill object")
                            .remove("skill_file");
                    }
                    "relative_path" => {
                        skill["skill_file"]["relative_path"] = json!("other/SKILL.md");
                    }
                    "bytes" => {
                        skill["skill_file"]["bytes"] = json!(0);
                    }
                    "sha256" => {
                        skill["skill_file"]["sha256"] = json!("0".repeat(64));
                    }
                    "malformed_sha256" => {
                        skill["skill_file"]["sha256"] = json!("not-a-sha");
                    }
                    _ => unreachable!(),
                }
            });
            let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
            assert!(
                !catalog.is_ready(),
                "case {case} must not admit an invalid file declaration"
            );
            fs::remove_dir_all(root).expect("cleanup");
        }
    }

    #[test]
    fn rejects_license_pin_and_projected_license_mismatch() {
        let (root, manifest, _) = fixture();
        rewrite_manifest(&manifest, |value| {
            value["upstream"]["license"]["sha256"] = json!("0".repeat(64));
        });
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(!catalog.is_ready());
        fs::remove_dir_all(root).expect("cleanup");

        let (root, manifest, _) = fixture();
        fs::write(root.join("kdense-test").join("LICENSE.md"), b"MIT\n").expect("license");
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(!catalog.is_ready());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn rejects_crlf_and_control_data_but_accepts_lf_and_tab() {
        let (root, manifest, _) = fixture();
        fs::write(
            root.join("kdense-test").join("SKILL.md"),
            b"# Test skill\r\n",
        )
        .expect("skill");
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(!catalog.is_ready());
        fs::remove_dir_all(root).expect("cleanup");

        let (root, manifest, _) = fixture();
        fs::write(
            root.join("kdense-test").join("SKILL.md"),
            b"# Test skill\n\x01",
        )
        .expect("skill");
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(!catalog.is_ready());
        fs::remove_dir_all(root).expect("cleanup");

        let (root, manifest, _) = fixture();
        let content = "# Test skill\n\tIndented.\n";
        fs::write(root.join("kdense-test").join("SKILL.md"), content).expect("skill");
        rewrite_manifest(&manifest, |value| {
            value["skills"][0]["skill_file"]["bytes"] = json!(content.len());
            value["skills"][0]["skill_file"]["sha256"] = json!(sha256_hex(content.as_bytes()));
        });
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        assert!(catalog.is_ready());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn query_contract_rejects_cross_endpoint_and_bad_values() {
        let discovery = parse_query("q=kdense-test&limit=1", QueryMode::Discovery)
            .expect("q alias should be accepted");
        assert_eq!(discovery.query.as_deref(), Some("kdense-test"));
        assert_eq!(discovery.limit, 1);

        for raw in [
            "query=a&q=b",
            "q=a&query=b",
            "limit=101",
            "limit=abc",
            "name=kdense-test",
            "unknown=value",
            "query=%",
            "query=%0A",
            "query=%FF",
            "query=a&",
        ] {
            assert!(
                parse_query(raw, QueryMode::Discovery).is_err(),
                "discovery query {raw:?} must be rejected"
            );
        }
        for raw in [
            "query=kdense-test",
            "q=kdense-test",
            "limit=1",
            "name=kdense-test&name=other",
            "name=other",
            "name=kdense_test",
            "name=%FF",
            "unknown=value",
        ] {
            assert!(
                parse_query(raw, QueryMode::Content).is_err(),
                "content query {raw:?} must be rejected"
            );
        }
    }

    #[test]
    fn cloned_ready_catalogs_share_the_immutable_snapshot() {
        let (root, manifest, _) = fixture();
        let catalog = SkillCatalog::load(root.to_str(), manifest.to_str());
        let clone = catalog.clone();
        let (CatalogState::Ready(left), CatalogState::Ready(right)) =
            (&catalog.state, &clone.state)
        else {
            panic!("fixture must produce a ready catalog");
        };
        assert!(Arc::ptr_eq(left, right));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
