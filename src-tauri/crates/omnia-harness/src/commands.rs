//! Custom slash commands: Markdown prompt templates discovered from
//! `<workspace>/.omnia/commands`, `<workspace>/.claude/commands` and the user
//! directories. `/name args` in a user message expands to the file body.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::skills::{frontmatter_value, split_frontmatter};

const MAX_COMMAND_FILE_BYTES: u64 = 256 * 1024;
const MAX_WALK_DEPTH: usize = 4;
const MAX_COMMANDS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandSource {
    Project,
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommand {
    /// File stem; files in subdirectories are named `dir:name`.
    pub name: String,
    pub description: String,
    pub argument_hint: String,
    /// Prompt template (file content without frontmatter).
    pub body: String,
    pub path: PathBuf,
    pub source: CommandSource,
}

fn parse_command(root: &Path, path: &Path, source: CommandSource) -> Option<CustomCommand> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_COMMAND_FILE_BYTES {
        return None;
    }
    let relative = path.strip_prefix(root).ok()?.with_extension("");
    let parts: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let name = parts.join(":");
    if name.is_empty() || name.chars().any(char::is_whitespace) {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let (front, body) = split_frontmatter(&content);
    let description = frontmatter_value(&front, "description")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            body.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(|line| {
                    line.trim_start_matches('#')
                        .trim()
                        .chars()
                        .take(100)
                        .collect()
                })
                .unwrap_or_default()
        });
    let argument_hint = frontmatter_value(&front, "argument-hint").unwrap_or_default();
    Some(CustomCommand {
        name,
        description,
        argument_hint,
        body: body.to_string(),
        path: path.to_path_buf(),
        source,
    })
}

fn scan(
    root: &Path,
    dir: &Path,
    depth: usize,
    source: CommandSource,
    out: &mut Vec<CustomCommand>,
) {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_COMMANDS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            scan(root, &path, depth + 1, source, out);
        } else if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            if let Some(command) = parse_command(root, &path, source) {
                out.push(command);
            }
        }
    }
}

/// Discovers commands. Project commands win over user commands on a name
/// clash; among project dirs `.omnia` wins over `.claude`.
pub fn discover_commands(workspace: &Path, user_dirs: &[PathBuf]) -> Vec<CustomCommand> {
    let mut found = Vec::new();
    for sub in [".omnia/commands", ".claude/commands"] {
        let root = workspace.join(sub);
        scan(&root, &root, 0, CommandSource::Project, &mut found);
    }
    for root in user_dirs {
        scan(root, root, 0, CommandSource::User, &mut found);
    }
    let mut seen = HashSet::new();
    let mut commands: Vec<CustomCommand> = found
        .into_iter()
        .filter(|command| seen.insert(command.name.clone()))
        .collect();
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

/// [`discover_commands`] plus the `commands/` folders of enabled plugins, which
/// rank below workspace and user commands on a name clash.
pub fn discover_commands_with_plugins(
    workspace: &Path,
    user_dirs: &[PathBuf],
    plugin_dirs: &[PathBuf],
) -> Vec<CustomCommand> {
    let mut dirs = user_dirs.to_vec();
    dirs.extend_from_slice(plugin_dirs);
    discover_commands(workspace, &dirs)
}

/// Splits arguments on whitespace; `"double"` and `'single'` quotes group words.
fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for ch in args.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started || !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => current.push(ch),
        }
    }
    if started || !current.is_empty() {
        out.push(current);
    }
    out
}

fn substitute(body: &str, args: &str) -> String {
    let positional = split_args(args);
    let mut used = false;
    let mut out = String::with_capacity(body.len() + args.len());
    let mut rest = body;
    while let Some(index) = rest.find('$') {
        out.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        if let Some(tail) = after.strip_prefix("ARGUMENTS") {
            out.push_str(args);
            used = true;
            rest = tail;
        } else if let Some(digit) = after.chars().next().filter(|c| ('1'..='9').contains(c)) {
            let n = digit as usize - '1' as usize;
            out.push_str(positional.get(n).map(String::as_str).unwrap_or(""));
            used = true;
            rest = &after[1..];
        } else {
            out.push('$');
            rest = after;
        }
    }
    out.push_str(rest);
    if !used && !args.is_empty() {
        out.push_str(&format!("\n\nARGUMENTS: {args}"));
    }
    out
}

/// Expands `/name args` into the command's body, or `None` when `text` is not
/// a known command.
pub fn expand(text: &str, commands: &[CustomCommand]) -> Option<String> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix('/')?;
    let (name, args) = match rest.find(char::is_whitespace) {
        Some(index) => (&rest[..index], rest[index..].trim()),
        None => (rest, ""),
    };
    let command = commands.iter().find(|command| command.name == name)?;
    Some(substitute(command.body.trim_matches(['\r', '\n']), args))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn discovers_with_precedence_and_subdirs() {
        let ws = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            ws.path(),
            ".omnia/commands/review.md",
            "---\ndescription: Review code\nargument-hint: <file>\nmodel: x\n---\nReview $1 please\n",
        );
        write(ws.path(), ".claude/commands/review.md", "claude version");
        write(
            ws.path(),
            ".claude/commands/git/sync.md",
            "# Sync things\nsync",
        );
        write(home.path(), "review.md", "user version");
        write(home.path(), "global.md", "global body");
        write(home.path(), "notes.txt", "ignored");
        let commands = discover_commands(ws.path(), &[home.path().to_path_buf()]);
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["git:sync", "global", "review"]);
        let review = &commands[2];
        assert_eq!(review.description, "Review code");
        assert_eq!(review.argument_hint, "<file>");
        assert_eq!(review.source, CommandSource::Project);
        assert_eq!(review.body.trim(), "Review $1 please");
        assert_eq!(commands[0].description, "Sync things");
        assert_eq!(commands[1].source, CommandSource::User);
    }

    fn command(name: &str, body: &str) -> CustomCommand {
        CustomCommand {
            name: name.into(),
            description: String::new(),
            argument_hint: String::new(),
            body: body.into(),
            path: PathBuf::new(),
            source: CommandSource::Project,
        }
    }

    #[test]
    fn expands_arguments() {
        let commands = vec![
            command("fix", "Fix $1 in $2 ($ARGUMENTS) cost $5 $9"),
            command("plain", "Do the thing"),
            command("git:sync", "sync"),
        ];
        assert_eq!(
            expand("/fix bug \"src/a b.rs\" now", &commands).unwrap(),
            "Fix bug in src/a b.rs (bug \"src/a b.rs\" now) cost  "
        );
        assert_eq!(expand("  /plain  ", &commands).unwrap(), "Do the thing");
        assert_eq!(
            expand("/plain extra words", &commands).unwrap(),
            "Do the thing\n\nARGUMENTS: extra words"
        );
        assert_eq!(expand("/git:sync", &commands).unwrap(), "sync");
        assert!(expand("/unknown x", &commands).is_none());
        assert!(expand("hello /fix", &commands).is_none());
        assert!(expand("/", &commands).is_none());
    }

    #[test]
    fn leaves_lone_dollar_alone() {
        let commands = vec![command("p", "cost $ and $0 and $x")];
        assert_eq!(expand("/p", &commands).unwrap(), "cost $ and $0 and $x");
    }
}
