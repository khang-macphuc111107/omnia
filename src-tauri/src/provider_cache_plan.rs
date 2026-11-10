//! Native-owned provider cache policy validation and plan identity.
//!
//! This module deliberately does not claim that local reuse is provider cache
//! evidence. It validates the renderer-authored policy while the input is
//! prepared, derives a content-free deterministic plan identity, and exposes
//! only the conservative controls that the installed adapters can prove.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    error::{NativeError, NativeResult},
    prepared_provider_input::FrozenProviderMessage,
};

pub const CACHE_POLICY_SCHEMA_VERSION: u32 = 1;
pub const CACHE_PLAN_ID_PREFIX: &str = "cache_plan_";

const MAX_POLICY_ID_BYTES: usize = 256;
const MAX_SCOPE_ID_BYTES: usize = 256;
const MAX_BREAKPOINTS: usize = 32;
const MAX_BREAKPOINT_BYTES: usize = 120;
const MAX_ALLOWED_OBJECT_KINDS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalCacheEncryption {
    NativeProfileKey,
    ProjectKey,
    DisabledByPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalCacheEviction {
    Lru,
    TtlLru,
    RecomputeCost,
    SensitivityAware,
    Custom,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalCacheResponseReuse {
    Disabled,
    ExactInputReview,
    FreshnessPolicyReview,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCacheMode {
    Disabled,
    Auto,
    Implicit,
    Explicit,
    ProviderDefault,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCacheKeyStrategy {
    ProviderDefault,
    ContentHash,
    ProjectRoute,
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCacheUnsupportedBehavior {
    SendUncached,
    LocalOptimize,
    Block,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderCacheWarmup {
    Disabled,
    OnFirstUse,
    Scheduled,
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CachePolicyScope {
    pub profile_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub provider_profile_id: Option<String>,
    #[serde(default)]
    pub model_profile_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalCachePolicy {
    pub enabled: bool,
    pub encryption: LocalCacheEncryption,
    pub max_bytes: u64,
    #[serde(default)]
    pub default_ttl_seconds: Option<u64>,
    pub eviction: LocalCacheEviction,
    pub allowed_object_kinds: Vec<String>,
    #[serde(default)]
    pub response_reuse: Option<LocalCacheResponseReuse>,
    #[serde(default)]
    pub secure_delete: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderNativeCachePolicy {
    pub mode: ProviderCacheMode,
    pub stable_prefix_planning: bool,
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
    #[serde(default)]
    pub cache_key_strategy: Option<ProviderCacheKeyStrategy>,
    #[serde(default)]
    pub cache_breakpoints: Vec<String>,
    pub unsupported_behavior: ProviderCacheUnsupportedBehavior,
    pub evidence_policy: String,
    #[serde(default)]
    pub warmup: Option<ProviderCacheWarmup>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCachePolicy {
    pub schema_version: u32,
    pub policy_id: String,
    pub revision_id: String,
    pub scope: CachePolicyScope,
    pub local: LocalCachePolicy,
    pub provider_native: ProviderNativeCachePolicy,
    #[serde(default)]
    pub data_classes_allowed: Vec<String>,
    #[serde(default)]
    pub metrics_enabled: Option<bool>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderCachePlan {
    pub policy_revision_id: String,
    pub plan_id: String,
    pub provider_family: String,
    pub stable_prefix_planning: bool,
    pub ttl_seconds: Option<u64>,
    pub cache_key_strategy: ProviderCacheKeyStrategy,
    pub unsupported_behavior: ProviderCacheUnsupportedBehavior,
    pub evidence_policy: String,
    pub explicit_anthropic_system: bool,
    pub explicit_anthropic_last_message: bool,
    pub explicit_anthropic_last_user: bool,
    pub anthropic_ttl: Option<String>,
    pub fallback_reason: Option<String>,
}

impl ProviderCachePolicy {
    pub fn validate(&self) -> NativeResult<()> {
        if self.schema_version != CACHE_POLICY_SCHEMA_VERSION {
            return Err(cache_invalid("schemaVersion", "must be 1"));
        }
        validate_bounded_text("policyId", &self.policy_id, MAX_POLICY_ID_BYTES)?;
        validate_bounded_text("revisionId", &self.revision_id, MAX_POLICY_ID_BYTES)?;
        validate_bounded_text(
            "scope.profileId",
            &self.scope.profile_id,
            MAX_SCOPE_ID_BYTES,
        )?;
        for (field, value) in [
            ("scope.projectId", self.scope.project_id.as_deref()),
            ("scope.workflowId", self.scope.workflow_id.as_deref()),
            (
                "scope.providerProfileId",
                self.scope.provider_profile_id.as_deref(),
            ),
            (
                "scope.modelProfileId",
                self.scope.model_profile_id.as_deref(),
            ),
        ] {
            if let Some(value) = value {
                validate_bounded_text(field, value, MAX_SCOPE_ID_BYTES)?;
            }
        }
        if self.local.allowed_object_kinds.len() > MAX_ALLOWED_OBJECT_KINDS {
            return Err(cache_invalid(
                "local.allowedObjectKinds",
                "contains too many object kinds",
            ));
        }
        for kind in &self.local.allowed_object_kinds {
            validate_bounded_text("local.allowedObjectKinds", kind, 80)?;
            if !matches!(
                kind.as_str(),
                "original"
                    | "extraction"
                    | "ocr"
                    | "thumbnail"
                    | "ast"
                    | "embedding"
                    | "summary"
                    | "retrieval"
                    | "compiled-context"
                    | "tool-result"
                    | "response"
            ) {
                return Err(cache_invalid(
                    "local.allowedObjectKinds",
                    "contains an unsupported object kind",
                ));
            }
        }
        if let Some(ttl) = self.local.default_ttl_seconds {
            if ttl == 0 {
                return Err(cache_invalid("local.defaultTtlSeconds", "must be positive"));
            }
        }
        if let Some(ttl) = self.provider_native.ttl_seconds {
            if ttl == 0 {
                return Err(cache_invalid(
                    "providerNative.ttlSeconds",
                    "must be positive",
                ));
            }
        }
        if self.provider_native.evidence_policy != "provider-reported-only" {
            return Err(cache_invalid(
                "providerNative.evidencePolicy",
                "must be provider-reported-only",
            ));
        }
        if self.provider_native.cache_breakpoints.len() > MAX_BREAKPOINTS {
            return Err(cache_invalid(
                "providerNative.cacheBreakpoints",
                "contains too many breakpoints",
            ));
        }
        for breakpoint in &self.provider_native.cache_breakpoints {
            validate_bounded_text(
                "providerNative.cacheBreakpoints",
                breakpoint,
                MAX_BREAKPOINT_BYTES,
            )?;
        }
        DateTime::parse_from_rfc3339(&self.created_at)
            .map_err(|_| cache_invalid("createdAt", "must be an RFC3339 timestamp"))?;
        Ok(())
    }
}

impl ProviderCachePlan {
    pub fn compile_from_parameters_json(
        parameters_json: &str,
        provider_profile_id: &str,
        model: &str,
        input_content_sha256: &str,
        provider_type: &str,
        messages: &[FrozenProviderMessage],
    ) -> NativeResult<Option<Self>> {
        let value: Value = serde_json::from_str(parameters_json)
            .map_err(|_| cache_invalid("parameters", "must be valid JSON"))?;
        let Some(raw_policy) = value.get("cachePolicy") else {
            return Ok(None);
        };
        let policy: ProviderCachePolicy =
            serde_json::from_value(raw_policy.clone()).map_err(|_| {
                cache_invalid("cachePolicy", "does not match the native policy contract")
            })?;
        policy.validate()?;
        if let Some(scope_provider) = policy.scope.provider_profile_id.as_deref() {
            if scope_provider != provider_profile_id {
                return Err(cache_invalid(
                    "cachePolicy.scope.providerProfileId",
                    "does not match the prepared provider profile",
                ));
            }
        }
        let provider_family = normalize_provider_family(provider_type);
        let has_system = messages
            .iter()
            .any(|message| matches!(message.role.as_str(), "system" | "developer"));
        let message_count = messages
            .iter()
            .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
            .count();
        let has_user = messages.iter().any(|message| message.role == "user");
        Ok(Some(Self::compile(
            &policy,
            provider_profile_id,
            model,
            input_content_sha256,
            &provider_family,
            has_system,
            message_count,
            has_user,
        )?))
    }

    #[allow(clippy::too_many_arguments)] // mirrors the persisted record layout; bundling into a struct would be a larger refactor
    pub fn compile(
        policy: &ProviderCachePolicy,
        provider_profile_id: &str,
        model: &str,
        input_content_sha256: &str,
        provider_family: &str,
        has_system: bool,
        message_count: usize,
        has_user: bool,
    ) -> NativeResult<Self> {
        policy.validate()?;
        let native = &policy.provider_native;
        let key_strategy = native
            .cache_key_strategy
            .clone()
            .unwrap_or(ProviderCacheKeyStrategy::ProviderDefault);
        let mut explicit_anthropic_system = false;
        let mut explicit_anthropic_last_message = false;
        let mut explicit_anthropic_last_user = false;
        let mut anthropic_ttl = None;
        let mut fallback_reason = None;

        let explicit_requested = matches!(native.mode, ProviderCacheMode::Explicit)
            || !native.cache_breakpoints.is_empty()
            || native.ttl_seconds.is_some()
            || !matches!(key_strategy, ProviderCacheKeyStrategy::ProviderDefault);

        if matches!(native.mode, ProviderCacheMode::Disabled) {
            fallback_reason = Some("disabled-by-policy".to_owned());
        } else if provider_family == "anthropic" {
            if explicit_requested {
                let requests_last_message = native
                    .cache_breakpoints
                    .iter()
                    .any(|breakpoint| breakpoint == "last-message");
                let requests_last_user = native
                    .cache_breakpoints
                    .iter()
                    .any(|breakpoint| breakpoint == "last-user");
                if requests_last_message && requests_last_user {
                    return unsupported(
                        policy,
                        provider_profile_id,
                        model,
                        input_content_sha256,
                        provider_family,
                        has_system,
                        message_count,
                        has_user,
                        "Anthropic cache breakpoints last-message and last-user cannot be combined"
                            .to_owned(),
                    );
                }
                for breakpoint in &native.cache_breakpoints {
                    match breakpoint.as_str() {
                        "system" if has_system => explicit_anthropic_system = true,
                        "last-message" if message_count > 0 => {
                            explicit_anthropic_last_message = true
                        }
                        "last-user" if message_count > 0 && has_user => {
                            explicit_anthropic_last_message = true;
                            explicit_anthropic_last_user = true;
                        }
                        _ => {
                            return unsupported(
                                policy,
                                provider_profile_id,
                                model,
                                input_content_sha256,
                                provider_family,
                                has_system,
                                message_count,
                                has_user,
                                format!("unsupported Anthropic cache breakpoint: {breakpoint}"),
                            )
                        }
                    }
                }
                if native.cache_breakpoints.is_empty() {
                    return unsupported(
                        policy,
                        provider_profile_id,
                        model,
                        input_content_sha256,
                        provider_family,
                        has_system,
                        message_count,
                        has_user,
                        "explicit Anthropic caching requires at least one known breakpoint"
                            .to_owned(),
                    );
                }
                if let Some(ttl) = native.ttl_seconds {
                    anthropic_ttl = match ttl {
                        300 => Some("5m".to_owned()),
                        3_600 => Some("1h".to_owned()),
                        _ => {
                            return unsupported(
                                policy,
                                provider_profile_id,
                                model,
                                input_content_sha256,
                                provider_family,
                                has_system,
                                message_count,
                                has_user,
                                "Anthropic supports only the documented 5m or 1h cache TTL in this adapter"
                                    .to_owned(),
                            )
                        }
                    };
                }
                if !matches!(key_strategy, ProviderCacheKeyStrategy::ProviderDefault) {
                    return unsupported(
                        policy,
                        provider_profile_id,
                        model,
                        input_content_sha256,
                        provider_family,
                        has_system,
                        message_count,
                        has_user,
                        "Anthropic cache-key strategies are provider-managed in this adapter"
                            .to_owned(),
                    );
                }
            }
        } else if explicit_requested {
            return unsupported(
                policy,
                provider_profile_id,
                model,
                input_content_sha256,
                provider_family,
                has_system,
                message_count,
                has_user,
                format!(
                    "explicit provider cache controls are not capability-verified for {provider_family}"
                ),
            );
        }

        let material = serde_json::json!({
            "schemaVersion": CACHE_POLICY_SCHEMA_VERSION,
            "policy": policy,
            "providerProfileId": provider_profile_id,
            "model": model,
            "inputContentSha256": input_content_sha256,
            "providerFamily": provider_family,
            "stablePrefixPlanning": native.stable_prefix_planning,
            "explicitAnthropicSystem": explicit_anthropic_system,
            "explicitAnthropicLastMessage": explicit_anthropic_last_message,
            "explicitAnthropicLastUser": explicit_anthropic_last_user,
            "anthropicTtl": anthropic_ttl,
            "fallbackReason": fallback_reason,
        });
        let bytes = serde_json::to_vec(&material).map_err(|_| {
            NativeError::new(
                "cache_plan_integrity_failed",
                "The provider cache plan could not be canonicalized",
            )
        })?;
        let digest = Sha256::digest(bytes);
        let plan_id = format!("{CACHE_PLAN_ID_PREFIX}{digest:x}");
        Ok(Self {
            policy_revision_id: policy.revision_id.clone(),
            plan_id,
            provider_family: provider_family.to_owned(),
            stable_prefix_planning: native.stable_prefix_planning,
            ttl_seconds: native.ttl_seconds,
            cache_key_strategy: key_strategy,
            unsupported_behavior: native.unsupported_behavior.clone(),
            evidence_policy: native.evidence_policy.clone(),
            explicit_anthropic_system,
            explicit_anthropic_last_message,
            explicit_anthropic_last_user,
            anthropic_ttl,
            fallback_reason,
        })
    }
}

#[allow(clippy::too_many_arguments)] // mirrors the persisted record layout; bundling into a struct would be a larger refactor
fn unsupported(
    policy: &ProviderCachePolicy,
    provider_profile_id: &str,
    model: &str,
    input_content_sha256: &str,
    provider_family: &str,
    has_system: bool,
    message_count: usize,
    has_user: bool,
    reason: String,
) -> NativeResult<ProviderCachePlan> {
    match policy.provider_native.unsupported_behavior {
        ProviderCacheUnsupportedBehavior::Block => Err(NativeError::new(
            "cache_policy_unsupported",
            "The provider cache policy requests a control that this native adapter cannot verify",
        )),
        ProviderCacheUnsupportedBehavior::SendUncached
        | ProviderCacheUnsupportedBehavior::LocalOptimize => {
            // Re-run compilation with a policy that disables unsupported
            // controls. This preserves a deterministic plan identity while
            // making the fallback explicit and safe.
            let mut fallback = policy.clone();
            fallback.provider_native.mode = ProviderCacheMode::Disabled;
            fallback.provider_native.ttl_seconds = None;
            fallback.provider_native.cache_breakpoints.clear();
            fallback.provider_native.cache_key_strategy =
                Some(ProviderCacheKeyStrategy::ProviderDefault);
            let mut plan = ProviderCachePlan::compile(
                &fallback,
                provider_profile_id,
                model,
                input_content_sha256,
                provider_family,
                has_system,
                message_count,
                has_user,
            )?;
            plan.policy_revision_id = policy.revision_id.clone();
            plan.fallback_reason = Some(reason);
            // The fallback plan must remain bound to the original frozen
            // provider/model/input material.  Recompute its identity after
            // attaching the reason so two different unsupported requests do
            // not collapse to the same opaque plan id.
            let material = serde_json::json!({
                "schemaVersion": CACHE_POLICY_SCHEMA_VERSION,
                "policyRevisionId": plan.policy_revision_id,
                "providerProfileId": provider_profile_id,
                "model": model,
                "inputContentSha256": input_content_sha256,
                "providerFamily": provider_family,
                "stablePrefixPlanning": plan.stable_prefix_planning,
                "fallbackReason": plan.fallback_reason,
            });
            let bytes = serde_json::to_vec(&material).map_err(|_| {
                NativeError::new(
                    "cache_plan_integrity_failed",
                    "The fallback provider cache plan could not be canonicalized",
                )
            })?;
            plan.plan_id = format!("{CACHE_PLAN_ID_PREFIX}{:x}", Sha256::digest(bytes));
            Ok(plan)
        }
    }
}

pub fn normalize_provider_family(provider_type: &str) -> String {
    match provider_type
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .as_str()
    {
        "openai" => "openai_responses".to_owned(),
        "deepseek" | "openai_compatible" | "local" => "openai_compatible".to_owned(),
        "anthropic" => "anthropic".to_owned(),
        "gemini" | "google" | "google_gemini" => "gemini".to_owned(),
        other => other.to_owned(),
    }
}

fn validate_bounded_text(field: &'static str, value: &str, max_bytes: usize) -> NativeResult<()> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(cache_invalid(
            field,
            "must be bounded, nonempty, and control-free",
        ));
    }
    Ok(())
}

fn cache_invalid(field: &'static str, reason: impl Into<String>) -> NativeError {
    NativeError::new("invalid_cache_policy", format!("{field} {}", reason.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepared_provider_input::FrozenProviderMessage;

    fn policy(
        mode: ProviderCacheMode,
        behavior: ProviderCacheUnsupportedBehavior,
    ) -> ProviderCachePolicy {
        ProviderCachePolicy {
            schema_version: 1,
            policy_id: "cache_policy_demo".to_owned(),
            revision_id: "cache_revision_demo".to_owned(),
            scope: CachePolicyScope {
                profile_id: "profile_default".to_owned(),
                project_id: None,
                workflow_id: None,
                provider_profile_id: Some("provider_0123456789abcdef0123456789abcdef".to_owned()),
                model_profile_id: None,
            },
            local: LocalCachePolicy {
                enabled: true,
                encryption: LocalCacheEncryption::NativeProfileKey,
                max_bytes: 1024,
                default_ttl_seconds: None,
                eviction: LocalCacheEviction::Lru,
                allowed_object_kinds: vec!["compiled-context".to_owned()],
                response_reuse: None,
                secure_delete: None,
            },
            provider_native: ProviderNativeCachePolicy {
                mode,
                stable_prefix_planning: true,
                ttl_seconds: None,
                cache_key_strategy: None,
                cache_breakpoints: vec![],
                unsupported_behavior: behavior,
                evidence_policy: "provider-reported-only".to_owned(),
                warmup: None,
            },
            data_classes_allowed: vec!["public".to_owned()],
            metrics_enabled: None,
            created_at: "2026-01-01T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn policy_rejects_non_provider_evidence() {
        let mut value = policy(
            ProviderCacheMode::Auto,
            ProviderCacheUnsupportedBehavior::LocalOptimize,
        );
        value.provider_native.evidence_policy = "local-estimate".to_owned();
        assert_eq!(value.validate().unwrap_err().code, "invalid_cache_policy");
    }

    #[test]
    fn anthropic_plan_is_deterministic_and_supports_known_breakpoints() {
        let mut value = policy(
            ProviderCacheMode::Explicit,
            ProviderCacheUnsupportedBehavior::Block,
        );
        value.provider_native.cache_breakpoints =
            vec!["system".to_owned(), "last-message".to_owned()];
        value.provider_native.ttl_seconds = Some(3_600);
        let messages = vec![
            FrozenProviderMessage {
                role: "system".to_owned(),
                content: "stable".to_owned(),
            },
            FrozenProviderMessage {
                role: "user".to_owned(),
                content: "dynamic".to_owned(),
            },
        ];
        let parameters = serde_json::json!({"cachePolicy": value}).to_string();
        let first = ProviderCachePlan::compile_from_parameters_json(
            &parameters,
            "provider_0123456789abcdef0123456789abcdef",
            "claude-sonnet",
            &"a".repeat(64),
            "anthropic",
            &messages,
        )
        .unwrap()
        .unwrap();
        assert!(first.plan_id.starts_with(CACHE_PLAN_ID_PREFIX));
        assert!(first.explicit_anthropic_system);
        assert!(first.explicit_anthropic_last_message);
        assert_eq!(first.anthropic_ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn unsupported_openai_explicit_controls_can_fall_back_to_uncached() {
        let mut value = policy(
            ProviderCacheMode::Explicit,
            ProviderCacheUnsupportedBehavior::SendUncached,
        );
        value.provider_native.cache_breakpoints = vec!["system".to_owned()];
        let messages = vec![FrozenProviderMessage {
            role: "user".to_owned(),
            content: "hello".to_owned(),
        }];
        let plan = ProviderCachePlan::compile_from_parameters_json(
            &serde_json::json!({"cachePolicy": value}).to_string(),
            "provider_0123456789abcdef0123456789abcdef",
            "gpt",
            &"b".repeat(64),
            "openai",
            &messages,
        )
        .unwrap()
        .unwrap();
        assert!(plan.fallback_reason.is_some());
        assert!(!plan.explicit_anthropic_system);
    }

    #[test]
    fn unsupported_fallback_plan_identity_binds_provider_model_and_input() {
        let mut value = policy(
            ProviderCacheMode::Explicit,
            ProviderCacheUnsupportedBehavior::SendUncached,
        );
        value.provider_native.cache_breakpoints = vec!["system".to_owned()];
        let messages = vec![FrozenProviderMessage {
            role: "user".to_owned(),
            content: "hello".to_owned(),
        }];
        let parameters = serde_json::json!({"cachePolicy": value}).to_string();
        let first = ProviderCachePlan::compile_from_parameters_json(
            &parameters,
            "provider_0123456789abcdef0123456789abcdef",
            "gpt-a",
            &"a".repeat(64),
            "openai",
            &messages,
        )
        .unwrap()
        .unwrap();
        // The policy scope is bound to the prepared provider profile, so the
        // provider-changed plan needs a policy scoped to that other provider.
        let mut other_provider_policy = value.clone();
        other_provider_policy.scope.provider_profile_id =
            Some("provider_ffffffffffffffffffffffffffffffff".to_owned());
        let other_provider_parameters =
            serde_json::json!({"cachePolicy": other_provider_policy}).to_string();
        let provider_changed = ProviderCachePlan::compile_from_parameters_json(
            &other_provider_parameters,
            "provider_ffffffffffffffffffffffffffffffff",
            "gpt-a",
            &"a".repeat(64),
            "openai",
            &messages,
        )
        .unwrap()
        .unwrap();
        let model_changed = ProviderCachePlan::compile_from_parameters_json(
            &parameters,
            "provider_0123456789abcdef0123456789abcdef",
            "gpt-b",
            &"a".repeat(64),
            "openai",
            &messages,
        )
        .unwrap()
        .unwrap();
        let input_changed = ProviderCachePlan::compile_from_parameters_json(
            &parameters,
            "provider_0123456789abcdef0123456789abcdef",
            "gpt-a",
            &"b".repeat(64),
            "openai",
            &messages,
        )
        .unwrap()
        .unwrap();

        assert_ne!(first.plan_id, provider_changed.plan_id);
        assert_ne!(first.plan_id, model_changed.plan_id);
        assert_ne!(first.plan_id, input_changed.plan_id);
    }

    #[test]
    fn anthropic_rejects_combined_last_message_and_last_user_breakpoints() {
        let mut value = policy(
            ProviderCacheMode::Explicit,
            ProviderCacheUnsupportedBehavior::Block,
        );
        value.provider_native.cache_breakpoints =
            vec!["last-message".to_owned(), "last-user".to_owned()];
        let messages = vec![
            FrozenProviderMessage {
                role: "user".to_owned(),
                content: "question".to_owned(),
            },
            FrozenProviderMessage {
                role: "assistant".to_owned(),
                content: "answer".to_owned(),
            },
        ];
        let error = ProviderCachePlan::compile_from_parameters_json(
            &serde_json::json!({"cachePolicy": value}).to_string(),
            "provider_0123456789abcdef0123456789abcdef",
            "claude-sonnet",
            &"a".repeat(64),
            "anthropic",
            &messages,
        )
        .expect_err("overlapping message breakpoints must not be silently dropped");
        assert_eq!(error.code, "cache_policy_unsupported");
    }
}
