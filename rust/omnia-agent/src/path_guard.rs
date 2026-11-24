//! Canonical Workspace Path Guard — delegates containment, verbatim stripping,
//! and Win32 reparse-point safety directly to `omnia_workspace_ops::path_guard`.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

/// Strip Windows extended-length path prefix (`\\?\` or `\\?\UNC\`) so tool paths stay consistent.
#[must_use]
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    omnia_workspace_ops::path_guard::strip_verbatim_drive_prefix(path)
}

/// Normalize a path string or `Path` cleanly on Windows without exposing `\\?\` UNC prefixes.
#[must_use]
pub fn sanitize_windows_path(path: &Path) -> PathBuf {
    let stripped = strip_verbatim_prefix(path);
    if stripped.as_os_str().is_empty() {
        return PathBuf::from(".");
    }
    let abs = if stripped.is_absolute() {
        stripped
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(stripped)
    };
    let clean = std::fs::canonicalize(&abs).unwrap_or(abs);
    strip_verbatim_prefix(&clean)
}

/// Canonicalizes and verifies an existing workspace root directory (rejecting reparse points/junctions).
pub fn validate_workspace_dir(path: &Path) -> Result<PathBuf> {
    omnia_workspace_ops::path_guard::resolve_workspace_root(path)
        .map(|p| strip_verbatim_prefix(&p))
        .map_err(|e| anyhow::anyhow!(e))
}

/// Resolves `rel_path` strictly inside `workspace_root`, rejecting path traversal (`..`),
/// Windows NUL bytes, ADS `:stream` suffixes, and symlink/junction reparse points.
pub fn ensure_within_workspace(workspace_root: &Path, rel_path: &str) -> Result<PathBuf> {
    let trimmed = rel_path.trim();
    if trimmed.is_empty() {
        bail!("relative path must not be empty");
    }
    if trimmed.contains('\0') {
        bail!("path contains invalid NUL byte");
    }
    // Reject Windows Alternate Data Streams outside drive letters (`C:\...`).
    let check_ads = if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        &trimmed[2..]
    } else {
        trimmed
    };
    if check_ads.contains(':') {
        bail!("Windows alternate data stream (`:`) not permitted in `{rel_path}`");
    }

    let resolved = omnia_workspace_ops::path_guard::resolve_contained_path(workspace_root, trimmed)
        .with_context(|| format!("path containment check failed for `{rel_path}`"))?;
    Ok(strip_verbatim_prefix(&resolved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_resolves_clean_contained_path() {
        let base = std::env::temp_dir().join(format!("omnia_pg_{}", std::process::id()));
        let _ = std::fs::create_dir_all(base.join("src"));
        assert!(ensure_within_workspace(&base, "../outside.txt").is_err());
        assert!(ensure_within_workspace(&base, "file.txt:ads").is_err());
        let ok = ensure_within_workspace(&base, "src/lib.rs").expect("contained");
        assert!(ok.ends_with("src\\lib.rs") || ok.ends_with("src/lib.rs"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
