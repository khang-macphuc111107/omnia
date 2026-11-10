//! Per-turn file checkpoints so a rewind can restore code, not only the
//! conversation.
//!
//! Checkpoints use monotonic logical keys and a durable mapping to visible
//! transcript boundaries. Compaction rebases that mapping without reusing keys.
//! Before a write tool touches a file
//! it calls [`ToolContext::checkpoint_before`](crate::ToolContext), which
//! records the file's prior content (or that it did not exist) once per
//! checkpoint. File contents are stored content-addressed under the store
//! root; a small JSON manifest maps checkpoint -> path -> prior state, so
//! checkpoints survive an app restart.
//! Ambiguous legacy/crash mappings are preserved in recovery archives so SEND
//! and conversation-only rewind can continue without guessing file restores.
//!
//! Only files changed through the harness write tools are tracked. Anything a
//! shell command, MCP tool, editor or other program changes is not, and the
//! [`RestoreReport`] says so.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Files above this size are not snapshotted ("too large, not restorable").
pub const MAX_CHECKPOINT_FILE_BYTES: u64 = 10 * 1024 * 1024;

const MANIFEST: &str = "manifest.json";
const BLOBS: &str = "blobs";
const RECOVERY: &str = "recovery";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Prior {
    /// The file did not exist; restoring deletes it.
    Absent,
    /// Prior content stored as blob `hash`.
    Blob { hash: String },
    /// Prior content exceeded the size cap and was not stored.
    TooLarge { bytes: u64 },
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CheckpointRecord {
    files: BTreeMap<String, Prior>,
    /// Shell commands run during this checkpoint; their effects are untracked.
    #[serde(default)]
    untracked_commands: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TimelineEntry {
    index: usize,
    /// Summary baselines are selected only by a rewind to zero.
    #[serde(default)]
    summary: bool,
}

/// An ambiguous timeline is never guessed or discarded. Its original manifest
/// bytes live in an immutable recovery file; these explicit references keep its
/// content-addressed priors alive through subsequent active-store GC.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecoveryArchive {
    manifest_file: String,
    reason: String,
    blob_hashes: BTreeSet<String>,
    /// Rewinding below this visible boundary would remove ambiguous retained
    /// history. Conversation-only rewind can lower this barrier intentionally.
    ambiguous_before: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpectedHistory {
    len: usize,
    hash: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Manifest {
    checkpoints: BTreeMap<usize, CheckpointRecord>,
    #[serde(default)]
    timeline: BTreeMap<usize, TimelineEntry>,
    #[serde(default)]
    next_key: usize,
    #[serde(default)]
    timeline_initialized: bool,
    /// Detect a manifest published before its compacted SQLite transcript.
    #[serde(default)]
    summary_anchor: Option<String>,
    #[serde(default)]
    recovery: Vec<RecoveryArchive>,
    /// Lowered recovery barriers are unsafe until SQLite confirms the rewind.
    #[serde(default)]
    pending_conversation_rewind: Option<ExpectedHistory>,
}

/// Outcome of [`CheckpointStore::restore`].
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// Files whose earlier content was written back.
    pub restored: Vec<String>,
    /// Files created during the rewound turns that were deleted.
    pub deleted: Vec<String>,
    /// Files that were changed but are too large to have been snapshotted.
    pub skipped_too_large: Vec<String>,
    /// Files that could not be restored (I/O error), or checkpoint metadata
    /// that could not be saved, with the reason. Their snapshots are retained.
    pub failed: Vec<String>,
    /// Honest statement of what a rewind cannot undo.
    pub untracked_note: String,
}

pub struct CheckpointStore {
    root: PathBuf,
    manifest: Mutex<Manifest>,
}

impl CheckpointStore {
    /// Opens (creating if needed) a store rooted at `root`.
    /// Only a missing manifest starts empty; unreadable or invalid persisted
    /// metadata must be repaired before any checkpoint can be discarded.
    pub fn open(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        let manifest = match fs::read(root.join(MANIFEST)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("cannot parse checkpoint manifest: {error}"),
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Manifest::default(),
            Err(error) => return Err(error),
        };
        fs::create_dir_all(root.join(BLOBS))?;
        Ok(Self {
            root,
            manifest: Mutex::new(manifest),
        })
    }

    /// Removes every checkpoint of a store (session deletion).
    pub fn destroy(root: &Path) -> std::io::Result<()> {
        match fs::remove_dir_all(root) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    /// Checkpoint ids currently held, ascending.
    pub fn checkpoint_ids(&self) -> Vec<usize> {
        self.lock().checkpoints.keys().copied().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Manifest> {
        self.manifest.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reconcile legacy positional records only against an uncompacted history.
    /// A shortened legacy transcript cannot establish which edits it represents.
    pub fn prepare_history(&self, history: &[crate::Message]) -> Result<(), String> {
        let mut manifest = self.lock();
        if let Some(reason) = history_mismatch(&manifest, history) {
            return Err(reason);
        }
        if manifest.timeline_initialized {
            return Ok(());
        }
        let mut candidate = manifest.clone();
        for &key in manifest.checkpoints.keys() {
            candidate.timeline.insert(
                key,
                TimelineEntry {
                    index: key,
                    summary: false,
                },
            );
        }
        candidate.next_key = candidate
            .checkpoints
            .keys()
            .next_back()
            .copied()
            .map_or(Ok(1), |key| {
                key.checked_add(1).ok_or("Checkpoint key space exhausted")
            })?
            .max(manifest.next_key)
            .max(1);
        candidate.timeline_initialized = true;
        self.save(&candidate)?;
        *manifest = candidate;
        Ok(())
    }

    /// Continue a conversation even when legacy/crash checkpoint positions are
    /// ambiguous. Preserve the original manifest and every referenced blob in a
    /// durable quarantine before establishing a fresh active timeline.
    /// The returned notice must be surfaced by the caller; file restore across
    /// retained ambiguous history remains blocked by `prepare_restore`/`restore`.
    pub fn prepare_continuation(
        &self,
        history: &[crate::Message],
    ) -> Result<Option<String>, String> {
        let mut manifest = self.lock();
        let Some(reason) = history_mismatch(&manifest, history) else {
            drop(manifest);
            self.prepare_history(history)?;
            self.confirm_history(history)?;
            return Ok(self.recovery_note());
        };
        let original = fs::read(self.root.join(MANIFEST))
            .map_err(|error| format!("Cannot preserve checkpoint recovery manifest: {error}"))?;
        let digest: String = Sha256::digest(&original)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let filename = format!("{RECOVERY}/manifest-{digest}.json");
        let backup = self.root.join(&filename);
        fs::create_dir_all(self.root.join(RECOVERY))
            .map_err(|error| format!("Cannot create checkpoint recovery archive: {error}"))?;
        // Content-addressed archive names preserve the exact original bytes.
        // Existing archives are verified, never overwritten with other data.
        match fs::read(&backup) {
            Ok(bytes) if bytes == original => {}
            Ok(_) => {
                return Err(
                    "Checkpoint recovery archive content does not match its identity".into(),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                atomic_write(&backup, &original)
                    .map_err(|error| format!("Cannot save checkpoint recovery archive: {error}"))?;
            }
            Err(error) => return Err(format!("Cannot read checkpoint recovery archive: {error}")),
        }
        let mut candidate = manifest.clone();
        candidate.next_key = candidate
            .next_key
            .max(
                candidate
                    .checkpoints
                    .keys()
                    .chain(candidate.timeline.keys())
                    .copied()
                    .max()
                    .map_or(Ok(1), |key| {
                        key.checked_add(1).ok_or("Checkpoint key space exhausted")
                    })?,
            )
            .max(1);
        candidate.recovery.push(RecoveryArchive {
            manifest_file: filename,
            reason,
            blob_hashes: checkpoint_blob_hashes(&candidate.checkpoints),
            ambiguous_before: history.len(),
        });
        candidate.checkpoints.clear();
        candidate.timeline.clear();
        candidate.summary_anchor = None;
        candidate.timeline_initialized = true;
        candidate.pending_conversation_rewind = None;
        self.save(&candidate)?;
        *manifest = candidate;
        Ok(recovery_note(&manifest))
    }

    /// Validate file restoration separately from permissive SEND/conversation
    /// continuation. This method never quarantines or guesses an old mapping.
    pub fn prepare_restore(&self, history: &[crate::Message], keep: usize) -> Result<(), String> {
        self.prepare_history(history)?;
        self.confirm_history(history)?;
        let manifest = self.lock();
        match recovery_barrier_error(&manifest, keep) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn recovery_note(&self) -> Option<String> {
        recovery_note(&self.lock())
    }

    /// The caller writes `history[..keep]` to its transcript store, then calls
    /// `confirm_history` with that exact persisted history. A failed transcript
    /// write leaves a durable guard against unsafe lowered recovery barriers.
    pub fn prepare_conversation_rewind(
        &self,
        history: &[crate::Message],
        keep: usize,
    ) -> Result<Option<String>, String> {
        if keep > history.len() {
            return Err("Conversation rewind boundary exceeds history".into());
        }
        let note = self.prepare_continuation(history)?;
        let mut manifest = self.lock();
        let mut candidate = manifest.clone();
        for key in selected_keys(&manifest, keep) {
            candidate.checkpoints.remove(&key);
            candidate.timeline.remove(&key);
        }
        for archive in &mut candidate.recovery {
            archive.ambiguous_before = archive.ambiguous_before.min(keep);
        }
        if keep == 0 {
            candidate.summary_anchor = None;
        }
        candidate.pending_conversation_rewind = Some(history_expectation(&history[..keep]));
        self.save(&candidate)?;
        *manifest = candidate;
        self.collect_garbage(&manifest);
        Ok(note)
    }

    /// Never clear this guard merely because the longer old history shares
    /// the desired prefix. Confirmation requires exact length and content.
    pub fn confirm_history(&self, history: &[crate::Message]) -> Result<(), String> {
        let mut manifest = self.lock();
        let Some(expected) = &manifest.pending_conversation_rewind else {
            return Ok(());
        };
        if !history_matches(expected, history) {
            return Err("Checkpoint conversation rewind is awaiting confirmation of the persisted transcript; keep both stores for recovery.".into());
        }
        let mut candidate = manifest.clone();
        candidate.pending_conversation_rewind = None;
        self.save(&candidate)?;
        *manifest = candidate;
        Ok(())
    }

    /// Allocate a durable identity for a real user/steer/Stop boundary. Keys are
    /// never recycled after rewind or compaction.
    pub fn begin_boundary(&self, index: usize) -> Result<usize, String> {
        let mut manifest = self.lock();
        let mut candidate = manifest.clone();
        let key = candidate.next_key.max(1);
        candidate.next_key = key.checked_add(1).ok_or("Checkpoint key space exhausted")?;
        candidate.timeline_initialized = true;
        candidate.timeline.insert(
            key,
            TimelineEntry {
                index,
                summary: false,
            },
        );
        self.save(&candidate)?;
        *manifest = candidate;
        Ok(key)
    }

    /// Rebase exact retained positions while preserving stable identities. The
    /// earliest prior state of summarized edits lives only at summary index 0.
    pub fn rebase_compaction(
        &self,
        split: usize,
        compacted: &[crate::Message],
        active: usize,
    ) -> Result<usize, String> {
        if split == 0 || compacted.len() < 2 || !is_summary(&compacted[0]) {
            return Err("Invalid checkpoint compaction metadata".into());
        }
        let mut manifest = self.lock();
        if !manifest.timeline_initialized {
            return Err("Checkpoint timeline must be initialized before compaction".into());
        }
        let mut candidate = manifest.clone();
        let mut older: Vec<_> = manifest
            .timeline
            .iter()
            .filter(|(_, entry)| entry.index < split)
            .map(|(&key, entry)| (entry.index, key))
            .collect();
        older.sort_unstable();
        let mut baseline = CheckpointRecord::default();
        for (_, key) in &older {
            if let Some(record) = candidate.checkpoints.remove(key) {
                baseline.untracked_commands = baseline
                    .untracked_commands
                    .saturating_add(record.untracked_commands);
                for (path, prior) in record.files {
                    insert_earliest(&mut baseline.files, path, prior);
                }
            }
            candidate.timeline.remove(key);
        }
        for entry in candidate.timeline.values_mut() {
            entry.index = entry.index - split + 2;
        }
        // Ambiguity represented by the retained summary still blocks rewind
        // zero. Retained/new turns after that summary remain independently
        // restorable, so rebase the barrier with the exact same split.
        for archive in &mut candidate.recovery {
            if archive.ambiguous_before != 0 {
                archive.ambiguous_before = if archive.ambiguous_before <= split {
                    2
                } else {
                    archive.ambiguous_before - split + 2
                };
            }
        }
        let baseline_key = candidate.next_key.max(1);
        candidate.next_key = baseline_key
            .checked_add(1)
            .ok_or("Checkpoint key space exhausted")?;
        candidate.timeline.insert(
            baseline_key,
            TimelineEntry {
                index: 0,
                summary: true,
            },
        );
        if !baseline.files.is_empty() || baseline.untracked_commands != 0 {
            candidate.checkpoints.insert(baseline_key, baseline);
        }
        let active = if candidate.timeline.contains_key(&active) {
            active
        } else {
            let key = candidate.next_key;
            candidate.next_key = key.checked_add(1).ok_or("Checkpoint key space exhausted")?;
            candidate.timeline.insert(
                key,
                TimelineEntry {
                    index: compacted.len() - 1,
                    summary: false,
                },
            );
            key
        };
        candidate.summary_anchor = Some(message_hash(&compacted[0]));
        self.save(&candidate)?;
        *manifest = candidate;
        self.collect_garbage(&manifest);
        Ok(active)
    }

    /// Records the prior state of `path` for checkpoint `id` unless this
    /// checkpoint already has it (the first record is the earliest state).
    pub fn record_before(&self, id: usize, path: &Path) -> Result<(), String> {
        let path = normalize(path);
        let key = path.to_string_lossy().into_owned();
        let identity = path_identity(&path);
        let mut manifest = self.lock();
        if manifest.timeline_initialized && !manifest.timeline.contains_key(&id) {
            return Err("Checkpoint identity has no active timeline boundary".into());
        }
        if manifest.checkpoints.get(&id).is_some_and(|record| {
            record
                .files
                .keys()
                .any(|key| path_identity(Path::new(key)) == identity)
        }) {
            return Ok(());
        }
        let prior = match fs::metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Prior::Absent,
            Err(error) => return Err(format!("cannot stat {}: {error}", path.display())),
            Ok(meta) if meta.is_dir() => return Ok(()),
            Ok(meta) if meta.len() > MAX_CHECKPOINT_FILE_BYTES => {
                Prior::TooLarge { bytes: meta.len() }
            }
            Ok(_) => {
                let bytes = fs::read(&path)
                    .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
                Prior::Blob {
                    hash: self.store_blob(&bytes)?,
                }
            }
        };
        let mut recorded = manifest.clone();
        recorded
            .checkpoints
            .entry(id)
            .or_default()
            .files
            .insert(key, prior);
        // A failed save must not make the next write think its snapshot is
        // durable. Publish the record only after persistence succeeds.
        self.save(&recorded)?;
        *manifest = recorded;
        Ok(())
    }

    /// Notes that an untrackable command ran during checkpoint `id`.
    pub fn note_untracked_command(&self, id: usize) -> Result<(), String> {
        let mut manifest = self.lock();
        if manifest.timeline_initialized && !manifest.timeline.contains_key(&id) {
            return Err("Checkpoint identity has no active timeline boundary".into());
        }
        let mut candidate = manifest.clone();
        let record = candidate.checkpoints.entry(id).or_default();
        record.untracked_commands = record.untracked_commands.saturating_add(1);
        self.save(&candidate)?;
        *manifest = candidate;
        Ok(())
    }

    fn store_blob(&self, bytes: &[u8]) -> Result<String, String> {
        let hash: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let target = self.root.join(BLOBS).join(&hash);
        if !target.exists() {
            atomic_write(&target, bytes)
                .map_err(|error| format!("cannot store checkpoint blob: {error}"))?;
        }
        Ok(hash)
    }

    fn save(&self, manifest: &Manifest) -> Result<(), String> {
        let json = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
        atomic_write(&self.root.join(MANIFEST), &json)
            .map_err(|error| format!("cannot save checkpoint manifest: {error}"))
    }

    /// Restores every file changed in checkpoints `>= to_message_index` to its
    /// earliest recorded state, then forgets successfully handled paths.
    /// Failed paths retain their snapshots so restoration can be retried,
    /// including after reopening the store.
    pub fn restore(&self, to_message_index: usize) -> RestoreReport {
        let mut manifest = self.lock();
        let mut report = RestoreReport::default();
        if manifest.pending_conversation_rewind.is_some() {
            report.failed.push("Conversation-only rewind requires persisted history confirmation before file restore".into());
            report.untracked_note = untracked_note(0);
            return report;
        }
        if let Some(error) = recovery_barrier_error(&manifest, to_message_index) {
            report.failed.push(error);
            report.untracked_note = untracked_note(0);
            return report;
        }
        let mut untracked_commands = 0u32;
        let mut failed_paths = BTreeSet::new();

        // Ascending ids, first record wins = earliest state of each path.
        let mut earliest: BTreeMap<String, Prior> = BTreeMap::new();
        let selected = selected_keys(&manifest, to_message_index);
        for id in &selected {
            let Some(record) = manifest.checkpoints.get(id) else {
                continue;
            };
            untracked_commands = untracked_commands.saturating_add(record.untracked_commands);
            for (path, prior) in &record.files {
                insert_earliest(&mut earliest, path.clone(), prior.clone());
            }
        }

        for (path, prior) in &earliest {
            let target = Path::new(path);
            match prior {
                Prior::Absent => match fs::remove_file(target) {
                    Ok(()) => report.deleted.push(path.clone()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        failed_paths.insert(path.clone());
                        report.failed.push(format!("{path}: {error}"));
                    }
                },
                Prior::TooLarge { .. } => report.skipped_too_large.push(path.clone()),
                Prior::Blob { hash } => {
                    let result = fs::read(self.root.join(BLOBS).join(hash))
                        .map_err(|error| format!("checkpoint data missing: {error}"))
                        .and_then(|bytes| {
                            if let Some(parent) = target.parent() {
                                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                            }
                            fs::write(target, bytes).map_err(|e| e.to_string())
                        });
                    match result {
                        Ok(()) => report.restored.push(path.clone()),
                        Err(error) => {
                            failed_paths.insert(path.clone());
                            report.failed.push(format!("{path}: {error}"));
                        }
                    }
                }
            }
        }

        report.untracked_note = untracked_note(untracked_commands);
        if let Some(note) = recovery_note(&manifest) {
            report.untracked_note.push(' ');
            report.untracked_note.push_str(&note);
        }

        let mut remaining = manifest.clone();
        remaining.checkpoints.retain(|id, record| {
            if !selected.contains(id) {
                return true;
            }
            record.files.retain(|path, _| {
                failed_paths.iter().any(|failed| {
                    path_identity(Path::new(path)) == path_identity(Path::new(failed))
                })
            });
            !record.files.is_empty()
        });
        // Failed restore retains the complete timeline so the original
        // transcript remains valid and the same boundary can be retried.
        if failed_paths.is_empty() {
            remaining.timeline.retain(|key, _| !selected.contains(key));
            if to_message_index == 0 {
                remaining.summary_anchor = None;
            }
        }
        // Keep the old in-memory and on-disk records if saving fails. Garbage
        // collection must never delete blobs still referenced by disk state.
        match self.save(&remaining) {
            Ok(()) => {
                *manifest = remaining;
                self.collect_garbage(&manifest);
            }
            Err(error) => report.failed.push(error),
        }
        report
    }

    /// Forgets checkpoints `>= to_message_index` without touching any file
    /// (conversation-only rewind: later turns must start from fresh records).
    /// A persistence failure retains the records and is returned to the caller.
    pub fn forget_from(&self, to_message_index: usize) -> Result<(), String> {
        let mut manifest = self.lock();
        let dropped = selected_keys(&manifest, to_message_index);
        let mut remaining = manifest.clone();
        let mut recovery_changed = false;
        for archive in &mut remaining.recovery {
            let retained = archive.ambiguous_before.min(to_message_index);
            recovery_changed |= retained != archive.ambiguous_before;
            archive.ambiguous_before = retained;
        }
        if dropped.is_empty() && !recovery_changed {
            return Ok(());
        }
        for id in dropped {
            remaining.checkpoints.remove(&id);
            remaining.timeline.remove(&id);
        }
        if to_message_index == 0 {
            remaining.summary_anchor = None;
        }
        self.save(&remaining)?;
        *manifest = remaining;
        self.collect_garbage(&manifest);
        Ok(())
    }

    fn collect_garbage(&self, manifest: &Manifest) {
        let live: HashSet<&str> = manifest
            .checkpoints
            .values()
            .flat_map(|record| record.files.values())
            .filter_map(|prior| match prior {
                Prior::Blob { hash } => Some(hash.as_str()),
                _ => None,
            })
            .chain(
                manifest
                    .recovery
                    .iter()
                    .flat_map(|archive| archive.blob_hashes.iter().map(String::as_str)),
            )
            .collect();
        let Ok(entries) = fs::read_dir(self.root.join(BLOBS)) else {
            return;
        };
        for entry in entries.flatten() {
            if !live.contains(entry.file_name().to_string_lossy().as_ref()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Distinct paths tracked in checkpoints `>= to_message_index` (preview).
    pub fn tracked_paths(&self, to_message_index: usize) -> BTreeSet<String> {
        let manifest = self.lock();
        selected_keys(&manifest, to_message_index)
            .into_iter()
            .filter_map(|key| manifest.checkpoints.get(&key))
            .flat_map(|record| record.files.keys().cloned())
            .collect()
    }
}

fn history_mismatch(manifest: &Manifest, history: &[crate::Message]) -> Option<String> {
    if let Some(expected) = &manifest.pending_conversation_rewind {
        if !history_matches(expected, history) {
            return Some("Checkpoint conversation rewind does not match the persisted conversation; a transcript write may have failed.".into());
        }
    }
    if let Some(anchor) = &manifest.summary_anchor {
        if history.first().map(message_hash).as_ref() != Some(anchor) {
            return Some("Checkpoint timeline does not match the persisted conversation; a compaction transcript save may have failed. Keep both stores and recover the matching conversation before file rewind.".into());
        }
    }
    if manifest.timeline_initialized {
        if manifest
            .timeline
            .values()
            .any(|entry| entry.index >= history.len())
        {
            return Some("Checkpoint timeline extends beyond the conversation; recovery is required before file rewind.".into());
        }
    } else if !manifest.checkpoints.is_empty()
        && (history.iter().any(is_summary)
            || manifest.checkpoints.keys().any(|&index| {
                history
                    .get(index)
                    .is_none_or(|message| message.role != crate::Role::User)
            }))
    {
        return Some("Legacy file checkpoints cannot be safely mapped to this conversation. Keep the checkpoint data for recovery; positional migration requires the original uncompacted transcript.".into());
    }
    None
}

fn history_expectation(history: &[crate::Message]) -> ExpectedHistory {
    let hash =
        Sha256::digest(serde_json::to_vec(history).expect("Message serialization is infallible"))
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
    ExpectedHistory {
        len: history.len(),
        hash,
    }
}

fn history_matches(expected: &ExpectedHistory, history: &[crate::Message]) -> bool {
    expected.len == history.len() && expected.hash == history_expectation(history).hash
}

fn checkpoint_blob_hashes(checkpoints: &BTreeMap<usize, CheckpointRecord>) -> BTreeSet<String> {
    checkpoints
        .values()
        .flat_map(|record| record.files.values())
        .filter_map(|prior| match prior {
            Prior::Blob { hash } => Some(hash.clone()),
            _ => None,
        })
        .collect()
}

fn recovery_note(manifest: &Manifest) -> Option<String> {
    if manifest.recovery.is_empty() {
        return None;
    }
    let paths = manifest
        .recovery
        .iter()
        .map(|archive| archive.manifest_file.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "Earlier file checkpoints have an ambiguous conversation mapping and were preserved for recovery in {paths}. Conversation can continue. Their file effects are not automatically restored; rewinding files across retained ambiguous history requires explicit recovery."
    ))
}

fn recovery_barrier_error(manifest: &Manifest, keep: usize) -> Option<String> {
    manifest.recovery.iter().find(|archive| keep < archive.ambiguous_before).map(|archive| {
        format!("File checkpoint recovery required before rewinding retained ambiguous history. Original manifest and snapshots are preserved in {}. {}", archive.manifest_file, archive.reason)
    })
}

fn selected_keys(manifest: &Manifest, index: usize) -> Vec<usize> {
    if !manifest.timeline_initialized {
        return manifest
            .checkpoints
            .range(index..)
            .map(|(&key, _)| key)
            .collect();
    }
    let mut selected: Vec<_> = manifest
        .timeline
        .iter()
        .filter(|(_, entry)| {
            if entry.summary {
                index == 0
            } else {
                entry.index >= index
            }
        })
        .map(|(&key, entry)| (entry.index, key))
        .collect();
    selected.sort_unstable();
    selected.into_iter().map(|(_, key)| key).collect()
}

fn message_hash(message: &crate::Message) -> String {
    Sha256::digest(serde_json::to_vec(message).expect("Message serialization is infallible"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_summary(message: &crate::Message) -> bool {
    message.role == crate::Role::User && message.content.iter().any(|block| {
        matches!(block, crate::Block::Text { text } if text.starts_with("<summary of earlier conversation>\n"))
    })
}

fn untracked_note(commands: u32) -> String {
    let base = "Only files changed by Omnia's file tools (write_file, edit_file, multi_edit, apply_patch) are restored. Changes made by shell commands, MCP tools or other programs are not tracked and were not rewound.";
    if commands == 0 {
        base.to_owned()
    } else {
        format!(
            "{base} {commands} shell command(s) ran in the rewound turns; any files they changed were left as they are."
        )
    }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = target.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, target)
}

/// Lexically removes `.` and resolves `..` so one file has one key.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn path_identity(path: &Path) -> String {
    let mut ancestor = normalize(path);
    let mut suffix = Vec::new();
    let canonical = loop {
        if let Ok(canonical) = fs::canonicalize(&ancestor) {
            break canonical;
        }
        let Some(name) = ancestor.file_name().map(|name| name.to_owned()) else {
            break ancestor;
        };
        suffix.push(name);
        if !ancestor.pop() {
            break ancestor;
        }
    };
    let mut canonical = canonical;
    for part in suffix.into_iter().rev() {
        canonical.push(part);
    }
    let key = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        key.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        key
    }
}

fn insert_earliest(files: &mut BTreeMap<String, Prior>, path: String, prior: Prior) {
    let identity = path_identity(Path::new(&path));
    if !files
        .keys()
        .any(|existing| path_identity(Path::new(existing)) == identity)
    {
        files.insert(path, prior);
    }
}

/// What a tool sees: the store plus the checkpoint id of the running turn.
#[derive(Clone)]
pub struct CheckpointScope {
    pub store: Arc<CheckpointStore>,
    cursor: Arc<Mutex<usize>>,
    /// Child agents share file snapshots, but have their own transcript.
    manage_timeline: bool,
}

impl CheckpointScope {
    /// Compatibility constructor for callers recording an already assigned key.
    pub fn from_key(store: Arc<CheckpointStore>, key: usize) -> Self {
        Self {
            store,
            cursor: Arc::new(Mutex::new(key)),
            manage_timeline: false,
        }
    }

    pub fn begin(
        store: Arc<CheckpointStore>,
        history: &[crate::Message],
        index: usize,
    ) -> Result<Self, String> {
        store.prepare_continuation(history)?;
        let key = store.begin_boundary(index)?;
        Ok(Self {
            store,
            cursor: Arc::new(Mutex::new(key)),
            manage_timeline: true,
        })
    }

    pub fn key(&self) -> usize {
        *self.cursor.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Nonfatal notice for callers to surface after continuing an ambiguous
    /// legacy/crash history. Archived snapshots remain available for recovery.
    pub fn recovery_note(&self) -> Option<String> {
        self.store.recovery_note()
    }

    pub fn child(&self) -> Self {
        Self {
            store: Arc::clone(&self.store),
            cursor: Arc::clone(&self.cursor),
            manage_timeline: false,
        }
    }

    pub fn advance(&self, index: usize) -> Result<(), String> {
        if self.manage_timeline {
            let key = self.store.begin_boundary(index)?;
            *self.cursor.lock().unwrap_or_else(|e| e.into_inner()) = key;
        }
        Ok(())
    }

    pub fn compact(&self, split: usize, compacted: &[crate::Message]) -> Result<(), String> {
        if self.manage_timeline {
            let key = self.store.rebase_compaction(split, compacted, self.key())?;
            *self.cursor.lock().unwrap_or_else(|e| e.into_inner()) = key;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store(dir: &tempfile::TempDir) -> CheckpointStore {
        CheckpointStore::open(dir.path().join("cp")).unwrap()
    }

    fn timeline_history() -> Vec<crate::Message> {
        (0..16)
            .map(|index| {
                if index % 2 == 0 {
                    crate::Message::user(format!("turn {index}"))
                } else {
                    crate::Message::assistant(vec![crate::Block::text("reply")])
                }
            })
            .collect()
    }

    fn compacted_history(history: &[crate::Message], split: usize) -> Vec<crate::Message> {
        let mut messages = vec![
            crate::Message::user("<summary of earlier conversation>\nsummary"),
            crate::Message::assistant(vec![crate::Block::text("ack")]),
        ];
        messages.extend_from_slice(&history[split..]);
        messages
    }

    #[test]
    fn compaction_rebases_stable_keys_and_summary_restore_survives_reopen() {
        for keep in [0, 2] {
            let dir = tempdir().unwrap();
            let cp = store(&dir);
            let history = timeline_history();
            let mut files = Vec::new();
            for index in [2, 10, 14] {
                let file = dir.path().join(format!("{index}.txt"));
                fs::write(&file, "before").unwrap();
                cp.record_before(index, &file).unwrap();
                fs::write(&file, "after").unwrap();
                files.push(file);
            }
            cp.prepare_history(&history).unwrap();
            let active = cp.begin_boundary(14).unwrap();
            let compacted = compacted_history(&history, 10);
            assert_eq!(
                cp.rebase_compaction(10, &compacted, active).unwrap(),
                active
            );
            {
                let manifest = cp.lock();
                assert_eq!(manifest.timeline[&10].index, 2);
                assert_eq!(manifest.timeline[&14].index, 6);
                assert!(!manifest.timeline.contains_key(&2));
                assert!(manifest
                    .timeline
                    .values()
                    .any(|entry| entry.index == 0 && entry.summary));
            }
            drop(cp);
            let cp = store(&dir);
            cp.prepare_history(&compacted).unwrap();
            assert!(cp
                .prepare_history(&history)
                .unwrap_err()
                .contains("does not match"));
            let report = cp.restore(keep);
            assert!(report.failed.is_empty(), "{report:?}");
            assert_eq!(
                fs::read_to_string(&files[0]).unwrap(),
                if keep == 0 { "before" } else { "after" }
            );
            assert_eq!(fs::read_to_string(&files[1]).unwrap(), "before");
            assert_eq!(fs::read_to_string(&files[2]).unwrap(), "before");
        }
    }

    #[test]
    fn repeated_compaction_same_path_preserves_summary_work_for_retained_rewind() {
        for keep in [0, 2] {
            let dir = tempdir().unwrap();
            let cp = Arc::new(store(&dir));
            let history = timeline_history();
            let file = dir.path().join("shared.txt");
            let summary_only = dir.path().join("summary-only.txt");
            fs::write(&file, "original").unwrap();
            fs::write(&summary_only, "summary original").unwrap();
            let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 2).unwrap();
            cp.record_before(scope.key(), &file).unwrap();
            cp.record_before(scope.key(), &summary_only).unwrap();
            fs::write(&file, "first summarized edit").unwrap();
            fs::write(&summary_only, "kept summarized work").unwrap();
            scope.advance(10).unwrap();
            cp.record_before(scope.key(), &file).unwrap();
            fs::write(&file, "second summarized edit").unwrap();
            scope.advance(14).unwrap();
            let retained_key = scope.key();
            cp.record_before(retained_key, &file).unwrap();
            fs::write(&file, "retained edit").unwrap();

            let first = compacted_history(&history, 10);
            scope.compact(10, &first).unwrap();
            assert_eq!(scope.key(), retained_key);
            assert_eq!(cp.lock().timeline[&retained_key].index, 6);
            let mut second = compacted_history(&first, 6);
            second[0] = crate::Message::user(
                "<summary of earlier conversation>\nsecond compaction summary",
            );
            scope.compact(6, &second).unwrap();
            assert_eq!(scope.key(), retained_key);
            assert_eq!(cp.lock().timeline[&retained_key].index, 2);
            assert_eq!(
                cp.lock()
                    .timeline
                    .values()
                    .filter(|entry| entry.summary)
                    .count(),
                1,
                "the earlier summary baseline is merged into the new baseline"
            );
            drop(scope);
            drop(cp);

            let cp = store(&dir);
            cp.prepare_history(&second).unwrap();
            assert!(cp.prepare_history(&first).is_err());
            let report = cp.restore(keep);
            assert!(report.failed.is_empty(), "{report:?}");
            assert_eq!(
                fs::read_to_string(&file).unwrap(),
                if keep == 0 {
                    "original"
                } else {
                    "second summarized edit"
                },
                "retained rewind keeps both summarized edits; rewind zero uses the original prior"
            );
            assert_eq!(
                fs::read_to_string(&summary_only).unwrap(),
                if keep == 0 {
                    "summary original"
                } else {
                    "kept summarized work"
                }
            );
        }
    }

    #[test]
    fn post_compaction_writes_follow_stable_cursor_and_restore_retained_boundary() {
        let dir = tempdir().unwrap();
        let cp = Arc::new(store(&dir));
        let history = timeline_history();
        let file = dir.path().join("shared.txt");
        fs::write(&file, "original").unwrap();
        let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 2).unwrap();
        cp.record_before(scope.key(), &file).unwrap();
        fs::write(&file, "summarized edit").unwrap();
        scope.advance(14).unwrap();
        let retained_key = scope.key();
        cp.record_before(retained_key, &file).unwrap();
        fs::write(&file, "before compaction").unwrap();
        let mut compacted = compacted_history(&history, 10);
        scope.compact(10, &compacted).unwrap();
        assert_eq!(scope.key(), retained_key);
        assert_eq!(cp.lock().timeline[&retained_key].index, 6);

        // A later tool in the same logical turn keeps its original prior,
        // even though its visible position changed from fourteen to six.
        cp.record_before(scope.key(), &file).unwrap();
        fs::write(&file, "continued after compaction").unwrap();
        assert_eq!(cp.lock().checkpoints[&retained_key].files.len(), 1);
        compacted.push(crate::Message::user("a later user turn"));
        scope.advance(8).unwrap();
        let later_key = scope.key();
        assert!(later_key > retained_key);
        cp.record_before(later_key, &file).unwrap();
        fs::write(&file, "later turn edit").unwrap();
        drop(scope);
        drop(cp);

        let cp = store(&dir);
        cp.prepare_history(&compacted).unwrap();
        assert!(cp.restore(8).failed.is_empty());
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "continued after compaction"
        );
        assert_eq!(cp.lock().timeline[&retained_key].index, 6);
        assert!(!cp.lock().timeline.contains_key(&later_key));
        assert!(cp.restore(6).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "summarized edit");
        assert!(cp.restore(0).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    }

    #[test]
    fn compaction_save_failure_keeps_old_timeline_cursor_and_blobs_for_retry() {
        let dir = tempdir().unwrap();
        let cp = Arc::new(store(&dir));
        let history = timeline_history();
        let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 14).unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "before").unwrap();
        cp.record_before(scope.key(), &file).unwrap();
        let old_key = scope.key();
        let old_manifest = fs::read(dir.path().join("cp/manifest.json")).unwrap();
        fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        let compacted = compacted_history(&history, 10);
        assert!(scope.compact(10, &compacted).is_err());
        assert_eq!(scope.key(), old_key);
        assert_eq!(cp.lock().timeline[&old_key].index, 14);
        assert_eq!(
            fs::read(dir.path().join("cp/manifest.json")).unwrap(),
            old_manifest
        );
        fs::remove_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        scope.compact(10, &compacted).unwrap();
        assert_eq!(cp.lock().timeline[&old_key].index, 6);
    }

    #[test]
    fn cursor_moves_for_real_boundaries_but_child_transcripts_cannot_move_it() {
        let dir = tempdir().unwrap();
        let cp = Arc::new(store(&dir));
        let history = timeline_history();
        let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 0).unwrap();
        let original = scope.key();
        let clone = scope.clone();
        let child = scope.child();
        child.advance(200).unwrap();
        assert_eq!(scope.key(), original);
        let file = dir.path().join("a.txt");
        fs::write(&file, "before").unwrap();
        cp.record_before(scope.key(), &file).unwrap();
        fs::write(&file, "middle").unwrap();
        scope.advance(4).unwrap();
        let steered = scope.key();
        assert!(steered > original);
        assert_eq!(clone.key(), steered);
        assert_eq!(child.key(), steered);
        cp.record_before(child.key(), &file).unwrap();
        fs::write(&file, "after").unwrap();
        assert!(cp.restore(4).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "middle");
        scope.advance(4).unwrap();
        assert!(scope.key() > steered, "rewind never reuses an identity");
        assert!(cp.restore(0).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");
    }

    #[test]
    fn legacy_compacted_or_shortened_histories_require_explicit_recovery() {
        let dir = tempdir().unwrap();
        let cp = store(&dir);
        let file = dir.path().join("a.txt");
        cp.record_before(14, &file).unwrap();
        let history = timeline_history();
        assert!(cp
            .prepare_history(&compacted_history(&history, 10))
            .is_err());
        assert!(cp.prepare_history(&history[..4]).is_err());
        assert!(!cp.lock().timeline_initialized);
        cp.prepare_history(&history).unwrap();
        assert_eq!(cp.lock().timeline[&14].index, 14);
    }

    #[test]
    fn legacy_merged_truncated_and_compacted_mappings_are_quarantined_without_guessing() {
        let history = timeline_history();
        let variants = [
            (3, history[..4].to_vec()), // legacy pre-merge key now points to an assistant
            (14, history[..4].to_vec()), // legacy key beyond persisted history
            (2, compacted_history(&history, 10)), // plausible index in a shortened transcript
        ];
        for (legacy_key, mut persisted) in variants {
            let dir = tempdir().unwrap();
            let cp = Arc::new(store(&dir));
            let file = dir.path().join("legacy.txt");
            fs::write(&file, "legacy original").unwrap();
            cp.record_before(legacy_key, &file).unwrap();
            fs::write(&file, "legacy edit").unwrap();
            let original = fs::read(cp.root.join(MANIFEST)).unwrap();
            assert!(cp.prepare_restore(&persisted, 0).is_err());
            let notice = cp.prepare_continuation(&persisted).unwrap().unwrap();
            assert!(notice.contains("preserved for recovery"));
            assert!(
                cp.checkpoint_ids().is_empty(),
                "ambiguous keys are not active"
            );
            let archive_file = cp.lock().recovery[0].manifest_file.clone();
            let archive_hashes = cp.lock().recovery[0].blob_hashes.clone();
            assert_eq!(fs::read(cp.root.join(&archive_file)).unwrap(), original);
            assert!(cp
                .prepare_restore(&persisted, 0)
                .unwrap_err()
                .contains("recovery required"));
            let denied = cp.restore(0);
            assert_eq!(denied.failed.len(), 1);
            assert_eq!(fs::read_to_string(&file).unwrap(), "legacy edit");

            // New effects have fresh identities and can be restored without
            // crossing the retained ambiguous history.
            let safe_index = persisted.len();
            persisted.push(crate::Message::user("continue safely"));
            let scope = CheckpointScope::begin(Arc::clone(&cp), &persisted, safe_index).unwrap();
            assert!(scope.key() > legacy_key);
            assert!(scope.recovery_note().is_some());
            cp.record_before(scope.key(), &file).unwrap();
            fs::write(&file, "new tracked edit").unwrap();
            cp.prepare_restore(&persisted, safe_index).unwrap();
            assert!(cp.restore(safe_index).failed.is_empty());
            assert_eq!(fs::read_to_string(&file).unwrap(), "legacy edit");

            // Conversation-only rewind intentionally keeps old file effects;
            // it never destroys the original manifest or its blob references.
            cp.forget_from(0).unwrap();
            assert_eq!(fs::read(cp.root.join(&archive_file)).unwrap(), original);
            for hash in &archive_hashes {
                assert!(cp.root.join(BLOBS).join(hash).is_file());
            }
            drop(scope);
            drop(cp);
            let cp = store(&dir);
            cp.prepare_restore(&[], 0).unwrap();
            assert_eq!(cp.lock().recovery.len(), 1);
            assert_eq!(fs::read(cp.root.join(archive_file)).unwrap(), original);
            for hash in archive_hashes {
                assert!(cp.root.join(BLOBS).join(hash).is_file());
            }
        }
    }

    #[test]
    fn crash_timeline_beyond_history_and_summary_mismatch_can_continue_after_quarantine() {
        for compacted_crash in [false, true] {
            let dir = tempdir().unwrap();
            let cp = Arc::new(store(&dir));
            let history = timeline_history();
            let file = dir.path().join("crash.txt");
            fs::write(&file, "original").unwrap();
            let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 14).unwrap();
            cp.record_before(scope.key(), &file).unwrap();
            fs::write(&file, "effect before crash").unwrap();
            let persisted = if compacted_crash {
                scope.compact(10, &compacted_history(&history, 10)).unwrap();
                history
            } else {
                history[..4].to_vec()
            };
            let old_next = cp.lock().next_key;
            let old_manifest = fs::read(cp.root.join(MANIFEST)).unwrap();
            let error = cp.prepare_restore(&persisted, 0).unwrap_err();
            assert!(error.contains(if compacted_crash {
                "does not match"
            } else {
                "extends beyond"
            }));
            let continued = CheckpointScope::begin(Arc::clone(&cp), &persisted, 2).unwrap();
            assert!(continued.key() >= old_next);
            assert!(continued.recovery_note().is_some());
            let archive = cp.lock().recovery[0].manifest_file.clone();
            assert_eq!(fs::read(cp.root.join(archive)).unwrap(), old_manifest);
            assert!(cp.prepare_restore(&persisted, 0).is_err());
            assert!(!cp.restore(0).failed.is_empty());
            assert_eq!(fs::read_to_string(&file).unwrap(), "effect before crash");
            cp.prepare_continuation(&persisted).unwrap();
            assert_eq!(
                cp.lock().recovery.len(),
                1,
                "normal continuation does not archive again"
            );
        }
    }

    #[test]
    fn archive_or_main_manifest_save_failure_keeps_original_mapping_and_snapshots() {
        let dir = tempdir().unwrap();
        let cp = store(&dir);
        let file = dir.path().join("legacy.txt");
        fs::write(&file, "original").unwrap();
        cp.record_before(14, &file).unwrap();
        let history = &timeline_history()[..4];
        let original = fs::read(cp.root.join(MANIFEST)).unwrap();
        let hashes = checkpoint_blob_hashes(&cp.lock().checkpoints);
        fs::write(cp.root.join(RECOVERY), "block archive directory").unwrap();
        assert!(cp
            .prepare_continuation(history)
            .unwrap_err()
            .contains("archive"));
        assert_eq!(cp.checkpoint_ids(), vec![14]);
        assert!(cp.lock().recovery.is_empty());
        assert_eq!(fs::read(cp.root.join(MANIFEST)).unwrap(), original);
        fs::remove_file(cp.root.join(RECOVERY)).unwrap();

        fs::create_dir(cp.root.join("manifest.tmp")).unwrap();
        assert!(cp
            .prepare_continuation(history)
            .unwrap_err()
            .contains("save checkpoint manifest"));
        assert_eq!(cp.checkpoint_ids(), vec![14]);
        assert!(!cp.lock().timeline_initialized);
        assert!(cp.lock().recovery.is_empty());
        assert_eq!(fs::read(cp.root.join(MANIFEST)).unwrap(), original);
        for hash in &hashes {
            assert!(cp.root.join(BLOBS).join(hash).is_file());
        }
        fs::remove_dir(cp.root.join("manifest.tmp")).unwrap();
        cp.prepare_continuation(history).unwrap();
        assert!(cp.checkpoint_ids().is_empty());
        assert_eq!(cp.lock().recovery.len(), 1);
        let archive = cp.lock().recovery[0].manifest_file.clone();
        assert_eq!(fs::read(cp.root.join(archive)).unwrap(), original);
    }

    #[test]
    fn conversation_only_rewind_preserves_multiple_quarantines_through_reopen_and_gc() {
        let dir = tempdir().unwrap();
        let cp = Arc::new(store(&dir));
        let history = timeline_history()[..4].to_vec();
        let old_file = dir.path().join("legacy.txt");
        fs::write(&old_file, "old original").unwrap();
        cp.record_before(14, &old_file).unwrap();
        fs::write(&old_file, "old unrewound effect").unwrap();
        cp.prepare_continuation(&history).unwrap();
        let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 2).unwrap();
        let crash_file = dir.path().join("crash.txt");
        fs::write(&crash_file, "crash original").unwrap();
        cp.record_before(scope.key(), &crash_file).unwrap();
        fs::write(&crash_file, "crash unrewound effect").unwrap();
        scope.advance(99).unwrap();
        let continued = CheckpointScope::begin(Arc::clone(&cp), &history, 2).unwrap();
        assert_eq!(cp.lock().recovery.len(), 2);
        let archived_hashes: BTreeSet<_> = cp
            .lock()
            .recovery
            .iter()
            .flat_map(|archive| archive.blob_hashes.iter().cloned())
            .collect();
        let backup_files: Vec<_> = cp
            .lock()
            .recovery
            .iter()
            .map(|archive| archive.manifest_file.clone())
            .collect();
        let new_file = dir.path().join("new.txt");
        fs::write(&new_file, "new original").unwrap();
        cp.record_before(continued.key(), &new_file).unwrap();
        let new_hashes = checkpoint_blob_hashes(&cp.lock().checkpoints);
        cp.forget_from(0).unwrap();
        assert_eq!(
            fs::read_to_string(&old_file).unwrap(),
            "old unrewound effect"
        );
        assert_eq!(
            fs::read_to_string(&crash_file).unwrap(),
            "crash unrewound effect"
        );
        assert!(cp
            .lock()
            .recovery
            .iter()
            .all(|archive| archive.ambiguous_before == 0));
        for hash in &archived_hashes {
            assert!(cp.root.join(BLOBS).join(hash).is_file());
        }
        for hash in new_hashes {
            assert!(!cp.root.join(BLOBS).join(hash).exists());
        }
        drop(continued);
        drop(scope);
        drop(cp);
        let cp = store(&dir);
        cp.prepare_restore(&[], 0).unwrap();
        assert!(cp.restore(0).failed.is_empty());
        assert!(cp.recovery_note().is_some());
        for hash in archived_hashes {
            assert!(cp.root.join(BLOBS).join(hash).is_file());
        }
        for backup in backup_files {
            assert!(cp.root.join(backup).is_file());
        }
    }

    #[test]
    fn quarantined_history_barrier_rebases_across_compaction_without_blocking_safe_turns() {
        // Both an entirely summarized ambiguous prefix and an ambiguous tail
        // straddling the split must retain exactly their conservative barrier.
        for (ambiguous_before, expected_barrier) in [(4, 2), (12, 4)] {
            let dir = tempdir().unwrap();
            let cp = Arc::new(store(&dir));
            let mut history = timeline_history();
            let file = dir.path().join("shared.txt");
            fs::write(&file, "legacy original").unwrap();
            cp.record_before(14, &file).unwrap();
            fs::write(&file, "kept legacy edit").unwrap();
            cp.prepare_continuation(&history[..ambiguous_before])
                .unwrap();
            let archived_hashes = cp.lock().recovery[0].blob_hashes.clone();
            let scope = CheckpointScope::begin(Arc::clone(&cp), &history, 14).unwrap();
            let retained_key = scope.key();
            cp.record_before(retained_key, &file).unwrap();
            fs::write(&file, "safe retained edit").unwrap();
            history = compacted_history(&history, 10);
            scope.compact(10, &history).unwrap();
            assert_eq!(scope.key(), retained_key);
            assert_eq!(cp.lock().recovery[0].ambiguous_before, expected_barrier);
            assert!(cp.prepare_restore(&history, expected_barrier - 1).is_err());
            cp.prepare_restore(&history, expected_barrier).unwrap();

            history.push(crate::Message::user("new turn after compaction"));
            scope.advance(8).unwrap();
            cp.record_before(scope.key(), &file).unwrap();
            fs::write(&file, "new post-compaction edit").unwrap();
            drop(scope);
            drop(cp);
            let cp = store(&dir);
            cp.prepare_restore(&history, 8).unwrap();
            assert!(cp.restore(8).failed.is_empty());
            assert_eq!(fs::read_to_string(&file).unwrap(), "safe retained edit");
            cp.prepare_restore(&history[..8], expected_barrier).unwrap();
            assert!(cp.restore(expected_barrier).failed.is_empty());
            assert_eq!(fs::read_to_string(&file).unwrap(), "kept legacy edit");
            assert!(
                !cp.restore(0).failed.is_empty(),
                "the retained summary still represents ambiguous old effects"
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), "kept legacy edit");
            for hash in archived_hashes {
                assert!(cp.root.join(BLOBS).join(hash).is_file());
            }
        }
    }

    #[test]
    fn conversation_rewind_barrier_waits_for_exact_persisted_history_confirmation() {
        let dir = tempdir().unwrap();
        let cp = store(&dir);
        let history = timeline_history()[..4].to_vec();
        let file = dir.path().join("legacy.txt");
        fs::write(&file, "legacy original").unwrap();
        cp.record_before(14, &file).unwrap();
        fs::write(&file, "kept legacy effect").unwrap();
        let note = cp.prepare_conversation_rewind(&history, 2).unwrap();
        assert!(note.is_some());
        assert!(cp.lock().pending_conversation_rewind.is_some());
        assert!(cp.confirm_history(&history).is_err());
        assert!(cp.prepare_restore(&history, 2).is_err());
        assert!(!cp.restore(0).failed.is_empty());
        drop(cp);

        let cp = store(&dir);
        assert!(
            cp.confirm_history(&history).is_err(),
            "the unchanged old SQLite history is not a confirmation"
        );
        cp.confirm_history(&history[..2]).unwrap();
        assert!(
            cp.prepare_restore(&history[..2], 0).is_err(),
            "retained ambiguous history still needs recovery"
        );
        cp.prepare_restore(&history[..2], 2).unwrap();
        assert!(cp.restore(2).failed.is_empty());
        cp.prepare_conversation_rewind(&history[..2], 0).unwrap();
        fs::create_dir(cp.root.join("manifest.tmp")).unwrap();
        assert!(
            cp.confirm_history(&[]).is_err(),
            "failed confirmation save retains the durable guard"
        );
        assert!(cp.lock().pending_conversation_rewind.is_some());
        assert!(!cp.restore(0).failed.is_empty());
        fs::remove_dir(cp.root.join("manifest.tmp")).unwrap();
        cp.confirm_history(&[]).unwrap();
        cp.prepare_restore(&[], 0).unwrap();
        assert!(cp.restore(0).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "kept legacy effect");
        let manifest = cp.lock();
        for archive in &manifest.recovery {
            assert!(cp.root.join(&archive.manifest_file).is_file());
            for hash in &archive.blob_hashes {
                assert!(cp.root.join(BLOBS).join(hash).is_file());
            }
        }
    }

    #[test]
    fn failed_conversation_transcript_write_can_continue_with_old_history_safely() {
        let dir = tempdir().unwrap();
        let cp = store(&dir);
        let history = timeline_history()[..4].to_vec();
        let file = dir.path().join("legacy.txt");
        fs::write(&file, "legacy original").unwrap();
        cp.record_before(14, &file).unwrap();
        fs::write(&file, "legacy effect").unwrap();
        cp.prepare_conversation_rewind(&history, 0).unwrap();
        assert_eq!(cp.lock().recovery[0].ambiguous_before, 0);
        // SQLite failed to save the truncated transcript. Continuing the old
        // transcript archives the pending mismatch and restores a conservative
        // barrier instead of silently trusting the lowered zero barrier.
        cp.prepare_continuation(&history).unwrap();
        assert!(cp.lock().pending_conversation_rewind.is_none());
        assert_eq!(cp.lock().recovery.len(), 2);
        assert_eq!(cp.lock().recovery[1].ambiguous_before, history.len());
        assert!(cp.prepare_restore(&history, 0).is_err());
        assert!(!cp.restore(0).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "legacy effect");
    }

    #[test]
    fn untracked_note_is_published_only_after_manifest_save_succeeds() {
        let dir = tempdir().unwrap();
        let cp = store(&dir);
        fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        assert!(cp.note_untracked_command(1).is_err());
        assert!(cp.checkpoint_ids().is_empty());
        fs::remove_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        cp.note_untracked_command(1).unwrap();
        assert_eq!(cp.lock().checkpoints[&1].untracked_commands, 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_aliases_keep_only_the_first_prior_state() {
        let dir = tempdir().unwrap();
        let cp = store(&dir);
        let file = dir.path().join("Alias.TXT");
        let alias = dir.path().join("alias.txt");
        fs::write(&file, "before").unwrap();
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "middle").unwrap();
        cp.record_before(2, &alias).unwrap();
        fs::write(&file, "after").unwrap();
        assert_eq!(cp.lock().checkpoints[&2].files.len(), 1);
        assert!(cp.restore(2).failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");
    }

    #[test]
    fn open_missing_manifest_starts_empty_and_records_durable_checkpoints() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("cp");
        let cp = CheckpointStore::open(&root).unwrap();
        assert!(cp.checkpoint_ids().is_empty());
        assert!(root.join(BLOBS).is_dir());
        assert!(!root.join(MANIFEST).exists());

        let file = dir.path().join("a.txt");
        fs::write(&file, "original").unwrap();
        cp.record_before(2, &file).unwrap();
        drop(cp);
        assert_eq!(
            CheckpointStore::open(&root).unwrap().checkpoint_ids(),
            vec![2]
        );
    }

    #[test]
    fn open_rejects_corrupt_manifest_without_touching_snapshots_and_can_retry() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("cp");
        let file = dir.path().join("a.txt");
        fs::write(&file, "original").unwrap();
        let cp = CheckpointStore::open(&root).unwrap();
        cp.record_before(2, &file).unwrap();
        drop(cp);
        fs::write(&file, "changed").unwrap();
        let saved_manifest = fs::read(root.join(MANIFEST)).unwrap();
        let blob = fs::read_dir(root.join(BLOBS))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let corrupt_manifest = b"{\"checkpoints\": {\"2\":";
        fs::write(root.join(MANIFEST), corrupt_manifest).unwrap();

        let error = CheckpointStore::open(&root)
            .err()
            .expect("corruption must fail to open");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("manifest"));
        assert_eq!(fs::read(root.join(MANIFEST)).unwrap(), corrupt_manifest);
        assert_eq!(fs::read(&blob).unwrap(), b"original");
        assert_eq!(fs::read(&file).unwrap(), b"changed");

        fs::write(root.join(MANIFEST), saved_manifest).unwrap();
        let reopened = CheckpointStore::open(&root).unwrap();
        assert_eq!(reopened.checkpoint_ids(), vec![2]);
        assert!(reopened.restore(2).failed.is_empty());
        assert_eq!(fs::read(&file).unwrap(), b"original");
    }

    #[test]
    fn open_rejects_invalid_manifest_schema_instead_of_assuming_no_checkpoints() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("cp");
        fs::create_dir_all(&root).unwrap();
        for bytes in [
            b"null".as_slice(),
            b"{}".as_slice(),
            b"{\"checkpoints\": []}".as_slice(),
            b"{\"checkpoints\": {\"2\": {}}}".as_slice(),
            b"{\"checkpoints\": {\"2\": {\"files\": {\"a.txt\": {\"state\": \"unknown\"}}}}}"
                .as_slice(),
        ] {
            fs::write(root.join(MANIFEST), bytes).unwrap();
            let error = CheckpointStore::open(&root)
                .err()
                .expect("invalid schema must fail to open");
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert_eq!(fs::read(root.join(MANIFEST)).unwrap(), bytes);
            assert!(!root.join(BLOBS).exists());
        }
    }

    #[test]
    fn open_returns_existing_manifest_read_errors_and_can_retry() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("cp");
        let file = dir.path().join("a.txt");
        fs::write(&file, "original").unwrap();
        let cp = CheckpointStore::open(&root).unwrap();
        cp.record_before(2, &file).unwrap();
        drop(cp);
        let saved = root.join("manifest.saved");
        fs::rename(root.join(MANIFEST), &saved).unwrap();
        let saved_manifest = fs::read(&saved).unwrap();
        // A directory at the manifest path is an I/O failure on every platform.
        fs::create_dir(root.join(MANIFEST)).unwrap();
        let blob = fs::read_dir(root.join(BLOBS))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();

        let error = CheckpointStore::open(&root)
            .err()
            .expect("read failure must fail to open");
        assert_ne!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(root.join(MANIFEST).is_dir());
        assert!(saved.is_file());
        assert_eq!(fs::read(&saved).unwrap(), saved_manifest);
        assert_eq!(fs::read(&blob).unwrap(), b"original");
        assert_eq!(fs::read(&file).unwrap(), b"original");

        fs::remove_dir(root.join(MANIFEST)).unwrap();
        fs::rename(saved, root.join(MANIFEST)).unwrap();
        assert_eq!(
            CheckpointStore::open(&root).unwrap().checkpoint_ids(),
            vec![2]
        );
    }

    #[test]
    fn write_then_rewind_restores_content() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "one").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "two").unwrap();
        // A second write in the same checkpoint must not overwrite the record.
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "three").unwrap();
        let report = cp.restore(2);
        assert_eq!(fs::read_to_string(&file).unwrap(), "one");
        assert_eq!(report.restored.len(), 1);
        assert!(report.untracked_note.contains("shell"));
        assert!(cp.checkpoint_ids().is_empty());
    }

    #[test]
    fn record_before_failed_manifest_save_does_not_commit_in_memory() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "original").unwrap();
        let cp = store(&dir);
        fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();

        let error = cp.record_before(2, &file).unwrap_err();
        assert!(error.contains("manifest"));
        assert!(cp.checkpoint_ids().is_empty());
        assert!(cp.tracked_paths(2).is_empty());
        // A second write attempt must still fail while persistence is blocked.
        assert!(cp.record_before(2, &file).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"original");
        assert!(!dir.path().join("cp/manifest.json").exists());
    }

    #[test]
    fn record_before_retry_is_durable_and_preserves_other_committed_paths() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        fs::write(&first, "first original").unwrap();
        fs::write(&second, "second original").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &first).unwrap();
        fs::write(&first, "first changed").unwrap();
        let manifest_path = dir.path().join("cp/manifest.json");
        let committed_manifest = fs::read(&manifest_path).unwrap();
        let blocker = dir.path().join("cp/manifest.tmp");
        fs::create_dir(&blocker).unwrap();

        assert!(cp.record_before(2, &second).is_err());
        assert_eq!(fs::read(&manifest_path).unwrap(), committed_manifest);
        fs::remove_dir(blocker).unwrap();
        // The next attempt snapshots the state that its write would replace.
        fs::write(&second, "updated before retry").unwrap();
        cp.record_before(2, &second).unwrap();
        fs::write(&second, "second changed").unwrap();
        drop(cp);

        let reopened = store(&dir);
        let report = reopened.restore(2);
        assert!(report.failed.is_empty());
        assert_eq!(report.restored.len(), 2);
        assert_eq!(fs::read(&first).unwrap(), b"first original");
        assert_eq!(fs::read(&second).unwrap(), b"updated before retry");
        assert!(reopened.checkpoint_ids().is_empty());
    }

    #[test]
    fn new_file_is_deleted_on_rewind() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("sub/new.txt");
        let cp = store(&dir);
        cp.record_before(0, &file).unwrap();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "x").unwrap();
        let report = cp.restore(0);
        assert!(!file.exists());
        assert_eq!(report.deleted.len(), 1);
    }

    #[test]
    fn too_large_file_is_skipped_not_restored() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("big.bin");
        fs::write(&file, vec![7u8; (MAX_CHECKPOINT_FILE_BYTES + 1) as usize]).unwrap();
        let cp = store(&dir);
        cp.record_before(4, &file).unwrap();
        fs::write(&file, "small").unwrap();
        let report = cp.restore(4);
        assert_eq!(report.skipped_too_large.len(), 1);
        assert!(report.restored.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "small");
    }

    #[test]
    fn multiple_turns_restore_earliest_state_at_or_after_index() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("f.txt");
        let other = dir.path().join("g.txt");
        fs::write(&file, "v0").unwrap();
        let cp = store(&dir);
        // Turn at index 2 changes f v0 -> v1.
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "v1").unwrap();
        // Turn at index 6 changes f v1 -> v2 and creates g.
        cp.record_before(6, &file).unwrap();
        cp.record_before(6, &other).unwrap();
        fs::write(&file, "v2").unwrap();
        fs::write(&other, "g").unwrap();

        // Rewinding only the last turn goes back to v1 and removes g.
        let report = cp.restore(6);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v1");
        assert!(!other.exists());
        assert_eq!(report.deleted.len(), 1);
        assert_eq!(cp.checkpoint_ids(), vec![2]);

        // Rewinding further goes back to v0.
        cp.restore(2);
        assert_eq!(fs::read_to_string(&file).unwrap(), "v0");
        assert!(cp.checkpoint_ids().is_empty());
    }

    #[test]
    fn checkpoints_persist_across_reopen_and_count_shell_commands() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("p.txt");
        fs::write(&file, "orig").unwrap();
        {
            let cp = store(&dir);
            cp.record_before(1, &file).unwrap();
            cp.note_untracked_command(1).unwrap();
        }
        fs::write(&file, "changed").unwrap();
        let cp = store(&dir);
        let report = cp.restore(1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "orig");
        assert!(report.untracked_note.contains("1 shell command"));
    }

    #[test]
    fn forget_from_drops_records_without_touching_files() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("z.txt");
        fs::write(&file, "a").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "b").unwrap();
        cp.forget_from(2).unwrap();
        assert!(cp.checkpoint_ids().is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "b");
        assert_eq!(
            fs::read_dir(dir.path().join("cp/blobs")).unwrap().count(),
            0
        );
    }

    #[test]
    fn forget_after_last_checkpoint_succeeds_without_a_manifest_write() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("z.txt");
        fs::write(&file, "a").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();

        cp.forget_from(4).unwrap();

        assert_eq!(cp.checkpoint_ids(), vec![2]);
        assert_eq!(fs::read_to_string(&file).unwrap(), "a");
    }

    #[test]
    fn lower_checkpoints_are_untouched_by_restore() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("k.txt");
        fs::write(&file, "a").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "b").unwrap();
        let report = cp.restore(4);
        assert!(report.restored.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "b");
        assert_eq!(cp.checkpoint_ids(), vec![2]);
    }

    #[test]
    fn failed_restore_keeps_earliest_snapshot_for_retry_after_reopen() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("blocked.txt");
        let other = dir.path().join("restorable.txt");
        fs::write(&file, "original").unwrap();
        fs::write(&other, "other original").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        cp.record_before(2, &other).unwrap();
        fs::write(&file, "intermediate").unwrap();
        cp.record_before(6, &file).unwrap();
        fs::write(&other, "changed").unwrap();
        // A directory replacing the target forces a portable I/O failure.
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();

        let report = cp.restore(2);

        assert_eq!(report.failed.len(), 1);
        assert_eq!(fs::read_to_string(&other).unwrap(), "other original");
        assert_eq!(cp.checkpoint_ids(), vec![2, 6]);
        assert_eq!(
            cp.tracked_paths(2),
            BTreeSet::from([file.to_string_lossy().into_owned()])
        );
        drop(cp);

        fs::remove_dir(&file).unwrap();
        fs::write(&other, "edited after successful restore").unwrap();
        let cp = store(&dir);
        let retried = cp.restore(2);
        assert!(retried.failed.is_empty());
        assert_eq!(retried.restored, vec![file.to_string_lossy().into_owned()]);
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        assert_eq!(
            fs::read_to_string(&other).unwrap(),
            "edited after successful restore"
        );
        assert!(cp.checkpoint_ids().is_empty());
        assert_eq!(
            fs::read_dir(dir.path().join("cp/blobs")).unwrap().count(),
            0
        );
    }

    #[test]
    fn failed_new_file_deletion_keeps_absent_record_for_retry() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("new.txt");
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::create_dir(&file).unwrap();

        let report = cp.restore(2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(cp.checkpoint_ids(), vec![2]);
        drop(cp);

        fs::remove_dir(&file).unwrap();
        fs::write(&file, "new content").unwrap();
        let cp = store(&dir);
        let retried = cp.restore(2);
        assert!(retried.failed.is_empty());
        assert_eq!(retried.deleted, vec![file.to_string_lossy().into_owned()]);
        assert!(!file.exists());
        assert!(cp.checkpoint_ids().is_empty());
    }

    #[test]
    fn failed_manifest_save_during_restore_preserves_durable_snapshots() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "original").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "changed").unwrap();
        // Block the manifest's temporary path without changing the old manifest.
        fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();

        let report = cp.restore(2);

        assert!(report
            .failed
            .iter()
            .any(|failure| failure.contains("manifest")));
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        assert_eq!(cp.checkpoint_ids(), vec![2]);
        assert_eq!(
            fs::read_dir(dir.path().join("cp/blobs")).unwrap().count(),
            1
        );
        drop(cp);

        fs::remove_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        fs::write(&file, "changed again").unwrap();
        let cp = store(&dir);
        let retried = cp.restore(2);
        assert!(retried.failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        assert!(cp.checkpoint_ids().is_empty());
    }

    #[test]
    fn failed_manifest_save_during_forget_preserves_durable_snapshots() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "original").unwrap();
        let cp = store(&dir);
        cp.record_before(2, &file).unwrap();
        fs::write(&file, "changed").unwrap();
        fs::create_dir(dir.path().join("cp/manifest.tmp")).unwrap();

        let error = cp.forget_from(2).unwrap_err();
        assert!(error.contains("manifest"));

        assert_eq!(cp.checkpoint_ids(), vec![2]);
        assert_eq!(
            fs::read_dir(dir.path().join("cp/blobs")).unwrap().count(),
            1
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "changed");
        drop(cp);

        fs::remove_dir(dir.path().join("cp/manifest.tmp")).unwrap();
        let cp = store(&dir);
        let report = cp.restore(2);
        assert!(report.failed.is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
    }
}
