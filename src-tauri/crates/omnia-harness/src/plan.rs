//! `present_plan`: how a Plan-mode run hands its plan to the user. Calling it
//! ends the turn (the agent loop stops after the tool result), and the host
//! shows the plan for approval. It exists only in Plan mode.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::permission::PermissionMode;
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec};

/// Tool name; the agent loop ends the run after a successful call to it.
pub const PRESENT_PLAN_TOOL: &str = "present_plan";

pub struct PresentPlanTool;

/// The plan text of a `present_plan` call's input, if it is usable.
pub fn plan_text(input: &Value) -> Option<&str> {
    input
        .get("plan")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
}

#[async_trait]
impl Tool for PresentPlanTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: PRESENT_PLAN_TOOL.into(),
            description: "Present your finished plan to the user for approval and end your turn. \
Use it once, when you have investigated enough: the plan should list the steps, the files to change, \
the commands to run and the risks. The user can approve it (the session then leaves plan mode and you \
are asked to proceed) or ask you to keep planning with feedback."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "string",
                        "description": "The complete plan in Markdown."
                    }
                },
                "required": ["plan"]
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        // Nothing is touched, so Plan mode (read-only) permits it.
        EffectClass::PureCompute
    }

    fn describe(&self, input: &Value) -> String {
        match plan_text(input) {
            Some(plan) => format!("Present plan ({} characters)", plan.chars().count()),
            None => "Present plan".to_owned(),
        }
    }

    async fn call(&self, _ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        if plan_text(&input).is_none() {
            return Ok(ToolOutput::error(
                "present_plan needs a non-empty `plan` string. Write the plan and call it again.",
            ));
        }
        Ok(ToolOutput::text(
            "Plan presented to the user. Stop here: wait for their approval or feedback.",
        ))
    }
}

/// Adds `present_plan` when (and only when) the run is in Plan mode.
pub fn register_for_mode(registry: &mut ToolRegistry, mode: PermissionMode) {
    if mode == PermissionMode::Plan {
        registry.register(Arc::new(PresentPlanTool));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn present_plan_exists_only_in_plan_mode() {
        for mode in [
            PermissionMode::AskAll,
            PermissionMode::AskWrites,
            PermissionMode::Auto,
            PermissionMode::Full,
        ] {
            let mut registry = ToolRegistry::default();
            register_for_mode(&mut registry, mode);
            assert!(registry.get(PRESENT_PLAN_TOOL).is_none(), "{mode:?}");
        }
        let mut registry = ToolRegistry::default();
        register_for_mode(&mut registry, PermissionMode::Plan);
        assert!(registry.get(PRESENT_PLAN_TOOL).is_some());
    }

    #[tokio::test]
    async fn rejects_an_empty_plan() {
        let ctx = ToolContext::new(std::env::temp_dir());
        let empty = PresentPlanTool
            .call(&ctx, json!({"plan": "  "}))
            .await
            .unwrap();
        assert!(empty.is_error);
        let ok = PresentPlanTool
            .call(&ctx, json!({"plan": "1. do it"}))
            .await
            .unwrap();
        assert!(!ok.is_error);
    }
}
