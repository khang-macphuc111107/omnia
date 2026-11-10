//! Provider-neutral conversation model. Every provider adapter converts these
//! types to and from its wire format, so switching model mid-session keeps the
//! same history.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    Image {
        media_type: String,
        /// Base64 payload.
        data: String,
    },
    Thinking {
        text: String,
        /// Provider signature that must be echoed back (Anthropic).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: Vec<Block>,
        #[serde(default)]
        is_error: bool,
    },
}

impl Block {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Block>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: vec![Block::text(text)],
        }
    }

    pub fn assistant(content: Vec<Block>) -> Self {
        Self {
            role: Role::Assistant,
            content,
        }
    }

    pub fn tool_uses(&self) -> impl Iterator<Item = (&str, &str, &Value)> {
        self.content.iter().filter_map(|block| match block {
            Block::ToolUse { id, name, input } => Some((id.as_str(), name.as_str(), input)),
            _ => None,
        })
    }
}

/// A tool as advertised to the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the input object.
    pub input_schema: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    StopSequence,
    Refusal,
    /// The harness exhausted its configured turn budget, not a model stop.
    TurnLimit,
    Other,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(other.cache_write_tokens);
    }
}

/// Normalized streaming event emitted by every provider adapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ThinkingSignature {
        signature: String,
    },
    ToolUseStart {
        id: String,
        name: String,
    },
    /// Partial JSON for the tool input; concatenate per id.
    ToolInputDelta {
        id: String,
        partial_json: String,
    },
    ToolUseEnd {
        id: String,
    },
    Usage {
        usage: Usage,
    },
    Stop {
        reason: StopReason,
    },
}

/// Folds a stream of events into the final assistant message.
#[derive(Debug, Default)]
pub struct MessageAccumulator {
    blocks: Vec<Block>,
    pending_tools: Vec<(String, String, String)>,
    pub usage: Usage,
    pub stop: Option<StopReason>,
}

impl MessageAccumulator {
    pub fn push(&mut self, event: &StreamEvent) -> crate::HarnessResult<()> {
        match event {
            StreamEvent::TextDelta { text } => match self.blocks.last_mut() {
                Some(Block::Text { text: existing }) => existing.push_str(text),
                _ => self.blocks.push(Block::text(text.clone())),
            },
            StreamEvent::ThinkingDelta { text } => match self.blocks.last_mut() {
                Some(Block::Thinking { text: existing, .. }) => existing.push_str(text),
                _ => self.blocks.push(Block::Thinking {
                    text: text.clone(),
                    signature: None,
                }),
            },
            StreamEvent::ThinkingSignature { signature } => {
                if let Some(Block::Thinking {
                    signature: slot, ..
                }) = self
                    .blocks
                    .iter_mut()
                    .rev()
                    .find(|block| matches!(block, Block::Thinking { .. }))
                {
                    *slot = Some(signature.clone());
                }
            }
            StreamEvent::ToolUseStart { id, name } => {
                // Deltas and ends are routed by id, so a repeated id would be
                // ambiguous; a completed duplicate would also make the later
                // tool result ambiguous. Reject rather than misassociate.
                let pending = self.pending_tools.iter().any(|entry| &entry.0 == id);
                let completed = self.blocks.iter().any(
                    |block| matches!(block, Block::ToolUse { id: existing, .. } if existing == id),
                );
                if pending || completed {
                    return Err(crate::HarnessError::Protocol(format!(
                        "duplicate tool call id `{id}` in one assistant message"
                    )));
                }
                self.pending_tools
                    .push((id.clone(), name.clone(), String::new()));
            }
            StreamEvent::ToolInputDelta { id, partial_json } => {
                if let Some(entry) = self.pending_tools.iter_mut().find(|entry| &entry.0 == id) {
                    entry.2.push_str(partial_json);
                }
            }
            StreamEvent::ToolUseEnd { id } => {
                if let Some(index) = self.pending_tools.iter().position(|entry| &entry.0 == id) {
                    let (id, name, json) = self.pending_tools.remove(index);
                    let input = if json.trim().is_empty() {
                        Value::Object(Default::default())
                    } else {
                        serde_json::from_str(&json).map_err(|error| {
                            crate::HarnessError::Protocol(format!(
                                "tool `{name}` input is not valid JSON: {error}"
                            ))
                        })?
                    };
                    self.blocks.push(Block::ToolUse { id, name, input });
                }
            }
            StreamEvent::Usage { usage } => self.usage.add(usage),
            StreamEvent::Stop { reason } => self.stop = Some(*reason),
        }
        Ok(())
    }

    pub fn finish(self) -> (Message, Usage, StopReason) {
        let stop = self.stop.unwrap_or(StopReason::Other);
        (Message::assistant(self.blocks), self.usage, stop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HarnessError, HarnessResult};
    use serde_json::json;

    #[test]
    fn usage_accumulation_saturates_all_counters() {
        let mut usage = Usage {
            input_tokens: u64::MAX - 1,
            output_tokens: u64::MAX - 1,
            cache_read_tokens: u64::MAX - 1,
            cache_write_tokens: u64::MAX - 1,
        };
        usage.add(&Usage {
            input_tokens: 3,
            output_tokens: 3,
            cache_read_tokens: 3,
            cache_write_tokens: 3,
        });
        assert_eq!(
            usage,
            Usage {
                input_tokens: u64::MAX,
                output_tokens: u64::MAX,
                cache_read_tokens: u64::MAX,
                cache_write_tokens: u64::MAX
            }
        );
    }

    fn start(id: &str, name: &str) -> StreamEvent {
        StreamEvent::ToolUseStart {
            id: id.into(),
            name: name.into(),
        }
    }

    fn delta(id: &str, partial_json: &str) -> StreamEvent {
        StreamEvent::ToolInputDelta {
            id: id.into(),
            partial_json: partial_json.into(),
        }
    }

    fn end(id: &str) -> StreamEvent {
        StreamEvent::ToolUseEnd { id: id.into() }
    }

    fn feed(events: &[StreamEvent]) -> HarnessResult<MessageAccumulator> {
        let mut acc = MessageAccumulator::default();
        for event in events {
            acc.push(event)?;
        }
        Ok(acc)
    }

    fn assert_duplicate_rejected(result: HarnessResult<MessageAccumulator>, id: &str) {
        match result {
            Err(HarnessError::Protocol(message)) => {
                assert!(message.contains("duplicate tool call id"), "{message}");
                assert!(message.contains(id), "{message}");
            }
            other => panic!("expected duplicate-id protocol error, got {other:?}"),
        }
    }

    #[test]
    fn interleaved_unique_ids_route_deltas_by_id() {
        let acc = feed(&[
            start("a", "read"),
            start("b", "write"),
            delta("b", r#"{"path":"#),
            delta("a", r#"{"path":"x"}"#),
            delta("b", r#""y"}"#),
            end("b"),
            end("a"),
            StreamEvent::Stop {
                reason: StopReason::ToolUse,
            },
        ])
        .expect("unique ids accumulate");
        let (message, _, stop) = acc.finish();
        assert_eq!(stop, StopReason::ToolUse);
        let calls: Vec<_> = message.tool_uses().collect();
        assert_eq!(
            calls,
            vec![
                ("b", "write", &json!({"path": "y"})),
                ("a", "read", &json!({"path": "x"})),
            ]
        );
    }

    #[test]
    fn empty_input_becomes_empty_object() {
        let acc = feed(&[start("a", "list"), end("a")]).unwrap();
        let (message, _, _) = acc.finish();
        assert_eq!(
            message.tool_uses().collect::<Vec<_>>(),
            vec![("a", "list", &json!({}))]
        );
    }

    #[test]
    fn duplicate_id_while_first_is_pending_is_rejected() {
        assert_duplicate_rejected(
            feed(&[
                start("dup", "read"),
                delta("dup", "{}"),
                start("dup", "write"),
            ]),
            "dup",
        );
    }

    #[test]
    fn duplicate_id_after_first_completed_is_rejected() {
        assert_duplicate_rejected(
            feed(&[
                start("dup", "read"),
                delta("dup", r#"{"path":"x"}"#),
                end("dup"),
                start("dup", "write"),
            ]),
            "dup",
        );
    }

    #[test]
    fn duplicate_rejection_does_not_corrupt_first_call() {
        let mut acc = MessageAccumulator::default();
        acc.push(&start("dup", "read")).unwrap();
        acc.push(&delta("dup", r#"{"path":"x"}"#)).unwrap();
        assert!(acc.push(&start("dup", "write")).is_err());
        assert_eq!(acc.pending_tools.len(), 1);
        acc.push(&end("dup")).unwrap();
        let (message, _, _) = acc.finish();
        assert_eq!(
            message.tool_uses().collect::<Vec<_>>(),
            vec![("dup", "read", &json!({"path": "x"}))]
        );
    }

    #[test]
    fn invalid_tool_json_is_protocol_error() {
        let result = feed(&[start("a", "read"), delta("a", "{not json"), end("a")]);
        assert!(matches!(result, Err(HarnessError::Protocol(_))));
    }
}
