//! Context compaction: summarize older history into a single message.

use futures_util::StreamExt;

use crate::{
    Block, HarnessError, HarnessResult, Message, Provider, ProviderRequest, Role, StreamEvent,
};

const IMAGE_TOKENS: usize = 1500;
const SUMMARY_PREFIX: &str = "<summary of earlier conversation>\n";
const ACK: &str = "Understood — continuing from the summary.";
const SUMMARY_SYSTEM: &str = "You compress a coding-agent conversation into a dense continuation \
summary so work can resume with no other context. Include: the user's goals and constraints, \
decisions made and why, files created/modified/inspected (with paths), the current state of the \
work, open todos and next steps, and any important code snippets, commands, identifiers or error \
messages verbatim. Be factual and concise. Output only the summary text.";

fn block_chars(block: &Block) -> usize {
    match block {
        Block::Text { text } | Block::Thinking { text, .. } => text.len(),
        Block::Image { .. } => IMAGE_TOKENS * 4,
        Block::ToolUse { name, input, .. } => name.len() + input.to_string().len(),
        Block::ToolResult { content, .. } => content.iter().map(block_chars).sum(),
    }
}

/// Rough token estimate (chars / 4; images ~1500 tokens).
pub fn estimate_tokens(messages: &[Message]) -> usize {
    let chars: usize = messages
        .iter()
        .flat_map(|message| message.content.iter())
        .map(block_chars)
        .sum();
    chars.div_ceil(4)
}

pub fn should_compact(last_input_tokens: u64, context_window: u64, threshold: f32) -> bool {
    let threshold = (f64::from(threshold) * 1e6).round() / 1e6;
    context_window > 0 && (last_input_tokens as f64) >= (context_window as f64) * threshold
}

pub fn context_window_for(model: &str) -> u64 {
    let id = model.to_ascii_lowercase();
    if id.contains("1m") {
        1_000_000
    } else if id.contains("claude") {
        200_000
    } else if id.contains("gemini") {
        1_000_000
    } else if id.contains("gpt-5") {
        400_000
    } else if id.starts_with("o3")
        || id.starts_with("o4")
        || id.contains("/o3")
        || id.contains("/o4")
    {
        200_000
    } else {
        // Includes deepseek (128k) and unknown models.
        128_000
    }
}

fn has_tool_results(message: &Message) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, Block::ToolResult { .. }))
}

/// Rewind to a whole user turn, never leaving tool results without their calls.
/// This also handles a steer message mixed with the final results of a batch.
/// Use the returned prefix length for transcript truncation, not a raw UI index.
pub fn rewind_boundary(history: &[Message], desired: usize) -> usize {
    let desired = desired.min(history.len());
    if desired == history.len() {
        return desired;
    }
    (0..=desired)
        .rev()
        .find(|&i| history[i].role == Role::User && !has_tool_results(&history[i]))
        .unwrap_or(0)
}

/// Largest index `<= desired` at which history may be split: `history[i]` is a
/// user message that is not purely tool results (so no tool_use/tool_result
/// pair is separated). Returns 0 if none exists (nothing to compact).
fn split_point(history: &[Message], desired: usize) -> usize {
    if history.is_empty() {
        return 0;
    }
    rewind_boundary(history, desired.min(history.len() - 1))
}

fn render_for_summary(messages: &[Message]) -> String {
    fn render_block(block: &Block, out: &mut String) {
        match block {
            Block::Text { text } => out.push_str(text),
            Block::Image { .. } => out.push_str("[image]"),
            Block::Thinking { .. } => {}
            Block::ToolUse { name, input, .. } => {
                out.push_str(&format!("[tool call {name}: {input}]"))
            }
            Block::ToolResult {
                content, is_error, ..
            } => {
                out.push_str(if *is_error {
                    "[tool error: "
                } else {
                    "[tool result: "
                });
                for inner in content {
                    render_block(inner, out);
                }
                out.push(']');
            }
        }
        out.push('\n');
    }
    let mut out = String::new();
    for message in messages {
        out.push_str(match message.role {
            Role::User => "## User\n",
            Role::Assistant => "## Assistant\n",
        });
        for block in &message.content {
            render_block(block, &mut out);
        }
        out.push('\n');
    }
    out
}

/// Summarizes everything before the last `keep_recent` messages (adjusted so a
/// tool_use is never separated from its tool_result). Returns `history`
/// unchanged when there is nothing to compact.
pub async fn compact(
    provider: &dyn Provider,
    model: &str,
    history: &[Message],
    keep_recent: usize,
) -> HarnessResult<Vec<Message>> {
    Ok(compact_with_metadata(provider, model, history, keep_recent)
        .await?
        .messages)
}

pub struct CompactedHistory {
    pub messages: Vec<Message>,
    /// Exact original split, before inserting summary and acknowledgement.
    pub split: usize,
}

pub async fn compact_with_metadata(
    provider: &dyn Provider,
    model: &str,
    history: &[Message],
    keep_recent: usize,
) -> HarnessResult<CompactedHistory> {
    compact_observed(provider, model, history, keep_recent, || Ok(()), |_| {}).await
}

/// Observe additive usage at ingestion, including usage before a later failure.
/// Admission runs only when a summary request will actually be sent.
pub(crate) async fn compact_observed(
    provider: &dyn Provider,
    model: &str,
    history: &[Message],
    keep_recent: usize,
    admit: impl FnOnce() -> HarnessResult<()>,
    mut usage_observed: impl FnMut(&crate::Usage),
) -> HarnessResult<CompactedHistory> {
    let desired = history.len().saturating_sub(keep_recent);
    let split = split_point(history, desired);
    if split == 0 {
        return Ok(CompactedHistory {
            messages: history.to_vec(),
            split: 0,
        });
    }
    let (older, recent) = history.split_at(split);

    let request = ProviderRequest {
        model: model.to_owned(),
        system: Some(SUMMARY_SYSTEM.to_owned()),
        messages: vec![Message::user(format!(
            "Summarize this conversation so far:\n\n{}",
            render_for_summary(older)
        ))],
        tools: Vec::new(),
        max_tokens: Some(4096),
        temperature: Some(0.0),
        reasoning_effort: None,
    };
    admit()?;
    let mut stream = provider.stream(request).await?;
    let mut summary = String::new();
    while let Some(event) = stream.next().await {
        match event? {
            StreamEvent::TextDelta { text } => summary.push_str(&text),
            StreamEvent::Usage { usage } => usage_observed(&usage),
            _ => {}
        }
    }
    let summary = summary.trim();
    if summary.is_empty() {
        return Err(HarnessError::Protocol(
            "compaction produced an empty summary".to_owned(),
        ));
    }

    // `recent` starts with a user message, so: User(summary), Assistant(ack),
    // then recent keeps roles alternating.
    let mut out = Vec::with_capacity(recent.len() + 2);
    out.push(Message::user(format!("{SUMMARY_PREFIX}{summary}")));
    out.push(Message::assistant(vec![Block::text(ACK)]));
    out.extend_from_slice(recent);
    Ok(CompactedHistory {
        messages: out,
        split,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderStream;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;

    struct Fake {
        reply: String,
        requests: Mutex<Vec<ProviderRequest>>,
    }

    impl Fake {
        fn new(reply: &str) -> Self {
            Self {
                reply: reply.to_owned(),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl Provider for Fake {
        fn id(&self) -> &str {
            "fake"
        }
        async fn stream(&self, request: ProviderRequest) -> HarnessResult<ProviderStream> {
            self.requests.lock().unwrap().push(request);
            let events = vec![
                Ok(StreamEvent::TextDelta {
                    text: self.reply.clone(),
                }),
                Ok(StreamEvent::Stop {
                    reason: crate::StopReason::EndTurn,
                }),
            ];
            Ok(Box::pin(futures_util::stream::iter(events)))
        }
    }

    fn assistant_text(text: &str) -> Message {
        Message::assistant(vec![Block::text(text)])
    }

    fn tool_call(id: &str) -> Message {
        Message::assistant(vec![Block::ToolUse {
            id: id.to_owned(),
            name: "read".to_owned(),
            input: json!({}),
        }])
    }

    fn tool_result(id: &str) -> Message {
        Message {
            role: Role::User,
            content: vec![Block::ToolResult {
                tool_use_id: id.to_owned(),
                content: vec![Block::text("ok")],
                is_error: false,
            }],
        }
    }

    fn alternates(messages: &[Message]) -> bool {
        messages.first().is_some_and(|m| m.role == Role::User)
            && messages.windows(2).all(|w| w[0].role != w[1].role)
    }

    #[test]
    fn estimates_and_thresholds() {
        let messages = vec![
            Message::user("a".repeat(400)),
            Message {
                role: Role::User,
                content: vec![Block::Image {
                    media_type: "image/png".into(),
                    data: "x".repeat(100_000),
                }],
            },
        ];
        assert_eq!(estimate_tokens(&messages), 100 + 1500);
        assert!(should_compact(80_000, 100_000, 0.8));
        assert!(!should_compact(79_999, 100_000, 0.8));
        assert_eq!(context_window_for("claude-sonnet-4"), 200_000);
        assert_eq!(context_window_for("claude-opus-4[1m]"), 1_000_000);
        assert_eq!(context_window_for("gemini-2.5-pro"), 1_000_000);
        assert_eq!(context_window_for("gpt-5.1"), 400_000);
        assert_eq!(context_window_for("o3-mini"), 200_000);
        assert_eq!(context_window_for("deepseek-chat"), 128_000);
        assert_eq!(context_window_for("mystery"), 128_000);
    }

    #[tokio::test]
    async fn noop_when_nothing_to_compact() {
        let provider = Fake::new("s");
        let history = vec![Message::user("hi"), assistant_text("yo")];
        let out = compact(&provider, "m", &history, 10).await.unwrap();
        assert_eq!(out, history);
        assert!(provider.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn split_never_separates_tool_pair() {
        let provider = Fake::new("SUMMARY");
        let history = vec![
            Message::user("task one"),
            assistant_text("ok"),
            Message::user("task two"),
            tool_call("t1"),
            tool_result("t1"),
            tool_call("t2"),
            tool_result("t2"),
            assistant_text("done"),
        ];
        // keep_recent=2 would split at index 6 (a tool_result); must move back to 2.
        let out = compact(&provider, "m", &history, 2).await.unwrap();
        assert!(alternates(&out));
        assert_eq!(out.len(), 2 + history.len() - 2);
        assert_eq!(&out[2..], &history[2..]);
        let Block::Text { text } = &out[0].content[0] else {
            panic!()
        };
        assert!(text.starts_with(SUMMARY_PREFIX));
        assert!(text.contains("SUMMARY"));
        // The summarizer saw only the older part and no tools.
        let requests = provider.requests.lock().unwrap();
        assert!(requests[0].tools.is_empty());
        assert!(!render_for_summary(&history[..2]).contains("task two"));
    }

    #[tokio::test]
    async fn no_safe_split_is_noop() {
        let provider = Fake::new("S");
        let history = vec![
            Message::user("only user msg"),
            tool_call("a"),
            tool_result("a"),
            assistant_text("end"),
        ];
        let out = compact(&provider, "m", &history, 1).await.unwrap();
        assert_eq!(out, history);
    }
}
