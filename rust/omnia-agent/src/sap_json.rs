//! Rust BAML Schema-Aligned Parsing (`SAP`) tolerant partial-JSON tool-call repair.
//!
//! Eliminates wasted LLM retry round-trips caused by minor tool-call JSON formatting
//! defects or truncated SSE tool payloads:
//! - Strips markdown fences (` ```json ... ``` `) and prose preamble/suffix
//! - Removes trailing commas before `}` or `]`
//! - Auto-closes truncated string quotes and unbalanced `{` / `[` delimiters
//! - Coerces float-encoded integers (`1000.0 -> 1000`) and stringified ints/bools
//!   against the tool's JSON Schema (directly fixing `htmustc` Codex/Gemini integer
//!   coercion quirks)

use serde_json::{Map, Number, Value};

#[derive(Debug, Clone)]
pub struct SapRepairResult {
    pub value: Value,
    pub repaired: bool,
    pub repairs_applied: Vec<String>,
}

/// Attempt strict JSON parse first, then apply deterministic SAP repairs + schema coercion.
pub fn repair_tool_json(raw: &str, schema: Option<&Value>) -> Result<SapRepairResult, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(SapRepairResult {
            value: Value::Object(Map::new()),
            repaired: false,
            repairs_applied: Vec::new(),
        });
    }

    // Fast path: already valid JSON
    if let Ok(mut val) = serde_json::from_str::<Value>(trimmed) {
        let mut repairs = Vec::new();
        if let Some(s) = schema {
            coerce_against_schema(&mut val, s, "$", &mut repairs);
        }
        return Ok(SapRepairResult {
            value: val,
            repaired: !repairs.is_empty(),
            repairs_applied: repairs,
        });
    }

    let mut repairs = Vec::new();
    let mut candidate = strip_markdown_fences(trimmed, &mut repairs);
    candidate = extract_outer_json_slice(&candidate, &mut repairs);
    candidate = strip_trailing_commas(&candidate, &mut repairs);

    // Try parse before auto-closing
    if let Ok(mut val) = serde_json::from_str::<Value>(&candidate) {
        if let Some(s) = schema {
            coerce_against_schema(&mut val, s, "$", &mut repairs);
        }
        return Ok(SapRepairResult {
            value: val,
            repaired: true,
            repairs_applied: repairs,
        });
    }

    // Auto-close truncated strings and unbalanced braces/brackets
    let closed = auto_close_truncated_json(&candidate, &mut repairs);
    let cleaned = strip_trailing_commas(&closed, &mut repairs);

    if let Ok(mut val) = serde_json::from_str::<Value>(&cleaned) {
        if let Some(s) = schema {
            coerce_against_schema(&mut val, s, "$", &mut repairs);
        }
        return Ok(SapRepairResult {
            value: val,
            repaired: true,
            repairs_applied: repairs,
        });
    }

    // Last-resort: try fixing unescaped literal newlines inside JSON strings
    let nl_fixed = escape_raw_newlines_in_strings(&cleaned, &mut repairs);
    if let Ok(mut val) = serde_json::from_str::<Value>(&nl_fixed) {
        if let Some(s) = schema {
            coerce_against_schema(&mut val, s, "$", &mut repairs);
        }
        return Ok(SapRepairResult {
            value: val,
            repaired: true,
            repairs_applied: repairs,
        });
    }

    Err(format!(
        "SAP JSON repair could not recover valid JSON from {} chars",
        trimmed.len()
    ))
}

fn strip_markdown_fences(input: &str, repairs: &mut Vec<String>) -> String {
    let t = input.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let body = if let Some(nl) = rest.find('\n') {
            &rest[nl + 1..]
        } else {
            rest
        };
        let stripped = body.trim_end().strip_suffix("```").unwrap_or(body).trim();
        repairs.push("stripped_markdown_fence".into());
        return stripped.to_string();
    }
    t.to_string()
}

fn extract_outer_json_slice(input: &str, repairs: &mut Vec<String>) -> String {
    let bytes = input.as_bytes();
    let Some(first_obj) = bytes.iter().position(|&b| b == b'{' || b == b'[') else {
        return input.to_string();
    };
    let open = bytes[first_obj];
    let close = if open == b'{' { b'}' } else { b']' };
    let last_close = bytes.iter().rposition(|&b| b == close);
    let end = match last_close {
        Some(pos) if pos >= first_obj => pos + 1,
        _ => input.len(),
    };
    if first_obj > 0 || end < input.len() {
        repairs.push("extracted_outer_json_span".into());
        return input[first_obj..end].to_string();
    }
    input.to_string()
}

fn strip_trailing_commas(input: &str, repairs: &mut Vec<String>) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut removed = false;

    for i in 0..chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                removed = true;
                continue;
            }
        }
        out.push(c);
    }
    if removed {
        repairs.push("stripped_trailing_comma".into());
    }
    out
}

fn auto_close_truncated_json(input: &str, repairs: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for c in input.chars() {
        out.push(c);
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' if stack.last() == Some(&c) => {
                stack.pop();
            }
            _ => {}
        }
    }

    if in_string {
        if escaped {
            out.pop();
        }
        out.push('"');
        repairs.push("closed_unterminated_string".into());
    }

    // Trim dangling colon or comma before closing containers
    let trimmed_end = out.trim_end();
    if let Some(last) = trimmed_end.chars().last() {
        if last == ':' {
            out = format!("{trimmed_end} null");
            repairs.push("filled_dangling_colon_null".into());
        } else if last == ',' {
            out = trimmed_end[..trimmed_end.len() - 1].to_string();
            repairs.push("trimmed_dangling_comma".into());
        }
    }

    if !stack.is_empty() {
        while let Some(closer) = stack.pop() {
            out.push(closer);
        }
        repairs.push("closed_unbalanced_containers".into());
    }
    out
}

fn escape_raw_newlines_in_strings(input: &str, repairs: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    let mut in_string = false;
    let mut escaped = false;
    let mut changed = false;

    for c in input.chars() {
        if in_string {
            if escaped {
                out.push(c);
                escaped = false;
                continue;
            }
            match c {
                '\\' => {
                    out.push(c);
                    escaped = true;
                }
                '"' => {
                    out.push(c);
                    in_string = false;
                }
                '\n' => {
                    out.push_str("\\n");
                    changed = true;
                }
                '\r' => {
                    changed = true;
                }
                '\t' => {
                    out.push_str("\\t");
                    changed = true;
                }
                _ => out.push(c),
            }
        } else {
            if c == '"' {
                in_string = true;
            }
            out.push(c);
        }
    }
    if changed {
        repairs.push("escaped_raw_newlines_in_string".into());
    }
    out
}

fn coerce_against_schema(val: &mut Value, schema: &Value, path: &str, repairs: &mut Vec<String>) {
    let expected_type = schema.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match expected_type {
        "integer" => {
            if let Value::Number(n) = val {
                if n.as_i64().is_none() && n.as_u64().is_none() {
                    if let Some(f) = n.as_f64() {
                        if f.is_finite() && (f - f.trunc()).abs() < 1e-9 {
                            let i = f.trunc() as i64;
                            *val = Value::Number(Number::from(i));
                            repairs.push(format!("coerced_float_to_int:{path}"));
                        }
                    }
                }
            } else if let Value::String(s) = val {
                let t = s.trim();
                if let Ok(i) = t.parse::<i64>() {
                    *val = Value::Number(Number::from(i));
                    repairs.push(format!("coerced_str_to_int:{path}"));
                } else if let Ok(f) = t.parse::<f64>() {
                    if f.is_finite() && (f - f.trunc()).abs() < 1e-9 {
                        *val = Value::Number(Number::from(f.trunc() as i64));
                        repairs.push(format!("coerced_str_float_to_int:{path}"));
                    }
                }
            }
        }
        "boolean" => {
            if let Value::String(s) = val {
                match s.trim().to_ascii_lowercase().as_str() {
                    "true" | "1" => {
                        *val = Value::Bool(true);
                        repairs.push(format!("coerced_str_to_bool:{path}"));
                    }
                    "false" | "0" => {
                        *val = Value::Bool(false);
                        repairs.push(format!("coerced_str_to_bool:{path}"));
                    }
                    _ => {}
                }
            }
        }
        "object" => {
            if let (Some(obj), Some(props)) = (
                val.as_object_mut(),
                schema.get("properties").and_then(|v| v.as_object()),
            ) {
                for (k, v) in obj.iter_mut() {
                    if let Some(prop_schema) = props.get(k) {
                        let sub_path = format!("{path}.{k}");
                        coerce_against_schema(v, prop_schema, &sub_path, repairs);
                    }
                }
            }
        }
        "array" => {
            if let (Some(arr), Some(item_schema)) = (val.as_array_mut(), schema.get("items")) {
                for (idx, item) in arr.iter_mut().enumerate() {
                    let sub_path = format!("{path}[{idx}]");
                    coerce_against_schema(item, item_schema, &sub_path, repairs);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repairs_markdown_fence_trailing_comma_and_float_ints() {
        let schema = json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" },
                "start_line": { "type": "integer" },
                "end_line": { "type": "integer" },
                "replace_all": { "type": "boolean" }
            }
        });
        let raw = "```json\n{\"path\": \"src/main.rs\", \"start_line\": 10.0, \"end_line\": \"42.0\", \"replace_all\": \"true\",}\n```";
        let res = repair_tool_json(raw, Some(&schema)).unwrap();
        assert!(res.repaired);
        assert_eq!(res.value["path"], "src/main.rs");
        assert_eq!(res.value["start_line"], 10);
        assert_eq!(res.value["end_line"], 42);
        assert_eq!(res.value["replace_all"], true);
    }

    #[test]
    fn auto_closes_truncated_sse_tool_json() {
        let raw = r#"{"path": "src/lib.rs", "old_string": "fn main() {"#;
        let res = repair_tool_json(raw, None).unwrap();
        assert!(res.repaired);
        assert_eq!(res.value["path"], "src/lib.rs");
        assert_eq!(res.value["old_string"], "fn main() {");
    }

    #[test]
    fn escapes_raw_multiline_strings_inside_json() {
        let raw = "{\"path\":\"a.py\",\"content\":\"def f():\n    return 1\"}";
        let res = repair_tool_json(raw, None).unwrap();
        assert!(res.repaired);
        assert_eq!(res.value["content"], "def f():\n    return 1");
    }
}
