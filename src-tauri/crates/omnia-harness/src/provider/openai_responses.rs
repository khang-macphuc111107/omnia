//! OpenAI Responses API adapter (`/v1/responses`, streaming).

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use serde_json::{json, Value};

use super::sse::{
    auth_headers, blocks_text, build_client, data_uri, handle_events, post_json_logged,
    sse_events_tap, stream_event_error, temp_json, versioned_url, EventHandler, SseEvent,
};
use super::{Provider, ProviderConfig, ProviderRequest, ProviderStream};
use crate::{Block, HarnessError, HarnessResult, Role, StopReason, StreamEvent, Usage};

pub struct OpenAiResponsesProvider {
    config: ProviderConfig,
    client: reqwest::Client,
    recorder: Option<super::record::Recorder>,
}

impl OpenAiResponsesProvider {
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
        versioned_url(&self.config.base_url, "responses")
    }

    pub fn headers(&self) -> Vec<(String, String)> {
        let mut config = self.config.clone();
        config.bearer_auth = true; // Responses API is always Bearer
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

fn image_part(media_type: &str, data: &str) -> Value {
    json!({"type": "input_image", "image_url": data_uri(media_type, data)})
}

/// Build the JSON request body.
pub fn build_body(req: &ProviderRequest) -> Value {
    let mut input: Vec<Value> = Vec::new();
    for message in &req.messages {
        // Pending message content, flushed whenever a function item interrupts.
        let mut parts: Vec<Value> = Vec::new();
        let role = match message.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        let flush = |parts: &mut Vec<Value>, input: &mut Vec<Value>| {
            if !parts.is_empty() {
                input.push(
                    json!({"type": "message", "role": role, "content": std::mem::take(parts)}),
                );
            }
        };
        let text_type = if message.role == Role::User {
            "input_text"
        } else {
            "output_text"
        };
        for block in &message.content {
            match block {
                Block::Text { text } if !text.is_empty() => {
                    parts.push(json!({"type": text_type, "text": text}));
                }
                Block::Text { .. } => {}
                Block::Image { media_type, data } => {
                    if message.role == Role::User {
                        parts.push(image_part(media_type, data));
                    }
                }
                // Reasoning items cannot be replayed without their ids.
                Block::Thinking { .. } => {}
                Block::ToolUse {
                    id,
                    name,
                    input: args,
                } => {
                    flush(&mut parts, &mut input);
                    input.push(json!({
                        "type": "function_call",
                        "call_id": id,
                        "name": name,
                        "arguments": args.to_string(),
                    }));
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } => {
                    flush(&mut parts, &mut input);
                    let mut output = blocks_text(content);
                    if output.is_empty() {
                        output = "(no output)".into();
                    }
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": tool_use_id,
                        "output": output,
                    }));
                    let images: Vec<Value> = content
                        .iter()
                        .filter_map(|b| match b {
                            Block::Image { media_type, data } => Some(image_part(media_type, data)),
                            _ => None,
                        })
                        .collect();
                    if !images.is_empty() {
                        input.push(json!({"type": "message", "role": "user", "content": images}));
                    }
                }
            }
        }
        flush(&mut parts, &mut input);
    }

    let mut body = json!({
        "model": req.model,
        "input": input,
        "stream": true,
        "store": false,
    });
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        body["instructions"] = json!(system);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    })
                })
                .collect(),
        );
    }
    if let Some(max) = req.max_tokens {
        body["max_output_tokens"] = json!(max);
    }
    match req.reasoning_effort.as_deref().and_then(effort) {
        Some(e) => body["reasoning"] = json!({"effort": e, "summary": "auto"}),
        None => {
            if let Some(t) = req.temperature {
                body["temperature"] = temp_json(t);
            }
        }
    }
    body
}

#[async_trait]
impl Provider for OpenAiResponsesProvider {
    fn id(&self) -> &str {
        "openai_responses"
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
            ResponsesHandler::default(),
        ))
    }
}

#[derive(Default)]
pub struct ResponsesHandler {
    /// item id / output index -> call_id
    by_item: HashMap<String, String>,
    by_index: HashMap<u64, String>,
    got_args: HashSet<String>,
    any_call: bool,
    stopped: bool,
}

fn usage_of(response: &Value) -> Usage {
    let usage = &response["usage"];
    let get = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    let input = get(usage, "input_tokens");
    let cached = usage
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Usage {
        input_tokens: input.saturating_sub(cached),
        output_tokens: get(usage, "output_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: 0,
    }
}

impl ResponsesHandler {
    fn resolve(&self, value: &Value) -> Option<String> {
        value
            .get("item_id")
            .and_then(Value::as_str)
            .and_then(|id| self.by_item.get(id))
            .or_else(|| {
                value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .and_then(|i| self.by_index.get(&i))
            })
            .cloned()
    }

    fn finish(&mut self, response: &Value, incomplete: bool, out: &mut Vec<StreamEvent>) {
        let usage = usage_of(response);
        if usage != Usage::default() {
            out.push(StreamEvent::Usage { usage });
        }
        let reason = if incomplete {
            match response
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
            {
                Some("max_output_tokens") => StopReason::MaxTokens,
                Some("content_filter") => StopReason::Refusal,
                _ => StopReason::Other,
            }
        } else if self.any_call {
            StopReason::ToolUse
        } else {
            StopReason::EndTurn
        };
        self.stopped = true;
        out.push(StreamEvent::Stop { reason });
    }
}

impl EventHandler for ResponsesHandler {
    fn on_event(&mut self, event: &SseEvent) -> HarnessResult<Vec<StreamEvent>> {
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| HarnessError::Protocol(format!("invalid Responses SSE JSON: {e}")))?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .unwrap_or("");
        let mut out = Vec::new();
        match kind {
            "response.output_text.delta" => {
                if let Some(text) = value["delta"].as_str().filter(|t| !t.is_empty()) {
                    out.push(StreamEvent::TextDelta { text: text.into() });
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(text) = value["delta"].as_str().filter(|t| !t.is_empty()) {
                    out.push(StreamEvent::ThinkingDelta { text: text.into() });
                }
            }
            "response.output_item.added" => {
                let item = &value["item"];
                if item["type"] == "function_call" {
                    let call_id = item["call_id"]
                        .as_str()
                        .or_else(|| item["id"].as_str())
                        .unwrap_or_default()
                        .to_string();
                    if let Some(id) = item["id"].as_str() {
                        self.by_item.insert(id.to_string(), call_id.clone());
                    }
                    if let Some(i) = value["output_index"].as_u64() {
                        self.by_index.insert(i, call_id.clone());
                    }
                    self.any_call = true;
                    out.push(StreamEvent::ToolUseStart {
                        id: call_id,
                        name: item["name"].as_str().unwrap_or_default().into(),
                    });
                }
            }
            "response.function_call_arguments.delta" => {
                if let (Some(id), Some(delta)) = (self.resolve(&value), value["delta"].as_str()) {
                    self.got_args.insert(id.clone());
                    out.push(StreamEvent::ToolInputDelta {
                        id,
                        partial_json: delta.into(),
                    });
                }
            }
            "response.output_item.done" => {
                let item = &value["item"];
                if item["type"] == "function_call" {
                    let id = item["call_id"]
                        .as_str()
                        .or_else(|| item["id"].as_str())
                        .unwrap_or_default()
                        .to_string();
                    if !self.got_args.contains(&id) {
                        if let Some(args) = item["arguments"].as_str().filter(|a| !a.is_empty()) {
                            out.push(StreamEvent::ToolInputDelta {
                                id: id.clone(),
                                partial_json: args.into(),
                            });
                        }
                    }
                    out.push(StreamEvent::ToolUseEnd { id });
                }
            }
            "response.completed" => self.finish(&value["response"], false, &mut out),
            "response.incomplete" => self.finish(&value["response"], true, &mut out),
            "response.failed" => {
                let error = &value["response"]["error"];
                let message = error["message"].as_str().unwrap_or("response failed");
                let code = error["code"].as_str().unwrap_or("");
                return Err(stream_event_error(
                    &format!("{code}: {message}"),
                    matches!(code, "server_error" | "rate_limit_exceeded"),
                ));
            }
            "error" => {
                let message = value["message"]
                    .as_str()
                    .or_else(|| value.pointer("/error/message").and_then(Value::as_str))
                    .unwrap_or("unknown error");
                let code = value["code"]
                    .as_str()
                    .or_else(|| value.pointer("/error/code").and_then(Value::as_str))
                    .unwrap_or("");
                return Err(stream_event_error(
                    &format!("{code}: {message}"),
                    matches!(code, "server_error" | "rate_limit_exceeded"),
                ));
            }
            _ => {}
        }
        Ok(out)
    }

    fn on_end(&mut self) -> HarnessResult<Vec<StreamEvent>> {
        if self.stopped {
            Ok(Vec::new())
        } else {
            Err(HarnessError::Protocol(
                "Responses stream ended before response.completed".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::sse::test_support::*;
    use super::*;
    use crate::{Message, ToolSpec};

    fn sse(kind: &str, data: Value) -> String {
        format!("event: {kind}\ndata: {data}\n\n")
    }

    fn fixture() -> String {
        [
            sse("response.created", json!({"type": "response.created", "response": {}})),
            sse("response.reasoning_summary_text.delta", json!({"type": "response.reasoning_summary_text.delta", "delta": "Plan. "})),
            sse("response.output_text.delta", json!({"type": "response.output_text.delta", "delta": "Sure \u{2014} "})),
            sse("response.output_text.delta", json!({"type": "response.output_text.delta", "delta": "reading."})),
            sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": 2,
                "item": {"type": "function_call", "id": "fc_9", "call_id": "call_abc", "name": "read_file", "arguments": ""}})),
            sse("response.function_call_arguments.delta", json!({"type": "response.function_call_arguments.delta", "item_id": "fc_9", "output_index": 2, "delta": "{\"path\":"})),
            sse("response.function_call_arguments.delta", json!({"type": "response.function_call_arguments.delta", "item_id": "fc_9", "output_index": 2, "delta": "\"a.rs\"}"})),
            sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": 2,
                "item": {"type": "function_call", "id": "fc_9", "call_id": "call_abc", "name": "read_file", "arguments": "{\"path\":\"a.rs\"}"}})),
            sse("response.completed", json!({"type": "response.completed", "response": {"status": "completed",
                "usage": {"input_tokens": 100, "output_tokens": 20, "input_tokens_details": {"cached_tokens": 30}}}})),
        ]
        .concat()
    }

    fn expected() -> Vec<StreamEvent> {
        vec![
            StreamEvent::ThinkingDelta {
                text: "Plan. ".into(),
            },
            StreamEvent::TextDelta {
                text: "Sure \u{2014} ".into(),
            },
            StreamEvent::TextDelta {
                text: "reading.".into(),
            },
            StreamEvent::ToolUseStart {
                id: "call_abc".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_abc".into(),
                partial_json: "{\"path\":".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_abc".into(),
                partial_json: "\"a.rs\"}".into(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_abc".into(),
            },
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 70,
                    output_tokens: 20,
                    cache_read_tokens: 30,
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
        let events = run_fixture(&fixture(), ResponsesHandler::default).await;
        assert_eq!(events, expected());
        let (message, usage, stop) = fold(&events);
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(usage.output_tokens, 20);
        assert_eq!(
            message.content,
            vec![
                Block::Thinking {
                    text: "Plan. ".into(),
                    signature: None
                },
                Block::text("Sure \u{2014} reading."),
                Block::ToolUse {
                    id: "call_abc".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.rs"})
                },
            ]
        );
    }

    #[tokio::test]
    async fn done_without_arg_deltas_and_incomplete_and_failed() {
        let s = [
            sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": 0,
                "item": {"type": "function_call", "id": "fc_1", "call_id": "c1", "name": "t"}})),
            sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": 0,
                "item": {"type": "function_call", "id": "fc_1", "call_id": "c1", "name": "t", "arguments": "{\"a\":1}"}})),
            sse("response.incomplete", json!({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max_output_tokens"}}})),
        ]
        .concat();
        let events = run_handler(vec![s.into_bytes()], ResponsesHandler::default())
            .await
            .unwrap();
        let (message, _, stop) = fold(&events);
        assert_eq!(stop, StopReason::MaxTokens);
        assert_eq!(
            message.content,
            vec![Block::ToolUse {
                id: "c1".into(),
                name: "t".into(),
                input: json!({"a": 1})
            }]
        );

        let failed = sse(
            "response.failed",
            json!({"type": "response.failed", "response": {"error": {"code": "server_error", "message": "oops"}}}),
        );
        assert!(matches!(
            run_handler(vec![failed.into_bytes()], ResponsesHandler::default()).await,
            Err(HarnessError::Provider {
                retryable: true,
                ..
            })
        ));
        let err = sse(
            "error",
            json!({"type": "error", "code": "invalid_prompt", "message": "bad"}),
        );
        assert!(matches!(
            run_handler(vec![err.into_bytes()], ResponsesHandler::default()).await,
            Err(HarnessError::Provider {
                retryable: false,
                ..
            })
        ));
    }

    #[test]
    fn body_golden_with_tool_round_trip() {
        let req = ProviderRequest {
            model: "gpt-x".into(),
            system: Some("sys".into()),
            messages: vec![
                Message::user("hi"),
                Message::assistant(vec![
                    Block::Thinking {
                        text: "t".into(),
                        signature: None,
                    },
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
            max_tokens: Some(1000),
            temperature: Some(0.3),
            reasoning_effort: Some("max".into()),
        };
        assert_eq!(
            build_body(&req),
            json!({
                "model": "gpt-x",
                "stream": true,
                "store": false,
                "instructions": "sys",
                "max_output_tokens": 1000,
                "reasoning": {"effort": "high", "summary": "auto"},
                "tools": [{"type": "function", "name": "read_file", "description": "d", "parameters": {"type": "object"}}],
                "input": [
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "calling"}]},
                    {"type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "{\"path\":\"a\"}"},
                    {"type": "function_call_output", "call_id": "call_1", "output": "data"},
                    {"type": "message", "role": "user", "content": [
                        {"type": "input_text", "text": "thanks"},
                        {"type": "input_image", "image_url": "data:image/png;base64,QQ=="},
                    ]},
                ],
            })
        );
    }

    #[tokio::test]
    async fn end_to_end_stream_against_local_server() {
        let (base, handle) = serve_once(200, "text/event-stream", fixture());
        let provider = OpenAiResponsesProvider::with_client(
            ProviderConfig {
                base_url: format!("{base}/v1"),
                api_key: Some("sk-test".into()),
                bearer_auth: false,
                extra_headers: vec![],
            },
            test_client(),
        );
        let stream = provider
            .stream(ProviderRequest {
                model: "gpt-x".into(),
                messages: vec![Message::user("hi")],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(collect_stream(stream).await.unwrap(), expected());
        let request = handle.join().unwrap().to_lowercase();
        assert!(request.starts_with("post /v1/responses "));
        assert!(request.contains("authorization: bearer sk-test"));
    }
}
