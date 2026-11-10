//! Blob download support for the browser layer.
//!
//! # Important: MSE-backed `blob:` URLs
//!
//! A `blob:` URL that a `<video>` element plays through MediaSource Extensions (YouTube,
//! most HLS/DASH players) is **not** a downloadable blob: it only represents a live
//! `MediaSource` object and `fetch(blobUrl)` fails or returns nothing useful. The real
//! media comes from the underlying manifest / segment requests; use
//! [`crate::detect::classify`] on the captured network traffic, which surfaces the HLS /
//! DASH manifests (and hides their fragments), and download those with the stream
//! pipeline. [`BLOB_READER_JS`] is for genuine `Blob`/`File` URLs (generated files,
//! canvas/recorder output, `URL.createObjectURL(file)` ...).

use crate::error::{DownloadError, Result};
use crate::fsutil::{move_file, sanitize_file_name, unique_path, with_suffix};
use base64::Engine;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Page-side JavaScript. Evaluates to an async function
/// `(blobUrl: string, onChunk?: (chunk) => any) => Promise<{mime, size, total, chunks?}>`.
///
/// The blob is fetched in-page and sliced into chunks of at most 1 MiB (`chunk.data` is
/// base64, `chunk` is `{index, total, data}`). With `onChunk`, each chunk is awaited and
/// delivered as it is produced (low memory); without it the chunks are returned in
/// `chunks`. Feed every chunk to [`BlobAssembler::accept`].
pub const BLOB_READER_JS: &str = r#"(async function omniaReadBlob(blobUrl, onChunk) {
  const CHUNK = 1024 * 1024;
  const resp = await fetch(blobUrl);
  if (!resp.ok) { throw new Error('blob fetch failed: ' + resp.status); }
  const blob = await resp.blob();
  const total = Math.max(1, Math.ceil(blob.size / CHUNK));
  const toBase64 = (bytes) => {
    let bin = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(bin);
  };
  const chunks = [];
  for (let index = 0; index < total; index++) {
    const part = blob.slice(index * CHUNK, Math.min(blob.size, (index + 1) * CHUNK));
    const data = toBase64(new Uint8Array(await part.arrayBuffer()));
    const chunk = { index, total, data };
    if (onChunk) { await onChunk(chunk); } else { chunks.push(chunk); }
  }
  return onChunk
    ? { mime: blob.type, size: blob.size, total }
    : { mime: blob.type, size: blob.size, total, chunks };
})"#;

/// Reassembles base64 chunks `(index, total, data)` (in any order) into a file.
pub struct BlobAssembler {
    dest_dir: PathBuf,
    file_name: String,
    part: PathBuf,
    file: Option<File>,
    total: Option<u32>,
    next: u32,
    pending: BTreeMap<u32, Vec<u8>>,
    written: u64,
}

impl BlobAssembler {
    pub fn new(dest_dir: &Path, file_name: &str) -> Result<Self> {
        std::fs::create_dir_all(dest_dir)?;
        let file_name = sanitize_file_name(file_name);
        let part = with_suffix(&dest_dir.join(&file_name), ".part");
        let file = File::create(&part)?;
        Ok(Self {
            dest_dir: dest_dir.to_path_buf(),
            file_name,
            part,
            file: Some(file),
            total: None,
            next: 0,
            pending: BTreeMap::new(),
            written: 0,
        })
    }

    /// Accept one chunk. Duplicates of an already written/pending index are ignored.
    /// Returns the number of bytes written to disk so far.
    pub fn accept(&mut self, index: u32, total: u32, data_base64: &str) -> Result<u64> {
        if total == 0 || index >= total {
            return Err(DownloadError::InvalidRequest(format!(
                "chunk {index} out of range (total {total})"
            )));
        }
        match self.total {
            None => self.total = Some(total),
            Some(t) if t != total => {
                return Err(DownloadError::InvalidRequest(format!(
                    "chunk total changed from {t} to {total}"
                )))
            }
            _ => {}
        }
        if index < self.next || self.pending.contains_key(&index) {
            return Ok(self.written);
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|e| {
                DownloadError::InvalidRequest(format!("bad base64 in chunk {index}: {e}"))
            })?;
        self.pending.insert(index, bytes);
        while let Some(chunk) = self.pending.remove(&self.next) {
            let f = self
                .file
                .as_mut()
                .ok_or_else(|| DownloadError::Other("assembler already finished".into()))?;
            f.write_all(&chunk)?;
            self.written += chunk.len() as u64;
            self.next += 1;
        }
        Ok(self.written)
    }

    pub fn is_complete(&self) -> bool {
        self.total.is_some_and(|t| self.next == t)
    }

    pub fn bytes_written(&self) -> u64 {
        self.written
    }

    /// `(received_in_order, total)`.
    pub fn chunks_progress(&self) -> (u32, Option<u32>) {
        (self.next, self.total)
    }

    /// Finalise: requires every chunk; moves the file to its (non-colliding) final name.
    pub fn finish(&mut self) -> Result<PathBuf> {
        if !self.is_complete() {
            return Err(DownloadError::Other(format!(
                "blob incomplete: {} of {:?} chunks",
                self.next, self.total
            )));
        }
        if let Some(mut f) = self.file.take() {
            f.flush()?;
        }
        let dest = unique_path(&self.dest_dir, &self.file_name);
        move_file(&self.part, &dest)?;
        Ok(dest)
    }

    /// Delete the partial file.
    pub fn abort(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(&self.part);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    #[test]
    fn assembles_out_of_order_with_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = BlobAssembler::new(dir.path(), "clip.bin").unwrap();
        assert_eq!(a.accept(2, 3, &b64(b"CCC")).unwrap(), 0);
        assert!(a.finish().is_err());
        assert_eq!(a.accept(0, 3, &b64(b"AA")).unwrap(), 2);
        assert_eq!(a.accept(0, 3, &b64(b"AA")).unwrap(), 2); // duplicate ignored
        assert!(!a.is_complete());
        assert_eq!(a.accept(1, 3, &b64(b"BBB")).unwrap(), 8);
        assert!(a.is_complete());
        std::fs::write(dir.path().join("clip.bin"), b"existing").unwrap();
        let path = a.finish().unwrap();
        assert_eq!(path.file_name().unwrap(), "clip (1).bin");
        assert_eq!(std::fs::read(path).unwrap(), b"AABBBCCC");
    }

    #[test]
    fn rejects_bad_input() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = BlobAssembler::new(dir.path(), "x").unwrap();
        assert!(a.accept(5, 3, "AA==").is_err());
        assert!(a.accept(0, 3, "!!!").is_err());
        a.accept(0, 3, "AA==").unwrap();
        assert!(a.accept(1, 4, "AA==").is_err());
        a.abort();
        assert!(!dir.path().join("x.part").exists());
    }

    #[test]
    fn js_snippet_shape() {
        assert!(BLOB_READER_JS.contains("1024 * 1024") && BLOB_READER_JS.contains("btoa"));
    }
}
