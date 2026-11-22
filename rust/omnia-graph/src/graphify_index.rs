use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omnia_core::SecretRedactor;
use serde::Serialize;
use serde_json::{json, Value};

use crate::peer_mesh::AgentGraphError;

const MAX_INDEXED_FILE_BYTES: u64 = 1024 * 1024;
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "target",
    "build",
    "roaming",
    "node_modules",
    "__pycache__",
    ".vs",
];

/// Origin confidence class of a Graphify knowledge relationship.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum GraphifyProvenance {
    Extracted,
    Inferred,
    Ambiguous,
}

impl GraphifyProvenance {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Extracted => "EXTRACTED",
            Self::Inferred => "INFERRED",
            Self::Ambiguous => "AMBIGUOUS",
        }
    }

    #[must_use]
    pub const fn default_confidence_bps(self) -> u32 {
        match self {
            Self::Extracted => 10_000,
            Self::Inferred => 7_500,
            Self::Ambiguous => 3_500,
        }
    }
}

/// Traversal direction for Graphify BFS exploration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TraversalDirection {
    Forward,
    Reverse,
    Both,
}

impl TraversalDirection {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Forward => "Forward",
            Self::Reverse => "Reverse",
            Self::Both => "Both",
        }
    }
}

/// Classification of an indexed entity node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum GraphifyEntityKind {
    Agent,
    CodeModule,
    Symbol,
    Skill,
    MemoryNote,
    Artifact,
    Requirement,
}

impl GraphifyEntityKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::CodeModule => "CodeModule",
            Self::Symbol => "Symbol",
            Self::Skill => "Skill",
            Self::MemoryNote => "MemoryNote",
            Self::Artifact => "Artifact",
            Self::Requirement => "Requirement",
        }
    }
}

/// Indexed entity stored inside [`GraphifyIndex`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphifyEntity {
    pub id: String,
    pub kind: GraphifyEntityKind,
    pub label: String,
    pub source_path: String,
    pub symbol_span: Option<String>,
}

impl GraphifyEntity {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind.as_str(),
            "label": self.label,
            "source_path": self.source_path,
            "symbol_span": self.symbol_span,
        })
    }
}

/// Provenance-annotated directed relationship in [`GraphifyIndex`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphifyEdge {
    pub from_id: String,
    pub to_id: String,
    pub relation: String,
    pub provenance: GraphifyProvenance,
    pub confidence_bps: u32,
    pub source_locator: String,
}

impl GraphifyEdge {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "from_id": self.from_id,
            "to_id": self.to_id,
            "relation": self.relation,
            "provenance": self.provenance.as_str(),
            "confidence_bps": self.confidence_bps,
            "source_locator": self.source_locator,
        })
    }
}

/// Output from [`GraphifyIndex::traverse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphifyTraversalResult {
    pub start_id: String,
    pub direction: TraversalDirection,
    pub max_depth: usize,
    pub visited_entities: Vec<GraphifyEntity>,
    pub traversed_edges: Vec<GraphifyEdge>,
    pub quarantined_ambiguous: Vec<GraphifyEdge>,
    pub detected_cycles: Vec<Vec<String>>,
}

impl GraphifyTraversalResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        SecretRedactor::redact_json(&json!({
            "start_id": self.start_id,
            "direction": self.direction.as_str(),
            "max_depth": self.max_depth,
            "visited_entities": self.visited_entities.iter().map(GraphifyEntity::to_json).collect::<Vec<_>>(),
            "traversed_edges": self.traversed_edges.iter().map(GraphifyEdge::to_json).collect::<Vec<_>>(),
            "quarantined_ambiguous": self.quarantined_ambiguous.iter().map(GraphifyEdge::to_json).collect::<Vec<_>>(),
            "detected_cycles": self.detected_cycles,
        }))
    }
}

impl Serialize for GraphifyTraversalResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// Summary report produced by [`GraphifyIndex::index_workspace`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkspaceIndexReport {
    pub files_indexed: usize,
    pub entities_added: usize,
    pub edges_added: usize,
    pub skipped_excluded_dirs: usize,
    pub skipped_reparse_points: usize,
    pub indexed_crates: Vec<String>,
}

impl WorkspaceIndexReport {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "files_indexed": self.files_indexed,
            "entities_added": self.entities_added,
            "edges_added": self.edges_added,
            "skipped_excluded_dirs": self.skipped_excluded_dirs,
            "skipped_reparse_points": self.skipped_reparse_points,
            "indexed_crates": self.indexed_crates,
        })
    }
}

#[derive(Debug, Default)]
struct GraphifyInner {
    entities: BTreeMap<String, GraphifyEntity>,
    edges: Vec<GraphifyEdge>,
    edge_keys: HashSet<(String, String, String, String)>,
    outgoing: BTreeMap<String, Vec<usize>>,
    incoming: BTreeMap<String, Vec<usize>>,
}

impl GraphifyInner {
    fn upsert_entity(&mut self, entity: GraphifyEntity) -> bool {
        let existed = self.entities.contains_key(&entity.id);
        self.entities.insert(entity.id.clone(), entity);
        !existed
    }

    fn add_edge(&mut self, edge: GraphifyEdge) -> Result<bool, AgentGraphError> {
        if !self.entities.contains_key(&edge.from_id) {
            return Err(AgentGraphError::UnknownEntity(edge.from_id));
        }
        if !self.entities.contains_key(&edge.to_id) {
            return Err(AgentGraphError::UnknownEntity(edge.to_id));
        }
        let dedup = (
            edge.from_id.clone(),
            edge.to_id.clone(),
            edge.relation.clone(),
            edge.provenance.as_str().to_owned(),
        );
        if !self.edge_keys.insert(dedup) {
            return Ok(false);
        }
        let idx = self.edges.len();
        self.outgoing
            .entry(edge.from_id.clone())
            .or_default()
            .push(idx);
        self.incoming
            .entry(edge.to_id.clone())
            .or_default()
            .push(idx);
        self.edges.push(edge);
        Ok(true)
    }
}

/// Bidirectional provenance-tracked code, documentation, skill, and agent knowledge index.
#[derive(Debug, Default)]
pub struct GraphifyIndex {
    inner: Mutex<GraphifyInner>,
}

impl GraphifyIndex {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_entity(&self, entity: GraphifyEntity) -> Result<(), AgentGraphError> {
        if entity.id.trim().is_empty() {
            return Err(AgentGraphError::InvalidEntityId(entity.id));
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        guard.upsert_entity(entity);
        Ok(())
    }

    pub fn add_edge(&self, mut edge: GraphifyEdge) -> Result<(), AgentGraphError> {
        if edge.confidence_bps == 0 {
            edge.confidence_bps = edge.provenance.default_confidence_bps();
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        let _ = guard.add_edge(edge)?;
        Ok(())
    }

    pub fn entity(&self, id: &str) -> Result<Option<GraphifyEntity>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard.entities.get(id).cloned())
    }

    pub fn entities(&self) -> Result<Vec<GraphifyEntity>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard.entities.values().cloned().collect())
    }

    pub fn edges(&self) -> Result<Vec<GraphifyEdge>, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        Ok(guard.edges.clone())
    }

    /// Breadth-first forward/reverse/bidirectional traversal with ambiguity quarantine
    /// and deterministic cycle detection.
    pub fn traverse(
        &self,
        start_id: &str,
        direction: TraversalDirection,
        max_depth: usize,
        include_ambiguous: bool,
    ) -> Result<GraphifyTraversalResult, AgentGraphError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        let start_entity = guard
            .entities
            .get(start_id)
            .cloned()
            .ok_or_else(|| AgentGraphError::UnknownEntity(start_id.to_owned()))?;

        #[derive(Clone)]
        struct QueueNode {
            id: String,
            depth: usize,
            path: Vec<String>,
        }

        let mut visited_ids = BTreeSet::new();
        visited_ids.insert(start_id.to_owned());
        let mut visited_entities = vec![start_entity];
        let mut seen_traversed = HashSet::new();
        let mut seen_quarantined = HashSet::new();
        let mut traversed_edges = Vec::new();
        let mut quarantined_ambiguous = Vec::new();
        let mut detected_cycles = Vec::new();
        let mut cycle_keys = HashSet::new();

        let mut queue = VecDeque::new();
        queue.push_back(QueueNode {
            id: start_id.to_owned(),
            depth: 0,
            path: vec![start_id.to_owned()],
        });

        while let Some(cur) = queue.pop_front() {
            if cur.depth >= max_depth {
                continue;
            }
            let mut candidate_indices = Vec::new();
            if matches!(
                direction,
                TraversalDirection::Forward | TraversalDirection::Both
            ) {
                if let Some(list) = guard.outgoing.get(&cur.id) {
                    for &idx in list {
                        candidate_indices.push((idx, true));
                    }
                }
            }
            if matches!(
                direction,
                TraversalDirection::Reverse | TraversalDirection::Both
            ) {
                if let Some(list) = guard.incoming.get(&cur.id) {
                    for &idx in list {
                        candidate_indices.push((idx, false));
                    }
                }
            }

            for (edge_idx, is_forward) in candidate_indices {
                let edge = &guard.edges[edge_idx];
                if edge.provenance == GraphifyProvenance::Ambiguous && !include_ambiguous {
                    if seen_quarantined.insert(edge_idx) {
                        quarantined_ambiguous.push(edge.clone());
                    }
                    continue;
                }
                if seen_traversed.insert(edge_idx) {
                    traversed_edges.push(edge.clone());
                }
                let next_id = if is_forward {
                    edge.to_id.clone()
                } else {
                    edge.from_id.clone()
                };

                if let Some(pos) = cur.path.iter().position(|p| p == &next_id) {
                    let mut cycle_path = cur.path[pos..].to_vec();
                    cycle_path.push(next_id.clone());
                    let key = cycle_path.join("->");
                    if cycle_keys.insert(key) {
                        detected_cycles.push(cycle_path);
                    }
                    continue;
                }

                if visited_ids.insert(next_id.clone()) {
                    if let Some(entity) = guard.entities.get(&next_id) {
                        visited_entities.push(entity.clone());
                    }
                    let mut next_path = cur.path.clone();
                    next_path.push(next_id.clone());
                    queue.push_back(QueueNode {
                        id: next_id,
                        depth: cur.depth + 1,
                        path: next_path,
                    });
                }
            }
        }

        Ok(GraphifyTraversalResult {
            start_id: start_id.to_owned(),
            direction,
            max_depth,
            visited_entities,
            traversed_edges,
            quarantined_ambiguous,
            detected_cycles,
        })
    }

    /// Deterministically index an Omnia repository checkout without traversing
    /// `.git`, `target`, `build`, `Roaming`, or any symlink / NTFS reparse point.
    ///
    /// Scans `<root>/Cargo.toml`, `rust/*/Cargo.toml`, `rust/*/src/*.rs` (plus
    /// nested modules under `src/`), `ui/app/*.js`, and `docs/**/*.md`.
    pub fn index_workspace(
        &self,
        workspace_root: &Path,
    ) -> Result<WorkspaceIndexReport, AgentGraphError> {
        let root_meta = fs::symlink_metadata(workspace_root)
            .map_err(|e| AgentGraphError::IoError(format!("{}: {e}", workspace_root.display())))?;
        if is_symlink_or_reparse(&root_meta) {
            return Err(AgentGraphError::IoError(
                "workspace root must not be a symlink or reparse point".to_owned(),
            ));
        }
        let canonical_root = fs::canonicalize(workspace_root)
            .map_err(|e| AgentGraphError::IoError(format!("{}: {e}", workspace_root.display())))?;

        let mut report = WorkspaceIndexReport::default();
        let mut pending_entities: Vec<GraphifyEntity> = Vec::new();
        let mut pending_edges: Vec<GraphifyEdge> = Vec::new();

        // 1. Root Cargo.toml
        let root_cargo = workspace_root.join("Cargo.toml");
        if is_safe_regular_file(&canonical_root, &root_cargo, &mut report) {
            if let Ok(text) = read_bounded_utf8(&root_cargo) {
                report.files_indexed += 1;
                pending_entities.push(GraphifyEntity {
                    id: "file:Cargo.toml".to_owned(),
                    kind: GraphifyEntityKind::Artifact,
                    label: "Workspace Cargo.toml".to_owned(),
                    source_path: "Cargo.toml".to_owned(),
                    symbol_span: None,
                });
                for member in parse_cargo_members(&text) {
                    let member_id = format!("file:{member}/Cargo.toml");
                    pending_entities.push(GraphifyEntity {
                        id: member_id.clone(),
                        kind: GraphifyEntityKind::Artifact,
                        label: format!("{member} manifest"),
                        source_path: format!("{member}/Cargo.toml"),
                        symbol_span: None,
                    });
                    pending_edges.push(GraphifyEdge {
                        from_id: "file:Cargo.toml".to_owned(),
                        to_id: member_id,
                        relation: "workspace_member".to_owned(),
                        provenance: GraphifyProvenance::Extracted,
                        confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                        source_locator: "Cargo.toml".to_owned(),
                    });
                }
            }
        }

        // 2. rust/*/Cargo.toml & rust/*/src/**/*.rs
        let rust_dir = workspace_root.join("rust");
        if is_safe_dir(&canonical_root, &rust_dir, &mut report) {
            let crate_dirs = sorted_dir_entries(&rust_dir)?;
            for entry_path in crate_dirs {
                let dir_name = file_name_lossy(&entry_path);
                if is_excluded_dir_name(&dir_name) {
                    report.skipped_excluded_dirs += 1;
                    continue;
                }
                if !is_safe_dir(&canonical_root, &entry_path, &mut report) {
                    continue;
                }

                let cargo_path = entry_path.join("Cargo.toml");
                let mut crate_name = dir_name.clone();
                if is_safe_regular_file(&canonical_root, &cargo_path, &mut report) {
                    if let Ok(cargo_text) = read_bounded_utf8(&cargo_path) {
                        report.files_indexed += 1;
                        if let Some(pkg) = parse_package_name(&cargo_text) {
                            crate_name = pkg;
                        }
                        let manifest_rel = format!("rust/{dir_name}/Cargo.toml");
                        let manifest_id = format!("file:{manifest_rel}");
                        let crate_id = format!("crate:{crate_name}");
                        report.indexed_crates.push(crate_name.clone());

                        pending_entities.push(GraphifyEntity {
                            id: manifest_id.clone(),
                            kind: GraphifyEntityKind::Artifact,
                            label: format!("{crate_name} Cargo.toml"),
                            source_path: manifest_rel.clone(),
                            symbol_span: None,
                        });
                        pending_entities.push(GraphifyEntity {
                            id: crate_id.clone(),
                            kind: GraphifyEntityKind::CodeModule,
                            label: crate_name.clone(),
                            source_path: format!("rust/{dir_name}"),
                            symbol_span: None,
                        });
                        pending_edges.push(GraphifyEdge {
                            from_id: manifest_id,
                            to_id: crate_id.clone(),
                            relation: "defines_crate".to_owned(),
                            provenance: GraphifyProvenance::Extracted,
                            confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                            source_locator: manifest_rel.clone(),
                        });

                        for dep in parse_cargo_dependencies(&cargo_text) {
                            let dep_id = format!("crate:{dep}");
                            pending_entities.push(GraphifyEntity {
                                id: dep_id.clone(),
                                kind: GraphifyEntityKind::CodeModule,
                                label: dep,
                                source_path: String::new(),
                                symbol_span: None,
                            });
                            pending_edges.push(GraphifyEdge {
                                from_id: crate_id.clone(),
                                to_id: dep_id,
                                relation: "depends_on".to_owned(),
                                provenance: GraphifyProvenance::Extracted,
                                confidence_bps: GraphifyProvenance::Extracted
                                    .default_confidence_bps(),
                                source_locator: manifest_rel.clone(),
                            });
                        }
                    }
                }

                let src_dir = entry_path.join("src");
                if is_safe_dir(&canonical_root, &src_dir, &mut report) {
                    let mut rs_files = Vec::new();
                    collect_safe_files_recursive(
                        &canonical_root,
                        &src_dir,
                        "rs",
                        &mut report,
                        &mut rs_files,
                    )?;
                    let crate_id = format!("crate:{crate_name}");
                    pending_entities.push(GraphifyEntity {
                        id: crate_id.clone(),
                        kind: GraphifyEntityKind::CodeModule,
                        label: crate_name.clone(),
                        source_path: format!("rust/{dir_name}"),
                        symbol_span: None,
                    });

                    for rs_path in rs_files {
                        let rel = rel_slash_path(workspace_root, &rs_path);
                        let Ok(rs_text) = read_bounded_utf8(&rs_path) else {
                            continue;
                        };
                        report.files_indexed += 1;
                        let mod_id = format!("module:{rel}");
                        pending_entities.push(GraphifyEntity {
                            id: mod_id.clone(),
                            kind: GraphifyEntityKind::CodeModule,
                            label: rel.clone(),
                            source_path: rel.clone(),
                            symbol_span: None,
                        });
                        pending_edges.push(GraphifyEdge {
                            from_id: crate_id.clone(),
                            to_id: mod_id.clone(),
                            relation: "contains_source".to_owned(),
                            provenance: GraphifyProvenance::Extracted,
                            confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                            source_locator: rel.clone(),
                        });

                        for (line_no, sym_name) in extract_rust_public_symbols(&rs_text) {
                            let sym_id = format!("sym:{crate_name}::{sym_name}");
                            pending_entities.push(GraphifyEntity {
                                id: sym_id.clone(),
                                kind: GraphifyEntityKind::Symbol,
                                label: sym_name,
                                source_path: rel.clone(),
                                symbol_span: Some(format!("L{line_no}")),
                            });
                            pending_edges.push(GraphifyEdge {
                                from_id: mod_id.clone(),
                                to_id: sym_id,
                                relation: "defines_symbol".to_owned(),
                                provenance: GraphifyProvenance::Extracted,
                                confidence_bps: GraphifyProvenance::Extracted
                                    .default_confidence_bps(),
                                source_locator: format!("{rel}#L{line_no}"),
                            });
                        }

                        for imported_crate in extract_internal_rust_imports(&rs_text) {
                            if imported_crate != crate_name {
                                let target_id = format!("crate:{imported_crate}");
                                pending_entities.push(GraphifyEntity {
                                    id: target_id.clone(),
                                    kind: GraphifyEntityKind::CodeModule,
                                    label: imported_crate,
                                    source_path: String::new(),
                                    symbol_span: None,
                                });
                                pending_edges.push(GraphifyEdge {
                                    from_id: mod_id.clone(),
                                    to_id: target_id,
                                    relation: "imports".to_owned(),
                                    provenance: GraphifyProvenance::Extracted,
                                    confidence_bps: GraphifyProvenance::Extracted
                                        .default_confidence_bps(),
                                    source_locator: rel.clone(),
                                });
                            }
                        }
                    }
                }
            }
        }

        // 3. ui/app/*.js
        let ui_app_dir = workspace_root.join("ui").join("app");
        if is_safe_dir(&canonical_root, &ui_app_dir, &mut report) {
            for js_path in sorted_dir_entries(&ui_app_dir)? {
                if js_path.extension().and_then(|e| e.to_str()) != Some("js") {
                    continue;
                }
                if !is_safe_regular_file(&canonical_root, &js_path, &mut report) {
                    continue;
                }
                let Ok(js_text) = read_bounded_utf8(&js_path) else {
                    continue;
                };
                report.files_indexed += 1;
                let rel = rel_slash_path(workspace_root, &js_path);
                let ui_id = format!("ui:{rel}");
                pending_entities.push(GraphifyEntity {
                    id: ui_id.clone(),
                    kind: GraphifyEntityKind::CodeModule,
                    label: file_name_lossy(&js_path),
                    source_path: rel.clone(),
                    symbol_span: None,
                });
                for (line_no, export_name) in extract_js_exports(&js_text) {
                    let sym_id = format!("uisym:{rel}::{export_name}");
                    pending_entities.push(GraphifyEntity {
                        id: sym_id.clone(),
                        kind: GraphifyEntityKind::Symbol,
                        label: export_name,
                        source_path: rel.clone(),
                        symbol_span: Some(format!("L{line_no}")),
                    });
                    pending_edges.push(GraphifyEdge {
                        from_id: ui_id.clone(),
                        to_id: sym_id,
                        relation: "exports_symbol".to_owned(),
                        provenance: GraphifyProvenance::Extracted,
                        confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                        source_locator: format!("{rel}#L{line_no}"),
                    });
                }
                for api_ep in extract_api_endpoints(&js_text) {
                    let api_id = format!("api:{api_ep}");
                    pending_entities.push(GraphifyEntity {
                        id: api_id.clone(),
                        kind: GraphifyEntityKind::Artifact,
                        label: api_ep,
                        source_path: rel.clone(),
                        symbol_span: None,
                    });
                    pending_edges.push(GraphifyEdge {
                        from_id: ui_id.clone(),
                        to_id: api_id,
                        relation: "calls_api".to_owned(),
                        provenance: GraphifyProvenance::Inferred,
                        confidence_bps: GraphifyProvenance::Inferred.default_confidence_bps(),
                        source_locator: rel.clone(),
                    });
                }
            }
        }

        // 4. docs/**/*.md
        let docs_dir = workspace_root.join("docs");
        if is_safe_dir(&canonical_root, &docs_dir, &mut report) {
            let mut md_files = Vec::new();
            collect_safe_files_recursive(
                &canonical_root,
                &docs_dir,
                "md",
                &mut report,
                &mut md_files,
            )?;
            for md_path in md_files {
                let Ok(md_text) = read_bounded_utf8(&md_path) else {
                    continue;
                };
                report.files_indexed += 1;
                let rel = rel_slash_path(workspace_root, &md_path);
                let doc_id = format!("doc:{rel}");
                pending_entities.push(GraphifyEntity {
                    id: doc_id.clone(),
                    kind: GraphifyEntityKind::Artifact,
                    label: file_name_lossy(&md_path),
                    source_path: rel.clone(),
                    symbol_span: None,
                });

                for req_id in extract_requirement_ids(&md_text) {
                    let req_entity_id = format!("req:{req_id}");
                    pending_entities.push(GraphifyEntity {
                        id: req_entity_id.clone(),
                        kind: GraphifyEntityKind::Requirement,
                        label: req_id,
                        source_path: rel.clone(),
                        symbol_span: None,
                    });
                    pending_edges.push(GraphifyEdge {
                        from_id: doc_id.clone(),
                        to_id: req_entity_id,
                        relation: "mentions_requirement".to_owned(),
                        provenance: GraphifyProvenance::Extracted,
                        confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                        source_locator: rel.clone(),
                    });
                }

                for target_rel in extract_markdown_rel_links(workspace_root, &md_path, &md_text) {
                    let target_id =
                        if target_rel.starts_with("docs/") && target_rel.ends_with(".md") {
                            format!("doc:{target_rel}")
                        } else {
                            format!("file:{target_rel}")
                        };
                    let target_kind = if target_rel.starts_with("docs/") {
                        GraphifyEntityKind::Artifact
                    } else {
                        GraphifyEntityKind::CodeModule
                    };
                    pending_entities.push(GraphifyEntity {
                        id: target_id.clone(),
                        kind: target_kind,
                        label: target_rel.clone(),
                        source_path: target_rel,
                        symbol_span: None,
                    });
                    pending_edges.push(GraphifyEdge {
                        from_id: doc_id.clone(),
                        to_id: target_id,
                        relation: "references".to_owned(),
                        provenance: GraphifyProvenance::Extracted,
                        confidence_bps: GraphifyProvenance::Extracted.default_confidence_bps(),
                        source_locator: rel.clone(),
                    });
                }
            }
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AgentGraphError::InternalLockPoisoned)?;
        for entity in pending_entities {
            if guard.upsert_entity(entity) {
                report.entities_added += 1;
            }
        }
        for edge in pending_edges {
            if guard.add_edge(edge)? {
                report.edges_added += 1;
            }
        }
        report.indexed_crates.sort();
        report.indexed_crates.dedup();
        Ok(report)
    }
}

fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

fn is_excluded_dir_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    EXCLUDED_DIRS.iter().any(|ex| *ex == lower)
}

fn strip_verbatim(p: &Path) -> String {
    let raw = p.to_string_lossy().replace('\\', "/");
    if let Some(rest) = raw.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = raw.strip_prefix("//?/") {
        rest.to_owned()
    } else {
        raw
    }
}

fn is_within_canonical_root(canonical_root: &Path, candidate: &Path) -> bool {
    let Ok(canon_cand) = fs::canonicalize(candidate) else {
        return false;
    };
    let root_str = strip_verbatim(canonical_root);
    let cand_str = strip_verbatim(&canon_cand);
    #[cfg(windows)]
    let (r, c) = (root_str.to_ascii_lowercase(), cand_str.to_ascii_lowercase());
    #[cfg(not(windows))]
    let (r, c) = (root_str, cand_str);
    if r == c {
        return true;
    }
    c.starts_with(&r) && c.as_bytes().get(r.len()) == Some(&b'/')
}

fn is_safe_dir(canonical_root: &Path, path: &Path, report: &mut WorkspaceIndexReport) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if is_symlink_or_reparse(&meta) {
        report.skipped_reparse_points += 1;
        return false;
    }
    meta.is_dir() && is_within_canonical_root(canonical_root, path)
}

fn is_safe_regular_file(
    canonical_root: &Path,
    path: &Path,
    report: &mut WorkspaceIndexReport,
) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if is_symlink_or_reparse(&meta) {
        report.skipped_reparse_points += 1;
        return false;
    }
    meta.is_file()
        && meta.len() <= MAX_INDEXED_FILE_BYTES
        && is_within_canonical_root(canonical_root, path)
}

fn sorted_dir_entries(dir: &Path) -> Result<Vec<PathBuf>, AgentGraphError> {
    let rd = fs::read_dir(dir)
        .map_err(|e| AgentGraphError::IoError(format!("{}: {e}", dir.display())))?;
    let mut paths = Vec::new();
    for item in rd.flatten() {
        paths.push(item.path());
    }
    paths.sort();
    Ok(paths)
}

fn collect_safe_files_recursive(
    canonical_root: &Path,
    dir: &Path,
    ext: &str,
    report: &mut WorkspaceIndexReport,
    out: &mut Vec<PathBuf>,
) -> Result<(), AgentGraphError> {
    for path in sorted_dir_entries(dir)? {
        let name = file_name_lossy(&path);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if is_symlink_or_reparse(&meta) {
            report.skipped_reparse_points += 1;
            continue;
        }
        if meta.is_dir() {
            if is_excluded_dir_name(&name) {
                report.skipped_excluded_dirs += 1;
                continue;
            }
            if is_within_canonical_root(canonical_root, &path) {
                collect_safe_files_recursive(canonical_root, &path, ext, report, out)?;
            }
        } else if meta.is_file()
            && meta.len() <= MAX_INDEXED_FILE_BYTES
            && path.extension().and_then(|e| e.to_str()) == Some(ext)
            && is_within_canonical_root(canonical_root, &path)
        {
            out.push(path);
        }
    }
    Ok(())
}

fn read_bounded_utf8(path: &Path) -> Result<String, AgentGraphError> {
    let bytes =
        fs::read(path).map_err(|e| AgentGraphError::IoError(format!("{}: {e}", path.display())))?;
    Ok(omnia_core::sanitize_utf8_lossy(&bytes))
}

fn file_name_lossy(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn rel_slash_path(root: &Path, target: &Path) -> String {
    target
        .strip_prefix(root)
        .unwrap_or(target)
        .to_string_lossy()
        .replace('\\', "/")
}

fn parse_cargo_members(text: &str) -> Vec<String> {
    let mut members = Vec::new();
    let mut in_members = false;
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.starts_with("members") && line.contains('[') {
            in_members = true;
        }
        if in_members {
            let mut rest = line;
            while let Some(start) = rest.find('"') {
                let after = &rest[start + 1..];
                if let Some(end) = after.find('"') {
                    let val = after[..end].trim();
                    if !val.is_empty() {
                        members.push(val.to_owned());
                    }
                    rest = &after[end + 1..];
                } else {
                    break;
                }
            }
            if line.contains(']') {
                in_members = false;
            }
        }
    }
    members
}

fn parse_package_name(text: &str) -> Option<String> {
    let mut in_pkg = false;
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            in_pkg = line == "[package]";
            continue;
        }
        if in_pkg && line.starts_with("name") {
            if let Some((_, rhs)) = line.split_once('=') {
                let cleaned = rhs.trim().trim_matches('"');
                if !cleaned.is_empty() {
                    return Some(cleaned.to_owned());
                }
            }
        }
    }
    None
}

fn parse_cargo_dependencies(text: &str) -> Vec<String> {
    let mut deps = Vec::new();
    let mut in_deps = false;
    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            in_deps = matches!(
                line,
                "[dependencies]" | "[dev-dependencies]" | "[build-dependencies]"
            );
            continue;
        }
        if in_deps {
            if let Some((lhs, _)) = line.split_once('=') {
                let dep = lhs.trim().trim_matches('"');
                if !dep.is_empty() && !dep.contains('.') {
                    deps.push(dep.to_owned());
                }
            }
        }
    }
    deps
}

fn extract_rust_public_symbols(text: &str) -> Vec<(usize, String)> {
    let mut syms = Vec::new();
    let prefixes = [
        "pub async fn ",
        "pub fn ",
        "pub struct ",
        "pub enum ",
        "pub trait ",
        "pub type ",
        "pub const ",
        "pub mod ",
    ];
    for (idx, raw_line) in text.lines().enumerate() {
        let trimmed = raw_line.trim_start();
        for prefix in prefixes {
            if let Some(rest) = trimmed.strip_prefix(prefix) {
                let ident: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                if !ident.is_empty() {
                    syms.push((idx + 1, ident));
                }
                break;
            }
        }
    }
    syms
}

fn extract_internal_rust_imports(text: &str) -> Vec<String> {
    let mut crates = BTreeSet::new();
    for raw_line in text.lines() {
        let trimmed = raw_line.trim();
        if let Some(rest) = trimmed.strip_prefix("use ") {
            let ident: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if ident.starts_with("omnia_") {
                crates.insert(ident.replace('_', "-"));
            }
        }
    }
    crates.into_iter().collect()
}

fn extract_js_exports(text: &str) -> Vec<(usize, String)> {
    let mut syms = Vec::new();
    let prefixes = [
        "export async function ",
        "export function ",
        "export class ",
        "export const ",
    ];
    for (idx, raw_line) in text.lines().enumerate() {
        let trimmed = raw_line.trim_start();
        for prefix in prefixes {
            if let Some(rest) = trimmed.strip_prefix(prefix) {
                let ident: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                    .collect();
                if !ident.is_empty() {
                    syms.push((idx + 1, ident));
                }
                break;
            }
        }
    }
    syms
}

fn extract_api_endpoints(text: &str) -> Vec<String> {
    let mut endpoints = BTreeSet::new();
    let mut rest = text;
    while let Some(pos) = rest.find("/api/") {
        let slice = &rest[pos..];
        let ep: String = slice
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
            .collect();
        if ep.len() > 5 {
            endpoints.insert(ep);
        }
        rest = &rest[pos + 5..];
    }
    endpoints.into_iter().collect()
}

fn extract_requirement_ids(text: &str) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for prefix in ["DOD-", "PRODUCT-", "ROOT-", "SESSION-"] {
        let mut rest = text;
        while let Some(pos) = rest.find(prefix) {
            let after = &rest[pos + prefix.len()..];
            let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                ids.insert(format!("{prefix}{digits}"));
            }
            rest = &rest[pos + prefix.len()..];
        }
    }
    ids.into_iter().collect()
}

fn extract_markdown_rel_links(workspace_root: &Path, md_path: &Path, text: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    let parent_dir = md_path.parent().unwrap_or(workspace_root);
    let mut rest = text;
    while let Some(open) = rest.find("](") {
        let after = &rest[open + 2..];
        let Some(close) = after.find(')') else {
            break;
        };
        let raw_target = after[..close].trim();
        let target_no_anchor = raw_target.split('#').next().unwrap_or("").trim();
        if !target_no_anchor.is_empty()
            && !target_no_anchor.starts_with("http://")
            && !target_no_anchor.starts_with("https://")
            && !target_no_anchor.starts_with("mailto:")
            && !target_no_anchor.starts_with("file://")
        {
            let resolved = normalize_relative_path(parent_dir, target_no_anchor);
            if let Ok(rel) = resolved.strip_prefix(workspace_root) {
                let s = rel.to_string_lossy().replace('\\', "/");
                if !s.is_empty() {
                    out.insert(s);
                }
            }
        }
        rest = &after[close + 1..];
    }
    out.into_iter().collect()
}

fn normalize_relative_path(base: &Path, rel: &str) -> PathBuf {
    let mut stack = base.to_path_buf();
    for part in rel.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                let _ = stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack
}
