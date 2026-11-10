//! Token-bucket speed limiter shared by all connections of a job.

use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct TokenBucket {
    rate: f64,
    state: Mutex<(f64, Instant)>,
}

impl TokenBucket {
    /// `bytes_per_sec` of 0 is treated as 1.
    pub fn new(bytes_per_sec: u64) -> Self {
        let rate = bytes_per_sec.max(1) as f64;
        Self {
            rate,
            state: Mutex::new((rate, Instant::now())),
        }
    }

    /// Wait until `n` bytes may be consumed.
    pub async fn acquire(&self, n: usize) {
        let wait = {
            let mut s = self.state.lock().await;
            let now = Instant::now();
            let elapsed = now.duration_since(s.1).as_secs_f64();
            s.1 = now;
            s.0 = (s.0 + elapsed * self.rate).min(self.rate);
            s.0 -= n as f64;
            if s.0 < 0.0 {
                Duration::from_secs_f64(-s.0 / self.rate)
            } else {
                Duration::ZERO
            }
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn limits_throughput() {
        let b = TokenBucket::new(100_000);
        let start = Instant::now();
        for _ in 0..4 {
            b.acquire(50_000).await;
        }
        // 200 KB at 100 KB/s with a 100 KB initial burst: roughly one second.
        assert!(
            start.elapsed() >= Duration::from_millis(800),
            "{:?}",
            start.elapsed()
        );
    }
}
