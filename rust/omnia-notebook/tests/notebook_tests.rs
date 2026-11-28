use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;
use omnia_notebook::{
    chunk_text_semantically, decode_text_safely, is_likely_binary, is_streamable_media_mime,
    normalize_drive_filename_suffix, parse_canonical_origin, parse_http_byte_range,
    requires_forced_attachment, sanitize_transport_filename, sha256_slices_hex,
    strip_local_path_fields, synthesize_audio_overview_wav, validate_xml_safety, AuthCircuitState,
    BridgeDirection, BridgeTransferRequest, ChatSettings, ContextualAskPreset,
    CreateNotebookRequest, CreateQuoteCardRequest, DispatchRequest, EffortLevel,
    GenerateArtifactRequest, HealStage, HttpByteRangeError, IngestSourceRequest, IngestionStage,
    InteractionSurface, NotebookEngine, NotebookError, NotebookLlmConfig, PdfClassification,
    PreviewContent, PreviewFormat, RecordTurnRequest, RemoteSyncItem, RepoPackageConfig,
    SelectionAction, SourceFilter, SourceKind, SourceRegistrationInput, StudioArtifactKind,
    VisibleHandoffStatus, AUTH_CHALLENGE_CODE, AUTH_CHALLENGE_HTTP_STATUS, CRATE_NAME,
    MANUAL_VISIBLE_BROWSER_ONLY, MAX_BINARY_PREVIEW_BYTES, MAX_CHAT_CUSTOM_PROMPT_CHARS,
    MAX_CHUNK_BYTES, MAX_COPIED_TEXT_BYTES, MAX_TRANSPORT_FILENAME_LEN, MAX_XML_BYTES,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Barrier;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "omnia-notebook-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        Self { path: dir }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            writer.start_file(*name, opts).expect("start zip entry");
            writer.write_all(data).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

fn build_synthetic_docx(paragraph: &str, table_header: (&str, &str), table_row: (&str, &str)) -> Vec<u8> {
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>"#,
        table_header.0, table_header.1, table_row.0, table_row.1
    );
    build_zip(&[("word/document.xml", xml.as_bytes())])
}

fn build_synthetic_xlsx() -> Vec<u8> {
    let workbook = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="QuarterlyMetrics" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
    let shared_strings = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Quarter</t></si>
  <si><t>LatencyMs</t></si>
  <si><t>Q4-2026</t></si>
</sst>"#;
    let sheet1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2"><v>42</v></c>
    </row>
  </sheetData>
</worksheet>"#;
    build_zip(&[
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/sharedStrings.xml", shared_strings.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet1.as_bytes()),
    ])
}

fn build_synthetic_pptx() -> Vec<u8> {
    let slide1 = r#"<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Atelier Studio Architecture</a:t></a:r></a:p>
    <a:p><a:r><a:t>Native Rust zero-unsafe core</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    let slide2 = r#"<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>BM25F Citation Grounding</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>"#;
    build_zip(&[
        ("ppt/slides/slide2.xml", slide2.as_bytes()),
        ("ppt/slides/slide1.xml", slide1.as_bytes()),
    ])
}

fn build_synthetic_pdf_flate(text_line: &str) -> Vec<u8> {
    let content_stream = format!("BT /F1 12 Tf 72 720 Td ({text_line}) Tj ET\n");
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(content_stream.as_bytes()).expect("zlib write");
    let compressed = enc.finish().expect("zlib finish");

    let mut pdf = Vec::new();
    pdf.extend_from_slice(b"%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Filter /FlateDecode /Length ");
    pdf.extend_from_slice(compressed.len().to_string().as_bytes());
    pdf.extend_from_slice(b" >>\nstream\n");
    pdf.extend_from_slice(&compressed);
    pdf.extend_from_slice(b"\nendstream\nendobj\n%%EOF\n");
    pdf
}

fn build_synthetic_tar_gz(filename: &str, payload: &[u8]) -> Vec<u8> {
    let mut tar = vec![0u8; 512];
    tar[..filename.len()].copy_from_slice(filename.as_bytes());
    let size_oct = format!("{:011o}\0", payload.len());
    tar[124..136].copy_from_slice(size_oct.as_bytes());
    tar[156] = b'0';
    tar.extend_from_slice(payload);
    let pad = (512 - (payload.len() % 512)) % 512;
    tar.extend(std::iter::repeat_n(0u8, pad));
    tar.extend(std::iter::repeat_n(0u8, 1024));

    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&tar).expect("gz write");
    gz.finish().expect("gz finish")
}

fn make_batchexecute_chunk(envelopes: Value) -> String {
    let s = serde_json::to_string(&envelopes).expect("serialize envelope");
    format!("{}\n{s}\n", s.len())
}

fn sample_gemini_share_payload() -> String {
    let mut prompt_node = vec![Value::Null; 16];
    prompt_node[0] = json!(["Explain WAL durability in Omnia SQLite storage.", null, null, null, []]);
    prompt_node[8] = Value::Bool(false);
    prompt_node[15] = json!([]);

    let mut draft = vec![Value::Null; 38];
    draft[0] = Value::String("rc_resp_1".to_string());
    draft[1] = json!(["Omnia uses `winsqlite3` WAL mode with `synchronous=NORMAL` and Win32 `LockFileEx` leases."]);
    draft[2] = json!([null, [[ [0, 40], [["https://example.org/wal?utm_source=tracker", "SQLite WAL Docs", "Write-Ahead Logging", "SQLite"]] ]]]);
    draft[37] = json!([null, [["search", "Google", "Checking SQLite WAL", "Verified WAL checkpointing.", []]]]);

    let mut resp_node = vec![Value::Null; 15];
    resp_node[0] = Value::Array(vec![Value::Array(draft)]);
    resp_node[1] = json!(["sqlite wal synchronous normal"]);
    resp_node[14] = Value::String("m-4-hydrogen".to_string());

    let turn = json!([["conv_1", "turn_1"], null, prompt_node, resp_node]);
    let root = json!([[null, [turn], ["conv_1", "Omnia SQLite WAL Research"], "share1234abcd", [1731600000, 0]]]);
    let root_str = serde_json::to_string(&root).expect("serialize root");
    let model_map_str = serde_json::to_string(&json!({"m-4-hydrogen": "Gemini 4 Hydrogen"})).expect("serialize model map");

    format!(
        ")]}}'\n\n{}{}",
        make_batchexecute_chunk(json!([["wrb.fr", "otAQ7b", model_map_str, null, null, null, "generic"]])),
        make_batchexecute_chunk(json!([["wrb.fr", "ujx1Bf", root_str, null, null, null, "generic"]]))
    )
}

fn create_test_notebook(engine: &NotebookEngine, title: &str, max_sources: usize) -> String {
    engine
        .create_notebook(CreateNotebookRequest {
            title: title.to_string(),
            description: "Integration test notebook".to_string(),
            allow_overflow_notebook: false,
            max_sources,
            model_id: "gemini-4-hydrogen".to_string(),
            effort_level: "high".to_string(),
        })
        .expect("create notebook")
        .notebook_id
}

#[test]
fn wal_persistence_reopen_and_engine_status() {
    let temp = TempDirGuard::new("wal");
    let db_path = temp.path.join("atelier.db");

    let nb_id = {
        let engine = NotebookEngine::open(&db_path).expect("open persistent WAL engine");
        let status = engine.status().expect("engine status");
        assert_eq!(status.crate_name, CRATE_NAME);
        assert_eq!(status.journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(status.circuit_breaker.state, AuthCircuitState::Closed);

        let nb_id = create_test_notebook(&engine, "Persistent Research Notebook", 10);
        engine
            .ingest_source(IngestSourceRequest {
                notebook_id: nb_id.clone(),
                title: Some("Architecture Overview".to_string()),
                filename: "arch.md".to_string(),
                mime_type: None,
                remote_id: Some("rem_arch_01".to_string()),
                bytes: b"# Overview\nNative Rust WAL store persists across restarts.".to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: json!({}),
            })
            .expect("ingest source");
        nb_id
    };

    // Reopen the exact same WAL SQLite file and verify durability.
    let reopened = NotebookEngine::open(&db_path).expect("reopen persistent WAL engine");
    let nb = reopened.get_notebook(&nb_id).expect("persisted notebook exists");
    assert_eq!(nb.title, "Persistent Research Notebook");
    let sources = reopened
        .list_sources(&nb_id, &SourceFilter::default())
        .expect("list persisted sources");
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].remote_id.as_deref(), Some("rem_arch_01"));
    assert_eq!(
        sha256_slices_hex(&[b"omnia", b"-notebook"]),
        omnia_core::sha256_hex(b"omnia-notebook")
    );
    assert_eq!(
        parse_canonical_origin("https://share.gemini.google/abcd1234").expect("origin"),
        "https://share.gemini.google"
    );
}

#[test]
fn sha256_intra_and_cross_batch_dedup_and_overflow_disallow() {
    let engine = NotebookEngine::open_in_memory().expect("open memory engine");

    // Attempting to enable overflow notebooks must be strictly rejected.
    let overflow_create = engine.create_notebook(CreateNotebookRequest {
        title: "Forbidden Overflow".to_string(),
        description: String::new(),
        allow_overflow_notebook: true,
        max_sources: 5,
        model_id: "gemini-3.5-flash-lite".to_string(),
        effort_level: "low".to_string(),
    });
    assert!(matches!(
        overflow_create,
        Err(NotebookError::PolicyBlocked {
            code: "OVERFLOW_NOTEBOOK_FORBIDDEN",
            ..
        })
    ));

    let nb_id = create_test_notebook(&engine, "Dedup & Cap Test", 2);

    // Batch 1 contains an intra-batch SHA-256 duplicate.
    let batch1 = engine
        .register_source_batch(
            &nb_id,
            vec![
                SourceRegistrationInput {
                    notebook_id: nb_id.clone(),
                    remote_id: None,
                    title: "Spec A".to_string(),
                    filename: "spec_a.md".to_string(),
                    mime_type: None,
                    source_kind_override: None,
                    raw_bytes: b"Identical payload bytes for dedup".to_vec(),
                    chunks: vec![("H".to_string(), "Identical payload bytes for dedup".to_string())],
                    ingestion_stage: "stage4_semantic_chunk".to_string(),
                    provenance: "EXTRACTED".to_string(),
                    metadata: json!({}),
                },
                SourceRegistrationInput {
                    notebook_id: nb_id.clone(),
                    remote_id: None,
                    title: "Spec A Copy".to_string(),
                    filename: "spec_a_copy.md".to_string(),
                    mime_type: None,
                    source_kind_override: None,
                    raw_bytes: b"Identical payload bytes for dedup".to_vec(),
                    chunks: vec![("H".to_string(), "Identical payload bytes for dedup".to_string())],
                    ingestion_stage: "stage4_semantic_chunk".to_string(),
                    provenance: "EXTRACTED".to_string(),
                    metadata: json!({}),
                },
            ],
        )
        .expect("batch 1");
    assert_eq!(batch1.inserted.len(), 1);
    assert_eq!(batch1.intra_batch_duplicates, 1);
    assert_eq!(batch1.cross_batch_duplicates, 0);

    // Batch 2 re-submits the exact same bytes (cross-batch dedup) plus one new source.
    let batch2 = engine
        .register_source_batch(
            &nb_id,
            vec![
                SourceRegistrationInput {
                    notebook_id: nb_id.clone(),
                    remote_id: None,
                    title: "Spec A Reupload".to_string(),
                    filename: "reupload.md".to_string(),
                    mime_type: None,
                    source_kind_override: None,
                    raw_bytes: b"Identical payload bytes for dedup".to_vec(),
                    chunks: vec![("H".to_string(), "Identical payload bytes for dedup".to_string())],
                    ingestion_stage: "stage4_semantic_chunk".to_string(),
                    provenance: "EXTRACTED".to_string(),
                    metadata: json!({}),
                },
                SourceRegistrationInput {
                    notebook_id: nb_id.clone(),
                    remote_id: None,
                    title: "Spec B".to_string(),
                    filename: "spec_b.md".to_string(),
                    mime_type: None,
                    source_kind_override: None,
                    raw_bytes: b"Second unique source content".to_vec(),
                    chunks: vec![("H".to_string(), "Second unique source content".to_string())],
                    ingestion_stage: "stage4_semantic_chunk".to_string(),
                    provenance: "EXTRACTED".to_string(),
                    metadata: json!({}),
                },
            ],
        )
        .expect("batch 2");
    assert_eq!(batch2.inserted.len(), 1);
    assert_eq!(batch2.cross_batch_duplicates, 1);

    // Adding a 3rd unique source exceeds `max_sources = 2` and fails with `OverflowDisallowed`.
    let overflow = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: Some("Spec C".to_string()),
        filename: "spec_c.md".to_string(),
        mime_type: None,
        remote_id: None,
        bytes: b"Third unique content exceeding cap".to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        overflow,
        Err(NotebookError::OverflowDisallowed {
            current: 2,
            max: 2,
            ..
        })
    ));
}

#[test]
fn collision_proof_source_id_rejects_duplicate_title_ambiguity_and_filters_media() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Identity & Filters", 10);

    let s1 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Design Specification".to_string()),
            filename: "design_v1.md".to_string(),
            mime_type: None,
            remote_id: Some("remote_v1".to_string()),
            bytes: b"# Design\nVersion 1 architecture notes.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("s1")
        .source;

    let s2 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Design Specification".to_string()),
            filename: "design_v2.md".to_string(),
            mime_type: None,
            remote_id: Some("remote_v2".to_string()),
            bytes: b"# Design\nVersion 2 updated architecture notes.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("s2")
        .source;

    // Duplicate title lookup MUST reject ambiguously and list both source IDs.
    let amb = engine.resolve_citation(&nb_id, "Design Specification");
    match amb {
        Err(NotebookError::AmbiguousCitation {
            title,
            matching_source_ids,
        }) => {
            assert_eq!(title, "Design Specification");
            assert_eq!(matching_source_ids.len(), 2);
            assert!(matching_source_ids.contains(&s1.source_id));
            assert!(matching_source_ids.contains(&s2.source_id));
        }
        other => panic!("expected AmbiguousCitation, got {other:?}"),
    }

    // Immutable `source_id` and `remote_id` ALWAYS resolve unambiguously.
    let r1 = engine
        .resolve_citation(&nb_id, &s1.source_id)
        .expect("resolve by source_id");
    assert_eq!(r1.source_id, s1.source_id);
    assert_eq!(r1.resolved_via, "source_id");

    let r2 = engine
        .resolve_citation(&nb_id, "remote_v2")
        .expect("resolve by remote_id");
    assert_eq!(r2.source_id, s2.source_id);
    assert_eq!(r2.resolved_via, "remote_id");

    // Ingest a video and an image to verify `exclude_videos` and `pure_documents_only`.
    engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Demo Video".to_string()),
            filename: "demo.mp4".to_string(),
            mime_type: Some("video/mp4".to_string()),
            remote_id: None,
            bytes: b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("video");

    engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Architecture PNG".to_string()),
            filename: "diagram.png".to_string(),
            mime_type: Some("image/png".to_string()),
            remote_id: None,
            bytes: b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x01\x00\x00\x00\x00\x80".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("png");

    let all = engine.list_sources(&nb_id, &SourceFilter::default()).expect("all");
    assert_eq!(all.len(), 4);

    let no_videos = engine
        .list_sources(
            &nb_id,
            &SourceFilter {
                exclude_videos: true,
                ..Default::default()
            },
        )
        .expect("no videos");
    assert_eq!(no_videos.len(), 3);
    assert!(no_videos.iter().all(|s| !s.is_video));

    let pure_docs = engine
        .list_sources(
            &nb_id,
            &SourceFilter {
                pure_documents_only: true,
                ..Default::default()
            },
        )
        .expect("pure docs");
    assert_eq!(pure_docs.len(), 2);
    assert!(pure_docs.iter().all(|s| s.source_kind == SourceKind::Document));
}

#[test]
fn clear_sources_strictly_preserves_studio_artifacts_chat_turns_and_btw_threads() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Clear Sources Preservation", 10);

    let src = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Core Paper".to_string()),
            filename: "paper.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# Abstract\nOmnia Atelier Research Studio achieves strict provenance.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("ingest")
        .source;

    let turn = engine
        .record_turn(RecordTurnRequest {
            notebook_id: nb_id.clone(),
            surface: InteractionSurface::Notebook,
            prompt_text: "Summarize the paper".to_string(),
            response_markdown: format!("Strict provenance is enforced [{}:0].", src.source_id),
            model_id: "gemini-4-hydrogen".to_string(),
            effort: EffortLevel::Medium,
            quotes: vec![],
            citations: vec![format!("[{}:0]", src.source_id)],
        })
        .expect("record turn");

    let quote_card = engine
        .create_quote_card(CreateQuoteCardRequest {
            notebook_id: nb_id.clone(),
            surface: InteractionSurface::Notebook,
            anchor_turn_id: turn.turn_id.clone(),
            source_id: Some(src.source_id.clone()),
            excerpt: "Strict provenance is enforced".to_string(),
            char_start: 0,
            char_end: 29,
        })
        .expect("quote");
    let _btw = engine
        .create_btw_thread(quote_card.quote, "What does provenance verify?")
        .expect("btw");

    let _artifact = engine
        .generate_artifact(GenerateArtifactRequest {
            notebook_id: nb_id.clone(),
            kind: StudioArtifactKind::Briefing,
            title: Some("Saved Briefing".to_string()),
            source_ids: None,
            focus_prompt: None,
        })
        .expect("generate briefing");

    let receipt = engine.clear_sources(&nb_id).expect("clear sources");
    assert_eq!(receipt.removed_sources, 1);
    assert_eq!(receipt.removed_chunks, 1);
    assert_eq!(receipt.preserved_artifacts, 1);
    assert_eq!(receipt.preserved_turns, 1);
    assert_eq!(receipt.preserved_btw_threads, 1);

    assert!(engine
        .list_sources(&nb_id, &SourceFilter::default())
        .expect("sources empty")
        .is_empty());
    assert_eq!(engine.list_artifacts(&nb_id).expect("artifacts").len(), 1);
    assert_eq!(engine.list_turns(&nb_id).expect("turns").len(), 1);
    assert_eq!(engine.list_btw_threads(&nb_id).expect("btw").len(), 1);
}

#[test]
fn xxe_xml_cap_zip_bomb_entry_count_depth_and_zip_slip_are_rejected() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Security Guards", 10);

    // 1. Direct XXE in XML and SVG.
    let xxe_xml = br#"<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>"#;
    let err = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: None,
        filename: "evil.xml".to_string(),
        mime_type: None,
        remote_id: None,
        bytes: xxe_xml.to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        err,
        Err(NotebookError::SecurityRejected {
            code: "XXE_REJECTED",
            ..
        })
    ));

    // 2. XXE embedded inside DOCX `word/document.xml`.
    let evil_docx = build_zip(&[("word/document.xml", xxe_xml)]);
    let err_docx = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: None,
        filename: "evil.docx".to_string(),
        mime_type: None,
        remote_id: None,
        bytes: evil_docx,
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        err_docx,
        Err(NotebookError::SecurityRejected {
            code: "XXE_REJECTED",
            ..
        })
    ));

    // 3. Zip bomb (>100x expansion ratio: 400 KiB of zeros compresses to ~500 bytes -> ~800x ratio!).
    let zeroes = vec![b'A'; 400 * 1024];
    let zip_bomb = build_zip(&[("word/document.xml", &zeroes)]);
    assert!(zip_bomb.len() < 3_000, "sanity check high compression ratio");
    let err_bomb = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: None,
        filename: "bomb.docx".to_string(),
        mime_type: None,
        remote_id: None,
        bytes: zip_bomb,
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        err_bomb,
        Err(NotebookError::SecurityRejected {
            code: "ZIP_BOMB_RATIO_EXCEEDED",
            ..
        })
    ));

    // 4. Archive exceeding 1,000 entries.
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut w = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for i in 0..1_005 {
            w.start_file(format!("f_{i}.txt"), opts).expect("entry");
            w.write_all(b"x").expect("write");
        }
        w.finish().expect("finish");
    }
    let err_entries = engine.preview_bytes("many.zip", None, &cursor.into_inner());
    assert!(matches!(
        err_entries,
        Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
            ..
        })
    ));

    // 5. Zip-slip traversal (`../escape.txt`).
    let zip_slip = build_zip(&[("../escape.txt", b"nope")]);
    let err_slip = engine.preview_bytes("slip.zip", None, &zip_slip);
    assert!(matches!(
        err_slip,
        Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_PATH_TRAVERSAL",
            ..
        })
    ));

    // 6. Archive nesting depth > 5 (true 6-level recursive ZIP caught automatically at depth 0!).
    let mut nested = build_zip(&[("leaf.txt", b"hello")]);
    for lvl in 0..6 {
        nested = build_zip(&[(format!("layer_{lvl}.zip").as_str(), &nested)]);
    }
    let err_depth = engine.preview_bytes("deep_nested.zip", None, &nested);
    assert!(matches!(
        err_depth,
        Err(NotebookError::SecurityRejected {
            code: "ARCHIVE_DEPTH_EXCEEDED",
            ..
        })
    ));

    // 7. UTF-16LE NUL-padded XXE + XML byte cap + disallowed MIME + disallowed executable extension.
    let utf16_xxe: Vec<u8> = "<!ENTITY x SYSTEM \"file:///etc/passwd\">"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert!(matches!(
        validate_xml_safety(&utf16_xxe, "utf16.xml"),
        Err(NotebookError::SecurityRejected {
            code: "XXE_REJECTED",
            ..
        })
    ));
    assert!(matches!(
        omnia_notebook::validate_xml_safety_with_limit(b"<root>oversized</root>", 8, "cap.xml"),
        Err(NotebookError::SecurityRejected {
            code: "XML_SIZE_LIMIT_EXCEEDED",
            ..
        })
    ));
    let err_mime = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: None,
        filename: "note.txt".to_string(),
        mime_type: Some("application/x-msdownload".to_string()),
        remote_id: None,
        bytes: b"hello".to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        err_mime,
        Err(NotebookError::SecurityRejected {
            code: "DISALLOWED_MIME_TYPE",
            ..
        })
    ));
    let err_exe = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id,
        title: None,
        filename: "payload.exe".to_string(),
        mime_type: None,
        remote_id: None,
        bytes: b"MZ".to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        err_exe,
        Err(NotebookError::SecurityRejected {
            code: "DISALLOWED_EXTENSION",
            ..
        })
    ));
    assert_eq!(MAX_XML_BYTES, 128 * 1024 * 1024);
    assert!(validate_xml_safety(b"<root>ok</root>", "ok.xml").is_ok());
}

#[test]
fn synthetic_docx_xlsx_pptx_csv_ipynb_pdf_code_repo_and_rollback_ingestion() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Multi-Format Ingestion", 20);

    // 1. Synthetic DOCX (paragraph + table).
    let docx_bytes = build_synthetic_docx(
        "Omnia Native Rust DOCX extraction",
        ("Component", "Status"),
        ("Notebook", "Verified"),
    );
    let docx_res = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("DOCX Report".to_string()),
            filename: "report.docx".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: docx_bytes,
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("docx ingest");
    let docx_chunks = engine
        .store()
        .list_chunks_for_source(&docx_res.source.source_id)
        .expect("docx chunks");
    assert!(docx_chunks[0].body.contains("Omnia Native Rust DOCX extraction"));
    assert!(docx_chunks[0].body.contains("| Component | Status |"));
    assert!(docx_chunks[0].body.contains("| Notebook | Verified |"));

    // 2. Synthetic XLSX (sharedStrings + workbook).
    let xlsx_res = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Metrics Sheet".to_string()),
            filename: "metrics.xlsx".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: build_synthetic_xlsx(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("xlsx ingest");
    let xlsx_chunks = engine
        .store()
        .list_chunks_for_source(&xlsx_res.source.source_id)
        .expect("xlsx chunks");
    assert!(xlsx_chunks[0].body.contains("## QuarterlyMetrics"));
    assert!(xlsx_chunks[0].body.contains("Q4-2026"));
    assert!(xlsx_chunks[0].body.contains("42"));

    // 3. Synthetic PPTX (numeric slide ordering).
    let pptx_res = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Deck".to_string()),
            filename: "deck.pptx".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: build_synthetic_pptx(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("pptx ingest");
    let pptx_chunks = engine
        .store()
        .list_chunks_for_source(&pptx_res.source.source_id)
        .expect("pptx chunks");
    let pptx_full: String = pptx_chunks.iter().map(|c| c.body.as_str()).collect::<Vec<_>>().join("\n");
    assert!(pptx_full.find("Slide 1").unwrap() < pptx_full.find("Slide 2").unwrap());

    // 4. CSV with quoted commas.
    let csv_res = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("CSV Table".to_string()),
            filename: "table.csv".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"Name,Notes\n\"Alpha, Inc\",\"Fast, safe\"\n".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("csv ingest");
    let csv_chunks = engine
        .store()
        .list_chunks_for_source(&csv_res.source.source_id)
        .expect("csv chunks");
    assert!(csv_chunks[0].body.contains("Alpha, Inc"));

    // 5. Jupyter IPYNB.
    let ipynb = json!({
        "cells": [
            {"cell_type": "markdown", "source": ["# Experiment\n", "Testing BM25F"]},
            {"cell_type": "code", "source": ["print(2 + 2)\n"], "outputs": [{"text": ["4\n"]}]}
        ]
    });
    let ipynb_res = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Analysis Notebook".to_string()),
            filename: "analysis.ipynb".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: serde_json::to_vec(&ipynb).expect("ipynb json"),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("ipynb ingest");
    let ipynb_chunks = engine
        .store()
        .list_chunks_for_source(&ipynb_res.source.source_id)
        .expect("ipynb chunks");
    assert!(ipynb_chunks.iter().any(|c| c.body.contains("print(2 + 2)")));

    // 6. Readable FlateDecode PDF + Encrypted PDF rejection.
    let pdf_res = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Readable PDF".to_string()),
            filename: "whitepaper.pdf".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: build_synthetic_pdf_flate("Pure Rust FlateDecode PDF Extraction"),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("pdf ingest");
    let pdf_chunks = engine
        .store()
        .list_chunks_for_source(&pdf_res.source.source_id)
        .expect("pdf chunks");
    assert!(pdf_chunks[0].body.contains("Pure Rust FlateDecode PDF Extraction"));

    let encrypted_pdf = b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Encrypt 5 0 R >>\n%%EOF\n";
    let enc_err = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: Some("Locked PDF".to_string()),
        filename: "locked.pdf".to_string(),
        mime_type: None,
        remote_id: None,
        bytes: encrypted_pdf.to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        enc_err,
        Err(NotebookError::SecurityRejected {
            code: "ENCRYPTED_PDF",
            ..
        })
    ));

    // 7. Code-repository-to-Markdown packager (respects .gitignore, skips binaries & forbidden cookies).
    let repo_dir = TempDirGuard::new("repo");
    fs::write(repo_dir.path.join(".gitignore"), "ignored_out/\n").expect("gitignore");
    fs::create_dir_all(repo_dir.path.join("src")).expect("src dir");
    fs::create_dir_all(repo_dir.path.join("ignored_out")).expect("ignored dir");
    fs::write(repo_dir.path.join("src/b_mod.rs"), "pub fn b() -> u32 { 2 }\n").expect("b_mod");
    fs::write(repo_dir.path.join("src/a_mod.rs"), "pub fn a() -> u32 { 1 }\n").expect("a_mod");
    fs::write(repo_dir.path.join("ignored_out/skip.rs"), "should be ignored").expect("ignored");
    fs::write(repo_dir.path.join("binary.dat"), [0u8, 1, 2, 0, 255]).expect("binary");
    fs::write(repo_dir.path.join("canary_cookies.db"), b"forbidden").expect("cookie file");

    let (repo_outcome, packaged) = engine
        .ingest_code_repository(
            &nb_id,
            &repo_dir.path,
            None,
            &RepoPackageConfig::for_workspace_root(&repo_dir.path),
        )
        .expect("package repo");
    assert_eq!(packaged.included_files, vec!["src/a_mod.rs", "src/b_mod.rs"]);
    assert_eq!(packaged.skipped_binary_files, vec!["binary.dat"]);
    assert!(!packaged.markdown.contains("canary_cookies"));
    assert!(!packaged.markdown.contains("should be ignored"));
    assert!(repo_outcome.chunk_count >= 1);

    // 8. Stage 4 (`<= 120 KiB` chunker) + Stage 5 (`<= 40 KiB` copied-text fallback) + Multi-part sibling rollback.
    let large_fallback = "alpha beta gamma delta ".repeat(2_600); // ~60 KiB > 40 KiB
    let fb_outcome = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Scanned PDF Fallback".to_string()),
            filename: "scanned.pdf".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF\n".to_vec(),
            copied_text_fallback: Some(large_fallback),
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("copied-text fallback");
    assert_eq!(fb_outcome.stage_completed, IngestionStage::Stage5CopiedTextFallback);
    assert_eq!(fb_outcome.source.source_kind, SourceKind::CopiedText);
    let fb_chunks = engine
        .store()
        .list_chunks_for_source(&fb_outcome.source.source_id)
        .expect("fb chunks");
    assert!(fb_chunks.len() >= 2);
    assert!(fb_chunks.iter().all(|c| c.byte_size <= MAX_COPIED_TEXT_BYTES));

    // Verify `<= 120 KiB` semantic chunking cap.
    let big_md = format!("# Big\n\n{}", "word ".repeat(35_000));
    let sem_chunks = omnia_notebook::chunk_text_semantically(&big_md, MAX_CHUNK_BYTES);
    assert!(sem_chunks.len() >= 2);
    assert!(sem_chunks.iter().all(|(_, body)| body.len() <= MAX_CHUNK_BYTES));

    // Multi-part rollback: part 0 succeeds, part 1 fails (encrypted PDF) -> part 0 MUST be rolled back!
    let count_before = engine
        .list_sources(&nb_id, &SourceFilter::default())
        .expect("before")
        .len();
    let rollback_err = engine.ingest_multipart_with_rollback(
        &nb_id,
        vec![
            IngestSourceRequest {
                notebook_id: nb_id.clone(),
                title: Some("Sibling Part 1".to_string()),
                filename: "part1.md".to_string(),
                mime_type: None,
                remote_id: None,
                bytes: b"# Part 1\nWill be rolled back atomically.".to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: json!({}),
            },
            IngestSourceRequest {
                notebook_id: nb_id.clone(),
                title: Some("Sibling Part 2 Bad".to_string()),
                filename: "part2.pdf".to_string(),
                mime_type: None,
                remote_id: None,
                bytes: encrypted_pdf.to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: json!({}),
            },
        ],
    );
    assert!(matches!(
        rollback_err,
        Err(NotebookError::IngestionFailed {
            rolled_back_siblings: 1,
            ..
        })
    ));
    let count_after = engine
        .list_sources(&nb_id, &SourceFilter::default())
        .expect("after")
        .len();
    assert_eq!(count_before, count_after);

    // Stage 6 heal sweep runs cleanly on healthy sources.
    let heal = engine.heal_sources(&nb_id).expect("heal sweep");
    assert_eq!(heal.inspected, count_after);
    assert_eq!(heal.already_healthy, count_after);
}

#[test]
fn rich_preview_service_covers_all_17_formats_and_forces_html_svg_attachment() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");

    // 1. PDF (including encrypted classification)
    let pdf_enc = engine
        .preview_bytes(
            "secret.pdf",
            None,
            b"%PDF-1.7\n1 0 obj << /Type /Page >> endobj\ntrailer << /Encrypt 2 0 R >>\n%%EOF\n",
        )
        .expect("pdf preview");
    assert_eq!(pdf_enc.format, PreviewFormat::Pdf);
    assert_eq!(pdf_enc.headers.x_content_type_options, "nosniff");
    assert!(matches!(
        pdf_enc.content,
        PreviewContent::PdfSummary {
            classification: PdfClassification::Encrypted,
            is_encrypted: true,
            ..
        }
    ));

    // 2. XLSX spreadsheet grid
    let xlsx = engine
        .preview_bytes("sheet.xlsx", None, &build_synthetic_xlsx())
        .expect("xlsx preview");
    assert_eq!(xlsx.format, PreviewFormat::SpreadsheetGrid);

    // 3. CSV/TSV delimited table
    let csv = engine
        .preview_bytes("data.tsv", None, b"A\tB\n1\t2\n")
        .expect("tsv preview");
    assert_eq!(csv.format, PreviewFormat::DelimitedTable);

    // 4. DOCX word doc
    let docx = engine
        .preview_bytes(
            "doc.docx",
            None,
            &build_synthetic_docx("Hello DOCX", ("K", "V"), ("1", "2")),
        )
        .expect("docx preview");
    assert_eq!(docx.format, PreviewFormat::WordDocument);

    // 5. PPTX presentation deck
    let pptx = engine
        .preview_bytes("slides.pptx", None, &build_synthetic_pptx())
        .expect("pptx preview");
    assert_eq!(pptx.format, PreviewFormat::PresentationDeck);

    // 6. EPUB book
    let epub = engine
        .preview_bytes(
            "book.epub",
            None,
            &build_zip(&[("OEBPS/ch1.xhtml", b"<html><body><h1>Chapter 1</h1><p>Text</p></body></html>")]),
        )
        .expect("epub preview");
    assert_eq!(epub.format, PreviewFormat::EpubBook);

    // 7. ODT document
    let odt = engine
        .preview_bytes(
            "notes.odt",
            None,
            &build_zip(&[("content.xml", b"<office:document-content><text:p>ODT body</text:p></office:document-content>")]),
        )
        .expect("odt preview");
    assert_eq!(odt.format, PreviewFormat::OpenDocumentText);

    // 8. RTF rich text
    let rtf = engine
        .preview_bytes("memo.rtf", None, br"{\rtf1\ansi{\fonttbl\f0 Arial;}Hello \b RTF\b0\par World}")
        .expect("rtf preview");
    assert_eq!(rtf.format, PreviewFormat::RichText);

    // 9. IPYNB notebook cells
    let ipynb = engine
        .preview_bytes(
            "nb.ipynb",
            None,
            br#"{"cells":[{"cell_type":"code","source":["x = 1"],"outputs":[]}]}"#,
        )
        .expect("ipynb preview");
    assert_eq!(ipynb.format, PreviewFormat::JupyterNotebook);

    // 10. Archive tree (ZIP + TAR.GZ + JAR 60-class cap)
    let tgz = engine
        .preview_bytes("bundle.tar.gz", None, &build_synthetic_tar_gz("hello.txt", b"world"))
        .expect("tgz preview");
    assert_eq!(tgz.format, PreviewFormat::ArchiveTree);
    let mut jar_entries: Vec<(String, Vec<u8>)> = (0..65)
        .map(|i| (format!("pkg/Class{i}.class"), b"CAFE".to_vec()))
        .collect();
    let jar_refs: Vec<(&str, &[u8])> = jar_entries
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();
    let jar = engine
        .preview_bytes("lib.jar", None, &build_zip(&jar_refs))
        .expect("jar preview");
    jar_entries.clear();
    assert_eq!(jar.format, PreviewFormat::ArchiveTree);
    assert!(matches!(
        jar.content,
        PreviewContent::ArchiveTree {
            total_entries: 65,
            omitted_entries: 5,
            ..
        }
    ));

    // 11. Source code (65+ languages check)
    let code = engine
        .preview_bytes("main.rs", None, b"fn main() { println!(\"ok\"); }\n")
        .expect("rust preview");
    assert_eq!(code.format, PreviewFormat::SourceCode);
    assert_eq!(omnia_notebook::detect_code_language("schema.prisma"), Some("prisma"));
    assert_eq!(omnia_notebook::detect_code_language("shader.wgsl"), Some("wgsl"));
    assert_eq!(omnia_notebook::detect_code_language("Dockerfile"), Some("dockerfile"));

    // 12. Markdown
    let md = engine
        .preview_bytes("README.md", None, b"# Heading\nBody text")
        .expect("md preview");
    assert_eq!(md.format, PreviewFormat::Markdown);

    // 13. Structured data (JSON)
    let json_p = engine
        .preview_bytes("config.json", None, br#"{"service":"omnia","port":3000}"#)
        .expect("json preview");
    assert_eq!(json_p.format, PreviewFormat::StructuredData);

    // 14. HTML document -> MUST force `attachment` + `nosniff`!
    let html = engine
        .preview_bytes(
            "page.html",
            Some("text/html"),
            b"<html><script>alert(1)</script><body><p>Safe text</p></body></html>",
        )
        .expect("html preview");
    assert_eq!(html.format, PreviewFormat::HtmlDocument);
    assert_eq!(html.headers.x_content_type_options, "nosniff");
    assert!(html.headers.force_attachment);
    assert!(html.headers.content_disposition.starts_with("attachment;"));
    if let PreviewContent::Text { text, .. } = &html.content {
        assert!(!text.contains("alert(1)"));
        assert!(text.contains("Safe text"));
    } else {
        panic!("expected Text content for html preview");
    }

    // 15. SVG vector -> MUST force `attachment` + `nosniff` + reject XXE!
    let svg = engine
        .preview_bytes(
            "icon.svg",
            Some("image/svg+xml"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><title>Icon</title></svg>",
        )
        .expect("svg preview");
    assert_eq!(svg.format, PreviewFormat::SvgVector);
    assert_eq!(svg.headers.x_content_type_options, "nosniff");
    assert!(svg.headers.force_attachment);
    assert!(svg.headers.content_disposition.starts_with("attachment;"));

    let xxe_svg = engine.preview_bytes(
        "evil.svg",
        None,
        b"<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///c:/windows/win.ini\">]><svg>&x;</svg>",
    );
    assert!(matches!(
        xxe_svg,
        Err(NotebookError::SecurityRejected {
            code: "XXE_REJECTED",
            ..
        })
    ));

    // 16. Media asset metadata (PNG width/height parsed from IHDR)
    let mut png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];
    png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    png.extend_from_slice(&640u32.to_be_bytes());
    png.extend_from_slice(&480u32.to_be_bytes());
    let media = engine
        .preview_bytes("render.png", None, &png)
        .expect("png preview");
    assert_eq!(media.format, PreviewFormat::MediaAsset);
    assert!(matches!(
        media.content,
        PreviewContent::MediaMetadata { ref metadata }
            if metadata.width == Some(640) && metadata.height == Some(480)
    ));

    // 17. Binary 4 KiB hex + SHA-256 fallback
    let big_bin = vec![0xABu8; 8_192];
    let bin = engine
        .preview_bytes("dump.bin", Some("application/octet-stream"), &big_bin)
        .expect("bin preview");
    assert_eq!(bin.format, PreviewFormat::BinaryHexFallback);
    assert!(bin.headers.force_attachment);
    assert_eq!(bin.headers.x_content_type_options, "nosniff");
    assert!(matches!(
        bin.content,
        PreviewContent::BinaryHex {
            preview_bytes: MAX_BINARY_PREVIEW_BYTES,
            total_bytes: 8_192,
            ..
        }
    ));
}

#[test]
fn bm25f_grounded_citation_retrieval_verifier_and_all_9_studio_artifacts() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Grounded Research Studio", 10);

    let s1 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Routing Spec".to_string()),
            filename: "routing.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# Circuit Breaker\nThe dynamic provider router trips after rate-limit cooldown and enforces quota reservation."
                .to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("s1")
        .source;

    let s2 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Storage Spec".to_string()),
            filename: "storage.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# SQLite WAL\nLuu tru SQLite WAL su dung khoa doc quyen Win32 LockFileEx.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("s2")
        .source;

    // Bilingual Vietnamese query with diacritics folds cleanly onto `storage.md`!
    let pack = engine
        .build_grounded_prompt(
            &nb_id,
            "Kiến trúc lưu trữ SQLite WAL và định tuyến hạn mức hoạt động thế nào?",
            &SourceFilter::default(),
            6,
        )
        .expect("grounded pack");
    assert!(!pack.evidence.is_empty());
    assert!(pack.evidence.iter().any(|e| e.source_id == s2.source_id));
    assert!(!pack.memory_links.is_empty());
    assert!(pack.graphify_entity_count >= 2);
    assert!(pack.assembled_context.contains(&format!("[{}:0]", s2.source_id)));

    // Strict citation verifier: valid answer passes; hallucinated source ID fails.
    let valid_answer = format!(
        "Router uses quota reservation [{}:0] while storage enforces WAL leases [{}:0].",
        s1.source_id, s2.source_id
    );
    let report_ok = engine
        .verify_citations(&nb_id, &valid_answer)
        .expect("verify ok");
    assert!(report_ok.valid);
    assert_eq!(report_ok.verified_citations.len(), 2);
    assert!(report_ok.invalid_citations.is_empty());

    let bad_answer = format!(
        "Claim backed by [{}:0] and hallucinated [src_nonexistent:99].",
        s1.source_id
    );
    let report_bad = engine
        .verify_citations(&nb_id, &bad_answer)
        .expect("verify bad");
    assert!(!report_bad.valid);
    assert_eq!(report_bad.invalid_citations.len(), 1);

    // Generate all 9 Studio Artifact kinds and verify persistence + rename + delete.
    let all_kinds = [
        StudioArtifactKind::Briefing,
        StudioArtifactKind::StudyGuide,
        StudioArtifactKind::Faq,
        StudioArtifactKind::Timeline,
        StudioArtifactKind::Quiz,
        StudioArtifactKind::Flashcards,
        StudioArtifactKind::MindMap,
        StudioArtifactKind::InfographicSpec,
        StudioArtifactKind::DataTable,
    ];
    let mut first_art_id = String::new();
    for kind in all_kinds {
        let art = engine
            .generate_artifact(GenerateArtifactRequest {
                notebook_id: nb_id.clone(),
                kind,
                title: None,
                source_ids: None,
                focus_prompt: Some("Omnia reliability".to_string()),
            })
            .expect("generate artifact");
        if first_art_id.is_empty() {
            first_art_id = art.artifact_id.clone();
        }
        assert_eq!(art.kind, kind);
        assert_eq!(art.cited_source_ids.len(), 2);
        if kind == StudioArtifactKind::MindMap {
            assert!(art.content_markdown.contains("```mermaid"));
            assert!(art.content_markdown.contains("flowchart TD"));
        }
    }
    assert_eq!(engine.list_artifacts(&nb_id).expect("list 9").len(), 9);
    let renamed = engine
        .rename_artifact(&first_art_id, "Executive Briefing v2")
        .expect("rename");
    assert_eq!(renamed.title, "Executive Briefing v2");
    assert!(engine.delete_artifact(&first_art_id).expect("delete"));
    assert_eq!(engine.list_artifacts(&nb_id).expect("list 8").len(), 8);
}

#[test]
fn unified_quote_btw_promote_and_bidirectional_cross_bridge() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Quote BTW Bridge", 10);

    let main_turn = engine
        .record_turn(RecordTurnRequest {
            notebook_id: nb_id.clone(),
            surface: InteractionSurface::Notebook,
            prompt_text: "Explain dual-queue dispatching".to_string(),
            response_markdown: "Gemini and Notebook queues run with isolated concurrency permits."
                .to_string(),
            model_id: "gemini-4-argon".to_string(),
            effort: EffortLevel::High,
            quotes: vec![],
            citations: vec![],
        })
        .expect("main turn");

    // 1. Strict `Quote` action -> structured composer quote card.
    let card = engine
        .create_quote_card(CreateQuoteCardRequest {
            notebook_id: nb_id.clone(),
            surface: InteractionSurface::Notebook,
            anchor_turn_id: main_turn.turn_id.clone(),
            source_id: None,
            excerpt: "isolated concurrency permits".to_string(),
            char_start: 35,
            char_end: 63,
        })
        .expect("quote card");
    assert_eq!(card.action, SelectionAction::Quote);
    assert!(card.markdown_blockquote.contains("> isolated concurrency permits"));

    // 2. Strict `BTW` action -> isolated side-thread (ZERO pollution to main `notebook_turns`!).
    let btw = engine
        .create_btw_thread(card.quote, "Does a blocked Gemini request pause Notebook?")
        .expect("btw thread");
    let btw = engine
        .append_btw_message(
            &btw.btw_id,
            "assistant",
            "No, each lane owns an independent Tokio semaphore.",
        )
        .expect("btw reply");
    assert_eq!(btw.messages.len(), 2);
    assert_eq!(
        engine.list_turns(&nb_id).expect("turns unchanged").len(),
        1,
        "BTW side-thread must NEVER pollute main notebook_turns"
    );

    // 3. `promote_btw_to_source` converts isolated BTW into an indexed source.
    let promoted = engine
        .promote_btw_to_source(&btw.btw_id, Some("Dual-Queue Isolation Insight"))
        .expect("promote btw");
    assert_eq!(promoted.source.source_kind, SourceKind::PromotedBtw);
    assert_eq!(
        promoted.thread.promoted_source_id.as_deref(),
        Some(promoted.source.source_id.as_str())
    );

    // 4. Bidirectional Cross-Bridge: Gemini -> Notebook AND Notebook -> Gemini.
    let g2n = engine
        .bridge_transfer(BridgeTransferRequest {
            notebook_id: nb_id.clone(),
            direction: BridgeDirection::GeminiToNotebook,
            title: "Gemini Research Finding".to_string(),
            content: "Rustls TLS avoids native OpenSSL drift on Windows.".to_string(),
            source_ids: vec![],
            remote_turn_id: Some("gem_turn_99".to_string()),
        })
        .expect("gemini to notebook");
    let bridged_src = g2n.created_source.expect("created source");
    assert_eq!(bridged_src.remote_id.as_deref(), Some("gem_turn_99"));

    let n2g = engine
        .bridge_transfer(BridgeTransferRequest {
            notebook_id: nb_id.clone(),
            direction: BridgeDirection::NotebookToGemini,
            title: "Handoff for Deep Synthesis".to_string(),
            content: "Compare these findings:".to_string(),
            source_ids: vec![promoted.source.source_id.clone(), bridged_src.source_id.clone()],
            remote_turn_id: None,
        })
        .expect("notebook to gemini");
    let handoff_prompt = n2g.gemini_handoff_prompt.expect("handoff prompt");
    assert!(handoff_prompt.contains(&format!("[{}:0]", promoted.source.source_id)));
    assert!(handoff_prompt.contains(&format!("[{}:0]", bridged_src.source_id)));
    assert_eq!(engine.list_bridge_events(&nb_id).expect("bridge log").len(), 2);
}

#[tokio::test]
async fn dual_queue_dispatcher_runs_gemini_and_notebook_in_true_parallel() {
    let engine = Arc::new(NotebookEngine::open_in_memory().expect("open engine"));
    let catalog = engine.dispatcher().model_catalog();
    assert!(catalog.iter().any(|m| m.model_id == "gemini-4-carbon"));

    // Both queues synchronize on a 2-party Barrier. If the dispatcher serialized them,
    // this test would deadlock (caught by timeout). Completing proves true parallel execution!
    let barrier = Arc::new(Barrier::new(2));

    let eng_g = Arc::clone(&engine);
    let bar_g = Arc::clone(&barrier);
    let gemini_task = tokio::spawn(async move {
        let req = DispatchRequest::new(
            InteractionSurface::Gemini,
            None,
            "Analyze parallel prompt",
            "gemini-4-hydrogen",
            EffortLevel::High,
        );
        eng_g
            .submit_gemini(req, move |r| async move {
                bar_g.wait().await;
                Ok((format!("Gemini handled: {}", r.prompt), vec![], json!({"lane": "gemini"})))
            })
            .await
    });

    let eng_n = Arc::clone(&engine);
    let bar_n = Arc::clone(&barrier);
    let notebook_task = tokio::spawn(async move {
        let req = DispatchRequest::new(
            InteractionSurface::Notebook,
            Some("nb_parallel".to_string()),
            "Ground notebook query",
            "gemini-3.5-flash-lite",
            EffortLevel::Low,
        );
        eng_n
            .submit_notebook(req, move |r| async move {
                bar_n.wait().await;
                Ok((
                    format!("Notebook grounded: {}", r.prompt),
                    vec!["[src_1:0]".to_string()],
                    json!({"lane": "notebook"}),
                ))
            })
            .await
    });

    let (g_res, n_res) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        async { tokio::join!(gemini_task, notebook_task) },
    )
    .await
    .expect("dual queues must execute concurrently without head-of-line blocking");

    let g_receipt = g_res.expect("join gemini").expect("gemini ok");
    let n_receipt = n_res.expect("join notebook").expect("notebook ok");
    assert_eq!(g_receipt.queue_name, "gemini_queue");
    assert_eq!(g_receipt.effort_level, EffortLevel::High);
    assert_eq!(n_receipt.queue_name, "notebook_queue");
    assert_eq!(n_receipt.effort_level, EffortLevel::Low);

    let stats = engine.dispatcher().stats();
    assert_eq!(stats.gemini_queue.completed, 1);
    assert_eq!(stats.notebook_queue.completed, 1);
    assert_eq!(stats.gemini_queue.peak_concurrent, 1);
    assert_eq!(stats.notebook_queue.peak_concurrent, 1);
}

#[tokio::test]
async fn public_gemini_share_import_and_429_auth_challenge_zero_retry_circuit_breaker() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Public Share Import", 10);
    let payload = sample_gemini_share_payload();

    // 1. Offline WIZ `batchexecute` payload import.
    let imported = engine
        .import_public_share_pages(
            &nb_id,
            "https://share.gemini.google/share1234abcd?utm_source=test",
            &[payload.as_str()],
        )
        .expect("import public share payload");
    assert_eq!(imported.share_id.as_deref(), Some("share1234abcd"));
    assert_eq!(imported.imported_turns, 1);
    assert!(imported.cursor_exhausted);
    assert_eq!(imported.source.source_kind, SourceKind::TranscriptShare);
    assert_eq!(engine.list_turns(&nb_id).expect("turns").len(), 1);

    // 2. Live HTTP loopback server returning HTTP 200 WIZ payload.
    let listener_ok = TcpListener::bind("127.0.0.1:0").await.expect("bind ok server");
    let addr_ok = listener_ok.local_addr().expect("addr ok");
    let payload_clone = payload.clone();
    let ok_srv = tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener_ok.accept().await {
            let mut req_buf = [0u8; 1024];
            let _ = stream.read(&mut req_buf).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload_clone.len(),
                payload_clone
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        }
    });

    let nb2 = create_test_notebook(&engine, "Live HTTP Share", 10);
    let live_importer = engine
        .share_importer()
        .with_fetch_url_override(format!("http://{addr_ok}/share"));
    let live_res = live_importer
        .fetch_and_import_public_share(&nb2, "https://share.gemini.google/live5678efgh")
        .await
        .expect("live HTTP import");
    ok_srv.await.expect("ok srv done");
    assert_eq!(live_res.imported_turns, 1);

    // 3. Live HTTP 429 AUTH_CHALLENGE_REQUIRED zero-retry fail-closed circuit breaker test!
    let hit_counter = Arc::new(AtomicUsize::new(0));
    let listener_429 = TcpListener::bind("127.0.0.1:0").await.expect("bind 429 server");
    let addr_429 = listener_429.local_addr().expect("addr 429");
    let hits_srv = Arc::clone(&hit_counter);
    let srv_429 = tokio::spawn(async move {
        for _ in 0..2 {
            if let Ok(Ok((mut stream, _))) = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                listener_429.accept(),
            )
            .await
            {
                hits_srv.fetch_add(1, Ordering::SeqCst);
                let mut req_buf = [0u8; 1024];
                let _ = stream.read(&mut req_buf).await;
                let body = r#"{"error":"AUTH_CHALLENGE_REQUIRED"}"#;
                let resp = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            } else {
                break;
            }
        }
    });

    let importer_429 = engine
        .share_importer()
        .with_fetch_url_override(format!("http://{addr_429}/sorry"));
    let err1 = importer_429
        .fetch_and_import_public_share(&nb2, "https://share.gemini.google/gated9999aaaa")
        .await
        .expect_err("HTTP 429 must fail closed");

    let ticket_id = match err1 {
        NotebookError::AuthChallengeRequired {
            status,
            code,
            handoff,
            ..
        } => {
            assert_eq!(status, AUTH_CHALLENGE_HTTP_STATUS);
            assert_eq!(code, AUTH_CHALLENGE_CODE);
            assert_eq!(handoff.execution_mode, MANUAL_VISIBLE_BROWSER_ONLY);
            assert!(!handoff.auto_solve_permitted);
            assert!(handoff.challenge_required);
            assert_eq!(handoff.status, VisibleHandoffStatus::PendingUserAction);
            handoff.ticket_id
        }
        other => panic!("expected AuthChallengeRequired, got {other:?}"),
    };

    // Exactly 1 request hit the server (0 automatic retries!).
    assert_eq!(hit_counter.load(Ordering::SeqCst), 1);
    assert_eq!(engine.circuit_breaker().snapshot().retries_attempted, 0);
    assert_eq!(engine.circuit_breaker().snapshot().state, AuthCircuitState::Tripped);

    // Second call MUST fail closed locally without making ANY network call (`hit_counter` stays 1!).
    let err2 = importer_429
        .fetch_and_import_public_share(&nb2, "https://share.gemini.google/gated9999bbbb")
        .await
        .expect_err("tripped breaker must fail closed immediately");
    assert_eq!(err2.http_status(), 429);
    assert_eq!(err2.error_code(), AUTH_CHALLENGE_CODE);
    assert_eq!(
        hit_counter.load(Ordering::SeqCst),
        1,
        "tripped circuit breaker must make ZERO outbound requests"
    );
    srv_429.await.expect("429 srv done");

    // Resetting before user completes handoff is blocked; completing handoff closes the breaker!
    let premature_reset = engine
        .circuit_breaker()
        .reset_after_handoff(engine.handoff_manager(), &ticket_id);
    assert!(matches!(
        premature_reset,
        Err(NotebookError::PolicyBlocked {
            code: "HANDOFF_NOT_COMPLETED",
            ..
        })
    ));

    let reset_snap = engine
        .complete_handoff_and_reset(&ticket_id)
        .expect("reset after user handoff completion");
    assert_eq!(reset_snap.state, AuthCircuitState::Closed);
    assert_eq!(reset_snap.retries_attempted, 0);
}

#[test]
fn citation_verifier_flags_ambiguous_duplicate_title_references() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Ambiguous Citation Verifier", 10);

    let s1 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Quarterly Report".to_string()),
            filename: "q1.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# Q1\nRevenue grew 12%.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("s1")
        .source;
    let _s2 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Quarterly Report".to_string()),
            filename: "q2.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# Q2\nRevenue grew 18%.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("s2")
        .source;

    let report = engine
        .verify_citations(
            &nb_id,
            &format!(
                "Revenue grew [{}:0], also mentioned in [Quarterly Report].",
                s1.source_id
            ),
        )
        .expect("verify ambiguous");
    assert!(!report.valid);
    assert_eq!(report.verified_citations.len(), 1);
    assert_eq!(report.ambiguous_references.len(), 1);
    assert_eq!(report.ambiguous_references[0].raw_reference, "Quarterly Report");
    assert_eq!(report.ambiguous_references[0].matching_source_ids.len(), 2);
}

#[test]
fn pdf_tj_hex_literals_and_stage6_heal_sweep_repairs_degraded_source() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "PDF TJ & Stage6 Heal", 10);

    let raw_pdf = b"%PDF-1.5\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Length 96 >>\nstream\nBT [(Atelier) -180 (Studio\\(v3\\))] TJ <4F6D6E6961> Tj ET\nendstream\nendobj\n%%EOF\n";
    let parsed = omnia_notebook::inspect_and_extract_pdf(raw_pdf);
    assert_eq!(parsed.classification, PdfClassification::ReadableText);
    assert!(parsed.extracted_text.contains("Atelier Studio(v3)"));
    assert!(parsed.extracted_text.contains("Omnia"));

    // Regression: binary high-byte stream payloads must never desynchronize byte offsets or panic.
    let mut binary_pdf = b"%PDF-1.4\n1 0 obj << /Length 2000 >>\nstream\n".to_vec();
    binary_pdf.extend(std::iter::repeat_n(0xC3u8, 2_000));
    binary_pdf.extend_from_slice(b"\nendstream\nendobj\n2 0 obj << >>\nstream\nBT (TailMarker) Tj ET\nendstream\nendobj\n%%EOF\n");
    let parsed_bin = omnia_notebook::inspect_and_extract_pdf(&binary_pdf);
    assert!(parsed_bin.extracted_text.contains("TailMarker"));

    // Register a source with 0 chunks + stored fallback excerpt so Stage 6 heals it cleanly.
    let reg = engine
        .library()
        .register_source(SourceRegistrationInput {
            notebook_id: nb_id.clone(),
            remote_id: None,
            title: "Degraded OCR Source".to_string(),
            filename: "ocr.txt".to_string(),
            mime_type: Some("text/plain".to_string()),
            source_kind_override: None,
            raw_bytes: b"degraded".to_vec(),
            chunks: vec![],
            ingestion_stage: "stage1_native_validate".to_string(),
            provenance: "EXTRACTED".to_string(),
            metadata: json!({
                "fallback_text_excerpt": "Recovered OCR paragraph restored during Stage 6 heal sweep."
            }),
        })
        .expect("register degraded");
    assert_eq!(reg.source.chunk_count, 0);

    let report = engine.heal_sources(&nb_id).expect("heal sweep");
    assert_eq!(report.inspected, 1);
    assert_eq!(report.healed, 1);
    assert_eq!(report.quarantined, 0);

    let repaired = engine
        .store()
        .get_source(&reg.source.source_id)
        .expect("get repaired")
        .expect("exists");
    assert_eq!(repaired.chunk_count, 1);
    assert_eq!(repaired.ingestion_stage, IngestionStage::Stage6HealSweep.as_str());
}

#[tokio::test]
async fn sorry_redirect_and_private_app_url_trip_zero_retry_circuit_breaker() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Redirect Gate", 5);

    // 1. Private `/app/...` URL refused immediately without touching network, tripping breaker.
    let private_err = engine
        .fetch_and_import_public_share(&nb_id, "https://gemini.google.com/app/private_conv_1")
        .await
        .expect_err("private /app URL must trip breaker");
    let t1 = match private_err {
        NotebookError::AuthChallengeRequired {
            status: 429,
            code: AUTH_CHALLENGE_CODE,
            handoff,
            ..
        } => handoff.ticket_id,
        other => panic!("expected AuthChallengeRequired, got {other:?}"),
    };
    engine
        .complete_handoff_and_reset(&t1)
        .expect("reset after private url test");

    // 1b. Non-loopback SSRF `fetch_url_override` is strictly rejected.
    let ssrf_importer = engine
        .share_importer()
        .with_fetch_url_override("http://169.254.169.254/latest/meta-data/");
    let ssrf_err = ssrf_importer
        .fetch_and_import_public_share(&nb_id, "https://share.gemini.google/ssrf123456")
        .await;
    assert!(matches!(
        ssrf_err,
        Err(NotebookError::SecurityRejected {
            code: "SSRF_OVERRIDE_REJECTED",
            ..
        })
    ));

    // 2. HTTP 302 redirect to `google.com/sorry` must NOT follow redirect and must trip breaker.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind redirect srv");
    let addr = listener.local_addr().expect("addr");
    let srv = tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf).await;
            let resp = "HTTP/1.1 302 Found\r\nLocation: https://www.google.com/sorry/index\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(resp.as_bytes()).await;
        }
    });

    let importer = engine
        .share_importer()
        .with_fetch_url_override(format!("http://{addr}/redirect"));
    let redir_err = importer
        .fetch_and_import_public_share(&nb_id, "https://share.gemini.google/redir123456")
        .await
        .expect_err("sorry redirect must trip circuit breaker");
    srv.await.expect("srv done");

    assert_eq!(redir_err.http_status(), 429);
    assert_eq!(redir_err.error_code(), AUTH_CHALLENGE_CODE);
    assert_eq!(engine.circuit_breaker().snapshot().state, AuthCircuitState::Tripped);
    assert_eq!(engine.circuit_breaker().snapshot().retries_attempted, 0);
}

#[test]
fn rtf_multibyte_after_hex_escape_never_panics() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "RTF Safety", 5);

    // Malformed `\'` followed immediately by multi-byte UTF-8 (`é`), `\é`, and trailing `\`.
    let nasty_rtf = "{\\rtf1\\ansi \\'aé \\'é \\é Hello\\par World\\}";
    let stripped = omnia_notebook::strip_rtf_to_text(nasty_rtf);
    assert!(stripped.contains("Hello"));
    assert!(stripped.contains("World"));

    let preview = engine
        .preview_bytes("nasty.rtf", None, nasty_rtf.as_bytes())
        .expect("preview nasty rtf without panic");
    assert_eq!(preview.format, PreviewFormat::RichText);

    let ingested = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id,
            title: Some("Nasty RTF".to_string()),
            filename: "nasty.rtf".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: nasty_rtf.as_bytes().to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("ingest nasty rtf without panic");
    assert!(ingested.chunk_count >= 1);
}

#[test]
fn concurrent_ingests_cannot_race_past_max_sources_cap() {
    let temp = TempDirGuard::new("concurrent_cap");
    let db_path = temp.path.join("cap_race.db");
    let engine = Arc::new(NotebookEngine::open(&db_path).expect("open WAL engine"));
    let nb_id = create_test_notebook(&engine, "Strict Cap Concurrency", 3);

    let start_barrier = Arc::new(std::sync::Barrier::new(8));
    let mut succeeded = 0usize;
    let mut overflowed = 0usize;

    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let eng = Arc::clone(&engine);
                let bar = Arc::clone(&start_barrier);
                let nb = nb_id.clone();
                scope.spawn(move || {
                    bar.wait();
                    eng.ingest_source(IngestSourceRequest {
                        notebook_id: nb,
                        title: Some(format!("Concurrent Doc {i}")),
                        filename: format!("doc_{i}.md"),
                        mime_type: None,
                        remote_id: None,
                        bytes: format!("# Doc {i}\nUnique body content #{i}.").into_bytes(),
                        copied_text_fallback: None,
                        max_chunk_bytes: None,
                        metadata: json!({}),
                    })
                })
            })
            .collect();
        for h in handles {
            match h.join().expect("thread join") {
                Ok(_) => succeeded += 1,
                Err(NotebookError::OverflowDisallowed { max: 3, .. }) => overflowed += 1,
                Err(other) => panic!("unexpected concurrent ingest error: {other:?}"),
            }
        }
    });

    assert_eq!(succeeded, 3);
    assert_eq!(overflowed, 5);
    assert_eq!(
        engine
            .list_sources(&nb_id, &SourceFilter::default())
            .expect("list")
            .len(),
        3
    );
}

#[test]
fn remote_id_collision_proof_prefix_and_uniqueness_enforced() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Remote ID Collision Proof", 10);

    // 1. `remote_id` with reserved `src_` prefix is strictly rejected.
    let spoof = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: Some("Spoofed".to_string()),
        filename: "spoof.md".to_string(),
        mime_type: None,
        remote_id: Some("src_deadbeef".to_string()),
        bytes: b"spoof content".to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(spoof, Err(NotebookError::InvalidInput(_))));

    // 2. Two distinct payloads reusing the same `remote_id` fail with `RemoteIdConflict`.
    let first = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Share v1".to_string()),
            filename: "share_v1.md".to_string(),
            mime_type: None,
            remote_id: Some("share_xyz_01".to_string()),
            bytes: b"# Share v1\nOriginal content".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("first remote_id ok")
        .source;

    let dup_remote = engine.ingest_source(IngestSourceRequest {
        notebook_id: nb_id.clone(),
        title: Some("Share v2".to_string()),
        filename: "share_v2.md".to_string(),
        mime_type: None,
        remote_id: Some("share_xyz_01".to_string()),
        bytes: b"# Share v2\nUpdated different content".to_vec(),
        copied_text_fallback: None,
        max_chunk_bytes: None,
        metadata: json!({}),
    });
    assert!(matches!(
        dup_remote,
        Err(NotebookError::RemoteIdConflict {
            ref remote_id,
            ref existing_source_id
        }) if remote_id == "share_xyz_01" && existing_source_id == &first.source_id
    ));

    // Identical content with same `remote_id` cleanly deduplicates by SHA-256.
    let same_content = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id,
            title: Some("Share v1 repeat".to_string()),
            filename: "share_v1_repeat.md".to_string(),
            mime_type: None,
            remote_id: Some("share_xyz_01".to_string()),
            bytes: b"# Share v1\nOriginal content".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("identical content dedup");
    assert!(same_content.deduplicated);
    assert_eq!(same_content.source.source_id, first.source_id);
}

#[test]
fn cumulative_nested_zip_bomb_budget_enforced_across_entries_and_levels() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");

    // Create a nested archive whose inner highly-compressible entries sum past 100x the outer ZIP.
    let inner_payload = vec![b'Z'; 160 * 1024];
    let inner_zip = build_zip(&[
        ("part_a.txt", &inner_payload),
        ("part_b.txt", &inner_payload),
    ]);
    let outer_zip = build_zip(&[
        ("inner_1.zip", &inner_zip),
        ("inner_2.zip", &inner_zip),
    ]);
    let err = engine.preview_bytes("nested_bomb.zip", None, &outer_zip);
    assert!(matches!(
        err,
        Err(NotebookError::SecurityRejected {
            code: "ZIP_BOMB_RATIO_EXCEEDED",
            ..
        })
    ));
}

#[test]
fn code_repository_enforces_workspace_root_containment_and_extended_secret_denylist() {
    let allowed_root = TempDirGuard::new("allowed_ws");
    let outside_root = TempDirGuard::new("outside_ws");
    let repo_sub = allowed_root.path.join("project");
    fs::create_dir_all(repo_sub.join("src")).expect("src dir");
    fs::create_dir_all(repo_sub.join(".ssh")).expect("ssh dir");
    fs::write(repo_sub.join("src/lib.rs"), "pub fn ok() -> bool { true }\n").expect("lib.rs");
    fs::write(repo_sub.join("id_rsa"), "PRIVATE").expect("id_rsa");
    fs::write(repo_sub.join("id_ed25519"), "PRIVATE").expect("id_ed25519");
    fs::write(repo_sub.join("vault.kdbx"), "KEEPASS").expect("kdbx");
    fs::write(repo_sub.join("deploy.ppk"), "PUTTY").expect("ppk");
    fs::write(repo_sub.join("credentials.json"), "{}").expect("creds");
    fs::write(repo_sub.join(".ssh/config"), "Host x").expect("ssh cfg");

    // 1. Default empty allowlist fails closed.
    let empty_err =
        omnia_notebook::package_code_repository(&repo_sub, &RepoPackageConfig::default());
    assert!(matches!(
        empty_err,
        Err(NotebookError::SecurityRejected {
            code: "WORKSPACE_ROOT_ALLOWLIST_REQUIRED",
            ..
        })
    ));

    // 2. Directory outside allowed_workspace_roots fails closed.
    let outside_err = omnia_notebook::package_code_repository(
        &outside_root.path,
        &RepoPackageConfig::for_workspace_root(&allowed_root.path),
    );
    assert!(matches!(
        outside_err,
        Err(NotebookError::SecurityRejected {
            code: "REPO_OUTSIDE_ALLOWED_ROOT",
            ..
        })
    ));

    // 3. UNC network path fails closed.
    let unc_err = omnia_notebook::package_code_repository(
        std::path::Path::new(r"\\fileserver\share\repo"),
        &RepoPackageConfig::for_workspace_root(&allowed_root.path),
    );
    assert!(matches!(
        unc_err,
        Err(NotebookError::SecurityRejected {
            code: "UNSAFE_LOCAL_PATH",
            ..
        })
    ));

    // 4. Contained workspace succeeds and strips every secret/key file.
    let pkg = omnia_notebook::package_code_repository(
        &repo_sub,
        &RepoPackageConfig::for_workspace_root(&allowed_root.path),
    )
    .expect("contained repo");
    assert_eq!(pkg.included_files, vec!["src/lib.rs"]);
    assert!(!pkg.markdown.contains("PRIVATE"));
    assert!(!pkg.markdown.contains("KEEPASS"));
    assert!(!pkg.markdown.contains("PUTTY"));
    assert!(!pkg.markdown.contains("credentials.json"));
}

#[tokio::test]
async fn dispatcher_drop_guard_recovers_in_flight_on_cancelled_future() {
    let engine = Arc::new(NotebookEngine::open_in_memory().expect("open engine"));
    let entered = Arc::new(tokio::sync::Notify::new());
    let entered_clone = Arc::clone(&entered);
    let eng_clone = Arc::clone(&engine);

    let handle = tokio::spawn(async move {
        let req = DispatchRequest::new(
            InteractionSurface::Gemini,
            None,
            "Long running prompt",
            "gemini-4-hydrogen",
            EffortLevel::High,
        );
        let _ = eng_clone
            .submit_gemini(req, move |_| async move {
                entered_clone.notify_one();
                std::future::pending::<Result<(String, Vec<String>, Value), NotebookError>>().await
            })
            .await;
    });

    entered.notified().await;
    assert_eq!(engine.dispatcher().stats().gemini_queue.in_flight, 1);

    handle.abort();
    let _ = handle.await;

    let stats = engine.dispatcher().stats().gemini_queue;
    assert_eq!(stats.in_flight, 0);
    assert_eq!(stats.failed, 1);
}

#[test]
fn p0_source_ids_filter_only_checked_persistence_rename_and_btw_delete() {
    let temp = TempDirGuard::new("p0_filters_persistence");
    let db_path = temp.path.join("p0_state.db");
    let (nb_id, s1_id, s2_id, btw_id) = {
        let engine = NotebookEngine::open(&db_path).expect("open wal");
        let nb_id = create_test_notebook(&engine, "Initial Title", 10);

        let renamed = engine
            .rename_notebook(&nb_id, "Renamed Research Atelier")
            .expect("rename notebook");
        assert_eq!(renamed.title, "Renamed Research Atelier");

        let s1 = engine
            .ingest_source(IngestSourceRequest {
                notebook_id: nb_id.clone(),
                title: Some("Alpha Spec".to_string()),
                filename: "alpha.md".to_string(),
                mime_type: None,
                remote_id: Some("rem_alpha".to_string()),
                bytes: b"# Alpha\nAlpha quantum routing protocol with deterministic leases."
                    .to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: json!({ "localPath": "C:\\Users\\example\\alpha.md" }),
            })
            .expect("ingest s1")
            .source;
        // Public metadata must never persist or expose `localPath`.
        assert!(s1.metadata.get("localPath").is_none());
        assert!(s1.checked);

        let s2 = engine
            .ingest_source(IngestSourceRequest {
                notebook_id: nb_id.clone(),
                title: Some("Beta Spec".to_string()),
                filename: "beta.md".to_string(),
                mime_type: None,
                remote_id: Some("rem_beta".to_string()),
                bytes: b"# Beta\nBeta quantum routing protocol with fallback queue.".to_vec(),
                copied_text_fallback: None,
                max_chunk_bytes: None,
                metadata: json!({}),
            })
            .expect("ingest s2")
            .source;

        // Toggle `checked = false` on s2.
        let unchecked = engine
            .set_source_checked(&nb_id, &s2.source_id, false)
            .expect("uncheck s2");
        assert!(!unchecked.checked);

        // `source_ids` filter strictly scopes both `list_sources` and BM25F `build_grounded_prompt`.
        let scoped_filter = SourceFilter {
            source_ids: Some(vec![s1.source_id.clone()]),
            ..Default::default()
        };
        let listed = engine
            .list_sources(&nb_id, &scoped_filter)
            .expect("scoped list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].source_id, s1.source_id);

        let pack = engine
            .build_grounded_prompt(&nb_id, "quantum routing protocol", &scoped_filter, 8)
            .expect("scoped grounding");
        assert!(!pack.evidence.is_empty());
        assert!(pack.evidence.iter().all(|ev| ev.source_id == s1.source_id));

        // `only_checked` filter excludes unchecked s2.
        let checked_pack = engine
            .build_grounded_prompt(
                &nb_id,
                "quantum routing protocol",
                &SourceFilter {
                    only_checked: true,
                    ..Default::default()
                },
                8,
            )
            .expect("checked-only grounding");
        assert!(!checked_pack.evidence.is_empty());
        assert!(checked_pack
            .evidence
            .iter()
            .all(|ev| ev.source_id == s1.source_id));

        // Record a main turn + BTW thread, then delete the BTW thread without mutating turns.
        let turn = engine
            .record_turn(RecordTurnRequest {
                notebook_id: nb_id.clone(),
                surface: InteractionSurface::Notebook,
                prompt_text: "Summarize Alpha".to_string(),
                response_markdown: format!("Alpha routing [{}:0]", s1.source_id),
                model_id: "gemini-4-hydrogen".to_string(),
                effort: EffortLevel::High,
                quotes: vec![],
                citations: vec![format!("[{}:0]", s1.source_id)],
            })
            .expect("record turn");
        let quote = engine
            .create_quote_card(CreateQuoteCardRequest {
                notebook_id: nb_id.clone(),
                surface: InteractionSurface::Notebook,
                anchor_turn_id: turn.turn_id,
                source_id: Some(s1.source_id.clone()),
                excerpt: "deterministic leases".to_string(),
                char_start: 0,
                char_end: 20,
            })
            .expect("quote card");
        let btw = engine
            .create_btw_thread(quote.quote, "Explain leases")
            .expect("create btw");
        assert_eq!(engine.list_btw_threads(&nb_id).expect("list btw").len(), 1);
        assert!(engine
            .delete_btw_thread(&btw.btw_id)
            .expect("delete btw thread"));
        assert!(engine.list_btw_threads(&nb_id).expect("empty btw").is_empty());
        assert_eq!(engine.list_turns(&nb_id).expect("turns intact").len(), 1);

        (nb_id, s1.source_id, s2.source_id, btw.btw_id)
    };

    // Reopen WAL DB to confirm rename, checked toggle, and BTW deletion survive restart.
    let reopened = NotebookEngine::open(&db_path).expect("reopen wal");
    assert_eq!(
        reopened.get_notebook(&nb_id).expect("get nb").title,
        "Renamed Research Atelier"
    );
    let s1_after = reopened
        .store()
        .get_source(&s1_id)
        .expect("s1")
        .expect("exists");
    let s2_after = reopened
        .store()
        .get_source(&s2_id)
        .expect("s2")
        .expect("exists");
    assert!(s1_after.checked);
    assert!(!s2_after.checked);
    assert!(reopened
        .store()
        .get_btw_thread(&btw_id)
        .expect("get deleted btw")
        .is_none());
}

#[tokio::test]
async fn p0_chat_settings_10k_cap_bilingual_effort_and_preset_wiring() {
    let temp = TempDirGuard::new("p0_chat_settings");
    let db_path = temp.path.join("chat_settings.db");
    let engine = NotebookEngine::open(&db_path).expect("open wal");
    let nb_id = create_test_notebook(&engine, "Chat Settings & Presets", 10);

    let s1 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Consensus Notes".to_string()),
            filename: "consensus.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# Raft\nRaft elects one leader per term using randomized timeouts.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("ingest")
        .source;

    // 1. Default settings.
    let defaults = engine.get_chat_settings(&nb_id).expect("default settings");
    assert_eq!(defaults, ChatSettings::default());

    // 2. Reject blank custom prompt and > 10,000-char custom prompt.
    assert!(matches!(
        engine.set_chat_settings(
            &nb_id,
            ChatSettings {
                mode: "custom".to_string(),
                length: "default".to_string(),
                custom_prompt: "   ".to_string(),
            }
        ),
        Err(NotebookError::InvalidInput(_))
    ));
    let over_cap = "a".repeat(MAX_CHAT_CUSTOM_PROMPT_CHARS + 1);
    assert!(matches!(
        engine.set_chat_settings(
            &nb_id,
            ChatSettings {
                mode: "custom".to_string(),
                length: "longer".to_string(),
                custom_prompt: over_cap,
            }
        ),
        Err(NotebookError::InvalidInput(_))
    ));

    // 3. Accept exact 10,000-char prompt and inject into system_instructions.
    let prefix = "Respond as a formal systems auditor. ";
    let exact_cap = format!(
        "{prefix}{}",
        "x".repeat(MAX_CHAT_CUSTOM_PROMPT_CHARS - prefix.chars().count())
    );
    assert_eq!(exact_cap.chars().count(), MAX_CHAT_CUSTOM_PROMPT_CHARS);
    let saved = engine
        .set_chat_settings(
            &nb_id,
            ChatSettings {
                mode: "custom".to_string(),
                length: "shorter".to_string(),
                custom_prompt: exact_cap.clone(),
            },
        )
        .expect("save exact 10k prompt");
    assert_eq!(saved.mode, "custom");
    assert_eq!(saved.length, "shorter");

    let pack = engine
        .build_grounded_prompt(&nb_id, "How does Raft elect a leader?", &SourceFilter::default(), 4)
        .expect("pack");
    assert!(pack
        .system_instructions
        .contains("Respond as a formal systems auditor."));
    assert!(pack.system_instructions.contains("Response Length: Keep the answer concise"));

    // 4. Bilingual EN + VI effort parsing.
    assert_eq!(EffortLevel::parse_bilingual("tối thiểu").unwrap(), EffortLevel::Minimal);
    assert_eq!(EffortLevel::parse_bilingual("thấp").unwrap(), EffortLevel::Low);
    assert_eq!(EffortLevel::parse_bilingual("trung bình").unwrap(), EffortLevel::Medium);
    assert_eq!(EffortLevel::parse_bilingual("cao").unwrap(), EffortLevel::High);
    assert_eq!(EffortLevel::parse_bilingual("rất cao").unwrap(), EffortLevel::XHigh);
    assert_eq!(EffortLevel::parse_bilingual("tối đa").unwrap(), EffortLevel::Max);

    // 5. Real loopback LLM ask with ContextualAskPreset::Verify + EffortLevel::XHigh + source_ids!
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let sid = s1.source_id.clone();
    let srv = tokio::spawn(async move {
        if let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = [0u8; 32768];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req_text = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert!(
                req_text.contains("Independently verify every factual and technical claim"),
                "preset Verify instruction must reach upstream LLM prompt"
            );
            let body = json!({
                "id": "chatcmpl-p0-preset",
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": format!("Verified: Raft uses randomized election timeouts [{sid}:0].")
                    }
                }],
                "usage": { "prompt_tokens": 30, "completion_tokens": 15 }
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.flush().await;
        }
    });

    let llm_cfg = NotebookLlmConfig {
        model_spec: "openai/dummy-model".to_string(),
        config_dir: None,
        api_base_override: Some(format!("http://{addr}/v1")),
        api_key_override: Some("dummy_test_api_key_example".to_string()),
        wire_api_override: Some("openai-completions".to_string()),
        effort: Some(EffortLevel::XHigh),
        temperature: 0.2,
        max_tokens: 512,
        allow_loopback_endpoints: true,
    };
    let outcome = engine
        .ask_notebook_with_preset_and_llm(
            &nb_id,
            InteractionSurface::Notebook,
            "How does Raft elect a leader?",
            Some(ContextualAskPreset::Verify),
            &SourceFilter {
                source_ids: Some(vec![s1.source_id.clone()]),
                ..Default::default()
            },
            4,
            &llm_cfg,
        )
        .await
        .expect("ask with preset");
    srv.await.expect("mock llm done");
    assert!(outcome.verification.valid);
    assert_eq!(outcome.turn.effort_level, "xhigh");
    assert!(outcome
        .pack
        .system_instructions
        .contains("Contextual Ask Preset (Verify)"));
}

#[test]
fn p0_reconcile_remote_sources_fails_closed_when_snapshot_incomplete() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Fail-Closed Sync Guard", 10);

    let s1 = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Local Ground Truth".to_string()),
            filename: "truth.md".to_string(),
            mime_type: None,
            remote_id: Some("rem_truth_01".to_string()),
            bytes: b"# Truth\nDo not delete on incomplete remote snapshot.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("ingest")
        .source;

    // Incomplete snapshot MUST fail closed with `SOURCES_INCOMPLETE` (HTTP 409) and zero mutations.
    let err = engine
        .reconcile_remote_sources(&nb_id, &[], false)
        .expect_err("incomplete snapshot must fail closed");
    assert_eq!(err.error_code(), "SOURCES_INCOMPLETE");
    assert_eq!(err.http_status(), 409);
    assert!(matches!(err, NotebookError::SourcesIncomplete { .. }));

    // Local source and tombstone table remain completely untouched.
    let remaining = engine
        .list_sources(&nb_id, &SourceFilter::default())
        .expect("list sources");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].source_id, s1.source_id);
    assert!(engine.list_tombstones(&nb_id).expect("tombstones").is_empty());

    // Complete snapshot with explicit remote item succeeds.
    let ok_rep = engine
        .reconcile_remote_sources(
            &nb_id,
            &[RemoteSyncItem {
                remote_id: "rem_truth_01".to_string(),
                title: Some("Local Ground Truth".to_string()),
                content_sha256: Some(s1.content_sha256),
            }],
            true,
        )
        .expect("complete snapshot ok");
    assert_eq!(ok_rep.active_sources.len(), 1);
}

#[test]
fn p0_upload_healer_five_stage_ladder_zero_red_rows_drive_suffix_and_error_dedupe() {
    // 1. Drive localized suffix normalization + <= 88 char transport filename sanitization.
    assert_eq!(normalize_drive_filename_suffix("Rosen.pdf PDF"), "Rosen.pdf");
    assert_eq!(
        normalize_drive_filename_suffix("table.xlsx Microsoft Excel"),
        "table.xlsx"
    );
    assert_eq!(
        normalize_drive_filename_suffix("figure.png Hình ảnh"),
        "figure.png"
    );
    assert_eq!(
        normalize_drive_filename_suffix("slides.pptx Microsoft PowerPoint"),
        "slides.pptx"
    );
    assert_eq!(
        normalize_drive_filename_suffix("my notes.apdf"),
        "my notes.apdf"
    );

    let long_vi = format!(
        "Báo cáo nghiên cứu kiến trúc hệ thống phân tán siêu dài {}.pdf PDF",
        "chi-tiet-".repeat(15)
    );
    let safe_long = sanitize_transport_filename(&long_vi, MAX_TRANSPORT_FILENAME_LEN);
    assert!(safe_long.len() <= MAX_TRANSPORT_FILENAME_LEN);
    assert!(safe_long.ends_with(".pdf"));
    assert!(safe_long.is_ascii());

    let reserved = sanitize_transport_filename("CON.txt", MAX_TRANSPORT_FILENAME_LEN);
    assert_eq!(reserved, "file-con.txt");

    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "UploadHealer & Error Dedupe", 20);

    // 2. Error-excluded SHA-256 dedupe: failed row MUST NOT cause retry to skip as duplicate!
    let retry_payload = b"# Retryable Paper\nExact payload retried after transient upload error.";
    let failed_reg = engine
        .library()
        .register_source(SourceRegistrationInput {
            notebook_id: nb_id.clone(),
            remote_id: None,
            title: "Failed Upload".to_string(),
            filename: "retry.md".to_string(),
            mime_type: Some("text/markdown".to_string()),
            source_kind_override: None,
            raw_bytes: retry_payload.to_vec(),
            chunks: vec![],
            ingestion_stage: "failed_upload".to_string(),
            provenance: "EXTRACTED".to_string(),
            metadata: json!({ "status": "error" }),
        })
        .expect("register failed row");
    assert_eq!(failed_reg.source.status, "error");

    let retry_ok = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Recovered Paper".to_string()),
            filename: "retry.md".to_string(),
            mime_type: Some("text/markdown".to_string()),
            remote_id: None,
            bytes: retry_payload.to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("retry identical bytes succeeds");
    assert!(!retry_ok.deduplicated, "failed row must not trigger SHA-256 skip");
    assert_eq!(retry_ok.source.status, "ready");
    assert!(retry_ok.chunk_count >= 1);

    // 3. Full 5-stage UploadHealer escalation (Stages 0..4 rejected -> Stage 5 succeeds, zero red rows).
    let nb_heal = create_test_notebook(&engine, "5-Stage Ladder", 20);
    // Seed a pre-existing red/error source to verify UploadHealer purges it before retry!
    let _pre_failed = engine
        .library()
        .register_source(SourceRegistrationInput {
            notebook_id: nb_heal.clone(),
            remote_id: None,
            title: "Stale Red Row".to_string(),
            filename: "stale.txt".to_string(),
            mime_type: Some("text/plain".to_string()),
            source_kind_override: None,
            raw_bytes: b"stale red row".to_vec(),
            chunks: vec![],
            ingestion_stage: "failed_upload".to_string(),
            provenance: "EXTRACTED".to_string(),
            metadata: json!({ "status": "error" }),
        })
        .expect("seed red row");

    let mut seen_stages = Vec::new();
    let healed_s5 = engine
        .heal_upload_with_ladder(
            IngestSourceRequest {
                notebook_id: nb_heal.clone(),
                title: Some("Rosen Discrete Math".to_string()),
                filename: "Rosen.pdf PDF".to_string(),
                mime_type: Some("application/pdf".to_string()),
                remote_id: None,
                bytes: b"%PDF-1.4\n1 0 obj << >>\nstream\nBT (Discrete Mathematics Graph Theory) Tj ET\nendstream\nendobj\n%%EOF\n".to_vec(),
                copied_text_fallback: Some("Discrete Mathematics Graph Theory fallback.".to_string()),
                max_chunk_bytes: Some(256),
                metadata: json!({ "localPath": "D:\\private\\Rosen.pdf" }),
            },
            |ctx| {
                seen_stages.push(ctx.stage);
                if ctx.stage == HealStage::Stage5MetadataInventory {
                    assert!(ctx.filename.len() <= MAX_TRANSPORT_FILENAME_LEN);
                    Ok(())
                } else {
                    Err(format!("simulated rejection at {}", ctx.stage.as_str()))
                }
            },
        )
        .expect("stage 5 inventory succeeds");

    assert_eq!(healed_s5.final_stage, HealStage::Stage5MetadataInventory);
    assert_eq!(healed_s5.normalized_filename, "Rosen.pdf");
    assert!(healed_s5.total_purged_failed_rows >= 1);
    assert_eq!(healed_s5.attempts.len(), 6);
    assert_eq!(
        seen_stages,
        vec![
            HealStage::Stage0Direct,
            HealStage::Stage1SanitizedRetry,
            HealStage::Stage2DeepConvertSplit,
            HealStage::Stage3PlainTxtChunks,
            HealStage::Stage4CopiedTextMicroChunks,
            HealStage::Stage5MetadataInventory,
        ]
    );
    // Zero red rows remain in the notebook and `localPath` was stripped.
    let all_heal_sources = engine
        .list_sources(&nb_heal, &SourceFilter::default())
        .expect("list healed");
    assert!(all_heal_sources.iter().all(|s| s.status == "ready"));
    assert!(all_heal_sources
        .iter()
        .all(|s| s.metadata.get("localPath").is_none()));

    // 4. Security guard: blocked `.exe` MUST fail closed immediately (never escalate to Stage 5).
    let blocked_exe = engine.heal_upload_with_ladder(
        IngestSourceRequest {
            notebook_id: nb_heal,
            title: Some("Payload".to_string()),
            filename: "payload.exe".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"MZ\x90\x00".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        },
        |_| Err("should never be called for blocked exe".to_string()),
    );
    assert!(matches!(
        blocked_exe,
        Err(NotebookError::SecurityRejected {
            code: "DISALLOWED_EXTENSION",
            ..
        })
    ));
}

#[test]
fn p0_encoding_safe_decode_all_encodings_and_utf8_chunk_boundary_fuzz() {
    // 1. Empty 0-byte file.
    let empty = decode_text_safely(b"");
    assert_eq!(empty.text, "");
    assert_eq!(empty.detected_encoding, "utf-8");

    // 2. UTF-8 BOM + CRLF + unsafe C0 control char (0x07 BEL stripped, \t & \n preserved).
    let utf8_bom = b"\xEF\xBB\xBFXin ch\xC3\xA0o\tOmnia\x07\r\nLine 2\r";
    let dec_bom = decode_text_safely(utf8_bom);
    assert_eq!(dec_bom.detected_encoding, "utf-8-bom");
    assert_eq!(dec_bom.text, "Xin chào\tOmnia\nLine 2\n");
    assert_eq!(dec_bom.stripped_controls, 1);

    // 3. UTF-16LE BOM.
    let mut u16le = vec![0xFFu8, 0xFE];
    for unit in "Hello Việt".encode_utf16() {
        u16le.extend_from_slice(&unit.to_le_bytes());
    }
    let dec_u16le = decode_text_safely(&u16le);
    assert_eq!(dec_u16le.detected_encoding, "utf-16le");
    assert_eq!(dec_u16le.text, "Hello Việt");

    // 4. UTF-16BE BOM.
    let mut u16be = vec![0xFEu8, 0xFF];
    for unit in "Atlas 2026".encode_utf16() {
        u16be.extend_from_slice(&unit.to_be_bytes());
    }
    let dec_u16be = decode_text_safely(&u16be);
    assert_eq!(dec_u16be.detected_encoding, "utf-16be");
    assert_eq!(dec_u16be.text, "Atlas 2026");

    // 5. BOM-less UTF-16LE heuristic (must be decoded as text AND NOT flagged as binary!).
    let mut bomless_le = Vec::new();
    for unit in "Omnia Notebook UTF16LE Heuristic".encode_utf16() {
        bomless_le.extend_from_slice(&unit.to_le_bytes());
    }
    assert!(!is_likely_binary(&bomless_le));
    let dec_bomless = decode_text_safely(&bomless_le);
    assert_eq!(dec_bomless.detected_encoding, "utf-16le-bomless");
    assert_eq!(dec_bomless.text, "Omnia Notebook UTF16LE Heuristic");

    // 6. UTF-32LE BOM.
    let mut u32le = vec![0xFFu8, 0xFE, 0x00, 0x00];
    for ch in "Rust32".chars() {
        u32le.extend_from_slice(&(ch as u32).to_le_bytes());
    }
    let dec_u32 = decode_text_safely(&u32le);
    assert_eq!(dec_u32.detected_encoding, "utf-32le");
    assert_eq!(dec_u32.text, "Rust32");

    // 7. Stray-NUL UTF-8 (<25% NULs).
    let stray_nul = b"Alpha\x00BetaGammaDelta";
    let dec_nul = decode_text_safely(stray_nul);
    assert_eq!(dec_nul.detected_encoding, "utf-8-nul-cleaned");
    assert_eq!(dec_nul.text, "AlphaBetaGammaDelta");
    assert_eq!(dec_nul.stripped_nuls, 1);

    // 8. Windows-1252 fallback (€ = 0x80, smart quotes 0x93/0x94, é = 0xE9).
    let win1252 = b"Caf\xE9 \x80 100 \x93OK\x94";
    let dec_cp = decode_text_safely(win1252);
    assert_eq!(dec_cp.detected_encoding, "windows-1252");
    assert_eq!(dec_cp.text, "Café € 100 “OK”");
    assert!(!dec_cp.text.contains('\u{FFFD}'));

    // 9. Surrogate/codepoint-safe UTF-8 chunking fuzz across Vietnamese + emoji + math.
    let unit = "Tiếng Việt chuẩn xác 🚀🔥🧠 ∑∫∀∃≠≤≥ — phân đoạn UTF-8 an toàn. ";
    let big_doc = format!("# Đa Ngôn Ngữ\n{}\n\n## Kết Luận\n{}", unit.repeat(40), unit.repeat(20));
    for max_bytes in [128usize, 257, 513, 1024, MAX_COPIED_TEXT_BYTES] {
        let chunks = chunk_text_semantically(&big_doc, max_bytes);
        assert!(!chunks.is_empty());
        for (_h, body) in chunks {
            assert!(
                body.len() <= max_bytes,
                "chunk length {} exceeded ceiling {}",
                body.len(),
                max_bytes
            );
            assert!(!body.contains('\u{FFFD}'));
        }
    }
}

#[test]
fn p0_http_range_206_416_415_audio_wav_xml_attachment_and_zero_local_path_leak() {
    let engine = NotebookEngine::open_in_memory().expect("open engine");
    let nb_id = create_test_notebook(&engine, "Audio Range & XML Safety", 10);
    let _src = engine
        .ingest_source(IngestSourceRequest {
            notebook_id: nb_id.clone(),
            title: Some("Audio Source".to_string()),
            filename: "notes.md".to_string(),
            mime_type: None,
            remote_id: None,
            bytes: b"# Overview\nHTTP Range streaming enables seekable audio overviews.".to_vec(),
            copied_text_fallback: None,
            max_chunk_bytes: None,
            metadata: json!({}),
        })
        .expect("ingest")
        .source;

    // 1. AudioOverview deterministic RIFF/WAVE stream + HTTP 206 / 416 range verification.
    let audio_art = engine
        .generate_artifact(GenerateArtifactRequest {
            notebook_id: nb_id.clone(),
            kind: StudioArtifactKind::AudioOverview,
            title: Some("Range Podcast".to_string()),
            source_ids: None,
            focus_prompt: Some("Range streaming".to_string()),
        })
        .expect("generate audio overview");
    let (_, wav) = engine
        .render_audio_overview_wav(&nb_id, &audio_art.artifact_id)
        .expect("render wav");
    assert!(wav.len() > 2048);
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");

    let r206 = parse_http_byte_range("bytes=0-1023", wav.len()).expect("valid 206 range");
    assert_eq!(r206.slice(&wav).len(), 1024);
    assert_eq!(
        r206.content_range_header(),
        format!("bytes 0-1023/{}", wav.len())
    );
    assert_eq!(&r206.slice(&wav)[0..4], b"RIFF");

    let suffix = parse_http_byte_range("bytes=-128", wav.len()).expect("valid suffix range");
    assert_eq!(suffix.slice(&wav).len(), 128);
    assert_eq!(suffix.end, wav.len() - 1);

    // Out-of-bounds, inverted, and multi-range fail closed with Unsatisfiable (HTTP 416).
    assert_eq!(
        parse_http_byte_range("bytes=99999999-", wav.len()),
        Err(HttpByteRangeError::Unsatisfiable {
            total_len: wav.len()
        })
    );
    assert_eq!(
        parse_http_byte_range("bytes=500-100", wav.len()),
        Err(HttpByteRangeError::Unsatisfiable {
            total_len: wav.len()
        })
    );
    assert_eq!(
        parse_http_byte_range("bytes=0-10, 20-30", wav.len()),
        Err(HttpByteRangeError::Unsatisfiable {
            total_len: wav.len()
        })
    );
    assert_eq!(
        parse_http_byte_range("items=0-10", wav.len()),
        Err(HttpByteRangeError::InvalidHeader)
    );

    // 2. Non-AudioOverview artifact rejected for WAV streaming (HTTP 415 path in Studio).
    let briefing = engine
        .generate_artifact(GenerateArtifactRequest {
            notebook_id: nb_id.clone(),
            kind: StudioArtifactKind::Briefing,
            title: Some("Text Briefing".to_string()),
            source_ids: None,
            focus_prompt: None,
        })
        .expect("briefing");
    assert!(synthesize_audio_overview_wav(&briefing).is_err());
    assert!(is_streamable_media_mime("audio/wav"));
    assert!(is_streamable_media_mime("audio/mpeg"));
    assert!(!is_streamable_media_mime("text/html"));
    assert!(!is_streamable_media_mime("image/svg+xml"));
    assert!(!is_streamable_media_mime("application/xml"));

    // 3. XML forced-attachment safety + nosniff.
    assert!(requires_forced_attachment("xml", "application/xml"));
    assert!(requires_forced_attachment("svg", "image/svg+xml"));
    assert!(requires_forced_attachment("data", "text/xml"));
    let xml_prev = engine
        .preview_bytes(
            "feed.xml",
            Some("application/xml"),
            b"<?xml version=\"1.0\"?><feed><entry>Safe XML</entry></feed>",
        )
        .expect("xml preview");
    assert!(xml_prev.headers.force_attachment);
    assert!(xml_prev
        .headers
        .content_disposition
        .starts_with("attachment;"));
    assert_eq!(xml_prev.headers.x_content_type_options, "nosniff");

    // 4. Recursive `localPath`/`local_path` scrubbing.
    let mut payload = json!({
        "localPath": "D:\\OmniaData\\secret.db",
        "items": [{ "local_path": "C:\\Users\\example\\a.pdf", "filePath": "/etc/hosts", "title": "Keep" }]
    });
    strip_local_path_fields(&mut payload);
    assert!(payload.get("localPath").is_none());
    assert!(payload["items"][0].get("local_path").is_none());
    assert!(payload["items"][0].get("filePath").is_none());
    assert_eq!(payload["items"][0]["title"], "Keep");
}
