use serde_json::{Map, Value};

use crate::error::CoreError;

/// Parse strict RFC 8259 UTF-8 JSON with `serde_json` recursion-depth safeguards (limit 128).
pub fn parse_json(input: &str) -> Result<Value, CoreError> {
    serde_json::from_str(input).map_err(|err| CoreError::InvalidJson(err.to_string()))
}

/// Parse strict RFC 8259 JSON, returning `None` on malformed input.
#[must_use]
pub fn try_parse_json(input: &str) -> Option<Value> {
    serde_json::from_str(input).ok()
}

/// Serialize a JSON value with deterministic sorted object keys (even if `preserve_order` is enabled).
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let sorted = sort_value_keys(value);
    serde_json::to_string(&sorted).unwrap_or_else(|_| "null".to_owned())
}

/// Serialize a JSON value as compact single-line JSON.
pub fn compact_json(value: &Value) -> Result<String, CoreError> {
    serde_json::to_string(value).map_err(|err| CoreError::InvalidJson(err.to_string()))
}

/// Serialize a JSON value with human-readable indentation and sorted object keys.
pub fn pretty_json(value: &Value) -> Result<String, CoreError> {
    let sorted = sort_value_keys(value);
    serde_json::to_string_pretty(&sorted).map_err(|err| CoreError::InvalidJson(err.to_string()))
}

fn sort_value_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_value_keys).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(a, _)| *a);
            let mut out = Map::with_capacity(entries.len());
            for (k, v) in entries {
                out.insert(k.clone(), sort_value_keys(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}
