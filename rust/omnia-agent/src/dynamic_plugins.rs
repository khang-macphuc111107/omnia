//! Cordis Dynamic Reversible Plugin Loader, Creator Mode & Fault Quarantine.
//!
//! Loads hot-discoverable workspace plugins (`.omnia/plugins/<id>/plugin.json`),
//! scaffolds new plugins cleanly in Creator Mode, maintains reversible rollback
//! snapshots, and automatically quarantines plugins that cross fault thresholds.

use crate::hooks::{HookRegistry, HookSpec};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_FAULT_THRESHOLD: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicPluginStatus {
    Active,
    Disabled,
    Quarantined,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicPluginToolDef {
    pub name: String,
    pub description: String,
    #[serde(default = "default_tool_schema")]
    pub parameters: Value,
    /// Shell/command template executed with JSON args passed on stdin + `OMNIA_PLUGIN_ARGS`? (stdin only to avoid arg leakage).
    pub command: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default = "default_plugin_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_tool_schema() -> Value {
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": true
    })
}

const fn default_plugin_timeout_ms() -> u64 {
    15_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicPluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tools: Vec<DynamicPluginToolDef>,
    #[serde(default)]
    pub hooks: Vec<HookSpec>,
    #[serde(default = "default_fault_threshold")]
    pub max_consecutive_faults: u32,
    #[serde(default = "default_enabled_true")]
    pub enabled_by_default: bool,
}

fn default_version() -> String {
    "0.1.0".into()
}

const fn default_fault_threshold() -> u32 {
    DEFAULT_FAULT_THRESHOLD
}

const fn default_enabled_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicPluginState {
    pub manifest: DynamicPluginManifest,
    pub root_dir: PathBuf,
    pub status: DynamicPluginStatus,
    pub consecutive_faults: u32,
    pub total_faults: u64,
    pub total_successes: u64,
    pub last_error: Option<String>,
    pub quarantined_at_ms: Option<u64>,
    pub revision: u64,
}

#[derive(Debug, Clone)]
struct PluginRollbackEntry {
    previous_status: DynamicPluginStatus,
    previous_manifest: DynamicPluginManifest,
    hook_ids: Vec<String>,
}

/// Manages Cordis dynamic reversible plugins with fault quarantine & Creator Mode.
#[derive(Clone)]
pub struct CordisPluginManager {
    workspace_root: PathBuf,
    plugins: Arc<RwLock<HashMap<String, DynamicPluginState>>>,
    rollback_history: Arc<RwLock<HashMap<String, Vec<PluginRollbackEntry>>>>,
}

impl std::fmt::Debug for CordisPluginManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.plugins.read().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("CordisPluginManager")
            .field("workspace_root", &self.workspace_root)
            .field("loaded_plugins", &count)
            .finish()
    }
}

impl CordisPluginManager {
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            plugins: Arc::new(RwLock::new(HashMap::new())),
            rollback_history: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Discovers dynamic plugins under `.omnia/plugins/<id>/plugin.json` and `.omp/plugins/<id>/plugin.json`.
    pub fn discover(&self, hooks: Option<&HookRegistry>) -> Result<Vec<DynamicPluginState>> {
        let roots = [
            self.workspace_root.join(".omnia").join("plugins"),
            self.workspace_root.join(".omp").join("plugins"),
        ];
        let mut discovered = Vec::new();
        for base in roots {
            if !base.is_dir() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&base) else {
                continue;
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let manifest_path = dir.join("plugin.json");
                if !manifest_path.is_file() {
                    continue;
                }
                let raw = std::fs::read_to_string(&manifest_path)
                    .with_context(|| format!("read {}", manifest_path.display()))?;
                let manifest: DynamicPluginManifest = serde_json::from_str(&raw)
                    .with_context(|| format!("parse {}", manifest_path.display()))?;
                validate_plugin_id(&manifest.id)?;
                let state = self.register_manifest(manifest, dir, hooks)?;
                discovered.push(state);
            }
        }
        Ok(discovered)
    }

    /// Creator Mode: scaffolds a clean dynamic plugin manifest on disk under `.omnia/plugins/<id>/`
    /// and immediately loads it as an active reversible plugin.
    pub fn create_scaffold(
        &self,
        id: &str,
        name: &str,
        description: &str,
        tool: Option<DynamicPluginToolDef>,
        hook: Option<HookSpec>,
        hooks: Option<&HookRegistry>,
    ) -> Result<DynamicPluginState> {
        validate_plugin_id(id)?;
        let plugin_dir = self.workspace_root.join(".omnia").join("plugins").join(id);
        std::fs::create_dir_all(&plugin_dir)
            .with_context(|| format!("create plugin dir {}", plugin_dir.display()))?;

        let manifest = DynamicPluginManifest {
            id: id.to_owned(),
            name: name.to_owned(),
            version: "0.1.0".into(),
            description: description.to_owned(),
            tools: tool.into_iter().collect(),
            hooks: hook.into_iter().collect(),
            max_consecutive_faults: DEFAULT_FAULT_THRESHOLD,
            enabled_by_default: true,
        };
        let manifest_path = plugin_dir.join("plugin.json");
        let serialized = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
        std::fs::write(&manifest_path, serialized)
            .with_context(|| format!("write {}", manifest_path.display()))?;

        self.register_manifest(manifest, plugin_dir, hooks)
    }

    pub fn register_manifest(
        &self,
        manifest: DynamicPluginManifest,
        root_dir: PathBuf,
        hooks: Option<&HookRegistry>,
    ) -> Result<DynamicPluginState> {
        validate_plugin_id(&manifest.id)?;
        let id = manifest.id.clone();

        let previous = self
            .plugins
            .read()
            .ok()
            .and_then(|map| map.get(&id).cloned());
        if let Some(prev) = &previous {
            let entry = PluginRollbackEntry {
                previous_status: prev.status,
                previous_manifest: prev.manifest.clone(),
                hook_ids: prev
                    .manifest
                    .hooks
                    .iter()
                    .map(|h| scoped_hook_id(&id, &h.id))
                    .collect(),
            };
            if let Ok(mut hist) = self.rollback_history.write() {
                hist.entry(id.clone()).or_default().push(entry);
            }
        }

        let status = if manifest.enabled_by_default {
            DynamicPluginStatus::Active
        } else {
            DynamicPluginStatus::Disabled
        };

        if let Some(hook_reg) = hooks {
            for h in &manifest.hooks {
                let mut scoped = h.clone();
                scoped.id = scoped_hook_id(&id, &h.id);
                scoped.enabled = status == DynamicPluginStatus::Active && h.enabled;
                if scoped.source.is_empty() {
                    scoped.source = format!("plugin:{id}");
                }
                hook_reg.register_command(scoped);
            }
        }

        let revision = previous.map_or(1, |p| p.revision + 1);
        let state = DynamicPluginState {
            manifest,
            root_dir,
            status,
            consecutive_faults: 0,
            total_faults: 0,
            total_successes: 0,
            last_error: None,
            quarantined_at_ms: None,
            revision,
        };
        if let Ok(mut map) = self.plugins.write() {
            map.insert(id, state.clone());
        }
        Ok(state)
    }

    /// Toggles plugin enabled/disabled cleanly while keeping reversible state.
    pub fn set_enabled(
        &self,
        id: &str,
        enabled: bool,
        hooks: Option<&HookRegistry>,
    ) -> Result<DynamicPluginState> {
        let mut map = self
            .plugins
            .write()
            .map_err(|_| anyhow::anyhow!("plugins lock poisoned"))?;
        let state = map
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown dynamic plugin `{id}`"))?;
        state.status = if enabled {
            state.consecutive_faults = 0;
            state.quarantined_at_ms = None;
            DynamicPluginStatus::Active
        } else {
            DynamicPluginStatus::Disabled
        };
        if let Some(hook_reg) = hooks {
            for h in &state.manifest.hooks {
                hook_reg.set_enabled(&scoped_hook_id(id, &h.id), enabled);
            }
        }
        Ok(state.clone())
    }

    /// Records a successful execution, resetting consecutive fault count.
    pub fn record_success(&self, id: &str) {
        if let Ok(mut map) = self.plugins.write() {
            if let Some(st) = map.get_mut(id) {
                st.consecutive_faults = 0;
                st.total_successes += 1;
            }
        }
    }

    /// Records a fault; if consecutive faults reach `max_consecutive_faults`,
    /// automatically quarantines the plugin and disables its hooks/tools.
    pub fn record_fault(
        &self,
        id: &str,
        error: &str,
        hooks: Option<&HookRegistry>,
    ) -> Option<DynamicPluginState> {
        let mut map = self.plugins.write().ok()?;
        let st = map.get_mut(id)?;
        st.consecutive_faults += 1;
        st.total_faults += 1;
        st.last_error = Some(error.to_owned());
        let threshold = st.manifest.max_consecutive_faults.max(1);
        if st.consecutive_faults >= threshold && st.status == DynamicPluginStatus::Active {
            st.status = DynamicPluginStatus::Quarantined;
            st.quarantined_at_ms = Some(now_epoch_ms());
            if let Some(hook_reg) = hooks {
                for h in &st.manifest.hooks {
                    hook_reg.set_enabled(&scoped_hook_id(id, &h.id), false);
                }
            }
        }
        Some(st.clone())
    }

    /// Reversibly rolls back the plugin to its previous manifest/status snapshot (or disables it).
    pub fn rollback(&self, id: &str, hooks: Option<&HookRegistry>) -> Result<DynamicPluginState> {
        let prev = self
            .rollback_history
            .write()
            .ok()
            .and_then(|mut h| h.get_mut(id).and_then(Vec::pop));
        let Some(entry) = prev else {
            return self.set_enabled(id, false, hooks);
        };

        let mut map = self
            .plugins
            .write()
            .map_err(|_| anyhow::anyhow!("plugins lock poisoned"))?;
        let state = map
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown dynamic plugin `{id}`"))?;
        if let Some(hook_reg) = hooks {
            for old_hid in &entry.hook_ids {
                hook_reg.set_enabled(old_hid, false);
            }
            for h in &entry.previous_manifest.hooks {
                let mut restored = h.clone();
                restored.id = scoped_hook_id(id, &h.id);
                restored.enabled = entry.previous_status == DynamicPluginStatus::Active && h.enabled;
                hook_reg.register_command(restored);
            }
        }
        state.manifest = entry.previous_manifest;
        state.status = entry.previous_status;
        state.consecutive_faults = 0;
        state.quarantined_at_ms = None;
        state.revision += 1;
        Ok(state.clone())
    }

    #[must_use]
    pub fn list(&self) -> Vec<DynamicPluginState> {
        let mut out: Vec<DynamicPluginState> = self
            .plugins
            .read()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
        out
    }

    #[must_use]
    pub fn active_tools(&self) -> Vec<(String, DynamicPluginToolDef)> {
        let mut out = Vec::new();
        if let Ok(map) = self.plugins.read() {
            for (pid, st) in map.iter() {
                if st.status == DynamicPluginStatus::Active {
                    for tool in &st.manifest.tools {
                        out.push((pid.clone(), tool.clone()));
                    }
                }
            }
        }
        out
    }
}

fn validate_plugin_id(id: &str) -> Result<()> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        bail!("invalid dynamic plugin id `{id}` (allowed: [A-Za-z0-9_-], max 64 chars)");
    }
    Ok(())
}

fn scoped_hook_id(plugin_id: &str, hook_id: &str) -> String {
    format!("plugin:{plugin_id}:{hook_id}")
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::HookEvent;

    #[test]
    fn creator_mode_reversible_rollback_and_fault_quarantine() {
        let tmp = std::env::temp_dir().join(format!("omnia_dyn_plugin_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("mkdir");

        let hooks = HookRegistry::new(&tmp);
        let mgr = CordisPluginManager::new(&tmp);

        let v1 = mgr
            .create_scaffold(
                "lint_guard",
                "Lint Guard",
                "Checks style on edits",
                None,
                Some(HookSpec {
                    id: "check".into(),
                    event: HookEvent::PreToolUse,
                    matcher: Some("edit_file".into()),
                    command: "echo ok".into(),
                    timeout_ms: 2_000,
                    enabled: true,
                    fail_closed: false,
                    source: String::new(),
                }),
                Some(&hooks),
            )
            .expect("scaffold v1");
        assert_eq!(v1.status, DynamicPluginStatus::Active);

        // Push v2 update
        let mut v2_manifest = v1.manifest.clone();
        v2_manifest.version = "0.2.0".into();
        let v2 = mgr
            .register_manifest(v2_manifest, v1.root_dir.clone(), Some(&hooks))
            .expect("v2");
        assert_eq!(v2.manifest.version, "0.2.0");

        // Trigger 3 consecutive faults -> automatic quarantine + hooks disabled
        for i in 1..=3 {
            let st = mgr
                .record_fault("lint_guard", &format!("fault #{i}"), Some(&hooks))
                .expect("plugin exists");
            if i < 3 {
                assert_eq!(st.status, DynamicPluginStatus::Active);
            } else {
                assert_eq!(st.status, DynamicPluginStatus::Quarantined);
            }
        }
        assert!(hooks
            .list()
            .into_iter()
            .all(|h| !h.enabled));

        // Reversible rollback restores v1 cleanly
        let restored = mgr.rollback("lint_guard", Some(&hooks)).expect("rollback");
        assert_eq!(restored.manifest.version, "0.1.0");
        assert_eq!(restored.status, DynamicPluginStatus::Active);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
