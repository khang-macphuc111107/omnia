//! Protocol-level client: lifecycle, `tools/list`, `tools/call`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use super::config::{McpServerConfig, McpTransportConfig};
use super::http::HttpTransport;
use super::rpc::Transport;
use super::stdio::{spawn_stdio, PipeTransport};
use super::{McpError, McpResult, PROTOCOL_VERSION};

#[derive(Debug, Clone, Copy)]
pub struct McpOptions {
    pub initialize_timeout: Duration,
    pub call_timeout: Duration,
}

impl Default for McpOptions {
    fn default() -> Self {
        Self {
            initialize_timeout: Duration::from_secs(30),
            call_timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerKind {
    Stdio,
    Http,
}

/// A tool as advertised by a server.
#[derive(Debug, Clone, PartialEq)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
}

pub struct McpClient {
    transport: Box<dyn Transport>,
    kind: ServerKind,
    opts: McpOptions,
    tools_changed: Arc<AtomicBool>,
    protocol_version: String,
    server_info: Value,
}

impl McpClient {
    /// Spawn / connect according to `config` and perform the handshake.
    pub async fn connect(config: &McpServerConfig, opts: McpOptions) -> McpResult<Self> {
        let flag = Arc::new(AtomicBool::new(false));
        match &config.transport {
            McpTransportConfig::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                let t = spawn_stdio(command, args, env, cwd.as_deref(), flag.clone())?;
                Self::handshake(Box::new(t), ServerKind::Stdio, opts, flag).await
            }
            McpTransportConfig::Http { url, headers, .. } => {
                let t = HttpTransport::new(url, headers, flag.clone())?;
                Self::handshake(Box::new(t), ServerKind::Http, opts, flag).await
            }
        }
    }

    /// Run the protocol over an arbitrary byte stream pair (tests, sockets).
    pub async fn connect_io<R, W>(
        reader: R,
        writer: W,
        kind: ServerKind,
        opts: McpOptions,
    ) -> McpResult<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let flag = Arc::new(AtomicBool::new(false));
        let t = PipeTransport::new(reader, writer, flag.clone(), None, None);
        Self::handshake(Box::new(t), kind, opts, flag).await
    }

    async fn handshake(
        transport: Box<dyn Transport>,
        kind: ServerKind,
        opts: McpOptions,
        tools_changed: Arc<AtomicBool>,
    ) -> McpResult<Self> {
        let init = async {
            let result = transport
                .request(
                    "initialize",
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": {"name": "omnia", "version": env!("CARGO_PKG_VERSION")},
                    }),
                    opts.initialize_timeout,
                    None,
                )
                .await?;
            // Accept whatever version the server answers with.
            let version = result
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION)
                .to_string();
            transport.set_protocol_version(&version);
            transport
                .notify("notifications/initialized", json!({}))
                .await?;
            let info = result.get("serverInfo").cloned().unwrap_or(Value::Null);
            Ok::<_, McpError>((version, info))
        };
        match init.await {
            Ok((protocol_version, server_info)) => Ok(Self {
                transport,
                kind,
                opts,
                tools_changed,
                protocol_version,
                server_info,
            }),
            Err(error) => {
                let diag = transport.diagnostics();
                transport.shutdown().await;
                Err(match diag {
                    Some(d) => McpError::Transport(format!("{error}; server stderr:\n{d}")),
                    None => error,
                })
            }
        }
    }

    pub fn kind(&self) -> ServerKind {
        self.kind
    }

    pub fn protocol_version(&self) -> &str {
        &self.protocol_version
    }

    pub fn server_info(&self) -> &Value {
        &self.server_info
    }

    pub fn diagnostics(&self) -> Option<String> {
        self.transport.diagnostics()
    }

    /// True once if the server announced `notifications/tools/list_changed`
    /// since the last `list_tools`.
    pub fn tools_changed(&self) -> bool {
        self.tools_changed.load(Ordering::SeqCst)
    }

    /// Fetch every tool, following `nextCursor` pagination.
    pub async fn list_tools(&self) -> McpResult<Vec<McpToolInfo>> {
        self.tools_changed.store(false, Ordering::SeqCst);
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..100 {
            let params = match &cursor {
                Some(c) => json!({"cursor": c}),
                None => json!({}),
            };
            let result = self
                .transport
                .request("tools/list", params, self.opts.initialize_timeout, None)
                .await?;
            for item in result
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                tools.push(McpToolInfo {
                    name: name.to_string(),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("title").and_then(Value::as_str))
                        .unwrap_or_default()
                        .to_string(),
                    input_schema: item
                        .get("inputSchema")
                        .filter(|v| v.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({"type": "object"})),
                    read_only: item
                        .pointer("/annotations/readOnlyHint")
                        .and_then(Value::as_bool)
                        == Some(true),
                });
            }
            match result.get("nextCursor").and_then(Value::as_str) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => return Ok(tools),
            }
        }
        Err(McpError::Protocol(
            "tools/list pagination did not end".into(),
        ))
    }

    /// Call a tool; returns the raw `CallToolResult` JSON.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        cancel: Option<&CancellationToken>,
    ) -> McpResult<Value> {
        self.transport
            .request(
                "tools/call",
                json!({"name": name, "arguments": arguments}),
                self.opts.call_timeout,
                cancel,
            )
            .await
    }

    pub async fn shutdown(&self) {
        self.transport.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::testutil::{spawn_fake, FakeServer};

    fn short() -> McpOptions {
        McpOptions {
            initialize_timeout: Duration::from_secs(5),
            call_timeout: Duration::from_millis(150),
        }
    }

    async fn connected() -> (McpClient, FakeServer) {
        let (r, w, fake) = spawn_fake();
        let client = McpClient::connect_io(r, w, ServerKind::Stdio, short())
            .await
            .unwrap();
        (client, fake)
    }

    #[tokio::test]
    async fn handshake_and_pagination() {
        let (client, fake) = connected().await;
        assert_eq!(client.protocol_version(), "2099-01-01");
        assert_eq!(client.server_info()["name"], "fake");
        let tools = client.list_tools().await.unwrap();
        let names: Vec<_> = tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["echo", "img", "err", "slow", "ping_first", "ro"]);
        assert!(tools.iter().find(|t| t.name == "ro").unwrap().read_only);
        assert_eq!(tools[0].input_schema["type"], "object");
        let log = fake.log();
        let methods: Vec<_> = log.iter().filter_map(|m| m["method"].as_str()).collect();
        assert_eq!(
            methods,
            [
                "initialize",
                "notifications/initialized",
                "tools/list",
                "tools/list"
            ]
        );
        assert_eq!(log[0]["params"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(log[0]["params"]["clientInfo"]["name"], "omnia");
        assert_eq!(log[3]["params"]["cursor"], "page2");
    }

    #[tokio::test]
    async fn server_requests_are_answered() {
        let (client, fake) = connected().await;
        let result = client
            .call_tool("ping_first", json!({}), None)
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "pong-ok");
        let replies = fake.log();
        let ping = replies.iter().find(|m| m["id"] == "p1").unwrap();
        assert_eq!(ping["result"], json!({}));
        let unknown = replies.iter().find(|m| m["id"] == "u1").unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn timeout_sends_cancelled() {
        let (client, fake) = connected().await;
        let err = client.call_tool("slow", json!({}), None).await.unwrap_err();
        assert!(matches!(err, McpError::Timeout(_)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        let log = fake.log();
        let cancelled = log
            .iter()
            .find(|m| m["method"] == "notifications/cancelled")
            .expect("cancelled notification");
        assert!(cancelled["params"]["requestId"].is_u64());
    }

    #[tokio::test]
    async fn cancel_token_aborts_call() {
        let (client, fake) = connected().await;
        let token = CancellationToken::new();
        let t2 = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            t2.cancel();
        });
        let opts_client = client;
        let err = opts_client
            .call_tool("slow", json!({}), Some(&token))
            .await
            .unwrap_err();
        assert!(matches!(err, McpError::Cancelled));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(fake
            .log()
            .iter()
            .any(|m| m["method"] == "notifications/cancelled"));
    }

    #[tokio::test]
    async fn tools_list_changed_sets_flag() {
        let (client, _fake) = connected().await;
        assert!(!client.tools_changed());
        client.call_tool("changed", json!({}), None).await.unwrap();
        assert!(client.tools_changed());
        client.list_tools().await.unwrap();
        assert!(!client.tools_changed());
    }

    #[tokio::test]
    async fn closed_connection_fails_requests() {
        let (client, fake) = connected().await;
        fake.stop();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let err = client.call_tool("echo", json!({}), None).await.unwrap_err();
        assert!(matches!(err, McpError::Closed | McpError::Transport(_)));
    }
}
