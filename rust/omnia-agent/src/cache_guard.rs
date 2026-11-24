//! Strict 4-Tier Prefix-0 KV-Cache Discipline & BLAKE3 Prefix Hashing (`SOTA v4`).
//!
//! Core invariants (Manus Context Engineering + Claude Code cache architecture):
//! - **Tier 0** (Token-0 System Prompt ~235 tokens + alphabetically sorted static core
//!   tool schemas) is 100% immutable across every turn of a session (NEVER embeds
//!   timestamps, dynamic CWD, git status, or volatile counters).
//! - **Tier 1** (lean non-standard project rules per `arXiv:2602.11988` + Turn-1 PPR
//!   AST RepoMap skeleton) is placed once in Turn-1 user message.
//! - **Tier 2** (strictly append-only intra-epoch turns) keeps KV prefix cache hit
//!   `>= 92%`.
//! - **Tier 3** (tail-only dynamic diagnostics, convergence hints, and pacing reminders)
//!   appends strictly at the message tail — never mutating earlier turns.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// 100% immutable Token-0 System Prompt (~235 tokens) engineered for late-2026 SOTA coding models.
pub const BASE_SYSTEM_PROMPT: &str = "\
You are Omnia Agent, an expert native software engineering agent operating in a local workspace.

Workflow:
1. Pre-loaded context: Turn-1 <workspace_context> includes a PageRank AST RepoMap (paths, symbols, line spans, edges). Skip Turn-1 workspace_map unless you need a subpath or symbol ego-graph.
2. Move fast: ALWAYS batch independent reads/searches/inspections as multiple parallel tool calls in ONE turn (never one file per turn); use read_file(paths=[...]) and search_code(mode=\"hybrid\"|\"symbol\"|\"regex\") for definitions/callers. Start editing/testing within 2-3 turns.
3. Surgical edits: read_file returns `line:hash| code` anchors. Prefer edit_file (Hashline start_anchor/end_anchor splice, exact old_string/new_string, or syntactic symbol block), apply_patch (atomic multi-file), or write_file (new/rewrite). Inspect syntax deltas & diffs; never repeat failing calls.
4. Verify & stop cleanly: run targeted tests/builds via shell after your final edit. Once tests pass with exit_code == 0 and 0 new errors, conclude concisely without redundant extra turns.
5. Report modified files, root cause, and observed verification.";

/// Variant used only when the `self_verify_gate` Cordis plugin is explicitly disabled.
pub const BASE_SYSTEM_PROMPT_NO_VERIFY: &str = "\
You are Omnia Agent, an expert native software engineering agent operating inside a local workspace.

Workflow:
1. Turn-1 <workspace_context> already includes a PageRank AST RepoMap with symbols and line numbers.
2. Batch related reads via read_file(paths=[...]) or parallel calls; use search_code(mode=\"hybrid\"|\"symbol\"|\"regex\") to locate definitions/callers.
3. Make surgical edits via edit_file (Hashline start_anchor/end_anchor splice or old_string/new_string), apply_patch (atomic multi-file), or write_file.
4. Inspect returned diffs/errors; avoid repeating identical failing calls. Finish concisely.";

#[must_use]
pub fn blake3_bytes(data: &[u8]) -> [u8; 32] {
    *blake3::hash(data).as_bytes()
}

#[must_use]
pub fn hex_encode_32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Fast SIMD BLAKE3 64-char lowercase hex digest.
#[must_use]
pub fn blake3_hex(data: &[u8]) -> String {
    hex_encode_32(&blake3_bytes(data))
}

/// Cryptographic SHA-256 raw 32-byte digest (`omnia_core::sha256_bytes`).
#[must_use]
pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    omnia_core::sha256_bytes(data)
}

/// Genuine lowercase 64-char hexadecimal SHA-256 digest (`omnia_core::sha256_hex`)
/// used for Instruction Delta Epochs and cryptographic content identity.
#[must_use]
pub fn sha256_hex(data: &[u8]) -> String {
    omnia_core::sha256_hex(data)
}

/// Recursively canonicalize any JSON value so all object keys are emitted in deterministic
/// lexicographical order regardless of insertion order.
#[must_use]
pub fn canonicalize_json(val: &Value) -> Value {
    match val {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k.clone(), canonicalize_json(v));
            }
            let mut out = Map::with_capacity(sorted.len());
            for (k, v) in sorted {
                out.insert(k, v);
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(canonicalize_json).collect()),
        other => other.clone(),
    }
}

/// Canonical OpenAI-compatible tool schema object (`type: "function"`) sorted alphabetically by tool name.
#[must_use]
pub fn canonicalize_openai_tools(tools: &[crate::plugin::ToolSpec]) -> Vec<Value> {
    let mut ordered: Vec<&crate::plugin::ToolSpec> = tools.iter().collect();
    ordered.sort_by(|a, b| a.name.cmp(&b.name));
    ordered
        .into_iter()
        .map(|t| {
            canonicalize_json(&serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            }))
        })
        .collect()
}

/// Rough token estimate (~3.8 chars/token for English/JSON schema mix).
#[must_use]
pub fn estimate_tokens(text: &str) -> u64 {
    ((text.len() as f64) / 3.8).ceil() as u64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCacheStats {
    pub session_key: Option<String>,
    pub system_prompt_hash: String,
    pub tool_schema_hash: String,
    pub prefix_stable: bool,
    pub prefix_mutations: u32,
    pub estimated_base_prompt_tokens: u64,
    pub uncached_input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_hit_pct: f64,
    pub lakeview_compressions: u32,
    pub lakeview_chars_saved: u64,
    pub loop_nudges: u32,
    pub recovery_attempts: u32,
}

#[derive(Debug, Clone)]
pub struct PrefixCacheGuard {
    session_key: Option<String>,
    baseline_system_hash: Option<[u8; 32]>,
    baseline_tool_hash: Option<[u8; 32]>,
    latest_system_hash: [u8; 32],
    latest_tool_hash: [u8; 32],
    prefix_mutations: u32,
    estimated_base_prompt_tokens: u64,
    pub uncached_input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub lakeview_compressions: u32,
    pub lakeview_chars_saved: u64,
    pub loop_nudges: u32,
    pub recovery_attempts: u32,
}

impl PrefixCacheGuard {
    #[must_use]
    pub fn new(
        session_key: Option<String>,
        system_prompt: &str,
        canonical_tools: &[Value],
    ) -> Self {
        let sys_hash = blake3_bytes(system_prompt.as_bytes());
        let tool_bytes = serde_json::to_vec(canonical_tools).unwrap_or_default();
        let tool_hash = blake3_bytes(&tool_bytes);
        let base_tokens =
            estimate_tokens(system_prompt) + estimate_tokens(&String::from_utf8_lossy(&tool_bytes));

        Self {
            session_key,
            baseline_system_hash: Some(sys_hash),
            baseline_tool_hash: Some(tool_hash),
            latest_system_hash: sys_hash,
            latest_tool_hash: tool_hash,
            prefix_mutations: 0,
            estimated_base_prompt_tokens: base_tokens,
            uncached_input_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            lakeview_compressions: 0,
            lakeview_chars_saved: 0,
            loop_nudges: 0,
            recovery_attempts: 0,
        }
    }

    pub fn verify_turn_prefix(&mut self, system_prompt: &str, canonical_tools: &[Value]) -> bool {
        let sys_hash = blake3_bytes(system_prompt.as_bytes());
        let tool_bytes = serde_json::to_vec(canonical_tools).unwrap_or_default();
        let tool_hash = blake3_bytes(&tool_bytes);

        self.latest_system_hash = sys_hash;
        self.latest_tool_hash = tool_hash;

        match (self.baseline_system_hash, self.baseline_tool_hash) {
            (Some(bs), Some(bt)) => {
                if bs != sys_hash || bt != tool_hash {
                    self.prefix_mutations += 1;
                    false
                } else {
                    true
                }
            }
            _ => {
                self.baseline_system_hash = Some(sys_hash);
                self.baseline_tool_hash = Some(tool_hash);
                true
            }
        }
    }

    pub fn record_usage(
        &mut self,
        uncached_input: u64,
        cache_read: u64,
        cache_write: u64,
        output: u64,
        reasoning: Option<u64>,
    ) {
        self.uncached_input_tokens += uncached_input;
        self.cache_read_tokens += cache_read;
        self.cache_write_tokens += cache_write;
        self.output_tokens += output;
        if let Some(r) = reasoning {
            self.reasoning_tokens += r;
        }
    }

    #[must_use]
    pub fn cache_hit_pct(&self) -> f64 {
        let total_input =
            self.uncached_input_tokens + self.cache_read_tokens + self.cache_write_tokens;
        if total_input == 0 {
            0.0
        } else {
            ((self.cache_read_tokens as f64 / total_input as f64) * 10000.0).round() / 100.0
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> HarnessCacheStats {
        HarnessCacheStats {
            session_key: self.session_key.clone(),
            system_prompt_hash: hex_encode_32(&self.latest_system_hash),
            tool_schema_hash: hex_encode_32(&self.latest_tool_hash),
            prefix_stable: self.prefix_mutations == 0,
            prefix_mutations: self.prefix_mutations,
            estimated_base_prompt_tokens: self.estimated_base_prompt_tokens,
            uncached_input_tokens: self.uncached_input_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            output_tokens: self.output_tokens,
            reasoning_tokens: self.reasoning_tokens,
            cache_hit_pct: self.cache_hit_pct(),
            lakeview_compressions: self.lakeview_compressions,
            lakeview_chars_saved: self.lakeview_chars_saved,
            loop_nudges: self.loop_nudges,
            recovery_attempts: self.recovery_attempts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{PluginRegistry, ToolSpec};
    use serde_json::json;

    #[test]
    fn canonicalizes_tool_schemas_deterministically() {
        let t_b = ToolSpec {
            name: "zeta_tool".into(),
            description: "Z".into(),
            parameters: json!({ "b": 2, "a": { "y": 1, "x": 0 } }),
            read_only: true,
        };
        let t_a = ToolSpec {
            name: "alpha_tool".into(),
            description: "A".into(),
            parameters: json!({ "type": "object" }),
            read_only: true,
        };
        let c1 = canonicalize_openai_tools(&[t_b.clone(), t_a.clone()]);
        let c2 = canonicalize_openai_tools(&[t_a, t_b]);
        assert_eq!(
            serde_json::to_string(&c1).unwrap(),
            serde_json::to_string(&c2).unwrap()
        );
        assert_eq!(c1[0]["function"]["name"], "alpha_tool");
    }

    #[test]
    fn prefix_cache_guard_stays_stable_and_detects_drift() {
        let reg = PluginRegistry::with_default_pillars();
        let tools = canonicalize_openai_tools(&reg.active_tools(false));
        let mut guard = PrefixCacheGuard::new(Some("s1".into()), BASE_SYSTEM_PROMPT, &tools);
        assert!(guard.verify_turn_prefix(BASE_SYSTEM_PROMPT, &tools));
        assert!(guard.snapshot().prefix_stable);

        guard.record_usage(500, 9500, 0, 200, Some(50));
        assert!((guard.cache_hit_pct() - 95.0).abs() < 0.01);

        assert!(!guard.verify_turn_prefix("mutated prompt", &tools));
        assert_eq!(guard.snapshot().prefix_mutations, 1);

        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(sha256_hex(b"abc"), blake3_hex(b"abc"));
    }
}
