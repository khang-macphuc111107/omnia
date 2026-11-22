use std::fs;
use std::path::{Path, PathBuf};

use omnia_core::uuid_v4;
use omnia_graph::{
    AgentGraphError, AgentRole, GraphifyEdge, GraphifyEntity, GraphifyEntityKind, GraphifyIndex,
    GraphifyProvenance, PeerMeshGraph, TraversalDirection,
};

#[test]
fn peer_mesh_duplex_and_guards() {
    let mesh = PeerMeshGraph::new(3);

    mesh.register_agent(
        "coord",
        AgentRole::Coordinator,
        vec!["docs/**".to_owned()],
        vec!["docs/generated/**".to_owned()],
    )
    .expect("register coord");
    mesh.register_agent(
        "worker-a",
        AgentRole::Worker,
        vec!["rust/omnia-routing/**".to_owned()],
        vec![],
    )
    .expect("register worker-a");
    mesh.register_agent(
        "worker-b",
        AgentRole::Worker,
        vec!["rust/omnia-graph/**".to_owned()],
        vec![],
    )
    .expect("register worker-b");
    mesh.register_agent(
        "verifier",
        AgentRole::Verifier,
        vec!["docs/generated/**".to_owned()],
        vec![],
    )
    .expect("register verifier carved out of coord exclusion");

    // Conflicting overlap must be rejected even with Windows backslashes or globs.
    let conflict = mesh
        .register_agent(
            "worker-dup",
            AgentRole::Worker,
            vec!["rust\\omnia-routing\\src".to_owned()],
            vec![],
        )
        .expect_err("overlapping path must be rejected");
    assert!(matches!(
        conflict,
        AgentGraphError::OwnershipConflict { .. }
    ));

    // Connect sibling <-> sibling, author <-> verifier, child <-> parent.
    mesh.connect_duplex("worker-a", "worker-b", "sibling_mesh")
        .expect("duplex siblings");
    mesh.connect_duplex("worker-a", "verifier", "author_verifier")
        .expect("duplex author-verifier");
    mesh.connect_duplex("coord", "worker-a", "parent_child")
        .expect("duplex parent-child");

    assert!(mesh.has_duplex_link("worker-a", "worker-b").expect("link"));
    assert!(mesh.has_duplex_link("worker-b", "worker-a").expect("rev"));

    // Cursor-based delivery and reply hop tracking.
    let m1 = mesh
        .send_peer(
            "worker-a",
            "worker-b",
            "contract",
            "need PeerMesh API",
            None,
            None,
            Some(1_000),
        )
        .expect("m1");
    let b_inbox = mesh.read_since("worker-b", 0).expect("read_since 0");
    assert_eq!(b_inbox.len(), 1);
    assert_eq!(b_inbox[0].seq, m1.seq);
    assert!(mesh
        .read_since("worker-b", m1.seq)
        .expect("read_since latest")
        .is_empty());

    let m2 = mesh
        .reply("worker-b", m1.seq, "", "ready", Some(1_050))
        .expect("reply 1");
    assert_eq!(m2.hop_count, 1);
    let m3 = mesh
        .reply("worker-a", m2.seq, "", "ack", Some(1_100))
        .expect("reply 2");
    assert_eq!(m3.hop_count, 2);

    // Hop 3 reaches max_hops=3 and must be refused.
    let hop_err = mesh
        .reply("worker-b", m3.seq, "", "infinite ping-pong", Some(1_150))
        .expect_err("hop budget exceeded");
    assert!(matches!(
        hop_err,
        AgentGraphError::HopBudgetExceeded {
            hop_count: 3,
            max_hops: 3
        }
    ));

    // Stale epoch rejection after epoch bump.
    let new_epoch = mesh.bump_agent_epoch("worker-a").expect("bump epoch");
    assert_eq!(new_epoch, 2);
    let epoch_err = mesh
        .send_peer(
            "worker-a",
            "worker-b",
            "stale",
            "old turn",
            Some(1),
            None,
            Some(1_200),
        )
        .expect_err("stale epoch rejected");
    assert!(matches!(epoch_err, AgentGraphError::StaleEpoch { .. }));

    // Broadcast + unread stall detection.
    let bcast = mesh
        .broadcast("worker-a", "sync", "checkpoint reached", None, Some(2_000))
        .expect("broadcast");
    assert!(bcast.recipients.contains(&"coord".to_owned()));
    assert!(bcast.recipients.contains(&"verifier".to_owned()));
    let stalled = mesh
        .detect_stalled_conversations(10_000, 5_000)
        .expect("stalled");
    assert!(!stalled.is_empty());

    let drained = mesh.drain_unread("verifier").expect("drain unread");
    assert_eq!(drained.len(), 1);
    assert!(mesh
        .drain_unread("verifier")
        .expect("drain empty")
        .is_empty());
}

#[test]
fn graphify_bidirectional_traversal() {
    let idx = GraphifyIndex::new();
    for (id, kind, label, path) in [
        (
            "req:DOD-02",
            GraphifyEntityKind::Requirement,
            "DOD-02",
            "docs/workspace/DOD.md",
        ),
        (
            "mod:router",
            GraphifyEntityKind::CodeModule,
            "dynamic_router",
            "rust/omnia-routing/src/lib.rs",
        ),
        (
            "sym:decide",
            GraphifyEntityKind::Symbol,
            "decide_and_reserve",
            "rust/omnia-routing/src/lib.rs",
        ),
        (
            "art:draft",
            GraphifyEntityKind::Artifact,
            "legacy_draft",
            "docs/draft.md",
        ),
    ] {
        idx.upsert_entity(GraphifyEntity {
            id: id.to_owned(),
            kind,
            label: label.to_owned(),
            source_path: path.to_owned(),
            symbol_span: None,
        })
        .expect("upsert entity");
    }

    idx.add_edge(GraphifyEdge {
        from_id: "req:DOD-02".to_owned(),
        to_id: "mod:router".to_owned(),
        relation: "implemented_by".to_owned(),
        provenance: GraphifyProvenance::Extracted,
        confidence_bps: 10_000,
        source_locator: "DOD.md#DOD-02".to_owned(),
    })
    .expect("e1");
    idx.add_edge(GraphifyEdge {
        from_id: "mod:router".to_owned(),
        to_id: "sym:decide".to_owned(),
        relation: "defines".to_owned(),
        provenance: GraphifyProvenance::Extracted,
        confidence_bps: 10_000,
        source_locator: "lib.rs#decide_and_reserve".to_owned(),
    })
    .expect("e2");
    // Cycle edge back to req:DOD-02 (inferred)
    idx.add_edge(GraphifyEdge {
        from_id: "sym:decide".to_owned(),
        to_id: "req:DOD-02".to_owned(),
        relation: "verifies".to_owned(),
        provenance: GraphifyProvenance::Inferred,
        confidence_bps: 7_500,
        source_locator: "routing_tests.rs".to_owned(),
    })
    .expect("e3");
    // Ambiguous edge should be quarantined when include_ambiguous=false.
    idx.add_edge(GraphifyEdge {
        from_id: "mod:router".to_owned(),
        to_id: "art:draft".to_owned(),
        relation: "maybe_related".to_owned(),
        provenance: GraphifyProvenance::Ambiguous,
        confidence_bps: 0,
        source_locator: "draft.md".to_owned(),
    })
    .expect("e4");

    let forward = idx
        .traverse("req:DOD-02", TraversalDirection::Forward, 4, false)
        .expect("forward");
    assert_eq!(forward.visited_entities.len(), 3);
    assert_eq!(forward.quarantined_ambiguous.len(), 1);
    assert_eq!(forward.detected_cycles.len(), 1);
    assert!(!forward.visited_entities.iter().any(|e| e.id == "art:draft"));

    let reverse = idx
        .traverse("sym:decide", TraversalDirection::Reverse, 2, false)
        .expect("reverse");
    assert!(reverse
        .visited_entities
        .iter()
        .any(|e| e.id == "req:DOD-02"));

    let both_with_ambiguous = idx
        .traverse("mod:router", TraversalDirection::Both, 2, true)
        .expect("both");
    assert!(both_with_ambiguous
        .visited_entities
        .iter()
        .any(|e| e.id == "art:draft"));
}

#[test]
fn graphify_workspace_indexer_scans_repo_and_skips_excluded_dirs() {
    let temp_root = std::env::temp_dir().join(format!("omnia-graph-idx-{}", uuid_v4()));
    fs::create_dir_all(temp_root.join("rust/omnia-demo/src")).expect("mkdir src");
    fs::create_dir_all(temp_root.join("ui/app")).expect("mkdir ui");
    fs::create_dir_all(temp_root.join("docs/workspace")).expect("mkdir docs");
    fs::create_dir_all(temp_root.join("docs/.git")).expect("mkdir excluded .git");
    fs::create_dir_all(temp_root.join("rust/target/src")).expect("mkdir excluded target");
    fs::create_dir_all(temp_root.join("rust/build/src")).expect("mkdir excluded build");
    fs::create_dir_all(temp_root.join("rust/Roaming/src")).expect("mkdir excluded Roaming");

    fs::write(
        temp_root.join("Cargo.toml"),
        "[workspace]\nmembers = [\n  \"rust/omnia-demo\",\n]\n",
    )
    .expect("write Cargo.toml");
    fs::write(
        temp_root.join("rust/omnia-demo/Cargo.toml"),
        "[package]\nname = \"omnia-demo\"\n\n[dependencies]\nomnia-core = { path = \"../omnia-core\" }\n",
    )
    .expect("write crate Cargo.toml");
    fs::write(
        temp_root.join("rust/omnia-demo/src/lib.rs"),
        "use omnia_core::sha256_hex;\npub struct DemoRouter;\npub fn route_now() {}\n",
    )
    .expect("write lib.rs");
    fs::write(
        temp_root.join("ui/app/router-lab.js"),
        "export function mountRouterLab() { return fetch('/api/routing/decisions'); }\n",
    )
    .expect("write js");
    fs::write(
        temp_root.join("docs/workspace/GOAL.md"),
        "# Goal\nSatisfies DOD-01 and [Demo](../rust/omnia-demo/src/lib.rs).\n",
    )
    .expect("write GOAL.md");
    fs::write(temp_root.join("docs/.git/secret.md"), "ignored DOD-99").expect("write git");
    fs::write(
        temp_root.join("rust/target/src/lib.rs"),
        "pub fn ignored_target_fn() {}\n",
    )
    .expect("write target");

    let index = GraphifyIndex::new();
    let report = index.index_workspace(&temp_root).expect("index workspace");
    assert_eq!(report.files_indexed, 5);
    assert!(report.skipped_excluded_dirs >= 4);
    assert!(report.indexed_crates.contains(&"omnia-demo".to_owned()));

    assert!(index
        .entity("sym:omnia-demo::DemoRouter")
        .expect("lookup sym")
        .is_some());
    assert!(index
        .entity("api:/api/routing/decisions")
        .expect("lookup api")
        .is_some());
    assert!(index.entity("req:DOD-01").expect("lookup req").is_some());
    assert!(index
        .entity("req:DOD-99")
        .expect("lookup ignored")
        .is_none());

    let trav = index
        .traverse(
            "doc:docs/workspace/GOAL.md",
            TraversalDirection::Forward,
            2,
            false,
        )
        .expect("traverse doc");
    assert!(trav.visited_entities.iter().any(|e| e.id == "req:DOD-01"));

    let _ = fs::remove_dir_all(&temp_root);
}

#[test]
fn graphify_indexes_live_omnia_repo() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let Some(repo_root) = manifest.parent().and_then(Path::parent) else {
        return;
    };
    if !repo_root.join("Cargo.toml").exists() {
        return;
    }
    let idx = GraphifyIndex::new();
    let report = idx
        .index_workspace(repo_root)
        .expect("index real omnia repo");
    assert!(report.files_indexed > 0);
    assert!(report.indexed_crates.contains(&"omnia-graph".to_owned()));
    assert!(idx
        .entity("sym:omnia-graph::PeerMeshGraph")
        .expect("lookup PeerMeshGraph")
        .is_some());
}
