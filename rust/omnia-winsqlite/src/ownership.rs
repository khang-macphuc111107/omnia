use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, GENERIC_READ,
    GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, LockFileEx, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK,
    LOCKFILE_FAIL_IMMEDIATELY, OPEN_ALWAYS,
};
use windows_sys::Win32::System::IO::OVERLAPPED;

use crate::error::WinSqliteError;
use crate::ffi::CreateFileW;

const LOCK_OFFSET_LOW: u32 = 0xFFFF_FFFE;
const LOCK_OFFSET_HIGH: u32 = 0x7FFF_FFFF;

/// Exclusive single-byte Win32 advisory lock (`0x7fff_ffff_ffff_fffe`) held on the
/// exact SQLite database path to enforce single-instance store ownership.
#[derive(Debug)]
pub struct StoreOwnership {
    path: PathBuf,
    handle: HANDLE,
}

// SAFETY: `StoreOwnership` solely owns a private Win32 file `HANDLE` whose only
// mutation occurs during `Drop` via `CloseHandle`. Moving ownership across
// threads (`Send`) and reading `path()` concurrently (`Sync`) are both sound.
unsafe impl Send for StoreOwnership {}
unsafe impl Sync for StoreOwnership {}

impl StoreOwnership {
    /// Acquire an exclusive non-blocking advisory byte-range lock on `db_path`.
    ///
    /// Returns `harness_store_busy` when another process or handle holds the lock
    /// (`ERROR_LOCK_VIOLATION` / `ERROR_SHARING_VIOLATION`), and
    /// `harness_store_ownership_failed` on all other path/Win32 errors.
    pub fn acquire(db_path: impl AsRef<Path>) -> Result<Self, WinSqliteError> {
        let path = db_path.as_ref().to_path_buf();
        if path.as_os_str().is_empty() {
            return Err(WinSqliteError::ownership_failed(
                "Harness store path cannot be empty.",
                None,
            ));
        }

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
        if wide
            .iter()
            .take(wide.len().saturating_sub(1))
            .any(|&u| u == 0)
        {
            return Err(WinSqliteError::ownership_failed(
                "Harness store path contains an interior NUL character.",
                None,
            ));
        }

        // SAFETY: `wide` is NUL-terminated UTF-16 valid for the duration of `CreateFileW`.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            // SAFETY: Thread-local Win32 error query immediately after failed API call.
            let win32 = unsafe { GetLastError() };
            if win32 == ERROR_SHARING_VIOLATION || win32 == ERROR_LOCK_VIOLATION {
                return Err(WinSqliteError::busy(
                    "harness_store_busy",
                    format!(
                        "Another Omnia instance already holds the harness store open: {}",
                        path.display()
                    ),
                    Some(win32),
                ));
            }
            return Err(WinSqliteError::ownership_failed(
                WinSqliteError::format_win32_detail(
                    &format!(
                        "Failed to open harness store ownership handle for {}",
                        path.display()
                    ),
                    win32,
                ),
                Some(win32),
            ));
        }

        // SAFETY: `info` is zero-initialized POD and `handle` is an open Win32 file handle.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `handle` is valid and `info` points to writable stack memory.
        if unsafe { GetFileInformationByHandle(handle, &mut info) } != 0
            && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
        {
            // SAFETY: Close valid handle before returning error.
            unsafe {
                CloseHandle(handle);
            }
            return Err(WinSqliteError::ownership_failed(
                format!(
                    "Harness store path cannot reference a directory: {}",
                    path.display()
                ),
                None,
            ));
        }

        // SAFETY: `OVERLAPPED` is a C POD struct where all-zero initialization is valid.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.Anonymous.Anonymous.Offset = LOCK_OFFSET_LOW;
        overlapped.Anonymous.Anonymous.OffsetHigh = LOCK_OFFSET_HIGH;

        // SAFETY: `handle` is valid and `overlapped` points to valid initialized stack storage.
        let locked = unsafe {
            LockFileEx(
                handle,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if locked == 0 {
            // SAFETY: Query Win32 error code immediately after failed `LockFileEx` before closing handle.
            let win32 = unsafe { GetLastError() };
            // SAFETY: `handle` is open and no longer needed after lock failure.
            unsafe {
                CloseHandle(handle);
            }
            if win32 == ERROR_LOCK_VIOLATION || win32 == ERROR_SHARING_VIOLATION {
                return Err(WinSqliteError::busy(
                    "harness_store_busy",
                    format!(
                        "Another Omnia instance already holds exclusive ownership of the harness store: {}",
                        path.display()
                    ),
                    Some(win32),
                ));
            }
            return Err(WinSqliteError::ownership_failed(
                WinSqliteError::format_win32_detail(
                    &format!(
                        "Failed to lock harness store ownership handle for {}",
                        path.display()
                    ),
                    win32,
                ),
                Some(win32),
            ));
        }

        Ok(Self { path, handle })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StoreOwnership {
    fn drop(&mut self) {
        if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
            // SAFETY: `self.handle` is uniquely owned by `self` and closed at most once on drop.
            unsafe {
                CloseHandle(self.handle);
            }
            self.handle = INVALID_HANDLE_VALUE;
        }
    }
}
