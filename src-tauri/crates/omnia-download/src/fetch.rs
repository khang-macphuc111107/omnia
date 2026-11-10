//! Small-resource fetching with retries (playlists, keys, media segments).

use crate::error::{DownloadError, Result};
use crate::progress::ProgressTracker;
use crate::ratelimit::TokenBucket;
use crate::request::RequestSpec;
use crate::types::ByteRange;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Shared context for fetching many small resources with the same auth context.
#[derive(Clone)]
pub struct Fetcher {
    pub client: Client,
    /// Auth context template; segment requests are derived from it.
    pub spec: RequestSpec,
    pub max_retries: u32,
    pub retry_base_delay: Duration,
    pub cancel: CancellationToken,
    pub tracker: Option<Arc<ProgressTracker>>,
    pub limiter: Option<Arc<TokenBucket>>,
}

impl Fetcher {
    /// GET a URL (optionally a byte range) with retries and exponential backoff.
    pub async fn get(&self, url: &str, range: Option<ByteRange>) -> Result<Bytes> {
        let mut attempt = 0u32;
        loop {
            match self.try_get(url, range).await {
                Ok(b) => return Ok(b),
                Err(DownloadError::Cancelled) => return Err(DownloadError::Cancelled),
                Err(e) => {
                    if !e.is_retryable() || attempt >= self.max_retries {
                        return Err(e);
                    }
                    let wait = self
                        .retry_base_delay
                        .saturating_mul(1u32 << attempt.min(6))
                        .min(Duration::from_secs(30));
                    attempt += 1;
                    tokio::select! {
                        _ = self.cancel.cancelled() => return Err(DownloadError::Cancelled),
                        _ = tokio::time::sleep(wait) => {}
                    }
                }
            }
        }
    }

    pub async fn get_text(&self, url: &str) -> Result<String> {
        let b = self.get(url, None).await?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    async fn try_get(&self, url: &str, range: Option<ByteRange>) -> Result<Bytes> {
        let spec = self.spec.derive(url);
        let hdr = range.map(|r| r.header_value());
        let resp = tokio::select! {
            _ = self.cancel.cancelled() => return Err(DownloadError::Cancelled),
            r = spec.send(&self.client, hdr.as_deref()) => r?,
        };
        let status = resp.status();
        if !status.is_success() {
            return Err(DownloadError::Status(status.as_u16()));
        }
        if let (Some(r), 200) = (range, status.as_u16()) {
            // Server ignored the range: slice what we need from the full body.
            let full = self.read_body(resp, false).await?;
            let start = r.offset as usize;
            let end = (r.offset + r.length) as usize;
            if end > full.len() {
                return Err(DownloadError::Network("short body for byte range".into()));
            }
            return Ok(full.slice(start..end));
        }
        self.read_body(resp, true).await
    }

    async fn read_body(&self, resp: reqwest::Response, count: bool) -> Result<Bytes> {
        let mut stream = resp.bytes_stream();
        let mut out = BytesMut::new();
        loop {
            let next = tokio::select! {
                _ = self.cancel.cancelled() => return Err(DownloadError::Cancelled),
                n = stream.next() => n,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk?;
            if let Some(l) = &self.limiter {
                l.acquire(chunk.len()).await;
            }
            if count {
                if let Some(t) = &self.tracker {
                    t.add(chunk.len() as u64);
                }
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out.freeze())
    }
}
