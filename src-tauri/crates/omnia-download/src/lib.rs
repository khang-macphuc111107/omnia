//! Omnia download engine (no Tauri dependency).
//!
//! * [`http`] - segmented, resumable HTTP downloads with dynamic range splitting
//! * [`hls`] / [`hls_download`] - HLS parsing and download (AES-128, live polling)
//! * [`dash`] / [`dash_download`] - MPEG-DASH parsing and download
//! * [`mux`] - ffmpeg stream-copy muxing
//! * [`detect`] - classify captured traffic for the "media found" list
//! * [`blob`] - blob download helpers for the browser layer
//! * [`engine`] - the job manager the app talks to
//!
//! DRM-protected content (HLS SAMPLE-AES / non-identity KEYFORMAT, DASH
//! `ContentProtection`) is detected and refused with [`DownloadError::DrmProtected`];
//! nothing here tries to circumvent DRM.

pub mod blob;
pub mod dash;
pub mod dash_download;
pub mod detect;
pub mod engine;
pub mod error;
pub mod fetch;
pub mod fsutil;
pub mod hls;
pub mod hls_download;
pub mod http;
pub mod mux;
pub mod probe;
pub mod progress;
pub mod ratelimit;
pub mod request;
pub mod types;

pub use blob::{BlobAssembler, BLOB_READER_JS};
pub use detect::{classify, Detected, DetectedKind};
pub use engine::{
    DownloadEngine, EngineConfig, JobEvent, JobId, JobKind, JobSnapshot, JobSpec, JobStatus,
};
pub use error::{DownloadError, Result};
pub use hls::select_variant;
pub use mux::{find_ffmpeg, find_ffmpeg_ordered, mux_cancellable, MuxOutcome};
pub use request::RequestSpec;
pub use types::{Progress, Quality};
