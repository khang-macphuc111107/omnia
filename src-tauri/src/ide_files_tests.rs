use super::*;

struct TestFolder {
    path: PathBuf,
    cleanup: PathBuf,
}
impl TestFolder {
    fn new(label: &str) -> Self {
        // Keep each test's root under its own private parent. Other tests pin
        // the shared system temp directory with strict ancestor sharing; a
        // sibling rename must not depend on the harness scheduling those tests
        // serially.
        let container =
            std::env::temp_dir().join(format!("omnia-ide-{label}-{}", Uuid::new_v4().simple()));
        let path = container.join("root");
        fs::create_dir_all(&path).unwrap();
        Self {
            path: dunce::canonicalize(path).unwrap(),
            cleanup: container,
        }
    }
    fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for TestFolder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.cleanup);
    }
}

fn scope() -> ScopeStamp {
    ScopeStamp {
        project_id: None,
        revision: 1,
        path_hash: "path-hash".to_owned(),
    }
}
fn request(permission: &IdeWritePermission, expected: &str, content: &str) -> WriteIdeFileRequest {
    WriteIdeFileRequest {
        grant_id: permission.grant_id.clone(),
        permission_id: permission.permission_id.clone(),
        relative_path: "note.txt".to_owned(),
        expected_content_sha256: expected.to_owned(),
        content: content.to_owned(),
    }
}

#[cfg(windows)]
fn externally_move_source(folder: &Path, destination: &str) {
    use std::ffi::OsStr;

    // The production save intentionally keeps the destination parent open
    // without DELETE sharing. Exercise the same handle-relative POSIX rename
    // primitive used by the writer so this seam models an external replacement
    // instead of failing first in Win32's path-based wrapper with ERROR_SHARING_VIOLATION.
    let pins = pin_directories(folder, "note.txt").unwrap();
    let source = windows_file_ops::open_child_for_rename(&pins, OsStr::new("note.txt")).unwrap();
    windows_file_ops::rename_child(&source, &pins, OsStr::new(destination)).unwrap();
    drop(source);
}

#[test]
fn relative_paths_reject_traversal_absolute_ads_device_and_alias_names() {
    for path in [
        "",
        "../outside",
        "a/../outside",
        "a//b",
        "/outside",
        "C:/outside",
        "\\\\host\\share",
        "note.txt:stream",
        "a/./b",
        "NUL.txt",
        "COM1",
        "note.txt.",
        "dir /note",
        "a\u{0}b",
        "a\nb",
    ] {
        assert!(
            normalized_relative(path).is_err(),
            "unexpected accepted path: {path:?}"
        );
    }
    assert_eq!(
        normalized_relative("src\\note.txt").unwrap(),
        "src/note.txt"
    );
}

#[test]
fn permission_is_bound_to_grant_scope_root_identity_and_session_registry() {
    let folder = TestFolder::new("approval");
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    assert_eq!(permission.scope, "session");
    assert!(registry
        .authorize(
            &permission.permission_id,
            "workspace_a",
            folder.path(),
            &scope()
        )
        .is_ok());
    assert_eq!(
        registry
            .authorize(
                &permission.permission_id,
                "workspace_b",
                folder.path(),
                &scope()
            )
            .unwrap_err()
            .code,
        "ide_write_permission_denied"
    );
    let mut newer = scope();
    newer.revision += 1;
    assert_eq!(
        registry
            .authorize(
                &permission.permission_id,
                "workspace_a",
                folder.path(),
                &newer
            )
            .unwrap_err()
            .code,
        "ide_write_permission_denied"
    );
    assert!(
        ApprovalRegistry::default()
            .authorize(
                &permission.permission_id,
                "workspace_a",
                folder.path(),
                &scope()
            )
            .is_err(),
        "write approvals must not survive native restart"
    );
    assert!(registry.revoke(&permission.permission_id));
    assert!(registry
        .authorize(
            &permission.permission_id,
            "workspace_a",
            folder.path(),
            &scope()
        )
        .is_err());
}

#[test]
fn approved_reads_return_exact_utf8_hash_and_reject_missing_binary_or_large_files() {
    let folder = TestFolder::new("read");
    fs::write(folder.path().join("note.txt"), "\u{feff}before\r\n").unwrap();
    let observed = read_ide_file("workspace_a", folder.path(), "note.txt").unwrap();
    assert_eq!(observed.content, "\u{feff}before\r\n");
    assert_eq!(observed.content_sha256, hash(observed.content.as_bytes()));
    assert_eq!(
        read_ide_file("workspace_a", folder.path(), "missing.txt")
            .unwrap_err()
            .code,
        "ide_source_missing"
    );
    fs::write(folder.path().join("binary"), b"a\0b").unwrap();
    assert_eq!(
        read_ide_file("workspace_a", folder.path(), "binary")
            .unwrap_err()
            .code,
        "binary_file"
    );
    fs::write(folder.path().join("invalid"), [0xff, 0xfe]).unwrap();
    assert_eq!(
        read_ide_file("workspace_a", folder.path(), "invalid")
            .unwrap_err()
            .code,
        "unsupported_encoding"
    );
    fs::write(folder.path().join("large"), vec![b'a'; MAX_IDE_BYTES + 1]).unwrap();
    assert_eq!(
        read_ide_file("workspace_a", folder.path(), "large")
            .unwrap_err()
            .code,
        "file_too_large"
    );
}

#[cfg(windows)]
#[test]
fn hash_checked_save_replaces_atomically_and_keeps_crlf_bom_and_permissions() {
    let folder = TestFolder::new("save");
    let original = "\u{feff}before\r\n";
    fs::write(folder.path().join("note.txt"), original).unwrap();
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    let submitted = "\u{feff}after\r\n";
    let result = write_ide_file(
        &registry,
        folder.path(),
        &scope(),
        &request(&permission, &hash(original.as_bytes()), submitted),
        || {},
    )
    .unwrap();
    match result {
        IdeSaveResult::Saved {
            file, receipt_id, ..
        } => {
            assert_eq!(file.content, submitted);
            assert_eq!(file.content_sha256, hash(submitted.as_bytes()));
            assert!(receipt_id.starts_with("ide_save_"));
        }
        result => panic!("unexpected save: {result:?}"),
    }
    assert_eq!(
        fs::read_to_string(folder.path().join("note.txt")).unwrap(),
        submitted
    );
    assert_eq!(
        fs::read_dir(folder.path()).unwrap().count(),
        1,
        "no staging files may remain"
    );
}

#[cfg(windows)]
#[test]
fn conflict_missing_and_revoked_permission_do_not_overwrite_or_recreate() {
    let folder = TestFolder::new("reject");
    fs::write(folder.path().join("note.txt"), "external").unwrap();
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    let write = request(&permission, &hash(b"before"), "draft");
    assert!(matches!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {}).unwrap(),
        IdeSaveResult::Conflict { .. }
    ));
    assert_eq!(
        fs::read_to_string(folder.path().join("note.txt")).unwrap(),
        "external"
    );
    fs::remove_file(folder.path().join("note.txt")).unwrap();
    assert!(matches!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {}).unwrap(),
        IdeSaveResult::Missing { .. }
    ));
    assert!(!folder.path().join("note.txt").exists());
    registry.revoke(&permission.permission_id);
    assert_eq!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {})
            .unwrap_err()
            .code,
        "ide_write_permission_denied"
    );
}

#[cfg(windows)]
#[test]
fn external_replacement_or_deletion_during_staging_returns_conflict_or_missing() {
    for deleted in [false, true] {
        let folder = TestFolder::new("race");
        fs::write(folder.path().join("note.txt"), "before").unwrap();
        let mut registry = ApprovalRegistry::default();
        let permission = registry
            .issue("workspace_a", folder.path(), &scope())
            .unwrap();
        let result = write_ide_file(
            &registry,
            folder.path(),
            &scope(),
            &request(&permission, &hash(b"before"), "draft"),
            || {
                externally_move_source(folder.path(), "removed-source.txt");
                if !deleted {
                    fs::write(folder.path().join("note.txt"), "external").unwrap();
                }
            },
        )
        .unwrap();
        // The save's parent pins are intentionally live through the callback;
        // remove the moved fixture only after the operation releases them.
        fs::remove_file(folder.path().join("removed-source.txt")).unwrap();
        if deleted {
            assert!(matches!(result, IdeSaveResult::Missing { .. }));
            assert!(!folder.path().join("note.txt").exists());
        } else {
            assert!(matches!(result, IdeSaveResult::Conflict { .. }));
            assert_eq!(
                fs::read_to_string(folder.path().join("note.txt")).unwrap(),
                "external"
            );
        }
        assert_eq!(
            fs::read_dir(folder.path()).unwrap().count(),
            usize::from(!deleted)
        );
    }
}

#[cfg(windows)]
#[test]
fn directory_handles_prevent_parent_swap_and_source_handle_blocks_in_place_writes() {
    let folder = TestFolder::new("locks");
    fs::create_dir(folder.path().join("nested")).unwrap();
    fs::write(folder.path().join("nested/note.txt"), "before").unwrap();
    let pins = pin_directories(folder.path(), "nested/note.txt").unwrap();
    assert!(fs::rename(folder.path().join("nested"), folder.path().join("moved")).is_err());
    let observed = observe(&pins, "workspace_a", "nested/note.txt").unwrap();
    assert!(fs::write(folder.path().join("nested/note.txt"), "unsafe").is_err());
    drop(observed);
    drop(pins);
    assert_eq!(
        fs::read_to_string(folder.path().join("nested/note.txt")).unwrap(),
        "before"
    );
}

#[cfg(windows)]
#[test]
fn child_io_and_replacement_use_the_pinned_parent_not_an_absolute_path_prefix() {
    let folder = TestFolder::new("relative-parent");
    let outside = TestFolder::new("relative-outside");
    fs::write(folder.path().join("note.txt"), "before").unwrap();
    fs::write(outside.path().join("note.txt"), "external").unwrap();
    let mut pins = pin_directories(folder.path(), "note.txt").unwrap();
    // Even a changed path prefix cannot redirect child opens or replacement:
    // the file name is resolved against the retained parent HANDLE. This seam
    // proves the API boundary, without claiming a packaged reparse-race run.
    pins.target = outside.path().join("note.txt");
    let observed = observe(&pins, "workspace_a", "note.txt").unwrap();
    assert_eq!(observed.record.content, "before");
    let mut staging = StagingFile::create(&pins).unwrap();
    staging.handle.write_all(b"after").unwrap();
    staging.handle.sync_all().unwrap();
    staging.replace(&pins).unwrap();
    drop(staging);
    assert_eq!(
        observe(&pins, "workspace_a", "note.txt")
            .unwrap()
            .record
            .content,
        "after"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("note.txt")).unwrap(),
        "external"
    );
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn invalid_hash_oversized_binary_and_readonly_saves_leave_original_intact() {
    let folder = TestFolder::new("invalid-save");
    fs::write(folder.path().join("note.txt"), "before").unwrap();
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    let mut write = request(&permission, &hash(b"before"), "draft");
    write.expected_content_sha256 = "invalid".to_owned();
    assert_eq!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {})
            .unwrap_err()
            .code,
        "invalid_input"
    );
    write.expected_content_sha256 = hash(b"before");
    write.content = "a".repeat(MAX_IDE_BYTES + 1);
    assert_eq!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {})
            .unwrap_err()
            .code,
        "file_too_large"
    );
    write.content = "a\0b".to_owned();
    assert_eq!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {})
            .unwrap_err()
            .code,
        "binary_file"
    );
    write.content = "draft".to_owned();
    let path = folder.path().join("note.txt");
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    let original_permissions = permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    assert_eq!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {})
            .unwrap_err()
            .code,
        "ide_permission_denied"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "before");
    fs::set_permissions(&path, original_permissions).unwrap();
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn revoked_scope_at_precommit_cleans_staging_without_replacing_source() {
    let folder = TestFolder::new("revoke-race");
    fs::write(folder.path().join("note.txt"), "before").unwrap();
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    let write = request(&permission, &hash(b"before"), "draft");
    let result = write_ide_file_checked(
        &registry,
        folder.path(),
        &scope(),
        &write,
        || {},
        || Err(permission_denied()),
    );
    assert_eq!(result.unwrap_err().code, "ide_write_permission_denied");
    assert_eq!(
        fs::read_to_string(folder.path().join("note.txt")).unwrap(),
        "before"
    );
    assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
}

#[cfg(windows)]
#[test]
fn write_approval_rejects_same_path_with_different_root_identity() {
    let folder = TestFolder::new("root-identity");
    let replacement = TestFolder::new("root-identity-replacement");
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    // Model a same-path replacement by retaining a different directory
    // identity while presenting the approved path value. The authorization
    // check must reject the handle identity mismatch before any write.
    let mut replacement_pins = pin_directories(replacement.path(), "").unwrap();
    replacement_pins.root = folder.path().to_path_buf();
    assert_eq!(
        registry
            .authorize_pinned(
                &permission.permission_id,
                "workspace_a",
                &replacement_pins,
                &scope()
            )
            .unwrap_err()
            .code,
        "ide_write_permission_denied"
    );
}

#[cfg(windows)]
#[test]
fn junction_escape_is_rejected_without_touching_external_bytes() {
    use std::os::windows::fs::symlink_dir;
    let folder = TestFolder::new("links");
    let outside = TestFolder::new("outside");
    fs::write(outside.path().join("note.txt"), "external").unwrap();
    // Developer Mode or elevation is required for symbolic links. Junction
    // creation uses the OS mklink builtin and does not execute downloaded code.
    let link = folder.path().join("escape");
    if symlink_dir(outside.path(), &link).is_err() {
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "the negative test requires a real junction"
        );
    }
    assert_eq!(
        read_ide_file("workspace_a", folder.path(), "escape/note.txt")
            .unwrap_err()
            .code,
        "ide_reparse_path"
    );
    let mut registry = ApprovalRegistry::default();
    let permission = registry
        .issue("workspace_a", folder.path(), &scope())
        .unwrap();
    let mut write = request(&permission, &hash(b"external"), "draft");
    write.relative_path = "escape/note.txt".to_owned();
    assert_eq!(
        write_ide_file(&registry, folder.path(), &scope(), &write, || {})
            .unwrap_err()
            .code,
        "ide_reparse_path"
    );
    assert_eq!(
        fs::read_to_string(outside.path().join("note.txt")).unwrap(),
        "external"
    );
    fs::remove_dir(link).unwrap();
}
