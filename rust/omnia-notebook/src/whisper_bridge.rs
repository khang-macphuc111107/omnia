//! Offline Whisper / FFmpeg audio-to-Markdown transcription bridge (`#![forbid(unsafe_code)]`)
//! mirroring `scripts/local-transcribe.py` with strict external staging & UNC path blocking.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use omnia_core::SecretRedactor;
use omnia_workspace_ops::path_guard::{is_reparse_point_metadata, resolve_workspace_root};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time;

use crate::error::NotebookError;
use crate::ingestion::{IngestSourceOutcome, IngestSourceRequest};
use crate::NotebookEngine;

#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DEFAULT_WHISPER_TIMEOUT_SECS: u64 = 300;
const MAX_TRANSCRIPT_STDOUT_BYTES: usize = 2 * 1024 * 1024;

/// Request to transcribe a local audio/video file via offline Whisper/FFmpeg and ingest `.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperTranscribeRequest {
    pub notebook_id: String,
    pub media_path: PathBuf,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub remote_id: Option<String>,
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default = "default_model_size")]
    pub model_size: String,
    #[serde(default)]
    pub workspace_root: Option<PathBuf>,
    #[serde(default)]
    pub output_dir: Option<PathBuf>,
}

fn default_lang() -> String {
    "vi".to_string()
}

fn default_model_size() -> String {
    "tiny".to_string()
}

/// Receipt returned after offline Whisper transcription and notebook ingestion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperTranscribeOutcome {
    pub transcript_markdown: String,
    pub provenance: Value,
    pub ingest: IngestSourceOutcome,
}

/// Validates a local media path against UNC/SMB prefixes, device namespaces, and reparse points.
pub fn validate_local_media_path(raw: &Path) -> Result<PathBuf, NotebookError> {
    let text = raw.to_string_lossy();
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with(r"\\")
        || trimmed.starts_with("//")
        || trimmed.starts_with(r"\??\")
        || trimmed.starts_with("/??/")
        || trimmed.contains('\0')
    {
        return Err(NotebookError::SecurityRejected {
            code: "UNSAFE_MEDIA_PATH",
            reason: "UNC/SMB/device media paths are blocked".into(),
        });
    }
    let meta = std::fs::symlink_metadata(raw)
        .map_err(|e| NotebookError::Io(format!("failed inspecting '{}': {e}", raw.display())))?;
    if meta.file_type().is_symlink() || is_reparse_point_metadata(&meta) {
        return Err(NotebookError::SecurityRejected {
            code: "REPARSE_MEDIA_PATH_BLOCKED",
            reason: "symlink/reparse media paths are blocked".into(),
        });
    }
    if !meta.is_file() {
        return Err(NotebookError::InvalidInput(format!(
            "media path '{}' is not a regular file",
            raw.display()
        )));
    }
    std::fs::canonicalize(raw)
        .map_err(|e| NotebookError::Io(format!("failed canonicalizing '{}': {e}", raw.display())))
}

/// Discovers a Whisper runner (`OMNIA_WHISPER_BIN` / `whisper` CLI) or Python (`OMNIA_PYTHON_BIN` / `python`).
#[must_use]
pub fn discover_whisper_runner() -> Option<WhisperRunner> {
    if let Ok(bin) = env::var("OMNIA_WHISPER_BIN") {
        let p = PathBuf::from(bin.trim());
        if p.is_file() {
            return Some(WhisperRunner::WhisperCli(p));
        }
    }
    if let Ok(py) = env::var("OMNIA_PYTHON_BIN") {
        let p = PathBuf::from(py.trim());
        if p.is_file() {
            return Some(WhisperRunner::PythonFasterWhisper(p));
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let w_exe = if cfg!(windows) { "whisper.exe" } else { "whisper" };
            if dir.join(w_exe).is_file() {
                return Some(WhisperRunner::WhisperCli(dir.join(w_exe)));
            }
        }
        for dir in env::split_paths(&paths) {
            let py_exe = if cfg!(windows) { "python.exe" } else { "python3" };
            if dir.join(py_exe).is_file() {
                return Some(WhisperRunner::PythonFasterWhisper(dir.join(py_exe)));
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhisperRunner {
    WhisperCli(PathBuf),
    PythonFasterWhisper(PathBuf),
}

/// Builds clean Whisper script / CLI invocation arguments and checks model/language bounds.
pub fn validate_whisper_params(req: &WhisperTranscribeRequest) -> Result<(String, String), NotebookError> {
    let lang = req.language.trim();
    if lang.is_empty()
        || lang.len() > 16
        || !lang
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(NotebookError::InvalidInput(
            "invalid Whisper language tag".into(),
        ));
    }
    let model = req.model_size.trim();
    if model.is_empty()
        || model.len() > 32
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(NotebookError::InvalidInput(
            "invalid Whisper model size identifier".into(),
        ));
    }
    if let (Some(ws), Some(out_dir)) = (&req.workspace_root, &req.output_dir) {
        if let Ok(canon_ws) = resolve_workspace_root(ws) {
            if let Ok(canon_out) = std::fs::canonicalize(out_dir) {
                if canon_out.starts_with(&canon_ws) {
                    return Err(NotebookError::SecurityRejected {
                        code: "OUTPUT_INSIDE_WORKSPACE",
                        reason: "Whisper transcript artifacts must be staged outside workspace_root"
                            .into(),
                    });
                }
            }
        }
    }
    Ok((lang.to_string(), model.to_string()))
}

/// Executes local offline Whisper (`faster_whisper` via Python `-B` or `whisper` CLI)
/// and ingests the resulting Markdown transcript + provenance receipt into `engine`.
pub async fn transcribe_and_ingest(
    engine: &NotebookEngine,
    req: WhisperTranscribeRequest,
) -> Result<WhisperTranscribeOutcome, NotebookError> {
    let _ = engine.library().require_notebook(&req.notebook_id)?;
    let media = validate_local_media_path(&req.media_path)?;
    let (lang, model) = validate_whisper_params(&req)?;
    let runner = discover_whisper_runner().ok_or_else(|| {
        NotebookError::WhisperUnavailable(
            "No offline Whisper CLI or Python faster_whisper runner found on host PATH".into(),
        )
    })?;

    let transcript_lines = run_whisper_subprocess(&runner, &media, &lang, &model).await?;
    let body_text = if transcript_lines.is_empty() {
        "No speech segments detected by offline ASR.".to_string()
    } else {
        transcript_lines.join("\n")
    };

    let filename_display = media
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let orig_ext = media
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_ascii_lowercase()))
        .unwrap_or_else(|| "[none]".to_string());

    let method = match &runner {
        WhisperRunner::WhisperCli(_) => format!("whisper-cli:{model}"),
        WhisperRunner::PythonFasterWhisper(_) => format!("faster-whisper:{model}"),
    };
    let md = format!(
        "# Local transcript - {filename_display}\n\n\
         - Original extension: `{orig_ext}`\n\
         - Converted extension: `.md`\n\
         - Conversion method: `{method}`\n\
         - Language: `{lang}`\n\
         - Segment count: {}\n\n\
         ## Transcript\n\n{body_text}\n",
        transcript_lines.len()
    );
    let provenance = json!({
        "originalFilename": filename_display,
        "originalExtension": orig_ext,
        "convertedExtension": ".md",
        "method": method,
        "language": lang,
        "segmentCount": transcript_lines.len(),
        "limitations": "Offline ASR can omit speech or misrecognize technical terms"
    });

    if let Some(out_dir) = &req.output_dir {
        std::fs::create_dir_all(out_dir)
            .map_err(|e| NotebookError::Io(format!("create output_dir failed: {e}")))?;
        let stem = media
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("transcript");
        let md_path = out_dir.join(format!("{stem}.md"));
        let prov_path = out_dir.join(format!("{stem}.md.provenance.json"));
        std::fs::write(&md_path, md.as_bytes())
            .map_err(|e| NotebookError::Io(format!("write transcript failed: {e}")))?;
        std::fs::write(&prov_path, serde_json::to_string_pretty(&provenance)?)
            .map_err(|e| NotebookError::Io(format!("write provenance failed: {e}")))?;
    }

    let stem_file = format!(
        "{}_transcript.md",
        media
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("media")
    );
    let ingest = engine.ingest_source(IngestSourceRequest {
        notebook_id: req.notebook_id,
        title: Some(
            req.title
                .unwrap_or_else(|| format!("Transcript: {filename_display}")),
        ),
        filename: stem_file,
        mime_type: Some("text/markdown".to_string()),
        remote_id: req.remote_id,
        bytes: md.as_bytes().to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({ "whisper_provenance": provenance }),
    })?;

    Ok(WhisperTranscribeOutcome {
        transcript_markdown: md,
        provenance,
        ingest,
    })
}

async fn run_whisper_subprocess(
    runner: &WhisperRunner,
    media: &Path,
    lang: &str,
    model: &str,
) -> Result<Vec<String>, NotebookError> {
    let mut cmd = match runner {
        WhisperRunner::WhisperCli(bin) => {
            let mut c = Command::new(bin);
            c.args([
                media.to_string_lossy().as_ref(),
                "--model",
                model,
                "--language",
                lang,
                "--output_format",
                "txt",
            ]);
            c
        }
        WhisperRunner::PythonFasterWhisper(py) => {
            let script = r#"
import sys
from faster_whisper import WhisperModel
m = WhisperModel(sys.argv[2], device='cpu', compute_type='int8')
segs, _ = m.transcribe(sys.argv[1], language=sys.argv[3], beam_size=1, vad_filter=True)
for s in segs:
    t = (s.text or '').strip()
    if t:
        print(f'[{s.start:0.1f}s - {s.end:0.1f}s] {t}')
"#;
            let mut c = Command::new(py);
            c.args(["-B", "-c", script, media.to_string_lossy().as_ref(), model, lang]);
            c
        }
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(WINDOWS_CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        NotebookError::WhisperUnavailable(format!("failed starting whisper runner: {e}"))
    })?;
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let res = time::timeout(Duration::from_secs(DEFAULT_WHISPER_TIMEOUT_SECS), async move {
        let mut out = Vec::new();
        let mut err = Vec::new();
        if let Some(ref mut so) = stdout_pipe {
            let _ = so.take(MAX_TRANSCRIPT_STDOUT_BYTES as u64).read_to_end(&mut out).await;
        }
        if let Some(ref mut se) = stderr_pipe {
            let _ = se.take(32 * 1024).read_to_end(&mut err).await;
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, out, err))
    })
    .await;

    match res {
        Ok(Ok((status, out, err))) => {
            if !status.success() {
                let err_txt = SecretRedactor::redact(&String::from_utf8_lossy(&err));
                return Err(NotebookError::WhisperUnavailable(format!(
                    "whisper process exited {}: {}",
                    status,
                    err_txt.trim()
                )));
            }
            Ok(String::from_utf8_lossy(&out)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(ToString::to_string)
                .collect())
        }
        Ok(Err(e)) => Err(NotebookError::Io(e.to_string())),
        Err(_) => Err(NotebookError::WhisperUnavailable(
            "whisper transcription timed out".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_media_paths_and_invalid_langs_are_blocked() {
        assert!(matches!(
            validate_local_media_path(Path::new(r"\\evil\share\audio.mp3")),
            Err(NotebookError::SecurityRejected {
                code: "UNSAFE_MEDIA_PATH",
                ..
            })
        ));
        let bad_req = WhisperTranscribeRequest {
            notebook_id: "nb_1".to_string(),
            media_path: PathBuf::from(r"D:\OmniaData\tmp\a.mp3"),
            title: None,
            remote_id: None,
            language: "vi;rm -rf /".to_string(),
            model_size: "tiny".to_string(),
            workspace_root: None,
            output_dir: None,
        };
        assert!(matches!(
            validate_whisper_params(&bad_req),
            Err(NotebookError::InvalidInput(_))
        ));
    }
}
