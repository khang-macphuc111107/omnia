//! Chunked browser `blob:` URL reader snippet and out-of-order disk [`BlobAssembler`].
//!
//! Security & scope:
//! - Genuine `Blob` / `File` URLs only (`MSE` stream `blob:` objects cannot be fetched via `fetch(blob:)`
//!   and must be harvested via stream/manifest capture).
//! - Rejects UNC/SMB/workspace-internal destinations via [`validate_safe_local_path`].

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use omnia_core::base64_decode;

use crate::types::{safe_output_filename, validate_safe_local_path, DownloaderError};

/// Maximum single base64-decoded `blob:` chunk size permitted in memory (8 MiB).
pub const MAX_BLOB_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// Maximum accumulated `blob:` chunks buffered before disk flush or limit rejection (4,096 chunks).
pub const MAX_BLOB_CHUNKS: usize = 4_096;

/// Safe 1 MiB chunked reader JavaScript for genuine browser `Blob`/`File` URLs.
/// Note: MSE (`MediaSource`) `blob:` URLs fail `fetch(blobUrl)` and require manifest/MSE hooks.
pub const BLOB_READER_JS: &str = r#"(async (blobUrl, chunkSize = 1048576) => {
  const resp = await fetch(blobUrl);
  const blob = await resp.blob();
  const total = blob.size;
  const chunks = [];
  for (let offset = 0; offset < total; offset += chunkSize) {
    const slice = blob.slice(offset, Math.min(offset + chunkSize, total));
    const buf = new Uint8Array(await slice.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) {
      bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    }
    chunks.push({ index: Math.floor(offset / chunkSize), base64: btoa(bin) });
  }
  return { totalBytes: total, mimeType: blob.type || '', chunks };
})"#;

/// Out-of-order and duplicate-tolerant disk reassembler for chunked browser `blob:` uploads.
pub struct BlobAssembler {
    final_path: PathBuf,
    part_path: PathBuf,
    chunks: BTreeMap<usize, Vec<u8>>,
    total_chunks: Option<usize>,
    total_bytes: u64,
}

impl BlobAssembler {
    /// Initializes a staged `.part` blob target outside `workspace_root`.
    pub fn new(
        staging_dir: &Path,
        raw_filename: &str,
        workspace_root: Option<&Path>,
    ) -> Result<Self, DownloaderError> {
        let safe_dir = validate_safe_local_path(staging_dir, workspace_root)?;
        fs::create_dir_all(&safe_dir)?;
        let safe_name = safe_output_filename(raw_filename)?;
        let final_path = safe_dir.join(&safe_name);
        let part_path = safe_dir.join(format!("{safe_name}.blob.part"));
        Ok(Self {
            final_path,
            part_path,
            chunks: BTreeMap::new(),
            total_chunks: None,
            total_bytes: 0,
        })
    }

    /// Accepts a raw byte slice at `chunk_index` (idempotent on duplicate indices).
    pub fn push_chunk(&mut self, chunk_index: usize, data: Vec<u8>) -> Result<(), DownloaderError> {
        if data.len() > MAX_BLOB_CHUNK_BYTES {
            return Err(DownloaderError::SecurityRejected(format!(
                "blob chunk {chunk_index} exceeds {MAX_BLOB_CHUNK_BYTES}-byte limit"
            )));
        }
        if chunk_index >= MAX_BLOB_CHUNKS && !self.chunks.contains_key(&chunk_index) {
            return Err(DownloaderError::SecurityRejected(format!(
                "blob chunk index {chunk_index} exceeds {MAX_BLOB_CHUNKS} cap"
            )));
        }
        if !self.chunks.contains_key(&chunk_index) && self.chunks.len() >= MAX_BLOB_CHUNKS {
            return Err(DownloaderError::SecurityRejected(
                "blob chunk count exceeded maximum cap".into(),
            ));
        }
        if let Some(prev) = self.chunks.insert(chunk_index, data) {
            self.total_bytes = self.total_bytes.saturating_sub(prev.len() as u64);
        }
        if let Some(cur) = self.chunks.get(&chunk_index) {
            self.total_bytes = self.total_bytes.saturating_add(cur.len() as u64);
        }
        Ok(())
    }

    /// Decodes base64 chunk payload and inserts it at `chunk_index`.
    pub fn push_base64_chunk(
        &mut self,
        chunk_index: usize,
        b64: &str,
    ) -> Result<usize, DownloaderError> {
        let decoded = base64_decode(b64.trim()).map_err(|e| {
            DownloaderError::InvalidInput(format!("invalid blob chunk base64: {e}"))
        })?;
        let n = decoded.len();
        self.push_chunk(chunk_index, decoded)?;
        Ok(n)
    }

    /// Declares total expected chunk count so [`Self::finalize`] verifies completeness.
    pub fn set_total_chunks(&mut self, count: usize) -> Result<(), DownloaderError> {
        if count > MAX_BLOB_CHUNKS {
            return Err(DownloaderError::SecurityRejected(format!(
                "total_chunks {count} exceeds {MAX_BLOB_CHUNKS}"
            )));
        }
        self.total_chunks = Some(count);
        Ok(())
    }

    /// Writes contiguous chunks `0..count` sequentially to `.part` and atomically renames to destination.
    pub fn finalize(self) -> Result<(PathBuf, u64), DownloaderError> {
        let expected = self.total_chunks.unwrap_or(self.chunks.len());
        if expected == 0 && self.chunks.is_empty() {
            return Err(DownloaderError::InvalidInput(
                "cannot finalize empty blob assembly".into(),
            ));
        }
        for idx in 0..expected {
            if !self.chunks.contains_key(&idx) {
                return Err(DownloaderError::InvalidInput(format!(
                    "missing blob chunk {idx} of {expected}"
                )));
            }
        }
        let mut file = File::create(&self.part_path)?;
        let mut written = 0u64;
        for idx in 0..expected {
            if let Some(bytes) = self.chunks.get(&idx) {
                file.write_all(bytes)?;
                written = written.saturating_add(bytes.len() as u64);
            }
        }
        file.sync_all()?;
        drop(file);
        if self.final_path.exists() {
            let _ = fs::remove_file(&self.final_path);
        }
        fs::rename(&self.part_path, &self.final_path)?;
        Ok((self.final_path, written))
    }

    /// Cleans up partial temp state without creating the output file.
    pub fn abort(self) {
        let _ = fs::remove_file(&self.part_path);
    }

    #[must_use]
    pub fn buffered_bytes(&self) -> u64 {
        self.total_bytes
    }

    /// Number of unique chunk indices buffered so far.
    #[must_use]
    pub fn received_count(&self) -> usize {
        self.chunks.len()
    }

    /// Returns `true` when `total_chunks > 0` and every chunk index `0..total_chunks` has arrived.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        let Some(total) = self.total_chunks else {
            return false;
        };
        total > 0 && (0..total).all(|idx| self.chunks.contains_key(&idx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_out_of_order_and_duplicate_blob_chunks_atomically() {
        let dir = std::env::temp_dir().join(format!(
            "omnia-dl-blob-test-{}",
            omnia_core::uuid_v4_simple()
        ));
        let mut asm = BlobAssembler::new(&dir, "capture.bin", None).unwrap();
        asm.set_total_chunks(2).unwrap();
        asm.push_base64_chunk(1, "V09STEQh").unwrap(); // "WORLD!"
        asm.push_chunk(0, b"HELLO ".to_vec()).unwrap();
        // Duplicate rewrite at index 0 stays idempotent.
        asm.push_chunk(0, b"HELLO ".to_vec()).unwrap();
        let (out, bytes) = asm.finalize().unwrap();
        assert_eq!(bytes, 12);
        assert_eq!(fs::read(&out).unwrap(), b"HELLO WORLD!");
        let _ = fs::remove_dir_all(&dir);
    }
}
