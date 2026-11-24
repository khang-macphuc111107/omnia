//! PTC / Code Mode (`run_code`) — Confined `rquickjs 0.12` JS Sandbox exposing
//! typed `tools.*` & `tools.mcp.*` host bindings with `maxParallelSubCalls`,
//! per-call `PermissionsEngine` + lifecycle hooks, memory/stack caps, and zero OS escape.

use anyhow::{bail, Result};
use futures_util::future::BoxFuture;
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const DEFAULT_PTC_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_PARALLEL_SUB_CALLS: usize = 6;
const MAX_ALLOWED_PARALLEL_SUB_CALLS: usize = 16;
const MAX_TOTAL_SUB_CALLS: usize = 64;
const PTC_MEMORY_LIMIT_BYTES: usize = 32 * 1024 * 1024;
const PTC_STACK_LIMIT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtcInnerToolOutput {
    pub content: String,
    pub is_error: bool,
    pub duration_ms: u64,
}

/// Callback invoked for EVERY inner tool call inside `run_code` (must enforce
/// `PermissionsEngine` + `HookRegistry` on every call!).
pub type PtcToolInvoker =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, PtcInnerToolOutput> + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtcRunRequest {
    pub code: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_parallel_sub_calls: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtcRunResult {
    pub ok: bool,
    pub value: Value,
    pub logs: Vec<String>,
    pub sub_calls_executed: usize,
    pub parallel_batches: usize,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Executes untrusted agent-generated JavaScript inside a strictly confined QuickJS VM.
pub async fn run_code_sandbox(req: PtcRunRequest, invoker: PtcToolInvoker) -> Result<PtcRunResult> {
    if let Some(ref lang) = req.language {
        let lower = lang.trim().to_ascii_lowercase();
        if !lower.is_empty() && !matches!(lower.as_str(), "js" | "javascript" | "ts" | "typescript")
        {
            bail!("unsupported PTC language `{lang}` (supported: javascript)");
        }
    }
    if req.code.trim().is_empty() {
        bail!("run_code `code` must not be empty");
    }

    let timeout_ms = req.timeout_ms.unwrap_or(DEFAULT_PTC_TIMEOUT_MS).clamp(250, 120_000);
    let max_parallel = req
        .max_parallel_sub_calls
        .unwrap_or(DEFAULT_MAX_PARALLEL_SUB_CALLS)
        .clamp(1, MAX_ALLOWED_PARALLEL_SUB_CALLS);

    let rt_handle = tokio::runtime::Handle::current();
    let started = Instant::now();
    let code = req.code.clone();

    tokio::task::spawn_blocking(move || {
        execute_quickjs_sync(&code, timeout_ms, max_parallel, rt_handle, invoker, started)
    })
    .await
    .map_err(|e| anyhow::anyhow!("PTC worker join failed: {e}"))?
}

fn execute_quickjs_sync(
    code: &str,
    timeout_ms: u64,
    max_parallel: usize,
    rt_handle: tokio::runtime::Handle,
    invoker: PtcToolInvoker,
    started: Instant,
) -> Result<PtcRunResult> {
    let runtime = Runtime::new().map_err(|e| anyhow::anyhow!("QuickJS runtime init: {e}"))?;
    runtime.set_memory_limit(PTC_MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(PTC_STACK_LIMIT_BYTES);

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

    let context = Context::full(&runtime)
        .map_err(|e| anyhow::anyhow!("QuickJS context init: {e}"))?;

    let sub_calls = Arc::new(AtomicUsize::new(0));
    let parallel_batches = Arc::new(AtomicUsize::new(0));
    let logs: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let inv_single = Arc::clone(&invoker);
    let handle_single = rt_handle.clone();
    let sub_single = Arc::clone(&sub_calls);

    let inv_batch = Arc::clone(&invoker);
    let handle_batch = rt_handle;
    let sub_batch = Arc::clone(&sub_calls);
    let batches_ref = Arc::clone(&parallel_batches);

    let logs_ref = Arc::clone(&logs);

    let js_res: Result<(bool, Value, Option<String>)> = context.with(|ctx| {
        let globals = ctx.globals();

        let log_fn = Function::new(ctx.clone(), move |msg: String| {
            if let Ok(mut g) = logs_ref.lock() {
                if g.len() < 256 {
                    g.push(msg);
                }
            }
        })
        .map_err(|e| anyhow::anyhow!("bind __omnia_log: {e}"))?;
        globals
            .set("__omnia_log", log_fn)
            .map_err(|e| anyhow::anyhow!("set __omnia_log: {e}"))?;

        let single_fn = Function::new(ctx.clone(), move |tool_name: String, args_json: String| -> String {
            if tool_name == "run_code" {
                return json!({ "is_error": true, "content": "recursive run_code disallowed" }).to_string();
            }
            let count = sub_single.fetch_add(1, Ordering::Relaxed) + 1;
            if count > MAX_TOTAL_SUB_CALLS {
                return json!({
                    "is_error": true,
                    "content": format!("PTC exceeded max_total_sub_calls ({MAX_TOTAL_SUB_CALLS})")
                })
                .to_string();
            }
            let parsed_args: Value = serde_json::from_str(&args_json).unwrap_or_else(|_| json!({}));
            let out = handle_single.block_on(inv_single(tool_name, parsed_args));
            serde_json::to_string(&out).unwrap_or_else(|e| {
                json!({ "is_error": true, "content": format!("serialize failed: {e}") }).to_string()
            })
        })
        .map_err(|e| anyhow::anyhow!("bind __omnia_call: {e}"))?;
        globals
            .set("__omnia_call", single_fn)
            .map_err(|e| anyhow::anyhow!("set __omnia_call: {e}"))?;

        let batch_fn = Function::new(ctx.clone(), move |calls_json: String| -> String {
            let Ok(items) = serde_json::from_str::<Vec<Value>>(&calls_json) else {
                return json!([{ "is_error": true, "content": "invalid calls array for tools.parallel" }]).to_string();
            };
            let prev = sub_batch.fetch_add(items.len(), Ordering::Relaxed);
            if prev + items.len() > MAX_TOTAL_SUB_CALLS {
                return json!([{
                    "is_error": true,
                    "content": format!("PTC batch exceeded max_total_sub_calls ({MAX_TOTAL_SUB_CALLS})")
                }])
                .to_string();
            }
            batches_ref.fetch_add(1, Ordering::Relaxed);

            let sem = Arc::new(Semaphore::new(max_parallel));
            let inv = Arc::clone(&inv_batch);
            let outs: Vec<PtcInnerToolOutput> = handle_batch.block_on(async move {
                let futs = items.into_iter().map(|entry| {
                    let sem = Arc::clone(&sem);
                    let inv = Arc::clone(&inv);
                    async move {
                        let _permit = sem.acquire_owned().await.ok();
                        let (tname, targs) = if let Some(arr) = entry.as_array() {
                            (
                                arr.first().and_then(Value::as_str).unwrap_or("").to_owned(),
                                arr.get(1).cloned().unwrap_or_else(|| json!({})),
                            )
                        } else {
                            (
                                entry.get("tool").and_then(Value::as_str).unwrap_or("").to_owned(),
                                entry.get("args").cloned().unwrap_or_else(|| json!({})),
                            )
                        };
                        if tname.is_empty() || tname == "run_code" {
                            return PtcInnerToolOutput {
                                content: "invalid or recursive tool name in tools.parallel".into(),
                                is_error: true,
                                duration_ms: 0,
                            };
                        }
                        inv(tname, targs).await
                    }
                });
                futures_util::future::join_all(futs).await
            });
            serde_json::to_string(&outs).unwrap_or_else(|_| "[]".into())
        })
        .map_err(|e| anyhow::anyhow!("bind __omnia_call_batch: {e}"))?;
        globals
            .set("__omnia_call_batch", batch_fn)
            .map_err(|e| anyhow::anyhow!("set __omnia_call_batch: {e}"))?;

        let prelude = build_sdk_prelude(max_parallel);
        ctx.eval::<(), _>(prelude.as_bytes())
            .map_err(|e| anyhow::anyhow!("PTC SDK prelude failed: {e}"))?;

        let user_script = format!(
            r#"
globalThis.__omnia_done = false;
globalThis.__omnia_ok = false;
globalThis.__omnia_res = null;
globalThis.__omnia_err = null;
(async () => {{
{code}
}})().then(
    (v) => {{
        globalThis.__omnia_done = true;
        globalThis.__omnia_ok = true;
        globalThis.__omnia_res = (v === undefined) ? null : JSON.stringify(v);
    }},
    (e) => {{
        globalThis.__omnia_done = true;
        globalThis.__omnia_ok = false;
        const m = (e && e.message) ? ((e.name ? e.name + ': ' : '') + e.message) : String(e);
        const st = (e && e.stack) ? String(e.stack) : '';
        globalThis.__omnia_err = st ? (st.includes(m) ? st : (m + '\n' + st)) : m;
    }}
);
"#
        );
        ctx.eval::<(), _>(user_script.as_bytes())
            .map_err(|e| anyhow::anyhow!("PTC eval error: {e}"))?;

        Ok((false, Value::Null, None))
    });

    if let Err(err) = js_res {
        return Ok(PtcRunResult {
            ok: false,
            value: Value::Null,
            logs: logs.lock().map(|g| g.clone()).unwrap_or_default(),
            sub_calls_executed: sub_calls.load(Ordering::Relaxed),
            parallel_batches: parallel_batches.load(Ordering::Relaxed),
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            error: Some(err.to_string()),
        });
    }

    // Drain promise jobs generated by `(async () => { ... })()` cleanly.
    while runtime.is_job_pending() {
        if let Err(e) = runtime.execute_pending_job() {
            return Ok(PtcRunResult {
                ok: false,
                value: Value::Null,
                logs: logs.lock().map(|g| g.clone()).unwrap_or_default(),
                sub_calls_executed: sub_calls.load(Ordering::Relaxed),
                parallel_batches: parallel_batches.load(Ordering::Relaxed),
                duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
                error: Some(format!("PTC async job error: {:?}", e)),
            });
        }
    }

    let (ok, value, error) = context.with(|ctx| -> Result<(bool, Value, Option<String>)> {
        let g = ctx.globals();
        let ok_flag: bool = g.get("__omnia_ok").unwrap_or(false);
        let err_opt: Option<String> = g.get("__omnia_err").unwrap_or(None);
        let res_str: Option<String> = g.get("__omnia_res").unwrap_or(None);
        let val = match res_str {
            Some(s) => serde_json::from_str(&s).unwrap_or(Value::String(s)),
            None => Value::Null,
        };
        Ok((ok_flag, val, err_opt))
    })?;

    Ok(PtcRunResult {
        ok,
        value,
        logs: logs.lock().map(|g| g.clone()).unwrap_or_default(),
        sub_calls_executed: sub_calls.load(Ordering::Relaxed),
        parallel_batches: parallel_batches.load(Ordering::Relaxed),
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        error,
    })
}

fn build_sdk_prelude(max_parallel: usize) -> String {
    format!(
        r#"
globalThis.console = {{
    log: (...xs) => __omnia_log(xs.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
    warn: (...xs) => __omnia_log('[warn] ' + xs.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
    error: (...xs) => __omnia_log('[error] ' + xs.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')),
}};
function __invoke(name, args) {{
    const raw = __omnia_call(name, JSON.stringify(args || {{}}));
    const parsed = JSON.parse(raw);
    if (parsed.is_error) {{
        throw new Error(name + ': ' + parsed.content);
    }}
    try {{ return JSON.parse(parsed.content); }} catch (_) {{ return parsed.content; }}
}}
globalThis.tools = {{
    maxParallelSubCalls: {max_parallel},
    read_file: (args) => __invoke('read_file', typeof args === 'string' ? {{ path: args }} : args),
    search_code: (args) => __invoke('search_code', typeof args === 'string' ? {{ query: args }} : args),
    edit_file: (args) => __invoke('edit_file', args),
    write_file: (args) => __invoke('write_file', args),
    apply_patch: (args) => __invoke('apply_patch', typeof args === 'string' ? {{ patch: args }} : args),
    patch_file: (args) => __invoke('patch_file', typeof args === 'string' ? {{ patch: args }} : args),
    workspace_map: (args) => __invoke('workspace_map', typeof args === 'string' ? {{ query: args }} : (args || {{}})),
    shell: (args) => __invoke('shell', typeof args === 'string' ? {{ command: args }} : args),
    run_shell: (args) => __invoke('shell', typeof args === 'string' ? {{ command: args }} : args),
    ast_edit: (args) => __invoke('ast_edit', args),
    ast_grep: (args) => __invoke('ast_grep', args),
    lsp_query: (args) => __invoke('lsp_query', args),
    pty: (args) => __invoke('pty_exec', args),
    dap: (args) => __invoke('dap', args),
    web_fetch: (args) => __invoke('web_fetch', typeof args === 'string' ? {{ url: args }} : args),
    web_search: (args) => __invoke('web_search', typeof args === 'string' ? {{ query: args }} : args),
    browser: (args) => __invoke('browser', args),
    parallel: (calls) => {{
        const raw = __omnia_call_batch(JSON.stringify(calls || []));
        return JSON.parse(raw).map(item => {{
            if (item.is_error) return {{ ok: false, error: item.content }};
            try {{ return {{ ok: true, value: JSON.parse(item.content) }}; }}
            catch (_) {{ return {{ ok: true, value: item.content }}; }}
        }});
    }},
    mcp: {{
        search: (query, limit = 10) => __invoke('discover_tools', {{ query, limit }}),
        call: (name_or_server, arguments_obj, tool_name) => __invoke('mcp_call', {{
            tool: name_or_server,
            server_tool: tool_name || null,
            arguments: arguments_obj || {{}},
        }}),
    }},
}};
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ptc_sandbox_runs_parallel_typed_sdk_and_isolates_os() {
        let invoker: PtcToolInvoker = Arc::new(|name, args| {
            Box::pin(async move {
                match name.as_str() {
                    "read_file" => PtcInnerToolOutput {
                        content: format!("content of {}", args["path"].as_str().unwrap_or("")),
                        is_error: false,
                        duration_ms: 1,
                    },
                    "lsp_query" => PtcInnerToolOutput {
                        content: json!({"diagnostics": 0, "symbol": args["symbol"]}).to_string(),
                        is_error: false,
                        duration_ms: 1,
                    },
                    _ => PtcInnerToolOutput {
                        content: format!("denied: {name}"),
                        is_error: true,
                        duration_ms: 0,
                    },
                }
            })
        });

        let out = run_code_sandbox(
            PtcRunRequest {
                code: r#"
                    console.log("starting batch");
                    const batch = tools.parallel([
                        ["read_file", { path: "a.rs" }],
                        ["read_file", { path: "b.rs" }],
                        ["lsp_query", { symbol: "Router" }],
                    ]);
                    return { count: batch.length, first: batch[0].value, diag: batch[2].value.diagnostics };
                "#
                .into(),
                language: Some("javascript".into()),
                timeout_ms: Some(5_000),
                max_parallel_sub_calls: Some(4),
            },
            invoker.clone(),
        )
        .await
        .expect("ptc run");

        assert!(out.ok, "PTC error: {:?}", out.error);
        assert_eq!(out.value["count"], json!(3));
        assert_eq!(out.value["first"], json!("content of a.rs"));
        assert_eq!(out.value["diag"], json!(0));
        assert_eq!(out.sub_calls_executed, 3);
        assert_eq!(out.parallel_batches, 1);

        // Zero host escape: `require` / `process` / `fetch` must be strictly undefined.
        let esc = run_code_sandbox(
            PtcRunRequest {
                code: r#"return { req: typeof require, proc: typeof process, f: typeof fetch };"#.into(),
                language: None,
                timeout_ms: Some(2_000),
                max_parallel_sub_calls: None,
            },
            invoker,
        )
        .await
        .expect("escape check");
        assert!(esc.ok);
        assert_eq!(esc.value["req"], json!("undefined"));
        assert_eq!(esc.value["proc"], json!("undefined"));
        assert_eq!(esc.value["f"], json!("undefined"));
    }
}
