//! Permission policy. The user is the authority: there is no built-in content
//! blocklist. Modes and rules are entirely user-configured, and explicit user
//! rules always win over the mode default.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::EffectClass;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Ask before every tool except pure computation.
    AskAll,
    /// Reads run freely; writes, processes, network and control ask.
    #[default]
    AskWrites,
    /// Everything runs; only actions that are hard to undo ask.
    Auto,
    /// Nothing asks. Only the user's own deny rules still apply.
    Full,
    /// Read-only investigation: anything that changes the workspace, runs a
    /// process or touches the network/desktop is refused so the agent ends
    /// with a plan for the user to approve instead.
    Plan,
}

/// The system-prompt section added to runs in [`PermissionMode::Plan`].
pub const PLAN_MODE_PROMPT: &str = "# Plan mode\nThe user turned on plan mode. Only read-only tools work: \
reading, searching and listing files. Writes, commands, network, browser and desktop actions are refused. \
Investigate what you need, then call the present_plan tool with a concrete step-by-step plan (files to change, \
commands to run, risks): it ends your turn and shows the plan to the user for approval. Do not claim to have \
changed anything.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleAction {
    Allow,
    Ask,
    Deny,
}

/// `tool` is a tool name or `*`; `pattern` is a glob (`*`, `?`) matched against
/// the call's primary argument (command, path or URL). `Bash(git *)` style rules
/// from other harnesses map to `{tool: "shell", pattern: "git *"}`.
///
/// Either field may instead start with `re:`, making the rest a regular
/// expression (Rust `regex` syntax, case-sensitive unless `(?i)`, unanchored:
/// use `^...$` to match the whole value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRule {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    pub action: RuleAction,
}

impl PermissionRule {
    pub fn new(tool: impl Into<String>, pattern: Option<&str>, action: RuleAction) -> Self {
        Self {
            tool: tool.into(),
            pattern: pattern.map(str::to_owned),
            action,
        }
    }

    fn matches(&self, tool: &str, primary: Option<&str>) -> bool {
        if !(self.tool == "*" || pattern_matches(&self.tool, tool)) {
            return false;
        }
        match (&self.pattern, primary) {
            (None, _) => true,
            (Some(pattern), Some(value))
                if tool == "shell"
                    && !pattern.starts_with(REGEX_PREFIX)
                    && !pattern.contains(['*', '?']) =>
            {
                pattern == value
            }
            (Some(pattern), Some(value)) => pattern_matches(pattern, value),
            (Some(_), None) => false,
        }
    }

    /// Rejects rules that could never be used as written: empty tool, empty
    /// pattern, or a `re:` field that is not a valid regular expression.
    pub fn validate(&self) -> Result<(), String> {
        if self.tool.trim().is_empty() {
            return Err("The tool name is empty (use * for every tool)".to_owned());
        }
        if self.pattern.as_deref().is_some_and(str::is_empty) {
            return Err("The pattern is empty (leave it out to match every call)".to_owned());
        }
        for field in std::iter::once(self.tool.as_str()).chain(self.pattern.as_deref()) {
            if let Some(source) = field.strip_prefix(REGEX_PREFIX) {
                compile_regex(source)
                    .map_err(|error| format!("Invalid regular expression `{source}`: {error}"))?;
            }
        }
        Ok(())
    }
}

/// Prefix that turns a rule's tool or pattern into a regular expression.
pub const REGEX_PREFIX: &str = "re:";

fn compile_regex(source: &str) -> Result<regex::Regex, regex::Error> {
    regex::RegexBuilder::new(source).size_limit(1 << 20).build()
}

/// `re:` fields are regular expressions; everything else is a glob.
fn pattern_matches(pattern: &str, text: &str) -> bool {
    match pattern.strip_prefix(REGEX_PREFIX) {
        Some(source) => compile_regex(source).is_ok_and(|regex| regex.is_match(text)),
        None => glob_match(pattern, text),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Ask,
    Deny(String),
}

/// A decision plus the rule (index into [`PermissionPolicy::rules`]) that
/// produced it; `None` when the mode default or Plan mode decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Explained {
    pub decision: Decision,
    pub rule: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionPolicy {
    pub mode: PermissionMode,
    pub rules: Vec<PermissionRule>,
}

impl PermissionPolicy {
    pub fn new(mode: PermissionMode) -> Self {
        Self {
            mode,
            rules: Vec::new(),
        }
    }

    pub fn evaluate(&self, tool: &str, effect: EffectClass, input: &Value) -> Decision {
        self.explain(tool, effect, input).decision
    }

    /// Like [`evaluate`](Self::evaluate), also naming the deciding rule. Deny
    /// rules beat allow rules, which beat ask rules, wherever they sit in the
    /// list; list order only picks between rules of the same action.
    pub fn explain(&self, tool: &str, effect: EffectClass, input: &Value) -> Explained {
        // Plan mode is an explicit user choice for this run, so it holds even
        // over allow rules.
        if self.mode == PermissionMode::Plan && !effect.is_read_only() {
            return Explained {
                decision: Decision::Deny(
                    "Plan mode is read-only. Present this step in your plan for the user to approve instead."
                        .to_owned(),
                ),
                rule: None,
            };
        }
        let primary = primary_argument(input);
        let primary = primary.as_deref();
        for action in [RuleAction::Deny, RuleAction::Allow, RuleAction::Ask] {
            if let Some((index, rule)) = self
                .rules
                .iter()
                .enumerate()
                .find(|(_, rule)| rule.action == action && rule.matches(tool, primary))
            {
                let decision = match action {
                    RuleAction::Allow => Decision::Allow,
                    RuleAction::Ask => Decision::Ask,
                    RuleAction::Deny => Decision::Deny(format!(
                        "Blocked by your rule {}{}",
                        rule.tool,
                        rule.pattern
                            .as_deref()
                            .map(|pattern| format!("({pattern})"))
                            .unwrap_or_default()
                    )),
                };
                return Explained {
                    decision,
                    rule: Some(index),
                };
            }
        }
        let decision = match self.mode {
            PermissionMode::Full | PermissionMode::Plan => Decision::Allow,
            PermissionMode::AskAll => {
                if effect == EffectClass::PureCompute {
                    Decision::Allow
                } else {
                    Decision::Ask
                }
            }
            PermissionMode::AskWrites => {
                if effect.is_read_only() {
                    Decision::Allow
                } else {
                    Decision::Ask
                }
            }
            PermissionMode::Auto => {
                let irreversible = effect == EffectClass::ComputerControl
                    || (effect == EffectClass::ExecuteProcess
                        && primary.is_some_and(looks_irreversible))
                    || publishes_outward(tool, input);
                if irreversible {
                    Decision::Ask
                } else {
                    Decision::Allow
                }
            }
        };
        Explained {
            decision,
            rule: None,
        }
    }

    /// Adds an allow rule for exactly this kind of call (used by "always allow").
    pub fn allow_like(&mut self, tool: &str, input: &Value) {
        let primary = primary_argument(input);
        // A remembered shell approval must not turn `git status` into authority
        // for `git status; arbitrary_command`. Glob metacharacters cannot be
        // represented literally by PermissionRule, so do not remember those.
        if tool == "shell"
            && primary
                .as_ref()
                .is_none_or(|value| value.contains(['*', '?']))
        {
            return;
        }
        // A value that merely looks like a `re:` pattern would be read back as
        // a regular expression, so it is not remembered either.
        if primary
            .as_deref()
            .is_some_and(|value| value.starts_with(REGEX_PREFIX))
        {
            return;
        }
        let pattern = primary;
        let rule = PermissionRule {
            tool: tool.to_owned(),
            pattern,
            action: RuleAction::Allow,
        };
        if !self.rules.contains(&rule) {
            self.rules.push(rule);
        }
    }
}

/// The argument permission rules match against.
pub fn primary_argument(input: &Value) -> Option<String> {
    ["command", "path", "file_path", "url", "pattern", "query"]
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
}

/// Calls that publish to a shared remote (other people see them, and they
/// cannot be taken back quietly) still ask in Auto mode.
fn publishes_outward(tool: &str, input: &Value) -> bool {
    match tool {
        "git_push" => true,
        "gh_pr" => matches!(input["action"].as_str(), Some("create" | "comment")),
        _ => false,
    }
}

fn looks_irreversible(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "rm -rf",
        "rm -r ",
        "rm -fr",
        "remove-item",
        "rmdir /s",
        "rd /s",
        "del /s",
        "del /q",
        "format ",
        "git push --force",
        "git push -f",
        "git reset --hard",
        "git clean -f",
        "git checkout -- .",
        "drop table",
        "drop database",
        "shutdown",
        "diskpart",
        "reg delete",
    ];
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Minimal glob: `*` matches any run (including `/`), `?` one character.
/// Matching is case-insensitive so Windows paths behave as users expect.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();
    let (mut p, mut t) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(star_at) = star {
            p = star_at + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn glob_matching() {
        assert!(glob_match("git *", "git status"));
        assert!(glob_match("src/**", "src/a/b.rs"));
        assert!(glob_match("*.RS", "main.rs"));
        assert!(!glob_match("git *", "npm test"));
        assert!(glob_match("a?c", "abc"));
    }

    #[test]
    fn modes_default_decisions() {
        let read = json!({"path": "a.txt"});
        let ask_writes = PermissionPolicy::new(PermissionMode::AskWrites);
        assert_eq!(
            ask_writes.evaluate("read_file", EffectClass::ReadWorkspace, &read),
            Decision::Allow
        );
        assert_eq!(
            ask_writes.evaluate("write_file", EffectClass::WriteWorkspace, &read),
            Decision::Ask
        );

        let mut plan = PermissionPolicy::new(PermissionMode::Plan);
        plan.allow_like("write_file", &json!({"path": "a.txt"}));
        assert!(matches!(
            plan.evaluate(
                "write_file",
                EffectClass::WriteWorkspace,
                &json!({"path": "a.txt"})
            ),
            Decision::Deny(_)
        ));
        assert_eq!(
            plan.evaluate(
                "read_file",
                EffectClass::ReadWorkspace,
                &json!({"path": "a.txt"})
            ),
            Decision::Allow
        );
        assert!(matches!(
            plan.evaluate(
                "web_fetch",
                EffectClass::Network,
                &json!({"url": "https://x"})
            ),
            Decision::Deny(_)
        ));

        let full = PermissionPolicy::new(PermissionMode::Full);
        let rm = json!({"command": "rm -rf build"});
        assert_eq!(
            full.evaluate("shell", EffectClass::ExecuteProcess, &rm),
            Decision::Allow
        );

        let auto = PermissionPolicy::new(PermissionMode::Auto);
        assert_eq!(
            auto.evaluate("shell", EffectClass::ExecuteProcess, &rm),
            Decision::Ask
        );
        let ls = json!({"command": "ls"});
        assert_eq!(
            auto.evaluate("shell", EffectClass::ExecuteProcess, &ls),
            Decision::Allow
        );
    }

    #[test]
    fn user_rules_override_mode_and_deny_wins() {
        let mut policy = PermissionPolicy::new(PermissionMode::Full);
        policy.rules.push(PermissionRule::new(
            "shell",
            Some("git push*"),
            RuleAction::Deny,
        ));
        policy.rules.push(PermissionRule::new(
            "shell",
            Some("git *"),
            RuleAction::Allow,
        ));
        let push = json!({"command": "git push origin main"});
        assert!(matches!(
            policy.evaluate("shell", EffectClass::ExecuteProcess, &push),
            Decision::Deny(_)
        ));
        let status = json!({"command": "git status"});
        assert_eq!(
            policy.evaluate("shell", EffectClass::ExecuteProcess, &status),
            Decision::Allow
        );

        let mut ask_writes = PermissionPolicy::new(PermissionMode::AskWrites);
        ask_writes.allow_like("shell", &json!({"command": "npm test"}));
        assert_eq!(
            ask_writes.evaluate(
                "shell",
                EffectClass::ExecuteProcess,
                &json!({"command": "npm run build"})
            ),
            Decision::Ask
        );
        for command in ["npm test; rm secret", "npm test && evil", "npm TEST"] {
            assert_eq!(
                ask_writes.evaluate(
                    "shell",
                    EffectClass::ExecuteProcess,
                    &json!({"command": command})
                ),
                Decision::Ask
            );
        }
        assert_eq!(
            ask_writes.evaluate(
                "shell",
                EffectClass::ExecuteProcess,
                &json!({"command": "npm test"})
            ),
            Decision::Allow
        );
        let count = ask_writes.rules.len();
        ask_writes.allow_like("shell", &json!({"command": "git show *"}));
        ask_writes.allow_like("shell", &json!({}));
        assert_eq!(ask_writes.rules.len(), count);
    }

    #[test]
    fn regex_rules_match_tool_and_argument() {
        let mut policy = PermissionPolicy::new(PermissionMode::AskWrites);
        policy.rules.push(PermissionRule::new(
            "shell",
            Some(r"re:^git (status|diff)( .*)?$"),
            RuleAction::Allow,
        ));
        policy.rules.push(PermissionRule::new(
            "re:^(write|edit)_file$",
            Some("re:(?i)\\.env$"),
            RuleAction::Deny,
        ));
        let shell = |command: &str| {
            policy.evaluate(
                "shell",
                EffectClass::ExecuteProcess,
                &json!({ "command": command }),
            )
        };
        assert_eq!(shell("git status"), Decision::Allow);
        assert_eq!(shell("git diff --stat"), Decision::Allow);
        // Anchors make the whole command match; a chained command does not.
        assert_eq!(shell("git status; rm x"), Decision::Ask);
        assert_eq!(shell("git push"), Decision::Ask);
        for tool in ["write_file", "edit_file"] {
            assert!(matches!(
                policy.evaluate(
                    tool,
                    EffectClass::WriteWorkspace,
                    &json!({"path": "app/.ENV"})
                ),
                Decision::Deny(_)
            ));
        }
        assert_eq!(
            policy.evaluate(
                "write_file",
                EffectClass::WriteWorkspace,
                &json!({"path": "a.rs"})
            ),
            Decision::Ask
        );
        assert_eq!(
            policy.evaluate(
                "multi_edit",
                EffectClass::WriteWorkspace,
                &json!({"path": ".env"})
            ),
            Decision::Ask
        );
    }

    #[test]
    fn invalid_regex_never_matches_and_fails_validation() {
        let rule = PermissionRule::new("shell", Some("re:(unclosed"), RuleAction::Allow);
        assert!(rule
            .validate()
            .unwrap_err()
            .contains("Invalid regular expression"));
        let mut policy = PermissionPolicy::new(PermissionMode::AskWrites);
        policy.rules.push(rule);
        assert_eq!(
            policy.evaluate(
                "shell",
                EffectClass::ExecuteProcess,
                &json!({"command": "(unclosed"})
            ),
            Decision::Ask
        );
        assert!(PermissionRule::new("", None, RuleAction::Allow)
            .validate()
            .is_err());
        assert!(PermissionRule::new("shell", Some(""), RuleAction::Allow)
            .validate()
            .is_err());
        assert!(PermissionRule::new("*", None, RuleAction::Ask)
            .validate()
            .is_ok());
    }

    #[test]
    fn deny_beats_allow_regardless_of_order_and_explain_names_the_rule() {
        let mut policy = PermissionPolicy::new(PermissionMode::Full);
        policy.rules.push(PermissionRule::new(
            "shell",
            Some("re:^git "),
            RuleAction::Allow,
        ));
        policy.rules.push(PermissionRule::new(
            "shell",
            Some("git push*"),
            RuleAction::Deny,
        ));
        let push = json!({"command": "git push"});
        let explained = policy.explain("shell", EffectClass::ExecuteProcess, &push);
        assert!(matches!(explained.decision, Decision::Deny(_)));
        assert_eq!(explained.rule, Some(1));
        let status = policy.explain(
            "shell",
            EffectClass::ExecuteProcess,
            &json!({"command": "git status"}),
        );
        assert_eq!((status.decision, status.rule), (Decision::Allow, Some(0)));
        let none = policy.explain(
            "read_file",
            EffectClass::ReadWorkspace,
            &json!({"path": "a"}),
        );
        assert_eq!((none.decision, none.rule), (Decision::Allow, None));
    }

    #[test]
    fn always_allow_does_not_remember_values_that_look_like_regexes() {
        let mut policy = PermissionPolicy::new(PermissionMode::AskWrites);
        policy.allow_like("write_file", &json!({"path": "re:.*"}));
        assert!(policy.rules.is_empty());
    }

    #[test]
    fn auto_mode_asks_before_publishing_to_a_remote() {
        let auto = PermissionPolicy::new(PermissionMode::Auto);
        assert_eq!(
            auto.evaluate("git_push", EffectClass::Network, &json!({})),
            Decision::Ask
        );
        for action in ["create", "comment"] {
            assert_eq!(
                auto.evaluate("gh_pr", EffectClass::Network, &json!({"action": action})),
                Decision::Ask
            );
        }
        for action in ["view", "list", "checks"] {
            assert_eq!(
                auto.evaluate("gh_pr", EffectClass::Network, &json!({"action": action})),
                Decision::Allow
            );
        }
        assert_eq!(
            auto.evaluate("git_pull", EffectClass::Network, &json!({})),
            Decision::Allow
        );
        let full = PermissionPolicy::new(PermissionMode::Full);
        assert_eq!(
            full.evaluate("git_push", EffectClass::Network, &json!({})),
            Decision::Allow
        );
    }
}
