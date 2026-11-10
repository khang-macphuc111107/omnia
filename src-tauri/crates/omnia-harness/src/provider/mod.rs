//! Provider adapters. Each adapter turns a [`ProviderRequest`] into an HTTP
//! streaming call and yields normalized [`StreamEvent`]s.

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};

use crate::{HarnessResult, Message, StreamEvent, ToolSpec};

pub mod destination;
pub mod factory;
pub mod record;
pub mod sse;
// Adapters (implemented in H1):
pub mod anthropic;
pub mod gemini;
pub mod openai_chat;
pub mod openai_responses;

pub type ProviderStream = Pin<Box<dyn Stream<Item = HarnessResult<StreamEvent>> + Send>>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProviderRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// "low" | "medium" | "high" | "max"; adapters map it to their own knob.
    pub reasoning_effort: Option<String>,
}

/// Connection settings for one provider endpoint. Credentials are resolved by
/// the host (desktop keyring) before the adapter is built.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    /// Use `Authorization: Bearer` instead of the provider's key header.
    #[serde(default)]
    pub bearer_auth: bool,
    #[serde(default)]
    pub extra_headers: Vec<(String, String)>,
}

#[async_trait]
pub trait Provider: Send + Sync {
    /// Stable id such as `anthropic`, `openai_responses`, `openai_chat`, `gemini`.
    fn id(&self) -> &str;
    async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream>;
}
