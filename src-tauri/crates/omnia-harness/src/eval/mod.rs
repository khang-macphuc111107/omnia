//! Deterministic, offline eval suite for the harness.
//!
//! A scenario (`evals/*.json`) describes a workspace fixture, permission
//! settings, user prompts, a scripted model and assertions. [`run_scenario`]
//! builds a real [`Agent`](crate::agent::Agent) with the real built-in tools,
//! hooks, checkpoints, compaction and subagents, replaces only the model with
//! a [`ScriptedProvider`], and reports what the harness did. No network, no
//! credentials. See `evals/README.md`.

mod check;
mod fixture;
mod runner;
pub mod scenario;
mod script;

pub use fixture::{docx_bytes, zip_stored};
pub use runner::{
    evals_dir, run_loaded, run_scenario, run_scenario_with, scenario_files, EvalReport, RunOptions,
};
pub use script::{LoggedRequest, ScriptedProvider};

/// Plain-text summary table of reports.
pub fn summary_table(reports: &[EvalReport]) -> String {
    let width = reports
        .iter()
        .map(|r| r.name.len())
        .max()
        .unwrap_or(8)
        .max(8);
    let mut out = format!(
        "{:<width$}  {:<5}  {:>5}  {:>5}  {:>7}  {:>8}\n",
        "scenario", "state", "turns", "tools", "tokens", "ms"
    );
    for report in reports {
        let state = if report.skipped.is_some() {
            "SKIP"
        } else if report.passed {
            "PASS"
        } else {
            "FAIL"
        };
        out.push_str(&format!(
            "{:<width$}  {:<5}  {:>5}  {:>5}  {:>7}  {:>8}\n",
            report.name,
            state,
            report.turns,
            report.tool_calls,
            report.tokens.input_tokens + report.tokens.output_tokens,
            report.duration.as_millis()
        ));
    }
    let passed = reports
        .iter()
        .filter(|r| r.passed && r.skipped.is_none())
        .count();
    let skipped = reports.iter().filter(|r| r.skipped.is_some()).count();
    let failed = reports.iter().filter(|r| !r.passed).count();
    out.push_str(&format!(
        "{passed} passed, {failed} failed, {skipped} skipped, {} total\n",
        reports.len()
    ));
    for report in reports.iter().filter(|r| !r.passed) {
        out.push_str(&format!("\nFAIL {}\n", report.name));
        for failure in &report.failures {
            out.push_str(&format!("  - {failure}\n"));
        }
    }
    out
}
