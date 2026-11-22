//! Canonical workspace-root containment and Windows reparse-point non-traversal guards.

use crate::{io_err, WorkspaceOpsError};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf, Prefix};

/// Win32 file attribute bit indicating an NTFS symlink, mount point, or directory junction.
pub const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// Returns `true` if `meta` identifies a symlink or Windows NTFS reparse point (`0x400`).
pub fn is_reparse_point_metadata(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || meta.file_type().is_symlink()
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// Inspects `path` without following symlinks/junctions and reports whether it is a reparse point.
pub fn is_reparse_point(path: impl AsRef<Path>) -> Result<bool, WorkspaceOpsError> {
    let p = path.as_ref();
    let meta = fs::symlink_metadata(p).map_err(|e| io_err("symlink_metadata", p, e))?;
    Ok(is_reparse_point_metadata(&meta))
}

/// Strips the Windows verbatim disk prefix (`\\?\C:\...`) returned by `std::fs::canonicalize`,
/// leaving standard drive-letter paths (`C:\...`). Verbatim UNC paths are left untouched.
pub fn strip_verbatim_drive_prefix(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            let bytes = rest.as_bytes();
            if bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'\\' || bytes[2] == b'/')
            {
                return PathBuf::from(rest);
            }
        }
        path.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

/// Validates and canonicalizes a workspace root directory, rejecting reparse points and non-dirs.
pub fn resolve_workspace_root(root: impl AsRef<Path>) -> Result<PathBuf, WorkspaceOpsError> {
    let root_path = root.as_ref();
    ensure_no_nul(root_path.as_os_str(), "workspace_root")?;
    let raw = root_path.to_string_lossy();
    if raw.is_empty() {
        return Err(WorkspaceOpsError::EmptyPath);
    }

    // Reject device / UNC prefixes on root; allow `\\?\X:\...` only to strip an already-canonicalized root.
    if raw.starts_with(r"\\.\") || raw.starts_with(r"//./") {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.into_owned(),
            reason: "windows_device_prefix",
        });
    }
    if raw.starts_with(r"\\?\UNC\") || raw.starts_with(r"//?/UNC/") {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.into_owned(),
            reason: "unc_network_prefix",
        });
    }

    let cleaned_input = strip_verbatim_drive_prefix(root_path);
    let cleaned_raw = cleaned_input.to_string_lossy();
    if cleaned_raw.starts_with(r"\\?\")
        || cleaned_raw.starts_with(r"//?/")
        || cleaned_raw.starts_with(r"\\")
        || cleaned_raw.starts_with(r"//")
    {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.into_owned(),
            reason: "unc_or_verbatim_prefix",
        });
    }

    let meta = fs::symlink_metadata(&cleaned_input)
        .map_err(|e| io_err("symlink_metadata", &cleaned_input, e))?;
    if is_reparse_point_metadata(&meta) {
        return Err(WorkspaceOpsError::ReparsePointDetected {
            path: cleaned_input.display().to_string(),
        });
    }
    if !meta.is_dir() {
        return Err(WorkspaceOpsError::NotADirectory {
            path: cleaned_input.display().to_string(),
        });
    }

    let canonical =
        fs::canonicalize(&cleaned_input).map_err(|e| io_err("canonicalize", &cleaned_input, e))?;
    let canonical_clean = strip_verbatim_drive_prefix(&canonical);

    let canonical_meta = fs::symlink_metadata(&canonical_clean)
        .map_err(|e| io_err("symlink_metadata", &canonical_clean, e))?;
    if is_reparse_point_metadata(&canonical_meta) {
        return Err(WorkspaceOpsError::ReparsePointDetected {
            path: canonical_clean.display().to_string(),
        });
    }
    if !canonical_meta.is_dir() {
        return Err(WorkspaceOpsError::NotADirectory {
            path: canonical_clean.display().to_string(),
        });
    }

    Ok(canonical_clean)
}

/// Resolves `candidate` (relative or contained absolute path) strictly inside `root`.
///
/// Rejects `..` traversal, NUL bytes, Windows `\\?\` / `\\.\` / UNC / drive-relative prefixes,
/// NTFS alternate data stream colons, trailing dots/spaces on segments, Windows reserved device
/// names, and any existing symlink or NTFS reparse point (`FILE_ATTRIBUTE_REPARSE_POINT = 0x400`).
pub fn resolve_contained_path(
    root: impl AsRef<Path>,
    candidate: impl AsRef<Path>,
) -> Result<PathBuf, WorkspaceOpsError> {
    let canonical_root = resolve_workspace_root(root)?;
    let cand_path = candidate.as_ref();
    ensure_no_nul(cand_path.as_os_str(), "candidate_path")?;

    let raw = cand_path.to_string_lossy();
    if raw.is_empty() {
        return Err(WorkspaceOpsError::EmptyPath);
    }

    reject_forbidden_raw_prefixes(&raw)?;

    let components: Vec<Component<'_>> = cand_path.components().collect();
    if components.is_empty() {
        return Err(WorkspaceOpsError::EmptyPath);
    }

    // Validate all components syntactically before touching the filesystem.
    let mut is_absolute_drive = false;
    let mut is_unix_rooted = false;
    for (idx, comp) in components.iter().enumerate() {
        match comp {
            Component::ParentDir => {
                return Err(WorkspaceOpsError::PathTraversal {
                    path: raw.into_owned(),
                });
            }
            Component::Prefix(prefix) => {
                if idx != 0 {
                    return Err(WorkspaceOpsError::ForbiddenPathPrefix {
                        path: raw.into_owned(),
                        reason: "misplaced_path_prefix",
                    });
                }
                match prefix.kind() {
                    Prefix::Disk(_) => {
                        if !matches!(components.get(1), Some(Component::RootDir)) {
                            return Err(WorkspaceOpsError::ForbiddenPathPrefix {
                                path: raw.into_owned(),
                                reason: "drive_relative_prefix",
                            });
                        }
                        is_absolute_drive = true;
                    }
                    Prefix::UNC(_, _) => {
                        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
                            path: raw.into_owned(),
                            reason: "unc_network_prefix",
                        });
                    }
                    Prefix::Verbatim(_)
                    | Prefix::VerbatimUNC(_, _)
                    | Prefix::VerbatimDisk(_)
                    | Prefix::DeviceNS(_) => {
                        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
                            path: raw.into_owned(),
                            reason: "windows_verbatim_or_device_prefix",
                        });
                    }
                }
            }
            Component::RootDir => {
                if idx == 0 {
                    is_unix_rooted = true;
                }
            }
            Component::CurDir => {}
            Component::Normal(seg) => {
                validate_normal_segment(seg, &raw)?;
            }
        }
    }

    let relative_segments: Vec<OsString> = if is_absolute_drive || is_unix_rooted {
        extract_relative_segments_from_absolute(&canonical_root, cand_path, &components, &raw)?
    } else {
        components
            .iter()
            .filter_map(|c| match c {
                Component::Normal(seg) => Some((*seg).to_os_string()),
                _ => None,
            })
            .collect()
    };

    walk_and_verify_non_reparse(&canonical_root, &relative_segments)
}

/// Returns a POSIX-style (`/`) workspace-relative path for `contained` inside `root`.
pub fn relative_posix_path(
    root: impl AsRef<Path>,
    contained: impl AsRef<Path>,
) -> Result<String, WorkspaceOpsError> {
    let canonical_root = resolve_workspace_root(root)?;
    let resolved = resolve_contained_path(&canonical_root, contained)?;
    let rel = resolved.strip_prefix(&canonical_root).map_err(|_| {
        WorkspaceOpsError::OutsideWorkspace {
            root: canonical_root.display().to_string(),
            candidate: resolved.display().to_string(),
        }
    })?;

    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();

    if parts.is_empty() {
        Ok(".".to_string())
    } else {
        Ok(parts.join("/"))
    }
}

/// Checks whether a candidate external directory (such as a rollback dir) lies outside `root`.
pub(crate) fn ensure_outside_workspace(
    canonical_root: &Path,
    external_dir: &Path,
) -> Result<PathBuf, WorkspaceOpsError> {
    ensure_no_nul(external_dir.as_os_str(), "rollback_dir")?;
    let raw = external_dir.to_string_lossy();
    if raw.is_empty() {
        return Err(WorkspaceOpsError::EmptyPath);
    }
    if raw.starts_with(r"\\.\") || raw.starts_with(r"//./") {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.into_owned(),
            reason: "windows_device_prefix",
        });
    }

    let clean_input = strip_verbatim_drive_prefix(external_dir);
    let abs_candidate = if clean_input.is_absolute() {
        clean_input
    } else {
        std::env::current_dir()
            .map_err(|e| io_err("current_dir", &clean_input, e))?
            .join(&clean_input)
    };

    let (existing_ancestor, tail) = split_longest_existing_ancestor(&abs_candidate);
    let resolved_ancestor = match existing_ancestor {
        Some(anc) => {
            let canon = fs::canonicalize(&anc).map_err(|e| io_err("canonicalize", &anc, e))?;
            strip_verbatim_drive_prefix(&canon)
        }
        None => abs_candidate.clone(),
    };

    let mut normalized = resolved_ancestor;
    for comp in tail {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(seg) => {
                normalized.push(seg);
            }
            _ => {}
        }
    }

    if normalized == canonical_root || normalized.starts_with(canonical_root) {
        return Err(WorkspaceOpsError::RollbackDirInsideWorkspace {
            root: canonical_root.display().to_string(),
            rollback_dir: normalized.display().to_string(),
        });
    }

    Ok(normalized)
}

fn ensure_no_nul(os_str: &OsStr, context: &'static str) -> Result<(), WorkspaceOpsError> {
    if os_str.as_encoded_bytes().contains(&0) {
        return Err(WorkspaceOpsError::NulByteInPath { context });
    }
    Ok(())
}

fn reject_forbidden_raw_prefixes(raw: &str) -> Result<(), WorkspaceOpsError> {
    if raw.starts_with(r"\\?\")
        || raw.starts_with(r"\\.\")
        || raw.starts_with(r"//?/")
        || raw.starts_with(r"//./")
    {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.to_string(),
            reason: "windows_verbatim_or_device_prefix",
        });
    }
    if raw.starts_with(r"\\") || raw.starts_with(r"//") {
        return Err(WorkspaceOpsError::ForbiddenPathPrefix {
            path: raw.to_string(),
            reason: "unc_network_prefix",
        });
    }
    Ok(())
}

fn validate_normal_segment(seg: &OsStr, full_raw: &str) -> Result<(), WorkspaceOpsError> {
    let s = seg.to_string_lossy();
    if s.contains(':') {
        return Err(WorkspaceOpsError::ForbiddenPathSegment {
            path: full_raw.to_string(),
            reason: "colon_or_alternate_data_stream",
        });
    }
    #[cfg(windows)]
    {
        if s.ends_with(' ') || (s.ends_with('.') && s != "." && s != "..") {
            return Err(WorkspaceOpsError::ForbiddenPathSegment {
                path: full_raw.to_string(),
                reason: "trailing_dot_or_space",
            });
        }
        let stem = s.split('.').next().unwrap_or("");
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
            return Err(WorkspaceOpsError::ForbiddenPathSegment {
                path: full_raw.to_string(),
                reason: "windows_reserved_device_name",
            });
        }
    }
    Ok(())
}

fn extract_relative_segments_from_absolute(
    canonical_root: &Path,
    cand_path: &Path,
    components: &[Component<'_>],
    raw: &str,
) -> Result<Vec<OsString>, WorkspaceOpsError> {
    // Walk prefixes of `cand_path` to locate the exact component boundary matching `canonical_root`.
    // Matching at the boundary rather than canonicalizing the whole candidate preserves any
    // intermediate symlink/junction inside the workspace so `walk_and_verify_non_reparse` catches it.
    let mut prefix_path = PathBuf::new();
    for (idx, comp) in components.iter().enumerate() {
        prefix_path.push(comp.as_os_str());
        if matches!(comp, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&prefix_path) {
            Ok(meta) => {
                let canon = match fs::canonicalize(&prefix_path) {
                    Ok(c) => strip_verbatim_drive_prefix(&c),
                    Err(_) => continue,
                };
                if canon == canonical_root {
                    if is_reparse_point_metadata(&meta) {
                        return Err(WorkspaceOpsError::ReparsePointDetected {
                            path: prefix_path.display().to_string(),
                        });
                    }
                    let tail: Vec<OsString> = components[idx + 1..]
                        .iter()
                        .filter_map(|c| match c {
                            Component::Normal(s) => Some((*s).to_os_string()),
                            _ => None,
                        })
                        .collect();
                    return Ok(tail);
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => break,
            Err(e) => return Err(io_err("symlink_metadata", &prefix_path, e)),
        }
    }

    Err(WorkspaceOpsError::OutsideWorkspace {
        root: canonical_root.display().to_string(),
        candidate: if raw.is_empty() {
            cand_path.display().to_string()
        } else {
            raw.to_string()
        },
    })
}

fn walk_and_verify_non_reparse(
    canonical_root: &Path,
    relative_segments: &[OsString],
) -> Result<PathBuf, WorkspaceOpsError> {
    let mut current = canonical_root.to_path_buf();
    let mut missing_tail: Vec<OsString> = Vec::new();
    let mut missing_started = false;

    for (idx, seg) in relative_segments.iter().enumerate() {
        let is_last = idx + 1 == relative_segments.len();
        if missing_started {
            missing_tail.push(seg.clone());
            continue;
        }

        current.push(seg);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if is_reparse_point_metadata(&meta) {
                    return Err(WorkspaceOpsError::ReparsePointDetected {
                        path: current.display().to_string(),
                    });
                }
                if !is_last && !meta.is_dir() {
                    return Err(WorkspaceOpsError::NotADirectory {
                        path: current.display().to_string(),
                    });
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                current.pop();
                missing_started = true;
                missing_tail.push(seg.clone());
            }
            Err(e) => return Err(io_err("symlink_metadata", &current, e)),
        }
    }

    let canonical_existing = strip_verbatim_drive_prefix(
        &fs::canonicalize(&current).map_err(|e| io_err("canonicalize", &current, e))?,
    );
    if canonical_existing != canonical_root && !canonical_existing.starts_with(canonical_root) {
        return Err(WorkspaceOpsError::OutsideWorkspace {
            root: canonical_root.display().to_string(),
            candidate: canonical_existing.display().to_string(),
        });
    }

    let mut result = canonical_existing;
    for seg in missing_tail {
        result.push(seg);
    }
    Ok(result)
}

fn split_longest_existing_ancestor(path: &Path) -> (Option<PathBuf>, Vec<Component<'_>>) {
    let mut current = path.to_path_buf();
    let mut popped_count = 0usize;
    loop {
        if current.exists() {
            let comps: Vec<Component<'_>> = path.components().collect();
            let split_at = comps.len().saturating_sub(popped_count);
            return (Some(current), comps[split_at..].to_vec());
        }
        if !current.pop() {
            return (None, path.components().collect());
        }
        popped_count += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    struct TempSandbox {
        base: PathBuf,
        root: PathBuf,
        outside: PathBuf,
        junctions: Vec<PathBuf>,
    }

    impl TempSandbox {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "omnia-ws-ops-{label}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            let root = base.join("workspace");
            let outside = base.join("outside");
            fs::create_dir_all(&root).expect("create workspace");
            fs::create_dir_all(&outside).expect("create outside");
            Self {
                base,
                root,
                outside,
                junctions: Vec::new(),
            }
        }
    }

    impl Drop for TempSandbox {
        fn drop(&mut self) {
            // Remove junctions first via `remove_dir` so directory targets are never traversed.
            for j in self.junctions.drain(..).rev() {
                let _ = fs::remove_dir(&j);
            }
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn rejects_parent_traversal_escape() {
        let sb = TempSandbox::new("traversal");
        for attempt in [
            "../outside",
            r"..\outside\secret.txt",
            "sub/../../outside/secret.txt",
            "sub/../file.txt",
        ] {
            let err = resolve_contained_path(&sb.root, attempt).expect_err("must reject traversal");
            assert!(
                matches!(err, WorkspaceOpsError::PathTraversal { .. }),
                "unexpected error for `{attempt}`: {err:?}"
            );
        }

        let abs_escape = sb.root.join("..").join("outside").join("secret.txt");
        let err = resolve_contained_path(&sb.root, &abs_escape).expect_err("must reject abs `..`");
        assert!(matches!(err, WorkspaceOpsError::PathTraversal { .. }));
    }

    #[test]
    fn rejects_nul_byte_in_path() {
        let sb = TempSandbox::new("nul");
        let err = resolve_contained_path(&sb.root, "src/\0lib.rs").expect_err("must reject NUL");
        assert!(matches!(err, WorkspaceOpsError::NulByteInPath { .. }));

        let bad_root = format!("{}\0bad", sb.root.display());
        let err =
            resolve_contained_path(&bad_root, "src/lib.rs").expect_err("must reject NUL in root");
        assert!(matches!(err, WorkspaceOpsError::NulByteInPath { .. }));
    }

    #[test]
    fn rejects_windows_verbatim_device_and_unc_paths() {
        let sb = TempSandbox::new("prefixes");
        let verbatim = format!(r"\\?\{}\inside.txt", sb.root.display());
        for (input, desc) in [
            (verbatim.as_str(), "verbatim disk"),
            (r"\\.\PhysicalDrive0", "device namespace"),
            (r"\\server\share\file.txt", "UNC backslash"),
            ("//server/share/file.txt", "UNC forward slash"),
            ("C:relative.txt", "drive-relative"),
        ] {
            let err =
                resolve_contained_path(&sb.root, input).expect_err(&format!("must reject {desc}"));
            assert!(
                matches!(err, WorkspaceOpsError::ForbiddenPathPrefix { .. }),
                "unexpected error for {desc}: {err:?}"
            );
        }

        let rooted = resolve_contained_path(&sb.root, "/etc/passwd")
            .expect_err("must reject non-drive rooted path");
        assert!(matches!(
            rooted,
            WorkspaceOpsError::OutsideWorkspace { .. }
                | WorkspaceOpsError::ForbiddenPathPrefix { .. }
        ));
    }

    #[test]
    fn rejects_alternate_data_stream_colon_and_reserved_names() {
        let sb = TempSandbox::new("segments");
        let err =
            resolve_contained_path(&sb.root, "notes.txt:hidden").expect_err("must reject ADS");
        assert!(matches!(
            err,
            WorkspaceOpsError::ForbiddenPathSegment { .. }
        ));

        #[cfg(windows)]
        {
            let err_con =
                resolve_contained_path(&sb.root, "sub/CON.txt").expect_err("must reject CON");
            assert!(matches!(
                err_con,
                WorkspaceOpsError::ForbiddenPathSegment { .. }
            ));

            let err_dot = resolve_contained_path(&sb.root, "file.txt.")
                .expect_err("must reject trailing dot");
            assert!(matches!(
                err_dot,
                WorkspaceOpsError::ForbiddenPathSegment { .. }
            ));
        }
    }

    #[test]
    fn allows_valid_relative_and_contained_absolute_paths() {
        let sb = TempSandbox::new("valid");
        let sub = sb.root.join("src");
        fs::create_dir_all(&sub).expect("mkdir src");
        let existing_file = sub.join("lib.rs");
        fs::write(&existing_file, "pub fn ok() {}\n").expect("write");

        let canonical_root = resolve_workspace_root(&sb.root).expect("canonical root");
        assert_eq!(
            resolve_contained_path(&sb.root, ".").expect("dot"),
            canonical_root
        );
        assert_eq!(
            resolve_contained_path(&sb.root, "./src/lib.rs").expect("rel existing"),
            canonical_root.join("src").join("lib.rs")
        );
        assert_eq!(
            resolve_contained_path(&sb.root, "src/new_dir/mod.rs").expect("rel new"),
            canonical_root.join("src").join("new_dir").join("mod.rs")
        );
        assert_eq!(
            resolve_contained_path(&sb.root, &existing_file).expect("abs contained"),
            canonical_root.join("src").join("lib.rs")
        );

        let outside_file = sb.outside.join("secret.txt");
        let err = resolve_contained_path(&sb.root, &outside_file).expect_err("outside rejected");
        assert!(matches!(err, WorkspaceOpsError::OutsideWorkspace { .. }));
    }

    #[test]
    fn rejects_reparse_point_junction_or_symlink() {
        let mut sb = TempSandbox::new("reparse");
        fs::write(sb.outside.join("secret.txt"), "top-secret\n").expect("write outside");
        let inside_real = sb.root.join("real");
        fs::create_dir_all(&inside_real).expect("mkdir real");
        fs::write(inside_real.join("inside.txt"), "ok\n").expect("write inside");

        let link_out = sb.root.join("link_out");
        let link_in = sb.root.join("link_in");

        #[cfg(windows)]
        let created = {
            let out_status = Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    &link_out.to_string_lossy(),
                    &sb.outside.to_string_lossy(),
                ])
                .output();
            let in_status = Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    &link_in.to_string_lossy(),
                    &inside_real.to_string_lossy(),
                ])
                .output();
            match (out_status, in_status) {
                (Ok(o1), Ok(o2)) if o1.status.success() && o2.status.success() => {
                    sb.junctions.push(link_out.clone());
                    sb.junctions.push(link_in.clone());
                    true
                }
                _ => match (
                    std::os::windows::fs::symlink_dir(&sb.outside, &link_out),
                    std::os::windows::fs::symlink_dir(&inside_real, &link_in),
                ) {
                    (Ok(()), Ok(())) => {
                        sb.junctions.push(link_out.clone());
                        sb.junctions.push(link_in.clone());
                        true
                    }
                    _ => false,
                },
            }
        };

        #[cfg(not(windows))]
        let created = {
            match (
                std::os::unix::fs::symlink(&sb.outside, &link_out),
                std::os::unix::fs::symlink(&inside_real, &link_in),
            ) {
                (Ok(()), Ok(())) => true,
                _ => false,
            }
        };

        if !created {
            eprintln!("skipping reparse traversal test: symlink/junction privilege unavailable");
            return;
        }

        assert!(is_reparse_point(&link_out).expect("reparse metadata"));

        // Both relative and absolute paths through an outside or inside junction must be rejected.
        let err_rel_out =
            resolve_contained_path(&sb.root, "link_out/secret.txt").expect_err("junction out");
        assert!(
            matches!(err_rel_out, WorkspaceOpsError::ReparsePointDetected { .. }),
            "expected ReparsePointDetected, got {err_rel_out:?}"
        );

        let err_rel_in =
            resolve_contained_path(&sb.root, "link_in/inside.txt").expect_err("junction in");
        assert!(
            matches!(err_rel_in, WorkspaceOpsError::ReparsePointDetected { .. }),
            "expected ReparsePointDetected, got {err_rel_in:?}"
        );

        let err_abs_in = resolve_contained_path(&sb.root, link_in.join("inside.txt"))
            .expect_err("abs junction in");
        assert!(matches!(
            err_abs_in,
            WorkspaceOpsError::ReparsePointDetected { .. }
        ));

        let err_root_junction =
            resolve_contained_path(&link_out, "secret.txt").expect_err("junction root");
        assert!(matches!(
            err_root_junction,
            WorkspaceOpsError::ReparsePointDetected { .. }
        ));
    }
}
