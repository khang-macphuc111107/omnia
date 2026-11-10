//! artifact: rich, versioned documents the agent shows in the side panel.
//!
//! Layout: `<cwd>/.omnia/artifacts/<id>/meta.json` plus one `v<N>.<ext>` file
//! per retained version (the last [`MAX_VERSIONS`]). The store functions are
//! also used by the desktop host to list, read and export artifacts.
//!
//! Effect class: `PureCompute`, the same as `todo_write`. The tool only writes
//! inside a harness-owned directory that no other tool treats as project
//! source, content is capped, and nothing is executed or fetched; the content
//! is only ever *rendered* by the renderer in a sandbox. Gating it behind
//! `WriteWorkspace` would prompt on every document draft in ask-writes mode
//! and block it in plan mode, where drafting a plan document is the point.
//! Concurrent calls (read-only tools run in parallel) are serialized by a
//! process-wide lock.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{finish, parse_input};
use crate::agent::AgentEvent;
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

/// Retained versions per artifact.
pub const MAX_VERSIONS: usize = 20;
/// Largest accepted content of one version.
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
/// Artifacts per session.
pub const MAX_ARTIFACTS_PER_SESSION: usize = 100;
const MAX_ID_LEN: usize = 48;
const MAX_TITLE_CHARS: usize = 120;
const MAX_LANGUAGE_CHARS: usize = 32;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Html,
    Markdown,
    Svg,
    Mermaid,
    Code,
    Csv,
}

impl ArtifactKind {
    fn ext(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Markdown => "md",
            Self::Svg => "svg",
            Self::Mermaid => "mmd",
            Self::Code => "txt",
            Self::Csv => "csv",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMeta {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub kind: ArtifactKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Newest version number.
    pub version: u32,
    /// Retained version numbers, ascending.
    pub versions: Vec<u32>,
    pub created_ms: u64,
    pub updated_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub meta: ArtifactMeta,
    pub version: u32,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct ArtifactInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub kind: Option<ArtifactKind>,
    pub language: Option<String>,
    pub content: String,
}

pub fn artifacts_root(cwd: &Path) -> PathBuf {
    cwd.join(".omnia").join("artifacts")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(format!(
            "invalid artifact id `{id}`: use 1-{MAX_ID_LEN} characters from a-z, 0-9 and `-`"
        ))
    }
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn slugify(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    let out: String = out.chars().take(32).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "artifact".into()
    } else {
        out
    }
}

fn clean_title(title: &str) -> String {
    let one_line = title.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(MAX_TITLE_CHARS).collect()
}

/// Directory of artifact `id`; rejects ids that are not plain slugs and
/// refuses to follow a symlinked artifact directory.
fn artifact_dir(cwd: &Path, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(artifacts_root(cwd).join(id))
}

/// meta.json is plain data on disk and may have been edited by anything with
/// workspace access, so it is never trusted: its `id` must equal the directory
/// it was read from (and be a plain slug), and the text fields must be sane.
/// Callers (export file names, preview targets) can then rely on `meta.id`.
fn validate_meta(dir: &Path, meta: &ArtifactMeta) -> Result<(), String> {
    let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !valid_id(&meta.id) || meta.id != dir_name {
        return Err("corrupt artifact metadata: id does not match its directory".into());
    }
    if meta.title.chars().count() > MAX_TITLE_CHARS || meta.title.chars().any(char::is_control) {
        return Err("corrupt artifact metadata: invalid title".into());
    }
    if let Some(language) = &meta.language {
        check_language(language)
            .map_err(|_| "corrupt artifact metadata: invalid language".to_string())?;
    }
    if meta.versions.len() > MAX_VERSIONS
        || meta.versions.iter().any(|v| *v == 0 || *v > meta.version)
    {
        return Err("corrupt artifact metadata: invalid versions".into());
    }
    Ok(())
}

fn check_language(language: &str) -> Result<(), String> {
    if language.chars().count() <= MAX_LANGUAGE_CHARS && !language.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(format!(
            "`language` must be at most {MAX_LANGUAGE_CHARS} characters without control characters"
        ))
    }
}

fn read_meta(dir: &Path) -> Result<Option<ArtifactMeta>, String> {
    match fs::symlink_metadata(dir) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            return Err("artifact path is not a plain directory".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read artifact: {e}")),
    }
    match fs::read(dir.join("meta.json")) {
        Ok(bytes) => {
            let meta: ArtifactMeta = serde_json::from_slice(&bytes)
                .map_err(|e| format!("corrupt artifact metadata: {e}"))?;
            validate_meta(dir, &meta)?;
            Ok(Some(meta))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read artifact metadata: {e}")),
    }
}

fn write_meta(dir: &Path, meta: &ArtifactMeta) -> Result<(), String> {
    let tmp = dir.join("meta.json.tmp");
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| format!("cannot write artifact metadata: {e}"))?;
    fs::rename(&tmp, dir.join("meta.json"))
        .map_err(|e| format!("cannot save artifact metadata: {e}"))
}

fn version_file(dir: &Path, kind: ArtifactKind, version: u32) -> PathBuf {
    dir.join(format!("v{version}.{}", kind.ext()))
}

/// Metadata of `id` if it exists and belongs to `session_id`.
fn owned_meta(cwd: &Path, session_id: &str, id: &str) -> Result<(PathBuf, ArtifactMeta), String> {
    let dir = artifact_dir(cwd, id)?;
    match read_meta(&dir)? {
        Some(meta) if meta.session_id == session_id => Ok((dir, meta)),
        Some(_) => Err(format!("artifact `{id}` belongs to another session")),
        None => Err(format!("artifact `{id}` not found")),
    }
}

fn check_content(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("`content` must not be empty".into());
    }
    if content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "`content` is {} bytes; the limit is {MAX_CONTENT_BYTES}",
            content.len()
        ));
    }
    Ok(())
}

fn push_version(dir: &Path, meta: &mut ArtifactMeta, content: &str) -> Result<(), String> {
    let next = meta.version + 1;
    fs::write(version_file(dir, meta.kind, next), content)
        .map_err(|e| format!("cannot write artifact: {e}"))?;
    meta.version = next;
    meta.versions.push(next);
    while meta.versions.len() > MAX_VERSIONS {
        let old = meta.versions.remove(0);
        let _ = fs::remove_file(version_file(dir, meta.kind, old));
    }
    meta.updated_ms = now_ms();
    write_meta(dir, meta)
}

/// Creates artifact `input.id` (or a generated id) as version 1.
pub fn create(cwd: &Path, session_id: &str, input: ArtifactInput) -> Result<ArtifactMeta, String> {
    let _guard = lock();
    let kind = input
        .kind
        .ok_or("`kind` is required to create an artifact")?;
    let title = clean_title(input.title.as_deref().unwrap_or(""));
    if title.is_empty() {
        return Err("`title` is required to create an artifact".into());
    }
    check_content(&input.content)?;
    if let Some(language) = &input.language {
        check_language(language)?;
    }
    let existing = list_unlocked(cwd, session_id);
    if existing.len() >= MAX_ARTIFACTS_PER_SESSION {
        return Err(format!(
            "this session already has {MAX_ARTIFACTS_PER_SESSION} artifacts; delete some first"
        ));
    }
    let id = match input.id {
        Some(id) => {
            check_id(&id)?;
            if read_meta(&artifact_dir(cwd, &id)?)?.is_some() {
                return Err(format!(
                    "artifact `{id}` already exists; use action `update` to add a version"
                ));
            }
            id
        }
        None => {
            let base = slugify(&title);
            let mut candidate = base.clone();
            let mut n = 2;
            while artifact_dir(cwd, &candidate)?.exists() {
                candidate = format!("{base}-{n}");
                n += 1;
            }
            candidate
        }
    };
    let dir = artifact_dir(cwd, &id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create artifact dir: {e}"))?;
    let now = now_ms();
    let mut meta = ArtifactMeta {
        id,
        session_id: session_id.to_string(),
        title,
        kind,
        language: input.language.filter(|l| !l.trim().is_empty()),
        version: 0,
        versions: Vec::new(),
        created_ms: now,
        updated_ms: now,
    };
    if let Err(e) = push_version(&dir, &mut meta, &input.content) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(meta)
}

/// Adds a new version of an existing artifact owned by `session_id`.
pub fn update(cwd: &Path, session_id: &str, input: ArtifactInput) -> Result<ArtifactMeta, String> {
    let _guard = lock();
    let id = input.id.ok_or("`id` is required to update an artifact")?;
    let (dir, mut meta) = owned_meta(cwd, session_id, &id)?;
    check_content(&input.content)?;
    if let Some(kind) = input.kind {
        if kind != meta.kind {
            return Err(format!(
                "artifact `{id}` is {:?}; its kind cannot change (create a new artifact instead)",
                meta.kind
            ));
        }
    }
    if let Some(title) = input
        .title
        .as_deref()
        .map(clean_title)
        .filter(|t| !t.is_empty())
    {
        meta.title = title;
    }
    if let Some(language) = input.language.filter(|l| !l.trim().is_empty()) {
        check_language(&language)?;
        meta.language = Some(language);
    }
    push_version(&dir, &mut meta, &input.content)?;
    Ok(meta)
}

/// Removes an artifact and all its versions.
pub fn delete(cwd: &Path, session_id: &str, id: &str) -> Result<ArtifactMeta, String> {
    let _guard = lock();
    let (dir, meta) = owned_meta(cwd, session_id, id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("cannot delete artifact: {e}"))?;
    Ok(meta)
}

fn list_unlocked(cwd: &Path, session_id: &str) -> Vec<ArtifactMeta> {
    let Ok(entries) = fs::read_dir(artifacts_root(cwd)) else {
        return Vec::new();
    };
    let mut out: Vec<ArtifactMeta> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_meta(&entry.path()).ok().flatten())
        .filter(|meta| meta.session_id == session_id)
        .collect();
    out.sort_by(|a, b| {
        b.updated_ms
            .cmp(&a.updated_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// Artifacts of a session, most recently updated first.
pub fn list(cwd: &Path, session_id: &str) -> Vec<ArtifactMeta> {
    let _guard = lock();
    list_unlocked(cwd, session_id)
}

/// Content of `version` (default: newest) of an artifact owned by `session_id`.
pub fn read(
    cwd: &Path,
    session_id: &str,
    id: &str,
    version: Option<u32>,
) -> Result<ArtifactContent, String> {
    let _guard = lock();
    let (dir, meta) = owned_meta(cwd, session_id, id)?;
    let version = version.unwrap_or(meta.version);
    if !meta.versions.contains(&version) {
        return Err(format!(
            "artifact `{id}` has no version {version} (retained: {:?})",
            meta.versions
        ));
    }
    let content = fs::read_to_string(version_file(&dir, meta.kind, version))
        .map_err(|e| format!("cannot read artifact version: {e}"))?;
    Ok(ArtifactContent {
        meta,
        version,
        content,
    })
}

/// Event for a successful `artifact` tool result, parsed from its JSON text.
pub fn event_from_output(output: &ToolOutput) -> Option<AgentEvent> {
    if output.is_error {
        return None;
    }
    let crate::Block::Text { text } = output.content.first()? else {
        return None;
    };
    let value: Value = serde_json::from_str(text).ok()?;
    Some(AgentEvent::Artifact {
        id: value.get("id")?.as_str()?.to_string(),
        version: u32::try_from(value.get("version")?.as_u64()?).ok()?,
        title: value.get("title")?.as_str()?.to_string(),
        kind: value.get("kind")?.as_str()?.to_string(),
        action: value.get("action")?.as_str()?.to_string(),
    })
}

pub struct ArtifactTool;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    action: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    kind: Option<ArtifactKind>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

fn result_json(action: &str, meta: &ArtifactMeta) -> ToolOutput {
    ToolOutput::text(
        json!({
            "ok": true,
            "action": action,
            "id": meta.id,
            "version": if action == "delete" { 0 } else { meta.version },
            "title": meta.title,
            "kind": meta.kind,
        })
        .to_string(),
    )
}

#[async_trait]
impl Tool for ArtifactTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "artifact".into(),
            description: format!(
                "Show a rich document in the user's Artifacts side panel instead of pasting it into \
chat. Use it for substantial, self-contained output the user will keep, copy or iterate on: a web page \
or small app (`html`, one file with inline CSS/JS, no external network), an image (`svg`), a document \
(`markdown`), a diagram (`mermaid`), a program or config (`code`, set `language`) or a table (`csv`). \
`create` makes version 1 (omit `id` to get one from the title); `update` replaces the content with a new \
version (send the COMPLETE new content, the last {MAX_VERSIONS} versions are kept); `delete` removes it. \
Content is limited to {} KiB. HTML runs in a sandbox with no network access.",
                MAX_CONTENT_BYTES / 1024
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["create", "update", "delete"]},
                    "id": {"type": "string", "description": "Artifact id (a-z, 0-9, `-`). Required for update and delete; optional for create."},
                    "title": {"type": "string", "description": "Short title. Required for create."},
                    "kind": {"type": "string", "enum": ["html", "markdown", "svg", "mermaid", "code", "csv"], "description": "Required for create; cannot change on update."},
                    "language": {"type": "string", "description": "Language name for `code` artifacts, e.g. python."},
                    "content": {"type": "string", "description": "Complete content. Required for create and update."}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::PureCompute
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "{} artifact {}",
            input["action"].as_str().unwrap_or("?"),
            input["title"]
                .as_str()
                .or_else(|| input["id"].as_str())
                .unwrap_or("")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: Args = parse_input(input)?;
            let artifact_input = |content: Option<String>| ArtifactInput {
                id: args.id.clone(),
                title: args.title.clone(),
                kind: args.kind,
                language: args.language.clone(),
                content: content.unwrap_or_default(),
            };
            match args.action.as_str() {
                "create" => create(
                    &ctx.cwd,
                    &ctx.session_id,
                    artifact_input(args.content.clone()),
                )
                .map(|m| result_json("create", &m)),
                "update" => update(
                    &ctx.cwd,
                    &ctx.session_id,
                    artifact_input(args.content.clone()),
                )
                .map(|m| result_json("update", &m)),
                "delete" => {
                    let id = args
                        .id
                        .as_deref()
                        .ok_or("`id` is required to delete an artifact")?;
                    delete(&ctx.cwd, &ctx.session_id, id).map(|m| result_json("delete", &m))
                }
                other => Err(format!(
                    "unknown action `{other}`: use create, update or delete"
                )),
            }
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: ArtifactKind, content: &str) -> ArtifactInput {
        ArtifactInput {
            title: Some("My  Page".into()),
            kind: Some(kind),
            content: content.into(),
            ..Default::default()
        }
    }

    #[test]
    fn create_update_read_list_delete() {
        let cwd = tempfile::tempdir().unwrap();
        let m = create(cwd.path(), "s1", input(ArtifactKind::Html, "<p>1</p>")).unwrap();
        assert_eq!((m.id.as_str(), m.version), ("my-page", 1));
        assert_eq!(m.title, "My Page");
        // Generated ids do not collide.
        let m2 = create(cwd.path(), "s1", input(ArtifactKind::Markdown, "# hi")).unwrap();
        assert_eq!(m2.id, "my-page-2");

        let up = ArtifactInput {
            id: Some("my-page".into()),
            content: "<p>2</p>".into(),
            ..Default::default()
        };
        let m = update(cwd.path(), "s1", up).unwrap();
        assert_eq!((m.version, m.versions.clone()), (2, vec![1, 2]));
        assert_eq!(
            read(cwd.path(), "s1", "my-page", None).unwrap().content,
            "<p>2</p>"
        );
        assert_eq!(
            read(cwd.path(), "s1", "my-page", Some(1)).unwrap().content,
            "<p>1</p>"
        );
        assert!(read(cwd.path(), "s1", "my-page", Some(9)).is_err());

        let ids: Vec<_> = list(cwd.path(), "s1").into_iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(list(cwd.path(), "other").is_empty());
        assert!(read(cwd.path(), "other", "my-page", None).is_err());
        assert!(delete(cwd.path(), "other", "my-page").is_err());

        delete(cwd.path(), "s1", "my-page").unwrap();
        assert!(read(cwd.path(), "s1", "my-page", None).is_err());
        assert!(!artifacts_root(cwd.path()).join("my-page").exists());
    }

    #[test]
    fn keeps_only_last_versions() {
        let cwd = tempfile::tempdir().unwrap();
        let m = create(cwd.path(), "s", input(ArtifactKind::Code, "0")).unwrap();
        for n in 1..=MAX_VERSIONS + 4 {
            let up = ArtifactInput {
                id: Some(m.id.clone()),
                content: n.to_string(),
                ..Default::default()
            };
            update(cwd.path(), "s", up).unwrap();
        }
        let got = read(cwd.path(), "s", &m.id, None).unwrap();
        assert_eq!(got.version as usize, MAX_VERSIONS + 5);
        assert_eq!(got.meta.versions.len(), MAX_VERSIONS);
        assert_eq!(got.meta.versions[0] as usize, 6);
        assert!(read(cwd.path(), "s", &m.id, Some(1)).is_err());
        assert!(!artifacts_root(cwd.path())
            .join(&m.id)
            .join("v1.txt")
            .exists());
        assert_eq!(read(cwd.path(), "s", &m.id, Some(6)).unwrap().content, "5");
    }

    #[test]
    fn rejects_bad_ids_and_traversal() {
        let cwd = tempfile::tempdir().unwrap();
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "a\\b",
            "A",
            "-x",
            "x y",
            "é",
            &"a".repeat(49),
        ] {
            let mut i = input(ArtifactKind::Html, "x");
            i.id = Some(bad.into());
            assert!(create(cwd.path(), "s", i).is_err(), "create {bad:?}");
            assert!(read(cwd.path(), "s", bad, None).is_err(), "read {bad:?}");
            assert!(delete(cwd.path(), "s", bad).is_err(), "delete {bad:?}");
        }
        assert!(!cwd.path().join(".omnia").exists() || list(cwd.path(), "s").is_empty());
    }

    #[test]
    fn validates_input() {
        let cwd = tempfile::tempdir().unwrap();
        assert!(create(cwd.path(), "s", input(ArtifactKind::Html, "")).is_err());
        let big = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert!(create(cwd.path(), "s", input(ArtifactKind::Html, &big)).is_err());
        let mut no_title = input(ArtifactKind::Html, "x");
        no_title.title = Some("  ".into());
        assert!(create(cwd.path(), "s", no_title).is_err());
        let mut no_kind = input(ArtifactKind::Html, "x");
        no_kind.kind = None;
        assert!(create(cwd.path(), "s", no_kind).is_err());
        let m = create(cwd.path(), "s", input(ArtifactKind::Html, "x")).unwrap();
        let mut dup = input(ArtifactKind::Html, "y");
        dup.id = Some(m.id.clone());
        assert!(create(cwd.path(), "s", dup)
            .unwrap_err()
            .contains("already exists"));
        let change_kind = ArtifactInput {
            id: Some(m.id),
            kind: Some(ArtifactKind::Svg),
            content: "y".into(),
            ..Default::default()
        };
        assert!(update(cwd.path(), "s", change_kind).is_err());
    }

    #[tokio::test]
    async fn tool_round_trip_and_event() {
        let cwd = tempfile::tempdir().unwrap();
        let mut ctx = ToolContext::new(cwd.path());
        ctx.session_id = "sess".into();
        let tool = ArtifactTool;
        assert_eq!(tool.effect(), EffectClass::PureCompute);
        let out = tool
            .call(
                &ctx,
                json!({"action":"create","id":"demo","title":"Demo","kind":"svg","content":"<svg/>"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error);
        match event_from_output(&out).unwrap() {
            AgentEvent::Artifact {
                id,
                version,
                kind,
                action,
                ..
            } => {
                assert_eq!(
                    (id.as_str(), version, kind.as_str(), action.as_str()),
                    ("demo", 1, "svg", "create")
                );
            }
            other => panic!("{other:?}"),
        }
        let out = tool
            .call(
                &ctx,
                json!({"action":"update","id":"demo","content":"<svg>2</svg>"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error);
        let out = tool
            .call(&ctx, json!({"action":"update","id":"nope","content":"x"}))
            .await
            .unwrap();
        assert!(out.is_error);
        assert!(event_from_output(&out).is_none());
        let out = tool.call(&ctx, json!({"action":"bogus"})).await.unwrap();
        assert!(out.is_error);
        let out = tool
            .call(&ctx, json!({"action":"delete","id":"demo"}))
            .await
            .unwrap();
        assert!(!out.is_error);
        assert!(list(cwd.path(), "sess").is_empty());
    }

    #[test]
    fn tampered_meta_json_is_rejected() {
        let cwd = tempfile::tempdir().unwrap();
        let m = create(cwd.path(), "s1", input(ArtifactKind::Html, "<p>1</p>")).unwrap();
        let meta_path = artifacts_root(cwd.path()).join(&m.id).join("meta.json");
        let original = fs::read_to_string(&meta_path).unwrap();
        let tamper = |find: &str, replace: &str| {
            let text = original.replace(find, replace);
            assert_ne!(text, original, "fixture must change");
            fs::write(&meta_path, text).unwrap();
        };
        for bad_id in [
            "..\\\\..\\\\evil",
            "../../evil",
            "a/b",
            "other-id",
            "UPPER",
            "",
        ] {
            tamper(
                &format!("\"id\": \"{}\"", m.id),
                &format!("\"id\": \"{bad_id}\""),
            );
            assert!(
                read(cwd.path(), "s1", &m.id, None).is_err(),
                "id {bad_id:?} must be rejected"
            );
            assert!(list(cwd.path(), "s1").is_empty());
            fs::write(&meta_path, &original).unwrap();
        }
        tamper("\"title\": \"My Page\"", "\"title\": \"bad\\u0007title\"");
        assert!(read(cwd.path(), "s1", &m.id, None).is_err());
        fs::write(&meta_path, &original).unwrap();
        assert_eq!(read(cwd.path(), "s1", &m.id, None).unwrap().meta.id, m.id);
    }
}
