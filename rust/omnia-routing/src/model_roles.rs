//! Model role definitions (`main`, `architect`, `fast`, `advisor`, `verifier`, `fast_apply`),
//! adaptive reasoning effort (`none`..`max`) ported from `htmustc-proxy`, and OpenCode-style
//! cross-model cryptographic proof scoping for thinking signatures and encrypted reasoning.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::str::FromStr;

/// Canonical functional model roles used across `omnia-agent`, `swarm_runtime`,
/// `test_time_scaling`, `omnia-notebook`, and `omnia-studio`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    Main,
    Architect,
    Fast,
    Advisor,
    Verifier,
    FastApply,
}

impl ModelRole {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Architect => "architect",
            Self::Fast => "fast",
            Self::Advisor => "advisor",
            Self::Verifier => "verifier",
            Self::FastApply => "fast_apply",
        }
    }

    /// All six supported Omnia v5 model roles in canonical order.
    pub const ALL: [ModelRole; 6] = [
        Self::Main,
        Self::Architect,
        Self::Fast,
        Self::Advisor,
        Self::Verifier,
        Self::FastApply,
    ];
}

impl fmt::Display for ModelRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ModelRole {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "main" | "default" | "primary" | "coder" => Ok(Self::Main),
            "architect" | "planner" | "design" => Ok(Self::Architect),
            "fast" | "quick" | "haiku" | "flash" | "mini" => Ok(Self::Fast),
            "advisor" | "oracle" | "consult" => Ok(Self::Advisor),
            "verifier" | "reviewer" | "critic" | "audit" => Ok(Self::Verifier),
            "fast_apply" | "fastapply" | "apply" | "edit" => Ok(Self::FastApply),
            other => Err(format!("unknown model role '{other}'")),
        }
    }
}

/// Ordered reasoning effort levels (unlocked through `max` per OpenCode & htmustc-proxy).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffortLevel {
    None = 0,
    Minimal = 1,
    Low = 2,
    Medium = 3,
    High = 4,
    XHigh = 5,
    Max = 6,
}

impl EffortLevel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    #[must_use]
    pub const fn budget_tokens(self) -> u64 {
        match self {
            Self::None => 0,
            Self::Minimal => 1_024,
            Self::Low => 4_096,
            Self::Medium => 12_288,
            Self::High => 24_576,
            Self::XHigh => 32_768,
            Self::Max => 64_000,
        }
    }
}

impl fmt::Display for EffortLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for EffortLevel {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" | "off" | "disabled" => Ok(Self::None),
            "minimal" | "min" => Ok(Self::Minimal),
            "low" => Ok(Self::Low),
            "medium" | "med" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" | "extra_high" | "extra-high" => Ok(Self::XHigh),
            "max" | "maximum" => Ok(Self::Max),
            other => Err(format!("unknown reasoning effort '{other}'")),
        }
    }
}

/// Wire spelling mode for model reasoning effort (`htmustc-proxy/internal/providers/effort.go`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffortWireMode {
    None,
    Levels,
    Budget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEffortSpec {
    pub mode: EffortWireMode,
    pub supported: Vec<EffortLevel>,
    pub default_level: Option<EffortLevel>,
    pub claude_adaptive: bool,
    pub min_budget: u64,
    pub max_budget: u64,
}

/// Normalize a model ID for family matching (`gpt-6.2-sol` -> `gpt-6-2-sol`).
#[must_use]
pub fn normalize_model_family_key(model_id: &str) -> String {
    let bare = model_id
        .rsplit('/')
        .next()
        .unwrap_or(model_id)
        .trim()
        .to_ascii_lowercase();
    let stripped = match bare.find('(') {
        Some(idx) if idx > 0 => bare[..idx].trim(),
        _ => bare.as_str(),
    };
    let stripped = stripped
        .strip_suffix("-review")
        .or_else(|| stripped.strip_suffix("-tiered"))
        .unwrap_or(stripped);
    stripped.replace('.', "-")
}

/// Lookup model effort capabilities matching live verified `htmustc-proxy` calibration.
/// All reasoning-capable families default to their highest supported effort (`max` -> clamped).
#[must_use]
pub fn effort_spec_for_model(model_id: &str) -> ModelEffortSpec {
    let key = normalize_model_family_key(model_id);
    let no_effort = || ModelEffortSpec {
        mode: EffortWireMode::None,
        supported: Vec::new(),
        default_level: None,
        claude_adaptive: false,
        min_budget: 0,
        max_budget: 0,
    };
    if matches!(key.as_str(), "" | "grok-4" | "grok-3" | "kimi-k2" | "deepseek") {
        return no_effort();
    }
    if key.starts_with("gpt-image")
        || key.starts_with("gpt-4")
        || key.starts_with("gpt-3")
        || key.starts_with("chatgpt")
        || key.starts_with("gpt-oss")
        || key.starts_with("gemini-2-0")
        || key.starts_with("gemma")
        || key.starts_with("deepseek-v4-flash")
        || key.starts_with("deepseek-reasoner")
        || key.starts_with("deepseek-chat")
        || key.starts_with("grok-code-fast")
        || key.starts_with("grok-4-fast")
        || key.starts_with("grok-2")
        || key.starts_with("grok-build")
        || key.starts_with("grok-imagine")
        || key.starts_with("whisper")
        || key.starts_with("scribe")
        || key.starts_with("eleven")
        || key.starts_with("aura")
        || key.starts_with("nova")
    {
        return no_effort();
    }
    if key.starts_with("gpt-6") || key.starts_with("gpt-5-6") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::None,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
                EffortLevel::Max,
            ],
            default_level: Some(EffortLevel::Max),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gpt-5-5") || key.starts_with("gpt-5-2") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::None,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
            ],
            default_level: Some(EffortLevel::XHigh),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gpt-5-4")
        || key.starts_with("gpt-5-3")
        || key.starts_with("codex-auto-review")
    {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
            ],
            default_level: Some(EffortLevel::XHigh),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gpt-5-1") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::None,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
            ],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gpt-5") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Minimal,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
            ],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("o1") || key.starts_with("o3") || key.starts_with("o4") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![EffortLevel::Low, EffortLevel::Medium, EffortLevel::High],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("claude-opus-5")
        || key.starts_with("claude-sonnet-5")
        || key.starts_with("claude-fable-5")
        || key.starts_with("claude-haiku-5")
        || key.starts_with("claude-opus-4-7")
        || key.starts_with("claude-opus-4-8")
    {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
                EffortLevel::Max,
            ],
            default_level: Some(EffortLevel::Max),
            claude_adaptive: true,
            min_budget: 1_024,
            max_budget: 128_000,
        };
    }
    if key.starts_with("claude-opus-4-6") || key.starts_with("claude-sonnet-4-6") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::Max,
            ],
            default_level: Some(EffortLevel::Max),
            claude_adaptive: true,
            min_budget: 1_024,
            max_budget: 128_000,
        };
    }
    if key.starts_with("claude-opus-4")
        || key.starts_with("claude-sonnet-4")
        || key.starts_with("claude-haiku-4")
        || key.starts_with("claude-3-7")
    {
        return ModelEffortSpec {
            mode: EffortWireMode::Budget,
            supported: vec![
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
            ],
            default_level: Some(EffortLevel::XHigh),
            claude_adaptive: false,
            min_budget: 1_024,
            max_budget: 128_000,
        };
    }
    if key.starts_with("claude-3") {
        return no_effort();
    }
    if key.starts_with("gemini-3-1-pro") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![EffortLevel::Low, EffortLevel::Medium, EffortLevel::High],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gemini-3-1-flash-lite") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Minimal,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
            ],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gemini-3-1-flash") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![EffortLevel::Minimal, EffortLevel::High],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gemini-3-pro") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![EffortLevel::Low, EffortLevel::High],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gemini-4") || key.starts_with("gemini-3") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Minimal,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
            ],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("gemini-2-5-pro") {
        return ModelEffortSpec {
            mode: EffortWireMode::Budget,
            supported: vec![
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
            ],
            default_level: Some(EffortLevel::XHigh),
            claude_adaptive: false,
            min_budget: 128,
            max_budget: 32_768,
        };
    }
    if key.starts_with("gemini-2-5") {
        return ModelEffortSpec {
            mode: EffortWireMode::Budget,
            supported: vec![
                EffortLevel::None,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
            ],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 128,
            max_budget: 24_576,
        };
    }
    if key.starts_with("deepseek-v4-pro") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![EffortLevel::None, EffortLevel::Max],
            default_level: Some(EffortLevel::Max),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("kimi-k3")
        || key.starts_with("k3")
        || key.starts_with("kimi-k2-7")
        || key.starts_with("kimi-k2-6")
        || key.starts_with("kimi-k2-5")
        || key.starts_with("kimi-k2-t")
    {
        return ModelEffortSpec {
            mode: EffortWireMode::Budget,
            supported: vec![EffortLevel::Low, EffortLevel::Medium, EffortLevel::High],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 1_024,
            max_budget: 32_000,
        };
    }
    if key.starts_with("grok-4-5") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
                EffortLevel::XHigh,
            ],
            default_level: Some(EffortLevel::XHigh),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("grok-3-mini") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![EffortLevel::Low, EffortLevel::High],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    if key.starts_with("glm-5") || key.starts_with("qwen3") {
        return ModelEffortSpec {
            mode: EffortWireMode::Levels,
            supported: vec![
                EffortLevel::None,
                EffortLevel::Low,
                EffortLevel::Medium,
                EffortLevel::High,
            ],
            default_level: Some(EffortLevel::High),
            claude_adaptive: false,
            min_budget: 0,
            max_budget: 0,
        };
    }
    no_effort()
}

/// Clamp `requested` down to the nearest lower supported level on `spec` (preserving exact match).
#[must_use]
pub fn clamp_effort_for_model(model_id: &str, requested: EffortLevel) -> Option<EffortLevel> {
    let spec = effort_spec_for_model(model_id);
    if spec.mode == EffortWireMode::None || spec.supported.is_empty() {
        return None;
    }
    if spec.supported.contains(&requested) {
        return Some(requested);
    }
    spec.supported
        .iter()
        .copied()
        .filter(|&lvl| lvl <= requested)
        .max()
        .or_else(|| spec.supported.first().copied())
}

/// Apply reasoning effort to an outbound JSON body according to dialect & model capabilities.
/// Supports OpenAI `reasoning_effort`, OpenAI Responses `reasoning.effort` (including `max`),
/// Anthropic adaptive thinking + `output_config.effort` (`max`) or budget-capped thinking (`< max_tokens`),
/// and Gemini `generationConfig.thinkingConfig`.
pub fn apply_reasoning_effort_wire(
    body: &mut Value,
    dialect: &str,
    model_id: &str,
    requested: EffortLevel,
    max_tokens_opt: Option<u64>,
) {
    let spec = effort_spec_for_model(model_id);
    let Some(level) = clamp_effort_for_model(model_id, requested) else {
        return;
    };
    let Some(obj) = body.as_object_mut() else {
        return;
    };

    match dialect {
        "openai-responses" => {
            if level == EffortLevel::None {
                obj.insert("reasoning".into(), json!({ "effort": "none" }));
            } else {
                obj.insert(
                    "reasoning".into(),
                    json!({ "effort": level.as_str(), "summary": "auto" }),
                );
            }
        }
        "openai-completions" => {
            obj.insert("reasoning_effort".into(), json!(level.as_str()));
        }
        "anthropic-messages" => {
            if level == EffortLevel::None {
                obj.insert("thinking".into(), json!({ "type": "disabled" }));
                obj.remove("output_config");
                return;
            }
            if spec.claude_adaptive && spec.mode == EffortWireMode::Levels {
                obj.insert("thinking".into(), json!({ "type": "adaptive" }));
                let out_cfg = obj.entry("output_config").or_insert_with(|| json!({}));
                if let Some(oc) = out_cfg.as_object_mut() {
                    oc.insert("effort".into(), json!(level.as_str()));
                }
            } else {
                let ceiling = max_tokens_opt
                    .filter(|&mt| mt > 1024)
                    .map(|mt| (mt - 1024).min(spec.max_budget.max(32_768)))
                    .unwrap_or(32_768);
                let budget = level.budget_tokens().min(ceiling);
                if budget >= 1_024 {
                    obj.insert(
                        "thinking".into(),
                        json!({ "type": "enabled", "budget_tokens": budget }),
                    );
                }
                obj.remove("output_config");
            }
        }
        "gemini" => {
            let gen_cfg = obj.entry("generationConfig").or_insert_with(|| json!({}));
            if let Some(gc) = gen_cfg.as_object_mut() {
                let tc = gc.entry("thinkingConfig").or_insert_with(|| json!({}));
                if let Some(tco) = tc.as_object_mut() {
                    tco.remove("thinking_budget");
                    tco.remove("thinking_level");
                    if spec.mode == EffortWireMode::Budget {
                        tco.remove("thinkingLevel");
                        let budget = level.budget_tokens().clamp(spec.min_budget, spec.max_budget);
                        tco.insert("thinkingBudget".into(), json!(budget));
                    } else {
                        tco.remove("thinkingBudget");
                        tco.insert("thinkingLevel".into(), json!(level.as_str().to_ascii_uppercase()));
                    }
                    tco.entry("includeThoughts")
                        .or_insert_with(|| json!(level != EffortLevel::None));
                }
            }
        }
        _ => {}
    }
}

/// Cross-Model Cryptographic Proof Scoping (ported from `opencode/packages/core/src/session/runner/to-llm-message.ts`).
/// Cryptographic thinking signatures, `redacted_thinking`, and OpenAI encrypted reasoning items
/// MUST ONLY be replayed when targeting the exact same `(provider, model)` on an untainted/non-error message.
#[must_use]
pub fn can_replay_cryptographic_proof(
    origin_provider: Option<&str>,
    origin_model: Option<&str>,
    target_provider: &str,
    target_model: &str,
    message_has_error: bool,
    reasoning_interrupted: bool,
) -> bool {
    if message_has_error || reasoning_interrupted {
        return false;
    }
    let Some(orig_m) = origin_model.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let same_model = normalize_model_family_key(orig_m) == normalize_model_family_key(target_model);
    if !same_model {
        return false;
    }
    match origin_provider.map(str::trim).filter(|s| !s.is_empty()) {
        Some(orig_p) => orig_p.eq_ignore_ascii_case(target_provider.trim()),
        None => true,
    }
}

/// Compute non-fabricated role suitability tie-break weight from intrinsic model family capabilities
/// (never synthetic latency/quota scores; used purely as capability affinity when candidate metrics tie).
#[must_use]
pub fn intrinsic_role_affinity(role: ModelRole, model_id: &str) -> f64 {
    let key = normalize_model_family_key(model_id);
    let is_gpt6_or_5 = key.starts_with("gpt-6") || key.starts_with("gpt-5");
    let is_claude5_or_opus4 =
        key.starts_with("claude-opus-5") || key.starts_with("claude-sonnet-5") || key.starts_with("claude-opus-4");
    let is_fast_tier = key.contains("flash") || key.contains("haiku") || key.contains("mini") || key.contains("nano");
    let is_gemini = key.starts_with("gemini");

    match role {
        ModelRole::Main => {
            if is_gpt6_or_5 || is_claude5_or_opus4 {
                10.0
            } else if key.starts_with("claude-") {
                8.0
            } else if is_gemini {
                5.0
            } else {
                3.0
            }
        }
        ModelRole::Architect | ModelRole::Advisor => {
            if key.starts_with("claude-opus-5") || key.starts_with("gpt-6") {
                12.0
            } else if is_claude5_or_opus4 || is_gpt6_or_5 {
                9.5
            } else {
                4.0
            }
        }
        ModelRole::Verifier => {
            if is_claude5_or_opus4 || is_gpt6_or_5 {
                11.0
            } else {
                4.5
            }
        }
        ModelRole::Fast | ModelRole::FastApply => {
            if is_fast_tier && !is_gemini {
                10.0
            } else if key.contains("sonnet") || key.starts_with("gpt-5-4") || key.starts_with("gpt-6") {
                7.5
            } else if is_fast_tier {
                6.5
            } else {
                4.0
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_clamps_max_for_gpt6_and_claude5_and_applies_wire_shape() {
        assert_eq!(clamp_effort_for_model("gpt-6.2-sol", EffortLevel::Max), Some(EffortLevel::Max));
        assert_eq!(clamp_effort_for_model("gpt-5.5", EffortLevel::Max), Some(EffortLevel::XHigh));
        assert_eq!(
            clamp_effort_for_model("claude-sonnet-5-5", EffortLevel::Max),
            Some(EffortLevel::Max)
        );

        let mut ant = json!({ "model": "claude-sonnet-5-5", "max_tokens": 32768 });
        apply_reasoning_effort_wire(&mut ant, "anthropic-messages", "claude-sonnet-5-5", EffortLevel::Max, Some(32768));
        assert_eq!(ant["thinking"]["type"], "adaptive");
        assert_eq!(ant["output_config"]["effort"], "max");

        let mut resp = json!({ "model": "gpt-6.2-sol" });
        apply_reasoning_effort_wire(&mut resp, "openai-responses", "gpt-6.2-sol", EffortLevel::Max, None);
        assert_eq!(resp["reasoning"]["effort"], "max");

        // Steer #16: Default effort across reasoning families is max (clamped per model),
        // and non-reasoning models omit effort parameters cleanly with zero 400 risk.
        assert_eq!(effort_spec_for_model("gpt-6.2-sol").default_level, Some(EffortLevel::Max));
        assert_eq!(effort_spec_for_model("claude-sonnet-5-5").default_level, Some(EffortLevel::Max));
        assert_eq!(effort_spec_for_model("claude-opus-5-5").default_level, Some(EffortLevel::Max));
        assert_eq!(effort_spec_for_model("deepseek-v4-pro").default_level, Some(EffortLevel::Max));
        assert_eq!(effort_spec_for_model("gemini-4-carbon").default_level, Some(EffortLevel::High));
        assert_eq!(effort_spec_for_model("gemini-3.8-flash").default_level, Some(EffortLevel::High));
        assert_eq!(effort_spec_for_model("kimi-k3.1-pro").default_level, Some(EffortLevel::High));
        assert_eq!(effort_spec_for_model("glm-5.3").default_level, Some(EffortLevel::High));
        assert_eq!(effort_spec_for_model("qwen3.8-max").default_level, Some(EffortLevel::High));
        assert_eq!(effort_spec_for_model("grok-4.5").default_level, Some(EffortLevel::XHigh));
        for no_eff in ["gpt-4o", "gpt-image-2", "deepseek-v4-flash", "kimi-k2", "whisper-1"] {
            assert_eq!(effort_spec_for_model(no_eff).default_level, None, "{no_eff}");
            let mut b = json!({ "model": no_eff });
            apply_reasoning_effort_wire(&mut b, "openai-completions", no_eff, EffortLevel::Max, None);
            assert!(b.get("reasoning_effort").is_none(), "{no_eff} must omit reasoning_effort");
        }
    }

    #[test]
    fn cross_model_proof_scoping_blocks_switched_models_and_errored_turns() {
        assert!(can_replay_cryptographic_proof(
            Some("htmustc-claude"),
            Some("claude-sonnet-5-5"),
            "htmustc-claude",
            "claude-sonnet-5-5",
            false,
            false
        ));
        assert!(!can_replay_cryptographic_proof(
            Some("htmustc-claude"),
            Some("claude-sonnet-5-5"),
            "htmustc",
            "gpt-6.2-sol",
            false,
            false
        ));
        assert!(!can_replay_cryptographic_proof(
            Some("htmustc-claude"),
            Some("claude-sonnet-5-5"),
            "htmustc-claude",
            "claude-sonnet-5-5",
            true,
            false
        ));
    }

    #[test]
    fn gpt_and_claude_prioritize_over_gemini_on_main_and_verifier_roles() {
        assert!(
            intrinsic_role_affinity(ModelRole::Main, "gpt-6.2-sol")
                > intrinsic_role_affinity(ModelRole::Main, "gemini-3.8-flash")
        );
        assert!(
            intrinsic_role_affinity(ModelRole::Verifier, "claude-sonnet-5-5")
                > intrinsic_role_affinity(ModelRole::Verifier, "gemini-3.8-flash")
        );
    }
}
