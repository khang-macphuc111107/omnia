//! Input calibration, polling jitter/chatter diagnostics, mouse stroke gesture recognition,
//! precision touchpad side-edge scroll strips, stylus evaluation, and truthful Windows input
//! capability descriptors.

use crate::capability::{CapabilityReason, CapabilityStatus};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

/// Standard ANSI physical key pitch mapped to logical calibration pixels (`1u = 20px`).
pub const KEY_PITCH_PX: f64 = 20.0;
/// Minimum spatial calibration points required for 5-point key-slip calibration.
pub const MIN_KEY_SLIP_CALIBRATION_POINTS: usize = 5;
/// Nominal gaming/office mouse polling tiers in Hertz.
pub const NOMINAL_MOUSE_POLLING_TIERS_HZ: [u32; 7] = [125, 250, 500, 1000, 2000, 4000, 8000];

/// Windows Registry key storing user Precision Touchpad configuration.
pub const PTP_REGISTRY_PATH: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\PrecisionTouchPad";
/// HID Usage Page for Digitizer devices (Touchpad, Pen/Stylus).
pub const HID_USAGE_PAGE_DIGITIZER: u16 = 0x0D;
/// HID Usage Page for Haptics devices (`SimpleHapticsController`).
pub const HID_USAGE_PAGE_HAPTICS: u16 = 0x0E;
/// HID Usage ID for Pen/Stylus under Digitizer Usage Page (`0x0D`).
pub const HID_USAGE_DIGITIZER_PEN: u16 = 0x02;
/// HID Usage ID for Precision Touchpad under Digitizer Usage Page (`0x0D`).
pub const HID_USAGE_DIGITIZER_TOUCHPAD: u16 = 0x05;
/// HID Usage ID for `SimpleHapticsController` under Haptics Usage Page (`0x0E`).
pub const HID_USAGE_HAPTICS_SIMPLE_CONTROLLER: u16 = 0x01;

/// Errors returned by input calibration, polling, gesture, and touchpad/stylus evaluators.
#[derive(Clone, Debug, PartialEq, Error)]
pub enum InputDiagnosticsError {
    /// Not enough samples were provided for the requested computation.
    #[error("{context} requires at least {required} samples, got {actual}")]
    InsufficientSamples {
        context: &'static str,
        required: usize,
        actual: usize,
    },
    /// A numeric metric was `NaN` or infinite.
    #[error("non-finite numeric value in `{field}`")]
    NonFiniteMetric { field: &'static str },
    /// Timestamps moved backward or did not advance strictly where required.
    #[error("non-monotonic timestamp at index {index}: {prev_us} -> {next_us}")]
    NonMonotonicTimestamps {
        index: usize,
        prev_us: u64,
        next_us: u64,
    },
    /// Invalid threshold, duration, or count parameter.
    #[error("invalid `{field}`: {detail}")]
    InvalidParameter { field: &'static str, detail: String },
    /// Character could not be mapped onto the physical ANSI QWERTY coordinate grid.
    #[error("unknown QWERTY physical key `{key}`")]
    UnknownQwertyKey { key: char },
    /// Touchpad configuration failed physical geometry or gain bounds.
    #[error("invalid touchpad configuration: {detail}")]
    InvalidTouchpadConfig { detail: String },
    /// Touchpad contact coordinates or contact diameter failed validation.
    #[error("invalid touchpad contact: {detail}")]
    InvalidTouchpadContact { detail: String },
    /// Stylus pressure or tilt angles were outside valid physical bounds.
    #[error("invalid stylus sample: {detail}")]
    InvalidStylusSample { detail: String },
    /// Mouse stroke path had insufficient points or displacement.
    #[error("invalid mouse stroke points: {detail}")]
    InvalidStrokePoints { detail: String },
}

/// Physical coordinate of a primary ANSI QWERTY key in calibration pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct QwertyKeyCoord {
    /// Canonical lowercase primary key character (`a-z`, `0-9`, punctuation, `' '`).
    pub key: char,
    /// Horizontal physical key center in pixels (`1u = KEY_PITCH_PX`).
    pub x_px: f64,
    /// Vertical physical key center in pixels (`1u = KEY_PITCH_PX`).
    pub y_px: f64,
    /// Physical row index (`0` = number row, `1` = QWERTY, `2` = ASDF, `3` = ZXCV, `4` = space).
    pub row: u8,
    /// Column index within the physical row.
    pub col: u8,
}

impl Serialize for QwertyKeyCoord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "key": self.key.to_string(),
            "x_px": self.x_px,
            "y_px": self.y_px,
            "row": self.row,
            "col": self.col,
        })
        .serialize(serializer)
    }
}

/// Normalizes a character (uppercase or shifted ANSI symbol) to its primary physical keycap.
pub fn normalize_qwerty_key(ch: char) -> Option<char> {
    let lower = ch.to_ascii_lowercase();
    let mapped = match lower {
        '~' => '`',
        '!' => '1',
        '@' => '2',
        '#' => '3',
        '$' => '4',
        '%' => '5',
        '^' => '6',
        '&' => '7',
        '*' => '8',
        '(' => '9',
        ')' => '0',
        '_' => '-',
        '+' => '=',
        '{' => '[',
        '}' => ']',
        '|' => '\\',
        ':' => ';',
        '"' => '\'',
        '<' => ',',
        '>' => '.',
        '?' => '/',
        other => other,
    };
    qwerty_key_position(mapped).map(|c| c.key)
}

/// Looks up the ANSI staggered QWERTY physical key center coordinate for `ch`.
pub fn qwerty_key_position(ch: char) -> Option<QwertyKeyCoord> {
    let lower = ch.to_ascii_lowercase();
    let canonical = match lower {
        '~' => '`',
        '!' => '1',
        '@' => '2',
        '#' => '3',
        '$' => '4',
        '%' => '5',
        '^' => '6',
        '&' => '7',
        '*' => '8',
        '(' => '9',
        ')' => '0',
        '_' => '-',
        '+' => '=',
        '{' => '[',
        '}' => ']',
        '|' => '\\',
        ':' => ';',
        '"' => '\'',
        '<' => ',',
        '>' => '.',
        '?' => '/',
        other => other,
    };

    const ROW0: &[char] = &[
        '`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=',
    ];
    const ROW1: &[char] = &[
        'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\',
    ];
    const ROW2: &[char] = &['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '\''];
    const ROW3: &[char] = &['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'];

    if let Some(col) = ROW0.iter().position(|k| *k == canonical) {
        return Some(QwertyKeyCoord {
            key: canonical,
            x_px: (col as f64) * KEY_PITCH_PX,
            y_px: 0.0,
            row: 0,
            col: col as u8,
        });
    }
    if let Some(col) = ROW1.iter().position(|k| *k == canonical) {
        return Some(QwertyKeyCoord {
            key: canonical,
            x_px: (1.5 + col as f64) * KEY_PITCH_PX,
            y_px: KEY_PITCH_PX,
            row: 1,
            col: col as u8,
        });
    }
    if let Some(col) = ROW2.iter().position(|k| *k == canonical) {
        return Some(QwertyKeyCoord {
            key: canonical,
            x_px: (1.75 + col as f64) * KEY_PITCH_PX,
            y_px: 2.0 * KEY_PITCH_PX,
            row: 2,
            col: col as u8,
        });
    }
    if let Some(col) = ROW3.iter().position(|k| *k == canonical) {
        return Some(QwertyKeyCoord {
            key: canonical,
            x_px: (2.25 + col as f64) * KEY_PITCH_PX,
            y_px: 3.0 * KEY_PITCH_PX,
            row: 3,
            col: col as u8,
        });
    }
    if canonical == ' ' {
        return Some(QwertyKeyCoord {
            key: ' ',
            x_px: 6.25 * KEY_PITCH_PX,
            y_px: 4.0 * KEY_PITCH_PX,
            row: 4,
            col: 0,
        });
    }
    None
}

/// Returns all mapped primary ANSI QWERTY coordinates in deterministic row/column order.
pub fn qwerty_key_map() -> Vec<QwertyKeyCoord> {
    const ALL_KEYS: &[char] = &[
        '`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'q', 'w', 'e', 'r', 't',
        'y', 'u', 'i', 'o', 'p', '[', ']', '\\', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';',
        '\'', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', ' ',
    ];
    ALL_KEYS
        .iter()
        .filter_map(|k| qwerty_key_position(*k))
        .collect()
}

/// Single spatial key-slip sample recorded during keyboard calibration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KeySlipSample {
    /// Intended QWERTY key character.
    pub expected_key: char,
    /// Observed horizontal spatial slip (`observed_x_px - expected_x_px`).
    pub dx_px: f64,
    /// Observed vertical spatial slip (`observed_y_px - expected_y_px`).
    pub dy_px: f64,
    /// Inter-key flight latency in milliseconds.
    pub flight_ms: f64,
}

impl KeySlipSample {
    /// Constructs a sample from explicit `(dx_px, dy_px)` spatial displacement.
    pub fn from_delta(
        expected_key: char,
        dx_px: f64,
        dy_px: f64,
        flight_ms: f64,
    ) -> Result<Self, InputDiagnosticsError> {
        let coord = qwerty_key_position(expected_key)
            .ok_or(InputDiagnosticsError::UnknownQwertyKey { key: expected_key })?;
        ensure_finite(dx_px, "dx_px")?;
        ensure_finite(dy_px, "dy_px")?;
        ensure_non_negative_finite(flight_ms, "flight_ms")?;
        Ok(Self {
            expected_key: coord.key,
            dx_px,
            dy_px,
            flight_ms,
        })
    }

    /// Constructs a sample from an intended key and observed strike `(x_px, y_px)`.
    pub fn from_coordinates(
        expected_key: char,
        observed_x_px: f64,
        observed_y_px: f64,
        flight_ms: f64,
    ) -> Result<Self, InputDiagnosticsError> {
        let coord = qwerty_key_position(expected_key)
            .ok_or(InputDiagnosticsError::UnknownQwertyKey { key: expected_key })?;
        ensure_finite(observed_x_px, "observed_x_px")?;
        ensure_finite(observed_y_px, "observed_y_px")?;
        ensure_non_negative_finite(flight_ms, "flight_ms")?;
        Ok(Self {
            expected_key: coord.key,
            dx_px: observed_x_px - coord.x_px,
            dy_px: observed_y_px - coord.y_px,
            flight_ms,
        })
    }

    /// Constructs a sample from an intended key and an accidentally struck neighbor key.
    pub fn from_keys(
        expected_key: char,
        observed_key: char,
        flight_ms: f64,
    ) -> Result<Self, InputDiagnosticsError> {
        let expected = qwerty_key_position(expected_key)
            .ok_or(InputDiagnosticsError::UnknownQwertyKey { key: expected_key })?;
        let observed = qwerty_key_position(observed_key)
            .ok_or(InputDiagnosticsError::UnknownQwertyKey { key: observed_key })?;
        ensure_non_negative_finite(flight_ms, "flight_ms")?;
        Ok(Self {
            expected_key: expected.key,
            dx_px: observed.x_px - expected.x_px,
            dy_px: observed.y_px - expected.y_px,
            flight_ms,
        })
    }
}

/// Ranked QWERTY neighbor key candidate produced by bias-compensated spatial slip recovery.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyNeighborCandidate {
    /// Candidate intended key character.
    pub key: char,
    /// Euclidean distance in pixels from the de-biased strike coordinate to this key's center.
    pub distance_px: f64,
    /// Monotonic normalized proximity score in `(0.0, 1.0]`.
    pub score: f64,
}

impl Serialize for KeyNeighborCandidate {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "key": self.key.to_string(),
            "distance_px": self.distance_px,
            "score": self.score,
        })
        .serialize(serializer)
    }
}

/// 5-point spatial key-slip calibration profile measuring directional finger drift & flight time.
#[derive(Clone, Debug, PartialEq)]
pub struct KeySlipProfile {
    /// Number of calibration samples included.
    pub sample_count: usize,
    /// Mean horizontal strike offset in pixels (`observed_x - expected_x`).
    pub mean_dx_px: f64,
    /// Mean vertical strike offset in pixels (`observed_y - expected_y`).
    pub mean_dy_px: f64,
    /// Mean inter-key flight time in milliseconds.
    pub mean_flight_ms: f64,
    /// Radial bias magnitude `hypot(mean_dx_px, mean_dy_px)` in pixels.
    pub radial_bias_px: f64,
}

impl KeySlipProfile {
    /// Calibrates a [`KeySlipProfile`] requiring at least 5 spatial calibration samples.
    pub fn from_5_point_calibration(
        samples: &[KeySlipSample],
    ) -> Result<Self, InputDiagnosticsError> {
        if samples.len() < MIN_KEY_SLIP_CALIBRATION_POINTS {
            return Err(InputDiagnosticsError::InsufficientSamples {
                context: "5-point key-slip calibration",
                required: MIN_KEY_SLIP_CALIBRATION_POINTS,
                actual: samples.len(),
            });
        }
        Self::from_samples(samples)
    }

    /// Calibrates a [`KeySlipProfile`] from one or more validated [`KeySlipSample`] measurements.
    pub fn from_samples(samples: &[KeySlipSample]) -> Result<Self, InputDiagnosticsError> {
        if samples.is_empty() {
            return Err(InputDiagnosticsError::InsufficientSamples {
                context: "key-slip calibration",
                required: 1,
                actual: 0,
            });
        }
        let mut sum_dx = 0.0;
        let mut sum_dy = 0.0;
        let mut sum_flight = 0.0;
        for sample in samples {
            if qwerty_key_position(sample.expected_key).is_none() {
                return Err(InputDiagnosticsError::UnknownQwertyKey {
                    key: sample.expected_key,
                });
            }
            ensure_finite(sample.dx_px, "dx_px")?;
            ensure_finite(sample.dy_px, "dy_px")?;
            ensure_non_negative_finite(sample.flight_ms, "flight_ms")?;
            sum_dx += sample.dx_px;
            sum_dy += sample.dy_px;
            sum_flight += sample.flight_ms;
        }
        let n = samples.len() as f64;
        let mean_dx_px = sum_dx / n;
        let mean_dy_px = sum_dy / n;
        let mean_flight_ms = sum_flight / n;
        Ok(Self {
            sample_count: samples.len(),
            mean_dx_px,
            mean_dy_px,
            mean_flight_ms,
            radial_bias_px: mean_dx_px.hypot(mean_dy_px),
        })
    }

    /// Ranks nearest distinct neighbor candidates on the QWERTY physical map after subtracting
    /// the calibrated spatial slip bias `(mean_dx_px, mean_dy_px)` from `observed_key`.
    pub fn rank_neighbor_candidates(
        &self,
        observed_key: char,
        limit: usize,
    ) -> Result<Vec<KeyNeighborCandidate>, InputDiagnosticsError> {
        self.rank_candidates_internal(observed_key, false, limit)
    }

    /// Ranks all candidate intended keys (including `observed_key`) by de-biased proximity.
    pub fn recover_intended_keys(
        &self,
        observed_key: char,
        limit: usize,
    ) -> Result<Vec<KeyNeighborCandidate>, InputDiagnosticsError> {
        self.rank_candidates_internal(observed_key, true, limit)
    }

    fn rank_candidates_internal(
        &self,
        observed_key: char,
        include_observed: bool,
        limit: usize,
    ) -> Result<Vec<KeyNeighborCandidate>, InputDiagnosticsError> {
        let obs_coord = qwerty_key_position(observed_key)
            .ok_or(InputDiagnosticsError::UnknownQwertyKey { key: observed_key })?;
        let intended_x = obs_coord.x_px - self.mean_dx_px;
        let intended_y = obs_coord.y_px - self.mean_dy_px;

        let mut ranked: Vec<KeyNeighborCandidate> = qwerty_key_map()
            .into_iter()
            .filter(|cand| include_observed || cand.key != obs_coord.key)
            .map(|cand| {
                let distance_px = (cand.x_px - intended_x).hypot(cand.y_px - intended_y);
                let score = (-distance_px * distance_px / (2.0 * KEY_PITCH_PX * KEY_PITCH_PX))
                    .exp()
                    .clamp(0.0, 1.0);
                KeyNeighborCandidate {
                    key: cand.key,
                    distance_px,
                    score,
                }
            })
            .collect();

        ranked.sort_by(|a, b| {
            a.distance_px
                .total_cmp(&b.distance_px)
                .then_with(|| a.key.cmp(&b.key))
        });
        if limit < ranked.len() {
            ranked.truncate(limit);
        }
        Ok(ranked)
    }
}

impl Serialize for KeySlipProfile {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "sample_count": self.sample_count,
            "mean_dx_px": self.mean_dx_px,
            "mean_dy_px": self.mean_dy_px,
            "mean_flight_ms": self.mean_flight_ms,
            "radial_bias_px": self.radial_bias_px,
        })
        .serialize(serializer)
    }
}

/// Key press/release telemetry sample used for NKRO and switch chatter calibration.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyEventSample {
    /// Key identifier (for example `"a"`, `"Space"`, `"KeyW"`).
    pub key: String,
    /// Monotonic event timestamp in milliseconds.
    pub timestamp_ms: f64,
    /// `true` on key-down, `false` on key-up.
    pub pressed: bool,
}

/// Switch chatter occurrence detected when two presses occur closer than `chatter_threshold_ms`.
#[derive(Clone, Debug, PartialEq)]
pub struct SwitchChatterEvent {
    /// Key exhibiting switch chatter.
    pub key: String,
    /// Measured inter-press duration in milliseconds.
    pub inter_press_ms: f64,
    /// Timestamp of the bounced press in milliseconds.
    pub timestamp_ms: f64,
}

impl Serialize for SwitchChatterEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "key": self.key,
            "inter_press_ms": self.inter_press_ms,
            "timestamp_ms": self.timestamp_ms,
        })
        .serialize(serializer)
    }
}

/// Input payload for pangram WPM and typing accuracy evaluation.
#[derive(Clone, Debug, PartialEq)]
pub struct PangramTestInput {
    /// Expected target pangram string.
    pub expected_text: String,
    /// Actual typed text captured from the user.
    pub typed_text: String,
    /// Total typing duration in milliseconds.
    pub duration_ms: f64,
}

/// Comprehensive keyboard calibration report covering NKRO, switch chatter, pangram WPM/accuracy,
/// and 5-point spatial key-slip calibration.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyboardCalibrationReport {
    /// Peak simultaneously depressed keys observed (N-Key Rollover).
    pub max_nkro_keys: usize,
    /// Total key-down press transitions analyzed.
    pub total_press_events: usize,
    /// Configured inter-press chatter threshold in milliseconds.
    pub chatter_threshold_ms: f64,
    /// Detected switch chatter bounces (`inter_press_ms < chatter_threshold_ms`).
    pub chatter_events: Vec<SwitchChatterEvent>,
    /// True if one or more switch chatter bounces occurred.
    pub chatter_detected: bool,
    /// Words per minute measured on the pangram drill (`(typed_chars / 5.0) / minutes`).
    pub pangram_wpm: Option<f64>,
    /// Character accuracy percentage (`0.0..=100.0`) measured against the pangram target.
    pub pangram_accuracy_pct: Option<f64>,
    /// Optional 5-point spatial key-slip bias profile.
    pub key_slip_profile: Option<KeySlipProfile>,
}

impl KeyboardCalibrationReport {
    /// Serializes this report into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for KeyboardCalibrationReport {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "max_nkro_keys": self.max_nkro_keys,
            "total_press_events": self.total_press_events,
            "chatter_threshold_ms": self.chatter_threshold_ms,
            "chatter_events": self.chatter_events,
            "chatter_detected": self.chatter_detected,
            "pangram_wpm": self.pangram_wpm,
            "pangram_accuracy_pct": self.pangram_accuracy_pct,
            "key_slip_profile": self.key_slip_profile,
        })
        .serialize(serializer)
    }
}

/// Evaluates keyboard NKRO peak rollover, switch chatter, pangram WPM/accuracy, and optional
/// 5-point spatial key-slip calibration.
pub fn evaluate_keyboard_calibration(
    events: &[KeyEventSample],
    chatter_threshold_ms: f64,
    pangram: Option<&PangramTestInput>,
    slip_samples: Option<&[KeySlipSample]>,
) -> Result<KeyboardCalibrationReport, InputDiagnosticsError> {
    if !chatter_threshold_ms.is_finite() || chatter_threshold_ms <= 0.0 {
        return Err(InputDiagnosticsError::InvalidParameter {
            field: "chatter_threshold_ms",
            detail: "must be finite and > 0".to_string(),
        });
    }

    let mut held_keys: BTreeSet<String> = BTreeSet::new();
    let mut last_press_ms: BTreeMap<String, f64> = BTreeMap::new();
    let mut max_nkro_keys = 0usize;
    let mut total_press_events = 0usize;
    let mut chatter_events = Vec::new();
    let mut prev_ts: Option<f64> = None;

    for (idx, event) in events.iter().enumerate() {
        ensure_non_negative_finite(event.timestamp_ms, "timestamp_ms")?;
        if let Some(prev) = prev_ts {
            if event.timestamp_ms < prev {
                return Err(InputDiagnosticsError::InvalidParameter {
                    field: "events",
                    detail: format!(
                        "non-monotonic event timestamp at index {idx}: {prev} -> {}",
                        event.timestamp_ms
                    ),
                });
            }
        }
        prev_ts = Some(event.timestamp_ms);

        let key_norm = event.key.trim().to_string();
        if key_norm.is_empty() {
            return Err(InputDiagnosticsError::InvalidParameter {
                field: "key",
                detail: format!("blank key identifier at index {idx}"),
            });
        }

        if event.pressed {
            total_press_events += 1;
            if let Some(prev_press) = last_press_ms.get(&key_norm).copied() {
                let inter_press_ms = event.timestamp_ms - prev_press;
                if inter_press_ms < chatter_threshold_ms {
                    chatter_events.push(SwitchChatterEvent {
                        key: key_norm.clone(),
                        inter_press_ms,
                        timestamp_ms: event.timestamp_ms,
                    });
                }
            }
            last_press_ms.insert(key_norm.clone(), event.timestamp_ms);
            held_keys.insert(key_norm);
            max_nkro_keys = max_nkro_keys.max(held_keys.len());
        } else {
            held_keys.remove(&key_norm);
        }
    }

    let (pangram_wpm, pangram_accuracy_pct) = match pangram {
        Some(pg) => {
            if pg.expected_text.is_empty() {
                return Err(InputDiagnosticsError::InvalidParameter {
                    field: "pangram.expected_text",
                    detail: "must not be empty".to_string(),
                });
            }
            if !pg.duration_ms.is_finite() || pg.duration_ms <= 0.0 {
                return Err(InputDiagnosticsError::InvalidParameter {
                    field: "pangram.duration_ms",
                    detail: "must be finite and > 0".to_string(),
                });
            }
            let typed_chars = pg.typed_text.chars().count() as f64;
            let expected_chars = pg.expected_text.chars().count();
            let minutes = pg.duration_ms / 60_000.0;
            let wpm = (typed_chars / 5.0) / minutes;
            let dist = levenshtein_chars(&pg.expected_text, &pg.typed_text);
            let denom = expected_chars.max(pg.typed_text.chars().count()).max(1) as f64;
            let accuracy = (((denom - dist as f64) / denom) * 100.0).clamp(0.0, 100.0);
            (Some(wpm), Some(accuracy))
        }
        None => (None, None),
    };

    let key_slip_profile = match slip_samples {
        Some(samples) => Some(KeySlipProfile::from_5_point_calibration(samples)?),
        None => None,
    };

    let chatter_detected = !chatter_events.is_empty();
    Ok(KeyboardCalibrationReport {
        max_nkro_keys,
        total_press_events,
        chatter_threshold_ms,
        chatter_events,
        chatter_detected,
        pangram_wpm,
        pangram_accuracy_pct,
        key_slip_profile,
    })
}

/// Mouse polling rate, jitter, drop detection, and nominal tier classification report.
#[derive(Clone, Debug, PartialEq)]
pub struct MousePollingReport {
    /// Number of input timestamps evaluated.
    pub sample_count: usize,
    /// Number of consecutive intervals (`sample_count - 1`).
    pub interval_count: usize,
    /// Mean observed polling frequency in Hz.
    pub mean_hz: f64,
    /// Mean inter-report interval in milliseconds.
    pub mean_interval_ms: f64,
    /// 95th percentile absolute interval deviation from mean in milliseconds.
    pub p95_jitter_ms: f64,
    /// Population standard deviation of inter-report intervals in milliseconds.
    pub std_dev_ms: f64,
    /// Intervals whose duration exceeded `1.5 * nominal_interval_ms`.
    pub dropped_intervals: usize,
    /// Estimated total missed USB/HID polling frames across dropped intervals.
    pub estimated_missed_polls: usize,
    /// Nearest standard mouse polling tier (`125/250/500/1000/2000/4000/8000 Hz`).
    pub nearest_nominal_tier_hz: u32,
}

impl MousePollingReport {
    /// Serializes this polling report into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for MousePollingReport {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "sample_count": self.sample_count,
            "interval_count": self.interval_count,
            "mean_hz": self.mean_hz,
            "mean_interval_ms": self.mean_interval_ms,
            "p95_jitter_ms": self.p95_jitter_ms,
            "std_dev_ms": self.std_dev_ms,
            "dropped_intervals": self.dropped_intervals,
            "estimated_missed_polls": self.estimated_missed_polls,
            "nearest_nominal_tier_hz": self.nearest_nominal_tier_hz,
        })
        .serialize(serializer)
    }
}

/// Analyzes mouse report timestamps (in microseconds) for polling rate, jitter, drops, and tier.
pub fn analyze_mouse_polling(
    timestamps_us: &[u64],
) -> Result<MousePollingReport, InputDiagnosticsError> {
    if timestamps_us.len() < 2 {
        return Err(InputDiagnosticsError::InsufficientSamples {
            context: "mouse polling analysis",
            required: 2,
            actual: timestamps_us.len(),
        });
    }

    let mut intervals_ms = Vec::with_capacity(timestamps_us.len() - 1);
    for (idx, pair) in timestamps_us.windows(2).enumerate() {
        let prev = pair[0];
        let next = pair[1];
        if next <= prev {
            return Err(InputDiagnosticsError::NonMonotonicTimestamps {
                index: idx + 1,
                prev_us: prev,
                next_us: next,
            });
        }
        intervals_ms.push((next - prev) as f64 / 1_000.0);
    }

    let interval_count = intervals_ms.len();
    let mean_interval_ms = intervals_ms.iter().sum::<f64>() / interval_count as f64;
    let mean_hz = 1_000.0 / mean_interval_ms;

    let mut sorted_intervals = intervals_ms.clone();
    sorted_intervals.sort_by(f64::total_cmp);
    let median_interval_ms = if interval_count % 2 == 1 {
        sorted_intervals[interval_count / 2]
    } else {
        0.5 * (sorted_intervals[interval_count / 2 - 1] + sorted_intervals[interval_count / 2])
    };
    let median_hz = 1_000.0 / median_interval_ms;

    // Classify nearest nominal polling tier from median cadence so occasional drops do not skew tier.
    let nearest_nominal_tier_hz = NOMINAL_MOUSE_POLLING_TIERS_HZ
        .iter()
        .copied()
        .min_by(|a, b| {
            let da = (*a as f64 - median_hz).abs();
            let db = (*b as f64 - median_hz).abs();
            da.total_cmp(&db)
        })
        .unwrap_or(1000);
    let nominal_interval_ms = 1_000.0 / (nearest_nominal_tier_hz as f64);

    let variance = intervals_ms
        .iter()
        .map(|dt| {
            let diff = dt - mean_interval_ms;
            diff * diff
        })
        .sum::<f64>()
        / interval_count as f64;
    let std_dev_ms = variance.sqrt();

    let mut jitters: Vec<f64> = intervals_ms
        .iter()
        .map(|dt| (dt - mean_interval_ms).abs())
        .collect();
    jitters.sort_by(f64::total_cmp);
    let p95_idx = ((0.95 * interval_count as f64).ceil() as usize)
        .saturating_sub(1)
        .min(interval_count - 1);
    let p95_jitter_ms = jitters[p95_idx];

    let mut dropped_intervals = 0usize;
    let mut estimated_missed_polls = 0usize;
    for dt in &intervals_ms {
        if *dt > 1.5 * nominal_interval_ms {
            dropped_intervals += 1;
            let ratio_rounded = (*dt / nominal_interval_ms).round().max(2.0) as usize;
            estimated_missed_polls += ratio_rounded.saturating_sub(1);
        }
    }

    Ok(MousePollingReport {
        sample_count: timestamps_us.len(),
        interval_count,
        mean_hz,
        mean_interval_ms,
        p95_jitter_ms,
        std_dev_ms,
        dropped_intervals,
        estimated_missed_polls,
        nearest_nominal_tier_hz,
    })
}

/// Mouse microswitch chatter / faulty double-click detection report.
#[derive(Clone, Debug, PartialEq)]
pub struct MouseChatterReport {
    /// Number of inter-click deltas analyzed.
    pub sample_count: usize,
    /// Chatter detection threshold in milliseconds.
    pub threshold_ms: f64,
    /// Number of intervals strictly below `threshold_ms`.
    pub chatter_count: usize,
    /// Zero-based indices of click deltas flagged as switch chatter.
    pub chatter_indices: Vec<usize>,
    /// Minimum observed click interval in milliseconds.
    pub min_delta_ms: Option<f64>,
    /// True when one or more bounce intervals were detected.
    pub faulty_switch: bool,
}

impl MouseChatterReport {
    /// Serializes this report into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for MouseChatterReport {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "sample_count": self.sample_count,
            "threshold_ms": self.threshold_ms,
            "chatter_count": self.chatter_count,
            "chatter_indices": self.chatter_indices,
            "min_delta_ms": self.min_delta_ms,
            "faulty_switch": self.faulty_switch,
        })
        .serialize(serializer)
    }
}

/// Detects faulty microswitch bounce intervals where `delta_ms < threshold_ms`.
pub fn detect_mouse_chatter(
    click_deltas_ms: &[f64],
    threshold_ms: f64,
) -> Result<MouseChatterReport, InputDiagnosticsError> {
    if !threshold_ms.is_finite() || threshold_ms <= 0.0 {
        return Err(InputDiagnosticsError::InvalidParameter {
            field: "threshold_ms",
            detail: "must be finite and > 0".to_string(),
        });
    }
    if click_deltas_ms.is_empty() {
        return Err(InputDiagnosticsError::InsufficientSamples {
            context: "mouse chatter detection",
            required: 1,
            actual: 0,
        });
    }

    let mut chatter_indices = Vec::new();
    let mut min_delta_ms: Option<f64> = None;

    for (idx, &delta) in click_deltas_ms.iter().enumerate() {
        ensure_non_negative_finite(delta, "click_deltas_ms")?;
        min_delta_ms = Some(match min_delta_ms {
            Some(prev) => prev.min(delta),
            None => delta,
        });
        if delta < threshold_ms {
            chatter_indices.push(idx);
        }
    }

    let chatter_count = chatter_indices.len();
    Ok(MouseChatterReport {
        sample_count: click_deltas_ms.len(),
        threshold_ms,
        chatter_count,
        chatter_indices,
        min_delta_ms,
        faulty_switch: chatter_count > 0,
    })
}

/// 2D screen-space pointer sample (`+x` Right, `+y` Down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrokePoint {
    pub x: f64,
    pub y: f64,
}

impl From<(f64, f64)> for StrokePoint {
    fn from(value: (f64, f64)) -> Self {
        Self {
            x: value.0,
            y: value.1,
        }
    }
}

impl Serialize for StrokePoint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({ "x": self.x, "y": self.y }).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StrokePoint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        let obj = val
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("StrokePoint must be a JSON object"))?;
        let x = obj
            .get("x")
            .and_then(Value::as_f64)
            .ok_or_else(|| serde::de::Error::custom("missing finite f64 x"))?;
        let y = obj
            .get("y")
            .and_then(Value::as_f64)
            .ok_or_else(|| serde::de::Error::custom("missing finite f64 y"))?;
        Ok(Self { x, y })
    }
}

/// Cardinal stroke direction in screen coordinates (`+x` = Right, `+y` = Down).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StrokeDirection {
    Left,
    Right,
    Up,
    Down,
}

impl StrokeDirection {
    /// Returns the single-letter stroke token (`"L"`, `"R"`, `"U"`, `"D"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Left => "L",
            Self::Right => "R",
            Self::Up => "U",
            Self::Down => "D",
        }
    }
}

impl Serialize for StrokeDirection {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Recognized deterministic mouse stroke gesture pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MouseStrokePattern {
    Left,
    Right,
    Up,
    Down,
    LeftUp,
    LeftDown,
    RightUp,
    RightDown,
    UpRight,
    DownRight,
    UpLeft,
    DownLeft,
    Sequence(String),
}

impl MouseStrokePattern {
    /// Returns the canonical arrow-joined direction label (for example `"L->U"`).
    pub fn as_str(&self) -> &str {
        match self {
            Self::Left => "L",
            Self::Right => "R",
            Self::Up => "U",
            Self::Down => "D",
            Self::LeftUp => "L->U",
            Self::LeftDown => "L->D",
            Self::RightUp => "R->U",
            Self::RightDown => "R->D",
            Self::UpRight => "U->R",
            Self::DownRight => "D->R",
            Self::UpLeft => "U->L",
            Self::DownLeft => "D->L",
            Self::Sequence(s) => s.as_str(),
        }
    }

    fn from_directions(dirs: &[StrokeDirection]) -> Self {
        match dirs {
            [StrokeDirection::Left] => Self::Left,
            [StrokeDirection::Right] => Self::Right,
            [StrokeDirection::Up] => Self::Up,
            [StrokeDirection::Down] => Self::Down,
            [StrokeDirection::Left, StrokeDirection::Up] => Self::LeftUp,
            [StrokeDirection::Left, StrokeDirection::Down] => Self::LeftDown,
            [StrokeDirection::Right, StrokeDirection::Up] => Self::RightUp,
            [StrokeDirection::Right, StrokeDirection::Down] => Self::RightDown,
            [StrokeDirection::Up, StrokeDirection::Right] => Self::UpRight,
            [StrokeDirection::Down, StrokeDirection::Right] => Self::DownRight,
            [StrokeDirection::Up, StrokeDirection::Left] => Self::UpLeft,
            [StrokeDirection::Down, StrokeDirection::Left] => Self::DownLeft,
            other => {
                let joined: Vec<&'static str> = other.iter().map(|d| d.as_str()).collect();
                Self::Sequence(joined.join("->"))
            }
        }
    }
}

/// Deterministic mouse stroke classification output.
#[derive(Clone, Debug, PartialEq)]
pub struct MouseStrokeClassification {
    /// Simplified direction sequence (`L`, `R`, `U`, `D`, `L->U`, etc.).
    pub directions: Vec<StrokeDirection>,
    /// Canonical sequence label (`"L"`, `"R"`, `"L->U"`, etc.).
    pub sequence_label: String,
    /// Typed gesture pattern classification.
    pub pattern: MouseStrokePattern,
    /// Total path length in pixels.
    pub total_length_px: f64,
    /// Net horizontal displacement (`last.x - first.x`).
    pub net_dx_px: f64,
    /// Net vertical displacement (`last.y - first.y`).
    pub net_dy_px: f64,
}

impl MouseStrokeClassification {
    /// Serializes this classification into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!({
            "directions": self.directions,
            "sequence_label": self.sequence_label,
            "total_length_px": self.total_length_px,
            "net_dx_px": self.net_dx_px,
            "net_dy_px": self.net_dy_px,
        })
    }
}

/// Classifies a sequence of screen-space pointer coordinates (`+x` Right, `+y` Down) into a
/// deterministic cardinal direction sequence (`L`, `R`, `U`, `D`, `L->U`, `L->D`, `R->U`,
/// `R->D`, `U->R`, `D->R`, etc.).
pub fn classify_mouse_stroke<P: Copy + Into<StrokePoint>>(
    points: &[P],
) -> Result<MouseStrokeClassification, InputDiagnosticsError> {
    if points.len() < 2 {
        return Err(InputDiagnosticsError::InsufficientSamples {
            context: "mouse stroke classification",
            required: 2,
            actual: points.len(),
        });
    }

    let pts: Vec<StrokePoint> = points.iter().copied().map(Into::into).collect();
    for p in &pts {
        ensure_finite(p.x, "point.x")?;
        ensure_finite(p.y, "point.y")?;
    }

    let mut total_length_px = 0.0;
    for pair in pts.windows(2) {
        total_length_px += (pair[1].x - pair[0].x).hypot(pair[1].y - pair[0].y);
    }
    if total_length_px < 4.0 {
        return Err(InputDiagnosticsError::InvalidStrokePoints {
            detail: format!("stroke path length {total_length_px:.2}px is below 4.0px minimum"),
        });
    }

    let epsilon = (total_length_px * 0.05).clamp(1.5, 4.0);
    let simplified = rdp_simplify(&pts, epsilon);

    let min_seg_len = (total_length_px * 0.08).clamp(3.0, 8.0);
    let mut directions: Vec<StrokeDirection> = Vec::new();
    for pair in simplified.windows(2) {
        let dx = pair[1].x - pair[0].x;
        let dy = pair[1].y - pair[0].y;
        let len = dx.hypot(dy);
        if len < min_seg_len && simplified.len() > 2 {
            continue;
        }
        let dir = quantize_cardinal(dx, dy);
        if directions.last() != Some(&dir) {
            directions.push(dir);
        }
    }

    if directions.is_empty() {
        let net_dx = pts.last().expect("non-empty").x - pts[0].x;
        let net_dy = pts.last().expect("non-empty").y - pts[0].y;
        if net_dx.hypot(net_dy) < 1e-6 {
            return Err(InputDiagnosticsError::InvalidStrokePoints {
                detail: "stroke segments collapsed to zero net motion".to_string(),
            });
        }
        directions.push(quantize_cardinal(net_dx, net_dy));
    }

    let pattern = MouseStrokePattern::from_directions(&directions);
    let sequence_label = pattern.as_str().to_string();
    let first = pts[0];
    let last = pts[pts.len() - 1];

    Ok(MouseStrokeClassification {
        directions,
        sequence_label,
        pattern,
        total_length_px,
        net_dx_px: last.x - first.x,
        net_dy_px: last.y - first.y,
    })
}

/// Customizable Precision Touchpad side-edge scroll strip and palm-rejection configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchpadEdgeScrollConfig {
    /// Physical touchpad active surface width in millimeters.
    pub width_mm: f64,
    /// Physical touchpad active surface height in millimeters.
    pub height_mm: f64,
    /// Width of the left-edge vertical scroll strip in millimeters (`0.0` disables).
    pub left_edge_strip_mm: f64,
    /// Width of the right-edge vertical scroll strip in millimeters (`0.0` disables).
    pub right_edge_strip_mm: f64,
    /// Movement jitter deadzone threshold in millimeters.
    pub deadzone_mm: f64,
    /// Smooth scroll delta multiplier applied to edge and two-finger scroll movement.
    pub scroll_gain: f64,
    /// When `true`, active side-edge scrolling locks pointer delta (`cursor_dx = 0.0, cursor_dy = 0.0`).
    pub cursor_lock: bool,
    /// Maximum finger contact major diameter in millimeters before rejecting as palm.
    pub palm_max_contact_mm: f64,
}

impl Default for TouchpadEdgeScrollConfig {
    fn default() -> Self {
        Self {
            width_mm: 120.0,
            height_mm: 75.0,
            left_edge_strip_mm: 8.0,
            right_edge_strip_mm: 8.0,
            deadzone_mm: 0.5,
            scroll_gain: 1.0,
            cursor_lock: true,
            palm_max_contact_mm: 14.0,
        }
    }
}

impl TouchpadEdgeScrollConfig {
    /// Validates physical geometry, strip widths, deadzone, scroll gain, and palm bounds.
    pub fn validate(&self) -> Result<(), InputDiagnosticsError> {
        ensure_positive_finite(self.width_mm, "width_mm")?;
        ensure_positive_finite(self.height_mm, "height_mm")?;
        ensure_non_negative_finite(self.left_edge_strip_mm, "left_edge_strip_mm")?;
        ensure_non_negative_finite(self.right_edge_strip_mm, "right_edge_strip_mm")?;
        ensure_non_negative_finite(self.deadzone_mm, "deadzone_mm")?;
        ensure_finite(self.scroll_gain, "scroll_gain")?;
        if self.scroll_gain <= 0.0 {
            return Err(InputDiagnosticsError::InvalidTouchpadConfig {
                detail: "scroll_gain must be > 0".to_string(),
            });
        }
        ensure_positive_finite(self.palm_max_contact_mm, "palm_max_contact_mm")?;
        if self.left_edge_strip_mm + self.right_edge_strip_mm >= self.width_mm {
            return Err(InputDiagnosticsError::InvalidTouchpadConfig {
                detail: format!(
                    "left_edge_strip_mm ({}) + right_edge_strip_mm ({}) must leave an interior zone < width_mm ({})",
                    self.left_edge_strip_mm, self.right_edge_strip_mm, self.width_mm
                ),
            });
        }
        Ok(())
    }
}

impl Serialize for TouchpadEdgeScrollConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "width_mm": self.width_mm,
            "height_mm": self.height_mm,
            "left_edge_strip_mm": self.left_edge_strip_mm,
            "right_edge_strip_mm": self.right_edge_strip_mm,
            "deadzone_mm": self.deadzone_mm,
            "scroll_gain": self.scroll_gain,
            "cursor_lock": self.cursor_lock,
            "palm_max_contact_mm": self.palm_max_contact_mm,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for TouchpadEdgeScrollConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        let obj = val.as_object().ok_or_else(|| {
            serde::de::Error::custom("TouchpadEdgeScrollConfig must be a JSON object")
        })?;
        let req_f64 = |k: &str| -> Result<f64, D::Error> {
            obj.get(k)
                .and_then(Value::as_f64)
                .ok_or_else(|| serde::de::Error::custom(format!("missing f64 field `{k}`")))
        };
        let cursor_lock = obj
            .get("cursor_lock")
            .and_then(Value::as_bool)
            .ok_or_else(|| serde::de::Error::custom("missing bool field `cursor_lock`"))?;
        let cfg = Self {
            width_mm: req_f64("width_mm")?,
            height_mm: req_f64("height_mm")?,
            left_edge_strip_mm: req_f64("left_edge_strip_mm")?,
            right_edge_strip_mm: req_f64("right_edge_strip_mm")?,
            deadzone_mm: req_f64("deadzone_mm")?,
            scroll_gain: req_f64("scroll_gain")?,
            cursor_lock,
            palm_max_contact_mm: req_f64("palm_max_contact_mm")?,
        };
        cfg.validate().map_err(serde::de::Error::custom)?;
        Ok(cfg)
    }
}

/// Single Precision Touchpad finger/palm contact frame sample.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchpadContact {
    /// Stable contact tracking ID.
    pub contact_id: u32,
    /// Horizontal contact center on touchpad surface in millimeters (`0.0..=width_mm`).
    pub x_mm: f64,
    /// Vertical contact center on touchpad surface in millimeters (`0.0..=height_mm`).
    pub y_mm: f64,
    /// Horizontal displacement since previous frame in millimeters.
    pub dx_mm: f64,
    /// Vertical displacement since previous frame in millimeters.
    pub dy_mm: f64,
    /// Contact major ellipse diameter in millimeters (used for palm rejection).
    pub contact_major_mm: f64,
}

/// Active touchpad side-edge scroll strip side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeStripSide {
    Left,
    Right,
}

impl EdgeStripSide {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

impl Serialize for EdgeStripSide {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Classified Precision Touchpad contact frame action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchpadAction {
    Idle,
    PalmRejectedOnly,
    EdgeScroll,
    CursorMove,
    TwoFingerScroll,
    TwoFingerPinchZoom,
    ThreeFingerSwipeLeft,
    ThreeFingerSwipeRight,
    ThreeFingerSwipeUp,
    ThreeFingerSwipeDown,
    ThreeFingerTapOrHold,
    MultiFingerGesture,
}

impl TouchpadAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::PalmRejectedOnly => "palm_rejected_only",
            Self::EdgeScroll => "edge_scroll",
            Self::CursorMove => "cursor_move",
            Self::TwoFingerScroll => "two_finger_scroll",
            Self::TwoFingerPinchZoom => "two_finger_pinch_zoom",
            Self::ThreeFingerSwipeLeft => "three_finger_swipe_left",
            Self::ThreeFingerSwipeRight => "three_finger_swipe_right",
            Self::ThreeFingerSwipeUp => "three_finger_swipe_up",
            Self::ThreeFingerSwipeDown => "three_finger_swipe_down",
            Self::ThreeFingerTapOrHold => "three_finger_tap_or_hold",
            Self::MultiFingerGesture => "multi_finger_gesture",
        }
    }
}

impl Serialize for TouchpadAction {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Evaluated touchpad cursor, edge-scroll, pinch-zoom, and palm-rejection outcome.
#[derive(Clone, Debug, PartialEq)]
pub struct TouchpadEvaluation {
    /// Classified frame gesture/action.
    pub action: TouchpadAction,
    /// Side-edge strip engaged when `action == TouchpadAction::EdgeScroll`.
    pub active_edge_strip: Option<EdgeStripSide>,
    /// Contact IDs admitted after palm rejection.
    pub active_contact_ids: Vec<u32>,
    /// Contact IDs rejected as palms (`contact_major_mm > palm_max_contact_mm`).
    pub rejected_palm_ids: Vec<u32>,
    /// Output horizontal pointer delta (`0.0` when `cursor_locked == true`).
    pub cursor_dx: f64,
    /// Output vertical pointer delta (`0.0` when `cursor_locked == true`).
    pub cursor_dy: f64,
    /// Output horizontal smooth scroll delta.
    pub scroll_dx: f64,
    /// Output vertical smooth scroll delta.
    pub scroll_dy: f64,
    /// Instantaneous pinch zoom ratio (`1.0` when neutral).
    pub pinch_scale: f64,
    /// Change in inter-finger separation in millimeters during two-finger evaluation.
    pub pinch_delta_mm: f64,
    /// Whether pointer movement was suppressed by side-edge `cursor_lock` or multi-touch mode.
    pub cursor_locked: bool,
}

impl TouchpadEvaluation {
    /// Serializes this evaluation into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for TouchpadEvaluation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "action": self.action,
            "active_edge_strip": self.active_edge_strip,
            "active_contact_ids": self.active_contact_ids,
            "rejected_palm_ids": self.rejected_palm_ids,
            "cursor_dx": self.cursor_dx,
            "cursor_dy": self.cursor_dy,
            "scroll_dx": self.scroll_dx,
            "scroll_dy": self.scroll_dy,
            "pinch_scale": self.pinch_scale,
            "pinch_delta_mm": self.pinch_delta_mm,
            "cursor_locked": self.cursor_locked,
        })
        .serialize(serializer)
    }
}

/// Evaluates Precision Touchpad contacts against side-edge scroll strip, pointer lock,
/// deadzone, palm rejection, and 1/2/3-finger gesture rules.
pub fn evaluate_touchpad_contacts(
    config: &TouchpadEdgeScrollConfig,
    contacts: &[TouchpadContact],
) -> Result<TouchpadEvaluation, InputDiagnosticsError> {
    config.validate()?;

    let mut active_contacts = Vec::new();
    let mut active_contact_ids = Vec::new();
    let mut rejected_palm_ids = Vec::new();

    for c in contacts {
        if !c.x_mm.is_finite()
            || !c.y_mm.is_finite()
            || !c.dx_mm.is_finite()
            || !c.dy_mm.is_finite()
            || !c.contact_major_mm.is_finite()
        {
            return Err(InputDiagnosticsError::NonFiniteMetric {
                field: "touchpad_contact",
            });
        }
        if c.x_mm < 0.0 || c.x_mm > config.width_mm || c.y_mm < 0.0 || c.y_mm > config.height_mm {
            return Err(InputDiagnosticsError::InvalidTouchpadContact {
                detail: format!(
                    "contact {} at ({}, {}) outside {}x{}mm bounds",
                    c.contact_id, c.x_mm, c.y_mm, config.width_mm, config.height_mm
                ),
            });
        }
        if c.contact_major_mm < 0.0 {
            return Err(InputDiagnosticsError::InvalidTouchpadContact {
                detail: format!(
                    "contact {} has negative diameter {}",
                    c.contact_id, c.contact_major_mm
                ),
            });
        }
        if c.contact_major_mm > config.palm_max_contact_mm {
            rejected_palm_ids.push(c.contact_id);
        } else {
            active_contact_ids.push(c.contact_id);
            active_contacts.push(*c);
        }
    }

    if active_contacts.is_empty() {
        let has_rejected_palms = !rejected_palm_ids.is_empty();
        let action = if !has_rejected_palms {
            TouchpadAction::Idle
        } else {
            TouchpadAction::PalmRejectedOnly
        };
        return Ok(TouchpadEvaluation {
            action,
            active_edge_strip: None,
            active_contact_ids,
            rejected_palm_ids,
            cursor_dx: 0.0,
            cursor_dy: 0.0,
            scroll_dx: 0.0,
            scroll_dy: 0.0,
            pinch_scale: 1.0,
            pinch_delta_mm: 0.0,
            cursor_locked: has_rejected_palms,
        });
    }

    if active_contacts.len() == 1 {
        let c = active_contacts[0];
        let in_left = config.left_edge_strip_mm > 0.0 && c.x_mm <= config.left_edge_strip_mm;
        let in_right = config.right_edge_strip_mm > 0.0
            && c.x_mm >= (config.width_mm - config.right_edge_strip_mm);

        if in_left || in_right {
            let side = if in_left {
                EdgeStripSide::Left
            } else {
                EdgeStripSide::Right
            };
            let eff_dy = apply_scalar_deadzone(c.dy_mm, config.deadzone_mm);
            let scroll_dy = eff_dy * config.scroll_gain;
            let (cursor_dx, cursor_dy) = if config.cursor_lock {
                (0.0, 0.0)
            } else {
                (apply_scalar_deadzone(c.dx_mm, config.deadzone_mm), eff_dy)
            };
            return Ok(TouchpadEvaluation {
                action: TouchpadAction::EdgeScroll,
                active_edge_strip: Some(side),
                active_contact_ids,
                rejected_palm_ids,
                cursor_dx,
                cursor_dy,
                scroll_dx: 0.0,
                scroll_dy,
                pinch_scale: 1.0,
                pinch_delta_mm: 0.0,
                cursor_locked: config.cursor_lock,
            });
        }

        let (cursor_dx, cursor_dy) = apply_vector_deadzone(c.dx_mm, c.dy_mm, config.deadzone_mm);
        let action = if cursor_dx == 0.0 && cursor_dy == 0.0 {
            TouchpadAction::Idle
        } else {
            TouchpadAction::CursorMove
        };
        return Ok(TouchpadEvaluation {
            action,
            active_edge_strip: None,
            active_contact_ids,
            rejected_palm_ids,
            cursor_dx,
            cursor_dy,
            scroll_dx: 0.0,
            scroll_dy: 0.0,
            pinch_scale: 1.0,
            pinch_delta_mm: 0.0,
            cursor_locked: false,
        });
    }

    if active_contacts.len() == 2 {
        let c0 = active_contacts[0];
        let c1 = active_contacts[1];
        let mean_dx = 0.5 * (c0.dx_mm + c1.dx_mm);
        let mean_dy = 0.5 * (c0.dy_mm + c1.dy_mm);

        let prev_dx = (c1.x_mm - c1.dx_mm) - (c0.x_mm - c0.dx_mm);
        let prev_dy = (c1.y_mm - c1.dy_mm) - (c0.y_mm - c0.dy_mm);
        let prev_dist = prev_dx.hypot(prev_dy);
        let curr_dist = (c1.x_mm - c0.x_mm).hypot(c1.y_mm - c0.y_mm);
        let pinch_delta_mm = curr_dist - prev_dist;
        let pinch_scale = if prev_dist > 1e-6 {
            curr_dist / prev_dist
        } else {
            1.0
        };

        let mean_mag = mean_dx.hypot(mean_dy);
        if pinch_delta_mm.abs() > config.deadzone_mm && pinch_delta_mm.abs() >= mean_mag {
            return Ok(TouchpadEvaluation {
                action: TouchpadAction::TwoFingerPinchZoom,
                active_edge_strip: None,
                active_contact_ids,
                rejected_palm_ids,
                cursor_dx: 0.0,
                cursor_dy: 0.0,
                scroll_dx: 0.0,
                scroll_dy: 0.0,
                pinch_scale,
                pinch_delta_mm,
                cursor_locked: true,
            });
        }

        let (eff_dx, eff_dy) = apply_vector_deadzone(mean_dx, mean_dy, config.deadzone_mm);
        return Ok(TouchpadEvaluation {
            action: TouchpadAction::TwoFingerScroll,
            active_edge_strip: None,
            active_contact_ids,
            rejected_palm_ids,
            cursor_dx: 0.0,
            cursor_dy: 0.0,
            scroll_dx: eff_dx * config.scroll_gain,
            scroll_dy: eff_dy * config.scroll_gain,
            pinch_scale,
            pinch_delta_mm,
            cursor_locked: true,
        });
    }

    if active_contacts.len() == 3 {
        let mean_dx = active_contacts.iter().map(|c| c.dx_mm).sum::<f64>() / 3.0;
        let mean_dy = active_contacts.iter().map(|c| c.dy_mm).sum::<f64>() / 3.0;
        let action = if mean_dx.abs() <= config.deadzone_mm && mean_dy.abs() <= config.deadzone_mm {
            TouchpadAction::ThreeFingerTapOrHold
        } else if mean_dx.abs() >= mean_dy.abs() {
            if mean_dx >= 0.0 {
                TouchpadAction::ThreeFingerSwipeRight
            } else {
                TouchpadAction::ThreeFingerSwipeLeft
            }
        } else if mean_dy >= 0.0 {
            TouchpadAction::ThreeFingerSwipeDown
        } else {
            TouchpadAction::ThreeFingerSwipeUp
        };
        return Ok(TouchpadEvaluation {
            action,
            active_edge_strip: None,
            active_contact_ids,
            rejected_palm_ids,
            cursor_dx: 0.0,
            cursor_dy: 0.0,
            scroll_dx: 0.0,
            scroll_dy: 0.0,
            pinch_scale: 1.0,
            pinch_delta_mm: 0.0,
            cursor_locked: true,
        });
    }

    Ok(TouchpadEvaluation {
        action: TouchpadAction::MultiFingerGesture,
        active_edge_strip: None,
        active_contact_ids,
        rejected_palm_ids,
        cursor_dx: 0.0,
        cursor_dy: 0.0,
        scroll_dx: 0.0,
        scroll_dy: 0.0,
        pinch_scale: 1.0,
        pinch_delta_mm: 0.0,
        cursor_locked: true,
    })
}

/// Windows Pen/Stylus input sample for pressure curve and tilt telemetry validation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StylusSample {
    /// Normalized tip/eraser pressure (`0.0..=1.0`).
    pub pressure: f64,
    /// X-axis tilt in degrees (`-90.0..=90.0`).
    pub tilt_x_deg: f64,
    /// Y-axis tilt in degrees (`-90.0..=90.0`).
    pub tilt_y_deg: f64,
    /// Whether barrel side button is depressed.
    pub barrel_button: bool,
    /// Whether inverted eraser tip is active.
    pub eraser_tip: bool,
    /// Whether stylus is in digitizer hover/sensing range.
    pub in_range: bool,
    /// Whether pen tip is physically contacting the digitizer surface.
    pub contact_active: bool,
}

/// Evaluated stylus stroke engagement state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StylusStrokeState {
    OutOfRange,
    Hover,
    EraserActive,
    LightStroke,
    MediumStroke,
    HeavyStroke,
}

impl StylusStrokeState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OutOfRange => "out_of_range",
            Self::Hover => "hover",
            Self::EraserActive => "eraser_active",
            Self::LightStroke => "light_stroke",
            Self::MediumStroke => "medium_stroke",
            Self::HeavyStroke => "heavy_stroke",
        }
    }
}

impl Serialize for StylusStrokeState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// Evaluated stylus pressure, combined tilt angle, azimuth, and stroke state.
#[derive(Clone, Debug, PartialEq)]
pub struct StylusEvaluation {
    /// Active engagement state (`Hover`, `LightStroke`, `MediumStroke`, `HeavyStroke`, `EraserActive`).
    pub state: StylusStrokeState,
    /// Validated normalized pressure (`0.0..=1.0`).
    pub normalized_pressure: f64,
    /// Combined Euclidean tilt magnitude in degrees (`0.0..=90.0`).
    pub combined_tilt_deg: f64,
    /// Tilt azimuth angle in degrees (`-180.0..=180.0`).
    pub tilt_azimuth_deg: f64,
    /// True when tip is in contact with positive pressure.
    pub is_contact_stroke: bool,
    /// Barrel button state echoed from sample.
    pub barrel_button: bool,
}

impl StylusEvaluation {
    /// Serializes this evaluation into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for StylusEvaluation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "state": self.state,
            "normalized_pressure": self.normalized_pressure,
            "combined_tilt_deg": self.combined_tilt_deg,
            "tilt_azimuth_deg": self.tilt_azimuth_deg,
            "is_contact_stroke": self.is_contact_stroke,
            "barrel_button": self.barrel_button,
        })
        .serialize(serializer)
    }
}

/// Validates and evaluates a stylus digitizer sample (`pressure` in `0..=1`, tilt in `-90..=90`).
pub fn evaluate_stylus_sample(
    sample: &StylusSample,
) -> Result<StylusEvaluation, InputDiagnosticsError> {
    if !sample.pressure.is_finite() || !(0.0..=1.0).contains(&sample.pressure) {
        return Err(InputDiagnosticsError::InvalidStylusSample {
            detail: format!("pressure {} out of [0.0, 1.0]", sample.pressure),
        });
    }
    if !sample.tilt_x_deg.is_finite()
        || !(-90.0..=90.0).contains(&sample.tilt_x_deg)
        || !sample.tilt_y_deg.is_finite()
        || !(-90.0..=90.0).contains(&sample.tilt_y_deg)
    {
        return Err(InputDiagnosticsError::InvalidStylusSample {
            detail: format!(
                "tilt ({}, {}) out of [-90.0, 90.0] degrees",
                sample.tilt_x_deg, sample.tilt_y_deg
            ),
        });
    }

    let combined_tilt_deg = sample.tilt_x_deg.hypot(sample.tilt_y_deg).min(90.0);
    let tilt_azimuth_deg = if sample.tilt_x_deg == 0.0 && sample.tilt_y_deg == 0.0 {
        0.0
    } else {
        sample.tilt_y_deg.atan2(sample.tilt_x_deg).to_degrees()
    };

    let is_contact_stroke = sample.in_range && sample.contact_active && sample.pressure > 0.0;
    let state = if !sample.in_range {
        StylusStrokeState::OutOfRange
    } else if !sample.contact_active || sample.pressure == 0.0 {
        StylusStrokeState::Hover
    } else if sample.eraser_tip {
        StylusStrokeState::EraserActive
    } else if sample.pressure < 0.35 {
        StylusStrokeState::LightStroke
    } else if sample.pressure < 0.75 {
        StylusStrokeState::MediumStroke
    } else {
        StylusStrokeState::HeavyStroke
    };

    Ok(StylusEvaluation {
        state,
        normalized_pressure: sample.pressure,
        combined_tilt_deg,
        tilt_azimuth_deg,
        is_contact_stroke,
        barrel_button: sample.barrel_button,
    })
}

/// Live Windows input probe observation record supplied by the OS/native harness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowsInputObservation {
    /// Descriptor identifier (for example `"ptp_registry"`, `"hid_raw_touchpad"`).
    pub id: String,
    /// True strictly when live registry/HID/WM_INPUT probing succeeded.
    pub observed: bool,
    /// Observed values or reason summary (never fabricated).
    pub detail: String,
}

/// Truthful Windows Precision Touchpad registry and HID Raw Input capability descriptor.
///
/// `source_verified` remains `false` (`CapabilityStatus::Unavailable`) unless an actual live
/// [`WindowsInputObservation`] confirms observation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowsInputCapabilityDescriptor {
    /// Stable descriptor identifier.
    pub id: String,
    /// Human-readable Windows input surface name.
    pub surface: String,
    /// Optional Windows Registry path (for example `HKCU\Software\Microsoft\Windows\CurrentVersion\PrecisionTouchPad`).
    pub registry_path: Option<String>,
    /// Optional Win32 window message (`WM_INPUT`).
    pub window_message: Option<String>,
    /// Optional HID Usage Page (`0x0D` Digitizer, `0x0E` Haptics).
    pub hid_usage_page: Option<u16>,
    /// Optional HID Usage ID (`0x05` Touchpad, `0x02` Pen, `0x01` SimpleHapticsController).
    pub hid_usage_id: Option<u16>,
    /// Optional HID usage symbolic name.
    pub hid_usage_name: Option<String>,
    /// Truthful capability status (`Available` only when live-observed).
    pub status: CapabilityStatus,
    /// Machine-readable reason code.
    pub reason_code: CapabilityReason,
    /// True strictly when `status == CapabilityStatus::Available` and verified by observation.
    pub source_verified: bool,
    /// Secret-free diagnostic status detail.
    pub detail: String,
}

impl WindowsInputCapabilityDescriptor {
    /// Serializes this descriptor into a [`serde_json::Value`].
    pub fn to_json(&self) -> Value {
        json!(self)
    }
}

impl Serialize for WindowsInputCapabilityDescriptor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        json!({
            "id": self.id,
            "surface": self.surface,
            "registry_path": self.registry_path,
            "window_message": self.window_message,
            "hid_usage_page": self.hid_usage_page.map(|v| format!("0x{v:02X}")),
            "hid_usage_id": self.hid_usage_id.map(|v| format!("0x{v:02X}")),
            "hid_usage_name": self.hid_usage_name,
            "status": self.status,
            "reason_code": self.reason_code,
            "source_verified": self.source_verified,
            "detail": self.detail,
        })
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for WindowsInputCapabilityDescriptor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        let obj = val.as_object().ok_or_else(|| {
            serde::de::Error::custom("WindowsInputCapabilityDescriptor must be a JSON object")
        })?;
        let req_str = |k: &str| -> Result<String, D::Error> {
            obj.get(k)
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .ok_or_else(|| serde::de::Error::custom(format!("missing string `{k}`")))
        };
        let opt_str = |k: &str| -> Option<String> {
            obj.get(k).and_then(Value::as_str).map(ToString::to_string)
        };
        let parse_opt_hex_u16 = |k: &str| -> Result<Option<u16>, D::Error> {
            match obj.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Number(n)) => n
                    .as_u64()
                    .and_then(|v| u16::try_from(v).ok())
                    .map(Some)
                    .ok_or_else(|| serde::de::Error::custom(format!("invalid u16 `{k}`"))),
                Some(Value::String(s)) => {
                    let trimmed = s.trim();
                    let parsed = if let Some(hex) = trimmed
                        .strip_prefix("0x")
                        .or_else(|| trimmed.strip_prefix("0X"))
                    {
                        u16::from_str_radix(hex, 16)
                    } else {
                        trimmed.parse::<u16>()
                    };
                    parsed
                        .map(Some)
                        .map_err(|_| serde::de::Error::custom(format!("invalid u16 hex `{k}`")))
                }
                _ => Err(serde::de::Error::custom(format!(
                    "`{k}` must be string, u16, or null"
                ))),
            }
        };

        let status: CapabilityStatus = serde_json::from_value(
            obj.get("status")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing status"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let reason_code: CapabilityReason = serde_json::from_value(
            obj.get("reason_code")
                .cloned()
                .ok_or_else(|| serde::de::Error::custom("missing reason_code"))?,
        )
        .map_err(serde::de::Error::custom)?;
        let raw_verified = obj
            .get("source_verified")
            .and_then(Value::as_bool)
            .ok_or_else(|| serde::de::Error::custom("missing bool source_verified"))?;

        // Epistemic guard: never allow deserialized forged `source_verified: true` when unavailable.
        let source_verified = raw_verified && status == CapabilityStatus::Available;

        Ok(Self {
            id: req_str("id")?,
            surface: req_str("surface")?,
            registry_path: opt_str("registry_path"),
            window_message: opt_str("window_message"),
            hid_usage_page: parse_opt_hex_u16("hid_usage_page")?,
            hid_usage_id: parse_opt_hex_u16("hid_usage_id")?,
            hid_usage_name: opt_str("hid_usage_name"),
            status,
            reason_code,
            source_verified,
            detail: req_str("detail")?,
        })
    }
}

/// Builds the catalog of Windows PTP registry & HID Raw Input capability descriptors,
/// keeping `source_verified == false` unless matched by an active [`WindowsInputObservation`].
pub fn describe_windows_input_capabilities(
    observations: &[WindowsInputObservation],
) -> Vec<WindowsInputCapabilityDescriptor> {
    let mut descriptors = vec![
        WindowsInputCapabilityDescriptor {
            id: "ptp_registry".to_string(),
            surface: "Windows Precision Touchpad User Preferences".to_string(),
            registry_path: Some(PTP_REGISTRY_PATH.to_string()),
            window_message: None,
            hid_usage_page: None,
            hid_usage_id: None,
            hid_usage_name: None,
            status: CapabilityStatus::Unavailable,
            reason_code: CapabilityReason::CaptureReceiptRequired,
            source_verified: false,
            detail: "PTP registry settings uninspected; awaiting live HKCU query receipt".to_string(),
        },
        WindowsInputCapabilityDescriptor {
            id: "hid_raw_touchpad".to_string(),
            surface: "HID Raw Input Precision Touchpad Digitizer".to_string(),
            registry_path: None,
            window_message: Some("WM_INPUT".to_string()),
            hid_usage_page: Some(HID_USAGE_PAGE_DIGITIZER),
            hid_usage_id: Some(HID_USAGE_DIGITIZER_TOUCHPAD),
            hid_usage_name: Some("TouchPad".to_string()),
            status: CapabilityStatus::Unavailable,
            reason_code: CapabilityReason::CaptureReceiptRequired,
            source_verified: false,
            detail: "WM_INPUT Digitizer TouchPad (0x0D/0x05) not yet observed via live device enumeration"
                .to_string(),
        },
        WindowsInputCapabilityDescriptor {
            id: "hid_raw_stylus".to_string(),
            surface: "HID Raw Input Pen/Stylus Digitizer".to_string(),
            registry_path: None,
            window_message: Some("WM_INPUT".to_string()),
            hid_usage_page: Some(HID_USAGE_PAGE_DIGITIZER),
            hid_usage_id: Some(HID_USAGE_DIGITIZER_PEN),
            hid_usage_name: Some("Pen".to_string()),
            status: CapabilityStatus::Unavailable,
            reason_code: CapabilityReason::CaptureReceiptRequired,
            source_verified: false,
            detail: "WM_INPUT Digitizer Pen (0x0D/0x02) not yet observed via live device enumeration"
                .to_string(),
        },
        WindowsInputCapabilityDescriptor {
            id: "hid_raw_simple_haptics".to_string(),
            surface: "HID Raw Input SimpleHapticsController".to_string(),
            registry_path: None,
            window_message: Some("WM_INPUT".to_string()),
            hid_usage_page: Some(HID_USAGE_PAGE_HAPTICS),
            hid_usage_id: Some(HID_USAGE_HAPTICS_SIMPLE_CONTROLLER),
            hid_usage_name: Some("SimpleHapticsController".to_string()),
            status: CapabilityStatus::Unavailable,
            reason_code: CapabilityReason::CaptureReceiptRequired,
            source_verified: false,
            detail: "WM_INPUT SimpleHapticsController (0x0E/0x01) not yet observed via live device enumeration"
                .to_string(),
        },
    ];

    for desc in &mut descriptors {
        if let Some(obs) = observations.iter().find(|o| o.id == desc.id) {
            if obs.observed && !obs.detail.trim().is_empty() {
                desc.status = CapabilityStatus::Available;
                desc.reason_code = CapabilityReason::Available;
                desc.source_verified = true;
                desc.detail = obs.detail.clone();
            } else {
                desc.status = CapabilityStatus::Unavailable;
                desc.reason_code = CapabilityReason::EndpointUnreachable;
                desc.source_verified = false;
                if !obs.detail.trim().is_empty() {
                    desc.detail = obs.detail.clone();
                }
            }
        }
    }

    descriptors
}

fn ensure_finite(value: f64, field: &'static str) -> Result<(), InputDiagnosticsError> {
    if !value.is_finite() {
        return Err(InputDiagnosticsError::NonFiniteMetric { field });
    }
    Ok(())
}

fn ensure_non_negative_finite(
    value: f64,
    field: &'static str,
) -> Result<(), InputDiagnosticsError> {
    ensure_finite(value, field)?;
    if value < 0.0 {
        return Err(InputDiagnosticsError::InvalidParameter {
            field,
            detail: format!("must be >= 0, got {value}"),
        });
    }
    Ok(())
}

fn ensure_positive_finite(value: f64, field: &'static str) -> Result<(), InputDiagnosticsError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(InputDiagnosticsError::InvalidTouchpadConfig {
            detail: format!("{field} must be finite and > 0, got {value}"),
        });
    }
    Ok(())
}

fn apply_scalar_deadzone(delta: f64, deadzone: f64) -> f64 {
    let mag = delta.abs();
    if mag <= deadzone {
        0.0
    } else {
        (mag - deadzone) * delta.signum()
    }
}

fn apply_vector_deadzone(dx: f64, dy: f64, deadzone: f64) -> (f64, f64) {
    let mag = dx.hypot(dy);
    if mag <= deadzone || mag == 0.0 {
        (0.0, 0.0)
    } else {
        let scale = (mag - deadzone) / mag;
        (dx * scale, dy * scale)
    }
}

fn quantize_cardinal(dx: f64, dy: f64) -> StrokeDirection {
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 {
            StrokeDirection::Right
        } else {
            StrokeDirection::Left
        }
    } else if dy >= 0.0 {
        StrokeDirection::Down
    } else {
        StrokeDirection::Up
    }
}

fn rdp_simplify(points: &[StrokePoint], epsilon: f64) -> Vec<StrokePoint> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let first = points[0];
    let last = points[points.len() - 1];
    let mut max_dist = 0.0;
    let mut max_idx = 0usize;

    for (idx, p) in points.iter().enumerate().take(points.len() - 1).skip(1) {
        let d = perpendicular_distance(*p, first, last);
        if d > max_dist {
            max_dist = d;
            max_idx = idx;
        }
    }

    if max_dist > epsilon {
        let mut left = rdp_simplify(&points[..=max_idx], epsilon);
        let right = rdp_simplify(&points[max_idx..], epsilon);
        left.pop();
        left.extend_from_slice(&right);
        left
    } else {
        vec![first, last]
    }
}

fn perpendicular_distance(p: StrokePoint, a: StrokePoint, b: StrokePoint) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let denom = dx.hypot(dy);
    if denom <= 1e-9 {
        return (p.x - a.x).hypot(p.y - a.y);
    }
    ((dy * p.x - dx * p.y + b.x * a.y - b.y * a.x).abs()) / denom
}

fn levenshtein_chars(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = b_chars.len();
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr: Vec<usize> = vec![0; m + 1];

    for (i, &ac) in a_chars.iter().enumerate() {
        curr[0] = i + 1;
        for (j, &bc) in b_chars.iter().enumerate() {
            let cost = usize::from(ac != bc);
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        prev.copy_from_slice(&curr);
    }
    prev[m]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_calibration_tracks_nkro_chatter_pangram_and_5_point_key_slip() {
        let events = vec![
            KeyEventSample {
                key: "w".to_string(),
                timestamp_ms: 10.0,
                pressed: true,
            },
            KeyEventSample {
                key: "a".to_string(),
                timestamp_ms: 12.0,
                pressed: true,
            },
            KeyEventSample {
                key: "s".to_string(),
                timestamp_ms: 14.0,
                pressed: true,
            },
            KeyEventSample {
                key: "d".to_string(),
                timestamp_ms: 16.0,
                pressed: true,
            },
            KeyEventSample {
                key: "Space".to_string(),
                timestamp_ms: 18.0,
                pressed: true,
            },
            KeyEventSample {
                key: "Shift".to_string(),
                timestamp_ms: 20.0,
                pressed: true,
            },
            // Release and bounce 'w' at 22ms after initial press at 10ms (12ms < 15ms threshold -> chatter!).
            KeyEventSample {
                key: "w".to_string(),
                timestamp_ms: 21.0,
                pressed: false,
            },
            KeyEventSample {
                key: "w".to_string(),
                timestamp_ms: 22.0,
                pressed: true,
            },
        ];

        // 5-point slip profile shifted +19.6px right (roughly 1 key width right).
        let samples = vec![
            KeySlipSample::from_delta('a', 18.0, 0.0, 82.0).unwrap(),
            KeySlipSample::from_delta('f', 20.0, -1.0, 74.0).unwrap(),
            KeySlipSample::from_delta('j', 19.0, 1.0, 68.0).unwrap(),
            KeySlipSample::from_delta('l', 21.0, 0.0, 76.0).unwrap(),
            KeySlipSample::from_keys('e', 'r', 70.0).unwrap(), // +20px right
        ];

        let pangram = PangramTestInput {
            expected_text: "the quick brown fox".to_string(),
            typed_text: "the quick brown fox".to_string(),
            duration_ms: 3_000.0, // 19 chars / 5 / 0.05 min = 76 WPM
        };

        let report = evaluate_keyboard_calibration(&events, 15.0, Some(&pangram), Some(&samples))
            .expect("valid keyboard calibration");
        assert_eq!(report.max_nkro_keys, 6);
        assert!(report.chatter_detected);
        assert_eq!(report.chatter_events.len(), 1);
        assert_eq!(report.chatter_events[0].key, "w");
        assert!((report.chatter_events[0].inter_press_ms - 12.0).abs() < 1e-6);
        assert!((report.pangram_wpm.unwrap() - 76.0).abs() < 1e-6);
        assert!((report.pangram_accuracy_pct.unwrap() - 100.0).abs() < 1e-6);

        let profile = report.key_slip_profile.as_ref().unwrap();
        assert_eq!(profile.sample_count, 5);
        assert!((profile.mean_dx_px - 19.6).abs() < 1e-6);
        assert!((profile.mean_flight_ms - 74.0).abs() < 1e-6);

        // User hit 's' with ~19.6px rightward bias -> nearest intended key is 'a'!
        let recovered = profile.recover_intended_keys('s', 3).unwrap();
        assert_eq!(recovered[0].key, 'a');
        let neighbors = profile.rank_neighbor_candidates('s', 3).unwrap();
        assert_eq!(neighbors[0].key, 'a');
        assert!(report.to_json().get("max_nkro_keys").is_some());

        // Fewer than 5 samples must fail 5-point calibration.
        let err = KeySlipProfile::from_5_point_calibration(&samples[..4]).unwrap_err();
        assert!(matches!(
            err,
            InputDiagnosticsError::InsufficientSamples { required: 5, .. }
        ));
    }

    #[test]
    fn mouse_polling_computes_tiers_jitter_stddev_and_dropped_intervals() {
        // Steady 1000 Hz (1000 us intervals)
        let steady_1k: Vec<u64> = (0..=20).map(|i| i * 1_000).collect();
        let rep_1k = analyze_mouse_polling(&steady_1k).unwrap();
        assert_eq!(rep_1k.nearest_nominal_tier_hz, 1000);
        assert!((rep_1k.mean_hz - 1000.0).abs() < 1e-6);
        assert_eq!(rep_1k.p95_jitter_ms, 0.0);
        assert_eq!(rep_1k.std_dev_ms, 0.0);
        assert_eq!(rep_1k.dropped_intervals, 0);

        // 8000 Hz (125 us intervals)
        let steady_8k: Vec<u64> = (0..=16).map(|i| i * 125).collect();
        let rep_8k = analyze_mouse_polling(&steady_8k).unwrap();
        assert_eq!(rep_8k.nearest_nominal_tier_hz, 8000);
        assert!((rep_8k.mean_hz - 8000.0).abs() < 1e-6);

        // 1000 Hz with one 3000 us gap (2 missed frames -> 1 dropped interval)
        let with_drop = vec![
            0, 1_000, 2_000, 3_000, 4_000, 5_000, 8_000, 9_000, 10_000, 11_000,
        ];
        let rep_drop = analyze_mouse_polling(&with_drop).unwrap();
        assert_eq!(rep_drop.nearest_nominal_tier_hz, 1000);
        assert_eq!(rep_drop.dropped_intervals, 1);
        assert_eq!(rep_drop.estimated_missed_polls, 2);
        assert!(rep_drop.p95_jitter_ms > 0.0);
        assert!(rep_drop.std_dev_ms > 0.0);

        // Non-monotonic timestamps fail cleanly.
        let err = analyze_mouse_polling(&[100, 200, 200]).unwrap_err();
        assert!(matches!(
            err,
            InputDiagnosticsError::NonMonotonicTimestamps { .. }
        ));
    }

    #[test]
    fn mouse_chatter_and_stroke_gesture_arena_classify_all_canonical_patterns() {
        let chatter = detect_mouse_chatter(&[120.0, 4.5, 95.0, 8.2], 12.0).unwrap();
        assert!(chatter.faulty_switch);
        assert_eq!(chatter.chatter_count, 2);
        assert_eq!(chatter.chatter_indices, vec![1, 3]);
        assert_eq!(chatter.min_delta_ms, Some(4.5));

        let healthy = detect_mouse_chatter(&[50.0, 80.0, 120.0], 10.0).unwrap();
        assert!(!healthy.faulty_switch);
        assert_eq!(healthy.chatter_count, 0);

        let cases: &[(&str, &[(f64, f64)])] = &[
            ("L", &[(100.0, 50.0), (50.0, 51.0), (0.0, 50.0)]),
            ("R", &[(0.0, 50.0), (40.0, 49.0), (80.0, 50.0)]),
            ("U", &[(50.0, 100.0), (51.0, 60.0), (50.0, 10.0)]),
            ("D", &[(50.0, 10.0), (49.0, 50.0), (50.0, 100.0)]),
            (
                "L->U",
                &[(100.0, 100.0), (40.0, 99.0), (0.0, 100.0), (1.0, 20.0)],
            ),
            (
                "L->D",
                &[(100.0, 0.0), (20.0, 1.0), (0.0, 0.0), (0.0, 80.0)],
            ),
            ("R->U", &[(0.0, 100.0), (80.0, 100.0), (80.0, 10.0)]),
            ("R->D", &[(0.0, 0.0), (80.0, 0.0), (80.0, 80.0)]),
            ("U->R", &[(0.0, 100.0), (0.0, 20.0), (80.0, 20.0)]),
            ("D->R", &[(0.0, 0.0), (0.0, 80.0), (80.0, 80.0)]),
        ];
        for (expected, pts) in cases {
            let cls = classify_mouse_stroke(pts).expect("classify stroke");
            assert_eq!(&cls.sequence_label, expected, "pts={pts:?}");
        }
    }

    #[test]
    fn touchpad_edge_scroll_locks_pointer_rejects_palms_and_handles_multitouch_and_stylus() {
        let cfg = TouchpadEdgeScrollConfig {
            width_mm: 120.0,
            height_mm: 75.0,
            left_edge_strip_mm: 8.0,
            right_edge_strip_mm: 10.0,
            deadzone_mm: 0.5,
            scroll_gain: 2.0,
            cursor_lock: true,
            palm_max_contact_mm: 14.0,
        };

        // Right-edge scroll with simultaneous palm resting on interior -> palm rejected, pointer locked.
        let edge_eval = evaluate_touchpad_contacts(
            &cfg,
            &[
                TouchpadContact {
                    contact_id: 1,
                    x_mm: 115.0,
                    y_mm: 30.0,
                    dx_mm: 0.8,
                    dy_mm: 10.5,
                    contact_major_mm: 6.5,
                },
                TouchpadContact {
                    contact_id: 2,
                    x_mm: 55.0,
                    y_mm: 60.0,
                    dx_mm: 2.0,
                    dy_mm: 2.0,
                    contact_major_mm: 24.0, // palm!
                },
            ],
        )
        .unwrap();
        assert_eq!(edge_eval.action, TouchpadAction::EdgeScroll);
        assert_eq!(edge_eval.active_edge_strip, Some(EdgeStripSide::Right));
        assert_eq!(edge_eval.rejected_palm_ids, vec![2]);
        assert_eq!(edge_eval.active_contact_ids, vec![1]);
        assert_eq!(edge_eval.cursor_dx, 0.0);
        assert_eq!(edge_eval.cursor_dy, 0.0);
        assert!(edge_eval.cursor_locked);
        assert!((edge_eval.scroll_dy - 20.0).abs() < 1e-6);

        // Left-edge scroll with cursor_lock = false unlocks pointer delta.
        let mut unlocked_cfg = cfg;
        unlocked_cfg.cursor_lock = false;
        let left_eval = evaluate_touchpad_contacts(
            &unlocked_cfg,
            &[TouchpadContact {
                contact_id: 7,
                x_mm: 4.0,
                y_mm: 25.0,
                dx_mm: 1.5,
                dy_mm: -5.5,
                contact_major_mm: 6.0,
            }],
        )
        .unwrap();
        assert_eq!(left_eval.action, TouchpadAction::EdgeScroll);
        assert_eq!(left_eval.active_edge_strip, Some(EdgeStripSide::Left));
        assert!(!left_eval.cursor_locked);
        assert!((left_eval.cursor_dx - 1.0).abs() < 1e-6);
        assert!((left_eval.scroll_dy + 10.0).abs() < 1e-6);

        // Interior 1-finger cursor movement.
        let cursor_eval = evaluate_touchpad_contacts(
            &cfg,
            &[TouchpadContact {
                contact_id: 3,
                x_mm: 60.0,
                y_mm: 40.0,
                dx_mm: 3.0,
                dy_mm: 4.0, // mag = 5.0 -> minus deadzone 0.5 => scale 4.5/5.0 = 0.9 -> (2.7, 3.6)
                contact_major_mm: 7.0,
            }],
        )
        .unwrap();
        assert_eq!(cursor_eval.action, TouchpadAction::CursorMove);
        assert!((cursor_eval.cursor_dx - 2.7).abs() < 1e-6);
        assert!((cursor_eval.cursor_dy - 3.6).abs() < 1e-6);

        // Interior 2-finger pinch-out zoom.
        let pinch_eval = evaluate_touchpad_contacts(
            &cfg,
            &[
                TouchpadContact {
                    contact_id: 1,
                    x_mm: 40.0,
                    y_mm: 40.0,
                    dx_mm: -5.0,
                    dy_mm: 0.0,
                    contact_major_mm: 6.0,
                },
                TouchpadContact {
                    contact_id: 2,
                    x_mm: 70.0,
                    y_mm: 40.0,
                    dx_mm: 5.0,
                    dy_mm: 0.0,
                    contact_major_mm: 6.0,
                },
            ],
        )
        .unwrap();
        assert_eq!(pinch_eval.action, TouchpadAction::TwoFingerPinchZoom);
        assert!((pinch_eval.pinch_scale - 1.5).abs() < 1e-6);
        assert_eq!(pinch_eval.cursor_dx, 0.0);

        // Interior 3-finger upward swipe.
        let three_eval = evaluate_touchpad_contacts(
            &cfg,
            &[
                TouchpadContact {
                    contact_id: 1,
                    x_mm: 45.0,
                    y_mm: 30.0,
                    dx_mm: 0.0,
                    dy_mm: -6.0,
                    contact_major_mm: 6.0,
                },
                TouchpadContact {
                    contact_id: 2,
                    x_mm: 60.0,
                    y_mm: 30.0,
                    dx_mm: 0.0,
                    dy_mm: -6.0,
                    contact_major_mm: 6.0,
                },
                TouchpadContact {
                    contact_id: 3,
                    x_mm: 75.0,
                    y_mm: 30.0,
                    dx_mm: 0.0,
                    dy_mm: -6.0,
                    contact_major_mm: 6.0,
                },
            ],
        )
        .unwrap();
        assert_eq!(three_eval.action, TouchpadAction::ThreeFingerSwipeUp);

        // Stylus pressure & tilt validation.
        let stylus = evaluate_stylus_sample(&StylusSample {
            pressure: 0.85,
            tilt_x_deg: 30.0,
            tilt_y_deg: 40.0,
            barrel_button: true,
            eraser_tip: false,
            in_range: true,
            contact_active: true,
        })
        .unwrap();
        assert_eq!(stylus.state, StylusStrokeState::HeavyStroke);
        assert!(stylus.is_contact_stroke);
        assert!((stylus.combined_tilt_deg - 50.0).abs() < 1e-6);
    }

    #[test]
    fn windows_ptp_and_hid_descriptors_never_fabricate_source_verified() {
        let default_descs = describe_windows_input_capabilities(&[]);
        assert_eq!(default_descs.len(), 4);
        for d in &default_descs {
            assert_eq!(d.status, CapabilityStatus::Unavailable);
            assert!(!d.source_verified);
        }
        assert!(default_descs
            .iter()
            .any(|d| d.registry_path.as_deref() == Some(PTP_REGISTRY_PATH)));
        assert!(default_descs.iter().any(|d| {
            d.hid_usage_page == Some(0x0E)
                && d.hid_usage_id == Some(0x01)
                && d.window_message.as_deref() == Some("WM_INPUT")
        }));

        // Forged JSON claiming `source_verified: true` on unavailable status must neutralize.
        let forged = json!({
            "id": "ptp_registry",
            "surface": "Windows Precision Touchpad User Preferences",
            "registry_path": PTP_REGISTRY_PATH,
            "status": "unavailable",
            "reason_code": "CAPTURE_RECEIPT_REQUIRED",
            "source_verified": true,
            "detail": "forged"
        });
        let decoded: WindowsInputCapabilityDescriptor = serde_json::from_value(forged).unwrap();
        assert!(!decoded.source_verified);

        // Only explicit live observation turns `source_verified` true for that descriptor.
        let observed = describe_windows_input_capabilities(&[WindowsInputObservation {
            id: "hid_raw_simple_haptics".to_string(),
            observed: true,
            detail: "WM_INPUT registered HID 0x0E/0x01 SimpleHapticsController".to_string(),
        }]);
        let haptics = observed
            .iter()
            .find(|d| d.id == "hid_raw_simple_haptics")
            .unwrap();
        assert_eq!(haptics.status, CapabilityStatus::Available);
        assert!(haptics.source_verified);
        let ptp = observed.iter().find(|d| d.id == "ptp_registry").unwrap();
        assert!(!ptp.source_verified);
    }
}
