//! Tauri commands for managing plugins (`~/.omnia/plugins`). Discovery and the
//! install/uninstall file operations live in `omnia_harness::plugins`; this
//! module adds the renderer-facing request shapes, git cloning and path
//! validation. Plugins take effect on the next run (the MCP cache key changes
//! whenever an enabled plugin's files do, see `harness_trust.rs`).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use omnia_harness::plugins::{self, Plugin, PluginContents, PluginError};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{NativeError, NativeResult};
use crate::harness_bridge::{omnia_home, require_id, validate_cwd, HarnessHub};

const GIT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_SOURCE_CHARS: usize = 2048;

fn plugin_error(error: PluginError) -> NativeError {
    NativeError::new(error.code(), error.to_string())
}

fn home() -> NativeResult<PathBuf> {
    omnia_home()
        .ok_or_else(|| NativeError::new("plugin_home_unavailable", "Cannot locate ~/.omnia"))
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Option<String>,
    pub scope: plugins::PluginScope,
    pub path: String,
    pub enabled: bool,
    pub contents: PluginContents,
}

impl From<Plugin> for PluginInfo {
    fn from(plugin: Plugin) -> Self {
        Self {
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            author: plugin.author,
            scope: plugin.scope,
            path: plugin.path.to_string_lossy().into_owned(),
            enabled: plugin.enabled,
            contents: plugin.contents,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginsListRequest {
    #[serde(default)]
    pub session_id: Option<String>,
}

/// Lists user plugins plus, when a session is given, the plugins of its folder.
#[tauri::command]
pub fn agent_plugins_list(
    hub: State<'_, HarnessHub>,
    request: AgentPluginsListRequest,
) -> NativeResult<Vec<PluginInfo>> {
    let cwd = match request.session_id.as_deref().map(str::trim) {
        Some(id) if !id.is_empty() => {
            let id = require_id(id, "sessionId")?;
            Some(validate_cwd(&hub.store().summary(&id)?.cwd)?)
        }
        _ => None,
    };
    Ok(
        plugins::discover_plugins(omnia_home().as_deref(), cwd.as_deref())
            .into_iter()
            .map(PluginInfo::from)
            .collect(),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginSetEnabledRequest {
    pub name: String,
    pub enabled: bool,
}

#[tauri::command]
pub fn agent_plugin_set_enabled(request: AgentPluginSetEnabledRequest) -> NativeResult<()> {
    plugins::set_enabled(&home()?, request.name.trim(), request.enabled).map_err(plugin_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginInstallRequest {
    /// Absolute local folder, or a git URL (`https://`, `ssh://`, `git@host:`).
    pub source: String,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Source {
    Folder(PathBuf),
    Git(String),
}

fn classify_source(source: &str) -> NativeResult<Source> {
    let source = source.trim();
    if source.is_empty() || source.chars().count() > MAX_SOURCE_CHARS {
        return Err(NativeError::invalid("source", "is empty or too long"));
    }
    if source.chars().any(char::is_control) {
        return Err(NativeError::invalid(
            "source",
            "contains control characters",
        ));
    }
    let lower = source.to_ascii_lowercase();
    let remote = ["https://", "http://", "ssh://", "git://", "git@"]
        .iter()
        .any(|prefix| lower.starts_with(prefix));
    if remote {
        if source.chars().any(char::is_whitespace) {
            return Err(NativeError::invalid(
                "source",
                "git URL must not contain spaces",
            ));
        }
        return Ok(Source::Git(source.to_owned()));
    }
    let path = PathBuf::from(source);
    if !path.is_absolute() {
        return Err(NativeError::invalid(
            "source",
            "must be an absolute folder path or a git URL",
        ));
    }
    Ok(Source::Folder(path))
}

/// Removes the temporary clone folder on every exit path.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git_clone(url: &str, dest: &Path) -> NativeResult<()> {
    let mut cmd = std::process::Command::new("git");
    cmd.args([
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "protocol.file.allow=never",
        "clone",
        "--depth",
        "1",
        "--quiet",
        "--no-tags",
        "--",
        url,
    ])
    .arg(dest)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped())
    .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            NativeError::new("plugin_git_missing", "git was not found on PATH")
        } else {
            NativeError::new("plugin_git_failed", format!("Cannot run git: {error}"))
        }
    })?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.take(8 * 1024).read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > GIT_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(NativeError::new(
                    "plugin_git_timeout",
                    "git clone timed out after 3 minutes",
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                return Err(NativeError::new("plugin_git_failed", error.to_string()));
            }
        }
    };
    let output = reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let detail = output.trim();
        Err(NativeError::new(
            "plugin_git_failed",
            format!(
                "git clone failed{}{}",
                if detail.is_empty() { "" } else { ": " },
                detail
            ),
        ))
    }
}

/// Installs from a validated source into `omnia_home`. Blocking.
fn install_blocking(omnia_home: &Path, source: &str, replace: bool) -> NativeResult<Plugin> {
    match classify_source(source)? {
        Source::Folder(path) => {
            plugins::install_from_dir(omnia_home, &path, replace).map_err(plugin_error)
        }
        Source::Git(url) => {
            let temp = TempDir(std::env::temp_dir().join(format!(
                "omnia-plugin-clone-{}",
                uuid::Uuid::new_v4().simple()
            )));
            git_clone(&url, &temp.0)?;
            plugins::install_from_dir(omnia_home, &temp.0, replace).map_err(plugin_error)
        }
    }
}

#[tauri::command]
pub async fn agent_plugin_install(request: AgentPluginInstallRequest) -> NativeResult<PluginInfo> {
    let home = home()?;
    tauri::async_runtime::spawn_blocking(move || {
        install_blocking(&home, &request.source, request.replace)
    })
    .await
    .map_err(|error| NativeError::new("plugin_install_failed", error.to_string()))?
    .map(PluginInfo::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginUninstallRequest {
    pub name: String,
}

/// User-scope plugins only; the folder is moved to `plugins/.trash`.
#[tauri::command]
pub fn agent_plugin_uninstall(request: AgentPluginUninstallRequest) -> NativeResult<()> {
    plugins::uninstall(&home()?, request.name.trim())
        .map(|_| ())
        .map_err(plugin_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn scratch() -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "omnia-plugin-bridge-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn sample(dir: &Path, name: &str) {
        write(
            &dir.join("omnia-plugin.json"),
            &format!(r#"{{"name":"{name}","version":"0.1.0","description":"d"}}"#),
        );
        write(&dir.join("skills/s/SKILL.md"), "---\nname: s\n---\nbody");
    }

    #[test]
    fn classifies_sources() {
        assert_eq!(
            classify_source(" https://github.com/a/b.git ").unwrap(),
            Source::Git("https://github.com/a/b.git".into())
        );
        assert!(matches!(
            classify_source("git@github.com:a/b.git").unwrap(),
            Source::Git(_)
        ));
        assert!(matches!(
            classify_source("ssh://git@host/a/b").unwrap(),
            Source::Git(_)
        ));
        let abs = std::env::temp_dir();
        assert_eq!(
            classify_source(&abs.to_string_lossy()).unwrap(),
            Source::Folder(abs)
        );
        for bad in [
            "",
            "   ",
            "relative/dir",
            "..",
            "-oProxyCommand=x",
            "ext::sh -c touch /tmp/x",
            "https://host/a b",
            "https://host/a\nb",
        ] {
            assert!(classify_source(bad).is_err(), "{bad:?}");
        }
        assert!(classify_source(&"x".repeat(MAX_SOURCE_CHARS + 1)).is_err());
    }

    #[test]
    fn install_uninstall_roundtrip_through_the_bridge_layer() {
        let tmp = scratch();
        let home = tmp.0.join("home");
        let src = tmp.0.join("src");
        sample(&src, "demo");
        let source = src.to_string_lossy().into_owned();

        let plugin = install_blocking(&home, &source, false).unwrap();
        let info = PluginInfo::from(plugin);
        assert_eq!(info.name, "demo");
        assert_eq!(info.scope, plugins::PluginScope::User);
        assert!(info.enabled);
        assert_eq!(info.contents.skills, 1);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["scope"], "user");
        assert_eq!(json["contents"]["mcpServers"], 0);

        let error = install_blocking(&home, &source, false).unwrap_err();
        assert_eq!(error.code, "plugin_already_installed");
        install_blocking(&home, &source, true).unwrap();

        plugins::set_enabled(&home, "demo", false).unwrap();
        let listed = plugins::discover_plugins(Some(&home), None);
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);

        plugins::uninstall(&home, "demo").unwrap();
        assert!(plugins::discover_plugins(Some(&home), None).is_empty());
        let trash = plugins::plugins_dir(&home).join(".trash");
        // One entry from the replace, one from the uninstall.
        assert_eq!(std::fs::read_dir(trash).unwrap().count(), 2);
    }

    #[test]
    fn rejects_invalid_folders_and_names() {
        let tmp = scratch();
        let home = tmp.0.join("home");
        let missing = tmp.0.join("missing");
        let error = install_blocking(&home, &missing.to_string_lossy(), false).unwrap_err();
        assert_eq!(error.code, "plugin_io_failed");

        let bad = tmp.0.join("bad");
        write(&bad.join("omnia-plugin.json"), r#"{"name":"../escape"}"#);
        let error = install_blocking(&home, &bad.to_string_lossy(), false).unwrap_err();
        assert_eq!(error.code, "plugin_invalid");
        assert!(!home.join("escape").exists());
        assert!(!tmp.0.join("escape").exists());

        assert_eq!(
            plugins::uninstall(&home, "../home").unwrap_err().code(),
            "plugin_invalid"
        );
        assert_eq!(
            plugins::set_enabled(&home, "a/b", true).unwrap_err().code(),
            "plugin_invalid"
        );
    }
}
