//! `mcp.json` / `.mcp.json` loading (the Claude Code / Cursor shape).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpTransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Streamable HTTP. `type` may be `http`, `streamable-http` or `sse`; the
    /// legacy HTTP+SSE transport is not implemented, all are treated alike.
    Http {
        #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(flatten)]
    pub transport: McpTransportConfig,
    #[serde(default)]
    pub disabled: bool,
}

impl McpServerConfig {
    pub fn stdio(command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            transport: McpTransportConfig::Stdio {
                command: command.into(),
                args,
                env: BTreeMap::new(),
                cwd: None,
            },
            disabled: false,
        }
    }

    pub fn http(url: impl Into<String>) -> Self {
        Self {
            transport: McpTransportConfig::Http {
                kind: Some("http".into()),
                url: url.into(),
                headers: BTreeMap::new(),
            },
            disabled: false,
        }
    }
}

/// Expand `${VAR}` and `${VAR:-default}`. Unknown variables become empty.
pub fn expand_env(input: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let expr = &after[..end];
        let (name, default) = match expr.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (expr, None),
        };
        let value = lookup(name.trim()).filter(|v| !v.is_empty());
        out.push_str(&value.unwrap_or_else(|| default.unwrap_or("").to_string()));
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn expand_config(
    cfg: &mut McpServerConfig,
    lookup: &dyn Fn(&str) -> Option<String>,
    workspace: &Path,
) {
    let ex = |s: &mut String| *s = expand_env(s, lookup);
    match &mut cfg.transport {
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
                if !dir.is_empty() && Path::new(dir.as_str()).is_relative() {
                    *dir = workspace.join(&*dir).to_string_lossy().into_owned();
                }
            }
        }
        McpTransportConfig::Http { url, headers, .. } => {
            ex(url);
            headers.values_mut().for_each(ex);
        }
    }
}

fn parse_file(
    path: &Path,
    workspace: &Path,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, McpServerConfig)> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let Ok(root) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let servers = root
        .get("mcpServers")
        .or_else(|| root.get("servers"))
        .and_then(Value::as_object);
    let Some(servers) = servers else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, value) in servers {
        // One malformed entry must not hide the others.
        if let Ok(mut cfg) = serde_json::from_value::<McpServerConfig>(value.clone()) {
            expand_config(&mut cfg, lookup, workspace);
            out.push((name.clone(), cfg));
        }
    }
    out
}

pub(crate) fn load_with(
    files: &[PathBuf],
    workspace: &Path,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Vec<(String, McpServerConfig)> {
    let mut merged: Vec<(String, McpServerConfig)> = Vec::new();
    for file in files {
        for (name, cfg) in parse_file(file, workspace, lookup) {
            match merged.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = cfg,
                None => merged.push((name, cfg)),
            }
        }
    }
    merged.retain(|(_, cfg)| !cfg.disabled);
    merged
}

/// Expands one plugin-provided server entry. `${OMNIA_PLUGIN_ROOT}` (and the
/// environment variable of the same name for stdio servers) point at the
/// plugin folder, relative `cwd` resolves against it, and the server name is
/// prefixed `plugin:<plugin>:` so it cannot collide with user servers.
pub fn expand_plugin_server(
    plugin: &str,
    plugin_root: &Path,
    server: &str,
    value: &Value,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(String, McpServerConfig), String> {
    let mut config: McpServerConfig = serde_json::from_value(value.clone())
        .map_err(|error| format!("MCP server `{server}`: {error}"))?;
    let root_text = plugin_root.to_string_lossy().into_owned();
    let layered = |name: &str| {
        if name == crate::plugins::ROOT_ENV {
            Some(root_text.clone())
        } else {
            lookup(name)
        }
    };
    expand_config(&mut config, &layered, plugin_root);
    if let McpTransportConfig::Stdio { env, .. } = &mut config.transport {
        env.insert(crate::plugins::ROOT_ENV.to_owned(), root_text.clone());
    }
    Ok((format!("plugin:{plugin}:{server}"), config))
}

/// Load MCP servers from `<user_config_dir>/mcp.json`, `<workspace>/.mcp.json`
/// and `<workspace>/.omnia/mcp.json` (later files win per server name).
/// Disabled servers are dropped; `${VAR}` is expanded from the environment.
pub fn load_mcp_config(
    workspace: &Path,
    user_config_dir: Option<&Path>,
) -> Vec<(String, McpServerConfig)> {
    load_mcp_config_with_plugins(workspace, user_config_dir, &[])
}

/// Like [`load_mcp_config`], plus each enabled plugin's `mcp.json` (servers
/// are named `plugin:<plugin>:<server>`).
pub fn load_mcp_config_with_plugins(
    workspace: &Path,
    user_config_dir: Option<&Path>,
    plugins: &[crate::plugins::Plugin],
) -> Vec<(String, McpServerConfig)> {
    let env = |name: &str| std::env::var(name).ok();
    let mut merged: Vec<(String, McpServerConfig)> = Vec::new();
    for plugin in plugins.iter().filter(|plugin| plugin.enabled) {
        let Some(file) = plugin.mcp_file() else {
            continue;
        };
        let Ok(root) = crate::plugins::read_json_object(&file) else {
            continue;
        };
        let Some(servers) = root
            .get("mcpServers")
            .or_else(|| root.get("servers"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (name, value) in servers {
            if let Ok((name, config)) =
                expand_plugin_server(&plugin.name, &plugin.path, name, value, &env)
            {
                merged.push((name, config));
            }
        }
    }
    merged.retain(|(_, cfg)| !cfg.disabled);
    for entry in load_mcp_files(workspace, user_config_dir) {
        match merged.iter_mut().find(|(n, _)| *n == entry.0) {
            Some(slot) => *slot = entry,
            None => merged.push(entry),
        }
    }
    merged
}

fn load_mcp_files(
    workspace: &Path,
    user_config_dir: Option<&Path>,
) -> Vec<(String, McpServerConfig)> {
    let mut files = Vec::new();
    if let Some(dir) = user_config_dir {
        files.push(dir.join("mcp.json"));
    }
    files.push(workspace.join(".mcp.json"));
    files.push(workspace.join(".omnia").join("mcp.json"));
    load_with(&files, workspace, &|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(name: &str) -> Option<String> {
        match name {
            "TOKEN" => Some("sekret".into()),
            "HOME_X" => Some("/home/x".into()),
            _ => None,
        }
    }

    #[test]
    fn expands_variables() {
        assert_eq!(expand_env("a-${TOKEN}-b", &lookup), "a-sekret-b");
        assert_eq!(expand_env("${NOPE}", &lookup), "");
        assert_eq!(expand_env("${NOPE:-fallback}", &lookup), "fallback");
        assert_eq!(expand_env("${TOKEN:-fallback}", &lookup), "sekret");
        assert_eq!(expand_env("no ${ close", &lookup), "no ${ close");
        assert_eq!(expand_env("plain", &lookup), "plain");
    }

    #[test]
    fn parses_both_shapes() {
        let stdio: McpServerConfig = serde_json::from_str(
            r#"{"command":"npx","args":["-y","srv"],"env":{"A":"1"},"cwd":"sub"}"#,
        )
        .unwrap();
        assert!(matches!(stdio.transport, McpTransportConfig::Stdio { .. }));
        let http: McpServerConfig = serde_json::from_str(
            r#"{"type":"streamable-http","url":"http://x/mcp","headers":{"Authorization":"Bearer t"},"disabled":true}"#,
        )
        .unwrap();
        assert!(http.disabled);
        match http.transport {
            McpTransportConfig::Http { url, headers, .. } => {
                assert_eq!(url, "http://x/mcp");
                assert_eq!(headers["Authorization"], "Bearer t");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn merges_files_later_wins_and_skips_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user.json");
        let proj = dir.path().join("proj.json");
        std::fs::write(
            &user,
            r#"{"mcpServers":{
                "a":{"command":"old"},
                "b":{"command":"keep","env":{"T":"${TOKEN}"},"cwd":"rel"},
                "c":{"command":"x"},
                "broken":{"nonsense":true}}}"#,
        )
        .unwrap();
        std::fs::write(
            &proj,
            r#"{"mcpServers":{
                "a":{"command":"new","args":["${HOME_X}/bin"]},
                "c":{"command":"x","disabled":true},
                "d":{"url":"http://${TOKEN}.example/mcp","type":"http"}}}"#,
        )
        .unwrap();
        let missing = dir.path().join("missing.json");
        let ws = Path::new("/ws");
        let out = load_with(&[user, missing, proj], ws, &lookup);
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["a", "b", "d"]);
        match &out[0].1.transport {
            McpTransportConfig::Stdio { command, args, .. } => {
                assert_eq!(command, "new");
                assert_eq!(args, &["/home/x/bin"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        match &out[1].1.transport {
            McpTransportConfig::Stdio { env, cwd, .. } => {
                assert_eq!(env["T"], "sekret");
                assert_eq!(
                    Path::new(cwd.as_deref().unwrap()),
                    Path::new("/ws").join("rel")
                );
            }
            other => panic!("unexpected {other:?}"),
        }
        match &out[2].1.transport {
            McpTransportConfig::Http { url, .. } => assert_eq!(url, "http://sekret.example/mcp"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn public_loader_reads_workspace_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"w":{"command":"node"}}}"#,
        )
        .unwrap();
        std::fs::create_dir(dir.path().join(".omnia")).unwrap();
        std::fs::write(
            dir.path().join(".omnia").join("mcp.json"),
            r#"{"mcpServers":{"w":{"command":"deno"}}}"#,
        )
        .unwrap();
        let out = load_mcp_config(dir.path(), None);
        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0].1.transport,
            McpTransportConfig::Stdio { command, .. } if command == "deno"
        ));
    }
}
