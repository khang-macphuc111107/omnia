//! Zero-AI pure-Rust systems microbenchmark for `omnia-agent`.
//! Measures real workspace indexing (Tree-sitter 0.25 + CSR PPR + BLAKE3 Merkle),
//! Hybrid BM25F + Zoekt Trigram + RRF search, Hashline v2 + imara-diff editing,
//! and BAML SAP partial-JSON repair with ZERO LLM API calls.

use omnia_agent::edit::{edit_file_by_hashline, line_hash_tag_str, FileReadTracker};
use omnia_agent::graph_locator::{verify_syntax_delta, WorkspaceGraphIndex};
use omnia_agent::permissions::ApprovalMode;
use omnia_agent::sap_json::repair_tool_json;
use omnia_agent::search::SearchMode;
use serde_json::json;
use std::path::PathBuf;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let repo_root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\Omnia"));

    // 1. Cold full-repo index: BLAKE3 Merkle + Tree-sitter 0.25 CST + CSR graph + Trigram/BM25F
    let t0 = Instant::now();
    let mut graph = WorkspaceGraphIndex::new(&repo_root);
    let cold_delta = graph.refresh()?;
    let cold_index_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // 2. Warm clean re-scan (BLAKE3 Merkle dirty-path pruning)
    let mut warm_ms = Vec::with_capacity(10);
    for _ in 0..10 {
        let tw = Instant::now();
        let d = graph.refresh()?;
        warm_ms.push(tw.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(d.changed_files.len(), 0);
    }
    warm_ms.sort_by(|a, b| a.total_cmp(b));
    let warm_merkle_p50_ms = warm_ms[warm_ms.len() / 2];

    // 3. CSR Personalized PageRank + Turn-1 Token-Budgeted AST RepoMap
    let mut ppr_ms = Vec::with_capacity(10);
    let mut repomap_bytes = 0usize;
    for _ in 0..10 {
        let tp = Instant::now();
        let map = graph.render_turn1_repomap(
            "NativeSuperEngine stream_anthropic_turn PrefixCacheGuard",
            1200,
        );
        ppr_ms.push(tp.elapsed().as_secs_f64() * 1000.0);
        repomap_bytes = map.len();
    }
    ppr_ms.sort_by(|a, b| a.total_cmp(b));
    let repomap_p50_ms = ppr_ms[ppr_ms.len() / 2];

    // 4. LocAgent entity search + 2-hop graph traversal + Hybrid BM25F/Trigram/RRF search
    let queries = [
        "NativeSuperEngine",
        "PrefixCacheGuard",
        "repair_tool_json",
        "edit_file_by_hashline",
        "WorkspaceGraphIndex",
        "OscillationDetector",
        "TurnCheckpointStore",
        "DownloadManager",
        "NotebookEngine",
        "PeerMeshGraph",
    ];
    let mut hybrid_us = Vec::with_capacity(queries.len() * 3);
    let mut entity_us = Vec::with_capacity(queries.len() * 3);
    let mut traverse_us = Vec::with_capacity(queries.len() * 3);
    let mut total_hits = 0usize;
    for _ in 0..3 {
        for q in &queries {
            let te = Instant::now();
            let hits = graph.search_entity(q, 10);
            entity_us.push(te.elapsed().as_secs_f64() * 1_000_000.0);
            total_hits += hits.len();

            let tt = Instant::now();
            let trav = graph.traverse_graph(q, 2);
            traverse_us.push(tt.elapsed().as_secs_f64() * 1_000_000.0);
            total_hits += trav.reached_files.len();

            let th = Instant::now();
            let out = graph.search(
                q,
                SearchMode::Hybrid,
                None,
                false,
                1,
                15,
                &[],
                true,
                ApprovalMode::Yolo,
            )?;
            hybrid_us.push(th.elapsed().as_secs_f64() * 1_000_000.0);
            total_hits += out.match_count;
        }
    }
    entity_us.sort_by(|a, b| a.total_cmp(b));
    traverse_us.sort_by(|a, b| a.total_cmp(b));
    hybrid_us.sort_by(|a, b| a.total_cmp(b));

    // 5. Hashline v2 + Tree-sitter post-edit syntax verification throughput (200 real disk edits in temp dir)
    let tmp = std::env::temp_dir().join(format!("omnia_bench_edit_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp)?;
    let target = tmp.join("sample.rs");
    let mut initial = String::new();
    for i in 0..200 {
        initial.push_str(&format!(
            "pub fn compute_{i}(x: i64) -> i64 {{ x + {i} }}\n"
        ));
    }
    std::fs::write(&target, &initial)?;
    let tracker = FileReadTracker::new();
    let t_edit = Instant::now();
    let mut syntax_clean = 0usize;
    let edit_iters = 200usize;
    for i in 0..edit_iters {
        let raw = std::fs::read(&target)?;
        tracker.record_read(&target, &raw);
        let text = String::from_utf8(raw)?;
        let lines: Vec<&str> = text.lines().collect();
        let line_idx0 = i % 200;
        let tag = line_hash_tag_str(&lines, line_idx0);
        let anchor = format!("{}:{}", line_idx0 + 1, tag);
        let replacement = format!(
            "pub fn compute_{line_idx0}(x: i64) -> i64 {{ x.saturating_add({}) }}",
            line_idx0 + i + 1
        );
        let res = edit_file_by_hashline(&tmp, "sample.rs", &anchor, None, &replacement, &tracker)?;
        assert!(res.replacements == 1);
        let updated = std::fs::read_to_string(&target)?;
        let report = verify_syntax_delta(
            "sample.rs",
            &text,
            &updated,
            Some((line_idx0 + 1, line_idx0 + 1)),
        );
        if report.is_clean() {
            syntax_clean += 1;
        }
    }
    let edit_total_ms = t_edit.elapsed().as_secs_f64() * 1000.0;
    let _ = std::fs::remove_dir_all(&tmp);

    // 6. BAML SAP Partial-JSON Repair Stress Corpus (10,000 malformed SSE tool calls)
    let schema = json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "start_line": { "type": "integer" },
            "max_lines": { "type": "integer" },
            "recursive": { "type": "boolean" }
        }
    });
    let corpus = [
        "{\"path\":\"src/engine.rs\",\"start_line\":100.0,\"max_lines\":50.0,}",
        "```json\n{\"path\":\"src/lib.rs\",\"start_line\":42,\"recursive\":\"true\"}\n```",
        "{\"path\":\"src/edit.rs\",\"start_line\":12,\"max_lines\":80",
        "{\"path\":\"src/patch.rs\",\"start_line\":1000.0,\"note\":\"line1\nline2\"}",
        "Here is the call: {\"path\":\"Cargo.toml\",\"start_line\":1,\"max_lines\":20,}",
    ];
    let sap_runs = 10_000usize;
    let t_sap = Instant::now();
    let mut sap_ok = 0usize;
    for i in 0..sap_runs {
        let sample = corpus[i % corpus.len()];
        if let Ok(r) = repair_tool_json(sample, Some(&schema)) {
            if r.value.get("path").and_then(|v| v.as_str()).is_some() {
                sap_ok += 1;
            }
        }
    }
    let sap_total_ms = t_sap.elapsed().as_secs_f64() * 1000.0;

    let report = json!({
        "workspace": repo_root.display().to_string(),
        "indexed_files": graph.merkle().files().len(),
        "indexed_dirs": graph.merkle().dir_count(),
        "ast_parsed_files": graph.parsed_asts().len(),
        "ast_symbols": graph.symbol_count(),
        "cold_changed_files": cold_delta.changed_files.len(),
        "cold_full_index_ms": (cold_index_ms * 100.0).round() / 100.0,
        "warm_merkle_rescan_p50_ms": (warm_merkle_p50_ms * 100.0).round() / 100.0,
        "ppr_repomap_p50_ms": (repomap_p50_ms * 100.0).round() / 100.0,
        "repomap_bytes": repomap_bytes,
        "entity_search_p50_us": (entity_us[entity_us.len() / 2] * 10.0).round() / 10.0,
        "graph_traverse_2hop_p50_us": (traverse_us[traverse_us.len() / 2] * 10.0).round() / 10.0,
        "hybrid_bm25f_trigram_rrf_p50_ms": ((hybrid_us[hybrid_us.len() / 2] / 1000.0) * 100.0).round() / 100.0,
        "search_total_hits": total_hits,
        "hashline_edit_plus_ast_verify_iters": edit_iters,
        "hashline_edit_plus_ast_clean": syntax_clean,
        "hashline_edit_plus_ast_avg_ms": ((edit_total_ms / edit_iters as f64) * 1000.0).round() / 1000.0,
        "hashline_edit_plus_ast_ops_per_sec": ((edit_iters as f64 / (edit_total_ms / 1000.0)) * 10.0).round() / 10.0,
        "sap_json_repair_iters": sap_runs,
        "sap_json_repair_success": sap_ok,
        "sap_json_repair_rate_pct": (100.0 * sap_ok as f64 / sap_runs as f64),
        "sap_json_repair_avg_us": ((sap_total_ms * 1000.0 / sap_runs as f64) * 100.0).round() / 100.0,
        "sap_json_repair_ops_per_sec": (sap_runs as f64 / (sap_total_ms / 1000.0)).round(),
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
