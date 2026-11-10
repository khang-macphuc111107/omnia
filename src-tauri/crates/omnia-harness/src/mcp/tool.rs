//! `McpTool`: adapts one server tool to the harness [`Tool`] trait.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::client::{McpClient, McpToolInfo, ServerKind};
use super::McpError;
use crate::{
    Block, EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec,
};

const MAX_NAME_LEN: usize = 64;

fn sanitize(part: &str) -> String {
    part.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn fnv_hex(input: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in input.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// `mcp__{server}__{tool}` restricted to `[A-Za-z0-9_-]`, at most 64 chars
/// (long names are truncated and given a stable hash suffix).
pub fn sanitize_tool_name(server: &str, tool: &str) -> String {
    let full = format!("mcp__{}__{}", sanitize(server), sanitize(tool));
    if full.len() <= MAX_NAME_LEN {
        return full;
    }
    let suffix = fnv_hex(&format!("{server}\u{0}{tool}"));
    format!("{}_{}", &full[..MAX_NAME_LEN - 9], suffix)
}

pub struct McpTool {
    client: Arc<McpClient>,
    server: String,
    remote_name: String,
    exposed_name: String,
    description: String,
    schema: Value,
    effect: EffectClass,
}

impl McpTool {
    pub fn new(server: &str, client: Arc<McpClient>, info: McpToolInfo) -> Self {
        let effect = if info.read_only {
            EffectClass::ReadWorkspace
        } else if client.kind() == ServerKind::Stdio {
            EffectClass::ExecuteProcess
        } else {
            EffectClass::Network
        };
        Self {
            exposed_name: sanitize_tool_name(server, &info.name),
            server: server.to_string(),
            remote_name: info.name,
            description: info.description,
            schema: info.input_schema,
            effect,
            client,
        }
    }
}

#[async_trait]
impl Tool for McpTool {
    fn spec(&self) -> ToolSpec {
        let description = if self.description.is_empty() {
            format!(
                "MCP tool `{}` from server `{}`",
                self.remote_name, self.server
            )
        } else {
            self.description.clone()
        };
        ToolSpec {
            name: self.exposed_name.clone(),
            description,
            input_schema: self.schema.clone(),
        }
    }

    fn effect(&self) -> EffectClass {
        self.effect
    }

    fn describe(&self, input: &Value) -> String {
        let mut args = input.to_string();
        if args.chars().count() > 200 {
            args = args.chars().take(200).collect::<String>() + "...";
        }
        format!("MCP {}: {} {}", self.server, self.remote_name, args)
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        let args = if input.is_null() { json!({}) } else { input };
        match self
            .client
            .call_tool(&self.remote_name, args, Some(&ctx.cancel))
            .await
        {
            Ok(result) => Ok(convert_call_result(&result)),
            Err(McpError::Cancelled) => Err(HarnessError::Cancelled),
            Err(error) => Ok(ToolOutput::error(format!(
                "MCP server `{}` tool `{}` failed: {error}",
                self.server, self.remote_name
            ))),
        }
    }
}

/// Convert a `CallToolResult` into harness output.
pub fn convert_call_result(result: &Value) -> ToolOutput {
    let mut content = Vec::new();
    let mut has_text = false;
    for item in result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let str_of = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default();
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                has_text = true;
                content.push(Block::text(str_of("text")));
            }
            Some("image") => content.push(Block::Image {
                media_type: str_of("mimeType").to_string(),
                data: str_of("data").to_string(),
            }),
            Some("audio") => content.push(Block::text(format!(
                "[audio content omitted ({})]",
                str_of("mimeType")
            ))),
            Some("resource") => {
                let res = item.get("resource").unwrap_or(&Value::Null);
                let uri = res.get("uri").and_then(Value::as_str).unwrap_or("?");
                match res.get("text").and_then(Value::as_str) {
                    Some(text) => {
                        has_text = true;
                        content.push(Block::text(format!("[resource {uri}]\n{text}")));
                    }
                    None => {
                        let mime = res
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown type");
                        content.push(Block::text(format!("[binary resource {uri} ({mime})]")));
                    }
                }
            }
            Some("resource_link") => {
                let mut line = format!("[resource link {}]", str_of("uri"));
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    line = format!("[resource link {name}: {}]", str_of("uri"));
                }
                content.push(Block::text(line));
            }
            _ => content.push(Block::text(item.to_string())),
        }
    }
    if !has_text {
        if let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null()) {
            content.push(Block::text(
                serde_json::to_string_pretty(structured).unwrap_or_else(|_| structured.to_string()),
            ));
        }
    }
    if content.is_empty() {
        content.push(Block::text("(no content)"));
    }
    ToolOutput {
        content,
        is_error: result.get("isError").and_then(Value::as_bool) == Some(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::client::McpOptions;
    use crate::mcp::testutil::spawn_fake;
    use std::time::Duration;

    #[test]
    fn names_are_sanitized_and_bounded() {
        assert_eq!(
            sanitize_tool_name("my server", "do.it"),
            "mcp__my_server__do_it"
        );
        let long = sanitize_tool_name("srv", &"x".repeat(100));
        assert_eq!(long.len(), 64);
        assert!(long.starts_with("mcp__srv__xxx"));
        let other = sanitize_tool_name("srv", &format!("{}y", "x".repeat(100)));
        assert_ne!(long, other);
        assert!(long
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'));
        // Non-ASCII must not panic on byte slicing.
        let uni = sanitize_tool_name("é", &"ü".repeat(80));
        assert!(uni.len() <= 64);
    }

    #[test]
    fn converts_content_kinds() {
        let out = convert_call_result(&json!({"content":[
            {"type":"text","text":"hi"},
            {"type":"image","data":"QUJD","mimeType":"image/png"},
            {"type":"resource","resource":{"uri":"file:///a","text":"body"}},
            {"type":"resource","resource":{"uri":"file:///b","blob":"x","mimeType":"image/x"}},
            {"type":"resource_link","uri":"http://l","name":"lnk"}
        ]}));
        assert!(!out.is_error);
        assert_eq!(out.content[0], Block::text("hi"));
        assert_eq!(
            out.content[1],
            Block::Image {
                media_type: "image/png".into(),
                data: "QUJD".into()
            }
        );
        assert_eq!(out.content[2], Block::text("[resource file:///a]\nbody"));
        assert_eq!(
            out.content[3],
            Block::text("[binary resource file:///b (image/x)]")
        );
        assert_eq!(out.content[4], Block::text("[resource link lnk: http://l]"));
    }

    #[test]
    fn structured_content_fallback_and_errors() {
        let out = convert_call_result(&json!({"structuredContent":{"a":1},"content":[]}));
        match &out.content[0] {
            Block::Text { text } => assert!(text.contains("\"a\": 1")),
            other => panic!("{other:?}"),
        }
        let out = convert_call_result(
            &json!({"isError":true,"content":[{"type":"text","text":"x"}],
            "structuredContent":{"a":1}}),
        );
        assert!(out.is_error);
        assert_eq!(out.content.len(), 1);
        assert_eq!(
            convert_call_result(&json!({})).content,
            vec![Block::text("(no content)")]
        );
    }

    async fn tools() -> (Vec<McpTool>, crate::mcp::testutil::FakeServer) {
        let (r, w, fake) = spawn_fake();
        let client = Arc::new(
            McpClient::connect_io(
                r,
                w,
                ServerKind::Stdio,
                McpOptions {
                    initialize_timeout: Duration::from_secs(5),
                    call_timeout: Duration::from_millis(200),
                },
            )
            .await
            .unwrap(),
        );
        let infos = client.list_tools().await.unwrap();
        let tools = infos
            .into_iter()
            .map(|i| McpTool::new("fake srv", client.clone(), i))
            .collect();
        (tools, fake)
    }

    fn find<'a>(tools: &'a [McpTool], name: &str) -> &'a McpTool {
        tools
            .iter()
            .find(|t| t.spec().name == format!("mcp__fake_srv__{name}"))
            .unwrap()
    }

    #[tokio::test]
    async fn tool_calls_end_to_end() {
        let (tools, _fake) = tools().await;
        let ctx = ToolContext::new(".");
        let echo = find(&tools, "echo");
        assert_eq!(echo.effect(), EffectClass::ExecuteProcess);
        assert_eq!(find(&tools, "ro").effect(), EffectClass::ReadWorkspace);
        assert_eq!(echo.spec().input_schema, json!({"type":"object"}));
        let out = echo.call(&ctx, json!({"text":"yo"})).await.unwrap();
        assert_eq!(out.content, vec![Block::text("echo:\"yo\"")]);

        let out = find(&tools, "img").call(&ctx, Value::Null).await.unwrap();
        assert!(
            matches!(&out.content[0], Block::Image { media_type, .. } if media_type == "image/png")
        );

        let out = find(&tools, "err").call(&ctx, json!({})).await.unwrap();
        assert!(out.is_error);
        assert_eq!(out.content, vec![Block::text("boom")]);

        // Timeout becomes an error output, not a harness error.
        let out = find(&tools, "slow").call(&ctx, json!({})).await.unwrap();
        assert!(out.is_error);

        // Cancellation surfaces as HarnessError::Cancelled.
        let ctx = ToolContext::new(".");
        let token = ctx.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            token.cancel();
        });
        let err = find(&tools, "slow")
            .call(&ctx, json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, HarnessError::Cancelled));
    }
}
