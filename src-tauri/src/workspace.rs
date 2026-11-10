use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::Path,
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{NativeError, NativeResult};

const MAX_DIRECTORY_ENTRIES: usize = 2_000;
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: WorkspaceEntryKind,
    pub byte_size: Option<u64>,
    pub modified_at_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryListing {
    pub grant_id: String,
    pub relative_path: String,
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextFile {
    pub grant_id: String,
    pub relative_path: String,
    pub content: String,
    pub byte_size: u64,
    pub content_sha256: String,
}

pub fn list_directory(
    grant_id: &str,
    root: &Path,
    relative_path: Option<&str>,
) -> NativeResult<WorkspaceDirectoryListing> {
    let relative_path = normalize_relative_path(relative_path)?;
    reject_reparse_root(root)?;
    let canonical_root = dunce::canonicalize(root)
        .map_err(|error| NativeError::io("the workspace root cannot be verified", error))?;
    let directory = resolve_beneath_root(root, &relative_path, true)?;
    verify_directory_scope(root, &canonical_root, &directory)?;
    let directory_metadata = fs::symlink_metadata(&directory)
        .map_err(|error| NativeError::io("the workspace directory cannot be inspected", error))?;
    if is_reparse_point(&directory_metadata) || !directory_metadata.is_dir() {
        return Err(NativeError::invalid(
            "relativePath",
            "must identify a regular directory",
        ));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory)
        .map_err(|error| NativeError::io("the workspace directory cannot be read", error))?
    {
        let entry =
            entry.map_err(|error| NativeError::io("a workspace entry cannot be read", error))?;
        if let Some(entry) = workspace_entry(&canonical_root, entry.path()) {
            entries.push(entry?);
        }
    }
    // A directory handle is not retained by `read_dir`, so the path may be
    // replaced by a junction/reparse point while the listing is in flight.
    // Re-verify both the grant root and resolved directory before returning
    // any entries; otherwise a swapped parent could disclose metadata from
    // outside the granted scope.
    verify_directory_scope(root, &canonical_root, &directory)?;
    entries.sort_by(|left, right| {
        let left_rank = matches!(left.kind, WorkspaceEntryKind::File);
        let right_rank = matches!(right.kind, WorkspaceEntryKind::File);
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let truncated = entries.len() > MAX_DIRECTORY_ENTRIES;
    entries.truncate(MAX_DIRECTORY_ENTRIES);
    Ok(WorkspaceDirectoryListing {
        grant_id: grant_id.to_owned(),
        relative_path: display_relative_path(&relative_path),
        entries,
        truncated,
    })
}

pub fn read_text_file(
    grant_id: &str,
    root: &Path,
    relative_path: &str,
) -> NativeResult<WorkspaceTextFile> {
    let relative_path = normalize_relative_path(Some(relative_path))?;
    if relative_path.as_os_str().is_empty() {
        return Err(NativeError::invalid("relativePath", "cannot be empty"));
    }
    reject_reparse_root(root)?;
    let file_path = resolve_beneath_root(root, &relative_path, true)?;
    let lexical_metadata = fs::symlink_metadata(&file_path)
        .map_err(|error| NativeError::io("the workspace file cannot be accessed", error))?;
    if is_reparse_point(&lexical_metadata) || !lexical_metadata.is_file() {
        return Err(NativeError::invalid(
            "relativePath",
            "must identify a regular file",
        ));
    }
    if lexical_metadata.len() > MAX_READ_BYTES {
        return Err(NativeError::new(
            "file_too_large",
            format!("The file exceeds the {MAX_READ_BYTES}-byte chat preview limit"),
        ));
    }

    let mut file = open_read_without_following_final_reparse_point(&file_path)
        .map_err(|error| NativeError::io("the workspace file cannot be read", error))?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| NativeError::io("the workspace file cannot be inspected", error))?;
    if is_reparse_point(&opened_metadata)
        || !opened_metadata.is_file()
        || opened_metadata.len() != lexical_metadata.len()
        || metadata_changed(&lexical_metadata, &opened_metadata)
    {
        return Err(NativeError::new(
            "workspace_file_changed",
            "The workspace file changed while it was being opened",
        ));
    }
    let declared_len = usize::try_from(opened_metadata.len()).map_err(|_| {
        NativeError::new(
            "file_too_large",
            "The file size cannot be represented safely",
        )
    })?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(declared_len).map_err(|_| {
        NativeError::retryable(
            "workspace_read_allocation_failed",
            "There is not enough memory to preview this workspace file",
        )
    })?;
    file.by_ref()
        .take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| NativeError::io("the workspace file cannot be read", error))?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(NativeError::new(
            "file_too_large",
            format!("The file exceeds the {MAX_READ_BYTES}-byte chat preview limit"),
        ));
    }

    let after_metadata = fs::symlink_metadata(&file_path).map_err(|_| {
        NativeError::new(
            "workspace_file_changed",
            "The workspace file changed while it was being read",
        )
    })?;
    let canonical_root = dunce::canonicalize(root)
        .map_err(|error| NativeError::io("the workspace root cannot be verified", error))?;
    let canonical_after = dunce::canonicalize(&file_path).map_err(|_| {
        NativeError::new(
            "workspace_file_changed",
            "The workspace file changed while it was being read",
        )
    })?;
    if is_reparse_point(&after_metadata)
        || canonical_after != file_path
        || !canonical_after.starts_with(&canonical_root)
        || metadata_changed(&lexical_metadata, &after_metadata)
        || metadata_changed(&opened_metadata, &after_metadata)
    {
        return Err(NativeError::new(
            "workspace_file_changed",
            "The workspace file changed while it was being read",
        ));
    }
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return Err(NativeError::new(
            "binary_file",
            "The selected file is binary and cannot be opened as text",
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            "unsupported_encoding",
            "The selected file is not valid UTF-8 text",
        )
    })?;
    let content_sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok(WorkspaceTextFile {
        grant_id: grant_id.to_owned(),
        relative_path: display_relative_path(&relative_path),
        content,
        byte_size: opened_metadata.len(),
        content_sha256,
    })
}

fn workspace_entry(root: &Path, path: std::path::PathBuf) -> Option<NativeResult<WorkspaceEntry>> {
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    let relative_path = path.strip_prefix(root).ok()?.to_path_buf();
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Some(Err(NativeError::io(
                "a workspace entry cannot be inspected",
                error,
            )))
        }
    };

    // Reparse points/junctions/symlinks are omitted at the boundary. They can
    // be surfaced later with an explicit safe-link representation.
    if is_reparse_point(&metadata) {
        return None;
    }
    let kind = if metadata.is_dir() {
        WorkspaceEntryKind::Directory
    } else if metadata.is_file() {
        WorkspaceEntryKind::File
    } else {
        return None;
    };
    Some(Ok(WorkspaceEntry {
        name: file_name,
        relative_path: display_relative_path(&relative_path),
        kind,
        byte_size: metadata.is_file().then_some(metadata.len()),
        modified_at_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64),
    }))
}

fn normalize_relative_path(relative_path: Option<&str>) -> NativeResult<std::path::PathBuf> {
    let value = relative_path.unwrap_or_default().trim();
    if value.as_bytes().contains(&0) {
        return Err(NativeError::invalid(
            "relativePath",
            "contains an invalid character",
        ));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(NativeError::invalid(
            "relativePath",
            "must be relative to the workspace grant",
        ));
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                reject_unsafe_component(value)?;
            }
            std::path::Component::CurDir => {}
            _ => {
                return Err(NativeError::invalid(
                    "relativePath",
                    "cannot contain a parent, root, or drive prefix",
                ));
            }
        }
    }
    Ok(path.to_path_buf())
}

#[cfg(windows)]
fn reject_unsafe_component(component: &std::ffi::OsStr) -> NativeResult<()> {
    // A colon in a normal Windows path component addresses an alternate data
    // stream (for example, `notes.txt:secret`).  Grants are for ordinary
    // files only; allowing ADS names would bypass the visible file boundary
    // and expose hidden stream content.
    let value = component.to_string_lossy();
    if value.contains(':') {
        return Err(NativeError::invalid(
            "relativePath",
            "cannot address a Windows alternate data stream",
        ));
    }
    // Win32 trims trailing dots/spaces and treats DOS device names as special
    // handles even when an extension is present (`CON.txt`, `NUL.log`, ...).
    // Reject these aliases so a scoped grant cannot address a device or make
    // two distinct renderer paths resolve to the same native target.
    if value.ends_with('.') || value.ends_with(' ') {
        return Err(NativeError::invalid(
            "relativePath",
            "cannot contain a Windows trailing dot or space",
        ));
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device_number = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || device_number.is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    });
    if reserved {
        return Err(NativeError::invalid(
            "relativePath",
            "cannot address a Windows device name",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_unsafe_component(_component: &std::ffi::OsStr) -> NativeResult<()> {
    Ok(())
}

fn verify_directory_scope(
    root: &Path,
    expected_canonical_root: &Path,
    directory: &Path,
) -> NativeResult<()> {
    reject_reparse_root(root)?;
    let canonical_root = dunce::canonicalize(root)
        .map_err(|error| NativeError::io("the workspace root cannot be verified", error))?;
    if canonical_root != expected_canonical_root {
        return Err(NativeError::new(
            "workspace_directory_changed",
            "The workspace root changed while it was being listed",
        ));
    }

    let canonical_directory = dunce::canonicalize(directory).map_err(|_| {
        NativeError::new(
            "workspace_directory_changed",
            "The workspace directory changed while it was being listed",
        )
    })?;
    if canonical_directory != directory || !canonical_directory.starts_with(expected_canonical_root)
    {
        return Err(NativeError::new(
            "workspace_scope_violation",
            "The workspace directory changed outside the granted folder",
        ));
    }
    reject_reparse_components(expected_canonical_root, &canonical_directory)
}

fn resolve_beneath_root(
    root: &Path,
    relative_path: &Path,
    require_exists: bool,
) -> NativeResult<std::path::PathBuf> {
    reject_reparse_root(root)?;
    let canonical_root = dunce::canonicalize(root)
        .map_err(|error| NativeError::io("the workspace root cannot be verified", error))?;
    let candidate = canonical_root.join(relative_path);
    reject_reparse_components(&canonical_root, &candidate)?;
    let canonical_candidate = if require_exists {
        dunce::canonicalize(&candidate).map_err(|error| {
            NativeError::io("the requested workspace path cannot be verified", error)
        })?
    } else {
        candidate
    };

    if canonical_candidate == canonical_root || canonical_candidate.starts_with(&canonical_root) {
        reject_reparse_components(&canonical_root, &canonical_candidate)?;
        Ok(canonical_candidate)
    } else {
        Err(NativeError::new(
            "workspace_scope_violation",
            "The requested path escapes the granted workspace folder",
        ))
    }
}

fn reject_reparse_components(root: &Path, target: &Path) -> NativeResult<()> {
    let relative = target.strip_prefix(root).map_err(|_| {
        NativeError::new(
            "workspace_scope_violation",
            "The requested path is outside the granted workspace folder",
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            NativeError::io("the requested workspace path cannot be inspected", error)
        })?;
        if is_reparse_point(&metadata) {
            return Err(NativeError::new(
                "workspace_reparse_path",
                "The requested workspace path contains a symbolic link, junction, or reparse point",
            ));
        }
    }
    Ok(())
}

fn reject_reparse_root(root: &Path) -> NativeResult<()> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| NativeError::io("the workspace root cannot be inspected", error))?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(NativeError::new(
            "workspace_reparse_root",
            "The workspace root must be a regular local directory",
        ));
    }
    Ok(())
}

fn open_read_without_following_final_reparse_point(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn metadata_changed(before: &Metadata, after: &Metadata) -> bool {
    before.len() != after.len() || before.modified().ok() != after.modified().ok()
}

fn display_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "omnia-workspace-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        assert!(normalize_relative_path(Some("../secret.txt")).is_err());
        #[cfg(windows)]
        assert!(normalize_relative_path(Some("C:\\Windows\\system.ini")).is_err());
        #[cfg(not(windows))]
        assert!(normalize_relative_path(Some("/etc/passwd")).is_err());
        assert!(normalize_relative_path(Some("src/lib.rs")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn alternate_data_stream_paths_are_rejected() {
        assert!(normalize_relative_path(Some("notes.txt:secret")).is_err());
        assert!(normalize_relative_path(Some("nested/report.txt::$DATA")).is_err());
        assert!(normalize_relative_path(Some("CON.txt")).is_err());
        assert!(normalize_relative_path(Some("nested/NUL.log")).is_err());
        assert!(normalize_relative_path(Some("COM¹.txt")).is_err());
        assert!(normalize_relative_path(Some("LPT³.log")).is_err());
        assert!(normalize_relative_path(Some("report.txt.")).is_err());
    }

    #[test]
    fn current_directory_can_be_listed_inside_its_grant() {
        let root = dunce::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let listing = list_directory("workspace_test", &root, None).unwrap();
        assert_eq!(listing.grant_id, "workspace_test");
    }

    #[test]
    fn bounded_text_reads_preserve_content_and_hash() {
        let root = temporary_directory("read");
        fs::write(root.join("notes.txt"), "safe workspace text").unwrap();
        let result = read_text_file("workspace_test", &root, "notes.txt").unwrap();
        assert_eq!(result.content, "safe workspace text");
        assert_eq!(result.byte_size, 19);
        assert_eq!(result.content_sha256.len(), 64);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_roots_and_entries_are_rejected() {
        use std::os::unix::fs::symlink;

        let root = temporary_directory("links");
        let outside = temporary_directory("outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        assert!(read_text_file("workspace_test", &root, "escape/secret.txt").is_err());

        let linked_root = root.with_extension("linked");
        symlink(&root, &linked_root).unwrap();
        assert!(list_directory("workspace_test", &linked_root, None).is_err());

        fs::remove_file(linked_root).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
