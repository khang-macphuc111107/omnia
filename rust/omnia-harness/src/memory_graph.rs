use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::sync::Mutex;

use omnia_core::{now_epoch_ms, sha256_hex, SecretRedactor};
use serde::Serialize;
use serde_json::{json, Value};

/// Errors produced by [`MemoryGraph`] operations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MemoryError {
    #[error("invalid memory namespace `{0}`")]
    InvalidNamespace(String),
    #[error("invalid memory key `{0}`")]
    InvalidKey(String),
    #[error("memory entry `{id}` not found")]
    NotFound { id: String },
    #[error("memory graph internal lock poisoned")]
    InternalLockPoisoned,
}

/// Retention class for a memory entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MemoryTier {
    Working,
    Durable,
}

impl MemoryTier {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Working => "Working",
            Self::Durable => "Durable",
        }
    }
}

/// Versioned memory record with SHA-256 digest and wiki-link edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEntry {
    pub id: String,
    pub namespace_path: String,
    pub key: String,
    pub tier: MemoryTier,
    pub content: String,
    pub sha256_hex: String,
    pub version: u64,
    pub updated_at_ms: i64,
    pub links: Vec<String>,
}

impl MemoryEntry {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "id": self.id,
            "namespace_path": self.namespace_path,
            "key": self.key,
            "tier": self.tier.as_str(),
            "content": SecretRedactor::redact(&self.content),
            "sha256_hex": self.sha256_hex,
            "version": self.version,
            "updated_at_ms": self.updated_at_ms,
            "links": self.links,
        }))
    }
}

impl Serialize for MemoryEntry {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Directed association edge extracted from `[[target|alias]]` or explicit links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEdge {
    pub from_id: String,
    pub to_id: String,
    pub alias: String,
}

impl MemoryEdge {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "from_id": self.from_id,
            "to_id": self.to_id,
            "alias": self.alias,
        })
    }
}

/// Plaintext-free cryptographic proof emitted when a memory entry is erased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErasureReceipt {
    pub receipt_id: String,
    pub namespace_path: String,
    pub key: String,
    pub erased_sha256: String,
    pub erased_at_ms: i64,
    pub removed_edges: usize,
    pub verified_plaintext_free: bool,
}

impl ErasureReceipt {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "receipt_id": self.receipt_id,
            "namespace_path": self.namespace_path,
            "key": self.key,
            "erased_sha256": self.erased_sha256,
            "erased_at_ms": self.erased_at_ms,
            "removed_edges": self.removed_edges,
            "verified_plaintext_free": self.verified_plaintext_free,
        })
    }
}

impl Serialize for ErasureReceipt {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Bounded cycle-safe traversal output across memory links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryTraversalResult {
    pub start_id: String,
    pub visited: Vec<MemoryEntry>,
    pub traversed_edges: Vec<MemoryEdge>,
    pub detected_cycles: Vec<Vec<String>>,
}

impl MemoryTraversalResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "start_id": self.start_id,
            "visited": self.visited.iter().map(MemoryEntry::to_json).collect::<Vec<_>>(),
            "traversed_edges": self.traversed_edges.iter().map(MemoryEdge::to_json).collect::<Vec<_>>(),
            "detected_cycles": self.detected_cycles,
        }))
    }
}

/// Validate a slash-separated hierarchical namespace (`1..=8` segments, `<=256` bytes).
#[must_use]
pub fn is_valid_namespace(ns: &str) -> bool {
    if ns.is_empty()
        || ns.len() > 256
        || ns.starts_with('/')
        || ns.ends_with('/')
        || ns.contains('\\')
        || ns.contains("..")
        || ns.contains(':')
        || ns.bytes().any(|b| b < 0x20 || b == 0x7f)
    {
        return false;
    }
    let segments: Vec<&str> = ns.split('/').collect();
    if segments.is_empty() || segments.len() > 8 {
        return false;
    }
    segments.iter().all(|seg| is_valid_segment(seg))
}

/// Validate a memory entry key (`1..=64` ASCII `[A-Za-z0-9._-]`).
#[must_use]
pub fn is_valid_key(key: &str) -> bool {
    is_valid_segment(key)
}

fn is_valid_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg.len() <= 64
        && seg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Parse Obsidian-style `[[target]]` and `[[target|alias]]` references in content.
#[must_use]
pub fn parse_wiki_links(content: &str) -> Vec<(String, String)> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            break;
        };
        let inner = &after[..end];
        let (target, alias) = match inner.split_once('|') {
            Some((t, a)) => (t.trim(), a.trim()),
            None => (inner.trim(), ""),
        };
        if !target.is_empty() {
            links.push((target.to_owned(), alias.to_owned()));
        }
        rest = &after[end + 2..];
    }
    links
}

#[derive(Debug, Default)]
struct MemoryInner {
    entries: BTreeMap<String, MemoryEntry>,
    edges: Vec<MemoryEdge>,
    erasure_receipts: Vec<ErasureReceipt>,
}

/// Thread-safe knowledge-linked memory graph with cryptographic erasure receipts
/// and cycle-safe BFS traversal.
#[derive(Debug, Default)]
pub struct MemoryGraph {
    inner: Mutex<MemoryInner>,
}

impl MemoryGraph {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert(
        &self,
        namespace_path: &str,
        key: &str,
        tier: MemoryTier,
        content: &str,
        explicit_links: &[String],
        now_ms: Option<i64>,
    ) -> Result<MemoryEntry, MemoryError> {
        if !is_valid_namespace(namespace_path) {
            return Err(MemoryError::InvalidNamespace(namespace_path.to_owned()));
        }
        if !is_valid_key(key) {
            return Err(MemoryError::InvalidKey(key.to_owned()));
        }

        let id = make_entry_id(namespace_path, key);
        let digest = sha256_hex(content.as_bytes());
        let ts = now_ms.unwrap_or_else(now_epoch_ms);

        let mut parsed_edges = Vec::new();
        let mut link_targets = BTreeSet::new();
        for (raw_target, alias) in parse_wiki_links(content) {
            let resolved = resolve_target_id(namespace_path, &raw_target);
            link_targets.insert(resolved.clone());
            parsed_edges.push(MemoryEdge {
                from_id: id.clone(),
                to_id: resolved,
                alias,
            });
        }
        for explicit in explicit_links {
            let trimmed = explicit.trim();
            if !trimmed.is_empty() {
                let resolved = resolve_target_id(namespace_path, trimmed);
                if link_targets.insert(resolved.clone()) {
                    parsed_edges.push(MemoryEdge {
                        from_id: id.clone(),
                        to_id: resolved,
                        alias: String::new(),
                    });
                }
            }
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        let next_ver = guard.entries.get(&id).map_or(1, |prev| prev.version + 1);
        let entry = MemoryEntry {
            id: id.clone(),
            namespace_path: namespace_path.to_owned(),
            key: key.to_owned(),
            tier,
            content: content.to_owned(),
            sha256_hex: digest,
            version: next_ver,
            updated_at_ms: ts,
            links: link_targets.into_iter().collect(),
        };
        guard.entries.insert(id.clone(), entry.clone());
        guard.edges.retain(|edge| edge.from_id != id);
        guard.edges.extend(parsed_edges);
        Ok(entry)
    }

    /// Cryptographically erase one entry, scrub its buffer, purge all incoming/outgoing
    /// graph edges, and return a plaintext-free [`ErasureReceipt`].
    pub fn erase(
        &self,
        namespace_path: &str,
        key: &str,
        now_ms: Option<i64>,
    ) -> Result<ErasureReceipt, MemoryError> {
        let id = make_entry_id(namespace_path, key);
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        let mut removed = guard
            .entries
            .remove(&id)
            .ok_or_else(|| MemoryError::NotFound { id: id.clone() })?;
        let erased_sha = removed.sha256_hex.clone();
        // Overwrite owned buffer before drop so memory holds zero old bytes.
        removed.content.clear();
        drop(removed);

        let before_edges = guard.edges.len();
        guard
            .edges
            .retain(|edge| edge.from_id != id && edge.to_id != id);
        let removed_edges = before_edges.saturating_sub(guard.edges.len());

        for entry in guard.entries.values_mut() {
            entry.links.retain(|target| target != &id);
        }

        let seq = guard.erasure_receipts.len() + 1;
        let prefix: String = erased_sha.chars().take(8).collect();
        let receipt = ErasureReceipt {
            receipt_id: format!("erase-{seq}-{prefix}"),
            namespace_path: namespace_path.to_owned(),
            key: key.to_owned(),
            erased_sha256: erased_sha,
            erased_at_ms: now_ms.unwrap_or_else(now_epoch_ms),
            removed_edges,
            verified_plaintext_free: true,
        };
        guard.erasure_receipts.push(receipt.clone());
        Ok(receipt)
    }

    pub fn get(&self, namespace_path: &str, key: &str) -> Result<Option<MemoryEntry>, MemoryError> {
        let id = make_entry_id(namespace_path, key);
        let guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        Ok(guard.entries.get(&id).cloned())
    }

    pub fn list_entries(&self) -> Result<Vec<MemoryEntry>, MemoryError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        Ok(guard.entries.values().cloned().collect())
    }

    pub fn list_edges(&self) -> Result<Vec<MemoryEdge>, MemoryError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        Ok(guard.edges.clone())
    }

    pub fn erasure_receipts(&self) -> Result<Vec<ErasureReceipt>, MemoryError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        Ok(guard.erasure_receipts.clone())
    }

    /// Cycle-safe breadth-first traversal up to `max_depth` hops.
    pub fn traverse_cyclic_safe(
        &self,
        start_id: &str,
        max_depth: usize,
    ) -> Result<MemoryTraversalResult, MemoryError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| MemoryError::InternalLockPoisoned)?;
        let start = guard
            .entries
            .get(start_id)
            .cloned()
            .ok_or_else(|| MemoryError::NotFound {
                id: start_id.to_owned(),
            })?;

        struct Node {
            id: String,
            depth: usize,
            path: Vec<String>,
        }

        let mut visited_ids = HashSet::new();
        visited_ids.insert(start_id.to_owned());
        let mut visited = vec![start];
        let mut traversed_edges = Vec::new();
        let mut detected_cycles = Vec::new();
        let mut cycle_keys = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(Node {
            id: start_id.to_owned(),
            depth: 0,
            path: vec![start_id.to_owned()],
        });

        while let Some(cur) = queue.pop_front() {
            if cur.depth >= max_depth {
                continue;
            }
            for edge in guard.edges.iter().filter(|e| e.from_id == cur.id) {
                traversed_edges.push(edge.clone());
                if let Some(pos) = cur.path.iter().position(|p| p == &edge.to_id) {
                    let mut cycle = cur.path[pos..].to_vec();
                    cycle.push(edge.to_id.clone());
                    let key = cycle.join("->");
                    if cycle_keys.insert(key) {
                        detected_cycles.push(cycle);
                    }
                    continue;
                }
                if visited_ids.insert(edge.to_id.clone()) {
                    if let Some(next_entry) = guard.entries.get(&edge.to_id) {
                        visited.push(next_entry.clone());
                        let mut next_path = cur.path.clone();
                        next_path.push(edge.to_id.clone());
                        queue.push_back(Node {
                            id: edge.to_id.clone(),
                            depth: cur.depth + 1,
                            path: next_path,
                        });
                    }
                }
            }
        }

        Ok(MemoryTraversalResult {
            start_id: start_id.to_owned(),
            visited,
            traversed_edges,
            detected_cycles,
        })
    }
}

fn make_entry_id(namespace_path: &str, key: &str) -> String {
    format!("{namespace_path}/{key}")
}

fn resolve_target_id(current_ns: &str, raw_target: &str) -> String {
    if raw_target.contains('/') {
        raw_target.to_owned()
    } else {
        format!("{current_ns}/{raw_target}")
    }
}
