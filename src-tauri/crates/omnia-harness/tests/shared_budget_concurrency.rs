//! Deterministic concurrent tests of the budget handle cloned into child contexts.
//!
//! These tests deliberately admit every sibling before any completion is charged.
//! Admission is a request-boundary check: already-admitted requests may overshoot.

use std::sync::{Arc, Barrier};
use std::thread;

use omnia_harness::{
    HarnessError, HarnessResult, TokenBudgetLedger, TokenBudgetSnapshot, TokenBudgetWarning,
    ToolContext, Usage,
};

#[derive(Debug)]
struct SiblingOutcome {
    initial_admission: HarnessResult<()>,
    warning: Option<TokenBudgetWarning>,
    next_admission: HarnessResult<()>,
}

fn complete_concurrent_siblings(
    parent: &ToolContext,
    sibling_count: usize,
    usage: Usage,
) -> (TokenBudgetSnapshot, Vec<SiblingOutcome>) {
    assert!(sibling_count > 1);
    let parent_budget = parent.token_budget.as_ref().expect("parent budget");

    // Validate context propagation before starting threads, so an assertion cannot
    // strand an already-running sibling at a barrier.
    let sibling_budgets: Vec<_> = (0..sibling_count)
        .map(|_| parent.clone().token_budget.expect("inherited budget"))
        .collect();
    for budget in &sibling_budgets {
        assert!(Arc::ptr_eq(parent_budget, budget));
    }

    let all_admitted = Arc::new(Barrier::new(sibling_count + 1));
    let release_completions = Arc::new(Barrier::new(sibling_count + 1));
    let all_charged = Arc::new(Barrier::new(sibling_count));
    let siblings: Vec<_> = sibling_budgets
        .into_iter()
        .map(|budget| {
            let all_admitted = Arc::clone(&all_admitted);
            let release_completions = Arc::clone(&release_completions);
            let all_charged = Arc::clone(&all_charged);
            thread::spawn(move || {
                let initial_admission = budget.admit();
                all_admitted.wait();
                release_completions.wait();

                let warning = if initial_admission.is_ok() {
                    budget.record(&usage)
                } else {
                    None
                };
                // Every sibling's next request sees all completed sibling usage.
                all_charged.wait();
                SiblingOutcome {
                    initial_admission,
                    warning,
                    next_admission: budget.admit(),
                }
            })
        })
        .collect();

    all_admitted.wait();
    let before_completions = parent_budget.snapshot();
    // Do not assert until after releasing and joining all workers.
    release_completions.wait();
    let outcomes = siblings
        .into_iter()
        .map(|sibling| sibling.join().expect("sibling thread panicked"))
        .collect();
    (before_completions, outcomes)
}

fn assert_budget_exceeded(result: &HarnessResult<()>, expected_used: u64, expected_budget: u64) {
    match result {
        Err(HarnessError::BudgetExceeded { used, budget }) => {
            assert_eq!((*used, *budget), (expected_used, expected_budget));
        }
        other => panic!("expected shared budget rejection, got {other:?}"),
    }
}

#[test]
fn concurrent_siblings_share_charges_warn_once_and_block_later_requests() {
    let mut parent = ToolContext::new(".");
    parent.token_budget = Some(TokenBudgetLedger::new(Some(100), 20));
    let budget = parent.token_budget.as_ref().unwrap();

    let (before_completions, outcomes) = complete_concurrent_siblings(
        &parent,
        4,
        Usage {
            input_tokens: 20,
            output_tokens: 10,
            ..Usage::default()
        },
    );

    assert_eq!(before_completions.used, 20);
    assert!(!before_completions.warned);
    assert!(outcomes
        .iter()
        .all(|outcome| outcome.initial_admission.is_ok()));
    assert_eq!(budget.snapshot().used, 140);
    assert!(budget.snapshot().warned);
    let warnings: Vec<_> = outcomes
        .iter()
        .filter_map(|outcome| outcome.warning)
        .collect();
    assert_eq!(
        warnings,
        vec![TokenBudgetWarning {
            used: 80,
            budget: 100
        }]
    );
    for outcome in &outcomes {
        assert_budget_exceeded(&outcome.next_admission, 140, 100);
    }
    assert_budget_exceeded(&budget.admit(), 140, 100);
    assert!(budget.record(&Usage::default()).is_none());
}

#[test]
fn concurrent_saturating_completions_cannot_wrap_or_repeat_warning() {
    let mut parent = ToolContext::new(".");
    parent.token_budget = Some(TokenBudgetLedger::new(Some(u64::MAX), 0));
    let budget = parent.token_budget.as_ref().unwrap();

    let (before_completions, outcomes) = complete_concurrent_siblings(
        &parent,
        8,
        Usage {
            input_tokens: u64::MAX,
            output_tokens: u64::MAX,
            ..Usage::default()
        },
    );

    assert_eq!(before_completions.used, 0);
    assert!(outcomes
        .iter()
        .all(|outcome| outcome.initial_admission.is_ok()));
    assert_eq!(budget.snapshot().used, u64::MAX);
    let warnings: Vec<_> = outcomes
        .iter()
        .filter_map(|outcome| outcome.warning)
        .collect();
    assert_eq!(
        warnings,
        vec![TokenBudgetWarning {
            used: u64::MAX,
            budget: u64::MAX
        }]
    );
    for outcome in &outcomes {
        assert_budget_exceeded(&outcome.next_admission, u64::MAX, u64::MAX);
    }
    assert_budget_exceeded(&budget.admit(), u64::MAX, u64::MAX);
}

#[test]
fn unlimited_shared_ledger_counts_concurrent_usage_without_blocking() {
    let mut parent = ToolContext::new(".");
    parent.token_budget = Some(TokenBudgetLedger::new(None, 17));
    let budget = parent.token_budget.as_ref().unwrap();

    let (before_completions, outcomes) = complete_concurrent_siblings(
        &parent,
        8,
        Usage {
            input_tokens: 2,
            output_tokens: 3,
            ..Usage::default()
        },
    );

    assert_eq!(before_completions.used, 17);
    assert_eq!(budget.snapshot().used, 57);
    assert!(!budget.snapshot().warned);
    assert!(outcomes.iter().all(|outcome| {
        outcome.initial_admission.is_ok()
            && outcome.next_admission.is_ok()
            && outcome.warning.is_none()
    }));
    assert!(budget.admit().is_ok());
}
