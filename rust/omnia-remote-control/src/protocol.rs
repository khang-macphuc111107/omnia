//! Wire frame codec, validation, directional capability enforcement, and authenticated session engine.

use std::collections::VecDeque;
use std::str::FromStr;

use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, SerializeMap, SerializeStruct, Serializer};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::crypto::{
    decode_base64, decode_hex_32, hmac_sha256_hex, push_len_prefixed, verify_hmac_sha256_hex,
    SessionKey,
};
use crate::pairing::{
    reject_unknown_keys, take_bool, take_string, take_u64, validate_identifier, CapabilityScope,
    FrameDirection, PairingError, SessionLease,
};
use crate::replay::{ReplayError, ReplayWindow, SequenceGenerator};

/// Maximum serialized wire frame envelope size in bytes (64 KiB).
pub const MAX_FRAME_WIRE_BYTES: usize = 64 * 1024;
/// Maximum allowed screen width in pixels (16K UHD).
pub const MAX_SCREEN_WIDTH: u32 = 16_384;
/// Maximum allowed screen height in pixels (16K UHD).
pub const MAX_SCREEN_HEIGHT: u32 = 16_384;
/// Maximum declared encoded screen frame payload size in bytes (32 MiB).
pub const MAX_SCREEN_FRAME_BYTES: u32 = 32 * 1024 * 1024;
/// Maximum inline Base64-decoded preview chunk carried directly inside a header (16 KiB).
pub const MAX_INLINE_PREVIEW_BYTES: usize = 16 * 1024;
/// Maximum Base64 string length accepted for `preview_base64` before decoding.
pub const MAX_PREVIEW_BASE64_LEN: usize = 24 * 1024;
/// Maximum display index accepted on multi-monitor input frames.
pub const MAX_DISPLAY_ID: u32 = 64;
/// Maximum concurrent touch points in a single `TouchEvent`.
pub const MAX_TOUCH_POINTS: usize = 16;
/// Maximum length of a keyboard `key_code` token.
pub const MAX_KEY_CODE_LEN: usize = 64;
/// Maximum length of a `DisconnectNotice` reason string.
pub const MAX_DISCONNECT_REASON_LEN: usize = 256;
/// Maximum retained entries in the in-memory session audit ring.
pub const MAX_AUDIT_RECORDS: usize = 1024;

/// Errors returned while validating, signing, or opening wire frames.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// Pairing or capability lease rejected the frame.
    #[error("pairing/lease error: {0}")]
    Pairing(#[from] PairingError),
    /// Anti-replay or sequence counter rejected the frame.
    #[error("replay/sequence error: {0}")]
    Replay(#[from] ReplayError),
    /// Frame envelope failed constant-time MAC verification.
    #[error("tampered or invalid frame MAC")]
    TamperedMac,
    /// Frame `session_id` did not match the active lease.
    #[error("frame session_id '{actual}' did not match active session '{expected}'")]
    SessionMismatch { expected: String, actual: String },
    /// Frame `sender_id` did not match the paired remote peer.
    #[error("unauthorized sender '{actual}'; expected paired peer '{expected}'")]
    UnauthorizedSender { expected: String, actual: String },
    /// Frame payload violated coordinate, dimension, or size invariants.
    #[error("invalid frame payload: {0}")]
    InvalidPayload(String),
    /// Serialized frame exceeded [`MAX_FRAME_WIRE_BYTES`] or was malformed JSON.
    #[error("wire codec error: {0}")]
    Codec(String),
    /// Timestamp was `0` (uninitialized).
    #[error("frame timestamp_ms must be greater than 0")]
    InvalidTimestamp,
    /// Attempted to send or receive after a `DisconnectNotice` already closed the stream direction.
    #[error("session already disconnected ({direction})")]
    SessionDisconnected { direction: FrameDirection },
}

/// Mouse button identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl MouseButton {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
            Self::X1 => "x1",
            Self::X2 => "x2",
        }
    }
}

impl FromStr for MouseButton {
    type Err = ProtocolError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            "middle" => Ok(Self::Middle),
            "x1" => Ok(Self::X1),
            "x2" => Ok(Self::X2),
            _ => Err(ProtocolError::InvalidPayload(format!(
                "unknown mouse button '{s}'"
            ))),
        }
    }
}

impl Serialize for MouseButton {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for MouseButton {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(de::Error::custom)
    }
}

/// Mouse button transition type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonAction {
    Down,
    Up,
    Click,
    DoubleClick,
}

impl ButtonAction {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Up => "up",
            Self::Click => "click",
            Self::DoubleClick => "double_click",
        }
    }
}

impl FromStr for ButtonAction {
    type Err = ProtocolError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "down" => Ok(Self::Down),
            "up" => Ok(Self::Up),
            "click" => Ok(Self::Click),
            "double_click" => Ok(Self::DoubleClick),
            _ => Err(ProtocolError::InvalidPayload(format!(
                "unknown button action '{s}'"
            ))),
        }
    }
}

impl Serialize for ButtonAction {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ButtonAction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(de::Error::custom)
    }
}

/// Keyboard transition type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Down,
    Up,
    Press,
}

impl KeyAction {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Up => "up",
            Self::Press => "press",
        }
    }
}

impl FromStr for KeyAction {
    type Err = ProtocolError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "down" => Ok(Self::Down),
            "up" => Ok(Self::Up),
            "press" => Ok(Self::Press),
            _ => Err(ProtocolError::InvalidPayload(format!(
                "unknown key action '{s}'"
            ))),
        }
    }
}

impl Serialize for KeyAction {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for KeyAction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(de::Error::custom)
    }
}

/// Touch lifecycle phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchAction {
    Start,
    Move,
    End,
    Cancel,
}

impl TouchAction {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Move => "move",
            Self::End => "end",
            Self::Cancel => "cancel",
        }
    }
}

impl FromStr for TouchAction {
    type Err = ProtocolError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "start" => Ok(Self::Start),
            "move" => Ok(Self::Move),
            "end" => Ok(Self::End),
            "cancel" => Ok(Self::Cancel),
            _ => Err(ProtocolError::InvalidPayload(format!(
                "unknown touch action '{s}'"
            ))),
        }
    }
}

impl Serialize for TouchAction {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TouchAction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::from_str(&raw).map_err(de::Error::custom)
    }
}

/// Single normalized touch contact point.
#[derive(Debug, Clone, PartialEq)]
pub struct TouchPoint {
    pub pointer_id: u32,
    /// Normalized horizontal coordinate in `[0.0, 1.0]`.
    pub x: f64,
    /// Normalized vertical coordinate in `[0.0, 1.0]`.
    pub y: f64,
    /// Normalized contact pressure in `[0.0, 1.0]`.
    pub pressure: f64,
}

impl TouchPoint {
    fn validate(&self) -> Result<(), ProtocolError> {
        validate_unit_coord("touch.x", self.x)?;
        validate_unit_coord("touch.y", self.y)?;
        validate_unit_coord("touch.pressure", self.pressure)?;
        Ok(())
    }

    fn canonicalized(&self) -> Self {
        Self {
            pointer_id: self.pointer_id,
            x: canonical_f64(self.x),
            y: canonical_f64(self.y),
            pressure: canonical_f64(self.pressure),
        }
    }
}

impl Serialize for TouchPoint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("TouchPoint", 4)?;
        s.serialize_field("pointer_id", &self.pointer_id)?;
        s.serialize_field("x", &self.x)?;
        s.serialize_field("y", &self.y)?;
        s.serialize_field("pressure", &self.pressure)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for TouchPoint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        reject_unknown_keys(&map, &["pointer_id", "x", "y", "pressure"])
            .map_err(de::Error::custom)?;
        Ok(Self {
            pointer_id: take_u32(&map, "pointer_id").map_err(de::Error::custom)?,
            x: take_f64(&map, "x").map_err(de::Error::custom)?,
            y: take_f64(&map, "y").map_err(de::Error::custom)?,
            pressure: take_f64(&map, "pressure").map_err(de::Error::custom)?,
        })
    }
}

/// Typed wire frame payloads for two-way remote screen and input control.
#[derive(Debug, Clone, PartialEq)]
pub enum FramePayload {
    ScreenFrameHeader {
        frame_id: u64,
        width: u32,
        height: u32,
        format: String,
        byte_len: u32,
        sha256_hex: String,
        keyframe: bool,
        preview_base64: Option<String>,
    },
    MouseMove {
        x: f64,
        y: f64,
        display_id: u32,
    },
    MouseClick {
        x: f64,
        y: f64,
        button: MouseButton,
        action: ButtonAction,
        display_id: u32,
    },
    KeyEvent {
        key_code: String,
        action: KeyAction,
        shift: bool,
        ctrl: bool,
        alt: bool,
        meta: bool,
        repeat: bool,
    },
    TouchEvent {
        action: TouchAction,
        display_id: u32,
        points: Vec<TouchPoint>,
    },
    Heartbeat {
        ping_nonce: u64,
        echo_nonce: Option<u64>,
    },
    DisconnectNotice {
        reason: String,
        graceful: bool,
    },
}

impl FramePayload {
    /// Canonical payload kind identifier.
    #[must_use]
    pub const fn kind_name(&self) -> &'static str {
        match self {
            Self::ScreenFrameHeader { .. } => "screen_frame_header",
            Self::MouseMove { .. } => "mouse_move",
            Self::MouseClick { .. } => "mouse_click",
            Self::KeyEvent { .. } => "key_event",
            Self::TouchEvent { .. } => "touch_event",
            Self::Heartbeat { .. } => "heartbeat",
            Self::DisconnectNotice { .. } => "disconnect_notice",
        }
    }

    /// Required [`CapabilityScope`] for sending or receiving this payload (`None` for control frames).
    #[must_use]
    pub const fn required_scope(&self) -> Option<CapabilityScope> {
        match self {
            Self::ScreenFrameHeader { .. } => Some(CapabilityScope::ScreenStream),
            Self::MouseMove { .. } | Self::MouseClick { .. } => Some(CapabilityScope::MouseInput),
            Self::KeyEvent { .. } => Some(CapabilityScope::KeyboardInput),
            Self::TouchEvent { .. } => Some(CapabilityScope::TouchInput),
            Self::Heartbeat { .. } | Self::DisconnectNotice { .. } => None,
        }
    }

    /// Validates payload coordinates, dimensions, identifier syntax, and bounded byte limits.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::ScreenFrameHeader {
                width,
                height,
                format,
                byte_len,
                sha256_hex,
                preview_base64,
                ..
            } => {
                if *width == 0 || *width > MAX_SCREEN_WIDTH {
                    return Err(ProtocolError::InvalidPayload(format!(
                        "screen width {width} outside 1..={MAX_SCREEN_WIDTH}"
                    )));
                }
                if *height == 0 || *height > MAX_SCREEN_HEIGHT {
                    return Err(ProtocolError::InvalidPayload(format!(
                        "screen height {height} outside 1..={MAX_SCREEN_HEIGHT}"
                    )));
                }
                if format.is_empty()
                    || format.len() > 32
                    || !format
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                {
                    return Err(ProtocolError::InvalidPayload(
                        "screen format must be 1..=32 ASCII [A-Za-z0-9_-] characters".to_string(),
                    ));
                }
                if *byte_len == 0 || *byte_len > MAX_SCREEN_FRAME_BYTES {
                    return Err(ProtocolError::InvalidPayload(format!(
                        "screen frame byte_len {byte_len} outside 1..={MAX_SCREEN_FRAME_BYTES}"
                    )));
                }
                decode_hex_32(sha256_hex).map_err(|err| {
                    ProtocolError::InvalidPayload(format!("invalid screen frame sha256_hex: {err}"))
                })?;
                if let Some(b64) = preview_base64 {
                    if b64.len() > MAX_PREVIEW_BASE64_LEN {
                        return Err(ProtocolError::InvalidPayload(format!(
                            "preview_base64 exceeds {MAX_PREVIEW_BASE64_LEN} characters"
                        )));
                    }
                    let decoded = decode_base64(b64).map_err(|err| {
                        ProtocolError::InvalidPayload(format!("invalid preview_base64: {err}"))
                    })?;
                    if decoded.len() > MAX_INLINE_PREVIEW_BYTES {
                        return Err(ProtocolError::InvalidPayload(format!(
                            "decoded inline preview ({} bytes) exceeds {MAX_INLINE_PREVIEW_BYTES} bytes",
                            decoded.len()
                        )));
                    }
                    if decoded.len() > *byte_len as usize {
                        return Err(ProtocolError::InvalidPayload(
                            "decoded inline preview exceeds declared byte_len".to_string(),
                        ));
                    }
                }
                Ok(())
            }
            Self::MouseMove { x, y, display_id } => {
                validate_unit_coord("mouse.x", *x)?;
                validate_unit_coord("mouse.y", *y)?;
                validate_display_id(*display_id)?;
                Ok(())
            }
            Self::MouseClick {
                x, y, display_id, ..
            } => {
                validate_unit_coord("mouse.x", *x)?;
                validate_unit_coord("mouse.y", *y)?;
                validate_display_id(*display_id)?;
                Ok(())
            }
            Self::KeyEvent { key_code, .. } => {
                let trimmed = key_code.trim();
                if trimmed.is_empty()
                    || key_code.len() > MAX_KEY_CODE_LEN
                    || !key_code.bytes().all(|b| (0x20..=0x7e).contains(&b))
                {
                    return Err(ProtocolError::InvalidPayload(format!(
                        "key_code must be 1..={MAX_KEY_CODE_LEN} printable ASCII characters"
                    )));
                }
                Ok(())
            }
            Self::TouchEvent {
                display_id, points, ..
            } => {
                validate_display_id(*display_id)?;
                if points.is_empty() || points.len() > MAX_TOUCH_POINTS {
                    return Err(ProtocolError::InvalidPayload(format!(
                        "touch points count {} outside 1..={MAX_TOUCH_POINTS}",
                        points.len()
                    )));
                }
                for point in points {
                    point.validate()?;
                }
                Ok(())
            }
            Self::Heartbeat { .. } => Ok(()),
            Self::DisconnectNotice { reason, .. } => {
                if reason.trim().is_empty()
                    || reason.len() > MAX_DISCONNECT_REASON_LEN
                    || reason.chars().any(char::is_control)
                {
                    return Err(ProtocolError::InvalidPayload(format!(
                        "disconnect reason must be 1..={MAX_DISCONNECT_REASON_LEN} non-control characters"
                    )));
                }
                Ok(())
            }
        }
    }

    fn canonicalized(&self) -> Self {
        match self {
            Self::MouseMove { x, y, display_id } => Self::MouseMove {
                x: canonical_f64(*x),
                y: canonical_f64(*y),
                display_id: *display_id,
            },
            Self::MouseClick {
                x,
                y,
                button,
                action,
                display_id,
            } => Self::MouseClick {
                x: canonical_f64(*x),
                y: canonical_f64(*y),
                button: *button,
                action: *action,
                display_id: *display_id,
            },
            Self::TouchEvent {
                action,
                display_id,
                points,
            } => Self::TouchEvent {
                action: *action,
                display_id: *display_id,
                points: points.iter().map(TouchPoint::canonicalized).collect(),
            },
            _ => self.clone(),
        }
    }
}

impl Serialize for FramePayload {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ScreenFrameHeader {
                frame_id,
                width,
                height,
                format,
                byte_len,
                sha256_hex,
                keyframe,
                preview_base64,
            } => {
                let mut m = serializer.serialize_map(Some(9))?;
                m.serialize_entry("kind", "screen_frame_header")?;
                m.serialize_entry("frame_id", frame_id)?;
                m.serialize_entry("width", width)?;
                m.serialize_entry("height", height)?;
                m.serialize_entry("format", format)?;
                m.serialize_entry("byte_len", byte_len)?;
                m.serialize_entry("sha256_hex", sha256_hex)?;
                m.serialize_entry("keyframe", keyframe)?;
                m.serialize_entry("preview_base64", preview_base64)?;
                m.end()
            }
            Self::MouseMove { x, y, display_id } => {
                let mut m = serializer.serialize_map(Some(4))?;
                m.serialize_entry("kind", "mouse_move")?;
                m.serialize_entry("x", x)?;
                m.serialize_entry("y", y)?;
                m.serialize_entry("display_id", display_id)?;
                m.end()
            }
            Self::MouseClick {
                x,
                y,
                button,
                action,
                display_id,
            } => {
                let mut m = serializer.serialize_map(Some(6))?;
                m.serialize_entry("kind", "mouse_click")?;
                m.serialize_entry("x", x)?;
                m.serialize_entry("y", y)?;
                m.serialize_entry("button", button)?;
                m.serialize_entry("action", action)?;
                m.serialize_entry("display_id", display_id)?;
                m.end()
            }
            Self::KeyEvent {
                key_code,
                action,
                shift,
                ctrl,
                alt,
                meta,
                repeat,
            } => {
                let mut m = serializer.serialize_map(Some(8))?;
                m.serialize_entry("kind", "key_event")?;
                m.serialize_entry("key_code", key_code)?;
                m.serialize_entry("action", action)?;
                m.serialize_entry("shift", shift)?;
                m.serialize_entry("ctrl", ctrl)?;
                m.serialize_entry("alt", alt)?;
                m.serialize_entry("meta", meta)?;
                m.serialize_entry("repeat", repeat)?;
                m.end()
            }
            Self::TouchEvent {
                action,
                display_id,
                points,
            } => {
                let mut m = serializer.serialize_map(Some(4))?;
                m.serialize_entry("kind", "touch_event")?;
                m.serialize_entry("action", action)?;
                m.serialize_entry("display_id", display_id)?;
                m.serialize_entry("points", points)?;
                m.end()
            }
            Self::Heartbeat {
                ping_nonce,
                echo_nonce,
            } => {
                let mut m = serializer.serialize_map(Some(3))?;
                m.serialize_entry("kind", "heartbeat")?;
                m.serialize_entry("ping_nonce", ping_nonce)?;
                m.serialize_entry("echo_nonce", echo_nonce)?;
                m.end()
            }
            Self::DisconnectNotice { reason, graceful } => {
                let mut m = serializer.serialize_map(Some(3))?;
                m.serialize_entry("kind", "disconnect_notice")?;
                m.serialize_entry("reason", reason)?;
                m.serialize_entry("graceful", graceful)?;
                m.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for FramePayload {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        let kind = take_string(&map, "kind").map_err(de::Error::custom)?;
        match kind.as_str() {
            "screen_frame_header" => {
                reject_unknown_keys(
                    &map,
                    &[
                        "kind",
                        "frame_id",
                        "width",
                        "height",
                        "format",
                        "byte_len",
                        "sha256_hex",
                        "keyframe",
                        "preview_base64",
                    ],
                )
                .map_err(de::Error::custom)?;
                let preview_base64 = match map.get("preview_base64") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(_) => {
                        return Err(de::Error::custom(
                            "field 'preview_base64' must be string or null",
                        ))
                    }
                };
                Ok(Self::ScreenFrameHeader {
                    frame_id: take_u64(&map, "frame_id").map_err(de::Error::custom)?,
                    width: take_u32(&map, "width").map_err(de::Error::custom)?,
                    height: take_u32(&map, "height").map_err(de::Error::custom)?,
                    format: take_string(&map, "format").map_err(de::Error::custom)?,
                    byte_len: take_u32(&map, "byte_len").map_err(de::Error::custom)?,
                    sha256_hex: take_string(&map, "sha256_hex").map_err(de::Error::custom)?,
                    keyframe: take_bool(&map, "keyframe").map_err(de::Error::custom)?,
                    preview_base64,
                })
            }
            "mouse_move" => {
                reject_unknown_keys(&map, &["kind", "x", "y", "display_id"])
                    .map_err(de::Error::custom)?;
                Ok(Self::MouseMove {
                    x: take_f64(&map, "x").map_err(de::Error::custom)?,
                    y: take_f64(&map, "y").map_err(de::Error::custom)?,
                    display_id: take_u32(&map, "display_id").map_err(de::Error::custom)?,
                })
            }
            "mouse_click" => {
                reject_unknown_keys(&map, &["kind", "x", "y", "button", "action", "display_id"])
                    .map_err(de::Error::custom)?;
                let button_str = take_string(&map, "button").map_err(de::Error::custom)?;
                let action_str = take_string(&map, "action").map_err(de::Error::custom)?;
                Ok(Self::MouseClick {
                    x: take_f64(&map, "x").map_err(de::Error::custom)?,
                    y: take_f64(&map, "y").map_err(de::Error::custom)?,
                    button: MouseButton::from_str(&button_str).map_err(de::Error::custom)?,
                    action: ButtonAction::from_str(&action_str).map_err(de::Error::custom)?,
                    display_id: take_u32(&map, "display_id").map_err(de::Error::custom)?,
                })
            }
            "key_event" => {
                reject_unknown_keys(
                    &map,
                    &[
                        "kind", "key_code", "action", "shift", "ctrl", "alt", "meta", "repeat",
                    ],
                )
                .map_err(de::Error::custom)?;
                let action_str = take_string(&map, "action").map_err(de::Error::custom)?;
                Ok(Self::KeyEvent {
                    key_code: take_string(&map, "key_code").map_err(de::Error::custom)?,
                    action: KeyAction::from_str(&action_str).map_err(de::Error::custom)?,
                    shift: take_bool(&map, "shift").map_err(de::Error::custom)?,
                    ctrl: take_bool(&map, "ctrl").map_err(de::Error::custom)?,
                    alt: take_bool(&map, "alt").map_err(de::Error::custom)?,
                    meta: take_bool(&map, "meta").map_err(de::Error::custom)?,
                    repeat: take_bool(&map, "repeat").map_err(de::Error::custom)?,
                })
            }
            "touch_event" => {
                reject_unknown_keys(&map, &["kind", "action", "display_id", "points"])
                    .map_err(de::Error::custom)?;
                let action_str = take_string(&map, "action").map_err(de::Error::custom)?;
                let points_val = map
                    .get("points")
                    .ok_or_else(|| de::Error::custom("missing field 'points'"))?;
                let points =
                    Vec::<TouchPoint>::deserialize(points_val).map_err(de::Error::custom)?;
                Ok(Self::TouchEvent {
                    action: TouchAction::from_str(&action_str).map_err(de::Error::custom)?,
                    display_id: take_u32(&map, "display_id").map_err(de::Error::custom)?,
                    points,
                })
            }
            "heartbeat" => {
                reject_unknown_keys(&map, &["kind", "ping_nonce", "echo_nonce"])
                    .map_err(de::Error::custom)?;
                let echo_nonce = match map.get("echo_nonce") {
                    None | Some(Value::Null) => None,
                    Some(Value::Number(n)) => Some(
                        n.as_u64()
                            .ok_or_else(|| de::Error::custom("field 'echo_nonce' must be u64"))?,
                    ),
                    Some(_) => {
                        return Err(de::Error::custom("field 'echo_nonce' must be u64 or null"))
                    }
                };
                Ok(Self::Heartbeat {
                    ping_nonce: take_u64(&map, "ping_nonce").map_err(de::Error::custom)?,
                    echo_nonce,
                })
            }
            "disconnect_notice" => {
                reject_unknown_keys(&map, &["kind", "reason", "graceful"])
                    .map_err(de::Error::custom)?;
                Ok(Self::DisconnectNotice {
                    reason: take_string(&map, "reason").map_err(de::Error::custom)?,
                    graceful: take_bool(&map, "graceful").map_err(de::Error::custom)?,
                })
            }
            other => Err(de::Error::custom(format!("unknown payload kind '{other}'"))),
        }
    }
}

/// Authenticated wire envelope transmitted between two paired peers.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameEnvelope {
    pub session_id: String,
    pub sender_id: String,
    pub seq: u64,
    pub timestamp_ms: u64,
    pub payload: FramePayload,
    pub mac_hex: String,
}

impl FrameEnvelope {
    /// Produces the unambiguous canonical byte sequence covered by `mac_hex`.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        validate_identifier("session_id", &self.session_id)?;
        validate_identifier("sender_id", &self.sender_id)?;
        if self.seq == 0 {
            return Err(ReplayError::ZeroSequence.into());
        }
        if self.timestamp_ms == 0 {
            return Err(ProtocolError::InvalidTimestamp);
        }
        let canonical_payload = self.payload.canonicalized();
        let payload_json = serde_json::to_vec(&canonical_payload)
            .map_err(|err| ProtocolError::Codec(err.to_string()))?;

        let mut buf = Vec::with_capacity(128 + payload_json.len());
        buf.extend_from_slice(b"omnia-remote-control:v1:frame");
        push_len_prefixed(&mut buf, self.session_id.as_bytes());
        push_len_prefixed(&mut buf, self.sender_id.as_bytes());
        buf.extend_from_slice(&self.seq.to_be_bytes());
        buf.extend_from_slice(&self.timestamp_ms.to_be_bytes());
        push_len_prefixed(&mut buf, &payload_json);
        Ok(buf)
    }

    /// Computes lowercase hex HMAC-SHA256 tag over this frame's canonical signing bytes.
    pub fn compute_mac(&self, key: &SessionKey) -> Result<String, ProtocolError> {
        let bytes = self.signing_bytes()?;
        Ok(hmac_sha256_hex(key.as_bytes(), &bytes))
    }

    /// Verifies `self.mac_hex` in constant time against `key`.
    pub fn verify_mac(&self, key: &SessionKey) -> Result<(), ProtocolError> {
        let bytes = self.signing_bytes()?;
        verify_hmac_sha256_hex(key.as_bytes(), &bytes, &self.mac_hex)
            .map_err(|_| ProtocolError::TamperedMac)
    }

    /// Serializes the envelope into JSON bytes while enforcing [`MAX_FRAME_WIRE_BYTES`].
    pub fn to_bounded_json_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        let bytes =
            serde_json::to_vec(self).map_err(|err| ProtocolError::Codec(err.to_string()))?;
        if bytes.len() > MAX_FRAME_WIRE_BYTES {
            return Err(ProtocolError::Codec(format!(
                "serialized frame ({} bytes) exceeds MAX_FRAME_WIRE_BYTES ({MAX_FRAME_WIRE_BYTES})",
                bytes.len()
            )));
        }
        Ok(bytes)
    }

    /// Deserializes a JSON frame envelope while enforcing [`MAX_FRAME_WIRE_BYTES`].
    pub fn from_bounded_json_bytes(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.is_empty() || bytes.len() > MAX_FRAME_WIRE_BYTES {
            return Err(ProtocolError::Codec(format!(
                "frame wire length {} outside 1..={MAX_FRAME_WIRE_BYTES}",
                bytes.len()
            )));
        }
        serde_json::from_slice(bytes).map_err(|err| ProtocolError::Codec(err.to_string()))
    }
}

impl Serialize for FrameEnvelope {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("FrameEnvelope", 6)?;
        s.serialize_field("session_id", &self.session_id)?;
        s.serialize_field("sender_id", &self.sender_id)?;
        s.serialize_field("seq", &self.seq)?;
        s.serialize_field("timestamp_ms", &self.timestamp_ms)?;
        s.serialize_field("payload", &self.payload)?;
        s.serialize_field("mac_hex", &self.mac_hex)?;
        s.end()
    }
}

impl<'de> Deserialize<'de> for FrameEnvelope {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = Map::<String, Value>::deserialize(deserializer)?;
        reject_unknown_keys(
            &map,
            &[
                "session_id",
                "sender_id",
                "seq",
                "timestamp_ms",
                "payload",
                "mac_hex",
            ],
        )
        .map_err(de::Error::custom)?;

        let payload_val = map
            .get("payload")
            .ok_or_else(|| de::Error::custom("missing field 'payload'"))?;
        let payload = FramePayload::deserialize(payload_val).map_err(de::Error::custom)?;

        Ok(Self {
            session_id: take_string(&map, "session_id").map_err(de::Error::custom)?,
            sender_id: take_string(&map, "sender_id").map_err(de::Error::custom)?,
            seq: take_u64(&map, "seq").map_err(de::Error::custom)?,
            timestamp_ms: take_u64(&map, "timestamp_ms").map_err(de::Error::custom)?,
            payload,
            mac_hex: take_string(&map, "mac_hex").map_err(de::Error::custom)?,
        })
    }
}

/// Outcome recorded in the secret-free audit log for every inbound/outbound frame check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditOutcome {
    Accepted,
    Rejected(String),
}

/// Secret-free audit record emitted by [`PeerSession`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRecord {
    pub direction: FrameDirection,
    pub session_id: String,
    pub peer_id: String,
    pub seq: u64,
    pub timestamp_ms: u64,
    pub payload_kind: &'static str,
    pub outcome: AuditOutcome,
}

/// Stateful authenticated two-way session endpoint enforcing lease, MAC, scopes, and anti-replay.
#[derive(Debug)]
pub struct PeerSession {
    lease: SessionLease,
    key: SessionKey,
    seq_gen: SequenceGenerator,
    replay_window: ReplayWindow,
    local_disconnected: bool,
    peer_disconnected: bool,
    audit_log: VecDeque<AuditRecord>,
}

impl PeerSession {
    /// Initializes an authenticated peer session after checking `lease` identity and `key` digest.
    pub fn new(lease: SessionLease, key: SessionKey) -> Result<Self, ProtocolError> {
        validate_identifier("session_id", &lease.session_id)?;
        validate_identifier("local_peer_id", &lease.local_peer_id)?;
        validate_identifier("peer_id", &lease.peer_id)?;
        lease.matches_key(&key)?;
        Ok(Self {
            lease,
            key,
            seq_gen: SequenceGenerator::new(),
            replay_window: ReplayWindow::new(),
            local_disconnected: false,
            peer_disconnected: false,
            audit_log: VecDeque::new(),
        })
    }

    /// Returns a read-only view of the active lease metadata (contains no raw key bytes).
    #[must_use]
    pub const fn lease(&self) -> &SessionLease {
        &self.lease
    }

    /// Explicitly revokes this session's lease so all future inbound and outbound frames fail closed.
    pub fn revoke(&mut self, reason: impl Into<String>) {
        self.lease.revoke(reason);
    }

    /// True once this endpoint has sent a `DisconnectNotice`.
    #[must_use]
    pub const fn is_local_disconnected(&self) -> bool {
        self.local_disconnected
    }

    /// True once the remote peer has sent a `DisconnectNotice`.
    #[must_use]
    pub const fn is_peer_disconnected(&self) -> bool {
        self.peer_disconnected
    }

    /// Number of accepted inbound frames tracked in the replay window.
    #[must_use]
    pub const fn inbound_accepted_count(&self) -> u64 {
        self.replay_window.accepted_count()
    }

    /// Highest authenticated inbound sequence number seen so far.
    #[must_use]
    pub const fn highest_inbound_seq(&self) -> u64 {
        self.replay_window.highest_seq()
    }

    /// Returns all retained secret-free audit records.
    #[must_use]
    pub fn audit_log(&self) -> &VecDeque<AuditRecord> {
        &self.audit_log
    }

    /// Validates, authorizes outbound scope, assigns monotonic `seq`, and signs an outbound frame.
    pub fn seal_outbound(
        &mut self,
        payload: FramePayload,
        now_ms: u64,
    ) -> Result<FrameEnvelope, ProtocolError> {
        let kind = payload.kind_name();
        let result = self.seal_outbound_inner(payload, now_ms);
        match &result {
            Ok(env) => self.record_audit(
                FrameDirection::Outbound,
                env.seq,
                now_ms,
                kind,
                AuditOutcome::Accepted,
            ),
            Err(err) => self.record_audit(
                FrameDirection::Outbound,
                self.seq_gen.peek_next().unwrap_or(0),
                now_ms,
                kind,
                AuditOutcome::Rejected(err.to_string()),
            ),
        }
        result
    }

    fn seal_outbound_inner(
        &mut self,
        payload: FramePayload,
        now_ms: u64,
    ) -> Result<FrameEnvelope, ProtocolError> {
        if now_ms == 0 {
            return Err(ProtocolError::InvalidTimestamp);
        }
        if self.local_disconnected {
            return Err(ProtocolError::SessionDisconnected {
                direction: FrameDirection::Outbound,
            });
        }
        self.lease
            .authorize(FrameDirection::Outbound, payload.required_scope(), now_ms)?;
        payload.validate()?;

        let canonical_payload = payload.canonicalized();
        let seq = self.seq_gen.next_seq()?;
        let mut envelope = FrameEnvelope {
            session_id: self.lease.session_id.clone(),
            sender_id: self.lease.local_peer_id.clone(),
            seq,
            timestamp_ms: now_ms,
            payload: canonical_payload,
            mac_hex: String::new(),
        };
        envelope.mac_hex = envelope.compute_mac(&self.key)?;
        let _ = envelope.to_bounded_json_bytes()?;

        if matches!(envelope.payload, FramePayload::DisconnectNotice { .. }) {
            self.local_disconnected = true;
        }
        Ok(envelope)
    }

    /// Verifies identity, active lease, MAC, payload invariants, directional scope, and anti-replay.
    pub fn open_inbound(
        &mut self,
        envelope: &FrameEnvelope,
        now_ms: u64,
    ) -> Result<FramePayload, ProtocolError> {
        let kind = envelope.payload.kind_name();
        let result = self.open_inbound_inner(envelope, now_ms);
        match &result {
            Ok(_) => self.record_audit(
                FrameDirection::Inbound,
                envelope.seq,
                now_ms,
                kind,
                AuditOutcome::Accepted,
            ),
            Err(err) => self.record_audit(
                FrameDirection::Inbound,
                envelope.seq,
                now_ms,
                kind,
                AuditOutcome::Rejected(err.to_string()),
            ),
        }
        result
    }

    fn open_inbound_inner(
        &mut self,
        envelope: &FrameEnvelope,
        now_ms: u64,
    ) -> Result<FramePayload, ProtocolError> {
        if now_ms == 0 {
            return Err(ProtocolError::InvalidTimestamp);
        }
        if self.peer_disconnected {
            return Err(ProtocolError::SessionDisconnected {
                direction: FrameDirection::Inbound,
            });
        }
        let _ = envelope.to_bounded_json_bytes()?;

        if envelope.session_id != self.lease.session_id {
            return Err(ProtocolError::SessionMismatch {
                expected: self.lease.session_id.clone(),
                actual: envelope.session_id.clone(),
            });
        }
        if envelope.sender_id != self.lease.peer_id {
            return Err(ProtocolError::UnauthorizedSender {
                expected: self.lease.peer_id.clone(),
                actual: envelope.sender_id.clone(),
            });
        }
        self.lease.is_active(now_ms)?;

        // Verify cryptographic MAC BEFORE mutating replay window state.
        envelope.verify_mac(&self.key)?;

        envelope.payload.validate()?;
        self.lease.authorize(
            FrameDirection::Inbound,
            envelope.payload.required_scope(),
            now_ms,
        )?;
        self.replay_window.check_and_accept(envelope.seq)?;

        if matches!(envelope.payload, FramePayload::DisconnectNotice { .. }) {
            self.peer_disconnected = true;
        }
        Ok(envelope.payload.clone())
    }

    fn record_audit(
        &mut self,
        direction: FrameDirection,
        seq: u64,
        timestamp_ms: u64,
        payload_kind: &'static str,
        outcome: AuditOutcome,
    ) {
        if self.audit_log.len() >= MAX_AUDIT_RECORDS {
            self.audit_log.pop_front();
        }
        self.audit_log.push_back(AuditRecord {
            direction,
            session_id: self.lease.session_id.clone(),
            peer_id: self.lease.peer_id.clone(),
            seq,
            timestamp_ms,
            payload_kind,
            outcome,
        });
    }
}

fn canonical_f64(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn validate_unit_coord(axis: &'static str, value: f64) -> Result<(), ProtocolError> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(ProtocolError::InvalidPayload(format!(
            "{axis} value {value} must be finite and within [0.0, 1.0]"
        )));
    }
    Ok(())
}

fn validate_display_id(display_id: u32) -> Result<(), ProtocolError> {
    if display_id > MAX_DISPLAY_ID {
        return Err(ProtocolError::InvalidPayload(format!(
            "display_id {display_id} exceeds MAX_DISPLAY_ID ({MAX_DISPLAY_ID})"
        )));
    }
    Ok(())
}

fn take_u32(map: &Map<String, Value>, key: &str) -> Result<u32, String> {
    let raw = take_u64(map, key)?;
    u32::try_from(raw).map_err(|_| format!("field '{key}' out of u32 range"))
}

fn take_f64(map: &Map<String, Value>, key: &str) -> Result<f64, String> {
    map.get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("missing or non-numeric field '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::sha256_hex;
    use crate::pairing::{
        complete_pairing_approver, complete_pairing_initiator, PairingApproval, PairingOffer,
    };

    const SECRET: &[u8] = b"omnia-protocol-test-secret";

    fn paired_sessions(
        host_inbound: Vec<CapabilityScope>,
        host_outbound: Vec<CapabilityScope>,
    ) -> (PeerSession, PeerSession) {
        let offer = PairingOffer::create(
            "sess-proto",
            "host",
            "controller",
            "offer-n1",
            host_inbound.clone(),
            host_outbound.clone(),
            1_000,
            5_000,
            60_000,
            SECRET,
        )
        .expect("offer");
        let approval = PairingApproval::approve(
            &offer,
            "controller",
            "approval-n1",
            host_inbound,
            host_outbound,
            SECRET,
            1_100,
        )
        .expect("approval");
        let (h_lease, h_key) =
            complete_pairing_initiator(&offer, &approval, SECRET, 1_200).expect("host lease");
        let (c_lease, c_key) =
            complete_pairing_approver(&offer, &approval, SECRET, 1_200).expect("ctrl lease");
        (
            PeerSession::new(h_lease, h_key).expect("host session"),
            PeerSession::new(c_lease, c_key).expect("ctrl session"),
        )
    }

    #[test]
    fn frame_envelope_json_round_trip_and_mac_verification() {
        let (mut host, mut ctrl) = paired_sessions(
            vec![
                CapabilityScope::MouseInput,
                CapabilityScope::KeyboardInput,
                CapabilityScope::TouchInput,
            ],
            vec![CapabilityScope::ScreenStream],
        );

        let screen_env = host
            .seal_outbound(
                FramePayload::ScreenFrameHeader {
                    frame_id: 7,
                    width: 1920,
                    height: 1080,
                    format: "bgra8".to_string(),
                    byte_len: 1024,
                    sha256_hex: sha256_hex(b"frame-7"),
                    keyframe: true,
                    preview_base64: Some(crate::crypto::encode_base64(b"tiny-preview")),
                },
                2_000,
            )
            .expect("host seals screen header");

        let wire = screen_env.to_bounded_json_bytes().expect("wire encode");
        let decoded = FrameEnvelope::from_bounded_json_bytes(&wire).expect("wire decode");
        let opened = ctrl
            .open_inbound(&decoded, 2_010)
            .expect("ctrl accepts screen header");
        assert!(matches!(
            opened,
            FramePayload::ScreenFrameHeader { frame_id: 7, .. }
        ));

        let move_env = ctrl
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.123456789,
                    y: 0.987654321,
                    display_id: 0,
                },
                2_020,
            )
            .expect("ctrl seals mouse move");
        let move_wire = move_env.to_bounded_json_bytes().expect("wire encode");
        let move_decoded = FrameEnvelope::from_bounded_json_bytes(&move_wire).expect("wire decode");
        assert!(host.open_inbound(&move_decoded, 2_030).is_ok());
    }

    #[test]
    fn rejects_tampered_mac_and_wrong_sender_or_session() {
        let (mut host, mut ctrl) = paired_sessions(
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
        );

        let mut env = ctrl
            .seal_outbound(
                FramePayload::MouseClick {
                    x: 0.5,
                    y: 0.5,
                    button: MouseButton::Left,
                    action: ButtonAction::Click,
                    display_id: 0,
                },
                2_000,
            )
            .expect("sealed");

        let mut tampered_payload = env.clone();
        tampered_payload.payload = FramePayload::MouseClick {
            x: 0.9,
            y: 0.5,
            button: MouseButton::Left,
            action: ButtonAction::Click,
            display_id: 0,
        };
        assert_eq!(
            host.open_inbound(&tampered_payload, 2_010),
            Err(ProtocolError::TamperedMac)
        );

        let mut wrong_sender = env.clone();
        wrong_sender.sender_id = "evil-peer".to_string();
        assert!(matches!(
            host.open_inbound(&wrong_sender, 2_010),
            Err(ProtocolError::UnauthorizedSender { .. })
        ));

        env.session_id = "other-session".to_string();
        assert!(matches!(
            host.open_inbound(&env, 2_010),
            Err(ProtocolError::SessionMismatch { .. })
        ));
    }

    #[test]
    fn rejects_unpaired_revoked_and_expired_session_frames() {
        let (mut host, mut ctrl) = paired_sessions(
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
        );

        let env = ctrl
            .seal_outbound(
                FramePayload::Heartbeat {
                    ping_nonce: 42,
                    echo_nonce: None,
                },
                2_000,
            )
            .expect("heartbeat");

        // Expired at 61_100 (approved_at 1100 + ttl 60_000 = 61_100).
        assert!(matches!(
            host.open_inbound(&env, 61_100),
            Err(ProtocolError::Pairing(PairingError::LeaseExpired { .. }))
        ));

        // Revoked lease fails closed even within time window.
        host.revoke("emergency revoke");
        assert!(matches!(
            host.open_inbound(&env, 2_010),
            Err(ProtocolError::Pairing(PairingError::LeaseRevoked { .. }))
        ));
        assert!(matches!(
            host.seal_outbound(
                FramePayload::Heartbeat {
                    ping_nonce: 99,
                    echo_nonce: None
                },
                2_020
            ),
            Err(ProtocolError::Pairing(PairingError::LeaseRevoked { .. }))
        ));
    }

    #[test]
    fn rejects_directional_scope_escalation_outbound_and_inbound() {
        let (mut host, mut ctrl) = paired_sessions(
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
        );

        // Controller cannot send KeyEvent when only MouseInput was granted outbound.
        let outbound_err = ctrl
            .seal_outbound(
                FramePayload::KeyEvent {
                    key_code: "Enter".to_string(),
                    action: KeyAction::Press,
                    shift: false,
                    ctrl: false,
                    alt: false,
                    meta: false,
                    repeat: false,
                },
                2_000,
            )
            .expect_err("ctrl outbound keyboard must be denied");
        assert!(matches!(
            outbound_err,
            ProtocolError::Pairing(PairingError::ScopeDenied {
                direction: FrameDirection::Outbound,
                scope: CapabilityScope::KeyboardInput,
                ..
            })
        ));

        // Even if someone signs a ScreenFrameHeader with the shared session key pretending to be controller,
        // host's inbound policy only allows MouseInput from controller and rejects ScreenStream!
        let forged_inbound = FrameEnvelope {
            session_id: host.lease().session_id.clone(),
            sender_id: "controller".to_string(),
            seq: 1,
            timestamp_ms: 2_000,
            payload: FramePayload::ScreenFrameHeader {
                frame_id: 1,
                width: 640,
                height: 480,
                format: "bgra8".to_string(),
                byte_len: 100,
                sha256_hex: sha256_hex(b"spoof"),
                keyframe: true,
                preview_base64: None,
            },
            mac_hex: String::new(),
        };
        let mut signed = forged_inbound;
        signed.mac_hex = signed.compute_mac(&ctrl.key).expect("sign");

        let inbound_err = host
            .open_inbound(&signed, 2_010)
            .expect_err("host must reject ungranted inbound ScreenStream from controller");
        assert!(matches!(
            inbound_err,
            ProtocolError::Pairing(PairingError::ScopeDenied {
                direction: FrameDirection::Inbound,
                scope: CapabilityScope::ScreenStream,
                ..
            })
        ));
    }

    #[test]
    fn rejects_invalid_mouse_and_touch_coordinates_and_oversized_payloads() {
        let (mut host, mut ctrl) = paired_sessions(
            vec![CapabilityScope::MouseInput, CapabilityScope::TouchInput],
            vec![CapabilityScope::ScreenStream],
        );

        for (x, y) in [
            (-0.01, 0.5),
            (1.01, 0.5),
            (f64::NAN, 0.5),
            (0.5, f64::INFINITY),
        ] {
            let err = ctrl
                .seal_outbound(
                    FramePayload::MouseMove {
                        x,
                        y,
                        display_id: 0,
                    },
                    2_000,
                )
                .expect_err("invalid mouse coord must fail");
            assert!(matches!(err, ProtocolError::InvalidPayload(_)));
        }

        let bad_touch = ctrl
            .seal_outbound(
                FramePayload::TouchEvent {
                    action: TouchAction::Start,
                    display_id: 0,
                    points: vec![TouchPoint {
                        pointer_id: 1,
                        x: 0.5,
                        y: 1.5,
                        pressure: 0.8,
                    }],
                },
                2_000,
            )
            .expect_err("touch y > 1.0 must fail");
        assert!(matches!(bad_touch, ProtocolError::InvalidPayload(_)));

        let empty_touch = ctrl
            .seal_outbound(
                FramePayload::TouchEvent {
                    action: TouchAction::Move,
                    display_id: 0,
                    points: vec![],
                },
                2_000,
            )
            .expect_err("empty touch points must fail");
        assert!(matches!(empty_touch, ProtocolError::InvalidPayload(_)));

        // Oversized inline preview chunk > 16 KiB must fail validation.
        let oversized_preview =
            crate::crypto::encode_base64(&vec![0xabu8; MAX_INLINE_PREVIEW_BYTES + 1]);
        let oversized_err = host
            .seal_outbound(
                FramePayload::ScreenFrameHeader {
                    frame_id: 9,
                    width: 1280,
                    height: 720,
                    format: "png".to_string(),
                    byte_len: 32_768,
                    sha256_hex: sha256_hex(b"big"),
                    keyframe: true,
                    preview_base64: Some(oversized_preview),
                },
                2_000,
            )
            .expect_err("oversized preview must fail");
        assert!(matches!(oversized_err, ProtocolError::InvalidPayload(_)));
    }

    #[test]
    fn tampered_mac_does_not_advance_replay_window() {
        let (mut host, mut ctrl) = paired_sessions(
            vec![CapabilityScope::MouseInput],
            vec![CapabilityScope::ScreenStream],
        );

        let legitimate = ctrl
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.25,
                    y: 0.75,
                    display_id: 0,
                },
                2_000,
            )
            .expect("legitimate seq=1");

        // Spoof seq=10_000 with forged MAC.
        let mut spoofed = legitimate.clone();
        spoofed.seq = 10_000;
        spoofed.mac_hex = "0".repeat(64);
        assert_eq!(
            host.open_inbound(&spoofed, 2_010),
            Err(ProtocolError::TamperedMac)
        );
        assert_eq!(host.highest_inbound_seq(), 0);

        // Legitimate seq=1 must still be accepted cleanly.
        assert!(host.open_inbound(&legitimate, 2_020).is_ok());
        assert_eq!(host.highest_inbound_seq(), 1);
    }
}
