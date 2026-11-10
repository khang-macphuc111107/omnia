//! Read-only, process-bound metrics seam for the native Rust boundary.
//!
//! This module deliberately reports only observations that can be tied to the
//! current process. Windows RSS uses a read-only process API; metrics without a
//! provider remain `Unsupported`. No estimate substitutes for an unavailable
//! measurement. A working-set observation alone does not establish idle state.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
mod windows_process {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    type Handle = *mut c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
    }

    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: Handle,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    pub(super) fn working_set_bytes() -> Result<u64, String> {
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            ..Default::default()
        };
        let size = counters.cb;
        // SAFETY: the pseudo-handle is supplied by the OS and the output
        // buffer is initialized with its documented size.
        let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
        if ok == 0 {
            return Err(format!(
                "GetProcessMemoryInfo failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        u64::try_from(counters.working_set_size)
            .map_err(|_| "working-set size exceeded u64".to_string())
    }
}

pub const COLLECTOR_ID: &str = "NATIVE-WINDOWS-COLLECTOR-001";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Metric<T> {
    Observed(T),
    Unsupported { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub executable: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectorSnapshot {
    pub collector_id: String,
    pub schema_version: u32,
    pub identity: ProcessIdentity,
    pub wall_clock_unix_ms: u128,
    pub monotonic_elapsed_ns: u128,
    pub idle_rss_bytes: Metric<u64>,
    pub cpu_percent: Metric<u32>,
    pub gpu_percent: Metric<u32>,
    pub input_latency_p95_ms: Metric<u64>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectorError {
    Disabled,
    ClockBeforeEpoch,
}

/// Collect a snapshot when the caller has explicitly enabled the native
/// collector.  The `started_at` instant should be captured by the caller at
/// process launch; using it preserves a monotonic, non-wall-clock duration.
pub fn collect(enabled: bool, started_at: Instant) -> Result<CollectorSnapshot, CollectorError> {
    if !enabled {
        return Err(CollectorError::Disabled);
    }

    let wall_clock_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| CollectorError::ClockBeforeEpoch)?
        .as_millis();
    let monotonic_elapsed_ns = started_at.elapsed().as_nanos();
    let executable = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    });

    #[cfg(windows)]
    let rss = windows_process::working_set_bytes()
        .map(Metric::Observed)
        .unwrap_or_else(|reason| Metric::Unsupported { reason });
    #[cfg(not(windows))]
    let rss = Metric::Unsupported {
        reason: "Windows process provider is unavailable on this target".to_string(),
    };
    let unsupported_reason =
        "CPU requires two process-time samples; GPU/input providers are not enabled".to_string();
    Ok(CollectorSnapshot {
        collector_id: COLLECTOR_ID.to_string(),
        schema_version: SCHEMA_VERSION,
        identity: ProcessIdentity {
            pid: std::process::id(),
            executable,
        },
        wall_clock_unix_ms,
        monotonic_elapsed_ns,
        idle_rss_bytes: rss,
        cpu_percent: Metric::Unsupported {
            reason: unsupported_reason.clone(),
        },
        gpu_percent: Metric::Unsupported {
            reason: unsupported_reason.clone(),
        },
        input_latency_p95_ms: Metric::Unsupported {
            reason: unsupported_reason,
        },
        limitations: vec![
            "Process identity and monotonic timing are observed locally.".to_string(),
            "RSS uses the Windows psapi working-set provider when running on Windows."
                .to_string(),
            "The legacy idle_rss_bytes field is an instantaneous working set; caller must establish idle state separately."
                .to_string(),
            "CPU requires paired process-time samples; GPU/input providers remain unsupported."
                .to_string(),
            "This receipt does not prove packaged Windows performance or native promotion."
                .to_string(),
        ],
    })
}

/// A small helper for callers that need a stable monotonic sample interval.
pub fn elapsed_since(started_at: Instant) -> Duration {
    started_at.elapsed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_collection_is_fail_closed() {
        let result = collect(false, Instant::now());
        assert_eq!(result, Err(CollectorError::Disabled));
    }

    #[test]
    fn enabled_collection_binds_identity_and_monotonic_clock() {
        let started = Instant::now();
        let snapshot = collect(true, started).expect("enabled collector");
        assert_eq!(snapshot.collector_id, COLLECTOR_ID);
        assert_eq!(snapshot.schema_version, SCHEMA_VERSION);
        assert_eq!(snapshot.identity.pid, std::process::id());
        assert!(snapshot.monotonic_elapsed_ns < 10_000_000_000);
        #[cfg(windows)]
        assert!(matches!(snapshot.idle_rss_bytes, Metric::Observed(bytes) if bytes > 0));
        assert!(matches!(snapshot.gpu_percent, Metric::Unsupported { .. }));
        assert!(matches!(
            snapshot.input_latency_p95_ms,
            Metric::Unsupported { .. }
        ));
        println!(
            "PROCESS_SNAPSHOT={}",
            serde_json::to_string(&snapshot).expect("serialize process observation")
        );
    }

    #[test]
    fn monotonic_elapsed_never_uses_wall_clock() {
        let started = Instant::now();
        std::thread::sleep(Duration::from_millis(1));
        assert!(elapsed_since(started) >= Duration::from_millis(1));
    }
}
