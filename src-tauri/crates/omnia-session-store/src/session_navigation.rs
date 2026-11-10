//! Metadata-only session navigation, independent from transcripts and app state.
//! Writes use an exact revision so concurrent windows cannot silently replace
//! another window's ordered tab list. Missing/deleted sessions are pruned on
//! load, while saves reject them to avoid reviving stale session references.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{
    error::{NativeError, NativeResult},
    harness_store::{AgentSessionSummary, HarnessStore},
};

const MAX_OPEN_SESSIONS: usize = 256;
const MAX_SAFE_NAVIGATION_REVISION: i64 = (1_i64 << 53) - 1;

/// Keyset position in `(updated_at_ms DESC, id ASC)` order. It is a position,
/// not a reference requiring the original row to remain present.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionPageCursor {
    pub updated_at_ms: i64,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionPageRequest {
    pub limit: u32,
    pub cursor: Option<AgentSessionPageCursor>,
}

/// One transaction-consistent page, navigation receipt and active summary.
/// Active may be outside `rows`; it never increases the page row count.
/// Concurrent edits between separate page requests may move rows across their
/// keyset positions. This API does not promise a frozen multi-request export.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionPage {
    pub rows: Vec<AgentSessionSummary>,
    pub active: Option<AgentSessionSummary>,
    pub navigation: AgentSessionNavigationLoad,
    pub next_cursor: Option<AgentSessionPageCursor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionNavigationSnapshot {
    pub schema_version: u32,
    pub revision: i64,
    pub open_ids: Vec<String>,
    pub active_id: Option<String>,
    pub updated_at_ms: i64,
}

impl Default for AgentSessionNavigationSnapshot {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            open_ids: Vec::new(),
            active_id: None,
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAgentSessionNavigationRequest {
    pub expected_revision: i64,
    pub open_ids: Vec<String>,
    pub active_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionNavigationLoad {
    pub snapshot: AgentSessionNavigationSnapshot,
    pub receipt_id: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AgentSessionNavigationSave {
    Saved {
        snapshot: AgentSessionNavigationSnapshot,
        #[serde(rename = "receiptId")]
        receipt_id: String,
    },
    Conflict {
        snapshot: AgentSessionNavigationSnapshot,
        #[serde(rename = "receiptId")]
        receipt_id: String,
    },
}

fn new_receipt_id() -> String {
    format!("session_navigation_{}", uuid::Uuid::new_v4().simple())
}

/// Return the immutable receipt for the current projection.  Revision zero is
/// the empty state and has a stable synthetic identity because no mutation has
/// been committed yet.  Receipts for revisions written by older builds are
/// created by the HarnessStore schema bootstrap migration.
fn current_receipt_id(connection: &Connection, revision: i64) -> NativeResult<String> {
    if revision == 0 {
        return Ok("session_navigation_empty".to_owned());
    }
    connection
        .query_row(
            "SELECT receipt_id FROM agent_session_navigation_receipts WHERE revision = ?1",
            [revision],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            NativeError::new(
                "session_navigation_receipt_missing",
                "The durable navigation receipt is missing for the current revision",
            )
        })
}

fn validate_navigation(open_ids: &[String], active_id: Option<&str>) -> NativeResult<()> {
    if open_ids.len() > MAX_OPEN_SESSIONS {
        return Err(NativeError::invalid(
            "openIds",
            "contains more than 256 sessions",
        ));
    }
    let mut unique = HashSet::new();
    for id in open_ids {
        if id.trim() != id || id.is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
            return Err(NativeError::invalid(
                "openIds",
                "contains an invalid session ID",
            ));
        }
        if !unique.insert(id.as_str()) {
            return Err(NativeError::invalid(
                "openIds",
                "contains a duplicate session ID",
            ));
        }
    }
    if active_id.is_some_and(|id| !unique.contains(id)) {
        return Err(NativeError::invalid(
            "activeId",
            "must reference an open session",
        ));
    }
    Ok(())
}

fn read_snapshot(connection: &Connection) -> NativeResult<AgentSessionNavigationSnapshot> {
    let row: Option<(i64, String)> = connection
        .query_row(
            "SELECT revision, snapshot_json FROM agent_session_navigation WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((revision, raw)) = row else {
        return Ok(AgentSessionNavigationSnapshot::default());
    };
    if raw.len() > 128 * 1024 {
        return Err(NativeError::new(
            "session_navigation_invalid",
            "The stored navigation snapshot exceeds its safety limit",
        ));
    }
    let mut snapshot: AgentSessionNavigationSnapshot =
        serde_json::from_str(&raw).map_err(|_| {
            NativeError::new(
                "session_navigation_invalid",
                "The stored navigation snapshot is invalid",
            )
        })?;
    if snapshot.schema_version != 1
        || revision <= 0
        || revision > MAX_SAFE_NAVIGATION_REVISION
        || snapshot.revision != revision
        || snapshot.updated_at_ms <= 0
    {
        return Err(NativeError::new(
            "session_navigation_invalid",
            "The stored navigation snapshot has invalid revision metadata",
        ));
    }
    validate_navigation(&snapshot.open_ids, snapshot.active_id.as_deref())?;
    let mut exists =
        connection.prepare("SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?1)")?;
    let mut retained = Vec::new();
    for id in snapshot.open_ids {
        if exists.query_row([&id], |row| row.get::<_, bool>(0))? {
            retained.push(id);
        }
    }
    snapshot.open_ids = retained;
    if snapshot
        .active_id
        .as_ref()
        .is_some_and(|id| !snapshot.open_ids.contains(id))
    {
        snapshot.active_id = None;
    }
    Ok(snapshot)
}

fn validate_page_request(request: &AgentSessionPageRequest) -> NativeResult<()> {
    if !(1..=100).contains(&request.limit) {
        return Err(NativeError::invalid("limit", "must be between 1 and 100"));
    }
    if let Some(cursor) = &request.cursor {
        if cursor.id.is_empty()
            || cursor.id.len() > 200
            || cursor.id.trim() != cursor.id
            || cursor.id.chars().any(char::is_control)
        {
            return Err(NativeError::invalid(
                "cursor",
                "contains an invalid session ID",
            ));
        }
    }
    Ok(())
}

const MAX_PAGE_SUMMARY_BYTES: usize = 256 * 1024;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const PAGE_AFTER_SQL: &str = "SELECT id, updated_at_ms, summary_json FROM agent_sessions
    WHERE updated_at_ms = ?1 AND id > ?2
    UNION ALL
    SELECT id, updated_at_ms, summary_json FROM agent_sessions
    WHERE updated_at_ms < ?1
    ORDER BY updated_at_ms DESC, id ASC LIMIT ?3";
const PAGE_FIRST_SQL: &str = "SELECT id, updated_at_ms, summary_json FROM agent_sessions
    ORDER BY updated_at_ms DESC, id ASC LIMIT ?1";

fn page_summary(
    id: String,
    updated: i64,
    raw: &str,
    bytes: &mut usize,
) -> NativeResult<AgentSessionSummary> {
    *bytes = bytes.saturating_add(raw.len());
    if raw.len() > MAX_PAGE_SUMMARY_BYTES || *bytes > MAX_PAGE_BYTES {
        return Err(NativeError::new(
            "session_page_too_large",
            "Session metadata exceeds the native page byte budget",
        ));
    }
    let summary: AgentSessionSummary = serde_json::from_str(raw).map_err(|_| {
        NativeError::new(
            "session_page_invalid",
            "A stored session summary is invalid",
        )
    })?;
    if summary.id != id || summary.updated_at_ms != updated {
        return Err(NativeError::new(
            "session_page_invalid",
            "A stored session summary differs from its ordering identity",
        ));
    }
    Ok(summary)
}

/// Caller owns a read transaction, so navigation pruning, receipt identity,
/// page rows and off-page active summary observe one SQLite snapshot.
fn read_session_page(
    connection: &Connection,
    request: AgentSessionPageRequest,
) -> NativeResult<AgentSessionPage> {
    let snapshot = read_snapshot(connection)?;
    let navigation = AgentSessionNavigationLoad {
        receipt_id: current_receipt_id(connection, snapshot.revision)?,
        snapshot,
    };
    let (sql, values): (&str, Vec<rusqlite::types::Value>) = match &request.cursor {
        Some(cursor) => (
            PAGE_AFTER_SQL,
            vec![
                cursor.updated_at_ms.into(),
                cursor.id.clone().into(),
                (i64::from(request.limit) + 1).into(),
            ],
        ),
        None => (PAGE_FIRST_SQL, vec![(i64::from(request.limit) + 1).into()]),
    };
    let mut statement = connection.prepare(sql)?;
    let mut query = statement.query(rusqlite::params_from_iter(values))?;
    let mut rows = Vec::with_capacity(request.limit as usize + 1);
    let mut bytes = 0;
    while let Some(row) = query.next()? {
        // Borrow SQLite text before allocating/decoding its JSON. Oversized
        // records fail explicitly; they are never silently truncated.
        let raw = row.get_ref(2)?;
        let raw = raw.as_str().map_err(|_| {
            NativeError::new("session_page_invalid", "Session metadata is not UTF-8 text")
        })?;
        rows.push(page_summary(row.get(0)?, row.get(1)?, raw, &mut bytes)?);
    }
    let next_cursor = if rows.len() > request.limit as usize {
        rows.pop();
        rows.last().map(|last| AgentSessionPageCursor {
            updated_at_ms: last.updated_at_ms,
            id: last.id.clone(),
        })
    } else {
        None
    };
    let active = navigation
        .snapshot
        .active_id
        .as_deref()
        .map(|id| {
            let mut statement = connection.prepare(
                "SELECT id, updated_at_ms, summary_json FROM agent_sessions WHERE id = ?1",
            )?;
            let mut query = statement.query([id])?;
            let row = query.next()?.ok_or_else(|| {
                NativeError::new(
                    "session_page_invalid",
                    "Active session disappeared from the read snapshot",
                )
            })?;
            let raw = row.get_ref(2)?;
            let raw = raw.as_str().map_err(|_| {
                NativeError::new("session_page_invalid", "Session metadata is not UTF-8 text")
            })?;
            page_summary(row.get(0)?, row.get(1)?, raw, &mut bytes)
        })
        .transpose()?;
    Ok(AgentSessionPage {
        rows,
        active,
        navigation,
        next_cursor,
    })
}

impl HarnessStore {
    pub fn session_page(&self, request: AgentSessionPageRequest) -> NativeResult<AgentSessionPage> {
        // Reject malformed requests without waiting for the connection mutex.
        validate_page_request(&request)?;
        let mut connection = self.lock()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let page = read_session_page(&tx, request)?;
        tx.commit()?;
        Ok(page)
    }

    pub fn load_session_navigation(&self) -> NativeResult<AgentSessionNavigationLoad> {
        let connection = self.lock()?;
        let snapshot = read_snapshot(&connection)?;
        Ok(AgentSessionNavigationLoad {
            receipt_id: current_receipt_id(&connection, snapshot.revision)?,
            snapshot,
        })
    }

    pub fn save_session_navigation(
        &self,
        request: SaveAgentSessionNavigationRequest,
    ) -> NativeResult<AgentSessionNavigationSave> {
        if request.expected_revision < 0 {
            return Err(NativeError::invalid(
                "expectedRevision",
                "must be a non-negative revision",
            ));
        }
        validate_navigation(&request.open_ids, request.active_id.as_deref())?;
        let mut connection = self.lock()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_snapshot(&tx)?;
        if current.revision != request.expected_revision {
            let revision = current.revision;
            return Ok(AgentSessionNavigationSave::Conflict {
                snapshot: current,
                receipt_id: current_receipt_id(&tx, revision)?,
            });
        }
        for id in &request.open_ids {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(NativeError::new(
                    "agent_session_not_found",
                    "Navigation contains a session that no longer exists",
                ));
            }
        }
        let revision = current
            .revision
            .checked_add(1)
            .filter(|value| *value <= MAX_SAFE_NAVIGATION_REVISION)
            .ok_or_else(|| {
                NativeError::new(
                    "session_navigation_revision_exhausted",
                    "The navigation revision cannot advance",
                )
            })?;
        let snapshot = AgentSessionNavigationSnapshot {
            schema_version: 1,
            revision,
            open_ids: request.open_ids,
            active_id: request.active_id,
            updated_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        let raw = serde_json::to_string(&snapshot).map_err(|_| {
            NativeError::new(
                "session_navigation_invalid",
                "Navigation could not be serialized",
            )
        })?;
        let receipt_id = new_receipt_id();
        tx.execute(
            "INSERT INTO agent_session_navigation_receipts
                (receipt_id, revision, snapshot_json) VALUES (?1, ?2, ?3)",
            params![receipt_id, revision, raw],
        )?;
        tx.execute(
            "INSERT INTO agent_session_navigation (singleton, revision, snapshot_json) VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json",
            params![revision, raw],
        )?;
        tx.commit()?;
        Ok(AgentSessionNavigationSave::Saved {
            snapshot,
            receipt_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness_store::{AgentSessionSummary, SessionScope};
    use omnia_harness::permission::PermissionMode;

    fn seed(store: &HarnessStore, id: &str) {
        store
            .save_summary(&AgentSessionSummary {
                id: id.to_owned(),
                title: id.to_owned(),
                scope: SessionScope::Project,
                cwd: "D:/project".to_owned(),
                profile_id: "p".to_owned(),
                model: "m".to_owned(),
                permission_mode: PermissionMode::default(),
                rules: vec![],
                reasoning_effort: None,
                fallback_models: vec![],
                token_budget: None,
                tokens_used: 0,
                system_prompt: None,
                parent_id: None,
                settings_revision: 1,
                message_count: 0,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();
    }

    fn request(
        revision: i64,
        ids: &[&str],
        active: Option<&str>,
    ) -> SaveAgentSessionNavigationRequest {
        SaveAgentSessionNavigationRequest {
            expected_revision: revision,
            open_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            active_id: active.map(str::to_owned),
        }
    }

    fn page(limit: u32, cursor: Option<AgentSessionPageCursor>) -> AgentSessionPageRequest {
        AgentSessionPageRequest { limit, cursor }
    }

    #[test]
    fn page_byte_budgets_fail_explicitly_without_mutation() {
        let store = HarnessStore::in_memory().unwrap();
        seed(&store, "large");
        let mut summary = store.summary("large").unwrap();
        summary.title = "x".repeat(MAX_PAGE_SUMMARY_BYTES);
        store.save_summary(&summary).unwrap();
        assert_eq!(
            store.session_page(page(1, None)).unwrap_err().code,
            "session_page_too_large"
        );
        assert_eq!(
            store.summary("large").unwrap().title.len(),
            MAX_PAGE_SUMMARY_BYTES
        );
        summary.title = "x".repeat(200 * 1024);
        for index in 0..11 {
            summary.id = format!("large-{index:02}");
            store.save_summary(&summary).unwrap();
        }
        store.delete("large").unwrap();
        assert_eq!(
            store.session_page(page(10, None)).unwrap_err().code,
            "session_page_too_large"
        );
        assert_eq!(store.session_page(page(5, None)).unwrap().rows.len(), 5);
    }

    #[test]
    fn deep_tied_timestamp_cursor_seeks_without_prefix_scan() {
        let store = HarnessStore::in_memory().unwrap();
        let mut connection = store.lock().unwrap();
        let tx = connection.transaction().unwrap();
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO agent_sessions(id,summary_json,updated_at_ms) VALUES(?1,'{}',100)",
                )
                .unwrap();
            for index in 0..100_000 {
                insert.execute([format!("tied-{index:06}")]).unwrap();
            }
        }
        tx.commit().unwrap();
        let mut steps = Vec::new();
        for cursor in ["tied-000000", "tied-099900"] {
            let mut statement = connection.prepare(PAGE_AFTER_SQL).unwrap();
            let rows: Vec<String> = statement
                .query_map(params![100, cursor, 51], |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(rows.len(), 51);
            let count = statement.get_status(rusqlite::StatementStatus::VmStep);
            assert!(count < 5000, "cursor {cursor}: {count} VM steps");
            steps.push(count);
        }
        println!("100000 tied timestamps; first/deep cursor VM steps={steps:?}");
        assert!(steps[1] <= steps[0] * 2 + 100);
    }

    #[test]
    fn keyset_query_uses_matching_index_without_sort_temp_tree() {
        let store = HarnessStore::in_memory().unwrap();
        let connection = store.lock().unwrap();
        for sql in [
            "EXPLAIN QUERY PLAN SELECT id, updated_at_ms, summary_json FROM agent_sessions ORDER BY updated_at_ms DESC,id ASC LIMIT 51",
            "EXPLAIN QUERY PLAN SELECT id, updated_at_ms, summary_json FROM agent_sessions WHERE updated_at_ms=100 AND id>'cursor' UNION ALL SELECT id, updated_at_ms, summary_json FROM agent_sessions WHERE updated_at_ms<100 ORDER BY updated_at_ms DESC,id ASC LIMIT 51",
        ] {
            let plan: Vec<String> = connection.prepare(sql).unwrap().query_map([], |row| row.get(3)).unwrap().map(Result::unwrap).collect();
            assert!(plan.iter().any(|line| line.contains("agent_sessions_page_order")), "{plan:?}");
            assert!(!plan.iter().any(|line| line.contains("TEMP B-TREE")), "{plan:?}");
        }
    }

    #[test]
    fn session_pages_bound_rows_and_order_tied_timestamps_without_gaps() {
        let store = HarnessStore::in_memory().unwrap();
        for id in ["d", "a", "c", "b", "old"] {
            seed(&store, id);
        }
        let mut old = store.summary("old").unwrap();
        old.updated_at_ms = 0;
        store.save_summary(&old).unwrap();
        store
            .save_session_navigation(request(0, &["old"], Some("old")))
            .unwrap();
        let mut cursor = None;
        let mut ids = Vec::new();
        loop {
            let loaded = store.session_page(page(2, cursor)).unwrap();
            assert!(loaded.rows.len() <= 2);
            assert_eq!(loaded.active.as_ref().unwrap().id, "old");
            assert_eq!(loaded.navigation.snapshot.revision, 1);
            ids.extend(loaded.rows.iter().map(|row| row.id.clone()));
            cursor = loaded.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids, ["a", "b", "c", "d", "old"]);
        let empty = store
            .session_page(page(
                1,
                Some(AgentSessionPageCursor {
                    updated_at_ms: i64::MIN,
                    id: "absent".into(),
                }),
            ))
            .unwrap();
        assert!(empty.rows.is_empty());
        assert!(empty.next_cursor.is_none());
        assert_eq!(empty.active.unwrap().id, "old");
        // Boundary timestamp values require no offset arithmetic.
        let mut newest = store.summary("d").unwrap();
        newest.updated_at_ms = i64::MAX;
        store.save_summary(&newest).unwrap();
        assert_eq!(store.session_page(page(1, None)).unwrap().rows[0].id, "d");
    }

    #[test]
    fn maximum_page_is_bounded_and_final_page_has_no_cursor() {
        let store = HarnessStore::in_memory().unwrap();
        for index in 0..103 {
            seed(&store, &format!("row-{index:03}"));
        }
        let first = store.session_page(page(100, None)).unwrap();
        assert_eq!(first.rows.len(), 100);
        assert_eq!(first.rows.first().unwrap().id, "row-000");
        assert_eq!(first.rows.last().unwrap().id, "row-099");
        let last = store.session_page(page(100, first.next_cursor)).unwrap();
        assert_eq!(last.rows.len(), 3);
        assert_eq!(last.rows.first().unwrap().id, "row-100");
        assert_eq!(last.rows.last().unwrap().id, "row-102");
        assert!(last.next_cursor.is_none());
    }

    #[test]
    fn invalid_pages_fail_before_lock_and_deleted_cursor_remains_a_position() {
        let store = HarnessStore::in_memory().unwrap();
        seed(&store, "a");
        seed(&store, "b");
        let cursor = store
            .session_page(page(1, None))
            .unwrap()
            .next_cursor
            .unwrap();
        store.delete("a").unwrap();
        let after = store.session_page(page(1, Some(cursor))).unwrap();
        assert_eq!(after.rows[0].id, "b");
        assert!(after.next_cursor.is_none());
        // Holding the non-reentrant mutex proves validation occurs before lock.
        let _held = store.lock().unwrap();
        for limit in [0, 101, u32::MAX] {
            assert!(store.session_page(page(limit, None)).is_err());
        }
        for id in ["", " space", "a\n", &"x".repeat(201)] {
            assert!(store
                .session_page(page(
                    1,
                    Some(AgentSessionPageCursor {
                        updated_at_ms: 0,
                        id: id.to_owned(),
                    })
                ))
                .is_err());
        }
        assert!(
            serde_json::from_value::<AgentSessionPageRequest>(serde_json::json!({
                "limit":1,"cursor":null,"offset":0,
            }))
            .is_err()
        );
    }

    #[test]
    fn session_page_prunes_deleted_active_and_rejects_corrupt_ordering_identity() {
        let store = HarnessStore::in_memory().unwrap();
        seed(&store, "a");
        store
            .save_session_navigation(request(0, &["a"], Some("a")))
            .unwrap();
        store.delete("a").unwrap();
        let loaded = store.session_page(page(100, None)).unwrap();
        assert!(loaded.rows.is_empty());
        assert!(loaded.active.is_none());
        assert!(loaded.navigation.snapshot.open_ids.is_empty());
        assert_eq!(loaded.navigation.snapshot.revision, 1);
        seed(&store, "b");
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE agent_sessions SET updated_at_ms = 2 WHERE id = 'b'",
                [],
            )
            .unwrap();
        assert_eq!(
            store.session_page(page(1, None)).unwrap_err().code,
            "session_page_invalid"
        );
    }

    #[test]
    fn page_snapshot_stays_consistent_across_writer_and_reopens_latest_state() {
        let path = std::env::temp_dir().join(format!("omnia-page-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let reader = HarnessStore::open(&path).unwrap();
            // Deliberate SQLite snapshot-isolation fixture: production opens
            // reject a second owner before recovery. This test-only connection
            // is not a live runtime observer and has no running provider.
            let writer = HarnessStore::open_snapshot_fixture(&path).unwrap();
            seed(&reader, "a");
            seed(&reader, "z");
            reader
                .save_session_navigation(request(0, &["a", "z"], Some("z")))
                .unwrap();
            let mut connection = reader.lock().unwrap();
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .unwrap();
            // Establish the same read snapshot used by public session_page.
            assert_eq!(read_snapshot(&tx).unwrap().active_id.as_deref(), Some("z"));
            writer.delete("z").unwrap();
            let mut changed = writer.summary("a").unwrap();
            changed.title = "New writer title".into();
            writer.save_summary(&changed).unwrap();
            writer
                .save_session_navigation(request(1, &["a"], Some("a")))
                .unwrap();
            let loaded = read_session_page(&tx, page(1, None)).unwrap();
            assert_eq!(loaded.rows[0].title, "a");
            assert_eq!(loaded.active.unwrap().id, "z");
            assert_eq!(loaded.navigation.snapshot.revision, 1);
            assert!(loaded.next_cursor.is_some());
            tx.commit().unwrap();
            drop(connection);
            let latest = reader.session_page(page(100, None)).unwrap();
            assert_eq!(latest.rows.len(), 1);
            assert_eq!(latest.rows[0].title, "New writer title");
            assert_eq!(latest.active.unwrap().id, "a");
            assert_eq!(latest.navigation.snapshot.revision, 2);
        }
        {
            let reopened = HarnessStore::open(&path).unwrap();
            let loaded = reopened.session_page(page(100, None)).unwrap();
            assert_eq!(loaded.rows.len(), 1);
            assert_eq!(loaded.active.unwrap().id, "a");
            assert_eq!(loaded.navigation.snapshot.revision, 2);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn navigation_is_ordered_durable_and_cas_protected() {
        let path =
            std::env::temp_dir().join(format!("omnia-navigation-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let store = HarnessStore::open(&path).unwrap();
            seed(&store, "a");
            seed(&store, "b");
            assert_eq!(
                store.load_session_navigation().unwrap().snapshot.revision,
                0
            );
            assert_eq!(
                store.load_session_navigation().unwrap().receipt_id,
                "session_navigation_empty"
            );
            assert!(matches!(
                store
                    .save_session_navigation(request(0, &["b", "a"], Some("a")))
                    .unwrap(),
                AgentSessionNavigationSave::Saved { .. }
            ));
            let first_receipt = match store
                .save_session_navigation(request(1, &["b", "a"], Some("a")))
                .unwrap()
            {
                AgentSessionNavigationSave::Saved { receipt_id, .. } => receipt_id,
                AgentSessionNavigationSave::Conflict { .. } => panic!("expected saved receipt"),
            };
            assert_ne!(first_receipt, "session_navigation_empty");
            assert_eq!(
                store.load_session_navigation().unwrap().receipt_id,
                first_receipt
            );
            assert!(matches!(
                store
                    .save_session_navigation(request(1, &["a"], Some("a")))
                    .unwrap(),
                AgentSessionNavigationSave::Conflict { receipt_id, .. } if receipt_id == first_receipt
            ));
        }
        let store = HarnessStore::open(&path).unwrap();
        let loaded = store.load_session_navigation().unwrap();
        assert_eq!(loaded.snapshot.open_ids, ["b", "a"]);
        assert_eq!(loaded.snapshot.active_id.as_deref(), Some("a"));
        assert_eq!(loaded.snapshot.revision, 2);
        drop(store);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn navigation_rejects_stale_unknown_duplicate_and_unbound_ids() {
        let store = HarnessStore::in_memory().unwrap();
        seed(&store, "a");
        for invalid in [
            request(-1, &["a"], None),
            request(0, &["missing"], None),
            request(0, &["a", "a"], None),
            request(0, &["a"], Some("missing")),
            request(0, &[" a"], None),
        ] {
            assert!(store.save_session_navigation(invalid).is_err());
        }
        assert_eq!(
            store.load_session_navigation().unwrap().snapshot.revision,
            0
        );
        assert!(serde_json::from_value::<SaveAgentSessionNavigationRequest>(
            serde_json::json!({"expectedRevision":0,"openIds":[],"activeId":null,"runId":"forged"})
        )
        .is_err());
    }

    #[test]
    fn deleted_sessions_are_pruned_without_reviving_them() {
        let store = HarnessStore::in_memory().unwrap();
        seed(&store, "a");
        seed(&store, "b");
        store
            .save_session_navigation(request(0, &["b", "a"], Some("b")))
            .unwrap();
        store.delete("b").unwrap();
        let loaded = store.load_session_navigation().unwrap().snapshot;
        assert_eq!(loaded.open_ids, ["a"]);
        assert_eq!(loaded.active_id, None);
        assert_eq!(loaded.revision, 1);
        assert!(store
            .save_session_navigation(request(1, &["b"], None))
            .is_err());
        assert!(matches!(
            store
                .save_session_navigation(request(1, &[], None))
                .unwrap(),
            AgentSessionNavigationSave::Saved { .. }
        ));
    }
}
