//! System prompt assembly: a short operating brief, the environment, and the
//! project's own instruction files.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Project-level default system prompt text, appended when the session has no
/// override of its own.
pub const PROJECT_SYSTEM_PROMPT_FILE: &str = ".omnia/system-prompt.md";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemPromptMode {
    /// Added after the built-in prompt.
    Append,
    /// Used instead of the built-in prompt.
    Replace,
}

/// A user-authored system prompt override (per session, or a saved preset).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemPromptConfig {
    pub mode: SystemPromptMode,
    pub text: String,
}

/// Everything that goes into one session's system prompt, already resolved.
pub struct PromptInputs<'a> {
    /// The built-in prompt (brief, environment, project rule files).
    pub base: String,
    /// Text of `<cwd>/.omnia/system-prompt.md`, if present.
    pub project_default: Option<&'a str>,
    /// The session's override; takes precedence over the project default.
    pub session_override: Option<&'a SystemPromptConfig>,
    pub plan_mode: bool,
    pub memory_section: Option<&'a str>,
    pub skills_section: Option<&'a str>,
}

/// The single place the final system prompt is assembled, used by both a real
/// run and the preview. Replace swaps out only the base prompt; the plan-mode,
/// memory and skills sections are functional and always follow.
pub fn compose_system_prompt(inputs: &PromptInputs<'_>) -> String {
    let override_text = inputs
        .session_override
        .filter(|config| !config.text.trim().is_empty());
    let mut out = match override_text {
        Some(config) if config.mode == SystemPromptMode::Replace => config.text.trim().to_owned(),
        Some(config) => format!(
            "{}

{}",
            inputs.base,
            config.text.trim()
        ),
        None => match inputs
            .project_default
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(text) => format!(
                "{}

{}",
                inputs.base, text
            ),
            None => inputs.base.clone(),
        },
    };
    if inputs.plan_mode {
        out.push_str(
            "

",
        );
        out.push_str(crate::permission::PLAN_MODE_PROMPT);
    }
    for section in [inputs.memory_section, inputs.skills_section]
        .into_iter()
        .flatten()
    {
        out.push_str(
            "

",
        );
        out.push_str(section);
    }
    out
}

/// Contents of the project's `.omnia/system-prompt.md`, if usable.
pub fn project_system_prompt(cwd: &Path) -> Option<String> {
    let path = cwd.join(PROJECT_SYSTEM_PROMPT_FILE);
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RULE_FILE_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    (!text.trim().is_empty()).then_some(text)
}

/// Instruction files read from the workspace root, in priority order. All
/// that exist are included, so a repo set up for another harness just works.
pub const PROJECT_RULE_FILES: &[&str] = &["OMNIA.md", "AGENTS.md", "CLAUDE.md", ".omnia/OMNIA.md"];
const MAX_RULE_FILE_BYTES: u64 = 64 * 1024;

const BRIEF: &str =
    "You are Omnia, an agent working in the user's workspace through the tools provided. \
The user directs the work: do what they ask, fully, using your own judgment on how. \
Read before you edit, keep changes focused, and verify your work (build, tests) when you can. \
Use tools in parallel when calls are independent. \
When a tool is denied, adjust instead of retrying the same call. \
Be concise in prose; put detail in the work itself.";

pub fn system_prompt(cwd: &Path, model: &str) -> String {
    let mut prompt = String::from(BRIEF);
    prompt.push_str("\n\n# Environment\n");
    prompt.push_str(&format!("- Working directory: {}\n", cwd.display()));
    prompt.push_str(&format!(
        "- Platform: {} ({})\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    prompt.push_str(&format!("- Model: {model}\n"));
    prompt.push_str(&format!(
        "- Git repository: {}\n",
        cwd.join(".git").exists()
    ));
    for rules in project_rules(cwd) {
        prompt.push_str(&format!(
            "\n# Project instructions ({})\n{}\n",
            rules.0,
            rules.1.trim()
        ));
    }
    prompt
}

/// `(file name, contents)` for each instruction file present in `cwd`.
pub fn project_rules(cwd: &Path) -> Vec<(String, String)> {
    PROJECT_RULE_FILES
        .iter()
        .filter_map(|name| {
            let path = cwd.join(name);
            let metadata = std::fs::metadata(&path).ok()?;
            if !metadata.is_file() || metadata.len() > MAX_RULE_FILE_BYTES {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            (!text.trim().is_empty()).then(|| ((*name).to_owned(), text))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_environment_and_rule_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "Use tabs.").unwrap();
        let prompt = system_prompt(dir.path(), "m1");
        assert!(prompt.contains("Model: m1"));
        assert!(prompt.contains("# Project instructions (AGENTS.md)\nUse tabs."));
        assert!(!prompt.contains("CLAUDE.md"));
    }

    fn inputs<'a>(
        over: Option<&'a SystemPromptConfig>,
        project: Option<&'a str>,
    ) -> PromptInputs<'a> {
        PromptInputs {
            base: "BASE".into(),
            project_default: project,
            session_override: over,
            plan_mode: false,
            memory_section: None,
            skills_section: None,
        }
    }
    fn cfg(mode: SystemPromptMode, text: &str) -> SystemPromptConfig {
        SystemPromptConfig {
            mode,
            text: text.into(),
        }
    }

    #[test]
    fn default_is_base_only() {
        assert_eq!(compose_system_prompt(&inputs(None, None)), "BASE");
    }

    #[test]
    fn append_and_replace() {
        let a = cfg(SystemPromptMode::Append, " extra ");
        assert_eq!(
            compose_system_prompt(&inputs(Some(&a), None)),
            "BASE

extra"
        );
        let r = cfg(SystemPromptMode::Replace, "mine");
        assert_eq!(compose_system_prompt(&inputs(Some(&r), None)), "mine");
    }

    #[test]
    fn blank_override_is_ignored() {
        let r = cfg(SystemPromptMode::Replace, "  ");
        assert_eq!(
            compose_system_prompt(&inputs(Some(&r), Some("proj"))),
            "BASE

proj"
        );
    }

    #[test]
    fn project_default_appends_unless_session_overrides() {
        assert_eq!(
            compose_system_prompt(&inputs(
                None,
                Some(
                    "proj
"
                )
            )),
            "BASE

proj"
        );
        let r = cfg(SystemPromptMode::Replace, "mine");
        assert_eq!(
            compose_system_prompt(&inputs(Some(&r), Some("proj"))),
            "mine"
        );
    }

    #[test]
    fn functional_sections_survive_replace() {
        let r = cfg(SystemPromptMode::Replace, "mine");
        let mut i = inputs(Some(&r), None);
        i.plan_mode = true;
        i.memory_section = Some("MEM");
        i.skills_section = Some("SKILLS");
        let out = compose_system_prompt(&i);
        assert!(out.starts_with(
            "mine

# Plan mode"
        ));
        assert!(out.ends_with(
            "

MEM

SKILLS"
        ));
        assert!(!out.contains("BASE"));
    }

    #[test]
    fn reads_project_system_prompt_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(project_system_prompt(dir.path()).is_none());
        std::fs::create_dir_all(dir.path().join(".omnia")).unwrap();
        std::fs::write(dir.path().join(PROJECT_SYSTEM_PROMPT_FILE), "Be terse.").unwrap();
        assert_eq!(
            project_system_prompt(dir.path()).as_deref(),
            Some("Be terse.")
        );
    }

    #[test]
    fn config_serde_shape() {
        let c: SystemPromptConfig =
            serde_json::from_str(r#"{"mode":"replace","text":"x"}"#).unwrap();
        assert_eq!(c.mode, SystemPromptMode::Replace);
    }
}
