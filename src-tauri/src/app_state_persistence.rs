//! Small native persistence boundary for the renderer-owned Omnia snapshot.
//!
//! The durable product database remains authoritative for conversations,
//! provider facts, run journals, and other native records.  This store is a
//! deliberately separate JSON file for the renderer composition snapshot so
//! the renderer can use the same serialized contract in browser preview and
//! Tauri.  The command layer owns the IPC schema; this module owns only file
//! locking, atomic replacement, and a minimal top-level revision check.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::Value;
use uuid::Uuid;

use crate::error::{NativeError, NativeResult};

const SNAPSHOT_FILE_NAME: &str = "omnia-app-state.json";
const MAX_SNAPSHOT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECEIPT_ID_BYTES: usize = 128;

#[derive(Debug, Clone)]
pub struct AppStateSnapshotStore {
    path: PathBuf,
    operation_lock: std::sync::Arc<Mutex<()>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotLoad {
    Empty {
        receipt_id: String,
    },
    Loaded {
        snapshot: String,
        revision: i64,
        receipt_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotSave {
    Saved {
        revision: i64,
        receipt_id: String,
    },
    Conflict {
        current_revision: Option<i64>,
        expected_revision: Option<i64>,
        receipt_id: String,
    },
}

/// A validated transfer payload returned by the native IPC boundary.
///
/// Transfer bundles are deliberately not written to the app-state snapshot:
/// they are portable import/export envelopes, while the snapshot remains the
/// renderer composition store.  Keeping the payload as an owned `String`
/// also makes the IPC result detached from the parsed `serde_json::Value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferBundle {
    pub bundle: String,
    pub receipt_id: String,
}

impl AppStateSnapshotStore {
    pub fn open(app_data_dir: &Path) -> NativeResult<Self> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| NativeError::io("Could not prepare Omnia app-state storage", error))?;
        Ok(Self {
            path: app_data_dir.join(SNAPSHOT_FILE_NAME),
            operation_lock: std::sync::Arc::new(Mutex::new(())),
        })
    }

    pub fn load(&self, _minimum_revision: Option<i64>) -> NativeResult<SnapshotLoad> {
        let _guard = self.operation_lock.lock().map_err(|_| {
            NativeError::new(
                "storage_lock_failed",
                "Omnia app-state storage is unavailable",
            )
        })?;
        if !self.path.exists() {
            return Ok(SnapshotLoad::Empty {
                receipt_id: self.receipt("load"),
            });
        }

        let bytes = fs::read(&self.path).map_err(|error| {
            NativeError::io("Could not read the Omnia app-state snapshot", error)
        })?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(NativeError::new(
                "snapshot_too_large",
                "The Omnia app-state snapshot is too large",
            ));
        }
        let snapshot = String::from_utf8(bytes).map_err(|_| {
            NativeError::new(
                "snapshot_invalid_encoding",
                "The Omnia app-state snapshot is not valid UTF-8",
            )
        })?;
        let revision = validate_snapshot(&snapshot)?;
        Ok(SnapshotLoad::Loaded {
            snapshot,
            revision,
            receipt_id: self.receipt("load"),
        })
    }

    pub fn save(
        &self,
        snapshot: &str,
        expected_revision: Option<i64>,
    ) -> NativeResult<SnapshotSave> {
        let _guard = self.operation_lock.lock().map_err(|_| {
            NativeError::new(
                "storage_lock_failed",
                "Omnia app-state storage is unavailable",
            )
        })?;
        let revision = validate_snapshot(snapshot)?;
        validate_optional_revision(expected_revision, "expected revision")?;

        let current = self.read_current_revision()?;
        if expected_revision.is_some() && expected_revision != current {
            return Ok(SnapshotSave::Conflict {
                current_revision: current,
                expected_revision,
                receipt_id: self.receipt("conflict"),
            });
        }

        let parent = self.path.parent().ok_or_else(|| {
            NativeError::new(
                "storage_path_invalid",
                "Omnia app-state storage path is invalid",
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| NativeError::io("Could not prepare Omnia app-state storage", error))?;

        // Write beside the final file and then replace it.  The in-process
        // lock prevents concurrent writers from racing this small replace
        // sequence; a reader therefore observes either the old or new JSON.
        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            SNAPSHOT_FILE_NAME,
            Uuid::new_v4().simple()
        ));
        fs::write(&temporary, snapshot).map_err(|error| {
            NativeError::io("Could not write the Omnia app-state snapshot", error)
        })?;
        if let Err(error) = fs::rename(&temporary, &self.path) {
            // Windows does not replace an existing file with rename.  Remove
            // only the exact scoped snapshot target, then retry the rename.
            if self.path.exists() {
                fs::remove_file(&self.path).map_err(|remove_error| {
                    let _ = fs::remove_file(&temporary);
                    NativeError::io(
                        "Could not replace the Omnia app-state snapshot",
                        remove_error,
                    )
                })?;
                fs::rename(&temporary, &self.path).map_err(|rename_error| {
                    let _ = fs::remove_file(&temporary);
                    NativeError::io(
                        "Could not commit the Omnia app-state snapshot",
                        rename_error,
                    )
                })?;
            } else {
                let _ = fs::remove_file(&temporary);
                return Err(NativeError::io(
                    "Could not commit the Omnia app-state snapshot",
                    error,
                ));
            }
        }

        Ok(SnapshotSave::Saved {
            revision,
            receipt_id: self.receipt("save"),
        })
    }

    /// Validate and detach a transfer payload for an export operation.
    ///
    /// Native intentionally does not merge the bundle into SQLite or the
    /// renderer snapshot here.  Import/export authority remains with the
    /// caller's domain adapter; this command is the bounded native transport
    /// boundary only.
    pub fn export_transfer(&self, bundle: &str) -> NativeResult<TransferBundle> {
        Ok(TransferBundle {
            bundle: normalize_transfer(bundle)?,
            receipt_id: self.receipt("transfer-export"),
        })
    }

    /// Validate and detach a transfer payload for an import operation.
    ///
    /// The caller receives the validated envelope and may then apply its
    /// domain-specific merge policy.  No durable state is changed by this
    /// transport-level command.
    pub fn import_transfer(&self, bundle: &str) -> NativeResult<TransferBundle> {
        Ok(TransferBundle {
            bundle: normalize_transfer(bundle)?,
            receipt_id: self.receipt("transfer-import"),
        })
    }

    fn read_current_revision(&self) -> NativeResult<Option<i64>> {
        if !self.path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&self.path).map_err(|error| {
            NativeError::io("Could not read the Omnia app-state snapshot", error)
        })?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err(NativeError::new(
                "snapshot_too_large",
                "The Omnia app-state snapshot is too large",
            ));
        }
        let snapshot = String::from_utf8(bytes).map_err(|_| {
            NativeError::new(
                "snapshot_invalid_encoding",
                "The Omnia app-state snapshot is not valid UTF-8",
            )
        })?;
        Ok(Some(validate_snapshot(&snapshot)?))
    }

    fn receipt(&self, operation: &str) -> String {
        let value = format!("native:{operation}:{}", Uuid::new_v4().simple());
        debug_assert!(value.len() <= MAX_RECEIPT_ID_BYTES);
        value
    }
}

fn validate_optional_revision(value: Option<i64>, label: &'static str) -> NativeResult<()> {
    if let Some(value) = value {
        if value < 1 {
            return Err(NativeError::invalid(label, "must be a positive integer"));
        }
    }
    Ok(())
}

fn validate_snapshot(snapshot: &str) -> NativeResult<i64> {
    if snapshot.len() > MAX_SNAPSHOT_BYTES {
        return Err(NativeError::new(
            "snapshot_too_large",
            "The Omnia app-state snapshot is too large",
        ));
    }
    let value: Value = serde_json::from_str(snapshot).map_err(|_| {
        NativeError::new(
            "snapshot_invalid_json",
            "The Omnia app-state snapshot is not valid JSON",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        NativeError::new(
            "snapshot_invalid_shape",
            "The Omnia app-state snapshot must be a JSON object",
        )
    })?;
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            NativeError::new(
                "snapshot_invalid_revision",
                "The Omnia app-state revision is invalid",
            )
        })?;
    if revision < 1 {
        return Err(NativeError::new(
            "snapshot_invalid_revision",
            "The Omnia app-state revision must be positive",
        ));
    }
    Ok(revision)
}

fn normalize_transfer(bundle: &str) -> NativeResult<String> {
    if bundle.len() > MAX_SNAPSHOT_BYTES {
        return Err(NativeError::new(
            "transfer_too_large",
            "The Omnia transfer bundle is too large",
        ));
    }
    let value: Value = serde_json::from_str(bundle).map_err(|_| {
        NativeError::new(
            "transfer_invalid_json",
            "The Omnia transfer bundle is not valid JSON",
        )
    })?;
    if !value.is_object() {
        return Err(NativeError::new(
            "transfer_invalid_shape",
            "The Omnia transfer bundle must be a JSON object",
        ));
    }
    serde_json::to_string(&value).map_err(|_| {
        NativeError::new(
            "transfer_serialization_failed",
            "The Omnia transfer bundle could not be serialized",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_store() -> AppStateSnapshotStore {
        let root = std::env::temp_dir().join(format!(
            "omnia-app-state-transfer-test-{}",
            Uuid::new_v4().simple()
        ));
        AppStateSnapshotStore::open(&root).expect("app-state store opens")
    }

    #[test]
    fn export_and_import_canonicalize_the_same_detached_bundle() {
        let store = temporary_store();
        let source = r#"{ "z": 2, "nested": { "enabled": true }, "a": 1 }"#;

        let exported = store.export_transfer(source).expect("transfer exports");
        let imported = store
            .import_transfer(&exported.bundle)
            .expect("canonical transfer imports");

        assert_eq!(
            exported.bundle,
            r#"{"a":1,"nested":{"enabled":true},"z":2}"#
        );
        assert_eq!(imported.bundle, exported.bundle);
        assert!(exported.receipt_id.starts_with("native:transfer-export:"));
        assert!(imported.receipt_id.starts_with("native:transfer-import:"));
    }

    #[test]
    fn transfer_operations_do_not_write_the_durable_snapshot() {
        let store = temporary_store();
        let bundle = r#"{"version":1,"payload":{}}"#;

        store.export_transfer(bundle).expect("transfer exports");
        store.import_transfer(bundle).expect("transfer imports");

        assert!(matches!(
            store.load(None).expect("snapshot load succeeds"),
            SnapshotLoad::Empty { .. }
        ));
    }

    #[test]
    fn transfer_validation_rejects_invalid_shape_and_json() {
        let store = temporary_store();

        let invalid_json = store.export_transfer("not-json").unwrap_err();
        assert_eq!(invalid_json.code, "transfer_invalid_json");

        let invalid_shape = store.export_transfer("[]").unwrap_err();
        assert_eq!(invalid_shape.code, "transfer_invalid_shape");
    }

    #[test]
    fn transfer_validation_rejects_payloads_over_the_native_bound() {
        let store = temporary_store();
        let oversized = format!("{{\"payload\":\"{}\"}}", "x".repeat(MAX_SNAPSHOT_BYTES));

        let error = store.import_transfer(&oversized).unwrap_err();
        assert_eq!(error.code, "transfer_too_large");
    }
}
