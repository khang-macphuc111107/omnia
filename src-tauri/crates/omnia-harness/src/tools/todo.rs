//! todo_write: per-session task list kept in memory.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

fn store() -> &'static Mutex<HashMap<String, Vec<TodoItem>>> {
    static STORE: OnceLock<Mutex<HashMap<String, Vec<TodoItem>>>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

/// Current task list of a session (empty if none).
pub fn todos_for(session_id: &str) -> Vec<TodoItem> {
    store()
        .lock()
        .map(|map| map.get(session_id).cloned().unwrap_or_default())
        .unwrap_or_default()
}

fn render(items: &[TodoItem]) -> String {
    if items.is_empty() {
        return "Todo list is empty.".into();
    }
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mark = match item.status {
                TodoStatus::Pending => "[ ]",
                TodoStatus::InProgress => "[~]",
                TodoStatus::Completed => "[x]",
            };
            format!("{}. {mark} {}", i + 1, item.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub struct TodoWriteTool;

#[derive(Deserialize)]
struct TodoArgs {
    todos: Vec<TodoItem>,
}

#[async_trait]
impl Tool for TodoWriteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "todo_write".into(),
            description: "Create and update the task list for the current session. Use it for \
multi-step work (3+ steps): write the full list, keep exactly one item `in_progress`, and mark items \
`completed` as soon as they are done. Each call replaces the entire list. Skip it for trivial requests."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "The complete, ordered task list.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string", "description": "Imperative description of the task."},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                            },
                            "required": ["content", "status"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["todos"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::PureCompute
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Update todo list ({} items)",
            input["todos"].as_array().map_or(0, Vec::len)
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: TodoArgs = parse_input(input)?;
            let in_progress = args
                .todos
                .iter()
                .filter(|t| t.status == TodoStatus::InProgress)
                .count();
            let mut out = render(&args.todos);
            if in_progress > 1 {
                out.push_str("\nWarning: more than one item is in_progress; keep exactly one.");
            }
            if let Ok(mut map) = store().lock() {
                map.insert(ctx.session_id.clone(), args.todos);
            }
            Ok(ToolOutput::text(out))
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Block;

    #[tokio::test]
    async fn stores_per_session_and_renders() {
        let mut a = ToolContext::new(".");
        a.session_id = "todo-test-a".into();
        let mut b = ToolContext::new(".");
        b.session_id = "todo-test-b".into();
        let out = TodoWriteTool
            .call(
                &a,
                json!({"todos": [
                    {"content": "one", "status": "completed"},
                    {"content": "two", "status": "in_progress"},
                    {"content": "three", "status": "pending"}
                ]}),
            )
            .await
            .unwrap();
        let Block::Text { text } = &out.content[0] else {
            panic!()
        };
        assert_eq!(text, "1. [x] one\n2. [~] two\n3. [ ] three");
        assert_eq!(todos_for("todo-test-a").len(), 3);
        assert!(todos_for("todo-test-b").is_empty());
        let _ = b;
        let out = TodoWriteTool
            .call(&a, json!({"todos": [{"content": "x", "status": "bogus"}]}))
            .await
            .unwrap();
        assert!(out.is_error);
        assert_eq!(todos_for("todo-test-a").len(), 3);
    }
}
