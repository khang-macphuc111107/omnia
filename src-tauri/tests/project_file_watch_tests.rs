#![allow(dead_code)]

#[path = "../src/error.rs"]
mod error;
#[path = "../src/project_file_watch.rs"]
mod project_file_watch;

use project_file_watch::{ProjectFileAvailability, ProjectFileWatch};
use std::{fs, path::PathBuf};

struct TemporarySource {
    root: PathBuf,
}
impl TemporarySource {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "omnia-project-watch-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}
impl Drop for TemporarySource {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn observes_content_changes_and_keeps_receipts_content_free() {
    let source = TemporarySource::new();
    let path = source.path("source.txt");
    fs::write(&path, b"first").unwrap();
    let mut watch = ProjectFileWatch::open(&path, 4096).unwrap();
    let first = watch.refresh(0).unwrap();
    assert_eq!(first.content.as_deref(), Some(b"first".as_slice()));
    assert_eq!(first.receipt.availability, ProjectFileAvailability::Present);
    assert!(first.receipt.content_changed);
    let unchanged = watch.refresh(1).unwrap();
    assert_eq!(unchanged.content, None);
    assert!(!unchanged.receipt.content_changed);
    fs::write(&path, b"second").unwrap();
    let changed = watch.refresh(2).unwrap();
    assert_eq!(changed.content.as_deref(), Some(b"second".as_slice()));
    assert_ne!(changed.receipt.content_sha256, first.receipt.content_sha256);
    assert_eq!(changed.receipt.identity, first.receipt.identity);
    let json = serde_json::to_string(&changed.receipt).unwrap();
    assert!(!json.contains("second"));
    assert!(!json.contains("source.txt"));
}

#[cfg(any(windows, target_os = "linux"))]
#[test]
fn resolves_renames_by_open_handle_without_scanning_directories() {
    let source = TemporarySource::new();
    let path = source.path("old.bin");
    let renamed = source.path("new.bin");
    fs::write(&path, [0, 1, 2, 255]).unwrap();
    let mut watch = ProjectFileWatch::open(&path, 4096).unwrap();
    let first = watch.refresh(0).unwrap();
    fs::rename(&path, &renamed).unwrap();
    let refresh = watch.refresh(1).unwrap();
    assert!(refresh.receipt.path_changed);
    assert!(!refresh.receipt.content_changed);
    assert_eq!(refresh.receipt.identity, first.receipt.identity);
    assert_eq!(
        refresh.receipt.availability,
        ProjectFileAvailability::Present
    );
    assert_eq!(refresh.current_path.as_deref(), Some(renamed.as_path()));
    assert!(refresh.content.is_none());
}

#[test]
fn removed_source_retains_the_last_successful_copy() {
    let source = TemporarySource::new();
    let path = source.path("removed.txt");
    fs::write(&path, b"retained latest bytes").unwrap();
    let mut watch = ProjectFileWatch::open(&path, 4096).unwrap();
    let first = watch.refresh(0).unwrap();
    let saved_copy = first.content.unwrap();
    fs::remove_file(&path).unwrap();
    let removed = watch.refresh(1).unwrap();
    assert_eq!(
        removed.receipt.availability,
        ProjectFileAvailability::Removed
    );
    assert_eq!(removed.receipt.content_sha256, first.receipt.content_sha256);
    assert!(removed.current_path.is_none());
    assert!(removed.content.is_none());
    assert_eq!(saved_copy, b"retained latest bytes");
}

#[test]
fn replacement_at_same_path_cannot_rebind_the_existing_watcher() {
    let source = TemporarySource::new();
    let path = source.path("source.txt");
    let moved = source.path("moved.txt");
    fs::write(&path, b"original object").unwrap();
    let mut watch = ProjectFileWatch::open(&path, 4096).unwrap();
    let first = watch.refresh(0).unwrap();
    fs::rename(&path, moved).unwrap();
    fs::write(&path, b"replacement object").unwrap();
    let refresh = watch.refresh(1).unwrap();
    assert_eq!(refresh.receipt.identity, first.receipt.identity);
    assert_eq!(refresh.receipt.content_sha256, first.receipt.content_sha256);
    assert!(ProjectFileWatch::resume(&path, &first.receipt.identity, 4096).is_err());
}

#[test]
fn stale_cancelled_and_oversize_refreshes_do_not_advance_revision() {
    let source = TemporarySource::new();
    let path = source.path("bounded.txt");
    fs::write(&path, b"small").unwrap();
    let mut watch = ProjectFileWatch::open(&path, 8).unwrap();
    let first = watch.refresh(0).unwrap();
    assert!(watch.refresh(0).is_err());
    assert_eq!(watch.revision(), 1);
    assert!(watch.refresh_with_cancel(1, || true).is_err());
    assert_eq!(watch.revision(), 1);
    fs::write(&path, b"exceeds byte budget").unwrap();
    assert!(watch.refresh(1).is_err());
    assert_eq!(watch.revision(), 1);
    fs::write(&path, b"small").unwrap();
    let unchanged = watch.refresh(1).unwrap();
    assert_eq!(
        unchanged.receipt.content_sha256,
        first.receipt.content_sha256
    );
    assert!(unchanged.content.is_none());
}

#[test]
fn rejects_directories_relative_paths_and_unsupported_limits() {
    let source = TemporarySource::new();
    let path = source.path("normal.txt");
    fs::write(&path, b"a").unwrap();
    assert!(ProjectFileWatch::open(&source.root, 4096).is_err());
    assert!(ProjectFileWatch::open(std::path::Path::new("relative.txt"), 4096).is_err());
    assert!(ProjectFileWatch::open(&path, 0).is_err());
    assert!(ProjectFileWatch::open(&path, u64::MAX).is_err());
}
