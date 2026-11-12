//! Agent Skills: folders containing a `SKILL.md` with YAML-ish frontmatter.
//!
//! Skills are discovered from the workspace and user directories, advertised
//! to the model in a compact prompt section, and loaded on demand through the
//! [`SkillTool`].

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const MAX_SKILL_FILE_BYTES: u64 = 256 * 1024;
const MAX_SKILL_NAME_CHARS: usize = 128;
const MAX_DESCRIPTION_CHARS: usize = 1024;
const MAX_LISTED_FILES: usize = 50;
const MAX_WALK_DEPTH: usize = 4;
/// Candidate roots larger than this fail closed, rather than allocating or
/// walking an unbounded directory before the per-root skill limit applies.
const MAX_SKILL_ROOT_ENTRIES: usize = 4096;
/// Sorted directory candidates are bounded separately from root entries.
const MAX_SKILLS_PER_ROOT: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Project,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Path of the `SKILL.md` file.
    pub path: PathBuf,
    /// Directory containing `SKILL.md`.
    pub dir: PathBuf,
    pub source: SkillSource,
}

/// Splits `content` into (frontmatter text, body). Without a leading `---`
/// line the frontmatter is empty and the body is the whole content.
pub(crate) fn split_frontmatter(content: &str) -> (String, &str) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return (String::new(), content);
    };
    if first.trim_end() != "---" {
        return (String::new(), content);
    }
    let mut consumed = first.len();
    let mut front = String::new();
    for line in lines {
        consumed += line.len();
        if line.trim_end() == "---" {
            return (front, &content[consumed..]);
        }
        front.push_str(line.trim_end_matches(['\r', '\n']));
        front.push('\n');
    }
    // Unterminated frontmatter: treat the whole file as body.
    (String::new(), content)
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_owned();
        }
    }
    value.to_owned()
}

/// Returns the value of top-level `key:` supporting quoted scalars, block
/// scalars (`>`, `|`) and plain continuation lines.
pub(crate) fn frontmatter_value(front: &str, key: &str) -> Option<String> {
    let lines: Vec<&str> = front.lines().collect();
    let prefix = format!("{key}:");
    let index = lines.iter().position(|line| line.starts_with(&prefix))?;
    let rest = lines[index][prefix.len()..].trim();
    let mut continuation = Vec::new();
    for line in &lines[index + 1..] {
        if line.trim().is_empty() {
            continuation.push("");
        } else if line.starts_with([' ', '\t']) {
            continuation.push(line.trim());
        } else {
            break;
        }
    }
    while continuation.last() == Some(&"") {
        continuation.pop();
    }
    match rest.chars().next() {
        Some('>') => Some(continuation.join(" ").trim().to_owned()),
        Some('|') => Some(continuation.join("\n").trim().to_owned()),
        _ => {
            let mut value = unquote(rest);
            for line in continuation.iter().filter(|line| !line.is_empty()) {
                value.push(' ');
                value.push_str(line);
            }
            Some(value)
        }
    }
}

fn invalid_boundary() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Skill paths must stay inside the discovered skill directory",
    )
}

/// Resolve a path and require the resolved target to remain below `root`.
///
/// The configured root is canonicalized by the caller, so a configured root
/// may itself be a symlink or junction. Descendant links are allowed when they
/// resolve inside that root; links resolving outside it are rejected.
fn contained_plain_path(root: &Path, path: &Path) -> io::Result<PathBuf> {
    let resolved = path.canonicalize()?;
    if !resolved.starts_with(root) {
        return Err(invalid_boundary());
    }
    // A link can be replaced while discovery is in progress. Require a
    // stable second resolution before trusting the path.
    if path.canonicalize()? != resolved {
        return Err(invalid_boundary());
    }
    Ok(resolved)
}

fn valid_skill_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.chars().count() <= MAX_SKILL_NAME_CHARS
        && !name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                )
        })
}

/// Resolve a skill directory and the configured-root boundary implied by its
/// parent. The discovery path is normally already canonical, but reloading
/// must also support an internal directory link that replaces it later.
fn resolved_skill_directory(dir: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let parent = dir.parent().ok_or_else(invalid_boundary)?;
    let boundary = parent.canonicalize()?;
    let resolved = dir.canonicalize()?;
    let metadata = std::fs::metadata(dir)?;
    if !metadata.is_dir() || !resolved.starts_with(&boundary) {
        return Err(invalid_boundary());
    }
    Ok((boundary, resolved))
}

fn read_skill_file(path: &Path, dir: &Path) -> io::Result<String> {
    // A previously discovered directory can be replaced before an on-demand
    // load. It may resolve through an internal link, but never outside the
    // configured root implied by its parent.
    let (boundary, resolved_dir) = resolved_skill_directory(dir)?;
    let resolved = contained_plain_path(&boundary, path)?;
    if !resolved.starts_with(&resolved_dir) {
        return Err(invalid_boundary());
    }
    let file = std::fs::File::open(&resolved)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > MAX_SKILL_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Skill must be a regular UTF-8 file of at most 256 KiB",
        ));
    }
    // Read from the same handle and bound the actual bytes as well as the
    // metadata. A file growing between metadata and read must not bypass the
    // limit; the same bound applies when a discovered skill is loaded later.
    let mut content = String::new();
    file.take(MAX_SKILL_FILE_BYTES + 1)
        .read_to_string(&mut content)?;
    if content.len() as u64 > MAX_SKILL_FILE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Skill file exceeds the 256 KiB limit",
        ));
    }
    let (current_boundary, current_dir) = resolved_skill_directory(dir)?;
    if current_boundary != boundary
        || current_dir != resolved_dir
        || contained_plain_path(&boundary, path)? != resolved
    {
        return Err(invalid_boundary());
    }
    Ok(content)
}

fn parse_skill(path: &Path, source: SkillSource) -> Option<Skill> {
    let dir = path.parent()?.to_path_buf();
    let content = read_skill_file(path, &dir).ok()?;
    let (front, _) = split_frontmatter(&content);
    let folder = dir.file_name()?.to_string_lossy().into_owned();
    let name = frontmatter_value(&front, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or(folder);
    if !valid_skill_name(&name) {
        return None;
    }
    let description = frontmatter_value(&front, "description").unwrap_or_default();
    let _ = contained_plain_path(&dir, path).ok()?;
    Some(Skill {
        name,
        description,
        // Keep the logical path so a later link replacement is re-resolved
        // and checked by `read_skill_file` rather than silently using the
        // discovery-time target.
        path: path.to_path_buf(),
        dir,
        source,
    })
}

fn scan_dir(root: &Path, source: SkillSource, out: &mut Vec<Skill>) {
    let Ok(root) = root.canonicalize() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let entries: Vec<_> = entries.take(MAX_SKILL_ROOT_ENTRIES + 1).collect();
    if entries.len() > MAX_SKILL_ROOT_ENTRIES {
        return;
    }
    let mut dirs: Vec<PathBuf> = entries
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| contained_plain_path(&root, &entry.path()).ok())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs.dedup();
    for dir in dirs.into_iter().take(MAX_SKILLS_PER_ROOT) {
        if let Some(skill) = parse_skill(&dir.join("SKILL.md"), source) {
            out.push(skill);
        }
    }
}

/// Discovers skills. Project skills win over user skills on name clash; among
/// project dirs the earlier one (`.omnia`, `.claude`, `.agents`) wins.
pub fn discover_skills(workspace: &Path, user_dirs: &[PathBuf]) -> Vec<Skill> {
    let mut found = Vec::new();
    for sub in [".omnia/skills", ".claude/skills", ".agents/skills"] {
        scan_dir(&workspace.join(sub), SkillSource::Project, &mut found);
    }
    for dir in user_dirs {
        scan_dir(dir, SkillSource::User, &mut found);
    }
    let mut seen = HashSet::new();
    let mut skills: Vec<Skill> = found
        .into_iter()
        .filter(|skill| seen.insert(skill.name.clone()))
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// [`discover_skills`] plus the `skills/` folders of enabled plugins, which
/// rank below workspace and user skills on a name clash.
pub fn discover_skills_with_plugins(
    workspace: &Path,
    user_dirs: &[PathBuf],
    plugin_dirs: &[PathBuf],
) -> Vec<Skill> {
    let mut dirs = user_dirs.to_vec();
    dirs.extend_from_slice(plugin_dirs);
    discover_skills(workspace, &dirs)
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut indices = text.char_indices();
    let Some((limit_byte, next_char)) = indices.nth(max) else {
        return text.to_owned();
    };
    if max == 0 {
        return "…".to_owned();
    }
    let prefix = &text[..limit_byte];
    let min_sentence_chars = max / 2;
    let mut sentence_end_byte = None;
    let mut chars_seen = 0usize;
    let mut iter = prefix.char_indices().peekable();
    while let Some((byte_idx, ch)) = iter.next() {
        chars_seen += 1;
        if matches!(ch, '.' | '!' | '?' | '。' | '！' | '？') && chars_seen >= min_sentence_chars
        {
            let followed_by_space = match iter.peek() {
                Some(&(_, next)) => next.is_whitespace(),
                None => next_char.is_whitespace(),
            };
            if followed_by_space {
                sentence_end_byte = Some(byte_idx + ch.len_utf8());
            }
        }
    }
    if let Some(end_byte) = sentence_end_byte {
        let mut out = prefix[..end_byte].trim_end().to_owned();
        out.push('…');
        return out;
    }

    let min_word_chars = (max * 3) / 4;
    let mut word_end_byte = None;
    for (char_pos, (byte_idx, ch)) in prefix.char_indices().enumerate() {
        if ch.is_whitespace() && char_pos >= min_word_chars {
            word_end_byte = Some(byte_idx);
        }
    }
    let cut = match word_end_byte {
        Some(end_byte) => prefix[..end_byte].trim_end(),
        None => prefix.trim_end(),
    };
    let mut out = cut.to_owned();
    out.push('…');
    out
}

pub fn skills_prompt_section(skills: &[Skill]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "# Skills\n\nSkills are packaged instructions for specific kinds of tasks. When the \
         user's task matches a skill below, call the `skill` tool with its name to load the \
         full instructions before acting.\n\n",
    );
    for skill in skills {
        let normalized = skill
            .description
            .replace("\r\n", " ")
            .replace(['\r', '\n'], " ");
        let description = truncate_chars(&normalized, MAX_DESCRIPTION_CHARS);
        out.push_str(&format!("- {}: {}\n", skill.name, description));
    }
    out
}

fn list_files(dir: &Path) -> Vec<String> {
    fn walk(
        boundary: &Path,
        display_root: &Path,
        dir: &Path,
        depth: usize,
        remaining_entries: &mut usize,
        out: &mut Vec<String>,
    ) {
        if depth > MAX_WALK_DEPTH
            || out.len() >= MAX_LISTED_FILES
            || *remaining_entries == 0
            || dir
                .canonicalize()
                .ok()
                .is_none_or(|path| !path.starts_with(boundary))
        {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let entries: Vec<_> = entries.take(*remaining_entries + 1).collect();
        if entries.len() > *remaining_entries {
            *remaining_entries = 0;
            return;
        }
        *remaining_entries -= entries.len();
        let mut paths: Vec<PathBuf> = entries
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|entry| contained_plain_path(boundary, &entry.path()).ok())
            .collect();
        paths.sort();
        paths.dedup();
        for path in paths {
            if out.len() >= MAX_LISTED_FILES {
                return;
            }
            if path.is_dir() {
                walk(
                    boundary,
                    display_root,
                    &path,
                    depth + 1,
                    remaining_entries,
                    out,
                );
            } else if path.is_file() {
                let Ok(relative) = path.strip_prefix(display_root) else {
                    continue;
                };
                let relative = relative.to_string_lossy().replace('\\', "/");
                if relative != "SKILL.md" {
                    out.push(relative);
                }
            }
        }
    }
    let mut out = Vec::new();
    let mut remaining_entries = MAX_SKILL_ROOT_ENTRIES;
    let Ok((boundary, resolved_dir)) = resolved_skill_directory(dir) else {
        return out;
    };
    walk(
        &boundary,
        &resolved_dir,
        &resolved_dir,
        0,
        &mut remaining_entries,
        &mut out,
    );
    out
}

/// Loads a skill's instructions on demand.
pub struct SkillTool {
    skills: Vec<Skill>,
}

impl SkillTool {
    pub fn new(skills: Vec<Skill>) -> Self {
        Self { skills }
    }
}

#[async_trait]
impl Tool for SkillTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "skill".to_owned(),
            description: "Load a skill's full instructions by name. Call this before acting on a \
                          task that matches one of the available skills."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": MAX_SKILL_NAME_CHARS, "description": "Skill name"},
                    "args": {"type": "string", "description": "Optional arguments for the skill"}
                },
                "required": ["name"]
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Load skill `{}`",
            input.get("name").and_then(Value::as_str).unwrap_or("?")
        )
    }

    async fn call(&self, _ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| HarnessError::InvalidInput("`name` is required".to_owned()))?;
        if !valid_skill_name(name) {
            return Err(HarnessError::InvalidInput(format!(
                "`name` must be a non-empty skill name of at most {MAX_SKILL_NAME_CHARS} characters without control or directional formatting characters"
            )));
        }
        let args = input
            .get("args")
            .and_then(Value::as_str)
            .filter(|a| !a.is_empty());
        let Some(skill) = self.skills.iter().find(|skill| skill.name == name) else {
            let names: Vec<&str> = self.skills.iter().map(|s| s.name.as_str()).collect();
            return Ok(ToolOutput::error(format!(
                "Unknown skill `{name}`. Available skills: {}",
                if names.is_empty() {
                    "(none)".to_owned()
                } else {
                    names.join(", ")
                }
            )));
        };
        let content = match read_skill_file(&skill.path, &skill.dir) {
            Ok(content) => content,
            Err(error) => {
                return Ok(ToolOutput::error(format!(
                    "Could not read {}: {error}",
                    skill.path.display()
                )))
            }
        };
        let (_, body) = split_frontmatter(&content);
        let mut out = format!("Base directory for this skill: {}\n\n", skill.dir.display());
        out.push_str(body.trim_start_matches(['\r', '\n']));
        if let Some(args) = args {
            out.push_str(&format!("\n\nArguments: {args}\n"));
        }
        let files = list_files(&skill.dir);
        if !files.is_empty() {
            out.push_str("\n\nFiles in this skill directory:\n");
            for file in files {
                out.push_str(&format!("- {file}\n"));
            }
        }
        Ok(ToolOutput::text(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, sub: &str, folder: &str, content: &str) {
        let dir = root.join(sub).join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    #[cfg(any(unix, windows))]
    fn try_link_directory(target: &Path, link: &Path) -> io::Result<()> {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_dir(target, link);
        result
    }

    #[cfg(any(unix, windows))]
    fn try_link_file(target: &Path, link: &Path) -> io::Result<()> {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(target, link);
        result
    }

    #[cfg(windows)]
    fn symlink_fixture_available(error: &io::Error) -> bool {
        // Windows requires SeCreateSymbolicLinkPrivilege (or Developer Mode)
        // for these fixtures. The production path remains covered by the
        // explicit Windows privilege probe in the external evidence receipt.
        !matches!(error.raw_os_error(), Some(1314) | Some(5)) // ERROR_PRIVILEGE_NOT_HELD / ACCESS_DENIED
    }

    #[cfg(unix)]
    fn symlink_fixture_available(_error: &io::Error) -> bool {
        true
    }

    #[test]
    fn skill_names_are_bounded_without_restricting_existing_identifier_styles() {
        let tmp = tempfile::tempdir().unwrap();
        let valid = [
            "plugin:Skill_name.v2".to_owned(),
            "kỹ-năng".to_owned(),
            "x".repeat(MAX_SKILL_NAME_CHARS),
        ];
        for (index, name) in valid.iter().enumerate() {
            write_skill(
                tmp.path(),
                ".omnia/skills",
                &format!("valid-{index}"),
                &format!("---\nname: {name}\n---\n"),
            );
        }
        for (index, name) in [
            "x".repeat(MAX_SKILL_NAME_CHARS + 1),
            "unsafe\u{007f}name".to_owned(),
            "unsafe\u{2028}name".to_owned(),
            "unsafe\u{202e}name".to_owned(),
            "unsafe\u{2066}name".to_owned(),
        ]
        .iter()
        .enumerate()
        {
            write_skill(
                tmp.path(),
                ".omnia/skills",
                &format!("invalid-{index}"),
                &format!("---\nname: {name}\n---\n"),
            );
        }
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "multiline",
            "---\nname: |\n  unsafe\n  name\n---\n",
        );
        write_skill(
            tmp.path(),
            ".omnia/skills",
            &"f".repeat(MAX_SKILL_NAME_CHARS + 1),
            "no frontmatter",
        );
        let skills = discover_skills(tmp.path(), &[]);
        assert_eq!(skills.len(), valid.len());
        assert!(valid
            .iter()
            .all(|name| skills.iter().any(|skill| &skill.name == name)));
        assert!(!skills_prompt_section(&skills).contains("unsafe"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn discovery_rejects_symlinked_skill_directories_and_instruction_files() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_skill(outside.path(), "", "outside", "---\nname: escaped\n---\n");
        let root = tmp.path().join(".omnia/skills");
        std::fs::create_dir_all(root.join("file-link")).unwrap();
        let Err(error) =
            try_link_directory(&outside.path().join("outside"), &root.join("dir-link"))
        else {
            let Err(error) = try_link_file(
                &outside.path().join("outside/SKILL.md"),
                &root.join("file-link/SKILL.md"),
            ) else {
                assert!(discover_skills(tmp.path(), &[]).is_empty());
                return;
            };
            if symlink_fixture_available(&error) {
                panic!("symlink fixture failed: {error}");
            }
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn discovery_allows_internal_links_but_rejects_escape_links() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "inside",
            "---\nname: inside-link\n---\n",
        );
        write_skill(outside.path(), "", "outside", "---\nname: escaped\n---\n");
        let root = tmp.path().join(".omnia/skills");
        let Ok(()) = try_link_directory(&root.join("inside"), &root.join("inside-alias")) else {
            return;
        };
        let skills = discover_skills(tmp.path(), &[]);
        assert!(skills.iter().any(|skill| skill.name == "inside-link"));
        let Err(error) =
            try_link_directory(&outside.path().join("outside"), &root.join("outside-alias"))
        else {
            assert!(!skills.iter().any(|skill| skill.name == "escaped"));
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn on_demand_internal_instruction_link_is_allowed() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "demo",
            "---\nname: demo\n---\n",
        );
        let dir = tmp.path().join(".omnia/skills/demo");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(
            dir.join("nested/body.md"),
            "---\nname: ignored\n---\n# Internal body",
        )
        .unwrap();
        std::fs::remove_file(dir.join("SKILL.md")).unwrap();
        let Err(error) = try_link_file(&dir.join("nested/body.md"), &dir.join("SKILL.md")) else {
            let skills = discover_skills(tmp.path(), &[]);
            assert_eq!(skills.len(), 1);
            let content = read_skill_file(&skills[0].path, &skills[0].dir).unwrap();
            assert!(content.contains("# Internal body"));
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn file_listing_allows_internal_links_and_omits_escape_links() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_skill(tmp.path(), "", "demo", "---\nname: demo\n---\n");
        let dir = tmp.path().join("demo").canonicalize().unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/inside.txt"), "inside").unwrap();
        std::fs::write(outside.path().join("outside-secret.txt"), "private").unwrap();
        let Ok(()) = try_link_file(
            &dir.join("nested/inside.txt"),
            &dir.join("nested/internal-alias.txt"),
        ) else {
            return;
        };
        let files = list_files(&dir);
        assert!(files.iter().any(|file| file == "nested/inside.txt"));
        let Err(error) = try_link_file(
            &outside.path().join("outside-secret.txt"),
            &dir.join("nested/escaped-file.txt"),
        ) else {
            assert!(!files.iter().any(|file| file.contains("escaped")));
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn file_listing_rejects_nested_symlinked_files_and_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_skill(tmp.path(), "", "demo", "---\nname: demo\n---\n");
        std::fs::write(outside.path().join("outside-secret.txt"), "private").unwrap();
        let dir = tmp.path().join("demo").canonicalize().unwrap();
        std::fs::write(dir.join("inside.txt"), "inside").unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let Err(error) = try_link_file(
            &outside.path().join("outside-secret.txt"),
            &dir.join("nested/escaped-file.txt"),
        ) else {
            let Err(error) = try_link_directory(outside.path(), &dir.join("escaped-dir")) else {
                assert_eq!(list_files(&dir), vec!["inside.txt".to_owned()]);
                return;
            };
            if symlink_fixture_available(&error) {
                panic!("symlink fixture failed: {error}");
            }
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
    }

    #[test]
    fn file_listing_has_a_shared_entry_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap();
        for index in 0..=MAX_SKILL_ROOT_ENTRIES {
            std::fs::write(dir.join(format!("entry-{index:04}.txt")), "").unwrap();
        }
        assert!(list_files(&dir).is_empty());
    }

    #[test]
    fn parses_frontmatter_variants() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "a",
            "---\nname: alpha\ndescription: \"Quoted: yes\"\n---\nbody",
        );
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "b",
            "---\ndescription: >\n  folded one\n  folded two\n---\nbody",
        );
        write_skill(tmp.path(), ".claude/skills", "c", "no frontmatter");
        let skills = discover_skills(tmp.path(), &[]);
        let names: Vec<_> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["alpha", "b", "c"]);
        assert_eq!(skills[0].description, "Quoted: yes");
        assert_eq!(skills[1].description, "folded one folded two");
        assert_eq!(skills[2].description, "");
    }

    #[test]
    fn project_wins_and_big_files_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".agents/skills",
            "x",
            "---\nname: dup\ndescription: project\n---\n",
        );
        write_skill(
            user.path(),
            "",
            "x",
            "---\nname: dup\ndescription: user\n---\n",
        );
        write_skill(
            user.path(),
            "",
            "big",
            &format!("---\nname: big\n---\n{}", "a".repeat(300_000)),
        );
        let skills = discover_skills(tmp.path(), &[user.path().to_path_buf()]);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].description, "project");
        assert_eq!(skills[0].source, SkillSource::Project);
    }

    #[test]
    fn user_roots_keep_declared_precedence_and_missing_roots_are_safe() {
        let tmp = tempfile::tempdir().unwrap();
        let omnia = tempfile::tempdir().unwrap();
        let claude = tempfile::tempdir().unwrap();
        let codex = tempfile::tempdir().unwrap();
        write_skill(
            omnia.path(),
            "",
            "shared",
            "---\nname: shared\ndescription: omnia\n---\n",
        );
        write_skill(
            claude.path(),
            "",
            "shared",
            "---\nname: shared\ndescription: claude\n---\n",
        );
        write_skill(
            codex.path(),
            "",
            "shared",
            "---\nname: shared\ndescription: codex\n---\n",
        );
        write_skill(
            codex.path(),
            "",
            "codex-only",
            "---\nname: codex-only\ndescription: codex\n---\n",
        );
        let missing = tmp.path().join("does-not-exist");
        let skills = discover_skills(
            tmp.path(),
            &[
                omnia.path().to_path_buf(),
                claude.path().to_path_buf(),
                missing,
                codex.path().to_path_buf(),
            ],
        );
        assert_eq!(skills.len(), 2);
        let shared = skills.iter().find(|skill| skill.name == "shared").unwrap();
        assert_eq!(shared.description, "omnia");
        assert!(skills.iter().any(|skill| skill.name == "codex-only"));
    }

    #[test]
    fn codex_compatibility_keeps_project_user_and_plugin_precedence() {
        let tmp = tempfile::tempdir().unwrap();
        let project_root = tmp.path().join("project");
        let omnia_root = tmp.path().join("omnia");
        let claude_root = tmp.path().join("claude");
        let codex_root = tmp.path().join("codex");
        let plugin_root = tmp.path().join("plugin");
        for (root, sub, label, names) in [
            (
                &project_root,
                ".agents/skills",
                "project",
                vec!["all-roots"],
            ),
            (&omnia_root, "", "omnia", vec!["all-roots", "user-roots"]),
            (
                &claude_root,
                "",
                "claude",
                vec!["all-roots", "user-roots", "claude-codex"],
            ),
            (
                &codex_root,
                "",
                "codex",
                vec![
                    "all-roots",
                    "user-roots",
                    "claude-codex",
                    "codex-plugin",
                    "codex-only",
                ],
            ),
            (
                &plugin_root,
                "",
                "plugin",
                vec!["codex-plugin", "plugin-only"],
            ),
        ] {
            for name in names {
                write_skill(
                    root,
                    sub,
                    name,
                    &format!("---\nname: {name}\ndescription: {label}\n---\n"),
                );
            }
        }
        let skills = discover_skills_with_plugins(
            &project_root,
            &[omnia_root, claude_root, codex_root],
            &[plugin_root],
        );
        let descriptions: std::collections::HashMap<_, _> = skills
            .iter()
            .map(|skill| (skill.name.as_str(), skill.description.as_str()))
            .collect();
        assert_eq!(descriptions.len(), 6);
        assert_eq!(descriptions["all-roots"], "project");
        assert_eq!(descriptions["user-roots"], "omnia");
        assert_eq!(descriptions["claude-codex"], "claude");
        assert_eq!(descriptions["codex-plugin"], "codex");
        assert_eq!(descriptions["codex-only"], "codex");
        assert_eq!(descriptions["plugin-only"], "plugin");
    }

    #[test]
    fn skill_root_scan_is_bounded_and_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..(MAX_SKILLS_PER_ROOT + 8) {
            write_skill(
                tmp.path(),
                ".omnia/skills",
                &format!("skill-{index:04}"),
                &format!("---\nname: skill-{index:04}\n---\n"),
            );
        }
        let skills = discover_skills(tmp.path(), &[]);
        assert_eq!(skills.len(), MAX_SKILLS_PER_ROOT);
        assert_eq!(
            skills.first().map(|skill| skill.name.as_str()),
            Some("skill-0000")
        );
        assert_eq!(
            skills.last().map(|skill| skill.name.as_str()),
            Some("skill-1023")
        );
    }

    #[test]
    fn oversized_skill_root_is_not_partially_advertised() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".omnia/skills");
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..MAX_SKILL_ROOT_ENTRIES {
            std::fs::write(root.join(format!("entry-{index:04}")), "").unwrap();
        }
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "valid",
            "---\nname: valid\n---\n",
        );
        assert!(discover_skills(tmp.path(), &[]).is_empty());
    }

    #[test]
    fn discovery_prompt_contains_metadata_without_instruction_bodies() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "demo",
            "---\nname: demo\ndescription: Metadata label\n---\nBODY_ONLY_SENTINEL",
        );
        let skills = discover_skills(tmp.path(), &[]);
        let section = skills_prompt_section(&skills);
        assert!(section.contains("- demo: Metadata label"));
        assert!(!section.contains("BODY_ONLY_SENTINEL"));
    }

    #[test]
    fn prompt_section_truncates() {
        assert_eq!(skills_prompt_section(&[]), "");
        let preserved = Skill {
            name: "mid".into(),
            description: "d".repeat(925),
            path: PathBuf::new(),
            dir: PathBuf::new(),
            source: SkillSource::User,
        };
        let oversized = Skill {
            name: "n".into(),
            description: "d".repeat(1500),
            path: PathBuf::new(),
            dir: PathBuf::new(),
            source: SkillSource::User,
        };
        let section = skills_prompt_section(&[preserved, oversized]);
        assert!(section.starts_with("# Skills"));
        assert!(section.contains("`skill` tool"));
        assert!(section
            .lines()
            .any(|l| l == format!("- mid: {}", "d".repeat(925))));
        assert!(section
            .lines()
            .any(|l| l.starts_with("- n: ") && l.ends_with('…') && l.chars().count() <= 1032));
    }

    #[test]
    fn truncate_chars_preserves_utf8_and_sentence_or_word_boundaries() {
        let exact = "tiếng Việt buổi tiếp đống".repeat(40);
        assert!(exact.chars().count() <= MAX_DESCRIPTION_CHARS);
        assert_eq!(truncate_chars(&exact, MAX_DESCRIPTION_CHARS), exact);

        let sentence_text =
            "Suy luận lỗi gõ phím tiếng Việt (buổi, tiếp, đống). Phần sau vượt quá giới hạn ký tự cho phép.";
        let truncated_sentence = truncate_chars(sentence_text, 65);
        assert_eq!(
            truncated_sentence,
            "Suy luận lỗi gõ phím tiếng Việt (buổi, tiếp, đống).…"
        );

        let word_text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let truncated_word = truncate_chars(word_text, 44);
        assert_eq!(truncated_word, "alpha beta gamma delta epsilon zeta eta…");

        let early_abbrev = format!("e.g. {}", "x".repeat(120));
        let truncated_abbrev = truncate_chars(&early_abbrev, 80);
        assert_eq!(truncated_abbrev.chars().count(), 81);
        assert!(truncated_abbrev.ends_with('…'));
    }

    #[tokio::test]
    async fn skill_tool_loads_and_errors() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "demo",
            "---\nname: demo\ndescription: d\n---\n# Body\nuse scripts/run.sh",
        );
        let dir = tmp.path().join(".omnia/skills/demo");
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("scripts/run.sh"), "echo").unwrap();
        let tool = SkillTool::new(discover_skills(tmp.path(), &[]));
        let ctx = ToolContext::new(tmp.path());
        let out = tool
            .call(&ctx, json!({"name": "demo", "args": "x"}))
            .await
            .unwrap();
        assert!(!out.is_error);
        let crate::Block::Text { text } = &out.content[0] else {
            panic!()
        };
        assert!(text.starts_with("Base directory for this skill:"));
        assert!(text.contains("# Body"));
        assert!(!text.contains("description: d"));
        assert!(text.contains("- scripts/run.sh"));
        assert!(text.contains("Arguments: x"));
        let out = tool.call(&ctx, json!({"name": "nope"})).await.unwrap();
        assert!(out.is_error);
        let crate::Block::Text { text } = &out.content[0] else {
            panic!()
        };
        assert!(text.contains("demo"));
    }

    #[tokio::test]
    async fn skill_tool_rechecks_size_after_discovery() {
        let tmp = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "demo",
            "---\nname: demo\ndescription: d\n---\n# Original body",
        );
        let tool = SkillTool::new(discover_skills(tmp.path(), &[]));
        std::fs::write(
            tmp.path().join(".omnia/skills/demo/SKILL.md"),
            "x".repeat(MAX_SKILL_FILE_BYTES as usize + 1),
        )
        .unwrap();
        let out = tool
            .call(&ToolContext::new(tmp.path()), json!({"name": "demo"}))
            .await
            .unwrap();
        assert!(out.is_error);
        let crate::Block::Text { text } = &out.content[0] else {
            panic!()
        };
        assert!(text.contains("256 KiB"));
        assert!(!text.contains(&"x".repeat(1024)));
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn skill_tool_rejects_instruction_file_symlink_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "demo",
            "---\nname: demo\n---\n",
        );
        let tool = SkillTool::new(discover_skills(tmp.path(), &[]));
        let path = tmp.path().join(".omnia/skills/demo/SKILL.md");
        let secret = outside.path().join("private.md");
        std::fs::write(&secret, "EXTERNAL_BODY_SENTINEL").unwrap();
        std::fs::remove_file(&path).unwrap();
        let Err(error) = try_link_file(&secret, &path) else {
            let out = tool
                .call(&ToolContext::new(tmp.path()), json!({"name": "demo"}))
                .await
                .unwrap();
            assert!(out.is_error);
            let crate::Block::Text { text } = &out.content[0] else {
                panic!()
            };
            assert!(text.contains("Skill paths must stay inside"));
            assert!(!text.contains("EXTERNAL_BODY_SENTINEL"));
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
        return;
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn skill_tool_rejects_directory_symlink_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_skill(
            tmp.path(),
            ".omnia/skills",
            "demo",
            "---\nname: demo\n---\n",
        );
        let tool = SkillTool::new(discover_skills(tmp.path(), &[]));
        let dir = tmp.path().join(".omnia/skills/demo");
        std::fs::rename(&dir, tmp.path().join(".omnia/skills/previous-demo")).unwrap();
        std::fs::write(outside.path().join("SKILL.md"), "EXTERNAL_BODY_SENTINEL").unwrap();
        let Err(error) = try_link_directory(outside.path(), &dir) else {
            let out = tool
                .call(&ToolContext::new(tmp.path()), json!({"name": "demo"}))
                .await
                .unwrap();
            assert!(out.is_error);
            let crate::Block::Text { text } = &out.content[0] else {
                panic!()
            };
            assert!(text.contains("Skill paths must stay inside"));
            assert!(!text.contains("EXTERNAL_BODY_SENTINEL"));
            return;
        };
        if symlink_fixture_available(&error) {
            panic!("symlink fixture failed: {error}");
        }
        return;
    }

    #[tokio::test]
    async fn skill_tool_rejects_unbounded_or_control_character_name_input() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = SkillTool::new(Vec::new());
        for name in [
            "x".repeat(MAX_SKILL_NAME_CHARS + 1),
            "bad\u{0000}name".to_owned(),
        ] {
            let result = tool
                .call(&ToolContext::new(tmp.path()), json!({"name": name}))
                .await;
            assert!(matches!(result, Err(HarnessError::InvalidInput(_))));
        }
    }
}
