//! `McpManager`: owns every configured server connection.

use std::sync::{Arc, Mutex};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};

use super::client::{McpClient, McpOptions};
use super::config::McpServerConfig;
use super::tool::McpTool;
use crate::Tool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpServerState {
    Connected,
    Failed,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub state: McpServerState,
    pub error: Option<String>,
    pub tool_count: usize,
}

struct Entry {
    name: String,
    state: McpServerState,
    error: Option<String>,
    client: Option<Arc<McpClient>>,
    tools: Vec<Arc<dyn Tool>>,
}

#[derive(Clone, Default)]
pub struct McpManager {
    servers: Arc<Mutex<Vec<Entry>>>,
}

async fn connect_one(
    name: &str,
    config: &McpServerConfig,
    opts: McpOptions,
) -> Result<(Arc<McpClient>, Vec<Arc<dyn Tool>>), String> {
    let client = Arc::new(
        McpClient::connect(config, opts)
            .await
            .map_err(|e| e.to_string())?,
    );
    match build_tools(name, &client).await {
        Ok(tools) => Ok((client, tools)),
        Err(error) => {
            client.shutdown().await;
            Err(error)
        }
    }
}

async fn build_tools(name: &str, client: &Arc<McpClient>) -> Result<Vec<Arc<dyn Tool>>, String> {
    let infos = client.list_tools().await.map_err(|e| e.to_string())?;
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    for info in infos {
        let tool = McpTool::new(name, client.clone(), info);
        if tools.iter().all(|t| t.spec().name != tool.spec().name) {
            tools.push(Arc::new(tool));
        }
    }
    Ok(tools)
}

impl McpManager {
    pub fn empty() -> Self {
        Self::default()
    }

    /// Connect all servers concurrently; failures are recorded per server.
    pub async fn start_all(configs: Vec<(String, McpServerConfig)>) -> Self {
        Self::start_all_with(configs, McpOptions::default()).await
    }

    pub async fn start_all_with(configs: Vec<(String, McpServerConfig)>, opts: McpOptions) -> Self {
        let entries = join_all(configs.into_iter().map(|(name, config)| async move {
            if config.disabled {
                return Entry {
                    name,
                    state: McpServerState::Disabled,
                    error: None,
                    client: None,
                    tools: Vec::new(),
                };
            }
            match connect_one(&name, &config, opts).await {
                Ok((client, tools)) => Entry {
                    name,
                    state: McpServerState::Connected,
                    error: None,
                    client: Some(client),
                    tools,
                },
                Err(error) => Entry {
                    name,
                    state: McpServerState::Failed,
                    error: Some(error),
                    client: None,
                    tools: Vec::new(),
                },
            }
        }))
        .await;
        Self {
            servers: Arc::new(Mutex::new(entries)),
        }
    }

    /// Register an already-connected client (replaces a server of that name).
    pub async fn add_client(&self, name: &str, client: Arc<McpClient>) -> Result<(), String> {
        let tools = build_tools(name, &client).await?;
        let entry = Entry {
            name: name.to_string(),
            state: McpServerState::Connected,
            error: None,
            client: Some(client),
            tools,
        };
        let mut servers = self.servers.lock().unwrap();
        match servers.iter_mut().find(|e| e.name == name) {
            Some(slot) => *slot = entry,
            None => servers.push(entry),
        }
        Ok(())
    }

    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.servers
            .lock()
            .unwrap()
            .iter()
            .flat_map(|e| e.tools.iter().cloned())
            .collect()
    }

    pub fn status(&self) -> Vec<McpServerStatus> {
        self.servers
            .lock()
            .unwrap()
            .iter()
            .map(|e| McpServerStatus {
                name: e.name.clone(),
                state: e.state,
                error: e.error.clone(),
                tool_count: e.tools.len(),
            })
            .collect()
    }

    /// Re-list tools of servers that sent `tools/list_changed`. Returns true
    /// if any server was refreshed.
    pub async fn refresh_if_changed(&self) -> bool {
        let stale: Vec<(String, Arc<McpClient>)> = self
            .servers
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                let client = e.client.as_ref()?;
                client
                    .tools_changed()
                    .then(|| (e.name.clone(), client.clone()))
            })
            .collect();
        let mut refreshed = false;
        for (name, client) in stale {
            if let Ok(tools) = build_tools(&name, &client).await {
                if let Some(entry) = self
                    .servers
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .find(|e| e.name == name)
                {
                    entry.tools = tools;
                    refreshed = true;
                }
            }
        }
        refreshed
    }

    /// Recent stderr output of a stdio server, if any.
    pub fn diagnostics(&self, name: &str) -> Option<String> {
        let client = self
            .servers
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.name == name)?
            .client
            .clone()?;
        client.diagnostics()
    }

    pub async fn shutdown(&self) {
        let clients: Vec<_> = {
            let mut servers = self.servers.lock().unwrap();
            servers
                .iter_mut()
                .filter_map(|e| {
                    e.tools.clear();
                    e.state = McpServerState::Disabled;
                    e.client.take()
                })
                .collect()
        };
        join_all(clients.iter().map(|c| c.shutdown())).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::client::ServerKind;
    use crate::mcp::testutil::spawn_fake;
    use serde_json::json;

    #[tokio::test]
    async fn failing_and_disabled_servers_do_not_break_others() {
        let mut disabled = McpServerConfig::stdio("whatever", vec![]);
        disabled.disabled = true;
        let configs = vec![
            (
                "bad".to_string(),
                McpServerConfig::stdio("definitely-not-a-real-binary-xyz", vec![]),
            ),
            ("off".to_string(), disabled),
            // Nothing listens here, so connecting fails quickly.
            (
                "web".to_string(),
                McpServerConfig::http("http://127.0.0.1:1/mcp"),
            ),
        ];
        let manager = McpManager::start_all(configs).await;
        let status = manager.status();
        assert_eq!(status.len(), 3);
        assert_eq!(status[0].state, McpServerState::Failed);
        assert!(status[0]
            .error
            .as_deref()
            .unwrap()
            .contains("failed to spawn"));
        assert_eq!(status[1].state, McpServerState::Disabled);
        assert_eq!(status[2].state, McpServerState::Failed);
        assert!(manager.tools().is_empty());
        let json = serde_json::to_value(&status[0]).unwrap();
        assert_eq!(json["state"], "failed");
        assert!(json.get("toolCount").is_some());
    }

    #[tokio::test]
    async fn connected_client_exposes_tools_and_refreshes() {
        let (r, w, _fake) = spawn_fake();
        let client = Arc::new(
            McpClient::connect_io(r, w, ServerKind::Http, McpOptions::default())
                .await
                .unwrap(),
        );
        let manager = McpManager::empty();
        let clone = manager.clone();
        clone.add_client("fake", client.clone()).await.unwrap();
        let tools = manager.tools();
        assert_eq!(tools.len(), 6);
        assert_eq!(tools[0].effect(), crate::EffectClass::Network);
        assert_eq!(manager.status()[0].tool_count, 6);
        assert!(!manager.refresh_if_changed().await);
        client.call_tool("changed", json!({}), None).await.unwrap();
        assert!(manager.refresh_if_changed().await);
        manager.shutdown().await;
        assert!(manager.tools().is_empty());
    }
}
