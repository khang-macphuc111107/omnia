use std::fs;

use omnia_core::uuid_v4;
use omnia_harness::{
    search_symbol_palette, symbol_palette, AttachmentChoice, AttachmentMediaKind, BlockFormat,
    ComposerNode, ComposerTable, ConversionStatus, DerivedRepresentation, DocumentAnchor, DropZone,
    IncomingAttachment, RichComposer, TextStyle, WireBlock,
};

#[test]
fn rich_composer_formatting_and_15_symbols() {
    let palette = symbol_palette();
    assert_eq!(palette.len(), 15);
    assert_eq!(palette.iter().filter(|s| s.category == "Math").count(), 7);
    assert_eq!(
        palette.iter().filter(|s| s.category == "Physics").count(),
        4
    );
    assert_eq!(
        palette.iter().filter(|s| s.category == "Chemistry").count(),
        4
    );

    let vn_search = search_symbol_palette("tich phan");
    assert!(vn_search.iter().any(|s| s.id == "math-integral"));
    let accented_search = search_symbol_palette("đạo hàm");
    assert!(accented_search.iter().any(|s| s.id == "math-partial"));

    let mut composer = RichComposer::new();
    composer.insert_text(
        "Section Heading",
        TextStyle {
            bold: true,
            block_format: BlockFormat::Heading1,
            ..TextStyle::default()
        },
    );
    let end_anchor = composer.caret();
    composer.set_caret(DocumentAnchor {
        node_index: end_anchor.node_index + 1,
        codepoint_offset: 0,
    });
    assert!(composer.insert_symbol_at_caret("math-integral"));
    assert!(composer.insert_symbol_at_caret("chem-enthalpy"));

    let mut table = ComposerTable::new(2, 1);
    table.headers = vec!["Quantity".to_owned(), "Symbol | Unit".to_owned()];
    assert!(table.set_cell(0, 0, "Enthalpy"));
    assert!(table.set_cell(0, 1, "J/mol | kJ"));
    composer.insert_table(table);

    let preview = composer.render_live_preview();
    assert!(preview.markdown_text.contains("# **Section Heading**"));
    assert!(preview.markdown_text.contains(r"\int_{a}^{b} f(x)\,dx"));
    assert!(preview.markdown_text.contains(r"Symbol \| Unit"));
    assert!(!preview.math_expressions.is_empty());
}

#[test]
fn rich_composer_dual_mode_paste_dnd_undo_redo() {
    let mut composer = RichComposer::new();
    composer.set_plain_text("Hello world");
    // Caret in the middle of "Hello world" (after "Hello ")
    let mid_anchor = DocumentAnchor {
        node_index: 0,
        codepoint_offset: 6,
    };

    let png_bytes = b"\x89PNG\r\n\x1A\nfake_png_data".to_vec();
    let png_att = IncomingAttachment {
        display_name: "plot.png".to_owned(),
        source_path: "plot.png".to_owned(),
        mime_type: "image/png".to_owned(),
        raw_bytes: png_bytes.clone(),
    };
    assert_eq!(png_att.classify_media_kind(), AttachmentMediaKind::ImagePng);

    // Cancel paste MUST produce zero mutation.
    let doc_before = composer.document().to_vec();
    let tray_before = composer.tray().to_vec();
    let undo_before = composer.undo_depth();
    composer.begin_paste(png_att.clone(), mid_anchor);
    assert!(composer.pending_paste().is_some());
    assert!(composer.resolve_paste(AttachmentChoice::Cancel).is_none());
    assert_eq!(composer.document(), doc_before.as_slice());
    assert_eq!(composer.tray(), tray_before.as_slice());
    assert_eq!(composer.undo_depth(), undo_before);

    // Inline paste splits text span around caret.
    composer.begin_paste(png_att, mid_anchor);
    let inline_id = composer
        .resolve_paste(AttachmentChoice::InlineAtCaret)
        .expect("inline id");
    assert!(composer.document().iter().any(|n| matches!(
        n,
        ComposerNode::InlineAttachment { attachment_id } if attachment_id == &inline_id
    )));
    assert_eq!(composer.document().len(), 3);

    // Move inline to tray, then copy back inline, then verify undo/redo.
    assert!(composer.move_inline_to_tray(&inline_id));
    assert_eq!(composer.tray().len(), 1);
    assert!(!composer
        .document()
        .iter()
        .any(|n| matches!(n, ComposerNode::InlineAttachment { .. })));

    assert!(composer.copy_tray_to_inline(
        &inline_id,
        DocumentAnchor {
            node_index: composer.document().len(),
            codepoint_offset: 0,
        },
    ));
    assert_eq!(composer.tray().len(), 1);
    assert!(composer
        .document()
        .iter()
        .any(|n| matches!(n, ComposerNode::InlineAttachment { .. })));

    assert!(composer.undo());
    assert!(!composer
        .document()
        .iter()
        .any(|n| matches!(n, ComposerNode::InlineAttachment { .. })));
    assert!(composer.redo());
    assert!(composer
        .document()
        .iter()
        .any(|n| matches!(n, ComposerNode::InlineAttachment { .. })));

    // Drag-and-drop into AttachmentTray
    let notes = IncomingAttachment {
        display_name: "notes.txt".to_owned(),
        source_path: "notes.txt".to_owned(),
        mime_type: "text/plain".to_owned(),
        raw_bytes: b"Dropped text payload".to_vec(),
    };
    composer.handle_drag_over(DropZone::AttachmentTray, DocumentAnchor::default());
    assert_eq!(composer.drop_indicator().zone, DropZone::AttachmentTray);
    let dropped_ids = composer.handle_drop(
        DropZone::AttachmentTray,
        vec![notes],
        DocumentAnchor::default(),
    );
    assert_eq!(dropped_ids.len(), 1);
    assert_eq!(composer.tray().len(), 2);
    assert_eq!(composer.drop_indicator().zone, DropZone::None);
}

#[test]
fn rich_composer_conversion_lifecycle_and_send_gating() {
    let mut composer = RichComposer::new();
    composer.set_plain_text("Inspect audio and PDF");

    // Empty composer cannot send
    assert!(!RichComposer::new().evaluate_send_readiness().ready);

    // WAV audio starts in Converting and blocks sending until complete/cancel/fail+ack
    let wav = IncomingAttachment {
        display_name: "meeting.wav".to_owned(),
        source_path: "meeting.wav".to_owned(),
        mime_type: "audio/wav".to_owned(),
        raw_bytes: b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec(),
    };
    let wav_ids = composer.add_attachments_to_tray(vec![wav]);
    let wav_id = &wav_ids[0];
    let gate_converting = composer.evaluate_send_readiness();
    assert!(!gate_converting.ready);
    assert_eq!(gate_converting.converting_count, 1);

    assert!(composer.fail_attachment_conversion(wav_id, "decoder timeout"));
    let gate_failed = composer.evaluate_send_readiness();
    assert!(!gate_failed.ready);
    assert_eq!(gate_failed.unacknowledged_failed_count, 1);

    // Retry puts it back into Converting
    assert!(composer.retry_attachment_conversion(wav_id));
    assert_eq!(
        composer.attachments()[wav_id].status,
        ConversionStatus::Converting
    );

    // Complete conversion unlocks Send
    assert!(composer.complete_attachment_conversion(
        wav_id,
        DerivedRepresentation {
            summary_text: "Audio transcript ready".to_owned(),
            transcript_lines: vec!["Speaker 1: Verify Rust migration".to_owned()],
            duration_ms: 4_200,
            ..DerivedRepresentation::default()
        },
    ));
    assert!(composer.evaluate_send_readiness().ready);

    // Encrypted PDF must fail immediately and block Send until removed or acknowledged
    let enc_pdf = IncomingAttachment {
        display_name: "locked.pdf".to_owned(),
        source_path: "locked.pdf".to_owned(),
        mime_type: "application/pdf".to_owned(),
        raw_bytes: b"%PDF-1.7\n1 0 obj << /Encrypt 3 0 R >> endobj\n".to_vec(),
    };
    let pdf_ids = composer.add_attachments_to_tray(vec![enc_pdf]);
    let pdf_id = &pdf_ids[0];
    assert_eq!(
        composer.attachments()[pdf_id].status,
        ConversionStatus::Failed
    );
    assert!(!composer.evaluate_send_readiness().ready);

    assert!(composer.acknowledge_failed_conversion(pdf_id));
    assert!(composer.evaluate_send_readiness().ready);
}

#[test]
fn rich_composer_provider_wire_serialization_and_lf_persistence() {
    let mut composer = RichComposer::new();
    composer.set_plain_text("Analyze plot and table");
    let png = IncomingAttachment {
        display_name: "chart.png".to_owned(),
        source_path: "chart.png".to_owned(),
        mime_type: "image/png".to_owned(),
        raw_bytes: b"\x89PNG\r\n\x1A\nPNGDATA".to_vec(),
    };
    let anchor = composer.caret();
    composer.insert_attachments_inline(vec![png], anchor);

    let turn = composer
        .serialize_for_provider("user")
        .expect("serialize ready composer");
    assert_eq!(turn.message.role, "user");
    assert!(turn
        .message
        .content
        .iter()
        .any(|b| matches!(b, WireBlock::Text { .. })));
    assert!(turn
        .message
        .content
        .iter()
        .any(|b| matches!(b, WireBlock::Image { media_type, .. } if media_type == "image/png")));
    assert_eq!(turn.upload_manifest.len(), 1);
    assert_eq!(turn.upload_manifest[0].placement, "inline");

    // Atomic LF persistence roundtrip
    let draft_path = std::env::temp_dir().join(format!("omnia-composer-{}.draft", uuid_v4()));
    composer.save_to_path(&draft_path).expect("save draft");
    let saved_bytes = fs::read(&draft_path).expect("read draft bytes");
    assert!(!saved_bytes.windows(2).any(|w| w == b"\r\n"));

    let reloaded = RichComposer::load_from_path(&draft_path).expect("reload draft");
    assert_eq!(reloaded.document(), composer.document());
    assert_eq!(reloaded.tray(), composer.tray());
    assert_eq!(reloaded.attachments(), composer.attachments());
    assert_eq!(reloaded.caret(), composer.caret());

    let _ = fs::remove_file(&draft_path);
}
