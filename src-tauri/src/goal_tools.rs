//! Native planning tools exposed to an Omnia agent run.
//!
//! The MCP server and the in-process harness use the same typed backend and
//! native storage implementation.  This adapter deliberately does not call
//! loopback HTTP: an agent run already has a trusted `AppHandle`, so adding a
//! transport hop would create a second failure and authorization surface.

use std::sync::Arc;

use async_trait::async_trait;
use omnia_harness::{
    EffectClass, HarnessError, HarnessResult, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::agent_services::ServiceGuard;
use crate::mcp_server::{
    task_tool_definitions, GoalEditArgs, GoalListArgs, GoalReadArgs, GoalRemoveArgs, GoalSetArgs,
    McpBackend, TaskCreateArgs, TaskDependencyCreateArgs, TaskDependencyListArgs, TaskListArgs,
    TaskReadArgs, TaskRevisionCreateArgs, TaskRevisionReadArgs, TaskStatusUpdateArgs,
};

const NAMES: [&str; 13] = [
    "omnia_goal_list",
    "omnia_goal_read",
    "omnia_goal_set",
    "omnia_goal_edit",
    "omnia_goal_remove",
    "omnia_task_list",
    "omnia_task_read",
    "omnia_task_revision_read",
    "omnia_task_dependency_list",
    "omnia_task_create",
    "omnia_task_revision_create",
    "omnia_task_status_update",
    "omnia_task_dependency_create",
];

fn planning_spec(name: &str) -> ToolSpec {
    let definitions = if name.starts_with("omnia_task_") {
        task_tool_definitions()
    } else {
        crate::mcp_server::goal_tool_definitions()
    };
    let definition = definitions
        .as_array()
        .expect("MCP tools are a static array")
        .iter()
        .find(|definition| definition["name"].as_str() == Some(name))
        .expect("registered planning name has an MCP definition");
    ToolSpec {
        name: name.to_owned(),
        description: definition["description"]
            .as_str()
            .expect("MCP tool description is static text")
            .to_owned(),
        input_schema: definition["inputSchema"].clone(),
    }
}

fn decode<T: DeserializeOwned>(input: Value, name: &str) -> HarnessResult<T> {
    if !input.is_object() {
        return Err(HarnessError::InvalidInput(format!(
            "{name} arguments must be a JSON object"
        )));
    }
    serde_json::from_value(input)
        .map_err(|error| HarnessError::InvalidInput(format!("Invalid {name} arguments: {error}")))
}

struct GoalPlanningTool {
    name: &'static str,
    backend: Arc<dyn McpBackend>,
    guard: ServiceGuard,
}

impl GoalPlanningTool {
    fn new(name: &'static str, backend: Arc<dyn McpBackend>, guard: ServiceGuard) -> Self {
        Self {
            name,
            backend,
            guard,
        }
    }
}

#[async_trait]
impl Tool for GoalPlanningTool {
    fn spec(&self) -> ToolSpec {
        planning_spec(self.name)
    }

    fn effect(&self) -> EffectClass {
        match self.name {
            "omnia_goal_list" | "omnia_goal_read" => EffectClass::ReadWorkspace,
            "omnia_task_list"
            | "omnia_task_read"
            | "omnia_task_revision_read"
            | "omnia_task_dependency_list" => EffectClass::ReadWorkspace,
            _ => EffectClass::WriteWorkspace,
        }
    }

    fn describe(&self, input: &Value) -> String {
        let target = input
            .get("goalId")
            .and_then(Value::as_str)
            .or_else(|| input.get("taskId").and_then(Value::as_str))
            .or_else(|| input.get("title").and_then(Value::as_str))
            .unwrap_or("planning state");
        format!("{} `{target}`", self.name)
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        if ctx.cancel.is_cancelled() {
            return Err(HarnessError::Cancelled);
        }
        if let Err(error) = (self.guard)() {
            return Ok(ToolOutput::error(error.to_string()));
        }
        let result = match self.name {
            "omnia_goal_list" => {
                self.backend
                    .goal_list(decode::<GoalListArgs>(input, self.name)?)
                    .await
            }
            "omnia_goal_read" => {
                self.backend
                    .goal_read(decode::<GoalReadArgs>(input, self.name)?)
                    .await
            }
            "omnia_goal_set" => {
                self.backend
                    .goal_set(decode::<GoalSetArgs>(input, self.name)?)
                    .await
            }
            "omnia_goal_edit" => {
                self.backend
                    .goal_edit(decode::<GoalEditArgs>(input, self.name)?)
                    .await
            }
            "omnia_goal_remove" => {
                self.backend
                    .goal_remove(decode::<GoalRemoveArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_list" => {
                self.backend
                    .task_list(decode::<TaskListArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_read" => {
                self.backend
                    .task_read(decode::<TaskReadArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_revision_read" => {
                self.backend
                    .task_revision_read(decode::<TaskRevisionReadArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_dependency_list" => {
                self.backend
                    .task_dependency_list(decode::<TaskDependencyListArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_create" => {
                self.backend
                    .task_create(decode::<TaskCreateArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_revision_create" => {
                self.backend
                    .task_revision_create(decode::<TaskRevisionCreateArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_status_update" => {
                self.backend
                    .task_status_update(decode::<TaskStatusUpdateArgs>(input, self.name)?)
                    .await
            }
            "omnia_task_dependency_create" => {
                self.backend
                    .task_dependency_create(decode::<TaskDependencyCreateArgs>(input, self.name)?)
                    .await
            }
            _ => unreachable!("only fixed planning tool names are registered"),
        };
        match result {
            Ok(value) => Ok(ToolOutput::text(
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()),
            )),
            Err(error) => Ok(ToolOutput::error(error)),
        }
    }
}

/// Register the goal and Task planning tools in the same registry as the agent run.
/// `McpBackend` remains the single mutation path, so MCP and in-process AI
/// calls have identical CAS, idempotency and preview-only behavior.
pub(crate) fn register(
    registry: &mut ToolRegistry,
    backend: Arc<dyn McpBackend>,
    guard: ServiceGuard,
) {
    for name in NAMES {
        registry.register(Arc::new(GoalPlanningTool::new(
            name,
            Arc::clone(&backend),
            guard.clone(),
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_server::{CreateSessionArgs, SendArgs};
    use async_trait::async_trait;
    use omnia_harness::permission::{Decision, PermissionMode, PermissionPolicy};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct RecordingBackend {
        calls: AtomicUsize,
    }

    impl RecordingBackend {
        fn receipt(&self) -> Result<Value, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "executionDisposition": "preview-only",
                "integrity": "valid",
                "replayed": false,
                "receiptId": "native-receipt"
            }))
        }
    }

    #[async_trait]
    impl McpBackend for RecordingBackend {
        async fn list_sessions(&self) -> Result<Value, String> {
            Err("not a planning tool".into())
        }
        async fn read_session(&self, _: &str, _: Option<usize>) -> Result<String, String> {
            Err("not a planning tool".into())
        }
        async fn create_session(&self, _: CreateSessionArgs) -> Result<Value, String> {
            Err("not a planning tool".into())
        }
        async fn send_message(&self, _: SendArgs) -> Result<Value, String> {
            Err("not a planning tool".into())
        }
        async fn interrupt(&self, _: &str) -> Result<Value, String> {
            Err("not a planning tool".into())
        }
        async fn list_profiles(&self) -> Result<Value, String> {
            Err("not a planning tool".into())
        }
        async fn goal_list(&self, _: GoalListArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn goal_read(&self, _: GoalReadArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn goal_set(&self, args: GoalSetArgs) -> Result<Value, String> {
            if args.idempotency_key == "backend-conflict" {
                self.calls.fetch_add(1, Ordering::SeqCst);
                return Err("stale_revision_head: preserved native failure".into());
            }
            self.receipt()
        }
        async fn goal_edit(&self, _: GoalEditArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn goal_remove(&self, _: GoalRemoveArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_list(&self, _: TaskListArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_read(&self, _: TaskReadArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_revision_read(&self, _: TaskRevisionReadArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_dependency_list(&self, _: TaskDependencyListArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_create(&self, _: TaskCreateArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_revision_create(&self, _: TaskRevisionCreateArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_status_update(&self, _: TaskStatusUpdateArgs) -> Result<Value, String> {
            self.receipt()
        }
        async fn task_dependency_create(
            &self,
            _: TaskDependencyCreateArgs,
        ) -> Result<Value, String> {
            self.receipt()
        }
    }

    fn tools() -> (ToolRegistry, Arc<RecordingBackend>) {
        let backend = Arc::new(RecordingBackend::default());
        let mut registry = ToolRegistry::default();
        register(&mut registry, backend.clone(), Arc::new(|| Ok(())));
        (registry, backend)
    }

    #[test]
    fn exposes_only_fixed_planning_names_and_shared_schemas() {
        let (registry, _) = tools();
        let mut expected = NAMES.to_vec();
        expected.sort();
        assert_eq!(registry.names().collect::<Vec<_>>(), expected);
        for name in NAMES {
            let spec = registry.get(name).unwrap().spec();
            assert_eq!(spec, planning_spec(name));
            assert_eq!(spec.input_schema["additionalProperties"], false);
        }
        assert!(registry.get("omnia_interrupt").is_none());
        assert!(registry.get("omnia_send_message").is_none());
    }

    #[test]
    fn real_registered_effects_enforce_plan_and_ask_writes_policy() {
        let (registry, _) = tools();
        let plan = PermissionPolicy::new(PermissionMode::Plan);
        let ask_writes = PermissionPolicy::new(PermissionMode::AskWrites);
        for name in NAMES {
            let effect = registry.get(name).unwrap().effect();
            if matches!(
                name,
                "omnia_goal_list"
                    | "omnia_goal_read"
                    | "omnia_task_list"
                    | "omnia_task_read"
                    | "omnia_task_revision_read"
                    | "omnia_task_dependency_list"
            ) {
                assert_eq!(effect, EffectClass::ReadWorkspace);
                assert_eq!(plan.evaluate(name, effect, &json!({})), Decision::Allow);
                assert_eq!(
                    ask_writes.evaluate(name, effect, &json!({})),
                    Decision::Allow
                );
            } else {
                assert_eq!(effect, EffectClass::WriteWorkspace);
                assert!(matches!(
                    plan.evaluate(name, effect, &json!({})),
                    Decision::Deny(_)
                ));
                assert_eq!(ask_writes.evaluate(name, effect, &json!({})), Decision::Ask);
            }
        }
    }

    #[tokio::test]
    async fn cancelled_or_malformed_calls_never_reach_backend() {
        let (registry, backend) = tools();
        let tool = registry.get("omnia_goal_set").unwrap();
        let ctx = ToolContext::new(std::env::temp_dir());
        for input in [
            json!({"title": "Missing idempotency key"}),
            json!({"title": "Goal", "idempotencyKey": "key", "runState": "running"}),
            json!({"title": " ", "idempotencyKey": "key"}),
            json!([]),
        ] {
            assert!(tool.call(&ctx, input).await.is_err());
        }
        ctx.cancel.cancel();
        assert!(matches!(
            tool.call(&ctx, json!({"title": "Goal", "idempotencyKey": "key"}))
                .await,
            Err(HarnessError::Cancelled)
        ));
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn service_guard_rejects_calls_before_native_backend() {
        let backend = Arc::new(RecordingBackend::default());
        let mut registry = ToolRegistry::default();
        let guard: ServiceGuard = Arc::new(|| {
            Err(crate::error::NativeError::new(
                "session_unavailable",
                "session is closed",
            ))
        });
        register(&mut registry, backend.clone(), guard);
        let out = registry
            .get("omnia_goal_list")
            .unwrap()
            .call(
                &ToolContext::new(std::env::temp_dir()),
                serde_json::json!({}),
            )
            .await
            .expect("guard errors are returned as tool errors");
        assert!(out.is_error);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn receipts_and_native_failures_are_returned_without_live_claims() {
        let (registry, backend) = tools();
        let ctx = ToolContext::new(std::env::temp_dir());
        let tool = registry.get("omnia_goal_set").unwrap();
        let output = tool
            .call(&ctx, json!({"title": "Goal", "idempotencyKey": "key"}))
            .await
            .unwrap();
        assert!(!output.is_error);
        let text = match &output.content[0] {
            omnia_harness::Block::Text { text } => text,
            _ => panic!("planning output must be text"),
        };
        let receipt: Value = serde_json::from_str(text).unwrap();
        assert_eq!(receipt["receiptId"], "native-receipt");
        assert_eq!(receipt["executionDisposition"], "preview-only");
        let failure = tool
            .call(
                &ctx,
                json!({"title": "Goal", "idempotencyKey": "backend-conflict"}),
            )
            .await
            .unwrap();
        assert!(failure.is_error);
        assert!(
            matches!(&failure.content[0], omnia_harness::Block::Text { text } if text.contains("stale_revision_head"))
        );
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn task_adapter_uses_shared_schema_and_preview_receipt() {
        let (registry, backend) = tools();
        let ctx = ToolContext::new(std::env::temp_dir());
        let tool = registry.get("omnia_task_create").unwrap();
        let output = tool
            .call(
                &ctx,
                json!({
                    "goalId": "goal_parent",
                    "title": "Task",
                    "idempotencyKey": "task-key"
                }),
            )
            .await
            .unwrap();
        assert!(!output.is_error);
        let text = match &output.content[0] {
            omnia_harness::Block::Text { text } => text,
            _ => panic!("task planning output must be text"),
        };
        let receipt: Value = serde_json::from_str(text).unwrap();
        assert_eq!(receipt["executionDisposition"], "preview-only");
        assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    }
}
