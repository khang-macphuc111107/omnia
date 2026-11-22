use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use omnia_core::sha256_hex;
use omnia_storage::{AttachmentPlacement, SessionStore};
use serde_json::json;

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
            "omnia-storage-{prefix}-{}-{nanos}",
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

#[test]
fn wal_mode_enabled_and_cooperative_lease_enforces_ttl_and_takeover() {
    let temp = TempDirGuard::new("studio-lease");
    let store = SessionStore::open(temp.path.join("studio.db")).expect("open session store");
    assert_eq!(store.journal_mode().expect("journal mode"), "wal");
    assert!(store
        .active_lease(10_000)
        .expect("no initial lease")
        .is_none());

    assert!(store
        .acquire_lease("owner-a", 1001, 5_000, 10_000)
        .expect("lease a"));
    let active = store
        .active_lease(11_000)
        .expect("read active")
        .expect("some");
    assert_eq!(active.owner_id, "owner-a");
    assert_eq!(active.pid, 1001);
    assert_eq!(active.expires_at_ms, 15_000);

    // Competing owner blocked while lease unexpired.
    assert!(!store
        .acquire_lease("owner-b", 1002, 5_000, 11_000)
        .expect("blocked"));
    assert!(!store
        .heartbeat("owner-b", 5_000, 11_000)
        .expect("hb blocked"));

    // Owner A renews TTL.
    assert!(store.heartbeat("owner-a", 5_000, 12_000).expect("hb a"));
    let renewed = store
        .active_lease(16_000)
        .expect("still valid")
        .expect("some");
    assert_eq!(renewed.expires_at_ms, 17_000);

    // Owner B acquires once lease expires.
    assert!(store
        .acquire_lease("owner-b", 1002, 5_000, 17_001)
        .expect("takeover"));
    let taken = store.active_lease(18_000).expect("active b").expect("some");
    assert_eq!(taken.owner_id, "owner-b");

    assert!(store.release_lease("owner-b").expect("release b"));
    assert!(store.active_lease(18_000).expect("released").is_none());
}

#[test]
fn sessions_crud_cas_messages_and_keyset_pagination_work_without_drift() {
    let store = SessionStore::open_in_memory().expect("open memory store");

    let s1 = store
        .create_session("First", "gpt-5.4", "low", 1_000, Some("s-01"))
        .expect("create s1");
    assert_eq!(s1.revision, 1);

    // Tied timestamps break deterministically by id DESC.
    let _s2 = store
        .create_session("Second", "gpt-5.4", "medium", 2_000, Some("s-02"))
        .expect("create s2");
    let _s3 = store
        .create_session("Third", "gpt-5.4", "high", 2_000, Some("s-03"))
        .expect("create s3");
    let _s4 = store
        .upsert_session("s-04", "Fourth", "claude-opus-4-6", "", 3_000)
        .expect("upsert s4");

    let page1 = store.list_sessions_page(2, None).expect("page 1");
    assert_eq!(page1.items.len(), 2);
    assert!(page1.has_more);
    assert_eq!(page1.items[0].id, "s-04");
    assert_eq!(page1.items[1].id, "s-03");

    let page2 = store
        .list_sessions_page(2, page1.next_cursor.as_ref())
        .expect("page 2");
    assert_eq!(page2.items.len(), 2);
    assert!(!page2.has_more);
    assert_eq!(page2.items[0].id, "s-02");
    assert_eq!(page2.items[1].id, "s-01");

    // CAS update succeeds on revision 1, bumps to 2, rejects stale revision 1.
    let updated = store
        .update_session_settings("s-01", "First Renamed", "o3", "high", 4_000, Some(1))
        .expect("cas update");
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.title, "First Renamed");

    let conflict = store
        .update_session_settings("s-01", "Stale", "o3", "low", 5_000, Some(1))
        .expect_err("stale revision must fail");
    assert_eq!(conflict.code, "session_revision_conflict");

    // Messages append in sequence and scrub metadata secrets.
    let synth_key = ["sk", "proj", "0123456789abcdefXYZ"].join("-");
    let meta = json!({ "api_key": synth_key, "token_budget": 8192 }).to_string();
    let m1 = store
        .append_message("s-01", "user", "hello", &meta, 4_100)
        .expect("append msg");
    assert_eq!(m1.seq, 1);
    assert!(!m1.metadata_json.contains(&synth_key));
    assert!(m1.metadata_json.contains("8192"));

    let msgs = store.list_messages("s-01", 0).expect("list msgs");
    assert_eq!(msgs.len(), 1);
    assert!(store.delete_session("s-01").expect("delete s1"));
    assert!(store.get_session("s-01").expect("get deleted").is_none());
    assert!(store
        .list_messages("s-01", 0)
        .expect("deleted msgs")
        .is_empty());
}

#[test]
fn attachments_deduplicate_by_sha256_across_inline_and_tray() {
    let store = SessionStore::open_in_memory().expect("open memory store");
    store
        .create_session("Attach", "gpt-5.4", "medium", 1_000, Some("sess-att"))
        .expect("create session");

    let payload = b"binary\x00png\xffdata";
    let expected_hash = sha256_hex(payload);

    let a1 = store
        .store_attachment(
            "sess-att",
            "msg-1",
            AttachmentPlacement::Inline,
            "shot.png",
            "image/png",
            payload,
            1_010,
        )
        .expect("store inline");
    let a2 = store
        .store_attachment(
            "sess-att",
            "msg-2",
            AttachmentPlacement::Tray,
            "copy.png",
            "image/png",
            payload,
            1_020,
        )
        .expect("store tray");

    assert_eq!(a1.sha256, expected_hash);
    assert_eq!(a2.sha256, expected_hash);
    assert_eq!(store.unique_blob_count().expect("blob count"), 1);

    let listed = store
        .list_session_attachments("sess-att")
        .expect("list attachments");
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].placement, AttachmentPlacement::Inline);
    assert_eq!(listed[1].placement, AttachmentPlacement::Tray);

    assert_eq!(
        store
            .read_blob(&expected_hash)
            .expect("read blob")
            .as_deref(),
        Some(payload.as_slice())
    );
}

#[test]
fn run_journal_redacts_secrets_while_preserving_token_counts() {
    let store = SessionStore::open_in_memory().expect("open memory store");
    let synth_tok = format!("{}{}", "ghp_", "0123456789abcdefghijKLMN");
    let auth_header = ["Bea", "rer ", &synth_tok].concat();
    let payload = json!({
        "Authorization": auth_header,
        "input_tokens": 250,
        "output_tokens": 75,
        "token_budget": 64000
    })
    .to_string();

    let seq = store
        .append_run_journal("sess-j", "run-1", "provider_call", &payload, 5_000)
        .expect("append journal");
    assert_eq!(seq, 1);

    let entries = store.list_run_journal("sess-j", 0).expect("list journal");
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].payload_json.contains(&synth_tok));
    assert!(entries[0].payload_json.contains("[REDACTED]"));
    assert!(entries[0].payload_json.contains("250"));
    assert!(entries[0].payload_json.contains("75"));
    assert!(entries[0].payload_json.contains("64000"));
}
