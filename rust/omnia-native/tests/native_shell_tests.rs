use std::ffi::c_void;
use std::fs;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};

use omnia_core::uuid_v4;
use omnia_harness::{AttachmentPlacement, ComposerModel};
use omnia_native::uia_provider::{
    com_add_ref, com_query_interface, com_release, iids, ButtonUiaObject, EditUiaObject,
    IRawElementProviderSimpleVtbl,
};
use omnia_native::{
    clamped_initial_window_bounds, clamped_min_track_size, compute_session_panel_layout,
    compute_shell_layout, effort_index, format_snapshot_status, format_store_error_status,
    normalize_effort, parse_qa_seed_directory_arg, parse_session_db_args, scale_px,
    strip_mnemonic_ampersands, validate_session_settings_input, Mode, NativeSessionCommand,
    NativeSessionStore, NativeSessionWorker, RectPx, SessionForm, EFFORTS, ID_MODE_BROWSER,
    ID_MODE_CHAT, ID_MODE_IDE, MAX_PENDING_SESSION_COMMANDS, UNCONFIGURED_MODEL_SENTINEL,
};
use windows_sys::Win32::Foundation::{E_NOINTERFACE, S_OK};
use windows_sys::Win32::System::Variant::{VariantClear, VariantInit, VARIANT, VT_BSTR, VT_I4};
use windows_sys::Win32::UI::Accessibility::{
    ProviderOptions, ProviderOptions_ServerSideProvider, UIA_ButtonControlTypeId,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_InvokePatternId, UIA_NamePropertyId,
    UIA_ValuePatternId,
};

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("omnia_native_test_{prefix}_{}", uuid_v4()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        Self { path: dir }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn cli_accepts_empty_and_absolute_session_db() {
    assert_eq!(parse_session_db_args(&[]).expect("empty cli ok"), None);

    let abs = if cfg!(windows) {
        r"D:\OmniaData\qa\fixture.sqlite3"
    } else {
        "/tmp/omnia_fixture.sqlite3"
    };
    let parsed = parse_session_db_args(&["--session-db".to_owned(), abs.to_owned()])
        .expect("valid absolute session db");
    assert_eq!(parsed, Some(PathBuf::from(abs)));
}

#[test]
fn cli_rejects_malformed_args_and_relative_paths() {
    assert!(parse_session_db_args(&["--unknown".to_owned()]).is_err());
    assert!(parse_session_db_args(&["--session-db".to_owned()]).is_err());
    assert!(parse_session_db_args(&["--session-db".to_owned(), "   ".to_owned()]).is_err());
    assert!(
        parse_session_db_args(&["--session-db".to_owned(), "relative.sqlite".to_owned()]).is_err()
    );
    assert!(
        parse_session_db_args(&["--session-db".to_owned(), "D:\\bad\npath.db".to_owned()]).is_err()
    );

    let abs = r"D:\OmniaData\qa\fixture.sqlite3".to_owned();
    assert!(parse_session_db_args(&[
        "--session-db".to_owned(),
        abs.clone(),
        "--session-db".to_owned(),
        abs,
    ])
    .is_err());
}

#[test]
fn qa_seed_cli_requires_single_absolute_dir() {
    assert!(parse_qa_seed_directory_arg(&[]).is_err());
    assert!(parse_qa_seed_directory_arg(&["a".to_owned(), "b".to_owned()]).is_err());
    assert!(parse_qa_seed_directory_arg(&["relative_dir".to_owned()]).is_err());
    let ok = parse_qa_seed_directory_arg(&[r"D:\OmniaData\qa\fixture-run".to_owned()])
        .expect("valid seed directory");
    assert_eq!(ok, PathBuf::from(r"D:\OmniaData\qa\fixture-run"));
}

#[test]
fn mode_headings_efforts_and_mnemonic_stripping_match_contract() {
    assert_eq!(Mode::from_control_id(ID_MODE_CHAT), Some(Mode::Chat));
    assert_eq!(Mode::from_control_id(ID_MODE_BROWSER), Some(Mode::Browser));
    assert_eq!(Mode::from_control_id(ID_MODE_IDE), Some(Mode::Ide));
    assert_eq!(Mode::from_control_id(999), None);

    assert!(Mode::Chat.heading_text().starts_with("Chat / No project\n"));
    assert!(Mode::Browser.heading_text().starts_with("Browser\n"));
    assert!(Mode::Ide.heading_text().starts_with("IDE\n"));

    assert_eq!(
        EFFORTS,
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    );
    assert_eq!(normalize_effort("MAX"), Some("max"));
    assert_eq!(effort_index("max"), 6);
    assert_eq!(effort_index("unknown"), 3);

    assert_eq!(strip_mnemonic_ampersands("&Yes"), "Yes");
    assert_eq!(strip_mnemonic_ampersands("Save && Close"), "Save & Close");
}

#[test]
fn session_settings_validation_and_dirty_checks() {
    let base = SessionForm::from_persisted("Alpha", "", "medium");
    assert!(!base.is_dirty(&base));

    let same_trimmed = SessionForm::from_persisted("  Alpha  ", "   ", "MEDIUM");
    assert!(!same_trimmed.is_dirty(&base));

    let changed_effort = SessionForm::from_persisted("Alpha", "", "max");
    assert!(changed_effort.is_dirty(&base));

    let empty_model = validate_session_settings_input("Saved guard title", "", "max")
        .expect_err("empty model rejected");
    assert_eq!(empty_model.code, "invalid_input");

    let sentinel_model =
        validate_session_settings_input("Title", UNCONFIGURED_MODEL_SENTINEL, "medium")
            .expect_err("internal sentinel rejected");
    assert_eq!(sentinel_model.code, "invalid_input");

    let ctrl_char = validate_session_settings_input("Bad\x07Title", "qa/model", "high")
        .expect_err("control chars rejected");
    assert_eq!(ctrl_char.code, "invalid_input");

    let valid = validate_session_settings_input(
        "  Native QA — phiên lưu bền  ",
        " qa/model-native ",
        "MAX",
    )
    .expect("unicode title valid");
    assert_eq!(valid.title, "Native QA — phiên lưu bền");
    assert_eq!(valid.model, "qa/model-native");
    assert_eq!(valid.effort, "max");

    assert_eq!(
        format_store_error_status(&empty_model),
        format!("invalid_input: {}", empty_model.message)
    );
}

#[test]
fn store_ownership_crud_cas_and_persistence_roundtrip() {
    let tmp = TempDirGuard::new("crud");
    let db_path = tmp.path.join("sessions.sqlite3");

    {
        let mut store = NativeSessionStore::open(&db_path).expect("open new sqlite store");
        let empty = store.refresh().expect("refresh empty");
        assert!(empty.active_session.is_none());
        assert_eq!(format_snapshot_status(&empty), "No active session.");

        // Second opener on same DB must fail immediately with `harness_store_busy`.
        let conflict = NativeSessionStore::open(&db_path)
            .err()
            .expect("exclusive lock busy");
        assert_eq!(conflict.code, "harness_store_busy");
        assert!(format_store_error_status(&conflict).starts_with("harness_store_busy:"));
        assert!(format_store_error_status(&conflict).contains("No automatic retry"));

        let created = store
            .create_projectless_session("New chat")
            .expect("create projectless chat");
        let active = created.active_session.as_ref().expect("active present");
        assert_eq!(active.title, "New chat");
        assert_eq!(active.ui_model, "");
        assert_eq!(active.reasoning_effort, "medium");
        assert_eq!(active.revision, 1);
        assert!(format_snapshot_status(&created).starts_with("Settings revision 1"));

        // CAS rejection on empty model preserves state & returns `invalid_input`.
        let invalid = store
            .update_settings(&active.id, active.revision, "Edited", "", "max")
            .expect_err("empty model invalid");
        assert_eq!(invalid.code, "invalid_input");

        // Stale CAS revision rejected.
        let stale = store
            .update_settings(&active.id, 999, "Edited", "qa/model-native", "max")
            .expect_err("stale revision rejected");
        assert_eq!(stale.code, "agent_session_revision_conflict");

        let updated = store
            .update_settings(
                &active.id,
                active.revision,
                "Native QA — phiên lưu bền",
                "qa/model-native",
                "max",
            )
            .expect("valid settings save");
        let saved = updated.active_session.as_ref().expect("active after save");
        assert_eq!(saved.title, "Native QA — phiên lưu bền");
        assert_eq!(saved.ui_model, "qa/model-native");
        assert_eq!(saved.reasoning_effort, "max");
        assert_eq!(saved.revision, 2);
        assert!(format_snapshot_status(&updated).starts_with("Settings revision 2"));
    }

    // Reopen after clean drop succeeds and retains UI model + effort.
    let mut reopened = NativeSessionStore::open(&db_path).expect("reopen after drop");
    let snap = reopened.refresh().expect("refresh reopened");
    let active = snap.active_session.as_ref().expect("reopened active");
    assert_eq!(active.title, "Native QA — phiên lưu bền");
    assert_eq!(active.ui_model, "qa/model-native");
    assert_eq!(active.reasoning_effort, "max");
    assert_eq!(active.revision, 2);
}

#[test]
fn paging_fixture_125_rows_and_deleted_select_recovery() {
    let tmp = TempDirGuard::new("paging");
    let db_path = tmp.path.join("sessions.sqlite3");

    let mut store = NativeSessionStore::open(&db_path).expect("open fixture db");
    let page1 = store.seed_paging_fixture().expect("seed 125 rows");

    assert_eq!(page1.page.total_count, 125);
    assert_eq!(page1.page.items.len(), 50);
    assert_eq!(page1.page.items[0].title, "Synthetic session 0000");
    assert_eq!(page1.page.items[49].title, "Synthetic session 0049");
    assert!(!page1.can_go_prev);
    assert!(page1.can_go_next);
    assert!(!page1.active_on_page);
    let active = page1.active_session.as_ref().expect("off-page active");
    assert_eq!(active.title, "Off-page active");
    assert_eq!(active.ui_model, "");
    assert_eq!(active.reasoning_effort, "medium");
    assert_eq!(active.revision, 1);
    let p1_status = format_snapshot_status(&page1);
    assert!(p1_status.starts_with("Settings revision 1"));
    assert!(p1_status.contains("outside this page"));

    let page2 = store.next_page().expect("page 2");
    assert_eq!(page2.page.items.len(), 50);
    assert_eq!(page2.page.items[0].title, "Synthetic session 0050");
    assert!(page2.can_go_prev);
    assert!(page2.can_go_next);

    let page3 = store.next_page().expect("page 3");
    assert_eq!(page3.page.items.len(), 25);
    assert_eq!(page3.page.items[0].title, "Synthetic session 0100");
    assert_eq!(page3.page.items[24].title, "Off-page active");
    assert!(page3.active_on_page);
    assert!(page3.can_go_prev);
    assert!(!page3.can_go_next);

    let back2 = store.prev_page().expect("back to page 2");
    assert_eq!(back2.page.items[0].title, "Synthetic session 0050");

    let reset1 = store.first_page().expect("back to page 1");
    assert_eq!(reset1.page.items[0].title, "Synthetic session 0000");

    // Simulate another writer deleting paging-fixture-0000 (`qa-guard`).
    let _ = store
        .inner_mut()
        .store_mut()
        .delete_agent_session("paging-fixture-0000")
        .expect("delete synthetic row");
    let err = store
        .select_session("paging-fixture-0000")
        .expect_err("select deleted row fails cleanly");
    assert_eq!(err.code, "agent_session_not_found");
    assert!(format_store_error_status(&err).contains("No automatic retry"));
}

#[test]
fn worker_async_startup_busy_and_single_pending_queue_guard() {
    let tmp = TempDirGuard::new("worker");
    let db_path = tmp.path.join("sessions.sqlite3");

    // Hold exclusive ownership from main thread, spawn background worker on same DB.
    let holder = NativeSessionStore::open(&db_path).expect("acquire holder lock");
    let wakes = Arc::new(AtomicUsize::new(0));
    let wakes_clone = Arc::clone(&wakes);
    let mut busy_worker = NativeSessionWorker::spawn(db_path.clone(), move || {
        wakes_clone.fetch_add(1, Ordering::SeqCst);
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    let event = loop {
        if let Some(ev) = busy_worker.take_completed() {
            break ev;
        }
        assert!(Instant::now() < deadline, "startup worker timed out");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(event.is_startup_open);
    let busy_err = event
        .result
        .expect_err("busy startup reports harness_store_busy");
    assert_eq!(busy_err.code, "harness_store_busy");
    assert_eq!(wakes.load(Ordering::SeqCst), 1);
    busy_worker.stop_and_wait();
    drop(holder);

    // After holder releases, worker opens cleanly and stops cleanly.
    let mut good_worker = NativeSessionWorker::spawn(db_path, || {});
    let ok_ev = loop {
        if let Some(ev) = good_worker.take_completed() {
            break ev;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(ok_ev.result.is_ok());
    good_worker.stop_and_wait();

    // Test bounded queue (`MAX_PENDING_SESSION_COMMANDS == 1`) with gated executor.
    assert_eq!(MAX_PENDING_SESSION_COMMANDS, 1);
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let gate_worker = Arc::clone(&gate);
    let mut gated_worker = NativeSessionWorker::spawn_with_executor(
        move |_cmd| {
            let (lock, cv) = &*gate_worker;
            let mut release = lock.lock().expect("lock gate");
            while !*release {
                release = cv.wait(release).expect("wait gate");
            }
            NativeSessionStore::open_in_memory()?.refresh()
        },
        || {},
    );

    let _op1 = gated_worker
        .submit(NativeSessionCommand::Refresh)
        .expect("first command accepted");
    assert!(gated_worker.is_busy());
    let second = gated_worker
        .submit(NativeSessionCommand::NextPage)
        .expect_err("second concurrent command rejected");
    assert_eq!(second.code, "session_worker_busy");

    {
        let (lock, cv) = &*gate;
        let mut release = lock.lock().expect("unlock gate");
        *release = true;
        cv.notify_all();
    }
    while gated_worker.take_completed().is_none() {
        std::thread::sleep(Duration::from_millis(10));
    }
    gated_worker.stop_and_wait();
}

#[test]
fn quality_01_dpi_scaling_and_workarea_clamping_never_clips_across_dpis() {
    assert_eq!(scale_px(100, 96), 100);
    assert_eq!(scale_px(100, 120), 125);
    assert_eq!(scale_px(100, 144), 150);
    assert_eq!(scale_px(100, 192), 200);

    let scenarios = [
        (96u32, RectPx::from_xywh(0, 0, 1920, 1032)),
        (120u32, RectPx::from_xywh(0, 0, 1920, 1032)),
        (144u32, RectPx::from_xywh(0, 0, 1920, 1032)),
        (192u32, RectPx::from_xywh(0, 0, 1920, 1032)),
        (144u32, RectPx::from_xywh(0, 0, 1280, 680)),
        (192u32, RectPx::from_xywh(0, 0, 3840, 2112)),
    ];

    for (dpi, workarea) in scenarios {
        let bounds = clamped_initial_window_bounds(dpi, workarea);
        assert!(
            workarea.contains_rect(bounds),
            "initial bounds {bounds:?} exceeded workarea {workarea:?} at {dpi} DPI"
        );

        let (min_w, min_h) = clamped_min_track_size(dpi, workarea);
        assert!(
            min_w <= workarea.width(),
            "min_w {min_w} > workarea width at {dpi} DPI"
        );
        assert!(
            min_h <= workarea.height(),
            "min_h {min_h} > workarea height at {dpi} DPI"
        );

        // Simulate client area slightly smaller than outer window (~chrome inset 16x40 scaled).
        let chrome_w = scale_px(16, dpi);
        let chrome_h = scale_px(40, dpi);
        let client_w = (bounds.width() - chrome_w).max(320);
        let client_h = (bounds.height() - chrome_h).max(240);

        let shell = compute_shell_layout(client_w, client_h, dpi, Mode::Chat);
        for ctrl in [
            shell.top_bar,
            shell.mode_chat,
            shell.mode_browser,
            shell.mode_ide,
            shell.left_card,
            shell.right_card,
            shell.heading,
            shell.draft_label,
            shell.draft,
            shell.composer_cmd,
            shell.sym_math,
            shell.sym_phys,
            shell.sym_chem,
            shell.composer_badge,
            shell.panel_host,
            shell.footer,
        ] {
            assert!(
                shell.client.contains_rect(ctrl),
                "shell control {ctrl:?} clipped outside client {:?} at {dpi} DPI",
                shell.client
            );
        }
        assert!(!shell.left_card.overlaps(shell.right_card));
        assert!(!shell.left_card.overlaps(shell.footer));
        assert!(!shell.right_card.overlaps(shell.footer));
        assert!(!shell.draft.overlaps(shell.composer_cmd));

        let panel =
            compute_session_panel_layout(shell.panel_host.width(), shell.panel_host.height(), dpi);
        let panel_ctrls = [
            panel.header,
            panel.new_button,
            panel.list,
            panel.prev_button,
            panel.next_button,
            panel.title_label,
            panel.title_edit,
            panel.model_label,
            panel.model_edit,
            panel.effort_label,
            panel.effort_combo,
            panel.save_button,
            panel.status,
            panel.refresh_button,
        ];
        for ctrl in panel_ctrls {
            assert!(
                panel.bounds.contains_rect(ctrl),
                "panel control {ctrl:?} clipped outside {:?} at {dpi} DPI",
                panel.bounds
            );
        }
        assert!(!panel.prev_button.overlaps(panel.next_button));
        assert!(!panel.status.overlaps(panel.refresh_button));
        assert!(!panel.save_button.overlaps(panel.status));
    }
}

#[test]
fn uia_com_button_and_edit_vtables_and_refcounting() {
    let (iid_unk, iid_raw, iid_invoke, iid_value) = iids();

    // Test Button COM provider QueryInterface, Pattern lookup, PropertyValue, and balanced Release.
    // SAFETY: Testing direct COM vtable pointers allocated via `ButtonUiaObject::allocate`.
    unsafe {
        let btn_raw = ButtonUiaObject::allocate(null_mut(), Some("&Save && Exit".to_owned()));
        let vtbl = *btn_raw.cast::<*const IRawElementProviderSimpleVtbl>();

        let mut opts: ProviderOptions = 0;
        assert_eq!(((*vtbl).get_provider_options)(btn_raw, &raw mut opts), S_OK);
        assert_eq!(opts, ProviderOptions_ServerSideProvider);

        // Wrong pattern returns S_OK with null pointer.
        let mut wrong_pat: *mut c_void = std::ptr::dangling_mut::<c_void>();
        assert_eq!(
            ((*vtbl).get_pattern_provider)(btn_raw, UIA_ValuePatternId, &raw mut wrong_pat),
            S_OK
        );
        assert!(wrong_pat.is_null());

        // Invoke pattern succeeds and bumps refcount.
        let mut invoke_pat: *mut c_void = null_mut();
        assert_eq!(
            ((*vtbl).get_pattern_provider)(btn_raw, UIA_InvokePatternId, &raw mut invoke_pat),
            S_OK
        );
        assert!(!invoke_pat.is_null());
        assert_ne!(invoke_pat, btn_raw); // Secondary vptr offset > 0

        // QI from secondary `IInvokeProvider*` back to `IRawElementProviderSimple*` recovers exact `btn_raw`.
        let recovered = com_query_interface(invoke_pat, &iid_raw).expect("QI back to raw");
        assert_eq!(recovered, btn_raw);
        assert_eq!(com_release(recovered), 2);
        assert_eq!(com_release(invoke_pat), 1);

        // ControlType and Name properties.
        let mut var_type: VARIANT = std::mem::zeroed();
        VariantInit(&raw mut var_type);
        assert_eq!(
            ((*vtbl).get_property_value)(btn_raw, UIA_ControlTypePropertyId, &raw mut var_type),
            S_OK
        );
        assert_eq!(var_type.Anonymous.Anonymous.vt, VT_I4);
        assert_eq!(
            var_type.Anonymous.Anonymous.Anonymous.lVal,
            UIA_ButtonControlTypeId
        );
        let _ = VariantClear(&raw mut var_type);

        let mut var_name: VARIANT = std::mem::zeroed();
        VariantInit(&raw mut var_name);
        assert_eq!(
            ((*vtbl).get_property_value)(btn_raw, UIA_NamePropertyId, &raw mut var_name),
            S_OK
        );
        assert_eq!(var_name.Anonymous.Anonymous.vt, VT_BSTR);
        let _ = VariantClear(&raw mut var_name);

        assert_eq!(
            com_query_interface(btn_raw, &iid_value).err(),
            Some(E_NOINTERFACE)
        );
        assert_eq!(com_add_ref(btn_raw), 2);
        assert_eq!(com_release(btn_raw), 1);
        assert_eq!(com_release(btn_raw), 0);
    }

    // Test Edit COM provider QueryInterface, ValuePattern lookup, and ControlType.
    // SAFETY: Testing direct COM vtable pointers allocated via `EditUiaObject::allocate`.
    unsafe {
        let edit_raw = EditUiaObject::allocate(null_mut(), Some("Composer command".to_owned()));
        let vtbl = *edit_raw.cast::<*const IRawElementProviderSimpleVtbl>();

        let mut var_type: VARIANT = std::mem::zeroed();
        VariantInit(&raw mut var_type);
        assert_eq!(
            ((*vtbl).get_property_value)(edit_raw, UIA_ControlTypePropertyId, &raw mut var_type),
            S_OK
        );
        assert_eq!(var_type.Anonymous.Anonymous.vt, VT_I4);
        assert_eq!(
            var_type.Anonymous.Anonymous.Anonymous.lVal,
            UIA_EditControlTypeId
        );
        let _ = VariantClear(&raw mut var_type);

        let mut val_pat: *mut c_void = null_mut();
        assert_eq!(
            ((*vtbl).get_pattern_provider)(edit_raw, UIA_ValuePatternId, &raw mut val_pat),
            S_OK
        );
        assert!(!val_pat.is_null());
        let unk = com_query_interface(val_pat, &iid_unk).expect("QI IUnknown from IValueProvider");
        assert_eq!(unk, edit_raw);
        assert_eq!(
            com_query_interface(edit_raw, &iid_invoke).err(),
            Some(E_NOINTERFACE)
        );
        assert_eq!(com_release(unk), 2);
        assert_eq!(com_release(val_pat), 1);
        assert_eq!(com_release(edit_raw), 0);
    }
}

#[test]
fn composer_model_templates_utf8_caret_and_pdf_safety() {
    let templates = ComposerModel::templates();
    assert_eq!(templates.len(), 15);

    let mut model = ComposerModel::new();
    model.set_draft("Dự án ", 6);
    assert!(model.insert_template_at_caret("math-fraction"));
    assert_eq!(model.draft_text(), r"Dự án $\frac{a}{b}$");

    let cancelled = model.handle_attachment_paste(
        "paper.pdf",
        "application/pdf",
        b"%PDF-1.7\n1 0 obj<<>>endobj\n",
        AttachmentPlacement::Cancel,
    );
    assert!(!cancelled.accepted);
    assert!(model.inline_attachments().is_empty());
    assert!(model.tray_attachments().is_empty());

    let encrypted =
        ComposerModel::inspect_pdf_bytes(b"%PDF-1.7\n1 0 obj<< /Encrypt 2 0 R >>endobj");
    assert!(encrypted.is_encrypted);
    assert!(encrypted.extracted_preview.is_none());
}
