//! File-backed persistence seam for native-boundary receipts.
//!
//! This is deliberately test-gated while the native shell migration is being
//! evaluated. It proves that a boundary receipt can survive close/reopen and
//! that competing writers cannot silently overwrite a newer revision.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::fmt;

use super::native_boundary::{BoundaryEvaluation, BOUNDARY_ID, SCHEMA_VERSION};

#[derive(Debug)]
pub enum PersistenceError {
    Sqlite(rusqlite::Error),
    Conflict { expected: u64, actual: u64 },
    InvalidPayload(String),
}

impl fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "sqlite: {error}"),
            Self::Conflict { expected, actual } => {
                write!(f, "revision conflict: expected {expected}, actual {actual}")
            }
            Self::InvalidPayload(reason) => write!(f, "invalid payload: {reason}"),
        }
    }
}

impl std::error::Error for PersistenceError {}

impl From<rusqlite::Error> for PersistenceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedReceipt {
    pub boundary_id: String,
    pub revision: u64,
    pub source_revision: String,
    pub payload: Value,
}

pub fn initialize(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_boundary_receipts (
            boundary_id TEXT PRIMARY KEY NOT NULL,
            revision INTEGER NOT NULL,
            source_revision TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );",
    )?;
    Ok(())
}

fn validate_payload(boundary_id: &str, payload: &Value) -> Result<String, PersistenceError> {
    if boundary_id.trim().is_empty() {
        return Err(PersistenceError::InvalidPayload(
            "boundary id must not be empty".to_string(),
        ));
    }
    let object = payload.as_object().ok_or_else(|| {
        PersistenceError::InvalidPayload("receipt payload must be a JSON object".to_string())
    })?;
    let payload_boundary = object
        .get("boundary_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            PersistenceError::InvalidPayload("payload boundary_id is required".to_string())
        })?;
    if payload_boundary != boundary_id {
        return Err(PersistenceError::InvalidPayload(
            "payload boundary_id does not match key".to_string(),
        ));
    }
    if boundary_id != BOUNDARY_ID {
        return Err(PersistenceError::InvalidPayload(format!(
            "unsupported boundary id: {boundary_id}"
        )));
    }
    let schema_version = object
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            PersistenceError::InvalidPayload("payload schema_version is required".to_string())
        })?;
    if schema_version != u64::from(SCHEMA_VERSION) {
        return Err(PersistenceError::InvalidPayload(format!(
            "payload schema_version {schema_version} does not match {SCHEMA_VERSION}"
        )));
    }
    let evaluation = object
        .get("evaluation")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            PersistenceError::InvalidPayload("payload evaluation object is required".to_string())
        })?;
    let evaluation_boundary = evaluation
        .get("boundary_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            PersistenceError::InvalidPayload(
                "payload evaluation.boundary_id is required".to_string(),
            )
        })?;
    if evaluation_boundary != boundary_id {
        return Err(PersistenceError::InvalidPayload(
            "payload evaluation.boundary_id does not match key".to_string(),
        ));
    }
    let evaluation_schema = evaluation
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            PersistenceError::InvalidPayload(
                "payload evaluation.schema_version is required".to_string(),
            )
        })?;
    if evaluation_schema != u64::from(SCHEMA_VERSION) {
        return Err(PersistenceError::InvalidPayload(format!(
            "payload evaluation.schema_version {evaluation_schema} does not match {SCHEMA_VERSION}"
        )));
    }
    serde_json::from_value::<BoundaryEvaluation>(Value::Object(evaluation.clone())).map_err(
        |error| {
            PersistenceError::InvalidPayload(format!(
                "payload evaluation is not a typed boundary evaluation: {error}"
            ))
        },
    )?;
    let source_revision = object
        .get("source_revision")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            PersistenceError::InvalidPayload("payload source_revision is required".to_string())
        })?;
    if source_revision.len() > 256 || source_revision.chars().any(char::is_control) {
        return Err(PersistenceError::InvalidPayload(
            "payload source_revision is invalid".to_string(),
        ));
    }
    serde_json::to_string(payload)
        .map_err(|error| PersistenceError::InvalidPayload(error.to_string()))
}

pub fn read(
    connection: &Connection,
    boundary_id: &str,
) -> Result<Option<PersistedReceipt>, PersistenceError> {
    initialize(connection)?;
    let row = connection
        .query_row(
            "SELECT revision, source_revision, payload_json
             FROM native_boundary_receipts WHERE boundary_id = ?1",
            params![boundary_id],
            |row| {
                let revision: i64 = row.get(0)?;
                let source_revision: String = row.get(1)?;
                let payload_json: String = row.get(2)?;
                Ok((revision, source_revision, payload_json))
            },
        )
        .optional()?;
    row.map(|(revision, source_revision, payload_json)| {
        let revision = u64::try_from(revision).map_err(|_| {
            PersistenceError::InvalidPayload("stored revision is negative".to_string())
        })?;
        if revision == 0 {
            return Err(PersistenceError::InvalidPayload(
                "stored revision must be positive".to_string(),
            ));
        }
        let payload = serde_json::from_str(&payload_json).map_err(|error| {
            PersistenceError::InvalidPayload(format!("stored JSON is malformed: {error}"))
        })?;
        if source_revision.trim().is_empty() {
            return Err(PersistenceError::InvalidPayload(
                "stored source revision is empty".to_string(),
            ));
        }
        let _validated_payload_json = validate_payload(boundary_id, &payload)?;
        let payload_source_revision = payload.get("source_revision").and_then(Value::as_str);
        if payload_source_revision.is_some_and(|value| value != source_revision) {
            return Err(PersistenceError::InvalidPayload(
                "stored payload source_revision does not match row".to_string(),
            ));
        }
        Ok(PersistedReceipt {
            boundary_id: boundary_id.to_string(),
            revision,
            source_revision,
            payload,
        })
    })
    .transpose()
}

pub fn append(
    connection: &mut Connection,
    boundary_id: &str,
    source_revision: &str,
    expected_revision: u64,
    payload: &Value,
) -> Result<u64, PersistenceError> {
    if source_revision.trim().is_empty() {
        return Err(PersistenceError::InvalidPayload(
            "source revision must not be empty".to_string(),
        ));
    }
    let payload_json = validate_payload(boundary_id, payload)?;
    if payload.get("source_revision").and_then(Value::as_str) != Some(source_revision) {
        return Err(PersistenceError::InvalidPayload(
            "payload source_revision does not match row".to_string(),
        ));
    }
    initialize(connection)?;
    let transaction = connection.transaction()?;
    let actual = read(&transaction, boundary_id)?
        .map(|receipt| receipt.revision)
        .unwrap_or(0);
    if actual != expected_revision {
        return Err(PersistenceError::Conflict {
            expected: expected_revision,
            actual,
        });
    }
    let next = actual.saturating_add(1);
    let sqlite_revision = i64::try_from(next).map_err(|_| {
        PersistenceError::InvalidPayload("revision exceeds SQLite integer range".to_string())
    })?;
    transaction.execute(
        "INSERT INTO native_boundary_receipts
            (boundary_id, revision, source_revision, payload_json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(boundary_id) DO UPDATE SET
            revision = excluded.revision,
            source_revision = excluded.source_revision,
            payload_json = excluded.payload_json",
        params![boundary_id, sqlite_revision, source_revision, payload_json],
    )?;
    transaction.commit()?;
    Ok(next)
}

pub fn rollback(
    connection: &mut Connection,
    boundary_id: &str,
    source_revision: &str,
    expected_revision: u64,
    payload: &Value,
) -> Result<u64, PersistenceError> {
    append(
        connection,
        boundary_id,
        source_revision,
        expected_revision,
        payload,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn payload(boundary_id: &str, state: &str) -> Value {
        serde_json::json!({
            "boundary_id": boundary_id,
            "schema_version": 1,
            "source_revision": "source-a",
            "state": state,
            "passed": false,
            "evaluation": {
                "boundary_id": boundary_id,
                "schema_version": SCHEMA_VERSION,
                "state": "Candidate",
                "passed": false,
                "failures": ["MissingBaseline"],
                "unsupported_capabilities": [],
                "rollback_required": true
            }
        })
    }

    fn temp_path() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("omnia-native-boundary-{stamp}.sqlite"))
    }

    #[test]
    fn receipt_survives_close_and_reopen_with_read_after() {
        let path = temp_path();
        {
            let mut connection = Connection::open(&path).unwrap();
            let revision = append(
                &mut connection,
                "NATIVE-RUST-BOUNDARY-001",
                "source-a",
                0,
                &payload("NATIVE-RUST-BOUNDARY-001", "candidate"),
            )
            .unwrap();
            assert_eq!(revision, 1);
            assert_eq!(
                read(&connection, "NATIVE-RUST-BOUNDARY-001")
                    .unwrap()
                    .unwrap()
                    .revision,
                1
            );
        }
        let connection = Connection::open(&path).unwrap();
        let receipt = read(&connection, "NATIVE-RUST-BOUNDARY-001")
            .unwrap()
            .unwrap();
        assert_eq!(receipt.source_revision, "source-a");
        assert_eq!(receipt.payload["state"], "candidate");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_writer_is_rejected_without_mutating_receipt() {
        let mut connection = Connection::open_in_memory().unwrap();
        append(
            &mut connection,
            "NATIVE-RUST-BOUNDARY-001",
            "source-a",
            0,
            &payload("NATIVE-RUST-BOUNDARY-001", "candidate"),
        )
        .unwrap();
        let mut stale_payload = payload("NATIVE-RUST-BOUNDARY-001", "rolled-back");
        stale_payload["source_revision"] = serde_json::json!("source-b");
        let error = append(
            &mut connection,
            "NATIVE-RUST-BOUNDARY-001",
            "source-b",
            0,
            &stale_payload,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            PersistenceError::Conflict {
                expected: 0,
                actual: 1
            }
        ));
        assert_eq!(
            read(&connection, "NATIVE-RUST-BOUNDARY-001")
                .unwrap()
                .unwrap()
                .source_revision,
            "source-a"
        );
    }

    #[test]
    fn rollback_is_a_new_revision_and_reads_back() {
        let mut connection = Connection::open_in_memory().unwrap();
        let first = append(
            &mut connection,
            "NATIVE-RUST-BOUNDARY-001",
            "source-a",
            0,
            &payload("NATIVE-RUST-BOUNDARY-001", "candidate"),
        )
        .unwrap();
        let second = rollback(
            &mut connection,
            "NATIVE-RUST-BOUNDARY-001",
            "source-a",
            first,
            &payload("NATIVE-RUST-BOUNDARY-001", "rolled-back"),
        )
        .unwrap();
        assert_eq!(second, 2);
        let receipt = read(&connection, "NATIVE-RUST-BOUNDARY-001")
            .unwrap()
            .unwrap();
        assert_eq!(receipt.revision, 2);
        assert_eq!(receipt.payload["state"], "rolled-back");
    }

    #[test]
    fn invalid_identity_or_evaluation_is_rejected_without_writes() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        let valid = payload(BOUNDARY_ID, "candidate");
        let mut invalid = Vec::new();
        for (pointer, replacement) in [
            ("/boundary_id", serde_json::json!("OTHER")),
            ("/schema_version", serde_json::json!(2)),
            ("/source_revision", serde_json::json!(" ")),
            ("/source_revision", serde_json::json!(null)),
            ("/evaluation/boundary_id", serde_json::json!("OTHER")),
            ("/evaluation/schema_version", serde_json::json!(0)),
            ("/evaluation/state", serde_json::json!("fabricated")),
            ("/evaluation/passed", serde_json::json!("false")),
            ("/evaluation/failures", serde_json::json!(["unknown"])),
        ] {
            let mut value = valid.clone();
            *value.pointer_mut(pointer).unwrap() = replacement;
            invalid.push(value);
        }
        invalid.push(serde_json::json!([]));
        for value in invalid {
            assert!(matches!(
                append(&mut connection, BOUNDARY_ID, "source-a", 0, &value),
                Err(PersistenceError::InvalidPayload(_))
            ));
            assert!(read(&connection, BOUNDARY_ID).unwrap().is_none());
        }
        assert!(append(&mut connection, BOUNDARY_ID, "", 0, &valid).is_err());
        assert!(append(&mut connection, BOUNDARY_ID, "source-b", 0, &valid).is_err());
    }

    #[test]
    fn malformed_stored_rows_fail_closed_after_reopen() {
        let path = temp_path();
        {
            let mut connection = Connection::open(&path).unwrap();
            append(
                &mut connection,
                BOUNDARY_ID,
                "source-a",
                0,
                &payload(BOUNDARY_ID, "candidate"),
            )
            .unwrap();
        }
        {
            let mut connection = Connection::open(&path).unwrap();
            let valid = serde_json::to_string(&payload(BOUNDARY_ID, "candidate")).unwrap();
            let wrong_identity = valid.replace(BOUNDARY_ID, "OTHER");
            for (revision, source, json) in [
                (0, "source-a", valid.as_str()),
                (-1, "source-a", valid.as_str()),
                (1, "", valid.as_str()),
                (1, "source-b", valid.as_str()),
                (1, "source-a", "{broken"),
                (1, "source-a", wrong_identity.as_str()),
            ] {
                connection
                    .execute(
                        "UPDATE native_boundary_receipts SET revision=?1,
                         source_revision=?2, payload_json=?3 WHERE boundary_id=?4",
                        params![revision, source, json, BOUNDARY_ID],
                    )
                    .unwrap();
                assert!(matches!(
                    read(&connection, BOUNDARY_ID),
                    Err(PersistenceError::InvalidPayload(_))
                ));
                assert!(matches!(
                    append(
                        &mut connection,
                        BOUNDARY_ID,
                        "source-a",
                        1,
                        &payload(BOUNDARY_ID, "replacement")
                    ),
                    Err(PersistenceError::InvalidPayload(_))
                ));
                let stored: String = connection
                    .query_row(
                        "SELECT payload_json FROM native_boundary_receipts WHERE boundary_id=?1",
                        params![BOUNDARY_ID],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(stored, json);
            }
        }
        std::fs::remove_file(path).unwrap();
    }
}
