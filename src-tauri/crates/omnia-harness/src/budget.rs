//! Shared, request-boundary token budgeting for one agent session.
//!
//! A single ledger is cloned into the root agent's tool context and all child
//! contexts. Usage is charged as provider-reported deltas are consumed, including
//! summarization requests and usage observed before a later error/cancellation;
//! admission is checked immediately before every model request. The ledger is
//! intentionally small and synchronous: no lock is held across an await.

use std::sync::{Arc, Mutex};

use crate::{HarnessError, Usage};

/// The one budget state shared by a root agent and all of its descendants.
#[derive(Debug)]
pub struct TokenBudgetLedger {
    state: Mutex<State>,
}

/// Cloneable handle carried by ToolContext.
pub type SharedTokenBudget = Arc<TokenBudgetLedger>;

#[derive(Debug)]
struct State {
    limit: Option<u64>,
    used: u64,
    warned: bool,
}

/// A stable view used by tests and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenBudgetSnapshot {
    pub limit: Option<u64>,
    pub used: u64,
    pub warned: bool,
}

/// Warning emitted exactly once when a limited ledger crosses 80%.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenBudgetWarning {
    pub used: u64,
    pub budget: u64,
}

impl TokenBudgetLedger {
    /// Creates a ledger seeded with usage from earlier runs.
    pub fn new(limit: Option<u64>, initial_used: u64) -> SharedTokenBudget {
        let warned = limit.is_some_and(|budget| crosses_warning(initial_used, budget));
        Arc::new(Self {
            state: Mutex::new(State {
                limit,
                used: initial_used,
                warned,
            }),
        })
    }

    /// Rejects a new model request after known usage reaches its limit.
    pub fn admit(&self) -> Result<(), HarnessError> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(budget) = state.limit {
            if state.used >= budget {
                return Err(HarnessError::BudgetExceeded {
                    used: state.used,
                    budget,
                });
            }
        }
        Ok(())
    }

    /// Charges one observed usage delta using the existing input-plus-output
    /// definition. Returns the one shared warning, if this crossed 80%.
    pub fn record(&self, usage: &Usage) -> Option<TokenBudgetWarning> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let delta = usage.input_tokens.saturating_add(usage.output_tokens);
        state.used = state.used.saturating_add(delta);
        let budget = state.limit?;
        if !state.warned && crosses_warning(state.used, budget) {
            state.warned = true;
            return Some(TokenBudgetWarning {
                used: state.used,
                budget,
            });
        }
        None
    }

    pub fn snapshot(&self) -> TokenBudgetSnapshot {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        TokenBudgetSnapshot {
            limit: state.limit,
            used: state.used,
            warned: state.warned,
        }
    }
}

fn crosses_warning(used: u64, budget: u64) -> bool {
    u128::from(used) * 5 >= u128::from(budget) * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturates_and_warns_once() {
        let ledger = TokenBudgetLedger::new(Some(u64::MAX), 0);
        let usage = Usage {
            input_tokens: u64::MAX,
            output_tokens: u64::MAX,
            ..Usage::default()
        };
        let first = ledger.record(&usage);
        assert_eq!(ledger.snapshot().used, u64::MAX);
        assert!(first.is_some());
        assert!(ledger.record(&Usage::default()).is_none());
        assert_eq!(ledger.snapshot().used, u64::MAX);
    }

    #[test]
    fn prior_usage_seeds_admission_and_warning() {
        let ledger = TokenBudgetLedger::new(Some(100), 80);
        assert!(ledger.admit().is_ok());
        assert!(ledger.snapshot().warned);
        ledger.record(&Usage {
            input_tokens: 20,
            ..Usage::default()
        });
        assert!(matches!(
            ledger.admit(),
            Err(HarnessError::BudgetExceeded {
                used: 100,
                budget: 100
            })
        ));
    }
}
