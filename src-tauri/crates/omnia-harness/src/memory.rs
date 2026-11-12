//! Hierarchical & graph-linked memory (user and project scope) with working vs
//! durable tiers, freshness/supersession tracking, and secret-free erasure receipts.
//!
//! Each memory is stored as a human-editable markdown file `<slug>.md` inside a
//! hierarchical category namespace (e.g. `memory`, `specs/routing/v2`,
//! `plans/q4-release`) alongside a `MEMORY.md` directory index.
//!
//! Structured graph edges (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`), working-tier
//! TTL metadata, and supersession pointers are persisted in
//! `<scope_root>/memory_graph.json`, while deletions append secret-free
//! cryptographic receipts to `<scope_root>/erasure_receipts.jsonl`.

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::tools::{finish, parse_input};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolRegistry, ToolSpec};

const INDEX_FILE: &str = "MEMORY.md";
const GRAPH_FILE: &str = "memory_graph.json";
const ERASURE_RECEIPTS_FILE: &str = "erasure_receipts.jsonl";
/// Per-scope cap on index text injected into the system prompt.
const INDEX_PROMPT_CAP: usize = 8 * 1024;
const MAX_SLUG_LEN: usize = 64;
const MAX_NAMESPACE_DEPTH: usize = 8;

pub const SUPPORTED_CATEGORIES: &[&str] = &["memory", "specs", "plans", "skills", "artifacts"];

// ---------------------------------------------------------------------------
// Tier, Provenance, Freshness, Graph, Tree, and Erasure Models
// ---------------------------------------------------------------------------

/// Memory durability tier: short-term working state vs long-term durable knowledge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MemoryTier {
    Working,
    #[default]
    Durable,
}

impl MemoryTier {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("durable") | Some("long_term") | Some("long-term") => Ok(Self::Durable),
            Some("working") | Some("short_term") | Some("short-term") => Ok(Self::Working),
            Some(other) => Err(format!(
                "invalid memory tier `{other}`: use `working` or `durable`"
            )),
        }
    }
}

/// Explicit provenance class for graph relationships between memory nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EdgeProvenance {
    /// Directly observed in explicit `[[link]]` syntax or explicit user/tool declaration.
    Extracted,
    /// Derived from high-confidence structural/semantic co-reference.
    Inferred,
    /// Weak or unresolved candidate relationship kept quarantined from strict traversal.
    Ambiguous,
}

impl EdgeProvenance {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_uppercase())
            .as_deref()
        {
            None | Some("EXTRACTED") => Ok(Self::Extracted),
            Some("INFERRED") => Ok(Self::Inferred),
            Some("AMBIGUOUS") => Ok(Self::Ambiguous),
            Some(other) => Err(format!(
                "invalid edge provenance `{other}`: use `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`"
            )),
        }
    }

    pub fn default_confidence_bps(self) -> u16 {
        match self {
            Self::Extracted => 10_000,
            Self::Inferred => 7_000,
            Self::Ambiguous => 4_000,
        }
    }
}

/// Directed typed edge in the general (potentially cyclic) memory graph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryEdge {
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
    pub provenance: EdgeProvenance,
    pub confidence_bps: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub auto_extracted: bool,
}

/// Metadata tracked per memory node in `<scope_root>/memory_graph.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryNodeMeta {
    pub node_id: String,
    pub scope: String,
    pub namespace: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default)]
    pub tier: MemoryTier,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub content_sha256: String,
}

/// Evaluated lifecycle state of a memory node at a given wall-clock timestamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FreshnessState {
    Fresh,
    Stale { age_ms: u64 },
    Expired { expired_at_ms: u64 },
    Superseded { superseded_by: String },
}

impl FreshnessState {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Fresh | Self::Stale { .. })
    }
}

/// Input specification for an explicit edge supplied on `memory_write`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeInput {
    /// Target slug (`api-v1`), namespace path (`specs/routing/api-v1`), or full canonical ID (`project:specs/api-v1`).
    pub to: String,
    #[serde(default = "default_relation")]
    pub relation: String,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub confidence_bps: Option<u16>,
    #[serde(default)]
    pub rationale: Option<String>,
}

fn default_relation() -> String {
    "related_to".to_string()
}

/// Persistent general cyclic graph store for a single scope (`user` or `project`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryGraph {
    #[serde(default = "default_graph_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub nodes: BTreeMap<String, MemoryNodeMeta>,
    #[serde(default)]
    pub edges: Vec<MemoryEdge>,
}

fn default_graph_version() -> u32 {
    1
}

/// Result of a cycle-safe bounded BFS traversal over `MemoryGraph`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubgraphView {
    pub visited_node_ids: Vec<String>,
    pub traversed_edges: Vec<MemoryEdge>,
    pub detected_cycles: Vec<Vec<String>>,
}

impl MemoryGraph {
    pub fn load(scope_root: &Path) -> Self {
        let path = scope_root.join(GRAPH_FILE);
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Self>(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, scope_root: &Path) -> Result<(), String> {
        fs::create_dir_all(scope_root)
            .map_err(|e| format!("cannot create graph root {}: {e}", scope_root.display()))?;
        let path = scope_root.join(GRAPH_FILE);
        let serialized = serde_json::to_string_pretty(self)
            .map_err(|e| format!("cannot serialize memory graph: {e}"))?;
        fs::write(path, format!("{serialized}\n"))
            .map_err(|e| format!("cannot write {GRAPH_FILE}: {e}"))
    }

    /// Inserts or updates a node and reconciles its auto-extracted + explicit edges.
    pub fn upsert_node_and_edges(
        &mut self,
        meta: MemoryNodeMeta,
        extracted_targets: &[String],
        explicit_edges: &[MemoryEdge],
    ) {
        let node_id = meta.node_id.clone();
        let now_ms = meta.updated_at_ms;
        let supersedes_target = meta.supersedes.clone();

        // Preserve any prior `superseded_by` marker if updating an already-superseded node
        // without explicitly clearing it.
        let mut merged_meta = meta;
        if merged_meta.superseded_by.is_none() {
            if let Some(prev) = self.nodes.get(&node_id) {
                merged_meta.created_at_ms = prev.created_at_ms;
                merged_meta.superseded_by = prev.superseded_by.clone();
            }
        }
        self.nodes.insert(node_id.clone(), merged_meta);

        // Remove previous outgoing edges owned by `node_id` so re-writes cleanly sync links.
        self.edges.retain(|edge| edge.from_id != node_id);

        let mut seen = BTreeSet::new();
        for target in extracted_targets {
            let key = (
                node_id.clone(),
                target.clone(),
                "references".to_string(),
                EdgeProvenance::Extracted,
            );
            if seen.insert(key) {
                self.edges.push(MemoryEdge {
                    from_id: node_id.clone(),
                    to_id: target.clone(),
                    relation: "references".to_string(),
                    provenance: EdgeProvenance::Extracted,
                    confidence_bps: EdgeProvenance::Extracted.default_confidence_bps(),
                    rationale: Some("wiki-link [[...]] in markdown body".to_string()),
                    created_at_ms: now_ms,
                    auto_extracted: true,
                });
            }
        }

        if let Some(superseded_id) = supersedes_target {
            if superseded_id != node_id {
                if let Some(old_node) = self.nodes.get_mut(&superseded_id) {
                    old_node.superseded_by = Some(node_id.clone());
                }
                let key = (
                    node_id.clone(),
                    superseded_id.clone(),
                    "supersedes".to_string(),
                    EdgeProvenance::Extracted,
                );
                if seen.insert(key) {
                    self.edges.push(MemoryEdge {
                        from_id: node_id.clone(),
                        to_id: superseded_id,
                        relation: "supersedes".to_string(),
                        provenance: EdgeProvenance::Extracted,
                        confidence_bps: 10_000,
                        rationale: Some("explicit supersession declaration".to_string()),
                        created_at_ms: now_ms,
                        auto_extracted: false,
                    });
                }
            }
        }

        for edge in explicit_edges {
            let key = (
                edge.from_id.clone(),
                edge.to_id.clone(),
                edge.relation.clone(),
                edge.provenance,
            );
            if seen.insert(key) {
                self.edges.push(edge.clone());
            }
        }

        self.edges.sort_by(|a, b| {
            a.from_id
                .cmp(&b.from_id)
                .then_with(|| a.to_id.cmp(&b.to_id))
                .then_with(|| a.relation.cmp(&b.relation))
                .then_with(|| a.provenance.cmp(&b.provenance))
        });
    }

    /// Removes a node and all incident incoming/outgoing edges, returning pruned edge count.
    pub fn remove_node(&mut self, node_id: &str) -> usize {
        self.nodes.remove(node_id);
        for node in self.nodes.values_mut() {
            if node.superseded_by.as_deref() == Some(node_id) {
                node.superseded_by = None;
            }
        }
        let before = self.edges.len();
        self.edges
            .retain(|e| e.from_id != node_id && e.to_id != node_id);
        before.saturating_sub(self.edges.len())
    }

    /// Outgoing edges (`from_id == node_id`), optionally excluding `Ambiguous` edges.
    pub fn outgoing_edges(&self, node_id: &str, include_ambiguous: bool) -> Vec<&MemoryEdge> {
        self.edges
            .iter()
            .filter(|e| {
                e.from_id == node_id
                    && (include_ambiguous || e.provenance != EdgeProvenance::Ambiguous)
            })
            .collect()
    }

    /// Incoming backlink edges (`to_id == node_id`), optionally excluding `Ambiguous` edges.
    pub fn incoming_edges(&self, node_id: &str, include_ambiguous: bool) -> Vec<&MemoryEdge> {
        self.edges
            .iter()
            .filter(|e| {
                e.to_id == node_id
                    && (include_ambiguous || e.provenance != EdgeProvenance::Ambiguous)
            })
            .collect()
    }

    /// Sorted 2-way neighbor IDs (`outgoing ∪ incoming`) incident to `node_id`.
    pub fn bidirectional_neighbors(&self, node_id: &str, include_ambiguous: bool) -> Vec<String> {
        let mut peers = BTreeSet::new();
        for edge in &self.edges {
            if !include_ambiguous && edge.provenance == EdgeProvenance::Ambiguous {
                continue;
            }
            if edge.from_id == node_id {
                peers.insert(edge.to_id.clone());
            } else if edge.to_id == node_id {
                peers.insert(edge.from_id.clone());
            }
        }
        peers.into_iter().collect()
    }

    /// Cycle-safe 2-way (`outgoing ∪ incoming`) BFS neighborhood traversal supporting general cyclic graphs.
    pub fn traverse_subgraph(
        &self,
        seed_ids: &[String],
        max_hops: usize,
        include_ambiguous: bool,
    ) -> SubgraphView {
        let mut visited: HashSet<String> = HashSet::new();
        let mut visited_order: Vec<String> = Vec::new();
        let mut traversed_edges: Vec<MemoryEdge> = Vec::new();
        let mut seen_edge_idx: HashSet<usize> = HashSet::new();
        let mut detected_cycles: Vec<Vec<String>> = Vec::new();
        let mut queue: VecDeque<(String, usize, Vec<String>)> = VecDeque::new();

        for seed in seed_ids {
            if visited.insert(seed.clone()) {
                visited_order.push(seed.clone());
                queue.push_back((seed.clone(), 0, vec![seed.clone()]));
            }
        }

        while let Some((current, depth, path)) = queue.pop_front() {
            if depth >= max_hops {
                continue;
            }
            for (idx, edge) in self.edges.iter().enumerate() {
                if !include_ambiguous && edge.provenance == EdgeProvenance::Ambiguous {
                    continue;
                }
                let neighbor = if edge.from_id == current {
                    Some(&edge.to_id)
                } else if edge.to_id == current {
                    Some(&edge.from_id)
                } else {
                    None
                };
                let Some(next_id) = neighbor else {
                    continue;
                };
                if seen_edge_idx.insert(idx) {
                    traversed_edges.push(edge.clone());
                }
                if edge.from_id == current && path.contains(next_id) {
                    let mut cycle = path.clone();
                    cycle.push(next_id.clone());
                    if !detected_cycles.contains(&cycle) {
                        detected_cycles.push(cycle);
                    }
                    continue;
                }
                if visited.insert(next_id.clone()) {
                    visited_order.push(next_id.clone());
                    let mut next_path = path.clone();
                    next_path.push(next_id.clone());
                    queue.push_back((next_id.clone(), depth + 1, next_path));
                }
            }
        }

        SubgraphView {
            visited_node_ids: visited_order,
            traversed_edges,
            detected_cycles,
        }
    }
}

/// Hierarchical namespace tree node representing a directory and its child namespaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryTreeNode {
    pub segment: String,
    pub namespace: String,
    pub items: Vec<MemoryTreeItem>,
    pub children: Vec<MemoryTreeNode>,
}

/// Summary of an individual memory note inside a hierarchical `MemoryTreeNode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryTreeItem {
    pub node_id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub tier: MemoryTier,
    pub freshness: FreshnessState,
}

/// Secret-free cryptographic erasure receipt proving memory removal without retaining plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErasureReceipt {
    pub receipt_id: String,
    pub scope: String,
    pub namespace: String,
    pub node_id_sha256: String,
    pub content_sha256: String,
    pub erased_bytes: u64,
    pub pruned_edges_count: usize,
    pub index_purged: bool,
    pub file_removed: bool,
    pub erased_at_ms: u64,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Path, Slug, Namespace, and Helper Functions
// ---------------------------------------------------------------------------

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Canonical node identifier `<scope>:<namespace>/<slug>`.
pub fn canonical_node_id(scope: &str, namespace: &str, slug: &str) -> String {
    format!("{scope}:{namespace}/{slug}")
}

/// Resolves a link target (`slug`, `ns/sub/slug`, or `scope:ns/slug`) into a canonical node ID.
pub fn resolve_link_target(
    default_scope: &str,
    default_namespace: &str,
    raw_target: &str,
) -> Result<String, String> {
    let trimmed = raw_target.trim();
    if let Some((scope_part, rest)) = trimmed.split_once(':') {
        if scope_part != "user" && scope_part != "project" {
            return Err(format!("invalid link target scope `{scope_part}`"));
        }
        let (ns, slug) = split_namespace_and_slug(default_namespace, rest)?;
        return Ok(canonical_node_id(scope_part, &ns, &slug));
    }
    let (ns, slug) = split_namespace_and_slug(default_namespace, trimmed)?;
    Ok(canonical_node_id(default_scope, &ns, &slug))
}

fn split_namespace_and_slug(
    default_namespace: &str,
    target: &str,
) -> Result<(String, String), String> {
    if let Some((ns_part, slug_part)) = target.rsplit_once('/') {
        let ns = normalize_category(Some(ns_part))?;
        check_slug(slug_part)?;
        Ok((ns.to_string(), slug_part.to_string()))
    } else {
        check_slug(target)?;
        Ok((default_namespace.to_string(), target.to_string()))
    }
}

/// Extracts `[[slug]]` and `[[category/sub/slug]]` links (supporting `[[target|alias]]`) from markdown.
pub fn extract_wiki_links(scope: &str, namespace: &str, body: &str) -> Vec<String> {
    let re = Regex::new(r"\[\[([^\[\]\n]+)\]\]").expect("valid wiki link regex");
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for caps in re.captures_iter(body) {
        let raw = caps[1].split('|').next().unwrap_or("").trim();
        if raw.is_empty() {
            continue;
        }
        if let Ok(target_id) = resolve_link_target(scope, namespace, raw) {
            if seen.insert(target_id.clone()) {
                out.push(target_id);
            }
        }
    }
    out
}

/// Evaluates freshness, expiry, and supersession for a node at `now_ms`.
pub fn evaluate_freshness(
    meta: &MemoryNodeMeta,
    now_ms: u64,
    stale_after_ms: Option<u64>,
) -> FreshnessState {
    if let Some(by) = &meta.superseded_by {
        return FreshnessState::Superseded {
            superseded_by: by.clone(),
        };
    }
    if let Some(exp) = meta.expires_at_ms {
        if now_ms >= exp {
            return FreshnessState::Expired { expired_at_ms: exp };
        }
    }
    let age_ms = now_ms.saturating_sub(meta.updated_at_ms);
    if let Some(threshold) = stale_after_ms {
        if age_ms >= threshold {
            return FreshnessState::Stale { age_ms };
        }
    }
    FreshnessState::Fresh
}

/// Directory of user-scope memories.
pub fn user_memory_dir(omnia_home: &Path) -> PathBuf {
    omnia_home.join("memory")
}

/// Directory of project-scope memories.
pub fn project_memory_dir(cwd: &Path) -> PathBuf {
    cwd.join(".omnia").join("memory")
}

/// Root directory for a scope (`omnia_home` for `user`, `<cwd>/.omnia` for `project`).
pub fn resolve_scope_root(
    scope: &str,
    cwd: &Path,
    omnia_home: Option<&Path>,
) -> Result<PathBuf, String> {
    match scope {
        "user" => omnia_home
            .map(Path::to_path_buf)
            .ok_or_else(|| "user memory is unavailable (no Omnia home directory)".to_string()),
        "project" => Ok(cwd.join(".omnia")),
        other => Err(format!("invalid scope `{other}`: use `user` or `project`")),
    }
}

fn join_namespace_path(base: &Path, category: &str) -> PathBuf {
    category
        .split('/')
        .filter(|seg| !seg.is_empty())
        .fold(base.to_path_buf(), |acc, seg| acc.join(seg))
}

/// Directory of a specific category (or hierarchical `category/subcategory`) under project-scope `.omnia/`.
pub fn project_category_dir(cwd: &Path, category: &str) -> PathBuf {
    join_namespace_path(&cwd.join(".omnia"), category)
}

/// Registers `memory_read`, `memory_write` and `memory_delete`. The bridge
/// calls this because it owns `omnia_home`.
pub fn register(registry: &mut ToolRegistry, omnia_home: Option<PathBuf>) {
    registry.register(Arc::new(MemoryReadTool {
        omnia_home: omnia_home.clone(),
    }));
    registry.register(Arc::new(MemoryWriteTool {
        omnia_home: omnia_home.clone(),
    }));
    registry.register(Arc::new(MemoryDeleteTool { omnia_home }));
}

/// "# Memory" system-prompt section with active indexes (including nested hierarchical namespaces),
/// or `None` when there are no memories in either scope.
pub fn memory_prompt_section(cwd: &Path, omnia_home: Option<&Path>) -> Option<String> {
    let mut sections = Vec::new();
    let mut seen_dirs = HashSet::new();

    if let Some(home) = omnia_home {
        let user_root_mem = user_memory_dir(home);
        seen_dirs.insert(user_root_mem.clone());
        if let Some(idx) = read_index_for_prompt(&user_root_mem) {
            sections.push(("User memory index".to_string(), idx));
        }
        let mut extra_user = Vec::new();
        collect_nested_indexes(home, home, &seen_dirs, &mut extra_user);
        for (ns, idx) in extra_user {
            sections.push((format!("User {ns} index"), idx));
        }
    }

    let project_root = cwd.join(".omnia");
    for cat in SUPPORTED_CATEGORIES {
        let dir = project_category_dir(cwd, cat);
        seen_dirs.insert(dir.clone());
        if let Some(idx) = read_index_for_prompt(&dir) {
            let label = match *cat {
                "memory" => "Project memory index".to_string(),
                "specs" => "Project specifications index (.omnia/specs)".to_string(),
                "plans" => "Project plans index (.omnia/plans)".to_string(),
                "skills" => "Project skills index (.omnia/skills)".to_string(),
                "artifacts" => "Project artifacts index (.omnia/artifacts)".to_string(),
                other => format!("Project {other} index (.omnia/{other})"),
            };
            sections.push((label, idx));
        }
    }
    let mut extra_project = Vec::new();
    collect_nested_indexes(&project_root, &project_root, &seen_dirs, &mut extra_project);
    for (ns, idx) in extra_project {
        sections.push((format!("Project {ns} index (.omnia/{ns})"), idx));
    }

    if sections.is_empty() {
        return None;
    }
    let mut out = String::from(
        "# Memory\n\nYou have file-based long-term memory in two scopes: `user` (applies to every \
project) and `project` (this workspace only, structured hierarchically under `.omnia/` including \
`memory/`, `specs/`, `plans/`, `skills/` and nested sub-namespaces like `specs/routing`). Below are \
the active indexes. Use `memory_read` (omit `slug` for the index, optional `category`) to load a \
memory, `memory_write` to save durable facts, preferences, specifications, or plans (re-writing \
updates it), and `memory_delete` to remove stale ones. Memories can link to each other with \
`[[slug]]` or `[[category/slug]]`. Do not store secrets or transient task state.\n",
    );
    for (label, index) in sections {
        out.push_str(&format!("\n## {label}\n\n{index}\n"));
    }
    Some(out)
}

fn collect_nested_indexes(
    root: &Path,
    current: &Path,
    seen_dirs: &HashSet<PathBuf>,
    out: &mut Vec<(String, String)>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    subdirs.sort();

    for subdir in subdirs {
        let Some(name) = subdir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !valid_slug(name) {
            continue;
        }
        let rel = subdir
            .strip_prefix(root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let depth = rel.split('/').filter(|s| !s.is_empty()).count();
        if depth > MAX_NAMESPACE_DEPTH {
            continue;
        }
        if !seen_dirs.contains(&subdir) {
            if let Some(idx) = read_index_for_prompt(&subdir) {
                out.push((rel, idx));
            }
        }
        collect_nested_indexes(root, &subdir, seen_dirs, out);
    }
}

fn read_index_for_prompt(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join(INDEX_FILE)).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= INDEX_PROMPT_CAP {
        return Some(text.to_string());
    }
    let mut end = INDEX_PROMPT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    // Prefer cutting at a line boundary so no index entry is half-shown.
    let end = text[..end].rfind('\n').unwrap_or(end);
    Some(format!(
        "{}\n[index truncated: showing {end} of {} bytes; use memory_read to see the rest]",
        &text[..end],
        text.len()
    ))
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= MAX_SLUG_LEN
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn check_slug(slug: &str) -> Result<(), String> {
    if valid_slug(slug) {
        Ok(())
    } else {
        Err(format!(
            "invalid slug `{slug}`: use 1-{MAX_SLUG_LEN} characters from a-z, 0-9 and `-`"
        ))
    }
}

/// Validates and normalizes an optional category or hierarchical namespace path
/// (e.g. `"specs"`, `"specs/routing/v2"`, `"memory/graph"`).
pub fn normalize_category(category: Option<&str>) -> Result<&str, String> {
    match category {
        None | Some("") => Ok("memory"),
        Some(cat) => {
            let cat = cat.trim();
            if cat.is_empty()
                || cat.starts_with('/')
                || cat.ends_with('/')
                || cat.contains('\\')
                || cat.contains("..")
            {
                return Err(format!(
                    "invalid category `{cat}`: use `/`-separated valid slugs (depth 1-{MAX_NAMESPACE_DEPTH})"
                ));
            }
            let segments: Vec<&str> = cat.split('/').collect();
            if segments.len() > MAX_NAMESPACE_DEPTH {
                return Err(format!(
                    "invalid category `{cat}`: namespace depth {} exceeds max {MAX_NAMESPACE_DEPTH}",
                    segments.len()
                ));
            }
            if segments
                .iter()
                .all(|seg| SUPPORTED_CATEGORIES.contains(seg) || valid_slug(seg))
            {
                Ok(cat)
            } else {
                Err(format!(
                    "invalid category `{cat}`: use one of {:?} or `/`-separated slugs (a-z, 0-9, `-`)",
                    SUPPORTED_CATEGORIES
                ))
            }
        }
    }
}

pub fn resolve_category_dir(
    scope: &str,
    category: &str,
    ctx: &ToolContext,
    omnia_home: &Option<PathBuf>,
) -> Result<PathBuf, String> {
    match scope {
        "user" => omnia_home
            .as_deref()
            .map(|h| join_namespace_path(h, category))
            .ok_or_else(|| "user memory is unavailable (no Omnia home directory)".to_string()),
        "project" => Ok(project_category_dir(&ctx.cwd, category)),
        other => Err(format!("invalid scope `{other}`: use `user` or `project`")),
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn index_line(slug: &str, name: &str, description: &str) -> String {
    let name = one_line(name).replace(['[', ']'], "");
    format!("- [{name}]({slug}.md) — {}", one_line(description))
}

/// Replaces (or appends) the index line for `slug`; `None` removes it.
fn update_index(dir: &Path, slug: &str, line: Option<String>) -> Result<(), String> {
    let path = dir.join(INDEX_FILE);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let marker = format!("]({slug}.md)");
    let mut lines: Vec<String> = Vec::new();
    let mut pending = line;
    for current in existing.lines() {
        if current.starts_with("- [") && current.contains(&marker) {
            if let Some(new) = pending.take() {
                lines.push(new);
            }
        } else {
            lines.push(current.to_string());
        }
    }
    if let Some(new) = pending {
        lines.push(new);
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    fs::write(&path, text).map_err(|e| format!("cannot write {INDEX_FILE}: {e}"))
}

/// Frontmatter values are JSON-quoted when they could confuse a YAML reader.
fn yaml_value(s: &str) -> String {
    if s.is_empty() || s.contains([':', '#', '"', '\'']) || s.starts_with(['-', '[', '{']) {
        Value::String(s.to_string()).to_string()
    } else {
        s.to_string()
    }
}

struct RenderMeta<'a> {
    name: &'a str,
    description: &'a str,
    kind: Option<&'a str>,
    tier: MemoryTier,
    expires_at_ms: Option<u64>,
    supersedes: Option<&'a str>,
    body: &'a str,
}

fn render_file(meta: &RenderMeta<'_>) -> String {
    let mut out = format!(
        "---\nname: {}\ndescription: {}\n",
        yaml_value(&one_line(meta.name)),
        yaml_value(&one_line(meta.description))
    );
    if let Some(kind) = meta.kind.map(one_line).filter(|k| !k.is_empty()) {
        out.push_str(&format!("type: {}\n", yaml_value(&kind)));
    }
    if meta.tier == MemoryTier::Working {
        out.push_str("tier: working\n");
    }
    if let Some(exp) = meta.expires_at_ms {
        out.push_str(&format!("expires_at_ms: {exp}\n"));
    }
    if let Some(sup) = meta.supersedes.map(one_line).filter(|s| !s.is_empty()) {
        out.push_str(&format!("supersedes: {}\n", yaml_value(&sup)));
    }
    out.push_str("---\n\n");
    out.push_str(meta.body.trim_end());
    out.push('\n');
    out
}

/// Parsed frontmatter + body of a `<slug>.md` memory document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMemoryDoc {
    pub name: String,
    pub description: String,
    pub kind: Option<String>,
    pub tier: MemoryTier,
    pub expires_at_ms: Option<u64>,
    pub supersedes: Option<String>,
    pub body: String,
}

pub fn parse_memory_markdown(raw: &str, fallback_slug: &str) -> ParsedMemoryDoc {
    let normalized = raw.replace("\r\n", "\n");
    let mut name = fallback_slug.to_string();
    let mut description = String::new();
    let mut kind = None;
    let mut tier = MemoryTier::Durable;
    let mut expires_at_ms = None;
    let mut supersedes = None;
    let mut body = normalized.as_str();

    if let Some(after_open) = normalized.strip_prefix("---\n") {
        if let Some((fm, rest)) = after_open.split_once("\n---\n") {
            body = rest.trim_start_matches('\n');
            for line in fm.lines() {
                let Some((k, v)) = line.split_once(':') else {
                    continue;
                };
                let key = k.trim();
                let val_raw = v.trim();
                let val =
                    serde_json::from_str::<String>(val_raw).unwrap_or_else(|_| val_raw.to_string());
                match key {
                    "name" if !val.is_empty() => name = val,
                    "description" => description = val,
                    "type" if !val.is_empty() => kind = Some(val),
                    "tier" => {
                        if let Ok(parsed) = MemoryTier::parse(Some(&val)) {
                            tier = parsed;
                        }
                    }
                    "expires_at_ms" => {
                        expires_at_ms = val.parse::<u64>().ok();
                    }
                    "supersedes" if !val.is_empty() => supersedes = Some(val),
                    _ => {}
                }
            }
        }
    }

    ParsedMemoryDoc {
        name,
        description,
        kind,
        tier,
        expires_at_ms,
        supersedes,
        body: body.trim().to_string(),
    }
}

// ---------------------------------------------------------------------------
// High-Level Programmatic Operations: Tree Scan, Promotion, Erasure, Search
// ---------------------------------------------------------------------------

/// Builds the hierarchical `MemoryTreeNode` across all namespaces in `scope`.
pub fn scan_memory_tree(
    scope: &str,
    cwd: &Path,
    omnia_home: Option<&Path>,
    now_ms: u64,
) -> Result<MemoryTreeNode, String> {
    let scope_root = resolve_scope_root(scope, cwd, omnia_home)?;
    let graph = MemoryGraph::load(&scope_root);
    let mut root = MemoryTreeNode {
        segment: scope.to_string(),
        namespace: String::new(),
        items: Vec::new(),
        children: Vec::new(),
    };
    if !scope_root.is_dir() {
        return Ok(root);
    }
    populate_tree_node(scope, &scope_root, &scope_root, &graph, now_ms, &mut root);
    Ok(root)
}

fn populate_tree_node(
    scope: &str,
    scope_root: &Path,
    current_dir: &Path,
    graph: &MemoryGraph,
    now_ms: u64,
    node: &mut MemoryTreeNode,
) {
    let Ok(entries) = fs::read_dir(current_dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();

    for path in paths {
        let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if !valid_slug(fname) {
                continue;
            }
            let child_ns = if node.namespace.is_empty() {
                fname.to_string()
            } else {
                format!("{}/{}", node.namespace, fname)
            };
            if child_ns.split('/').count() > MAX_NAMESPACE_DEPTH {
                continue;
            }
            let mut child = MemoryTreeNode {
                segment: fname.to_string(),
                namespace: child_ns,
                items: Vec::new(),
                children: Vec::new(),
            };
            populate_tree_node(scope, scope_root, &path, graph, now_ms, &mut child);
            if !child.items.is_empty() || !child.children.is_empty() {
                node.children.push(child);
            }
        } else if !node.namespace.is_empty() && fname != INDEX_FILE && fname.ends_with(".md") {
            let slug = fname.trim_end_matches(".md");
            if !valid_slug(slug) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let parsed = parse_memory_markdown(&raw, slug);
            let nid = canonical_node_id(scope, &node.namespace, slug);
            let (tier, freshness) = if let Some(meta) = graph.nodes.get(&nid) {
                (meta.tier, evaluate_freshness(meta, now_ms, None))
            } else {
                let synthetic = MemoryNodeMeta {
                    node_id: nid.clone(),
                    scope: scope.to_string(),
                    namespace: node.namespace.clone(),
                    slug: slug.to_string(),
                    name: parsed.name.clone(),
                    description: parsed.description.clone(),
                    kind: parsed.kind.clone(),
                    tier: parsed.tier,
                    created_at_ms: now_ms,
                    updated_at_ms: now_ms,
                    expires_at_ms: parsed.expires_at_ms,
                    supersedes: parsed.supersedes.clone(),
                    superseded_by: None,
                    content_sha256: sha256_hex(raw.as_bytes()),
                };
                (parsed.tier, evaluate_freshness(&synthetic, now_ms, None))
            };
            node.items.push(MemoryTreeItem {
                node_id: nid,
                slug: slug.to_string(),
                name: parsed.name,
                description: parsed.description,
                tier,
                freshness,
            });
        }
    }
}

/// Promotes a short-term `Working` memory note into a long-term `Durable` memory note,
/// clearing any TTL/expiry in both the `.md` frontmatter and `memory_graph.json`.
pub fn promote_working_to_durable(
    scope: &str,
    category: Option<&str>,
    slug: &str,
    cwd: &Path,
    omnia_home: Option<&Path>,
    now_ms: u64,
) -> Result<MemoryNodeMeta, String> {
    check_slug(slug)?;
    let namespace = normalize_category(category)?;
    let scope_root = resolve_scope_root(scope, cwd, omnia_home)?;
    let dir = join_namespace_path(&scope_root, namespace);
    let file = dir.join(format!("{slug}.md"));
    let raw = fs::read_to_string(&file)
        .map_err(|_| format!("{namespace} `{slug}` not found in {scope} scope"))?;
    let parsed = parse_memory_markdown(&raw, slug);

    let rendered = render_file(&RenderMeta {
        name: &parsed.name,
        description: &parsed.description,
        kind: parsed.kind.as_deref(),
        tier: MemoryTier::Durable,
        expires_at_ms: None,
        supersedes: parsed.supersedes.as_deref(),
        body: &parsed.body,
    });
    fs::write(&file, &rendered).map_err(|e| format!("cannot write promoted memory: {e}"))?;
    let line = index_line(slug, &parsed.name, &parsed.description);
    update_index(&dir, slug, Some(line))?;

    let mut graph = MemoryGraph::load(&scope_root);
    let node_id = canonical_node_id(scope, namespace, slug);
    let supersedes_resolved = parsed
        .supersedes
        .as_deref()
        .and_then(|s| resolve_link_target(scope, namespace, s).ok());
    let meta = if let Some(existing) = graph.nodes.get(&node_id).cloned() {
        MemoryNodeMeta {
            tier: MemoryTier::Durable,
            expires_at_ms: None,
            updated_at_ms: now_ms,
            content_sha256: sha256_hex(rendered.as_bytes()),
            ..existing
        }
    } else {
        MemoryNodeMeta {
            node_id: node_id.clone(),
            scope: scope.to_string(),
            namespace: namespace.to_string(),
            slug: slug.to_string(),
            name: parsed.name,
            description: parsed.description,
            kind: parsed.kind,
            tier: MemoryTier::Durable,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            expires_at_ms: None,
            supersedes: supersedes_resolved,
            superseded_by: None,
            content_sha256: sha256_hex(rendered.as_bytes()),
        }
    };
    let extracted = extract_wiki_links(scope, namespace, &parsed.body);
    let preserved_explicit: Vec<MemoryEdge> = graph
        .edges
        .iter()
        .filter(|e| e.from_id == node_id && !e.auto_extracted && e.relation != "supersedes")
        .cloned()
        .collect();
    graph.upsert_node_and_edges(meta.clone(), &extracted, &preserved_explicit);
    graph.save(&scope_root)?;
    Ok(meta)
}

/// Erases a memory file, index line, and graph edges, appending a secret-free `ErasureReceipt`.
pub fn erase_memory_with_receipt(
    scope: &str,
    category: Option<&str>,
    slug: &str,
    cwd: &Path,
    omnia_home: Option<&Path>,
    reason: &str,
    now_ms: u64,
) -> Result<ErasureReceipt, String> {
    check_slug(slug)?;
    let namespace = normalize_category(category)?;
    let scope_root = resolve_scope_root(scope, cwd, omnia_home)?;
    let dir = join_namespace_path(&scope_root, namespace);
    let file = dir.join(format!("{slug}.md"));
    if !file.is_file() {
        return Err(format!("{namespace} `{slug}` not found in {scope} scope"));
    }

    let raw_bytes =
        fs::read(&file).map_err(|e| format!("cannot inspect memory before erase: {e}"))?;
    let erased_bytes = raw_bytes.len() as u64;
    let content_sha256 = sha256_hex(&raw_bytes);
    let node_id = canonical_node_id(scope, namespace, slug);
    let node_id_sha256 = sha256_hex(node_id.as_bytes());

    fs::remove_file(&file).map_err(|e| format!("cannot delete memory: {e}"))?;
    update_index(&dir, slug, None)?;

    let mut graph = MemoryGraph::load(&scope_root);
    let pruned_edges_count = graph.remove_node(&node_id);
    if scope_root.join(GRAPH_FILE).exists() || pruned_edges_count > 0 || !graph.nodes.is_empty() {
        graph.save(&scope_root)?;
    }

    let receipt = ErasureReceipt {
        receipt_id: format!("ers-{}", Uuid::new_v4()),
        scope: scope.to_string(),
        namespace: namespace.to_string(),
        node_id_sha256,
        content_sha256,
        erased_bytes,
        pruned_edges_count,
        index_purged: true,
        file_removed: !file.exists(),
        erased_at_ms: now_ms,
        reason: one_line(reason),
    };
    append_erasure_receipt(&scope_root, &receipt)?;
    Ok(receipt)
}

fn append_erasure_receipt(scope_root: &Path, receipt: &ErasureReceipt) -> Result<(), String> {
    fs::create_dir_all(scope_root)
        .map_err(|e| format!("cannot create receipt dir {}: {e}", scope_root.display()))?;
    let path = scope_root.join(ERASURE_RECEIPTS_FILE);
    let line = serde_json::to_string(receipt)
        .map_err(|e| format!("cannot serialize erasure receipt: {e}"))?;
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("cannot open {ERASURE_RECEIPTS_FILE}: {e}"))?;
    writeln!(handle, "{line}").map_err(|e| format!("cannot write {ERASURE_RECEIPTS_FILE}: {e}"))
}

/// Reads all recorded secret-free `ErasureReceipt` records for `scope`.
pub fn read_erasure_receipts(
    scope: &str,
    cwd: &Path,
    omnia_home: Option<&Path>,
) -> Result<Vec<ErasureReceipt>, String> {
    let scope_root = resolve_scope_root(scope, cwd, omnia_home)?;
    let path = scope_root.join(ERASURE_RECEIPTS_FILE);
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let receipt: ErasureReceipt = serde_json::from_str(line)
            .map_err(|e| format!("invalid erasure receipt JSON line: {e}"))?;
        out.push(receipt);
    }
    Ok(out)
}

/// Full hydrated record of a memory document on disk + graph metadata for retrieval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedMemoryRecord {
    pub node_id: String,
    pub scope: String,
    pub namespace: String,
    pub slug: String,
    pub path: PathBuf,
    pub doc: ParsedMemoryDoc,
    pub freshness: FreshnessState,
}

/// Loads all memory documents across hierarchical namespaces in `scope` (`user` or `project`).
pub fn load_all_memories_in_scope(
    scope: &str,
    cwd: &Path,
    omnia_home: Option<&Path>,
    now_ms: u64,
) -> Result<(Vec<LoadedMemoryRecord>, MemoryGraph), String> {
    let scope_root = resolve_scope_root(scope, cwd, omnia_home)?;
    let graph = MemoryGraph::load(&scope_root);
    let mut records = Vec::new();
    if scope_root.is_dir() {
        collect_loaded_records(
            scope,
            &scope_root,
            &scope_root,
            &graph,
            now_ms,
            &mut records,
        );
    }
    Ok((records, graph))
}

fn collect_loaded_records(
    scope: &str,
    scope_root: &Path,
    current_dir: &Path,
    graph: &MemoryGraph,
    now_ms: u64,
    out: &mut Vec<LoadedMemoryRecord>,
) {
    let Ok(entries) = fs::read_dir(current_dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();

    let rel_ns = current_dir
        .strip_prefix(scope_root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    for path in paths {
        let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if !valid_slug(fname) {
                continue;
            }
            let next_depth = if rel_ns.is_empty() {
                1
            } else {
                rel_ns.split('/').count() + 1
            };
            if next_depth <= MAX_NAMESPACE_DEPTH {
                collect_loaded_records(scope, scope_root, &path, graph, now_ms, out);
            }
        } else if !rel_ns.is_empty() && fname != INDEX_FILE && fname.ends_with(".md") {
            let slug = fname.trim_end_matches(".md");
            if !valid_slug(slug) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let doc = parse_memory_markdown(&raw, slug);
            let node_id = canonical_node_id(scope, &rel_ns, slug);
            let freshness = if let Some(meta) = graph.nodes.get(&node_id) {
                evaluate_freshness(meta, now_ms, None)
            } else {
                let synthetic = MemoryNodeMeta {
                    node_id: node_id.clone(),
                    scope: scope.to_string(),
                    namespace: rel_ns.clone(),
                    slug: slug.to_string(),
                    name: doc.name.clone(),
                    description: doc.description.clone(),
                    kind: doc.kind.clone(),
                    tier: doc.tier,
                    created_at_ms: now_ms,
                    updated_at_ms: now_ms,
                    expires_at_ms: doc.expires_at_ms,
                    supersedes: doc.supersedes.clone(),
                    superseded_by: None,
                    content_sha256: sha256_hex(raw.as_bytes()),
                };
                evaluate_freshness(&synthetic, now_ms, None)
            };
            out.push(LoadedMemoryRecord {
                node_id,
                scope: scope.to_string(),
                namespace: rel_ns.clone(),
                slug: slug.to_string(),
                path,
                doc,
                freshness,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Tool Schemas & Implementations (`memory_read`, `memory_write`, `memory_delete`)
// ---------------------------------------------------------------------------

fn scope_schema() -> Value {
    json!({"type": "string", "enum": ["user", "project"], "description": "`user` = all projects, `project` = this workspace."})
}

fn category_schema() -> Value {
    json!({
        "type": "string",
        "description": "Optional category or hierarchical `/`-separated namespace path (e.g. `memory`, `specs`, `specs/routing/v2`, `plans`, `skills`, `artifacts`). Defaults to `memory`."
    })
}

fn slug_schema() -> Value {
    json!({"type": "string", "description": "Memory id: 1-64 chars of a-z, 0-9, `-`."})
}

#[derive(Deserialize)]
struct ReadArgs {
    scope: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
struct WriteArgs {
    scope: String,
    #[serde(default)]
    category: Option<String>,
    slug: String,
    name: String,
    description: String,
    body: String,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    ttl_ms: Option<u64>,
    #[serde(default)]
    expires_at_ms: Option<u64>,
    #[serde(default)]
    supersedes: Option<String>,
    #[serde(default)]
    edges: Vec<EdgeInput>,
}

#[derive(Deserialize)]
struct DeleteArgs {
    scope: String,
    #[serde(default)]
    category: Option<String>,
    slug: String,
    #[serde(default)]
    reason: Option<String>,
}

pub struct MemoryReadTool {
    pub omnia_home: Option<PathBuf>,
}

#[async_trait]
impl Tool for MemoryReadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_read".into(),
            description:
                "Read a long-term or working memory by slug, or the category/namespace index when `slug` is omitted."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": scope_schema(),
                    "category": category_schema(),
                    "slug": slug_schema()
                },
                "required": ["scope"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Read {} {} {}",
            input["scope"].as_str().unwrap_or("?"),
            input["category"].as_str().unwrap_or("memory"),
            input["slug"].as_str().unwrap_or("index")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: ReadArgs = parse_input(input)?;
            let category = normalize_category(args.category.as_deref())?;
            let dir = resolve_category_dir(&args.scope, category, ctx, &self.omnia_home)?;
            let (file, label) = match &args.slug {
                Some(slug) => {
                    check_slug(slug)?;
                    (
                        dir.join(format!("{slug}.md")),
                        format!("{category} `{slug}`"),
                    )
                }
                None => (dir.join(INDEX_FILE), format!("{category} index")),
            };
            match fs::read_to_string(&file) {
                Ok(text) if text.trim().is_empty() => Ok(ToolOutput::text("(empty)")),
                Ok(text) => Ok(ToolOutput::text(text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && args.slug.is_none() => {
                    Ok(ToolOutput::text(format!("(no {category} yet)")))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!(
                    "{label} not found in {} scope ({category})",
                    args.scope
                )),
                Err(e) => Err(format!("cannot read {label}: {e}")),
            }
        })())
    }
}

pub struct MemoryWriteTool {
    pub omnia_home: Option<PathBuf>,
}

#[async_trait]
impl Tool for MemoryWriteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_write".into(),
            description: "Create or overwrite a hierarchical/graph memory and update its index \
line. Keep `description` to one short line (shown in the index); put details in `body`, which may \
link to other memories with [[slug]] or [[category/slug]]. Supports `working` vs `durable` tiers, \
`supersedes`, and typed graph `edges` with provenance (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": scope_schema(),
                    "category": category_schema(),
                    "slug": slug_schema(),
                    "name": {"type": "string", "description": "Human-readable title."},
                    "description": {"type": "string", "description": "One-line summary for the index."},
                    "body": {"type": "string", "description": "Memory content (markdown)."},
                    "type": {"type": "string", "description": "Optional note kind, e.g. user, feedback, project, reference."},
                    "tier": {"type": "string", "enum": ["working", "durable"], "description": "Memory tier (`durable` default, or `working` for short-term notes)."},
                    "ttl_ms": {"type": "integer", "minimum": 1, "description": "Optional relative TTL in milliseconds (used primarily for `working` tier)."},
                    "expires_at_ms": {"type": "integer", "minimum": 1, "description": "Optional absolute UNIX epoch expiry timestamp in milliseconds."},
                    "supersedes": {"type": "string", "description": "Optional slug or `category/slug` superseded by this memory."},
                    "edges": {
                        "type": "array",
                        "description": "Optional typed graph edges from this memory node.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "to": {"type": "string"},
                                "relation": {"type": "string"},
                                "provenance": {"type": "string", "enum": ["EXTRACTED", "INFERRED", "AMBIGUOUS"]},
                                "confidence_bps": {"type": "integer", "minimum": 0, "maximum": 10000},
                                "rationale": {"type": "string"}
                            },
                            "required": ["to"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["scope", "slug", "name", "description", "body"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Write {} {} {}",
            input["scope"].as_str().unwrap_or("?"),
            input["category"].as_str().unwrap_or("memory"),
            input["slug"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: WriteArgs = parse_input(input)?;
            check_slug(&args.slug)?;
            if one_line(&args.name).is_empty() {
                return Err("`name` must not be empty".into());
            }
            let category = normalize_category(args.category.as_deref())?;
            let tier = MemoryTier::parse(args.tier.as_deref())?;
            let dir = resolve_category_dir(&args.scope, category, ctx, &self.omnia_home)?;
            let scope_root = resolve_scope_root(&args.scope, &ctx.cwd, self.omnia_home.as_deref())?;
            let now_ms = now_epoch_ms();
            let expires_at_ms = args
                .expires_at_ms
                .or_else(|| args.ttl_ms.map(|ttl| now_ms.saturating_add(ttl)));

            let supersedes_resolved = match args.supersedes.as_deref().map(str::trim) {
                Some(s) if !s.is_empty() => Some(resolve_link_target(&args.scope, category, s)?),
                _ => None,
            };

            let node_id = canonical_node_id(&args.scope, category, &args.slug);
            let mut explicit_edges = Vec::with_capacity(args.edges.len());
            for edge_in in &args.edges {
                let target_id = resolve_link_target(&args.scope, category, &edge_in.to)?;
                let provenance = EdgeProvenance::parse(edge_in.provenance.as_deref())?;
                let confidence_bps = edge_in
                    .confidence_bps
                    .unwrap_or_else(|| provenance.default_confidence_bps())
                    .min(10_000);
                let relation = one_line(&edge_in.relation);
                if relation.is_empty() {
                    return Err("edge `relation` must not be empty".into());
                }
                explicit_edges.push(MemoryEdge {
                    from_id: node_id.clone(),
                    to_id: target_id,
                    relation,
                    provenance,
                    confidence_bps,
                    rationale: edge_in.rationale.as_deref().map(one_line),
                    created_at_ms: now_ms,
                    auto_extracted: false,
                });
            }

            fs::create_dir_all(&dir).map_err(|e| format!("cannot create memory dir: {e}"))?;
            let file = dir.join(format!("{}.md", args.slug));
            ctx.checkpoint_before(&file)?;
            ctx.checkpoint_before(&dir.join(INDEX_FILE))?;

            let content = render_file(&RenderMeta {
                name: &args.name,
                description: &args.description,
                kind: args.kind.as_deref(),
                tier,
                expires_at_ms,
                supersedes: args.supersedes.as_deref(),
                body: &args.body,
            });
            fs::write(&file, &content).map_err(|e| format!("cannot write memory: {e}"))?;
            let line = index_line(&args.slug, &args.name, &args.description);
            update_index(&dir, &args.slug, Some(line))?;

            // Persist node & graph metadata (wiki-link EXTRACTED edges + explicit edges + supersession).
            let extracted_targets = extract_wiki_links(&args.scope, category, &args.body);
            let mut graph = MemoryGraph::load(&scope_root);
            let meta = MemoryNodeMeta {
                node_id,
                scope: args.scope.clone(),
                namespace: category.to_string(),
                slug: args.slug.clone(),
                name: one_line(&args.name),
                description: one_line(&args.description),
                kind: args.kind.as_deref().map(one_line).filter(|s| !s.is_empty()),
                tier,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
                expires_at_ms,
                supersedes: supersedes_resolved,
                superseded_by: None,
                content_sha256: sha256_hex(content.as_bytes()),
            };
            graph.upsert_node_and_edges(meta, &extracted_targets, &explicit_edges);
            graph.save(&scope_root)?;

            Ok(ToolOutput::text(format!(
                "Saved {} {} `{}`.",
                args.scope, category, args.slug
            )))
        })())
    }
}

pub struct MemoryDeleteTool {
    pub omnia_home: Option<PathBuf>,
}

#[async_trait]
impl Tool for MemoryDeleteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory_delete".into(),
            description:
                "Delete a memory, purge its index entry and graph edges, and record a secret-free erasure receipt."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "scope": scope_schema(),
                    "category": category_schema(),
                    "slug": slug_schema(),
                    "reason": {"type": "string", "description": "Optional non-sensitive audit reason for erasure."}
                },
                "required": ["scope", "slug"],
                "additionalProperties": false
            }),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Delete {} {} {}",
            input["scope"].as_str().unwrap_or("?"),
            input["category"].as_str().unwrap_or("memory"),
            input["slug"].as_str().unwrap_or("?")
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish((|| {
            let args: DeleteArgs = parse_input(input)?;
            check_slug(&args.slug)?;
            let category = normalize_category(args.category.as_deref())?;
            let dir = resolve_category_dir(&args.scope, category, ctx, &self.omnia_home)?;
            let file = dir.join(format!("{}.md", args.slug));
            if !file.is_file() {
                return Err(format!(
                    "{category} `{}` not found in {} scope",
                    args.slug, args.scope
                ));
            }
            ctx.checkpoint_before(&file)?;
            ctx.checkpoint_before(&dir.join(INDEX_FILE))?;

            let reason = args.reason.as_deref().unwrap_or("tool_memory_delete");
            let _receipt = erase_memory_with_receipt(
                &args.scope,
                Some(category),
                &args.slug,
                &ctx.cwd,
                self.omnia_home.as_deref(),
                reason,
                now_epoch_ms(),
            )?;
            Ok(ToolOutput::text(format!(
                "Deleted {} {} `{}`.",
                args.scope, category, args.slug
            )))
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Setup = (
        tempfile::TempDir,
        tempfile::TempDir,
        ToolRegistry,
        ToolContext,
    );

    fn setup() -> Setup {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let mut registry = ToolRegistry::default();
        register(&mut registry, Some(home.path().to_path_buf()));
        let ctx = ToolContext::new(cwd.path());
        (home, cwd, registry, ctx)
    }

    async fn run(reg: &ToolRegistry, ctx: &ToolContext, tool: &str, input: Value) -> ToolOutput {
        reg.get(tool).unwrap().call(ctx, input).await.unwrap()
    }

    fn write_input(scope: &str, slug: &str, description: &str) -> Value {
        json!({"scope": scope, "slug": slug, "name": "Tabs", "description": description,
               "body": "Uses tabs. See [[style]].", "type": "feedback"})
    }

    fn text(out: &ToolOutput) -> String {
        format!("{:?}", out.content)
    }

    #[tokio::test]
    async fn write_creates_file_and_index_line() {
        let (home, _cwd, reg, ctx) = setup();
        let out = run(
            &reg,
            &ctx,
            "memory_write",
            write_input("user", "tabs", "Prefer tabs"),
        )
        .await;
        assert!(!out.is_error, "{}", text(&out));
        let dir = user_memory_dir(home.path());
        let file = fs::read_to_string(dir.join("tabs.md")).unwrap();
        assert!(file.starts_with("---\nname: Tabs\ndescription: Prefer tabs\ntype: feedback\n---"));
        assert!(file.contains("[[style]]"));
        let index = fs::read_to_string(dir.join("MEMORY.md")).unwrap();
        assert_eq!(index, "- [Tabs](tabs.md) — Prefer tabs\n");
        let read = run(
            &reg,
            &ctx,
            "memory_read",
            json!({"scope": "user", "slug": "tabs"}),
        )
        .await;
        assert!(text(&read).contains("Uses tabs"));
        let idx = run(&reg, &ctx, "memory_read", json!({"scope": "user"})).await;
        assert!(text(&idx).contains("tabs.md"));
    }

    #[tokio::test]
    async fn overwrite_updates_line_without_duplicating() {
        let (home, _cwd, reg, ctx) = setup();
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "tabs", "old"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "other", "x"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "tabs", "new: value"),
        )
        .await;
        let index = fs::read_to_string(project_memory_dir(&ctx.cwd).join("MEMORY.md")).unwrap();
        assert_eq!(index.matches("(tabs.md)").count(), 1);
        assert!(index.contains("new: value"));
        assert!(!index.contains("old"));
        assert!(index.contains("(other.md)"));
        assert!(!home.path().join("memory").exists());
    }

    #[tokio::test]
    async fn delete_removes_file_and_line() {
        let (home, _cwd, reg, ctx) = setup();
        run(&reg, &ctx, "memory_write", write_input("user", "tabs", "d")).await;
        let del = json!({"scope": "user", "slug": "tabs"});
        let out = run(&reg, &ctx, "memory_delete", del.clone()).await;
        assert!(!out.is_error);
        let dir = user_memory_dir(home.path());
        assert!(!dir.join("tabs.md").exists());
        assert!(!fs::read_to_string(dir.join("MEMORY.md"))
            .unwrap()
            .contains("tabs.md"));
        assert!(run(&reg, &ctx, "memory_delete", del).await.is_error);
    }

    #[tokio::test]
    async fn bad_slug_and_scope_rejected() {
        let (_home, cwd, reg, ctx) = setup();
        for slug in ["../evil", "A", "a/b", "", "a.b", &"x".repeat(65)] {
            let out = run(&reg, &ctx, "memory_write", write_input("user", slug, "d")).await;
            assert!(out.is_error, "slug {slug:?} accepted");
            let read = json!({"scope": "project", "slug": slug});
            assert!(run(&reg, &ctx, "memory_read", read).await.is_error);
        }
        let out = run(&reg, &ctx, "memory_write", write_input("global", "ok", "d")).await;
        assert!(out.is_error);
        assert!(!cwd.path().join(".omnia").exists());
    }

    #[tokio::test]
    async fn user_scope_needs_home() {
        let mut reg = ToolRegistry::default();
        register(&mut reg, None);
        let cwd = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(cwd.path());
        assert!(
            run(&reg, &ctx, "memory_write", write_input("user", "a", "d"))
                .await
                .is_error
        );
    }

    #[tokio::test]
    async fn prompt_section_includes_both_scopes() {
        let (home, cwd, reg, ctx) = setup();
        assert!(memory_prompt_section(cwd.path(), Some(home.path())).is_none());
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("user", "u-one", "user fact"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "p-one", "project fact"),
        )
        .await;
        let section = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(section.starts_with("# Memory"));
        assert!(section.contains("user fact") && section.contains("project fact"));
        assert!(section.contains("memory_write"));
        let only_project = memory_prompt_section(cwd.path(), None).unwrap();
        assert!(!only_project.contains("user fact"));
    }

    #[test]
    fn prompt_section_truncates_large_index() {
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let dir = user_memory_dir(home.path());
        fs::create_dir_all(&dir).unwrap();
        let big: String = (0..1000)
            .map(|i| format!("- [m{i}](m{i}.md) — dòng mô tả dài số {i}\n"))
            .collect();
        fs::write(dir.join("MEMORY.md"), big).unwrap();
        let section = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(section.contains("[index truncated"));
        assert!(section.len() < INDEX_PROMPT_CAP + 2048);
        assert!(!section.contains("m999.md"));
    }

    #[tokio::test]
    async fn write_and_read_hierarchical_project_categories() {
        let (_home, cwd, reg, ctx) = setup();
        let spec_input = json!({
            "scope": "project",
            "category": "specs",
            "slug": "arch-spec",
            "name": "Architecture Spec",
            "description": "Core architecture",
            "body": "Hierarchical memory specification."
        });
        let out = run(&reg, &ctx, "memory_write", spec_input).await;
        assert!(!out.is_error, "{}", text(&out));
        let spec_file = cwd.path().join(".omnia").join("specs").join("arch-spec.md");
        assert!(
            spec_file.exists(),
            "spec file must exist under .omnia/specs"
        );
        let spec_idx = cwd.path().join(".omnia").join("specs").join("MEMORY.md");
        assert!(
            spec_idx.exists(),
            "spec index must exist under .omnia/specs"
        );
        assert!(fs::read_to_string(&spec_idx)
            .unwrap()
            .contains("arch-spec.md"));

        let read_out = run(
            &reg,
            &ctx,
            "memory_read",
            json!({
                "scope": "project",
                "category": "specs",
                "slug": "arch-spec"
            }),
        )
        .await;
        assert!(!read_out.is_error);
        assert!(text(&read_out).contains("Hierarchical memory specification"));

        let del_out = run(
            &reg,
            &ctx,
            "memory_delete",
            json!({
                "scope": "project",
                "category": "specs",
                "slug": "arch-spec"
            }),
        )
        .await;
        assert!(!del_out.is_error);
        assert!(!spec_file.exists());
        assert!(!fs::read_to_string(&spec_idx)
            .unwrap()
            .contains("arch-spec.md"));
    }

    #[tokio::test]
    async fn prompt_section_includes_hierarchical_categories() {
        let (home, cwd, reg, ctx) = setup();
        run(
            &reg,
            &ctx,
            "memory_write",
            write_input("project", "p-core", "core fact"),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "specs",
                "slug": "api-v1",
                "name": "API Spec",
                "description": "API design",
                "body": "Endpoints list."
            }),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "plans",
                "slug": "milestone-1",
                "name": "Milestone 1",
                "description": "Q1 release",
                "body": "Tasks list."
            }),
        )
        .await;

        let section = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(section.contains("Project memory index"));
        assert!(section.contains("Project specifications index (.omnia/specs)"));
        assert!(section.contains("Project plans index (.omnia/plans)"));
        assert!(section.contains("API design"));
        assert!(section.contains("Q1 release"));
    }

    #[tokio::test]
    async fn multi_segment_hierarchical_tree_and_traversal_rejections() {
        let (home, cwd, reg, ctx) = setup();
        for bad_cat in [
            "/leading",
            "trailing/",
            "specs//double",
            "specs/../escape",
            "specs\\backslash",
            "Specs/Upper",
            "a/b/c/d/e/f/g/h/i",
        ] {
            let out = run(
                &reg,
                &ctx,
                "memory_write",
                json!({
                    "scope": "project",
                    "category": bad_cat,
                    "slug": "note",
                    "name": "Bad",
                    "description": "Bad category",
                    "body": "Should fail."
                }),
            )
            .await;
            assert!(out.is_error, "bad category {bad_cat:?} must fail");
        }

        let out = run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "specs/routing/v2",
                "slug": "circuit-breaker",
                "name": "Circuit Breaker Spec",
                "description": "Half-open recovery contract",
                "body": "Links to [[specs/routing/v2/quota-reserve|quota]]."
            }),
        )
        .await;
        assert!(!out.is_error, "{}", text(&out));

        let nested_file = cwd
            .path()
            .join(".omnia/specs/routing/v2/circuit-breaker.md");
        assert!(nested_file.is_file());

        let prompt = memory_prompt_section(cwd.path(), Some(home.path())).unwrap();
        assert!(prompt.contains("Project specs/routing/v2 index (.omnia/specs/routing/v2)"));
        assert!(prompt.contains("Half-open recovery contract"));

        let tree =
            scan_memory_tree("project", cwd.path(), Some(home.path()), now_epoch_ms()).unwrap();
        let specs = tree.children.iter().find(|c| c.segment == "specs").unwrap();
        let routing = specs
            .children
            .iter()
            .find(|c| c.segment == "routing")
            .unwrap();
        let v2 = routing.children.iter().find(|c| c.segment == "v2").unwrap();
        assert_eq!(v2.namespace, "specs/routing/v2");
        assert_eq!(v2.items.len(), 1);
        assert_eq!(v2.items[0].slug, "circuit-breaker");
    }

    #[tokio::test]
    async fn cyclic_graph_edges_and_provenance_filtering() {
        let (_home, cwd, reg, ctx) = setup();
        // Create A -> B (EXTRACTED via wiki link), B -> C (INFERRED), C -> A (EXTRACTED cycle), and B -> D (AMBIGUOUS).
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "specs/graph",
                "slug": "node-a",
                "name": "Node A",
                "description": "Entry node",
                "body": "Depends on [[node-b]]."
            }),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "specs/graph",
                "slug": "node-b",
                "name": "Node B",
                "description": "Middle node",
                "body": "Core implementation.",
                "edges": [
                    {"to": "node-c", "relation": "depends_on", "provenance": "INFERRED", "rationale": "co-edited module"},
                    {"to": "node-d", "relation": "related_to", "provenance": "AMBIGUOUS", "rationale": "weak lexical overlap"}
                ]
            }),
        )
        .await;
        run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "specs/graph",
                "slug": "node-c",
                "name": "Node C",
                "description": "Cycle closing node",
                "body": "Feeds back into [[node-a]]."
            }),
        )
        .await;

        let graph = MemoryGraph::load(&cwd.path().join(".omnia"));
        let strict = graph.traverse_subgraph(&["project:specs/graph/node-a".to_string()], 5, false);
        assert!(strict
            .visited_node_ids
            .contains(&"project:specs/graph/node-a".to_string()));
        assert!(strict
            .visited_node_ids
            .contains(&"project:specs/graph/node-b".to_string()));
        assert!(strict
            .visited_node_ids
            .contains(&"project:specs/graph/node-c".to_string()));
        assert!(
            !strict
                .visited_node_ids
                .contains(&"project:specs/graph/node-d".to_string()),
            "AMBIGUOUS edge must be quarantined when include_ambiguous = false"
        );
        assert!(
            !strict.detected_cycles.is_empty(),
            "cycle A -> B -> C -> A must be detected without infinite recursion"
        );

        let permissive =
            graph.traverse_subgraph(&["project:specs/graph/node-a".to_string()], 5, true);
        assert!(permissive
            .visited_node_ids
            .contains(&"project:specs/graph/node-d".to_string()));
    }

    #[tokio::test]
    async fn working_tier_expiry_promotion_supersession_and_erasure_receipt() {
        let (_home, cwd, reg, ctx) = setup();
        let base_ms = 1_700_000_000_000_u64;

        // 1. Write short-term working memory with explicit expiry.
        let out = run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "memory/session",
                "slug": "temp-hypothesis",
                "name": "Temporary Hypothesis",
                "description": "Sensitive debug note",
                "body": "Hypothesis body secret-token-placeholder.",
                "tier": "working",
                "expires_at_ms": base_ms + 5_000
            }),
        )
        .await;
        assert!(!out.is_error);

        let graph = MemoryGraph::load(&cwd.path().join(".omnia"));
        let working_meta = graph
            .nodes
            .get("project:memory/session/temp-hypothesis")
            .unwrap();
        assert_eq!(working_meta.tier, MemoryTier::Working);
        assert_eq!(
            evaluate_freshness(working_meta, base_ms + 1_000, None),
            FreshnessState::Fresh
        );
        assert_eq!(
            evaluate_freshness(working_meta, base_ms + 6_000, None),
            FreshnessState::Expired {
                expired_at_ms: base_ms + 5_000
            }
        );

        // 2. Promote working memory to durable long-term memory.
        let promoted = promote_working_to_durable(
            "project",
            Some("memory/session"),
            "temp-hypothesis",
            cwd.path(),
            None,
            base_ms + 7_000,
        )
        .unwrap();
        assert_eq!(promoted.tier, MemoryTier::Durable);
        assert_eq!(promoted.expires_at_ms, None);
        assert_eq!(
            evaluate_freshness(&promoted, base_ms + 999_999, None),
            FreshnessState::Fresh
        );

        // 3. Supersede `temp-hypothesis` with `validated-architecture`.
        let sup_out = run(
            &reg,
            &ctx,
            "memory_write",
            json!({
                "scope": "project",
                "category": "memory/session",
                "slug": "validated-architecture",
                "name": "Validated Architecture",
                "description": "Confirmed root cause",
                "body": "Replaces old hypothesis.",
                "supersedes": "temp-hypothesis"
            }),
        )
        .await;
        assert!(!sup_out.is_error);
        let graph_after_sup = MemoryGraph::load(&cwd.path().join(".omnia"));
        let old_meta = graph_after_sup
            .nodes
            .get("project:memory/session/temp-hypothesis")
            .unwrap();
        assert_eq!(
            evaluate_freshness(old_meta, base_ms + 10_000, None),
            FreshnessState::Superseded {
                superseded_by: "project:memory/session/validated-architecture".to_string()
            }
        );

        // 4. Delete `temp-hypothesis` and verify secret-free erasure receipt + graph edge pruning.
        let del_out = run(
            &reg,
            &ctx,
            "memory_delete",
            json!({
                "scope": "project",
                "category": "memory/session",
                "slug": "temp-hypothesis",
                "reason": "user_requested_erasure"
            }),
        )
        .await;
        assert!(!del_out.is_error);

        let receipts = read_erasure_receipts("project", cwd.path(), None).unwrap();
        assert_eq!(receipts.len(), 1);
        assert!(receipts[0].file_removed);
        assert!(receipts[0].index_purged);
        assert_eq!(receipts[0].pruned_edges_count, 1);
        assert_eq!(receipts[0].reason, "user_requested_erasure");

        let raw_receipts =
            fs::read_to_string(cwd.path().join(".omnia").join(ERASURE_RECEIPTS_FILE)).unwrap();
        assert!(
            !raw_receipts.contains("secret-token-placeholder")
                && !raw_receipts.contains("Temporary Hypothesis")
                && !raw_receipts.contains("temp-hypothesis"),
            "erasure receipt must be strictly secret-free and plaintext-free"
        );
    }
}
