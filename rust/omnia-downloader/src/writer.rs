//! Streaming pre-allocated random-access disk I/O (`PositionalWriter`).
//!
//! Uses 100% safe Rust (`#![forbid(unsafe_code)]`):
//! - Pre-allocates destination `.part` size via `File::set_len(expected_size)`.
//! - Writes chunks directly to disk offsets via `FileExt::seek_write` on Windows
//!   (and `Seek` + `Write` on non-Windows) with ZERO full-file RAM buffering.
//! - Supports `truncate_to_zero` for `200 OK` Range-violation fallback.
//! - Rejects UNC/SMB paths, reparse points, and workspace-internal staging dirs.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::types::{validate_safe_local_path, DownloaderError};

/// Thread-safe streaming random-access positional file writer.
#[derive(Clone)]
pub struct PositionalWriter {
    path: PathBuf,
    file: Arc<Mutex<File>>,
}

impl PositionalWriter {
    /// Opens or creates a `.part` staging file after enforcing UNC/reparse/external-staging
    /// containment, optionally pre-allocating `expected_size` bytes when `> 0`.
    pub fn open_or_create(
        path: &Path,
        expected_size: u64,
        workspace_root: Option<&Path>,
    ) -> Result<Self, DownloaderError> {
        let safe_path = validate_safe_local_path(path, workspace_root)?;
        if let Some(parent) = safe_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&safe_path)?;

        if expected_size > 0 {
            let current_len = file.metadata()?.len();
            if current_len != expected_size {
                file.set_len(expected_size)?;
            }
        }

        Ok(Self {
            path: safe_path,
            file: Arc::new(Mutex::new(file)),
        })
    }

    /// Path of the underlying `.part` file.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes `data` at exact byte `offset` without mutating any shared cursor outside the lock.
    #[cfg(windows)]
    pub fn write_at(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        use std::os::windows::fs::FileExt;
        if data.is_empty() {
            return Ok(());
        }
        let file = self.file.lock();
        let mut written = 0usize;
        while written < data.len() {
            let n = file.seek_write(&data[written..], offset + written as u64)?;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "seek_write returned 0 bytes",
                ));
            }
            written += n;
        }
        Ok(())
    }

    /// Portable non-Windows random-access write.
    #[cfg(not(windows))]
    pub fn write_at(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        if data.is_empty() {
            return Ok(());
        }
        let mut file = self.file.lock();
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(data)?;
        Ok(())
    }

    /// Async wrapper running [`Self::write_at`] on Tokio's blocking pool so disk I/O
    /// never stalls concurrent network streams.
    pub async fn write_at_async(&self, offset: u64, data: bytes::Bytes) -> Result<(), DownloaderError> {
        let writer = self.clone();
        tokio::task::spawn_blocking(move || writer.write_at(offset, &data))
            .await
            .map_err(|err| {
                DownloaderError::Io(io::Error::other(format!("write task join error: {err}")))
            })??;
        Ok(())
    }

    /// Truncates the file to `0` bytes (used when a server violates Range with `200 OK`
    /// and the engine falls back cleanly to a fresh single-stream transfer).
    pub fn truncate_to_zero(&self) -> io::Result<()> {
        let file = self.file.lock();
        file.set_len(0)?;
        file.sync_data()
    }

    /// Sets file length to `len` bytes.
    pub fn set_len(&self, len: u64) -> io::Result<()> {
        let file = self.file.lock();
        file.set_len(len)
    }

    /// Flushes OS buffers to disk.
    pub fn sync_all(&self) -> io::Result<()> {
        let file = self.file.lock();
        file.sync_all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_unc_smb_paths() {
        let err = PositionalWriter::open_or_create(
            Path::new(r"\\fileserver\share\payload.part"),
            1024,
            None,
        )
        .err()
        .expect("UNC path must be rejected");
        assert!(matches!(err, DownloaderError::ForbiddenPath { .. }));

        let err_verbatim = PositionalWriter::open_or_create(
            Path::new(r"\\?\UNC\fileserver\share\payload.part"),
            1024,
            None,
        )
        .err()
        .expect("verbatim UNC path must be rejected");
        assert!(matches!(err_verbatim, DownloaderError::ForbiddenPath { .. }));
    }

    #[test]
    fn preallocates_writes_out_of_order_and_truncates() {
        let dir = std::env::temp_dir().join(format!(
            "omnia-dl-writer-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let path = dir.join("sample.bin.part");
        let writer = PositionalWriter::open_or_create(&path, 12, None).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 12);

        writer.write_at(6, b"WORLD!").unwrap();
        writer.write_at(0, b"HELLO ").unwrap();
        writer.sync_all().unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"HELLO WORLD!");

        writer.truncate_to_zero().unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);

        drop(writer);
        let _ = fs::remove_dir_all(&dir);
    }
}
