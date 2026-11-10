//! Run-bound, journal-before-delivery user questions.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::{
    CancellationToken, EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput,
    ToolSpec,
};

pub const MAX_PROMPT_BYTES: usize = 8_192;
const MAX_OPTION_BYTES: usize = 1_024;
const MAX_ANSWER_BYTES: usize = 32_768;
const MAX_OPTIONS: usize = 8;
const MAX_PENDING: usize = 16;

/// Durable event sink supplied by the native bridge. The callback must commit
/// before returning; the broker only delivers an actionable request or answer
/// after this callback succeeds.
pub type QuestionJournal = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionInput {
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub recommended: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub id: String,
    pub run_id: String,
    pub tool_use_id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub recommended: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionReceipt {
    pub request_id: String,
    pub run_id: String,
    pub status: &'static str,
}

#[derive(Debug, thiserror::Error)]
pub enum QuestionError {
    #[error("Invalid question input: {0}")]
    Invalid(&'static str),
    #[error("That question is no longer pending")]
    NotPending,
    #[error("That question belongs to a different run")]
    WrongRun,
    #[error("The run no longer accepts user input")]
    Closed,
    #[error("The user-input journal could not be committed: {0}")]
    Journal(String),
}

struct Pending {
    question: PendingQuestion,
    sender: oneshot::Sender<Option<String>>,
}

#[derive(Default)]
struct BrokerState {
    pending: BTreeMap<String, Pending>,
    closed: bool,
}

/// One broker belongs to exactly one active session/run. A restored journal is
/// evidence, not an authority to recreate a sender after process restart.
pub struct QuestionBroker {
    session_id: String,
    run_id: String,
    cancel: CancellationToken,
    state: Mutex<BrokerState>,
    journal: QuestionJournal,
}

fn valid_text(value: &str, max_bytes: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= max_bytes
        && !value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\t' | '\r')))
}

impl QuestionInput {
    fn validate(&mut self) -> Result<(), QuestionError> {
        if !valid_text(&self.prompt, MAX_PROMPT_BYTES, true) {
            return Err(QuestionError::Invalid(
                "prompt must be nonempty, plain text and at most 8192 bytes",
            ));
        }
        self.prompt = self.prompt.trim().to_owned();
        if self.options.len() > MAX_OPTIONS || self.recommended.len() > MAX_OPTIONS {
            return Err(QuestionError::Invalid(
                "at most eight options are supported",
            ));
        }
        for option in &mut self.options {
            if !valid_text(option, MAX_OPTION_BYTES, false) {
                return Err(QuestionError::Invalid(
                    "options must be nonempty single-line text of at most 1024 bytes",
                ));
            }
            *option = option.trim().to_owned();
        }
        let options: BTreeSet<_> = self.options.iter().cloned().collect();
        if options.len() != self.options.len() {
            return Err(QuestionError::Invalid("option labels must be unique"));
        }
        let mut seen = BTreeSet::new();
        for option in &mut self.recommended {
            *option = option.trim().to_owned();
            if !options.contains(option.as_str()) || !seen.insert(option.clone()) {
                return Err(QuestionError::Invalid(
                    "recommended labels must name distinct options",
                ));
            }
        }
        Ok(())
    }
}

impl QuestionBroker {
    pub fn new(
        session_id: String,
        run_id: String,
        cancel: CancellationToken,
        journal: QuestionJournal,
    ) -> Self {
        Self {
            session_id,
            run_id,
            cancel,
            state: Mutex::new(BrokerState::default()),
            journal,
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn pending(&self) -> Vec<PendingQuestion> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || self.cancel.is_cancelled() {
            return Vec::new();
        }
        state
            .pending
            .values()
            .map(|item| item.question.clone())
            .collect()
    }

    pub fn begin(
        &self,
        tool_use_id: &str,
        mut input: QuestionInput,
    ) -> Result<(PendingQuestion, oneshot::Receiver<Option<String>>), QuestionError> {
        input.validate()?;
        if !valid_text(tool_use_id, 256, false) {
            return Err(QuestionError::Invalid(
                "tool call identity is missing or invalid",
            ));
        }
        let question = PendingQuestion {
            id: format!("question_{}", uuid::Uuid::new_v4().simple()),
            run_id: self.run_id.clone(),
            tool_use_id: tool_use_id.to_owned(),
            prompt: input.prompt,
            options: input.options,
            recommended: input.recommended,
        };
        let (sender, receiver) = oneshot::channel();
        // Keep the sender installed while holding the state lock through the
        // durable request write. This preserves the sender-before-publication
        // invariant without allowing interrupt/answer to journal a terminal
        // event ahead of the request event.
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || self.cancel.is_cancelled() {
            return Err(QuestionError::Closed);
        }
        if state.pending.len() >= MAX_PENDING {
            return Err(QuestionError::Invalid(
                "too many unanswered questions; wait for the existing requests",
            ));
        }
        state.pending.insert(
            question.id.clone(),
            Pending {
                question: question.clone(),
                sender,
            },
        );
        // Native journal callback must commit before delivering to the UI.
        let event = json!({"type":"ask_user", "id":question.id, "requestId":question.id,
            "runId":question.run_id, "toolUseId":question.tool_use_id, "prompt":question.prompt,
            "options":question.options, "recommended":question.recommended});
        if let Err(error) = (self.journal)(event) {
            state.pending.remove(&question.id);
            self.cancel.cancel();
            return Err(QuestionError::Journal(error));
        }
        Ok((question, receiver))
    }

    pub fn answer(
        &self,
        request_id: &str,
        run_id: Option<&str>,
        answer: Option<String>,
    ) -> Result<QuestionReceipt, QuestionError> {
        if run_id.is_some_and(|id| id != self.run_id) {
            return Err(QuestionError::WrongRun);
        }
        let answer = match answer {
            Some(answer) if valid_text(&answer, MAX_ANSWER_BYTES, true) => {
                Some(answer.trim().to_owned())
            }
            Some(_) => {
                return Err(QuestionError::Invalid(
                    "answer must be nonempty plain text of at most 32768 bytes",
                ))
            }
            None => None,
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || self.cancel.is_cancelled() {
            return Err(QuestionError::Closed);
        }
        let item = state
            .pending
            .get(request_id)
            .ok_or(QuestionError::NotPending)?;
        if item.sender.is_closed() {
            return Err(QuestionError::NotPending);
        }
        let status = if answer.is_some() {
            "answered"
        } else {
            "cancelled"
        };
        (self.journal)(
            json!({"type":"ask_user_resolved", "id":request_id, "requestId":request_id,
            "runId":self.run_id, "status":status, "answer":answer, "reason":"user_response"}),
        )
        .map_err(QuestionError::Journal)?;
        let item = state
            .pending
            .remove(request_id)
            .ok_or(QuestionError::NotPending)?;
        // The journal commit is the acknowledgement boundary. The waiting
        // tool may be dropped concurrently after that commit; returning an
        // error would contradict the durable `answered` receipt and invite a
        // duplicate user submission. A dropped receiver simply means the
        // model no longer consumes this already-recorded answer.
        let _ = item.sender.send(answer);
        Ok(QuestionReceipt {
            request_id: request_id.to_owned(),
            run_id: self.run_id.clone(),
            status,
        })
    }

    fn cancel_pending(&self, request_id: &str, reason: &str) -> Result<(), QuestionError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(item) = state.pending.remove(request_id) else {
            return Ok(());
        };
        let recorded = (self.journal)(
            json!({"type":"ask_user_resolved", "id":request_id, "requestId":request_id,
            "runId":self.run_id, "status":"cancelled", "answer":Value::Null, "reason":reason}),
        );
        let _ = item.sender.send(None);
        if recorded.is_err() {
            self.cancel.cancel();
        }
        recorded.map_err(QuestionError::Journal)
    }

    pub fn close(&self, reason: &str) -> Result<(), QuestionError> {
        let pending = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            std::mem::take(&mut state.pending)
        };
        let mut error = None;
        for (id, item) in pending {
            if let Err(message) =
                (self.journal)(json!({"type":"ask_user_resolved", "id":id, "requestId":id,
                "runId":self.run_id, "status":"cancelled", "answer":Value::Null, "reason":reason}))
            {
                self.cancel.cancel();
                error = Some(QuestionError::Journal(message));
            }
            let _ = item.sender.send(None);
        }
        error.map_or(Ok(()), Err)
    }
}

struct QuestionLease {
    broker: Arc<QuestionBroker>,
    id: String,
}
impl Drop for QuestionLease {
    fn drop(&mut self) {
        let _ = self.broker.cancel_pending(&self.id, "request_abandoned");
    }
}

pub struct AskUserTool {
    broker: Arc<QuestionBroker>,
}
impl AskUserTool {
    pub fn new(broker: Arc<QuestionBroker>) -> Self {
        Self { broker }
    }
}

#[async_trait]
impl Tool for AskUserTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "ask_user".into(),
            description: "Ask the user for a missing decision. Supply up to eight concise options in priority order and recommended labels; free text and explicit cancellation are always supported. Wait for the answer. A cancelled answer does not authorize an action or automatic re-asking.".into(),
            input_schema: json!({"type":"object", "properties":{
                "prompt":{"type":"string","minLength":1,"maxLength":8192},
                "options":{"type":"array","maxItems":8,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":1024}},
                "recommended":{"type":"array","maxItems":8,"uniqueItems":true,"items":{"type":"string"}}
            },"required":["prompt"],"additionalProperties":false}),
        }
    }
    fn effect(&self) -> EffectClass {
        EffectClass::PureCompute
    }
    fn describe(&self, _: &Value) -> String {
        "Request a user decision".into()
    }
    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        if ctx.cancel.is_cancelled() {
            return Err(HarnessError::Cancelled);
        }
        if ctx.session_id != self.broker.session_id {
            return Ok(ToolOutput::error(
                "Question broker does not belong to this session",
            ));
        }
        let input = match serde_json::from_value::<QuestionInput>(input) {
            Ok(input) => input,
            Err(_) => return Ok(ToolOutput::error("ask_user requires prompt and optional options/recommended arrays; no other fields are accepted")),
        };
        let (question, receiver) = match self.broker.begin(&ctx.tool_use_id, input) {
            Ok(pending) => pending,
            Err(QuestionError::Closed) => return Err(HarnessError::Cancelled),
            Err(error @ QuestionError::Journal(_)) => {
                return Err(HarnessError::tool("ask_user", error.to_string()))
            }
            Err(error) => return Ok(ToolOutput::error(error.to_string())),
        };
        let _lease = QuestionLease {
            broker: Arc::clone(&self.broker),
            id: question.id.clone(),
        };
        let answer = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(HarnessError::Cancelled),
            answer = receiver => answer.map_err(|_| HarnessError::Cancelled)?,
        };
        Ok(ToolOutput::text(
            json!({"requestId":question.id, "runId":question.run_id,
            "status":if answer.is_some() { "answered" } else { "cancelled" }, "answer":answer})
            .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests;
