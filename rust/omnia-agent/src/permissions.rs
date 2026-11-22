//! Fine-grained Allow/Deny Glob Permission Rules engine with Untrusted-Repo Trust Gate.
//!
//! Security model:
//! - Base approval modes: `plan`, `always-ask`, `always-ask-cached`, `write`, `yolo`.
//! - Global & workspace rules carry `{ action: allow | deny, tool, matchPattern }`.
//! - **Deny ALWAYS wins** — even over `yolo` / `Trusted`!
//! - **Untrusted Repo Gate:** When `workspace_trusted == false`, workspace `deny` rules
//!   ARE enforced, while workspace `allow` rules are IGNORED until explicitly trusted.

use glob::Pattern;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Plan,
    AlwaysAsk,
    AlwaysAskCached,
    Write,
    Yolo,
}

impl ApprovalMode {
    /// Strictly parse a CLI flag value (`plan`, `always-ask`, `always-ask-cached`, `write`, `yolo`),
    /// returning an error on unknown/typo values (never silently falling back to `Yolo`).
    pub fn try_parse_flag(s: &str) -> anyhow::Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "plan" => Ok(Self::Plan),
            "write" => Ok(Self::Write),
            "always-ask" | "ask" => Ok(Self::AlwaysAsk),
            "always-ask-cached" => Ok(Self::AlwaysAskCached),
            "yolo" => Ok(Self::Yolo),
            other => anyhow::bail!(
                "invalid approval mode '{other}' (expected: plan | always-ask | always-ask-cached | write | yolo)"
            ),
        }
    }

    /// Parse CLI flag value, failing closed to `ApprovalMode::AlwaysAsk` on unknown values.
    #[must_use]
    pub fn parse_flag(s: &str) -> Self {
        Self::try_parse_flag(s).unwrap_or(Self::AlwaysAsk)
    }

    /// CLI flag string representation.
    #[must_use]
    pub const fn as_flag(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::AlwaysAsk => "always-ask",
            Self::AlwaysAskCached => "always-ask-cached",
            Self::Write => "write",
            Self::Yolo => "yolo",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionScope {
    Global,
    Workspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionAction {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionDecision {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub id: String,
    pub scope: PermissionScope,
    pub workspace_id: Option<String>,
    pub action: PermissionAction,
    pub tool: String,
    pub match_pattern: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEvalResult {
    pub decision: PermissionDecision,
    pub matched_rule_id: Option<String>,
    pub reason: String,
    pub untrusted_override: bool,
}

pub struct PermissionsEngine;

impl PermissionsEngine {
    /// Built-in default safety deny rules (`.env*`, SSH private keys, destructive shell/git ops).
    #[must_use]
    pub fn default_rules() -> Vec<PermissionRule> {
        vec![
            PermissionRule {
                id: "builtin-deny-env".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "*".into(),
                match_pattern: "*.env*".into(),
                note: "Block reading/writing environment secret files even in YOLO mode".into(),
            },
            PermissionRule {
                id: "builtin-deny-ssh".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "*".into(),
                match_pattern: "*id_rsa*".into(),
                note: "Protect SSH private keys".into(),
            },
            PermissionRule {
                id: "builtin-deny-rm-rf".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*rm -rf /*".into(),
                note: "Block destructive root deletion".into(),
            },
            PermissionRule {
                id: "builtin-deny-win-remove-item".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*Remove-Item*-Recurse*-Force*".into(),
                note: "Block Windows PowerShell recursive force delete".into(),
            },
            PermissionRule {
                id: "builtin-deny-win-remove-item-fr".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*Remove-Item*-Force*-Recurse*".into(),
                note: "Block Windows PowerShell force recursive delete".into(),
            },
            PermissionRule {
                id: "builtin-deny-win-del-sq".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*del /s /q*".into(),
                note: "Block Windows cmd silent recursive del".into(),
            },
            PermissionRule {
                id: "builtin-deny-win-rd-sq".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*rd /s /q*".into(),
                note: "Block Windows cmd silent recursive directory removal".into(),
            },
            PermissionRule {
                id: "builtin-gitguard-reset-hard".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*git reset --hard*".into(),
                note: "gitGuard: block destructive git reset --hard".into(),
            },
            PermissionRule {
                id: "builtin-gitguard-clean-fd".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*git clean -fd*".into(),
                note: "gitGuard: block destructive git clean -fd".into(),
            },
            PermissionRule {
                id: "builtin-gitguard-push-force".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*git push --force*".into(),
                note: "gitGuard: block destructive git push --force".into(),
            },
            PermissionRule {
                id: "builtin-gitguard-push-f".into(),
                scope: PermissionScope::Global,
                workspace_id: None,
                action: PermissionAction::Deny,
                tool: "bash".into(),
                match_pattern: "*git push -f*".into(),
                note: "gitGuard: block destructive git push -f".into(),
            },
        ]
    }

    #[must_use]
    pub fn evaluate(
        rules: &[PermissionRule],
        workspace_trusted: bool,
        tool: &str,
        target: &str,
        base_mode: ApprovalMode,
    ) -> PermissionEvalResult {
        let norm_target = target.replace('\\', "/");
        let file_name = std::path::Path::new(&norm_target)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        // Pass 1: DENY rules always win regardless of trust or approval mode.
        for rule in rules.iter().filter(|r| r.action == PermissionAction::Deny) {
            if rule_matches(rule, tool, &norm_target, &file_name) {
                return PermissionEvalResult {
                    decision: PermissionDecision::Deny,
                    matched_rule_id: Some(rule.id.clone()),
                    reason: format!(
                        "Denied by {:?} rule '{}' (tool={}, pattern={})",
                        rule.scope, rule.id, rule.tool, rule.match_pattern
                    ),
                    untrusted_override: false,
                };
            }
        }

        // Pass 2: ALLOW rules (workspace allow rules ignored when untrusted).
        let mut ignored_untrusted_allow = false;
        for rule in rules.iter().filter(|r| r.action == PermissionAction::Allow) {
            if !rule_matches(rule, tool, &norm_target, &file_name) {
                continue;
            }
            if rule.scope == PermissionScope::Workspace && !workspace_trusted {
                ignored_untrusted_allow = true;
                continue;
            }
            return PermissionEvalResult {
                decision: PermissionDecision::Allow,
                matched_rule_id: Some(rule.id.clone()),
                reason: format!("Allowed by {:?} rule '{}'", rule.scope, rule.id),
                untrusted_override: false,
            };
        }

        // Pass 3: Base approval mode fallback.
        let effective_mode = if !workspace_trusted
            && matches!(base_mode, ApprovalMode::Yolo | ApprovalMode::Write)
        {
            ApprovalMode::AlwaysAsk
        } else {
            base_mode
        };

        let is_read_tool = matches!(
            tool.to_ascii_lowercase().as_str(),
            "read" | "grep" | "find" | "ls" | "glob" | "git_status" | "git_diff" | "lsp"
        );
        let is_write_tool = matches!(
            tool.to_ascii_lowercase().as_str(),
            "write" | "edit" | "notebook" | "patch"
        );

        let decision = match effective_mode {
            ApprovalMode::Yolo => PermissionDecision::Allow,
            ApprovalMode::Write => {
                if is_read_tool || is_write_tool {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Ask
                }
            }
            ApprovalMode::Plan => {
                if is_read_tool {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Deny
                }
            }
            ApprovalMode::AlwaysAsk | ApprovalMode::AlwaysAskCached => {
                if is_read_tool {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Ask
                }
            }
        };

        let untrusted_override =
            ignored_untrusted_allow || (!workspace_trusted && effective_mode != base_mode);

        PermissionEvalResult {
            decision,
            matched_rule_id: None,
            reason: if untrusted_override {
                format!(
                    "Untrusted workspace enforces deny-only gate (downgraded {:?} -> {:?})",
                    base_mode, effective_mode
                )
            } else {
                format!("Resolved by base approval mode {:?}", effective_mode)
            },
            untrusted_override,
        }
    }
}

fn rule_matches(rule: &PermissionRule, tool: &str, norm_target: &str, file_name: &str) -> bool {
    let tool_pat = rule.tool.trim();
    if tool_pat.is_empty() {
        return false;
    }
    let tool_ok = tool_pat == "*"
        || tool_pat.eq_ignore_ascii_case(tool)
        || Pattern::new(&tool_pat.to_ascii_lowercase())
            .map(|p| p.matches(&tool.to_ascii_lowercase()))
            .unwrap_or(false);
    if !tool_ok {
        return false;
    }

    let pat_str = rule.match_pattern.trim().replace('\\', "/");
    if pat_str.is_empty() {
        return false;
    }
    if pat_str == "*" || pat_str == "**" {
        return true;
    }
    let case_insensitive = matches!(
        tool.to_ascii_lowercase().as_str(),
        "bash" | "shell" | "execute" | "terminal"
    ) || cfg!(windows);
    let pat_cmp = if case_insensitive {
        pat_str.to_ascii_lowercase()
    } else {
        pat_str.clone()
    };
    let target_cmp = if case_insensitive {
        norm_target.to_ascii_lowercase()
    } else {
        norm_target.to_string()
    };
    let file_cmp = if case_insensitive {
        file_name.to_ascii_lowercase()
    } else {
        file_name.to_string()
    };

    if let Ok(pat) = Pattern::new(&pat_cmp) {
        if pat.matches(&target_cmp) {
            return true;
        }
        if !pat_str.contains('/') && !file_cmp.is_empty() && pat.matches(&file_cmp) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_overrides_yolo_and_untrusted_ignores_workspace_allow() {
        let mut rules = PermissionsEngine::default_rules();
        rules.push(PermissionRule {
            id: "ws-allow-bash".into(),
            scope: PermissionScope::Workspace,
            workspace_id: Some("w1".into()),
            action: PermissionAction::Allow,
            tool: "bash".into(),
            match_pattern: "npm test*".into(),
            note: "repo test command".into(),
        });

        let r1 = PermissionsEngine::evaluate(
            &rules,
            true,
            "write",
            r"C:\repo\.env.local",
            ApprovalMode::Yolo,
        );
        assert_eq!(r1.decision, PermissionDecision::Deny);
        assert_eq!(r1.matched_rule_id.as_deref(), Some("builtin-deny-env"));

        let r2 = PermissionsEngine::evaluate(
            &rules,
            false,
            "bash",
            "npm test",
            ApprovalMode::AlwaysAsk,
        );
        assert_eq!(r2.decision, PermissionDecision::Ask);
        assert!(r2.untrusted_override);

        let r3 = PermissionsEngine::evaluate(
            &rules,
            true,
            "bash",
            "npm test",
            ApprovalMode::AlwaysAsk,
        );
        assert_eq!(r3.decision, PermissionDecision::Allow);
        assert_eq!(r3.matched_rule_id.as_deref(), Some("ws-allow-bash"));
    }

    #[test]
    fn approval_mode_parse_fails_closed_and_try_parse_rejects_typos() {
        assert_eq!(ApprovalMode::parse_flag("yollo"), ApprovalMode::AlwaysAsk);
        assert_eq!(ApprovalMode::parse_flag(""), ApprovalMode::AlwaysAsk);
        assert!(ApprovalMode::try_parse_flag("yollo").is_err());
        assert_eq!(ApprovalMode::try_parse_flag("yolo").unwrap(), ApprovalMode::Yolo);
        assert_eq!(ApprovalMode::try_parse_flag("plan").unwrap(), ApprovalMode::Plan);
    }
}
