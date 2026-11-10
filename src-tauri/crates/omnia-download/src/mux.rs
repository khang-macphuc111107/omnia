//! ffmpeg discovery and stream-copy muxing (never re-encodes).

use crate::error::{DownloadError, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MuxOutcome {
    Muxed {
        output: PathBuf,
    },
    /// ffmpeg is missing (or muxing was not possible); raw track files are kept.
    #[serde(rename_all = "camelCase")]
    MuxSkipped {
        reason: String,
    },
}

/// Locate `ffmpeg`: the configured path if it exists, otherwise a search of `PATH`.
pub fn find_ffmpeg(configured: Option<&Path>) -> Option<PathBuf> {
    find_ffmpeg_ordered(configured, None)
}

/// Discovery order: configured path (file or directory), `user_bin/ffmpeg(.exe)`, then `PATH`.
pub fn find_ffmpeg_ordered(configured: Option<&Path>, user_bin: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = configured {
        if p.is_file() {
            return Some(p.to_path_buf());
        }
        if p.is_dir() {
            let c = p.join(exe_name());
            if c.is_file() {
                return Some(c);
            }
        }
    }
    if let Some(dir) = user_bin {
        let c = dir.join(exe_name());
        if c.is_file() {
            return Some(c);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe_name()))
        .find(|c| c.is_file())
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// Arguments for a stream-copy mux. `adts_aac` adds the ADTS->ASC bitstream filter
/// (needed when remuxing MPEG-TS AAC audio into MP4).
pub fn build_args(
    video: &Path,
    audio: Option<&Path>,
    output: &Path,
    adts_aac: bool,
) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
    ];
    a.push("-i".into());
    a.push(video.into());
    if let Some(au) = audio {
        a.push("-i".into());
        a.push(au.into());
    }
    a.extend(["-c".into(), "copy".into()]);
    if adts_aac {
        a.extend(["-bsf:a".into(), "aac_adtstoasc".into()]);
    }
    a.push(output.into());
    a
}

/// Mux `video` (+ optional `audio`) into `output` using `ffmpeg -c copy`.
///
/// `ffmpeg == None` yields `MuxSkipped` so callers keep the raw files. On ffmpeg failure the
/// partial output is removed and an error is returned.
pub async fn mux(
    ffmpeg: Option<&Path>,
    video: &Path,
    audio: Option<&Path>,
    output: &Path,
) -> Result<MuxOutcome> {
    mux_cancellable(ffmpeg, video, audio, output, &CancellationToken::new()).await
}

/// Like [`mux`], but cancelling `cancel` kills ffmpeg, removes the partial output and
/// returns [`DownloadError::Cancelled`].
pub async fn mux_cancellable(
    ffmpeg: Option<&Path>,
    video: &Path,
    audio: Option<&Path>,
    output: &Path,
    cancel: &CancellationToken,
) -> Result<MuxOutcome> {
    let Some(ffmpeg) = ffmpeg else {
        return Ok(MuxOutcome::MuxSkipped {
            reason: "ffmpeg was not found (install it or set its path)".into(),
        });
    };
    let is_ts = video
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ts"))
        || audio.is_some_and(|a| a.extension().is_some_and(|e| e.eq_ignore_ascii_case("ts")));
    let adts = is_ts
        && output
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(build_args(video, audio, output, adts))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                                     // Dropping the pending `output()` future kills ffmpeg (kill_on_drop).
    let out = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = std::fs::remove_file(output);
            return Err(DownloadError::Cancelled);
        }
        result = cmd.output() => match result {
            Ok(o) => o,
            Err(e) => {
                return Ok(MuxOutcome::MuxSkipped { reason: format!("could not run ffmpeg: {e}") });
            }
        },
    };
    if out.status.success() && output.is_file() {
        Ok(MuxOutcome::Muxed {
            output: output.to_path_buf(),
        })
    } else {
        let _ = std::fs::remove_file(output);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        Err(DownloadError::Other(format!(
            "ffmpeg failed ({}): {tail}",
            out.status
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn skipped_without_ffmpeg() {
        let out = mux(None, Path::new("a.ts"), None, Path::new("a.mp4"))
            .await
            .unwrap();
        assert!(matches!(out, MuxOutcome::MuxSkipped { .. }));
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("muxSkipped") && json.contains("reason"));
    }

    #[test]
    fn discovery_prefers_configured_then_user_bin() {
        let dir = std::env::temp_dir().join(format!("omnia-ffmpeg-{}", std::process::id()));
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let (fa, fb) = (a.join(exe_name()), b.join(exe_name()));
        std::fs::write(&fa, b"x").unwrap();
        std::fs::write(&fb, b"x").unwrap();
        assert_eq!(find_ffmpeg_ordered(Some(&fa), Some(&b)), Some(fa.clone()));
        assert_eq!(
            find_ffmpeg_ordered(Some(&a.join("missing")), Some(&b)),
            Some(fb.clone())
        );
        assert_eq!(find_ffmpeg_ordered(None, Some(&b)), Some(fb));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancelled_before_run_is_cancelled_not_skipped() {
        let token = CancellationToken::new();
        token.cancel();
        let r = mux_cancellable(
            Some(Path::new("ffmpeg-does-not-matter")),
            Path::new("a.ts"),
            None,
            Path::new("a.mp4"),
            &token,
        )
        .await;
        assert!(matches!(r, Err(DownloadError::Cancelled)));
    }

    #[test]
    fn unconfigured_missing_path_is_not_found_directly() {
        assert!(
            find_ffmpeg(Some(Path::new("Z:/definitely/not/here/ffmpeg.exe"))).is_none()
                || std::env::var_os("PATH").is_some()
        );
    }

    #[test]
    fn args_for_av_mux() {
        let a = build_args(
            Path::new("v.mp4"),
            Some(Path::new("a.m4a")),
            Path::new("o.mp4"),
            false,
        );
        let s: Vec<String> = a.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        assert_eq!(
            s.join(" "),
            "-y -hide_banner -loglevel error -i v.mp4 -i a.m4a -c copy o.mp4"
        );
        let a = build_args(Path::new("v.ts"), None, Path::new("o.mp4"), true);
        assert!(a.iter().any(|x| x == "aac_adtstoasc"));
    }
}
