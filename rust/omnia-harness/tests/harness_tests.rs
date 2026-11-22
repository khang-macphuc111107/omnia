use std::fs;
use std::path::{Path, PathBuf};

use omnia_core::uuid_v4;
use omnia_harness::{
    is_valid_key, is_valid_namespace, AttachmentPlacement, ComposerModel, MemoryError, MemoryGraph,
    MemoryTier, ProactiveRag, SkillRegistry, SteerMode, SteerQueue, SteerStatus,
};

#[test]
fn memory_graph_cycles_and_erasure() {
    assert!(is_valid_namespace("omnia/routing/v2"));
    assert!(!is_valid_namespace(""));
    assert!(!is_valid_namespace("/leading/slash"));
    assert!(!is_valid_namespace("bad..seg"));
    assert!(!is_valid_namespace("1/2/3/4/5/6/7/8/9"));
    assert!(is_valid_key("router_invariants.v1"));
    assert!(!is_valid_key("bad/key"));

    let mg = MemoryGraph::new();
    let e1 = mg
        .upsert(
            "omnia/core",
            "node-a",
            MemoryTier::Durable,
            "Root decision references [[node-b|Peer B]]",
            &[],
            Some(1_000),
        )
        .expect("upsert a");
    let e2 = mg
        .upsert(
            "omnia/core",
            "node-b",
            MemoryTier::Working,
            "Secondary references [[node-a|Back to A]] and [[secret-leaf|Secret]]",
            &[],
            Some(1_100),
        )
        .expect("upsert b");
    assert_eq!(e1.links, vec!["omnia/core/node-b"]);
    assert_eq!(e2.version, 1);

    mg.upsert(
        "omnia/core",
        "secret-leaf",
        MemoryTier::Working,
        "Transient token=tok-temporary-secret",
        &[],
        Some(1_200),
    )
    .expect("upsert leaf");

    let trav = mg
        .traverse_cyclic_safe("omnia/core/node-a", 6)
        .expect("traverse cyclic safe");
    assert_eq!(trav.visited.len(), 3);
    assert_eq!(trav.detected_cycles.len(), 1);
    assert_eq!(
        trav.detected_cycles[0],
        vec![
            "omnia/core/node-a",
            "omnia/core/node-b",
            "omnia/core/node-a"
        ]
    );

    let receipt = mg
        .erase("omnia/core", "secret-leaf", Some(1_300))
        .expect("erase leaf");
    assert!(receipt.verified_plaintext_free);
    assert!(receipt.receipt_id.starts_with("erase-1-"));
    assert_eq!(receipt.removed_edges, 1);
    assert!(mg
        .get("omnia/core", "secret-leaf")
        .expect("get erased")
        .is_none());

    let receipt_json = receipt.to_json().to_string();
    assert!(!receipt_json.contains("tok-temporary-secret"));

    let updated_b = mg
        .get("omnia/core", "node-b")
        .expect("get b")
        .expect("b present");
    assert!(!updated_b
        .links
        .iter()
        .any(|l| l == "omnia/core/secret-leaf"));

    let double_erase = mg
        .erase("omnia/core", "secret-leaf", Some(1_400))
        .expect_err("double erase must return NotFound");
    assert!(matches!(double_erase, MemoryError::NotFound { .. }));
}

#[test]
fn proactive_rag_bilingual_and_citation_gates() {
    let rag = ProactiveRag::new();

    // Accent-insensitive Vietnamese query AND accented Vietnamese query must both resolve!
    let vn_accented = rag.plan_and_retrieve(
        "Tại sao hạn mức router và kiến trúc đồ thị lại tách bạch?",
        3,
    );
    assert_eq!(vn_accented.language, "vi");
    assert!(vn_accented.should_retrieve);
    assert!(vn_accented
        .sub_queries
        .iter()
        .any(|sq| sq.intent == "bilingual_cross_reference"));
    assert!(vn_accented
        .cited_sources
        .iter()
        .any(|s| s.source_id == "src-dynamic-router"));

    let vn_unaccented = rag.plan_and_retrieve(
        "Tai sao han muc dinh tuyen va giao thuc do thi lai quan trong?",
        3,
    );
    assert_eq!(vn_unaccented.language, "vi");
    assert!(vn_unaccented.should_retrieve);
    assert!(vn_unaccented
        .cited_sources
        .iter()
        .any(|s| s.source_id == "src-dynamic-router"));

    let mixed = rag.plan_and_retrieve(
        "Compare hạn mức quota and DynamicProviderRouter fallback?",
        3,
    );
    assert_eq!(mixed.language, "bilingual");
    assert!(mixed.should_retrieve);

    let en = rag.plan_and_retrieve(
        "How does DynamicProviderRouter handle Unknown quota and circuit fallback?",
        2,
    );
    assert_eq!(en.language, "en");
    assert!(en.should_retrieve);
    assert!(en
        .unused_sources
        .iter()
        .any(|u| u.exclusion_reason == "quarantined_ambiguous_provenance"));
    assert!(en
        .unused_sources
        .iter()
        .any(|u| u.exclusion_reason == "superseded_historical_artifact"));
    assert!(!en
        .cited_sources
        .iter()
        .any(|c| c.source_id == "src-ambiguous-draft"
            || c.source_id == "src-legacy-tauri-superseded"));
}

#[test]
fn skill_registry_manifest_openai_yaml_and_bm25() {
    let temp_root = std::env::temp_dir().join(format!("omnia-skill-reg-{}", uuid_v4()));
    let skill_a = temp_root.join(".agents/skills/vn-typo-helper");
    let skill_b = temp_root.join(".agents/skills/cpp-native-build");
    fs::create_dir_all(skill_a.join("agents")).expect("mkdir skill a");
    fs::create_dir_all(skill_b.join("agents")).expect("mkdir skill b");

    fs::write(
        temp_root.join(".agents/skills.json"),
        "{\"entries\":[{\"path\":\".agents/skills\"}]}",
    )
    .expect("write skills.json");
    fs::write(
        skill_a.join("SKILL.md"),
        "\u{FEFF}---\nname: vn-typo-helper\ndescription: >\n  Resolve Vietnamese Telex and VNI diacritic input variants accurately.\n---\nBody\n",
    )
    .expect("write skill a");
    fs::write(
        skill_a.join("agents/openai.yaml"),
        "interface:\n  display_name: \"Vietnamese Input Helper\"\n  short_description: \"Bilingual Telex VNI normalizer\"\n  default_prompt: \"Normalize Vietnamese prompt slips\"\n",
    )
    .expect("write openai.yaml a");
    fs::write(
        skill_b.join("SKILL.md"),
        "---\nname: cpp-native-build\ndescription: \"Out-of-source CMake Ninja MSVC builds\"\n---\nBody\n",
    )
    .expect("write skill b");

    let reg = SkillRegistry::new();
    let report = reg.load_from_workspace(&temp_root).expect("load workspace");
    assert_eq!(report.loaded, 2);

    let list = reg.list_skills().expect("list skills");
    assert_eq!(list.len(), 2);
    let helper = list
        .iter()
        .find(|s| s.name == "vn-typo-helper")
        .expect("helper present");
    assert_eq!(
        helper
            .openai_interface
            .as_ref()
            .map(|o| o.display_name.as_str()),
        Some("Vietnamese Input Helper")
    );

    let vn_hits = reg.search("tiếng việt telex", 5).expect("search vn");
    assert_eq!(vn_hits[0].skill.name, "vn-typo-helper");

    let unaccented_hits = reg.search("tieng viet vni", 5).expect("search unaccented");
    assert_eq!(unaccented_hits[0].skill.name, "vn-typo-helper");

    let _ = fs::remove_dir_all(&temp_root);

    // Also test against the live Omnia repo `.agents/skills.json` if present.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest.parent().and_then(Path::parent) {
        if repo_root.join(".agents/skills.json").exists() {
            let live_reg = SkillRegistry::new();
            let live_rep = live_reg
                .load_from_workspace(repo_root)
                .expect("load repo skills");
            assert!(live_rep.loaded >= 13);
            let steer_hits = live_reg
                .search("additive steer queue unfinished tasks", 5)
                .expect("search steer");
            assert!(!steer_hits.is_empty());
        }
    }
}

#[test]
fn composer_templates_dual_paste_encrypted_pdf_and_steer_queue() {
    let templates = ComposerModel::templates();
    assert_eq!(templates.len(), 15);
    assert!(templates.iter().any(|t| t.id == "chem-gibbs"));
    assert!(templates.iter().any(|t| t.id == "phys-maxwell-curl"));

    let mut composer = ComposerModel::new();
    composer.set_draft("Solve ", 6);
    assert!(composer.insert_template_at_caret("chem-gibbs"));
    assert!(composer
        .draft_text()
        .contains(r"\Delta G = \Delta H - T\Delta S"));

    let before_cancel = composer.draft_text().to_owned();
    let canceled = composer.handle_attachment_paste(
        "diagram.png",
        "image/png",
        b"\x89PNG\r\n\x1A\npayload",
        AttachmentPlacement::Cancel,
    );
    assert!(!canceled.accepted);
    assert_eq!(composer.draft_text(), before_cancel);
    assert!(composer.inline_attachments().is_empty());
    assert!(composer.tray_attachments().is_empty());

    let inline = composer.handle_attachment_paste(
        "notes.txt",
        "text/plain",
        b"Hello Omnia",
        AttachmentPlacement::InlineAtCaret,
    );
    assert!(inline.accepted);
    assert!(!inline.deduplicated);
    assert_eq!(composer.inline_attachments().len(), 1);

    // Duplicate payload must deduplicate without duplicating attachment lists.
    let dup = composer.handle_attachment_paste(
        "notes-copy.txt",
        "text/plain",
        b"Hello Omnia",
        AttachmentPlacement::AttachmentTray,
    );
    assert!(dup.accepted);
    assert!(dup.deduplicated);
    assert!(composer.tray_attachments().is_empty());

    // Encrypted PDF must never extract content.
    let encrypted_pdf = b"%PDF-1.7\n1 0 obj << /Type /Catalog /Encrypt 2 0 R >> endobj\n";
    let pdf_res = composer.handle_attachment_paste(
        "locked.pdf",
        "application/pdf",
        encrypted_pdf,
        AttachmentPlacement::AttachmentTray,
    );
    let att = pdf_res.attachment.expect("pdf attachment");
    assert!(att.is_encrypted);
    assert!(att.status.starts_with("UNREADABLE:"));

    // SteerQueue ADDITIVE_INTAKE contract
    let queue = SteerQueue::new();
    assert_eq!(queue.token_budget(), None);
    let s1 = queue.enqueue(
        "Implement core parity",
        SteerMode::AdditiveIntake,
        Some(100),
    );
    assert!(queue.mark_status(&s1.id, SteerStatus::InProgress));
    let s2 = queue.enqueue(
        "Add Vietnamese RAG folding",
        SteerMode::AdditiveIntake,
        Some(200),
    );

    let snapshot = queue.items();
    assert_eq!(snapshot.len(), 2);
    assert_eq!(snapshot[0].status, SteerStatus::InProgress);
    assert_eq!(snapshot[1].status, SteerStatus::Queued);
    assert_eq!(queue.active_backlog_count(), 2);
    assert_eq!(queue.token_budget(), None);

    // Only explicit cancel/supersede updates a targeted entry.
    let s3 = queue.enqueue(
        "Replace obsolete step",
        SteerMode::ExplicitStopOrReplace,
        Some(300),
    );
    assert!(queue.reconcile_cancel_or_supersede(&s2.id, Some(&s3.id), "superseded by s3"));
    let updated = queue.items();
    assert_eq!(updated[0].status, SteerStatus::InProgress);
    assert_eq!(updated[1].status, SteerStatus::Superseded);
    assert_eq!(updated[2].status, SteerStatus::Queued);
}
