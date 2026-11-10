//! sqlite_query (read-only) and sqlite_execute (writes).

use async_trait::async_trait;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{display_path, finish, parse_input, truncate_chars};
use crate::{EffectClass, HarnessResult, Tool, ToolContext, ToolOutput, ToolSpec};

const DEFAULT_MAX_ROWS: usize = 200;
const HARD_MAX_ROWS: usize = 10_000;
const MAX_CELL_CHARS: usize = 200;

pub struct SqliteQueryTool;
pub struct SqliteExecuteTool;

#[derive(Deserialize)]
struct Args {
    path: String,
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
    max_rows: Option<usize>,
}

fn schema(write: bool) -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "SQLite database file (absolute or relative to the working directory)."},
            "sql": {"type": "string", "description": if write {
                "A single SQL statement (INSERT/UPDATE/DELETE/CREATE/...)."
            } else {
                "A single read-only SQL statement (SELECT, PRAGMA table_info, EXPLAIN, ...)."
            }},
            "params": {"type": "array", "description": "Positional parameters bound to `?` placeholders (null, boolean, number or string).", "items": {}},
            "max_rows": {"type": "integer", "minimum": 1, "description": "Maximum rows to return (default 200, max 10000)."}
        },
        "required": ["path", "sql"],
        "additionalProperties": false
    })
}

#[async_trait]
impl Tool for SqliteQueryTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "sqlite_query".into(),
            description: "Run one read-only SQL statement against a SQLite database file (opened \
read-only) and return the result as a table with column names. Statements that would modify the \
database are rejected; use sqlite_execute for those."
                .into(),
            input_schema: schema(false),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::ReadWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Query {}: {}",
            input["path"].as_str().unwrap_or("?"),
            super::short(input["sql"].as_str().unwrap_or("?"))
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(run(ctx, input, false).await)
    }
}

#[async_trait]
impl Tool for SqliteExecuteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "sqlite_execute".into(),
            description: "Run one SQL statement that may modify a SQLite database file (created \
if missing). Returns the number of affected rows, or the result table for statements that return \
rows (e.g. RETURNING). The database file is checkpointed first so the change can be undone."
                .into(),
            input_schema: schema(true),
        }
    }

    fn effect(&self) -> EffectClass {
        EffectClass::WriteWorkspace
    }

    fn describe(&self, input: &Value) -> String {
        format!(
            "Execute on {}: {}",
            input["path"].as_str().unwrap_or("?"),
            super::short(input["sql"].as_str().unwrap_or("?"))
        )
    }

    async fn call(&self, ctx: &ToolContext, input: Value) -> HarnessResult<ToolOutput> {
        finish(run(ctx, input, true).await)
    }
}

async fn run(ctx: &ToolContext, input: Value, write: bool) -> Result<ToolOutput, String> {
    let args: Args = parse_input(input)?;
    let path = ctx.resolve(&args.path);
    if write {
        ctx.checkpoint_before(&path)?;
    } else if !path.is_file() {
        return Err(format!("database file not found: {}", path.display()));
    }
    let shown = display_path(ctx, &path);
    let max_rows = args
        .max_rows
        .unwrap_or(DEFAULT_MAX_ROWS)
        .clamp(1, HARD_MAX_ROWS);
    let work = tokio::task::spawn_blocking(move || execute(&path, &args, max_rows, write));
    let text = tokio::select! {
        joined = work => joined.map_err(|error| format!("sqlite task failed: {error}"))??,
        _ = ctx.cancel.cancelled() => return Err("cancelled".into()),
    };
    Ok(ToolOutput::text(format!("{shown}\n{text}")))
}

fn to_sql(value: &Value) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().ok_or("unsupported number parameter")?),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => return Err(format!("unsupported parameter type: {other}")),
    })
}

fn cell(value: ValueRef<'_>) -> String {
    let raw = match value {
        ValueRef::Null => return "NULL".into(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => return format!("<blob {} bytes>", b.len()),
    };
    truncate_chars(&raw.replace(['\n', '\r'], " "), MAX_CELL_CHARS)
}

fn execute(
    path: &std::path::Path,
    args: &Args,
    max_rows: usize,
    write: bool,
) -> Result<String, String> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
    };
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(&args.sql)
        .map_err(|error| format!("SQL error: {error}"))?;
    if !write && !stmt.readonly() {
        return Err(
            "this statement would modify the database; sqlite_query is read-only - use sqlite_execute"
                .into(),
        );
    }
    let params = args
        .params
        .iter()
        .map(to_sql)
        .collect::<Result<Vec<_>, _>>()?;
    let columns = stmt.column_count();
    if columns == 0 {
        let changed = stmt
            .execute(rusqlite::params_from_iter(params.iter()))
            .map_err(|error| format!("SQL error: {error}"))?;
        return Ok(format!("OK, {changed} row(s) affected"));
    }
    let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(|error| format!("SQL error: {error}"))?;
    let mut out = format!("{}\n", names.join(" | "));
    let mut count = 0usize;
    let mut truncated = false;
    while let Some(row) = rows.next().map_err(|error| format!("SQL error: {error}"))? {
        if count == max_rows {
            truncated = true;
            break;
        }
        let fields: Vec<String> = (0..columns)
            .map(|i| row.get_ref(i).map(cell).unwrap_or_else(|e| e.to_string()))
            .collect();
        out.push_str(&fields.join(" | "));
        out.push('\n');
        count += 1;
    }
    out.push_str(&format!("({count} row(s))"));
    if truncated {
        out.push_str(&format!(
            "\n[truncated at {max_rows} rows; add LIMIT/OFFSET or raise max_rows]"
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Block;
    use tempfile::tempdir;

    fn text(out: &ToolOutput) -> String {
        match &out.content[0] {
            Block::Text { text } => text.clone(),
            other => panic!("not text: {other:?}"),
        }
    }

    fn seed(dir: &tempfile::TempDir) {
        let conn = Connection::open(dir.path().join("t.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB);
             INSERT INTO people(name, score, data) VALUES ('ann', 1.5, x'0102'), ('bob', NULL, NULL), ('cy', 3, NULL);",
        )
        .unwrap();
    }

    #[tokio::test]
    async fn query_table_params_and_truncation() {
        let dir = tempdir().unwrap();
        seed(&dir);
        let ctx = ToolContext::new(dir.path());
        let out = SqliteQueryTool
            .call(
                &ctx,
                json!({"path": "t.db", "sql": "SELECT id, name, score, data FROM people WHERE id >= ? ORDER BY id", "params": [1]}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(!out.is_error, "{t}");
        assert!(t.contains("id | name | score | data"), "{t}");
        assert!(t.contains("1 | ann | 1.5 | <blob 2 bytes>"), "{t}");
        assert!(t.contains("2 | bob | NULL | NULL"), "{t}");
        assert!(t.contains("(3 row(s))"));
        let out = SqliteQueryTool
            .call(
                &ctx,
                json!({"path": "t.db", "sql": "SELECT name FROM people", "max_rows": 2}),
            )
            .await
            .unwrap();
        let t = text(&out);
        assert!(
            t.contains("(2 row(s))") && t.contains("truncated at 2"),
            "{t}"
        );
    }

    #[tokio::test]
    async fn query_rejects_writes_and_missing_db() {
        let dir = tempdir().unwrap();
        seed(&dir);
        let ctx = ToolContext::new(dir.path());
        let out = SqliteQueryTool
            .call(&ctx, json!({"path": "t.db", "sql": "DELETE FROM people"}))
            .await
            .unwrap();
        assert!(out.is_error && text(&out).contains("sqlite_execute"));
        let out = SqliteQueryTool
            .call(&ctx, json!({"path": "nope.db", "sql": "SELECT 1"}))
            .await
            .unwrap();
        assert!(out.is_error);
        assert!(!dir.path().join("nope.db").exists());
        let out = SqliteQueryTool
            .call(&ctx, json!({"path": "t.db", "sql": "SELEC"}))
            .await
            .unwrap();
        assert!(out.is_error);
        let conn = Connection::open(dir.path().join("t.db")).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM people", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }

    #[tokio::test]
    async fn execute_writes() {
        let dir = tempdir().unwrap();
        seed(&dir);
        let ctx = ToolContext::new(dir.path());
        assert_eq!(SqliteExecuteTool.effect(), EffectClass::WriteWorkspace);
        let out = SqliteExecuteTool
            .call(
                &ctx,
                json!({"path": "t.db", "sql": "UPDATE people SET score = ? WHERE name = ?", "params": [9, "bob"]}),
            )
            .await
            .unwrap();
        assert!(
            !out.is_error && text(&out).contains("1 row(s) affected"),
            "{}",
            text(&out)
        );
        let out = SqliteExecuteTool
            .call(&ctx, json!({"path": "new.db", "sql": "CREATE TABLE x(a)"}))
            .await
            .unwrap();
        assert!(!out.is_error);
        assert!(dir.path().join("new.db").exists());
        let out = SqliteQueryTool
            .call(
                &ctx,
                json!({"path": "t.db", "sql": "SELECT score FROM people WHERE name = 'bob'"}),
            )
            .await
            .unwrap();
        assert!(text(&out).contains("\n9\n"), "{}", text(&out));
    }
}
