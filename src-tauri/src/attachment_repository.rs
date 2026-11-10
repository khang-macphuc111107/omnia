use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::Serialize;
use uuid::Uuid;

use crate::{
    content_store::{
        BlobCommitOutcome, BlobDescriptor, BlobKeyProvider, ContentStore, PreparedBlob,
    },
    error::{NativeError, NativeResult},
    storage::Storage,
};

const DEFAULT_PROFILE_ID: &str = "profile_default";
const DEFAULT_DRAFT_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_DRAFT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_FILES_PER_DRAFT: usize = 100;
const MAX_FILENAME_BYTES: usize = 512;
const MAX_ACCEPTED_MEDIA_TYPES: usize = 64;

/// Renderer-safe attachment metadata. Blob paths, wrapped keys, nonces and raw
/// bytes deliberately remain private to the native repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    pub id: String,
    pub draft_id: Option<String>,
    pub message_id: Option<String>,
    pub project_id: Option<String>,
    pub filename: String,
    pub media_type: String,
    pub byte_size: i64,
    pub extraction_status: String,
    pub created_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDraftRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub branch_id: Option<String>,
    pub state: String,
    pub expires_at_ms: i64,
    pub binding_key: Option<String>,
    pub bound_message_id: Option<String>,
    pub bound_run_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub bound_at_ms: Option<i64>,
    pub abandoned_at_ms: Option<i64>,
    pub expired_at_ms: Option<i64>,
    pub attachments: Vec<AttachmentRecord>,
}

/// Bounded UTF-8 projection for text-like attachments.  The encrypted blob
/// descriptor and raw bytes remain native-only; the renderer receives only
/// the metadata needed to display the content and the decoded text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentTextRecord {
    pub id: String,
    pub media_type: String,
    pub byte_size: i64,
    pub text: String,
}

/// Bounded, renderer-safe projection of an encrypted binary attachment. The
/// bytes have already passed AES-GCM authentication and content-hash
/// verification in `ContentStore::read_verified`; no native path or key
/// material crosses the IPC boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBinaryPreviewRecord {
    pub id: String,
    pub media_type: String,
    pub byte_size: i64,
    pub content_sha256: String,
    pub data_base64: String,
}

#[derive(Clone, Debug)]
pub struct AttachmentDraftScope<'a> {
    pub project_id: Option<&'a str>,
    pub conversation_id: Option<&'a str>,
    pub branch_id: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub struct IngestAttachmentDraft<'a> {
    pub scope: AttachmentDraftScope<'a>,
    pub paths: &'a [PathBuf],
    pub accepted_media_types: &'a [String],
    pub expires_at_ms: Option<i64>,
}

struct PreparedAttachment {
    id: String,
    filename: String,
    media_type: String,
    byte_size: i64,
    prepared_blob: PreparedBlob,
}

/// The one production coordinator for attachment ingestion.  The operation
/// mutex serializes the small filesystem-publication/SQLite-commit gap within
/// this process so two pickers cannot persist a losing randomized descriptor.
#[derive(Default)]
pub struct AttachmentRepository {
    operation_lock: Mutex<()>,
}

impl AttachmentRepository {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ingest_draft(
        &self,
        storage: &Storage,
        content_store: &ContentStore,
        keys: &dyn BlobKeyProvider,
        input: IngestAttachmentDraft<'_>,
    ) -> NativeResult<AttachmentDraftRecord> {
        validate_scope(&input.scope)?;
        validate_accepted_media_types(input.accepted_media_types)?;
        if input.paths.is_empty() || input.paths.len() > MAX_FILES_PER_DRAFT {
            return Err(NativeError::invalid(
                "paths",
                format!("must contain between 1 and {MAX_FILES_PER_DRAFT} files"),
            ));
        }

        let now = now_ms();
        let expires_at_ms = input.expires_at_ms.unwrap_or(now + DEFAULT_DRAFT_TTL_MS);
        if expires_at_ms <= now || expires_at_ms - now > MAX_DRAFT_TTL_MS {
            return Err(NativeError::invalid(
                "expiresAtMs",
                "must be after creation and no more than seven days in the future",
            ));
        }

        let mut prepared = Vec::with_capacity(input.paths.len());
        for path in input.paths {
            let (filename, media_type, bytes) = read_selected_file(
                path,
                content_store.max_blob_bytes(),
                input.accepted_media_types,
            )?;
            let byte_size = i64::try_from(bytes.len()).map_err(|_| {
                NativeError::new("attachment_too_large", "The selected file is too large")
            })?;
            prepared.push(PreparedAttachment {
                id: format!("attachment_{}", Uuid::new_v4().simple()),
                filename,
                media_type: media_type.clone(),
                byte_size,
                prepared_blob: content_store.prepare_bytes(keys, &media_type, &bytes)?,
            });
        }

        let _operation = self.operation_lock.lock().map_err(|_| {
            NativeError::new(
                "attachment_repository_locked",
                "The attachment repository lock was poisoned",
            )
        })?;
        let draft_id = format!("attachment_draft_{}", Uuid::new_v4().simple());
        let mut newly_published = Vec::new();
        let result = storage.with_transaction(|transaction| {
            validate_scope_in_database(transaction, &input.scope)?;
            transaction.execute(
                "INSERT INTO attachment_drafts (
                    id, profile_id, project_id, conversation_id, branch_id,
                    state, expires_at_ms, created_at_ms, updated_at_ms, metadata_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?7, '{}')",
                params![
                    draft_id,
                    DEFAULT_PROFILE_ID,
                    input.scope.project_id,
                    input.scope.conversation_id,
                    input.scope.branch_id,
                    expires_at_ms,
                    now,
                ],
            )?;

            for candidate in prepared {
                let prepared_descriptor = candidate.prepared_blob.descriptor().clone();
                let descriptor = match candidate.prepared_blob.commit()? {
                    BlobCommitOutcome::Published(descriptor) => {
                        insert_blob_descriptor(transaction, &descriptor, now)?;
                        newly_published.push(descriptor.storage_relpath.clone());
                        descriptor
                    }
                    BlobCommitOutcome::AlreadyExists {
                        id,
                        storage_relpath,
                    } => {
                        // Never persist `prepared_descriptor`: AES-GCM uses a
                        // fresh nonce/DEK, so it cannot describe the canonical
                        // ciphertext that won publication.
                        let canonical =
                            load_blob_descriptor(transaction, &id)?.ok_or_else(|| {
                                NativeError::new(
                                    "blob_reconciliation_required",
                                    "Encrypted content exists without canonical database metadata",
                                )
                            })?;
                        if canonical.storage_relpath != storage_relpath
                            || canonical.plaintext_size != prepared_descriptor.plaintext_size
                        {
                            return Err(NativeError::new(
                                "blob_metadata_conflict",
                                "Canonical blob metadata does not match the encrypted content",
                            ));
                        }
                        canonical
                    }
                };

                transaction.execute(
                    "INSERT INTO attachments (
                        id, profile_id, draft_id, message_id, project_id, blob_id,
                        filename, media_type, byte_size, extraction_status,
                        created_at_ms, metadata_json
                     ) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7,
                               'pending', ?8, '{\"origin\":\"picker\"}')",
                    params![
                        candidate.id,
                        DEFAULT_PROFILE_ID,
                        draft_id,
                        descriptor.id,
                        candidate.filename,
                        candidate.media_type,
                        candidate.byte_size,
                        now,
                    ],
                )?;
            }
            load_draft(transaction, &draft_id)?.ok_or_else(|| {
                NativeError::new(
                    "attachment_draft_missing",
                    "The attachment draft was not created",
                )
            })
        });

        if result.is_err() {
            // Publication precedes the SQLite commit. Remove only files this
            // operation definitively published; dedupe hits are canonical and
            // never compensated here. A cleanup failure is intentionally left
            // as an orphan for startup reconciliation, never treated as a
            // successful ingest.
            for relpath in newly_published {
                let _ = content_store.delete_file_if_present(&relpath);
            }
        }
        result
    }

    pub fn get_draft(
        &self,
        storage: &Storage,
        draft_id: &str,
    ) -> NativeResult<AttachmentDraftRecord> {
        validate_id("draftId", draft_id, "attachment_draft_")?;
        storage.with_transaction(|transaction| {
            expire_drafts(transaction, now_ms())?;
            load_draft(transaction, draft_id)?.ok_or_else(|| {
                NativeError::new(
                    "attachment_draft_not_found",
                    "Attachment draft was not found",
                )
            })
        })
    }

    pub fn list_drafts(
        &self,
        storage: &Storage,
        conversation_id: &str,
        branch_id: Option<&str>,
        include_terminal: bool,
    ) -> NativeResult<Vec<AttachmentDraftRecord>> {
        validate_id("conversationId", conversation_id, "conversation_")?;
        if let Some(branch_id) = branch_id {
            validate_id("branchId", branch_id, "branch_")?;
        }
        storage.with_transaction(|transaction| {
            expire_drafts(transaction, now_ms())?;
            let mut statement = transaction.prepare(
                "SELECT id
                 FROM attachment_drafts
                 WHERE profile_id = ?1
                   AND conversation_id = ?2
                   AND (?3 IS NULL OR branch_id = ?3)
                   AND (?4 = 1 OR state = 'open')
                 ORDER BY created_at_ms DESC, id",
            )?;
            let ids = statement
                .query_map(
                    params![
                        DEFAULT_PROFILE_ID,
                        conversation_id,
                        branch_id,
                        i64::from(include_terminal),
                    ],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            ids.into_iter()
                .map(|id| {
                    load_draft(transaction, &id)?.ok_or_else(|| {
                        NativeError::new(
                            "attachment_draft_not_found",
                            "Attachment draft disappeared during listing",
                        )
                    })
                })
                .collect()
        })
    }

    pub fn remove_attachment(
        &self,
        storage: &Storage,
        content_store: &ContentStore,
        draft_id: &str,
        attachment_id: &str,
    ) -> NativeResult<AttachmentDraftRecord> {
        validate_id("draftId", draft_id, "attachment_draft_")?;
        validate_id("attachmentId", attachment_id, "attachment_")?;
        let _operation = self.operation_lock.lock().map_err(|_| {
            NativeError::new(
                "attachment_repository_locked",
                "The attachment repository lock was poisoned",
            )
        })?;
        let now = now_ms();
        let (record, orphan_relpath) = storage.with_transaction(|transaction| {
            expire_drafts(transaction, now)?;
            ensure_open_draft(transaction, draft_id, now)?;
            let live_count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM attachments
                 WHERE draft_id = ?1 AND deleted_at_ms IS NULL",
                [draft_id],
                |row| row.get(0),
            )?;
            if live_count <= 1 {
                return Err(NativeError::new(
                    "attachment_draft_empty",
                    "Removing this file would leave the attachment draft empty",
                ));
            }
            let blob_id: String = transaction
                .query_row(
                    "SELECT blob_id FROM attachments
                     WHERE id = ?1 AND draft_id = ?2 AND deleted_at_ms IS NULL",
                    params![attachment_id, draft_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    NativeError::new(
                        "attachment_not_found",
                        "The attachment is not a live member of this draft",
                    )
                })?;
            transaction.execute("DELETE FROM attachments WHERE id = ?1", [attachment_id])?;
            transaction.execute(
                "UPDATE attachment_drafts SET updated_at_ms = ?1 WHERE id = ?2",
                params![now, draft_id],
            )?;
            let orphan_relpath = unreferenced_blob_relpath(transaction, &blob_id)?;
            if orphan_relpath.is_some() {
                transaction.execute("DELETE FROM blob_objects WHERE id = ?1", [blob_id])?;
            }
            let record = load_draft(transaction, draft_id)?.ok_or_else(|| {
                NativeError::new(
                    "attachment_draft_not_found",
                    "Attachment draft was not found",
                )
            })?;
            Ok((record, orphan_relpath))
        })?;
        if let Some(relpath) = orphan_relpath {
            // Metadata has been removed transactionally. Failure to remove the
            // ciphertext is a recoverable orphan, never a reason to resurrect
            // attachment ownership that has already committed.
            let _ = content_store.delete_file_if_present(&relpath);
        }
        Ok(record)
    }

    pub fn abandon_draft(
        &self,
        storage: &Storage,
        draft_id: &str,
    ) -> NativeResult<AttachmentDraftRecord> {
        validate_id("draftId", draft_id, "attachment_draft_")?;
        storage.with_transaction(|transaction| {
            let now = now_ms();
            expire_drafts(transaction, now)?;
            ensure_open_draft(transaction, draft_id, now)?;
            transaction.execute(
                "UPDATE attachment_drafts
                 SET state = 'abandoned', updated_at_ms = ?1, abandoned_at_ms = ?1
                 WHERE id = ?2 AND profile_id = ?3 AND state = 'open'",
                params![now, draft_id, DEFAULT_PROFILE_ID],
            )?;
            load_draft(transaction, draft_id)?.ok_or_else(|| {
                NativeError::new(
                    "attachment_draft_not_found",
                    "Attachment draft was not found",
                )
            })
        })
    }

    pub fn list_attachments(
        &self,
        storage: &Storage,
        project_id: Option<&str>,
        message_id: Option<&str>,
        include_deleted: bool,
    ) -> NativeResult<Vec<AttachmentRecord>> {
        if project_id.is_some() && message_id.is_some() {
            return Err(NativeError::invalid(
                "scope",
                "must contain at most one project or message",
            ));
        }
        if let Some(project_id) = project_id {
            validate_id("projectId", project_id, "project_")?;
        }
        if let Some(message_id) = message_id {
            validate_id("messageId", message_id, "message_")?;
        }
        storage.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, draft_id, message_id, project_id, filename, media_type,
                        byte_size, extraction_status, created_at_ms, deleted_at_ms
                 FROM attachments
                 WHERE profile_id = ?1
                   AND (?2 IS NULL OR project_id = ?2)
                   AND (?3 IS NULL OR message_id = ?3)
                   AND (?4 = 1 OR deleted_at_ms IS NULL)
                 ORDER BY created_at_ms DESC, id",
            )?;
            let attachments = statement
                .query_map(
                    params![
                        DEFAULT_PROFILE_ID,
                        project_id,
                        message_id,
                        i64::from(include_deleted),
                    ],
                    attachment_from_row,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(attachments)
        })
    }

    pub fn read_text(
        &self,
        storage: &Storage,
        content_store: &ContentStore,
        keys: &dyn BlobKeyProvider,
        attachment_id: &str,
        max_bytes: usize,
    ) -> NativeResult<AttachmentTextRecord> {
        validate_id("attachmentId", attachment_id, "attachment_")?;
        let max_bytes = u64::try_from(max_bytes).map_err(|_| {
            NativeError::new(
                "attachment_too_large",
                "The requested text limit is invalid",
            )
        })?;
        let (media_type, byte_size, descriptor) = storage.with_connection(|connection| {
            let (media_type, byte_size, blob_id): (String, i64, String) = connection
                .query_row(
                    "SELECT media_type, byte_size, blob_id
                     FROM attachments
                     WHERE id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL",
                    params![attachment_id, DEFAULT_PROFILE_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    NativeError::new(
                        "attachment_not_found",
                        "The attachment was not found or is no longer available",
                    )
                })?;
            if !is_text_media_type(&media_type) {
                return Err(NativeError::new(
                    "attachment_not_text",
                    "The attachment media type is not supported for text reading",
                ));
            }
            let descriptor = load_blob_descriptor(connection, &blob_id)?.ok_or_else(|| {
                NativeError::new(
                    "attachment_blob_missing",
                    "The attachment body metadata is unavailable",
                )
            })?;
            if descriptor.media_type != media_type || descriptor.plaintext_size != byte_size {
                return Err(NativeError::new(
                    "attachment_metadata_conflict",
                    "The attachment metadata does not match its encrypted body",
                ));
            }
            Ok((media_type, byte_size, descriptor))
        })?;

        let plaintext = content_store.read_verified(keys, &descriptor, max_bytes)?;
        let text = String::from_utf8(plaintext.to_vec()).map_err(|_| {
            NativeError::new(
                "attachment_text_invalid_utf8",
                "The text attachment is not valid UTF-8",
            )
        })?;
        Ok(AttachmentTextRecord {
            id: attachment_id.to_owned(),
            media_type,
            byte_size,
            text,
        })
    }

    pub fn read_binary_preview(
        &self,
        storage: &Storage,
        content_store: &ContentStore,
        keys: &dyn BlobKeyProvider,
        attachment_id: &str,
        max_bytes: usize,
    ) -> NativeResult<AttachmentBinaryPreviewRecord> {
        validate_id("attachmentId", attachment_id, "attachment_")?;
        let max_bytes = u64::try_from(max_bytes).map_err(|_| {
            NativeError::new(
                "attachment_too_large",
                "The requested binary preview limit is invalid",
            )
        })?;
        let (media_type, byte_size, descriptor) = storage.with_connection(|connection| {
            let (media_type, byte_size, blob_id): (String, i64, String) = connection
                .query_row(
                    "SELECT media_type, byte_size, blob_id
                     FROM attachments
                     WHERE id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL",
                    params![attachment_id, DEFAULT_PROFILE_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    NativeError::new(
                        "attachment_not_found",
                        "The attachment was not found or is no longer available",
                    )
                })?;
            let descriptor = load_blob_descriptor(connection, &blob_id)?.ok_or_else(|| {
                NativeError::new(
                    "attachment_blob_missing",
                    "The attachment body metadata is unavailable",
                )
            })?;
            if descriptor.media_type != media_type || descriptor.plaintext_size != byte_size {
                return Err(NativeError::new(
                    "attachment_metadata_conflict",
                    "The attachment metadata does not match its encrypted body",
                ));
            }
            Ok((media_type, byte_size, descriptor))
        })?;

        let plaintext = content_store.read_verified(keys, &descriptor, max_bytes)?;
        let data_base64 = BASE64_STANDARD.encode(plaintext.as_slice());
        Ok(AttachmentBinaryPreviewRecord {
            id: attachment_id.to_owned(),
            media_type,
            byte_size,
            content_sha256: descriptor.id,
            data_base64,
        })
    }
}

fn is_text_media_type(media_type: &str) -> bool {
    media_type.starts_with("text/")
        || matches!(
            media_type,
            "application/json"
                | "application/ld+json"
                | "application/xml"
                | "application/yaml"
                | "application/javascript"
                | "application/typescript"
                | "application/sql"
                | "image/svg+xml"
        )
}

fn validate_scope(scope: &AttachmentDraftScope<'_>) -> NativeResult<()> {
    if scope.project_id.is_none() && scope.conversation_id.is_none() {
        return Err(NativeError::invalid(
            "scope",
            "must identify a project or conversation",
        ));
    }
    if scope.branch_id.is_some() && scope.conversation_id.is_none() {
        return Err(NativeError::invalid(
            "branchId",
            "requires a conversation scope",
        ));
    }
    if let Some(project_id) = scope.project_id {
        validate_id("projectId", project_id, "project_")?;
    }
    if let Some(conversation_id) = scope.conversation_id {
        validate_id("conversationId", conversation_id, "conversation_")?;
    }
    if let Some(branch_id) = scope.branch_id {
        validate_id("branchId", branch_id, "branch_")?;
    }
    Ok(())
}

fn validate_scope_in_database(
    transaction: &Transaction<'_>,
    scope: &AttachmentDraftScope<'_>,
) -> NativeResult<()> {
    let scope_exists: bool = transaction.query_row(
        "SELECT EXISTS (
            SELECT 1
            FROM app_profiles profile
            LEFT JOIN projects project
              ON project.id = ?2 AND project.profile_id = profile.id
             AND project.deleted_at_ms IS NULL
            LEFT JOIN conversations conversation
              ON conversation.id = ?3 AND conversation.profile_id = profile.id
             AND conversation.deleted_at_ms IS NULL
            LEFT JOIN conversation_branches branch
              ON branch.id = ?4 AND branch.conversation_id = conversation.id
             AND branch.deleted_at_ms IS NULL
            WHERE profile.id = ?1 AND profile.deleted_at_ms IS NULL
              AND (?2 IS NULL OR project.id IS NOT NULL)
              AND (?3 IS NULL OR conversation.id IS NOT NULL)
              AND (?4 IS NULL OR branch.id IS NOT NULL)
              AND (?2 IS NULL OR ?3 IS NULL OR conversation.project_id = ?2)
        )",
        params![
            DEFAULT_PROFILE_ID,
            scope.project_id,
            scope.conversation_id,
            scope.branch_id,
        ],
        |row| row.get(0),
    )?;
    if scope_exists {
        Ok(())
    } else {
        Err(NativeError::new(
            "attachment_scope_violation",
            "The attachment draft scope is unavailable or does not share one lineage",
        ))
    }
}

fn validate_accepted_media_types(values: &[String]) -> NativeResult<()> {
    if values.len() > MAX_ACCEPTED_MEDIA_TYPES {
        return Err(NativeError::invalid(
            "acceptedMediaTypes",
            format!("must contain at most {MAX_ACCEPTED_MEDIA_TYPES} entries"),
        ));
    }
    let mut unique = HashSet::new();
    for value in values {
        let canonical = canonical_media_type(value)?;
        if !unique.insert(canonical) {
            return Err(NativeError::invalid(
                "acceptedMediaTypes",
                "cannot contain duplicate media types",
            ));
        }
    }
    Ok(())
}

fn read_selected_file(
    path: &Path,
    max_bytes: u64,
    accepted_media_types: &[String],
) -> NativeResult<(String, String, Vec<u8>)> {
    let lexical = fs::symlink_metadata(path)
        .map_err(|error| NativeError::io("could not inspect the selected attachment", error))?;
    if !lexical.is_file() || is_reparse_point(&lexical) {
        return Err(NativeError::new(
            "attachment_path_unsafe",
            "The selected attachment is not a regular local file",
        ));
    }
    let file = open_read_without_following_final_reparse_point(path)
        .map_err(|error| NativeError::io("could not open the selected attachment", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| NativeError::io("could not inspect the selected attachment", error))?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err(NativeError::new(
            "attachment_path_unsafe",
            "The selected attachment is not a regular local file",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(NativeError::new(
            "blob_too_large",
            format!("The selected attachment exceeds the {max_bytes} byte local limit"),
        ));
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| {
        NativeError::new(
            "attachment_too_large",
            "The selected attachment is too large",
        )
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| NativeError::io("could not read the selected attachment", error))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(NativeError::new(
            "attachment_changed",
            "The selected attachment changed while it was being read",
        ));
    }
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| NativeError::invalid("filename", "is unavailable or invalid UTF-8"))?
        .to_owned();
    if filename.len() > MAX_FILENAME_BYTES || filename.contains(['/', '\\', '\0']) {
        return Err(NativeError::invalid("filename", "is unsafe or too long"));
    }
    let media_type = infer::get(&bytes)
        .map(|kind| kind.mime_type().to_owned())
        .unwrap_or_else(|| media_type_from_extension(path));
    let media_type = canonical_media_type(&media_type)?;
    if !accepted_media_types.is_empty()
        && !accepted_media_types
            .iter()
            .any(|accepted| media_type_matches(&media_type, accepted))
    {
        return Err(NativeError::new(
            "attachment_media_type_rejected",
            format!("The selected attachment media type {media_type} is not accepted"),
        ));
    }
    Ok((filename, media_type, bytes))
}

fn canonical_media_type(value: &str) -> NativeResult<String> {
    let canonical = value.trim().to_ascii_lowercase();
    let Some((category, subtype)) = canonical.split_once('/') else {
        return Err(NativeError::invalid("mediaType", "must be a MIME type"));
    };
    if category.is_empty()
        || subtype.is_empty()
        || canonical.len() > 255
        || !canonical
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !byte.is_ascii_control())
    {
        return Err(NativeError::invalid(
            "mediaType",
            "must be a canonical printable MIME type",
        ));
    }
    Ok(canonical)
}

fn media_type_matches(actual: &str, accepted: &str) -> bool {
    let accepted = accepted.trim().to_ascii_lowercase();
    actual == accepted
        || accepted == "*/*"
        || accepted
            .strip_suffix("/*")
            .is_some_and(|category| actual.starts_with(&format!("{category}/")))
}

fn media_type_from_extension(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "application/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "c" | "h" => "text/x-c",
        "cc" | "cpp" | "cxx" | "hpp" => "text/x-c++",
        "java" => "text/x-java-source",
        "sql" => "application/sql",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        _ => "application/octet-stream",
    }
    .to_owned()
}

fn insert_blob_descriptor(
    transaction: &Transaction<'_>,
    descriptor: &BlobDescriptor,
    created_at_ms: i64,
) -> NativeResult<()> {
    transaction.execute(
        "INSERT INTO blob_objects (
            id, cipher_version, key_version, wrapped_dek, nonce, media_type,
            plaintext_size, ciphertext_size, storage_relpath, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            descriptor.id,
            descriptor.cipher_version,
            descriptor.key_version,
            descriptor.wrapped_dek,
            descriptor.nonce,
            descriptor.media_type,
            descriptor.plaintext_size,
            descriptor.ciphertext_size,
            descriptor.storage_relpath,
            created_at_ms,
        ],
    )?;
    Ok(())
}

fn load_blob_descriptor(connection: &Connection, id: &str) -> NativeResult<Option<BlobDescriptor>> {
    Ok(connection
        .query_row(
            "SELECT id, cipher_version, key_version, wrapped_dek, nonce,
                    media_type, plaintext_size, ciphertext_size, storage_relpath
             FROM blob_objects WHERE id = ?1",
            [id],
            |row| {
                Ok(BlobDescriptor {
                    id: row.get(0)?,
                    cipher_version: row.get(1)?,
                    key_version: row.get(2)?,
                    wrapped_dek: row.get(3)?,
                    nonce: row.get(4)?,
                    media_type: row.get(5)?,
                    plaintext_size: row.get(6)?,
                    ciphertext_size: row.get(7)?,
                    storage_relpath: row.get(8)?,
                })
            },
        )
        .optional()?)
}

fn load_draft(
    connection: &Connection,
    draft_id: &str,
) -> NativeResult<Option<AttachmentDraftRecord>> {
    let draft = connection
        .query_row(
            "SELECT id, project_id, conversation_id, branch_id, state,
                    expires_at_ms, binding_key, bound_message_id, bound_run_id,
                    created_at_ms, updated_at_ms, bound_at_ms, abandoned_at_ms,
                    expired_at_ms
             FROM attachment_drafts
             WHERE id = ?1 AND profile_id = ?2",
            params![draft_id, DEFAULT_PROFILE_ID],
            |row| {
                Ok(AttachmentDraftRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    conversation_id: row.get(2)?,
                    branch_id: row.get(3)?,
                    state: row.get(4)?,
                    expires_at_ms: row.get(5)?,
                    binding_key: row.get(6)?,
                    bound_message_id: row.get(7)?,
                    bound_run_id: row.get(8)?,
                    created_at_ms: row.get(9)?,
                    updated_at_ms: row.get(10)?,
                    bound_at_ms: row.get(11)?,
                    abandoned_at_ms: row.get(12)?,
                    expired_at_ms: row.get(13)?,
                    attachments: Vec::new(),
                })
            },
        )
        .optional()?;
    let Some(mut draft) = draft else {
        return Ok(None);
    };
    let mut statement = connection.prepare(
        "SELECT id, draft_id, message_id, project_id, filename, media_type,
                byte_size, extraction_status, created_at_ms, deleted_at_ms
         FROM attachments
         WHERE draft_id = ?1 AND profile_id = ?2 AND deleted_at_ms IS NULL
         ORDER BY created_at_ms, id",
    )?;
    draft.attachments = statement
        .query_map(params![draft_id, DEFAULT_PROFILE_ID], attachment_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(draft))
}

fn attachment_from_row(row: &Row<'_>) -> rusqlite::Result<AttachmentRecord> {
    Ok(AttachmentRecord {
        id: row.get(0)?,
        draft_id: row.get(1)?,
        message_id: row.get(2)?,
        project_id: row.get(3)?,
        filename: row.get(4)?,
        media_type: row.get(5)?,
        byte_size: row.get(6)?,
        extraction_status: row.get(7)?,
        created_at_ms: row.get(8)?,
        deleted_at_ms: row.get(9)?,
    })
}

fn expire_drafts(transaction: &Transaction<'_>, now: i64) -> NativeResult<usize> {
    Ok(transaction.execute(
        "UPDATE attachment_drafts
         SET state = 'expired', updated_at_ms = ?1, expired_at_ms = ?1
         WHERE profile_id = ?2 AND state = 'open' AND expires_at_ms <= ?1",
        params![now, DEFAULT_PROFILE_ID],
    )?)
}

fn ensure_open_draft(transaction: &Transaction<'_>, draft_id: &str, now: i64) -> NativeResult<()> {
    let state: Option<(String, i64)> = transaction
        .query_row(
            "SELECT state, expires_at_ms FROM attachment_drafts
             WHERE id = ?1 AND profile_id = ?2",
            params![draft_id, DEFAULT_PROFILE_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match state {
        None => Err(NativeError::new(
            "attachment_draft_not_found",
            "Attachment draft was not found",
        )),
        Some((state, _)) if state != "open" => Err(NativeError::new(
            "attachment_draft_not_open",
            format!("Attachment draft is {state} and can no longer be changed"),
        )),
        Some((_, expires_at)) if expires_at <= now => Err(NativeError::new(
            "attachment_draft_expired",
            "Attachment draft has expired",
        )),
        Some(_) => Ok(()),
    }
}

fn unreferenced_blob_relpath(
    transaction: &Transaction<'_>,
    blob_id: &str,
) -> NativeResult<Option<String>> {
    Ok(transaction
        .query_row(
            "SELECT storage_relpath
             FROM blob_objects blob
             WHERE blob.id = ?1
               AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.blob_id = blob.id)
               AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.extracted_text_blob_id = blob.id)
               AND NOT EXISTS (SELECT 1 FROM artifact_revisions r WHERE r.blob_id = blob.id)
               AND NOT EXISTS (SELECT 1 FROM extraction_attempts e WHERE e.output_text_blob_id = blob.id)",
            [blob_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn validate_id(field: &'static str, value: &str, prefix: &str) -> NativeResult<()> {
    let suffix = value.strip_prefix(prefix).unwrap_or_default();
    if suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(NativeError::invalid(field, "is malformed"))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn open_read_without_following_final_reparse_point(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as TestMutex;

    use zeroize::Zeroizing;

    use super::*;
    use crate::content_store::BlobKeyProvider;

    struct TestKeys {
        key: [u8; 32],
    }

    impl BlobKeyProvider for TestKeys {
        fn current_key_version(&self) -> NativeResult<i64> {
            Ok(1)
        }

        fn wrap_dek(&self, _key_version: i64, dek: &[u8; 32]) -> NativeResult<Vec<u8>> {
            Ok(dek
                .iter()
                .zip(self.key)
                .map(|(left, right)| left ^ right)
                .collect())
        }

        fn unwrap_dek(
            &self,
            _key_version: i64,
            wrapped_dek: &[u8],
        ) -> NativeResult<Zeroizing<[u8; 32]>> {
            let mut dek = [0_u8; 32];
            for (index, byte) in wrapped_dek.iter().enumerate() {
                dek[index] = byte ^ self.key[index];
            }
            Ok(Zeroizing::new(dek))
        }
    }

    static ENV_LOCK: TestMutex<()> = TestMutex::new(());

    fn fixture() -> (PathBuf, Storage, ContentStore, TestKeys, String, String) {
        let root = std::env::temp_dir().join(format!("omnia-attachment-repo-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let storage = Storage::open(root.join("omnia.sqlite3")).unwrap();
        let content_store = ContentStore::open_with_limit(&root, 1024 * 1024).unwrap();
        let (conversation_id, branch_id) = storage
            .with_transaction(|transaction| {
                let conversation_id = format!("conversation_{}", Uuid::new_v4().simple());
                let branch_id = format!("branch_{}", Uuid::new_v4().simple());
                let now = now_ms();
                transaction.execute(
                    "INSERT INTO conversations (
                        id, profile_id, title, created_at_ms, updated_at_ms, metadata_json
                     ) VALUES (?1, ?2, 'Test', ?3, ?3, '{}')",
                    params![conversation_id, DEFAULT_PROFILE_ID, now],
                )?;
                transaction.execute(
                    "INSERT INTO conversation_branches (
                        id, conversation_id, created_at_ms
                     ) VALUES (?1, ?2, ?3)",
                    params![branch_id, conversation_id, now],
                )?;
                transaction.execute(
                    "UPDATE conversations SET active_branch_id = ?1 WHERE id = ?2",
                    params![branch_id, conversation_id],
                )?;
                Ok((conversation_id, branch_id))
            })
            .unwrap();
        (
            root,
            storage,
            content_store,
            TestKeys { key: [0xA5; 32] },
            conversation_id,
            branch_id,
        )
    }

    fn write_file(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn ingest_creates_an_opaque_durable_draft_and_deduplicates_canonically() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (root, storage, content_store, keys, conversation_id, branch_id) = fixture();
        let first = write_file(&root, "first.txt", b"same private attachment");
        let second = write_file(&root, "second.txt", b"same private attachment");
        let repository = AttachmentRepository::new();
        let scope = AttachmentDraftScope {
            project_id: None,
            conversation_id: Some(&conversation_id),
            branch_id: Some(&branch_id),
        };
        let first_draft = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope: scope.clone(),
                    paths: &[first],
                    accepted_media_types: &["text/plain".to_owned()],
                    expires_at_ms: None,
                },
            )
            .unwrap();
        let second_draft = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope,
                    paths: &[second],
                    accepted_media_types: &["text/plain".to_owned()],
                    expires_at_ms: None,
                },
            )
            .unwrap();
        assert_eq!(first_draft.attachments.len(), 1);
        assert_eq!(second_draft.attachments.len(), 1);
        assert!(first_draft.id.starts_with("attachment_draft_"));
        let blob_count: i64 = storage
            .with_connection(|connection| {
                Ok(connection
                    .query_row("SELECT COUNT(*) FROM blob_objects", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(blob_count, 1);
        let attachment_count: i64 = storage
            .with_connection(|connection| {
                Ok(connection
                    .query_row("SELECT COUNT(*) FROM attachments", [], |row| row.get(0))?)
            })
            .unwrap();
        assert_eq!(attachment_count, 2);
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_canonical_metadata_fails_closed_on_dedupe() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (root, storage, content_store, keys, conversation_id, branch_id) = fixture();
        let path = write_file(&root, "orphan.txt", b"orphan encrypted body");
        let bytes = fs::read(&path).unwrap();
        content_store
            .prepare_bytes(&keys, "text/plain", &bytes)
            .unwrap()
            .commit()
            .unwrap();
        let repository = AttachmentRepository::new();
        let error = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope: AttachmentDraftScope {
                        project_id: None,
                        conversation_id: Some(&conversation_id),
                        branch_id: Some(&branch_id),
                    },
                    paths: &[path],
                    accepted_media_types: &[],
                    expires_at_ms: None,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "blob_reconciliation_required");
        let draft_count: i64 = storage
            .with_connection(|connection| {
                Ok(
                    connection.query_row("SELECT COUNT(*) FROM attachment_drafts", [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .unwrap();
        assert_eq!(draft_count, 0);
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_cannot_empty_a_draft_and_abandon_is_terminal() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (root, storage, content_store, keys, conversation_id, branch_id) = fixture();
        let first = write_file(&root, "one.txt", b"one");
        let second = write_file(&root, "two.txt", b"two");
        let repository = AttachmentRepository::new();
        let draft = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope: AttachmentDraftScope {
                        project_id: None,
                        conversation_id: Some(&conversation_id),
                        branch_id: Some(&branch_id),
                    },
                    paths: &[first, second],
                    accepted_media_types: &[],
                    expires_at_ms: None,
                },
            )
            .unwrap();
        let remaining = repository
            .remove_attachment(
                &storage,
                &content_store,
                &draft.id,
                &draft.attachments[0].id,
            )
            .unwrap();
        assert_eq!(remaining.attachments.len(), 1);
        let error = repository
            .remove_attachment(
                &storage,
                &content_store,
                &draft.id,
                &remaining.attachments[0].id,
            )
            .unwrap_err();
        assert_eq!(error.code, "attachment_draft_empty");
        let abandoned = repository.abandon_draft(&storage, &draft.id).unwrap();
        assert_eq!(abandoned.state, "abandoned");
        let terminal_error = repository.abandon_draft(&storage, &draft.id).unwrap_err();
        assert_eq!(terminal_error.code, "attachment_draft_not_open");
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_preview_authenticates_and_returns_bounded_opaque_bytes() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (root, storage, content_store, keys, conversation_id, branch_id) = fixture();
        let bytes = [0_u8, 0xFF, 0x01, 0x80, 0x42, 0x00];
        let path = write_file(&root, "opaque.bin", &bytes);
        let repository = AttachmentRepository::new();
        let draft = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope: AttachmentDraftScope {
                        project_id: None,
                        conversation_id: Some(&conversation_id),
                        branch_id: Some(&branch_id),
                    },
                    paths: &[path],
                    accepted_media_types: &[],
                    expires_at_ms: None,
                },
            )
            .unwrap();
        let id = &draft.attachments[0].id;
        let preview = repository
            .read_binary_preview(&storage, &content_store, &keys, id, bytes.len())
            .unwrap();
        assert_eq!(BASE64_STANDARD.decode(&preview.data_base64).unwrap(), bytes);
        assert_eq!(preview.byte_size, bytes.len() as i64);
        assert_eq!(preview.content_sha256, crate::storage::sha256_hex(bytes));
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains("wrappedDek"));
        assert!(!serialized.contains("nonce"));
        assert!(!serialized.contains("storageRelpath"));
        assert_eq!(
            repository
                .read_binary_preview(&storage, &content_store, &keys, id, bytes.len() - 1,)
                .unwrap_err()
                .code,
            "blob_too_large"
        );
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_preview_rejects_metadata_drift_and_deleted_attachments() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (root, storage, content_store, keys, conversation_id, branch_id) = fixture();
        let path = write_file(&root, "document.bin", b"private bytes");
        let repository = AttachmentRepository::new();
        let draft = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope: AttachmentDraftScope {
                        project_id: None,
                        conversation_id: Some(&conversation_id),
                        branch_id: Some(&branch_id),
                    },
                    paths: &[path],
                    accepted_media_types: &[],
                    expires_at_ms: None,
                },
            )
            .unwrap();
        let id = &draft.attachments[0].id;
        storage
            .with_transaction(|transaction| {
                transaction.execute(
                    "UPDATE attachments SET byte_size = byte_size + 1 WHERE id = ?1",
                    [id],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            repository
                .read_binary_preview(&storage, &content_store, &keys, id, 1024,)
                .unwrap_err()
                .code,
            "attachment_metadata_conflict"
        );
        storage
            .with_transaction(|transaction| {
                transaction.execute(
                    "UPDATE attachments SET deleted_at_ms = ?1 WHERE id = ?2",
                    params![now_ms(), id],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            repository
                .read_binary_preview(&storage, &content_store, &keys, id, 1024,)
                .unwrap_err()
                .code,
            "attachment_not_found"
        );
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_preview_rejects_ciphertext_tampering_before_returning_bytes() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (root, storage, content_store, keys, conversation_id, branch_id) = fixture();
        let path = write_file(&root, "secret.bin", b"authenticated private bytes");
        let repository = AttachmentRepository::new();
        let draft = repository
            .ingest_draft(
                &storage,
                &content_store,
                &keys,
                IngestAttachmentDraft {
                    scope: AttachmentDraftScope {
                        project_id: None,
                        conversation_id: Some(&conversation_id),
                        branch_id: Some(&branch_id),
                    },
                    paths: &[path],
                    accepted_media_types: &[],
                    expires_at_ms: None,
                },
            )
            .unwrap();
        let id = &draft.attachments[0].id;
        let relative: String = storage.with_connection(|connection| {
            Ok(connection.query_row(
                "SELECT blob.storage_relpath FROM blob_objects blob JOIN attachments a ON a.blob_id = blob.id WHERE a.id = ?1",
                [id], |row| row.get(0),
            )?)
        }).unwrap();
        let ciphertext_path = root.join("blobs").join(relative);
        let mut ciphertext = fs::read(&ciphertext_path).unwrap();
        ciphertext[0] ^= 1;
        fs::write(&ciphertext_path, ciphertext).unwrap();
        assert_eq!(
            repository
                .read_binary_preview(&storage, &content_store, &keys, id, 1024,)
                .unwrap_err()
                .code,
            "blob_integrity_failed"
        );
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
