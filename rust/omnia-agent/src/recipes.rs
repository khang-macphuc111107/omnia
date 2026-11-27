//! Goose-compatible YAML Recipes discovery, schema validation, parameter binding,
//! and sub-recipe prompt rendering.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

/// Parameter requirement level matching Goose YAML recipe semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipeParamRequirement {
    #[default]
    Required,
    Optional,
    UserPrompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecipeParamType {
    #[default]
    String,
    Number,
    Boolean,
    Select,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeParameter {
    pub key: String,
    #[serde(default)]
    pub input_type: RecipeParamType,
    #[serde(default)]
    pub requirement: RecipeParamRequirement,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubRecipeRef {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub sequential_when_repeated: bool,
}

/// Canonical Goose-style YAML Recipe specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecipeSpec {
    #[serde(default = "default_recipe_version")]
    pub version: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub extensions: Vec<Value>,
    #[serde(default)]
    pub builtins: Vec<String>,
    #[serde(default)]
    pub parameters: Vec<RecipeParameter>,
    #[serde(default)]
    pub sub_recipes: Vec<SubRecipeRef>,
    #[serde(default)]
    pub activities: Vec<String>,
    #[serde(default)]
    pub response: Option<Value>,
    #[serde(default)]
    pub retry: Option<Value>,
    #[serde(default)]
    pub source_path: Option<PathBuf>,
}

fn default_recipe_version() -> String {
    "1.0.0".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderedRecipe {
    pub title: String,
    pub version: String,
    pub resolved_params: BTreeMap<String, String>,
    pub instructions: Option<String>,
    pub prompt: String,
    pub sub_recipes: Vec<SubRecipeRef>,
    pub builtins: Vec<String>,
}

/// Parses a Goose-compatible YAML recipe string and validates structural invariants.
pub fn parse_recipe_yaml(raw_yaml: &str, source_path: Option<PathBuf>) -> Result<RecipeSpec> {
    let mut spec: RecipeSpec = serde_yaml::from_str(raw_yaml).context("parse YAML recipe")?;
    if spec.title.trim().is_empty() {
        bail!("recipe `title` must not be empty");
    }
    if spec.instructions.as_deref().unwrap_or("").trim().is_empty()
        && spec.prompt.as_deref().unwrap_or("").trim().is_empty()
    {
        bail!("recipe `{}` must specify either `instructions` or `prompt`", spec.title);
    }
    let mut seen_keys = std::collections::HashSet::new();
    for p in &spec.parameters {
        if p.key.trim().is_empty() {
            bail!("recipe parameter key must not be empty");
        }
        if !seen_keys.insert(p.key.clone()) {
            bail!("duplicate recipe parameter `{}`", p.key);
        }
        if p.input_type == RecipeParamType::Select && p.options.is_empty() {
            bail!("select recipe parameter `{}` requires non-empty `options`", p.key);
        }
    }
    spec.source_path = source_path;
    Ok(spec)
}

/// Discovers `.yaml`/`.yml` recipes inside `.omnia/recipes` and `.goose/recipes`.
pub fn discover_recipes(workspace_root: &Path) -> Vec<RecipeSpec> {
    let mut out = Vec::new();
    for rel in [".omnia/recipes", ".goose/recipes"] {
        let dir = workspace_root.join(rel);
        if !dir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let is_yaml = p
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("yaml") || e.eq_ignore_ascii_case("yml"));
            if !is_yaml {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&p) {
                if let Ok(spec) = parse_recipe_yaml(&raw, Some(p.clone())) {
                    out.push(spec);
                }
            }
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

/// Validates caller parameters against `spec` and renders `instructions` and `prompt` safely
/// using a single non-recursive pass over `{{ key }}` template placeholders.
pub fn validate_and_render_recipe(
    spec: &RecipeSpec,
    supplied: &HashMap<String, String>,
) -> Result<RenderedRecipe> {
    let mut resolved = BTreeMap::new();
    for param in &spec.parameters {
        let val = match supplied.get(&param.key) {
            Some(v) => v.clone(),
            None => match (&param.default, param.requirement) {
                (Some(def), _) => def.clone(),
                (None, RecipeParamRequirement::Optional) => String::new(),
                (None, RecipeParamRequirement::Required | RecipeParamRequirement::UserPrompt) => {
                    bail!("missing required recipe parameter `{}`", param.key);
                }
            },
        };
        match param.input_type {
            RecipeParamType::Number if !val.is_empty() && val.parse::<f64>().is_err() => {
                bail!("recipe parameter `{}` must be numeric (got `{val}`)", param.key);
            }
            RecipeParamType::Boolean
                if !val.is_empty()
                    && !matches!(val.to_ascii_lowercase().as_str(), "true" | "false" | "1" | "0") =>
            {
                bail!("recipe parameter `{}` must be boolean (got `{val}`)", param.key);
            }
            RecipeParamType::Select
                if !val.is_empty() && !param.options.iter().any(|opt| opt == &val) =>
            {
                bail!(
                    "recipe parameter `{}` value `{val}` not in allowed options {:?}",
                    param.key,
                    param.options
                );
            }
            _ => {}
        }
        resolved.insert(param.key.clone(), val);
    }

    let rendered_instructions = spec
        .instructions
        .as_deref()
        .map(|s| render_template_single_pass(s, &resolved));
    let raw_prompt = spec
        .prompt
        .as_deref()
        .unwrap_or_else(|| spec.instructions.as_deref().unwrap_or(""));
    let rendered_prompt = render_template_single_pass(raw_prompt, &resolved);

    let rendered_subs = spec
        .sub_recipes
        .iter()
        .map(|sub| SubRecipeRef {
            name: sub.name.clone(),
            path: sub.path.clone(),
            values: sub
                .values
                .iter()
                .map(|(k, v)| (k.clone(), render_template_single_pass(v, &resolved)))
                .collect(),
            sequential_when_repeated: sub.sequential_when_repeated,
        })
        .collect();

    Ok(RenderedRecipe {
        title: spec.title.clone(),
        version: spec.version.clone(),
        resolved_params: resolved,
        instructions: rendered_instructions,
        prompt: rendered_prompt,
        sub_recipes: rendered_subs,
        builtins: spec.builtins.clone(),
    })
}

fn render_template_single_pass(template: &str, params: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut cursor = 0usize;
    while let Some(rel_open) = template[cursor..].find("{{") {
        let open = cursor + rel_open;
        out.push_str(&template[cursor..open]);
        let after_open = open + 2;
        if let Some(rel_close) = template[after_open..].find("}}") {
            let close = after_open + rel_close;
            let key = template[after_open..close].trim();
            if let Some(val) = params.get(key) {
                out.push_str(val);
            } else {
                out.push_str(&template[open..close + 2]);
            }
            cursor = close + 2;
        } else {
            out.push_str("{{");
            cursor = after_open;
        }
    }
    out.push_str(&template[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_validates_and_renders_goose_yaml_recipe() {
        let yaml = r#"
version: "1.0.0"
title: "Security Audit"
description: "Audit crate for SSRF and secrets"
instructions: "Inspect {{ crate_name }} in {{ mode }} mode."
prompt: "Audit {{ crate_name }} using {{ depth }} checks."
parameters:
  - key: crate_name
    input_type: string
    requirement: required
  - key: mode
    input_type: select
    requirement: optional
    default: "strict"
    options: ["fast", "strict"]
  - key: depth
    input_type: number
    requirement: optional
    default: "3"
"#;
        let spec = parse_recipe_yaml(yaml, None).expect("parse yaml");
        let mut args = HashMap::new();
        args.insert("crate_name".into(), "omnia-agent".into());
        let rendered = validate_and_render_recipe(&spec, &args).expect("render");
        assert_eq!(rendered.prompt, "Audit omnia-agent using 3 checks.");
        assert_eq!(
            rendered.instructions.as_deref(),
            Some("Inspect omnia-agent in strict mode.")
        );

        // Missing required parameter fails closed
        assert!(validate_and_render_recipe(&spec, &HashMap::new()).is_err());

        // Non-recursive template safety: value containing `{{ mode }}` is not re-expanded
        let mut tricky = HashMap::new();
        tricky.insert("crate_name".into(), "{{ mode }}".into());
        let non_rec = validate_and_render_recipe(&spec, &tricky).expect("non-recursive");
        assert_eq!(non_rec.prompt, "Audit {{ mode }} using 3 checks.");
    }
}
