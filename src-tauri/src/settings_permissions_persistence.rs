//! Native persistence boundary for the renderer settings/permission snapshot.
//!
//! Settings and permission policy are intentionally stored in a separate,
//! bounded JSON document.  The renderer owns the strict schema and policy
//! semantics; this native layer owns only durable bytes, atomic replacement,
//! and compare-and-swap on the top-level revision.  Keeping this file apart
//! from the conversation database also means a malformed settings document
//! cannot make the primary workspace database unavailable.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde_json::Value;
use uuid::Uuid;

use crate::error::{NativeError, NativeResult};

const SNAPSHOT_FILE_NAME: &str = "omnia-settings-permissions.json";
const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct SettingsPermissionsSnapshotStore {
    path: PathBuf,
    operation_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsPermissionsLoad {
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
pub enum SettingsPermissionsSave {
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

impl SettingsPermissionsSnapshotStore {
    pub fn open(app_data_dir: &Path) -> NativeResult<Self> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| NativeError::io("Could not prepare Omnia settings storage", error))?;
        Ok(Self {
            path: app_data_dir.join(SNAPSHOT_FILE_NAME),
            operation_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn load(&self, minimum_revision: Option<i64>) -> NativeResult<SettingsPermissionsLoad> {
        let _guard = self.operation_lock.lock().map_err(|_| {
            NativeError::new(
                "storage_lock_failed",
                "Omnia settings storage is unavailable",
            )
        })?;
        validate_optional_revision(minimum_revision, "minimum revision")?;
        if !self.path.exists() {
            return Ok(SettingsPermissionsLoad::Empty {
                receipt_id: self.receipt("load"),
            });
        }

        let snapshot = read_snapshot(&self.path)?;
        let revision = validate_snapshot(&snapshot)?;
        if minimum_revision.is_some_and(|minimum| revision < minimum) {
            // Return the stored value.  The renderer adapter turns this into a
            // typed revision-conflict and can decide whether to refresh.
        }
        Ok(SettingsPermissionsLoad::Loaded {
            snapshot,
            revision,
            receipt_id: self.receipt("load"),
        })
    }

    pub fn save(
        &self,
        snapshot: &str,
        expected_revision: Option<i64>,
    ) -> NativeResult<SettingsPermissionsSave> {
        let _guard = self.operation_lock.lock().map_err(|_| {
            NativeError::new(
                "storage_lock_failed",
                "Omnia settings storage is unavailable",
            )
        })?;
        let revision = validate_snapshot(snapshot)?;
        validate_optional_revision(expected_revision, "expected revision")?;

        let current = self.read_current_revision()?;
        if expected_revision.is_some() && expected_revision != current {
            return Ok(SettingsPermissionsSave::Conflict {
                current_revision: current,
                expected_revision,
                receipt_id: self.receipt("conflict"),
            });
        }

        let parent = self.path.parent().ok_or_else(|| {
            NativeError::new(
                "storage_path_invalid",
                "Omnia settings storage path is invalid",
            )
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| NativeError::io("Could not prepare Omnia settings storage", error))?;

        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            SNAPSHOT_FILE_NAME,
            Uuid::new_v4().simple()
        ));
        fs::write(&temporary, snapshot).map_err(|error| {
            NativeError::io("Could not write the Omnia settings snapshot", error)
        })?;
        if let Err(error) = fs::rename(&temporary, &self.path) {
            // Windows cannot replace an existing file with rename.  Remove
            // only the exact scoped target, then retry the atomic replacement.
            if self.path.exists() {
                fs::remove_file(&self.path).map_err(|remove_error| {
                    let _ = fs::remove_file(&temporary);
                    NativeError::io(
                        "Could not replace the Omnia settings snapshot",
                        remove_error,
                    )
                })?;
                fs::rename(&temporary, &self.path).map_err(|rename_error| {
                    let _ = fs::remove_file(&temporary);
                    NativeError::io("Could not commit the Omnia settings snapshot", rename_error)
                })?;
            } else {
                let _ = fs::remove_file(&temporary);
                return Err(NativeError::io(
                    "Could not commit the Omnia settings snapshot",
                    error,
                ));
            }
        }

        Ok(SettingsPermissionsSave::Saved {
            revision,
            receipt_id: self.receipt("save"),
        })
    }

    fn read_current_revision(&self) -> NativeResult<Option<i64>> {
        if !self.path.exists() {
            return Ok(None);
        }
        Ok(Some(validate_snapshot(&read_snapshot(&self.path)?)?))
    }

    fn receipt(&self, operation: &str) -> String {
        format!("native:settings:{operation}:{}", Uuid::new_v4().simple())
    }
}

fn read_snapshot(path: &Path) -> NativeResult<String> {
    let bytes = fs::read(path)
        .map_err(|error| NativeError::io("Could not read the Omnia settings snapshot", error))?;
    if bytes.len() > MAX_SNAPSHOT_BYTES {
        return Err(NativeError::new(
            "settings_snapshot_too_large",
            "The Omnia settings snapshot is too large",
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        NativeError::new(
            "settings_snapshot_invalid_encoding",
            "The Omnia settings snapshot is not valid UTF-8",
        )
    })
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
            "settings_snapshot_too_large",
            "The Omnia settings snapshot is too large",
        ));
    }
    let value: Value = serde_json::from_str(snapshot).map_err(|_| {
        NativeError::new(
            "settings_snapshot_invalid_json",
            "The Omnia settings snapshot is not valid JSON",
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        NativeError::new(
            "settings_snapshot_invalid_shape",
            "The Omnia settings snapshot must be a JSON object",
        )
    })?;
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            NativeError::new(
                "settings_snapshot_invalid_revision",
                "The Omnia settings snapshot revision is invalid",
            )
        })?;
    if revision < 1 {
        return Err(NativeError::new(
            "settings_snapshot_invalid_revision",
            "The Omnia settings snapshot revision must be positive",
        ));
    }
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(revision: i64) -> String {
        format!(r#"{{"version":1,"revision":{revision}}}"#)
    }

    #[test]
    fn validates_revision_and_round_trips_atomically() {
        let root = tempfile_dir();
        let store = SettingsPermissionsSnapshotStore::open(&root).expect("store opens");
        assert!(matches!(
            store.load(None).unwrap(),
            SettingsPermissionsLoad::Empty { .. }
        ));
        assert!(matches!(
            store.save(&snapshot(1), None).unwrap(),
            SettingsPermissionsSave::Saved { revision: 1, .. }
        ));
        assert!(matches!(
            store.load(Some(1)).unwrap(),
            SettingsPermissionsLoad::Loaded { revision: 1, .. }
        ));
        assert!(matches!(
            store.save(&snapshot(2), Some(1)).unwrap(),
            SettingsPermissionsSave::Saved { revision: 2, .. }
        ));
    }

    #[test]
    fn rejects_stale_revision_and_malformed_payloads() {
        let root = tempfile_dir();
        let store = SettingsPermissionsSnapshotStore::open(&root).expect("store opens");
        assert!(store.save(&snapshot(1), None).is_ok());
        assert!(matches!(
            store.save(&snapshot(2), Some(7)).unwrap(),
            SettingsPermissionsSave::Conflict { .. }
        ));
        assert!(store.save("[]", None).is_err());
        assert!(store.save(r#"{"revision":0}"#, None).is_err());
    }

    fn tempfile_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("omnia-settings-test-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&path).expect("temp dir creates");
        path
    }
}
