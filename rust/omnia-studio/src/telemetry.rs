//! Process, binary, and Rust workspace telemetry helpers.

use std::collections::HashSet;
use std::env;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

/// Compiler version identifier emitted in `/api/health`.
pub const RUSTC_VERSION_LABEL: &str = "rustc 1.100.0";
/// Default fallback member count matching Omnia's 17-crate workspace.
pub const DEFAULT_WORKSPACE_CRATE_COUNT: usize = 17;

/// Resolves the live `rustc` version string (cached via `OnceLock`, falling back cleanly).
#[must_use]
pub fn detect_rustc_version() -> &'static str {
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| {
            let mut cmd = std::process::Command::new("rustc");
            cmd.arg("--version");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| RUSTC_VERSION_LABEL.to_string())
        })
        .as_str()
}

/// Returns `true` if `meta` represents a symlink or Windows NTFS reparse point (`0x400`).
#[must_use]
pub fn is_reparse_or_symlink(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    false
}

/// Queries the current process working set size in bytes via Win32 `GetProcessMemoryInfo`.
#[cfg(windows)]
#[allow(unsafe_code)]
#[must_use]
pub fn query_working_set_bytes() -> u64 {
    use core::mem::{size_of, zeroed};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: `counters` is stack-allocated and zero-initialized with `cb` set to the exact byte
    // size of `PROCESS_MEMORY_COUNTERS`, and `GetCurrentProcess()` returns a valid pseudo-handle
    // for the calling process.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = zeroed();
        counters.cb = u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS>()).unwrap_or(0);
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0 {
            u64::try_from(counters.WorkingSetSize).unwrap_or(u64::MAX)
        } else {
            0
        }
    }
}

/// Fallback working set query for non-Windows targets.
#[cfg(not(windows))]
#[must_use]
pub fn query_working_set_bytes() -> u64 {
    0
}

/// Returns the byte length of the currently running executable image (`0` if unavailable).
#[must_use]
pub fn query_current_binary_bytes() -> u64 {
    let Ok(exe_path) = env::current_exe() else {
        return 0;
    };
    fs::symlink_metadata(exe_path)
        .map(|meta| meta.len())
        .unwrap_or(0)
}

/// Counts live `.rs` files under `workspace_root/rust` without traversing symlinks,
/// NTFS reparse points, `.git`, `target`, or build directories.
#[must_use]
pub fn count_rust_files(workspace_root: &Path) -> usize {
    let rust_dir = workspace_root.join("rust");
    let Ok(root_meta) = fs::symlink_metadata(&rust_dir) else {
        return 0;
    };
    if is_reparse_or_symlink(&root_meta) || !root_meta.is_dir() {
        return 0;
    }
    let Ok(canonical_rust_dir) = fs::canonicalize(&rust_dir) else {
        return 0;
    };

    let mut visited = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![canonical_rust_dir.clone()];
    let mut count = 0usize;

    while let Some(dir) = stack.pop() {
        if !visited.insert(dir.clone()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if is_excluded_walk_dir(name) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if is_reparse_or_symlink(&meta) {
                continue;
            }
            let Ok(canon) = fs::canonicalize(&path) else {
                continue;
            };
            if !canon.starts_with(&canonical_rust_dir) {
                continue;
            }
            if meta.is_dir() {
                stack.push(canon);
            } else if meta.is_file() && path.extension().and_then(|e| e.to_str()) == Some("rs") {
                count = count.saturating_add(1);
            }
        }
    }

    count
}

/// Discovers the Cargo workspace member crate count from `<workspace_root>/Cargo.toml`.
#[must_use]
pub fn discover_crate_count(workspace_root: &Path) -> usize {
    let cargo_toml = workspace_root.join("Cargo.toml");
    let Ok(meta) = fs::symlink_metadata(&cargo_toml) else {
        return DEFAULT_WORKSPACE_CRATE_COUNT;
    };
    if is_reparse_or_symlink(&meta) || !meta.is_file() {
        return DEFAULT_WORKSPACE_CRATE_COUNT;
    }
    let Ok(text) = fs::read_to_string(&cargo_toml) else {
        return DEFAULT_WORKSPACE_CRATE_COUNT;
    };
    let parsed = parse_workspace_members_count(&text);
    if parsed == 0 {
        DEFAULT_WORKSPACE_CRATE_COUNT
    } else {
        parsed
    }
}

fn parse_workspace_members_count(text: &str) -> usize {
    let mut in_members = false;
    let mut count = 0usize;
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.starts_with("members") && line.contains('[') {
            in_members = true;
        }
        if in_members {
            let mut rest = line;
            while let Some(start) = rest.find('"') {
                let after = &rest[start + 1..];
                if let Some(end) = after.find('"') {
                    if !after[..end].trim().is_empty() {
                        count += 1;
                    }
                    rest = &after[end + 1..];
                } else {
                    break;
                }
            }
            if line.contains(']') {
                break;
            }
        }
    }
    count
}

fn is_excluded_walk_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | "target" | "build" | "node_modules" | "__pycache__"
    )
}

/// Full statistical distribution summary (`min/p50/p90/p95/p99/max/mean/stdDev/iqr/outliers`).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDistribution {
    pub count: usize,
    pub min: Option<f64>,
    pub q1: Option<f64>,
    pub p50: Option<f64>,
    pub q3: Option<f64>,
    pub p90: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub std_dev: Option<f64>,
    pub iqr: Option<f64>,
    pub outlier_threshold_high: Option<f64>,
    pub outlier_count: usize,
}

fn round_metric(v: f64, decimals: i32) -> f64 {
    let scale = 10f64.powi(decimals);
    (v * scale).round() / scale
}

fn percentile_sorted(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let pct = p.clamp(0.0, 100.0) / 100.0;
    let idx = pct * ((sorted.len() - 1) as f64);
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        Some(sorted[lo])
    } else {
        let frac = idx - (lo as f64);
        Some(sorted[lo] + (sorted[hi] - sorted[lo]) * frac)
    }
}

/// Computes exact percentiles, mean, standard deviation, IQR, and Tukey high-outlier count.
#[must_use]
pub fn compute_distribution(samples: &[f64], decimals: i32) -> StatDistribution {
    let mut clean: Vec<f64> = samples.iter().copied().filter(|v| v.is_finite()).collect();
    if clean.is_empty() {
        return StatDistribution::default();
    }
    clean.sort_by(|a, b| a.total_cmp(b));
    let n = clean.len();
    let sum: f64 = clean.iter().sum();
    let mean_raw = sum / (n as f64);
    let variance = if n > 1 {
        clean
            .iter()
            .map(|v| {
                let d = *v - mean_raw;
                d * d
            })
            .sum::<f64>()
            / (n as f64)
    } else {
        0.0
    };
    let std_raw = variance.sqrt();

    let q1_raw = percentile_sorted(&clean, 25.0).unwrap_or(clean[0]);
    let p50_raw = percentile_sorted(&clean, 50.0).unwrap_or(clean[0]);
    let q3_raw = percentile_sorted(&clean, 75.0).unwrap_or(clean[n - 1]);
    let p90_raw = percentile_sorted(&clean, 90.0).unwrap_or(clean[n - 1]);
    let p95_raw = percentile_sorted(&clean, 95.0).unwrap_or(clean[n - 1]);
    let p99_raw = percentile_sorted(&clean, 99.0).unwrap_or(clean[n - 1]);
    let iqr_raw = (q3_raw - q1_raw).max(0.0);
    let outlier_thr_raw = if n >= 4 {
        Some(q3_raw + 1.5 * iqr_raw)
    } else {
        None
    };
    let outlier_count = outlier_thr_raw
        .map(|thr| clean.iter().filter(|&&v| v > thr && thr > 0.0).count())
        .unwrap_or(0);

    StatDistribution {
        count: n,
        min: Some(round_metric(clean[0], decimals)),
        q1: Some(round_metric(q1_raw, decimals)),
        p50: Some(round_metric(p50_raw, decimals)),
        q3: Some(round_metric(q3_raw, decimals)),
        p90: Some(round_metric(p90_raw, decimals)),
        p95: Some(round_metric(p95_raw, decimals)),
        p99: Some(round_metric(p99_raw, decimals)),
        max: Some(round_metric(clean[n - 1], decimals)),
        mean: Some(round_metric(mean_raw, decimals)),
        std_dev: Some(round_metric(std_raw, decimals)),
        iqr: Some(round_metric(iqr_raw, decimals)),
        outlier_threshold_high: outlier_thr_raw.map(|t| round_metric(t, decimals)),
        outlier_count,
    }
}

/// Estimates KV-cache dollar savings (6-decimal USD) for `cache_read_tokens` on `model_id`.
#[must_use]
pub fn estimate_kv_cache_savings_usd(model_id: &str, cache_read_tokens: i64) -> f64 {
    if cache_read_tokens <= 0 {
        return 0.0;
    }
    let lower = model_id.to_ascii_lowercase();
    // (uncached input $/1M, cached read $/1M) conservative published reference rates
    let (uncached_per_m, cached_per_m): (f64, f64) = if lower.contains("opus") {
        (15.0, 1.5)
    } else if lower.contains("sonnet") || lower.contains("fable") {
        (3.0, 0.3)
    } else if lower.contains("haiku") {
        (0.8, 0.08)
    } else if lower.contains("gpt-6") || lower.contains("gpt-5") || lower.contains("codex") {
        (2.5, 0.25)
    } else if lower.contains("gemini") && lower.contains("flash") {
        (0.35, 0.035)
    } else if lower.contains("gemini") {
        (1.25, 0.125)
    } else if lower.contains("deepseek") || lower.contains("qwen") || lower.contains("glm") || lower.contains("kimi") {
        (0.55, 0.14)
    } else {
        (2.0, 0.2)
    };
    let delta_per_m = (uncached_per_m - cached_per_m).max(0.0);
    round_metric((cache_read_tokens as f64 / 1_000_000.0) * delta_per_m, 6)
}

/// SQLite database + WAL/SHM sidecar byte footprint descriptor.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteWalFileInfo {
    pub name: String,
    pub db_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub total_bytes: u64,
}

/// Inspects `*.db` + `-wal` / `-shm` byte sizes inside `data_dir` without traversing symlinks.
#[must_use]
pub fn inspect_sqlite_wal_files(data_dir: &Path) -> Vec<SqliteWalFileInfo> {
    let Ok(dir_meta) = fs::symlink_metadata(data_dir) else {
        return Vec::new();
    };
    if is_reparse_or_symlink(&dir_meta) || !dir_meta.is_dir() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(data_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !fname.to_ascii_lowercase().ends_with(".db") {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if is_reparse_or_symlink(&meta) || !meta.is_file() {
            continue;
        }
        let db_bytes = meta.len();
        let wal_path = PathBuf::from(format!("{}-wal", path.display()));
        let shm_path = PathBuf::from(format!("{}-shm", path.display()));
        let wal_bytes = fs::symlink_metadata(&wal_path)
            .ok()
            .filter(|m| !is_reparse_or_symlink(m) && m.is_file())
            .map(|m| m.len())
            .unwrap_or(0);
        let shm_bytes = fs::symlink_metadata(&shm_path)
            .ok()
            .filter(|m| !is_reparse_or_symlink(m) && m.is_file())
            .map(|m| m.len())
            .unwrap_or(0);
        out.push(SqliteWalFileInfo {
            name: fname.to_string(),
            db_bytes,
            wal_bytes,
            shm_bytes,
            total_bytes: db_bytes.saturating_add(wal_bytes).saturating_add(shm_bytes),
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.total_bytes));
    out
}

#[cfg(test)]
mod telemetry_stats_tests {
    use super::*;

    #[test]
    fn distribution_computes_percentiles_iqr_and_outliers() {
        let samples = vec![100.0, 110.0, 120.0, 130.0, 140.0, 150.0, 900.0];
        let dist = compute_distribution(&samples, 2);
        assert_eq!(dist.count, 7);
        assert_eq!(dist.min, Some(100.0));
        assert_eq!(dist.p50, Some(130.0));
        assert_eq!(dist.max, Some(900.0));
        assert!(dist.p95.unwrap() > 150.0);
        assert!(dist.iqr.unwrap() > 0.0);
        assert_eq!(dist.outlier_count, 1);
    }

    #[test]
    fn kv_savings_scales_precisely_to_six_decimals() {
        let saved = estimate_kv_cache_savings_usd("claude-sonnet-5-5", 100_000);
        assert!((saved - 0.27).abs() < 1e-6);
        assert_eq!(estimate_kv_cache_savings_usd("gpt-6.2-sol", 0), 0.0);
    }
}
