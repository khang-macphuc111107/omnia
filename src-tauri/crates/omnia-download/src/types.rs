//! Small shared value types.

use serde::{Deserialize, Serialize};

/// Quality selection for adaptive streams (HLS / DASH).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Quality {
    /// Highest bandwidth.
    #[default]
    Best,
    /// Lowest bandwidth.
    Worst,
    /// Best variant whose height is <= the value.
    MaxHeight(u32),
    /// Best variant whose bandwidth is <= the value (bits/s).
    Bandwidth(u64),
}

/// A byte range `[offset, offset + length)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}

impl ByteRange {
    pub fn header_value(&self) -> String {
        format!(
            "bytes={}-{}",
            self.offset,
            self.offset + self.length.saturating_sub(1)
        )
    }
}

/// Progress snapshot published while a download runs.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
    /// Smoothed (EMA) speed in bytes per second.
    pub speed_bps: f64,
    pub eta_secs: Option<f64>,
    pub connections: u32,
    pub segments_done: Option<u32>,
    pub segments_total: Option<u32>,
}

type Cand = (u64, Option<u32>);

fn best_of(items: &[Cand], pred: impl Fn(&Cand) -> bool, best: bool) -> Option<usize> {
    let it = items.iter().enumerate().filter(|(_, x)| pred(x));
    if best {
        it.max_by_key(|(_, x)| (x.0, x.1.unwrap_or(0)))
            .map(|(i, _)| i)
    } else {
        it.min_by_key(|(_, x)| (x.0, x.1.unwrap_or(0)))
            .map(|(i, _)| i)
    }
}

/// Generic select-by-quality over `(bandwidth, height)` candidates; returns the index.
pub fn pick_by_quality(items: &[(u64, Option<u32>)], quality: Quality) -> Option<usize> {
    if items.is_empty() {
        return None;
    }
    match quality {
        Quality::Best => best_of(items, |_| true, true),
        Quality::Worst => best_of(items, |_| true, false),
        Quality::MaxHeight(h) => {
            // Tallest variant that fits; otherwise the smallest known; otherwise best overall.
            let fit = items
                .iter()
                .enumerate()
                .filter(|(_, x)| x.1.is_some_and(|hh| hh <= h))
                .max_by_key(|(_, x)| (x.1.unwrap_or(0), x.0))
                .map(|(i, _)| i);
            if fit.is_some() {
                fit
            } else if items.iter().all(|x| x.1.is_none()) {
                best_of(items, |_| true, true)
            } else {
                items
                    .iter()
                    .enumerate()
                    .filter(|(_, x)| x.1.is_some())
                    .min_by_key(|(_, x)| (x.1.unwrap_or(0), x.0))
                    .map(|(i, _)| i)
            }
        }
        Quality::Bandwidth(b) => {
            best_of(items, |x| x.0 <= b, true).or_else(|| best_of(items, |_| true, false))
        }
    }
}
