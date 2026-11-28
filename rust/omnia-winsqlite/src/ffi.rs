use core::ffi::{c_char, c_int, c_void};

#[repr(C)]
pub struct sqlite3 {
    _private: [u8; 0],
}

#[repr(C)]
pub struct sqlite3_stmt {
    _private: [u8; 0],
}

pub const SQLITE_OK: c_int = 0;
pub const SQLITE_BUSY: c_int = 5;
pub const SQLITE_ROW: c_int = 100;
pub const SQLITE_DONE: c_int = 101;

pub const SQLITE_INTEGER: c_int = 1;
pub const SQLITE_FLOAT: c_int = 2;
pub const SQLITE_TEXT: c_int = 3;
pub const SQLITE_BLOB: c_int = 4;
pub const SQLITE_NULL: c_int = 5;

pub const SQLITE_OPEN_READONLY: c_int = 0x0000_0001;
pub const SQLITE_OPEN_READWRITE: c_int = 0x0000_0002;
pub const SQLITE_OPEN_CREATE: c_int = 0x0000_0004;
pub const SQLITE_OPEN_MEMORY: c_int = 0x0000_0080;
pub const SQLITE_OPEN_FULLMUTEX: c_int = 0x0001_0000;

/// Equivalent to `((sqlite3_destructor_type)-1)` passed as an opaque pointer
/// so Rust never constructs an invalid function-pointer value.
pub const SQLITE_TRANSIENT_PTR: *const c_void = (-1isize) as *const c_void;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    pub fn CreateFileW(
        lp_file_name: *const u16,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *const c_void,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: *mut c_void,
    ) -> *mut c_void;
}

#[cfg(not(windows))]
pub unsafe fn CreateFileW(
    _lp_file_name: *const u16,
    _dw_desired_access: u32,
    _dw_share_mode: u32,
    _lp_security_attributes: *const c_void,
    _dw_creation_disposition: u32,
    _dw_flags_and_attributes: u32,
    _h_template_file: *mut c_void,
) -> *mut c_void {
    core::ptr::null_mut()
}

#[cfg(windows)]
#[link(name = "winsqlite3")]
extern "system" {
    pub fn sqlite3_open_v2(
        filename: *const c_char,
        pp_db: *mut *mut sqlite3,
        flags: c_int,
        z_vfs: *const c_char,
    ) -> c_int;
    pub fn sqlite3_close(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_close_v2(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_exec(
        db: *mut sqlite3,
        sql: *const c_char,
        callback: *const c_void,
        arg: *mut c_void,
        errmsg: *mut *mut c_char,
    ) -> c_int;
    pub fn sqlite3_prepare_v2(
        db: *mut sqlite3,
        z_sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut sqlite3_stmt,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    pub fn sqlite3_step(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_finalize(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_reset(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_clear_bindings(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_bind_null(stmt: *mut sqlite3_stmt, index: c_int) -> c_int;
    pub fn sqlite3_bind_int64(stmt: *mut sqlite3_stmt, index: c_int, value: i64) -> c_int;
    pub fn sqlite3_bind_double(stmt: *mut sqlite3_stmt, index: c_int, value: f64) -> c_int;
    pub fn sqlite3_bind_text(
        stmt: *mut sqlite3_stmt,
        index: c_int,
        value: *const c_char,
        n: c_int,
        destructor: *const c_void,
    ) -> c_int;
    pub fn sqlite3_bind_blob(
        stmt: *mut sqlite3_stmt,
        index: c_int,
        value: *const c_void,
        n: c_int,
        destructor: *const c_void,
    ) -> c_int;
    pub fn sqlite3_column_count(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_column_type(stmt: *mut sqlite3_stmt, col: c_int) -> c_int;
    pub fn sqlite3_column_int64(stmt: *mut sqlite3_stmt, col: c_int) -> i64;
    pub fn sqlite3_column_double(stmt: *mut sqlite3_stmt, col: c_int) -> f64;
    pub fn sqlite3_column_text(stmt: *mut sqlite3_stmt, col: c_int) -> *const u8;
    pub fn sqlite3_column_blob(stmt: *mut sqlite3_stmt, col: c_int) -> *const c_void;
    pub fn sqlite3_column_bytes(stmt: *mut sqlite3_stmt, col: c_int) -> c_int;
    pub fn sqlite3_busy_timeout(db: *mut sqlite3, ms: c_int) -> c_int;
    pub fn sqlite3_errmsg(db: *mut sqlite3) -> *const c_char;
    pub fn sqlite3_extended_errcode(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_changes(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_last_insert_rowid(db: *mut sqlite3) -> i64;
    pub fn sqlite3_get_autocommit(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_free(ptr: *mut c_void);
}

#[cfg(not(windows))]
#[link(name = "sqlite3")]
extern "C" {
    pub fn sqlite3_open_v2(
        filename: *const c_char,
        pp_db: *mut *mut sqlite3,
        flags: c_int,
        z_vfs: *const c_char,
    ) -> c_int;
    pub fn sqlite3_close(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_close_v2(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_exec(
        db: *mut sqlite3,
        sql: *const c_char,
        callback: *const c_void,
        arg: *mut c_void,
        errmsg: *mut *mut c_char,
    ) -> c_int;
    pub fn sqlite3_prepare_v2(
        db: *mut sqlite3,
        z_sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut sqlite3_stmt,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    pub fn sqlite3_step(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_finalize(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_reset(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_clear_bindings(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_bind_null(stmt: *mut sqlite3_stmt, index: c_int) -> c_int;
    pub fn sqlite3_bind_int64(stmt: *mut sqlite3_stmt, index: c_int, value: i64) -> c_int;
    pub fn sqlite3_bind_double(stmt: *mut sqlite3_stmt, index: c_int, value: f64) -> c_int;
    pub fn sqlite3_bind_text(
        stmt: *mut sqlite3_stmt,
        index: c_int,
        value: *const c_char,
        n: c_int,
        destructor: *const c_void,
    ) -> c_int;
    pub fn sqlite3_bind_blob(
        stmt: *mut sqlite3_stmt,
        index: c_int,
        value: *const c_void,
        n: c_int,
        destructor: *const c_void,
    ) -> c_int;
    pub fn sqlite3_column_count(stmt: *mut sqlite3_stmt) -> c_int;
    pub fn sqlite3_column_type(stmt: *mut sqlite3_stmt, col: c_int) -> c_int;
    pub fn sqlite3_column_int64(stmt: *mut sqlite3_stmt, col: c_int) -> i64;
    pub fn sqlite3_column_double(stmt: *mut sqlite3_stmt, col: c_int) -> f64;
    pub fn sqlite3_column_text(stmt: *mut sqlite3_stmt, col: c_int) -> *const u8;
    pub fn sqlite3_column_blob(stmt: *mut sqlite3_stmt, col: c_int) -> *const c_void;
    pub fn sqlite3_column_bytes(stmt: *mut sqlite3_stmt, col: c_int) -> c_int;
    pub fn sqlite3_busy_timeout(db: *mut sqlite3, ms: c_int) -> c_int;
    pub fn sqlite3_errmsg(db: *mut sqlite3) -> *const c_char;
    pub fn sqlite3_extended_errcode(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_changes(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_last_insert_rowid(db: *mut sqlite3) -> i64;
    pub fn sqlite3_get_autocommit(db: *mut sqlite3) -> c_int;
    pub fn sqlite3_free(ptr: *mut c_void);
}
