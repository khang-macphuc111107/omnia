//! Segmented HTTP downloader (IDM style): N connections, dynamic range splitting
//! (work stealing), resumable via a JSON sidecar, `.part` file with positional writes.

use crate::error::{DownloadError, Result};
use crate::fsutil::{move_file, sanitize_file_name, unique_path, with_suffix, write_all_at};
use crate::probe::{probe, ProbeResult};
use crate::progress::ProgressTracker;
use crate::ratelimit::TokenBucket;
use crate::request::RequestSpec;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

/// Size of the per-connection write buffer.
const FLUSH_BYTES: usize = 128 * 1024;
pub const SIDECAR_SUFFIX: &str = ".omnia-dl.json";

#[derive(Clone, Debug)]
pub struct HttpOptions {
    /// Parallel connections, clamped to 1..=32.
    pub connections: usize,
    pub max_retries: u32,
    pub retry_base_delay: Duration,
    /// Bytes per second, shared by all connections.
    pub speed_limit: Option<u64>,
    /// Never split a remaining range smaller than `2 * min_split_size`.
    pub min_split_size: u64,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            connections: 16,
            max_retries: 5,
            retry_base_delay: Duration::from_millis(500),
            speed_limit: None,
            min_split_size: 512 * 1024,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadedFile {
    pub path: PathBuf,
    pub size: u64,
}

/// On-disk resume state (`<file>.omnia-dl.json`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub request: RequestSpec,
    pub final_url: String,
    pub size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub file_name: String,
    /// Completed half-open ranges `[start, end)`, sorted and merged.
    pub completed: Vec<(u64, u64)>,
}

fn backoff(base: Duration, attempt: u32) -> Duration {
    base.saturating_mul(1u32 << attempt.min(6))
        .min(Duration::from_secs(30))
}

fn add_range(done: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    if start >= end {
        return;
    }
    done.push((start, end));
    done.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(done.len());
    for &(s, e) in done.iter() {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    *done = merged;
}

fn gaps(done: &[(u64, u64)], size: u64) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut pos = 0;
    for &(s, e) in done {
        if s > pos {
            out.push((pos, s.min(size)));
        }
        pos = pos.max(e);
    }
    if pos < size {
        out.push((pos, size));
    }
    out
}

struct Slot {
    /// Flushed (durable) position.
    cur: u64,
    /// Received position including buffered data.
    recv: u64,
    end: u64,
    active: bool,
}

struct Sched {
    slots: Vec<Slot>,
    pending: VecDeque<(u64, u64)>,
    done: Vec<(u64, u64)>,
}

struct Ctx {
    client: Client,
    spec: RequestSpec,
    file: Arc<File>,
    sched: Mutex<Sched>,
    tracker: Arc<ProgressTracker>,
    limiter: Option<TokenBucket>,
    opts: HttpOptions,
    cancel: CancellationToken,
    etag: Option<String>,
    /// Total object size every 206 response must report.
    size: u64,
}

impl Ctx {
    /// Take a pending range or split the largest active one in half.
    fn claim(&self) -> Option<usize> {
        let mut s = self.sched.lock().unwrap();
        if let Some((a, b)) = s.pending.pop_front() {
            s.slots.push(Slot {
                cur: a,
                recv: a,
                end: b,
                active: true,
            });
            return Some(s.slots.len() - 1);
        }
        let min = self.opts.min_split_size.max(1);
        let victim = s
            .slots
            .iter()
            .enumerate()
            .filter(|(_, sl)| sl.active && sl.end.saturating_sub(sl.recv) >= 2 * min)
            .max_by_key(|(_, sl)| sl.end - sl.recv)
            .map(|(i, _)| i)?;
        let (mid, old_end) = {
            let v = &s.slots[victim];
            (v.recv + (v.end - v.recv) / 2, v.end)
        };
        s.slots[victim].end = mid;
        s.slots.push(Slot {
            cur: mid,
            recv: mid,
            end: old_end,
            active: true,
        });
        Some(s.slots.len() - 1)
    }

    fn release(&self, idx: usize) {
        self.sched.lock().unwrap().slots[idx].active = false;
    }

    async fn flush(&self, idx: usize, buf: &mut Vec<u8>) -> Result<()> {
        if buf.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(buf);
        let offset = self.sched.lock().unwrap().slots[idx].cur;
        let len = data.len() as u64;
        let file = self.file.clone();
        tokio::task::spawn_blocking(move || write_all_at(&file, &data, offset))
            .await
            .map_err(|e| DownloadError::Io(e.to_string()))??;
        {
            let mut s = self.sched.lock().unwrap();
            add_range(&mut s.done, offset, offset + len);
            s.slots[idx].cur = offset + len;
        }
        self.tracker.add(len);
        Ok(())
    }

    /// One attempt at downloading the remainder of a slot.
    async fn run_attempt(&self, idx: usize, buf: &mut Vec<u8>) -> Result<()> {
        let (start, end) = {
            let mut s = self.sched.lock().unwrap();
            let sl = &mut s.slots[idx];
            sl.recv = sl.cur; // buffered-but-unflushed data from a failed attempt is discarded
            (sl.cur, sl.end)
        };
        if start >= end {
            return Ok(());
        }
        let range = format!("bytes={}-{}", start, end - 1);
        let resp = self.spec.send(&self.client, Some(&range)).await?;
        match resp.status() {
            StatusCode::PARTIAL_CONTENT => {}
            s if s.is_success() => {
                return Err(DownloadError::Unsupported(
                    "server ignored Range request".into(),
                ))
            }
            s => return Err(DownloadError::Status(s.as_u16())),
        }
        // The body is written at `start`; it must be exactly the bytes we asked for.
        let content_range = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok());
        if content_range.and_then(parse_content_range) != Some((start, end - 1, self.size)) {
            return Err(DownloadError::Other(format!(
                "server returned mismatched Content-Range {:?} for bytes {}-{}/{}",
                content_range,
                start,
                end - 1,
                self.size
            )));
        }
        if let (Some(want), Some(got)) = (
            &self.etag,
            resp.headers().get("etag").and_then(|v| v.to_str().ok()),
        ) {
            if want != got {
                return Err(DownloadError::Other(
                    "resource changed during download".into(),
                ));
            }
        }
        let mut stream = resp.bytes_stream();
        loop {
            let next = tokio::select! {
                _ = self.cancel.cancelled() => return Err(DownloadError::Cancelled),
                n = stream.next() => n,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk?;
            if let Some(l) = &self.limiter {
                l.acquire(chunk.len()).await;
            }
            let (take, finished) = {
                let mut s = self.sched.lock().unwrap();
                let sl = &mut s.slots[idx];
                let room = sl.end.saturating_sub(sl.recv) as usize;
                let take = room.min(chunk.len());
                sl.recv += take as u64;
                (take, sl.recv >= sl.end)
            };
            buf.extend_from_slice(&chunk[..take]);
            if buf.len() >= FLUSH_BYTES || finished {
                self.flush(idx, buf).await?;
            }
            if finished {
                return Ok(());
            }
        }
        let done = {
            let s = self.sched.lock().unwrap();
            s.slots[idx].recv >= s.slots[idx].end
        };
        if done {
            Ok(())
        } else {
            Err(DownloadError::Network(
                "connection closed before range completed".into(),
            ))
        }
    }

    async fn worker(self: Arc<Self>) -> Result<()> {
        self.tracker.conn_inc();
        let r = self.worker_inner().await;
        self.tracker.conn_dec();
        r
    }

    async fn worker_inner(&self) -> Result<()> {
        while let Some(idx) = self.claim() {
            let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_BYTES * 2);
            let mut attempt = 0u32;
            loop {
                let before = self.sched.lock().unwrap().slots[idx].cur;
                let res = self.run_attempt(idx, &mut buf).await;
                // Persist whatever valid data we hold, even on failure.
                let flushed = if buf.is_empty() {
                    Ok(())
                } else {
                    self.flush(idx, &mut buf).await
                };
                match (res, flushed) {
                    (Ok(()), Ok(())) => break,
                    (Err(DownloadError::Cancelled), _) => {
                        self.release(idx);
                        return Err(DownloadError::Cancelled);
                    }
                    (Err(e), _) | (Ok(()), Err(e)) => {
                        let progressed = self.sched.lock().unwrap().slots[idx].cur > before;
                        if progressed {
                            attempt = 0;
                        }
                        if !e.is_retryable() || attempt >= self.opts.max_retries {
                            self.release(idx);
                            return Err(e);
                        }
                        let wait = backoff(self.opts.retry_base_delay, attempt);
                        attempt += 1;
                        tokio::select! {
                            _ = self.cancel.cancelled() => {
                                self.release(idx);
                                return Err(DownloadError::Cancelled);
                            }
                            _ = tokio::time::sleep(wait) => {}
                        }
                    }
                }
            }
            self.release(idx);
        }
        Ok(())
    }
}

fn sidecar_path(target: &Path) -> PathBuf {
    with_suffix(target, SIDECAR_SUFFIX)
}

fn part_path(target: &Path) -> PathBuf {
    with_suffix(target, ".part")
}

/// Remove partial data and resume state for a target path (used on cancel / remove).
pub fn cleanup_partial(target: &Path) {
    let _ = std::fs::remove_file(part_path(target));
    let _ = std::fs::remove_file(sidecar_path(target));
}

fn write_state(path: &Path, state: &ResumeState) {
    if let Ok(json) = serde_json::to_vec(state) {
        let tmp = with_suffix(path, ".tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// Parse `bytes START-END/TOTAL` (a satisfied byte range with a known total).
fn parse_content_range(v: &str) -> Option<(u64, u64, u64)> {
    let (unit, rest) = v.trim().split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = rest.trim().split_once('/')?;
    let (s, e) = range.split_once('-')?;
    let num = |x: &str| {
        let x = x.trim();
        if x.is_empty() || !x.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        x.parse::<u64>().ok()
    };
    let (s, e, t) = (num(s)?, num(e)?, num(total)?);
    (s <= e && e < t).then_some((s, e, t))
}

/// The request URL in the form it is persisted in the sidecar.
fn persisted_url(url: &str) -> Option<String> {
    match crate::request::serialize_public_url(url, serde_json::value::Serializer) {
        Ok(serde_json::Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// Completed ranges must be non-empty, sorted, non-overlapping and inside `[0, size)`.
fn ranges_in_bounds(done: &[(u64, u64)], size: u64) -> bool {
    let mut prev = 0;
    for &(s, e) in done {
        if s < prev || s >= e || e > size {
            return false;
        }
        prev = e;
    }
    true
}

/// Completed ranges from a sidecar, only if it describes exactly this download (fail-closed).
/// Validators must match as supplied: one that appeared, disappeared or changed invalidates it.
fn resume_ranges(
    state: &ResumeState,
    spec: &RequestSpec,
    probe: &ProbeResult,
    name: &str,
    size: u64,
    part_len: Option<u64>,
) -> Option<Vec<(u64, u64)>> {
    let valid = persisted_url(&spec.url).is_some_and(|u| u == state.request.url && u == spec.url)
        && spec.headers.is_empty()
        && spec.cookies.is_none()
        && spec.referer.is_none()
        && spec.user_agent.is_none()
        && spec.body.is_none()
        && state.request.method.eq_ignore_ascii_case(&spec.method)
        && state.final_url == probe.final_url
        && state.file_name == name
        && probe.size == Some(size)
        && state.size == size
        && state.etag == probe.etag
        && state.last_modified == probe.last_modified
        && part_len == Some(size)
        && ranges_in_bounds(&state.completed, size);
    valid.then(|| state.completed.clone())
}

#[allow(clippy::too_many_arguments)] // mirrors the persisted record layout; bundling into a struct would be a larger refactor
/// Download `spec` into `dest_dir`.
///
/// * Probes the resource first; uses segmented mode when it is a GET, the server supports
///   ranges and the size is known; otherwise a single resilient stream.
/// * If a valid sidecar + `.part` exist the download resumes (validators are checked; if the
///   remote file changed it restarts from zero).
/// * Cancelling the token returns `Err(Cancelled)` after persisting state (this is "pause").
/// * `on_target` receives the destination path (without `.part`) as soon as it is known so
///   callers can clean up after a cancel via [`cleanup_partial`].
pub async fn download_http(
    client: &Client,
    spec: &RequestSpec,
    dest_dir: &Path,
    file_name: Option<&str>,
    opts: &HttpOptions,
    cancel: &CancellationToken,
    tracker: &Arc<ProgressTracker>,
    on_target: Option<&(dyn Fn(&Path) + Send + Sync)>,
) -> Result<DownloadedFile> {
    tokio::fs::create_dir_all(dest_dir).await?;
    let info = tokio::select! {
        _ = cancel.cancelled() => return Err(DownloadError::Cancelled),
        r = probe(client, spec) => r?,
    };
    let name = file_name
        .map(sanitize_file_name)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| info.file_name.clone());
    let target = dest_dir.join(&name);
    if let Some(cb) = on_target {
        cb(&target);
    }
    let part = part_path(&target);
    let sidecar = sidecar_path(&target);

    let segmented = spec.is_get() && info.accept_ranges && info.size.is_some_and(|s| s > 0);
    if !segmented {
        let _ = std::fs::remove_file(&sidecar);
        return download_single(client, spec, dest_dir, &name, &part, opts, cancel, tracker).await;
    }
    let size = info.size.unwrap_or(0);

    // Resume state.
    let mut done: Vec<(u64, u64)> = Vec::new();
    if let Ok(bytes) = std::fs::read(&sidecar) {
        if let Ok(state) = serde_json::from_slice::<ResumeState>(&bytes) {
            let part_len = std::fs::metadata(&part).ok().map(|m| m.len());
            if let Some(ranges) = resume_ranges(&state, spec, &info, &name, size, part_len) {
                done = ranges;
            }
        }
    }
    if done.is_empty() {
        let _ = std::fs::remove_file(&part);
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&part)?;
    if file.metadata()?.len() != size {
        file.set_len(size)?;
    }

    let mut state = ResumeState {
        request: spec.clone(),
        final_url: info.final_url.clone(),
        size,
        etag: info.etag.clone(),
        last_modified: info.last_modified.clone(),
        file_name: name.clone(),
        completed: done.clone(),
    };
    write_state(&sidecar, &state);

    let already: u64 = done.iter().map(|(s, e)| e - s).sum();
    tracker.add_total(size);
    tracker.add(already);

    let n = opts.connections.clamp(1, 32);
    let missing = gaps(&done, size);
    let remaining: u64 = missing.iter().map(|(s, e)| e - s).sum();
    let mut pending = VecDeque::new();
    if remaining > 0 {
        // Initial split: roughly equal pieces, none smaller than min_split_size.
        let piece = (remaining / n as u64).max(opts.min_split_size.max(1));
        for (s, e) in missing {
            let mut a = s;
            while a < e {
                let mut b = (a + piece).min(e);
                if e - b < piece / 2 {
                    b = e;
                }
                pending.push_back((a, b));
                a = b;
            }
        }
    }

    let ctx = Arc::new(Ctx {
        client: client.clone(),
        spec: spec.clone(),
        file: Arc::new(file),
        sched: Mutex::new(Sched {
            slots: Vec::new(),
            pending,
            done,
        }),
        tracker: tracker.clone(),
        limiter: opts.speed_limit.map(TokenBucket::new),
        opts: opts.clone(),
        cancel: cancel.child_token(),
        etag: info.etag.clone(),
        size,
    });

    let mut set = JoinSet::new();
    for _ in 0..n {
        set.spawn(ctx.clone().worker());
    }
    // Periodic persistence of resume state.
    let saver = {
        let ctx = ctx.clone();
        let sidecar = sidecar.clone();
        let mut st = state.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(1));
            iv.tick().await;
            loop {
                iv.tick().await;
                st.completed = ctx.sched.lock().unwrap().done.clone();
                write_state(&sidecar, &st);
            }
        })
    };

    let mut first_err: Option<DownloadError> = None;
    while let Some(joined) = set.join_next().await {
        let r =
            joined.unwrap_or_else(|e| Err(DownloadError::Other(format!("worker panicked: {e}"))));
        if let Err(e) = r {
            ctx.cancel.cancel();
            let replace = match (&first_err, &e) {
                (None, _) => true,
                (Some(DownloadError::Cancelled), DownloadError::Cancelled) => false,
                (Some(DownloadError::Cancelled), _) => true,
                _ => false,
            };
            if replace {
                first_err = Some(e);
            }
        }
    }
    saver.abort();

    state.completed = ctx.sched.lock().unwrap().done.clone();
    let file = ctx.file.clone();
    let _ = tokio::task::spawn_blocking(move || file.sync_data()).await;
    write_state(&sidecar, &state);

    if let Some(e) = first_err {
        if matches!(&e, DownloadError::Other(m) if m.contains("changed")) {
            cleanup_partial(&target);
        }
        return Err(if cancel.is_cancelled() {
            DownloadError::Cancelled
        } else {
            e
        });
    }
    if gaps(&state.completed, size).is_empty() {
        drop(ctx);
        let final_path = unique_path(dest_dir, &name);
        move_file(&part, &final_path)?;
        let _ = std::fs::remove_file(&sidecar);
        Ok(DownloadedFile {
            path: final_path,
            size,
        })
    } else {
        Err(DownloadError::Other("download incomplete".into()))
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_single(
    client: &Client,
    spec: &RequestSpec,
    dest_dir: &Path,
    name: &str,
    part: &Path,
    opts: &HttpOptions,
    cancel: &CancellationToken,
    tracker: &Arc<ProgressTracker>,
) -> Result<DownloadedFile> {
    use tokio::io::AsyncWriteExt;
    let limiter = opts.speed_limit.map(TokenBucket::new);
    let mut attempt = 0u32;
    let mut total_added = false;
    tracker.conn_inc();
    let result: Result<u64> = loop {
        let mut counted = 0u64;
        let r: Result<u64> = async {
            let resp = tokio::select! {
                _ = cancel.cancelled() => return Err(DownloadError::Cancelled),
                r = spec.send(client, None) => r?,
            };
            if !resp.status().is_success() {
                return Err(DownloadError::Status(resp.status().as_u16()));
            }
            if !total_added {
                if let Some(len) = resp.content_length() {
                    tracker.add_total(len);
                    total_added = true;
                }
            }
            let mut f = tokio::fs::File::create(part).await?;
            let mut stream = resp.bytes_stream();
            loop {
                let next = tokio::select! {
                    _ = cancel.cancelled() => return Err(DownloadError::Cancelled),
                    n = stream.next() => n,
                };
                let Some(chunk) = next else { break };
                let chunk = chunk?;
                if let Some(l) = &limiter {
                    l.acquire(chunk.len()).await;
                }
                f.write_all(&chunk).await?;
                counted += chunk.len() as u64;
                tracker.add(chunk.len() as u64);
            }
            f.flush().await?;
            Ok(counted)
        }
        .await;
        match r {
            Ok(n) => break Ok(n),
            Err(DownloadError::Cancelled) => break Err(DownloadError::Cancelled),
            Err(e) => {
                tracker.sub(counted);
                if !e.is_retryable() || attempt >= opts.max_retries {
                    break Err(e);
                }
                let wait = backoff(opts.retry_base_delay, attempt);
                attempt += 1;
                tokio::select! {
                    _ = cancel.cancelled() => break Err(DownloadError::Cancelled),
                    _ = tokio::time::sleep(wait) => {}
                }
            }
        }
    };
    tracker.conn_dec();
    match result {
        Ok(size) => {
            let final_path = unique_path(dest_dir, name);
            move_file(part, &final_path)?;
            Ok(DownloadedFile {
                path: final_path,
                size,
            })
        }
        Err(e) => {
            if matches!(e, DownloadError::Cancelled) {
                let _ = std::fs::remove_file(part);
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_math() {
        let mut d = vec![];
        add_range(&mut d, 10, 20);
        add_range(&mut d, 0, 5);
        add_range(&mut d, 5, 10);
        add_range(&mut d, 30, 40);
        assert_eq!(d, vec![(0, 20), (30, 40)]);
        assert_eq!(gaps(&d, 50), vec![(20, 30), (40, 50)]);
        assert!(gaps(&[(0, 50)], 50).is_empty());
    }

    #[test]
    fn backoff_grows_and_caps() {
        let b = Duration::from_millis(100);
        assert_eq!(backoff(b, 0), Duration::from_millis(100));
        assert_eq!(backoff(b, 3), Duration::from_millis(800));
        assert_eq!(backoff(Duration::from_secs(10), 6), Duration::from_secs(30));
    }

    #[test]
    fn content_range_parsing_is_strict() {
        assert_eq!(parse_content_range("bytes 0-9/10"), Some((0, 9, 10)));
        assert_eq!(parse_content_range("Bytes 5-5/6"), Some((5, 5, 6)));
        for bad in [
            "bytes 0-9/*",
            "bytes */10",
            "bytes 9-0/10",
            "bytes 0-10/10",
            "bytes -1-9/10",
            "items 0-9/10",
            "bytes 0-9",
            "",
        ] {
            assert_eq!(parse_content_range(bad), None, "{bad}");
        }
    }

    #[test]
    fn completed_range_bounds() {
        assert!(ranges_in_bounds(&[], 10));
        assert!(ranges_in_bounds(&[(0, 4), (6, 10)], 10));
        assert!(!ranges_in_bounds(&[(0, 11)], 10));
        assert!(!ranges_in_bounds(&[(4, 4)], 10));
        assert!(!ranges_in_bounds(&[(5, 3)], 10));
        assert!(!ranges_in_bounds(&[(0, 6), (4, 10)], 10));
        assert!(!ranges_in_bounds(&[(6, 10), (0, 4)], 10));
    }

    const LEN: usize = 4096;

    fn body() -> Vec<u8> {
        (0..LEN).map(|i| (i % 251) as u8).collect()
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Mode {
        Correct,
        ShiftedStart,
        WrongTotal,
        MissingContentRange,
    }

    /// Local loopback fixture: probe (`bytes=0-0`) is always answered correctly; other ranges per `mode`.
    /// Returns (url, server task, data ranges requested after the probe).
    async fn serve(mode: Mode) -> (String, tokio::task::JoinHandle<()>, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/fixture.bin", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let task = tokio::spawn(async move {
            let data = body();
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut req = Vec::new();
                loop {
                    let mut buf = [0; 1024];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..n]);
                    if req.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&req).to_ascii_lowercase();
                let range = text
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .map(str::to_string);
                let (status, extra, payload): (&str, String, &[u8]) = match &range {
                    Some(r) => {
                        if r != "0-0" {
                            log.lock().unwrap().push(r.clone());
                        }
                        let (s, e) = r.split_once('-').unwrap();
                        let (s, e): (usize, usize) = (s.parse().unwrap(), e.parse().unwrap());
                        let m = if r == "0-0" { Mode::Correct } else { mode };
                        let cr = match m {
                            Mode::Correct => format!("Content-Range: bytes {s}-{e}/{LEN}\r\n"),
                            Mode::ShiftedStart => {
                                format!("Content-Range: bytes 0-{}/{LEN}\r\n", e - s)
                            }
                            Mode::WrongTotal => {
                                format!("Content-Range: bytes {s}-{e}/{}\r\n", LEN * 2)
                            }
                            Mode::MissingContentRange => String::new(),
                        };
                        // ShiftedStart sends bytes from offset 0, as a misbehaving server would.
                        let payload = if m == Mode::ShiftedStart {
                            &data[..=e - s]
                        } else {
                            &data[s..=e]
                        };
                        ("206 Partial Content", cr, payload)
                    }
                    None => ("200 OK", String::new(), &data[..]),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nETag: \"v2\"\r\n{extra}Connection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                if !text.starts_with("head ") {
                    let _ = stream.write_all(payload).await;
                }
            }
        });
        (url, task, seen)
    }

    fn fixture_spec(url: &str) -> RequestSpec {
        let mut spec = RequestSpec::get(url);
        spec.test_loopback = true;
        spec
    }

    async fn run(spec: &RequestSpec, dir: &Path, connections: usize) -> Result<DownloadedFile> {
        let client = crate::request::build_client().unwrap();
        let cancel = CancellationToken::new();
        let (tracker, _) = ProgressTracker::new(None);
        let opts = HttpOptions {
            connections,
            max_retries: 0,
            min_split_size: 512,
            ..Default::default()
        };
        tokio::time::timeout(
            Duration::from_secs(10),
            download_http(
                &client,
                spec,
                dir,
                Some("fixture.bin"),
                &opts,
                &cancel,
                &tracker,
                None,
            ),
        )
        .await
        .expect("download timed out")
    }

    #[tokio::test]
    async fn rejects_206_with_mismatched_content_range() {
        for mode in [
            Mode::ShiftedStart,
            Mode::WrongTotal,
            Mode::MissingContentRange,
        ] {
            let (url, server, _) = serve(mode).await;
            let dir = tempfile::tempdir().unwrap();
            let err = run(&fixture_spec(&url), dir.path(), 2).await.unwrap_err();
            assert!(
                matches!(&err, DownloadError::Other(m) if m.contains("Content-Range")),
                "unexpected error: {err:?}"
            );
            assert!(
                !dir.path().join("fixture.bin").exists(),
                "a corrupt file was finalized"
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn accepts_exact_content_range() {
        let (url, server, _) = serve(Mode::Correct).await;
        let dir = tempfile::tempdir().unwrap();
        let out = run(&fixture_spec(&url), dir.path(), 4).await.unwrap();
        assert_eq!(std::fs::read(out.path).unwrap(), body());
        server.abort();
    }

    /// Write a `.part` of the right size filled with junk plus a sidecar claiming it is complete.
    fn plant(dir: &Path, state: &ResumeState, part_len: usize) {
        let target = dir.join("fixture.bin");
        std::fs::write(part_path(&target), vec![0xEE; part_len]).unwrap();
        write_state(&sidecar_path(&target), state);
    }

    fn good_state(url: &str) -> ResumeState {
        ResumeState {
            request: RequestSpec::get(url),
            final_url: url::Url::parse(url).unwrap().to_string(),
            size: LEN as u64,
            etag: Some("\"v2\"".into()),
            last_modified: None,
            file_name: "fixture.bin".into(),
            completed: vec![(0, LEN as u64)],
        }
    }

    #[test]
    fn resume_is_disabled_when_request_context_cannot_be_revalidated_safely() {
        let url = "https://example.test/file.bin";
        let state = good_state(url);
        let probe = ProbeResult {
            final_url: url::Url::parse(url).unwrap().to_string(),
            size: Some(LEN as u64),
            accept_ranges: true,
            etag: Some("\"v2\"".into()),
            last_modified: None,
            content_type: None,
            file_name: "fixture.bin".into(),
        };
        let mut authenticated = RequestSpec::get(url);
        authenticated
            .headers
            .push(("Authorization".into(), "Bearer account-a".into()));
        assert!(resume_ranges(
            &state,
            &authenticated,
            &probe,
            "fixture.bin",
            LEN as u64,
            Some(LEN as u64)
        )
        .is_none());

        let signed_url = "https://example.test/file.bin?token=account-a";
        let mut signed_state = good_state(signed_url);
        signed_state.request.url = persisted_url(signed_url).unwrap();
        let signed_probe = ProbeResult {
            final_url: url::Url::parse(signed_url).unwrap().to_string(),
            ..probe
        };
        assert!(resume_ranges(
            &signed_state,
            &RequestSpec::get(signed_url),
            &signed_probe,
            "fixture.bin",
            LEN as u64,
            Some(LEN as u64)
        )
        .is_none());
    }

    #[tokio::test]
    async fn stale_or_mismatched_sidecar_is_discarded() {
        type Tweak = fn(&mut ResumeState, &mut usize);
        let cases: Vec<(&str, Tweak)> = vec![
            ("etag missing in sidecar", |s, _| s.etag = None),
            ("etag changed", |s, _| s.etag = Some("\"v1\"".into())),
            ("last-modified appeared", |s, _| {
                s.last_modified = Some("Mon, 01 Jan 2024 00:00:00 GMT".into())
            }),
            ("different request URL", |s, _| {
                s.request = RequestSpec::get("http://127.0.0.1:1/other.bin")
            }),
            ("different final URL", |s, _| {
                s.final_url = "http://127.0.0.1:1/elsewhere.bin".into()
            }),
            ("different file name", |s, _| {
                s.file_name = "other.bin".into()
            }),
            ("different size", |s, _| s.size = LEN as u64 / 2),
            ("range past end of object", |s, _| {
                s.completed = vec![(0, LEN as u64 + 100)]
            }),
            ("overlapping ranges", |s, _| {
                s.completed = vec![(0, 3000), (1000, LEN as u64)]
            }),
            ("empty range", |s, _| {
                s.completed = vec![(10, 10), (0, LEN as u64)]
            }),
            ("part file truncated", |_, len| *len = LEN / 2),
        ];
        for (label, tweak) in cases {
            let (url, server, seen) = serve(Mode::Correct).await;
            let dir = tempfile::tempdir().unwrap();
            let mut state = good_state(&url);
            let mut part_len = LEN;
            tweak(&mut state, &mut part_len);
            plant(dir.path(), &state, part_len);
            let out = run(&fixture_spec(&url), dir.path(), 2)
                .await
                .unwrap_or_else(|e| panic!("{label}: {e:?}"));
            assert_eq!(
                std::fs::read(&out.path).unwrap(),
                body(),
                "{label}: stale bytes were trusted"
            );
            assert!(
                !seen.lock().unwrap().is_empty(),
                "{label}: nothing was re-downloaded"
            );
            server.abort();
        }
    }

    #[tokio::test]
    async fn matching_sidecar_resumes_only_missing_bytes() {
        let (url, server, seen) = serve(Mode::Correct).await;
        let dir = tempfile::tempdir().unwrap();
        let half = LEN / 2;
        let mut state = good_state(&url);
        state.completed = vec![(0, half as u64)];
        plant(dir.path(), &state, LEN);
        // The first half on disk is real data; only the second half may be fetched.
        let target = dir.path().join("fixture.bin");
        let mut part = body();
        part[half..].fill(0xEE);
        std::fs::write(part_path(&target), &part).unwrap();
        let out = run(&fixture_spec(&url), dir.path(), 1).await.unwrap();
        assert_eq!(std::fs::read(out.path).unwrap(), body());
        let requested = seen.lock().unwrap().clone();
        assert_eq!(requested, vec![format!("{half}-{}", LEN - 1)]);
        server.abort();
    }
}
