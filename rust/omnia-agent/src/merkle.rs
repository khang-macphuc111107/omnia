//! Frontier `v0.3.0` BLAKE3 SIMD Merkle Tree Incremental Workspace Indexer.
//!
//! Upgrades over `v0.2.0`:
//! - **BLAKE3 SIMD (`blake3 1.8`)** with raw `[u8; 32]` internal digests (5-10x faster than SHA-256).
//! - **True $O(|\Delta| \cdot D_{\text{depth}})$ Dirty-Path Ancestor Propagation:**
//!   - Computes **0 hashes** when clean (`changed_files.is_empty() && removed_files.is_empty()`).
//!   - On single-leaf edits, rehashes ONLY parent directories along the path to root!
//! - **`.gitignore`-Aware Walk (`ignore::WalkBuilder`)** with `hidden(false)`, `git_ignore(true)`,
//!   `follow_links(false)` + ignored-dir safety filter + Win32 reparse-point exclusion.
//! - **Strict Security Invariant:** Evaluates `PermissionsEngine` Deny rules (`.env*`, `*id_rsa*`)
//!   BEFORE reading or hashing a single byte!
//! - **Persistent SQLite WAL Cache (`omni_db::merkle_cache`)** stored strictly in `app_data_dir`
//!   (NEVER writes any cache/db file inside the target user workspace!).

use crate::cache_guard::{blake3_bytes, hex_encode_32};
use anyhow::Result;
use chrono::Utc;
use ignore::WalkBuilder;
use crate::path_guard::sanitize_windows_path;
use crate::permissions::{ApprovalMode, PermissionDecision, PermissionRule, PermissionsEngine};
use crate::agent_store::{AgentStore, CachedMerkleRow};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".omni-tmp",
];

const MAX_HASH_FILE_BYTES: u64 = 4 * 1024 * 1024; // 4 MiB cap per leaf

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MerkleFileEntry {
    pub rel_path: String,
    pub size_bytes: u64,
    pub mtime_secs: i64,
    pub mtime_nanos: u32,
    /// Hex digest (BLAKE3 in v0.3.0; field name kept `sha256` for wire compatibility).
    pub sha256: String,
    #[serde(skip)]
    pub blake3_bytes: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessMerkleStatus {
    pub workspace_path: String,
    pub root_hash: String,
    pub short_hash: String,
    pub file_count: usize,
    pub dir_count: usize,
    pub symbol_count: usize,
    pub changed_files: usize,
    pub refresh_ms: f64,
    pub last_updated_ms: i64,
}

#[derive(Debug, Clone)]
pub struct MerkleRefreshDelta {
    pub root_hash: String,
    pub changed_files: Vec<String>,
    pub removed_files: Vec<String>,
    pub rehashed_dirs: usize,
    pub refresh_ms: f64,
}

#[derive(Clone)]
pub struct MerkleIndex {
    workspace_root: PathBuf,
    workspace_hash: String,
    permission_rules: Vec<PermissionRule>,
    files: BTreeMap<String, MerkleFileEntry>,
    dir_files: BTreeMap<String, BTreeSet<String>>,
    dir_children: BTreeMap<String, BTreeSet<String>>,
    dir_hashes: BTreeMap<String, [u8; 32]>,
    root_hash_bytes: [u8; 32],
    root_hash: String,
    last_refresh_ms: f64,
    last_changed_count: usize,
    last_updated_ms: i64,
    initialized: bool,
    db: Option<AgentStore>,
}

impl MerkleIndex {
    pub fn new(workspace_root: &Path) -> Self {
        Self::with_options(workspace_root, PermissionsEngine::default_rules(), None)
    }

    pub fn with_options(
        workspace_root: &Path,
        permission_rules: Vec<PermissionRule>,
        db: Option<AgentStore>,
    ) -> Self {
        let clean = sanitize_windows_path(workspace_root);
        let ws_hash = hex_encode_32(&blake3_bytes(clean.to_string_lossy().as_bytes()));
        let empty_bytes = blake3_bytes(b"empty");
        let empty_hex = hex_encode_32(&empty_bytes);

        let mut idx = Self {
            workspace_root: clean,
            workspace_hash: ws_hash,
            permission_rules,
            files: BTreeMap::new(),
            dir_files: BTreeMap::new(),
            dir_children: BTreeMap::new(),
            dir_hashes: BTreeMap::new(),
            root_hash_bytes: empty_bytes,
            root_hash: empty_hex,
            last_refresh_ms: 0.0,
            last_changed_count: 0,
            last_updated_ms: 0,
            initialized: false,
            db,
        };
        idx.dir_children.insert(String::new(), BTreeSet::new());
        idx.dir_files.insert(String::new(), BTreeSet::new());
        idx.hydrate_from_db();
        idx
    }

    fn hydrate_from_db(&mut self) {
        let Some(ref db) = self.db else {
            return;
        };
        let Ok(rows) = db.load_merkle_cache(&self.workspace_hash) else {
            return;
        };
        if rows.is_empty() {
            return;
        }
        for row in rows {
            if let Some(b3) = decode_hex_32(&row.blake3_hex) {
                self.insert_tree_membership(&row.rel_path);
                self.files.insert(
                    row.rel_path.clone(),
                    MerkleFileEntry {
                        rel_path: row.rel_path,
                        size_bytes: row.size_bytes,
                        mtime_secs: row.mtime_secs,
                        mtime_nanos: row.mtime_nanos,
                        sha256: row.blake3_hex,
                        blake3_bytes: b3,
                    },
                );
            }
        }
        // Recompute all directory hashes in-memory from cached leaves (0 disk reads!)
        let all_dirs: BTreeSet<String> = self.dir_children.keys().cloned().collect();
        self.rehash_dirty_dirs(&all_dirs);
        self.initialized = true;
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn root_hash(&self) -> &str {
        &self.root_hash
    }

    pub fn root_hash_bytes(&self) -> [u8; 32] {
        self.root_hash_bytes
    }

    pub fn files(&self) -> &BTreeMap<String, MerkleFileEntry> {
        &self.files
    }

    pub fn dir_count(&self) -> usize {
        self.dir_hashes.len()
    }

    pub fn last_refresh_ms(&self) -> f64 {
        self.last_refresh_ms
    }

    /// Incrementally scan the workspace using `.gitignore`-aware `WalkBuilder`, hashing ONLY
    /// changed/new leaves with BLAKE3 SIMD and rehashing ONLY dirty ancestor directories!
    pub fn refresh(&mut self) -> Result<MerkleRefreshDelta> {
        let t0 = Instant::now();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut changed_files: Vec<String> = Vec::new();
        let mut dirty_dirs: BTreeSet<String> = BTreeSet::new();
        let mut db_upserts: Vec<CachedMerkleRow> = Vec::new();

        if self.workspace_root.exists() {
            let root = self.workspace_root.clone();
            let walker = WalkBuilder::new(&root)
                .hidden(false)
                .git_ignore(true)
                .git_global(false)
                .git_exclude(false)
                .parents(false)
                .follow_links(false)
                .filter_entry(|entry| {
                    if entry.depth() == 0 {
                        return true;
                    }
                    // Reject symlinks and Windows NTFS reparse points
                    if entry.path_is_symlink() {
                        return false;
                    }
                    if let Ok(meta) = fs::symlink_metadata(entry.path()) {
                        if is_symlink_or_reparse(&meta) {
                            return false;
                        }
                        if meta.is_dir() {
                            let name = entry.file_name().to_string_lossy();
                            if IGNORED_DIRS.iter().any(|&ig| ig.eq_ignore_ascii_case(&name)) {
                                return false;
                            }
                        }
                    }
                    true
                })
                .build();

            for dent in walker.flatten() {
                if dent.depth() == 0 {
                    continue;
                }
                let abs = dent.path();
                let Ok(meta) = fs::symlink_metadata(abs) else {
                    continue;
                };
                if is_symlink_or_reparse(&meta) || !meta.is_file() {
                    continue;
                }

                // STRICT SECURITY INVARIANT: evaluate PermissionsEngine Deny rules BEFORE reading a single byte!
                let abs_str = abs.to_string_lossy();
                let eval_read = PermissionsEngine::evaluate(
                    &self.permission_rules,
                    true,
                    "read",
                    &abs_str,
                    ApprovalMode::Yolo,
                );
                if eval_read.decision == PermissionDecision::Deny {
                    continue;
                }

                let Ok(rel_raw) = abs.strip_prefix(&root) else {
                    continue;
                };
                let rel_path = rel_raw.to_string_lossy().replace('\\', "/");
                if rel_path.is_empty() {
                    continue;
                }

                let size_bytes = meta.len();
                let (mtime_secs, mtime_nanos) = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| (d.as_secs() as i64, d.subsec_nanos()))
                    .unwrap_or((0, 0));

                seen.insert(rel_path.clone());

                let unchanged = self.files.get(&rel_path).is_some_and(|prev| {
                    prev.size_bytes == size_bytes
                        && prev.mtime_secs == mtime_secs
                        && prev.mtime_nanos == mtime_nanos
                });
                if unchanged {
                    continue;
                }

                let b3_bytes = if size_bytes <= MAX_HASH_FILE_BYTES {
                    match fs::read(abs) {
                        Ok(bytes) => blake3_bytes(&bytes),
                        Err(_) => {
                            blake3_bytes(format!("unreadable:{size_bytes}:{mtime_secs}").as_bytes())
                        }
                    }
                } else {
                    blake3_bytes(
                        format!("large:{size_bytes}:{mtime_secs}:{mtime_nanos}").as_bytes(),
                    )
                };
                let b3_hex = hex_encode_32(&b3_bytes);

                let content_changed = self
                    .files
                    .get(&rel_path)
                    .map(|prev| prev.blake3_bytes != b3_bytes)
                    .unwrap_or(true);

                self.insert_tree_membership(&rel_path);
                self.files.insert(
                    rel_path.clone(),
                    MerkleFileEntry {
                        rel_path: rel_path.clone(),
                        size_bytes,
                        mtime_secs,
                        mtime_nanos,
                        sha256: b3_hex.clone(),
                        blake3_bytes: b3_bytes,
                    },
                );
                db_upserts.push(CachedMerkleRow {
                    rel_path: rel_path.clone(),
                    size_bytes,
                    mtime_secs,
                    mtime_nanos,
                    blake3_hex: b3_hex,
                });

                if content_changed {
                    mark_ancestors_dirty(&rel_path, &mut dirty_dirs);
                    changed_files.push(rel_path);
                }
            }
        }

        let removed_files: Vec<String> = self
            .files
            .keys()
            .filter(|k| !seen.contains(*k))
            .cloned()
            .collect();
        for rem in &removed_files {
            self.files.remove(rem);
            self.remove_tree_membership(rem);
            mark_ancestors_dirty(rem, &mut dirty_dirs);
        }

        // Initial empty workspace bootstrap ensures root hash exists once
        let rehashed_dirs = if !self.initialized {
            self.initialized = true;
            let all_dirs: BTreeSet<String> = self.dir_children.keys().cloned().collect();
            self.rehash_dirty_dirs(&all_dirs)
        } else if !dirty_dirs.is_empty() {
            self.rehash_dirty_dirs(&dirty_dirs)
        } else {
            0
        };

        if let Some(ref db) = self.db {
            if !db_upserts.is_empty() || !removed_files.is_empty() {
                let _ = db.upsert_merkle_cache(&self.workspace_hash, &db_upserts, &removed_files);
            }
        }

        let refresh_ms = ((t0.elapsed().as_secs_f64() * 1000.0) * 100.0).round() / 100.0;
        self.last_refresh_ms = refresh_ms;
        self.last_changed_count = changed_files.len() + removed_files.len();
        self.last_updated_ms = Utc::now().timestamp_millis();

        Ok(MerkleRefreshDelta {
            root_hash: self.root_hash.clone(),
            changed_files,
            removed_files,
            rehashed_dirs,
            refresh_ms,
        })
    }

    pub fn status(&self, symbol_count: usize) -> HarnessMerkleStatus {
        HarnessMerkleStatus {
            workspace_path: self.workspace_root.to_string_lossy().into_owned(),
            short_hash: self.root_hash.chars().take(12).collect(),
            root_hash: self.root_hash.clone(),
            file_count: self.files.len(),
            dir_count: self.dir_hashes.len(),
            symbol_count,
            changed_files: self.last_changed_count,
            refresh_ms: self.last_refresh_ms,
            last_updated_ms: self.last_updated_ms,
        }
    }

    fn insert_tree_membership(&mut self, rel_path: &str) {
        let parent = parent_dir(rel_path);
        self.dir_files
            .entry(parent.clone())
            .or_default()
            .insert(rel_path.to_string());
        self.dir_children.entry(parent.clone()).or_default();

        let mut cur = parent;
        while !cur.is_empty() {
            let p = parent_dir(&cur);
            self.dir_children
                .entry(p.clone())
                .or_default()
                .insert(cur.clone());
            self.dir_files.entry(p.clone()).or_default();
            cur = p;
        }
    }

    fn remove_tree_membership(&mut self, rel_path: &str) {
        let mut cur = parent_dir(rel_path);
        if let Some(files) = self.dir_files.get_mut(&cur) {
            files.remove(rel_path);
        }
        // Prune now-empty non-root directories upward
        while !cur.is_empty() {
            let no_files = self.dir_files.get(&cur).is_none_or(|s| s.is_empty());
            let no_kids = self.dir_children.get(&cur).is_none_or(|s| s.is_empty());
            if no_files && no_kids {
                self.dir_files.remove(&cur);
                self.dir_children.remove(&cur);
                self.dir_hashes.remove(&cur);
                let p = parent_dir(&cur);
                if let Some(kids) = self.dir_children.get_mut(&p) {
                    kids.remove(&cur);
                }
                cur = p;
            } else {
                break;
            }
        }
    }

    /// Rehash ONLY `dirty_dirs` deepest-first in $O(|\Delta| \cdot D_{\text{depth}})$.
    fn rehash_dirty_dirs(&mut self, dirty_dirs: &BTreeSet<String>) -> usize {
        let mut ordered: Vec<String> = dirty_dirs
            .iter()
            .filter(|d| d.is_empty() || self.dir_children.contains_key(*d))
            .cloned()
            .collect();
        ordered.sort_by(|a, b| {
            let da = dir_depth(a);
            let db = dir_depth(b);
            db.cmp(&da).then_with(|| a.cmp(b))
        });

        let mut rehashed = 0usize;
        for dir in ordered {
            let mut hasher = blake3::Hasher::new();
            if let Some(fnames) = self.dir_files.get(&dir) {
                for rel in fnames {
                    if let Some(entry) = self.files.get(rel) {
                        let base = rel.rsplit('/').next().unwrap_or(rel);
                        hasher.update(b"F:");
                        hasher.update(base.as_bytes());
                        hasher.update(b":");
                        hasher.update(&entry.blake3_bytes);
                        hasher.update(b"\n");
                    }
                }
            }
            if let Some(subdirs) = self.dir_children.get(&dir) {
                for sub in subdirs {
                    if let Some(dh) = self.dir_hashes.get(sub) {
                        let base = sub.rsplit('/').next().unwrap_or(sub);
                        hasher.update(b"D:");
                        hasher.update(base.as_bytes());
                        hasher.update(b":");
                        hasher.update(dh);
                        hasher.update(b"\n");
                    }
                }
            }
            let digest = *hasher.finalize().as_bytes();
            self.dir_hashes.insert(dir, digest);
            rehashed += 1;
        }

        if let Some(&root_b) = self.dir_hashes.get("") {
            self.root_hash_bytes = root_b;
            self.root_hash = hex_encode_32(&root_b);
        }
        rehashed
    }
}

fn parent_dir(rel_path: &str) -> String {
    rel_path
        .rsplit_once('/')
        .map(|(d, _)| d.to_string())
        .unwrap_or_default()
}

fn dir_depth(dir: &str) -> usize {
    if dir.is_empty() {
        0
    } else {
        dir.matches('/').count() + 1
    }
}

fn mark_ancestors_dirty(rel_path: &str, dirty: &mut BTreeSet<String>) {
    let mut cur = parent_dir(rel_path);
    loop {
        dirty.insert(cur.clone());
        if cur.is_empty() {
            break;
        }
        cur = parent_dir(&cur);
    }
}

fn decode_hex_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blake3_merkle_dirty_path_rehashes_zero_dirs_when_clean_and_only_ancestors_on_mutation() {
        let tmp = std::env::temp_dir().join(format!("omni_merkle_v3_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("a/deep")).unwrap();
        fs::create_dir_all(tmp.join("b/other")).unwrap();
        fs::create_dir_all(tmp.join(".git")).unwrap();
        fs::write(tmp.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(tmp.join(".env"), "SECRET_KEY=top_secret\n").unwrap();
        fs::write(tmp.join("a/deep/one.py"), "def one():\n    return 1\n").unwrap();
        fs::write(tmp.join("b/other/two.py"), "def two():\n    return 2\n").unwrap();

        let db = AgentStore::open_in_memory().unwrap();
        let mut idx = MerkleIndex::with_options(&tmp, PermissionsEngine::default_rules(), Some(db.clone()));
        let d1 = idx.refresh().unwrap();
        // `.env` and `.git/HEAD` MUST be excluded!
        assert_eq!(idx.files().len(), 2);
        assert!(!idx.files().contains_key(".env"));
        assert_eq!(d1.changed_files.len(), 2);
        let root1 = d1.root_hash.clone();

        // Clean refresh -> 0 changed files, 0 rehashed directories!
        let d2 = idx.refresh().unwrap();
        assert_eq!(d2.changed_files.len(), 0);
        assert_eq!(d2.rehashed_dirs, 0);
        assert_eq!(d2.root_hash, root1);

        // Mutate ONLY `a/deep/one.py` -> rehashes ONLY `a/deep`, `a`, `` (3 dirs, NOT `b` or `b/other`!)
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(tmp.join("a/deep/one.py"), "def one():\n    return 42\n").unwrap();
        let d3 = idx.refresh().unwrap();
        assert_eq!(d3.changed_files, vec!["a/deep/one.py".to_string()]);
        assert_eq!(d3.rehashed_dirs, 3);
        assert_ne!(d3.root_hash, root1);

        // Warm reopen from SQLite WAL cache -> 0 disk reads / 0 changed files!
        let mut idx_warm =
            MerkleIndex::with_options(&tmp, PermissionsEngine::default_rules(), Some(db));
        let d_warm = idx_warm.refresh().unwrap();
        assert_eq!(d_warm.changed_files.len(), 0);
        assert_eq!(d_warm.rehashed_dirs, 0);
        assert_eq!(d_warm.root_hash, d3.root_hash);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn decode_hex_32_rejects_non_ascii_64_byte_utf8_without_panicking() {
        // 32 copies of 2-byte UTF-8 'é' == 64 bytes total, previously panicked on non-char boundary!
        let corrupt = "é".repeat(32);
        assert_eq!(corrupt.len(), 64);
        assert!(decode_hex_32(&corrupt).is_none());
        assert!(decode_hex_32(&"a".repeat(64)).is_some());
    }
}
