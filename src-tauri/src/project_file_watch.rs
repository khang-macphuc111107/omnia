//! On-demand observation of a single native-selected source file.
//!
//! An open, read-only OS file handle is the capability. Refresh reads that
//! handle and resolves its current name, so a rename is not guessed from file
//! contents and no directory/volume scan is needed. Content is returned only
//! after a stable, bounded read; callers retain the last successful copy when
//! a refresh fails or the source is removed. This module does not own a thread,
//! accept renderer paths, mutate source files, or persist file bytes.

use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{NativeError, NativeResult};

pub const PROJECT_FILE_WATCH_VERSION: &str = "native-file-handle-v1";
pub const MAX_PROJECT_FILE_WATCH_BYTES: u64 = 64 * 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFileIdentity {
    /// SHA-256 over OS object identity and its creation time when available.
    /// The receipt never exposes a raw volume serial number or inode.
    pub sha256: String,
    pub method: ProjectFileIdentityMethod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectFileIdentityMethod {
    WindowsFileId,
    UnixDeviceInode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectFileAvailability {
    Present,
    /// The open file object has no links, or Windows reports delete pending.
    /// Its final readable bytes can still be captured through the handle.
    Removed,
    /// The file handle is valid but this OS cannot resolve a current name.
    /// This is not evidence of deletion.
    LocationUnknown,
}

/// Content-free observation suitable for a native pointer receipt. File paths
/// and source bytes are kept separately in `ProjectFileRefresh`, which must
/// not be logged or forwarded as a general telemetry event.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFileWatchReceipt {
    pub version: String,
    pub identity: ProjectFileIdentity,
    pub revision: u64,
    pub availability: ProjectFileAvailability,
    pub path_changed: bool,
    pub content_changed: bool,
    pub byte_size: u64,
    pub content_sha256: String,
    pub modified_at_ms: Option<i64>,
    pub sampled_at_ms: i64,
}

/// Native-only data returned after a successful observation. `content` is
/// `Some` on the initial capture and whenever the captured bytes change.
/// `None` means to retain the existing copy, including for removed sources.
#[derive(Debug)]
pub struct ProjectFileRefresh {
    pub receipt: ProjectFileWatchReceipt,
    pub current_path: Option<PathBuf>,
    pub content: Option<Vec<u8>>,
}

#[derive(Debug)]
pub struct ProjectFileWatch {
    file: File,
    identity: ProjectFileIdentity,
    max_bytes: u64,
    last_path: Option<PathBuf>,
    last_content_sha256: Option<String>,
    revision: u64,
}

impl ProjectFileWatch {
    /// Open one file selected by a native picker or another already-approved
    /// native authority. The caller owns permission and project association.
    /// This does not grant access to the containing directory.
    pub fn open(selected_path: &Path, max_bytes: u64) -> NativeResult<Self> {
        validate_max_bytes(max_bytes)?;
        if !selected_path.is_absolute() {
            return Err(NativeError::invalid(
                "sourcePath",
                "must be an absolute native-selected path",
            ));
        }
        let before = fs::symlink_metadata(selected_path).map_err(|error| {
            NativeError::io("The selected source file cannot be inspected", error)
        })?;
        if !before.is_file() || is_reparse_point(&before) {
            return Err(NativeError::new(
                "project_source_not_regular",
                "The selected source must be a regular file",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Permit the user to rename/delete the source while Omnia keeps
            // its read handle. Never request write or deletion access.
            const FILE_SHARE_READ: u32 = 1;
            const FILE_SHARE_WRITE: u32 = 2;
            const FILE_SHARE_DELETE: u32 = 4;
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
            options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options
            .open(selected_path)
            .map_err(|error| NativeError::io("The selected source file cannot be opened", error))?;
        let opened = file.metadata().map_err(|error| {
            NativeError::io("The selected source handle cannot be inspected", error)
        })?;
        if !opened.is_file() || is_reparse_point(&opened) {
            return Err(NativeError::new(
                "project_source_not_regular",
                "The selected source must be a regular file",
            ));
        }
        let identity = file_identity(&file, &opened)?;
        // Opening via a parent path can race a rename/reparse replacement.
        // Require that the selected path still identifies the opened object.
        if !path_matches_identity(selected_path, &identity) {
            return Err(source_changed());
        }
        if opened.len() > max_bytes {
            return Err(source_too_large());
        }
        let last_path = current_location(&file, selected_path, &identity)?.path;
        Ok(Self {
            file,
            identity,
            max_bytes,
            last_path,
            last_content_sha256: None,
            revision: 0,
        })
    }

    /// Reopen persisted source metadata after restart. A reused path must
    /// never silently bind to a different object. A renamed file whose new
    /// path was not observed before shutdown needs explicit user relinking.
    pub fn resume(
        selected_path: &Path,
        expected: &ProjectFileIdentity,
        max_bytes: u64,
    ) -> NativeResult<Self> {
        validate_identity(expected)?;
        let watch = Self::open(selected_path, max_bytes)?;
        if watch.identity != *expected {
            return Err(NativeError::new(
                "project_source_identity_changed",
                "The source path now identifies a different file; relink it explicitly",
            ));
        }
        Ok(watch)
    }

    pub fn identity(&self) -> &ProjectFileIdentity {
        &self.identity
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn refresh(&mut self, expected_revision: u64) -> NativeResult<ProjectFileRefresh> {
        self.refresh_with_cancel(expected_revision, || false)
    }

    /// Read only when the caller asks for a refresh. Cancellation and byte
    /// limits are checked on every 64 KiB chunk. A failed read does not change
    /// the watch revision, path, or latest successful content fingerprint.
    pub fn refresh_with_cancel<F>(
        &mut self,
        expected_revision: u64,
        mut cancelled: F,
    ) -> NativeResult<ProjectFileRefresh>
    where
        F: FnMut() -> bool,
    {
        if self.revision != expected_revision {
            return Err(NativeError::new(
                "project_source_revision_conflict",
                "The source watcher revision changed before refresh",
            ));
        }
        if cancelled() {
            return Err(source_cancelled());
        }
        let before = self
            .file
            .metadata()
            .map_err(|error| NativeError::io("The source handle cannot be inspected", error))?;
        if before.len() > self.max_bytes {
            return Err(source_too_large());
        }
        let before_identity = file_identity(&self.file, &before)?;
        if before_identity != self.identity {
            return Err(source_changed());
        }
        let location_before = current_location(
            &self.file,
            self.last_path.as_deref().unwrap_or(Path::new("")),
            &self.identity,
        )?;
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|error| NativeError::io("The source handle cannot be read", error))?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(before.len() as usize)
            .map_err(|_| {
                NativeError::retryable(
                    "project_source_allocation_failed",
                    "There is not enough memory to refresh this source",
                )
            })?;
        let mut buffer = [0u8; READ_BUFFER_BYTES];
        loop {
            if cancelled() {
                return Err(source_cancelled());
            }
            let count = self
                .file
                .read(&mut buffer)
                .map_err(|error| NativeError::io("The source handle cannot be read", error))?;
            if count == 0 {
                break;
            }
            if bytes.len().saturating_add(count) as u64 > self.max_bytes {
                return Err(source_too_large());
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
        let after = self
            .file
            .metadata()
            .map_err(|error| NativeError::io("The source handle cannot be inspected", error))?;
        let location_after = current_location(
            &self.file,
            self.last_path.as_deref().unwrap_or(Path::new("")),
            &self.identity,
        )?;
        if before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
            || file_identity(&self.file, &after)? != self.identity
            || bytes.len() as u64 != after.len()
            || location_before != location_after
        {
            return Err(source_changed());
        }
        let content_sha256 = sha256_hex(&bytes);
        let content_changed = self.last_content_sha256.as_ref() != Some(&content_sha256);
        let path_changed = self.last_path != location_after.path;
        let revision = self.revision.checked_add(1).ok_or_else(|| {
            NativeError::new(
                "project_source_revision_exhausted",
                "The source watcher revision is exhausted",
            )
        })?;
        let receipt = ProjectFileWatchReceipt {
            version: PROJECT_FILE_WATCH_VERSION.to_owned(),
            identity: self.identity.clone(),
            revision,
            availability: location_after.availability,
            path_changed,
            content_changed,
            byte_size: bytes.len() as u64,
            content_sha256: content_sha256.clone(),
            modified_at_ms: time_ms(after.modified().ok()),
            sampled_at_ms: now_ms(),
        };
        self.last_path = location_after.path.clone();
        self.last_content_sha256 = Some(content_sha256);
        self.revision = revision;
        Ok(ProjectFileRefresh {
            receipt,
            current_path: location_after.path,
            content: content_changed.then_some(bytes),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Location {
    path: Option<PathBuf>,
    availability: ProjectFileAvailability,
}

fn validate_max_bytes(max_bytes: u64) -> NativeResult<()> {
    if max_bytes == 0 || max_bytes > MAX_PROJECT_FILE_WATCH_BYTES {
        return Err(NativeError::invalid(
            "maxBytes",
            "must be between 1 and 64 MiB",
        ));
    }
    Ok(())
}

fn validate_identity(identity: &ProjectFileIdentity) -> NativeResult<()> {
    if identity.sha256.len() != 64 || !identity.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(NativeError::invalid(
            "sourceIdentity",
            "must contain a SHA-256 hex digest",
        ));
    }
    Ok(())
}

fn path_matches_identity(path: &Path, identity: &ProjectFileIdentity) -> bool {
    // This supplementary check does not read source bytes, follow final
    // symlinks, or replace the already-open capability with a path lookup.
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return false;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(7).custom_flags(0x0020_0000);
    }
    let Ok(file) = options.open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    file_identity(&file, &metadata).ok().as_ref() == Some(identity)
}

#[cfg(windows)]
fn file_identity(file: &File, _metadata: &Metadata) -> NativeResult<ProjectFileIdentity> {
    use std::os::windows::io::AsRawHandle;
    let mut information = windows_handle::FileInformation::default();
    // SAFETY: the borrowed OS handle remains valid for this call and the
    // output buffer has exactly the Windows BY_HANDLE_FILE_INFORMATION layout.
    if unsafe { windows_handle::GetFileInformationByHandle(file.as_raw_handle(), &mut information) }
        == 0
    {
        return Err(NativeError::io(
            "The source file identity cannot be read",
            std::io::Error::last_os_error(),
        ));
    }
    let mut bytes = b"windows-file-id-v1\0".to_vec();
    bytes.extend_from_slice(&information.volume_serial_number.to_le_bytes());
    bytes.extend_from_slice(&information.file_index_high.to_le_bytes());
    bytes.extend_from_slice(&information.file_index_low.to_le_bytes());
    bytes.extend_from_slice(&information.creation_time_high.to_le_bytes());
    bytes.extend_from_slice(&information.creation_time_low.to_le_bytes());
    Ok(ProjectFileIdentity {
        sha256: sha256_hex(bytes),
        method: ProjectFileIdentityMethod::WindowsFileId,
    })
}

#[cfg(unix)]
fn file_identity(_file: &File, metadata: &Metadata) -> NativeResult<ProjectFileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let mut bytes = b"unix-file-id-v1\0".to_vec();
    bytes.extend_from_slice(&metadata.dev().to_le_bytes());
    bytes.extend_from_slice(&metadata.ino().to_le_bytes());
    if let Ok(created) = metadata.created() {
        if let Ok(time) = created.duration_since(UNIX_EPOCH) {
            bytes.extend_from_slice(&time.as_nanos().to_le_bytes());
        }
    }
    Ok(ProjectFileIdentity {
        sha256: sha256_hex(bytes),
        method: ProjectFileIdentityMethod::UnixDeviceInode,
    })
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File, _metadata: &Metadata) -> NativeResult<ProjectFileIdentity> {
    Err(NativeError::new(
        "project_source_identity_unavailable",
        "This platform cannot provide stable source file identities",
    ))
}

#[cfg(windows)]
fn current_location(
    file: &File,
    _last_path: &Path,
    identity: &ProjectFileIdentity,
) -> NativeResult<Location> {
    use std::os::windows::io::AsRawHandle;
    let mut standard = windows_handle::FileStandardInformation::default();
    // SAFETY: the handle is live; FileStandardInfo has the documented layout.
    let inspected = unsafe {
        windows_handle::GetFileInformationByHandleEx(
            file.as_raw_handle(),
            1,
            (&mut standard as *mut windows_handle::FileStandardInformation).cast(),
            std::mem::size_of::<windows_handle::FileStandardInformation>() as u32,
        )
    };
    if inspected != 0 && (standard.delete_pending != 0 || standard.number_of_links == 0) {
        return Ok(Location {
            path: None,
            availability: ProjectFileAvailability::Removed,
        });
    }
    // SAFETY: the first call only asks Windows for the required buffer size.
    let length = unsafe {
        windows_handle::GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, 0)
    };
    if length == 0 || length > 32_768 {
        return Ok(Location {
            path: None,
            availability: ProjectFileAvailability::LocationUnknown,
        });
    }
    let mut buffer = vec![0u16; length as usize + 1];
    // SAFETY: the buffer is writable for the supplied UTF-16 capacity.
    let written = unsafe {
        windows_handle::GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Ok(Location {
            path: None,
            availability: ProjectFileAvailability::LocationUnknown,
        });
    }
    use std::os::windows::ffi::OsStringExt;
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..written as usize]));
    if !path_matches_identity(&path, identity) {
        return Ok(Location {
            path: None,
            availability: ProjectFileAvailability::LocationUnknown,
        });
    }
    Ok(Location {
        path: Some(dunce::simplified(&path).to_path_buf()),
        availability: ProjectFileAvailability::Present,
    })
}

#[cfg(unix)]
fn current_location(
    file: &File,
    last_path: &Path,
    identity: &ProjectFileIdentity,
) -> NativeResult<Location> {
    use std::os::unix::fs::MetadataExt;
    if file
        .metadata()
        .map_err(|error| NativeError::io("The source handle cannot be inspected", error))?
        .nlink()
        == 0
    {
        return Ok(Location {
            path: None,
            availability: ProjectFileAvailability::Removed,
        });
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        if let Ok(path) = fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())) {
            if path_matches_identity(&path, identity) {
                return Ok(Location {
                    path: Some(path),
                    availability: ProjectFileAvailability::Present,
                });
            }
        }
    }
    if path_matches_identity(last_path, identity) {
        return Ok(Location {
            path: Some(last_path.to_path_buf()),
            availability: ProjectFileAvailability::Present,
        });
    }
    Ok(Location {
        path: None,
        availability: ProjectFileAvailability::LocationUnknown,
    })
}

#[cfg(not(any(windows, unix)))]
fn current_location(
    _file: &File,
    _last_path: &Path,
    _identity: &ProjectFileIdentity,
) -> NativeResult<Location> {
    Ok(Location {
        path: None,
        availability: ProjectFileAvailability::LocationUnknown,
    })
}

#[cfg(windows)]
mod windows_handle {
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Default)]
    pub struct FileInformation {
        pub file_attributes: u32,
        pub creation_time_low: u32,
        pub creation_time_high: u32,
        pub last_access_time_low: u32,
        pub last_access_time_high: u32,
        pub last_write_time_low: u32,
        pub last_write_time_high: u32,
        pub volume_serial_number: u32,
        pub file_size_high: u32,
        pub file_size_low: u32,
        pub number_of_links: u32,
        pub file_index_high: u32,
        pub file_index_low: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    pub struct FileStandardInformation {
        pub allocation_size: i64,
        pub end_of_file: i64,
        pub number_of_links: u32,
        pub delete_pending: u8,
        pub directory: u8,
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetFileInformationByHandle(
            handle: *mut c_void,
            information: *mut FileInformation,
        ) -> i32;
        pub fn GetFileInformationByHandleEx(
            handle: *mut c_void,
            class: u32,
            information: *mut c_void,
            size: u32,
        ) -> i32;
        pub fn GetFinalPathNameByHandleW(
            handle: *mut c_void,
            path: *mut u16,
            capacity: u32,
            flags: u32,
        ) -> u32;
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse_point(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}
fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn time_ms(time: Option<SystemTime>) -> Option<i64> {
    time.and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
}
fn now_ms() -> i64 {
    time_ms(Some(SystemTime::now())).unwrap_or(1).max(1)
}
fn source_changed() -> NativeError {
    NativeError::retryable(
        "project_source_changed_during_read",
        "The source changed during refresh; the previous copy remains current",
    )
}
fn source_too_large() -> NativeError {
    NativeError::new(
        "project_source_too_large",
        "The source exceeds the configured snapshot byte limit",
    )
}
fn source_cancelled() -> NativeError {
    NativeError::new(
        "project_source_refresh_cancelled",
        "The source refresh was cancelled",
    )
}
