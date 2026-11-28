//! Shared ACP wire helpers used by BOTH transports (`omnia --acp` stdio and
//! `omnia --acp-http` HTTP/SSE/WebSocket).
//!
//! Shapes are pinned against `agent-client-protocol-schema` v1.9.1 as consumed by
//! Goose 1.60 (`crates/goose/src/acp/provider.rs`): `session/new` MUST return a
//! `configOptions[]` entry with `category == "model"` and `type == "select"`
//! (otherwise goose fails the session with "agent returned no model config_options"),
//! `session/set_config_option` MUST echo the full refreshed option set, and
//! `stopReason` values are snake_case (`end_turn | max_tokens | max_turn_requests |
//! refusal | cancelled`).

use serde_json::{json, Value};

use crate::permissions::ApprovalMode;
use crate::{read_models_config, resolve_model_endpoint};

/// Well-known config option ids (goose matches `model` by category, `effort` by id fallback).
pub const MODEL_OPTION_ID: &str = "model";
pub const THOUGHT_LEVEL_OPTION_ID: &str = "thought_level";
pub const MODE_OPTION_ID: &str = "mode";

const DEFAULT_EFFORTS: &[&str] = &["minimal", "low", "medium", "high"];

/// Env-var-name shaped credential values (`HTMUSTC_API_KEY`) are dereferenced;
/// anything else (`mk-live-…`, mixed case / dashes) is a literal secret.
#[must_use]
pub fn is_env_var_name(raw: &str) -> bool {
    let t = raw.trim();
    !t.is_empty()
        && t.bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && t.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// Resolve a credential that may be an ENV var NAME (OMP `models.yml` convention)
/// to its secret value. Returns `None` when the value is not env-shaped or the
/// variable is unset (caller keeps the original value).
#[must_use]
pub fn deref_env_credential(raw: &str) -> Option<String> {
    let name = raw.trim();
    if !is_env_var_name(name) {
        return None;
    }
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_string())
}

/// Map engine run status onto the ACP `stopReason` enum.
#[must_use]
pub fn stop_reason_for_status(status: &str) -> &'static str {
    match status {
        "completed" => "end_turn",
        "aborted" => "cancelled",
        "timeout" | "max_turns" => "max_turn_requests",
        _ => "refusal",
    }
}

/// One selectable model for the goose model picker.
#[derive(Debug, Clone)]
pub struct ModelCatalogEntry {
    /// Fully-qualified `provider/model` spec (unambiguous across providers).
    pub spec: String,
    /// Human label.
    pub name: String,
    /// Reasoning-effort vocabulary advertised by the model.
    pub efforts: Vec<String>,
    /// Model's preferred default effort (from `thinking.defaultLevel`).
    pub default_effort: Option<String>,
}

/// Flatten `models.yml` into the ACP model catalog (order = file order).
#[must_use]
pub fn model_catalog(config_dir: Option<&std::path::Path>) -> Vec<ModelCatalogEntry> {
    let cfg = read_models_config(config_dir).ok();
    let mut out: Vec<ModelCatalogEntry> = Vec::new();
    if let Some(c) = cfg {
        for p in &c.providers {
            for m in &p.models {
                let efforts: Vec<String> = match m.thinking.as_ref() {
                    Some(t) if !t.efforts.is_empty() => t.efforts.clone(),
                    _ => DEFAULT_EFFORTS.iter().map(|s| s.to_string()).collect(),
                };
                let default_effort = m
                    .thinking
                    .as_ref()
                    .map(|t| t.default_level.clone())
                    .filter(|d| !d.trim().is_empty());
                out.push(ModelCatalogEntry {
                    spec: format!("{}/{}", p.id, m.id),
                    name: if m.name.is_empty() {
                        m.id.clone()
                    } else {
                        m.name.clone()
                    },
                    efforts,
                    default_effort,
                });
            }
        }
    }
    if out.is_empty() {
        // models.yml missing/unparsable: still offer built-in fallbacks so the goose
        // session handshake never dies with "agent returned no model config_options".
        for (spec, name) in [
            ("htmustc-claude/claude-sonnet-5-5", "Claude Sonnet 5.5"),
            ("htmustc-openai/gpt-6.2-sol", "GPT 6.2 Sol"),
            ("htmustc-gemini/gemini-3.8-flash", "Gemini 3.8 Flash"),
        ] {
            out.push(ModelCatalogEntry {
                spec: spec.into(),
                name: name.into(),
                efforts: DEFAULT_EFFORTS.iter().map(|s| s.to_string()).collect(),
                default_effort: Some("medium".into()),
            });
        }
    }
    out
}

/// Validate a requested effort against the model vocabulary, falling back to the
/// model default / first entry.
#[must_use]
pub fn normalize_effort(entry: &ModelCatalogEntry, requested: Option<&str>) -> String {
    if let Some(r) = requested {
        let r = r.trim().to_ascii_lowercase();
        if entry.efforts.iter().any(|e| e.eq_ignore_ascii_case(&r)) {
            return r;
        }
    }
    entry
        .default_effort
        .clone()
        .filter(|d| entry.efforts.iter().any(|e| e.eq_ignore_ascii_case(d)))
        .or_else(|| entry.efforts.first().cloned())
        .unwrap_or_else(|| "medium".into())
}

fn capitalized(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn labeled_options(values: &[String], labels: &[(String, String)]) -> Vec<Value> {
    values
        .iter()
        .map(|v| {
            let label = labels
                .iter()
                .find(|(id, _)| id == v)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| capitalized(v));
            json!({ "value": v, "name": label })
        })
        .collect()
}

/// Build the `configOptions` array advertised on `session/new`, `session/load`,
/// and every `session/set_config_option` response.
pub fn build_config_options(
    catalog: &[ModelCatalogEntry],
    current_model: &str,
    current_effort: Option<&str>,
    approval: ApprovalMode,
) -> Vec<Value> {
    let entry = catalog
        .iter()
        .find(|e| e.spec == current_model)
        .cloned()
        .unwrap_or_else(|| ModelCatalogEntry {
            spec: current_model.to_string(),
            name: current_model.to_string(),
            efforts: DEFAULT_EFFORTS.iter().map(|s| s.to_string()).collect(),
            default_effort: Some("medium".into()),
        });

    let model_values: Vec<String> = catalog.iter().map(|e| e.spec.clone()).collect();
    let model_labels: Vec<(String, String)> = catalog
        .iter()
        .map(|e| (e.spec.clone(), e.name.clone()))
        .collect();
    let mut model_opts = labeled_options(&model_values, &model_labels);
    // Selected model may be absent from the catalog (models.yml edited mid-session):
    // keep it visible so `currentValue` always matches an offered option.
    if !model_values.iter().any(|v| v == &entry.spec) {
        model_opts.insert(0, json!({ "value": entry.spec, "name": entry.name }));
    }

    let current_effort = normalize_effort(&entry, current_effort);
    let effort_labels: Vec<(String, String)> = entry
        .efforts
        .iter()
        .map(|e| (e.clone(), capitalized(e)))
        .collect();

    let (mode_current, mode_labels) = acp_mode_state(approval);
    let mode_values: Vec<String> = vec!["default".into(), "yolo".into()];

    vec![
        json!({
            "id": MODEL_OPTION_ID,
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": entry.spec,
            "options": model_opts,
        }),
        json!({
            "id": THOUGHT_LEVEL_OPTION_ID,
            "name": "Reasoning effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": current_effort,
            "options": labeled_options(&entry.efforts, &effort_labels),
        }),
        json!({
            "id": MODE_OPTION_ID,
            "name": "Session mode",
            "category": "mode",
            "type": "select",
            "currentValue": mode_current,
            "options": labeled_options(&mode_values, &mode_labels),
        }),
    ]
}

/// Session `modes` state (legacy selector) mirroring the `mode` config option.
pub fn build_modes_state(approval: ApprovalMode) -> Value {
    let (current, _) = acp_mode_state(approval);
    json!({
        "currentModeId": current,
        "availableModes": [
            { "id": "yolo", "name": "Auto", "description": "YOLO / Turbo / Full Access (Auto-Approve)" },
            { "id": "default", "name": "Approve", "description": "Ask before edits and shell commands" }
        ]
    })
}

fn acp_mode_state(approval: ApprovalMode) -> (&'static str, Vec<(String, String)>) {
    let current = if matches!(approval, ApprovalMode::Yolo) {
        "yolo"
    } else {
        "default"
    };
    (
        current,
        vec![
            ("yolo".into(), "Auto".into()),
            ("default".into(), "Approve".into()),
        ],
    )
}

/// Approval mode decoded from an ACP mode id.
#[must_use]
pub fn approval_for_mode_id(id: &str) -> Option<ApprovalMode> {
    match id.trim().to_ascii_lowercase().as_str() {
        "yolo" | "turbo" | "full" | "full-access" | "unrestricted" | "auto" | "auto-approve"
        | "bypasspermissions" | "acceptall" => Some(ApprovalMode::Yolo),
        "default" | "approve" | "ask" | "always-ask" => Some(ApprovalMode::AlwaysAsk),
        "always-ask-cached" | "cached" => Some(ApprovalMode::AlwaysAskCached),
        "plan" | "read-only" | "readonly" => Some(ApprovalMode::Plan),
        "write" | "acceptedits" => Some(ApprovalMode::Write),
        _ => None,
    }
}

/// Switch a live session to a catalog model; returns the resolved `provider/model`.
pub fn rebind_model(
    engine: &mut crate::NativeSuperEngine,
    spec: &str,
    config_dir: Option<&std::path::Path>,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> anyhow::Result<String> {
    use crate::edit::ModelEditAffinity;
    use crate::EpochMaskingState;

    let ep = resolve_model_endpoint(spec, config_dir, base_url, api_key)?;
    engine.endpoint = ep.clone();
    engine.epoch_masker = EpochMaskingState::for_context_window(ep.context_window);
    engine.edit_affinity = ModelEditAffinity::for_model(&ep.model_id);
    Ok(format!("{}/{}", ep.provider_id, ep.model_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_credential_deref_only_for_env_shaped_names() {
        unsafe { std::env::set_var("OMNIA_TEST_ACAP_NAME", "secret-1") };
        assert_eq!(
            deref_env_credential("OMNIA_TEST_ACAP_NAME").as_deref(),
            Some("secret-1")
        );
        assert_eq!(deref_env_credential("mk-live-K61abc"), None);
        assert_eq!(deref_env_credential(""), None);
        assert_eq!(deref_env_credential("9LIVES"), None);
        unsafe { std::env::remove_var("OMNIA_TEST_ACAP_NAME") };
    }

    #[test]
    fn stop_reason_mapping_is_acp_snake_case() {
        assert_eq!(stop_reason_for_status("completed"), "end_turn");
        assert_eq!(stop_reason_for_status("aborted"), "cancelled");
        assert_eq!(stop_reason_for_status("timeout"), "max_turn_requests");
        assert_eq!(stop_reason_for_status("error"), "refusal");
    }

    fn catalog() -> Vec<ModelCatalogEntry> {
        vec![
            ModelCatalogEntry {
                spec: "p/one".into(),
                name: "One".into(),
                efforts: vec!["low".into(), "high".into()],
                default_effort: Some("high".into()),
            },
            ModelCatalogEntry {
                spec: "p/two".into(),
                name: "Two".into(),
                efforts: vec!["low".into()],
                default_effort: None,
            },
        ]
    }

    #[test]
    fn config_options_advertise_model_select() {
        let opts = build_config_options(&catalog(), "p/one", None, ApprovalMode::AlwaysAsk);
        let model = opts.iter().find(|o| o["category"] == "model").unwrap();
        assert_eq!(model["id"], "model");
        assert_eq!(model["type"], "select");
        assert_eq!(model["currentValue"], "p/one");
        assert_eq!(model["options"].as_array().unwrap().len(), 2);
        let effort = opts
            .iter()
            .find(|o| o["category"] == "thought_level")
            .unwrap();
        assert_eq!(effort["currentValue"], "high");
        let mode = opts.iter().find(|o| o["category"] == "mode").unwrap();
        assert_eq!(mode["currentValue"], "default");
    }

    #[test]
    fn unknown_current_model_stays_selectable() {
        let opts = build_config_options(&catalog(), "p/ghost", Some("low"), ApprovalMode::Yolo);
        let model = opts.iter().find(|o| o["category"] == "model").unwrap();
        assert_eq!(model["currentValue"], "p/ghost");
        assert!(model["options"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["value"] == "p/ghost"));
        assert_eq!(
            opts.iter().find(|o| o["category"] == "mode").unwrap()["currentValue"],
            "yolo"
        );
    }
}
