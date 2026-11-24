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
