use std::fs;
use std::path::PathBuf;

use omnia_graph::{
    extract_cst_facts, GraphifyEdge, GraphifyEntity, GraphifyEntityKind, GraphifyIndex,
    GraphifyProvenance, TraversalDirection,
};

struct TempWorkspace {
    path: PathBuf,
}

impl TempWorkspace {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "omnia-cst-ppr-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("mkdir");
        Self { path }
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn cst_extracts_symbols_imports_calls_across_rust_python_ts_go_cpp() {
    let rs = extract_cst_facts(
        "src/router.rs",
        "use crate::quota::QuotaState;\npub struct DynamicRouter { pub ok: bool }\nimpl DynamicRouter { pub fn route(&self) { check_quota(); } }\n",
    );
    assert_eq!(rs.language, "rust");
    assert!(rs.symbols.iter().any(|s| s.name == "DynamicRouter" && s.is_public));
    assert!(rs.symbols.iter().any(|s| s.name == "route" && s.is_public));
    assert!(rs.imports.iter().any(|i| i.contains("QuotaState")));
    assert!(rs.call_refs.iter().any(|c| c == "check_quota"));

    let py = extract_cst_facts(
        "pkg/engine.py",
        "from pkg.base import BaseEngine\nclass Runner(BaseEngine):\n    def execute(self):\n        return self.step()\n",
    );
    assert_eq!(py.language, "python");
    assert!(py.symbols.iter().any(|s| s.name == "Runner"));
    assert!(py.symbols.iter().any(|s| s.name == "execute"));
    assert!(py.inherits.iter().any(|b| b == "BaseEngine"));
    assert!(py.call_refs.iter().any(|c| c == "step"));

    let ts = extract_cst_facts(
        "ui/app.tsx",
        "import { useStore } from './store';\nexport class StudioView {}\nexport function renderApp() { return useStore(); }\n",
    );
    assert_eq!(ts.language, "tsx");
    assert!(ts.symbols.iter().any(|s| s.name == "StudioView"));
    assert!(ts.symbols.iter().any(|s| s.name == "renderApp"));

    let go = extract_cst_facts(
        "cmd/main.go",
        "package main\nimport \"fmt\"\ntype Engine struct{}\nfunc Run() { fmt.Println(\"ok\") }\n",
    );
    assert_eq!(go.language, "go");
    assert!(go.symbols.iter().any(|s| s.name == "Run" && s.is_public));

    let cpp = extract_cst_facts(
        "native/win.cpp",
        "#include <windows.h>\nclass WinShell {};\nint main() { return 0; }\n",
    );
    assert_eq!(cpp.language, "cpp");
    assert!(cpp.symbols.iter().any(|s| s.name == "WinShell"));
}

#[test]
fn csr_ppr_ranks_connected_neighbors_and_quarantines_ambiguous_edges() {
    let idx = GraphifyIndex::new();
    for (id, label, path) in [
        ("mod:engine", "engine.rs", "rust/src/engine.rs"),
        ("sym:run", "run_prompt", "rust/src/engine.rs"),
        ("mod:router", "router.rs", "rust/src/router.rs"),
        ("mod:orphan", "orphan.rs", "rust/src/orphan.rs"),
    ] {
        idx.upsert_entity(GraphifyEntity {
            id: id.to_owned(),
            kind: GraphifyEntityKind::Symbol,
            label: label.to_owned(),
            source_path: path.to_owned(),
            symbol_span: Some("1-10".to_owned()),
        })
        .expect("upsert");
    }
    idx.add_edge(GraphifyEdge {
        from_id: "mod:engine".to_owned(),
        to_id: "sym:run".to_owned(),
        relation: "defines".to_owned(),
        provenance: GraphifyProvenance::Extracted,
        confidence_bps: 10_000,
        source_locator: "rust/src/engine.rs".to_owned(),
    })
    .unwrap();
    idx.add_edge(GraphifyEdge {
        from_id: "sym:run".to_owned(),
        to_id: "mod:router".to_owned(),
        relation: "calls".to_owned(),
        provenance: GraphifyProvenance::Inferred,
        confidence_bps: 8_500,
        source_locator: "rust/src/engine.rs".to_owned(),
    })
    .unwrap();
    idx.add_edge(GraphifyEdge {
        from_id: "mod:engine".to_owned(),
        to_id: "mod:orphan".to_owned(),
        relation: "references".to_owned(),
        provenance: GraphifyProvenance::Ambiguous,
        confidence_bps: 3_000,
        source_locator: "rust/src/engine.rs".to_owned(),
    })
    .unwrap();

    let hits_clean = idx.ranked_ppr(&["mod:engine"], "", 4, false).expect("ppr clean");
    assert!(hits_clean.iter().any(|h| h.id == "mod:router"));
    let router_score = hits_clean
        .iter()
        .find(|h| h.id == "mod:router")
        .map(|h| h.score)
        .unwrap_or(0.0);
    let orphan_score = hits_clean
        .iter()
        .find(|h| h.id == "mod:orphan")
        .map(|h| h.score)
        .unwrap_or(0.0);
    assert!(router_score > orphan_score);

    let trav = idx
        .traverse("mod:engine", TraversalDirection::Forward, 2, false)
        .expect("traverse");
    assert!(!trav.quarantined_ambiguous.is_empty());
}

#[test]
fn graphify_index_workspace_extracts_rust_and_ui_symbols_via_cst() {
    let ws = TempWorkspace::new("ws");
    fs::create_dir_all(ws.path.join("rust/demo/src")).unwrap();
    fs::create_dir_all(ws.path.join("ui/app")).unwrap();
    fs::write(
        ws.path.join("Cargo.toml"),
        "[workspace]\nmembers = [\"rust/demo\"]\n",
    )
    .unwrap();
    fs::write(
        ws.path.join("rust/demo/Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    fs::write(
        ws.path.join("rust/demo/src/lib.rs"),
        "pub struct CstWidget { pub count: usize }\npub fn build_widget() -> CstWidget { CstWidget { count: 1 } }\n",
    )
    .unwrap();
    fs::write(
        ws.path.join("ui/app/widget.js"),
        "export function mountWidget(el) { return el; }\n",
    )
    .unwrap();
    fs::create_dir_all(ws.path.join("py_pkg")).unwrap();
    fs::write(
        ws.path.join("py_pkg/base.py"),
        "class BaseService:\n    def settle_task(self):\n        return True\n",
    )
    .unwrap();
    fs::write(
        ws.path.join("py_pkg/worker.py"),
        "from py_pkg.base import BaseService\nclass Worker(BaseService):\n    def run(self):\n        return self.settle_task()\n",
    )
    .unwrap();

    let idx = GraphifyIndex::new();
    let report = idx.index_workspace(&ws.path).expect("index workspace");
    assert!(report.entities_added >= 6);
    let entities = idx.entities().unwrap();
    assert!(entities.iter().any(|e| e.label == "CstWidget"));
    assert!(entities.iter().any(|e| e.label == "build_widget"));
    assert!(entities.iter().any(|e| e.label == "mountWidget"));
    assert!(entities.iter().any(|e| e.label == "settle_task"));

    let ppr = idx
        .ranked_ppr(&["mod:py_pkg/worker.py"], "", 8, false)
        .expect("ranked ppr");
    assert!(ppr.iter().any(|h| h.id.contains("settle_task") || h.id.contains("BaseService")));
}
