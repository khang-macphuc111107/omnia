//! Session recording: action steps, frames, GIF and a replayable Playwright spec.
#![allow(clippy::chunks_exact_to_as_chunks)]

pub mod codegen;
pub mod gif;

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::capture::{ImageFormat, ScreenshotOptions};
use crate::tab::Tab;
pub use codegen::{ElementInfo, Step};

/// Hard cap on stored frames per recording.
pub const MAX_FRAMES: usize = 600;
/// Frames are downscaled so the longer side is at most this many pixels.
pub const FRAME_MAX_SIDE: u32 = 960;
/// The GIF never runs longer than this.
pub const MAX_GIF_SECONDS: u64 = 120;
const DEFAULT_FPS: f32 = 1.0;
const MAX_FPS: f32 = 4.0;

struct FrameMeta {
    file: PathBuf,
    t_ms: u64,
    /// Click marker as fractions of the frame (0..1).
    marker: Option<(f64, f64)>,
}

struct Active {
    name: String,
    dir: PathBuf,
    frames_dir: PathBuf,
    started: Instant,
    started_unix_ms: u64,
    steps: Vec<Step>,
    frames: Vec<FrameMeta>,
    reserved: usize,
    dropped: usize,
    secrets: Vec<String>,
    last_hash: Option<u64>,
    fps: f32,
    idle: Option<tokio::task::JoinHandle<()>>,
}

/// Everything collected while recording, ready to be written out.
pub struct Finished {
    name: String,
    dir: PathBuf,
    frames_dir: PathBuf,
    started_unix_ms: u64,
    duration_ms: u64,
    steps: Vec<Step>,
    frames: Vec<FrameMeta>,
    dropped: usize,
    secrets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFiles {
    pub dir: PathBuf,
    pub gif: Option<PathBuf>,
    pub steps_json: PathBuf,
    pub spec: PathBuf,
    pub steps: usize,
    pub frames: usize,
    pub dropped_frames: usize,
    pub duration_ms: u64,
    pub secrets: Vec<String>,
    pub gif_error: Option<String>,
}

#[derive(Default)]
pub struct Recorder {
    state: Mutex<Option<Active>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// `YYYYMMDD-HHMMSS` (UTC) from unix seconds.
pub fn utc_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "recording".into()
    } else {
        cleaned
    }
}

/// Per-frame delays in centiseconds from capture timestamps: gaps are clamped to
/// 0.1-2.5 s, the last frame lingers 1.5 s, and the total is capped.
pub fn frame_delays_cs(times_ms: &[u64]) -> Vec<u16> {
    let mut delays: Vec<u64> = times_ms
        .iter()
        .enumerate()
        .map(|(i, t)| match times_ms.get(i + 1) {
            Some(next) => next.saturating_sub(*t).clamp(100, 2500),
            None => 1500,
        })
        .collect();
    let total: u64 = delays.iter().sum();
    let cap = MAX_GIF_SECONDS * 1000;
    if total > cap {
        for d in &mut delays {
            *d = (*d * cap / total).max(20);
        }
    }
    delays
        .into_iter()
        .map(|d| (d / 10).clamp(2, u16::MAX as u64) as u16)
        .collect()
}

impl Recorder {
    fn lock(&self) -> MutexGuard<'_, Option<Active>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_active(&self) -> bool {
        self.lock().is_some()
    }

    /// Begins a recording under `root/<name>-<timestamp>/`.
    pub fn start(
        &self,
        root: &Path,
        name: Option<&str>,
        fps: Option<f64>,
    ) -> Result<PathBuf, String> {
        let mut state = self.lock();
        if let Some(active) = state.as_ref() {
            return Err(format!(
                "already recording \"{}\"; stop it first",
                active.name
            ));
        }
        let name = sanitize_name(name.unwrap_or(""));
        let dir = root.join(format!("{name}-{}", utc_stamp(now_ms() / 1000)));
        let dir = (0..100)
            .map(|n| {
                if n == 0 {
                    dir.clone()
                } else {
                    PathBuf::from(format!("{}-{n}", dir.display()))
                }
            })
            .find(|d| !d.exists())
            .ok_or("could not pick a recording folder")?;
        let frames_dir = dir.join(".frames");
        std::fs::create_dir_all(&frames_dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let fps = fps.map_or(DEFAULT_FPS, |f| f as f32).clamp(0.0, MAX_FPS);
        *state = Some(Active {
            name,
            dir: dir.clone(),
            frames_dir,
            started: Instant::now(),
            started_unix_ms: now_ms(),
            steps: Vec::new(),
            frames: Vec::new(),
            reserved: 0,
            dropped: 0,
            secrets: Vec::new(),
            last_hash: None,
            fps,
            idle: None,
        });
        Ok(dir)
    }

    /// Spawns the low-rate idle frame task (no-op for fps 0 or when not recording).
    pub fn start_idle(self: &Arc<Self>, browser: Arc<crate::Browser>) {
        let fps = match self.lock().as_ref() {
            Some(a) if a.fps > 0.0 => a.fps,
            _ => return,
        };
        let recorder = self.clone();
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs_f32(1.0 / fps));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if !recorder.is_active() || browser.is_closed() {
                    break;
                }
                if let Ok(tab) = browser.active_tab().await {
                    recorder.capture_frame(&tab, None, true).await;
                }
            }
        });
        if let Some(active) = self.lock().as_mut() {
            active.idle = Some(handle);
        }
    }

    /// Allocates the next `OMNIA_SECRET_n` name.
    pub fn next_secret(&self) -> String {
        let mut state = self.lock();
        match state.as_mut() {
            Some(a) => {
                let name = format!("OMNIA_SECRET_{}", a.secrets.len() + 1);
                a.secrets.push(name.clone());
                name
            }
            None => "OMNIA_SECRET_1".into(),
        }
    }

    pub fn push_step(
        &self,
        tool: &str,
        input: Value,
        url: String,
        locator: Option<String>,
        element: Option<ElementInfo>,
        secret: Option<String>,
    ) {
        if let Some(a) = self.lock().as_mut() {
            let index = a.steps.len();
            a.steps.push(Step {
                index,
                tool: tool.into(),
                input,
                url,
                at_ms: a.started.elapsed().as_millis() as u64,
                timestamp: now_ms(),
                locator,
                element,
                secret,
            });
        }
    }

    /// Claims a frame slot; `None` once the cap is reached.
    fn reserve_frame(&self) -> Option<(usize, PathBuf, u64)> {
        let mut state = self.lock();
        let a = state.as_mut()?;
        if a.reserved >= MAX_FRAMES {
            a.dropped += 1;
            return None;
        }
        let index = a.reserved;
        a.reserved += 1;
        Some((
            index,
            a.frames_dir.join(format!("{index:04}.png")),
            a.started.elapsed().as_millis() as u64,
        ))
    }

    fn commit_frame(&self, file: PathBuf, t_ms: u64, marker: Option<(f64, f64)>) {
        if let Some(a) = self.lock().as_mut() {
            a.frames.push(FrameMeta { file, t_ms, marker });
        }
    }

    /// Captures a downscaled viewport frame. Idle frames identical to the previous one are skipped.
    pub async fn capture_frame(&self, tab: &Tab, marker: Option<(f64, f64)>, idle: bool) {
        if !self.is_active() {
            return;
        }
        let options = ScreenshotOptions {
            format: ImageFormat::Png,
            max_dimension: Some(FRAME_MAX_SIDE),
            ..Default::default()
        };
        let shot =
            match tokio::time::timeout(Duration::from_secs(5), tab.screenshot(&options)).await {
                Ok(Ok(shot)) => shot,
                _ => return,
            };
        self.store_frame(&shot.data, marker, idle).await;
    }

    /// Persists already-captured PNG bytes as the next frame.
    pub async fn store_frame(&self, png: &[u8], marker: Option<(f64, f64)>, idle: bool) -> bool {
        let mut hasher = DefaultHasher::new();
        png.hash(&mut hasher);
        let hash = hasher.finish();
        if idle {
            let mut state = self.lock();
            let Some(a) = state.as_mut() else {
                return false;
            };
            if a.last_hash == Some(hash) {
                return false;
            }
        }
        let Some((_, file, t_ms)) = self.reserve_frame() else {
            return false;
        };
        if tokio::fs::write(&file, png).await.is_err() {
            return false;
        }
        if let Some(a) = self.lock().as_mut() {
            a.last_hash = Some(hash);
        }
        self.commit_frame(file, t_ms, marker);
        true
    }

    pub fn status(&self) -> String {
        match self.lock().as_ref() {
            None => "Not recording.".into(),
            Some(a) => format!(
                "Recording \"{}\" for {} s: {} steps, {} frames{} -> {}",
                a.name,
                a.started.elapsed().as_secs(),
                a.steps.len(),
                a.frames.len(),
                if a.dropped > 0 {
                    format!(" ({} dropped at the {MAX_FRAMES}-frame cap)", a.dropped)
                } else {
                    String::new()
                },
                a.dir.display()
            ),
        }
    }

    /// Ends the recording; `None` when none was active.
    pub fn stop(&self) -> Option<Finished> {
        let mut active = self.lock().take()?;
        if let Some(task) = active.idle.take() {
            task.abort();
        }
        active.frames.sort_by_key(|f| f.t_ms);
        Some(Finished {
            name: active.name,
            dir: active.dir,
            frames_dir: active.frames_dir,
            started_unix_ms: active.started_unix_ms,
            duration_ms: active.started.elapsed().as_millis() as u64,
            steps: active.steps,
            frames: active.frames,
            dropped: active.dropped,
            secrets: active.secrets,
        })
    }
}

impl Finished {
    /// Writes `steps.json`, `replay.spec.ts` and `recording.gif`, then removes the frame cache. Blocking.
    pub fn write(self) -> Result<RecordingFiles, String> {
        let steps_json = self.dir.join("steps.json");
        let spec = self.dir.join("replay.spec.ts");
        let first_url = self.steps.first().map(|s| s.url.clone());
        let doc = serde_json::json!({
            "name": self.name,
            "startedAt": self.started_unix_ms,
            "durationMs": self.duration_ms,
            "firstUrl": first_url,
            "frames": self.frames.len(),
            "droppedFrames": self.dropped,
            "secrets": self.secrets,
            "steps": self.steps,
        });
        std::fs::write(
            &steps_json,
            serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("cannot write steps.json: {e}"))?;
        std::fs::write(
            &spec,
            codegen::playwright_spec(&self.name, &self.steps, &self.secrets),
        )
        .map_err(|e| format!("cannot write replay.spec.ts: {e}"))?;
        let gif_path = self.dir.join("recording.gif");
        let (gif, gif_error) = match build_gif(&self.frames) {
            Ok(bytes) => match std::fs::write(&gif_path, bytes) {
                Ok(()) => (Some(gif_path), None),
                Err(e) => (None, Some(format!("cannot write recording.gif: {e}"))),
            },
            Err(e) => (None, Some(e)),
        };
        let _ = std::fs::remove_dir_all(&self.frames_dir);
        Ok(RecordingFiles {
            dir: self.dir,
            gif,
            steps_json,
            spec,
            steps: self.steps.len(),
            frames: self.frames.len(),
            dropped_frames: self.dropped,
            duration_ms: self.duration_ms,
            secrets: self.secrets,
            gif_error,
        })
    }
}

fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let (w, h) = (info.width, info.height);
    let pixels = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::Rgb => pixels
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::Grayscale => pixels.iter().flat_map(|g| [*g, *g, *g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => pixels
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Indexed => return Err("indexed png frame".into()),
    };
    Ok((w, h, rgba))
}

/// Nearest-neighbour resize of an RGBA buffer.
pub fn resize_rgba(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    let mut out = Vec::with_capacity(dw as usize * dh as usize * 4);
    for y in 0..dh {
        let sy = (y as u64 * sh as u64 / dh as u64) as usize;
        for x in 0..dw {
            let sx = (x as u64 * sw as u64 / dw as u64) as usize;
            let i = (sy * sw as usize + sx) * 4;
            out.extend_from_slice(&src[i..i + 4]);
        }
    }
    out
}

/// Draws a red dot with a white ring at the fractional position.
pub fn draw_marker(rgba: &mut [u8], w: u32, h: u32, fx: f64, fy: f64) {
    let cx = (fx.clamp(0.0, 1.0) * (w as f64 - 1.0)).round() as i64;
    let cy = (fy.clamp(0.0, 1.0) * (h as f64 - 1.0)).round() as i64;
    let radius = ((w.max(h) as f64 / 90.0).round() as i64).clamp(5, 14);
    for y in (cy - radius - 2).max(0)..=(cy + radius + 2).min(h as i64 - 1) {
        for x in (cx - radius - 2).max(0)..=(cx + radius + 2).min(w as i64 - 1) {
            let d2 = (x - cx).pow(2) + (y - cy).pow(2);
            let colour = if d2 <= radius * radius {
                [230, 30, 30]
            } else if d2 <= (radius + 2) * (radius + 2) {
                [255, 255, 255]
            } else {
                continue;
            };
            let i = (y as usize * w as usize + x as usize) * 4;
            rgba[i..i + 3].copy_from_slice(&colour);
        }
    }
}

fn load_frame(meta: &FrameMeta, cw: u32, ch: u32) -> Option<Vec<u8>> {
    let bytes = std::fs::read(&meta.file).ok()?;
    let (w, h, rgba) = decode_png(&bytes).ok()?;
    let mut rgba = resize_rgba(&rgba, w, h, cw, ch);
    if let Some((fx, fy)) = meta.marker {
        draw_marker(&mut rgba, cw, ch, fx, fy);
    }
    Some(rgba)
}

fn build_gif(frames: &[FrameMeta]) -> Result<Vec<u8>, String> {
    let first = frames.first().ok_or("no frames were captured")?;
    let bytes = std::fs::read(&first.file).map_err(|e| e.to_string())?;
    let (cw, ch, _) = decode_png(&bytes)?;
    if cw == 0 || ch == 0 || cw > u16::MAX as u32 || ch > u16::MAX as u32 {
        return Err("unusable frame size".into());
    }
    let mut histogram = HashMap::new();
    let mut usable = Vec::new();
    for (i, meta) in frames.iter().enumerate() {
        if let Some(rgba) = load_frame(meta, cw, ch) {
            gif::sample_histogram(&mut histogram, &rgba, 5);
            usable.push(i);
        }
    }
    if usable.is_empty() {
        return Err("no readable frames".into());
    }
    let mut palette = gif::Palette::from_histogram(&histogram);
    let times: Vec<u64> = usable.iter().map(|i| frames[*i].t_ms).collect();
    let delays = frame_delays_cs(&times);
    let encoded: Vec<gif::GifFrame> = usable
        .iter()
        .zip(delays)
        .filter_map(|(i, delay_cs)| {
            load_frame(&frames[*i], cw, ch).map(|rgba| gif::GifFrame { rgba, delay_cs })
        })
        .collect();
    Ok(gif::encode_gif(
        cw as u16,
        ch as u16,
        &encoded,
        &mut palette,
    ))
}

/// One finished recording folder, as listed to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEntry {
    pub name: String,
    pub path: PathBuf,
    /// Unix milliseconds (folder modification time).
    pub created: u64,
    pub steps: usize,
    pub has_gif: bool,
}

/// Lists recording folders (those holding a `steps.json`), newest first.
pub fn list_recordings(root: &Path) -> Vec<RecordingEntry> {
    let Ok(read) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<RecordingEntry> = read
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let steps_file = dir.join("steps.json");
            if !dir.is_dir() || !steps_file.is_file() {
                return None;
            }
            let doc: Value = serde_json::from_slice(&std::fs::read(&steps_file).ok()?).ok()?;
            let created = doc["startedAt"].as_u64().unwrap_or_else(|| {
                std::fs::metadata(&dir)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64)
            });
            Some(RecordingEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                steps: doc["steps"].as_array().map_or(0, Vec::len),
                has_gif: dir.join("recording.gif").is_file(),
                path: dir,
                created,
            })
        })
        .collect();
    out.sort_by_key(|e| std::cmp::Reverse(e.created));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn png(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().unwrap();
            let data: Vec<u8> = (0..w * h).flat_map(|_| rgb).collect();
            writer.write_image_data(&data).unwrap();
        }
        out
    }

    #[test]
    fn stamps_and_names() {
        assert_eq!(utc_stamp(0), "19700101-000000");
        assert_eq!(utc_stamp(1_700_000_000), "20231114-221320");
        assert_eq!(sanitize_name("  my flow/../x "), "my-flow----x");
        assert_eq!(sanitize_name("***"), "recording");
        assert_eq!(sanitize_name(""), "recording");
    }

    #[test]
    fn delays_are_clamped_and_capped() {
        assert_eq!(
            frame_delays_cs(&[0, 10, 5000, 5100]),
            vec![10, 250, 10, 150]
        );
        let times: Vec<u64> = (0..200).map(|i| i * 2500).collect();
        let total: u32 = frame_delays_cs(&times).iter().map(|d| *d as u32).sum();
        assert!(
            total <= (MAX_GIF_SECONDS * 100) as u32 + 200,
            "total {total}"
        );
    }

    #[tokio::test]
    async fn frame_cap_and_idle_dedupe() {
        let root = tempfile::tempdir().unwrap();
        let rec = Recorder::default();
        let dir = rec.start(root.path(), Some("cap"), None).unwrap();
        assert!(rec.start(root.path(), None, None).is_err());
        let data = png(2, 2, [1, 2, 3]);
        assert!(rec.store_frame(&data, None, true).await);
        assert!(
            !rec.store_frame(&data, None, true).await,
            "identical idle frame skipped"
        );
        assert!(
            rec.store_frame(&data, None, false).await,
            "action frames are always kept"
        );
        for _ in 0..MAX_FRAMES + 5 {
            rec.store_frame(&data, None, false).await;
        }
        let finished = rec.stop().unwrap();
        assert_eq!(finished.frames.len(), MAX_FRAMES);
        assert!(finished.dropped >= 7);
        assert!(dir.join(".frames").is_dir());
    }

    #[tokio::test]
    async fn stop_writes_gif_steps_and_spec_with_redaction() {
        let root = tempfile::tempdir().unwrap();
        let rec = Recorder::default();
        rec.start(root.path(), Some("login flow"), Some(0.0))
            .unwrap();
        let secret = rec.next_secret();
        assert_eq!(secret, "OMNIA_SECRET_1");
        rec.push_step(
            "browser_navigate",
            json!({"url": "https://a.test/login"}),
            "https://a.test/login".into(),
            None,
            None,
            None,
        );
        rec.push_step(
            "browser_type",
            json!({"ref": "e3", "text": "[redacted]"}),
            "https://a.test/login".into(),
            Some("page.getByLabel('Password')".into()),
            None,
            Some(secret),
        );
        rec.store_frame(&png(40, 30, [250, 250, 250]), None, false)
            .await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        rec.store_frame(&png(40, 30, [10, 120, 200]), Some((0.5, 0.5)), false)
            .await;
        assert!(rec.status().contains("2 steps, 2 frames"));
        let finished = rec.stop().unwrap();
        assert!(!rec.is_active());
        let files = tokio::task::spawn_blocking(move || finished.write())
            .await
            .unwrap()
            .unwrap();
        let gif = std::fs::read(files.gif.as_ref().expect("gif written")).unwrap();
        assert_eq!(&gif[..6], b"GIF89a");
        assert_eq!(u16::from_le_bytes([gif[6], gif[7]]), 40);
        assert_eq!(*gif.last().unwrap(), 0x3B);
        let spec = std::fs::read_to_string(&files.spec).unwrap();
        assert!(spec.contains("page.goto('https://a.test/login')"));
        assert!(spec.contains("fill(process.env.OMNIA_SECRET_1 ?? '')"));
        let steps = std::fs::read_to_string(&files.steps_json).unwrap();
        assert!(steps.contains("OMNIA_SECRET_1") && steps.contains("[redacted]"));
        assert!(!files.dir.join(".frames").exists());
        let listed = list_recordings(root.path());
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].steps, listed[0].has_gif), (2, true));
    }
}
