//! Plugins: folders bundling skills, agents, commands, hooks and MCP servers.
//!
//! ```text
//! my-plugin/
//!   omnia-plugin.json      {"name","version","description","author"?}
//!   (or .claude-plugin/plugin.json)
//!   skills/<skill>/SKILL.md
//!   agents/<agent>.md
//!   commands/<command>.md
//!   hooks.json             {"hooks": {...}}      same schema as settings.json
//!   mcp.json               {"mcpServers": {...}} same schema as mcp.json
//! ```
//!
//! Plugins live in `~/.omnia/plugins/*` (user scope) and
//! `<workspace>/.omnia/plugins/*` (project scope). Enabled state is kept in
//! `~/.omnia/plugins.json` (`{"enabled": {"name": false}}`, default enabled).
//! Hook and MCP commands may reference the plugin folder through
//! `${OMNIA_PLUGIN_ROOT}`; hooks and stdio MCP servers also get it as an
//! environment variable. Whether project plugins may run is a trust decision
//! that belongs to the caller (see the desktop bridge).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::hooks::HookMatcher;

/// Environment variable / substitution token naming the plugin folder.
pub const ROOT_ENV: &str = "OMNIA_PLUGIN_ROOT";
/// Manifest locations, in order of preference (relative to the plugin root).
pub const MANIFEST_PATHS: [&str; 2] = ["omnia-plugin.json", ".claude-plugin/plugin.json"];

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 64;
const MAX_INSTALL_FILES: usize = 5_000;
const MAX_INSTALL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_INSTALL_DEPTH: usize = 12;
const MAX_COUNT_DEPTH: usize = 4;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("{0}")]
    Invalid(String),
    #[error("plugin `{0}` is already installed")]
    AlreadyInstalled(String),
    #[error("plugin `{0}` is not installed")]
    NotFound(String),
    #[error("{0}")]
    Io(String),
}

impl PluginError {
    /// Stable machine-readable code for the renderer.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "plugin_invalid",
            Self::AlreadyInstalled(_) => "plugin_already_installed",
            Self::NotFound(_) => "plugin_not_found",
            Self::Io(_) => "plugin_io_failed",
        }
    }
}

fn io_error(context: &Path, error: std::io::Error) -> PluginError {
    PluginError::Io(format!("{}: {error}", context.display()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginScope {
    User,
    Project,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContents {
    pub skills: usize,
    pub agents: usize,
    pub commands: usize,
    pub hooks: usize,
    pub mcp_servers: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    pub scope: PluginScope,
    /// Plugin root folder.
    pub path: PathBuf,
    /// Manifest file that was read.
    pub manifest_path: PathBuf,
    pub enabled: bool,
    pub contents: PluginContents,
}

impl Plugin {
    /// `skills`, `agents` or `commands` folder if it exists.
    pub fn dir(&self, kind: &str) -> Option<PathBuf> {
        let dir = self.path.join(kind);
        dir.is_dir().then_some(dir)
    }

    pub fn hooks_file(&self) -> Option<PathBuf> {
        let file = self.path.join("hooks.json");
        file.is_file().then_some(file)
    }

    pub fn mcp_file(&self) -> Option<PathBuf> {
        let file = self.path.join("mcp.json");
        file.is_file().then_some(file)
    }
}

/// A plugin name is a safe folder name: ASCII letters, digits, `-`, `_`, `.`,
/// at most 64 characters, not starting with `.`.
pub fn validate_name(name: &str) -> Result<(), PluginError> {
    let ok = !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(PluginError::Invalid(format!(
            "invalid plugin name `{name}`: use letters, digits, `-`, `_`, `.` (max {MAX_NAME_CHARS}, not starting with `.`)"
        )))
    }
}

/// Reads a JSON object file (BOM tolerant, size bounded).
pub fn read_json_object(path: &Path) -> Result<Value, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.len() > MAX_CONFIG_BYTES {
        return Err(format!("{}: larger than 4 MiB", path.display()));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{}: must be a JSON object", path.display()));
    }
    Ok(value)
}

/// Replaces `${OMNIA_PLUGIN_ROOT}` in `text`.
pub fn substitute_root(text: &str, root: &Path) -> String {
    text.replace(&format!("${{{ROOT_ENV}}}"), &root.to_string_lossy())
}

/// Parses the `hooks` key of a plugin `hooks.json` (missing = no hooks) and
/// binds every command to `root`: `${OMNIA_PLUGIN_ROOT}` is substituted and
/// the runner exports `OMNIA_PLUGIN_ROOT`.
pub fn bind_hooks(
    value: &Value,
    root: &Path,
) -> Result<BTreeMap<String, Vec<HookMatcher>>, String> {
    let Some(hooks) = value.get("hooks") else {
        return Ok(BTreeMap::new());
    };
    let mut map: BTreeMap<String, Vec<HookMatcher>> =
        serde_json::from_value(hooks.clone()).map_err(|e| format!("invalid `hooks`: {e}"))?;
    for group in map.values_mut().flatten() {
        for hook in &mut group.hooks {
            hook.command = substitute_root(&hook.command, root);
            hook.plugin_root = Some(root.to_path_buf());
        }
    }
    Ok(map)
}

fn manifest_author(value: &Value) -> Option<String> {
    match value.get("author")? {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Object(map) => map
            .get("name")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(|text| text.trim().to_owned()),
        _ => None,
    }
}

/// Finds and parses the manifest of the plugin rooted at `dir`.
pub fn read_manifest(dir: &Path) -> Result<(PluginManifest, PathBuf), PluginError> {
    let path = MANIFEST_PATHS
        .iter()
        .map(|relative| dir.join(relative))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            PluginError::Invalid(format!(
                "{}: missing omnia-plugin.json (or .claude-plugin/plugin.json)",
                dir.display()
            ))
        })?;
    let value = read_json_object(&path).map_err(PluginError::Invalid)?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(|text| text.trim().to_owned())
    };
    let name = text("name")
        .ok_or_else(|| PluginError::Invalid(format!("{}: missing `name`", path.display())))?;
    validate_name(&name)?;
    Ok((
        PluginManifest {
            name,
            version: text("version").unwrap_or_else(|| "0.0.0".to_owned()),
            description: text("description").unwrap_or_default(),
            author: manifest_author(&value),
        },
        path,
    ))
}

fn count_markdown(dir: &Path, depth: usize) -> usize {
    if depth > MAX_COUNT_DEPTH {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .map(|path| {
            if path.is_dir() {
                count_markdown(&path, depth + 1)
            } else {
                usize::from(
                    path.extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md")),
                )
            }
        })
        .sum()
}

fn count_contents(dir: &Path) -> PluginContents {
    let skills = std::fs::read_dir(dir.join("skills"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().join("SKILL.md").is_file())
                .count()
        })
        .unwrap_or(0);
    let agents = std::fs::read_dir(dir.join("agents"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                })
                .count()
        })
        .unwrap_or(0);
    let hooks = read_json_object(&dir.join("hooks.json"))
        .ok()
        .and_then(|value| bind_hooks(&value, dir).ok())
        .map(|map| map.values().flatten().map(|group| group.hooks.len()).sum())
        .unwrap_or(0);
    let mcp_servers = read_json_object(&dir.join("mcp.json"))
        .ok()
        .and_then(|value| {
            value
                .get("mcpServers")
                .or_else(|| value.get("servers"))
                .and_then(Value::as_object)
                .map(serde_json::Map::len)
        })
        .unwrap_or(0);
    PluginContents {
        skills,
        agents,
        commands: count_markdown(&dir.join("commands"), 0),
        hooks,
        mcp_servers,
    }
}

/// `~/.omnia/plugins`.
pub fn plugins_dir(omnia_home: &Path) -> PathBuf {
    omnia_home.join("plugins")
}

fn state_file(omnia_home: &Path) -> PathBuf {
    omnia_home.join("plugins.json")
}

/// Explicit enabled flags from `plugins.json`; absent names default to enabled.
pub fn read_enabled_state(omnia_home: Option<&Path>) -> BTreeMap<String, bool> {
    let Some(home) = omnia_home else {
        return BTreeMap::new();
    };
    let Ok(value) = read_json_object(&state_file(home)) else {
        return BTreeMap::new();
    };
    value
        .get("enabled")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(name, flag)| Some((name.clone(), flag.as_bool()?)))
                .collect()
        })
        .unwrap_or_default()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), PluginError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_error(parent, e))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, text).map_err(|e| io_error(&tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_error(path, e)
    })
}

/// Persists the enabled flag of `name` in `plugins.json`.
pub fn set_enabled(omnia_home: &Path, name: &str, enabled: bool) -> Result<(), PluginError> {
    validate_name(name)?;
    let mut root = read_json_object(&state_file(omnia_home)).unwrap_or_else(|_| json!({}));
    let flags = root
        .as_object_mut()
        .expect("read_json_object returns an object")
        .entry("enabled")
        .or_insert_with(|| json!({}));
    if !flags.is_object() {
        *flags = json!({});
    }
    flags[name] = json!(enabled);
    let text = serde_json::to_string_pretty(&root).map_err(|e| PluginError::Io(e.to_string()))?;
    write_atomic(&state_file(omnia_home), &text)
}

fn forget_enabled(omnia_home: &Path, name: &str) -> Result<(), PluginError> {
    let Ok(mut root) = read_json_object(&state_file(omnia_home)) else {
        return Ok(());
    };
    let removed = root
        .get_mut("enabled")
        .and_then(Value::as_object_mut)
        .is_some_and(|flags| flags.remove(name).is_some());
    if removed {
        let text =
            serde_json::to_string_pretty(&root).map_err(|e| PluginError::Io(e.to_string()))?;
        write_atomic(&state_file(omnia_home), &text)?;
    }
    Ok(())
}

fn load_plugin(
    dir: &Path,
    scope: PluginScope,
    enabled_state: &BTreeMap<String, bool>,
) -> Option<Plugin> {
    let (manifest, manifest_path) = read_manifest(dir).ok()?;
    Some(Plugin {
        enabled: enabled_state.get(&manifest.name).copied().unwrap_or(true),
        contents: count_contents(dir),
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        scope,
        path: dir.to_path_buf(),
        manifest_path,
    })
}

fn scan_scope(
    root: &Path,
    scope: PluginScope,
    state: &BTreeMap<String, bool>,
    out: &mut Vec<Plugin>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        if let Some(plugin) = load_plugin(&dir, scope, state) {
            // Project plugins override user plugins of the same name.
            out.retain(|existing| existing.name != plugin.name);
            out.push(plugin);
        }
    }
}

/// Finds plugins in `<omnia_home>/plugins/*` and `<cwd>/.omnia/plugins/*`,
/// sorted by name. Disabled plugins are included (`enabled == false`); callers
/// decide what to load. Project plugins are only *discovered* here; running
/// their hooks/MCP servers requires workspace trust, which the caller checks.
pub fn discover_plugins(omnia_home: Option<&Path>, cwd: Option<&Path>) -> Vec<Plugin> {
    let state = read_enabled_state(omnia_home);
    let mut plugins = Vec::new();
    if let Some(home) = omnia_home {
        scan_scope(&plugins_dir(home), PluginScope::User, &state, &mut plugins);
    }
    if let Some(cwd) = cwd {
        scan_scope(
            &cwd.join(".omnia").join("plugins"),
            PluginScope::Project,
            &state,
            &mut plugins,
        );
    }
    plugins.sort_by(|a, b| a.name.cmp(&b.name));
    plugins
}

/// `skills`/`agents`/`commands` folders of the enabled plugins.
pub fn plugin_dirs(plugins: &[Plugin], kind: &str) -> Vec<PathBuf> {
    plugins
        .iter()
        .filter(|plugin| plugin.enabled)
        .filter_map(|plugin| plugin.dir(kind))
        .collect()
}

// ---- install / uninstall ----------------------------------------------------

struct Budget {
    files: usize,
    bytes: u64,
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Symlinks and junctions are both reparse points.
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn copy_file(src: &Path, dst: &Path, budget: &mut Budget) -> Result<(), PluginError> {
    budget.files += 1;
    let size = std::fs::metadata(src).map_err(|e| io_error(src, e))?.len();
    budget.bytes += size;
    if budget.files > MAX_INSTALL_FILES || budget.bytes > MAX_INSTALL_BYTES {
        return Err(PluginError::Invalid(
            "plugin is too large (limit 5000 files / 64 MiB)".into(),
        ));
    }
    std::fs::copy(src, dst).map_err(|e| io_error(src, e))?;
    Ok(())
}

/// Copies `src` into `dst`, refusing symlinks/junctions that leave
/// `root_canon` and skipping `.git`.
fn copy_tree(
    root_canon: &Path,
    src: &Path,
    dst: &Path,
    depth: usize,
    budget: &mut Budget,
) -> Result<(), PluginError> {
    if depth > MAX_INSTALL_DEPTH {
        return Err(PluginError::Invalid(
            "plugin folder nests too deeply".into(),
        ));
    }
    std::fs::create_dir_all(dst).map_err(|e| io_error(dst, e))?;
    let mut entries: Vec<_> = std::fs::read_dir(src)
        .map_err(|e| io_error(src, e))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let path = entry.path();
        let target = dst.join(&name);
        let meta = std::fs::symlink_metadata(&path).map_err(|e| io_error(&path, e))?;
        if is_link(&meta) {
            let resolved = std::fs::canonicalize(&path).map_err(|e| io_error(&path, e))?;
            if !resolved.starts_with(root_canon) {
                return Err(PluginError::Invalid(format!(
                    "{} is a link that points outside the plugin folder",
                    path.display()
                )));
            }
            if resolved.is_dir() {
                return Err(PluginError::Invalid(format!(
                    "{} is a folder link; folder links are not supported",
                    path.display()
                )));
            }
            copy_file(&resolved, &target, budget)?;
        } else if meta.is_dir() {
            copy_tree(root_canon, &path, &target, depth + 1, budget)?;
        } else if meta.is_file() {
            copy_file(&path, &target, budget)?;
        }
    }
    Ok(())
}

fn move_to_trash(omnia_home: &Path, from: &Path, name: &str) -> Result<PathBuf, PluginError> {
    let trash = plugins_dir(omnia_home).join(".trash");
    std::fs::create_dir_all(&trash).map_err(|e| io_error(&trash, e))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut target = trash.join(format!("{name}-{stamp}"));
    if target.exists() {
        target = trash.join(format!("{name}-{stamp}-{}", uuid::Uuid::new_v4().simple()));
    }
    std::fs::rename(from, &target).map_err(|e| io_error(from, e))?;
    Ok(target)
}

fn find_user_plugin(omnia_home: &Path, name: &str) -> Option<Plugin> {
    discover_plugins(Some(omnia_home), None)
        .into_iter()
        .find(|plugin| plugin.name == name)
}

/// Installs the plugin folder `source` into `<omnia_home>/plugins/<name>`.
/// Refuses to overwrite an installed plugin unless `replace` (the old copy is
/// then moved to `.trash`). Validates the manifest, bounds the size and refuses
/// links that escape the source folder. Nothing is installed on failure.
pub fn install_from_dir(
    omnia_home: &Path,
    source: &Path,
    replace: bool,
) -> Result<Plugin, PluginError> {
    let source_canon = std::fs::canonicalize(source).map_err(|e| io_error(source, e))?;
    if !source_canon.is_dir() {
        return Err(PluginError::Invalid(format!(
            "{} is not a folder",
            source.display()
        )));
    }
    let (manifest, _) = read_manifest(&source_canon)?;
    let store = plugins_dir(omnia_home);
    std::fs::create_dir_all(&store).map_err(|e| io_error(&store, e))?;
    let store_canon = std::fs::canonicalize(&store).map_err(|e| io_error(&store, e))?;
    if source_canon.starts_with(&store_canon) {
        return Err(PluginError::Invalid(
            "the source folder is already inside the plugin store".into(),
        ));
    }
    let existing = find_user_plugin(omnia_home, &manifest.name);
    let dest = existing
        .as_ref()
        .map_or_else(|| store.join(&manifest.name), |plugin| plugin.path.clone());
    let occupied = std::fs::symlink_metadata(&dest).is_ok();
    if occupied && !replace {
        return Err(PluginError::AlreadyInstalled(manifest.name));
    }

    let staging = store.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    let mut budget = Budget { files: 0, bytes: 0 };
    if let Err(error) = copy_tree(&source_canon, &source_canon, &staging, 0, &mut budget) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    if occupied {
        if let Err(error) = move_to_trash(omnia_home, &dest, &manifest.name) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    }
    if let Err(error) = std::fs::rename(&staging, &dest) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(io_error(&dest, error));
    }
    load_plugin(
        &dest,
        PluginScope::User,
        &read_enabled_state(Some(omnia_home)),
    )
    .ok_or_else(|| PluginError::Invalid("installed plugin could not be read back".into()))
}

/// Moves a user-scope plugin to `<omnia_home>/plugins/.trash/<name>-<ts>`.
/// Returns the trash location.
pub fn uninstall(omnia_home: &Path, name: &str) -> Result<PathBuf, PluginError> {
    validate_name(name)?;
    let plugin =
        find_user_plugin(omnia_home, name).ok_or_else(|| PluginError::NotFound(name.to_owned()))?;
    let trashed = move_to_trash(omnia_home, &plugin.path, name)?;
    forget_enabled(omnia_home, name)?;
    Ok(trashed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn make_plugin(dir: &Path, name: &str) {
        write(
            &dir.join("omnia-plugin.json"),
            &format!(r#"{{"name":"{name}","version":"1.2.3","description":"demo","author":"me"}}"#),
        );
        write(
            &dir.join("skills/greet/SKILL.md"),
            "---\nname: greet\ndescription: say hi\n---\nHi",
        );
        write(
            &dir.join("agents/helper.md"),
            "---\nname: helper\n---\nbe helpful",
        );
        write(&dir.join("commands/ship.md"), "ship it $ARGUMENTS");
        write(&dir.join("commands/ns/deep.md"), "deep");
        write(
            &dir.join("hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"run ${OMNIA_PLUGIN_ROOT}/x.sh"}]}]}}"#,
        );
        write(
            &dir.join("mcp.json"),
            r#"{"mcpServers":{"tool":{"command":"node","args":["${OMNIA_PLUGIN_ROOT}/srv.js"],"cwd":"sub"}}}"#,
        );
    }

    #[test]
    fn manifest_variants_and_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        write(
            &a.join(".claude-plugin/plugin.json"),
            r#"{"name":"compat","author":{"name":"Zed"}}"#,
        );
        let (manifest, _) = read_manifest(&a).unwrap();
        assert_eq!(manifest.name, "compat");
        assert_eq!(manifest.version, "0.0.0");
        assert_eq!(manifest.author.as_deref(), Some("Zed"));

        let b = tmp.path().join("b");
        write(&b.join("omnia-plugin.json"), r#"{"name":"../evil"}"#);
        assert!(read_manifest(&b).is_err());
        write(&b.join("omnia-plugin.json"), "{}");
        assert!(read_manifest(&b).is_err());
        assert!(read_manifest(&tmp.path().join("none")).is_err());
        for bad in ["", ".hidden", "a b", "a/b", "a\\b", &"x".repeat(65)] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
        assert!(validate_name("ok-name_1.2").is_ok());
    }

    #[test]
    fn discovers_scopes_counts_and_enabled_state() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cwd = tmp.path().join("ws");
        make_plugin(&home.join("plugins/alpha"), "alpha");
        make_plugin(&cwd.join(".omnia/plugins/beta"), "beta");
        make_plugin(&home.join("plugins/.trash/old"), "old");
        write(&home.join("plugins/not-a-plugin/readme.md"), "x");

        let plugins = discover_plugins(Some(&home), Some(&cwd));
        let names: Vec<_> = plugins.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"]);
        assert_eq!(plugins[0].scope, PluginScope::User);
        assert_eq!(plugins[1].scope, PluginScope::Project);
        assert!(plugins.iter().all(|p| p.enabled));
        assert_eq!(
            plugins[0].contents,
            PluginContents {
                skills: 1,
                agents: 1,
                commands: 2,
                hooks: 1,
                mcp_servers: 1
            }
        );

        set_enabled(&home, "beta", false).unwrap();
        let plugins = discover_plugins(Some(&home), Some(&cwd));
        assert!(plugins[0].enabled && !plugins[1].enabled);
        assert_eq!(plugin_dirs(&plugins, "skills").len(), 1);
        assert!(plugin_dirs(&plugins, "nope").is_empty());
        assert_eq!(discover_plugins(Some(&home), None).len(), 1);
        assert!(discover_plugins(None, None).is_empty());
    }

    #[test]
    fn project_plugin_overrides_user_plugin_of_same_name() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cwd = tmp.path().join("ws");
        make_plugin(&home.join("plugins/dup"), "dup");
        make_plugin(&cwd.join(".omnia/plugins/dup"), "dup");
        let plugins = discover_plugins(Some(&home), Some(&cwd));
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].scope, PluginScope::Project);
    }

    #[test]
    fn hooks_are_bound_to_the_plugin_root() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("p");
        make_plugin(&dir, "p");
        let value = read_json_object(&dir.join("hooks.json")).unwrap();
        let map = bind_hooks(&value, &dir).unwrap();
        let hook = &map["Stop"][0].hooks[0];
        assert_eq!(hook.command, format!("run {}/x.sh", dir.display()));
        assert_eq!(hook.plugin_root.as_deref(), Some(dir.as_path()));
        assert!(bind_hooks(&json!({"hooks": 3}), &dir).is_err());
        assert!(bind_hooks(&json!({}), &dir).unwrap().is_empty());

        // A config file cannot smuggle in its own root.
        let sneaky =
            json!({"hooks":{"Stop":[{"hooks":[{"command":"x","plugin_root":"C:/evil"}]}]}});
        assert_eq!(
            bind_hooks(&sneaky, &dir).unwrap()["Stop"][0].hooks[0]
                .plugin_root
                .as_deref(),
            Some(dir.as_path())
        );
    }

    #[test]
    fn loaders_merge_plugin_contributions() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let cwd = tmp.path().join("ws");
        fs::create_dir_all(&cwd).unwrap();
        make_plugin(&home.join("plugins/alpha"), "alpha");
        make_plugin(&home.join("plugins/gone"), "gone");
        set_enabled(&home, "gone", false).unwrap();
        let plugins = discover_plugins(Some(&home), Some(&cwd));

        let skills = crate::skills::discover_skills_with_plugins(
            &cwd,
            &[],
            &plugin_dirs(&plugins, "skills"),
        );
        assert_eq!(skills.len(), 1);
        let commands = crate::commands::discover_commands_with_plugins(
            &cwd,
            &[],
            &plugin_dirs(&plugins, "commands"),
        );
        let names: Vec<_> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["ns:deep", "ship"]);
        let agents = crate::subagent::discover_agents_with_plugins(
            &cwd,
            &[],
            &plugin_dirs(&plugins, "agents"),
        );
        assert!(agents.iter().any(|a| a.name == "helper"));

        let hooks = crate::hooks::load_hooks_with_plugins(&cwd, None, &plugins);
        assert_eq!(hooks.hooks["Stop"].len(), 1);
        assert!(hooks.hooks["Stop"][0].hooks[0].command.contains("alpha"));

        let servers = crate::mcp::load_mcp_config_with_plugins(&cwd, None, &plugins);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].0, "plugin:alpha:tool");
        match &servers[0].1.transport {
            crate::mcp::McpTransportConfig::Stdio { args, env, cwd, .. } => {
                assert!(Path::new(&args[0]).starts_with(home.join("plugins").join("alpha")));
                assert!(env.contains_key(ROOT_ENV));
                assert!(Path::new(cwd.as_deref().unwrap())
                    .starts_with(home.join("plugins").join("alpha")));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn install_copies_refuses_overwrite_and_replaces_via_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let src = tmp.path().join("src");
        make_plugin(&src, "alpha");
        write(&src.join(".git/config"), "ignored");

        let plugin = install_from_dir(&home, &src, false).unwrap();
        assert_eq!(plugin.name, "alpha");
        assert_eq!(plugin.scope, PluginScope::User);
        assert!(home.join("plugins/alpha/skills/greet/SKILL.md").is_file());
        assert!(!home.join("plugins/alpha/.git").exists());

        assert!(matches!(
            install_from_dir(&home, &src, false),
            Err(PluginError::AlreadyInstalled(_))
        ));
        write(&src.join("commands/new.md"), "new");
        let plugin = install_from_dir(&home, &src, true).unwrap();
        assert_eq!(plugin.contents.commands, 3);
        let trash: Vec<_> = fs::read_dir(home.join("plugins/.trash")).unwrap().collect();
        assert_eq!(trash.len(), 1);
        assert!(fs::read_dir(home.join("plugins"))
            .unwrap()
            .filter_map(Result::ok)
            .all(|e| !e.file_name().to_string_lossy().starts_with(".staging")));
        // Installing from inside the store is refused.
        assert!(install_from_dir(&home, &home.join("plugins/alpha"), true).is_err());
    }

    #[test]
    fn install_rejects_bad_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        assert!(install_from_dir(&home, &tmp.path().join("missing"), false).is_err());
        let file = tmp.path().join("file.txt");
        write(&file, "x");
        assert!(install_from_dir(&home, &file, false).is_err());
        let nomanifest = tmp.path().join("nm");
        write(&nomanifest.join("a.md"), "x");
        assert!(matches!(
            install_from_dir(&home, &nomanifest, false),
            Err(PluginError::Invalid(_))
        ));
        assert!(!plugins_dir(&home).join("nm").exists());
    }

    #[test]
    fn install_refuses_links_that_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let src = tmp.path().join("src");
        make_plugin(&src, "linky");
        let secret = tmp.path().join("secret.txt");
        write(&secret, "secret");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&secret, src.join("leak.txt")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&secret, src.join("leak.txt")).is_ok();
        if !linked {
            return; // symlink privilege unavailable on this machine
        }
        assert!(matches!(
            install_from_dir(&home, &src, false),
            Err(PluginError::Invalid(_))
        ));
        assert!(!plugins_dir(&home).join("linky").exists());
        assert!(fs::read_dir(plugins_dir(&home))
            .map(|entries| entries.count() == 0)
            .unwrap_or(true));
    }

    #[test]
    fn uninstall_moves_to_trash_and_clears_state() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let src = tmp.path().join("src");
        make_plugin(&src, "alpha");
        install_from_dir(&home, &src, false).unwrap();
        set_enabled(&home, "alpha", false).unwrap();

        let trashed = uninstall(&home, "alpha").unwrap();
        assert!(trashed.starts_with(home.join("plugins/.trash")));
        assert!(trashed.join("omnia-plugin.json").is_file());
        assert!(discover_plugins(Some(&home), None).is_empty());
        assert!(!read_enabled_state(Some(&home)).contains_key("alpha"));
        assert!(matches!(
            uninstall(&home, "alpha"),
            Err(PluginError::NotFound(_))
        ));
        assert!(uninstall(&home, "../x").is_err());
    }
}
