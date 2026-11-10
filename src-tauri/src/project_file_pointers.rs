//! Durable, identity-bound project file snapshots.
//!
//! A picker grants one file identity. Refresh never adopts a different file
//! merely because it later occupies the same path. Rename discovery is a
//! bounded metadata-only walk under the selected file's original parent.
//! Bodies are copied into the encrypted content store; removing the source
//! therefore leaves the last verified snapshot available to the project.

use std::{
    collections::VecDeque,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    content_store::{BlobCommitOutcome, BlobDescriptor, BlobKeyProvider, ContentStore},
    error::{NativeError, NativeResult},
};

const MAX_POINTERS_PER_PROJECT: usize = 1_000;
const MAX_SELECTED_FILES: usize = 64;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 10_000;
const MAX_SCAN_DEPTH: usize = 8;
const WATCHER_VERSION: &str = "native-file-identity-poll-v1";

pub struct ProjectFilePointerRepository {
    connection: Mutex<Connection>,
    bodies: ContentStore,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerRecord {
    pub id: String,
    pub project_id: String,
    pub source_path: String,
    pub display_name: String,
    pub source_identity_sha256: String,
    pub content_sha256: String,
    pub byte_size: u64,
    pub source_exists: bool,
    pub source_updated_at_ms: Option<i64>,
    pub snapshot_updated_at_ms: i64,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFilePointerReceipt {
    pub id: String,
    pub pointer_id: String,
    pub project_id: String,
    pub revision: u64,
    pub outcome: String,
    pub watcher_version: String,
    pub source_identity_sha256: String,
    pub content_sha256: String,
    pub source_exists: bool,
    pub renamed: bool,
    pub content_changed: bool,
    pub scanned_entries: usize,
    pub observed_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilePointerMutation {
    pub pointer: ProjectFilePointerRecord,
    pub receipt: ProjectFilePointerReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilePointerBody {
    pub pointer_id: String,
    pub revision: u64,
    pub content_sha256: String,
    pub byte_size: u64,
    pub encoding: &'static str,
    pub content: String,
}

struct StoredPointer {
    record: ProjectFilePointerRecord,
    identity: String,
    discovery_root: PathBuf,
    blob: BlobDescriptor,
}

struct ObservedFile {
    path: PathBuf,
    identity: String,
    modified_at_ms: Option<i64>,
    bytes: Vec<u8>,
}

enum Discovery {
    Found(PathBuf, usize),
    Missing(usize),
    Incomplete,
}

impl ProjectFilePointerRepository {
    pub fn open(app_data_dir: &Path) -> NativeResult<Self> {
        let root = app_data_dir.join("project-files");
        fs::create_dir_all(&root).map_err(|error| {
            NativeError::io("Could not prepare project file snapshot storage", error)
        })?;
        if is_reparse(&fs::symlink_metadata(&root).map_err(|error| {
            NativeError::io("Could not inspect project file snapshot storage", error)
        })?) {
            return Err(NativeError::new(
                "pointer_store_unsafe",
                "Project file storage cannot be a reparse point",
            ));
        }
        let root = dunce::canonicalize(root).map_err(|error| {
            NativeError::io("Could not resolve project file snapshot storage", error)
        })?;
        let connection = Connection::open(root.join("pointers.sqlite3"))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA busy_timeout = 5000;
             PRAGMA trusted_schema = OFF;
             CREATE TABLE IF NOT EXISTS pointer_blobs (
                 id TEXT PRIMARY KEY, descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json))
             ) STRICT;
             CREATE TABLE IF NOT EXISTS project_file_pointers (
                 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, identity TEXT NOT NULL,
                 discovery_root TEXT NOT NULL, blob_id TEXT NOT NULL REFERENCES pointer_blobs(id),
                 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
                 UNIQUE(project_id, identity)
             ) STRICT;
             CREATE TABLE IF NOT EXISTS pointer_receipts (
                 id TEXT PRIMARY KEY, pointer_id TEXT NOT NULL REFERENCES project_file_pointers(id),
                 revision INTEGER NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
                 UNIQUE(pointer_id, revision)
             ) STRICT;
             CREATE TRIGGER IF NOT EXISTS pointer_receipts_immutable_update
                 BEFORE UPDATE ON pointer_receipts BEGIN SELECT RAISE(ABORT, 'immutable pointer receipt'); END;
             CREATE TRIGGER IF NOT EXISTS pointer_receipts_immutable_delete
                 BEFORE DELETE ON pointer_receipts BEGIN SELECT RAISE(ABORT, 'immutable pointer receipt'); END;",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            bodies: ContentStore::open(&root)?,
        })
    }

    pub fn import_files(
        &self,
        keys: &dyn BlobKeyProvider,
        project_id: &str,
        paths: &[PathBuf],
    ) -> NativeResult<Vec<ProjectFilePointerMutation>> {
        validate_project(project_id)?;
        if paths.is_empty() || paths.len() > MAX_SELECTED_FILES {
            return Err(NativeError::invalid(
                "files",
                "must contain 1 to 64 picker-selected files",
            ));
        }
        let mut results = Vec::with_capacity(paths.len());
        for path in paths {
            let observed = read_source(path, None)?;
            let mut connection = self.lock()?;
            let transaction = connection.transaction()?;
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT id FROM project_file_pointers WHERE project_id = ?1 AND identity = ?2",
                    params![project_id, observed.identity],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(id) = existing {
                transaction.commit()?;
                drop(connection);
                let stored = self.load(&id)?;
                results.push(self.refresh(keys, project_id, &id, stored.record.revision)?);
                continue;
            }
            let count: usize = transaction.query_row(
                "SELECT COUNT(*) FROM project_file_pointers WHERE project_id = ?1",
                [project_id],
                |row| row.get(0),
            )?;
            if count >= MAX_POINTERS_PER_PROJECT {
                return Err(NativeError::new(
                    "pointer_limit_reached",
                    "This project reached its 1,000 file pointer limit",
                ));
            }
            let blob = self.persist_body(&transaction, keys, &observed.bytes)?;
            let now = now_ms();
            let record = ProjectFilePointerRecord {
                id: format!("file_pointer_{}", Uuid::new_v4().simple()),
                project_id: project_id.to_owned(),
                source_path: observed.path.to_string_lossy().into_owned(),
                display_name: filename(&observed.path)?,
                source_identity_sha256: digest(observed.identity.as_bytes()),
                content_sha256: blob.id.clone(),
                byte_size: observed.bytes.len() as u64,
                source_exists: true,
                source_updated_at_ms: observed.modified_at_ms,
                snapshot_updated_at_ms: now,
                revision: 1,
            };
            let discovery_root = observed
                .path
                .parent()
                .ok_or_else(|| NativeError::invalid("file", "has no parent directory"))?;
            transaction.execute(
                "INSERT INTO project_file_pointers(id, project_id, identity, discovery_root, blob_id, record_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![record.id, project_id, observed.identity, discovery_root.to_string_lossy(), blob.id, serialize(&record)?],
            )?;
            let receipt = make_receipt(&record, "imported", false, true, 0, now);
            append_receipt(&transaction, &receipt)?;
            transaction.commit()?;
            results.push(ProjectFilePointerMutation {
                pointer: record,
                receipt,
            });
        }
        Ok(results)
    }

    pub fn list(&self, project_id: &str) -> NativeResult<Vec<ProjectFilePointerRecord>> {
        validate_project(project_id)?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT record_json FROM project_file_pointers WHERE project_id = ?1 ORDER BY id LIMIT 1001",
        )?;
        let values = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if values.len() > MAX_POINTERS_PER_PROJECT {
            return Err(NativeError::new(
                "pointer_metadata_invalid",
                "The project file catalog exceeds its safe bound",
            ));
        }
        values
            .into_iter()
            .map(|value| deserialize(&value))
            .collect()
    }

    /// Returns only source-backed pointers eligible for a fresh retrieval
    /// admission.  A missing source remains readable through `read_body` so
    /// the retained snapshot can be inspected, but it must not silently
    /// re-enter a new index or retrieval request.
    pub fn list_retrieval_candidates(
        &self,
        project_id: &str,
    ) -> NativeResult<Vec<ProjectFilePointerRecord>> {
        validate_project(project_id)?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT record_json
             FROM project_file_pointers
             WHERE project_id = ?1
               AND json_extract(record_json, '$.sourceExists') = 1
             ORDER BY id
             LIMIT 1001",
        )?;
        let values = statement
            .query_map([project_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if values.len() > MAX_POINTERS_PER_PROJECT {
            return Err(NativeError::new(
                "pointer_metadata_invalid",
                "The project file catalog exceeds its safe bound",
            ));
        }
        values
            .into_iter()
            .map(|value| deserialize(&value))
            .collect()
    }

    pub fn refresh(
        &self,
        keys: &dyn BlobKeyProvider,
        project_id: &str,
        pointer_id: &str,
        expected_revision: u64,
    ) -> NativeResult<ProjectFilePointerMutation> {
        validate_project(project_id)?;
        validate_pointer(pointer_id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let mut stored = load_stored(&transaction, pointer_id)?;
        ensure_scope(&stored, project_id, expected_revision)?;
        let discovery = discover_source(&stored)?;
        let now = now_ms().max(stored.record.snapshot_updated_at_ms);
        let (renamed, content_changed, scanned_entries, outcome) = match discovery {
            Discovery::Found(path, scanned_entries) => {
                let observed = read_source(&path, Some(&stored.identity))?;
                let content_sha256 = digest(&observed.bytes);
                let content_changed = content_sha256 != stored.record.content_sha256;
                let renamed = stored.record.source_path != observed.path.to_string_lossy();
                if content_changed {
                    stored.blob = self.persist_body(&transaction, keys, &observed.bytes)?;
                }
                stored.record.source_path = observed.path.to_string_lossy().into_owned();
                stored.record.display_name = filename(&observed.path)?;
                stored.record.content_sha256 = content_sha256;
                stored.record.byte_size = observed.bytes.len() as u64;
                stored.record.source_exists = true;
                stored.record.source_updated_at_ms = observed.modified_at_ms;
                (
                    renamed,
                    content_changed,
                    scanned_entries,
                    if content_changed {
                        "updated"
                    } else if renamed {
                        "renamed"
                    } else {
                        "unchanged"
                    },
                )
            }
            Discovery::Missing(scanned_entries) => {
                stored.record.source_exists = false;
                (false, false, scanned_entries, "source_missing")
            }
            Discovery::Incomplete => return Err(NativeError::retryable(
                "pointer_discovery_incomplete",
                "File identity discovery reached its bound; the retained snapshot was not changed",
            )),
        };
        stored.record.snapshot_updated_at_ms = now;
        stored.record.revision = stored.record.revision.checked_add(1).ok_or_else(|| {
            NativeError::new(
                "pointer_revision_exhausted",
                "The file pointer revision is exhausted",
            )
        })?;
        transaction.execute(
            "UPDATE project_file_pointers SET blob_id = ?1, record_json = ?2 WHERE id = ?3",
            params![stored.blob.id, serialize(&stored.record)?, pointer_id],
        )?;
        let receipt = make_receipt(
            &stored.record,
            outcome,
            renamed,
            content_changed,
            scanned_entries,
            now,
        );
        append_receipt(&transaction, &receipt)?;
        transaction.commit()?;
        Ok(ProjectFilePointerMutation {
            pointer: stored.record,
            receipt,
        })
    }

    pub fn read_body(
        &self,
        keys: &dyn BlobKeyProvider,
        project_id: &str,
        pointer_id: &str,
        expected_revision: u64,
    ) -> NativeResult<ProjectFilePointerBody> {
        validate_project(project_id)?;
        validate_pointer(pointer_id)?;
        let stored = self.load(pointer_id)?;
        ensure_scope(&stored, project_id, expected_revision)?;
        let plaintext = self
            .bodies
            .read_verified(keys, &stored.blob, MAX_READ_BYTES)?;
        Ok(ProjectFilePointerBody {
            pointer_id: pointer_id.to_owned(),
            revision: stored.record.revision,
            content_sha256: stored.record.content_sha256,
            byte_size: plaintext.len() as u64,
            encoding: "base64",
            content: STANDARD.encode(plaintext.as_slice()),
        })
    }

    pub fn receipts(
        &self,
        project_id: &str,
        pointer_id: &str,
    ) -> NativeResult<Vec<ProjectFilePointerReceipt>> {
        validate_project(project_id)?;
        validate_pointer(pointer_id)?;
        let connection = self.lock()?;
        let stored = load_stored(&connection, pointer_id)?;
        if stored.record.project_id != project_id {
            return Err(scope_error());
        }
        let mut statement = connection.prepare(
            "SELECT receipt_json FROM pointer_receipts WHERE pointer_id = ?1 ORDER BY revision DESC LIMIT 100",
        )?;
        let values = statement
            .query_map([pointer_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        values
            .into_iter()
            .map(|value| deserialize(&value))
            .collect()
    }

    fn persist_body(
        &self,
        connection: &Connection,
        keys: &dyn BlobKeyProvider,
        bytes: &[u8],
    ) -> NativeResult<BlobDescriptor> {
        let hash = digest(bytes);
        let existing: Option<String> = connection
            .query_row(
                "SELECT descriptor_json FROM pointer_blobs WHERE id = ?1",
                [&hash],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            let descriptor: BlobDescriptor = deserialize(&existing)?;
            self.bodies
                .read_verified(keys, &descriptor, MAX_FILE_BYTES)?;
            return Ok(descriptor);
        }
        let prepared = self
            .bodies
            .prepare_bytes(keys, "application/octet-stream", bytes)?;
        let descriptor = match prepared.commit()? {
            BlobCommitOutcome::Published(descriptor) => descriptor,
            BlobCommitOutcome::AlreadyExists { .. } => {
                return Err(NativeError::new(
                    "pointer_blob_reconciliation_required",
                    "A retained file body exists without canonical metadata",
                ))
            }
        };
        connection.execute(
            "INSERT INTO pointer_blobs(id, descriptor_json) VALUES (?1, ?2)",
            params![descriptor.id, serialize(&descriptor)?],
        )?;
        Ok(descriptor)
    }

    fn load(&self, pointer_id: &str) -> NativeResult<StoredPointer> {
        let connection = self.lock()?;
        load_stored(&connection, pointer_id)
    }
    fn lock(&self) -> NativeResult<std::sync::MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| {
            NativeError::new(
                "pointer_store_locked",
                "Project file storage is unavailable",
            )
        })
    }
}

fn load_stored(connection: &Connection, pointer_id: &str) -> NativeResult<StoredPointer> {
    let row: Option<(String, String, String, String)> = connection
        .query_row(
            "SELECT p.record_json, p.identity, p.discovery_root, b.descriptor_json
         FROM project_file_pointers p JOIN pointer_blobs b ON b.id = p.blob_id WHERE p.id = ?1",
            [pointer_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let (record, identity, root, blob) = row.ok_or_else(|| {
        NativeError::new(
            "pointer_not_found",
            "The project file pointer does not exist",
        )
    })?;
    let stored = StoredPointer {
        record: deserialize(&record)?,
        identity,
        discovery_root: PathBuf::from(root),
        blob: deserialize(&blob)?,
    };
    if stored.record.id != pointer_id
        || stored.record.content_sha256 != stored.blob.id
        || stored.record.source_identity_sha256 != digest(stored.identity.as_bytes())
    {
        return Err(NativeError::new(
            "pointer_metadata_invalid",
            "The retained file metadata failed its identity check",
        ));
    }
    Ok(stored)
}

fn discover_source(stored: &StoredPointer) -> NativeResult<Discovery> {
    let original = Path::new(&stored.record.source_path);
    if let Some(identity) = inspect_identity(original)? {
        if identity == stored.identity {
            return Ok(Discovery::Found(original.to_owned(), 0));
        }
    }
    let root_metadata = match fs::symlink_metadata(&stored.discovery_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Discovery::Missing(0))
        }
        Err(error) => {
            return Err(NativeError::io(
                "Could not inspect the file discovery root",
                error,
            ))
        }
    };
    if !root_metadata.is_dir() || is_reparse(&root_metadata) {
        return Err(NativeError::new(
            "pointer_discovery_scope_changed",
            "The file discovery directory changed identity or became unsafe",
        ));
    }
    let root = dunce::canonicalize(&stored.discovery_root)
        .map_err(|error| NativeError::io("Could not resolve the file discovery root", error))?;
    if root != stored.discovery_root {
        return Err(NativeError::new(
            "pointer_discovery_scope_changed",
            "The file discovery directory resolved outside its original scope",
        ));
    }
    let mut queue = VecDeque::from([(root, 0)]);
    let mut scanned = 0;
    let mut truncated = false;
    while let Some((directory, depth)) = queue.pop_front() {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| NativeError::io("Could not scan the file discovery directory", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| NativeError::io("Could not inspect a file discovery entry", error))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            scanned += 1;
            if scanned > MAX_SCAN_ENTRIES {
                return Ok(Discovery::Incomplete);
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                NativeError::io("Could not inspect a file discovery entry", error)
            })?;
            if is_reparse(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                if depth < MAX_SCAN_DEPTH {
                    queue.push_back((entry.path(), depth + 1));
                } else {
                    truncated = true;
                }
            } else if metadata.is_file()
                && inspect_identity(&entry.path())?.as_deref() == Some(&stored.identity)
            {
                return Ok(Discovery::Found(entry.path(), scanned));
            }
        }
    }
    Ok(if truncated {
        Discovery::Incomplete
    } else {
        Discovery::Missing(scanned)
    })
}

fn read_source(path: &Path, expected_identity: Option<&str>) -> NativeResult<ObservedFile> {
    reject_reparse_components(path)?;
    let canonical_before = dunce::canonicalize(path)
        .map_err(|error| NativeError::io("Could not resolve the selected project file", error))?;
    let mut file = open_without_following(path)
        .map_err(|error| NativeError::io("Could not open the selected project file", error))?;
    let before = file
        .metadata()
        .map_err(|error| NativeError::io("Could not inspect the selected project file", error))?;
    if !before.is_file() || is_reparse(&before) || before.len() > MAX_FILE_BYTES {
        return Err(NativeError::new(
            "pointer_file_unsafe",
            "The selected source must be a regular file of at most 64 MiB",
        ));
    }
    let identity = file_identity(&file, &before)?;
    if expected_identity.is_some_and(|expected| expected != identity) {
        return Err(NativeError::new(
            "pointer_source_replaced",
            "The selected path now identifies a different file",
        ));
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| NativeError::io("Could not read the selected project file", error))?;
    let after = file
        .metadata()
        .map_err(|error| NativeError::io("Could not recheck the selected project file", error))?;
    let canonical_after = dunce::canonicalize(path).map_err(|error| {
        NativeError::io("Could not recheck the selected project file path", error)
    })?;
    let path_identity = inspect_identity(path)?;
    if bytes.len() as u64 > MAX_FILE_BYTES
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || canonical_before != canonical_after
        || path_identity.as_deref() != Some(identity.as_str())
    {
        return Err(NativeError::retryable(
            "pointer_source_changed",
            "The project source changed while its snapshot was being read",
        ));
    }
    Ok(ObservedFile {
        path: canonical_after,
        identity,
        modified_at_ms: system_ms(after.modified().ok()),
        bytes,
    })
}

fn inspect_identity(path: &Path) -> NativeResult<Option<String>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(NativeError::io(
            "Could not inspect the project source identity",
            error,
        )),
        Ok(metadata) if !metadata.is_file() || is_reparse(&metadata) => Ok(None),
        Ok(_) => {
            reject_reparse_components(path)?;
            let file = open_without_following(path).map_err(|error| {
                NativeError::io("Could not open the project source identity", error)
            })?;
            let metadata = file.metadata().map_err(|error| {
                NativeError::io("Could not inspect the project source identity", error)
            })?;
            file_identity(&file, &metadata).map(Some)
        }
    }
}

#[cfg(windows)]
fn file_identity(file: &File, _metadata: &Metadata) -> NativeResult<String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.map_err(
        |_| {
            NativeError::new(
                "pointer_identity_unavailable",
                "Windows could not prove the selected file identity",
            )
        },
    )?;
    Ok(format!(
        "win32:{:08x}:{:08x}{:08x}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}

#[cfg(unix)]
fn file_identity(_file: &File, metadata: &Metadata) -> NativeResult<String> {
    use std::os::unix::fs::MetadataExt;
    Ok(format!("unix:{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File, _metadata: &Metadata) -> NativeResult<String> {
    Err(NativeError::new(
        "pointer_identity_unavailable",
        "This platform has no supported stable file identity backend",
    ))
}

fn open_without_following(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    options.open(path)
}

fn reject_reparse_components(path: &Path) -> NativeResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| NativeError::io("Could not inspect the project source path", error))?;
        if is_reparse(&metadata) {
            return Err(NativeError::new(
                "pointer_source_reparse",
                "Project file pointers do not follow links, junctions or reparse points",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn filename(path: &Path) -> NativeResult<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| NativeError::invalid("file", "requires a representable filename"))
}
fn validate_project(id: &str) -> NativeResult<()> {
    validate_id(id, "project_", "projectId")
}
fn validate_pointer(id: &str) -> NativeResult<()> {
    validate_id(id, "file_pointer_", "pointerId")
}
fn validate_id(id: &str, prefix: &str, field: &'static str) -> NativeResult<()> {
    if !id.starts_with(prefix)
        || id.len() <= prefix.len()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(NativeError::invalid(
            field,
            "must be an opaque native identifier",
        ));
    }
    Ok(())
}
fn ensure_scope(stored: &StoredPointer, project_id: &str, revision: u64) -> NativeResult<()> {
    if stored.record.project_id != project_id {
        return Err(scope_error());
    }
    if stored.record.revision != revision {
        return Err(NativeError::retryable(
            "pointer_revision_conflict",
            "The file pointer changed; reload its latest revision",
        ));
    }
    Ok(())
}
fn scope_error() -> NativeError {
    NativeError::new(
        "pointer_scope_conflict",
        "The file pointer does not belong to the selected project",
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn system_ms(value: Option<SystemTime>) -> Option<i64> {
    value?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}
fn now_ms() -> i64 {
    system_ms(Some(SystemTime::now())).unwrap_or(1).max(1)
}
fn serialize<T: Serialize>(value: &T) -> NativeResult<String> {
    serde_json::to_string(value).map_err(|_| {
        NativeError::new(
            "pointer_serialization_failed",
            "Project file metadata could not be serialized",
        )
    })
}
fn deserialize<T: for<'de> Deserialize<'de>>(value: &str) -> NativeResult<T> {
    serde_json::from_str(value).map_err(|_| {
        NativeError::new(
            "pointer_metadata_invalid",
            "Project file metadata is malformed",
        )
    })
}
fn append_receipt(
    connection: &Connection,
    receipt: &ProjectFilePointerReceipt,
) -> NativeResult<()> {
    connection.execute("INSERT INTO pointer_receipts(id, pointer_id, revision, receipt_json) VALUES (?1, ?2, ?3, ?4)",
        params![receipt.id, receipt.pointer_id, receipt.revision, serialize(receipt)?])?;
    Ok(())
}
fn make_receipt(
    record: &ProjectFilePointerRecord,
    outcome: &str,
    renamed: bool,
    content_changed: bool,
    scanned_entries: usize,
    observed_at_ms: i64,
) -> ProjectFilePointerReceipt {
    ProjectFilePointerReceipt {
        id: format!("file_pointer_receipt_{}", Uuid::new_v4().simple()),
        pointer_id: record.id.clone(),
        project_id: record.project_id.clone(),
        revision: record.revision,
        outcome: outcome.to_owned(),
        watcher_version: WATCHER_VERSION.to_owned(),
        source_identity_sha256: record.source_identity_sha256.clone(),
        content_sha256: record.content_sha256.clone(),
        source_exists: record.source_exists,
        renamed,
        content_changed,
        scanned_entries,
        observed_at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroizing;

    struct Keys;
    impl BlobKeyProvider for Keys {
        fn current_key_version(&self) -> NativeResult<i64> {
            Ok(1)
        }
        fn wrap_dek(&self, _: i64, key: &[u8; 32]) -> NativeResult<Vec<u8>> {
            Ok(key.iter().map(|byte| byte ^ 0x5a).collect())
        }
        fn unwrap_dek(&self, _: i64, wrapped: &[u8]) -> NativeResult<Zeroizing<[u8; 32]>> {
            let mut key = [0; 32];
            for (index, byte) in wrapped.iter().enumerate() {
                key[index] = byte ^ 0x5a;
            }
            Ok(Zeroizing::new(key))
        }
    }
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("omnia-file-pointers-{}", Uuid::new_v4().simple()));
            fs::create_dir_all(root.join("sources")).unwrap();
            Self(root)
        }
        fn source(&self, name: &str, body: &[u8]) -> PathBuf {
            let path = self.0.join("sources").join(name);
            fs::write(&path, body).unwrap();
            path
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rename_content_change_delete_and_restart_keep_one_file_identity() {
        let sandbox = Sandbox::new();
        let source = sandbox.source("report.md", b"first verified snapshot");
        let repository = ProjectFilePointerRepository::open(&sandbox.0).unwrap();
        let imported = repository
            .import_files(&Keys, "project_alpha", std::slice::from_ref(&source))
            .unwrap()
            .remove(0);
        assert_eq!(imported.pointer.revision, 1);
        let renamed = sandbox.0.join("sources").join("renamed.md");
        fs::rename(&source, &renamed).unwrap();
        let rename = repository
            .refresh(&Keys, "project_alpha", &imported.pointer.id, 1)
            .unwrap();
        assert!(rename.receipt.renamed);
        assert_eq!(rename.pointer.id, imported.pointer.id);
        assert_eq!(
            rename.pointer.source_identity_sha256,
            imported.pointer.source_identity_sha256
        );
        fs::write(&renamed, b"latest content survives deletion").unwrap();
        let updated = repository
            .refresh(&Keys, "project_alpha", &imported.pointer.id, 2)
            .unwrap();
        assert!(updated.receipt.content_changed);
        fs::remove_file(&renamed).unwrap();
        let deleted = repository
            .refresh(&Keys, "project_alpha", &imported.pointer.id, 3)
            .unwrap();
        assert!(!deleted.pointer.source_exists);
        assert_eq!(
            deleted.pointer.content_sha256,
            updated.pointer.content_sha256
        );
        drop(repository);
        let reopened = ProjectFilePointerRepository::open(&sandbox.0).unwrap();
        let body = reopened
            .read_body(&Keys, "project_alpha", &imported.pointer.id, 4)
            .unwrap();
        assert_eq!(
            STANDARD.decode(body.content).unwrap(),
            b"latest content survives deletion"
        );
        assert_eq!(
            reopened
                .receipts("project_alpha", &imported.pointer.id)
                .unwrap()
                .len(),
            4
        );
        let raw_database = fs::read(sandbox.0.join("project-files/pointers.sqlite3")).unwrap();
        assert!(!raw_database
            .windows(13)
            .any(|part| part == b"latest conten"));
    }

    #[test]
    fn path_replacement_does_not_silently_adopt_unselected_identity() {
        let sandbox = Sandbox::new();
        let source = sandbox.source("chosen.txt", b"chosen original");
        let repository = ProjectFilePointerRepository::open(&sandbox.0).unwrap();
        let imported = repository
            .import_files(&Keys, "project_alpha", std::slice::from_ref(&source))
            .unwrap()
            .remove(0);
        let moved = sandbox.0.join("sources").join("original.txt");
        fs::rename(&source, &moved).unwrap();
        fs::write(&source, b"unselected replacement").unwrap();
        let refreshed = repository
            .refresh(&Keys, "project_alpha", &imported.pointer.id, 1)
            .unwrap();
        assert!(refreshed.receipt.renamed);
        assert_eq!(refreshed.pointer.display_name, "original.txt");
        let body = repository
            .read_body(&Keys, "project_alpha", &imported.pointer.id, 2)
            .unwrap();
        assert_eq!(STANDARD.decode(body.content).unwrap(), b"chosen original");
    }

    #[test]
    fn scope_revision_and_immutable_receipts_are_enforced() {
        let sandbox = Sandbox::new();
        let source = sandbox.source("guard.txt", b"guarded");
        let repository = ProjectFilePointerRepository::open(&sandbox.0).unwrap();
        let imported = repository
            .import_files(&Keys, "project_alpha", &[source])
            .unwrap()
            .remove(0);
        assert_eq!(
            repository
                .refresh(&Keys, "project_beta", &imported.pointer.id, 1)
                .unwrap_err()
                .code,
            "pointer_scope_conflict"
        );
        assert_eq!(
            repository
                .refresh(&Keys, "project_alpha", &imported.pointer.id, 0)
                .unwrap_err()
                .code,
            "pointer_revision_conflict"
        );
        assert_eq!(
            repository
                .read_body(&Keys, "project_beta", &imported.pointer.id, 1)
                .unwrap_err()
                .code,
            "pointer_scope_conflict"
        );
        let connection = repository.lock().unwrap();
        assert!(connection
            .execute("UPDATE pointer_receipts SET revision = 99", [])
            .is_err());
        assert!(connection
            .execute("DELETE FROM pointer_receipts", [])
            .is_err());
        drop(connection);
        assert_eq!(
            repository
                .receipts("project_alpha", &imported.pointer.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn duplicate_imports_dedupe_by_identity_and_encrypt_shared_content() {
        let sandbox = Sandbox::new();
        let first = sandbox.source("first.txt", b"same content");
        let second = sandbox.source("second.txt", b"same content");
        let repository = ProjectFilePointerRepository::open(&sandbox.0).unwrap();
        let imported = repository
            .import_files(&Keys, "project_alpha", &[first.clone(), second])
            .unwrap();
        assert_ne!(imported[0].pointer.id, imported[1].pointer.id);
        assert_eq!(
            imported[0].pointer.content_sha256,
            imported[1].pointer.content_sha256
        );
        let repeated = repository
            .import_files(&Keys, "project_alpha", &[first])
            .unwrap();
        assert_eq!(repeated[0].pointer.id, imported[0].pointer.id);
        assert_eq!(repository.list("project_alpha").unwrap().len(), 2);
        assert_eq!(
            repository
                .read_body(&Keys, "project_alpha", &repeated[0].pointer.id, 2)
                .unwrap()
                .byte_size,
            12
        );
    }

    #[test]
    fn missing_source_is_excluded_from_new_retrieval_but_snapshot_remains_readable() {
        let sandbox = Sandbox::new();
        let source = sandbox.source("retrieval.txt", b"retain for audit");
        let repository = ProjectFilePointerRepository::open(&sandbox.0).unwrap();
        let imported = repository
            .import_files(&Keys, "project_alpha", std::slice::from_ref(&source))
            .unwrap()
            .remove(0);
        assert_eq!(
            repository
                .list_retrieval_candidates("project_alpha")
                .unwrap()
                .len(),
            1
        );

        fs::remove_file(&source).unwrap();
        let refreshed = repository
            .refresh(&Keys, "project_alpha", &imported.pointer.id, 1)
            .unwrap();
        assert!(!refreshed.pointer.source_exists);
        assert!(repository
            .list_retrieval_candidates("project_alpha")
            .unwrap()
            .is_empty());
        let body = repository
            .read_body(&Keys, "project_alpha", &imported.pointer.id, 2)
            .unwrap();
        assert_eq!(STANDARD.decode(body.content).unwrap(), b"retain for audit");
    }
}
