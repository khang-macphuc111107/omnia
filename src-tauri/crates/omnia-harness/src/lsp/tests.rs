use super::*;
use std::sync::Arc;

const FAKE_SERVER: &str = r#"
const fs = require('fs');
let buf = Buffer.alloc(0);
const docs = {};
function send(o) {
  const b = Buffer.from(JSON.stringify(o));
  process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n');
  process.stdout.write(b);
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function range(l, c, l2, c2) { return { start: { line: l, character: c }, end: { line: l2, character: c2 } }; }
function publish(uri, tag) {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [
    { range: range(1, 3, 1, 4), severity: 2, message: 'fake warning ' + tag, source: 'fake', code: 'W1' },
    { range: range(0, 0, 0, 1), severity: 1, message: 'fake error ' + tag, source: 'fake', code: 7 },
    { range: range(0, 0, 0, 1), severity: 3, message: 'fake info' },
  ] } });
}
function handle(m) {
  switch (m.method) {
    case 'initialize': reply(m.id, { capabilities: {} }); return;
    case 'initialized':
      send({ jsonrpc: '2.0', id: 'srv1', method: 'workspace/configuration', params: { items: [{ section: 'x' }] } });
      send({ jsonrpc: '2.0', id: 99, method: 'window/workDoneProgress/create', params: { token: 't' } });
      return;
    case 'textDocument/didOpen':
      docs[m.params.textDocument.uri] = m.params.textDocument.text;
      publish(m.params.textDocument.uri, 'open'); return;
    case 'textDocument/didChange':
      docs[m.params.textDocument.uri] = m.params.contentChanges[0].text;
      publish(m.params.textDocument.uri, 'change'); return;
    case 'textDocument/definition':
      reply(m.id, { uri: m.params.textDocument.uri, range: range(1, 3, 1, 4) }); return;
    case 'textDocument/references':
      reply(m.id, [
        { uri: m.params.textDocument.uri, range: range(0, 0, 0, 3) },
        { targetUri: m.params.textDocument.uri, targetRange: range(1, 0, 1, 1), targetSelectionRange: range(1, 3, 1, 4) },
      ].slice(0, m.params.context.includeDeclaration ? 2 : 1)); return;
    case 'textDocument/hover':
      reply(m.id, { contents: { kind: 'markdown', value: 'fake hover' } }); return;
    case 'textDocument/documentSymbol':
      reply(m.id, [{ name: 'Outer', kind: 5, range: range(0, 0, 2, 0), selectionRange: range(0, 0, 0, 3),
        children: [{ name: 'inner', kind: 6, range: range(1, 0, 1, 7), selectionRange: range(1, 3, 1, 4) }] }]); return;
    case 'workspace/symbol':
      reply(m.id, [{ name: 'Found_' + m.params.query, kind: 12, containerName: 'mod',
        location: { uri: Object.keys(docs)[0], range: range(1, 3, 1, 4) } }]); return;
    case 'textDocument/rename': {
      const uri = m.params.textDocument.uri;
      const lines = docs[uri].split('\n');
      const p = m.params.position;
      const word = /[A-Za-z_]+/g;
      let target = null, mm;
      while ((mm = word.exec(lines[p.line])) !== null) {
        if (mm.index <= p.character && p.character <= mm.index + mm[0].length) target = mm[0];
      }
      if (!target) { reply(m.id, null); return; }
      const edits = [];
      lines.forEach((line, l) => {
        const re = new RegExp('\\b' + target + '\\b', 'g'); let x;
        while ((x = re.exec(line)) !== null) edits.push({ range: range(l, x.index, l, x.index + target.length), newText: m.params.newName });
      });
      edits.reverse();
      if (m.params.newName === 'USE_DOC_CHANGES') {
        reply(m.id, { documentChanges: [{ textDocument: { uri, version: 1 }, edits }] });
      } else if (m.params.newName === 'MAKE_FILE') {
        reply(m.id, { documentChanges: [{ kind: 'create', uri: uri + '.new' }] });
      } else if (m.params.newName === 'OUTSIDE') {
        reply(m.id, { changes: { 'file:///definitely/not/in/workspace.fake': edits } });
      } else {
        reply(m.id, { changes: { [uri]: edits } });
      }
      return;
    }
    case 'shutdown': reply(m.id, null); return;
    case 'exit': process.exit(0);
  }
  if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const i = buf.indexOf('\r\n\r\n');
    if (i < 0) return;
    const mt = /Content-Length: (\d+)/i.exec(buf.slice(0, i).toString());
    const n = Number(mt[1]);
    if (buf.length < i + 4 + n) return;
    const body = buf.slice(i + 4, i + 4 + n).toString();
    buf = buf.slice(i + 4 + n);
    handle(JSON.parse(body));
  }
});
"#;

struct Fixture {
    _home: tempfile::TempDir,
    work: tempfile::TempDir,
    registry: ToolRegistry,
    manager: Arc<LspManager>,
}

fn node() -> Option<PathBuf> {
    config::resolve_command("node", &config::path_dirs())
}

fn fixture(idle: Duration) -> Option<Fixture> {
    let node = node()?;
    let home = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let script = home.path().join("fake-lsp.js");
    std::fs::write(&script, FAKE_SERVER).unwrap();
    std::fs::write(
        home.path().join("lsp.json"),
        json!({"servers": {"fake": {
            "command": node.to_string_lossy(),
            "args": [script.to_string_lossy()],
            "extensions": ["fake"]
        }}})
        .to_string(),
    )
    .unwrap();
    let manager =
        Arc::new(LspManager::new(Some(home.path().to_path_buf()), false).with_idle_timeout(idle));
    let mut registry = ToolRegistry::default();
    register_with(&mut registry, Arc::clone(&manager));
    Some(Fixture {
        _home: home,
        work,
        registry,
        manager,
    })
}

impl Fixture {
    async fn call(&self, tool: &str, input: Value) -> ToolOutput {
        let ctx = ToolContext::new(self.work.path());
        self.registry
            .get(tool)
            .unwrap()
            .call(&ctx, input)
            .await
            .unwrap()
    }
}

fn text_of(out: &ToolOutput) -> String {
    out.content
        .iter()
        .filter_map(|b| match b {
            crate::Block::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn registers_six_tools_with_effects() {
    let mut registry = ToolRegistry::default();
    register(&mut registry, None, false);
    let names: Vec<&str> = registry.names().collect();
    assert_eq!(
        names,
        [
            "lsp_definition",
            "lsp_diagnostics",
            "lsp_hover",
            "lsp_references",
            "lsp_rename",
            "lsp_symbols"
        ]
    );
    for name in &names {
        let tool = registry.get(name).unwrap();
        assert_eq!(tool.spec().input_schema["type"], "object");
        assert_eq!(
            tool.effect() == EffectClass::WriteWorkspace,
            *name == "lsp_rename"
        );
    }
}

#[tokio::test]
async fn missing_server_gives_install_instructions() {
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("a.rs"), "fn main() {}").unwrap();
    let manager = Arc::new(LspManager::new(None, false).with_path_dirs(vec![]));
    let mut registry = ToolRegistry::default();
    register_with(&mut registry, manager);
    let ctx = ToolContext::new(work.path());
    let out = registry
        .get("lsp_hover")
        .unwrap()
        .call(&ctx, json!({"path":"a.rs","line":1,"column":1}))
        .await
        .unwrap();
    assert!(out.is_error);
    let text = text_of(&out);
    assert!(
        text.contains("rustup component add rust-analyzer"),
        "{text}"
    );
    assert!(text.contains("lsp.json"), "{text}");
}

#[tokio::test]
async fn bad_arguments_are_model_errors() {
    let work = tempfile::tempdir().unwrap();
    let mut registry = ToolRegistry::default();
    register(&mut registry, None, false);
    let ctx = ToolContext::new(work.path());
    for (tool, input) in [
        ("lsp_definition", json!({"path":"a.rs","line":0,"column":1})),
        ("lsp_symbols", json!({})),
        (
            "lsp_rename",
            json!({"path":"a.rs","line":1,"column":1,"new_name":"a b"}),
        ),
        (
            "lsp_definition",
            json!({"path":"missing.rs","line":1,"column":1}),
        ),
        ("lsp_hover", json!({"path": 5})),
    ] {
        let out = registry.get(tool).unwrap().call(&ctx, input).await.unwrap();
        assert!(out.is_error, "{tool}: {}", text_of(&out));
    }
}

#[tokio::test]
async fn fake_server_end_to_end() {
    let Some(fx) = fixture(IDLE_SHUTDOWN) else {
        eprintln!("skipping: node not on PATH");
        return;
    };
    // line 2 starts with an emoji so UTF-16 and character columns differ.
    std::fs::write(
        fx.work.path().join("x.fake"),
        "foo 😀 foo\n😀 ab\nbar foo\n",
    )
    .unwrap();

    // The fake server resolves "definition" to line 2, UTF-16 char 3 => char col 3.
    let out = fx
        .call(
            "lsp_definition",
            json!({"path":"x.fake","line":1,"column":1}),
        )
        .await;
    let text = text_of(&out);
    assert!(!out.is_error, "{text}");
    assert!(text.contains("1 definition"), "{text}");
    assert!(text.contains("x.fake:2:3  😀 ab"), "{text}");

    let out = fx
        .call(
            "lsp_references",
            json!({"path":"x.fake","line":1,"column":1}),
        )
        .await;
    let text = text_of(&out);
    assert!(text.contains("2 references"), "{text}");
    assert!(text.contains("x.fake:1:1  foo 😀 foo"), "{text}");
    assert!(text.contains("x.fake:2:3"), "{text}");
    let out = fx
        .call(
            "lsp_references",
            json!({"path":"x.fake","line":1,"column":1,"include_declaration":false}),
        )
        .await;
    assert!(text_of(&out).contains("1 reference"), "{}", text_of(&out));

    let out = fx
        .call("lsp_hover", json!({"path":"x.fake","line":1,"column":1}))
        .await;
    assert_eq!(text_of(&out), "fake hover");

    let out = fx.call("lsp_symbols", json!({"path":"x.fake"})).await;
    let text = text_of(&out);
    assert!(text.contains("class Outer  1:1"), "{text}");
    assert!(text.contains("  method inner  2:3"), "{text}");

    let out = fx.call("lsp_symbols", json!({"query":"Zed"})).await;
    let text = text_of(&out);
    assert!(
        text.contains("function Found_Zed (in mod)  x.fake:2:3"),
        "{text}"
    );

    let out = fx.call("lsp_diagnostics", json!({"path":"x.fake"})).await;
    let text = text_of(&out);
    assert!(text.contains("1 error(s), 1 warning(s)"), "{text}");
    assert!(
        text.contains("x.fake:1:1 error[7] fake error open (fake)"),
        "{text}"
    );
    assert!(
        text.contains("x.fake:2:3 warning[W1] fake warning open (fake)"),
        "{text}"
    );
    assert!(!text.contains("fake info"), "{text}");

    // Rename: "foo" on line 3 (1-based col 5) -> every occurrence, UTF-16 safe.
    let out = fx
        .call(
            "lsp_rename",
            json!({"path":"x.fake","line":3,"column":5,"new_name":"baz"}),
        )
        .await;
    let text = text_of(&out);
    assert!(!out.is_error, "{text}");
    assert!(text.contains("3 edits in 1 file"), "{text}");
    assert!(text.contains("x.fake:1:7  `foo` -> `baz`"), "{text}");
    assert_eq!(
        std::fs::read_to_string(fx.work.path().join("x.fake")).unwrap(),
        "baz 😀 baz\n😀 ab\nbar baz\n"
    );

    // The next diagnostics call sees the changed file (didChange).
    let out = fx.call("lsp_diagnostics", json!({"path":"x.fake"})).await;
    assert!(
        text_of(&out).contains("fake error change"),
        "{}",
        text_of(&out)
    );
    assert_eq!(fx.manager.live_count().await, 1);
}

#[tokio::test]
async fn rename_variants_and_refusals() {
    let Some(fx) = fixture(IDLE_SHUTDOWN) else {
        eprintln!("skipping: node not on PATH");
        return;
    };
    let file = fx.work.path().join("y.fake");
    std::fs::write(&file, "abc abc\nabc\n").unwrap();

    let out = fx
        .call(
            "lsp_rename",
            json!({"path":"y.fake","line":1,"column":1,"new_name":"USE_DOC_CHANGES"}),
        )
        .await;
    assert!(!out.is_error, "{}", text_of(&out));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "USE_DOC_CHANGES USE_DOC_CHANGES\nUSE_DOC_CHANGES\n"
    );

    std::fs::write(&file, "abc\n").unwrap();
    for name in ["MAKE_FILE", "OUTSIDE"] {
        let out = fx
            .call(
                "lsp_rename",
                json!({"path":"y.fake","line":1,"column":1,"new_name":name}),
            )
            .await;
        assert!(out.is_error, "{name}: {}", text_of(&out));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "abc\n");
    }

    // No identifier under the cursor => null from the server.
    std::fs::write(&file, "   \n").unwrap();
    let out = fx
        .call(
            "lsp_rename",
            json!({"path":"y.fake","line":1,"column":2,"new_name":"q"}),
        )
        .await;
    assert!(out.is_error);

    // Out-of-range positions are reported before reaching the server.
    let out = fx
        .call("lsp_hover", json!({"path":"y.fake","line":9,"column":1}))
        .await;
    assert!(text_of(&out).contains("out of range"), "{}", text_of(&out));
}

#[tokio::test]
async fn rename_records_checkpoints() {
    let Some(fx) = fixture(IDLE_SHUTDOWN) else {
        eprintln!("skipping: node not on PATH");
        return;
    };
    let file = fx.work.path().join("z.fake");
    std::fs::write(&file, "abc abc\n").unwrap();
    let cp_dir = tempfile::tempdir().unwrap();
    let store = Arc::new(crate::CheckpointStore::open(cp_dir.path().join("cp")).unwrap());
    let mut ctx = ToolContext::new(fx.work.path());
    ctx.checkpoint = Some(crate::CheckpointScope::from_key(Arc::clone(&store), 1));
    let out = fx
        .registry
        .get("lsp_rename")
        .unwrap()
        .call(
            &ctx,
            json!({"path":"z.fake","line":1,"column":1,"new_name":"xyz"}),
        )
        .await
        .unwrap();
    assert!(!out.is_error, "{}", text_of(&out));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "xyz xyz\n");
    let report = store.restore(1);
    assert!(report.failed.is_empty(), "{report:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "abc abc\n");
}

#[tokio::test]
async fn cancellation_and_idle_shutdown() {
    let Some(fx) = fixture(Duration::from_millis(0)) else {
        eprintln!("skipping: node not on PATH");
        return;
    };
    std::fs::write(fx.work.path().join("c.fake"), "abc\n").unwrap();

    let ctx = ToolContext::new(fx.work.path());
    ctx.cancel.cancel();
    let result = fx
        .registry
        .get("lsp_hover")
        .unwrap()
        .call(&ctx, json!({"path":"c.fake","line":1,"column":1}))
        .await;
    assert!(matches!(result, Err(HarnessError::Cancelled)));

    let out = fx
        .call("lsp_hover", json!({"path":"c.fake","line":1,"column":1}))
        .await;
    assert!(!out.is_error, "{}", text_of(&out));
    // The background reaper (idle = 0) or an explicit sweep stops the server.
    tokio::time::sleep(Duration::from_millis(50)).await;
    fx.manager.sweep().await;
    assert_eq!(fx.manager.live_count().await, 0);
    // A later call transparently restarts it.
    let out = fx
        .call("lsp_hover", json!({"path":"c.fake","line":1,"column":1}))
        .await;
    assert!(!out.is_error, "{}", text_of(&out));
    assert_eq!(fx.manager.live_count().await, 1);
}

#[tokio::test]
async fn project_config_only_when_trusted() {
    let Some(node) = node() else {
        eprintln!("skipping: node not on PATH");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let script = work.path().join("fake-lsp.js");
    std::fs::write(&script, FAKE_SERVER).unwrap();
    std::fs::create_dir_all(work.path().join(".omnia")).unwrap();
    std::fs::write(
        work.path().join(".omnia/lsp.json"),
        json!({"servers": {"p": {"command": node.to_string_lossy(),
            "args": [script.to_string_lossy()], "extensions": ["proj"]}}})
        .to_string(),
    )
    .unwrap();
    std::fs::write(work.path().join("a.proj"), "abc\n").unwrap();
    let ctx = ToolContext::new(work.path());
    for (trusted, ok) in [(false, false), (true, true)] {
        let manager = Arc::new(LspManager::new(None, trusted));
        let mut registry = ToolRegistry::default();
        register_with(&mut registry, manager);
        let out = registry
            .get("lsp_hover")
            .unwrap()
            .call(&ctx, json!({"path":"a.proj","line":1,"column":1}))
            .await
            .unwrap();
        assert_eq!(!out.is_error, ok, "trusted={trusted}: {}", text_of(&out));
        if !ok {
            assert!(text_of(&out).contains("not trusted"), "{}", text_of(&out));
        }
    }
}

#[tokio::test]
async fn immutable_snapshot_dispatches_approved_bytes_and_rejects_other_workspace() {
    let Some(node) = node() else {
        eprintln!("skipping: node not on PATH");
        return;
    };
    let work = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let script = work.path().join("approved-lsp.js");
    std::fs::write(&script, FAKE_SERVER).unwrap();
    let bytes = json!({"servers": {"snapshot": {
        "command": node.to_string_lossy(),
        "args": [script.to_string_lossy()],
        "extensions": ["snap"]
    }}})
    .to_string()
    .into_bytes();
    let snapshot = load_specs_from_snapshot(work.path(), Some(&bytes), None);
    let manager = Arc::new(
        LspManager::new(None, false)
            .with_spec_snapshot(work.path(), snapshot)
            .with_idle_timeout(Duration::ZERO),
    );
    let mut registry = ToolRegistry::default();
    register_with(&mut registry, Arc::clone(&manager));
    // The launch still uses the approved node program and script after the
    // repository replaces its executable config before the first tool call.
    std::fs::create_dir_all(work.path().join(".omnia")).unwrap();
    std::fs::write(
        work.path().join(".omnia/lsp.json"),
        r#"{"servers":{"snapshot":{"command":"not-approved","extensions":["snap"]}}}"#,
    )
    .unwrap();
    for root in [work.path(), other.path()] {
        std::fs::write(root.join("a.snap"), "abc\n").unwrap();
    }
    let call = |root: &Path| {
        let ctx = ToolContext::new(root);
        let tool = registry.get("lsp_hover").unwrap();
        async move {
            tool.call(&ctx, json!({"path":"a.snap","line":1,"column":1}))
                .await
                .unwrap()
        }
    };
    let approved = call(work.path()).await;
    assert!(!approved.is_error, "{}", text_of(&approved));
    let rejected = call(other.path()).await;
    assert!(rejected.is_error);
    assert!(
        text_of(&rejected).contains("another workspace"),
        "{}",
        text_of(&rejected)
    );
    manager.sweep().await;
}

/// Needs a working rust-analyzer (`rustup component add rust-analyzer`).
#[tokio::test]
#[ignore]
async fn rust_analyzer_definition() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"lsp_probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(
        dir.path().join("src/main.rs"),
        "fn helper() -> u32 {\n    1\n}\n\nfn main() {\n    let _x = helper();\n}\n",
    )
    .unwrap();
    let mut registry = ToolRegistry::default();
    register(&mut registry, None, false);
    let ctx = ToolContext::new(dir.path());
    let out = registry
        .get("lsp_definition")
        .unwrap()
        .call(&ctx, json!({"path":"src/main.rs","line":6,"column":15}))
        .await
        .unwrap();
    let text = text_of(&out);
    assert!(!out.is_error, "{text}");
    assert!(
        text.contains("src/main.rs:1:4  fn helper() -> u32 {"),
        "{text}"
    );
}
