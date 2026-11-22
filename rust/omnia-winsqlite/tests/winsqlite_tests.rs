use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use omnia_winsqlite::{ColumnType, Connection, StepStatus, StoreOwnership};

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
            "omnia-winsqlite-{prefix}-{}-{nanos}",
            std::process::id()
        ));
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
fn open_read_write_configures_wal_normal_sync_and_foreign_keys() {
    let temp = TempDirGuard::new("wal");
    let db_path = temp.path.join("studio.db");
    let conn = Connection::open_read_write(&db_path).expect("open read-write db");

    assert_eq!(
        conn.query_scalar_text("PRAGMA journal_mode;")
            .expect("query journal_mode")
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("wal")
    );
    assert_eq!(
        conn.query_scalar_text("PRAGMA synchronous;")
            .expect("query synchronous")
            .as_deref(),
        Some("1")
    );
    assert_eq!(
        conn.query_scalar_text("PRAGMA foreign_keys;")
            .expect("query foreign_keys")
            .as_deref(),
        Some("1")
    );
    assert_eq!(
        conn.query_scalar_text("PRAGMA busy_timeout;")
            .expect("query busy_timeout")
            .as_deref(),
        Some("5000")
    );
    assert!(conn.is_autocommit());
    conn.close().expect("close connection");
}

#[test]
fn prepared_statement_bindings_and_column_getters_preserve_empty_and_binary_values() {
    let conn = Connection::open_in_memory().expect("open memory db");
    conn.exec_batch(
        "CREATE TABLE items (\n\
            id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
            txt TEXT,\n\
            num INTEGER,\n\
            flt REAL,\n\
            raw BLOB\n\
        );",
    )
    .expect("create table");

    {
        let mut insert = conn
            .prepare("INSERT INTO items (txt, num, flt, raw) VALUES (?1, ?2, ?3, ?4);")
            .expect("prepare insert");

        insert.bind_text(1, "Tieng Viet — Ω").expect("bind text");
        insert.bind_int64(2, 42).expect("bind int64");
        insert.bind_double(3, 3.25).expect("bind double");
        insert.bind_blob(4, &[0u8, 1, 255, 42]).expect("bind blob");
        assert_eq!(insert.step().expect("step 1"), StepStatus::Done);
        assert_eq!(conn.last_insert_rowid(), 1);
        assert_eq!(conn.changes(), 1);

        insert.reset().expect("reset");
        insert.clear_bindings().expect("clear bindings");
        insert.bind_text(1, "").expect("bind empty text");
        insert.bind_null(2).expect("bind null");
        insert.bind_null(3).expect("bind null");
        insert.bind_blob(4, &[]).expect("bind empty blob");
        assert_eq!(insert.step().expect("step 2"), StepStatus::Done);
    }

    let mut select = conn
        .prepare("SELECT id, txt, num, flt, raw FROM items ORDER BY id ASC;")
        .expect("prepare select");
    assert_eq!(select.column_count(), 5);

    assert_eq!(select.step().expect("row 1"), StepStatus::Row);
    assert_eq!(select.column_int64(0).expect("id 1"), 1);
    assert_eq!(select.column_text(1).expect("txt 1"), "Tieng Viet — Ω");
    assert_eq!(select.column_opt_int64(2).expect("num 1"), Some(42));
    assert!((select.column_double(3).expect("flt 1") - 3.25).abs() < 1e-9);
    assert_eq!(select.column_blob(4).expect("raw 1"), vec![0u8, 1, 255, 42]);

    assert_eq!(select.step().expect("row 2"), StepStatus::Row);
    assert_eq!(select.column_type(1), ColumnType::Text);
    assert_eq!(
        select.column_opt_text(1).expect("empty txt"),
        Some(String::new())
    );
    assert_eq!(select.column_type(2), ColumnType::Null);
    assert_eq!(select.column_opt_int64(2).expect("null num"), None);
    assert_eq!(select.column_type(4), ColumnType::Blob);
    assert_eq!(select.column_blob(4).expect("empty blob"), Vec::<u8>::new());

    assert_eq!(select.step().expect("done"), StepStatus::Done);
}

#[test]
fn transactions_commit_and_drop_rolls_back_uncommitted_changes() {
    let mut conn = Connection::open_in_memory().expect("open memory db");
    conn.exec_batch("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER NOT NULL);")
        .expect("create kv");

    {
        let tx = conn.begin_immediate().expect("begin tx 1");
        assert!(!tx.is_autocommit());
        let mut stmt = tx
            .prepare("INSERT INTO kv (k, v) VALUES ('committed', 1);")
            .expect("prepare");
        stmt.step().expect("step");
        drop(stmt);
        tx.commit().expect("commit tx 1");
    }
    assert!(conn.is_autocommit());

    {
        let tx = conn.begin_immediate().expect("begin tx 2");
        assert!(!tx.is_autocommit());
        tx.exec_batch("INSERT INTO kv (k, v) VALUES ('rolled_back', 2);")
            .expect("insert inside tx 2");
        // Drop without calling commit.
    }
    assert!(conn.is_autocommit());

    let mut count_stmt = conn
        .prepare("SELECT COUNT(*), MAX(v) FROM kv;")
        .expect("count query");
    assert_eq!(count_stmt.step().expect("row"), StepStatus::Row);
    assert_eq!(count_stmt.column_int64(0).expect("count"), 1);
    assert_eq!(count_stmt.column_int64(1).expect("max"), 1);
}

#[test]
fn read_only_connection_does_not_modify_file_or_spawn_sidecars() {
    let temp = TempDirGuard::new("readonly");
    let db_path = temp.path.join("ro.db");

    {
        let conn = Connection::open_read_write(&db_path).expect("open rw");
        conn.exec_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT NOT NULL);\n\
             INSERT INTO items (id, val) VALUES (7, 'seeded');\n\
             PRAGMA journal_mode = DELETE;",
        )
        .expect("seed and reset journal mode");
    }

    let before_bytes = fs::read(&db_path).expect("read db before");
    let ro = Connection::open_read_only(&db_path).expect("open ro");
    let mut stmt = ro
        .prepare("SELECT val FROM items WHERE id = 7;")
        .expect("prepare ro query");
    assert_eq!(stmt.step().expect("row"), StepStatus::Row);
    assert_eq!(stmt.column_text(0).expect("val"), "seeded");
    drop(stmt);

    let write_attempt = ro.exec_batch("INSERT INTO items (id, val) VALUES (8, 'fail');");
    assert!(write_attempt.is_err());
    drop(ro);

    let after_bytes = fs::read(&db_path).expect("read db after");
    assert_eq!(before_bytes, after_bytes);
    let entries: Vec<_> = fs::read_dir(&temp.path)
        .expect("read dir")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect entries");
    assert_eq!(entries.len(), 1);
}

#[test]
fn store_ownership_rejects_second_owner_with_busy_and_releases_on_drop() {
    let temp = TempDirGuard::new("ownership");
    let db_path = temp.path.join("harness.db");

    assert_eq!(
        StoreOwnership::acquire("")
            .expect_err("empty path fails")
            .code,
        "harness_store_ownership_failed"
    );
    assert_eq!(
        StoreOwnership::acquire(&temp.path)
            .expect_err("directory path fails")
            .code,
        "harness_store_ownership_failed"
    );

    let first = StoreOwnership::acquire(&db_path).expect("acquire first lock");
    assert_eq!(first.path(), db_path.as_path());

    let err = StoreOwnership::acquire(&db_path).expect_err("second lock must fail");
    assert_eq!(err.code, "harness_store_busy");
    assert!(err.retryable);

    drop(first);
    let reacquired = StoreOwnership::acquire(&db_path).expect("reacquire after drop");
    drop(reacquired);
}
