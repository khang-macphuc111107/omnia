//! Windows-safe path normalization and strict fail-closed workspace containment guards.
//!
//! Strips Win32 verbatim drive prefixes (`\\?\<A-Z>:\`), rejects `..` escapes,
//! UNC/SMB paths (`\\server\share`, `\\?\UNC\...`), NT device namespaces (`\\.\`,
//! `\\?\Device\`, `\\?\GLOBALROOT`, `\\?\Pipe`, `\\?\Volume{...}`, `\\?\PhysicalDrive*`),
//! NTFS Alternate Data Streams (`file::$DATA`), Windows reserved device names
//! (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`), symlinks, NTFS reparse
//! points/junctions (`0x0400`), and dangling links whose targets cannot be verified
//! via fail-closed `fs::canonicalize` inside the workspace root.

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Strip Windows verbatim path prefixes (`\\?\` and `\\?\UNC\`).
#[must_use]
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// Best-effort canonicalize for display/non-security normalization.
/// Security boundaries MUST use `canonicalize_strict` (fail-closed) instead.
#[must_use]
pub fn sanitize_windows_path(path: &Path) -> PathBuf {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim_prefix(&resolved)
}

/// Fail-closed canonicalization: returns `Err` whenever `fs::canonicalize` fails
/// (never falls back to an unverified path!).
fn canonicalize_strict(path: &Path) -> Result<PathBuf> {
    let resolved = fs::canonicalize(path)
        .with_context(|| format!("fail-closed canonicalize failed for {}", path.display()))?;
    Ok(strip_verbatim_prefix(&resolved))
}

/// Strict check that a verbatim `\\?\` prefix is ONLY an ASCII drive prefix (`\\?\C:\...`).
fn is_valid_verbatim_drive_prefix(norm_backslash: &str) -> bool {
    let b = norm_backslash.as_bytes();
    b.len() >= 7
        && &b[..4] == br"\\?\"
        && b[4].is_ascii_alphabetic()
        && b[5] == b':'
        && b[6] == b'\\'
}

/// Reject UNC paths, Win32 device namespaces, NTFS Alternate Data Streams, and
/// Windows reserved device filenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`).
fn validate_raw_path_hygiene(raw_trimmed: &str) -> Result<()> {
    if raw_trimmed.is_empty() {
        bail!("empty path blocked");
    }
    if raw_trimmed.contains('\0') {
        bail!("null byte in path blocked");
    }

    let norm_slashes = raw_trimmed.replace('/', "\\");
    if norm_slashes.starts_with(r"\??\") {
        bail!("NT object namespace path blocked: {raw_trimmed}");
    }
    if norm_slashes.starts_with(r"\\?\") {
        if !is_valid_verbatim_drive_prefix(&norm_slashes) {
            bail!("non-drive verbatim/device namespace path blocked: {raw_trimmed}");
        }
    } else if norm_slashes.starts_with(r"\\") {
        bail!("UNC or Win32 device namespace path blocked: {raw_trimmed}");
    }

    // Reject NTFS Alternate Data Streams (`:` anywhere outside a leading drive prefix `C:`)
    let after_drive = if norm_slashes.starts_with(r"\\?\") {
        &norm_slashes[6..]
    } else {
        let b = norm_slashes.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            &norm_slashes[2..]
        } else {
            &norm_slashes[..]
        }
    };
    if after_drive.contains(':') {
        bail!("NTFS Alternate Data Stream / embedded colon blocked: {raw_trimmed}");
    }

    // Reject Windows reserved device filenames on EVERY path component
    // (including with extensions like `CON.txt`, `nul.py`, or trailing spaces/dots).
    for segment in after_drive.split('\\') {
        let s = segment.trim_end_matches([' ', '.']);
        if s.is_empty() || s == "." || s == ".." {
            continue;
        }
        let stem = s.split('.').next().unwrap_or(s);
        let upper = stem.to_ascii_uppercase();
        if matches!(
            upper.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        ) {
            bail!("Windows reserved device name blocked: {raw_trimmed}");
        }
    }

    Ok(())
}

/// Validate a workspace directory root itself (non-UNC, non-device, existing directory,
/// fail-closed canonicalized). Used by ACP and CLI session entrypoints.
pub fn validate_workspace_dir(path: &Path) -> Result<PathBuf> {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim();
    validate_raw_path_hygiene(trimmed)?;
    let canon = canonicalize_strict(Path::new(trimmed))?;
    if !canon.is_dir() {
        bail!("workspace path is not an existing directory: {}", canon.display());
    }
    Ok(canon)
}

/// Strictly validate that `rel_path` stays inside `workspace_root` (blocking `..`
/// escapes, UNC/NT device namespaces, NTFS ADS, Windows reserved device names,
/// absolute outside paths, symlinks, NTFS junctions, and dangling/uncanonicalizable links).
pub fn ensure_within_workspace(workspace_root: &Path, rel_path: &str) -> Result<PathBuf> {
    let trimmed = rel_path.trim();
    validate_raw_path_hygiene(trimmed)?;

    let root = validate_workspace_dir(workspace_root)?;

    let candidate_rel = Path::new(trimmed);
    let mut normalized = if candidate_rel.is_absolute() {
        let stripped = strip_verbatim_prefix(candidate_rel);
        let mut acc = PathBuf::new();
        for comp in stripped.components() {
            match comp {
                Component::Prefix(p) => acc.push(p.as_os_str()),
                Component::RootDir => acc.push(comp.as_os_str()),
                Component::CurDir => {}
                Component::Normal(part) => acc.push(part),
                Component::ParentDir => {
                    if !acc.pop() {
                        bail!("path traversal blocked: {trimmed}");
                    }
                }
            }
        }
        acc
    } else {
        let mut acc = root.clone();
        for comp in candidate_rel.components() {
            match comp {
                Component::CurDir => {}
                Component::Normal(part) => acc.push(part),
                Component::ParentDir => {
                    if !acc.pop() || !acc.starts_with(&root) {
                        bail!("path traversal blocked: {trimmed}");
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    bail!("invalid path component in relative path: {trimmed}");
                }
            }
        }
        acc
    };

    if !normalized.starts_with(&root) {
        bail!(
            "path {} escapes workspace {}",
            normalized.display(),
            root.display()
        );
    }

    // Reject dangling, inaccessible, or escaping symlinks / NTFS reparse points on EVERY component.
    if let Ok(rel_under_root) = normalized.strip_prefix(&root) {
        let mut cursor = root.clone();
        for comp in rel_under_root.components() {
            if let Component::Normal(part) = comp {
                cursor.push(part);
                if let Ok(meta) = fs::symlink_metadata(&cursor) {
                    if is_symlink_or_reparse_point(&meta) {
                        if !cursor.exists() {
                            bail!(
                                "dangling symlink/junction blocked (cannot verify containment): {}",
                                cursor.display()
                            );
                        }
                        let canon = canonicalize_strict(&cursor)?;
                        if !canon.starts_with(&root) {
                            bail!(
                                "symlink/junction target {} escapes workspace {}",
                                canon.display(),
                                root.display()
                            );
                        }
                    }
                }
            }
        }
    }

    if normalized.exists() {
        let canonical = canonicalize_strict(&normalized)?;
        if !canonical.starts_with(&root) {
            bail!(
                "symlink target {} escapes workspace {}",
                canonical.display(),
                root.display()
            );
        }
        return Ok(canonical);
    }

    // For non-existent write targets, validate the nearest existing ancestor fail-closed.
    let mut ancestor = normalized.clone();
    while !ancestor.exists() {
        if !ancestor.pop() {
            bail!("invalid target path: {trimmed}");
        }
    }
    let canon_ancestor = canonicalize_strict(&ancestor)?;
    if !canon_ancestor.starts_with(&root) {
        bail!("target ancestor escapes workspace: {trimmed}");
    }

    if let Ok(tail) = normalized.strip_prefix(&ancestor) {
        normalized = canon_ancestor.join(tail);
    }
    if !normalized.starts_with(&root) {
        bail!(
            "resolved path {} escapes workspace {}",
            normalized.display(),
            root.display()
        );
    }

    Ok(normalized)
}

fn is_symlink_or_reparse_point(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_verbatim_prefixes() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\C:\Users\dev\repo")),
            PathBuf::from(r"C:\Users\dev\repo")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\dir")),
            PathBuf::from(r"\\server\share\dir")
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"C:\normal\path")),
            PathBuf::from(r"C:\normal\path")
        );
    }

    #[test]
    fn blocks_workspace_path_traversal_devices_ads_and_reserved_names() {
        let tmp = std::env::temp_dir().join(format!("omnia_path_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("sub")).unwrap();
        let ok = ensure_within_workspace(&tmp, "  sub/file.txt  ").unwrap();
        assert!(ok.ends_with(Path::new("sub").join("file.txt")));

        for bad in [
            "../outside.txt",
            "sub/../../outside.txt",
            r"\\server\share\secret.txt",
            r"\\?\GLOBALROOT\Device\Harddisk0",
            r"\\?\Device\HarddiskVolume1\Windows",
            r"\\?\PhysicalDrive0",
            r"\\?\BootPartition",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\x",
            r"\\.\Pipe\evil",
            r"\??\C:\Windows\System32",
            "sub/file.txt::$DATA",
            "CON",
            "sub/NUL.py",
            "COM1.txt",
            "LPT9",
            "aux",
        ] {
            assert!(
                ensure_within_workspace(&tmp, bad).is_err(),
                "MUST reject dangerous path: {bad}"
            );
        }

        assert!(validate_workspace_dir(Path::new(r"\\server\share\repo")).is_err());
        assert!(validate_workspace_dir(&tmp).is_ok());

        let _ = fs::remove_dir_all(&tmp);
    }
}
