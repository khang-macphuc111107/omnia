//! Win32 window capture target identity and frame receipt validator.
//!
//! Enforces HWND/PID/process-creation-time continuity (preventing Windows PID reuse),
//! rejects minimized or zero-area windows, and verifies frame size, SHA-256 digest,
//! and non-blank pixel invariants.

use crate::capability::{AdapterKind, CapabilityReason, CapabilityReport, CapabilityStatus};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Default maximum captured width or height in pixels, aligned with `native/qa-capture.ps1`.
pub const DEFAULT_MAX_CAPTURE_DIMENSION: u32 = 8192;
/// SHA-256 hex digest of an empty byte slice (`""`), always rejected for frame receipts.
pub const EMPTY_INPUT_SHA256_HEX: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MIN_PNG_BYTES: usize = 67;

/// Win32 window identity snapshot binding HWND, PID, creation time, geometry, and iconic state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowIdentity {
    /// Win32 window handle (`HWND` cast to `u64`).
    pub hwnd: u64,
    /// Owning Win32 process identifier (`PID`).
    pub pid: u32,
    /// Process creation timestamp (`FILETIME` in 100ns ticks since 1601-01-01 UTC) to catch PID reuse.
    pub process_create_time_100ns: u64,
    /// Window title text at observation time.
    pub title: String,
    /// Window width in logical/physical capture pixels.
    pub width: u32,
    /// Window height in logical/physical capture pixels.
    pub height: u32,
    /// True when `IsIconic(hwnd)` indicates the window is minimized.
    pub minimized: bool,
}

impl Serialize for WindowIdentity {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "hwnd": self.hwnd,
            "pid": self.pid,
            "process_create_time_100ns": self.process_create_time_100ns,
            "title": self.title,
            "width": self.width,
            "height": self.height,
            "minimized": self.minimized,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for WindowIdentity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("WindowIdentity must be a JSON object"))?;
        let hwnd = obj
            .get("hwnd")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u64 hwnd"))?;
        let pid_u64 = obj
            .get("pid")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u32 pid"))?;
        let pid =
            u32::try_from(pid_u64).map_err(|_| serde::de::Error::custom("pid overflows u32"))?;
        let process_create_time_100ns = obj
            .get("process_create_time_100ns")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u64 process_create_time_100ns"))?;
        let title = obj
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("missing string title"))?
            .to_string();
        let width_u64 = obj
            .get("width")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u32 width"))?;
        let height_u64 = obj
            .get("height")
            .and_then(Value::as_u64)
            .ok_or_else(|| serde::de::Error::custom("missing u32 height"))?;
        let width = u32::try_from(width_u64)
            .map_err(|_| serde::de::Error::custom("width overflows u32"))?;
        let height = u32::try_from(height_u64)
            .map_err(|_| serde::de::Error::custom("height overflows u32"))?;
        let minimized = obj
            .get("minimized")
            .and_then(Value::as_bool)
            .ok_or_else(|| serde::de::Error::custom("missing bool minimized"))?;
        Ok(Self {
            hwnd,
            pid,
            process_create_time_100ns,
            title,
            width,
            height,
            minimized,
        })
    }
}

/// Pixel or encoded container format for captured frame receipts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapturePixelFormat {
    /// Uncompressed 32-bit BGRA pixels (4 bytes per pixel).
    Bgra8,
    /// Uncompressed 32-bit RGBA pixels (4 bytes per pixel).
    Rgba8,
    /// Encoded PNG image container.
    Png,
}

impl CapturePixelFormat {
    /// Returns the canonical `snake_case` wire tag.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bgra8 => "bgra8",
            Self::Rgba8 => "rgba8",
            Self::Png => "png",
        }
    }
}

impl Serialize for CapturePixelFormat {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CapturePixelFormat {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        match raw.as_str() {
            "bgra8" => Ok(Self::Bgra8),
            "rgba8" => Ok(Self::Rgba8),
            "png" => Ok(Self::Png),
            other => Err(serde::de::Error::custom(format!(
                "unknown pixel format: {other}"
            ))),
        }
    }
}

/// Captured frame receipt submitted for pre- and post-capture verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureFrameReceipt {
    /// Target window identity selected before invoking capture.
    pub expected_target: WindowIdentity,
    /// Window identity observed right after capture completed.
    pub observed_target: WindowIdentity,
    /// Captured image width in pixels.
    pub frame_width: u32,
    /// Captured image height in pixels.
    pub frame_height: u32,
    /// Pixel or container format.
    pub pixel_format: CapturePixelFormat,
    /// Byte length of the captured frame payload.
    pub byte_len: usize,
    /// Lowercase or uppercase 64-character hex SHA-256 digest of the captured payload.
    pub sha256_hex: String,
    /// Optional raw frame bytes for inline hash + non-blank pixel inspection.
    pub frame_bytes: Option<Vec<u8>>,
    /// External pixel-inspection flag required when `frame_bytes` is `None` or container-encoded.
    pub non_blank_verified: bool,
}

/// Verified capture receipt summary produced only after all identity and integrity checks pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedCaptureReceipt {
    /// Verified target window identity.
    pub target: WindowIdentity,
    /// Verified frame width.
    pub frame_width: u32,
    /// Verified frame height.
    pub frame_height: u32,
    /// Verified pixel/container format.
    pub pixel_format: CapturePixelFormat,
    /// Verified payload byte size.
    pub byte_len: usize,
    /// Normalized lowercase 64-char SHA-256 digest.
    pub sha256_hex: String,
    /// Always `true` on validated receipts.
    pub non_blank_verified: bool,
}

impl Serialize for ValidatedCaptureReceipt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "target": self.target,
            "frame_width": self.frame_width,
            "frame_height": self.frame_height,
            "pixel_format": self.pixel_format,
            "byte_len": self.byte_len,
            "sha256_hex": self.sha256_hex,
            "non_blank_verified": self.non_blank_verified,
        })
        .serialize(serializer)
    }
}

/// Window capture validation error mapped directly to truthful [`CapabilityStatus`] states.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum WindowCaptureError {
    /// Window handle (`hwnd`) is zero.
    #[error("capture target HWND is zero")]
    InvalidHwnd,
    /// Process identifier (`pid`) is zero.
    #[error("capture target PID is zero")]
    InvalidPid,
    /// Process creation timestamp (`process_create_time_100ns`) is zero.
    #[error("capture target process_create_time_100ns is zero")]
    MissingProcessCreateTime,
    /// Window is minimized (`IsIconic`).
    #[error("capture blocked: target window is minimized")]
    WindowMinimized,
    /// Window has zero width or zero height.
    #[error("capture target has zero area ({width}x{height})")]
    ZeroAreaWindow {
        /// Observed width.
        width: u32,
        /// Observed height.
        height: u32,
    },
    /// Window or frame dimensions exceed configured capture maximum.
    #[error("capture blocked: dimensions {width}x{height} exceed limit {max_dimension}")]
    DimensionExceedsLimit {
        /// Observed width.
        width: u32,
        /// Observed height.
        height: u32,
        /// Maximum allowed dimension.
        max_dimension: u32,
    },
    /// Target HWND drifted between expected and observed snapshots.
    #[error("stale target: HWND changed from {expected} to {observed}")]
    HwndMismatch {
        /// Expected HWND.
        expected: u64,
        /// Observed HWND.
        observed: u64,
    },
    /// Target PID changed between expected and observed snapshots.
    #[error("stale target: PID changed from {expected} to {observed}")]
    PidMismatch {
        /// Expected PID.
        expected: u32,
        /// Observed PID.
        observed: u32,
    },
    /// Same PID now maps to a different `process_create_time_100ns` (PID reuse).
    #[error("stale target: process_create_time_100ns changed ({expected} -> {observed}), indicating PID reuse")]
    PidReuseDetected {
        /// Expected process creation time.
        expected: u64,
        /// Observed process creation time.
        observed: u64,
    },
    /// Window dimensions changed mid-capture or frame dimensions disagree with window dimensions.
    #[error("stale target: geometry mismatch ({detail})")]
    GeometryMismatch {
        /// Dimension mismatch explanation.
        detail: String,
    },
    /// Frame byte length is zero or digest corresponds to empty input.
    #[error("empty frame receipt rejected")]
    EmptyFrameReceipt,
    /// Frame byte length disagrees with buffer length or pixel-format size invariants.
    #[error("frame size mismatch: {0}")]
    FrameSizeMismatch(String),
    /// Frame SHA-256 hex format is invalid.
    #[error("invalid frame SHA-256 hex digest")]
    InvalidFrameHash,
    /// Computed SHA-256 digest of frame bytes does not match receipt `sha256_hex`.
    #[error("frame SHA-256 digest mismatch (expected {expected}, got {actual})")]
    FrameHashMismatch {
        /// Declared SHA-256 hex.
        expected: String,
        /// Actual SHA-256 hex.
        actual: String,
    },
    /// Frame is completely blank, all-transparent, uniform monochrome, or lacks non-blank verification.
    #[error("blank or unverified frame rejected: {0}")]
    BlankFrameDetected(String),
}

impl WindowCaptureError {
    /// Maps this error to `(CapabilityStatus, CapabilityReason)`.
    pub const fn classification(&self) -> (CapabilityStatus, CapabilityReason) {
        match self {
            Self::InvalidHwnd => (CapabilityStatus::StaleTarget, CapabilityReason::InvalidHwnd),
            Self::InvalidPid => (CapabilityStatus::StaleTarget, CapabilityReason::InvalidPid),
            Self::MissingProcessCreateTime => (
                CapabilityStatus::StaleTarget,
                CapabilityReason::MissingProcessCreateTime,
            ),
            Self::WindowMinimized => (CapabilityStatus::Blocked, CapabilityReason::WindowMinimized),
            Self::ZeroAreaWindow { .. } => (
                CapabilityStatus::StaleTarget,
                CapabilityReason::ZeroAreaWindow,
            ),
            Self::DimensionExceedsLimit { .. } => (
                CapabilityStatus::Blocked,
                CapabilityReason::DimensionExceedsLimit,
            ),
            Self::HwndMismatch { .. } => (
                CapabilityStatus::StaleTarget,
                CapabilityReason::HwndMismatch,
            ),
            Self::PidMismatch { .. } => {
                (CapabilityStatus::StaleTarget, CapabilityReason::PidMismatch)
            }
            Self::PidReuseDetected { .. } => (
                CapabilityStatus::StaleTarget,
                CapabilityReason::PidReuseDetected,
            ),
            Self::GeometryMismatch { .. } => (
                CapabilityStatus::StaleTarget,
                CapabilityReason::GeometryMismatch,
            ),
            Self::EmptyFrameReceipt => {
                (CapabilityStatus::Error, CapabilityReason::EmptyFrameReceipt)
            }
            Self::FrameSizeMismatch(_) => {
                (CapabilityStatus::Error, CapabilityReason::FrameSizeMismatch)
            }
            Self::InvalidFrameHash => (CapabilityStatus::Error, CapabilityReason::InvalidFrameHash),
            Self::FrameHashMismatch { .. } => {
                (CapabilityStatus::Error, CapabilityReason::FrameHashMismatch)
            }
            Self::BlankFrameDetected(_) => (
                CapabilityStatus::Error,
                CapabilityReason::BlankFrameDetected,
            ),
        }
    }

    /// Converts this error into a truthful [`CapabilityReport`].
    pub fn to_capability_report(&self) -> CapabilityReport {
        let (status, reason) = self.classification();
        CapabilityReport::failure(
            AdapterKind::WindowCapture,
            status,
            reason,
            self.to_string(),
            None,
        )
    }
}

/// Computes lowercase hex SHA-256 digest of a byte slice.
pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Validates standalone [`WindowIdentity`] liveness, iconic state, and area bounds.
pub fn validate_window_target(
    target: &WindowIdentity,
    max_dimension: u32,
) -> Result<(), WindowCaptureError> {
    if target.hwnd == 0 {
        return Err(WindowCaptureError::InvalidHwnd);
    }
    if target.pid == 0 {
        return Err(WindowCaptureError::InvalidPid);
    }
    if target.process_create_time_100ns == 0 {
        return Err(WindowCaptureError::MissingProcessCreateTime);
    }
    if target.minimized {
        return Err(WindowCaptureError::WindowMinimized);
    }
    if target.width == 0 || target.height == 0 {
        return Err(WindowCaptureError::ZeroAreaWindow {
            width: target.width,
            height: target.height,
        });
    }
    if target.width > max_dimension || target.height > max_dimension {
        return Err(WindowCaptureError::DimensionExceedsLimit {
            width: target.width,
            height: target.height,
            max_dimension,
        });
    }
    Ok(())
}

/// Validates a [`CaptureFrameReceipt`] using [`DEFAULT_MAX_CAPTURE_DIMENSION`].
pub fn validate_capture_receipt(
    receipt: &CaptureFrameReceipt,
) -> Result<ValidatedCaptureReceipt, WindowCaptureError> {
    validate_capture_receipt_with_max_dim(receipt, DEFAULT_MAX_CAPTURE_DIMENSION)
}

/// Validates target identity continuity, PID-reuse protection, frame hash/size, and non-blank invariants.
pub fn validate_capture_receipt_with_max_dim(
    receipt: &CaptureFrameReceipt,
    max_dimension: u32,
) -> Result<ValidatedCaptureReceipt, WindowCaptureError> {
    validate_window_target(&receipt.expected_target, max_dimension)?;
    validate_window_target(&receipt.observed_target, max_dimension)?;

    if receipt.observed_target.hwnd != receipt.expected_target.hwnd {
        return Err(WindowCaptureError::HwndMismatch {
            expected: receipt.expected_target.hwnd,
            observed: receipt.observed_target.hwnd,
        });
    }
    if receipt.observed_target.pid != receipt.expected_target.pid {
        return Err(WindowCaptureError::PidMismatch {
            expected: receipt.expected_target.pid,
            observed: receipt.observed_target.pid,
        });
    }
    if receipt.observed_target.process_create_time_100ns
        != receipt.expected_target.process_create_time_100ns
    {
        return Err(WindowCaptureError::PidReuseDetected {
            expected: receipt.expected_target.process_create_time_100ns,
            observed: receipt.observed_target.process_create_time_100ns,
        });
    }
    if receipt.observed_target.width != receipt.expected_target.width
        || receipt.observed_target.height != receipt.expected_target.height
    {
        return Err(WindowCaptureError::GeometryMismatch {
            detail: format!(
                "expected {}x{}, observed {}x{}",
                receipt.expected_target.width,
                receipt.expected_target.height,
                receipt.observed_target.width,
                receipt.observed_target.height
            ),
        });
    }
    if receipt.frame_width == 0
        || receipt.frame_height == 0
        || receipt.frame_width != receipt.observed_target.width
        || receipt.frame_height != receipt.observed_target.height
    {
        return Err(WindowCaptureError::GeometryMismatch {
            detail: format!(
                "window is {}x{} but frame is {}x{}",
                receipt.observed_target.width,
                receipt.observed_target.height,
                receipt.frame_width,
                receipt.frame_height
            ),
        });
    }
    if receipt.byte_len == 0 {
        return Err(WindowCaptureError::EmptyFrameReceipt);
    }

    let normalized_hash = normalize_sha256_hex(&receipt.sha256_hex)?;
    if normalized_hash == EMPTY_INPUT_SHA256_HEX {
        return Err(WindowCaptureError::EmptyFrameReceipt);
    }

    validate_payload_size_and_content(receipt, &normalized_hash)?;

    Ok(ValidatedCaptureReceipt {
        target: receipt.observed_target.clone(),
        frame_width: receipt.frame_width,
        frame_height: receipt.frame_height,
        pixel_format: receipt.pixel_format,
        byte_len: receipt.byte_len,
        sha256_hex: normalized_hash,
        non_blank_verified: true,
    })
}

/// Evaluates a capture receipt directly into a truthful [`CapabilityReport`].
pub fn evaluate_capture_receipt(receipt: &CaptureFrameReceipt) -> CapabilityReport {
    match validate_capture_receipt(receipt) {
        Ok(valid) => CapabilityReport::available(
            AdapterKind::WindowCapture,
            format!(
                "window capture verified (hwnd=0x{:x}, pid={}, {}x{}, {} bytes, sha256={})",
                valid.target.hwnd,
                valid.target.pid,
                valid.frame_width,
                valid.frame_height,
                valid.byte_len,
                &valid.sha256_hex[..12]
            ),
            None,
            None,
        ),
        Err(err) => err.to_capability_report(),
    }
}

/// Evaluates optional window target configuration without fabricating capture availability.
///
/// Even when a target passes geometry/liveness checks, capability remains `Unavailable`
/// (`CAPTURE_RECEIPT_REQUIRED`) until a live frame receipt is validated.
pub fn probe_window_target_status(target: Option<&WindowIdentity>) -> CapabilityReport {
    let Some(identity) = target else {
        return CapabilityReport::unconfigured(AdapterKind::WindowCapture, "capture_target");
    };
    match validate_window_target(identity, DEFAULT_MAX_CAPTURE_DIMENSION) {
        Ok(()) => CapabilityReport::failure(
            AdapterKind::WindowCapture,
            CapabilityStatus::Unavailable,
            CapabilityReason::CaptureReceiptRequired,
            format!(
                "target hwnd=0x{:x} pid={} is structurally valid, but no verified capture receipt has been collected",
                identity.hwnd, identity.pid
            ),
            None,
        ),
        Err(err) => err.to_capability_report(),
    }
}

fn normalize_sha256_hex(raw: &str) -> Result<String, WindowCaptureError> {
    let trimmed = raw.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(WindowCaptureError::InvalidFrameHash);
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn validate_payload_size_and_content(
    receipt: &CaptureFrameReceipt,
    normalized_hash: &str,
) -> Result<(), WindowCaptureError> {
    let expected_raw_bytes = match receipt.pixel_format {
        CapturePixelFormat::Bgra8 | CapturePixelFormat::Rgba8 => {
            let pixels = (receipt.frame_width as usize)
                .checked_mul(receipt.frame_height as usize)
                .and_then(|px| px.checked_mul(4))
                .ok_or_else(|| {
                    WindowCaptureError::FrameSizeMismatch("pixel buffer size overflow".to_string())
                })?;
            if receipt.byte_len != pixels {
                return Err(WindowCaptureError::FrameSizeMismatch(format!(
                    "expected {pixels} bytes for {}x{} 32bpp frame, got {}",
                    receipt.frame_width, receipt.frame_height, receipt.byte_len
                )));
            }
            Some(pixels)
        }
        CapturePixelFormat::Png => {
            if receipt.byte_len < MIN_PNG_BYTES {
                return Err(WindowCaptureError::FrameSizeMismatch(format!(
                    "PNG payload too small ({} bytes < {MIN_PNG_BYTES})",
                    receipt.byte_len
                )));
            }
            None
        }
    };

    match &receipt.frame_bytes {
        Some(bytes) => {
            if bytes.len() != receipt.byte_len {
                return Err(WindowCaptureError::FrameSizeMismatch(format!(
                    "declared byte_len={} does not match frame_bytes.len()={}",
                    receipt.byte_len,
                    bytes.len()
                )));
            }
            let actual_hash = compute_sha256_hex(bytes);
            if actual_hash != normalized_hash {
                return Err(WindowCaptureError::FrameHashMismatch {
                    expected: normalized_hash.to_string(),
                    actual: actual_hash,
                });
            }
            match receipt.pixel_format {
                CapturePixelFormat::Bgra8 | CapturePixelFormat::Rgba8 => {
                    let _ = expected_raw_bytes;
                    verify_raw_pixels_non_blank(bytes)?;
                }
                CapturePixelFormat::Png => {
                    verify_png_header_and_flags(
                        bytes,
                        receipt.frame_width,
                        receipt.frame_height,
                        receipt.non_blank_verified,
                    )?;
                }
            }
        }
        None => {
            if !receipt.non_blank_verified {
                return Err(WindowCaptureError::BlankFrameDetected(
                    "receipt omitted inline frame_bytes and non_blank_verified is false"
                        .to_string(),
                ));
            }
        }
    }
    Ok(())
}

fn verify_raw_pixels_non_blank(bytes: &[u8]) -> Result<(), WindowCaptureError> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err(WindowCaptureError::FrameSizeMismatch(
            "raw 32bpp pixel buffer is empty or not 4-byte aligned".to_string(),
        ));
    }
    if bytes.iter().all(|b| *b == 0) {
        return Err(WindowCaptureError::BlankFrameDetected(
            "all pixel bytes are zero".to_string(),
        ));
    }
    let (pixels, remainder) = bytes.as_chunks::<4>();
    debug_assert!(remainder.is_empty());
    let Some((first, rest)) = pixels.split_first() else {
        return Err(WindowCaptureError::BlankFrameDetected(
            "no pixels present".to_string(),
        ));
    };
    let mut any_non_zero_alpha = first[3] != 0;
    let mut any_distinct_pixel = false;
    for px in rest {
        if px[3] != 0 {
            any_non_zero_alpha = true;
        }
        if px != first {
            any_distinct_pixel = true;
        }
        if any_non_zero_alpha && any_distinct_pixel {
            return Ok(());
        }
    }
    if !any_non_zero_alpha {
        return Err(WindowCaptureError::BlankFrameDetected(
            "all pixels are fully transparent (alpha=0)".to_string(),
        ));
    }
    Err(WindowCaptureError::BlankFrameDetected(
        "frame is completely uniform monochrome across all pixels".to_string(),
    ))
}

fn verify_png_header_and_flags(
    bytes: &[u8],
    expected_w: u32,
    expected_h: u32,
    non_blank_verified: bool,
) -> Result<(), WindowCaptureError> {
    if bytes.len() < MIN_PNG_BYTES || &bytes[..8] != PNG_SIGNATURE {
        return Err(WindowCaptureError::FrameSizeMismatch(
            "invalid PNG signature".to_string(),
        ));
    }
    // PNG IHDR chunk starts at byte 8: [4B len=13][4B "IHDR"][4B width BE][4B height BE]
    if &bytes[12..16] != b"IHDR" {
        return Err(WindowCaptureError::FrameSizeMismatch(
            "PNG missing leading IHDR chunk".to_string(),
        ));
    }
    let png_w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let png_h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if png_w != expected_w || png_h != expected_h {
        return Err(WindowCaptureError::GeometryMismatch {
            detail: format!("PNG IHDR is {png_w}x{png_h}, expected {expected_w}x{expected_h}"),
        });
    }
    let has_idat = bytes.windows(4).any(|w| w == b"IDAT");
    let has_iend = bytes.windows(4).any(|w| w == b"IEND");
    if !has_idat || !has_iend {
        return Err(WindowCaptureError::FrameSizeMismatch(
            "PNG missing IDAT or IEND chunk".to_string(),
        ));
    }
    if !non_blank_verified {
        return Err(WindowCaptureError::BlankFrameDetected(
            "encoded PNG frame requires explicit non_blank_verified pixel check".to_string(),
        ));
    }
    Ok(())
}
