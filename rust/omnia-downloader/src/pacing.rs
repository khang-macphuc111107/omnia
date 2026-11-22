//! Congestion control (`AIMD + BDP`), RFC 9110 `Retry-After` parsing, Token Bucket
//! bandwidth throttling, and 4 pacing modes (`turbo`, `adaptive`, `polite`, `linear_rate_guarded`).

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, NaiveDateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

use crate::types::{MAX_STREAMS, MIN_STREAMS};

/// Maximum `Retry-After` delay accepted before clamping (10 minutes).
pub const MAX_RETRY_AFTER_SECS: u64 = 600;

/// Four supported transfer pacing & capture modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PacingMode {
    /// Aggressive parallel range streaming up to 128 streams.
    Turbo,
    /// AIMD + BDP dynamic concurrency window adapting to RTT/429/503 signals.
    #[default]
    Adaptive,
    /// Single-stream polite transfer with configurable inter-segment delay.
    Polite,
    /// Strictly sequential single-stream transfer with linear rate guard (no parallel seeks).
    LinearRateGuarded,
}

impl PacingMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Turbo => "turbo",
            Self::Adaptive => "adaptive",
            Self::Polite => "polite",
            Self::LinearRateGuarded => "linear_rate_guarded",
        }
    }

    #[must_use]
    pub fn from_db_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "turbo" => Self::Turbo,
            "polite" => Self::Polite,
            "linear_rate_guarded" | "linear" => Self::LinearRateGuarded,
            _ => Self::Adaptive,
        }
    }

    /// Maximum streams permitted under this pacing mode given caller request.
    #[must_use]
    pub fn effective_max_streams(self, requested: usize) -> usize {
        let clamped = requested.clamp(MIN_STREAMS, MAX_STREAMS);
        match self {
            Self::Turbo | Self::Adaptive => clamped,
            Self::Polite | Self::LinearRateGuarded => 1,
        }
    }

    /// Whether parallel work-stealing is permitted under this pacing mode.
    #[must_use]
    pub const fn allows_work_stealing(self) -> bool {
        matches!(self, Self::Turbo | Self::Adaptive)
    }
}

/// Parses an HTTP `Retry-After` header per RFC 9110 §10.2.3.
///
/// Supports both:
/// - Non-negative integer delta-seconds (e.g. `"120"`), and
/// - HTTP-date formats: IMF-fixdate (`"Wed, 21 Oct 2015 07:28:00 GMT"`), RFC 850, and ANSI C `asctime()`.
///
/// Returns `None` for unparseable values and clamps parsed waits to `0..=MAX_RETRY_AFTER_SECS`.
#[must_use]
pub fn parse_retry_after(header_value: &str, now_epoch_secs: i64) -> Option<Duration> {
    let trimmed = header_value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.bytes().all(|b| b.is_ascii_digit()) {
        let secs = trimmed.parse::<u64>().ok()?;
        return Some(Duration::from_secs(secs.min(MAX_RETRY_AFTER_SECS)));
    }

    // IMF-fixdate / RFC 2822 (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
    if let Ok(dt) = DateTime::parse_from_rfc2822(trimmed) {
        let delta = dt.timestamp().saturating_sub(now_epoch_secs).max(0) as u64;
        return Some(Duration::from_secs(delta.min(MAX_RETRY_AFTER_SECS)));
    }

    // Explicit IMF-fixdate format fallback if timezone is literal "GMT"
    if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%a, %d %b %Y %H:%M:%S GMT") {
        let dt = naive.and_utc();
        let delta = dt.timestamp().saturating_sub(now_epoch_secs).max(0) as u64;
        return Some(Duration::from_secs(delta.min(MAX_RETRY_AFTER_SECS)));
    }

    // Obsolete RFC 850 date (e.g., "Sunday, 06-Nov-94 08:49:37 GMT")
    if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%A, %d-%b-%y %H:%M:%S GMT") {
        let dt = naive.and_utc();
        let delta = dt.timestamp().saturating_sub(now_epoch_secs).max(0) as u64;
        return Some(Duration::from_secs(delta.min(MAX_RETRY_AFTER_SECS)));
    }

    // ANSI C asctime() format (e.g., "Sun Nov  6 08:49:37 1994")
    if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%a %b %e %H:%M:%S %Y") {
        let dt = naive.and_utc();
        let delta = dt.timestamp().saturating_sub(now_epoch_secs).max(0) as u64;
        return Some(Duration::from_secs(delta.min(MAX_RETRY_AFTER_SECS)));
    }

    None
}

/// Convenience wrapper for [`parse_retry_after`] using current wall-clock UTC time.
#[must_use]
pub fn parse_retry_after_now(header_value: &str) -> Option<Duration> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    parse_retry_after(header_value, now)
}

/// Snapshot of AIMD + BDP congestion telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CongestionMetrics {
    pub current_window: usize,
    pub max_window: usize,
    pub ssthresh: usize,
    pub smoothed_rtt_ms: f64,
    pub estimated_bandwidth_bps: u64,
    pub bdp_bytes: u64,
    pub backoff_events: u64,
}

/// Additive-Increase / Multiplicative-Decrease (AIMD) + Bandwidth-Delay Product (BDP)
/// stream concurrency controller.
#[derive(Debug)]
pub struct AimdBdpController {
    mode: PacingMode,
    max_window: usize,
    cwnd: f64,
    ssthresh: usize,
    smoothed_rtt_ms: f64,
    estimated_bw_bps: f64,
    backoff_events: u64,
    next_allowed_epoch_ms: u64,
}

impl AimdBdpController {
    /// Creates a new controller initialized for `mode` and `max_streams` (`1..=128`).
    #[must_use]
    pub fn new(mode: PacingMode, max_streams: usize) -> Self {
        let max_window = mode.effective_max_streams(max_streams);
        let initial_cwnd = match mode {
            PacingMode::Turbo => max_window,
            PacingMode::Adaptive => max_window.clamp(1, 4),
            PacingMode::Polite | PacingMode::LinearRateGuarded => 1,
        };
        Self {
            mode,
            max_window,
            cwnd: initial_cwnd as f64,
            ssthresh: (max_window / 2).max(2),
            smoothed_rtt_ms: 50.0,
            estimated_bw_bps: 0.0,
            backoff_events: 0,
            next_allowed_epoch_ms: 0,
        }
    }

    /// Returns the currently recommended concurrent stream count (`1..=max_window`).
    #[must_use]
    pub fn target_streams(&self) -> usize {
        if matches!(self.mode, PacingMode::Polite | PacingMode::LinearRateGuarded) {
            return 1;
        }
        (self.cwnd.floor() as usize).clamp(MIN_STREAMS, self.max_window)
    }

    /// Records a healthy chunk transfer sample, updating EWMA RTT, bandwidth estimate,
    /// BDP, and applying slow-start / additive increase.
    pub fn on_chunk_success(&mut self, bytes: u64, rtt: Duration) {
        let rtt_ms = (rtt.as_secs_f64() * 1000.0).max(1.0);
        // RFC 6298 EWMA alpha = 1/8
        self.smoothed_rtt_ms = 0.875 * self.smoothed_rtt_ms + 0.125 * rtt_ms;

        let secs = rtt.as_secs_f64().max(0.001);
        let sample_bps = (bytes as f64) / secs;
        if self.estimated_bw_bps <= 0.0 {
            self.estimated_bw_bps = sample_bps;
        } else {
            self.estimated_bw_bps = 0.75 * self.estimated_bw_bps + 0.25 * sample_bps;
        }

        match self.mode {
            PacingMode::Polite | PacingMode::LinearRateGuarded => {
                self.cwnd = 1.0;
            }
            PacingMode::Turbo => {
                self.cwnd = (self.cwnd + 2.0).min(self.max_window as f64);
            }
            PacingMode::Adaptive => {
                let inc = if (self.cwnd as usize) < self.ssthresh {
                    1.0
                } else {
                    1.0 / self.cwnd.max(1.0)
                };
                self.cwnd = (self.cwnd + inc).min(self.max_window as f64);
            }
        }
    }

    /// Records transient server congestion (`HTTP 429` non-challenge or `HTTP 503` or timeout):
    /// applies multiplicative decrease (`cwnd /= 2`) and computes the required backoff delay
    /// honoring RFC 9110 `Retry-After` if present.
    pub fn on_congestion(
        &mut self,
        status: u16,
        retry_after_header: Option<&str>,
        now_epoch_ms: u64,
    ) -> Duration {
        self.backoff_events = self.backoff_events.saturating_add(1);
        let cur = self.cwnd.floor() as usize;
        self.ssthresh = (cur / 2).max(1);
        self.cwnd = (self.cwnd * 0.5).max(1.0);

        let now_secs = (now_epoch_ms / 1000) as i64;
        let delay = retry_after_header
            .and_then(|hdr| parse_retry_after(hdr, now_secs))
            .unwrap_or_else(|| {
                let base_ms: u64 = if status == 429 { 1_000 } else { 500 };
                let shift = self.backoff_events.min(6) as u32;
                Duration::from_millis((base_ms.saturating_mul(1u64 << shift)).min(30_000))
            });

        self.next_allowed_epoch_ms = now_epoch_ms.saturating_add(delay.as_millis() as u64);
        delay
    }

    /// Computed Bandwidth-Delay Product in bytes (`estimated_bw_bps * smoothed_rtt_secs`).
    #[must_use]
    pub fn bdp_bytes(&self) -> u64 {
        let bdp = self.estimated_bw_bps * (self.smoothed_rtt_ms / 1000.0);
        if bdp.is_finite() && bdp > 0.0 {
            bdp as u64
        } else {
            0
        }
    }

    /// Returns remaining cooldown duration at `now_epoch_ms`, if any.
    #[must_use]
    pub fn cooldown_remaining(&self, now_epoch_ms: u64) -> Duration {
        Duration::from_millis(self.next_allowed_epoch_ms.saturating_sub(now_epoch_ms))
    }

    /// Snapshot of current AIMD + BDP metrics.
    #[must_use]
    pub fn metrics(&self) -> CongestionMetrics {
        CongestionMetrics {
            current_window: self.target_streams(),
            max_window: self.max_window,
            ssthresh: self.ssthresh,
            smoothed_rtt_ms: self.smoothed_rtt_ms,
            estimated_bandwidth_bps: self.estimated_bw_bps.max(0.0) as u64,
            bdp_bytes: self.bdp_bytes(),
            backoff_events: self.backoff_events,
        }
    }
}

#[derive(Debug)]
struct BucketState {
    rate_bps: Option<u64>,
    capacity: f64,
    tokens: f64,
    last_refill: Instant,
}

/// Thread-safe async Token Bucket bandwidth limiter (`bytes/sec`).
#[derive(Debug)]
pub struct TokenBucketLimiter {
    state: Mutex<BucketState>,
}

impl TokenBucketLimiter {
    /// Creates a limiter with optional `rate_bps`. `None` or `Some(0)` means unlimited.
    #[must_use]
    pub fn new(rate_bps: Option<u64>) -> Self {
        let effective = rate_bps.filter(|&v| v > 0);
        let cap = effective.map_or(f64::INFINITY, |r| (r as f64).max(65_536.0));
        Self {
            state: Mutex::new(BucketState {
                rate_bps: effective,
                capacity: cap,
                tokens: cap,
                last_refill: Instant::now(),
            }),
        }
    }

    /// Dynamically updates the bandwidth cap (`None` or `Some(0)` disables throttling).
    pub fn set_rate_bps(&self, rate_bps: Option<u64>) {
        let mut st = self.state.lock();
        let effective = rate_bps.filter(|&v| v > 0);
        st.rate_bps = effective;
        st.capacity = effective.map_or(f64::INFINITY, |r| (r as f64).max(65_536.0));
        if st.tokens > st.capacity {
            st.tokens = st.capacity;
        }
        st.last_refill = Instant::now();
    }

    /// Returns the currently active rate cap in bytes/sec, if any.
    #[must_use]
    pub fn rate_bps(&self) -> Option<u64> {
        self.state.lock().rate_bps
    }

    /// Attempts to consume `bytes` immediately at timestamp `now`.
    /// Returns `Duration::ZERO` if enough tokens are available, or the exact wait needed.
    pub fn try_consume_at(&self, bytes: u64, now: Instant) -> Duration {
        let mut st = self.state.lock();
        let Some(rate) = st.rate_bps else {
            return Duration::ZERO;
        };
        if bytes == 0 {
            return Duration::ZERO;
        }

        let elapsed = now.saturating_duration_since(st.last_refill).as_secs_f64();
        if elapsed > 0.0 {
            st.tokens = (st.tokens + elapsed * (rate as f64)).min(st.capacity);
            st.last_refill = now;
        }

        let needed = bytes as f64;
        if st.tokens >= needed {
            st.tokens -= needed;
            Duration::ZERO
        } else {
            let deficit = needed - st.tokens;
            st.tokens = 0.0;
            Duration::from_secs_f64((deficit / (rate as f64)).min(60.0))
        }
    }

    /// Asynchronously paces transfer of `bytes` under the configured token bucket cap.
    pub async fn acquire(&self, bytes: u64) {
        let wait = self.try_consume_at(bytes, Instant::now());
        if !wait.is_zero() {
            sleep(wait).await;
        }
    }
}

/// Returns current UTC timestamp in seconds using `chrono::Utc`.
#[must_use]
pub fn now_utc_secs() -> i64 {
    Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_parses_seconds_and_rfc9110_http_date() {
        assert_eq!(
            parse_retry_after("45", 1_700_000_000),
            Some(Duration::from_secs(45))
        );
        // Clamped at MAX_RETRY_AFTER_SECS
        assert_eq!(
            parse_retry_after("99999", 1_700_000_000),
            Some(Duration::from_secs(MAX_RETRY_AFTER_SECS))
        );

        // RFC 9110 IMF-fixdate: Wed, 21 Oct 2015 07:28:00 GMT == 1445412480
        let base = 1_445_412_420; // 60 seconds earlier
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", base),
            Some(Duration::from_secs(60))
        );
        // Past HTTP-date clamps cleanly to 0s
        assert_eq!(
            parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", base + 500),
            Some(Duration::from_secs(0))
        );
        assert_eq!(parse_retry_after("not-a-date", base), None);
    }

    #[test]
    fn aimd_bdp_scales_up_and_halves_on_congestion() {
        let mut ctrl = AimdBdpController::new(PacingMode::Adaptive, 32);
        assert_eq!(ctrl.target_streams(), 4);

        for _ in 0..8 {
            ctrl.on_chunk_success(1024 * 1024, Duration::from_millis(50));
        }
        let peak = ctrl.target_streams();
        assert!(peak > 4);
        assert!(ctrl.bdp_bytes() > 0);

        let backoff = ctrl.on_congestion(503, Some("12"), 1_000_000);
        assert_eq!(backoff, Duration::from_secs(12));
        assert!(ctrl.target_streams() <= peak / 2 + 1);
    }

    #[test]
    fn token_bucket_enforces_rate_cap_deterministically() {
        let limiter = TokenBucketLimiter::new(Some(100_000)); // 100 KB/s, burst 100 KB
        let t0 = Instant::now();
        assert_eq!(limiter.try_consume_at(60_000, t0), Duration::ZERO);
        assert_eq!(limiter.try_consume_at(40_000, t0), Duration::ZERO);
        // Bucket now empty; requesting 50_000 bytes requires 0.5s wait.
        let wait = limiter.try_consume_at(50_000, t0);
        assert!(wait >= Duration::from_millis(490) && wait <= Duration::from_millis(510));
        // After 1 second refill, 100_000 bytes are available again.
        assert_eq!(
            limiter.try_consume_at(80_000, t0 + Duration::from_secs(1)),
            Duration::ZERO
        );
    }

    #[test]
    fn polite_and_linear_modes_clamp_streams_to_one() {
        assert_eq!(PacingMode::Polite.effective_max_streams(64), 1);
        assert_eq!(PacingMode::LinearRateGuarded.effective_max_streams(128), 1);
        assert_eq!(PacingMode::Turbo.effective_max_streams(128), 128);
        assert_eq!(PacingMode::Turbo.effective_max_streams(999), 128);
    }
}
