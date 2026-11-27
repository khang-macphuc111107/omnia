//! Lossless FFmpeg `-c copy` mux/clip (`[In]`/`[Out]`, `mov_text` soft-sub) and
//! `ffprobe` verification engine (porting `idmMediaConverter.js` cleanly in `#![forbid(unsafe_code)]`).

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time;

use crate::types::{validate_safe_local_path, DownloaderError};

#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_MEDIA_TIMEOUT_SECS: u64 = 180;
const MAX_MEDIA_STD_BYTES: usize = 512 * 1024;

/// Discovers an external `ffmpeg` or `ffprobe` binary without traversing inside `workspace_root`.
#[must_use]
pub fn find_media_binary(tool_name: &str) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) {
        format!("{tool_name}.exe")
    } else {
        tool_name.to_string()
    };

    let env_key = if tool_name.eq_ignore_ascii_case("ffmpeg") {
        "OMNIA_FFMPEG_BIN"
    } else {
        "OMNIA_FFPROBE_BIN"
    };
    if let Ok(raw) = env::var(env_key) {
        let p = PathBuf::from(raw.trim());
        if p.is_file() {
            return Some(p);
        }
    }

    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join(&exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let extra_candidates = [
        PathBuf::from(r"E:\Users\khang\Documents\ChatGPT\Gemini Notebook\tools\ffmpeg\ffmpeg-9.0.2-essentials_build\bin")
            .join(&exe_name),
        PathBuf::from(r"D:\OmniaData\tools\ffmpeg\bin").join(&exe_name),
    ];
    extra_candidates.into_iter().find(|p| p.is_file())
}

/// Extracted stream summary returned by `ffprobe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FfprobeStreamSummary {
    pub index: u32,
    pub codec_type: String,
    pub codec_name: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub language: Option<String>,
}

/// Verified `ffprobe` media container report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FfprobeReport {
    pub path: String,
    pub format_name: String,
    pub duration_secs: Option<f64>,
    pub size_bytes: u64,
    pub streams: Vec<FfprobeStreamSummary>,
}

/// Request to mux, clip (`[In]`/`[Out]`), or attach soft subtitles using FFmpeg `-c copy`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMuxRequest {
    pub video_input: PathBuf,
    pub audio_input: Option<PathBuf>,
    pub subtitle_input: Option<PathBuf>,
    pub subtitle_lang: Option<String>,
    pub output_path: PathBuf,
    #[serde(default, alias = "clip_start_sec", alias = "clipStartSec")]
    pub clip_in_secs: Option<f64>,
    #[serde(default, alias = "clip_end_sec", alias = "clipEndSec")]
    pub clip_out_secs: Option<f64>,
    pub workspace_root: Option<PathBuf>,
    pub verify_with_ffprobe: bool,
    pub timeout_secs: Option<u64>,
}

/// Computes the half-open segment index range `[start_idx, end_idx)` covering `[clip_start_sec, clip_end_sec]`
/// for lossless HLS/DASH segment slicing without downloading unrelated segments.
#[must_use]
pub fn slice_segments_for_clip_range(
    segment_durations_secs: &[f64],
    clip_start_sec: Option<f64>,
    clip_end_sec: Option<f64>,
) -> (usize, usize) {
    if segment_durations_secs.is_empty() {
        return (0, 0);
    }
    let start_t = clip_start_sec.unwrap_or(0.0).max(0.0);
    let end_t = clip_end_sec.unwrap_or(f64::INFINITY);
    if end_t <= start_t {
        return (0, 0);
    }
    let mut cursor = 0.0_f64;
    let mut first: Option<usize> = None;
    let mut last_excl = 0usize;
    for (idx, &dur_raw) in segment_durations_secs.iter().enumerate() {
        let dur = if dur_raw.is_finite() && dur_raw > 0.0 {
            dur_raw
        } else {
            0.0
        };
        let seg_start = cursor;
        let seg_end = cursor + dur;
        cursor = seg_end;
        if seg_end > start_t && seg_start < end_t {
            if first.is_none() {
                first = Some(idx);
            }
            last_excl = idx + 1;
        }
    }
    match first {
        Some(s) => (s, last_excl),
        None => (0, 0),
    }
}

/// Outcome of a bounded FFmpeg `-c copy` operation and optional `ffprobe` verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaMuxOutcome {
    pub output_path: PathBuf,
    pub ffmpeg_args: Vec<String>,
    pub output_bytes: u64,
    pub verified: bool,
    pub ffprobe: Option<FfprobeReport>,
}

/// Validates input/output containment and constructs deterministic lossless `-c copy` FFmpeg args.
pub fn build_ffmpeg_mux_args(req: &MediaMuxRequest) -> Result<Vec<String>, DownloaderError> {
    let ws = req.workspace_root.as_deref();
    let safe_video = validate_safe_local_path(&req.video_input, ws)?;
    let safe_output = validate_safe_local_path(&req.output_path, ws)?;
    if let Some(in_s) = req.clip_in_secs {
        if !in_s.is_finite() || in_s < 0.0 {
            return Err(DownloaderError::InvalidInput(
                "clip_in_secs must be finite and >= 0".into(),
            ));
        }
    }
    if let Some(out_s) = req.clip_out_secs {
        if !out_s.is_finite() || out_s <= req.clip_in_secs.unwrap_or(0.0) {
            return Err(DownloaderError::InvalidInput(
                "clip_out_secs must be greater than clip_in_secs".into(),
            ));
        }
    }

    let mut args = vec!["-y".to_string(), "-hide_banner".to_string(), "-loglevel".to_string(), "error".to_string()];

    if let Some(in_s) = req.clip_in_secs {
        args.push("-ss".to_string());
        args.push(format!("{in_s:.3}"));
    }
    if let Some(out_s) = req.clip_out_secs {
        args.push("-to".to_string());
        args.push(format!("{out_s:.3}"));
    }

    args.push("-i".to_string());
    args.push(safe_video.to_string_lossy().into_owned());

    let mut input_idx = 1usize;
    let audio_idx = if let Some(audio) = &req.audio_input {
        let safe_audio = validate_safe_local_path(audio, ws)?;
        args.push("-i".to_string());
        args.push(safe_audio.to_string_lossy().into_owned());
        let idx = input_idx;
        input_idx += 1;
        Some(idx)
    } else {
        None
    };

    let sub_idx = if let Some(sub) = &req.subtitle_input {
        let safe_sub = validate_safe_local_path(sub, ws)?;
        args.push("-i".to_string());
        args.push(safe_sub.to_string_lossy().into_owned());
        let idx = input_idx;
        Some(idx)
    } else {
        None
    };

    // Map streams explicitly for lossless copy + mov_text soft-sub muxing.
    args.push("-map".to_string());
    args.push("0:v:0".to_string());
    if let Some(aidx) = audio_idx {
        args.push("-map".to_string());
        args.push(format!("{aidx}:a:0?"));
    } else {
        args.push("-map".to_string());
        args.push("0:a:0?".to_string());
    }
    if let Some(sidx) = sub_idx {
        args.push("-map".to_string());
        args.push(format!("{sidx}:s:0?"));
    }

    args.push("-c".to_string());
    args.push("copy".to_string());

    if sub_idx.is_some() {
        let ext = safe_output
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if ext == "mp4" || ext == "m4v" || ext == "mov" {
            args.push("-c:s".to_string());
            args.push("mov_text".to_string());
        }
        if let Some(lang) = req.subtitle_lang.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.push("-metadata:s:s:0".to_string());
            args.push(format!("language={lang}"));
        }
    }

    if safe_output
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
    {
        args.push("-movflags".to_string());
        args.push("+faststart".to_string());
    }

    args.push(safe_output.to_string_lossy().into_owned());
    Ok(args)
}

/// Runs `ffprobe` cleanly on `path` and returns verified stream & container metadata.
pub async fn run_ffprobe(
    path: &Path,
    workspace_root: Option<&Path>,
) -> Result<FfprobeReport, DownloaderError> {
    let safe_path = validate_safe_local_path(path, workspace_root)?;
    let bin = find_media_binary("ffprobe").ok_or_else(|| {
        DownloaderError::InvalidInput("ffprobe binary unavailable on host PATH/tools".into())
    })?;
    let args = vec![
        "-v".to_string(),
        "quiet".to_string(),
        "-print_format".to_string(),
        "json".to_string(),
        "-show_format".to_string(),
        "-show_streams".to_string(),
        safe_path.to_string_lossy().into_owned(),
    ];
    let stdout = run_bounded_media_cmd(&bin, &args, Duration::from_secs(30)).await?;
    let parsed: Value = serde_json::from_slice(&stdout)?;
    parse_ffprobe_json(&safe_path, &parsed)
}

/// Parses `ffprobe -print_format json` output into [`FfprobeReport`].
pub fn parse_ffprobe_json(path: &Path, val: &Value) -> Result<FfprobeReport, DownloaderError> {
    let fmt = val.get("format").and_then(Value::as_object);
    let format_name = fmt
        .and_then(|f| f.get("format_name"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let duration_secs = fmt
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    let size_bytes = fmt
        .and_then(|f| f.get("size"))
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or_else(|| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0));

    let streams = val
        .get("streams")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let obj = s.as_object()?;
                    Some(FfprobeStreamSummary {
                        index: obj.get("index").and_then(Value::as_u64).unwrap_or(0) as u32,
                        codec_type: obj
                            .get("codec_type")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        codec_name: obj
                            .get("codec_name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        width: obj
                            .get("width")
                            .and_then(Value::as_u64)
                            .and_then(|n| u32::try_from(n).ok()),
                        height: obj
                            .get("height")
                            .and_then(Value::as_u64)
                            .and_then(|n| u32::try_from(n).ok()),
                        language: obj
                            .get("tags")
                            .and_then(|t| t.get("language"))
                            .and_then(Value::as_str)
                            .map(ToString::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(FfprobeReport {
        path: path.to_string_lossy().into_owned(),
        format_name,
        duration_secs,
        size_bytes,
        streams,
    })
}

/// Executes FFmpeg `-c copy` mux/clip/soft-sub conversion and optional `ffprobe` verification.
pub async fn convert_or_clip_media(req: MediaMuxRequest) -> Result<MediaMuxOutcome, DownloaderError> {
    let args = build_ffmpeg_mux_args(&req)?;
    let bin = find_media_binary("ffmpeg").ok_or_else(|| {
        DownloaderError::InvalidInput("ffmpeg binary unavailable on host PATH/tools".into())
    })?;
    let safe_output = validate_safe_local_path(&req.output_path, req.workspace_root.as_deref())?;
    if let Some(parent) = safe_output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let timeout = Duration::from_secs(
        req.timeout_secs
            .unwrap_or(DEFAULT_MEDIA_TIMEOUT_SECS)
            .clamp(5, 600),
    );
    let _ = run_bounded_media_cmd(&bin, &args, timeout).await?;
    let output_bytes = std::fs::metadata(&safe_output).map(|m| m.len()).unwrap_or(0);
    if output_bytes == 0 {
        return Err(DownloaderError::InvalidInput(
            "ffmpeg completed but produced an empty output file".into(),
        ));
    }

    let ffprobe = if req.verify_with_ffprobe {
        Some(run_ffprobe(&safe_output, req.workspace_root.as_deref()).await?)
    } else {
        None
    };
    let verified = ffprobe
        .as_ref()
        .is_some_and(|p| !p.streams.is_empty() && p.size_bytes > 0);

    Ok(MediaMuxOutcome {
        output_path: safe_output,
        ffmpeg_args: args,
        output_bytes,
        verified,
        ffprobe,
    })
}

async fn run_bounded_media_cmd(
    bin: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<Vec<u8>, DownloaderError> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(WINDOWS_CREATE_NO_WINDOW);

    let mut child = cmd.spawn()?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let res = time::timeout(timeout, async move {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        if let Some(ref mut so) = stdout_pipe {
            let mut limited = so.take(MAX_MEDIA_STD_BYTES as u64);
            let _ = limited.read_to_end(&mut out_buf).await;
        }
        if let Some(ref mut se) = stderr_pipe {
            let mut limited = se.take(64 * 1024);
            let _ = limited.read_to_end(&mut err_buf).await;
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, out_buf, err_buf))
    })
    .await;

    match res {
        Ok(Ok((status, out_buf, err_buf))) => {
            if !status.success() {
                let err_str = String::from_utf8_lossy(&err_buf);
                return Err(DownloaderError::InvalidInput(format!(
                    "media process '{}' exited {}: {}",
                    bin.display(),
                    status,
                    err_str.trim()
                )));
            }
            Ok(out_buf)
        }
        Ok(Err(err)) => Err(DownloaderError::Io(err)),
        Err(_) => Err(DownloaderError::InvalidInput(format!(
            "media process '{}' timed out after {}s",
            bin.display(),
            timeout.as_secs()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_args_build_lossless_copy_clip_and_mov_text_soft_sub() {
        let req = MediaMuxRequest {
            video_input: PathBuf::from(r"D:\OmniaData\tmp\video.mp4"),
            audio_input: Some(PathBuf::from(r"D:\OmniaData\tmp\audio.m4a")),
            subtitle_input: Some(PathBuf::from(r"D:\OmniaData\tmp\subs.srt")),
            subtitle_lang: Some("eng".to_string()),
            output_path: PathBuf::from(r"D:\OmniaData\tmp\muxed.mp4"),
            clip_in_secs: Some(12.5),
            clip_out_secs: Some(45.0),
            workspace_root: Some(PathBuf::from(r"D:\Omnia")),
            verify_with_ffprobe: true,
            timeout_secs: Some(60),
        };
        let args = build_ffmpeg_mux_args(&req).expect("build args");
        assert!(args.windows(2).any(|w| w == ["-ss", "12.500"]));
        assert!(args.windows(2).any(|w| w == ["-to", "45.000"]));
        assert!(args.windows(2).any(|w| w == ["-c", "copy"]));
        assert!(args.windows(2).any(|w| w == ["-c:s", "mov_text"]));
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]));
    }

    #[test]
    fn ffmpeg_args_block_unc_paths() {
        let req = MediaMuxRequest {
            video_input: PathBuf::from(r"\\evil-server\share\v.mp4"),
            audio_input: None,
            subtitle_input: None,
            subtitle_lang: None,
            output_path: PathBuf::from(r"D:\OmniaData\tmp\out.mp4"),
            clip_in_secs: None,
            clip_out_secs: None,
            workspace_root: None,
            verify_with_ffprobe: false,
            timeout_secs: None,
        };
        assert!(matches!(
            build_ffmpeg_mux_args(&req),
            Err(DownloaderError::ForbiddenPath { .. })
        ));
    }

    #[test]
    fn parse_ffprobe_json_extracts_streams() {
        let raw = serde_json::json!({
            "format": { "format_name": "mov,mp4,m4a,3gp", "duration": "32.500", "size": "1048576" },
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 },
                { "index": 1, "codec_type": "audio", "codec_name": "aac" }
            ]
        });
        let rep = parse_ffprobe_json(Path::new(r"D:\OmniaData\tmp\out.mp4"), &raw).expect("parse");
        assert_eq!(rep.streams.len(), 2);
        assert_eq!(rep.streams[0].codec_name, "h264");
        assert_eq!(rep.size_bytes, 1_048_576);
    }
}
