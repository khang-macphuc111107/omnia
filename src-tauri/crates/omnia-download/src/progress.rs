//! Progress aggregation: atomic counters + a ticker publishing smoothed speed / ETA.

use crate::types::Progress;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub type ProgressCallback = Arc<dyn Fn(&Progress) + Send + Sync>;

pub struct ProgressTracker {
    downloaded: AtomicU64,
    total: AtomicU64, // 0 = unknown
    connections: AtomicU32,
    seg_done: AtomicU32,
    seg_total: AtomicU32,
    speed: Mutex<SpeedState>,
    tx: watch::Sender<Progress>,
    callback: Option<ProgressCallback>,
}

struct SpeedState {
    last_bytes: u64,
    last_time: Instant,
    ema: f64,
}

impl ProgressTracker {
    pub fn new(callback: Option<ProgressCallback>) -> (Arc<Self>, watch::Receiver<Progress>) {
        let (tx, rx) = watch::channel(Progress::default());
        let t = Arc::new(Self {
            downloaded: AtomicU64::new(0),
            total: AtomicU64::new(0),
            connections: AtomicU32::new(0),
            seg_done: AtomicU32::new(0),
            seg_total: AtomicU32::new(0),
            speed: Mutex::new(SpeedState {
                last_bytes: 0,
                last_time: Instant::now(),
                ema: 0.0,
            }),
            tx,
            callback,
        });
        (t, rx)
    }

    pub fn subscribe(&self) -> watch::Receiver<Progress> {
        self.tx.subscribe()
    }

    pub fn add(&self, n: u64) {
        self.downloaded.fetch_add(n, Ordering::Relaxed);
    }

    /// Un-count bytes that will be downloaded again.
    pub fn sub(&self, n: u64) {
        let cur = self.downloaded.load(Ordering::Relaxed);
        self.downloaded
            .store(cur.saturating_sub(n), Ordering::Relaxed);
        if let Ok(mut s) = self.speed.lock() {
            s.last_bytes = s.last_bytes.min(self.downloaded.load(Ordering::Relaxed));
        }
    }

    /// Discard counted bytes (e.g. a single-stream download restarting from zero).
    pub fn reset_downloaded(&self) {
        self.downloaded.store(0, Ordering::Relaxed);
        if let Ok(mut s) = self.speed.lock() {
            s.last_bytes = 0;
        }
    }

    pub fn add_total(&self, n: u64) {
        self.total.fetch_add(n, Ordering::Relaxed);
    }

    pub fn set_total(&self, n: Option<u64>) {
        self.total.store(n.unwrap_or(0), Ordering::Relaxed);
    }

    pub fn conn_inc(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn conn_dec(&self) {
        self.connections.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn set_connections(&self, n: u32) {
        self.connections.store(n, Ordering::Relaxed);
    }

    pub fn segment_done(&self) {
        self.seg_done.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_segments_total(&self, n: u32) {
        self.seg_total.fetch_add(n, Ordering::Relaxed);
    }

    pub fn downloaded(&self) -> u64 {
        self.downloaded.load(Ordering::Relaxed)
    }

    fn snapshot(&self, update_speed: bool) -> Progress {
        let downloaded = self.downloaded.load(Ordering::Relaxed);
        let total = match self.total.load(Ordering::Relaxed) {
            0 => None,
            t => Some(t),
        };
        let seg_total = self.seg_total.load(Ordering::Relaxed);
        let seg_done = self.seg_done.load(Ordering::Relaxed);
        let speed = {
            let mut s = self.speed.lock().unwrap();
            if update_speed {
                let now = Instant::now();
                let dt = now.duration_since(s.last_time).as_secs_f64();
                if dt > 0.0 {
                    let inst = downloaded.saturating_sub(s.last_bytes) as f64 / dt;
                    s.ema = if s.ema == 0.0 {
                        inst
                    } else {
                        0.7 * s.ema + 0.3 * inst
                    };
                    s.last_bytes = downloaded;
                    s.last_time = now;
                }
            }
            s.ema
        };
        let est_total = total.or_else(|| {
            (seg_total > 0 && seg_done > 0)
                .then(|| (downloaded as f64 * seg_total as f64 / seg_done as f64) as u64)
        });
        let eta = match est_total {
            Some(t) if speed > 1.0 => Some(t.saturating_sub(downloaded) as f64 / speed),
            _ => None,
        };
        Progress {
            downloaded,
            total,
            speed_bps: speed,
            eta_secs: eta,
            connections: self.connections.load(Ordering::Relaxed),
            segments_done: (seg_total > 0).then_some(seg_done),
            segments_total: (seg_total > 0).then_some(seg_total),
        }
    }

    /// Publish a fresh snapshot immediately.
    pub fn publish(&self) {
        let p = self.snapshot(true);
        if let Some(cb) = &self.callback {
            cb(&p);
        }
        self.tx.send_replace(p);
    }

    /// Final publish with speed zeroed.
    pub fn finish(&self) {
        let mut p = self.snapshot(false);
        p.speed_bps = 0.0;
        p.eta_secs = None;
        p.connections = 0;
        if let Some(cb) = &self.callback {
            cb(&p);
        }
        self.tx.send_replace(p);
    }

    /// Spawn the periodic publisher; it stops when the guard is dropped.
    pub fn spawn_ticker(self: &Arc<Self>) -> TickerGuard {
        let this = self.clone();
        TickerGuard(tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_millis(250));
            loop {
                iv.tick().await;
                this.publish();
            }
        }))
    }
}

pub struct TickerGuard(JoinHandle<()>);

impl Drop for TickerGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}
