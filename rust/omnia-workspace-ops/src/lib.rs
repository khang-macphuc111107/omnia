//! `omnia-workspace-ops` implements INT-06 workspace/IDE operations for Omnia:
//!
//! 1. **Path containment (`path_guard`)**: Canonical workspace-root containment
//!    that rejects `..` traversal, NUL bytes, Windows `\\?\` / `\\.\` / UNC abuse,
//!    alternate data streams, reserved device names, and symlink/junction components
//!    using `FILE_ATTRIBUTE_REPARSE_POINT` (`0x400`) non-traversal checks.
//! 2. **Safe file operations (`fs_ops`)**: Strict UTF-8 `LF`-normalized reads,
//!    numbered snippet slicing, atomic temp+rename writes with SHA-256 before/after
//!    digests, unified diff summaries, and external rollback receipts (`D:\OmniaData\...`).
//! 3. **Bounded command execution (`process_ops`)**: Workspace-contained `cwd`
//!    verification, Win32 Job Object process-tree supervision (`KILL_ON_JOB_CLOSE`),
//!    zero-busy-poll wait/timeout enforcement, and deadlock-free capped stdout/stderr capture.
//! 4. **Chunked range download planner (`range_downloader`)**: 1–128 stream
//!    inclusive byte-range planning, pure-Rust SSRF/URL guard, external staging
//!    containment, dynamic work-stealing tail splits, and SHA-256 verification.
//! 5. **Hardware tier & VRAM guard (`hardware`)**: Zero-subprocess Win32 RAM/VRAM
//!    detection (`GlobalMemoryStatusEx` + 64-bit `qwMemorySize` registry query) and
//!    AN515-55 4 GB VRAM safety guard.
//! 6. **Shell output micro-compactor (`shell_compactor`)**: `rtk`-style output
//!    scrubber, build/test/diff/install compressor, traceback-preserving cap, and
//!    external `>4 KB` spill writer.

#![deny(unsafe_code)]

pub mod fs_ops;
pub mod hardware;
pub mod path_guard;
pub mod process_ops;
pub mod range_downloader;
pub mod shell_compactor;

use std::io;
use std::path::Path;
use thiserror::Error;

pub use fs_ops::{
    read_snippet, read_text_file, rollback_write, unified_diff, write_atomic, DiffSummary,
    LineEndingPolicy, NumberedLine, ReadFileResult, RollbackOutcome, RollbackReceipt,
    SnippetResult, WriteOptions, WriteReceipt,
};
pub use hardware::{
    classify_hardware_tier, detect_hardware_profile, validate_local_aux_model_vram,
    HardwareProfile, HardwareTier, LocalAuxVramCheck, DEFAULT_DWM_UI_HEADROOM_MB,
    DEFAULT_MAX_AUX_MODEL_VRAM_MB,
};
pub use path_guard::{
    is_reparse_point, is_reparse_point_metadata, relative_posix_path, resolve_contained_path,
    resolve_workspace_root, strip_verbatim_drive_prefix,
};
pub use process_ops::{
    collect_process_tree_pids, pid_is_alive, process_tree_rss_bytes, run_bounded_command,
    spawn_supervised_command, CommandReceipt, CommandSpec, ProcessSupervisor,
};
pub use range_downloader::{
    assemble_and_verify_chunks, assemble_plan_chunks_and_verify, pick_largest_stealable_segment,
    plan_range_download, plan_range_download_with_policy, split_largest_active_segment,
    validate_download_url, validate_download_url_with_policy, ByteRangeSegment,
    RangeDownloadError, RangeDownloadPlan, RangeUrlPolicy, ValidatedDownloadUrl,
    VerifiedChunkAssembly, MAX_RANGE_STREAMS, MIN_RANGE_STREAMS,
};
pub use shell_compactor::{
    cap_output_traceback_preserving, compact_shell_output, scrub_shell_output,
    spill_oversized_output, CompactedShellOutput, ShellSpillReceipt,
    DEFAULT_SPILL_THRESHOLD_BYTES,
};

/// Unified error type for all Omnia workspace path, file, rollback, and process operations.
#[derive(Debug, Error)]
pub enum WorkspaceOpsError {
    #[error("path cannot be empty")]
    EmptyPath,

    #[error("NUL byte rejected in {context}")]
    NulByteInPath { context: &'static str },

    #[error("forbidden path prefix in `{path}`: {reason}")]
    ForbiddenPathPrefix { path: String, reason: &'static str },

    #[error("forbidden path segment in `{path}`: {reason}")]
    ForbiddenPathSegment { path: String, reason: &'static str },

    #[error("parent traversal (`..`) rejected in `{path}`")]
    PathTraversal { path: String },

    #[error("path `{candidate}` escapes workspace root `{root}`")]
    OutsideWorkspace { root: String, candidate: String },

    #[error("reparse point / symlink component rejected at `{path}`")]
    ReparsePointDetected { path: String },

    #[error("expected directory at `{path}`")]
    NotADirectory { path: String },

    #[error("expected regular file at `{path}`")]
    NotAFile { path: String },

    #[error("invalid UTF-8 content in `{path}`")]
    InvalidUtf8 { path: String },

    #[error("CR/CRLF line ending rejected under strict LF policy in `{path}`")]
    CrlfDetected { path: String },

    #[error("invalid line range start={start_line}, end={end_line}")]
    InvalidLineRange { start_line: usize, end_line: usize },

    #[error("rollback directory `{rollback_dir}` must live outside workspace root `{root}`")]
    RollbackDirInsideWorkspace { root: String, rollback_dir: String },

    #[error("rollback receipt invalid for `{path}`: {reason}")]
    InvalidRollbackReceipt { path: String, reason: String },

    #[error("rollback integrity check failed: expected sha256 `{expected}`, got `{actual}`")]
    RollbackIntegrityMismatch { expected: String, actual: String },

    #[error("invalid command specification: {reason}")]
    InvalidCommandSpec { reason: String },

    #[error("JSON serialization/deserialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("I/O failure during {operation} on `{path}`: {source}")]
    Io {
        operation: &'static str,
        path: String,
        #[source]
        source: io::Error,
    },
}

pub(crate) fn io_err(operation: &'static str, path: &Path, source: io::Error) -> WorkspaceOpsError {
    WorkspaceOpsError::Io {
        operation,
        path: path.display().to_string(),
        source,
    }
}
