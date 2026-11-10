//! Permission rules the user manages: where they live, how they are loaded
//! and how a hypothetical call is evaluated against them.
//!
//! Three scopes, all visible and editable in Settings:
//! - `global`: `agent-permission-rules.json` in the app data folder.
//! - `project`: `<workspace>/.omnia/permissions.json`. It is part of the
//!   workspace trust fingerprint and honored only while the workspace is trusted.
//! - `session`: stored with the session ("Always allow" adds rules here).
//!
//! Deny beats allow beats ask across every scope; order only breaks ties
//! between rules of the same action.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_harness::permission::{Decision, PermissionMode, PermissionPolicy, PermissionRule};
use omnia_harness::EffectClass;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{NativeError, NativeResult};

pub const GLOBAL_FILE: &str = "agent-permission-rules.json";
pub const PROJECT_FILE: &str = ".omnia/permissions.json";
const MAX_RULES: usize = 500;
const MAX_FIELD_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleScope {
    Global,
    Project,
    Session,
}

/// Checks every rule and the list size; the message names the offending rule.
pub fn validate_rules(rules: &[PermissionRule]) -> NativeResult<()> {
    if rules.len() > MAX_RULES {
        return Err(NativeError::invalid(
            "rules",
            format!("allows at most {MAX_RULES} rules"),
        ));
    }
    for (index, rule) in rules.iter().enumerate() {
        let too_long = rule.tool.chars().count() > MAX_FIELD_CHARS
            || rule
                .pattern
                .as_deref()
                .is_some_and(|p| p.chars().count() > MAX_FIELD_CHARS);
        if too_long {
            return Err(NativeError::invalid(
                "rules",
                format!("rule {} is too long", index + 1),
            ));
        }
        rule.validate().map_err(|message| {
            NativeError::invalid("rules", format!("rule {}: {message}", index + 1))
        })?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
struct RulesFile {
    #[serde(default)]
    rules: Vec<PermissionRule>,
}

/// Parses a rules file (`{"rules":[...]}`); every rule must validate.
pub fn parse_rules_file(bytes: &[u8]) -> Result<Vec<PermissionRule>, String> {
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let file: RulesFile =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    validate_rules(&file.rules).map_err(|e| e.to_string())?;
    Ok(file.rules)
}

fn write_rules_file(path: &Path, rules: &[PermissionRule]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&RulesFile {
        rules: rules.to_vec(),
    })
    .map_err(std::io::Error::other)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

fn failed(what: &str) -> NativeError {
    NativeError::new(
        "permission_rules_failed",
        format!("Could not {what} the permission rules"),
    )
}

/// The user-level rules file in the app data folder.
pub struct RuleStore {
    file: PathBuf,
    lock: Mutex<()>,
}

impl RuleStore {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            file: app_data_dir.join(GLOBAL_FILE),
            lock: Mutex::new(()),
        }
    }

    /// An unreadable file is an error rather than "no rules": silently
    /// dropping the user's deny rules would be unsafe.
    pub fn list(&self) -> NativeResult<Vec<PermissionRule>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        match std::fs::read(&self.file) {
            Ok(bytes) => parse_rules_file(&bytes).map_err(|error| {
                NativeError::new(
                    "permission_rules_invalid",
                    format!("{} is not valid: {error}", self.file.display()),
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(_) => Err(failed("read")),
        }
    }

    pub fn replace(&self, rules: Vec<PermissionRule>) -> NativeResult<Vec<PermissionRule>> {
        validate_rules(&rules)?;
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        write_rules_file(&self.file, &rules).map_err(|_| failed("save"))?;
        Ok(rules)
    }
}

/// Writes (or, for an empty list, removes) the project rules file.
pub fn write_project_rules(cwd: &Path, rules: &[PermissionRule]) -> NativeResult<()> {
    validate_rules(rules)?;
    let path = cwd.join(PROJECT_FILE);
    if rules.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(failed("save")),
        };
    }
    write_rules_file(&path, rules).map_err(|_| failed("save"))
}

/// A rule together with the scope it came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedRule {
    pub scope: RuleScope,
    /// Position within its own scope's list.
    pub index: usize,
    #[serde(flatten)]
    pub rule: PermissionRule,
}

pub fn scoped(scope: RuleScope, rules: &[PermissionRule]) -> Vec<ScopedRule> {
    rules
        .iter()
        .enumerate()
        .map(|(index, rule)| ScopedRule {
            scope,
            index,
            rule: rule.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestOutcome {
    /// `allow`, `ask` or `deny`.
    pub decision: &'static str,
    /// Why: the deny message, or what decided it.
    pub reason: String,
    pub rule: Option<ScopedRule>,
    pub mode: PermissionMode,
    pub effect: EffectClass,
    /// The tool is not a built-in, so its effect class was assumed.
    pub effect_assumed: bool,
}

/// Evaluates `tool(input)` against the layered rules, in the order
/// global, project, session.
pub fn test_call(
    mode: PermissionMode,
    layers: &[(RuleScope, &[PermissionRule])],
    tool: &str,
    input: &Value,
    effect_override: Option<EffectClass>,
) -> TestOutcome {
    let known = omnia_harness::tools::builtin_registry()
        .get(tool)
        .map(|tool| tool.effect())
        .or_else(|| {
            (tool == omnia_harness::plan::PRESENT_PLAN_TOOL).then_some(EffectClass::PureCompute)
        });
    // An unknown tool is assumed to run something, the cautious reading.
    let (effect, effect_assumed) = match (effect_override, known) {
        (Some(effect), _) => (effect, false),
        (None, Some(effect)) => (effect, false),
        (None, None) => (EffectClass::ExecuteProcess, true),
    };
    let mut policy = PermissionPolicy::new(mode);
    let mut origin: Vec<ScopedRule> = Vec::new();
    for (scope, rules) in layers {
        policy.rules.extend(rules.iter().cloned());
        origin.extend(scoped(*scope, rules));
    }
    let explained = policy.explain(tool, effect, input);
    let rule = explained.rule.and_then(|index| origin.get(index).cloned());
    let (decision, reason) = match (&explained.decision, &rule) {
        (Decision::Allow, Some(_)) => ("allow", "An allow rule matches.".to_owned()),
        (Decision::Ask, Some(_)) => ("ask", "An ask rule matches.".to_owned()),
        (Decision::Deny(reason), _) => ("deny", reason.clone()),
        (Decision::Allow, None) => (
            "allow",
            format!("No rule matches; the {mode:?} mode runs it."),
        ),
        (Decision::Ask, None) => (
            "ask",
            format!("No rule matches; the {mode:?} mode asks first."),
        ),
    };
    TestOutcome {
        decision,
        reason,
        rule,
        mode,
        effect,
        effect_assumed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnia_harness::permission::RuleAction;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnia-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn global_store_persists_validates_and_fails_closed() {
        let dir = temp_dir("rules-global");
        let store = RuleStore::new(&dir);
        assert!(store.list().unwrap().is_empty());
        let rules = vec![
            PermissionRule::new("shell", Some("re:^git "), RuleAction::Allow),
            PermissionRule::new("write_file", Some("*.env"), RuleAction::Deny),
        ];
        store.replace(rules.clone()).unwrap();
        // A fresh store reads what was saved, in order.
        assert_eq!(RuleStore::new(&dir).list().unwrap(), rules);
        let bad = vec![PermissionRule::new(
            "shell",
            Some("re:("),
            RuleAction::Allow,
        )];
        assert!(store.replace(bad).is_err());
        assert_eq!(
            store.list().unwrap(),
            rules,
            "a rejected save keeps the old rules"
        );
        std::fs::write(dir.join(GLOBAL_FILE), "{not json").unwrap();
        assert_eq!(store.list().unwrap_err().code, "permission_rules_invalid");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn project_file_round_trips_and_empty_removes_it() {
        let dir = temp_dir("rules-project");
        let rules = vec![PermissionRule::new(
            "shell",
            Some("npm test"),
            RuleAction::Allow,
        )];
        write_project_rules(&dir, &rules).unwrap();
        let bytes = std::fs::read(dir.join(PROJECT_FILE)).unwrap();
        assert_eq!(parse_rules_file(&bytes).unwrap(), rules);
        write_project_rules(&dir, &[]).unwrap();
        assert!(!dir.join(PROJECT_FILE).exists());
        write_project_rules(&dir, &[]).unwrap();
        assert!(parse_rules_file(br#"{"rules":[{"tool":"","action":"allow"}]}"#).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_box_names_the_deciding_rule_and_scope() {
        let global = vec![PermissionRule::new(
            "shell",
            Some("git *"),
            RuleAction::Allow,
        )];
        let project = vec![PermissionRule::new(
            "shell",
            Some("re:push"),
            RuleAction::Deny,
        )];
        let layers: Vec<(RuleScope, &[PermissionRule])> =
            vec![(RuleScope::Global, &global), (RuleScope::Project, &project)];
        let push = test_call(
            PermissionMode::AskWrites,
            &layers,
            "shell",
            &json!({"command": "git push origin"}),
            None,
        );
        assert_eq!(push.decision, "deny");
        let rule = push.rule.unwrap();
        assert_eq!((rule.scope, rule.index), (RuleScope::Project, 0));
        let status = test_call(
            PermissionMode::AskWrites,
            &layers,
            "shell",
            &json!({"command": "git status"}),
            None,
        );
        assert_eq!(status.decision, "allow");
        assert_eq!(status.rule.unwrap().scope, RuleScope::Global);
        let other = test_call(
            PermissionMode::AskWrites,
            &layers,
            "shell",
            &json!({"command": "ls"}),
            None,
        );
        assert_eq!((other.decision, other.rule.is_none()), ("ask", true));
        let unknown = test_call(
            PermissionMode::AskWrites,
            &layers,
            "mcp__x__y",
            &json!({}),
            None,
        );
        assert!(unknown.effect_assumed && unknown.decision == "ask");
        let plan = test_call(
            PermissionMode::Plan,
            &layers,
            "write_file",
            &json!({"path": "a"}),
            None,
        );
        assert_eq!(plan.decision, "deny");
    }
}
