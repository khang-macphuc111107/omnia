//! Kernel-backed ownership of one database file, acquired before SQLite opens.
//!
//! This is a cooperative local-process ownership boundary, not an effect lease
//! or a substitute for SQLite's transactions. A host shares its one store using
//! `Arc`; it must not reopen the recovering database for an observer. The guard
//! must outlive every connection that belongs to that store.
//!
//! Locking the file itself makes relative paths, symlinks and hard links to the
//! same file contend on its kernel identity. Windows additionally denies delete
//! sharing while the guard is alive. On Unix, `flock` is advisory and does not
//! prevent rename/unlink or replacement; the database directory must remain
//! app-controlled. Neither implementation protects against an actor bypassing
//! this protocol or replacing an ancestor/reparse target during open.

use std::fs::File;
use std::path::Path;

#[cfg(any(windows, unix))]
use std::{fs::OpenOptions, io};

use crate::error::{NativeError, NativeResult};

/// The private file handle owns the kernel lock. Closing it releases ownership,
/// including when the process exits; no PID record, timeout or stale-file delete
/// can accidentally revoke an active owner. Do not clone this handle.
pub(crate) struct StoreOwnership {
    _file: File,
}

fn failed() -> NativeError {
    NativeError::new(
        "harness_store_ownership_failed",
        "Exclusive agent session storage ownership could not be established",
    )
}

#[cfg(any(windows, unix))]
fn classify(error: io::Error) -> NativeError {
    #[cfg(windows)]
    let conflict = matches!(
        error.raw_os_error(),
        Some(code)
            if code == windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32
                || code == windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32
    );
    #[cfg(unix)]
    let conflict = error.kind() == io::ErrorKind::WouldBlock;

    if conflict {
        NativeError::retryable(
            "harness_store_busy",
            "Agent session storage is already owned by another store",
        )
    } else {
        // OS error descriptions may contain a path or other private data.
        failed()
    }
}

impl StoreOwnership {
    pub(crate) fn acquire(path: &Path) -> NativeResult<Self> {
        #[cfg(any(windows, unix))]
        {
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);

            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
                // SQLite can open/read/write the same identity. Denying delete
                // sharing prevents replacing that file while this owner lives.
                options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                // Existing permissions are preserved; newly created stores
                // must not become world-readable through this early open.
                options.mode(0o600);
            }

            let file = options.open(path).map_err(classify)?;
            if !file.metadata().map_err(classify)?.is_file() {
                return Err(failed());
            }
            lock(&file).map_err(classify)?;
            Ok(Self { _file: file })
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = path;
            Err(failed())
        }
    }
}

#[cfg(windows)]
fn lock(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
        System::IO::{OVERLAPPED, OVERLAPPED_0, OVERLAPPED_0_0},
    };

    // One byte at 2^63-2 is outside SQLite's pending/shared lock region
    // (0x40000000) and valid SQLite database payload sizes. A byte-range lock
    // beyond EOF does not extend/truncate/write the file.
    const OFFSET: u64 = 0x7fff_ffff_ffff_fffe;
    let mut overlapped = OVERLAPPED {
        Anonymous: OVERLAPPED_0 {
            Anonymous: OVERLAPPED_0_0 {
                Offset: OFFSET as u32,
                OffsetHigh: (OFFSET >> 32) as u32,
            },
        },
        ..OVERLAPPED::default()
    };
    // SAFETY: the live File owns a synchronous handle with read/write access.
    // `overlapped` is initialized and remains valid throughout the synchronous,
    // fail-immediate call. Reserved is zero and the range is exactly one byte.
    let success = unsafe {
        LockFileEx(
            file.as_raw_handle(),
            LOCKFILE_FAIL_IMMEDIATELY | LOCKFILE_EXCLUSIVE_LOCK,
            0,
            1,
            0,
            &mut overlapped,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    // SAFETY: File owns this live descriptor. flock has no pointer arguments;
    // LOCK_NB prevents blocking, and ownership ends when this handle closes.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(all(test, any(windows, unix)))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("omnia-store-owner-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }

        fn database(&self) -> PathBuf {
            self.root.join("sessions.sqlite3")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Remove only this fixture's named files, after guards close.
            // Preserve unexpected files rather than recursively deleting.
            for name in ["sessions.sqlite3", "alias.sqlite3", "other.sqlite3"] {
                let _ = std::fs::remove_file(self.root.join(name));
            }
            let _ = std::fs::remove_dir(&self.root);
        }
    }

    #[test]
    fn second_owner_is_rejected_until_first_handle_closes() {
        let fixture = Fixture::new();
        let owner = StoreOwnership::acquire(&fixture.database()).unwrap();
        let error = StoreOwnership::acquire(&fixture.database()).err().unwrap();
        assert_eq!(error.code, "harness_store_busy");
        assert!(error.retryable);
        assert!(!error.message.contains(&fixture.root.to_string_lossy()[..]));
        drop(owner);
        let successor = StoreOwnership::acquire(&fixture.database()).unwrap();
        drop(successor);
    }

    #[test]
    fn hard_link_alias_contends_on_the_database_identity() {
        let fixture = Fixture::new();
        std::fs::write(fixture.database(), b"fixture bytes").unwrap();
        // This test requires hard-link support in the test filesystem. Failure
        // is explicit rather than silently claiming alias coverage.
        let alias = fixture.root.join("alias.sqlite3");
        std::fs::hard_link(fixture.database(), &alias).unwrap();
        let owner = StoreOwnership::acquire(&fixture.database()).unwrap();
        let error = StoreOwnership::acquire(&alias).err().unwrap();
        assert_eq!(error.code, "harness_store_busy");
        drop(owner);
        let successor = StoreOwnership::acquire(&alias).unwrap();
        drop(successor);
        assert_eq!(std::fs::read(alias).unwrap(), b"fixture bytes");
    }

    #[test]
    fn acquisition_preserves_existing_bytes_and_new_file_length() {
        let fixture = Fixture::new();
        let original = b"Existing bytes must not be overwritten";
        std::fs::write(fixture.database(), original).unwrap();
        let owner = StoreOwnership::acquire(&fixture.database()).unwrap();
        assert_eq!(std::fs::read(fixture.database()).unwrap(), original);
        assert_eq!(
            std::fs::metadata(fixture.database()).unwrap().len(),
            original.len() as u64
        );
        let other = fixture.root.join("other.sqlite3");
        let independent_owner = StoreOwnership::acquire(&other).unwrap();
        assert_eq!(std::fs::metadata(other).unwrap().len(), 0);
        drop(independent_owner);
        drop(owner);
        assert_eq!(std::fs::read(fixture.database()).unwrap(), original);
    }

    #[test]
    fn open_failure_is_static_and_nonretryable() {
        let fixture = Fixture::new();
        let private_path = fixture.root.join("missing-private-parent/session.sqlite3");
        let error = StoreOwnership::acquire(&private_path).err().unwrap();
        assert_eq!(error.code, "harness_store_ownership_failed");
        assert!(!error.retryable);
        assert!(!error.message.contains("missing-private-parent"));
        assert!(!error.message.contains(&fixture.root.to_string_lossy()[..]));
    }

    #[cfg(windows)]
    #[test]
    fn windows_owner_denies_database_rename_and_delete_until_release() {
        let fixture = Fixture::new();
        let owner = StoreOwnership::acquire(&fixture.database()).unwrap();
        let alias = fixture.root.join("alias.sqlite3");
        assert!(std::fs::rename(fixture.database(), &alias).is_err());
        assert!(std::fs::remove_file(fixture.database()).is_err());
        drop(owner);
        std::fs::rename(fixture.database(), &alias).unwrap();
        let successor = StoreOwnership::acquire(&alias).unwrap();
        drop(successor);
    }
}
