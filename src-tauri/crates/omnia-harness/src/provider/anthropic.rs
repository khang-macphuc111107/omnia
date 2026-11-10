//! Anthropic Messages API adapter (`/v1/messages`, streaming).

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::sse::{
    auth_headers, build_client, handle_events, post_json_logged, sse_events_tap,
    stream_event_error, temp_json, versioned_url, EventHandler, SseEvent,
};
use super::{Provider, ProviderConfig, ProviderRequest, ProviderStream};
use crate::{Block, HarnessError, HarnessResult, Message, Role, StopReason, StreamEvent, Usage};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 8192;

pub struct AnthropicProvider {
    config: ProviderConfig,
    client: reqwest::Client,
    recorder: Option<super::record::Recorder>,
}

impl AnthropicProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self::with_client(config, build_client())
    }

    /// Record every request/response exchange into `log` (inspector).
    pub fn with_recorder(mut self, log: std::sync::Arc<super::record::RequestLog>) -> Self {
        self.recorder = Some(super::record::Recorder { log });
        self
    }

    pub fn with_client(config: ProviderConfig, client: reqwest::Client) -> Self {
        Self {
            config,
            client,
            recorder: None,
        }
    }

    pub fn endpoint(&self) -> String {
        versioned_url(&self.config.base_url, "messages")
    }

    pub fn headers(&self) -> Vec<(String, String)> {
        auth_headers(
            &self.config,
            "x-api-key",
            &[("anthropic-version", ANTHROPIC_VERSION)],
        )
    }
}

fn thinking_budget(effort: &str) -> Option<u32> {
    match effort {
        "low" => Some(2048),
        "medium" => Some(8192),
        "high" => Some(24576),
        "max" => Some(32000),
        _ => None,
    }
}

fn block_to_json(block: &Block) -> Option<Value> {
    match block {
        Block::Text { text } if text.is_empty() => None,
        Block::Text { text } => Some(json!({"type": "text", "text": text})),
        Block::Image { media_type, data } => Some(json!({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        })),
        // Unsigned thinking cannot be replayed; the API rejects it.
        Block::Thinking { text, signature } => signature
            .as_ref()
            .map(|signature| json!({"type": "thinking", "thinking": text, "signature": signature})),
        Block::ToolUse { id, name, input } => {
            Some(json!({"type": "tool_use", "id": id, "name": name, "input": input}))
        }
        Block::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            let mut parts: Vec<Value> = content.iter().filter_map(block_to_json).collect();
            if parts.is_empty() {
                parts.push(json!({"type": "text", "text": "(no output)"}));
            }
            let mut value = json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": parts,
            });
            if *is_error {
                value["is_error"] = Value::Bool(true);
            }
            Some(value)
        }
    }
}

fn message_to_json(message: &Message) -> Option<Value> {
    let content: Vec<Value> = message.content.iter().filter_map(block_to_json).collect();
    if content.is_empty() {
        return None;
    }
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    Some(json!({"role": role, "content": content}))
}

/// Build the JSON request body.
pub fn build_body(req: &ProviderRequest) -> Value {
    let budget = req.reasoning_effort.as_deref().and_then(thinking_budget);
    let mut max_tokens = req.max_tokens;
    let mut thinking = None;
    if let Some(mut budget) = budget {
        match max_tokens {
            None => max_tokens = Some(DEFAULT_MAX_TOKENS.max(budget + 4096)),
            Some(max) if max <= budget => {
                // Keep the caller's cap; shrink the thinking budget under it.
                budget = max / 2;
            }
            _ => {}
        }
        if budget >= 1024 {
            thinking = Some(budget);
        }
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": req.messages.iter().filter_map(message_to_json).collect::<Vec<_>>(),
        "stream": true,
    });
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        body["system"] = json!(system);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
                    })
                })
                .collect(),
        );
    }
    match thinking {
        Some(budget) => {
            body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
        }
        None => {
            if let Some(temperature) = req.temperature {
                body["temperature"] = temp_json(temperature);
            }
        }
    }
    body
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn id(&self) -> &str {
        "anthropic"
    }

    async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream> {
        let body = build_body(&request);
        let (resp, tap) = post_json_logged(
            &self.client,
            &self.endpoint(),
            &self.headers(),
            &body,
            self.recorder.as_ref(),
            self.id(),
            &request.model,
        )
        .await?;
        Ok(handle_events(
            sse_events_tap(resp, tap),
            AnthropicHandler::default(),
        ))
    }
}

/// SSE event translator.
#[derive(Default)]
pub struct AnthropicHandler {
    tool_ids: HashMap<u64, String>,
    emitted: Usage,
    stop_reason: Option<StopReason>,
    stopped: bool,
}

fn usage_of(value: &Value) -> Usage {
    let get = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: get("input_tokens"),
        output_tokens: get("output_tokens"),
        cache_read_tokens: get("cache_read_input_tokens"),
        cache_write_tokens: get("cache_creation_input_tokens"),
    }
}

fn map_stop(reason: &str) -> StopReason {
    match reason {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "refusal" => StopReason::Refusal,
        _ => StopReason::Other,
    }
}

impl AnthropicHandler {
    /// Usage counters are cumulative; emit only what is new.
    fn usage_event(&mut self, new: Usage, out: &mut Vec<StreamEvent>) {
        let diff = Usage {
            input_tokens: new.input_tokens.saturating_sub(self.emitted.input_tokens),
            output_tokens: new.output_tokens.saturating_sub(self.emitted.output_tokens),
            cache_read_tokens: new
                .cache_read_tokens
                .saturating_sub(self.emitted.cache_read_tokens),
            cache_write_tokens: new
                .cache_write_tokens
                .saturating_sub(self.emitted.cache_write_tokens),
        };
        self.emitted = Usage {
            input_tokens: new.input_tokens.max(self.emitted.input_tokens),
            output_tokens: new.output_tokens.max(self.emitted.output_tokens),
            cache_read_tokens: new.cache_read_tokens.max(self.emitted.cache_read_tokens),
            cache_write_tokens: new.cache_write_tokens.max(self.emitted.cache_write_tokens),
        };
        if diff != Usage::default() {
            out.push(StreamEvent::Usage { usage: diff });
        }
    }
}

impl EventHandler for AnthropicHandler {
    fn on_event(&mut self, event: &SseEvent) -> HarnessResult<Vec<StreamEvent>> {
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| HarnessError::Protocol(format!("invalid Anthropic SSE JSON: {e}")))?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .unwrap_or("");
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
        let mut out = Vec::new();
        match kind {
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.usage_event(usage_of(usage), &mut out);
                }
            }
            "content_block_start" => {
                let block = &value["content_block"];
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        let id = block["id"].as_str().unwrap_or_default().to_string();
                        let name = block["name"].as_str().unwrap_or_default().to_string();
                        self.tool_ids.insert(index, id.clone());
                        out.push(StreamEvent::ToolUseStart { id, name });
                    }
                    Some("text") => {
                        if let Some(text) = block["text"].as_str().filter(|t| !t.is_empty()) {
                            out.push(StreamEvent::TextDelta { text: text.into() });
                        }
                    }
                    Some("thinking") => {
                        if let Some(text) = block["thinking"].as_str().filter(|t| !t.is_empty()) {
                            out.push(StreamEvent::ThinkingDelta { text: text.into() });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => out.push(StreamEvent::TextDelta {
                        text: delta["text"].as_str().unwrap_or_default().into(),
                    }),
                    Some("thinking_delta") => out.push(StreamEvent::ThinkingDelta {
                        text: delta["thinking"].as_str().unwrap_or_default().into(),
                    }),
                    Some("signature_delta") => out.push(StreamEvent::ThinkingSignature {
                        signature: delta["signature"].as_str().unwrap_or_default().into(),
                    }),
                    Some("input_json_delta") => {
                        if let Some(id) = self.tool_ids.get(&index) {
                            out.push(StreamEvent::ToolInputDelta {
                                id: id.clone(),
                                partial_json: delta["partial_json"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .into(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(id) = self.tool_ids.remove(&index) {
                    out.push(StreamEvent::ToolUseEnd { id });
                }
            }
            "message_delta" => {
                if let Some(reason) = value.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(map_stop(reason));
                }
                if let Some(usage) = value.get("usage") {
                    self.usage_event(usage_of(usage), &mut out);
                }
            }
            "message_stop" => {
                self.stopped = true;
                out.push(StreamEvent::Stop {
                    reason: self.stop_reason.unwrap_or(StopReason::EndTurn),
                });
            }
            "error" => {
                let error = &value["error"];
                let message = error["message"].as_str().unwrap_or("unknown error");
                let kind = error["type"].as_str().unwrap_or("error");
                let retryable =
                    matches!(kind, "overloaded_error" | "api_error" | "rate_limit_error");
                return Err(stream_event_error(&format!("{kind}: {message}"), retryable));
            }
            _ => {} // ping and unknown events
        }
        Ok(out)
    }

    fn on_end(&mut self) -> HarnessResult<Vec<StreamEvent>> {
        if self.stopped {
            Ok(Vec::new())
        } else {
            Err(HarnessError::Protocol(
                "Anthropic stream ended before message_stop".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::sse::test_support::*;
    use super::*;
    use crate::ToolSpec;

    const FIXTURE: &str = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":25,\"output_tokens\":1,\"cache_read_input_tokens\":4}}}\n\n",
        "event: content_block_start\r\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\r\n\r\n",
        "event: ping\ndata: {\"type\":\"ping\"}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Hmm \u{1F914}\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"SIG\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Let me \"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"look.\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"a.rs\\\"}\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":42}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );

    fn expected_events() -> Vec<StreamEvent> {
        vec![
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 25,
                    output_tokens: 1,
                    cache_read_tokens: 4,
                    cache_write_tokens: 0,
                },
            },
            StreamEvent::ThinkingDelta {
                text: "Hmm \u{1F914}".into(),
            },
            StreamEvent::ThinkingSignature {
                signature: "SIG".into(),
            },
            StreamEvent::TextDelta {
                text: "Let me ".into(),
            },
            StreamEvent::TextDelta {
                text: "look.".into(),
            },
            StreamEvent::ToolUseStart {
                id: "toolu_1".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "toolu_1".into(),
                partial_json: "{\"path\":".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "toolu_1".into(),
                partial_json: "\"a.rs\"}".into(),
            },
            StreamEvent::ToolUseEnd {
                id: "toolu_1".into(),
            },
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 0,
                    output_tokens: 41,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                },
            },
            StreamEvent::Stop {
                reason: StopReason::ToolUse,
            },
        ]
    }

    #[tokio::test]
    async fn parses_fixture_at_any_chunk_boundary() {
        let events = run_fixture(FIXTURE, AnthropicHandler::default).await;
        assert_eq!(events, expected_events());
        let (message, usage, stop) = fold(&events);
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(usage.input_tokens, 25);
        assert_eq!(usage.output_tokens, 42);
        assert_eq!(
            message.content,
            vec![
                Block::Thinking {
                    text: "Hmm \u{1F914}".into(),
                    signature: Some("SIG".into())
                },
                Block::text("Let me look."),
                Block::ToolUse {
                    id: "toolu_1".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.rs"})
                },
            ]
        );
    }

    #[tokio::test]
    async fn error_event_and_truncation() {
        let err = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        match run_handler(vec![err.as_bytes().to_vec()], AnthropicHandler::default()).await {
            Err(HarnessError::Provider {
                retryable: true,
                message,
                status: None,
            }) => {
                assert!(message.contains("Overloaded"))
            }
            other => panic!("{other:?}"),
        }
        let cut = "event: ping\ndata: {\"type\":\"ping\"}\n\n";
        assert!(matches!(
            run_handler(vec![cut.as_bytes().to_vec()], AnthropicHandler::default()).await,
            Err(HarnessError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn refusal_stop_reason() {
        let s = "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"refusal\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
        let events = run_handler(vec![s.as_bytes().to_vec()], AnthropicHandler::default())
            .await
            .unwrap();
        assert_eq!(
            events,
            vec![StreamEvent::Stop {
                reason: StopReason::Refusal
            }]
        );
    }

    fn history() -> Vec<Message> {
        vec![
            Message::user("read a.rs"),
            Message::assistant(vec![
                Block::Thinking {
                    text: "t".into(),
                    signature: Some("S".into()),
                },
                Block::Thinking {
                    text: "unsigned".into(),
                    signature: None,
                },
                Block::text("ok"),
                Block::ToolUse {
                    id: "toolu_1".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.rs"}),
                },
            ]),
            Message {
                role: Role::User,
                content: vec![
                    Block::ToolResult {
                        tool_use_id: "toolu_1".into(),
                        content: vec![Block::text("boom")],
                        is_error: true,
                    },
                    Block::Image {
                        media_type: "image/png".into(),
                        data: "QUJD".into(),
                    },
                ],
            },
        ]
    }

    #[test]
    fn body_golden_with_tool_round_trip() {
        let req = ProviderRequest {
            model: "claude-x".into(),
            system: Some("be brief".into()),
            messages: history(),
            tools: vec![ToolSpec {
                name: "read_file".into(),
                description: "Read".into(),
                input_schema: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            }],
            max_tokens: Some(4096),
            temperature: Some(0.5),
            reasoning_effort: None,
        };
        assert_eq!(
            build_body(&req),
            json!({
                "model": "claude-x",
                "max_tokens": 4096,
                "stream": true,
                "system": "be brief",
                "temperature": 0.5,
                "tools": [{"name": "read_file", "description": "Read",
                           "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}],
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "read a.rs"}]},
                    {"role": "assistant", "content": [
                        {"type": "thinking", "thinking": "t", "signature": "S"},
                        {"type": "text", "text": "ok"},
                        {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "a.rs"}},
                    ]},
                    {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": "toolu_1",
                         "content": [{"type": "text", "text": "boom"}], "is_error": true},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}},
                    ]},
                ],
            })
        );
    }

    #[test]
    fn thinking_budget_and_max_tokens() {
        let mut req = ProviderRequest {
            model: "m".into(),
            temperature: Some(0.2),
            ..Default::default()
        };
        req.reasoning_effort = Some("high".into());
        let body = build_body(&req);
        assert_eq!(
            body["thinking"],
            json!({"type": "enabled", "budget_tokens": 24576})
        );
        assert!(body["max_tokens"].as_u64().unwrap() > 24576);
        assert!(body.get("temperature").is_none());

        req.reasoning_effort = Some("low".into());
        req.max_tokens = Some(2048);
        let body = build_body(&req);
        let budget = body["thinking"]["budget_tokens"].as_u64();
        assert!(budget.is_none() || budget.unwrap() < 2048);
        assert_eq!(body["max_tokens"], 2048);
    }

    #[tokio::test]
    async fn end_to_end_stream_against_local_server() {
        let (base, handle) = serve_once(200, "text/event-stream", FIXTURE.to_string());
        let provider = AnthropicProvider::with_client(
            ProviderConfig {
                base_url: base,
                api_key: Some("k-123".into()),
                bearer_auth: false,
                extra_headers: vec![("x-extra".into(), "1".into())],
            },
            test_client(),
        );
        let stream = provider
            .stream(ProviderRequest {
                model: "claude-x".into(),
                messages: vec![Message::user("hi")],
                ..Default::default()
            })
            .await
            .unwrap();
        let events = collect_stream(stream).await.unwrap();
        assert_eq!(events, expected_events());
        let request = handle.join().unwrap().to_lowercase();
        assert!(request.starts_with("post /v1/messages "));
        assert!(request.contains("x-api-key: k-123"));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(request.contains("x-extra: 1"));
    }
}
