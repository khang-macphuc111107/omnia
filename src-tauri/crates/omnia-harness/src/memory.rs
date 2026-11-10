//! File-based long-term memory (user and project scope).
//!
//! Each memory is one markdown file `<slug>.md` with a small frontmatter
//! (`name`, `description`, optional `type`) and a free-text body that may link
//! to other memories with `[[slug]]`. Every memory directory also holds a
//! `MEMORY.md` index with one line per memory. Files are meant to be
//! hand-editable; the tools only keep the index in sync.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::tools::{finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec};

const INDEX_FILE: &str = "MEMORY.md";
/// Per-scope cap on index text injected into the system prompt.
const INDEX_PROMPT_CAP: usize = 8 * 1024;
const MAX_SLUG_LEN: usize = 64;
pub const SUPPORTED_CATEGORIES: &[&str] = &["memory", "specs", "plans", "skills", "artifacts"];

/// Directory of user-scope memories.
pub fn user_memory_dir(omnia_home: &Path) -> PathBuf {
    omnia_home.join("memory")
}

/// Directory of project-scope memories.
pub fn project_memory_dir(cwd: &Path) -> PathBuf {
    cwd.join(".omnia").join("memory")
}

/// Directory of a specific category under project-scope .omnia/.
pub fn project_category_dir(cwd: &Path, category: &str) -> PathBuf {
    cwd.join(".omnia").join(category)
}

/// Registers `memory_read`, `memory_write` and `memory_delete`. The bridge
/// calls this because it owns `omnia_home`.
pub fn register(registry: &mut ToolRegistry, omnia_home: Option<PathBuf>) {
    registry.register(Arc::new(MemoryReadTool {
        omnia_home: omnia_home.clone(),
    }));
    registry.register(Arc::new(MemoryWriteTool {
        omnia_home: omnia_home.clone(),
    }));
    registry.register(Arc::new(MemoryDeleteTool { omnia_home }));
}

/// "# Memory" system-prompt section with both indexes, or `None` when there
/// are no memories in either scope.
pub fn memory_prompt_section(cwd: &Path, omnia_home: Option<&Path>) -> Option<String> {
    let mut sections = Vec::new();
    if let Some(home) = omnia_home {
        if let Some(idx) = read_index_for_prompt(&user_memory_dir(home)) {
            sections.push(("User memory index".to_string(), idx));
        }
    }
    for cat in SUPPORTED_CATEGORIES {
        let dir = project_category_dir(cwd, cat);
        if let Some(idx) = read_index_for_prompt(&dir) {
            let label = match *cat {
                "memory" => "Project memory index".to_string(),
                "specs" => "Project specifications index (.omnia/specs)".to_string(),
                "plans" => "Project plans index (.omnia/plans)".to_string(),
                "skills" => "Project skills index (.omnia/skills)".to_string(),
                "artifacts" => "Project artifacts index (.omnia/artifacts)".to_string(),
                other => format!("Project {other} index (.omnia/{other})"),
            };
            sections.push((label, idx));
        }
    }
    if sections.is_empty() {
        return None;
    }
    let mut out = String::from(
        "# Memory\n\nYou have file-based long-term memory in two scopes: `user` (applies to every \
project) and `project` (this workspace only, structured hierarchically under `.omnia/` including \
`memory/`, `specs/`, `plans/`, `skills/`). Below are the active indexes. Use `memory_read` (omit `slug` \
for the index, optional `category`) to load a memory, `memory_write` to save durable facts, preferences, \
specifications, or plans (re-writing updates it), and `memory_delete` to remove stale ones. \
Memories can link to each other with `[[slug]]`. Do not store secrets or transient task state.\n",
    );
    for (label, index) in sections {
        out.push_str(&format!("\n## {label}\n\n{index}\n"));
    }
    Some(out)
}

fn read_index_for_prompt(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(INDEX_FILE)).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= INDEX_PROMPT_CAP {
        return Some(text.to_string());
    }
    let mut end = INDEX_PROMPT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    // Prefer cutting at a line boundary so no index entry is half-shown.
    let end = text[..end].rfind('\n').unwrap_or(end);
    Some(format!(
        "{}\n[index truncated: showing {end} of {} bytes; use memory_read to see the rest]",
        &text[..end],
        text.len()
    ))
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG_LEN
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn check_slug(slug: &str) -> Result<(), String> {
    if valid_slug(slug) {
        Ok(())
    } else {
        Err(format!(
            "invalid slug `{slug}`: use 1-{MAX_SLUG_LEN} characters from a-z, 0-9 and `-`"
        ))
    }
}

pub fn normalize_category(category: Option<&str>) -> Result<&str, String> {
    match category {
        None | Some("") => Ok("memory"),
        Some(cat) => {
            let cat = cat.trim();
            if SUPPORTED_CATEGORIES.contains(&cat) || valid_slug(cat) {
                Ok(cat)
            } else {
                Err(format!(
                    "invalid category `{cat}`: use one of {:?} or a valid slug",
                    SUPPORTED_CATEGORIES
                ))
            }
        }
    }
}

pub fn resolve_category_dir(
    scope: &str,
    category: &str,
    ctx: &ToolContext,
    omnia_home: &Option<PathBuf>,
) -> Result<PathBuf, String> {
    match scope {
        "user" => omnia_home
            .as_deref()
            .map(|h| h.join(category))
            .ok_or_else(|| "user memory is unavailable (no Omnia home directory)".to_string()),
        "project" => Ok(project_category_dir(&ctx.cwd, category)),
        other => Err(format!("invalid scope `{other}`: use `user` or `project`")),
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn index_line(slug: &str, name: &str, description: &str) -> String {
    let name = one_line(name).replace(['[', ']'], "");
    format!("- [{name}]({slug}.md) — {}", one_line(description))
}

/// Replaces (or appends) the index line for `slug`; `None` removes it.
fn update_index(dir: &Path, slug: &str, line: Option<String>) -> Result<(), String> {
    let path = dir.join(INDEX_FILE);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let marker = format!("]({slug}.md)");
    let mut lines: Vec<String> = Vec::new();
    let mut pending = line;
    for current in existing.lines() {
        if current.starts_with("- [") && current.contains(&marker) {
            if let Some(new) = pending.take() {
                lines.push(new);
            }
        } else {
            lines.push(current.to_string());
        }
    }
    if let Some(new) = pending {
        lines.push(new);
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    fs::write(&path, text).map_err(|e| format!("cannot write {INDEX_FILE}: {e}"))
}

/// Frontmatter values are JSON-quoted when they could confuse a YAML reader.
fn yaml_value(s: &str) -> String {
    if s.is_empty() || s.contains([':', '#', '"', '\'']) || s.starts_with(['-', '[', '{']) {
        Value::String(s.to_string()).to_string()
    } else {
        s.to_string()
    }
}

fn render_file(name: &str, description: &str, kind: Option<&str>, body: &str) -> String {
    let mut out = format!(
        "---\nname: {}\ndescription: {}\n",
        yaml_value(&one_line(name)),
        yaml_value(&one_line(description))
    );
    if let Some(kind) = kind.map(one_line).filter(|k| !k.is_empty()) {
        out.push_str(&format!("type: {}\n", yaml_value(&kind)));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_end());
    out.push('\n');
    out
}

fn scope_schema() -> Value {
    json!({"type": "string", "enum": ["user", "project"], "description": "`user` = all projects, `project` = this workspace."})
}

fn category_schema() -> Value {
    json!({
        "type": "string",
        "description": "Optional category folder under .omnia/ (e.g. `memory`, `specs`, `plans`, `skills`, `artifacts`). Defaults to `memory`."
    })
}

fn slug_schema() -> Value {
    json!({"type": "string", "description": "Memory id: 1-64 chars of a-z, 0-9, `-`."})
}

#[derive(Deserialize)]
struct ReadArgs {
    scope: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
struct WriteArgs {
    scope: String,
    #[serde(default)]
    category: Option<String>,
    slug: String,
    name: String,
    description: String,
    body: String,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct DeleteArgs {
    scope: String,
    #[serde(default)]
    category: Option<String>,
    slug: String,
}

pub struct MemoryReadTool {
    pub omnia_home: Option<PathBuf>,
}

#[async_trait]
impl Tool for MemoryReadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_read".into(),
            description:
                "Read a long-term memory by slug, or the scope's index when `slug` is omitted."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": scope_schema(),
                    "category": category_schema(),
                    "slug": slug_schema()
                },
                "required": ["scope"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Read {} {} {}",
            input["scope"].as_str().unwrap_or("?"),
            input["category"].as_str().unwrap_or("memory"),
            input["slug"].as_str().unwrap_or("index")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: ReadArgs = parse_input(input)?;
            let category = normalize_category(args.category.as_deref())?;
            let dir = resolve_category_dir(&args.scope, category, ctx, &self.omnia_home)?;
            let (file, label) = match &args.slug {
                Some(slug) => {
                    check_slug(slug)?;
                    (
                        dir.join(format!("{slug}.md")),
                        format!("{category} `{slug}`"),
                    )
                }
                None => (dir.join(INDEX_FILE), format!("{category} index")),
            };
            match fs::read_to_string(&file) {
                Ok(text) if text.trim().is_empty() => Ok(ToolOutput::text("(empty)")),
                Ok(text) => Ok(ToolOutput::text(text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && args.slug.is_none() => {
                    Ok(ToolOutput::text(format!("(no {category} yet)")))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!(
                    "{label} not found in {} scope ({category})",
                    args.scope
                )),
                Err(e) => Err(format!("cannot read {label}: {e}")),
            }
        })())
    }
}

pub struct MemoryWriteTool {
    pub omnia_home: Option<PathBuf>,
}

#[async_trait]
impl Tool for MemoryWriteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_write".into(),
            description: "Create or overwrite a long-term memory and update its index line. Keep \
`description` to one short line (it is shown in the index); put details in `body`, which may link \
to other memories with [[slug]]."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": scope_schema(),
                    "category": category_schema(),
                    "slug": slug_schema(),
                    "name": {"type": "string", "description": "Human-readable title."},
                    "description": {"type": "string", "description": "One-line summary for the index."},
                    "body": {"type": "string", "description": "Memory content (markdown)."},
                    "type": {"type": "string", "description": "Optional category, e.g. user, feedback, project, reference."}
                },
                "required": ["scope", "slug", "name", "description", "body"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Write {} {} {}",
            input["scope"].as_str().unwrap_or("?"),
            input["category"].as_str().unwrap_or("memory"),
            input["slug"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: WriteArgs = parse_input(input)?;
            check_slug(&args.slug)?;
            if one_line(&args.name).is_empty() {
                return Err("`name` must not be empty".into());
            }
            let category = normalize_category(args.category.as_deref())?;
            let dir = resolve_category_dir(&args.scope, category, ctx, &self.omnia_home)?;
            fs::create_dir_all(&dir).map_err(|e| format!("cannot create memory dir: {e}"))?;
            let file = dir.join(format!("{}.md", args.slug));
            ctx.checkpoint_before(&file)?;
            ctx.checkpoint_before(&dir.join(INDEX_FILE))?;
            let content = render_file(
                &args.name,
                &args.description,
                args.kind.as_deref(),
                &args.body,
            );
            fs::write(&file, content).map_err(|e| format!("cannot write memory: {e}"))?;
            let line = index_line(&args.slug, &args.name, &args.description);
            update_index(&dir, &args.slug, Some(line))?;
            Ok(ToolOutput::text(format!(
                "Saved {} {} `{}`.",
                args.scope, category, args.slug
            )))
        })())
    }
}

pub struct MemoryDeleteTool {
    pub omnia_home: Option<PathBuf>,
}

#[async_trait]
impl Tool for MemoryDeleteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_delete".into(),
            description: "Delete a long-term memory and its index line.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": scope_schema(),
                    "category": category_schema(),
                    "slug": slug_schema()
                },
                "required": ["scope", "slug"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Delete {} {} {}",
            input["scope"].as_str().unwrap_or("?"),
            input["category"].as_str().unwrap_or("memory"),
            input["slug"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: DeleteArgs = parse_input(input)?;
            check_slug(&args.slug)?;
            let category = normalize_category(args.category.as_deref())?;
            let dir = resolve_category_dir(&args.scope, category, ctx, &self.omnia_home)?;
            let file = dir.join(format!("{}.md", args.slug));
            if !file.is_file() {
                return Err(format!(
                    "{category} `{}` not found in {} scope",
                    args.slug, args.scope
                ));
            }
            ctx.checkpoint_before(&file)?;
            ctx.checkpoint_before(&dir.join(INDEX_FILE))?;
            fs::remove_file(&file).map_err(|e| format!("cannot delete memory: {e}"))?;
            update_index(&dir, &args.slug, None)?;
            Ok(ToolOutput::text(format!(
                "Deleted {} {} `{}`.",
                args.scope, category, args.slug
            )))
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Setup = (
        tempfile::TempDir,
        tempfile::TempDir,
        ToolRegistry,
        ToolContext,
    );

    fn setup() -> Setup {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let mut registry = ToolRegistry::default();
        register(&mut registry, Some(home.path().to_path_buf()));
        let ctx = ToolContext::new(cwd.path());
        (home, cwd, registry, ctx)
    }

    async fn run(reg: &ToolRegistry, ctx: &ToolContext, tool: &str, input: Value) -> ToolOutput {
        reg.get(tool).unwrap().call(ctx, input).await.unwrap()
    }

    fn write_input(scope: &str, slug: &str, description: &str) -> Value {
        json!({"scope": scope, "slug": slug, "name": "Tabs", "description": description,
               "body": "Uses tabs. See [[style]].", "type": "feedback"})
    }

    fn text(out: &ToolOutput) -> String {
        format!("{:?}", out.content)
    }

    #[tokio::test]
    async fn write_creates_file_and_index_line() {
        let (home, _cwd, reg, ctx) = setup();
        let out = run(
            &reg,
            &ctx,
            "memory_write",
            write_input("user", "tabs", "Prefer tabs"),
        )
        .await;
        assert!(!out.is_error, "{}", text(&out));
        let dir = user_memory_dir(home.path());
        let file = fs::read_to_string(dir.join("tabs.md")).unwrap();
        assert!(file.starts_with("---\nname: Tabs\ndescription: Prefer tabs\ntype: feedback\n---"));
        assert!(file.contains("[[style]]"));
        let index = fs::read_to_string(dir.join("MEMORY.md")).unwrap();
        assert_eq!(index, "- [Tabs](tabs.md) — Prefer tabs\n");
        let read = run(
            &reg,
            &ctx,
            "memory_read",
            json!({"scope": "user", "slug": "tabs"}),
        )
        .await;
        assert!(text(&read).contains("Uses tabs"));
        let idx = run(&reg, &ctx, "memory_read", json!({"scope": "user"})).await;
        assert!(text(&idx).contains("tabs.md"));
    }

    #[tokio::test]
    async fn overwrite_updates_line_without_duplicating() {
        let (home, _cwd, reg, ctx) = setup();
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "tabs", "old"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "other", "x"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "tabs", "new: value"),
        )
        .await;
        let index = fs::read_to_string(project_memory_dir(&ctx.cwd).join("MEMORY.md")).unwrap();
        assert_eq!(index.matches("(tabs.md)").count(), 1);
        assert!(index.contains("new: value"));
        assert!(!index.contains("old"));
        assert!(index.contains("(other.md)"));
        assert!(!home.path().join("memory").exists());
    }

    #[tokio::test]
    async fn delete_removes_file_and_line() {
        let (home, _cwd, reg, ctx) = setup();
        run(&reg, &ctx, "memory_write", write_input("user", "tabs", "d")).await;
        let del = json!({"scope": "user", "slug": "tabs"});
        let out = run(&reg, &ctx, "memory_delete", del.clone()).await;
        assert!(!out.is_error);
        let dir = user_memory_dir(home.path());
        assert!(!dir.join("tabs.md").exists());
        assert!(!fs::read_to_string(dir.join("MEMORY.md"))
            .unwrap()
            .contains("tabs.md"));
        assert!(run(&reg, &ctx, "memory_delete", del).await.is_error);
    }

    #[tokio::test]
    async fn bad_slug_and_scope_rejected() {
        let (_home, cwd, reg, ctx) = setup();
        for slug in ["../evil", "A", "a/b", "", "a.b", &"x".repeat(65)] {
            let out = run(&reg, &ctx, "memory_write", write_input("user", slug, "d")).await;
            assert!(out.is_error, "slug {slug:?} accepted");
            let read = json!({"scope": "project", "slug": slug});
            assert!(run(&reg, &ctx, "memory_read", read).await.is_error);
        }
        let out = run(&reg, &ctx, "memory_write", write_input("global", "ok", "d")).await;
        assert!(out.is_error);
        assert!(!cwd.path().join(".omnia").exists());
    }

    #[tokio::test]
    async fn user_scope_needs_home() {
        let mut reg = ToolRegistry::default();
        register(&mut reg, None);
        let cwd = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(cwd.path());
        assert!(
            run(&reg, &ctx, "memory_write", write_input("user", "a", "d"))
                .await
                .is_error
        );
    }

    #[tokio::test]
    async fn prompt_section_includes_both_scopes() {
        let (home, cwd, reg, ctx) = setup();
        assert!(memory_prompt_section(cwd.path(), Some(home.path())).is_none());
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("user", "u-one", "user fact"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "p-one", "project fact"),
        )
        .await;
        let section = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(section.starts_with("# Memory"));
        assert!(section.contains("user fact") && section.contains("project fact"));
        assert!(section.contains("memory_write"));
        let only_project = memory_prompt_section(cwd.path(), None).unwrap();
        assert!(!only_project.contains("user fact"));
    }

    #[test]
    fn prompt_section_truncates_large_index() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let dir = user_memory_dir(home.path());
        fs::create_dir_all(&dir).unwrap();
        let big: String = (0..1000)
            .map(|i| format!("- [m{i}](m{i}.md) — dòng mô tả dài số {i}\n"))
            .collect();
        fs::write(dir.join("MEMORY.md"), big).unwrap();
        let section = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(section.contains("[index truncated"));
        assert!(section.len() < INDEX_PROMPT_CAP + 2048);
        assert!(!section.contains("m999.md"));
    }

    #[tokio::test]
    async fn write_and_read_hierarchical_project_categories() {
        let (_home, cwd, reg, ctx) = setup();
        let spec_input = json!({
            "scope": "project",
            "category": "specs",
            "slug": "arch-spec",
            "name": "Architecture Spec",
            "description": "Core architecture",
            "body": "Hierarchical memory specification."
        });
        let out = run(&reg, &ctx, "memory_write", spec_input).await;
        assert!(!out.is_error, "{}", text(&out));
        let spec_file = cwd.path().join(".omnia").join("specs").join("arch-spec.md");
        assert!(
            spec_file.exists(),
            "spec file must exist under .omnia/specs"
        );
        let spec_idx = cwd.path().join(".omnia").join("specs").join("MEMORY.md");
        assert!(
            spec_idx.exists(),
            "spec index must exist under .omnia/specs"
        );
        assert!(fs::read_to_string(&spec_idx)
            .unwrap()
            .contains("arch-spec.md"));

        let read_out = run(
            &reg,
            &ctx,
            "memory_read",
            json!({
                "scope": "project",
                "category": "specs",
                "slug": "arch-spec"
            }),
        )
        .await;
        assert!(!read_out.is_error);
        assert!(text(&read_out).contains("Hierarchical memory specification"));

        let del_out = run(
            &reg,
            &ctx,
            "memory_delete",
            json!({
                "scope": "project",
                "category": "specs",
                "slug": "arch-spec"
            }),
        )
        .await;
        assert!(!del_out.is_error);
        assert!(!spec_file.exists());
        assert!(!fs::read_to_string(&spec_idx)
            .unwrap()
            .contains("arch-spec.md"));
    }

    #[tokio::test]
    async fn prompt_section_includes_hierarchical_categories() {
        let (home, cwd, reg, ctx) = setup();
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "p-core", "core fact"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "specs",
                "slug": "api-v1",
                "name": "API Spec",
                "description": "API design",
                "body": "Endpoints list."
            }),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "plans",
                "slug": "milestone-1",
                "name": "Milestone 1",
                "description": "Q1 release",
                "body": "Tasks list."
            }),
        )
        .await;

        let section = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(section.contains("Project memory index"));
        assert!(section.contains("Project specifications index (.omnia/specs)"));
        assert!(section.contains("Project plans index (.omnia/plans)"));
        assert!(section.contains("API design"));
        assert!(section.contains("Q1 release"));
    }
}
