//! Google Gemini adapter (`streamGenerateContent?alt=sse`).

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use super::sse::{
    auth_headers, blocks_text, build_client, handle_events, post_json_logged, sse_events_tap,
    stream_event_error, temp_json, EventHandler, SseEvent,
};
use super::{Provider, ProviderConfig, ProviderRequest, ProviderStream};
use crate::{Block, HarnessError, HarnessResult, Role, StopReason, StreamEvent, Usage};

pub struct GeminiProvider {
    config: ProviderConfig,
    client: reqwest::Client,
    recorder: Option<super::record::Recorder>,
}

impl GeminiProvider {
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

    pub fn endpoint(&self, model: &str) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        let model = model.strip_prefix("models/").unwrap_or(model);
        let version = base.rsplit('/').next().unwrap_or("");
        let root = if version.starts_with("v1") {
            base.to_string()
        } else {
            format!("{base}/v1beta")
        };
        format!("{root}/models/{model}:streamGenerateContent?alt=sse")
    }

    pub fn headers(&self) -> Vec<(String, String)> {
        auth_headers(&self.config, "x-goog-api-key", &[])
    }
}

fn thinking_budget(effort: &str) -> Option<u32> {
    match effort {
        "low" => Some(1024),
        "medium" => Some(8192),
        "high" => Some(24576),
        "max" => Some(32768),
        _ => None,
    }
}

/// Gemini accepts only an OpenAPI subset; drop keys it rejects.
fn sanitize_schema(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, v) in map {
                if matches!(key.as_str(), "$schema" | "additionalProperties" | "$id") {
                    continue;
                }
                // Property names are arbitrary; only recurse into values.
                out.insert(key.clone(), sanitize_schema(v));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_schema).collect()),
        other => other.clone(),
    }
}

fn function_declaration(tool: &crate::ToolSpec) -> Value {
    let mut decl = json!({"name": tool.name, "description": tool.description});
    let has_props = tool
        .input_schema
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|p| !p.is_empty());
    if has_props {
        decl["parameters"] = sanitize_schema(&tool.input_schema);
    }
    decl
}

/// Build the JSON request body.
pub fn build_body(req: &ProviderRequest) -> Value {
    // Gemini has no tool-call ids: map id -> tool name from the history.
    let mut names: HashMap<&str, &str> = HashMap::new();
    for message in &req.messages {
        for (id, name, _) in message.tool_uses() {
            names.insert(id, name);
        }
    }

    let mut contents: Vec<Value> = Vec::new();
    for message in &req.messages {
        let mut parts: Vec<Value> = Vec::new();
        for block in &message.content {
            match block {
                Block::Text { text } if !text.is_empty() => parts.push(json!({"text": text})),
                Block::Text { .. } => {}
                Block::Image { media_type, data } => {
                    parts.push(json!({"inlineData": {"mimeType": media_type, "data": data}}));
                }
                Block::Thinking { .. } => {}
                Block::ToolUse { name, input, .. } => {
                    parts.push(json!({"functionCall": {"name": name, "args": input}}));
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let name = names
                        .get(tool_use_id.as_str())
                        .copied()
                        .unwrap_or("unknown_tool");
                    let text = blocks_text(content);
                    let response = if *is_error {
                        json!({"error": text})
                    } else {
                        json!({"output": text})
                    };
                    parts.push(json!({"functionResponse": {"name": name, "response": response}}));
                    for b in content {
                        if let Block::Image { media_type, data } = b {
                            parts.push(
                                json!({"inlineData": {"mimeType": media_type, "data": data}}),
                            );
                        }
                    }
                }
            }
        }
        if parts.is_empty() {
            continue;
        }
        let role = match message.role {
            Role::User => "user",
            Role::Assistant => "model",
        };
        contents.push(json!({"role": role, "parts": parts}));
    }

    let mut body = json!({"contents": contents});
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        body["systemInstruction"] = json!({"parts": [{"text": system}]});
    }
    if !req.tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": req.tools.iter().map(function_declaration).collect::<Vec<_>>()
        }]);
    }
    let mut config = Map::new();
    if let Some(max) = req.max_tokens {
        config.insert("maxOutputTokens".into(), json!(max));
    }
    if let Some(t) = req.temperature {
        config.insert("temperature".into(), temp_json(t));
    }
    if let Some(budget) = req.reasoning_effort.as_deref().and_then(thinking_budget) {
        config.insert(
            "thinkingConfig".into(),
            json!({"includeThoughts": true, "thinkingBudget": budget}),
        );
    }
    if !config.is_empty() {
        body["generationConfig"] = Value::Object(config);
    }
    body
}

#[async_trait]
impl Provider for GeminiProvider {
    fn id(&self) -> &str {
        "gemini"
    }

    async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream> {
        let body = build_body(&request);
        let url = self.endpoint(&request.model);
        let (resp, tap) = post_json_logged(
            &self.client,
            &url,
            &self.headers(),
            &body,
            self.recorder.as_ref(),
            self.id(),
            &request.model,
        )
        .await?;
        let prefix = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        Ok(handle_events(
            sse_events_tap(resp, tap),
            GeminiHandler::new(prefix),
        ))
    }
}

pub struct GeminiHandler {
    prefix: String,
    next: u32,
    any_call: bool,
    finish: Option<StopReason>,
    emitted_usage: Usage,
    seen_candidate: bool,
}

impl GeminiHandler {
    /// `prefix` makes synthesized ids unique across turns/sessions.
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
            next: 0,
            any_call: false,
            finish: None,
            emitted_usage: Usage::default(),
            seen_candidate: false,
        }
    }

    /// Metadata counters are cumulative. Publish each known delta immediately
    /// so transport errors, invalid finishes, or a dropped stream cannot hide
    /// usage that was already received. Repeated/regressing counters must not
    /// reset the high-water marks or charge the same tokens a second time.
    fn usage_event(&mut self, meta: &Value) -> Option<StreamEvent> {
        let get = |key: &str| meta.get(key).and_then(Value::as_u64).unwrap_or(0);
        let cached = get("cachedContentTokenCount");
        let usage = Usage {
            input_tokens: get("promptTokenCount").saturating_sub(cached),
            output_tokens: get("candidatesTokenCount").saturating_add(get("thoughtsTokenCount")),
            cache_read_tokens: cached,
            cache_write_tokens: 0,
        };
        let delta = Usage {
            input_tokens: usage
                .input_tokens
                .saturating_sub(self.emitted_usage.input_tokens),
            output_tokens: usage
                .output_tokens
                .saturating_sub(self.emitted_usage.output_tokens),
            cache_read_tokens: usage
                .cache_read_tokens
                .saturating_sub(self.emitted_usage.cache_read_tokens),
            cache_write_tokens: 0,
        };
        self.emitted_usage = Usage {
            input_tokens: usage.input_tokens.max(self.emitted_usage.input_tokens),
            output_tokens: usage.output_tokens.max(self.emitted_usage.output_tokens),
            cache_read_tokens: usage
                .cache_read_tokens
                .max(self.emitted_usage.cache_read_tokens),
            cache_write_tokens: 0,
        };
        (delta != Usage::default()).then_some(StreamEvent::Usage { usage: delta })
    }
}

fn map_finish(reason: &str) -> StopReason {
    match reason {
        "STOP" => StopReason::EndTurn,
        "MAX_TOKENS" => StopReason::MaxTokens,
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" => {
            StopReason::Refusal
        }
        _ => StopReason::Other,
    }
}

impl EventHandler for GeminiHandler {
    fn on_event(&mut self, event: &SseEvent) -> HarnessResult<Vec<StreamEvent>> {
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|e| HarnessError::Protocol(format!("invalid Gemini SSE JSON: {e}")))?;
        if let Some(error) = value.get("error").filter(|e| e.is_object()) {
            let message = error["message"].as_str().unwrap_or("unknown error");
            let status = error["status"].as_str().unwrap_or("");
            let retryable = matches!(status, "UNAVAILABLE" | "RESOURCE_EXHAUSTED" | "INTERNAL");
            return Err(stream_event_error(
                &format!("{status}: {message}"),
                retryable,
            ));
        }
        let mut out = Vec::new();
        if value.pointer("/promptFeedback/blockReason").is_some() && !self.seen_candidate {
            self.finish = Some(StopReason::Refusal);
        }
        if let Some(candidate) = value.pointer("/candidates/0") {
            self.seen_candidate = true;
            if let Some(parts) = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    if let Some(call) = part.get("functionCall") {
                        let id = format!("call_{}_{}", self.prefix, self.next);
                        self.next += 1;
                        self.any_call = true;
                        out.push(StreamEvent::ToolUseStart {
                            id: id.clone(),
                            name: call["name"].as_str().unwrap_or_default().into(),
                        });
                        let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
                        out.push(StreamEvent::ToolInputDelta {
                            id: id.clone(),
                            partial_json: args.to_string(),
                        });
                        out.push(StreamEvent::ToolUseEnd { id });
                    } else if let Some(text) = part["text"].as_str().filter(|t| !t.is_empty()) {
                        if part["thought"].as_bool() == Some(true) {
                            out.push(StreamEvent::ThinkingDelta { text: text.into() });
                        } else {
                            out.push(StreamEvent::TextDelta { text: text.into() });
                        }
                    }
                }
            }
            if let Some(reason) = candidate["finishReason"].as_str() {
                self.finish = Some(map_finish(reason));
            }
        }
        if let Some(meta) = value.get("usageMetadata").filter(|m| m.is_object()) {
            if let Some(event) = self.usage_event(meta) {
                out.push(event);
            }
        }
        Ok(out)
    }

    fn on_end(&mut self) -> HarnessResult<Vec<StreamEvent>> {
        let Some(finish) = self.finish else {
            return Err(HarnessError::Protocol(
                "Gemini stream ended without a finishReason".into(),
            ));
        };
        let mut out = Vec::new();
        let reason = if finish == StopReason::EndTurn && self.any_call {
            StopReason::ToolUse
        } else {
            finish
        };
        out.push(StreamEvent::Stop { reason });
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::super::sse::test_support::*;
    use super::*;
    use crate::{Message, ToolSpec};

    fn chunk(v: Value) -> String {
        format!("data: {v}\r\n\r\n")
    }

    fn fixture() -> String {
        [
            chunk(json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "weighing", "thought": true}]}}],
                "usageMetadata": {"promptTokenCount": 10, "totalTokenCount": 10}})),
            chunk(json!({"candidates": [{"content": {"role": "model", "parts": [{"text": "Hi \u{1F600}"}]}}]})),
            chunk(json!({"candidates": [{"content": {"role": "model", "parts": [
                {"functionCall": {"name": "read_file", "args": {"path": "a.rs"}}},
                {"functionCall": {"name": "ls"}}]},
                "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 8, "thoughtsTokenCount": 2, "cachedContentTokenCount": 40}})),
        ]
        .concat()
    }

    fn expected() -> Vec<StreamEvent> {
        vec![
            StreamEvent::ThinkingDelta {
                text: "weighing".into(),
            },
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 10,
                    ..Usage::default()
                },
            },
            StreamEvent::TextDelta {
                text: "Hi \u{1F600}".into(),
            },
            StreamEvent::ToolUseStart {
                id: "call_t_0".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_t_0".into(),
                partial_json: "{\"path\":\"a.rs\"}".into(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_t_0".into(),
            },
            StreamEvent::ToolUseStart {
                id: "call_t_1".into(),
                name: "ls".into(),
            },
            StreamEvent::ToolInputDelta {
                id: "call_t_1".into(),
                partial_json: "{}".into(),
            },
            StreamEvent::ToolUseEnd {
                id: "call_t_1".into(),
            },
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 50,
                    output_tokens: 10,
                    cache_read_tokens: 40,
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
        let events = run_fixture(&fixture(), || GeminiHandler::new("t")).await;
        assert_eq!(events, expected());
        let (message, usage, stop) = fold(&events);
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(
            usage,
            Usage {
                input_tokens: 60,
                output_tokens: 10,
                cache_read_tokens: 40,
                cache_write_tokens: 0,
            }
        );
        assert_eq!(
            message.content,
            vec![
                Block::Thinking {
                    text: "weighing".into(),
                    signature: None
                },
                Block::text("Hi \u{1F600}"),
                Block::ToolUse {
                    id: "call_t_0".into(),
                    name: "read_file".into(),
                    input: json!({"path": "a.rs"})
                },
                Block::ToolUse {
                    id: "call_t_1".into(),
                    name: "ls".into(),
                    input: json!({})
                },
            ]
        );
    }

    fn event(value: Value) -> SseEvent {
        SseEvent {
            event: None,
            data: value.to_string(),
        }
    }

    #[test]
    fn usage_deltas_keep_high_water_marks_and_do_not_repeat_at_eof() {
        let mut handler = GeminiHandler::new("t");
        let first = json!({"promptTokenCount": 100, "cachedContentTokenCount": 40,
            "candidatesTokenCount": 5, "thoughtsTokenCount": 3});
        assert_eq!(
            handler
                .on_event(&event(json!({"usageMetadata": first})))
                .unwrap(),
            vec![StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 60,
                    output_tokens: 8,
                    cache_read_tokens: 40,
                    cache_write_tokens: 0,
                }
            }]
        );
        for metadata in [
            first,
            json!({"promptTokenCount": 50, "cachedContentTokenCount": 20,
                "candidatesTokenCount": 1, "thoughtsTokenCount": 2}),
            json!({}),
        ] {
            assert!(handler
                .on_event(&event(json!({"usageMetadata": metadata})))
                .unwrap()
                .is_empty());
        }
        assert_eq!(
            handler
                .on_event(&event(json!({
                    "candidates": [{"finishReason": "STOP"}],
                    "usageMetadata": {"promptTokenCount": 120, "cachedContentTokenCount": 45,
                        "candidatesTokenCount": 9, "thoughtsTokenCount": 5}
                })))
                .unwrap(),
            vec![StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 15,
                    output_tokens: 6,
                    cache_read_tokens: 5,
                    cache_write_tokens: 0,
                }
            }]
        );
        assert_eq!(
            handler.on_end().unwrap(),
            vec![StreamEvent::Stop {
                reason: StopReason::EndTurn
            }]
        );
    }

    #[test]
    fn usage_arithmetic_saturates_and_ignores_invalid_counters() {
        let mut handler = GeminiHandler::new("t");
        assert_eq!(
            handler.usage_event(&json!({
                "promptTokenCount": 1, "cachedContentTokenCount": 3,
                "candidatesTokenCount": u64::MAX, "thoughtsTokenCount": 1
            })),
            Some(StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 0,
                    output_tokens: u64::MAX,
                    cache_read_tokens: 3,
                    cache_write_tokens: 0,
                }
            })
        );
        assert_eq!(
            handler.usage_event(&json!({
                "promptTokenCount": -1, "cachedContentTokenCount": "bad",
                "candidatesTokenCount": null, "thoughtsTokenCount": -3
            })),
            None
        );
        assert_eq!(
            handler.usage_event(&json!({
                "candidatesTokenCount": u64::MAX, "thoughtsTokenCount": u64::MAX
            })),
            None
        );
    }

    #[tokio::test]
    async fn usage_is_yielded_before_transport_handler_or_missing_finish_errors() {
        for ending in [
            "transport",
            "invalid-json",
            "provider",
            "missing-finish",
            "invalid-finish",
        ] {
            let metadata = chunk(json!({"usageMetadata": {
                "promptTokenCount": 40, "candidatesTokenCount": 2
            }}));
            let mut bytes = vec![Ok(metadata.into_bytes())];
            match ending {
                "transport" => bytes.push(Err("connection reset".to_string())),
                "invalid-json" => bytes.push(Ok(b"data: {bad json}\n\n".to_vec())),
                "provider" => bytes.push(Ok(chunk(json!({"error": {
                    "status": "UNAVAILABLE", "message": "busy"
                }}))
                .into_bytes())),
                "invalid-finish" => bytes.push(Ok(chunk(json!({
                    "candidates": [{"finishReason": 42}]
                }))
                .into_bytes())),
                "missing-finish" => {}
                _ => unreachable!(),
            }
            let mut stream = handle_events(
                super::super::sse::sse_from_bytes(futures_util::stream::iter(bytes)),
                GeminiHandler::new("t"),
            );
            assert_eq!(
                stream.next().await.unwrap().unwrap(),
                StreamEvent::Usage {
                    usage: Usage {
                        input_tokens: 40,
                        output_tokens: 2,
                        ..Usage::default()
                    }
                },
                "{ending}"
            );
            assert!(stream.next().await.unwrap().is_err(), "{ending}");
            assert!(stream.next().await.is_none(), "{ending}");
        }
    }

    #[tokio::test]
    async fn usage_does_not_wait_for_eof_when_stream_is_dropped() {
        let events = futures_util::stream::iter([Ok(event(json!({"usageMetadata": {
            "promptTokenCount": 12, "cachedContentTokenCount": 2
        }})))])
        .chain(futures_util::stream::pending());
        let mut stream = handle_events(events, GeminiHandler::new("t"));
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            StreamEvent::Usage {
                usage: Usage {
                    input_tokens: 10,
                    cache_read_tokens: 2,
                    ..Usage::default()
                }
            }
        );
        drop(stream);
    }

    #[tokio::test]
    async fn finish_reasons_blocks_and_errors() {
        let s = chunk(
            json!({"candidates": [{"content": {"parts": [{"text": "x"}]}, "finishReason": "MAX_TOKENS"}]}),
        );
        let events = run_handler(vec![s.into_bytes()], GeminiHandler::new("t"))
            .await
            .unwrap();
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Stop {
                reason: StopReason::MaxTokens
            })
        );

        let s = chunk(json!({"promptFeedback": {"blockReason": "SAFETY"}}));
        let events = run_handler(vec![s.into_bytes()], GeminiHandler::new("t"))
            .await
            .unwrap();
        assert_eq!(
            events,
            vec![StreamEvent::Stop {
                reason: StopReason::Refusal
            }]
        );

        let s = chunk(json!({"error": {"code": 503, "status": "UNAVAILABLE", "message": "busy"}}));
        assert!(matches!(
            run_handler(vec![s.into_bytes()], GeminiHandler::new("t")).await,
            Err(HarnessError::Provider {
                retryable: true,
                ..
            })
        ));
        assert!(matches!(
            run_handler(vec![], GeminiHandler::new("t")).await,
            Err(HarnessError::Protocol(_))
        ));
    }

    #[test]
    fn body_golden_with_tool_round_trip() {
        let req = ProviderRequest {
            model: "gemini-x".into(),
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
                        id: "call_t_0".into(),
                        name: "read_file".into(),
                        input: json!({"path": "a"}),
                    },
                ]),
                Message {
                    role: Role::User,
                    content: vec![
                        Block::ToolResult {
                            tool_use_id: "call_t_0".into(),
                            content: vec![Block::text("data")],
                            is_error: false,
                        },
                        Block::ToolResult {
                            tool_use_id: "missing".into(),
                            content: vec![Block::text("bad")],
                            is_error: true,
                        },
                        Block::Image {
                            media_type: "image/png".into(),
                            data: "QQ==".into(),
                        },
                    ],
                },
            ],
            tools: vec![
                ToolSpec {
                    name: "read_file".into(),
                    description: "d".into(),
                    input_schema: json!({"$schema": "x", "type": "object", "additionalProperties": false,
                        "properties": {"path": {"type": "string"}}}),
                },
                ToolSpec {
                    name: "noargs".into(),
                    description: "n".into(),
                    input_schema: json!({"type": "object", "properties": {}}),
                },
            ],
            max_tokens: Some(512),
            temperature: Some(0.4),
            reasoning_effort: Some("low".into()),
        };
        assert_eq!(
            build_body(&req),
            json!({
                "systemInstruction": {"parts": [{"text": "sys"}]},
                "generationConfig": {"maxOutputTokens": 512, "temperature": 0.4,
                    "thinkingConfig": {"includeThoughts": true, "thinkingBudget": 1024}},
                "tools": [{"functionDeclarations": [
                    {"name": "read_file", "description": "d",
                     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}},
                    {"name": "noargs", "description": "n"},
                ]}],
                "contents": [
                    {"role": "user", "parts": [{"text": "hi"}]},
                    {"role": "model", "parts": [
                        {"text": "calling"},
                        {"functionCall": {"name": "read_file", "args": {"path": "a"}}}]},
                    {"role": "user", "parts": [
                        {"functionResponse": {"name": "read_file", "response": {"output": "data"}}},
                        {"functionResponse": {"name": "unknown_tool", "response": {"error": "bad"}}},
                        {"inlineData": {"mimeType": "image/png", "data": "QQ=="}},
                    ]},
                ],
            })
        );
    }

    #[test]
    fn endpoint_forms() {
        let mk = |base: &str| {
            GeminiProvider::new(ProviderConfig {
                base_url: base.into(),
                api_key: None,
                bearer_auth: false,
                extra_headers: vec![],
            })
        };
        assert_eq!(
            mk("https://generativelanguage.googleapis.com/").endpoint("models/g-1"),
            "https://generativelanguage.googleapis.com/v1beta/models/g-1:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            mk("http://h/v1beta").endpoint("g-1"),
            "http://h/v1beta/models/g-1:streamGenerateContent?alt=sse"
        );
    }

    #[tokio::test]
    async fn end_to_end_stream_against_local_server() {
        let (base, handle) = serve_once(200, "text/event-stream", fixture());
        let provider = GeminiProvider::with_client(
            ProviderConfig {
                base_url: base,
                api_key: Some("g-key".into()),
                bearer_auth: false,
                extra_headers: vec![],
            },
            test_client(),
        );
        let stream = provider
            .stream(ProviderRequest {
                model: "gemini-x".into(),
                messages: vec![Message::user("hi")],
                ..Default::default()
            })
            .await
            .unwrap();
        let events = collect_stream(stream).await.unwrap();
        // Ids carry a random prefix; normalize before comparing.
        let normalized: Vec<StreamEvent> = events
            .iter()
            .map(|e| match e.clone() {
                StreamEvent::ToolUseStart { id, name } => StreamEvent::ToolUseStart {
                    id: norm(&id),
                    name,
                },
                StreamEvent::ToolInputDelta { id, partial_json } => StreamEvent::ToolInputDelta {
                    id: norm(&id),
                    partial_json,
                },
                StreamEvent::ToolUseEnd { id } => StreamEvent::ToolUseEnd { id: norm(&id) },
                other => other,
            })
            .collect();
        assert_eq!(normalized, expected());
        let request = handle.join().unwrap().to_lowercase();
        assert!(request.starts_with("post /v1beta/models/gemini-x:streamgeneratecontent?alt=sse "));
        assert!(request.contains("x-goog-api-key: g-key"));
    }

    fn norm(id: &str) -> String {
        let n = id.rsplit('_').next().unwrap();
        format!("call_t_{n}")
    }
}
