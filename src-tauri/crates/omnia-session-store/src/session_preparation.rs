//! Transport-independent session prompt and agent configuration preparation.
//!
//! Callers supply the selected workspace, home and discovered skills. This
//! function does not discover environment settings, open storage, authorize
//! workspace content, resolve credentials, register tools or dispatch a run.
//! Prompt file reads retain the existing harness semantics; this is not an
//! immutable configuration snapshot or a replacement for the trust boundary.

use std::path::Path;

use omnia_harness::{
    agent::AgentConfig,
    memory, prompt,
    prompt::PromptInputs,
    skills::{self, Skill},
};

use crate::harness_store::AgentSessionSummary;

/// Prepare the same prompt and routing settings for native and compatibility
/// consumers. Every field not owned by the session retains `AgentConfig`'s
/// default, including retry, context, compaction and cancellation settings.
pub fn prepare_session_config(
    summary: &AgentSessionSummary,
    cwd: &Path,
    omnia_home: Option<&Path>,
    plan_mode: bool,
    skills: &[Skill],
) -> AgentConfig {
    let project_default = prompt::project_system_prompt(cwd);
    let memory = memory::memory_prompt_section(cwd, omnia_home);
    let skills_section = (!skills.is_empty()).then(|| skills::skills_prompt_section(skills));
    let system = prompt::compose_system_prompt(&PromptInputs {
        base: prompt::system_prompt(cwd, &summary.model),
        project_default: project_default.as_deref(),
        session_override: summary.system_prompt.as_ref(),
        plan_mode,
        memory_section: memory.as_deref(),
        skills_section: skills_section.as_deref(),
    });
    AgentConfig {
        model: summary.model.clone(),
        system: Some(system),
        reasoning_effort: summary.reasoning_effort.clone(),
        fallback_models: summary.fallback_models.clone(),
        token_budget: summary.token_budget,
        initial_tokens_used: summary.tokens_used,
        ..AgentConfig::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_store::SessionScope;
    use omnia_harness::{
        permission::{PermissionMode, PLAN_MODE_PROMPT},
        prompt::{SystemPromptConfig, SystemPromptMode},
        skills::SkillSource,
    };
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "omnia-session-preparation-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only the unique disposable directory created by this fixture.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn summary() -> AgentSessionSummary {
        AgentSessionSummary {
            id: "session-preparation".into(),
            title: "Preparation".into(),
            scope: SessionScope::Projectless,
            cwd: "unused-summary-cwd".into(),
            profile_id: "provider-selected".into(),
            model: "model-selected".into(),
            permission_mode: PermissionMode::default(),
            rules: Vec::new(),
            reasoning_effort: None,
            fallback_models: Vec::new(),
            token_budget: None,
            tokens_used: 0,
            system_prompt: None,
            parent_id: None,
            settings_revision: 1,
            message_count: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn routing_budget_and_unowned_defaults_are_preserved() {
        let fixture = Fixture::new();
        let mut summary = summary();
        summary.reasoning_effort = Some("xhigh".into());
        summary.fallback_models = vec!["fallback-a".into(), "fallback-b".into()];
        summary.token_budget = Some(123_456);
        summary.tokens_used = 4_567;
        let actual = prepare_session_config(&summary, &fixture.0, None, false, &[]);
        let expected = AgentConfig {
            model: summary.model.clone(),
            system: Some(prompt::system_prompt(&fixture.0, &summary.model)),
            reasoning_effort: summary.reasoning_effort.clone(),
            fallback_models: summary.fallback_models.clone(),
            token_budget: summary.token_budget,
            initial_tokens_used: summary.tokens_used,
            ..AgentConfig::default()
        };
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn project_default_yields_to_append_and_replace_session_overrides() {
        let fixture = Fixture::new();
        fixture.write(".omnia/system-prompt.md", "PROJECT_DEFAULT_SENTINEL");
        let mut summary = summary();
        let project = prepare_session_config(&summary, &fixture.0, None, false, &[])
            .system
            .unwrap();
        assert!(project.ends_with("PROJECT_DEFAULT_SENTINEL"));
        for mode in [SystemPromptMode::Append, SystemPromptMode::Replace] {
            summary.system_prompt = Some(SystemPromptConfig {
                mode,
                text: " SESSION_OVERRIDE_SENTINEL ".into(),
            });
            let system = prepare_session_config(&summary, &fixture.0, None, false, &[])
                .system
                .unwrap();
            assert!(!system.contains("PROJECT_DEFAULT_SENTINEL"));
            if mode == SystemPromptMode::Replace {
                assert_eq!(system, "SESSION_OVERRIDE_SENTINEL");
            } else {
                assert!(system.starts_with(&prompt::system_prompt(&fixture.0, &summary.model)));
                assert!(system.ends_with("SESSION_OVERRIDE_SENTINEL"));
            }
        }
        summary.system_prompt.as_mut().unwrap().text = " \n ".into();
        assert!(
            prepare_session_config(&summary, &fixture.0, None, false, &[])
                .system
                .unwrap()
                .ends_with("PROJECT_DEFAULT_SENTINEL")
        );
    }

    #[test]
    fn replace_preserves_plan_memory_and_skill_sections_in_order() {
        let workspace = Fixture::new();
        let home = Fixture::new();
        workspace.write(".omnia/memory/MEMORY.md", "PROJECT_MEMORY_SENTINEL");
        home.write("memory/MEMORY.md", "USER_MEMORY_SENTINEL");
        let mut summary = summary();
        summary.system_prompt = Some(SystemPromptConfig {
            mode: SystemPromptMode::Replace,
            text: "REPLACED_BASE_SENTINEL".into(),
        });
        let skills = vec![Skill {
            name: "preparation-skill".into(),
            description: "SKILL_DESCRIPTION_SENTINEL".into(),
            path: workspace.0.join("not-loaded/SKILL.md"),
            dir: workspace.0.join("not-loaded"),
            source: SkillSource::Project,
        }];
        let system = prepare_session_config(&summary, &workspace.0, Some(&home.0), true, &skills)
            .system
            .unwrap();
        assert!(system.starts_with("REPLACED_BASE_SENTINEL"));
        let plan_at = system.find(PLAN_MODE_PROMPT).unwrap();
        let memory_at = system.find("# Memory").unwrap();
        let skills_at = system.find("# Skills").unwrap();
        assert!(plan_at < memory_at && memory_at < skills_at);
        assert!(system.contains("PROJECT_MEMORY_SENTINEL"));
        assert!(system.contains("USER_MEMORY_SENTINEL"));
        assert!(system.contains("SKILL_DESCRIPTION_SENTINEL"));
        assert!(!workspace.0.join("not-loaded").exists());
        let without_home = prepare_session_config(&summary, &workspace.0, None, false, &[])
            .system
            .unwrap();
        assert!(without_home.contains("PROJECT_MEMORY_SENTINEL"));
        assert!(!without_home.contains("USER_MEMORY_SENTINEL"));
        assert!(!without_home.contains(PLAN_MODE_PROMPT));
        assert!(!without_home.contains("# Skills"));
    }
}
