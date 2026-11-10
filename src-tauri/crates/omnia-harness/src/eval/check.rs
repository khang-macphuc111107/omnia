//! Assertion evaluation: observed run -> list of human-readable failures.

use std::collections::HashMap;
use std::path::Path;

use super::runner::{final_text, Observed};
use super::scenario::{Expect, FileCheck, NameCheck, Range, RequestCheck, ResultCheck};
use super::script::LoggedRequest;
use crate::agent::AgentEvent;
use crate::{Block, Message};

/// Every event including those nested in subagent wrappers (wrapper first).
fn flatten(events: &[AgentEvent]) -> Vec<&AgentEvent> {
    let mut out = Vec::new();
    for event in events {
        out.push(event);
        if let AgentEvent::Subagent { event, .. } = event {
            out.extend(flatten(std::slice::from_ref(event.as_ref())));
        }
    }
    out
}

fn event_tag(event: &AgentEvent) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|t| t.as_str().map(str::to_owned))
        })
        .unwrap_or_default()
}

/// Tool call id -> tool name, from every assistant message seen.
fn tool_names(events: &[AgentEvent]) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for event in flatten(events) {
        if let AgentEvent::AssistantMessage { message } = event {
            for (id, name, _) in message.tool_uses() {
                names.insert(id.to_owned(), name.to_owned());
            }
        }
    }
    names
}

/// Names of the tool calls the model proposed, in order.
pub(crate) fn proposed_names(events: &[AgentEvent]) -> Vec<String> {
    let mut out = Vec::new();
    for event in flatten(events) {
        if let AgentEvent::AssistantMessage { message } = event {
            out.extend(message.tool_uses().map(|(_, name, _)| name.to_owned()));
        }
    }
    out
}

/// Names of the tools that started executing, in order.
pub(crate) fn executed_names(events: &[AgentEvent]) -> Vec<String> {
    let names = tool_names(events);
    flatten(events)
        .into_iter()
        .filter_map(|event| match event {
            AgentEvent::ToolStarted { id } => {
                Some(names.get(id).cloned().unwrap_or_else(|| format!("?{id}")))
            }
            _ => None,
        })
        .collect()
}

fn output_text(output: &crate::ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            Block::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct ToolResultView {
    tool: String,
    is_error: bool,
    text: String,
}

fn results(events: &[AgentEvent]) -> Vec<ToolResultView> {
    let names = tool_names(events);
    flatten(events)
        .into_iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCompleted { id, output } => Some(ToolResultView {
                tool: names.get(id).cloned().unwrap_or_default(),
                is_error: output.is_error,
                text: output_text(output),
            }),
            _ => None,
        })
        .collect()
}

fn result_matches(check: &ResultCheck, view: &ToolResultView) -> bool {
    check.tool.as_ref().is_none_or(|tool| *tool == view.tool)
        && check.is_error.is_none_or(|flag| flag == view.is_error)
        && check
            .contains
            .as_ref()
            .is_none_or(|needle| view.text.contains(needle.as_str()))
}

fn describe_result(check: &ResultCheck) -> String {
    format!(
        "tool={:?} is_error={:?} contains={:?}",
        check.tool, check.is_error, check.contains
    )
}

fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
}

pub(crate) fn check_files(checks: &[FileCheck], root: &Path, label: &str) -> Vec<String> {
    let mut failures = Vec::new();
    for check in checks {
        let path = root.join(&check.path);
        let exists = path.exists();
        if let Some(expected) = check.exists {
            if exists != expected {
                failures.push(format!(
                    "{label}: file `{}` exists={exists}, expected {expected}",
                    check.path
                ));
                continue;
            }
        }
        let needs_content =
            check.equals.is_some() || !check.contains.is_empty() || !check.not_contains.is_empty();
        if !needs_content {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => normalize(&content),
            Err(error) => {
                failures.push(format!("{label}: cannot read `{}`: {error}", check.path));
                continue;
            }
        };
        if let Some(expected) = &check.equals {
            if content != normalize(expected) {
                failures.push(format!(
                    "{label}: file `{}` is {content:?}, expected {:?}",
                    check.path,
                    normalize(expected)
                ));
            }
        }
        for needle in &check.contains {
            if !content.contains(needle.as_str()) {
                failures.push(format!(
                    "{label}: file `{}` does not contain {needle:?} (is {content:?})",
                    check.path
                ));
            }
        }
        for needle in &check.not_contains {
            if content.contains(needle.as_str()) {
                failures.push(format!(
                    "{label}: file `{}` unexpectedly contains {needle:?}",
                    check.path
                ));
            }
        }
    }
    failures
}

fn check_names(label: &str, check: &NameCheck, names: &[String], failures: &mut Vec<String>) {
    if let Some(exact) = &check.exact {
        if names != exact.as_slice() {
            failures.push(format!(
                "{label}: expected exactly {exact:?}, got {names:?}"
            ));
        }
    }
    if !check.ordered.is_empty() {
        let mut cursor = names.iter();
        let in_order = check
            .ordered
            .iter()
            .all(|wanted| cursor.any(|name| name == wanted));
        if !in_order {
            failures.push(format!(
                "{label}: expected order {:?} not found in {names:?}",
                check.ordered
            ));
        }
    }
    for name in &check.includes {
        if !names.contains(name) {
            failures.push(format!("{label}: expected `{name}` in {names:?}"));
        }
    }
    for name in &check.excludes {
        if names.contains(name) {
            failures.push(format!("{label}: `{name}` must not appear, got {names:?}"));
        }
    }
    if let Some(range) = &check.count {
        check_range(
            &format!("{label} count"),
            range,
            names.len() as u64,
            failures,
        );
    }
}

fn check_range(label: &str, range: &Range, value: u64, failures: &mut Vec<String>) {
    if !range.check(value) {
        failures.push(format!("{label}: {value}, expected {}", range.describe()));
    }
}

fn message_text(messages: &[Message]) -> String {
    let mut out = String::new();
    fn push(block: &Block, out: &mut String) {
        match block {
            Block::Text { text } | Block::Thinking { text, .. } => out.push_str(text),
            Block::ToolUse { name, input, .. } => out.push_str(&format!("{name} {input}")),
            Block::ToolResult { content, .. } => content.iter().for_each(|b| push(b, out)),
            Block::Image { .. } => out.push_str("[image]"),
        }
        out.push('\n');
    }
    for message in messages {
        message
            .content
            .iter()
            .for_each(|block| push(block, &mut out));
    }
    out
}

fn check_request(check: &RequestCheck, main: &[&LoggedRequest], failures: &mut Vec<String>) {
    let len = main.len() as i64;
    let index = if check.index < 0 {
        len + check.index
    } else {
        check.index
    };
    let Some(logged) = usize::try_from(index).ok().and_then(|i| main.get(i)) else {
        failures.push(format!(
            "request #{}: out of range ({} session requests)",
            check.index,
            main.len()
        ));
        return;
    };
    let system = logged.request.system.clone().unwrap_or_default();
    let messages = message_text(&logged.request.messages);
    for needle in &check.system_contains {
        if !system.contains(needle.as_str()) {
            failures.push(format!(
                "request #{}: system prompt lacks {needle:?}",
                check.index
            ));
        }
    }
    for needle in &check.system_not_contains {
        if system.contains(needle.as_str()) {
            failures.push(format!(
                "request #{}: system prompt unexpectedly has {needle:?}",
                check.index
            ));
        }
    }
    for needle in &check.messages_contain {
        if !messages.contains(needle.as_str()) {
            failures.push(format!(
                "request #{}: messages lack {needle:?}",
                check.index
            ));
        }
    }
}

pub(crate) fn check_expect(expect: &Expect, observed: &Observed) -> Vec<String> {
    let mut failures = Vec::new();

    match (&expect.run_error, &observed.run_error) {
        (None, Some(error)) => failures.push(format!("run failed unexpectedly: {error}")),
        (Some(wanted), None) => failures.push(format!(
            "expected run error containing {wanted:?}, but the run succeeded"
        )),
        (Some(wanted), Some(error)) if !error.contains(wanted.as_str()) => {
            failures.push(format!("run error {error:?} does not contain {wanted:?}"));
        }
        _ => {}
    }
    if let Some(stop) = &expect.stop {
        let actual = observed
            .last_stop
            .and_then(|reason| serde_json::to_value(reason).ok())
            .and_then(|value| value.as_str().map(str::to_owned));
        if actual.as_deref() != Some(stop.as_str()) {
            failures.push(format!("stop reason {actual:?}, expected {stop:?}"));
        }
    }
    if let Some(range) = &expect.turns {
        check_range("turns", range, u64::from(observed.turns), &mut failures);
    }
    if let Some(range) = &expect.tokens {
        let total = observed.tokens.input_tokens + observed.tokens.output_tokens;
        check_range("tokens", range, total, &mut failures);
    }
    if let Some(range) = &expect.history_len {
        check_range(
            "history_len",
            range,
            observed.history.len() as u64,
            &mut failures,
        );
    }
    let text = final_text(&observed.history);
    for needle in &expect.final_text_contains {
        if !text.contains(needle.as_str()) {
            failures.push(format!("final text {text:?} lacks {needle:?}"));
        }
    }
    failures.extend(check_files(&expect.files, &observed.workspace, "files"));
    if let Some(check) = &expect.proposed {
        check_names(
            "proposed",
            check,
            &proposed_names(&observed.events),
            &mut failures,
        );
    }
    if let Some(check) = &expect.executed {
        check_names(
            "executed",
            check,
            &executed_names(&observed.events),
            &mut failures,
        );
    }
    let views = results(&observed.events);
    for check in &expect.results {
        if !views.iter().any(|view| result_matches(check, view)) {
            let seen: Vec<String> = views
                .iter()
                .map(|view| {
                    format!(
                        "[{} error={}] {}",
                        view.tool,
                        view.is_error,
                        view.text.chars().take(160).collect::<String>()
                    )
                })
                .collect();
            failures.push(format!(
                "no tool result matches ({}); results were {seen:?}",
                describe_result(check)
            ));
        }
    }
    for check in &expect.no_results {
        if let Some(view) = views.iter().find(|view| result_matches(check, view)) {
            failures.push(format!(
                "a tool result unexpectedly matches ({}): [{}] {}",
                describe_result(check),
                view.tool,
                view.text.chars().take(160).collect::<String>()
            ));
        }
    }
    if !expect.events.is_empty() {
        let mut counts: HashMap<String, u64> = HashMap::new();
        for event in flatten(&observed.events) {
            *counts.entry(event_tag(event)).or_default() += 1;
        }
        for (tag, range) in &expect.events {
            let count = counts.get(tag).copied().unwrap_or(0);
            check_range(&format!("event `{tag}`"), range, count, &mut failures);
        }
    }
    let main: Vec<&LoggedRequest> = observed
        .requests
        .iter()
        .filter(|logged| logged.kind == super::scenario::RequestKind::Main)
        .collect();
    if let Some(models) = &expect.models_requested {
        let actual: Vec<&str> = main
            .iter()
            .map(|logged| logged.request.model.as_str())
            .collect();
        if actual != models.iter().map(String::as_str).collect::<Vec<_>>() {
            failures.push(format!("models requested {actual:?}, expected {models:?}"));
        }
    }
    for check in &expect.requests {
        check_request(check, &main, &mut failures);
    }
    failures
}
