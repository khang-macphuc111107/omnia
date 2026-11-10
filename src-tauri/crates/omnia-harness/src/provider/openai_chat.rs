//! OpenAI-compatible Chat Completions adapter (`/v1/chat/completions`), used
//! for OpenAI itself, Ollama, LM Studio, DeepSeek and other compatible
//! servers.

use async_trait::async_trait;
use serde_json::{json, Value};

use super::sse::{
    auth_headers, blocks_text, build_client, data_uri, handle_events, post_json_logged,
    sse_events_tap, stream_event_error, temp_json, versioned_url, EventHandler, SseEvent,
};
use super::{Provider, ProviderConfig, ProviderRequest, ProviderStream};
use crate::{Block, HarnessError, HarnessResult, Role, StopReason, StreamEvent, Usage};

pub struct OpenAiChatProvider {
    config: ProviderConfig,
    client: reqwest::Client,
    recorder: Option<super::record::Recorder>,
}

impl OpenAiChatProvider {
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
        versioned_url(&self.config.base_url, "chat/completions")
    }

    pub fn headers(&self) -> Vec<(String, String)> {
        let mut config = self.config.clone();
        config.bearer_auth = true;
        auth_headers(&config, "authorization", &[])
    }
}

fn effort(effort: &str) -> Option<&'static str> {
    match effort {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "max" => Some("high"),
        _ => None,
    }
}

/// Build the JSON request body.
pub fn build_body(req: &ProviderRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        messages.push(json!({"role": "system", "content": system}));
    }
    for message in &req.messages {
        match message.role {
            Role::User => {
                // Tool results first (they must follow the assistant tool_calls).
                let mut parts: Vec<Value> = Vec::new();
                let mut has_image = false;
                for block in &message.content {
                    match block {
                        Block::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            let mut text = blocks_text(content);
                            if text.is_empty() {
                                text = "(no output)".into();
                            }
                            messages.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": text,
                            }));
                            for b in content {
                                if let Block::Image { media_type, data } = b {
                                    has_image = true;
                                    parts.push(json!({"type": "image_url",
                                        "image_url": {"url": data_uri(media_type, data)}}));
                                }
                            }
                        }
                        Block::Text { text } if !text.is_empty() => {
                            parts.push(json!({"type": "text", "text": text}));
                        }
                        Block::Image { media_type, data } => {
                            has_image = true;
                            parts.push(json!({"type": "image_url",
                                "image_url": {"url": data_uri(media_type, data)}}));
                        }
                        _ => {}
                    }
                }
                if parts.is_empty() {
                    continue;
                }
                if has_image {
                    messages.push(json!({"role": "user", "content": parts}));
                } else {
                    let text = parts
                        .iter()
                        .filter_map(|p| p["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    messages.push(json!({"role": "user", "content": text}));
                }
            }
            Role::Assistant => {
                let text = blocks_text(&message.content);
                let tool_calls: Vec<Value> = message
                    .tool_uses()
                    .map(|(id, name, input)| {
                        json!({
                            "id": id,
                            "type": "function",
                            "function": {"name": name, "arguments": input.to_string()},
                        })
                    })
                    .collect();
                if text.is_empty() && tool_calls.is_empty() {
                    continue;
                }
                let mut value = json!({
                    "role": "assistant",
                    "content": if text.is_empty() { Value::Null } else { json!(text) },
                });
                if !tool_calls.is_empty() {
                    value["tool_calls"] = Value::Array(tool_calls);
                }
                messages.push(value);
            }
        }
    }

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        },
                    })
                })
                .collect(),
        );
    }
    if let Some(max) = req.max_tokens {
        body["max_tokens"] = json!(max);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = temp_json(t);
    }
    if let Some(e) = req.reasoning_effort.as_deref().and_then(effort) {
        body["reasoning_effort"] = json!(e);
    }
    body
}

#[async_trait]
impl Provider for OpenAiChatProvider {
    fn id(&self) -> &str {
        "openai_chat"
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
            ChatHandler::default(),
        ))
    }
}

#[derive(Default)]
pub struct ChatHandler {
    /// Open tool calls as (stream index, id), in arrival order.
    open: Vec<(u64, String)>,
    ever_called: bool,
    finish: Option<StopReason>,
    stopped: bool,
}

fn map_finish(reason: &str, had_calls: bool) -> StopReason {
    match reason {
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "stop" | "eos" => {
            if had_calls {
                StopReason::ToolUse
            } else {
                StopReason::EndTurn
            }
        }
        "content_filter" => StopReason::Refusal,
        _ => StopReason::Other,
    }
}

fn usage_of(usage: &Value) -> Usage {
    let get = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let cached = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| get("prompt_cache_hit_tokens"));
    Usage {
        input_tokens: get("prompt_tokens").saturating_sub(cached),
        output_tokens: get("completion_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
    }
}

impl ChatHandler {
    fn close_all(&mut self, out: &mut Vec<StreamEvent>) {
        for (_, id) in self.open.drain(..) {
            out.push(StreamEvent::ToolUseEnd { id });
        }
    }

    fn tool_call(&mut self, tc: &Value, out: &mut Vec<StreamEvent>) {
        let id = tc
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let index = match tc.get("index").and_then(Value::as_u64) {
            Some(i) => i,
            None => match (id, self.open.last()) {
                // No index: a new id starts a new call, otherwise continue the last.
                (Some(id), last) if last.map(|l| l.1.as_str()) != Some(id) => {
                    self.open.last().map_or(0, |l| l.0 + 1)
                }
                (_, Some(last)) => last.0,
                _ => 0,
            },
        };
        let function = &tc["function"];
        if !self.open.iter().any(|(i, _)| *i == index) {
            let call_id = id
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{index}"));
            self.open.push((index, call_id.clone()));
            self.ever_called = true;
            out.push(StreamEvent::ToolUseStart {
                id: call_id,
                name: function["name"].as_str().unwrap_or_default().into(),
            });
        }
        if let Some(args) = function.get("arguments").and_then(Value::as_str) {
            if !args.is_empty() {
                let call_id = self
                    .open
                    .iter()
                    .find(|(i, _)| *i == index)
                    .map(|(_, id)| id.clone())
                    .unwrap_or_default();
                out.push(StreamEvent::ToolInputDelta {
                    id: call_id,
                    partial_json: args.into(),
                });
            }
        }
    }

    fn stop_event(&mut self, out: &mut Vec<StreamEvent>) {
        if !self.stopped {
            self.stopped = true;
            out.push(StreamEvent::Stop {
                reason: self.finish.unwrap_or(StopReason::EndTurn),
            });
        }
    }
}

impl EventHandler for ChatHandler {
    fn on_event(&mut self, event: &SseEvent) -> HarnessResult<Vec<StreamEvent>> {
        let data = event.data.trim();
        let mut out = Vec::new();
        if data == "[DONE]" {
            self.close_all(&mut out);
            self.stop_event(&mut out);
            return Ok(out);
        }
        let value: Value = serde_json::from_str(data)
            .map_err(|e| HarnessError::Protocol(format!("invalid chat SSE JSON: {e}")))?;
        if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
            let message = error["message"]
                .as_str()
                .or_else(|| error.as_str())
                .unwrap_or("unknown error");
            return Err(stream_event_error(message, false));
        }
        if let Some(choice) = value.pointer("/choices/0") {
            let delta = &choice["delta"];
            if let Some(text) = delta["reasoning_content"]
                .as_str()
                .or_else(|| delta["reasoning"].as_str())
                .filter(|t| !t.is_empty())
            {
                out.push(StreamEvent::ThinkingDelta { text: text.into() });
            }
            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                out.push(StreamEvent::TextDelta { text: text.into() });
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for tc in calls {
                    self.tool_call(tc, &mut out);
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.close_all(&mut out);
                self.finish = Some(map_finish(reason, self.ever_called));
            }
        }
        if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
            let usage = usage_of(usage);
            if usage != Usage::default() {
                out.push(StreamEvent::Usage { usage });
            }
        }
        Ok(out)
    }

    fn on_end(&mut self) -> HarnessResult<Vec<StreamEvent>> {
        let mut out = Vec::new();
        if self.stopped {
            return Ok(out);
        }
        if self.finish.is_none() {
            return Err(HarnessError::Protocol(
                "chat stream ended without a finish_reason".into(),
            ));
        }
        self.close_all(&mut out);
        self.stop_event(&mut out);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::super::sse::test_support::*;
    use super::*;
    use crate::{Message, ToolSpec};

    fn chunk(v: Value) -> String {
        format!("data: {v}\n\n")
    }

    fn fixture() -> String {
        [
            chunk(json!({"choices": [{"index": 0, "delta": {"role": "assistant", "reasoning_content": "think "}}]})),
            chunk(json!({"choices": [{"index": 0, "delta": {"content": "Hel"}}]})),
            chunk(json!({"choices": [{"index": 0, "delta": {"content": "lo \u{00e9}"}}]})),
            chunk(json!({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "id": "call_a", "type": "function", "function": {"name": "read_file", "arguments": ""}}]}}]})),
            chunk(json!({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": "{\"path\":"}}]}}]})),
            chunk(json!({"choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 1, "id": "call_b", "type": "function", "function": {"name": "ls", "arguments": "{}"}},
                {"index": 0, "function": {"arguments": "\"a.rs\"}"}}]}}]})),
            chunk(json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})),
            chunk(json!({"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 9, "prompt_tokens_details": {"cached_tokens": 10}}})),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat()
    }

    fn expected() -> Vec<StreamEvent> {
        vec![
            StreamEvent::ThinkingDelta {
                text: "think ".into(),
            },
            StreamEvent::TextDelta { text: "Hel".into() },
            StreamEvent::TextDelta {
                text: "lo \u{00e9}".into(),
            },
            StreamEvent::ToolUseStart {
                id: "call_a".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_a".into(),
                partial_json: "{\"path\":".into(),
            },
            StreamEvent::ToolUseStart {
                id: "call_b".into(),
                name: "ls".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_b".into(),
                partial_json: "{}".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_a".into(),
                partial_json: "\"a.rs\"}".into(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_a".into(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_b".into(),
            },
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 40,
                    output_tokens: 9,
                    cache_read_tokens: 10,
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
        let events = run_fixture(&fixture(), ChatHandler::default).await;
        assert_eq!(events, expected());
        let (message, _, stop) = fold(&events);
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(
            message.content,
            vec![
                Block::Thinking {
                    text: "think ".into(),
                    signature: None
                },
                Block::text("Hello \u{00e9}"),
                Block::ToolUse {
                    id: "call_a".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.rs"})
                },
                Block::ToolUse {
                    id: "call_b".into(),
                    name: "ls".into(),
                    input: json!({})
                },
            ]
        );
    }

    #[tokio::test]
    async fn finish_reasons_and_missing_done() {
        let s = chunk(json!({"choices": [{"delta": {"content": "x"}, "finish_reason": "length"}]}));
        let events = run_handler(vec![s.into_bytes()], ChatHandler::default())
            .await
            .unwrap();
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Stop {
                reason: StopReason::MaxTokens
            })
        );

        // Local servers sometimes say "stop" even when calling tools; no index, no id.
        let s = [
            chunk(json!({"choices": [{"delta": {"tool_calls": [{"function": {"name": "t", "arguments": "{\"a\":1}"}}]}}]})),
            chunk(json!({"choices": [{"delta": {}, "finish_reason": "stop"}]})),
        ]
        .concat();
        let events = run_handler(vec![s.into_bytes()], ChatHandler::default())
            .await
            .unwrap();
        let (message, _, stop) = fold(&events);
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(
            message.content,
            vec![Block::ToolUse {
                id: "call_0".into(),
                name: "t".into(),
                input: json!({"a": 1})
            }]
        );

        let truncated = chunk(json!({"choices": [{"delta": {"content": "x"}}]}));
        assert!(matches!(
            run_handler(vec![truncated.into_bytes()], ChatHandler::default()).await,
            Err(HarnessError::Protocol(_))
        ));
        let err = chunk(json!({"error": {"message": "nope"}}));
        assert!(matches!(
            run_handler(vec![err.into_bytes()], ChatHandler::default()).await,
            Err(HarnessError::Provider { .. })
        ));
    }

    #[test]
    fn body_golden_with_tool_round_trip() {
        let req = ProviderRequest {
            model: "local".into(),
            system: Some("sys".into()),
            messages: vec![
                Message::user("hi"),
                Message::assistant(vec![
                    Block::text("calling"),
                    Block::ToolUse {
                        id: "call_1".into(),
                        name: "read_file".into(),
                        input: json!({"path": "a"}),
                    },
                ]),
                Message {
                    role: Role::User,
                    content: vec![
                        Block::ToolResult {
                            tool_use_id: "call_1".into(),
                            content: vec![Block::text("data")],
                            is_error: false,
                        },
                        Block::text("thanks"),
                        Block::Image {
                            media_type: "image/png".into(),
                            data: "QQ==".into(),
                        },
                    ],
                },
            ],
            tools: vec![ToolSpec {
                name: "read_file".into(),
                description: "d".into(),
                input_schema: json!({"type": "object"}),
            }],
            max_tokens: Some(256),
            temperature: Some(0.1),
            reasoning_effort: Some("medium".into()),
        };
        assert_eq!(
            build_body(&req),
            json!({
                "model": "local",
                "stream": true,
                "stream_options": {"include_usage": true},
                "max_tokens": 256,
                "temperature": 0.1,
                "reasoning_effort": "medium",
                "tools": [{"type": "function", "function": {"name": "read_file", "description": "d", "parameters": {"type": "object"}}}],
                "messages": [
                    {"role": "system", "content": "sys"},
                    {"role": "user", "content": "hi"},
                    {"role": "assistant", "content": "calling", "tool_calls": [
                        {"id": "call_1", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"a\"}"}}]},
                    {"role": "tool", "tool_call_id": "call_1", "content": "data"},
                    {"role": "user", "content": [
                        {"type": "text", "text": "thanks"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QQ=="}},
                    ]},
                ],
            })
        );
        // Assistant with only tool calls -> content null.
        let req = ProviderRequest {
            messages: vec![Message::assistant(vec![Block::ToolUse {
                id: "c".into(),
                name: "n".into(),
                input: json!({}),
            }])],
            ..Default::default()
        };
        assert_eq!(build_body(&req)["messages"][0]["content"], Value::Null);
    }

    #[tokio::test]
    async fn end_to_end_stream_against_local_server_with_and_without_v1() {
        for suffix in ["", "/v1"] {
            let (base, handle) = serve_once(200, "text/event-stream", fixture());
            let provider = OpenAiChatProvider::with_client(
                ProviderConfig {
                    base_url: format!("{base}{suffix}/"),
                    api_key: None,
                    bearer_auth: false,
                    extra_headers: vec![],
                },
                test_client(),
            );
            let stream = provider
                .stream(ProviderRequest {
                    model: "m".into(),
                    messages: vec![Message::user("hi")],
                    ..Default::default()
                })
                .await
                .unwrap();
            assert_eq!(collect_stream(stream).await.unwrap(), expected());
            let request = handle.join().unwrap().to_lowercase();
            assert!(
                request.starts_with("post /v1/chat/completions "),
                "{request}"
            );
            assert!(!request.contains("authorization:"));
        }
    }
}
