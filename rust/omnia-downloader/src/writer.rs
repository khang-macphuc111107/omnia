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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::types::{validate_safe_local_path, DownloaderError};

/// Default user-space coalescing flush threshold (512 KiB).
pub const DEFAULT_COALESCE_BYTES: usize = 512 * 1024;

type PendingWriteChunk = Option<(u64, Vec<u8>)>;

/// Batches contiguous sequential chunks up to `max_buf_bytes` before issuing
/// `spawn_blocking` positional disk writes (porting `idmDiskPreallocator.js::CoalescedDiskWriter`).
#[derive(Clone)]
pub struct CoalescedDiskWriter {
    inner: PositionalWriter,
    max_buf_bytes: usize,
    pending: Arc<Mutex<PendingWriteChunk>>,
    disk_flushes: Arc<AtomicUsize>,
}

impl CoalescedDiskWriter {
    /// Creates a coalescing writer around `inner` flushing at `max_buf_bytes` (minimum 16 KiB).
    #[must_use]
    pub fn new(inner: PositionalWriter, max_buf_bytes: usize) -> Self {
        Self {
            inner,
            max_buf_bytes: max_buf_bytes.max(16 * 1024),
            pending: Arc::new(Mutex::new(None)),
            disk_flushes: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Number of underlying disk writes issued so far (for diagnostics/tests).
    #[must_use]
    pub fn disk_flush_count(&self) -> usize {
        self.disk_flushes.load(Ordering::Relaxed)
    }

    /// Appends `data` at `offset`, flushing automatically if non-contiguous or buffer threshold is reached.
    pub async fn write_at_coalesced(
        &self,
        offset: u64,
        data: bytes::Bytes,
    ) -> Result<(), DownloaderError> {
        if data.is_empty() {
            return Ok(());
        }

        let (prev_flush, direct_flush): (PendingWriteChunk, PendingWriteChunk) = {
            let mut guard = self.pending.lock();
            match guard.as_mut() {
                Some((start_off, buf)) if *start_off + (buf.len() as u64) == offset => {
                    buf.extend_from_slice(&data);
                    if buf.len() >= self.max_buf_bytes {
                        (guard.take(), None)
                    } else {
                        (None, None)
                    }
                }
                Some(_) => {
                    let prev = guard.take();
                    if data.len() >= self.max_buf_bytes {
                        (prev, Some((offset, data.to_vec())))
                    } else {
                        *guard = Some((offset, data.to_vec()));
                        (prev, None)
                    }
                }
                None => {
                    if data.len() >= self.max_buf_bytes {
                        (None, Some((offset, data.to_vec())))
                    } else {
                        *guard = Some((offset, data.to_vec()));
                        (None, None)
                    }
                }
            }
        };

        if let Some((po, pb)) = prev_flush {
            self.flush_raw(po, pb).await?;
        }
        if let Some((doff, dbuf)) = direct_flush {
            self.flush_raw(doff, dbuf).await?;
        }
        Ok(())
    }

    /// Flushes any buffered bytes to disk immediately.
    pub async fn flush_async(&self) -> Result<(), DownloaderError> {
        let pending = self.pending.lock().take();
        if let Some((off, buf)) = pending {
            self.flush_raw(off, buf).await?;
        }
        Ok(())
    }

    async fn flush_raw(&self, offset: u64, buf: Vec<u8>) -> Result<(), DownloaderError> {
        if buf.is_empty() {
            return Ok(());
        }
        self.disk_flushes.fetch_add(1, Ordering::Relaxed);
        self.inner
            .write_at_async(offset, bytes::Bytes::from(buf))
            .await
    }
}

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

    #[tokio::test]
    async fn coalesced_writer_batches_contiguous_writes_and_flushes_on_gap() {
        let dir = std::env::temp_dir().join(format!(
            "omnia-dl-coalesce-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let path = dir.join("coalesce.bin.part");
        let base = PositionalWriter::open_or_create(&path, 16, None).unwrap();
        let coalesced = CoalescedDiskWriter::new(base.clone(), 16 * 1024);

        coalesced
            .write_at_coalesced(0, bytes::Bytes::from_static(b"AAAA"))
            .await
            .unwrap();
        coalesced
            .write_at_coalesced(4, bytes::Bytes::from_static(b"BBBB"))
            .await
            .unwrap();
        // Contiguous writes stay buffered in user-space until threshold or gap.
        assert_eq!(coalesced.disk_flush_count(), 0);

        // Non-contiguous offset triggers flush of 0..8 first.
        coalesced
            .write_at_coalesced(12, bytes::Bytes::from_static(b"DDDD"))
            .await
            .unwrap();
        assert_eq!(coalesced.disk_flush_count(), 1);

        coalesced
            .write_at_coalesced(8, bytes::Bytes::from_static(b"CCCC"))
            .await
            .unwrap();
        coalesced.flush_async().await.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"AAAABBBBCCCCDDDD");

        drop(coalesced);
        drop(base);
        let _ = fs::remove_dir_all(&dir);
    }
}
