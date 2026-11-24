//! `omnia`: Ultra-lightweight headless Full Native Rust CLI entrypoint.
//!
//! Uses `MiMalloc` global allocator with ZERO GUI, Studio, Downloader, or Notebook
//! dependencies for `<15 ms` cold start, `<30 MB` RSS, and `<10 MB` release binary size.
//!
//! Commands:
//! - `omnia --version` / `-V`
//! - `omnia --profile-startup [--out <json>]`
//! - `omnia run --workspace <dir> --model <id> --base-url <url> [--api-key <key>]
//!     [--wire-api auto|chat|responses|messages|gemini] [--thinking minimal|low|medium|high]
//!     [--output-format stream-json|json|text] [--auto-approve | --approval-mode <mode>]
//!     [--max-turns N] [--timeout-secs S] [--prompt-file <path>] [--trajectory <path>]
//!     [--out <json>] "<prompt>"`
//! - `omnia --acp [--model <id>] [--base-url <url>] [--api-key <key>]`
//! - `omnia rewind --workspace <dir> --turn <n> [--session <id>]`

use anyhow::{bail, Context, Result};
use mimalloc::MiMalloc;
use omnia_agent::{
    default_omnia_data_dir, process_tree_rss_bytes, redact_secrets, run_acp_http_server,
    run_acp_stdio_server, run_super_eval, sanitize_windows_path, AgentStore, ApprovalMode,
    FileReadTracker, HarnessEventSink, HarnessStreamEvent, PermissionsEngine, PluginRegistry,
    SuperEvalOptions, TurnCheckpointStore, WireApiMode,
};
use serde_json::json;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Instant;

mod tui;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    // Goose resolves ACP adapters by binary name (SearchPaths), so copy/symlink this
    // exe as `pi-acp.exe` (or `omnia-acp.exe`) and it serves stdio ACP with no argv.
    if args.is_empty() {
        let invoked_as = env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()))
            .unwrap_or_default();
        if matches!(
            invoked_as.as_str(),
            "pi-acp" | "omnia-acp" | "goose-acp" | "agy-acp"
        ) {
            return run_acp_stdio_from_args(&[]);
        }
    }

    // Launch interactive TUI when invoked with no arguments (`omnia`) or `omnia tui ...`!
    let Some(first) = args.first().map(String::as_str) else {
        return launch_tui_from_args(&[]);
    };

    match first {
        "tui" => launch_tui_from_args(&args[1..]),
        "--help" | "-h" | "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "--version" | "-V" => {
            println!("omnia {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        "--profile-startup" => match run_profile_startup(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia --profile-startup error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        "--acp" | "acp" => run_acp_stdio_from_args(&args[1..]),
        "--acp-http" | "acp-http" => {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("omnia runtime error: {}", redact_secrets(&format!("{e:#}")));
                    return ExitCode::FAILURE;
                }
            };
            let rest = &args[1..];
            let host = arg_value(rest, "--host").unwrap_or_else(|| "127.0.0.1".into());
            let port: u16 = arg_value(rest, "--port")
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(8791);
            let secret = arg_value(rest, "--secret")
                .or_else(|| env::var("OMNIA_ACP_SECRET").ok())
                .or_else(|| env::var("GOOSE_SERVER__SECRET_KEY").ok())
                .filter(|s| !s.trim().is_empty());
            let model = arg_value(rest, "--model");
            let base_url = arg_value(rest, "--base-url").or_else(|| arg_value(rest, "--api-base"));
            let api_key = arg_value(rest, "--api-key");
            match rt.block_on(run_acp_http_server(
                &host, port, secret, model, base_url, api_key,
            )) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("omnia --acp-http error: {}", redact_secrets(&format!("{e:#}")));
                    ExitCode::FAILURE
                }
            }
        }
        "run" => {
            let rest = &args[1..];
            if rest.first().map(String::as_str) == Some("--help")
                || rest.first().map(String::as_str) == Some("-h")
            {
                print_help();
                return ExitCode::SUCCESS;
            }
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("omnia runtime error: {}", redact_secrets(&format!("{e:#}")));
                    return ExitCode::FAILURE;
                }
            };
            match rt.block_on(run_agent_cmd(rest)) {
                Ok(ok) => {
                    if ok {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::FAILURE
                    }
                }
                Err(e) => {
                    let safe_err = redact_secrets(&format!("{e:#}"));
                    let fmt = arg_value(rest, "--output-format")
                        .unwrap_or_else(|| "text".into())
                        .to_ascii_lowercase();
                    if fmt == "stream-json" || fmt == "json" {
                        println!(
                            "{}",
                            json!({
                                "type": "error",
                                "message": safe_err
                            })
                        );
                    } else {
                        eprintln!("omnia run error: {safe_err}");
                    }
                    ExitCode::FAILURE
                }
            }
        }
        "rewind" => match run_rewind_cmd(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omnia rewind error: {}", redact_secrets(&format!("{e:#}")));
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("Unknown command '{first}'. Run `omnia --help` for usage.");
            ExitCode::FAILURE
        }
    }
}

/// Shared stdio-ACP entry for `omnia --acp` AND the `pi-acp.exe`/`omnia-acp.exe`
/// argv[0] shims goose resolves by binary name.
fn run_acp_stdio_from_args(rest: &[String]) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("omnia runtime error: {}", redact_secrets(&format!("{e:#}")));
            return ExitCode::FAILURE;
        }
    };
    let model = arg_value(rest, "--model").or_else(|| env::var("OMNIA_MODEL").ok());
    let base_url = arg_value(rest, "--base-url")
        .or_else(|| arg_value(rest, "--api-base"))
        .or_else(|| env::var("OMNIA_BASE_URL").ok());
    let api_key = arg_value(rest, "--api-key")
        .or_else(|| env::var("OMNIA_API_KEY").ok())
        .or_else(|| env::var("HTMUSTC_API_KEY").ok());
    match rt.block_on(run_acp_stdio_server(model, base_url, api_key)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("omnia --acp error: {}", redact_secrets(&format!("{e:#}")));
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    println!(
        "\
omnia {} — Ultra-Lightweight Native Rust Autonomous Coding Agent CLI

USAGE:
  omnia --version
  omnia --profile-startup [--out <json>]
  omnia run --workspace <dir> --model <id> --base-url <url> [OPTIONS] \"<prompt>\"
  omnia --acp [--model <id>] [--base-url <url>] [--api-key <key>]
  omnia --acp-http [--host <ip>] [--port <n>] [--secret <key>]
  omnia rewind --workspace <dir> --turn <n> [--session <id>]

RUN OPTIONS:
  --workspace, --cwd <dir>       Target workspace directory (default: current dir)
  --model <id>                   Model identifier (e.g. claude-sonnet-5-5, gemini-3.8-flash, gpt-6.2-sol)
  --base-url, --api-base <url>   Upstream OpenAI/Anthropic/Gemini base URL (env: OMNIA_BASE_URL)
  --api-key <key>                API key (env: OMNIA_API_KEY, HTMUSTC_API_KEY, OPENAI_API_KEY)
  --wire-api <mode>              auto | chat | responses | messages | gemini (default: auto)
  --thinking <level>             minimal | low | medium | high
  --output-format <fmt>          stream-json | json | text (default: text)
  --auto-approve                 Run with ApprovalMode::Yolo (non-interactive)
  --approval-mode <mode>         yolo | write | plan | always-ask | always-ask-cached
  --max-turns <n>                Maximum agent turns (default: 50)
  --timeout-secs, --timeout <s>  Run timeout in seconds (default: 300)
  --prompt-file <path>           Read prompt from UTF-8 file instead of positional arg
  --trajectory <path>            Write append-only JSONL turn trajectory
  --out <path>                   Write final JSON summary report to file",
        env!("CARGO_PKG_VERSION")
    );
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            return args.get(i + 1).cloned();
        }
        let prefix = format!("{flag}=");
        if let Some(rest) = args[i].strip_prefix(&prefix) {
            return Some(rest.to_string());
        }
        i += 1;
    }
    None
}

fn extract_positional_prompt(args: &[String]) -> Option<String> {
    const VALUE_FLAGS: &[&str] = &[
        "--workspace",
        "--cwd",
        "--model",
        "--base-url",
        "--api-base",
        "--api-key",
        "--wire-api",
        "--thinking",
        "--output-format",
        "--approval-mode",
        "--max-turns",
        "--timeout-secs",
        "--timeout",
        "--prompt-file",
        "--prompt",
        "--config-dir",
        "--trajectory",
        "--out",
        "--session",
        "--turn",
    ];
    let mut i = 0;
    let mut positionals = Vec::new();
    while i < args.len() {
        let a = &args[i];
        if a == "--" {
            positionals.extend(args[i + 1..].iter().cloned());
            break;
        }
        if VALUE_FLAGS.contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if a.starts_with("--") {
            i += 1;
            continue;
        }
        positionals.push(a.clone());
        i += 1;
    }
    if positionals.is_empty() {
        None
    } else {
        Some(positionals.join(" "))
    }
}

fn resolve_omp_tui_paths() -> Option<(PathBuf, PathBuf, PathBuf, PathBuf)> {
    let candidates = [
        env::var("OMNIA_OMP_TUI_DIR").ok().map(PathBuf::from),
        Some(default_omnia_data_dir().join("omp-tui")),
        Some(PathBuf::from(r"D:\OmniaData\omp-tui")),
    ];
    for root in candidates.into_iter().flatten() {
        let bun = root.join("bun.exe");
        let cli_js = root
            .join("app")
            .join("node_modules")
            .join("@oh-my-pi")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js");
        if bun.is_file() && cli_js.is_file() {
            return Some((bun, cli_js, root.join("agent"), root.join("sessions")));
        }
    }
    None
}

fn launch_tui_from_args(args: &[String]) -> ExitCode {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return ExitCode::SUCCESS;
    }
    let workspace = arg_value(args, "--workspace")
        .or_else(|| arg_value(args, "--cwd"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let model = arg_value(args, "--model");
    let base_url = arg_value(args, "--base-url").or_else(|| arg_value(args, "--api-base"));
    let api_key = arg_value(args, "--api-key");
    let force_native = args.iter().any(|a| a == "--native");

    if !force_native {
        if let Some((bun, cli_js, agent_dir, sessions_dir)) = resolve_omp_tui_paths() {
            let clean_ws = sanitize_windows_path(&workspace);
            let _ = fs::create_dir_all(&agent_dir);
            let _ = fs::create_dir_all(&sessions_dir);
            let mut cmd = std::process::Command::new(&bun);
            cmd.arg(&cli_js)
                .arg("--cwd")
                .arg(&clean_ws)
                .arg("--session-dir")
                .arg(&sessions_dir)
                .env("PI_CODING_AGENT_DIR", &agent_dir);
            if let Ok(exe) = env::current_exe() {
                cmd.env("OMNIA_EXE_PATH", exe);
            }
            let backend_ext = agent_dir.join("extensions").join("omnia-backend.ts");
            if backend_ext.is_file() {
                cmd.arg("--extension").arg(&backend_ext);
            }
            let selected_model = model
                .clone()
                .or_else(|| env::var("OMNIA_MODEL").ok().filter(|s| !s.trim().is_empty()))
                .unwrap_or_else(|| "htmustc-claude/claude-sonnet-5-5".into());
            cmd.arg("--model").arg(&selected_model);
            if let Some(ref k) = api_key {
                cmd.env("HTMUSTC_API_KEY", k).arg("--api-key").arg(k);
            } else if let Ok(k) = env::var("OMNIA_API_KEY").or_else(|_| env::var("OPENAI_API_KEY")) {
                if env::var("HTMUSTC_API_KEY").is_err() && !k.trim().is_empty() {
                    cmd.env("HTMUSTC_API_KEY", k);
                }
            }
            if args.iter().any(|a| a == "-c" || a == "--continue") {
                cmd.arg("-c");
            }
            if let Some(r) = arg_value(args, "--resume").or_else(|| arg_value(args, "-r")) {
                cmd.arg("--resume").arg(r);
            }
            match cmd.status() {
                Ok(status) => {
                    return if status.success() {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(status.code().unwrap_or(1) as u8)
                    };
                }
                Err(e) => {
                    eprintln!(
                        "omnia omp-tui launch warning ({}); falling back to native TUI",
                        redact_secrets(&e.to_string())
                    );
                }
            }
        }
    }

    let wire_api = arg_value(args, "--wire-api").map(|s| WireApiMode::parse_flag(&s));
    let thinking = arg_value(args, "--thinking");
    let approval_mode = resolve_approval_mode(args).ok().filter(|_| {
        args.iter().any(|a| {
            a == "--auto-approve" || a == "--approval-mode" || a.starts_with("--approval-mode=")
        })
    });
    let max_turns = arg_value(args, "--max-turns")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(50);
    let timeout_secs = arg_value(args, "--timeout-secs")
        .or_else(|| arg_value(args, "--timeout"))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300);

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("omnia runtime error: {}", redact_secrets(&format!("{e:#}")));
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(tui::run_interactive_tui(tui::TuiLaunchOptions {
        workspace,
        model,
        base_url,
        api_key,
        wire_api,
        thinking,
        approval_mode,
        max_turns,
        timeout_secs,
    })) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("omnia tui error: {}", redact_secrets(&format!("{e:#}")));
            ExitCode::FAILURE
        }
    }
}

fn run_profile_startup(args: &[String]) -> Result<()> {
    let t0 = Instant::now();
    let plugins = PluginRegistry::with_default_pillars();
    let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let rss_bytes = process_tree_rss_bytes(std::process::id());
    let report = json!({
        "harness": "omnia",
        "backend": "omnia-agent",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "startupMs": (total_ms * 100.0).round() / 100.0,
        "rssBytes": rss_bytes,
        "rssMiB": ((rss_bytes as f64 / (1024.0 * 1024.0)) * 100.0).round() / 100.0,
        "pluginCount": plugins.list_info().len(),
    });
    let serialized = serde_json::to_string_pretty(&report)?;
    if let Some(out) = arg_value(args, "--out") {
        if let Some(p) = PathBuf::from(&out).parent() {
            if !p.as_os_str().is_empty() {
                fs::create_dir_all(p)?;
            }
        }
        fs::write(&out, &serialized)?;
    }
    println!("{serialized}");
    Ok(())
}

async fn run_agent_cmd(args: &[String]) -> Result<bool> {
    let workspace = arg_value(args, "--workspace")
        .or_else(|| arg_value(args, "--cwd"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let cwd = sanitize_windows_path(&workspace);

    let model = arg_value(args, "--model")
        .or_else(|| env::var("OMNIA_MODEL").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "gemini-3.8-flash".into());
    let api_base = arg_value(args, "--base-url")
        .or_else(|| arg_value(args, "--api-base"))
        .or_else(|| env::var("OMNIA_BASE_URL").ok().filter(|s| !s.trim().is_empty()));
    let api_key = arg_value(args, "--api-key")
        .or_else(|| env::var("OMNIA_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("HTMUSTC_API_KEY").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| env::var("OPENAI_API_KEY").ok().filter(|s| !s.trim().is_empty()));
    let wire_api = arg_value(args, "--wire-api")
        .map(|s| WireApiMode::parse_flag(&s))
        .unwrap_or(WireApiMode::Auto);
    let thinking_level = arg_value(args, "--thinking");
    let config_dir = arg_value(args, "--config-dir").map(PathBuf::from);
    let max_turns = arg_value(args, "--max-turns")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(50);
    let timeout_secs = arg_value(args, "--timeout-secs")
        .or_else(|| arg_value(args, "--timeout"))
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300);
    let trajectory_path = arg_value(args, "--trajectory").map(PathBuf::from);
    let out_path = arg_value(args, "--out");
    let output_format = arg_value(args, "--output-format")
        .unwrap_or_else(|| "text".into())
        .to_ascii_lowercase();

    let approval_mode = resolve_approval_mode(args)?;

    let prompt = if let Some(pf) = arg_value(args, "--prompt-file") {
        fs::read_to_string(&pf).with_context(|| format!("failed to read --prompt-file {pf}"))?
    } else if let Some(p) = arg_value(args, "--prompt") {
        p
    } else if let Some(pos) = extract_positional_prompt(args) {
        pos
    } else {
        bail!("missing prompt (pass positional \"<prompt>\" or --prompt-file <path>)");
    };

    let data_dir = default_omnia_data_dir();
    let db = AgentStore::open(&data_dir)
        .or_else(|_| AgentStore::open_in_memory())
        .ok();

    let stream_json = output_format == "stream-json";
    let stdout_lock = Arc::new(Mutex::new(io::stdout()));
    let emit_line = {
        let lock = Arc::clone(&stdout_lock);
        move |v: serde_json::Value| {
            if let Ok(mut out) = lock.lock() {
                let _ = writeln!(out, "{v}");
                let _ = out.flush();
            }
        }
    };

    if stream_json {
        emit_line(json!({
            "type": "session_start",
            "harness": "omnia",
            "version": env!("CARGO_PKG_VERSION"),
            "workspace": cwd.to_string_lossy(),
            "model": model,
            "wireApi": format!("{wire_api:?}").to_ascii_lowercase(),
        }));
    }

    let event_sink: Option<HarnessEventSink> = if stream_json {
        let lock = Arc::clone(&stdout_lock);
        Some(Arc::new(move |ev: HarnessStreamEvent| {
            let line = match ev {
                HarnessStreamEvent::TurnStart { turn } => json!({
                    "type": "turn_start",
                    "turn": turn
                }),
                HarnessStreamEvent::TurnEnd { turn } => json!({
                    "type": "turn_end",
                    "turn": turn
                }),
                HarnessStreamEvent::DeltaBatch {
                    message_id,
                    text_delta,
                    thinking_delta,
                } => json!({
                    "type": "delta",
                    "messageId": message_id,
                    "textDelta": text_delta,
                    "thinkingDelta": thinking_delta
                }),
                HarnessStreamEvent::ToolStart {
                    tool_call_id,
                    tool_name,
                    arguments,
                } => json!({
                    "type": "tool_start",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "arguments": redact_json_value(arguments)
                }),
                HarnessStreamEvent::ToolEnd {
                    tool_call_id,
                    tool_name,
                    output,
                    is_error,
                    duration_ms,
                } => json!({
                    "type": "tool_end",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "isError": is_error,
                    "durationMs": duration_ms,
                    "outputBytes": output.len()
                }),
                HarnessStreamEvent::AutoRecovery { attempt, reason } => json!({
                    "type": "auto_recovery",
                    "attempt": attempt,
                    "reason": redact_secrets(&reason)
                }),
                HarnessStreamEvent::Metrics {
                    tokens_per_second,
                    context_tokens,
                    context_window,
                    context_percent,
                    total_cost_usd,
                } => json!({
                    "type": "metrics",
                    "tokensPerSecond": tokens_per_second,
                    "contextTokens": context_tokens,
                    "contextWindow": context_window,
                    "contextPercent": context_percent,
                    "totalCostUsd": total_cost_usd
                }),
                HarnessStreamEvent::Telemetry {
                    cache_stats,
                    merkle_root,
                    merkle_refresh_ms,
                    lakeview_compressions,
                    turn_count,
                    tool_call_count,
                    tool_error_count,
                } => json!({
                    "type": "telemetry",
                    "turns": turn_count,
                    "toolCalls": tool_call_count,
                    "toolErrors": tool_error_count,
                    "cacheHitPct": cache_stats.cache_hit_pct,
                    "uncachedInputTokens": cache_stats.uncached_input_tokens,
                    "cacheReadTokens": cache_stats.cache_read_tokens,
                    "outputTokens": cache_stats.output_tokens,
                    "reasoningTokens": cache_stats.reasoning_tokens,
                    "lakeviewCompressions": lakeview_compressions,
                    "merkleRoot": merkle_root,
                    "merkleRefreshMs": merkle_refresh_ms
                }),
            };
            if let Ok(mut out) = lock.lock() {
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        }))
    } else {
        None
    };

    let mut report = run_super_eval(SuperEvalOptions {
        cwd,
        model,
        prompt,
        approval_mode,
        workspace_trusted: approval_mode == ApprovalMode::Yolo,
        permission_rules: PermissionsEngine::default_rules(),
        thinking_level,
        config_dir,
        api_base,
        api_key,
        wire_api,
        timeout_secs,
        max_turns,
        trajectory_path,
        plugins: PluginRegistry::with_default_pillars(),
        db: db.clone(),
        event_sink,
    })
    .await?;

    // Redact any accidental credential substrings before emitting stdout/report files
    report.final_text = redact_secrets(&report.final_text);
    if let Some(ref e) = report.error {
        report.error = Some(redact_secrets(e));
    }

    if let Some(ref d) = db {
        let _ = d.checkpoint();
    }

    if let Some(op) = out_path {
        let p = PathBuf::from(&op);
        if let Some(parent) = p.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        fs::write(&p, serde_json::to_string_pretty(&report)?)?;
    }

    match output_format.as_str() {
        "stream-json" => {
            emit_line(json!({
                "type": "final_summary",
                "report": report
            }));
        }
        "json" => {
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        _ => {
            println!("{}", report.final_text);
        }
    }

    Ok(report.success)
}

fn run_rewind_cmd(args: &[String]) -> Result<()> {
    let workspace = arg_value(args, "--workspace")
        .or_else(|| arg_value(args, "--cwd"))
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let cwd = sanitize_windows_path(&workspace);
    let target_turn: u32 = arg_value(args, "--turn")
        .context("omnia rewind requires --turn <n>")?
        .parse()
        .context("invalid integer for --turn")?;

    let db = AgentStore::open(&default_omnia_data_dir())?;
    let session_id = match arg_value(args, "--session") {
        Some(s) => s,
        None => db
            .latest_checkpoint_session()?
            .context("no persisted turn checkpoints found in AgentStore")?,
    };

    let mut store = TurnCheckpointStore::load_from_store(&session_id, db)?;
    let tracker = FileReadTracker::new();
    let restored = store.rollback_to_turn(target_turn, &cwd, &tracker)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "rewound": true,
            "sessionId": session_id,
            "targetTurn": target_turn,
            "restoredFiles": restored
        }))?
    );
    Ok(())
}

fn redact_json_value(val: serde_json::Value) -> serde_json::Value {
    match val {
        serde_json::Value::String(s) => serde_json::Value::String(redact_secrets(&s)),
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(redact_json_value).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, redact_json_value(v)))
                .collect(),
        ),
        other => other,
    }
}

fn resolve_approval_mode(args: &[String]) -> Result<ApprovalMode> {
    if args.iter().any(|a| a == "--auto-approve") {
        return Ok(ApprovalMode::Yolo);
    }
    if let Some(mode_str) = arg_value(args, "--approval-mode") {
        return ApprovalMode::try_parse_flag(&mode_str);
    }
    // Fail-closed default when neither `--auto-approve` nor `--approval-mode` is passed.
    Ok(ApprovalMode::AlwaysAsk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_argument_parser_extracts_flags_and_positional_prompt() {
        let args: Vec<String> = vec![
            "--workspace",
            r"D:\tmp\repo",
            "--model",
            "claude-sonnet-5-5",
            "--base-url",
            "http://127.0.0.1:4100/v1",
            "--wire-api",
            "messages",
            "--output-format",
            "stream-json",
            "--auto-approve",
            "Fix failing test in ledger.py",
        ]
        .into_iter()
        .map(String::from)
        .collect();

        assert_eq!(arg_value(&args, "--workspace").as_deref(), Some(r"D:\tmp\repo"));
        assert_eq!(arg_value(&args, "--model").as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(arg_value(&args, "--wire-api").as_deref(), Some("messages"));
        assert_eq!(
            extract_positional_prompt(&args).as_deref(),
            Some("Fix failing test in ledger.py")
        );
        assert_eq!(resolve_approval_mode(&args).unwrap(), ApprovalMode::Yolo);
    }

    #[test]
    fn cli_approval_mode_fails_closed_by_default_and_rejects_typos() {
        let bare: Vec<String> = vec!["--model".into(), "gpt-6.2-sol".into(), "hello".into()];
        assert_eq!(resolve_approval_mode(&bare).unwrap(), ApprovalMode::AlwaysAsk);

        let typo: Vec<String> = vec!["--approval-mode".into(), "yollo".into()];
        assert!(resolve_approval_mode(&typo).is_err());

        let write_mode: Vec<String> = vec!["--approval-mode".into(), "write".into()];
        assert_eq!(resolve_approval_mode(&write_mode).unwrap(), ApprovalMode::Write);
    }
}
