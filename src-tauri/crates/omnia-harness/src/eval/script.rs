//! The scripted model: a [`Provider`] that replays [`ScriptTurn`]s.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::scenario::{RequestKind, ScriptTurn};
use crate::{
    Block, HarnessError, HarnessResult, Provider, ProviderRequest, ProviderStream, Role,
    StopReason, StreamEvent, Usage,
};

/// One request the harness made to the model.
#[derive(Debug, Clone)]
pub struct LoggedRequest {
    pub kind: RequestKind,
    pub request: ProviderRequest,
}

struct Slot {
    turn: ScriptTurn,
    remaining: u32,
}

#[derive(Default)]
struct State {
    slots: Vec<Slot>,
    log: Vec<LoggedRequest>,
    /// Requests no scripted turn matched.
    unmatched: Vec<String>,
}

/// Deterministic, offline model. Each request is classified (main agent,
/// compaction, subagent) and answered with the first unused scripted turn of
/// that kind whose conditions match.
#[derive(Clone)]
pub struct ScriptedProvider {
    state: Arc<Mutex<State>>,
}

pub const SUMMARY_REQUEST_PREFIX: &str = "Summarize this conversation so far";
const SUBAGENT_MARKER: &str = "# Subagent";

impl ScriptedProvider {
    pub fn new(script: &[ScriptTurn]) -> Self {
        let slots = script
            .iter()
            .map(|turn| Slot {
                remaining: turn.times.unwrap_or(1),
                turn: turn.clone(),
            })
            .collect();
        Self {
            state: Arc::new(Mutex::new(State {
                slots,
                ..State::default()
            })),
        }
    }

    pub fn requests(&self) -> Vec<LoggedRequest> {
        self.lock().log.clone()
    }

    pub fn unmatched(&self) -> Vec<String> {
        self.lock().unmatched.clone()
    }

    /// Scripted turns that were never served.
    pub fn unused(&self) -> usize {
        self.lock()
            .slots
            .iter()
            .filter(|slot| slot.remaining > 0)
            .count()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn classify(request: &ProviderRequest) -> RequestKind {
    let first_text = request
        .messages
        .first()
        .and_then(|message| {
            message.content.iter().find_map(|block| match block {
                Block::Text { text } => Some(text.as_str()),
                _ => None,
            })
        })
        .unwrap_or("");
    if request.tools.is_empty() && first_text.starts_with(SUMMARY_REQUEST_PREFIX) {
        RequestKind::Compaction
    } else if request
        .system
        .as_deref()
        .is_some_and(|system| system.contains(SUBAGENT_MARKER))
    {
        RequestKind::Subagent
    } else {
        RequestKind::Main
    }
}

/// Text of the most recent tool result in the request, if any.
fn last_result_text(request: &ProviderRequest) -> Option<String> {
    for message in request.messages.iter().rev() {
        if message.role != Role::User {
            continue;
        }
        let mut found = None;
        for block in &message.content {
            if let Block::ToolResult { content, .. } = block {
                let text = content
                    .iter()
                    .filter_map(|b| match b {
                        Block::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                found = Some(match found {
                    Some(previous) => format!("{previous}\n{text}"),
                    None => text,
                });
            }
        }
        if found.is_some() {
            return found;
        }
    }
    None
}

fn matches(turn: &ScriptTurn, kind: RequestKind, request: &ProviderRequest) -> bool {
    if turn.kind != kind {
        return false;
    }
    if let Some(model) = &turn.when_model {
        if *model != request.model {
            return false;
        }
    }
    if let Some(needle) = &turn.when_last_result_contains {
        match last_result_text(request) {
            Some(text) if text.contains(needle.as_str()) => {}
            _ => return false,
        }
    }
    true
}

fn events_for(turn: &ScriptTurn, serial: usize) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    if let Some(usage) = turn.usage {
        events.push(StreamEvent::Usage {
            usage: Usage {
                input_tokens: usage.input,
                output_tokens: usage.output,
                ..Usage::default()
            },
        });
    }
    if let Some(text) = &turn.say {
        events.push(StreamEvent::TextDelta { text: text.clone() });
    }
    for (index, call) in turn.tool_calls.iter().enumerate() {
        let id = call
            .id
            .clone()
            .unwrap_or_else(|| format!("call_{serial}_{index}"));
        let input = if call.input.is_null() {
            serde_json::json!({})
        } else {
            call.input.clone()
        };
        events.push(StreamEvent::ToolUseStart {
            id: id.clone(),
            name: call.name.clone(),
        });
        events.push(StreamEvent::ToolInputDelta {
            id: id.clone(),
            partial_json: input.to_string(),
        });
        events.push(StreamEvent::ToolUseEnd { id });
    }
    let reason = match turn.stop.as_deref() {
        Some("max_tokens") => StopReason::MaxTokens,
        Some("end_turn") => StopReason::EndTurn,
        Some("tool_use") => StopReason::ToolUse,
        _ if turn.tool_calls.is_empty() => StopReason::EndTurn,
        _ => StopReason::ToolUse,
    };
    events.push(StreamEvent::Stop { reason });
    events
}

#[async_trait]
impl Provider for ScriptedProvider {
    fn id(&self) -> &str {
        "scripted"
    }

    async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream> {
        let kind = classify(&request);
        let mut state = self.lock();
        let serial = state.log.len();
        state.log.push(LoggedRequest {
            kind,
            request: request.clone(),
        });
        let found = state
            .slots
            .iter()
            .position(|slot| slot.remaining > 0 && matches(&slot.turn, kind, &request));
        let Some(index) = found else {
            let note = format!(
                "request #{serial} ({kind:?}, model `{}`) matched no scripted turn",
                request.model
            );
            state.unmatched.push(note.clone());
            return Err(HarnessError::Protocol(format!(
                "eval script exhausted: {note}"
            )));
        };
        state.slots[index].remaining -= 1;
        let turn = state.slots[index].turn.clone();
        drop(state);
        if let Some(error) = &turn.error {
            return Err(HarnessError::Provider {
                status: Some(error.status),
                message: error.message.clone(),
                retryable: error.retryable,
            });
        }
        let events = events_for(&turn, serial);
        Ok(Box::pin(futures_util::stream::iter(
            events.into_iter().map(Ok),
        )))
    }
}
