//! True Dual-Queue Parallel Dispatcher (`gemini_queue` + `notebook_queue`) with independent
//! async concurrency gates, Atelier Research Studio v3 model catalog, and reasoning effort routing.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use omnia_core::{now_epoch_ms, SecretRedactor};
use omnia_harness::fold_vietnamese_ascii;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::error::NotebookError;
use crate::interactions::{InteractionSurface, QuoteRef};

/// Reasoning / thinking effort level supported across Gemini and Notebook surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffortLevel {
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

impl EffortLevel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub fn parse_strict(raw: &str) -> Result<Self, NotebookError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "minimal" => Ok(Self::Minimal),
            "low" => Ok(Self::Low),
            "medium" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" => Ok(Self::XHigh),
            "max" => Ok(Self::Max),
            other => Err(NotebookError::InvalidInput(format!(
                "unsupported reasoning effort level '{other}' (expected minimal|low|medium|high|xhigh|max)"
            ))),
        }
    }

    /// Parse English and Vietnamese effort synonyms (e.g. `low`/`thấp`, `medium`/`trung bình`,
    /// `high`/`cao`, `xhigh`/`rất cao`, `max`/`tối đa`, `minimal`/`tối thiểu`).
    pub fn parse_bilingual(raw: &str) -> Result<Self, NotebookError> {
        let folded = fold_vietnamese_ascii(raw.trim())
            .replace(['-', '_'], " ");
        let collapsed: String = folded.split_whitespace().collect::<Vec<_>>().join(" ");
        match collapsed.as_str() {
            "minimal" | "min" | "toi thieu" | "toithieu" | "nho nhat" => Ok(Self::Minimal),
            "low" | "thap" | "nhanh" | "fast" => Ok(Self::Low),
            "medium" | "med" | "normal" | "balanced" | "trung binh" | "trungbinh" | "vua" => {
                Ok(Self::Medium)
            }
            "high" | "cao" | "sau" | "deep" => Ok(Self::High),
            "xhigh" | "x high" | "extra high" | "very high" | "rat cao" | "ratcao" => {
                Ok(Self::XHigh)
            }
            "max" | "maximum" | "ultra" | "toi da" | "toida" | "cuc dai" => Ok(Self::Max),
            _ => Err(NotebookError::InvalidInput(format!(
                "unsupported reasoning effort level '{}' (expected minimal|low|medium|high|xhigh|max)",
                raw.trim()
            ))),
        }
    }
}

/// Model catalog entry exposed to Wave 3 Atelier Research Studio v3 popovers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCatalogEntry {
    pub model_id: String,
    pub display_name: String,
    pub family: String,
    pub supports_effort: bool,
    pub default_effort: EffortLevel,
    pub surfaces: Vec<InteractionSurface>,
}

/// Canonical Atelier Research Studio v3 model catalog.
#[must_use]
pub fn default_model_catalog() -> Vec<ModelCatalogEntry> {
    let both = vec![InteractionSurface::Gemini, InteractionSurface::Notebook];
    vec![
        ModelCatalogEntry {
            model_id: "gemini-3.5-flash-lite".to_string(),
            display_name: "Gemini 3.5 Flash-Lite".to_string(),
            family: "flash".to_string(),
            supports_effort: true,
            default_effort: EffortLevel::Low,
            surfaces: both.clone(),
        },
        ModelCatalogEntry {
            model_id: "gemini-4-hydrogen".to_string(),
            display_name: "Gemini 4 Hydrogen".to_string(),
            family: "hydrogen".to_string(),
            supports_effort: true,
            default_effort: EffortLevel::Medium,
            surfaces: both.clone(),
        },
        ModelCatalogEntry {
            model_id: "gemini-3.1-pro".to_string(),
            display_name: "Gemini 3.1 Pro".to_string(),
            family: "pro".to_string(),
            supports_effort: true,
            default_effort: EffortLevel::High,
            surfaces: both.clone(),
        },
        ModelCatalogEntry {
            model_id: "gemini-4-argon".to_string(),
            display_name: "Gemini 4 Argon".to_string(),
            family: "argon".to_string(),
            supports_effort: true,
            default_effort: EffortLevel::High,
            surfaces: both.clone(),
        },
        ModelCatalogEntry {
            model_id: "gemini-4-carbon".to_string(),
            display_name: "Gemini 4 Carbon".to_string(),
            family: "carbon".to_string(),
            supports_effort: true,
            default_effort: EffortLevel::High,
            surfaces: both,
        },
    ]
}

/// Dispatch request targeting either `gemini_queue` or `notebook_queue`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchRequest {
    pub request_id: String,
    pub surface: InteractionSurface,
    pub notebook_id: Option<String>,
    pub prompt: String,
    pub model_id: String,
    pub effort_level: EffortLevel,
    #[serde(default)]
    pub quotes: Vec<QuoteRef>,
    pub created_at_ms: i64,
}

impl DispatchRequest {
    /// Construct a new validated dispatch request with a generated UUID.
    #[must_use]
    pub fn new(
        surface: InteractionSurface,
        notebook_id: Option<String>,
        prompt: impl Into<String>,
        model_id: impl Into<String>,
        effort_level: EffortLevel,
    ) -> Self {
        Self {
            request_id: format!("req_{}", Uuid::new_v4().simple()),
            surface,
            notebook_id,
            prompt: SecretRedactor::redact(&prompt.into()),
            model_id: model_id.into(),
            effort_level,
            quotes: Vec::new(),
            created_at_ms: now_epoch_ms(),
        }
    }
}

/// Receipt emitted after a dispatched task completes on its surface queue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DispatchReceipt {
    pub request_id: String,
    pub surface: InteractionSurface,
    pub queue_name: String,
    pub model_id: String,
    pub effort_level: EffortLevel,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
    pub duration_ms: u64,
    pub output_markdown: String,
    pub citations: Vec<String>,
    pub metadata: Value,
}

/// Live telemetry snapshot for a single surface queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SingleQueueStats {
    pub queue_name: String,
    pub max_concurrency: usize,
    pub in_flight: usize,
    pub peak_concurrent: usize,
    pub completed: usize,
    pub failed: usize,
}

/// Combined live telemetry for both independent queues (`gemini_queue` + `notebook_queue`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DualQueueStats {
    pub gemini_queue: SingleQueueStats,
    pub notebook_queue: SingleQueueStats,
}

#[derive(Debug)]
struct QueueLane {
    name: &'static str,
    max_concurrency: usize,
    semaphore: Arc<Semaphore>,
    in_flight: AtomicUsize,
    peak_concurrent: AtomicUsize,
    completed: AtomicUsize,
    failed: AtomicUsize,
}

impl QueueLane {
    fn new(name: &'static str, max_concurrency: usize) -> Self {
        let cap = max_concurrency.max(1);
        Self {
            name,
            max_concurrency: cap,
            semaphore: Arc::new(Semaphore::new(cap)),
            in_flight: AtomicUsize::new(0),
            peak_concurrent: AtomicUsize::new(0),
            completed: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
        }
    }

    fn stats(&self) -> SingleQueueStats {
        SingleQueueStats {
            queue_name: self.name.to_string(),
            max_concurrency: self.max_concurrency,
            in_flight: self.in_flight.load(Ordering::Acquire),
            peak_concurrent: self.peak_concurrent.load(Ordering::Acquire),
            completed: self.completed.load(Ordering::Acquire),
            failed: self.failed.load(Ordering::Acquire),
        }
    }

    fn record_enter(&self) {
        let current = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        let mut peak = self.peak_concurrent.load(Ordering::Acquire);
        while current > peak {
            match self.peak_concurrent.compare_exchange_weak(
                peak,
                current,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => peak = actual,
            }
        }
    }

    fn record_exit(&self, ok: bool) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
        if ok {
            self.completed.fetch_add(1, Ordering::AcqRel);
        } else {
            self.failed.fetch_add(1, Ordering::AcqRel);
        }
    }
}

/// RAII guard ensuring `in_flight` ALWAYS decrements even if a dispatched future is cancelled/dropped.
struct InFlightGuard {
    lane: Arc<QueueLane>,
    settled: bool,
}

impl InFlightGuard {
    fn enter(lane: Arc<QueueLane>) -> Self {
        lane.record_enter();
        Self {
            lane,
            settled: false,
        }
    }

    fn finish(mut self, ok: bool) {
        self.settled = true;
        self.lane.record_exit(ok);
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if !self.settled {
            self.lane.record_exit(false);
        }
    }
}

/// True Dual-Queue Parallel Dispatcher isolating `gemini_queue` and `notebook_queue` concurrency.
///
/// Blocking or long-running jobs in `gemini_queue` NEVER starve or serialize `notebook_queue`,
/// and vice versa.
#[derive(Debug, Clone)]
pub struct DualQueueDispatcher {
    gemini_queue: Arc<QueueLane>,
    notebook_queue: Arc<QueueLane>,
    catalog: Arc<Vec<ModelCatalogEntry>>,
}

impl Default for DualQueueDispatcher {
    fn default() -> Self {
        Self::new(4, 4)
    }
}

impl DualQueueDispatcher {
    /// Create a dual-queue dispatcher with independent concurrency limits for Gemini and Notebook lanes.
    #[must_use]
    pub fn new(gemini_concurrency: usize, notebook_concurrency: usize) -> Self {
        Self {
            gemini_queue: Arc::new(QueueLane::new("gemini_queue", gemini_concurrency)),
            notebook_queue: Arc::new(QueueLane::new("notebook_queue", notebook_concurrency)),
            catalog: Arc::new(default_model_catalog()),
        }
    }

    /// Return the Atelier Research Studio v3 model catalog.
    #[must_use]
    pub fn model_catalog(&self) -> Vec<ModelCatalogEntry> {
        (*self.catalog).clone()
    }

    /// Return live concurrency and completion metrics for both queues.
    #[must_use]
    pub fn stats(&self) -> DualQueueStats {
        DualQueueStats {
            gemini_queue: self.gemini_queue.stats(),
            notebook_queue: self.notebook_queue.stats(),
        }
    }

    /// Dispatch a request to the lane matching `req.surface` (`gemini_queue` or `notebook_queue`).
    pub async fn dispatch<F, Fut>(
        &self,
        req: DispatchRequest,
        executor: F,
    ) -> Result<DispatchReceipt, NotebookError>
    where
        F: FnOnce(DispatchRequest) -> Fut,
        Fut: Future<Output = Result<(String, Vec<String>, Value), NotebookError>>,
    {
        if req.prompt.trim().is_empty() {
            return Err(NotebookError::InvalidInput(
                "dispatch prompt cannot be empty".to_string(),
            ));
        }
        if req.model_id.trim().is_empty() {
            return Err(NotebookError::InvalidInput(
                "dispatch model_id cannot be empty".to_string(),
            ));
        }

        let lane = match req.surface {
            InteractionSurface::Gemini => Arc::clone(&self.gemini_queue),
            InteractionSurface::Notebook => Arc::clone(&self.notebook_queue),
        };

        let _permit = lane.semaphore.acquire().await.map_err(|_| {
            NotebookError::InvalidInput(format!("{} semaphore closed", lane.name))
        })?;
        let guard = InFlightGuard::enter(Arc::clone(&lane));
        let started = now_epoch_ms();
        let req_id = req.request_id.clone();
        let surface = req.surface;
        let model_id = req.model_id.clone();
        let effort_level = req.effort_level;

        let result = executor(req).await;
        let finished = now_epoch_ms();
        let duration_ms = finished.saturating_sub(started).max(0) as u64;

        match result {
            Ok((output_markdown, citations, mut extra_meta)) => {
                guard.finish(true);
                if let Some(obj) = extra_meta.as_object_mut() {
                    obj.insert("queue".to_string(), json!(lane.name));
                    obj.insert("effort_level".to_string(), json!(effort_level.as_str()));
                }
                Ok(DispatchReceipt {
                    request_id: req_id,
                    surface,
                    queue_name: lane.name.to_string(),
                    model_id,
                    effort_level,
                    started_at_ms: started,
                    finished_at_ms: finished,
                    duration_ms,
                    output_markdown: SecretRedactor::redact(&output_markdown),
                    citations,
                    metadata: SecretRedactor::redact_json(&extra_meta),
                })
            }
            Err(err) => {
                guard.finish(false);
                Err(err)
            }
        }
    }

    /// Convenience wrapper targeting `gemini_queue` explicitly.
    pub async fn dispatch_gemini<F, Fut>(
        &self,
        mut req: DispatchRequest,
        executor: F,
    ) -> Result<DispatchReceipt, NotebookError>
    where
        F: FnOnce(DispatchRequest) -> Fut,
        Fut: Future<Output = Result<(String, Vec<String>, Value), NotebookError>>,
    {
        req.surface = InteractionSurface::Gemini;
        self.dispatch(req, executor).await
    }

    /// Convenience wrapper targeting `notebook_queue` explicitly.
    pub async fn dispatch_notebook<F, Fut>(
        &self,
        mut req: DispatchRequest,
        executor: F,
    ) -> Result<DispatchReceipt, NotebookError>
    where
        F: FnOnce(DispatchRequest) -> Fut,
        Fut: Future<Output = Result<(String, Vec<String>, Value), NotebookError>>,
    {
        req.surface = InteractionSurface::Notebook;
        self.dispatch(req, executor).await
    }
}
