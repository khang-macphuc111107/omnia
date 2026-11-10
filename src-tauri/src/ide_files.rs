//! Original Omnia text editor boundary. Persistent workspace grants allow reads;
//! writes require a separate native-confirmed, process-session approval.
//!
//! Windows saves pin every parent directory, open files relative to the pinned
//! destination parent, deny concurrent in-place writers, stage bytes in that
//! directory, recheck source identity/hash, and rename the staging HANDLE
//! atomically. Windows does not expose a general conditional
//! filesystem replace: an unrelated process can still replace/delete the final
//! directory entry between the final check and rename. This is NOT filesystem
//! compare-and-swap. No save is retried, and missing sources are never knowingly
//! recreated. Other platforms fail closed for writes pending equivalent handles.

use std::{
    collections::HashMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

use crate::{
    error::{NativeError, NativeResult},
    state::AppState,
};

const MAX_IDE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SESSION_APPROVALS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ScopeStamp {
    project_id: Option<String>,
    revision: i64,
    path_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeWritePermission {
    grant_id: String,
    permission_id: String,
    scope: &'static str,
}

struct ApprovedRoot {
    grant_id: String,
    root: PathBuf,
    identity: String,
    stamp: ScopeStamp,
}
#[derive(Default)]
struct ApprovalRegistry {
    approvals: HashMap<String, ApprovedRoot>,
}

impl ApprovalRegistry {
    fn issue(
        &mut self,
        grant_id: &str,
        root: &Path,
        stamp: &ScopeStamp,
    ) -> NativeResult<IdeWritePermission> {
        if self.approvals.len() >= MAX_SESSION_APPROVALS {
            return Err(NativeError::new(
                "ide_permission_limit",
                "Revoke an IDE write approval before adding another folder",
            ));
        }
        let pins = pin_directories(root, "")?;
        let permission_id = format!("ide_write_{}", Uuid::new_v4().simple());
        self.approvals.insert(
            permission_id.clone(),
            ApprovedRoot {
                grant_id: grant_id.to_owned(),
                root: pins.root.clone(),
                identity: root_identity(&pins)?,
                stamp: stamp.clone(),
            },
        );
        Ok(IdeWritePermission {
            grant_id: grant_id.to_owned(),
            permission_id,
            scope: "session",
        })
    }

    fn authorize(
        &self,
        permission_id: &str,
        grant_id: &str,
        root: &Path,
        stamp: &ScopeStamp,
    ) -> NativeResult<()> {
        let pins = pin_directories(root, "")?;
        self.authorize_pinned(permission_id, grant_id, &pins, stamp)
    }

    fn authorize_pinned(
        &self,
        permission_id: &str,
        grant_id: &str,
        pins: &PinnedDirectories,
        stamp: &ScopeStamp,
    ) -> NativeResult<()> {
        let approved = self
            .approvals
            .get(permission_id)
            .ok_or_else(permission_denied)?;
        if approved.grant_id != grant_id || approved.root != pins.root || approved.stamp != *stamp {
            return Err(permission_denied());
        }
        if root_identity(pins)? != approved.identity {
            return Err(permission_denied());
        }
        Ok(())
    }

    fn revoke(&mut self, permission_id: &str) -> bool {
        self.approvals.remove(permission_id).is_some()
    }
}

fn permission_denied() -> NativeError {
    NativeError::new(
        "ide_write_permission_denied",
        "The folder has no current IDE write approval. Your dirty buffer is retained",
    )
}

fn registry() -> &'static Mutex<ApprovalRegistry> {
    static REGISTRY: OnceLock<Mutex<ApprovalRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(ApprovalRegistry::default()))
}

fn lock_registry() -> NativeResult<std::sync::MutexGuard<'static, ApprovalRegistry>> {
    registry().lock().map_err(|_| {
        NativeError::new(
            "ide_state_unavailable",
            "IDE permission state is unavailable; no write was attempted",
        )
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdeGrantRequest {
    grant_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdeRevokeRequest {
    permission_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadIdeFileRequest {
    grant_id: String,
    relative_path: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteIdeFileRequest {
    grant_id: String,
    permission_id: String,
    relative_path: String,
    expected_content_sha256: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeTextFile {
    grant_id: String,
    relative_path: String,
    content: String,
    byte_size: u64,
    content_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum IdeSaveResult {
    Saved {
        file: IdeTextFile,
        #[serde(rename = "receiptId")]
        receipt_id: String,
        #[serde(rename = "externalRaceGuard")]
        external_race_guard: &'static str,
    },
    Conflict {
        #[serde(rename = "actualContentSha256")]
        actual_content_sha256: Option<String>,
        #[serde(rename = "receiptId")]
        receipt_id: String,
    },
    Missing {
        #[serde(rename = "receiptId")]
        receipt_id: String,
    },
}

fn grant_scope(state: &AppState, grant_id: &str) -> NativeResult<(PathBuf, ScopeStamp)> {
    let (project_id, revision, path_hash) =
        state.storage.workspace_grant_scope_for_read(grant_id)?;
    let root = state.storage.workspace_root_for_read(grant_id)?;
    Ok((
        root,
        ScopeStamp {
            project_id,
            revision,
            path_hash,
        },
    ))
}

#[tauri::command]
pub async fn ide_write_permission_request(
    app: AppHandle,
    state: State<'_, AppState>,
    request: IdeGrantRequest,
) -> NativeResult<Option<IdeWritePermission>> {
    if !cfg!(windows) {
        return Err(NativeError::new(
            "ide_write_unsupported",
            "Native IDE writes currently require the Windows handle boundary",
        ));
    }
    let (root, stamp) = grant_scope(&state, &request.grant_id)?;
    let pins = pin_directories(&root, "")?;
    let identity = root_identity(&pins)?;
    drop(pins);
    let approved = app.dialog().message(format!("Allow Omnia IDE to save existing UTF-8 text files in:\n\n{}\n\nThis write approval lasts for this app session. Saving requires the last read content hash. Cancel keeps the folder read-only.", root.display()))
        .title("Allow IDE saves for this folder?").kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Allow saving".to_owned(), "Keep read-only".to_owned())).blocking_show();
    if !approved {
        return Ok(None);
    }
    // Permission dialogs can remain open while another operation revokes or
    // reselects a grant. Never issue approval from that stale observation.
    let (after_root, after_stamp) = grant_scope(&state, &request.grant_id)?;
    let after_pins = pin_directories(&after_root, "")?;
    if root != after_root || stamp != after_stamp || identity != root_identity(&after_pins)? {
        return Err(permission_denied());
    }
    lock_registry()?
        .issue(&request.grant_id, &after_root, &after_stamp)
        .map(Some)
}

#[tauri::command]
pub fn ide_write_permission_revoke(request: IdeRevokeRequest) -> NativeResult<bool> {
    Ok(lock_registry()?.revoke(&request.permission_id))
}

#[tauri::command]
pub async fn ide_text_file_read(
    state: State<'_, AppState>,
    request: ReadIdeFileRequest,
) -> NativeResult<IdeTextFile> {
    let (root, stamp) = grant_scope(&state, &request.grant_id)?;
    let result = read_ide_file(&request.grant_id, &root, &request.relative_path)?;
    let (after_root, after_stamp) = grant_scope(&state, &request.grant_id)?;
    if root != after_root || stamp != after_stamp {
        return Err(NativeError::new(
            "ide_scope_changed",
            "The read grant changed while reading. The buffer was not replaced",
        ));
    }
    Ok(result)
}

#[tauri::command]
pub async fn ide_text_file_write(
    state: State<'_, AppState>,
    request: WriteIdeFileRequest,
) -> NativeResult<IdeSaveResult> {
    let (root, stamp) = grant_scope(&state, &request.grant_id)?;
    // This lock serializes all Omnia IDE writers and approval revocation.
    // Storage read-grant revocation has its own lock and is rechecked at commit.
    let approvals = lock_registry()?;
    write_ide_file_checked(
        &approvals,
        &root,
        &stamp,
        &request,
        || {
            // The authoritative storage check is performed by the fallible closure
            // below in write_ide_file_checked; this callback is the deterministic
            // precommit race seam used by native tests.
        },
        || {
            let (after_root, after_stamp) = grant_scope(&state, &request.grant_id)?;
            if root != after_root || stamp != after_stamp {
                return Err(permission_denied());
            }
            Ok(())
        },
    )
}

fn normalized_relative(value: &str) -> NativeResult<String> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty()
        || normalized.len() > 4096
        || normalized
            .chars()
            .any(|c| c.is_control() || ":<>\"|?*".contains(c))
    {
        return Err(NativeError::invalid(
            "relativePath",
            "must be a bounded relative regular-file path",
        ));
    }
    for segment in normalized.split('/') {
        let stem = segment.split('.').next().unwrap_or_default().to_uppercase();
        let device = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
        ) || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            });
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.ends_with('.')
            || segment.ends_with(' ')
            || device
        {
            return Err(NativeError::invalid(
                "relativePath",
                "cannot contain traversal, device names or Windows path aliases",
            ));
        }
    }
    Ok(normalized)
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn receipt() -> String {
    format!("ide_save_{}", Uuid::new_v4().simple())
}

fn io_error(error: std::io::Error) -> NativeError {
    match error.kind() {
        std::io::ErrorKind::NotFound => NativeError::new("ide_source_missing", "The source file or folder is missing. Your buffer is retained"),
        std::io::ErrorKind::PermissionDenied => NativeError::new("ide_permission_denied", "The operating system denied file access. Your buffer is retained"),
        _ if matches!(error.raw_os_error(), Some(32 | 33)) => NativeError::new("ide_file_in_use", "The file or parent folder is in use by another process. No automatic retry was attempted"),
        _ => NativeError::new("ide_file_io_failed", "The local file operation failed. Your buffer is retained"),
    }
}

fn is_reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

struct PinnedDirectories {
    root: PathBuf,
    target: PathBuf,
    handles: Vec<File>,
    root_index: usize,
}

fn pin_directories(root: &Path, relative: &str) -> NativeResult<PinnedDirectories> {
    let root_metadata = fs::symlink_metadata(root).map_err(io_error)?;
    if is_reparse(&root_metadata) || !root_metadata.is_dir() {
        return Err(NativeError::new(
            "ide_reparse_path",
            "The approved root must be a regular directory",
        ));
    }
    let canonical = dunce::canonicalize(root).map_err(io_error)?;
    if canonical != root {
        return Err(NativeError::new(
            "ide_scope_changed",
            "The approved root no longer resolves to its original path",
        ));
    }
    let path = if relative.is_empty() {
        String::new()
    } else {
        normalized_relative(relative)?
    };
    let target = canonical.join(&path);
    let mut parents: Vec<PathBuf> = canonical.ancestors().map(Path::to_path_buf).collect();
    parents.reverse();
    let root_index = parents.len() - 1;
    let mut parent = canonical.clone();
    let components: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        parent.push(component);
        parents.push(parent.clone());
    }
    let mut handles = Vec::new();
    let parent_count = parents.len();
    for (index, parent) in parents.into_iter().enumerate() {
        let metadata = fs::symlink_metadata(&parent).map_err(io_error)?;
        if is_reparse(&metadata) || !metadata.is_dir() {
            return Err(NativeError::new(
                "ide_reparse_path",
                "A parent path is a symbolic link, junction, or non-directory",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Ancestors are observation handles and must not block unrelated
            // workspace operations. A nested parent is pinned against DELETE
            // sharing so its directory entry cannot be swapped while a file
            // below it is being saved. The approved root and a direct child
            // target intentionally share DELETE: external replacement is a
            // supported conflict input and is detected by the source handle's
            // identity/hash recheck.
            let is_final_parent = index + 1 == parent_count;
            let components = path.split('/').filter(|part| !part.is_empty()).count();
            let pin_delete = is_final_parent && components != 1;
            options
                .share_mode(if pin_delete { 1 | 2 } else { 1 | 2 | 4 })
                .custom_flags(0x0200_0000 | 0x0020_0000);
        }
        let file = options.open(&parent).map_err(io_error)?;
        let opened = file.metadata().map_err(io_error)?;
        if is_reparse(&opened)
            || !opened.is_dir()
            || dunce::canonicalize(&parent).map_err(io_error)? != parent
        {
            return Err(NativeError::new(
                "ide_reparse_path",
                "A parent path changed during file access",
            ));
        }
        handles.push(file);
    }
    Ok(PinnedDirectories {
        root: canonical,
        target,
        handles,
        root_index,
    })
}

fn root_identity(pins: &PinnedDirectories) -> NativeResult<String> {
    identity(&pins.handles[pins.root_index])
}

#[cfg(windows)]
fn identity(file: &File) -> NativeResult<String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.map_err(
        |_| {
            NativeError::new(
                "ide_identity_unavailable",
                "Windows could not prove the file identity",
            )
        },
    )?;
    Ok(format!(
        "win32:{:08x}:{:08x}{:08x}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}
#[cfg(unix)]
fn identity(file: &File) -> NativeResult<String> {
    use std::os::unix::fs::MetadataExt;
    let info = file.metadata().map_err(io_error)?;
    Ok(format!("unix:{}:{}", info.dev(), info.ino()))
}
#[cfg(not(any(windows, unix)))]
fn identity(_file: &File) -> NativeResult<String> {
    Err(NativeError::new(
        "ide_identity_unavailable",
        "This platform cannot prove the file identity",
    ))
}

struct Observation {
    _handle: File,
    record: IdeTextFile,
    identity: String,
}

#[cfg(windows)]
mod windows_file_ops {
    use super::*;
    use std::{
        ffi::{c_void, OsStr},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
    };
    use windows::Win32::Storage::FileSystem::FILE_RENAME_INFO;

    // NT structures use their native pointer alignment on 32/64-bit Windows.
    // No pointer returned by these calls escapes the owning Rust allocation.
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: *mut c_void,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }
    #[repr(C)]
    struct IoStatusBlock {
        status_or_pointer: isize,
        information: usize,
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            handle: *mut *mut c_void,
            desired_access: u32,
            object_attributes: *const ObjectAttributes,
            io_status: *mut IoStatusBlock,
            allocation_size: *const i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *const c_void,
            ea_length: u32,
        ) -> i32;
        fn NtSetInformationFile(
            handle: *mut c_void,
            io_status: *mut IoStatusBlock,
            information: *const c_void,
            length: u32,
            information_class: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    fn checked_status(status: i32) -> NativeResult<()> {
        if status >= 0 {
            Ok(())
        } else {
            // Convert the returned NTSTATUS directly. LastError is unrelated
            // to NT calls and previously hid the precise rename failure.
            let code = unsafe { RtlNtStatusToDosError(status) };
            Err(io_error(std::io::Error::from_raw_os_error(code as i32)))
        }
    }

    fn child_name(value: &OsStr) -> NativeResult<Vec<u16>> {
        let name: Vec<u16> = value.encode_wide().collect();
        if name.is_empty()
            || name.len() > (u16::MAX as usize / 2)
            || name.iter().any(|unit| matches!(*unit, 0 | 47 | 58 | 92))
        {
            return Err(NativeError::invalid(
                "relativePath",
                "must resolve to one bounded file name inside the pinned parent",
            ));
        }
        Ok(name)
    }

    fn parent_handle(pins: &PinnedDirectories) -> NativeResult<*mut c_void> {
        let parent = pins.handles.last().ok_or_else(|| {
            NativeError::new(
                "ide_scope_changed",
                "The file has no pinned parent directory",
            )
        })?;
        let metadata = parent.metadata().map_err(io_error)?;
        if !metadata.is_dir() || is_reparse(&metadata) {
            return Err(NativeError::new(
                "ide_reparse_path",
                "The pinned parent changed into a reparse path",
            ));
        }
        Ok(parent.as_raw_handle())
    }

    pub(super) fn open_child(
        pins: &PinnedDirectories,
        name: &OsStr,
        create_staging: bool,
    ) -> NativeResult<File> {
        open_child_with_delete(pins, name, create_staging, false)
    }

    #[cfg(test)]
    pub(super) fn open_child_for_rename(
        pins: &PinnedDirectories,
        name: &OsStr,
    ) -> NativeResult<File> {
        open_child_with_delete(pins, name, false, true)
    }

    fn open_child_with_delete(
        pins: &PinnedDirectories,
        name: &OsStr,
        create_staging: bool,
        allow_delete: bool,
    ) -> NativeResult<File> {
        let mut name = child_name(name)?;
        let mut unicode = UnicodeString {
            length: (name.len() * 2) as u16,
            maximum_length: (name.len() * 2) as u16,
            buffer: name.as_mut_ptr(),
        };
        let attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: parent_handle(pins)?,
            object_name: &mut unicode,
            attributes: 0x40, // OBJ_CASE_INSENSITIVE
            security_descriptor: std::ptr::null_mut(),
            security_quality_of_service: std::ptr::null_mut(),
        };
        let mut io_status = IoStatusBlock {
            status_or_pointer: 0,
            information: 0,
        };
        let mut handle = std::ptr::null_mut();
        // Synchronous opens require SYNCHRONIZE. A source shares DELETE so an
        // external replacement can be observed, while denying in-place writes.
        // The staging HANDLE owns DELETE/WRITE_DAC and denies WRITE/DELETE share.
        let access = if create_staging {
            // GENERIC_WRITE includes FILE_WRITE_ATTRIBUTES for the copied
            // readonly state applied before staging is flushed and committed.
            0x8000_0000 | 0x4000_0000 | 0x0001_0000 | 0x0004_0000 | 0x0010_0000
        } else {
            0x8000_0000 | 0x0010_0000 | if allow_delete { 0x0001_0000 } else { 0 }
        };
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &attributes,
                &mut io_status,
                std::ptr::null(),
                0x80, // FILE_ATTRIBUTE_NORMAL
                if create_staging { 1 } else { 1 | 4 },
                if create_staging { 2 } else { 1 }, // FILE_CREATE / FILE_OPEN
                0x0020_0000 | 0x40 | 0x20, // OPEN_REPARSE_POINT, NON_DIRECTORY, SYNC_NONALERT
                std::ptr::null(),
                0,
            )
        };
        checked_status(status)?;
        // NtCreateFile succeeded and transferred exactly one owned HANDLE.
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    pub(super) fn rename_child(
        file: &File,
        pins: &PinnedDirectories,
        name: &OsStr,
    ) -> NativeResult<()> {
        let name = child_name(name)?;
        let bytes = std::mem::size_of::<FILE_RENAME_INFO>() + name.len() * 2;
        let mut storage =
            vec![0usize; (bytes + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        let mut io_status = IoStatusBlock {
            status_or_pointer: 0,
            information: 0,
        };
        let status = unsafe {
            // Win32 SetFileInformationByHandle rejects non-null RootDirectory.
            // NtSetInformationFile supports the HANDLE-relative destination.
            // REPLACE_IF_EXISTS | POSIX_SEMANTICS allows replacing our retained
            // read observations (which share DELETE) without a close/reopen gap.
            (*info).Anonymous.Flags = 1 | 2;
            (*info).RootDirectory = windows::Win32::Foundation::HANDLE(parent_handle(pins)?);
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut io_status,
                info.cast(),
                bytes as u32,
                65, // FileRenameInformationEx; no fallback with weaker semantics.
            )
        };
        checked_status(status)
    }
}

fn observe(pins: &PinnedDirectories, grant_id: &str, relative: &str) -> NativeResult<Observation> {
    #[cfg(windows)]
    let open_source = || {
        let name = pins
            .target
            .file_name()
            .ok_or_else(|| NativeError::invalid("relativePath", "has no file name"))?;
        windows_file_ops::open_child(pins, name, false)
    };
    #[cfg(not(windows))]
    let open_source = || {
        let metadata = fs::symlink_metadata(&pins.target).map_err(io_error)?;
        if is_reparse(&metadata) || !metadata.is_file() {
            return Err(NativeError::new(
                "ide_reparse_path",
                "The editor opens regular files only; symbolic links are rejected",
            ));
        }
        File::open(&pins.target).map_err(io_error)
    };
    let mut file = open_source()?;
    let opened = file.metadata().map_err(io_error)?;
    if is_reparse(&opened) || !opened.is_file() {
        return Err(NativeError::new(
            "ide_reparse_path",
            "The editor opens regular files only; symbolic links and junctions are rejected",
        ));
    }
    if opened.len() > MAX_IDE_BYTES as u64 {
        return Err(NativeError::new(
            "file_too_large",
            "The editor opens text files up to 2 MiB",
        ));
    }
    let source_identity = identity(&file)?;
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_IDE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > MAX_IDE_BYTES {
        return Err(NativeError::new(
            "file_too_large",
            "The editor opens text files up to 2 MiB",
        ));
    }
    if bytes.contains(&0) {
        return Err(NativeError::new(
            "binary_file",
            "The file contains binary bytes and cannot be edited as text",
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            "unsupported_encoding",
            "The file is not valid UTF-8 and was not decoded with replacement characters",
        )
    })?;
    let path_handle = open_source()?;
    let after = path_handle.metadata().map_err(io_error)?;
    if is_reparse(&after)
        || identity(&path_handle)? != source_identity
        || opened.len() != after.len()
        || opened.modified().ok() != after.modified().ok()
    {
        return Err(NativeError::new(
            "ide_source_changed",
            "The source changed while reading; the buffer was not replaced",
        ));
    }
    Ok(Observation {
        _handle: file,
        identity: source_identity,
        record: IdeTextFile {
            grant_id: grant_id.to_owned(),
            relative_path: relative.to_owned(),
            byte_size: content.len() as u64,
            content_sha256: hash(content.as_bytes()),
            content,
        },
    })
}

fn read_ide_file(grant_id: &str, root: &Path, relative: &str) -> NativeResult<IdeTextFile> {
    let relative = normalized_relative(relative)?;
    let pins = pin_directories(root, &relative)?;
    Ok(observe(&pins, grant_id, &relative)?.record)
}

// Tests use this adapter to inject an external change after staging, before
// the final observation. Production supplies the storage scope check too.
#[cfg(test)]
fn write_ide_file<F: FnOnce()>(
    approvals: &ApprovalRegistry,
    root: &Path,
    stamp: &ScopeStamp,
    request: &WriteIdeFileRequest,
    before_commit: F,
) -> NativeResult<IdeSaveResult> {
    write_ide_file_checked(approvals, root, stamp, request, before_commit, || Ok(()))
}

fn write_ide_file_checked<F: FnOnce(), C: FnOnce() -> NativeResult<()>>(
    approvals: &ApprovalRegistry,
    root: &Path,
    stamp: &ScopeStamp,
    request: &WriteIdeFileRequest,
    before_commit: F,
    check_scope: C,
) -> NativeResult<IdeSaveResult> {
    approvals.authorize(&request.permission_id, &request.grant_id, root, stamp)?;
    let relative = normalized_relative(&request.relative_path)?;
    if request.content.len() > MAX_IDE_BYTES {
        return Err(NativeError::new(
            "file_too_large",
            "The edited content exceeds the 2 MiB editor limit",
        ));
    }
    if request.content.contains('\0') {
        return Err(NativeError::new(
            "binary_file",
            "A text save cannot introduce binary NUL bytes",
        ));
    }
    if request.expected_content_sha256.len() != 64
        || !request
            .expected_content_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(NativeError::invalid(
            "expectedContentSha256",
            "must contain the last native SHA-256 receipt",
        ));
    }
    #[cfg(not(windows))]
    {
        let _ = (relative, before_commit, check_scope);
        return Err(NativeError::new(
            "ide_write_unsupported",
            "Native IDE writes require the Windows handle boundary",
        ));
    }
    #[cfg(windows)]
    {
        let pins = match pin_directories(root, &relative) {
            Ok(pins) => pins,
            Err(e) if e.code == "ide_source_missing" => {
                return Ok(IdeSaveResult::Missing {
                    receipt_id: receipt(),
                })
            }
            Err(e) => return Err(e),
        };
        approvals.authorize_pinned(&request.permission_id, &request.grant_id, &pins, stamp)?;
        let before = match observe(&pins, &request.grant_id, &relative) {
            Ok(file) => file,
            Err(e) if e.code == "ide_source_missing" => {
                return Ok(IdeSaveResult::Missing {
                    receipt_id: receipt(),
                })
            }
            Err(e) => return Err(e),
        };
        if before.record.content_sha256 != request.expected_content_sha256 {
            return Ok(IdeSaveResult::Conflict {
                actual_content_sha256: Some(before.record.content_sha256),
                receipt_id: receipt(),
            });
        }
        if before
            ._handle
            .metadata()
            .map_err(io_error)?
            .permissions()
            .readonly()
        {
            return Err(NativeError::new(
                "ide_permission_denied",
                "The source is read-only. Your dirty buffer is retained",
            ));
        }
        let mut staging = StagingFile::create(&pins)?;
        copy_source_dacl(&before._handle, &staging.handle)?;
        staging
            .handle
            .write_all(request.content.as_bytes())
            .map_err(io_error)?;
        staging
            .handle
            .set_permissions(before._handle.metadata().map_err(io_error)?.permissions())
            .map_err(io_error)?;
        staging.handle.sync_all().map_err(io_error)?;
        before_commit();
        check_scope()?;
        let current = match observe(&pins, &request.grant_id, &relative) {
            Ok(file) => file,
            Err(e) if e.code == "ide_source_missing" => {
                return Ok(IdeSaveResult::Missing {
                    receipt_id: receipt(),
                })
            }
            Err(e) => return Err(e),
        };
        if current.identity != before.identity
            || current.record.content_sha256 != request.expected_content_sha256
        {
            return Ok(IdeSaveResult::Conflict {
                actual_content_sha256: Some(current.record.content_sha256),
                receipt_id: receipt(),
            });
        }
        let saved_identity = identity(&staging.handle)?;
        staging.replace(&pins)?;
        // Close the writer before a no-WRITE-sharing readback observation.
        drop(staging);
        let after = observe(&pins, &request.grant_id, &relative).map_err(|_| NativeError::new("ide_write_outcome_unknown", "The replacement completed but readback failed. Keep your buffer and check the source before another save"))?;
        if after.record.content != request.content || saved_identity != after.identity {
            return Err(NativeError::new("ide_write_outcome_unknown", "The replacement completed but the source changed before verification. Keep your buffer; do not blindly retry"));
        }
        Ok(IdeSaveResult::Saved {
            file: after.record,
            receipt_id: receipt(),
            external_race_guard:
                "windows_parent_handles_and_precommit_identity_hash_not_filesystem_cas",
        })
    }
}

#[cfg(windows)]
fn copy_source_dacl(source: &File, destination: &File) -> NativeResult<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Security::{
            GetKernelObjectSecurity, SetKernelObjectSecurity, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        },
    };
    let denied = || {
        NativeError::new(
            "ide_permission_denied",
            "The source access rules could not be preserved. No replacement was attempted",
        )
    };
    let mut required = 0u32;
    // Query length first. No content/path is logged or passed to a shell.
    let _ = unsafe {
        GetKernelObjectSecurity(
            HANDLE(source.as_raw_handle()),
            DACL_SECURITY_INFORMATION.0,
            None,
            0,
            &mut required,
        )
    };
    if required == 0 || required > 1024 * 1024 {
        return Err(denied());
    }
    let mut storage = vec![
        0usize;
        (required as usize + std::mem::size_of::<usize>() - 1)
            / std::mem::size_of::<usize>()
    ];
    let descriptor = PSECURITY_DESCRIPTOR(storage.as_mut_ptr().cast());
    unsafe {
        GetKernelObjectSecurity(
            HANDLE(source.as_raw_handle()),
            DACL_SECURITY_INFORMATION.0,
            Some(descriptor),
            required,
            &mut required,
        )
    }
    .map_err(|_| denied())?;
    // Protect the copied effective DACL against parent inheritance during this
    // replacement. Owner/SACL/inheritance policy changes are not claimed here.
    unsafe {
        SetKernelObjectSecurity(
            HANDLE(destination.as_raw_handle()),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    }
    .map_err(|_| denied())
}

#[cfg(windows)]
struct StagingFile {
    handle: File,
    committed: bool,
}
#[cfg(windows)]
impl StagingFile {
    fn create(pins: &PinnedDirectories) -> NativeResult<Self> {
        let name = format!(".omnia-save-{}.tmp", Uuid::new_v4().simple());
        let handle = windows_file_ops::open_child(pins, std::ffi::OsStr::new(&name), true)?;
        Ok(Self {
            handle,
            committed: false,
        })
    }

    fn replace(&mut self, pins: &PinnedDirectories) -> NativeResult<()> {
        let name = pins
            .target
            .file_name()
            .ok_or_else(|| NativeError::invalid("relativePath", "has no file name"))?;
        windows_file_ops::rename_child(&self.handle, pins, name)?;
        self.committed = true;
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for StagingFile {
    fn drop(&mut self) {
        if !self.committed {
            // The retained handle denies DELETE sharing. Mark the HANDLE for
            // deletion rather than opening its path, which cannot follow links.
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::{
                Foundation::HANDLE,
                Storage::FileSystem::{
                    FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
                },
            };
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            let _ = unsafe {
                SetFileInformationByHandle(
                    HANDLE(self.handle.as_raw_handle()),
                    FileDispositionInfo,
                    (&info as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            };
        }
    }
}

#[cfg(test)]
#[path = "ide_files_tests.rs"]
mod tests;
