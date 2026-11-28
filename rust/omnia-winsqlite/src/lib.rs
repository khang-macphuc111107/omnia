//! Safe RAII bindings over Windows built-in `winsqlite3` and Win32 store ownership locking.

mod error;
mod ffi;
mod ownership;

use std::ffi::{CStr, CString};
use std::ops::Deref;
use std::os::raw::c_int;
use std::path::Path;
use std::ptr::{self, NonNull};
use std::slice;

pub use error::{ColumnType, StepStatus, TxBehavior, WinSqliteError};
pub use ownership::StoreOwnership;

/// Default SQLite busy timeout applied to opened connections (milliseconds).
pub const DEFAULT_BUSY_TIMEOUT_MS: i32 = 5_000;

/// Safe RAII owner of a `sqlite3` database connection.
#[derive(Debug)]
pub struct Connection {
    db: NonNull<ffi::sqlite3>,
}

/// Alias matching the legacy C++ `SqliteConnection` name for smooth porting.
pub type SqliteConnection = Connection;

// SAFETY: Connections are always opened with `SQLITE_OPEN_FULLMUTEX` (or `:memory:`
// with `SQLITE_OPEN_FULLMUTEX`). Moving a `Connection` across threads (`Send`) is
// sound; `Connection` deliberately remains `!Sync` so statements/transactions/errors
// cannot interleave unsynchronized across threads without an external `Mutex`.
unsafe impl Send for Connection {}

impl Connection {
    /// Open (or create) a read-write SQLite database and configure WAL,
    /// `synchronous=NORMAL`, `foreign_keys=ON`, and `busy_timeout(5000)`.
    pub fn open_read_write(path: impl AsRef<Path>) -> Result<Self, WinSqliteError> {
        let path_str = path_to_utf8_str(path.as_ref())?;
        let flags =
            ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE | ffi::SQLITE_OPEN_FULLMUTEX;
        let conn = Self::open_raw(path_str, flags)?;
        conn.busy_timeout(DEFAULT_BUSY_TIMEOUT_MS)?;
        conn.exec_batch(
            "PRAGMA journal_mode = WAL;\n\
             PRAGMA synchronous = NORMAL;\n\
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(conn)
    }

    /// Open an existing SQLite database in strict read-only mode without modifying
    /// journal mode or creating WAL/SHM sidecar files.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, WinSqliteError> {
        let path_str = path_to_utf8_str(path.as_ref())?;
        let flags = ffi::SQLITE_OPEN_READONLY | ffi::SQLITE_OPEN_FULLMUTEX;
        let conn = Self::open_raw(path_str, flags)?;
        conn.busy_timeout(DEFAULT_BUSY_TIMEOUT_MS)?;
        Ok(conn)
    }

    /// Open an isolated in-memory SQLite database with `foreign_keys=ON` and
    /// `busy_timeout(5000)`.
    pub fn open_in_memory() -> Result<Self, WinSqliteError> {
        let flags = ffi::SQLITE_OPEN_READWRITE
            | ffi::SQLITE_OPEN_CREATE
            | ffi::SQLITE_OPEN_MEMORY
            | ffi::SQLITE_OPEN_FULLMUTEX;
        let conn = Self::open_raw(":memory:", flags)?;
        conn.busy_timeout(DEFAULT_BUSY_TIMEOUT_MS)?;
        conn.exec_batch("PRAGMA foreign_keys = ON;")?;
        Ok(conn)
    }

    fn open_raw(filename: &str, flags: c_int) -> Result<Self, WinSqliteError> {
        let c_filename = CString::new(filename).map_err(|_| {
            WinSqliteError::invalid_input("SQLite path contains interior NUL byte.")
        })?;
        let mut raw_db: *mut ffi::sqlite3 = ptr::null_mut();
        // SAFETY: `c_filename` is valid NUL-terminated UTF-8 and `raw_db` is writable stack space.
        let rc =
            unsafe { ffi::sqlite3_open_v2(c_filename.as_ptr(), &mut raw_db, flags, ptr::null()) };
        if rc != ffi::SQLITE_OK {
            let ext = if raw_db.is_null() {
                rc
            } else {
                // SAFETY: `raw_db` was returned by `sqlite3_open_v2` even on failure.
                unsafe { ffi::sqlite3_extended_errcode(raw_db) }
            };
            let msg = if raw_db.is_null() {
                format!("sqlite3_open_v2 failed with rc={rc}")
            } else {
                // SAFETY: `raw_db` is valid until closed below.
                let detail = unsafe { read_db_errmsg(raw_db) };
                format!("sqlite3_open_v2 failed ({rc}): {detail}")
            };
            if !raw_db.is_null() {
                // SAFETY: Prevent handle leak on failed `sqlite3_open_v2`.
                unsafe {
                    ffi::sqlite3_close_v2(raw_db);
                }
            }
            return Err(make_sqlite_error("sqlite_open_failed", msg, ext));
        }

        let db = NonNull::new(raw_db).ok_or_else(|| {
            WinSqliteError::storage_failed("sqlite3_open_v2 succeeded with a null database handle.")
        })?;
        Ok(Self { db })
    }

    /// Explicitly close the SQLite connection and report any error from `sqlite3_close`.
    pub fn close(self) -> Result<(), WinSqliteError> {
        let db = self.db.as_ptr();
        std::mem::forget(self);
        // SAFETY: `db` is uniquely owned here and forgotten above so `Drop` will not close twice.
        let rc = unsafe { ffi::sqlite3_close(db) };
        if rc != ffi::SQLITE_OK {
            // SAFETY: Connection remains open on `SQLITE_BUSY`; read message then defer cleanup with `close_v2`.
            let ext = unsafe { ffi::sqlite3_extended_errcode(db) };
            // SAFETY: `db` is still valid until `sqlite3_close_v2`.
            let msg = unsafe { read_db_errmsg(db) };
            // SAFETY: Ensure handle cannot leak after surfacing the `sqlite3_close` error.
            unsafe {
                ffi::sqlite3_close_v2(db);
            }
            return Err(make_sqlite_error(
                "sqlite_close_failed",
                format!("sqlite3_close failed ({rc}): {msg}"),
                ext,
            ));
        }
        Ok(())
    }

    /// Configure SQLite busy handler timeout in milliseconds.
    pub fn busy_timeout(&self, ms: i32) -> Result<(), WinSqliteError> {
        // SAFETY: `self.db` is valid and open for the lifetime of `&self`.
        let rc = unsafe { ffi::sqlite3_busy_timeout(self.db.as_ptr(), ms) };
        if rc != ffi::SQLITE_OK {
            return Err(self.capture_error(
                "sqlite_pragma_failed",
                "sqlite3_busy_timeout failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Return `true` when the connection is currently in autocommit mode (no active transaction).
    #[must_use]
    pub fn is_autocommit(&self) -> bool {
        // SAFETY: `self.db` is valid and open.
        unsafe { ffi::sqlite3_get_autocommit(self.db.as_ptr()) != 0 }
    }

    /// Execute one or more semicolon-delimited SQL statements that return no rows.
    pub fn exec_batch(&self, sql: &str) -> Result<(), WinSqliteError> {
        let c_sql = CString::new(sql).map_err(|_| {
            WinSqliteError::invalid_input("SQL batch contains an interior NUL byte.")
        })?;
        let mut raw_err: *mut std::os::raw::c_char = ptr::null_mut();
        // SAFETY: `self.db` and `c_sql` are valid; callback is null; `raw_err` receives allocated error text on error.
        let rc = unsafe {
            ffi::sqlite3_exec(
                self.db.as_ptr(),
                c_sql.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                &mut raw_err,
            )
        };
        if rc != ffi::SQLITE_OK {
            let ext = self.extended_errcode();
            let detail = if !raw_err.is_null() {
                // SAFETY: SQLite guarantees `raw_err` is NUL-terminated when non-null.
                let s = unsafe { CStr::from_ptr(raw_err) }
                    .to_string_lossy()
                    .into_owned();
                // SAFETY: Memory returned via `sqlite3_exec`'s errmsg out-param must be freed via `sqlite3_free`.
                unsafe { ffi::sqlite3_free(raw_err.cast()) };
                s
            } else {
                self.errmsg()
            };
            return Err(make_sqlite_error(
                "sqlite_exec_failed",
                format!("sqlite3_exec failed ({rc}): {detail}"),
                if ext != 0 { ext } else { rc },
            ));
        }
        if !raw_err.is_null() {
            // SAFETY: Defensive free if SQLite ever populated `raw_err` unexpectedly.
            unsafe { ffi::sqlite3_free(raw_err.cast()) };
        }
        Ok(())
    }

    /// Prepare a single UTF-8 SQL statement bound to the lifetime of this connection.
    pub fn prepare(&self, sql: &str) -> Result<Statement<'_>, WinSqliteError> {
        let len = i32::try_from(sql.len())
            .map_err(|_| WinSqliteError::invalid_input("SQL statement exceeds i32 byte length."))?;
        if sql.as_bytes().contains(&0) {
            return Err(WinSqliteError::invalid_input(
                "SQL statement contains an interior NUL byte.",
            ));
        }
        let mut raw_stmt: *mut ffi::sqlite3_stmt = ptr::null_mut();
        // SAFETY: `self.db` is valid and `sql` bytes stay valid throughout `sqlite3_prepare_v2`.
        let rc = unsafe {
            ffi::sqlite3_prepare_v2(
                self.db.as_ptr(),
                sql.as_ptr().cast(),
                len,
                &mut raw_stmt,
                ptr::null_mut(),
            )
        };
        if rc != ffi::SQLITE_OK {
            if !raw_stmt.is_null() {
                // SAFETY: Defensive finalize in case SQLite returned a handle on failure.
                unsafe {
                    ffi::sqlite3_finalize(raw_stmt);
                }
            }
            return Err(self.capture_error(
                "sqlite_prepare_failed",
                "sqlite3_prepare_v2 failed",
                rc,
            ));
        }
        let stmt = NonNull::new(raw_stmt).ok_or_else(|| {
            WinSqliteError::invalid_input("Prepared SQL contains no executable statement.")
        })?;
        Ok(Statement { stmt, conn: self })
    }

    /// Execute `PRAGMA journal_mode` or a scalar text pragma/query and return row 0 column 0.
    pub fn query_scalar_text(&self, sql: &str) -> Result<Option<String>, WinSqliteError> {
        let mut stmt = self.prepare(sql)?;
        match stmt.step()? {
            StepStatus::Row => stmt.column_opt_text(0),
            StepStatus::Done => Ok(None),
        }
    }

    /// Run `PRAGMA quick_check(1)` to detect SQLite B-tree corruption cleanly.
    pub fn integrity_check(&self) -> Result<bool, WinSqliteError> {
        Ok(self
            .query_scalar_text("PRAGMA quick_check(1);")?
            .is_some_and(|s| s.eq_ignore_ascii_case("ok")))
    }

    /// Return the rowid of the most recent successful `INSERT` on this connection.
    #[must_use]
    pub fn last_insert_rowid(&self) -> i64 {
        // SAFETY: `self.db` is valid and open.
        unsafe { ffi::sqlite3_last_insert_rowid(self.db.as_ptr()) }
    }

    /// Return the number of rows modified by the most recent `INSERT`, `UPDATE`, or `DELETE`.
    #[must_use]
    pub fn changes(&self) -> i32 {
        // SAFETY: `self.db` is valid and open.
        unsafe { ffi::sqlite3_changes(self.db.as_ptr()) }
    }

    /// Return the extended SQLite error code from the most recent failed API call.
    #[must_use]
    pub fn extended_errcode(&self) -> i32 {
        // SAFETY: `self.db` is valid and open.
        unsafe { ffi::sqlite3_extended_errcode(self.db.as_ptr()) }
    }

    /// Return the UTF-8 error message from the most recent failed API call.
    #[must_use]
    pub fn errmsg(&self) -> String {
        // SAFETY: `self.db` is valid and open.
        unsafe { read_db_errmsg(self.db.as_ptr()) }
    }

    /// Begin a `DEFERRED` transaction that rolls back automatically on drop unless committed.
    pub fn begin_deferred(&mut self) -> Result<Transaction<'_>, WinSqliteError> {
        self.begin(TxBehavior::Deferred)
    }

    /// Begin an `IMMEDIATE` transaction that rolls back automatically on drop unless committed.
    pub fn begin_immediate(&mut self) -> Result<Transaction<'_>, WinSqliteError> {
        self.begin(TxBehavior::Immediate)
    }

    /// Begin a transaction with the requested [`TxBehavior`].
    pub fn begin(&mut self, behavior: TxBehavior) -> Result<Transaction<'_>, WinSqliteError> {
        let sql = match behavior {
            TxBehavior::Deferred => "BEGIN DEFERRED;",
            TxBehavior::Immediate => "BEGIN IMMEDIATE;",
        };
        self.exec_batch(sql)?;
        Ok(Transaction {
            conn: self,
            finished: false,
        })
    }

    fn capture_error(&self, code: &str, prefix: &str, rc: c_int) -> WinSqliteError {
        let ext = self.extended_errcode();
        let effective = if ext != 0 { ext } else { rc };
        let detail = self.errmsg();
        make_sqlite_error(code, format!("{prefix} ({rc}): {detail}"), effective)
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        // SAFETY: `self.db` is uniquely owned and never double-closed (`close` uses `mem::forget`).
        unsafe {
            ffi::sqlite3_close_v2(self.db.as_ptr());
        }
    }
}

/// Safe RAII guard for an active SQLite transaction.
///
/// Dereferences to [`Connection`] so callers can run `tx.prepare(...)` or pass `&*tx`
/// while holding exclusive transactional control. Dropping an uncommitted `Transaction`
/// rolls it back automatically.
#[derive(Debug)]
pub struct Transaction<'conn> {
    conn: &'conn mut Connection,
    finished: bool,
}

/// Alias matching the legacy C++ `SqliteTransaction` name for smooth porting.
pub type SqliteTransaction<'conn> = Transaction<'conn>;

impl<'conn> Transaction<'conn> {
    /// Commit the transaction and consume the guard.
    ///
    /// If `COMMIT;` fails while SQLite leaves the transaction active (for example on a deferred
    /// foreign-key constraint violation or lock error), automatically rolls back before returning
    /// the error so the connection is never left stuck in an open transaction.
    pub fn commit(mut self) -> Result<(), WinSqliteError> {
        let res = self.conn.exec_batch("COMMIT;");
        if res.is_ok() {
            self.finished = true;
        } else if !self.conn.is_autocommit() {
            let _ = self.conn.exec_batch("ROLLBACK;");
            self.finished = true;
        } else {
            self.finished = true;
        }
        res
    }

    /// Explicitly roll back the transaction and consume the guard.
    pub fn rollback(mut self) -> Result<(), WinSqliteError> {
        self.finished = true;
        if !self.conn.is_autocommit() {
            self.conn.exec_batch("ROLLBACK;")?;
        }
        Ok(())
    }
}

impl Deref for Transaction<'_> {
    type Target = Connection;

    fn deref(&self) -> &Self::Target {
        self.conn
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.finished && !self.conn.is_autocommit() {
            let _ = self.conn.exec_batch("ROLLBACK;");
        }
    }
}

/// Safe RAII owner of a prepared `sqlite3_stmt` bound to its parent [`Connection`].
#[derive(Debug)]
pub struct Statement<'conn> {
    stmt: NonNull<ffi::sqlite3_stmt>,
    conn: &'conn Connection,
}

impl Statement<'_> {
    /// Advance the prepared statement to the next result row or completion.
    pub fn step(&mut self) -> Result<StepStatus, WinSqliteError> {
        // SAFETY: `self.stmt` is valid and unfinalized while `&mut self` lives.
        let rc = unsafe { ffi::sqlite3_step(self.stmt.as_ptr()) };
        match rc {
            ffi::SQLITE_ROW => Ok(StepStatus::Row),
            ffi::SQLITE_DONE => Ok(StepStatus::Done),
            other => {
                Err(self
                    .conn
                    .capture_error("sqlite_step_failed", "sqlite3_step failed", other))
            }
        }
    }

    /// Advance the statement and return `true` if a row is ready, or `false` when done.
    pub fn step_row(&mut self) -> Result<bool, WinSqliteError> {
        Ok(matches!(self.step()?, StepStatus::Row))
    }

    /// Reset a prepared statement back to its initial state for re-execution.
    pub fn reset(&mut self) -> Result<(), WinSqliteError> {
        // SAFETY: `self.stmt` is valid.
        let rc = unsafe { ffi::sqlite3_reset(self.stmt.as_ptr()) };
        if rc != ffi::SQLITE_OK {
            return Err(self
                .conn
                .capture_error("sqlite_reset_failed", "sqlite3_reset failed", rc));
        }
        Ok(())
    }

    /// Clear all previously bound parameters back to SQL `NULL`.
    pub fn clear_bindings(&mut self) -> Result<(), WinSqliteError> {
        // SAFETY: `self.stmt` is valid.
        let rc = unsafe { ffi::sqlite3_clear_bindings(self.stmt.as_ptr()) };
        if rc != ffi::SQLITE_OK {
            return Err(self.conn.capture_error(
                "sqlite_bind_failed",
                "sqlite3_clear_bindings failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Bind SQL `NULL` to 1-based parameter `index`.
    pub fn bind_null(&mut self, index: i32) -> Result<(), WinSqliteError> {
        // SAFETY: `self.stmt` is valid.
        let rc = unsafe { ffi::sqlite3_bind_null(self.stmt.as_ptr(), index) };
        if rc != ffi::SQLITE_OK {
            return Err(self.conn.capture_error(
                "sqlite_bind_failed",
                "sqlite3_bind_null failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Bind a 64-bit signed integer to 1-based parameter `index`.
    pub fn bind_int64(&mut self, index: i32, value: i64) -> Result<(), WinSqliteError> {
        // SAFETY: `self.stmt` is valid.
        let rc = unsafe { ffi::sqlite3_bind_int64(self.stmt.as_ptr(), index, value) };
        if rc != ffi::SQLITE_OK {
            return Err(self.conn.capture_error(
                "sqlite_bind_failed",
                "sqlite3_bind_int64 failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Bind an optional 64-bit signed integer (`None` -> SQL `NULL`).
    pub fn bind_opt_int64(&mut self, index: i32, value: Option<i64>) -> Result<(), WinSqliteError> {
        match value {
            Some(v) => self.bind_int64(index, v),
            None => self.bind_null(index),
        }
    }

    /// Bind a 64-bit float to 1-based parameter `index`.
    pub fn bind_double(&mut self, index: i32, value: f64) -> Result<(), WinSqliteError> {
        // SAFETY: `self.stmt` is valid.
        let rc = unsafe { ffi::sqlite3_bind_double(self.stmt.as_ptr(), index, value) };
        if rc != ffi::SQLITE_OK {
            return Err(self.conn.capture_error(
                "sqlite_bind_failed",
                "sqlite3_bind_double failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Bind a UTF-8 string using `SQLITE_TRANSIENT` (empty string binds empty TEXT `""`, not NULL).
    pub fn bind_text(&mut self, index: i32, value: &str) -> Result<(), WinSqliteError> {
        let len = i32::try_from(value.len()).map_err(|_| {
            WinSqliteError::invalid_input("Bound text parameter exceeds i32 byte length.")
        })?;
        // Pass a non-null pointer for empty slices so SQLite binds `""` instead of `NULL`.
        let ptr = if value.is_empty() {
            b"".as_ptr().cast()
        } else {
            value.as_ptr().cast()
        };
        // SAFETY: `self.stmt` is valid; `ptr` points to `len` valid bytes and `SQLITE_TRANSIENT` copies immediately.
        let rc = unsafe {
            ffi::sqlite3_bind_text(
                self.stmt.as_ptr(),
                index,
                ptr,
                len,
                ffi::SQLITE_TRANSIENT_PTR,
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(self.conn.capture_error(
                "sqlite_bind_failed",
                "sqlite3_bind_text failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Bind an optional UTF-8 string (`None` -> SQL `NULL`).
    pub fn bind_opt_text(&mut self, index: i32, value: Option<&str>) -> Result<(), WinSqliteError> {
        match value {
            Some(text) => self.bind_text(index, text),
            None => self.bind_null(index),
        }
    }

    /// Bind a binary blob using `SQLITE_TRANSIENT` (empty slice binds empty BLOB `X''`, not NULL).
    pub fn bind_blob(&mut self, index: i32, value: &[u8]) -> Result<(), WinSqliteError> {
        let len = i32::try_from(value.len()).map_err(|_| {
            WinSqliteError::invalid_input("Bound blob parameter exceeds i32 byte length.")
        })?;
        let ptr = if value.is_empty() {
            b"".as_ptr().cast()
        } else {
            value.as_ptr().cast()
        };
        // SAFETY: `self.stmt` is valid; `ptr` points to `len` valid bytes and `SQLITE_TRANSIENT` copies immediately.
        let rc = unsafe {
            ffi::sqlite3_bind_blob(
                self.stmt.as_ptr(),
                index,
                ptr,
                len,
                ffi::SQLITE_TRANSIENT_PTR,
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(self.conn.capture_error(
                "sqlite_bind_failed",
                "sqlite3_bind_blob failed",
                rc,
            ));
        }
        Ok(())
    }

    /// Return the number of columns in the prepared statement's result set.
    #[must_use]
    pub fn column_count(&self) -> i32 {
        // SAFETY: `self.stmt` is valid.
        unsafe { ffi::sqlite3_column_count(self.stmt.as_ptr()) }
    }

    /// Return the SQLite storage class for 0-based column `col`.
    #[must_use]
    pub fn column_type(&self, col: i32) -> ColumnType {
        // SAFETY: `self.stmt` is valid.
        match unsafe { ffi::sqlite3_column_type(self.stmt.as_ptr(), col) } {
            ffi::SQLITE_INTEGER => ColumnType::Integer,
            ffi::SQLITE_FLOAT => ColumnType::Float,
            ffi::SQLITE_TEXT => ColumnType::Text,
            ffi::SQLITE_BLOB => ColumnType::Blob,
            ffi::SQLITE_NULL => ColumnType::Null,
            _ => ColumnType::Null,
        }
    }

    /// Return `true` when 0-based column `col` is SQL `NULL`.
    #[must_use]
    pub fn column_is_null(&self, col: i32) -> bool {
        self.column_type(col) == ColumnType::Null
    }

    /// Read 0-based column `col` as `i64`.
    pub fn column_int64(&self, col: i32) -> Result<i64, WinSqliteError> {
        self.validate_column_index(col)?;
        // SAFETY: `self.stmt` is valid and column index was range-checked.
        Ok(unsafe { ffi::sqlite3_column_int64(self.stmt.as_ptr(), col) })
    }

    /// Read 0-based column `col` as `Option<i64>` (`None` when SQL `NULL`).
    pub fn column_opt_int64(&self, col: i32) -> Result<Option<i64>, WinSqliteError> {
        self.validate_column_index(col)?;
        if self.column_is_null(col) {
            return Ok(None);
        }
        // SAFETY: `self.stmt` is valid and column index was range-checked.
        Ok(Some(unsafe {
            ffi::sqlite3_column_int64(self.stmt.as_ptr(), col)
        }))
    }

    /// Read 0-based column `col` as `f64`.
    pub fn column_double(&self, col: i32) -> Result<f64, WinSqliteError> {
        self.validate_column_index(col)?;
        // SAFETY: `self.stmt` is valid and column index was range-checked.
        Ok(unsafe { ffi::sqlite3_column_double(self.stmt.as_ptr(), col) })
    }

    /// Read 0-based column `col` as a UTF-8 `String` (empty string on SQL `NULL`).
    pub fn column_text(&self, col: i32) -> Result<String, WinSqliteError> {
        Ok(self.column_opt_text(col)?.unwrap_or_default())
    }

    /// Read 0-based column `col` as `Option<String>` (`None` on SQL `NULL`).
    pub fn column_opt_text(&self, col: i32) -> Result<Option<String>, WinSqliteError> {
        self.validate_column_index(col)?;
        if self.column_is_null(col) {
            return Ok(None);
        }
        // Call `column_text` before `column_bytes` per SQLite C API pointer-stability rule.
        // SAFETY: `self.stmt` is valid and column index was range-checked.
        let ptr = unsafe { ffi::sqlite3_column_text(self.stmt.as_ptr(), col) };
        if ptr.is_null() {
            return Ok(Some(String::new()));
        }
        // SAFETY: Must follow `sqlite3_column_text` without intervening type conversions.
        let len = unsafe { ffi::sqlite3_column_bytes(self.stmt.as_ptr(), col) };
        if len <= 0 {
            return Ok(Some(String::new()));
        }
        // SAFETY: `ptr` is non-null and SQLite guarantees `len` readable bytes until next step/finalize/conversion.
        let bytes = unsafe { slice::from_raw_parts(ptr, len as usize) };
        let text = std::str::from_utf8(bytes).map_err(|err| {
            WinSqliteError::storage_failed(format!(
                "SQLite text column {col} is invalid UTF-8: {err}"
            ))
        })?;
        Ok(Some(text.to_owned()))
    }

    /// Read 0-based column `col` as a raw `Vec<u8>` blob (empty vector for SQL `NULL` or `X''`).
    pub fn column_blob(&self, col: i32) -> Result<Vec<u8>, WinSqliteError> {
        self.validate_column_index(col)?;
        if self.column_is_null(col) {
            return Ok(Vec::new());
        }
        // Call `column_blob` before `column_bytes` per SQLite C API pointer-stability rule.
        // SAFETY: `self.stmt` is valid and column index was range-checked.
        let ptr = unsafe { ffi::sqlite3_column_blob(self.stmt.as_ptr(), col) };
        // SAFETY: Follows `sqlite3_column_blob` cleanly.
        let len = unsafe { ffi::sqlite3_column_bytes(self.stmt.as_ptr(), col) };
        if ptr.is_null() || len <= 0 {
            return Ok(Vec::new());
        }
        // SAFETY: `ptr` is non-null and points to `len` readable bytes.
        let bytes = unsafe { slice::from_raw_parts(ptr.cast::<u8>(), len as usize) };
        Ok(bytes.to_vec())
    }

    fn validate_column_index(&self, col: i32) -> Result<(), WinSqliteError> {
        let count = self.column_count();
        if col < 0 || col >= count {
            return Err(WinSqliteError::invalid_input(format!(
                "Column index {col} is out of bounds for statement with {count} column(s)."
            )));
        }
        Ok(())
    }
}

impl Drop for Statement<'_> {
    fn drop(&mut self) {
        // SAFETY: `self.stmt` is uniquely owned and dropped before its borrowed `Connection`.
        unsafe {
            ffi::sqlite3_finalize(self.stmt.as_ptr());
        }
    }
}

fn path_to_utf8_str(path: &Path) -> Result<&str, WinSqliteError> {
    if path.as_os_str().is_empty() {
        return Err(WinSqliteError::invalid_input(
            "SQLite database path cannot be empty.",
        ));
    }
    path.to_str()
        .ok_or_else(|| WinSqliteError::invalid_input("SQLite database path is not valid UTF-8."))
}

fn make_sqlite_error(code: &str, message: String, sqlite_code: i32) -> WinSqliteError {
    let retryable = (sqlite_code & 0xFF) == ffi::SQLITE_BUSY;
    WinSqliteError::sqlite(code, message, sqlite_code, retryable)
}

/// SAFETY: Caller must guarantee `db` is a valid non-null `sqlite3*`.
unsafe fn read_db_errmsg(db: *mut ffi::sqlite3) -> String {
    // SAFETY: Caller guarantees `db` is valid.
    let ptr = unsafe { ffi::sqlite3_errmsg(db) };
    if ptr.is_null() {
        return "unknown sqlite error".to_owned();
    }
    // SAFETY: `sqlite3_errmsg` returns a static or connection-owned NUL-terminated UTF-8 string.
    unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integrity_check_passes_on_healthy_db() {
        let conn = Connection::open_in_memory().expect("open memory db");
        conn.exec_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);")
            .expect("create table");
        assert!(conn.integrity_check().expect("integrity check"));
    }

    #[test]
    fn failed_commit_rolls_back_and_restores_autocommit() {
        let mut conn = Connection::open_in_memory().expect("open memory db");
        conn.exec_batch(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY);\n\
             CREATE TABLE child (\n\
                 id INTEGER PRIMARY KEY,\n\
                 parent_id INTEGER NOT NULL REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED\n\
             );",
        )
        .expect("create schema");

        let tx = conn.begin_immediate().expect("begin tx");
        tx.exec_batch("INSERT INTO child (id, parent_id) VALUES (1, 999);")
            .expect("deferred FK allows insert until commit");
        assert!(
            tx.commit().is_err(),
            "deferred FK violation must fail commit"
        );
        assert!(
            conn.is_autocommit(),
            "failed commit must roll back so connection returns to autocommit"
        );

        // Subsequent transaction must succeed without 'cannot start a transaction within a transaction'.
        let tx2 = conn
            .begin_immediate()
            .expect("subsequent begin_immediate must succeed");
        tx2.exec_batch("INSERT INTO parent (id) VALUES (999);")
            .expect("insert parent");
        tx2.commit().expect("commit parent");
    }
}
