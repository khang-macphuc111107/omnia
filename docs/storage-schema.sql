-- Omnia Phase 1 local persistence contract.
-- SQLite dialect. Application migrations own execution of this file.
-- Secret material MUST NOT be stored in this database.

PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;

CREATE TABLE schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    min_app_version TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    encryption_key_version INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE schema_migrations (
    migration_id TEXT PRIMARY KEY,
    checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    duration_ms INTEGER,
    app_version TEXT NOT NULL
) STRICT;

CREATE TABLE app_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json))
) STRICT;

CREATE TABLE provider_profiles (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    provider_type TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    normalized_base_url TEXT NOT NULL,
    credential_ref TEXT, -- opaque handle; not a key/token
    auth_scheme TEXT NOT NULL DEFAULT 'bearer',
    organization_id TEXT,
    remote_project_id TEXT,
    config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
    egress_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(egress_policy_json)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    UNIQUE (profile_id, display_name)
) STRICT;

CREATE INDEX provider_profiles_profile_idx
    ON provider_profiles(profile_id, deleted_at_ms, enabled);

CREATE TABLE provider_models (
    provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    display_name TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
    limits_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits_json)),
    pricing_json TEXT CHECK (pricing_json IS NULL OR json_valid(pricing_json)),
    discovered_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    PRIMARY KEY (provider_profile_id, model_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    description TEXT,
    instructions TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX projects_profile_idx ON projects(profile_id, deleted_at_ms, updated_at_ms DESC);

CREATE TABLE workspace_grants (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    display_path TEXT NOT NULL,
    canonical_path_hash TEXT NOT NULL CHECK (length(canonical_path_hash) = 64),
    path_ref TEXT NOT NULL, -- native-owned bookmark/opaque scoped path reference
    permissions_json TEXT NOT NULL CHECK (json_valid(permissions_json)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    UNIQUE (profile_id, canonical_path_hash)
) STRICT;

CREATE TABLE model_presets (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    provider_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    model_id TEXT NOT NULL,
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
    system_instruction TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    UNIQUE (profile_id, name)
) STRICT;

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'New chat' CHECK (length(title) <= 500),
    active_branch_id TEXT,
    pinned_at_ms INTEGER,
    archived_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX conversations_list_idx
    ON conversations(profile_id, deleted_at_ms, archived_at_ms, updated_at_ms DESC);

CREATE TABLE conversation_branches (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL,
    forked_from_message_id TEXT,
    name TEXT,
    created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER
) STRICT;

CREATE INDEX branches_conversation_idx
    ON conversation_branches(conversation_id, deleted_at_ms, created_at_ms);

-- Added after both tables exist to avoid a circular create-order dependency.
CREATE TRIGGER conversations_active_branch_guard_insert
BEFORE INSERT ON conversations
WHEN NEW.active_branch_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM conversation_branches b
        WHERE b.id = NEW.active_branch_id AND b.conversation_id = NEW.id
    ) THEN RAISE(ABORT, 'active branch must belong to conversation') END;
END;

CREATE TRIGGER conversations_active_branch_guard_update
BEFORE UPDATE OF active_branch_id ON conversations
WHEN NEW.active_branch_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM conversation_branches b
        WHERE b.id = NEW.active_branch_id AND b.conversation_id = NEW.id
    ) THEN RAISE(ABORT, 'active branch must belong to conversation') END;
END;

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    replaces_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'developer', 'user', 'assistant', 'tool')),
    status TEXT NOT NULL CHECK (status IN ('draft', 'complete', 'cancelled', 'failed')),
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
    content_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(content_json)),
    content_text TEXT NOT NULL DEFAULT '',
    provider_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
    model_id TEXT,
    finish_reason TEXT,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cached_tokens INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    cost_microunits INTEGER CHECK (cost_microunits IS NULL OR cost_microunits >= 0),
    content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    finalized_at_ms INTEGER,
    deleted_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    UNIQUE (branch_id, sequence_no)
) STRICT;

CREATE INDEX messages_conversation_idx
    ON messages(conversation_id, branch_id, deleted_at_ms, sequence_no);
CREATE INDEX messages_parent_idx ON messages(parent_message_id);

CREATE TABLE generations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    provider_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
    model_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'cancelled', 'failed')),
    request_parameters_json TEXT NOT NULL CHECK (json_valid(request_parameters_json)),
    request_fingerprint TEXT CHECK (request_fingerprint IS NULL OR length(request_fingerprint) = 64),
    remote_request_id TEXT,
    error_code TEXT,
    started_at_ms INTEGER,
    first_token_at_ms INTEGER,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX generations_conversation_idx
    ON generations(conversation_id, created_at_ms DESC);

-- A generation is the user-visible logical run. Retries, reconnects, repairs,
-- and user-authorized fallbacks are distinct provider attempts so partial or
-- terminal outcomes are never overwritten by a later dispatch.
CREATE TABLE run_attempts (
    id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    provider_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
    model_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('created', 'dispatching', 'accepted', 'streaming',
                  'complete', 'interrupted', 'failed', 'outcome_unknown')
    ),
    accepted_by_provider TEXT NOT NULL DEFAULT 'false'
        CHECK (accepted_by_provider IN ('false', 'true', 'unknown')),
    idempotency_supported INTEGER NOT NULL DEFAULT 0
        CHECK (idempotency_supported IN (0, 1)),
    remote_request_id TEXT,
    error_code TEXT,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (generation_id, ordinal)
) STRICT;

CREATE INDEX run_attempts_generation_idx
    ON run_attempts(generation_id, ordinal);

CREATE TABLE blob_objects (
    id TEXT PRIMARY KEY, -- SHA-256 plaintext content hash
    cipher_version INTEGER NOT NULL,
    key_version INTEGER NOT NULL,
    wrapped_dek BLOB NOT NULL,
    nonce BLOB NOT NULL,
    media_type TEXT NOT NULL,
    plaintext_size INTEGER NOT NULL CHECK (plaintext_size >= 0),
    ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size >= 0),
    storage_relpath TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL,
    verified_at_ms INTEGER,
    pending_delete_at_ms INTEGER
) STRICT;

CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
    extracted_text_blob_id TEXT REFERENCES blob_objects(id) ON DELETE SET NULL,
    created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK ((message_id IS NOT NULL) != (project_id IS NOT NULL))
) STRICT;

CREATE INDEX attachments_message_idx ON attachments(message_id, deleted_at_ms);
CREATE INDEX attachments_project_idx ON attachments(project_id, deleted_at_ms);

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    language TEXT,
    current_revision_id TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER
) STRICT;

CREATE TABLE artifact_revisions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (artifact_id, revision_no)
) STRICT;

CREATE TABLE memory_records (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'conversation')),
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('candidate', 'approved', 'rejected', 'expired', 'deleted')),
    content_text TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    confidence_ppm INTEGER CHECK (confidence_ppm IS NULL OR confidence_ppm BETWEEN 0 AND 1000000),
    source_type TEXT NOT NULL,
    source_id TEXT,
    extraction_model TEXT,
    user_approved INTEGER NOT NULL DEFAULT 0 CHECK (user_approved IN (0, 1)),
    approved_at_ms INTEGER,
    expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK (
        (scope = 'global' AND project_id IS NULL AND conversation_id IS NULL) OR
        (scope = 'project' AND project_id IS NOT NULL AND conversation_id IS NULL) OR
        (scope = 'conversation' AND conversation_id IS NOT NULL)
    )
) STRICT;

CREATE INDEX memory_retrieval_idx
    ON memory_records(profile_id, state, scope, project_id, conversation_id, expires_at_ms);

CREATE TABLE memory_embeddings (
    memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
    embedding_model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    source_content_sha256 TEXT NOT NULL CHECK (length(source_content_sha256) = 64),
    vector_blob BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (memory_id, embedding_model)
) WITHOUT ROWID, STRICT;

CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    UNIQUE (profile_id, slug)
) STRICT;

CREATE TABLE skill_versions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    content_blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    source_type TEXT NOT NULL,
    source_uri TEXT,
    author TEXT,
    signature_json TEXT CHECK (signature_json IS NULL OR json_valid(signature_json)),
    requested_capabilities_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(requested_capabilities_json)),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (skill_id, version),
    UNIQUE (skill_id, content_sha256)
) STRICT;

CREATE TABLE capability_grants (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('skill_version', 'workspace', 'provider', 'agent')),
    subject_id TEXT NOT NULL,
    subject_content_sha256 TEXT,
    capability TEXT NOT NULL,
    constraints_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
    granted_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER,
    revoked_at_ms INTEGER,
    UNIQUE (profile_id, subject_type, subject_id, capability)
) STRICT;

CREATE TABLE audit_events (
    sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    profile_id TEXT REFERENCES app_profiles(id) ON DELETE SET NULL,
    occurred_at_ms INTEGER NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
    subject_type TEXT,
    subject_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    previous_mac BLOB,
    event_mac BLOB NOT NULL
) STRICT;

CREATE INDEX audit_events_time_idx ON audit_events(occurred_at_ms DESC);

CREATE TABLE purge_queue (
    id TEXT PRIMARY KEY,
    profile_id TEXT REFERENCES app_profiles(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    not_before_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT,
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (entity_type, entity_id)
) STRICT;

CREATE INDEX purge_queue_ready_idx
    ON purge_queue(completed_at_ms, not_before_ms, attempt_count);

-- Omnia schema v3: encrypted content, indexing, frozen context, and citations.
-- Keep this marker stable: the native migrator uses the SQL below it as the
-- transactional v2 -> v3 migration while fresh profiles execute this file in
-- full. Content payloads stay in blob_objects; these tables retain bounded
-- metadata, hashes, scope, and immutable provenance only.

ALTER TABLE artifact_revisions
    ADD COLUMN producing_run_id TEXT REFERENCES generations(id) ON DELETE SET NULL;
ALTER TABLE artifact_revisions
    ADD COLUMN producing_attempt_id TEXT REFERENCES run_attempts(id) ON DELETE SET NULL;
ALTER TABLE artifact_revisions
    ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));

CREATE INDEX artifact_revisions_producing_run_idx
    ON artifact_revisions(producing_run_id, producing_attempt_id);

CREATE TRIGGER artifact_revisions_attempt_guard_insert
BEFORE INSERT ON artifact_revisions
WHEN NEW.producing_attempt_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NEW.producing_run_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM run_attempts a
        WHERE a.id = NEW.producing_attempt_id
          AND a.generation_id = NEW.producing_run_id
    ) THEN RAISE(ABORT, 'artifact attempt must belong to producing run') END;
END;

CREATE TRIGGER artifact_revisions_attempt_guard_update
BEFORE UPDATE OF producing_run_id, producing_attempt_id ON artifact_revisions
WHEN NEW.producing_attempt_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NEW.producing_run_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM run_attempts a
        WHERE a.id = NEW.producing_attempt_id
          AND a.generation_id = NEW.producing_run_id
    ) THEN RAISE(ABORT, 'artifact attempt must belong to producing run') END;
END;

CREATE TABLE attachment_ingestions (
    id TEXT PRIMARY KEY,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'complete', 'failed', 'skipped', 'cancelled')
    ),
    requested_by_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    requested_by_run_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    source_content_sha256 TEXT NOT NULL CHECK (length(source_content_sha256) = 64),
    detected_media_type TEXT,
    error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    UNIQUE (attachment_id, ordinal),
    CHECK (completed_at_ms IS NULL OR started_at_ms IS NOT NULL)
) STRICT;

CREATE INDEX attachment_ingestions_attachment_idx
    ON attachment_ingestions(attachment_id, ordinal DESC);
CREATE INDEX attachment_ingestions_state_idx
    ON attachment_ingestions(state, updated_at_ms);

CREATE TABLE extraction_attempts (
    id TEXT PRIMARY KEY,
    ingestion_id TEXT NOT NULL REFERENCES attachment_ingestions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    extractor_id TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('created', 'running', 'complete', 'failed', 'cancelled')
    ),
    output_text_blob_id TEXT REFERENCES blob_objects(id) ON DELETE RESTRICT,
    output_content_sha256 TEXT CHECK (
        output_content_sha256 IS NULL OR length(output_content_sha256) = 64
    ),
    page_count INTEGER CHECK (page_count IS NULL OR page_count >= 0),
    error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    diagnostics_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(diagnostics_json)),
    UNIQUE (ingestion_id, ordinal),
    CHECK (
        (state = 'complete' AND output_text_blob_id IS NOT NULL
                            AND output_content_sha256 IS NOT NULL)
        OR state <> 'complete'
    )
) STRICT;

CREATE INDEX extraction_attempts_ingestion_idx
    ON extraction_attempts(ingestion_id, ordinal DESC);

CREATE TABLE indexed_sources (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (
        source_kind IN ('workspace_file', 'attachment', 'artifact')
    ),
    workspace_grant_id TEXT REFERENCES workspace_grants(id) ON DELETE RESTRICT,
    attachment_id TEXT REFERENCES attachments(id) ON DELETE RESTRICT,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
    source_key_sha256 TEXT NOT NULL CHECK (length(source_key_sha256) = 64),
    relative_path TEXT,
    display_name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (
        state IN ('active', 'superseded', 'revoked', 'deleted')
    ),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    invalidated_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK (
        (source_kind = 'workspace_file'
            AND workspace_grant_id IS NOT NULL
            AND attachment_id IS NULL AND artifact_id IS NULL)
        OR
        (source_kind = 'attachment'
            AND attachment_id IS NOT NULL
            AND workspace_grant_id IS NULL AND artifact_id IS NULL)
        OR
        (source_kind = 'artifact'
            AND artifact_id IS NOT NULL
            AND workspace_grant_id IS NULL AND attachment_id IS NULL)
    ),
    CHECK ((state IN ('revoked', 'deleted')) = (invalidated_at_ms IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX indexed_sources_live_key_idx
    ON indexed_sources(profile_id, source_key_sha256)
    WHERE state = 'active';
CREATE INDEX indexed_sources_project_idx
    ON indexed_sources(project_id, state, updated_at_ms DESC);
CREATE INDEX indexed_sources_grant_idx
    ON indexed_sources(workspace_grant_id, state);

CREATE TABLE source_versions (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES indexed_sources(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    content_blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    modified_at_ms INTEGER,
    extractor_id TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    superseded_at_ms INTEGER,
    invalidated_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    UNIQUE (source_id, ordinal),
    UNIQUE (source_id, content_sha256),
    CHECK (superseded_at_ms IS NULL OR superseded_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX source_versions_source_idx
    ON source_versions(source_id, ordinal DESC);

CREATE TABLE source_chunks (
    id TEXT PRIMARY KEY,
    source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    content_blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    source_content_sha256 TEXT NOT NULL CHECK (length(source_content_sha256) = 64),
    start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
    end_byte INTEGER NOT NULL CHECK (end_byte > start_byte),
    start_line INTEGER CHECK (start_line IS NULL OR start_line >= 1),
    end_line INTEGER CHECK (end_line IS NULL OR end_line >= start_line),
    page_start INTEGER CHECK (page_start IS NULL OR page_start >= 1),
    page_end INTEGER CHECK (page_end IS NULL OR page_end >= page_start),
    token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
    token_estimator_version TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    invalidated_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    UNIQUE (source_version_id, ordinal),
    UNIQUE (source_version_id, content_sha256, start_byte, end_byte)
) STRICT;

CREATE INDEX source_chunks_version_idx
    ON source_chunks(source_version_id, ordinal);
CREATE INDEX source_chunks_hash_idx
    ON source_chunks(content_sha256);

CREATE TABLE index_jobs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    workspace_grant_id TEXT REFERENCES workspace_grants(id) ON DELETE RESTRICT,
    attachment_ingestion_id TEXT REFERENCES attachment_ingestions(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'complete', 'failed', 'cancelled', 'invalidated')
    ),
    indexer_version TEXT NOT NULL,
    options_sha256 TEXT NOT NULL CHECK (length(options_sha256) = 64),
    snapshot_sha256 TEXT CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64),
    error_code TEXT,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    invalidated_at_ms INTEGER,
    stats_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json)),
    CHECK (
        (workspace_grant_id IS NOT NULL AND attachment_ingestion_id IS NULL)
        OR
        (workspace_grant_id IS NULL AND attachment_ingestion_id IS NOT NULL)
    )
) STRICT;

CREATE INDEX index_jobs_project_idx
    ON index_jobs(project_id, state, created_at_ms DESC);
CREATE INDEX index_jobs_grant_idx
    ON index_jobs(workspace_grant_id, state);

CREATE TABLE index_diagnostics (
    job_id TEXT NOT NULL REFERENCES index_jobs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    code TEXT NOT NULL,
    source_id TEXT REFERENCES indexed_sources(id) ON DELETE SET NULL,
    detail_blob_id TEXT REFERENCES blob_objects(id) ON DELETE RESTRICT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (job_id, ordinal)
) WITHOUT ROWID, STRICT;

CREATE TABLE retrieval_snapshots (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
    query_sha256 TEXT NOT NULL CHECK (length(query_sha256) = 64),
    retriever_version TEXT NOT NULL,
    token_budget INTEGER NOT NULL CHECK (token_budget > 0),
    consumed_tokens INTEGER NOT NULL DEFAULT 0 CHECK (
        consumed_tokens >= 0 AND consumed_tokens <= token_budget
    ),
    state TEXT NOT NULL CHECK (state IN ('building', 'frozen', 'failed', 'invalidated')),
    snapshot_sha256 TEXT CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64),
    created_at_ms INTEGER NOT NULL,
    frozen_at_ms INTEGER,
    invalidated_at_ms INTEGER,
    stats_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json)),
    CHECK (
        (state = 'frozen' AND frozen_at_ms IS NOT NULL AND snapshot_sha256 IS NOT NULL)
        OR state <> 'frozen'
    ),
    CHECK ((state = 'invalidated') = (invalidated_at_ms IS NOT NULL))
) STRICT;

CREATE INDEX retrieval_snapshots_project_idx
    ON retrieval_snapshots(project_id, created_at_ms DESC);
CREATE INDEX retrieval_snapshots_run_idx ON retrieval_snapshots(run_id);

CREATE TABLE retrieval_snapshot_items (
    snapshot_id TEXT NOT NULL REFERENCES retrieval_snapshots(id) ON DELETE CASCADE,
    source_chunk_id TEXT NOT NULL REFERENCES source_chunks(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    disposition TEXT NOT NULL CHECK (disposition IN ('selected', 'omitted')),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
    rank INTEGER CHECK (rank IS NULL OR rank >= 1),
    score_ppm INTEGER CHECK (score_ppm IS NULL OR score_ppm BETWEEN 0 AND 1000000),
    token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
    chunk_content_sha256 TEXT NOT NULL CHECK (length(chunk_content_sha256) = 64),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, ordinal),
    UNIQUE (snapshot_id, source_chunk_id),
    CHECK (
        (disposition = 'selected' AND rank IS NOT NULL)
        OR (disposition = 'omitted' AND rank IS NULL)
    )
) WITHOUT ROWID, STRICT;

CREATE INDEX retrieval_snapshot_items_chunk_idx
    ON retrieval_snapshot_items(source_chunk_id, snapshot_id);

CREATE TABLE context_snapshots (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE REFERENCES generations(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    compiler_version TEXT NOT NULL,
    token_budget INTEGER NOT NULL CHECK (token_budget > 0),
    consumed_tokens INTEGER NOT NULL CHECK (
        consumed_tokens >= 0 AND consumed_tokens <= token_budget
    ),
    state TEXT NOT NULL CHECK (state IN ('building', 'frozen', 'failed')),
    snapshot_sha256 TEXT CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64),
    created_at_ms INTEGER NOT NULL,
    frozen_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK (
        (state = 'frozen' AND frozen_at_ms IS NOT NULL AND snapshot_sha256 IS NOT NULL)
        OR state <> 'frozen'
    )
) STRICT;

CREATE INDEX context_snapshots_conversation_idx
    ON context_snapshots(conversation_id, created_at_ms DESC);

CREATE TABLE context_snapshot_items (
    snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    item_kind TEXT NOT NULL CHECK (
        item_kind IN ('system', 'developer', 'message', 'retrieval', 'memory', 'skill', 'tool')
    ),
    item_ref TEXT,
    retrieval_snapshot_id TEXT REFERENCES retrieval_snapshots(id) ON DELETE RESTRICT,
    source_chunk_id TEXT REFERENCES source_chunks(id) ON DELETE RESTRICT,
    content_blob_id TEXT REFERENCES blob_objects(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
    disposition TEXT NOT NULL CHECK (disposition IN ('selected', 'omitted')),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
    created_at_ms INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    PRIMARY KEY (snapshot_id, ordinal),
    UNIQUE (snapshot_id, ordinal, source_chunk_id),
    CHECK (
        (item_kind = 'retrieval' AND retrieval_snapshot_id IS NOT NULL
                                 AND source_chunk_id IS NOT NULL)
        OR item_kind <> 'retrieval'
    )
) WITHOUT ROWID, STRICT;

CREATE INDEX context_snapshot_items_chunk_idx
    ON context_snapshot_items(source_chunk_id, snapshot_id);

CREATE TABLE citations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(id) ON DELETE CASCADE,
    context_item_ordinal INTEGER NOT NULL CHECK (context_item_ordinal >= 0),
    source_chunk_id TEXT NOT NULL REFERENCES source_chunks(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    claim_start_byte INTEGER NOT NULL CHECK (claim_start_byte >= 0),
    claim_end_byte INTEGER NOT NULL CHECK (claim_end_byte > claim_start_byte),
    source_start_byte INTEGER NOT NULL CHECK (source_start_byte >= 0),
    source_end_byte INTEGER NOT NULL CHECK (source_end_byte > source_start_byte),
    source_content_sha256 TEXT NOT NULL CHECK (length(source_content_sha256) = 64),
    quoted_text_blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    quoted_text_sha256 TEXT NOT NULL CHECK (length(quoted_text_sha256) = 64),
    validation_state TEXT NOT NULL CHECK (
        validation_state IN ('supported', 'unsupported', 'stale', 'unverified')
    ),
    created_at_ms INTEGER NOT NULL,
    validated_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    UNIQUE (run_id, ordinal)
) STRICT;

CREATE INDEX citations_message_idx ON citations(assistant_message_id, ordinal);
CREATE INDEX citations_source_idx ON citations(source_chunk_id);

CREATE TRIGGER citations_context_guard_insert
BEFORE INSERT ON citations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM context_snapshots cs
        JOIN context_snapshot_items csi
          ON csi.snapshot_id = cs.id
         AND csi.ordinal = NEW.context_item_ordinal
        WHERE cs.id = NEW.context_snapshot_id
          AND cs.run_id = NEW.run_id
          AND cs.state = 'frozen'
          AND csi.disposition = 'selected'
          AND csi.source_chunk_id = NEW.source_chunk_id
    ) THEN RAISE(ABORT, 'citation source must be selected in frozen context') END;
END;

CREATE TRIGGER citations_context_guard_update
BEFORE UPDATE OF run_id, context_snapshot_id, context_item_ordinal, source_chunk_id ON citations
BEGIN
    SELECT RAISE(ABORT, 'citation provenance is immutable');
END;

CREATE TRIGGER citations_run_message_guard_insert
BEFORE INSERT ON citations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM generations g
        WHERE g.id = NEW.run_id
          AND g.assistant_message_id = NEW.assistant_message_id
    ) THEN RAISE(ABORT, 'citation message must be produced by run') END;
END;

CREATE TRIGGER citations_run_message_guard_update
BEFORE UPDATE OF assistant_message_id ON citations
BEGIN
    SELECT RAISE(ABORT, 'citation provenance is immutable');
END;

CREATE TRIGGER citations_context_item_update_guard
BEFORE UPDATE ON context_snapshot_items
WHEN EXISTS (
    SELECT 1
    FROM citations c
    WHERE c.context_snapshot_id = OLD.snapshot_id
      AND c.context_item_ordinal = OLD.ordinal
)
BEGIN
    SELECT RAISE(ABORT, 'cited context item is immutable');
END;

CREATE TRIGGER citations_context_item_delete_guard
BEFORE DELETE ON context_snapshot_items
WHEN EXISTS (
    SELECT 1
    FROM citations c
    WHERE c.context_snapshot_id = OLD.snapshot_id
      AND c.context_item_ordinal = OLD.ordinal
)
BEGIN
    SELECT RAISE(ABORT, 'cited context item is immutable');
END;

CREATE TRIGGER context_snapshot_items_frozen_insert_guard
BEFORE INSERT ON context_snapshot_items
WHEN EXISTS (
    SELECT 1 FROM context_snapshots cs
    WHERE cs.id = NEW.snapshot_id AND cs.state = 'frozen'
)
BEGIN
    SELECT RAISE(ABORT, 'frozen context cannot accept new items');
END;

CREATE TRIGGER context_snapshot_items_frozen_update_guard
BEFORE UPDATE ON context_snapshot_items
WHEN EXISTS (
    SELECT 1 FROM context_snapshots cs
    WHERE cs.id = OLD.snapshot_id AND cs.state = 'frozen'
)
BEGIN
    SELECT RAISE(ABORT, 'frozen context items are immutable');
END;

CREATE TRIGGER context_snapshot_items_frozen_delete_guard
BEFORE DELETE ON context_snapshot_items
WHEN EXISTS (
    SELECT 1 FROM context_snapshots cs
    WHERE cs.id = OLD.snapshot_id AND cs.state = 'frozen'
)
BEGIN
    SELECT RAISE(ABORT, 'frozen context items are immutable');
END;

CREATE TRIGGER workspace_grants_invalidate_derived_data
AFTER UPDATE OF revoked_at_ms ON workspace_grants
WHEN OLD.revoked_at_ms IS NULL AND NEW.revoked_at_ms IS NOT NULL
BEGIN
    UPDATE indexed_sources
       SET state = 'revoked', invalidated_at_ms = NEW.revoked_at_ms,
           updated_at_ms = NEW.revoked_at_ms
     WHERE workspace_grant_id = NEW.id AND state = 'active';

    UPDATE source_versions
       SET invalidated_at_ms = NEW.revoked_at_ms
     WHERE invalidated_at_ms IS NULL
       AND source_id IN (
           SELECT id FROM indexed_sources WHERE workspace_grant_id = NEW.id
       );

    UPDATE source_chunks
       SET invalidated_at_ms = NEW.revoked_at_ms
     WHERE invalidated_at_ms IS NULL
       AND source_version_id IN (
           SELECT sv.id
           FROM source_versions sv
           JOIN indexed_sources s ON s.id = sv.source_id
           WHERE s.workspace_grant_id = NEW.id
       );

    UPDATE index_jobs
       SET state = 'invalidated', invalidated_at_ms = NEW.revoked_at_ms,
           completed_at_ms = COALESCE(completed_at_ms, NEW.revoked_at_ms)
     WHERE workspace_grant_id = NEW.id AND state <> 'invalidated';

    UPDATE retrieval_snapshots
       SET state = 'invalidated', invalidated_at_ms = NEW.revoked_at_ms
     WHERE state <> 'invalidated'
       AND id IN (
           SELECT DISTINCT rsi.snapshot_id
           FROM retrieval_snapshot_items rsi
           JOIN source_chunks sc ON sc.id = rsi.source_chunk_id
           JOIN source_versions sv ON sv.id = sc.source_version_id
           JOIN indexed_sources s ON s.id = sv.source_id
           WHERE s.workspace_grant_id = NEW.id
       );
END;

-- Omnia schema v4: durable attachment drafts and exact-one-owner attachment
-- rows. Keep this marker stable: the native migrator executes the SQL below
-- it only after validating the v3 attachment population. It rebuilds the
-- attachment table inside one transaction so the exact-one-owner invariant is
-- represented by a real table CHECK, not only by repository convention.

CREATE TABLE attachment_drafts (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'bound', 'abandoned', 'expired')),
    expires_at_ms INTEGER NOT NULL,
    binding_key TEXT,
    bound_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
    bound_run_id TEXT REFERENCES generations(id) ON DELETE RESTRICT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    bound_at_ms INTEGER,
    abandoned_at_ms INTEGER,
    expired_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK (project_id IS NOT NULL OR conversation_id IS NOT NULL),
    CHECK (branch_id IS NULL OR conversation_id IS NOT NULL),
    CHECK (expires_at_ms > created_at_ms),
    CHECK (
        (state = 'open'
            AND binding_key IS NULL
            AND bound_message_id IS NULL
            AND bound_run_id IS NULL
            AND bound_at_ms IS NULL
            AND abandoned_at_ms IS NULL
            AND expired_at_ms IS NULL)
        OR
        (state = 'bound'
            AND binding_key IS NOT NULL
            AND length(binding_key) BETWEEN 1 AND 256
            AND bound_message_id IS NOT NULL
            AND bound_run_id IS NOT NULL
            AND bound_at_ms IS NOT NULL
            AND abandoned_at_ms IS NULL
            AND expired_at_ms IS NULL)
        OR
        (state = 'abandoned'
            AND binding_key IS NULL
            AND bound_message_id IS NULL
            AND bound_run_id IS NULL
            AND bound_at_ms IS NULL
            AND abandoned_at_ms IS NOT NULL
            AND expired_at_ms IS NULL)
        OR
        (state = 'expired'
            AND binding_key IS NULL
            AND bound_message_id IS NULL
            AND bound_run_id IS NULL
            AND bound_at_ms IS NULL
            AND abandoned_at_ms IS NULL
            AND expired_at_ms IS NOT NULL)
    ),
    CHECK (bound_at_ms IS NULL OR bound_at_ms >= created_at_ms),
    CHECK (abandoned_at_ms IS NULL OR abandoned_at_ms >= created_at_ms),
    CHECK (expired_at_ms IS NULL OR expired_at_ms >= expires_at_ms)
) STRICT;

CREATE INDEX attachment_drafts_conversation_idx
    ON attachment_drafts(conversation_id, branch_id, state, created_at_ms);
CREATE INDEX attachment_drafts_project_idx
    ON attachment_drafts(project_id, state, created_at_ms);
CREATE INDEX attachment_drafts_expiry_idx
    ON attachment_drafts(profile_id, state, expires_at_ms);
CREATE UNIQUE INDEX attachment_drafts_binding_key_idx
    ON attachment_drafts(profile_id, binding_key)
    WHERE binding_key IS NOT NULL;

CREATE TABLE attachments_v4 (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    draft_id TEXT REFERENCES attachment_drafts(id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL REFERENCES blob_objects(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
    extracted_text_blob_id TEXT REFERENCES blob_objects(id) ON DELETE SET NULL,
    created_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    CHECK (
        (draft_id IS NOT NULL) +
        (message_id IS NOT NULL) +
        (project_id IS NOT NULL) = 1
    )
) STRICT;

INSERT INTO attachments_v4 (
    id, profile_id, draft_id, message_id, project_id, blob_id, filename,
    media_type, byte_size, extraction_status, extracted_text_blob_id,
    created_at_ms, deleted_at_ms, metadata_json
)
SELECT
    id, profile_id, NULL, message_id, project_id, blob_id, filename,
    media_type, byte_size, extraction_status, extracted_text_blob_id,
    created_at_ms, deleted_at_ms, metadata_json
FROM attachments;

DROP TABLE attachments;
ALTER TABLE attachments_v4 RENAME TO attachments;

CREATE INDEX attachments_draft_idx ON attachments(draft_id, deleted_at_ms);
CREATE INDEX attachments_message_idx ON attachments(message_id, deleted_at_ms);
CREATE INDEX attachments_project_idx ON attachments(project_id, deleted_at_ms);

CREATE TRIGGER attachment_drafts_scope_guard_insert
BEFORE INSERT ON attachment_drafts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles p
        WHERE p.id = NEW.profile_id AND p.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft profile is unavailable') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = NEW.project_id
          AND p.profile_id = NEW.profile_id
          AND p.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft project must belong to profile') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = NEW.conversation_id
          AND c.profile_id = NEW.profile_id
          AND c.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR c.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'attachment draft conversation must match profile and project') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches b
        WHERE b.id = NEW.branch_id
          AND b.conversation_id = NEW.conversation_id
          AND b.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft branch must belong to conversation') END;
    SELECT CASE WHEN NEW.state = 'bound' AND NOT EXISTS (
        SELECT 1
        FROM messages m
        JOIN generations g ON g.id = NEW.bound_run_id
        WHERE m.id = NEW.bound_message_id
          AND m.role = 'user'
          AND m.conversation_id = NEW.conversation_id
          AND m.branch_id = NEW.branch_id
          AND g.conversation_id = NEW.conversation_id
          AND g.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'attachment draft binding must match message and run scope') END;
END;

CREATE TRIGGER attachment_drafts_scope_guard_update
BEFORE UPDATE OF profile_id, project_id, conversation_id, branch_id,
                 state, binding_key, bound_message_id, bound_run_id ON attachment_drafts
BEGIN
    SELECT CASE WHEN OLD.state <> 'open'
        THEN RAISE(ABORT, 'terminal attachment draft is immutable') END;
    SELECT CASE WHEN NEW.profile_id <> OLD.profile_id
        THEN RAISE(ABORT, 'attachment draft profile is immutable') END;
    SELECT CASE WHEN NEW.project_id IS NOT OLD.project_id
                       OR NEW.conversation_id IS NOT OLD.conversation_id
                       OR NEW.branch_id IS NOT OLD.branch_id
        THEN RAISE(ABORT, 'attachment draft scope is immutable') END;
    SELECT CASE WHEN NEW.state = 'bound' AND NOT EXISTS (
        SELECT 1
        FROM messages m
        JOIN generations g ON g.id = NEW.bound_run_id
        WHERE m.id = NEW.bound_message_id
          AND m.role = 'user'
          AND m.conversation_id = NEW.conversation_id
          AND m.branch_id = NEW.branch_id
          AND g.conversation_id = NEW.conversation_id
          AND g.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'attachment draft binding must match message and run scope') END;
END;

CREATE TRIGGER attachments_draft_owner_guard_insert
BEFORE INSERT ON attachments
WHEN NEW.draft_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM attachment_drafts d
        WHERE d.id = NEW.draft_id
          AND d.profile_id = NEW.profile_id
          AND d.state = 'open'
          AND d.expires_at_ms > NEW.created_at_ms
    ) THEN RAISE(ABORT, 'attachment draft owner must be live and match profile') END;
END;

CREATE TRIGGER attachments_draft_owner_guard_update
BEFORE UPDATE OF draft_id, message_id, project_id, profile_id ON attachments
WHEN NEW.draft_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM attachment_drafts d
        WHERE d.id = NEW.draft_id
          AND d.profile_id = NEW.profile_id
          AND d.state = 'open'
    ) THEN RAISE(ABORT, 'attachment draft owner must be open and match profile') END;
END;

CREATE TRIGGER attachments_message_owner_guard_insert
BEFORE INSERT ON attachments
WHEN NEW.message_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = NEW.message_id
          AND c.profile_id = NEW.profile_id
          AND c.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment message owner must match profile') END;
END;

CREATE TRIGGER attachments_message_owner_guard_update
BEFORE UPDATE OF draft_id, message_id, project_id, profile_id ON attachments
WHEN NEW.message_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = NEW.message_id
          AND c.profile_id = NEW.profile_id
          AND c.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment message owner must match profile') END;
END;

CREATE TRIGGER attachments_project_owner_guard_insert
BEFORE INSERT ON attachments
WHEN NEW.project_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = NEW.project_id
          AND p.profile_id = NEW.profile_id
          AND p.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment project owner must match profile') END;
END;

CREATE TRIGGER attachments_project_owner_guard_update
BEFORE UPDATE OF draft_id, message_id, project_id, profile_id ON attachments
WHEN NEW.project_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = NEW.project_id
          AND p.profile_id = NEW.profile_id
          AND p.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment project owner must match profile') END;
END;

-- Omnia schema v5: immutable native-owned prepared provider inputs.
-- Keep this marker stable: the native migrator executes only the SQL below it for a
-- transactional v4 -> v5 migration. Renderer dispatch receives only the input
-- and attempt IDs; messages and parameters remain native-owned.

CREATE TABLE frozen_provider_inputs (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    attempt_id TEXT NOT NULL UNIQUE
        REFERENCES run_attempts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL
        REFERENCES generations(id) ON DELETE CASCADE,
    provider_profile_id TEXT NOT NULL
        REFERENCES provider_profiles(id) ON DELETE RESTRICT,
    model_id TEXT NOT NULL,
    messages_json TEXT NOT NULL
        CHECK (json_valid(messages_json))
        CHECK (json_type(messages_json) = 'array'),
    parameters_json TEXT NOT NULL
        CHECK (json_valid(parameters_json))
        CHECK (json_type(parameters_json) = 'object'),
    content_sha256 TEXT NOT NULL
        CHECK (length(content_sha256) = 64)
        CHECK (content_sha256 = lower(content_sha256)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    dispatch_started_at_ms INTEGER,
    CHECK (dispatch_started_at_ms IS NULL OR dispatch_started_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX frozen_provider_inputs_run_idx
    ON frozen_provider_inputs(run_id, created_at_ms);

CREATE TRIGGER frozen_provider_inputs_scope_guard_insert
BEFORE INSERT ON frozen_provider_inputs
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM run_attempts a
        JOIN generations g ON g.id = a.generation_id
        JOIN provider_profiles p ON p.id = NEW.provider_profile_id
        WHERE a.id = NEW.attempt_id
          AND a.generation_id = NEW.run_id
          AND a.provider_profile_id = NEW.provider_profile_id
          AND a.model_id = NEW.model_id
          AND g.id = NEW.run_id
          AND g.provider_profile_id = NEW.provider_profile_id
          AND g.model_id = NEW.model_id
          AND p.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'frozen provider input must match its run attempt scope') END;
END;

CREATE TRIGGER frozen_provider_inputs_body_immutable
BEFORE UPDATE OF schema_version, attempt_id, run_id, provider_profile_id,
                 model_id, messages_json, parameters_json, content_sha256,
                 created_at_ms ON frozen_provider_inputs
BEGIN
    SELECT RAISE(ABORT, 'frozen provider input body is immutable');
END;

CREATE TRIGGER frozen_provider_inputs_dispatch_guard
BEFORE UPDATE OF dispatch_started_at_ms ON frozen_provider_inputs
BEGIN
    SELECT CASE WHEN OLD.dispatch_started_at_ms IS NOT NULL
        THEN RAISE(ABORT, 'frozen provider input was already dispatched') END;
    SELECT CASE WHEN NEW.dispatch_started_at_ms IS NULL
        THEN RAISE(ABORT, 'frozen provider dispatch timestamp cannot be cleared') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM run_attempts a
        JOIN generations g ON g.id = a.generation_id
        WHERE a.id = OLD.attempt_id
          AND a.generation_id = OLD.run_id
          AND a.state = 'dispatching'
          AND g.id = OLD.run_id
          AND g.state = 'running'
    ) THEN RAISE(ABORT, 'frozen provider input dispatch requires an active attempt') END;
END;

-- Omnia schema v6: attachment binding lineage, immutable receipts, and lifecycle hardening.
-- Keep this marker stable. The native v5 -> v6 migrator validates every legacy
-- owner, draft scope, live binding lineage, and recoverable bound attachment
-- before executing this section. A conflict aborts the whole migration rather
-- than inventing attachment provenance.

CREATE TABLE attachment_binding_receipts (
    draft_id TEXT NOT NULL
        REFERENCES attachment_drafts(id) ON DELETE RESTRICT,
    attachment_id TEXT NOT NULL
        REFERENCES attachments(id) ON DELETE RESTRICT,
    profile_id TEXT NOT NULL
        REFERENCES app_profiles(id) ON DELETE RESTRICT,
    project_id TEXT
        REFERENCES projects(id) ON DELETE RESTRICT,
    conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE RESTRICT,
    branch_id TEXT NOT NULL
        REFERENCES conversation_branches(id) ON DELETE RESTRICT,
    message_id TEXT NOT NULL
        REFERENCES messages(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL
        REFERENCES generations(id) ON DELETE RESTRICT,
    binding_key TEXT NOT NULL CHECK (length(binding_key) BETWEEN 1 AND 256),
    attachment_blob_id TEXT NOT NULL
        REFERENCES blob_objects(id) ON DELETE RESTRICT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (draft_id, attachment_id),
    UNIQUE (attachment_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX attachment_binding_receipts_run_idx
    ON attachment_binding_receipts(run_id, message_id, created_at_ms);

-- A v5 bound row is migratable only when the native preflight proved that its
-- still-draft-owned live attachments are sufficient to preserve exact
-- provenance. Already re-homed legacy attachments cannot be attributed to a
-- draft without guessing, so the migration rejects those databases.
INSERT INTO attachment_binding_receipts (
    draft_id, attachment_id, profile_id, project_id, conversation_id,
    branch_id, message_id, run_id, binding_key, attachment_blob_id,
    created_at_ms
)
SELECT
    d.id, a.id, d.profile_id, d.project_id, d.conversation_id,
    d.branch_id, d.bound_message_id, d.bound_run_id, d.binding_key,
    a.blob_id, d.bound_at_ms
FROM attachment_drafts d
JOIN attachments a
  ON a.draft_id = d.id
 AND a.profile_id = d.profile_id
 AND a.deleted_at_ms IS NULL
WHERE d.state = 'bound';

DROP TRIGGER attachment_drafts_scope_guard_insert;
DROP TRIGGER attachment_drafts_scope_guard_update;
DROP TRIGGER attachments_draft_owner_guard_insert;
DROP TRIGGER attachments_draft_owner_guard_update;
DROP TRIGGER attachments_message_owner_guard_insert;
DROP TRIGGER attachments_message_owner_guard_update;
DROP TRIGGER attachments_project_owner_guard_insert;
DROP TRIGGER attachments_project_owner_guard_update;

CREATE TRIGGER attachment_drafts_v6_insert_guard
BEFORE INSERT ON attachment_drafts
BEGIN
    SELECT CASE WHEN NEW.state <> 'open'
        THEN RAISE(ABORT, 'attachment draft must be created open') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles profile
        WHERE profile.id = NEW.profile_id
          AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft profile is unavailable') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft project must belong to profile') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.project_id IS NEW.project_id
          AND conversation.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft conversation must match captured scope') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft branch must belong to conversation') END;
END;

CREATE TRIGGER attachment_drafts_v6_update_guard
BEFORE UPDATE ON attachment_drafts
BEGIN
    SELECT CASE WHEN OLD.state <> 'open'
        THEN RAISE(ABORT, 'terminal attachment draft is immutable') END;
    SELECT CASE WHEN NEW.id <> OLD.id
                       OR NEW.profile_id <> OLD.profile_id
                       OR NEW.project_id IS NOT OLD.project_id
                       OR NEW.conversation_id IS NOT OLD.conversation_id
                       OR NEW.branch_id IS NOT OLD.branch_id
                       OR NEW.created_at_ms <> OLD.created_at_ms
        THEN RAISE(ABORT, 'attachment draft identity and scope are immutable') END;
    SELECT CASE WHEN NEW.updated_at_ms < OLD.updated_at_ms
        THEN RAISE(ABORT, 'attachment draft timestamp cannot move backwards') END;
    SELECT CASE WHEN NEW.state <> 'open'
                       AND (NEW.expires_at_ms <> OLD.expires_at_ms
                            OR NEW.metadata_json <> OLD.metadata_json)
        THEN RAISE(ABORT, 'attachment draft terminal transition cannot rewrite captured data') END;
    SELECT CASE WHEN NEW.state = 'bound'
                       AND (NEW.bound_at_ms >= OLD.expires_at_ms
                            OR NEW.updated_at_ms <> NEW.bound_at_ms)
        THEN RAISE(ABORT, 'attachment draft must bind before expiry') END;
    SELECT CASE WHEN NEW.state = 'abandoned'
                       AND NEW.updated_at_ms <> NEW.abandoned_at_ms
        THEN RAISE(ABORT, 'attachment draft abandonment timestamp is invalid') END;
    SELECT CASE WHEN NEW.state = 'expired'
                       AND NEW.updated_at_ms <> NEW.expired_at_ms
        THEN RAISE(ABORT, 'attachment draft expiry timestamp is invalid') END;
    SELECT CASE WHEN NEW.state = 'bound' AND NOT EXISTS (
        SELECT 1
        FROM app_profiles profile
        JOIN conversations conversation
          ON conversation.id = NEW.conversation_id
         AND conversation.profile_id = NEW.profile_id
         AND conversation.project_id IS NEW.project_id
         AND conversation.deleted_at_ms IS NULL
        JOIN conversation_branches branch
          ON branch.id = NEW.branch_id
         AND branch.conversation_id = conversation.id
         AND branch.deleted_at_ms IS NULL
        JOIN messages user_message
          ON user_message.id = NEW.bound_message_id
         AND user_message.conversation_id = conversation.id
         AND user_message.branch_id = branch.id
         AND user_message.role = 'user'
         AND user_message.status = 'complete'
         AND user_message.finalized_at_ms IS NOT NULL
         AND user_message.deleted_at_ms IS NULL
        JOIN generations run
          ON run.id = NEW.bound_run_id
         AND run.conversation_id = conversation.id
         AND run.branch_id = branch.id
         AND run.state = 'queued'
         AND run.started_at_ms IS NULL
         AND run.completed_at_ms IS NULL
        JOIN messages assistant_message
          ON assistant_message.id = run.assistant_message_id
         AND assistant_message.conversation_id = conversation.id
         AND assistant_message.branch_id = branch.id
         AND assistant_message.parent_message_id = user_message.id
         AND assistant_message.role = 'assistant'
         AND assistant_message.status = 'draft'
         AND assistant_message.finalized_at_ms IS NULL
         AND assistant_message.deleted_at_ms IS NULL
        JOIN run_attempts attempt
          ON attempt.generation_id = run.id
         AND attempt.ordinal = 1
         AND attempt.state = 'created'
         AND attempt.accepted_by_provider = 'false'
         AND attempt.started_at_ms IS NULL
         AND attempt.completed_at_ms IS NULL
         AND attempt.provider_profile_id = run.provider_profile_id
         AND attempt.model_id = run.model_id
        JOIN frozen_provider_inputs frozen_input
          ON frozen_input.attempt_id = attempt.id
         AND frozen_input.run_id = run.id
         AND frozen_input.provider_profile_id = run.provider_profile_id
         AND frozen_input.model_id = run.model_id
         AND frozen_input.dispatch_started_at_ms IS NULL
        JOIN provider_profiles provider
          ON provider.id = run.provider_profile_id
         AND provider.profile_id = NEW.profile_id
         AND provider.enabled = 1
         AND provider.deleted_at_ms IS NULL
        LEFT JOIN projects project
          ON project.id = NEW.project_id
         AND project.profile_id = NEW.profile_id
         AND project.deleted_at_ms IS NULL
        WHERE profile.id = NEW.profile_id
          AND profile.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR project.id IS NOT NULL)
    ) THEN RAISE(ABORT, 'attachment draft binding lineage is not dispatchable') END;
    SELECT CASE WHEN NEW.state = 'bound' AND NOT EXISTS (
        SELECT 1 FROM attachments attachment
        WHERE attachment.draft_id = OLD.id
          AND attachment.profile_id = OLD.profile_id
          AND attachment.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment draft cannot bind without a live attachment') END;
END;

CREATE TRIGGER attachment_drafts_v6_bound_receipts
AFTER UPDATE OF state ON attachment_drafts
WHEN OLD.state = 'open' AND NEW.state = 'bound'
BEGIN
    INSERT INTO attachment_binding_receipts (
        draft_id, attachment_id, profile_id, project_id, conversation_id,
        branch_id, message_id, run_id, binding_key, attachment_blob_id,
        created_at_ms
    )
    SELECT
        NEW.id, attachment.id, NEW.profile_id, NEW.project_id,
        NEW.conversation_id, NEW.branch_id, NEW.bound_message_id,
        NEW.bound_run_id, NEW.binding_key, attachment.blob_id, NEW.bound_at_ms
    FROM attachments attachment
    WHERE attachment.draft_id = NEW.id
      AND attachment.profile_id = NEW.profile_id
      AND attachment.deleted_at_ms IS NULL;
END;

CREATE TRIGGER attachment_drafts_v6_bound_delete_guard
BEFORE DELETE ON attachment_drafts
WHEN OLD.state = 'bound'
BEGIN
    SELECT RAISE(ABORT, 'bound attachment provenance cannot be deleted');
END;

CREATE TRIGGER attachment_binding_receipts_insert_guard
BEFORE INSERT ON attachment_binding_receipts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM attachment_drafts draft
        JOIN attachments attachment
          ON attachment.id = NEW.attachment_id
         AND attachment.draft_id = draft.id
         AND attachment.profile_id = draft.profile_id
         AND attachment.blob_id = NEW.attachment_blob_id
         AND attachment.deleted_at_ms IS NULL
        WHERE draft.id = NEW.draft_id
          AND draft.state = 'bound'
          AND draft.profile_id = NEW.profile_id
          AND draft.project_id IS NEW.project_id
          AND draft.conversation_id = NEW.conversation_id
          AND draft.branch_id = NEW.branch_id
          AND draft.bound_message_id = NEW.message_id
          AND draft.bound_run_id = NEW.run_id
          AND draft.binding_key = NEW.binding_key
          AND draft.bound_at_ms = NEW.created_at_ms
    ) THEN RAISE(ABORT, 'attachment binding receipt does not match bound draft provenance') END;
END;

CREATE TRIGGER attachment_binding_receipts_immutable
BEFORE UPDATE ON attachment_binding_receipts
BEGIN
    SELECT RAISE(ABORT, 'attachment binding receipt is immutable');
END;

CREATE TRIGGER attachment_binding_receipts_delete_guard
BEFORE DELETE ON attachment_binding_receipts
BEGIN
    SELECT RAISE(ABORT, 'attachment binding receipt cannot be deleted');
END;

CREATE TRIGGER attachments_v6_owner_guard_insert
BEFORE INSERT ON attachments
BEGIN
    SELECT CASE WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM attachment_drafts draft
        JOIN app_profiles profile
          ON profile.id = draft.profile_id
         AND profile.deleted_at_ms IS NULL
        LEFT JOIN projects project
          ON project.id = draft.project_id
         AND project.profile_id = draft.profile_id
         AND project.deleted_at_ms IS NULL
        LEFT JOIN conversations conversation
          ON conversation.id = draft.conversation_id
         AND conversation.profile_id = draft.profile_id
         AND conversation.project_id IS draft.project_id
         AND conversation.deleted_at_ms IS NULL
        LEFT JOIN conversation_branches branch
          ON branch.id = draft.branch_id
         AND branch.conversation_id = draft.conversation_id
         AND branch.deleted_at_ms IS NULL
        WHERE draft.id = NEW.draft_id
          AND draft.profile_id = NEW.profile_id
          AND draft.state = 'open'
          AND draft.expires_at_ms > NEW.created_at_ms
          AND (draft.project_id IS NULL OR project.id IS NOT NULL)
          AND (draft.conversation_id IS NULL OR conversation.id IS NOT NULL)
          AND (draft.branch_id IS NULL OR branch.id IS NOT NULL)
    ) THEN RAISE(ABORT, 'attachment draft owner must be live and match captured scope') END;
    SELECT CASE WHEN NEW.message_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM messages message
        JOIN conversations conversation
          ON conversation.id = message.conversation_id
         AND conversation.profile_id = NEW.profile_id
         AND conversation.deleted_at_ms IS NULL
        JOIN app_profiles profile
          ON profile.id = conversation.profile_id
         AND profile.deleted_at_ms IS NULL
        WHERE message.id = NEW.message_id
          AND message.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment message owner must be live and match profile') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        JOIN app_profiles profile
          ON profile.id = project.profile_id
         AND profile.deleted_at_ms IS NULL
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment project owner must be live and match profile') END;
END;

CREATE TRIGGER attachments_v6_owner_guard_update
BEFORE UPDATE OF draft_id, message_id, project_id, profile_id ON attachments
BEGIN
    SELECT CASE WHEN NEW.profile_id <> OLD.profile_id
        THEN RAISE(ABORT, 'attachment profile is immutable') END;
    SELECT CASE WHEN NEW.draft_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM attachment_drafts draft
        JOIN app_profiles profile
          ON profile.id = draft.profile_id
         AND profile.deleted_at_ms IS NULL
        LEFT JOIN projects project
          ON project.id = draft.project_id
         AND project.profile_id = draft.profile_id
         AND project.deleted_at_ms IS NULL
        LEFT JOIN conversations conversation
          ON conversation.id = draft.conversation_id
         AND conversation.profile_id = draft.profile_id
         AND conversation.project_id IS draft.project_id
         AND conversation.deleted_at_ms IS NULL
        LEFT JOIN conversation_branches branch
          ON branch.id = draft.branch_id
         AND branch.conversation_id = draft.conversation_id
         AND branch.deleted_at_ms IS NULL
        WHERE draft.id = NEW.draft_id
          AND draft.profile_id = NEW.profile_id
          AND draft.state = 'open'
          AND (draft.project_id IS NULL OR project.id IS NOT NULL)
          AND (draft.conversation_id IS NULL OR conversation.id IS NOT NULL)
          AND (draft.branch_id IS NULL OR branch.id IS NOT NULL)
    ) THEN RAISE(ABORT, 'attachment draft owner must be open and match captured scope') END;
    SELECT CASE WHEN NEW.message_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM messages message
        JOIN conversations conversation
          ON conversation.id = message.conversation_id
         AND conversation.profile_id = NEW.profile_id
         AND conversation.deleted_at_ms IS NULL
        JOIN app_profiles profile
          ON profile.id = conversation.profile_id
         AND profile.deleted_at_ms IS NULL
        WHERE message.id = NEW.message_id
          AND message.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment message owner must be live and match profile') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        JOIN app_profiles profile
          ON profile.id = project.profile_id
         AND profile.deleted_at_ms IS NULL
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'attachment project owner must be live and match profile') END;
END;

CREATE TRIGGER attachments_v6_draft_rehome_guard
BEFORE UPDATE OF draft_id, message_id, project_id ON attachments
WHEN OLD.draft_id IS NOT NULL
     AND (NEW.draft_id IS NOT OLD.draft_id
          OR NEW.message_id IS NOT OLD.message_id
          OR NEW.project_id IS NOT OLD.project_id)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM attachment_binding_receipts receipt
        WHERE receipt.attachment_id = OLD.id
          AND receipt.draft_id = OLD.draft_id
          AND receipt.profile_id = NEW.profile_id
          AND receipt.message_id = NEW.message_id
          AND receipt.attachment_blob_id = NEW.blob_id
          AND NEW.draft_id IS NULL
          AND NEW.project_id IS NULL
    ) THEN RAISE(ABORT, 'draft attachment can only re-home through its bound receipt') END;
END;

CREATE TRIGGER attachments_v6_bound_owner_immutable
BEFORE UPDATE OF draft_id, message_id, project_id, profile_id, blob_id ON attachments
WHEN EXISTS (
    SELECT 1 FROM attachment_binding_receipts receipt
    WHERE receipt.attachment_id = OLD.id
)
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM attachment_binding_receipts receipt
        WHERE receipt.attachment_id = OLD.id
          AND receipt.profile_id = NEW.profile_id
          AND receipt.message_id = NEW.message_id
          AND receipt.attachment_blob_id = NEW.blob_id
          AND NEW.draft_id IS NULL
          AND NEW.project_id IS NULL
    ) THEN RAISE(ABORT, 'bound attachment ownership is immutable') END;
END;

CREATE TRIGGER attachments_v6_bound_delete_guard
BEFORE DELETE ON attachments
WHEN EXISTS (
    SELECT 1 FROM attachment_binding_receipts receipt
    WHERE receipt.attachment_id = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, 'bound attachment provenance cannot be deleted');
END;

-- Omnia schema v7: durable native run journals and cursor replay.
-- Keep this marker stable. Existing runs are deliberately classified as
-- legacy-partial during migration; the migrator does not fabricate provider
-- deltas, usage, reasoning, or terminal facts from materialized projections.

CREATE TABLE run_journals (
    run_id TEXT PRIMARY KEY
        REFERENCES generations(id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    journal_epoch TEXT NOT NULL UNIQUE,
    coverage TEXT NOT NULL
        CHECK (coverage IN ('complete', 'legacy-partial', 'recovered-partial')),
    coverage_reason TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    CHECK (
        (coverage = 'complete' AND coverage_reason IS NULL)
        OR (coverage <> 'complete' AND coverage_reason IS NOT NULL)
    )
) STRICT;

CREATE TABLE run_events (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    run_id TEXT NOT NULL
        REFERENCES run_journals(run_id) ON DELETE CASCADE,
    attempt_id TEXT
        REFERENCES run_attempts(id) ON DELETE CASCADE,
    frozen_provider_input_id TEXT
        REFERENCES frozen_provider_inputs(id) ON DELETE CASCADE,
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'run.created', 'run.dispatching', 'run.started',
            'run.completed', 'run.cancelled', 'run.failed', 'run.recovered',
            'attempt.created', 'attempt.dispatch_started', 'attempt.accepted',
            'attempt.completed', 'attempt.interrupted', 'attempt.failed',
            'attempt.outcome_unknown', 'message.text_delta',
            'message.reasoning_summary_delta', 'usage.updated',
            'context.retrieval_receipt'
        )
    ),
    source TEXT NOT NULL
        CHECK (source IN ('harness', 'provider', 'tool', 'user', 'memory', 'skill')),
    visibility TEXT NOT NULL
        CHECK (visibility IN ('user', 'inspector', 'diagnostic')),
    sensitivity TEXT NOT NULL
        CHECK (sensitivity IN ('normal', 'sensitive', 'secret_ref')),
    payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json))
        CHECK (length(CAST(payload_json AS BLOB)) <= 524288),
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
    committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms > 0),
    UNIQUE (run_id, sequence_no),
    UNIQUE (run_id, id),
    CHECK ((attempt_id IS NULL) = (frozen_provider_input_id IS NULL))
) STRICT;

CREATE INDEX run_events_replay_idx
    ON run_events(run_id, sequence_no);

CREATE UNIQUE INDEX run_events_one_terminal_per_run
    ON run_events(run_id)
    WHERE event_type IN ('run.completed', 'run.cancelled', 'run.failed');

CREATE TRIGGER run_journals_immutable
BEFORE UPDATE ON run_journals
BEGIN
    SELECT RAISE(ABORT, 'run journal metadata is immutable');
END;

CREATE TRIGGER run_journals_delete_guard
BEFORE DELETE ON run_journals
WHEN EXISTS (SELECT 1 FROM generations WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'live run journal cannot be deleted');
END;

CREATE TRIGGER run_events_append_only_update
BEFORE UPDATE ON run_events
BEGIN
    SELECT RAISE(ABORT, 'run event journal is append-only');
END;

CREATE TRIGGER run_events_append_only_delete
BEFORE DELETE ON run_events
WHEN EXISTS (SELECT 1 FROM run_journals WHERE run_id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'run event journal is append-only');
END;

CREATE TRIGGER run_events_scope_guard
BEFORE INSERT ON run_events
BEGIN
    SELECT CASE WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM run_attempts attempt
        JOIN frozen_provider_inputs frozen
          ON frozen.id = NEW.frozen_provider_input_id
         AND frozen.attempt_id = attempt.id
         AND frozen.run_id = attempt.generation_id
         AND frozen.provider_profile_id = attempt.provider_profile_id
         AND frozen.model_id = attempt.model_id
        JOIN generations run
          ON run.id = attempt.generation_id
         AND run.provider_profile_id = attempt.provider_profile_id
         AND run.model_id = attempt.model_id
        WHERE attempt.id = NEW.attempt_id
          AND attempt.generation_id = NEW.run_id
    ) THEN RAISE(ABORT, 'run event attempt and frozen input scope conflict') END;
END;

CREATE TRIGGER run_events_sequence_guard
BEFORE INSERT ON run_events
BEGIN
    SELECT CASE WHEN NEW.sequence_no <> (
        SELECT COALESCE(MAX(sequence_no), 0) + 1
        FROM run_events
        WHERE run_id = NEW.run_id
    ) THEN RAISE(ABORT, 'run event sequence must be gap-free') END;
END;

-- FTS is intentionally optional. It creates another plaintext/derived copy and
-- must only be enabled under the product's database-encryption/search policy.
-- CREATE VIRTUAL TABLE message_search USING fts5(
--     message_id UNINDEXED,
--     conversation_id UNINDEXED,
--     content_text,
--     tokenize = 'unicode61 remove_diacritics 2'
-- );

-- Omnia schema v8: local-first telemetry and the append-only usage ledger.
-- Keep this marker stable. Telemetry is content-free by construction: raw
-- prompts, responses, reasoning, credentials, paths, headers, and tool payloads
-- never belong in these tables. The native validator owns the bounded JSON
-- fields and lineage checks that SQLite cannot express safely.

CREATE TABLE run_timing_observations (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
    clock_domain_id TEXT NOT NULL CHECK (length(clock_domain_id) BETWEEN 1 AND 160),
    origin_at_ms INTEGER NOT NULL CHECK (origin_at_ms > 0),
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= origin_at_ms),
    coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'estimated', 'unknown')),
    dispatch_started_ms INTEGER NOT NULL CHECK (dispatch_started_ms >= 0),
    request_committed_ms INTEGER CHECK (request_committed_ms IS NULL OR request_committed_ms >= dispatch_started_ms),
    first_byte_ms INTEGER CHECK (first_byte_ms IS NULL OR first_byte_ms >= COALESCE(request_committed_ms, dispatch_started_ms)),
    first_provider_output_ms INTEGER CHECK (first_provider_output_ms IS NULL OR first_provider_output_ms >= COALESCE(first_byte_ms, dispatch_started_ms)),
    first_reasoning_ms INTEGER CHECK (first_reasoning_ms IS NULL OR first_reasoning_ms >= COALESCE(first_byte_ms, dispatch_started_ms)),
    first_visible_output_ms INTEGER CHECK (first_visible_output_ms IS NULL OR first_visible_output_ms >= COALESCE(first_byte_ms, dispatch_started_ms)),
    first_complete_item_ms INTEGER CHECK (first_complete_item_ms IS NULL OR first_complete_item_ms >= COALESCE(first_byte_ms, dispatch_started_ms)),
    last_visible_output_ms INTEGER CHECK (last_visible_output_ms IS NULL OR last_visible_output_ms >= COALESCE(first_visible_output_ms, dispatch_started_ms)),
    terminal_ms INTEGER CHECK (terminal_ms IS NULL OR terminal_ms >= dispatch_started_ms),
    queue_ms INTEGER CHECK (queue_ms IS NULL OR queue_ms >= 0),
    context_compile_ms INTEGER CHECK (context_compile_ms IS NULL OR context_compile_ms >= 0),
    approval_wait_ms INTEGER CHECK (approval_wait_ms IS NULL OR approval_wait_ms >= 0),
    provider_backoff_ms INTEGER CHECK (provider_backoff_ms IS NULL OR provider_backoff_ms >= 0),
    tool_wait_ms INTEGER CHECK (tool_wait_ms IS NULL OR tool_wait_ms >= 0),
    renderer_backpressure_ms INTEGER CHECK (renderer_backpressure_ms IS NULL OR renderer_backpressure_ms >= 0),
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX run_timing_observations_attempt_idx
    ON run_timing_observations(attempt_id, observed_at_ms, id);
CREATE INDEX run_timing_observations_run_idx
    ON run_timing_observations(run_id, observed_at_ms, id);

CREATE TABLE run_usage_ledger (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
    source TEXT NOT NULL CHECK (source IN ('local-estimate', 'provider-incremental', 'provider-final', 'provider-invoice', 'user-correction')),
    authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
    coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'estimated', 'unknown')),
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms > 0),
    response_identity_hash TEXT CHECK (response_identity_hash IS NULL OR length(response_identity_hash) = 64),
    fact_sha256 TEXT NOT NULL CHECK (length(fact_sha256) = 64),
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    cache_read_input_tokens INTEGER CHECK (cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0),
    cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    visible_output_tokens INTEGER CHECK (visible_output_tokens IS NULL OR visible_output_tokens >= 0),
    provider_counters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_counters_json)),
    supersedes_entry_id TEXT REFERENCES run_usage_ledger(id) ON DELETE RESTRICT,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (attempt_id, sequence_no)
) STRICT;

CREATE INDEX run_usage_ledger_attempt_idx
    ON run_usage_ledger(attempt_id, sequence_no);
CREATE INDEX run_usage_ledger_run_idx
    ON run_usage_ledger(run_id, sequence_no);
CREATE UNIQUE INDEX run_usage_ledger_provider_identity_idx
    ON run_usage_ledger(attempt_id, source, response_identity_hash)
    WHERE response_identity_hash IS NOT NULL;

CREATE TRIGGER run_usage_ledger_scope_guard_insert
BEFORE INSERT ON run_usage_ledger
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM run_attempts attempt
        JOIN generations run ON run.id = attempt.generation_id
        JOIN app_profiles profile ON profile.id = NEW.profile_id
        WHERE attempt.id = NEW.attempt_id
          AND attempt.generation_id = NEW.run_id
          AND run.provider_profile_id IS NOT NULL
          AND profile.id = NEW.profile_id
    ) THEN RAISE(ABORT, 'usage ledger lineage does not match run and attempt') END;
    SELECT CASE WHEN NEW.source IN ('provider-incremental', 'provider-final', 'provider-invoice')
                     AND NEW.response_identity_hash IS NULL
        THEN RAISE(ABORT, 'provider usage requires a response identity hash') END;
    SELECT CASE WHEN NEW.sequence_no <> (
        SELECT COALESCE(MAX(sequence_no), 0) + 1
        FROM run_usage_ledger
        WHERE attempt_id = NEW.attempt_id
    ) THEN RAISE(ABORT, 'usage ledger sequence must be gap-free') END;
END;

CREATE TABLE run_cost_statements (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    usage_entry_id TEXT NOT NULL REFERENCES run_usage_ledger(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('calculated-estimate', 'provider-reported', 'invoice', 'user-override')),
    component TEXT NOT NULL CHECK (length(component) BETWEEN 1 AND 160),
    amount_microunits INTEGER NOT NULL CHECK (amount_microunits >= 0),
    currency TEXT NOT NULL CHECK (length(currency) BETWEEN 3 AND 8),
    price_snapshot_id TEXT,
    price_snapshot_hash TEXT CHECK (price_snapshot_hash IS NULL OR length(price_snapshot_hash) = 64),
    formula_version TEXT,
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms > 0),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (usage_entry_id, kind, component, currency)
) STRICT;

CREATE INDEX run_cost_statements_attempt_idx
    ON run_cost_statements(attempt_id, observed_at_ms, id);

CREATE TRIGGER run_cost_statements_lineage_guard_insert
BEFORE INSERT ON run_cost_statements
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM run_usage_ledger usage
        WHERE usage.id = NEW.usage_entry_id
          AND usage.run_id = NEW.run_id
          AND usage.attempt_id = NEW.attempt_id
    ) THEN RAISE(ABORT, 'cost statement lineage does not match usage entry') END;
    SELECT CASE WHEN NEW.kind = 'calculated-estimate'
                     AND (NEW.price_snapshot_id IS NULL OR NEW.price_snapshot_hash IS NULL OR NEW.formula_version IS NULL)
        THEN RAISE(ABORT, 'calculated cost requires a frozen price snapshot and formula') END;
END;

CREATE TABLE provider_health_observations (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
    model_profile_id TEXT,
    dimension TEXT NOT NULL CHECK (dimension IN ('dns', 'tls', 'authentication', 'authorization', 'billing', 'catalog', 'transport', 'protocol', 'streaming', 'model', 'rate-limit')),
    outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'degraded', 'fail', 'unknown')),
    error_class TEXT,
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    diagnostic_code TEXT,
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms > 0),
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX provider_health_observations_provider_idx
    ON provider_health_observations(provider_profile_id, model_profile_id, observed_at_ms DESC);

CREATE TABLE provider_quota_windows (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    health_observation_id TEXT NOT NULL REFERENCES provider_health_observations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('requests', 'input-tokens', 'output-tokens', 'total-tokens', 'concurrency')),
    limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
    remaining_value INTEGER CHECK (remaining_value IS NULL OR remaining_value >= 0),
    reset_at_ms INTEGER,
    window_seconds INTEGER CHECK (window_seconds IS NULL OR window_seconds >= 0),
    source TEXT NOT NULL CHECK (source IN ('provider-header', 'provider-api', 'configured', 'inferred')),
    authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    CHECK (limit_value IS NULL OR remaining_value IS NULL OR remaining_value <= limit_value),
    CHECK (source <> 'inferred' OR authoritative = 0)
) STRICT;

CREATE INDEX provider_quota_windows_health_idx
    ON provider_quota_windows(health_observation_id, kind);

CREATE TABLE harness_operation_observations (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES run_attempts(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES harness_operation_observations(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('context-compile', 'retrieval', 'memory-read', 'skill-load', 'approval-wait', 'tool-call', 'subagent-run', 'validation', 'artifact-build', 'checkpoint')),
    operation_name TEXT NOT NULL CHECK (length(operation_name) BETWEEN 1 AND 200),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'denied', 'timed-out', 'unknown')),
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    queue_ms INTEGER CHECK (queue_ms IS NULL OR queue_ms >= 0),
    approval_wait_ms INTEGER CHECK (approval_wait_ms IS NULL OR approval_wait_ms >= 0),
    input_bytes INTEGER CHECK (input_bytes IS NULL OR input_bytes >= 0),
    output_bytes INTEGER CHECK (output_bytes IS NULL OR output_bytes >= 0),
    input_items INTEGER CHECK (input_items IS NULL OR input_items >= 0),
    output_items INTEGER CHECK (output_items IS NULL OR output_items >= 0),
    mutation_count INTEGER CHECK (mutation_count IS NULL OR mutation_count >= 0),
    cache_outcome TEXT NOT NULL CHECK (cache_outcome IN ('hit', 'miss', 'write', 'bypass', 'not-applicable')),
    verification_outcome TEXT NOT NULL CHECK (verification_outcome IN ('passed', 'failed', 'not-run', 'not-applicable')),
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
    created_at_ms INTEGER NOT NULL,
    CHECK (queue_ms IS NULL OR queue_ms <= duration_ms),
    CHECK (approval_wait_ms IS NULL OR approval_wait_ms <= duration_ms)
) STRICT;

CREATE INDEX harness_operation_observations_run_idx
    ON harness_operation_observations(run_id, started_at_ms, id);

CREATE TABLE telemetry_export_checkpoints (
    exporter_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    collection TEXT NOT NULL CHECK (collection IN ('local', 'operational', 'diagnostic')),
    cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
    updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE telemetry_daily_rollups (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    day_utc TEXT NOT NULL CHECK (length(day_utc) = 10),
    provider_type TEXT NOT NULL CHECK (length(provider_type) BETWEEN 1 AND 64),
    model_bucket TEXT NOT NULL CHECK (length(model_bucket) BETWEEN 1 AND 128),
    operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 64),
    outcome TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 32),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    input_tokens INTEGER,
    output_tokens INTEGER,
    visible_output_tokens INTEGER,
    total_cost_microunits INTEGER,
    latency_p50_ms INTEGER,
    latency_p95_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (profile_id, day_utc, provider_type, model_bucket, operation_kind, outcome)
) STRICT;

CREATE INDEX telemetry_daily_rollups_lookup_idx
    ON telemetry_daily_rollups(profile_id, day_utc, provider_type, model_bucket);

-- Omnia schema v9: immutable multimodal bridge planning and stage receipts.
-- Keep this marker stable. These tables store metadata/provenance only: no
-- attachment bytes, base64 payloads, credentials, cookies, headers, provider
-- wire bodies, or filesystem paths are admitted by the native repository.

CREATE TABLE multimodal_bridge_plans (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    contract_revision INTEGER NOT NULL CHECK (contract_revision = 2),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL REFERENCES run_attempts(id) ON DELETE CASCADE,
    frozen_provider_input_id TEXT
        REFERENCES frozen_provider_inputs(id) ON DELETE RESTRICT,
    supersedes_plan_id TEXT
        REFERENCES multimodal_bridge_plans(id) ON DELETE RESTRICT,
    requested_mode TEXT NOT NULL CHECK (requested_mode IN (
        'auto', 'direct-native', 'local-transform', 'specialist-bridge-model',
        'hybrid-ensemble', 'surrogate-to-primary', 'human-review',
        'unsupported', 'local-only', 'direct-only', 'cheapest',
        'highest-quality', 'manual'
    )),
    resolved_mode TEXT NOT NULL CHECK (resolved_mode IN (
        'direct-native', 'local-transform', 'specialist-bridge-model',
        'hybrid-ensemble', 'surrogate-to-primary', 'human-review', 'unsupported'
    )),
    disposition TEXT NOT NULL CHECK (disposition IN (
        'ready', 'ready-with-degradation', 'review-required', 'blocked',
        'failed', 'unsupported'
    )),
    source_manifest_sha256 TEXT NOT NULL
        CHECK (length(source_manifest_sha256) = 64)
        CHECK (source_manifest_sha256 = lower(source_manifest_sha256)),
    capability_snapshot_revision_id TEXT NOT NULL
        CHECK (length(capability_snapshot_revision_id) BETWEEN 1 AND 512),
    policy_revision_id TEXT NOT NULL
        CHECK (length(policy_revision_id) BETWEEN 1 AND 512),
    data_boundary TEXT NOT NULL CHECK (data_boundary IN (
        'local-only', 'approved-provider', 'mixed', 'denied', 'review-required'
    )),
    egress_decision TEXT NOT NULL CHECK (egress_decision IN (
        'not-required', 'approved', 'denied', 'review-required'
    )),
    selected_reason_codes_json TEXT NOT NULL
        CHECK (json_valid(selected_reason_codes_json))
        CHECK (json_type(selected_reason_codes_json) = 'array')
        CHECK (length(CAST(selected_reason_codes_json AS BLOB)) <= 32768),
    rejected_alternatives_json TEXT NOT NULL
        CHECK (json_valid(rejected_alternatives_json))
        CHECK (json_type(rejected_alternatives_json) = 'array')
        CHECK (length(CAST(rejected_alternatives_json AS BLOB)) <= 131072),
    decisive_fidelity_dimensions_json TEXT NOT NULL
        CHECK (json_valid(decisive_fidelity_dimensions_json))
        CHECK (json_type(decisive_fidelity_dimensions_json) = 'array')
        CHECK (length(CAST(decisive_fidelity_dimensions_json AS BLOB)) <= 32768),
    fidelity_profile TEXT NOT NULL CHECK (fidelity_profile IN (
        'semantic-and-visual', 'semantic-only', 'render-required',
        'model-specific', 'unknown'
    )),
    plan_sha256 TEXT NOT NULL UNIQUE
        CHECK (length(plan_sha256) = 64)
        CHECK (plan_sha256 = lower(plan_sha256)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    CHECK (supersedes_plan_id IS NULL OR supersedes_plan_id <> id),
    CHECK (
        (resolved_mode = 'unsupported' AND disposition IN (
            'unsupported', 'blocked', 'review-required'
        )) OR resolved_mode <> 'unsupported'
    ),
    CHECK (
        (resolved_mode IN (
            'direct-native', 'specialist-bridge-model', 'hybrid-ensemble',
            'surrogate-to-primary'
        ) AND egress_decision = 'approved')
        OR resolved_mode NOT IN (
            'direct-native', 'specialist-bridge-model', 'hybrid-ensemble',
            'surrogate-to-primary'
        )
    )
) STRICT;

CREATE INDEX multimodal_bridge_plans_run_idx
    ON multimodal_bridge_plans(run_id, created_at_ms, id);
CREATE INDEX multimodal_bridge_plans_attempt_idx
    ON multimodal_bridge_plans(attempt_id, created_at_ms, id);

CREATE TABLE multimodal_bridge_plan_artifacts (
    plan_id TEXT NOT NULL
        REFERENCES multimodal_bridge_plans(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
    source_sha256 TEXT NOT NULL
        CHECK (length(source_sha256) = 64)
        CHECK (source_sha256 = lower(source_sha256)),
    source_selector TEXT NOT NULL
        CHECK (length(source_selector) BETWEEN 1 AND 512),
    modality TEXT NOT NULL CHECK (modality IN (
        'image', 'audio', 'video', 'pdf', 'document', 'spreadsheet',
        'archive', 'code', 'structured-data', 'scientific-artifact'
    )),
    media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 3 AND 255),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    PRIMARY KEY (plan_id, ordinal),
    UNIQUE (plan_id, attachment_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX multimodal_bridge_plan_artifacts_attachment_idx
    ON multimodal_bridge_plan_artifacts(attachment_id, plan_id);

CREATE TABLE multimodal_bridge_stage_receipts (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    plan_id TEXT NOT NULL
        REFERENCES multimodal_bridge_plans(id) ON DELETE CASCADE,
    stage_id TEXT NOT NULL CHECK (length(stage_id) BETWEEN 1 AND 512),
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    stage_kind TEXT NOT NULL CHECK (stage_kind IN (
        'admit', 'direct-deliver', 'local-transform', 'specialist-bridge',
        'hybrid-verify', 'surrogate-package', 'primary-deliver', 'human-review'
    )),
    status TEXT NOT NULL CHECK (status IN (
        'planned', 'running', 'completed', 'failed', 'cancelled',
        'outcome-unknown', 'reconcile-required', 'unsupported'
    )),
    boundary TEXT NOT NULL CHECK (boundary IN (
        'local-only', 'approved-provider', 'human-review'
    )),
    source_manifest_sha256 TEXT NOT NULL
        CHECK (length(source_manifest_sha256) = 64)
        CHECK (source_manifest_sha256 = lower(source_manifest_sha256)),
    output_manifest_sha256 TEXT
        CHECK (output_manifest_sha256 IS NULL OR (
            length(output_manifest_sha256) = 64
            AND output_manifest_sha256 = lower(output_manifest_sha256)
        )),
    capability_snapshot_revision_id TEXT NOT NULL
        CHECK (length(capability_snapshot_revision_id) BETWEEN 1 AND 512),
    policy_revision_id TEXT NOT NULL
        CHECK (length(policy_revision_id) BETWEEN 1 AND 512),
    provider_acceptance TEXT NOT NULL CHECK (provider_acceptance IN (
        'not-applicable', 'not-accepted', 'accepted', 'unknown'
    )),
    reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN (
        'not-required', 'pending', 'reconciled', 'blocked', 'failed'
    )),
    derivative_sha256_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(derivative_sha256_json))
        CHECK (json_type(derivative_sha256_json) = 'array')
        CHECK (length(CAST(derivative_sha256_json AS BLOB)) <= 131072),
    fidelity_disposition TEXT NOT NULL CHECK (fidelity_disposition IN (
        'planned', 'processing', 'ready', 'ready-with-degradation',
        'review-required', 'blocked', 'failed', 'unsupported'
    )),
    receipt_sha256 TEXT NOT NULL UNIQUE
        CHECK (length(receipt_sha256) = 64)
        CHECK (receipt_sha256 = lower(receipt_sha256)),
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms > 0),
    completed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= started_at_ms),
    UNIQUE (plan_id, stage_id, attempt_no),
    CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
    CHECK (
        (status IN ('outcome-unknown', 'reconcile-required')
            AND reconciliation_status IN ('pending', 'blocked'))
        OR status NOT IN ('outcome-unknown', 'reconcile-required')
    ),
    CHECK (
        status <> 'outcome-unknown'
        OR provider_acceptance IN ('accepted', 'unknown')
    ),
    CHECK (
        boundary = 'approved-provider'
        OR provider_acceptance = 'not-applicable'
    )
) STRICT;

CREATE INDEX multimodal_bridge_stage_receipts_plan_idx
    ON multimodal_bridge_stage_receipts(plan_id, stage_id, attempt_no);

CREATE TRIGGER multimodal_bridge_plans_scope_guard_insert
BEFORE INSERT ON multimodal_bridge_plans
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM run_attempts attempt
        JOIN generations run ON run.id = attempt.generation_id
        JOIN conversations conversation ON conversation.id = run.conversation_id
        WHERE attempt.id = NEW.attempt_id
          AND attempt.generation_id = NEW.run_id
          AND conversation.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'multimodal bridge plan scope conflict') END;
    SELECT CASE WHEN NEW.frozen_provider_input_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM frozen_provider_inputs frozen
        WHERE frozen.id = NEW.frozen_provider_input_id
          AND frozen.attempt_id = NEW.attempt_id
          AND frozen.run_id = NEW.run_id
    ) THEN RAISE(ABORT, 'multimodal bridge frozen input scope conflict') END;
    SELECT CASE WHEN NEW.supersedes_plan_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM multimodal_bridge_plans previous
        WHERE previous.id = NEW.supersedes_plan_id
          AND previous.run_id = NEW.run_id
          AND previous.attempt_id = NEW.attempt_id
    ) THEN RAISE(ABORT, 'multimodal bridge successor scope conflict') END;
END;

CREATE TRIGGER multimodal_bridge_plan_artifacts_scope_guard_insert
BEFORE INSERT ON multimodal_bridge_plan_artifacts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM multimodal_bridge_plans plan
        JOIN generations run ON run.id = plan.run_id
        JOIN messages user_message
          ON user_message.id = (
              SELECT parent_message_id
              FROM messages assistant_message
              WHERE assistant_message.id = run.assistant_message_id
          )
        JOIN attachments attachment
          ON attachment.id = NEW.attachment_id
         AND attachment.message_id = user_message.id
         AND attachment.deleted_at_ms IS NULL
        WHERE plan.id = NEW.plan_id
          AND attachment.blob_id = NEW.source_sha256
          AND attachment.byte_size = NEW.byte_size
          AND attachment.media_type = NEW.media_type
    ) THEN RAISE(ABORT, 'multimodal bridge artifact provenance conflict') END;
END;

CREATE TRIGGER multimodal_bridge_stage_receipts_scope_guard_insert
BEFORE INSERT ON multimodal_bridge_stage_receipts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM multimodal_bridge_plans plan
        WHERE plan.id = NEW.plan_id
          AND plan.source_manifest_sha256 = NEW.source_manifest_sha256
          AND plan.capability_snapshot_revision_id = NEW.capability_snapshot_revision_id
          AND plan.policy_revision_id = NEW.policy_revision_id
    ) THEN RAISE(ABORT, 'multimodal bridge stage receipt scope conflict') END;
END;

CREATE TRIGGER multimodal_bridge_plans_append_only_update
BEFORE UPDATE ON multimodal_bridge_plans
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge plan is immutable');
END;

CREATE TRIGGER multimodal_bridge_plans_append_only_delete
BEFORE DELETE ON multimodal_bridge_plans
WHEN EXISTS (SELECT 1 FROM generations WHERE id = OLD.run_id)
BEGIN
    SELECT RAISE(ABORT, 'live multimodal bridge plan cannot be deleted');
END;

CREATE TRIGGER multimodal_bridge_plan_artifacts_append_only_update
BEFORE UPDATE ON multimodal_bridge_plan_artifacts
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge artifact provenance is immutable');
END;

CREATE TRIGGER multimodal_bridge_plan_artifacts_append_only_delete
BEFORE DELETE ON multimodal_bridge_plan_artifacts
WHEN EXISTS (SELECT 1 FROM multimodal_bridge_plans WHERE id = OLD.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge artifact provenance is immutable');
END;

CREATE TRIGGER multimodal_bridge_stage_receipts_append_only_update
BEFORE UPDATE ON multimodal_bridge_stage_receipts
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge stage receipt is append-only');
END;

CREATE TRIGGER multimodal_bridge_stage_receipts_append_only_delete
BEFORE DELETE ON multimodal_bridge_stage_receipts
WHEN EXISTS (SELECT 1 FROM multimodal_bridge_plans WHERE id = OLD.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge stage receipt is append-only');
END;

-- Omnia schema v10: multimodal bridge provenance and fail-closed hardening.
-- Keep this marker stable. v10 rebuilds the artifact table because SQLite
-- cannot widen its modality CHECK constraint in place. Existing rows are
-- copied verbatim; native code never normalizes historical provenance metadata.
-- Unknown canonical MIME values are rejected before durable admission. The
-- v10 rebuild intentionally retains only trusted modality values while adding
-- exact immutable receipt provenance and provider-stage guards below.

DROP TRIGGER IF EXISTS multimodal_bridge_plan_artifacts_scope_guard_insert;
DROP TRIGGER IF EXISTS multimodal_bridge_plan_artifacts_append_only_update;
DROP TRIGGER IF EXISTS multimodal_bridge_plan_artifacts_append_only_delete;

CREATE TABLE multimodal_bridge_plan_artifacts_v10 (
    plan_id TEXT NOT NULL
        REFERENCES multimodal_bridge_plans(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
    source_sha256 TEXT NOT NULL
        CHECK (length(source_sha256) = 64)
        CHECK (source_sha256 = lower(source_sha256)),
    source_selector TEXT NOT NULL
        CHECK (length(source_selector) BETWEEN 1 AND 512),
    modality TEXT NOT NULL CHECK (modality IN (
        'image', 'audio', 'video', 'pdf', 'document', 'spreadsheet',
        'archive', 'code', 'structured-data', 'scientific-artifact'
    )),
    media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 3 AND 255),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    PRIMARY KEY (plan_id, ordinal),
    UNIQUE (plan_id, attachment_id)
) WITHOUT ROWID, STRICT;

INSERT INTO multimodal_bridge_plan_artifacts_v10 (
    plan_id, ordinal, attachment_id, source_sha256, source_selector,
    modality, media_type, byte_size, created_at_ms
)
SELECT
    plan_id, ordinal, attachment_id, source_sha256, source_selector,
    modality, media_type, byte_size, created_at_ms
FROM multimodal_bridge_plan_artifacts;

DROP TABLE multimodal_bridge_plan_artifacts;
ALTER TABLE multimodal_bridge_plan_artifacts_v10
    RENAME TO multimodal_bridge_plan_artifacts;

CREATE INDEX multimodal_bridge_plan_artifacts_attachment_idx
    ON multimodal_bridge_plan_artifacts(attachment_id, plan_id);

-- An artifact is admissible only when it is backed by an immutable binding
-- receipt for the exact profile/project/conversation/branch/message/run of
-- its plan. This prevents a future internal caller from bypassing the
-- receipt-derived native admission path with a message-owned attachment.
CREATE TRIGGER multimodal_bridge_plan_artifacts_scope_guard_insert
BEFORE INSERT ON multimodal_bridge_plan_artifacts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM multimodal_bridge_plans plan
        JOIN generations run ON run.id = plan.run_id
        JOIN conversations conversation ON conversation.id = run.conversation_id
        JOIN messages assistant_message
          ON assistant_message.id = run.assistant_message_id
        JOIN messages user_message
          ON user_message.id = assistant_message.parent_message_id
        JOIN attachments attachment
          ON attachment.id = NEW.attachment_id
         AND attachment.message_id = user_message.id
         AND attachment.deleted_at_ms IS NULL
        JOIN attachment_binding_receipts receipt
          ON receipt.attachment_id = attachment.id
         AND receipt.attachment_blob_id = NEW.source_sha256
         AND receipt.profile_id = plan.profile_id
         AND receipt.project_id IS conversation.project_id
         AND receipt.conversation_id = run.conversation_id
         AND receipt.branch_id = run.branch_id
         AND receipt.message_id = user_message.id
         AND receipt.run_id = plan.run_id
        WHERE plan.id = NEW.plan_id
          AND attachment.draft_id IS NULL
          AND attachment.blob_id = NEW.source_sha256
          AND attachment.byte_size = NEW.byte_size
          AND attachment.media_type = NEW.media_type
    ) THEN RAISE(ABORT, 'multimodal bridge artifact receipt provenance conflict') END;
END;

CREATE TRIGGER multimodal_bridge_plan_artifacts_append_only_update
BEFORE UPDATE ON multimodal_bridge_plan_artifacts
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge artifact provenance is immutable');
END;

CREATE TRIGGER multimodal_bridge_plan_artifacts_append_only_delete
BEFORE DELETE ON multimodal_bridge_plan_artifacts
WHEN EXISTS (SELECT 1 FROM multimodal_bridge_plans WHERE id = OLD.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'multimodal bridge artifact provenance is immutable');
END;

DROP TRIGGER IF EXISTS multimodal_bridge_stage_receipts_scope_guard_insert;

-- No native provider carrier exists at this checkpoint. Enforce the same
-- rule in SQLite as in Rust: a stage receipt may not claim an approved
-- provider boundary or provider acceptance until carrier, acceptance evidence,
-- and reconciliation are implemented as a separate later slice.
CREATE TRIGGER multimodal_bridge_stage_receipts_scope_guard_insert
BEFORE INSERT ON multimodal_bridge_stage_receipts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM multimodal_bridge_plans plan
        WHERE plan.id = NEW.plan_id
          AND plan.source_manifest_sha256 = NEW.source_manifest_sha256
          AND plan.capability_snapshot_revision_id = NEW.capability_snapshot_revision_id
          AND plan.policy_revision_id = NEW.policy_revision_id
    ) THEN RAISE(ABORT, 'multimodal bridge stage receipt scope conflict') END;
    SELECT CASE WHEN NEW.boundary = 'approved-provider'
                      OR NEW.provider_acceptance <> 'not-applicable'
        THEN RAISE(ABORT, 'multimodal bridge provider execution is unavailable') END;
END;

-- Omnia schema v11: immutable state-revision graph and branch-head CAS.
--
-- These tables contain bounded, redacted JSON manifests and hashes only. They
-- are not a replacement for typed message/run/journal facts. Every accepted
-- mutation is represented by an immutable revision and the mutable head is a
-- projection that may be rebuilt from those revisions at a fixed watermark.
CREATE TABLE state_revision_streams (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (profile_id, conversation_id, branch_id)
) STRICT;

CREATE INDEX state_revision_streams_scope_idx
    ON state_revision_streams(profile_id, conversation_id, branch_id);

CREATE TABLE state_revisions (
    id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL REFERENCES state_revision_streams(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN (
        'root', 'checkpoint', 'continuation', 'resume', 'prompt-edit',
        'retry-result', 'branch', 'fork', 'merge', 'promotion', 'compaction',
        'reconciliation', 'recovery'
    )),
    status TEXT NOT NULL CHECK (status IN (
        'candidate', 'accepted', 'rejected', 'superseded', 'outcome-unknown',
        'conflicted', 'blocked', 'discarded', 'invalid'
    )),
    branch_sequence INTEGER NOT NULL CHECK (branch_sequence >= 0),
    watermark_json TEXT NOT NULL CHECK (json_valid(watermark_json)),
    observed_head_id TEXT REFERENCES state_revisions(id),
    expected_head_id TEXT REFERENCES state_revisions(id),
    actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
    causation_json TEXT NOT NULL CHECK (json_valid(causation_json)),
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    authority_json TEXT NOT NULL CHECK (json_valid(authority_json)),
    routing_cache_json TEXT NOT NULL CHECK (json_valid(routing_cache_json)),
    state_digest TEXT NOT NULL CHECK (length(state_digest) BETWEEN 16 AND 512),
    canonicalization_revision TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (stream_id, branch_sequence)
) STRICT;

CREATE INDEX state_revisions_stream_sequence_idx
    ON state_revisions(stream_id, branch_sequence, id);
CREATE INDEX state_revisions_stream_status_idx
    ON state_revisions(stream_id, status, branch_sequence);

CREATE TABLE state_revision_parents (
    revision_id TEXT NOT NULL REFERENCES state_revisions(id) ON DELETE CASCADE,
    parent_revision_id TEXT NOT NULL REFERENCES state_revisions(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (revision_id, parent_revision_id),
    UNIQUE (revision_id, ordinal)
) WITHOUT ROWID, STRICT;

CREATE INDEX state_revision_parents_parent_idx
    ON state_revision_parents(parent_revision_id, revision_id);

CREATE TABLE state_revision_edges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'inherits-from', 'checkpoint-of', 'continues-from',
        'resumes-from-checkpoint', 'edits', 'retries', 'branches-from',
        'forks-from', 'merges-from', 'promotes', 'compacts',
        'reconciles-external-effect', 'supersedes', 'conflicts-with',
        'derives-selected-delta-from'
    )),
    from_revision_id TEXT NOT NULL REFERENCES state_revisions(id) ON DELETE RESTRICT,
    to_revision_id TEXT NOT NULL REFERENCES state_revisions(id) ON DELETE RESTRICT,
    operation_id TEXT,
    causal_cursor_json TEXT NOT NULL CHECK (json_valid(causal_cursor_json)),
    policy_revision_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    CHECK (from_revision_id <> to_revision_id)
) STRICT;

CREATE INDEX state_revision_edges_from_idx
    ON state_revision_edges(from_revision_id, created_at_ms, id);
CREATE INDEX state_revision_edges_to_idx
    ON state_revision_edges(to_revision_id, created_at_ms, id);

CREATE TABLE state_revision_heads (
    stream_id TEXT PRIMARY KEY REFERENCES state_revision_streams(id) ON DELETE CASCADE,
    accepted_revision_id TEXT REFERENCES state_revisions(id) ON DELETE RESTRICT,
    branch_sequence INTEGER NOT NULL CHECK (branch_sequence >= 0),
    updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE state_revision_idempotency (
    stream_id TEXT NOT NULL REFERENCES state_revision_streams(id) ON DELETE CASCADE,
    idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
    canonical_payload_hash TEXT NOT NULL CHECK (length(canonical_payload_hash) = 64),
    result_revision_id TEXT NOT NULL REFERENCES state_revisions(id) ON DELETE RESTRICT,
    -- receipt_json is an immutable, redacted StateRevisionReceipt v1.  The
    -- normative JSON Schema lives at
    -- docs/omnia-ultra/schemas/state-revision-receipt.schema.json.  A receipt
    -- created on a complete v12 journal requires schemaVersion, outcome
    -- ("applied"), revisionId, streamId, acceptedHeadStateRevisionId,
    -- expectedHeadStateRevisionId, branchSequence, canonicalPayloadHash and
    -- the all-or-none journal cursor (journalEpoch, journalSequence,
    -- journalEventId).  A receipt inherited from a v11 stream migrated with
    -- legacy-partial coverage may contain only the base eight fields because
    -- migration deliberately does not fabricate historical events; partial
    -- cursors are invalid.  The receipt records the original mutation's
    -- accepted/effective CAS heads and event cursor; it intentionally does not
    -- store the mutable live current head.  Replay must validate and
    -- cross-check this JSON against the typed rows rather than reconstructing
    -- it from a later projection.
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (stream_id, idempotency_key_hash)
) WITHOUT ROWID, STRICT;

CREATE INDEX state_revision_idempotency_result_idx
    ON state_revision_idempotency(result_revision_id);

CREATE TRIGGER state_revision_streams_scope_guard_insert
BEFORE INSERT ON state_revision_streams
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM conversations conversation
        JOIN conversation_branches branch
          ON branch.id = NEW.branch_id
         AND branch.conversation_id = conversation.id
         AND branch.deleted_at_ms IS NULL
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND (conversation.project_id IS NEW.project_id)
          AND conversation.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'state revision stream scope conflict') END;
END;

CREATE TRIGGER state_revision_streams_immutable_update
BEFORE UPDATE ON state_revision_streams
BEGIN
    SELECT RAISE(ABORT, 'state revision streams are immutable');
END;

CREATE TRIGGER state_revision_streams_immutable_delete
BEFORE DELETE ON state_revision_streams
BEGIN
    SELECT RAISE(ABORT, 'state revision streams are immutable');
END;

CREATE TRIGGER state_revisions_scope_guard_insert
BEFORE INSERT ON state_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM state_revision_streams stream
        WHERE stream.id = NEW.stream_id
          AND (NEW.observed_head_id IS NULL OR EXISTS (
              SELECT 1 FROM state_revisions observed
              WHERE observed.id = NEW.observed_head_id
                AND observed.stream_id = NEW.stream_id
          ))
          AND (NEW.expected_head_id IS NULL OR EXISTS (
              SELECT 1 FROM state_revisions expected
              WHERE expected.id = NEW.expected_head_id
                AND expected.stream_id = NEW.stream_id
          ))
    ) THEN RAISE(ABORT, 'state revision head scope conflict') END;
END;

CREATE TRIGGER state_revisions_immutable_update
BEFORE UPDATE ON state_revisions
BEGIN
    SELECT RAISE(ABORT, 'state revisions are immutable');
END;

CREATE TRIGGER state_revisions_immutable_delete
BEFORE DELETE ON state_revisions
BEGIN
    SELECT RAISE(ABORT, 'state revisions are immutable');
END;

-- A stream has one bootstrap root.  The accepted-head projection is not a
-- sufficient uniqueness boundary because candidate roots intentionally do not
-- advance that projection.  Keep the invariant in SQLite as well as in the
-- native repository so direct recovery/import writes cannot create a second
-- root after a candidate bootstrap.
CREATE TRIGGER state_revisions_root_uniqueness_guard_insert
BEFORE INSERT ON state_revisions
WHEN NEW.kind = 'root'
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM state_revisions existing
        WHERE existing.stream_id = NEW.stream_id
          AND existing.kind = 'root'
    ) THEN RAISE(ABORT, 'state revision stream already has a root') END;
END;

CREATE TRIGGER state_revision_parents_scope_guard_insert
BEFORE INSERT ON state_revision_parents
BEGIN
    SELECT CASE WHEN NEW.revision_id = NEW.parent_revision_id
        THEN RAISE(ABORT, 'state revision cannot parent itself') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions child
        JOIN state_revisions parent
          ON parent.id = NEW.parent_revision_id
         AND parent.stream_id = child.stream_id
        WHERE child.id = NEW.revision_id
    ) THEN RAISE(ABORT, 'state revision parent scope conflict') END;
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM state_revisions child
        JOIN state_revisions parent
          ON parent.id = NEW.parent_revision_id
         AND parent.stream_id = child.stream_id
        WHERE child.id = NEW.revision_id
          AND parent.branch_sequence >= child.branch_sequence
    ) THEN RAISE(ABORT, 'state revision parent sequence conflict') END;
END;

CREATE TRIGGER state_revision_parents_immutable_update
BEFORE UPDATE ON state_revision_parents
BEGIN
    SELECT RAISE(ABORT, 'state revision parents are immutable');
END;

CREATE TRIGGER state_revision_parents_immutable_delete
BEFORE DELETE ON state_revision_parents
BEGIN
    SELECT RAISE(ABORT, 'state revision parents are immutable');
END;

CREATE TRIGGER state_revision_edges_scope_guard_insert
BEFORE INSERT ON state_revision_edges
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions source_revision
        JOIN state_revisions target_revision
          ON target_revision.id = NEW.to_revision_id
         AND target_revision.stream_id = source_revision.stream_id
        WHERE source_revision.id = NEW.from_revision_id
    ) THEN RAISE(ABORT, 'state revision edge scope conflict') END;
END;

CREATE TRIGGER state_revision_edges_immutable_update
BEFORE UPDATE ON state_revision_edges
BEGIN
    SELECT RAISE(ABORT, 'state revision edges are immutable');
END;

CREATE TRIGGER state_revision_edges_immutable_delete
BEFORE DELETE ON state_revision_edges
BEGIN
    SELECT RAISE(ABORT, 'state revision edges are immutable');
END;

CREATE TRIGGER state_revision_heads_scope_guard_insert
BEFORE INSERT ON state_revision_heads
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM state_revision_streams stream
        WHERE stream.id = NEW.stream_id
    ) THEN RAISE(ABORT, 'state revision head stream not found') END;
    SELECT CASE WHEN NEW.accepted_revision_id IS NULL
                     AND NEW.branch_sequence <> 0
        THEN RAISE(ABORT, 'an empty state revision head must have branch sequence zero') END;
    SELECT CASE WHEN NEW.accepted_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.accepted_revision_id
          AND revision.stream_id = NEW.stream_id
          AND revision.status = 'accepted'
          AND revision.branch_sequence = NEW.branch_sequence
    ) THEN RAISE(ABORT, 'state revision accepted head scope conflict') END;
    SELECT CASE WHEN NEW.accepted_revision_id IS NULL
                      AND NEW.branch_sequence <> 0
        THEN RAISE(ABORT, 'state revision null head must use sequence zero') END;
END;

CREATE TRIGGER state_revision_heads_scope_guard_update
BEFORE UPDATE ON state_revision_heads
BEGIN
    SELECT CASE WHEN NEW.stream_id <> OLD.stream_id
        THEN RAISE(ABORT, 'state revision head stream identity is immutable') END;
    SELECT CASE WHEN NEW.branch_sequence < OLD.branch_sequence
        THEN RAISE(ABORT, 'state revision head branch sequence must be monotonic') END;
    SELECT CASE WHEN NEW.accepted_revision_id IS NULL
                     AND NEW.branch_sequence <> 0
        THEN RAISE(ABORT, 'an empty state revision head must have branch sequence zero') END;
    SELECT CASE WHEN NEW.accepted_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.accepted_revision_id
          AND revision.stream_id = NEW.stream_id
          AND revision.status = 'accepted'
          AND revision.branch_sequence = NEW.branch_sequence
    ) THEN RAISE(ABORT, 'state revision accepted head scope conflict') END;
    SELECT CASE WHEN NEW.accepted_revision_id IS NULL
                      AND NEW.branch_sequence <> 0
        THEN RAISE(ABORT, 'state revision null head must use sequence zero') END;
END;

CREATE TRIGGER state_revision_heads_stream_immutable_update
BEFORE UPDATE OF stream_id ON state_revision_heads
BEGIN
    SELECT RAISE(ABORT, 'state revision head stream is immutable');
END;

CREATE TRIGGER state_revision_idempotency_scope_guard_insert
BEFORE INSERT ON state_revision_idempotency
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM state_revision_streams stream
        WHERE stream.id = NEW.stream_id
    ) THEN RAISE(ABORT, 'state revision idempotency stream not found') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.result_revision_id
          AND revision.stream_id = NEW.stream_id
    ) THEN RAISE(ABORT, 'state revision idempotency result scope conflict') END;
END;

CREATE TRIGGER state_revision_idempotency_immutable_update
BEFORE UPDATE ON state_revision_idempotency
BEGIN
    SELECT RAISE(ABORT, 'state revision idempotency receipts are immutable');
END;

CREATE TRIGGER state_revision_idempotency_immutable_delete
BEFORE DELETE ON state_revision_idempotency
BEGIN
    SELECT RAISE(ABORT, 'state revision idempotency receipts are immutable');
END;

-- Omnia schema v12: append-only state-revision mutation journal.
--
-- State-revision mutations are not necessarily provider runs, so they cannot
-- be represented by the run-scoped journal without inventing a fake run.  This
-- narrow journal records one safe, hash-only fact for every committed
-- state-revision mutation.  The journal fact is appended in the same native
-- transaction as the revision, parent/edge rows, idempotency receipt and
-- accepted-head projection.
CREATE TABLE state_revision_journals (
    stream_id TEXT PRIMARY KEY
        REFERENCES state_revision_streams(id) ON DELETE CASCADE,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    journal_epoch TEXT NOT NULL UNIQUE,
    coverage TEXT NOT NULL
        CHECK (coverage IN ('complete', 'legacy-partial', 'recovered-partial')),
    coverage_reason TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    CHECK (
        (coverage = 'complete' AND coverage_reason IS NULL)
        OR (coverage <> 'complete' AND coverage_reason IS NOT NULL)
    )
) STRICT;

CREATE TABLE state_revision_events (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    stream_id TEXT NOT NULL
        REFERENCES state_revision_journals(stream_id) ON DELETE CASCADE,
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
    event_type TEXT NOT NULL CHECK (
        event_type IN ('state.revision_appended')
    ),
    source TEXT NOT NULL CHECK (
        source IN ('harness', 'user', 'agent', 'automation', 'recovery', 'system')
    ),
    visibility TEXT NOT NULL CHECK (
        visibility IN ('user', 'inspector', 'diagnostic')
    ),
    sensitivity TEXT NOT NULL CHECK (
        sensitivity IN ('normal', 'sensitive', 'secret_ref')
    ),
    revision_id TEXT NOT NULL
        REFERENCES state_revisions(id) ON DELETE RESTRICT,
    payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json))
        CHECK (length(CAST(payload_json AS BLOB)) <= 524288),
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
    committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms > 0),
    UNIQUE (stream_id, sequence_no),
    UNIQUE (stream_id, id),
    UNIQUE (stream_id, revision_id)
) STRICT;

CREATE INDEX state_revision_events_replay_idx
    ON state_revision_events(stream_id, sequence_no);

CREATE INDEX state_revision_events_revision_idx
    ON state_revision_events(stream_id, revision_id);

CREATE TRIGGER state_revision_journals_immutable_update
BEFORE UPDATE ON state_revision_journals
BEGIN
    SELECT RAISE(ABORT, 'state revision journal metadata is immutable');
END;

CREATE TRIGGER state_revision_journals_immutable_delete
BEFORE DELETE ON state_revision_journals
BEGIN
    SELECT RAISE(ABORT, 'state revision journal metadata is immutable');
END;

CREATE TRIGGER state_revision_events_append_only_update
BEFORE UPDATE ON state_revision_events
BEGIN
    SELECT RAISE(ABORT, 'state revision event journal is append-only');
END;

CREATE TRIGGER state_revision_events_append_only_delete
BEFORE DELETE ON state_revision_events
BEGIN
    SELECT RAISE(ABORT, 'state revision event journal is append-only');
END;

CREATE TRIGGER state_revision_events_scope_guard
BEFORE INSERT ON state_revision_events
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revision_journals journal
        JOIN state_revisions revision
          ON revision.id = NEW.revision_id
         AND revision.stream_id = journal.stream_id
        WHERE journal.stream_id = NEW.stream_id
    ) THEN RAISE(ABORT, 'state revision event scope conflict') END;
END;

CREATE TRIGGER state_revision_events_sequence_guard
BEFORE INSERT ON state_revision_events
BEGIN
    SELECT CASE WHEN NEW.sequence_no <> (
        SELECT COALESCE(MAX(sequence_no), 0) + 1
        FROM state_revision_events
        WHERE stream_id = NEW.stream_id
    ) THEN RAISE(ABORT, 'state revision event sequence must be gap-free') END;
END;

-- Omnia schema v13: immutable state-revision operation facts.
--
-- Operation metadata describes the operation that created a revision, not a
-- particular parent edge.  Keeping it in a revision-keyed fact gives roots a
-- durable operation record even though roots have no parent edge, and gives
-- replay validation one authoritative source to compare with the journal.
-- Historical v11/v12 revisions are marked legacy-partial when the metadata
-- cannot be recovered without inventing facts.  New revisions always receive
-- a complete row in the same transaction as the revision and journal event.
CREATE TABLE state_revision_operation_facts (
    revision_id TEXT PRIMARY KEY
        REFERENCES state_revisions(id) ON DELETE RESTRICT,
    operation_id TEXT,
    causal_cursor_json TEXT,
    policy_revision_id TEXT,
    coverage TEXT NOT NULL
        CHECK (coverage IN ('complete', 'legacy-partial')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    CHECK (
        (coverage = 'complete'
            AND causal_cursor_json IS NOT NULL
            AND json_valid(causal_cursor_json)
            AND policy_revision_id IS NOT NULL
            AND length(policy_revision_id) BETWEEN 1 AND 256)
        OR coverage = 'legacy-partial'
    ),
    CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 256)
) STRICT;

CREATE INDEX state_revision_operation_facts_coverage_idx
    ON state_revision_operation_facts(coverage, created_at_ms, revision_id);

CREATE TRIGGER state_revision_operation_facts_scope_guard_insert
BEFORE INSERT ON state_revision_operation_facts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.revision_id
    ) THEN RAISE(ABORT, 'state revision operation fact revision not found') END;
    SELECT CASE WHEN NEW.operation_id IS NOT NULL
                      AND (length(NEW.operation_id) < 1 OR length(NEW.operation_id) > 256)
        THEN RAISE(ABORT, 'state revision operation fact operation identifier is invalid') END;
    SELECT CASE WHEN NEW.coverage = 'complete'
                      AND (NEW.causal_cursor_json IS NULL
                           OR json_valid(NEW.causal_cursor_json) = 0
                           OR NEW.policy_revision_id IS NULL
                           OR length(NEW.policy_revision_id) < 1
                           OR length(NEW.policy_revision_id) > 256)
        THEN RAISE(ABORT, 'complete state revision operation fact is incomplete') END;
END;

CREATE TRIGGER state_revision_operation_facts_immutable_update
BEFORE UPDATE ON state_revision_operation_facts
BEGIN
    SELECT RAISE(ABORT, 'state revision operation facts are immutable');
END;

CREATE TRIGGER state_revision_operation_facts_immutable_delete
BEFORE DELETE ON state_revision_operation_facts
BEGIN
    SELECT RAISE(ABORT, 'state revision operation facts are immutable');
END;

-- Omnia schema v14: immutable provider-attempt lineage facts.
--
-- A lineage fact is created in the same native transaction as the frozen
-- provider input.  It is intentionally metadata-only: endpoint fingerprints,
-- revision identifiers, hashes, and bounded policy references are retained,
-- while provider URLs, request bodies, credentials, cookies, headers, local
-- paths, and attachment bytes remain outside this table.  NULL on an optional
-- provenance field means unknown/unavailable/not-applicable; it is never a
-- zero or empty-string sentinel.
CREATE TABLE provider_attempt_lineage_facts (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    frozen_provider_input_id TEXT NOT NULL UNIQUE
        REFERENCES frozen_provider_inputs(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL
        REFERENCES generations(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL
        REFERENCES run_attempts(id) ON DELETE RESTRICT,
    provider_profile_id TEXT NOT NULL
        REFERENCES provider_profiles(id) ON DELETE RESTRICT,
    model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 512),

    provider_definition_schema_version INTEGER NOT NULL
        CHECK (provider_definition_schema_version = 1),
    provider_definition_sha256 TEXT NOT NULL
        CHECK (
            length(provider_definition_sha256) = 64
            AND provider_definition_sha256 = lower(provider_definition_sha256)
            AND provider_definition_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    endpoint_fingerprint_sha256 TEXT NOT NULL
        CHECK (
            length(endpoint_fingerprint_sha256) = 64
            AND endpoint_fingerprint_sha256 = lower(endpoint_fingerprint_sha256)
            AND endpoint_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    adapter_revision TEXT NOT NULL
        CHECK (length(adapter_revision) BETWEEN 1 AND 160),

    catalog_snapshot_id TEXT
        CHECK (catalog_snapshot_id IS NULL OR length(catalog_snapshot_id) BETWEEN 1 AND 512),
    catalog_snapshot_sha256 TEXT
        CHECK (
            catalog_snapshot_sha256 IS NULL OR (
                length(catalog_snapshot_sha256) = 64
                AND catalog_snapshot_sha256 = lower(catalog_snapshot_sha256)
                AND catalog_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),
    model_descriptor_revision_id TEXT
        CHECK (model_descriptor_revision_id IS NULL OR length(model_descriptor_revision_id) BETWEEN 1 AND 512),
    model_descriptor_sha256 TEXT
        CHECK (
            model_descriptor_sha256 IS NULL OR (
                length(model_descriptor_sha256) = 64
                AND model_descriptor_sha256 = lower(model_descriptor_sha256)
                AND model_descriptor_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),
    model_capability_snapshot_id TEXT
        CHECK (model_capability_snapshot_id IS NULL OR length(model_capability_snapshot_id) BETWEEN 1 AND 512),
    model_capability_snapshot_sha256 TEXT
        CHECK (
            model_capability_snapshot_sha256 IS NULL OR (
                length(model_capability_snapshot_sha256) = 64
                AND model_capability_snapshot_sha256 = lower(model_capability_snapshot_sha256)
                AND model_capability_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),

    route_revision_id TEXT
        CHECK (route_revision_id IS NULL OR length(route_revision_id) BETWEEN 1 AND 512),
    routing_decision_receipt_id TEXT
        CHECK (routing_decision_receipt_id IS NULL OR length(routing_decision_receipt_id) BETWEEN 1 AND 512),
    retry_policy_revision_id TEXT
        CHECK (retry_policy_revision_id IS NULL OR length(retry_policy_revision_id) BETWEEN 1 AND 512),
    cache_policy_revision_id TEXT
        CHECK (cache_policy_revision_id IS NULL OR length(cache_policy_revision_id) BETWEEN 1 AND 512),
    cache_plan_id TEXT
        CHECK (cache_plan_id IS NULL OR length(cache_plan_id) BETWEEN 1 AND 512),

    price_snapshot_id TEXT
        CHECK (price_snapshot_id IS NULL OR length(price_snapshot_id) BETWEEN 1 AND 512),
    price_snapshot_sha256 TEXT
        CHECK (
            price_snapshot_sha256 IS NULL OR (
                length(price_snapshot_sha256) = 64
                AND price_snapshot_sha256 = lower(price_snapshot_sha256)
                AND price_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),
    parameter_profile_revision_id TEXT
        CHECK (parameter_profile_revision_id IS NULL OR length(parameter_profile_revision_id) BETWEEN 1 AND 512),
    resolved_parameters_sha256 TEXT NOT NULL
        CHECK (
            length(resolved_parameters_sha256) = 64
            AND resolved_parameters_sha256 = lower(resolved_parameters_sha256)
            AND resolved_parameters_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    requested_effort TEXT
        CHECK (
            requested_effort IS NULL
            OR requested_effort IN ('fast', 'balanced', 'deep', 'ultra', 'custom')
        ),
    effective_effort TEXT
        CHECK (
            effective_effort IS NULL
            OR (
                length(effective_effort) BETWEEN 1 AND 80
                AND trim(effective_effort) <> ''
                AND effective_effort NOT GLOB '*[' || char(9) || char(10) || char(13) || ']*'
            )
        ),

    context_manifest_id TEXT
        CHECK (context_manifest_id IS NULL OR length(context_manifest_id) BETWEEN 1 AND 512),
    context_manifest_sha256 TEXT
        CHECK (
            context_manifest_sha256 IS NULL OR (
                length(context_manifest_sha256) = 64
                AND context_manifest_sha256 = lower(context_manifest_sha256)
                AND context_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
            )
        ),
    authority_continuity_record_id TEXT
        CHECK (authority_continuity_record_id IS NULL OR length(authority_continuity_record_id) BETWEEN 1 AND 512),
    data_classification_revision_id TEXT
        CHECK (data_classification_revision_id IS NULL OR length(data_classification_revision_id) BETWEEN 1 AND 512),

    input_content_sha256 TEXT NOT NULL
        CHECK (
            length(input_content_sha256) = 64
            AND input_content_sha256 = lower(input_content_sha256)
            AND input_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    lineage_sha256 TEXT NOT NULL
        CHECK (
            length(lineage_sha256) = 64
            AND lineage_sha256 = lower(lineage_sha256)
            AND lineage_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE INDEX provider_attempt_lineage_facts_attempt_idx
    ON provider_attempt_lineage_facts(attempt_id, created_at_ms, id);
CREATE INDEX provider_attempt_lineage_facts_run_idx
    ON provider_attempt_lineage_facts(run_id, created_at_ms, id);
CREATE INDEX provider_attempt_lineage_facts_provider_idx
    ON provider_attempt_lineage_facts(provider_profile_id, model_id, created_at_ms DESC);

CREATE TRIGGER provider_attempt_lineage_facts_scope_guard_insert
BEFORE INSERT ON provider_attempt_lineage_facts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM frozen_provider_inputs frozen
        JOIN run_attempts attempt
          ON attempt.id = frozen.attempt_id
         AND attempt.generation_id = frozen.run_id
         AND attempt.provider_profile_id = frozen.provider_profile_id
         AND attempt.model_id = frozen.model_id
        JOIN generations run
          ON run.id = frozen.run_id
         AND run.provider_profile_id = frozen.provider_profile_id
         AND run.model_id = frozen.model_id
        JOIN provider_profiles profile
          ON profile.id = frozen.provider_profile_id
        WHERE frozen.id = NEW.frozen_provider_input_id
          AND frozen.run_id = NEW.run_id
           AND frozen.attempt_id = NEW.attempt_id
           AND frozen.provider_profile_id = NEW.provider_profile_id
           AND frozen.model_id = NEW.model_id
           AND NEW.created_at_ms = frozen.created_at_ms
     ) THEN RAISE(ABORT, 'provider attempt lineage scope conflict') END;
    SELECT CASE WHEN NEW.input_content_sha256 <> (
        SELECT frozen.content_sha256
        FROM frozen_provider_inputs frozen
        WHERE frozen.id = NEW.frozen_provider_input_id
    ) THEN RAISE(ABORT, 'provider attempt lineage input hash conflict') END;
    SELECT CASE WHEN (NEW.catalog_snapshot_id IS NULL) <> (NEW.catalog_snapshot_sha256 IS NULL)
        THEN RAISE(ABORT, 'catalog snapshot id and hash must be both known or both unknown') END;
    SELECT CASE WHEN (NEW.model_descriptor_revision_id IS NULL) <> (NEW.model_descriptor_sha256 IS NULL)
        THEN RAISE(ABORT, 'model descriptor revision and hash must be both known or both unknown') END;
    SELECT CASE WHEN (NEW.model_capability_snapshot_id IS NULL) <> (NEW.model_capability_snapshot_sha256 IS NULL)
        THEN RAISE(ABORT, 'model capability snapshot id and hash must be both known or both unknown') END;
    SELECT CASE WHEN (NEW.price_snapshot_id IS NULL) <> (NEW.price_snapshot_sha256 IS NULL)
        THEN RAISE(ABORT, 'price snapshot id and hash must be both known or both unknown') END;
    SELECT CASE WHEN (NEW.context_manifest_id IS NULL) <> (NEW.context_manifest_sha256 IS NULL)
        THEN RAISE(ABORT, 'context manifest id and hash must be both known or both unknown') END;
END;

CREATE TRIGGER provider_attempt_lineage_facts_immutable_update
BEFORE UPDATE ON provider_attempt_lineage_facts
BEGIN
    SELECT RAISE(ABORT, 'provider attempt lineage facts are immutable');
END;

CREATE TRIGGER provider_attempt_lineage_facts_immutable_delete
BEFORE DELETE ON provider_attempt_lineage_facts
BEGIN
    SELECT RAISE(ABORT, 'provider attempt lineage facts are immutable');
END;

-- Omnia schema v15: durable run-control resolutions, checkpoints,
-- continuation intents, and immutable message revisions.
--
-- These records are metadata-only receipts. Prompt/response bodies,
-- credentials, cookies, raw provider headers, attachment bytes, and local
-- filesystem paths must never be persisted in this section. The operation and
-- intent JSON columns contain canonical, redacted envelopes produced by the
-- native resolver and are bounded by the storage layer before insertion.
CREATE TABLE run_control_operations (
    operation_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    idempotency_key_hash TEXT NOT NULL
        CHECK (length(idempotency_key_hash) = 64
               AND idempotency_key_hash = lower(idempotency_key_hash)
               AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    canonical_payload_hash TEXT NOT NULL
        CHECK (length(canonical_payload_hash) = 64
               AND canonical_payload_hash = lower(canonical_payload_hash)
               AND canonical_payload_hash NOT GLOB '*[^0-9a-f]*'),
    operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
    operation_state TEXT NOT NULL CHECK (
        operation_state IN ('resolved', 'applied', 'blocked', 'rejected',
                            'cancelled', 'failed')
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX run_control_operations_idempotency_idx
    ON run_control_operations(profile_id, idempotency_key_hash);
CREATE INDEX run_control_operations_scope_idx
    ON run_control_operations(profile_id, conversation_id, branch_id, created_at_ms DESC);

CREATE TRIGGER run_control_operations_scope_guard_insert
BEFORE INSERT ON run_control_operations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM conversations conversation
        JOIN conversation_branches branch
          ON branch.id = NEW.branch_id
         AND branch.conversation_id = conversation.id
         AND branch.deleted_at_ms IS NULL
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'run-control operation scope conflict') END;
END;

CREATE TRIGGER run_control_operations_immutable_update
BEFORE UPDATE ON run_control_operations
BEGIN
    SELECT RAISE(ABORT, 'run-control operation receipts are immutable');
END;

CREATE TRIGGER run_control_operations_immutable_delete
BEFORE DELETE ON run_control_operations
BEGIN
    SELECT RAISE(ABORT, 'run-control operation receipts are immutable');
END;

CREATE TABLE run_control_operation_events (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES run_control_operations(operation_id) ON DELETE RESTRICT,
    operation_state TEXT NOT NULL CHECK (
        operation_state IN ('resolved', 'applied', 'blocked', 'rejected',
                            'cancelled', 'failed')
    ),
    result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (operation_id, operation_state)
) STRICT;

CREATE INDEX run_control_operation_events_lookup_idx
    ON run_control_operation_events(operation_id, created_at_ms DESC, event_id DESC);

CREATE TRIGGER run_control_operation_events_immutable_update
BEFORE UPDATE ON run_control_operation_events
BEGIN
    SELECT RAISE(ABORT, 'run-control operation events are immutable');
END;

CREATE TRIGGER run_control_operation_events_immutable_delete
BEFORE DELETE ON run_control_operation_events
BEGIN
    SELECT RAISE(ABORT, 'run-control operation events are immutable');
END;

CREATE TABLE run_checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES generations(id) ON DELETE RESTRICT,
    attempt_id TEXT REFERENCES run_attempts(id) ON DELETE RESTRICT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    agent_instance_id TEXT,
    state_revision_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('requested', 'checkpointing', 'paused', 'resuming',
                   'expired', 'blocked', 'invalidated')
    ),
    disposition TEXT NOT NULL CHECK (
        disposition IN ('cooperative-checkpoint', 'provider-supported-suspend',
                        'cancel-then-reconcile', 'pending-effect-checkpoint',
                        'held', 'outcome-unknown')
    ),
    cursor INTEGER NOT NULL CHECK (cursor >= 0),
    partial_output_policy TEXT CHECK (
        partial_output_policy IS NULL OR partial_output_policy IN (
            'exclude', 'durable-only', 'include-as-interrupted-artifact',
            'wait-safe-boundary'
        )
    ),
    frozen_provider_input_id TEXT,
    provider_acceptance TEXT CHECK (
        provider_acceptance IS NULL OR provider_acceptance IN (
            'not-sent', 'accepted', 'rejected', 'unknown'
        )
    ),
    pending_reconciliation_ids_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(pending_reconciliation_ids_json)),
    lease_epoch INTEGER CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
    telemetry_watermark INTEGER CHECK (
        telemetry_watermark IS NULL OR telemetry_watermark >= 0
    ),
    content_hash TEXT NOT NULL CHECK (length(content_hash) BETWEEN 16 AND 512),
    idempotency_key_hash TEXT NOT NULL
        CHECK (length(idempotency_key_hash) = 64
               AND idempotency_key_hash = lower(idempotency_key_hash)
               AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX run_checkpoints_idempotency_idx
    ON run_checkpoints(profile_id, idempotency_key_hash);
CREATE INDEX run_checkpoints_run_idx
    ON run_checkpoints(profile_id, run_id, created_at_ms DESC, checkpoint_id DESC);
CREATE INDEX run_checkpoints_scope_idx
    ON run_checkpoints(profile_id, conversation_id, branch_id, created_at_ms DESC);

CREATE TRIGGER run_checkpoints_scope_guard_insert
BEFORE INSERT ON run_checkpoints
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM generations run
        JOIN conversations conversation
          ON conversation.id = run.conversation_id
         AND conversation.profile_id = NEW.profile_id
         AND conversation.deleted_at_ms IS NULL
        JOIN conversation_branches branch
          ON branch.id = run.branch_id
         AND branch.conversation_id = run.conversation_id
         AND branch.deleted_at_ms IS NULL
        WHERE run.id = NEW.run_id
          AND run.conversation_id = NEW.conversation_id
          AND run.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'run checkpoint scope conflict') END;
    SELECT CASE WHEN NEW.attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM run_attempts attempt
        WHERE attempt.id = NEW.attempt_id AND attempt.generation_id = NEW.run_id
    ) THEN RAISE(ABORT, 'run checkpoint attempt scope conflict') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream
          ON stream.id = revision.stream_id
         AND stream.profile_id = NEW.profile_id
         AND stream.conversation_id = NEW.conversation_id
         AND stream.branch_id = NEW.branch_id
        JOIN conversations revision_conversation
          ON revision_conversation.id = stream.conversation_id
         AND revision_conversation.profile_id = NEW.profile_id
         AND revision_conversation.deleted_at_ms IS NULL
        JOIN conversation_branches revision_branch
          ON revision_branch.id = stream.branch_id
         AND revision_branch.conversation_id = stream.conversation_id
         AND revision_branch.deleted_at_ms IS NULL
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'run checkpoint state revision scope conflict') END;
END;

CREATE TRIGGER run_checkpoints_immutable_update
BEFORE UPDATE ON run_checkpoints
BEGIN
    SELECT RAISE(ABORT, 'run checkpoints are immutable');
END;

CREATE TRIGGER run_checkpoints_immutable_delete
BEFORE DELETE ON run_checkpoints
BEGIN
    SELECT RAISE(ABORT, 'run checkpoints are immutable');
END;

CREATE TABLE continuation_intents (
    intent_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    root_kind TEXT NOT NULL CHECK (
        root_kind IN ('run', 'task', 'goal', 'branch', 'checkpoint', 'starter-workflow')
    ),
    root_id TEXT NOT NULL,
    intent_kind TEXT NOT NULL CHECK (
        intent_kind IN ('unfinished-answer', 'next-plan-task', 'resume-checkpoint',
                        'bootstrap-active-goal', 'research-next', 'test-next',
                        'review-next', 'plan-only', 'draft-only')
    ),
    state_revision_id TEXT NOT NULL,
    execution_mode TEXT NOT NULL CHECK (
        execution_mode IN ('preview', 'plan-only', 'draft-only', 'execute')
    ),
    model_profile_id TEXT,
    effort TEXT NOT NULL CHECK (effort IN ('fast', 'balanced', 'deep', 'ultra', 'custom')),
    allowed_tool_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_tool_ids_json)),
    budget_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(budget_json)),
    loop_guard_json TEXT NOT NULL CHECK (json_valid(loop_guard_json)),
    approval_policy_revision TEXT,
    idempotency_key_hash TEXT NOT NULL
        CHECK (length(idempotency_key_hash) = 64
               AND idempotency_key_hash = lower(idempotency_key_hash)
               AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    canonical_payload_hash TEXT NOT NULL
        CHECK (length(canonical_payload_hash) = 64
               AND canonical_payload_hash = lower(canonical_payload_hash)
               AND canonical_payload_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX continuation_intents_idempotency_idx
    ON continuation_intents(profile_id, idempotency_key_hash);
CREATE INDEX continuation_intents_scope_idx
    ON continuation_intents(profile_id, conversation_id, branch_id, created_at_ms DESC);

CREATE TRIGGER continuation_intents_scope_guard_insert
BEFORE INSERT ON continuation_intents
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM conversations conversation
        JOIN conversation_branches branch
          ON branch.id = NEW.branch_id
         AND branch.conversation_id = conversation.id
         AND branch.deleted_at_ms IS NULL
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'continuation intent scope conflict') END;
END;

CREATE TRIGGER continuation_intents_immutable_update
BEFORE UPDATE ON continuation_intents
BEGIN
    SELECT RAISE(ABORT, 'continuation intents are immutable');
END;

CREATE TRIGGER continuation_intents_immutable_delete
BEFORE DELETE ON continuation_intents
BEGIN
    SELECT RAISE(ABORT, 'continuation intents are immutable');
END;

CREATE TABLE message_revisions (
    revision_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES conversation_branches(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('draft', 'user', 'assistant', 'tool', 'system', 'annotation')),
    effect TEXT NOT NULL CHECK (
        effect IN ('edit-draft', 'replace-queued', 'edit-as-branch',
                   'replay-historical', 'retry-current-state',
                   'selected-delta-retry', 'annotation-or-correction')
    ),
    parent_revision_id TEXT,
    source_cursor INTEGER NOT NULL CHECK (source_cursor >= 0),
    destination_branch_id TEXT,
    content_hash TEXT NOT NULL CHECK (length(content_hash) BETWEEN 16 AND 512),
    redaction_class TEXT NOT NULL CHECK (length(redaction_class) BETWEEN 1 AND 120),
    idempotency_key_hash TEXT NOT NULL
        CHECK (length(idempotency_key_hash) = 64
               AND idempotency_key_hash = lower(idempotency_key_hash)
               AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX message_revisions_idempotency_idx
    ON message_revisions(profile_id, idempotency_key_hash);
CREATE INDEX message_revisions_message_idx
    ON message_revisions(profile_id, message_id, source_cursor, created_at_ms DESC);
CREATE INDEX message_revisions_scope_idx
    ON message_revisions(profile_id, conversation_id, branch_id, created_at_ms DESC);

CREATE TRIGGER message_revisions_scope_guard_insert
BEFORE INSERT ON message_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM messages message
        JOIN conversations conversation
          ON conversation.id = message.conversation_id
         AND conversation.profile_id = NEW.profile_id
         AND conversation.deleted_at_ms IS NULL
        JOIN conversation_branches branch
          ON branch.id = message.branch_id
         AND branch.conversation_id = message.conversation_id
         AND branch.deleted_at_ms IS NULL
        WHERE message.id = NEW.message_id
          AND message.conversation_id = NEW.conversation_id
          AND message.branch_id = NEW.branch_id
          AND message.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'message revision source scope conflict') END;
    SELECT CASE WHEN NEW.destination_branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches destination
        WHERE destination.id = NEW.destination_branch_id
          AND destination.conversation_id = NEW.conversation_id
          AND destination.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'message revision destination scope conflict') END;
END;

CREATE TRIGGER message_revisions_immutable_update
BEFORE UPDATE ON message_revisions
BEGIN
    SELECT RAISE(ABORT, 'message revisions are immutable');
END;

CREATE TRIGGER message_revisions_immutable_delete
BEFORE DELETE ON message_revisions
BEGIN
    SELECT RAISE(ABORT, 'message revisions are immutable');
END;

-- Omnia schema v16: authoritative goals, tasks, and starter workflows.
--
-- These tables are the native continuation-root authority.  Renderer IDs are
-- only admissible when the corresponding live row, revision, scope lineage,
-- and optional state anchor all resolve in the same SQLite transaction.  The
-- definition JSON is a bounded, canonical metadata manifest; prompt bodies,
-- credentials, cookies, raw provider payloads, and local filesystem paths do
-- not belong in these tables.

CREATE TABLE goals (
    id TEXT PRIMARY KEY CHECK (
        length(id) BETWEEN 37 AND 256 AND id GLOB 'goal_*'
    ),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE RESTRICT,
    branch_id TEXT REFERENCES conversation_branches(id) ON DELETE RESTRICT,
    current_revision_id TEXT,
    state_revision_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'active', 'paused', 'completed', 'archived', 'cancelled')
    ),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    description TEXT CHECK (description IS NULL OR length(description) <= 16000),
    acceptance_criteria_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(acceptance_criteria_json)
               AND json_type(acceptance_criteria_json) = 'array'
               AND length(acceptance_criteria_json) <= 262144),
    roadmap_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(roadmap_json)
               AND json_type(roadmap_json) = 'object'
               AND length(roadmap_json) <= 262144),
    metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json)
               AND json_type(metadata_json) = 'object'
               AND length(metadata_json) <= 262144),
    canonical_payload_sha256 TEXT NOT NULL CHECK (
        length(canonical_payload_sha256) = 64
        AND canonical_payload_sha256 = lower(canonical_payload_sha256)
        AND canonical_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    deleted_at_ms INTEGER,
    CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX goals_profile_idx ON goals(profile_id, deleted_at_ms, status, updated_at_ms DESC);
CREATE INDEX goals_project_idx ON goals(profile_id, project_id, deleted_at_ms, updated_at_ms DESC);
CREATE INDEX goals_conversation_idx
    ON goals(profile_id, conversation_id, branch_id, deleted_at_ms, updated_at_ms DESC);
CREATE INDEX goals_revision_idx ON goals(profile_id, current_revision_id);
CREATE INDEX goals_state_revision_idx ON goals(profile_id, state_revision_id);

CREATE TABLE goal_revisions (
    revision_id TEXT PRIMARY KEY CHECK (
        length(revision_id) BETWEEN 46 AND 256 AND revision_id GLOB 'goal_revision_*'
    ),
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json)
               AND json_type(payload_json) = 'object'
               AND length(payload_json) <= 524288),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64
        AND content_sha256 = lower(content_sha256)
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    state_revision_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (goal_id, revision_no)
) STRICT;

CREATE INDEX goal_revisions_goal_idx ON goal_revisions(goal_id, revision_no DESC, created_at_ms DESC);
CREATE INDEX goal_revisions_state_idx ON goal_revisions(state_revision_id, goal_id);

CREATE TRIGGER goals_scope_guard_insert
BEFORE INSERT ON goals
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles profile
        WHERE profile.id = NEW.profile_id AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'goal profile scope conflict') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'goal project scope conflict') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR conversation.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'goal conversation scope conflict') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'goal branch scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'goal state revision must exist') END;
END;

-- A root is inserted before its first immutable revision is created.  Keep
-- the nullable pointer empty during that bootstrap step; once populated it
-- must already address a revision owned by this exact goal.  This INSERT
-- guard complements the UPDATE guard below and closes the direct-SQL/import
-- path that could otherwise create an authority root pointing at another
-- root's revision.
CREATE TRIGGER goals_current_revision_insert_guard
BEFORE INSERT ON goals
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM goal_revisions revision
        WHERE revision.revision_id = NEW.current_revision_id
          AND revision.goal_id = NEW.id
    ) THEN RAISE(ABORT, 'goal current revision scope conflict') END;
END;

CREATE TRIGGER goals_scope_guard_update
BEFORE UPDATE OF profile_id, project_id, conversation_id, branch_id,
                 current_revision_id, state_revision_id, status, title,
                 description, acceptance_criteria_json, roadmap_json,
                 metadata_json, canonical_payload_sha256, created_at_ms,
                 updated_at_ms, deleted_at_ms ON goals
BEGIN
    SELECT CASE WHEN NEW.id <> OLD.id OR NEW.profile_id <> OLD.profile_id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.conversation_id IS NOT OLD.conversation_id
        OR NEW.branch_id IS NOT OLD.branch_id
        OR NEW.created_at_ms <> OLD.created_at_ms
        THEN RAISE(ABORT, 'goal identity and scope are immutable') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'goal project scope conflict') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR conversation.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'goal conversation scope conflict') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'goal branch scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'goal state revision must exist') END;
END;

CREATE TRIGGER goals_current_revision_guard
BEFORE UPDATE OF current_revision_id ON goals
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM goal_revisions revision
        WHERE revision.revision_id = NEW.current_revision_id
          AND revision.goal_id = NEW.id
    ) THEN RAISE(ABORT, 'goal current revision scope conflict') END;
END;

CREATE TRIGGER goals_immutable_delete_guard
BEFORE DELETE ON goals
BEGIN
    SELECT RAISE(ABORT, 'goals are lifecycle records and cannot be deleted');
END;

CREATE TRIGGER goal_revisions_scope_guard_insert
BEFORE INSERT ON goal_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM goals goal
        WHERE goal.id = NEW.goal_id
          AND goal.profile_id = (SELECT profile_id FROM goals WHERE id = NEW.goal_id)
    ) THEN RAISE(ABORT, 'goal revision source scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'goal revision state anchor must exist') END;
END;

CREATE TRIGGER goal_revisions_immutable_update
BEFORE UPDATE ON goal_revisions
BEGIN
    SELECT RAISE(ABORT, 'goal revisions are immutable');
END;

CREATE TRIGGER goal_revisions_immutable_delete
BEFORE DELETE ON goal_revisions
BEGIN
    SELECT RAISE(ABORT, 'goal revisions are immutable');
END;

CREATE TABLE tasks (
    id TEXT PRIMARY KEY CHECK (
        length(id) BETWEEN 37 AND 256 AND id GLOB 'task_*'
    ),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
    project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE RESTRICT,
    branch_id TEXT REFERENCES conversation_branches(id) ON DELETE RESTRICT,
    current_revision_id TEXT,
    state_revision_id TEXT,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'ready', 'in_progress', 'blocked', 'completed', 'cancelled', 'archived')
    ),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    description TEXT CHECK (description IS NULL OR length(description) <= 16000),
    metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (json_valid(metadata_json)
               AND json_type(metadata_json) = 'object'
               AND length(metadata_json) <= 262144),
    canonical_payload_sha256 TEXT NOT NULL CHECK (
        length(canonical_payload_sha256) = 64
        AND canonical_payload_sha256 = lower(canonical_payload_sha256)
        AND canonical_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    deleted_at_ms INTEGER,
    CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX tasks_profile_idx ON tasks(profile_id, deleted_at_ms, status, updated_at_ms DESC);
CREATE INDEX tasks_goal_idx ON tasks(profile_id, goal_id, deleted_at_ms, status, updated_at_ms DESC);
CREATE INDEX tasks_project_idx ON tasks(profile_id, project_id, deleted_at_ms, updated_at_ms DESC);
CREATE INDEX tasks_conversation_idx
    ON tasks(profile_id, conversation_id, branch_id, deleted_at_ms, updated_at_ms DESC);
CREATE INDEX tasks_revision_idx ON tasks(profile_id, current_revision_id);
CREATE INDEX tasks_state_revision_idx ON tasks(profile_id, state_revision_id);

CREATE TABLE task_revisions (
    revision_id TEXT PRIMARY KEY CHECK (
        length(revision_id) BETWEEN 46 AND 256 AND revision_id GLOB 'task_revision_*'
    ),
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    payload_json TEXT NOT NULL
        CHECK (json_valid(payload_json)
               AND json_type(payload_json) = 'object'
               AND length(payload_json) <= 524288),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64
        AND content_sha256 = lower(content_sha256)
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    state_revision_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (task_id, revision_no)
) STRICT;

CREATE INDEX task_revisions_task_idx ON task_revisions(task_id, revision_no DESC, created_at_ms DESC);
CREATE INDEX task_revisions_state_idx ON task_revisions(state_revision_id, task_id);

CREATE TRIGGER tasks_scope_guard_insert
BEFORE INSERT ON tasks
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM goals goal
        WHERE goal.id = NEW.goal_id
          AND goal.profile_id = NEW.profile_id
          AND goal.deleted_at_ms IS NULL
          AND goal.status NOT IN ('archived', 'cancelled')
    ) THEN RAISE(ABORT, 'task goal lineage conflict') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles profile
        WHERE profile.id = NEW.profile_id AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task profile scope conflict') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task project scope conflict') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR conversation.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'task conversation scope conflict') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task branch scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'task state revision must exist') END;
END;

CREATE TRIGGER tasks_current_revision_insert_guard
BEFORE INSERT ON tasks
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM task_revisions revision
        WHERE revision.revision_id = NEW.current_revision_id
          AND revision.task_id = NEW.id
    ) THEN RAISE(ABORT, 'task current revision scope conflict') END;
END;

CREATE TRIGGER tasks_scope_guard_update
BEFORE UPDATE OF profile_id, goal_id, project_id, conversation_id, branch_id,
                 current_revision_id, state_revision_id, status, title,
                 description, metadata_json, canonical_payload_sha256,
                 created_at_ms, updated_at_ms, deleted_at_ms ON tasks
BEGIN
    SELECT CASE WHEN NEW.id <> OLD.id OR NEW.profile_id <> OLD.profile_id
        OR NEW.goal_id <> OLD.goal_id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.conversation_id IS NOT OLD.conversation_id
        OR NEW.branch_id IS NOT OLD.branch_id
        OR NEW.created_at_ms <> OLD.created_at_ms
        THEN RAISE(ABORT, 'task identity and lineage are immutable') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM goals goal
        WHERE goal.id = NEW.goal_id
          AND goal.profile_id = NEW.profile_id
          AND goal.deleted_at_ms IS NULL
          AND goal.status NOT IN ('archived', 'cancelled')
    ) THEN RAISE(ABORT, 'task goal lineage conflict') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task project scope conflict') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR conversation.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'task conversation scope conflict') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task branch scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'task state revision must exist') END;
END;

CREATE TRIGGER tasks_current_revision_guard
BEFORE UPDATE OF current_revision_id ON tasks
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM task_revisions revision
        WHERE revision.revision_id = NEW.current_revision_id
          AND revision.task_id = NEW.id
    ) THEN RAISE(ABORT, 'task current revision scope conflict') END;
END;

CREATE TRIGGER tasks_immutable_delete_guard
BEFORE DELETE ON tasks
BEGIN
    SELECT RAISE(ABORT, 'tasks are lifecycle records and cannot be deleted');
END;

CREATE TRIGGER task_revisions_scope_guard_insert
BEFORE INSERT ON task_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM tasks task
        WHERE task.id = NEW.task_id
          AND task.goal_id IS NOT NULL
    ) THEN RAISE(ABORT, 'task revision source scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'task revision state anchor must exist') END;
END;

CREATE TRIGGER task_revisions_immutable_update
BEFORE UPDATE ON task_revisions
BEGIN
    SELECT RAISE(ABORT, 'task revisions are immutable');
END;

CREATE TRIGGER task_revisions_immutable_delete
BEFORE DELETE ON task_revisions
BEGIN
    SELECT RAISE(ABORT, 'task revisions are immutable');
END;

CREATE TABLE task_dependencies (
    id TEXT PRIMARY KEY CHECK (
        length(id) BETWEEN 48 AND 256 AND id GLOB 'task_dependency_*'
    ),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    to_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    dependency_kind TEXT NOT NULL CHECK (
        dependency_kind IN ('blocks', 'requires', 'related')
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (profile_id, from_task_id, to_task_id, dependency_kind),
    CHECK (from_task_id <> to_task_id)
) STRICT;

CREATE INDEX task_dependencies_from_idx
    ON task_dependencies(profile_id, from_task_id, dependency_kind, to_task_id);
CREATE INDEX task_dependencies_to_idx
    ON task_dependencies(profile_id, to_task_id, dependency_kind, from_task_id);

CREATE TRIGGER task_dependencies_scope_guard_insert
BEFORE INSERT ON task_dependencies
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tasks source
        JOIN tasks target
          ON target.id = NEW.to_task_id
         AND target.profile_id = NEW.profile_id
         AND target.goal_id = source.goal_id
         AND target.deleted_at_ms IS NULL
        WHERE source.id = NEW.from_task_id
          AND source.profile_id = NEW.profile_id
          AND source.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task dependency scope conflict') END;
    SELECT CASE WHEN NEW.dependency_kind IN ('blocks', 'requires') AND EXISTS (
        WITH RECURSIVE reachable(task_id) AS (
            SELECT NEW.to_task_id
            UNION
            SELECT dependency.to_task_id
            FROM task_dependencies dependency
            JOIN reachable ON reachable.task_id = dependency.from_task_id
            WHERE dependency.profile_id = NEW.profile_id
        )
        SELECT 1 FROM reachable WHERE task_id = NEW.from_task_id
    ) THEN RAISE(ABORT, 'task dependency cycle detected') END;
END;

CREATE TRIGGER task_dependencies_immutable_update
BEFORE UPDATE ON task_dependencies
BEGIN
    SELECT RAISE(ABORT, 'task dependencies are immutable');
END;

CREATE TRIGGER task_dependencies_immutable_delete
BEFORE DELETE ON task_dependencies
BEGIN
    SELECT RAISE(ABORT, 'task dependencies are immutable');
END;

CREATE TABLE starter_workflows (
    id TEXT PRIMARY KEY CHECK (
        length(id) BETWEEN 49 AND 256 AND id GLOB 'starter_workflow_*'
    ),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE RESTRICT,
    branch_id TEXT REFERENCES conversation_branches(id) ON DELETE RESTRICT,
    current_revision_id TEXT,
    state_revision_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
    description TEXT CHECK (description IS NULL OR length(description) <= 16000),
    definition_json TEXT NOT NULL
        CHECK (json_valid(definition_json)
               AND json_type(definition_json) = 'object'
               AND length(definition_json) <= 524288),
    canonical_payload_sha256 TEXT NOT NULL CHECK (
        length(canonical_payload_sha256) = 64
        AND canonical_payload_sha256 = lower(canonical_payload_sha256)
        AND canonical_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    deleted_at_ms INTEGER,
    CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX starter_workflows_profile_idx
    ON starter_workflows(profile_id, deleted_at_ms, status, enabled, updated_at_ms DESC);
CREATE INDEX starter_workflows_project_idx
    ON starter_workflows(profile_id, project_id, deleted_at_ms, updated_at_ms DESC);
CREATE INDEX starter_workflows_conversation_idx
    ON starter_workflows(profile_id, conversation_id, branch_id, deleted_at_ms, updated_at_ms DESC);
CREATE INDEX starter_workflows_revision_idx
    ON starter_workflows(profile_id, current_revision_id);
CREATE INDEX starter_workflows_state_revision_idx
    ON starter_workflows(profile_id, state_revision_id);

CREATE TABLE starter_workflow_revisions (
    revision_id TEXT PRIMARY KEY CHECK (
        length(revision_id) BETWEEN 58 AND 256
        AND revision_id GLOB 'starter_workflow_revision_*'
    ),
    starter_workflow_id TEXT NOT NULL REFERENCES starter_workflows(id) ON DELETE RESTRICT,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    definition_json TEXT NOT NULL
        CHECK (json_valid(definition_json)
               AND json_type(definition_json) = 'object'
               AND length(definition_json) <= 1048576),
    content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256) = 64
        AND content_sha256 = lower(content_sha256)
        AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    state_revision_id TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (starter_workflow_id, revision_no)
) STRICT;

CREATE INDEX starter_workflow_revisions_workflow_idx
    ON starter_workflow_revisions(starter_workflow_id, revision_no DESC, created_at_ms DESC);
CREATE INDEX starter_workflow_revisions_state_idx
    ON starter_workflow_revisions(state_revision_id, starter_workflow_id);

CREATE TRIGGER starter_workflows_scope_guard_insert
BEFORE INSERT ON starter_workflows
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles profile
        WHERE profile.id = NEW.profile_id AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'starter workflow profile scope conflict') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'starter workflow project scope conflict') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR conversation.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'starter workflow conversation scope conflict') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'starter workflow branch scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'starter workflow state revision must exist') END;
END;

CREATE TRIGGER starter_workflows_current_revision_insert_guard
BEFORE INSERT ON starter_workflows
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM starter_workflow_revisions revision
        WHERE revision.revision_id = NEW.current_revision_id
          AND revision.starter_workflow_id = NEW.id
    ) THEN RAISE(ABORT, 'starter workflow current revision scope conflict') END;
END;

CREATE TRIGGER starter_workflows_scope_guard_update
BEFORE UPDATE OF profile_id, project_id, conversation_id, branch_id,
                 current_revision_id, state_revision_id, status, enabled,
                 name, title, description, definition_json,
                 canonical_payload_sha256, created_at_ms, updated_at_ms,
                 deleted_at_ms ON starter_workflows
BEGIN
    SELECT CASE WHEN NEW.id <> OLD.id OR NEW.profile_id <> OLD.profile_id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.conversation_id IS NOT OLD.conversation_id
        OR NEW.branch_id IS NOT OLD.branch_id
        OR NEW.created_at_ms <> OLD.created_at_ms
        THEN RAISE(ABORT, 'starter workflow identity and scope are immutable') END;
    SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project
        WHERE project.id = NEW.project_id
          AND project.profile_id = NEW.profile_id
          AND project.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'starter workflow project scope conflict') END;
    SELECT CASE WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = NEW.conversation_id
          AND conversation.profile_id = NEW.profile_id
          AND conversation.deleted_at_ms IS NULL
          AND (NEW.project_id IS NULL OR conversation.project_id = NEW.project_id)
    ) THEN RAISE(ABORT, 'starter workflow conversation scope conflict') END;
    SELECT CASE WHEN NEW.branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM conversation_branches branch
        WHERE branch.id = NEW.branch_id
          AND branch.conversation_id = NEW.conversation_id
          AND branch.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'starter workflow branch scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'starter workflow state revision must exist') END;
END;

CREATE TRIGGER starter_workflows_current_revision_guard
BEFORE UPDATE OF current_revision_id ON starter_workflows
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM starter_workflow_revisions revision
        WHERE revision.revision_id = NEW.current_revision_id
          AND revision.starter_workflow_id = NEW.id
    ) THEN RAISE(ABORT, 'starter workflow current revision scope conflict') END;
END;

CREATE TRIGGER starter_workflows_immutable_delete_guard
BEFORE DELETE ON starter_workflows
BEGIN
    SELECT RAISE(ABORT, 'starter workflows are lifecycle records and cannot be deleted');
END;

CREATE TRIGGER starter_workflow_revisions_scope_guard_insert
BEFORE INSERT ON starter_workflow_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM starter_workflows workflow
        WHERE workflow.id = NEW.starter_workflow_id
    ) THEN RAISE(ABORT, 'starter workflow revision source scope conflict') END;
    SELECT CASE WHEN NEW.state_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM state_revisions revision
        WHERE revision.id = NEW.state_revision_id
    ) THEN RAISE(ABORT, 'starter workflow revision state anchor must exist') END;
END;

CREATE TRIGGER starter_workflow_revisions_immutable_update
BEFORE UPDATE ON starter_workflow_revisions
BEGIN
    SELECT RAISE(ABORT, 'starter workflow revisions are immutable');
END;

CREATE TRIGGER starter_workflow_revisions_immutable_delete
BEFORE DELETE ON starter_workflow_revisions
BEGIN
    SELECT RAISE(ABORT, 'starter workflow revisions are immutable');
END;

-- Omnia schema v17: authoritative-root state-anchor stream guards.
--
-- v16 verified that a root/revision state anchor existed, but existence alone
-- is not sufficient authority: a restored or direct-SQL row could point at a
-- revision from another profile, conversation, or branch. State revisions are
-- stream-scoped native facts with mandatory conversation+branch identity. A
-- global/project root may therefore remain unanchored, but every non-null
-- anchor below must resolve to the exact profile/conversation/branch lineage.
-- The bootstrap/current-revision ordering remains unchanged; these are
-- additive protection triggers for fresh installs and v16->v17 migrations.

CREATE TRIGGER goals_state_revision_scope_guard_insert
BEFORE INSERT ON goals
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE revision.id = NEW.state_revision_id
          AND NEW.conversation_id IS NOT NULL
          AND NEW.branch_id IS NOT NULL
          AND stream.profile_id = NEW.profile_id
          AND stream.conversation_id = NEW.conversation_id
          AND stream.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'goal state revision scope conflict') END;
END;

CREATE TRIGGER goals_state_revision_scope_guard_update
BEFORE UPDATE OF profile_id, conversation_id, branch_id, state_revision_id ON goals
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE revision.id = NEW.state_revision_id
          AND NEW.conversation_id IS NOT NULL
          AND NEW.branch_id IS NOT NULL
          AND stream.profile_id = NEW.profile_id
          AND stream.conversation_id = NEW.conversation_id
          AND stream.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'goal state revision scope conflict') END;
END;

CREATE TRIGGER goal_revisions_state_revision_scope_guard_insert
BEFORE INSERT ON goal_revisions
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM goals goal
        JOIN state_revisions revision ON revision.id = NEW.state_revision_id
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE goal.id = NEW.goal_id
          AND goal.conversation_id IS NOT NULL
          AND goal.branch_id IS NOT NULL
          AND stream.profile_id = goal.profile_id
          AND stream.conversation_id = goal.conversation_id
          AND stream.branch_id = goal.branch_id
    ) THEN RAISE(ABORT, 'goal revision state anchor scope conflict') END;
END;

CREATE TRIGGER tasks_state_revision_scope_guard_insert
BEFORE INSERT ON tasks
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE revision.id = NEW.state_revision_id
          AND NEW.conversation_id IS NOT NULL
          AND NEW.branch_id IS NOT NULL
          AND stream.profile_id = NEW.profile_id
          AND stream.conversation_id = NEW.conversation_id
          AND stream.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'task state revision scope conflict') END;
END;

CREATE TRIGGER tasks_state_revision_scope_guard_update
BEFORE UPDATE OF profile_id, conversation_id, branch_id, state_revision_id ON tasks
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE revision.id = NEW.state_revision_id
          AND NEW.conversation_id IS NOT NULL
          AND NEW.branch_id IS NOT NULL
          AND stream.profile_id = NEW.profile_id
          AND stream.conversation_id = NEW.conversation_id
          AND stream.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'task state revision scope conflict') END;
END;

CREATE TRIGGER task_revisions_state_revision_scope_guard_insert
BEFORE INSERT ON task_revisions
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tasks task
        JOIN state_revisions revision ON revision.id = NEW.state_revision_id
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE task.id = NEW.task_id
          AND task.conversation_id IS NOT NULL
          AND task.branch_id IS NOT NULL
          AND stream.profile_id = task.profile_id
          AND stream.conversation_id = task.conversation_id
          AND stream.branch_id = task.branch_id
    ) THEN RAISE(ABORT, 'task revision state anchor scope conflict') END;
END;

CREATE TRIGGER starter_workflows_state_revision_scope_guard_insert
BEFORE INSERT ON starter_workflows
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE revision.id = NEW.state_revision_id
          AND NEW.conversation_id IS NOT NULL
          AND NEW.branch_id IS NOT NULL
          AND stream.profile_id = NEW.profile_id
          AND stream.conversation_id = NEW.conversation_id
          AND stream.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'starter workflow state revision scope conflict') END;
END;

CREATE TRIGGER starter_workflows_state_revision_scope_guard_update
BEFORE UPDATE OF profile_id, conversation_id, branch_id, state_revision_id ON starter_workflows
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM state_revisions revision
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE revision.id = NEW.state_revision_id
          AND NEW.conversation_id IS NOT NULL
          AND NEW.branch_id IS NOT NULL
          AND stream.profile_id = NEW.profile_id
          AND stream.conversation_id = NEW.conversation_id
          AND stream.branch_id = NEW.branch_id
    ) THEN RAISE(ABORT, 'starter workflow state revision scope conflict') END;
END;

CREATE TRIGGER starter_workflow_revisions_state_revision_scope_guard_insert
BEFORE INSERT ON starter_workflow_revisions
WHEN NEW.state_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM starter_workflows workflow
        JOIN state_revisions revision ON revision.id = NEW.state_revision_id
        JOIN state_revision_streams stream ON stream.id = revision.stream_id
        WHERE workflow.id = NEW.starter_workflow_id
          AND workflow.conversation_id IS NOT NULL
          AND workflow.branch_id IS NOT NULL
          AND stream.profile_id = workflow.profile_id
          AND stream.conversation_id = workflow.conversation_id
          AND stream.branch_id = workflow.branch_id
    ) THEN RAISE(ABORT, 'starter workflow revision state anchor scope conflict') END;
END;

-- Omnia schema v18: immutable authoritative-root mutation receipts.
--
-- Root/revision tables intentionally do not carry an idempotency key.  This
-- shared receipt address lets native goal/task/workflow writers replay an
-- exact mutation without adding renderer-controlled identity to the root
-- tables.  The receipt is a redacted projection only; prompt bodies,
-- credentials, cookies, provider payloads, and filesystem paths are excluded.
CREATE TABLE authoritative_root_mutation_receipts (
    receipt_id TEXT PRIMARY KEY CHECK (
        length(receipt_id) BETWEEN 45 AND 256
        AND receipt_id GLOB 'root_receipt_*'
    ),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    idempotency_key_hash TEXT NOT NULL CHECK (
        length(idempotency_key_hash) = 64
        AND idempotency_key_hash = lower(idempotency_key_hash)
        AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    root_kind TEXT NOT NULL CHECK (
        root_kind IN ('goal', 'task', 'starter-workflow')
    ),
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN (
            'goal.create', 'goal.revision.create', 'goal.status.update',
            'task.create', 'task.revision.create', 'task.status.update',
            'starter-workflow.create', 'starter-workflow.revision.create',
            'starter-workflow.status.update'
        )
    ),
    root_id TEXT NOT NULL CHECK (length(root_id) BETWEEN 37 AND 256),
    revision_id TEXT CHECK (revision_id IS NULL OR length(revision_id) BETWEEN 46 AND 256),
    canonical_payload_sha256 TEXT NOT NULL CHECK (
        length(canonical_payload_sha256) = 64
        AND canonical_payload_sha256 = lower(canonical_payload_sha256)
        AND canonical_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    scope_json TEXT NOT NULL CHECK (
        json_valid(scope_json)
        AND json_type(scope_json) = 'object'
        AND length(scope_json) <= 16384
    ),
    result_json TEXT NOT NULL CHECK (
        json_valid(result_json)
        AND json_type(result_json) = 'object'
        AND length(result_json) <= 65536
    ),
    receipt_sha256 TEXT NOT NULL CHECK (
        length(receipt_sha256) = 64
        AND receipt_sha256 = lower(receipt_sha256)
        AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (profile_id, idempotency_key_hash, root_kind, operation_kind)
) STRICT;

CREATE INDEX authoritative_root_receipts_root_idx
    ON authoritative_root_mutation_receipts(profile_id, root_kind, root_id, created_at_ms DESC);
CREATE INDEX authoritative_root_receipts_revision_idx
    ON authoritative_root_mutation_receipts(profile_id, revision_id, created_at_ms DESC);

CREATE TRIGGER authoritative_root_receipts_scope_guard_insert
BEFORE INSERT ON authoritative_root_mutation_receipts
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles profile
        WHERE profile.id = NEW.profile_id AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'authoritative root receipt profile scope conflict') END;
    SELECT CASE WHEN (NEW.root_kind = 'goal' AND NOT EXISTS (
        SELECT 1 FROM goals root
        WHERE root.id = NEW.root_id AND root.profile_id = NEW.profile_id
    )) THEN RAISE(ABORT, 'authoritative root receipt goal scope conflict') END;
    SELECT CASE WHEN (NEW.root_kind = 'task' AND NOT EXISTS (
        SELECT 1 FROM tasks root
        WHERE root.id = NEW.root_id AND root.profile_id = NEW.profile_id
    )) THEN RAISE(ABORT, 'authoritative root receipt task scope conflict') END;
    SELECT CASE WHEN (NEW.root_kind = 'starter-workflow' AND NOT EXISTS (
        SELECT 1 FROM starter_workflows root
        WHERE root.id = NEW.root_id AND root.profile_id = NEW.profile_id
    )) THEN RAISE(ABORT, 'authoritative root receipt workflow scope conflict') END;
    SELECT CASE WHEN NEW.root_kind = 'goal' AND NEW.operation_kind NOT LIKE 'goal.%'
        THEN RAISE(ABORT, 'authoritative root receipt operation scope conflict') END;
    SELECT CASE WHEN NEW.root_kind = 'task' AND NEW.operation_kind NOT LIKE 'task.%'
        THEN RAISE(ABORT, 'authoritative root receipt operation scope conflict') END;
    SELECT CASE WHEN NEW.root_kind = 'starter-workflow'
                      AND NEW.operation_kind NOT LIKE 'starter-workflow.%'
        THEN RAISE(ABORT, 'authoritative root receipt operation scope conflict') END;
    SELECT CASE WHEN NEW.revision_id IS NOT NULL AND NEW.root_kind = 'goal'
                      AND NOT EXISTS (
        SELECT 1 FROM goal_revisions revision
        WHERE revision.revision_id = NEW.revision_id
          AND revision.goal_id = NEW.root_id
    ) THEN RAISE(ABORT, 'authoritative root receipt revision scope conflict') END;
    SELECT CASE WHEN NEW.revision_id IS NOT NULL AND NEW.root_kind = 'task'
                      AND NOT EXISTS (
        SELECT 1 FROM task_revisions revision
        WHERE revision.revision_id = NEW.revision_id
          AND revision.task_id = NEW.root_id
    ) THEN RAISE(ABORT, 'authoritative root receipt revision scope conflict') END;
    SELECT CASE WHEN NEW.revision_id IS NOT NULL AND NEW.root_kind = 'starter-workflow'
                      AND NOT EXISTS (
        SELECT 1 FROM starter_workflow_revisions revision
        WHERE revision.revision_id = NEW.revision_id
          AND revision.starter_workflow_id = NEW.root_id
    ) THEN RAISE(ABORT, 'authoritative root receipt revision scope conflict') END;
END;

CREATE TRIGGER authoritative_root_receipts_immutable_update
BEFORE UPDATE ON authoritative_root_mutation_receipts
BEGIN
    SELECT RAISE(ABORT, 'authoritative root mutation receipts are immutable');
END;

CREATE TRIGGER authoritative_root_receipts_immutable_delete
BEFORE DELETE ON authoritative_root_mutation_receipts
BEGIN
    SELECT RAISE(ABORT, 'authoritative root mutation receipts are immutable');
END;

-- Omnia schema v19: terminal task dependency insertion guards.
--
-- Dependency rows are immutable facts.  A dependency may only be created
-- between live, non-terminal tasks in the same profile and goal.  Existing
-- rows are intentionally left untouched when a task later becomes terminal;
-- this migration hardens the insertion boundary without rewriting history.
DROP TRIGGER IF EXISTS task_dependencies_scope_guard_insert;

CREATE TRIGGER task_dependencies_scope_guard_insert
BEFORE INSERT ON task_dependencies
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM tasks source
        JOIN tasks target
          ON target.id = NEW.to_task_id
         AND target.profile_id = NEW.profile_id
         AND target.goal_id = source.goal_id
         AND target.deleted_at_ms IS NULL
        WHERE source.id = NEW.from_task_id
          AND source.profile_id = NEW.profile_id
          AND source.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'task dependency scope conflict') END;
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM tasks source
        WHERE source.id = NEW.from_task_id
          AND source.profile_id = NEW.profile_id
          AND source.status IN ('completed', 'cancelled', 'archived')
    ) THEN RAISE(ABORT, 'task dependency source is terminal') END;
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM tasks target
        WHERE target.id = NEW.to_task_id
          AND target.profile_id = NEW.profile_id
          AND target.status IN ('completed', 'cancelled', 'archived')
    ) THEN RAISE(ABORT, 'task dependency target is terminal') END;
    SELECT CASE WHEN NEW.dependency_kind IN ('blocks', 'requires') AND EXISTS (
        WITH RECURSIVE reachable(task_id) AS (
            SELECT NEW.to_task_id
            UNION
            SELECT dependency.to_task_id
            FROM task_dependencies dependency
            JOIN reachable ON reachable.task_id = dependency.from_task_id
            WHERE dependency.profile_id = NEW.profile_id
        )
        SELECT 1 FROM reachable WHERE task_id = NEW.from_task_id
    ) THEN RAISE(ABORT, 'task dependency cycle detected') END;
END;

-- Omnia schema v20: immutable provider-definition revisions.
--
-- A prepared provider attempt retains the exact transport definition selected
-- at preparation time. Only bounded transport metadata and an opaque
-- credential-store reference are stored; secret bytes, headers, cookies and
-- request bodies never cross this boundary. Credential revocation is still
-- evaluated against the live profile and secret store immediately before
-- dispatch.
CREATE TABLE provider_definition_revisions (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    provider_profile_id TEXT NOT NULL
        REFERENCES provider_profiles(id) ON DELETE RESTRICT,
    provider_type TEXT NOT NULL CHECK (length(provider_type) BETWEEN 1 AND 80),
    normalized_base_url TEXT NOT NULL CHECK (length(normalized_base_url) BETWEEN 1 AND 4096),
    auth_scheme TEXT NOT NULL CHECK (length(auth_scheme) BETWEEN 1 AND 40),
    organization_id TEXT,
    remote_project_id TEXT,
    credential_ref TEXT,
    local_network_grant INTEGER NOT NULL CHECK (local_network_grant IN (0, 1)),
    adapter_revision TEXT NOT NULL CHECK (length(adapter_revision) BETWEEN 1 AND 160),
    definition_sha256 TEXT NOT NULL CHECK (
        length(definition_sha256) = 64
        AND definition_sha256 = lower(definition_sha256)
        AND definition_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX provider_definition_revisions_profile_hash_idx
    ON provider_definition_revisions(provider_profile_id, definition_sha256);
CREATE INDEX provider_definition_revisions_profile_created_idx
    ON provider_definition_revisions(provider_profile_id, created_at_ms DESC, id DESC);

CREATE TRIGGER provider_definition_revisions_scope_guard_insert
BEFORE INSERT ON provider_definition_revisions
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_profiles profile
        WHERE profile.id = NEW.provider_profile_id
          AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'provider definition revision profile scope conflict') END;
    SELECT CASE WHEN NEW.credential_ref IS NOT NULL
                      AND (length(NEW.credential_ref) <> 48
                           OR substr(NEW.credential_ref, 1, 16) <> 'provider_secret_'
                           OR substr(NEW.credential_ref, 17) GLOB '*[^0-9a-f]*')
        THEN RAISE(ABORT, 'provider definition revision credential reference is invalid') END;
END;

CREATE TRIGGER provider_definition_revisions_immutable_update
BEFORE UPDATE ON provider_definition_revisions
BEGIN
    SELECT RAISE(ABORT, 'provider definition revisions are immutable');
END;

CREATE TRIGGER provider_definition_revisions_immutable_delete
BEFORE DELETE ON provider_definition_revisions
BEGIN
    SELECT RAISE(ABORT, 'provider definition revisions are immutable');
END;

ALTER TABLE provider_attempt_lineage_facts
    ADD COLUMN provider_definition_revision_id TEXT
        REFERENCES provider_definition_revisions(id) ON DELETE RESTRICT;

CREATE INDEX provider_attempt_lineage_facts_definition_revision_idx
    ON provider_attempt_lineage_facts(provider_definition_revision_id);

CREATE TRIGGER provider_attempt_lineage_provider_definition_revision_scope_guard
BEFORE INSERT ON provider_attempt_lineage_facts
WHEN NEW.provider_definition_revision_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1
        FROM provider_definition_revisions revision
        WHERE revision.id = NEW.provider_definition_revision_id
          AND revision.provider_profile_id = NEW.provider_profile_id
    ) THEN RAISE(ABORT, 'provider attempt definition revision scope conflict') END;
END;

-- Omnia schema v21: run-scoped retrieval receipt lifecycle.
-- Retrieval evidence is append-only and remains bound to the exact prepared
-- attempt. It carries hashes and bounded identifiers, never source content.

-- Omnia schema v22: immutable provider catalog snapshots.
--
-- A successful provider discovery is retained as bounded, content-free
-- provenance for routing and prepared-attempt lineage. The model descriptor
-- JSON contains only the sanitized catalog projection produced by the native
-- adapter; credentials, headers, URLs, cookies and response bodies never
-- cross this boundary. Snapshots are immutable and deduplicated by profile
-- and content hash, so a failed refresh leaves the last known catalog intact.
CREATE TABLE provider_catalog_snapshots (
    id TEXT PRIMARY KEY
        CHECK (length(id) BETWEEN 17 AND 512
               AND substr(id, 1, 17) = 'catalog_snapshot_'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    provider_profile_id TEXT NOT NULL
        REFERENCES provider_profiles(id) ON DELETE RESTRICT,
    snapshot_sha256 TEXT NOT NULL CHECK (
        length(snapshot_sha256) = 64
        AND snapshot_sha256 = lower(snapshot_sha256)
        AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    models_json TEXT NOT NULL CHECK (
        json_valid(models_json)
        AND json_type(models_json) = 'array'
        AND length(CAST(models_json AS BLOB)) BETWEEN 2 AND 524288
    ),
    discovered_at_ms INTEGER NOT NULL CHECK (discovered_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX provider_catalog_snapshots_profile_hash_idx
    ON provider_catalog_snapshots(provider_profile_id, snapshot_sha256);
CREATE INDEX provider_catalog_snapshots_profile_idx
    ON provider_catalog_snapshots(provider_profile_id, discovered_at_ms DESC, id DESC);

CREATE TRIGGER provider_catalog_snapshots_scope_guard_insert
BEFORE INSERT ON provider_catalog_snapshots
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM provider_profiles profile
        WHERE profile.id = NEW.provider_profile_id
          AND profile.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'provider catalog snapshot profile scope conflict') END;
    SELECT CASE WHEN NEW.snapshot_sha256 <> lower(NEW.snapshot_sha256)
                      OR length(NEW.snapshot_sha256) <> 64
                      OR NEW.snapshot_sha256 GLOB '*[^0-9a-f]*'
        THEN RAISE(ABORT, 'provider catalog snapshot hash is invalid') END;
END;

CREATE TRIGGER provider_catalog_snapshots_immutable_update
BEFORE UPDATE ON provider_catalog_snapshots
BEGIN
    SELECT RAISE(ABORT, 'provider catalog snapshots are immutable');
END;

CREATE TRIGGER provider_catalog_snapshots_immutable_delete
BEFORE DELETE ON provider_catalog_snapshots
BEGIN
    SELECT RAISE(ABORT, 'provider catalog snapshots are immutable');
END;

-- Omnia schema v23: durable runtime operation intents and delivery outbox.
--
-- These rows are the native admission boundary for future scheduler/provider
-- adapters.  They intentionally do not claim that an operation was delivered
-- or that a provider applied it: the first durable state is `accepted`, and
-- the outbox starts in `queued`.  Payloads are canonical, bounded JSON
-- envelopes produced by the native storage layer; credentials, cookies,
-- provider bodies, and filesystem paths must not be stored here.
CREATE TABLE runtime_heads (
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (
        target_kind IN ('goal', 'plan', 'task', 'session', 'run')
    ),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
    head_version INTEGER NOT NULL CHECK (head_version >= 0),
    state_sha256 TEXT NOT NULL CHECK (
        length(state_sha256) = 64
        AND state_sha256 = lower(state_sha256)
        AND state_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
    PRIMARY KEY (profile_id, target_kind, target_id)
) STRICT;

CREATE TABLE runtime_operations (
    operation_id TEXT PRIMARY KEY
        CHECK (length(operation_id) BETWEEN 19 AND 512
               AND substr(operation_id, 1, 18) = 'runtime_operation_'),
    profile_id TEXT NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (
        target_kind IN ('goal', 'plan', 'task', 'session', 'run')
    ),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 512),
    operation_kind TEXT NOT NULL CHECK (
        operation_kind IN (
            'queue', 'start', 'steer', 'pause', 'resume', 'cancel',
            'retry', 'reconcile', 'reprioritize'
        )
    ),
    effect_class TEXT NOT NULL CHECK (
        effect_class IN (
            'read_only', 'analysis_only', 'reversible_write',
            'provider_dispatch', 'process_control', 'external_effect'
        )
    ),
    goal_id TEXT REFERENCES goals(id) ON DELETE RESTRICT,
    plan_revision_id TEXT,
    task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
    task_revision_id TEXT REFERENCES task_revisions(revision_id) ON DELETE RESTRICT,
    session_id TEXT,
    run_id TEXT REFERENCES generations(id) ON DELETE RESTRICT,
    run_generation INTEGER CHECK (run_generation IS NULL OR run_generation >= 0),
    expected_head_version INTEGER CHECK (
        expected_head_version IS NULL OR expected_head_version >= 0
    ),
    resulting_head_version INTEGER NOT NULL CHECK (resulting_head_version >= 1),
    idempotency_key_hash TEXT NOT NULL CHECK (
        length(idempotency_key_hash) = 64
        AND idempotency_key_hash = lower(idempotency_key_hash)
        AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    ),
    canonical_payload_sha256 TEXT NOT NULL CHECK (
        length(canonical_payload_sha256) = 64
        AND canonical_payload_sha256 = lower(canonical_payload_sha256)
        AND canonical_payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json)
        AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 524288
    ),
    operation_state TEXT NOT NULL CHECK (
        operation_state IN (
            'accepted', 'delivered', 'safe_boundary_acknowledged',
            'completed', 'failed', 'outcome_unknown',
            'cancel_requested', 'cancel_completed'
        )
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0)
) STRICT;

CREATE UNIQUE INDEX runtime_operations_idempotency_idx
    ON runtime_operations(profile_id, idempotency_key_hash);
CREATE INDEX runtime_operations_target_idx
    ON runtime_operations(profile_id, target_kind, target_id, created_at_ms DESC);

CREATE TABLE runtime_outbox (
    outbox_id TEXT PRIMARY KEY
        CHECK (length(outbox_id) BETWEEN 16 AND 512
               AND substr(outbox_id, 1, 15) = 'runtime_outbox_'),
    operation_id TEXT NOT NULL REFERENCES runtime_operations(operation_id) ON DELETE RESTRICT,
    delivery_attempt INTEGER NOT NULL CHECK (delivery_attempt >= 1),
    previous_outbox_id TEXT REFERENCES runtime_outbox(outbox_id) ON DELETE RESTRICT,
    payload_sha256 TEXT NOT NULL CHECK (
        length(payload_sha256) = 64
        AND payload_sha256 = lower(payload_sha256)
        AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json)
        AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 524288
    ),
    delivery_state TEXT NOT NULL CHECK (
        delivery_state IN ('queued', 'leased', 'delivered', 'outcome_unknown', 'superseded')
    ),
    lease_owner TEXT,
    lease_expires_at_ms INTEGER CHECK (
        lease_expires_at_ms IS NULL OR lease_expires_at_ms > 0
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (operation_id, delivery_attempt)
) STRICT;

CREATE INDEX runtime_outbox_delivery_idx
    ON runtime_outbox(delivery_state, created_at_ms, outbox_id);
CREATE INDEX runtime_outbox_operation_idx
    ON runtime_outbox(operation_id, delivery_attempt DESC);

CREATE TRIGGER runtime_operations_scope_guard_insert
BEFORE INSERT ON runtime_operations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM app_profiles profile
        WHERE profile.id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation profile scope conflict') END;
    SELECT CASE WHEN NEW.goal_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM goals goal
        WHERE goal.id = NEW.goal_id AND goal.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation goal scope conflict') END;
    SELECT CASE WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tasks task
        WHERE task.id = NEW.task_id AND task.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation task scope conflict') END;
    SELECT CASE WHEN NEW.task_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM task_revisions revision
        JOIN tasks task ON task.id = revision.task_id
        WHERE revision.revision_id = NEW.task_revision_id
          AND task.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation task revision scope conflict') END;
    SELECT CASE WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM generations run
        JOIN conversations conversation ON conversation.id = run.conversation_id
        WHERE run.id = NEW.run_id AND conversation.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation run scope conflict') END;
    SELECT CASE WHEN NEW.target_kind = 'goal' AND NOT EXISTS (
        SELECT 1 FROM goals goal
        WHERE goal.id = NEW.target_id
          AND goal.profile_id = NEW.profile_id
          AND goal.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'runtime operation goal target does not exist') END;
    SELECT CASE WHEN NEW.target_kind = 'goal'
                     AND (NEW.goal_id IS NULL OR NEW.goal_id <> NEW.target_id)
        THEN RAISE(ABORT, 'runtime operation goal target lineage conflict') END;
    SELECT CASE WHEN NEW.target_kind = 'task' AND NOT EXISTS (
        SELECT 1 FROM tasks task
        WHERE task.id = NEW.target_id
          AND task.profile_id = NEW.profile_id
          AND task.deleted_at_ms IS NULL
    ) THEN RAISE(ABORT, 'runtime operation task target does not exist') END;
    SELECT CASE WHEN NEW.target_kind = 'task'
                     AND (NEW.task_id IS NULL OR NEW.task_id <> NEW.target_id)
        THEN RAISE(ABORT, 'runtime operation task target lineage conflict') END;
    SELECT CASE WHEN NEW.target_kind = 'task' AND NOT EXISTS (
        SELECT 1 FROM tasks task
        WHERE task.id = NEW.target_id
          AND task.goal_id = NEW.goal_id
          AND task.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation task goal lineage conflict') END;
    SELECT CASE WHEN NEW.target_kind = 'run' AND NOT EXISTS (
        SELECT 1
        FROM generations run
        JOIN conversations conversation ON conversation.id = run.conversation_id
        WHERE run.id = NEW.target_id
          AND conversation.profile_id = NEW.profile_id
    ) THEN RAISE(ABORT, 'runtime operation run target does not exist') END;
    SELECT CASE WHEN NEW.target_kind = 'run'
                     AND (NEW.run_id IS NULL OR NEW.run_id <> NEW.target_id)
        THEN RAISE(ABORT, 'runtime operation run target lineage conflict') END;
END;

CREATE TRIGGER runtime_operations_immutable_update
BEFORE UPDATE ON runtime_operations
BEGIN
    SELECT RAISE(ABORT, 'runtime operations are immutable');
END;

CREATE TRIGGER runtime_operations_immutable_delete
BEFORE DELETE ON runtime_operations
BEGIN
    SELECT RAISE(ABORT, 'runtime operations are immutable');
END;

CREATE TRIGGER runtime_outbox_scope_guard_insert
BEFORE INSERT ON runtime_outbox
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM runtime_operations operation
        WHERE operation.operation_id = NEW.operation_id
    ) THEN RAISE(ABORT, 'runtime outbox operation scope conflict') END;
    SELECT CASE WHEN NEW.previous_outbox_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM runtime_outbox previous
        WHERE previous.outbox_id = NEW.previous_outbox_id
          AND previous.operation_id = NEW.operation_id
          AND previous.delivery_attempt < NEW.delivery_attempt
    ) THEN RAISE(ABORT, 'runtime outbox predecessor scope conflict') END;
END;

CREATE TRIGGER runtime_outbox_immutable_update
BEFORE UPDATE ON runtime_outbox
BEGIN
    SELECT RAISE(ABORT, 'runtime outbox rows are immutable');
END;

CREATE TRIGGER runtime_outbox_immutable_delete
BEFORE DELETE ON runtime_outbox
BEGIN
    SELECT RAISE(ABORT, 'runtime outbox rows are immutable');
END;

-- Omnia schema v24: append-only runtime lifecycle receipts.
-- These facts describe an observed transition or an explicit reconciliation
-- result. They do not imply that a provider/process was reached.
CREATE TABLE runtime_events (
    event_id TEXT PRIMARY KEY
        CHECK (length(event_id) BETWEEN 16 AND 512
               AND substr(event_id, 1, 14) = 'runtime_event_'),
    operation_id TEXT NOT NULL REFERENCES runtime_operations(operation_id)
        ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'accepted', 'delivered', 'safe_boundary_acknowledged',
            'completed', 'failed', 'cancel_requested', 'cancel_completed',
            'outcome_unknown', 'reconciled'
        )
    ),
    actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
    authority_kind TEXT NOT NULL CHECK (length(authority_kind) BETWEEN 1 AND 64),
    delegation_id TEXT,
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json)
        AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) BETWEEN 2 AND 524288
    ),
    payload_sha256 TEXT NOT NULL CHECK (
        length(payload_sha256) = 64
        AND payload_sha256 = lower(payload_sha256)
        AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    UNIQUE (operation_id, event_type)
) STRICT;

CREATE INDEX runtime_events_operation_idx
    ON runtime_events(operation_id, created_at_ms, event_id);

CREATE TRIGGER runtime_events_scope_guard_insert
BEFORE INSERT ON runtime_events
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM runtime_operations operation
        WHERE operation.operation_id = NEW.operation_id
    ) THEN RAISE(ABORT, 'runtime event operation scope conflict') END;
    SELECT CASE WHEN NEW.payload_sha256 <> lower(NEW.payload_sha256)
                     OR length(NEW.payload_sha256) <> 64
        THEN RAISE(ABORT, 'runtime event payload hash is invalid') END;
END;

CREATE TRIGGER runtime_events_immutable_update
BEFORE UPDATE ON runtime_events
BEGIN
    SELECT RAISE(ABORT, 'runtime events are immutable');
END;

CREATE TRIGGER runtime_events_immutable_delete
BEFORE DELETE ON runtime_events
BEGIN
    SELECT RAISE(ABORT, 'runtime events are immutable');
END;

-- Omnia schema v25: durable tiered supervisor/project-manager/worker
-- admission journal. Rows are accepted intent and lease metadata only; no
-- provider or process dispatch is implied.
CREATE TABLE tiered_orchestration_heads (
    goal_id TEXT NOT NULL CHECK (length(goal_id) BETWEEN 1 AND 512),
    run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
    version INTEGER NOT NULL CHECK (version > 0),
    snapshot_hash TEXT NOT NULL CHECK (
        length(snapshot_hash) = 64
        AND snapshot_hash = lower(snapshot_hash)
        AND snapshot_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    PRIMARY KEY (goal_id, run_id, version)
) STRICT;

CREATE TABLE tiered_orchestration_current (
    goal_id TEXT NOT NULL CHECK (length(goal_id) BETWEEN 1 AND 512),
    run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
    version INTEGER NOT NULL CHECK (version > 0),
    snapshot_hash TEXT NOT NULL CHECK (
        length(snapshot_hash) = 64
        AND snapshot_hash = lower(snapshot_hash)
        AND snapshot_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
    PRIMARY KEY (goal_id, run_id),
    FOREIGN KEY (goal_id, run_id, version)
      REFERENCES tiered_orchestration_heads(goal_id, run_id, version)
) STRICT;

CREATE TABLE tiered_orchestration_agents (
    goal_id TEXT NOT NULL CHECK (length(goal_id) BETWEEN 1 AND 512),
    run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
    version INTEGER NOT NULL CHECK (version > 0),
    agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 512),
    role TEXT NOT NULL CHECK (role IN ('supervisor', 'project-manager', 'worker')),
    parent_id TEXT,
    lane TEXT,
    ownership_json TEXT NOT NULL CHECK (
        json_valid(ownership_json) AND json_type(ownership_json) = 'array'
    ),
    stop_condition TEXT NOT NULL CHECK (length(stop_condition) BETWEEN 1 AND 2048),
    lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 1 AND 512),
    lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms > 0),
    PRIMARY KEY (goal_id, run_id, version, agent_id),
    UNIQUE (goal_id, run_id, version, lease_id),
    FOREIGN KEY (goal_id, run_id, version)
      REFERENCES tiered_orchestration_heads(goal_id, run_id, version)
) STRICT;

CREATE INDEX tiered_orchestration_agents_scope_idx
    ON tiered_orchestration_agents(goal_id, run_id, version, role);

CREATE TRIGGER tiered_orchestration_heads_immutable_update
BEFORE UPDATE ON tiered_orchestration_heads
BEGIN SELECT RAISE(ABORT, 'tiered orchestration heads are immutable'); END;
CREATE TRIGGER tiered_orchestration_heads_immutable_delete
BEFORE DELETE ON tiered_orchestration_heads
BEGIN SELECT RAISE(ABORT, 'tiered orchestration heads are immutable'); END;
CREATE TRIGGER tiered_orchestration_current_immutable_delete
BEFORE DELETE ON tiered_orchestration_current
BEGIN SELECT RAISE(ABORT, 'tiered orchestration current delete forbidden'); END;
CREATE TRIGGER tiered_orchestration_agents_immutable_update
BEFORE UPDATE ON tiered_orchestration_agents
BEGIN SELECT RAISE(ABORT, 'tiered orchestration agents are immutable'); END;
CREATE TRIGGER tiered_orchestration_agents_immutable_delete
BEFORE DELETE ON tiered_orchestration_agents
BEGIN SELECT RAISE(ABORT, 'tiered orchestration agents are immutable'); END;
