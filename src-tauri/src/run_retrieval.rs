//! Native execution evidence for retrieval requested by an exact prepared run.
//!
//! The stateless scorer intentionally accepts renderer projections. This path
//! instead reads a live native workspace grant, builds its own index, and
//! commits a content-free receipt only while the original run/grant scope is
//! still valid. A receipt proves retrieval execution; it does not mutate an
//! already frozen provider input or claim that the provider received its text.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    error::{NativeError, NativeResult},
    run_journal::{
        append_run_event, retrieval_receipt_event, PreparedRunJournalScope,
        RunContextRetrievalMatch, RunContextRetrievalOmission, RunContextRetrievalReceipt,
        RunJournalEventRecord,
    },
    storage::{now_ms, Storage},
    workspace_indexer::{
        build_workspace_index, retrieve_workspace_chunks, WorkspaceIndexOptions,
        WorkspaceIndexSnapshot, WorkspaceIndexStats, WorkspaceRetrievalOptions,
        WorkspaceRetrievalResult,
    },
};

const PROFILE_ID: &str = "profile_default";
// Journal evidence is bounded independently from the larger retrieval result.
const MAX_RECEIPT_OMISSIONS: usize = 1_024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetrieveWorkspaceForRunRequest {
    pub run_id: String,
    pub attempt_id: String,
    pub frozen_provider_input_id: String,
    pub grant_id: String,
    pub query: String,
    pub index_options: Option<WorkspaceIndexOptions>,
    pub retrieval_options: Option<WorkspaceRetrievalOptions>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunWorkspaceRetrievalResult {
    pub retrieval: WorkspaceRetrievalResult,
    pub index_snapshot_id: String,
    pub index_snapshot_sha256: String,
    pub index_truncated: bool,
    pub index_has_errors: bool,
    pub index_stats: WorkspaceIndexStats,
    pub journal_event: RunJournalEventRecord,
    /// Frozen requests are immutable. Retrieval results require a separate
    /// context compilation/admission step before a later provider dispatch.
    pub provider_input_admission: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
struct WorkspaceRetrievalScope {
    project_id: Option<String>,
    grant_updated_at_ms: i64,
    canonical_path_hash: String,
}

pub fn retrieve_workspace_for_run(
    storage: &Storage,
    request: RetrieveWorkspaceForRunRequest,
) -> NativeResult<RunWorkspaceRetrievalResult> {
    let scope = PreparedRunJournalScope::new(
        &request.run_id,
        &request.attempt_id,
        &request.frozen_provider_input_id,
    )?;
    validate_grant_id(&request.grant_id)?;
    let retrieval_options = request.retrieval_options.unwrap_or_default();
    // Reject invalid queries/budgets before scanning the filesystem.
    retrieve_workspace_chunks(&[], &request.query, &retrieval_options)?;
    let expected_scope = storage.with_connection(|connection| {
        load_workspace_scope(connection, &scope, &request.grant_id)
    })?;
    let root = storage.workspace_root_for_read(&request.grant_id)?;
    let index = build_workspace_index(
        &request.grant_id,
        expected_scope.project_id.as_deref(),
        &root,
        &request.index_options.unwrap_or_default(),
    )?;
    let retrieval = retrieve_workspace_chunks(&index.chunks, &request.query, &retrieval_options)?;
    let receipt = receipt_from_native_result(&index, &retrieval);
    let payload = serde_json::to_value(receipt).map_err(|_| {
        NativeError::new(
            "retrieval_receipt_failed",
            "Could not encode retrieval evidence",
        )
    })?;
    let occurred_at_ms = now_ms();
    let journal_event = storage.with_immediate_transaction(|transaction| {
        let actual_scope = load_workspace_scope(transaction, &scope, &request.grant_id)?;
        if actual_scope != expected_scope {
            return Err(NativeError::new(
                "workspace_retrieval_scope_changed",
                "The workspace grant changed while retrieval was executing",
            ));
        }
        append_run_event(
            transaction,
            retrieval_receipt_event(&scope, payload, occurred_at_ms),
        )
    })?;
    Ok(RunWorkspaceRetrievalResult {
        retrieval,
        index_snapshot_id: index.snapshot_id,
        index_snapshot_sha256: index.snapshot_sha256,
        index_truncated: index.truncated,
        index_has_errors: index.has_errors,
        index_stats: index.stats,
        journal_event,
        provider_input_admission: "not_admitted",
    })
}

fn load_workspace_scope(
    connection: &Connection,
    scope: &PreparedRunJournalScope,
    grant_id: &str,
) -> NativeResult<WorkspaceRetrievalScope> {
    let run_scope: Option<(Option<String>, String, String)> = connection
        .query_row(
            "SELECT c.project_id, g.state, a.state
             FROM generations g
             JOIN conversations c ON c.id = g.conversation_id
             JOIN run_attempts a ON a.generation_id = g.id
             JOIN frozen_provider_inputs f ON f.run_id = g.id AND f.attempt_id = a.id
             WHERE g.id = ?1 AND a.id = ?2 AND f.id = ?3
               AND c.profile_id = ?4 AND c.deleted_at_ms IS NULL
               AND (c.project_id IS NULL OR EXISTS (
                   SELECT 1 FROM projects p
                   WHERE p.id = c.project_id AND p.profile_id = ?4 AND p.deleted_at_ms IS NULL
               ))",
            params![
                scope.run_id,
                scope.attempt_id,
                scope.frozen_provider_input_id,
                PROFILE_ID
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((project_id, run_state, attempt_state)) = run_scope else {
        return Err(NativeError::new(
            "run_event_scope_conflict",
            "The exact run, attempt, and frozen input do not belong to an active conversation",
        ));
    };
    if !matches!(
        (run_state.as_str(), attempt_state.as_str()),
        ("queued", "created") | ("running", "dispatching" | "accepted" | "streaming")
    ) {
        return Err(NativeError::new(
            "run_state_conflict",
            "Retrieval requires an active prepared provider attempt",
        ));
    }
    let grant: Option<(i64, String)> = connection
        .query_row(
            "SELECT updated_at_ms, canonical_path_hash FROM workspace_grants
             WHERE id = ?1 AND profile_id = ?2 AND project_id IS ?3
               AND revoked_at_ms IS NULL AND json_extract(permissions_json, '$.read') = 1",
            params![grant_id, PROFILE_ID, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((grant_updated_at_ms, canonical_path_hash)) = grant else {
        return Err(NativeError::new(
            "workspace_retrieval_scope_conflict",
            "Retrieval requires a live read grant in the run's exact project scope",
        ));
    };
    Ok(WorkspaceRetrievalScope {
        project_id,
        grant_updated_at_ms,
        canonical_path_hash,
    })
}

fn receipt_from_native_result(
    index: &WorkspaceIndexSnapshot,
    retrieval: &WorkspaceRetrievalResult,
) -> RunContextRetrievalReceipt {
    RunContextRetrievalReceipt {
        query_sha256: retrieval.query_sha256.clone(),
        index_snapshot_id: Some(index.snapshot_id.clone()),
        index_snapshot_sha256: Some(index.snapshot_sha256.clone()),
        indexer_version: index.indexer_version.clone(),
        scorer_version: retrieval.scorer_version.clone(),
        token_budget: retrieval.token_budget as u64,
        consumed_tokens: retrieval.consumed_tokens as u64,
        matched_candidates: retrieval.matched_candidates as u64,
        omission_report_truncated: retrieval.omission_report_truncated
            || retrieval.omissions.len() > MAX_RECEIPT_OMISSIONS,
        matches: retrieval
            .matches
            .iter()
            .map(|matched| RunContextRetrievalMatch {
                chunk_id: matched.chunk.chunk_id.clone(),
                source_id: matched.chunk.source_id.clone(),
                rank: matched.rank as u32,
                score: matched.score,
                reasons: matched
                    .reasons
                    .iter()
                    .map(|reason| reason.as_str().to_owned())
                    .collect(),
                token_estimate: matched.chunk.token_estimate as u64,
                content_sha256: matched.chunk.content_sha256.clone(),
            })
            .collect(),
        omissions: retrieval
            .omissions
            .iter()
            .take(MAX_RECEIPT_OMISSIONS)
            .map(|omitted| RunContextRetrievalOmission {
                chunk_id: omitted.chunk_id.clone(),
                reason: omitted.reason.as_str().to_owned(),
            })
            .collect(),
    }
}

fn validate_grant_id(grant_id: &str) -> NativeResult<()> {
    let suffix = grant_id.strip_prefix("workspace_").unwrap_or_default();
    if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(NativeError::invalid(
            "grantId",
            "must be an opaque native workspace identifier",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        prepared_provider_input::{PreparedProviderInputReceipt, StartPreparedAttemptRequest},
        run_journal::{ProviderAcceptanceEvidence, ProviderAttemptFailureEvidence},
        storage::{NewConversationRun, NewProviderProfile},
    };
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("omnia-retrieval-{}", Uuid::new_v4()));
            fs::create_dir(&directory).expect("test directory should be created");
            fs::write(
                directory.join("cobalt.md"),
                "Cobalt retrieval verifies exact prepared run scope and native journal receipts.",
            )
            .expect("test source should be written");
            Self(directory)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            // Remove only this independently generated, verified temp child.
            let temp_root = fs::canonicalize(std::env::temp_dir()).ok();
            let target = fs::canonicalize(&self.0).ok();
            if let (Some(temp_root), Some(target)) = (temp_root, target) {
                if target.parent() == Some(temp_root.as_path())
                    && target
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("omnia-retrieval-"))
                {
                    let _ = fs::remove_dir_all(target);
                }
            }
        }
    }

    fn prepare(storage: &Storage, project_id: Option<&str>) -> PreparedProviderInputReceipt {
        let conversation = storage.create_conversation(project_id, None).unwrap();
        let provider_display_name = format!("Retrieval test provider {}", Uuid::new_v4().simple());
        let provider = storage
            .save_provider_profile(NewProviderProfile {
                provider_type: "local",
                display_name: &provider_display_name,
                normalized_base_url: "http://127.0.0.1:11434/v1",
                auth_scheme: "none",
                organization_id: None,
                remote_project_id: None,
                credential_ref: None,
                local_network_grant: true,
            })
            .unwrap();
        let run_id = format!("run_{}", Uuid::new_v4().simple());
        let attempt_id = format!("attempt_{}", Uuid::new_v4().simple());
        let user_message_id = format!("message_{}", Uuid::new_v4().simple());
        let assistant_message_id = format!("message_{}", Uuid::new_v4().simple());
        storage
            .prepare_conversation_run(NewConversationRun {
                conversation_id: &conversation.conversation.id,
                branch_id: &conversation.conversation.active_branch_id,
                run_id: &run_id,
                attempt_id: &attempt_id,
                user_message_id: &user_message_id,
                assistant_message_id: &assistant_message_id,
                prompt: "Retrieve cobalt evidence",
                provider_profile_id: &provider.id,
                model_id: "local-model",
                request_parameters_json: "{}",
            })
            .unwrap()
            .provider_input
    }

    fn request(
        input: &PreparedProviderInputReceipt,
        grant_id: &str,
    ) -> RetrieveWorkspaceForRunRequest {
        RetrieveWorkspaceForRunRequest {
            run_id: input.run_id.clone(),
            attempt_id: input.attempt_id.clone(),
            frozen_provider_input_id: input.id.clone(),
            grant_id: grant_id.to_owned(),
            query: "cobalt retrieval".to_owned(),
            index_options: None,
            retrieval_options: None,
        }
    }

    fn event_count(storage: &Storage, run_id: &str) -> i64 {
        storage
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM run_events WHERE run_id = ?1",
                        [run_id],
                        |row| row.get(0),
                    )
                    .map_err(NativeError::from)
            })
            .unwrap()
    }

    #[test]
    fn native_retrieval_receipt_keeps_exact_scope_and_does_not_break_dispatch() {
        let storage = Storage::in_memory().unwrap();
        let directory = TestDirectory::new();
        let grant = storage.add_workspace_grant(None, &directory.0).unwrap();
        let input = prepare(&storage, None);
        let result = retrieve_workspace_for_run(&storage, request(&input, &grant.id)).unwrap();
        assert_eq!(result.retrieval.matches.len(), 1);
        assert_eq!(result.journal_event.run_id, input.run_id);
        assert_eq!(
            result.journal_event.attempt_id.as_deref(),
            Some(input.attempt_id.as_str())
        );
        assert_eq!(
            result.journal_event.frozen_provider_input_id.as_deref(),
            Some(input.id.as_str())
        );
        assert_eq!(result.journal_event.event_type, "context.retrieval_receipt");
        assert_eq!(result.provider_input_admission, "not_admitted");
        let receipt_json = serde_json::to_string(&result.journal_event.payload).unwrap();
        assert!(!receipt_json.contains("Cobalt retrieval verifies"));
        assert!(!receipt_json.contains("cobalt.md"));
        assert!(!receipt_json.contains(&directory.0.to_string_lossy().to_string()));
        storage
            .mark_prepared_attempt_dispatching(&StartPreparedAttemptRequest {
                attempt_id: input.attempt_id.clone(),
                frozen_provider_input_id: input.id.clone(),
            })
            .expect("receipt must not replace the lifecycle head");
        let scope =
            PreparedRunJournalScope::new(&input.run_id, &input.attempt_id, &input.id).unwrap();
        storage
            .journal_provider_started(&scope, &input.provider_profile_id, &input.model, now_ms())
            .unwrap();
        retrieve_workspace_for_run(&storage, request(&input, &grant.id)).unwrap();
        storage
            .journal_assistant_delta(&scope, "Grounded answer", now_ms())
            .unwrap();
        storage
            .journal_run_completed(&scope, "stop", now_ms())
            .unwrap();
        let before = event_count(&storage, &input.run_id);
        assert_eq!(
            retrieve_workspace_for_run(&storage, request(&input, &grant.id))
                .unwrap_err()
                .code,
            "run_state_conflict"
        );
        assert_eq!(event_count(&storage, &input.run_id), before);
    }

    #[test]
    fn native_retrieval_rejects_cross_run_and_cross_project_scopes_without_journal_mutation() {
        let storage = Storage::in_memory().unwrap();
        let directory = TestDirectory::new();
        let project_a = storage.create_project("A", None, None).unwrap();
        let project_b = storage.create_project("B", None, None).unwrap();
        let grant = storage
            .add_workspace_grant(Some(&project_a.id), &directory.0)
            .unwrap();
        let input_a = prepare(&storage, Some(&project_a.id));
        let input_b = prepare(&storage, Some(&project_b.id));
        let before = event_count(&storage, &input_b.run_id);
        assert_eq!(
            retrieve_workspace_for_run(&storage, request(&input_b, &grant.id))
                .unwrap_err()
                .code,
            "workspace_retrieval_scope_conflict"
        );
        let mut invalid = request(&input_a, &grant.id);
        invalid.frozen_provider_input_id = input_b.id;
        assert_eq!(
            retrieve_workspace_for_run(&storage, invalid)
                .unwrap_err()
                .code,
            "run_event_scope_conflict"
        );
        assert_eq!(event_count(&storage, &input_b.run_id), before);
    }

    #[test]
    fn native_retrieval_rejects_revoked_grants_and_terminal_runs() {
        let storage = Storage::in_memory().unwrap();
        let directory = TestDirectory::new();
        let grant = storage.add_workspace_grant(None, &directory.0).unwrap();
        let input = prepare(&storage, None);
        storage.revoke_workspace_grant(&grant.id).unwrap();
        let before = event_count(&storage, &input.run_id);
        assert_eq!(
            retrieve_workspace_for_run(&storage, request(&input, &grant.id))
                .unwrap_err()
                .code,
            "workspace_retrieval_scope_conflict"
        );
        assert_eq!(event_count(&storage, &input.run_id), before);
        storage.add_workspace_grant(None, &directory.0).unwrap();
        let scope =
            PreparedRunJournalScope::new(&input.run_id, &input.attempt_id, &input.id).unwrap();
        storage
            .journal_prepared_run_failed(
                &scope,
                "fixture_failure",
                ProviderAttemptFailureEvidence::Definitive {
                    acceptance: ProviderAcceptanceEvidence::NotAccepted,
                },
                now_ms(),
            )
            .unwrap();
        let before_terminal = event_count(&storage, &input.run_id);
        assert_eq!(
            retrieve_workspace_for_run(&storage, request(&input, &grant.id))
                .unwrap_err()
                .code,
            "run_state_conflict"
        );
        assert_eq!(event_count(&storage, &input.run_id), before_terminal);
    }
}
