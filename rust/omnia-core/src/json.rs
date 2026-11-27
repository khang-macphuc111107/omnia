use serde_json::{Map, Value};

use crate::error::CoreError;

const MIN_I64_F64: f64 = -9_223_372_036_854_775_808.0; // -2^63 exact in IEEE-754 binary64
const MAX_I64_EXCL_F64: f64 = 9_223_372_036_854_775_808.0; // +2^63 exact in IEEE-754 binary64
const MAX_U64_EXCL_F64: f64 = 18_446_744_073_709_551_616.0; // +2^64 exact in IEEE-754 binary64

/// Parse strict RFC 8259 UTF-8 JSON with `serde_json` recursion-depth safeguards (limit 128).
pub fn parse_json(input: &str) -> Result<Value, CoreError> {
    serde_json::from_str(input).map_err(|err| CoreError::InvalidJson(err.to_string()))
}

/// Parse strict RFC 8259 JSON, returning `None` on malformed input.
#[must_use]
pub fn try_parse_json(input: &str) -> Option<Value> {
    serde_json::from_str(input).ok()
}

/// Convert an `f64` to `i64` only if it is finite, integral, and strictly representable in `i64`.
///
/// Because `i64::MAX` rounds up to `+2^63` in IEEE-754 binary64, the upper bound is strictly
/// exclusive (`< +2^63`) while the lower bound is inclusive (`>= -2^63`). Negative zero maps to `0`.
#[must_use]
pub fn try_f64_to_i64(value: f64) -> Option<i64> {
    if value.is_finite()
        && (MIN_I64_F64..MAX_I64_EXCL_F64).contains(&value)
        && value.trunc() == value
    {
        #[allow(clippy::cast_possible_truncation)]
        Some(value as i64)
    } else {
        None
    }
}

/// Checked RFC 8259 integer extraction (`AUD-29`): accepts only finite, integral JSON numbers
/// strictly representable in `i64` (including exact scientific notation like `6.4e1` and `-0.0`),
/// rejecting fractions (`64.9`, `-0.5`), out-of-range integers (`9223372036854775808`), huge
/// exponents (`1e100`, `-1e100`), booleans, strings, nulls, arrays, and objects.
#[must_use]
pub fn try_json_i64(value: &Value) -> Option<i64> {
    let Value::Number(num) = value else {
        return None;
    };
    if let Some(i) = num.as_i64() {
        return Some(i);
    }
    if num.is_u64() {
        // Unsigned integer strictly greater than i64::MAX (e.g. 9223372036854775808).
        return None;
    }
    num.as_f64().and_then(try_f64_to_i64)
}

/// Checked `i64` extraction falling back to `fallback` whenever `value` is not a valid `i64`.
#[must_use]
pub fn json_i64_or(value: &Value, fallback: i64) -> i64 {
    try_json_i64(value).unwrap_or(fallback)
}

/// Checked `i64` extraction enforcing inclusive application bounds `[min, max]`.
#[must_use]
pub fn try_json_i64_in_range(value: &Value, min: i64, max: i64) -> Option<i64> {
    try_json_i64(value).filter(|v| (min..=max).contains(v))
}

/// Checked RFC 8259 unsigned 64-bit integer extraction rejecting negatives, fractions, and overflow.
#[must_use]
pub fn try_json_u64(value: &Value) -> Option<u64> {
    let Value::Number(num) = value else {
        return None;
    };
    if let Some(u) = num.as_u64() {
        return Some(u);
    }
    if num.is_i64() {
        return None;
    }
    num.as_f64().and_then(|d| {
        if d.is_finite() && (0.0..MAX_U64_EXCL_F64).contains(&d) && d.trunc() == d {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(d as u64)
        } else {
            None
        }
    })
}

/// Validate an optional integer field on a JSON object: absent keys yield `default`, whereas any
/// present key that is non-integral, non-finite, wrong-typed, or outside `[min, max]` fails closed.
pub fn parse_optional_json_i64_in_range(
    obj: &Map<String, Value>,
    key: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, CoreError> {
    let Some(raw) = obj.get(key) else {
        return Ok(default);
    };
    try_json_i64_in_range(raw, min, max).ok_or_else(|| {
        CoreError::InvalidInput(format!("{key} must be an integer between {min} and {max}"))
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checked_json_integers_match_aud29_and_pr1_boundaries() {
        let fallback = 123_i64;
        for raw in [
            "1e100",
            "-1e100",
            "9223372036854775808",
            "64.9",
            "-0.5",
            "true",
            "null",
            "\"64\"",
            "[]",
            "{}",
        ] {
            let parsed = parse_json(raw).expect("valid RFC 8259 JSON token");
            assert_eq!(try_json_i64(&parsed), None, "must reject {raw}");
            assert_eq!(json_i64_or(&parsed, fallback), fallback);
        }

        for bad_float in [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NAN,
            MIN_I64_F64.next_down(),
            MAX_I64_EXCL_F64,
        ] {
            assert_eq!(
                try_f64_to_i64(bad_float),
                None,
                "must reject float {bad_float}"
            );
        }

        assert_eq!(
            try_json_i64(&parse_json("9223372036854775807").unwrap()),
            Some(i64::MAX)
        );
        assert_eq!(
            try_json_i64(&parse_json("-9223372036854775808").unwrap()),
            Some(i64::MIN)
        );
        assert_eq!(try_f64_to_i64(MIN_I64_F64), Some(i64::MIN));
        assert_eq!(
            try_f64_to_i64(MAX_I64_EXCL_F64.next_down()),
            Some(i64::MAX - 1023)
        );
        assert_eq!(try_json_i64(&parse_json("6.4e1").unwrap()), Some(64));
        assert_eq!(
            json_i64_or(&parse_json("-0.0").unwrap(), fallback),
            0
        );
        assert_eq!(
            try_json_u64(&parse_json("9223372036854775808").unwrap()),
            Some(9_223_372_036_854_775_808_u64)
        );
        assert_eq!(try_json_u64(&parse_json("-1").unwrap()), None);
        assert_eq!(try_json_u64(&parse_json("6.4e1").unwrap()), Some(64));

        let valid_obj = json!({ "estimatedTokens": 64 });
        assert_eq!(
            parse_optional_json_i64_in_range(
                valid_obj.as_object().unwrap(),
                "estimatedTokens",
                4096,
                64,
                1_000_000
            )
            .unwrap(),
            64
        );
        let missing_obj = json!({});
        assert_eq!(
            parse_optional_json_i64_in_range(
                missing_obj.as_object().unwrap(),
                "estimatedTokens",
                4096,
                64,
                1_000_000
            )
            .unwrap(),
            4096
        );
        for bad_val in [
            json!(63),
            json!(1_000_001),
            json!(64.9),
            json!(-64),
            json!("64"),
            json!(true),
            json!(null),
        ] {
            let obj = json!({ "estimatedTokens": bad_val });
            assert!(parse_optional_json_i64_in_range(
                obj.as_object().unwrap(),
                "estimatedTokens",
                4096,
                64,
                1_000_000
            )
            .is_err());
        }
    }

    #[test]
    fn rfc8259_strictness_rejects_control_chars_unpaired_surrogates_and_excess_depth() {
        // Unescaped C0 control chars inside strings are forbidden by RFC 8259.
        assert!(parse_json("\"line1\nline2\"").is_err());
        assert!(parse_json("\"tab\there\"").is_err());
        assert!(parse_json("\"nul\u{0000}byte\"").is_err());

        // Lone UTF-16 surrogates are rejected; valid surrogate pairs decode to Unicode scalars.
        assert!(parse_json(r#""\uD800""#).is_err());
        assert!(parse_json(r#""\uDC00""#).is_err());
        assert!(parse_json(r#""\uD83D""#).is_err());
        let rocket = parse_json(r#""\uD83D\uDE80""#).expect("valid surrogate pair");
        assert_eq!(rocket.as_str(), Some("🚀"));

        // Depth safeguard (serde_json default recursion limit = 128).
        let ok_depth = format!("{}1{}", "[".repeat(64), "]".repeat(64));
        assert!(parse_json(&ok_depth).is_ok());
        let too_deep = format!("{}1{}", "[".repeat(140), "]".repeat(140));
        assert!(parse_json(&too_deep).is_err());
    }
}
