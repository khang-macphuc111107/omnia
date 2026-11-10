//! Snapshot-based workspace executable configuration trust. The bytes approved
//! are the bytes parsed; never re-read project config after checking its digest.
use crate::error::{NativeError, NativeResult};
use crate::harness_store::HarnessStore;
use omnia_harness::hooks::{HookConfig, HookMatcher};
use omnia_harness::mcp::{expand_env, expand_plugin_server, McpServerConfig, McpTransportConfig};
use omnia_harness::plugins::{self, PluginScope};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ConfigSource {
    pub path: String,
    pub scope: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceTrust {
    pub cwd: String,
    pub fingerprint: String,
    pub trusted: bool,
    pub sources: Vec<ConfigSource>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// `settings.json`: `hooks` key.
    Hooks,
    /// `mcp.json`.
    Mcp,
    /// Plugin `hooks.json` (bound to its plugin root).
    PluginHooks,
    /// Plugin `mcp.json` (servers prefixed, bound to its plugin root).
    PluginMcp,
    /// Plugin manifest: only hashed so a changed plugin needs re-approval.
    PluginManifest,
    /// `lsp.json`: names language-server executables. Project bytes require
    /// trust and both scopes are parsed directly from this immutable snapshot.
    Lsp,
    /// `.omnia/permissions.json`: the project's permission rules. Hashed into
    /// the fingerprint (a repository must not be able to pre-approve its own
    /// tool calls) and parsed by [`ConfigSnapshot::project_permission_rules`].
    Permissions,
}
/// The workspace's `.omnia/permissions.json` as captured in a snapshot.
pub struct ProjectRules {
    pub path: String,
    pub exists: bool,
    /// Whether this exact file content is trusted (rules apply only if so).
    pub trusted: bool,
    pub rules: Vec<omnia_harness::permission::PermissionRule>,
    /// Why the file could not be parsed, if it could not.
    pub error: Option<String>,
}
struct ConfigFile {
    path: PathBuf,
    project: bool,
    kind: Kind,
    /// Plugin name and root for the `Plugin*` kinds.
    plugin: Option<(String, PathBuf)>,
    bytes: Vec<u8>,
}
pub struct ConfigSnapshot {
    pub(super) cwd: PathBuf,
    files: Vec<ConfigFile>,
    fingerprint: String,
    cache_key: String,
    /// Enabled plugins seen when the snapshot was captured.
    plugins: Vec<plugins::Plugin>,
}
fn invalid(error: impl std::fmt::Display) -> NativeError {
    NativeError::new("workspace_config_invalid", error.to_string())
}
impl ConfigSnapshot {
    pub fn capture(cwd: &Path, user: Option<&Path>) -> NativeResult<Self> {
        let cwd = dunce::canonicalize(cwd).map_err(invalid)?;
        type Entry = (PathBuf, bool, Kind, Option<(String, PathBuf)>);
        let mut paths: Vec<Entry> = Vec::new();
        if let Some(user) = user {
            paths.push((user.join("settings.json"), false, Kind::Hooks, None));
            paths.push((user.join("mcp.json"), false, Kind::Mcp, None));
            paths.push((user.join("lsp.json"), false, Kind::Lsp, None));
        }
        paths.extend([
            (cwd.join(".omnia/settings.json"), true, Kind::Hooks, None),
            (
                cwd.join(".omnia/settings.local.json"),
                true,
                Kind::Hooks,
                None,
            ),
            (cwd.join(".mcp.json"), true, Kind::Mcp, None),
            (cwd.join(".omnia/mcp.json"), true, Kind::Mcp, None),
            (cwd.join(".omnia/lsp.json"), true, Kind::Lsp, None),
            (
                cwd.join(super::perms::PROJECT_FILE),
                true,
                Kind::Permissions,
                None,
            ),
        ]);
        // Enabled plugins contribute their executable configuration. Project
        // plugins are hashed into the project fingerprint, so they need the
        // same exact-snapshot approval as other project hooks/MCP servers.
        let enabled_plugins: Vec<plugins::Plugin> = plugins::discover_plugins(user, Some(&cwd))
            .into_iter()
            .filter(|plugin| plugin.enabled)
            .collect();
        for plugin in &enabled_plugins {
            let project = plugin.scope == PluginScope::Project;
            let who = Some((plugin.name.clone(), plugin.path.clone()));
            paths.push((
                plugin.manifest_path.clone(),
                project,
                Kind::PluginManifest,
                who.clone(),
            ));
            if let Some(file) = plugin.hooks_file() {
                paths.push((file, project, Kind::PluginHooks, who.clone()));
            }
            if let Some(file) = plugin.mcp_file() {
                paths.push((file, project, Kind::PluginMcp, who));
            }
        }
        let mut project_hash = Sha256::new();
        let mut all_hash = Sha256::new();
        let mut files = Vec::new();
        for (path, project, kind, plugin) in paths {
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(invalid(format!("{}: {e}", path.display()))),
            };
            // Bound executable configuration parsing; malformed files fail closed.
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(invalid("Configuration exceeds 4 MiB"));
            }
            {
                let hash = &mut all_hash;
                hash.update(path.to_string_lossy().as_bytes());
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(&bytes);
            }
            if project {
                project_hash.update(path.to_string_lossy().as_bytes());
                project_hash.update((bytes.len() as u64).to_le_bytes());
                project_hash.update(&bytes);
            }
            files.push(ConfigFile {
                path,
                project,
                kind,
                plugin,
                bytes,
            });
        }
        Ok(Self {
            cwd,
            files,
            fingerprint: format!("{:x}", project_hash.finalize()),
            cache_key: format!("{:x}", all_hash.finalize()),
            plugins: enabled_plugins,
        })
    }
    /// Enabled plugins whose content may be used now: user plugins always,
    /// project plugins only while this workspace snapshot is trusted.
    pub fn active_plugins(&self, store: &HarnessStore) -> Vec<plugins::Plugin> {
        let trusted = self.status(store).map(|s| s.trusted).unwrap_or(false);
        self.plugins
            .iter()
            .filter(|plugin| trusted || plugin.scope == PluginScope::User)
            .cloned()
            .collect()
    }
    pub fn cache_key(&self) -> &str {
        &self.cache_key
    }
    /// Inspects installed plugin connectors from the exact bytes captured for
    /// trust. It does not initialize MCP, read a secret store, or grant access.
    pub fn plugin_connection_receipts(
        &self,
        store: &HarnessStore,
    ) -> NativeResult<Vec<crate::plugin_connections::PluginConnectionReceipt>> {
        let trusted = self.status(store)?.trusted;
        let mut receipts = Vec::new();
        for file in self
            .files
            .iter()
            .filter(|file| file.kind == Kind::PluginMcp)
        {
            let Some((name, _)) = file.plugin.as_ref() else {
                continue;
            };
            let Some(plugin) = self.plugins.iter().find(|plugin| &plugin.name == name) else {
                continue;
            };
            receipts.extend(crate::plugin_connections::inspect_plugin_connections(
                plugin,
                &file.bytes,
                &self.cache_key,
                &self.fingerprint,
                trusted,
                &|key| std::env::var(key).ok(),
            )?);
        }
        Ok(receipts)
    }
    pub fn status(&self, store: &HarnessStore) -> NativeResult<WorkspaceTrust> {
        let cwd = self.cwd.to_string_lossy().into_owned();
        let trusted = !self.files.iter().any(|f| f.project)
            || store.workspace_trusted(&cwd, &self.fingerprint)?;
        Ok(WorkspaceTrust {
            cwd,
            fingerprint: self.fingerprint.clone(),
            trusted,
            sources: self
                .files
                .iter()
                .map(|f| ConfigSource {
                    path: f.path.to_string_lossy().into_owned(),
                    scope: if f.project { "project" } else { "user" }.into(),
                })
                .collect(),
        })
    }
    /// The project's permission rules. They are listed even when untrusted
    /// (so the user can review them) but `rules` must only be applied when
    /// `trusted`; use [`Self::honored_permission_rules`] for that.
    pub fn project_permission_rules(&self, store: &HarnessStore) -> ProjectRules {
        let path = self
            .cwd
            .join(super::perms::PROJECT_FILE)
            .to_string_lossy()
            .into_owned();
        let trusted = self.status(store).map(|s| s.trusted).unwrap_or(false);
        let Some(file) = self.files.iter().find(|f| f.kind == Kind::Permissions) else {
            return ProjectRules {
                path,
                exists: false,
                trusted,
                rules: Vec::new(),
                error: None,
            };
        };
        match super::perms::parse_rules_file(&file.bytes) {
            Ok(rules) => ProjectRules {
                path,
                exists: true,
                trusted,
                rules,
                error: None,
            },
            Err(error) => ProjectRules {
                path,
                exists: true,
                trusted,
                rules: Vec::new(),
                error: Some(error),
            },
        }
    }
    /// Project rules to apply to a run: none unless the snapshot is trusted,
    /// and a trusted but unparsable file fails closed (it might hold deny rules).
    pub fn honored_permission_rules(
        &self,
        store: &HarnessStore,
    ) -> NativeResult<Vec<omnia_harness::permission::PermissionRule>> {
        let project = self.project_permission_rules(store);
        if !project.trusted {
            return Ok(Vec::new());
        }
        match project.error {
            Some(error) => Err(invalid(format!("{}: {error}", project.path))),
            None => Ok(project.rules),
        }
    }
    pub fn require_trust(&self, store: &HarnessStore) -> NativeResult<()> {
        if !self.status(store)?.trusted {
            return Err(NativeError::new("workspace_trust_required", "Review and trust this workspace's executable hooks/MCP configuration before running it"));
        }
        Ok(())
    }
    /// Resolves LSP executable definitions from the same bytes included in the
    /// trust fingerprint. A missing config stays absent for this run; the LSP
    /// manager must not re-read the project/user file later during dispatch.
    pub fn lsp_specs(&self, store: &HarnessStore) -> NativeResult<omnia_harness::lsp::LoadedSpecs> {
        self.require_trust(store)?;
        let project = self
            .files
            .iter()
            .find(|file| file.kind == Kind::Lsp && file.project);
        let user = self
            .files
            .iter()
            .find(|file| file.kind == Kind::Lsp && !file.project);
        Ok(omnia_harness::lsp::load_specs_from_snapshot(
            &self.cwd,
            project.map(|file| file.bytes.as_slice()),
            user.map(|file| (file.path.as_path(), file.bytes.as_slice())),
        ))
    }
    pub fn configurations(
        &self,
        store: &HarnessStore,
    ) -> NativeResult<(HookConfig, Vec<(String, McpServerConfig)>)> {
        self.require_trust(store)?;
        let mut hooks = HookConfig::default();
        let mut servers = BTreeMap::new();
        for file in &self.files {
            if matches!(
                file.kind,
                Kind::PluginManifest | Kind::Lsp | Kind::Permissions
            ) {
                continue;
            }
            let text = std::str::from_utf8(&file.bytes).map_err(invalid)?;
            let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|e| invalid(format!("{}: {e}", file.path.display())))?;
            if !root.is_object() {
                return Err(invalid("Configuration must be a JSON object"));
            }
            if let (Kind::PluginHooks, Some((_, plugin_root))) = (file.kind, &file.plugin) {
                let map = plugins::bind_hooks(&root, plugin_root)
                    .map_err(|e| invalid(format!("{}: {e}", file.path.display())))?;
                for (event, groups) in map {
                    hooks.hooks.entry(event).or_default().extend(groups);
                }
            } else if let (Kind::PluginMcp, Some((plugin_name, plugin_root))) =
                (file.kind, &file.plugin)
            {
                let value = root.get("mcpServers").or_else(|| root.get("servers"));
                let map = match value {
                    None => continue,
                    Some(value) => value
                        .as_object()
                        .ok_or_else(|| invalid("MCP servers must be an object"))?,
                };
                for (name, value) in map {
                    let (name, config) =
                        expand_plugin_server(plugin_name, plugin_root, name, value, &|key| {
                            std::env::var(key).ok()
                        })
                        .map_err(invalid)?;
                    servers.insert(name, config);
                }
            } else if file.kind == Kind::Hooks {
                if let Some(value) = root.get("hooks") {
                    let map: BTreeMap<String, Vec<HookMatcher>> =
                        serde_json::from_value(value.clone()).map_err(invalid)?;
                    for (event, groups) in map {
                        hooks.hooks.entry(event).or_default().extend(groups);
                    }
                }
            } else if let Some(value) = root.get("mcpServers").or_else(|| root.get("servers")) {
                let map = value
                    .as_object()
                    .ok_or_else(|| invalid("MCP servers must be an object"))?;
                for (name, value) in map {
                    let mut config: McpServerConfig =
                        serde_json::from_value(value.clone()).map_err(invalid)?;
                    let ex = |s: &mut String| *s = expand_env(s, &|key| std::env::var(key).ok());
                    match &mut config.transport {
                        McpTransportConfig::Stdio {
                            command,
                            args,
                            env,
                            cwd,
                        } => {
                            ex(command);
                            args.iter_mut().for_each(ex);
                            env.values_mut().for_each(ex);
                            if let Some(dir) = cwd {
                                ex(dir);
                                if Path::new(dir).is_relative() {
                                    *dir = self.cwd.join(&*dir).to_string_lossy().into_owned();
                                }
                            }
                        }
                        McpTransportConfig::Http { url, headers, .. } => {
                            ex(url);
                            headers.values_mut().for_each(ex);
                        }
                    }
                    servers.insert(name.clone(), config);
                }
            }
        }
        Ok((
            hooks,
            servers
                .into_iter()
                .filter(|(_, config)| !config.disabled)
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_requires_explicit_exact_snapshot_trust_user_does_not() {
        let dir = std::env::temp_dir().join(format!("omnia-trust-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        let user = dir.join("user");
        std::fs::create_dir_all(ws.join(".omnia")).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        std::fs::write(user.join("settings.json"), r#"{"hooks":{}}"#).unwrap();
        let store = HarnessStore::in_memory().unwrap();
        assert!(
            ConfigSnapshot::capture(&ws, Some(&user))
                .unwrap()
                .status(&store)
                .unwrap()
                .trusted
        );
        let file = ws.join(".omnia/settings.json");
        std::fs::write(&file, r#"{"hooks":{}}"#).unwrap();
        let snapshot = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        assert!(snapshot.configurations(&store).is_err());
        let status = snapshot.status(&store).unwrap();
        store
            .set_workspace_trust(&status.cwd, Some(&status.fingerprint))
            .unwrap();
        assert!(snapshot.configurations(&store).is_ok());
        std::fs::write(&file, r#"{"hooks":{"Stop":[]}}"#).unwrap();
        assert!(ConfigSnapshot::capture(&ws, Some(&user))
            .unwrap()
            .configurations(&store)
            .is_err());
        // Previously approved immutable bytes remain safe even if the disk changed.
        assert!(snapshot.configurations(&store).unwrap().0.hooks.is_empty());
        store.set_workspace_trust(&status.cwd, None).unwrap();
        assert!(snapshot.configurations(&store).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn project_lsp_config_is_fingerprinted_and_requires_trust() {
        let dir = std::env::temp_dir().join(format!("omnia-trust-lsp-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        std::fs::create_dir_all(ws.join(".omnia")).unwrap();
        let store = HarnessStore::in_memory().unwrap();
        let none = ConfigSnapshot::capture(&ws, None)
            .unwrap()
            .status(&store)
            .unwrap();
        assert!(none.trusted);
        let file = ws.join(".omnia/lsp.json");
        std::fs::write(
            &file,
            r#"{"servers":{"x":{"command":"a","extensions":["snap"]}}}"#,
        )
        .unwrap();
        let first = ConfigSnapshot::capture(&ws, None).unwrap();
        let status = first.status(&store).unwrap();
        assert!(!status.trusted, "a project lsp.json must be reviewed");
        assert_ne!(status.fingerprint, none.fingerprint);
        assert!(status
            .sources
            .iter()
            .any(|s| s.path.ends_with("lsp.json") && s.scope == "project"));
        store
            .set_workspace_trust(&status.cwd, Some(&status.fingerprint))
            .unwrap();
        assert!(first.status(&store).unwrap().trusted);
        assert_eq!(first.lsp_specs(&store).unwrap().specs[0].command, "a");
        // The LSP file is hashed only; it must not break hook/MCP parsing.
        assert!(first.configurations(&store).is_ok());
        std::fs::write(
            &file,
            r#"{"servers":{"x":{"command":"b","extensions":["snap"]}}}"#,
        )
        .unwrap();
        // The approved snapshot's immutable bytes remain authoritative.
        assert_eq!(first.lsp_specs(&store).unwrap().specs[0].command, "a");
        let edited = ConfigSnapshot::capture(&ws, None).unwrap();
        assert!(edited.lsp_specs(&store).is_err());
        let changed = edited.status(&store).unwrap();
        assert_ne!(changed.fingerprint, status.fingerprint);
        assert!(!changed.trusted, "changing lsp.json re-prompts");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lsp_user_config_and_absent_project_config_are_snapshotted() {
        let dir =
            std::env::temp_dir().join(format!("omnia-trust-lsp-user-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        let user = dir.join("user");
        std::fs::create_dir_all(ws.join(".omnia")).unwrap();
        std::fs::create_dir_all(&user).unwrap();
        let user_file = user.join("lsp.json");
        std::fs::write(
            &user_file,
            r#"{"servers":{"user":{"command":"original","extensions":["snap"]}}}"#,
        )
        .unwrap();
        let store = HarnessStore::in_memory().unwrap();
        let snapshot = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        let before = snapshot.cache_key().to_string();
        assert!(snapshot.status(&store).unwrap().trusted);
        std::fs::write(
            &user_file,
            r#"{"servers":{"user":{"command":"changed","extensions":["snap"]}}}"#,
        )
        .unwrap();
        std::fs::write(
            ws.join(".omnia/lsp.json"),
            r#"{"servers":{"late":{"command":"unapproved","extensions":["late"]}}}"#,
        )
        .unwrap();
        let specs = snapshot.lsp_specs(&store).unwrap();
        assert_eq!(specs.specs[0].command, "original");
        assert!(!specs.specs.iter().any(|spec| spec.name == "late"));
        let changed = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        assert_ne!(changed.cache_key(), before);
        assert!(!changed.status(&store).unwrap().trusted);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn project_permission_rules_are_fingerprinted_and_gated_by_trust() {
        use omnia_harness::permission::{PermissionRule, RuleAction};
        let dir = std::env::temp_dir().join(format!("omnia-trust-perm-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        std::fs::create_dir_all(ws.join(".omnia")).unwrap();
        let store = HarnessStore::in_memory().unwrap();
        let none = ConfigSnapshot::capture(&ws, None).unwrap();
        assert!(none.honored_permission_rules(&store).unwrap().is_empty());
        let before = none.status(&store).unwrap();
        assert!(before.trusted);

        let rules = vec![PermissionRule::new(
            "shell",
            Some("re:^npm "),
            RuleAction::Allow,
        )];
        super::super::perms::write_project_rules(&ws, &rules).unwrap();
        let snapshot = ConfigSnapshot::capture(&ws, None).unwrap();
        let status = snapshot.status(&store).unwrap();
        assert!(
            !status.trusted,
            "a project permissions.json must be reviewed"
        );
        assert_ne!(status.fingerprint, before.fingerprint);
        assert!(status
            .sources
            .iter()
            .any(|s| s.path.ends_with("permissions.json") && s.scope == "project"));
        // Listed for review, but not honored, until trusted.
        let listed = snapshot.project_permission_rules(&store);
        assert!(listed.exists && !listed.trusted && listed.rules == rules);
        assert!(snapshot
            .honored_permission_rules(&store)
            .unwrap()
            .is_empty());
        assert!(snapshot.configurations(&store).is_err());

        store
            .set_workspace_trust(&status.cwd, Some(&status.fingerprint))
            .unwrap();
        assert_eq!(snapshot.honored_permission_rules(&store).unwrap(), rules);
        // The rules file is hashed only; it must not break hook/MCP parsing.
        assert!(snapshot.configurations(&store).is_ok());

        // Editing the file behind the app's back revokes trust and the rules.
        std::fs::write(
            ws.join(super::super::perms::PROJECT_FILE),
            r#"{"rules":[{"tool":"*","action":"allow"}]}"#,
        )
        .unwrap();
        let edited = ConfigSnapshot::capture(&ws, None).unwrap();
        assert!(!edited.status(&store).unwrap().trusted);
        assert!(edited.honored_permission_rules(&store).unwrap().is_empty());

        // A trusted but malformed file fails closed instead of dropping deny rules.
        std::fs::write(ws.join(super::super::perms::PROJECT_FILE), "{broken").unwrap();
        let broken = ConfigSnapshot::capture(&ws, None).unwrap();
        let status = broken.status(&store).unwrap();
        store
            .set_workspace_trust(&status.cwd, Some(&status.fingerprint))
            .unwrap();
        assert!(broken.honored_permission_rules(&store).is_err());
        assert!(broken.project_permission_rules(&store).error.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn write_plugin(dir: &Path, name: &str, command: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("omnia-plugin.json"),
            format!(r#"{{"name":"{name}"}}"#),
        )
        .unwrap();
        std::fs::write(
            dir.join("hooks.json"),
            format!(r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"{command}"}}]}}]}}}}"#),
        )
        .unwrap();
        std::fs::write(
            dir.join("mcp.json"),
            r#"{"mcpServers":{"srv":{"command":"node","args":["${OMNIA_PLUGIN_ROOT}/s.js"]}}}"#,
        )
        .unwrap();
    }

    #[test]
    fn plugins_feed_hooks_and_mcp_with_project_plugins_gated_by_trust() {
        let dir = std::env::temp_dir().join(format!("omnia-trust-plugin-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        let user = dir.join("user");
        std::fs::create_dir_all(&ws).unwrap();
        write_plugin(
            &user.join("plugins/mine"),
            "mine",
            "echo user ${OMNIA_PLUGIN_ROOT}",
        );
        let store = HarnessStore::in_memory().unwrap();

        // User plugins run without a trust prompt and are namespaced.
        let snapshot = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        let (hooks, servers) = snapshot.configurations(&store).unwrap();
        let command = &hooks.hooks["Stop"][0].hooks[0];
        assert!(command.command.starts_with("echo user ") && !command.command.contains("${"));
        assert!(command.plugin_root.is_some());
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].0, "plugin:mine:srv");
        let key_user_only = snapshot.cache_key().to_owned();

        // A project plugin needs exact-snapshot trust.
        write_plugin(&ws.join(".omnia/plugins/proj"), "proj", "echo project");
        let snapshot = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        assert!(snapshot.configurations(&store).is_err());
        let status = snapshot.status(&store).unwrap();
        store
            .set_workspace_trust(&status.cwd, Some(&status.fingerprint))
            .unwrap();
        let (hooks, servers) = snapshot.configurations(&store).unwrap();
        assert_eq!(hooks.hooks["Stop"].len(), 2);
        assert_eq!(servers.len(), 2);
        assert_ne!(snapshot.cache_key(), key_user_only);

        // Editing the project plugin's MCP config revokes approval and changes the cache key.
        let key_before = snapshot.cache_key().to_owned();
        std::fs::write(
            ws.join(".omnia/plugins/proj/mcp.json"),
            r#"{"mcpServers":{"srv":{"command":"evil"}}}"#,
        )
        .unwrap();
        let edited = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        assert_ne!(edited.cache_key(), key_before);
        assert!(edited.configurations(&store).is_err());

        // Disabling the project plugin removes its contributions and the prompt.
        omnia_harness::plugins::set_enabled(&user, "proj", false).unwrap();
        let disabled = ConfigSnapshot::capture(&ws, Some(&user)).unwrap();
        let (hooks, servers) = disabled.configurations(&store).unwrap();
        assert_eq!(hooks.hooks["Stop"].len(), 1);
        assert_eq!(servers.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn connector_receipts_use_captured_bytes_and_exact_snapshot_trust() {
        use crate::plugin_connections::PluginConnectionState;
        let dir =
            std::env::temp_dir().join(format!("omnia-connector-receipts-{}", uuid::Uuid::new_v4()));
        let ws = dir.join("workspace");
        let root = ws.join(".omnia/plugins/github");
        write_plugin(&root, "github", "echo project");
        let store = HarnessStore::in_memory().unwrap();
        let snapshot = ConfigSnapshot::capture(&ws, None).unwrap();
        let before = snapshot.plugin_connection_receipts(&store).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(
            before[0].state,
            PluginConnectionState::WorkspaceTrustRequired
        );
        let status = snapshot.status(&store).unwrap();
        store
            .set_workspace_trust(&status.cwd, Some(&status.fingerprint))
            .unwrap();
        let approved = snapshot.plugin_connection_receipts(&store).unwrap();
        assert_eq!(approved[0].state, PluginConnectionState::Configured);
        assert_ne!(approved[0].receipt_id, before[0].receipt_id);
        std::fs::write(
            root.join("mcp.json"),
            r#"{"mcpServers":{"srv":{"command":"changed-executable"}}}"#,
        )
        .unwrap();
        // The old object stays bound to the bytes reviewed, including its hash.
        let held = snapshot.plugin_connection_receipts(&store).unwrap();
        assert_eq!(held[0].receipt_id, approved[0].receipt_id);
        let changed = ConfigSnapshot::capture(&ws, None).unwrap();
        let next = changed.plugin_connection_receipts(&store).unwrap();
        assert_eq!(next[0].state, PluginConnectionState::WorkspaceTrustRequired);
        assert_ne!(
            next[0].configuration_sha256,
            approved[0].configuration_sha256
        );
        assert_ne!(
            next[0].configuration_snapshot_sha256,
            approved[0].configuration_snapshot_sha256
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
