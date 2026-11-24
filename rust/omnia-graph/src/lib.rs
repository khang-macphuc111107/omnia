#![forbid(unsafe_code)]

//! Bidirectional all-to-all peer mesh (`PeerMeshGraph`) and provenance-tracked
//! code/document knowledge index (`GraphifyIndex`).

pub mod cst_ppr;
pub mod graphify_index;
pub mod peer_mesh;

pub use cst_ppr::{
    detect_cst_language, extract_cst_facts, CsrCodeGraph, CsrRelationKind, CstFileFacts, CstSymbol,
    PprEntityHit,
};
pub use graphify_index::{
    GraphifyEdge, GraphifyEntity, GraphifyEntityKind, GraphifyIndex, GraphifyProvenance,
    GraphifyTraversalResult, TraversalDirection, WorkspaceIndexReport,
};
pub use peer_mesh::{
    normalize_repo_path, prefix_covers, valid_agent_id, AgentGraphError, AgentNode, AgentRole,
    ConvergenceReport, PeerLinkEdge, PeerMeshGraph, PeerMessage, StalledPeerAlert,
};
