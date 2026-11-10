//! Native-first shell boundary contract.
//!
//! This module is intentionally a measurement and admission seam, not a replacement
//! for the current Tauri projection. It keeps the candidate native shell behind a
//! feature gate and refuses promotion when a benchmark sample is incomplete.

use serde::{Deserialize, Serialize};

pub const BOUNDARY_ID: &str = "NATIVE-RUST-BOUNDARY-001";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundaryState {
    Baseline,
    Candidate,
    Promoted,
    RolledBack,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceSample {
    pub startup_ms: u64,
    pub idle_rss_bytes: u64,
    pub peak_rss_bytes: u64,
    pub cpu_percent: f32,
    pub gpu_percent: f32,
    pub input_latency_p95_ms: u64,
    pub binary_bytes: u64,
    pub close_reopen_ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundaryBudget {
    pub max_startup_regression_percent: f32,
    pub max_idle_rss_regression_percent: f32,
    pub max_peak_rss_regression_percent: f32,
    /// Maximum allowed candidate binary-size growth relative to baseline.
    ///
    /// This is a percentage budget, consistent with the startup/RSS budgets.
    /// The field is serde-defaulted so receipts written before this field was
    /// introduced remain readable and are evaluated with the conservative
    /// default.
    #[serde(default = "default_binary_regression_percent")]
    pub max_binary_regression_percent: f32,
    pub max_input_latency_p95_ms: u64,
}

fn default_binary_regression_percent() -> f32 {
    10.0
}

impl Default for BoundaryBudget {
    fn default() -> Self {
        Self {
            max_startup_regression_percent: 10.0,
            max_idle_rss_regression_percent: 10.0,
            max_peak_rss_regression_percent: 10.0,
            max_binary_regression_percent: default_binary_regression_percent(),
            max_input_latency_p95_ms: 50,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundaryFailure {
    FeatureDisabled,
    MissingBaseline,
    InvalidBudget,
    InvalidSample,
    InvalidUnsupportedCapability,
    NonFiniteMetric,
    StartupRegression,
    IdleRssRegression,
    PeakRssRegression,
    BinarySizeRegression,
    InputLatency,
    CloseReopen,
}

fn valid_percent(value: f32) -> bool {
    value.is_finite() && (0.0..=100.0).contains(&value)
}

fn valid_budget(budget: &BoundaryBudget) -> bool {
    budget.max_startup_regression_percent.is_finite()
        && budget.max_startup_regression_percent >= 0.0
        && budget.max_startup_regression_percent <= 100_000.0
        && budget.max_idle_rss_regression_percent.is_finite()
        && budget.max_idle_rss_regression_percent >= 0.0
        && budget.max_idle_rss_regression_percent <= 100_000.0
        && budget.max_peak_rss_regression_percent.is_finite()
        && budget.max_peak_rss_regression_percent >= 0.0
        && budget.max_peak_rss_regression_percent <= 100_000.0
        && budget.max_binary_regression_percent.is_finite()
        && budget.max_binary_regression_percent >= 0.0
        && budget.max_binary_regression_percent <= 100_000.0
}

/// Compare integer measurements against the exact IEEE-754 f32 budget value.
/// Validated budgets are <=100_000, so their binary exponent is negative.
/// u64 * 24-bit significand fits u128; dividing before shifting preserves floor.
fn exceeds_regression(base: u64, candidate: u64, percent: f32) -> bool {
    debug_assert!(percent.is_finite() && (0.0..=100_000.0).contains(&percent));
    let bits = percent.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32;
    let fraction = bits & 0x7fffff;
    let (significand, shift) = if exponent == 0 {
        (fraction, 149)
    } else {
        (fraction | (1 << 23), (150 - exponent) as u32)
    };
    let scaled = u128::from(base) * u128::from(significand) / 100;
    let allowance = scaled.checked_shr(shift).unwrap_or(0);
    u128::from(candidate) > u128::from(base) + allowance
}

fn valid_sample(sample: &ResourceSample) -> bool {
    sample.startup_ms > 0
        && sample.idle_rss_bytes > 0
        && sample.peak_rss_bytes >= sample.idle_rss_bytes
        && sample.binary_bytes > 0
        && valid_percent(sample.cpu_percent)
        && valid_percent(sample.gpu_percent)
}

fn valid_capability_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._:-".contains(byte)
        })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundaryEvaluation {
    pub boundary_id: String,
    pub schema_version: u32,
    pub state: BoundaryState,
    pub passed: bool,
    pub failures: Vec<BoundaryFailure>,
    pub unsupported_capabilities: Vec<String>,
    pub rollback_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeBoundaryReceipt {
    pub boundary_id: String,
    pub schema_version: u32,
    pub baseline: Option<ResourceSample>,
    pub candidate: ResourceSample,
    pub budget: BoundaryBudget,
    pub evaluation: BoundaryEvaluation,
    pub source_revision: String,
    pub measured_at: String,
    pub limitations: Vec<String>,
}

pub fn evaluate(
    baseline: Option<&ResourceSample>,
    candidate: &ResourceSample,
    budget: &BoundaryBudget,
    unsupported_capabilities: Vec<String>,
) -> BoundaryEvaluation {
    let mut failures = Vec::new();
    let mut state = BoundaryState::Candidate;
    if baseline.is_none() {
        failures.push(BoundaryFailure::MissingBaseline);
    }
    if !valid_budget(budget) {
        failures.push(BoundaryFailure::InvalidBudget);
    }
    if !valid_sample(candidate) || baseline.is_some_and(|sample| !valid_sample(sample)) {
        failures.push(BoundaryFailure::InvalidSample);
    }
    if unsupported_capabilities
        .iter()
        .any(|capability| !valid_capability_id(capability))
    {
        failures.push(BoundaryFailure::InvalidUnsupportedCapability);
    }
    let metrics = [candidate.cpu_percent, candidate.gpu_percent];
    if metrics
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        failures.push(BoundaryFailure::NonFiniteMetric);
    }
    if valid_budget(budget) && candidate.input_latency_p95_ms > budget.max_input_latency_p95_ms {
        failures.push(BoundaryFailure::InputLatency);
    }
    if !candidate.close_reopen_ok {
        failures.push(BoundaryFailure::CloseReopen);
    }
    if valid_budget(budget) {
        if let Some(base) = baseline {
            if exceeds_regression(
                base.startup_ms,
                candidate.startup_ms,
                budget.max_startup_regression_percent,
            ) {
                failures.push(BoundaryFailure::StartupRegression);
            }
            if exceeds_regression(
                base.idle_rss_bytes,
                candidate.idle_rss_bytes,
                budget.max_idle_rss_regression_percent,
            ) {
                failures.push(BoundaryFailure::IdleRssRegression);
            }
            if exceeds_regression(
                base.peak_rss_bytes,
                candidate.peak_rss_bytes,
                budget.max_peak_rss_regression_percent,
            ) {
                failures.push(BoundaryFailure::PeakRssRegression);
            }
            if exceeds_regression(
                base.binary_bytes,
                candidate.binary_bytes,
                budget.max_binary_regression_percent,
            ) {
                failures.push(BoundaryFailure::BinarySizeRegression);
            }
        }
    }
    let passed = failures.is_empty();
    if passed {
        state = BoundaryState::Promoted;
    }
    BoundaryEvaluation {
        boundary_id: BOUNDARY_ID.to_string(),
        schema_version: SCHEMA_VERSION,
        state,
        passed,
        rollback_required: !passed,
        failures,
        unsupported_capabilities,
    }
}

/// Evaluate a candidate only when the native shell feature has been explicitly
/// enabled by the caller. The default product path must pass `false` until the
/// benchmark and packaged evidence gates are satisfied.
pub fn evaluate_if_enabled(
    enabled: bool,
    baseline: Option<&ResourceSample>,
    candidate: &ResourceSample,
    budget: &BoundaryBudget,
    unsupported_capabilities: Vec<String>,
) -> BoundaryEvaluation {
    if !enabled {
        return BoundaryEvaluation {
            boundary_id: BOUNDARY_ID.to_string(),
            schema_version: SCHEMA_VERSION,
            state: BoundaryState::Baseline,
            passed: false,
            failures: vec![BoundaryFailure::FeatureDisabled],
            unsupported_capabilities,
            rollback_required: false,
        };
    }
    evaluate(baseline, candidate, budget, unsupported_capabilities)
}

pub fn rollback_receipt(receipt: &NativeBoundaryReceipt) -> NativeBoundaryReceipt {
    let mut rolled = receipt.clone();
    rolled.evaluation.state = BoundaryState::RolledBack;
    rolled.evaluation.rollback_required = false;
    rolled.evaluation.passed = false;
    rolled
        .limitations
        .push("Candidate was not promoted; current projection remains authoritative.".to_string());
    rolled
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(startup_ms: u64, rss: u64, latency: u64, reopen: bool) -> ResourceSample {
        ResourceSample {
            startup_ms,
            idle_rss_bytes: rss,
            peak_rss_bytes: rss * 2,
            cpu_percent: 1.0,
            gpu_percent: 0.0,
            input_latency_p95_ms: latency,
            binary_bytes: 10,
            close_reopen_ok: reopen,
        }
    }

    #[test]
    fn promotes_only_with_complete_budget_sample() {
        let baseline = sample(100, 100, 20, true);
        let candidate = sample(105, 105, 30, true);
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec!["browser-webview".into()],
        );
        assert!(result.passed);
        assert_eq!(result.state, BoundaryState::Promoted);
        assert_eq!(result.unsupported_capabilities, vec!["browser-webview"]);
    }

    #[test]
    fn missing_baseline_is_fail_closed() {
        let result = evaluate(
            None,
            &sample(1, 1, 1, true),
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(!result.passed);
        assert!(result.failures.contains(&BoundaryFailure::MissingBaseline));
        assert!(result.rollback_required);
    }

    #[test]
    fn disabled_feature_cannot_promote_candidate() {
        let sample = sample(1, 1, 1, true);
        let result = evaluate_if_enabled(
            false,
            Some(&sample),
            &sample,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(!result.passed);
        assert_eq!(result.state, BoundaryState::Baseline);
        assert!(result.failures.contains(&BoundaryFailure::FeatureDisabled));
    }

    #[test]
    fn regression_and_reopen_failure_require_rollback() {
        let baseline = sample(100, 100, 20, true);
        let candidate = sample(200, 200, 51, false);
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(!result.passed);
        assert!(result
            .failures
            .contains(&BoundaryFailure::StartupRegression));
        assert!(result
            .failures
            .contains(&BoundaryFailure::IdleRssRegression));
        assert!(result
            .failures
            .contains(&BoundaryFailure::PeakRssRegression));
        assert!(result.failures.contains(&BoundaryFailure::InputLatency));
        assert!(result.failures.contains(&BoundaryFailure::CloseReopen));
        let receipt = NativeBoundaryReceipt {
            boundary_id: BOUNDARY_ID.into(),
            schema_version: SCHEMA_VERSION,
            baseline: Some(baseline),
            candidate,
            budget: BoundaryBudget::default(),
            evaluation: result,
            source_revision: "test".into(),
            measured_at: "2026-11-10T00:00:00Z".into(),
            limitations: vec![],
        };
        assert_eq!(
            rollback_receipt(&receipt).evaluation.state,
            BoundaryState::RolledBack
        );
    }

    #[test]
    fn rejects_non_finite_resource_metrics() {
        let baseline = sample(1, 1, 1, true);
        let mut candidate = sample(1, 1, 1, true);
        candidate.cpu_percent = f32::NAN;
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(result.failures.contains(&BoundaryFailure::NonFiniteMetric));
    }

    #[test]
    fn rejects_invalid_budget_without_comparing_metrics() {
        let baseline = sample(100, 100, 10, true);
        let candidate = sample(101, 101, 10, true);
        let budget = BoundaryBudget {
            max_startup_regression_percent: -1.0,
            ..BoundaryBudget::default()
        };
        let result = evaluate(Some(&baseline), &candidate, &budget, vec![]);
        assert!(!result.passed);
        assert!(result.failures.contains(&BoundaryFailure::InvalidBudget));
        assert!(!result
            .failures
            .contains(&BoundaryFailure::StartupRegression));
        assert!(!result
            .failures
            .contains(&BoundaryFailure::BinarySizeRegression));
    }

    #[test]
    fn binary_size_budget_rejects_growth_above_threshold() {
        let baseline = sample(100, 100, 10, true);
        let mut candidate = sample(100, 100, 10, true);
        candidate.binary_bytes = 111;
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(result
            .failures
            .contains(&BoundaryFailure::BinarySizeRegression));
        assert!(!result.passed);
    }

    #[test]
    fn binary_size_budget_allows_growth_at_threshold() {
        let baseline = sample(100, 100, 10, true);
        let mut candidate = sample(100, 100, 10, true);
        candidate.binary_bytes = 11;
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(!result
            .failures
            .contains(&BoundaryFailure::BinarySizeRegression));
        assert!(result.passed);
    }

    #[test]
    fn binary_budget_rejects_non_finite_and_negative_values() {
        let baseline = sample(100, 100, 10, true);
        let candidate = sample(100, 100, 10, true);
        for value in [f32::NAN, f32::INFINITY, -1.0] {
            let budget = BoundaryBudget {
                max_binary_regression_percent: value,
                ..BoundaryBudget::default()
            };
            let result = evaluate(Some(&baseline), &candidate, &budget, vec![]);
            assert!(result.failures.contains(&BoundaryFailure::InvalidBudget));
            assert!(!result
                .failures
                .contains(&BoundaryFailure::BinarySizeRegression));
        }
    }

    #[test]
    fn rejects_zero_or_inconsistent_samples() {
        let mut baseline = sample(100, 100, 10, true);
        baseline.binary_bytes = 0;
        let mut candidate = sample(101, 101, 10, true);
        candidate.peak_rss_bytes = 1;
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(!result.passed);
        assert!(result.failures.contains(&BoundaryFailure::InvalidSample));
    }

    #[test]
    fn rejects_malformed_unsupported_capability_ids() {
        let baseline = sample(100, 100, 10, true);
        let candidate = sample(101, 101, 10, true);
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec!["Browser-WebView".into()],
        );
        assert!(!result.passed);
        assert!(result
            .failures
            .contains(&BoundaryFailure::InvalidUnsupportedCapability));
    }

    #[test]
    fn rejects_out_of_range_percent_metrics() {
        let baseline = sample(100, 100, 10, true);
        let mut candidate = sample(101, 101, 10, true);
        candidate.gpu_percent = 101.0;
        let result = evaluate(
            Some(&baseline),
            &candidate,
            &BoundaryBudget::default(),
            vec![],
        );
        assert!(!result.passed);
        assert!(result.failures.contains(&BoundaryFailure::InvalidSample));
    }
    #[test]
    fn exact_regression_comparison_preserves_large_integer_boundaries() {
        let base = 1_u64 << 53;
        assert!(exceeds_regression(base, base + 1, 0.0));
        assert!(!exceeds_regression(u64::MAX, u64::MAX, 0.0));
        assert!(exceeds_regression(u64::MAX - 1, u64::MAX, 0.0));
        assert!(!exceeds_regression(u64::MAX, u64::MAX, 100_000.0));
        assert!(exceeds_regression(100, 111, 10.0));
        assert!(!exceeds_regression(100, 110, 10.0));
        assert!(exceeds_regression(100, 101, f32::from_bits(1)));
        assert!(exceeds_regression(100, 101, -0.0));
        assert!(!exceeds_regression(400, 401, 0.25));
        assert!(exceeds_regression(400, 402, 0.25));
    }

    #[test]
    fn zero_budget_rejects_single_unit_growth_above_f64_precision_for_all_metrics() {
        let value = 1_u64 << 53;
        let mut base = sample(value, value, 1, true);
        base.binary_bytes = value;
        let mut candidate = base.clone();
        candidate.startup_ms += 1;
        candidate.idle_rss_bytes += 1;
        candidate.peak_rss_bytes += 1;
        candidate.binary_bytes += 1;
        let budget = BoundaryBudget {
            max_startup_regression_percent: 0.0,
            max_idle_rss_regression_percent: 0.0,
            max_peak_rss_regression_percent: 0.0,
            max_binary_regression_percent: 0.0,
            ..BoundaryBudget::default()
        };
        let evaluation = evaluate(Some(&base), &candidate, &budget, vec![]);
        for expected in [
            BoundaryFailure::StartupRegression,
            BoundaryFailure::IdleRssRegression,
            BoundaryFailure::PeakRssRegression,
            BoundaryFailure::BinarySizeRegression,
        ] {
            assert!(evaluation.failures.contains(&expected));
        }
    }
}
