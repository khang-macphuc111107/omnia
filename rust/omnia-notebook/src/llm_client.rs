//! Real multi-dialect LLM client (`openai-completions`, `openai-responses`,
//! `anthropic-messages`, `google-gemini`) for `omnia-notebook`.
//!
//! Zero hardcoded/fake outputs: resolves endpoints from `omnia_agent::resolve_model_endpoint`
//! or explicit overrides/environment variables, redacts secrets, and validates endpoints.

use std::env;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use omnia_agent::{resolve_model_endpoint, ResolvedModelEndpoint};
use omnia_core::SecretRedactor;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::dispatcher::EffortLevel;
use crate::error::NotebookError;

const DEFAULT_LLM_TIMEOUT_SECS: u64 = 120;

/// Explicit or `models.yml`-backed LLM execution settings for `omnia-notebook`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookLlmConfig {
    pub model_spec: String,
    #[serde(default)]
    pub config_dir: Option<PathBuf>,
    #[serde(default)]
    pub api_base_override: Option<String>,
    #[serde(default)]
    pub api_key_override: Option<String>,
    #[serde(default)]
    pub wire_api_override: Option<String>,
    #[serde(default)]
    pub effort: Option<EffortLevel>,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u64,
    #[serde(default)]
    pub allow_loopback_endpoints: bool,
}

const fn default_temperature() -> f32 {
    0.25
}

const fn default_max_tokens() -> u64 {
    4096
}

impl Default for NotebookLlmConfig {
    fn default() -> Self {
        Self {
            model_spec: env::var("OMNIA_NOTEBOOK_MODEL")
                .unwrap_or_else(|_| "htmustc-gemini/gemini-3.5-flash-lite".to_string()),
            config_dir: None,
            api_base_override: env::var("OMNIA_NOTEBOOK_BASE_URL").ok(),
            api_key_override: env::var("OMNIA_NOTEBOOK_API_KEY").ok(),
            wire_api_override: env::var("OMNIA_NOTEBOOK_WIRE_API").ok(),
            effort: None,
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            allow_loopback_endpoints: false,
        }
    }
}

/// Real usage/model metadata returned from an LLM completion call (strictly secret-free).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotebookLlmResponse {
    pub text: String,
    pub model_id: String,
    pub provider_id: String,
    pub wire_api: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub latency_ms: u64,
}

/// Resolves a concrete [`ResolvedModelEndpoint`] from `models.yml` + env/explicit overrides,
/// returning [`NotebookError::ProviderUnconfigured`] cleanly when unconfigured.
pub fn resolve_notebook_endpoint(
    cfg: &NotebookLlmConfig,
) -> Result<ResolvedModelEndpoint, NotebookError> {
    let base_ov = cfg
        .api_base_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let key_ov = cfg
        .api_key_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut endpoint = resolve_model_endpoint(
        &cfg.model_spec,
        cfg.config_dir.as_deref(),
        base_ov,
        key_ov,
    )
    .map_err(|err| {
        NotebookError::ProviderUnconfigured(format!(
            "No LLM endpoint resolved for '{}': {}",
            cfg.model_spec,
            SecretRedactor::redact(&err.to_string())
        ))
    })?;

    if let Some(wire) = cfg
        .wire_api_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        endpoint.api = wire.to_string();
    }

    if endpoint.base_url.trim().is_empty() {
        return Err(NotebookError::ProviderUnconfigured(format!(
            "Resolved endpoint for '{}' has empty base_url",
            cfg.model_spec
        )));
    }
    if endpoint.api_key.trim().is_empty() && !is_local_unauthenticated_allowed(&endpoint.base_url) {
        return Err(NotebookError::ProviderUnconfigured(format!(
            "API key unavailable for provider '{}' (configure models.yml, Windows Credential Manager, or OMNIA_NOTEBOOK_API_KEY)",
            endpoint.provider_id
        )));
    }

    validate_endpoint_url(&endpoint.base_url, cfg.allow_loopback_endpoints)?;
    Ok(endpoint)
}

fn is_local_unauthenticated_allowed(base_url: &str) -> bool {
    Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|h| matches!(h.as_str(), "127.0.0.1" | "localhost" | "::1"))
}

fn validate_endpoint_url(base_url: &str, allow_loopback: bool) -> Result<(), NotebookError> {
    let parsed = Url::parse(base_url.trim()).map_err(|e| {
        NotebookError::InvalidInput(format!("invalid LLM base_url '{}': {e}", SecretRedactor::redact(base_url)))
    })?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(NotebookError::SecurityRejected {
            code: "INVALID_LLM_SCHEME",
            reason: "LLM base_url must use http or https".into(),
        });
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(NotebookError::SecurityRejected {
            code: "EMBEDDED_URL_CREDENTIALS",
            reason: "embedded credentials in LLM URL are forbidden".into(),
        });
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if is_loopback && !(allow_loopback || cfg!(test)) {
        return Ok(()); // Loopback local proxies (e.g. htmustc-proxy / ollama) are permitted over HTTP.
    }
    if parsed.scheme() != "https" && !is_loopback {
        return Err(NotebookError::SecurityRejected {
            code: "INSECURE_REMOTE_LLM_SCHEME",
            reason: "non-loopback LLM endpoint must use HTTPS".into(),
        });
    }
    Ok(())
}

/// Executes a real HTTP completion against `endpoint` supporting OpenAI Chat Completions,
/// OpenAI Responses API, Anthropic Messages API, and Google Gemini `generateContent`.
pub async fn complete_prompt(
    cfg: &NotebookLlmConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<NotebookLlmResponse, NotebookError> {
    let endpoint = resolve_notebook_endpoint(cfg)?;
    let started = Instant::now();
    let max_tokens = cfg.max_tokens.min(endpoint.max_tokens.max(512));

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(DEFAULT_LLM_TIMEOUT_SECS))
        .build()
        .map_err(|e| NotebookError::Http(SecretRedactor::redact(&e.to_string())))?;

    let api = endpoint.api.to_ascii_lowercase();
    let base = endpoint.base_url.trim_end_matches('/');

    let (url, body, mut req_builder) = if api.contains("anthropic") {
        let u = format!("{base}/v1/messages");
        let u = if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            u
        };
        let mut body = json!({
            "model": endpoint.model_id,
            "max_tokens": max_tokens,
            "system": system_prompt,
            "messages": [{ "role": "user", "content": user_prompt }],
            "stream": false
        });
        if let Some(budget) = match cfg.effort {
            Some(EffortLevel::High) => Some(2048),
            Some(EffortLevel::XHigh) => Some(4096),
            Some(EffortLevel::Max) => Some(8192),
            _ => None,
        } {
            body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
        }
        let rb = client
            .post(&u)
            .header("anthropic-version", "2023-06-01")
            .header("x-api-key", &endpoint.api_key);
        (u, body, rb)
    } else if api.contains("gemini") || api.contains("google") {
        let u = format!("{base}/models/{}:generateContent", endpoint.model_id);
        let body = json!({
            "systemInstruction": { "parts": [{ "text": system_prompt }] },
            "contents": [{ "role": "user", "parts": [{ "text": user_prompt }] }],
            "generationConfig": {
                "temperature": cfg.temperature,
                "maxOutputTokens": max_tokens
            }
        });
        let rb = if endpoint.auth_header {
            client.post(&u).bearer_auth(&endpoint.api_key)
        } else {
            client.post(&u).header("x-goog-api-key", &endpoint.api_key)
        };
        (u, body, rb)
    } else if api.contains("responses") {
        let u = if base.ends_with("/v1") {
            format!("{base}/responses")
        } else {
            format!("{base}/v1/responses")
        };
        let mut body = json!({
            "model": endpoint.model_id,
            "instructions": system_prompt,
            "input": [{ "role": "user", "content": [{ "type": "input_text", "text": user_prompt }] }],
            "max_output_tokens": max_tokens,
            "stream": false
        });
        if let Some(eff) = cfg.effort {
            body["reasoning"] = json!({ "effort": eff.as_str() });
        }
        let rb = client.post(&u).bearer_auth(&endpoint.api_key);
        (u, body, rb)
    } else {
        let u = if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else if base.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{base}/v1/chat/completions")
        };
        let mut body = json!({
            "model": endpoint.model_id,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ],
            "temperature": cfg.temperature,
            "max_tokens": max_tokens,
            "stream": false
        });
        if let Some(eff) = cfg.effort {
            body["reasoning_effort"] = json!(eff.as_str());
        }
        let rb = if endpoint.api_key.is_empty() {
            client.post(&u)
        } else {
            client.post(&u).bearer_auth(&endpoint.api_key)
        };
        (u, body, rb)
    };

    if !endpoint.api_key.is_empty() && !api.contains("anthropic") && !api.contains("gemini") {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", endpoint.api_key));
    }

    let resp = req_builder
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            NotebookError::Http(format!(
                "LLM request to {} failed: {}",
                SecretRedactor::redact(&url),
                SecretRedactor::redact(&e.to_string())
            ))
        })?;

    let status = resp.status();
    let raw_bytes = resp
        .bytes()
        .await
        .map_err(|e| NotebookError::Http(SecretRedactor::redact(&e.to_string())))?;
    let raw_text = String::from_utf8_lossy(&raw_bytes);

    if !status.is_success() {
        let snippet: String = raw_text.chars().take(500).collect();
        return Err(NotebookError::LlmFailed(format!(
            "LLM endpoint HTTP {}: {}",
            status.as_u16(),
            SecretRedactor::redact(&snippet)
        )));
    }

    let parsed: Value = serde_json::from_str(&raw_text).map_err(|e| {
        NotebookError::LlmFailed(format!(
            "LLM response was not valid JSON: {}",
            SecretRedactor::redact(&e.to_string())
        ))
    })?;

    let (text, in_tok, out_tok) = extract_completion_text_and_usage(&api, &parsed).ok_or_else(|| {
        NotebookError::LlmFailed("LLM response missing assistant text content".to_string())
    })?;

    Ok(NotebookLlmResponse {
        text,
        model_id: endpoint.model_id,
        provider_id: endpoint.provider_id,
        wire_api: endpoint.api,
        input_tokens: in_tok,
        output_tokens: out_tok,
        latency_ms: started.elapsed().as_millis() as u64,
    })
}

fn extract_completion_text_and_usage(api: &str, v: &Value) -> Option<(String, u64, u64)> {
    let usage = v.get("usage").or_else(|| v.get("usageMetadata"));
    let in_tok = usage
        .and_then(|u| {
            u.get("prompt_tokens")
                .or_else(|| u.get("input_tokens"))
                .or_else(|| u.get("promptTokenCount"))
        })
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let out_tok = usage
        .and_then(|u| {
            u.get("completion_tokens")
                .or_else(|| u.get("output_tokens"))
                .or_else(|| u.get("candidatesTokenCount"))
        })
        .and_then(Value::as_u64)
        .unwrap_or(0);

    if api.contains("anthropic") {
        let arr = v.get("content")?.as_array()?;
        let text = arr
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return Some((text, in_tok, out_tok));
        }
    }

    if api.contains("gemini") || api.contains("google") {
        if let Some(parts) = v
            .get("candidates")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_array)
        {
            let text = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return Some((text, in_tok, out_tok));
            }
        }
    }

    if let Some(output_text) = v.get("output_text").and_then(Value::as_str) {
        if !output_text.trim().is_empty() {
            return Some((output_text.to_string(), in_tok, out_tok));
        }
    }

    if let Some(output_arr) = v.get("output").and_then(Value::as_array) {
        let mut parts = Vec::new();
        for item in output_arr {
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for c in content {
                    if let Some(t) = c.get("text").and_then(Value::as_str) {
                        parts.push(t);
                    }
                }
            }
        }
        let joined = parts.join("\n");
        if !joined.trim().is_empty() {
            return Some((joined, in_tok, out_tok));
        }
    }

    // Standard OpenAI Chat Completions format
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)?;
    if content.trim().is_empty() {
        return None;
    }
    Some((content.to_string(), in_tok, out_tok))
}

/// Extracts a structured JSON object/array from markdown fences or raw LLM prose if present.
#[must_use]
pub fn extract_json_payload(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        if v.is_object() || v.is_array() {
            return Some(v);
        }
    }
    if let Some(start) = trimmed.find("```json") {
        let after = &trimmed[start + 7..];
        if let Some(end) = after.find("```") {
            if let Ok(v) = serde_json::from_str::<Value>(after[..end].trim()) {
                return Some(v);
            }
        }
    }
    if let Some(obj_start) = trimmed.find('{') {
        if let Some(obj_end) = trimmed.rfind('}') {
            if obj_end > obj_start {
                if let Ok(v) = serde_json::from_str::<Value>(&trimmed[obj_start..=obj_end]) {
                    return Some(v);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn real_llm_client_executes_openai_wire_call_against_mock_server() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let body = json!({
                    "id": "chatcmpl-fixture",
                    "choices": [{ "message": { "role": "assistant", "content": "Grounded answer [src_1:0]." } }],
                    "usage": { "prompt_tokens": 42, "completion_tokens": 11 }
                })
                .to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let cfg = NotebookLlmConfig {
            model_spec: "openai/gpt-fixture".to_string(),
            config_dir: None,
            api_base_override: Some(format!("http://{addr}/v1")),
            api_key_override: Some("sk-dummy-notebook-fixture-12345".to_string()),
            wire_api_override: Some("openai-completions".to_string()),
            effort: Some(EffortLevel::High),
            temperature: 0.2,
            max_tokens: 1024,
            allow_loopback_endpoints: true,
        };
        let res = complete_prompt(&cfg, "Be concise.", "Explain WAL leases.")
            .await
            .expect("llm complete");
        assert_eq!(res.text, "Grounded answer [src_1:0].");
        assert_eq!(res.input_tokens, 42);
        assert_eq!(res.output_tokens, 11);
        srv.abort();
    }
}
