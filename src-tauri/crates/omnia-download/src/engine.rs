//! Job manager: queueing, concurrency limit, pause / resume / cancel, persistence, events.

use crate::blob::BlobAssembler;
use crate::dash_download::download_dash;
use crate::error::{DownloadError, Result};
use crate::fetch::Fetcher;
use crate::fsutil::{move_file, sanitize_file_name, unique_path};
use crate::hls_download::{download_hls, StreamOptions, StreamOutput};
use crate::http::{cleanup_partial, download_http, HttpOptions};
use crate::mux::{find_ffmpeg, mux_cancellable, MuxOutcome};
use crate::probe::file_name_from_url;
use crate::progress::ProgressTracker;
use crate::ratelimit::TokenBucket;
use crate::request::{build_client, RequestSpec};
use crate::types::{Progress, Quality};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

pub type JobId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobKind {
    /// Plain (segmented) HTTP download.
    Http,
    /// HLS stream (master or media playlist URL in `request`).
    Hls { quality: Quality },
    /// DASH stream (MPD URL in `request`).
    Dash { quality: Quality },
    /// Chunks pushed by the browser layer through [`DownloadEngine::blob_chunk`]; `request.url`
    /// is informational only.
    Blob,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub kind: JobKind,
    pub request: RequestSpec,
    pub dest_dir: PathBuf,
    #[serde(default)]
    pub file_name: Option<String>,
    /// HTTP only; defaults to the engine setting (8).
    #[serde(default)]
    pub connections: Option<usize>,
    /// Bytes per second.
    #[serde(default)]
    pub speed_limit: Option<u64>,
    /// HLS / DASH: mux with ffmpeg into one MP4 when available.
    #[serde(default = "default_true")]
    pub mux: bool,
}

impl JobSpec {
    pub fn new(kind: JobKind, request: RequestSpec, dest_dir: impl Into<PathBuf>) -> Self {
        Self {
            kind,
            request,
            dest_dir: dest_dir.into(),
            file_name: None,
            connections: None,
            speed_limit: None,
            mux: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Downloading,
    Paused,
    Muxing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: JobId,
    pub spec: JobSpec,
    pub status: JobStatus,
    pub progress: Progress,
    /// Final file (the muxed file, or the main raw track).
    pub output_path: Option<PathBuf>,
    /// Additional outputs (e.g. the separate audio track when muxing was skipped).
    pub extra_outputs: Vec<PathBuf>,
    pub mux: Option<MuxOutcome>,
    pub error: Option<String>,
    /// Machine readable error class (`drmProtected`, `network`, ...).
    pub error_code: Option<String>,
    /// Unix milliseconds.
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[allow(clippy::large_enum_variant)] // short-lived event value; boxing would change the public serde-facing shape
pub enum JobEvent {
    Added {
        job: JobSnapshot,
    },
    Progress {
        id: JobId,
        progress: Progress,
    },
    Status {
        id: JobId,
        status: JobStatus,
        error: Option<String>,
        error_code: Option<String>,
    },
    Completed {
        id: JobId,
        output_path: Option<PathBuf>,
    },
    Removed {
        id: JobId,
    },
}

#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// JSON file holding the persisted job list.
    pub state_file: PathBuf,
    pub max_active: usize,
    pub default_connections: usize,
    pub max_retries: u32,
    pub retry_base_delay: Duration,
    pub hls_concurrency: usize,
    pub ffmpeg_path: Option<PathBuf>,
    pub min_split_size: u64,
}

impl EngineConfig {
    pub fn new(state_file: impl Into<PathBuf>) -> Self {
        Self {
            state_file: state_file.into(),
            max_active: 3,
            default_connections: 16,
            max_retries: 5,
            retry_base_delay: Duration::from_millis(500),
            hls_concurrency: 6,
            ffmpeg_path: None,
            min_split_size: 512 * 1024,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Intent {
    None,
    Pause,
    Cancel,
    Remove,
}

struct Entry {
    snap: JobSnapshot,
    cancel: Option<CancellationToken>,
    stop: CancellationToken,
    intent: Intent,
    http_target: Option<PathBuf>,
    work_dir: Option<PathBuf>,
    blob: Option<BlobAssembler>,
    restored: bool,
}

struct Inner {
    cfg: Mutex<EngineConfig>,
    jobs: Mutex<Vec<Entry>>,
    tx: broadcast::Sender<JobEvent>,
    client: reqwest::Client,
    persist_lock: Mutex<()>,
}

#[derive(Clone)]
pub struct DownloadEngine {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn error_code(e: &DownloadError) -> String {
    serde_json::to_value(e)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str().map(str::to_string)))
        .unwrap_or_else(|| "other".into())
}

fn stem_for(spec: &JobSpec) -> String {
    let name = spec
        .file_name
        .clone()
        .or_else(|| file_name_from_url(&spec.request.url))
        .map(|n| sanitize_file_name(&n))
        .unwrap_or_else(|| "video".into());
    let p = Path::new(&name);
    let stem = match p.extension().and_then(|e| e.to_str()) {
        Some(e) if e.len() <= 5 => p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&name)
            .to_string(),
        _ => name.clone(),
    };
    if stem.is_empty() {
        "video".into()
    } else {
        stem
    }
}

impl DownloadEngine {
    /// Create an engine, restoring the persisted job list. Restored jobs that were running or
    /// queued come back `Paused`; call [`resume`](Self::resume) to continue them.
    pub fn new(cfg: EngineConfig) -> Result<Self> {
        let (tx, _) = broadcast::channel(2048);
        let mut entries = Vec::new();
        if let Ok(bytes) = std::fs::read(&cfg.state_file) {
            if let Ok(snaps) = serde_json::from_slice::<Vec<JobSnapshot>>(&bytes) {
                for mut snap in snaps {
                    match snap.status {
                        JobStatus::Queued | JobStatus::Downloading | JobStatus::Muxing => {
                            if snap.spec.kind == JobKind::Blob {
                                snap.status = JobStatus::Failed;
                                snap.error = Some("interrupted by application exit".into());
                            } else {
                                snap.status = JobStatus::Paused;
                            }
                        }
                        _ => {}
                    }
                    snap.progress.speed_bps = 0.0;
                    snap.progress.eta_secs = None;
                    snap.progress.connections = 0;
                    entries.push(Entry {
                        snap,
                        cancel: None,
                        stop: CancellationToken::new(),
                        intent: Intent::None,
                        http_target: None,
                        work_dir: None,
                        blob: None,
                        restored: true,
                    });
                }
            }
        }
        Ok(Self {
            inner: Arc::new(Inner {
                cfg: Mutex::new(cfg),
                jobs: Mutex::new(entries),
                tx,
                client: build_client()?,
                persist_lock: Mutex::new(()),
            }),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<JobEvent> {
        self.inner.tx.subscribe()
    }

    pub fn list(&self) -> Vec<JobSnapshot> {
        self.inner
            .jobs
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.snap.clone())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<JobSnapshot> {
        self.inner
            .jobs
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.snap.id == id)
            .map(|e| e.snap.clone())
    }

    pub fn set_max_active(&self, n: usize) {
        self.inner.cfg.lock().unwrap().max_active = n.max(1);
        self.inner.schedule();
    }

    pub fn set_ffmpeg_path(&self, p: Option<PathBuf>) {
        self.inner.cfg.lock().unwrap().ffmpeg_path = p;
    }

    /// Add a job. Must be called inside a Tokio runtime (it may start immediately).
    pub fn add(&self, spec: JobSpec) -> Result<JobId> {
        if spec.kind != JobKind::Blob {
            let u = url::Url::parse(&spec.request.url)?;
            if !matches!(u.scheme(), "http" | "https") {
                return Err(DownloadError::InvalidRequest(format!(
                    "unsupported URL scheme {:?}",
                    u.scheme()
                )));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut blob = None;
        let mut status = JobStatus::Queued;
        if spec.kind == JobKind::Blob {
            let name = spec.file_name.clone().unwrap_or_else(|| "blob.bin".into());
            blob = Some(BlobAssembler::new(&spec.dest_dir, &name)?);
            status = JobStatus::Downloading;
        }
        let snap = JobSnapshot {
            id: id.clone(),
            spec,
            status,
            progress: Progress::default(),
            output_path: None,
            extra_outputs: Vec::new(),
            mux: None,
            error: None,
            error_code: None,
            created_at: now_ms(),
        };
        self.inner.jobs.lock().unwrap().push(Entry {
            snap: snap.clone(),
            cancel: None,
            stop: CancellationToken::new(),
            intent: Intent::None,
            http_target: None,
            work_dir: None,
            blob,
            restored: false,
        });
        self.inner.persist();
        let _ = self.inner.tx.send(JobEvent::Added { job: snap });
        self.inner.schedule();
        Ok(id)
    }

    /// True if the job was restored from persistent storage and has not yet been reauthorized.
    pub fn is_quarantined(&self, id: &str) -> bool {
        self.inner
            .jobs
            .lock()
            .unwrap()
            .iter()
            .find(|e| e.snap.id == id)
            .is_some_and(|e| e.restored)
    }

    /// Alias for [`is_quarantined`](Self::is_quarantined).
    pub fn is_restored(&self, id: &str) -> bool {
        self.is_quarantined(id)
    }

    /// Reauthorize a restored job with fresh credentials/spec, clearing its quarantine.
    pub async fn reauthorize(&self, id: &str, new_spec: RequestSpec) -> Result<()> {
        if new_spec.url.is_empty() {
            return Err(DownloadError::InvalidRequest("URL cannot be empty".into()));
        }
        let u = url::Url::parse(&new_spec.url)?;
        if !matches!(u.scheme(), "http" | "https") {
            return Err(DownloadError::InvalidRequest(format!(
                "unsupported URL scheme {:?}",
                u.scheme()
            )));
        }
        let mut jobs = self.inner.jobs.lock().unwrap();
        let e = find(&mut jobs, id)?;
        e.snap.spec.request = new_spec;
        e.restored = false;
        Ok(())
    }

    /// Pause: keeps partial data (HTTP resumes from the sidecar; HLS/DASH restart).
    pub fn pause(&self, id: &str) -> Result<()> {
        let mut action = None;
        {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let e = find(&mut jobs, id)?;
            match e.snap.status {
                JobStatus::Queued => action = Some(JobStatus::Paused),
                JobStatus::Downloading => {
                    if let Some(c) = &e.cancel {
                        e.intent = Intent::Pause;
                        c.cancel();
                    }
                }
                _ => {}
            }
        }
        if let Some(s) = action {
            self.inner.set_status(id, s, None);
        }
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<()> {
        {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let e = find(&mut jobs, id)?;
            if e.restored {
                return Err(DownloadError::InvalidRequest(
                    "download requires reauthorization before it can be resumed".into(),
                ));
            }
            if !matches!(
                e.snap.status,
                JobStatus::Paused | JobStatus::Failed | JobStatus::Cancelled
            ) || e.snap.spec.kind == JobKind::Blob
            {
                return Ok(());
            }
            e.intent = Intent::None;
            e.stop = CancellationToken::new();
        }
        self.inner.set_status(id, JobStatus::Queued, None);
        self.inner.schedule();
        Ok(())
    }

    /// Cancel and delete partial data. The job stays in the list as `Cancelled`.
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.inner.cancel_or_remove(id, false)
    }

    /// Remove the job from the list (cancelling it first; partial data is deleted,
    /// completed files are kept).
    pub fn remove(&self, id: &str) -> Result<()> {
        self.inner.cancel_or_remove(id, true)
    }

    /// Gracefully end a live HLS capture: keep what was downloaded and finish the job.
    pub fn stop(&self, id: &str) -> Result<()> {
        let mut jobs = self.inner.jobs.lock().unwrap();
        find(&mut jobs, id)?.stop.cancel();
        Ok(())
    }

    /// Feed a base64 chunk from the page-side blob reader ([`crate::blob::BLOB_READER_JS`]).
    pub fn blob_chunk(&self, id: &str, index: u32, total: u32, data_base64: &str) -> Result<()> {
        let mut finished: Option<std::result::Result<PathBuf, DownloadError>> = None;
        let progress;
        {
            let mut jobs = self.inner.jobs.lock().unwrap();
            let e = find(&mut jobs, id)?;
            let Some(asm) = e.blob.as_mut() else {
                return Err(DownloadError::InvalidRequest(
                    "not an active blob job".into(),
                ));
            };
            match asm.accept(index, total, data_base64) {
                Ok(written) => {
                    e.snap.progress.downloaded = written;
                    let (done, tot) = asm.chunks_progress();
                    e.snap.progress.segments_done = Some(done);
                    e.snap.progress.segments_total = tot;
                    if asm.is_complete() {
                        finished = Some(asm.finish());
                    }
                }
                Err(err) => finished = Some(Err(err)),
            }
            progress = e.snap.progress.clone();
        }
        let _ = self.inner.tx.send(JobEvent::Progress {
            id: id.to_string(),
            progress,
        });
        match finished {
            Some(Ok(path)) => {
                self.inner.mutate(id, |e| {
                    e.blob = None;
                    e.snap.output_path = Some(path.clone());
                    e.snap.status = JobStatus::Completed;
                });
                self.inner.persist();
                let _ = self.inner.tx.send(JobEvent::Completed {
                    id: id.to_string(),
                    output_path: Some(path),
                });
                Ok(())
            }
            Some(Err(err)) => {
                self.inner.mutate(id, |e| {
                    if let Some(mut b) = e.blob.take() {
                        b.abort();
                    }
                });
                self.inner.fail(id, &err);
                Err(err)
            }
            None => Ok(()),
        }
    }
}

fn find<'a>(jobs: &'a mut [Entry], id: &str) -> Result<&'a mut Entry> {
    jobs.iter_mut()
        .find(|e| e.snap.id == id)
        .ok_or_else(|| DownloadError::Other(format!("no such job: {id}")))
}

impl Inner {
    fn mutate<R>(&self, id: &str, f: impl FnOnce(&mut Entry) -> R) -> Option<R> {
        self.jobs
            .lock()
            .unwrap()
            .iter_mut()
            .find(|e| e.snap.id == id)
            .map(f)
    }

    fn persist(&self) {
        let _g = self.persist_lock.lock().unwrap();
        let snaps: Vec<JobSnapshot> = self
            .jobs
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.snap.clone())
            .collect();
        let path = self.cfg.lock().unwrap().state_file.clone();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(&snaps) {
            let tmp = crate::fsutil::with_suffix(&path, ".tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn set_status(&self, id: &str, status: JobStatus, error: Option<(String, String)>) {
        let (err, code) = error.map_or((None, None), |(m, c)| (Some(m), Some(c)));
        self.mutate(id, |e| {
            e.snap.status = status;
            e.snap.error = err.clone();
            e.snap.error_code = code.clone();
            if !matches!(status, JobStatus::Downloading | JobStatus::Muxing) {
                e.snap.progress.speed_bps = 0.0;
                e.snap.progress.eta_secs = None;
                e.snap.progress.connections = 0;
            }
        });
        self.persist();
        let _ = self.tx.send(JobEvent::Status {
            id: id.to_string(),
            status,
            error: err,
            error_code: code,
        });
    }

    fn fail(&self, id: &str, e: &DownloadError) {
        self.set_status(id, JobStatus::Failed, Some((e.to_string(), error_code(e))));
    }

    /// Start queued jobs while below the active limit.
    fn schedule(self: &Arc<Self>) {
        let max = self.cfg.lock().unwrap().max_active.max(1);
        let mut to_start = Vec::new();
        {
            let mut jobs = self.jobs.lock().unwrap();
            let mut active = jobs
                .iter()
                .filter(|e| {
                    matches!(e.snap.status, JobStatus::Downloading | JobStatus::Muxing)
                        && e.snap.spec.kind != JobKind::Blob
                })
                .count();
            for e in jobs.iter_mut() {
                if active >= max {
                    break;
                }
                if e.snap.status == JobStatus::Queued {
                    let token = CancellationToken::new();
                    e.cancel = Some(token.clone());
                    e.intent = Intent::None;
                    e.snap.status = JobStatus::Downloading;
                    e.snap.error = None;
                    e.snap.error_code = None;
                    active += 1;
                    to_start.push((
                        e.snap.id.clone(),
                        e.snap.spec.clone(),
                        token,
                        e.stop.clone(),
                    ));
                }
            }
        }
        for (id, spec, token, stop) in to_start {
            self.persist();
            let _ = self.tx.send(JobEvent::Status {
                id: id.clone(),
                status: JobStatus::Downloading,
                error: None,
                error_code: None,
            });
            let inner = self.clone();
            tokio::spawn(async move {
                let result = inner.run_job(&id, &spec, &token, &stop).await;
                inner.finish_job(&id, result);
                inner.schedule();
            });
        }
    }

    fn cancel_or_remove(self: &Arc<Self>, id: &str, remove: bool) -> Result<()> {
        enum Act {
            Signalled,
            Immediate(Option<PathBuf>, Option<PathBuf>),
        }
        let act = {
            let mut jobs = self.jobs.lock().unwrap();
            let e = find(&mut jobs, id)?;
            match (e.snap.status, &e.cancel) {
                (JobStatus::Downloading, Some(c)) if e.blob.is_none() => {
                    e.intent = if remove {
                        Intent::Remove
                    } else {
                        Intent::Cancel
                    };
                    c.cancel();
                    Act::Signalled
                }
                (JobStatus::Muxing, Some(c)) => {
                    e.intent = if remove {
                        Intent::Remove
                    } else {
                        Intent::Cancel
                    };
                    c.cancel();
                    Act::Signalled
                }
                _ => {
                    if let Some(mut b) = e.blob.take() {
                        b.abort();
                    }
                    let completed = e.snap.status == JobStatus::Completed;
                    let (t, w) = if completed {
                        (None, None)
                    } else {
                        (e.http_target.clone(), e.work_dir.clone())
                    };
                    Act::Immediate(t, w)
                }
            }
        };
        if let Act::Immediate(target, work) = act {
            if let Some(t) = target {
                cleanup_partial(&t);
            }
            if let Some(w) = work {
                let _ = std::fs::remove_dir_all(w);
            }
            if remove {
                self.jobs.lock().unwrap().retain(|e| e.snap.id != id);
                self.persist();
                let _ = self.tx.send(JobEvent::Removed { id: id.to_string() });
            } else {
                let completed = self
                    .mutate(id, |e| e.snap.status == JobStatus::Completed)
                    .unwrap_or(false);
                if !completed {
                    self.set_status(id, JobStatus::Cancelled, None);
                }
            }
            self.schedule();
        }
        Ok(())
    }

    fn finish_job(self: &Arc<Self>, id: &str, result: Result<RunOutput>) {
        let intent = self.mutate(id, |e| {
            let i = e.intent;
            e.cancel = None;
            i
        });
        let Some(intent) = intent else { return };
        match result {
            Ok(out) => {
                self.mutate(id, |e| {
                    e.snap.output_path = Some(out.path.clone());
                    e.snap.extra_outputs = out.extra.clone();
                    e.snap.mux = out.mux.clone();
                    e.work_dir = None;
                    e.snap.progress.speed_bps = 0.0;
                    e.snap.progress.eta_secs = None;
                    e.snap.progress.connections = 0;
                });
                self.set_status(id, JobStatus::Completed, None);
                let _ = self.tx.send(JobEvent::Completed {
                    id: id.to_string(),
                    output_path: Some(out.path),
                });
            }
            Err(DownloadError::Cancelled) => match intent {
                Intent::Cancel | Intent::Remove => {
                    let (target, work) = self
                        .mutate(id, |e| (e.http_target.clone(), e.work_dir.take()))
                        .unwrap_or((None, None));
                    if let Some(t) = target {
                        cleanup_partial(&t);
                    }
                    if let Some(w) = work {
                        let _ = std::fs::remove_dir_all(w);
                    }
                    if intent == Intent::Remove {
                        self.jobs.lock().unwrap().retain(|e| e.snap.id != id);
                        self.persist();
                        let _ = self.tx.send(JobEvent::Removed { id: id.to_string() });
                    } else {
                        self.set_status(id, JobStatus::Cancelled, None);
                    }
                }
                _ => self.set_status(id, JobStatus::Paused, None),
            },
            Err(e) => {
                // Stream work dirs are rebuilt from scratch on every (re)start, so a
                // terminally failed job has no use for them.
                if let Some(w) = self.mutate(id, |e| e.work_dir.take()).flatten() {
                    let _ = std::fs::remove_dir_all(w);
                }
                self.fail(id, &e)
            }
        }
    }

    async fn run_job(
        self: &Arc<Self>,
        id: &str,
        spec: &JobSpec,
        cancel: &CancellationToken,
        stop: &CancellationToken,
    ) -> Result<RunOutput> {
        let cfg = self.cfg.lock().unwrap().clone();
        let cb_inner = self.clone();
        let cb_id = id.to_string();
        let callback: crate::progress::ProgressCallback = Arc::new(move |p: &Progress| {
            cb_inner.mutate(&cb_id, |e| e.snap.progress = p.clone());
            let _ = cb_inner.tx.send(JobEvent::Progress {
                id: cb_id.clone(),
                progress: p.clone(),
            });
        });
        let (tracker, _rx) = ProgressTracker::new(Some(callback));
        let _ticker = tracker.spawn_ticker();

        let result = match &spec.kind {
            JobKind::Http => {
                let opts = HttpOptions {
                    connections: spec.connections.unwrap_or(cfg.default_connections),
                    max_retries: cfg.max_retries,
                    retry_base_delay: cfg.retry_base_delay,
                    speed_limit: spec.speed_limit,
                    min_split_size: cfg.min_split_size,
                };
                let me = self.clone();
                let jid = id.to_string();
                let on_target = move |p: &Path| {
                    let p = p.to_path_buf();
                    me.mutate(&jid, |e| e.http_target = Some(p));
                };
                download_http(
                    &self.client,
                    &spec.request,
                    &spec.dest_dir,
                    spec.file_name.as_deref(),
                    &opts,
                    cancel,
                    &tracker,
                    Some(&on_target),
                )
                .await
                .map(|d| RunOutput {
                    path: d.path,
                    extra: Vec::new(),
                    mux: None,
                })
            }
            JobKind::Hls { .. } | JobKind::Dash { .. } => {
                let stem = stem_for(spec);
                let work = spec
                    .dest_dir
                    .join(format!(".{stem}.omnia-work-{}", &id[..8.min(id.len())]));
                self.mutate(id, |e| e.work_dir = Some(work.clone()));
                let _ = std::fs::remove_dir_all(&work);
                let fetcher = Fetcher {
                    client: self.client.clone(),
                    spec: spec.request.clone(),
                    max_retries: cfg.max_retries,
                    retry_base_delay: cfg.retry_base_delay,
                    cancel: cancel.clone(),
                    tracker: Some(tracker.clone()),
                    limiter: spec.speed_limit.map(|l| Arc::new(TokenBucket::new(l))),
                };
                let sopts = StreamOptions {
                    concurrency: cfg.hls_concurrency,
                    live_poll_interval: None,
                    live_stop: stop.clone(),
                };
                let streams = match &spec.kind {
                    JobKind::Hls { quality } => {
                        download_hls(&fetcher, &spec.request.url, *quality, &work, &sopts).await
                    }
                    JobKind::Dash { quality } => {
                        let hopts = HttpOptions {
                            connections: spec.connections.unwrap_or(cfg.default_connections),
                            max_retries: cfg.max_retries,
                            retry_base_delay: cfg.retry_base_delay,
                            speed_limit: spec.speed_limit,
                            min_split_size: cfg.min_split_size,
                        };
                        download_dash(&fetcher, &spec.request.url, *quality, &work, &sopts, &hopts)
                            .await
                    }
                    _ => unreachable!(),
                };
                match streams {
                    Ok(out) => {
                        self.set_status(id, JobStatus::Muxing, None);
                        let r = self.finalize_streams(&cfg, spec, &stem, out, cancel).await;
                        let _ = std::fs::remove_dir_all(&work);
                        r
                    }
                    Err(e) => Err(e),
                }
            }
            JobKind::Blob => Err(DownloadError::Unsupported(
                "blob jobs are driven by blob_chunk".into(),
            )),
        };
        tracker.finish();
        result
    }

    /// Mux (when requested and possible) or move raw tracks next to the destination.
    async fn finalize_streams(
        &self,
        cfg: &EngineConfig,
        spec: &JobSpec,
        stem: &str,
        out: StreamOutput,
        cancel: &CancellationToken,
    ) -> Result<RunOutput> {
        let dest = &spec.dest_dir;
        let mut outcome = None;
        if spec.mux {
            let ffmpeg = find_ffmpeg(cfg.ffmpeg_path.as_deref());
            let target = unique_path(dest, &format!("{stem}.mp4"));
            let r = mux_cancellable(
                ffmpeg.as_deref(),
                &out.video,
                out.audio.as_deref(),
                &target,
                cancel,
            )
            .await;
            if matches!(r, Err(DownloadError::Cancelled)) {
                return Err(DownloadError::Cancelled);
            }
            let result = r.unwrap_or_else(|e| MuxOutcome::MuxSkipped {
                reason: e.to_string(),
            });
            if let MuxOutcome::Muxed { output } = &result {
                let _ = std::fs::remove_file(&out.video);
                if let Some(a) = &out.audio {
                    let _ = std::fs::remove_file(a);
                }
                return Ok(RunOutput {
                    path: output.clone(),
                    extra: Vec::new(),
                    mux: Some(result),
                });
            }
            outcome = Some(result);
        }
        let ext = |p: &Path| {
            p.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin")
                .to_string()
        };
        let video_dest = unique_path(dest, &format!("{stem}.{}", ext(&out.video)));
        move_file(&out.video, &video_dest)?;
        let mut extra = Vec::new();
        if let Some(a) = &out.audio {
            let audio_dest = unique_path(dest, &format!("{stem}.audio.{}", ext(a)));
            move_file(a, &audio_dest)?;
            extra.push(audio_dest);
        }
        Ok(RunOutput {
            path: video_dest,
            extra,
            mux: outcome,
        })
    }
}

struct RunOutput {
    path: PathBuf,
    extra: Vec<PathBuf>,
    mux: Option<MuxOutcome>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paused_hls_engine(dir: &Path) -> (DownloadEngine, String) {
        let state = dir.join("state.json");
        let spec = JobSpec::new(
            JobKind::Hls {
                quality: Quality::Best,
            },
            RequestSpec::get("https://example.com/a.m3u8"),
            dir,
        );
        let snap = JobSnapshot {
            id: "abcdef0123456789".into(),
            spec,
            status: JobStatus::Paused,
            progress: Progress::default(),
            output_path: None,
            extra_outputs: Vec::new(),
            mux: None,
            error: None,
            error_code: None,
            created_at: 0,
        };
        std::fs::write(&state, serde_json::to_vec(&vec![snap]).unwrap()).unwrap();
        (
            DownloadEngine::new(EngineConfig::new(state)).unwrap(),
            "abcdef0123456789".into(),
        )
    }

    #[test]
    fn failed_stream_job_removes_work_dir_but_paused_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, id) = paused_hls_engine(dir.path());
        let work = dir.path().join(".a.omnia-work-abcdef01");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("seg0.ts"), b"x").unwrap();
        engine.inner.mutate(&id, |e| {
            e.work_dir = Some(work.clone());
            e.intent = Intent::Pause;
        });
        engine.inner.finish_job(&id, Err(DownloadError::Cancelled));
        assert!(work.exists(), "paused jobs keep their work dir");
        assert_eq!(engine.get(&id).unwrap().status, JobStatus::Paused);

        engine.inner.mutate(&id, |e| e.intent = Intent::None);
        engine
            .inner
            .finish_job(&id, Err(DownloadError::Parse("bad playlist".into())));
        assert!(
            !work.exists(),
            "failed jobs must not leave hidden work dirs"
        );
        let snap = engine.get(&id).unwrap();
        assert_eq!(snap.status, JobStatus::Failed);
        assert_eq!(snap.error_code.as_deref(), Some("parse"));
    }

    #[tokio::test]
    async fn restored_job_requires_reauthorization_before_resume() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, id) = paused_hls_engine(dir.path());
        assert!(engine.is_quarantined(&id));
        assert!(engine.is_restored(&id));

        // Resuming while quarantined must fail with reauthorization required
        let resume_res = engine.resume(&id);
        assert!(resume_res.is_err());
        assert!(
            matches!(resume_res.unwrap_err(), DownloadError::InvalidRequest(msg) if msg.contains("reauthorization"))
        );

        // Reauthorize with fresh spec and credentials
        let mut new_spec = RequestSpec::get("https://example.com/fresh.m3u8");
        new_spec
            .headers
            .push(("Authorization".into(), "Bearer fresh_token".into()));
        engine.reauthorize(&id, new_spec.clone()).await.unwrap();

        // Quarantine is now cleared
        assert!(!engine.is_quarantined(&id));
        assert!(!engine.is_restored(&id));
        let updated = engine.get(&id).unwrap();
        assert_eq!(updated.spec.request.url, "https://example.com/fresh.m3u8");
        assert_eq!(updated.spec.request.headers.len(), 1);

        // Resume now succeeds
        assert!(engine.resume(&id).is_ok());
    }
}
